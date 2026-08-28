import type { EvidenceRef } from "../json.ts";
import {
  denseOwnArrayValues,
  evidenceSha256,
  objectRefKey,
  sameObjectIdentity,
  sha256Value,
} from "../json.ts";
import {
  bytes,
  clone,
  exactRecord,
  messageRole,
  ownValue,
} from "./canonical.ts";
import {
  childFoldIds,
  assignFoldParents,
  flattenFoldRefs,
  foldMap,
  parseActiveContextState,
} from "./persistence.ts";
import {
  ACTIVE_CONTEXT_POLICY,
  DEFAULT_CONTEXT_WINDOW,
  servingBudgetTokens,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveFold,
  MappedMessage,
} from "./policy.ts";

export { protectionSha256, topologySha256 } from "./persistence.ts";
export { clone } from "./canonical.ts";
export { sha256Value } from "../json.ts";
export { validAdvisoryState } from "./persistence.ts";

export const MAPPED_BY_KEY = new WeakMap<ActiveContextSnapshot, Map<string, MappedMessage>>();

export function mappedByKey(snapshot: ActiveContextSnapshot): Map<string, MappedMessage> {
  let indexed = MAPPED_BY_KEY.get(snapshot);
  if (!indexed) {
    indexed = new Map(snapshot.mapped.flatMap((item) => item.ref ? [[objectRefKey(item.ref), item]] : []));
    MAPPED_BY_KEY.set(snapshot, indexed);
  }
  return indexed;
}

export function exactMapped(snapshot: ActiveContextSnapshot, ref: EvidenceRef): MappedMessage | null {
  const item = mappedByKey(snapshot).get(objectRefKey(ref));
  return item && sameObjectIdentity(item.ref!, ref) && item.ref!.sha256 === ref.sha256 &&
    evidenceSha256(item.message) === ref.sha256 ? item : null;
}

export function refsInOrder(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): number[] | null {
  const indices = refs.map((ref) => exactMapped(snapshot, ref)?.index ?? -1);
  if (indices.some((index) => index < 0) || new Set(indices).size !== indices.length) return null;
  for (let index = 1; index < indices.length; index += 1) if (indices[index] !== indices[index - 1] + 1) return null;
  return indices;
}

export const BRANCH_POSITIONS = new WeakMap<ActiveContextSnapshot, Map<string, { index: number; sha256: string }>>();

export function branchSha256(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): string {
  let indexed = BRANCH_POSITIONS.get(snapshot);
  if (!indexed) {
    indexed = new Map(snapshot.branchObjects.map((item, index) => [
      objectRefKey(item.ref),
      { index, sha256: item.ref.sha256 },
    ]));
    BRANCH_POSITIONS.set(snapshot, indexed);
  }
  const positions = refs.map((ref) => {
    const position = indexed!.get(objectRefKey(ref));
    return position?.sha256 === ref.sha256 ? position.index : -1;
  });
  if (positions.some((index) => index < 0)) return sha256Value({ missing: refs.map(objectRefKey) });
  const anchor = Math.max(...positions);
  return sha256Value(snapshot.branchObjects.slice(0, anchor + 1).map((item) => item.ref));
}

export function contextUsageRatio(value: unknown): number | null {
  const tokens = ownValue(value, "tokens");
  const contextWindow = ownValue(value, "contextWindow");
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 ||
      typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return tokens / contextWindow;
}

export function budgetOccupancy(snapshot: ActiveContextSnapshot, windowRatio: number | null): number | null {
  if (typeof windowRatio !== "number" || !Number.isFinite(windowRatio)) return null;
  if (!(snapshot.budgetTokens > 0) || !(snapshot.contextWindow > 0)) return null;
  return windowRatio * snapshot.contextWindow / snapshot.budgetTokens;
}

