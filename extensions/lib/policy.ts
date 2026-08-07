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
  // The correction verbs. Curation the agent cannot fix afterwards is curation it
  // will not risk making, so re-briefing a fold and dissolving a mis-cut boundary
  // are part of the ordinary surface, not an epoch-only extra.
  "rebrief", "reboundary",
] as const);
/**
 * The epoch surface: the immediate actions plus `unmark`. A mark is a standing decision
 * rather than a one-shot attempt, so withdrawing one needs a verb of its own.
 *
 * There is deliberately NO agent-callable commit verb. Marking is the agent's job and
 * folding is the runtime's, and a verb the runtime is entitled to overrule is surface
 * without function: measured 2026-08-07 (rep 17), the agent called commit twice and the
 * runtime correctly held it both times. The internal commit paths -- the epoch commit,
 * the gated commit, the fence and the recovery lane -- are unchanged and unexposed.
 */
export const EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  ...ACTIVE_CONTEXT_TOOL_ACTIONS, "unmark",
] as const);
export type ActiveContextToolAction = typeof EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS[number];
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
/**
 * Commit when the ELIGIBLE marked mass is worth its one rewrite. Window pressure stays
 * underneath as the safety backstop; this is the economic trigger above it.
 */
export const EPOCH_ELIGIBLE_SHARE_COMMIT_THRESHOLD = 0.30;
/**
 * The reclaim floor, and the single constant that decides whether a commit is worth
 * firing at all.
 *
 * Measured on memex (19,082 calls, 254 sessions): a token-weighted pooled cache share
 * of 89.9% across two provider wires, with steady-state requests at 91.6% and any
 * request following a mutation at 15.7%. A fold costs exactly what one user message
 * costs. Their mutations are 5.3% of requests; rep 14's were about 34%, and that
 * FREQUENCY difference is the entire gap between their 90% and our 64% -- the
 * per-mutation penalty is the same on both.
 *
 * So a commit that would free less than this share of the truthful budget does not
 * fire: it defers and accumulates until it is worth a full prefix. Safety outranks
 * economics, so the hard fence and overflow recovery fire regardless.
 */
export const COMMIT_RECLAIM_FLOOR_SHARE = 0.02;

/**
 * The thermostat's lower line.
 *
 * The floor above says what is worth firing; this says how DEEP a firing goes. The
 * failure shape it removes is rep 13's crumb ratchet: a trigger that fires, frees a
 * little, and re-fires almost immediately, so the window climbs a staircase of
 * mutations. Firing at the trigger line and folding down to a target line makes the
 * spacing between events structural -- the next event cannot arrive until inflow has
 * refilled the gap -- so the window saws instead of climbing.
 *
 * The gap here is 15 points of a truthful budget. Rep 13's largest measured inflow step
 * was 27,815 tokens against a 400,000 window, about 7 points, so at least two full
 * worst-case steps must land before the trigger can re-arm, and the agent keeps roughly
 * two thirds of its budget as working room after every event. Eligibility still binds:
 * if the eligible mass cannot reach the target, the commit takes what it may and
 * records the shortfall rather than loosening a protection to hit a number.
 */
export const CURATION_TARGET_OCCUPANCY_SHARE = 0.35;
export const MAX_PENDING_MARKS = 256;
/** Enough batches to actually reach the floor on a wide window before the loop exits. */
export const EPOCH_MAX_TOPUP_MARKS = 64;
/** Estimate only; provider token accounting always comes from a measured response. */
export const ESTIMATED_BYTES_PER_TOKEN = 4;
/** Rendered navigation/topology overhead assumed around a brief when estimating a placeholder. */
export const ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES = 240;

// ---------------------------------------------------------------------------
// The reliability spine. Every behavior below shipped as an off-by-default lever
// through iterations 2 and 3 and was sealed ON by rep 14 (64/64), so it is now
// simply how pi-fold works: the flags and their conditional twins are gone, and
// git history is the lineage. What stays configurable is only what is genuinely a
// deployment fact (`providerTotalWindow`) or an experiment condition (`guidance`,
// `foldScheduling`, `foldPeekResults`, `guidedCuration`).
//
// Sealed unconditional: ephemeral peek (with the per-call `ephemeral` override),
// admission control, retained pending marks, the eligible-share commit trigger,
// stage-identified briefs, the current-turn commit guard, the pinned-mass backstop,
// the status index diet, delivery-counted advisories, and projection instrumentation.
// ---------------------------------------------------------------------------

