import { objectRefKey } from "../json.ts";
import type { EvidenceRef } from "../json.ts";
import {
  bytes,
  clone,
  messageRole,
} from "./canonical.ts";
import {
  commitPreparedFold,
  pinnedPeekMass,
  preparedMatchesCandidate,
  prepareFold,
  renderFold,
  renderFoldParts,
  selectAutomaticSpan,
  setFoldProjectionState,
} from "./folding.ts";
import type { AutomaticRungSelection } from "./folding.ts";
import {
  foldInterval,
  budgetOccupancy,
  hardFenceRatio,
  mappedByKey,
  orderedRoots,
  refsProtected,
  toolRefsProtected,
} from "./measurement.ts";
import {
  childFoldIds,
  clearPrepared,
  flattenFoldRefs,
  foldIdFor,
  parsePendingMarks,
  pendingMarkKey,
} from "./persistence.ts";
import { currentTurnRefKeys } from "./transcript.ts";
import {
  ESTIMATED_BYTES_PER_TOKEN,
  MAX_WEDGE_ABSORB_TOKENS,
  ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES,
  MAX_PENDING_MARKS,
  MAX_UNMARKED_CANDIDATES,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  FoldCandidate,
  FoldPart,
  MarkOrigin,
  PendingFoldMark,
  PendingMark,
} from "./policy.ts";
import {
  automaticToolBatches,
  automaticToolBrief,
  candidateSourceRefs,
  chapterRangeIsUnitAligned,
  partsForRange,
  peekedSourceFoldIds,
  selectAutomaticConsolidations,
  spanBytes,
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  resultCall,
} from "./selection.ts";

const NO_PENDING_MARKS: readonly PendingMark[] = Object.freeze([]);

export function pendingMarks(state: Pick<ActiveContextState, "pendingMarks">): readonly PendingMark[] {
  return state.pendingMarks ?? NO_PENDING_MARKS;
}

export function withPendingMarks(
  state: ActiveContextState,
  marks: readonly PendingMark[],
): ActiveContextState {
  const next = marks.length ? parsePendingMarks(clone(marks) as PendingMark[]) : [];
  const head = { ...state };
  delete head.surfacing;
  delete head.pendingMarks;
  delete head.advisory;
  delete head.prepared;
  return {
    ...head,
    ...(state.surfacing?.length ? { surfacing: clone(state.surfacing) } : {}),
    ...(next.length ? { pendingMarks: next } : {}),
    ...(state.advisory ? { advisory: clone(state.advisory) } : {}),
    ...(state.prepared ? { prepared: clone(state.prepared) } : {}),
  };
}

export interface MarkAddition {
  state: ActiveContextState;
  added: boolean;
  reason: string | null;
}

export function addPendingMark(state: ActiveContextState, mark: PendingMark): MarkAddition {
  const marks = pendingMarks(state);
  if (marks.some((existing) => pendingMarkKey(existing) === pendingMarkKey(mark))) {
    return { state, added: false, reason: `${mark.mark} mark ${mark.id} is already pending` };
  }
  if (marks.length >= MAX_PENDING_MARKS) {
    return {
      state,
      added: false,
      reason: `at most ${MAX_PENDING_MARKS} marks may be pending; commit the epoch first`,
    };
  }
  return { state: withPendingMarks(state, [...marks, mark]), added: true, reason: null };
}

export function estimatedTokens(sizeInBytes: number): number {
  return Math.max(0, Math.ceil(sizeInBytes / ESTIMATED_BYTES_PER_TOKEN));
}

export function markOrdinal(snapshot: Pick<ActiveContextSnapshot, "mapped">): number {
  return snapshot.mapped.length;
}

export interface MarkSpanRefs {
  refs: EvidenceRef[];
  unresolved: { foldId: string; pending: boolean } | null;
}

