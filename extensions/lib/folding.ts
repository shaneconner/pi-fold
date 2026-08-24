import type { EvidenceRef } from "../json.ts";
import {
  denseOwnArrayValues,
  evidenceRef,
  evidenceSha256,
  isPlainRecord,
  objectRefKey,
  sha256Text,
  sha256Value,
  stableStringify,
} from "../json.ts";
import {
  contentText,
  boundedUtf8,
  bytes,
  clone,
  messageRole,
  ownValue,
  sessionEntryMessages,
  usefulBrief,
  utf8Slice,
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
} from "./measurement.ts";
import {
  childFoldIds,
  clearPrepared,
  flattenFoldRefs,
  foldBrief,
  foldIdFor,
  foldMap,
  MAX_ACTIVE_PROTECTED,
  normalizedPart,
  protectionSha256,
  topologySha256,
  validateFoldForest,
} from "./persistence.ts";
import {
  ACTIVE_CONTEXT_POLICY,
  activeContextBrand,
  activeContextSource,
  CONTEXT_STATUS_RESPONSE_BYTES,
  EXPAND_LEASE_GENERATIONS,
  MAX_EXPAND_LEASES,
  MAX_FOLD_SPAN_CHARS,
  PEEK_DEFAULT_MAX_BYTES,
  PEEK_HEAD_SHARE,
  STATUS_DIET_INDEX_ROWS,
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
  unpinnedStaleFolds,
  deterministicChapterCandidateBrief,
  toolClipHead,
  deterministicConsolidationBrief,
  oneLine,
  NO_FOLD_KINDS,
  partsForRange,
  resultCall,
  selectAutomaticConsolidations,
  selectAutomaticRefold,
  selectAutomaticToolBatch,
} from "./selection.ts";
import { staleSpanMatureEnd } from "./transcript.ts";

export function selectAutomaticChapter(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimed: ReadonlySet<string> = new Set<string>(),
): FoldCandidate | null {
  const units = chapterUnits(snapshot);
  const allowedChildren = NO_FOLD_KINDS;
  // The maturity floor: a stale span may end only where the batch lane has already had
  // its chance, so a chapter can never claim a tool batch one turn before it qualifies.
  const matureEnd = staleSpanMatureEnd(snapshot.messages);
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    const first = units[unitIndex];
    if (first.end > matureEnd) break;
    let best: FoldCandidate | null = null;
    for (let endIndex = unitIndex; endIndex < units.length; endIndex += 1) {
      const unit = units[endIndex];
      if (unit.end > matureEnd) break;
      if (endIndex > unitIndex && unit.start !== units[endIndex - 1].end) break;
      const coherentSegment = endIndex > unitIndex || first.end - first.start > 1;
      if (!coherentSegment) continue;
      const parts = partsForRange(snapshot, state, first.start, unit.end - 1, allowedChildren);
      if (!parts || parts.some((part) => part.kind === "fold" && state.expanded.includes(part.foldId))) continue;
      const refs = candidateSourceRefs(parts, state);
      if (claimed.size && refs.some((ref) => claimed.has(objectRefKey(ref)))) continue;
      if (refsProtected(refs, state, snapshot)) continue;
      const size = bytes(encodedFoldSource(snapshot, state, parts, "chapter"));
      const biteSized = size <= MAX_FOLD_SPAN_CHARS || endIndex === unitIndex;
      // ACCUMULATE UNTIL OVER, never cut to hit the number. The walk grows the span one
      // whole unit at a time and records the first one that carries it past the floor,
      // so a fold is always at least minFoldChars and always ends on a message boundary.
      if (size >= snapshot.thresholds.minFoldChars && biteSized) best = { kind: "chapter", parts, sourceRefs: refs };
      if (size > MAX_FOLD_SPAN_CHARS) break;
    }
    if (best) return best;
  }
  return null;
}

export function selectAutomaticStaleSpan(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimed: ReadonlySet<string> = new Set<string>(),
): FoldCandidate | null {
  const chapter = selectAutomaticChapter(snapshot, state, claimed);
  const folds = selectAutomaticConsolidations(snapshot, state)[0] ?? null;
  if (!chapter || !folds) return chapter ?? folds;
  const at = (candidate: FoldCandidate): number =>
    exactMapped(snapshot, candidate.sourceRefs[0])?.index ?? Number.MAX_SAFE_INTEGER;
  return at(folds) < at(chapter) ? folds : chapter;
}

export function selectAutomaticSpan(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimed: ReadonlySet<string> = new Set<string>(),
): FoldCandidate | null {
  return selectAutomaticToolBatch(snapshot, state, claimed)[0] ??
    selectAutomaticStaleSpan(snapshot, state, claimed);
}

