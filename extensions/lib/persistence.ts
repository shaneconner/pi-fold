import type { EvidenceRef } from "../json.ts";
import {
  denseOwnArrayValues,
  isObjectRef,
  isPlainRecord,
  objectRefKey,
  sha256Value,
  stableStringify,
} from "../json.ts";
import {
  bytes,
  clone,
  emptyActiveContextState,
  exactRecord,
  ownValue,
  structurallyValidBrief,
} from "./canonical.ts";
import {
  ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
  ACTIVE_CONTEXT_POLICY,
  ACTIVE_CONTEXT_STATE_ENTRY,
  EXPAND_LEASE_GENERATIONS,
  MAX_EXPAND_LEASES,
  MAX_PENDING_MARKS,
  MEMORY_BODY_CHARS,
  MEMORY_KEY_CHARS,
  MEMORY_KEYS_MAX,
} from "./policy.ts";
import type {
  ActiveContextCheckpointV2,
  ActiveContextDeltaV2,
  ActiveContextState,
  ActiveContextStateWireV2,
  ActiveFold,
  AdvisoryMilestone,
  BriefOverride,
  BriefProvenance,
  ToolClip,
  WorkingMemoryEntry,
  FoldKind,
  FoldPart,
  FoldRecordEntry,
  FoldRecordRef,
  MarkOrigin,
  PendingMark,
  PreparedFold,
} from "./policy.ts";

export const ACTIVE_FOLD_KEYS = [
  "id", "kind", "parentId", "parts", "brief", "provenance", "sourceSha256",
  "sourceChars", "placeholderChars", "createdAt",
] as const;
export const PREPARED_FOLD_KEYS = [
  "id", "sessionId", "generation", "branchSha256", "topologySha256", "protectionSha256",
  "sourceRefs", "sourceSha256", "beforeRefs", "beforeSha256", "afterRefs", "afterSha256", "fold",
] as const;
export const ACTIVE_STATE_KEYS = ["version", "sessionId", "revision", "folds", "expanded", "protected"] as const;
export const FOLD_RECORD_REF_KEYS = ["id", "sha256"] as const;
export const FOLD_RECORD_ENTRY_KEYS = ["version", "sessionId", "foldId", "recordSha256", "fold"] as const;
export const PENDING_FOLD_MARK_KEYS = [
  "mark", "id", "kind", "parts", "brief", "briefProvenance", "origin", "ordinal",
] as const;
export const PENDING_REFOLD_MARK_KEYS = ["mark", "id", "origin", "ordinal"] as const;
export const MARK_ORIGINS = Object.freeze(["agent", "ladder", "user"] as const);
export const STATE_CHECKPOINT_V2_KEYS = [
  "version", "kind", "sessionId", "revision", "foldRefs", "expanded", "protected", "prepared", "stateSha256",
] as const;
export const STATE_DELTA_V2_KEYS = [
  "version", "kind", "sessionId", "revision", "baseRevision", "baseStateSha256", "addFoldRefs",
  "removeFoldIds", "expanded", "protected", "prepared", "stateSha256",
] as const;
export const MAX_ACTIVE_FOLD_RECORD_BYTES = 256 * 1024;
export const MAX_ACTIVE_STATE_EVENT_BYTES = 512 * 1024;
export const MAX_ACTIVE_FOLD_RECORDS = 4_096;
export const MAX_ACTIVE_FOLD_PARTS = 1_024;
export const MAX_ACTIVE_EXPANDED = 1_024;
export const MAX_ACTIVE_PROTECTED = 1_024;

export function validTokensSinceToolFold(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function pendingMarkKey(mark: Pick<PendingMark, "mark" | "id">): string {
  return `${mark.mark}:${mark.id}`;
}

export function validPendingMark(value: unknown): value is PendingMark {
  const id = ownValue(value, "id");
  const ordinal = ownValue(value, "ordinal");
  if (typeof id !== "string" || !id ||
      !MARK_ORIGINS.includes(ownValue(value, "origin") as MarkOrigin) ||
      !Number.isSafeInteger(ordinal) || Number(ordinal) < 0) return false;
  const mark = ownValue(value, "mark");
  if (mark === "refold") return exactRecord(value, PENDING_REFOLD_MARK_KEYS);
  if (mark !== "fold" || !exactRecord(value, PENDING_FOLD_MARK_KEYS)) return false;
  const kind = ownValue(value, "kind");
  const parts = denseOwnArrayValues(ownValue(value, "parts"));
  return (kind === "tool-result" || kind === "chapter" || kind === "consolidation") &&
    Boolean(parts?.length) && parts!.every(validFoldPart) && structurallyValidBrief(ownValue(value, "brief")) &&
    validProvenance(ownValue(value, "briefProvenance")) &&
    id === foldIdFor(kind as FoldKind, parts as FoldPart[]);
}

export function briefOverrideText(override: unknown): string | null {
  if (typeof override === "string") return override;
  const brief = ownValue(override, "brief");
  return typeof brief === "string" ? brief : null;
}

export function parseBriefOverrides(
  value: unknown,
  ids?: ReadonlySet<string>,
): Record<string, BriefOverride> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid active-context brief overrides");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const validOverride = (override: unknown): boolean => {
    const brief = briefOverrideText(override);
    if (typeof brief !== "string" || !brief.trim() ||
        brief.length > ACTIVE_CONTEXT_POLICY.maxBriefChars) return false;
    if (typeof override === "string") return true;
    return exactRecord(override, ["brief", "provenance"]) &&
      validProvenance(ownValue(override, "provenance"));
  };
  if (entries.length > MAX_ACTIVE_FOLD_RECORDS ||
      entries.some(([id, override]) => !id || !validOverride(override) || (ids && !ids.has(id)))) {
    throw new Error("Invalid active-context brief overrides");
  }
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, BriefOverride>;
}

export function foldBrief(
  fold: Pick<ActiveFold, "id" | "brief">,
  state: Pick<ActiveContextState, "briefs">,
): string {
  return briefOverrideText(state.briefs?.[fold.id]) ?? fold.brief;
}

export function foldProvenance(
  fold: Pick<ActiveFold, "id" | "provenance">,
  state: Pick<ActiveContextState, "briefs">,
): BriefProvenance {
  const override = state.briefs?.[fold.id];
  const provenance = typeof override === "object" && override
    ? ownValue(override, "provenance")
    : undefined;
  return normalizeLegacyProvenance(provenance ?? fold.provenance);
}

export function parsePendingMarks(value: unknown): PendingMark[] {
  const marks = denseOwnArrayValues(value);
  if (!marks || marks.length > MAX_PENDING_MARKS || !marks.every(validPendingMark) ||
      new Set((marks as PendingMark[]).map(pendingMarkKey)).size !== marks.length) {
    throw new Error("Invalid active-context pending marks");
  }
  return clone(marks) as PendingMark[];
}

export function parseLeases(value: unknown, foldIds?: ReadonlySet<string>): Record<string, number> {
  if (!isPlainRecord(value)) throw new Error("Invalid active-context expand leases");
  const entries = Object.entries(value);
  if (entries.length > MAX_EXPAND_LEASES || entries.some(([id, remaining]) =>
    !id || (foldIds && !foldIds.has(id)) || !Number.isSafeInteger(remaining) ||
    Number(remaining) < 1 || Number(remaining) > EXPAND_LEASE_GENERATIONS)) {
    throw new Error("Invalid active-context expand leases");
  }
  return Object.fromEntries(entries.map(([id, remaining]) => [id, Number(remaining)]));
}

