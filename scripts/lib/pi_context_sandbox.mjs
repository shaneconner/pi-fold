// The mount namespace one experiment run executes inside.
//
// WHY THIS EXISTS (Shane 2026-08-21). Both arms ran on three tools: `read`, the
// stage tool and the ledger tool. Stock Pi ships seven (`bash`, `edit`, `find`,
// `grep`, `ls`, `read`, `write`), so the experiment was never comparing native Pi
// against native Pi plus folding; it was comparing two subsets of Pi. The
// subtraction was containment, not measurement: Pi's `read` resolves any path
// against cwd with no guard of its own, the session file sat in the run directory
// one level ABOVE the checkout, and the run config named the plan that carries
// every graded answer. Five sealed runs walked that chain and read the key.
//
// Restoring the tool surface is only honest if the boundary moves from the tool
// list to the filesystem. That is this module: the answer key, the seeds that
// regenerate the ledger, the project's own memory and the harness source are
// ABSENT from the namespace rather than denied inside it. The read fence stays as
// defence in depth, which it can now afford to be, because `bash` walks straight
// past an in-process guard and only an unmounted path stops it.
//
// What the namespace holds, and nothing else:
//   /work        the pinned checkout, READ-ONLY, and the session cwd
//   /session     this run's session directory, one file, named for its session id
//   /run         this run's worker artifacts
//   /opt/harness this run's copy of the harness source, DELETED after import
//   /opt/pi      the Pi install, read-only
//   /home/agent  a writable home, so `write` and `bash` have somewhere to go
//   /tmp         a tmpfs
//
// Absent by construction: the campaign directory (the plan with every
// expectedAnswer), `docs/` (the frozen ledger seed, which regenerates every seeded
// value from the mode alone), `.canon` (219 files of project memory whose journal
// quotes seeded values and states the whole design), `lab/`, the verifier (its
// gate fixtures quote seeded values), $HOME, and every other session on the
// machine.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

// Where each bound resource lands inside the namespace. These are constants rather
// than settings: a run that mounted its checkout somewhere else would not be the
// run the seal describes.
export const SANDBOX_PATHS = Object.freeze({
  work: "/work",
  session: "/session",
  run: "/run",
  harness: "/opt/harness",
  node: "/opt/node",
  home: "/home/agent",
  // Pi is bound where PI_INSTALL_ROOT already looks for it, under the sandbox's
  // own HOME. The worker resolves jiti and typebox through explicit aliases into
  // this root, so the project's node_modules is never needed and never mounted.
  pi: "/home/agent/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent",
  config: "/config.json",
  plan: "/plan.json",
});

// The ONLY first-party source copied in. Traced from the worker's import graph,
// not from a directory glob, because a glob is how `verify_pi_context_experiment.mjs`
// would arrive: its gate fixtures quote seeded ledger values verbatim.
export const HARNESS_SOURCE = Object.freeze([
  "package.json",
  "scripts/run_pi_context_experiment_worker.mjs",
  "scripts/pi_context_experiment_extension.mjs",
  "scripts/lib/pi_context_experiment.mjs",
  "scripts/lib/pi_context_soak_attestation.mjs",
  "scripts/lib/pi_fold_identity.mjs",
  "scripts/lib/pi_context_sandbox.mjs",
  "extensions/active-context.ts",
  "extensions/evidence.js",
  "extensions/index.js",
  "extensions/json.ts",
  "extensions/settings.ts",
  "extensions/lib/canonical.ts",
  "extensions/lib/curation.ts",
  "extensions/lib/folding.ts",
  "extensions/lib/instrumentation.ts",
  "extensions/lib/measurement.ts",
  "extensions/lib/persistence.ts",
  "extensions/lib/policy.ts",
  "extensions/lib/rollback.ts",
  "extensions/lib/scheduling.ts",
  "extensions/lib/selection.ts",
  "extensions/lib/tool-surface.ts",
  "extensions/lib/transcript.ts",
]);

// A seeded ledger value is `lv-` and hex; a code word is `cw-` and hex. Any file
// carrying one has no business inside the namespace, whoever wrote it.
const SEEDED_TOKEN = /\b(lv|cw)-[0-9a-f]{4,}/;

export function seededTokenCarriers(projectRoot, files = HARNESS_SOURCE) {
  return files.filter((file) => {
    const path = join(projectRoot, file);
    return existsSync(path) && SEEDED_TOKEN.test(readFileSync(path, "utf8"));
  });
}

