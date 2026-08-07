#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  SOAK_BEHAVIORAL_MODE,
  SOAK_CALIBRATION_HEARTBEAT_MS,
  SOAK_CALIBRATION_STAGE_COUNT,
  SOAK_CALIBRATION_STAGE_INTERVAL_MS,
  SOAK_CALIBRATION_WATCHDOG_MS,
  SOAK_HEARTBEAT_MS,
  SOAK_MIN_DURATION_MS,
  SOAK_MODE_ACCEPTANCE,
  SOAK_MODE_CALIBRATION,
  SOAK_MODE_VERIFICATION,
  SOAK_PACING_FLOOR_MS,
  SOAK_PI_SUBAGENTS_ROOT,
  SOAK_PROTOCOL_VERSION,
  SOAK_RUNNER_MODE,
  SOAK_SANITIZED_ENV_MARKER,
  SOAK_STAGE_COUNT,
  SOAK_STAGE_INTERVAL_MS,
  SOAK_WATCHDOG_MS,
  SOAK_VERIFICATION_HEARTBEAT_MS,
  SOAK_VERIFICATION_STAGE_INTERVAL_MS,
  SOAK_VERIFICATION_WATCHDOG_MS,
  appendJsonLineFsync,
  artifactStat,
  assertSanitizedRuntimeEnvironment,
  assertRunId,
  assertSoak,
  assertUnitName,
  bootId,
  directoryTreeSha256,
  exactKeys,
  fileSha256,
  freshChallenge,
  monotonicMs,
  paceRecordIdentity,
  parseSystemdShow,
  processStartTicks,
  providerRuntimeProjection,
  readJson,
  readJsonLines,
  renderArchiveStage,
  runtimeSourcePaths,
  sha256Json,
  sha256Text,
  validateHeartbeatRecords,
  validatePaceRecords,
  validateRunConfig,
  verifySourceHashes,
  writeJsonExclusive,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const STATE_ROOT = "/home/shane/quorum-run/state/ops/pi-context-hours-soak";
const VERIFICATION_ROOT = "/home/shane/quorum-run/tmp";
const args = new Set(process.argv.slice(2));
const preflightOnly = args.has("--preflight");
const calibration = args.has("--calibration");
const verification = args.has("--verification");
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

function sanitizedChildEnvironment(extra = {}) {
  const environment = {};
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    if (typeof process.env[key] === "string") environment[key] = process.env[key];
  }
  environment.PATH = "/usr/local/bin:/usr/bin:/bin";
  environment.HOME = "/home/shane";
  environment.USER = "shane";
  environment.LOGNAME = "shane";
  environment.XDG_RUNTIME_DIR = "/run/user/1000";
  environment[SOAK_SANITIZED_ENV_MARKER] = "1";
  return { ...environment, ...extra };
}

function dependencyHashes() {
  return {
    piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
    piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
    piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
    piSubagentsPackageJson: fileSha256(join(SOAK_PI_SUBAGENTS_ROOT, "package.json")),
    piSubagentsSrcTree: directoryTreeSha256(join(SOAK_PI_SUBAGENTS_ROOT, "src")),
    nodeExecutable: fileSha256(process.execPath),
  };
}