export function validProvenance(value: unknown): value is BriefProvenance {
  if (exactRecord(value, ["kind"]) &&
      (ownValue(value, "kind") === "supplied" || ownValue(value, "kind") === "deterministic" ||
       ownValue(value, "kind") === "augmented")) return true;
  const hasDigest = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "launchContractDigest"));
  if (!exactRecord(value, ["kind", "provider", "model", "effort", ...(hasDigest ? ["launchContractDigest"] : [])]) ||
      (ownValue(value, "kind") !== "model" && ownValue(value, "kind") !== "luna") ||
      typeof ownValue(value, "provider") !== "string" || !ownValue(value, "provider") ||
      typeof ownValue(value, "model") !== "string" || !ownValue(value, "model") ||
      typeof ownValue(value, "effort") !== "string" || !ownValue(value, "effort")) return false;
  return !hasDigest || (typeof ownValue(value, "launchContractDigest") === "string" &&
    /^[a-f0-9]{64}$/.test(String(ownValue(value, "launchContractDigest"))));
}

export function normalizeLegacyProvenance(provenance: unknown): BriefProvenance {
  if (ownValue(provenance, "kind") !== "luna") return clone(provenance) as BriefProvenance;
  return {
    kind: "model",
    provider: String(ownValue(provenance, "provider")),
    model: String(ownValue(provenance, "model")),
    effort: String(ownValue(provenance, "effort")),
    ...(typeof ownValue(provenance, "launchContractDigest") === "string"
      ? { launchContractDigest: String(ownValue(provenance, "launchContractDigest")) }
      : {}),
  };
}

export function validFoldPart(value: unknown): value is FoldPart {
  if (exactRecord(value, ["kind", "ref"]) && ownValue(value, "kind") === "raw") {
    return isObjectRef(ownValue(value, "ref"));
  }
  return exactRecord(value, ["kind", "foldId"]) && ownValue(value, "kind") === "fold" &&
    typeof ownValue(value, "foldId") === "string" && Boolean(ownValue(value, "foldId"));
}

export function validFoldShape(value: unknown): value is ActiveFold {
  if (!exactRecord(value, ACTIVE_FOLD_KEYS)) return false;
  const kind = ownValue(value, "kind");
  const parts = denseOwnArrayValues(ownValue(value, "parts"));
  const parentId = ownValue(value, "parentId");
  const sourceSha256 = ownValue(value, "sourceSha256");
  return (kind === "tool-result" || kind === "chapter" || kind === "consolidation") &&
    typeof ownValue(value, "id") === "string" && Boolean(ownValue(value, "id")) &&
    (parentId === null || typeof parentId === "string") && Boolean(parts?.length) &&
    parts!.every(validFoldPart) && structurallyValidBrief(ownValue(value, "brief")) &&
    validProvenance(ownValue(value, "provenance")) && typeof sourceSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sourceSha256) && Number.isSafeInteger(ownValue(value, "sourceChars")) &&
    Number(ownValue(value, "sourceChars")) > 0 && Number.isSafeInteger(ownValue(value, "placeholderChars")) &&
    Number(ownValue(value, "placeholderChars")) > 0 && Number.isSafeInteger(ownValue(value, "createdAt")) &&
    Number(ownValue(value, "createdAt")) >= 0;
}

export function normalizedPart(part: FoldPart): unknown {
  return part.kind === "fold"
    ? { kind: "fold", foldId: part.foldId }
    : { kind: "raw", ref: { ...part.ref } };
}

export function foldIdFor(kind: FoldKind, parts: FoldPart[]): string {
  return `fold_${sha256Value({ kind, parts: parts.map(normalizedPart) }).slice(0, 24)}`;
}

export function foldMap(state: Pick<ActiveContextState, "folds">): Map<string, ActiveFold> {
  return new Map(state.folds.map((fold) => [fold.id, fold]));
}

export function childFoldIds(fold: Pick<ActiveFold, "parts">): string[] {
  return fold.parts.filter((part): part is Extract<FoldPart, { kind: "fold" }> => part.kind === "fold")
    .map((part) => part.foldId);
}

export function flattenFoldRefs(fold: ActiveFold, state: Pick<ActiveContextState, "folds">): EvidenceRef[] {
  const byId = foldMap(state);
  const visiting = new Set<string>();
  const visit = (current: ActiveFold): EvidenceRef[] => {
    if (visiting.has(current.id)) throw new Error(`Active-context fold cycle at ${current.id}`);
    visiting.add(current.id);
    const refs = current.parts.flatMap((part) => {
      if (part.kind === "raw") return [part.ref];
      const child = byId.get(part.foldId);
      if (!child) throw new Error(`Missing active-context child ${part.foldId}`);
      return visit(child);
    });
    visiting.delete(current.id);
    return refs;
  };
  return visit(fold);
}

export function directFoldOwners(folds: readonly ActiveFold[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const fold of folds) {
    for (const part of fold.parts) {
      if (part.kind !== "raw") continue;
      const key = objectRefKey(part.ref);
      if (owner.has(key)) throw new Error(`Evidence ${part.ref.entryId} has multiple direct fold owners`);
      owner.set(key, fold.id);
    }
  }
  return owner;
}

export function validateFoldForest(folds: ActiveFold[]): ActiveFold[] {
  const rawValues = denseOwnArrayValues(folds);
  if (!rawValues || rawValues.some((fold) => !validFoldShape(fold))) {
    throw new Error("Invalid active-context fold forest shape");
  }
  const values = clone(rawValues) as ActiveFold[];
  const byId = new Map<string, ActiveFold>();
  for (const fold of values) {
    if (fold.id !== foldIdFor(fold.kind, fold.parts) || byId.has(fold.id)) {
      throw new Error("Invalid active-context fold");
    }
    if (fold.kind === "tool-result" &&
        (!fold.parts.length || fold.parts.some((part) => part.kind !== "raw" || part.ref.role !== "toolResult"))) {
      throw new Error("Tool-result fold must own one validated assistant batch of tool results");
    }
    if (fold.kind === "consolidation" && !fold.parts.some((part) => part.kind === "fold")) {
      throw new Error("Consolidation folds must contain at least one child fold");
    }
    byId.set(fold.id, fold);
  }
  directFoldOwners(values);
  const parent = new Map<string, string>();
  for (const fold of values) {
    for (const part of fold.parts) {
      if (part.kind === "fold") {
        if (!byId.has(part.foldId) || part.foldId === fold.id || parent.has(part.foldId)) {
          throw new Error(`Invalid or multiply owned child fold ${part.foldId}`);
        }
        parent.set(part.foldId, fold.id);
      }
    }
  }
  for (const fold of values) {
    if ((parent.get(fold.id) ?? null) !== fold.parentId) throw new Error(`Fold ${fold.id} parent drift`);
  }
  for (const fold of values) {
    const refs = flattenFoldRefs(fold, { folds: values });
    if (fold.sourceSha256 !== sha256Value(refs)) throw new Error(`Fold ${fold.id} source digest drift`);
  }
  return values;
}