export function markSpanRefs(state: ActiveContextState, mark: PendingMark): MarkSpanRefs {
  const byId = new Map(state.folds.map((fold) => [fold.id, fold] as const));
  const marks = pendingMarks(state);
  const refs: EvidenceRef[] = [];
  let unresolved: MarkSpanRefs["unresolved"] = null;
  const path = new Set<string>();
  const miss = (foldId: string, pending: boolean): void => {
    if (!unresolved) unresolved = { foldId, pending };
  };
  const collect = (parts: readonly FoldPart[]): void => {
    for (const part of parts) {
      if (part.kind === "raw") {
        refs.push(part.ref);
        continue;
      }
      const child = byId.get(part.foldId);
      if (!child) {
        miss(part.foldId, marks.some((item) => item.mark === "fold" && item.id === part.foldId));
        continue;
      }
      if (path.has(child.id)) {
        miss(child.id, false);
        continue;
      }
      path.add(child.id);
      collect(child.parts);
      path.delete(child.id);
    }
  };
  if (mark.mark === "refold") {
    const fold = byId.get(mark.id);
    if (!fold) {
      miss(mark.id, marks.some((item) => item.mark === "fold" && item.id === mark.id));
    } else {
      path.add(fold.id);
      collect(fold.parts);
      path.delete(fold.id);
    }
  } else collect(mark.parts);
  return { refs, unresolved };
}

export function markFreedBytes(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  mark: PendingMark,
): number {
  if (mark.mark === "refold") {
    const fold = state.folds.find((item) => item.id === mark.id);
    if (!fold || !state.expanded.includes(mark.id)) return 0;
    const expanded = renderFold(fold, state, snapshot);
    const folded = renderFold(fold, {
      ...state,
      expanded: state.expanded.filter((id) => id !== mark.id),
    }, snapshot);
    return expanded && folded ? Math.max(0, bytes(expanded) - bytes(folded)) : 0;
  }
  const source = renderFoldParts(mark.parts, state, snapshot);
  if (!source) return 0;
  const placeholders = mark.kind === "tool-result" ? mark.parts.length : 1;
  const placeholder = placeholders * (mark.brief.length + ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES);
  return Math.max(0, bytes(source) - placeholder);
}

export function markTouchesCurrentTurn(
  state: ActiveContextState,
  mark: PendingMark,
  currentTurn: ReadonlySet<string>,
): boolean {
  if (!currentTurn.size) return false;
  return markSpanRefs(state, mark).refs.some((ref) => currentTurn.has(objectRefKey(ref)));
}

export function markSpanStart(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  mark: PendingMark,
): number {
  const span = markSpanRefs(state, mark);
  if (span.unresolved) return snapshot.mapped.length;
  const refs = span.refs;
  const indexed = mappedByKey(snapshot);
  const indices = refs.flatMap((ref) => {
    const item = indexed.get(objectRefKey(ref));
    return item ? [item.index] : [];
  });
  return indices.length ? Math.min(...indices) : snapshot.mapped.length;
}

export const GUARD_WAIVER_PROTECTED_MARKS = 2;

export const GUARD_WAIVER_MINIMUM_MARKS = 4;

export function guardWaiverCount(input: {
  snapshot: ActiveContextSnapshot;
  ratio: number | null;
  guardedMarks: number;
  otherApplicableMarks: number;
  /**
   * THE BOUNDARY IS ITS OWN SIGNAL, and a better one than the occupancy anchor.
   *
   * The anchor exists to answer "is this session in enough trouble to spend the open
   * turn's own evidence": a proxy, because nothing else was asking. At a compaction
   * boundary Pi has already answered it. Cancelling the compaction and then applying
   * nothing hands Pi's own threshold a byte-identical projection, which is worse than
   * letting it compact, because compaction would at least have shed something.
   *
   * Measured on the sol-20260813 smoke: the boundary fired, cancelled the compaction and
   * retained all seven marks at 0.20 occupancy, freeing nothing. The full run reaches the
   * anchor 12,576 tokens past its own trigger, so it self-corrects there and this is
   * about what happens in between; a smoke, or any session whose budget it never
   * approaches, never corrects at all.
   *
   * Everything else about the waiver is unchanged, and deliberately: the newest marks
   * still stay raw, a small guarded set still holds whole, and other applicable work
   * still takes precedence over spending the open turn.
   */
  boundary?: boolean;
}): number {
  const { snapshot, ratio, guardedMarks, otherApplicableMarks, boundary } = input;
  if (guardedMarks <= 0 || typeof ratio !== "number" || !Number.isFinite(ratio)) return 0;
  if (ratio >= hardFenceRatio(snapshot)) return guardedMarks;
  const occupancy = budgetOccupancy(snapshot, ratio);
  if (occupancy === null || otherApplicableMarks > 0) return 0;
  if (occupancy < snapshot.policy.refoldRatio && !boundary) return 0;
  if (guardedMarks < GUARD_WAIVER_MINIMUM_MARKS) return 0;
  return Math.max(1, guardedMarks - GUARD_WAIVER_PROTECTED_MARKS);
}

