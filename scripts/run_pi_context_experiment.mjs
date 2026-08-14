#!/usr/bin/env node

// Supervisor for ONE fold-vs-compaction run of ONE arm.
//
// Derived from the retired soak supervisor (in git history through 09a4ea5): the
// supervisor owns stage release (the
// worker can never self-serve its own workload), maintains the hash-chained pace and
// heartbeat ledgers, and seals a non-authorizing candidate report that a separate
// adjudicator turns into evidence.
//
//   node scripts/run_pi_context_experiment.mjs --run-dir <dir> --unit <unit> \
//        --campaign-dir <dir> --plan <stages.json> --arm pifold|native|unmanaged|nativefence \
//        [--model-provider openai-codex] [--model-id gpt-5.6-sol] [--effort xhigh]

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPERIMENT_ARMS,
  EXPERIMENT_BEHAVIORAL_MODE,
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_SESSION_TYPES,
  EXPERIMENT_DEPENDENCY_KEYS,
  EXPERIMENT_PROVIDER_INPUT_BUDGETS,
  EXPERIMENT_TRANSPORT,
  EXPERIMENT_GUIDANCE_PROFILES,
  EXPERIMENT_MODE_PLANS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_RUNNER_MODE,
  EXPERIMENT_SCHEDULING_SOURCE,
  EXPERIMENT_STATE_ROOT,
  armRuntimeConfiguration,
  assertExperiment,
  corpusManifestSha256,
  stagePayloadText,
  validateExperimentRunConfig,
  validateStagePlan,
  visibleStage,
} from "./lib/pi_context_experiment.mjs";
import {
  SOAK_MAX_HEARTBEAT_GAP_MS,
  SOAK_SANITIZED_ENV_MARKER,
  appendJsonLineFsync,
  artifactStat,
  assertSanitizedRuntimeEnvironment,
  bootId,
  directoryTreeSha256,
  exactKeys,
  fileSha256,
  freshChallenge,
  monotonicMs,
  paceRecordIdentity,
  parseSystemdShow,
  PI_INSTALL_ROOT,
  RUNTIME_HOME,
  RUNTIME_USER,
  RUNTIME_XDG_DIR,
  processStartTicks,
  readJson,
  readJsonLines,
  sha256Json,
  sha256Text,
  verifySourceHashes,
  writeJsonExclusive,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = PI_INSTALL_ROOT;

const argumentValue = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

// The experiment's own runtime surface, pinned the way the soak pins its own.
const EXPERIMENT_SOURCE_PATHS = Object.freeze([
  "scripts/lib/pi_context_experiment.mjs",
  "scripts/lib/pi_context_soak_attestation.mjs",
  "scripts/lib/pi_fold_identity.mjs",
  "scripts/pi_context_experiment_extension.mjs",
  "scripts/run_pi_context_experiment.mjs",
  "scripts/run_pi_context_experiment_worker.mjs",
  "scripts/adjudicate_pi_context_experiment.mjs",
  "scripts/stage_pi_context_experiment.mjs",
]);

// The epoch scheduler is REQUIRED: epoch is the runtime's only scheduler, so a run that
// cannot pin the code implementing its own condition is not the experiment.
//
// The measured runtime is this repo's own `extensions/` package, not a consumer's deployed
// copy, so every byte under measurement is a tracked byte and `codeCommit` describes it.
// Every source file under that root is pinned rather than a hand-kept subset: a new module
// joins the seal the moment it exists, and the seal can never silently lag the code.
function experimentSourceHashes() {
  const runtimeRoot = join(PROJECT, "extensions");
  assertExperiment(existsSync(runtimeRoot), "pi-fold runtime source root is missing");
  assertExperiment(existsSync(join(PROJECT, EXPERIMENT_SCHEDULING_SOURCE)),
    `Epoch fold scheduling requires ${EXPERIMENT_SCHEDULING_SOURCE}`);
  const runtimePaths = [];
  const collect = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) collect(path, `${prefix}${name}/`);
      else if (name.endsWith(".ts") || name.endsWith(".js")) runtimePaths.push(`${prefix}${name}`);
    }
  };
  collect(runtimeRoot, "extensions/");
  assertExperiment(runtimePaths.includes(EXPERIMENT_SCHEDULING_SOURCE),
    "Runtime source listing lost the scheduling source");
  const paths = [...runtimePaths, ...EXPERIMENT_SOURCE_PATHS];
  return paths.reduce((result, relative) => {
    const path = join(PROJECT, relative);
    assertExperiment(existsSync(path), `Missing experiment runtime source ${relative}`);
    result[relative] = fileSha256(path);
    return result;
  }, {});
}