export function parseActiveContextState(
  value: unknown,
  sessionId: string,
  defaultAdvisory = true,
): ActiveContextState {
  const recordLike = Boolean(value && typeof value === "object" && !Array.isArray(value));
  const hasPrepared = recordLike && Object.prototype.hasOwnProperty.call(value, "prepared");
  const hasAdvisory = recordLike && Object.prototype.hasOwnProperty.call(value, "advisory");
  const hasTokensSinceToolFold = recordLike &&
    Object.prototype.hasOwnProperty.call(value, "tokensSinceToolFold");
  const hasLeases = recordLike && Object.prototype.hasOwnProperty.call(value, "leases");
  const hasPendingMarks = recordLike && Object.prototype.hasOwnProperty.call(value, "pendingMarks");
  const hasPinnedPeeks = recordLike && Object.prototype.hasOwnProperty.call(value, "pinnedPeeks");
  const hasBriefs = recordLike && Object.prototype.hasOwnProperty.call(value, "briefs");
  const hasClips = recordLike && Object.prototype.hasOwnProperty.call(value, "clips");
  const hasMemory = recordLike && Object.prototype.hasOwnProperty.call(value, "memory");
  // Read and dropped, never stored: see legacyRiderStateSha256. A v1 state has no digest
  // to reproduce, so here the tolerance is the whole of it.
  const hasLegacyRider = recordLike && Object.prototype.hasOwnProperty.call(value, "rider");
  refuseRetiredStateFields(value);
  const extraKeys = [
    ...(hasPrepared ? ["prepared"] : []),
    ...(hasAdvisory ? ["advisory"] : []),
    ...(hasTokensSinceToolFold ? ["tokensSinceToolFold"] : []),
    ...(hasLeases ? ["leases"] : []),
    ...(hasPendingMarks ? ["pendingMarks"] : []),
    ...(hasPinnedPeeks ? ["pinnedPeeks"] : []),
    ...(hasBriefs ? ["briefs"] : []),
    ...(hasClips ? ["clips"] : []),
    ...(hasMemory ? ["memory"] : []),
    ...(hasLegacyRider ? ["rider"] : []),
  ];
  if (!exactRecord(value, [...ACTIVE_STATE_KEYS, ...extraKeys])) throw new Error("Invalid active-context state keys");
  const folds = denseOwnArrayValues(ownValue(value, "folds"));
  const expanded = denseOwnArrayValues(ownValue(value, "expanded"));
  const protectedRefs = denseOwnArrayValues(ownValue(value, "protected"));
  if (ownValue(value, "version") !== 1 || ownValue(value, "sessionId") !== sessionId ||
      !Number.isSafeInteger(ownValue(value, "revision")) || Number(ownValue(value, "revision")) < 0 ||
      !folds || !expanded || !protectedRefs || expanded.some((id) => typeof id !== "string") ||
      protectedRefs.some((ref) => !isObjectRef(ref))) throw new Error("Invalid active-context state");
  const validatedFolds = validateFoldForest(folds as ActiveFold[]);
  const ids = new Set(validatedFolds.map((fold) => fold.id));
  if (new Set(expanded).size !== expanded.length || expanded.some((id) => !ids.has(String(id)))) {
    throw new Error("Invalid active-context expanded set");
  }
  if (new Set((protectedRefs as EvidenceRef[]).map(objectRefKey)).size !== protectedRefs.length) {
    throw new Error("Invalid active-context protection set");
  }
  if (hasPrepared) validatePreparedShape(ownValue(value, "prepared"));
  if (hasAdvisory && !validAdvisoryState(ownValue(value, "advisory"))) {
    throw new Error("Invalid active-context advisory state");
  }
  if (hasTokensSinceToolFold && !validTokensSinceToolFold(ownValue(value, "tokensSinceToolFold"))) {
    throw new Error("Invalid active-context tool-fold cadence");
  }
  const leases = hasLeases ? parseLeases(ownValue(value, "leases"), ids) : {};
  const marks = hasPendingMarks ? parsePendingMarks(ownValue(value, "pendingMarks")) : [];
  if (marks.some((mark) => mark.mark === "refold" && !ids.has(mark.id))) {
    throw new Error("Invalid active-context pending marks");
  }
  const briefs = hasBriefs ? parseBriefOverrides(ownValue(value, "briefs"), ids) : {};
  const clips = hasClips ? parseToolClips(ownValue(value, "clips")) : [];
  const memory = hasMemory ? parseWorkingMemory(ownValue(value, "memory")) : [];
  const source = clone(value) as unknown as ActiveContextState;
  return {
    version: 1,
    sessionId: source.sessionId,
    revision: source.revision,
    folds: validatedFolds,
    expanded: clone(source.expanded),
    protected: clone(source.protected),
    tokensSinceToolFold: hasTokensSinceToolFold
      ? Number(ownValue(value, "tokensSinceToolFold"))
      : 0,
    leases,
    ...(marks.length ? { pendingMarks: marks } : {}),
    ...(Object.keys(briefs).length ? { briefs } : {}),
    ...(clips.length ? { clips } : {}),
    ...(memory.length ? { memory } : {}),
    ...(hasAdvisory
      ? { advisory: clone(source.advisory!) }
      : defaultAdvisory ? { advisory: { highWater: 0, delivered: {} } } : {}),
    ...(hasPrepared ? { prepared: clone(source.prepared!) } : {}),
  };
}

function parseToolClips(value: unknown): ToolClip[] {
  const entries = denseOwnArrayValues(value);
  if (!entries) throw new Error("Invalid active-context clips");
  const clips = entries.map((entry) => {
    if (!exactRecord(entry, ["callId", "entryId"]) ||
        typeof ownValue(entry, "callId") !== "string" || !ownValue(entry, "callId") ||
        typeof ownValue(entry, "entryId") !== "string" || !ownValue(entry, "entryId")) {
      throw new Error("Invalid active-context clip entry");
    }
    return { callId: String(ownValue(entry, "callId")), entryId: String(ownValue(entry, "entryId")) };
  });
  if (new Set(clips.map((clip) => clip.callId)).size !== clips.length) {
    throw new Error("Invalid active-context clips: duplicate call id");
  }
  return clips;
}

function parseWorkingMemory(value: unknown): WorkingMemoryEntry[] {
  const entries = denseOwnArrayValues(value);
  if (!entries) throw new Error("Invalid active-context working memory");
  const memory = entries.map((entry) => {
    const key = ownValue(entry, "key");
    const body = ownValue(entry, "body");
    const ordinal = ownValue(entry, "ordinal");
    if (!exactRecord(entry, ["key", "body", "ordinal"]) ||
        typeof key !== "string" || !key || key.length > MEMORY_KEY_CHARS ||
        typeof body !== "string" || !body || body.length > MEMORY_BODY_CHARS ||
        !Number.isSafeInteger(ordinal) || Number(ordinal) < 0) {
      throw new Error("Invalid active-context working-memory entry");
    }
    return { key, body, ordinal: Number(ordinal) };
  });
  if (memory.length > MEMORY_KEYS_MAX) {
    throw new Error(`Invalid active-context working memory: over ${MEMORY_KEYS_MAX} entries`);
  }
  if (new Set(memory.map((entry) => entry.key)).size !== memory.length) {
    throw new Error("Invalid active-context working memory: duplicate key");
  }
  return memory;
}

export function clearPrepared(state: ActiveContextState): ActiveContextState {
  const next = { ...state };
  delete next.prepared;
  return next;
}

export function validatePreparedShape(value: unknown): asserts value is PreparedFold {
  if (!exactRecord(value, PREPARED_FOLD_KEYS)) throw new Error("Invalid prepared active-context fold keys");
  const prepared = value as unknown as PreparedFold;
  const sourceRefs = denseOwnArrayValues(ownValue(value, "sourceRefs"));
  const beforeRefs = denseOwnArrayValues(ownValue(value, "beforeRefs"));
  const afterRefs = denseOwnArrayValues(ownValue(value, "afterRefs"));
  if (typeof prepared.id !== "string" || !prepared.id || !validFoldShape(prepared.fold) ||
      prepared.id !== prepared.fold.id || prepared.fold.parentId !== null || !prepared.sessionId ||
      !Number.isSafeInteger(prepared.generation) || prepared.generation < 0 ||
      ![prepared.branchSha256, prepared.topologySha256, prepared.protectionSha256, prepared.sourceSha256,
        prepared.beforeSha256, prepared.afterSha256].every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
      !sourceRefs?.length || !beforeRefs || !afterRefs ||
      [...sourceRefs, ...beforeRefs, ...afterRefs].some((ref) => !isObjectRef(ref)) ||
      prepared.fold.id !== foldIdFor(prepared.fold.kind, prepared.fold.parts) ||
      prepared.fold.sourceSha256 !== sha256Value(sourceRefs)) {
    throw new Error("Invalid prepared active-context fold");
  }
}

export function canonicalFoldRecord(fold: ActiveFold): ActiveFold {
  return { ...clone(fold), parentId: null };
}

export function sameFoldRecordIdentity(left: ActiveFold, right: ActiveFold): boolean {
  return sha256Value({ ...canonicalFoldRecord(left), createdAt: 0 }) ===
    sha256Value({ ...canonicalFoldRecord(right), createdAt: 0 });
}

