import type { EvidenceRef } from "../json.ts";

export const DEFAULT_ACTIVE_CONTEXT_TOOL_NAME = "active_context";
export const DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX = "pi-fold-active-context";
export const DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL = "Active Context";
export const DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN = "active-context";
export const DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES = Object.freeze({
  status: "context",
  fold: "fold-context",
});
export const GUIDANCE_PROFILES = Object.freeze(["pressure", "curation", "minimal"] as const);
export type GuidanceProfile = typeof GUIDANCE_PROFILES[number];
export const DEFAULT_GUIDANCE_PROFILE: GuidanceProfile = "pressure";

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
export const NATIVE_COMPACTION_RECEIPT_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-native-compaction-receipt`;
export const NATIVE_COMPACTION_DECISION_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-native-compaction-decision`;
export const PROVIDER_CONTEXT_MEASUREMENT_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-provider-context-measurement`;
export const ACTIVE_CONTEXT_STATUS_KEY = DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
export const ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  "status", "peek", "fold", "expand", "refold", "protect", "unprotect",
] as const);
/** The immediate-mode surface plus the epoch-mode commit verb. */
export const EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  ...ACTIVE_CONTEXT_TOOL_ACTIONS, "commit",
] as const);
/**
 * Retained pending marks make "mark" a standing decision rather than a one-shot
 * attempt, so withdrawing one needs a verb of its own. It exists only where marks
 * can be retained; nothing else grows a surface it cannot use.
 */
export const RETAINED_MARK_ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  ...EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS, "unmark",
] as const);
export type ActiveContextToolAction = typeof RETAINED_MARK_ACTIVE_CONTEXT_TOOL_ACTIONS[number];
export const USER_RESCUE_MAX_SOURCE_CHARS = 512_000;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const TOOL_FOLD_CADENCE_MIN_TOKENS = 12_000;
export const TOOL_FOLD_CADENCE_WINDOW_FRACTION = 0.06;
export const EXPAND_LEASE_GENERATIONS = 8;
export const MAX_EXPAND_LEASES = 64;
export const CONSOLIDATION_WIDTH_THRESHOLD = 10;
export const MAX_ADVISORY_DELIVERIES_PER_MILESTONE = 16;

// Ephemeral surfacing structure. These stay INTERNAL constants rather than public
// options: they are the knobs the surfacing experiment is meant to settle, and an
// option surface fixed before the accept/reject data exists would freeze a guess.
export const DEFAULT_SURFACING_ENABLED = true;
export const SURFACING_TOP_K = 3;
export const SURFACING_MIN_SCORE = 0.30;
export const SURFACING_CHAR_BUDGET = 1_000;
export const SURFACING_COOLDOWN_ORDINALS = 8;
export const SURFACING_OUTCOME_WINDOW_ORDINALS = 12;
export const SURFACING_RECENT_TASK_SPANS = 6;
export const SURFACING_MAX_TASK_CHARS = 12_000;
export const SURFACING_MAX_LOG_RECORDS = 128;
export const SURFACING_LEXICAL_WEIGHT = 0.80;
export const SURFACING_RECENCY_WEIGHT = 0.14;
export const SURFACING_DEPTH_WEIGHT = 0.06;
export const SURFACING_MAX_DEPTH = 4;
export const SURFACING_MAX_TEXT_CHARS = 220;
export const SURFACING_SOURCE_ID = "fold-brief";

// Conservative LOWER bound on UTF-8 bytes per provider token, used only to cap
// the protected byte tail as a share of a small window; never to estimate usage.
export const BYTES_PER_TOKEN_FLOOR = 2;

// Two-phase fold scheduling. A provider prefix cache is positional: any mid-window
// edit invalidates every byte after it, so the cost of folding is dominated by how
// OFTEN the projection changes, not by how much it saves. In "epoch" mode a fold
// decision becomes a free MARK and a later COMMIT applies every pending mark in one
// rewrite. "immediate" is the default and is byte-identical to pre-0.1.2 behavior.
export const FOLD_SCHEDULING_MODES = Object.freeze(["immediate", "epoch"] as const);
export type FoldSchedulingMode = typeof FOLD_SCHEDULING_MODES[number];
export const DEFAULT_FOLD_SCHEDULING: FoldSchedulingMode = "immediate";

// Epoch knobs stay INTERNAL constants for the same reason the surfacing knobs do:
// they are what the round-2 cost measurement exists to settle, and an option surface
// fixed before that data would freeze a guess.
/**
 * An automatic commit tops up with stale tool batches until it would free this share
 * of the window. It is a FLOOR under an epoch's accumulated marks, not the driver of
 * one, so it is set where a commit is unambiguously worth its single rewrite.
 */
export const EPOCH_COMMIT_TARGET_WINDOW_SHARE = 0.40;
/** A fold whose span begins within this many mapped messages of the tail invalidates almost nothing. */
export const EPOCH_TAIL_ADJACENT_MESSAGES = 16;
export const MAX_PENDING_MARKS = 256;
/** Enough batches to actually reach the floor on a wide window before the loop exits. */
export const EPOCH_MAX_TOPUP_MARKS = 64;
/** Estimate only; provider token accounting always comes from a measured response. */
export const ESTIMATED_BYTES_PER_TOKEN = 4;
/** Rendered navigation/topology overhead assumed around a brief when estimating a placeholder. */
export const ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES = 240;

// ---------------------------------------------------------------------------
// Iteration-2 reliability levers. Every one of them is OFF by default, because
// the immediate-mode default projection and durable state are pinned byte-for-byte
// by an offline gate; a lever that changed either without being asked for would be
// a regression no matter how good it is.
// ---------------------------------------------------------------------------

/**
 * A peek copies a fold's stored source back into the window. Those bytes are a pure
 * duplicate of evidence the runtime still holds losslessly, and once the model call
 * that asked for them has answered, keeping them costs a full window slot for nothing.
 * With this on, a CONSUMED peek result renders as a short recall stub in the next
 * projection unless the agent expanded the fold or pinned the read.
 */
export const DEFAULT_EPHEMERAL_PEEK = false;

/**
 * The provider serving window is the TOTAL admission budget minus whatever output
 * reservation the deployment actually asked for; the per-request max-input descriptor
 * assumes a full output reservation and understates the real ceiling. Measured
 * 2026-08-06: a run aborted at ~297k projected tokens against a 272k descriptor while
 * the same provider had just accepted 339,689 tokens.
 */
export const DEFAULT_TRUTHFUL_CAPACITY = false;
export const DEFAULT_PROVIDER_TOTAL_WINDOW = 400_000;

/** Preflight a peek/expand against the target's exact stored size and real headroom. */
export const DEFAULT_ADMISSION_CONTROL = false;
/** Narrowing is what makes a refusal governance instead of denial. */
export const PEEK_MIN_SLICE_BYTES = 1_024;

/** Marks refused at commit are kept pending instead of silently dropped. */
export const DEFAULT_RETAIN_PENDING_MARKS = false;

/** Commit when the ELIGIBLE marked mass is worth its one rewrite, not when the window is nearly full. */
export const DEFAULT_ELIGIBLE_SHARE_COMMIT = false;
export const DEFAULT_ELIGIBLE_SHARE_COMMIT_THRESHOLD = 0.30;

/**
 * A deterministic read-only tool fold used to describe itself with one generic
 * sentence per tool, so every fold of the same tool carried the SAME brief and no
 * index could answer "which fold holds X". Measured 2026-08-06: three probe answers
 * lived in two stage folds and no run, control included, ever peeked the right one.
 * With this on the automatic brief carries bounded exact anchors instead: the call
 * arguments, a leading label from the result head, and a TRAILING anchor from the
 * result tail, where chain keys and conclusions live.
 */
export const DEFAULT_STAGE_IDENTIFIED_BRIEFS = false;

/** The default status payload stops carrying the whole fold tree. */
export const DEFAULT_STATUS_INDEX_DIET = false;
export const STATUS_DIET_SUGGESTIONS = 5;

/**
 * Count an advisory when it is DELIVERED, not when it is armed. Arming used to spend
 * the milestone budget, and any automatic fold in the same context pass cleared the arm
 * before it was ever projected, so the budget drained with zero deliveries.
 */
export const DEFAULT_ADVISORY_DELIVERY = false;

/** Split real projection rewrites from provider-side cache-miss observations. */
export const DEFAULT_PROJECTION_INSTRUMENTATION = false;
export const MAX_PROJECTION_HASH_RECORDS = 64;
export const MAX_PINNED_PEEKS = 64;

/** Active-context tool actions that read without mutating, so their results may fold. */
export const READ_ONLY_CONTEXT_ACTIONS_DEFAULT: ReadonlySet<string> = new Set(["status"]);
/**
 * The classification that also lets a `peek` result be reclaimed by the tool-fold rung.
 * A peek copies a fold's own stored source back into the window, so leaving it raw is a
 * pure duplicate of evidence the runtime already holds; epoch scheduling adopts this set
 * unconditionally, and immediate scheduling reaches it through `foldPeekResults`.
 */
export const PEEK_READ_ONLY_CONTEXT_ACTIONS: ReadonlySet<string> = new Set(["status", "peek"]);

export type MarkOrigin = "agent" | "ladder";

/** A fold decided but not yet applied: no projection byte has moved for it. */
export interface PendingFoldMark {
  mark: "fold";
  id: string;
  kind: FoldKind;
  parts: FoldPart[];
  brief: string;
  briefProvenance: BriefProvenance;
  origin: MarkOrigin;
  /** Transcript ordinal at mark time; orders the commit. Never a wall clock. */
  ordinal: number;
}

/** An expanded fold decided to return to its placeholder at the next commit. */
export interface PendingRefoldMark {
  mark: "refold";
  id: string;
  origin: MarkOrigin;
  ordinal: number;
}

export type PendingMark = PendingFoldMark | PendingRefoldMark;

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
      kind: "model" | "luna";
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

export type SurfacingOutcome = "shown" | "accept" | "reject";

/** One durable surfacing observation: what was shown, how it scored, and what the agent did. */
export interface SurfacingRecord {
  source: string;
  id: string;
  score: number;
  ordinal: number;
  outcome: SurfacingOutcome;
}

/** One item a suggestion source offers for the shared carrier. */
export interface SurfacingCandidate {
  source: string;
  id: string;
  text: string;
  route: string;
  alternateRoute?: string;
  /** Transcript position used for recency; higher is more recent. Never a wall clock. */
  position?: number;
  depth?: number;
}

export interface SurfacingSuggestion extends SurfacingCandidate {
  score: number;
}

export interface SuggestionSourceInput {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  toolName: string;
}

export interface SuggestionSource {
  id: string;
  candidates: (input: SuggestionSourceInput) => SurfacingCandidate[];
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
  /** Epoch scheduling only; omitted when empty so pre-0.1.2 state digests never move. */
  pendingMarks?: PendingMark[];
  /**
   * Fold ids whose peek result the agent asked to keep raw. Ephemeral peek only, and
   * omitted when empty for the same reason `pendingMarks` is: a key that appears only
   * when a lever is used cannot move a default digest.
   */
  pinnedPeeks?: string[];
  prepared?: PreparedFold;
  advisory?: {
    highWater: number;
    delivered: Record<string, number>;
    armed?: { milestone: AdvisoryMilestone; threshold: number; scheduleKey: string };
  };
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
  advisory?: NonNullable<ActiveContextState["advisory"]>;
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
  pendingMarks?: PendingMark[];
  advisory?: NonNullable<ActiveContextState["advisory"]>;
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
  protectedIndices: Set<number>;
  toolProtectedIndices: Set<number>;
  policy: typeof ACTIVE_CONTEXT_POLICY;
  toolName: string;
  brandNoun: string;
  entryTypePrefix: string;
  readOnlyTools: ReadonlySet<string>;
  /** Active-context tool actions treated as read-only when classifying tool batches. */
  readOnlyContextActions: ReadonlySet<string>;
  contextWindow: number;
  windowSource: "reported" | "fallback";
  /** Consumed peek results render as recall stubs instead of duplicate source bytes. */
  ephemeralPeek: boolean;
  /** Automatic tool briefs carry bounded exact call arguments and result anchors. */
  stageIdentifiedBriefs: boolean;
}

export interface FoldCandidate {
  kind: FoldKind;
  parts: FoldPart[];
  sourceRefs: EvidenceRef[];
}

export const READ_ONLY_TOOLS_DEFAULT = new Set([
  "read", "grep", "find", "ls",
]);

export type AdvisoryMilestone = "orientation" | "notice" | "tools" | "chapters" | "urgent";
