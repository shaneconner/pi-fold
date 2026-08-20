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
  briefContractComplaint,
  commitPreparedFold,
  descendantIds,
  encodedFoldSource,
  foldCandidatesDetail,
  foldTreeDetail,
  peekFoldSource,
  prepareFold,
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
  exactMapped,
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
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES,
  DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
  DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  COMMIT_RECLAIM_FLOOR_SHARE,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_CONTEXT_WINDOW,
  resolveGuidance,
  assertThresholdsServable,
  resolveThresholds,
  servingBudgetTokens,
  ESTIMATED_BYTES_PER_TOKEN,
  entryTypeNamespace,
  MAX_FOLD_SPAN_CHARS,
  MAX_PINNED_SHARE,
  MAX_WEDGE_ABSORB_TOKENS,
  PEEK_DEFAULT_MAX_BYTES,
  PEEK_MIN_SLICE_BYTES,
  PEEK_READ_ONLY_CONTEXT_ACTIONS,
  AUTO_FOLD_BLACKLIST_DEFAULT,
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
  markAwarenessText,
  receiptBlockText,
  stewardAdvisoryText,
  withReceipt,
} from "./lib/curation.ts";
import type {
  ContextReceipt,
} from "./lib/curation.ts";
import {
  addPendingMark,
  claimedRefKeys,
  commitPendingMarks,
  consolidationMarks,
  ephemeralPeekMarks,
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
  candidateSpanChars,
  manualFoldCandidate,
  peekedSourceFoldIds,
  selectAutomaticToolBatch,
  snapFoldCandidate,
  snapToFoldBoundaries,
  splitCandidateBySize,
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

export type ProjectionReadingBasis = "anchored" | "rewritten" | "unmeasured";

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
export * from "./lib/transcript.ts";

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
  toolName?: string;
  toolLabel?: string;
  brandNoun?: string;
  entryTypePrefix?: string;
  commandNames?: { status?: string; fold?: string };
  blacklistAutoFoldTools?: ReadonlySet<string>;
  providerInputBudget?: number;
  thresholds?: ActiveContextThresholds;
  guidance?: Partial<ActiveContextGuidance>;
}): {
  projectionCandidates: (ctx: any) => Array<Record<string, unknown>>;
} {
  const toolName = options.toolName ?? DEFAULT_ACTIVE_CONTEXT_TOOL_NAME;
  const toolLabel = options.toolLabel ?? DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL;
  const brandNoun = options.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN;
  const entryTypePrefix = options.entryTypePrefix ?? DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
  const blacklistAutoFoldTools = options.blacklistAutoFoldTools ?? AUTO_FOLD_BLACKLIST_DEFAULT;
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
  const thresholds = resolveThresholds(options.thresholds);
  assertThresholdsServable(thresholds, providerInputBudget ?? servingBudgetTokens(DEFAULT_CONTEXT_WINDOW));
  const guidance = resolveGuidance(options.guidance);
  const stateEntryType = `${entryTypePrefix}-state`;
  const foldRecordEntryType = `${entryTypePrefix}-fold-record`;
  const milestoneProjectionType = `${entryTypePrefix}-milestone`;
  const advisoryProjectionType = `${entryTypePrefix}-advisory`;
  const receiptProjectionType = `${entryTypePrefix}-receipts`;
  const riderProjectionType = `${entryTypePrefix}-rider`;
  const stewardProjectionType = `${entryTypePrefix}-steward`;
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
    projectionCalibrations: [] as Array<{ chars: number; tokens: number }>,
    lastProjectedEstimate: null as number | null,
    lastProjectedEstimateCalibrated: false,
    lastProjectedEstimateBasis: "unmeasured" as ProjectionReadingBasis,
    lastProjectedSizeTokens: null as number | null,
    projectionAnchor: null as {
      tokens: number;
      chars: number;
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

  const advisory = {
    hardFenceNoticeKey: null as string | null,
    hardFenceReleaseSessionId: null as string | null,
    hardFenceReleasedProjectionKeys: new Set<string>(),
    stewardCrossingActive: false,
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
    "context.commit", "context.fold", "context.absorb", "context.split", "context.recovery",
  ]);
  const CACHE_ACTION_REQUEST_CLASS: Readonly<Record<string, string>> = Object.freeze({
    fold: "after-mark",
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
      split_folds: receipt.splitFolds,
      split_from_chars: receipt.splitFromChars,
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

  const updateStatus = (ctx: any): void => {
    try {
      const roots = persistence.state && lifecycle.latestSnapshot ? orderedRoots(persistence.state, lifecycle.latestSnapshot).length : 0;
      const prepared = persistence.state?.prepared ? " · brief ready" : ladder.preparing ? " · briefing" : "";
      const usage = measurements.lastProviderMeasurement
        ? ` · provider ${measurements.lastProviderMeasurement.tokens}/${measurements.lastProviderMeasurement.contextWindow}`
        : " · provider usage unmeasured";
      const suspended = ladder.automaticFailure ? " · automatic suspended" : "";
      ctx.ui?.setStatus?.(entryTypePrefix, `${toolName} folds: ${roots}${prepared}${usage}${suspended}`);
    } catch { }
  };

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
    advisory.hardFenceNoticeKey = null;
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
        freshTail: snapshot.thresholds.freshTail,
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

  const abortUnsafeHardContext = (
    snapshot: ActiveContextSnapshot | null,
    ctx: any,
    allowUnmeasuredRevisionRelease = false,
  ): boolean => {
    if (measurements.latestRatio === null || measurements.latestRatio < hardFenceRatio(snapshot ?? undefined, ctx) || !persistence.state) return false;
    const measuredRevision = measurements.lastProviderMeasurement
      ? measurements.providerMeasurementRevisionByMessageSha.get(measurements.lastProviderMeasurement.messageSha256)
      : undefined;
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
    if (typeof ctx.abort !== "function") {
      throw new Error(`Pi hard-fence abort capability is unavailable at ratio ${measurements.latestRatio}`);
    }
    ctx.abort();
    return true;
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
    if (!(measurement.tokens > 0) || chars / measurement.tokens < PROJECTION_CHARS_PER_TOKEN_FLOOR) {
      measurements.projectionAnchor = null;
      return;
    }
    measurements.projectionAnchor = {
      tokens: measurement.tokens,
      chars,
      head: text.slice(0, -1),
      messageSha256: measurement.messageSha256,
      sessionId: persistence.state.sessionId,
      generation: lifecycle.generation,
    };
  };

  const projectedTokenReading = (projected: unknown[]): {
    tokens: number;
    basis: ProjectionReadingBasis;
    chars: number;
    anchorTokens: number | null;
    deltaChars: number | null;
  } => {
    const text = stableStringify(projected);
    const chars = Buffer.byteLength(text, "utf8");
    const charsPerToken = projectionCharsPerToken();
    const estimate = Math.ceil(chars / charsPerToken);
    const anchor = measurements.projectionAnchor;
    if (!anchor || anchor.generation !== lifecycle.generation ||
        anchor.sessionId !== persistence.state?.sessionId) {
      return { tokens: estimate, basis: "unmeasured", chars, anchorTokens: null, deltaChars: null };
    }
    const separator = text.length > anchor.head.length ? text[anchor.head.length] : "";
    if (!text.startsWith(anchor.head) || (separator !== "," && separator !== "]")) {
      return { tokens: estimate, basis: "rewritten", chars, anchorTokens: anchor.tokens, deltaChars: null };
    }
    const deltaChars = chars - anchor.chars;
    return {
      tokens: Math.max(0, anchor.tokens + Math.ceil(deltaChars / charsPerToken)),
      basis: "anchored",
      chars,
      anchorTokens: anchor.tokens,
      deltaChars,
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

  const projectionExceedsBudget = (projected: unknown[], ctx: any): {
    tokens: number;
    sizeTokens: number;
    basis: ProjectionReadingBasis;
    budgetTokens: number;
    marginTokens: number;
    over: boolean;
    crowded: boolean;
  } => {
    const capacity = currentCapacity(ctx);
    const budgetTokens = Number.isFinite(capacity.budgetTokens) && capacity.budgetTokens > 0
      ? capacity.budgetTokens
      : Number.POSITIVE_INFINITY;
    const reading = projectedTokenReading(projected);
    const tokens = reading.tokens;
    const sizeTokens = Math.ceil(reading.chars / projectionCharsPerToken());
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

  const enforceProjectionBudget = async (
    snapshot: ActiveContextSnapshot,
    projected: unknown[],
    ctx: any,
  ): Promise<{ projected: unknown[]; aborted: boolean }> => {
    let measured = projectionExceedsBudget(projected, ctx);
    const rejected = curation.pendingRejection !== null;
    if (!measured.crowded && !rejected) return { projected, aborted: false };
    const trigger = measured;
    let reduced = projected;
    let attempts = 0;
    let reducedAtLeastOnce = false;
    while (measured.crowded || measured.over || rejected) {
      attempts += 1;
      // THE EMERGENCY IS THE REQUEST THAT WILL NOT FIT, and only that. A projection at
      // the margin is ordinary work: the fence commits it because it is the pass holding
      // the request, but it is not a recovery, it does not waive the current-turn guard,
      // and it does not buy an exemption from the reclaim floor. Waiving at the margin
      // spends the open turn's own evidence on headroom the boundary was about to buy.
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
    if (!measured.over) return { projected: reduced, aborted: false };
    abortOverBudgetProjection(measured.tokens, measured.budgetTokens, ctx, attempts);
    return { projected: reduced, aborted: true };
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

  const stewardReading = (
    snapshot: ActiveContextSnapshot,
  ): { text: string; facts: Record<string, unknown> } | null => {
    const capacity = servingCapacity(snapshot.contextWindow);
    const used = capacity.usedTokens;
    const budget = capacity.budgetTokens;
    const inflow = expectedWallInflowTokens();
    if (used === null || !(budget > 0) || !(inflow > 0)) return null;
    // The steward band sits one inflow step ahead of the wall's own: the agent gets
    // roughly one request's worth of room to mark finished units with its own briefs
    // before the band-top epoch takes the remainder with deterministic ones. Inside
    // the wall band and past the budget the existing lanes own the moment, so the
    // advisory stands down exactly where they stand up, and with no measured inflow
    // pairing there is no band at all.
    if (used + inflow > budget) return null;
    if (used + 2 * inflow <= budget) return null;
    const state = persistence.state!;
    const remainder = unmarkedRemainder(snapshot, state, projectionCharsPerToken());
    // Under real pressure the ladder has already claimed every completed batch
    // by the time the band is reached (sol-20260820-steward rep 2: 111 folds,
    // zero unclaimed candidates at every band moment, every rider's anchors 0),
    // so the durable invitation is the one the agent can always act on: the
    // newest standing folds whose briefs are not the agent's own, correctable
    // through rebrief. Newest first, because a brief worth writing needs the
    // agent to still remember what the fold holds; an expanded fold is visible
    // raw and needs no brief right now.
    // Only a fold whose BRIEF actually renders is worth rebriefing: the offline
    // brief-function study (2026-08-20) measured visible carriage at 43 percent
    // natural and ZERO seeded because consolidation parents dilute their
    // children's briefs to subject lines, so a hidden child's brief carries
    // nothing however good it is. The walk mirrors the projection's own render
    // rule: a collapsed fold shows its brief; a revealed one shows its parts.
    const visibleBriefFolds: ActiveFold[] = [];
    const byFoldId = new Map(state.folds.map((fold) => [fold.id, fold]));
    const walkVisible = (fold: ActiveFold): void => {
      const refs = flattenFoldRefs(fold, state);
      const revealed = state.expanded.includes(fold.id) || (fold.kind === "tool-result"
        ? toolRefsProtected(refs, state, snapshot)
        : refsProtected(refs, state, snapshot));
      if (!revealed) {
        visibleBriefFolds.push(fold);
        return;
      }
      for (const part of fold.parts) {
        if (part.kind !== "raw") {
          const child = byFoldId.get(part.foldId);
          if (child) walkVisible(child);
        }
      }
    };
    for (const fold of state.folds) if (fold.parentId === null) walkVisible(fold);
    // Largest first: the fold covering the most source has the most diluted
    // brief (a consolidation parent's 2,000 chars divide across about ten
    // children per level), so it is where a rebrief buys the most carriage.
    // Consolidation parents are by construction the largest, which is exactly
    // the study's re-aim. Ties break newest first, while the agent still
    // remembers what the span holds.
    const rebriefTargets = visibleBriefFolds
      .map((fold, index) => ({ fold, index, refs: flattenFoldRefs(fold, state).length }))
      .filter(({ fold }) => !state.briefs?.[fold.id] &&
        foldProvenance(fold, state).kind !== "agent")
      .sort((a, b) => b.refs - a.refs || b.index - a.index)
      .slice(0, 3)
      .map(({ fold }) => ({
        id: fold.id,
        kind: fold.kind,
        briefHead: String(foldBrief(fold, state) ?? "").slice(0, 200),
      }));
    if (!remainder.candidates.length && !rebriefTargets.length) return null;
    const accounting = markAccounting(snapshot, state);
    const text = stewardAdvisoryText({
      toolName,
      brandNoun,
      usedTokens: used,
      budgetTokens: budget,
      inflowTokens: inflow,
      candidates: remainder.candidates,
      rebriefTargets,
      pendingAgentMarks: accounting.agentMarks,
      eligibleMarks: accounting.eligibleMarks,
    });
    return {
      text,
      facts: {
        used_tokens: used,
        budget_tokens: budget,
        inflow_tokens: inflow,
        unmarked_spans: remainder.spans,
        unmarked_tokens: remainder.tokens,
        largest_candidate: remainder.candidates[0]?.id ?? null,
        rebrief_targets: rebriefTargets.length,
        top_rebrief_target: rebriefTargets[0]?.id ?? null,
        pending_agent_marks: accounting.agentMarks,
        eligible_marks: accounting.eligibleMarks,
        chars: text.length,
      },
    };
  };

  const appendSteward = (projected: unknown[], snapshot: ActiveContextSnapshot): unknown[] => {
    // Unlike the rider, which persists until the next epoch replaces it, the
    // steward must be able to STAND DOWN: a frozen pass reuses the prior
    // projection as its prefix, so declining to append is not enough. Any
    // standing advisory is withdrawn first, and re-appended only while the
    // band condition still holds, which is the one-request carrier shape the
    // sealed ephemeral probe promoted.
    const reading = stewardReading(snapshot);
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      if (ownValue(projected[index], "customType") === stewardProjectionType) {
        projected.splice(index, 1);
      }
    }
    if (!reading) {
      advisory.stewardCrossingActive = false;
      return projected;
    }
    if (!advisory.stewardCrossingActive) {
      advisory.stewardCrossingActive = true;
      // The DIRECTED TURN is deleted (sol-20260820 reps 5-7, kill line fired
      // 2026-08-20): a followUp curation turn queued at this crossing elicited
      // 0, 1 and 9 rebriefs across three sealed reps on the same workload, the
      // engaged reps were the campaign's most expensive ($27.03 and $36.29
      // against an $18-21 advisory-era band) with the campaign's worst cache
      // share on the max-engagement rep (0.812, because every rebrief rewrites
      // the projection at its fold's placeholder), rep 7's nine rebriefs were
      // one end-of-session burst after the work they could have served, and no
      // measured outcome moved: the end block read 10/10 in every pifold rep
      // with or without them, because lossless peek already carries recall.
      // The crossing, its event and the appended advisory STAY as costless
      // instrumentation; a future model's voluntary uptake reads for free.
      emit("context.steward", reading.facts);
    }
    projected.push({
      role: "custom",
      customType: stewardProjectionType,
      content: reading.text,
      display: false,
      details: {
        source: activeContextSource(entryTypePrefix),
        ephemeral: true,
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
  // Runs against the BODY before the freeze reads it, so the one rewrite this
  // costs lands at the moment the answer does and the projection is stable on
  // every later pass. A message already projection-shaped (a fold's own
  // deterministic brief placeholder carries the same toolCallId) is never
  // touched: only the raw result is the ephemeral one.
  const withdrawConsumedEphemeralPeeks = (body: unknown[]): void => {
    if (!ephemeralPeeks.size) return;
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
      body[index] = {
        role: "toolResult",
        toolCallId: callId,
        toolName: ownValue(message, "toolName"),
        content: [{ type: "text", text: "Ephemeral peek consumed; the reply that followed it is the surviving trace." }],
        isError: false,
        details: { projection: "ephemeral-peek-consumed" },
        timestamp: ownValue(message, "timestamp"),
      };
    }
  };

  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const body = projectActiveContext(snapshot, persistence.state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType &&
        customType !== receiptProjectionType && customType !== stewardProjectionType &&
        customType !== riderProjectionType && customType !== curationProjectionType;
    });
    withdrawConsumedEphemeralPeeks(body);
    const held = freeze.body?.length ?? 0;
    freeze.active = freeze.projection !== null && body.length >= held &&
      stableStringify(body.slice(0, held)) === freeze.bodyText;
    const projected = freeze.active
      ? [...freeze.projection!, ...body.slice(held)]
      : [...body];
    if (!freeze.active) freeze.keys.clear();
    freeze.body = body;
    freeze.bodyText = stableStringify(body);
    appendReceipts(projected, snapshot);
    appendRider(projected, snapshot);
    appendSteward(projected, snapshot);
    return holdFrozen(projected);
  };
  const noteProjection = (projected: unknown[]): void => {
    const digests = messageDigests(projected);
    const comparison = compareProjections(instrumentation.previousDigests, digests);
    recordProjection(instrumentation.ledger, comparison, digests);
    instrumentation.previousDigests = digests;
    instrumentation.lastChange = comparison.change;
    const text = stableStringify(projected);
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
    const reading = projectedTokenReading(projected);
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
    const guarded = currentTurnRefKeys(snapshot);
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
    const freeingTarget = usedTokens === null || budgetTokens <= 0
      ? 0
      : Math.max(0, (usedTokens - thresholds.minTarget * budgetTokens) / budgetTokens);
    if (topUp) {
      for (const mark of topUpMarks({
        snapshot,
        state,
        ordinal,
        eligibleOnly: true,
        targetShare: freeingTarget,
      })) {
        const addition = addPendingMark(state, mark);
        if (addition.added) { state = addition.state; topUpAdded += 1; }
      }
      const reachedShare = markAccounting(snapshot, state).eligibleFreedBudgetShare;
      const shallow = reachedShare < Math.max(commitDepthFloorShare(snapshot), freeingTarget);
      if (shallow && atOrAboveBackstop(snapshot, waiverRatio)) {
        for (const mark of topUpMarks({
          snapshot,
          state,
          ordinal,
          eligibleOnly: true,
          targetShare: 1,
        })) {
          const addition = addPendingMark(state, mark);
          if (addition.added) { state = addition.state; topUpAdded += 1; }
        }
      }
    }
    const wedges = absorbWedgeMarks({
      snapshot,
      state,
      charsPerToken: projectionCharsPerToken(),
      excludeRefKeys: guarded,
    });
    state = wedges.state;
    const accounting = markAccounting(snapshot, state);
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
        window_tokens: snapshot.contextWindow,
      });
      return null;
    }
    const bytesBefore = bytes(projectActiveContext(snapshot, state));
    const guardWaiver = guardWaiverCount({
      snapshot,
      ratio: waiverRatio,
      boundary: trigger === "compaction-boundary",
      guardedMarks: pendingMarks(state).filter((mark) =>
        markTouchesCurrentTurn(state, mark, guarded)).length,
      otherApplicableMarks: pendingMarks(state).filter((mark) =>
        !markTouchesCurrentTurn(state, mark, guarded) &&
        markEligibility(snapshot, state, mark) === "eligible").length,
    });
    let result = await commitPendingMarks({
      snapshot,
      state,
      generation: lifecycle.generation,
      retainIneligible: true,
      guardCurrentTurn: true,
      guardWaiver,
    });
    for (;;) {
      let closing = result.state;
      for (const mark of consolidationMarks({ snapshot, state: closing, ordinal })) {
        const addition = addPendingMark(closing, mark);
        if (addition.added) { closing = addition.state; closingAdded += 1; }
      }
      if (closing === result.state) break;
      const closed = await commitPendingMarks({
        snapshot,
        state: closing,
        generation: lifecycle.generation,
        retainIneligible: true,
        guardCurrentTurn: true,
      });
      if (!closed.applied.length) break;
      result = {
        ...closed,
        applied: [...result.applied, ...closed.applied],
        refused: [...result.refused.filter((mark) => !mark.retained), ...closed.refused],
        waived: [...result.waived, ...closed.waived],
      };
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
      waived_marks: result.waived.length,
      pending_marks: accounting.pending,
      agent_marks: accounting.agentMarks,
      ladder_marks: accounting.ladderMarks,
      peek_marks: peekAdded,
      topup_marks: topUpAdded,
      consolidation_marks: consolidationAdded,
      closing_consolidation_marks: closingAdded,
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
        threshold_tokens: MAX_WEDGE_ABSORB_TOKENS,
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
      consolidationMarks: consolidationAdded,
      closingMarks: closingAdded,
      absorbedWedges: wedges.absorbed.length,
      absorbed: wedges.absorbed,
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
      splitFolds: Number(action.splitFolds ?? 0),
      splitFromChars: Number(action.splitFromChars ?? 0),
      absorbedWedges: Number(epoch?.absorbedWedges ?? 0),
      recovered: curation.recoveryAttempts > 0,
      protectedBytes: Number(epoch?.protectedStaleBytes ?? 0),
      note: null,
    }));
  };

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!persistence.state || ladder.automaticFailure || ladder.preparing) return null;
    const rungSelectionOptions = { toolOnly: rungOptions.toolOnly };
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
    // MARKING ONLY. Every mutation the rung used to perform inline -- a prepared chapter,
    // a tool fold, a refold, a consolidation, a chapter split -- now travels as a pending
    // mark and lands at the boundary, which is the one point the projection changes.
    // WHAT the rung decides is unchanged; WHEN it takes effect is.
    return markLadderSelection();
  };
  /**
   * The one durable transaction. Whatever it wraps either lands with its state persisted
   * or leaves the state it entered with, and a failure suspends folding by name rather
   * than being retried quietly. Marking and committing both go through it, which is why
   * a commit that vanishes at persistence (gate 122) and a suspension that says nothing
   * (gate 123) are single properties rather than one per caller.
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
  const attemptAutomaticRung = (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
  ): Promise<Record<string, unknown> | null> => queueAutomatic(
    snapshot, ratio, ctx, phase, () => applyAutomaticRung(snapshot, ratio, rungOptions),
  );
  /**
   * A COMMIT, THROUGH THE SAME TRANSACTION AND THE SAME QUEUE. Two callers reach it: the
   * compaction boundary, which is the ordinary one, and the projection fence, which is
   * the emergency one. The fence cannot wait for a boundary because the request it is
   * holding does not fit, so it commits in place; that is the one exception, and it is
   * the exception that already existed.
   */
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
      const budgeted = await enforceProjectionBudget(snapshot, projected, ctx);
      projected = budgeted.projected;
      const reading = projectedTokenReading(projected);
      measurements.lastProjectedChars = reading.chars;
      measurements.lastProjectedEstimate = reading.tokens;
      measurements.lastProjectedEstimateBasis = reading.basis;
      measurements.lastProjectedSizeTokens = Math.ceil(reading.chars / projectionCharsPerToken());
      measurements.lastProjectedEstimateCalibrated = measurements.projectionCalibrations.length > 0;
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
          refoldRatio: snapshot.policy.refoldRatio,
          chapterPrepareRatio: snapshot.policy.prepareRatio,
          hardFenceRatio: hardFenceRatio(snapshot),
          thresholds: { ...snapshot.thresholds },
          zones: {
            freshBoundary: snapshot.freshBoundary,
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
        ...(params.ephemeral === true ? {
          ephemeral: "this result rides your context exactly until your next message; " +
            "carry forward what matters in your reply, which takes over its place",
        } : {}),
      });
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
        activation: "the fold's placeholder and index rows now carry your brief; " +
          "the exact source and its fold record are untouched.",
      });
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
        for (const part of splitCandidateBySize(snapshot, persistence.state, recut)) {
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
      const marks: Array<Record<string, unknown>> = [];
      let staged = persistence.state;
      for (const item of resolved) {
        const { candidate } = item;
        const alreadyPrepared = staged.folds.some((fold) =>
          fold.id === foldIdFor(candidate.kind, candidate.parts));
        const deferred = refsProtected(candidate.sourceRefs, staged, snapshot) ||
          (candidate.kind === "tool-result" &&
            toolRefsProtected(candidate.sourceRefs, staged, snapshot));
        const suppliedComplaint = item.brief === undefined
          ? null
          : briefContractComplaint(item.brief.trim(), snapshot.policy.maxBriefChars, snapshot.toolName);
        if (suppliedComplaint !== null) {
          marks.push({
            id: foldIdFor(candidate.kind, candidate.parts),
            kind: candidate.kind,
            ok: false,
            deferred: false,
            reason: `Supplied brief rejected. ${suppliedComplaint}`,
          });
          continue;
        }
        const briefed = !deferred && !alreadyPrepared
          ? await prepareFold({
            candidate,
            snapshot,
            state: staged,
            generation: lifecycle.generation,
            brief: item.brief,
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
      const held = pendingMarks(persistence.state).map((mark) => ({
        id: mark.id,
        kind: mark.kind,
        tokens: estimatedTokens(markFreedBytes(snapshot, persistence.state!, mark)),
      }));
      const remainder = unmarkedRemainder(snapshot, persistence.state, projectionCharsPerToken());
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
      curation.contextCalls += 1;
      const attempt = (ok: boolean, error: string | null, corrections: Array<Record<string, unknown>>) => {
        const record = emit("context.attempt", {
          action,
          ok,
          error,
          tool_call_id: toolCallId,
          marks_requested: requestedMarkCount(params),
          corrections_applied: corrections.length,
          arguments_sha256: sha256Value(params ?? {}),
          ...(action === "peek" && params?.ephemeral === true ? { ephemeral: true } : {}),
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
        if (action === "peek" && params?.ephemeral === true) ephemeralPeeks.add(toolCallId);
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
      if (selector === "commit") {
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
      safeNotify(ctx, `Context command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { }
  });

  return { projectionCandidates };
}