export function foldRecordRef(fold: ActiveFold): FoldRecordRef {
  const canonical = canonicalFoldRecord(fold);
  return { id: canonical.id, sha256: sha256Value(canonical) };
}

export function semanticStateSha256(state: ActiveContextState): string {
  return sha256Value(state);
}

export function legacyCadenceOmittedStateSha256(state: ActiveContextState): string {
  const legacy = clone(state) as Partial<ActiveContextState>;
  if (legacy.tokensSinceToolFold === 0) delete legacy.tokensSinceToolFold;
  if (legacy.leases && Object.keys(legacy.leases).length === 0) delete legacy.leases;
  return sha256Value(legacy);
}

/**
 * THE DIGEST A RIDER-ERA BUILD WROTE, reproduced without the subsystem.
 *
 * `semanticStateSha256` hashes the materialized state object, and `stableStringify` walks
 * own keys in INSERTION order, so a field that is gone changes the digest even though it
 * changed nothing else. The rider sat immediately before `prepared` in the materialized
 * literal, and last when there was no prepared, so that is where it goes back for the one
 * moment it is needed. It joins the two legacy derivations already here, which exist for
 * exactly this reason: a state stays verifiable across the build that stopped writing it.
 *
 * Consulted ONLY when the wire actually carried a rider, so a current state whose digest
 * has genuinely drifted still fails rather than finding a second way to pass.
 */
export function legacyRiderStateSha256(state: ActiveContextState, rider: unknown): string {
  const legacy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === "prepared") legacy.rider = rider;
    legacy[key] = value;
  }
  if (!Object.prototype.hasOwnProperty.call(legacy, "rider")) legacy.rider = rider;
  return sha256Value(legacy);
}

export function legacyReplayOrderStateSha256(state: ActiveContextState): string {
  return sha256Value({
    version: state.version,
    sessionId: state.sessionId,
    revision: state.revision,
    folds: state.folds,
    expanded: state.expanded,
    protected: state.protected,
    ...(state.prepared ? { prepared: state.prepared } : {}),
    ...(state.advisory ? { advisory: state.advisory } : {}),
  });
}

export function sameStateProjection(left: ActiveContextState, right: ActiveContextState): boolean {
  const normalized = (value: ActiveContextState): Partial<ActiveContextState> => {
    const normalizedState = { ...clone(value), revision: 0 } as Partial<ActiveContextState>;
    if (normalizedState.tokensSinceToolFold === 0) delete normalizedState.tokensSinceToolFold;
    if (normalizedState.leases && Object.keys(normalizedState.leases).length === 0) delete normalizedState.leases;
    if (normalizedState.pendingMarks && normalizedState.pendingMarks.length === 0) delete normalizedState.pendingMarks;
    if (normalizedState.briefs && !Object.keys(normalizedState.briefs).length) delete normalizedState.briefs;
    if (normalizedState.clips && normalizedState.clips.length === 0) delete normalizedState.clips;
    if (normalizedState.memory && normalizedState.memory.length === 0) delete normalizedState.memory;
    return normalizedState;
  };
  return stableStringify(normalized(left)) === stableStringify(normalized(right));
}

export function parseFoldRecordRef(value: unknown): FoldRecordRef {
  if (!exactRecord(value, FOLD_RECORD_REF_KEYS) ||
      typeof ownValue(value, "id") !== "string" || !ownValue(value, "id") ||
      typeof ownValue(value, "sha256") !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(ownValue(value, "sha256")))) {
    throw new Error("Invalid active-context fold record reference");
  }
  return clone(value) as unknown as FoldRecordRef;
}

export function parseFoldRecordEntry(value: unknown, sessionId: string): FoldRecordEntry {
  if (!exactRecord(value, FOLD_RECORD_ENTRY_KEYS) || ownValue(value, "version") !== 1 ||
      ownValue(value, "sessionId") !== sessionId || typeof ownValue(value, "foldId") !== "string" ||
      typeof ownValue(value, "recordSha256") !== "string") {
    throw new Error("Invalid active-context fold record");
  }
  const foldValue = ownValue(value, "fold");
  if (!validFoldShape(foldValue)) throw new Error("Invalid active-context fold record payload");
  const fold = clone(foldValue);
  if (fold.parentId !== null || fold.parts.length > MAX_ACTIVE_FOLD_PARTS || fold.id !== ownValue(value, "foldId") ||
      fold.id !== foldIdFor(fold.kind, fold.parts) || sha256Value(fold) !== ownValue(value, "recordSha256")) {
    throw new Error("Active-context fold record identity drift");
  }
  const record = clone(value) as unknown as FoldRecordEntry;
  if (bytes(record) > MAX_ACTIVE_FOLD_RECORD_BYTES) throw new Error("Active-context fold record exceeds wire limit");
  return record;
}

export function validateV2ProjectionFields(
  expandedValue: unknown,
  protectedValue: unknown,
  preparedValue: unknown,
  advisoryValue: unknown,
  tokensSinceToolFoldValue: unknown,
  leasesValue: unknown,
  pendingMarksValue?: unknown,
  briefsValue?: unknown,
): {
  expanded: string[];
  protected: EvidenceRef[];
  prepared?: PreparedFold;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  tokensSinceToolFold: number;
  leases: Record<string, number>;
  pendingMarks: PendingMark[];
  briefs: Record<string, string>;
} {
  const expanded = denseOwnArrayValues(expandedValue);
  const protectedRefs = denseOwnArrayValues(protectedValue);
  if (!expanded || expanded.length > MAX_ACTIVE_EXPANDED || expanded.some((id) => typeof id !== "string" || !id) ||
      new Set(expanded).size !== expanded.length || !protectedRefs || protectedRefs.length > MAX_ACTIVE_PROTECTED ||
      protectedRefs.some((ref) => !isObjectRef(ref)) ||
      new Set((protectedRefs as EvidenceRef[]).map(objectRefKey)).size !== protectedRefs.length) {
    throw new Error("Invalid active-context v2 projection fields");
  }
  if (preparedValue !== null) validatePreparedShape(preparedValue);
  if (advisoryValue !== undefined && !validAdvisoryState(advisoryValue)) {
    throw new Error("Invalid active-context v2 advisory state");
  }
  if (tokensSinceToolFoldValue !== undefined && !validTokensSinceToolFold(tokensSinceToolFoldValue)) {
    throw new Error("Invalid active-context v2 tool-fold cadence");
  }
  const leases = leasesValue === undefined ? {} : parseLeases(leasesValue);
  const pendingMarks = pendingMarksValue === undefined ? [] : parsePendingMarks(pendingMarksValue);
  const briefs = briefsValue === undefined ? {} : parseBriefOverrides(briefsValue);
  return {
    expanded: clone(expanded) as string[],
    protected: clone(protectedRefs) as EvidenceRef[],
    ...(preparedValue === null ? {} : { prepared: clone(preparedValue) as PreparedFold }),
    ...(advisoryValue === undefined ? {} : {
      advisory: clone(advisoryValue) as NonNullable<ActiveContextState["advisory"]>,
    }),
    tokensSinceToolFold: tokensSinceToolFoldValue === undefined ? 0 : Number(tokensSinceToolFoldValue),
    leases,
    pendingMarks,
    briefs,
  };
}