export function hardFenceRatio(value?: unknown, ctx?: any): number {
  const direct = ownValue(value, "contextWindow");
  const reported = ownValue(ctx?.getContextUsage?.(), "contextWindow");
  const contextWindow = typeof direct === "number" && Number.isFinite(direct) && direct > 0
    ? direct
    : typeof reported === "number" && Number.isFinite(reported) && reported > 0
      ? reported
      : DEFAULT_CONTEXT_WINDOW;
  const budgetTokens = ownValue(value, "budgetTokens");
  if (typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0) {
    return Math.min(1, budgetTokens / contextWindow);
  }
  const reserve = Math.min(
    ACTIVE_CONTEXT_POLICY.responseReserve,
    Math.floor(contextWindow * 0.1),
  );
  return (contextWindow - reserve) / contextWindow;
}

export interface CapacityAccounting {
  mode: "descriptor" | "truthful";
  window: number;
  outputReservation: number;
  budgetTokens: number;
  usedTokens: number | null;
  headroomTokens: number | null;
  descriptorWindow: number | null;
}

export function capacityAccounting(input: {
  window: number;
  truthful: boolean;
  descriptorWindow: number | null;
  usedTokens: number | null;
}): CapacityAccounting {
  const window = Number.isFinite(input.window) && input.window > 0 ? input.window : DEFAULT_CONTEXT_WINDOW;
  const budgetTokens = input.truthful ? window : servingBudgetTokens(window);
  const outputReservation = window - budgetTokens;
  const usedTokens = typeof input.usedTokens === "number" && Number.isFinite(input.usedTokens) &&
    input.usedTokens >= 0 ? input.usedTokens : null;
  return {
    mode: input.truthful ? "truthful" : "descriptor",
    window,
    outputReservation,
    budgetTokens,
    usedTokens,
    headroomTokens: usedTokens === null ? null : budgetTokens - usedTokens,
    descriptorWindow: input.descriptorWindow,
  };
}

export interface ProviderContextMeasurement {
  tokens: number;
  contextWindow: number;
  messageSha256: string;
  provider: string | null;
  model: string | null;
}

export interface ProviderMeasurementAnchor {
  sessionId: string;
  generation: number;
  topologySha256: string;
  protectionSha256: string;
}

export interface ProviderContextMeasurementReceipt {
  version: 1;
  sessionId: string;
  projectionRevision: number;
  messageSha256: string;
  provider: string;
  model: string;
  tokens: number;
  contextWindow: number;
  occurredAt: number;
}

export const PROVIDER_CONTEXT_MEASUREMENT_KEYS = [
  "version", "sessionId", "projectionRevision", "messageSha256", "provider", "model",
  "tokens", "contextWindow", "occurredAt",
] as const;

export function parseProviderContextMeasurementReceipt(
  value: unknown,
  expectedSessionId?: string,
): ProviderContextMeasurementReceipt {
  if (!exactRecord(value, PROVIDER_CONTEXT_MEASUREMENT_KEYS)) {
    throw new Error("Invalid provider context measurement receipt shape");
  }
  const sessionId = ownValue(value, "sessionId");
  const projectionRevision = ownValue(value, "projectionRevision");
  const messageSha256 = ownValue(value, "messageSha256");
  const provider = ownValue(value, "provider");
  const model = ownValue(value, "model");
  const tokens = ownValue(value, "tokens");
  const contextWindow = ownValue(value, "contextWindow");
  const occurredAt = ownValue(value, "occurredAt");
  if (ownValue(value, "version") !== 1 || typeof sessionId !== "string" || !sessionId ||
      (expectedSessionId && sessionId !== expectedSessionId) ||
      !Number.isSafeInteger(projectionRevision) || Number(projectionRevision) < 0 ||
      typeof messageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(messageSha256) ||
      typeof provider !== "string" || !provider || typeof model !== "string" || !model ||
      typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0 ||
      typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0 ||
      !Number.isSafeInteger(occurredAt) || Number(occurredAt) < 0) {
    throw new Error("Invalid provider context measurement receipt");
  }
  return clone(value) as unknown as ProviderContextMeasurementReceipt;
}

