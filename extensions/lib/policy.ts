import type { EvidenceRef } from "../json.ts";

export const DEFAULT_ACTIVE_CONTEXT_TOOL_NAME = "pi_fold_context";
export const DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX = "pi-fold-active-context";
export const DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL = "pi-fold Active Context";
export const DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN = "pi-fold";
export const DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES = Object.freeze({
  status: "fold-status",
  fold: "fold",
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
  "status", "peek", "fold", "expand", "refold", "pin", "unpin",
  "reboundary", "unmark",
] as const);
/**
 * REBRIEF IS DELETED (Shane, 2026-08-21). Every rebrief rewrites the projection at its
 * fold's placeholder, which breaks the prefix cache from that point on: sol-20260820
 * rep 7's first rebrief hit a front-of-projection fold, identical_share collapsed to
 * 0.0007, and nine ~185K-token requests ran cacheRead 0 for $8.36 in one burst. The
 * end block read 10 of 10 in every pifold rep with or without rebriefs, because
 * lossless peek already carries recall, so the action was paying a full cache break
 * for something the runtime did not need. The name stays spent.
 */
export const RETIRED_TOOL_ACTIONS: Readonly<Record<string, string>> = Object.freeze({
  rebrief: "rebrief is deleted: rewriting a standing fold's brief rewrites the projection " +
    "at that fold's placeholder and breaks the prefix cache from there on, for recall that " +
    "peek already carries losslessly. Write the brief you want when you mark the span, or " +
    "use reboundary to re-cut it.",
});
export type ActiveContextToolAction = typeof ACTIVE_CONTEXT_TOOL_ACTIONS[number];
export const USER_RESCUE_MAX_SOURCE_CHARS = 512_000;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const EXPAND_LEASE_GENERATIONS = 8;
export const MAX_EXPAND_LEASES = 64;

export const COMMIT_RECLAIM_FLOOR_SHARE = 0.02;

/**
 * How far below the commit trigger the agent is told a commit is coming (Shane,
 * 2026-08-22: "around 10% from the commit threshold"). A share of the serving budget
 * rather than a token count, because a token count means a different fraction of every
 * deployment's window. The advisory takes the wider of this and one worst recent inflow
 * step, so a single large result cannot step over the whole band unasked.
 */
export const STEWARD_WARNING_SHARE = 0.10;

export const MAX_PINNED_SHARE = 0.25;

export interface ActiveContextThresholds {
  maxTarget: number;
  minTarget: number;
  freshTail: number;
  consolidateAfter: number;
  minFoldChars: number;
}

/**
 * The floor a fold has to clear to be worth making, in CHARACTERS (Shane, 2026-08-21).
 *
 * Characters rather than tokens because characters are provider-agnostic: a token count
 * means a different amount of text on every wire, and this number exists so a person can
 * reason about it. It replaces two constants nobody could tell apart, minToolChars at
 * 2,000 and minChapterChars at 4,000, and it is not specific to tool results or to
 * chapters: everything in the window costs tokens, so everything counts toward the floor.
 *
 * It is a floor, not a cut. The automatic span accumulates whole messages and stops at
 * the first one that carries it OVER the floor, so a fold is always at least this big
 * and never cuts a message in half to hit the number exactly. The same floor is what a
 * gap between two folds has to clear to survive: anything smaller is absorbed by the
 * fold beside it rather than left as a raw sliver, because a sliver costs its bytes and
 * buys nothing.
 *
 * 8,000 was chosen against the sealed corpus. Rep 1 of sol-20260814-traps folded 89
 * spans at a median of 57,808 source chars, but nine of them came in under 8,000 and
 * TWO were net negative, 2,726 chars of source replaced by 5,341 of placeholder (196
 * percent) and 6,384 replaced by 10,531 (165 percent). A fold that grows the window is
 * not a fold. The floor sits above every observed inversion with room to spare.
 */
export const MINIMUM_FOLD_CHARS_FLOOR = 2_000;

