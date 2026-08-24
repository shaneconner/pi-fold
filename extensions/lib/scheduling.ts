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
  selectAutomaticChapter,
  selectAutomaticSpan,
  setFoldProjectionState,
} from "./folding.ts";
import type { AutomaticRungSelection } from "./folding.ts";
import {
  foldInterval,
  budgetOccupancy,
  mappedByKey,
  orderedRoots,
  protectedStaleMass,
  refsProtected,
} from "./measurement.ts";
import {
  childFoldIds,
  clearPrepared,
  flattenFoldRefs,
  foldIdFor,
  parsePendingMarks,
  pendingMarkKey,
} from "./persistence.ts";
import {
  ESTIMATED_BYTES_PER_TOKEN,
  ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES,
  MAX_FRONTIER_CUTS_PER_PASS,
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
  selectAutomaticRefold,
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
  delete head.pendingMarks;
  delete head.advisory;
  delete head.prepared;
  return {
    ...head,
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
  const blocked = refsProtected(refs, state, snapshot);
  return blocked ? "protected" : "eligible";
}

export interface MarkAccounting {
  pending: number;
  agentMarks: number;
  ladderMarks: number;
  userMarks: number;
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
    userMarks: marks.filter((mark) => mark.origin === "user").length,
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
    return deterministicConsolidationBrief(candidate, state, snapshot.toolName, snapshot);
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
        refsProtected(refs, state, snapshot)) continue;
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
  return refsProtected(refs, state, snapshot);
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
  /** Raw bytes, which is what the fold frontier measures itself against. */
  chars: number;
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
  // CHAPTERS ARE FOLDABLE MASS TOO (Shane, 2026-08-23).
  //
  // The population used to be tool batches alone, while `selectAutomaticSpan` proposes a
  // chapter whenever no batch is available, so on a chapter-heavy session this reported a
  // remainder of zero over material automatic folding was about to take. It is the reading
  // a deferred commit uses to say whether its mass is HELD or simply absent, which is the
  // one distinction that record exists to draw, and it was answering "absent" for mass in
  // plain view. It also broke the frontier's first cut, which gated on this number before
  // the threshold moved into the selector where it belongs.
  //
  // Walked with the selector rather than re-derived, so the population is what automatic
  // folding can actually reach and cannot drift from it. Walked from an EMPTY claim set,
  // because this is the DENOMINATOR: a chapter already claimed by a mark is still foldable
  // mass, it is just mass that is already spoken for, and the numerator below is what
  // subtracts it. Bounded by the mapped length, which no terminating walk can exceed since
  // every pass claims at least one ref.
  const indexed = mappedByKey(snapshot);
  const walked = new Set<string>();
  for (let pass = 0; pass < snapshot.mapped.length; pass += 1) {
    const chapter = selectAutomaticChapter(snapshot, state, walked);
    if (!chapter) break;
    for (const ref of chapter.sourceRefs) {
      walked.add(objectRefKey(ref));
      const item = indexed.get(objectRefKey(ref));
      if (item) members.add(item.index);
    }
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
    chars: unmarkedBytes,
    share: memberBytes > 0 ? unmarkedBytes / memberBytes : 0,
    candidates: candidates.slice(0, Math.max(0, limit)),
  };
}

/**
 * THE FOLD FRONTIER: THE RUNTIME CUTS, AND THE AGENT EDITS WHAT IT CUT
 * (Shane, 2026-08-23).
 *
 * The ladder used to stage nothing between commits, and before that it staged a mark on
 * every measured response. Both were answers to the same question, WHEN SHOULD THE AGENT
 * CURATE, and both got it wrong in the same way: they asked the agent to CHOOSE SPANS.
 * Eager staging chose them first and crowded the agent out; standing down left the choice
 * open until the commit, by which time the material was long out of view and the only
 * information available was staleness, which the runtime already has.
 *
 * So the choice moves. As raw material accumulates past `minFoldChars`, the runtime cuts
 * it, stalest first, exactly as a commit would. The cut is a PENDING MARK and pending
 * marks are byte-inert: nothing moves, the projection does not change, the prefix cache is
 * untouched, and the agent keeps seeing the raw material until a commit applies it. What
 * the agent gets is a fold to annotate while the content is still fresh, which is the one
 * thing it knows that the runtime does not.
 *
 * The loop bounds itself twice over. It stops when the unmarked remainder falls under the
 * threshold, and it stops when the selector runs out of members, so a window whose whole
 * remainder is pinned or blacklisted stages nothing and says so by returning empty rather
 * than spinning.
 */