export function parseActiveContextStateV2(value: unknown, sessionId: string): ActiveContextStateWireV2 {
  const kind = ownValue(value, "kind");
  const hasAdvisory = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "advisory"));
  const hasTokensSinceToolFold = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "tokensSinceToolFold"));
  const hasLeases = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "leases"));
  const hasPendingMarks = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "pendingMarks"));
  const hasAddPendingMarks = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "addPendingMarks"));
  const hasPendingMarkOrder = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "pendingMarkOrder"));
  const hasPinnedPeeks = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "pinnedPeeks"));
  const hasBriefs = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "briefs"));
  const hasAddBriefs = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "addBriefs"));
  const hasRemoveBriefIds = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "removeBriefIds"));
  const hasWireClips = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "clips"));
  const hasClipBase = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "clipBase"));
  const hasAddClips = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "addClips"));
  const hasWireMemory = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "memory"));
  const hasLegacyRider = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "rider"));
  refuseRetiredStateFields(value);
  const optionalKeys = [
    ...(hasAdvisory ? ["advisory"] : []),
    ...(hasTokensSinceToolFold ? ["tokensSinceToolFold"] : []),
    ...(hasLeases ? ["leases"] : []),
    ...(hasPendingMarks ? ["pendingMarks"] : []),
    ...(hasAddPendingMarks ? ["addPendingMarks"] : []),
    ...(hasPendingMarkOrder ? ["pendingMarkOrder"] : []),
    ...(hasPinnedPeeks ? ["pinnedPeeks"] : []),
    ...(hasBriefs ? ["briefs"] : []),
    ...(hasAddBriefs ? ["addBriefs"] : []),
    ...(hasRemoveBriefIds ? ["removeBriefIds"] : []),
    ...(hasWireClips ? ["clips"] : []),
    ...(hasClipBase ? ["clipBase"] : []),
    ...(hasAddClips ? ["addClips"] : []),
    ...(hasWireMemory ? ["memory"] : []),
    // Carried no further than the digest check in `materializeStatePersistence`, which is
    // the only thing on a load that the rider's absence can change.
    ...(hasLegacyRider ? ["rider"] : []),
  ];
  const checkpoint = kind === "checkpoint" &&
    exactRecord(value, [...STATE_CHECKPOINT_V2_KEYS, ...optionalKeys]);
  const delta = kind === "delta" &&
    exactRecord(value, [...STATE_DELTA_V2_KEYS, ...optionalKeys]);
  if ((!checkpoint && !delta) || ownValue(value, "version") !== 2 || ownValue(value, "sessionId") !== sessionId ||
      !Number.isSafeInteger(ownValue(value, "revision")) || Number(ownValue(value, "revision")) < 0 ||
      typeof ownValue(value, "stateSha256") !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(ownValue(value, "stateSha256")))) {
    throw new Error("Invalid active-context v2 state");
  }
  validateV2ProjectionFields(
    ownValue(value, "expanded"), ownValue(value, "protected"), ownValue(value, "prepared"),
    ownValue(value, "advisory"), ownValue(value, "tokensSinceToolFold"), ownValue(value, "leases"),
    ownValue(value, "pendingMarks"), ownValue(value, "briefs"),
  );
  if (hasWireClips) parseToolClips(ownValue(value, "clips"));
  if (hasAddClips) parseToolClips(ownValue(value, "addClips"));
  if (hasWireMemory) parseWorkingMemory(ownValue(value, "memory"));
  if (hasClipBase) {
    const base = ownValue(value, "clipBase");
    if (!Number.isSafeInteger(base) || Number(base) < 0) throw new Error("Invalid active-context clip base");
  }
  // A whole array and a change cannot both be the truth on one wire.
  if (hasWireClips && (hasClipBase || hasAddClips)) {
    throw new Error("Invalid active-context clips: whole array beside a change");
  }
  if (hasAddClips && !hasClipBase) throw new Error("Invalid active-context clips: change without a base");
  if (checkpoint) {
    const refs = denseOwnArrayValues(ownValue(value, "foldRefs"));
    if (!refs || refs.length > MAX_ACTIVE_FOLD_RECORDS) throw new Error("Invalid active-context checkpoint refs");
    const parsed = refs.map(parseFoldRecordRef);
    if (new Set(parsed.map((ref) => ref.id)).size !== parsed.length) {
      throw new Error("Duplicate active-context checkpoint ref");
    }
  } else {
    if (!Number.isSafeInteger(ownValue(value, "baseRevision")) || Number(ownValue(value, "baseRevision")) < 0 ||
        typeof ownValue(value, "baseStateSha256") !== "string" ||
        !/^[a-f0-9]{64}$/.test(String(ownValue(value, "baseStateSha256")))) {
      throw new Error("Invalid active-context delta base");
    }
    const addRefs = denseOwnArrayValues(ownValue(value, "addFoldRefs"));
    const removeIds = denseOwnArrayValues(ownValue(value, "removeFoldIds"));
    if (!addRefs || addRefs.length > MAX_ACTIVE_FOLD_RECORDS || !removeIds ||
        removeIds.length > MAX_ACTIVE_FOLD_RECORDS || removeIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Invalid active-context delta changes");
    }
    const parsed = addRefs.map(parseFoldRecordRef);
    if (new Set(parsed.map((ref) => ref.id)).size !== parsed.length || new Set(removeIds).size !== removeIds.length) {
      throw new Error("Duplicate active-context delta change");
    }
    if (hasAddBriefs) parseBriefOverrides(ownValue(value, "addBriefs"));
    if (hasRemoveBriefIds) {
      const removeBriefs = denseOwnArrayValues(ownValue(value, "removeBriefIds"));
      if (!removeBriefs || removeBriefs.length > MAX_ACTIVE_FOLD_RECORDS ||
          removeBriefs.some((id) => typeof id !== "string" || !id) ||
          new Set(removeBriefs).size !== removeBriefs.length) {
        throw new Error("Invalid active-context delta brief removals");
      }
    }
    if (hasBriefs && (hasAddBriefs || hasRemoveBriefIds)) {
      throw new Error("Active-context delta states the whole brief map and a change to it");
    }
    if (hasAddPendingMarks) parsePendingMarks(ownValue(value, "addPendingMarks"));
    if (hasPendingMarkOrder) {
      const order = denseOwnArrayValues(ownValue(value, "pendingMarkOrder"));
      if (!order || order.length > MAX_PENDING_MARKS ||
          order.some((key) => typeof key !== "string" || !key) ||
          new Set(order).size !== order.length) {
        throw new Error("Invalid active-context delta pending mark order");
      }
    }
    // The order is what the replay is BUILT from, so additions without it name marks
    // nothing will place. Refused rather than absorbed, because absorbing it would drop
    // the marks silently and a dropped mark is evidence that never gets folded.
    if (hasAddPendingMarks && !hasPendingMarkOrder) {
      throw new Error("Active-context delta adds pending marks and states no order for them");
    }
    if (hasPendingMarks && (hasAddPendingMarks || hasPendingMarkOrder)) {
      throw new Error("Active-context delta states the whole mark array and a change to it");
    }
  }
  const parsed = clone(value) as unknown as ActiveContextStateWireV2;
  if (bytes(parsed) > MAX_ACTIVE_STATE_EVENT_BYTES) throw new Error("Active-context state event exceeds wire limit");
  return parsed;
}

export function normalizeFoldsForPersistedRecords(
  folds: ActiveFold[],
  records: Map<string, FoldRecordEntry>,
): ActiveFold[] {
  const normalized = folds.map((fold) => {
    const record = records.get(fold.id);
    if (!record) return clone(fold);
    if (!sameFoldRecordIdentity(fold, record.fold)) {
      throw new Error(`Conflicting durable active-context fold ${fold.id}`);
    }
    return { ...clone(record.fold), parentId: fold.parentId };
  });
  return deriveFoldParents(normalized);
}

export function deriveFoldParents(records: ActiveFold[]): ActiveFold[] {
  const folds = records.map(canonicalFoldRecord);
  const byId = new Map(folds.map((fold) => [fold.id, fold]));
  const assigned = new Set<string>();
  for (const parent of folds) {
    for (const childId of childFoldIds(parent)) {
      const child = byId.get(childId);
      if (!child || assigned.has(childId)) throw new Error(`Invalid active-context child record ${childId}`);
      child.parentId = parent.id;
      assigned.add(childId);
    }
  }
  return validateFoldForest(folds);
}