export type MarkEligibility = "eligible" | "protected" | "unfulfillable";

export function markEligibility(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  mark: PendingMark,
): MarkEligibility {
  if (mark.mark === "refold") {
    const fold = state.folds.find((item) => item.id === mark.id);
    if (!fold || !foldInterval(fold, state, snapshot)) return "unfulfillable";
    return state.expanded.includes(mark.id) ? "eligible" : "unfulfillable";
  }
  const span = markSpanRefs(state, mark);
  if (span.unresolved) return span.unresolved.pending ? "protected" : "unfulfillable";
  const refs = span.refs;
  if (!refs.length) return "unfulfillable";
  const mapped = new Set(snapshot.mapped.flatMap((item) => item.ref ? [objectRefKey(item.ref)] : []));
  if (refs.some((ref) => !mapped.has(objectRefKey(ref)))) return "unfulfillable";
  const blocked = mark.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot);
  return blocked ? "protected" : "eligible";
}

export interface MarkAccounting {
  pending: number;
  agentMarks: number;
  ladderMarks: number;
  freedBytes: number;
  freedTokens: number;
  freedBudgetShare: number;
  rewriteTokens: number;
  eligibleMarks: number;
  retainedMarks: number;
  eligibleFreedBytes: number;
  eligibleFreedTokens: number;
  eligibleFreedBudgetShare: number;
  pinnedBytes: number;
  pinnedResults: number;
}

export function markAccounting(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): MarkAccounting {
  const marks = pendingMarks(state);
  const indexByKey = new Map(snapshot.mapped.flatMap((item) =>
    item.ref ? [[objectRefKey(item.ref), item.index] as const] : []));
  let freedBytes = 0;
  let eligibleFreedBytes = 0;
  let eligibleMarks = 0;
  let retainedMarks = 0;
  let earliest = -1;
  for (const mark of marks) {
    const freed = markFreedBytes(snapshot, state, mark);
    freedBytes += freed;
    const eligibility = markEligibility(snapshot, state, mark);
    if (eligibility === "eligible") {
      eligibleMarks += 1;
      eligibleFreedBytes += freed;
    } else if (eligibility === "protected") retainedMarks += 1;
    for (const ref of markSpanRefs(state, mark).refs) {
      const index = indexByKey.get(objectRefKey(ref));
      if (index === undefined) continue;
      if (earliest < 0 || index < earliest) earliest = index;
    }
  }
  const rewriteBytes = earliest < 0
    ? 0
    : bytes(snapshot.messages.slice(earliest));
  const freedTokens = estimatedTokens(freedBytes);
  const eligibleFreedTokens = estimatedTokens(eligibleFreedBytes);
  const pinned = pinnedPeekMass(snapshot, state);
  return {
    pending: marks.length,
    agentMarks: marks.filter((mark) => mark.origin === "agent").length,
    ladderMarks: marks.filter((mark) => mark.origin === "ladder").length,
    freedBytes,
    freedTokens,
    freedBudgetShare: snapshot.budgetTokens > 0 ? freedTokens / snapshot.budgetTokens : 0,
    rewriteTokens: estimatedTokens(rewriteBytes),
    eligibleMarks,
    retainedMarks,
    eligibleFreedBytes,
    eligibleFreedTokens,
    eligibleFreedBudgetShare: snapshot.budgetTokens > 0
      ? eligibleFreedTokens / snapshot.budgetTokens
      : 0,
    pinnedBytes: pinned.bytes,
    pinnedResults: pinned.results,
  };
}

