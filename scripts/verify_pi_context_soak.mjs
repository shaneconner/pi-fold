#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOAK_CALIBRATION_HEARTBEAT_MS,
  SOAK_CALIBRATION_STAGE_COUNT,
  SOAK_CALIBRATION_STAGE_INTERVAL_MS,
  SOAK_CALIBRATION_WATCHDOG_MS,
  SOAK_HEARTBEAT_MS,
  SOAK_MIN_DURATION_MS,
  SOAK_MODE_ACCEPTANCE,
  SOAK_MODE_CALIBRATION,
  SOAK_PACING_FLOOR_MS,
  SOAK_SANITIZED_ENV_MARKER,
  SOAK_STAGE_COUNT,
  SOAK_STAGE_INTERVAL_MS,
  SOAK_VERIFICATION_WATCHDOG_MS,
  SOAK_WATCHDOG_MS,
  assertSanitizedRuntimeEnvironment,
  directoryTreeSha256,
  freshChallenge,
  paceRecordIdentity,
  parseSystemdExecStart,
  providerRuntimeProjection,
  readJson,
  readJsonLines,
  renderArchiveStage,
  sha256Json,
  sha256Text,
  validateExternalClockBounds,
  validateHeartbeatRecords,
  validatePaceRecords,
  validateProviderExchange,
  validateRunConfig,
  verifySourceHashes,
  writeJsonPublished,
  writeTerminalAcceptanceSeal,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relative) => readFileSync(join(PROJECT, relative), "utf8");
assert.equal(SOAK_CALIBRATION_STAGE_COUNT, 8);
assert.equal(SOAK_CALIBRATION_STAGE_INTERVAL_MS, 60_000);
assert.equal(SOAK_CALIBRATION_WATCHDOG_MS, 30 * 60 * 1_000);
assert.equal(SOAK_CALIBRATION_HEARTBEAT_MS, 5_000);
assert(SOAK_CALIBRATION_STAGE_COUNT < SOAK_STAGE_COUNT);
assertSanitizedRuntimeEnvironment({
  [SOAK_SANITIZED_ENV_MARKER]: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/shane",
  XDG_RUNTIME_DIR: "/run/user/1000",
});
assert.throws(() => assertSanitizedRuntimeEnvironment({
  [SOAK_SANITIZED_ENV_MARKER]: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/shane",
  XDG_RUNTIME_DIR: "/run/user/1000",
  NODE_OPTIONS: "--require=/tmp/overlay.cjs",
}), /Unsafe inherited soak environment/);
assert.throws(() => assertSanitizedRuntimeEnvironment({
  [SOAK_SANITIZED_ENV_MARKER]: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/shane",
  XDG_RUNTIME_DIR: "/run/user/1000",
  GIT_DIR: "/tmp/fabricated.git",
}), /Unsafe inherited soak environment/);
assert.throws(() => assertSanitizedRuntimeEnvironment({
  [SOAK_SANITIZED_ENV_MARKER]: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/shane",
  XDG_RUNTIME_DIR: "/run/user/1000",
  GIT_CONFIG_PARAMETERS: "'core.filemode=false'",
}), /Unsafe inherited soak environment/);

const exactExecStart = parseSystemdExecStart(
  "{ path=/usr/bin/node ; argv[]=/usr/bin/node /repo/scripts/run_pi_context_soak.mjs --run-dir /state/run --unit unit.service --calibration ; ignore_errors=no ; start_time=[] ; }",
);
assert.equal(exactExecStart.path, "/usr/bin/node");
assert.deepEqual(exactExecStart.argv, [
  "/usr/bin/node", "/repo/scripts/run_pi_context_soak.mjs", "--run-dir", "/state/run",
  "--unit", "unit.service", "--calibration",
]);
assert.throws(() => parseSystemdExecStart(
  "{ path=/usr/bin/node-wrapper ; argv[]=/usr/bin/node /repo/scripts/run_pi_context_soak.mjs --run-dir /state/run ; ignore_errors=no ; }",
), /executable path is not exact/);

