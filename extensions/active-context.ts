import {
  denseOwnArrayValues,
  evidenceSha256,
  objectRefKey,
  sha256Value,
  stableStringify,
} from "./json.ts";
import {
  contentText,
  bytes,
  clone,
  emptyActiveContextState,
  ownValue,
  serializedPrefixHolds,
  sessionEntryMessages,
  uniqueMessageDigestAnchor,
} from "./lib/canonical.ts";
import {
  activeContextStatus,
  automaticPreparationId,
  boundStatusPayload,
  briefContractComplaint,
  commitPreparedFold,
  descendantIds,
  encodedFoldSource,
  foldCandidatesDetail,
  foldIndexRow,
  foldTreeDetail,
  peekFoldSource,
  prepareFold,
  projectActiveContext,
  projectionSlateCandidates,
  protectEvidence,
  requireActiveFold,
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
  imageMass,
  latestProviderContextMeasurement,
  orderedRoots,
  parseNativeCompactionCompletion,
  exactMapped,
  parseNativeCompactionDecision,
  parseProviderContextMeasurementReceipt,
  persistenceProjection,
  protectedStaleMass,
  providerContextMeasurement,
  providerTokens,
  refsProtected,
  stringIds,
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
  foldIdFor,
  foldRecordRef,
  makeFoldRecordEntry,
  makeStateCheckpoint,
  makeStateDelta,
  MAX_ACTIVE_FOLD_RECORDS,
  materializeStatePersistence,
  foldProvenance,
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
  UNBRIEFED_FOLDS_BEFORE_NOTICE,
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES,
  DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
  DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  COMMIT_RECLAIM_FLOOR_SHARE,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_CONTEXT_WINDOW,
  assertThresholdsServable,
  resolveThresholds,
  servingBudgetTokens,
  ESTIMATED_BYTES_PER_TOKEN,
  IMAGE_ESTIMATED_TOKENS,
  entryTypeNamespace,
  MAX_FOLD_SPAN_CHARS,
  DEFAULT_TOOL_FOLD_THRESHOLD,
  MAX_PINNED_SHARE,
  PEEK_DEFAULT_MAX_BYTES,
  peekIsEphemeral,
  PEEK_MIN_SLICE_BYTES,
  PEEK_READ_ONLY_CONTEXT_ACTIONS,
  RETIRED_TOOL_ACTIONS,
  AUTO_FOLD_BLACKLIST_DEFAULT,
  USER_RESCUE_MAX_SOURCE_CHARS,
} from "./lib/policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveContextThresholds,
  ActiveContextToolAction,
  BriefProvenance,
  FoldCandidate,
  FoldKind,
  FoldRecordEntry,
  PreparedFold,
} from "./lib/policy.ts";
import {
  absorbWedgeMarks,
  markSpanRefs,
} from "./lib/scheduling.ts";
import {
  contextReceipt,
  foldNoticeText,
  foldStatusText,
  receiptBlockText,
  withReceipt,
} from "./lib/curation.ts";
import type {
  ContextReceipt,
} from "./lib/curation.ts";
import {
  addPendingMark,
  commitCoverage,
  windowClaims,
  commitPendingMarks,
  toolClipAdditions,
  consolidationMarks,
  ephemeralPeekMarks,
  epochCommitDue,
  estimatedTokens,
  foldMarkFor,
  ladderBrief,
  markAccounting,
  markRewriteTokens,
  markFreedBytes,
  unmarkedRemainder,
  markClaimingRef,
  markOrdinal,
  pendingMarks,
  refoldMarks,
  schedulingStatus,
  topUpMarks,
  frontierMarks,
  withPendingMarks,
} from "./lib/scheduling.ts";
import {
  manualFoldCandidate,
  peekedSourceFoldIds,
  snapFoldCandidate,
  snapToFoldBoundaries,
  spanBytes,
} from "./lib/selection.ts";
import type { SpanCorrection } from "./lib/selection.ts";
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
import { buildFoldEditorData, FoldEditorView } from "./lib/editor-ui.ts";
import { publishLiveSettings } from "./lib/live-settings.ts";
import {
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

export type ProjectionReadingBasis = "anchored" | "rewritten" | "unmeasured";

export * from "./lib/canonical.ts";
export * from "./lib/curation.ts";
export * from "./lib/folding.ts";
export * from "./lib/instrumentation.ts";
export * from "./lib/live-settings.ts";
export * from "./lib/measurement.ts";
export * from "./lib/persistence.ts";
export * from "./lib/policy.ts";
export * from "./lib/rollback.ts";
export * from "./lib/scheduling.ts";
export * from "./lib/selection.ts";
export * from "./lib/transcript.ts";

/**
 * The two independent scalars, resolved in ONE place because they are resolved TWICE:
 * once from the registration options and once from every /fold-settings edit that
 * reaches the running session. Absent means the package default in both directions,
 * which is the settings file's own law, and the refusal text is the same sentence
 * wherever the bad value came from.
 */
function resolvedPostFoldNotice(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("postFoldNotice must be a boolean: true keeps the post-fold invitation " +
      "notice, false ships every fold with the runtime's deterministic brief and no " +
      "carrier inviting the agent to improve it");
  }
  return value ?? false;
}

function resolvedToolFoldThreshold(value: unknown): number {
  const resolved = value ?? DEFAULT_TOOL_FOLD_THRESHOLD;
  if (typeof resolved !== "number" || !Number.isFinite(resolved) ||
      resolved < 0 || resolved >= 1) {
    throw new Error("toolFoldThreshold must be a share in [0, 1): it names the oldest " +
      "fraction of the projected window whose tool results are clipped in view at each " +
      "commit, and 0 turns the diet off");
  }
  return resolved;
}

