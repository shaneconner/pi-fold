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
  EPOCH_MAX_TOPUP_MARKS,
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

/**
 * Two-phase fold scheduling.
 *
 * A provider prefix cache is positional: editing the middle of the window
 * invalidates every byte after the edit, so per-turn folding pays a full uncached
 * prefix over and over. Nothing here changes what a fold MEANS. A fold decision
 * becomes a MARK, which moves no projection byte, and a later COMMIT applies every
 * pending mark through the same preparation and commit machinery an immediate fold
 * uses, in one rewrite.
 *
 * Every function is deterministic: transcript ordinals and positions only, never a
 * wall clock and never randomness.
 */

/** The empty read, shared and frozen, so a state with no marks allocates nothing. */
const NO_PENDING_MARKS: readonly PendingMark[] = Object.freeze([]);

/**
 * The pending marks as a READ VIEW, not a copy.
 *
 * Every caller here reads: membership tests, accounting sums, and filters that build
 * a fresh array anyway. The copy belongs on the WRITE path, and `withPendingMarks`
 * already takes it, so taking a second one on every read bought nothing and cost a
 * great deal: `markSpanRefs` calls this once per mark and is itself called once per
 * mark by the accounting, eligibility, staleness, current-turn and absorption
 * readings, which made a deep clone of the whole array quadratic in the mark count
 * per pass. Profiled at 21 percent of a 120-turn session, the single largest cost in
 * the runtime, ahead of every projection and hash.
 *
 * The view is safe because the state is replaced rather than edited: no code path
 * mutates `state.pendingMarks` in place, and the readonly type is what keeps it so.
 */
export function pendingMarks(state: Pick<ActiveContextState, "pendingMarks">): readonly PendingMark[] {
  return state.pendingMarks ?? NO_PENDING_MARKS;
}

/**
 * Property ORDER matters here: the state digest is a stable stringify, so an
 * appended key would replay as digest drift. Rebuild the tail of the record in the
 * same order `parseActiveContextState` produces.
 */
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

/** Idempotent by mark key, bounded, and never silently dropping the oldest mark. */
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

/** Transcript-position ordering used for marks; identical to the surfacing ordinal. */
export function markOrdinal(snapshot: Pick<ActiveContextSnapshot, "mapped">): number {
  return snapshot.mapped.length;
}

export interface MarkSpanRefs {
  /** Every evidence ref the mark's parts resolve to against the state in hand. */
  refs: EvidenceRef[];
  /**
   * The first part naming a fold the state does not hold, or null when the span reads
   * in full. `pending` is the difference between a defer and a drop: a mark still
   * standing carries the id its committed fold will have, so that fold is about to
   * exist, and where no mark names it nothing ever will.
   */
  unresolved: { foldId: string; pending: boolean } | null;
}

/**
 * THE ONE READING OF A MARK'S SPAN, AND IT ANSWERS RATHER THAN THROWS.
 *
 * A mark's parts name folds by id. Between the mark and the commit the state can stop
 * holding one: `reboundary` dissolves a root while consulting only `fold.parentId`, so
 * nothing there consults the pending marks, and the mark is left naming a fold that is
 * gone. `candidateSourceRefs` answers that with `Missing candidate child`, which is
 * right for a candidate being prepared and wrong for every reading that merely reports
 * on a mark: accounting, eligibility, staleness, the current-turn guard, the claimed
 * keys and wedge absorption all ran that throw out of a status call or a commit pass,
 * on state the runtime itself produced (Shane 2026-08-10).
 *
 * So the readings share this, and it is total. Raw parts resolve; a held child is
 * flattened; an unheld child is REPORTED, with the refs either side of it still
 * collected, because a partial span is the honest reading of a partly resolvable mark
 * and a guard that can see half the evidence is better than one that sees none. A
 * repeated fold on the path reads as unresolved and not pending: a corrupt forest costs
 * one mark the ordinary drop rather than hanging the caller, which is the same stop the
 * apply order's `placing` set carries.
 */
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