export type AutomaticRungSelection =
  | { kind: "prepared-chapter"; candidate: FoldCandidate }
  | { kind: "tool"; candidate: FoldCandidate }
  | { kind: "refold"; foldId: string }
  | { kind: "consolidation"; candidate: FoldCandidate }
  | { kind: "chapter"; candidate: FoldCandidate }
  | { kind: "chapter-prepare"; candidate: FoldCandidate };

export interface AutomaticRungSelectionOptions {
  toolOnly?: boolean;
  claimed?: ReadonlySet<string>;
  claimedFoldIds?: ReadonlySet<string>;
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
  const claimed = options.claimed ?? new Set<string>();
  const claimedFoldIds = options.claimedFoldIds ?? new Set<string>();
  if (!options.toolOnly && state.prepared) {
    if (!Number.isFinite(ratio) || ratio < hardFenceRatio(snapshot)) return null;
    const candidate = selectAutomaticChapter(snapshot, state, claimed);
    return candidate ? { kind: "prepared-chapter", candidate } : null;
  }
  const tool = selectAutomaticToolBatch(snapshot, state, claimed)[0] ?? null;
  if (tool) return { kind: "tool", candidate: tool };
  if (options.toolOnly || !Number.isFinite(ratio)) return null;
  const refold = selectAutomaticRefold(snapshot, state, claimedFoldIds);
  if (refold) return { kind: "refold", foldId: refold };
  const span = selectAutomaticStaleSpan(snapshot, state, claimed);
  if (span?.kind === "consolidation") return { kind: "consolidation", candidate: span };
  const chapter = span;
  if (!chapter) return null;
  if (ratio >= hardFenceRatio(snapshot)) return { kind: "chapter", candidate: chapter };
  if (ratio >= snapshot.policy.prepareRatio) return { kind: "chapter-prepare", candidate: chapter };
  return null;
}

