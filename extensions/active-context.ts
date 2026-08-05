import type { EvidenceRef } from "./json.ts";
import {
  denseOwnArrayValues,
  evidenceRef,
  evidenceSha256,
  evidenceValue,
  isObjectRef,
  isPlainRecord,
  objectRefKey,
  sameObjectIdentity,
  sha256Text,
  sha256Value,
  stableStringify,
} from "./json.ts";

export const ACTIVE_CONTEXT_STATE_ENTRY = "quorum-active-context-state";
export const ACTIVE_CONTEXT_FOLD_RECORD_ENTRY = "quorum-active-context-fold-record";
export const NATIVE_COMPACTION_RECEIPT_ENTRY = "quorum-native-compaction-receipt";
export const NATIVE_COMPACTION_DECISION_ENTRY = "quorum-native-compaction-decision";
export const PROVIDER_CONTEXT_MEASUREMENT_ENTRY = "quorum-provider-context-measurement";
export const ACTIVE_CONTEXT_STATUS_KEY = "quorum-active-context";
export const ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  "status", "fold", "expand", "refold", "protect", "unprotect",
] as const);
export type ActiveContextToolAction = typeof ACTIVE_CONTEXT_TOOL_ACTIONS[number];
const USER_RESCUE_MAX_SOURCE_CHARS = 512_000;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const TOOL_FOLD_CADENCE_MIN_TOKENS = 12_000;
const TOOL_FOLD_CADENCE_WINDOW_FRACTION = 0.06;
const EXPAND_LEASE_GENERATIONS = 8;
const MAX_EXPAND_LEASES = 64;
const CONSOLIDATION_WIDTH_THRESHOLD = 10;
const MAX_ADVISORY_DELIVERIES_PER_MILESTONE = 16;

// Conservative LOWER bound on UTF-8 bytes per provider token, used only to cap
// the protected byte tail as a share of a small window — never to estimate usage.
const BYTES_PER_TOKEN_FLOOR = 2;

export const ACTIVE_CONTEXT_POLICY = Object.freeze({
  freshTurns: 3,
  freshBytes: 24_000,
  freshWindowShare: 0.25,
  warningRatio: 0.65,
  toolFoldRatio: 0.75,
  refoldRatio: 0.85,
  prepareRatio: 0.90,
  warmRatio: 0.55,
  responseReserve: 16_384,
  // Used only when neither provider measurements nor the host report a context window.
  fallbackChapterFoldRatio: 255_616 / 272_000,
  consolidationRatio: 0.85,
  consolidationChildren: 5,
  maxConsolidationChildren: 8,
  minToolChars: 2_000,
  minChapterChars: 4_000,
  maxChapterChars: 128_000,
  maxChapterTurns: 4,
  maxSourceChars: 200_000,
  maxFoldSourceRefs: 256,
  maxBriefChars: 1_200,
  briefTimeoutMs: 120_000,
  orientationMessages: 2,
  maxOrientationChars: 12_000,
});

export type FoldKind = "tool-result" | "chapter" | "consolidation";
export type FoldPart = { kind: "raw"; ref: EvidenceRef } | { kind: "fold"; foldId: string };
export type BriefProvenance =
  | { kind: "supplied" }
  | { kind: "deterministic" }
  | {
      kind: "model";
      provider: string;
      model: string;
      effort: string;
      launchContractDigest?: string;
    };

export interface ActiveFold {
  id: string;
  kind: FoldKind;
  parentId: string | null;
  parts: FoldPart[];
  brief: string;
  provenance: BriefProvenance;
  sourceSha256: string;
  sourceChars: number;
  placeholderChars: number;
  createdAt: number;
}

export interface PreparedFold {
  id: string;
  sessionId: string;
  generation: number;
  branchSha256: string;
  topologySha256: string;
  protectionSha256: string;
  sourceRefs: EvidenceRef[];
  sourceSha256: string;
  beforeRefs: EvidenceRef[];
  beforeSha256: string;
  afterRefs: EvidenceRef[];
  afterSha256: string;
  fold: ActiveFold;
}

export interface ActiveContextState {
  version: 1;
  sessionId: string;
  revision: number;
  folds: ActiveFold[];
  expanded: string[];
  protected: EvidenceRef[];
  tokensSinceToolFold: number;
  leases: Record<string, number>;
  prepared?: PreparedFold;
  advisory?: {
    highWater: number;
    delivered: Record<string, number>;
    armed?: { milestone: AdvisoryMilestone; threshold: number; scheduleKey: string };
  };
}

interface FoldRecordRef {
  id: string;
  sha256: string;
}

interface FoldRecordEntry {
  version: 1;
  sessionId: string;
  foldId: string;
  recordSha256: string;
  fold: ActiveFold;
}

interface ActiveContextCheckpointV2 {
  version: 2;
  kind: "checkpoint";
  sessionId: string;
  revision: number;
  foldRefs: FoldRecordRef[];
  expanded: string[];
  protected: EvidenceRef[];
  prepared: PreparedFold | null;
  tokensSinceToolFold?: number;
  leases?: Record<string, number>;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  stateSha256: string;
}

interface ActiveContextDeltaV2 {
  version: 2;
  kind: "delta";
  sessionId: string;
  revision: number;
  baseRevision: number;
  baseStateSha256: string;
  addFoldRefs: FoldRecordRef[];
  removeFoldIds: string[];
  expanded: string[];
  protected: EvidenceRef[];
  prepared: PreparedFold | null;
  tokensSinceToolFold?: number;
  leases?: Record<string, number>;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  stateSha256: string;
}

type ActiveContextStateWireV2 = ActiveContextCheckpointV2 | ActiveContextDeltaV2;

interface MappedMessage {
  index: number;
  message: unknown;
  ref: EvidenceRef | null;
}

interface BranchObject {
  branchIndex: number;
  message: unknown;
  ref: EvidenceRef;
}

export interface CompleteTurn {
  start: number;
  end: number;
}

export interface ActiveContextSnapshot {
  sessionId: string;
  messages: unknown[];
  mapped: MappedMessage[];
  branchObjects: BranchObject[];
  completeTurns: CompleteTurn[];
  freshBoundary: number;
  protectedIndices: Set<number>;
  toolProtectedIndices: Set<number>;
  policy: typeof ACTIVE_CONTEXT_POLICY;
  toolName: string;
  entryTypePrefix: string;
  readOnlyTools: ReadonlySet<string>;
  contextWindow: number;
  windowSource: "reported" | "fallback";
}

export interface FoldCandidate {
  kind: FoldKind;
  parts: FoldPart[];
  sourceRefs: EvidenceRef[];
}

const READ_ONLY_TOOLS_DEFAULT = new Set([
  "read", "grep", "find", "ls", "inspect_repo",
  "web_search", "source_check", "fetch_content", "get_search_content",
  "wiki_read", "wiki_search", "journal_read", "recall", "memory_context",
  "memory_status", "memory_outline", "wiki_lint", "surface_folds", "expand",
  "memory_search_turns", "memory_ticker_dossier", "memory_theme_dossier",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : stableStringify(value), "utf8");
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const expected = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size) return false;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

function messageRole(message: unknown): string | null {
  const role = ownValue(message, "role");
  return typeof role === "string" && role ? role : null;
}

function contentText(message: unknown): string {
  const content = ownValue(message, "content");
  if (typeof content === "string") return content;
  const parts = denseOwnArrayValues(content);
  if (!parts) return "";
  const text: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part && typeof part === "object" && ownValue(part, "type") === "text") {
      text.push(String(ownValue(part, "text") ?? ""));
    }
  }
  return text.join("\n");
}

/** Pi's exact one-entry projection, kept local so this service has no second transcript owner. */
export function sessionEntryMessages(entry: Record<string, unknown>): unknown[] {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
        message.content == null) {
      return [{ ...message, content: [] }];
    }
    return [message];
  }
  const timestamp = new Date(String(entry.timestamp)).getTime();
  if (entry.type === "custom_message") {
    return [{
      role: "custom",
      customType: entry.customType,
      content: entry.content ?? [],
      display: entry.display,
      details: entry.details,
      timestamp,
    }];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp }];
  }
  if (entry.type === "compaction") {
    return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }];
  }
  return [];
}

type UniqueMessageAnchor = {
  index: number;
  entryId: string;
  message: unknown;
};

function uniqueMessageDigestAnchor(
  entries: readonly unknown[],
  messageSha256: string,
): UniqueMessageAnchor | null {
  let anchor: UniqueMessageAnchor | null = null;
  let digestMatches = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const entryId = ownValue(entry, "id");
    if (typeof entryId !== "string" || !entryId) continue;
    const messages = sessionEntryMessages(entry as Record<string, unknown>);
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      let digest = "";
      try { digest = evidenceSha256(messages[messageIndex]); } catch { continue; }
      if (digest !== messageSha256) continue;
      digestMatches += 1;
      anchor = { index, entryId, message: messages[messageIndex] };
    }
  }
  if (digestMatches !== 1 || !anchor) return null;
  let identityMatches = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (ownValue(entries[index], "id") === anchor.entryId) identityMatches += 1;
  }
  return identityMatches === 1 ? anchor : null;
}

export function emptyActiveContextState(sessionId: string): ActiveContextState {
  if (!sessionId) throw new Error("Active context requires a Pi session ID");
  return {
    version: 1,
    sessionId,
    revision: 0,
    folds: [],
    expanded: [],
    protected: [],
    tokensSinceToolFold: 0,
    leases: {},
    advisory: { highWater: 0, delivered: {} },
  };
}

function usefulBrief(
  value: unknown,
  maximum = ACTIVE_CONTEXT_POLICY.maxBriefChars,
  toolName = "quorum_context",
): value is string {
  if (typeof value !== "string") return false;
  const brief = value.trim();
  if (!brief || brief.length > maximum) return false;
  const factualLines: string[] = [];
  const lines = brief.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text || text.toLowerCase().includes(toolName.toLowerCase()) ||
        /^\[[^\]]*(?:fold|active-context)[^\]]*\]$/i.test(text)) continue;
    if (/^(?:topology\b|expand\b|refold\b|list(?:\/page)?\b|page\b|action\b|fold(?:ed)?\s+(?:placeholder|uid|id)\b|(?:this\s+)?fold\b.*\b(?:expand|refold|placeholder|topology|uid|id)\b|(?:parent|children?|previous|next|navigation)\s*[:=])/i.test(text)) continue;
    factualLines.push(text);
  }
  const factual = factualLines.join(" ").trim();
  return /[A-Za-z0-9]{3,}/.test(factual);
}

function structurallyValidBrief(value: unknown, maximum = ACTIVE_CONTEXT_POLICY.maxBriefChars): value is string {
  if (typeof value !== "string") return false;
  const brief = value.trim();
  return Boolean(brief) && brief.length <= maximum &&
    (brief.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 3;
}

const ACTIVE_FOLD_KEYS = [
  "id", "kind", "parentId", "parts", "brief", "provenance", "sourceSha256",
  "sourceChars", "placeholderChars", "createdAt",
] as const;
const PREPARED_FOLD_KEYS = [
  "id", "sessionId", "generation", "branchSha256", "topologySha256", "protectionSha256",
  "sourceRefs", "sourceSha256", "beforeRefs", "beforeSha256", "afterRefs", "afterSha256", "fold",
] as const;
const ACTIVE_STATE_KEYS = ["version", "sessionId", "revision", "folds", "expanded", "protected"] as const;
const FOLD_RECORD_REF_KEYS = ["id", "sha256"] as const;
const FOLD_RECORD_ENTRY_KEYS = ["version", "sessionId", "foldId", "recordSha256", "fold"] as const;
const STATE_CHECKPOINT_V2_KEYS = [
  "version", "kind", "sessionId", "revision", "foldRefs", "expanded", "protected", "prepared", "stateSha256",
] as const;
const STATE_DELTA_V2_KEYS = [
  "version", "kind", "sessionId", "revision", "baseRevision", "baseStateSha256", "addFoldRefs",
  "removeFoldIds", "expanded", "protected", "prepared", "stateSha256",
] as const;
const MAX_ACTIVE_FOLD_RECORD_BYTES = 256 * 1024;
const MAX_ACTIVE_STATE_EVENT_BYTES = 512 * 1024;
const MAX_ACTIVE_FOLD_RECORDS = 4_096;
const MAX_ACTIVE_FOLD_PARTS = 1_024;
const MAX_ACTIVE_EXPANDED = 1_024;
const MAX_ACTIVE_PROTECTED = 1_024;

function validTokensSinceToolFold(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseLeases(value: unknown, foldIds?: ReadonlySet<string>): Record<string, number> {
  if (!isPlainRecord(value)) throw new Error("Invalid active-context expand leases");
  const entries = Object.entries(value);
  if (entries.length > MAX_EXPAND_LEASES || entries.some(([id, remaining]) =>
    !id || (foldIds && !foldIds.has(id)) || !Number.isSafeInteger(remaining) ||
    Number(remaining) < 1 || Number(remaining) > EXPAND_LEASE_GENERATIONS)) {
    throw new Error("Invalid active-context expand leases");
  }
  return Object.fromEntries(entries.map(([id, remaining]) => [id, Number(remaining)]));
}

function validProvenance(value: unknown): value is BriefProvenance {
  if (exactRecord(value, ["kind"]) &&
      (ownValue(value, "kind") === "supplied" || ownValue(value, "kind") === "deterministic")) return true;
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

function normalizeLegacyProvenance(provenance: unknown): BriefProvenance {
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

function validFoldPart(value: unknown): value is FoldPart {
  if (exactRecord(value, ["kind", "ref"]) && ownValue(value, "kind") === "raw") {
    return isObjectRef(ownValue(value, "ref"));
  }
  return exactRecord(value, ["kind", "foldId"]) && ownValue(value, "kind") === "fold" &&
    typeof ownValue(value, "foldId") === "string" && Boolean(ownValue(value, "foldId"));
}

function validFoldShape(value: unknown): value is ActiveFold {
  if (!exactRecord(value, ACTIVE_FOLD_KEYS)) return false;
  const kind = ownValue(value, "kind");
  const parts = denseOwnArrayValues(ownValue(value, "parts"));
  const parentId = ownValue(value, "parentId");
  const sourceSha256 = ownValue(value, "sourceSha256");
  return (kind === "tool-result" || kind === "chapter" || kind === "consolidation") &&
    typeof ownValue(value, "id") === "string" && Boolean(ownValue(value, "id")) &&
    (parentId === null || typeof parentId === "string") && Boolean(parts?.length) &&
    parts!.length <= ACTIVE_CONTEXT_POLICY.maxFoldSourceRefs &&
    parts!.every(validFoldPart) && structurallyValidBrief(ownValue(value, "brief")) &&
    validProvenance(ownValue(value, "provenance")) && typeof sourceSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sourceSha256) && Number.isSafeInteger(ownValue(value, "sourceChars")) &&
    Number(ownValue(value, "sourceChars")) > 0 && Number.isSafeInteger(ownValue(value, "placeholderChars")) &&
    Number(ownValue(value, "placeholderChars")) > 0 && Number.isSafeInteger(ownValue(value, "createdAt")) &&
    Number(ownValue(value, "createdAt")) >= 0;
}

function normalizedPart(part: FoldPart): unknown {
  return part.kind === "fold"
    ? { kind: "fold", foldId: part.foldId }
    : { kind: "raw", ref: { ...part.ref } };
}

export function foldIdFor(kind: FoldKind, parts: FoldPart[]): string {
  return `fold_${sha256Value({ kind, parts: parts.map(normalizedPart) }).slice(0, 24)}`;
}

function foldMap(state: Pick<ActiveContextState, "folds">): Map<string, ActiveFold> {
  return new Map(state.folds.map((fold) => [fold.id, fold]));
}

export function childFoldIds(fold: ActiveFold): string[] {
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
    if (fold.kind === "consolidation" && fold.parts.some((part) => part.kind !== "fold")) {
      throw new Error("Consolidation folds may contain only child folds");
    }
    byId.set(fold.id, fold);
  }
  const parent = new Map<string, string>();
  const rawOwner = new Map<string, string>();
  for (const fold of values) {
    for (const part of fold.parts) {
      if (part.kind === "raw") {
        const key = objectRefKey(part.ref);
        if (rawOwner.has(key)) throw new Error(`Evidence ${part.ref.entryId} has multiple direct fold owners`);
        rawOwner.set(key, fold.id);
      } else {
        if (!byId.has(part.foldId) || part.foldId === fold.id || parent.has(part.foldId)) {
          throw new Error(`Invalid or multiply owned child fold ${part.foldId}`);
        }
        parent.set(part.foldId, fold.id);
      }
    }
  }
  for (const fold of values) {
    if ((parent.get(fold.id) ?? null) !== fold.parentId) throw new Error(`Fold ${fold.id} parent drift`);
    for (const childId of childFoldIds(fold)) {
      const child = byId.get(childId)!;
      if (fold.kind === "chapter" && child.kind !== "tool-result") {
        throw new Error(`Chapter ${fold.id} may contain only tool-result folds`);
      }
      if (fold.kind === "consolidation" && child.kind === "tool-result") {
        throw new Error(`Consolidation ${fold.id} may contain only chapter or consolidation folds`);
      }
    }
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
  const extraKeys = [
    ...(hasPrepared ? ["prepared"] : []),
    ...(hasAdvisory ? ["advisory"] : []),
    ...(hasTokensSinceToolFold ? ["tokensSinceToolFold"] : []),
    ...(hasLeases ? ["leases"] : []),
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
  const source = clone(value) as unknown as ActiveContextState;
  // Provenance normalization is presentation-only — never mutate a durable
  // content-addressed fold record: changing its bytes causes the next re-persist
  // to report a conflicting durable fold and suspend automatic management.
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
    ...(hasAdvisory
      ? { advisory: clone(source.advisory!) }
      : defaultAdvisory ? { advisory: { highWater: 0, delivered: {} } } : {}),
    ...(hasPrepared ? { prepared: clone(source.prepared!) } : {}),
  };
}

function clearPrepared(state: ActiveContextState): ActiveContextState {
  const { prepared: _prepared, ...next } = state;
  return next;
}

function validatePreparedShape(value: unknown): asserts value is PreparedFold {
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

function canonicalFoldRecord(fold: ActiveFold): ActiveFold {
  return { ...clone(fold), parentId: null };
}

function sameFoldRecordIdentity(left: ActiveFold, right: ActiveFold): boolean {
  return sha256Value({ ...canonicalFoldRecord(left), createdAt: 0 }) ===
    sha256Value({ ...canonicalFoldRecord(right), createdAt: 0 });
}

function foldRecordRef(fold: ActiveFold): FoldRecordRef {
  const canonical = canonicalFoldRecord(fold);
  return { id: canonical.id, sha256: sha256Value(canonical) };
}

function semanticStateSha256(state: ActiveContextState): string {
  return sha256Value(state);
}

function prePhaseBSemanticStateSha256(state: ActiveContextState): string {
  const legacy = clone(state) as Partial<ActiveContextState>;
  if (legacy.tokensSinceToolFold === 0) delete legacy.tokensSinceToolFold;
  if (legacy.leases && Object.keys(legacy.leases).length === 0) delete legacy.leases;
  return sha256Value(legacy);
}

function phaseAReplayOrderStateSha256(state: ActiveContextState): string {
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

function sameStateProjection(left: ActiveContextState, right: ActiveContextState): boolean {
  const normalized = (value: ActiveContextState): Partial<ActiveContextState> => {
    const out = { ...clone(value), revision: 0 } as Partial<ActiveContextState>;
    if (out.tokensSinceToolFold === 0) delete out.tokensSinceToolFold;
    if (out.leases && Object.keys(out.leases).length === 0) delete out.leases;
    return out;
  };
  return stableStringify(normalized(left)) === stableStringify(normalized(right));
}

function parseFoldRecordRef(value: unknown): FoldRecordRef {
  if (!exactRecord(value, FOLD_RECORD_REF_KEYS) ||
      typeof ownValue(value, "id") !== "string" || !ownValue(value, "id") ||
      typeof ownValue(value, "sha256") !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(ownValue(value, "sha256")))) {
    throw new Error("Invalid active-context fold record reference");
  }
  return clone(value) as unknown as FoldRecordRef;
}

function parseFoldRecordEntry(value: unknown, sessionId: string): FoldRecordEntry {
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

function validateV2ProjectionFields(
  expandedValue: unknown,
  protectedValue: unknown,
  preparedValue: unknown,
  advisoryValue: unknown,
  tokensSinceToolFoldValue: unknown,
  leasesValue: unknown,
): {
  expanded: string[];
  protected: EvidenceRef[];
  prepared?: PreparedFold;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  tokensSinceToolFold: number;
  leases: Record<string, number>;
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
  return {
    expanded: clone(expanded) as string[],
    protected: clone(protectedRefs) as EvidenceRef[],
    ...(preparedValue === null ? {} : { prepared: clone(preparedValue) as PreparedFold }),
    ...(advisoryValue === undefined ? {} : {
      advisory: clone(advisoryValue) as NonNullable<ActiveContextState["advisory"]>,
    }),
    tokensSinceToolFold: tokensSinceToolFoldValue === undefined ? 0 : Number(tokensSinceToolFoldValue),
    leases,
  };
}

function parseActiveContextStateV2(value: unknown, sessionId: string): ActiveContextStateWireV2 {
  const kind = ownValue(value, "kind");
  const hasAdvisory = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "advisory"));
  const hasTokensSinceToolFold = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "tokensSinceToolFold"));
  const hasLeases = Boolean(value && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "leases"));
  const optionalKeys = [
    ...(hasAdvisory ? ["advisory"] : []),
    ...(hasTokensSinceToolFold ? ["tokensSinceToolFold"] : []),
    ...(hasLeases ? ["leases"] : []),
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
  );
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
  }
  const parsed = clone(value) as unknown as ActiveContextStateWireV2;
  if (bytes(parsed) > MAX_ACTIVE_STATE_EVENT_BYTES) throw new Error("Active-context state event exceeds wire limit");
  return parsed;
}