export function epochCommitDue(snapshot: ActiveContextSnapshot, ratio: number | null): boolean {
  const occupancy = budgetOccupancy(snapshot, ratio);
  return occupancy !== null && occupancy >= snapshot.thresholds.maxTarget;
}

export function foldMarkFor(input: {
  candidate: FoldCandidate;
  brief: string;
  briefProvenance: PendingFoldMark["briefProvenance"];
  origin: MarkOrigin;
  ordinal: number;
}): PendingFoldMark {
  const { candidate } = input;
  return {
    mark: "fold",
    id: foldIdFor(candidate.kind, candidate.parts),
    kind: candidate.kind,
    parts: clone(candidate.parts),
    brief: input.brief,
    briefProvenance: clone(input.briefProvenance),
    origin: input.origin,
    ordinal: input.ordinal,
  };
}

export function ladderBrief(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  candidate: FoldCandidate,
): string {
  if (candidate.kind === "tool-result") return automaticToolBrief(snapshot, candidate);
  if (candidate.kind === "consolidation") {
    return deterministicConsolidationBrief(candidate, state, snapshot.toolName);
  }
  return deterministicChapterCandidateBrief(snapshot, candidate);
}

export function automaticMarkBrief(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  candidate: FoldCandidate,
): { brief: string; briefProvenance: PendingFoldMark["briefProvenance"] } {
  const prepared = state.prepared;
  if (prepared && preparedMatchesCandidate(prepared, candidate)) {
    return { brief: prepared.fold.brief, briefProvenance: clone(prepared.fold.provenance) };
  }
  return { brief: ladderBrief(snapshot, state, candidate), briefProvenance: { kind: "deterministic" } };
}

export function ladderSelectionMark(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  selection: AutomaticRungSelection;
  ordinal: number;
}): PendingMark | null {
  const { selection } = input;
  if (selection.kind === "refold") {
    return { mark: "refold", id: selection.foldId, origin: "ladder", ordinal: input.ordinal };
  }
  if (selection.kind !== "tool" && selection.kind !== "chapter" && selection.kind !== "consolidation") {
    return null;
  }
  return foldMarkFor({
    candidate: selection.candidate,
    ...automaticMarkBrief(input.snapshot, input.state, selection.candidate),
    origin: "ladder",
    ordinal: input.ordinal,
  });
}

export function ephemeralPeekMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
}): PendingFoldMark[] {
  const { snapshot, state } = input;
  const claimed = claimedRefKeys(state);
  const groups = new Map<number, Array<{ index: number; call: NonNullable<ReturnType<typeof resultCall>> }>>();
  for (const item of snapshot.mapped) {
    if (messageRole(item.message) !== "toolResult" || !item.ref) continue;
    const call = resultCall(snapshot, item.index, true);
    if (!call || call.name !== snapshot.toolName) continue;
    const group = groups.get(call.assistantIndex) ?? [];
    group.push({ index: item.index, call });
    groups.set(call.assistantIndex, group);
  }
  const marks: PendingFoldMark[] = [];
  for (const group of [...groups.entries()].sort(([left], [right]) => left - right)) {
    const entries = group[1];
    const expected = entries[0].call.batch;
    const ids = new Set(entries.map(({ call }) => call.id));
    if (ids.size !== expected.length || expected.some((id) => !ids.has(id))) continue;
    const refs = entries
      .sort((left, right) => left.index - right.index)
      .map(({ index }) => snapshot.mapped[index].ref!);
    const peeked = peekedSourceFoldIds(snapshot, refs);
    if (!peeked) continue;
    if (peeked.some((id) => state.expanded.includes(id) || peekedFoldProtected(snapshot, state, id))) continue;
    if (refs.some((ref) => claimed.has(objectRefKey(ref))) ||
        refs.length > snapshot.policy.maxFoldSourceRefs ||
        toolRefsProtected(refs, state, snapshot)) continue;
    const candidate: FoldCandidate = {
      kind: "tool-result",
      parts: refs.map((ref) => ({ kind: "raw" as const, ref })),
      sourceRefs: refs,
    };
    marks.push(foldMarkFor({
      candidate,
      brief: automaticToolBrief(snapshot, candidate),
      briefProvenance: { kind: "deterministic" },
      origin: "agent",
      ordinal: input.ordinal,
    }));
  }
  return marks;
}

