import type { EvidenceRef } from "../json.ts";

export const DEFAULT_ACTIVE_CONTEXT_TOOL_NAME = "pi_fold_context";
export const DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX = "pi-fold-active-context";
export const DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL = "pi-fold Active Context";
export const DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN = "pi-fold";
export const DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES = Object.freeze({
  status: "pi-fold-context",
  fold: "fold-context",
});

export function entryTypeNamespace(entryTypePrefix: string): string {
  const suffix = "-active-context";
  return entryTypePrefix.endsWith(suffix) && entryTypePrefix.length > suffix.length
    ? entryTypePrefix.slice(0, -suffix.length)
    : entryTypePrefix;
}

export function activeContextSource(entryTypePrefix: string): string {
  const namespace = entryTypeNamespace(entryTypePrefix);
  return namespace === entryTypePrefix ? entryTypePrefix : `${namespace}/active-context`;
}

export function activeContextBrand(brandNoun: string): string {
  return /active-context$/i.test(brandNoun) ? brandNoun : `${brandNoun} active-context`;
}

export function contextBrand(brandNoun: string): string {
  return /context$/i.test(brandNoun) ? brandNoun : `${brandNoun} context`;
}

const DEFAULT_ENTRY_NAMESPACE = entryTypeNamespace(DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX);
export const ACTIVE_CONTEXT_STATE_ENTRY = `${DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX}-state`;
export const ACTIVE_CONTEXT_FOLD_RECORD_ENTRY = `${DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX}-fold-record`;
export const PROVIDER_CONTEXT_MEASUREMENT_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-provider-context-measurement`;
export const ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  "status", "peek", "fold", "expand", "refold", "protect", "unprotect",
  "rebrief", "reboundary", "unmark",
] as const);
export type ActiveContextToolAction = typeof ACTIVE_CONTEXT_TOOL_ACTIONS[number];
export const USER_RESCUE_MAX_SOURCE_CHARS = 512_000;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const EXPAND_LEASE_GENERATIONS = 8;
export const MAX_EXPAND_LEASES = 64;

export const SURFACING_BM25_K1 = 1.5;
export const SURFACING_BM25_B = 0.75;
export const SURFACING_CONTENT_HIT = 0.25;
export const SURFACING_BRIEF_HIT = 0.15;
export const SURFACING_DIVERGENCE_MARGIN = 0.10;
export const SURFACING_SLATE_SIZE = 1;
export const SURFACING_OUTCOME_WINDOW_ORDINALS = 12;
export const SURFACING_IGNORE_LIMIT = 2;
export const SURFACING_PROVENANCE_TERMS = 3;
export const SURFACING_INTENT_CHARS = 1_200;
export const SURFACING_INTENT_ARGUMENT_CHARS = 120;
export const SURFACING_INTENT_RECENCY_SHARE = 0.5;
export const SURFACING_INTENT_ARGUMENT_KEYS: readonly string[] = Object.freeze([
  "path", "file_path", "query", "pattern", "command", "brief", "id",
]);
export const SURFACING_MAX_CONTENT_CHARS = 20_000;
export const SURFACING_MAX_LEDGER_RECORDS = 256;
export const SURFACING_HOOK_CHARS = 160;

export const COMMIT_RECLAIM_FLOOR_SHARE = 0.02;

export const MAX_PINNED_SHARE = 0.25;

export interface ActiveContextThresholds {
  maxTarget: number;
  minTarget: number;
  freshTail: number;
  consolidateAfter: number;
}

export const DEFAULT_THRESHOLDS: Readonly<ActiveContextThresholds> = Object.freeze({
  maxTarget: 0.80,
  // 0.20, down from 0.35 (Shane 2026-08-14). The cut depth is what sets the epoch
  // cadence: every commit rewrites the prefix from the earliest folded byte, so the
  // cost of an epoch is nearly flat in how deep it cuts, while the relief it buys is
  // the whole distance to the trigger. sol-20260814-traps rep 1 ran six commits, each
  // freeing to 0.35 and refilling in two to three stages; at 0.20 the same run shape
  // owes roughly a quarter fewer epochs, which is a quarter fewer full-prefix
  // rewrites, the dominant self-inflicted cache break. The floor stays well above
  // the fresh tail and the pinned-mass floor, so the validation laws below bind
  // exactly as before.
  minTarget: 0.20,
  freshTail: 0.02,
  consolidateAfter: 10,
});

export const MINIMUM_SUPPORTED_BUDGET_TOKENS = 10_000;

export const MINIMUM_FRESH_TAIL_TOKENS = 500;

export class ThresholdPolicyError extends Error {
  readonly invariant: string;
  constructor(invariant: string, message: string) {
    super(message);
    this.name = "ThresholdPolicyError";
    this.invariant = invariant;
  }
}

function thresholdProportion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ThresholdPolicyError(field, `thresholds.${field} must be a proportion above 0 and below 1`);
  }
  return value;
}

export function resolveThresholds(value: unknown): ActiveContextThresholds {
  if (value === undefined) return { ...DEFAULT_THRESHOLDS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThresholdPolicyError("shape", "thresholds must be an object with all four fields");
  }
  const supplied = value as Record<string, unknown>;
  const fields = ["maxTarget", "minTarget", "freshTail", "consolidateAfter"] as const;
  for (const key of Object.keys(supplied)) {
    if (!(fields as readonly string[]).includes(key)) {
      throw new ThresholdPolicyError("shape", `thresholds has no ${key} field`);
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(supplied, field)) {
      throw new ThresholdPolicyError("shape", `thresholds must declare ${field}; the object is set whole or not at all`);
    }
  }
  const maxTarget = thresholdProportion(supplied.maxTarget, "maxTarget");
  const minTarget = thresholdProportion(supplied.minTarget, "minTarget");
  const freshTail = thresholdProportion(supplied.freshTail, "freshTail");
  const consolidateAfter = supplied.consolidateAfter;
  if (typeof consolidateAfter !== "number" || !Number.isInteger(consolidateAfter) || consolidateAfter < 1) {
    throw new ThresholdPolicyError("consolidateAfter", "thresholds.consolidateAfter must be a positive integer count");
  }
  if (!(minTarget < maxTarget)) {
    throw new ThresholdPolicyError("minTarget<maxTarget",
      "thresholds.minTarget must sit below thresholds.maxTarget, or a commit has no depth to reach");
  }
  if (!(freshTail < maxTarget)) {
    throw new ThresholdPolicyError("freshTail<maxTarget",
      "thresholds.freshTail must sit below thresholds.maxTarget, or the trigger fires on protected mass alone");
  }
  if (!(maxTarget - minTarget >= freshTail)) {
    throw new ThresholdPolicyError("gap>=freshTail",
      "the hysteresis gap (maxTarget - minTarget) must be at least thresholds.freshTail, " +
      "or refilling the protected tail alone re-fires the trigger");
  }
  const pinned = Math.ceil(MAX_PINNED_SHARE * MINIMUM_SUPPORTED_BUDGET_TOKENS);
  const fresh = Math.ceil(freshTail * MINIMUM_SUPPORTED_BUDGET_TOKENS);
  if (!(pinned + fresh < Math.floor(maxTarget * MINIMUM_SUPPORTED_BUDGET_TOKENS))) {
    throw new ThresholdPolicyError("pinnedPlusFreshTail<maxTarget",
      `the pin ceiling (${MAX_PINNED_SHARE}) plus thresholds.freshTail must stay below ` +
      `thresholds.maxTarget at the ${MINIMUM_SUPPORTED_BUDGET_TOKENS}-token minimum supported budget`);
  }
  return { maxTarget, minTarget, freshTail, consolidateAfter };
}

export function assertThresholdsServable(thresholds: ActiveContextThresholds, budgetTokens: number): void {
  if (!Number.isFinite(budgetTokens) || budgetTokens < MINIMUM_SUPPORTED_BUDGET_TOKENS) {
    throw new ThresholdPolicyError("minimumBudget",
      `a ${Math.floor(budgetTokens)}-token serving budget is below the ` +
      `${MINIMUM_SUPPORTED_BUDGET_TOKENS}-token minimum this package supports`);
  }
  const freshTokens = Math.floor(thresholds.freshTail * budgetTokens);
  if (freshTokens < MINIMUM_FRESH_TAIL_TOKENS) {
    throw new ThresholdPolicyError("freshTailTokens",
      `thresholds.freshTail is ${freshTokens} tokens of a ${Math.floor(budgetTokens)}-token serving budget, ` +
      `below the ${MINIMUM_FRESH_TAIL_TOKENS}-token minimum one foldable unit needs`);
  }
}

export function zoneBytes(share: number, budgetTokens: number): number {
  if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return Math.floor(share * budgetTokens * ESTIMATED_BYTES_PER_TOKEN);
}

export function servingBudgetTokens(window: number): number {
  const resolved = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  return resolved - Math.min(ACTIVE_CONTEXT_POLICY.responseReserve, Math.floor(resolved * 0.1));
}

export const MAX_PENDING_MARKS = 256;
export const ESTIMATED_BYTES_PER_TOKEN = 4;
export const ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES = 240;

export const PEEK_MIN_SLICE_BYTES = 1_024;

export const STATUS_DIET_SUGGESTIONS = 5;

export interface ActiveContextGuidance {
  actionResponses: boolean;
}

export const DEFAULT_GUIDANCE: ActiveContextGuidance = Object.freeze({
  actionResponses: true,
});

const GUIDANCE_KEYS: readonly (keyof ActiveContextGuidance)[] = Object.freeze([
  "actionResponses",
]);

export function resolveGuidance(value: unknown): ActiveContextGuidance {
  if (value === undefined) return DEFAULT_GUIDANCE;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance must be an object of { actionResponses } booleans");
  }
  for (const key of Object.keys(value)) {
    if (!GUIDANCE_KEYS.includes(key as keyof ActiveContextGuidance)) {
      throw new Error(`guidance has no ${key} setting: the only keys are ` +
        `${GUIDANCE_KEYS.join(", ")}, and they are booleans`);
    }
  }
  const resolved = { ...DEFAULT_GUIDANCE } as ActiveContextGuidance;
  for (const key of GUIDANCE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const setting = (value as Record<string, unknown>)[key];
    if (typeof setting !== "boolean") throw new Error(`guidance.${key} must be a boolean`);
    resolved[key] = setting;
  }
  return Object.freeze(resolved);
}
export const MAX_SURFACING_LINE_BYTES = 384;

export const MAX_CONTEXT_RECEIPTS = 3;
export const CONTEXT_RECEIPT_BLOCK_BYTES = 900;

export const CONTEXT_MARK_RESPONSE_BYTES = 900;
export const CONTEXT_STATUS_RESPONSE_BYTES = 24_000;
export const MAX_UNMARKED_CANDIDATES = 3;

export const MAX_FOLD_SPAN_CHARS = 16_000;
export const MAX_WEDGE_ABSORB_TOKENS = 256;
export const MAX_BRIEF_UPGRADES_IN_FLIGHT = 2;
export const MAX_BRIEF_UPGRADE_QUEUE = 4;
export const MAX_BRIEF_BATCH_SPANS = 10;
export const PEEK_DEFAULT_MAX_BYTES = 16_000;
export const PEEK_HEAD_SHARE = 0.6;

export const PEEK_READ_ONLY_CONTEXT_ACTIONS: ReadonlySet<string> = new Set(["status", "peek"]);

export type MarkOrigin = "agent" | "ladder";

export interface PendingFoldMark {
  mark: "fold";
  id: string;
  kind: FoldKind;
  parts: FoldPart[];
  brief: string;
  briefProvenance: BriefProvenance;
  origin: MarkOrigin;
  ordinal: number;
}

export interface PendingRefoldMark {
  mark: "refold";
  id: string;
  origin: MarkOrigin;
  ordinal: number;
}

export type PendingMark = PendingFoldMark | PendingRefoldMark;

export const ACTIVE_CONTEXT_POLICY = Object.freeze({
  refoldRatio: 0.85,
  prepareRatio: 0.90,
  warmRatio: 0.55,
  responseReserve: 16_384,
  minToolChars: 2_000,
  minChapterChars: 4_000,
  maxChapterChars: 128_000,
  maxChapterTurns: 4,
  maxSourceChars: 200_000,
  maxFoldSourceRefs: 256,
  maxBriefChars: 2_000,
  briefTimeoutMs: 300_000,
  orientationMessages: 2,
  maxOrientationChars: 12_000,
});

export type FoldKind = "tool-result" | "chapter" | "consolidation";
export type FoldPart = { kind: "raw"; ref: EvidenceRef } | { kind: "fold"; foldId: string };
export type BriefProvenance =
  | { kind: "supplied" }
  | { kind: "deterministic" }
  | {
      kind: "model" | "luna";
      provider: string;
      model: string;
      effort: string;
      launchContractDigest?: string;
    };

export type BriefOverride = string | { brief: string; provenance: BriefProvenance };

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

export type SurfacingOutcome = "shown" | "acted" | "used" | "ignored";

export interface SurfacingRecord {
  id: string;
  surfaced: number;
  taken: number;
  ordinal: number;
  outcome: SurfacingOutcome;
}

export interface SurfacingTransition {
  id: string;
  from: SurfacingOutcome;
  to: SurfacingOutcome;
  ordinal: number;
}

export interface SurfacingCandidate {
  id: string;
  brief: string;
  content: string;
  route: string;
  position: number;
  depth: number;
}

export interface SurfacingSuggestion extends SurfacingCandidate {
  contentScore: number;
  briefScore: number;
  margin: number;
  slot: number;
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
  surfacing?: SurfacingRecord[];
  pendingMarks?: PendingMark[];
  pinnedPeeks?: never;
  briefs?: Record<string, BriefOverride>;
  prepared?: PreparedFold;
  advisory?: {
    highWater: number;
    delivered: Record<string, number>;
    armed?: { milestone: AdvisoryMilestone; threshold: number; scheduleKey: string };
  };
  rider?: { epoch: number; text: string };
}

export interface FoldRecordRef {
  id: string;
  sha256: string;
}

export interface FoldRecordEntry {
  version: 1;
  sessionId: string;
  foldId: string;
  recordSha256: string;
  fold: ActiveFold;
}

export interface ActiveContextCheckpointV2 {
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
  surfacing?: SurfacingRecord[];
  pendingMarks?: PendingMark[];
  briefs?: Record<string, BriefOverride>;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  rider?: NonNullable<ActiveContextState["rider"]>;
  lastCall?: NonNullable<ActiveContextState["lastCall"]>;
  notices?: NonNullable<ActiveContextState["notices"]>;
  stateSha256: string;
}

export interface ActiveContextDeltaV2 {
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
  surfacing?: SurfacingRecord[];
  // `pendingMarks` and `briefs` on a delta are the WHOLE value: what every delta written
  // before 2026-08-13 carries, and what sealed sessions replay. New deltas carry the change
  // instead. The marks carry an ORDER as well as a membership, so the change is the marks
  // that are new or rewritten plus the whole key order, which states the removals too.
  pendingMarks?: PendingMark[];
  addPendingMarks?: PendingMark[];
  pendingMarkOrder?: string[];
  briefs?: Record<string, BriefOverride>;
  addBriefs?: Record<string, BriefOverride>;
  removeBriefIds?: string[];
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  rider?: NonNullable<ActiveContextState["rider"]>;
  lastCall?: NonNullable<ActiveContextState["lastCall"]>;
  notices?: NonNullable<ActiveContextState["notices"]>;
  stateSha256: string;
}

export type ActiveContextStateWireV2 = ActiveContextCheckpointV2 | ActiveContextDeltaV2;

export interface MappedMessage {
  index: number;
  message: unknown;
  ref: EvidenceRef | null;
}

export interface BranchObject {
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
  thresholds: ActiveContextThresholds;
  budgetTokens: number;
  protectedIndices: Set<number>;
  toolProtectedIndices: Set<number>;
  policy: typeof ACTIVE_CONTEXT_POLICY;
  toolName: string;
  brandNoun: string;
  entryTypePrefix: string;
  blacklistAutoFoldTools: ReadonlySet<string>;
  readOnlyContextActions: ReadonlySet<string>;
  contextWindow: number;
  windowSource: "reported" | "fallback";
}

export interface FoldCandidate {
  kind: FoldKind;
  parts: FoldPart[];
  sourceRefs: EvidenceRef[];
}

export const AUTO_FOLD_BLACKLIST_DEFAULT: ReadonlySet<string> = new Set();

export type AdvisoryMilestone = "orientation" | "notice" | "tools" | "chapters" | "urgent";
