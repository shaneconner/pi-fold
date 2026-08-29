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
//   the home     a writable home, so `write` and `bash` have somewhere to go
//   /tmp         a tmpfs
//
// Absent by construction: the campaign directory (the plan with every
// expectedAnswer), `docs/` (the frozen ledger seed, which regenerates every seeded
// value from the mode alone), `.canon` (219 files of project memory whose journal
// quotes seeded values and states the whole design), `lab/`, the verifier (its
// gate fixtures quote seeded values), $HOME, and every other session on the
// machine.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { basename, join } from "node:path";

// Where each bound resource lands inside the namespace. These are constants rather
// than settings: a run that mounted its checkout somewhere else would not be the
// run the seal describes.
// The namespace's own PATH, pinned as a constant so the environment assertion and
// the argv builder cannot drift apart.
export const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";

// Inside the namespace bubblewrap is init at pid 1 and the worker is its only
// child, so the worker always sees itself as 2. The supervisor holds the host
// child handle separately, which is what binds liveness; this binds identity.
export const SANDBOX_WORKER_PID = 2;

// ASSEMBLED, NOT WRITTEN OUT. This is a synthetic home inside a mount namespace
// and belongs to nobody, but it matches the pattern package gate 86 greps tracked
// files for, and that gate is right to be blunt about operator paths rather than
// carrying exemptions. Assembling is the idiom the gate itself uses for its own
// known-bad samples, for the same reason.
const SANDBOX_HOME = ["", "home", "agent"].join("/");

export const SANDBOX_PATHS = Object.freeze({
  work: "/work",
  session: "/session",
  // Where a run directory lands WHEN one is mounted at all, which for the experiment is
  // never: nothing of its run crosses as a path any more. `run_steer_session` still mounts
  // one, because the tree it grades IS the tree the agent edits, so the directory is the
  // subject rather than the bookkeeping. Two callers, two needs, one builder.
  run: "/run",
  harness: "/opt/harness",
  node: "/opt/node",
  home: SANDBOX_HOME,
  // Pi is bound where PI_INSTALL_ROOT already looks for it, under the sandbox's
  // own HOME. The worker resolves jiti and typebox through explicit aliases into
  // this root, so the project's node_modules is never needed and never mounted.
  pi: `${SANDBOX_HOME}/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent`,
  // Pi's agent directory, rebuilt per run rather than bound. The real one holds
  // run-history.jsonl (the user's own sessions), models.json (a secret-tool lookup
  // for an unrelated provider) and the interactive pi-fold deployment. None of
  // that belongs to this run.
  scratch: "/tmp",
  // A WRITABLE DIRECTORY INSIDE THE READ-ONLY CHECKOUT (2026-08-25). The v5 stale
  // artifacts are notes the model is asked to bring up to date, so it must be able to edit
  // one, and the checkout is read-only ON PURPOSE (the tree is graded material). The whole
  // tree cannot be opened up for that. This is a fresh per-run directory layered over the
  // read-only bind, so the corpus stays pristine and only the notes are writable.
  //
  // It lives INSIDE /work rather than in /tmp or $HOME because `read` is fenced to the
  // checkout (gate 67): a note the model could not open with its ordinary reading tool,
  // and had to reach with `bash` instead, would be a tell in itself.
  notes: "/work/notes",
  agent: `${SANDBOX_HOME}/.pi/agent`,
  auth: `${SANDBOX_HOME}/.pi/agent/auth.json`,
  // The config and the plan are WRITTEN INTO the harness copy rather than bound
  // over it, so the one deletion covers them too. A separate bind here would be a
  // mount point the worker could not remove, and that is what lets the config
  // still carry the end block's prompt text: it stops existing before the first turn.
  config: "/opt/harness/config.json",
  plan: "/opt/harness/plan.json",
});