function normalizeFoldsForPersistedRecords(
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

function deriveFoldParents(records: ActiveFold[]): ActiveFold[] {
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

function stateFromFoldRefs(
  wire: Pick<
    ActiveContextCheckpointV2,
    "sessionId" | "revision" | "expanded" | "protected" | "prepared" | "advisory" |
      "tokensSinceToolFold" | "leases"
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
    ...(wire.advisory === undefined ? {} : { advisory: clone(wire.advisory) }),
    ...(wire.prepared === null || wire.prepared === undefined ? {} : { prepared: clone(wire.prepared) }),
  };
  return parseActiveContextState(state, wire.sessionId, false);
}

interface MaterializedStatePersistence {
  state: ActiveContextState;
  wireVersion: 0 | 1 | 2;
  records: Map<string, FoldRecordEntry>;
  stateSha256: string;
  projectionFingerprints: Map<number, { topologySha256: string; protectionSha256: string }>;
}

function materializeStatePersistence(
  entries: any[],
  sessionId: string,
  stateEntryType = ACTIVE_CONTEXT_STATE_ENTRY,
  foldRecordEntryType = ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
): MaterializedStatePersistence {
  let state = emptyActiveContextState(sessionId);
  let wireVersion: 0 | 1 | 2 = 0;
  const records = new Map<string, FoldRecordEntry>();
  const projectionFingerprints = new Map<number, { topologySha256: string; protectionSha256: string }>();
  let stateSha256 = semanticStateSha256(state);
  let stateStart = -1;
  let checkpointIndex = -1;
  let v2Seen = false;
  const rememberProjection = (): void => {
    projectionFingerprints.set(state.revision, {
      topologySha256: topologySha256(state),
      protectionSha256: protectionSha256(state),
    });
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
      if (wireVersion === 0 || wire.baseRevision !== state.revision || wire.baseStateSha256 !== stateSha256 ||
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
      state = stateFromFoldRefs(wire, [...byId.values()], records);
    }
    const calculated = semanticStateSha256(state);
    // Compatibility window: accept the current digest plus two legacy shapes: one
    // omitted zero cadence/empty leases; the other used a different replay-property
    // order. These shims keep already-written v2 events readable and can be removed
    // at the next wire-version bump.
    if (calculated !== wire.stateSha256 &&
        prePhaseBSemanticStateSha256(state) !== wire.stateSha256 &&
        phaseAReplayOrderStateSha256(state) !== wire.stateSha256) {
      throw new Error("Active-context v2 state digest drift");
    }
    wireVersion = 2;
    stateSha256 = calculated;
    rememberProjection();
  }
  return { state, wireVersion, records, stateSha256, projectionFingerprints };
}

export function materializeActiveContextState(entries: any[], sessionId: string): ActiveContextState {
  return parseActiveContextState(materializeStatePersistence(entries, sessionId).state, sessionId);
}

function makeFoldRecordEntry(fold: ActiveFold, sessionId: string): FoldRecordEntry {
  const canonical = canonicalFoldRecord(fold);
  return parseFoldRecordEntry({
    version: 1,
    sessionId,
    foldId: canonical.id,
    recordSha256: sha256Value(canonical),
    fold: canonical,
  }, sessionId);
}

function makeStateCheckpoint(state: ActiveContextState): ActiveContextCheckpointV2 {
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
    ...(state.advisory ? { advisory: clone(state.advisory) } : {}),
    stateSha256: semanticStateSha256(state),
  }, state.sessionId) as ActiveContextCheckpointV2;
}

function makeStateDelta(previous: ActiveContextState, next: ActiveContextState): ActiveContextDeltaV2 {
  const previousRefs = new Map(previous.folds.map((fold) => {
    const ref = foldRecordRef(fold);
    return [ref.id, ref] as const;
  }));
  const nextRefs = new Map(next.folds.map((fold) => {
    const ref = foldRecordRef(fold);
    return [ref.id, ref] as const;
  }));
  for (const [id, ref] of nextRefs) {
    const before = previousRefs.get(id);
    if (before && before.sha256 !== ref.sha256) throw new Error(`Active-context fold record changed for ${id}`);
  }
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
    ...(next.advisory ? { advisory: clone(next.advisory) } : {}),
    stateSha256: semanticStateSha256(next),
  }, next.sessionId) as ActiveContextDeltaV2;
}

function terminalAssistant(message: unknown): boolean {
  if (messageRole(message) !== "assistant") return false;
  const stop = ownValue(message, "stopReason");
  return stop === "stop" || stop === "length";
}

function completeTurns(messages: unknown[]): CompleteTurn[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) if (messageRole(messages[index]) === "user") starts.push(index);
  const turns: CompleteTurn[] = [];
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    const start = starts[cursor];
    const limit = starts[cursor + 1] ?? messages.length;
    let end = limit;
    while (end > start && (messageRole(messages[end - 1]) === "custom" ||
        messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
    if (end > start && terminalAssistant(messages[end - 1])) turns.push({ start, end });
  }
  return turns;
}

/**
 * Native compaction may resume the assistant after a summary without replaying
 * the compacted user message. Once a later user message exists, that closed
 * assistant/tool prefix is stale evidence, not part of the fresh user tail.
 * Keep the native summary itself raw and require a terminal assistant boundary.
 */
function leadingCompactionContinuation(messages: unknown[]): CompleteTurn | null {
  if (messageRole(messages[0]) !== "compactionSummary") return null;
  let firstUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messageRole(messages[index]) === "user") { firstUser = index; break; }
  }
  if (firstUser <= 1 || messageRole(messages[1]) !== "assistant") return null;
  let end = firstUser;
  while (end > 1 && (messageRole(messages[end - 1]) === "custom" ||
      messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
  return end > 1 && terminalAssistant(messages[end - 1]) ? { start: 1, end } : null;
}

export function isReadOnlyContextTool(
  name: string,
  args?: unknown,
  toolName = "quorum_context",
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): boolean {
  if (readOnlyTools.has(name)) return true;
  if (name !== toolName || !isPlainRecord(args) || ownValue(args, "action") !== "status") return false;
  const allowed = new Set(["action", "offset", "limit"]);
  const keys = Reflect.ownKeys(args);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string" || !allowed.has(keys[index] as string)) return false;
  }
  return true;
}

function exactToolCallParts(content: unknown): unknown[] | null {
  const parts = denseOwnArrayValues(content);
  if (!parts) return null;
  const calls: unknown[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (ownValue(parts[index], "type") === "toolCall") calls.push(parts[index]);
  }
  return calls;
}

export interface ValidatedToolBatch {
  calls: Array<{ id: string; name: string; assistantIndex: number; resultIndex: number }>;
}

interface ScannedToolBatches extends ValidatedToolBatch {
  unsafeIndices: Set<number>;
}

/** Validate each same-assistant tool batch inside one complete turn; results never cross a batch. */
function scanTurnToolBatches(
  messages: unknown[],
  turn: CompleteTurn,
  allowIncomplete = false,
  toolName = "quorum_context",
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): ScannedToolBatches | null {
  if (!Number.isSafeInteger(turn.start) || !Number.isSafeInteger(turn.end) ||
      turn.start < 0 || turn.end > messages.length || turn.start >= turn.end) return null;
  const terminal = terminalAssistant(messages[turn.end - 1]);
  if (!terminal && !allowIncomplete) return null;
  const batches: Array<{
    assistantIndex: number;
    end: number;
    safe: boolean;
    calls: Array<{ id: string; name: string; assistantIndex: number; resultIndex: number }>;
  }> = [];
  const unsafeIndices = new Set<number>();
  let index = turn.start;
  while (index < turn.end) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "assistant" && terminal && index === turn.end - 1) {
      index += 1;
      continue;
    }
    if (role !== "assistant" || ownValue(message, "stopReason") !== "toolUse") {
      if (role === "assistant" || role === "toolResult") unsafeIndices.add(index);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < turn.end && messageRole(messages[end]) === "toolResult") end += 1;
    const content = denseOwnArrayValues(ownValue(message, "content"));
    const rawCalls = exactToolCallParts(ownValue(message, "content")) ?? [];
    const calls = new Map<string, { id: string; name: string; assistantIndex: number }>();
    const results = new Map<string, { name: string; resultIndex: number }>();
    let safe = Boolean(content && rawCalls.length);
    for (const part of rawCalls) {
      const id = ownValue(part, "id");
      const name = ownValue(part, "name");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          calls.has(id) || !isReadOnlyContextTool(name, ownValue(part, "arguments"), toolName, readOnlyTools)) safe = false;
      else calls.set(id, { id, name, assistantIndex: index });
    }
    for (let resultIndex = index + 1; resultIndex < end; resultIndex += 1) {
      const result = messages[resultIndex];
      const id = ownValue(result, "toolCallId");
      const name = ownValue(result, "toolName");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          ownValue(result, "isError") !== false || results.has(id)) safe = false;
      else results.set(id, { name, resultIndex });
    }
    const validated: ScannedToolBatches["calls"] = [];
    if (calls.size !== results.size) safe = false;
    for (const call of calls.values()) {
      const result = results.get(call.id);
      if (!result || result.name !== call.name) safe = false;
      else validated.push({ ...call, resultIndex: result.resultIndex });
    }
    batches.push({ assistantIndex: index, end, safe, calls: validated });
    index = end;
  }

  const owners = new Map<string, number>();
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    for (const call of batches[batchIndex].calls) {
      const owner = owners.get(call.id);
      if (owner === undefined) owners.set(call.id, batchIndex);
      else {
        batches[owner].safe = false;
        batches[batchIndex].safe = false;
      }
    }
  }

  const calls: ScannedToolBatches["calls"] = [];
  for (const batch of batches) {
    if (batch.safe) calls.push(...batch.calls);
    else for (let unsafe = batch.assistantIndex; unsafe < batch.end; unsafe += 1) unsafeIndices.add(unsafe);
  }
  return { calls, unsafeIndices };
}

/** Validate a complete turn as wholly read-only. Granular callers may still use its safe batches. */
export function validateTurnToolBatch(
  messages: unknown[],
  turn: CompleteTurn,
  toolName = "quorum_context",
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): ValidatedToolBatch | null {
  const scanned = scanTurnToolBatches(messages, turn, false, toolName, readOnlyTools);
  return scanned && scanned.unsafeIndices.size === 0 ? { calls: scanned.calls } : null;
}

interface ChapterUnit {
  start: number;
  end: number;
  turnStart: number;
}

/**
 * Structural chapter segments are deliberately independent of terminal turns.
 * A long-running user turn is one segment even while the coordinator continues
 * issuing tools; a later user message closes the preceding segment without
 * making that boundary either necessary or sufficient for folding.
 */
function chapterSegments(messages: unknown[]): CompleteTurn[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messageRole(messages[index]) === "user") starts.push(index);
  }
  const segments: CompleteTurn[] = [];
  if (messageRole(messages[0]) === "compactionSummary") {
    const end = starts[0] ?? messages.length;
    if (end > 1) segments.push({ start: 1, end });
  }
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    const start = starts[cursor];
    let end = starts[cursor + 1] ?? messages.length;
    while (end > start && (messageRole(messages[end - 1]) === "custom" ||
        messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}

/**
 * Build indivisible structurally closed units. Chapters may summarize completed
 * mutating and failed work, including an old prefix of the currently running
 * turn. Every tool-use assistant must own one complete, unique result batch;
 * any pending, unmatched, or unknown shape protects its entire segment.
 */
function structurallyClosedChapterUnits(messages: unknown[], segment: CompleteTurn): ChapterUnit[] {
  const units: ChapterUnit[] = [];
  const ownedCalls = new Set<string>();
  for (let index = segment.start; index < segment.end;) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "toolResult") {
      index += 1;
      continue;
    }
    if (role !== "assistant") {
      units.push({ start: index, end: index + 1, turnStart: segment.start });
      index += 1;
      continue;
    }
    const stopReason = ownValue(message, "stopReason");
    const content = denseOwnArrayValues(ownValue(message, "content"));
    const rawCalls = exactToolCallParts(ownValue(message, "content")) ?? [];
    const toolShaped = stopReason === "toolUse" || rawCalls.length > 0;
    if (!toolShaped) {
      if (stopReason === "stop" || stopReason === "length" ||
          stopReason === "error" || stopReason === "aborted") {
        units.push({ start: index, end: index + 1, turnStart: segment.start });
      }
      index += 1;
      continue;
    }
    const calls = new Map<string, string>();
    let safe = Boolean(content && rawCalls.length &&
      (stopReason === "toolUse" || stopReason === "length" ||
        stopReason === "error" || stopReason === "aborted"));
    for (const part of rawCalls) {
      const id = ownValue(part, "id");
      const name = ownValue(part, "name");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          calls.has(id) || ownedCalls.has(id)) safe = false;
      else calls.set(id, name);
    }
    let end = index + 1;
    const results = new Map<string, string>();
    while (end < segment.end && messageRole(messages[end]) === "toolResult") {
      const id = ownValue(messages[end], "toolCallId");
      const name = ownValue(messages[end], "toolName");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name || results.has(id)) safe = false;
      else results.set(id, name);
      end += 1;
    }
    if (calls.size !== results.size) safe = false;
    for (const [id, name] of calls) {
      if (results.get(id) !== name) {
        safe = false;
        break;
      }
    }
    if (safe) {
      for (const id of calls.keys()) ownedCalls.add(id);
      units.push({ start: index, end, turnStart: segment.start });
    }
    index = end;
  }
  return units;
}

function unsafeChapterIndices(messages: unknown[]): Set<number> {
  const eligible = new Set<number>();
  const segments = chapterSegments(messages);
  for (const segment of segments) {
    const units = structurallyClosedChapterUnits(messages, segment);
    for (const unit of units) for (let index = unit.start; index < unit.end; index += 1) eligible.add(index);
  }
  const unsafe = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) if (!eligible.has(index)) unsafe.add(index);
  // The initiating request of the still-running segment remains raw even after
  // its older completed work has moved beyond the byte tail. It carries the
  // live marathon objective; subsequent structurally closed batches may fold.
  const current = segments.length ? segments[segments.length - 1] : undefined;
  if (current?.end === messages.length && !terminalAssistant(messages[current.end - 1]) &&
      messageRole(messages[current.start]) === "user") unsafe.add(current.start);
  return unsafe;
}

function freshBoundary(messages: unknown[], turns: CompleteTurn[], policy: typeof ACTIVE_CONTEXT_POLICY): number {
  if (!messages.length) return 0;
  let unfinishedUser = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue;
    let complete = false;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (turns[turnIndex].start === index) { complete = true; break; }
    }
    unfinishedUser = complete ? messages.length : index;
    break;
  }
  const leading = leadingCompactionContinuation(messages);
  let boundary = turns.length >= policy.freshTurns
    ? turns[turns.length - policy.freshTurns].start
    : leading?.end ?? 0;
  boundary = Math.min(boundary, unfinishedUser);
  while (boundary > 0) {
    const suffix: unknown[] = [];
    for (let index = boundary; index < messages.length; index += 1) suffix.push(messages[index]);
    if (bytes(suffix) >= policy.freshBytes) break;
    let previous: CompleteTurn | null = null;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (turns[turnIndex].start < boundary) previous = turns[turnIndex];
    }
    if (!previous) { boundary = 0; break; }
    boundary = previous.start;
  }
  return boundary;
}

function toolFreshIndices(
  messages: unknown[],
  turns: CompleteTurn[],
  policy: typeof ACTIVE_CONTEXT_POLICY,
): Set<number> {
  const protectedIndices = new Set<number>();
  const firstFreshTurn = Math.max(0, turns.length - policy.freshTurns);
  for (let turnIndex = firstFreshTurn; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    for (let index = turn.start; index < turn.end; index += 1) protectedIndices.add(index);
  }
  let tailBytes = 0;
  let boundary = messages.length;
  while (boundary > 0 && tailBytes < policy.freshBytes) {
    boundary -= 1;
    tailBytes += bytes(messages[boundary]);
  }
  for (let index = boundary; index < messages.length; index += 1) protectedIndices.add(index);
  return protectedIndices;
}

export function mapActiveContext(input: {
  sessionId: string;
  eventMessages: unknown[];
  contextEntries: Array<Record<string, unknown>>;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
  policy?: Partial<typeof ACTIVE_CONTEXT_POLICY>;
  toolName?: string;
  entryTypePrefix?: string;
  readOnlyTools?: ReadonlySet<string>;
  contextWindow?: number;
}): ActiveContextSnapshot {
  const policy = Object.freeze({ ...ACTIVE_CONTEXT_POLICY, ...(input.policy ?? {}) }) as typeof ACTIVE_CONTEXT_POLICY;
  const projectEntry = input.projectEntry ?? sessionEntryMessages;
  const branchObjects: BranchObject[] = [];
  for (let entryIndex = 0; entryIndex < input.contextEntries.length; entryIndex += 1) {
    const entry = input.contextEntries[entryIndex];
    const entryId = typeof entry?.id === "string" ? entry.id : "";
    if (!entryId) continue;
    const projected = denseOwnArrayValues(projectEntry(entry));
    if (!projected) continue;
    for (let messageIndex = 0; messageIndex < projected.length; messageIndex += 1) {
      const message = projected[messageIndex];
      try {
        branchObjects.push({
          branchIndex: branchObjects.length,
          message,
          ref: evidenceRef(input.sessionId, entryId, message),
        });
      } catch {
        // Unknown persisted shapes stay unavailable rather than weakening exact refs.
      }
    }
  }

  const mapped: MappedMessage[] = [];
  let cursor = 0;
  for (let index = 0; index < input.eventMessages.length; index += 1) {
    const message = input.eventMessages[index];
    let wire: string | null = null;
    let digest: string | null = null;
    try {
      wire = stableStringify(evidenceValue(message));
      digest = sha256Text(wire);
    } catch {
      mapped.push({ index, message, ref: null });
      continue;
    }
    let match = -1;
    for (let branchIndex = cursor; branchIndex < branchObjects.length; branchIndex += 1) {
      const candidate = branchObjects[branchIndex];
      if (candidate.ref.sha256 === digest && stableStringify(evidenceValue(candidate.message)) === wire) {
        match = branchIndex;
        break;
      }
    }
    if (match < 0) mapped.push({ index, message, ref: null });
    else {
      mapped.push({ index, message, ref: branchObjects[match].ref });
      cursor = match + 1;
    }
  }

  const reportedContextWindow = typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) && input.contextWindow > 0
    ? input.contextWindow
    : null;
  // A fixed byte floor can dominate a small or shrunken window. Cap the protected
  // tail at freshWindowShare of the window via a conservative bytes-per-token
  // floor: this binds only on genuinely small windows and never widens the
  // protected tail.
  const tailPolicy = reportedContextWindow === null ? policy : Object.freeze({
    ...policy,
    freshBytes: Math.min(policy.freshBytes, Math.floor(
      reportedContextWindow * policy.freshWindowShare * BYTES_PER_TOKEN_FLOOR)),
  });
  const turns = completeTurns(input.eventMessages);
  const boundary = freshBoundary(input.eventMessages, turns, tailPolicy);
  const protectedIndices = unsafeChapterIndices(input.eventMessages);
  const toolProtectedIndices = toolFreshIndices(input.eventMessages, turns, tailPolicy);
  // Chapter protection is set-shaped: preserve the newest complete turns and
  // raw byte tail, while allowing an older closed prefix of the current turn.
  for (const index of toolProtectedIndices) protectedIndices.add(index);
  for (let mappedIndex = 0; mappedIndex < mapped.length; mappedIndex += 1) {
    const item = mapped[mappedIndex];
    if (item.ref) continue;
    protectedIndices.add(item.index);
    toolProtectedIndices.add(item.index);
  }
  return {
    sessionId: input.sessionId,
    messages: clone(input.eventMessages),
    mapped,
    branchObjects,
    completeTurns: turns,
    freshBoundary: boundary,
    protectedIndices,
    toolProtectedIndices,
    policy: tailPolicy,
    toolName: input.toolName ?? "quorum_context",
    entryTypePrefix: input.entryTypePrefix ?? "quorum-active-context",
    readOnlyTools: input.readOnlyTools ?? READ_ONLY_TOOLS_DEFAULT,
    contextWindow: reportedContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    windowSource: reportedContextWindow === null ? "fallback" : "reported",
  };
}

const MAPPED_BY_KEY = new WeakMap<ActiveContextSnapshot, Map<string, MappedMessage>>();

function mappedByKey(snapshot: ActiveContextSnapshot): Map<string, MappedMessage> {
  let indexed = MAPPED_BY_KEY.get(snapshot);
  if (!indexed) {
    indexed = new Map(snapshot.mapped.flatMap((item) => item.ref ? [[objectRefKey(item.ref), item]] : []));
    MAPPED_BY_KEY.set(snapshot, indexed);
  }
  return indexed;
}

function exactMapped(snapshot: ActiveContextSnapshot, ref: EvidenceRef): MappedMessage | null {
  const item = mappedByKey(snapshot).get(objectRefKey(ref));
  return item && sameObjectIdentity(item.ref!, ref) && item.ref!.sha256 === ref.sha256 &&
    evidenceSha256(item.message) === ref.sha256 ? item : null;
}

function refsInOrder(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): number[] | null {
  const indices = refs.map((ref) => exactMapped(snapshot, ref)?.index ?? -1);
  if (indices.some((index) => index < 0) || new Set(indices).size !== indices.length) return null;
  for (let index = 1; index < indices.length; index += 1) if (indices[index] !== indices[index - 1] + 1) return null;
  return indices;
}

const BRANCH_POSITIONS = new WeakMap<ActiveContextSnapshot, Map<string, { index: number; sha256: string }>>();