export function stateFromFoldRefs(
  wire: Pick<
    ActiveContextCheckpointV2,
    "sessionId" | "revision" | "expanded" | "protected" | "prepared" | "advisory" |
      "tokensSinceToolFold" | "leases" | "pendingMarks" | "briefs" | "clips" | "memory"
  >,
  refs: FoldRecordRef[],
  records: Map<string, FoldRecordEntry>,
): ActiveContextState {
  if (refs.length > MAX_ACTIVE_FOLD_RECORDS) throw new Error("Active-context fold closure exceeds limit");
  const folds = refs.map((ref) => {
    const record = records.get(ref.id);
    if (!record || record.recordSha256 !== ref.sha256) throw new Error(`Missing active-context fold record ${ref.id}`);
    return record.fold;
  });
  const state: ActiveContextState = {
    version: 1,
    sessionId: wire.sessionId,
    revision: wire.revision,
    folds: deriveFoldParents(folds),
    expanded: clone(wire.expanded),
    protected: clone(wire.protected),
    tokensSinceToolFold: wire.tokensSinceToolFold ?? 0,
    leases: clone(wire.leases ?? {}),
    ...(wire.pendingMarks?.length ? { pendingMarks: clone(wire.pendingMarks) } : {}),
    ...(wire.briefs && Object.keys(wire.briefs).length ? { briefs: clone(wire.briefs) } : {}),
    ...(wire.clips?.length ? { clips: clone(wire.clips) } : {}),
    ...(wire.memory?.length ? { memory: clone(wire.memory) } : {}),
    ...(wire.advisory === undefined ? {} : { advisory: clone(wire.advisory) }),
    ...(wire.prepared === null || wire.prepared === undefined ? {} : { prepared: clone(wire.prepared) }),
  };
  return parseActiveContextState(state, wire.sessionId, false);
}

export interface ProjectionFingerprint {
  topologySha256: string;
  protectionSha256: string;
}

/**
 * A REVISION'S FINGERPRINTS, COMPUTED WHEN ONE IS ASKED FOR.
 *
 * A `Map` satisfies this, which is what it was until 2026-08-13. The narrower shape is the
 * point: the only reader takes ONE revision on the restore path, and the eager map hashed
 * the fold forest twice for every revision the ledger ever held, on every materialization,
 * including the ones that discard the map entirely.
 */
export interface ProjectionFingerprints {
  get(revision: number): ProjectionFingerprint | undefined;
}

export interface MaterializedStatePersistence {
  state: ActiveContextState;
  wireVersion: 0 | 1 | 2;
  records: Map<string, FoldRecordEntry>;
  stateSha256: string;
  projectionFingerprints: ProjectionFingerprints;
}

export function materializeStatePersistence(
  entries: any[],
  sessionId: string,
  stateEntryType = ACTIVE_CONTEXT_STATE_ENTRY,
  foldRecordEntryType = ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
): MaterializedStatePersistence {
  let state = emptyActiveContextState(sessionId);
  let wireVersion: 0 | 1 | 2 = 0;
  const records = new Map<string, FoldRecordEntry>();
  // WHAT A FINGERPRINT IS MADE OF, HELD BY REFERENCE UNTIL ONE IS ASKED FOR.
  //
  // Replaying a ledger hashed the whole fold forest twice per revision, and one revision is
  // ever read, by one caller, on the restore path. `materializeActiveContextState` takes
  // `.state` and drops the map, so every request on a folding session paid for hundreds of
  // digests it could not reach. Profiled against sol-20260813-paired rep 1 at its full
  // 1,276 entries, materialization was 98% of a derivation, and canonicalizing and hashing
  // was 72% of that.
  //
  // Holding the fields costs no copy: `state` is REPLACED on every delta rather than
  // mutated (see `stateFromFoldRefs` below), so a reference taken here keeps that
  // revision's own values, and the fold objects inside are shared with `records`.
  const fingerprintSources = new Map<number, Pick<ActiveContextState,
    "folds" | "expanded" | "protected">>();
  const fingerprintCache = new Map<number, ProjectionFingerprint>();
  const projectionFingerprints: ProjectionFingerprints = {
    get(revision: number): ProjectionFingerprint | undefined {
      const cached = fingerprintCache.get(revision);
      if (cached) return cached;
      const source = fingerprintSources.get(revision);
      if (!source) return undefined;
      const computed = {
        topologySha256: topologySha256(source),
        protectionSha256: protectionSha256(source),
      };
      fingerprintCache.set(revision, computed);
      return computed;
    },
  };
  let stateSha256 = semanticStateSha256(state);
  // WHAT THE LAST ACCEPTED ENTRY ACTUALLY RECORDED, when that is not what this build
  // would compute. A state accepted through one of the legacy derivations below was
  // written by a build that hashed it differently, and the delta that follows it names
  // its base by THAT digest, so a chain of them is unreadable unless the reading carries
  // both: the modern digest for what this build writes next, and the written one for what
  // the next entry will name. Null whenever they agree, which is every state this build
  // wrote itself, so the chain check below is unchanged for them.
  let writtenSha256: string | null = null;
  let stateStart = -1;
  let checkpointIndex = -1;
  let v2Seen = false;
  const rememberProjection = (): void => {
    fingerprintSources.set(state.revision, state);
  };
  rememberProjection();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== stateEntryType) continue;
    const version = ownValue(entry.data, "version");
    if (version === 1) {
      if (v2Seen) throw new Error("Active-context v1 state follows v2 state");
      stateStart = index;
      continue;
    }
    if (version !== 2) throw new Error("Invalid active-context persisted state version");
    const kind = ownValue(entry.data, "kind");
    if (kind === "checkpoint") {
      if (v2Seen || checkpointIndex >= 0) throw new Error("Duplicate active-context v2 checkpoint");
      checkpointIndex = index;
      stateStart = index;
    } else if (checkpointIndex < 0) {
      throw new Error("Active-context v2 delta precedes migration checkpoint");
    }
    v2Seen = true;
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "custom") continue;
    if (entry.customType === foldRecordEntryType) {
      const record = parseFoldRecordEntry(entry.data, sessionId);
      const previous = records.get(record.foldId);
      if (previous && previous.recordSha256 !== record.recordSha256) {
        throw new Error(`Conflicting active-context fold record ${record.foldId}`);
      }
      records.set(record.foldId, record);
      continue;
    }
    if (entry.customType !== stateEntryType || index < stateStart) continue;
    if (ownValue(entry.data, "version") === 1) {
      if (wireVersion === 2) throw new Error("Active-context v1 state follows v2 state");
      state = parseActiveContextState(entry.data, sessionId);
      wireVersion = 1;
      stateSha256 = semanticStateSha256(state);
      rememberProjection();
      continue;
    }
    const wire = parseActiveContextStateV2(entry.data, sessionId);
    if (wire.kind === "checkpoint") {
      state = stateFromFoldRefs(wire, wire.foldRefs, records);
    } else {
      if (wireVersion === 0 || wire.baseRevision !== state.revision ||
          (wire.baseStateSha256 !== stateSha256 && wire.baseStateSha256 !== writtenSha256) ||
          wire.revision <= wire.baseRevision) {
        throw new Error("Broken active-context delta chain");
      }
      const refs = state.folds.map(foldRecordRef);
      const byId = new Map(refs.map((ref) => [ref.id, ref]));
      for (const id of wire.removeFoldIds) {
        if (!byId.delete(id)) throw new Error(`Unknown active-context delta removal ${id}`);
      }
      for (const ref of wire.addFoldRefs) {
        const existing = byId.get(ref.id);
        if (existing && existing.sha256 !== ref.sha256) throw new Error(`Conflicting active-context delta ref ${ref.id}`);
        if (existing) throw new Error(`Duplicate active-context delta addition ${ref.id}`);
        byId.set(ref.id, ref);
      }
      // A delta written before 2026-08-13 carries the whole brief map; a newer one carries
      // only what changed. The presence of `briefs` is the discriminator, not a fallback:
      // a wire that states the whole map is replayed as the whole map.
      const briefs = wire.briefs !== undefined ? clone(wire.briefs) : { ...(state.briefs ?? {}) };
      if (wire.briefs === undefined) {
        for (const id of wire.removeBriefIds ?? []) {
          if (!Object.prototype.hasOwnProperty.call(briefs, id)) {
            throw new Error(`Unknown active-context brief removal ${id}`);
          }
          delete briefs[id];
        }
        for (const [id, brief] of Object.entries(wire.addBriefs ?? {})) {
          if (Object.prototype.hasOwnProperty.call(briefs, id) &&
              sha256Value(briefs[id]) === sha256Value(brief)) {
            throw new Error(`Redundant active-context brief ${id}`);
          }
          briefs[id] = clone(brief);
        }
      }
      // Same rule for the marks, but the discriminator is the ORDER's presence rather than
      // the array's absence. A delta written before 2026-08-13 states the whole array when
      // it has one and states nothing when it does not, so "no array" means "no marks"
      // there; reading it as "keep the base's marks" would resurrect marks a sealed session
      // had cleared. The order list is what a NEW delta's replay is built from, so a key it
      // does not name is removed by not being named.
      let marks: PendingMark[];
      if (wire.pendingMarkOrder === undefined) {
        marks = wire.pendingMarks !== undefined ? clone(wire.pendingMarks) : [];
      } else {
        const held = new Map((state.pendingMarks ?? []).map((mark) =>
          [pendingMarkKey(mark), mark] as const));
        for (const mark of wire.addPendingMarks ?? []) {
          const key = pendingMarkKey(mark);
          const standing = held.get(key);
          if (standing && sha256Value(standing) === sha256Value(mark)) {
            throw new Error(`Redundant active-context pending mark ${key}`);
          }
          held.set(key, clone(mark));
        }
        marks = wire.pendingMarkOrder.map((key) => {
          const mark = held.get(key);
          if (!mark) throw new Error(`Unknown active-context pending mark ${key}`);
          return mark;
        });
      }
      // The clips replay by the same discriminator rule as the briefs and the marks: the
      // presence of the CHANGE is what says a wire carries one. A delta written before
      // 2026-08-24 states the whole array when it has one and states nothing when it does
      // not, so "no array" means "no clips" there, exactly as it does for the marks.
      const clips = wire.clipBase === undefined
        ? (wire.clips !== undefined ? clone(wire.clips) : [])
        : [...(state.clips ?? []).slice(0, wire.clipBase), ...clone(wire.addClips ?? [])];
      if (wire.clipBase !== undefined && wire.clipBase > (state.clips ?? []).length) {
        throw new Error(`Unknown active-context clip base ${wire.clipBase}`);
      }
      if (new Set(clips.map((clip) => clip.callId)).size !== clips.length) {
        throw new Error("Invalid active-context clips: duplicate call id");
      }
      state = stateFromFoldRefs(
        {
          ...wire,
          briefs: Object.keys(briefs).length ? briefs : undefined,
          pendingMarks: marks.length ? marks : undefined,
          clips: clips.length ? clips : undefined,
          memory: wire.memory?.length ? clone(wire.memory) : undefined,
        },
        [...byId.values()],
        records,
      );
    }
    const calculated = semanticStateSha256(state);
    const legacyRider = (wire as { rider?: unknown }).rider;
    if (calculated !== wire.stateSha256 &&
        legacyCadenceOmittedStateSha256(state) !== wire.stateSha256 &&
        legacyReplayOrderStateSha256(state) !== wire.stateSha256 &&
        (legacyRider === undefined ||
          legacyRiderStateSha256(state, legacyRider) !== wire.stateSha256)) {
      throw new Error("Active-context v2 state digest drift");
    }
    wireVersion = 2;
    stateSha256 = calculated;
    writtenSha256 = wire.stateSha256 === calculated ? null : wire.stateSha256;
    rememberProjection();
  }
  return { state, wireVersion, records, stateSha256, projectionFingerprints };
}

