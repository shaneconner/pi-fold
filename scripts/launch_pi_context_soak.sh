#!/bin/bash -p
set -eu

ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && /bin/pwd)
STATE_ROOT=/home/shane/quorum-run/state/ops/pi-context-hours-soak
MODE=acceptance
CALIBRATION_REPORT=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --calibration)
      MODE=calibration
      shift
      ;;
    --calibration-report)
      [ "$#" -ge 2 ] || { echo "--calibration-report needs a path" >&2; exit 2; }
      CALIBRATION_REPORT=$2
      shift 2
      ;;
    *)
      echo "usage: $0 [--calibration | --calibration-report <candidate-report>]" >&2
      exit 2
      ;;
  esac
done
if [ "$MODE" = acceptance ] && [ -z "$CALIBRATION_REPORT" ]; then
  echo "acceptance launch requires --calibration-report <passing candidate-report>" >&2
  exit 2
fi
if [ "$MODE" = calibration ] && [ -n "$CALIBRATION_REPORT" ]; then
  echo "calibration mode does not accept --calibration-report" >&2
  exit 2
fi

unset QUORUM_PI_ROOT NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH \
  BASH_ENV ENV NODE_TLS_REJECT_UNAUTHORIZED PI_CODING_AGENT_DIR OPENAI_BASE_URL OPENAI_API_BASE \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy \
  SSL_CERT_FILE SSL_CERT_DIR DBUS_SESSION_BUS_ADDRESS \
  GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM \
  GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_NAMESPACE
PATH=/usr/local/bin:/usr/bin:/bin
HOME=/home/shane
USER=shane
LOGNAME=shane
XDG_RUNTIME_DIR=/run/user/$(/usr/bin/id -u)
export PATH HOME USER LOGNAME XDG_RUNTIME_DIR
export QUORUM_CONTEXT_SOAK_SANITIZED=1

if ! GIT_STATUS=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 \
  /usr/bin/git -c core.fsmonitor=false -c core.untrackedCache=false \
  -C "$ROOT" status --porcelain=v1 --untracked-files=all); then
  echo "unable to attest the soak worktree" >&2
  exit 1
fi
if [ -n "$GIT_STATUS" ]; then
  echo "refusing context soak from a dirty worktree" >&2
  exit 1
fi
/bin/mkdir -p "$STATE_ROOT"
RUN_ID=$(/usr/bin/date -u +%Y-%m-%dT%H-%M-%SZ)-$(/usr/bin/openssl rand -hex 6)
RUN_DIR=$STATE_ROOT/$RUN_ID
UNIT_SUFFIX=$(printf '%s' "$RUN_ID" | /usr/bin/tr '[:upper:]' '[:lower:]')
UNIT=quorum-pi-context-soak-$UNIT_SUFFIX.service
SUPERVISOR_LOG=$STATE_ROOT/$RUN_ID.supervisor.log
XDG_RUNTIME=$XDG_RUNTIME_DIR

run_systemd() {
  /usr/bin/systemd-run --user \
    --unit="$UNIT" \
    --remain-after-exit \
    --setenv=QUORUM_CONTEXT_SOAK_SANITIZED=1 \
    --setenv=HOME=/home/shane \
    --setenv=USER=shane \
    --setenv=LOGNAME=shane \
    --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
    --setenv="XDG_RUNTIME_DIR=$XDG_RUNTIME" \
    --setenv=LANG=C.UTF-8 \
    --property="UnsetEnvironment=QUORUM_PI_ROOT NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV NODE_TLS_REJECT_UNAUTHORIZED PI_CODING_AGENT_DIR OPENAI_BASE_URL OPENAI_API_BASE HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy SSL_CERT_FILE SSL_CERT_DIR DBUS_SESSION_BUS_ADDRESS GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_CEILING_DIRECTORIES GIT_NAMESPACE" \
    --property="WorkingDirectory=$ROOT" \
    --property="TimeoutStartSec=5h" \
    --property="RuntimeMaxSec=255m" \
    --property="KillMode=mixed" \
    --property="StandardOutput=append:$SUPERVISOR_LOG" \
    --property="StandardError=append:$SUPERVISOR_LOG" \
    "$@" >/dev/null
}

if [ "$MODE" = calibration ]; then
  run_systemd /usr/bin/node "$ROOT/scripts/run_pi_context_soak.mjs" \
    --run-dir "$RUN_DIR" --unit "$UNIT" --calibration
else
  run_systemd /usr/bin/node "$ROOT/scripts/run_pi_context_soak.mjs" \
    --run-dir "$RUN_DIR" --unit "$UNIT" --calibration-report "$CALIBRATION_REPORT"
fi

printf '{"ok":true,"acceptance":false,"mode":"%s","unit":"%s","runDir":"%s","supervisorLog":"%s"}\n' \
  "$MODE" "$UNIT" "$RUN_DIR" "$SUPERVISOR_LOG"