function peekedFoldProtected(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  foldId: string,
): boolean {
  const fold = state.folds.find((item) => item.id === foldId);
  if (!fold) return false;
  const refs = flattenFoldRefs(fold, state);
  return fold.kind === "tool-result"
    ? toolRefsProtected(refs, state, snapshot)
    : refsProtected(refs, state, snapshot);
}

export function claimedRefKeys(state: ActiveContextState): Set<string> {
  const keys = new Set<string>();
  for (const fold of state.folds) {
    for (const part of fold.parts) if (part.kind === "raw") keys.add(objectRefKey(part.ref));
  }
  for (const mark of pendingMarks(state)) {
    if (mark.mark !== "fold") continue;
    for (const ref of markSpanRefs(state, mark).refs) keys.add(objectRefKey(ref));
  }
  return keys;
}

export interface UnmarkedRemainder {
  spans: number;
  tokens: number;
  share: number;
  candidates: Array<{ id: string; tokens: number }>;
}

export function unmarkedRemainder(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  charsPerToken: number,
  limit = MAX_UNMARKED_CANDIDATES,
): UnmarkedRemainder {
  const perToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : ESTIMATED_BYTES_PER_TOKEN;
  const claimed = claimedRefKeys(state);
  const members = new Set<number>();
  for (const batch of automaticToolBatches(snapshot, state)) {
    for (const index of batch.indices) members.add(index);
  }
  const candidates: Array<{ id: string; tokens: number }> = [];
  let unmarkedBytes = 0;
  let memberBytes = 0;
  for (const item of snapshot.mapped) {
    if (!item.ref || !members.has(item.index)) continue;
    const size = bytes(item.message);
    memberBytes += size;
    if (claimed.has(objectRefKey(item.ref))) continue;
    unmarkedBytes += size;
    candidates.push({ id: item.ref.entryId, tokens: Math.ceil(size / perToken) });
  }
  candidates.sort((left, right) => right.tokens - left.tokens || (left.id < right.id ? -1 : 1));
  return {
    spans: candidates.length,
    tokens: Math.ceil(unmarkedBytes / perToken),
    share: memberBytes > 0 ? unmarkedBytes / memberBytes : 0,
    candidates: candidates.slice(0, Math.max(0, limit)),
  };
}

export function markedFoldIds(state: ActiveContextState): Set<string> {
  const ids = new Set<string>();
  for (const mark of pendingMarks(state)) if (mark.mark === "refold") ids.add(mark.id);
  return ids;
}

export function consolidationMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
}): PendingFoldMark[] {
  return selectAutomaticConsolidations(input.snapshot, input.state).map((candidate) => foldMarkFor({
    candidate,
    ...automaticMarkBrief(input.snapshot, input.state, candidate),
    origin: "ladder",
    ordinal: input.ordinal,
  }));
}

export function topUpMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
  targetShare: number;
  excludeRefKeys?: ReadonlySet<string>;
  eligibleOnly?: boolean;
}): PendingFoldMark[] {
  const { snapshot } = input;
  const target = input.targetShare;
  const claimed = claimedRefKeys(input.state);
  for (const key of input.excludeRefKeys ?? []) claimed.add(key);
  const marks: PendingFoldMark[] = [];
  let state = input.state;
  const progress = (value: ActiveContextState): number => {
    const accounting = markAccounting(snapshot, value);
    return input.eligibleOnly ? accounting.eligibleFreedBudgetShare : accounting.freedBudgetShare;
  };
  let share = progress(state);
  while (share < target) {
    const candidate = selectAutomaticSpan(snapshot, state, claimed);
    if (!candidate) break;
    const mark = foldMarkFor({
      candidate,
      ...automaticMarkBrief(snapshot, state, candidate),
      origin: "ladder",
      ordinal: input.ordinal,
    });
    const addition = addPendingMark(state, mark);
    if (!addition.added) break;
    state = addition.state;
    marks.push(mark);
    for (const ref of candidate.sourceRefs) claimed.add(objectRefKey(ref));
    share = progress(state);
  }
  return marks;
}