function branchSha256(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): string {
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

export function topologySha256(state: Pick<ActiveContextState, "folds" | "expanded">): string {
  return sha256Value({ folds: state.folds, expanded: [...state.expanded].sort() });
}

export function protectionSha256(state: Pick<ActiveContextState, "protected">): string {
  return sha256Value([...state.protected].sort((left, right) => objectRefKey(left).localeCompare(objectRefKey(right))));
}

export function contextUsageRatio(value: unknown): number | null {
  const tokens = ownValue(value, "tokens");
  const contextWindow = ownValue(value, "contextWindow");
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 ||
      typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return tokens / contextWindow;
}

export function hardFenceRatio(value?: unknown, ctx?: any): number {
  const direct = ownValue(value, "contextWindow");
  const reported = ownValue(ctx?.getContextUsage?.(), "contextWindow");
  const contextWindow = typeof direct === "number" && Number.isFinite(direct) && direct > 0
    ? direct
    : typeof reported === "number" && Number.isFinite(reported) && reported > 0
      ? reported
      : DEFAULT_CONTEXT_WINDOW;
  if ((!Number.isFinite(direct) || Number(direct) <= 0) &&
      (!Number.isFinite(reported) || Number(reported) <= 0)) {
    return ACTIVE_CONTEXT_POLICY.fallbackChapterFoldRatio;
  }
  const reserve = Math.min(
    ACTIVE_CONTEXT_POLICY.responseReserve,
    Math.floor(contextWindow * 0.1),
  );
  return (contextWindow - reserve) / contextWindow;
}

interface ProviderContextMeasurement {
  tokens: number;
  contextWindow: number;
  messageSha256: string;
  provider: string | null;
  model: string | null;
}

interface ProviderMeasurementAnchor {
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

const PROVIDER_CONTEXT_MEASUREMENT_KEYS = [
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

function providerTokens(message: unknown): number | null {
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

function providerContextMeasurement(
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

function latestProviderContextMeasurement(
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

function contextWindowFor(ctx: any): number | null {
  const hostWindow = ownValue(ctx.getContextUsage?.(), "contextWindow");
  if (typeof hostWindow === "number" && Number.isFinite(hostWindow) && hostWindow > 0) return hostWindow;
  const modelWindow = ownValue(ctx?.model, "contextWindow");
  return typeof modelWindow === "number" && Number.isFinite(modelWindow) && modelWindow > 0 ? modelWindow : null;
}

export function toolFoldCadence(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new Error("Tool-fold cadence requires a positive context window");
  }
  return Math.max(TOOL_FOLD_CADENCE_MIN_TOKENS, TOOL_FOLD_CADENCE_WINDOW_FRACTION * contextWindow);
}

function rootFolds(state: ActiveContextState): ActiveFold[] {
  return state.folds.filter((fold) => fold.parentId === null);
}

function foldInterval(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): { start: number; end: number } | null {
  const refs = flattenFoldRefs(fold, state);
  const indices = refsInOrder(snapshot, refs);
  return indices ? { start: indices[0], end: indices.at(-1)! } : null;
}

function orderedRoots(state: ActiveContextState, snapshot: ActiveContextSnapshot): Array<{ fold: ActiveFold; start: number; end: number }> {
  return rootFolds(state).flatMap((fold) => {
    const interval = foldInterval(fold, state, snapshot);
    return interval ? [{ fold, ...interval }] : [];
  }).sort((left, right) => left.start - right.start);
}

function visibleCollapsedRoots(state: ActiveContextState, snapshot: ActiveContextSnapshot) {
  return orderedRoots(state, snapshot).filter(({ fold }) => !state.expanded.includes(fold.id));
}

function persistenceProjection(state: ActiveContextState, snapshot: ActiveContextSnapshot): ActiveContextState {
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
  if (projected.prepared && projected.prepared.sourceRefs.some((ref) => !mapped.has(objectRefKey(ref)))) {
    delete projected.prepared;
  }
  projected.folds = deriveFoldParents(projected.folds);
  return parseActiveContextState(projected, state.sessionId);
}

function explicitProtectedKeys(state: ActiveContextState): Set<string> {
  return new Set(state.protected.map(objectRefKey));
}

function refsProtected(
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

function toolRefsProtected(
  refs: EvidenceRef[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): boolean {
  const explicit = explicitProtectedKeys(state);
  return refs.some((ref) => {
    const item = exactMapped(snapshot, ref);
    return !item || explicit.has(objectRefKey(ref)) || snapshot.toolProtectedIndices.has(item.index);
  });
}

interface ResultCall {
  id: string;
  name: string;
  batch: string[];
  assistantIndex: number;
}

const RESULT_CALL_INDEXES = new WeakMap<ActiveContextSnapshot, {
  strict?: Map<number, ResultCall>;
  consumed?: Map<number, ResultCall>;
}>();

function resultCallIndex(snapshot: ActiveContextSnapshot, allowConsumedIncomplete: boolean): Map<number, ResultCall> {
  const cached = RESULT_CALL_INDEXES.get(snapshot) ?? {};
  const key = allowConsumedIncomplete ? "consumed" : "strict";
  if (cached[key]) return cached[key]!;
  const indexed = new Map<number, ResultCall>();
  const segments: Array<{ turn: CompleteTurn; complete: boolean }> = snapshot.completeTurns.map((turn) => ({
    turn,
    complete: true,
  }));
  if (allowConsumedIncomplete) {
    const completeStarts = new Set(snapshot.completeTurns.map((turn) => turn.start));
    const starts = snapshot.messages.flatMap((message, index) => messageRole(message) === "user" ? [index] : []);
    for (let cursor = 0; cursor < starts.length; cursor += 1) {
      if (completeStarts.has(starts[cursor])) continue;
      segments.push({
        turn: { start: starts[cursor], end: starts[cursor + 1] ?? snapshot.messages.length },
        complete: false,
      });
    }
  }
  segments.sort((left, right) => left.turn.start - right.turn.start);
  for (const { turn, complete } of segments) {
    const validated = scanTurnToolBatches(
      snapshot.messages,
      turn,
      allowConsumedIncomplete,
      snapshot.toolName,
      snapshot.readOnlyTools,
    );
    if (!validated) continue;
    const batches = new Map<number, string[]>();
    for (const call of validated.calls) {
      const batch = batches.get(call.assistantIndex) ?? [];
      batch.push(call.id);
      batches.set(call.assistantIndex, batch);
    }
    for (const call of validated.calls) {
      if (allowConsumedIncomplete) {
        let laterGenerations = 0;
        for (let index = call.resultIndex + 1; index < turn.end; index += 1) {
          const message = snapshot.messages[index];
          if (messageRole(message) !== "assistant") continue;
          if (ownValue(message, "stopReason") === "toolUse") laterGenerations += 1;
          else if (complete && terminalAssistant(message)) laterGenerations = Math.max(laterGenerations, 1);
        }
        if ((complete && laterGenerations < 1) || (!complete && laterGenerations < 2)) continue;
      }
      indexed.set(call.resultIndex, {
        id: call.id,
        name: call.name,
        assistantIndex: call.assistantIndex,
        batch: batches.get(call.assistantIndex)!,
      });
    }
  }
  cached[key] = indexed;
  RESULT_CALL_INDEXES.set(snapshot, cached);
  return indexed;
}

function resultCall(
  snapshot: ActiveContextSnapshot,
  resultIndex: number,
  allowConsumedIncomplete = false,
): ResultCall | null {
  return resultCallIndex(snapshot, allowConsumedIncomplete).get(resultIndex) ?? null;
}

const TOOL_CALL_ARGUMENTS = new WeakMap<ActiveContextSnapshot, Map<number, Map<string, unknown>>>();

function toolCallArguments(snapshot: ActiveContextSnapshot, assistantIndex: number, id: string): unknown {
  let assistants = TOOL_CALL_ARGUMENTS.get(snapshot);
  if (!assistants) {
    assistants = new Map();
    TOOL_CALL_ARGUMENTS.set(snapshot, assistants);
  }
  let calls = assistants.get(assistantIndex);
  if (!calls) {
    calls = new Map();
    const assistant = snapshot.messages[assistantIndex];
    for (const part of denseOwnArrayValues(ownValue(assistant, "content")) ?? []) {
      if (ownValue(part, "type") !== "toolCall") continue;
      const callId = ownValue(part, "id");
      if (typeof callId === "string" && callId) calls.set(callId, ownValue(part, "arguments"));
    }
    assistants.set(assistantIndex, calls);
  }
  return calls.get(id);
}

export function automaticToolBrief(snapshot: ActiveContextSnapshot, candidate: FoldCandidate): string {
  const refs = candidate.kind === "tool-result" && candidate.parts.every((part) => part.kind === "raw")
    ? candidate.parts.map((part) => (part as Extract<FoldPart, { kind: "raw" }>).ref)
    : [];
  const calls = refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    const call = item ? resultCall(snapshot, item.index, true) : null;
    if (!call) throw new Error("Automatic tool brief lost its validated call");
    return call;
  });
  if (!calls.length || new Set(calls.map((call) => call.assistantIndex)).size !== 1) {
    throw new Error("Automatic tool brief crossed a validated assistant batch");
  }
  const first = calls[0];
  const factualBriefValue = (value: string): string => value
    .replace(new RegExp(snapshot.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "active-context service")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const factualToolName = (name: string): string => name.toLowerCase() === snapshot.toolName.toLowerCase()
    ? "active-context status inspection"
    : factualBriefValue(name);
  const args = toolCallArguments(snapshot, first.assistantIndex, first.id);
  const targets: string[] = [];
  for (const key of ["path", "address", "query", "url", "action", "id"]) {
    const value = ownValue(args, key);
    if (typeof value === "string" && value.trim()) targets.push(`${key}=${factualBriefValue(value)}`);
  }
  const target = targets.length ? ` for ${targets.join(", ")}` : "";
  if (calls.length === 1) {
    return `Completed read-only ${factualToolName(first.name)}${target}; its exact stale output remains recoverable from this fold.`;
  }
  const names = [...new Set(calls.map((call) => factualToolName(call.name)))].sort().join("/");
  return `Completed one read-only ${names} batch with ${calls.length} exact results${target}; every stale output remains recoverable from this fold.`;
}

function deterministicConsolidationBrief(candidate: FoldCandidate, state: ActiveContextState): string {
  const byId = foldMap(state);
  const subjects = candidate.parts.flatMap((part) => {
    if (part.kind !== "fold") return [];
    const child = byId.get(part.foldId);
    return child ? [child.brief.replace(/\s+/g, " ").trim()] : [];
  });
  const text = `Grouped completed context covering: ${subjects.join(" ")}`.replace(/\s+/g, " ").trim();
  if (text.length <= ACTIVE_CONTEXT_POLICY.maxBriefChars) return text;
  let bounded = text.slice(0, ACTIVE_CONTEXT_POLICY.maxBriefChars - 1).trimEnd();
  const finalCode = bounded.charCodeAt(bounded.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) bounded = bounded.slice(0, -1);
  return `${bounded}.`;
}

function partsForRange(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  start: number,
  end: number,
  allowedChildKinds: ReadonlySet<FoldKind>,
): FoldPart[] | null {
  const roots = orderedRoots(state, snapshot);
  for (const root of roots) {
    const overlaps = root.start <= end && start <= root.end;
    if (!overlaps) continue;
    if (root.start < start || root.end > end || !allowedChildKinds.has(root.fold.kind)) return null;
  }
  const childAt = new Map(roots
    .filter((root) => root.start >= start && root.end <= end)
    .map((root) => [root.start, root]));
  const parts: FoldPart[] = [];
  for (let index = start; index <= end;) {
    const child = childAt.get(index);
    if (child) {
      parts.push({ kind: "fold", foldId: child.fold.id });
      index = child.end + 1;
      continue;
    }
    const ref = snapshot.mapped[index]?.ref;
    if (!ref) return null;
    parts.push({ kind: "raw", ref });
    index += 1;
  }
  return parts;
}

function candidateSourceRefs(parts: FoldPart[], state: ActiveContextState): EvidenceRef[] {
  const byId = foldMap(state);
  return parts.flatMap((part) => {
    if (part.kind === "raw") return [part.ref];
    const child = byId.get(part.foldId);
    if (!child) throw new Error(`Missing candidate child ${part.foldId}`);
    return flattenFoldRefs(child, state);
  });
}

function chapterUnits(snapshot: ActiveContextSnapshot): ChapterUnit[] {
  return chapterSegments(snapshot.messages)
    .flatMap((segment) => structurallyClosedChapterUnits(snapshot.messages, segment));
}

export function selectAutomaticChapter(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  maximumSourceRefs: number = snapshot.policy.maxFoldSourceRefs,
): FoldCandidate | null {
  const units = chapterUnits(snapshot);
  const allowedChildren = new Set<FoldKind>(["tool-result"]);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const first = units[unitIndex];
    let best: FoldCandidate | null = null;
    const turnStarts = new Set<number>();
    for (let endIndex = unitIndex; endIndex < units.length; endIndex += 1) {
      const unit = units[endIndex];
      if (endIndex > unitIndex && unit.start !== units[endIndex - 1].end) break;
      turnStarts.add(unit.turnStart);
      if (turnStarts.size > snapshot.policy.maxChapterTurns) break;
      const coherentSegment = endIndex > unitIndex || first.end - first.start > 1;
      if (!coherentSegment) continue;
      const parts = partsForRange(snapshot, state, first.start, unit.end - 1, allowedChildren);
      if (!parts || parts.some((part) => part.kind === "fold" && state.expanded.includes(part.foldId))) continue;
      const refs = candidateSourceRefs(parts, state);
      if (refs.length > maximumSourceRefs) break;
      if (refsProtected(refs, state, snapshot)) continue;
      const size = bytes(encodedFoldSource(snapshot, state, parts, "chapter"));
      if (size > snapshot.policy.maxChapterChars) break;
      if (size >= snapshot.policy.minChapterChars) best = { kind: "chapter", parts, sourceRefs: refs };
    }
    // Prefer the largest bounded segment beginning at the oldest eligible unit.
    if (best) return best;
  }
  return null;
}

export function selectAutomaticConsolidation(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
): FoldCandidate | null {
  const visibleRoots = visibleCollapsedRoots(state, snapshot);
  const widthEligible = visibleRoots.length > CONSOLIDATION_WIDTH_THRESHOLD;
  const pressureEligible = Number.isFinite(ratio) && ratio >= snapshot.policy.consolidationRatio;
  if (!widthEligible && !pressureEligible) return null;
  const roots = visibleRoots.filter(({ fold }) =>
    (fold.kind === "chapter" || fold.kind === "consolidation") &&
    !refsProtected(flattenFoldRefs(fold, state), state, snapshot));
  const candidateFor = (selected: typeof roots): FoldCandidate | null => {
    const parts: FoldPart[] = selected.map(({ fold }) => ({ kind: "fold", foldId: fold.id }));
    const sourceRefs = candidateSourceRefs(parts, state);
    return selected.length >= 2 && sourceRefs.length <= snapshot.policy.maxFoldSourceRefs
      ? { kind: "consolidation", parts, sourceRefs }
      : null;
  };
  if (widthEligible && !pressureEligible) {
    const oldest = roots.slice(0, snapshot.policy.consolidationChildren);
    let run: typeof roots = [];
    for (const root of oldest) {
      if (!run.length || root.start === run.at(-1)!.end + 1) {
        run.push(root);
      } else {
        if (run.length >= 2) return candidateFor(run);
        run = [root];
      }
    }
    return run.length >= 2 ? candidateFor(run) : null;
  }
  let run: typeof roots = [];
  const finish = (): FoldCandidate | null => {
    if (run.length < snapshot.policy.consolidationChildren) return null;
    const selected = run.slice(0, snapshot.policy.maxConsolidationChildren);
    const parts: FoldPart[] = selected.map(({ fold }) => ({ kind: "fold", foldId: fold.id }));
    const sourceRefs = candidateSourceRefs(parts, state);
    return sourceRefs.length <= snapshot.policy.maxFoldSourceRefs
      ? { kind: "consolidation", parts, sourceRefs }
      : null;
  };
  for (const root of roots) {
    if (!run.length || root.start === run.at(-1)!.end + 1) run.push(root);
    else {
      const candidate = finish();
      if (candidate) return candidate;
      run = [root];
    }
  }
  return finish();
}

export function selectAutomaticToolBatch(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
): FoldCandidate[] {
  if (!Number.isFinite(ratio) || ratio < snapshot.policy.toolFoldRatio) return [];
  const owned = new Set(state.folds.flatMap((fold) => fold.parts.flatMap((part) =>
    part.kind === "raw" ? [objectRefKey(part.ref)] : [])));
  const groups = new Map<number, Array<{ item: MappedMessage; call: NonNullable<ReturnType<typeof resultCall>> }>>();
  for (const item of snapshot.mapped) {
    if (messageRole(item.message) !== "toolResult") continue;
    const call = resultCall(snapshot, item.index, true);
    if (!call) continue;
    const group = groups.get(call.assistantIndex) ?? [];
    group.push({ item, call });
    groups.set(call.assistantIndex, group);
  }
  for (const group of groups.values()) {
    const expected = group[0].call.batch;
    const ids = new Set(group.map(({ call }) => call.id));
    const refs = group.map(({ item }) => item.ref);
    if (ids.size !== expected.length || expected.some((id) => !ids.has(id)) ||
        refs.some((ref) => !ref || ref.role !== "toolResult")) continue;
    const exactRefs = refs as EvidenceRef[];
    if (exactRefs.length > snapshot.policy.maxFoldSourceRefs ||
        exactRefs.some((ref) => owned.has(objectRefKey(ref))) ||
        toolRefsProtected(exactRefs, state, snapshot) || refsInOrder(snapshot, exactRefs) === null ||
        group.reduce((total, { item }) => total + bytes(item.message), 0) < snapshot.policy.minToolChars) continue;
    return [{
      kind: "tool-result",
      parts: exactRefs.map((ref) => ({ kind: "raw", ref })),
      sourceRefs: exactRefs,
    }];
  }
  return [];
}

export function selectAutomaticRefold(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
): string | null {
  if (!Number.isFinite(ratio) || ratio < snapshot.policy.refoldRatio) return null;
  const candidates = state.expanded.flatMap((id) => {
    const fold = state.folds.find((item) => item.id === id);
    const interval = fold ? foldInterval(fold, state, snapshot) : null;
    const protectedSource = fold && (fold.kind === "tool-result"
      ? toolRefsProtected(flattenFoldRefs(fold, state), state, snapshot)
      : refsProtected(flattenFoldRefs(fold, state), state, snapshot));
    return fold && interval && !protectedSource && !state.leases[id] ? [{ id, ...interval }] : [];
  }).sort((left, right) => left.end - right.end || (left.end - left.start) - (right.end - right.start));
  return candidates[0]?.id ?? null;
}

function selectAutomaticToolForRung(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
  cadenceWaived = false,
): FoldCandidate | null {
  const cadenceSatisfied = state.tokensSinceToolFold >= toolFoldCadence(snapshot.contextWindow);
  if (!cadenceWaived && (!Number.isFinite(ratio) ||
      (ratio < snapshot.policy.toolFoldRatio && !cadenceSatisfied))) return null;
  return selectAutomaticToolBatch(snapshot, state, 1)[0] ?? null;
}

type AutomaticRungSelection =
  | { kind: "prepared-chapter"; candidate: FoldCandidate }
  | { kind: "tool"; candidate: FoldCandidate }
  | { kind: "refold"; foldId: string }
  | { kind: "consolidation"; candidate: FoldCandidate }
  | { kind: "chapter"; candidate: FoldCandidate }
  | { kind: "chapter-prepare"; candidate: FoldCandidate };

interface AutomaticRungSelectionOptions {
  waiveToolCadence?: boolean;
  toolOnly?: boolean;
  summarizerAvailable?: boolean;
  failedPreparationIds?: ReadonlySet<string>;
}

function automaticPreparationId(candidate: FoldCandidate, state: ActiveContextState): string {
  return sha256Value({
    kind: candidate.kind,
    refs: candidate.sourceRefs,
    topology: topologySha256(state),
    protection: protectionSha256(state),
  });
}

function selectAutomaticRung(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
  options: AutomaticRungSelectionOptions = {},
): AutomaticRungSelection | null {
  if (!options.toolOnly && state.prepared) {
    if (!Number.isFinite(ratio) || ratio < hardFenceRatio(snapshot)) return null;
    const candidate = selectAutomaticChapter(snapshot, state);
    return candidate ? { kind: "prepared-chapter", candidate } : null;
  }
  const tool = selectAutomaticToolForRung(snapshot, state, ratio, options.waiveToolCadence);
  if (tool) return { kind: "tool", candidate: tool };
  if (options.toolOnly || !Number.isFinite(ratio)) return null;
  const refold = selectAutomaticRefold(snapshot, state, ratio);
  if (refold) return { kind: "refold", foldId: refold };
  const consolidation = selectAutomaticConsolidation(snapshot, state, ratio);
  if (consolidation) return { kind: "consolidation", candidate: consolidation };
  const chapter = selectAutomaticChapter(snapshot, state);
  if (!chapter) return null;
  const preparationFailed = options.failedPreparationIds?.has(
    automaticPreparationId(chapter, state),
  ) ?? false;
  if (ratio >= hardFenceRatio(snapshot)) {
    return !options.summarizerAvailable || preparationFailed
      ? { kind: "chapter", candidate: chapter }
      : { kind: "chapter-prepare", candidate: chapter };
  }
  if ((options.summarizerAvailable && ratio >= snapshot.policy.warmRatio) ||
      ((!options.summarizerAvailable || preparationFailed) && ratio >= snapshot.policy.prepareRatio)) {
    return { kind: "chapter-prepare", candidate: chapter };
  }
  return null;
}

export function foldCandidatesDetail(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number | null,
  options: {
    summarizerAvailable?: boolean;
    generation?: number;
    measurementFresh?: boolean;
    automaticFailure?: boolean;
    preparing?: boolean;
    failedPreparationIds?: ReadonlySet<string>;
  } = {},
): Record<string, unknown> {
  const measuredRatio = ratio !== null && Number.isFinite(ratio) ? ratio : Number.NaN;
  const tool = selectAutomaticToolForRung(snapshot, state, measuredRatio);
  const refold = selectAutomaticRefold(snapshot, state, measuredRatio);
  const consolidation = selectAutomaticConsolidation(snapshot, state, measuredRatio);
  const chapter = selectAutomaticChapter(snapshot, state);
  const selection = selectAutomaticRung(snapshot, state, measuredRatio, {
    summarizerAvailable: options.summarizerAvailable,
    failedPreparationIds: options.failedPreparationIds,
  });
  let wouldFireNow: string | null = null;
  let blockedBy: string | null = null;
  if (options.measurementFresh === false) blockedBy = "measurement-stale";
  else if (options.automaticFailure) blockedBy = "automatic-failure";
  else if (options.preparing) blockedBy = "preparing";
  else if (selection?.kind === "prepared-chapter" && state.prepared && preparedFoldError({
    prepared: state.prepared,
    snapshot,
    state,
    generation: options.generation ?? state.prepared.generation,
    ratio: measuredRatio,
  }) !== null) blockedBy = "prepared-drift";
  else wouldFireNow = selection?.kind ?? null;
  return {
    tool: tool ? {
      startId: tool.sourceRefs[0].entryId,
      endId: tool.sourceRefs.at(-1)!.entryId,
    } : null,
    refold,
    consolidation: consolidation
      ? consolidation.parts.map((part) => part.kind === "fold" ? part.foldId : "")
      : null,
    chapter: chapter ? {
      ids: chapter.sourceRefs.map((ref) => ref.entryId),
      estimatedChars: encodedFoldSource(snapshot, state, chapter.parts, chapter.kind).length,
    } : null,
    wouldFireNow,
    blockedBy,
    cadence: {
      tokensSinceToolFold: state.tokensSinceToolFold,
      cadenceNeed: toolFoldCadence(snapshot.contextWindow),
    },
    width: {
      visibleRoots: visibleCollapsedRoots(state, snapshot).length,
      threshold: CONSOLIDATION_WIDTH_THRESHOLD,
    },
  };
}

export function selectAutomaticCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
): FoldCandidate | null {
  const selection = selectAutomaticRung(snapshot, state, ratio);
  return selection && "candidate" in selection ? selection.candidate : null;
}

function resolveFoldInputIds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): Array<{ start: number; end: number; fold?: ActiveFold }> {
  if (!ids.length || ids.length > 64 || ids.some((id) => !id)) throw new Error("fold requires 1-64 nonempty ids");
  const values = ids.map((id) => {
    const fold = state.folds.find((item) => item.id === id);
    if (fold) {
      if (fold.parentId !== null) throw new Error(`Fold ${id} is already nested under ${fold.parentId}`);
      const interval = foldInterval(fold, state, snapshot);
      if (!interval) throw new Error(`Fold ${id} is not active in the Pi context event`);
      return { ...interval, fold };
    }
    const item = snapshot.mapped.find((candidate) => candidate.ref?.entryId === id);
    if (!item?.ref) throw new Error(`Unknown active-context source ${id}`);
    return { start: item.index, end: item.index };
  });
  values.sort((left, right) => left.start - right.start);
  return values;
}

function chapterRangeIsUnitAligned(snapshot: ActiveContextSnapshot, start: number, end: number): boolean {
  const units = chapterUnits(snapshot).filter((unit) => unit.end > start && unit.start <= end);
  if (!units.length || units[0].start !== start || units.at(-1)!.end !== end + 1) return false;
  if (new Set(units.map((unit) => unit.turnStart)).size > snapshot.policy.maxChapterTurns) return false;
  return units.every((unit, index) => index === 0 || unit.start === units[index - 1].end);
}

export function manualFoldCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): FoldCandidate {
  const bounded = (candidate: FoldCandidate): FoldCandidate => {
    if (candidate.sourceRefs.length > snapshot.policy.maxFoldSourceRefs) {
      throw new Error(`Folds may include at most ${snapshot.policy.maxFoldSourceRefs} exact source references`);
    }
    return candidate;
  };
  const selected = resolveFoldInputIds(snapshot, state, ids);
  const start = selected[0].start;
  const end = selected.at(-1)!.end;
  const one = selected.length === 1 ? selected[0] : null;
  if (selected.every((item) => !item.fold && snapshot.mapped[item.start].ref?.role === "toolResult")) {
    const refs = selected.map((item) => snapshot.mapped[item.start].ref!);
    const calls = selected.map((item) => resultCall(snapshot, item.start, true));
    const first = calls[0];
    const completeBatch = first && calls.every((call) => call && call.assistantIndex === first.assistantIndex) &&
      calls.length === first.batch.length &&
      new Set(calls.map((call) => call!.id)).size === first.batch.length &&
      first.batch.every((id) => calls.some((call) => call!.id === id));
    if (completeBatch && !toolRefsProtected(refs, state, snapshot)) {
      return bounded({ kind: "tool-result", parts: refs.map((ref) => ({ kind: "raw", ref })), sourceRefs: refs });
    }
    if (one && first && first.batch.length === 1 && !toolRefsProtected(refs, state, snapshot)) {
      return bounded({ kind: "tool-result", parts: [{ kind: "raw", ref: refs[0] }], sourceRefs: refs });
    }
  }
  const exactFolds = selected.every((item) => item.fold && item.fold.kind !== "tool-result") &&
    selected.every((item, index) => index === 0 || item.start === selected[index - 1].end + 1);
  if (exactFolds && selected.length >= 2) {
    const parts: FoldPart[] = selected.map((item) => ({ kind: "fold", foldId: item.fold!.id }));
    const refs = candidateSourceRefs(parts, state);
    if (refsProtected(refs, state, snapshot)) throw new Error("Manual consolidation contains protected evidence");
    return bounded({ kind: "consolidation", parts, sourceRefs: refs });
  }
  if (!chapterRangeIsUnitAligned(snapshot, start, end)) {
    throw new Error("Chapter folds must align to a contiguous structurally closed user/assistant/tool-batch range");
  }
  const parts = partsForRange(snapshot, state, start, end, new Set<FoldKind>(["tool-result"]));
  if (!parts) throw new Error("Chapter fold would partially overlap or swallow an existing chapter");
  const refs = candidateSourceRefs(parts, state);
  if (refsProtected(refs, state, snapshot)) throw new Error("Manual chapter contains fresh, unfinished, unmatched, unmapped, or protected evidence");
  return bounded({ kind: "chapter", parts, sourceRefs: refs });
}

function encodedRefs(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): string {
  return stableStringify(refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    return { ref, message: item.message };
  }));
}