/**
 * Estimated bytes a mark would remove from the projection. Fold marks use a
 * placeholder estimate rather than a trial fold: the number is presentational, so
 * paying a full preparation per mark on every status call is not worth exactness.
 */
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

/**
 * Whether a pending mark covers any evidence the current excursion just gathered.
 *
 * Read off whatever the span resolves to. A mark naming an unheld fold still answers
 * here, on the parts that DO resolve, so a span holding both fresh raw evidence and a
 * child that has not landed is guarded on the fresh evidence instead of throwing the
 * whole commit.
 */
export function markTouchesCurrentTurn(
  state: ActiveContextState,
  mark: PendingMark,
  currentTurn: ReadonlySet<string>,
): boolean {
  if (!currentTurn.size) return false;
  return markSpanRefs(state, mark).refs.some((ref) => currentTurn.has(objectRefKey(ref)));
}

/**
 * The real staleness of a mark: the earliest window index its span covers, in branch
 * order.
 *
 * A mark's `ordinal` is the transcript position at MARK time, so across epochs it
 * carries when the DECISION was made and nothing about the age of what the decision
 * covers, and inside one epoch every mark shares one value. Ordering a release by it
 * therefore fell through to comparing mark ids, which are content hashes. Measured on the
 * sealed rep-3 state 2026-08-10: the bounded release held back the marks covering window
 * indices 101 and 111 and surrendered the one covering 117, the newest material on the
 * table, so the two marks the guard kept were not the two it exists to keep.
 *
 * A span that no longer maps sorts past the newest entry: there is no staleness to read
 * on material that has left the branch, and releasing such a mark frees no window byte.
 * A span that does not resolve in full sorts there too, for the same reason and by the
 * same number: while a named fold is missing there is no start to read, and the apply
 * order places such a mark off its naming rather than off this reading.
 */
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

/**
 * How many of the newest guarded marks the pressure waiver still protects. The agent's
 * MOST RECENT reads are the ones an in-flight excursion is about to work from, so they
 * are the last thing surrendered; everything older is fair game once the window is the
 * bigger risk.
 */
export const GUARD_WAIVER_PROTECTED_MARKS = 2;

/**
 * How many marks the guard must be holding before the pressure waiver releases any.
 * Without a floor the waiver degrades into exactly the per-pass folding epoch
 * scheduling exists to prevent: the batch drains, one new mark is guarded on the next
 * pass, and releasing that one mark buys a whole prefix invalidation. Below the fence
 * the waiver only ever releases a BATCH. The fence itself ignores this floor.
 */
export const GUARD_WAIVER_MINIMUM_MARKS = 4;

/**
 * Survivability outranks the guard.
 *
 * The current-turn guard is correct while there is room to wait, and fatal once there
 * is not: a workload that never emits a terminal assistant message has ONE turn, so
 * the boundary never advances and every mark is guarded forever. Measured 2026-08-06
 * (rep 11): 58 assistant messages, all stopReason "toolUse", ZERO terminal ones, so
 * the automatic commit applied nothing all run; the only marks that ever landed came
 * from the agent's own two explicit commits. The window reached 359,625 tokens and the
 * next request went out at ~458k estimated and was rejected by the provider.
 *
 * So: the guard holds in full while the commit has other work. It is waived only when
 * it would STARVE the commit -- no other mark could be applied -- and pressure has
 * reached the backstop, and then only for the OLDEST guarded marks. At the hard fence
 * every guarded mark is waived, because the only useful action left is the fold that
 * keeps the request transmissible.
 */
export function guardWaiverCount(input: {
  snapshot: ActiveContextSnapshot;
  ratio: number | null;
  guardedMarks: number;
  /** Marks this commit can apply WITHOUT the waiver. While any exist, the guard holds. */
  otherApplicableMarks: number;
}): number {
  const { snapshot, ratio, guardedMarks, otherApplicableMarks } = input;
  if (guardedMarks <= 0 || typeof ratio !== "number" || !Number.isFinite(ratio)) return 0;
  if (ratio >= hardFenceRatio(snapshot)) return guardedMarks;
  const occupancy = budgetOccupancy(snapshot, ratio);
  if (occupancy === null || occupancy < snapshot.policy.refoldRatio || otherApplicableMarks > 0) return 0;
  if (guardedMarks < GUARD_WAIVER_MINIMUM_MARKS) return 0;
  return Math.max(1, guardedMarks - GUARD_WAIVER_PROTECTED_MARKS);
}