export interface AbsorbedWedge {
  intoMarkId: string;
  fromMarkId: string;
  startId: string;
  endId: string;
  entries: number;
  tokens: number;
}

export function absorbWedgeMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  charsPerToken: number;
  excludeRefKeys?: ReadonlySet<string>;
}): { state: ActiveContextState; absorbed: AbsorbedWedge[] } {
  const { snapshot } = input;
  const charsPerToken = Number.isFinite(input.charsPerToken) && input.charsPerToken > 0
    ? input.charsPerToken
    : ESTIMATED_BYTES_PER_TOKEN;
  const exclude = input.excludeRefKeys ?? new Set<string>();
  let state = input.state;
  const absorbed: AbsorbedWedge[] = [];
  const indexByKey = new Map(snapshot.mapped.flatMap((item) =>
    item.ref ? [[objectRefKey(item.ref), item.index] as const] : []));
  const markInterval = (mark: PendingFoldMark): { start: number; end: number } | null => {
    const indices = markSpanRefs(state, mark).refs
      .map((ref) => indexByKey.get(objectRefKey(ref)))
      .filter((index): index is number => index !== undefined);
    return indices.length ? { start: Math.min(...indices), end: Math.max(...indices) } : null;
  };
  for (;;) {
    const marks = pendingMarks(state);
    const occupied = [
      ...orderedRoots(state, snapshot).map((root) => ({ start: root.start, end: root.end })),
      ...marks.flatMap((mark) => {
        if (mark.mark !== "fold") return [];
        const interval = markInterval(mark);
        return interval ? [interval] : [];
      }),
    ].sort((left, right) => left.start - right.start);
    let applied = false;
    for (const mark of marks) {
      if (mark.mark !== "fold") continue;
      const interval = markInterval(mark);
      if (!interval) continue;
      const previous = occupied.filter((item) => item.end < interval.start).at(-1);
      const gapStart = previous ? previous.end + 1 : -1;
      const gapEnd = interval.start - 1;
      if (gapStart < 0 || gapEnd < gapStart) continue;
      if (absorbed.some((item) => item.intoMarkId === mark.id)) continue;
      const gapTokens = Math.ceil(spanBytes(snapshot, gapStart, gapEnd + 1) / charsPerToken);
      if (gapTokens > MAX_WEDGE_ABSORB_TOKENS) continue;
      const gapRefs = [];
      let usable = true;
      for (let index = gapStart; index <= gapEnd; index += 1) {
        const ref = snapshot.mapped[index]?.ref;
        if (!ref || exclude.has(objectRefKey(ref))) { usable = false; break; }
        gapRefs.push(ref);
      }
      if (!usable || !gapRefs.length) continue;
      if (refsProtected(gapRefs, state, snapshot)) continue;
      if (!chapterRangeIsUnitAligned(snapshot, gapStart, interval.end)) continue;
      const parts = partsForRange(snapshot, state, gapStart, interval.end, new Set<FoldKind>(["tool-result"]));
      if (!parts) continue;
      const grown = foldMarkFor({
        candidate: { kind: "chapter", parts, sourceRefs: candidateSourceRefs(parts, state) },
        brief: `${mark.brief} It also holds ${gapRefs.length} short adjacent entry(s) absorbed at commit.`
          .slice(0, snapshot.policy.maxBriefChars),
        briefProvenance: mark.briefProvenance,
        origin: mark.origin,
        ordinal: mark.ordinal,
      });
      const kept = pendingMarks(state).filter((item) => pendingMarkKey(item) !== pendingMarkKey(mark));
      if (kept.some((item) => pendingMarkKey(item) === pendingMarkKey(grown))) continue;
      state = withPendingMarks(state, [...kept, grown]);
      absorbed.push({
        intoMarkId: grown.id,
        fromMarkId: mark.id,
        startId: gapRefs[0].entryId,
        endId: gapRefs.at(-1)!.entryId,
        entries: gapRefs.length,
        tokens: gapTokens,
      });
      applied = true;
      break;
    }
    if (!applied) break;
  }
  return { state, absorbed };
}