/**
 * The provider serving window is the TOTAL admission budget minus whatever output
 * reservation the deployment actually asked for; the per-request max-input descriptor
 * assumes a full output reservation and understates the real ceiling. Measured
 * 2026-08-06: a run aborted at ~297k projected tokens against a 272k descriptor while
 * the same provider had just accepted 339,689 tokens. Declaring the total window is
 * the deployment's own fact, so it is the option; there is no separate boolean, and
 * an undeclared window falls back to the descriptor and SAYS so in the accounting.
 */

/** Narrowing is what makes a refusal governance instead of denial. */
export const PEEK_MIN_SLICE_BYTES = 1_024;

/** How many folds the dieted status payload ranks by what they would reclaim. */
export const STATUS_DIET_SUGGESTIONS = 5;

export const MAX_PROJECTION_HASH_RECORDS = 64;
export const MAX_PINNED_PEEKS = 64;

// ---------------------------------------------------------------------------
// Guided curation. The one iteration-4 experiment condition: the two-signal
// curation trigger, its bounded last-call gate, and the reactive receipt block.
// ---------------------------------------------------------------------------

export const DEFAULT_GUIDED_CURATION = false;

/**
 * Signal one: measured occupancy of the truthful serving budget.
 *
 * Four fifths, not half (Shane RULING 2026-08-06, after rep 15): below this line the
 * runtime is QUIET -- nothing folds automatically at all -- so the threshold is where
 * the fold event should happen, and the remaining fifth of the budget is the runway the
 * gate rounds and the commit itself spend. An earlier line buys announcement room by
 * spending window the agent still wants for the task.
 */
export const CURATION_OCCUPANCY_SHARE = 0.80;

/**
 * The two sparse reminders, as shares of the truthful serving budget.
 *
 * Exactly two per window cycle, one line each, informatory: mark chapters as you go so
 * the folds are neat when the fold event triggers. They are the ONLY pre-gate guidance
 * in guided curation -- recurring pressure nags trained rep 15's agent to ignore the
 * one message that mattered -- and they re-arm after each commit cycle, so a window that
 * climbs twice is reminded twice.
 */
export const CURATION_REMINDER_SHARES: readonly number[] = Object.freeze([0.45, 0.65]);

/**
 * Signal two: tool-result mass OUTSIDE the fresh tail, as a share of the window.
 * Occupancy alone announces commits a commit cannot serve -- a window full of
 * conversation has nothing stale to fold. Rep 14 ran 138 tool results over ~4.2MB of
 * payload against a 400k window, so a fifth of the window (~80k tokens, ~320KB) is
 * roughly a dozen ordinary results: reached early in a tool-heavy run, and never
 * reached by a run whose window is not actually made of stale tool output. It is half
 * the commit's own top-up target, so the announcement always precedes a commit that
 * has at least half a target of real mass to work with.
 */
export const CURATION_STALE_TOOL_SHARE = 0.20;

/**
 * The gate's hard round cap. Every context pass with the gate open consumes one round,
 * so the commit proceeds after at most this many passes NO MATTER WHAT the agent does;
 * a pass whose response was not a context-tool call proceeds immediately. Two is a
 * bounded conversation, not a negotiation, and it makes a stall non-constructible.
 */
export const CURATION_GATE_MAX_ROUNDS = 2;

/** How many automatic-action receipts stay in the window; the oldest ages out. */
export const MAX_CONTEXT_RECEIPTS = 3;
/** Hard byte cap on the rendered receipt block, so a receipt can never itself bloat. */
export const CONTEXT_RECEIPT_BLOCK_BYTES = 900;
/** Durable instrumentation records kept in the in-memory ledger for status. */
export const MAX_CONTEXT_ATTEMPT_RECORDS = 128;

// ---------------------------------------------------------------------------
// The mark response.
//
// Measured 2026-08-07 (rep 17): every context action was followed by a projection
// REWRITE, never an append, because the surface answered a mark by refreshing blocks
// the agent had already paid to cache. A tail-appended tool result is the one place
// left that can inform the agent for free, so the awareness moved THERE and the
// projection went byte-frozen between fold events. The result is bounded on the same
// principle as the receipt block: a report about bloat that becomes bloat has argued
// against itself.
// ---------------------------------------------------------------------------

