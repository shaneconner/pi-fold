#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sessionFile = process.argv[2] || process.env.PI_SESSION_FILE;
const markerId = process.argv[3] || process.env.QUORUM_CONTEXT_CANARY_MARKER || null;
const requiredAgentFolds = Number.parseInt(process.env.QUORUM_REQUIRED_AGENT_FOLDS ?? "0", 10);
if (!Number.isSafeInteger(requiredAgentFolds) || requiredAgentFolds < 0 || requiredAgentFolds > 64) {
  throw new Error(`Invalid QUORUM_REQUIRED_AGENT_FOLDS: ${process.env.QUORUM_REQUIRED_AGENT_FOLDS}`);
}
if (!sessionFile || !existsSync(sessionFile)) throw new Error(`Pi session does not exist: ${sessionFile || "missing"}`);

const piRoot = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist", "index.js")));
const { createJiti } = await import(pathToFileURL(
  join(piRoot, "node_modules", "jiti", "lib", "jiti.mjs"),
));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
    typebox: join(piRoot, "node_modules", "typebox", "build", "index.mjs"),
  },
});
const context = await jiti.import(join(projectRoot, ".pi", "extensions", "quorum", "active-context.ts"));
const identity = await jiti.import(join(projectRoot, ".pi", "extensions", "quorum", "identity.js"));
const json = await jiti.import(join(projectRoot, ".pi", "extensions", "quorum", "json.ts"));

const manager = SessionManager.open(sessionFile, undefined, projectRoot);
const branch = manager.getBranch();
const markerIndex = markerId ? branch.findIndex((entry) => entry.id === markerId) : -1;
if (markerId && markerIndex < 0) throw new Error(`Canary marker ${markerId} is not on the selected Pi branch`);
const sinceMarker = markerIndex < 0 ? branch : branch.slice(markerIndex + 1);
const state = context.materializeActiveContextState(branch, manager.getSessionId(),
  identity.QUORUM_STATE_ENTRY, identity.QUORUM_FOLD_RECORD_ENTRY);
const messages = manager.buildSessionContext().messages;
const snapshot = context.mapActiveContext({
  sessionId: manager.getSessionId(),
  eventMessages: messages,
  contextEntries: manager.buildContextEntries(),
});
const projection = context.projectActiveContext(snapshot, state);
const status = context.activeContextStatus(snapshot, state, 0, 32);
const terminal = [...messages].reverse().find((message) => message?.role === "assistant" &&
  ["stop", "length", "toolUse"].includes(message.stopReason) &&
  typeof message.provider === "string" && message.provider &&
  typeof message.model === "string" && message.model &&
  message.usage && typeof message.usage === "object" &&
  Number.isFinite(message.usage.totalTokens) && message.usage.totalTokens > 0);
const tokens = terminal?.usage?.totalTokens;
const contextWindow = terminal?.contextWindow ?? 272_000;
const stateEntries = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_STATE_ENTRY);
const foldRecords = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_FOLD_RECORD_ENTRY);
const nativeCompactions = sinceMarker.filter((entry) => entry.type === "compaction");
const nativeDecisions = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_NATIVE_COMPACTION_DECISION_ENTRY);
const nativeReceipts = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === identity.QUORUM_NATIVE_COMPACTION_RECEIPT_ENTRY);
const historicalGuidanceReceipts = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_MILESTONE_RECEIPT_ENTRY)
  .map((entry) => context.parseGuidanceMilestoneReceipt(entry.data, manager.getSessionId()));
const historicalGuidanceActions = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_ACTION_RECEIPT_ENTRY)
  .map((entry) => context.parseGuidanceActionReceipt(entry.data, manager.getSessionId()));
const guidanceDeliveries = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_DELIVERY_ENTRY)
  .map((entry) => context.parseGuidanceDelivery(entry.data, manager.getSessionId()));
const guidanceActions = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_OBLIGATION_ACTION_ENTRY)
  .map((entry) => context.parseGuidanceObligationActionReceipt(entry.data, manager.getSessionId()));
const guidanceReductions = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_REDUCTION_ENTRY)
  .map((entry) => context.parseGuidanceReductionReceipt(entry.data, manager.getSessionId()));
const guidanceFallbacks = sinceMarker.filter((entry) => entry.type === "custom" &&
  entry.customType === context.GUIDANCE_AUTOMATIC_FALLBACK_ENTRY)
  .map((entry) => context.parseGuidanceAutomaticFallbackReceipt(entry.data, manager.getSessionId()));