export type MarkEligibility = "eligible" | "protected" | "unfulfillable";

/**
 * Whether a pending mark can be applied right now.
 *
 * "protected" is a WAITING state, not a failure: the span is fresh or the agent
 * protected it, and both conditions expire. "unfulfillable" is terminal: the evidence
 * or the fold the mark names has left the branch, so no later commit can honour it.
 * Collapsing the two is what made a refusal look like a drop.
 *
 * A mark naming a fold the state does not hold is judged by the same two words, and
 * the classification is the whole answer: a fold another pending mark is about to mint
 * is a span still WAITING to be readable, and a fold nothing will mint has left the
 * branch exactly as lost evidence has. No third word (Shane 2026-08-10).
 */
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
  /** Marks a commit could apply right now. */
  eligibleMarks: number;
  /** Marks whose span is still fresh or protected, waiting rather than lost. */
  retainedMarks: number;
  eligibleFreedBytes: number;
  eligibleFreedTokens: number;
  /** The ROI signal: eligible marked mass as a share of the truthful window. */
  eligibleFreedBudgetShare: number;
  /** Raw peek mass no reclamation can take: pinned reads and protected results. */
  pinnedBytes: number;
  /** How many peek results that mass is spread over. */
  pinnedResults: number;
}

/**
 * What a commit of the current marks would cost and free. `rewriteTokens` is the
 * prefix a commit invalidates: everything from the earliest marked message to the
 * end of the window, which is exactly what a positional cache must re-send.
 */
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

/**
 * THE commit trigger. There is exactly one.
 *
 * Occupancy of the serving budget reaches maxTarget and a commit fires. Nothing else
 * fires one automatically: the user command and the fence/recovery lane are the only
 * other paths into a commit, and both are authority rather than economics.
 *
 * Two arms used to sit here. The eligible-share arm asked whether accumulated marks
 * were worth a rewrite and fired 164 commits from ordinal 17 in rep 15, each a fresh
 * cache rebuild bought with marks that had not yet earned one; worse, it could fire
 * BELOW maxTarget, which is the quiet-runtime law it was sitting underneath. The
 * pressure arm read a window ratio against the refold rung, which after
 * re-denomination is simply a second line above this one. Both are gone. Marking is
 * doorless below the commit line and costs nothing, so what a pass accumulates is never a
 * reason to commit; crossing the band top is.
 */
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
    // The same identity the committed fold will get, so a repeated decision is
    // inert rather than a second fold of the same span.
    id: foldIdFor(candidate.kind, candidate.parts),
    kind: candidate.kind,
    parts: clone(candidate.parts),
    brief: input.brief,
    briefProvenance: clone(input.briefProvenance),
    origin: input.origin,
    ordinal: input.ordinal,
  };
}

/** The deterministic brief a ladder decision would have folded with. */
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

/**
 * The brief and provenance an automatic mark carries.
 *
 * A warmed chapter brief the runtime already paid a model call for is REUSED when the
 * prepared fold is exactly this candidate. Under epoch scheduling every automatic fold
 * arrives through a mark, so a preparation whose brief the mark path ignored would be a
 * model call spent on nothing.
 */
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

/**
 * Turn one automatic rung selection into a mark. Prepared chapters are excluded on
 * purpose: that rung only fires at the hard provider fence, which is already inside
 * a commit epoch, and deferring it would strand a model-generated brief.
 */
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