const sourceHashes = Object.fromEntries([
  ".pi/extensions/quorum/index.js",
  ".pi/extensions/quorum/active-context.ts",
  ".pi/settings.json",
  "scripts/lib/pi_context_soak_attestation.mjs",
  "scripts/pi_context_soak_extension.mjs",
  "scripts/run_pi_context_soak.mjs",
  "scripts/run_pi_context_soak_worker.mjs",
  "scripts/adjudicate_pi_context_soak.mjs",
  "scripts/audit_pi_context_recovery.mjs",
].map((path, index) => [path, String(index + 1).padStart(64, "0")]));
const scratch = mkdtempSync(join(tmpdir(), "pi-context-soak-attestation-"));
try {
  writeFileSync(join(scratch, "source.txt"), "one");
  const sourceTreeBefore = directoryTreeSha256(scratch);
  verifySourceHashes(scratch, { "source.txt": sha256Text("one") });
  writeFileSync(join(scratch, "source.txt"), "two");
  assert.notEqual(directoryTreeSha256(scratch), sourceTreeBefore);
  assert.throws(() => verifySourceHashes(scratch, { "source.txt": sha256Text("one") }),
    /source hash drifted/);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const sealScratch = mkdtempSync(join(tmpdir(), "pi-context-soak-seal-"));
try {
  const sealPath = join(sealScratch, "acceptance-seal.json");
  writeTerminalAcceptanceSeal(sealPath, {
    version: 1,
    terminal: true,
    runId: "run-1",
    codeCommit: "1".repeat(40),
    evidenceSha256: "2".repeat(64),
    manifestSha256: "3".repeat(64),
    sealedWallMs: 1_800_000_000_000,
    acceptance: true,
  });
  const seal = JSON.parse(readFileSync(sealPath, "utf8"));
  assert.equal(seal.acceptance, true);
  assert.equal(Object.keys(seal).at(-1), "acceptance");
  assert.deepEqual(readdirSync(sealScratch), ["acceptance-seal.json"]);
  assert.throws(() => writeTerminalAcceptanceSeal(sealPath, seal), /EEXIST/);
} finally {
  rmSync(sealScratch, { recursive: true, force: true });
}

const publicationScratch = mkdtempSync(join(tmpdir(), "pi-context-publication-"));
try {
  const publicationPath = join(publicationScratch, "stage.json");
  const publication = { version: 1, payload: "p".repeat(2 * 1024 * 1024) };
  writeJsonPublished(publicationPath, publication);
  assert.deepEqual(JSON.parse(readFileSync(publicationPath, "utf8")), publication);
  assert.deepEqual(readdirSync(publicationScratch), ["stage.json"]);
  assert.throws(() => writeJsonPublished(publicationPath, { version: 2 }), /EEXIST/);
  assert.deepEqual(readdirSync(publicationScratch), ["stage.json"]);
} finally {
  rmSync(publicationScratch, { recursive: true, force: true });
}

const config = validateRunConfig({
  version: 1,
  runId: "2026-08-02T00-00-00Z-abcdef123456",
  runDir: "/home/shane/quorum-run/state/ops/pi-context-hours-soak/2026-08-02T00-00-00Z-abcdef123456",
  mode: SOAK_MODE_ACCEPTANCE,
  unit: "quorum-pi-context-soak-test.service",
  invocationId: "1".repeat(32),
  supervisorPid: 1234,
  supervisorStartTicks: 5678,
  bootId: "11111111-1111-1111-1111-111111111111",
  codeCommit: "2".repeat(40),
  codeTree: "3".repeat(40),
  firstChallenge: "4".repeat(64),
  stageCount: SOAK_STAGE_COUNT,
  stageIntervalMs: SOAK_STAGE_INTERVAL_MS,
  minimumDurationMs: SOAK_MIN_DURATION_MS,
  watchdogMs: SOAK_WATCHDOG_MS,
  heartbeatMs: SOAK_HEARTBEAT_MS,
  createdWallMs: 1_800_000_000_000,
  createdMonotonicMs: 10_000,
  sourceHashes,
  dependencyHashes: {
    piPackageJson: "e".repeat(64),
    piDistTree: "f".repeat(64),
    piNodeModulesTree: "1".repeat(64),
    piSubagentsPackageJson: "3".repeat(64),
    piSubagentsSrcTree: "4".repeat(64),
    nodeExecutable: "2".repeat(64),
  },
  calibration: {
    runId: "2026-08-02T00-00-00Z-123456abcdef",
    candidateReportSha256: "d".repeat(64),
    evidenceSha256: "c".repeat(64),
    projectedWallClockMs: 14_000_000,
    providerTurnP95Ms: 10_000,
    projectedProviderTurns: 50,
    observedSealingMs: 25_000,
    accepted: true,
  },
});
const calibrationConfig = validateRunConfig({
  ...config,
  mode: SOAK_MODE_CALIBRATION,
  stageCount: SOAK_CALIBRATION_STAGE_COUNT,
  stageIntervalMs: SOAK_CALIBRATION_STAGE_INTERVAL_MS,
  minimumDurationMs: 0,
  watchdogMs: SOAK_CALIBRATION_WATCHDOG_MS,
  heartbeatMs: SOAK_CALIBRATION_HEARTBEAT_MS,
  calibration: null,
});
assert.equal(calibrationConfig.stageCount, 8);
assert.throws(() => validateRunConfig({ ...calibrationConfig, stageCount: 6 }),
  /Calibration soak constants are invalid/);

const pace = [];
let priorPace = null;
let previousRelease = config.createdMonotonicMs;
let currentChallenge = config.firstChallenge;
for (let stage = 1; stage <= SOAK_STAGE_COUNT; stage += 1) {
  const nextChallenge = stage === SOAK_STAGE_COUNT ? "END" : String(stage + 5).padStart(64, "0");
  const content = renderArchiveStage(stage, nextChallenge);
  const identity = {
    version: 1,
    runId: config.runId,
    stage,
    challengeSha256: sha256Text(currentChallenge),
    requestSha256: sha256Text(`request-${stage}`),
    responseSha256: sha256Text(`response-${stage}`),
    contentSha256: sha256Text(content),
    nextChallengeSha256: sha256Text(nextChallenge),
    requestedWallMs: config.createdWallMs + (stage - 1) * SOAK_STAGE_INTERVAL_MS + 1,
    requestedMonotonicMs: previousRelease + 1,
    releasedWallMs: config.createdWallMs + stage * SOAK_STAGE_INTERVAL_MS,
    releasedMonotonicMs: previousRelease + SOAK_STAGE_INTERVAL_MS,
    priorRecordSha256: priorPace,
  };
  const record = { ...identity, recordSha256: sha256Json(identity) };
  assert.equal(record.recordSha256, paceRecordIdentity(record));
  pace.push(record);
  priorPace = record.recordSha256;
  previousRelease = record.releasedMonotonicMs;
  currentChallenge = nextChallenge;
}
const paceSummary = validatePaceRecords(pace, config);
assert.equal(paceSummary.elapsedMs, SOAK_PACING_FLOOR_MS);
assert(paceSummary.elapsedMs >= SOAK_MIN_DURATION_MS);

const earlyPace = structuredClone(pace);
earlyPace[3].releasedMonotonicMs -= 1;
earlyPace[3].recordSha256 = paceRecordIdentity(earlyPace[3]);
assert.throws(() => validatePaceRecords(earlyPace, config), /before its external pacing gate|priorRecord/);
const duplicateChallenge = structuredClone(pace);
duplicateChallenge[1].challengeSha256 = duplicateChallenge[0].challengeSha256;
duplicateChallenge[1].recordSha256 = paceRecordIdentity(duplicateChallenge[1]);
assert.throws(() => validatePaceRecords(duplicateChallenge, config), /Reused stage challenge|priorRecord|Pace identity/);
const tamperedPace = structuredClone(pace);
tamperedPace[8].contentSha256 = "f".repeat(64);
assert.throws(() => validatePaceRecords(tamperedPace, config), /identity drift/);

const heartbeats = [];
let priorHeartbeat = null;
let heartbeatTime = config.createdMonotonicMs;
let ordinal = 0;
while (heartbeatTime < pace.at(-1).releasedMonotonicMs) {
  heartbeatTime += SOAK_HEARTBEAT_MS;
  const identity = {
    version: 1,
    runId: config.runId,
    ordinal: ++ordinal,
    wallMs: config.createdWallMs + heartbeatTime,
    monotonicMs: heartbeatTime,
    workerPid: 4321,
    workerStartTicks: 8765,
    sessionBytes: ordinal * 100,
    sessionMtimeMs: config.createdWallMs + heartbeatTime,
    priorRecordSha256: priorHeartbeat,
  };
  const record = { ...identity, recordSha256: sha256Json(identity) };
  heartbeats.push(record);
  priorHeartbeat = record.recordSha256;
}
const heartbeatSummary = validateHeartbeatRecords(heartbeats, config, heartbeats.at(-1).monotonicMs);
assert.equal(heartbeatSummary.count, heartbeats.length);
const externalBounds = {
  config,
  systemdStartMonotonicMs: 9_000,
  systemdExitMonotonicMs: pace.at(-1).releasedMonotonicMs + 10_000,
  paceRecords: pace,
  heartbeatRecords: heartbeats,
  supervisor: {
    startedMonotonicMs: config.createdMonotonicMs,
    finishedMonotonicMs: pace.at(-1).releasedMonotonicMs + 1,
  },
  worker: {
    workerStartedMonotonicMs: config.createdMonotonicMs + 1,
    workerFinishedMonotonicMs: pace.at(-1).releasedMonotonicMs,
  },
};
validateExternalClockBounds(externalBounds);
const forgedWallPace = structuredClone(pace);
forgedWallPace[3].requestedWallMs = -2;
forgedWallPace[3].releasedWallMs = -1;
assert.throws(() => validateExternalClockBounds({ ...externalBounds, paceRecords: forgedWallPace }),
  /wall clock moved backwards/);
const outsideSystemdPace = structuredClone(pace);
outsideSystemdPace.at(-1).releasedMonotonicMs = externalBounds.systemdExitMonotonicMs + 1;
assert.throws(() => validateExternalClockBounds({ ...externalBounds, paceRecords: outsideSystemdPace }),
  /outside the retained systemd interval/);
const heartbeatGap = structuredClone(heartbeats);
heartbeatGap[4].monotonicMs += 100_000;
heartbeatGap[4].recordSha256 = sha256Json(Object.fromEntries(
  Object.entries(heartbeatGap[4]).filter(([key]) => key !== "recordSha256"),
));
assert.throws(() => validateHeartbeatRecords(heartbeatGap, config, heartbeats.at(-1).monotonicMs), /Heartbeat/);

const providerExchange = [
  {
    kind: "provider-request", ordinal: 1, recordSha256: "d".repeat(64), leafId: "leaf-1",
    provider: "openai-codex", model: "gpt-5.6-sol", monotonicMs: 20_000,
  },
  {
    kind: "provider-response", ordinal: 2, requestOrdinal: 1,
    requestRecordSha256: "d".repeat(64), requestLeafId: "leaf-1",
    messageSha256: "e".repeat(64), provider: "openai-codex", model: "gpt-5.6-sol",
    monotonicMs: 21_000,
  },
  {
    kind: "provider-request", ordinal: 3, recordSha256: "f".repeat(64), leafId: "leaf-2",
    provider: "openai-codex", model: "gpt-5.6-sol", monotonicMs: 22_000,
  },
  {
    kind: "provider-response", ordinal: 4, requestOrdinal: 3,
    requestRecordSha256: "f".repeat(64), requestLeafId: "leaf-2",
    messageSha256: "1".repeat(64), provider: "openai-codex", model: "gpt-5.6-sol",
    monotonicMs: 23_000,
  },
];
assert.equal(validateProviderExchange(providerExchange).length, 2);
const providerProjection = providerRuntimeProjection(providerExchange, 2, {
  sealingOverheadMs: 25_000,
  safetyMarginMs: 60_000,
});
assert.equal(providerProjection.sealingOverheadMs, 25_000);
assert.equal(providerProjection.safetyMarginMs, 60_000);
assert.equal(providerProjection.projectedWallClockMs,
  SOAK_PACING_FLOOR_MS + providerProjection.projectedProviderTurns * 1_000 + 85_000);
assert.throws(() => validateProviderExchange(providerExchange.slice(0, 3)), /incomplete/);
const replayedProviderResponse = structuredClone(providerExchange);
replayedProviderResponse[3].messageSha256 = replayedProviderResponse[1].messageSha256;
assert.throws(() => validateProviderExchange(replayedProviderResponse), /replayed/);
const mismatchedProviderResponse = structuredClone(providerExchange);
mismatchedProviderResponse[3].requestRecordSha256 = "2".repeat(64);
assert.throws(() => validateProviderExchange(mismatchedProviderResponse), /identity drift/);

const soakRunner = source("scripts/run_pi_context_soak.mjs");
const soakAdjudicator = source("scripts/adjudicate_pi_context_soak.mjs");
const soakContract = source("scripts/lib/pi_context_soak_attestation.mjs");
const soakExtension = source("scripts/pi_context_soak_extension.mjs");
const soakLauncher = source("scripts/launch_pi_context_soak.sh");
const soakAdjudicatorLauncher = source("scripts/adjudicate_pi_context_soak.sh");
const activeContext = source(".pi/extensions/quorum/active-context.ts");
const runtimePolicy = source(".pi/extensions/quorum/lib/policy.ts");
const quorumIndex = source(".pi/extensions/quorum/index.js");
assert(!soakRunner.includes("acceptance: true"));
assert(soakRunner.includes("writeJsonPublished(") && soakExtension.includes("writeJsonPublished(") &&
  !soakExtension.includes("writeJsonExclusive(requestPath") &&
  soakContract.indexOf("durableWrite(temporary") < soakContract.indexOf("linkSync(temporary, path)"));
assert(soakLauncher.startsWith("#!/bin/bash -p") &&
  soakLauncher.indexOf("HOME=/home/shane") < soakLauncher.indexOf("/usr/bin/git") &&
  soakLauncher.includes("GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null") &&
  soakLauncher.includes("--setenv=QUORUM_CONTEXT_SOAK_SANITIZED=1") &&
  soakLauncher.includes("UnsetEnvironment=QUORUM_PI_ROOT NODE_OPTIONS") &&
  soakLauncher.includes("BASH_ENV ENV") &&
  soakAdjudicatorLauncher.startsWith("#!/bin/bash -p") &&
  soakAdjudicatorLauncher.includes("PATH=/usr/local/bin:/usr/bin:/bin") &&
  soakAdjudicatorLauncher.includes("GIT_DIR GIT_WORK_TREE") &&
  soakAdjudicatorLauncher.includes("GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS") &&
  soakAdjudicator.includes('execFileSync("/usr/bin/git"') &&
  soakAdjudicator.includes('execFileSync("/usr/bin/systemctl"'));
assert(soakAdjudicator.includes("acceptance: true") &&
  !soakAdjudicator.includes("acceptance-report.json") &&
  soakAdjudicator.includes("adjudication-evidence.json") &&
  soakAdjudicator.includes("writeTerminalAcceptanceSeal(acceptanceSealPath") &&
  soakAdjudicator.includes("Git revision drifted before terminal acceptance sealing") &&
  soakAdjudicator.includes("systemdCompletion(candidate, config)") &&
  soakAdjudicator.includes("Provider request/response count is not one-to-one") &&
  soakAdjudicator.includes("context.ACTIVE_CONTEXT_TOOL_ACTIONS") &&
  !soakAdjudicator.includes("providerToolNames].filter(Boolean)"));
assert(soakExtension.includes('pi.on("before_provider_request"') &&
  soakExtension.includes('pi.on("session_before_compact"') &&
  soakExtension.indexOf('pi.on("session_before_compact"') <
    soakExtension.indexOf("registerQuorumExtension(pi") &&
  soakExtension.includes('from "../.pi/extensions/quorum/index.js"') &&
  soakExtension.includes("...QUORUM_ACTIVE_CONTEXT_REGISTRATION,") &&
  soakExtension.includes("readOnlyTools: SOAK_READ_ONLY_TOOLS,") &&
  soakExtension.includes("activeContextEnabled: false") &&
  soakExtension.includes("memoryProjectionEnabled: false") &&
  soakExtension.includes("mcpRuntimeEnabled: false") &&
  soakExtension.includes("agentToolEnabled: false") &&
  soakExtension.includes("SOAK_ADVISORY_HOOK_PREFIX") &&
  soakExtension.includes("ADVISORY_BUDGETS") &&
  soakExtension.includes("recoverFoldMessages") &&
  soakExtension.includes("automatic-suspended") &&
  soakExtension.includes("provider-context-schema") &&
  soakExtension.includes("forbidden-tool"));
assert(activeContext.includes("hardFenceRatio") &&
  activeContext.includes("clearArmedAdvisory") &&
  runtimePolicy.includes('windowSource: "reported" | "fallback"') &&
  runtimePolicy.includes("MAX_ADVISORY_DELIVERIES_PER_MILESTONE"));
assert(quorumIndex.includes("export function registerQuorumExtension") &&
  quorumIndex.includes("const ACTIVE_CONTEXT_ENABLED = true") &&
  quorumIndex.includes("if (memoryProjectionEnabled)"));

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${freshChallenge().slice(0, 12)}`;
const runDir = join("/home/shane/quorum-run/tmp", runId);
const sanitizedEnvironment = Object.fromEntries([
  ["PATH", "/usr/local/bin:/usr/bin:/bin"],
  ["HOME", "/home/shane"],
  ["USER", "shane"],
  ["LOGNAME", "shane"],
  ["XDG_RUNTIME_DIR", "/run/user/1000"],
  [SOAK_SANITIZED_ENV_MARKER, "1"],
  ...["LANG", "LC_ALL", "TZ"].flatMap((key) =>
    typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
]);
const runProcess = spawnSync(process.execPath, [
  join(PROJECT, "scripts", "run_pi_context_soak.mjs"),
  "--verification",
  "--run-dir", runDir,
  "--unit", "quorum-pi-context-soak-verification.service",
], {
  cwd: PROJECT,
  env: sanitizedEnvironment,
  encoding: "utf8",
  timeout: SOAK_VERIFICATION_WATCHDOG_MS + 30_000,
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(runProcess.error, undefined,
  `Real verification runner failed to spawn: ${runProcess.error?.message}`);
assert.equal(runProcess.status, 0,
  `Real verification runner failed (${runProcess.status}): ${runProcess.stderr || runProcess.stdout}`);
const runResult = JSON.parse(runProcess.stdout);
assert.equal(runResult.ok, true, "Real verification runner rejected its candidate");
assert.equal(runResult.runDir, runDir, "Real verification runner changed its artifact directory");

const adjudicationProcess = spawnSync(process.execPath, [
  join(PROJECT, "scripts", "adjudicate_pi_context_soak.mjs"),
  "--verification", runDir,
], {
  cwd: PROJECT,
  env: sanitizedEnvironment,
  encoding: "utf8",
  timeout: 90_000,
  maxBuffer: 16 * 1024 * 1024,
});
assert.equal(adjudicationProcess.error, undefined,
  `Real soak adjudicator failed to spawn: ${adjudicationProcess.error?.message}`);
assert.equal(adjudicationProcess.status, 0,
  `Real soak adjudication failed (${adjudicationProcess.status}): ${adjudicationProcess.stderr || adjudicationProcess.stdout}`);
const adjudication = JSON.parse(adjudicationProcess.stdout);
assert.equal(adjudication.ok, true, "Real soak adjudicator rejected the run artifacts");
assert.equal(adjudication.verificationAccepted, true,
  "Real soak adjudicator did not issue a verification verdict");
assert.equal(adjudication.runDir, runDir, "Adjudication verdict changed the run directory");
assert(adjudication.summary?.automaticFoldCount >= 1,
  "Real soak adjudication did not prove an automatic durable fold");
const workerReport = readJson(join(runDir, "worker-report.json"));
const sessionEntries = readJsonLines(workerReport.sessionFile);
const markerIndex = sessionEntries.findIndex((entry) => entry?.id === workerReport.markerId);
assert(markerIndex >= 0, "Verification recount cannot find the run marker");
const runAssistantEntries = sessionEntries.slice(markerIndex + 1).filter((entry) =>
  entry?.type === "message" && entry.message?.role === "assistant");
const usageRecount = {
  requests: runAssistantEntries.length,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  entriesWithoutUsage: 0,
};
for (const entry of runAssistantEntries) {
  const usage = entry.message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    usageRecount.entriesWithoutUsage += 1;
    continue;
  }
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    assert(Number.isFinite(usage[field]) && usage[field] >= 0,
      `Verification recount found invalid assistant usage ${field}`);
    usageRecount[field] += usage[field];
  }
}
assert.deepEqual(adjudication.summary.usageTotals, usageRecount,
  "Adjudicated usage totals differ from an entry-by-entry session recount");
const providerPairCount = validateProviderExchange(
  readJsonLines(join(runDir, "provider-requests.jsonl")),
).length;
assert.equal(adjudication.summary.usageTotals.requests, providerPairCount,
  "Usage request count differs from the provider-request ledger pair count");

const report = {
  ok: true,
  acceptance: false,
  preflightOnly: true,
  contract: {
    stageCount: SOAK_STAGE_COUNT,
    stageIntervalMs: SOAK_STAGE_INTERVAL_MS,
    pacingFloorMs: SOAK_PACING_FLOOR_MS,
    minimumDurationMs: SOAK_MIN_DURATION_MS,
    watchdogMs: SOAK_WATCHDOG_MS,
  },
  checks: {
    acceptanceConstantsImmutable: true,
    sourceDriftRejectedBeforeLoad: true,
    externalPromptAndModelOverlaysDisabled: true,
    inheritedRuntimeOverlaysRejected: true,
    systemdSanitizedEnvironmentExplicitlyPropagated: true,
    privilegedShellIgnoresBashEnv: true,
    gitAndSystemctlUseAbsolutePaths: true,
    launcherPinsHomeBeforeGitAndDisablesGitConfig: true,
    gitRoutingEnvironmentRejected: true,
    unnamedProviderToolsRejected: true,
    calibrationStageCount: SOAK_CALIBRATION_STAGE_COUNT,
    realIndexBootstrap: true,
    advisoryRuntimeOnly: true,
    deterministicFloorAllowed: true,
    realWorkerSpawned: true,
    realAdjudicatorUsed: true,
    realRunDirectory: runDir,
    realAdjudication: adjudication.summary,
    automaticDurableFoldArtifactProof: true,
    usageTotalsArtifactRecount: true,
    transitiveDependencyTreeDriftRejected: true,
    monotonicPaceChain: true,
    earlyReleaseRejected: true,
    duplicateChallengeRejected: true,
    paceTamperRejected: true,
    heartbeatGapRejected: true,
    forgedArtifactClocksRejected: true,
    systemdClockBoundsRequired: true,
    exactSystemdExecutableAndArgvRequired: true,
    calibrationUsesObservedSealing: true,
    calibrationsCannotAuthorize: true,
    dedicatedAdjudicatorOnlyAuthority: true,
    terminalAcceptanceSealPublishedLast: true,
    acceptanceSealExclusiveWithoutTrueTemp: true,
    ipcPublicationAtomicAndExclusive: true,
    gitRevalidatedBeforeAcceptanceSeal: true,
    advisoryHookLedgerRequired: true,
    providerRequestResponseBijection: true,
    providerReplayRejected: true,
    externalPacingRetained: true,
    independentAdjudicationRetained: true,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