export const DEFAULT_THRESHOLDS: Readonly<ActiveContextThresholds> = Object.freeze({
  maxTarget: 0.80,
  // 0.20, down from 0.35 (Shane 2026-08-14). The cut depth is what sets the epoch
  // cadence: every commit rewrites the prefix from the earliest folded byte, so the
  // cost of an epoch is nearly flat in how deep it cuts, while the relief it buys is
  // the whole distance to the trigger. sol-20260814-traps rep 1 ran six commits, each
  // freeing to 0.35 and refilling in two to three stages; at 0.20 the same run shape
  // owes roughly a quarter fewer epochs, which is a quarter fewer full-prefix
  // rewrites, the dominant self-inflicted cache break. The floor is a target the
  // class law outranks, not a guarantee: a session pinned to the 0.25 ceiling
  // beside the 0.02 fresh tail legally holds 0.27 and lands above this number,
  // and the epoch receipt reports targetBudgetShare beside actualFreedBudgetShare
  // so the shortfall is a readable fact per epoch rather than a silent miss. The
  // validation laws below bind exactly as before.
  minTarget: 0.20,
  // 0.10, up from 0.02 (Shane 2026-08-21). The tail is what the current turn is still
  // reading, and 2 percent of a 250k budget is 5,000 tokens, roughly one large tool
  // result. The guard catches what the tail misses, but the guard is a commit-time
  // decision and the tail is a standing promise, so the promise should be the one a
  // person can reason about: a tenth of the window stays raw.
  freshTail: 0.10,
  consolidateAfter: 10,
  minFoldChars: 8_000,
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
    throw new ThresholdPolicyError("shape", "thresholds must be an object with all five fields");
  }
  const supplied = value as Record<string, unknown>;
  const fields = ["maxTarget", "minTarget", "freshTail", "consolidateAfter", "minFoldChars"] as const;
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
  const minFoldChars = supplied.minFoldChars;
  if (typeof minFoldChars !== "number" || !Number.isInteger(minFoldChars) ||
      minFoldChars < MINIMUM_FOLD_CHARS_FLOOR) {
    throw new ThresholdPolicyError("minFoldChars",
      "thresholds.minFoldChars must be an integer character count of at least " +
      `${MINIMUM_FOLD_CHARS_FLOOR}; below that a fold can cost more placeholder than the ` +
      "source it replaces");
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
  return { maxTarget, minTarget, freshTail, consolidateAfter, minFoldChars };
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

export const STATUS_DIET_INDEX_ROWS = 5;

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

export const MAX_CONTEXT_RECEIPTS = 3;
export const CONTEXT_RECEIPT_BLOCK_BYTES = 900;

export const CONTEXT_MARK_RESPONSE_BYTES = 900;
export const CONTEXT_STATUS_RESPONSE_BYTES = 24_000;
export const MAX_UNMARKED_CANDIDATES = 3;

export const MAX_FOLD_SPAN_CHARS = 16_000;
export const PEEK_DEFAULT_MAX_BYTES = 16_000;
export const PEEK_HEAD_SHARE = 0.6;

/**
 * A PEEK IS EPHEMERAL UNLESS THE AGENT SAYS OTHERWISE (Shane, 2026-08-22).
 *
 * The default follows the measured choice rather than the cautious one. On sealed run
 * rep 7, six of seven peeks asked for ephemeral at first organic exposure, and the one
 * durable read was the stage-64 probe, exactly where the bytes were wanted standing.
 * The economics agree: a peek is a pure append and costs the cache nothing, while the
 * withdrawal is a tail operation at the withdrawn result's own index, so the cheap read
 * should be the one you get without asking.
 *
 * Only an explicit false is durable. A missing value, and anything the validator has
 * already rejected, reads as ephemeral, so a host or model that never learned the
 * argument still gets the cheap behaviour and can still recover the bytes by peeking
 * again, which is lossless.
 */
export function peekIsEphemeral(params: Record<string, unknown> | undefined | null): boolean {
  return params?.ephemeral !== false;
}

export const PEEK_READ_ONLY_CONTEXT_ACTIONS: ReadonlySet<string> = new Set(["status", "peek"]);

/** "user" is a mark laid down by the human through /fold-editor; it stages and
 *  commits through the same validated path as an agent mark and counts toward the
 *  commit's coverage the same way. */
export type MarkOrigin = "agent" | "ladder" | "user";

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
  responseReserve: 16_384,
  // The most exact source bytes ONE read may put back in the window, whichever verb
  // asks: an expand collapses its biggest children until the render fits, and a peek
  // clamps its `bytes` to it. Was two numbers until 2026-08-22, when the peek ceiling
  // was `maxChapterChars` 128,000 and that constant also claimed to cap a chapter.
  maxSourceChars: 200_000,
  maxBriefChars: 2_000,
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

export interface ActiveContextState {
  version: 1;
  sessionId: string;
  revision: number;
  folds: ActiveFold[];
  expanded: string[];
  protected: EvidenceRef[];
  tokensSinceToolFold: number;
  leases: Record<string, number>;
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
