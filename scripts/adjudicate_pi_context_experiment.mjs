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
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_MARKER_ENTRY,
  EXPERIMENT_TOOL_NAME,
  FOLD_RECORD_SUFFIX,
  sessionLedgerLens,
  armRuntimeConfiguration,
  assertExperiment,
  buildIncludeResolver,
  closedBookPrompt,
  closedBookQuestions,
  composeEndBlockPrompt,
  endBlockAdjacencyTranscript,
  endBlockTranscript,
  endBlockVerdicts,
  closedBookTranscript,
  computeRereadTax,
  contextEventMetrics,
  corpusManifestSha256,
  deliverableTranscripts,
  echoVerdicts,
  endOfRunBriefProvenance,
  providerWeather,
  estimateTokens,
  isWindowOverflow,
  nativeCompactionDisposition,
  probeClassOf,
  probeMechanicalVerdicts,
  probeWaveRecovery,
  probeProvenance,
  probeTranscripts,
  quotedIncludeSpecs,
  thinkTimeFromPace,
  toolResultContentSha256,
  toolResultText,
  traceStepTranscripts,
  traceStepVerdicts,
  abortMarkerMessages,
  reconcileWitnessCount,
  usageSeriesFromLedger,
  outOfBandUsage,
  billedCostFromLedger,
  unansweredRequestsFromLedger,
  validateExperimentManifest,
  validateExperimentRunConfig,
  validateStagePlan,
} from "./lib/pi_context_experiment.mjs";
import {
  ARTIFACT_END_BLOCK_SCHEMA,
  gradeAdjacency,
  staleArtifactVerdicts,
} from "./lib/pi_context_artifacts.mjs";
import { hostSessionFile } from "./lib/pi_context_sandbox.mjs";
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
    // The verbs were renamed protect/unprotect -> pin/unpin (Shane 2026-08-21: the
    // guidance already called it pinning). Both names are read so a sealed run from
    // either era counts, and no run recorded the old verb anyway (corpus sweep: 0).
    pinCalls: (byAction.pin ?? 0) + (byAction.protect ?? 0),
    unpinCalls: (byAction.unpin ?? 0) + (byAction.unprotect ?? 0),
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
    // Which generator wrote each brief, read at the END of the run: the sealed fold
    // records joined to the commit records that upgraded them, because a ladder fold
    // commits deterministic and is upgraded at a later boundary. Seeded with both regimes
    // at zero so a run that produced no model brief SAYS so rather than omitting the key:
    // the deterministic brief is the failure fallback, and a rep whose folds all carry it
    // measured the fallback, not the mechanism.
    briefProvenance: endOfRunBriefProvenance(entries),
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
  const closedBook = config.sessionType === EXPERIMENT_CLOSED_BOOK_LABEL;
  const armRuntime = closedBook
    ? { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: false }
    : armRuntimeConfiguration(config.arm);
  assertExperiment(closedBook || EXPERIMENT_ARMS.includes(config.arm),
    "Run config arm is not one of the three arms");
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
    manifest.plan.planSha256 === plan.planSha256 &&
    manifest.target.commit === plan.repo.commit &&
    manifest.target.treeSha256 === config.targetTreeSha256 &&
    manifest.model.provider === config.model.provider && manifest.model.id === config.model.id &&
    manifest.model.effort === config.model.effort &&
    manifest.runtime.codeCommit === config.codeCommit &&
    sha256Json(manifest) === worker.manifestSha256,
  "Run manifest does not pin this run's arm, model, runtime, target repo and stage plan");
  assertExperiment(closedBook
    ? manifest.sessionType === EXPERIMENT_CLOSED_BOOK_LABEL &&
      manifest.questionsSha256 === sha256Json(closedBookQuestions(plan))
    : manifest.guidance === config.guidance &&
      manifest.target.checkoutSha256 === config.targetTreeSha256 &&
      manifest.endBlockSha256 === sha256Text(composeEndBlockPrompt(plan, config.querySeed)),
  closedBook
    ? "Closed-book manifest does not pin this plan's question list"
    : "Run manifest guidance/checkout/end-block pins drifted from the run config");
  // Re-derive the corpus fingerprint from the plan, so the manifest pin is checked against
  // the plan rather than trusted from the run that wrote it.
  assertExperiment(corpusManifestSha256(plan.stages.flatMap((stage) => stage.files)) ===
    manifest.target.treeSha256, "Manifest target fingerprint is not the plan's staged corpus");

  const sessionFile = hostSessionFile(runDir, worker.sessionFile);
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
  // ONE USER MESSAGE, PLUS EXACTLY THE RESUMES THAT WERE RECORDED.
  //
  // The contract is that the workload is delivered as one continuous task rather than fed
  // to the agent turn by turn, and a bare count of one enforced that only while nothing
  // could legitimately prompt again. Two things now can. A model that ends its turn early
  // is resumed (gate 56 of the harness suite), and on the matched-fence arm every crossing
  // aborts the live turn, because `compact` aborts before it prepares, so that arm is
  // resumed once per compaction by construction: rep 3 of sol-20260814-fenced compacted
  // three times and finished all eight stages across four user messages.
  //
  // So the count is checked against the resumes the worker RECORDED rather than relaxed. An
  // extra user message that no resume accounts for still breaks the contract, which is the
  // spoon-feeding this rule exists to catch, and the resume count is reported beside the
  // workload rather than absorbed into it: on this arm it is a cost of the mechanism.
  const recordedResumes = Array.isArray(worker.stageNudges) ? worker.stageNudges.length : 0;
  // The withheld end block is the one further message an arm session may
  // legitimately carry (task #79 build 3): asked after the last stage, its
  // bytes pinned by the manifest. It counts here only when a user message is
  // BYTE-IDENTICAL to the recomputed prompt, so an extra message no resume and
  // no end block accounts for still breaks the contract.
  const endBlockDelivered = closedBook ? 0
    : (plan.endBlockAdjacency !== undefined
      ? endBlockAdjacencyTranscript({ entries: runEntries, questions: plan.endBlockAdjacency })
      : endBlockTranscript({
        entries: runEntries, ledger: plan.ledger, querySeed: config.querySeed,
      })).delivered ? 1 : 0;
  assertExperiment(userMessages === 1 + recordedResumes + endBlockDelivered,
    `One-user-message contract broken: ${userMessages} user messages in the run span ` +
    `against ${recordedResumes} recorded resume(s) and ${endBlockDelivered} end block(s)`);

  // Closed-book runs grade through the SAME mechanical verdicts and stop there. The
  // prompt law makes "no stage payload bytes" checkable: the sealed prompt hash must
  // equal the plan-derived question list recomputed here, and the session must have
  // used nothing at all: no tools, no folds, no compactions, no supervisor ledgers.
  if (closedBook) {
    assertExperiment(candidate.workerReady?.promptSha256 === sha256Text(closedBookPrompt(plan)),
      "Closed-book session prompt is not the plan-derived question list");
    assertExperiment(!runEntries.some((entry) => entry?.type === "message" &&
      ["toolResult", "toolCall"].includes(entry.message?.role)) &&
      runEntries.flatMap(messageToolCalls).length === 0,
    "Closed-book session carries tool traffic");
    assertExperiment(!runEntries.some((entry) => entry?.type === "compaction"),
      "Closed-book session carries a compaction");
    assertExperiment(!runEntries.some((entry) => entry?.type === "custom" &&
      typeof entry.customType === "string" && entry.customType.endsWith(FOLD_RECORD_SUFFIX)),
    "Closed-book session carries a fold record");
    const usage = usageTotals(runEntries);
    const transcripts = closedBookTranscript({ entries: runEntries, plan });
    const probeVerdicts = probeMechanicalVerdicts({ plan, transcripts });
    const answers = transcripts.flatMap((wave) => wave.answers);
    const probeClassSummary = Object.fromEntries(["conversation", "derived", "repository"]
      .map((klass) => {
        const inClass = answers.filter((answer) => probeClassOf(answer.kind) === klass);
        return [klass, {
          questions: inClass.length,
          parsed: inClass.filter((answer) => answer.parsed).length,
        }];
      }));
    const report = {
      ok: true,
      independentlyAdjudicated: true,
      version: 1,
      sessionType: EXPERIMENT_CLOSED_BOOK_LABEL,
      runDir,
      runId: config.runId,
      campaignId: config.campaignId,
      arm: config.arm,
      repetition: config.repetition,
      mode: config.mode,
      transport: config.transport ?? "auto",
      manifest,
      usage: {
        ...usage,
        wallClockMs: worker.workerFinishedMonotonicMs - worker.workerStartedMonotonicMs,
      },
      probeClassSummary,
      probeVerdicts,
      probes: transcripts,
      evidence: {
        sessionSha256: seal.sessionSha256,
        candidateReportSha256: seal.candidateReportSha256,
        manifestSha256: sha256Json(manifest),
        planSha256: plan.planSha256,
        questionsSha256: manifest.questionsSha256,
        promptSha256: candidate.workerReady.promptSha256,
        adjudicatorSourceSha256: fileSha256(fileURLToPath(import.meta.url)),
        probeTranscriptSha256: sha256Text(JSON.stringify(transcripts)),
      },
    };
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
      voluntaryFoldShare: null, expandCalls: 0, pinCalls: 0, unpinCalls: 0,
      refoldCalls: 0, peekCalls: 0, foldKinds: {},
      // The same lens on an arm that folds nothing: it reads the empty run rather than
      // stating a hand-written zero, so the two arms can never report different shapes.
      briefProvenance: endOfRunBriefProvenance(runEntries) };
  // The runtime's own canonical stream: exact mutation accounting and the
  // mechanism-limited counterfactual. Arms without the extension emit no stream, and the
  // wire series above remains their only mutation lens.
  const contextEvents = armRuntime.activeContextEnabled
    ? contextEventMetrics(runEntries)
    : null;

  // Arm invariants: an arm that did the other arm's thing is not evidence. Compaction is
  // judged by OUTCOME, so the invariant is about COMPLETED compactions: the pifold arm runs
  // with compaction enabled and is expected to see passes, but a summary that replaced its
  // transcript would mean the runtime failed to intercept. Both witnesses count completions
  // only, since a cancelled pass opens no stop-the-world record and writes no branch entry.
  if (nativeCompactionDisposition(config.arm).latchOnCompletion) {
    assertExperiment(stw.nativeCompactions === 0 && stw.nativeCompactionSessionEntries === 0,
      `Arm ${config.arm} recorded a completed native compaction`);
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
  // the blind grader is a second reader. Echo probes are graded separately, as
  // consistency with the agent's OWN earlier answer beside plan truth.
  const probeVerdicts = probeMechanicalVerdicts({ plan, transcripts: probes });
  // What each wave COST to answer, reported beside the score so a free wave is
  // never read as recall. sol-20260814-deployment had two: native answered wave
  // 16 with nothing compacted yet and stages 1-15 fully raw, and pifold answered
  // wave 32 with zero recovery calls and lost both of its probes there.
  const waveRecovery = probeWaveRecovery({ entries: runEntries, transcripts: probes });
  const echoes = echoVerdicts({ plan, transcripts: probes });
  // The withheld end block, graded three ways: record correctness fixed at
  // record time (the ledger tool's event against the plan), recall fidelity
  // against the agent's OWN record, and what the answers cost in recovery,
  // with the reconstruction table row-exact and the withdrawn-value trap cell
  // stated beside the verdict.
  // A v5 plan grades ADJACENCY and a v4 plan the ledger, on the plan's own say-so. The
  // adjacency block has no record half to compare against (`ledger_record` was deleted with
  // the ledger), so what it reports is the read plus one verdict per question: correct,
  // partial, wrong, or abstained, an abstention being the honest decline the ask invites
  // rather than a zero.
  const endBlock = plan.endBlockAdjacency !== undefined
    ? (() => {
      const transcript = endBlockAdjacencyTranscript({
        entries: runEntries, questions: plan.endBlockAdjacency,
      });
      const byId = new Map(plan.endBlockAdjacency.map((question) => [question.id, question]));
      return {
        schema: ARTIFACT_END_BLOCK_SCHEMA,
        delivered: transcript.delivered,
        answers: transcript.answers.map((answer) => ({
          ...answer,
          verdict: gradeAdjacency({ question: byId.get(answer.id), named: answer.named }),
        })),
      };
    })()
    : endBlockVerdicts({
      entries: runEntries, ledger: plan.ledger, querySeed: config.querySeed, events: workerEvents,
    });

  // The v5 stale artifacts, graded post-hoc from the snapshots the extension took at
  // collection time. A run staged before the instrument carries neither the file nor the
  // plan's asks and reports null, exactly as a pre-ledger run reports no ledger.
  const staleArtifacts = plan.staleArtifacts === undefined ? null
    : staleArtifactVerdicts({
      records: readJsonLines(join(runDir, "stale-artifacts.jsonl")),
      artifacts: plan.staleArtifacts,
    });

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
  const provenance = probeProvenance({
    entries: runEntries, plan, probes, steps: auditTranscripts,
  });

  // (g) The per-request dials the iteration comparison runs on. The ledger is the source
  // because it alone carries the request wall clock beside the response usage; it is
  // cross-checked against the session's own assistant-message count so the two witnesses
  // cannot silently disagree.
  const usageSeries = usageSeriesFromLedger(ledger);
  // A queued followUp delivery (the directed curation turn's trigger) can abort
  // the request build in flight, and Pi persists that abort as an assistant
  // message with stopReason "error" and an all-zero usage block; no ledger
  // record can exist for it. A provider-delivered zero-usage error (native
  // rep 6: "Your input exceeds the context window") is the same marker shape
  // WITH its exchange recorded, so the unledgered count is derived and
  // bounded by the marker count rather than assumed equal to it. An unpaired
  // assistant message carrying ANY spend still fails by this name, because
  // unrecorded provider spend is what the two witnesses exist to catch.
  const abortMarkers = abortMarkerMessages(runEntries);
  const witness = reconcileWitnessCount({
    requests: usage.requests,
    responses: usageSeries.series.length,
    markers: abortMarkers.length,
  });
  assertExperiment(witness.ok,
    `Provider ledger reports ${usageSeries.series.length} responses against ` +
    `${usage.requests} assistant messages in the session ` +
    `(${abortMarkers.length} zero-usage abort marker(s), ` +
    `${witness.unledgered} unledgered)`);
  const thinkTime = thinkTimeFromPace(paceRecords);
  // Read once, reported under two headings: what was spent where the ledger cannot see it,
  // and what Pi billed for everything including that.
  const outOfBand = outOfBandUsage(entries);
  const billed = billedCostFromLedger(ledger);

  const report = {
    ok: true,
    independentlyAdjudicated: true,
    version: 1,
    runDir,
    runId: config.runId,
    campaignId: config.campaignId,
    arm: config.arm,
    // The retired condition dials, reported from the run config when it carries them.
    // An ABSENT key means the run was configured after the dials were deleted, so it is
    // epoch with foldable peek results by construction: every artifact sealed while the
    // dials existed wrote both keys explicitly (verified across all 17 campaign-metrics
    // rows), and the runtime now refuses either option at construction. Defaulting to
    // the shipped-through-1.0.2 values here would publish every future epoch run as
    // "immediate".
    foldScheduling: config.foldScheduling ?? "epoch",
    foldPeekResults: config.foldPeekResults ?? true,
    providerInputBudget: config.providerInputBudget ?? null,
    // Which model this run ASKED to write its fold briefs, or null for a run that wired
    // none. What the run actually got is `curation.briefProvenance`: a configured
    // generator that failed every call reads as a full deterministic count there, so the
    // two fields together separate the intended regime from the observed one.
    briefGenerator: config.briefGenerator ?? null,
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
      // What it took to keep the workload moving, split by cause. A model that stopped
      // early and a turn our own fence aborted are different costs and the comparison
      // reads them differently, so neither is reported as the other.
      resumes: recordedResumes,
      resumesAfterFenceCompaction: (worker.stageNudges ?? [])
        .filter((nudge) => nudge.reason === "fence-compaction").length,
      resumesAfterModelStop: (worker.stageNudges ?? [])
        .filter((nudge) => nudge.reason === "model-ended-turn").length,
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
      // Aborted turns Pi persisted as zero-usage error messages: in the
      // assistant count above, absent from the wire series, no spend to carry.
      abortMarkers,
      unledgeredAbortMarkers: witness.unledgered,
    },
    // WHAT THE MESSAGE LOOP CANNOT SEE, and what Pi actually billed for all of it.
    //
    // `usage` above is the conversation alone. Native's compactions and pi-fold's brief
    // generator both call the provider outside it and neither reaches the request hook, so
    // both were invisible until 2026-08-14: rep 1 of sol-20260814-fenced-full hid 1,586,200
    // fresh generator tokens on one arm and 75,375 compaction tokens on the other, and the
    // arm with the larger hidden spend was the one the headline favoured.
    //
    // Cost is READ from the same records rather than computed, so the long-context tier is
    // already inside it; the crossing COUNT is reported beside it because that tier is
    // where a declared serving budget silently decides the result.
    outOfBand,
    billed: {
      ...billed,
      outOfBandUsd: outOfBand.totals.costUsd,
      totalUsd: billed.messageCallsUsd + outOfBand.totals.costUsd,
      unansweredRequests: unansweredRequestsFromLedger(ledger),
    },
    // Read beside the wall clock on purpose. Every turn derives over the whole session, so
    // a ledger that grows faster than the work buys wall time no provider charged for, and
    // `wallClockMs` alone cannot tell that apart from folding being slow.
    sessionLedger: sessionLedgerLens(entries, statSync(sessionFile).size),
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
    providerWeather: providerWeather(workerEvents, ledger),
    overflowPoint,
    probeClassSummary,
    probeVerdicts,
    waveRecovery,
    echoes,
    endBlock,
    staleArtifacts,
    auditTraces,
    provenance,
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
    "entriesWithoutUsage", "providerResponses", "abortMarkers", "unledgeredAbortMarkers",
    "wallClockMs", "series", "mutations",
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