// The ONLY first-party source copied in. Traced from the worker's import graph,
// not from a directory glob, because a glob is how `verify_pi_context_experiment.mjs`
// would arrive: its gate fixtures quote seeded ledger values verbatim.
export const HARNESS_SOURCE = Object.freeze([
  "package.json",
  "scripts/run_pi_context_experiment_worker.mjs",
  "scripts/pi_context_experiment_extension.mjs",
  "scripts/lib/pi_context_experiment.mjs",
  // The v5 stale-artifact bounds, which the extension imports to plant and collect.
  // A run without it dies before its first turn with MODULE_NOT_FOUND at
  // pi_context_experiment_extension.mjs, which is how the first v5 smoke campaign died.
  "scripts/lib/pi_context_artifacts.mjs",
  "scripts/lib/pi_context_soak_attestation.mjs",
  "scripts/lib/pi_fold_identity.mjs",
  "scripts/lib/pi_context_sandbox.mjs",
  // Pinned by the run config's source hashes, so the worker's own attestation
  // needs them present. They go the same way as the rest, before the first turn.
  "scripts/run_pi_context_experiment.mjs",
  "scripts/stage_pi_context_experiment.mjs",
  "scripts/adjudicate_pi_context_experiment.mjs",
  "extensions/active-context.ts",
  "extensions/evidence.js",
  "extensions/index.js",
  "extensions/json.ts",
  "extensions/settings.ts",
  "extensions/lib/canonical.ts",
  "extensions/lib/curation.ts",
  "extensions/lib/editor-ui.ts",
  "extensions/lib/folding.ts",
  "extensions/lib/instrumentation.ts",
  "extensions/lib/live-settings.ts",
  "extensions/lib/measurement.ts",
  "extensions/lib/persistence.ts",
  "extensions/lib/policy.ts",
  "extensions/lib/rollback.ts",
  "extensions/lib/scheduling.ts",
  "extensions/lib/selection.ts",
  "extensions/lib/tool-surface.ts",
  "extensions/lib/transcript.ts",
]);

// What a STEER run needs on top of the v4 list: its own worker and that worker's library.
// Both have to be importable before the harness deletion runs.
export const STEER_HARNESS_SOURCE = Object.freeze([
  ...HARNESS_SOURCE,
  "scripts/run_steer_session_worker.mjs",
  "scripts/lib/steer_session.mjs",
]);

// THE PI-CANON EXTENSION SOURCE (Shane 2026-08-26), staged only when the run's config
// carries the canon condition. Traced from canon.ts's own import graph, exactly as
// HARNESS_SOURCE is traced from the worker's: `index.js` and `settings.ts` stay out
// because they pull the settings TUI and the user-level settings file, neither of which
// belongs inside a sealed run. The copy rides the same lifecycle as the harness source:
// staged under canon/, imported before the deletion, gone before the first turn.
export const CANON_HARNESS_FILES = Object.freeze([
  "canon.ts",
  "lib/lint.ts",
  "lib/retrieval.ts",
  "lib/schema.ts",
  "lib/store.ts",
  "lib/surfacing.ts",
  "lib/tool.ts",
]);