export function frontierMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
}): PendingFoldMark[] {
  const { snapshot } = input;
  const claimed = claimedRefKeys(input.state);
  const marks: PendingFoldMark[] = [];
  let state = input.state;
  while (marks.length < MAX_FRONTIER_CUTS_PER_PASS) {
    // THE THRESHOLD IS THE SELECTOR'S OWN, which is `minFoldChars`, and it is read there
    // rather than counted here. The first cut of this measured the unmarked remainder
    // instead, and that reads TOOL BATCHES ONLY: a chapter-only session had a remainder of
    // zero however much raw prose it held, so the frontier never fired on it at all and
    // gate 7's fixture produced no cut. One threshold, in the one place that knows every
    // span kind.
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
  }
  return marks;
}

/**
 * The pending mark that already holds a piece of this evidence, if any.
 *
 * The commit fills from the stale end and the depth bound retains what it does not
 * reach, so a ladder mark routinely outlives the commit that staged it. An agent
 * marking the same evidence afterwards would stand a second owner over one span and
 * lose at apply time with a forest invariant for a message. Refusing at the tool says
 * so while the agent can still act on it.
 */
export function markClaimingRef(
  state: ActiveContextState,
  refs: readonly EvidenceRef[],
): { markId: string; entryId: string } | null {
  for (const mark of pendingMarks(state)) {
    if (mark.mark !== "fold") continue;
    const claimed = new Set(markSpanRefs(state, mark).refs.map(objectRefKey));
    for (const ref of refs) {
      if (claimed.has(objectRefKey(ref))) return { markId: mark.id, entryId: ref.entryId };
    }
  }
  return null;
}

export interface WindowClaims {
  /** Tokens standing marks will free at the next commit. */
  markedTokens: number;
  /** Tokens the agent pinned raw: a claim that frees nothing and is never taken. */
  pinnedTokens: number;
  pinnedRefs: number;
  /** Pinned mass as a share of the serving budget, against its cap. */
  pinnedShare: number;
  /** Completed units neither marked nor pinned: what the ladder takes by age. */
  unclaimedTokens: number;
  unclaimedSpans: number;
}

/**
 * A PIN IS A CLAIM, NOT A FOLD (Shane, 2026-08-22: "if they do a pin on raw span I think
 * we also treat that as a marked fold but a pinned one").
 *
 * Read as accounting, that is exactly right and already half true: pinned evidence is
 * refused to every automatic rung, skipped by wedge absorption, and excluded from the
 * unmarked remainder, so the ladder cannot take it and it is never reported as an
 * oversight. What was missing is that the agent could not SEE it, and the whole point of
 * asking an agent to account for its window is that the gaps become visible.
 *
 * A pin cannot count toward the DROP, and that is not a technicality. Pinned bytes stay
 * in the window, so they free nothing; if they counted, an agent could "cover" a commit
 * with pins, the commit would still be short, and it would fold something else anyway.
 * The number would be a lie at the moment it mattered most. So the three buckets are
 * reported side by side and only one of them pays.
 */
export function windowClaims(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  budgetTokens: number;
  charsPerToken: number;
}): WindowClaims {
  const { snapshot, state, budgetTokens } = input;
  const accounting = markAccounting(snapshot, state);
  const remainder = unmarkedRemainder(snapshot, state, input.charsPerToken);
  const pinned = protectedStaleMass(snapshot, state);
  const pinnedTokens = estimatedTokens(pinned.bytes);
  return {
    markedTokens: Math.round(accounting.eligibleFreedBudgetShare * budgetTokens),
    pinnedTokens,
    pinnedRefs: pinned.refs,
    pinnedShare: budgetTokens > 0 ? pinnedTokens / budgetTokens : 0,
    unclaimedTokens: remainder.tokens,
    unclaimedSpans: remainder.spans,
  };
}

export interface CommitCoverage {
  /** The share of the serving budget the next commit is sized to free. */
  targetShare: number;
  targetTokens: number;
  /** What the standing marks will actually free when that commit runs. */
  markedShare: number;
  markedTokens: number;
  /** What the ladder will take by staleness unless the agent marks it first. */
  remainingTokens: number;
  covered: boolean;
}