function encodedFoldSource(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  parts: FoldPart[],
  kind: FoldKind,
): string {
  if (kind !== "chapter") {
    const messages = renderFoldParts(parts, state, snapshot);
    if (!messages) throw new Error("Fold source projection drifted");
    return stableStringify({ parts: parts.map(normalizedPart), messages });
  }
  const refs = candidateSourceRefs(parts, state);
  return stableStringify(refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    const call = ref.role === "toolResult" ? resultCall(snapshot, item.index, true) : null;
    if (!call) return { ref, message: clone(item.message) };
    const candidate: FoldCandidate = {
      kind: "tool-result",
      parts: [{ kind: "raw", ref }],
      sourceRefs: [ref],
    };
    return {
      ref,
      message: {
        role: "toolResult",
        toolCallId: ownValue(item.message, "toolCallId"),
        toolName: ownValue(item.message, "toolName"),
        content: [{ type: "text", text: automaticToolBrief(snapshot, candidate) }],
        isError: false,
        details: {
          projection: "deterministic-read-only-tool-brief",
          sourceSha256: ref.sha256,
          sourceBytes: bytes(item.message),
        },
        timestamp: ownValue(item.message, "timestamp"),
      },
    };
  }));
}

function boundedOrientation(
  snapshot: ActiveContextSnapshot,
  sourceRefs: EvidenceRef[],
): { beforeRefs: EvidenceRef[]; beforeText: string; afterRefs: EvidenceRef[]; afterText: string } {
  const indices = refsInOrder(snapshot, sourceRefs);
  if (!indices) throw new Error("Fold source is not an exact contiguous active range");
  const sourceKeys = new Set(sourceRefs.map(objectRefKey));
  const collect = (candidates: MappedMessage[]): { refs: EvidenceRef[]; text: string } => {
    const refs: EvidenceRef[] = [];
    let text = "[]";
    for (const item of candidates) {
      if (!item.ref || sourceKeys.has(objectRefKey(item.ref))) continue;
      const trial = [...refs, item.ref];
      const encoded = encodedRefs(snapshot, trial);
      if (encoded.length > snapshot.policy.maxOrientationChars) break;
      refs.push(item.ref);
      text = encoded;
      if (refs.length >= snapshot.policy.orientationMessages) break;
    }
    return { refs, text };
  };
  const before = collect(snapshot.mapped.slice(0, indices[0]).reverse()).refs.reverse();
  const beforeText = before.length ? encodedRefs(snapshot, before) : "[]";
  const after = collect(snapshot.mapped.slice(indices.at(-1)! + 1));
  return { beforeRefs: before, beforeText, afterRefs: after.refs, afterText: after.text };
}

