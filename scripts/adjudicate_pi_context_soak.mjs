#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SOAK_BEHAVIORAL_MODE,
  SOAK_EXPECTED_TOOL_NAMES,
  SOAK_MARKER_ENTRY,
  SOAK_MIN_DURABLE_FOLDS,
  SOAK_MODE_ACCEPTANCE,
  SOAK_MODE_CALIBRATION,
  SOAK_MODE_VERIFICATION,
  SOAK_MODEL_CONTEXT_ACTIONS,
  SOAK_PI_SUBAGENTS_ROOT,
  SOAK_RUNNER_MODE,
  SOAK_STAGE_COUNT,
  SOAK_TOOL_NAME,
  SOAK_WATCHDOG_MS,
  archiveStageIsPlateau,
  artifactStat,
  assertSanitizedRuntimeEnvironment,
  assertSoak,
  bootId,
  directoryTreeSha256,
  exactKeys,
  fileSha256,
  parseSystemdExecStart,
  parseSystemdShow,
  providerRuntimeProjection,
  readJson,
  readJsonLines,
  renderArchiveStage,
  renderSoakPrompt,
  sha256Bytes,
  sha256Json,
  sha256Text,
  soakSystemPrompt,
  validateExternalClockBounds,
  validateHeartbeatRecords,
  validatePaceRecords,
  validateProviderExchange,
  validateRunConfig,
  verifySourceHashes,
  writeJsonExclusive,
  writeTerminalAcceptanceSeal,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const ACCEPTANCE_ROOT = "/home/shane/quorum-run/state/ops/pi-context-hours-soak";
let SessionManager;
let ModelRuntimeClass;
let context;
let identity;

async function loadRawRuntime() {
  if (SessionManager && context) return;
  const pi = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
  SessionManager = pi.SessionManager;
  ModelRuntimeClass = pi.ModelRuntime;
  const jitiPath = join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs");
  assertSoak(existsSync(jitiPath), "Raw soak adjudication cannot resolve jiti");
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const jiti = createJiti(import.meta.url, {
    alias: {
      "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
      typebox: join(PI_ROOT, "node_modules", "typebox", "build", "index.mjs"),
    },
  });
  context = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "active-context.ts"));
identity = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "identity.js"));
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

function currentGit({ requireClean }) {
  const head = gitExec(["-C", PROJECT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = gitExec(["-C", PROJECT, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const status = gitExec(["-C", PROJECT, "status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" });
  if (requireClean) assertSoak(status === "", `Adjudication requires a clean soak revision: ${status.trim()}`);
  return { head, tree, statusSha256: sha256Text(status) };
}

function sourceAtCommitSha(commit, path) {
  return sha256Bytes(gitExec(["-C", PROJECT, "show", `${commit}:${path}`]));
}

function validateHashChain(records, label) {
  let prior = null;
  for (const [index, record] of records.entries()) {
    const { recordSha256, ...identity } = record;
    assertSoak(record?.ordinal === index + 1 && record.priorRecordSha256 === prior &&
      recordSha256 === sha256Json(identity), `${label} hash-chain drift at ${index + 1}`);
    prior = recordSha256;
  }
  return prior;
}

function messageToolCalls(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => part?.type === "toolCall").map((part) => ({
    entry,
    message,
    id: part.id,
    name: part.name,
    arguments: part.arguments,
  }));
}

const USAGE_TOTAL_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];

function assistantUsageTotals(entries) {
  const totals = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    entriesWithoutUsage: 0,
  };
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    totals.requests += 1;
    const usage = entry.message.usage;
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      totals.entriesWithoutUsage += 1;
      continue;
    }
    for (const field of USAGE_TOTAL_FIELDS) {
      assertSoak(Number.isFinite(usage[field]) && usage[field] >= 0,
        `Assistant usage field ${field} is invalid`);
      totals[field] += usage[field];
    }
  }
  return totals;
}

function lastMessage(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "message") return entries[index];
  }
  return null;
}

function entryIndexByIdentity(entries, id) {
  const indexes = entries.flatMap((entry, index) => entry?.id === id ? [index] : []);
  assertSoak(indexes.length === 1, `Entry identity ${id} is absent or ambiguous`);
  return indexes[0];
}