export function providerTokens(message: unknown): number | null {
  const stopReason = ownValue(message, "stopReason");
  if (messageRole(message) !== "assistant" ||
      (stopReason !== "stop" && stopReason !== "length" && stopReason !== "toolUse")) return null;
  const usage = ownValue(message, "usage");
  if (!usage || typeof usage !== "object") return null;
  const total = ownValue(usage, "totalTokens");
  if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
  const components = ["input", "output", "cacheRead", "cacheWrite"].map((key) => ownValue(usage, key));
  if (components.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return null;
  const calculated = components.reduce<number>((sum, value) => sum + Number(value), 0);
  return calculated > 0 ? calculated : null;
}

export function providerContextMeasurement(
  message: unknown,
  contextWindow: unknown,
  expectedModel?: { provider?: unknown; id?: unknown } | null,
): ProviderContextMeasurement | null {
  const tokens = providerTokens(message);
  if (tokens === null || typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  const provider = typeof ownValue(message, "provider") === "string" ? String(ownValue(message, "provider")) : null;
  const model = typeof ownValue(message, "model") === "string" ? String(ownValue(message, "model")) : null;
  if (!provider || !model) return null;
  const expectedProvider = typeof expectedModel?.provider === "string" ? expectedModel.provider : null;
  const expectedId = typeof expectedModel?.id === "string" ? expectedModel.id : null;
  if ((expectedProvider && provider !== expectedProvider) || (expectedId && model !== expectedId)) return null;
  return { tokens, contextWindow, messageSha256: evidenceSha256(message), provider, model };
}

export function latestProviderContextMeasurement(
  messages: unknown[],
  contextWindow: unknown,
  expectedModel?: { provider?: unknown; id?: unknown } | null,
): ProviderContextMeasurement | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const measurement = providerContextMeasurement(messages[index], contextWindow);
    if (!measurement) continue;
    const expectedProvider = typeof expectedModel?.provider === "string" ? expectedModel.provider : null;
    const expectedId = typeof expectedModel?.id === "string" ? expectedModel.id : null;
    if ((expectedProvider && measurement.provider !== expectedProvider) ||
        (expectedId && measurement.model !== expectedId)) return null;
    return measurement;
  }
  return null;
}

export function contextWindowFor(ctx: any): number | null {
  const hostWindow = ownValue(ctx.getContextUsage?.(), "contextWindow");
  if (typeof hostWindow === "number" && Number.isFinite(hostWindow) && hostWindow > 0) return hostWindow;
  const modelWindow = ownValue(ctx?.model, "contextWindow");
  return typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : null;
}

export function rootFolds(state: ActiveContextState): ActiveFold[] {
  return state.folds.filter((fold) => fold.parentId === null);
}

export function foldInterval(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): { start: number; end: number } | null {
  const refs = flattenFoldRefs(fold, state);
  const indices = refsInOrder(snapshot, refs);
  return indices ? { start: indices[0], end: indices.at(-1)! } : null;
}

export type OrderedRoot = { fold: ActiveFold; start: number; end: number };

// ROOT INTERVALS ARE DERIVED ONCE PER (STATE, SNAPSHOT) PAIR (2026-08-24). This derivation
// is O(roots x folds) on its own, because `foldInterval` calls `flattenFoldRefs`, which
// rebuilds `foldMap` for every root it walks. `partsForRange` opens with it, and
// `selectAutomaticChapter` calls `partsForRange` from a walk that is quadratic in units,
// so the cost was O(units^2 x roots x folds) for an answer that cannot change inside a
// pass. Replaying sealed sol-20260823-live rep 3 at 125 folds, ONE frontier walk made
// 12,333 calls and spent 22.5 seconds, and 12,328 of them returned null without reading a
// root, because the automatic chapter passes an EMPTY allowed-child set and any overlap
// refuses. At 140 folds the walk was 98.8 percent of the runtime's whole per-request cost;
// the per-turn gap between a response and the next projection ran 3s at zero folds to 164s
// past 150, and five per-turn call sites each pay a walk.
//
// The memo is gate 113's rule and gate 121's rule at a third address: kept against the
// state and snapshot OBJECTS rather than their contents, because both are REPLACED on
// every change rather than mutated, so a replaced one misses and derives again instead of
// serving something stale. It hands every caller the SAME array, which is safe only while
// no reading mutates it; gate 149 drives every call site against a frozen one so a reading
// that starts mutating throws rather than quietly poisoning the memo.
export const ORDERED_ROOTS = new WeakMap<ActiveContextState, WeakMap<ActiveContextSnapshot, OrderedRoot[]>>();