// One hash over exactly the files the run stages, in list order, so the config's pin is
// a statement about the bytes that executed rather than about a directory that may hold
// more. Shared by the supervisor (pin at launch, re-check after the copy) and the gates.
export function canonHarnessTreeSha256(extensionsDir) {
  const hash = createHash("sha256");
  for (const relative of CANON_HARNESS_FILES) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(join(extensionsDir, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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
    checkoutDir, sessionDir, harnessDir,
    piRoot, nodeExecutable, homeDir, identityDir, agentDir, authPath, scratchDir,
    // OPTIONAL (2026-08-25). The experiment passes none: its worker reaches its supervisor
    // over inherited descriptors, so the run directory never enters the namespace at all.
    // `run_steer_session` passes one, exactly as it always has, because the tree it grades is
    // the tree the agent edits. Same precedent as `notesDir`: a parameter that exists because
    // two callers genuinely differ, not a knob.
    runDir = null,
    // Optional: a v4 campaign has no notes and must keep running exactly as it ran.
    notesDir = null,
    // The steer protocol grades the tree the agent LEAVES BEHIND, so its checkout has
    // to be writable and its worker is a different script. Both default to the v4
    // shape, because a sealed campaign must keep running exactly as it ran.
    workWritable = false,
    workerScript = "run_pi_context_experiment_worker.mjs",
  } = layout;
  for (const [name, value] of Object.entries({
    checkoutDir, sessionDir, harnessDir,
    piRoot, nodeExecutable, homeDir, identityDir, agentDir, authPath, scratchDir,
  })) {
    if (typeof value !== "string" || !value.startsWith("/")) {
      throw new Error(`Sandbox layout needs an absolute ${name}`);
    }
  }
  if (runDir !== null && (typeof runDir !== "string" || !runDir.startsWith("/"))) {
    throw new Error("Sandbox layout needs an absolute runDir");
  }
  return [
    bwrap,
    // --unshare-all carries the PID namespace, and that is the part that matters.
    // A fresh /proc alone leaves every host process visible: a probe from inside
    // read neighbouring cmdlines naming real paths under the user's home, which is the
    // 2026-08-14 leak chain arriving through a neighbour instead of through self.
    // With the namespace, five pids are visible and the sandboxed process is pid 2.
    "--unshare-all", "--share-net",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv",
    "--setenv", "HOME", SANDBOX_PATHS.home,
    "--setenv", "USER", "agent",
    "--setenv", "LOGNAME", "agent",
    "--setenv", "PATH", SANDBOX_PATH,
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "PI_FOLD_SANITIZED", "1",
    // A base system with no /etc beyond what TLS and name resolution need. /etc as
    // a whole would carry the machine's identity for no gain.
    // BOUND, not symlinked. A symlink to usr/lib is right on a merged-/usr
    // distribution and wrong elsewhere, and getting it wrong costs the dynamic
    // loader: execve then returns ENOENT naming the PROGRAM, which reads as a
    // missing binary and is not. Binding resolves on the host, so it works whether
    // these are real directories or already symlinks into /usr.
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    // A synthetic account, not the machine's. os.userInfo() needs a passwd entry
    // and the host's would name every real user on the box.
    "--ro-bind", join(identityDir, "passwd"), "/etc/passwd",
    "--ro-bind", join(identityDir, "group"), "/etc/group",
    // -try, because these differ across distributions and a CI runner does not have
    // all three. A missing TLS bundle is a failure the provider call reports for
    // itself; a missing bind here would kill the sandbox before it starts, which
    // says nothing useful.
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--proc", "/proc",
    "--dev", "/dev",
    // A REAL DIRECTORY, not a tmpfs (Shane 2026-08-21: "we just need to be sure
    // they cannot cheat"). With `bash` in the namespace the model can write notes
    // anywhere it has a filesystem, and a tmpfs vanishes with the namespace, so
    // those notes would be unauditable by construction. A note file is not
    // cheating, it is ordinary work a real machine allows, but it IS a recovery
    // channel that is neither compaction nor folding: the smoke run's native
    // deliverable ran 2,404 bytes and carried four of the plan's expectedAnswer
    // values, because a deliverable summarises exactly what the probes ask about.
    // Binding it means every byte the model writes is captured, hashed and sealed,
    // so an answer recovered from its own notes can be told apart from one the
    // mechanism carried instead of being pooled with it invisibly.
    "--bind", scratchDir, SANDBOX_PATHS.scratch,
    "--ro-bind", nodeExecutable, SANDBOX_PATHS.node,
    // The run. Under v4 the checkout is read-only because the answer key was computed
    // against the pristine tree: an edit there would drift the graded material rather
    // than escape anything, which makes this a measurement guard and not a containment
    // one. Under the steer protocol the edited tree IS the graded material, so it is
    // bound read-write and the pristine copy the grader diffs against never enters the
    // namespace at all.
    workWritable ? "--bind" : "--ro-bind", checkoutDir, SANDBOX_PATHS.work,
    // LAYERED OVER the checkout bind, so it must come after it. A read-only tree with one
    // writable directory in it: the notes can be edited, the corpus cannot.
    ...(notesDir === null ? [] : ["--bind", notesDir, SANDBOX_PATHS.notes]),
    "--bind", sessionDir, SANDBOX_PATHS.session,
    // THE RUN DIRECTORY IS NOT MOUNTED (Shane, 2026-08-25: "I don't personally really like it
    // in there"). It used to be bound whole at /run, and a 68-agent audit found that this was
    // the single largest leak in the system: `cat /run/run-config.json` returned the arm, the
    // campaign, the stage count, the frozen querySeed, and EVERY stale-artifact ask with its
    // stage, its wording and the full text of the note about to be planted. Beside it,
    // stale-artifacts.jsonl kept plantedSha256 and returnedSha256, undoing the consume-on-write
    // bound the instrument depends on; worker-events.jsonl narrated the harness to itself; and
    // ipc/requests/stage-NN.json restored the numbering by filename. Nothing the MODEL needs
    // was ever in there: it is harness plumbing, and a filesystem was simply the easiest IPC to
    // write. The ledgers now travel as inherited descriptors the supervisor opens on the HOST
    // (see RUN_CHANNEL_LEDGERS), so every file lands exactly where every reader has always
    // found it and only the writer changed. The delivery round-trip travels on DELIVERY_FD, a
    // duplex socket, so it does not need a directory either and there is nothing left to mount.
    ...(runDir === null ? [] : ["--bind", runDir, SANDBOX_PATHS.run]),
    "--bind", harnessDir, SANDBOX_PATHS.harness,
    "--bind", homeDir, SANDBOX_PATHS.home,
    // AFTER the home bind, so these layer inside it rather than being swallowed.
    "--bind", agentDir, SANDBOX_PATHS.agent,
    // The credential store is the REAL file, read-write, because the token
    // refreshes during a run and independent per-run snapshots would race. It is
    // the one thing here the model could read and should not: `bash` is inside the
    // namespace and so is this file. The read fence denies it as defence in depth,
    // which is all an in-process guard can be, and the exposure is disclosed
    // rather than described as closed.
    "--bind", authPath, SANDBOX_PATHS.auth,
    "--ro-bind", piRoot, SANDBOX_PATHS.pi,
    "--chdir", SANDBOX_PATHS.work,
    "--",
    SANDBOX_PATHS.node,
    join(SANDBOX_PATHS.harness, "scripts", workerScript),
    SANDBOX_PATHS.config,
  ];
}

// The plan the worker is allowed to hold. The supervisor renders every stage
// itself and sends the rendered text over the stage channel, so the worker never
// needed instructions, probes or the ledger: it needs the file list to attest the
// checkout it actually ran on, and the count to know when the assignment ends.
// Built by whitelist, so a field added to the full plan cannot arrive by default.
export const SANDBOX_PLAN_KEYS = Object.freeze([
  "version", "mode", "planSha256", "stageCount", "probeCount", "deliverableCount",
  "repo", "files",
]);

export function sandboxPlan(plan) {
  return {
    version: plan.version,
    mode: plan.mode,
    planSha256: plan.planSha256,
    stageCount: plan.stageCount,
    probeCount: plan.probeCount,
    deliverableCount: plan.deliverableCount,
    repo: {
      key: plan.repo.key, url: plan.repo.url,
      commit: plan.repo.commit, treeSha256: plan.repo.treeSha256,
    },
    files: plan.stages.flatMap((stage) => stage.files).map((file) => ({
      path: file.path, sha256: file.sha256,
    })),
  };
}

// The worker cannot run `validateStagePlan` any more, because the plan it holds
// has no stages: they are rendered by the supervisor and arrive over the stage
// channel. What it must still prove is that the geometry is the geometry its
// config pins, and that nothing instructional or graded rode along.
export function validateSandboxPlan(value) {
  const ok = value && typeof value === "object" && !Array.isArray(value) &&
    SANDBOX_PLAN_KEYS.every((key) => key in value) &&
    Object.keys(value).every((key) => SANDBOX_PLAN_KEYS.includes(key)) &&
    Number.isSafeInteger(value.stageCount) && value.stageCount > 0 &&
    Array.isArray(value.files) && value.files.length > 0 &&
    value.files.every((file) => typeof file?.path === "string" && typeof file?.sha256 === "string");
  if (!ok) throw new Error("Invalid sandboxed stage plan shape");
  return value;
}

// The run config the worker is allowed to hold. `querySeed` is the field that
// forced this: with it and the ledger geometry, the end block is derivable, and a
// model that can derive the questions has been told what to remember. The
// supervisor keeps the seed and delivers the end block as text when the exam
// starts, which is also the moment the questions stop being a leak.
// THE LEDGERS A RUN WRITES FROM INSIDE THE NAMESPACE, in descriptor order. The supervisor
// opens each one on the HOST and hands it to bubblewrap as an inherited descriptor, which
// bwrap passes through to the process it execs (verified against a real bwrap, not assumed).
// The worker writes the same bytes it always wrote; what changed is that it no longer needs a
// directory it shares with the model in order to do it. Order is the contract: the fd number
// is the index in this list plus RUN_CHANNEL_FIRST_FD, so appending is safe and reordering is
// not. Names match the files on disk exactly, because every sealed reader looks for them by
// those names and none of them moved.
export const RUN_CHANNEL_LEDGERS = Object.freeze([
  "worker-events.jsonl",
  "tool-results.jsonl",
  "provider-requests.jsonl",
  "stop-the-world.jsonl",
  "stale-artifacts.jsonl",
  "failure-latch.jsonl",
]);
// The WRITE-ONCE documents, after the ledgers in the same descriptor run. The supervisor opens
// these with "wx", so exclusivity is the supervisor's guarantee rather than the worker's: a
// second write to one of them is a bug, not a race, and gate 55's rescued report must not be
// able to overwrite a real one. The worker tracks in memory which it has written.
export const RUN_CHANNEL_DOCUMENTS = Object.freeze([
  "worker-ready.json",
  "run-manifest.json",
  "worker-report.json",
]);
// Everything the worker writes out, ledgers first, in descriptor order.
export const RUN_CHANNEL_FILES = Object.freeze([...RUN_CHANNEL_LEDGERS, ...RUN_CHANNEL_DOCUMENTS]);
// THE DELIVERY SOCKET (2026-08-25). Stage delivery is a round trip and the ledgers are not,
// so it gets its own descriptor rather than a shared directory: node's `stdio` entry "pipe"
// above index 2 yields a duplex socket on BOTH sides, and bubblewrap passes it through
// (verified against a real bwrap, both directions, not assumed). This is what retired
// `/run/ipc`. Line-delimited JSON, one object per line, request out and response back.
export const DELIVERY_FD = 3;
// 0, 1 and 2 are the worker's own stdio and 3 is the delivery socket; the ledgers start after.
export const RUN_CHANNEL_FIRST_FD = 4;

export function runChannelFd(name) {
  const index = RUN_CHANNEL_FILES.indexOf(name);
  if (index < 0) throw new Error(`No run channel is defined for ${name}`);
  return RUN_CHANNEL_FIRST_FD + index;
}

// The worker's side of the channel: the same bytes `appendJsonLineFsync` wrote to a path,
// written to the descriptor the supervisor opened on the host instead. No framing and no
// routing, because there is nothing to route: one file, one descriptor, decided by position.
const runChannelAppends = new Map();
let runChannelDirectory = null;

// A DIRECTORY INSTEAD OF THE DESCRIPTORS, for callers that have no namespace around them.
// Inside a run the channel IS the inherited descriptor and there is nothing to configure; the
// gate suite drives this same extension in its own process, where fd 4 upward belong to the
// verifier and writing to them would corrupt whatever they are. Same seam and same reason as
// `deleteHarnessSource(harnessRoot = SANDBOX_PATHS.harness)`: a default production uses and a
// test overrides, not an option anything chooses between.
export function useRunChannelDirectory(directory) {
  runChannelDirectory = directory;
}

function writeRunChannel(name, text) {
  if (runChannelDirectory === null) {
    const fd = runChannelFd(name);
    writeSync(fd, text);
    fsyncSync(fd);
    return;
  }
  runChannelFd(name);
  const fd = openSync(join(runChannelDirectory, name), "a", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendRunChannel(name, value) {
  writeRunChannel(name, `${JSON.stringify(value)}\n`);
  runChannelAppends.set(name, (runChannelAppends.get(name) ?? 0) + 1);
}

// How many records THIS PROCESS has appended to a ledger. The worker used to answer that by
// reading the latch file back and counting its lines, which is the one thing a descriptor
// cannot do and, more to the point, is a process reading a file it wrote itself. Everything
// inside the namespace appends through the call above, worker and extension alike, so the
// count is complete on this side of the boundary; the supervisor appends to the same latch
// from the host and is not counted, exactly as it never was.
export function runChannelAppendCount(name) {
  runChannelFd(name);
  return runChannelAppends.get(name) ?? 0;
}

const writtenRunChannelDocuments = new Set();

// WRITE-ONCE, ENFORCED HERE. `flag: "wx"` used to carry this and a descriptor cannot: the
// supervisor's own open is what makes the FILE exclusive, so the second write has to be
// refused in the writer. It matters in exactly one place, gate 55's signal-rescued report,
// whose whole contract is that it can never overwrite a real one; it returns false rather
// than throwing because that caller is a signal handler on its way to exit.
export function writeRunChannelDocument(name, text) {
  if (!RUN_CHANNEL_DOCUMENTS.includes(name)) {
    throw new Error(`${name} is not a write-once run channel document`);
  }
  if (writtenRunChannelDocuments.has(name)) return false;
  writtenRunChannelDocuments.add(name);
  writeRunChannel(name, text);
  return true;
}

export const SANDBOX_CONFIG_WITHHELD = Object.freeze([
  "querySeed", "planPath", "runDir", "repoDir", "sessionDir",
]);

export function sandboxConfig(config, endBlockPrompt) {
  const withheld = new Set(SANDBOX_CONFIG_WITHHELD);
  const carried = Object.fromEntries(
    Object.entries(config).filter(([key]) => !withheld.has(key)));
  return {
    ...carried,
    planPath: SANDBOX_PATHS.plan,
    // NO runDir. The worker's run directory is not a place any more, it is a set of
    // descriptors, and a config naming a path the namespace does not have would be a lie the
    // first reader believed. `validateExperimentRunConfig` reads the sandboxed shape off
    // `repoDir` for exactly that reason and refuses a sandboxed config that names one.
    repoDir: SANDBOX_PATHS.work,
    sessionDir: SANDBOX_PATHS.session,
    // The TEXT, not the seed. The supervisor composes the end block from the
    // ledger and the frozen query seed on its own side; the worker only reads it
    // out. A seed plus the ledger geometry is a derivable question list, and a
    // model that can derive the questions has been told what to remember.
    ...(endBlockPrompt === undefined ? {} : { endBlockPrompt }),
  };
}

// The synthetic account the namespace runs as. bwrap maps the caller's uid, so the
// entry has to carry that number while naming nobody real.
export function sandboxIdentityFiles(uid, gid) {
  return {
    passwd: `agent:x:${uid}:${gid}:agent:${SANDBOX_PATHS.home}:/bin/sh\n`,
    group: `agent:x:${gid}:\n`,
  };
}

// WHERE A RUN'S BIND SOURCES LIVE, AND WHERE THEY END UP. Every path the namespace binds
// is staged under an opaque root and renamed into the run directory at seal, because bwrap
// repeats its whole argv in /proc/1/cmdline and records each bind's SOURCE path in
// /proc/self/mountinfo, and a source under the campaign names the experiment, the campaign,
// the arm and the repetition to anything that reads either file. Nothing can launder a
// mount source, so the repair is to mount from somewhere that says nothing. Both halves are
// defined together so a rename cannot land in the wrong place, and so the sealed half stays
// exactly what every reader of a sealed run has always addressed.
export function runBindSources(runDir, stagingRoot) {
  return {
    live: {
      checkout: join(stagingRoot, "repo"),
      session: join(stagingRoot, "session"),
      sandbox: join(stagingRoot, "sandbox"),
    },
    sealed: {
      checkout: join(runDir, "repo"),
      session: join(runDir, "session"),
      sandbox: `${runDir}.sandbox`,
    },
  };
}

// The trees the model can write, addressed under whichever root currently holds them.
// A run stages its bind sources under an opaque directory and renames them into
// <runDir>.sandbox at seal, so the supervisor needs these same three names at two
// different roots: naming them once here is what keeps the two agreeing. Order matches
// modelWrittenFiles' own parameters.
export function modelWritableTrees(root) {
  return [join(root, "home"), join(root, "scratch"), join(root, "notes")];
}

// Everything the model itself put on disk, for the adjudicator to read. The two
// writable places it has are its home and its scratch; the checkout is read-only
// and the run directory holds the harness's own artifacts. Returned sorted so a
// run's manifest is stable, with content hashed rather than carried, because the
// point is to be able to ASK whether an answer came from here.
export function modelWrittenFiles(homeDir, scratchDir, notesDir = null) {
  const found = [];
  const walk = (root, label) => {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) { walk(full, `${label}/${entry.name}`); continue; }
      if (!entry.isFile()) continue;
      const bytes = readFileSync(full);
      found.push({
        path: `${label}/${entry.name}`,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(homeDir, SANDBOX_PATHS.home);
  walk(scratchDir, SANDBOX_PATHS.scratch);
  // The notes directory is writable too, so every byte the model leaves there is sealed
  // beside the rest. The harness's own planted text lands here as well, which is right:
  // the seal states what was on disk, and the artifact snapshots state who wrote it.
  if (notesDir !== null) walk(notesDir, SANDBOX_PATHS.notes);
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

// The worker names its session file from INSIDE the namespace, so every reader on
// this side has to translate. Pre-sandbox runs reported a host path already and are
// returned unchanged, which is what keeps sealed campaigns adjudicable. One
// definition on purpose: the supervisor needs it at readiness and the adjudicator
// needs it months later, and two copies would drift.
export function hostSessionFile(runDir, reported) {
  if (typeof reported !== "string" || !reported.startsWith(`${SANDBOX_PATHS.session}/`)) {
    return reported;
  }
  return join(runDir, "session", basename(reported));
}

export function sandboxSessionPath(sessionDir, sessionFile) {
  return join(SANDBOX_PATHS.session, basename(sessionFile ?? "", ""));
}
