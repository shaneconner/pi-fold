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
export type ActiveContextToolAction = typeof ACTIVE_CONTEXT_TOOL_ACTIONS[number];
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