// The worker deletes its own source once every module is resident. Node caches by
// resolved path and the whole graph is imported at startup, so nothing reads these
// bytes again; what the deletion removes is a description of the experiment sitting
// where `grep` can reach it. This is what makes the restored tool surface safe:
// the model cannot read the protocol it is inside.
// The mount POINT cannot be removed from inside (EBUSY), so the contents go and the
// empty directory stays. That is the whole difference: what `grep` could have read
// is gone, and an empty /opt/harness says nothing about the protocol.
export function deleteHarnessSource(harnessRoot = SANDBOX_PATHS.harness) {
  const removed = [];
  for (const entry of readdirSync(harnessRoot)) {
    rmSync(join(harnessRoot, entry), { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}

export function harnessSourceRemains(harnessRoot = SANDBOX_PATHS.harness) {
  return existsSync(harnessRoot) ? readdirSync(harnessRoot) : [];
}

// The harness copy holds no mount points, so `rm -rf` can remove it whole once its
// modules are resident.
export function sandboxArgv(layout) {
  const {
    bwrap = "/usr/bin/bwrap",
    checkoutDir, sessionDir, runDir, harnessDir,
    piRoot, nodeExecutable, configPath, planPath, homeDir, identityDir,
  } = layout;
  for (const [name, value] of Object.entries({
    checkoutDir, sessionDir, runDir, harnessDir,
    piRoot, nodeExecutable, configPath, planPath, homeDir, identityDir,
  })) {
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error(`Sandbox layout needs an absolute ${name}`);
    }
  }
  return [
    bwrap,
    // --unshare-all carries the PID namespace, and that is the part that matters.
    // A fresh /proc alone leaves every host process visible: a probe from inside
    // read neighbouring cmdlines naming real /home/shane paths, which is the
    // 2026-08-14 leak chain arriving through a neighbour instead of through self.
    // With the namespace, five pids are visible and the sandboxed process is pid 2.
    "--unshare-all", "--share-net",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "HOME", SANDBOX_PATHS.home,
    "--setenv", "USER", "agent",
    "--setenv", "LOGNAME", "agent",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PI_FOLD_SANITIZED", "1",
    // A base system with no /etc beyond what TLS and name resolution need. /etc as
    // a whole would carry the machine's identity for no gain.
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/bin", "/sbin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib", "/lib64",
    // A synthetic account, not the machine's. os.userInfo() needs a passwd entry
    // and the host's would name every real user on the box.
    "--ro-bind", join(identityDir, "passwd"), "/etc/passwd",
    "--ro-bind", join(identityDir, "group"), "/etc/group",
    "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    "--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", nodeExecutable, SANDBOX_PATHS.node,
    // The run. The checkout is read-only because the answer key was computed
    // against the pristine tree: an edit there would drift the graded material
    // rather than escape anything, which makes this a measurement guard and not
    // a containment one.
    "--ro-bind", checkoutDir, SANDBOX_PATHS.work,
    "--bind", sessionDir, SANDBOX_PATHS.session,
    "--bind", runDir, SANDBOX_PATHS.run,
    "--bind", harnessDir, SANDBOX_PATHS.harness,
    "--bind", homeDir, SANDBOX_PATHS.home,
    // AFTER the home bind, so it layers inside it rather than being swallowed.
    "--ro-bind", piRoot, SANDBOX_PATHS.pi,
    "--ro-bind", configPath, SANDBOX_PATHS.config,
    "--ro-bind", planPath, SANDBOX_PATHS.plan,
    "--chdir", SANDBOX_PATHS.work,
    "--",
    SANDBOX_PATHS.node,
    join(SANDBOX_PATHS.harness, "scripts", "run_pi_context_experiment_worker.mjs"),
    SANDBOX_PATHS.config,
  ];
}

// The plan the worker is allowed to hold. The supervisor renders every stage
// itself and sends the rendered text over the stage channel, so the worker never
// needed instructions, probes or the ledger: it needs the file list to attest the
// checkout it actually ran on, and the count to know when the assignment ends.
// Built by whitelist, so a field added to the full plan cannot arrive by default.
export function sandboxPlan(plan) {
  return {
    version: plan.version,
    mode: plan.mode,
    planSha256: plan.planSha256,
    stageCount: plan.stageCount,
    repo: { commit: plan.repo.commit, treeSha256: plan.repo.treeSha256 },
    files: plan.stages.flatMap((stage) => stage.files).map((file) => ({
      path: file.path, sha256: file.sha256,
    })),
  };
}

// The run config the worker is allowed to hold. `querySeed` is the field that
// forced this: with it and the ledger geometry, the end block is derivable, and a
// model that can derive the questions has been told what to remember. The
// supervisor keeps the seed and delivers the end block as text when the exam
// starts, which is also the moment the questions stop being a leak.
export const SANDBOX_CONFIG_WITHHELD = Object.freeze(["querySeed", "planPath", "runDir", "repoDir"]);

export function sandboxConfig(config) {
  const withheld = new Set(SANDBOX_CONFIG_WITHHELD);
  const carried = Object.fromEntries(
    Object.entries(config).filter(([key]) => !withheld.has(key)));
  return { ...carried, planPath: SANDBOX_PATHS.plan, runDir: SANDBOX_PATHS.run, repoDir: SANDBOX_PATHS.work };
}

// The synthetic account the namespace runs as. bwrap maps the caller's uid, so the
// entry has to carry that number while naming nobody real.
export function sandboxIdentityFiles(uid, gid) {
  return {
    passwd: `agent:x:${uid}:${gid}:agent:${SANDBOX_PATHS.home}:/bin/sh\n`,
    group: `agent:x:${gid}:\n`,
  };
}

export function sandboxSessionPath(sessionDir, sessionFile) {
  return join(SANDBOX_PATHS.session, basename(sessionFile ?? "", ""));
}
