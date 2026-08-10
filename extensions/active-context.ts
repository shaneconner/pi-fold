import {
  denseOwnArrayValues,
  evidenceSha256,
  objectRefKey,
  sha256Value,
  stableStringify,
} from "./json.ts";
import {
  bytes,
  clone,
  emptyActiveContextState,
  ownValue,
  sessionEntryMessages,
  uniqueMessageDigestAnchor,
} from "./lib/canonical.ts";
import {
  activeContextStatus,
  automaticPreparationId,
  boundStatusPayload,
  commitPreparedFold,
  descendantIds,
  encodedFoldSource,
  foldCandidatesDetail,
  foldTreeDetail,
  peekFoldSource,
  prepareFold,
  preparedFoldError,
  projectActiveContext,
  projectionSlateCandidates,
  protectEvidence,
  requireActiveFold,
  selectAutomaticChapter,
  selectAutomaticRung,
  setFoldProjectionState,
  withExpandLease,
} from "./lib/folding.ts";
import {
  admissionVerdict,
  boundReceiptText,
  boundedInteger,
  capacityAccounting,
  contextUsageRatio,
  contextWindowFor,
  explicitProtectedMass,
  budgetOccupancy,
  hardFenceRatio,
  latestProviderContextMeasurement,
  orderedRoots,
  parseNativeCompactionCompletion,
  parseNativeCompactionDecision,
  parseProviderContextMeasurementReceipt,
  persistenceProjection,
  protectedStaleMass,
  providerContextMeasurement,
  providerTokens,
  refsProtected,
  stringIds,
  toolRefsProtected,
  toolPayload,
} from "./lib/measurement.ts";
import type {
  NativeCompactionCompletionReceipt,
  NativeCompactionDecisionReceipt,
  ProviderContextMeasurement,
  ProviderMeasurementAnchor,
} from "./lib/measurement.ts";
import {
  childFoldIds,
  clearPrepared,
  deriveFoldParents,
  flattenFoldRefs,
  foldBrief,
  foldIdFor,
  makeFoldRecordEntry,
  makeStateCheckpoint,
  makeStateDelta,
  MAX_ACTIVE_FOLD_RECORDS,
  materializeStatePersistence,
  normalizeFoldsForPersistedRecords,
  normalizeLegacyProvenance,
  protectionSha256,
  sameStateProjection,
  semanticStateSha256,
  topologySha256,
} from "./lib/persistence.ts";
import type { MaterializedStatePersistence } from "./lib/persistence.ts";
import {
  activeContextSource,
  ACTIVE_CONTEXT_POLICY,
  ACTIVE_CONTEXT_TOOL_ACTIONS,
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES,
  DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
  DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  COMMIT_RECLAIM_FLOOR_SHARE,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_CONTEXT_WINDOW,
  MAX_THRESHOLD_NOTICES,
  THRESHOLD_NOTICE_SHARES,
  resolveGuidance,
  assertThresholdsServable,
  resolveThresholds,
  servingBudgetTokens,
  ESTIMATED_BYTES_PER_TOKEN,
  entryTypeNamespace,
  MAX_FOLD_SPAN_CHARS,
  MAX_PINNED_SHARE,
  MAX_WEDGE_ABSORB_TOKENS,
  OVERFLOW_RECOVERY_MAX_ATTEMPTS,
  PEEK_DEFAULT_MAX_BYTES,
  PEEK_MIN_SLICE_BYTES,
  PEEK_READ_ONLY_CONTEXT_ACTIONS,
  AUTO_FOLD_BLACKLIST_DEFAULT,
  SURFACING_BRIEF_HIT,
  SURFACING_CONTENT_HIT,
  SURFACING_DIVERGENCE_MARGIN,
  SURFACING_OUTCOME_WINDOW_ORDINALS,
  SURFACING_SLATE_SIZE,
  USER_RESCUE_MAX_SOURCE_CHARS,
} from "./lib/policy.ts";
import type {
  ActiveContextGuidance,
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveContextThresholds,
  ActiveContextToolAction,
  FoldCandidate,
  FoldKind,
  FoldRecordEntry,
  PreparedFold,
} from "./lib/policy.ts";
import {
  absorbWedgeMarks,
} from "./lib/scheduling.ts";
import {
  contextReceipt,
  contextRiderText,
  curationSignals,
  lastCallText,
  markAwarenessText,
  receiptBlockText,
  thresholdNoticeText,
  withReceipt,
} from "./lib/curation.ts";
import type {
  ContextReceipt,
  CurationSignals,
} from "./lib/curation.ts";
import {
  addPendingMark,
  claimedRefKeys,
  commitPendingMarks,
  ephemeralPeekMarks,
  epochCommitDue,
  estimatedTokens,
  foldMarkFor,
  ladderSelectionMark,
  ladderBrief,
  markAccounting,
  markEligibility,
  markFreedBytes,
  unmarkedRemainder,
  guardWaiverCount,
  markedFoldIds,
  markOrdinal,
  pendingMarks,
  markTouchesCurrentTurn,
  schedulingStatus,
  topUpMarks,
  withPendingMarks,
} from "./lib/scheduling.ts";
import {
  automaticToolBrief,
  candidateSpanChars,
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  manualFoldCandidate,
  peekedSourceFoldIds,
  selectAutomaticToolBatch,
  snapFoldCandidate,
  snapToFoldBoundaries,
  splitCandidateBySize,
} from "./lib/selection.ts";
import type { SpanCorrection } from "./lib/selection.ts";
import {
  issueSurfacing,
  noteSurfacingAction,
  resolveSurfacing,
  selectSurfacingSlate,
  surfacingLedger,
  surfacingSilenced,
  surfacingSlateText,
} from "./lib/surfacing.ts";
import {
  compareProjections,
  emptyLedger,
  ledgerSummary,
  messageDigests,
  observeCacheUsage,
  prefixDivergence,
  recordContextEvent,
  recordProjection,
} from "./lib/instrumentation.ts";
import type {
  ContextEvent,
  ContextEventKind,
  ProjectionChange,
} from "./lib/instrumentation.ts";
import { buildActiveContextCommands, buildActiveContextTool } from "./lib/tool-surface.ts";
import {
  currentTurnRefKeys,
  mapActiveContext,
} from "./lib/transcript.ts";
import {
  findOverflowErrorEntry,
  overflowEventShape,
  preStripHolds,
  probeRollbackSurfaces,
  rollbackNoticeText,
  unansweredToolCalls,
} from "./lib/rollback.ts";

// Test seam only; the package API is registerPiFold because package.json exports block deep imports.
export * from "./lib/canonical.ts";
export * from "./lib/curation.ts";
export * from "./lib/folding.ts";
export * from "./lib/instrumentation.ts";
export * from "./lib/measurement.ts";
export * from "./lib/persistence.ts";
export * from "./lib/policy.ts";
export * from "./lib/rollback.ts";
export * from "./lib/scheduling.ts";
export * from "./lib/selection.ts";
export * from "./lib/surfacing.ts";
export * from "./lib/transcript.ts";

/**
 * The batched fold request: several {span, brief} pairs in one call, with the single
 * `ids` form still accepted because it is the shape a status action hands back.
 */
export interface BatchedMarkRequest {
  ids: string[];
  brief?: string;
}

export function batchedMarkRequests(params: Record<string, unknown>): BatchedMarkRequest[] {
  const batched = params.marks;
  if (batched === undefined) {
    return [{
      ids: stringIds(params.ids),
      ...(typeof params.brief === "string" && params.brief.trim() ? { brief: params.brief } : {}),
    }];
  }
  const values = denseOwnArrayValues(batched);
  if (!values || !values.length || values.length > 64) {
    throw new Error("marks must be a dense array of 1-64 {ids, brief} objects");
  }
  return values.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`marks[${index}] must be an object with ids and an optional brief`);
    }
    const brief = ownValue(value, "brief");
    if (brief !== undefined && (typeof brief !== "string" || !brief.trim())) {
      throw new Error(`marks[${index}].brief must be a nonempty string`);
    }
    return {
      ids: stringIds(ownValue(value, "ids")),
      ...(typeof brief === "string" && brief.trim() ? { brief } : {}),
    };
  });
}