/** Hard byte cap on the rendered awareness block a mark call answers with. */
export const CONTEXT_MARK_RESPONSE_BYTES = 900;
/** How many unmarked candidates the awareness block names; the remainder is an aggregate. */
export const MAX_UNMARKED_CANDIDATES = 3;

// ---------------------------------------------------------------------------
// Bite-sized folds and bounded peeks. These two constants are one decision read
// from two ends, so they are stated together and kept equal.
//
// Measured 2026-08-06 (rep 6): a single 60,432-byte chapter fold hid the needed
// fact in its tail, and every peek of it was either truncated short of the answer
// or too expensive to widen. A fold is only navigable if reading one back is cheap,
// so a fold's source is capped and an oversized span is SPLIT into sequential
// bounded folds, each with its own brief. The peek bound is the same number, so a
// default peek of one bite-sized fold returns it whole -- about 4,000 tokens, a
// read any session can afford -- and only a legacy oversized fold is ever truncated.
// ---------------------------------------------------------------------------

/** A fold whose exact source exceeds this is split into sequential bounded folds. */
export const MAX_FOLD_SPAN_CHARS = 16_000;
/**
 * The other bound: a SLIVER of stale raw content hugging a fold boundary is absorbed
 * into its later neighbour inside a commit the epoch already paid for.
 *
 * The threshold is deliberately tiny, measured in the session's own calibrated TOKENS,
 * and it is not pressure-scaled. Non-sequential curation is a first-class state: an
 * agent may hold folds at 10:20, 40:55 and 60:70 with raw spans between them ON
 * PURPOSE, and a mechanism that swallowed those gaps would quietly turn pi-fold into
 * system-controlled compaction with the curation element deleted. 256 tokens is about
 * one short prompt or one one-line result -- nobody deliberately keeps a sliver that
 * small as standing context -- and it sits an order of magnitude under the minimum
 * chapter size the ladder itself will fold. Anything larger stays raw permanently,
 * however ragged the projection looks; the ladder's ordinary fold eligibility is the
 * only thing that ever touches it, and absorption never becomes a second folding path.
 *
 * Later, not earlier, because extending the LATER fold backward mutates at a shallower
 * prefix position and preserves more of the cache. There is no content-affinity logic,
 * every absorption is receipted, and a wrong grouping is one `reboundary` away.
 */
export const MAX_WEDGE_ABSORB_TOKENS = 256;
/** What a peek returns without an explicit widening argument. */
export const PEEK_DEFAULT_MAX_BYTES = 16_000;
/** Head share of a truncated peek; the remainder is the tail, where conclusions live. */
export const PEEK_HEAD_SHARE = 0.6;

// ---------------------------------------------------------------------------
// Overflow rollback and recovery.
// ---------------------------------------------------------------------------

/**
 * How many times one inflow may be recovered before the runtime gives up.
 *
 * A provider context-overflow rejection mutates nothing durable -- the assistant
 * message never lands and the projection is rebuilt per request -- so recovery is a
 * reduction plus a rebuild, not a branch rewind. Two attempts is the cap: the first
 * folds at fence pressure with the guard fully waived, the second reaches into the
 * fresh tail, and a third would be asking the same question of the same evidence.
 * Past it the run fails LOUDLY, because an inflow that cannot fit after maximal
 * folding is a genuine impossibility rather than a recoverable state.
 */
export const OVERFLOW_RECOVERY_MAX_ATTEMPTS = 2;

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
  /** Epoch scheduling only; omitted when empty so immediate-mode state digests never move. */
  pendingMarks?: PendingMark[];
  /** Fold ids whose peek result the agent asked to keep raw. Omitted when empty. */
  pinnedPeeks?: string[];
  /**
   * Agent-corrected fold briefs, by fold id. A fold RECORD is content-addressed and
   * immutable -- rewriting its brief in place would report a conflicting durable fold
   * and suspend automatic management -- so a re-brief is durable state beside the
   * record rather than a mutation of it. Omitted when empty.
   */
  briefs?: Record<string, string>;
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
  briefs?: Record<string, string>;
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
  briefs?: Record<string, string>;
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
