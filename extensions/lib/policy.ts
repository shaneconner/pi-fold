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
/**
 * How many unbriefed pending folds stand before the runtime says so.
 *
 * A CONSTANT, not a threshold the deployment can turn (Shane's KISS rule): it is a
 * batching size, and the only thing a knob here would buy is a deployment that never
 * speaks. Three is the smallest batch that reads as a batch rather than as a running
 * commentary on every cut.
 */
export const UNBRIEFED_FOLDS_BEFORE_NOTICE = 3;

/**
 * How many spans the frontier cuts on one projection pass.
 *
 * A CONSTANT, and a cost bound rather than a policy. Each cut rescans the window for the
 * next stalest span, so an unbounded loop is quadratic in the number of spans a window
 * holds: on a 300-turn fixture it took a gate from 2.5 seconds to 152. A frontier does not
 * need to catch up in one pass, because a pass costs nothing to repeat and the material it
 * has not reached yet is still raw and still in front of the agent, which is where the
 * design wants it. Eight is comfortably ahead of any real arrival rate.
 */
export const MAX_FRONTIER_CUTS_PER_PASS = 8;

export const ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  "status", "peek", "brief", "expand", "refold", "pin", "unpin",
  "reboundary", "unmark",
] as const);
/**
 * FOLD IS DELETED AS AN AGENT VERB (Shane, 2026-08-23), and `brief` is what replaced it.
 *
 * The agent used to choose spans from nothing. Measured against real compaction
 * boundaries on 2026-08-23, that produced a projection byte-identical to the same arm
 * with no agent at all: six marks, 9,450 characters of briefs, same visible count, same
 * fold count, same aborts. It marks what the ladder would have taken anyway, because at
 * the moment it is asked the only information available is staleness and the runtime
 * already has that.
 *
 * So the runtime cuts at the frontier and the agent annotates what it cut, while the
 * material is still in front of it. `brief` attaches or replaces the brief on a PENDING
 * fold and refuses on a standing one, which is the rebrief deletion above read from the
 * other side: a pending mark is not in the window, so writing its brief moves no bytes
 * and costs no cache, and a standing fold's placeholder is in the window, so writing that
 * one costs the whole prefix from there on. The name `fold` stays spent.
 */
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
export const MAX_PINNED_SHARE = 0.25;

/**
 * THE TOOL-CALL DIET's default share (Shane 2026-08-28, on the sol-20260826-full2
 * verdict). Every fold repetition from 3 onward ran 0.50 and the campaign's headline
 * results are all from that shape, so the shipped default is the measured value rather
 * than the absence of one. A deployment turns the diet off with an explicit 0, which is
 * why the option's range is [0, 1) instead of the open interval it shipped with: one
 * meaning per value, and no absent-means-off special case.
 */
export const DEFAULT_TOOL_FOLD_THRESHOLD = 0.50;

export interface ActiveContextThresholds {
  maxTarget: number;
  minTarget: number;
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
  // 0.20 (Shane 2026-08-28, on the sol-20260826-full2 verdict). This number went 0.20 ->
  // 0.40 on 2026-08-23 and came back on the campaign that was still running when it
  // moved, so both readings are recorded here rather than one quietly replacing the
  // other. The top of the band is not in question and never was.
  //
  // Read against the 19 mature sealed pifold runs that share a 251,520-token budget,
  // where the trigger sat at 0.80 of it, 201,216 tokens. Peak occupancy per run came in
  // at a median 237,399, a 0.944 share, p90 247,551, max 257,117: a session runs roughly
  // 36,000 tokens PAST its own trigger before the commit it fired takes effect, because
  // the trigger fires at a measurement and inflow continues while the epoch is computed.
  // So 0.80 already delivers a 250k top, and raising it toward 250k directly would put
  // the median peak over the budget and into the fence.
  //
  // The 2026-08-23 case for 0.40 was that it seats the floor near where commits actually
  // land: across 206 commit landings the session came to rest at a median 79,034 tokens,
  // 153 of the 206 below 100,000, and landings sit ABOVE the aim rather than at it, since
  // the class law and the available material both outrank it. That was bought knowing the
  // price, about a fifth more epochs and so a fifth more full-prefix rewrites, to hold
  // 100k of raw context across the whole cycle.
  //
  // The campaign priced the trade and it went the other way. The commit rewrite tax is
  // minTarget / (maxTarget - minTarget), because every commit re-reads roughly
  // minTarget x budget of prefix uncached and a shallower cut buys less runway for nearly
  // the same bill: 1.0 at 0.80/0.40 against 0.33 at 0.80/0.20. Every sol-20260826-full2
  // fold repetition from 3 onward ran 0.80/0.20, including the fold-plus-canon rep 5 that
  // answered 14 of 16 with nothing wrong at $100.85 against native-plus-canon's $201.70.
  // The shipped default is now the configuration that was measured.
  //
  // THE KNOWN LIMIT, unchanged and still true: MAX_PINNED_SHARE is 0.25, so a fully
  // pinned session legally holds more than a 0.20 aim asks for, and there the commit
  // stops short of its target by construction rather than by fault. The epoch receipt
  // reports targetBudgetShare beside actualFreedBudgetShare, so the shortfall stays a
  // readable fact per epoch rather than a silent miss. The validation laws below bind
  // exactly as before.
  minTarget: 0.20,
  consolidateAfter: 10,
  minFoldChars: 8_000,
});

