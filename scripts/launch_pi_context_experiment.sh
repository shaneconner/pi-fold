#!/bin/bash -p
set -eu

# Launch one repetition of the fold-vs-compaction experiment: all requested arms IN
# PARALLEL, one systemd unit per arm, each supervising one real Pi session over its own
# pinned detached worktree. Parallel is the default and the point: running the arms in the
# same wall-clock window removes provider time-of-day variance from the comparison, which a
# serial schedule would fold straight into the result.
#
#   scripts/launch_pi_context_experiment.sh --campaign <id> --mode smoke|full [--rep 1] \
#       [--arms pifold,native,unmanaged] [--repo curl]

ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && /bin/pwd)
RUN_HOME=$(/usr/bin/getent passwd "$(/usr/bin/id -u)" | /usr/bin/cut -d: -f6)
RUN_USER=$(/usr/bin/id -un)
STATE_ROOT=$RUN_HOME/pi-fold-runs/state/ops/pi-context-experiment
CAMPAIGN=
MODE=
REP=1
ARMS=pifold,native,unmanaged
REPO=curl
MODEL_PROVIDER=openai-codex
MODEL_ID=gpt-5.6-sol
EFFORT=xhigh

while [ "$#" -gt 0 ]; do
  case "$1" in
    --campaign) CAMPAIGN=$2; shift 2;;
    --mode) MODE=$2; shift 2;;
    --rep) REP=$2; shift 2;;
    --arms) ARMS=$2; shift 2;;
    --repo) REPO=$2; shift 2;;
    --model-provider) MODEL_PROVIDER=$2; shift 2;;
    --model-id) MODEL_ID=$2; shift 2;;
    --effort) EFFORT=$2; shift 2;;
    *) echo "usage: $0 --campaign <id> --mode smoke|full [--rep N] [--arms a,b,c] [--repo r]" >&2; exit 2;;
  esac
done
[ -n "$CAMPAIGN" ] || { echo "--campaign is required" >&2; exit 2; }
case "$MODE" in smoke|full) ;; *) echo "--mode must be smoke or full" >&2; exit 2;; esac
case "$REP" in ''|*[!0-9]*) echo "--rep must be an integer" >&2; exit 2;; esac

unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH \
  BASH_ENV ENV NODE_TLS_REJECT_UNAUTHORIZED PI_CODING_AGENT_DIR OPENAI_BASE_URL OPENAI_API_BASE \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy \
  SSL_CERT_FILE SSL_CERT_DIR DBUS_SESSION_BUS_ADDRESS \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_NAMESPACE
PATH=/usr/local/bin:/usr/bin:/bin
HOME=$RUN_HOME
USER=$RUN_USER
LOGNAME=$RUN_USER
XDG_RUNTIME_DIR=/run/user/$(/usr/bin/id -u)
export PATH HOME USER LOGNAME XDG_RUNTIME_DIR
export PI_FOLD_SANITIZED=1

if ! GIT_STATUS=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c core.fsmonitor=false -c core.untrackedCache=false \
  -C "$ROOT" status --porcelain=v1 --untracked-files=all); then
  echo "unable to attest the experiment worktree" >&2
  exit 1
fi
if [ -n "$GIT_STATUS" ]; then
  echo "refusing an experiment launch from a dirty worktree" >&2
  exit 1
fi

CAMPAIGN_DIR=$STATE_ROOT/$CAMPAIGN
PLAN=$CAMPAIGN_DIR/stages-$MODE.json
/bin/mkdir -p "$CAMPAIGN_DIR/runs"
if [ ! -f "$PLAN" ]; then
  /usr/bin/node "$ROOT/scripts/stage_pi_context_experiment.mjs" \
    --campaign-dir "$CAMPAIGN_DIR" --mode "$MODE" --repo "$REPO" >"$CAMPAIGN_DIR/staging-$MODE.json"
fi
[ -f "$PLAN" ] || { echo "staging did not produce $PLAN" >&2; exit 1; }

UNITS=
OLD_IFS=$IFS
IFS=,
for ARM in $ARMS; do
  IFS=$OLD_IFS
  # "closedbook" is not an arm: it launches the plan's closed-book floor session
  # (question list only, no stages, no tools, no checkout) through the same unit shape.
  case "$ARM" in pifold|native|unmanaged|closedbook) ;; *) echo "unknown arm $ARM" >&2; exit 2;; esac
  if [ "$ARM" = closedbook ]; then
    ARM_ARGS="--session-type closed-book"
  else
    ARM_ARGS="--arm $ARM"
  fi
  RUN_ID=$(/usr/bin/date -u +%Y-%m-%dT%H-%M-%SZ)-$ARM-rep$REP-$(/usr/bin/openssl rand -hex 4)
  RUN_DIR=$CAMPAIGN_DIR/runs/$RUN_ID
  UNIT_SUFFIX=$(printf '%s' "$RUN_ID" | /usr/bin/tr '[:upper:]' '[:lower:]')
  UNIT=pi-fold-experiment-$UNIT_SUFFIX.service
  LOG=$CAMPAIGN_DIR/runs/$RUN_ID.supervisor.log
  /usr/bin/systemd-run --user \
    --unit="$UNIT" \
    --remain-after-exit \
    --setenv=PI_FOLD_SANITIZED=1 \
    --setenv=HOME="$RUN_HOME" \
    --setenv=USER="$RUN_USER" \
    --setenv=LOGNAME="$RUN_USER" \
    --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
    --setenv="XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" \
    --setenv=LANG=C.UTF-8 \
    --property="UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV NODE_TLS_REJECT_UNAUTHORIZED PI_CODING_AGENT_DIR OPENAI_BASE_URL OPENAI_API_BASE HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR DBUS_SESSION_BUS_ADDRESS GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_NAMESPACE" \
    --property="WorkingDirectory=$ROOT" \
    --property="TimeoutStartSec=6h" \
    --property="RuntimeMaxSec=305m" \
    --property="KillMode=mixed" \
    --property="StandardOutput=append:$LOG" \
    --property="StandardError=append:$LOG" \
    /usr/bin/node "$ROOT/scripts/run_pi_context_experiment.mjs" \
      --run-dir "$RUN_DIR" --unit "$UNIT" --campaign-dir "$CAMPAIGN_DIR" --plan "$PLAN" \
      $ARM_ARGS \
      --repetition "$REP" --ordinal "$REP" \
      --model-provider "$MODEL_PROVIDER" --model-id "$MODEL_ID" --effort "$EFFORT" >/dev/null
  UNITS="$UNITS $UNIT"
  IFS=,
done
IFS=$OLD_IFS

printf '{"ok":true,"campaign":"%s","campaignDir":"%s","mode":"%s","repetition":%s,"plan":"%s","units":"%s"}\n' \
  "$CAMPAIGN" "$CAMPAIGN_DIR" "$MODE" "$REP" "$PLAN" "${UNITS# }"
