import {
  denseOwnArrayValues,
  objectRefKey,
  sha256Value,
  stableStringify,
} from "./json.ts";
import {
  advisorySchedule,
  advisoryState,
  clearArmedAdvisory,
  liveAdvisoryText,
  milestoneText,
  updateAdvisoryMilestone,
} from "./lib/advisory.ts";
import {
  bytes,
  clone,
  emptyActiveContextState,
  ownValue,
  uniqueMessageDigestAnchor,
} from "./lib/canonical.ts";
import {
  activeContextStatus,
  automaticPreparationId,
  commitPreparedFold,
  encodedFoldSource,
  foldCandidatesDetail,
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
  boundReceiptText,
  boundedInteger,
  contextUsageRatio,
  contextWindowFor,
  hardFenceRatio,
  latestProviderContextMeasurement,
  orderedRoots,
  parseNativeCompactionCompletion,
  parseNativeCompactionDecision,
  parseProviderContextMeasurementReceipt,
  persistenceProjection,
  providerContextMeasurement,
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
  clearPrepared,
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
  ACTIVE_CONTEXT_STATUS_KEY,
  ACTIVE_CONTEXT_TOOL_ACTIONS,
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES,
  DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
  DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  DEFAULT_CONTEXT_WINDOW,
  entryTypeNamespace,
  READ_ONLY_TOOLS_DEFAULT,
  USER_RESCUE_MAX_SOURCE_CHARS,
} from "./lib/policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveContextToolAction,
  AdvisoryMilestone,
  FoldCandidate,
  FoldKind,
  FoldRecordEntry,
  PreparedFold,
} from "./lib/policy.ts";
import {
  automaticToolBrief,
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  manualFoldCandidate,
  selectAutomaticToolBatch,
  selectAutomaticToolForRung,
} from "./lib/selection.ts";
import { buildActiveContextCommands, buildActiveContextTool } from "./lib/tool-surface.ts";
import { mapActiveContext } from "./lib/transcript.ts";

export * from "./lib/advisory.ts";
export * from "./lib/canonical.ts";
export * from "./lib/folding.ts";
export * from "./lib/measurement.ts";
export * from "./lib/persistence.ts";
export * from "./lib/policy.ts";
export * from "./lib/selection.ts";
export * from "./lib/transcript.ts";