export function registerActiveContext(pi: any, options: {
  toolName?: string;
  toolLabel?: string;
  brandNoun?: string;
  entryTypePrefix?: string;
  commandNames?: { status?: string; fold?: string };
  blacklistAutoFoldTools?: ReadonlySet<string>;
  providerInputBudget?: number;
  thresholds?: ActiveContextThresholds;
  /** THE TOOL-CALL DIET's share point (2026-08-24; default 0.50 since 2026-08-28, Shane,
   *  on the sol-20260826-full2 verdict): tool results in the oldest toolFoldThreshold
   *  share of the projected window are clipped IN VIEW at each commit, identified head
   *  kept, full bytes peek-recoverable behind the entry id the marker names. A share in
   *  [0, 1), where 0 turns the diet off; 0.50 is what every fold repetition from 3 onward
   *  ran, so the default is the value that was measured rather than the absence of one. */
  toolFoldThreshold?: number;
  /** THE INVITATION SWITCH (public since 2026-08-27; DEFAULT FALSE since 2026-08-28,
   *  Shane, on the sol-20260826-full2 verdict). false is the deterministic shape the
   *  campaign measured and the one it recommends: no carrier ever invites a brief and
   *  every fold goes out with the runtime's own words, which drew 14, 14, 9 and 8 correct
   *  against the invited condition's 3. true restores the standing invitation for the
   *  agent to improve a brief. Either way the agent verbs stay on the tool, so an agent
   *  that finds a fold can still annotate what it reads. */
  postFoldNotice?: boolean;
}): {
  projectionCandidates: (ctx: any) => Array<Record<string, unknown>>;
} {
  const toolName = options.toolName ?? DEFAULT_ACTIVE_CONTEXT_TOOL_NAME;
  const toolLabel = options.toolLabel ?? DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL;
  const brandNoun = options.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN;
  const entryTypePrefix = options.entryTypePrefix ?? DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
  const blacklistAutoFoldTools = options.blacklistAutoFoldTools ?? AUTO_FOLD_BLACKLIST_DEFAULT;
  // THESE THREE ARE THE SETTINGS SURFACE, AND THEY ARE NOT CONSTANTS (2026-08-29). Each
  // was resolved once here and read from the closure ever after, so a person editing
  // /fold-settings changed the file and nothing else while the session kept the values
  // pi booted with. They are `let` so the live applier published below can replace them,
  // and every reader takes the variable rather than a copy, so a swap reaches the next
  // snapshot, the next commit decision and the status line without anything else moving.
  let postFoldNotice = resolvedPostFoldNotice(options.postFoldNotice);
  let toolFoldThreshold = resolvedToolFoldThreshold(options.toolFoldThreshold);
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
  for (const removed of ["setProjectionProvider", "setSuggestionSourceRegistrar"]) {
    if (Object.hasOwn(options, removed)) {
      throw new Error(`${removed} is no longer an option: projection candidates are returned by ` +
        "registration, and external suggestion sources have no carrier to render into");
    }
  }
  for (const inverted of ["readOnlyTools", "autoFoldableTools"]) {
    if (Object.hasOwn(options, inverted)) {
      throw new Error(`${inverted} is now blacklistAutoFoldTools, and the sense is INVERTED: ` +
        "every completed tool batch folds unmarked, and the list names the exceptions whose " +
        "results must stay raw. An allow-list moved across verbatim would bar exactly the " +
        "tools it meant to permit");
    }
  }
  if (Object.hasOwn(options, "guidance")) {
    throw new Error("guidance is no longer an option: it switched the copy that taught the " +
      "agent to CHOOSE SPANS, and the agent does not choose spans. The runtime cuts at the " +
      "frontier and the agent annotates what it cut, so the guidance it switched has been " +
      "replaced wholesale by the post-fold notice, which is not optional because a fold the " +
      "agent is never told about is one it can never brief");
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
  let thresholds = resolveThresholds(options.thresholds);
  assertThresholdsServable(thresholds, providerInputBudget ?? servingBudgetTokens(DEFAULT_CONTEXT_WINDOW));
  const stateEntryType = `${entryTypePrefix}-state`;
  const foldRecordEntryType = `${entryTypePrefix}-fold-record`;
  const milestoneProjectionType = `${entryTypePrefix}-milestone`;
  const advisoryProjectionType = `${entryTypePrefix}-advisory`;
  const foldNoticeProjectionType = `${entryTypePrefix}-fold-notice`;
  const receiptProjectionType = `${entryTypePrefix}-receipts`;
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

  const persistence = {
    state: null as ActiveContextState | null,
    persisted: null as ActiveContextState | null,
    persistedWireVersion: 0 as 0 | 1 | 2,
    persistedStateSha256: "",
    persistedFoldRecords: new Map<string, FoldRecordEntry>(),
    persistenceQueue: Promise.resolve<void>(undefined),
  };

  const ladder = {
    /** The provider measurement the last band-top commit ran against; one commit per one. */
    bandTopMeasurement: null as unknown,
    /** The snapshot-and-state key whose frontier scan came back empty; see advanceFoldFrontier. */
    frontierEmptyKey: null as string | null,
    pendingManual: false,
    preparing: null as { id: string; controller: AbortController; promise: Promise<void> } | null,
    lastPreparationError: null as string | null,
    boundaryFailure: null as string | null,
    lastPreparationCandidateId: null as string | null,
    lastSelectionKind: null as FoldKind | "refold" | null,
    lastSelectionSourceIds: [] as string[],
    pendingContextNote: null as string | null,
    lastAutomaticAction: null as Record<string, unknown> | null,
    overBudgetReduction: null as Record<string, unknown> | null,
    automaticFailure: null as AutomaticFailureState | null,
    actionQueue: Promise.resolve<unknown>(undefined),
  };

  const measurements = {
    latestRatio: null as number | null,
    lastProviderMeasurement: null as ProviderContextMeasurement | null,
    descriptorWindow: null as number | null,
    lastProjectedChars: null as number | null,
    lastProjectedImages: 0,
    projectionCalibrations: [] as Array<{ chars: number; tokens: number }>,
    lastProjectedEstimate: null as number | null,
    lastProjectedEstimateCalibrated: false,
    lastProjectedEstimateBasis: "unmeasured" as ProjectionReadingBasis,
    lastProjectedSizeTokens: null as number | null,
    projectionAnchor: null as {
      tokens: number;
      chars: number;
      /** `chars` less the base64 of any image, which is what the delta is taken on. */
      textChars: number;
      /** Images inside the anchored prefix, each worth IMAGE_ESTIMATED_TOKENS. */
      images: number;
      head: string;
      messageSha256: string;
      sessionId: string;
      generation: number;
    } | null,
    estimatorErrors: [] as number[],
    inflowSteps: [] as number[],
    wallInflowSteps: [] as number[],
    providerMeasurementQueue: Promise.resolve<void>(undefined),
    providerMeasurementReceipts: new Set<string>(),
    providerMeasurementRevisionByMessageSha: new Map<string, number>(),
    providerMeasurementByMessageSha: new Map<string, ProviderContextMeasurementReceipt>(),
    providerMeasurementAnchorByMessageSha: new Map<string, ProviderMeasurementAnchor>(),
  };

  const instrumentation = {
    ledger: emptyLedger(),
    previousDigests: null as string[] | null,
    previousText: null as string | null,
    // The image mass of `previousText`, kept beside it because the provider anchor is
    // built from that text and has no access to the array it came from.
    previousImages: 0,
    previousImageChars: 0,
    lastChange: "append" as ProjectionChange,
    lastPreservedShare: null as number | null,
    sinceHandoff: [] as Array<{
      seq: number;
      kind: string;
      action?: string;
      ok?: boolean;
    }>,
    mutationsSinceHandoff: 0,
    requests: 0,
    lastMutationRequest: 0,
    lastMutationTokens: null as number | null,
    // WHAT THE SESSION SPENDS DERIVING ITSELF, cumulative for the process.
    //
    // Every lifecycle event remaps the whole branch, so the cost of a turn is not the
    // cost of one derivation: it is however many the handlers happen to run. Measuring
    // it at the two entry points and carrying the running totals on the projection means
    // a consumer differences consecutive projections for the per-request cost and reads
    // the last one for the exact session total. That is a SUM. The alternative, taking
    // one terminal derivation and multiplying by the request count, treats every early
    // request as though the session were already at its final size, which is invalid
    // precisely when growth is the thing under study.
    //
    // These are process counters, not state. A rollback does not return the CPU, so they
    // do not roll back either.
    derivations: 0,
    deriveMs: 0,
    derivationHits: 0,
  };
  const freeze = {
    body: null as unknown[] | null,
    bodyText: null as string | null,
    projection: null as unknown[] | null,
    keys: new Set<string>(),
    active: false,
  };
  const carrierAdmitted = (key: string): boolean => {
    if (freeze.active && freeze.keys.has(key)) return false;
    freeze.keys.add(key);
    return true;
  };

  const curation = {
    receipts: [] as ContextReceipt[],
    contextCalls: 0,
    wallEpisodeOpen: false,
    recoveryAttempts: 0,
    pendingRejection: null as { status: number; ordinal: number } | null,
    lastRecovery: null as Record<string, unknown> | null,
    instrumentationQueue: Promise.resolve<void>(undefined),
  };

  const rollback = {
    probes: null as ReturnType<typeof probeRollbackSurfaces> | null,
    armed: false,
    classifier: null as ((message: unknown, contextWindow: number) => boolean) | null,
    classifierSource: null as string | null,
    attempts: 0,
    last: null as Record<string, unknown> | null,
    pendingOverflow: null as { at: number; entryId: string | null } | null,
  };

  // EPHEMERAL PEEK (Build 4b): tool call ids whose peek asked for one-read
  // visibility. In-memory ON PURPOSE: a restart forgets the registry and the
  // result stays durable, which is the safe default, and the durable entry
  // always keeps the exact bytes, so folding, peek and rollback read the
  // source unchanged whatever the projection shows.
  const ephemeralPeeks = new Set<string>();

  const nativeCompaction = {
    lastThresholdDecision: null as Record<string, unknown> | null,
    pendingNativeReceipt: null as NativeCompactionCompletionReceipt | null,
    nativeReceiptQueue: Promise.resolve<void>(undefined),
  };

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
   * ONE DERIVATION PER DISTINCT BRANCH, WITHIN ONE PASS.
   *
   * A lifecycle pass asks for the authoritative snapshot repeatedly: the fence asks, the
   * ladder asks, the accounting asks, the status surface asks. Instrumented on a fixture,
   * a single request cost up to TEN derivations, and a derivation remaps the entire
   * branch. On sol-20260813-paired rep 2 one of those cost 18.5 seconds.
   *
   * The memo is deliberately the SMALLEST one that is airtight rather than the largest
   * one that would pay. It lives for exactly one pass and is dropped at the start of the
   * next, so nothing it holds can outlive the moment it was true. Within a pass the only
   * way the branch changes is by APPENDING, which moves a length, so keying on the two
   * lengths and the window catches every change that can occur. A cache that had to
   * reason about entries being replaced underneath it would be the kind of guard this
   * project does not keep; this one cannot face that question.
   */
  const derivationMemo = {
    key: null as string | null,
    snapshot: null as ActiveContextSnapshot | null,
  };
  const dropDerivationMemo = (): void => {
    derivationMemo.key = null;
    derivationMemo.snapshot = null;
  };

  const beginMutationPass = (): void => {
    instrumentation.mutationsSinceHandoff = 0;
    dropDerivationMemo();
  };

  const emit = (kind: ContextEventKind, payload: Record<string, unknown> = {}): ContextEvent => {
    const record = recordContextEvent(instrumentation.ledger, kind, {
      session_id: persistence.state?.sessionId ?? "",
      ordinal: currentOrdinal(),
      revision: persistence.state?.revision ?? 0,
      at: Date.now(),
    }, payload);
    instrumentation.sinceHandoff.push({
      seq: record.seq,
      kind,
      ...(typeof record.action === "string" ? { action: record.action } : {}),
      ...(typeof record.ok === "boolean" ? { ok: record.ok } : {}),
    });
    const operation = curation.instrumentationQueue.then(async () => {
      try { await pi.appendEntry(contextEventEntryType, record); }
      catch { }
    });
    curation.instrumentationQueue = operation.then(() => undefined, () => undefined);
    return record;
  };

  const PREFIX_MUTATING_KINDS: ReadonlySet<string> = new Set([
    "context.commit", "context.fold", "context.absorb", "context.recovery",
  ]);
  const CACHE_ACTION_REQUEST_CLASS: Readonly<Record<string, string>> = Object.freeze({
    peek: "after-peek",
    expand: "after-expand",
    refold: "after-refold",
  });

  const deliverReceipt = (receipt: ContextReceipt): void => {
    curation.receipts = withReceipt(curation.receipts, receipt);
    emit("context.receipt", {
      receipt_kind: receipt.kind,
      trigger: receipt.trigger,
      folds_committed: receipt.foldsCommitted,
      folds_created: receipt.foldsCreated,
      freed_tokens: receipt.freedTokens,
      absorbed_wedges: receipt.absorbedWedges,
      recovered: receipt.recovered,
      protected_bytes: receipt.protectedBytes,
      note: receipt.note,
    });
  };

  const safeNotify = (ctx: any, message: string, level: "info" | "warning" | "error"): void => {
    try { ctx.ui?.notify?.(message, level); } catch { }
  };

  const contextSessionMatches = (ctx: any, sessionId: string): boolean => {
    try { return ctx.sessionManager.getSessionId() === sessionId; }
    catch { return false; }
  };

  const sessionIdentityStillValid = (ctx: any, sessionId: string, expectedGeneration: number): boolean =>
    lifecycle.generation === expectedGeneration && persistence.state?.sessionId === sessionId &&
    (!ctx || contextSessionMatches(ctx, sessionId));

  /**
   * THE ONE LINE THAT IS ALWAYS ON SCREEN, so it answers the question a person actually
   * has: how full am I, and is anything about to happen.
   *
   * It used to read `pi_fold_context folds: 3 · provider 187234/272000`. That led with the
   * AGENT TOOL'S NAME, which a person cannot call and does not care about, and then spent
   * its remaining width on two raw counts they would have to divide themselves. The brand
   * leads now, occupancy is a percentage of the serving budget, and the commit point is
   * named only when it is close enough to matter.
   */
  const updateStatus = (ctx: any): void => {
    try {
      const roots = persistence.state && lifecycle.latestSnapshot ? orderedRoots(persistence.state, lifecycle.latestSnapshot).length : 0;
      const staged = persistence.state ? pendingMarks(persistence.state).length : 0;
      const capacity = currentCapacity(ctx);
      const used = measurements.lastProviderMeasurement?.tokens ?? null;
      const share = used !== null && capacity.budgetTokens > 0 ? used / capacity.budgetTokens : null;
      const parts: string[] = [];
      // FAILURE LEADS. This line is cut to whatever width the host gives it, so the last
      // segment is the first one a narrow terminal removes, and folding having stopped is
      // the one state on this line a person has to act on. It was appended last.
      if (ladder.automaticFailure) parts.push("FOLDING STOPPED");
      // Unmeasured is stated, never guessed: an estimate rendered as a fact is the habit
      // that cost a live session, and this line is the most-read surface there is.
      parts.push(share === null ? "not measured" : `${Math.round(share * 100)}% full`);
      // THE LIVE BAND, NOT THE LAST SNAPSHOT'S (2026-08-29). This read the threshold off
      // `lifecycle.latestSnapshot`, which is derived per context event, so a band changed
      // in /fold-settings went on being announced at its old value until the next event
      // rebuilt a snapshot. The number this line owes a person is the one that will fire,
      // and that is the runtime's own variable.
      const trigger = thresholds.maxTarget;
      // WHEN, not just how full. "68% full" only answers the second question a reader has
      // if they already remember where the trigger sits; naming it answers both.
      //
      // NOT WHILE STOPPED, though: the line rendered "COMMIT DUE" and "FOLDING STOPPED"
      // in one breath, promising the thing it was announcing would not happen.
      if (share !== null && !ladder.automaticFailure) {
        parts.push(share >= trigger ? "COMMIT DUE" : `commit at ${Math.round(trigger * 100)}%`);
      }
      if (staged > 0) parts.push(`${staged} staged`);
      if (roots > 0) parts.push(`${roots} fold${roots === 1 ? "" : "s"}`);
      ctx.ui?.setStatus?.(entryTypePrefix, `${brandNoun} ${parts.join(" · ")}`);
    } catch { }
  };

  /**
   * WHAT A PERSON SAVES IN /fold-settings REACHES THIS SESSION (2026-08-29).
   *
   * The screen writes the file and then hands the whole file here, so an absent field
   * means the package default exactly as it does on disk and at registration; the three
   * values are resolved through the same functions the options went through, which is
   * what stops a value meaning one thing at boot and another at an edit.
   *
   * ATOMIC: every value is validated before any is assigned, so a refusal leaves the
   * session on the settings it already had rather than half-moved. It throws the way
   * registration throws, and the caller decides what that means; the settings screen
   * catches it, because a screen may not take the session down with it.
   *
   * The memo is dropped because `authoritativeSnapshotFor` keys on session, entries and
   * messages, none of which move when a threshold does, so a cached snapshot would serve
   * the old band to the next reader that asked.
   */
  publishLiveSettings(pi, (settings, ctx) => {
    const nextThresholds = resolveThresholds(settings?.thresholds);
    assertThresholdsServable(nextThresholds,
      providerInputBudget ?? servingBudgetTokens(DEFAULT_CONTEXT_WINDOW));
    const nextToolFoldThreshold = resolvedToolFoldThreshold(settings?.toolFoldThreshold);
    const nextPostFoldNotice = resolvedPostFoldNotice(settings?.postFoldNotice);
    const changed: string[] = [];
    for (const field of ["maxTarget", "minTarget", "consolidateAfter", "minFoldChars"] as const) {
      if (nextThresholds[field] !== thresholds[field]) changed.push(field);
    }
    if (nextToolFoldThreshold !== toolFoldThreshold) changed.push("toolFoldThreshold");
    if (nextPostFoldNotice !== postFoldNotice) changed.push("postFoldNotice");
    // A SAVE THAT MOVED NOTHING IS NOT AN EVENT. The screen saves every keystroke that
    // lands, including a row stepped back to where it started.
    if (!changed.length) return;
    thresholds = nextThresholds;
    toolFoldThreshold = nextToolFoldThreshold;
    postFoldNotice = nextPostFoldNotice;
    dropDerivationMemo();
    // THE STREAM CARRIES IT, because from here on the session's commits fire at a point
    // no earlier record explains, and an archive reading this run later has no other way
    // to know the band moved under it.
    emit("context.settings", {
      changed,
      max_target: thresholds.maxTarget,
      min_target: thresholds.minTarget,
      consolidate_after: thresholds.consolidateAfter,
      min_fold_chars: thresholds.minFoldChars,
      tool_fold_threshold: toolFoldThreshold,
      post_fold_notice: postFoldNotice,
    });
    // The person is standing in the settings screen, so the line they will look at next
    // is the status line. Without this it keeps the old number until a context event.
    if (ctx) { try { updateStatus(ctx); } catch { } }
  });

  const budgetWindowFor = (ctx: any): number | null => {
    measurements.descriptorWindow = contextWindowFor(ctx);
    return providerInputBudget ?? measurements.descriptorWindow;
  };

  const servingCapacity = (window: number | null): ReturnType<typeof capacityAccounting> =>
    capacityAccounting({
      window: window ?? lifecycle.latestSnapshot?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      truthful: providerInputBudget !== null,
      descriptorWindow: measurements.descriptorWindow,
      usedTokens: measurements.lastProviderMeasurement?.tokens ?? null,
    });

  const currentCapacity = (ctx: any): ReturnType<typeof capacityAccounting> =>
    servingCapacity(budgetWindowFor(ctx));

  /**
   * The one place a derivation is timed. Both entry points route through it, so the
   * counters cannot drift from the work: a new call site that forgets to time itself
   * would have to call `mapActiveContext` directly, which nothing outside these two
   * functions does.
   */
  const timedDerivation = (derive: () => ActiveContextSnapshot): ActiveContextSnapshot => {
    const started = Date.now();
    try { return derive(); }
    finally {
      instrumentation.derivations += 1;
      instrumentation.deriveMs += Date.now() - started;
    }
  };

  const snapshotForEvent = (ctx: any, messages: unknown[]): ActiveContextSnapshot =>
    timedDerivation(() => mapActiveContext({
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
  }));

  const authoritativeSnapshotFor = (ctx: any): ActiveContextSnapshot => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!lifecycle.latestSnapshot || lifecycle.latestSnapshot.sessionId !== sessionId) {
      throw new Error("A current same-session Pi context event is required");
    }
    const entries = ctx.sessionManager.buildContextEntries();
    const window = budgetWindowFor(ctx) ?? undefined;
    const key = `${sessionId}:${entries.length}:${lifecycle.latestSnapshot.messages.length}:${window}`;
    if (derivationMemo.snapshot && derivationMemo.key === key) {
      instrumentation.derivationHits += 1;
      return derivationMemo.snapshot;
    }
    const derived = timedDerivation(() => mapActiveContext({
      sessionId,
      eventMessages: lifecycle.latestSnapshot.messages,
      contextEntries: entries,
      policy: lifecycle.latestSnapshot.policy,
      toolName,
      brandNoun,
      entryTypePrefix,
      blacklistAutoFoldTools,
      readOnlyContextActions,
      contextWindow: window,
      netBudget: providerInputBudget !== null,
      thresholds,
    }));
    derivationMemo.key = key;
    derivationMemo.snapshot = derived;
    return derived;
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
    measurements.wallInflowSteps.length = 0;
    measurements.projectionAnchor = null;
    measurements.lastProjectedEstimateBasis = "unmeasured";
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
    instrumentation.previousImages = 0;
    instrumentation.previousImageChars = 0;
    instrumentation.requests = 0;
    instrumentation.lastMutationRequest = 0;
    instrumentation.lastMutationTokens = null;
    instrumentation.lastChange = "append";
    instrumentation.lastPreservedShare = null;
    instrumentation.sinceHandoff = [];
    instrumentation.mutationsSinceHandoff = 0;
    curation.receipts = [];
    curation.contextCalls = 0;
    curation.recoveryAttempts = 0;
    curation.pendingRejection = null;
    curation.lastRecovery = null;
    ladder.lastAutomaticAction = null;
    ladder.automaticFailure = null;
    measurements.providerMeasurementReceipts.clear();
    measurements.providerMeasurementRevisionByMessageSha.clear();
    measurements.providerMeasurementByMessageSha.clear();
    measurements.providerMeasurementAnchorByMessageSha.clear();
    const sessionId = ctx.sessionManager.getSessionId();
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
      const persistedFoldIds = new Set(persistence.persisted.folds.map((fold) => fold.id));
      const arrivingFoldIds = next.folds.filter((fold) => !persistedFoldIds.has(fold.id)).map((fold) => fold.id);
      const foldsInMemory = next.folds.length;
      let projectionSnapshot: ActiveContextSnapshot | null = null;
      if (ctx && lifecycle.latestSnapshot?.sessionId === next.sessionId) {
        projectionSnapshot = authoritativeSnapshotFor(ctx);
        next = persistenceProjection(next, projectionSnapshot);
      }
      next.folds = normalizeFoldsForPersistedRecords(next.folds, persistence.persistedFoldRecords);
      if (sameStateProjection(next, persistence.persisted)) {
        if (arrivingFoldIds.length) {
          const lost = clone(persistence.state).folds.find((fold) => fold.id === arrivingFoldIds[0]);
          const lostRefs = lost ? flattenFoldRefs(lost, persistence.state) : [];
          const unresolved = projectionSnapshot
            ? lostRefs.filter((ref) => !exactMapped(projectionSnapshot!, ref)).length
            : null;
          throw new Error(
            `Active-context commit discarded at persistence: ${arrivingFoldIds.length} arriving fold(s) ` +
            `did not survive the persistence projection (${foldsInMemory} in memory, ` +
            `${next.folds.length} durable) at revision ${persistence.state.revision}; ` +
            `first ${arrivingFoldIds[0]} with ${unresolved ?? "unknown"} of ${lostRefs.length} refs ` +
            `unmapped against a ${projectionSnapshot?.mapped.length ?? 0}-message, ` +
            `${projectionSnapshot?.branchObjects.length ?? 0}-object projection snapshot`,
          );
        }
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
      // AN ALREADY-DURABLE FOLD NEEDS A DIGEST, NOT A RECORD (2026-08-28). This built the
      // whole entry for every fold on every persist just to compare one hash and continue:
      // `makeFoldRecordEntry` canonicalizes, hashes, then `parseFoldRecordEntry` re-validates,
      // clones the fold again, recomputes `foldIdFor`, hashes a second time and stringifies
      // for the wire cap. Replaying a real sealed session, 98.2 percent of 4,947 calls hit
      // the `continue`, and 126 of 135 persists appended nothing while rebuilding all of it.
      // `foldRecordRef` is the same digest by construction (`makeFoldRecordEntry` stores
      // `canonicalFoldRecord`, and `stateFromFoldRefs` already matches records to refs on
      // this equality at persistence.ts:809); gate 152 pins it. Equal digests mean
      // byte-identical canonical bytes to a record that already passed
      // `parseFoldRecordEntry`, so skipping the rebuild cannot reach a different verdict.
      // Measured 85.0ms to 19.6ms at 400 folds.
      for (const fold of next.folds) {
        const ref = foldRecordRef(fold);
        const existing = persistence.persistedFoldRecords.get(ref.id);
        if (existing) {
          if (existing.recordSha256 !== ref.sha256) {
            throw new Error(`Conflicting durable active-context fold ${ref.id}`);
          }
          continue;
        }
        const record = makeFoldRecordEntry(fold, sessionId);
        await pi.appendEntry(foldRecordEntryType, record);
        persistence.persistedFoldRecords.set(record.foldId, record);
        if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
          if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
          throw new Error("Active-context session changed after fold-record persistence");
        }
      }
      const wire = persistence.persistedWireVersion === 2 ? makeStateDelta(persistence.persisted, next) : makeStateCheckpoint(next);
      // THE WIRE CARRIES BOTH DIGESTS IT JUST DERIVED (2026-08-28). `makeStateDelta` writes
      // `baseStateSha256` from `persistence.persisted` and `stateSha256` from `next`, and
      // nothing mutates either state between that call and here, so re-hashing two whole
      // states was pure repetition at about 7ms per durable write. The drift check keeps its
      // teeth: `baseStateSha256` is still derived from `persistence.persisted`, so a
      // persisted digest that has drifted from the state it claims to describe still raises.
      // Gate 152 pins both equalities.
      if (wire.kind === "delta" && persistence.persistedStateSha256 !== wire.baseStateSha256) {
        throw new Error("Active-context durable base digest drift");
      }
      await pi.appendEntry(stateEntryType, wire);
      persistence.persisted = clone(next);
      persistence.persistedWireVersion = 2;
      persistence.persistedStateSha256 = wire.stateSha256;
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
        const selected = selectAutomaticRung(snapshot, persistence.state, ratio);
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
    const firstFailure = !ladder.automaticFailure;
    if (firstFailure || ladder.automaticFailure!.message !== message) {
      emit("context.suspend", {
        phase,
        error: message,
        error_name: error instanceof Error ? error.name : typeof error,
        disposition: firstFailure ? persistenceDisposition : ladder.automaticFailure!.persistenceDisposition,
        outcome: "suspended",
        repeat: !firstFailure,
        suppressed_callbacks: ladder.automaticFailure?.suppressedCallbacks ?? 0,
        state_revision: persistence.state?.revision ?? null,
        durable_revision: persistence.persisted?.revision ?? null,
        folds_in_memory: persistence.state?.folds.length ?? null,
        folds_durable: persistence.persisted?.folds.length ?? null,
        fold_records_durable: persistence.persistedFoldRecords.size,
        pending_marks: persistence.state?.pendingMarks?.length ?? 0,
        key: firstFailure ? key : ladder.automaticFailure!.key,
      });
    }
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

  const PROJECTION_CALIBRATION_MIN_CHARS = 20_000;
  const PROJECTION_CALIBRATION_MIN_TOKENS = 5_000;
  const PROJECTION_CHARS_PER_TOKEN_FLOOR = 2;
  const PROJECTION_CHARS_PER_TOKEN_CEILING = 12;
  const PROJECTION_CALIBRATION_WINDOW = 6;
  const PROJECTION_ERROR_WINDOW = 8;
  const PROJECTION_MARGIN_FLOOR_SHARE = 0.05;

  const noteProjectionCalibration = (measurement: ProviderContextMeasurement): void => {
    const previous = measurements.lastProviderMeasurement;
    if (Number.isFinite(measurement.tokens) && previous && Number.isFinite(previous.tokens)) {
      const step = measurement.tokens - previous.tokens;
      if (step > 0) {
        measurements.inflowSteps.push(step);
        if (measurements.inflowSteps.length > PROJECTION_ERROR_WINDOW) measurements.inflowSteps.shift();
      }
    }
    const chars = measurements.lastProjectedChars;
    if (chars === null || chars < PROJECTION_CALIBRATION_MIN_CHARS) return;
    // NEVER LEARN THE RATIO FROM A WINDOW HOLDING AN IMAGE. chars/token is a fact about
    // prose; a projection carrying base64 has a far higher true ratio, and because
    // projectionCharsPerToken takes the MINIMUM over the window such a sample is either
    // discarded (leaving the over-read in place) or, once images dominate, poisons the
    // ratio for the text around them. The clean rule is to calibrate on text alone.
    if (measurements.lastProjectedImages > 0) return;
    if (!Number.isFinite(measurement.tokens) || measurement.tokens < PROJECTION_CALIBRATION_MIN_TOKENS) return;
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

  const noteProviderProjectionAnchor = (measurement: ProviderContextMeasurement): void => {
    if (measurements.projectionAnchor?.messageSha256 === measurement.messageSha256) return;
    const text = instrumentation.previousText;
    if (!text || text.length < 2 || !text.endsWith("]") || !persistence.state) {
      measurements.projectionAnchor = null;
      return;
    }
    const chars = bytes(text);
    // The anchor is differenced against TEXT characters, so it must store them. The mass
    // belongs to the same `previousText` this anchor is built from, recorded by
    // noteProjection when that text was produced.
    const textChars = Math.max(0, chars - instrumentation.previousImageChars);
    const images = instrumentation.previousImages;
    // The floor test reads TEXT against tokens: an image-heavy projection has a raw ratio
    // far above any prose floor and would sail through a test that is meant to reject a
    // measurement the text cannot explain.
    if (!(measurement.tokens > 0) ||
        (measurement.tokens > images * IMAGE_ESTIMATED_TOKENS &&
          textChars / (measurement.tokens - images * IMAGE_ESTIMATED_TOKENS) <
            PROJECTION_CHARS_PER_TOKEN_FLOOR)) {
      measurements.projectionAnchor = null;
      return;
    }
    measurements.projectionAnchor = {
      tokens: measurement.tokens,
      chars,
      textChars,
      images,
      head: text.slice(0, -1),
      messageSha256: measurement.messageSha256,
      sessionId: persistence.state.sessionId,
      generation: lifecycle.generation,
    };
  };

  // THE SERIALIZATION TRAVELS, THE READING DOES NOT (2026-08-28). Six whole-window
  // serializations rode every provider request and four were the same string from the same
  // unmutated array. Only the TEXT is threaded, never a finished reading: each site still
  // re-reads `measurements.projectionAnchor` and `projectionCharsPerToken()` at its own
  // time, so every emitted number stays what it was. That matters on the commit path, where
  // `enforceProjectionBudget` awaits `attemptAutomaticCommit` and an `attributionChanged`
  // can null the anchor between the last measurement and the read: threading a reading would
  // freeze `basis` at "measured" where today it flips to "unmeasured". Roughly 50ms per
  // request at a 467KB window, 100ms at 1MB, all of it blocking main-loop CPU. Honest
  // framing: six become three, not one.
  const projectedTokenReading = (projected: unknown[], serialized?: string): {
    tokens: number;
    basis: ProjectionReadingBasis;
    chars: number;
    /** The image-corrected size of THIS projection, independent of any anchor. */
    sizeTokens: number;
    images: number;
    anchorTokens: number | null;
    deltaChars: number | null;
    text: string;
  } => {
    const text = serialized ?? stableStringify(projected);
    const chars = Buffer.byteLength(text, "utf8");
    const charsPerToken = projectionCharsPerToken();
    // AN IMAGE IS NOT TEXT (2026-08-28, see imageMass). Its base64 leaves the character
    // count and comes back as a flat per-image cost, because dividing base64 by a ratio
    // learned from prose read one screenshot as 110,000 tokens against a true 1,500 and
    // aborted a session that was less than half full.
    const mass = imageMass(projected);
    const textChars = Math.max(0, chars - mass.base64Chars);
    const imageTokens = mass.images * IMAGE_ESTIMATED_TOKENS;
    const estimate = Math.ceil(textChars / charsPerToken) + imageTokens;
    const anchor = measurements.projectionAnchor;
    if (!anchor || anchor.generation !== lifecycle.generation ||
        anchor.sessionId !== persistence.state?.sessionId) {
      return { tokens: estimate, basis: "unmeasured", chars, sizeTokens: estimate, images: mass.images, anchorTokens: null, deltaChars: null, text };
    }
    const separator = text.length > anchor.head.length ? text[anchor.head.length] : "";
    if (!text.startsWith(anchor.head) || (separator !== "," && separator !== "]")) {
      return { tokens: estimate, basis: "rewritten", chars, sizeTokens: estimate, images: mass.images, anchorTokens: anchor.tokens, deltaChars: null, text };
    }
    // The delta is taken on TEXT characters and images separately, so an image arriving
    // after the anchor costs its own flat price rather than its base64 length.
    const deltaChars = textChars - anchor.textChars;
    const deltaImages = mass.images - anchor.images;
    return {
      tokens: Math.max(0, anchor.tokens + Math.ceil(deltaChars / charsPerToken) +
        deltaImages * IMAGE_ESTIMATED_TOKENS),
      basis: "anchored",
      chars,
      sizeTokens: estimate,
      images: mass.images,
      anchorTokens: anchor.tokens,
      deltaChars,
      text,
    };
  };

  const estimatorErrorShare = (): number => measurements.estimatorErrors.length
    ? Math.max(...measurements.estimatorErrors.map((error) => Math.abs(error)))
    : 0;

  const expectedInflowTokens = (): number => measurements.inflowSteps.length
    ? Math.max(...measurements.inflowSteps)
    : 0;

  const WALL_INFLOW_WINDOW = 8;
  const noteWallInflow = (measurement: ProviderContextMeasurement): void => {
    const previous = measurements.lastProviderMeasurement;
    if (!previous || !Number.isFinite(measurement.tokens) || !Number.isFinite(previous.tokens)) return;
    const step = measurement.tokens - previous.tokens;
    if (step <= 0) return;
    measurements.wallInflowSteps.push(step);
    if (measurements.wallInflowSteps.length > WALL_INFLOW_WINDOW) measurements.wallInflowSteps.shift();
  };

  const expectedWallInflowTokens = (): number => measurements.wallInflowSteps.length
    ? Math.max(...measurements.wallInflowSteps)
    : 0;

  const projectionMarginTokens = (estimate: number, windowTokens: number): number => Math.ceil(Math.max(
    PROJECTION_MARGIN_FLOOR_SHARE * windowTokens,
    estimatorErrorShare() * estimate + expectedInflowTokens(),
  ));

  const projectionExceedsBudget = (projected: unknown[], ctx: any, serialized?: string): {
    tokens: number;
    sizeTokens: number;
    basis: ProjectionReadingBasis;
    budgetTokens: number;
    marginTokens: number;
    over: boolean;
    crowded: boolean;
    text: string;
  } => {
    const capacity = currentCapacity(ctx);
    const budgetTokens = Number.isFinite(capacity.budgetTokens) && capacity.budgetTokens > 0
      ? capacity.budgetTokens
      : Number.POSITIVE_INFINITY;
    const reading = projectedTokenReading(projected, serialized);
    const tokens = reading.tokens;
    const sizeTokens = reading.sizeTokens;
    const marginTokens = Number.isFinite(budgetTokens)
      ? projectionMarginTokens(tokens, capacity.window)
      : 0;
    return {
      tokens,
      sizeTokens,
      basis: reading.basis,
      budgetTokens,
      marginTokens,
      over: tokens > budgetTokens,
      crowded: tokens + marginTokens > budgetTokens,
      text: reading.text,
    };
  };

  // THE BAND TOP COMMITS ON ITS OWN (Shane, 2026-08-22).
  //
  // `maxTarget` is what the settings panel calls the commit trigger, and until now it
  // fired nothing. There were two commit sites: the fence below, which measures against
  // the WHOLE serving budget plus a margin, and the compaction boundary, which is Pi's
  // own threshold near the top of the window. A live 1M-window session sat at 571,367
  // tokens against a stated trigger of 516,096 with `folds: 0`, because neither site was
  // anywhere near. On a 251,520-token budget the fence sits close enough behind the
  // boundary to hide it; at 1M the two are half a million tokens apart.
  //
  // Shane, on the shape of the fix: "if the context is over our max, we commit. I don't
  // think that should be anything like once it crosses this threshold or anything like
  // that, it should just be an if statement. That way there isn't much room for error, if
  // it's over we fold." So there is no latch and no crossing to detect. Every projection
  // pass asks one question and acts on the answer. Occupancy only moves when the provider
  // measures, and a second attempt inside one handoff already defers on the mutation
  // budget, so "one commit per pass while over" is what this produces. A pass that finds
  // nothing to fold says so in the stream, which is a state worth seeing rather than one
  // worth suppressing.
  /**
   * Cut the raw material that has piled up past the last fold, and say so.
   *
   * This is the whole of "the runtime cuts": no commit, no bytes moved, no persistence
   * boundary. It stages pending marks the same way a commit's own top-up does, through
   * the same selector and the same brief builder, so a frontier cut and a commit fill are
   * the same object and the agent cannot tell them apart except by when it heard.
   */
  const advanceFoldFrontier = (snapshot: ActiveContextSnapshot): number => {
    if (!persistence.state) return 0;
    if (ladder.automaticFailure !== null) return 0;
    // A SCAN THAT FOUND NOTHING IS NOT RE-RUN UNTIL SOMETHING CHANGES. Exhausting the
    // selector costs one window scan per staged cut and one more to come back empty, and
    // once everything foldable is staged EVERY later pass pays that last scan to be told
    // the same thing. Measured on the 90-projection loop inside gate 50's instrumentation
    // claim: 137ms of a 460ms pass, 30 percent of the runtime's own per-request cost, for
    // an answer that cannot have changed.
    //
    // The key is the one `authoritativeSnapshotFor` already trusts for the snapshot
    // itself, plus the two pieces of state the selector reads: the revision, which moves
    // on every durable write, and the pending-mark count, which moves when the agent
    // withdraws one. It is only consulted when the last scan staged NOTHING; a scan that
    // staged something changed the state, so its key is stale by construction.
    const frontierKey = `${snapshot.messages.length}:${snapshot.mapped.length}:` +
      `${persistence.state.revision}:${pendingMarks(persistence.state).length}`;
    if (ladder.frontierEmptyKey === frontierKey) return 0;
    // CONSOLIDATION IS ANNOUNCED THE SAME WAY (Shane, 2026-08-23). When standing folds
    // reach `consolidateAfter` the parent that will absorb them is staged HERE rather than
    // being computed inside the commit, for exactly the reason the frontier exists: a
    // parent's brief indexes ten children, it is the entry the agent will navigate by, and
    // the agent knows what mattered in those children while the commit only knows their
    // order. Staged, it is byte-inert like any other pending mark and rides the same
    // notice, so there is one mechanism and not two.
    const marks = [
      ...frontierMarks({
        snapshot,
        state: persistence.state,
        ordinal: instrumentation.requests,
      }),
      ...consolidationMarks({
        snapshot,
        state: persistence.state,
        ordinal: instrumentation.requests,
      }),
    ];
    let state = persistence.state;
    const staged: ReturnType<typeof frontierMarks> = [];
    for (const mark of marks) {
      const addition = addPendingMark(state, mark);
      if (!addition.added) continue;
      state = addition.state;
      staged.push(mark);
    }
    // NOTHING STAGED, so this key is answered and the next pass under it can skip the
    // scan. Read from `staged` rather than from `marks`, because a candidate the pending
    // set already holds comes back from the selector every pass and is refused every
    // pass: keying on `marks` left the skip unreachable in exactly the steady state it
    // was built for, and half its measured saving on the floor.
    if (!staged.length) {
      ladder.frontierEmptyKey = frontierKey;
      return 0;
    }
    persistence.state = state;
    emit("context.frontier", {
      cut: staged.length,
      pending_marks: (state.pendingMarks ?? []).length,
      min_fold_chars: thresholds.minFoldChars,
    });
    // NO PERSISTENCE BOUNDARY OF ITS OWN, deliberately. A cut is DERIVED: the mark id
    // comes from the span, so a restart that lost these re-cuts exactly the same spans
    // with exactly the same ids, and the only thing that has to survive is a brief the
    // agent WROTE, which its own action persists along with the marks it rides with.
    // Persisting here instead cost a durable write on every projection pass, and the
    // branch entry it appended rebuilt the projection: gates 110 and 111 caught it as an
    // occupancy anchor that stopped reading the provider's own count.
    return staged.length;
  };

  /**
   * Tell the agent what was cut, once there is enough of it to be worth a turn.
   *
   * It is built from LIVE state, so it names what is unbriefed at the pass it speaks on,
   * and it is admitted ONCE per frozen projection, so a pass that adds material leaves it
   * buried at its own index rather than moving it to the tail. Those two together mean it
   * is a snapshot rather than a running tally: cuts staged after it spoke wait for the
   * next pass that rebuilds the projection anyway, and that is the trade being made. A
   * carrier that re-renders to stay current has to move, moving costs the occupancy
   * anchor its provider count, and an anchor is worth more than a fold id arriving one
   * epoch early. What it must never do is ask twice for a brief the agent has written,
   * and it does not: the rebuild reads the marks, not its own last text.
   */
  const appendFoldNotice = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    // The deterministic experiment condition: cuts stage and commits land exactly as
    // ever, but nothing invites a brief, so briefs stay the runtime's own.
    if (!postFoldNotice) return projected;
    if (!persistence.state) return projected;
    const held = pendingMarks(persistence.state);
    const unbriefed = held.filter((mark) =>
      mark.briefProvenance?.kind !== "supplied" && mark.briefProvenance?.kind !== "augmented");
    // BATCHED, AND APPENDED ONCE. A notice per cut is noise, and noise is how guidance
    // gets ignored; the frontier cuts often and this speaks only when a batch has built
    // up. `carrierAdmitted` is what makes it an APPEND rather than a rewrite: once the
    // carrier is in the frozen projection it is not pushed again, so raw material
    // arriving afterwards lands after it and the prefix in front of it never moves.
    //
    // The first cut of this withdrew the carrier and re-pushed it at the tail every pass,
    // the way the steward band had to because a band must be able to stand down. That is
    // exactly wrong for this one: re-pushing moved the notice past each newly arrived
    // message, so the byte at its old index changed on a pass where nothing else had, and
    // gates 110 and 111 read the whole projection as rewritten and dropped the occupancy
    // anchor back to the estimate. A carrier that moves on a quiet pass costs the cache,
    // which is the one thing this design exists to avoid.
    if (unbriefed.length < UNBRIEFED_FOLDS_BEFORE_NOTICE) return projected;
    if (!carrierAdmitted("fold-notice")) return projected;
    const text = foldNoticeText({
      unbriefed: unbriefed.map((mark) => ({
        id: mark.id,
        kind: mark.kind,
        tokens: estimatedTokens(markFreedBytes(snapshot, persistence.state!, mark)),
        brief: typeof mark.brief === "string" ? mark.brief : undefined,
      })),
      pending: held.length,
      toolName,
      brandNoun,
    });
    emit("context.frontier", {
      cut: 0,
      pending_marks: held.length,
      unbriefed: unbriefed.length,
      notice_chars: text.length,
    });
    projected.push({
      role: "custom",
      customType: foldNoticeProjectionType,
      content: text,
      display: false,
      details: { source: activeContextSource(entryTypePrefix), ephemeral: true },
      timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
        ? ownValue(snapshot.messages.at(-1), "timestamp")
        : 0,
    });
    return projected;
  };

  const enforceBandTop = async (
    snapshot: ActiveContextSnapshot,
    ctx: any,
  ): Promise<boolean> => {
    if (!epochCommitDue(snapshot, measurements.latestRatio)) return false;
    // ONE COMMIT PER MEASUREMENT, which is what "one commit per crossing" means once the
    // commit stops taking everything. There was no latch here and none was needed: the
    // band-top commit folded every span the class law offered, so the next pass found
    // nothing proposable and deferred. The 2026-08-23 depth bound ends that, on purpose,
    // and without this the parked window commits a SLICE on every pass at the same
    // declared occupancy, which is a prefix rewrite per pass and the exact cache cost the
    // one-commit rule exists to prevent. Occupancy is anchored to the provider's own
    // count, so a new count is the only evidence that the window actually moved; the
    // latch is keyed to that measurement and nothing else.
    if (ladder.bandTopMeasurement !== null &&
        ladder.bandTopMeasurement === measurements.lastProviderMeasurement) {
      return false;
    }
    ladder.bandTopMeasurement = measurements.lastProviderMeasurement;
    let action: Record<string, unknown> | null = null;
    try {
      // NULL RATIO, deliberately. The band top is routine housekeeping at a stated
      // threshold, not an emergency, and a null ratio is what arms the depth bound: the
      // commit takes stalest-first and stops at the aim, so the newest events stay raw
      // for as long as there is room for them. The fence and the compaction boundary
      // carry a ratio and no bound, because something has already gone wrong there.
      action = await attemptAutomaticCommit(snapshot, ctx, "band-top", null);
    } catch (error) {
      suspendAutomatic(error, "band-top", ctx);
      return false;
    }
    return action !== null;
  };

  const enforceProjectionBudget = async (
    snapshot: ActiveContextSnapshot,
    projected: unknown[],
    ctx: any,
  ): Promise<{ projected: unknown[]; text: string }> => {
    let measured = projectionExceedsBudget(projected, ctx);
    const rejected = curation.pendingRejection !== null;
    if (!measured.crowded && !rejected) return { projected, text: measured.text };
    const trigger = measured;
    let reduced = projected;
    let attempts = 0;
    let reducedAtLeastOnce = false;
    while (measured.crowded || measured.over || rejected) {
      attempts += 1;
      // THE EMERGENCY IS THE REQUEST THAT WILL NOT FIT, and only that. A projection at
      // the margin is ordinary work: the fence commits it because it is the pass holding
      // the request, but it is not a recovery and it does not buy an exemption from the
      // reclaim floor. What separates it from the band top is depth alone: the fence
      // carries a ratio, so its commit takes everything eligible rather than stopping at
      // the aim.
      const emergency = measured.over || rejected;
      if (emergency) curation.recoveryAttempts += 1;
      let action: Record<string, unknown> | null = null;
      try {
        // The fence COMMITS. A mark moves no bytes, and the request it is holding is the
        // one that will not fit, so marking here would spin the loop against an unchanged
        // projection until it ran out of things to mark.
        action = await attemptAutomaticCommit(
          snapshot, ctx, "projection-budget", emergency ? 1 : measurements.latestRatio,
        );
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
        estimatedTokensBefore: trigger.sizeTokens,
        estimatedTokensAfter: measured.sizeTokens,
        occupancyTokensAfter: measured.tokens,
        occupancyBasis: measured.basis,
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
      const overflowBefore = trigger.sizeTokens;
      const rejectedTokens = measurements.lastProjectedSizeTokens;
      const freedTokens = typeof rejectedTokens === "number"
        ? Math.max(0, rejectedTokens - measured.sizeTokens)
        : 0;
      const recovered = freedTokens > 0 && !measured.over;
      curation.lastRecovery = {
        status: curation.pendingRejection?.status ?? null,
        attempts,
        estimatedTokensAfter: measured.sizeTokens,
        budgetTokens: measured.budgetTokens,
        recovered,
      };
      emit("context.recovery", {
        provider_status: curation.pendingRejection?.status ?? null,
        attempts,
        tokens_before: overflowBefore,
        tokens_after: measured.sizeTokens,
        occupancy_tokens_after: measured.tokens,
        occupancy_basis: measured.basis,
        budget_tokens: measured.budgetTokens,
        margin_tokens: measured.marginTokens,
        recovered,
        rejected_tokens: typeof rejectedTokens === "number" ? rejectedTokens : null,
        freed_tokens: freedTokens,
        loop_reduced: reducedAtLeastOnce,
        rollback_seq: typeof rollback.last?.seq === "number" ? rollback.last.seq : null,
      });
      const unchangedNote = "The provider rejected the last request and this pass made it no smaller, so the " +
        `rebuilt request is ${measured.tokens} estimated tokens against a ${measured.budgetTokens}-token ` +
        "serving budget. Our own estimate says it fits; the provider already said otherwise about a request " +
        "this size, so this is not a recovery. Fold or protect deliberately, or the next request meets the " +
        "same rejection.";
      deliverReceipt(contextReceipt({
        kind: "overflow-recovery",
        ordinal: markOrdinal(snapshot),
        trigger: `provider-rejection:${curation.pendingRejection?.status ?? "unknown"}`,
        freedTokens,
        occupancyBefore: typeof rejectedTokens === "number" ? rejectedTokens : overflowBefore,
        occupancyAfter: measured.sizeTokens,
        recovered,
        note: measured.over
          ? `The rebuilt request is still ${measured.tokens} tokens against a ${measured.budgetTokens}-token ` +
            "serving budget, so the run stops here rather than sending a request the provider will reject again."
          : recovered
            ? "A rollback was required: the provider rejected the last request, which overfilled the serving " +
              `budget at ${rejectedTokens} estimated tokens against ${measured.budgetTokens}. This pass ` +
              `landed it at ${measured.sizeTokens} tokens. Nothing durable was written for it, and the request ` +
              "was rebuilt inside the budget rather than dropped."
            : unchangedNote,
      }));
      curation.pendingRejection = null;
    }
    // THE RUNTIME COMMITS AND TRANSMITS; ONLY THE PROVIDER REFUSES (Shane, 2026-08-28).
    //
    // This used to abort the request when the projection still read over budget after the
    // loop. It was deleted because it let an ESTIMATE veto a request that ground truth
    // would have accepted: a live session read 220,883 tokens where the provider counted
    // 111,837, was refused before transmission, and could not be rescued, because the
    // commit before the refusal had applied 28 marks and the next applied 0. The advice it
    // printed, fold manually or run /compact, named the two things the mechanism had just
    // proven it could not do.
    //
    // maxTarget is a TRIGGER meaning "commit now", not a bound meaning "refuse to
    // proceed", and only the first is something an estimate can be right about. What
    // remains is the loop above, which commits everything it can reach; the request then
    // goes to the provider, and a genuine overflow is handled by the rejection path, which
    // branches back, folds and retries on the provider's own count rather than ours.
    // `measured` is recomputed on `reduced` at every turn of the loop, so its text is the
    // serialization of the array this returns.
    return { projected: reduced, text: measured.text };
  };

  const startPreparation = (snapshot: ActiveContextSnapshot, ratio: number | null, ctx: any): void => {
    if (lifecycle.shuttingDown || !persistence.state || ladder.automaticFailure || ratio === null || persistence.state.prepared || ladder.preparing ||
        ratio < snapshot.policy.prepareRatio ||
        !measurements.lastProviderMeasurement || !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) return;
    const selection = selectAutomaticRung(snapshot, persistence.state, ratio);
    ladder.lastSelectionKind = selection && "candidate" in selection ? selection.candidate.kind : null;
    ladder.lastSelectionSourceIds = selection && "candidate" in selection
      ? selection.candidate.sourceRefs.slice(0, 8).map((ref) => ref.entryId)
      : [];
    if (selection?.kind !== "chapter-prepare") return;
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

  const holdFrozen = (projected: unknown[]): unknown[] => {
    freeze.projection = [...projected];
    freeze.active = false;
    return projected;
  };

  // An ephemeral peek result rides the projection exactly until the model's
  // next message, the same answered reading as the directed ask, then its
  // index holds a one-line placeholder and the reply is the surviving trace.
  // A message already projection-shaped (a fold's own deterministic brief
  // placeholder carries the same toolCallId) is never touched: only the raw
  // result is the ephemeral one.
  //
  // Returns what it replaced, keyed by call id, because the freeze has to be
  // told. Running against the BODY alone was not enough: the freeze compares
  // this pass's body prefix against the previous one and reuses the previous
  // PROJECTION when they match, and a withdrawal edits a body index inside
  // that prefix, so the comparison failed and the whole projection was rebuilt
  // from the body. The rebuild drops every receipt the freeze had
  // buried mid-array over the session, which moves divergence back to the
  // FIRST buried carrier rather than leaving it at the withdrawn index. That
  // is the opposite of what this mechanism is for: a tail edit was rewriting
  // the session's whole cached prefix.
  const withdrawConsumedEphemeralPeeks = (body: unknown[]): Map<string, unknown> => {
    const withdrawn = new Map<string, unknown>();
    if (!ephemeralPeeks.size) return withdrawn;
    for (let index = 0; index < body.length; index += 1) {
      const message = body[index];
      const callId = ownValue(message, "toolCallId");
      if (ownValue(message, "role") !== "toolResult" || typeof callId !== "string" ||
        !ephemeralPeeks.has(callId)) continue;
      const details = ownValue(message, "details");
      if (details && typeof ownValue(details, "projection") === "string") continue;
      const answered = body.slice(index + 1).some((later) =>
        ownValue(later, "role") === "assistant");
      if (!answered) continue;
      const placeholder = {
        role: "toolResult",
        toolCallId: callId,
        toolName: ownValue(message, "toolName"),
        content: [{ type: "text", text: "Ephemeral peek consumed; the reply that followed it is the surviving trace." }],
        isError: false,
        details: { projection: "ephemeral-peek-consumed" },
        timestamp: ownValue(message, "timestamp"),
      };
      body[index] = placeholder;
      withdrawn.set(callId, placeholder);
    }
    return withdrawn;
  };

  // Carry a withdrawal into the freeze's own kept arrays so the frozen prefix
  // stays usable. Matched by CALL ID rather than by position: the projection
  // interleaves buried carriers, so a body index is not a projection index.
  // The substitution is identity-preserving on role, call id, tool name and
  // timestamp, so what changes is the one result's content and nothing else,
  // and divergence lands at the withdrawn index where the mechanism puts it.
  const carryWithdrawalIntoFreeze = (messages: unknown[], withdrawn: Map<string, unknown>): void => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (ownValue(message, "role") !== "toolResult") continue;
      const callId = ownValue(message, "toolCallId");
      if (typeof callId !== "string") continue;
      const placeholder = withdrawn.get(callId);
      if (!placeholder) continue;
      const details = ownValue(message, "details");
      if (details && typeof ownValue(details, "projection") === "string") continue;
      messages[index] = placeholder;
    }
  };

  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const body = projectActiveContext(snapshot, persistence.state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType &&
        customType !== receiptProjectionType && customType !== curationProjectionType &&
        customType !== foldNoticeProjectionType;
    });
    const withdrawn = withdrawConsumedEphemeralPeeks(body);
    if (withdrawn.size && freeze.body) {
      carryWithdrawalIntoFreeze(freeze.body, withdrawn);
      freeze.bodyText = stableStringify(freeze.body);
      if (freeze.projection) carryWithdrawalIntoFreeze(freeze.projection, withdrawn);
    }
    const held = freeze.body?.length ?? 0;
    // THE PREFIX IS READ OUT OF THE WHOLE SERIALIZATION (2026-08-28). This asked
    // `stableStringify(body.slice(0, held)) === freeze.bodyText`, and in steady state `held`
    // is `body.length` minus the couple of messages that just arrived, so it was a second
    // full serialization of the window plus a slice allocation, beside the one below that
    // every pass does anyway. `serializedPrefixHolds` carries why that is sound; a false
    // POSITIVE here splices the previous pass's `freeze.projection` in front of the new tail
    // and emits stale messages, which is a content bug rather than a slowdown, and gate 154
    // drives the predicate itself rather than restating it.
    const bodyText = stableStringify(body);
    freeze.active = freeze.projection !== null &&
      serializedPrefixHolds(bodyText, freeze.bodyText, held, body.length);
    const projected = freeze.active
      ? [...freeze.projection!, ...body.slice(held)]
      : [...body];
    if (!freeze.active) freeze.keys.clear();
    freeze.body = body;
    freeze.bodyText = bodyText;
    appendReceipts(projected, snapshot);
    appendFoldNotice(projected, snapshot);
    return holdFrozen(projected);
  };
  const noteProjection = (projected: unknown[], serialized?: string): void => {
    const digests = messageDigests(projected);
    const comparison = compareProjections(instrumentation.previousDigests, digests);
    recordProjection(instrumentation.ledger, comparison, digests);
    instrumentation.previousDigests = digests;
    instrumentation.lastChange = comparison.change;
    const text = serialized ?? stableStringify(projected);
    const divergence = prefixDivergence(instrumentation.previousText, text);
    const previousChars = instrumentation.previousText?.length ?? 0;
    instrumentation.lastPreservedShare = previousChars > 0
      ? divergence.identicalChars / previousChars
      : null;
    const charsPerToken = projectionCharsPerToken();
    const successfulCacheActions = instrumentation.sinceHandoff.filter((event) =>
      event.kind === "context.attempt" && event.ok === true &&
      typeof event.action === "string" && CACHE_ACTION_REQUEST_CLASS[event.action]);
    const latestCacheAction = successfulCacheActions.at(-1) ?? null;
    const latestCacheActionClass = latestCacheAction?.action
      ? CACHE_ACTION_REQUEST_CLASS[latestCacheAction.action]
      : null;
    const projectionActions = successfulCacheActions.filter((event) =>
      event.action === "expand" || event.action === "refold");
    const causes = instrumentation.sinceHandoff.filter((event) =>
      PREFIX_MUTATING_KINDS.has(event.kind) || projectionActions.includes(event));
    const structuralCause = causes.some((event) => event.kind !== "context.attempt");
    const requestClass = causes.some((event) => event.kind === "context.recovery")
      ? "after-rollback"
      : (latestCacheAction?.action === "expand" || latestCacheAction?.action === "refold")
        ? latestCacheActionClass!
        : structuralCause
          ? "after-fold"
          : latestCacheActionClass
            ? latestCacheActionClass
            : divergence.index === null ? "steady-state" : "after-message";
    const reading = projectedTokenReading(projected, text);
    emit("context.projection", {
      change: comparison.change,
      previous_count: comparison.previousCount,
      next_count: comparison.nextCount,
      appended_count: comparison.appendedCount,
      first_divergent_index: comparison.firstDivergentIndex,
      chars: reading.chars,
      estimated_tokens: reading.tokens,
      estimate_basis: reading.basis,
      anchor_tokens: reading.anchorTokens,
      delta_chars: reading.deltaChars,
      chars_per_token: charsPerToken,
      derivations: instrumentation.derivations,
      derive_ms: Math.round(instrumentation.deriveMs),
      derivation_hits: instrumentation.derivationHits,
    });
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
        : (causes.length ? causes.map((event) => event.kind === "context.attempt"
          ? `context.attempt:${String(event.action)}`
          : event.kind).join(",") : "unattributed"),
      cause_event_seqs: causes.map((event) => event.seq).join(","),
      events_since_handoff: instrumentation.sinceHandoff.length,
      cache_action: latestCacheAction?.action ?? null,
      cache_action_seq: latestCacheAction?.seq ?? null,
      request_class: requestClass,
    });
    instrumentation.previousText = text;
    instrumentation.sinceHandoff = [];
    instrumentation.mutationsSinceHandoff = 0;
  };

  const prepareAndCommitExplicit = async (input: {
    snapshot: ActiveContextSnapshot;
    candidate: FoldCandidate;
    brief?: string;
    briefProvenance?: "supplied" | "deterministic" | BriefProvenance;
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
      briefProvenance: input.briefProvenance,
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

  const outputWallDue = (snapshot: ActiveContextSnapshot): boolean => {
    const capacity = servingCapacity(snapshot.contextWindow);
    if (capacity.usedTokens === null || !(capacity.budgetTokens > 0)) return false;
    if (capacity.usedTokens > capacity.budgetTokens) return false;
    return capacity.usedTokens + expectedWallInflowTokens() > capacity.budgetTokens;
  };

  const runCommitEpoch = async (
    snapshot: ActiveContextSnapshot,
    trigger: string,
    topUp: boolean,
    waiverRatio: number | null = measurements.latestRatio,
    userRequested = false,
  ): Promise<Record<string, unknown> | null> => {
    const ordinal = markOrdinal(snapshot);
    let state = persistence.state!;
    let peekAdded = 0;
    let topUpAdded = 0;
    let refoldAdded = 0;
    let consolidationAdded = 0;
    let closingAdded = 0;
    for (const mark of ephemeralPeekMarks({ snapshot, state, ordinal })) {
      const addition = addPendingMark(state, mark);
      if (addition.added) { state = addition.state; peekAdded += 1; }
    }
    for (const mark of consolidationMarks({ snapshot, state, ordinal })) {
      const addition = addPendingMark(state, mark);
      if (addition.added) { state = addition.state; consolidationAdded += 1; }
    }
    const capacity = servingCapacity(snapshot.contextWindow);
    const usedTokens = capacity.usedTokens;
    const budgetTokens = capacity.budgetTokens;
    const overflowExempt = userRequested || curation.recoveryAttempts > 0 ||
      (usedTokens !== null && budgetTokens > 0 && usedTokens > budgetTokens);
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
    // ONE DEFINITION OF THE DROP. The fill sizes itself to it, the advisory warns
    // against it, and the mark response answers "how much more" with it.
    const freeingTarget = commitCoverage({ snapshot, state, usedTokens, budgetTokens }).targetShare;
    // ONE COMMIT, SIZED BEFORE IT RUNS (Shane, 2026-08-21). At the threshold we know how
    // far the window has to come down: `freeingTarget` is the distance from what is used
    // now to the minTarget floor. The agent's marks count toward that distance first and
    // the ladder fills the remainder from the stale end, so an agent that marked 30k of a
    // 100k drop leaves 70k for the fill and both land in the SAME commit.
    //
    // Three rules decide the fill, and each replaced something that was tried first:
    //
    // The ladder does not STAND DOWN when the agent has marked. Standing down commits at
    // whatever depth the agent happened to reach, so one small mark commits a barely-moved
    // window and the next fence pass fires a second commit in the same cycle, which is the
    // cache cost the one-commit rule exists to prevent. `topUpMarks` measures progress
    // against the state it is handed, so agent marks are counted rather than displaced,
    // and `claimedRefKeys` keeps the fill off spans the agent already took.
    //
    // Raw stale material is spent BEFORE expanded folds, so an agent reading an expanded
    // fold keeps it while anything else can cover the drop. This is also the only route
    // to the refold rung now that nothing stages between commits.
    //
    // The fill measures progress over EVERY mark it makes, not just the ones this commit
    // will apply. Measuring the eligible share alone is what a starved commit needs and it
    // is wrong here: a mark over protected evidence moves the eligible share by nothing,
    // so the loop kept marking and walked a whole 24-batch excursion chasing a target it
    // could not reach that way (the retainer was the current-turn guard then; pins and
    // protected evidence retain the same way now). Counting everything bounds the fill at
    // the drop it was asked for. The backstop still reads the eligible share, because
    // starvation is the one state where the difference is the point.
    const fill = (targetShare: number, eligibleOnly: boolean): void => {
      for (const mark of topUpMarks({ snapshot, state, ordinal, eligibleOnly, targetShare })) {
        const addition = addPendingMark(state, mark);
        if (addition.added) { state = addition.state; topUpAdded += 1; }
      }
      for (const mark of refoldMarks({ snapshot, state, ordinal, eligibleOnly, targetShare })) {
        const addition = addPendingMark(state, mark);
        if (addition.added) { state = addition.state; refoldAdded += 1; }
      }
    };
    let backstopFired = false;
    if (topUp) {
      fill(freeingTarget, false);
      const reachedShare = markAccounting(snapshot, state).eligibleFreedBudgetShare;
      const shallow = reachedShare < Math.max(commitDepthFloorShare(snapshot), freeingTarget);
      if (shallow && atOrAboveBackstop(snapshot, waiverRatio)) {
        backstopFired = true;
        fill(1, true);
      }
    }
    const wedges = absorbWedgeMarks({
      snapshot,
      state,
      charsPerToken: projectionCharsPerToken(),
    });
    state = wedges.state;
    const accounting = markAccounting(snapshot, state);
    // Derived ONCE, here, against the pre-commit state both readers below report against.
    // It left `MarkAccounting` because it serializes the whole marked tail and every other
    // caller of `markAccounting` was paying for a number only this path reads.
    const rewriteTokens = markRewriteTokens(snapshot, state);
    if (!accounting.pending) {
      const remainder = unmarkedRemainder(snapshot, state, projectionCharsPerToken());
      emit("context.commit", {
        trigger,
        deferred: true,
        reason: "nothing-proposable",
        applied_marks: 0,
        pending_marks: 0,
        unmarked_stale_spans: remainder.spans,
        unmarked_stale_tokens: remainder.tokens,
        window_tokens: snapshot.contextWindow,
      });
      return null;
    }
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
        // THE REMAINDER RIDES EVERY DEFERRAL, not just the empty one. It was on
        // `nothing-proposable` alone, which was the only starved shape while staging
        // happened at commit time. The frontier cuts ahead of the commit, so a starved
        // pass now usually arrives holding a mark it cannot apply and lands HERE instead,
        // and "below the reclaim floor" without the remainder does not tell a reader
        // whether the mass is held or simply absent. That is the distinction the whole
        // record exists to draw.
        unmarked_stale_spans: unmarkedRemainder(snapshot, state, projectionCharsPerToken()).spans,
        window_tokens: snapshot.contextWindow,
      });
      return null;
    }
    const bytesBefore = bytes(projectActiveContext(snapshot, state));
    // THE COMMIT CUTS ONLY AS DEEP AS THE BUDGET ASKS (Shane, 2026-08-23). The frontier
    // stages as material arrives, so by now the pending set is most of the window; without
    // this bound the first commit would fold all of it. `freeingTarget` is a share of the
    // budget and the bound is bytes, so it is converted once, here, through the same ratio
    // the projection weighs itself with.
    //
    // It binds on the ROUTINE path only: a null ratio is the band top, ordinary
    // housekeeping at a stated threshold, and that is where "only as deep as it needs"
    // belongs. The fence and the compaction boundary carry a ratio because something has
    // already gone wrong there, and a lane holding a request that will not fit is not the
    // place to leave depth on the table. The backstop is exempt for the same reason: it
    // fires only when the commit is already starving.
    //
    // This bound is also what protects the working set since the current-turn guard was
    // deleted (Shane, 2026-08-23, from the first live session): the cut takes stalest
    // first and stops at the aim, so the newest events stay raw exactly as long as there
    // is room for them, in every session shape including one that never closes a turn.
    let result = await commitPendingMarks({
      snapshot,
      state,
      generation: lifecycle.generation,
      retainIneligible: true,
      ...(backstopFired || waiverRatio !== null ? {} : {
        applyTargetBytes: Math.ceil(freeingTarget * budgetTokens * projectionCharsPerToken()),
      }),
    });
    for (;;) {
      // THE CLOSING PASS COMMITS ONLY WHAT IT SEATS (2026-08-23). It rides the same paid
      // rewrite to give a group its parent, and it runs UNBOUNDED because a parent's whole
      // span must land together. Handing it the full pending set therefore leaked the depth
      // cut: the marks the bound had just retained were still pending, the closing commit
      // carried no bound, and the first band-top commit after the guard deletion folded all
      // 24 of them to the floor (gate 09's fixture, applied 26 of 24 with deferred 0). The
      // marks the cut held back are set aside before the closing commit and restored after,
      // so the only thing an unbounded closing pass can spend is the parents it just made.
      let closing = result.state;
      const heldBack = pendingMarks(closing);
      let seeded = withPendingMarks(closing, []);
      let seededAdded = 0;
      for (const mark of consolidationMarks({ snapshot, state: closing, ordinal })) {
        const addition = addPendingMark(closing, mark);
        if (!addition.added) continue;
        closing = addition.state;
        const carried = addPendingMark(seeded, mark);
        if (carried.added) { seeded = carried.state; closingAdded += 1; seededAdded += 1; }
      }
      if (!seededAdded) break;
      const closed = await commitPendingMarks({
        snapshot,
        state: seeded,
        generation: lifecycle.generation,
        retainIneligible: true,
      });
      if (!closed.applied.length) break;
      result = {
        ...closed,
        state: withPendingMarks(closed.state, [...pendingMarks(closed.state), ...heldBack]),
        applied: [...result.applied, ...closed.applied],
        refused: [...result.refused.filter((mark) => !mark.retained), ...closed.refused],
        retained: [...result.retained.filter((mark) =>
          !closed.applied.some((appliedMark) => appliedMark.id === mark.id)), ...closed.retained],
      };
    }
    // THE TOOL-CALL DIET RIDES THE SAME TRANSACTION (2026-08-24): clips are selected
    // against the post-fold state and land in the same revision the commit minted, so
    // the one paid rewrite carries both and no non-commit pass ever moves a byte. The
    // full bytes stay in the transcript behind each clip's entry id.
    let clippedResults = 0;
    if (toolFoldThreshold > 0) {
      const clipAdditions = toolClipAdditions({
        snapshot,
        state: result.state,
        threshold: toolFoldThreshold,
        blacklist: blacklistAutoFoldTools,
      });
      if (clipAdditions.length) {
        clippedResults = clipAdditions.length;
        result = { ...result, state: { ...result.state,
          clips: [...(result.state.clips ?? []), ...clipAdditions] } };
      }
    }
    persistence.state = result.state;
    const bytesAfter = bytes(projectActiveContext(snapshot, persistence.state));
    const freedBytes = Math.max(0, bytesBefore - bytesAfter);
    const pinHeld = protectedStaleMass(snapshot, result.state);
    const commitEvent = emit("context.commit", {
      trigger,
      deferred: false,
      reason: null,
      eligible_freed_share: accounting.eligibleFreedBudgetShare,
      reclaim_floor_share: COMMIT_RECLAIM_FLOOR_SHARE,
      target_freed_share: freeingTarget,
      hysteresis_target_share: freeingTarget,
      target_occupancy_share: thresholds.minTarget,
      shortfall_share: Math.max(0, freeingTarget - accounting.eligibleFreedBudgetShare),
      occupancy_tokens_before: usedTokens,
      budget_tokens: budgetTokens,
      expected_inflow_tokens: expectedWallInflowTokens(),
      output_wall: outputWallDue(snapshot),
      requests_since_previous: instrumentation.requests - instrumentation.lastMutationRequest,
      inflow_tokens_since_previous: usedTokens === null || instrumentation.lastMutationTokens === null
        ? null
        : usedTokens - instrumentation.lastMutationTokens,
      applied_marks: result.applied.length,
      refused_marks: result.refused.filter((mark) => !mark.retained).length,
      deferred_marks: result.retained.length,
      pending_marks: accounting.pending,
      agent_marks: accounting.agentMarks,
      ladder_marks: accounting.ladderMarks,
      peek_marks: peekAdded,
      topup_marks: topUpAdded,
      refold_marks: refoldAdded,
      consolidation_marks: consolidationAdded,
      closing_consolidation_marks: closingAdded,
      absorbed_wedges: wedges.absorbed.length,
      clipped_results: clippedResults,
      freed_bytes: freedBytes,
      freed_tokens: estimatedTokens(freedBytes),
      rewrite_tokens: rewriteTokens,
      pinned_bytes: accounting.pinnedBytes,
      pinned_results: accounting.pinnedResults,
      protected_stale_bytes: pinHeld.bytes,
      protected_stale_refs: pinHeld.refs,
      window_tokens: snapshot.contextWindow,
    });
    instrumentation.mutationsSinceHandoff += 1;
    instrumentation.lastMutationRequest = instrumentation.requests;
    instrumentation.lastMutationTokens = usedTokens;
    let foldedToolResults = 0;
    let foldedSpans = 0;
    for (const applied of result.applied) {
      const fold = persistence.state.folds.find((item) => item.id === applied.foldId);
      if (fold?.kind === "tool-result") foldedToolResults += 1;
      else foldedSpans += 1;
      const peekedSources = fold?.kind === "tool-result"
        ? peekedSourceFoldIds(snapshot, flattenFoldRefs(fold, persistence.state))
        : null;
      emit("context.fold", {
        commit_seq: commitEvent.seq,
        fold_id: applied.foldId,
        mark_id: applied.id,
        fold_kind: fold?.kind ?? applied.mark,
        origin: applied.origin,
        peek_of: peekedSources ? peekedSources.join(",") : null,
        source_chars: fold?.sourceChars ?? 0,
        placeholder_chars: fold?.placeholderChars ?? 0,
        brief_provenance: fold ? foldProvenance(fold, persistence.state).kind : null,
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
        chars: wedge.chars,
        threshold_chars: thresholds.minFoldChars,
      });
    }
    const epoch = {
      trigger,
      applied: result.applied,
      refused: result.refused,
      pendingMarks: accounting.pending,
      agentMarks: accounting.agentMarks,
      ladderMarks: accounting.ladderMarks,
      peekMarks: peekAdded,
      topUpMarks: topUpAdded,
      refoldMarks: refoldAdded,
      consolidationMarks: consolidationAdded,
      closingMarks: closingAdded,
      absorbedWedges: wedges.absorbed.length,
      absorbed: wedges.absorbed,
      foldedSpans,
      foldedToolResults,
      occupancyTokensBefore: usedTokens,
      depthFloorShare: commitDepthFloorShare(snapshot),
      reclaimFloorShare: COMMIT_RECLAIM_FLOOR_SHARE,
      appliedMarks: result.applied.length,
      refusedMarks: result.refused.filter((mark) => !mark.retained).length,
      deferredMarks: result.retained.length,
      pinnedBytes: accounting.pinnedBytes,
      pinnedResults: accounting.pinnedResults,
      protectedStaleBytes: pinHeld.bytes,
      protectedStaleRefs: pinHeld.refs,
      retainedMarks: result.retained.length,
      eligibleMarks: accounting.eligibleMarks,
      estimatedRewriteTokens: rewriteTokens,
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
    // The receipt is the LAST statement of the commit, and stays that way: harness gate
    // 54 reads a commit that reported applied marks and delivered no receipt as one that
    // threw partway and left its folds in the stream and nowhere else. The rung used to
    // write it because the rung used to own the epoch; the boundary owns it now.
    ladder.lastAutomaticAction = { kind: "epoch-commit", foldIds: [], sourceIds: [], epoch };
    ladder.pendingContextNote =
      `A commit epoch applied ${result.applied.length} pending mark(s) in one rewrite; ` +
      "exact evidence remains expandable.";
    noteAutomaticReceipt(snapshot, ladder.lastAutomaticAction, epoch);
    return epoch;
  };

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
      occupancyBefore,
      occupancyAfter: occupancyBefore === null ? null : Math.max(0, occupancyBefore - freedTokens),
      spansFolded: epoch ? Number(epoch.foldedSpans ?? 0) : foldIds,
      toolResultsFolded: epoch ? Number(epoch.foldedToolResults ?? 0) : 0,
      absorbedWedges: Number(epoch?.absorbedWedges ?? 0),
      recovered: curation.recoveryAttempts > 0,
      protectedBytes: Number(epoch?.protectedStaleBytes ?? 0),
      note: null,
    }));
  };

  /**
   * A COMMIT, THROUGH THE SAME TRANSACTION AND THE SAME QUEUE. Two callers reach it: the
   * compaction boundary, which is the ordinary one, and the projection fence, which is
   * the emergency one. The fence cannot wait for a boundary because the request it is
   * holding does not fit, so it commits in place; that is the one exception, and it is
   * the exception that already existed.
   */

  const runAutomaticTransaction = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    operation: () => Promise<Record<string, unknown> | null>,
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
      action = await operation();
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
      const disposition = stateCommitted ? "state-committed" : recordOnly ? "record-only" : "none";
      suspendAutomatic(error, phase, ctx, key, disposition);
      updateStatus(ctx);
      return stateCommitted ? action : null;
    }
  };
  const queueAutomatic = (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    operation: () => Promise<Record<string, unknown> | null>,
  ): Promise<Record<string, unknown> | null> => {
    const queued = ladder.actionQueue.then(() =>
      runAutomaticTransaction(snapshot, ratio, ctx, phase, operation));
    ladder.actionQueue = queued.catch(() => undefined);
    return queued;
  };
  const attemptAutomaticCommit = (
    snapshot: ActiveContextSnapshot,
    ctx: any,
    trigger: string,
    waiverRatio: number | null,
  ): Promise<Record<string, unknown> | null> => queueAutomatic(
    snapshot, waiverRatio ?? 1, ctx, trigger, () => runCommitEpoch(snapshot, trigger, true, waiverRatio),
  );
  const projectionCandidates = (ctx: any): Array<Record<string, unknown>> => {
    if (lifecycle.shuttingDown || !persistence.state) return [];
    try {
      return projectionSlateCandidates(persistence.state, authoritativeSnapshotFor(ctx));
    } catch {
      return [];
    }
  };
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
    measurements.wallInflowSteps.length = 0;
    measurements.projectionAnchor = null;
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
          noteProjectionCalibration(observedMeasurement);
          noteProviderProjectionAnchor(observedMeasurement);
          measurements.lastProviderMeasurement = observedMeasurement;
          startPreparation(snapshot, measurements.latestRatio, ctx);
          if (!ladder.automaticFailure && measurements.latestRatio >= hardFenceRatio(snapshot) && ladder.preparing) {
            mutationAttempted = true;
            await ladder.preparing.promise;
            if (!sessionIdentityStillValid(ctx, snapshot.sessionId, generationAtEntry)) {
              return { messages: event.messages };
            }
          }
          // NO EAGER LADDER MARKING (Shane, 2026-08-21): the rung used to stage a mark
          // here on every measured response, which crowded the agent out of curation
          // entirely -- by the time an agent looked, every eligible batch was already
          // marked. The commit epoch fills fresh at commit time (topUpMarks), which is
          // the only automatic marking there is.
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
        return { messages: event.messages };
      }
      // THE FRONTIER CUTS FIRST, and it costs the projection nothing to do so: a pending
      // mark moves no bytes, so this runs BEFORE the band top and the fence and changes
      // neither of their inputs. What it changes is WHEN the agent learns a fold exists,
      // which is now while the material it covers is still in front of it.
      advanceFoldFrontier(snapshot);
      // BEFORE the fence, so an ordinary crossing is an ordinary commit and the fence is
      // left holding only the requests that genuinely will not fit.
      if (await enforceBandTop(snapshot, ctx)) {
        mutationAttempted = true;
        persistedSucceeded = true;
        try { projected = projectWithAdvisory(snapshot); }
        catch (error) {
          suspendAutomatic(error, "projection", ctx);
          return { messages: event.messages };
        }
      }
      const budgeted = await enforceProjectionBudget(snapshot, projected, ctx);
      projected = budgeted.projected;
      const reading = projectedTokenReading(projected, budgeted.text);
      measurements.lastProjectedChars = reading.chars;
      measurements.lastProjectedImages = reading.images;
      measurements.lastProjectedEstimate = reading.tokens;
      measurements.lastProjectedEstimateBasis = reading.basis;
      // The size is the reading's own image-corrected figure. Recomputing it from raw
      // chars here is what fed base64 straight into the fence's own accounting.
      measurements.lastProjectedSizeTokens = reading.sizeTokens;
      measurements.lastProjectedEstimateCalibrated = measurements.projectionCalibrations.length > 0;
      noteProjection(projected, budgeted.text);
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
    curation.recoveryAttempts = 0;
    curation.pendingRejection = null;
    noteWallInflow(measurement);
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
    if (measurementStateChanged && persistence.state && persistence.persisted &&
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
        emit("context.usage", {
          provider: ownValue(message, "provider") ?? null,
          model: ownValue(message, "model") ?? null,
          input_tokens: observation.inputTokens,
          cache_read_tokens: observation.cacheReadTokens,
          cache_write_tokens: observation.cacheWriteTokens,
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
      try { updateStatus(ctx); } catch { }
    }
  });
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
        // No rung here either: turn end stages nothing (see the context-path note).
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
    try { updateStatus(ctx); } catch { }
  });
  pi.on("session_before_tree", (event: Record<string, unknown>) => {
    const preparation = ownValue(event, "preparation");
    if (!preparation || typeof preparation !== "object") return;
    return ownValue(preparation, "userWantsSummary") === true ? { cancel: true } : undefined;
  });

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
    } catch { }
    for (const specifier of specifiers) {
      try {
        const module = await import(specifier) as Record<string, unknown>;
        if (typeof module.isContextOverflow === "function") {
          rollback.classifier = module.isContextOverflow as (message: unknown, contextWindow: number) => boolean;
          rollback.classifierSource = specifier;
          return;
        }
      } catch { }
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

  const noteOverflowAtMessageEnd = (message: unknown, ctx: any): void => {
    if (!rollback.classifier || !message || typeof message !== "object") return;
    const window = budgetWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW;
    let overflow = false;
    try { overflow = rollback.classifier(message, window) === true; }
    catch { return; }
    if (!overflow) return;
    rollback.pendingOverflow = { at: currentOrdinal(), entryId: null };
  };

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
    load(ctx, true);
    curation.pendingRejection = { status: 400, ordinal: currentOrdinal() };
  };

  pi.on("session_before_compact", async (event: Record<string, unknown>, ctx: any) => {
    const reason = ownValue(event, "reason");
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
      try { updateStatus(ctx); } catch { }
      return { cancel: true };
    }
    if (reason === "manual") {
      nativeCompaction.lastThresholdDecision = {
        handled: false,
        retry: false,
        reason: "manual native compaction explicitly requested by the user",
        compactionReason: reason,
      };
      try { updateStatus(ctx); } catch { }
      return undefined;
    }
    let handoff: Record<string, unknown> | null = null;
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      handoff = await attemptAutomaticCommit(
        snapshot, ctx, "compaction-boundary", measurements.latestRatio,
      );
    } catch (error) {
      suspendAutomatic(error, "compaction-boundary", ctx);
      return undefined;
    }
    // CANCELLED WHETHER OR NOT ANYTHING WAS HANDED OFF. Letting Pi compact when the
    // boundary found nothing eligible is a silent fallback to a lossy summary, and
    // losslessness is the whole claim: a crossing that reclaims nothing is a STARVED
    // session, and the fence, the abort and the rollback lane already own that case and
    // say so out loud. The decision record still names which of the two happened.
    nativeCompaction.lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: handoff
        ? `${contextBrand(brandNoun)} handed the prefix off losslessly instead of compacting it`
        : `${contextBrand(brandNoun)} blocked stock automatic compaction with nothing eligible to hand off`,
      compactionReason: reason,
      nativeCompactionCompleted: false,
    };
    try { updateStatus(ctx); } catch { }
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
    }
    try { await recoverNativeReceipts(ctx); }
    catch (error) { safeNotify(ctx, `Native compaction receipt recovery remains pending: ${String(error)}`, "error"); }
    updateStatus(ctx);
  });

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
      alternatives.push({ action: "status", detail: "fold_candidates" });
    }
    throw new Error(
      `${input.action} of ${input.foldId} needs ~${verdict.requestedTokens} tokens and only ` +
      `${verdict.headroomTokens} remain of the ${verdict.budgetTokens}-token budget; it was refused ` +
      "before it could cross the fence. Free room or read less: " +
      JSON.stringify(alternatives),
    );
  };

  /**
   * THE WITHDRAWAL PATH, shared by the tool's unmark action and the editor's
   * withdraw intent: same refusal for an unknown id, same persist, same status.
   */
  const withdrawMarks = async (ids: string[], ctx: any): Promise<Array<Record<string, unknown>>> => {
    const requested = new Set(ids);
    const before = pendingMarks(persistence.state!);
    const kept = before.filter((mark) => !requested.has(mark.id));
    const removed = before.filter((mark) => requested.has(mark.id));
    const unknown = ids.filter((id) => !before.some((mark) => mark.id === id));
    if (unknown.length) throw new Error(`No pending mark named ${unknown.join(", ")}`);
    await persistManual(withPendingMarks(persistence.state!, kept), ctx);
    updateStatus(ctx);
    return removed as Array<Record<string, unknown>>;
  };

  /**
   * THE PIN CHANGE PATH, shared by the tool's pin/unpin actions and the editor's
   * pin toggle: the pinned-share cap, protectEvidence, the canonical event, persist.
   */
  const applyProtectionChange = async (
    snapshot: ActiveContextSnapshot,
    ids: string[],
    pin: boolean,
    ctx: any,
  ): Promise<void> => {
    const refsBefore = persistence.state!.protected.length;
    const nextProtection = protectEvidence(snapshot, persistence.state!, ids, pin);
    if (pin) {
      const capacity = servingCapacity(snapshot.contextWindow);
      const prospectiveShare = capacity.budgetTokens > 0
        ? estimatedTokens(explicitProtectedMass(snapshot, nextProtection).bytes) / capacity.budgetTokens
        : 0;
      if (prospectiveShare > MAX_PINNED_SHARE) {
        throw new Error(
          `protect refused: these pins would hold ${Math.round(prospectiveShare * 100)}% of the ` +
          `working window raw, past the ${Math.round(MAX_PINNED_SHARE * 100)}% pinned-share cap. ` +
          'Release earlier pins with {"action":"unpin","ids":["<entry-id>"]} first; ' +
          "folding keeps entries exactly recoverable without pinning them.");
      }
    }
    await persistManual(nextProtection, ctx);
    emit("context.pin", {
      pin,
      ids: ids.join(","),
      id_count: ids.length,
      protected_refs_before: refsBefore,
      protected_refs_after: persistence.state!.protected.length,
    });
    updateStatus(ctx);
  };

  /**
   * THE ONE STAGING PATH FOR FOLD MARKS (2026-08-23). The /fold-editor's user marks
   * run THIS code and nothing else: span snapping, claim refusal, brief contract,
   * prepareFold, replacement of a standing mark over the same span. A user mark is
   * mechanically an ordinary mark: it counts toward the commit's coverage, answers
   * with its commit arithmetic, and folds at the epoch exactly as a runtime mark does.
   */
  const stageFoldMark = async (
    ids: string[],
    supplied: string | undefined,
    signal: AbortSignal,
    ctx: any,
    snapshot: ActiveContextSnapshot,
  ): Promise<{ mark: Record<string, unknown>; corrections: SpanCorrection[]; staged: ActiveContextState }> => {
    const snapped = snapFoldCandidate(snapshot, persistence.state, ids, { allowProtected: true });
    // AN AGENT'S SPAN IS TAKEN WHOLE (Shane, 2026-08-22). The bite-size cap was
    // applied to manual marks too, and it was the only caller: the ladder never
    // splits, because `selectAutomaticChapter` stops accumulating at the cap on its
    // own. So the split existed solely to second-guess the one judgement the design
    // wants to encourage, and it charged for it twice. One intended fold became five
    // or ten placeholders, and every piece was handed the SAME brief, so each one
    // claimed to describe a span it held a fraction of, while the correction text
    // said "each with its own brief", which was never true.
    //
    // The cap stays for the ladder, where it was earned (2026-08-06 rep 6: one
    // 60,432-byte chapter hid the fact the run needed). The difference is who chose
    // the boundary. A ladder fold is a span nobody vouched for, so it is kept small
    // enough to read back cheaply. An agent fold is a span the agent cut and wrote a
    // brief for, and it stays navigable by a route that did not exist in 2026-08:
    // peek takes offset and bytes, states the omitted middle, and reads any child id,
    // so a large fold has a narrow read. An expand that will not fit is refused with
    // a peek offered instead, so size costs a refusal rather than a window.
    const candidate = snapped.candidate;
    const corrections = snapped.corrections;
    let staged = persistence.state!;
    const alreadyPrepared = staged.folds.some((fold) =>
      fold.id === foldIdFor(candidate.kind, candidate.parts));
    const deferred = refsProtected(candidate.sourceRefs, staged, snapshot);
    // A MARK IS EDITABLE UNTIL IT COMMITS (Shane, 2026-08-21). Marking a span you
    // already marked REPLACES the mark, so a brief written in haste is corrected by
    // writing it again: the span is identical, the id derives from the span, and no
    // byte has moved yet, so the correction costs nothing at all. After the commit
    // the fold is standing and there is no rewrite verb, because rewriting a
    // standing brief rewrites the projection at its placeholder; `reboundary`
    // re-cuts the span instead, which was going to rewrite anyway.
    const replacing = foldIdFor(candidate.kind, candidate.parts);
    const claimed = markClaimingRef(staged, candidate.sourceRefs);
    if (claimed && claimed.markId !== replacing) {
      return {
        mark: {
          id: replacing,
          kind: candidate.kind,
          ok: false,
          deferred: false,
          reason: `Evidence ${claimed.entryId} is already held by pending mark ${claimed.markId}, ` +
            `which folds at the next commit. Unmark ${claimed.markId} first if you want to ` +
            "mark this span differently.",
        },
        corrections,
        staged,
      };
    }
    const suppliedComplaint = supplied === undefined
      ? null
      : briefContractComplaint(supplied.trim(), snapshot.policy.agentBriefReserve, snapshot.toolName);
    if (suppliedComplaint !== null) {
      return {
        mark: {
          id: replacing,
          kind: candidate.kind,
          ok: false,
          deferred: false,
          reason: `Supplied brief rejected. ${suppliedComplaint}`,
        },
        corrections,
        staged,
      };
    }
    const briefed = !deferred && !alreadyPrepared
      ? await prepareFold({
        candidate,
        snapshot,
        state: staged,
        generation: lifecycle.generation,
        brief: supplied,
        ctx,
        signal,
      })
      : null;
    const mark = foldMarkFor({
      candidate,
      brief: briefed?.fold.brief ?? supplied ?? ladderBrief(snapshot, staged, candidate),
      briefProvenance: briefed?.fold.provenance ??
        (supplied ? { kind: "supplied" } : { kind: "deterministic" }),
      origin: "user",
      ordinal: markOrdinal(snapshot),
    });
    // Drop the standing mark over this exact span before adding, so a re-mark is a
    // replacement rather than a duplicate refusal. `claimed` is this same mark by the
    // check above, and the id is derived from the span, so the state after is the
    // state a first mark with the new brief would have produced.
    const replaced = claimed !== null;
    if (replaced) {
      staged = withPendingMarks(staged,
        pendingMarks(staged).filter((standing) => standing.id !== replacing));
    }
    const addition = addPendingMark(staged, mark);
    if (!addition.added) {
      return {
        mark: { id: mark.id, kind: mark.kind, ok: false, deferred: false, reason: addition.reason },
        corrections,
        staged,
      };
    }
    staged = addition.state;
    return {
      mark: {
        id: mark.id,
        kind: mark.kind,
        ok: true,
        deferred,
        ...(replaced ? { replaced: true } : {}),
        ...(deferred
          ? {
            scheduled: "the span is still in the fresh window; this mark is held and folds at the " +
              "first commit after it ages out",
          }
          : {}),
        brief: mark.brief,
        provenance: normalizeLegacyProvenance(mark.briefProvenance),
      },
      corrections,
      staged,
    };
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
    // A deleted action is refused BY NAME rather than by "not enabled": the two are
    // different facts, and an agent told a verb is merely off will keep offering it.
    if (Object.prototype.hasOwnProperty.call(RETIRED_TOOL_ACTIONS, action)) {
      throw new Error(RETIRED_TOOL_ACTIONS[action]);
    }
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
      const paged = detail === "folds" || detail === "objects";
      const accounting = markAccounting(snapshot, persistence.state);
      return toolPayload(boundStatusPayload({
        ...activeContextStatus(
          snapshot,
          persistence.state,
          statusOffset,
          statusLimit,
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
          refoldRatio: snapshot.policy.refoldRatio,
          chapterPrepareRatio: snapshot.policy.prepareRatio,
          hardFenceRatio: hardFenceRatio(snapshot),
          thresholds: { ...snapshot.thresholds },
          zones: {
            budgetTokens: snapshot.budgetTokens,
          },
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
            contextCalls: curation.contextCalls,
            receipts: curation.receipts.map((receipt) => ({ ...receipt })),
          },
          recovery: {
            attempts: curation.recoveryAttempts,
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
          projectionMarginTokens: measurements.lastProjectedEstimate === null
            ? null
            : projectionMarginTokens(measurements.lastProjectedEstimate, currentCapacity(ctx).window),
          projectionEstimatedTokens: measurements.lastProjectedEstimate,
          projectionEstimateBasis: measurements.lastProjectedEstimateBasis,
          projectionAnchorTokens: measurements.projectionAnchor?.tokens ?? null,
          automaticSuspended: ladder.automaticFailure !== null,
          automaticFailure: ladder.automaticFailure ? clone(ladder.automaticFailure) : null,
          lastCompactionDecision: nativeCompaction.lastThresholdDecision,
          scheduling: schedulingStatus({
            snapshot,
            state: persistence.state,
            ratio: measurements.latestRatio,
          }),
          // WHAT THE RUNTIME HAS CUT AND NOT YET FOLDED, by name, because the agent needs
          // an id to brief one and a notice it saw two turns ago is not a reference. Read
          // from the LIVE state rather than the durable record: a frontier cut is derived
          // from its span and is not written on its own, so the durable record is behind
          // by design and only a brief or a commit brings it forward.
          pendingFolds: pendingMarks(persistence.state).map((mark) => ({
            id: mark.id,
            kind: mark.kind,
            tokens: estimatedTokens(markFreedBytes(snapshot, persistence.state!, mark)),
            briefed: mark.briefProvenance?.kind === "supplied" ||
              mark.briefProvenance?.kind === "augmented",
            brief: mark.brief ?? null,
            briefProvenance: mark.briefProvenance ? clone(mark.briefProvenance) : null,
          })),
          nativeSummaries: "disabled",
          instrumentation: {
            enabled: true,
            ...ledgerSummary(instrumentation.ledger),
            projectionRecords: clone(instrumentation.ledger.records),
            cacheObservations: clone(instrumentation.ledger.observations),
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
            generation: lifecycle.generation,
            measurementFresh: Boolean(measurements.lastProviderMeasurement &&
              durableProviderMeasurementMatches(measurements.lastProviderMeasurement)),
            automaticFailure: ladder.automaticFailure !== null,
            preparing: Boolean(ladder.preparing),
          }),
        } : {}),
        ...(detail === "tree" ? { tree: foldTreeDetail(snapshot, persistence.state).slice(statusOffset) } : {}),
      }, typeof detail === "string" ? detail : null, statusOffset));
    }
    if (action === "peek") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("peek requires id");
      if (params.ephemeral !== undefined && typeof params.ephemeral !== "boolean") {
        throw new Error("peek ephemeral must be a boolean");
      }
      const offset = boundedInteger(params.offset, 0, 0, 1_000_000_000, "offset");
      const sliceBytes = boundedInteger(
        params.bytes,
        PEEK_DEFAULT_MAX_BYTES,
        PEEK_MIN_SLICE_BYTES,
        snapshot.policy.maxSourceChars,
        "bytes",
      );
      const target = persistence.state.folds.find((item) => item.id === id);
      // A CLIPPED RESULT ANSWERS TO ITS ENTRY ID (2026-08-24, the tool-call diet): the
      // clip marker names the entry, and the full bytes are in the transcript rather
      // than behind a fold, so the read serves them from the mapped message directly,
      // through the same admission fence and the same slice bounds as a fold peek.
      if (!target) {
        const clip = (persistence.state.clips ?? []).find((item) =>
          item.entryId === id || item.callId === id);
        if (clip) {
          const mapped = snapshot.mapped.find((item) => item.ref?.entryId === clip.entryId);
          if (!mapped) throw new Error(`Clipped result ${id} is no longer on this branch`);
          const full = contentText(snapshot.messages[mapped.index]);
          admit({
            action: "peek",
            ctx,
            foldId: clip.entryId,
            requestedBytes: Math.max(0, Math.min(sliceBytes, full.length - offset)),
            children: [],
          });
          const slice = full.slice(offset, offset + sliceBytes);
          return toolPayload({
            id: clip.entryId,
            source: slice,
            truncated: offset + slice.length < full.length,
            sourceChars: full.length,
            offset,
            ...(peekIsEphemeral(params) ? {
              ephemeral: "this result rides your context exactly until your next message; " +
                "extract what your current task needs into that reply, which takes over its " +
                "place. Peeking again is lossless and cheap; pass ephemeral false when you " +
                "need these bytes standing for several turns",
            } : { durable: "this result stays in your context like any other tool result" }),
          });
        }
        throw new Error(`Unknown active-context fold ${id}`);
      }
      admit({
        action: "peek",
        ctx,
        foldId: id,
        requestedBytes: Math.max(0, Math.min(sliceBytes, target.sourceChars - offset)),
        children: childFoldIds(target),
      });
      const payload = toolPayload({
        ...peekFoldSource({
          foldId: id,
          state: persistence.state,
          entries: ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch(),
          sessionId: ctx.sessionManager.getSessionId(),
          maximumBytes: sliceBytes,
          offset,
          toolName,
        }),
        ...(peekIsEphemeral(params) ? {
          ephemeral: "this result rides your context exactly until your next message; " +
            "extract what your current task needs into that reply, which takes over its " +
            "place. Peeking again is lossless and cheap; pass ephemeral false when you " +
            "need these bytes standing for several turns",
        } : { durable: "this result stays in your context like any other tool result" }),
      });
      return payload;
    }
    if (action === "reboundary") {
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
        // Re-cut whole, for the same reason a mark is taken whole: the agent named this
        // boundary, and splitting it hands one brief to several folds that each hold a
        // fraction of what it describes.
        for (const part of [recut]) {
          const durable = persistence.persistedFoldRecords.get(foldIdFor(part.kind, part.parts));
          const { preparedFold, nextState } = await prepareAndCommitExplicit({
            // A re-cut carries the durable fold's OWN brief and provenance: those words
            // were validated when they were first accepted, and re-judging them as a
            // fresh agent submission would refuse a deterministic or composed brief
            // against the agent's reserve.
            snapshot, candidate: part, brief: durable ? durable.fold.brief : supplied,
            briefProvenance: durable ? durable.fold.provenance : undefined, ctx, signal,
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
        await persistManual(persistence.state, ctx);
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
      await persistManual({ ...next, leases }, ctx);
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
      }
      let next = setFoldProjectionState(persistence.state, id, action === "expand" ? "expanded" : "folded");
      if (action === "expand") next = withExpandLease(next, id);
      else {
        const leases = { ...next.leases };
        delete leases[id];
        next = { ...next, leases };
      }
      await persistManual(next, ctx);
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
    if (action === "pin" || action === "unpin") {
      const ids = stringIds(params.ids);
      await applyProtectionChange(snapshot, ids, action === "pin", ctx);
      const refsAfter = persistence.state!.protected.length;
      // A PIN IS A CLAIM ON THE WINDOW, so it answers with the same picture a mark does.
      // It never pays the drop, and saying so here is what stops an agent pinning its way
      // to a coverage it does not have.
      const pinCapacity = servingCapacity(snapshot.contextWindow);
      const pinClaims = windowClaims({
        snapshot,
        state: persistence.state,
        budgetTokens: pinCapacity.budgetTokens,
        charsPerToken: projectionCharsPerToken(),
      });
      const pinCoverage = commitCoverage({
        snapshot,
        state: persistence.state,
        usedTokens: pinCapacity.usedTokens,
        budgetTokens: pinCapacity.budgetTokens,
      });
      return toolPayload({
        version: 1,
        action,
        ids,
        protectedRefs: refsAfter,
        pinnedTokens: pinClaims.pinnedTokens,
        pinnedShare: pinClaims.pinnedShare,
        maxPinnedShare: MAX_PINNED_SHARE,
        markedTowardCommitTokens: pinClaims.markedTokens,
        unclaimedTokens: pinClaims.unclaimedTokens,
        commitTargetTokens: pinCoverage.targetTokens,
        unmarkedAgainstCommitTokens: pinCoverage.remainingTokens,
        activation: action === "pin"
          ? "durable immediately; projected on the next model call in this same turn. " +
            "Pinned entries stay RAW and are never folded, automatically or by a mark, so " +
            "this is how you keep a span expanded. It frees nothing: the next commit still " +
            "has to reach its drop from what is left, so pinned mass makes the rest of the " +
            "window fold sooner rather than later."
          : "durable immediately; projected on the next model call in this same turn. The " +
            "released entries are foldable again and rejoin the next commit's candidates.",
      });
    }
    if (action === "unmark") {
      const removed = await withdrawMarks(stringIds(params.ids), ctx);
      const accounting = markAccounting(snapshot, persistence.state!);
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
    if (action === "brief") {
      // THE ONE EDIT THAT IS FREE. A pending mark is not in the window, so writing its
      // brief moves no bytes and costs no prefix cache; the brief reaches the projection
      // only when the commit writes that placeholder for the first time. A STANDING fold
      // is the opposite case and is refused by name: its placeholder is already in the
      // window, and rewriting it breaks the cache from that point on, which is the
      // rebrief deletion of 2026-08-21 read from the other side.
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("brief needs the id of a pending fold");
      const standing = persistence.state!.folds.find((fold) => fold.id === id);
      if (standing) {
        throw new Error(
          `${id} is a standing fold, not a pending one, so its brief is already in your ` +
          "window and rewriting it would rewrite the projection from that placeholder on. " +
          `Read it with ${toolName} {"action":"peek","id":"${id}"}, or re-cut the span with ` +
          `${toolName} {"action":"reboundary","ids":[...]} if the boundary is wrong.`,
        );
      }
      const held = pendingMarks(persistence.state!);
      const target = held.find((mark) => mark.id === id);
      if (!target) {
        const names = held.slice(0, 5).map((mark) => mark.id).join(", ");
        throw new Error(
          `No pending fold ${id}. ${held.length
            ? `The folds waiting for a brief are: ${names}${held.length > 5 ? ", ..." : ""}.`
            : "Nothing is pending right now, so there is nothing to brief."}`,
        );
      }
      const text = String(params.brief ?? "").trim();
      const complaint = briefContractComplaint(text, snapshot.policy.agentBriefReserve, snapshot.toolName);
      if (complaint !== null) throw new Error(`Supplied brief rejected. ${complaint}`);
      const nextState = {
        ...persistence.state!,
        revision: persistence.state!.revision + 1,
        pendingMarks: held.map((mark) => mark.id === id
          ? { ...mark, brief: text, briefProvenance: { kind: "supplied" as const } }
          : mark),
      };
      persistence.state = nextState;
      await persistManual(nextState, ctx);
      updateStatus(ctx);
      emit("context.brief", { id, chars: text.length, origin: "agent" });
      const accounting = markAccounting(snapshot, persistence.state!);
      const remainder = unmarkedRemainder(snapshot, persistence.state!, projectionCharsPerToken());
      return toolPayload({
        version: 1,
        action,
        id,
        kind: target.kind,
        brief: text,
        provenance: "agent",
        argumentsSha256: executionArgumentsSha256,
        durableRevision: persistence.state!.revision,
        pendingMarks: accounting.pending,
        unbriefed: pendingMarks(persistence.state!)
          .filter((mark) => mark.briefProvenance?.kind !== "supplied" &&
            mark.briefProvenance?.kind !== "augmented").map((mark) => mark.id),
        unmarkedSpans: remainder.spans,
        unmarkedTokens: remainder.tokens,
        activation: "durable immediately, and it costs your window nothing: this fold is " +
          "pending, so the brief you just wrote is stored outside the projection and " +
          "reaches it only when the commit folds this span. Nothing in your context moved.",
      });
    }
    throw new Error(`Unknown ${toolName} action '${action}'`);
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
      curation.contextCalls += 1;
      const attempt = (ok: boolean, error: string | null, corrections: Array<Record<string, unknown>>) => {
        const record = emit("context.attempt", {
          action,
          ok,
          error,
          tool_call_id: toolCallId,
          corrections_applied: corrections.length,
          arguments_sha256: sha256Value(params ?? {}),
          ...(action === "peek" ? { ephemeral: peekIsEphemeral(params) } : {}),
        });
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
        if (action === "peek" && peekIsEphemeral(params)) ephemeralPeeks.add(toolCallId);
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
      const capacity = currentCapacity(ctx);
      const staged = pendingMarks(persistence.state);
      safeNotify(ctx, foldStatusText({
        brand: brandNoun,
        usedTokens: measurements.lastProviderMeasurement?.tokens ?? null,
        budgetTokens: capacity.budgetTokens,
        commitAtShare: snapshot.thresholds.maxTarget,
        aimShare: snapshot.thresholds.minTarget,
        roots: (status.roots as string[]).length,
        totalFolds: Number(status.totalFolds ?? 0),
        stagedMarks: staged.length,
        stagedTokens: staged.reduce((total, mark) =>
          total + estimatedTokens(markFreedBytes(snapshot, persistence.state!, mark)), 0),
        pinned: persistence.state.protected.length,
        suspended: ladder.automaticFailure?.message ?? null,
        foldCommand: `/${commandNames.fold}`,
        editorCommand: "/fold-editor",
      }), "info");
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
      // BARE /fold IS THE COMMIT (Shane, dogfooding 2026-08-22): staging is the
      // normal accumulation and applying it is the default verb. The old bare behavior
      // rescue-folded an auto-offered chapter, which read as the command ignoring the
      // staged pile; a rescue now needs explicit ids.
      if (!selector || selector === "commit") {
        const capacity = servingCapacity(snapshot.contextWindow);
        const occupancy = capacity.usedTokens !== null && capacity.budgetTokens > 0
          ? capacity.usedTokens / capacity.budgetTokens
          : null;
        const topUp = occupancy !== null && occupancy >= thresholds.maxTarget;
        const committed = await runCommitEpoch(snapshot, "user-command", topUp, measurements.latestRatio, true);
        // Until this lands the epoch's folds are in the event stream and nowhere else.
        // Swallowing the failure here announced a commit that does not exist and left the
        // session computing folds it would keep throwing away, which is the dead session
        // gate 122 was built for, reached through the user's own command instead.
        try { await persist(ctx); }
        catch (error) {
          suspendAutomatic(error, "user-command", ctx);
          updateStatus(ctx);
          throw error;
        }
        updateStatus(ctx);
        safeNotify(
          ctx,
          committed
            ? `Committed ${ownValue(committed, "applied_marks") ?? 0} mark(s)${topUp ? " with automatic top-up" : ""}. ` +
              "Exact source remains expandable."
            : "Nothing to commit: no staged mark could apply (pinned or already-folded spans hold).",
          "info",
        );
        return;
      }
      const supplied = (divider >= 0 ? args.slice(divider + 4) : "").trim() || undefined;
      const ids = selector ? selector.replace(/\.\./g, " ").split(/[\s,]+/).filter(Boolean) : [];
      if (!ids.length) {
        throw new Error(
          "Nothing to rescue without ids: /fold with no arguments commits every staged mark; " +
            "name the span to fold now (/fold <start-id> [end-id] -- brief)",
        );
      }
      const candidate = manualFoldCandidate(snapshot, persistence.state!, ids);
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
      safeNotify(ctx, `Context command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  /**
   * /fold-editor, V2.2. The handler assembles a plain data snapshot of the working
   * window and hands it to the view; the view holds no runtime reference and no
   * mutation path. What changed in V2.2: raw entries are MARK POINTS, and a span
   * laid down between two of them stages through `stageFoldMarks` -- the SAME
   * validated path the tool's fold action runs -- with origin "user". The view
   * computes nothing but the arithmetic it is handed (spanCost) and reports one
   * intent (onStageMark); this handler owns every state transition.
   */
  const foldEditorCommandHandler = async (_args: string, ctx: any): Promise<void> => {
    if (typeof ctx.ui?.custom !== "function") {
      throw new Error("/fold-editor needs an interactive UI; use /fold-status for the text form");
    }
    const snapshot = lifecycle.latestSnapshot
      ? authoritativeSnapshotFor(ctx)
      : snapshotForEvent(ctx, ctx.sessionManager.buildSessionContext().messages);
    if (!lifecycle.latestSnapshot) lifecycle.latestSnapshot = snapshot;
    if (!persistence.state) throw new Error("The context window is empty; there is nothing to show yet");

    // THE WOULD-BE FOLD SIZE (Shane, 2026-08-23). The footer's number while a span is
    // being laid down is the runtime's own estimate -- span bytes over the mapped
    // window at ESTIMATED_BYTES_PER_TOKEN -- so what the user sees before staging is
    // what the staged mark answers with after it.
    const spanCost = (from: number, to: number) => ({
      entries: Math.abs(to - from) + 1,
      tokens: estimatedTokens(spanBytes(snapshot, Math.min(from, to), Math.max(from, to) + 1)),
    });

    // Marks move no bytes until the commit, so window geometry cannot change while
    // the editor holds it open; only pending state grows. Rebuilding against the SAME
    // snapshot with fresh state keeps PROPOSED rows honest without re-deriving indices.
    const buildData = () => {
      const state = persistence.state!;
      const capacity = servingCapacity(snapshot.contextWindow);
      const occupancy = capacity.usedTokens !== null && capacity.budgetTokens > 0
        ? capacity.usedTokens / capacity.budgetTokens
        : null;
      const accounting = markAccounting(snapshot, state);
      return {
        // NO SESSION ID. Eight hex characters of a value a person never types, on the
        // title line of the surface, is the same defect the rows below it just lost.
        title: `${brandNoun} window`,
        occupancy: {
          usedTokens: capacity.usedTokens,
          budgetTokens: capacity.budgetTokens,
          commitOccupancy: thresholds.maxTarget,
          commitDue: occupancy !== null && occupancy >= thresholds.maxTarget,
          suspended: Boolean(ladder.automaticFailure),
        },
        blocks: buildFoldEditorData(snapshot, state, {
          foldRows: () => (state.folds ?? []).map((fold: any) => {
            const row = foldIndexRow(fold, state, snapshot);
            const entries = flattenFoldRefs(fold, state)
              .map((ref) => {
                const item = exactMapped(snapshot, ref);
                const message = item?.message as Record<string, unknown> | undefined;
                const role = String(item?.ref?.role ?? message?.role ?? "entry");
                const content = message?.content;
                let preview = "";
                if (typeof content === "string") preview = content.slice(0, 300);
                else if (Array.isArray(content)) {
                  const firstText = content.find((part) => part?.type === "text");
                  preview = typeof firstText?.text === "string" ? firstText.text.slice(0, 300) : "";
                }
                return { id: ref.entryId, role, preview: preview.replace(/\s+/g, " ") };
              });
            return {
              id: String(row.id),
              kind: String(row.kind ?? ""),
              brief: String(row.brief ?? ""),
              sourceCount: Number(row.sourceCount ?? 0),
              startPosition: Number(row.startPosition),
              endPosition: Number(row.endPosition),
              entries,
            };
          }),
          pendingMarkRefs: () => pendingMarks(state)
            .filter((mark) => mark.mark === "fold")
            .map((mark) => ({
              id: mark.id,
              origin: String(mark.origin),
              brief: String(mark.brief ?? ""),
              // WHAT THE STAGED MARK FREES, so a PROPOSED row states its size the
              // way the footer prices an unstaged span.
              ...(typeof markFreedBytes(snapshot, state, mark) === "number"
                ? { tokens: estimatedTokens(markFreedBytes(snapshot, state, mark)) }
                : {}),
              entryIds: markSpanRefs(state, mark).refs
                .map((ref) => ref.entryId)
                .filter((entryId): entryId is string => Boolean(entryId)),
            })),
          mappedRange: (from: number, to: number) => {
            const out: Array<{ id: string; role: string; preview: string; index?: number }> = [];
            for (let index = from; index <= to; index += 1) {
              const item = snapshot.mapped[index];
              if (!item) continue;
              const message = item.message as Record<string, unknown> | undefined;
              const role = String(item.ref?.role ?? message?.role ?? "entry");
              const content = message?.content;
              // 300 chars, same as fold entries: the view shows 48 on the row and
              // deepens to 240 on Enter, so a 48-char preview made detail a no-op.
              let preview = "";
              if (typeof content === "string") preview = content.slice(0, 300);
              else if (Array.isArray(content)) {
                const firstText = content.find((part) => part?.type === "text");
                preview = typeof firstText?.text === "string" ? firstText.text.slice(0, 300) : "";
              }
              // THE INDEX IS THE MARK POINT: raw entries carry their mapped position so
              // the view can price a span and name its two boundary ids.
              out.push({
                id: item.ref?.entryId ?? String(index),
                role,
                preview: preview.replace(/\s+/g, " "),
                ...(item.ref?.entryId ? { index } : {}),
              });
            }
            return out;
          },
          entryCount: snapshot.mapped.length,
        }),
        pending: {
          count: pendingMarks(state).length,
          agentMarks: accounting.agentMarks,
          ladderMarks: accounting.ladderMarks,
          userMarks: accounting.userMarks,
          freedTokens: accounting.freedTokens,
        },
        pinned: state.protected.map((ref) => ref.entryId),
      };
    };

    let view: FoldEditorView | null = null;
    const runQueued = async (work: () => Promise<void>): Promise<void> => {
      const operation = ladder.actionQueue.then(work);
      ladder.actionQueue = operation.catch(() => undefined);
      await operation;
    };
    const refreshAfter = (): void => {
      if (view) view.refresh(buildData());
    };
    const editorActions = {
      spanCost,
      onStageMark: async (fromId: string, toId: string, brief?: string): Promise<void> => {
        await runQueued(async () => {
          const fresh = authoritativeSnapshotFor(ctx);
          const { mark, staged } = await stageFoldMark(
            [fromId, toId], brief && brief.trim() ? brief.trim() : undefined,
            new AbortController().signal, ctx, fresh);
          // Refuse BEFORE persisting: a refused mark leaves state untouched and
          // persisting it would be a no-op write against the same-state projection.
          if (mark.ok !== true) throw new Error(String(mark.reason ?? "the span was refused"));
          await persistManual(staged, ctx);
          updateStatus(ctx);
        });
        safeNotify(ctx, "Staged user mark(s); they apply at the next commit epoch.", "info");
        refreshAfter();
      },
      onWithdrawMark: async (markId: string): Promise<void> => {
        let removed: Array<Record<string, unknown>> = [];
        await runQueued(async () => {
          removed = await withdrawMarks([markId], ctx) as Array<Record<string, unknown>>;
        });
        safeNotify(ctx,
          `Withdrew ${removed.length} staged mark(s); no context bytes moved.`, "info");
        refreshAfter();
      },
      onTogglePin: async (entryId: string): Promise<void> => {
        const pinnedAlready = persistence.state!.protected
          .some((ref: any) => ref.entryId === entryId);
        await runQueued(async () => {
          await applyProtectionChange(authoritativeSnapshotFor(ctx), [entryId], !pinnedAlready, ctx);
        });
        safeNotify(ctx, pinnedAlready
          ? "Unpinned: the released entries rejoin the next commit's candidates."
          : "Pinned raw: held through every fold; frees nothing toward the drop.", "info");
        refreshAfter();
      },
    };
    await ctx.ui.custom((
      _tui: unknown,
      theme: any,
      keybindings: { matches(data: string, action: string): boolean } | null,
      done: () => void,
    ) => {
      view = new FoldEditorView(buildData(), done, keybindings, theme, editorActions);
      return view;
    });
    updateStatus(ctx);
  };

  pi.registerTool(buildActiveContextTool({
    name: toolName,
    label: toolLabel,
    allowedActions: allowedToolActions,
    fullSurface: true,
    maxBriefChars: ACTIVE_CONTEXT_POLICY.agentBriefReserve,
    statusDetails: ["fold_candidates", "tree", "folds", "objects"],
    minPeekSliceBytes: PEEK_MIN_SLICE_BYTES,
    defaultPeekBytes: PEEK_DEFAULT_MAX_BYTES,
    handler: toolHandler,
  }));
  for (const command of buildActiveContextCommands({
    statusName: commandNames.status,
    foldName: commandNames.fold,
    editorName: "fold-editor",
    statusHandler: statusCommandHandler,
    foldHandler: foldCommandHandler,
    editorHandler: foldEditorCommandHandler,
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
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { }
  });

  return { projectionCandidates };
}