export function orderedRoots(state: ActiveContextState, snapshot: ActiveContextSnapshot): OrderedRoot[] {
  let bySnapshot = ORDERED_ROOTS.get(state);
  if (!bySnapshot) {
    bySnapshot = new WeakMap<ActiveContextSnapshot, OrderedRoot[]>();
    ORDERED_ROOTS.set(state, bySnapshot);
  }
  const memoized = bySnapshot.get(snapshot);
  if (memoized) return memoized;
  const roots = rootFolds(state).flatMap((fold) => {
    const interval = foldInterval(fold, state, snapshot);
    return interval ? [{ fold, ...interval }] : [];
  }).sort((left, right) => left.start - right.start);
  bySnapshot.set(snapshot, roots);
  return roots;
}

export function visibleCollapsedRoots(state: ActiveContextState, snapshot: ActiveContextSnapshot) {
  return orderedRoots(state, snapshot).filter(({ fold }) => !state.expanded.includes(fold.id));
}

export function persistenceProjection(state: ActiveContextState, snapshot: ActiveContextSnapshot): ActiveContextState {
  const byId = foldMap(state);
  const retained = new Set<string>();
  const retain = (fold: ActiveFold): void => {
    if (retained.has(fold.id)) return;
    retained.add(fold.id);
    for (const childId of childFoldIds(fold)) {
      const child = byId.get(childId);
      if (!child) throw new Error(`Missing active-context child ${childId}`);
      retain(child);
    }
  };
  for (const root of orderedRoots(state, snapshot)) retain(root.fold);
  const mapped = new Set(snapshot.branchObjects.map((item) => objectRefKey(item.ref)));
  const projected: ActiveContextState = {
    ...clone(state),
    folds: state.folds.filter((fold) => retained.has(fold.id)),
    expanded: state.expanded.filter((id) => retained.has(id)),
    protected: state.protected.filter((ref) => mapped.has(objectRefKey(ref))),
    leases: Object.fromEntries(Object.entries(state.leases)
      .filter(([id]) => retained.has(id))),
  };
  const survivingMarks = (state.pendingMarks ?? []).filter((mark) => mark.mark === "refold"
    ? retained.has(mark.id)
    : mark.parts.every((part) => part.kind === "raw"
      ? mapped.has(objectRefKey(part.ref))
      : retained.has(part.foldId)));
  if (survivingMarks.length) projected.pendingMarks = clone(survivingMarks);
  else delete projected.pendingMarks;
  delete projected.pinnedPeeks;
  const survivingBriefs = Object.entries(state.briefs ?? {}).filter(([id]) => retained.has(id));
  if (survivingBriefs.length) projected.briefs = Object.fromEntries(clone(survivingBriefs));
  else delete projected.briefs;
  if (projected.prepared && projected.prepared.sourceRefs.some((ref) => !mapped.has(objectRefKey(ref)))) {
    delete projected.prepared;
  }
  // The parse on the next line validates this forest, so `assignFoldParents` is the whole
  // job here; `deriveFoldParents` would walk it twice.
  projected.folds = assignFoldParents(projected.folds);
  return parseActiveContextState(projected, state.sessionId);
}

export function explicitProtectedKeys(state: ActiveContextState): Set<string> {
  return new Set(state.protected.map(objectRefKey));
}

/**
 * Held against folding: pinned by name, or unfoldable for validity (an unfinished turn, an
 * entry with no evidence ref). There used to be a second reading of this for tool spans,
 * differing only in which protected set it consulted; the two sets collapsed into one when
 * fresh-tail was deleted, and the two functions were byte-identical after that.
 */