export function registerActiveContext(pi: any, options: {
  summarizeContextSpan?: (request: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  setProjectionProvider?: (provider: (ctx: any) => Array<Record<string, unknown>>) => void;
  toolActions?: readonly ActiveContextToolAction[];
  toolName?: string;
  toolLabel?: string;
  brandNoun?: string;
  entryTypePrefix?: string;
  commandPrefix?: string;
  commandNames?: { status?: string; fold?: string };
  readOnlyTools?: ReadonlySet<string>;
  blockingTools?: readonly string[];
}): { projectionCandidates: (ctx: any) => Array<Record<string, unknown>> } {
  const toolName = options.toolName ?? DEFAULT_ACTIVE_CONTEXT_TOOL_NAME;
  const toolLabel = options.toolLabel ?? DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL;
  const brandNoun = options.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN;
  const entryTypePrefix = options.entryTypePrefix ?? DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
  const commandPrefix = options.commandPrefix ?? "";
  const readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS_DEFAULT;
  if (!toolName || !toolLabel || !brandNoun || !entryTypePrefix || typeof commandPrefix !== "string" ||
      (commandPrefix && !/^[a-z0-9-]+$/.test(commandPrefix)) ||
      [...readOnlyTools].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Active-context names and read-only tools must be nonempty strings");
  }
  const commandStem = commandPrefix ? `${commandPrefix.replace(/-+$/, "")}-` : "";
  // Full-name override for hosts that need non-default command names (e.g. the
  // pi-fold package's neutral "context"); commandPrefix remains the derived form.
  const commandNames = {
    status: options.commandNames?.status ?? `${commandStem}${DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES.status}`,
    fold: options.commandNames?.fold ?? `${commandStem}${DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES.fold}`,
  };
  if (![commandNames.status, commandNames.fold].every((name) =>
      typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name)) ||
      commandNames.status === commandNames.fold) {
    throw new Error("Active-context command names must be distinct kebab-case strings");
  }
  const configuredBlockingTools = denseOwnArrayValues(options.blockingTools ?? ["Agent"]);
  if (!configuredBlockingTools || configuredBlockingTools.some((name) => typeof name !== "string" || !name) ||
      new Set(configuredBlockingTools).size !== configuredBlockingTools.length) {
    throw new Error("Blocking tools must be one dense array of unique nonempty strings");
  }
  const blockingTools = new Set(configuredBlockingTools as string[]);
  const stateEntryType = `${entryTypePrefix}-state`;
  const foldRecordEntryType = `${entryTypePrefix}-fold-record`;
  const milestoneProjectionType = `${entryTypePrefix}-milestone`;
  const advisoryProjectionType = `${entryTypePrefix}-advisory`;
  const entryNamespace = entryTypeNamespace(entryTypePrefix);
  const providerMeasurementEntryType = `${entryNamespace}-provider-context-measurement`;
  const nativeReceiptEntryType = `${entryNamespace}-native-compaction-receipt`;
  const nativeDecisionEntryType = `${entryNamespace}-native-compaction-decision`;
  const configuredToolActions = denseOwnArrayValues(
    options.toolActions ?? ACTIVE_CONTEXT_TOOL_ACTIONS,
  );
  if (!configuredToolActions || configuredToolActions.length < 1) {
    throw new Error("Active-context tool actions must be one non-empty dense array");
  }
  const allowedToolActions: ActiveContextToolAction[] = [];
  const allowedToolActionSet = new Set<string>();
  for (const value of configuredToolActions) {
    if (typeof value !== "string" ||
        !ACTIVE_CONTEXT_TOOL_ACTIONS.includes(value as ActiveContextToolAction) ||
        allowedToolActionSet.has(value)) {
      throw new Error(`Invalid or duplicate active-context tool action '${String(value)}'`);
    }
    allowedToolActions.push(value as ActiveContextToolAction);
    allowedToolActionSet.add(value);
  }
  Object.freeze(allowedToolActions);

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
    automaticFailure: null as AutomaticFailureState | null,
    failedPreparations: new Set<string>(),
    actionQueue: Promise.resolve<unknown>(undefined),
  };

  // Owns provider receipts, anchors, and usage; providerMeasurementQueue serializes receipt writes.
  const measurements = {
    latestRatio: null as number | null,
    lastProviderMeasurement: null as ProviderContextMeasurement | null,
    providerMeasurementQueue: Promise.resolve<void>(undefined),
    providerMeasurementReceipts: new Set<string>(),
    providerMeasurementRevisionByMessageSha: new Map<string, number>(),
    providerMeasurementByMessageSha: new Map<string, ProviderContextMeasurementReceipt>(),
    providerMeasurementAnchorByMessageSha: new Map<string, ProviderMeasurementAnchor>(),
  };

  // Owns advisory arming and hard-fence delivery; durable effects use persistenceQueue.
  const advisory = {
    historicalGuidanceEntries: 0,
    armedMilestone: null as AdvisoryMilestone | null,
    advisoryScheduleKey: null as string | null,
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
  // A same-session start/tree reload is a projection-generation mutation.
  // Queue it behind every context authority → preparation → commit →
  // projection transaction, then serialize the actual load with the action
  // queue. Appending to actionQueue only after the context queue drains is
  // deliberate: a running context may itself need actionQueue to commit its
  // final-rung chapter, so capturing both queues up front would deadlock.
  const lifecycle = {
    generation: 0,
    shuttingDown: false,
    latestSnapshot: null as ActiveContextSnapshot | null,
    latestSnapshotError: null as string | null,
    blockingToolHarvestedThisTurn: false,
    blockingToolHarvestQueuedThisTurn: false,
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

  const snapshotForEvent = (ctx: any, messages: unknown[]): ActiveContextSnapshot => mapActiveContext({
    sessionId: ctx.sessionManager.getSessionId(),
    eventMessages: messages,
    contextEntries: ctx.sessionManager.buildContextEntries(),
    toolName,
    brandNoun,
    entryTypePrefix,
    readOnlyTools,
    contextWindow: contextWindowFor(ctx) ?? undefined,
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
      readOnlyTools,
      contextWindow: contextWindowFor(ctx) ?? undefined,
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
    lifecycle.blockingToolHarvestedThisTurn = false;
    lifecycle.blockingToolHarvestQueuedThisTurn = false;
    if (!preserveThresholdDecision) nativeCompaction.lastThresholdDecision = null;
    ladder.lastPreparationError = null;
    ladder.boundaryFailure = null;
    ladder.lastPreparationCandidateId = null;
    ladder.lastSelectionKind = null;
    ladder.lastSelectionSourceIds = [];
    ladder.pendingContextNote = null;
    advisory.historicalGuidanceEntries = 0;
    advisory.armedMilestone = null;
    advisory.advisoryScheduleKey = null;
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
      if (typeof entry.customType === "string" && [
        `${entryTypePrefix}-guidance-`,
        `${ACTIVE_CONTEXT_STATUS_KEY}-guidance-`,
      ].some((prefix) => entry.customType.startsWith(prefix))) {
        advisory.historicalGuidanceEntries += 1;
        continue;
      }
      if (entry.customType !== providerMeasurementEntryType) continue;
      try {
        const receipt = parseProviderContextMeasurementReceipt(entry.data, sessionId);
        const boundRevision = measurements.providerMeasurementRevisionByMessageSha.get(receipt.messageSha256);
        if (boundRevision !== undefined && boundRevision !== receipt.projectionRevision) {
          throw new Error("One provider response is bound to multiple projection revisions");
        }
        measurements.providerMeasurementRevisionByMessageSha.set(receipt.messageSha256, receipt.projectionRevision);
        const priorMeasurement = measurements.providerMeasurementByMessageSha.get(receipt.messageSha256);
        if (priorMeasurement && stableStringify(priorMeasurement) !== stableStringify(receipt)) {
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
    advisory.armedMilestone = advisoryState(persistence.state).armed?.milestone ?? null;
    persistence.persistedWireVersion = restoredPersistence?.wireVersion ?? 0;
    persistence.persistedFoldRecords = restoredPersistence?.records ?? new Map<string, FoldRecordEntry>();
    persistence.persistedStateSha256 = restoredPersistence?.stateSha256 ?? semanticStateSha256(durableRestored);
    const restoredMessages = ctx.sessionManager.buildSessionContext?.()?.messages;
    measurements.lastProviderMeasurement = latestProviderContextMeasurement(
      Array.isArray(restoredMessages) ? restoredMessages : [],
      contextWindowFor(ctx),
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
    const latest = [...completions.values()].sort((left, right) => left.occurredAt - right.occurredAt).at(-1);
    if (latest) {
      nativeCompaction.lastThresholdDecision = {
        handled: true,
        retry: false,
        reason: `native compaction completed; ${brandNoun} folding state rebuilt`,
        compactionReason: latest.reason,
        nativeCompactionCompleted: true,
        receiptKey: latest.receiptKey,
        decision: latest.decision,
      };
    }
  };

  const markManual = (
    next: ActiveContextState,
    action: Exclude<ActiveContextToolAction, "status">,
  ): void => {
    cancelPreparation();
    persistence.state = clearPrepared(next);
    ladder.pendingManual = true;
    if (action === "fold") advisory.armedMilestone = null;
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
    markManual(next, action);
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
    armedMilestone: advisory.armedMilestone,
    lastAutomaticAction: ladder.lastAutomaticAction,
    automaticFailure: ladder.automaticFailure ? clone(ladder.automaticFailure) : null,
    boundaryFailure: ladder.boundaryFailure,
  });
  const restoreTransient = (saved: ReturnType<typeof captureTransient>): void => {
    ladder.pendingManual = saved.pendingManual;
    ladder.preparing = saved.preparing?.controller.signal.aborted ? null : saved.preparing;
    ladder.pendingContextNote = saved.pendingContextNote;
    advisory.armedMilestone = saved.armedMilestone;
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
        toolFoldRatio: snapshot.policy.toolFoldRatio,
        refoldRatio: snapshot.policy.refoldRatio,
        prepareRatio: snapshot.policy.prepareRatio,
        hardFenceRatio: hardFenceRatio(snapshot),
        consolidationRatio: snapshot.policy.consolidationRatio,
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
  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const projected = projectActiveContext(snapshot, persistence.state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType;
    });
    const armed = advisoryState(persistence.state!).armed;
    if (!armed || armed.milestone !== advisory.armedMilestone || measurements.latestRatio === null ||
        measurements.latestRatio < 0.85 * armed.threshold) return projected;
    const status = activeContextStatus(snapshot, persistence.state!, 0, 1, snapshot.policy.maxFoldSourceRefs);
    const eligible = ownValue(status, "eligibleChapter");
    const startId = ownValue(eligible, "startId");
    const endId = ownValue(eligible, "endId");
    const chapterEndpoints = typeof startId === "string" && typeof endId === "string"
      ? [startId, endId]
      : [];
    const toolEndpoints = selectAutomaticToolBatch(snapshot, persistence.state!, 1)
      .flatMap((candidate) => candidate.sourceRefs.at(-1)?.entryId ?? [])
      .slice(0, 3);
    const remediationCount = advisoryState(persistence.state!).delivered[armed.milestone] ?? 0;
    projected.push({
      role: "custom",
      customType: milestoneProjectionType,
      content: milestoneText(armed.milestone, persistence.state!.sessionId, armed.threshold, toolName, brandNoun),
      display: false,
      details: { source: activeContextSource(entryTypePrefix), ephemeral: true, milestone: armed.milestone },
      timestamp: 0,
    });
    projected.push({
      role: "custom",
      customType: advisoryProjectionType,
      content: liveAdvisoryText({
        milestone: armed.milestone,
        ratio: measurements.latestRatio,
        toolEndpoints,
        chapterEndpoints,
        remediationCount,
        brandNoun,
      }),
      display: false,
      details: { source: activeContextSource(entryTypePrefix), ephemeral: true, milestone: armed.milestone },
      timestamp: typeof ownValue(snapshot.messages.at(-1), "timestamp") === "number"
        ? ownValue(snapshot.messages.at(-1), "timestamp")
        : 0,
    });
    return projected;
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

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!persistence.state || ladder.automaticFailure || ladder.preparing) return null;
    const selection = selectAutomaticRung(snapshot, persistence.state, ratio, {
      waiveToolCadence: rungOptions.waiveToolCadence,
      toolOnly: rungOptions.toolOnly,
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: ladder.failedPreparations,
    });
    if (!selection) return null;
    const before = bytes(projectActiveContext(snapshot, persistence.state));
    let action: Record<string, unknown> | null = null;
    if (selection.kind === "prepared-chapter" && persistence.state.prepared) {
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
    } else if (selection.kind === "tool") {
      cancelPreparation();
      const tool = selection.candidate;
      const id = await commitDeterministicCandidate(snapshot, tool, automaticToolBrief(snapshot, tool));
      action = {
        kind: "tool-fold",
        foldIds: [id],
        sourceIds: tool.sourceRefs.map((ref) => ref.entryId),
      };
      ladder.pendingContextNote = `${tool.sourceRefs.length} stale completed read-only tool result(s) were folded.`;
    } else if (selection.kind === "refold") {
      cancelPreparation();
      persistence.state = setFoldProjectionState(persistence.state, selection.foldId, "folded");
      action = { kind: "refold", foldIds: [selection.foldId] };
      ladder.pendingContextNote = `Stale expanded fold ${selection.foldId} returned to its identical placeholder.`;
    } else if (selection.kind === "consolidation") {
      cancelPreparation();
      const consolidation = selection.candidate;
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
    } else if (selection.kind === "chapter") {
      const chapter = selection.candidate;
      const id = await commitDeterministicCandidate(
        snapshot,
        chapter,
        deterministicChapterCandidateBrief(snapshot, chapter),
      );
      action = {
        kind: "chapter-fold",
        foldIds: [id],
        sourceIds: chapter.sourceRefs.map((ref) => ref.entryId),
      };
      ladder.pendingContextNote =
        `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
    }
    if (!action || !persistence.state) return null;
    const after = bytes(projectActiveContext(snapshot, persistence.state));
    persistence.state = clearArmedAdvisory(persistence.state);
    advisory.armedMilestone = null;
    ladder.lastAutomaticAction = { ...action, sourceBytesSaved: Math.max(0, before - after) };
    return ladder.lastAutomaticAction;
  };
  const runAutomaticRungTransaction = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
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
  ): Promise<Record<string, unknown> | null> => {
    const operation = ladder.actionQueue.then(() =>
      runAutomaticRungTransaction(snapshot, ratio, ctx, phase));
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
  options.setProjectionProvider?.(projectionCandidates);

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

  pi.on("session_start", async (_event: unknown, ctx: any) => { await safeLifecycleLoad(ctx, "session-start"); });
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
    advisory.armedMilestone = persistence.state ? advisoryState(persistence.state).armed?.milestone ?? null : null;
    advisory.advisoryScheduleKey = "pending-reseed";
    nativeCompaction.lastThresholdDecision = null;
    updateStatus(ctx);
  };
  pi.on("model_select", attributionChanged);
  pi.on("thinking_level_select", attributionChanged);

  const armMilestoneForMeasurement = (
    snapshot: ActiveContextSnapshot,
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!persistence.state) return false;
    const ratio = contextUsageRatio(measurement);
    if (ratio === null) return false;
    const schedule = advisorySchedule(snapshot);
    const scheduleKey = sha256Value({
      schedule: schedule.key,
      provider: measurement.provider,
      model: measurement.model,
      contextWindow: measurement.contextWindow,
    });
    const scheduleChanged = advisory.advisoryScheduleKey !== null && advisory.advisoryScheduleKey !== scheduleKey;
    advisory.advisoryScheduleKey = scheduleKey;
    const before = stableStringify(advisoryState(persistence.state));
    const updated = updateAdvisoryMilestone(persistence.state, ratio, schedule, scheduleChanged, scheduleKey);
    persistence.state = updated.state;
    const armed = advisoryState(persistence.state).armed;
    if (armed && ratio < 0.85 * armed.threshold) {
      persistence.state = clearArmedAdvisory(persistence.state);
      advisory.armedMilestone = null;
    } else {
      advisory.armedMilestone = armed?.milestone ?? null;
    }
    return before !== stableStringify(advisoryState(persistence.state));
  };

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
      let observed = latestProviderContextMeasurement(
        snapshot.messages,
        contextWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (observed && providerMeasurementBranchIndex(ctx, observed) < 0) observed = null;
      let advisoryChanged = false;
      let measurementStateChanged = false;
      if (observed) {
        const boundRevision = measurements.providerMeasurementRevisionByMessageSha.get(observed.messageSha256);
        if (boundRevision !== undefined &&
            !durableProviderMeasurementReceiptMatches(observed, boundRevision)) {
          try { await persistProviderMeasurement(ctx, observed, boundRevision); }
          catch (error) { suspendAutomatic(error, "provider-measurement", ctx); }
        }
        measurements.latestRatio = contextUsageRatio(observed);
        if (durableProviderMeasurementMatches(observed) && measurements.latestRatio !== null) {
          measurementStateChanged = accountAnchoredMeasurement(observed);
          measurements.lastProviderMeasurement = observed;
          advisoryChanged = armMilestoneForMeasurement(snapshot, observed);
          startPreparation(snapshot, measurements.latestRatio, ctx);
          if (!ladder.automaticFailure && measurements.latestRatio >= hardFenceRatio(snapshot) && ladder.preparing) {
            mutationAttempted = true;
            await ladder.preparing.promise;
            if (!sessionIdentityStillValid(ctx, snapshot.sessionId, generationAtEntry)) {
              return { messages: event.messages };
            }
          }
          if (selectAutomaticToolForRung(snapshot, persistence.state, measurements.latestRatio)) mutationAttempted = true;
          const action = await attemptAutomaticRung(snapshot, measurements.latestRatio, ctx, "context");
          if (action) {
            mutationAttempted = true;
            persistedSucceeded = true;
            advisoryChanged = false;
          }
        } else measurements.lastProviderMeasurement = observed;
      } else {
        measurements.latestRatio = contextUsageRatio(measurements.lastProviderMeasurement);
      }
      if ((advisoryChanged || measurementStateChanged) && persistence.state && persistence.persisted &&
          !sameStateProjection(persistence.state, persistence.persisted)) {
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
    measurements.lastProviderMeasurement = measurement;
    measurements.latestRatio = measuredRatio;
    let snapshot: ActiveContextSnapshot;
    try { snapshot = authoritativeSnapshotFor(ctx); }
    catch {
      updateStatus(ctx);
      return;
    }
    const advisoryChanged = armMilestoneForMeasurement(snapshot, measurement);
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
    if (!action && (advisoryChanged || measurementStateChanged) && persistence.state && persistence.persisted &&
        !sameStateProjection(persistence.state, persistence.persisted)) {
      await persistThroughActionQueue(ctx);
    }
    updateStatus(ctx);
  };

  pi.on("message_end", async (event: Record<string, unknown>, ctx: any) => {
    if (lifecycle.shuttingDown) return;
    try {
      const message = ownValue(event, "message");
      const measurement = providerContextMeasurement(
        message,
        contextWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
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
  pi.on("tool_call", (event: Record<string, unknown>, ctx: any) => {
    const calledTool = ownValue(event, "toolName");
    if (lifecycle.shuttingDown || lifecycle.blockingToolHarvestedThisTurn || lifecycle.blockingToolHarvestQueuedThisTurn ||
        typeof calledTool !== "string" || !blockingTools.has(calledTool)) return;
    lifecycle.blockingToolHarvestQueuedThisTurn = true;
    const operation = ladder.actionQueue.then(async () => {
      try {
        if (!persistence.state || measurements.latestRatio === null || !measurements.lastProviderMeasurement || ladder.automaticFailure ||
            !durableProviderMeasurementMatches(measurements.lastProviderMeasurement)) return null;
        cancelPreparation();
        let snapshot: ActiveContextSnapshot;
        try { snapshot = authoritativeSnapshotFor(ctx); }
        catch { return null; }
        const candidate = selectAutomaticToolForRung(snapshot, persistence.state, measurements.latestRatio, true);
        if (!candidate) {
          lifecycle.blockingToolHarvestedThisTurn = true;
          return null;
        }
        const action = await runAutomaticRungTransaction(
          snapshot,
          measurements.latestRatio,
          ctx,
          "tool-call",
          { waiveToolCadence: true, toolOnly: true },
        );
        if (action) lifecycle.blockingToolHarvestedThisTurn = true;
        return action;
      } finally {
        lifecycle.blockingToolHarvestQueuedThisTurn = false;
        try { updateStatus(ctx); } catch { /* A blocking tool call must never wait on presentation. */ }
      }
    });
    ladder.actionQueue = operation.catch(() => undefined);
  });
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    lifecycle.blockingToolHarvestedThisTurn = false;
    lifecycle.blockingToolHarvestQueuedThisTurn = false;
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

  pi.on("session_before_compact", (event: Record<string, unknown>, ctx: any) => {
    const reason = ownValue(event, "reason");
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
      if (detail !== undefined && detail !== "fold_candidates") {
        throw new Error("status detail must be 'fold_candidates'");
      }
      const schedule = advisorySchedule(snapshot);
      return toolPayload({
        ...activeContextStatus(
          snapshot,
          persistence.state,
          boundedInteger(params.offset, 0, 0, 1_000_000, "offset"),
          boundedInteger(params.limit, 40, 1, 100, "limit"),
          snapshot.policy.maxFoldSourceRefs,
        ),
        available: true,
        automatic: {
          pressureRatio: measurements.latestRatio,
          milestones: Object.fromEntries(schedule.rungs.map((rung) => [
            rung.milestone,
            { threshold: rung.threshold, budget: rung.budget },
          ])),
          armedMilestone: advisory.armedMilestone,
          advisory: advisoryState(persistence.state),
          historicalGuidanceEntries: advisory.historicalGuidanceEntries,
          warningRatio: snapshot.policy.warningRatio,
          toolFoldRatio: snapshot.policy.toolFoldRatio,
          refoldRatio: snapshot.policy.refoldRatio,
          chapterPrepareRatio: snapshot.policy.prepareRatio,
          hardFenceRatio: hardFenceRatio(snapshot),
          responseReserve: Math.min(
            ACTIVE_CONTEXT_POLICY.responseReserve,
            Math.floor(snapshot.contextWindow * 0.1),
          ),
          windowSource: snapshot.windowSource,
          consolidationRatio: snapshot.policy.consolidationRatio,
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
          automaticSuspended: ladder.automaticFailure !== null,
          automaticFailure: ladder.automaticFailure ? clone(ladder.automaticFailure) : null,
          lastCompactionDecision: nativeCompaction.lastThresholdDecision,
          nativeSummaries: "disabled",
          freeHarvest: blockingTools.size === 0 ? "disabled" : "enabled",
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
      });
    }
    if (action === "expand" || action === "refold") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error(`${action} requires id`);
      requireActiveFold(snapshot, persistence.state, id);
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
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "protect" || action === "unprotect") {
      const ids = stringIds(params.ids);
      await persistManual(protectEvidence(snapshot, persistence.state, ids, action === "protect"), action, ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        ids,
        activation: "durable immediately; projected on the next model call in this same turn",
      });
    }
    if (action === "fold") {
      const ids = stringIds(params.ids);
      const candidate = manualFoldCandidate(snapshot, persistence.state, ids);
      const supplied = typeof params.brief === "string" && params.brief.trim() ? params.brief : undefined;
      const { preparedFold, nextState } = await prepareAndCommitExplicit({
        snapshot,
        candidate,
        brief: supplied,
        ctx,
        signal,
      });
      advisory.armedMilestone = null;
      await persistManual(clearArmedAdvisory(nextState), "fold", ctx);
      updateStatus(ctx);
      return toolPayload({
        version: 1,
        action,
        id: preparedFold.id,
        kind: preparedFold.fold.kind,
        brief: preparedFold.fold.brief,
        provenance: normalizeLegacyProvenance(preparedFold.fold.provenance),
        argumentsSha256: executionArgumentsSha256,
        durableRevision: persistence.state.revision,
        activation: "durable immediately; projected on the next model call in this same turn",
        expand: { action: "expand", id: preparedFold.id },
      });
    }
    throw new Error(`Unknown ${toolName} action '${action}'`);
  };
  const toolHandler = async (
    _toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    _onUpdate: unknown,
    ctx: any,
  ): Promise<unknown> => {
    const operation = ladder.actionQueue.then(() => executeAction(params, signal, ctx));
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
      const supplied = (divider >= 0 ? args.slice(divider + 4) : "").trim() || undefined;
      const ids = selector ? selector.replace(/\.\./g, " ").split(/[\s,]+/).filter(Boolean) : [];
      const candidate = ids.length
        ? manualFoldCandidate(snapshot, persistence.state!, ids)
        : selectAutomaticChapter(snapshot, persistence.state!) ?? selectAutomaticToolBatch(snapshot, persistence.state!, 1)[0] ?? null;
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
      persistence.state = clearArmedAdvisory(nextState);
      advisory.armedMilestone = null;
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
      advisory.armedMilestone = null;
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
    fullSurface: allowedToolActions.length === ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    maxBriefChars: ACTIVE_CONTEXT_POLICY.maxBriefChars,
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
    advisory.armedMilestone = null;
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { /* Shutdown cannot be blocked by UI. */ }
  });

  return { projectionCandidates };
}