function gitExec(args, options = {}) {
  return execFileSync("/usr/bin/git", [
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args,
  ], {
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
}

function gitAttestation({ requireClean = true } = {}) {
  const head = gitExec(["-C", PROJECT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = gitExec(["-C", PROJECT, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const status = gitExec(["-C", PROJECT, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" });
  if (requireClean) {
    assertSoak(status === "", `Soak requires a completely clean worktree: ${status.trim()}`);
  }
  return { head, tree, statusSha256: sha256Text(status) };
}

function systemdAttestation(unit) {
  const text = execFileSync("/usr/bin/systemctl", [
    "--user", "show", unit,
    "--property=Id,InvocationID,MainPID,ActiveState,SubState,ExecMainStartTimestampMonotonic",
  ], { encoding: "utf8" });
  const properties = parseSystemdShow(text);
  assertSoak(properties.Id === unit && properties.InvocationID === process.env.INVOCATION_ID &&
    Number(properties.MainPID) === process.pid && properties.ActiveState === "active" &&
    Number(properties.ExecMainStartTimestampMonotonic) > 0,
  `Soak systemd identity drifted: ${JSON.stringify(properties)}`);
  return properties;
}

function waitTick(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childCompletion(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, wallMs: Date.now(), monotonicMs: monotonicMs() }));
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

async function supervisedWait({ state, worker, sessionFile, predicate, label, absoluteDeadline }) {
  while (!predicate()) {
    const now = monotonicMs();
    if (now >= absoluteDeadline) throw new Error(`${label} exceeded its monotonic deadline`);
    if (worker.exitCode !== null || worker.signalCode !== null) {
      throw new Error(`${label} lost worker: code=${worker.exitCode} signal=${worker.signalCode}`);
    }
    if (now - state.lastHeartbeatMonotonicMs >= state.config.heartbeatMs) {
      appendHeartbeat(state, worker, sessionFile);
    }
    await waitTick();
  }
}

function parseRequest(path, config, stage, expectedChallenge, worker) {
  const request = readJson(path);
  assertSoak(exactKeys(request, [
    "version", "runId", "stage", "challenge", "challengeSha256", "toolCallId",
    "workerPid", "workerStartTicks", "requestedWallMs", "requestedMonotonicMs", "requestSha256",
  ]), `Invalid stage request shape ${stage}`);
  const { requestSha256, ...identity } = request;
  assertSoak(request.version === 1 && request.runId === config.runId && request.stage === stage &&
    request.challenge === expectedChallenge && request.challengeSha256 === sha256Text(expectedChallenge) &&
    request.workerPid === worker.pid && request.workerStartTicks === processStartTicks(worker.pid) &&
    request.requestSha256 === sha256Json(identity),
  `Stage request identity drift ${stage}`);
  return request;
}

function responseIdentity(response) {
  const { responseSha256: _response, paceRecordSha256: _pace, ...identity } = response;
  return sha256Json(identity);
}

function calibrationAttestation(path, git) {
  assertSoak(path && existsSync(path) && basename(path) === "candidate-report.json",
    "Acceptance soak requires --calibration-report <candidate-report.json>");
  const calibrationRunDir = resolve(dirname(path));
  assertSoak(dirname(calibrationRunDir) === STATE_ROOT &&
    resolve(path) === join(calibrationRunDir, "candidate-report.json"),
  "Calibration report is outside its canonical soak run directory");
  const stdout = execFileSync(process.execPath, [
    join(PROJECT, "scripts", "adjudicate_pi_context_soak.mjs"),
    "--calibration",
    calibrationRunDir,
  ], { cwd: PROJECT, encoding: "utf8" });
  const result = JSON.parse(stdout);
  const evidence = result.evidence;
  assertSoak(result.ok === true && result.acceptance === false &&
    result.calibrationAccepted === true && result.evidenceSha256 === sha256Json(evidence) &&
    evidence.codeCommit === git.head && evidence.candidateReportSha256 === fileSha256(path) &&
    evidence.projectedWallClockMs <= SOAK_WATCHDOG_MS,
  "Independent calibration adjudication rejected the acceptance launch");
  return {
    runId: evidence.runId,
    candidateReportSha256: evidence.candidateReportSha256,
    evidenceSha256: result.evidenceSha256,
    projectedWallClockMs: evidence.projectedWallClockMs,
    providerTurnP95Ms: evidence.providerTurnP95Ms,
    projectedProviderTurns: evidence.projectedProviderTurns,
    observedSealingMs: evidence.observedSealingMs,
    accepted: true,
  };
}

function createRunConfig({
  runId, runDir, mode, unit, invocationId, git, sourceHashes, dependencies, calibration,
}) {
  const acceptance = mode === SOAK_MODE_ACCEPTANCE;
  const shortVerification = mode === SOAK_MODE_VERIFICATION;
  return validateRunConfig({
    version: SOAK_PROTOCOL_VERSION,
    runId,
    runDir,
    mode,
    unit,
    invocationId,
    supervisorPid: process.pid,
    supervisorStartTicks: processStartTicks(process.pid),
    bootId: bootId(),
    codeCommit: git.head,
    codeTree: git.tree,
    firstChallenge: freshChallenge(),
    stageCount: acceptance || shortVerification ? SOAK_STAGE_COUNT : SOAK_CALIBRATION_STAGE_COUNT,
    stageIntervalMs: acceptance ? SOAK_STAGE_INTERVAL_MS
      : shortVerification ? SOAK_VERIFICATION_STAGE_INTERVAL_MS : SOAK_CALIBRATION_STAGE_INTERVAL_MS,
    minimumDurationMs: acceptance ? SOAK_MIN_DURATION_MS : 0,
    watchdogMs: acceptance ? SOAK_WATCHDOG_MS
      : shortVerification ? SOAK_VERIFICATION_WATCHDOG_MS : SOAK_CALIBRATION_WATCHDOG_MS,
    heartbeatMs: acceptance ? SOAK_HEARTBEAT_MS
      : shortVerification ? SOAK_VERIFICATION_HEARTBEAT_MS : SOAK_CALIBRATION_HEARTBEAT_MS,
    createdWallMs: Date.now(),
    createdMonotonicMs: monotonicMs(),
    sourceHashes,
    dependencyHashes: dependencies,
    calibration,
  });
}

function launchProjection(runDir, config) {
  return providerRuntimeProjection(
    readJsonLines(join(runDir, "provider-requests.jsonl")),
    config.stageCount,
  );
}

function preflightReport() {
  const git = gitAttestation();
  const sourceHashes = runtimeSourcePaths(PROJECT);
  const dependencies = dependencyHashes();
  return {
    ok: true,
    acceptance: false,
    acceptanceCandidate: false,
    preflightOnly: true,
    version: 1,
    behavioralMode: SOAK_BEHAVIORAL_MODE,
    runnerMode: SOAK_RUNNER_MODE,
    codeCommit: git.head,
    codeTree: git.tree,
    sourceHashes,
    dependencyHashes: dependencies,
    plan: {
      stageCount: SOAK_STAGE_COUNT,
      stageIntervalMs: SOAK_STAGE_INTERVAL_MS,
      calibrationStageCount: SOAK_CALIBRATION_STAGE_COUNT,
      calibrationStageIntervalMs: SOAK_CALIBRATION_STAGE_INTERVAL_MS,
      calibrationWatchdogMs: SOAK_CALIBRATION_WATCHDOG_MS,
      calibrationHeartbeatMs: SOAK_CALIBRATION_HEARTBEAT_MS,
      pacingFloorMs: SOAK_PACING_FLOOR_MS,
      minimumDurationMs: SOAK_MIN_DURATION_MS,
      watchdogMs: SOAK_WATCHDOG_MS,
      sequentialChallengeOwner: "external-supervisor",
      providerSessions: 1,
      workerProcesses: 1,
      acceptanceRequiresPassingCalibration: true,
    },
  };
}

async function run() {
  if (preflightOnly) {
    assertSanitizedRuntimeEnvironment(process.env, { requireMarker: false });
    return preflightReport();
  }
  assertSanitizedRuntimeEnvironment(process.env);
  const requestedRunDir = argumentValue("--run-dir");
  const unit = assertUnitName(argumentValue("--unit"));
  assertSoak(requestedRunDir, "Live soak requires --run-dir");
  const runDir = resolve(requestedRunDir);
  const requiredRoot = verification ? VERIFICATION_ROOT : STATE_ROOT;
  assertSoak(dirname(runDir) === requiredRoot, `Soak run directory must live under ${requiredRoot}`);
  const runId = assertRunId(basename(runDir));
  const invocationId = verification ? freshChallenge().slice(0, 32) : process.env.INVOCATION_ID;
  assertSoak(typeof invocationId === "string" && /^[0-9a-f]{32}$/.test(invocationId),
    "Live soak lacks a valid invocation identity");
  const systemdStart = verification ? null : systemdAttestation(unit);
  const gitStart = gitAttestation({ requireClean: !verification });
  const sourceHashes = runtimeSourcePaths(PROJECT);
  const dependencies = dependencyHashes();
  const calibrationProof = calibration || verification
    ? null
    : calibrationAttestation(argumentValue("--calibration-report"), gitStart);
  mkdirSync(runDir, { recursive: false, mode: 0o700 });
  for (const relative of ["ipc", "ipc/requests", "ipc/responses"]) {
    mkdirSync(join(runDir, relative), { mode: 0o700 });
  }
  const config = createRunConfig({
    runId,
    runDir,
    mode: verification ? SOAK_MODE_VERIFICATION
      : calibration ? SOAK_MODE_CALIBRATION : SOAK_MODE_ACCEPTANCE,
    unit,
    invocationId,
    git: gitStart,
    sourceHashes,
    dependencies,
    calibration: calibrationProof,
  });
  const configPath = join(runDir, "run-config.json");
  writeJsonExclusive(configPath, config);
  closeSync(openSync(join(runDir, "failure-latch.jsonl"), "wx", 0o600));
  const stdoutFd = openSync(join(runDir, "worker.stdout.log"), "wx", 0o600);
  const stderrFd = openSync(join(runDir, "worker.stderr.log"), "wx", 0o600);
  const worker = spawn(process.execPath, [join(PROJECT, "scripts", "run_pi_context_soak_worker.mjs"), configPath], {
    cwd: PROJECT,
    env: sanitizedChildEnvironment({ QUORUM_CONTEXT_SOAK_RUN_ID: runId }),
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
  let workerReady;
  let workerExit;
  let failure = null;
  try {
    const readyPath = join(runDir, "worker-ready.json");
    await supervisedWait({
      state, worker, sessionFile: null,
      predicate: () => existsSync(readyPath),
      label: "worker readiness",
      absoluteDeadline: config.createdMonotonicMs + 2 * 60 * 1_000,
    });
    workerReady = readJson(readyPath);
    assertSoak(workerReady.runId === runId && workerReady.workerPid === worker.pid &&
      workerReady.workerStartTicks === processStartTicks(worker.pid) &&
      workerReady.sessionFile.startsWith(`${runDir}/`),
    "Worker readiness identity drifted");
    state.workerStartTicks = workerReady.workerStartTicks;
    appendHeartbeat(state, worker, workerReady.sessionFile);

    let expectedChallenge = config.firstChallenge;
    let previousRelease = config.createdMonotonicMs;
    for (let stage = 1; stage <= config.stageCount; stage += 1) {
      const requestPath = join(runDir, "ipc", "requests", `stage-${String(stage).padStart(2, "0")}.json`);
      await supervisedWait({
        state, worker, sessionFile: workerReady.sessionFile,
        predicate: () => existsSync(requestPath),
        label: `stage ${stage} request`,
        absoluteDeadline: config.createdMonotonicMs + config.watchdogMs,
      });
      const request = parseRequest(requestPath, config, stage, expectedChallenge, worker);
      const releaseAt = previousRelease + config.stageIntervalMs;
      await supervisedWait({
        state, worker, sessionFile: workerReady.sessionFile,
        predicate: () => monotonicMs() >= releaseAt,
        label: `stage ${stage} gate`,
        absoluteDeadline: config.createdMonotonicMs + config.watchdogMs,
      });
      const nextChallenge = stage === config.stageCount ? "END" : freshChallenge();
      const content = renderArchiveStage(stage, nextChallenge);
      const responseBase = {
        version: 1,
        runId,
        stage,
        challengeSha256: request.challengeSha256,
        requestSha256: request.requestSha256,
        content,
        contentSha256: sha256Text(content),
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
        nextChallengeSha256: responseBase.nextChallengeSha256,
        requestedWallMs: request.requestedWallMs,
        requestedMonotonicMs: request.requestedMonotonicMs,
        releasedWallMs: responseBase.releasedWallMs,
        releasedMonotonicMs: responseBase.releasedMonotonicMs,
        priorRecordSha256: state.priorPaceSha256,
      };
      const pace = { ...paceIdentity, recordSha256: sha256Json(paceIdentity) };
      assertSoak(pace.recordSha256 === paceRecordIdentity(pace), "Internal pace identity drifted");
      appendJsonLineFsync(join(runDir, "pace.jsonl"), pace);
      state.priorPaceSha256 = pace.recordSha256;
      const response = {
        ...responseBase,
        paceRecordSha256: pace.recordSha256,
        responseSha256,
      };
      assertSoak(responseIdentity(response) === responseSha256, "Internal response identity drifted");
      writeJsonPublished(
        join(runDir, "ipc", "responses", `stage-${String(stage).padStart(2, "0")}.json`),
        response,
      );
      expectedChallenge = nextChallenge;
      previousRelease = pace.releasedMonotonicMs;
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
    assertSoak(workerExit.code === 0 && workerExit.signal === null, `Worker failed: ${JSON.stringify(workerExit)}`);
  } catch (error) {
    failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    appendJsonLineFsync(join(runDir, "failure-latch.jsonl"), {
      version: 1, runId, phase: "supervisor", detail: failure.message,
      wallMs: Date.now(), monotonicMs: monotonicMs(),
    });
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
    workerExit = await completion;
  }

  await waitTick(2);
  const finalHeartbeat = appendHeartbeat(state, worker, workerReady?.sessionFile ?? null);
  const gitEnd = gitAttestation({ requireClean: !verification });
  assertSoak(gitEnd.head === gitStart.head && gitEnd.tree === gitStart.tree &&
    gitEnd.statusSha256 === gitStart.statusSha256,
    "Soak source revision changed during the run");
  verifySourceHashes(PROJECT, sourceHashes);
  assertSoak(JSON.stringify(dependencyHashes()) === JSON.stringify(dependencies),
    "Soak Pi/runtime dependencies changed during the run");
  const paceRecords = readJsonLines(join(runDir, "pace.jsonl"));
  const paceSummary = failure ? null : validatePaceRecords(paceRecords, config);
  const heartbeatRecords = readJsonLines(join(runDir, "heartbeats.jsonl"));
  const heartbeatSummary = validateHeartbeatRecords(
    heartbeatRecords,
    config,
    finalHeartbeat.monotonicMs,
  );
  const workerReportPath = join(runDir, "worker-report.json");
  const sessionFile = workerReady?.sessionFile ?? null;
  const artifactPaths = [
    "run-config.json", "worker-ready.json", "worker-report.json", "pace.jsonl",
    "heartbeats.jsonl", "provider-requests.jsonl", "worker-events.jsonl",
    "worker.stdout.log", "worker.stderr.log",
    ...Array.from({ length: config.stageCount }, (_, index) => [
      `ipc/requests/stage-${String(index + 1).padStart(2, "0")}.json`,
      `ipc/responses/stage-${String(index + 1).padStart(2, "0")}.json`,
    ]).flat(),
  ].filter((relative) => existsSync(join(runDir, relative)));
  if (sessionFile && existsSync(sessionFile)) artifactPaths.push(sessionFile.slice(runDir.length + 1));
  artifactPaths.push("failure-latch.jsonl");
  const artifacts = Object.fromEntries(artifactPaths.map((relative) => [relative, artifactStat(join(runDir, relative))]));
  const projectedLaunch = launchProjection(runDir, config);
  const workerReport = readJson(workerReportPath);
  const failureLatchEntries = readJsonLines(join(runDir, "failure-latch.jsonl")).length;
  const sealingDeadlineMonotonicMs = config.createdMonotonicMs + config.watchdogMs;
  const sealingHeadroomMs = verification ? 5_000 : 60_000;
  assertSoak(monotonicMs() <= sealingDeadlineMonotonicMs - sealingHeadroomMs,
    "Soak left insufficient watchdog headroom for durable sealing");
  const supervisorFinishedWallMs = Date.now();
  const supervisorFinishedMonotonicMs = monotonicMs();
  const candidateOk = !failure && workerReport.ok === true && failureLatchEntries === 0 &&
    (config.mode !== SOAK_MODE_CALIBRATION || projectedLaunch.accepted === true);
  const candidate = {
    version: 1,
    ok: candidateOk,
    acceptance: false,
    acceptanceCandidate: !failure && config.mode === SOAK_MODE_ACCEPTANCE,
    verificationCandidate: !failure && config.mode === SOAK_MODE_VERIFICATION,
    requiresIndependentAdjudication: true,
    runId,
    runDir,
    runnerMode: SOAK_RUNNER_MODE,
    behavioralMode: SOAK_BEHAVIORAL_MODE,
    unit,
    invocationId,
    systemdStart,
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
    gitStart,
    gitEnd,
    sourceHashes,
    dependencyHashes: dependencies,
    paceSummary,
    launchProjection: projectedLaunch,
    heartbeatSummary,
    failure,
    failureLatchEntries,
    artifacts,
  };
  const candidatePath = join(runDir, "candidate-report.json");
  writeJsonExclusive(candidatePath, candidate);
  const sealedWallMs = Date.now();
  const sealedMonotonicMs = monotonicMs();
  assertSoak(sealedMonotonicMs <= sealingDeadlineMonotonicMs - (verification ? 1_000 : 5_000),
    "Soak sealing crossed its watchdog safety fence");
  const seal = {
    version: 1,
    runId,
    acceptance: false,
    candidateReportSha256: fileSha256(candidatePath),
    sessionSha256: sessionFile && existsSync(sessionFile) ? fileSha256(sessionFile) : null,
    finalPaceRecordSha256: paceSummary?.finalRecordSha256 ?? null,
    finalHeartbeatRecordSha256: heartbeatSummary.finalRecordSha256,
    sealedWallMs,
    sealedMonotonicMs,
    workerToSealMs: sealedMonotonicMs - workerExit.monotonicMs,
  };
  writeJsonExclusive(join(runDir, "candidate-seal.json"), seal);
  for (const relative of [...artifactPaths, "candidate-report.json", "candidate-seal.json"]) {
    try { chmodSync(join(runDir, relative), 0o440); } catch { /* Directories and absent optional files are skipped. */ }
  }
  assertSoak(monotonicMs() <= sealingDeadlineMonotonicMs,
    "Soak exceeded its watchdog before process exit");
  return { ...candidate, candidatePath, sealPath: join(runDir, "candidate-seal.json") };
}

let report;
try {
  report = await run();
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  report = {
    ok: false,
    acceptance: false,
    acceptanceCandidate: false,
    preflightOnly,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