export const MINIMUM_SUPPORTED_BUDGET_TOKENS = 10_000;

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
  const fields = ["maxTarget", "minTarget", "consolidateAfter", "minFoldChars"] as const;
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
  return { maxTarget, minTarget, consolidateAfter, minFoldChars };
}

export function assertThresholdsServable(_thresholds: ActiveContextThresholds, budgetTokens: number): void {
  if (!Number.isFinite(budgetTokens) || budgetTokens < MINIMUM_SUPPORTED_BUDGET_TOKENS) {
    throw new ThresholdPolicyError("minimumBudget",
      `a ${Math.floor(budgetTokens)}-token serving budget is below the ` +
      `${MINIMUM_SUPPORTED_BUDGET_TOKENS}-token minimum this package supports`);
  }
}

export function servingBudgetTokens(window: number): number {
  const resolved = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  return resolved - Math.min(ACTIVE_CONTEXT_POLICY.responseReserve, Math.floor(resolved * 0.1));
}

export const MAX_PENDING_MARKS = 256;
export const ESTIMATED_BYTES_PER_TOKEN = 4;

/**
 * What one image in the window is worth, in tokens, for estimation only.
 *
 * A provider prices an image from its DIMENSIONS, not its byte size: Anthropic bills
 * about width x height / 750, which puts a 2000x563 screenshot near 1,500 tokens, and a
 * large image caps close to this number once the long edge is scaled to the 1568px limit.
 * The exact figure differs per provider and cannot be known from the base64 alone.
 *
 * It does not need to be exact. The value it replaces was the image's base64 length
 * divided by a prose chars-per-token ratio, which read one screenshot as 110,000 tokens
 * against a true cost near 1,500. Being within an order of magnitude ends the failure;
 * the provider anchor corrects the rest as soon as a real measurement lands. A constant
 * rather than an option, because nobody can tune this better than the anchor can.
 */
export const IMAGE_ESTIMATED_TOKENS = 1_600;
export const ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES = 240;

export const PEEK_MIN_SLICE_BYTES = 1_024;

export const STATUS_DIET_INDEX_ROWS = 5;

export const MAX_CONTEXT_RECEIPTS = 3;
export const CONTEXT_RECEIPT_BLOCK_BYTES = 900;

/**
 * The post-fold notice's bound, and its own rather than the receipt block's.
 *
 * It is larger because it carries a variable-length list the receipt does not: three
 * fixed sentences of instruction plus one entry per unbriefed fold, and the pending set
 * grows past MAX_FRONTIER_CUTS_PER_PASS whenever the frontier stages faster than the
 * agent answers. 1,200 seats the instruction and roughly eight folds; past that the list
 * gives way and states how many it could not name.
 */
export const FOLD_NOTICE_BYTES = 2_400;
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

export const PEEK_READ_ONLY_CONTEXT_ACTIONS: ReadonlySet<string> = new Set(["status", "peek", "recall"]);

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
  // THE TOOL-CALL DIET (2026-08-24): at COMMIT TIME ONLY, a stale tool result inside
  // the configured toolFoldThreshold share of the projected window is clipped IN VIEW
  // to an identified head, the full bytes staying peek-recoverable behind its entry id.
  // The head keeps the leading paragraph up to its cap (gate 134's rule); results at or
  // under the floor stay whole, because clipping a small result buys almost nothing and
  // adds a peek indirection. Constants, not options, for v1: the share point is the one
  // public knob.
  toolClipHeadChars: 500,
  toolClipFloorChars: 2_000,
  maxBriefChars: 2_000,
  // The agent's share of maxBriefChars when a supplied brief augments the deterministic
  // head (sol-20260823-live rep 7: supplied briefs REPLACED the fact-carrying head and
  // 74 of 95 peeks recovered values the run's own briefs dropped). The head keeps the
  // remainder, so identification can never be displaced by a long agent clause.
  agentBriefReserve: 600,
  orientationMessages: 2,
  maxOrientationChars: 12_000,
});

export type FoldKind = "tool-result" | "chapter" | "consolidation";
export type ToolClip = { callId: string; entryId: string };
export type FoldPart = { kind: "raw"; ref: EvidenceRef } | { kind: "fold"; foldId: string };
export type BriefProvenance =
  | { kind: "supplied" }
  | { kind: "deterministic" }
  | { kind: "augmented" }
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
  clips?: ToolClip[];
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
  clips?: ToolClip[];
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
  // `clips` on a delta is the WHOLE array: what every delta written before 2026-08-24
  // carries, and what sealed sessions replay. New deltas carry the change instead. Clips
  // are appended and never edited, so the change is a count of what the base already holds
  // plus the ones that are new; a rollback that shortens the array states a lower count.
  // The order list the marks use would be WORSE than the bug here, because a callId is
  // about a hundred characters and re-listing thirty of them on every delta costs more
  // than the array it replaces.
  clips?: ToolClip[];
  clipBase?: number;
  addClips?: ToolClip[];
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