export function refsProtected(
  refs: EvidenceRef[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): boolean {
  const explicit = explicitProtectedKeys(state);
  return refs.some((ref) => {
    const item = exactMapped(snapshot, ref);
    return !item || explicit.has(objectRefKey(ref)) || snapshot.protectedIndices.has(item.index);
  });
}

export function protectedStaleMass(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): { bytes: number; refs: number } {
  const explicit = explicitProtectedKeys(state);
  if (!explicit.size) return { bytes: 0, refs: 0 };
  let total = 0;
  let refs = 0;
  for (const item of snapshot.mapped) {
    if (!item.ref || !explicit.has(objectRefKey(item.ref))) continue;
    if (snapshot.protectedIndices.has(item.index)) continue;
    total += bytes(item.message);
    refs += 1;
  }
  return { bytes: total, refs };
}

export function explicitProtectedMass(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): { bytes: number; refs: number } {
  const explicit = explicitProtectedKeys(state);
  if (!explicit.size) return { bytes: 0, refs: 0 };
  let total = 0;
  let refs = 0;
  for (const item of snapshot.mapped) {
    if (!item.ref || !explicit.has(objectRefKey(item.ref))) continue;
    total += bytes(item.message);
    refs += 1;
  }
  return { bytes: total, refs };
}

export interface AdmissionVerdict {
  admitted: boolean;
  reason: "admitted" | "unmeasured" | "would-cross-fence";
  requestedTokens: number;
  headroomTokens: number | null;
  budgetTokens: number;
  affordableBytes: number;
}

export function admissionVerdict(input: {
  requestedBytes: number;
  capacity: CapacityAccounting;
  bytesPerToken: number;
}): AdmissionVerdict {
  const requestedTokens = Math.max(0, Math.ceil(input.requestedBytes / input.bytesPerToken));
  const { headroomTokens, budgetTokens } = input.capacity;
  if (headroomTokens === null) {
    return {
      admitted: true,
      reason: "unmeasured",
      requestedTokens,
      headroomTokens,
      budgetTokens,
      affordableBytes: input.requestedBytes,
    };
  }
  const affordableBytes = Math.max(0, headroomTokens) * input.bytesPerToken;
  return {
    admitted: requestedTokens <= headroomTokens,
    reason: requestedTokens <= headroomTokens ? "admitted" : "would-cross-fence",
    requestedTokens,
    headroomTokens,
    budgetTokens,
    affordableBytes,
  };
}

export function toolPayload(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

export function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return Number(value);
}

export function stringIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error("ids must contain 1-64 values");
  const ids = value.map((item) => String(item).trim());
  if (ids.some((id) => !id)) throw new Error("ids must be nonempty strings");
  return ids;
}

export interface NativeCompactionDecisionReceipt {
  version: 1;
  decisionKey: string;
  sessionId: string;
  triggerEntryId: string;
  reason: string;
  willRetry: boolean;
  failureCode: string;
  message: string;
  preparationError: string | null;
  boundaryFailure: string | null;
  selectionKind: string | null;
  selectionSourceIds: string[];
  automaticActionKind: string | null;
  providerMessageSha256: string | null;
  occurredAt: number;
}

export interface NativeCompactionCompletionReceipt {
  version: 2;
  receiptKey: string;
  sessionId: string;
  compactionEntryId: string;
  reason: string;
  willRetry: boolean;
  fromExtension: boolean;
  occurredAt: number;
  goal: "zero-native-compactions";
  decision: NativeCompactionDecisionReceipt;
}

export function boundedReceiptString(value: unknown, maximum = 1_200): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

export function boundReceiptText(value: unknown, maximum: number, fallback: string): string {
  const text = typeof value === "string" && value ? value : fallback;
  if (Buffer.byteLength(text, "utf8") <= maximum) return text;
  let output = "";
  for (const character of text) {
    if (Buffer.byteLength(output + character, "utf8") > maximum) break;
    output += character;
  }
  return output || fallback.slice(0, maximum);
}