/**
 * PEEK COPIES ARE EPHEMERAL BY CONTRACT.
 *
 * A peek returns a fold's exact stored source, so the copy sits in the window as raw
 * mass beside that fold's own placeholder: the same bytes held twice, with the second
 * copy re-retrievable forever from the id the agent already used. So a completed peek
 * read is reclaimed at the NEXT commit rather than aging through the ladder, and the
 * window being append-only is why the reclaim can only happen at a commit boundary.
 *
 * Two survival paths, and only two. Expanding the fold it peeked means the agent asked
 * for those bytes in place, and pinning is the veto: a pin holds the copy raw through
 * every commit, exactly as it holds any other evidence, and lifting it hands the copy
 * back to the next commit. Both are read here at marking time, and a pin made AFTER the
 * mark exists still vetoes, because a protected mark waits instead of applying.
 *
 * These marks are minted at the last-call exposure as well as at the commit, so the
 * pending disposal is visible during the gated round the pin has to fit inside.
 */
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
    // The agent committed to what it peeked: leave the read in the raw window.
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
      // A peek is an agent-initiated read; attributing its disposal to the ladder
      // would deflate the agent-vs-ladder mark ratio the adjudication reads.
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

/** Every evidence key already spoken for by a fold or a pending fold mark. */
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

/** What is still on the table after the marks in hand: the steering number and its parts. */
export interface UnmarkedRemainder {
  /** Tool results in a MEMBER batch that no fold and no pending mark owns. */
  spans: number;
  tokens: number;
  /** Unmarked member tokens as a share of the member tool mass. The steering number. */
  share: number;
  /** The largest few, by reclaim value, so the next batch is one read away. */
  candidates: Array<{ id: string; tokens: number }>;
}

/**
 * The unmarked remainder, as an AGGREGATE plus a bounded head.
 *
 * An exhaustive list is what the status index already is, and re-rendering it is what
 * this build removed from the projection. What an agent needs to decide the NEXT batch
 * is one percentage and the few largest names; everything else is a total.
 *
 * ONE DEFINITION OF STALE, AND IT IS THE SELECTOR'S OWN. The scope is class membership:
 * every result inside a batch `automaticToolBatches` admits, which is the same
 * enumeration `selectAutomaticToolBatch` picks its proposal out of. So the last call and
 * the deferred-commit record announce mass a commit can actually take, by construction
 * rather than by two filters kept in step. Counting whole-window tool results instead
 * announced material no rung could ever propose: rep 3 named 280k tokens while every
 * selector had nothing, which reads as a runtime refusing work it had just described.
 *
 * Membership is not ownership: the denominator is every member result, taken or not, so
 * the share reads as the fraction of reachable tool mass still unspoken for.
 */
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

/** Every fold id already spoken for by a pending refold mark. */
export function markedFoldIds(state: ActiveContextState): Set<string> {
  const ids = new Set<string>();
  for (const mark of pendingMarks(state)) if (mark.mark === "refold") ids.add(mark.id);
  return ids;
}

/**
 * THE COUNT LAW, AS MARKS. Every parent the eligible-root count owes right now, all of
 * them, in the epoch that notices.
 *
 * Separate from the top-up on purpose. The top-up is pressure arithmetic: it stops the
 * moment the marks in hand reach the freeing target, which is the right rule for how
 * DEEP a commit cuts and the wrong rule entirely for a law that says a count of eligible
 * roots at or above the width is a state that must not persist. So this runs at every
 * commit epoch and it runs first, whatever the pressure and whatever the top-up would
 * have proposed (Shane 2026-08-10).
 */
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

/**
 * Agent judgment leads; automation guarantees the floor. If the marks the agent made
 * would free less than the target share of the window, automation adds the stalest
 * unprotected eligible SPANS until they do: completed tool batches and raw narrative
 * chapters. Placeholders are not on that list any more; a placeholder gets a parent from
 * the count law above, which is not pressure arithmetic and does not stop at a target.
 */
