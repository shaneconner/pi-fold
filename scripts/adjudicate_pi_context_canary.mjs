#!/usr/bin/env node

/** Re-adjudicate the withdrawn historical calibration without authorizing current acceptance. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const MANIFEST_PATH = join(PROJECT, "tests", "fixtures", "pi_context", "live_canary_acceptance_candidate.json");
const MANIFEST_SHA256 = "7ca5e1423071cab3a19ca97d969df26421ef96d703d6f0ed1e911a2b78167fbc";
const DEFAULT_REPORT = "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T18-45-04-835Z/report.json";
const DEFAULT_SESSION = "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T18-45-04-835Z/2026-08-01T18-45-04-892Z_019fbea4-e2fc-73d0-a31e-8c3b901b9171.jsonl";
const reportPath = process.argv[2] ?? DEFAULT_REPORT;
const sessionPath = process.argv[3] ?? DEFAULT_SESSION;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

assert(existsSync(MANIFEST_PATH) && sha256(MANIFEST_PATH) === MANIFEST_SHA256,
  "Acceptance-candidate manifest is missing or changed");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
assert(exactKeys(manifest, ["version", "source", "policy", "observed"]) && manifest.version === 1 &&
  exactKeys(manifest.source, ["reportSha256", "sessionSha256", "sessionId"]) &&
  exactKeys(manifest.policy, [
    "provider", "model", "contextWindow", "awarenessTokens", "automaticToolTokens",
    "requiredAgentFolds", "chainFiles",
  ]) && exactKeys(manifest.observed, [
    "runEntries", "providerCheckpoints", "firstProviderTokens", "highWaterTokens",
    "finalProviderTokens", "terminalEntryId", "readCalls", "statusCalls", "foldCalls",
    "stateEvents", "foldRecords", "guidanceActions",
  ]), "Acceptance-candidate manifest schema drifted");
if (process.env.QUORUM_CANARY_ACCEPTANCE_MANIFEST_ONLY === "1") {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptance: false,
    preflightOnly: true,
    manifestPath: MANIFEST_PATH,
    manifestSha256: MANIFEST_SHA256,
    source: manifest.source,
    policy: manifest.policy,
    observed: manifest.observed,
  }, null, 2)}\n`);
  process.exit(0);
}
assert(existsSync(reportPath) && existsSync(sessionPath), "Pinned canary report/session is unavailable");
assert(sha256(reportPath) === manifest.source.reportSha256, "Pinned canary report hash drifted");
assert(sha256(sessionPath) === manifest.source.sessionSha256, "Pinned canary session hash drifted");

const report = JSON.parse(readFileSync(reportPath, "utf8"));
assert(report.ok === false && report.acceptance === false &&
  report.error?.message === `Marathon never crossed action pressure: ${manifest.observed.highWaterTokens}/176800`,
"Candidate is not the known over-strict canary result");
assert(report.sessionFile === sessionPath && report.observations?.deadlineFired === false &&
  report.observations?.pressureAbortFired === false,
"Candidate report lifecycle facts drifted");
for (const [key, reportKey] of Object.entries({
  runEntries: "runEntries", providerCheckpoints: "providerCheckpointEvents",
  highWaterTokens: "highWaterTokens", readCalls: "readCalls", statusCalls: "statusCalls",
  foldCalls: "foldCalls", stateEvents: "states", foldRecords: "foldRecords",
  guidanceActions: "guidanceActions",
})) {
  const actual = ["states", "foldRecords", "guidanceActions"].includes(reportKey)
    ? report.observations.customEntryCounts?.[reportKey] : report.observations?.[reportKey];
  assert(actual === manifest.observed[key], `Candidate report ${key} drifted: ${actual}`);
}
assert(report.nativeCounts?.compactions === 0 && report.nativeCounts?.decisions === 0 &&
  report.nativeCounts?.receipts === 0 && report.compactionEvents?.length === 0,
"Candidate report contains native fallback");

const { SessionManager } = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
const { calculateContextTokens } = await import(pathToFileURL(
  join(PI_ROOT, "dist", "core", "compaction", "index.js"),
));
const jiti = createJiti(import.meta.url);
const context = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "active-context.ts"));
const identity = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "identity.js"));
const json = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "json.ts"));
const manager = SessionManager.open(sessionPath, undefined, PROJECT);
assert(manager.getSessionId() === manifest.source.sessionId, "Pinned canary session ID drifted");
const branch = manager.getBranch();
const runEntries = branch.slice(-manifest.observed.runEntries);
assert(runEntries.length === manifest.observed.runEntries, "Pinned canary run-entry boundary drifted");
const runIndex = new Map(runEntries.map((entry, index) => [entry.id, index]));
const successfulAssistant = (message) => message?.role === "assistant" &&
  message.provider === manifest.policy.provider && message.model === manifest.policy.model &&
  ["stop", "length", "toolUse"].includes(message.stopReason) &&
  Number.isFinite(calculateContextTokens(message.usage)) && calculateContextTokens(message.usage) > 0;
const assistants = runEntries.flatMap((entry) => entry.type === "message" && successfulAssistant(entry.message)
  ? [{ entry, message: entry.message, tokens: calculateContextTokens(entry.message.usage) }] : []);
const providerTokens = assistants.map((item) => item.tokens);
assert(assistants.length === manifest.observed.providerCheckpoints &&
  providerTokens[0] === manifest.observed.firstProviderTokens &&
  Math.max(...providerTokens) === manifest.observed.highWaterTokens &&
  providerTokens.at(-1) === manifest.observed.finalProviderTokens,
"Pinned provider checkpoints drifted");
assert(providerTokens[0] < manifest.policy.awarenessTokens &&
  Math.max(...providerTokens) >= manifest.policy.awarenessTokens &&
  Math.max(...providerTokens) < manifest.policy.automaticToolTokens &&
  providerTokens.some((tokens, index) => index > 0 && tokens < providerTokens[index - 1]),
"Candidate did not prove awareness, bounded pressure, and provider-confirmed reduction");
assert(assistants.at(-1).entry.id === manifest.observed.terminalEntryId &&
  assistants.at(-1).message.stopReason === "stop", "Candidate lacks terminal provider completion");

const calls = (name, action) => assistants.flatMap(({ entry, message, tokens }) =>
  (Array.isArray(message.content) ? message.content : []).flatMap((part) =>
    part?.type === "toolCall" && part.name === name &&
    (action === undefined || part.arguments?.action === action)
      ? [{ entryId: entry.id, callId: part.id, arguments: part.arguments, tokens }] : []));
const readCalls = calls("read");
const statusCalls = calls("quorum_context", "status");
const foldCalls = calls("quorum_context", "fold");
assert(readCalls.length === manifest.observed.readCalls && statusCalls.length === manifest.observed.statusCalls &&
  foldCalls.length === manifest.observed.foldCalls, "Candidate tool-call counts drifted");
const pairedReadResults = readCalls.map((call) => {
  const callIndex = runIndex.get(call.entryId);
  const result = runEntries.slice(callIndex + 1).find((entry) => {
    const message = entry.type === "message" ? entry.message : null;
    return message?.role === "toolResult" && message.toolCallId === call.callId &&
      message.toolName === "read";
  });
  assert(result?.message?.isError === false,
    `Read call ${call.callId} lacks a successful result`);
  const text = (Array.isArray(result.message.content) ? result.message.content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
  return { ...call, callIndex, resultEntryId: result.id, resultIndex: runIndex.get(result.id), text };
});
const stageResults = [...Array(manifest.policy.chainFiles)].map((_, index) => {
  const file = index + 1;
  const path = join(report.runDir, "evidence", `archive-${String(file).padStart(2, "0")}.txt`);
  const reads = pairedReadResults.filter((item) => item.arguments?.path === path);
  assert(reads.length > 0, `Candidate lacks a successful archive-${String(file).padStart(2, "0")} read`);
  const next = file < manifest.policy.chainFiles
    ? join(report.runDir, "evidence", `archive-${String(file + 1).padStart(2, "0")}.txt`) : "END";
  const pointer = reads.find((item) => item.text.includes(`NEXT: ${next}`));
  assert(pointer, `Archive stage ${file} lacks its successful NEXT result`);
  return { file, path, next, pointer };
});
for (let index = 1; index < stageResults.length; index += 1) {
  const firstCall = Math.min(...pairedReadResults
    .filter((item) => item.arguments?.path === stageResults[index].path)
    .map((item) => item.callIndex));
  assert(firstCall > stageResults[index - 1].pointer.resultIndex,
    `Archive stage ${index + 1} began before stage ${index} completed`);
}

const successfulFolds = foldCalls.map((call) => {
  const callIndex = runIndex.get(call.entryId);
  const result = runEntries.slice(callIndex + 1).find((entry) => {
    const message = entry.type === "message" ? entry.message : null;
    return message?.role === "toolResult" && message.toolCallId === call.callId &&
      message.toolName === "quorum_context";
  });
  assert(result?.message?.isError === false && result.message.details?.action === "fold" &&
    typeof result.message.details?.id === "string", `Fold call ${call.callId} lacks a successful result`);
  return { ...call, resultEntryId: result.id, foldId: result.message.details.id };
});
assert(new Set(successfulFolds.map((item) => item.foldId)).size === successfulFolds.length,
  "Candidate model fold IDs are not unique");

const state = context.materializeActiveContextState(branch, manager.getSessionId(),
  identity.QUORUM_STATE_ENTRY, identity.QUORUM_FOLD_RECORD_ENTRY);
const stateFoldIds = new Set(state.folds.map((fold) => fold.id));
assert(state.folds.length === successfulFolds.length &&
  successfulFolds.every((item) => stateFoldIds.has(item.foldId)),
"Candidate contains a non-model-origin automatic fold or lost a model fold");
const stateEntries = runEntries.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_STATE_ENTRY);
const foldRecords = runEntries.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_FOLD_RECORD_ENTRY);
assert(stateEntries.length === manifest.observed.stateEvents && foldRecords.length === manifest.observed.foldRecords,
  "Candidate durable state/fold counts drifted");
const foldReductions = successfulFolds.map((action) => {
  const resultIndex = runIndex.get(action.resultEntryId);
  const durableStateEntry = runEntries.slice(0, resultIndex).reverse().find((entry) =>
    entry.type === "custom" && entry.customType === identity.QUORUM_STATE_ENTRY);
  const projectionRevision = durableStateEntry?.data?.revision;
  assert(Number.isSafeInteger(projectionRevision),
    `Model fold ${action.foldId} lacks a preceding durable projection revision`);
  const measurementEntry = runEntries.slice(resultIndex + 1).find((entry) =>
    entry.type === "custom" && entry.customType === identity.QUORUM_PROVIDER_CONTEXT_MEASUREMENT_ENTRY &&
    entry.data?.provider === manifest.policy.provider && entry.data?.model === manifest.policy.model &&
    Number.isSafeInteger(entry.data?.projectionRevision) &&
    entry.data.projectionRevision >= projectionRevision && Number.isFinite(entry.data?.tokens));
  assert(measurementEntry && measurementEntry.data.tokens < action.tokens,
    `Model fold ${action.foldId} lacks a later provider-confirmed reduction`);
  return {
    foldId: action.foldId,
    beforeTokens: action.tokens,
    afterTokens: measurementEntry.data.tokens,
    measurementSha256: measurementEntry.data.messageSha256,
    projectionRevision: measurementEntry.data.projectionRevision,
  };
});
const reductionByFold = new Map(foldReductions.map((item) => [item.foldId, item]));

const guidance = runEntries.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_MILESTONE_RECEIPT_ENTRY)
  .map((entry) => context.parseGuidanceMilestoneReceipt(entry.data, manager.getSessionId()));
const actions = runEntries.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_ACTION_RECEIPT_ENTRY)
  .map((entry) => context.parseGuidanceActionReceipt(entry.data, manager.getSessionId()));
assert(actions.length === manifest.observed.guidanceActions &&
  actions.length >= manifest.policy.requiredAgentFolds &&
  new Set(actions.map((receipt) => receipt.receiptKey)).size === actions.length &&
  new Set(actions.map((receipt) => receipt.toolCallId)).size === actions.length &&
  new Set(actions.map((receipt) => receipt.foldId)).size === actions.length &&
  guidance.some((receipt) => receipt.milestone === "awareness") &&
  guidance.every((receipt) => receipt.automaticFallback === "none"),
"Candidate lacks distinct attributed awareness actions or contains fallback");
const successfulByFold = new Map(successfulFolds.map((item) => [item.foldId, item]));
const actionRecovery = actions.map((receipt) => {
  context.validateGuidanceActionReceipt({
    receipt, entries: branch, state, sessionId: manager.getSessionId(),
  });
  const action = successfulByFold.get(receipt.foldId);
  assert(action && action.entryId === receipt.assistantEntryId &&
    action.callId === receipt.toolCallId && action.resultEntryId === receipt.toolResultEntryId,
  `Guidance action ${receipt.receiptKey} is not bound to its model fold`);
  const actionIndex = runIndex.get(action.entryId);
  assert(receipt.sourceRefs.every((ref) => {
    const index = runIndex.get(ref.entryId);
    return Number.isSafeInteger(index) && index < actionIndex;
  }), `Guidance action ${receipt.receiptKey} cites non-prior source evidence`);
  const reduction = reductionByFold.get(receipt.foldId);
  assert(reduction && reduction.projectionRevision >= receipt.durableRevision,
    `Guidance action ${receipt.receiptKey} lacks its revision-bound provider reduction`);
  const recovered = context.recoverFoldMessages({
    foldId: receipt.foldId, state, entries: branch, sessionId: manager.getSessionId(),
  });
  assert(recovered.length > 0, `Guidance action ${receipt.receiptKey} recovered no exact evidence`);
  return {
    receiptKey: receipt.receiptKey,
    foldId: receipt.foldId,
    recoveredSha256: json.sha256Value(recovered),
    beforeTokens: reduction.beforeTokens,
    afterTokens: reduction.afterTokens,
    measurementSha256: reduction.measurementSha256,
    projectionRevision: reduction.projectionRevision,
  };
});

const native = {
  compactions: runEntries.filter((entry) => entry.type === "compaction").length,
  decisions: runEntries.filter((entry) => entry.type === "custom" &&
    entry.customType === identity.QUORUM_NATIVE_COMPACTION_DECISION_ENTRY).length,
  receipts: runEntries.filter((entry) => entry.type === "custom" &&
    entry.customType === identity.QUORUM_NATIVE_COMPACTION_RECEIPT_ENTRY).length,
};
assert(native.compactions === 0 && native.decisions === 0 && native.receipts === 0,
  "Candidate contains native fallback");
const finalText = (assistants.at(-1).message.content ?? [])
  .filter((part) => part?.type === "text").map((part) => part.text).join("\n");
assert(finalText.includes("CANARY_MARKER_01") &&
  finalText.includes(`CANARY_MARKER_${String(manifest.policy.chainFiles).padStart(2, "0")}`) &&
  finalText.includes(`archive-01.txt\` through \`archive-${String(manifest.policy.chainFiles).padStart(2, "0")}.txt`),
"Candidate final synthesis does not identify the complete chain range");

const result = {
  ok: true,
  acceptance: false,
  calibrationOnly: true,
  adjudicatedExistingRun: true,
  correction: "This minutes-scale historical run remains capability evidence only; current acceptance requires at least three wall-clock hours and the durable guidance protocol.",
  reportPath,
  reportSha256: manifest.source.reportSha256,
  sessionPath,
  sessionSha256: manifest.source.sessionSha256,
  sessionId: manager.getSessionId(),
  firstProviderTokens: providerTokens[0],
  highWaterTokens: Math.max(...providerTokens),
  finalProviderTokens: providerTokens.at(-1),
  providerCheckpoints: assistants.length,
  chainFiles: manifest.policy.chainFiles,
  readCalls: readCalls.length,
  statusCalls: statusCalls.length,
  foldCalls: foldCalls.length,
  modelOriginFoldIds: successfulFolds.map((item) => item.foldId),
  foldReductions,
  guidanceActions: actions.length,
  actionRecovery,
  nativeCounts: native,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