export function materializeActiveContextState(
  entries: any[],
  sessionId: string,
  stateEntryType = ACTIVE_CONTEXT_STATE_ENTRY,
  foldRecordEntryType = ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
): ActiveContextState {
  return parseActiveContextState(
    materializeStatePersistence(entries, sessionId, stateEntryType, foldRecordEntryType).state,
    sessionId,
  );
}

export function makeFoldRecordEntry(fold: ActiveFold, sessionId: string): FoldRecordEntry {
  const canonical = canonicalFoldRecord(fold);
  return parseFoldRecordEntry({
    version: 1,
    sessionId,
    foldId: canonical.id,
    recordSha256: sha256Value(canonical),
    fold: canonical,
  }, sessionId);
}

export function makeStateCheckpoint(state: ActiveContextState): ActiveContextCheckpointV2 {
  return parseActiveContextStateV2({
    version: 2,
    kind: "checkpoint",
    sessionId: state.sessionId,
    revision: state.revision,
    foldRefs: state.folds.map(foldRecordRef),
    expanded: clone(state.expanded),
    protected: clone(state.protected),
    prepared: state.prepared ? clone(state.prepared) : null,
    tokensSinceToolFold: state.tokensSinceToolFold,
    leases: clone(state.leases),
    ...(state.pendingMarks?.length ? { pendingMarks: clone(state.pendingMarks) } : {}),
    ...(state.briefs && Object.keys(state.briefs).length ? { briefs: clone(state.briefs) } : {}),
    ...(state.clips?.length ? { clips: clone(state.clips) } : {}),
    ...(state.memory?.length ? { memory: clone(state.memory) } : {}),
    ...(state.advisory ? { advisory: clone(state.advisory) } : {}),
    stateSha256: semanticStateSha256(state),
  }, state.sessionId) as ActiveContextCheckpointV2;
}

