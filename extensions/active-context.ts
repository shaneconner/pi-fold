import type { EvidenceRef } from "./json.ts";
import {
  denseOwnArrayValues,
  evidenceRef,
  evidenceSha256,
  evidenceValue,
  isObjectRef,
  isPlainRecord,
  objectRefKey,
  sameObjectIdentity,
  sha256Text,
  sha256Value,
  stableStringify,
} from "./json.ts";

import {
  ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
  ACTIVE_CONTEXT_POLICY,
  ACTIVE_CONTEXT_STATE_ENTRY,
  ACTIVE_CONTEXT_STATUS_KEY,
  ACTIVE_CONTEXT_TOOL_ACTIONS,
  BYTES_PER_TOKEN_FLOOR,
  CONSOLIDATION_WIDTH_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  EXPAND_LEASE_GENERATIONS,
  MAX_ADVISORY_DELIVERIES_PER_MILESTONE,
  MAX_EXPAND_LEASES,
  NATIVE_COMPACTION_DECISION_ENTRY,
  NATIVE_COMPACTION_RECEIPT_ENTRY,
  PROVIDER_CONTEXT_MEASUREMENT_ENTRY,
  READ_ONLY_TOOLS_DEFAULT,
  TOOL_FOLD_CADENCE_MIN_TOKENS,
  TOOL_FOLD_CADENCE_WINDOW_FRACTION,
  USER_RESCUE_MAX_SOURCE_CHARS,
} from "./lib/policy.ts";
import type {
  ActiveContextCheckpointV2,
  ActiveContextDeltaV2,
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveContextStateWireV2,
  ActiveContextToolAction,
  ActiveFold,
  AdvisoryMilestone,
  BranchObject,
  BriefProvenance,
  CompleteTurn,
  FoldCandidate,
  FoldKind,
  FoldPart,
  FoldRecordEntry,
  FoldRecordRef,
  MappedMessage,
  PreparedFold,
} from "./lib/policy.ts";

export * from "./lib/policy.ts";
import {
  bytes,
  clone,
  contentText,
  emptyActiveContextState,
  exactRecord,
  messageRole,
  ownValue,
  sessionEntryMessages,
  structurallyValidBrief,
  uniqueMessageDigestAnchor,
  usefulBrief,
} from "./lib/canonical.ts";

export * from "./lib/canonical.ts";
import {
  ADVISORY_BUDGETS,
  ADVISORY_MILESTONES,
  childFoldIds,
  clearPrepared,
  deriveFoldParents,
  flattenFoldRefs,
  foldIdFor,
  foldMap,
  makeFoldRecordEntry,
  makeStateCheckpoint,
  makeStateDelta,
  MAX_ACTIVE_FOLD_RECORDS,
  materializeStatePersistence,
  normalizeFoldsForPersistedRecords,
  normalizeLegacyProvenance,
  normalizedPart,
  parseActiveContextState,
  protectionSha256,
  sameStateProjection,
  semanticStateSha256,
  topologySha256,
  validAdvisoryState,
  validateFoldForest,
} from "./lib/persistence.ts";
import type { MaterializedStatePersistence } from "./lib/persistence.ts";

export * from "./lib/persistence.ts";
import {
  chapterSegments,
  mapActiveContext,
  scanTurnToolBatches,
  structurallyClosedChapterUnits,
  terminalAssistant,
} from "./lib/transcript.ts";
import type { ChapterUnit } from "./lib/transcript.ts";

export * from "./lib/transcript.ts";
import {
  automatic_PLACEHOLDER,
  boundReceiptText,
  branchSha256,
  contextUsageRatio,
  contextWindowFor,
  exactMapped,
  explicitProtectedKeys,
  foldInterval,
  hardFenceRatio,
  latestProviderContextMeasurement,
  orderedRoots,
  parseNativeCompactionCompletion,
  parseNativeCompactionDecision,
  parseProviderContextMeasurementReceipt,
  persistenceProjection,
  providerContextMeasurement,
  refsInOrder,
  refsProtected,
  stringIds,
  toolFoldCadence,
  toolPayload,
  toolRefsProtected,
  visibleCollapsedRoots,
  boundedInteger,
} from "./lib/measurement.ts";
import type {
  NativeCompactionCompletionReceipt,
  NativeCompactionDecisionReceipt,
  ProviderContextMeasurement,
  ProviderMeasurementAnchor,
} from "./lib/measurement.ts";

export * from "./lib/measurement.ts";
import {
  automaticToolBrief,
  candidateSourceRefs,
  chapterUnits,
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  manualFoldCandidate,
  partsForRange,
  resultCall,
  selectAutomaticConsolidation,
  selectAutomaticRefold,
  selectAutomaticToolBatch,
  selectAutomaticToolForRung,
} from "./lib/selection.ts";

export * from "./lib/selection.ts";


export function selectAutomaticChapter(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  maximumSourceRefs: number = snapshot.policy.maxFoldSourceRefs,
): FoldCandidate | null {
  const units = chapterUnits(snapshot);
  const allowedChildren = new Set<FoldKind>(["tool-result"]);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const first = units[unitIndex];
    let best: FoldCandidate | null = null;
    const turnStarts = new Set<number>();
    for (let endIndex = unitIndex; endIndex < units.length; endIndex += 1) {
      const unit = units[endIndex];
      if (endIndex > unitIndex && unit.start !== units[endIndex - 1].end) break;
      turnStarts.add(unit.turnStart);
      if (turnStarts.size > snapshot.policy.maxChapterTurns) break;
      const coherentSegment = endIndex > unitIndex || first.end - first.start > 1;
      if (!coherentSegment) continue;
      const parts = partsForRange(snapshot, state, first.start, unit.end - 1, allowedChildren);
      if (!parts || parts.some((part) => part.kind === "fold" && state.expanded.includes(part.foldId))) continue;
      const refs = candidateSourceRefs(parts, state);
      if (refs.length > maximumSourceRefs) break;
      if (refsProtected(refs, state, snapshot)) continue;
      const size = bytes(encodedFoldSource(snapshot, state, parts, "chapter"));
      if (size > snapshot.policy.maxChapterChars) break;
      if (size >= snapshot.policy.minChapterChars) best = { kind: "chapter", parts, sourceRefs: refs };
    }
    // Prefer the largest bounded segment beginning at the oldest eligible unit.
    if (best) return best;
  }
  return null;
}

type AutomaticRungSelection =
  | { kind: "prepared-chapter"; candidate: FoldCandidate }
  | { kind: "tool"; candidate: FoldCandidate }
  | { kind: "refold"; foldId: string }
  | { kind: "consolidation"; candidate: FoldCandidate }
  | { kind: "chapter"; candidate: FoldCandidate }
  | { kind: "chapter-prepare"; candidate: FoldCandidate };

interface AutomaticRungSelectionOptions {
  waiveToolCadence?: boolean;
  toolOnly?: boolean;
  summarizerAvailable?: boolean;
  failedPreparationIds?: ReadonlySet<string>;
}

function automaticPreparationId(candidate: FoldCandidate, state: ActiveContextState): string {
  return sha256Value({
    kind: candidate.kind,
    refs: candidate.sourceRefs,
    topology: topologySha256(state),
    protection: protectionSha256(state),
  });
}

function selectAutomaticRung(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
  options: AutomaticRungSelectionOptions = {},
): AutomaticRungSelection | null {
  if (!options.toolOnly && state.prepared) {
    if (!Number.isFinite(ratio) || ratio < hardFenceRatio(snapshot)) return null;
    const candidate = selectAutomaticChapter(snapshot, state);
    return candidate ? { kind: "prepared-chapter", candidate } : null;
  }
  const tool = selectAutomaticToolForRung(snapshot, state, ratio, options.waiveToolCadence);
  if (tool) return { kind: "tool", candidate: tool };
  if (options.toolOnly || !Number.isFinite(ratio)) return null;
  const refold = selectAutomaticRefold(snapshot, state, ratio);
  if (refold) return { kind: "refold", foldId: refold };
  const consolidation = selectAutomaticConsolidation(snapshot, state, ratio);
  if (consolidation) return { kind: "consolidation", candidate: consolidation };
  const chapter = selectAutomaticChapter(snapshot, state);
  if (!chapter) return null;
  const preparationFailed = options.failedPreparationIds?.has(
    automaticPreparationId(chapter, state),
  ) ?? false;
  if (ratio >= hardFenceRatio(snapshot)) {
    return !options.summarizerAvailable || preparationFailed
      ? { kind: "chapter", candidate: chapter }
      : { kind: "chapter-prepare", candidate: chapter };
  }
  if ((options.summarizerAvailable && ratio >= snapshot.policy.warmRatio) ||
      ((!options.summarizerAvailable || preparationFailed) && ratio >= snapshot.policy.prepareRatio)) {
    return { kind: "chapter-prepare", candidate: chapter };
  }
  return null;
}

export function foldCandidatesDetail(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number | null,
  options: {
    summarizerAvailable?: boolean;
    generation?: number;
    measurementFresh?: boolean;
    automaticFailure?: boolean;
    preparing?: boolean;
    failedPreparationIds?: ReadonlySet<string>;
  } = {},
): Record<string, unknown> {
  const measuredRatio = ratio !== null && Number.isFinite(ratio) ? ratio : Number.NaN;
  const tool = selectAutomaticToolForRung(snapshot, state, measuredRatio);
  const refold = selectAutomaticRefold(snapshot, state, measuredRatio);
  const consolidation = selectAutomaticConsolidation(snapshot, state, measuredRatio);
  const chapter = selectAutomaticChapter(snapshot, state);
  const selection = selectAutomaticRung(snapshot, state, measuredRatio, {
    summarizerAvailable: options.summarizerAvailable,
    failedPreparationIds: options.failedPreparationIds,
  });
  let wouldFireNow: string | null = null;
  let blockedBy: string | null = null;
  if (options.measurementFresh === false) blockedBy = "measurement-stale";
  else if (options.automaticFailure) blockedBy = "automatic-failure";
  else if (options.preparing) blockedBy = "preparing";
  else if (selection?.kind === "prepared-chapter" && state.prepared && preparedFoldError({
    prepared: state.prepared,
    snapshot,
    state,
    generation: options.generation ?? state.prepared.generation,
    ratio: measuredRatio,
  }) !== null) blockedBy = "prepared-drift";
  else wouldFireNow = selection?.kind ?? null;
  return {
    tool: tool ? {
      startId: tool.sourceRefs[0].entryId,
      endId: tool.sourceRefs.at(-1)!.entryId,
    } : null,
    refold,
    consolidation: consolidation
      ? consolidation.parts.map((part) => part.kind === "fold" ? part.foldId : "")
      : null,
    chapter: chapter ? {
      ids: chapter.sourceRefs.map((ref) => ref.entryId),
      estimatedChars: encodedFoldSource(snapshot, state, chapter.parts, chapter.kind).length,
    } : null,
    wouldFireNow,
    blockedBy,
    cadence: {
      tokensSinceToolFold: state.tokensSinceToolFold,
      cadenceNeed: toolFoldCadence(snapshot.contextWindow),
    },
    width: {
      visibleRoots: visibleCollapsedRoots(state, snapshot).length,
      threshold: CONSOLIDATION_WIDTH_THRESHOLD,
    },
  };
}

export function selectAutomaticCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number,
): FoldCandidate | null {
  const selection = selectAutomaticRung(snapshot, state, ratio);
  return selection && "candidate" in selection ? selection.candidate : null;
}

function encodedRefs(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): string {
  return stableStringify(refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    return { ref, message: item.message };
  }));
}