const recoverAction = (receipt, protocol, validate) => {
  validate();
  const fold = state.folds.find((candidate) => candidate.id === receipt.foldId);
  if (!fold) throw new Error(`Guidance action fold ${receipt.foldId} is absent after restart`);
  const refs = context.flattenFoldRefs(fold, state);
  if (JSON.stringify(refs) !== JSON.stringify(receipt.sourceRefs)) {
    throw new Error(`Guidance action fold ${receipt.foldId} source order drifted after restart`);
  }
  const recovered = context.recoverFoldMessages({
    foldId: receipt.foldId, state, entries: branch, sessionId: manager.getSessionId(),
  });
  if (!recovered.length) throw new Error(`Guidance action fold ${receipt.foldId} recovered no messages`);
  return {
    protocol,
    receiptKey: receipt.receiptKey,
    foldId: receipt.foldId,
    sourceRefs: refs,
    recoveredSha256: json.sha256Value(recovered),
  };
};
const historicalActionRecovery = historicalGuidanceActions.map((receipt) => recoverAction(
  receipt,
  "historical-milestone-action",
  () => context.validateGuidanceActionReceipt({
    receipt, entries: branch, state, sessionId: manager.getSessionId(),
  }),
));
const actionRecovery = guidanceActions.map((receipt) => {
  const delivery = guidanceDeliveries.find((candidate) => candidate.deliveryKey === receipt.deliveryKey);
  if (!delivery) throw new Error(`Guidance action ${receipt.receiptKey} lacks delivery ${receipt.deliveryKey}`);
  const reduction = guidanceReductions.find((candidate) => candidate.actionReceiptKey === receipt.receiptKey);
  if (!reduction) throw new Error(`Guidance action ${receipt.receiptKey} lacks its reduction receipt`);
  const recovered = recoverAction(receipt, "delivery-action-reduction", () => {
    context.validateGuidanceObligationActionReceipt({
      receipt, delivery, entries: branch, state, sessionId: manager.getSessionId(),
    });
    context.validateGuidanceReductionReceipt({
      receipt: reduction,
      delivery,
      action: receipt,
      entries: branch,
      state,
      sessionId: manager.getSessionId(),
    });
  });
  return { ...recovered, deliveryKey: delivery.deliveryKey, reductionReceiptKey: reduction.receiptKey };
});
const toolCandidates = context.selectAutomaticToolBatch(snapshot, state, 0.85);
const chapterCandidate = context.selectAutomaticCandidate(snapshot, state, 0.95);
const historicalAutomaticGuidance = historicalGuidanceReceipts.filter(
  (receipt) => receipt.automaticFallback !== "none",
);
const newProtocolComplete = guidanceDeliveries.length === guidanceActions.length &&
  guidanceActions.length === guidanceReductions.length &&
  new Set(guidanceActions.map((receipt) => receipt.deliveryKey)).size === guidanceActions.length &&
  new Set(guidanceReductions.map((receipt) => receipt.actionReceiptKey)).size === guidanceReductions.length;
const uniqueCausalActionIds = context.uniqueGuidanceActionCausalIdentities([
  ...historicalGuidanceActions,
  ...guidanceActions,
]);
const totalAgentActions = uniqueCausalActionIds.length;
const report = {
  ok: nativeCompactions.length === 0 && nativeDecisions.length === 0 && nativeReceipts.length === 0 &&
    historicalAutomaticGuidance.length === 0 && guidanceFallbacks.length === 0 && newProtocolComplete &&
    totalAgentActions >= requiredAgentFolds,
  sessionId: manager.getSessionId(),
  sessionFile,
  marker: markerId ? { id: markerId, index: markerIndex, timestamp: branch[markerIndex]?.timestamp } : null,
  branchEntries: branch.length,
  postMarkerEntries: sinceMarker.length,
  messages: messages.length,
  rawJsonBytes: Buffer.byteLength(JSON.stringify(messages)),
  projectedJsonBytes: Buffer.byteLength(JSON.stringify(projection)),
  provider: terminal ? {
    provider: terminal.provider ?? null,
    model: terminal.model ?? null,
    tokens: Number.isFinite(tokens) ? tokens : null,
    contextWindow,
    ratio: Number.isFinite(tokens) && contextWindow > 0 ? tokens / contextWindow : null,
  } : null,
  persistence: {
    revision: state.revision,
    historicalFolds: state.folds.length,
    activeFolds: status.totalFolds,
    activeRoots: status.roots,
    stateEventsAfterMarker: stateEntries.length,
    stateVersionsAfterMarker: [...new Set(stateEntries.map((entry) => entry.data?.version))],
    foldRecordsAfterMarker: foldRecords.length,
  },
  eligible: {
    toolBatches: toolCandidates.length,
    toolResults: toolCandidates.reduce((count, candidate) => count + candidate.sourceRefs.length, 0),
    oldestToolResultId: toolCandidates[0]?.sourceRefs[0]?.entryId ?? null,
    highPressureKind: chapterCandidate?.kind ?? null,
    highPressureRefs: chapterCandidate?.sourceRefs?.length ?? 0,
  },
  guidance: {
    historicalMilestones: historicalGuidanceReceipts,
    historicalActionReceipts: historicalGuidanceActions,
    deliveries: guidanceDeliveries,
    actionReceipts: guidanceActions,
    reductionReceipts: guidanceReductions,
    actionRecovery: [...historicalActionRecovery, ...actionRecovery],
    automaticFallbacks: [...historicalAutomaticGuidance, ...guidanceFallbacks],
    newProtocolComplete,
    uniqueCausalActionIds,
    totalAgentActions,
    requiredAgentFolds,
  },
  nativeAfterMarker: {
    compactions: nativeCompactions.map((entry) => ({ id: entry.id, timestamp: entry.timestamp, tokensBefore: entry.tokensBefore })),
    decisions: nativeDecisions.length,
    receipts: nativeReceipts.length,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