export function foldCandidatesDetail(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ratio: number | null,
  options: {
    generation?: number;
    measurementFresh?: boolean;
    automaticFailure?: boolean;
    preparing?: boolean;
  } = {},
): Record<string, unknown> {
  const measuredRatio = ratio !== null && Number.isFinite(ratio) ? ratio : Number.NaN;
  const tool = selectAutomaticToolBatch(snapshot, state)[0] ?? null;
  const refold = selectAutomaticRefold(snapshot, state);
  const staleSpan = selectAutomaticStaleSpan(snapshot, state);
  const consolidation = staleSpan?.kind === "consolidation" ? staleSpan : null;
  const chapter = staleSpan?.kind === "chapter" ? staleSpan : null;
  const selection = selectAutomaticRung(snapshot, state, measuredRatio);
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
    zones: {
      freshBoundary: snapshot.freshBoundary,
      budgetTokens: snapshot.budgetTokens,
    },
    width: {
      visibleRoots: unpinnedStaleFolds(snapshot, state).length,
      threshold: snapshot.thresholds.consolidateAfter,
      groupsDue: selectAutomaticConsolidations(snapshot, state).length,
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

export function consolidationSourceText(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  parts: FoldPart[],
): string {
  const byId = foldMap(state);
  const entries = parts.map((part, index) => {
    if (part.kind === "raw") {
      const item = exactMapped(snapshot, part.ref);
      if (!item) throw new Error(`Exact Pi evidence drift for ${part.ref.entryId}`);
      return { index, foldId: null, kind: "raw" as const, brief: null, messages: [clone(item.message)] };
    }
    const child = byId.get(part.foldId);
    if (!child) throw new Error(`Consolidation source lost child fold ${part.foldId}`);
    const messages = renderFoldParts(child.parts, state, snapshot);
    if (!messages) throw new Error(`Consolidation source projection drifted at ${child.id}`);
    return { index, foldId: child.id, kind: child.kind, brief: foldBrief(child, state), messages };
  });
  const collapsed = new Set<number>();
  const render = (): string => stableStringify(entries.map((entry) => ({
    child: entry.index + 1,
    of: entries.length,
    ...(entry.foldId === null ? {} : { foldId: entry.foldId }),
    kind: entry.kind,
    ...(entry.brief === null ? {} : { brief: entry.brief }),
    ...(collapsed.has(entry.index)
      ? { collapsed: "brief only: this child did not fit expanded" }
      : { contents: entry.messages }),
  })));
  const bySize = entries
    .filter((entry) => entry.foldId !== null)
    .map((entry) => ({ index: entry.index, size: bytes(entry.messages) }))
    .sort((a, b) => b.size - a.size || a.index - b.index);
  let text = render();
  for (const entry of bySize) {
    if (bytes(text) <= snapshot.policy.maxSourceChars) break;
    collapsed.add(entry.index);
    text = render();
  }
  return text;
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

export function briefContractComplaint(
  brief: string,
  maxBriefChars: number,
  toolName: string,
): string | null {
  if (!brief) return "You returned no brief text. Reply with the brief itself and nothing else.";
  if (brief.length > maxBriefChars) {
    return `Your brief was ${brief.length} characters and the limit is ${maxBriefChars}. ` +
      "Rewrite it within the limit. Cut detail, not subjects: every subject you named must " +
      "still be named in the shorter brief.";
  }
  if (!usefulBrief(brief, maxBriefChars, toolName)) {
    return "Your brief carried no factual content once fold navigation lines were dropped. " +
      "Name concrete things from the span: files, identifiers, decisions, results, errors.";
  }
  return null;
}

export async function prepareFold(input: {
  candidate: FoldCandidate;
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  brief?: string;
  briefProvenance?: "supplied" | "deterministic" | BriefProvenance;
  ctx?: unknown;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<PreparedFold> {
  const { candidate, snapshot, state } = input;
  const protectedSource = refsProtected(candidate.sourceRefs, state, snapshot);
  if (!candidate.sourceRefs.length ||
      refsInOrder(snapshot, candidate.sourceRefs) === null || protectedSource) {
    throw new Error("Fold source is not exact, stale, and unprotected");
  }
  const sourceText = encodedFoldSource(snapshot, state, candidate.parts, candidate.kind);
  const orientation = boundedOrientation(snapshot, candidate.sourceRefs);
  const sourceSha256 = sha256Text(sourceText);
  const beforeSha256 = sha256Text(orientation.beforeText);
  const afterSha256 = sha256Text(orientation.afterText);

  let brief: string;
  let provenance: BriefProvenance;
  if (input.brief !== undefined) {
    const declaredKind = typeof input.briefProvenance === "object"
      ? input.briefProvenance.kind
      : input.briefProvenance ?? "supplied";
    if (declaredKind === "supplied") {
      // A SUPPLIED BRIEF AUGMENTS THE HEAD, NEVER REPLACES IT (rep 7 of
      // sol-20260823-live: replacement deleted the fact-carrying identification and 74
      // of 95 peeks recovered values the run's own briefs dropped). The agent's clause
      // is judged against its own reserve so the refusal names the budget the agent
      // actually has, and the deterministic head keeps the remainder of the one policy
      // cap. Only the agent's OWN words take this path: a deterministic brief arriving
      // through the same door IS the head, and a re-prepared augmented brief is already
      // composed, so each passes through under the whole-brief cap instead.
      const complaint = briefContractComplaint(
        input.brief.trim(), snapshot.policy.agentBriefReserve, snapshot.toolName);
      if (complaint !== null) throw new Error(`Supplied brief rejected. ${complaint}`);
      const clause = input.brief.trim();
      const head = candidate.kind === "consolidation"
        ? deterministicConsolidationBrief(candidate, state, snapshot.toolName, snapshot)
        : deterministicChapterCandidateBrief(snapshot, candidate);
      if (head) {
        const seam = " · Agent: ";
        const headRoom = Math.max(0, snapshot.policy.maxBriefChars - seam.length - clause.length);
        brief = `${oneLine(head, headRoom)}${seam}${clause}`;
        provenance = { kind: "augmented" };
      } else {
        brief = clause;
        provenance = { kind: "supplied" };
      }
    } else {
      const complaint = briefContractComplaint(
        input.brief.trim(), snapshot.policy.maxBriefChars, snapshot.toolName);
      if (complaint !== null) throw new Error(`Supplied brief rejected. ${complaint}`);
      brief = input.brief.trim();
      provenance = typeof input.briefProvenance === "object"
        ? clone(input.briefProvenance)
        : { kind: declaredKind } as BriefProvenance;
    }
  } else {
    brief = candidate.kind === "consolidation"
      ? deterministicConsolidationBrief(candidate, state, snapshot.toolName, snapshot)
      : deterministicChapterCandidateBrief(snapshot, candidate);
    provenance = { kind: "deterministic" };
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
  // One protected set now: an entry is unfoldable because its turn has not completed or
  // because it carries no evidence ref, and both are validity, not recency. The branch on
  // fold kind went with fresh-tail protection: it read `toolRefsProtected` on one side,
  // and once that collapsed onto `refsProtected` both arms were the same call.
  if (indices.some((index) => snapshot.protectedIndices.has(index))) return "protection drift";
  if (refsProtected(prepared.sourceRefs, state, snapshot)) return "source became protected";
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
  const descendants = new Set<string>();
  const visit = (foldId: string): void => {
    for (const child of childFoldIds(byId.get(foldId)!)) {
      descendants.add(child);
      visit(child);
    }
  };
  if (byId.has(id)) visit(id);
  return descendants;
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
  if (byKey.size > MAX_ACTIVE_PROTECTED) {
    throw new Error(
      `Protecting ${ids.join(", ")} would hold ${byKey.size} refs, over the ${MAX_ACTIVE_PROTECTED}-ref cap; ` +
        "unpin something first",
    );
  }
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
    foldBrief(fold, state),
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
  const mustReveal = state.expanded.includes(fold.id) || (refsProtected(refs, state, snapshot));
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
  return renderFoldParts(fold.parts, state, snapshot);
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
  const sourceLinkage = toolLinkageCounts(source);
  const projectedLinkage = toolLinkageCounts(projected);
  const ids = new Set([...sourceLinkage.keys(), ...projectedLinkage.keys()]);
  for (const id of ids) {
    const original = sourceLinkage.get(id) ?? { calls: 0, results: 0 };
    const visible = projectedLinkage.get(id) ?? { calls: 0, results: 0 };
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

export function pinnedPeekMass(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): { bytes: number; results: number } {
  const explicitProtected = explicitProtectedKeys(state);
  const folded = new Set<string>();
  for (const fold of state.folds) {
    for (const ref of flattenFoldRefs(fold, state)) folded.add(objectRefKey(ref));
  }
  const peekCalls = new Map<string, string>();
  for (const message of snapshot.messages) {
    if (messageRole(message) !== "assistant") continue;
    for (const part of denseOwnArrayValues(ownValue(message, "content")) ?? []) {
      if (ownValue(part, "type") !== "toolCall" || ownValue(part, "name") !== snapshot.toolName) continue;
      const callId = ownValue(part, "id");
      const args = ownValue(part, "arguments");
      const foldId = ownValue(args, "id");
      if (typeof callId !== "string" || !callId || ownValue(args, "action") !== "peek" ||
          typeof foldId !== "string" || !foldId) continue;
      peekCalls.set(callId, foldId);
    }
  }
  let total = 0;
  let results = 0;
  for (const item of snapshot.mapped) {
    if (messageRole(item.message) !== "toolResult" || !item.ref) continue;
    if (folded.has(objectRefKey(item.ref))) continue;
    const toolCallId = ownValue(item.message, "toolCallId");
    const foldId = typeof toolCallId === "string" ? peekCalls.get(toolCallId) : undefined;
    if (!foldId) continue;
    if (!explicitProtected.has(objectRefKey(item.ref))) continue;
    total += bytes(item.message);
    results += 1;
  }
  return { bytes: total, results };
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
  applyToolClips(output, state, snapshot);
  assertProjectionPreservesToolLinkage(snapshot.messages, output);
  return output;
}

// THE TOOL-CALL DIET'S VIEW (2026-08-24). A clipped result renders in place as its
// identified head with the cut stated and the recovery named, matched BY CALL ID and
// identity-preserving on role, call id, tool name, error flag and timestamp, exactly
// the ephemeral-peek withdrawal's shape one mechanism over. Clips are only ever ADDED
// inside a commit transaction, and a commit already rewrites the projection, so a
// non-commit pass with unchanged clips renders byte-identically and the frozen prefix
// never moves. Every reader shares this pass because every reader shares
// projectActiveContext: the live projection, the persistence readers and the
// attribution lens all see the same clipped view, and the full bytes stay in the
// transcript behind the entry id the marker names.
function applyToolClips(
  output: unknown[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): void {
  if (!state.clips?.length) return;
  const byCallId = new Map(state.clips.map((clip) => [clip.callId, clip]));
  for (let index = 0; index < output.length; index += 1) {
    const message = output[index] as Record<string, unknown> | null;
    if (!message || (message as { role?: unknown }).role !== "toolResult") continue;
    const callId = (message as { toolCallId?: unknown }).toolCallId;
    if (typeof callId !== "string") continue;
    const clip = byCallId.get(callId);
    if (!clip) continue;
    const details = (message as { details?: unknown }).details;
    if (details && typeof (details as { projection?: unknown }).projection === "string") continue;
    const full = contentText(message);
    if (full.length <= snapshot.policy.toolClipFloorChars) continue;
    const head = toolClipHead(full, snapshot.policy.toolClipHeadChars);
    const hidden = full.length - head.length;
    if (hidden <= 0) continue;
    output[index] = {
      role: "toolResult",
      toolCallId: callId,
      toolName: (message as { toolName?: unknown }).toolName,
      content: [{ type: "text", text: `${head}\n... [${hidden} more chars clipped; ` +
        `{"action":"peek","id":"${clip.entryId}"} returns the full result]` }],
      isError: (message as { isError?: unknown }).isError ?? false,
      details: { projection: "tool-clip" },
      timestamp: (message as { timestamp?: unknown }).timestamp,
    };
  }
}

export function foldStatusRow(fold: ActiveFold, state: ActiveContextState, snapshot: ActiveContextSnapshot): Record<string, unknown> {
  const navigation = foldNavigation(fold, state, snapshot);
  const interval = foldInterval(fold, state, snapshot);
  const refs = flattenFoldRefs(fold, state);
  const allSourceIds = refs.map((ref) => ref.entryId);
  const sourceIds = allSourceIds.slice(0, 64);
  const blocked = refsProtected(refs, state, snapshot);
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
    brief: foldBrief(fold, state),
    sourceChars: fold.sourceChars,
    actions: {
      primary: projection === "folded"
        ? { action: "expand", id: fold.id }
        : { action: "refold", id: fold.id },
      expand: { action: "expand", id: fold.id },
      refold: { action: "refold", id: fold.id },
      pin: { action: "pin", ids: [fold.id] },
    },
  };
}

export function orderedFoldTree(state: ActiveContextState, snapshot: ActiveContextSnapshot): ActiveFold[] {
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
  for (const root of orderedRoots(state, snapshot)) visit(root.fold.id);
  return ordered;
}

export function foldDepth(state: ActiveContextState, fold: ActiveFold): number {
  const byId = foldMap(state);
  let depth = 0;
  for (let parentId = fold.parentId; parentId; parentId = byId.get(parentId)?.parentId ?? null) depth += 1;
  return depth;
}

export function foldTreeDetail(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): Array<Record<string, unknown>> {
  return orderedFoldTree(state, snapshot).map((fold) => ({
    id: fold.id,
    kind: fold.kind,
    depth: foldDepth(state, fold),
    parentId: fold.parentId,
    brief: foldBrief(fold, state),
    sourceCount: flattenFoldRefs(fold, state).length,
    state: state.expanded.includes(fold.id) ? "expanded" : "folded",
    peekable: true,
  }));
}

export function foldIndexRow(
  fold: ActiveFold,
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): Record<string, unknown> {
  const refs = flattenFoldRefs(fold, state);
  const interval = foldInterval(fold, state, snapshot);
  const replacement = renderFold(fold, state, snapshot);
  const source = renderFold(fold, { ...state, expanded: [...state.expanded, fold.id] }, snapshot);
  const reclaimableBytes = replacement && source ? Math.max(0, bytes(source) - bytes(replacement)) : 0;
  return {
    id: fold.id,
    kind: fold.kind,
    depth: foldDepth(state, fold),
    state: state.expanded.includes(fold.id) ? "expanded" : "folded",
    startId: refs[0]?.entryId ?? null,
    endId: refs.at(-1)?.entryId ?? null,
    startPosition: interval?.start ?? null,
    endPosition: interval?.end ?? null,
    sourceCount: refs.length,
    sourceBytes: fold.sourceChars,
    reclaimableBytes,
    brief: foldBrief(fold, state),
    peek: { action: "peek", id: fold.id },
    expand: { action: "expand", id: fold.id },
  };
}

export function foldSourceMap(
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
  limit = 512,
): { entries: Array<[string, string]>; total: number; truncated: boolean } {
  const entries: Array<[string, string]> = [];
  for (const fold of orderedFoldTree(state, snapshot)) {
    for (const ref of flattenFoldRefs(fold, state)) entries.push([ref.entryId, fold.id]);
  }
  const byEntry = new Map(entries);
  const all = [...byEntry.entries()];
  return { entries: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

export function activeContextStatus(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  offset = 0,
  limit = 40,
  statusOptions: { diet?: boolean; indexRows?: number } = {},
): Record<string, unknown> {
  const roots = orderedRoots(state, snapshot).map((item) => item.fold.id);
  const ordered = orderedFoldTree(state, snapshot);
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
      !snapshot.protectedIndices.has(item.index) && !protectedKeys.has(objectRefKey(item.ref)) &&
      resultCall(snapshot, item.index, true) !== null,
  }] : []);
  const selectedObjects = objects.slice(offset, offset + limit);
  const eligibleChapter = selectAutomaticChapter(snapshot, state);
  const eligibleSourceIds = eligibleChapter?.sourceRefs.map((ref) => ref.entryId) ?? [];
  const eligibleEndpoints = eligibleSourceIds.length
    ? [...new Set([eligibleSourceIds[0], eligibleSourceIds.at(-1)!])]
    : [];
  const index = statusOptions.diet
    ? visibleCollapsedFolds(state, snapshot)
      .map((fold) => foldIndexRow(fold, state, snapshot))
      .sort((left, right) =>
        Number(right.reclaimableBytes) - Number(left.reclaimableBytes) ||
        String(left.id).localeCompare(String(right.id)))
      .slice(0, statusOptions.indexRows ?? STATUS_DIET_INDEX_ROWS)
    : null;
  const sourceMap = statusOptions.diet ? foldSourceMap(state, snapshot) : null;
  return {
    version: 1,
    service: "active-context-folding",
    roots,
    ...(statusOptions.diet
      ? {
        index: "diet",
        topFolds: index,
        sourceMap: sourceMap!.entries,
        sourceMapTotal: sourceMap!.total,
        sourceMapTruncated: sourceMap!.truncated,
        paging: {
          note: "Results are delivered in bounded pages.",
          folds: { action: "status", detail: "folds", offset: 0, limit: 40 },
          objects: { action: "status", detail: "objects", offset: 0, limit: 40 },
          tree: { action: "status", detail: "tree", offset: 0 },
        },
      }
      : {
        folds: selected.map((fold) => foldStatusRow(fold, state, snapshot)),
        objects: selectedObjects,
        nextObjectOffset: offset + selectedObjects.length < objects.length
          ? offset + selectedObjects.length
          : null,
      }),
    offset,
    nextOffset: offset + selected.length < ordered.length ? offset + selected.length : null,
    totalFolds: ordered.length,
    protectedSourceIds: state.protected.flatMap((ref) => exactMapped(snapshot, ref) ? [ref.entryId] : []),
    totalObjects: objects.length,
    eligibleChapter: eligibleChapter ? {
      kind: "chapter",
      sourceCount: eligibleSourceIds.length,
      sourceIds: eligibleSourceIds.slice(0, 64),
      sourceIdsTruncated: eligibleSourceIds.length > 64,
      startId: eligibleSourceIds[0],
      endId: eligibleSourceIds.at(-1),
      action: { action: "fold", ids: eligibleEndpoints, brief: "<factual brief, at most 1000 characters>" },
    } : null,
    currentTurnRequiresBoundary: false,
    actions: {
      status: { action: "status", offset, limit },
      fold: { action: "fold", ids: ["<source-or-fold-id>"], brief: "<optional factual brief, at most 1000 characters>" },
      pin: { action: "pin", ids: ["<source-or-fold-id>"] },
    },
  };
}

const STATUS_CONTINUATION_RESERVE_BYTES = 400;

export function boundStatusPayload(
  payload: Record<string, unknown>,
  detail: string | null,
  offset: number,
  cap: number = CONTEXT_STATUS_RESPONSE_BYTES,
): Record<string, unknown> {
  const size = (): number => Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");
  if (size() <= cap) return payload;
  const target = cap - STATUS_CONTINUATION_RESERVE_BYTES;
  const fits = (): boolean => size() <= target;
  const omitted: string[] = [];
  const shrink = (owner: unknown, key: string, label: string, keepEnd = false, minKeep = 0): number => {
    if (!isPlainRecord(owner) || fits()) return 0;
    const original = ownValue(owner, key);
    if (!Array.isArray(original) || original.length <= minKeep) return 0;
    const container = owner as Record<string, unknown>;
    const apply = (keep: number): void => {
      container[key] = keepEnd ? original.slice(original.length - keep) : original.slice(0, keep);
    };
    let low = minKeep;
    let high = original.length - 1;
    let keep = minKeep;
    while (low <= high) {
      const mid = (low + high) >> 1;
      apply(mid);
      if (fits()) { keep = mid; low = mid + 1; } else { high = mid - 1; }
    }
    apply(keep);
    const dropped = original.length - keep;
    if (dropped > 0) omitted.push(`${dropped} ${label}`);
    return dropped;
  };
  const automatic = ownValue(payload, "automatic");
  const instrumentation = isPlainRecord(automatic) ? ownValue(automatic, "instrumentation") : undefined;
  const lastAction = isPlainRecord(automatic) ? ownValue(automatic, "lastAutomaticAction") : undefined;
  const lastEpoch = isPlainRecord(lastAction) ? ownValue(lastAction, "epoch") : undefined;
  shrink(instrumentation, "projectionRecords", "projection record(s)", true);
  shrink(instrumentation, "cacheObservations", "cache observation(s)", true);
  shrink(instrumentation, "events", "context event(s)", true);
  if (shrink(payload, "sourceMap", "source map row(s)") > 0) payload.sourceMapTruncated = true;
  shrink(payload, "topFolds", "top fold row(s)");
  // The last epoch's receipt lists grow with commit depth (a deep epoch applies dozens
  // of marks). They are the commit's own receipt, so they outlast
  // every other diagnostic, but they still page away before any listing row the
  // caller actually asked for: on the detail pages, where none of the diagnostics
  // above exist, they are the mass that made one fold row miss the cap.
  const receiptRowsDropped =
    shrink(lastEpoch, "applied", "applied receipt row(s)", true) +
    shrink(lastEpoch, "absorbed", "absorbed receipt row(s)", true) > 0;
  const rowLabel = (key: string): string => key === "folds" ? "fold row(s)" : key === "objects" ? "object row(s)" : "tree row(s)";
  let continueAt: number | null = null;
  if (detail === "folds" || detail === "objects") {
    const rideKey = detail === "folds" ? "objects" : "folds";
    if (shrink(payload, rideKey, rowLabel(rideKey)) > 0) {
      const rideKept = (payload[rideKey] as unknown[]).length;
      if (rideKey === "folds") payload.nextOffset = offset + rideKept;
      else payload.nextObjectOffset = offset + rideKept;
    }
  }
  const primaryKey = detail === "objects" ? "objects" : detail === "tree" ? "tree" : detail === "folds" ? "folds" : null;
  if (primaryKey && shrink(payload, primaryKey, rowLabel(primaryKey), false, 1) > 0) {
    continueAt = offset + (payload[primaryKey] as unknown[]).length;
    if (primaryKey === "objects") payload.nextObjectOffset = continueAt;
    else payload.nextOffset = continueAt;
  }
  if (!omitted.length) return payload;
  // A dropped receipt row has no page: the epoch receipt is a record of the last
  // action, not a listing, and claiming it "stays reachable" pointed the agent at
  // a page that does not exist (2026-08-14 external review). The span-to-fold
  // mapping it summarizes stays complete in the folds and tree details, so the
  // continuation says exactly that instead.
  const pageable = continueAt === null
    ? "the fold, object and tree lists stay reachable through the paged status details"
    : `continue at ${JSON.stringify({ action: "status", detail, offset: continueAt })}`;
  const resume = receiptRowsDropped
    ? `${pageable}; the epoch receipt keeps only its newest rows and the trimmed rows have no page`
    : (continueAt === null ? "the full lists stay reachable through the paged status details" : pageable);
  payload.continuation =
    `Status pages are bounded to ${cap} bytes; omitted ${omitted.join(", ")}; ${resume}.`;
  return payload;
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
    const protectedSource = refsProtected(refs, state, snapshot);
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

export interface FoldSourceRequest {
  foldId: string;
  state: ActiveContextState;
  entries: Array<Record<string, unknown>>;
  sessionId: string;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
}

function exactSessionMessages(input: FoldSourceRequest): Map<string, unknown> {
  const projectEntry = input.projectEntry ?? sessionEntryMessages;
  const exact = new Map<string, unknown>();
  for (const entry of input.entries) {
    if (typeof entry?.id !== "string") continue;
    for (const message of projectEntry(entry)) {
      const ref = evidenceRef(input.sessionId, entry.id, message);
      exact.set(`${objectRefKey(ref)}:${ref.sha256}`, message);
    }
  }
  return exact;
}

function exactMessageFor(
  exact: Map<string, unknown>,
  ref: EvidenceRef,
  sessionId: string,
): unknown {
  if (ref.sessionId !== sessionId) throw new Error(`Fold source ${ref.entryId} belongs to another session`);
  const message = exact.get(`${objectRefKey(ref)}:${ref.sha256}`);
  if (!message || evidenceSha256(message) !== ref.sha256) {
    throw new Error(`Exact recovery failed for ${ref.entryId}`);
  }
  return clone(message);
}

export function recoverFoldMessages(input: FoldSourceRequest): unknown[] {
  const fold = input.state.folds.find((item) => item.id === input.foldId);
  if (!fold) throw new Error(`Unknown active-context fold ${input.foldId}`);
  const exact = exactSessionMessages(input);
  return flattenFoldRefs(fold, input.state).map((ref) => exactMessageFor(exact, ref, input.sessionId));
}

export function storedChildPlaceholder(child: ActiveFold, state: ActiveContextState): Record<string, unknown> {
  return {
    placeholder: "fold",
    id: child.id,
    kind: child.kind,
    brief: foldBrief(child, state),
    sourceSha256: child.sourceSha256,
    sourceBytes: child.sourceChars,
    children: childFoldIds(child).length,
    peek: { action: "peek", id: child.id },
  };
}

export function foldStoredSpan(input: FoldSourceRequest): unknown[] {
  const fold = input.state.folds.find((item) => item.id === input.foldId);
  if (!fold) throw new Error(`Unknown active-context fold ${input.foldId}`);
  const exact = exactSessionMessages(input);
  const byId = foldMap(input.state);
  return fold.parts.map((part) => {
    if (part.kind === "raw") return exactMessageFor(exact, part.ref, input.sessionId);
    const child = byId.get(part.foldId);
    if (!child) throw new Error(`Missing active-context child ${part.foldId}`);
    return storedChildPlaceholder(child, input.state);
  });
}

export function peekFoldSource(input: {
  foldId: string;
  state: ActiveContextState;
  entries: Array<Record<string, unknown>>;
  sessionId: string;
  maximumBytes?: number;
  offset?: number;
  toolName?: string;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
}): Record<string, unknown> {
  const fold = input.state.folds.find((item) => item.id === input.foldId);
  if (!fold) throw new Error(`Unknown active-context fold ${input.foldId}`);
  const messages = foldStoredSpan({
    foldId: input.foldId,
    state: input.state,
    entries: input.entries,
    sessionId: input.sessionId,
    projectEntry: input.projectEntry,
  });
  const source = stableStringify(messages);
  const sourceBytes = bytes(source);
  const offset = Math.min(Math.max(0, input.offset ?? 0), sourceBytes);
  const budget = input.maximumBytes ?? PEEK_DEFAULT_MAX_BYTES;
  const window = offset > 0 ? utf8Slice(source, offset) : source;
  const view = offset > 0
    ? { text: boundedUtf8(window, budget), omittedBytes: 0, contiguous: true }
    : boundedHeadTail(window, budget);
  const returned = view.text;
  const returnedBytes = bytes(returned) - bytes(headTailMarker(view.omittedBytes));
  const nextOffset = view.contiguous && offset + returnedBytes < sourceBytes
    ? offset + returnedBytes
    : null;
  const truncated = view.omittedBytes > 0 || nextOffset !== null;
  const children = childFoldIds(fold);
  const index = descendantIndexRows(fold, input.state);
  return {
    version: 1,
    action: "peek",
    id: fold.id,
    kind: fold.kind,
    parentId: fold.parentId,
    depth: foldDepth(input.state, fold),
    brief: foldBrief(fold, input.state),
    sourceCount: messages.length,
    sourceSha256: fold.sourceSha256,
    sourceBytes,
    offset,
    returnedBytes,
    omittedBytes: view.omittedBytes,
    nextOffset,
    truncated,
    view: offset > 0 ? "slice" : (view.omittedBytes > 0 ? "index" : "complete"),
    ...(index.length ? { index } : {}),
    children,
    narrower: {
      ...(nextOffset === null ? {} : { slice: { action: "peek", id: fold.id, offset: nextOffset, bytes: returnedBytes } }),
      ...(children.length ? { child: { action: "peek", id: children[0] } } : {}),
    },
    ...(truncated
      ? { wider: { action: "peek", id: fold.id, bytes: Math.min(sourceBytes, ACTIVE_CONTEXT_POLICY.maxSourceChars) } }
      : {}),
    lifetime: "these bytes stay in the window exactly as returned, like any other tool result, and " +
      `nothing rewrites this result in place. It is a COPY of fold ${fold.id}'s stored source, so the ` +
      `next commit reclaims it behind a placeholder naming ${fold.id}; peek ${fold.id} again for the ` +
      "same verbatim bytes, or pin this result to keep the copy raw.",
    note: truncated
      ? `Bounded read: ${returnedBytes} of ${sourceBytes} exact source bytes, ${view.omittedBytes} omitted ` +
        `from the middle. Widen with bytes, page with offset, or expand ${fold.id} to restore it in place.`
      : children.length
        ? `Complete stored span, one level: raw entries exactly, and ${children.length} child fold(s) still ` +
          "placeheld. Peek a child id to read its own span; the fold stayed collapsed and no projection changed."
        : "Complete exact source; the fold stayed collapsed and no projection changed.",
    source: returned,
    ...(truncated
      ? {
        truncationReminder: `STOP: ${view.omittedBytes || sourceBytes - returnedBytes} of ${sourceBytes} ` +
          "bytes were NOT shown" +
          (view.omittedBytes ? " (the middle; the head and tail are both above)" : " (everything after this slice)") +
          `. Widen with {"action":"peek","id":"${fold.id}","bytes":${
            Math.min(sourceBytes, ACTIVE_CONTEXT_POLICY.maxSourceChars)}}` +
          (nextOffset === null ? "" : ` or read on with {"action":"peek","id":"${fold.id}","offset":${nextOffset}}`) +
          ".",
      }
      : {}),
  };
}

export function headTailMarker(omittedBytes: number): string {
  return omittedBytes > 0 ? `\n... [${omittedBytes} exact source bytes omitted] ...\n` : "";
}

export function boundedHeadTail(
  source: string,
  budget: number,
): { text: string; omittedBytes: number; contiguous: boolean } {
  const total = bytes(source);
  if (total <= budget) return { text: source, omittedBytes: 0, contiguous: true };
  const headBudget = Math.max(1, Math.floor(budget * PEEK_HEAD_SHARE));
  const head = boundedUtf8(source, headBudget);
  const tailBudget = Math.max(1, budget - bytes(head));
  const tailStart = Math.max(bytes(head), total - tailBudget);
  const tail = boundedUtf8(utf8Slice(source, tailStart), tailBudget);
  const omittedBytes = Math.max(0, total - bytes(head) - bytes(tail));
  if (omittedBytes <= 0) return { text: source, omittedBytes: 0, contiguous: true };
  return {
    text: `${head}${headTailMarker(omittedBytes)}${tail}`,
    omittedBytes,
    contiguous: false,
  };
}

export function descendantIndexRows(
  fold: ActiveFold,
  state: ActiveContextState,
): Array<Record<string, unknown>> {
  const byId = foldMap(state);
  const rows: Array<Record<string, unknown>> = [];
  const visit = (parent: ActiveFold): void => {
    for (const childId of childFoldIds(parent)) {
      const child = byId.get(childId);
      if (!child) continue;
      rows.push({
        id: child.id,
        kind: child.kind,
        depth: foldDepth(state, child),
        brief: foldBrief(child, state),
        peek: { action: "peek", id: child.id },
      });
      visit(child);
    }
  };
  visit(fold);
  return rows;
}
