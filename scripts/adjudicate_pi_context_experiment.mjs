#!/usr/bin/env node

// Independent adjudication of ONE fold-vs-compaction run. Artifact-only: the session
// entries, the supervisor ledgers and the run manifest. Nothing is synthesized, nothing is
// re-derived by re-running the session, and the adjudicator never authorizes anything.
//
//   node scripts/adjudicate_pi_context_experiment.mjs <runDir> [--re-adjudicate]
//
// Emits <runDir>/experiment-evidence.json and prints the same object. Run artifacts are
// sealed 0440 and the evidence file is written exclusively, so a second adjudication of an
// already-adjudicated run must ask for it: --re-adjudicate writes
// experiment-evidence.<first8 of adjudicatorSourceSha256>.json ALONGSIDE the original.
// Nothing is ever overwritten, and the file name states which adjudicator produced it.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_EVENT_SUFFIX,
  EXPERIMENT_ARMS,
  EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS,
  EXPERIMENT_DEFAULT_FOLD_SCHEDULING,
  EXPERIMENT_MARKER_ENTRY,
  EXPERIMENT_TOOL_NAME,
  armRuntimeConfiguration,
  assertExperiment,
  buildIncludeResolver,
  computeRereadTax,
  contextEventMetrics,
  corpusManifestSha256,
  deliverableTranscripts,
  estimateTokens,
  isWindowOverflow,
  probeClassOf,
  probeMechanicalVerdicts,
  probeTranscripts,
  quotedIncludeSpecs,
  thinkTimeFromPace,
  toolResultContentSha256,
  toolResultText,
  traceStepTranscripts,
  traceStepVerdicts,
  usageSeriesFromLedger,
  validateExperimentManifest,
  validateExperimentRunConfig,
  validateStagePlan,
} from "./lib/pi_context_experiment.mjs";
import { PI_FOLD_ACTIVE_CONTEXT_REGISTRATION } from "./lib/pi_fold_identity.mjs";
import {
  artifactStat,
  exactKeys,
  fileSha256,
  readJson,
  readJsonLines,
  sha256Json,
  sha256Text,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";

const FOLD_RECORD_SUFFIX = "-fold-record";
const NATIVE_ENTRY_MARKERS = ["native-compaction-receipt", "native-compaction-decision"];

function validateHashChain(records, label) {
  let prior = null;
  for (const [index, record] of records.entries()) {
    const { recordSha256, ...identity } = record;
    assertExperiment(record?.ordinal === index + 1 && record.priorRecordSha256 === prior &&
      recordSha256 === sha256Json(identity), `${label} hash-chain drift at ${index + 1}`);
    prior = recordSha256;
  }
  return prior;
}

function messageToolCalls(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((part) => part?.type === "toolCall")
    .map((part) => ({ entry, id: part.id, name: part.name, arguments: part.arguments }));
}

// (a) Usage totals, split the way the publication needs them: cached read, cache write and
// fresh input are separate, because cache economics cut both ways.
function usageTotals(entries) {
  const totals = {
    requests: 0,
    inputFresh: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
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
    for (const [field, key] of [
      ["input", "inputFresh"], ["cacheRead", "cacheRead"], ["cacheWrite", "cacheWrite"],
      ["output", "output"], ["reasoning", "reasoning"], ["totalTokens", "totalTokens"],
    ]) {
      const value = usage[field];
      if (value === undefined || value === null) continue;
      assertExperiment(Number.isFinite(value) && value >= 0,
        `Assistant usage field ${field} is invalid`);
      totals[key] += value;
    }
  }
  return totals;
}

// (b) Reread tax. Hash every tool-result payload in session order; a hash already seen is
// bytes ingested again. Stage payloads are unique by plan construction, so a repeat can
// only come from the model reading something it had already been given.
function rereadLedgerFromSession(entries) {
  const records = [];
  let ordinal = 0;
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "toolResult") continue;
    const text = toolResultText(message.content);
    ordinal += 1;
    records.push({
      ordinal,
      toolName: message.toolName ?? null,
      contentSha256: toolResultContentSha256(message.content),
      chars: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      tokensEstimated: estimateTokens(text),
    });
  }
  return records;
}