export interface AppliedMark {
  mark: PendingMark["mark"];
  id: string;
  origin: MarkOrigin;
  foldId: string;
}

export interface RefusedMark {
  mark: PendingMark["mark"];
  id: string;
  origin: MarkOrigin;
  reason: string;
  retained: boolean;
}

export interface CommitEpochResult {
  state: ActiveContextState;
  applied: AppliedMark[];
  refused: RefusedMark[];
  retained: PendingMark[];
  waived: PendingMark[];
}

export async function commitPendingMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  now?: () => number;
  retainIneligible?: boolean;
  guardCurrentTurn?: boolean;
  guardWaiver?: number;
}): Promise<CommitEpochResult> {
  const marks = pendingMarks(input.state);
  const retained: PendingMark[] = [];
  const waived: PendingMark[] = [];
  const guardReasons = new Map<string, string>();
  const held = new Set(input.state.folds.map((fold) => fold.id));
  const deferred: PendingMark[] = [];
  const awaitingMintedChild = (mark: PendingMark): boolean =>
    markSpanRefs(input.state, mark).unresolved?.pending === true;
  const currentTurn = input.guardCurrentTurn
    ? currentTurnRefKeys(input.snapshot)
    : new Set<string>();
  if (input.guardCurrentTurn) {
    const applicable: PendingMark[] = [];
    const guarded: PendingMark[] = [];
    for (const mark of marks) {
      if (markTouchesCurrentTurn(input.state, mark, currentTurn)) guarded.push(mark);
      else applicable.push(mark);
    }
    const guardedStart = new Map(guarded.map((mark) =>
      [pendingMarkKey(mark), markSpanStart(input.snapshot, input.state, mark)] as const));
    guarded.sort((left, right) =>
      guardedStart.get(pendingMarkKey(left))! - guardedStart.get(pendingMarkKey(right))! ||
      left.id.localeCompare(right.id));
    const waiverCount = Math.max(0, Math.min(guarded.length, Math.trunc(input.guardWaiver ?? 0)));
    for (const [index, mark] of guarded.entries()) {
      if (index < waiverCount) {
        waived.push(mark);
        applicable.push(mark);
        continue;
      }
      retained.push(mark);
      guardReasons.set(
        pendingMarkKey(mark),
        "evidence was gathered in the current turn; the mark stays pending until the turn closes",
      );
    }
    marks.length = 0;
    marks.push(...applicable);
  }
  if (input.retainIneligible) {
    const applicable: PendingMark[] = [];
    for (const mark of marks) {
      if (!awaitingMintedChild(mark) &&
          markEligibility(input.snapshot, input.state, mark) === "protected") retained.push(mark);
      else applicable.push(mark);
    }
    marks.length = 0;
    marks.push(...applicable);
  }
  let state = withPendingMarks(input.state, retained);
  const applied: AppliedMark[] = [];
  const refused: RefusedMark[] = retained.map((mark) => ({
    mark: mark.mark,
    id: mark.id,
    origin: mark.origin,
    reason: guardReasons.get(pendingMarkKey(mark)) ??
      "span is still fresh or protected; the mark stays pending until it is eligible",
    retained: true,
  }));
  const minting = new Map(marks.flatMap((mark) =>
    mark.mark === "fold" && !held.has(mark.id) ? [[mark.id, mark] as const] : []));
  const applyStart = new Map(marks.map((mark) =>
    [pendingMarkKey(mark), markSpanStart(input.snapshot, input.state, mark)] as const));
  const base = [...marks].sort((left, right) =>
    applyStart.get(pendingMarkKey(left))! - applyStart.get(pendingMarkKey(right))! ||
    left.id.localeCompare(right.id));
  const ordered: PendingMark[] = [];
  const placed = new Set<string>();
  const placing = new Set<string>();
  const place = (mark: PendingMark): void => {
    const key = pendingMarkKey(mark);
    if (placed.has(key) || placing.has(key)) return;
    placing.add(key);
    if (mark.mark === "fold") {
      for (const childId of childFoldIds(mark)) {
        const child = minting.get(childId);
        if (child) place(child);
      }
    }
    placing.delete(key);
    placed.add(key);
    ordered.push(mark);
  };
  for (const mark of base) place(mark);
  for (const mark of ordered) {
    try {
      if (mark.mark === "refold") {
        const fold = state.folds.find((item) => item.id === mark.id);
        if (!fold || !foldInterval(fold, state, input.snapshot)) {
          throw new Error(`fold ${mark.id} is no longer active in the context event`);
        }
        if (!state.expanded.includes(mark.id)) throw new Error(`fold ${mark.id} is already folded`);
        state = setFoldProjectionState(state, mark.id, "folded");
        applied.push({ mark: "refold", id: mark.id, origin: mark.origin, foldId: mark.id });
        continue;
      }
      const parts = clone(mark.parts);
      const span = markSpanRefs(state, mark);
      if (span.unresolved) {
        const { foldId, pending } = span.unresolved;
        if (pending) deferred.push(mark);
        refused.push({
          mark: mark.mark,
          id: mark.id,
          origin: mark.origin,
          reason: pending
            ? `pending fold mark ${mark.id} names fold ${foldId}, which a still-pending mark ` +
              "has not minted yet; the mark stays pending until that fold lands"
            : `pending fold mark ${mark.id} names fold ${foldId}, which the context no longer ` +
              "holds and no pending mark will mint; the decision cannot be honoured",
          retained: pending,
        });
        continue;
      }
      const sourceRefs = span.refs;
      const blocked = mark.kind === "tool-result"
        ? toolRefsProtected(sourceRefs, state, input.snapshot)
        : refsProtected(sourceRefs, state, input.snapshot);
      if (blocked) {
        throw new Error(
          `pending fold mark ${mark.id} covers protected or fresh evidence; ` +
          "unprotect that evidence and mark it again",
        );
      }
      const prepared = await prepareFold({
        candidate: { kind: mark.kind, parts, sourceRefs },
        snapshot: input.snapshot,
        state,
        generation: input.generation,
        brief: mark.brief,
        briefProvenance: mark.briefProvenance,
        now: input.now,
      });
      state = commitPreparedFold({
        prepared,
        snapshot: input.snapshot,
        state,
        generation: input.generation,
      });
      applied.push({ mark: "fold", id: mark.id, origin: mark.origin, foldId: prepared.id });
      if (state.prepared && state.folds.some((fold) => fold.id === state.prepared!.id)) {
        state = clearPrepared(state);
      }
    } catch (error) {
      refused.push({
        mark: mark.mark,
        id: mark.id,
        origin: mark.origin,
        reason: error instanceof Error ? error.message : String(error),
        retained: false,
      });
    }
  }
  if (deferred.length) {
    state = withPendingMarks(state, [...pendingMarks(state), ...deferred]);
    retained.push(...deferred);
  }
  return { state, applied, refused, retained, waived };
}

export function schedulingStatus(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ratio: number | null;
}): Record<string, unknown> {
  const accounting = markAccounting(input.snapshot, input.state);
  return {
    mode: "epoch",
    ...accounting,
    thresholds: { ...input.snapshot.thresholds },
    budgetTokens: input.snapshot.budgetTokens,
    commitDue: epochCommitDue(input.snapshot, input.ratio),
    commitTrigger: {
      mode: "band-top",
      commitOccupancy: input.snapshot.thresholds.maxTarget,
      occupancy: budgetOccupancy(input.snapshot, input.ratio),
      due: epochCommitDue(input.snapshot, input.ratio),
    },
    marks: pendingMarks(input.state).map((mark) => ({
      mark: mark.mark,
      id: mark.id,
      origin: mark.origin,
      ordinal: mark.ordinal,
      eligibility: markEligibility(input.snapshot, input.state, mark),
      ...(mark.mark === "fold" ? { kind: mark.kind, brief: mark.brief } : {}),
    })),
  };
}