export function registerActiveContext(pi: any, options: {
  /**
   * INTERNAL brief-generator seam, not a public option: `registerPiFold` refuses the
   * name and builds the generator from `summarizer`. It stays a parameter because it
   * is the runtime's only brief-generator interface.
   */
  summarizeContextSpan?: (request: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  /**
   * INTERNAL deployment-identity seam, not public options: the package entry refuses all
   * five by name and the shipped identity is the one in `policy.ts`. They survive here
   * because the neutrality gate has to register a synthetic brand to prove none of it
   * reaches the defaults, and the experiment harness registers the pi-fold identity
   * explicitly so its sealed runs keep their entry types.
   */
  toolName?: string;
  toolLabel?: string;
  brandNoun?: string;
  entryTypePrefix?: string;
  commandNames?: { status?: string; fold?: string };
  /**
   * The auto-fold EXCEPTION list, empty by default: every completed tool batch folds
   * unmarked, and this names the tools whose results must stay raw.
   */
  blacklistAutoFoldTools?: ReadonlySet<string>;
  /** The serving budget itself, ALREADY NET of the deployment's output reservation. */
  providerInputBudget?: number;
  /**
   * The thermostat, set whole or not at all. USER policy: no agent action reads it back
   * as a mutable surface, and status reports the values without offering to change them.
   */
  thresholds?: ActiveContextThresholds;
  /** Both guidance surfaces, set together, defaulting on. */
  guidance?: Partial<ActiveContextGuidance>;
}): {
  projectionCandidates: (ctx: any) => Array<Record<string, unknown>>;
} {
  const toolName = options.toolName ?? DEFAULT_ACTIVE_CONTEXT_TOOL_NAME;
  const toolLabel = options.toolLabel ?? DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL;
  const brandNoun = options.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN;
  const entryTypePrefix = options.entryTypePrefix ?? DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
  const blacklistAutoFoldTools = options.blacklistAutoFoldTools ?? AUTO_FOLD_BLACKLIST_DEFAULT;
  // Deleted options are REFUSED by name, never ignored. A deployment still passing one
  // believes it asked for something, and silence would hand it the opposite behavior:
  // `foldScheduling` chose between epoch and the deleted immediate scheduler,
  // `foldPeekResults` opted peek results out of the foldable classification, and
  // `toolActions` narrowed the action surface. All three are unconditional now.
  for (const removed of ["foldScheduling", "foldPeekResults", "toolActions"]) {
    if (Object.hasOwn(options, removed)) {
      throw new Error(`${removed} is no longer an option: epoch scheduling, peek foldability ` +
        "and the whole action surface are unconditional");
    }
  }
  if (Object.hasOwn(options, "blockingTools")) {
    throw new Error("blockingTools is no longer an option: a tool call never causes a rewrite of " +
      "its own, and the commit epoch is the only path that mutates the projection");
  }
  // The per-request surfacing channel. `setProjectionProvider` was a second delivery
  // path for the value this call already returns, and `setSuggestionSourceRegistrar`
  // handed out registration into a carrier that no longer exists: the slate rode a
  // per-request ephemeral tail, which moved the prefix on every single pass. The
  // selector survives and returns at the commit boundary; the channel does not.
  for (const removed of ["setProjectionProvider", "setSuggestionSourceRegistrar"]) {
    if (Object.hasOwn(options, removed)) {
      throw new Error(`${removed} is no longer an option: projection candidates are returned by ` +
        "registration, and external suggestion sources have no carrier to render into");
    }
  }
  // The renamed options are refused by their OLD names, each pointing at the new one.
  // `readOnlyTools` and then `autoFoldableTools` were both ALLOW-lists, and the list runs
  // the other way now, so neither may be forwarded silently: an allow-list read as a
  // blacklist bars exactly the tools it meant to permit. `commandPrefix` derived two
  // command names from a stem the full-name override then overrode anyway;
  // `providerTotalWindow` was a gross window the runtime netted down with a GUESSED
  // reservation, and the guess is what the reshape deleted.
  for (const inverted of ["readOnlyTools", "autoFoldableTools"]) {
    if (Object.hasOwn(options, inverted)) {
      throw new Error(`${inverted} is now blacklistAutoFoldTools, and the sense is INVERTED: ` +
        "every completed tool batch folds unmarked, and the list names the exceptions whose " +
        "results must stay raw. An allow-list moved across verbatim would bar exactly the " +
        "tools it meant to permit");
    }
  }
  if (Object.hasOwn(options, "commandPrefix")) {
    throw new Error("commandPrefix is no longer an option: give whole names with commandNames");
  }
  if (Object.hasOwn(options, "providerTotalWindow")) {
    throw new Error("providerTotalWindow is now providerInputBudget, and it is ALREADY NET: " +
      "pass the tokens the deployment may actually fill, not the total window the runtime " +
      "then subtracts a guessed output reservation from");
  }
  if (options.providerInputBudget !== undefined &&
      (!Number.isSafeInteger(options.providerInputBudget) || options.providerInputBudget <= 0)) {
    throw new Error("providerInputBudget must be a positive integer");
  }
  // The deployment's own fact, and the only capacity knob: declaring it makes every
  // ratio, fence and budget truthful, and leaving it out falls back to the provider
  // descriptor and SAYS "descriptor" in the capacity accounting.
  const providerInputBudget = options.providerInputBudget ?? null;
  const readOnlyContextActions = PEEK_READ_ONLY_CONTEXT_ACTIONS;
  if (!toolName || !toolLabel || !brandNoun || !entryTypePrefix ||
      [...blacklistAutoFoldTools].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Active-context names and blacklisted auto-fold tools must be nonempty strings");
  }
  const commandNames = {
    status: options.commandNames?.status ?? DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES.status,
    fold: options.commandNames?.fold ?? DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES.fold,
  };
  if (![commandNames.status, commandNames.fold].every((name) =>
      typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name)) ||
      commandNames.status === commandNames.fold) {
    throw new Error("Active-context command names must be distinct kebab-case strings");
  }
  // The thermostat, validated atomically before anything else reads a threshold, and
  // then checked against the budget this deployment can actually serve.
  const thresholds = resolveThresholds(options.thresholds);
  assertThresholdsServable(thresholds, providerInputBudget ?? servingBudgetTokens(DEFAULT_CONTEXT_WINDOW));
  const guidance = resolveGuidance(options.guidance);
  const stateEntryType = `${entryTypePrefix}-state`;
  const foldRecordEntryType = `${entryTypePrefix}-fold-record`;
  const milestoneProjectionType = `${entryTypePrefix}-milestone`;
  const advisoryProjectionType = `${entryTypePrefix}-advisory`;
  const surfacingProjectionType = `${entryTypePrefix}-surfacing`;
  const receiptProjectionType = `${entryTypePrefix}-receipts`;
  const riderProjectionType = `${entryTypePrefix}-rider`;
  const lastCallProjectionType = `${entryTypePrefix}-lastcall`;
  const noticeProjectionType = `${entryTypePrefix}-notice`;
  const curationProjectionType = `${entryTypePrefix}-curation`;
  const entryNamespace = entryTypeNamespace(entryTypePrefix);
  const providerMeasurementEntryType = `${entryNamespace}-provider-context-measurement`;
  const nativeReceiptEntryType = `${entryNamespace}-native-compaction-receipt`;
  const contextEventEntryType = `${entryNamespace}-context-event`;
  const nativeDecisionEntryType = `${entryNamespace}-native-compaction-decision`;
  const allowedToolActions: readonly ActiveContextToolAction[] = ACTIVE_CONTEXT_TOOL_ACTIONS;
  const allowedToolActionSet = new Set<string>(allowedToolActions);

  type AutomaticFailureState = {
    key: string;
    phase: string;
    message: string;
    firstFailedAt: number;
    attempts: 1;
    suppressedCallbacks: number;
    persistenceDisposition: "none" | "record-only" | "state-committed";
  };

  // Owns in-memory/durable state and wire/record bookkeeping; persistenceQueue serializes it.
  // Once the state event succeeds, replay owns this exact state; RAM may not roll behind it.
  const persistence = {
    state: null as ActiveContextState | null,
    persisted: null as ActiveContextState | null,
    persistedWireVersion: 0 as 0 | 1 | 2,
    persistedStateSha256: "",
    persistedFoldRecords: new Map<string, FoldRecordEntry>(),
    persistenceQueue: Promise.resolve<void>(undefined),
  };

  // Owns preparation/ladder rollback, selection, and suspension; actionQueue serializes it.
  const ladder = {
    pendingManual: false,
    preparing: null as { id: string; controller: AbortController; promise: Promise<void> } | null,
    lastPreparationError: null as string | null,
    boundaryFailure: null as string | null,
    lastPreparationCandidateId: null as string | null,
    lastSelectionKind: null as FoldKind | "refold" | null,
    lastSelectionSourceIds: [] as string[],
    pendingContextNote: null as string | null,
    lastAutomaticAction: null as Record<string, unknown> | null,
    /** What the last over-budget projection cost and whether the reduction saved it. */
    overBudgetReduction: null as Record<string, unknown> | null,
    automaticFailure: null as AutomaticFailureState | null,
    failedPreparations: new Set<string>(),
    actionQueue: Promise.resolve<unknown>(undefined),
  };

  // Owns provider receipts, anchors, and usage; providerMeasurementQueue serializes receipt writes.
  const measurements = {
    latestRatio: null as number | null,
    lastProviderMeasurement: null as ProviderContextMeasurement | null,
    /** What the host/model descriptor last claimed, kept so the gap stays auditable. */
    descriptorWindow: null as number | null,
    /** Serialized size of the projection this process last handed the host. */
    lastProjectedChars: null as number | null,
    /**
     * Ground truth for the transmission fence: recent pairings of a projection's size
     * with the token count the provider reported for it. A fixed bytes-per-token
     * constant is a guess about a tokenizer, and it is wrong by different amounts in
     * different sessions -- measured 2026-08-06, 4.7 chars/token in rep11 and 7.0 in
     * rep12 for the SAME workload. It also DRIFTS within one session: rep13 moved
     * between 5.34 and 6.01 over its last twenty requests. Only the recent window
     * counts, and the fence reads it pessimistically.
     */
    projectionCalibrations: [] as Array<{ chars: number; tokens: number }>,
    /** What the fence estimated for the projection it last handed the host. */
    lastProjectedEstimate: null as number | null,
    /** Whether that estimate used a measured ratio rather than the bootstrap constant. */
    lastProjectedEstimateCalibrated: false,
    /** Signed estimator error against recent measurements, as a share of measured tokens. */
    estimatorErrors: [] as number[],
    /** Growth in measured tokens between consecutive requests. */
    inflowSteps: [] as number[],
    providerMeasurementQueue: Promise.resolve<void>(undefined),
    providerMeasurementReceipts: new Set<string>(),
    providerMeasurementRevisionByMessageSha: new Map<string, number>(),
    providerMeasurementByMessageSha: new Map<string, ProviderContextMeasurementReceipt>(),
    providerMeasurementAnchorByMessageSha: new Map<string, ProviderMeasurementAnchor>(),
  };

  // Owns the projection/cache ledger. Nothing here is durable: it is telemetry about
  // this process's own projections, rebuilt from scratch on every load.
  const instrumentation = {
    ledger: emptyLedger(),
    previousDigests: null as string[] | null,
    /** The previous TRANSMITTED projection, for the byte-level prefix comparison. */
    previousText: null as string | null,
    lastChange: "append" as ProjectionChange,
    /** Share of the PREVIOUS prompt the last projection kept, for miss attribution. */
    lastPreservedShare: null as number | null,
    /** Events emitted since the last handoff, which is the attribution candidate set. */
    sinceHandoff: [] as Array<{ seq: number; kind: string }>,
    /** Structural mutations emitted since the last handoff. The per-generation budget. */
    mutationsSinceHandoff: 0,
    /** Provider responses this session, so event SPACING is readable from the stream. */
    requests: 0,
    lastMutationRequest: 0,
    lastMutationTokens: null as number | null,
  };
  /**
   * MECHANISM 1. The frozen surface.
   *
   * Between fold events the projection is byte-frozen: the only change a context action
   * may cause is the append of its own tool result at the tail. Rep 17 measured every
   * single context attempt landing as a projection REWRITE -- status 0.60-0.90 prefix
   * identity, peek 0.96, the held gate down to 0.013 -- because the surface answered
   * each one by re-rendering blocks the agent had already paid to cache. Provider prefix
   * caches are positional, so each of those refreshes was a full or partial cache kill.
   *
   * `body` is the last rebuilt fold projection and `projection` is that body plus the
   * carriers appended to it. While the rebuilt body still starts with `body` verbatim,
   * nothing structural moved, so the previous projection is reused WHOLE and only the
   * newly arrived raw messages are appended after it. A carrier whose key is already in
   * the window is never re-rendered; a fold event, a reveal or an overflow recovery
   * diverges the body and takes the sanctioned rewrite.
   */
  const freeze = {
    body: null as unknown[] | null,
    bodyText: null as string | null,
    projection: null as unknown[] | null,
    keys: new Set<string>(),
    /** True only while assembling a pass that reused the frozen projection. */
    active: false,
  };
  /**
   * A carrier may be built exactly once per freeze window. This is checked BEFORE the
   * builder runs, because building a milestone spends its delivery budget and building
   * a reminder advances the reminder cursor: a carrier that cannot land must not pay.
   */
  const carrierAdmitted = (key: string): boolean => {
    if (freeze.active && freeze.keys.has(key)) return false;
    freeze.keys.add(key);
    return true;
  };

  // Owns the guided-curation gate, the receipt ring, the context-event stream, and the
  // overflow recovery lane. Nothing here is durable session STATE: it describes what
  // this process did to the live window, and the durable copy is the appended
  // instrumentation entry, which is what an external adjudicator reads.
  const curation = {
    receipts: [] as ContextReceipt[],
    /** Every context-management tool call this session. */
    contextCalls: 0,
    /** The last measurement the commit trigger took, reported by status. */
    lastSignals: null as CurationSignals | null,
    /**
     * COMMIT REOPEN HYSTERESIS. The eligible foldable share measured just after the last
     * triggered commit, or null when the trigger is free to fire. Measured 2026-08-07
     * (rep 17): occupancy plateaued at 0.85-0.92 of the truthful budget for the final
     * third of the run, and the trigger fired ten times over a window whose foldable mass
     * had not changed. A plateau is not an event. The trigger re-arms only once occupancy
     * falls back under it and crosses again, or once a reclaim floor of eligible mass is
     * NEW. This outlived the announcement it was built beside: it bounds how often the
     * runtime rewrites the projection, which is the whole cost model.
     */
    reopenBaselineShare: null as number | null,
    /**
     * Where the armed last-call actually LANDED: the exposure it rendered and the
     * ordinal of the pass that rendered it. In-memory on purpose: after a reload the
     * carrier re-renders on the first projection, this re-arms, and the commit waits
     * one more round rather than firing on a prompt nobody saw.
     */
    lastCallDelivery: null as { exposure: number; ordinal: number } | null,
    /** Recovery attempts spent on the CURRENT inflow; reset by any accepted request. */
    recoveryAttempts: 0,
    /** A provider rejection observed but not yet recovered from. */
    pendingRejection: null as { status: number; ordinal: number } | null,
    lastRecovery: null as Record<string, unknown> | null,
    instrumentationQueue: Promise.resolve<void>(undefined),
  };

  /**
   * The tree-rollback lane.
   *
   * Armed once per session against the pi surfaces it calls, because every one of them
   * is an internal the extension contract does not promise. Disarmed, the lane is OFF
   * and says so on the record: an overflow still emits `context.rollback` with
   * `armed: false` and the reason, the user is notified, and the session behaves
   * exactly as it did before this build -- the projection-budget fence aborts an
   * over-budget request rather than half-performing a recovery.
   */
  const rollback = {
    probes: null as ReturnType<typeof probeRollbackSurfaces> | null,
    armed: false,
    /** pi's own overflow classifier, resolved from the host; null when unreachable. */
    classifier: null as ((message: unknown, contextWindow: number) => boolean) | null,
    classifierSource: null as string | null,
    /** Ordinals of episodes handled, so the one-shot and the ledger agree. */
    attempts: 0,
    last: null as Record<string, unknown> | null,
    /** An overflow seen at message_end and not yet claimed by the compaction event. */
    pendingOverflow: null as { at: number; entryId: string | null } | null,
  };

  // Owns advisory arming and hard-fence delivery; durable effects use persistenceQueue.
  const advisory = {
    hardFenceNoticeKey: null as string | null,
    hardFenceReleaseSessionId: null as string | null,
    hardFenceReleasedProjectionKeys: new Set<string>(),
  };

  // Owns native-compaction decisions and completion retry state; nativeReceiptQueue serializes it.
  const nativeCompaction = {
    lastThresholdDecision: null as Record<string, unknown> | null,
    pendingNativeReceipt: null as NativeCompactionCompletionReceipt | null,
    nativeReceiptQueue: Promise.resolve<void>(undefined),
  };

  // Owns session generation, snapshots/reloads, and per-turn blocking-tool harvest state.
  // Pi normally requests context serially, but retries, reloads, and host
  // integrations can overlap callbacks. Serialize the entire authority →
  // preparation → commit → projection transaction so a follower cannot
  // observe a published measurement before the leader's durable receipt or
  // return raw final-rung context while the leader is preparing a brief.
  const lifecycle = {
    generation: 0,
    shuttingDown: false,
    latestSnapshot: null as ActiveContextSnapshot | null,
    latestSnapshotError: null as string | null,
    contextQueue: Promise.resolve<void>(undefined),
  };

  const durableProviderMeasurementReceiptMatches = (
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): boolean => {
    const receipt = measurements.providerMeasurementByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && receipt.projectionRevision === projectionRevision &&
      receipt.provider === measurement.provider && receipt.model === measurement.model &&
      receipt.tokens === measurement.tokens && receipt.contextWindow === measurement.contextWindow);
  };

  const durableProviderMeasurementMatches = (
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!persistence.state) return false;
    const receipt = measurements.providerMeasurementByMessageSha.get(measurement.messageSha256);
    const anchor = measurements.providerMeasurementAnchorByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && anchor && anchor.sessionId === persistence.state.sessionId &&
      anchor.generation === lifecycle.generation &&
      anchor.topologySha256 === topologySha256(persistence.state) &&
      anchor.protectionSha256 === protectionSha256(persistence.state) &&
      receipt.provider === measurement.provider && receipt.model === measurement.model &&
      receipt.tokens === measurement.tokens && receipt.contextWindow === measurement.contextWindow);
  };

  const currentOrdinal = (): number =>
    lifecycle.latestSnapshot ? markOrdinal(lifecycle.latestSnapshot) : 0;

  /**
   * Emit one record into THE context event stream, in the ledger AND as a durable
   * session entry. An in-memory ledger is invisible to an analyst reading session
   * artifacts, and telemetry may never block or fail the action it describes.
   */
  /**
   * Open a pass's mutation budget. ONE structural mutation per pass is the budget: the
   * rep-15 defect was a second commit inside the SAME pass, after the first had already
   * rebuilt the projection, so the counter is armed wherever a pass begins.
   */
  const beginMutationPass = (): void => { instrumentation.mutationsSinceHandoff = 0; };

  const emit = (kind: ContextEventKind, payload: Record<string, unknown> = {}): ContextEvent => {
    const record = recordContextEvent(instrumentation.ledger, kind, {
      session_id: persistence.state?.sessionId ?? "",
      ordinal: currentOrdinal(),
      revision: persistence.state?.revision ?? 0,
      at: Date.now(),
    }, payload);
    instrumentation.sinceHandoff.push({ seq: record.seq, kind });
    const operation = curation.instrumentationQueue.then(async () => {
      try { await pi.appendEntry(contextEventEntryType, record); }
      catch { /* Telemetry is never a lifecycle boundary. */ }
    });
    curation.instrumentationQueue = operation.then(() => undefined, () => undefined);
    return record;
  };

  /**
   * Actions of ours that move bytes at or before a prefix position. Receipts, gate
   * notices and suggestions are appended after the whole projection, so they can only
   * move the tail and are never a prefix cause.
   */
  const PREFIX_MUTATING_KINDS: ReadonlySet<string> = new Set([
    "context.commit", "context.fold", "context.absorb", "context.split", "context.recovery",
  ]);

  const deliverReceipt = (receipt: ContextReceipt): void => {
    curation.receipts = withReceipt(curation.receipts, receipt);
    emit("context.receipt", {
      receipt_kind: receipt.kind,
      trigger: receipt.trigger,
      folds_committed: receipt.foldsCommitted,
      folds_created: receipt.foldsCreated,
      freed_tokens: receipt.freedTokens,
      split_folds: receipt.splitFolds,
      split_from_chars: receipt.splitFromChars,
      absorbed_wedges: receipt.absorbedWedges,
      recovered: receipt.recovered,
      protected_bytes: receipt.protectedBytes,
      note: receipt.note,
    });
  };

  const safeNotify = (ctx: any, message: string, level: "info" | "warning" | "error"): void => {
    try { ctx.ui?.notify?.(message, level); } catch { /* Presentation cannot block Pi lifecycle progress. */ }
  };

  const contextSessionMatches = (ctx: any, sessionId: string): boolean => {
    try { return ctx.sessionManager.getSessionId() === sessionId; }
    catch { return false; }
  };

  const sessionIdentityStillValid = (ctx: any, sessionId: string, expectedGeneration: number): boolean =>
    lifecycle.generation === expectedGeneration && persistence.state?.sessionId === sessionId &&
    (!ctx || contextSessionMatches(ctx, sessionId));

  const updateStatus = (ctx: any): void => {
    try {
      const roots = persistence.state && lifecycle.latestSnapshot ? orderedRoots(persistence.state, lifecycle.latestSnapshot).length : 0;
      const prepared = persistence.state?.prepared ? " · brief ready" : ladder.preparing ? " · briefing" : "";
      const usage = measurements.lastProviderMeasurement
        ? ` · provider ${measurements.lastProviderMeasurement.tokens}/${measurements.lastProviderMeasurement.contextWindow}`
        : " · provider usage unmeasured";
      const suspended = ladder.automaticFailure ? " · automatic suspended" : "";
      ctx.ui?.setStatus?.(entryTypePrefix, `${toolName} folds: ${roots}${prepared}${usage}${suspended}`);
    } catch { /* Status presentation is request-ephemeral and never a lifecycle boundary. */ }
  };

  /**
   * The number every ratio, fence and budget is computed against. Declared, it is the
   * deployment's own serving budget, already net of whatever output reservation it holds
   * back; undeclared, it is the per-request max-input descriptor, which bakes in a full
   * output reservation the deployment never asked for and so aborts requests inside real
   * headroom. The descriptor is still read, and still reported, so the gap stays
   * auditable rather than assumed.
   */
  const budgetWindowFor = (ctx: any): number | null => {
    // Remembered so the ctx-free callers (trigger, gate, reminders, advisory) report the
    // same descriptor gap the fence does instead of re-reading a second source.
    measurements.descriptorWindow = contextWindowFor(ctx);
    return providerInputBudget ?? measurements.descriptorWindow;
  };

  /**
   * THE serving budget. One resolution, one formula, one value.
   *
   * Every consumer -- the curation trigger, the last-call gate, the sparse reminders,
   * the transmission fence, the projection estimator and every instrumentation record --
   * reads this. Measured 2026-08-06 (rep 15): the trigger and gate ran a whole run
   * against a 272,000-token per-request DESCRIPTOR (budget 255,616) while the fence used
   * the truthful 383,616, because the same arithmetic lived in three places. A second
   * copy of this formula is the defect; there is now only one.
   */
  const servingCapacity = (window: number | null): ReturnType<typeof capacityAccounting> =>
    capacityAccounting({
      window: window ?? lifecycle.latestSnapshot?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      truthful: providerInputBudget !== null,
      descriptorWindow: measurements.descriptorWindow,
      usedTokens: measurements.lastProviderMeasurement?.tokens ?? null,
    });

  const currentCapacity = (ctx: any): ReturnType<typeof capacityAccounting> =>
    servingCapacity(budgetWindowFor(ctx));

  const snapshotForEvent = (ctx: any, messages: unknown[]): ActiveContextSnapshot => mapActiveContext({
    sessionId: ctx.sessionManager.getSessionId(),
    eventMessages: messages,
    contextEntries: ctx.sessionManager.buildContextEntries(),
    toolName,
    brandNoun,
    entryTypePrefix,
    blacklistAutoFoldTools,
    readOnlyContextActions,
    contextWindow: budgetWindowFor(ctx) ?? undefined,
    netBudget: providerInputBudget !== null,
    thresholds,
  });

  const authoritativeSnapshotFor = (ctx: any): ActiveContextSnapshot => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!lifecycle.latestSnapshot || lifecycle.latestSnapshot.sessionId !== sessionId) {
      throw new Error("A current same-session Pi context event is required");
    }
    return mapActiveContext({
      sessionId,
      eventMessages: lifecycle.latestSnapshot.messages,
      contextEntries: ctx.sessionManager.buildContextEntries(),
      policy: lifecycle.latestSnapshot.policy,
      toolName,
      brandNoun,
      entryTypePrefix,
      blacklistAutoFoldTools,
      readOnlyContextActions,
      contextWindow: budgetWindowFor(ctx) ?? undefined,
      netBudget: providerInputBudget !== null,
      thresholds,
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
    ladder.preparing?.controller.abort();
    ladder.preparing = null;
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
    lifecycle.generation += 1;
    lifecycle.shuttingDown = false;
    cancelPreparation();
    lifecycle.latestSnapshot = null;
    lifecycle.latestSnapshotError = null;
    measurements.latestRatio = null;
    measurements.lastProviderMeasurement = null;
    ladder.pendingManual = false;
    if (!preserveThresholdDecision) nativeCompaction.lastThresholdDecision = null;
    ladder.lastPreparationError = null;
    ladder.boundaryFailure = null;
    ladder.lastPreparationCandidateId = null;
    ladder.lastSelectionKind = null;
    ladder.lastSelectionSourceIds = [];
    ladder.pendingContextNote = null;
    instrumentation.ledger = emptyLedger();
    instrumentation.previousDigests = null;
    instrumentation.previousText = null;
    instrumentation.requests = 0;
    instrumentation.lastMutationRequest = 0;
    instrumentation.lastMutationTokens = null;
    instrumentation.lastChange = "append";
    instrumentation.lastPreservedShare = null;
    instrumentation.sinceHandoff = [];
    instrumentation.mutationsSinceHandoff = 0;
    curation.receipts = [];
    curation.contextCalls = 0;
    curation.lastSignals = null;
    curation.reopenBaselineShare = null;
    curation.recoveryAttempts = 0;
    curation.pendingRejection = null;
    curation.lastRecovery = null;
    ladder.lastAutomaticAction = null;
    ladder.automaticFailure = null;
    advisory.hardFenceNoticeKey = null;
    ladder.failedPreparations.clear();
    measurements.providerMeasurementReceipts.clear();
    measurements.providerMeasurementRevisionByMessageSha.clear();
    measurements.providerMeasurementByMessageSha.clear();
    measurements.providerMeasurementAnchorByMessageSha.clear();
    const sessionId = ctx.sessionManager.getSessionId();
    if (advisory.hardFenceReleaseSessionId !== sessionId) {
      advisory.hardFenceReleaseSessionId = sessionId;
      advisory.hardFenceReleasedProjectionKeys.clear();
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
      if (entry.customType !== providerMeasurementEntryType) continue;
      try {
        const receipt = parseProviderContextMeasurementReceipt(entry.data, sessionId);
        const boundRevision = measurements.providerMeasurementRevisionByMessageSha.get(receipt.messageSha256);
        if (boundRevision !== undefined && boundRevision !== receipt.projectionRevision) {
          throw new Error("One provider response is bound to multiple projection revisions");
        }
        measurements.providerMeasurementRevisionByMessageSha.set(receipt.messageSha256, receipt.projectionRevision);
        const priorReceipt = measurements.providerMeasurementByMessageSha.get(receipt.messageSha256);
        if (priorReceipt && stableStringify(priorReceipt) !== stableStringify(receipt)) {
          throw new Error("One provider response has conflicting durable measurement receipts");
        }
        measurements.providerMeasurementByMessageSha.set(receipt.messageSha256, receipt);
        const fingerprint = restoredPersistence?.projectionFingerprints.get(receipt.projectionRevision);
        if (fingerprint) {
          measurements.providerMeasurementAnchorByMessageSha.set(receipt.messageSha256, {
            sessionId,
            generation: lifecycle.generation,
            ...fingerprint,
          });
        }
        measurements.providerMeasurementReceipts.add(providerMeasurementReceiptKey(
          sessionId,
          receipt.projectionRevision,
          receipt,
        ));
      } catch (error) {
        measurementRestoreError = error;
      }
    }
    const durableRestored = restored ?? emptyActiveContextState(sessionId);
    persistence.state = durableRestored.prepared ? clearPrepared(durableRestored) : clone(durableRestored);
    persistence.persistedWireVersion = restoredPersistence?.wireVersion ?? 0;
    persistence.persistedFoldRecords = restoredPersistence?.records ?? new Map<string, FoldRecordEntry>();
    persistence.persistedStateSha256 = restoredPersistence?.stateSha256 ?? semanticStateSha256(durableRestored);
    const restoredMessages = ctx.sessionManager.buildSessionContext?.()?.messages;
    measurements.lastProviderMeasurement = latestProviderContextMeasurement(
      Array.isArray(restoredMessages) ? restoredMessages : [],
      budgetWindowFor(ctx),
      ctx.model,
    );
    measurements.latestRatio = contextUsageRatio(measurements.lastProviderMeasurement);
    persistence.persisted = clone(durableRestored);
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
    const operation = persistence.persistenceQueue.then(async () => {
      if (!persistence.state || !persistence.persisted) return;
      let next = clone(persistence.state);
      if (ctx && lifecycle.latestSnapshot?.sessionId === next.sessionId) {
        next = persistenceProjection(next, authoritativeSnapshotFor(ctx));
      }
      next.folds = normalizeFoldsForPersistedRecords(next.folds, persistence.persistedFoldRecords);
      if (sameStateProjection(next, persistence.persisted)) {
        persistence.state = clone(persistence.persisted);
        return;
      }
      if (next.revision <= persistence.persisted.revision) next.revision = persistence.persisted.revision + 1;
      const generationAtStart = lifecycle.generation;
      const sessionId = next.sessionId;
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before persistence");
      }
      if (next.folds.length > MAX_ACTIVE_FOLD_RECORDS) {
        throw new Error("Active-context fold closure exceeds persistence limit");
      }
      for (const fold of next.folds) {
        const record = makeFoldRecordEntry(fold, sessionId);
        const existing = persistence.persistedFoldRecords.get(record.foldId);
        if (existing) {
          if (existing.recordSha256 !== record.recordSha256) {
            throw new Error(`Conflicting durable active-context fold ${record.foldId}`);
          }
          continue;
        }
        await pi.appendEntry(foldRecordEntryType, record);
        persistence.persistedFoldRecords.set(record.foldId, record);
        if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
          if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
          throw new Error("Active-context session changed after fold-record persistence");
        }
      }
      const wire = persistence.persistedWireVersion === 2 ? makeStateDelta(persistence.persisted, next) : makeStateCheckpoint(next);
      if (persistence.persistedWireVersion === 2 && persistence.persistedStateSha256 !== semanticStateSha256(persistence.persisted)) {
        throw new Error("Active-context durable base digest drift");
      }
      await pi.appendEntry(stateEntryType, wire);
      persistence.persisted = clone(next);
      persistence.persistedWireVersion = 2;
      persistence.persistedStateSha256 = semanticStateSha256(next);
      persistence.state = lifecycle.shuttingDown ? null : clone(next);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
        throw new Error("Active-context session changed after durable persistence");
      }
    });
    persistence.persistenceQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistThroughActionQueue = (ctx?: any): Promise<void> => {
    const operation = ladder.actionQueue.then(() => persist(ctx));
    ladder.actionQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistProviderMeasurement = (
    ctx: any,
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): Promise<boolean> => {
    if (!persistence.state || !Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return Promise.resolve(false);
    }
    const generationAtStart = lifecycle.generation;
    const sessionId = persistence.state.sessionId;
    const queuedMeasurement = clone(measurement);
    const revision = projectionRevision;
    const anchor: ProviderMeasurementAnchor = {
      sessionId,
      generation: generationAtStart,
      topologySha256: topologySha256(persistence.state),
      protectionSha256: protectionSha256(persistence.state),
    };
    const operation = measurements.providerMeasurementQueue.then(async () => {
      if (lifecycle.shuttingDown || !sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before measurement persistence");
      }
      const measurement = queuedMeasurement;
      const boundRevision = measurements.providerMeasurementRevisionByMessageSha.get(measurement.messageSha256);
      if (boundRevision !== undefined) {
        return boundRevision === revision &&
          durableProviderMeasurementReceiptMatches(measurement, revision);
      }
      const receiptKey = providerMeasurementReceiptKey(sessionId, revision, measurement);
      if (measurements.providerMeasurementReceipts.has(receiptKey)) {
        measurements.providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
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
      measurements.providerMeasurementReceipts.add(receiptKey);
      measurements.providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
      measurements.providerMeasurementByMessageSha.set(measurement.messageSha256, receipt);
      measurements.providerMeasurementAnchorByMessageSha.set(measurement.messageSha256, anchor);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed during measurement persistence");
      }
      return true;
    });
    measurements.providerMeasurementQueue = operation.then(() => undefined, () => undefined);
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
      preparationError: ladder.lastPreparationError
        ? boundReceiptText(ladder.lastPreparationError, 1_200, "context preparation failed")
        : null,
      boundaryFailure: ladder.boundaryFailure
        ? boundReceiptText(ladder.boundaryFailure, 1_200, "context boundary failed")
        : null,
      selectionKind: ladder.lastSelectionKind ? boundReceiptText(ladder.lastSelectionKind, 64, "unknown") : null,
      selectionSourceIds: ladder.lastSelectionSourceIds.slice(0, 64)
        .map((id) => boundReceiptText(id, 512, "unknown-source")),
      automaticActionKind: typeof ownValue(ladder.lastAutomaticAction, "kind") === "string"
        ? boundReceiptText(ownValue(ladder.lastAutomaticAction, "kind"), 128, "unknown")
        : null,
      providerMessageSha256: measurements.lastProviderMeasurement?.messageSha256 ?? null,
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
    const operation = nativeCompaction.nativeReceiptQueue.then(async () => {
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
      nativeCompaction.pendingNativeReceipt = null;
    });
    nativeCompaction.nativeReceiptQueue = operation.catch(() => undefined);
    return operation;
  };

  const recoverNativeReceipts = async (ctx: any): Promise<void> => {
    if (nativeCompaction.pendingNativeReceipt) await persistNativeCompletion(nativeCompaction.pendingNativeReceipt, ctx);
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
    const latestCompletion = [...completions.values()]
      .sort((left, right) => left.occurredAt - right.occurredAt)
      .at(-1);
    if (latestCompletion) {
      nativeCompaction.lastThresholdDecision = {
        handled: true,
        retry: false,
        reason: `native compaction completed; ${brandNoun} folding state rebuilt`,
        compactionReason: latestCompletion.reason,
        nativeCompactionCompleted: true,
        receiptKey: latestCompletion.receiptKey,
        decision: latestCompletion.decision,
      };
    }
  };

  const markManual = (next: ActiveContextState): void => {
    cancelPreparation();
    persistence.state = clearPrepared(next);
    ladder.pendingManual = true;
    ladder.boundaryFailure = null;
  };

  const persistManual = async (
    next: ActiveContextState,
    action: Exclude<ActiveContextToolAction, "status">,
    ctx: any,
  ): Promise<void> => {
    const stateAtEntry = persistence.state ? clone(persistence.state) : null;
    const persistedAtEntry = persistence.persisted;
    const transientAtEntry = captureTransient();
    markManual(next);
    try {
      await persist(ctx);
      ladder.pendingManual = false;
      ladder.automaticFailure = null;
      ladder.boundaryFailure = null;
    } catch (error) {
      if (persistence.persisted === persistedAtEntry && stateAtEntry) {
        persistence.state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      ladder.boundaryFailure = error instanceof Error ? error.message : String(error);
      safeNotify(ctx, `Active-context change was not persisted: ${ladder.boundaryFailure}`, "error");
      throw error;
    }
  };

  const captureTransient = () => ({
    pendingManual: ladder.pendingManual,
    preparing: ladder.preparing,
    pendingContextNote: ladder.pendingContextNote,
    lastAutomaticAction: ladder.lastAutomaticAction,
    automaticFailure: ladder.automaticFailure ? clone(ladder.automaticFailure) : null,
    boundaryFailure: ladder.boundaryFailure,
  });
  const restoreTransient = (saved: ReturnType<typeof captureTransient>): void => {
    ladder.pendingManual = saved.pendingManual;
    ladder.preparing = saved.preparing?.controller.signal.aborted ? null : saved.preparing;
    ladder.pendingContextNote = saved.pendingContextNote;
    ladder.lastAutomaticAction = saved.lastAutomaticAction;
    ladder.automaticFailure = saved.automaticFailure;
    ladder.boundaryFailure = saved.boundaryFailure;
  };
  const automaticOperationKey = (
    phase: string,
    snapshot: ActiveContextSnapshot | null = lifecycle.latestSnapshot,
    ratio: number | null = measurements.latestRatio,
  ): string => {
    const lifecyclePhase = ["context", "message-end", "turn-end"].includes(phase) ? "automatic-rung" : phase;
    let selection: Record<string, unknown> = { kind: lifecyclePhase };
    try {
      if (persistence.state && snapshot && ratio !== null) {
        const selected = selectAutomaticRung(snapshot, persistence.state, ratio, {
          summarizerAvailable: Boolean(options.summarizeContextSpan),
          failedPreparationIds: ladder.failedPreparations,
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
      sessionId: persistence.state?.sessionId ?? snapshot?.sessionId ?? null,
      revision: persistence.state?.revision ?? null,
      topology: persistence.state ? topologySha256(persistence.state) : null,
      protection: persistence.state ? protectionSha256(persistence.state) : null,
      selection,
      policy: snapshot ? {
        maxTarget: snapshot.thresholds.maxTarget,
        minTarget: snapshot.thresholds.minTarget,
        freshTail: snapshot.thresholds.freshTail,
        staleTail: snapshot.thresholds.staleTail,
        hardFenceRatio: hardFenceRatio(snapshot),
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
    ladder.boundaryFailure = message;
    cancelPreparation();
    if (persistence.state?.prepared) persistence.state = clearPrepared(persistence.state);
    if (ladder.automaticFailure) {
      ladder.automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        ladder.automaticFailure.suppressedCallbacks + 1,
      );
      return;
    }
    ladder.automaticFailure = {
      key,
      phase,
      message,
      firstFailedAt: Date.now(),
      attempts: 1,
      suppressedCallbacks: 0,
      persistenceDisposition,
    };
    ladder.pendingContextNote = `Automatic context management suspended after one ${phase} failure; exact Pi context remains raw and manual context actions remain available.`;
    safeNotify(ctx, `Automatic context management suspended: ${message}`, "warning");
  };

  const abortUnsafeHardContext = (
    snapshot: ActiveContextSnapshot | null,
    ctx: any,
    allowUnmeasuredRevisionRelease = false,
  ): boolean => {
    if (measurements.latestRatio === null || measurements.latestRatio < hardFenceRatio(snapshot ?? undefined, ctx) || !persistence.state) return false;
    const measuredRevision = measurements.lastProviderMeasurement
      ? measurements.providerMeasurementRevisionByMessageSha.get(measurements.lastProviderMeasurement.messageSha256)
      : undefined;
    // A durable projection topology after the measured response gets exactly
    // one provider attempt so its fold can be measured. Concurrent
    // callbacks, retries, and same-session reloads may not repeatedly release
    // that unmeasured projection. Non-structural state persistence does not
    // spend this release. A failed automatic transaction never gets this
    // escape, even if a record/state append preceded its projection failure.
    if (allowUnmeasuredRevisionRelease && !ladder.automaticFailure &&
        measuredRevision !== undefined && measurements.lastProviderMeasurement &&
        !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) {
      const releaseKey = sha256Value({
        sessionId: persistence.state.sessionId,
        topologySha256: topologySha256(persistence.state),
        protectionSha256: protectionSha256(persistence.state),
        measuredRevision,
        providerMessageSha256: measurements.lastProviderMeasurement?.messageSha256 ?? null,
      });
      if (!advisory.hardFenceReleasedProjectionKeys.has(releaseKey) &&
          advisory.hardFenceReleasedProjectionKeys.size < 4_096) {
        advisory.hardFenceReleasedProjectionKeys.add(releaseKey);
        return false;
      }
    }
    const key = ladder.automaticFailure?.key ?? sha256Value({
      sessionId: snapshot?.sessionId ?? persistence.state.sessionId,
      revision: persistence.state.revision,
      providerMessageSha256: measurements.lastProviderMeasurement?.messageSha256 ?? null,
      phase: "hard-provider-fence",
    });
    ladder.pendingContextNote = `Provider context reached the hard ${brandNoun} fence without a newly committed lossless fold. ` +
      "The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.";
    if (advisory.hardFenceNoticeKey !== key) {
      advisory.hardFenceNoticeKey = key;
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
      throw new Error(`Pi hard-fence abort capability is unavailable at ratio ${measurements.latestRatio}`);
    }
    ctx.abort();
    return true;
  };

  /**
   * Bytes per token, measured rather than assumed.
   *
   * `ESTIMATED_BYTES_PER_TOKEN` is a constant over RAW text, and the fence weighs a
   * SERIALIZED projection: roles, ids, custom types and JSON escaping all count toward
   * the bytes and none of them reach the provider's tokenizer the same way. Measured
   * 2026-08-06 on one workload: rep11 ran at 4.7 serialized chars per measured token
   * and rep12 at 7.0. Against the fixed 4 that is a 76% over-estimate in rep12, which
   * is exactly how a session whose real window was 49% full (187,805 tokens of a
   * 400,000 window, ratio 0.47) had its request judged over a 383,616-token budget,
   * reduced, judged over again, and finally ABORTED at stage 37 of 64.
   *
   * So the ratio is calibrated per session against ground truth: the size of a
   * projection this process handed the host, paired with the token count the provider
   * reported for it. Tiny early requests are ignored -- a 466-char first projection
   * measured against a system prompt gives a meaningless 0.46 -- and the result is
   * bounded, so a pathological pairing can neither disable the fence nor trip it.
   */
  const PROJECTION_CALIBRATION_MIN_CHARS = 20_000;
  const PROJECTION_CALIBRATION_MIN_TOKENS = 5_000;
  const PROJECTION_CHARS_PER_TOKEN_FLOOR = 2;
  const PROJECTION_CHARS_PER_TOKEN_CEILING = 12;
  /** How many recent pairings the ratio, the error window and the inflow window keep. */
  const PROJECTION_CALIBRATION_WINDOW = 6;
  const PROJECTION_ERROR_WINDOW = 8;
  /** Margin floor, as a share of the window, before any error or inflow is measured. */
  const PROJECTION_MARGIN_FLOOR_SHARE = 0.05;

  const noteProjectionCalibration = (measurement: ProviderContextMeasurement): void => {
    const previous = measurements.lastProviderMeasurement;
    if (Number.isFinite(measurement.tokens) && previous && Number.isFinite(previous.tokens)) {
      const step = measurement.tokens - previous.tokens;
      // Only GROWTH is an inflow step. A commit shrinks the window; that is the thing
      // the margin has to survive, not a size the next request can be predicted from.
      if (step > 0) {
        measurements.inflowSteps.push(step);
        if (measurements.inflowSteps.length > PROJECTION_ERROR_WINDOW) measurements.inflowSteps.shift();
      }
    }
    const chars = measurements.lastProjectedChars;
    if (chars === null || chars < PROJECTION_CALIBRATION_MIN_CHARS) return;
    if (!Number.isFinite(measurement.tokens) || measurement.tokens < PROJECTION_CALIBRATION_MIN_TOKENS) return;
    // The signed error of the estimate we made for the projection this measurement
    // describes. This is the only direct measure of how wrong the fence can be.
    // Only a CALIBRATED estimate's error belongs in the window. The bootstrap constant
    // is wrong by design -- 76% high in rep12 -- and letting that one reading set the
    // margin would keep every later request permanently inside it.
    if (measurements.lastProjectedEstimate !== null && measurements.lastProjectedEstimateCalibrated &&
        measurement.tokens > 0) {
      measurements.estimatorErrors.push(
        (measurements.lastProjectedEstimate - measurement.tokens) / measurement.tokens,
      );
      if (measurements.estimatorErrors.length > PROJECTION_ERROR_WINDOW) measurements.estimatorErrors.shift();
    }
    measurements.projectionCalibrations.push({ chars, tokens: measurement.tokens });
    if (measurements.projectionCalibrations.length > PROJECTION_CALIBRATION_WINDOW) {
      measurements.projectionCalibrations.shift();
    }
  };

  /**
   * Recent, and pessimistic.
   *
   * A single latest pairing tracks drift but carries its noise; an average lags it.
   * Near the top of the window neither is acceptable, because the error that matters is
   * one-sided: a ratio that is too HIGH under-counts tokens and transmits a request the
   * provider will reject. So the fence takes the smallest ratio in the recent window,
   * which converges instantly in the dangerous direction and within a window in the
   * cheap one. Measured 2026-08-06 (rep13): the ratio moved 5.34 to 6.01 and back
   * across twenty requests while the window sat above 90% full.
   */
  const projectionCharsPerToken = (): number => {
    const usable = measurements.projectionCalibrations.filter((entry) =>
      entry.tokens > 0 && Number.isFinite(entry.chars / entry.tokens) && entry.chars / entry.tokens > 0);
    if (!usable.length) return ESTIMATED_BYTES_PER_TOKEN;
    const measured = Math.min(...usable.map((entry) => entry.chars / entry.tokens));
    return Math.min(
      PROJECTION_CHARS_PER_TOKEN_CEILING,
      Math.max(PROJECTION_CHARS_PER_TOKEN_FLOOR, measured),
    );
  };

  const projectedTokenEstimate = (projected: unknown[]): number =>
    Math.ceil(bytes(projected) / projectionCharsPerToken());

  /** The largest recent estimator error, as a share. Unmeasured sessions assume none. */
  const estimatorErrorShare = (): number => measurements.estimatorErrors.length
    ? Math.max(...measurements.estimatorErrors.map((error) => Math.abs(error)))
    : 0;

  /** The largest recent growth step, which is what one more turn can add. */
  const expectedInflowTokens = (): number => measurements.inflowSteps.length
    ? Math.max(...measurements.inflowSteps)
    : 0;

  /**
   * The safety margin.
   *
   * A fence that fires AT the budget is a fence that fires after the wire: the request
   * that kills the session is the one built after the last measurement, and it is never
   * the one being weighed. Measured 2026-08-06 (rep13): the last measurement read
   * 370,320 tokens against a 383,616 budget -- 13,296 of headroom against a median
   * inflow of 13,865 and a maximum of 27,815 -- while the estimate for that request was
   * 366,934, comfortably "under budget". The next request crossed the real limit and
   * the provider rejected it. Every number in that sentence was known to the runtime.
   *
   * So the reduction threshold carries what the runtime knows it does not know: the
   * worst recent estimator error applied to this estimate, plus one worst recent inflow
   * step, never less than a floor share of the window.
   */
  const projectionMarginTokens = (estimate: number, windowTokens: number): number => Math.ceil(Math.max(
    PROJECTION_MARGIN_FLOOR_SHARE * windowTokens,
    estimatorErrorShare() * estimate + expectedInflowTokens(),
  ));

  /**
   * The TRANSMISSION fence.
   *
   * `abortUnsafeHardContext` gates on `measurements.latestRatio`, which describes the
   * request the provider ALREADY answered. It is a lagging indicator: between that
   * response and the next request an excursion can add a hundred thousand tokens of
   * tool results, and nothing in the fence looks at the projection actually about to
   * be sent. Measured 2026-08-06 (rep 11): the last measurement read 359,625 tokens of
   * a 400,000 window, ratio 0.937 against a 0.959 hard fence, so no abort fired -- and
   * the projection that went out was 1,831,936 chars, about 458k estimated tokens, 1.2x
   * the whole window. The provider rejected it twice and the run died. rep4 aborted
   * correctly only because its 272k DESCRIPTOR window put the stale ratio over the
   * fence by luck of arithmetic, not because anything measured the request.
   *
   * So the projection itself is measured here, against the truthful serving budget the
   * capacity accounting already computes. Over budget, an emergency reduction runs at
   * fence pressure -- where every guarded mark is waived -- and the rebuilt projection
   * is measured again. If it still does not fit, the request is aborted BEFORE
   * transmission, which is the whole point of having a fence.
   */
  const projectionExceedsBudget = (projected: unknown[], ctx: any): {
    tokens: number;
    budgetTokens: number;
    marginTokens: number;
    /** Past the wire: this request must not be transmitted at all. */
    over: boolean;
    /** Inside the margin: still sendable, but the next one may not be. Reduce NOW. */
    crowded: boolean;
  } => {
    const capacity = currentCapacity(ctx);
    const budgetTokens = Number.isFinite(capacity.budgetTokens) && capacity.budgetTokens > 0
      ? capacity.budgetTokens
      : Number.POSITIVE_INFINITY;
    const tokens = projectedTokenEstimate(projected);
    const marginTokens = Number.isFinite(budgetTokens)
      ? projectionMarginTokens(tokens, capacity.window)
      : 0;
    return {
      tokens,
      budgetTokens,
      marginTokens,
      over: tokens > budgetTokens,
      crowded: tokens + marginTokens > budgetTokens,
    };
  };

  const abortOverBudgetProjection = (
    tokens: number,
    budgetTokens: number,
    ctx: any,
    recoveryAttempts = 0,
  ): void => {
    const key = sha256Value({
      sessionId: persistence.state?.sessionId ?? null,
      revision: persistence.state?.revision ?? null,
      tokens,
      budgetTokens,
      phase: "projection-budget-fence",
    });
    ladder.pendingContextNote =
      `The ${brandNoun} projection estimates ${tokens} tokens against a ${budgetTokens}-token serving budget` +
      (recoveryAttempts
        ? `, after ${recoveryAttempts} recovery attempt(s) that folded everything foldable. The remaining ` +
          "inflow does not fit at any folding depth, which is an impossibility rather than a recoverable state."
        : ".") +
      " The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.";
    if (advisory.hardFenceNoticeKey !== key) {
      advisory.hardFenceNoticeKey = key;
      safeNotify(
        ctx,
        "Provider request aborted: the projection exceeds the serving budget. " +
        "Run /compact or make an explicit bounded context fold.",
        "error",
      );
    }
    if (typeof ctx.abort !== "function") {
      throw new Error(`Pi projection-budget abort capability is unavailable at ${tokens} estimated tokens`);
    }
    ctx.abort();
  };

  /**
   * Enforce the budget, and RECOVER rather than die.
   *
   * A provider context-overflow rejection mutates nothing durable: the assistant
   * message never lands and this runtime rebuilds the projection from the branch on
   * every request. So the terminal path is not an abort, it is a rollback: do not
   * append the failed exchange, fold at fence pressure until the request fits, rebuild,
   * and let Pi resend. Recovery is capped, and the cap is what makes it safe -- an
   * inflow that still will not fit after maximal folding is a genuine impossibility,
   * and that one fails LOUDLY exactly as before.
   */
  const enforceProjectionBudget = async (
    snapshot: ActiveContextSnapshot,
    projected: unknown[],
    ctx: any,
  ): Promise<{ projected: unknown[]; aborted: boolean }> => {
    let measured = projectionExceedsBudget(projected, ctx);
    const rejected = curation.pendingRejection !== null;
    // CROWDED, not over, is the trigger for reducing: the request that kills a session
    // is the one built after this one. A provider rejection outranks our own estimate:
    // it is ground truth that the last request did not fit, whatever we measured.
    if (!measured.crowded && !rejected) return { projected, aborted: false };
    // Crowded is a MARGIN PREDICTION, not an overflow. While a last-call round is
    // genuinely OPEN, exposure rendered this pass or the agent's response still
    // outstanding, the prediction waits for it: this request still fits and the
    // round ends on the very next context pass. Once the round has elapsed the
    // margin lane acts freely, because a stale exposure parked behind the reopen
    // latch must never muzzle the one reducer that can still act (the 20k-window
    // probe climbed from crowded to the wire in exactly that state). Genuine
    // untransmissibility, an over-budget projection or a provider rejection, never
    // waits: a request whose projection exceeds the provider input budget is rejected
    // outright, so recovery must produce a window that fits. Economy does not outrank
    // the one round.
    const lastCall = persistence.state?.lastCall;
    const delivery = curation.lastCallDelivery;
    const roundOpen = Boolean(lastCall) && (!delivery || delivery.exposure !== lastCall.exposure ||
      markOrdinal(snapshot) <= delivery.ordinal);
    if (!measured.over && !rejected && roundOpen) {
      return { projected, aborted: false };
    }
    // Why this fired, recorded from the measurement that TRIGGERED it rather than the
    // one taken afterwards, which by then describes a projection that fits.
    const trigger = measured;
    let reduced = projected;
    let attempts = 0;
    let reducedAtLeastOnce = false;
    // At the fence the only useful action is the fold that keeps the request
    // transmissible, so every reduction runs with every guarded mark waived.
    while (attempts < OVERFLOW_RECOVERY_MAX_ATTEMPTS && (measured.crowded || measured.over || rejected)) {
      attempts += 1;
      curation.recoveryAttempts += 1;
      let action: Record<string, unknown> | null = null;
      try {
        action = await attemptAutomaticRung(snapshot, 1, ctx, "projection-budget", {
          waiverRatio: 1,
        });
      } catch (error) {
        suspendAutomatic(error, "projection-budget", ctx);
        break;
      }
      if (!action || !persistence.state) break;
      reducedAtLeastOnce = true;
      reduced = projectWithAdvisory(snapshot);
      measured = projectionExceedsBudget(reduced, ctx);
      if (!measured.over && !measured.crowded) break;
    }
    if (reducedAtLeastOnce) {
      ladder.overBudgetReduction = {
        estimatedTokensBefore: projectedTokenEstimate(projected),
        estimatedTokensAfter: measured.tokens,
        budgetTokens: trigger.budgetTokens,
        marginTokens: trigger.marginTokens,
        estimatorErrorShare: estimatorErrorShare(),
        expectedInflowTokens: expectedInflowTokens(),
        crowded: trigger.crowded,
        overBeforeReduction: trigger.over,
        transmitted: !measured.over,
        recoveryAttempts: attempts,
        providerRejected: rejected,
      };
    }
    if (rejected) {
      curation.lastRecovery = {
        status: curation.pendingRejection?.status ?? null,
        attempts,
        estimatedTokensAfter: measured.tokens,
        budgetTokens: measured.budgetTokens,
        recovered: !measured.over,
      };
      emit("context.recovery", {
        provider_status: curation.pendingRejection?.status ?? null,
        attempts,
        max_attempts: OVERFLOW_RECOVERY_MAX_ATTEMPTS,
        tokens_before: projectedTokenEstimate(projected),
        tokens_after: measured.tokens,
        budget_tokens: measured.budgetTokens,
        margin_tokens: measured.marginTokens,
        recovered: !measured.over,
        // The join. `context.rollback` records what left the branch; this records what
        // the retried pass folded to make the shorter window fit, and the two are one
        // episode. Null when a rejection was recorded without a tree rollback.
        rollback_seq: typeof rollback.last?.seq === "number" ? rollback.last.seq : null,
      });
      const overflowBefore = projectedTokenEstimate(projected);
      deliverReceipt(contextReceipt({
        kind: "overflow-recovery",
        ordinal: markOrdinal(snapshot),
        trigger: `provider-rejection:${curation.pendingRejection?.status ?? "unknown"}`,
        freedTokens: Math.max(0, overflowBefore - measured.tokens),
        occupancyBefore: overflowBefore,
        occupancyAfter: measured.tokens,
        recovered: true,
        note: measured.over
          ? `The rebuilt request is still ${measured.tokens} tokens against a ${measured.budgetTokens}-token ` +
            "serving budget, so the run stops here rather than sending a request the provider will reject again."
          : "A rollback was required: the provider rejected the last request, which overfilled the serving " +
            `budget at ${overflowBefore} estimated tokens against ${measured.budgetTokens}. ` +
            `${attempts} reduction(s) landed it at ${measured.tokens} tokens. Nothing durable was written ` +
            "for it, and the request was rebuilt inside the budget rather than dropped.",
      }));
      curation.pendingRejection = null;
    }
    if (!measured.over) return { projected: reduced, aborted: false };
    abortOverBudgetProjection(measured.tokens, measured.budgetTokens, ctx, attempts);
    return { projected: reduced, aborted: true };
  };

  const startPreparation = (snapshot: ActiveContextSnapshot, ratio: number | null, ctx: any): void => {
    if (lifecycle.shuttingDown || !persistence.state || ladder.automaticFailure || ratio === null || persistence.state.prepared || ladder.preparing ||
        ratio < snapshot.policy.warmRatio ||
        !measurements.lastProviderMeasurement || !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) return;
    // Preparation is asynchronous but never jumps ahead of an immediately
    // committable deterministic fold on the same measured projection.
    const selection = selectAutomaticRung(snapshot, persistence.state, ratio, {
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: ladder.failedPreparations,
    });
    ladder.lastSelectionKind = selection && "candidate" in selection ? selection.candidate.kind : null;
    ladder.lastSelectionSourceIds = selection && "candidate" in selection
      ? selection.candidate.sourceRefs.slice(0, 8).map((ref) => ref.entryId)
      : [];
    if (selection?.kind !== "chapter-prepare") return;
    // Already bite-sized: the chapter selector never proposes a span past the cap, so a
    // model brief is never spent on a fold nobody can read back cheaply.
    const candidate = selection.candidate;
    const id = automaticPreparationId(candidate, persistence.state);
    const controller = new AbortController();
    ladder.lastPreparationError = null;
    ladder.lastPreparationCandidateId = id;
    const slot = { id, controller, promise: Promise.resolve() };
    ladder.preparing = slot;
    const capturedState = clone(persistence.state);
    const capturedGeneration = lifecycle.generation;
    slot.promise = prepareFold({
      candidate,
      snapshot,
      state: capturedState,
      generation: capturedGeneration,
      summarize: ladder.failedPreparations.has(id) ? undefined : options.summarizeContextSpan,
      onSummarizerFailure: (error) => {
        ladder.lastPreparationError = error instanceof Error ? error.message : String(error);
        ladder.failedPreparations.add(id);
      },
      ctx,
      signal: controller.signal,
    }).then((preparedFold) => {
      const operation = ladder.actionQueue.then(() => {
        if (controller.signal.aborted ||
            !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
        const currentState = persistence.state;
        if (!currentState || topologySha256(currentState) !== preparedFold.topologySha256 ||
            protectionSha256(currentState) !== preparedFold.protectionSha256) return;
        persistence.state = { ...currentState, prepared: preparedFold };
        return persist(ctx);
      });
      ladder.actionQueue = operation.catch(() => undefined);
      return operation;
    }).catch((error) => {
      if (controller.signal.aborted ||
          !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
      ladder.lastPreparationError = error instanceof Error ? error.message : String(error);
      ladder.failedPreparations.add(id);
      suspendAutomatic(
        error,
        "chapter-prepare",
        ctx,
        sha256Value({ sessionId: snapshot.sessionId, operation: "chapter-prepare", candidateId: id }),
      );
    }).finally(() => {
      const ownsSlot = ladder.preparing === slot;
      if (ownsSlot) ladder.preparing = null;
      if (ownsSlot && sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) updateStatus(ctx);
    });
  };
  // Appended at the very TAIL, after the stable prefix, so a suggestion never
  // invalidates a cached prefix and never becomes durable transcript.
  /**
   * The receipt block: what the runtime did to this window, as status rather than as
   * advice. It is the only carrier this runtime builds.
   *
   * It is free because it is RETROSPECTIVE. A receipt exists only after a commit has
   * already rewritten the projection, so it rides a cache break the runtime had to pay
   * for regardless, and the freeze then closes over it so it is never paid for again.
   * It is hard-bounded and its ring evicts the oldest entry, because a report about
   * bloat that becomes bloat has argued against itself.
   */
  const appendReceipts = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    const content = receiptBlockText({ receipts: curation.receipts, toolName, brandNoun });
    if (!content) return projected;
    if (!carrierAdmitted("receipts")) return projected;
    projected.push({
      role: "custom",
      customType: receiptProjectionType,
      content,
      display: false,
      details: {
        source: activeContextSource(entryTypePrefix),
        ephemeral: true,
        receipts: curation.receipts.map((receipt) => ({ ...receipt })),
        maxBytes: CONTEXT_RECEIPT_BLOCK_BYTES,
      },
      timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
        ? ownValue(snapshot.messages.at(-1), "timestamp")
        : 0,
    });
    return projected;
  };

  /**
   * The rider rides the SAME admission as the receipt block: it renders from the
   * persisted literal bytes, lands once per freeze cycle, and the freeze closes over
   * it, so it can never diverge a prefix on its own. It is never regenerated: the
   * bytes the epoch persisted are the bytes every re-render carries.
   */
  const appendRider = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    const rider = persistence.state?.rider;
    if (!rider) return projected;
    if (!carrierAdmitted("rider")) return projected;
    projected.push({
      role: "custom",
      customType: riderProjectionType,
      content: rider.text,
      display: false,
      details: {
        source: activeContextSource(entryTypePrefix),
        ephemeral: true,
        riderEpoch: rider.epoch,
      },
      timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
        ? ownValue(snapshot.messages.at(-1), "timestamp")
        : 0,
    });
    return projected;
  };

  /**
   * Threshold notices are APPEND-ONCE: each delivered notice is its own carrier with
   * its own key, so a notice that fires mid-freeze lands at the tail as a pure append,
   * the freeze closes over it, and it then persists in the window the way a tool
   * result does. A freeze break re-renders every retained notice from its persisted
   * literal bytes inside the rewrite that broke the freeze.
   */
  const appendNotices = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    const notices = persistence.state?.notices;
    if (!notices?.ring.length) return projected;
    for (const notice of notices.ring) {
      if (!carrierAdmitted(`notice-${notice.share}-${notice.ordinal}`)) continue;
      projected.push({
        role: "custom",
        customType: noticeProjectionType,
        content: notice.text,
        display: false,
        details: {
          source: activeContextSource(entryTypePrefix),
          ephemeral: true,
          share: notice.share,
          noticeOrdinal: notice.ordinal,
        },
        timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
          ? ownValue(snapshot.messages.at(-1), "timestamp")
          : 0,
      });
    }
    return projected;
  };

  /**
   * The pre-commit last-call rides the commit BOUNDARY: it is armed when the band-top
   * trigger fires, appended at the tail (a pure append) for exactly one gated round,
   * and the commit that consumes it clears the state, so the carrier's disappearance
   * rides the rewrite that commit already pays for. Rendering records the delivery,
   * which is what the one-round clock is measured from.
   */
  const appendLastCall = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    const lastCall = persistence.state?.lastCall;
    if (!lastCall) return projected;
    if (carrierAdmitted(`lastcall-${lastCall.exposure}`)) {
      projected.push({
        role: "custom",
        customType: lastCallProjectionType,
        content: lastCall.text,
        display: false,
        details: {
          source: activeContextSource(entryTypePrefix),
          ephemeral: true,
          exposure: lastCall.exposure,
        },
        timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
          ? ownValue(snapshot.messages.at(-1), "timestamp")
          : 0,
      });
    }
    if (curation.lastCallDelivery?.exposure !== lastCall.exposure) {
      curation.lastCallDelivery = { exposure: lastCall.exposure, ordinal: markOrdinal(snapshot) };
    }
    return projected;
  };

  /**
   * Whatever this pass ended up sending becomes the frozen surface for the next one, in
   * full. Nothing rides after the frozen region.
   *
   * The earlier build kept a live suggestion slate outside the freeze, reasoning that
   * advice goes stale and that a re-rendered block "only diverges the prefix when its
   * own content changes". That reasoning is wrong, and rep 21 measured the cost. A
   * positional cache compares bytes from the start: this pass sends [frozen][slate] and
   * the next sends [frozen][new messages][slate], so at the offset where the slate sat
   * the next pass has new messages instead. The slate diverges the prefix EVERY pass
   * whatever it says, because appending anything displaces it. There is no stable
   * position at a moving tail.
   *
   * Measured on rep 21: a 1503-character slate against a 1.5M-character prompt, 99.86%
   * of the projection preserved by our own accounting, and 16 full cache rebuilds
   * costing 3.71M tokens -- 21.9% of every input token in the run. Prefix caching is a
   * step function, not a gradient: mutation cost has no relation to mutation size.
   *
   * So the rule this build enforces: the runtime adds to the window only at a moment it
   * is already rewriting the window, which means at a commit. A carrier landed there is
   * free, because the break is already paid for, and it stays landed forever because
   * the freeze closes over it.
   */
  const holdFrozen = (projected: unknown[]): unknown[] => {
    freeze.projection = [...projected];
    freeze.active = false;
    return projected;
  };

  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const body = projectActiveContext(snapshot, persistence.state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType &&
        customType !== surfacingProjectionType && customType !== receiptProjectionType &&
        customType !== riderProjectionType && customType !== curationProjectionType &&
        customType !== lastCallProjectionType && customType !== noticeProjectionType;
    });
    // The freeze test, stated as bytes rather than as intent: if the rebuilt body still
    // OPENS with the frozen body verbatim, nothing structural moved and the previous
    // projection is reused whole, with only what arrived since appended after it.
    const held = freeze.body?.length ?? 0;
    freeze.active = freeze.projection !== null && body.length >= held &&
      stableStringify(body.slice(0, held)) === freeze.bodyText;
    const projected = freeze.active
      ? [...freeze.projection!, ...body.slice(held)]
      : [...body];
    if (!freeze.active) freeze.keys.clear();
    freeze.body = body;
    freeze.bodyText = stableStringify(body);
    // The one carrier left, and the only one that can ever be free: a statement of what
    // the runtime just did. It is built only when a commit produced a receipt, it lands
    // inside the freeze, and it is never rendered twice.
    //
    // Everything that used to stand here was ANTICIPATORY -- pressure milestones, the
    // live advisory, curation reminders, the last-call notice. Anticipatory guidance has
    // to arrive BEFORE the event it warns about, so it can never ride a break the
    // runtime was already paying for; it has to create one. Anticipatory guidance and an
    // append-only projection are mutually exclusive, and eleven runs say the warning
    // bought nothing anyway: voluntary fold share was 0.00, and the three runs built
    // specifically to invite curation produced 0, 1 and 0 voluntary folds.
    appendReceipts(projected, snapshot);
    appendRider(projected, snapshot);
    appendNotices(projected, snapshot);
    appendLastCall(projected, snapshot);
    return holdFrozen(projected);
  };
  /**
   * Classify the projection we are about to send against the one before it. A rewrite
   * is ours; a pure append that the provider still re-reads is not, and conflating the
   * two is what made a scheduling lever look responsible for 12 misses it never caused.
   */
  const noteProjection = (projected: unknown[]): void => {
    const digests = messageDigests(projected);
    const comparison = compareProjections(instrumentation.previousDigests, digests);
    recordProjection(instrumentation.ledger, comparison, digests);
    instrumentation.previousDigests = digests;
    instrumentation.lastChange = comparison.change;
    const text = stableStringify(projected);
    const divergence = prefixDivergence(instrumentation.previousText, text);
    const previousChars = instrumentation.previousText?.length ?? 0;
    // How much of the PREVIOUS prompt this projection still opens with. identicalShare
    // measures the new projection instead, which grows every pass and would call a
    // total rewrite "preserved" as soon as enough fresh content landed after it.
    instrumentation.lastPreservedShare = previousChars > 0
      ? divergence.identicalChars / previousChars
      : null;
    const charsPerToken = projectionCharsPerToken();
    const causes = instrumentation.sinceHandoff.filter((event) =>
      PREFIX_MUTATING_KINDS.has(event.kind));
    emit("context.projection", {
      change: comparison.change,
      previous_count: comparison.previousCount,
      next_count: comparison.nextCount,
      appended_count: comparison.appendedCount,
      first_divergent_index: comparison.firstDivergentIndex,
      chars: bytes(projected),
      estimated_tokens: projectedTokenEstimate(projected),
      chars_per_token: charsPerToken,
    });
    // Emission only. Which of these is a provider-side miss and which is a rewrite we
    // caused is a join against provider-reported cacheRead, and that join is the
    // analyst's, not this runtime's.
    emit("context.prefix", {
      change: comparison.change,
      divergent_char: divergence.index,
      divergent_tokens: divergence.index === null ? null : Math.ceil(divergence.index / charsPerToken),
      identical_chars: divergence.identicalChars,
      identical_share: divergence.identicalShare,
      chars: text.length,
      previous_chars: instrumentation.previousText?.length ?? 0,
      estimated_tokens: Math.ceil(text.length / charsPerToken),
      cause: divergence.index === null
        ? "pure-append"
        : (causes.length ? causes.map((event) => event.kind).join(",") : "unattributed"),
      cause_event_seqs: causes.map((event) => event.seq).join(","),
      events_since_handoff: instrumentation.sinceHandoff.length,
      // The request class, which falls straight out of the attribution and makes a run
      // directly comparable to a production cache table. Not new measurement.
      request_class: divergence.index === null
        ? "steady-state"
        : (causes.some((event) => event.kind === "context.recovery")
          ? "after-rollback"
          : (causes.length ? "after-fold" : "after-message")),
    });
    instrumentation.previousText = text;
    instrumentation.sinceHandoff = [];
    instrumentation.mutationsSinceHandoff = 0;
  };

  const commitDeterministicCandidate = async (
    snapshot: ActiveContextSnapshot,
    candidate: FoldCandidate,
    brief: string,
  ): Promise<string> => {
    const preparedFold = await prepareFold({
      candidate,
      snapshot,
      state: persistence.state!,
      generation: lifecycle.generation,
      brief,
      briefProvenance: "deterministic",
    });
    persistence.state = commitPreparedFold({
      prepared: preparedFold,
      snapshot,
      state: persistence.state!,
      generation: lifecycle.generation,
    });
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
    const baseState = persistence.state!;
    const generationAtStart = lifecycle.generation;
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
      state: persistence.state!,
      generation: generationAtStart,
    });
    return { preparedFold, nextState };
  };

  /**
   * The one mutation of an epoch: every pending mark, plus the automatic additions
   * a commit is allowed to make, applied through the same machinery as an immediate
   * fold. Free additions come first (peek reads the agent already discarded), then
   * the quota top-up that guarantees the commit is worth its rewrite.
   */
  /**
   * One turn of inflow, as a share of the window: the least a commit at high occupancy
   * has to free to be worth its rewrite. Measured inflow is used when the session has
   * any -- rep13 ran at a median 13,865 and a maximum 27,815 tokens per request against
   * a 400,000 window -- and the floor share stands in until then.
   */
  const commitDepthFloorShare = (snapshot: ActiveContextSnapshot): number => {
    const window = snapshot.contextWindow;
    if (!Number.isFinite(window) || window <= 0) return COMMIT_RECLAIM_FLOOR_SHARE;
    const inflow = expectedInflowTokens();
    return Math.max(COMMIT_RECLAIM_FLOOR_SHARE, inflow > 0 ? inflow / window : 0);
  };

  const atOrAboveBackstop = (snapshot: ActiveContextSnapshot, ratio: number | null): boolean => {
    const occupancy = budgetOccupancy(snapshot, ratio);
    return occupancy !== null && occupancy >= snapshot.policy.refoldRatio;
  };

  /**
   * What the gated round did, measured against the arming snapshot. Pins and unpins
   * are read from the stream itself (context.protect records after the exposure); the
   * call and mark deltas are clamped at zero because contextCalls is process-local and
   * a reload inside a round must not report a negative response.
   */
  const lastCallAttribution = (
    lastCall: NonNullable<ActiveContextState["lastCall"]>,
    agentMarksNow: number,
  ): { responded: boolean; context_calls: number; marks_added: number; protects: number; unprotects: number } => {
    const contextCalls = Math.max(0, curation.contextCalls - lastCall.contextCalls);
    const protectRecords = instrumentation.ledger.events.filter((record) =>
      record.seq > lastCall.exposure && record.kind === "context.protect");
    const protects = protectRecords.filter((record) => record.protect === true).length;
    return {
      responded: contextCalls > 0,
      context_calls: contextCalls,
      marks_added: Math.max(0, agentMarksNow - lastCall.agentMarks),
      protects,
      unprotects: protectRecords.length - protects,
    };
  };

  const clearLastCall = (): void => {
    if (!persistence.state?.lastCall) return;
    const next = { ...persistence.state };
    delete next.lastCall;
    persistence.state = next;
    curation.lastCallDelivery = null;
  };

  const runCommitEpoch = async (
    snapshot: ActiveContextSnapshot,
    trigger: string,
    topUp: boolean,
    /**
     * Pressure the waiver is measured against. Defaults to the measured ratio; the
     * over-budget reduction forces the fence so nothing survivable is held back.
     */
    waiverRatio: number | null = measurements.latestRatio,
    /**
     * A user asked for this commit. It outranks the two ECONOMIC guards -- the reclaim
     * floor and the one-mutation-per-handoff budget -- because those exist to spend the
     * session's rewrites well and the user just said where to spend one. It outranks
     * nothing else: freshness, pins, exactness and the provider fence are unchanged.
     */
    userRequested = false,
  ): Promise<Record<string, unknown> | null> => {
    const ordinal = markOrdinal(snapshot);
    let state = persistence.state!;
    let peekAdded = 0;
    let topUpAdded = 0;
    for (const mark of ephemeralPeekMarks({ snapshot, state, ordinal })) {
      const addition = addPendingMark(state, mark);
      if (addition.added) { state = addition.state; peekAdded += 1; }
    }
    const guarded = currentTurnRefKeys(snapshot);
    // THE ZONE LAW IS UNCONDITIONAL.
    //
    // There was a fence-only snapshot here: at high occupancy it narrowed the fresh
    // tail to a quarter and extended the stale zone over the middle, so a reduction
    // that had to make a rejected request sendable had mass to reach. That existed
    // because the runtime had exactly one answer to a provider rejection, folding
    // harder, and folding harder inside three zones runs out of legal material. The
    // rollback lane is the answer now: an overflow rolls the leaf back past the
    // request that failed and the ordinary commit runs on the shorter window. So the
    // zones hold in EVERY snapshot at every occupancy -- the fresh tail never folds,
    // the middle is agent judgment only, pins are exempt -- and there is one set of
    // rules to reason about instead of two.
    // The thermostat. Firing at the trigger line and folding down to the target line is
    // what makes event SPACING structural rather than hoped for.
    const capacity = servingCapacity(snapshot.contextWindow);
    const usedTokens = capacity.usedTokens;
    const budgetTokens = capacity.budgetTokens;
    // THE UNTRANSMISSIBILITY EXEMPTION, NARROWED.
    //
    // A request whose projection exceeds the provider input budget is rejected outright,
    // so recovery must produce a window that fits. The hard fence, though, is a RATIO
    // prediction. Standing near it is not the same as being unable to send, and treating
    // the two alike handed the fence path a standing waiver from both economy guards. Measured 2026-08-07 (rep 17): fence-path
    // window-pressure commits fired at eligible-freed shares as low as 0.018, under the
    // 0.02 floor the guided path honors, and re-fired inside a single ordinal. So only
    // two states outrank the economy: the overflow recovery lane, which runs because a
    // request already did not fit, and an occupancy genuinely past the serving budget,
    // where the next request aborts unless something moves. Everything else defers.
    const overflowExempt = userRequested || curation.recoveryAttempts > 0 ||
      (usedTokens !== null && budgetTokens > 0 && usedTokens > budgetTokens);
    // ONE STRUCTURAL MUTATION PER HANDOFF.
    //
    // Measured 2026-08-06 (rep 15): two context.commit records 50ms apart inside one
    // ordinal, revisions 14 and 15 -- two REAL mutations, not a duplicated record. The
    // pass had committed at the announced trigger, rebuilt the projection, found it
    // still CROWDED (inside the fence margin, but transmissible), and committed again.
    // The second commit bought margin the next pass would have bought anyway and cost a
    // whole second prefix rewrite. So a second commit in the same handoff defers unless
    // the request is genuinely untransmittable: a request whose projection exceeds the
    // provider input budget is rejected outright, so recovery must produce a window that
    // fits, and the fence and the recovery lane spend the budget to get one.
    if (instrumentation.mutationsSinceHandoff > 0 && !overflowExempt) {
      emit("context.commit", {
        trigger,
        deferred: true,
        reason: "mutation-budget-spent",
        applied_marks: 0,
        mutations_since_handoff: instrumentation.mutationsSinceHandoff,
        pending_marks: pendingMarks(state).length,
      });
      return null;
    }
    // THE HYSTERESIS, AND THE WHOLE FREEING TARGET.
    //
    // How deep this event cuts is one subtraction on one denominator: what is used,
    // less where the thermostat wants to land, over the serving budget. The separate
    // 0.40 floor is gone -- it was a share of the WINDOW under a share of the BUDGET,
    // so it never once bound (the hysteresis share at these thresholds bottoms out at
    // 0.405 of window), and a floor that cannot fire is a number that only drifts.
    const freeingTarget = usedTokens === null || budgetTokens <= 0
      ? 0
      : Math.max(0, (usedTokens - thresholds.minTarget * budgetTokens) / budgetTokens);
    if (topUp) {
      // Measuring top-up progress against ELIGIBLE mass is what keeps the pressure
      // backstop working under a peek-heavy agent: pinned and retained marks are mass
      // no commit can move, and counting them as progress stops the top-up dead.
      for (const mark of topUpMarks({
        snapshot,
        state,
        ordinal,
        excludeRefKeys: guarded,
        eligibleOnly: true,
        targetShare: freeingTarget,
      })) {
        const addition = addPendingMark(state, mark);
        if (addition.added) { state = addition.state; topUpAdded += 1; }
      }
      // DEPTH, inside the zones.
      //
      // Near the top of the window a commit that frees less than one turn of inflow
      // does not reduce anything: it pays a full prefix rewrite, gives back less than
      // the next stage adds, and the window ratchets UP through commit after commit.
      // Measured 2026-08-06 (rep13): once the big stale mass was folded, six commits of
      // two to four folds each carried the window from 340k to 370k and into a provider
      // rejection, with the backstop firing the whole way. So a commit at or above the
      // backstop that has not reached one inflow step tops up against everything
      // ELIGIBLE instead of billing a rewrite for crumbs. Eligible is the operative
      // word: this reaches harder inside the stale zone, and never outside it.
      const reachedShare = markAccounting(snapshot, state).eligibleFreedBudgetShare;
      const shallow = reachedShare < Math.max(commitDepthFloorShare(snapshot), freeingTarget);
      if (shallow && atOrAboveBackstop(snapshot, waiverRatio)) {
        for (const mark of topUpMarks({
          snapshot,
          state,
          ordinal,
          excludeRefKeys: guarded,
          eligibleOnly: true,
          targetShare: 1,
        })) {
          const addition = addPendingMark(state, mark);
          if (addition.added) { state = addition.state; topUpAdded += 1; }
        }
      }
    }
    // Boundary slivers ride along in the mutation this commit already pays for; they
    // are never a mutation of their own, and a gap above the tiny token threshold is
    // deliberate curation the absorber must not touch.
    const wedges = absorbWedgeMarks({
      snapshot,
      state,
      charsPerToken: projectionCharsPerToken(),
      excludeRefKeys: guarded,
    });
    state = wedges.state;
    const accounting = markAccounting(snapshot, state);
    if (!accounting.pending) return null;
    // The reclaim floor. One structural mutation per model call is the budget, so a
    // commit that would free crumbs spends the whole budget on nothing: it defers and
    // the marks accumulate. A request whose projection exceeds the provider input budget
    // is rejected outright, so recovery must produce a window that fits: genuine overflow
    // -- the recovery lane, or an occupancy already past the serving budget -- fires
    // regardless of what it frees. Standing at the fence RATIO does not.
    if (!overflowExempt &&
        accounting.eligibleFreedBudgetShare < COMMIT_RECLAIM_FLOOR_SHARE) {
      persistence.state = state;
      emit("context.commit", {
        trigger,
        deferred: true,
        reason: "below-reclaim-floor",
        applied_marks: 0,
        pending_marks: accounting.pending,
        eligible_marks: accounting.eligibleMarks,
        eligible_freed_share: accounting.eligibleFreedBudgetShare,
        reclaim_floor_share: COMMIT_RECLAIM_FLOOR_SHARE,
        window_tokens: snapshot.contextWindow,
      });
      return null;
    }
    const bytesBefore = bytes(projectActiveContext(snapshot, state));
    // The guard protects an in-flight excursion, never at the cost of the session's
    // ability to send a request at all: above the pressure backstop the oldest guarded
    // marks are released. The guard is a protection with a WAIVER, which is why it
    // survived the fence-snapshot deletion: one protection, one owner, one waiver.
    const guardWaiver = guardWaiverCount({
      snapshot,
      ratio: waiverRatio,
      guardedMarks: pendingMarks(state).filter((mark) =>
        markTouchesCurrentTurn(state, mark, guarded)).length,
      // The starvation test asks the same question the commit will, against the same
      // snapshot the commit adjudicates against: does this epoch have work that does
      // not touch the open turn? Two snapshots gave two answers, and the one that
      // decided the commit was not the one being asked. There is one snapshot now.
      otherApplicableMarks: pendingMarks(state).filter((mark) =>
        !markTouchesCurrentTurn(state, mark, guarded) &&
        markEligibility(snapshot, state, mark) === "eligible").length,
    });
    const result = await commitPendingMarks({
      snapshot,
      state,
      generation: lifecycle.generation,
      retainIneligible: true,
      guardCurrentTurn: true,
      guardWaiver,
    });
    persistence.state = result.state;
    const bytesAfter = bytes(projectActiveContext(snapshot, result.state));
    const freedBytes = Math.max(0, bytesBefore - bytesAfter);
    // The cost of the agent's pins, measured at the moment it matters: mass this
    // commit could not touch because protect holds it.
    const pinHeld = protectedStaleMass(snapshot, result.state);
    const commitEvent = emit("context.commit", {
      trigger,
      deferred: false,
      reason: null,
      eligible_freed_share: accounting.eligibleFreedBudgetShare,
      reclaim_floor_share: COMMIT_RECLAIM_FLOOR_SHARE,
      // The two first-class dials: how much ONE event reclaims, and how long since the
      // last one. A trigger that frees too little re-fires immediately, and that shape
      // is only visible with both numbers on the same record.
      target_freed_share: freeingTarget,
      hysteresis_target_share: freeingTarget,
      target_occupancy_share: thresholds.minTarget,
      shortfall_share: Math.max(0, freeingTarget - accounting.eligibleFreedBudgetShare),
      occupancy_tokens_before: usedTokens,
      budget_tokens: budgetTokens,
      requests_since_previous: instrumentation.requests - instrumentation.lastMutationRequest,
      inflow_tokens_since_previous: usedTokens === null || instrumentation.lastMutationTokens === null
        ? null
        : usedTokens - instrumentation.lastMutationTokens,
      applied_marks: result.applied.length,
      // Refusal is TERMINAL only. A mark whose span was still fresh is deferred, not
      // refused: it is held and folds at the first commit after the span ages out.
      refused_marks: result.refused.filter((mark) => !mark.retained).length,
      deferred_marks: result.retained.length,
      waived_marks: result.waived.length,
      pending_marks: accounting.pending,
      agent_marks: accounting.agentMarks,
      ladder_marks: accounting.ladderMarks,
      peek_marks: peekAdded,
      topup_marks: topUpAdded,
      absorbed_wedges: wedges.absorbed.length,
      freed_bytes: freedBytes,
      freed_tokens: estimatedTokens(freedBytes),
      rewrite_tokens: accounting.rewriteTokens,
      pinned_bytes: accounting.pinnedBytes,
      pinned_results: accounting.pinnedResults,
      protected_stale_bytes: pinHeld.bytes,
      protected_stale_refs: pinHeld.refs,
      window_tokens: snapshot.contextWindow,
    });
    instrumentation.mutationsSinceHandoff += 1;
    instrumentation.lastMutationRequest = instrumentation.requests;
    instrumentation.lastMutationTokens = usedTokens;
    // THE RESPONSE ATTRIBUTION. Whatever the gated round did, or that it did nothing,
    // is linked to the exposure it answered, and the exposure is consumed by the
    // commit whatever its trigger: a fence or user commit landing mid-round is still
    // the commit boundary the last-call announced. The carrier's disappearance rides
    // this commit's own rewrite.
    if (persistence.state.lastCall) {
      const lastCall = persistence.state.lastCall;
      const attribution = lastCallAttribution(lastCall, accounting.agentMarks);
      emit("context.response", {
        exposure_seq: lastCall.exposure,
        commit_seq: commitEvent.seq,
        trigger,
        outcome: attribution.responded ? "responded" : "silent",
        ...attribution,
      });
      clearLastCall();
    }
    // A commit that drops occupancy back under a waypoint re-arms its notice: the next
    // upward crossing is a new event and earns a new one. The estimate is the same one
    // the receipt reports: measured occupancy before, less what this commit freed.
    if (persistence.state.notices && usedTokens !== null && budgetTokens > 0) {
      const postOccupancy = Math.max(0, usedTokens - estimatedTokens(freedBytes)) / budgetTokens;
      const fired = persistence.state.notices.fired.filter((share) => postOccupancy >= share);
      if (fired.length !== persistence.state.notices.fired.length) {
        persistence.state = { ...persistence.state, notices: { ...persistence.state.notices, fired } };
      }
    }
    // The rider: at most ONE action prompt per fold epoch, composed from post-commit
    // numbers, persisted as literal bytes, delivered beside the receipt inside the
    // rewrite this commit already paid for. The epoch key is the commit event's own
    // stream sequence: strictly monotone, one per applied commit, so refold-only
    // epochs get their rider too and no two epochs can ever share a key. The next
    // epoch REPLACES the text; nothing stacks.
    const riderEpoch = commitEvent.seq;
    if (persistence.state.rider?.epoch !== riderEpoch) {
      const postAccounting = markAccounting(snapshot, persistence.state);
      const remainder = unmarkedRemainder(snapshot, persistence.state, projectionCharsPerToken());
      const pinnedMass = explicitProtectedMass(snapshot, persistence.state);
      const pinnedShare = budgetTokens > 0
        ? estimatedTokens(pinnedMass.bytes) / budgetTokens
        : 0;
      const riderText = contextRiderText({
        toolName,
        brandNoun,
        suggestion: deliverSurfacing(snapshot, "rider"),
        pendingAgentMarks: postAccounting.agentMarks,
        eligibleMarks: postAccounting.eligibleMarks,
        freedTokens: postAccounting.freedTokens,
        eligibleFreedTokens: postAccounting.eligibleFreedTokens,
        anchors: remainder.candidates.slice(0, 3).map((candidate) => candidate.id),
        pinnedShare,
        maxPinnedShare: MAX_PINNED_SHARE,
      });
      persistence.state = { ...persistence.state, rider: { epoch: riderEpoch, text: riderText } };
      emit("context.rider", {
        epoch: riderEpoch,
        chars: riderText.length,
        anchors: Math.min(3, remainder.candidates.length),
        pending_agent_marks: postAccounting.agentMarks,
        eligible_marks: postAccounting.eligibleMarks,
        pinned_share: pinnedShare,
        max_pinned_share: MAX_PINNED_SHARE,
      });
    }
    let foldedToolResults = 0;
    let foldedSpans = 0;
    for (const applied of result.applied) {
      const fold = persistence.state.folds.find((item) => item.id === applied.foldId);
      if (fold?.kind === "tool-result") foldedToolResults += 1;
      else foldedSpans += 1;
      // A reclaimed peek copy names what it copied. Derived from the transcript rather
      // than carried on the mark, so the pointer is the same whichever mechanism claimed
      // the copy: the exposure's reclaim marking, the commit's, or the doorless ladder.
      const peekedSources = fold?.kind === "tool-result"
        ? peekedSourceFoldIds(snapshot, flattenFoldRefs(fold, persistence.state))
        : null;
      emit("context.fold", {
        commit_seq: commitEvent.seq,
        fold_id: applied.foldId,
        // The MARK this fold came from. The stream is now the only account of what a
        // commit applied, so it has to name both ends of that mapping.
        mark_id: applied.id,
        fold_kind: fold?.kind ?? applied.mark,
        origin: applied.origin,
        peek_of: peekedSources ? peekedSources.join(",") : null,
        source_chars: fold?.sourceChars ?? 0,
        placeholder_chars: fold?.placeholderChars ?? 0,
        brief_provenance: fold ? normalizeLegacyProvenance(fold.provenance).kind : null,
      });
    }
    for (const wedge of wedges.absorbed) {
      emit("context.absorb", {
        commit_seq: commitEvent.seq,
        into_fold_id: wedge.intoMarkId,
        from_mark_id: wedge.fromMarkId,
        start_id: wedge.startId,
        end_id: wedge.endId,
        entries: wedge.entries,
        tokens: wedge.tokens,
        threshold_tokens: MAX_WEDGE_ABSORB_TOKENS,
      });
    }
    // A bound-out top-up and a silently dropped agent mark are both invisible in an
    // applied/refused list alone, so the epoch reports its own composition.
    return {
      trigger,
      applied: result.applied,
      refused: result.refused,
      pendingMarks: accounting.pending,
      agentMarks: accounting.agentMarks,
      ladderMarks: accounting.ladderMarks,
      peekMarks: peekAdded,
      topUpMarks: topUpAdded,
      absorbedWedges: wedges.absorbed.length,
      absorbed: wedges.absorbed,
      // What the commit actually folded, the way an agent counts it, so the receipt can
      // report impact instead of an opaque mark total.
      foldedSpans,
      foldedToolResults,
      occupancyTokensBefore: usedTokens,
      depthFloorShare: commitDepthFloorShare(snapshot),
      reclaimFloorShare: COMMIT_RECLAIM_FLOOR_SHARE,
      guardWaived: result.waived.length > 0,
      waivedMarks: result.waived.length,
      appliedMarks: result.applied.length,
      refusedMarks: result.refused.filter((mark) => !mark.retained).length,
      deferredMarks: result.retained.length,
      pinnedBytes: accounting.pinnedBytes,
      pinnedResults: accounting.pinnedResults,
      protectedStaleBytes: pinHeld.bytes,
      protectedStaleRefs: pinHeld.refs,
      retainedMarks: result.retained.length,
      currentTurnRetained: result.retained.filter((mark) =>
        markTouchesCurrentTurn(state, mark, guarded)).length,
      eligibleMarks: accounting.eligibleMarks,
      estimatedRewriteTokens: accounting.rewriteTokens,
      estimatedFreedTokens: accounting.freedTokens,
      freedBudgetShare: accounting.freedBudgetShare,
      sourceBytesSaved: freedBytes,
      actualFreedBudgetShare: snapshot.budgetTokens > 0
        ? estimatedTokens(freedBytes) / snapshot.budgetTokens
        : 0,
      targetBudgetShare: freeingTarget,
      hysteresisTargetShare: freeingTarget,
      requestsSincePreviousCommit: instrumentation.requests - instrumentation.lastMutationRequest,
      instrumentation: ledgerSummary(instrumentation.ledger),
    };
  };

  /** The two curation signals, measured against the ONE serving budget. */
  const measuredCurationSignals = (snapshot: ActiveContextSnapshot): CurationSignals => {
    const capacity = servingCapacity(snapshot.contextWindow);
    curation.lastSignals = curationSignals({
      snapshot,
      state: persistence.state!,
      usedTokens: capacity.usedTokens,
      budgetTokens: capacity.budgetTokens,
      window: capacity.window,
      charsPerToken: projectionCharsPerToken(),
      eligibleFolds: markAccounting(snapshot, persistence.state!).eligibleMarks,
    });
    return curation.lastSignals;
  };

  /**
   * The silent early commit. The two signals decide, the reclaim floor stops a commit
   * that would free nothing, and the hysteresis stops a plateau from reading as a
   * stream of events. What is gone is only the announcement in front of it.
   */
  /**
   * THE trigger, with its one piece of hysteresis.
   *
   * Occupancy at or above maxTarget, and then the reopen latch: a window that is still
   * full because the last commit could not reach the target is the SAME event, not a
   * new one, so a second commit waits for at least a reclaim floor of genuinely new
   * eligible mass. Without it a parked window fires a commit per pass and every one of
   * them rebuilds the prefix for crumbs.
   */
  const commitTriggerDue = (snapshot: ActiveContextSnapshot, ratio: number | null): boolean => {
    if (!persistence.state) return false;
    if (!epochCommitDue(snapshot, ratio)) return false;
    measuredCurationSignals(snapshot);
    // The latch is an ECONOMY rule, and the fence is not latched: a request whose
    // projection exceeds the provider input budget is rejected outright, so recovery
    // must produce a window that fits.
    // A request that does not fit gets its commit whether or not the previous one left
    // new eligible mass behind; holding it back would be spending the session's
    // transmissibility to save a prefix rewrite.
    if (typeof ratio === "number" && Number.isFinite(ratio) && ratio >= hardFenceRatio(snapshot)) {
      curation.reopenBaselineShare = null;
      return true;
    }
    if (curation.reopenBaselineShare !== null) {
      const eligibleShare = markAccounting(snapshot, persistence.state).eligibleFreedBudgetShare;
      if (eligibleShare - curation.reopenBaselineShare < COMMIT_RECLAIM_FLOOR_SHARE) return false;
      curation.reopenBaselineShare = null;
    }
    return true;
  };

  /**
   * Condition (a) of the reopen hysteresis, evaluated on EVERY context pass. A window
   * that fell back under the trigger has ended its cycle, and the next crossing is a
   * fresh event. This cannot live inside the trigger: the quiet passes that matter are
   * exactly the ones too far below it to evaluate it.
   */
  const clearCommitLatchBelowTrigger = (): void => {
    if (curation.reopenBaselineShare === null) return;
    const capacity = servingCapacity(lifecycle.latestSnapshot?.contextWindow ?? null);
    if (capacity.usedTokens === null || capacity.budgetTokens <= 0) return;
    if (capacity.usedTokens / capacity.budgetTokens < thresholds.maxTarget) {
      curation.reopenBaselineShare = null;
    }
  };

  /**
   * One receipt per automatic context action, in the window and in the durable stream.
   * Informatory, never exhortative: it says what happened, what it freed, and which
   * verbs correct it. A mark that changed nothing is not an event and gets no receipt.
   */
  const noteAutomaticReceipt = (
    snapshot: ActiveContextSnapshot,
    action: Record<string, unknown>,
    epoch: Record<string, unknown> | null,
  ): void => {
    const kind = String(action.kind ?? "context-action");
    if (kind === "mark") return;
    const savedBytes = Number(action.sourceBytesSaved ?? epoch?.sourceBytesSaved ?? 0);
    const freedTokens = Number.isFinite(savedBytes) && savedBytes > 0
      ? Math.ceil(savedBytes / projectionCharsPerToken())
      : 0;
    const foldIds = Array.isArray(action.foldIds) ? action.foldIds.length : 0;
    const occupancyBefore = epoch && typeof epoch.occupancyTokensBefore === "number"
      ? epoch.occupancyTokensBefore
      : measurements.lastProviderMeasurement?.tokens ?? null;
    deliverReceipt(contextReceipt({
      kind,
      ordinal: markOrdinal(snapshot),
      trigger: epoch ? String(epoch.trigger ?? "") || null : null,
      foldsCommitted: epoch ? Number(epoch.appliedMarks ?? 0) : 0,
      foldsCreated: foldIds || (epoch ? Number(epoch.appliedMarks ?? 0) : 0),
      freedTokens,
      // The impact, in the same unit the budget is stated in.
      occupancyBefore,
      occupancyAfter: occupancyBefore === null ? null : Math.max(0, occupancyBefore - freedTokens),
      spansFolded: epoch ? Number(epoch.foldedSpans ?? 0) : foldIds,
      toolResultsFolded: epoch ? Number(epoch.foldedToolResults ?? 0) : 0,
      splitFolds: Number(action.splitFolds ?? 0),
      splitFromChars: Number(action.splitFromChars ?? 0),
      absorbedWedges: Number(epoch?.absorbedWedges ?? 0),
      recovered: curation.recoveryAttempts > 0,
      protectedBytes: Number(epoch?.protectedStaleBytes ?? 0),
      note: null,
    }));
  };

  /**
   * Threshold notices, evaluated on every pass the ladder runs on. One waypoint fires
   * once per upward crossing of the measured occupancy; delivery is an append-once
   * carrier plus its stream record, and re-arming belongs to the commit that drops
   * occupancy back under the line. Default on; `guidance.thresholdNotices: false`
   * registers the runtime with the waypoints silent.
   */
  const deliverThresholdNotices = (snapshot: ActiveContextSnapshot): boolean => {
    if (!guidance.thresholdNotices || !persistence.state) return false;
    const capacity = servingCapacity(snapshot.contextWindow);
    if (capacity.usedTokens === null || capacity.budgetTokens <= 0) return false;
    const occupancy = capacity.usedTokens / capacity.budgetTokens;
    const current = persistence.state.notices ?? { fired: [], ring: [] };
    let fired = current.fired;
    let ring = current.ring;
    let changed = false;
    for (const share of THRESHOLD_NOTICE_SHARES) {
      if (occupancy < share || fired.includes(share)) continue;
      const text = thresholdNoticeText({
        share,
        occupancyTokens: capacity.usedTokens,
        budgetTokens: capacity.budgetTokens,
        maxTarget: thresholds.maxTarget,
        toolName,
        brandNoun,
      });
      fired = [...fired, share];
      ring = [...ring, { share, ordinal: markOrdinal(snapshot), text }];
      if (ring.length > MAX_THRESHOLD_NOTICES) ring = ring.slice(ring.length - MAX_THRESHOLD_NOTICES);
      changed = true;
      emit("context.notice", {
        share,
        occupancy,
        occupancy_tokens: capacity.usedTokens,
        budget_tokens: capacity.budgetTokens,
        max_target: thresholds.maxTarget,
        chars: text.length,
      });
    }
    if (changed) persistence.state = { ...persistence.state, notices: { fired, ring } };
    return changed;
  };

  /**
   * The same selection, read rather than delivered: what the next carrier WOULD say,
   * with the ledger that decides whether it says anything at all.
   */
  const statusSurfacing = (snapshot: ActiveContextSnapshot): Record<string, unknown> => {
    const ledger = persistence.state ? surfacingLedger(persistence.state) : [];
    if (!persistence.state) return { slate: [], line: null, ledger, silenced: [] };
    const selection = selectSurfacingSlate({
      state: persistence.state,
      snapshot,
      toolName,
      ordinal: markOrdinal(snapshot),
    });
    return {
      slate: selection.slate.map((suggestion) => ({
        id: suggestion.id,
        route: suggestion.route,
        contentScore: suggestion.contentScore,
        briefScore: suggestion.briefScore,
        margin: suggestion.margin,
        slot: suggestion.slot,
      })),
      line: surfacingSlateText({ slate: selection.slate, queryTerms: selection.queryTerms, brandNoun }),
      considered: selection.considered,
      divergent: selection.divergent,
      suppressed: selection.suppressed,
      intentTerms: selection.queryTerms.size,
      contentHit: SURFACING_CONTENT_HIT,
      briefHit: SURFACING_BRIEF_HIT,
      divergenceMargin: SURFACING_DIVERGENCE_MARGIN,
      slateSize: SURFACING_SLATE_SIZE,
      silenced: [...surfacingSilenced(ledger)],
      ledger,
    };
  };

  /**
   * THE SURFACING SLATE, delivered.
   *
   * The agent cannot peek a fold it does not know to want, so one line names the fold
   * whose stored content matches the task in hand when its brief does not. Where it
   * lands is the whole economics: only carriers that ride a rewrite the runtime is
   * already paying for (the pre-commit last call and the post-commit rider) plus the
   * on-demand status surface, which the agent asked for. The per-request ephemeral
   * carrier stays dead; it cost 21.9% of every input token in rep 21 and nothing else
   * about this build changes that verdict.
   *
   * One suggestion per delivery point, and most delivery points get none. Every
   * delivery first resolves whatever offers have run out of window, so the ignore that
   * silences a fold is recorded before the next selection reads the ledger.
   */
  const deliverSurfacing = (snapshot: ActiveContextSnapshot, carrier: string): string | null => {
    if (!persistence.state) return null;
    const ordinal = markOrdinal(snapshot);
    const resolved = resolveSurfacing({ state: persistence.state, snapshot, ordinal });
    persistence.state = resolved.state;
    for (const transition of resolved.transitions) {
      emit("context.outcome", {
        fold_id: transition.id,
        from_outcome: transition.from,
        outcome: transition.to,
        outcome_ordinal: transition.ordinal,
        window_ordinals: SURFACING_OUTCOME_WINDOW_ORDINALS,
      });
    }
    const selection = selectSurfacingSlate({ state: persistence.state, snapshot, toolName, ordinal });
    const suggestion = selection.slate[0];
    if (!suggestion) return null;
    const text = surfacingSlateText({
      slate: selection.slate,
      queryTerms: selection.queryTerms,
      brandNoun,
    });
    if (!text) return null;
    persistence.state = issueSurfacing(persistence.state, suggestion.id, ordinal);
    emit("context.suggestion", {
      carrier,
      fold_id: suggestion.id,
      content_score: suggestion.contentScore,
      brief_score: suggestion.briefScore,
      margin: suggestion.margin,
      content_hit: SURFACING_CONTENT_HIT,
      brief_hit: SURFACING_BRIEF_HIT,
      divergence_margin: SURFACING_DIVERGENCE_MARGIN,
      slot: suggestion.slot,
      slate_size: SURFACING_SLATE_SIZE,
      fold_depth: suggestion.depth,
      considered: selection.considered,
      divergent: selection.divergent,
      suppressed: selection.suppressed,
      intent_terms: selection.queryTerms.size,
      chars: text.length,
    });
    return text;
  };

  /**
   * THE PRE-COMMIT LAST-CALL GATE. When the band-top trigger fires, the commit defers
   * exactly one gated round behind one exposure of the ruled prompt; then it proceeds
   * with whatever marks exist. A request whose projection exceeds the provider input
   * budget is rejected outright, so recovery must produce a window that fits: fence
   * pressure, the recovery lane, or an occupancy already past the serving budget
   * commit NOW, and the user
   * command never reaches this gate because explicit intent is its own answer. The
   * round is measured from DELIVERY: the commit proceeds only on a context pass whose
   * ordinal is past the pass that rendered the exposure, which is exactly one agent
   * response between prompt and rewrite.
   */
  const lastCallVerdict = (
    snapshot: ActiveContextSnapshot,
    pressure: number | null,
    phase: string,
  ): "expose" | "hold" | "proceed" => {
    const state = persistence.state!;
    const capacity = servingCapacity(snapshot.contextWindow);
    const fenceLevel = typeof pressure === "number" && Number.isFinite(pressure) &&
      pressure >= hardFenceRatio(snapshot);
    const overBudget = capacity.usedTokens !== null && capacity.budgetTokens > 0 &&
      capacity.usedTokens > capacity.budgetTokens;
    if (fenceLevel || overBudget || curation.recoveryAttempts > 0 || curation.pendingRejection) {
      return "proceed";
    }
    if (!state.lastCall) return "expose";
    if (phase !== "context") return "hold";
    const delivery = curation.lastCallDelivery;
    if (!delivery || delivery.exposure !== state.lastCall.exposure) return "hold";
    return markOrdinal(snapshot) > delivery.ordinal ? "proceed" : "hold";
  };

  const exposeLastCall = (snapshot: ActiveContextSnapshot): void => {
    if (!persistence.state) return;
    // THE PEEK RECLAIM IS MARKED HERE, NOT ONLY AT THE COMMIT.
    //
    // A peek copy is reclaimed at the next commit by contract, and a contract the agent
    // cannot see until after it executes is not one it can veto. The exposure is the one
    // bounded round before the rewrite, so minting the reclaim marks now puts the pending
    // disposal in front of the agent while a pin still changes the outcome: a pinned mark
    // waits instead of applying, and lifting the pin hands the copy to a later commit.
    const exposureOrdinal = markOrdinal(snapshot);
    let peekReclaims = 0;
    for (const mark of ephemeralPeekMarks({ snapshot, state: persistence.state, ordinal: exposureOrdinal })) {
      const addition = addPendingMark(persistence.state, mark);
      if (addition.added) { persistence.state = addition.state; peekReclaims += 1; }
    }
    const signals = measuredCurationSignals(snapshot);
    const remainder = unmarkedRemainder(snapshot, persistence.state, projectionCharsPerToken());
    const accounting = markAccounting(snapshot, persistence.state);
    const text = lastCallText({
      signals,
      unmarked: { spans: remainder.spans, tokens: remainder.tokens },
      pendingMarks: accounting.pending,
      peekReclaims,
      suggestion: deliverSurfacing(snapshot, "lastcall"),
      toolName,
      brandNoun,
    });
    const record = emit("context.lastcall", {
      occupancy: signals.occupancy,
      max_target: thresholds.maxTarget,
      occupancy_tokens: signals.occupancyTokens,
      budget_tokens: signals.budgetTokens,
      unmarked_stale_spans: remainder.spans,
      unmarked_stale_tokens: remainder.tokens,
      pending_marks: accounting.pending,
      pending_agent_marks: accounting.agentMarks,
      peek_marks: peekReclaims,
      chars: text.length,
    });
    persistence.state = {
      ...persistence.state,
      lastCall: {
        exposure: record.seq,
        ordinal: markOrdinal(snapshot),
        contextCalls: curation.contextCalls,
        agentMarks: accounting.agentMarks,
        text,
      },
    };
  };

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
    phase = "context",
  ): Promise<Record<string, unknown> | null> => {
    if (!persistence.state || ladder.automaticFailure || ladder.preparing) return null;
    const rungSelectionOptions = {
      toolOnly: rungOptions.toolOnly,
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: ladder.failedPreparations,
    };
    // The ladder decides but does not move bytes. Marks already pending are decisions
    // already made: excluding the evidence they cover makes every eligible turn choose
    // NEW stale content, so marks accumulate with stale growth instead of re-proposing
    // one stale batch.
    const markLadderSelection = (): Record<string, unknown> | null => {
      if (!persistence.state) return null;
      const decision = selectAutomaticRung(snapshot, persistence.state, ratio, {
        ...rungSelectionOptions,
        claimed: claimedRefKeys(persistence.state),
        claimedFoldIds: markedFoldIds(persistence.state),
      });
      const mark = decision
        ? ladderSelectionMark({
          snapshot, state: persistence.state, selection: decision, ordinal: markOrdinal(snapshot),
        })
        : null;
      if (!mark) return null;
      const addition = addPendingMark(persistence.state, mark);
      if (!addition.added) return null;
      persistence.state = addition.state;
      ladder.pendingContextNote =
        `Pending ${mark.mark} mark ${mark.id} recorded; no context bytes moved. ` +
        "It applies at the next commit epoch.";
      ladder.lastAutomaticAction = {
        kind: "mark",
        foldIds: [mark.id],
        sourceIds: [],
        markKind: mark.mark,
        markOrigin: mark.origin,
        pendingMarks: pendingMarks(persistence.state).length,
        sourceBytesSaved: 0,
      };
      return ladder.lastAutomaticAction;
    };
    let epoch: Record<string, unknown> | null = null;
    let inlineRungs = true;
    // QUIET RUNTIME, AND THE ONE TRIGGER.
    //
    // A commit is an epoch transition: it rewrites the projection, every rewrite risks
    // the whole prefix cache, so the cadence has to be the fewest commits that still
    // keep the window inside its budget. Occupancy reaching maxTarget is the whole
    // automatic condition. Below it the runtime is quiet and marks accumulate free;
    // at it, one commit folds down toward minTarget, and the gap between the two lines
    // is what makes the spacing of events structural rather than hoped for.
    //
    // Two other arms used to reach this line and both are deleted. The eligible-share
    // arm fired 164 commits from ordinal 17 in rep 15 on marks that had not earned a
    // rewrite, and it could fire below maxTarget, which is the quiet law it sat under.
    // The stale-mass AND-condition guarded an ANNOUNCEMENT that no longer exists: a
    // commit is never announced, so a commit with nothing eligible now applies nothing
    // and reports it rather than being suppressed in advance.
    //
    // The trigger decides early and says nothing. Nothing warns that a commit is
    // coming, because a warning has to arrive before the event it warns about and
    // therefore has to break a prefix nothing else was breaking.
    // Evaluated on EVERY pass the ladder runs on, which is where the pressure backstop
    // always sat. Crossing the band top is a property of occupancy, not of which
    // lifecycle hook happened to notice it, and a trigger that waits for the next
    // projection pass is a window that keeps climbing while it waits.
    const noticesChanged = deliverThresholdNotices(snapshot);
    let lastCallChanged = false;
    const commitDue = commitTriggerDue(snapshot, ratio);
    if (commitDue) {
      const verdict = lastCallVerdict(snapshot, rungOptions.waiverRatio ?? ratio, phase);
      if (verdict === "expose") {
        exposeLastCall(snapshot);
        lastCallChanged = true;
      } else if (verdict === "proceed") {
        epoch = await runCommitEpoch(
          snapshot,
          "band-top",
          true,
          rungOptions.waiverRatio ?? ratio,
        );
        // Latch the eligible share this commit left behind, so the next crossing waits
        // for genuinely new foldable mass rather than for the same window to still be
        // full. The band top is a LINE, and a window parked on it is one event.
        if (persistence.state) {
          curation.reopenBaselineShare =
            markAccounting(snapshot, persistence.state).eligibleFreedBudgetShare;
        }
      }
      // "hold": the exposure is out and the round is still the agent's. Marks keep
      // accumulating below; nothing commits and nothing re-exposes.
    } else if (persistence.state.lastCall) {
      // The crossing died without its commit (a user rescue or expiry dropped
      // occupancy back under the trigger), so the exposure lapses: attributed,
      // cleared, and the next crossing is a fresh event with a fresh exposure.
      const capacity = servingCapacity(snapshot.contextWindow);
      if (capacity.usedTokens !== null && capacity.budgetTokens > 0 &&
          capacity.usedTokens / capacity.budgetTokens < thresholds.maxTarget) {
        const lastCall = persistence.state.lastCall;
        const attribution = lastCallAttribution(
          lastCall,
          markAccounting(snapshot, persistence.state).agentMarks,
        );
        emit("context.response", {
          exposure_seq: lastCall.exposure,
          commit_seq: null,
          trigger: null,
          outcome: "lapsed",
          ...attribution,
        });
        clearLastCall();
        lastCallChanged = true;
      }
    }
    // An inline rung is free only INSIDE a rewrite the epoch already paid for. Below
    // the threshold no commit ran, and an epoch that applied NOTHING -- every mark
    // held back by an open turn or by ineligibility -- paid for no rewrite either,
    // so folding inline there is a fresh single-fold rewrite of its own. Measured
    // 2026-08-06 (rep 10): the current-turn guard retained all nine marks every turn
    // while the inline rung folded one batch per turn anyway, 52 single-fold
    // rewrites that left the prefix cache share at zero. Below a paid rewrite the
    // ladder MARKS, so the decisions batch into the first commit that can apply them.
    inlineRungs = Boolean(epoch) && Number(epoch?.appliedMarks ?? 0) > 0;
    if (!inlineRungs) {
      const marked = markLadderSelection();
      if (marked) {
        if (epoch) ladder.lastAutomaticAction = { ...marked, epoch };
        return ladder.lastAutomaticAction;
      }
      // A carrier change is durable state even when no mark and no epoch moved: the
      // exposure and the notices must survive a reload, so the pass returns an action
      // for the transaction to persist. Never a receipt: a carrier reports itself.
      if (!epoch && (lastCallChanged || noticesChanged)) {
        ladder.lastAutomaticAction = { kind: "carrier", foldIds: [], sourceIds: [], sourceBytesSaved: 0 };
        return ladder.lastAutomaticAction;
      }
    }
    // Evidence a pending mark already covers is not the inline rung's to fold: a mark
    // the commit RETAINED (the open turn's own reads) would otherwise be folded here
    // by the very pass that just protected it.
    //
    // The open turn's keys are excluded DIRECTLY, not just via the marks that claim
    // them. Claiming is not protection: once a commit applies every pending mark the
    // claim set is empty, and the inline rung then folds the open turn's oldest read
    // with nothing left to stop it. That is the rep-8 shape, and byte freshness does
    // not reach it -- the first read of a long excursion sits outside the fresh tail
    // while the turn that gathered it is still running. It became reachable when the
    // quiet cadence started landing a commit on the same context pass, which is what
    // turns the inline rung on in the first place.
    const selection = inlineRungs
      ? selectAutomaticRung(snapshot, persistence.state, ratio, {
        ...rungSelectionOptions,
        claimed: new Set([
          ...claimedRefKeys(persistence.state),
          ...currentTurnRefKeys(snapshot),
        ]),
        claimedFoldIds: markedFoldIds(persistence.state),
      })
      : null;
    // Above the commit threshold we are already inside the epoch's rewrite turn, so
    // every rung applies inline: the extra rung costs at most one more invalidation
    // in a turn that has already paid one. Restricting this to prepared chapters made
    // the refold and consolidation rungs unreachable in epoch mode, which drove a
    // session whose reducible bytes sit in expanded folds into the hard fence.
    const applicable = selection;
    if (!applicable || applicable.kind === "chapter-prepare") {
      if (!epoch || !persistence.state) return null;
      ladder.pendingContextNote =
        `A commit epoch applied ${(epoch.applied as unknown[]).length} pending mark(s) in one rewrite; ` +
        "exact evidence remains expandable.";
      ladder.lastAutomaticAction = { kind: "epoch-commit", foldIds: [], sourceIds: [], epoch };
      noteAutomaticReceipt(snapshot, ladder.lastAutomaticAction, epoch);
      return ladder.lastAutomaticAction;
    }
    const projectedBytesBefore = bytes(projectActiveContext(snapshot, persistence.state));
    let action: Record<string, unknown> | null = null;
    if (applicable.kind === "prepared-chapter" && persistence.state.prepared) {
      const error = preparedFoldError({
        prepared: persistence.state.prepared,
        snapshot,
        state: persistence.state,
        generation: lifecycle.generation,
        ratio,
      });
      if (error) {
        persistence.state = clearPrepared(persistence.state);
      } else {
        const id = persistence.state.prepared.id;
        const sourceIds = persistence.state.prepared.sourceRefs.map((ref) => ref.entryId);
        persistence.state = commitPreparedFold({
          prepared: persistence.state.prepared,
          snapshot,
          state: persistence.state,
          generation: lifecycle.generation,
        });
        action = { kind: "chapter-fold", foldIds: [id], sourceIds };
        ladder.pendingContextNote = `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
      }
    } else if (applicable.kind === "tool") {
      cancelPreparation();
      const tool = applicable.candidate;
      const id = await commitDeterministicCandidate(snapshot, tool, automaticToolBrief(snapshot, tool));
      action = {
        kind: "tool-fold",
        foldIds: [id],
        sourceIds: tool.sourceRefs.map((ref) => ref.entryId),
      };
      ladder.pendingContextNote = `${tool.sourceRefs.length} stale completed read-only tool result(s) were folded.`;
    } else if (applicable.kind === "refold") {
      cancelPreparation();
      persistence.state = setFoldProjectionState(persistence.state, applicable.foldId, "folded");
      action = { kind: "refold", foldIds: [applicable.foldId] };
      ladder.pendingContextNote = `Stale expanded fold ${applicable.foldId} returned to its identical placeholder.`;
    } else if (applicable.kind === "consolidation") {
      cancelPreparation();
      const consolidation = applicable.candidate;
      const id = await commitDeterministicCandidate(
        snapshot,
        consolidation,
        deterministicConsolidationBrief(consolidation, persistence.state),
      );
      action = {
        kind: "consolidation",
        foldIds: [id],
        sourceIds: consolidation.sourceRefs.map((ref) => ref.entryId),
      };
      ladder.pendingContextNote =
        `Stale folded chapters were consolidated under ${id}; every child remains expandable.`;
    } else if (applicable.kind === "chapter") {
      const chapter = applicable.candidate;
      // Bite-sized by construction: an oversized coherent chapter becomes sequential
      // bounded folds, each with its own brief, split only at closed unit boundaries.
      const spanChars = candidateSpanChars(snapshot, persistence.state, chapter);
      const parts = splitCandidateBySize(snapshot, persistence.state, chapter);
      const foldIds: string[] = [];
      for (const part of parts) {
        foldIds.push(await commitDeterministicCandidate(
          snapshot,
          part,
          deterministicChapterCandidateBrief(snapshot, part),
        ));
      }
      action = {
        kind: "chapter-fold",
        foldIds,
        sourceIds: chapter.sourceRefs.map((ref) => ref.entryId),
        ...(parts.length > 1 ? { splitFolds: parts.length, splitFromChars: spanChars } : {}),
      };
      if (parts.length > 1) {
        emit("context.split", {
          source: "ladder",
          span_chars: spanChars,
          parts: parts.length,
          cap_chars: MAX_FOLD_SPAN_CHARS,
          fold_ids: foldIds.join(","),
        });
      }
      ladder.pendingContextNote = parts.length > 1
        ? `A ${spanChars}-char stale chapter was folded as ${parts.length} bite-sized folds ` +
          `(${foldIds.join(", ")}); exact evidence remains expandable.`
        : `A coherent stale chapter was folded under ${foldIds[0]}; exact evidence remains expandable.`;
    }
    if ((!action && !epoch) || !persistence.state) return null;
    const projectedBytesAfter = bytes(projectActiveContext(snapshot, persistence.state));
    ladder.lastAutomaticAction = {
      ...(action ?? { kind: "epoch-commit", foldIds: [], sourceIds: [] }),
      ...(epoch ? { epoch } : {}),
      sourceBytesSaved: Math.max(0, projectedBytesBefore - projectedBytesAfter),
    };
    noteAutomaticReceipt(snapshot, ladder.lastAutomaticAction, epoch);
    return ladder.lastAutomaticAction;
  };
  const runAutomaticRungTransaction = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!persistence.state || !measurements.lastProviderMeasurement ||
        !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) return null;
    if (ladder.automaticFailure) {
      ladder.automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        ladder.automaticFailure.suppressedCallbacks + 1,
      );
      return null;
    }
    const key = automaticOperationKey(phase, snapshot, ratio);
    const stateAtEntry = clone(persistence.state);
    const persistedAtEntry = persistence.persisted;
    const recordsAtEntry = persistence.persistedFoldRecords.size;
    const transientAtEntry = captureTransient();
    let action: Record<string, unknown> | null = null;
    try {
      action = await applyAutomaticRung(snapshot, ratio, rungOptions, phase);
      if (action) await persist(ctx);
      if (action) ladder.boundaryFailure = null;
      return action;
    } catch (error) {
      const stateCommitted = persistence.persisted !== persistedAtEntry;
      const recordOnly = !stateCommitted && persistence.persistedFoldRecords.size > recordsAtEntry;
      if (!stateCommitted) {
        persistence.state = stateAtEntry;
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
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
  ): Promise<Record<string, unknown> | null> => {
    const operation = ladder.actionQueue.then(() =>
      runAutomaticRungTransaction(snapshot, ratio, ctx, phase, rungOptions));
    ladder.actionQueue = operation.catch(() => undefined);
    return operation;
  };
  const projectionCandidates = (ctx: any): Array<Record<string, unknown>> => {
    if (lifecycle.shuttingDown || !persistence.state) return [];
    try {
      return projectionSlateCandidates(persistence.state, authoritativeSnapshotFor(ctx));
    } catch {
      return [];
    }
  };
  // A same-session start/tree reload is a projection-generation mutation.
  // Queue it behind every context authority → preparation → commit →
  // projection transaction, then serialize the actual load with the action
  // queue. Appending to actionQueue only after the context queue drains is
  // deliberate: a running context may itself need actionQueue to commit its
  // final-rung chapter, so capturing both queues up front would deadlock.
  const enqueueLifecycleLoad = async (ctx: any): Promise<void> => {
    const operation = lifecycle.contextQueue.then(() => {
      const loadOperation = ladder.actionQueue.then(async () => {
        load(ctx);
        await recoverNativeReceipts(ctx);
      });
      ladder.actionQueue = loadOperation.catch(() => undefined);
      return loadOperation;
    });
    lifecycle.contextQueue = operation.then(() => undefined, () => undefined);
    await operation;
  };

  const safeLifecycleLoad = async (ctx: any, phase: "session-start" | "session-tree"): Promise<void> => {
    try { await enqueueLifecycleLoad(ctx); }
    catch (error) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!persistence.state || persistence.state.sessionId !== sessionId) persistence.state = emptyActiveContextState(sessionId);
      if (!persistence.persisted || persistence.persisted.sessionId !== sessionId) persistence.persisted = clone(persistence.state);
      lifecycle.latestSnapshotError = error instanceof Error ? error.message : String(error);
      suspendAutomatic(error, phase, ctx);
      updateStatus(ctx);
    }
  };

  /**
   * State the resolved serving budget once, at startup, before anything reads it. A
   * budget nobody can see in the stream is how rep 15 spent a whole run on a 272,000
   * descriptor without a single record saying so.
   */
  const recordResolvedCapacity = (ctx: any): void => {
    const capacity = currentCapacity(ctx);
    emit("context.capacity", {
      mode: capacity.mode,
      window_tokens: capacity.window,
      budget_tokens: capacity.budgetTokens,
      output_reservation: capacity.outputReservation,
      descriptor_window: capacity.descriptorWindow,
    });
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    await safeLifecycleLoad(ctx, "session-start");
    recordResolvedCapacity(ctx);
    await armRollbackLane(ctx);
  });
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
    nativeCompaction.pendingNativeReceipt = receipt;
    load(ctx, true);
    nativeCompaction.lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: `native compaction completed; ${brandNoun} folding state rebuilt`,
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
    safeNotify(ctx, `Pi native compaction ran; ${brandNoun} folding state was rebuilt.`, "warning");
    updateStatus(ctx);
  });

  const attributionChanged = async (_event: unknown, ctx: any): Promise<void> => {
    lifecycle.generation += 1;
    cancelPreparation();
    if (persistence.state?.prepared) persistence.state = clearPrepared(persistence.state);
    measurements.latestRatio = null;
    measurements.lastProviderMeasurement = null;
    nativeCompaction.lastThresholdDecision = null;
    updateStatus(ctx);
  };
  pi.on("model_select", attributionChanged);
  pi.on("thinking_level_select", attributionChanged);

  const accountAnchoredMeasurement = (measurement: ProviderContextMeasurement): boolean => {
    if (!persistence.state) return false;
    if (!measurements.lastProviderMeasurement) {
      measurements.lastProviderMeasurement = measurement;
      return false;
    }
    if (measurements.lastProviderMeasurement.messageSha256 === measurement.messageSha256) return false;
    const previousTokens = measurements.lastProviderMeasurement.tokens;
    const delta = Math.max(0, measurement.tokens - previousTokens);
    const tokensSinceToolFold = Math.min(Number.MAX_SAFE_INTEGER, persistence.state.tokensSinceToolFold + delta);
    const leases = Object.fromEntries(Object.entries(persistence.state.leases)
      .flatMap(([id, remaining]) => remaining > 1 ? [[id, remaining - 1]] : []));
    const changed = tokensSinceToolFold !== persistence.state.tokensSinceToolFold ||
      stableStringify(leases) !== stableStringify(persistence.state.leases);
    if (changed) persistence.state = { ...persistence.state, tokensSinceToolFold, leases };
    return changed;
  };

  const handleContext = async (event: { messages: unknown[] }, ctx: any) => {
    if (lifecycle.shuttingDown) return { messages: event.messages };
    beginMutationPass();
    clearCommitLatchBelowTrigger();
    if (!persistence.state) persistence.state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    lifecycle.latestSnapshot = null;
    lifecycle.latestSnapshotError = null;
    const stateAtEntry = clone(persistence.state);
    const persistedAtEntry = persistence.persisted;
    const transientAtEntry = captureTransient();
    const generationAtEntry = lifecycle.generation;
    let mutationAttempted = ladder.pendingManual;
    let persistedSucceeded = false;
    try {
      const snapshot = snapshotForEvent(ctx, event.messages);
      lifecycle.latestSnapshot = snapshot;
      if (ladder.automaticFailure) {
        ladder.automaticFailure.suppressedCallbacks = Math.min(
          Number.MAX_SAFE_INTEGER,
          ladder.automaticFailure.suppressedCallbacks + 1,
        );
      }
      let observedMeasurement = latestProviderContextMeasurement(
        snapshot.messages,
        budgetWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (observedMeasurement && providerMeasurementBranchIndex(ctx, observedMeasurement) < 0) {
        observedMeasurement = null;
      }
      let measurementStateChanged = false;
      if (observedMeasurement) {
        const boundRevision = measurements.providerMeasurementRevisionByMessageSha.get(
          observedMeasurement.messageSha256,
        );
        if (boundRevision !== undefined &&
            !durableProviderMeasurementReceiptMatches(observedMeasurement, boundRevision)) {
          try { await persistProviderMeasurement(ctx, observedMeasurement, boundRevision); }
          catch (error) { suspendAutomatic(error, "provider-measurement", ctx); }
        }
        measurements.latestRatio = contextUsageRatio(observedMeasurement);
        if (durableProviderMeasurementMatches(observedMeasurement) && measurements.latestRatio !== null) {
          measurementStateChanged = accountAnchoredMeasurement(observedMeasurement);
          // Calibrate BEFORE the new measurement becomes the previous one: the inflow
          // step is the difference between them.
          noteProjectionCalibration(observedMeasurement);
          measurements.lastProviderMeasurement = observedMeasurement;
          startPreparation(snapshot, measurements.latestRatio, ctx);
          if (!ladder.automaticFailure && measurements.latestRatio >= hardFenceRatio(snapshot) && ladder.preparing) {
            mutationAttempted = true;
            await ladder.preparing.promise;
            if (!sessionIdentityStillValid(ctx, snapshot.sessionId, generationAtEntry)) {
              return { messages: event.messages };
            }
          }
          if (selectAutomaticToolBatch(snapshot, persistence.state)[0]) mutationAttempted = true;
          const action = await attemptAutomaticRung(
            snapshot, measurements.latestRatio, ctx, "context",
          );
          if (action) {
            mutationAttempted = true;
            persistedSucceeded = true;
          }
        } else measurements.lastProviderMeasurement = observedMeasurement;
      } else {
        measurements.latestRatio = contextUsageRatio(measurements.lastProviderMeasurement);
      }
      if (measurementStateChanged && persistence.state &&
          persistence.persisted && !sameStateProjection(persistence.state, persistence.persisted)) {
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
      // A projection larger than the serving budget is never transmitted, whatever the
      // last measured ratio says about the request before it.
      const budgeted = await enforceProjectionBudget(snapshot, projected, ctx);
      projected = budgeted.projected;
      // Every projection this process BUILDS is a size reference for the calibration,
      // including one the fence aborted. Recording only sent projections locks an
      // already-large session out of calibrating at all: its first projection aborts
      // under the uncalibrated constant, so nothing is ever sent, so nothing ever
      // measures the ratio, so it aborts forever.
      measurements.lastProjectedChars = bytes(projected);
      measurements.lastProjectedEstimate = projectedTokenEstimate(projected);
      measurements.lastProjectedEstimateCalibrated = measurements.projectionCalibrations.length > 0;
      // An aborted request still returns the PROJECTION. Handing back the raw branch
      // instead makes the aborted turn the largest message list the session ever
      // produced -- the corpus, folds and all -- which is the exact inverse of what a
      // fence is for, and it is what an abort looked like in rep12: 3,952,934 chars
      // against a 1,322,385-char projection of the same session. It is not noted as a
      // cache observation, because it was never sent.
      if (budgeted.aborted) {
        updateStatus(ctx);
        return { messages: projected };
      }
      noteProjection(projected);
      updateStatus(ctx);
      return { messages: projected };
    } catch (error) {
      if (!persistedSucceeded && persistence.persisted === persistedAtEntry) {
        persistence.state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      lifecycle.latestSnapshotError = error instanceof Error ? error.message : String(error);
      if (mutationAttempted) {
        if (!persistedSucceeded) ladder.boundaryFailure = lifecycle.latestSnapshotError;
        suspendAutomatic(error, persistedSucceeded ? "post-persist-projection" : "context", ctx);
      }
      abortUnsafeHardContext(lifecycle.latestSnapshot, ctx);
      return { messages: event.messages };
    }
  };
  pi.on("context", (event: { messages: unknown[] }, ctx: any) => {
    const operation = lifecycle.contextQueue.then(() => handleContext(event, ctx));
    lifecycle.contextQueue = operation.then(() => undefined, () => undefined);
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
    if (lifecycle.shuttingDown ||
        !sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        topologySha256(persistence.state!) !== capturedTopologySha256 ||
        protectionSha256(persistence.state!) !== capturedProtectionSha256) return;
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
    // The provider accepted a request: whatever the recovery lane spent belongs to an
    // inflow that is now behind us, and the cap resets for the next one.
    curation.recoveryAttempts = 0;
    curation.pendingRejection = null;
    measurements.lastProviderMeasurement = measurement;
    measurements.latestRatio = measuredRatio;
    let snapshot: ActiveContextSnapshot;
    try { snapshot = authoritativeSnapshotFor(ctx); }
    catch {
      updateStatus(ctx);
      return;
    }
    startPreparation(snapshot, measurements.latestRatio, ctx);
    if (measurements.latestRatio >= hardFenceRatio(measurement, ctx) && ladder.preparing) await ladder.preparing.promise;
    if (!sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        !durableProviderMeasurementMatches(measurement)) return;
    const action = await attemptAutomaticRung(
      authoritativeSnapshotFor(ctx),
      measurements.latestRatio,
      ctx,
      "message-end",
    );
    if (!action && measurementStateChanged && persistence.state && persistence.persisted &&
        !sameStateProjection(persistence.state, persistence.persisted)) {
      await persistThroughActionQueue(ctx);
    }
    updateStatus(ctx);
  };

  pi.on("message_end", async (event: Record<string, unknown>, ctx: any) => {
    if (lifecycle.shuttingDown) return;
    beginMutationPass();
    try {
      const message = ownValue(event, "message");
      noteOverflowAtMessageEnd(message, ctx);
      instrumentation.requests += 1;
      const observation = observeCacheUsage(instrumentation.ledger, {
        usage: ownValue(message, "usage"),
        change: instrumentation.lastChange,
        preservedShare: instrumentation.lastPreservedShare,
      });
      if (observation) {
        // The join key: this is where the stream meets provider-side telemetry.
        emit("context.usage", {
          provider: ownValue(message, "provider") ?? null,
          model: ownValue(message, "model") ?? null,
          input_tokens: observation.inputTokens,
          cache_read_tokens: observation.cacheReadTokens,
          total_tokens: providerTokens(message),
          projection_change: observation.change,
          provider_side_miss: observation.providerSideMiss,
          message_sha256: evidenceSha256(message),
        });
      }
      const measurement = providerContextMeasurement(
        message,
        budgetWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (!measurement || !persistence.state) return;
      const capturedSessionId = ctx.sessionManager.getSessionId();
      const capturedGeneration = lifecycle.generation;
      const capturedProjectionRevision = persistence.state.revision;
      const capturedTopologySha256 = topologySha256(persistence.state);
      const capturedProtectionSha256 = protectionSha256(persistence.state);
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
  /*
   * There was an `after_provider_response` handler here that treated `status >= 400` as
   * the rejection signal. It could never fire on the case it was written for. Every
   * provider adapter calls `onResponse` exactly once and only AFTER the request promise
   * resolves, so a 4xx rejects the promise and control never reaches that call at all
   * (verified across all seven adapters in pi-ai 0.83.0). `pendingRejection` was
   * therefore never set in production and the recovery branch of the projection budget
   * never ran. It is set by the rollback lane now, from an event that does fire.
   */
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    beginMutationPass();
    if (lifecycle.shuttingDown || !persistence.state || !persistence.persisted) return;
    const stateAtEntry = clone(persistence.state);
    const persistedAtEntry = persistence.persisted;
    const transientAtEntry = captureTransient();
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      if (!ladder.pendingManual && !ladder.automaticFailure && measurements.latestRatio !== null && measurements.lastProviderMeasurement &&
          durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) {
        startPreparation(snapshot, measurements.latestRatio, ctx);
        if (measurements.latestRatio >= hardFenceRatio(snapshot) && ladder.preparing) await ladder.preparing.promise;
        await attemptAutomaticRung(snapshot, measurements.latestRatio, ctx, "turn-end");
      }
      ladder.pendingManual = false;
      if (!ladder.automaticFailure) ladder.boundaryFailure = null;
    } catch (error) {
      if (persistence.persisted === persistedAtEntry) {
        persistence.state = stateAtEntry;
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

  /**
   * pi's own overflow classifier, borrowed rather than re-implemented.
   *
   * `isContextOverflow` owns the provider-message patterns AND the silent cases (usage
   * past the window with a clean stop, the truncating `length` stop). Re-stating that
   * pattern set here would drift on the first provider that reworded its 400. The
   * bare specifier is tried first, for a deployment where pi-ai is hoisted; the second
   * form reaches pi's own nested copy, which is where a default install puts it.
   */
  const resolveOverflowClassifier = async (): Promise<void> => {
    if (rollback.classifier || rollback.classifierSource === "unresolved") return;
    const host = "@earendil-works/pi-coding-agent";
    const marker = `/${host}/`;
    const specifiers = ["@earendil-works/pi-ai/compat"];
    try {
      const entry = import.meta.resolve(host);
      const at = entry.lastIndexOf(marker);
      if (at >= 0) {
        specifiers.push(`${entry.slice(0, at + marker.length)}node_modules/@earendil-works/pi-ai/dist/compat.js`);
      }
    } catch { /* An unresolvable host is the same answer as an unresolvable classifier. */ }
    for (const specifier of specifiers) {
      try {
        const module = await import(specifier) as Record<string, unknown>;
        if (typeof module.isContextOverflow === "function") {
          rollback.classifier = module.isContextOverflow as (message: unknown, contextWindow: number) => boolean;
          rollback.classifierSource = specifier;
          return;
        }
      } catch { /* Try the next form; the last failure is the answer. */ }
    }
    rollback.classifierSource = "unresolved";
  };

  const armRollbackLane = async (ctx: any): Promise<void> => {
    const probes = probeRollbackSurfaces(ctx?.sessionManager);
    rollback.probes = probes;
    rollback.armed = probes.armed;
    await resolveOverflowClassifier();
    if (!probes.armed) {
      safeNotify(
        ctx,
        `${brandNoun} overflow rollback is DISARMED for this session (${probes.failures.join("; ")}). ` +
        "An input-overflow rejection will abort the request instead of rolling the session back.",
        "warning",
      );
    }
  };

  /**
   * The disarmed answer, and the only one: say so on the record and leave the session
   * behaving exactly as it did before the lane existed.
   */
  const refuseRollback = (reason: string, trigger: string, ctx: any): void => {
    emit("context.rollback", {
      trigger,
      armed: false,
      disarm_reason: reason,
      error_entry_id: null,
      old_leaf_id: null,
      new_leaf_id: null,
      entries_abandoned: 0,
      occupancy_tokens_before: measurements.lastProviderMeasurement?.tokens ?? null,
      tokens_rolled_back: 0,
      replayed: false,
      replay_skip_reason: "lane-disarmed",
      notice_chars: 0,
      attempt_ordinal: rollback.attempts,
      probes_passed: rollback.probes ? rollback.probes.failures.length === 0 : false,
    });
    safeNotify(
      ctx,
      `${brandNoun} could not roll back after a provider input-overflow rejection: ${reason}. ` +
      "The request was not retried.",
      "error",
    );
  };

  /**
   * The fallback trigger, and the honest limit of it.
   *
   * `session_before_compact` never fires for a deployment that turned auto-compaction
   * off, so the primary trigger is deaf there. This is the second detector: pi's own
   * classifier over the assistant message at `message_end`, which is where the error
   * message first becomes visible. It records the episode and, if no compaction event
   * claims it, reports it.
   *
   * It does NOT roll back, and the reason is mechanical rather than cautious. The
   * pre-strip this lane depends on happens INSIDE `_checkCompaction`, which is exactly
   * the code an auto-compaction-disabled deployment never reaches, so on this path
   * agent state still carries the oversized window plus the error message. A bare
   * `branch()` there would leave the tree and agent state disagreeing, which is the
   * failure mode the whole design exists to avoid. Held, and reported as held.
   */
  const noteOverflowAtMessageEnd = (message: unknown, ctx: any): void => {
    if (!rollback.classifier || !message || typeof message !== "object") return;
    const window = budgetWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW;
    let overflow = false;
    try { overflow = rollback.classifier(message, window) === true; }
    catch { return; }
    if (!overflow) return;
    rollback.pendingOverflow = { at: currentOrdinal(), entryId: null };
  };

  /**
   * An overflow that no compaction event claimed: the auto-compaction-disabled shape.
   * Loud, terminal, and never silent.
   */
  const reportUnclaimedOverflow = (ctx: any): void => {
    if (!rollback.pendingOverflow) return;
    rollback.pendingOverflow = null;
    rollback.attempts += 1;
    refuseRollback(
      "the overflow arrived without a compaction event, so pi never stripped the failed message from agent " +
      "state and a tree rollback would leave the tree and agent state disagreeing (auto-compaction is off)",
      "message_end",
      ctx,
    );
  };

  /**
   * ROLLBACK, COMMIT, REPLAY.
   *
   * pi has already stripped the trailing error message from agent state by the time
   * this fires, so agent state IS the rolled-back window and all that remains is to
   * move the session leaf to match. The label goes on FIRST, because a label appends at
   * the current leaf and advances it, so applied after the branch it would mark the
   * surviving path instead of the abandoned one.
   *
   * The commit deliberately does NOT happen here. The retried request runs its own
   * `context` pass, and that pass folds and commits before the payload is built. A
   * commit here would adjudicate a snapshot taken outside a projection pass and then be
   * evaluated again by the retry, which is two mutations for one episode.
   */
  const rebuiltMessageCount = (manager: Record<string, any>): number | null => {
    try {
      const rebuilt = manager.buildSessionContext?.();
      return Array.isArray(rebuilt?.messages) ? rebuilt.messages.length : null;
    } catch { return null; }
  };

  const recoverFromOverflow = (event: Record<string, unknown>, ctx: any): void => {
    rollback.attempts += 1;
    rollback.pendingOverflow = null;
    if (!rollback.armed) {
      refuseRollback(
        rollback.probes?.failures.join("; ") ?? "the rollback probes never ran",
        "session_before_compact",
        ctx,
      );
      return;
    }
    const shape = overflowEventShape(event);
    if (!shape.ok) {
      refuseRollback(`the overflow event is missing ${shape.missing.join(", ")}`, "session_before_compact", ctx);
      return;
    }
    const branchEntries = ownValue(event, "branchEntries");
    // Copied, not aliased. `getBranch()` hands back the live array and the branch call
    // below truncates it in place, so a handler holding the original reference watches
    // the entries it is still reasoning about disappear underneath it.
    const entries = Array.isArray(branchEntries) ? [...branchEntries] : [];
    const errorEntry = findOverflowErrorEntry(entries);
    if (!errorEntry) {
      refuseRollback("the rejected assistant entry is not the branch tail", "session_before_compact", ctx);
      return;
    }
    const manager = ctx.sessionManager as Record<string, any>;
    const oldLeafId = manager.getLeafId();
    const sessionMessagesBefore = rebuiltMessageCount(manager);
    const abandoned = entries.slice(errorEntry.index);
    const rolledBackBytes = bytes(abandoned.flatMap((entry: any) => sessionEntryMessages(entry) ?? []));
    // Lineage first. The abandoned path stays in the tree, and it says why it was left.
    try {
      manager.appendLabelChange(errorEntry.id, `${entryTypePrefix} overflow rollback`);
    } catch (error) {
      refuseRollback(`the lineage label failed (${String(error)})`, "session_before_compact", ctx);
      return;
    }
    try {
      if (errorEntry.parentId === null) manager.resetLeaf();
      else manager.branch(errorEntry.parentId);
    } catch (error) {
      refuseRollback(`the branch failed (${String(error)})`, "session_before_compact", ctx);
      return;
    }
    // The invariant, measured rather than assumed: the rolled-back window has to be
    // exactly the failed entry shorter, or the retry sends something nobody built.
    const errorEntryMessages = (sessionEntryMessages(entries[errorEntry.index]) ?? []).length;
    const sessionMessagesAfter = rebuiltMessageCount(manager);
    const holds = sessionMessagesBefore === null || sessionMessagesAfter === null ||
      preStripHolds({ sessionMessagesBefore, sessionMessagesAfter, errorEntryMessages });
    const unanswered = unansweredToolCalls(entries.slice(0, errorEntry.index));
    let replaySkipReason: string | null = null;
    if (!holds) {
      replaySkipReason = `the rolled-back window came back ${sessionMessagesAfter} messages against the ` +
        `${(sessionMessagesBefore ?? 0) - errorEntryMessages} the rollback should have left`;
    } else if (unanswered.length) {
      replaySkipReason = `the rolled-back tail leaves ${unanswered.length} tool call(s) unanswered, and a user ` +
        "turn after an unsatisfied tool call is a malformed transcript for every provider";
    }
    const occupancyBefore = measurements.lastProviderMeasurement?.tokens ?? null;
    const notice = rollbackNoticeText({
      brandNoun,
      toolName,
      tokensRolledBack: estimatedTokens(rolledBackBytes),
      entriesAbandoned: abandoned.length,
      replayed: replaySkipReason === null,
      replaySkipReason,
    });
    // Exactly ONE steered message. Steering drains one at a time at the top of the
    // retried loop, so a second would be silently held to a turn that never comes.
    let replayed = false;
    if (replaySkipReason === null) {
      if (typeof pi.sendMessage !== "function") {
        replaySkipReason = "this pi build exposes no message verb, so the retry cannot be steered";
      } else {
        try {
          pi.sendMessage(
            { customType: `${entryTypePrefix}-overflow-recovery`, content: notice },
            { deliverAs: "steer" },
          );
          replayed = true;
        } catch (error) {
          replaySkipReason = `the recovery notice could not be queued (${String(error)})`;
        }
      }
    }
    if (!replayed) safeNotify(ctx, notice, "warning");
    const record = emit("context.rollback", {
      trigger: "session_before_compact",
      armed: true,
      disarm_reason: null,
      error_entry_id: errorEntry.id,
      old_leaf_id: typeof oldLeafId === "string" ? oldLeafId : null,
      new_leaf_id: errorEntry.parentId,
      entries_abandoned: abandoned.length,
      occupancy_tokens_before: occupancyBefore,
      tokens_rolled_back: estimatedTokens(rolledBackBytes),
      replayed,
      replay_skip_reason: replaySkipReason,
      notice_chars: notice.length,
      attempt_ordinal: rollback.attempts,
      probes_passed: true,
    });
    rollback.last = {
      seq: record.seq,
      errorEntryId: errorEntry.id,
      newLeafId: errorEntry.parentId,
      entriesAbandoned: abandoned.length,
      tokensRolledBack: estimatedTokens(rolledBackBytes),
      replayed,
      replaySkipReason,
      noticeChars: notice.length,
      attemptOrdinal: rollback.attempts,
    };
    // The tree moved, so the mapping is rebuilt from it. THEN the fold is armed for the
    // retried pass, in that order: a reload clears the recovery flags, and arming before
    // it would hand the retry a cleared one. The guards are waived in that pass because
    // a request that already did not fit has nothing left to economize.
    load(ctx, true);
    curation.pendingRejection = { status: 400, ordinal: currentOrdinal() };
  };

  pi.on("session_before_compact", (event: Record<string, unknown>, ctx: any) => {
    const reason = ownValue(event, "reason");
    // The overflow reason is a provider rejection pi is prepared to retry, and it is
    // the rollback lane's trigger. Threshold and manual compaction are unchanged.
    if (reason === "overflow" && ownValue(event, "willRetry") === true) {
      nativeCompaction.lastThresholdDecision = {
        handled: true,
        retry: true,
        reason: `provider input overflow; ${contextBrand(brandNoun)} rolled the session tree back instead`,
        compactionReason: reason,
        nativeCompactionCompleted: false,
      };
      try { recoverFromOverflow(event, ctx); }
      catch (error) { suspendAutomatic(error, "overflow-rollback", ctx); }
      try { updateStatus(ctx); } catch { /* Recovery must survive presentation failure. */ }
      return { cancel: true };
    }
    if (reason === "manual") {
      nativeCompaction.lastThresholdDecision = {
        handled: false,
        retry: false,
        reason: "manual native compaction explicitly requested by the user",
        compactionReason: reason,
      };
      try { updateStatus(ctx); } catch { /* Manual rescue must survive presentation failure. */ }
      return undefined;
    }
    nativeCompaction.lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: `blocked stock automatic compaction; ${contextBrand(brandNoun)} folding remains authoritative`,
      compactionReason: reason,
      nativeCompactionCompleted: false,
    };
    return { cancel: true };
  });
  pi.on("agent_settled", async (_event: unknown, ctx: any) => {
    reportUnclaimedOverflow(ctx);
    if (ladder.pendingManual && persistence.persisted && ladder.boundaryFailure === null) {
      cancelPreparation();
      persistence.state = clone(persistence.persisted);
      ladder.pendingManual = false;
    }
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      startPreparation(snapshot, measurements.latestRatio, ctx);
    } catch {
      // The next authoritative context event will retry mapping.
    }
    try { await recoverNativeReceipts(ctx); }
    catch (error) { safeNotify(ctx, `Native compaction receipt recovery remains pending: ${String(error)}`, "error"); }
    updateStatus(ctx);
  });

  /**
   * Admission control. A refusal that names no next action is denial, not governance,
   * so every refusal carries at least one CONSTRUCTIBLE alternative: a bounded slice
   * sized to the headroom we actually have, a child fold that is smaller by
   * construction, and the commit that frees the room. The exact stored size of the
   * target is known, so this is arithmetic, not a guess.
   */
  const admit = (input: {
    action: "peek" | "expand";
    ctx: any;
    foldId: string;
    requestedBytes: number;
    children: string[];
  }): void => {
    const capacity = currentCapacity(input.ctx);
    const verdict = admissionVerdict({
      requestedBytes: input.requestedBytes,
      capacity,
      bytesPerToken: ESTIMATED_BYTES_PER_TOKEN,
    });
    if (verdict.admitted) return;
    const sliceBytes = Math.max(
      PEEK_MIN_SLICE_BYTES,
      Math.floor(verdict.affordableBytes * 0.9),
    );
    const alternatives: Array<Record<string, unknown>> = [];
    if (verdict.affordableBytes >= PEEK_MIN_SLICE_BYTES) {
      alternatives.push({ action: "peek", id: input.foldId, offset: 0, bytes: sliceBytes });
    }
    for (const child of input.children.slice(0, 3)) {
      alternatives.push({ action: "peek", id: child });
    }
    if (!alternatives.length) {
      // The floor: folding is always available, and it is the action that creates
      // the room this read needs.
      alternatives.push({ action: "status", detail: "fold_candidates" });
    }
    throw new Error(
      `${input.action} of ${input.foldId} needs ~${verdict.requestedTokens} tokens and only ` +
      `${verdict.headroomTokens} remain of the ${verdict.budgetTokens}-token budget; it was refused ` +
      "before it could cross the fence. Free room or read less: " +
      JSON.stringify(alternatives),
    );
  };

  const executeAction = async (
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: any,
  ): Promise<unknown> => {
    if (lifecycle.shuttingDown) throw new Error("Active-context runtime is shut down");
    if (!persistence.state) persistence.state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    const executionArgumentsSha256 = sha256Value(params);
    const action = String(params.action ?? "");
    if (!allowedToolActionSet.has(action)) {
      throw new Error(`${toolName} action '${action}' is not enabled in this runtime`);
    }
    if (action === "status" && !lifecycle.latestSnapshot) {
      return toolPayload({
        version: 1,
        service: "active-context-folding",
        available: false,
        contextEventError: lifecycle.latestSnapshotError ?? "No current same-session Pi context event has been observed",
      });
    }
    const snapshot = authoritativeSnapshotFor(ctx);
    if (action === "status") {
      const detail = ownValue(params, "detail");
      const details = ["fold_candidates", "tree", "folds", "objects"];
      if (detail !== undefined && !details.includes(String(detail))) {
        throw new Error(`status detail must be one of ${details.map((name) => `'${name}'`).join(", ")}`);
      }
      const statusOffset = boundedInteger(params.offset, 0, 0, 1_000_000, "offset");
      const statusLimit = boundedInteger(params.limit, 40, 1, 100, "limit");
      // Paging is explicit and agent-driven: the full tree is reachable, it just
      // stops riding along on every request that wanted a count.
      const paged = detail === "folds" || detail === "objects";
      const accounting = markAccounting(snapshot, persistence.state);
      return toolPayload(boundStatusPayload({
        ...activeContextStatus(
          snapshot,
          persistence.state,
          statusOffset,
          statusLimit,
          snapshot.policy.maxFoldSourceRefs,
          { diet: !paged },
        ),
        headroomTokens: currentCapacity(ctx).headroomTokens,
        budgetTokens: currentCapacity(ctx).budgetTokens,
        pendingMarks: accounting.pending,
        eligibleMarks: accounting.eligibleMarks,
        retainedMarks: accounting.retainedMarks,
        eligibleMarkedShare: accounting.eligibleFreedBudgetShare,
        markedShare: accounting.freedBudgetShare,
        available: true,
        automatic: {
          pressureRatio: measurements.latestRatio,
          // Status is a READ of the slate, never a delivery of one. `status` is a
          // read-only context action and the tool-batch safety scan is built on
          // read-only actions not writing durable state, so asking must not issue a
          // suggestion, spend the precision budget, or move a suppression counter. An
          // agent that asks gets the answer; only the push carriers are metered.
          surfacing: statusSurfacing(snapshot),
          refoldRatio: snapshot.policy.refoldRatio,
          chapterPrepareRatio: snapshot.policy.prepareRatio,
          hardFenceRatio: hardFenceRatio(snapshot),
          // The declared policy, reported. No action reads it back as a setting.
          thresholds: { ...snapshot.thresholds },
          zones: {
            staleBoundary: snapshot.staleBoundary,
            freshBoundary: snapshot.freshBoundary,
            budgetTokens: snapshot.budgetTokens,
          },
          // What THIS runtime withheld, which is nothing once the deployment declared an
          // already-net budget. One number, from the same accounting the fence divides by.
          responseReserve: currentCapacity(ctx).outputReservation,
          windowSource: snapshot.windowSource,
          capacity: {
            ...currentCapacity(ctx),
            bytesPerToken: projectionCharsPerToken(),
          },
          providerMeasurement: measurements.lastProviderMeasurement ? {
            tokens: measurements.lastProviderMeasurement.tokens,
            contextWindow: measurements.lastProviderMeasurement.contextWindow,
            messageSha256: measurements.lastProviderMeasurement.messageSha256,
            provider: measurements.lastProviderMeasurement.provider,
            model: measurements.lastProviderMeasurement.model,
          } : null,
          measurementFresh: Boolean(measurements.lastProviderMeasurement &&
            durableProviderMeasurementMatches(measurements.lastProviderMeasurement)),
          preparing: Boolean(ladder.preparing),
          preparedFoldId: persistence.state.prepared?.id ?? null,
          preparedSourceCount: persistence.state.prepared?.sourceRefs.length ?? null,
          pendingContextNote: ladder.pendingContextNote,
          lastCandidateId: ladder.lastPreparationCandidateId,
          lastPreparationError: ladder.lastPreparationError,
          boundaryFailure: ladder.boundaryFailure,
          lastSelectionKind: ladder.lastSelectionKind,
          lastSelectionSourceIds: ladder.lastSelectionSourceIds,
          lastAutomaticAction: ladder.lastAutomaticAction,
          overBudgetReduction: ladder.overBudgetReduction ? clone(ladder.overBudgetReduction) : null,
          curation: {
            occupancyThreshold: thresholds.maxTarget,
            signals: curation.lastSignals ? { ...curation.lastSignals } : null,
            contextCalls: curation.contextCalls,
            receipts: curation.receipts.map((receipt) => ({ ...receipt })),
          },
          recovery: {
            attempts: curation.recoveryAttempts,
            maxAttempts: OVERFLOW_RECOVERY_MAX_ATTEMPTS,
            pendingRejection: curation.pendingRejection ? { ...curation.pendingRejection } : null,
            last: curation.lastRecovery ? clone(curation.lastRecovery) : null,
            rollback: {
              armed: rollback.armed,
              probeFailures: rollback.probes ? [...rollback.probes.failures] : null,
              classifier: rollback.classifierSource,
              attempts: rollback.attempts,
              last: rollback.last ? clone(rollback.last) : null,
            },
          },
          foldSpanCap: MAX_FOLD_SPAN_CHARS,
          projectionBudgetTokens: currentCapacity(ctx).budgetTokens,
          projectionCharsPerToken: projectionCharsPerToken(),
          projectionEstimatorErrorShare: estimatorErrorShare(),
          projectionExpectedInflowTokens: expectedInflowTokens(),
          projectionMarginTokens: measurements.lastProjectedChars === null
            ? null
            : projectionMarginTokens(
              Math.ceil(measurements.lastProjectedChars / projectionCharsPerToken()),
              currentCapacity(ctx).window,
            ),
          projectionEstimatedTokens: measurements.lastProjectedChars === null
            ? null
            : Math.ceil(measurements.lastProjectedChars / projectionCharsPerToken()),
          automaticSuspended: ladder.automaticFailure !== null,
          automaticFailure: ladder.automaticFailure ? clone(ladder.automaticFailure) : null,
          lastCompactionDecision: nativeCompaction.lastThresholdDecision,
          scheduling: schedulingStatus({
            snapshot,
            state: persistence.state,
            ratio: measurements.latestRatio,
          }),
          nativeSummaries: "disabled",
          instrumentation: {
            enabled: true,
            ...ledgerSummary(instrumentation.ledger),
            projectionRecords: clone(instrumentation.ledger.records),
            cacheObservations: clone(instrumentation.ledger.observations),
            // THE stream, as the durable entries carry it. One shape, one convention.
            events: clone(instrumentation.ledger.events),
          },
          peek: {
            defaultMaxBytes: PEEK_DEFAULT_MAX_BYTES,
            lifetime: "append-only; the copy is reclaimed at the next commit unless pinned",
          },
          pressureSource: "last-successful-provider-response-only",
          postOverflowCallback: "blocked-while-stock-native-compaction-is-disabled",
          sameOperationRetry: false,
        },
        ...(detail === "fold_candidates" ? {
          candidates: foldCandidatesDetail(snapshot, persistence.state, measurements.latestRatio, {
            summarizerAvailable: Boolean(options.summarizeContextSpan),
            generation: lifecycle.generation,
            measurementFresh: Boolean(measurements.lastProviderMeasurement &&
              durableProviderMeasurementMatches(measurements.lastProviderMeasurement)),
            automaticFailure: ladder.automaticFailure !== null,
            preparing: Boolean(ladder.preparing),
            failedPreparationIds: ladder.failedPreparations,
          }),
        } : {}),
        ...(detail === "tree" ? { tree: foldTreeDetail(snapshot, persistence.state).slice(statusOffset) } : {}),
      }, typeof detail === "string" ? detail : null, statusOffset));
    }
    // Peeking or expanding a surfaced fold is the ACTED label, joined to the offer that
    // named it. It stays ephemeral: the ledger rides the next persisted state, never an
    // entry of its own, and the used/ignored grades land when the window closes.
    const noteSurfacingAccept = (id: string): void => {
      if (!persistence.state) return;
      persistence.state = noteSurfacingAction(persistence.state, id, markOrdinal(snapshot));
    };
    if (action === "peek") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("peek requires id");
      const offset = boundedInteger(params.offset, 0, 0, 1_000_000_000, "offset");
      // The DEFAULT is the bounded index view. Widening is an explicit argument, so
      // the default path cannot overfill a window: measured 2026-08-06, 14 raw peek
      // results held 1.9M characters, 82 percent of everything still unfolded.
      const sliceBytes = boundedInteger(
        params.bytes,
        PEEK_DEFAULT_MAX_BYTES,
        PEEK_MIN_SLICE_BYTES,
        snapshot.policy.maxChapterChars,
        "bytes",
      );
      const target = persistence.state.folds.find((item) => item.id === id);
      if (!target) throw new Error(`Unknown active-context fold ${id}`);
      admit({
        action: "peek",
        ctx,
        foldId: id,
        requestedBytes: Math.max(0, Math.min(sliceBytes, target.sourceChars - offset)),
        children: childFoldIds(target),
      });
      const payload = toolPayload(peekFoldSource({
        foldId: id,
        state: persistence.state,
        entries: ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch(),
        sessionId: ctx.sessionManager.getSessionId(),
        maximumBytes: sliceBytes,
        offset,
        toolName,
      }));
      noteSurfacingAccept(id);
      return payload;
    }
    if (action === "rebrief") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("rebrief requires id");
      const brief = typeof params.brief === "string" ? params.brief.trim() : "";
      if (!brief) throw new Error("rebrief requires a nonempty brief");
      if (brief.length > snapshot.policy.maxBriefChars) {
        throw new Error(`rebrief brief must be at most ${snapshot.policy.maxBriefChars} characters`);
      }
      const fold = requireActiveFold(snapshot, persistence.state, id);
      const previous = foldBrief(fold, persistence.state);
      const briefs = { ...(persistence.state.briefs ?? {}), [id]: brief };
      await persistManual({ ...persistence.state, revision: persistence.state.revision + 1, briefs }, action, ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        id,
        brief,
        previousBrief: previous,
        durableRevision: persistence.state.revision,
        activation: "the fold's placeholder, index rows and suggestions now carry your brief; " +
          "the exact source and its fold record are untouched.",
      });
    }
    if (action === "reboundary") {
      // One verb, both directions. `ids` names the span you want to BE one fold: every
      // fold overlapping it dissolves and the span is re-cut as one, which merges N
      // adjacent folds when the span covers them and splits one fold when the span sits
      // inside it. `id` alone is the plain dissolve, which returns a span to raw.
      if (params.ids !== undefined) {
        const requestedIds = stringIds(params.ids);
        const snapped = snapToFoldBoundaries(snapshot, persistence.state, requestedIds);
        const dissolvedIds = snapped.covered.map((item) => item.id);
        const briefs = { ...(persistence.state.briefs ?? {}) };
        for (const dissolvedId of dissolvedIds) delete briefs[dissolvedId];
        const leases = { ...persistence.state.leases };
        for (const dissolvedId of dissolvedIds) delete leases[dissolvedId];
        const dissolvedSet = new Set(dissolvedIds);
        const flattened: ActiveContextState = {
          ...persistence.state,
          revision: persistence.state.revision + 1,
          folds: deriveFoldParents(persistence.state.folds.filter((item) =>
            !dissolvedSet.has(item.id) && !dissolvedIds.some((rootId) =>
              descendantIds(persistence.state!, rootId).has(item.id)))),
          expanded: persistence.state.expanded.filter((expandedId) => !dissolvedSet.has(expandedId)),
          leases,
          ...(Object.keys(briefs).length ? { briefs } : {}),
        };
        if (!Object.keys(briefs).length) delete flattened.briefs;
        persistence.state = flattened;
        const supplied = typeof params.brief === "string" && params.brief.trim() ? params.brief : undefined;
        const recut = manualFoldCandidate(snapshot, persistence.state, snapped.ids, { allowProtected: true });
        const created: Array<Record<string, unknown>> = [];
        const correctedBriefs: Record<string, string> = {};
        for (const part of splitCandidateBySize(snapshot, persistence.state, recut)) {
          // A re-cut that lands back on a span this session already folded meets its own
          // immutable record. The record wins -- rewriting it would report a conflicting
          // durable fold and suspend automatic management -- and the supplied brief
          // becomes a correction beside it, which is what `rebrief` writes anyway.
          const durable = persistence.persistedFoldRecords.get(foldIdFor(part.kind, part.parts));
          const { preparedFold, nextState } = await prepareAndCommitExplicit({
            snapshot, candidate: part, brief: durable ? durable.fold.brief : supplied, ctx, signal,
          });
          persistence.state = nextState;
          if (durable && supplied) correctedBriefs[preparedFold.id] = supplied;
          created.push({
            id: preparedFold.id,
            kind: preparedFold.fold.kind,
            brief: supplied ?? preparedFold.fold.brief,
          });
        }
        if (Object.keys(correctedBriefs).length) {
          persistence.state = {
            ...persistence.state,
            briefs: { ...(persistence.state.briefs ?? {}), ...correctedBriefs },
          };
        }
        await persistManual(persistence.state, action, ctx);
        updateStatus(ctx);
        return toolPayload({
          version: 1,
          action,
          mode: dissolvedIds.length > 1 ? "merge" : "recut",
          dissolved: dissolvedIds,
          created,
          corrections: snapped.corrections,
          startId: snapped.ids[0],
          endId: snapped.ids[1],
          durableRevision: persistence.state.revision,
          activation: "durable immediately; the named span is now exactly one fold per bite-size cap, " +
            "and every dissolved fold's evidence is inside it or raw again.",
        });
      }
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("reboundary requires id, or ids naming the span to re-cut");
      const fold = requireActiveFold(snapshot, persistence.state, id);
      if (fold.parentId) {
        throw new Error(
          `Fold ${id} is nested under ${fold.parentId}; dissolve ${fold.parentId} first so ${id} is a root`,
        );
      }
      const refs = flattenFoldRefs(fold, persistence.state);
      const children = childFoldIds(fold);
      const briefs = { ...(persistence.state.briefs ?? {}) };
      delete briefs[id];
      const next: ActiveContextState = {
        ...persistence.state,
        revision: persistence.state.revision + 1,
        folds: deriveFoldParents(persistence.state.folds.filter((item) => item.id !== id)),
        expanded: persistence.state.expanded.filter((expandedId) => expandedId !== id),
        ...(Object.keys(briefs).length ? { briefs } : {}),
      };
      if (!Object.keys(briefs).length) delete next.briefs;
      const leases = { ...next.leases };
      delete leases[id];
      await persistManual({ ...next, leases }, action, ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        id,
        dissolved: true,
        releasedChildren: children,
        startId: refs[0]?.entryId ?? null,
        endId: refs.at(-1)?.entryId ?? null,
        durableRevision: persistence.state.revision,
        activation: `the span ${id} held is raw again and its boundary is yours to re-cut; ` +
          "fold the endpoints you meant, or two sub-spans to split it. No evidence moved.",
      });
    }
    if (action === "expand" || action === "refold") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error(`${action} requires id`);
      // An expand with marks pending opens the commit epoch: the restore and the
      // batch of folds then cost one rewrite between them instead of two.
      let epochApplied: unknown[] = [];
      if (action === "expand" && pendingMarks(persistence.state).length) {
        const result = await commitPendingMarks({
          snapshot,
          state: persistence.state,
          generation: lifecycle.generation,
          retainIneligible: true,
        });
        persistence.state = result.state;
        epochApplied = result.applied;
      }
      const expanding = requireActiveFold(snapshot, persistence.state, id);
      if (action === "expand") {
        admit({
          action: "expand",
          ctx,
          foldId: id,
          requestedBytes: Math.max(0, expanding.sourceChars - expanding.placeholderChars),
          children: childFoldIds(expanding),
        });
        noteSurfacingAccept(id);
      }
      let next = setFoldProjectionState(persistence.state, id, action === "expand" ? "expanded" : "folded");
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
        ...(epochApplied.length ? { committedMarks: epochApplied } : {}),
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "protect" || action === "unprotect") {
      const ids = stringIds(params.ids);
      const refsBefore = persistence.state.protected.length;
      const nextProtection = protectEvidence(snapshot, persistence.state, ids, action === "protect");
      if (action === "protect") {
        // The pin ceiling: protect is a promise to hold bytes raw through every fold,
        // and a promise with no mass bound can pin the window solid. The refusal is
        // corrective, not denial: it names the cap and the release valve.
        const capacity = servingCapacity(snapshot.contextWindow);
        const prospectiveShare = capacity.budgetTokens > 0
          ? estimatedTokens(explicitProtectedMass(snapshot, nextProtection).bytes) / capacity.budgetTokens
          : 0;
        if (prospectiveShare > MAX_PINNED_SHARE) {
          throw new Error(
            `protect refused: these pins would hold ${Math.round(prospectiveShare * 100)}% of the ` +
            `working window raw, past the ${Math.round(MAX_PINNED_SHARE * 100)}% pinned-share cap. ` +
            'Release earlier pins with {"action":"unprotect","ids":["<entry-id>"]} first; ' +
            "folding keeps entries exactly recoverable without pinning them.");
        }
      }
      await persistManual(nextProtection, action, ctx);
      const refsAfter = persistence.state.protected.length;
      emit("context.protect", {
        protect: action === "protect",
        ids: ids.join(","),
        id_count: ids.length,
        protected_refs_before: refsBefore,
        protected_refs_after: refsAfter,
      });
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        ids,
        protectedRefs: refsAfter,
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "unmark") {
      const ids = stringIds(params.ids);
      const requested = new Set(ids);
      const before = pendingMarks(persistence.state);
      const kept = before.filter((mark) => !requested.has(mark.id));
      const removed = before.filter((mark) => requested.has(mark.id));
      const unknown = ids.filter((id) => !before.some((mark) => mark.id === id));
      if (unknown.length) throw new Error(`No pending mark named ${unknown.join(", ")}`);
      await persistManual(withPendingMarks(persistence.state, kept), action, ctx);
      updateStatus(ctx);
      const accounting = markAccounting(snapshot, persistence.state);
      return toolPayload({
        version: 1,
        action,
        unmarked: removed.map((mark) => ({ mark: mark.mark, id: mark.id, origin: mark.origin })),
        pendingMarks: accounting.pending,
        eligibleMarks: accounting.eligibleMarks,
        retainedMarks: accounting.retainedMarks,
        durableRevision: persistence.state.revision,
        activation: "the withdrawn marks will never be applied; no context bytes moved",
      });
    }
    if (action === "fold") {
      // One call, several {span, brief} pairs. Marking is free and committing is not,
      // so the shape that should be cheapest to express is the BATCH: an agent that
      // must spend one call per span curates less than one that spends one call.
      const requested = batchedMarkRequests(params);
      const resolved: Array<{
        candidate: FoldCandidate;
        brief?: string;
        corrections: SpanCorrection[];
        splitFrom: number;
      }> = [];
      for (const request of requested) {
        const snapped = snapFoldCandidate(snapshot, persistence.state, request.ids, { allowProtected: true });
        const spanChars = candidateSpanChars(snapshot, persistence.state, snapped.candidate);
        const parts = splitCandidateBySize(snapshot, persistence.state, snapped.candidate);
        for (const [index, part] of parts.entries()) {
          resolved.push({
            candidate: part,
            brief: request.brief,
            corrections: index === 0
              ? [
                ...snapped.corrections,
                ...(parts.length > 1
                  ? [{
                    from: request.ids,
                    to: [],
                    reason: `span was ${spanChars} chars, over the ${MAX_FOLD_SPAN_CHARS}-char bite-size cap; ` +
                      `split into ${parts.length} sequential folds, each with its own brief`,
                  }]
                  : []),
              ]
              : [],
            splitFrom: parts.length > 1 && index === 0 ? spanChars : 0,
          });
        }
        if (parts.length > 1) {
          emit("context.split", {
            source: "agent",
            span_chars: spanChars,
            parts: parts.length,
            cap_chars: MAX_FOLD_SPAN_CHARS,
            fold_ids: "",
          });
        }
      }
      const corrections = resolved.flatMap((item) => item.corrections);
      // Resolve every brief now, while the source is in hand, so the commit epoch
      // itself stays deterministic and free of provider calls. A span that is not
      // eligible YET cannot go through preparation at all, so it takes the
      // deterministic brief: the mark is a decision, and refusing to record it
      // because the span is momentarily fresh is exactly the drop being fixed.
      const marks: Array<Record<string, unknown>> = [];
      let staged = persistence.state;
      for (const item of resolved) {
        const { candidate } = item;
        // ACCEPT AND HOLD. A span that is still fresh or protected is not a refusal:
        // the mark is a standing decision, it is recorded now, and it folds at the
        // first commit after the span ages out. Refusal is reserved for a mark that
        // cannot be constructed at all.
        // A REPEATED DECISION IS INERT. The fold id is derived from the span, so a
        // span the ladder already prepared carries that exact id in the forest
        // already, and preparing it a second time throws "Prepared fold already
        // exists" out of the tool call. Under the old cadence commits were frequent
        // enough to drain prepared folds before a second decision could land on one;
        // the quiet runtime commits far less often, so the collision became reachable
        // in ordinary use -- the ladder marks a span, the agent then folds the same
        // span, and the agent's call fails. Marking is a standing decision about a
        // span, and deciding the same thing twice has to be a no-op.
        const alreadyPrepared = staged.folds.some((fold) =>
          fold.id === foldIdFor(candidate.kind, candidate.parts));
        const deferred = refsProtected(candidate.sourceRefs, staged, snapshot) ||
          (candidate.kind === "tool-result" &&
            toolRefsProtected(candidate.sourceRefs, staged, snapshot));
        const briefed = !deferred && !alreadyPrepared
          ? await prepareFold({
            candidate,
            snapshot,
            state: staged,
            generation: lifecycle.generation,
            brief: item.brief,
            summarize: options.summarizeContextSpan,
            ctx,
            signal,
          })
          : null;
        const mark = foldMarkFor({
          candidate,
          brief: briefed?.fold.brief ?? item.brief ?? ladderBrief(snapshot, staged, candidate),
          briefProvenance: briefed?.fold.provenance ??
            (item.brief ? { kind: "supplied" } : { kind: "deterministic" }),
          origin: "agent",
          ordinal: markOrdinal(snapshot),
        });
        const addition = addPendingMark(staged, mark);
        if (!addition.added) {
          marks.push({ id: mark.id, kind: mark.kind, ok: false, deferred: false, reason: addition.reason });
          continue;
        }
        staged = addition.state;
        marks.push({
          id: mark.id,
          kind: mark.kind,
          ok: true,
          deferred,
          ...(deferred
            ? {
              scheduled: "the span is still in the fresh window; this mark is held and folds at the " +
                "first commit after it ages out",
            }
            : {}),
          brief: mark.brief,
          provenance: normalizeLegacyProvenance(mark.briefProvenance),
        });
      }
      await persistManual(staged, action, ctx);
      updateStatus(ctx);
      const accounting = markAccounting(snapshot, persistence.state);
      // MECHANISM 3. The projection is byte-frozen between fold events, so this reply
      // is the only cache-free channel left: it carries the whole picture, not just
      // an acknowledgement of the spans this call named.
      const held = pendingMarks(persistence.state).map((mark) => ({
        id: mark.id,
        kind: mark.kind,
        tokens: estimatedTokens(markFreedBytes(snapshot, persistence.state!, mark)),
      }));
      const remainder = unmarkedRemainder(snapshot, persistence.state, projectionCharsPerToken());
      // The single-span shape is the head of the batched one: one call carrying one
      // span answers exactly as it always did, and a batch adds fields rather than
      // replacing them.
      const only = marks.length === 1 && marks[0].ok === true ? marks[0] : null;
      return toolPayload({
        version: 1,
        action,
        scheduling: "epoch",
        ok: marks.some((mark) => mark.ok === true),
        deferredMarks: marks.filter((mark) => mark.deferred === true).length,
        ...(only
          ? {
            id: only.id,
            kind: only.kind,
            brief: only.brief,
            provenance: only.provenance,
            deferred: only.deferred,
            ...(only.scheduled ? { scheduled: only.scheduled } : {}),
          }
          : {}),
        marks,
        // Never silently reinterpreted: a span the runtime moved says so, here.
        corrections,
        argumentsSha256: executionArgumentsSha256,
        durableRevision: persistence.state.revision,
        pendingMarks: accounting.pending,
        eligibleMarks: accounting.eligibleMarks,
        retainedMarks: accounting.retainedMarks,
        estimatedFreedWindowShare: accounting.freedBudgetShare,
        estimatedEligibleWindowShare: accounting.eligibleFreedBudgetShare,
        estimatedRewriteTokens: accounting.rewriteTokens,
        held,
        heldNote: "held until it ages out or the next fold event",
        unmarkedSpans: remainder.spans,
        unmarkedTokens: remainder.tokens,
        unmarkedShare: remainder.share,
        unmarkedCandidates: remainder.candidates,
        // The acknowledgement rides the tool result, so it PERSISTS in context the way
        // every tool result does. Default on;
        // `guidance.actionResponses: false` returns the accounting without the prose.
        ...(guidance.actionResponses ? {
          awareness: markAwarenessText({ held, remainder, toolName, brandNoun }),
          activation: "accepted as pending marks; no context bytes moved, and nothing else in your " +
            "context changed either. They apply together at the next commit epoch, which the runtime " +
            "opens at the fold event. " +
            "A mark over a still-fresh span is held, not refused: it is scheduled, and it folds at the " +
            "first commit after that span ages out of the fresh window. " +
            "Mark several spans in one call: this whole picture comes back with each one.",
        } : {}),
      });
    }
    throw new Error(`Unknown ${toolName} action '${action}'`);
  };
  /**
   * Every context-management call, accepted AND refused, in the durable stream.
   *
   * A rejected call is the more informative of the two: an agent whose spans keep being
   * refused looks identical, from fold records alone, to an agent that never tried to
   * curate at all. The exact validation text is recorded verbatim, because "it failed"
   * is not a finding and "ids must contain 1-64 values" is.
   */
  const requestedMarkCount = (params: Record<string, unknown>): number => {
    const batched = denseOwnArrayValues(params?.marks);
    if (batched) return batched.length;
    return params?.ids === undefined && params?.id === undefined ? 0 : 1;
  };

  const toolHandler = async (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    _onUpdate: unknown,
    ctx: any,
  ): Promise<unknown> => {
    const operation = ladder.actionQueue.then(async () => {
      const action = String(params?.action ?? "");
      // The gate's engagement signal, counted BEFORE the call can fail: an agent that
      // reached for a context verb engaged, whether or not the span was valid.
      curation.contextCalls += 1;
      const attempt = (ok: boolean, error: string | null, corrections: Array<Record<string, unknown>>) => {
        const record = emit("context.attempt", {
          action,
          ok,
          error,
          // The join key against the worker's own tool-call log: one logical row per
          // model-emitted invocation, matched by id and never by order or clock.
          tool_call_id: toolCallId,
          marks_requested: requestedMarkCount(params),
          corrections_applied: corrections.length,
          arguments_sha256: sha256Value(params ?? {}),
        });
        // One record per correction, referencing its attempt: nothing nests, and a
        // reader counting corrections never has to unpack an array to do it.
        for (const correction of corrections) {
          const from = denseOwnArrayValues(ownValue(correction, "from")) ?? [];
          const to = denseOwnArrayValues(ownValue(correction, "to")) ?? [];
          emit("context.correction", {
            attempt_seq: record.seq,
            action,
            requested_start_id: from[0] ?? null,
            requested_end_id: from[1] ?? null,
            corrected_start_id: to[0] ?? null,
            corrected_end_id: to[1] ?? null,
            reason: ownValue(correction, "reason") ?? null,
          });
        }
      };
      try {
        const result = await executeAction(params, signal, ctx);
        const corrections = denseOwnArrayValues(ownValue(ownValue(result, "details"), "corrections"));
        attempt(true, null, (corrections ?? []) as Array<Record<string, unknown>>);
        return result;
      } catch (error) {
        attempt(false, error instanceof Error ? error.message : String(error), []);
        throw error;
      }
    });
    ladder.actionQueue = operation.catch(() => undefined);
    return operation;
  };
  const statusCommandHandler = async (_args: string, ctx: any): Promise<void> => {
    if (!persistence.state) persistence.state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      const status = activeContextStatus(snapshot, persistence.state, 0, 40);
      safeNotify(
        ctx,
        `Active context: ${status.totalFolds} fold(s), roots ${(status.roots as string[]).join(", ") || "none"}. ` +
          `Use ${toolName} status for exact recursive actions.`,
        "info",
      );
    } catch (error) {
      safeNotify(ctx, `Active-context status unavailable; native Pi context is unchanged: ${String(error)}`, "warning");
    }
  };
  const foldCommandHandler = async (args: string, ctx: any): Promise<void> => {
    const operation = ladder.actionQueue.then(async () => {
      if (!persistence.state) persistence.state = emptyActiveContextState(ctx.sessionManager.getSessionId());
      const snapshot = lifecycle.latestSnapshot
        ? authoritativeSnapshotFor(ctx)
        : snapshotForEvent(ctx, ctx.sessionManager.buildSessionContext().messages);
      if (!lifecycle.latestSnapshot) lifecycle.latestSnapshot = snapshot;
      const divider = args.indexOf(" -- ");
      const selector = (divider >= 0 ? args.slice(0, divider) : args).trim();
      // THE USER COMMIT. One word, and the only commit verb any caller has: the model
      // tool still has no commit action, because a verb the runtime is entitled to
      // overrule is surface without function. A user is not overruled.
      //
      // Below maxTarget it applies the eligible marks in hand and stops -- no automatic
      // top-up, because the user asked to bank the curation they made, not to have the
      // runtime pick more. At or above maxTarget it is the ordinary event: the planner
      // may top up toward minTarget. Neither path touches freshness, pins, exactness or
      // the provider fence.
      if (selector === "commit") {
        const capacity = servingCapacity(snapshot.contextWindow);
        const occupancy = capacity.usedTokens !== null && capacity.budgetTokens > 0
          ? capacity.usedTokens / capacity.budgetTokens
          : null;
        const topUp = occupancy !== null && occupancy >= thresholds.maxTarget;
        const committed = await runCommitEpoch(snapshot, "user-command", topUp, measurements.latestRatio, true);
        try { await persist(ctx); } catch { /* The commit already reported its own outcome. */ }
        updateStatus(ctx);
        safeNotify(
          ctx,
          committed
            ? `Committed ${ownValue(committed, "applied_marks") ?? 0} mark(s)${topUp ? " with automatic top-up" : ""}. ` +
              "Exact source remains expandable."
            : "Nothing eligible to commit: no pending mark is outside the fresh tail.",
          "info",
        );
        return;
      }
      const supplied = (divider >= 0 ? args.slice(divider + 4) : "").trim() || undefined;
      const ids = selector ? selector.replace(/\.\./g, " ").split(/[\s,]+/).filter(Boolean) : [];
      const candidate = ids.length
        ? manualFoldCandidate(snapshot, persistence.state!, ids)
        : selectAutomaticChapter(snapshot, persistence.state!) ?? selectAutomaticToolBatch(snapshot, persistence.state!)[0] ?? null;
      if (!candidate) throw new Error("No exact stale rescue span is currently eligible");
      const stateBefore = persistence.state!;
      const persistedBefore = persistence.persisted ? clone(persistence.persisted) : null;
      const generationBefore = lifecycle.generation;
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
      persistence.state = nextState;
      try { await persist(ctx); }
      catch (error) {
        if (sessionIdentityStillValid(ctx, stateBefore.sessionId, generationBefore)) {
          persistence.state = stateBefore;
          persistence.persisted = persistedBefore;
        }
        throw error;
      }
      ladder.pendingManual = false;
      ladder.automaticFailure = null;
      ladder.pendingContextNote =
        `User rescue folded stale context under ${preparedFold.id}; exact source remains expandable.`;
      ladder.lastAutomaticAction = {
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
    ladder.actionQueue = operation.catch(() => undefined);
    try { await operation; }
    catch (error) {
      safeNotify(ctx, `Context rescue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  pi.registerTool(buildActiveContextTool({
    name: toolName,
    label: toolLabel,
    allowedActions: allowedToolActions,
    fullSurface: true,
    maxBriefChars: ACTIVE_CONTEXT_POLICY.maxBriefChars,
    statusDetails: ["fold_candidates", "tree", "folds", "objects"],
    minPeekSliceBytes: PEEK_MIN_SLICE_BYTES,
    defaultPeekBytes: PEEK_DEFAULT_MAX_BYTES,
    handler: toolHandler,
  }));
  for (const command of buildActiveContextCommands({
    statusName: commandNames.status,
    foldName: commandNames.fold,
    statusHandler: statusCommandHandler,
    foldHandler: foldCommandHandler,
  })) {
    pi.registerCommand(command.name, {
      description: command.description,
      handler: command.handler,
    });
  }
  pi.on("session_shutdown", (_event: unknown, ctx: any) => {
    lifecycle.generation += 1;
    lifecycle.shuttingDown = true;
    cancelPreparation();
    persistence.state = null;
    persistence.persisted = null;
    lifecycle.latestSnapshot = null;
    curation.receipts = [];
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { /* Shutdown cannot be blocked by UI. */ }
  });

  return { projectionCandidates };
}