function encodedFoldSource(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  parts: FoldPart[],
  kind: FoldKind,
): string {
  if (kind !== "chapter") {
    const messages = renderFoldParts(parts, state, snapshot);
    if (!messages) throw new Error("Fold source projection drifted");
    return stableStringify({ parts: parts.map(normalizedPart), messages });
  }
  const refs = candidateSourceRefs(parts, state);
  return stableStringify(refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    const call = ref.role === "toolResult" ? resultCall(snapshot, item.index, true) : null;
    if (!call) return { ref, message: clone(item.message) };
    const candidate: FoldCandidate = {
      kind: "tool-result",
      parts: [{ kind: "raw", ref }],
      sourceRefs: [ref],
    };
    return {
      ref,
      message: {
        role: "toolResult",
        toolCallId: ownValue(item.message, "toolCallId"),
        toolName: ownValue(item.message, "toolName"),
        content: [{ type: "text", text: automaticToolBrief(snapshot, candidate) }],
        isError: false,
        details: {
          projection: "deterministic-read-only-tool-brief",
          sourceSha256: ref.sha256,
          sourceBytes: bytes(item.message),
        },
        timestamp: ownValue(item.message, "timestamp"),
      },
    };
  }));
}

function boundedOrientation(
  snapshot: ActiveContextSnapshot,
  sourceRefs: EvidenceRef[],
): { beforeRefs: EvidenceRef[]; beforeText: string; afterRefs: EvidenceRef[]; afterText: string } {
  const indices = refsInOrder(snapshot, sourceRefs);
  if (!indices) throw new Error("Fold source is not an exact contiguous active range");
  const sourceKeys = new Set(sourceRefs.map(objectRefKey));
  const collect = (candidates: MappedMessage[]): { refs: EvidenceRef[]; text: string } => {
    const refs: EvidenceRef[] = [];
    let text = "[]";
    for (const item of candidates) {
      if (!item.ref || sourceKeys.has(objectRefKey(item.ref))) continue;
      const trial = [...refs, item.ref];
      const encoded = encodedRefs(snapshot, trial);
      if (encoded.length > snapshot.policy.maxOrientationChars) break;
      refs.push(item.ref);
      text = encoded;
      if (refs.length >= snapshot.policy.orientationMessages) break;
    }
    return { refs, text };
  };
  const before = collect(snapshot.mapped.slice(0, indices[0]).reverse()).refs.reverse();
  const beforeText = before.length ? encodedRefs(snapshot, before) : "[]";
  const after = collect(snapshot.mapped.slice(indices.at(-1)! + 1));
  return { beforeRefs: before, beforeText, afterRefs: after.refs, afterText: after.text };
}