// (c) Stop-the-world accounting: native compactions against folds-in-stride, each with the
// gap to the next productive provider request.
function stopTheWorld({ entries, ledger, liveRecords, foldRecords }) {
  const providerRequests = ledger
    .filter((record) => record.kind === "provider-request")
    .map((record) => record.monotonicMs)
    .sort((left, right) => left - right);
  const nextRequestAfter = (monotonicMs) =>
    providerRequests.find((value) => value > monotonicMs) ?? null;
  const nativeEntries = entries.filter((entry) => entry?.type === "compaction" ||
    (entry?.type === "custom" && NATIVE_ENTRY_MARKERS.some((marker) =>
      typeof entry.customType === "string" && entry.customType.endsWith(marker))));
  const liveNative = liveRecords.filter((record) => record.kind === "native-compaction");
  const events = liveNative.map((record) => ({
    kind: "native-compaction",
    stage: record.stage ?? null,
    openedMonotonicMs: record.openedMonotonicMs,
    timeToFirstProductiveRequestMs: record.timeToFirstProductiveRequestMs ??
      (nextRequestAfter(record.openedMonotonicMs) === null
        ? null
        : nextRequestAfter(record.openedMonotonicMs) - record.openedMonotonicMs),
  }));
  // A fold is in-stride by construction: it happens inside a turn, so its "gap" is measured
  // the same way and reported alongside, never assumed to be zero.
  const foldEvents = foldRecords.map((record) => ({
    kind: "fold",
    foldId: record.data?.foldId ?? null,
    foldKind: record.data?.fold?.kind ?? null,
    openedMonotonicMs: null,
    timeToFirstProductiveRequestMs: null,
  }));
  return {
    nativeCompactions: events.length,
    nativeCompactionSessionEntries: nativeEntries.length,
    foldsInStride: foldEvents.length,
    events,
    foldEvents,
    medianNativeRecoveryMs: median(events
      .map((event) => event.timeToFirstProductiveRequestMs)
      .filter((value) => Number.isFinite(value))),
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// (d) Voluntary-fold share plus expand/protect usage. Attribution is the soak's: a fold is
// model-origin when a context tool call with action "fold" produced exactly that fold id.
function curation({ entries, foldRecords, contextToolName, workerEvents = [], workerReport = null }) {
  const calls = entries.flatMap(messageToolCalls).filter((call) => call.name === contextToolName);
  const resultsByCallId = new Map();
  for (const entry of entries) {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role === "toolResult" && message.toolName === contextToolName) {
      resultsByCallId.set(message.toolCallId, message);
    }
  }
  const byAction = {};
  const modelFoldIds = new Set();
  for (const call of calls) {
    const action = typeof call.arguments?.action === "string" ? call.arguments.action : "unknown";
    byAction[action] = (byAction[action] ?? 0) + 1;
    if (action !== "fold") continue;
    const result = resultsByCallId.get(call.id);
    if (result?.isError === false && typeof result.details?.id === "string") {
      modelFoldIds.add(result.details.id);
    }
  }
  const allFoldIds = foldRecords.map((record) => record.data?.foldId).filter(Boolean);
  const voluntary = allFoldIds.filter((id) => modelFoldIds.has(id)).length;
  // One logical row per model-emitted invocation. The worker log and the runtime's
  // attempt records observe different failure surfaces (a schema-rejected call never
  // reaches the runtime), so the join is by tool_call_id, never by order or clock.
  const modelEmitted = workerEvents.filter((row) => row?.kind === "tool-call" &&
    row.details?.toolName === contextToolName);
  const attemptRows = entries
    .filter((entry) => entry?.type === "custom" && typeof entry.customType === "string" &&
      entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data?.kind === "context.attempt")
    .map((entry) => entry.data);
  const attemptCallIds = new Set(attemptRows
    .map((row) => (typeof row.tool_call_id === "string" ? row.tool_call_id : null))
    .filter(Boolean));
  const emittedCallIds = new Set(modelEmitted
    .map((row) => (typeof row.details?.toolCallId === "string" ? row.details.toolCallId : null))
    .filter(Boolean));
  return {
    contextToolCalls: calls.length,
    byAction,
    invocationJoin: {
      joinKey: "tool_call_id",
      modelEmittedCalls: modelEmitted.length,
      runtimeAttempts: attemptRows.length,
      attemptsWithJoinKey: attemptCallIds.size,
      emittedWithoutAttempt: [...emittedCallIds].filter((id) => !attemptCallIds.has(id)).length,
      attemptsWithoutEmitted: [...attemptCallIds].filter((id) => !emittedCallIds.has(id)).length,
    },
    endOfRun: {
      protectedRefs: workerReport?.foldSummary?.protectedRefs ?? null,
      pendingMarks: workerReport?.foldSummary?.pendingMarks ?? null,
      pendingAgentMarks: workerReport?.foldSummary?.pendingAgentMarks ?? null,
    },
    expandCalls: byAction.expand ?? 0,
    protectCalls: byAction.protect ?? 0,
    unprotectCalls: byAction.unprotect ?? 0,
    refoldCalls: byAction.refold ?? 0,
    peekCalls: byAction.peek ?? 0,
    // totalFolds counts fold RECORDS written by the runtime. It is NOT a count of prefix
    // invalidations: on this arm the headline mutation metric is the runtime's own event
    // stream (contextEvents.prefixRewrites); usage.mutations stays beside it as the
    // design-agnostic wire inference, which rep 17 showed overcounting 60 against 38
    // actual commits.
    totalFolds: allFoldIds.length,
    totalFoldsCounts: "fold-records",
    headlineMutationMetric: "contextEvents.prefixRewrites",
    voluntaryFolds: voluntary,
    automaticFolds: allFoldIds.length - voluntary,
    voluntaryFoldShare: allFoldIds.length > 0 ? voluntary / allFoldIds.length : null,
    foldKinds: foldRecords.reduce((result, record) => {
      const kind = record.data?.fold?.kind ?? "unknown";
      result[kind] = (result[kind] ?? 0) + 1;
      return result;
    }, {}),
  };
}

// (e) Recall probes and deliverables. Extraction lives in the shared contract
// (probeTranscripts / deliverableTranscripts): it scans FORWARD from the stage result
// because the model routinely answers one message slot late, and it addresses stage
// results by stamped stage ordinal so a stale-key retry cannot shift the window. Parsing
// is best-effort and ALWAYS keeps the raw text, because the grading is external and must
// be able to see what the parser did.

function adjudicate(runDir, { reAdjudicate = false } = {}) {
  for (const required of ["run-config.json", "candidate-report.json", "candidate-seal.json", "worker-report.json"]) {
    assertExperiment(existsSync(join(runDir, required)), `Run is incomplete: missing ${required}`);
  }
  const config = validateExperimentRunConfig(readJson(join(runDir, "run-config.json")));
  const candidate = readJson(join(runDir, "candidate-report.json"));
  const seal = readJson(join(runDir, "candidate-seal.json"));
  const worker = readJson(join(runDir, "worker-report.json"));
  const armRuntime = armRuntimeConfiguration(config.arm);
  assertExperiment(EXPERIMENT_ARMS.includes(config.arm), "Run config arm is not one of the three arms");
  assertExperiment(candidate.runId === config.runId && candidate.arm === config.arm &&
    seal.runId === config.runId && seal.arm === config.arm &&
    seal.candidateReportSha256 === fileSha256(join(runDir, "candidate-report.json")) &&
    worker.runId === config.runId && worker.arm === config.arm,
  "Run identity is inconsistent across config, candidate, seal and worker report");
  for (const [relative, expected] of Object.entries(candidate.artifacts)) {
    const actual = artifactStat(join(runDir, relative));
    assertExperiment(actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
      `Candidate artifact drifted: ${relative}`);
  }

  const plan = validateStagePlan(readJson(config.planPath));
  assertExperiment(plan.planSha256 === config.planSha256, "Adjudicated plan is not the run's pinned plan");
  const manifest = validateExperimentManifest(readJson(join(runDir, "run-manifest.json")));
  assertExperiment(manifest.runId === config.runId && manifest.arm === config.arm &&
    manifest.guidance === config.guidance && manifest.plan.planSha256 === plan.planSha256 &&
    manifest.target.commit === plan.repo.commit &&
    manifest.target.treeSha256 === config.targetTreeSha256 &&
    manifest.target.checkoutSha256 === config.targetTreeSha256 &&
    manifest.model.provider === config.model.provider && manifest.model.id === config.model.id &&
    manifest.model.effort === config.model.effort &&
    manifest.runtime.codeCommit === config.codeCommit &&
    sha256Json(manifest) === worker.manifestSha256,
  "Run manifest does not pin this run's arm, model, runtime, target repo and stage plan");
  // Re-derive the corpus fingerprint from the plan, so the manifest pin is checked against
  // the plan rather than trusted from the run that wrote it.
  assertExperiment(corpusManifestSha256(plan.stages.flatMap((stage) => stage.files)) ===
    manifest.target.treeSha256, "Manifest target fingerprint is not the plan's staged corpus");

  const sessionFile = worker.sessionFile;
  assertExperiment(sessionFile && existsSync(sessionFile), "Session evidence is missing");
  assertExperiment(fileSha256(sessionFile) === seal.sessionSha256, "Session evidence drifted after sealing");
  const entries = readJsonLines(sessionFile);
  const markerIndex = entries.findIndex((entry) => entry?.id === worker.markerId);
  assertExperiment(markerIndex >= 0, "Session does not carry this run's marker");
  assertExperiment(entries[markerIndex]?.customType === EXPERIMENT_MARKER_ENTRY,
    "Run marker has the wrong entry type");
  const runEntries = entries.slice(markerIndex + 1);
  const userMessages = runEntries.filter((entry) => entry?.type === "message" &&
    entry.message?.role === "user").length;
  assertExperiment(userMessages === 1,
    `One-user-message contract broken: ${userMessages} user messages in the run span`);

  const ledger = readJsonLines(join(runDir, "provider-requests.jsonl"));
  validateHashChain(ledger, "provider/context ledger");
  const workerEvents = readJsonLines(join(runDir, "worker-events.jsonl"));
  validateHashChain(workerEvents, "worker event ledger");
  const liveToolResults = readJsonLines(join(runDir, "tool-results.jsonl"));
  validateHashChain(liveToolResults, "tool-result ledger");
  const stopRecords = readJsonLines(join(runDir, "stop-the-world.jsonl"));
  const paceRecords = readJsonLines(join(runDir, "pace.jsonl"));
  assertExperiment(paceRecords.length === candidate.stagesReleased,
    "Pace ledger does not match the supervisor's released stage count");
  for (const [index, record] of paceRecords.entries()) {
    assertExperiment(record.stage === index + 1 &&
      record.payloadSha256 === plan.stages[index].payloadSha256,
    `Released stage ${index + 1} is not the planned payload`);
  }

  const foldRecords = runEntries.filter((entry) => entry?.type === "custom" &&
    typeof entry.customType === "string" && entry.customType.endsWith(FOLD_RECORD_SUFFIX));
  const contextToolName = PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.toolName;
  const usage = usageTotals(runEntries);
  const rereadRecords = rereadLedgerFromSession(runEntries);
  const reread = computeRereadTax(rereadRecords);
  // The live ledger is a second witness on the same bytes: if the two disagree, the
  // measurement is not trustworthy and adjudication fails loudly rather than picking one.
  // Compared as a MULTISET: concurrent tool calls land in the live ledger in completion
  // order but in the session in call order (observed as pure swaps in the first smoke),
  // and repeat counts are order-independent (repeats = total - distinct).
  const liveRunResults = liveToolResults.filter((record) => record.contentSha256);
  if (liveRunResults.length === rereadRecords.length) {
    const sortedLive = liveRunResults.map((record) => record.contentSha256).sort();
    const sortedSession = rereadRecords.map((record) => record.contentSha256).sort();
    assertExperiment(sortedLive.every((sha, index) => sha === sortedSession[index]),
      "Live tool-result ledger disagrees with the session's tool-result payload hashes");
  }
  const stw = stopTheWorld({ entries: runEntries, ledger, liveRecords: stopRecords, foldRecords });
  const curationSummary = armRuntime.activeContextEnabled
    ? curation({ entries: runEntries, foldRecords, contextToolName, workerEvents, workerReport: worker })
    : { contextToolCalls: 0, byAction: {}, totalFolds: 0, totalFoldsCounts: "fold-records",
      headlineMutationMetric: "usage.mutations", voluntaryFolds: 0, automaticFolds: 0,
      voluntaryFoldShare: null, expandCalls: 0, protectCalls: 0, unprotectCalls: 0,
      refoldCalls: 0, peekCalls: 0, foldKinds: {} };
  // The runtime's own canonical stream: exact mutation accounting and the
  // mechanism-limited counterfactual. Arms without the extension emit no stream, and the
  // wire series above remains their only mutation lens.
  const contextEvents = armRuntime.activeContextEnabled
    ? contextEventMetrics(runEntries)
    : null;

  // Arm invariants: an arm that did the other arm's thing is not evidence.
  if (!armRuntime.nativeCompactionEnabled) {
    assertExperiment(stw.nativeCompactions === 0 && stw.nativeCompactionSessionEntries === 0,
      `Arm ${config.arm} recorded a native compaction`);
  }
  if (!armRuntime.activeContextEnabled) {
    assertExperiment(foldRecords.length === 0, `Arm ${config.arm} recorded a fold`);
  }

  const providerPairs = ledger.filter((record) => record.kind === "provider-response").length;
  const toolCalls = runEntries.flatMap(messageToolCalls);
  const wallClockMs = worker.workerFinishedMonotonicMs - worker.workerStartedMonotonicMs;

  // (f) The unmanaged arm's datum: where the window wall is.
  const overflowText = [
    worker.overflow?.detail ?? "",
    readFileSync(join(runDir, "worker.stderr.log"), "utf8"),
    // Second witness: the session's own terminal error text. The worker's detail field
    // historically carried only the (empty) content array, not errorMessage.
    ...runEntries
      .filter((entry) => entry?.type === "message" &&
        ["error", "length"].includes(entry.message?.stopReason))
      .map((entry) => `${entry.message?.errorMessage ?? ""}`),
  ].join("\n");
  const overflowPoint = worker.overflow
    ? {
      detected: worker.overflow.detected,
      stagesCompleted: candidate.stagesReleased,
      stagesPlanned: plan.stageCount,
      matchedWindowOverflow: isWindowOverflow(overflowText),
      lastProviderRequestPayloadChars: ledger
        .filter((record) => record.kind === "provider-request")
        .map((record) => record.payloadChars ?? null)
        .filter((value) => Number.isFinite(value)).at(-1) ?? null,
      detail: worker.overflow.detail,
    }
    : null;
  if (armRuntime.toleratesOverflow) {
    assertExperiment(overflowPoint === null || overflowPoint.matchedWindowOverflow === true,
      "Unmanaged arm ended abnormally without a recognizable window-overflow signature");
  } else {
    assertExperiment(overflowPoint === null, `Arm ${config.arm} hit the window wall`);
  }

  const probes = probeTranscripts({ entries: runEntries, plan });
  const deliverables = deliverableTranscripts({ entries: runEntries, plan });
  // Parse rates by probe class, before grading: conversation-class probes are the
  // recall instrument, derived-class the audit-trace values, repo-class the
  // control, and a run that never even ANSWERED one class should be visible
  // without opening the blind packet.
  const probeAnswers = probes.flatMap((wave) => wave.answers);
  const probeClassSummary = Object.fromEntries(["conversation", "derived", "echo", "repository"]
    .map((klass) => {
      const inClass = probeAnswers.filter((answer) => probeClassOf(answer.kind) === klass);
      return [klass, {
        questions: inClass.length,
        parsed: inClass.filter((answer) => answer.parsed).length,
      }];
    }));
  // Decision (Shane 2026-08-09): mechanical exact match is the headline verdict;
  // the blind grader is a second reader. Echo probes are graded separately.
  const probeVerdicts = probeMechanicalVerdicts({ plan, transcripts: probes });

  // Audit traces: every chain step graded absolutely (against the harness walk)
  // and against the agent's own predecessor. INC self-evaluation reads the run's
  // pinned worktree; a pruned worktree reports not-evaluated rather than guessing.
  const repoDir = join(runDir, "repo");
  let resolveInclude = null;
  const includeTargets = (path) => {
    if (!existsSync(repoDir)) return null;
    if (resolveInclude === null) {
      const paths = [];
      const walk = (directory) => {
        for (const name of readdirSync(directory).sort()) {
          if (name === ".git") continue;
          const child = join(directory, name);
          const stat = statSync(child);
          if (stat.isDirectory()) walk(child);
          else if (stat.isFile()) paths.push(relative(repoDir, child));
        }
      };
      walk(repoDir);
      resolveInclude = buildIncludeResolver(paths);
    }
    const absolute = join(repoDir, path);
    if (!existsSync(absolute)) return [];
    try {
      return quotedIncludeSpecs(readFileSync(absolute, "utf8"))
        .map((spec) => resolveInclude(path, spec));
    } catch {
      return [];
    }
  };
  const auditTranscripts = traceStepTranscripts({ entries: runEntries, plan });
  const auditTraces = traceStepVerdicts({ transcripts: auditTranscripts, plan, includeTargets });

  // (g) The per-request dials the iteration comparison runs on. The ledger is the source
  // because it alone carries the request wall clock beside the response usage; it is
  // cross-checked against the session's own assistant-message count so the two witnesses
  // cannot silently disagree.
  const usageSeries = usageSeriesFromLedger(ledger);
  assertExperiment(usageSeries.series.length === usage.requests,
    `Provider ledger reports ${usageSeries.series.length} responses against ` +
    `${usage.requests} assistant messages in the session`);
  const thinkTime = thinkTimeFromPace(paceRecords);

  const report = {
    ok: true,
    independentlyAdjudicated: true,
    version: 1,
    runDir,
    runId: config.runId,
    campaignId: config.campaignId,
    arm: config.arm,
    foldScheduling: config.foldScheduling ?? EXPERIMENT_DEFAULT_FOLD_SCHEDULING,
    foldPeekResults: config.foldPeekResults ?? EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS,
    providerTotalWindow: config.providerTotalWindow ?? null,
    transport: config.transport ?? "auto",
    repetition: config.repetition,
    mode: config.mode,
    manifest,
    workload: {
      stagesPlanned: plan.stageCount,
      stagesReleased: candidate.stagesReleased,
      stageCalls: toolCalls.filter((call) => call.name === EXPERIMENT_TOOL_NAME).length,
      readCalls: toolCalls.filter((call) => call.name === "read").length,
      toolCalls: toolCalls.length,
      probeStages: probes.length,
      deliverables: deliverables.length,
    },
    usage: {
      ...usage,
      providerResponses: providerPairs,
      wallClockMs,
      series: usageSeries.series,
      mutations: usageSeries.mutations,
      mutationRule: usageSeries.mutationRule,
      meanCacheShare: usageSeries.meanCacheShare,
      pooledCacheShare: usageSeries.pooledCacheShare,
    },
    contextEvents,
    thinkTime,
    rereadTax: {
      tokenEstimatorId: reread.tokenEstimatorId,
      toolResults: reread.toolResults,
      distinctPayloads: reread.distinctPayloads,
      repeatResults: reread.repeatResults,
      repeatBytes: reread.repeatBytes,
      repeatTokensEstimated: reread.repeatTokensEstimated,
      totalBytes: reread.totalBytes,
      totalTokensEstimated: reread.totalTokensEstimated,
      repeatByteShare: reread.repeatByteShare,
      topRepeats: reread.repeated.slice(0, 20),
    },
    stopTheWorld: stw,
    curation: curationSummary,
    overflowPoint,
    probeClassSummary,
    probeVerdicts,
    auditTraces,
    probes,
    deliverables,
    evidence: {
      sessionSha256: seal.sessionSha256,
      candidateReportSha256: seal.candidateReportSha256,
      manifestSha256: sha256Json(manifest),
      planSha256: plan.planSha256,
      providerLedgerSha256: fileSha256(join(runDir, "provider-requests.jsonl")),
      toolResultLedgerSha256: existsSync(join(runDir, "tool-results.jsonl"))
        ? fileSha256(join(runDir, "tool-results.jsonl")) : null,
      workerEventsSha256: fileSha256(join(runDir, "worker-events.jsonl")),
      adjudicatorSourceSha256: fileSha256(fileURLToPath(import.meta.url)),
      probeTranscriptSha256: sha256Text(JSON.stringify(probes)),
      deliverableTranscriptSha256: sha256Text(JSON.stringify(deliverables)),
      traceStepTranscriptSha256: sha256Text(JSON.stringify(auditTranscripts)),
    },
  };
  assertExperiment(exactKeys(report.usage, [
    "requests", "inputFresh", "cacheRead", "cacheWrite", "output", "reasoning", "totalTokens",
    "entriesWithoutUsage", "providerResponses", "wallClockMs", "series", "mutations",
    "mutationRule", "meanCacheShare", "pooledCacheShare",
  ]), "Usage report shape drifted");
  // Re-adjudication never touches the original: the sidecar is named for the adjudicator
  // that produced it, and the exclusive write refuses a second run of the same adjudicator.
  const evidencePath = join(runDir, reAdjudicate
    ? `experiment-evidence.${report.evidence.adjudicatorSourceSha256.slice(0, 8)}.json`
    : "experiment-evidence.json");
  if (reAdjudicate) {
    assertExperiment(existsSync(join(runDir, "experiment-evidence.json")),
      "Re-adjudication expects an already-adjudicated run: adjudicate it normally first");
  }
  report.evidencePath = evidencePath;
  writeJsonExclusive(evidencePath, report);
  return report;
}

let result;
try {
  const argv = process.argv.slice(2);
  const reAdjudicate = argv.includes("--re-adjudicate");
  const positional = argv.filter((value) => !value.startsWith("--"));
  assertExperiment(argv.every((value) => !value.startsWith("--") || value === "--re-adjudicate"),
    "Adjudication accepts only --re-adjudicate");
  const runDir = resolve(positional[0] ?? "");
  assertExperiment(runDir && existsSync(runDir), "Adjudication requires a run directory");
  assertExperiment(runDir.startsWith("/"), "Run directory must be absolute");
  result = adjudicate(runDir, { reAdjudicate });
} catch (error) {
  result = {
    ok: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
