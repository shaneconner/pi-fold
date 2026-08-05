import type { EvidenceRef } from "../json.ts";
import {
  denseOwnArrayValues,
  evidenceRef,
  evidenceSha256,
  objectRefKey,
  sha256Text,
  sha256Value,
  stableStringify,
} from "../json.ts";
import {
  bytes,
  clone,
  messageRole,
  ownValue,
  sessionEntryMessages,
  usefulBrief,
} from "./canonical.ts";
import {
  branchSha256,
  exactMapped,
  explicitProtectedKeys,
  foldInterval,
  hardFenceRatio,
  orderedRoots,
  refsInOrder,
  refsProtected,
  toolFoldCadence,
  toolRefsProtected,
  visibleCollapsedRoots,
} from "./measurement.ts";
import {
  childFoldIds,
  clearPrepared,
  flattenFoldRefs,
  foldIdFor,
  foldMap,
  normalizedPart,
  protectionSha256,
  topologySha256,
  validateFoldForest,
} from "./persistence.ts";
import {
  activeContextBrand,
  activeContextSource,
  CONSOLIDATION_WIDTH_THRESHOLD,
  EXPAND_LEASE_GENERATIONS,
  MAX_EXPAND_LEASES,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveFold,
  BriefProvenance,
  FoldCandidate,
  FoldKind,
  FoldPart,
  MappedMessage,
  PreparedFold,
} from "./policy.ts";
import {
  automaticToolBrief,
  candidateSourceRefs,
  chapterUnits,
  deterministicChapterCandidateBrief,
  partsForRange,
  resultCall,
  selectAutomaticConsolidation,
  selectAutomaticRefold,
  selectAutomaticToolForRung,
} from "./selection.ts";

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
    if (best) return best;
  }
  return null;
}

export type AutomaticRungSelection =
  | { kind: "prepared-chapter"; candidate: FoldCandidate }
  | { kind: "tool"; candidate: FoldCandidate }
  | { kind: "refold"; foldId: string }
  | { kind: "consolidation"; candidate: FoldCandidate }
  | { kind: "chapter"; candidate: FoldCandidate }
  | { kind: "chapter-prepare"; candidate: FoldCandidate };

export interface AutomaticRungSelectionOptions {
  waiveToolCadence?: boolean;
  toolOnly?: boolean;
  summarizerAvailable?: boolean;
  failedPreparationIds?: ReadonlySet<string>;
}

export function automaticPreparationId(candidate: FoldCandidate, state: ActiveContextState): string {
  return sha256Value({
    kind: candidate.kind,
    refs: candidate.sourceRefs,
    topology: topologySha256(state),
    protection: protectionSha256(state),
  });
}

export function selectAutomaticRung(
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

export function encodedRefs(snapshot: ActiveContextSnapshot, refs: EvidenceRef[]): string {
  return stableStringify(refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    return { ref, message: item.message };
  }));
}

export function encodedFoldSource(
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

export function boundedOrientation(
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

export function renderFoldParts(
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

export function stateWithNestedFold(state: ActiveContextState, fold: ActiveFold): ActiveContextState {
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

export function preparedPartsStillExact(prepared: PreparedFold, state: ActiveContextState): boolean {
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

export function preparedMatchesCandidate(prepared: PreparedFold, candidate: FoldCandidate | null): boolean {
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

export function descendantIds(state: ActiveContextState, id: string): Set<string> {
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

export function withExpandLease(state: ActiveContextState, id: string): ActiveContextState {
  const leases = { ...state.leases, [id]: EXPAND_LEASE_GENERATIONS };
  const entries = Object.entries(leases);
  if (entries.length > MAX_EXPAND_LEASES) {
    entries.sort(([leftId, left], [rightId, right]) => left - right || leftId.localeCompare(rightId));
    delete leases[entries[0][0]];
  }
  return { ...state, leases };
}

export function requireActiveFold(
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

export function siblingIds(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string[] {
  if (fold.parentId) {
    const parent = state.folds.find((item) => item.id === fold.parentId);
    return parent ? childFoldIds(parent) : [];
  }
  return orderedRoots(state, snapshot).map((item) => item.fold.id);
}

export function foldNavigation(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): {
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

export function foldPlaceholder(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): string {
  const navigation = foldNavigation(fold, state, snapshot);
  const parent = fold.parentId ?? "root";
  return [
    `[${activeContextBrand(snapshot.brandNoun)} fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=${parent}; children=${childFoldIds(fold).length}; ` +
      `previous=${navigation.previous ?? "none"}; next=${navigation.next ?? "none"}.`,
    `Expand exactly: ${snapshot.toolName} {"action":"expand","id":"${fold.id}"}`,
    `List/page exactly: ${snapshot.toolName} {"action":"status"}`,
  ].join("\n");
}

export function renderFold(
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
      details: { source: activeContextSource(snapshot.entryTypePrefix), foldId: fold.id },
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

export interface ToolLinkageCount {
  calls: number;
  results: number;
}

export function toolLinkageCounts(messages: unknown[]): Map<string, ToolLinkageCount> {
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

export function assertProjectionPreservesToolLinkage(source: unknown[], projected: unknown[]): void {
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

export function foldStatusRow(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): Record<string, unknown> {
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

export function visibleCollapsedFolds(
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