async function assertIsolatedWorkerModel(worker) {
  const runtime = await ModelRuntimeClass.create({ modelsPath: null, allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  assertSoak(model?.api === "openai-codex-responses" &&
    model.baseUrl === "https://chatgpt.com/backend-api" && model.contextWindow === 272_000 &&
    runtime.getRegisteredProviderConfig("openai-codex") === undefined &&
    worker.model?.provider === model.provider && worker.model?.id === model.id &&
    worker.model?.api === model.api && worker.model?.baseUrl === model.baseUrl &&
    worker.model?.contextWindow === model.contextWindow && worker.model?.maxTokens === 2_048 &&
    worker.model?.descriptorSha256 === sha256Json(model),
  "Worker provider/model descriptor is not the isolated stock built-in");
}

function systemdCompletion(candidate, config) {
  const text = execFileSync("/usr/bin/systemctl", [
    "--user", "show", candidate.unit,
    "--property=Id,InvocationID,ActiveState,SubState,Result,ExecMainPID,ExecStart,ExecMainCode,ExecMainStatus,ExecMainStartTimestampMonotonic,ExecMainExitTimestampMonotonic",
  ], { encoding: "utf8" });
  const properties = parseSystemdShow(text);
  const startUs = Number(properties.ExecMainStartTimestampMonotonic);
  const exitUs = Number(properties.ExecMainExitTimestampMonotonic);
  const execStart = parseSystemdExecStart(properties.ExecStart);
  const expectedArgv = [
    "/usr/bin/node",
    join(PROJECT, "scripts", "run_pi_context_soak.mjs"),
    "--run-dir", config.runDir,
    "--unit", config.unit,
    ...(config.mode === SOAK_MODE_ACCEPTANCE
      ? ["--calibration-report", join(ACCEPTANCE_ROOT, config.calibration.runId, "candidate-report.json")]
      : ["--calibration"]),
  ];
  assertSoak(properties.Id === config.unit && properties.InvocationID === candidate.invocationId &&
    properties.Result === "success" && Number(properties.ExecMainStatus) === 0 &&
    Number(properties.ExecMainPID) === candidate.supervisor.pid && execStart.path === "/usr/bin/node" &&
    JSON.stringify(execStart.argv) === JSON.stringify(expectedArgv) && startUs > 0 && exitUs > startUs,
  `Systemd completion attestation failed: ${JSON.stringify(properties)}`);
  return {
    properties,
    startMonotonicMs: Math.floor(startUs / 1_000),
    exitMonotonicMs: Math.floor(exitUs / 1_000),
    elapsedMs: Math.floor((exitUs - startUs) / 1_000),
  };
}

function validatePortableManifest(manifest) {
  assertSoak(exactKeys(manifest, [
    "version", "acceptance", "evidenceComplete", "mode", "run", "source", "duration",
    "workload", "advisory", "safety", "artifacts",
  ]) && manifest.version === 1 && manifest.acceptance === false &&
    manifest.evidenceComplete === true &&
    [SOAK_MODE_ACCEPTANCE, SOAK_MODE_CALIBRATION, SOAK_MODE_VERIFICATION].includes(manifest.mode) &&
    exactKeys(manifest.advisory, [
      "delivered", "foldCount", "hookClearEvents", "recoveredFolds", "recoverySha256",
    ]) && manifest.advisory.foldCount >= SOAK_MIN_DURABLE_FOLDS &&
    manifest.advisory.recoveredFolds === manifest.advisory.foldCount &&
    manifest.advisory.hookClearEvents >= 1 && /^[0-9a-f]{64}$/.test(manifest.advisory.recoverySha256) &&
    exactKeys(manifest.safety, [
      "terminalStop", "failureLatches", "hardFenceAborts", "automaticSuspended",
      "nativeCompactions", "forbiddenTools",
    ]) && manifest.safety.terminalStop === true &&
    Object.entries(manifest.safety).every(([key, value]) => key === "terminalStop" || value === 0),
  "Portable soak manifest does not establish the advisory runtime contract");
  for (const [milestone, delivered] of Object.entries(manifest.advisory.delivered)) {
    assertSoak(Number.isSafeInteger(delivered) && delivered >= 0 &&
      delivered <= context.ADVISORY_BUDGETS[milestone],
    `Portable advisory milestone ${milestone} exceeded its budget`);
  }
  assertSoak(JSON.stringify(manifest).includes("/home/") === false &&
    JSON.stringify(manifest).includes("sessionFile") === false,
  "Portable manifest contains private paths");
  return manifest;
}

function verifyCandidateArtifacts(runDir, candidate) {
  for (const [relative, expected] of Object.entries(candidate.artifacts)) {
    const actual = artifactStat(join(runDir, relative));
    assertSoak(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
      `Candidate artifact drifted: ${relative}`);
  }
}

function validateStageEvidence({ runDir, config, branch, runEntries, paceRecords }) {
  const indexById = new Map(branch.map((entry, index) => [entry.id, index]));
  const calls = runEntries.flatMap(messageToolCalls);
  const archiveCalls = calls.filter((call) => call.name === SOAK_TOOL_NAME);
  const contextCalls = calls.filter((call) => call.name === "quorum_context");
  // A disallowed quorum_context ACTION is soak policy refusal, tolerated only as a
  // proven block (exactly one ERROR result, no runtime effect). A foreign TOOL is
  // still an integrity failure.
  const blockedContextCalls = contextCalls.filter((call) =>
    !SOAK_MODEL_CONTEXT_ACTIONS.includes(call.arguments?.action));
  const blockedCallIds = new Set(blockedContextCalls.map((call) => call.id));
  for (const call of blockedContextCalls) {
    const callIndex = indexById.get(call.entry.id);
    const matches = branch.flatMap((entry, resultIndex) => {
      const message = entry?.type === "message" ? entry.message : null;
      return resultIndex > callIndex && message?.role === "toolResult" &&
        message.toolCallId === call.id ? [message] : [];
    });
    assertSoak(matches.length === 1 && matches[0].isError === true,
      `Blocked context action ${call.id} lacks exactly one error result proving the block held`);
  }
  const forbiddenCalls = calls.filter((call) =>
    call.name !== SOAK_TOOL_NAME && call.name !== "quorum_context");
  assertSoak(forbiddenCalls.length === 0, `Soak used forbidden tools: ${JSON.stringify(forbiddenCalls)}`);
  assertSoak(archiveCalls.length === config.stageCount &&
    new Set(archiveCalls.map((call) => call.id)).size === archiveCalls.length &&
    runEntries.every((entry) => messageToolCalls(entry)
      .filter((call) => call.name === SOAK_TOOL_NAME).length <= 1),
  "Archive stage calls are missing, duplicated, or parallel");
  const toolResults = runEntries.filter((entry) => entry?.type === "message" &&
    entry.message?.role === "toolResult");
  assertSoak(toolResults.every((entry) => entry.message.isError === false ||
    blockedCallIds.has(entry.message.toolCallId)),
  "Soak contains a failed tool result outside the blocked-context-action policy");
  const archiveResults = [];
  let plateauCount = 0;
  let priorResultIndex = -1;
  for (const [index, call] of archiveCalls.entries()) {
    const stage = index + 1;
    const callIndex = indexById.get(call.entry.id);
    const matches = branch.flatMap((entry, resultIndex) => {
      const message = entry?.type === "message" ? entry.message : null;
      return resultIndex > callIndex && message?.role === "toolResult" &&
        message.toolCallId === call.id && message.toolName === SOAK_TOOL_NAME
        ? [{ entry, resultIndex }] : [];
    });
    assertSoak(matches.length === 1 && matches[0].entry.message.isError === false &&
      callIndex > priorResultIndex, `Archive stage ${stage} is not causally sequential`);
    const pace = paceRecords[index];
    const details = matches[0].entry.message.details;
    const content = matches[0].entry.message.content?.map((part) => part?.text ?? "").join("\n") ?? "";
    const response = readJson(join(runDir, "ipc", "responses", `stage-${String(stage).padStart(2, "0")}.json`));
    const contentBytes = Buffer.byteLength(response.content, "utf8");
    const observedPlateau = contentBytes < 30_000;
    if (observedPlateau) plateauCount += 1;
    assertSoak(observedPlateau === archiveStageIsPlateau(stage) &&
      response.content === renderArchiveStage(stage, response.nextChallenge) && content === response.content &&
      call.arguments?.key && sha256Text(call.arguments.key) === pace.challengeSha256 &&
      details?.stage === stage && details?.requestSha256 === pace.requestSha256 &&
      details?.responseSha256 === pace.responseSha256 && details?.contentSha256 === pace.contentSha256 &&
      details?.paceRecordSha256 === pace.recordSha256 && sha256Text(content) === pace.contentSha256,
    `Archive stage ${stage} differs from external paced evidence`);
    archiveResults.push({ call, callIndex, resultIndex: matches[0].resultIndex, contentBytes });
    priorResultIndex = matches[0].resultIndex;
  }
  return {
    archiveCalls, contextCalls, forbiddenCalls, archiveResults, plateauCount, indexById,
    blockedContextActions: blockedContextCalls.length,
  };
}

function validateRuntimeArtifacts({ runDir, config, worker, branch, runEntries, ledger, workerEvents }) {
  const state = context.materializeActiveContextState(branch, worker.sessionId,
    identity.QUORUM_STATE_ENTRY, identity.QUORUM_FOLD_RECORD_ENTRY);
  const advisory = state.advisory ?? { highWater: 0, delivered: {} };
  for (const [milestone, delivered] of Object.entries(advisory.delivered)) {
    assertSoak(delivered <= context.ADVISORY_BUDGETS[milestone],
      `Advisory milestone ${milestone} exceeded its delivery budget`);
  }

  const durableFoldRecords = runEntries.filter((entry) => entry?.type === "custom" &&
    entry.customType === identity.QUORUM_FOLD_RECORD_ENTRY);
  assertSoak(state.folds.length >= SOAK_MIN_DURABLE_FOLDS &&
    durableFoldRecords.length === state.folds.length &&
    new Set(durableFoldRecords.map((entry) => entry.data?.foldId)).size === state.folds.length &&
    state.folds.every((fold) => durableFoldRecords.some((entry) => entry.data?.foldId === fold.id)),
  "Durable advisory-era folds are missing, duplicated, or no longer recoverable");
  const modelFoldCalls = runEntries.flatMap(messageToolCalls).filter((call) =>
    call.name === "quorum_context" && call.arguments?.action === "fold");
  const modelFoldIds = modelFoldCalls.map((call) => {
    const callIndex = entryIndexByIdentity(branch, call.entry.id);
    const matches = branch.flatMap((entry, index) => {
      const message = entry?.type === "message" ? entry.message : null;
      return index > callIndex && message?.role === "toolResult" &&
        message.toolCallId === call.id && message.toolName === "quorum_context"
        ? [message] : [];
    });
    assertSoak(matches.length === 1 && matches[0].isError === false &&
      matches[0].details?.action === "fold" &&
      state.folds.some((fold) => fold.id === matches[0].details?.id),
    `Model-origin fold call ${call.id} does not match one durable fold`);
    return matches[0].details.id;
  });
  assertSoak(new Set(modelFoldIds).size === modelFoldIds.length,
    "Multiple model-origin fold calls claim the same durable fold");
  const modelFoldIdSet = new Set(modelFoldIds);
  const automaticFoldIds = state.folds
    .filter((fold) => !modelFoldIdSet.has(fold.id))
    .map((fold) => fold.id);
  assertSoak(automaticFoldIds.length >= 1,
    "Automatic durable folds are missing; every durable fold is attributable to a model-origin quorum_context fold call");
  const recoveries = state.folds.map((fold) => ({
    foldId: fold.id,
    sha256: sha256Json(context.recoverFoldMessages({
      foldId: fold.id,
      state,
      entries: branch,
      sessionId: worker.sessionId,
    })),
  }));
  const workerRecoveries = worker.finalRuntimeObservation?.foldRecoveries ?? [];
  assertSoak(worker.finalRuntimeObservation?.foldCount === state.folds.length &&
    recoveries.every((recovery) => workerRecoveries.some((item) =>
      item.foldId === recovery.foldId && item.sha256 === recovery.sha256)),
  "Worker fold recovery differs from canonical session entries");

  const projections = ledger.filter((record) => record.kind === "context-projection");
  let priorFoldCount = 0;
  let priorHooks = [];
  let hookClearEvents = 0;
  const projectionRecoveries = new Map();
  for (const projection of projections) {
    assertSoak(Number.isSafeInteger(projection.foldCount) && projection.foldCount >= 0 &&
      Array.isArray(projection.hookSha256) && Array.isArray(projection.recoveries),
    "Context projection lacks advisory/fold observations");
    for (const recovery of projection.recoveries) {
      projectionRecoveries.set(`${recovery.foldId}:${recovery.sha256}`, true);
    }
    if (projection.foldCount > priorFoldCount) {
      assertSoak(priorHooks.every((hash) => !projection.hookSha256.includes(hash)),
        "A fold-growth projection retained its prior advisory hook");
      hookClearEvents += 1;
    }
    priorFoldCount = Math.max(priorFoldCount, projection.foldCount);
    priorHooks = projection.hookSha256;
  }
  // A fold committed during the terminal settle has no later provider request
  // to project it: requiring projection coverage for it makes acceptance a
  // race (the 06-29 sealed run beat it by 87ms; the 10-41 run lost it by 38s).
  // Every fold's recovery is still SHA-verified against the worker's final
  // observation above; projection coverage binds the folds that preceded the
  // terminal response and therefore could project.
  const terminalEntryIndex = entryIndexByIdentity(branch, worker.terminal.entryId);
  const foldRecordIndexById = new Map(branch.flatMap((entry, index) =>
    entry?.type === "custom" && entry.customType === identity.QUORUM_FOLD_RECORD_ENTRY &&
    typeof entry.data?.foldId === "string" ? [[entry.data.foldId, index]] : []));
  const projectable = recoveries.filter((recovery) =>
    (foldRecordIndexById.get(recovery.foldId) ?? -1) < terminalEntryIndex);
  assertSoak(hookClearEvents >= 1 && projectable.every((recovery) =>
    projectionRecoveries.has(`${recovery.foldId}:${recovery.sha256}`)),
  "Projected fold recovery or advisory-hook clearing is incomplete");

  const runtimeObservations = workerEvents.filter((event) => event.kind === "runtime-observation");
  assertSoak(runtimeObservations.length === config.stageCount &&
    runtimeObservations.every((event, index) => event.details?.stage === index + 1 &&
      event.details.available === true && typeof event.details.automaticSuspended === "boolean" &&
      Number.isSafeInteger(event.details.foldCount) && event.details.foldCount >= 0),
  "Worker runtime observations do not cover every pressure stage");
  const observedFoldCounts = runtimeObservations.map((event) => event.details.foldCount);
  const workerFoldGrowthEvents = observedFoldCounts.filter((foldCount, index) =>
    index > 0 && foldCount > observedFoldCounts[index - 1]).length;
  assertSoak(observedFoldCounts.every((foldCount, index) =>
    index === 0 || foldCount >= observedFoldCounts[index - 1]) && workerFoldGrowthEvents >= 1,
  "Worker event stream did not observe durable fold count rising during the pressure climb");
  const pressure = runtimeObservations.flatMap((event) =>
    typeof event.details.pressureRatio === "number" ? [event.details.pressureRatio] : []);
  const fences = runtimeObservations.flatMap((event) =>
    typeof event.details.hardFenceRatio === "number" ? [event.details.hardFenceRatio] : []);
  assertSoak(pressure.length > 0 && pressure.every((value) => Number.isFinite(value) && value >= 0) &&
    fences.length === runtimeObservations.length && fences.every((value) => Number.isFinite(value) && value > 0),
  "Runtime pressure/fence observations are incomplete");

  const failureLatches = readJsonLines(join(runDir, "failure-latch.jsonl"));
  const hardFenceAborts = projections.filter((projection) => projection.signalAborted === true).length +
    failureLatches.filter((entry) => entry.phase === "context-aborted").length;
  const automaticSuspended = runtimeObservations.filter((event) =>
    event.details.automaticSuspended === true).length +
    (worker.finalRuntimeObservation?.automaticSuspended === true ? 1 : 0);
  const nativeCompactions = runEntries.filter((entry) => entry?.type === "compaction" ||
    (entry?.type === "custom" && [
      identity.QUORUM_NATIVE_COMPACTION_DECISION_ENTRY,
      identity.QUORUM_NATIVE_COMPACTION_RECEIPT_ENTRY,
    ].includes(entry.customType))).length;
  assertSoak(failureLatches.length === 0 && hardFenceAborts === 0 && automaticSuspended === 0 &&
    nativeCompactions === 0,
  "Soak observed a failure latch, hard-fence abort, suspended automation, or native compaction");

  return {
    delivered: advisory.delivered,
    foldCount: state.folds.length,
    modelFoldCount: modelFoldIds.length,
    automaticFoldCount: automaticFoldIds.length,
    automaticFoldIds,
    workerFoldGrowthEvents,
    hookClearEvents,
    recoveredFolds: recoveries.length,
    recoveries,
    maxProviderRatio: Math.max(...pressure),
    minHardFenceRatio: Math.min(...fences),
    pressureObservations: pressure.length,
    hardFenceAborts,
    automaticSuspended,
    nativeCompactions,
    failureLatches: failureLatches.length,
  };
}

async function adjudicateRun(runDir, expectedMode) {
  const candidatePath = join(runDir, "candidate-report.json");
  const candidateSealPath = join(runDir, "candidate-seal.json");
  const configPath = join(runDir, "run-config.json");
  assertSoak(existsSync(candidatePath) && existsSync(candidateSealPath) && existsSync(configPath),
    "Soak candidate is incomplete or unsealed");
  const config = validateRunConfig(readJson(configPath));
  const candidate = readJson(candidatePath);
  const candidateSeal = readJson(candidateSealPath);
  assertSoak(config.mode === expectedMode && config.bootId === bootId() && candidate.ok === true &&
    candidate.acceptance === false && candidate.requiresIndependentAdjudication === true &&
    candidate.runId === config.runId && candidate.runnerMode === SOAK_RUNNER_MODE &&
    candidate.behavioralMode === SOAK_BEHAVIORAL_MODE && candidate.failure === null &&
    candidate.failureLatchEntries === 0 && candidate.workerExit?.code === 0 &&
    candidate.workerExit?.signal === null &&
    candidateSeal.version === 1 && candidateSeal.runId === config.runId &&
    candidateSeal.acceptance === false &&
    candidateSeal.candidateReportSha256 === fileSha256(candidatePath) &&
    candidateSeal.workerToSealMs === candidateSeal.sealedMonotonicMs - candidate.workerExit.monotonicMs,
  "Candidate is not a clean non-authorizing advisory soak");
  if (expectedMode === SOAK_MODE_ACCEPTANCE) {
    assertSoak(candidate.acceptanceCandidate === true, "Acceptance candidate flag is absent");
  } else if (expectedMode === SOAK_MODE_VERIFICATION) {
    assertSoak(candidate.verificationCandidate === true, "Verification candidate flag is absent");
  }
  verifyCandidateArtifacts(runDir, candidate);

  const requireClean = expectedMode !== SOAK_MODE_VERIFICATION;
  const git = currentGit({ requireClean });
  assertSoak(git.head === config.codeCommit && git.tree === config.codeTree &&
    candidate.gitStart?.head === config.codeCommit && candidate.gitEnd?.head === config.codeCommit &&
    candidate.gitStart?.statusSha256 === candidate.gitEnd?.statusSha256 &&
    (requireClean || git.statusSha256 === candidate.gitEnd?.statusSha256),
  "Soak source revision or worktree snapshot drifted");
  if (requireClean) {
    for (const [path, hash] of Object.entries(config.sourceHashes)) {
      assertSoak(sourceAtCommitSha(config.codeCommit, path) === hash,
        `Pinned soak Git source hash drifted: ${path}`);
    }
  }
  verifySourceHashes(PROJECT, config.sourceHashes);
  assertSoak(JSON.stringify(dependencyHashes()) === JSON.stringify(config.dependencyHashes),
    "Pinned Pi/runtime dependencies changed before adjudication");
  await loadRawRuntime();
  verifySourceHashes(PROJECT, config.sourceHashes);
  assertSoak(JSON.stringify(dependencyHashes()) === JSON.stringify(config.dependencyHashes),
    "Adjudication loaded a changed runtime closure");

  const paceRecords = readJsonLines(join(runDir, "pace.jsonl"));
  const pace = validatePaceRecords(paceRecords, config);
  const heartbeats = readJsonLines(join(runDir, "heartbeats.jsonl"));
  const heartbeat = validateHeartbeatRecords(heartbeats, config, candidate.supervisor.finishedMonotonicMs);
  const systemd = expectedMode === SOAK_MODE_VERIFICATION ? null : systemdCompletion(candidate, config);
  const worker = readJson(join(runDir, "worker-report.json"));
  if (systemd) {
    validateExternalClockBounds({
      config,
      systemdStartMonotonicMs: systemd.startMonotonicMs,
      systemdExitMonotonicMs: systemd.exitMonotonicMs,
      paceRecords,
      heartbeatRecords: heartbeats,
      supervisor: candidate.supervisor,
      worker,
    });
  } else {
    assertSoak(worker.workerStartedMonotonicMs >= candidate.supervisor.startedMonotonicMs &&
      worker.workerFinishedMonotonicMs <= candidate.supervisor.finishedMonotonicMs &&
      pace.elapsedMs >= config.stageCount * config.stageIntervalMs,
    "Verification worker/pacing clocks escaped the direct supervisor interval");
  }
  await assertIsolatedWorkerModel(worker);
  assertSoak(worker.ok === true && worker.acceptance === false && worker.deadlineFired === false &&
    JSON.stringify(worker.contextToolActions) === JSON.stringify(context.ACTIVE_CONTEXT_TOOL_ACTIONS) &&
    JSON.stringify(worker.modelContextActionAllowlist) === JSON.stringify(SOAK_MODEL_CONTEXT_ACTIONS) &&
    JSON.stringify(candidate.workerReady.contextToolActions) ===
      JSON.stringify(context.ACTIVE_CONTEXT_TOOL_ACTIONS) &&
    JSON.stringify(candidate.workerReady.activeToolNames) === JSON.stringify(SOAK_EXPECTED_TOOL_NAMES) &&
    candidate.workerReady.promptSha256 === sha256Text(renderSoakPrompt(config.firstChallenge)) &&
    candidate.workerReady.configuredSystemPromptSha256 === sha256Text(soakSystemPrompt()) &&
    candidate.workerReady.appendedSystemPromptCount === 0 &&
    fileSha256(worker.sessionFile) === candidateSeal.sessionSha256,
  "Worker schema, policy, prompt, or session evidence drifted");

  const manager = SessionManager.open(worker.sessionFile, undefined, PROJECT);
  const branch = manager.getBranch();
  const markerIndex = entryIndexByIdentity(branch, worker.markerId);
  assertSoak(branch[markerIndex]?.type === "custom" &&
    branch[markerIndex].customType === SOAK_MARKER_ENTRY,
  "Soak marker identity has the wrong type");
  const runEntries = branch.slice(markerIndex + 1);
  const terminal = lastMessage(branch);
  assertSoak(terminal?.id === worker.terminal.entryId && terminal.message?.role === "assistant" &&
    terminal.message.stopReason === "stop" && messageToolCalls(terminal).length === 0 &&
    sha256Json(terminal.message) === worker.terminal.messageSha256 &&
    runEntries.filter((entry) => entry?.type === "message" && entry.message?.role === "user").length === 1 &&
    !runEntries.some((entry) => entry?.type === "custom_message") &&
    !runEntries.some((entry) => entry?.type === "message" && entry.message?.role === "assistant" &&
      ["error", "aborted", "length"].includes(entry.message.stopReason)),
  "Session is not one terminal continuous advisory-era turn");
  const terminalIndex = entryIndexByIdentity(branch, terminal.id);
  const terminalMeasurements = runEntries.filter((entry) => entry?.type === "custom" &&
    entry.customType === identity.QUORUM_PROVIDER_CONTEXT_MEASUREMENT_ENTRY &&
    entry.data?.messageSha256 === worker.terminal.messageSha256);
  assertSoak(terminalMeasurements.length === 1 &&
    entryIndexByIdentity(branch, terminalMeasurements[0].id) > markerIndex,
  "Terminal provider response lacks one same-run durable measurement");
  const terminalReceipt =
    context.parseProviderContextMeasurementReceipt(terminalMeasurements[0].data, worker.sessionId);
  assertSoak(terminalReceipt.provider === worker.model.provider &&
    terminalReceipt.model === worker.model.id,
  "Terminal durable measurement receipt attribution drifted from the pinned worker model");

  const stage = validateStageEvidence({ runDir, config, branch, runEntries, paceRecords });
  assertSoak(stage.archiveResults.at(-1).resultIndex < terminalIndex,
    "Terminal synthesis predates the final staged result");

  const ledger = readJsonLines(join(runDir, "provider-requests.jsonl"));
  validateHashChain(ledger, "provider/context ledger");
  const providerPairs = validateProviderExchange(ledger);
  const providerAssistants = runEntries.filter((entry) => entry?.type === "message" &&
    entry.message?.role === "assistant" && entry.message.provider === "openai-codex" &&
    entry.message.model === "gpt-5.6-sol" && ["stop", "toolUse"].includes(entry.message.stopReason));
  assertSoak(providerPairs.length === providerAssistants.length,
    "Provider request/response count is not one-to-one");
  const usageTotals = assistantUsageTotals(runEntries);
  assertSoak(usageTotals.requests === providerPairs.length,
    "Assistant usage request count differs from the provider-request ledger pair count");
  const providerToolsSha256 = providerPairs[0]?.request.providerToolsSha256;
  const indexById = stage.indexById;
  let priorRequestLeafIndex = markerIndex;
  let priorAssistantIndex = markerIndex;
  for (const [index, { request, response }] of providerPairs.entries()) {
    const requestLeafIndex = entryIndexByIdentity(branch, request.leafId);
    const assistantMatches = providerAssistants.flatMap((entry) =>
      sha256Json(entry.message) === response.messageSha256
        ? [{ entry, index: indexById.get(entry.id) }] : []);
    assertSoak(assistantMatches.length === 1 && assistantMatches[0].index > requestLeafIndex &&
      requestLeafIndex > priorRequestLeafIndex && assistantMatches[0].index > priorAssistantIndex &&
      response.stopReason === assistantMatches[0].entry.message.stopReason &&
      request.provider === "openai-codex" && request.model === "gpt-5.6-sol" &&
      request.thinkingLevel === "xhigh" &&
      request.systemPromptSha256 === candidate.workerReady.systemPromptSha256 &&
      request.providerToolsSha256 === providerToolsSha256 &&
      JSON.stringify([...request.providerToolNames].sort()) === JSON.stringify(SOAK_EXPECTED_TOOL_NAMES) &&
      JSON.stringify(request.contextToolActions) === JSON.stringify(context.ACTIVE_CONTEXT_TOOL_ACTIONS),
    `Provider pair ${index + 1} is not bound to the full runtime schema and one branch response`);
    priorRequestLeafIndex = requestLeafIndex;
    priorAssistantIndex = assistantMatches[0].index;
  }

  const workerEvents = readJsonLines(join(runDir, "worker-events.jsonl"));
  validateHashChain(workerEvents, "worker event ledger");
  const blockedContextEvents = workerEvents.filter((event) =>
    event.kind === "blocked-context-action");
  assertSoak(blockedContextEvents.length === stage.blockedContextActions,
    "Blocked context actions in the worker event ledger differ from the session's blocked calls");
  const runtime = validateRuntimeArtifacts({
    runDir, config, worker, branch, runEntries, ledger, workerEvents,
  });
  const summary = {
    stageCount: stage.archiveResults.length,
    plateauCount: stage.plateauCount,
    providerRequests: providerPairs.length,
    pressureObservations: runtime.pressureObservations,
    maxProviderRatio: runtime.maxProviderRatio,
    minHardFenceRatio: runtime.minHardFenceRatio,
    foldCount: runtime.foldCount,
    modelFoldCount: runtime.modelFoldCount,
    automaticFoldCount: runtime.automaticFoldCount,
    workerFoldGrowthEvents: runtime.workerFoldGrowthEvents,
    recoveredFolds: runtime.recoveredFolds,
    hookClearEvents: runtime.hookClearEvents,
    advisoryDeliveries: runtime.delivered,
    hardFenceAborts: runtime.hardFenceAborts,
    automaticSuspended: runtime.automaticSuspended,
    nativeCompactions: runtime.nativeCompactions,
    failureLatches: runtime.failureLatches,
    blockedContextActions: stage.blockedContextActions,
    usageTotals,
  };
  const manifest = validatePortableManifest({
    version: 1,
    acceptance: false,
    evidenceComplete: true,
    mode: config.mode,
    run: {
      runId: config.runId,
      sessionId: worker.sessionId,
      markerId: worker.markerId,
      unit: candidate.unit,
      invocationId: candidate.invocationId,
    },
    source: {
      codeCommit: config.codeCommit,
      codeTree: config.codeTree,
      sourceHashes: config.sourceHashes,
      dependencyHashes: config.dependencyHashes,
      piVersion: worker.piVersion,
      model: worker.model,
      thinkingLevel: worker.thinkingLevel,
      calibration: config.calibration,
    },
    duration: {
      minimumMs: config.minimumDurationMs,
      supervisorMs: candidate.supervisor.finishedMonotonicMs - candidate.supervisor.startedMonotonicMs,
      systemdMs: systemd?.elapsedMs ?? null,
      pacingMs: pace.elapsedMs,
      stageCount: config.stageCount,
      stageIntervalMs: config.stageIntervalMs,
      heartbeatCount: heartbeats.length,
      finalPaceRecordSha256: pace.finalRecordSha256,
      finalHeartbeatRecordSha256: heartbeat.finalRecordSha256,
    },
    workload: {
      behavioralMode: SOAK_BEHAVIORAL_MODE,
      promptSha256: candidate.workerReady.promptSha256,
      configuredSystemPromptSha256: candidate.workerReady.configuredSystemPromptSha256,
      systemPromptSha256: candidate.workerReady.systemPromptSha256,
      toolInventorySha256: candidate.workerReady.toolInventorySha256,
      providerToolsSha256,
      providerRequests: providerPairs.length,
      archiveCalls: stage.archiveCalls.length,
      plateauCount: stage.plateauCount,
      terminalEntryId: terminal.id,
      terminalMessageSha256: worker.terminal.messageSha256,
    },
    advisory: {
      delivered: runtime.delivered,
      foldCount: runtime.foldCount,
      hookClearEvents: runtime.hookClearEvents,
      recoveredFolds: runtime.recoveredFolds,
      recoverySha256: sha256Json(runtime.recoveries),
    },
    safety: {
      terminalStop: true,
      failureLatches: runtime.failureLatches,
      hardFenceAborts: runtime.hardFenceAborts,
      automaticSuspended: runtime.automaticSuspended,
      nativeCompactions: runtime.nativeCompactions,
      forbiddenTools: stage.forbiddenCalls.length,
    },
    artifacts: {
      candidateReportSha256: fileSha256(candidatePath),
      candidateSealSha256: fileSha256(candidateSealPath),
      sessionSha256: fileSha256(worker.sessionFile),
      paceSha256: fileSha256(join(runDir, "pace.jsonl")),
      heartbeatsSha256: fileSha256(join(runDir, "heartbeats.jsonl")),
      providerRequestsSha256: fileSha256(join(runDir, "provider-requests.jsonl")),
      workerEventsSha256: fileSha256(join(runDir, "worker-events.jsonl")),
      failureLatchSha256: fileSha256(join(runDir, "failure-latch.jsonl")),
      workerStdoutSha256: fileSha256(join(runDir, "worker.stdout.log")),
      workerStderrSha256: fileSha256(join(runDir, "worker.stderr.log")),
      adjudicatorSourceSha256: fileSha256(fileURLToPath(import.meta.url)),
    },
  });
  assertSoak(readFileSync(join(runDir, "worker.stderr.log"), "utf8").trim() === "",
    "Worker stderr is not empty");

  const evidence = {
    ok: true,
    acceptance: false,
    independentlyAdjudicated: true,
    runDir,
    summary,
    manifest,
    ...(systemd ? { systemd: systemd.properties } : {}),
  };
  const evidencePath = join(runDir, "adjudication-evidence.json");
  const manifestPath = join(runDir, "portable-manifest.json");
  writeJsonExclusive(manifestPath, manifest);
  writeJsonExclusive(evidencePath, evidence);

  if (expectedMode === SOAK_MODE_CALIBRATION) {
    const projection = providerRuntimeProjection(ledger, config.stageCount, {
      sealingOverheadMs: candidateSeal.workerToSealMs,
      safetyMarginMs: 60_000,
    });
    assertSoak(projection.accepted === true, "Calibration projection exceeds the launch watchdog");
    const calibrationEvidence = {
      version: 1,
      runId: config.runId,
      codeCommit: config.codeCommit,
      candidateReportSha256: fileSha256(candidatePath),
      evidencePathSha256: fileSha256(evidencePath),
      providerTurnP95Ms: projection.providerTurnP95Ms,
      projectedProviderTurns: projection.projectedProviderTurns,
      projectedWallClockMs: projection.projectedWallClockMs,
      observedSealingMs: candidateSeal.workerToSealMs,
      durableFolds: runtime.foldCount,
      recoveredFolds: runtime.recoveredFolds,
    };
    return {
      ok: true,
      acceptance: false,
      calibrationAccepted: true,
      runDir,
      summary,
      evidence: calibrationEvidence,
      evidenceSha256: sha256Json(calibrationEvidence),
      evidencePath,
      manifestPath,
    };
  }

  if (expectedMode === SOAK_MODE_VERIFICATION) {
    return {
      ok: true,
      acceptance: false,
      verificationAccepted: true,
      independentlyAdjudicated: true,
      runDir,
      summary,
      evidencePath,
      manifestPath,
    };
  }

  const finalGit = currentGit({ requireClean: true });
  assertSoak(finalGit.head === config.codeCommit && finalGit.tree === config.codeTree,
    "Git revision drifted before terminal acceptance sealing");
  verifySourceHashes(PROJECT, config.sourceHashes);
  assertSoak(JSON.stringify(dependencyHashes()) === JSON.stringify(config.dependencyHashes),
    "Runtime closure drifted before terminal acceptance sealing");
  const acceptanceSealPath = join(runDir, "acceptance-seal.json");
  writeTerminalAcceptanceSeal(acceptanceSealPath, {
    version: 1,
    terminal: true,
    runId: config.runId,
    codeCommit: config.codeCommit,
    evidenceSha256: fileSha256(evidencePath),
    manifestSha256: fileSha256(manifestPath),
    sealedWallMs: Date.now(),
    acceptance: true,
  });
  return {
    ok: true,
    acceptance: true,
    independentlyAdjudicated: true,
    runDir,
    summary,
    evidencePath,
    manifestPath,
    acceptanceSealPath,
    acceptanceSealSha256: fileSha256(acceptanceSealPath),
  };
}

let result;
try {
  await loadRawRuntime();
  if (process.argv[2] === "--manifest-only") {
    const path = process.argv[3];
    assertSoak(path && existsSync(path), "Manifest-only adjudication requires a portable manifest");
    result = {
      ok: true,
      acceptance: false,
      manifestOnly: true,
      evidenceComplete: true,
      requiresIndependentReview: true,
      manifest: validatePortableManifest(readJson(path)),
    };
  } else {
    assertSanitizedRuntimeEnvironment(process.env);
    const flag = process.argv[2];
    const mode = flag === "--calibration" ? SOAK_MODE_CALIBRATION
      : flag === "--verification" ? SOAK_MODE_VERIFICATION : SOAK_MODE_ACCEPTANCE;
    const rawPath = mode === SOAK_MODE_ACCEPTANCE ? process.argv[2] : process.argv[3];
    const runDir = resolve(rawPath ?? "");
    assertSoak(runDir && existsSync(runDir), "Adjudication requires a soak run directory");
    result = await adjudicateRun(runDir, mode);
  }
} catch (error) {
  result = {
    ok: false,
    acceptance: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