function oneLine(value: string, maximum: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  let bounded = text.slice(0, maximum).trimEnd();
  const finalCode = bounded.charCodeAt(bounded.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded;
}

export function deterministicChapterBrief(
  refs: EvidenceRef[],
  messages: unknown[],
  toolName = "quorum_context",
): string {
  if (refs.length !== messages.length || !refs.length) {
    throw new Error("Deterministic chapter brief requires aligned exact evidence");
  }
  const firstUser = messages.find((message) => messageRole(message) === "user");
  const firstAssistant = messages.find((message) =>
    messageRole(message) === "assistant" && contentText(message).trim());
  const toolCounts = new Map<string, number>();
  for (const message of messages) {
    if (messageRole(message) !== "assistant") continue;
    for (const part of denseOwnArrayValues(ownValue(message, "content")) ?? []) {
      if (ownValue(part, "type") !== "toolCall") continue;
      const name = ownValue(part, "name");
      if (typeof name === "string" && name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }
  const ask = oneLine(firstUser ? contentText(firstUser) : "No user ask in this span", 90);
  const assistant = oneLine(firstAssistant ? contentText(firstAssistant).split(/\r?\n/)[0] :
    "No assistant text in this span", 110);
  const tools = oneLine([...toolCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${count}×${name}`)
    .join(" ") || "no tools", 500);
  const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const composed = `User: ${ask} · Tools: ${tools} · Assistant: ${assistant}`
    .replace(new RegExp(escapeName(toolName), "gi"), "active-context service")
    .replace(new RegExp(escapeName("quorum_context"), "gi"), "active-context service");
  if (usefulBrief(composed, ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName)) return composed;
  // Constant floor-of-the-floor: provably passes usefulBrief (no tool name, no structural pattern).
  return `Folded ${refs.length} exact messages from this span's complete turns.`;
}

function deterministicChapterCandidateBrief(
  snapshot: ActiveContextSnapshot,
  candidate: FoldCandidate,
): string {
  const messages = candidate.sourceRefs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    return item.message;
  });
  return deterministicChapterBrief(candidate.sourceRefs, messages, snapshot.toolName);
}

export async function prepareFold(input: {
  candidate: FoldCandidate;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  brief?: string;
  briefProvenance?: "supplied" | "deterministic";
  summarize?: (request: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>>;
  onSummarizerFailure?: (error: unknown) => void;
  ctx?: unknown;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PreparedFold> {
  const { candidate, snapshot, state } = input;
  const protectedSource = candidate.kind === "tool-result"
    ? toolRefsProtected(candidate.sourceRefs, state, snapshot)
    : refsProtected(candidate.sourceRefs, state, snapshot);
  if (!candidate.sourceRefs.length || candidate.sourceRefs.length > snapshot.policy.maxFoldSourceRefs ||
      refsInOrder(snapshot, candidate.sourceRefs) === null || protectedSource) {
    throw new Error("Fold source is not exact, stale, and unprotected");
  }
  const sourceText = encodedFoldSource(snapshot, state, candidate.parts, candidate.kind);
  const orientation = boundedOrientation(snapshot, candidate.sourceRefs);
  const sourceSha256 = sha256Text(sourceText);
  const beforeSha256 = sha256Text(orientation.beforeText);
  const afterSha256 = sha256Text(orientation.afterText);
  const candidateId = sha256Value({
    kind: candidate.kind,
    parts: candidate.parts.map(normalizedPart),
    sourceSha256,
    beforeSha256,
    afterSha256,
  });

  let brief: string;
  let provenance: BriefProvenance;
  if (input.brief !== undefined) {
    if (!usefulBrief(input.brief, snapshot.policy.maxBriefChars, snapshot.toolName)) {
      throw new Error(`Supplied brief must be non-structural and at most ${snapshot.policy.maxBriefChars} characters`);
    }
    brief = input.brief.trim();
    provenance = { kind: input.briefProvenance ?? "supplied" };
  } else {
    let modelBrief: { brief: string; provenance: BriefProvenance } | null = null;
    if (input.summarize) {
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", relayAbort, { once: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (bytes(sourceText) > snapshot.policy.maxSourceChars) {
          throw new Error("Fold source exceeds the bounded model-summary request");
        }
        const timed = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Context brief exceeded ${snapshot.policy.briefTimeoutMs}ms`));
          }, snapshot.policy.briefTimeoutMs);
        });
        const result = await Promise.race([input.summarize({
          candidateId,
          sourceRefs: clone(candidate.sourceRefs),
          sourceText,
          sourceSha256,
          beforeRefs: clone(orientation.beforeRefs),
          beforeText: orientation.beforeText,
          beforeSha256,
          afterRefs: clone(orientation.afterRefs),
          afterText: orientation.afterText,
          afterSha256,
          maxBriefChars: snapshot.policy.maxBriefChars,
          signal: controller.signal,
        }, input.ctx), timed]);
        const generated = typeof result?.brief === "string" ? result.brief.trim() : "";
        const digest = result?.launchContractDigest;
        if (!usefulBrief(generated, snapshot.policy.maxBriefChars, snapshot.toolName) ||
            typeof result?.provider !== "string" || !result.provider ||
            typeof result?.model !== "string" || !result.model ||
            typeof result?.effort !== "string" || !result.effort || result.toolCalls !== 0 ||
            (digest !== undefined && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))) {
          throw new Error("Model context brief attribution, zero-tool, digest, or usefulness contract drift");
        }
        modelBrief = {
          brief: generated,
          provenance: {
            kind: "model",
            provider: result.provider,
            model: result.model,
            effort: result.effort,
            ...(typeof digest === "string" ? { launchContractDigest: digest } : {}),
          },
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        input.onSummarizerFailure?.(error);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", relayAbort);
      }
    }
    if (modelBrief) {
      brief = modelBrief.brief;
      provenance = modelBrief.provenance;
    } else {
      brief = deterministicChapterCandidateBrief(snapshot, candidate);
      provenance = { kind: "deterministic" };
    }
  }

  const id = foldIdFor(candidate.kind, candidate.parts);
  const provisional: ActiveFold = {
    id,
    kind: candidate.kind,
    parentId: null,
    parts: clone(candidate.parts),
    brief,
    provenance,
    sourceSha256: sha256Value(candidate.sourceRefs),
    sourceChars: 1,
    placeholderChars: 1,
    createdAt: (input.now ?? Date.now)(),
  };
  const sourceMessages = renderFoldParts(candidate.parts, state, snapshot);
  const provisionalState = stateWithNestedFold(state, provisional);
  const replacementFold = provisionalState.folds.find((item) => item.id === id)!;
  const replacementMessages = renderFold(replacementFold, provisionalState, snapshot);
  if (!sourceMessages || !replacementMessages) throw new Error("Fold rendering drifted before measurement");
  const sourceBytes = bytes(sourceMessages);
  const replacementBytes = bytes(replacementMessages);
  if (candidate.kind === "consolidation" && replacementBytes >= sourceBytes) {
    throw new Error("Consolidation brief would not materially reduce its rendered child placeholders");
  }
  const fold: ActiveFold = {
    ...provisional,
    sourceChars: sourceBytes,
    placeholderChars: replacementBytes,
  };
  return {
    id,
    sessionId: snapshot.sessionId,
    generation: input.generation,
    branchSha256: branchSha256(snapshot, [
      ...orientation.beforeRefs,
      ...candidate.sourceRefs,
      ...orientation.afterRefs,
    ]),
    topologySha256: topologySha256(state),
    protectionSha256: protectionSha256(state),
    sourceRefs: clone(candidate.sourceRefs),
    sourceSha256,
    beforeRefs: clone(orientation.beforeRefs),
    beforeSha256,
    afterRefs: clone(orientation.afterRefs),
    afterSha256,
    fold,
  };
}

function renderFoldParts(
  parts: FoldPart[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): unknown[] | null {
  const byId = foldMap(state);
  const output: unknown[] = [];
  for (const part of parts) {
    if (part.kind === "raw") {
      const item = exactMapped(snapshot, part.ref);
      if (!item) return null;
      output.push(clone(item.message));
    } else {
      const child = byId.get(part.foldId);
      if (!child) return null;
      const rendered = renderFold(child, state, snapshot);
      if (!rendered) return null;
      output.push(...rendered);
    }
  }
  return output;
}

function stateWithNestedFold(state: ActiveContextState, fold: ActiveFold): ActiveContextState {
  const childIds = new Set(childFoldIds(fold));
  if (state.folds.some((item) => item.id === fold.id)) throw new Error("Prepared fold already exists");
  const folds = state.folds.map((item) => childIds.has(item.id) ? { ...item, parentId: fold.id } : item);
  folds.push(clone(fold));
  const collapse = new Set<string>(childIds);
  for (const childId of childIds) for (const id of descendantIds(state, childId)) collapse.add(id);
  return {
    ...state,
    folds: validateFoldForest(folds),
    expanded: state.expanded.filter((id) => !collapse.has(id)),
    tokensSinceToolFold: fold.kind === "tool-result" ? 0 : state.tokensSinceToolFold,
    leases: Object.fromEntries(Object.entries(state.leases)
      .filter(([id]) => !collapse.has(id))),
  };
}

function preparedPartsStillExact(prepared: PreparedFold, state: ActiveContextState): boolean {
  const byId = foldMap(state);
  const refs: EvidenceRef[] = [];
  for (const part of prepared.fold.parts) {
    if (part.kind === "raw") refs.push(part.ref);
    else {
      const child = byId.get(part.foldId);
      if (!child || child.parentId !== null) return false;
      refs.push(...flattenFoldRefs(child, state));
    }
  }
  return stableStringify(refs) === stableStringify(prepared.sourceRefs) &&
    prepared.fold.id === foldIdFor(prepared.fold.kind, prepared.fold.parts);
}

function preparedMatchesCandidate(prepared: PreparedFold, candidate: FoldCandidate | null): boolean {
  return Boolean(candidate) && stableStringify({
    kind: prepared.fold.kind,
    parts: prepared.fold.parts.map(normalizedPart),
    sourceRefs: prepared.sourceRefs,
  }) === stableStringify({
    kind: candidate!.kind,
    parts: candidate!.parts.map(normalizedPart),
    sourceRefs: candidate!.sourceRefs,
  });
}

export function preparedFoldError(input: {
  prepared: PreparedFold;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  ratio?: number | null;
}): string | null {
  const { prepared, snapshot, state } = input;
  if (prepared.sessionId !== snapshot.sessionId) return "session drift";
  if (prepared.generation !== input.generation) return "generation drift";
  if (prepared.topologySha256 !== topologySha256(state)) return "topology drift";
  if (prepared.protectionSha256 !== protectionSha256(state)) return "protection drift";
  if (!preparedPartsStillExact(prepared, state)) return "prepared parts drift";
  const indices = refsInOrder(snapshot, prepared.sourceRefs);
  if (!indices) return "source mapping drift";
  let sourceText: string;
  try { sourceText = encodedFoldSource(snapshot, state, prepared.fold.parts, prepared.fold.kind); }
  catch { return "source hash drift"; }
  if (sha256Text(sourceText) !== prepared.sourceSha256) return "source hash drift";
  let orientation;
  try { orientation = boundedOrientation(snapshot, prepared.sourceRefs); }
  catch { return "orientation drift"; }
  if (stableStringify(orientation.beforeRefs) !== stableStringify(prepared.beforeRefs) ||
      stableStringify(orientation.afterRefs) !== stableStringify(prepared.afterRefs) ||
      sha256Text(orientation.beforeText) !== prepared.beforeSha256 ||
      sha256Text(orientation.afterText) !== prepared.afterSha256) return "orientation drift";
  if (prepared.branchSha256 !== branchSha256(snapshot, [
    ...prepared.beforeRefs, ...prepared.sourceRefs, ...prepared.afterRefs,
  ])) return "branch drift";
  const toolSource = prepared.fold.kind === "tool-result";
  if (indices.some((index) => toolSource
    ? snapshot.toolProtectedIndices.has(index)
    : snapshot.protectedIndices.has(index))) return "fresh-tail drift";
  if (toolSource
    ? toolRefsProtected(prepared.sourceRefs, state, snapshot)
    : refsProtected(prepared.sourceRefs, state, snapshot)) return "source became protected";
  if (Object.prototype.hasOwnProperty.call(input, "ratio")) {
    if (input.ratio === null || typeof input.ratio !== "number" || !Number.isFinite(input.ratio)) {
      return "current pressure unavailable";
    }
    if (!preparedMatchesCandidate(prepared, selectAutomaticCandidate(snapshot, state, input.ratio))) {
      return "automatic candidate drift";
    }
  }
  return null;
}

function descendantIds(state: ActiveContextState, id: string): Set<string> {
  const byId = foldMap(state);
  const out = new Set<string>();
  const visit = (foldId: string): void => {
    for (const child of childFoldIds(byId.get(foldId)!)) {
      out.add(child);
      visit(child);
    }
  };
  if (byId.has(id)) visit(id);
  return out;
}

export function commitPreparedFold(input: {
  prepared: PreparedFold;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
}): ActiveContextState {
  const error = preparedFoldError(input);
  if (error) throw new Error(`Prepared active-context fold discarded: ${error}`);
  const nested = stateWithNestedFold(input.state, input.prepared.fold);
  const next = clearPrepared({ ...nested, revision: input.state.revision + 1 });
  // A fold is not committed unless its provider projection preserves every
  // existing tool-call/output pair atomically. This keeps malformed provider
  // context non-constructible even if a future selector regresses.
  projectActiveContext(input.snapshot, next);
  return next;
}

export function setFoldProjectionState(
  state: ActiveContextState,
  id: string,
  projection: "folded" | "expanded",
): ActiveContextState {
  const fold = state.folds.find((item) => item.id === id);
  if (!fold) throw new Error(`Unknown active-context fold ${id}`);
  const expanded = new Set(state.expanded);
  if (projection === "expanded") {
    if (fold.parentId && !expanded.has(fold.parentId)) {
      throw new Error(`Expand parent ${fold.parentId} before child ${id}`);
    }
    expanded.add(id);
    for (const descendant of descendantIds(state, id)) expanded.delete(descendant);
  } else {
    expanded.delete(id);
    for (const descendant of descendantIds(state, id)) expanded.delete(descendant);
  }
  return clearPrepared({ ...state, revision: state.revision + 1, expanded: [...expanded] });
}

function withExpandLease(state: ActiveContextState, id: string): ActiveContextState {
  const leases = { ...state.leases, [id]: EXPAND_LEASE_GENERATIONS };
  const entries = Object.entries(leases);
  if (entries.length > MAX_EXPAND_LEASES) {
    entries.sort(([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId));
    delete leases[entries[0][0]];
  }
  return { ...state, leases };
}

function requireActiveFold(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  id: string,
): ActiveFold {
  const fold = state.folds.find((item) => item.id === id);
  if (!fold || !foldInterval(fold, state, snapshot)) {
    throw new Error(`Active-context fold ${id} is not present in the current Pi context event`);
  }
  return fold;
}

export function protectEvidence(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  protect: boolean,
): ActiveContextState {
  const refs = ids.flatMap((id) => {
    const fold = state.folds.find((item) => item.id === id);
    if (fold) return flattenFoldRefs(requireActiveFold(snapshot, state, id), state);
    const item = snapshot.mapped.find((candidate) => candidate.ref?.entryId === id);
    if (!item?.ref) throw new Error(`Unknown active-context source ${id}`);
    return [item.ref];
  });
  const byKey = new Map(state.protected.map((ref) => [objectRefKey(ref), ref]));
  for (const ref of refs) protect ? byKey.set(objectRefKey(ref), ref) : byKey.delete(objectRefKey(ref));
  return clearPrepared({
    ...state,
    revision: state.revision + 1,
    protected: [...byKey.values()],
  });
}

function siblingIds(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string[] {
  if (fold.parentId) {
    const parent = state.folds.find((item) => item.id === fold.parentId);
    return parent ? childFoldIds(parent) : [];
  }
  return orderedRoots(state, snapshot).map((item) => item.fold.id);
}

function foldNavigation(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): {
  previous: string | null;
  next: string | null;
} {
  const siblings = siblingIds(fold, state, snapshot);
  const index = siblings.indexOf(fold.id);
  return {
    previous: index > 0 ? siblings[index - 1] : null,
    next: index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null,
  };
}

function foldPlaceholder(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string {
  const navigation = foldNavigation(fold, state, snapshot);
  const parent = fold.parentId ?? "root";
  return [
    `[Quorum active-context fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=${parent}; children=${childFoldIds(fold).length}; ` +
      `previous=${navigation.previous ?? "none"}; next=${navigation.next ?? "none"}.`,
    `Expand exactly: ${snapshot.toolName} {"action":"expand","id":"${fold.id}"}`,
    `List/page exactly: ${snapshot.toolName} {"action":"status"}`,
  ].join("\n");
}

function renderFold(
  fold: ActiveFold,
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): unknown[] | null {
  const refs = flattenFoldRefs(fold, state);
  const indices = refsInOrder(snapshot, refs);
  if (!indices) return null;
  const mustReveal = state.expanded.includes(fold.id) || (fold.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot));
  if (!mustReveal) {
    const first = snapshot.messages[indices[0]] as Record<string, unknown>;
    const text = foldPlaceholder(fold, state, snapshot);
    if (fold.kind === "tool-result") return indices.map((index) => ({
      ...clone(snapshot.messages[index] as Record<string, unknown>),
      content: [{ type: "text", text }],
    }));
    return [{
      role: "custom",
      customType: `${snapshot.entryTypePrefix}-fold`,
      content: text,
      display: false,
      details: { source: "quorum/active-context", foldId: fold.id },
      timestamp: typeof first?.timestamp === "number" ? first.timestamp : 0,
    }];
  }
  const byId = foldMap(state);
  const output: unknown[] = [];
  for (const part of fold.parts) {
    if (part.kind === "raw") {
      const item = exactMapped(snapshot, part.ref);
      if (!item) return null;
      output.push(clone(item.message));
    } else {
      const child = byId.get(part.foldId);
      if (!child) return null;
      const rendered = renderFold(child, state, snapshot);
      if (!rendered) return null;
      output.push(...rendered);
    }
  }
  return output;
}

interface ToolLinkageCount {
  calls: number;
  results: number;
}

function toolLinkageCounts(messages: unknown[]): Map<string, ToolLinkageCount> {
  const counts = new Map<string, ToolLinkageCount>();
  const increment = (id: string, field: keyof ToolLinkageCount): void => {
    const current = counts.get(id) ?? { calls: 0, results: 0 };
    current[field] += 1;
    counts.set(id, current);
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "assistant") {
      const content = denseOwnArrayValues(ownValue(message, "content"));
      if (!content) continue;
      for (const part of content) {
        if (ownValue(part, "type") !== "toolCall") continue;
        const id = ownValue(part, "id");
        if (typeof id === "string" && id) increment(id, "calls");
      }
    } else if (role === "toolResult") {
      const id = ownValue(message, "toolCallId");
      if (typeof id === "string" && id) increment(id, "results");
    }
  }
  return counts;
}

function assertProjectionPreservesToolLinkage(source: unknown[], projected: unknown[]): void {
  const before = toolLinkageCounts(source);
  const after = toolLinkageCounts(projected);
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const original = before.get(id) ?? { calls: 0, results: 0 };
    const visible = after.get(id) ?? { calls: 0, results: 0 };
    const uniquelyClosed = original.calls === 1 && original.results === 1;
    const valid = uniquelyClosed
      ? (visible.calls === 1 && visible.results === 1) ||
        (visible.calls === 0 && visible.results === 0)
      : visible.calls === original.calls && visible.results === original.results;
    if (!valid) {
      throw new Error(
        `Active-context projection split tool call/result linkage for ${id.slice(0, 120)}: ` +
        `${original.calls}/${original.results} became ${visible.calls}/${visible.results}`,
      );
    }
  }
}

export function projectActiveContext(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): unknown[] {
  validateFoldForest(state.folds);
  const replacements = new Map<number, { end: number; messages: unknown[] }>();
  for (const root of orderedRoots(state, snapshot)) {
    const rendered = renderFold(root.fold, state, snapshot);
    if (rendered) replacements.set(root.start, { end: root.end, messages: rendered });
  }
  const output: unknown[] = [];
  for (let index = 0; index < snapshot.messages.length;) {
    const replacement = replacements.get(index);
    if (replacement) {
      output.push(...replacement.messages);
      index = replacement.end + 1;
    } else {
      output.push(clone(snapshot.messages[index]));
      index += 1;
    }
  }
  assertProjectionPreservesToolLinkage(snapshot.messages, output);
  return output;
}

function foldStatusRow(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): Record<string, unknown> {
  const navigation = foldNavigation(fold, state, snapshot);
  const interval = foldInterval(fold, state, snapshot);
  const refs = flattenFoldRefs(fold, state);
  const allSourceIds = refs.map((ref) => ref.entryId);
  const sourceIds = allSourceIds.slice(0, 64);
  const blocked = fold.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot);
  const projection = state.expanded.includes(fold.id) ? "expanded" : "folded";
  return {
    id: fold.id,
    kind: fold.kind,
    parent: fold.parentId,
    children: childFoldIds(fold),
    previous: navigation.previous,
    next: navigation.next,
    state: projection,
    active: Boolean(interval),
    protected: blocked,
    sourceIds,
    sourceCount: allSourceIds.length,
    sourceIdsTruncated: sourceIds.length < allSourceIds.length,
    sourceSha256: fold.sourceSha256,
    actions: {
      primary: projection === "folded"
        ? { action: "expand", id: fold.id }
        : { action: "refold", id: fold.id },
      expand: { action: "expand", id: fold.id },
      refold: { action: "refold", id: fold.id },
      protect: { action: "protect", ids: [fold.id] },
    },
  };
}

export function activeContextStatus(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  offset = 0,
  limit = 40,
  maximumChapterSourceRefs = Number.MAX_SAFE_INTEGER,
): Record<string, unknown> {
  const roots = orderedRoots(state, snapshot).map((item) => item.fold.id);
  const byId = foldMap(state);
  const ordered: ActiveFold[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const fold = byId.get(id);
    if (!fold || seen.has(id)) return;
    seen.add(id);
    ordered.push(fold);
    for (const child of childFoldIds(fold)) visit(child);
  };
  for (const root of roots) visit(root);
  const selected = ordered.slice(offset, offset + limit);
  const protectedKeys = explicitProtectedKeys(state);
  const objects = snapshot.mapped.flatMap((item) => item.ref ? [{
    id: item.ref.entryId,
    role: item.ref.role,
    sha256: item.ref.sha256,
    position: item.index,
    stale: !snapshot.protectedIndices.has(item.index),
    protected: snapshot.protectedIndices.has(item.index) || protectedKeys.has(objectRefKey(item.ref)),
    staleToolResult: item.ref.role === "toolResult" &&
      !snapshot.toolProtectedIndices.has(item.index) && !protectedKeys.has(objectRefKey(item.ref)) &&
      resultCall(snapshot, item.index, true) !== null,
  }] : []);
  const selectedObjects = objects.slice(offset, offset + limit);
  const eligibleChapter = selectAutomaticChapter(snapshot, state, maximumChapterSourceRefs);
  const eligibleSourceIds = eligibleChapter?.sourceRefs.map((ref) => ref.entryId) ?? [];
  const eligibleEndpoints = eligibleSourceIds.length
    ? [...new Set([eligibleSourceIds[0], eligibleSourceIds.at(-1)!])]
    : [];
  return {
    version: 1,
    service: "active-context-folding",
    roots,
    folds: selected.map((fold) => foldStatusRow(fold, state, snapshot)),
    offset,
    nextOffset: offset + selected.length < ordered.length ? offset + selected.length : null,
    totalFolds: ordered.length,
    protectedSourceIds: state.protected.flatMap((ref) => exactMapped(snapshot, ref) ? [ref.entryId] : []),
    objects: selectedObjects,
    totalObjects: objects.length,
    nextObjectOffset: offset + selectedObjects.length < objects.length ? offset + selectedObjects.length : null,
    eligibleChapter: eligibleChapter ? {
      kind: "chapter",
      sourceCount: eligibleSourceIds.length,
      sourceIds: eligibleSourceIds.slice(0, 64),
      sourceIdsTruncated: eligibleSourceIds.length > 64,
      startId: eligibleSourceIds[0],
      endId: eligibleSourceIds.at(-1),
      action: { action: "fold", ids: eligibleEndpoints, brief: "<factual brief, at most 1000 characters>" },
    } : null,
    rawTailMinimumBytes: snapshot.policy.freshBytes,
    currentTurnRequiresBoundary: false,
    actions: {
      status: { action: "status", offset, limit },
      fold: { action: "fold", ids: ["<source-or-fold-id>"], brief: "<optional factual brief, at most 1000 characters>" },
      protect: { action: "protect", ids: ["<source-or-fold-id>"] },
    },
  };
}

function visibleCollapsedFolds(
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): ActiveFold[] {
  const byId = foldMap(state);
  const output: ActiveFold[] = [];
  const visit = (fold: ActiveFold): void => {
    const refs = flattenFoldRefs(fold, state);
    if (!foldInterval(fold, state, snapshot)) return;
    const protectedSource = fold.kind === "tool-result"
      ? toolRefsProtected(refs, state, snapshot)
      : refsProtected(refs, state, snapshot);
    if (!state.expanded.includes(fold.id) && !protectedSource) {
      output.push(fold);
      return;
    }
    for (const childId of childFoldIds(fold)) visit(byId.get(childId)!);
  };
  for (const root of orderedRoots(state, snapshot)) visit(root.fold);
  return output;
}

export function projectionSlateCandidates(
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
  limit = 16,
): Array<Record<string, unknown>> {
  return visibleCollapsedFolds(state, snapshot).slice(0, limit).flatMap((fold, rank) => {
    const replacement = renderFold(fold, state, snapshot);
    const expandedState = { ...state, expanded: [...state.expanded, fold.id] };
    const source = renderFold(fold, expandedState, snapshot);
    if (!replacement || !source) return [];
    const replacementBytes = bytes(replacement);
    const sourceBytes = bytes(source);
    const saved = sourceBytes - replacementBytes;
    if (saved <= 0) return [];
    const provenanceKind = (fold.provenance as { kind: string }).kind;
    const generator = provenanceKind === "model" || provenanceKind === "luna"
      ? "projection-model"
      : provenanceKind === "deterministic" ? "projection-deterministic" : "projection-supplied";
    return [{
      version: 1,
      key: `projection:${fold.id}`,
      kind: "projection",
      domain: "system",
      horizon: "working",
      source_id: fold.id,
      source_version: fold.sourceSha256,
      route: { tool: snapshot.toolName, arguments: { action: "expand", id: fold.id } },
      token_cost: Math.max(1, Math.ceil(replacementBytes / 4)),
      expansion_cost: Math.max(1, Math.ceil(sourceBytes / 4)),
      rank,
      score: Math.min(1, saved / sourceBytes),
      raw_score: saved,
      confidence: "exact",
      freshness: "current",
      locked_owner: false,
      collapse_key: `projection:${fold.id}`,
      generator,
      generator_version: "memory-slate-generators-v2",
      recency: null,
    }];
  });
}

export function recoverFoldMessages(input: {
  foldId: string;
  state: ActiveContextState;
  entries: Array<Record<string, unknown>>;
  sessionId: string;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
}): unknown[] {
  const fold = input.state.folds.find((item) => item.id === input.foldId);
  if (!fold) throw new Error(`Unknown active-context fold ${input.foldId}`);
  const projectEntry = input.projectEntry ?? sessionEntryMessages;
  const exact = new Map<string, unknown>();
  for (const entry of input.entries) {
    if (typeof entry?.id !== "string") continue;
    for (const message of projectEntry(entry)) {
      const ref = evidenceRef(input.sessionId, entry.id, message);
      exact.set(`${objectRefKey(ref)}:${ref.sha256}`, message);
    }
  }
  return flattenFoldRefs(fold, input.state).map((ref) => {
    if (ref.sessionId !== input.sessionId) throw new Error(`Fold source ${ref.entryId} belongs to another session`);
    const message = exact.get(`${objectRefKey(ref)}:${ref.sha256}`);
    if (!message || evidenceSha256(message) !== ref.sha256) {
      throw new Error(`Exact recovery failed for ${ref.entryId}`);
    }
    return clone(message);
  });
}

function toolPayload(value: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return Number(value);
}

function stringIds(value: unknown): string[] {
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

function boundedReceiptString(value: unknown, maximum = 1_200): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}

function boundReceiptText(value: unknown, maximum: number, fallback: string): string {
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

export type AdvisoryMilestone = "notice" | "tools" | "chapters" | "urgent";

export const ADVISORY_BUDGETS: Readonly<Record<AdvisoryMilestone, number>> = Object.freeze({
  notice: 2,
  tools: 2,
  chapters: 2,
  urgent: 3,
});

interface AdvisorySchedule {
  key: string;
  rungs: Array<{ milestone: AdvisoryMilestone; threshold: number; budget: number }>;
}

const ADVISORY_MILESTONES = Object.freeze(
  Object.keys(ADVISORY_BUDGETS) as AdvisoryMilestone[],
);

function validAdvisoryState(value: unknown): value is NonNullable<ActiveContextState["advisory"]> {
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
    Number.isSafeInteger(ownValue(delivered, key)) && Number(ownValue(delivered, key)) >= 0 &&
    Number(ownValue(delivered, key)) <= MAX_ADVISORY_DELIVERIES_PER_MILESTONE);
}

function advisoryState(state: ActiveContextState): NonNullable<ActiveContextState["advisory"]> {
  if (state.advisory === undefined) return { highWater: 0, delivered: {} };
  if (!validAdvisoryState(state.advisory)) {
    throw new Error("Corrupt in-memory advisory state (no silent fallback)");
  }
  return clone(state.advisory);
}

function clearArmedAdvisory(state: ActiveContextState): ActiveContextState {
  const current = advisoryState(state);
  if (!current.armed) return state;
  const { armed: _armed, ...advisory } = current;
  return { ...state, advisory };
}

export function advisorySchedule(
  snapshot: Pick<ActiveContextSnapshot, "policy" | "contextWindow">,
): AdvisorySchedule {
  const raw = [
    { milestone: "notice" as const, threshold: 0.50, budget: ADVISORY_BUDGETS.notice },
    { milestone: "tools" as const, threshold: snapshot.policy.toolFoldRatio - 0.04,
      budget: ADVISORY_BUDGETS.tools },
    { milestone: "chapters" as const, threshold: snapshot.policy.prepareRatio - 0.05,
      budget: ADVISORY_BUDGETS.chapters },
    { milestone: "urgent" as const, threshold: hardFenceRatio(snapshot) - 0.03,
      budget: ADVISORY_BUDGETS.urgent },
  ];
  for (let index = raw.length - 2; index >= 0; index -= 1) {
    raw[index].threshold = Math.min(raw[index].threshold, raw[index + 1].threshold - 0.02);
  }
  for (const rung of raw) rung.threshold = Math.max(0, Math.min(1, rung.threshold));
  return {
    key: sha256Value(raw.map(({ milestone, threshold }) => ({ milestone, threshold }))),
    rungs: raw,
  };
}

function updateAdvisoryMilestone(
  currentState: ActiveContextState,
  ratio: number,
  schedule: AdvisorySchedule,
  scheduleChanged: boolean,
  scheduleKey: string,
): { state: ActiveContextState; milestone: AdvisoryMilestone | null } {
  const current = advisoryState(currentState);
  if (scheduleChanged) {
    return {
      state: { ...currentState, advisory: { ...current, highWater: Math.min(1, ratio) } },
      milestone: null,
    };
  }
  let highWater = current.highWater;
  for (let index = schedule.rungs.length - 1; index >= 0; index -= 1) {
    const rung = schedule.rungs[index];
    if ((current.delivered[rung.milestone] ?? 0) > 0 && ratio < 0.85 * rung.threshold) {
      highWater = Math.min(highWater, index > 0 ? schedule.rungs[index - 1].threshold : 0);
    }
  }
  const crossed = schedule.rungs.filter((rung) =>
    highWater < rung.threshold && ratio >= rung.threshold &&
    (current.delivered[rung.milestone] ?? 0) < rung.budget);
  const selected = crossed.at(-1) ?? null;
  const delivered = { ...current.delivered };
  if (selected) delivered[selected.milestone] = (delivered[selected.milestone] ?? 0) + 1;
  const armed = selected
    ? { milestone: selected.milestone, threshold: selected.threshold, scheduleKey }
    : current.armed;
  return {
    state: {
      ...currentState,
      advisory: {
        highWater: Math.min(1, Math.max(highWater, ratio)),
        delivered,
        ...(armed ? { armed } : {}),
      },
    },
    milestone: selected?.milestone ?? null,
  };
}

function milestoneText(
  milestone: AdvisoryMilestone,
  sessionId: string,
  threshold: number,
  toolName: string,
): string {
  const percent = Math.round(threshold * 100);
  const prefix = `[Quorum context milestone ${milestone}; session ${sessionId.slice(0, 16)}]`;
  if (milestone === "notice") {
    return `${prefix} Context pressure has crossed ${percent}%. Automatic folding is available. ` +
      `Inspect candidates exactly with ${toolName} {"action":"status"}.`;
  }
  if (milestone === "tools") {
    return `${prefix} The read-only tool-fold rung begins at ${percent}%. ` +
      "Eligible completed tool batches can be folded now; current endpoint ids are in the live advisory.";
  }
  if (milestone === "chapters") {
    return `${prefix} The chapter preparation rung begins at ${percent}%. ` +
      `Use eligibleChapter endpoints with ${toolName} ` +
      '{"action":"fold","ids":["<start>","<end>"],"brief":"<factual brief>"}.';
  }
  return `${prefix} The hard context fence is near. The next automatic action is a committed chapter fold ` +
    "or the provider request is aborted before transmission.";
}

function liveAdvisoryText(input: {
  milestone: AdvisoryMilestone;
  ratio: number;
  toolEndpoints: string[];
  chapterEndpoints: string[];
  remediationCount: number;
}): string {
  const tools = input.toolEndpoints.length
    ? input.toolEndpoints.slice(0, 3).join(", ")
    : "none";
  const chapter = input.chapterEndpoints.length
    ? `${input.chapterEndpoints[0]}..${input.chapterEndpoints.at(-1)}`
    : "none";
  return boundReceiptText(
    `[Quorum context advisory] pressure ${Math.round(input.ratio * 100)}%; milestone ${input.milestone}; ` +
      `eligible read-only batch endpoints: ${tools}; eligibleChapter endpoints: ${chapter}; ` +
      `session milestone count: ${input.remediationCount}.`,
    2_048,
    "[Quorum context advisory] Live pressure details are unavailable.",
  );
}

export function registerActiveContext(pi: any, options: {
  summarizeContextSpan?: (request: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  setProjectionProvider?: (provider: (ctx: any) => Array<Record<string, unknown>>) => void;
  toolActions?: readonly ActiveContextToolAction[];
  toolName?: string;
  entryTypePrefix?: string;
  commandPrefix?: string;
  commandNames?: { status?: string; fold?: string };
  readOnlyTools?: ReadonlySet<string>;
  blockingTools?: readonly string[];
}): { projectionCandidates: (ctx: any) => Array<Record<string, unknown>> } {
  const toolName = options.toolName ?? "quorum_context";
  const entryTypePrefix = options.entryTypePrefix ?? "quorum-active-context";
  const commandPrefix = options.commandPrefix ?? "";
  const readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS_DEFAULT;
  if (!toolName || !entryTypePrefix || typeof commandPrefix !== "string" ||
      (commandPrefix && !/^[a-z0-9-]+$/.test(commandPrefix)) ||
      [...readOnlyTools].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Active-context names and read-only tools must be nonempty strings");
  }
  const commandStem = commandPrefix ? `${commandPrefix.replace(/-+$/, "")}-` : "";
  // Full-name override for hosts that need non-default command names (e.g. the
  // pi-fold package's neutral "context"); commandPrefix remains the derived form.
  const commandNames = {
    status: options.commandNames?.status ?? `${commandStem}quorum-context`,
    fold: options.commandNames?.fold ?? `${commandStem}fold-context`,
  };
  if (![commandNames.status, commandNames.fold].every((name) =>
      typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name)) ||
      commandNames.status === commandNames.fold) {
    throw new Error("Active-context command names must be distinct kebab-case strings");
  }
  const configuredBlockingTools = denseOwnArrayValues(options.blockingTools ?? ["Agent"]);
  if (!configuredBlockingTools || configuredBlockingTools.some((name) => typeof name !== "string" || !name) ||
      new Set(configuredBlockingTools).size !== configuredBlockingTools.length) {
    throw new Error("Blocking tools must be one dense array of unique nonempty strings");
  }
  const blockingTools = new Set(configuredBlockingTools as string[]);
  const stateEntryType = `${entryTypePrefix}-state`;
  const foldRecordEntryType = `${entryTypePrefix}-fold-record`;
  const milestoneProjectionType = `${entryTypePrefix}-milestone`;
  const advisoryProjectionType = `${entryTypePrefix}-advisory`;
  const defaultEntryTypes = entryTypePrefix === ACTIVE_CONTEXT_STATUS_KEY;
  const providerMeasurementEntryType = defaultEntryTypes
    ? PROVIDER_CONTEXT_MEASUREMENT_ENTRY
    : `${entryTypePrefix}-provider-context-measurement`;
  const nativeReceiptEntryType = defaultEntryTypes
    ? NATIVE_COMPACTION_RECEIPT_ENTRY
    : `${entryTypePrefix}-native-compaction-receipt`;
  const nativeDecisionEntryType = defaultEntryTypes
    ? NATIVE_COMPACTION_DECISION_ENTRY
    : `${entryTypePrefix}-native-compaction-decision`;
  const configuredToolActions = denseOwnArrayValues(
    options.toolActions ?? ACTIVE_CONTEXT_TOOL_ACTIONS,
  );
  if (!configuredToolActions || configuredToolActions.length < 1) {
    throw new Error("Active-context tool actions must be one non-empty dense array");
  }
  const allowedToolActions: ActiveContextToolAction[] = [];
  const allowedToolActionSet = new Set<string>();
  for (const value of configuredToolActions) {
    if (typeof value !== "string" ||
        !ACTIVE_CONTEXT_TOOL_ACTIONS.includes(value as ActiveContextToolAction) ||
        allowedToolActionSet.has(value)) {
      throw new Error(`Invalid or duplicate active-context tool action '${String(value)}'`);
    }
    allowedToolActions.push(value as ActiveContextToolAction);
    allowedToolActionSet.add(value);
  }
  Object.freeze(allowedToolActions);

  type AutomaticFailureState = {
    key: string;
    phase: string;
    message: string;
    firstFailedAt: number;
    attempts: 1;
    suppressedCallbacks: number;
    persistenceDisposition: "none" | "record-only" | "state-committed";
  };

  let generation = 0;
  let shuttingDown = false;
  let state: ActiveContextState | null = null;
  let persisted: ActiveContextState | null = null;
  let latestSnapshot: ActiveContextSnapshot | null = null;
  let latestSnapshotError: string | null = null;
  let latestRatio: number | null = null;
  let lastProviderMeasurement: ProviderContextMeasurement | null = null;
  let pendingManual = false;
  let preparing: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  let lastThresholdDecision: Record<string, unknown> | null = null;
  let pendingNativeReceipt: NativeCompactionCompletionReceipt | null = null;
  let lastPreparationError: string | null = null;
  let boundaryFailure: string | null = null;
  let lastPreparationCandidateId: string | null = null;
  let lastSelectionKind: FoldKind | "refold" | null = null;
  let lastSelectionSourceIds: string[] = [];
  let pendingContextNote: string | null = null;
  let historicalGuidanceEntries = 0;
  let armedMilestone: AdvisoryMilestone | null = null;
  let advisoryScheduleKey: string | null = null;
  let lastAutomaticAction: Record<string, unknown> | null = null;
  let automaticFailure: AutomaticFailureState | null = null;
  let hardFenceNoticeKey: string | null = null;
  let hardFenceReleaseSessionId: string | null = null;
  let blockingToolHarvestedThisTurn = false;
  let blockingToolHarvestQueuedThisTurn = false;
  const hardFenceReleasedProjectionKeys = new Set<string>();
  const failedPreparations = new Set<string>();
  let actionQueue = Promise.resolve<unknown>(undefined);
  let persistenceQueue = Promise.resolve<void>(undefined);
  let providerMeasurementQueue = Promise.resolve<void>(undefined);
  const providerMeasurementReceipts = new Set<string>();
  const providerMeasurementRevisionByMessageSha = new Map<string, number>();
  const providerMeasurementByMessageSha = new Map<string, ProviderContextMeasurementReceipt>();
  const providerMeasurementAnchorByMessageSha = new Map<string, ProviderMeasurementAnchor>();
  let persistedWireVersion: 0 | 1 | 2 = 0;
  let persistedStateSha256 = "";
  let persistedFoldRecords = new Map<string, FoldRecordEntry>();
  let nativeReceiptQueue = Promise.resolve<void>(undefined);
  let contextQueue = Promise.resolve<void>(undefined);

  const durableProviderMeasurementReceiptMatches = (
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): boolean => {
    const receipt = providerMeasurementByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && receipt.projectionRevision === projectionRevision &&
      receipt.provider === measurement.provider && receipt.model === measurement.model &&
      receipt.tokens === measurement.tokens && receipt.contextWindow === measurement.contextWindow);
  };

  const durableProviderMeasurementMatches = (
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!state) return false;
    const receipt = providerMeasurementByMessageSha.get(measurement.messageSha256);
    const anchor = providerMeasurementAnchorByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && anchor && anchor.sessionId === state.sessionId &&
      anchor.generation === generation &&
      anchor.topologySha256 === topologySha256(state) &&
      anchor.protectionSha256 === protectionSha256(state) &&
      receipt.provider === measurement.provider && receipt.model === measurement.model &&
      receipt.tokens === measurement.tokens && receipt.contextWindow === measurement.contextWindow);
  };

  const safeNotify = (ctx: any, message: string, level: "info" | "warning" | "error"): void => {
    try { ctx.ui?.notify?.(message, level); } catch { /* Presentation cannot block Pi lifecycle progress. */ }
  };

  const contextSessionMatches = (ctx: any, sessionId: string): boolean => {
    try { return ctx.sessionManager.getSessionId() === sessionId; }
    catch { return false; }
  };

  const sessionIdentityStillValid = (ctx: any, sessionId: string, expectedGeneration: number): boolean =>
    generation === expectedGeneration && state?.sessionId === sessionId &&
    (!ctx || contextSessionMatches(ctx, sessionId));

  const updateStatus = (ctx: any): void => {
    try {
      const roots = state && latestSnapshot ? orderedRoots(state, latestSnapshot).length : 0;
      const prepared = state?.prepared ? " · brief ready" : preparing ? " · briefing" : "";
      const usage = lastProviderMeasurement
        ? ` · provider ${lastProviderMeasurement.tokens}/${lastProviderMeasurement.contextWindow}`
        : " · provider usage unmeasured";
      const suspended = automaticFailure ? " · automatic suspended" : "";
      ctx.ui?.setStatus?.(entryTypePrefix, `${toolName} folds: ${roots}${prepared}${usage}${suspended}`);
    } catch { /* Status presentation is request-ephemeral and never a lifecycle boundary. */ }
  };

  const snapshotForEvent = (ctx: any, messages: unknown[]): ActiveContextSnapshot => mapActiveContext({
    sessionId: ctx.sessionManager.getSessionId(),
    eventMessages: messages,
    contextEntries: ctx.sessionManager.buildContextEntries(),
    toolName,
    entryTypePrefix,
    readOnlyTools,
    contextWindow: contextWindowFor(ctx) ?? undefined,
  });

  const authoritativeSnapshotFor = (ctx: any): ActiveContextSnapshot => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!latestSnapshot || latestSnapshot.sessionId !== sessionId) {
      throw new Error("A current same-session Pi context event is required");
    }
    return mapActiveContext({
      sessionId,
      eventMessages: latestSnapshot.messages,
      contextEntries: ctx.sessionManager.buildContextEntries(),
      policy: latestSnapshot.policy,
      toolName,
      entryTypePrefix,
      readOnlyTools,
      contextWindow: contextWindowFor(ctx) ?? undefined,
    });
  };

  const providerMeasurementBranchIndex = (
    ctx: any,
    measurement: ProviderContextMeasurement,
  ): number => {
    let branch: unknown[] | null = null;
    try { branch = denseOwnArrayValues(ctx.sessionManager.getBranch()); }
    catch { return -1; }
    if (!branch) return -1;
    const anchor = uniqueMessageDigestAnchor(branch, measurement.messageSha256);
    if (!anchor) return -1;
    const candidate = providerContextMeasurement(
      anchor.message,
      measurement.contextWindow,
      { provider: measurement.provider, id: measurement.model },
    );
    return candidate?.messageSha256 === measurement.messageSha256 &&
      candidate.tokens === measurement.tokens ? anchor.index : -1;
  };

  const cancelPreparation = (): void => {
    preparing?.controller.abort();
    preparing = null;
  };

  const providerMeasurementReceiptKey = (
    sessionId: string,
    projectionRevision: number,
    measurement: Pick<ProviderContextMeasurement, "messageSha256" | "provider" | "model">,
  ): string => sha256Value({
    sessionId,
    projectionRevision,
    messageSha256: measurement.messageSha256,
    provider: measurement.provider,
    model: measurement.model,
  });

  const load = (ctx: any, preserveThresholdDecision = false): void => {
    generation += 1;
    shuttingDown = false;
    cancelPreparation();
    latestSnapshot = null;
    latestSnapshotError = null;
    latestRatio = null;
    lastProviderMeasurement = null;
    pendingManual = false;
    blockingToolHarvestedThisTurn = false;
    blockingToolHarvestQueuedThisTurn = false;
    if (!preserveThresholdDecision) lastThresholdDecision = null;
    lastPreparationError = null;
    boundaryFailure = null;
    lastPreparationCandidateId = null;
    lastSelectionKind = null;
    lastSelectionSourceIds = [];
    pendingContextNote = null;
    historicalGuidanceEntries = 0;
    armedMilestone = null;
    advisoryScheduleKey = null;
    lastAutomaticAction = null;
    automaticFailure = null;
    hardFenceNoticeKey = null;
    failedPreparations.clear();
    providerMeasurementReceipts.clear();
    providerMeasurementRevisionByMessageSha.clear();
    providerMeasurementByMessageSha.clear();
    providerMeasurementAnchorByMessageSha.clear();
    const sessionId = ctx.sessionManager.getSessionId();
    if (hardFenceReleaseSessionId !== sessionId) {
      hardFenceReleaseSessionId = sessionId;
      hardFenceReleasedProjectionKeys.clear();
    }
    let restored: ActiveContextState | null = null;
    let restoreError: unknown = null;
    let restoredPersistence: MaterializedStatePersistence | null = null;
    let measurementRestoreError: unknown = null;
    const branchEntries = [...ctx.sessionManager.getBranch()];
    try {
      restoredPersistence = materializeStatePersistence(
        branchEntries,
        sessionId,
        stateEntryType,
        foldRecordEntryType,
      );
      restored = restoredPersistence.state;
    } catch (error) {
      restoreError = error;
    }
    for (const entry of branchEntries) {
      if (entry?.type !== "custom") continue;
      if (typeof entry.customType === "string" && [
        `${entryTypePrefix}-guidance-`,
        `${ACTIVE_CONTEXT_STATUS_KEY}-guidance-`,
      ].some((prefix) => entry.customType.startsWith(prefix))) {
        historicalGuidanceEntries += 1;
        continue;
      }
      if (entry.customType !== providerMeasurementEntryType) continue;
      try {
        const receipt = parseProviderContextMeasurementReceipt(entry.data, sessionId);
        const boundRevision = providerMeasurementRevisionByMessageSha.get(receipt.messageSha256);
        if (boundRevision !== undefined && boundRevision !== receipt.projectionRevision) {
          throw new Error("One provider response is bound to multiple projection revisions");
        }
        providerMeasurementRevisionByMessageSha.set(receipt.messageSha256, receipt.projectionRevision);
        const priorMeasurement = providerMeasurementByMessageSha.get(receipt.messageSha256);
        if (priorMeasurement && stableStringify(priorMeasurement) !== stableStringify(receipt)) {
          throw new Error("One provider response has conflicting durable measurement receipts");
        }
        providerMeasurementByMessageSha.set(receipt.messageSha256, receipt);
        const fingerprint = restoredPersistence?.projectionFingerprints.get(receipt.projectionRevision);
        if (fingerprint) {
          providerMeasurementAnchorByMessageSha.set(receipt.messageSha256, {
            sessionId,
            generation,
            ...fingerprint,
          });
        }
        providerMeasurementReceipts.add(providerMeasurementReceiptKey(
          sessionId,
          receipt.projectionRevision,
          receipt,
        ));
      } catch (error) {
        measurementRestoreError = error;
      }
    }
    const durableRestored = restored ?? emptyActiveContextState(sessionId);
    state = durableRestored.prepared ? clearPrepared(durableRestored) : clone(durableRestored);
    armedMilestone = advisoryState(state).armed?.milestone ?? null;
    persistedWireVersion = restoredPersistence?.wireVersion ?? 0;
    persistedFoldRecords = restoredPersistence?.records ?? new Map<string, FoldRecordEntry>();
    persistedStateSha256 = restoredPersistence?.stateSha256 ?? semanticStateSha256(durableRestored);
    const restoredMessages = ctx.sessionManager.buildSessionContext?.()?.messages;
    lastProviderMeasurement = latestProviderContextMeasurement(
      Array.isArray(restoredMessages) ? restoredMessages : [],
      contextWindowFor(ctx),
      ctx.model,
    );
    latestRatio = contextUsageRatio(lastProviderMeasurement);
    persisted = clone(durableRestored);
    if (restoreError) safeNotify(
      ctx,
      `Active-context state was ignored; Pi native context remains authoritative: ${String(restoreError)}`,
      "warning",
    );
    if (measurementRestoreError) safeNotify(
      ctx,
      `Malformed provider measurement receipt was ignored; automatic context remains unmeasured: ${String(measurementRestoreError)}`,
      "warning",
    );
    updateStatus(ctx);
  };
  const persist = (ctx?: any): Promise<void> => {
    const operation = persistenceQueue.then(async () => {
      if (!state || !persisted) return;
      let next = clone(state);
      if (ctx && latestSnapshot?.sessionId === next.sessionId) {
        next = persistenceProjection(next, authoritativeSnapshotFor(ctx));
      }
      next.folds = normalizeFoldsForPersistedRecords(next.folds, persistedFoldRecords);
      if (sameStateProjection(next, persisted)) {
        state = clone(persisted);
        return;
      }
      if (next.revision <= persisted.revision) next.revision = persisted.revision + 1;
      const generationAtStart = generation;
      const sessionId = next.sessionId;
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before persistence");
      }
      if (next.folds.length > MAX_ACTIVE_FOLD_RECORDS) {
        throw new Error("Active-context fold closure exceeds persistence limit");
      }
      for (const fold of next.folds) {
        const record = makeFoldRecordEntry(fold, sessionId);
        const existing = persistedFoldRecords.get(record.foldId);
        if (existing) {
          if (existing.recordSha256 !== record.recordSha256) {
            throw new Error(`Conflicting durable active-context fold ${record.foldId}`);
          }
          continue;
        }
        await pi.appendEntry(foldRecordEntryType, record);
        persistedFoldRecords.set(record.foldId, record);
        if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
          if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
          throw new Error("Active-context session changed after fold-record persistence");
        }
      }
      const wire = persistedWireVersion === 2 ? makeStateDelta(persisted, next) : makeStateCheckpoint(next);
      if (persistedWireVersion === 2 && persistedStateSha256 !== semanticStateSha256(persisted)) {
        throw new Error("Active-context durable base digest drift");
      }
      await pi.appendEntry(stateEntryType, wire);
      // Once the state event succeeds, replay owns this exact state; RAM may not roll behind it.
      persisted = clone(next);
      persistedWireVersion = 2;
      persistedStateSha256 = semanticStateSha256(next);
      state = shuttingDown ? null : clone(next);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
        throw new Error("Active-context session changed after durable persistence");
      }
    });
    persistenceQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistThroughActionQueue = (ctx?: any): Promise<void> => {
    const operation = actionQueue.then(() => persist(ctx));
    actionQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistProviderMeasurement = (
    ctx: any,
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): Promise<boolean> => {
    if (!state || !Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return Promise.resolve(false);
    }
    const generationAtStart = generation;
    const sessionId = state.sessionId;
    const queuedMeasurement = clone(measurement);
    const revision = projectionRevision;
    const anchor: ProviderMeasurementAnchor = {
      sessionId,
      generation: generationAtStart,
      topologySha256: topologySha256(state),
      protectionSha256: protectionSha256(state),
    };
    const operation = providerMeasurementQueue.then(async () => {
      if (shuttingDown || !sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before measurement persistence");
      }
      const measurement = queuedMeasurement;
      const boundRevision = providerMeasurementRevisionByMessageSha.get(measurement.messageSha256);
      if (boundRevision !== undefined) {
        return boundRevision === revision &&
          durableProviderMeasurementReceiptMatches(measurement, revision);
      }
      const receiptKey = providerMeasurementReceiptKey(sessionId, revision, measurement);
      if (providerMeasurementReceipts.has(receiptKey)) {
        providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
        return durableProviderMeasurementReceiptMatches(measurement, revision);
      }
      const receipt = parseProviderContextMeasurementReceipt({
        version: 1,
        sessionId,
        projectionRevision: revision,
        messageSha256: measurement.messageSha256,
        provider: measurement.provider,
        model: measurement.model,
        tokens: measurement.tokens,
        contextWindow: measurement.contextWindow,
        occurredAt: Date.now(),
      }, sessionId);
      await pi.appendEntry(providerMeasurementEntryType, receipt);
      // The append is authoritative even if lifecycle attribution changes immediately after it.
      providerMeasurementReceipts.add(receiptKey);
      providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
      providerMeasurementByMessageSha.set(measurement.messageSha256, receipt);
      providerMeasurementAnchorByMessageSha.set(measurement.messageSha256, anchor);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed during measurement persistence");
      }
      return true;
    });
    providerMeasurementQueue = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const makeNativeDecision = (
    ctx: any,
    reason: string,
    willRetry: boolean,
    failureCode: string,
    message: string,
  ): NativeCompactionDecisionReceipt => {
    const sessionId = ctx.sessionManager.getSessionId();
    const triggerEntryId = boundReceiptText(ctx.sessionManager.getLeafId?.(), 512, "no-leaf");
    const boundedReason = boundReceiptText(reason, 64, "unknown");
    const boundedFailureCode = boundReceiptText(failureCode, 128, "unspecified-native-fallback");
    const decision: NativeCompactionDecisionReceipt = {
      version: 1,
      decisionKey: sha256Value({
        sessionId, triggerEntryId, reason: boundedReason, failureCode: boundedFailureCode,
      }),
      sessionId,
      triggerEntryId,
      reason: boundedReason,
      willRetry,
      failureCode: boundedFailureCode,
      message: boundReceiptText(message, 1_200, "Pi native compaction safety net allowed"),
      preparationError: lastPreparationError
        ? boundReceiptText(lastPreparationError, 1_200, "context preparation failed")
        : null,
      boundaryFailure: boundaryFailure
        ? boundReceiptText(boundaryFailure, 1_200, "context boundary failed")
        : null,
      selectionKind: lastSelectionKind ? boundReceiptText(lastSelectionKind, 64, "unknown") : null,
      selectionSourceIds: lastSelectionSourceIds.slice(0, 64)
        .map((id) => boundReceiptText(id, 512, "unknown-source")),
      automaticActionKind: typeof ownValue(lastAutomaticAction, "kind") === "string"
        ? boundReceiptText(ownValue(lastAutomaticAction, "kind"), 128, "unknown")
        : null,
      providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
      occurredAt: Date.now(),
    };
    return parseNativeCompactionDecision(decision, sessionId);
  };

  const buildNativeCompletion = (
    event: Record<string, unknown>,
    ctx: any,
    decision: NativeCompactionDecisionReceipt,
  ): NativeCompactionCompletionReceipt => {
    const entry = ownValue(event, "compactionEntry");
    const compactionEntryId = String(ownValue(entry, "id") ?? "");
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
    const persistedCompaction = entries.find((candidate: any) =>
      candidate?.type === "compaction" && candidate.id === compactionEntryId);
    if (!persistedCompaction) {
      throw new Error(`Native completion does not reference a persisted compaction entry: ${compactionEntryId || "missing"}`);
    }
    return parseNativeCompactionCompletion({
      version: 2,
      receiptKey: sha256Value({ sessionId, compactionEntryId }),
      sessionId,
      compactionEntryId,
      reason: boundReceiptText(ownValue(event, "reason"), 64, decision.reason),
      willRetry: ownValue(event, "willRetry") === true,
      fromExtension: ownValue(event, "fromExtension") === true,
      occurredAt: Date.now(),
      goal: "zero-native-compactions",
      decision,
    }, sessionId);
  };

  const persistNativeCompletion = (receipt: NativeCompactionCompletionReceipt, ctx: any): Promise<void> => {
    const operation = nativeReceiptQueue.then(async () => {
      const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
      const existing = entries
        .filter((entry: any) => entry?.type === "custom" && entry.customType === nativeReceiptEntryType &&
          ownValue(entry.data, "version") === 2)
        .map((entry: any) => parseNativeCompactionCompletion(entry.data, receipt.sessionId))
        .find((item: NativeCompactionCompletionReceipt) => item.receiptKey === receipt.receiptKey);
      if (existing) {
        if (stableStringify(existing) !== stableStringify(receipt)) {
          throw new Error(`Conflicting native compaction receipt ${receipt.receiptKey}`);
        }
      } else {
        await pi.appendEntry(nativeReceiptEntryType, receipt);
      }
      pendingNativeReceipt = null;
    });
    nativeReceiptQueue = operation.catch(() => undefined);
    return operation;
  };

  const recoverNativeReceipts = async (ctx: any): Promise<void> => {
    if (pendingNativeReceipt) await persistNativeCompletion(pendingNativeReceipt, ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = [...(ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch())];
    const completions = new Map<string, NativeCompactionCompletionReceipt>();
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== nativeReceiptEntryType ||
          ownValue(entry.data, "version") !== 2) continue;
      const receipt = parseNativeCompactionCompletion(entry.data, sessionId);
      completions.set(receipt.decision.decisionKey, receipt);
    }
    const usedCompactions = new Set([...completions.values()].map((receipt) => receipt.compactionEntryId));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as any;
      if (entry?.type !== "custom" || entry.customType !== nativeDecisionEntryType) continue;
      const decision = parseNativeCompactionDecision(entry.data, sessionId);
      if (completions.has(decision.decisionKey)) continue;
      const compaction = entries.find((candidate: any) =>
        candidate?.type === "compaction" && !usedCompactions.has(candidate.id) &&
        (candidate.parentId === entry.id || candidate.id === decision.triggerEntryId)) as any;
      if (!compaction) continue;
      const receipt = parseNativeCompactionCompletion({
        version: 2,
        receiptKey: sha256Value({ sessionId, compactionEntryId: compaction.id }),
        sessionId,
        compactionEntryId: compaction.id,
        reason: decision.reason,
        willRetry: decision.willRetry,
        fromExtension: compaction.fromHook === true,
        occurredAt: Number.isFinite(Date.parse(String(compaction.timestamp)))
          ? Date.parse(String(compaction.timestamp))
          : decision.occurredAt,
        goal: "zero-native-compactions",
        decision,
      }, sessionId);
      await persistNativeCompletion(receipt, ctx);
      completions.set(decision.decisionKey, receipt);
      usedCompactions.add(compaction.id);
    }
    const latest = [...completions.values()].sort((left, right) => left.occurredAt - right.occurredAt).at(-1);
    if (latest) {
      lastThresholdDecision = {
        handled: true,
        retry: false,
        reason: "native compaction completed; Quorum folding state rebuilt",
        compactionReason: latest.reason,
        nativeCompactionCompleted: true,
        receiptKey: latest.receiptKey,
        decision: latest.decision,
      };
    }
  };

  const markManual = (
    next: ActiveContextState,
    action: Exclude<ActiveContextToolAction, "status">,
  ): void => {
    cancelPreparation();
    state = clearPrepared(next);
    pendingManual = true;
    if (action === "fold") armedMilestone = null;
    boundaryFailure = null;
  };

  const persistManual = async (
    next: ActiveContextState,
    action: Exclude<ActiveContextToolAction, "status">,
    ctx: any,
  ): Promise<void> => {
    const stateAtEntry = state ? clone(state) : null;
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    markManual(next, action);
    try {
      await persist(ctx);
      pendingManual = false;
      automaticFailure = null;
      boundaryFailure = null;
    } catch (error) {
      if (persisted === persistedAtEntry && stateAtEntry) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      boundaryFailure = error instanceof Error ? error.message : String(error);
      safeNotify(ctx, `Active-context change was not persisted: ${boundaryFailure}`, "error");
      throw error;
    }
  };

  const captureTransient = () => ({
    pendingManual,
    preparing,
    pendingContextNote,
    armedMilestone,
    lastAutomaticAction,
    automaticFailure: automaticFailure ? clone(automaticFailure) : null,
    boundaryFailure,
  });
  const restoreTransient = (saved: ReturnType<typeof captureTransient>): void => {
    pendingManual = saved.pendingManual;
    preparing = saved.preparing?.controller.signal.aborted ? null : saved.preparing;
    pendingContextNote = saved.pendingContextNote;
    armedMilestone = saved.armedMilestone;
    lastAutomaticAction = saved.lastAutomaticAction;
    automaticFailure = saved.automaticFailure;
    boundaryFailure = saved.boundaryFailure;
  };
  const automaticOperationKey = (
    phase: string,
    snapshot: ActiveContextSnapshot | null = latestSnapshot,
    ratio: number | null = latestRatio,
  ): string => {
    const lifecyclePhase = ["context", "message-end", "turn-end"].includes(phase) ? "automatic-rung" : phase;
    let selection: Record<string, unknown> = { kind: lifecyclePhase };
    try {
      if (state && snapshot && ratio !== null) {
        const selected = selectAutomaticRung(snapshot, state, ratio, {
          summarizerAvailable: Boolean(options.summarizeContextSpan),
          failedPreparationIds: failedPreparations,
        });
        if (selected?.kind === "refold") {
          selection = { kind: "refold", foldId: selected.foldId };
        } else if (selected && "candidate" in selected) {
          selection = {
            kind: selected.kind === "prepared-chapter" || selected.kind === "chapter"
              ? "chapter-fold"
              : selected.kind,
            refs: selected.candidate.sourceRefs.map(objectRefKey),
          };
        }
      }
    } catch {
      selection = { kind: `${lifecyclePhase}-selection` };
    }
    return sha256Value({
      sessionId: state?.sessionId ?? snapshot?.sessionId ?? null,
      revision: state?.revision ?? null,
      topology: state ? topologySha256(state) : null,
      protection: state ? protectionSha256(state) : null,
      selection,
      policy: snapshot ? {
        toolFoldRatio: snapshot.policy.toolFoldRatio,
        refoldRatio: snapshot.policy.refoldRatio,
        prepareRatio: snapshot.policy.prepareRatio,
        hardFenceRatio: hardFenceRatio(snapshot),
        consolidationRatio: snapshot.policy.consolidationRatio,
      } : null,
    });
  };

  const suspendAutomatic = (
    error: unknown,
    phase: string,
    ctx: any,
    key = automaticOperationKey(phase),
    persistenceDisposition: AutomaticFailureState["persistenceDisposition"] = "none",
  ): void => {
    const message = boundReceiptText(
      error instanceof Error ? error.message : String(error),
      1_200,
      "automatic context failure",
    );
    boundaryFailure = message;
    cancelPreparation();
    if (state?.prepared) state = clearPrepared(state);
    if (automaticFailure) {
      automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        automaticFailure.suppressedCallbacks + 1,
      );
      return;
    }
    automaticFailure = {
      key,
      phase,
      message,
      firstFailedAt: Date.now(),
      attempts: 1,
      suppressedCallbacks: 0,
      persistenceDisposition,
    };
    pendingContextNote = `Automatic context management suspended after one ${phase} failure; exact Pi context remains raw and manual context actions remain available.`;
    safeNotify(ctx, `Automatic context management suspended: ${message}`, "warning");
  };

  const abortUnsafeHardContext = (
    snapshot: ActiveContextSnapshot | null,
    ctx: any,
    allowUnmeasuredRevisionRelease = false,
  ): boolean => {
    if (latestRatio === null || latestRatio < hardFenceRatio(snapshot ?? undefined, ctx) || !state) return false;
    const measuredRevision = lastProviderMeasurement
      ? providerMeasurementRevisionByMessageSha.get(lastProviderMeasurement.messageSha256)
      : undefined;
    // A durable projection topology after the measured response gets exactly
    // one provider attempt so its fold can be measured. Concurrent
    // callbacks, retries, and same-session reloads may not repeatedly release
    // that unmeasured projection. Non-structural state persistence does not
    // spend this release. A failed automatic transaction never gets this
    // escape, even if a record/state append preceded its projection failure.
    if (allowUnmeasuredRevisionRelease && !automaticFailure &&
        measuredRevision !== undefined && lastProviderMeasurement &&
        !durableProviderMeasurementMatches(lastProviderMeasurement)) {
      const releaseKey = sha256Value({
        sessionId: state.sessionId,
        topologySha256: topologySha256(state),
        protectionSha256: protectionSha256(state),
        measuredRevision,
        providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
      });
      if (!hardFenceReleasedProjectionKeys.has(releaseKey) &&
          hardFenceReleasedProjectionKeys.size < 4_096) {
        hardFenceReleasedProjectionKeys.add(releaseKey);
        return false;
      }
    }
    const key = automaticFailure?.key ?? sha256Value({
      sessionId: snapshot?.sessionId ?? state.sessionId,
      revision: state.revision,
      providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
      phase: "hard-provider-fence",
    });
    pendingContextNote = "Provider context reached the hard Quorum fence without a newly committed lossless fold. The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.";
    if (hardFenceNoticeKey !== key) {
      hardFenceNoticeKey = key;
      safeNotify(
        ctx,
        "Provider request aborted at the hard context fence; run /compact or make an explicit bounded context fold.",
        "error",
      );
    }
    // Stock Pi exposes abort() in every extension event context. Calling it
    // here aborts the signal passed to the provider stream after this context
    // transform returns, so exact raw Pi messages remain canonical but are not
    // transmitted as an overflowing request.
    if (typeof ctx.abort !== "function") {
      throw new Error(`Pi hard-fence abort capability is unavailable at ratio ${latestRatio}`);
    }
    ctx.abort();
    return true;
  };

  const startPreparation = (snapshot: ActiveContextSnapshot, ratio: number | null, ctx: any): void => {
    if (shuttingDown || !state || automaticFailure || ratio === null || state.prepared || preparing ||
        ratio < snapshot.policy.warmRatio ||
        !lastProviderMeasurement || !durableProviderMeasurementMatches(lastProviderMeasurement)) return;
    // Preparation is asynchronous but never jumps ahead of an immediately
    // committable deterministic fold on the same measured projection.
    const selection = selectAutomaticRung(snapshot, state, ratio, {
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: failedPreparations,
    });
    lastSelectionKind = selection && "candidate" in selection ? selection.candidate.kind : null;
    lastSelectionSourceIds = selection && "candidate" in selection
      ? selection.candidate.sourceRefs.slice(0, 8).map((ref) => ref.entryId)
      : [];
    if (selection?.kind !== "chapter-prepare") return;
    const candidate = selection.candidate;
    const id = automaticPreparationId(candidate, state);
    const controller = new AbortController();
    lastPreparationError = null;
    lastPreparationCandidateId = id;
    const slot = { id, controller, promise: Promise.resolve() };
    preparing = slot;
    const capturedState = clone(state);
    const capturedGeneration = generation;
    slot.promise = prepareFold({
      candidate,
      snapshot,
      state: capturedState,
      generation: capturedGeneration,
      summarize: failedPreparations.has(id) ? undefined : options.summarizeContextSpan,
      onSummarizerFailure: (error) => {
        lastPreparationError = error instanceof Error ? error.message : String(error);
        failedPreparations.add(id);
      },
      ctx,
      signal: controller.signal,
    }).then((preparedFold) => {
      const operation = actionQueue.then(() => {
        if (controller.signal.aborted ||
            !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
        const currentState = state;
        if (!currentState || topologySha256(currentState) !== preparedFold.topologySha256 ||
            protectionSha256(currentState) !== preparedFold.protectionSha256) return;
        state = { ...currentState, prepared: preparedFold };
        return persist(ctx);
      });
      actionQueue = operation.catch(() => undefined);
      return operation;
    }).catch((error) => {
      if (controller.signal.aborted ||
          !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
      lastPreparationError = error instanceof Error ? error.message : String(error);
      failedPreparations.add(id);
      suspendAutomatic(
        error,
        "chapter-prepare",
        ctx,
        sha256Value({ sessionId: snapshot.sessionId, operation: "chapter-prepare", candidateId: id }),
      );
    }).finally(() => {
      const ownsSlot = preparing === slot;
      if (ownsSlot) preparing = null;
      if (ownsSlot && sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) updateStatus(ctx);
    });
  };
  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const projected = projectActiveContext(snapshot, state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType;
    });
    const armed = advisoryState(state!).armed;
    if (!armed || armed.milestone !== armedMilestone || latestRatio === null ||
        latestRatio < 0.85 * armed.threshold) return projected;
    const status = activeContextStatus(snapshot, state!, 0, 1, snapshot.policy.maxFoldSourceRefs);
    const eligible = ownValue(status, "eligibleChapter");
    const startId = ownValue(eligible, "startId");
    const endId = ownValue(eligible, "endId");
    const chapterEndpoints = typeof startId === "string" && typeof endId === "string"
      ? [startId, endId]
      : [];
    const toolEndpoints = selectAutomaticToolBatch(snapshot, state!, 1)
      .flatMap((candidate) => candidate.sourceRefs.at(-1)?.entryId ?? [])
      .slice(0, 3);
    const remediationCount = advisoryState(state!).delivered[armed.milestone] ?? 0;
    projected.push({
      role: "custom",
      customType: milestoneProjectionType,
      content: milestoneText(armed.milestone, state!.sessionId, armed.threshold, toolName),
      display: false,
      details: { source: "quorum/active-context", ephemeral: true, milestone: armed.milestone },
      timestamp: 0,
    });
    projected.push({
      role: "custom",
      customType: advisoryProjectionType,
      content: liveAdvisoryText({
        milestone: armed.milestone,
        ratio: latestRatio,
        toolEndpoints,
        chapterEndpoints,
        remediationCount,
      }),
      display: false,
      details: { source: "quorum/active-context", ephemeral: true, milestone: armed.milestone },
      timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
        ? ownValue(snapshot.messages.at(-1), "timestamp")
        : 0,
    });
    return projected;
  };
  const commitDeterministicCandidate = async (
    snapshot: ActiveContextSnapshot,
    candidate: FoldCandidate,
    brief: string,
  ): Promise<string> => {
    const preparedFold = await prepareFold({
      candidate,
      snapshot,
      state: state!,
      generation,
      brief,
      briefProvenance: "deterministic",
    });
    state = commitPreparedFold({ prepared: preparedFold, snapshot, state: state!, generation });
    return preparedFold.id;
  };

  const prepareAndCommitExplicit = async (input: {
    snapshot: ActiveContextSnapshot;
    candidate: FoldCandidate;
    brief?: string;
    ctx: any;
    signal?: AbortSignal;
    maximumSourceChars?: number;
  }): Promise<{ preparedFold: PreparedFold; nextState: ActiveContextState }> => {
    const baseState = state!;
    const generationAtStart = generation;
    const sessionId = baseState.sessionId;
    const sourceChars = bytes(encodedFoldSource(input.snapshot, baseState, input.candidate.parts, input.candidate.kind));
    if (sourceChars > (input.maximumSourceChars ?? USER_RESCUE_MAX_SOURCE_CHARS)) {
      throw new Error(`Selected fold source is ${sourceChars} bytes; choose a smaller bounded span`);
    }
    const preparedFold = await prepareFold({
      candidate: input.candidate,
      snapshot: input.snapshot,
      state: baseState,
      generation: generationAtStart,
      brief: input.brief,
      summarize: options.summarizeContextSpan,
      ctx: input.ctx,
      signal: input.signal,
    });
    if (!sessionIdentityStillValid(input.ctx, sessionId, generationAtStart)) {
      throw new Error("Active-context session changed while preparing the explicit fold");
    }
    const current = authoritativeSnapshotFor(input.ctx);
    if (!sessionIdentityStillValid(input.ctx, sessionId, generationAtStart)) {
      throw new Error("Active-context session changed during explicit fold revalidation");
    }
    const nextState = commitPreparedFold({
      prepared: preparedFold,
      snapshot: current,
      state: state!,
      generation: generationAtStart,
    });
    return { preparedFold, nextState };
  };

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!state || automaticFailure || preparing) return null;
    const selection = selectAutomaticRung(snapshot, state, ratio, {
      waiveToolCadence: rungOptions.waiveToolCadence,
      toolOnly: rungOptions.toolOnly,
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: failedPreparations,
    });
    if (!selection) return null;
    const before = bytes(projectActiveContext(snapshot, state));
    let action: Record<string, unknown> | null = null;
    if (selection.kind === "prepared-chapter" && state.prepared) {
      const error = preparedFoldError({
        prepared: state.prepared,
        snapshot,
        state,
        generation,
        ratio,
      });
      if (error) {
        state = clearPrepared(state);
      } else {
        const id = state.prepared.id;
        const sourceIds = state.prepared.sourceRefs.map((ref) => ref.entryId);
        state = commitPreparedFold({ prepared: state.prepared, snapshot, state, generation });
        action = { kind: "chapter-fold", foldIds: [id], sourceIds };
        pendingContextNote = `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
      }
    } else if (selection.kind === "tool") {
      cancelPreparation();
      const tool = selection.candidate;
      const id = await commitDeterministicCandidate(snapshot, tool, automaticToolBrief(snapshot, tool));
      action = {
        kind: "tool-fold",
        foldIds: [id],
        sourceIds: tool.sourceRefs.map((ref) => ref.entryId),
      };
      pendingContextNote = `${tool.sourceRefs.length} stale completed read-only tool result(s) were folded.`;
    } else if (selection.kind === "refold") {
      cancelPreparation();
      state = setFoldProjectionState(state, selection.foldId, "folded");
      action = { kind: "refold", foldIds: [selection.foldId] };
      pendingContextNote = `Stale expanded fold ${selection.foldId} returned to its identical placeholder.`;
    } else if (selection.kind === "consolidation") {
      cancelPreparation();
      const consolidation = selection.candidate;
      const id = await commitDeterministicCandidate(
        snapshot,
        consolidation,
        deterministicConsolidationBrief(consolidation, state),
      );
      action = {
        kind: "consolidation",
        foldIds: [id],
        sourceIds: consolidation.sourceRefs.map((ref) => ref.entryId),
      };
      pendingContextNote =
        `Stale folded chapters were consolidated under ${id}; every child remains expandable.`;
    } else if (selection.kind === "chapter") {
      const chapter = selection.candidate;
      const id = await commitDeterministicCandidate(
        snapshot,
        chapter,
        deterministicChapterCandidateBrief(snapshot, chapter),
      );
      action = {
        kind: "chapter-fold",
        foldIds: [id],
        sourceIds: chapter.sourceRefs.map((ref) => ref.entryId),
      };
      pendingContextNote =
        `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
    }
    if (!action || !state) return null;
    const after = bytes(projectActiveContext(snapshot, state));
    state = clearArmedAdvisory(state);
    armedMilestone = null;
    lastAutomaticAction = { ...action, sourceBytesSaved: Math.max(0, before - after) };
    return lastAutomaticAction;
  };
  const runAutomaticRungTransaction = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!state || !lastProviderMeasurement ||
        !durableProviderMeasurementMatches(lastProviderMeasurement)) return null;
    if (automaticFailure) {
      automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        automaticFailure.suppressedCallbacks + 1,
      );
      return null;
    }
    const key = automaticOperationKey(phase, snapshot, ratio);
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const recordsAtEntry = persistedFoldRecords.size;
    const transientAtEntry = captureTransient();
    let action: Record<string, unknown> | null = null;
    try {
      action = await applyAutomaticRung(snapshot, ratio, rungOptions);
      if (action) await persist(ctx);
      if (action) boundaryFailure = null;
      return action;
    } catch (error) {
      const stateCommitted = persisted !== persistedAtEntry;
      const recordOnly = !stateCommitted && persistedFoldRecords.size > recordsAtEntry;
      if (!stateCommitted) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      suspendAutomatic(
        error,
        phase,
        ctx,
        key,
        stateCommitted ? "state-committed" : recordOnly ? "record-only" : "none",
      );
      updateStatus(ctx);
      return stateCommitted ? action : null;
    }
  };
  const attemptAutomaticRung = (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
  ): Promise<Record<string, unknown> | null> => {
    const operation = actionQueue.then(() =>
      runAutomaticRungTransaction(snapshot, ratio, ctx, phase));
    actionQueue = operation.catch(() => undefined);
    return operation;
  };
  const projectionCandidates = (ctx: any): Array<Record<string, unknown>> => {
    if (shuttingDown || !state) return [];
    try {
      return projectionSlateCandidates(state, authoritativeSnapshotFor(ctx));
    } catch {
      return [];
    }
  };
  options.setProjectionProvider?.(projectionCandidates);

  const enqueueLifecycleLoad = async (ctx: any): Promise<void> => {
    // A same-session start/tree reload is a projection-generation mutation.
    // Queue it behind every context authority → preparation → commit →
    // projection transaction, then serialize the actual load with the action
    // queue. Appending to actionQueue only after the context queue drains is
    // deliberate: a running context may itself need actionQueue to commit its
    // final-rung chapter, so capturing both queues up front would deadlock.
    const operation = contextQueue.then(() => {
      const loadOperation = actionQueue.then(async () => {
        load(ctx);
        await recoverNativeReceipts(ctx);
      });
      actionQueue = loadOperation.catch(() => undefined);
      return loadOperation;
    });
    contextQueue = operation.then(() => undefined, () => undefined);
    await operation;
  };

  const safeLifecycleLoad = async (ctx: any, phase: "session-start" | "session-tree"): Promise<void> => {
    try { await enqueueLifecycleLoad(ctx); }
    catch (error) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!state || state.sessionId !== sessionId) state = emptyActiveContextState(sessionId);
      if (!persisted || persisted.sessionId !== sessionId) persisted = clone(state);
      latestSnapshotError = error instanceof Error ? error.message : String(error);
      suspendAutomatic(error, phase, ctx);
      updateStatus(ctx);
    }
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => { await safeLifecycleLoad(ctx, "session-start"); });
  pi.on("session_tree", async (_event: unknown, ctx: any) => { await safeLifecycleLoad(ctx, "session-tree"); });
  pi.on("session_compact", async (event: Record<string, unknown>, ctx: any) => {
    const reason = boundReceiptText(ownValue(event, "reason"), 64, "unknown");
    const decision = makeNativeDecision(
      ctx,
      reason,
      ownValue(event, "willRetry") === true,
      reason === "manual" ? "manual-user-request" : "native-completion-without-predecision",
      reason === "manual"
        ? "Manual native compaction explicitly requested as the model-independent safety net"
        : "Native compaction completed without a matching pre-compaction decision receipt",
    );
    try {
      const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
      const existing = entries.find((entry: any) => entry?.type === "custom" &&
        entry.customType === nativeDecisionEntryType &&
        ownValue(entry.data, "decisionKey") === decision.decisionKey);
      if (existing) parseNativeCompactionDecision(existing.data, decision.sessionId);
      else await pi.appendEntry(nativeDecisionEntryType, decision);
    } catch (error) {
      safeNotify(ctx, `Native completion decision could not persist for recovery: ${String(error)}`, "error");
    }
    const receipt = buildNativeCompletion(event, ctx, decision);
    pendingNativeReceipt = receipt;
    load(ctx, true);
    lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: "native compaction completed; Quorum folding state rebuilt",
      compactionReason: reason,
      nativeCompactionCompleted: true,
      receiptKey: receipt.receiptKey,
      decision,
    };
    try {
      await persistNativeCompletion(receipt, ctx);
    } catch (error) {
      safeNotify(ctx, `Native compaction completed; its receipt remains queued for retry: ${String(error)}`, "error");
    }
    safeNotify(ctx, "Pi native compaction ran; Quorum folding state was rebuilt.", "warning");
    updateStatus(ctx);
  });

  const attributionChanged = async (_event: unknown, ctx: any): Promise<void> => {
    generation += 1;
    cancelPreparation();
    if (state?.prepared) state = clearPrepared(state);
    latestRatio = null;
    lastProviderMeasurement = null;
    armedMilestone = state ? advisoryState(state).armed?.milestone ?? null : null;
    advisoryScheduleKey = "pending-reseed";
    lastThresholdDecision = null;
    updateStatus(ctx);
  };
  pi.on("model_select", attributionChanged);
  pi.on("thinking_level_select", attributionChanged);

  const armMilestoneForMeasurement = (
    snapshot: ActiveContextSnapshot,
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!state) return false;
    const ratio = contextUsageRatio(measurement);
    if (ratio === null) return false;
    const schedule = advisorySchedule(snapshot);
    const scheduleKey = sha256Value({
      schedule: schedule.key,
      provider: measurement.provider,
      model: measurement.model,
      contextWindow: measurement.contextWindow,
    });
    const scheduleChanged = advisoryScheduleKey !== null && advisoryScheduleKey !== scheduleKey;
    advisoryScheduleKey = scheduleKey;
    const before = stableStringify(advisoryState(state));
    const updated = updateAdvisoryMilestone(state, ratio, schedule, scheduleChanged, scheduleKey);
    state = updated.state;
    const armed = advisoryState(state).armed;
    if (armed && ratio < 0.85 * armed.threshold) {
      state = clearArmedAdvisory(state);
      armedMilestone = null;
    } else {
      armedMilestone = armed?.milestone ?? null;
    }
    return before !== stableStringify(advisoryState(state));
  };

  const accountAnchoredMeasurement = (measurement: ProviderContextMeasurement): boolean => {
    if (!state) return false;
    if (!lastProviderMeasurement) {
      lastProviderMeasurement = measurement;
      return false;
    }
    if (lastProviderMeasurement.messageSha256 === measurement.messageSha256) return false;
    const previousTokens = lastProviderMeasurement.tokens;
    const delta = Math.max(0, measurement.tokens - previousTokens);
    const tokensSinceToolFold = Math.min(Number.MAX_SAFE_INTEGER, state.tokensSinceToolFold + delta);
    const leases = Object.fromEntries(Object.entries(state.leases)
      .flatMap(([id, remaining]) => remaining > 1 ? [[id, remaining - 1]] : []));
    const changed = tokensSinceToolFold !== state.tokensSinceToolFold ||
      stableStringify(leases) !== stableStringify(state.leases);
    if (changed) state = { ...state, tokensSinceToolFold, leases };
    return changed;
  };

  const handleContext = async (event: { messages: unknown[] }, ctx: any) => {
    if (shuttingDown) return { messages: event.messages };
    if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    latestSnapshot = null;
    latestSnapshotError = null;
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    const generationAtEntry = generation;
    let mutationAttempted = pendingManual;
    let persistedSucceeded = false;
    try {
      const snapshot = snapshotForEvent(ctx, event.messages);
      latestSnapshot = snapshot;
      if (automaticFailure) {
        automaticFailure.suppressedCallbacks = Math.min(
          Number.MAX_SAFE_INTEGER,
          automaticFailure.suppressedCallbacks + 1,
        );
      }
      let observed = latestProviderContextMeasurement(
        snapshot.messages,
        contextWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (observed && providerMeasurementBranchIndex(ctx, observed) < 0) observed = null;
      let advisoryChanged = false;
      let measurementStateChanged = false;
      if (observed) {
        const boundRevision = providerMeasurementRevisionByMessageSha.get(observed.messageSha256);
        if (boundRevision !== undefined &&
            !durableProviderMeasurementReceiptMatches(observed, boundRevision)) {
          try { await persistProviderMeasurement(ctx, observed, boundRevision); }
          catch (error) { suspendAutomatic(error, "provider-measurement", ctx); }
        }
        latestRatio = contextUsageRatio(observed);
        if (durableProviderMeasurementMatches(observed) && latestRatio !== null) {
          measurementStateChanged = accountAnchoredMeasurement(observed);
          lastProviderMeasurement = observed;
          advisoryChanged = armMilestoneForMeasurement(snapshot, observed);
          startPreparation(snapshot, latestRatio, ctx);
          if (!automaticFailure && latestRatio >= hardFenceRatio(snapshot) && preparing) {
            mutationAttempted = true;
            await preparing.promise;
            if (!sessionIdentityStillValid(ctx, snapshot.sessionId, generationAtEntry)) {
              return { messages: event.messages };
            }
          }
          if (selectAutomaticToolForRung(snapshot, state, latestRatio)) mutationAttempted = true;
          const action = await attemptAutomaticRung(snapshot, latestRatio, ctx, "context");
          if (action) {
            mutationAttempted = true;
            persistedSucceeded = true;
            advisoryChanged = false;
          }
        } else lastProviderMeasurement = observed;
      } else {
        latestRatio = contextUsageRatio(lastProviderMeasurement);
      }
      if ((advisoryChanged || measurementStateChanged) && state && persisted &&
          !sameStateProjection(state, persisted)) {
        mutationAttempted = true;
        await persistThroughActionQueue(ctx);
        persistedSucceeded = true;
      }
      let projected: unknown[];
      try { projected = projectWithAdvisory(snapshot); }
      catch (error) {
        suspendAutomatic(error, "projection", ctx);
        abortUnsafeHardContext(snapshot, ctx);
        return { messages: event.messages };
      }
      if (abortUnsafeHardContext(snapshot, ctx, true)) {
        updateStatus(ctx);
        return { messages: event.messages };
      }
      updateStatus(ctx);
      return { messages: projected };
    } catch (error) {
      if (!persistedSucceeded && persisted === persistedAtEntry) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      latestSnapshotError = error instanceof Error ? error.message : String(error);
      if (mutationAttempted) {
        if (!persistedSucceeded) boundaryFailure = latestSnapshotError;
        suspendAutomatic(error, persistedSucceeded ? "post-persist-projection" : "context", ctx);
      }
      abortUnsafeHardContext(latestSnapshot, ctx);
      return { messages: event.messages };
    }
  };
  pi.on("context", (event: { messages: unknown[] }, ctx: any) => {
    // Pi normally requests context serially, but retries, reloads, and host
    // integrations can overlap callbacks. Serialize the entire authority →
    // preparation → commit → projection transaction so a follower cannot
    // observe a published measurement before the leader's durable receipt or
    // return raw final-rung context while the leader is preparing a brief.
    const operation = contextQueue.then(() => handleContext(event, ctx));
    contextQueue = operation.then(() => undefined, () => undefined);
    return operation;
  });

  const applyAnchoredProviderMeasurement = async (
    measurement: ProviderContextMeasurement,
    ctx: any,
    capturedSessionId: string,
    capturedGeneration: number,
    capturedProjectionRevision: number,
    capturedTopologySha256: string,
    capturedProtectionSha256: string,
  ): Promise<void> => {
    if (shuttingDown ||
        !sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        topologySha256(state!) !== capturedTopologySha256 ||
        protectionSha256(state!) !== capturedProtectionSha256) return;
    try {
      await persistProviderMeasurement(ctx, measurement, capturedProjectionRevision);
    } catch (error) {
      suspendAutomatic(error, "provider-measurement", ctx);
      return;
    }
    const measuredRatio = contextUsageRatio(measurement);
    if (!sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        !durableProviderMeasurementMatches(measurement) ||
        measuredRatio === null) return;
    const measurementStateChanged = accountAnchoredMeasurement(measurement);
    lastProviderMeasurement = measurement;
    latestRatio = measuredRatio;
    let snapshot: ActiveContextSnapshot;
    try { snapshot = authoritativeSnapshotFor(ctx); }
    catch {
      updateStatus(ctx);
      return;
    }
    const advisoryChanged = armMilestoneForMeasurement(snapshot, measurement);
    startPreparation(snapshot, latestRatio, ctx);
    if (latestRatio >= hardFenceRatio(measurement, ctx) && preparing) await preparing.promise;
    if (!sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        !durableProviderMeasurementMatches(measurement)) return;
    const action = await attemptAutomaticRung(
      authoritativeSnapshotFor(ctx),
      latestRatio,
      ctx,
      "message-end",
    );
    if (!action && (advisoryChanged || measurementStateChanged) && state && persisted &&
        !sameStateProjection(state, persisted)) {
      await persistThroughActionQueue(ctx);
    }
    updateStatus(ctx);
  };

  pi.on("message_end", async (event: Record<string, unknown>, ctx: any) => {
    if (shuttingDown) return;
    try {
      const message = ownValue(event, "message");
      const measurement = providerContextMeasurement(
        message,
        contextWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (!measurement || !state) return;
      const capturedSessionId = ctx.sessionManager.getSessionId();
      const capturedGeneration = generation;
      const capturedProjectionRevision = state.revision;
      const capturedTopologySha256 = topologySha256(state);
      const capturedProtectionSha256 = protectionSha256(state);
      await applyAnchoredProviderMeasurement(
        measurement,
        ctx,
        capturedSessionId,
        capturedGeneration,
        capturedProjectionRevision,
        capturedTopologySha256,
        capturedProtectionSha256,
      );
    } catch (error) {
      suspendAutomatic(error, "message-end", ctx);
      try { updateStatus(ctx); } catch { /* The provider loop must keep running. */ }
    }
  });
  pi.on("tool_call", (event: Record<string, unknown>, ctx: any) => {
    const calledTool = ownValue(event, "toolName");
    if (shuttingDown || blockingToolHarvestedThisTurn || blockingToolHarvestQueuedThisTurn ||
        typeof calledTool !== "string" || !blockingTools.has(calledTool)) return;
    blockingToolHarvestQueuedThisTurn = true;
    const operation = actionQueue.then(async () => {
      try {
        if (!state || latestRatio === null || !lastProviderMeasurement || automaticFailure ||
            !durableProviderMeasurementMatches(lastProviderMeasurement)) return null;
        cancelPreparation();
        let snapshot: ActiveContextSnapshot;
        try { snapshot = authoritativeSnapshotFor(ctx); }
        catch { return null; }
        const candidate = selectAutomaticToolForRung(snapshot, state, latestRatio, true);
        if (!candidate) {
          blockingToolHarvestedThisTurn = true;
          return null;
        }
        const action = await runAutomaticRungTransaction(
          snapshot,
          latestRatio,
          ctx,
          "tool-call",
          { waiveToolCadence: true, toolOnly: true },
        );
        if (action) blockingToolHarvestedThisTurn = true;
        return action;
      } finally {
        blockingToolHarvestQueuedThisTurn = false;
        try { updateStatus(ctx); } catch { /* A blocking tool call must never wait on presentation. */ }
      }
    });
    actionQueue = operation.catch(() => undefined);
  });
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    blockingToolHarvestedThisTurn = false;
    blockingToolHarvestQueuedThisTurn = false;
    if (shuttingDown || !state || !persisted) return;
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      if (!pendingManual && !automaticFailure && latestRatio !== null && lastProviderMeasurement &&
          durableProviderMeasurementMatches(lastProviderMeasurement)) {
        startPreparation(snapshot, latestRatio, ctx);
        if (latestRatio >= hardFenceRatio(snapshot) && preparing) await preparing.promise;
        await attemptAutomaticRung(snapshot, latestRatio, ctx, "turn-end");
      }
      pendingManual = false;
      if (!automaticFailure) boundaryFailure = null;
    } catch (error) {
      if (persisted === persistedAtEntry) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      suspendAutomatic(error, "turn-end", ctx);
    }
    try { updateStatus(ctx); } catch { /* turn_end must never stall Pi. */ }
  });
  pi.on("session_before_tree", (event: Record<string, unknown>) => {
    const preparation = ownValue(event, "preparation");
    if (!preparation || typeof preparation !== "object") return;
    return ownValue(preparation, "userWantsSummary") === true ? { cancel: true } : undefined;
  });

  pi.on("session_before_compact", (event: Record<string, unknown>, ctx: any) => {
    const reason = ownValue(event, "reason");
    if (reason === "manual") {
      lastThresholdDecision = {
        handled: false,
        retry: false,
        reason: "manual native compaction explicitly requested by the user",
        compactionReason: reason,
      };
      try { updateStatus(ctx); } catch { /* Manual rescue must survive presentation failure. */ }
      return undefined;
    }
    lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: "blocked stock automatic compaction; Quorum context folding remains authoritative",
      compactionReason: reason,
      nativeCompactionCompleted: false,
    };
    return { cancel: true };
  });
  pi.on("agent_settled", async (_event: unknown, ctx: any) => {
    if (pendingManual && persisted && boundaryFailure === null) {
      cancelPreparation();
      state = clone(persisted);
      pendingManual = false;
    }
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      startPreparation(snapshot, latestRatio, ctx);
    } catch {
      // The next authoritative context event will retry mapping.
    }
    try { await recoverNativeReceipts(ctx); }
    catch (error) { safeNotify(ctx, `Native compaction receipt recovery remains pending: ${String(error)}`, "error"); }
    updateStatus(ctx);
  });

  const executeAction = async (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: any,
  ): Promise<unknown> => {
    if (shuttingDown) throw new Error("Active-context runtime is shut down");
    if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    const executionArgumentsSha256 = sha256Value(params);
    const action = String(params.action ?? "");
    if (!allowedToolActionSet.has(action)) {
      throw new Error(`${toolName} action '${action}' is not enabled in this runtime`);
    }
    if (action === "status" && !latestSnapshot) {
      return toolPayload({
        version: 1,
        service: "active-context-folding",
        available: false,
        contextEventError: latestSnapshotError ?? "No current same-session Pi context event has been observed",
      });
    }
    const snapshot = authoritativeSnapshotFor(ctx);
    if (action === "status") {
      const detail = ownValue(params, "detail");
      if (detail !== undefined && detail !== "fold_candidates") {
        throw new Error("status detail must be 'fold_candidates'");
      }
      const schedule = advisorySchedule(snapshot);
      return toolPayload({
        ...activeContextStatus(
          snapshot,
          state,
          boundedInteger(params.offset, 0, 0, 1_000_000, "offset"),
          boundedInteger(params.limit, 40, 1, 100, "limit"),
          snapshot.policy.maxFoldSourceRefs,
        ),
        available: true,
        automatic: {
          pressureRatio: latestRatio,
          milestones: Object.fromEntries(schedule.rungs.map((rung) => [
            rung.milestone,
            { threshold: rung.threshold, budget: rung.budget },
          ])),
          armedMilestone,
          advisory: advisoryState(state),
          historicalGuidanceEntries,
          warningRatio: snapshot.policy.warningRatio,
          toolFoldRatio: snapshot.policy.toolFoldRatio,
          refoldRatio: snapshot.policy.refoldRatio,
          chapterPrepareRatio: snapshot.policy.prepareRatio,
          hardFenceRatio: hardFenceRatio(snapshot),
          responseReserve: Math.min(
            ACTIVE_CONTEXT_POLICY.responseReserve,
            Math.floor(snapshot.contextWindow * 0.1),
          ),
          windowSource: snapshot.windowSource,
          consolidationRatio: snapshot.policy.consolidationRatio,
          providerMeasurement: lastProviderMeasurement ? {
            tokens: lastProviderMeasurement.tokens,
            contextWindow: lastProviderMeasurement.contextWindow,
            messageSha256: lastProviderMeasurement.messageSha256,
            provider: lastProviderMeasurement.provider,
            model: lastProviderMeasurement.model,
          } : null,
          measurementFresh: Boolean(lastProviderMeasurement &&
            durableProviderMeasurementMatches(lastProviderMeasurement)),
          preparing: Boolean(preparing),
          preparedFoldId: state.prepared?.id ?? null,
          preparedSourceCount: state.prepared?.sourceRefs.length ?? null,
          pendingContextNote,
          lastCandidateId: lastPreparationCandidateId,
          lastPreparationError,
          boundaryFailure,
          lastSelectionKind,
          lastSelectionSourceIds,
          lastAutomaticAction,
          automaticSuspended: automaticFailure !== null,
          automaticFailure: automaticFailure ? clone(automaticFailure) : null,
          lastCompactionDecision: lastThresholdDecision,
          nativeSummaries: "disabled",
          freeHarvest: blockingTools.size === 0 ? "disabled" : "enabled",
          pressureSource: "last-successful-provider-response-only",
          postOverflowCallback: "blocked-while-stock-native-compaction-is-disabled",
          sameOperationRetry: false,
        },
        ...(detail === "fold_candidates" ? {
          candidates: foldCandidatesDetail(snapshot, state, latestRatio, {
            summarizerAvailable: Boolean(options.summarizeContextSpan),
            generation,
            measurementFresh: Boolean(lastProviderMeasurement &&
              durableProviderMeasurementMatches(lastProviderMeasurement)),
            automaticFailure: automaticFailure !== null,
            preparing: Boolean(preparing),
            failedPreparationIds: failedPreparations,
          }),
        } : {}),
      });
    }
    if (action === "expand" || action === "refold") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error(`${action} requires id`);
      requireActiveFold(snapshot, state, id);
      let next = setFoldProjectionState(state, id, action === "expand" ? "expanded" : "folded");
      if (action === "expand") next = withExpandLease(next, id);
      else {
        const leases = { ...next.leases };
        delete leases[id];
        next = { ...next, leases };
      }
      await persistManual(
        next,
        action,
        ctx,
      );
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        id,
        state: action === "expand" ? "expanded" : "folded",
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "protect" || action === "unprotect") {
      const ids = stringIds(params.ids);
      await persistManual(protectEvidence(snapshot, state, ids, action === "protect"), action, ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        ids,
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "fold") {
      const ids = stringIds(params.ids);
      const candidate = manualFoldCandidate(snapshot, state, ids);
      const supplied = typeof params.brief === "string" && params.brief.trim() ? params.brief : undefined;
      const { preparedFold, nextState } = await prepareAndCommitExplicit({
        snapshot,
        candidate,
        brief: supplied,
        ctx,
        signal,
      });
      armedMilestone = null;
      await persistManual(clearArmedAdvisory(nextState), "fold", ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        id: preparedFold.id,
        kind: preparedFold.fold.kind,
        brief: preparedFold.fold.brief,
        provenance: normalizeLegacyProvenance(preparedFold.fold.provenance),
        argumentsSha256: executionArgumentsSha256,
        durableRevision: state.revision,
        activation: "durable immediately; projected on the next model call in this same turn",
        expand: { action: "expand", id: preparedFold.id },
      });
    }
    throw new Error(`Unknown ${toolName} action '${action}'`);
  };
  const fullToolSurface = allowedToolActions.length === ACTIVE_CONTEXT_TOOL_ACTIONS.length;
  pi.registerTool({
    name: toolName,
    label: "Quorum Active Context",
    description: fullToolSurface
      ? "Page, fold, expand, refold, or protect exact Pi active-context evidence. Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard 1200-character maximum."
      : `Use only the configured active-context actions: ${allowedToolActions.join(", ")}. Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard 1200-character maximum.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: allowedToolActions },
        ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
        id: { type: "string", minLength: 1 },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: ACTIVE_CONTEXT_POLICY.maxBriefChars,
          description: "Factual fold brief; keep it at most 1000 characters to stay below the hard 1200-character limit.",
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: ["fold_candidates"] },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const operation = actionQueue.then(() => executeAction(params, signal, ctx));
      actionQueue = operation.catch(() => undefined);
      return operation;
    },
  });

  pi.registerCommand(commandNames.status, {
    description: "Show active-context fold roots and paging state",
    handler: async (_args: string, ctx: any) => {
      if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
      try {
        const snapshot = authoritativeSnapshotFor(ctx);
        const status = activeContextStatus(snapshot, state, 0, 40);
        safeNotify(
          ctx,
          `Active context: ${status.totalFolds} fold(s), roots ${(status.roots as string[]).join(", ") || "none"}. ` +
            `Use ${toolName} status for exact recursive actions.`,
          "info",
        );
      } catch (error) {
        safeNotify(ctx, `Active-context status unavailable; native Pi context is unchanged: ${String(error)}`, "warning");
      }
    },
  });

  pi.registerCommand(commandNames.fold, {
    description: "Losslessly fold a stale context span; works without a main-model request",
    handler: async (args: string, ctx: any) => {
      const operation = actionQueue.then(async () => {
        if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
        const snapshot = latestSnapshot
          ? authoritativeSnapshotFor(ctx)
          : snapshotForEvent(ctx, ctx.sessionManager.buildSessionContext().messages);
        if (!latestSnapshot) latestSnapshot = snapshot;
        const divider = args.indexOf(" -- ");
        const selector = (divider >= 0 ? args.slice(0, divider) : args).trim();
        const supplied = (divider >= 0 ? args.slice(divider + 4) : "").trim() || undefined;
        const ids = selector ? selector.replace(/\.\./g, " ").split(/[\s,]+/).filter(Boolean) : [];
        const candidate = ids.length
          ? manualFoldCandidate(snapshot, state!, ids)
          : selectAutomaticChapter(snapshot, state!) ?? selectAutomaticToolBatch(snapshot, state!, 1)[0] ?? null;
        if (!candidate) throw new Error("No exact stale rescue span is currently eligible");
        const stateBefore = state!;
        const persistedBefore = persisted ? clone(persisted) : null;
        const generationBefore = generation;
        const { preparedFold, nextState } = await prepareAndCommitExplicit({
          snapshot,
          candidate,
          brief: supplied,
          ctx,
          maximumSourceChars: USER_RESCUE_MAX_SOURCE_CHARS,
        });
        if (!sessionIdentityStillValid(ctx, stateBefore.sessionId, generationBefore)) {
          throw new Error("Active-context session changed before rescue persistence");
        }
        state = clearArmedAdvisory(nextState);
        armedMilestone = null;
        try { await persist(ctx); }
        catch (error) {
          if (sessionIdentityStillValid(ctx, stateBefore.sessionId, generationBefore)) {
            state = stateBefore;
            persisted = persistedBefore;
          }
          throw error;
        }
        pendingManual = false;
        automaticFailure = null;
        armedMilestone = null;
        pendingContextNote =
          `User rescue folded stale context under ${preparedFold.id}; exact source remains expandable.`;
        lastAutomaticAction = {
          kind: "user-rescue-fold",
          foldIds: [preparedFold.id],
          sourceIds: preparedFold.sourceRefs.map((ref) => ref.entryId),
        };
        updateStatus(ctx);
        safeNotify(
          ctx,
          `Folded ${preparedFold.fold.sourceChars} bytes into ${preparedFold.id}. Exact source remains expandable.`,
          "info",
        );
      });
      actionQueue = operation.catch(() => undefined);
      try { await operation; }
      catch (error) {
        safeNotify(ctx, `Context rescue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.on("session_shutdown", (_event: unknown, ctx: any) => {
    generation += 1;
    shuttingDown = true;
    cancelPreparation();
    state = null;
    persisted = null;
    latestSnapshot = null;
    armedMilestone = null;
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { /* Shutdown cannot be blocked by UI. */ }
  });

  return { projectionCandidates };
}