export function makeStateDelta(previous: ActiveContextState, next: ActiveContextState): ActiveContextDeltaV2 {
  const previousRefs = new Map(previous.folds.map((fold) => {
    const ref = foldRecordRef(fold);
    return [ref.id, ref] as const;
  }));
  const nextRefs = new Map(next.folds.map((fold) => {
    const ref = foldRecordRef(fold);
    return [ref.id, ref] as const;
  }));
  for (const [id, ref] of nextRefs) {
    const previousRef = previousRefs.get(id);
    if (previousRef && previousRef.sha256 !== ref.sha256) {
      throw new Error(`Active-context fold record changed for ${id}`);
    }
  }
  // A delta carries the CHANGE, never a value its base already holds. The brief map used
  // to ship whole on every write: 81% of all state bytes on sol-20260812 rep 9, 17.7 MB of
  // it unchanged, which then made every later turn slower because the session file is what
  // the runtime derives over.
  const previousBriefs = previous.briefs ?? {};
  const nextBriefs = next.briefs ?? {};
  const addBriefs: Record<string, BriefOverride> = {};
  for (const [id, brief] of Object.entries(nextBriefs)) {
    if (!Object.prototype.hasOwnProperty.call(previousBriefs, id)) { addBriefs[id] = clone(brief); continue; }
    if (sha256Value(previousBriefs[id]) !== sha256Value(brief)) addBriefs[id] = clone(brief);
  }
  const removeBriefIds = Object.keys(previousBriefs)
    .filter((id) => !Object.prototype.hasOwnProperty.call(nextBriefs, id));
  // The marks are the same rule one shape along, and the next largest field after the
  // briefs: 2.55 MB of rep 9's 21.6 MB ledger, which a diff takes to 0.16 MB. They carry an
  // ORDER as well as a membership, and appending after removing does not always reproduce
  // it (four of that run's 309 writes), so the key order travels whole and states the
  // removals with it. It is short next to the marks themselves, so there is no case to
  // split and no branch that can pick the wrong one.
  const previousMarks = previous.pendingMarks ?? [];
  const nextMarks = next.pendingMarks ?? [];
  const previousByKey = new Map(previousMarks.map((mark) => [pendingMarkKey(mark), mark] as const));
  const addPendingMarks = nextMarks.filter((mark) => {
    const held = previousByKey.get(pendingMarkKey(mark));
    return !held || sha256Value(held) !== sha256Value(mark);
  });
  const marksTravel = previousMarks.length > 0 || nextMarks.length > 0;
  // THE CLIPS ARE THE SAME RULE A THIRD TIME (2026-08-24). They shipped whole on every
  // delta, which was 50.1 percent of all state bytes on sol-20260823-live rep 11, 472,750
  // of 942,902, for an array that never held more than 34 entries: the same defect the two
  // comments above were written about, arriving with a feature that did not inherit their
  // encoding. Clips are APPENDED and never edited, so the change is a count of what the
  // base already holds plus the ones that are new, and a rollback that shortens the array
  // states a lower count. The marks' order list would be worse than the bug here: a callId
  // is about a hundred characters, so re-listing them all on every delta costs more than
  // the array it replaces.
  const previousClips = previous.clips ?? [];
  const nextClips = next.clips ?? [];
  let clipBase = 0;
  while (clipBase < previousClips.length && clipBase < nextClips.length &&
    previousClips[clipBase].callId === nextClips[clipBase].callId &&
    previousClips[clipBase].entryId === nextClips[clipBase].entryId) clipBase += 1;
  const addClips = nextClips.slice(clipBase);
  const clipsTravel = previousClips.length > 0 || nextClips.length > 0;
  // The rest travel whole and stay that way. Measured on the same run, the two that were
  // worth a diff were 20.0 MB of the 21.6 MB ledger; what remained were bounded objects
  // with their own caps rather than collections that grow with the epoch (the largest,
  // the since-retired `notices`, was 0.93 MB). A diff for a capped
  // value is a second encoding to keep honest for a few hundred kilobytes a session, and
  // the reader's own compatibility rule is the part that is easy to get wrong: this build
  // shipped one such bug and the gate caught it.
  return parseActiveContextStateV2({
    version: 2,
    kind: "delta",
    sessionId: next.sessionId,
    revision: next.revision,
    baseRevision: previous.revision,
    baseStateSha256: semanticStateSha256(previous),
    addFoldRefs: [...nextRefs.values()].filter((ref) => !previousRefs.has(ref.id)),
    removeFoldIds: [...previousRefs.keys()].filter((id) => !nextRefs.has(id)),
    expanded: clone(next.expanded),
    protected: clone(next.protected),
    prepared: next.prepared ? clone(next.prepared) : null,
    tokensSinceToolFold: next.tokensSinceToolFold,
    leases: clone(next.leases),
    ...(marksTravel ? { pendingMarkOrder: nextMarks.map(pendingMarkKey) } : {}),
    ...(addPendingMarks.length ? { addPendingMarks: clone(addPendingMarks) } : {}),
    ...(Object.keys(addBriefs).length ? { addBriefs } : {}),
    ...(removeBriefIds.length ? { removeBriefIds } : {}),
    ...(clipsTravel ? { clipBase: clipBase, ...(addClips.length ? { addClips: clone(addClips) } : {}) } : {}),
    // The memory travels whole when it exists: bounded at MEMORY_KEYS_MAX entries and
    // edited in place, so the change encodings above have nothing to save here.
    ...(next.memory?.length ? { memory: clone(next.memory) } : {}),
    ...(next.advisory ? { advisory: clone(next.advisory) } : {}),
    stateSha256: semanticStateSha256(next),
  }, next.sessionId) as ActiveContextDeltaV2;
}

export function topologySha256(state: Pick<ActiveContextState, "folds" | "expanded">): string {
  return sha256Value({ folds: state.folds, expanded: [...state.expanded].sort() });
}

export function protectionSha256(state: Pick<ActiveContextState, "protected">): string {
  return sha256Value([...state.protected].sort((left, right) => objectRefKey(left).localeCompare(objectRefKey(right))));
}

export const ADVISORY_MILESTONES = Object.freeze(
  ["orientation", "notice", "tools", "chapters", "urgent"] as AdvisoryMilestone[],
);

/**
 * THE RETIRED STATE FIELDS, REFUSED BY NAME.
 *
 * `lastCall` and `notices` were the occupancy thermostat's two announcements, and `rider`
 * was the post-commit invitation to create marks, deleted 2026-08-23 with the curation
 * redesign: the runtime cuts and the agent edits, so an invitation to create is a carrier
 * with nothing left to invite. Nothing
 * writes them any more and nothing reads them, so a durable state that still carries one
 * was written by a build that had them, and the exact-record readers would reject it with
 * "Invalid active-context state keys" -- true, and useless to whoever has to act on it.
 *
 * Refusing by name is the whole behaviour. Tolerating the field and dropping it is the
 * silent path: it makes a version boundary look like a successful load, and the state
 * that comes back is not the state that was written. Gate 17 already states the wire's
 * policy in the other direction -- an older exact-record reader rejects newer fields, and
 * a bump is explicit -- and this is that same policy read from the newer side.
 *
 * `rider` IS NOT ON THIS LIST, and the distinction is the whole point of the list. The
 * refusal's own reason is "a state it cannot reproduce", so a field the build CAN
 * reproduce is out of its scope: the rider was projection carrier text, it changed no
 * fold, no ref and no brief, and the only thing it ever touched that survives a load is
 * the state digest. So it is read, spent on the digest, and dropped, which is what
 * `legacyRiderStateSha256` below is for. Retiring it by name instead made every state the
 * sol-20260815-hidden campaign sealed unreadable and cost the hidden-mass result its 102
 * attributed carriage rows, which is a high price for a field that carried no behaviour.
 */
const RETIRED_STATE_FIELDS: readonly string[] = Object.freeze(["lastCall", "notices", "surfacing"]);

export function refuseRetiredStateFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const carried = RETIRED_STATE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(value, field));
  if (!carried.length) return;
  throw new Error(
    `Active-context state carries the retired field(s) ${carried.join(", ")}: it was written ` +
    "by a build that still carried the subsystem behind it. Nothing writes or reads them " +
    "now, and this build will not load a state it cannot reproduce.",
  );
}

export function validAdvisoryState(value: unknown): value is NonNullable<ActiveContextState["advisory"]> {
  const hasArmed = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "armed"));
  if (!exactRecord(value, ["highWater", "delivered", ...(hasArmed ? ["armed"] : [])]) ||
      typeof ownValue(value, "highWater") !== "number" ||
      !Number.isFinite(ownValue(value, "highWater")) || Number(ownValue(value, "highWater")) < 0 ||
      Number(ownValue(value, "highWater")) > 1 || !isPlainRecord(ownValue(value, "delivered"))) return false;
  if (hasArmed) {
    const armed = ownValue(value, "armed");
    if (!exactRecord(armed, ["milestone", "threshold", "scheduleKey"]) ||
        !ADVISORY_MILESTONES.includes(ownValue(armed, "milestone") as AdvisoryMilestone) ||
        typeof ownValue(armed, "threshold") !== "number" ||
        !Number.isFinite(ownValue(armed, "threshold")) || Number(ownValue(armed, "threshold")) < 0 ||
        Number(ownValue(armed, "threshold")) > 1 ||
        typeof ownValue(armed, "scheduleKey") !== "string" ||
        !/^[a-f0-9]{64}$/.test(String(ownValue(armed, "scheduleKey")))) return false;
  }
  const delivered = ownValue(value, "delivered") as Record<string, unknown>;
  return Reflect.ownKeys(delivered).every((key) => typeof key === "string" &&
    ADVISORY_MILESTONES.includes(key as AdvisoryMilestone) &&
    Number.isSafeInteger(ownValue(delivered, key)) && Number(ownValue(delivered, key)) >= 0);
}