export async function prepareFold(input: {
  candidate: FoldCandidate;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  brief?: string;
  briefProvenance?: "supplied" | "deterministic";
  summarize?: (request: Record<string, unknown>, ctx?: unknown) => Promise<Record<string, unknown>>;
  onSummarizerFailure?: (error: unknown) => void;
  ctx?: unknown;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PreparedFold> {
  const { candidate, snapshot, state } = input;
  const protectedSource = candidate.kind === "tool-result"
    ? toolRefsProtected(candidate.sourceRefs, state, snapshot)
    : refsProtected(candidate.sourceRefs, state, snapshot);
  if (!candidate.sourceRefs.length || candidate.sourceRefs.length > snapshot.policy.maxFoldSourceRefs ||
      refsInOrder(snapshot, candidate.sourceRefs) === null || protectedSource) {
    throw new Error("Fold source is not exact, stale, and unprotected");
  }
  const sourceText = encodedFoldSource(snapshot, state, candidate.parts, candidate.kind);
  const orientation = boundedOrientation(snapshot, candidate.sourceRefs);
  const sourceSha256 = sha256Text(sourceText);
  const beforeSha256 = sha256Text(orientation.beforeText);
  const afterSha256 = sha256Text(orientation.afterText);
  const candidateId = sha256Value({
    kind: candidate.kind,
    parts: candidate.parts.map(normalizedPart),
    sourceSha256,
    beforeSha256,
    afterSha256,
  });

  let brief: string;
  let provenance: BriefProvenance;
  if (input.brief !== undefined) {
    if (!usefulBrief(input.brief, snapshot.policy.maxBriefChars, snapshot.toolName)) {
      throw new Error(`Supplied brief must be non-structural and at most ${snapshot.policy.maxBriefChars} characters`);
    }
    brief = input.brief.trim();
    provenance = { kind: input.briefProvenance ?? "supplied" };
  } else {
    let modelBrief: { brief: string; provenance: BriefProvenance } | null = null;
    if (input.summarize) {
      const controller = new AbortController();
      const relayAbort = (): void => controller.abort();
      input.signal?.addEventListener("abort", relayAbort, { once: true });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        if (bytes(sourceText) > snapshot.policy.maxSourceChars) {
          throw new Error("Fold source exceeds the bounded model-summary request");
        }
        const timed = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Context brief exceeded ${snapshot.policy.briefTimeoutMs}ms`));
          }, snapshot.policy.briefTimeoutMs);
        });
        const result = await Promise.race([input.summarize({
          candidateId,
          sourceRefs: clone(candidate.sourceRefs),
          sourceText,
          sourceSha256,
          beforeRefs: clone(orientation.beforeRefs),
          beforeText: orientation.beforeText,
          beforeSha256,
          afterRefs: clone(orientation.afterRefs),
          afterText: orientation.afterText,
          afterSha256,
          maxBriefChars: snapshot.policy.maxBriefChars,
          signal: controller.signal,
        }, input.ctx), timed]);
        const generated = typeof result?.brief === "string" ? result.brief.trim() : "";
        const digest = result?.launchContractDigest;
        if (!usefulBrief(generated, snapshot.policy.maxBriefChars, snapshot.toolName) ||
            typeof result?.provider !== "string" || !result.provider ||
            typeof result?.model !== "string" || !result.model ||
            typeof result?.effort !== "string" || !result.effort || result.toolCalls !== 0 ||
            (digest !== undefined && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)))) {
          throw new Error("Model context brief attribution, zero-tool, digest, or usefulness contract drift");
        }
        modelBrief = {
          brief: generated,
          provenance: {
            kind: "model",
            provider: result.provider,
            model: result.model,
            effort: result.effort,
            ...(typeof digest === "string" ? { launchContractDigest: digest } : {}),
          },
        };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        input.onSummarizerFailure?.(error);
      } finally {
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", relayAbort);
      }
    }
    if (modelBrief) {
      brief = modelBrief.brief;
      provenance = modelBrief.provenance;
    } else {
      brief = deterministicChapterCandidateBrief(snapshot, candidate);
      provenance = { kind: "deterministic" };
    }
  }

  const id = foldIdFor(candidate.kind, candidate.parts);
  const provisional: ActiveFold = {
    id,
    kind: candidate.kind,
    parentId: null,
    parts: clone(candidate.parts),
    brief,
    provenance,
    sourceSha256: sha256Value(candidate.sourceRefs),
    sourceChars: 1,
    placeholderChars: 1,
    createdAt: (input.now ?? Date.now)(),
  };
  const sourceMessages = renderFoldParts(candidate.parts, state, snapshot);
  const provisionalState = stateWithNestedFold(state, provisional);
  const replacementFold = provisionalState.folds.find((item) => item.id === id)!;
  const replacementMessages = renderFold(replacementFold, provisionalState, snapshot);
  if (!sourceMessages || !replacementMessages) throw new Error("Fold rendering drifted before measurement");
  const sourceBytes = bytes(sourceMessages);
  const replacementBytes = bytes(replacementMessages);
  if (candidate.kind === "consolidation" && replacementBytes >= sourceBytes) {
    throw new Error("Consolidation brief would not materially reduce its rendered child placeholders");
  }
  const fold: ActiveFold = {
    ...provisional,
    sourceChars: sourceBytes,
    placeholderChars: replacementBytes,
  };
  return {
    id,
    sessionId: snapshot.sessionId,
    generation: input.generation,
    branchSha256: branchSha256(snapshot, [
      ...orientation.beforeRefs,
      ...candidate.sourceRefs,
      ...orientation.afterRefs,
    ]),
    topologySha256: topologySha256(state),
    protectionSha256: protectionSha256(state),
    sourceRefs: clone(candidate.sourceRefs),
    sourceSha256,
    beforeRefs: clone(orientation.beforeRefs),
    beforeSha256,
    afterRefs: clone(orientation.afterRefs),
    afterSha256,
    fold,
  };
}

function renderFoldParts(
  parts: FoldPart[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): unknown[] | null {
  const byId = foldMap(state);
  const output: unknown[] = [];
  for (const part of parts) {
    if (part.kind === "raw") {
      const item = exactMapped(snapshot, part.ref);
      if (!item) return null;
      output.push(clone(item.message));
    } else {
      const child = byId.get(part.foldId);
      if (!child) return null;
      const rendered = renderFold(child, state, snapshot);
      if (!rendered) return null;
      output.push(...rendered);
    }
  }
  return output;
}

function stateWithNestedFold(state: ActiveContextState, fold: ActiveFold): ActiveContextState {
  const childIds = new Set(childFoldIds(fold));
  if (state.folds.some((item) => item.id === fold.id)) throw new Error("Prepared fold already exists");
  const folds = state.folds.map((item) => childIds.has(item.id) ? { ...item, parentId: fold.id } : item);
  folds.push(clone(fold));
  const collapse = new Set<string>(childIds);
  for (const childId of childIds) for (const id of descendantIds(state, childId)) collapse.add(id);
  return {
    ...state,
    folds: validateFoldForest(folds),
    expanded: state.expanded.filter((id) => !collapse.has(id)),
    tokensSinceToolFold: fold.kind === "tool-result" ? 0 : state.tokensSinceToolFold,
    leases: Object.fromEntries(Object.entries(state.leases)
      .filter(([id]) => !collapse.has(id))),
  };
}

function preparedPartsStillExact(prepared: PreparedFold, state: ActiveContextState): boolean {
  const byId = foldMap(state);
  const refs: EvidenceRef[] = [];
  for (const part of prepared.fold.parts) {
    if (part.kind === "raw") refs.push(part.ref);
    else {
      const child = byId.get(part.foldId);
      if (!child || child.parentId !== null) return false;
      refs.push(...flattenFoldRefs(child, state));
    }
  }
  return stableStringify(refs) === stableStringify(prepared.sourceRefs) &&
    prepared.fold.id === foldIdFor(prepared.fold.kind, prepared.fold.parts);
}

function preparedMatchesCandidate(prepared: PreparedFold, candidate: FoldCandidate | null): boolean {
  return Boolean(candidate) && stableStringify({
    kind: prepared.fold.kind,
    parts: prepared.fold.parts.map(normalizedPart),
    sourceRefs: prepared.sourceRefs,
  }) === stableStringify({
    kind: candidate!.kind,
    parts: candidate!.parts.map(normalizedPart),
    sourceRefs: candidate!.sourceRefs,
  });
}

export function preparedFoldError(input: {
  prepared: PreparedFold;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  ratio?: number | null;
}): string | null {
  const { prepared, snapshot, state } = input;
  if (prepared.sessionId !== snapshot.sessionId) return "session drift";
  if (prepared.generation !== input.generation) return "generation drift";
  if (prepared.topologySha256 !== topologySha256(state)) return "topology drift";
  if (prepared.protectionSha256 !== protectionSha256(state)) return "protection drift";
  if (!preparedPartsStillExact(prepared, state)) return "prepared parts drift";
  const indices = refsInOrder(snapshot, prepared.sourceRefs);
  if (!indices) return "source mapping drift";
  let sourceText: string;
  try { sourceText = encodedFoldSource(snapshot, state, prepared.fold.parts, prepared.fold.kind); }
  catch { return "source hash drift"; }
  if (sha256Text(sourceText) !== prepared.sourceSha256) return "source hash drift";
  let orientation;
  try { orientation = boundedOrientation(snapshot, prepared.sourceRefs); }
  catch { return "orientation drift"; }
  if (stableStringify(orientation.beforeRefs) !== stableStringify(prepared.beforeRefs) ||
      stableStringify(orientation.afterRefs) !== stableStringify(prepared.afterRefs) ||
      sha256Text(orientation.beforeText) !== prepared.beforeSha256 ||
      sha256Text(orientation.afterText) !== prepared.afterSha256) return "orientation drift";
  if (prepared.branchSha256 !== branchSha256(snapshot, [
    ...prepared.beforeRefs, ...prepared.sourceRefs, ...prepared.afterRefs,
  ])) return "branch drift";
  const toolSource = prepared.fold.kind === "tool-result";
  if (indices.some((index) => toolSource
    ? snapshot.toolProtectedIndices.has(index)
    : snapshot.protectedIndices.has(index))) return "fresh-tail drift";
  if (toolSource
    ? toolRefsProtected(prepared.sourceRefs, state, snapshot)
    : refsProtected(prepared.sourceRefs, state, snapshot)) return "source became protected";
  if (Object.prototype.hasOwnProperty.call(input, "ratio")) {
    if (input.ratio === null || typeof input.ratio !== "number" || !Number.isFinite(input.ratio)) {
      return "current pressure unavailable";
    }
    if (!preparedMatchesCandidate(prepared, selectAutomaticCandidate(snapshot, state, input.ratio))) {
      return "automatic candidate drift";
    }
  }
  return null;
}

function descendantIds(state: ActiveContextState, id: string): Set<string> {
  const byId = foldMap(state);
  const out = new Set<string>();
  const visit = (foldId: string): void => {
    for (const child of childFoldIds(byId.get(foldId)!)) {
      out.add(child);
      visit(child);
    }
  };
  if (byId.has(id)) visit(id);
  return out;
}

export function commitPreparedFold(input: {
  prepared: PreparedFold;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
}): ActiveContextState {
  const error = preparedFoldError(input);
  if (error) throw new Error(`Prepared active-context fold discarded: ${error}`);
  const nested = stateWithNestedFold(input.state, input.prepared.fold);
  const next = clearPrepared({ ...nested, revision: input.state.revision + 1 });
  // A fold is not committed unless its provider projection preserves every
  // existing tool-call/output pair atomically. This keeps malformed provider
  // context non-constructible even if a future selector regresses.
  projectActiveContext(input.snapshot, next);
  return next;
}

export function setFoldProjectionState(
  state: ActiveContextState,
  id: string,
  projection: "folded" | "expanded",
): ActiveContextState {
  const fold = state.folds.find((item) => item.id === id);
  if (!fold) throw new Error(`Unknown active-context fold ${id}`);
  const expanded = new Set(state.expanded);
  if (projection === "expanded") {
    if (fold.parentId && !expanded.has(fold.parentId)) {
      throw new Error(`Expand parent ${fold.parentId} before child ${id}`);
    }
    expanded.add(id);
    for (const descendant of descendantIds(state, id)) expanded.delete(descendant);
  } else {
    expanded.delete(id);
    for (const descendant of descendantIds(state, id)) expanded.delete(descendant);
  }
  return clearPrepared({ ...state, revision: state.revision + 1, expanded: [...expanded] });
}

function withExpandLease(state: ActiveContextState, id: string): ActiveContextState {
  const leases = { ...state.leases, [id]: EXPAND_LEASE_GENERATIONS };
  const entries = Object.entries(leases);
  if (entries.length > MAX_EXPAND_LEASES) {
    entries.sort(([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId));
    delete leases[entries[0][0]];
  }
  return { ...state, leases };
}

function requireActiveFold(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  id: string,
): ActiveFold {
  const fold = state.folds.find((item) => item.id === id);
  if (!fold || !foldInterval(fold, state, snapshot)) {
    throw new Error(`Active-context fold ${id} is not present in the current Pi context event`);
  }
  return fold;
}

export function protectEvidence(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  protect: boolean,
): ActiveContextState {
  const refs = ids.flatMap((id) => {
    const fold = state.folds.find((item) => item.id === id);
    if (fold) return flattenFoldRefs(requireActiveFold(snapshot, state, id), state);
    const item = snapshot.mapped.find((candidate) => candidate.ref?.entryId === id);
    if (!item?.ref) throw new Error(`Unknown active-context source ${id}`);
    return [item.ref];
  });
  const byKey = new Map(state.protected.map((ref) => [objectRefKey(ref), ref]));
  for (const ref of refs) protect ? byKey.set(objectRefKey(ref), ref) : byKey.delete(objectRefKey(ref));
  return clearPrepared({
    ...state,
    revision: state.revision + 1,
    protected: [...byKey.values()],
  });
}

function siblingIds(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string[] {
  if (fold.parentId) {
    const parent = state.folds.find((item) => item.id === fold.parentId);
    return parent ? childFoldIds(parent) : [];
  }
  return orderedRoots(state, snapshot).map((item) => item.fold.id);
}

function foldNavigation(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): {
  previous: string | null;
  next: string | null;
} {
  const siblings = siblingIds(fold, state, snapshot);
  const index = siblings.indexOf(fold.id);
  return {
    previous: index > 0 ? siblings[index - 1] : null,
    next: index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null,
  };
}

function foldPlaceholder(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string {
  const navigation = foldNavigation(fold, state, snapshot);
  const parent = fold.parentId ?? "root";
  return [
    `[Quorum active-context fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=${parent}; children=${childFoldIds(fold).length}; ` +
      `previous=${navigation.previous ?? "none"}; next=${navigation.next ?? "none"}.`,
    `Expand exactly: ${snapshot.toolName} {"action":"expand","id":"${fold.id}"}`,
    `List/page exactly: ${snapshot.toolName} {"action":"status"}`,
  ].join("\n");
}

function renderFold(
  fold: ActiveFold,
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): unknown[] | null {
  const refs = flattenFoldRefs(fold, state);
  const indices = refsInOrder(snapshot, refs);
  if (!indices) return null;
  const mustReveal = state.expanded.includes(fold.id) || (fold.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot));
  if (!mustReveal) {
    const first = snapshot.messages[indices[0]] as Record<string, unknown>;
    const text = foldPlaceholder(fold, state, snapshot);
    if (fold.kind === "tool-result") return indices.map((index) => ({
      ...clone(snapshot.messages[index] as Record<string, unknown>),
      content: [{ type: "text", text }],
    }));
    return [{
      role: "custom",
      customType: `${snapshot.entryTypePrefix}-fold`,
      content: text,
      display: false,
      details: { source: "quorum/active-context", foldId: fold.id },
      timestamp: typeof first?.timestamp === "number" ? first.timestamp : 0,
    }];
  }
  const byId = foldMap(state);
  const output: unknown[] = [];
  for (const part of fold.parts) {
    if (part.kind === "raw") {
      const item = exactMapped(snapshot, part.ref);
      if (!item) return null;
      output.push(clone(item.message));
    } else {
      const child = byId.get(part.foldId);
      if (!child) return null;
      const rendered = renderFold(child, state, snapshot);
      if (!rendered) return null;
      output.push(...rendered);
    }
  }
  return output;
}

interface ToolLinkageCount {
  calls: number;
  results: number;
}

function toolLinkageCounts(messages: unknown[]): Map<string, ToolLinkageCount> {
  const counts = new Map<string, ToolLinkageCount>();
  const increment = (id: string, field: keyof ToolLinkageCount): void => {
    const current = counts.get(id) ?? { calls: 0, results: 0 };
    current[field] += 1;
    counts.set(id, current);
  };
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "assistant") {
      const content = denseOwnArrayValues(ownValue(message, "content"));
      if (!content) continue;
      for (const part of content) {
        if (ownValue(part, "type") !== "toolCall") continue;
        const id = ownValue(part, "id");
        if (typeof id === "string" && id) increment(id, "calls");
      }
    } else if (role === "toolResult") {
      const id = ownValue(message, "toolCallId");
      if (typeof id === "string" && id) increment(id, "results");
    }
  }
  return counts;
}

function assertProjectionPreservesToolLinkage(source: unknown[], projected: unknown[]): void {
  const before = toolLinkageCounts(source);
  const after = toolLinkageCounts(projected);
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const original = before.get(id) ?? { calls: 0, results: 0 };
    const visible = after.get(id) ?? { calls: 0, results: 0 };
    const uniquelyClosed = original.calls === 1 && original.results === 1;
    const valid = uniquelyClosed
      ? (visible.calls === 1 && visible.results === 1) ||
        (visible.calls === 0 && visible.results === 0)
      : visible.calls === original.calls && visible.results === original.results;
    if (!valid) {
      throw new Error(
        `Active-context projection split tool call/result linkage for ${id.slice(0, 120)}: ` +
        `${original.calls}/${original.results} became ${visible.calls}/${visible.results}`,
      );
    }
  }
}

export function projectActiveContext(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): unknown[] {
  validateFoldForest(state.folds);
  const replacements = new Map<number, { end: number; messages: unknown[] }>();
  for (const root of orderedRoots(state, snapshot)) {
    const rendered = renderFold(root.fold, state, snapshot);
    if (rendered) replacements.set(root.start, { end: root.end, messages: rendered });
  }
  const output: unknown[] = [];
  for (let index = 0; index < snapshot.messages.length;) {
    const replacement = replacements.get(index);
    if (replacement) {
      output.push(...replacement.messages);
      index = replacement.end + 1;
    } else {
      output.push(clone(snapshot.messages[index]));
      index += 1;
    }
  }
  assertProjectionPreservesToolLinkage(snapshot.messages, output);
  return output;
}

function foldStatusRow(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): Record<string, unknown> {
  const navigation = foldNavigation(fold, state, snapshot);
  const interval = foldInterval(fold, state, snapshot);
  const refs = flattenFoldRefs(fold, state);
  const allSourceIds = refs.map((ref) => ref.entryId);
  const sourceIds = allSourceIds.slice(0, 64);
  const blocked = fold.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot);
  const projection = state.expanded.includes(fold.id) ? "expanded" : "folded";
  return {
    id: fold.id,
    kind: fold.kind,
    parent: fold.parentId,
    children: childFoldIds(fold),
    previous: navigation.previous,
    next: navigation.next,
    state: projection,
    active: Boolean(interval),
    protected: blocked,
    sourceIds,
    sourceCount: allSourceIds.length,
    sourceIdsTruncated: sourceIds.length < allSourceIds.length,
    sourceSha256: fold.sourceSha256,
    actions: {
      primary: projection === "folded"
        ? { action: "expand", id: fold.id }
        : { action: "refold", id: fold.id },
      expand: { action: "expand", id: fold.id },
      refold: { action: "refold", id: fold.id },
      protect: { action: "protect", ids: [fold.id] },
    },
  };
}

export function activeContextStatus(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  offset = 0,
  limit = 40,
  maximumChapterSourceRefs = Number.MAX_SAFE_INTEGER,
): Record<string, unknown> {
  const roots = orderedRoots(state, snapshot).map((item) => item.fold.id);
  const byId = foldMap(state);
  const ordered: ActiveFold[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    const fold = byId.get(id);
    if (!fold || seen.has(id)) return;
    seen.add(id);
    ordered.push(fold);
    for (const child of childFoldIds(fold)) visit(child);
  };
  for (const root of roots) visit(root);
  const selected = ordered.slice(offset, offset + limit);
  const protectedKeys = explicitProtectedKeys(state);
  const objects = snapshot.mapped.flatMap((item) => item.ref ? [{
    id: item.ref.entryId,
    role: item.ref.role,
    sha256: item.ref.sha256,
    position: item.index,
    stale: !snapshot.protectedIndices.has(item.index),
    protected: snapshot.protectedIndices.has(item.index) || protectedKeys.has(objectRefKey(item.ref)),
    staleToolResult: item.ref.role === "toolResult" &&
      !snapshot.toolProtectedIndices.has(item.index) && !protectedKeys.has(objectRefKey(item.ref)) &&
      resultCall(snapshot, item.index, true) !== null,
  }] : []);
  const selectedObjects = objects.slice(offset, offset + limit);
  const eligibleChapter = selectAutomaticChapter(snapshot, state, maximumChapterSourceRefs);
  const eligibleSourceIds = eligibleChapter?.sourceRefs.map((ref) => ref.entryId) ?? [];
  const eligibleEndpoints = eligibleSourceIds.length
    ? [...new Set([eligibleSourceIds[0], eligibleSourceIds.at(-1)!])]
    : [];
  return {
    version: 1,
    service: "active-context-folding",
    roots,
    folds: selected.map((fold) => foldStatusRow(fold, state, snapshot)),
    offset,
    nextOffset: offset + selected.length < ordered.length ? offset + selected.length : null,
    totalFolds: ordered.length,
    protectedSourceIds: state.protected.flatMap((ref) => exactMapped(snapshot, ref) ? [ref.entryId] : []),
    objects: selectedObjects,
    totalObjects: objects.length,
    nextObjectOffset: offset + selectedObjects.length < objects.length ? offset + selectedObjects.length : null,
    eligibleChapter: eligibleChapter ? {
      kind: "chapter",
      sourceCount: eligibleSourceIds.length,
      sourceIds: eligibleSourceIds.slice(0, 64),
      sourceIdsTruncated: eligibleSourceIds.length > 64,
      startId: eligibleSourceIds[0],
      endId: eligibleSourceIds.at(-1),
      action: { action: "fold", ids: eligibleEndpoints, brief: "<factual brief, at most 1000 characters>" },
    } : null,
    rawTailMinimumBytes: snapshot.policy.freshBytes,
    currentTurnRequiresBoundary: false,
    actions: {
      status: { action: "status", offset, limit },
      fold: { action: "fold", ids: ["<source-or-fold-id>"], brief: "<optional factual brief, at most 1000 characters>" },
      protect: { action: "protect", ids: ["<source-or-fold-id>"] },
    },
  };
}

function visibleCollapsedFolds(
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): ActiveFold[] {
  const byId = foldMap(state);
  const output: ActiveFold[] = [];
  const visit = (fold: ActiveFold): void => {
    const refs = flattenFoldRefs(fold, state);
    if (!foldInterval(fold, state, snapshot)) return;
    const protectedSource = fold.kind === "tool-result"
      ? toolRefsProtected(refs, state, snapshot)
      : refsProtected(refs, state, snapshot);
    if (!state.expanded.includes(fold.id) && !protectedSource) {
      output.push(fold);
      return;
    }
    for (const childId of childFoldIds(fold)) visit(byId.get(childId)!);
  };
  for (const root of orderedRoots(state, snapshot)) visit(root.fold);
  return output;
}

export function projectionSlateCandidates(
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
  limit = 16,
): Array<Record<string, unknown>> {
  return visibleCollapsedFolds(state, snapshot).slice(0, limit).flatMap((fold, rank) => {
    const replacement = renderFold(fold, state, snapshot);
    const expandedState = { ...state, expanded: [...state.expanded, fold.id] };
    const source = renderFold(fold, expandedState, snapshot);
    if (!replacement || !source) return [];
    const replacementBytes = bytes(replacement);
    const sourceBytes = bytes(source);
    const saved = sourceBytes - replacementBytes;
    if (saved <= 0) return [];
    const provenanceKind = (fold.provenance as { kind: string }).kind;
    const generator = provenanceKind === "model" || provenanceKind === "luna"
      ? "projection-model"
      : provenanceKind === "deterministic" ? "projection-deterministic" : "projection-supplied";
    return [{
      version: 1,
      key: `projection:${fold.id}`,
      kind: "projection",
      domain: "system",
      horizon: "working",
      source_id: fold.id,
      source_version: fold.sourceSha256,
      route: { tool: snapshot.toolName, arguments: { action: "expand", id: fold.id } },
      token_cost: Math.max(1, Math.ceil(replacementBytes / 4)),
      expansion_cost: Math.max(1, Math.ceil(sourceBytes / 4)),
      rank,
      score: Math.min(1, saved / sourceBytes),
      raw_score: saved,
      confidence: "exact",
      freshness: "current",
      locked_owner: false,
      collapse_key: `projection:${fold.id}`,
      generator,
      generator_version: "memory-slate-generators-v2",
      recency: null,
    }];
  });
}

export function recoverFoldMessages(input: {
  foldId: string;
  state: ActiveContextState;
  entries: Array<Record<string, unknown>>;
  sessionId: string;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
}): unknown[] {
  const fold = input.state.folds.find((item) => item.id === input.foldId);
  if (!fold) throw new Error(`Unknown active-context fold ${input.foldId}`);
  const projectEntry = input.projectEntry ?? sessionEntryMessages;
  const exact = new Map<string, unknown>();
  for (const entry of input.entries) {
    if (typeof entry?.id !== "string") continue;
    for (const message of projectEntry(entry)) {
      const ref = evidenceRef(input.sessionId, entry.id, message);
      exact.set(`${objectRefKey(ref)}:${ref.sha256}`, message);
    }
  }
  return flattenFoldRefs(fold, input.state).map((ref) => {
    if (ref.sessionId !== input.sessionId) throw new Error(`Fold source ${ref.entryId} belongs to another session`);
    const message = exact.get(`${objectRefKey(ref)}:${ref.sha256}`);
    if (!message || evidenceSha256(message) !== ref.sha256) {
      throw new Error(`Exact recovery failed for ${ref.entryId}`);
    }
    return clone(message);
  });
}

interface AdvisorySchedule {
  key: string;
  rungs: Array<{ milestone: AdvisoryMilestone; threshold: number; budget: number }>;
}

function advisoryState(state: ActiveContextState): NonNullable<ActiveContextState["advisory"]> {
  if (state.advisory === undefined) return { highWater: 0, delivered: {} };
  if (!validAdvisoryState(state.advisory)) {
    throw new Error("Corrupt in-memory advisory state (no silent fallback)");
  }
  return clone(state.advisory);
}

function clearArmedAdvisory(state: ActiveContextState): ActiveContextState {
  const current = advisoryState(state);
  if (!current.armed) return state;
  const { armed: _armed, ...advisory } = current;
  return { ...state, advisory };
}

export function advisorySchedule(
  snapshot: Pick<ActiveContextSnapshot, "policy" | "contextWindow">,
): AdvisorySchedule {
  const raw = [
    { milestone: "notice" as const, threshold: 0.50, budget: ADVISORY_BUDGETS.notice },
    { milestone: "tools" as const, threshold: snapshot.policy.toolFoldRatio - 0.04,
      budget: ADVISORY_BUDGETS.tools },
    { milestone: "chapters" as const, threshold: snapshot.policy.prepareRatio - 0.05,
      budget: ADVISORY_BUDGETS.chapters },
    { milestone: "urgent" as const, threshold: hardFenceRatio(snapshot) - 0.03,
      budget: ADVISORY_BUDGETS.urgent },
  ];
  for (let index = raw.length - 2; index >= 0; index -= 1) {
    raw[index].threshold = Math.min(raw[index].threshold, raw[index + 1].threshold - 0.02);
  }
  for (const rung of raw) rung.threshold = Math.max(0, Math.min(1, rung.threshold));
  return {
    key: sha256Value(raw.map(({ milestone, threshold }) => ({ milestone, threshold }))),
    rungs: raw,
  };
}

function updateAdvisoryMilestone(
  currentState: ActiveContextState,
  ratio: number,
  schedule: AdvisorySchedule,
  scheduleChanged: boolean,
  scheduleKey: string,
): { state: ActiveContextState; milestone: AdvisoryMilestone | null } {
  const current = advisoryState(currentState);
  if (scheduleChanged) {
    return {
      state: { ...currentState, advisory: { ...current, highWater: Math.min(1, ratio) } },
      milestone: null,
    };
  }
  let highWater = current.highWater;
  for (let index = schedule.rungs.length - 1; index >= 0; index -= 1) {
    const rung = schedule.rungs[index];
    if ((current.delivered[rung.milestone] ?? 0) > 0 && ratio < 0.85 * rung.threshold) {
      highWater = Math.min(highWater, index > 0 ? schedule.rungs[index - 1].threshold : 0);
    }
  }
  const crossed = schedule.rungs.filter((rung) =>
    highWater < rung.threshold && ratio >= rung.threshold &&
    (current.delivered[rung.milestone] ?? 0) < rung.budget);
  const selected = crossed.at(-1) ?? null;
  const delivered = { ...current.delivered };
  if (selected) delivered[selected.milestone] = (delivered[selected.milestone] ?? 0) + 1;
  const armed = selected
    ? { milestone: selected.milestone, threshold: selected.threshold, scheduleKey }
    : current.armed;
  return {
    state: {
      ...currentState,
      advisory: {
        highWater: Math.min(1, Math.max(highWater, ratio)),
        delivered,
        ...(armed ? { armed } : {}),
      },
    },
    milestone: selected?.milestone ?? null,
  };
}

function milestoneText(
  milestone: AdvisoryMilestone,
  sessionId: string,
  threshold: number,
  toolName: string,
): string {
  const percent = Math.round(threshold * 100);
  const prefix = `[Quorum context milestone ${milestone}; session ${sessionId.slice(0, 16)}]`;
  if (milestone === "notice") {
    return `${prefix} Context pressure has crossed ${percent}%. Automatic folding is available. ` +
      `Inspect candidates exactly with ${toolName} {"action":"status"}.`;
  }
  if (milestone === "tools") {
    return `${prefix} The read-only tool-fold rung begins at ${percent}%. ` +
      "Eligible completed tool batches can be folded now; current endpoint ids are in the live advisory.";
  }
  if (milestone === "chapters") {
    return `${prefix} The chapter preparation rung begins at ${percent}%. ` +
      `Use eligibleChapter endpoints with ${toolName} ` +
      '{"action":"fold","ids":["<start>","<end>"],"brief":"<factual brief>"}.';
  }
  return `${prefix} The hard context fence is near. The next automatic action is a committed chapter fold ` +
    "or the provider request is aborted before transmission.";
}

function liveAdvisoryText(input: {
  milestone: AdvisoryMilestone;
  ratio: number;
  toolEndpoints: string[];
  chapterEndpoints: string[];
  remediationCount: number;
}): string {
  const tools = input.toolEndpoints.length
    ? input.toolEndpoints.slice(0, 3).join(", ")
    : "none";
  const chapter = input.chapterEndpoints.length
    ? `${input.chapterEndpoints[0]}..${input.chapterEndpoints.at(-1)}`
    : "none";
  return boundReceiptText(
    `[Quorum context advisory] pressure ${Math.round(input.ratio * 100)}%; milestone ${input.milestone}; ` +
      `eligible read-only batch endpoints: ${tools}; eligibleChapter endpoints: ${chapter}; ` +
      `session milestone count: ${input.remediationCount}.`,
    2_048,
    "[Quorum context advisory] Live pressure details are unavailable.",
  );
}

export function registerActiveContext(pi: any, options: {
  summarizeContextSpan?: (request: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
  setProjectionProvider?: (provider: (ctx: any) => Array<Record<string, unknown>>) => void;
  toolActions?: readonly ActiveContextToolAction[];
  toolName?: string;
  entryTypePrefix?: string;
  commandPrefix?: string;
  commandNames?: { status?: string; fold?: string };
  readOnlyTools?: ReadonlySet<string>;
  blockingTools?: readonly string[];
}): { projectionCandidates: (ctx: any) => Array<Record<string, unknown>> } {
  const toolName = options.toolName ?? "quorum_context";
  const entryTypePrefix = options.entryTypePrefix ?? "quorum-active-context";
  const commandPrefix = options.commandPrefix ?? "";
  const readOnlyTools = options.readOnlyTools ?? READ_ONLY_TOOLS_DEFAULT;
  if (!toolName || !entryTypePrefix || typeof commandPrefix !== "string" ||
      (commandPrefix && !/^[a-z0-9-]+$/.test(commandPrefix)) ||
      [...readOnlyTools].some((name) => typeof name !== "string" || !name)) {
    throw new Error("Active-context names and read-only tools must be nonempty strings");
  }
  const commandStem = commandPrefix ? `${commandPrefix.replace(/-+$/, "")}-` : "";
  // Full-name override for hosts that need non-default command names (e.g. the
  // pi-fold package's neutral "context"); commandPrefix remains the derived form.
  const commandNames = {
    status: options.commandNames?.status ?? `${commandStem}quorum-context`,
    fold: options.commandNames?.fold ?? `${commandStem}fold-context`,
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
  const defaultEntryTypes = entryTypePrefix === ACTIVE_CONTEXT_STATUS_KEY;
  const providerMeasurementEntryType = defaultEntryTypes
    ? PROVIDER_CONTEXT_MEASUREMENT_ENTRY
    : `${entryTypePrefix}-provider-context-measurement`;
  const nativeReceiptEntryType = defaultEntryTypes
    ? NATIVE_COMPACTION_RECEIPT_ENTRY
    : `${entryTypePrefix}-native-compaction-receipt`;
  const nativeDecisionEntryType = defaultEntryTypes
    ? NATIVE_COMPACTION_DECISION_ENTRY
    : `${entryTypePrefix}-native-compaction-decision`;
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

  let generation = 0;
  let shuttingDown = false;
  let state: ActiveContextState | null = null;
  let persisted: ActiveContextState | null = null;
  let latestSnapshot: ActiveContextSnapshot | null = null;
  let latestSnapshotError: string | null = null;
  let latestRatio: number | null = null;
  let lastProviderMeasurement: ProviderContextMeasurement | null = null;
  let pendingManual = false;
  let preparing: { id: string; controller: AbortController; promise: Promise<void> } | null = null;
  let lastThresholdDecision: Record<string, unknown> | null = null;
  let pendingNativeReceipt: NativeCompactionCompletionReceipt | null = null;
  let lastPreparationError: string | null = null;
  let boundaryFailure: string | null = null;
  let lastPreparationCandidateId: string | null = null;
  let lastSelectionKind: FoldKind | "refold" | null = null;
  let lastSelectionSourceIds: string[] = [];
  let pendingContextNote: string | null = null;
  let historicalGuidanceEntries = 0;
  let armedMilestone: AdvisoryMilestone | null = null;
  let advisoryScheduleKey: string | null = null;
  let lastAutomaticAction: Record<string, unknown> | null = null;
  let automaticFailure: AutomaticFailureState | null = null;
  let hardFenceNoticeKey: string | null = null;
  let hardFenceReleaseSessionId: string | null = null;
  let blockingToolHarvestedThisTurn = false;
  let blockingToolHarvestQueuedThisTurn = false;
  const hardFenceReleasedProjectionKeys = new Set<string>();
  const failedPreparations = new Set<string>();
  let actionQueue = Promise.resolve<unknown>(undefined);
  let persistenceQueue = Promise.resolve<void>(undefined);
  let providerMeasurementQueue = Promise.resolve<void>(undefined);
  const providerMeasurementReceipts = new Set<string>();
  const providerMeasurementRevisionByMessageSha = new Map<string, number>();
  const providerMeasurementByMessageSha = new Map<string, ProviderContextMeasurementReceipt>();
  const providerMeasurementAnchorByMessageSha = new Map<string, ProviderMeasurementAnchor>();
  let persistedWireVersion: 0 | 1 | 2 = 0;
  let persistedStateSha256 = "";
  let persistedFoldRecords = new Map<string, FoldRecordEntry>();
  let nativeReceiptQueue = Promise.resolve<void>(undefined);
  let contextQueue = Promise.resolve<void>(undefined);

  const durableProviderMeasurementReceiptMatches = (
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): boolean => {
    const receipt = providerMeasurementByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && receipt.projectionRevision === projectionRevision &&
      receipt.provider === measurement.provider && receipt.model === measurement.model &&
      receipt.tokens === measurement.tokens && receipt.contextWindow === measurement.contextWindow);
  };

  const durableProviderMeasurementMatches = (
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!state) return false;
    const receipt = providerMeasurementByMessageSha.get(measurement.messageSha256);
    const anchor = providerMeasurementAnchorByMessageSha.get(measurement.messageSha256);
    return Boolean(receipt && anchor && anchor.sessionId === state.sessionId &&
      anchor.generation === generation &&
      anchor.topologySha256 === topologySha256(state) &&
      anchor.protectionSha256 === protectionSha256(state) &&
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
    generation === expectedGeneration && state?.sessionId === sessionId &&
    (!ctx || contextSessionMatches(ctx, sessionId));

  const updateStatus = (ctx: any): void => {
    try {
      const roots = state && latestSnapshot ? orderedRoots(state, latestSnapshot).length : 0;
      const prepared = state?.prepared ? " · brief ready" : preparing ? " · briefing" : "";
      const usage = lastProviderMeasurement
        ? ` · provider ${lastProviderMeasurement.tokens}/${lastProviderMeasurement.contextWindow}`
        : " · provider usage unmeasured";
      const suspended = automaticFailure ? " · automatic suspended" : "";
      ctx.ui?.setStatus?.(entryTypePrefix, `${toolName} folds: ${roots}${prepared}${usage}${suspended}`);
    } catch { /* Status presentation is request-ephemeral and never a lifecycle boundary. */ }
  };

  const snapshotForEvent = (ctx: any, messages: unknown[]): ActiveContextSnapshot => mapActiveContext({
    sessionId: ctx.sessionManager.getSessionId(),
    eventMessages: messages,
    contextEntries: ctx.sessionManager.buildContextEntries(),
    toolName,
    entryTypePrefix,
    readOnlyTools,
    contextWindow: contextWindowFor(ctx) ?? undefined,
  });

  const authoritativeSnapshotFor = (ctx: any): ActiveContextSnapshot => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!latestSnapshot || latestSnapshot.sessionId !== sessionId) {
      throw new Error("A current same-session Pi context event is required");
    }
    return mapActiveContext({
      sessionId,
      eventMessages: latestSnapshot.messages,
      contextEntries: ctx.sessionManager.buildContextEntries(),
      policy: latestSnapshot.policy,
      toolName,
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
    preparing?.controller.abort();
    preparing = null;
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
    generation += 1;
    shuttingDown = false;
    cancelPreparation();
    latestSnapshot = null;
    latestSnapshotError = null;
    latestRatio = null;
    lastProviderMeasurement = null;
    pendingManual = false;
    blockingToolHarvestedThisTurn = false;
    blockingToolHarvestQueuedThisTurn = false;
    if (!preserveThresholdDecision) lastThresholdDecision = null;
    lastPreparationError = null;
    boundaryFailure = null;
    lastPreparationCandidateId = null;
    lastSelectionKind = null;
    lastSelectionSourceIds = [];
    pendingContextNote = null;
    historicalGuidanceEntries = 0;
    armedMilestone = null;
    advisoryScheduleKey = null;
    lastAutomaticAction = null;
    automaticFailure = null;
    hardFenceNoticeKey = null;
    failedPreparations.clear();
    providerMeasurementReceipts.clear();
    providerMeasurementRevisionByMessageSha.clear();
    providerMeasurementByMessageSha.clear();
    providerMeasurementAnchorByMessageSha.clear();
    const sessionId = ctx.sessionManager.getSessionId();
    if (hardFenceReleaseSessionId !== sessionId) {
      hardFenceReleaseSessionId = sessionId;
      hardFenceReleasedProjectionKeys.clear();
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
        historicalGuidanceEntries += 1;
        continue;
      }
      if (entry.customType !== providerMeasurementEntryType) continue;
      try {
        const receipt = parseProviderContextMeasurementReceipt(entry.data, sessionId);
        const boundRevision = providerMeasurementRevisionByMessageSha.get(receipt.messageSha256);
        if (boundRevision !== undefined && boundRevision !== receipt.projectionRevision) {
          throw new Error("One provider response is bound to multiple projection revisions");
        }
        providerMeasurementRevisionByMessageSha.set(receipt.messageSha256, receipt.projectionRevision);
        const priorMeasurement = providerMeasurementByMessageSha.get(receipt.messageSha256);
        if (priorMeasurement && stableStringify(priorMeasurement) !== stableStringify(receipt)) {
          throw new Error("One provider response has conflicting durable measurement receipts");
        }
        providerMeasurementByMessageSha.set(receipt.messageSha256, receipt);
        const fingerprint = restoredPersistence?.projectionFingerprints.get(receipt.projectionRevision);
        if (fingerprint) {
          providerMeasurementAnchorByMessageSha.set(receipt.messageSha256, {
            sessionId,
            generation,
            ...fingerprint,
          });
        }
        providerMeasurementReceipts.add(providerMeasurementReceiptKey(
          sessionId,
          receipt.projectionRevision,
          receipt,
        ));
      } catch (error) {
        measurementRestoreError = error;
      }
    }
    const durableRestored = restored ?? emptyActiveContextState(sessionId);
    state = durableRestored.prepared ? clearPrepared(durableRestored) : clone(durableRestored);
    armedMilestone = advisoryState(state).armed?.milestone ?? null;
    persistedWireVersion = restoredPersistence?.wireVersion ?? 0;
    persistedFoldRecords = restoredPersistence?.records ?? new Map<string, FoldRecordEntry>();
    persistedStateSha256 = restoredPersistence?.stateSha256 ?? semanticStateSha256(durableRestored);
    const restoredMessages = ctx.sessionManager.buildSessionContext?.()?.messages;
    lastProviderMeasurement = latestProviderContextMeasurement(
      Array.isArray(restoredMessages) ? restoredMessages : [],
      contextWindowFor(ctx),
      ctx.model,
    );
    latestRatio = contextUsageRatio(lastProviderMeasurement);
    persisted = clone(durableRestored);
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
    const operation = persistenceQueue.then(async () => {
      if (!state || !persisted) return;
      let next = clone(state);
      if (ctx && latestSnapshot?.sessionId === next.sessionId) {
        next = persistenceProjection(next, authoritativeSnapshotFor(ctx));
      }
      next.folds = normalizeFoldsForPersistedRecords(next.folds, persistedFoldRecords);
      if (sameStateProjection(next, persisted)) {
        state = clone(persisted);
        return;
      }
      if (next.revision <= persisted.revision) next.revision = persisted.revision + 1;
      const generationAtStart = generation;
      const sessionId = next.sessionId;
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before persistence");
      }
      if (next.folds.length > MAX_ACTIVE_FOLD_RECORDS) {
        throw new Error("Active-context fold closure exceeds persistence limit");
      }
      for (const fold of next.folds) {
        const record = makeFoldRecordEntry(fold, sessionId);
        const existing = persistedFoldRecords.get(record.foldId);
        if (existing) {
          if (existing.recordSha256 !== record.recordSha256) {
            throw new Error(`Conflicting durable active-context fold ${record.foldId}`);
          }
          continue;
        }
        await pi.appendEntry(foldRecordEntryType, record);
        persistedFoldRecords.set(record.foldId, record);
        if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
          if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
          throw new Error("Active-context session changed after fold-record persistence");
        }
      }
      const wire = persistedWireVersion === 2 ? makeStateDelta(persisted, next) : makeStateCheckpoint(next);
      if (persistedWireVersion === 2 && persistedStateSha256 !== semanticStateSha256(persisted)) {
        throw new Error("Active-context durable base digest drift");
      }
      await pi.appendEntry(stateEntryType, wire);
      // Once the state event succeeds, replay owns this exact state; RAM may not roll behind it.
      persisted = clone(next);
      persistedWireVersion = 2;
      persistedStateSha256 = semanticStateSha256(next);
      state = shuttingDown ? null : clone(next);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        if (ctx && !contextSessionMatches(ctx, sessionId)) load(ctx);
        throw new Error("Active-context session changed after durable persistence");
      }
    });
    persistenceQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistThroughActionQueue = (ctx?: any): Promise<void> => {
    const operation = actionQueue.then(() => persist(ctx));
    actionQueue = operation.catch(() => undefined);
    return operation;
  };

  const persistProviderMeasurement = (
    ctx: any,
    measurement: ProviderContextMeasurement,
    projectionRevision: number,
  ): Promise<boolean> => {
    if (!state || !Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
      return Promise.resolve(false);
    }
    const generationAtStart = generation;
    const sessionId = state.sessionId;
    const queuedMeasurement = clone(measurement);
    const revision = projectionRevision;
    const anchor: ProviderMeasurementAnchor = {
      sessionId,
      generation: generationAtStart,
      topologySha256: topologySha256(state),
      protectionSha256: protectionSha256(state),
    };
    const operation = providerMeasurementQueue.then(async () => {
      if (shuttingDown || !sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed before measurement persistence");
      }
      const measurement = queuedMeasurement;
      const boundRevision = providerMeasurementRevisionByMessageSha.get(measurement.messageSha256);
      if (boundRevision !== undefined) {
        return boundRevision === revision &&
          durableProviderMeasurementReceiptMatches(measurement, revision);
      }
      const receiptKey = providerMeasurementReceiptKey(sessionId, revision, measurement);
      if (providerMeasurementReceipts.has(receiptKey)) {
        providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
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
      providerMeasurementReceipts.add(receiptKey);
      providerMeasurementRevisionByMessageSha.set(measurement.messageSha256, revision);
      providerMeasurementByMessageSha.set(measurement.messageSha256, receipt);
      providerMeasurementAnchorByMessageSha.set(measurement.messageSha256, anchor);
      if (!sessionIdentityStillValid(ctx, sessionId, generationAtStart)) {
        throw new Error("Active-context session changed during measurement persistence");
      }
      return true;
    });
    providerMeasurementQueue = operation.then(() => undefined, () => undefined);
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
      preparationError: lastPreparationError
        ? boundReceiptText(lastPreparationError, 1_200, "context preparation failed")
        : null,
      boundaryFailure: boundaryFailure
        ? boundReceiptText(boundaryFailure, 1_200, "context boundary failed")
        : null,
      selectionKind: lastSelectionKind ? boundReceiptText(lastSelectionKind, 64, "unknown") : null,
      selectionSourceIds: lastSelectionSourceIds.slice(0, 64)
        .map((id) => boundReceiptText(id, 512, "unknown-source")),
      automaticActionKind: typeof ownValue(lastAutomaticAction, "kind") === "string"
        ? boundReceiptText(ownValue(lastAutomaticAction, "kind"), 128, "unknown")
        : null,
      providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
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
    const operation = nativeReceiptQueue.then(async () => {
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
      pendingNativeReceipt = null;
    });
    nativeReceiptQueue = operation.catch(() => undefined);
    return operation;
  };

  const recoverNativeReceipts = async (ctx: any): Promise<void> => {
    if (pendingNativeReceipt) await persistNativeCompletion(pendingNativeReceipt, ctx);
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
      lastThresholdDecision = {
        handled: true,
        retry: false,
        reason: "native compaction completed; Quorum folding state rebuilt",
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
    state = clearPrepared(next);
    pendingManual = true;
    if (action === "fold") armedMilestone = null;
    boundaryFailure = null;
  };

  const persistManual = async (
    next: ActiveContextState,
    action: Exclude<ActiveContextToolAction, "status">,
    ctx: any,
  ): Promise<void> => {
    const stateAtEntry = state ? clone(state) : null;
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    markManual(next, action);
    try {
      await persist(ctx);
      pendingManual = false;
      automaticFailure = null;
      boundaryFailure = null;
    } catch (error) {
      if (persisted === persistedAtEntry && stateAtEntry) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      boundaryFailure = error instanceof Error ? error.message : String(error);
      safeNotify(ctx, `Active-context change was not persisted: ${boundaryFailure}`, "error");
      throw error;
    }
  };

  const captureTransient = () => ({
    pendingManual,
    preparing,
    pendingContextNote,
    armedMilestone,
    lastAutomaticAction,
    automaticFailure: automaticFailure ? clone(automaticFailure) : null,
    boundaryFailure,
  });
  const restoreTransient = (saved: ReturnType<typeof captureTransient>): void => {
    pendingManual = saved.pendingManual;
    preparing = saved.preparing?.controller.signal.aborted ? null : saved.preparing;
    pendingContextNote = saved.pendingContextNote;
    armedMilestone = saved.armedMilestone;
    lastAutomaticAction = saved.lastAutomaticAction;
    automaticFailure = saved.automaticFailure;
    boundaryFailure = saved.boundaryFailure;
  };
  const automaticOperationKey = (
    phase: string,
    snapshot: ActiveContextSnapshot | null = latestSnapshot,
    ratio: number | null = latestRatio,
  ): string => {
    const lifecyclePhase = ["context", "message-end", "turn-end"].includes(phase) ? "automatic-rung" : phase;
    let selection: Record<string, unknown> = { kind: lifecyclePhase };
    try {
      if (state && snapshot && ratio !== null) {
        const selected = selectAutomaticRung(snapshot, state, ratio, {
          summarizerAvailable: Boolean(options.summarizeContextSpan),
          failedPreparationIds: failedPreparations,
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
      sessionId: state?.sessionId ?? snapshot?.sessionId ?? null,
      revision: state?.revision ?? null,
      topology: state ? topologySha256(state) : null,
      protection: state ? protectionSha256(state) : null,
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
    boundaryFailure = message;
    cancelPreparation();
    if (state?.prepared) state = clearPrepared(state);
    if (automaticFailure) {
      automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        automaticFailure.suppressedCallbacks + 1,
      );
      return;
    }
    automaticFailure = {
      key,
      phase,
      message,
      firstFailedAt: Date.now(),
      attempts: 1,
      suppressedCallbacks: 0,
      persistenceDisposition,
    };
    pendingContextNote = `Automatic context management suspended after one ${phase} failure; exact Pi context remains raw and manual context actions remain available.`;
    safeNotify(ctx, `Automatic context management suspended: ${message}`, "warning");
  };

  const abortUnsafeHardContext = (
    snapshot: ActiveContextSnapshot | null,
    ctx: any,
    allowUnmeasuredRevisionRelease = false,
  ): boolean => {
    if (latestRatio === null || latestRatio < hardFenceRatio(snapshot ?? undefined, ctx) || !state) return false;
    const measuredRevision = lastProviderMeasurement
      ? providerMeasurementRevisionByMessageSha.get(lastProviderMeasurement.messageSha256)
      : undefined;
    // A durable projection topology after the measured response gets exactly
    // one provider attempt so its fold can be measured. Concurrent
    // callbacks, retries, and same-session reloads may not repeatedly release
    // that unmeasured projection. Non-structural state persistence does not
    // spend this release. A failed automatic transaction never gets this
    // escape, even if a record/state append preceded its projection failure.
    if (allowUnmeasuredRevisionRelease && !automaticFailure &&
        measuredRevision !== undefined && lastProviderMeasurement &&
        !durableProviderMeasurementMatches(lastProviderMeasurement)) {
      const releaseKey = sha256Value({
        sessionId: state.sessionId,
        topologySha256: topologySha256(state),
        protectionSha256: protectionSha256(state),
        measuredRevision,
        providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
      });
      if (!hardFenceReleasedProjectionKeys.has(releaseKey) &&
          hardFenceReleasedProjectionKeys.size < 4_096) {
        hardFenceReleasedProjectionKeys.add(releaseKey);
        return false;
      }
    }
    const key = automaticFailure?.key ?? sha256Value({
      sessionId: snapshot?.sessionId ?? state.sessionId,
      revision: state.revision,
      providerMessageSha256: lastProviderMeasurement?.messageSha256 ?? null,
      phase: "hard-provider-fence",
    });
    pendingContextNote = "Provider context reached the hard Quorum fence without a newly committed lossless fold. The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.";
    if (hardFenceNoticeKey !== key) {
      hardFenceNoticeKey = key;
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
      throw new Error(`Pi hard-fence abort capability is unavailable at ratio ${latestRatio}`);
    }
    ctx.abort();
    return true;
  };

  const startPreparation = (snapshot: ActiveContextSnapshot, ratio: number | null, ctx: any): void => {
    if (shuttingDown || !state || automaticFailure || ratio === null || state.prepared || preparing ||
        ratio < snapshot.policy.warmRatio ||
        !lastProviderMeasurement || !durableProviderMeasurementMatches(lastProviderMeasurement)) return;
    // Preparation is asynchronous but never jumps ahead of an immediately
    // committable deterministic fold on the same measured projection.
    const selection = selectAutomaticRung(snapshot, state, ratio, {
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: failedPreparations,
    });
    lastSelectionKind = selection && "candidate" in selection ? selection.candidate.kind : null;
    lastSelectionSourceIds = selection && "candidate" in selection
      ? selection.candidate.sourceRefs.slice(0, 8).map((ref) => ref.entryId)
      : [];
    if (selection?.kind !== "chapter-prepare") return;
    const candidate = selection.candidate;
    const id = automaticPreparationId(candidate, state);
    const controller = new AbortController();
    lastPreparationError = null;
    lastPreparationCandidateId = id;
    const slot = { id, controller, promise: Promise.resolve() };
    preparing = slot;
    const capturedState = clone(state);
    const capturedGeneration = generation;
    slot.promise = prepareFold({
      candidate,
      snapshot,
      state: capturedState,
      generation: capturedGeneration,
      summarize: failedPreparations.has(id) ? undefined : options.summarizeContextSpan,
      onSummarizerFailure: (error) => {
        lastPreparationError = error instanceof Error ? error.message : String(error);
        failedPreparations.add(id);
      },
      ctx,
      signal: controller.signal,
    }).then((preparedFold) => {
      const operation = actionQueue.then(() => {
        if (controller.signal.aborted ||
            !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
        const currentState = state;
        if (!currentState || topologySha256(currentState) !== preparedFold.topologySha256 ||
            protectionSha256(currentState) !== preparedFold.protectionSha256) return;
        state = { ...currentState, prepared: preparedFold };
        return persist(ctx);
      });
      actionQueue = operation.catch(() => undefined);
      return operation;
    }).catch((error) => {
      if (controller.signal.aborted ||
          !sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) return;
      lastPreparationError = error instanceof Error ? error.message : String(error);
      failedPreparations.add(id);
      suspendAutomatic(
        error,
        "chapter-prepare",
        ctx,
        sha256Value({ sessionId: snapshot.sessionId, operation: "chapter-prepare", candidateId: id }),
      );
    }).finally(() => {
      const ownsSlot = preparing === slot;
      if (ownsSlot) preparing = null;
      if (ownsSlot && sessionIdentityStillValid(ctx, snapshot.sessionId, capturedGeneration)) updateStatus(ctx);
    });
  };
  const projectWithAdvisory = (snapshot: ActiveContextSnapshot): unknown[] => {
    const projected = projectActiveContext(snapshot, state!).filter((message) => {
      const customType = ownValue(message, "customType");
      return customType !== milestoneProjectionType && customType !== advisoryProjectionType;
    });
    const armed = advisoryState(state!).armed;
    if (!armed || armed.milestone !== armedMilestone || latestRatio === null ||
        latestRatio < 0.85 * armed.threshold) return projected;
    const status = activeContextStatus(snapshot, state!, 0, 1, snapshot.policy.maxFoldSourceRefs);
    const eligible = ownValue(status, "eligibleChapter");
    const startId = ownValue(eligible, "startId");
    const endId = ownValue(eligible, "endId");
    const chapterEndpoints = typeof startId === "string" && typeof endId === "string"
      ? [startId, endId]
      : [];
    const toolEndpoints = selectAutomaticToolBatch(snapshot, state!, 1)
      .flatMap((candidate) => candidate.sourceRefs.at(-1)?.entryId ?? [])
      .slice(0, 3);
    const remediationCount = advisoryState(state!).delivered[armed.milestone] ?? 0;
    projected.push({
      role: "custom",
      customType: milestoneProjectionType,
      content: milestoneText(armed.milestone, state!.sessionId, armed.threshold, toolName),
      display: false,
      details: { source: "quorum/active-context", ephemeral: true, milestone: armed.milestone },
      timestamp: 0,
    });
    projected.push({
      role: "custom",
      customType: advisoryProjectionType,
      content: liveAdvisoryText({
        milestone: armed.milestone,
        ratio: latestRatio,
        toolEndpoints,
        chapterEndpoints,
        remediationCount,
      }),
      display: false,
      details: { source: "quorum/active-context", ephemeral: true, milestone: armed.milestone },
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
      state: state!,
      generation,
      brief,
      briefProvenance: "deterministic",
    });
    state = commitPreparedFold({ prepared: preparedFold, snapshot, state: state!, generation });
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
    const baseState = state!;
    const generationAtStart = generation;
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
      state: state!,
      generation: generationAtStart,
    });
    return { preparedFold, nextState };
  };

  const applyAutomaticRung = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!state || automaticFailure || preparing) return null;
    const selection = selectAutomaticRung(snapshot, state, ratio, {
      waiveToolCadence: rungOptions.waiveToolCadence,
      toolOnly: rungOptions.toolOnly,
      summarizerAvailable: Boolean(options.summarizeContextSpan),
      failedPreparationIds: failedPreparations,
    });
    if (!selection) return null;
    const before = bytes(projectActiveContext(snapshot, state));
    let action: Record<string, unknown> | null = null;
    if (selection.kind === "prepared-chapter" && state.prepared) {
      const error = preparedFoldError({
        prepared: state.prepared,
        snapshot,
        state,
        generation,
        ratio,
      });
      if (error) {
        state = clearPrepared(state);
      } else {
        const id = state.prepared.id;
        const sourceIds = state.prepared.sourceRefs.map((ref) => ref.entryId);
        state = commitPreparedFold({ prepared: state.prepared, snapshot, state, generation });
        action = { kind: "chapter-fold", foldIds: [id], sourceIds };
        pendingContextNote = `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
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
      pendingContextNote = `${tool.sourceRefs.length} stale completed read-only tool result(s) were folded.`;
    } else if (selection.kind === "refold") {
      cancelPreparation();
      state = setFoldProjectionState(state, selection.foldId, "folded");
      action = { kind: "refold", foldIds: [selection.foldId] };
      pendingContextNote = `Stale expanded fold ${selection.foldId} returned to its identical placeholder.`;
    } else if (selection.kind === "consolidation") {
      cancelPreparation();
      const consolidation = selection.candidate;
      const id = await commitDeterministicCandidate(
        snapshot,
        consolidation,
        deterministicConsolidationBrief(consolidation, state),
      );
      action = {
        kind: "consolidation",
        foldIds: [id],
        sourceIds: consolidation.sourceRefs.map((ref) => ref.entryId),
      };
      pendingContextNote =
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
      pendingContextNote =
        `A coherent stale chapter was folded under ${id}; exact evidence remains expandable.`;
    }
    if (!action || !state) return null;
    const after = bytes(projectActiveContext(snapshot, state));
    state = clearArmedAdvisory(state);
    armedMilestone = null;
    lastAutomaticAction = { ...action, sourceBytesSaved: Math.max(0, before - after) };
    return lastAutomaticAction;
  };
  const runAutomaticRungTransaction = async (
    snapshot: ActiveContextSnapshot,
    ratio: number,
    ctx: any,
    phase: string,
    rungOptions: { waiveToolCadence?: boolean; toolOnly?: boolean } = {},
  ): Promise<Record<string, unknown> | null> => {
    if (!state || !lastProviderMeasurement ||
        !durableProviderMeasurementMatches(lastProviderMeasurement)) return null;
    if (automaticFailure) {
      automaticFailure.suppressedCallbacks = Math.min(
        Number.MAX_SAFE_INTEGER,
        automaticFailure.suppressedCallbacks + 1,
      );
      return null;
    }
    const key = automaticOperationKey(phase, snapshot, ratio);
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const recordsAtEntry = persistedFoldRecords.size;
    const transientAtEntry = captureTransient();
    let action: Record<string, unknown> | null = null;
    try {
      action = await applyAutomaticRung(snapshot, ratio, rungOptions);
      if (action) await persist(ctx);
      if (action) boundaryFailure = null;
      return action;
    } catch (error) {
      const stateCommitted = persisted !== persistedAtEntry;
      const recordOnly = !stateCommitted && persistedFoldRecords.size > recordsAtEntry;
      if (!stateCommitted) {
        state = stateAtEntry;
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
    const operation = actionQueue.then(() =>
      runAutomaticRungTransaction(snapshot, ratio, ctx, phase));
    actionQueue = operation.catch(() => undefined);
    return operation;
  };
  const projectionCandidates = (ctx: any): Array<Record<string, unknown>> => {
    if (shuttingDown || !state) return [];
    try {
      return projectionSlateCandidates(state, authoritativeSnapshotFor(ctx));
    } catch {
      return [];
    }
  };
  options.setProjectionProvider?.(projectionCandidates);

  const enqueueLifecycleLoad = async (ctx: any): Promise<void> => {
    // A same-session start/tree reload is a projection-generation mutation.
    // Queue it behind every context authority → preparation → commit →
    // projection transaction, then serialize the actual load with the action
    // queue. Appending to actionQueue only after the context queue drains is
    // deliberate: a running context may itself need actionQueue to commit its
    // final-rung chapter, so capturing both queues up front would deadlock.
    const operation = contextQueue.then(() => {
      const loadOperation = actionQueue.then(async () => {
        load(ctx);
        await recoverNativeReceipts(ctx);
      });
      actionQueue = loadOperation.catch(() => undefined);
      return loadOperation;
    });
    contextQueue = operation.then(() => undefined, () => undefined);
    await operation;
  };

  const safeLifecycleLoad = async (ctx: any, phase: "session-start" | "session-tree"): Promise<void> => {
    try { await enqueueLifecycleLoad(ctx); }
    catch (error) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!state || state.sessionId !== sessionId) state = emptyActiveContextState(sessionId);
      if (!persisted || persisted.sessionId !== sessionId) persisted = clone(state);
      latestSnapshotError = error instanceof Error ? error.message : String(error);
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
    pendingNativeReceipt = receipt;
    load(ctx, true);
    lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: "native compaction completed; Quorum folding state rebuilt",
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
    safeNotify(ctx, "Pi native compaction ran; Quorum folding state was rebuilt.", "warning");
    updateStatus(ctx);
  });

  const attributionChanged = async (_event: unknown, ctx: any): Promise<void> => {
    generation += 1;
    cancelPreparation();
    if (state?.prepared) state = clearPrepared(state);
    latestRatio = null;
    lastProviderMeasurement = null;
    armedMilestone = state ? advisoryState(state).armed?.milestone ?? null : null;
    advisoryScheduleKey = "pending-reseed";
    lastThresholdDecision = null;
    updateStatus(ctx);
  };
  pi.on("model_select", attributionChanged);
  pi.on("thinking_level_select", attributionChanged);

  const armMilestoneForMeasurement = (
    snapshot: ActiveContextSnapshot,
    measurement: ProviderContextMeasurement,
  ): boolean => {
    if (!state) return false;
    const ratio = contextUsageRatio(measurement);
    if (ratio === null) return false;
    const schedule = advisorySchedule(snapshot);
    const scheduleKey = sha256Value({
      schedule: schedule.key,
      provider: measurement.provider,
      model: measurement.model,
      contextWindow: measurement.contextWindow,
    });
    const scheduleChanged = advisoryScheduleKey !== null && advisoryScheduleKey !== scheduleKey;
    advisoryScheduleKey = scheduleKey;
    const before = stableStringify(advisoryState(state));
    const updated = updateAdvisoryMilestone(state, ratio, schedule, scheduleChanged, scheduleKey);
    state = updated.state;
    const armed = advisoryState(state).armed;
    if (armed && ratio < 0.85 * armed.threshold) {
      state = clearArmedAdvisory(state);
      armedMilestone = null;
    } else {
      armedMilestone = armed?.milestone ?? null;
    }
    return before !== stableStringify(advisoryState(state));
  };

  const accountAnchoredMeasurement = (measurement: ProviderContextMeasurement): boolean => {
    if (!state) return false;
    if (!lastProviderMeasurement) {
      lastProviderMeasurement = measurement;
      return false;
    }
    if (lastProviderMeasurement.messageSha256 === measurement.messageSha256) return false;
    const previousTokens = lastProviderMeasurement.tokens;
    const delta = Math.max(0, measurement.tokens - previousTokens);
    const tokensSinceToolFold = Math.min(Number.MAX_SAFE_INTEGER, state.tokensSinceToolFold + delta);
    const leases = Object.fromEntries(Object.entries(state.leases)
      .flatMap(([id, remaining]) => remaining > 1 ? [[id, remaining - 1]] : []));
    const changed = tokensSinceToolFold !== state.tokensSinceToolFold ||
      stableStringify(leases) !== stableStringify(state.leases);
    if (changed) state = { ...state, tokensSinceToolFold, leases };
    return changed;
  };

  const handleContext = async (event: { messages: unknown[] }, ctx: any) => {
    if (shuttingDown) return { messages: event.messages };
    if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    latestSnapshot = null;
    latestSnapshotError = null;
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    const generationAtEntry = generation;
    let mutationAttempted = pendingManual;
    let persistedSucceeded = false;
    try {
      const snapshot = snapshotForEvent(ctx, event.messages);
      latestSnapshot = snapshot;
      if (automaticFailure) {
        automaticFailure.suppressedCallbacks = Math.min(
          Number.MAX_SAFE_INTEGER,
          automaticFailure.suppressedCallbacks + 1,
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
        const boundRevision = providerMeasurementRevisionByMessageSha.get(observed.messageSha256);
        if (boundRevision !== undefined &&
            !durableProviderMeasurementReceiptMatches(observed, boundRevision)) {
          try { await persistProviderMeasurement(ctx, observed, boundRevision); }
          catch (error) { suspendAutomatic(error, "provider-measurement", ctx); }
        }
        latestRatio = contextUsageRatio(observed);
        if (durableProviderMeasurementMatches(observed) && latestRatio !== null) {
          measurementStateChanged = accountAnchoredMeasurement(observed);
          lastProviderMeasurement = observed;
          advisoryChanged = armMilestoneForMeasurement(snapshot, observed);
          startPreparation(snapshot, latestRatio, ctx);
          if (!automaticFailure && latestRatio >= hardFenceRatio(snapshot) && preparing) {
            mutationAttempted = true;
            await preparing.promise;
            if (!sessionIdentityStillValid(ctx, snapshot.sessionId, generationAtEntry)) {
              return { messages: event.messages };
            }
          }
          if (selectAutomaticToolForRung(snapshot, state, latestRatio)) mutationAttempted = true;
          const action = await attemptAutomaticRung(snapshot, latestRatio, ctx, "context");
          if (action) {
            mutationAttempted = true;
            persistedSucceeded = true;
            advisoryChanged = false;
          }
        } else lastProviderMeasurement = observed;
      } else {
        latestRatio = contextUsageRatio(lastProviderMeasurement);
      }
      if ((advisoryChanged || measurementStateChanged) && state && persisted &&
          !sameStateProjection(state, persisted)) {
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
      if (!persistedSucceeded && persisted === persistedAtEntry) {
        state = stateAtEntry;
        restoreTransient(transientAtEntry);
      }
      latestSnapshotError = error instanceof Error ? error.message : String(error);
      if (mutationAttempted) {
        if (!persistedSucceeded) boundaryFailure = latestSnapshotError;
        suspendAutomatic(error, persistedSucceeded ? "post-persist-projection" : "context", ctx);
      }
      abortUnsafeHardContext(latestSnapshot, ctx);
      return { messages: event.messages };
    }
  };
  pi.on("context", (event: { messages: unknown[] }, ctx: any) => {
    // Pi normally requests context serially, but retries, reloads, and host
    // integrations can overlap callbacks. Serialize the entire authority →
    // preparation → commit → projection transaction so a follower cannot
    // observe a published measurement before the leader's durable receipt or
    // return raw final-rung context while the leader is preparing a brief.
    const operation = contextQueue.then(() => handleContext(event, ctx));
    contextQueue = operation.then(() => undefined, () => undefined);
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
    if (shuttingDown ||
        !sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        topologySha256(state!) !== capturedTopologySha256 ||
        protectionSha256(state!) !== capturedProtectionSha256) return;
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
    lastProviderMeasurement = measurement;
    latestRatio = measuredRatio;
    let snapshot: ActiveContextSnapshot;
    try { snapshot = authoritativeSnapshotFor(ctx); }
    catch {
      updateStatus(ctx);
      return;
    }
    const advisoryChanged = armMilestoneForMeasurement(snapshot, measurement);
    startPreparation(snapshot, latestRatio, ctx);
    if (latestRatio >= hardFenceRatio(measurement, ctx) && preparing) await preparing.promise;
    if (!sessionIdentityStillValid(ctx, capturedSessionId, capturedGeneration) ||
        !durableProviderMeasurementMatches(measurement)) return;
    const action = await attemptAutomaticRung(
      authoritativeSnapshotFor(ctx),
      latestRatio,
      ctx,
      "message-end",
    );
    if (!action && (advisoryChanged || measurementStateChanged) && state && persisted &&
        !sameStateProjection(state, persisted)) {
      await persistThroughActionQueue(ctx);
    }
    updateStatus(ctx);
  };

  pi.on("message_end", async (event: Record<string, unknown>, ctx: any) => {
    if (shuttingDown) return;
    try {
      const message = ownValue(event, "message");
      const measurement = providerContextMeasurement(
        message,
        contextWindowFor(ctx) ?? DEFAULT_CONTEXT_WINDOW,
        ctx.model,
      );
      if (!measurement || !state) return;
      const capturedSessionId = ctx.sessionManager.getSessionId();
      const capturedGeneration = generation;
      const capturedProjectionRevision = state.revision;
      const capturedTopologySha256 = topologySha256(state);
      const capturedProtectionSha256 = protectionSha256(state);
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
    if (shuttingDown || blockingToolHarvestedThisTurn || blockingToolHarvestQueuedThisTurn ||
        typeof calledTool !== "string" || !blockingTools.has(calledTool)) return;
    blockingToolHarvestQueuedThisTurn = true;
    const operation = actionQueue.then(async () => {
      try {
        if (!state || latestRatio === null || !lastProviderMeasurement || automaticFailure ||
            !durableProviderMeasurementMatches(lastProviderMeasurement)) return null;
        cancelPreparation();
        let snapshot: ActiveContextSnapshot;
        try { snapshot = authoritativeSnapshotFor(ctx); }
        catch { return null; }
        const candidate = selectAutomaticToolForRung(snapshot, state, latestRatio, true);
        if (!candidate) {
          blockingToolHarvestedThisTurn = true;
          return null;
        }
        const action = await runAutomaticRungTransaction(
          snapshot,
          latestRatio,
          ctx,
          "tool-call",
          { waiveToolCadence: true, toolOnly: true },
        );
        if (action) blockingToolHarvestedThisTurn = true;
        return action;
      } finally {
        blockingToolHarvestQueuedThisTurn = false;
        try { updateStatus(ctx); } catch { /* A blocking tool call must never wait on presentation. */ }
      }
    });
    actionQueue = operation.catch(() => undefined);
  });
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    blockingToolHarvestedThisTurn = false;
    blockingToolHarvestQueuedThisTurn = false;
    if (shuttingDown || !state || !persisted) return;
    const stateAtEntry = clone(state);
    const persistedAtEntry = persisted;
    const transientAtEntry = captureTransient();
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      if (!pendingManual && !automaticFailure && latestRatio !== null && lastProviderMeasurement &&
          durableProviderMeasurementMatches(lastProviderMeasurement)) {
        startPreparation(snapshot, latestRatio, ctx);
        if (latestRatio >= hardFenceRatio(snapshot) && preparing) await preparing.promise;
        await attemptAutomaticRung(snapshot, latestRatio, ctx, "turn-end");
      }
      pendingManual = false;
      if (!automaticFailure) boundaryFailure = null;
    } catch (error) {
      if (persisted === persistedAtEntry) {
        state = stateAtEntry;
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
      lastThresholdDecision = {
        handled: false,
        retry: false,
        reason: "manual native compaction explicitly requested by the user",
        compactionReason: reason,
      };
      try { updateStatus(ctx); } catch { /* Manual rescue must survive presentation failure. */ }
      return undefined;
    }
    lastThresholdDecision = {
      handled: true,
      retry: false,
      reason: "blocked stock automatic compaction; Quorum context folding remains authoritative",
      compactionReason: reason,
      nativeCompactionCompleted: false,
    };
    return { cancel: true };
  });
  pi.on("agent_settled", async (_event: unknown, ctx: any) => {
    if (pendingManual && persisted && boundaryFailure === null) {
      cancelPreparation();
      state = clone(persisted);
      pendingManual = false;
    }
    try {
      const snapshot = authoritativeSnapshotFor(ctx);
      startPreparation(snapshot, latestRatio, ctx);
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
    if (shuttingDown) throw new Error("Active-context runtime is shut down");
    if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
    const executionArgumentsSha256 = sha256Value(params);
    const action = String(params.action ?? "");
    if (!allowedToolActionSet.has(action)) {
      throw new Error(`${toolName} action '${action}' is not enabled in this runtime`);
    }
    if (action === "status" && !latestSnapshot) {
      return toolPayload({
        version: 1,
        service: "active-context-folding",
        available: false,
        contextEventError: latestSnapshotError ?? "No current same-session Pi context event has been observed",
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
          state,
          boundedInteger(params.offset, 0, 0, 1_000_000, "offset"),
          boundedInteger(params.limit, 40, 1, 100, "limit"),
          snapshot.policy.maxFoldSourceRefs,
        ),
        available: true,
        automatic: {
          pressureRatio: latestRatio,
          milestones: Object.fromEntries(schedule.rungs.map((rung) => [
            rung.milestone,
            { threshold: rung.threshold, budget: rung.budget },
          ])),
          armedMilestone,
          advisory: advisoryState(state),
          historicalGuidanceEntries,
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
          providerMeasurement: lastProviderMeasurement ? {
            tokens: lastProviderMeasurement.tokens,
            contextWindow: lastProviderMeasurement.contextWindow,
            messageSha256: lastProviderMeasurement.messageSha256,
            provider: lastProviderMeasurement.provider,
            model: lastProviderMeasurement.model,
          } : null,
          measurementFresh: Boolean(lastProviderMeasurement &&
            durableProviderMeasurementMatches(lastProviderMeasurement)),
          preparing: Boolean(preparing),
          preparedFoldId: state.prepared?.id ?? null,
          preparedSourceCount: state.prepared?.sourceRefs.length ?? null,
          pendingContextNote,
          lastCandidateId: lastPreparationCandidateId,
          lastPreparationError,
          boundaryFailure,
          lastSelectionKind,
          lastSelectionSourceIds,
          lastAutomaticAction,
          automaticSuspended: automaticFailure !== null,
          automaticFailure: automaticFailure ? clone(automaticFailure) : null,
          lastCompactionDecision: lastThresholdDecision,
          nativeSummaries: "disabled",
          freeHarvest: blockingTools.size === 0 ? "disabled" : "enabled",
          pressureSource: "last-successful-provider-response-only",
          postOverflowCallback: "blocked-while-stock-native-compaction-is-disabled",
          sameOperationRetry: false,
        },
        ...(detail === "fold_candidates" ? {
          candidates: foldCandidatesDetail(snapshot, state, latestRatio, {
            summarizerAvailable: Boolean(options.summarizeContextSpan),
            generation,
            measurementFresh: Boolean(lastProviderMeasurement &&
              durableProviderMeasurementMatches(lastProviderMeasurement)),
            automaticFailure: automaticFailure !== null,
            preparing: Boolean(preparing),
            failedPreparationIds: failedPreparations,
          }),
        } : {}),
      });
    }
    if (action === "expand" || action === "refold") {
      const id = String(params.id ?? "").trim();
      if (!id) throw new Error(`${action} requires id`);
      requireActiveFold(snapshot, state, id);
      let next = setFoldProjectionState(state, id, action === "expand" ? "expanded" : "folded");
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
      await persistManual(protectEvidence(snapshot, state, ids, action === "protect"), action, ctx);
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
      const candidate = manualFoldCandidate(snapshot, state, ids);
      const supplied = typeof params.brief === "string" && params.brief.trim() ? params.brief : undefined;
      const { preparedFold, nextState } = await prepareAndCommitExplicit({
        snapshot,
        candidate,
        brief: supplied,
        ctx,
        signal,
      });
      armedMilestone = null;
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
        durableRevision: state.revision,
        activation: "durable immediately; projected on the next model call in this same turn",
        expand: { action: "expand", id: preparedFold.id },
      });
    }
    throw new Error(`Unknown ${toolName} action '${action}'`);
  };
  const fullToolSurface = allowedToolActions.length === ACTIVE_CONTEXT_TOOL_ACTIONS.length;
  pi.registerTool({
    name: toolName,
    label: "Quorum Active Context",
    description: fullToolSurface
      ? "Page, fold, expand, refold, or protect exact Pi active-context evidence. Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard 1200-character maximum."
      : `Use only the configured active-context actions: ${allowedToolActions.join(", ")}. Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard 1200-character maximum.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: allowedToolActions },
        ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
        id: { type: "string", minLength: 1 },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: ACTIVE_CONTEXT_POLICY.maxBriefChars,
          description: "Factual fold brief; keep it at most 1000 characters to stay below the hard 1200-character limit.",
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: ["fold_candidates"] },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const operation = actionQueue.then(() => executeAction(params, signal, ctx));
      actionQueue = operation.catch(() => undefined);
      return operation;
    },
  });

  pi.registerCommand(commandNames.status, {
    description: "Show active-context fold roots and paging state",
    handler: async (_args: string, ctx: any) => {
      if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
      try {
        const snapshot = authoritativeSnapshotFor(ctx);
        const status = activeContextStatus(snapshot, state, 0, 40);
        safeNotify(
          ctx,
          `Active context: ${status.totalFolds} fold(s), roots ${(status.roots as string[]).join(", ") || "none"}. ` +
            `Use ${toolName} status for exact recursive actions.`,
          "info",
        );
      } catch (error) {
        safeNotify(ctx, `Active-context status unavailable; native Pi context is unchanged: ${String(error)}`, "warning");
      }
    },
  });

  pi.registerCommand(commandNames.fold, {
    description: "Losslessly fold a stale context span; works without a main-model request",
    handler: async (args: string, ctx: any) => {
      const operation = actionQueue.then(async () => {
        if (!state) state = emptyActiveContextState(ctx.sessionManager.getSessionId());
        const snapshot = latestSnapshot
          ? authoritativeSnapshotFor(ctx)
          : snapshotForEvent(ctx, ctx.sessionManager.buildSessionContext().messages);
        if (!latestSnapshot) latestSnapshot = snapshot;
        const divider = args.indexOf(" -- ");
        const selector = (divider >= 0 ? args.slice(0, divider) : args).trim();
        const supplied = (divider >= 0 ? args.slice(divider + 4) : "").trim() || undefined;
        const ids = selector ? selector.replace(/\.\./g, " ").split(/[\s,]+/).filter(Boolean) : [];
        const candidate = ids.length
          ? manualFoldCandidate(snapshot, state!, ids)
          : selectAutomaticChapter(snapshot, state!) ?? selectAutomaticToolBatch(snapshot, state!, 1)[0] ?? null;
        if (!candidate) throw new Error("No exact stale rescue span is currently eligible");
        const stateBefore = state!;
        const persistedBefore = persisted ? clone(persisted) : null;
        const generationBefore = generation;
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
        state = clearArmedAdvisory(nextState);
        armedMilestone = null;
        try { await persist(ctx); }
        catch (error) {
          if (sessionIdentityStillValid(ctx, stateBefore.sessionId, generationBefore)) {
            state = stateBefore;
            persisted = persistedBefore;
          }
          throw error;
        }
        pendingManual = false;
        automaticFailure = null;
        armedMilestone = null;
        pendingContextNote =
          `User rescue folded stale context under ${preparedFold.id}; exact source remains expandable.`;
        lastAutomaticAction = {
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
      actionQueue = operation.catch(() => undefined);
      try { await operation; }
      catch (error) {
        safeNotify(ctx, `Context rescue failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
  pi.on("session_shutdown", (_event: unknown, ctx: any) => {
    generation += 1;
    shuttingDown = true;
    cancelPreparation();
    state = null;
    persisted = null;
    latestSnapshot = null;
    armedMilestone = null;
    try { ctx.ui?.setStatus?.(entryTypePrefix, undefined); } catch { /* Shutdown cannot be blocked by UI. */ }
  });

  return { projectionCandidates };
}