export function parseNativeCompactionDecision(value: unknown, expectedSessionId?: string): NativeCompactionDecisionReceipt {
  const keys = [
    "version", "decisionKey", "sessionId", "triggerEntryId", "reason", "willRetry", "failureCode", "message",
    "preparationError", "boundaryFailure", "selectionKind", "selectionSourceIds",
    "automaticActionKind", "providerMessageSha256", "occurredAt",
  ];
  if (!exactRecord(value, keys) || ownValue(value, "version") !== 1 ||
      typeof ownValue(value, "decisionKey") !== "string" || !/^[a-f0-9]{64}$/.test(String(ownValue(value, "decisionKey"))) ||
      !boundedReceiptString(ownValue(value, "sessionId"), 512) ||
      !boundedReceiptString(ownValue(value, "triggerEntryId"), 512) ||
      (expectedSessionId && ownValue(value, "sessionId") !== expectedSessionId) ||
      !boundedReceiptString(ownValue(value, "reason"), 64) || !boundedReceiptString(ownValue(value, "failureCode"), 128) ||
      !boundedReceiptString(ownValue(value, "message")) || typeof ownValue(value, "willRetry") !== "boolean" ||
      !Number.isSafeInteger(ownValue(value, "occurredAt")) || Number(ownValue(value, "occurredAt")) < 0) {
    throw new Error("Invalid native compaction decision receipt");
  }
  for (const key of ["preparationError", "boundaryFailure", "selectionKind", "automaticActionKind"] as const) {
    const field = ownValue(value, key);
    if (field !== null && !boundedReceiptString(field, 1_200)) throw new Error(`Invalid native compaction decision ${key}`);
  }
  const providerMessageSha256 = ownValue(value, "providerMessageSha256");
  const sourceIds = denseOwnArrayValues(ownValue(value, "selectionSourceIds"));
  if ((providerMessageSha256 !== null && (typeof providerMessageSha256 !== "string" || !/^[a-f0-9]{64}$/.test(providerMessageSha256))) ||
      !sourceIds || sourceIds.length > 64 || sourceIds.some((id) => !boundedReceiptString(id, 512))) {
    throw new Error("Invalid native compaction decision evidence");
  }
  const sessionId = String(ownValue(value, "sessionId"));
  const triggerEntryId = String(ownValue(value, "triggerEntryId"));
  const reason = String(ownValue(value, "reason"));
  const failureCode = String(ownValue(value, "failureCode"));
  if (ownValue(value, "decisionKey") !== sha256Value({ sessionId, triggerEntryId, reason, failureCode })) {
    throw new Error("Native compaction decision identity drift");
  }
  return clone(value) as unknown as NativeCompactionDecisionReceipt;
}

export function parseNativeCompactionCompletion(value: unknown, expectedSessionId?: string): NativeCompactionCompletionReceipt {
  const keys = [
    "version", "receiptKey", "sessionId", "compactionEntryId", "reason", "willRetry",
    "fromExtension", "occurredAt", "goal", "decision",
  ];
  if (!exactRecord(value, keys) || ownValue(value, "version") !== 2 ||
      typeof ownValue(value, "receiptKey") !== "string" || !/^[a-f0-9]{64}$/.test(String(ownValue(value, "receiptKey"))) ||
      !boundedReceiptString(ownValue(value, "sessionId"), 512) ||
      (expectedSessionId && ownValue(value, "sessionId") !== expectedSessionId) ||
      !boundedReceiptString(ownValue(value, "compactionEntryId"), 512) ||
      !boundedReceiptString(ownValue(value, "reason"), 64) || typeof ownValue(value, "willRetry") !== "boolean" ||
      typeof ownValue(value, "fromExtension") !== "boolean" || !Number.isSafeInteger(ownValue(value, "occurredAt")) ||
      ownValue(value, "goal") !== "zero-native-compactions") {
    throw new Error("Invalid native compaction completion receipt");
  }
  const sessionId = String(ownValue(value, "sessionId"));
  const compactionEntryId = String(ownValue(value, "compactionEntryId"));
  const decision = parseNativeCompactionDecision(ownValue(value, "decision"), sessionId);
  if (ownValue(value, "receiptKey") !== sha256Value({ sessionId, compactionEntryId })) {
    throw new Error("Native compaction completion receipt identity drift");
  }
  return { ...(clone(value) as unknown as NativeCompactionCompletionReceipt), decision };
}