function dependencyHashes() {
  const hashes = {
    piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
    piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
    piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
    nodeExecutable: fileSha256(process.execPath),
  };
  // Checked here, against the same list the run-config validator uses, so a mismatch is a
  // refusal to launch rather than a run that dies minutes later inside its own supervisor.
  assertExperiment(exactKeys(hashes, EXPERIMENT_DEPENDENCY_KEYS),
    "Supervisor dependency hashes disagree with EXPERIMENT_DEPENDENCY_KEYS");
  return hashes;
}

function gitExec(gitArgs, options = {}) {
  return execFileSync("/usr/bin/git", [
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...gitArgs,
  ], {
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function gitAttestation({ requireClean }) {
  const head = gitExec(["-C", PROJECT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = gitExec(["-C", PROJECT, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const status = gitExec(["-C", PROJECT, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" });
  if (requireClean) {
    assertExperiment(status === "", `Experiment requires a clean worktree: ${status.trim()}`);
  }
  return { head, tree, statusSha256: sha256Text(status) };
}

function sanitizedChildEnvironment(extra = {}) {
  const environment = {};
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.PATH = "/usr/local/bin:/usr/bin:/bin";
  environment.HOME = RUNTIME_HOME;
  environment.USER = RUNTIME_USER;
  environment.LOGNAME = RUNTIME_USER;
  environment.XDG_RUNTIME_DIR = RUNTIME_XDG_DIR;
  environment[SOAK_SANITIZED_ENV_MARKER] = "1";
  return { ...environment, ...extra };
}

// The soak's one-calibration-one-acceptance exclusive create, generalized to N slots: a
// campaign slot is claimed with O_EXCL, so two supervisors can never occupy the same
// (arm, repetition) cell no matter how they were launched.
function claimSlot(campaignDir, arm, repetition, runId) {
  const slotsDir = join(campaignDir, "slots");
  mkdirSync(slotsDir, { recursive: true, mode: 0o700 });
  const slotPath = join(slotsDir, `${arm}-rep${String(repetition).padStart(2, "0")}.claim`);
  writeJsonExclusive(slotPath, {
    version: 1, arm, repetition, runId, pid: process.pid, claimedWallMs: Date.now(),
  });
  return slotPath;
}

function waitTick(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childCompletion(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) =>
      resolve({ code, signal, wallMs: Date.now(), monotonicMs: monotonicMs() }));
  });
}

function appendHeartbeat(state, worker, sessionFile) {
  const sessionStat = sessionFile && existsSync(sessionFile) ? statSync(sessionFile) : null;
  const identity = {
    version: 1,
    runId: state.config.runId,
    ordinal: state.heartbeatOrdinal + 1,
    wallMs: Date.now(),
    monotonicMs: monotonicMs(),
    workerPid: worker.pid,
    workerStartTicks: state.workerStartTicks ?? processStartTicks(worker.pid),
    sessionBytes: sessionStat?.size ?? 0,
    sessionMtimeMs: sessionStat ? Math.trunc(sessionStat.mtimeMs) : 0,
    priorRecordSha256: state.priorHeartbeatSha256,
  };
  const record = { ...identity, recordSha256: sha256Json(identity) };
  appendJsonLineFsync(join(state.config.runDir, "heartbeats.jsonl"), record);
  state.heartbeatOrdinal = identity.ordinal;
  state.priorHeartbeatSha256 = record.recordSha256;
  state.lastHeartbeatMonotonicMs = identity.monotonicMs;
  return record;
}

// A SUPERVISOR KILLED FROM OUTSIDE STILL WRITES ITS CANDIDATE REPORT.
//
// `systemctl stop` signals the whole cgroup, and Node's default handler ends the process
// where it stands: the finalization at the bottom of this file, which writes
// `candidate-report.json` and the artifact table, never runs. The worker installs its own
// handler for exactly this reason, and sol-20260812 rep 9 proved that handler cannot fire
// when the worker is busy: signal handlers run on the event loop, and that worker held 98%
// of a core in synchronous JS for 118 minutes, so systemd escalated to SIGKILL and the run
// left no worker report and no candidate report at all. The supervisor is the process that
// CAN run one: it spends the whole run idle between IPC polls.
//
// It does not rescue the run and must not read as one. The signal is routed into the same
// failure path a blown deadline takes, which latches, ends the worker and writes a report
// that says ok false and names what happened.
let terminationSignal = null;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { terminationSignal ??= signal; });
}

// How long the supervisor waits for a signalled worker before ending it outright. A worker
// that cannot run its own handler cannot exit on request either, and waiting for one that
// never will is how the supervisor came to be killed alongside it.
const WORKER_TERMINATION_GRACE_MS = 10_000;

async function endWorker(worker, completion) {
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
  const graceful = await Promise.race([
    completion.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), WORKER_TERMINATION_GRACE_MS).unref()),
  ]);
  if (!graceful && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  return completion;
}

async function supervisedWait({ state, worker, sessionFile, predicate, label, absoluteDeadline, tolerateExit = false }) {
  while (!predicate()) {
    const now = monotonicMs();
    if (terminationSignal) throw new Error(`${label} terminated by ${terminationSignal}`);
    if (now >= absoluteDeadline) throw new Error(`${label} exceeded its monotonic deadline`);
    if (worker.exitCode !== null || worker.signalCode !== null) {
      if (tolerateExit) return { workerExited: true };
      throw new Error(`${label} lost worker: code=${worker.exitCode} signal=${worker.signalCode}`);
    }
    if (now - state.lastHeartbeatMonotonicMs >= state.config.heartbeatMs) {
      appendHeartbeat(state, worker, sessionFile);
    }
    await waitTick();
  }
  return { workerExited: false };
}

function parseRequest(path, config, stage, expectedChallenge, worker) {
  const request = readJson(path);
  assertExperiment(exactKeys(request, [
    "version", "runId", "stage", "challenge", "challengeSha256", "toolCallId",
    "workerPid", "workerStartTicks", "requestedWallMs", "requestedMonotonicMs", "requestSha256",
  ]), `Invalid stage request shape ${stage}`);
  const { requestSha256, ...identity } = request;
  assertExperiment(request.version === 1 && request.runId === config.runId && request.stage === stage &&
    request.challenge === expectedChallenge &&
    request.challengeSha256 === sha256Text(expectedChallenge) &&
    request.workerPid === worker.pid && request.workerStartTicks === processStartTicks(worker.pid) &&
    request.requestSha256 === sha256Json(identity),
  `Stage request identity drift ${stage}`);
  return request;
}

function responseIdentity(response) {
  const { responseSha256: _response, paceRecordSha256: _pace, ...identity } = response;
  return sha256Json(identity);
}

// Stage content is materialized by the SUPERVISOR from the plan plus the run's pinned
// checkout, and pin-checked against the plan's payload hash before the nonce is spliced in.
function renderStage(plan, stage, repoDir, nextChallenge) {
  const files = stage.files.map((file) => ({
    ...file,
    text: readFileSync(join(repoDir, file.path), "utf8"),
  }));
  assertExperiment(files.every((file) => sha256Text(file.text) === file.sha256),
    `Stage ${stage.ordinal} checkout bytes drifted from the plan`);
  const visible = {
    ...visibleStage(stage),
    files,
  };
  const pinned = stagePayloadText(visible);
  assertExperiment(sha256Text(pinned) === stage.payloadSha256,
    `Stage ${stage.ordinal} rendered payload does not match its planned hash`);
  return stagePayloadText({ ...visible, nextKeyPlaceholder: nextChallenge });
}

async function run() {
  assertSanitizedRuntimeEnvironment(process.env);
  const requestedRunDir = argumentValue("--run-dir");
  const unit = argumentValue("--unit");
  const campaignDir = argumentValue("--campaign-dir");
  const planPath = argumentValue("--plan");
  const sessionType = argumentValue("--session-type", "arm");
  assertExperiment(EXPERIMENT_SESSION_TYPES.includes(sessionType),
    "Invalid --session-type: arm|closed-book");
  const closedBook = sessionType === EXPERIMENT_CLOSED_BOOK_LABEL;
  // A closed-book session has no arm and no arm conditions; its label rides the arm
  // slot so run ids, slot claims and reports stay one shape without ever colliding.
  const arm = closedBook ? EXPERIMENT_CLOSED_BOOK_LABEL : argumentValue("--arm");
  assertExperiment(!closedBook || argumentValue("--arm") === null,
    "--session-type closed-book takes no --arm");
  const repetition = Number(argumentValue("--repetition", "1"));
  const ordinal = Number(argumentValue("--ordinal", "1"));
  const modelProvider = argumentValue("--model-provider", "openai-codex");
  const modelId = argumentValue("--model-id", "gpt-5.6-sol");
  const effort = argumentValue("--effort", "xhigh");
  assertExperiment(requestedRunDir && unit && campaignDir && planPath, "Experiment run requires --run-dir, --unit, --campaign-dir and --plan");
  assertExperiment(closedBook || EXPERIMENT_ARMS.includes(arm),
    `Experiment run requires --arm ${EXPERIMENT_ARMS.join("|")}`);
  // Deployment fact resolved from the model pin, never a tunable: rep 16 aborted after the
  // curation thresholds ran against the 255,616-token descriptor budget because this fact
  // never reached the registration. Unlisted models run in descriptor mode.
  //
  // `--provider-input-budget none` declares NONE, and it is a basis rather than a tuning
  // dial (Shane 2026-08-14). Declaring 251,520 is the descriptor window less Pi's reserve,
  // and it caps BOTH arms below the provider's 272,000 long-context tier by construction.
  // luna-20260807 (Sol throughout; the campaign name is only a label) predates the constant:
  // native drifted to 369,024 tokens and was billed the surcharge on 17 of 117 calls at
  // $20.99, while folding held pi-fold at 236,861 so it never left the base tier at $13.89.
  // That surcharge was the entire cost result, and declaring a budget designs it out, which
  // is how sol-20260814-fenced-full came back $20.88 to $13.74 the other way. Neither basis
  // is wrong; running one while reporting the other would be. The manifest records whichever
  // was used, so a sealed run states its own basis.
  const requestedBudget = argumentValue("--provider-input-budget", null);
  assertExperiment(requestedBudget === null || requestedBudget === "none",
    "Experiment run accepts --provider-input-budget none, or nothing at all: the declared " +
    "budget is a model fact and is not otherwise settable");
  const providerInputBudget = requestedBudget === "none"
    ? null
    : EXPERIMENT_PROVIDER_INPUT_BUDGETS[`${modelProvider}/${modelId}`] ?? null;
  // The matched fence measures a share of the declared budget, so it has nothing to fence
  // against without one. Refused here rather than at the extension, so the run fails at
  // launch instead of after the model has been paid for.
  assertExperiment(arm !== "nativefence" || providerInputBudget !== null,
    "The nativefence arm fences against a declared serving budget and cannot run without one");
  const runDir = resolve(requestedRunDir);
  const requiredRoot = join(EXPERIMENT_STATE_ROOT, basename(resolve(campaignDir)), "runs");
  assertExperiment(dirname(runDir) === requiredRoot, `Run directory must live under ${requiredRoot}`);
  const runId = basename(runDir);
  const invocationId = process.env.INVOCATION_ID;
  assertExperiment(typeof invocationId === "string" && /^[0-9a-f]{32}$/.test(invocationId),
    "Live experiment run lacks a valid invocation identity");
  const properties = parseSystemdShow(execFileSync("/usr/bin/systemctl", [
    "--user", "show", unit,
    "--property=Id,InvocationID,MainPID,ActiveState,ExecMainStartTimestampMonotonic",
  ], { encoding: "utf8" }));
  assertExperiment(properties.Id === unit && properties.InvocationID === invocationId &&
    Number(properties.MainPID) === process.pid && properties.ActiveState === "active",
  `Experiment systemd identity drifted: ${JSON.stringify(properties)}`);

  const plan = validateStagePlan(readJson(resolve(planPath)));
  const modePlan = EXPERIMENT_MODE_PLANS[plan.mode];
  const gitStart = gitAttestation({ requireClean: true });
  const sourceHashes = experimentSourceHashes();
  const dependencies = dependencyHashes();
  const slotPath = claimSlot(resolve(campaignDir), arm, repetition, runId);

  mkdirSync(runDir, { recursive: false, mode: 0o700 });
  for (const relative of ["ipc", "ipc/requests", "ipc/responses"]) {
    mkdirSync(join(runDir, relative), { mode: 0o700 });
  }
  // Every arm run reads its OWN detached worktree at the pinned commit. A closed-book
  // session gets an EMPTY directory in the same position: no checkout bytes exist to
  // leak, and the run-config law that the repo path lives inside the run dir holds.
  const repoDir = join(runDir, "repo");
  const stagedFiles = plan.stages.flatMap((stage) => stage.files);
  const plannedFingerprint = corpusManifestSha256(stagedFiles);
  if (closedBook) {
    mkdirSync(repoDir, { mode: 0o700 });
  } else {
    gitExec(["-C", join(resolve(campaignDir), "repo.git"), "worktree", "add", "--quiet", "--detach",
      repoDir, plan.repo.commit]);
    const checkoutFingerprint = corpusManifestSha256(stagedFiles.map((file) => ({
      path: file.path, sha256: sha256Text(readFileSync(join(repoDir, file.path), "utf8")),
    })));
    assertExperiment(checkoutFingerprint === plannedFingerprint,
      "Run checkout does not reproduce the planned staged corpus");
  }

  const config = validateExperimentRunConfig({
    version: EXPERIMENT_PROTOCOL_VERSION,
    runId,
    runDir,
    campaignId: basename(resolve(campaignDir)),
    arm,
    mode: plan.mode,
    ...(closedBook
      ? { sessionType }
      : {
        ...(providerInputBudget === null ? {} : { providerInputBudget }),
        // No brief generator: the deterministic brief carries the opening prose
        // now (package gate 134), and this run measures the no-generator condition
        // the reviews recommend making permanent. See EXPERIMENT_BRIEF_GENERATOR's
        // retirement note in the library.
      }),
    transport: EXPERIMENT_TRANSPORT,
    repetition,
    ordinal,
    seed: plan.seed,
    unit,
    invocationId,
    supervisorPid: process.pid,
    supervisorStartTicks: processStartTicks(process.pid),
    bootId: bootId(),
    codeCommit: gitStart.head,
    codeTree: gitStart.tree,
    firstChallenge: freshChallenge(),
    stageCount: plan.stageCount,
    stageIntervalMs: modePlan.stageIntervalMs,
    watchdogMs: modePlan.watchdogMs,
    heartbeatMs: modePlan.heartbeatMs,
    createdWallMs: Date.now(),
    createdMonotonicMs: monotonicMs(),
    sourceHashes,
    dependencyHashes: dependencies,
    planPath: resolve(planPath),
    planSha256: plan.planSha256,
    repoDir,
    targetCommit: plan.repo.commit,
    targetTreeSha256: plannedFingerprint,
    model: { provider: modelProvider, id: modelId, effort },
  });
  const configPath = join(runDir, "run-config.json");
  writeJsonExclusive(configPath, config);
  closeSync(openSync(join(runDir, "failure-latch.jsonl"), "wx", 0o600));
  const stdoutFd = openSync(join(runDir, "worker.stdout.log"), "wx", 0o600);
  const stderrFd = openSync(join(runDir, "worker.stderr.log"), "wx", 0o600);
  const worker = spawn(process.execPath, [
    join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), configPath,
  ], {
    cwd: PROJECT,
    env: sanitizedChildEnvironment({ PI_FOLD_EXPERIMENT_RUN_ID: runId }),
    detached: false,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const completion = childCompletion(worker);
  const state = {
    config,
    heartbeatOrdinal: 0,
    priorHeartbeatSha256: null,
    lastHeartbeatMonotonicMs: config.createdMonotonicMs,
    priorPaceSha256: null,
    workerStartTicks: processStartTicks(worker.pid),
  };
  const armRuntime = closedBook
    ? { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: false }
    : armRuntimeConfiguration(arm);
  let workerReady;
  let workerExit;
  let failure = null;
  let stagesReleased = 0;
  let earlyExit = false;
  try {
    const readyPath = join(runDir, "worker-ready.json");
    await supervisedWait({
      state, worker, sessionFile: null,
      predicate: () => existsSync(readyPath),
      label: "worker readiness",
      absoluteDeadline: config.createdMonotonicMs + 5 * 60 * 1_000,
    });
    workerReady = readJson(readyPath);
    assertExperiment(workerReady.runId === runId && workerReady.workerPid === worker.pid &&
      workerReady.arm === arm &&
      workerReady.checkoutSha256 === (closedBook ? null : plannedFingerprint) &&
      workerReady.sessionFile.startsWith(`${runDir}/`),
    "Worker readiness identity drifted");
    state.workerStartTicks = workerReady.workerStartTicks;
    appendHeartbeat(state, worker, workerReady.sessionFile);

    let expectedChallenge = config.firstChallenge;
    let previousRelease = config.createdMonotonicMs;
    // A closed-book session has no stages to release: the loop body never runs and the
    // supervisor drops straight to awaiting the worker's single-turn completion.
    for (let stage = 1; !closedBook && stage <= config.stageCount; stage += 1) {
      const requestPath = join(runDir, "ipc", "requests", `stage-${String(stage).padStart(2, "0")}.json`);
      // The unmanaged arm is expected to die at the window wall mid-plan; that exit is its
      // measurement, so the release loop stops instead of failing the run.
      const waited = await supervisedWait({
        state, worker, sessionFile: workerReady.sessionFile,
        predicate: () => existsSync(requestPath),
        label: `stage ${stage} request`,
        absoluteDeadline: config.createdMonotonicMs + config.watchdogMs,
        tolerateExit: armRuntime.toleratesOverflow,
      });
      if (waited.workerExited) { earlyExit = true; break; }
      const request = parseRequest(requestPath, config, stage, expectedChallenge, worker);
      const releaseAt = previousRelease + config.stageIntervalMs;
      const gated = await supervisedWait({
        state, worker, sessionFile: workerReady.sessionFile,
        predicate: () => monotonicMs() >= releaseAt,
        label: `stage ${stage} gate`,
        absoluteDeadline: config.createdMonotonicMs + config.watchdogMs,
        tolerateExit: armRuntime.toleratesOverflow,
      });
      if (gated.workerExited) { earlyExit = true; break; }
      const planStage = plan.stages[stage - 1];
      const nextChallenge = stage === config.stageCount ? "END" : freshChallenge();
      const content = renderStage(plan, planStage, repoDir, nextChallenge);
      const responseBase = {
        version: 1,
        runId,
        stage,
        challengeSha256: request.challengeSha256,
        requestSha256: request.requestSha256,
        content,
        contentSha256: sha256Text(content),
        payloadSha256: planStage.payloadSha256,
        nextChallenge,
        nextChallengeSha256: sha256Text(nextChallenge),
        releasedWallMs: Date.now(),
        releasedMonotonicMs: monotonicMs(),
      };
      const responseSha256 = sha256Json(responseBase);
      const paceIdentity = {
        version: 1,
        runId,
        stage,
        challengeSha256: request.challengeSha256,
        requestSha256: request.requestSha256,
        responseSha256,
        contentSha256: responseBase.contentSha256,
        payloadSha256: planStage.payloadSha256,
        nextChallengeSha256: responseBase.nextChallengeSha256,
        requestedWallMs: request.requestedWallMs,
        requestedMonotonicMs: request.requestedMonotonicMs,
        releasedWallMs: responseBase.releasedWallMs,
        releasedMonotonicMs: responseBase.releasedMonotonicMs,
        priorRecordSha256: state.priorPaceSha256,
      };
      const pace = { ...paceIdentity, recordSha256: sha256Json(paceIdentity) };
      assertExperiment(pace.recordSha256 === paceRecordIdentity(pace), "Internal pace identity drifted");
      appendJsonLineFsync(join(runDir, "pace.jsonl"), pace);
      state.priorPaceSha256 = pace.recordSha256;
      const response = { ...responseBase, paceRecordSha256: pace.recordSha256, responseSha256 };
      assertExperiment(responseIdentity(response) === responseSha256, "Internal response identity drifted");
      writeJsonPublished(
        join(runDir, "ipc", "responses", `stage-${String(stage).padStart(2, "0")}.json`),
        response,
      );
      expectedChallenge = nextChallenge;
      previousRelease = pace.releasedMonotonicMs;
      stagesReleased = stage;
      appendHeartbeat(state, worker, workerReady.sessionFile);
    }
    workerExit = await Promise.race([
      completion,
      (async () => {
        await supervisedWait({
          state, worker, sessionFile: workerReady.sessionFile,
          predicate: () => worker.exitCode !== null || worker.signalCode !== null,
          label: "worker terminal completion",
          absoluteDeadline: config.createdMonotonicMs + config.watchdogMs,
        });
        return completion;
      })(),
    ]);
    assertExperiment(workerExit.code === 0 && workerExit.signal === null,
      `Worker failed: ${JSON.stringify(workerExit)}`);
  } catch (error) {
    failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    appendJsonLineFsync(join(runDir, "failure-latch.jsonl"), {
      version: 1, runId, phase: "supervisor", detail: failure.message,
      wallMs: Date.now(), monotonicMs: monotonicMs(),
    });
    workerExit = await endWorker(worker, completion);
  }

  await waitTick(2);
  const finalHeartbeat = appendHeartbeat(state, worker, workerReady?.sessionFile ?? null);
  const gitEnd = gitAttestation({ requireClean: false });
  // The pin is the experiment FILE SET (verifySourceHashes, byte-for-byte) and the
  // runtime dependencies, never the repo head: concurrent sessions commit unrelated
  // work in this shared repo, and a moved head over an untouched file set is not
  // contamination (a head pin voided two clean 64/64 runs in rep 1). gitStart and
  // gitEnd both land in the candidate report for the adjudicator to see.
  verifySourceHashes(PROJECT, sourceHashes);
  assertExperiment(JSON.stringify(dependencyHashes()) === JSON.stringify(dependencies),
    "Experiment Pi/runtime dependencies changed during the run");
  const heartbeats = readJsonLines(join(runDir, "heartbeats.jsonl"));
  assertExperiment(heartbeats.length > 0 &&
    finalHeartbeat.monotonicMs - heartbeats.at(-1).monotonicMs <= SOAK_MAX_HEARTBEAT_GAP_MS,
  "Experiment heartbeat trace is empty or stale");
  const workerReport = existsSync(join(runDir, "worker-report.json"))
    ? readJson(join(runDir, "worker-report.json")) : null;
  const sessionFile = workerReady?.sessionFile ?? null;
  const artifactPaths = [
    "run-config.json", "run-manifest.json", "worker-ready.json", "worker-report.json",
    "pace.jsonl", "heartbeats.jsonl", "provider-requests.jsonl", "worker-events.jsonl",
    "tool-results.jsonl", "stop-the-world.jsonl", "worker.stdout.log", "worker.stderr.log",
    ...Array.from({ length: config.stageCount }, (_, index) => [
      `ipc/requests/stage-${String(index + 1).padStart(2, "0")}.json`,
      `ipc/responses/stage-${String(index + 1).padStart(2, "0")}.json`,
    ]).flat(),
  ].filter((relative) => existsSync(join(runDir, relative)));
  if (sessionFile && existsSync(sessionFile)) artifactPaths.push(sessionFile.slice(runDir.length + 1));
  artifactPaths.push("failure-latch.jsonl");
  const artifacts = Object.fromEntries(artifactPaths.map((relative) =>
    [relative, artifactStat(join(runDir, relative))]));
  const failureLatchEntries = readJsonLines(join(runDir, "failure-latch.jsonl")).length;
  const supervisorFinishedWallMs = Date.now();
  const supervisorFinishedMonotonicMs = monotonicMs();
  const candidateOk = !failure && workerReport?.ok === true &&
    (failureLatchEntries === 0 || (armRuntime.toleratesOverflow && Boolean(workerReport?.overflow)));
  const candidate = {
    version: 1,
    ok: candidateOk,
    requiresIndependentAdjudication: true,
    runId,
    runDir,
    campaignId: config.campaignId,
    arm,
    ...(closedBook ? { sessionType } : {}),
    repetition,
    ordinal,
    mode: config.mode,
    runnerMode: EXPERIMENT_RUNNER_MODE,
    behavioralMode: EXPERIMENT_BEHAVIORAL_MODE,
    unit,
    invocationId,
    slotPath,
    supervisor: {
      pid: process.pid,
      startTicks: config.supervisorStartTicks,
      bootId: config.bootId,
      startedWallMs: config.createdWallMs,
      startedMonotonicMs: config.createdMonotonicMs,
      finishedWallMs: supervisorFinishedWallMs,
      finishedMonotonicMs: supervisorFinishedMonotonicMs,
    },
    workerExit,
    workerReady,
    stagesReleased,
    stagesPlanned: config.stageCount,
    earlyExit,
    gitStart,
    gitEnd,
    sourceHashes,
    dependencyHashes: dependencies,
    planSha256: plan.planSha256,
    targetTreeSha256: plannedFingerprint,
    failure,
    // Named on its own rather than left to be read out of `failure.message`: a run ended
    // from outside is not the same finding as one that failed on its own, and rep 9's
    // deaths were reported as "Request was aborted" precisely because nothing said so.
    terminatedBySignal: terminationSignal,
    failureLatchEntries,
    artifacts,
  };
  const candidatePath = join(runDir, "candidate-report.json");
  writeJsonExclusive(candidatePath, candidate);
  const seal = {
    version: 1,
    runId,
    arm,
    candidateReportSha256: fileSha256(candidatePath),
    sessionSha256: sessionFile && existsSync(sessionFile) ? fileSha256(sessionFile) : null,
    finalHeartbeatRecordSha256: finalHeartbeat.recordSha256,
    sealedWallMs: Date.now(),
    sealedMonotonicMs: monotonicMs(),
    workerToSealMs: monotonicMs() - workerExit.monotonicMs,
  };
  writeJsonExclusive(join(runDir, "candidate-seal.json"), seal);
  for (const relative of [...artifactPaths, "candidate-report.json", "candidate-seal.json"]) {
    try { chmodSync(join(runDir, relative), 0o440); } catch { /* Directories and absent optional files are skipped. */ }
  }
  return { ...candidate, candidatePath, sealPath: join(runDir, "candidate-seal.json") };
}

let report;
try {
  report = await run();
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report = {
    ok: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