/**
 * WHAT THE NEXT COMMIT NEEDS, AND HOW MUCH OF IT THE AGENT HAS COVERED.
 *
 * One definition, read by three callers that used to reason about the drop separately:
 * the commit fill that sizes itself to it, the advisory that warns before it, and the
 * mark response that tells the agent where it stands. An agent asked to govern its own
 * context cannot do it against a number nobody tells it.
 *
 * The marked side is the ELIGIBLE share, not every standing mark, because a mark over
 * protected evidence frees nothing at this commit however good it is. That makes
 * `remainingTokens` the honest answer to "what will fold without me".
 *
 * `targetShare` moves as the window grows: it is measured from occupancy NOW, and two
 * large results landing after the reading raise it again. Callers that render it say so.
 */
export function commitCoverage(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  usedTokens: number | null;
  budgetTokens: number;
}): CommitCoverage {
  const { snapshot, state, usedTokens, budgetTokens } = input;
  const targetShare = usedTokens === null || !(budgetTokens > 0)
    ? 0
    : Math.max(0, (usedTokens - snapshot.thresholds.minTarget * budgetTokens) / budgetTokens);
  const accounting = markAccounting(snapshot, state);
  const markedShare = accounting.eligibleFreedBudgetShare;
  const targetTokens = Math.round(targetShare * budgetTokens);
  const markedTokens = Math.round(markedShare * budgetTokens);
  const remainingTokens = Math.max(0, targetTokens - markedTokens);
  return {
    targetShare,
    targetTokens,
    markedShare,
    markedTokens,
    remainingTokens,
    covered: remainingTokens === 0,
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
  eligibleOnly?: boolean;
}): PendingFoldMark[] {
  const { snapshot } = input;
  const target = input.targetShare;
  const claimed = claimedRefKeys(input.state);
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

/**
 * REFOLD AS THE LAST FILL, NOT THE FIRST (Shane, 2026-08-21).
 *
 * An expanded fold is stale mass sitting in the window, so the commit may reclaim it,
 * but only after raw stale material has been spent. An agent that expands a fold is
 * reading it; taking it back while there is still unfolded material to take is hostile
 * for no gain. Pin holds a span past that point, and a live lease holds it for the
 * generations right after the expand. Stalest first, and never past the freeing target.
 */
export function refoldMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
  targetShare: number;
  eligibleOnly?: boolean;
}): PendingMark[] {
  const { snapshot } = input;
  const marks: PendingMark[] = [];
  let state = input.state;
  const claimedFoldIds = markedFoldIds(state);
  const progress = (value: ActiveContextState): number => {
    const accounting = markAccounting(snapshot, value);
    return input.eligibleOnly ? accounting.eligibleFreedBudgetShare : accounting.freedBudgetShare;
  };
  let share = progress(state);
  while (share < input.targetShare) {
    const foldId = selectAutomaticRefold(snapshot, state, claimedFoldIds);
    if (!foldId) break;
    const mark: PendingMark = {
      mark: "refold",
      id: foldId,
      origin: "ladder",
      ordinal: input.ordinal,
    };
    const addition = addPendingMark(state, mark);
    if (!addition.added) break;
    state = addition.state;
    marks.push(mark);
    claimedFoldIds.add(foldId);
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
  chars: number;
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
      // THE GAP FLOOR IS THE FOLD FLOOR (Shane, 2026-08-21). A gap between two folds
      // that could not stand as a fold on its own has no business staying raw: it costs
      // its own bytes and buys nothing, and the neighbour beside it can hold it for the
      // price of one sentence in the brief. So anything under minFoldChars is absorbed
      // and anything at or over it is left alone, because at that size it is a fold the
      // ladder will take on its own terms. This replaced MAX_WEDGE_ABSORB_TOKENS, a
      // separate 256-token constant that let 1,024-char slivers survive between folds.
      const gapBytes = spanBytes(snapshot, gapStart, gapEnd + 1);
      if (gapBytes >= snapshot.thresholds.minFoldChars) continue;
      const gapTokens = Math.ceil(gapBytes / charsPerToken);
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
      // ELIGIBILITY, not truncation (Shane 2026-08-14): the grown fold's brief
      // must name what it absorbed, and a brief already near the policy cap has
      // no room for that sentence. Slicing dropped exactly the words that made
      // the absorption honest, so a wedge whose truthful suffix does not fit is
      // simply not absorbed; the gap stays raw for a later commit.
      const absorbSuffix = ` It also holds ${gapRefs.length} short adjacent entry(s) absorbed at commit.`;
      if (mark.brief.length + absorbSuffix.length > snapshot.policy.maxBriefChars) continue;
      const grown = foldMarkFor({
        candidate: { kind: "chapter", parts, sourceRefs: candidateSourceRefs(parts, state) },
        brief: `${mark.brief}${absorbSuffix}`,
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
        chars: gapBytes,
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
}

export async function commitPendingMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  now?: () => number;
  retainIneligible?: boolean;
  /**
   * How many bytes this commit needs to free. Marks past it are RETAINED, not applied.
   *
   * This bound did not exist before the frontier (Shane, 2026-08-23), and it did not need
   * to: staging was sized to the drop by `topUpMarks`, so every pending mark was one the
   * commit had already decided it wanted. The frontier stages as material ARRIVES, which
   * is the whole point of it, so by the time a commit fires the pending set is everything
   * the window holds. Applying all of it would cut the window to nothing at the first
   * commit, which is neither what the budget asks for nor what the agent is owed: what it
   * is owed is that material stays raw for as long as there is room for it.
   *
   * Undefined means no bound, which is what the emergency lanes want: a fence or a
   * rollback is not housekeeping and takes everything it can.
   */
  applyTargetBytes?: number;
}): Promise<CommitEpochResult> {
  // THE CURRENT-TURN GUARD IS DELETED (Shane, 2026-08-23: "you're using turns as the
  // boundaries, which should not be the case. It should be at the most granular level,
  // which is events"). The guard retained every mark touching a toolResult newer than
  // the last terminal assistant stop, and a terminal stop is a TURN artifact: the first
  // live session (sol-20260823-live rep 1) ran its whole workload as one turn, every
  // assistant response stopping "toolUse", so the guard's "current turn" was the entire
  // window, four band-top commits applied nothing, and the projection fence swept 18
  // marks at 0.958 occupancy down to a 0.031 landing against a 0.40 aim. The waiver
  // machinery existed only to bail the guard out at the fence and the boundary, so it
  // is deleted with it. What protects the working set now is structural and event-level:
  // an incomplete batch is never proposable, the depth bound stops the routine commit at
  // the aim, and the stalest-first cut order leaves the newest events raw.
  const marks = pendingMarks(input.state);
  const retained: PendingMark[] = [];
  const held = new Set(input.state.folds.map((fold) => fold.id));
  const deferred: PendingMark[] = [];
  const awaitingMintedChild = (mark: PendingMark): boolean =>
    markSpanRefs(input.state, mark).unresolved?.pending === true;
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
    reason: "span is still fresh or protected; the mark stays pending until it is eligible",
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
  // THE DEPTH CUT, STALEST FIRST. `base` is already in span order, so taking a prefix of
  // it takes the oldest material and leaves the newest raw, which is the ordering the
  // agent would choose if it were asked. A mark left over here is RETAINED rather than
  // refused: it is still pending, still briefable, still editable, and the next commit
  // that needs depth will reach it.
  const bounded: PendingMark[] = [];
  if (input.applyTargetBytes !== undefined && input.applyTargetBytes > 0) {
    let freed = 0;
    for (const mark of base) {
      if (freed >= input.applyTargetBytes) {
        bounded.push(mark);
        continue;
      }
      freed += markFreedBytes(input.snapshot, input.state, mark);
    }
    if (bounded.length) {
      const spare = new Set(bounded.map((mark) => pendingMarkKey(mark)));
      const kept = base.filter((mark) => !spare.has(pendingMarkKey(mark)));
      base.length = 0;
      base.push(...kept);
      for (const mark of bounded) {
        retained.push(mark);
        refused.push({
          mark: mark.mark,
          id: mark.id,
          origin: mark.origin,
          reason: "the commit reached its target before this mark; it stays pending and " +
            "the span stays raw until a later commit needs the depth",
          retained: true,
        });
      }
      state = withPendingMarks(input.state, retained);
    }
  }
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
      const blocked = refsProtected(sourceRefs, state, input.snapshot);
      if (blocked) {
        throw new Error(
          `pending fold mark ${mark.id} covers protected or fresh evidence; ` +
          "unpin that evidence and mark it again",
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
  return { state, applied, refused, retained };
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
