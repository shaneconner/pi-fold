import {
  denseOwnArrayValues,
  evidenceSha256,
  objectRefKey,
  sha256Text,
  sha256Value,
  stableStringify,
} from "./json.ts";
import type { EvidenceRef } from "./json.ts";
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
  boundedOrientation,
  boundStatusPayload,
  briefContractComplaint,
  commitPreparedFold,
  consolidationSourceText,
  descendantIds,
  encodedFoldSource,
  generatedBriefs,
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
  MAX_BRIEF_BATCH_SPANS,
  MAX_BRIEF_UPGRADE_QUEUE,
  MAX_BRIEF_UPGRADES_IN_FLIGHT,
  MAX_FOLD_SPAN_CHARS,
  MAX_PINNED_SHARE,
  MAX_WEDGE_ABSORB_TOKENS,
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
  BriefProvenance,
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
export * from "./lib/surfacing.ts";
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
  summarizeContextSpan?: (request: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
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
    failedPreparations: new Set<string>(),
    actionQueue: Promise.resolve<unknown>(undefined),
  };

  const upgrades = {
    queue: [] as Array<{
      members: Array<{ foldId: string; sourceSha256: string }>;
      request: Record<string, unknown>;
    }>,
    running: new Map<string, { controller: AbortController; promise: Promise<void> }>(),
    ready: [] as Array<{ foldId: string; sourceSha256: string; brief: string; provenance: BriefProvenance }>,
    failed: new Set<string>(),
    deferred: new Set<string>(),
    failures: 0,
    cures: 0,
    abandoned: [] as string[],
    lastError: null as string | null,
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
    sinceHandoff: [] as Array<{ seq: number; kind: string }>,
    mutationsSinceHandoff: 0,
    requests: 0,
    lastMutationRequest: 0,
    lastMutationTokens: null as number | null,
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
    lastSignals: null as CurationSignals | null,
    reopenBaselineShare: null as number | null,
    wallEpisodeOpen: false,
    lastCallDelivery: null as { exposure: number; ordinal: number } | null,
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
  };

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
      catch { }
    });
    curation.instrumentationQueue = operation.then(() => undefined, () => undefined);
    return record;
  };

  const observedSummarize = options.summarizeContextSpan
    ? async (request: Record<string, unknown>, summarizerCtx: unknown): Promise<Record<string, unknown>> => {
      const startedAt = Date.now();
      const queuedAt = typeof request.queuedAtMs === "number" ? request.queuedAtMs : null;
      const spans = Array.isArray(request.spans)
        ? request.spans as Array<Record<string, unknown>>
        : null;
      const sourceText = typeof request.sourceText === "string" ? request.sourceText : "";
      const groupSpan = (span: Record<string, unknown>): boolean =>
        Number.isInteger(span.children) && (span.children as number) > 1;
      const charsOf = (span: Record<string, unknown>): number =>
        typeof span.sourceText === "string" ? span.sourceText.length : 0;
      const kindCounts = spans
        ? {
          spans: spans.length,
          group_spans: spans.filter(groupSpan).length,
          leaf_spans: spans.filter((span) => !groupSpan(span)).length,
          group_source_chars: spans.filter(groupSpan).reduce((sum, span) => sum + charsOf(span), 0),
          leaf_source_chars: spans.filter((span) => !groupSpan(span))
            .reduce((sum, span) => sum + charsOf(span), 0),
          fold_ids: spans.map((span) => typeof span.candidateId === "string" ? span.candidateId : ""),
        }
        : {
          spans: 1,
          group_spans: groupSpan(request) ? 1 : 0,
          leaf_spans: groupSpan(request) ? 0 : 1,
          group_source_chars: groupSpan(request) ? sourceText.length : 0,
          leaf_source_chars: groupSpan(request) ? 0 : sourceText.length,
        };
      const batchSourceSha256 = (): string => sha256Text(JSON.stringify(
        (spans ?? []).map((span) => typeof span.sourceText === "string" ? span.sourceText : ""),
      ));
      const base = {
        fold_id: typeof request.candidateId === "string" ? request.candidateId : "",
        source_chars: spans ? spans.reduce((sum, span) => sum + charsOf(span), 0) : sourceText.length,
        source_sha256: typeof request.sourceSha256 === "string"
          ? request.sourceSha256
          : spans ? batchSourceSha256() : sha256Text(sourceText),
        ...kindCounts,
        cure: typeof request.cure === "string" && request.cure.length > 0,
        ...(queuedAt === null ? {} : { queued_ms: Math.max(0, startedAt - queuedAt) }),
      };
      try {
        const result = await options.summarizeContextSpan!(request, summarizerCtx);
        const written = Array.isArray(result?.briefs)
          ? (result.briefs as unknown[]).map((item) => typeof item === "string" ? item.trim() : "")
          : [typeof result?.brief === "string" ? result.brief.trim() : ""];
        emit("context.brief", {
          ...base,
          outcome: "ok",
          duration_ms: Date.now() - startedAt,
          provider: typeof result?.provider === "string" ? result.provider : "",
          model: typeof result?.model === "string" ? result.model : "",
          effort: typeof result?.effort === "string" ? result.effort : "",
          brief_chars: written.reduce((sum, item) => sum + item.length, 0),
          brief_chars_each: written.map((item) => item.length),
          brief_sha256: written.length === 1 && written[0] ? sha256Text(written[0]) : "",
          usage: result?.usage && typeof result.usage === "object" ? clone(result.usage) : null,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit("context.brief", {
          ...base,
          outcome: /exceeded \d+ms/.test(message) ? "timeout" : "error",
          duration_ms: Date.now() - startedAt,
          error: boundReceiptText(message, 240, "brief generator"),
        });
        throw error;
      }
    }
    : undefined;

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
    cancelBriefUpgrades();
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
    const lastCall = persistence.state?.lastCall;
    const delivery = curation.lastCallDelivery;
    const roundOpen = Boolean(lastCall) && (!delivery || delivery.exposure !== lastCall.exposure ||
      markOrdinal(snapshot) <= delivery.ordinal);
    if (!measured.over && !rejected && roundOpen) {
      return { projected, aborted: false };
    }
    const trigger = measured;
    let reduced = projected;
    let attempts = 0;
    let reducedAtLeastOnce = false;
    while (measured.crowded || measured.over || rejected) {
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
        ratio < snapshot.policy.warmRatio ||
        !measurements.lastProviderMeasurement || !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) return;
    const selection = selectAutomaticRung(snapshot, persistence.state, ratio, {
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: ladder.failedPreparations,
    });
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
      summarize: ladder.failedPreparations.has(id) ? undefined : observedSummarize,
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
    appendNotices(projected, snapshot);
    appendLastCall(projected, snapshot);
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
    const causes = instrumentation.sinceHandoff.filter((event) =>
      PREFIX_MUTATING_KINDS.has(event.kind));
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
        : (causes.length ? causes.map((event) => event.kind).join(",") : "unattributed"),
      cause_event_seqs: causes.map((event) => event.seq).join(","),
      events_since_handoff: instrumentation.sinceHandoff.length,
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

  const queueBriefUpgrades = (
    snapshot: ActiveContextSnapshot,
    stateBeforeCommit: ActiveContextState,
    foldIds: readonly string[],
  ): void => {
    if (!observedSummarize || !persistence.state) return;
    const queued = (id: string): boolean =>
      upgrades.queue.some((entry) => entry.members.some((member) => member.foldId === id));
    const pending = (id: string): boolean => upgrades.running.has(id) || queued(id) ||
      upgrades.ready.some((entry) => entry.foldId === id) ||
      upgrades.deferred.has(id);
    const gathered: Array<{
      foldId: string;
      sourceSha256: string;
      refs: EvidenceRef[];
      span: Record<string, unknown>;
      chars: number;
      parent: boolean;
    }> = [];
    for (const foldId of [...upgrades.deferred, ...foldIds]) {
      const full = upgrades.queue.length >= MAX_BRIEF_UPGRADE_QUEUE;
      if (upgrades.failed.has(foldId) || upgrades.running.has(foldId) || queued(foldId) ||
          upgrades.ready.some((entry) => entry.foldId === foldId)) continue;
      const fold = persistence.state.folds.find((item) => item.id === foldId);
      if (!fold || foldProvenance(fold, persistence.state).kind !== "deterministic") {
        upgrades.deferred.delete(foldId);
        continue;
      }
      const parent = fold.parts.some((part) => part.kind === "fold");
      if (parent && (full || childFoldIds(fold).some(pending))) {
        upgrades.deferred.add(foldId);
        continue;
      }
      if (full) { upgrades.abandoned.push(foldId); continue; }
      upgrades.deferred.delete(foldId);
      const refs = parent
        ? flattenFoldRefs(fold, persistence.state)
        : fold.parts.every((part) => part.kind === "raw")
          ? fold.parts.map((part) => (part as { kind: "raw"; ref: EvidenceRef }).ref)
          : null;
      if (!refs) continue;
      try {
        const sourceText = parent
          ? consolidationSourceText(snapshot, persistence.state, fold.parts)
          : encodedFoldSource(snapshot, stateBeforeCommit, fold.parts, fold.kind);
        const chars = bytes(sourceText);
        if (chars > snapshot.policy.maxSourceChars) continue;
        gathered.push({
          foldId,
          sourceSha256: fold.sourceSha256,
          refs,
          chars,
          parent,
          span: {
            candidateId: fold.id,
            sourceRefs: clone(refs),
            sourceText,
            sourceSha256: sha256Text(sourceText),
            children: parent ? fold.parts.length : 0,
          },
        });
      } catch (error) {
        upgrades.failed.add(foldId);
        upgrades.failures += 1;
        upgrades.lastError = boundReceiptText(
          error instanceof Error ? error.message : String(error), 240, "brief upgrade",
        );
      }
    }
    for (let at = 0; at < gathered.length;) {
      if (upgrades.queue.length >= MAX_BRIEF_UPGRADE_QUEUE) {
        for (const item of gathered.slice(at)) {
          if (item.parent) upgrades.deferred.add(item.foldId);
          else upgrades.abandoned.push(item.foldId);
        }
        break;
      }
      const members: typeof gathered = [];
      let chars = 0;
      while (at < gathered.length && members.length < MAX_BRIEF_BATCH_SPANS &&
             (!members.length || chars + gathered[at].chars <= snapshot.policy.maxSourceChars)) {
        chars += gathered[at].chars;
        members.push(gathered[at]);
        at += 1;
      }
      const before = boundedOrientation(snapshot, members[0].refs);
      const after = boundedOrientation(snapshot, members[members.length - 1].refs);
      upgrades.queue.push({
        members: members.map((item) => ({ foldId: item.foldId, sourceSha256: item.sourceSha256 })),
        request: {
          spans: members.map((item) => item.span),
          beforeRefs: clone(before.beforeRefs),
          beforeText: before.beforeText,
          beforeSha256: sha256Text(before.beforeText),
          afterRefs: clone(after.afterRefs),
          afterText: after.afterText,
          afterSha256: sha256Text(after.afterText),
          maxBriefChars: snapshot.policy.maxBriefChars,
          queuedAtMs: Date.now(),
        },
      });
    }
  };

  const startBriefUpgrade = (snapshot: ActiveContextSnapshot, ctx: any): boolean => {
    const summarize = observedSummarize;
    const inFlight = new Set(upgrades.running.values()).size;
    if (!summarize || lifecycle.shuttingDown || !upgrades.queue.length ||
        inFlight >= MAX_BRIEF_UPGRADES_IN_FLIGHT) return false;
    const entry = upgrades.queue.shift()!;
    const controller = new AbortController();
    const slot = { controller, promise: Promise.resolve() };
    for (const member of entry.members) upgrades.running.set(member.foldId, slot);
    const capturedSessionId = snapshot.sessionId;
    const capturedGeneration = lifecycle.generation;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    slot.promise = (async () => {
      const timed = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`Brief upgrade exceeded ${snapshot.policy.briefTimeoutMs}ms`));
        }, snapshot.policy.briefTimeoutMs);
      });
      const generated = await Promise.race([
        generatedBriefs({
          summarize: (request, callCtx) => summarize({ ...request, signal: controller.signal }, callCtx),
          request: entry.request,
          spans: entry.request.spans as Array<Record<string, unknown>>,
          ctx,
          maxBriefChars: snapshot.policy.maxBriefChars,
          toolName: snapshot.toolName,
        }),
        timed,
      ]);
      if (controller.signal.aborted ||
          !sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration)) return;
      entry.members.forEach((member, at) => {
        const written = generated.briefs[at];
        if (!written) {
          upgrades.failed.add(member.foldId);
          upgrades.failures += 1;
          upgrades.lastError = boundReceiptText(
            `span ${at + 1} of ${entry.members.length}: ${generated.complaints[at] ?? "no brief"}`,
            240, "brief upgrade",
          );
          return;
        }
        upgrades.ready.push({
          foldId: member.foldId,
          sourceSha256: member.sourceSha256,
          brief: written.brief,
          provenance: written.provenance,
        });
      });
      upgrades.cures += generated.cured;
    })().catch((error) => {
      if (controller.signal.aborted) return;
      for (const member of entry.members) upgrades.failed.add(member.foldId);
      upgrades.failures += 1;
      upgrades.lastError = boundReceiptText(
        error instanceof Error ? error.message : String(error), 240, "brief upgrade",
      );
    }).finally(() => {
      clearTimeout(timeout);
      for (const member of entry.members) {
        if (upgrades.running.get(member.foldId) === slot) upgrades.running.delete(member.foldId);
      }
      if (!lifecycle.shuttingDown && lifecycle.generation === capturedGeneration) {
        resumeBriefUpgrades(snapshot, ctx);
      }
    });
    return true;
  };

  const startBriefUpgrades = (snapshot: ActiveContextSnapshot, ctx: any): void => {
    while (startBriefUpgrade(snapshot, ctx)) continue;
  };

  const resumeBriefUpgrades = (snapshot: ActiveContextSnapshot, ctx: any): void => {
    if (upgrades.deferred.size && persistence.state) {
      queueBriefUpgrades(snapshot, persistence.state, []);
    }
    startBriefUpgrades(snapshot, ctx);
  };

  const cancelBriefUpgrades = (): void => {
    for (const slot of upgrades.running.values()) slot.controller.abort();
    upgrades.running.clear();
    upgrades.queue = [];
    upgrades.ready = [];
    upgrades.deferred.clear();
  };

  const applyBriefUpgrades = (): string[] => {
    if (!upgrades.ready.length || !persistence.state) return [];
    const applied: string[] = [];
    for (const entry of upgrades.ready) {
      const state = persistence.state;
      const fold = state.folds.find((item) => item.id === entry.foldId);
      if (!fold || fold.sourceSha256 !== entry.sourceSha256 ||
          foldProvenance(fold, state).kind !== "deterministic" ||
          state.expanded.includes(fold.id) || state.briefs?.[fold.id] !== undefined) continue;
      persistence.state = {
        ...state,
        briefs: {
          ...(state.briefs ?? {}),
          [fold.id]: { brief: entry.brief, provenance: clone(entry.provenance) },
        },
      };
      applied.push(fold.id);
    }
    upgrades.ready = [];
    return applied;
  };

  const commitDeterministicCandidate = async (
    snapshot: ActiveContextSnapshot,
    candidate: FoldCandidate,
    brief: string,
  ): Promise<string> => {
    const stateBeforeCommit = persistence.state!;
    const preparedFold = await prepareFold({
      candidate,
      snapshot,
      state: stateBeforeCommit,
      generation: lifecycle.generation,
      brief,
      briefProvenance: "deterministic",
    });
    persistence.state = commitPreparedFold({
      prepared: preparedFold,
      snapshot,
      state: stateBeforeCommit,
      generation: lifecycle.generation,
    });
    queueBriefUpgrades(snapshot, stateBeforeCommit, [preparedFold.id]);
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
      summarize: observedSummarize,
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
    const upgradedFolds = applyBriefUpgrades();
    const upgradeFailures = upgrades.failures;
    const upgradeError = upgrades.lastError;
    const upgradeCures = upgrades.cures;
    const upgradeAbandoned = upgrades.abandoned;
    upgrades.failures = 0;
    upgrades.cures = 0;
    upgrades.abandoned = [];
    upgrades.lastError = null;
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
      brief_upgrades: upgradedFolds.length,
      brief_upgrade_ids: upgradedFolds.join(","),
      brief_upgrade_failures: upgradeFailures,
      brief_upgrade_cures: upgradeCures,
      brief_upgrade_error: upgradeError,
      brief_upgrades_abandoned: upgradeAbandoned.length,
      brief_upgrades_abandoned_ids: upgradeAbandoned.join(","),
      brief_upgrades_waiting: upgrades.ready.length + upgrades.running.size +
        upgrades.queue.reduce((total, entry) => total + entry.members.length, 0),
      brief_upgrade_calls: upgrades.queue.length + new Set(upgrades.running.values()).size,
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
    if (persistence.state.notices && usedTokens !== null && budgetTokens > 0) {
      const postOccupancy = Math.max(0, usedTokens - estimatedTokens(freedBytes)) / budgetTokens;
      const fired = persistence.state.notices.fired.filter((share) => postOccupancy >= share);
      if (fired.length !== persistence.state.notices.fired.length) {
        persistence.state = { ...persistence.state, notices: { ...persistence.state.notices, fired } };
      }
    }
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
    queueBriefUpgrades(snapshot, state, result.applied.map((applied) => applied.foldId));
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
    return {
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
  };

  const clearCommitLatchBelowTrigger = (): void => {
    if (curation.reopenBaselineShare === null) return;
    const capacity = servingCapacity(lifecycle.latestSnapshot?.contextWindow ?? null);
    if (capacity.usedTokens === null || capacity.budgetTokens <= 0) return;
    if (capacity.usedTokens / capacity.budgetTokens < thresholds.maxTarget) {
      curation.reopenBaselineShare = null;
    }
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

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: {
      toolOnly?: boolean;
      waiverRatio?: number;
    } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!persistence.state || ladder.automaticFailure || ladder.preparing) return null;
    const rungSelectionOptions = {
      toolOnly: rungOptions.toolOnly,
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: ladder.failedPreparations,
    };
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
    const epoch: Record<string, unknown> | null = null;
    let inlineRungs = true;
    const noticesChanged = false;
    const lastCallChanged = false;
    inlineRungs = Boolean(epoch) && Number(epoch?.appliedMarks ?? 0) > 0;
    if (!inlineRungs) {
      const marked = markLadderSelection();
      if (marked) {
        if (epoch) ladder.lastAutomaticAction = { ...marked, epoch };
        return ladder.lastAutomaticAction;
      }
      if (!epoch && (lastCallChanged || noticesChanged)) {
        ladder.lastAutomaticAction = { kind: "carrier", foldIds: [], sourceIds: [], sourceBytesSaved: 0 };
        return ladder.lastAutomaticAction;
      }
    }
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
        deterministicConsolidationBrief(consolidation, persistence.state, snapshot.toolName),
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
      action = await applyAutomaticRung(snapshot, ratio, rungOptions);
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
    const operation = ladder.actionQueue.then(async () => {
      const action = await runAutomaticRungTransaction(snapshot, ratio, ctx, phase, rungOptions);
      resumeBriefUpgrades(snapshot, ctx);
      return action;
    });
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
    cancelBriefUpgrades();
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
      handoff = await runCommitEpoch(snapshot, "compaction-boundary", true, measurements.latestRatio);
      await persist(ctx);
    } catch (error) {
      suspendAutomatic(error, "compaction-boundary", ctx);
      return undefined;
    }
    nativeCompaction.lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: handoff
        ? `${contextBrand(brandNoun)} handed the prefix off losslessly instead of compacting it`
        : `${contextBrand(brandNoun)} had nothing eligible to hand off`,
      compactionReason: reason,
      nativeCompactionCompleted: false,
    };
    try { updateStatus(ctx); } catch { }
    if (!handoff) return undefined;
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
          surfacing: statusSurfacing(snapshot),
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
            signals: curation.lastSignals ? { ...curation.lastSignals } : null,
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
    const noteSurfacingAccept = (id: string): void => {
      if (!persistence.state) return;
      persistence.state = noteSurfacingAction(persistence.state, id, markOrdinal(snapshot));
    };
    if (action === "peek") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error("peek requires id");
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
            summarize: observedSummarize,
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
        try { await persist(ctx); } catch { }
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
    cancelBriefUpgrades();
    persistence.state = null;
    persistence.persisted = null;
    lifecycle.latestSnapshot = null;
    curation.receipts = [];
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { }
  });

  return { projectionCandidates };
}