export function topUpMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
  /** Freeing target as a share of the SERVING BUDGET. Required: there is no second default. */
  targetShare: number;
  /** Evidence keys the top-up may never propose, e.g. the current excursion's reads. */
  excludeRefKeys?: ReadonlySet<string>;
  /** Measure progress against ELIGIBLE mass, so pinned or protected marks never count. */
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
  for (let attempt = 0; attempt < EPOCH_MAX_TOPUP_MARKS && share < target; attempt += 1) {
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

/** One sliver a commit swallowed into its later neighbour, reported never inferred. */
export interface AbsorbedWedge {
  /** The mark that grew backward to cover it. */
  intoMarkId: string;
  /**
   * The id that mark carried BEFORE it grew. A mark's id is derived from its span, so
   * growing the span mints a new one; without this the trail from the decision the
   * agent made to the fold that carries it is broken, and a mark appears to vanish.
   */
  fromMarkId: string;
  startId: string;
  endId: string;
  entries: number;
  tokens: number;
}

/**
 * Wedge absorption. THE ANTI-LCM PIN LIVES HERE.
 *
 * A sliver of stale raw content hugging a fold boundary is a crumb nothing will ever
 * reclaim: it is below the minimum chapter size, so no chapter rung will take it, and
 * it is not a tool batch, so no tool rung will either. Absorbing it costs nothing
 * because it happens INSIDE a commit the epoch has already paid for -- it grows a
 * pending mark backward rather than performing a mutation of its own.
 *
 * What it must never do is erode deliberate non-sequential curation. An agent holding
 * folds at 10:20, 40:55 and 60:70 with raw spans between them chose that shape, and a
 * mechanism that swallowed those gaps would delete the curation element outright. So
 * the threshold is tiny, measured in the session's own calibrated tokens, and NOT
 * pressure-scaled: above it, a gap stays raw permanently no matter how full the window
 * gets or how ragged the projection looks.
 */
export function absorbWedgeMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  /** The session's measured serialized chars per token; never a fixed constant. */
  charsPerToken: number;
  /** Evidence absorption may never touch, e.g. the current excursion's own reads. */
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
  // One pass, oldest first. Each absorption rewrites exactly one mark, and a mark that
  // has already grown is not a candidate to grow again in the same commit.
  for (let guard = 0; guard < MAX_PENDING_MARKS; guard += 1) {
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
      // The whole discriminator, in one line: above this, the gap is the agent's.
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
      // Structural safety: the grown span must still be a valid closed chapter, which
      // is what keeps every tool call paired with its result in the projection.
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
  /** Whether the mark survives as pending rather than being discarded. */
  retained: boolean;
}

export interface CommitEpochResult {
  state: ActiveContextState;
  applied: AppliedMark[];
  refused: RefusedMark[];
  retained: PendingMark[];
  /** Guarded marks the pressure waiver released into this commit, oldest material first. */
  waived: PendingMark[];
}

/**
 * Apply every pending mark. This is the ONE mutation of the epoch: it reuses
 * prepareFold/commitPreparedFold exactly as the immediate path does, so a committed
 * mark and an immediate fold produce the same fold record.
 */
export async function commitPendingMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  generation: number;
  now?: () => number;
  /**
   * Keep marks the commit could not apply YET. A mark is a standing decision; dropping
   * it because the span happened to be fresh at commit time silently discards the
   * agent's judgment and leaves nothing for the next commit to act on.
   */
  retainIneligible?: boolean;
  /**
   * Never fold evidence the CURRENT excursion gathered. A commit that runs between
   * an agent's read and its use of that read hands the agent a window where its own
   * just-gathered evidence is a placeholder. Such marks stay pending for the next
   * commit rather than being applied or dropped.
   */
  guardCurrentTurn?: boolean;
  /**
   * How many guarded marks the pressure waiver releases anyway, oldest material first. The
   * guard protects an in-flight excursion; it may never cost the session its ability
   * to send a request at all. See `guardWaiverCount`.
   */
  guardWaiver?: number;
}): Promise<CommitEpochResult> {
  const marks = pendingMarks(input.state);
  const retained: PendingMark[] = [];
  const waived: PendingMark[] = [];
  const guardReasons = new Map<string, string>();
  const held = new Set(input.state.folds.map((fold) => fold.id));
  const deferred: PendingMark[] = [];
  /**
   * Whether the mark names a fold some other standing mark is about to mint. Until that
   * fold exists there is no eligibility worth judging: the question is about material
   * the child owns, and the apply loop is where it gets asked, after the child has
   * landed. A mark naming a fold NOBODY will mint is not this case; it is judged
   * normally, and the apply loop drops it by name.
   */
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
    // Oldest MATERIAL first: the newest reads are the ones the excursion is about to
    // use, so they are the last evidence the waiver surrenders. Staleness is a property
    // of the span, never of when the mark was proposed; see `markSpanStart`. The id
    // comparison is the final tiebreak between marks covering the same start, and
    // nothing else.
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
      // A mark awaiting a child another mark will mint is not judged here. Its
      // eligibility is a question about material the child fold owns, and that fold is
      // what this commit is about to create. The apply loop asks it once the child has
      // landed, and answers by name when it does not.
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
  // CHILDREN BEFORE THE SPANS THAT ABSORB THEM, AND TRANSCRIPT ORDER IS NOT THAT ORDER.
  //
  // The invariant is real: a span whose parts name another mark's fold must find that
  // fold in the forest when it applies. `foldMarkFor` gives a mark the id its committed
  // fold will carry, so the naming is exact and readable off the parts. What it is NOT is
  // geometry. A parent CONTAINS its child, so the earliest window index a parent covers
  // is at or before its child's, and ordering oldest material first applies the parent
  // FIRST in exactly the case the invariant exists for. The cost is not a reordering:
  // `candidateSourceRefs` throws `Missing candidate child` on the unresolved part, the
  // apply loop catches it, and the mark is refused with `retained: false`, so the parent
  // applied one place too early loses the agent's decision outright rather than waiting.
  //
  // So the dependency is the law and the sort key is the tiebreak. Among marks with no
  // such tie, real transcript order: the earliest window index the span covers, oldest
  // material first, id last. The `ordinal` this used to sort on is the transcript position
  // at MARK time, one value shared by every mark an epoch proposes, so within an epoch it
  // decided nothing and the order fell through to comparing content hashes.
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
    // `placing` is the cycle stop. Fold ids are hashes OF the parts, so a cycle would
    // need a hash to name its own ancestor; the guard is here so a corrupt state loses
    // one mark to the ordinary refusal rather than hanging the commit.
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
      // THE ANSWER TO A NAME THE STATE CANNOT RESOLVE, AND IT IS TWO ANSWERS.
      //
      // A mark still standing will mint the fold this one names, so the span becomes
      // readable at the next commit: that is a DEFER, and the mark stays pending. This
      // is the child a guard held while its parent was applicable, which the epoch used
      // to discard outright. Nothing standing names it and it is a DROP: `reboundary`
      // dissolved the fold, or the mark that would have minted it was itself refused,
      // and no later commit can honour the decision. Same two words the eligibility
      // reading uses, and the same receipt shape a dropped brief upgrade gets.
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
      // A warmed preparation the commit just materialized through its mark is spent:
      // leaving it standing would hold a prepared fold whose id already exists in the
      // forest, and every later drift check would refuse it by name.
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
  // Deferrals rejoin the pending set. A mark the loop could not read yet is a standing
  // decision exactly as a guard-held one is, and `retained` is what the commit record
  // counts as deferred, so both live in the same list.
  if (deferred.length) {
    state = withPendingMarks(state, [...pendingMarks(state), ...deferred]);
    retained.push(...deferred);
  }
  return { state, applied, refused, retained, waived };
}

/** The scheduling block reported by the status action. */
export function schedulingStatus(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ratio: number | null;
}): Record<string, unknown> {
  const accounting = markAccounting(input.snapshot, input.state);
  return {
    // A literal, not a setting: epoch is the only scheduler there is.
    mode: "epoch",
    ...accounting,
    // The declared policy, reported never mutable.
    thresholds: { ...input.snapshot.thresholds },
    budgetTokens: input.snapshot.budgetTokens,
    commitDue: epochCommitDue(input.snapshot, input.ratio),
    // One trigger, reported as one line. The eligible share is still reported above in
    // the accounting because it is what a commit WOULD free; it is no longer a reason
    // to fire one.
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
