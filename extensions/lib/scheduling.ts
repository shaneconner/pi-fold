import { objectRefKey } from "../json.ts";
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
  orderedRoots,
  refsProtected,
  toolRefsProtected,
} from "./measurement.ts";
import {
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
  MarkOrigin,
  PendingFoldMark,
  PendingMark,
} from "./policy.ts";
import {
  automaticToolBrief,
  candidateSourceRefs,
  chapterRangeIsUnitAligned,
  partsForRange,
  spanBytes,
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  resultCall,
  toolCallArguments,
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

export function pendingMarks(state: Pick<ActiveContextState, "pendingMarks">): PendingMark[] {
  return state.pendingMarks ? clone(state.pendingMarks) : [];
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

/** Whether a pending mark covers any evidence the current excursion just gathered. */
export function markTouchesCurrentTurn(
  state: ActiveContextState,
  mark: PendingMark,
  currentTurn: ReadonlySet<string>,
): boolean {
  if (!currentTurn.size) return false;
  const refs = mark.mark === "refold"
    ? (() => {
      const fold = state.folds.find((item) => item.id === mark.id);
      return fold ? flattenFoldRefs(fold, state) : [];
    })()
    : candidateSourceRefs(mark.parts, state);
  return refs.some((ref) => currentTurn.has(objectRefKey(ref)));
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
  const refs = candidateSourceRefs(mark.parts, state);
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
    const fold = mark.mark === "refold" ? state.folds.find((item) => item.id === mark.id) : null;
    const refs = mark.mark === "refold"
      ? (fold ? flattenFoldRefs(fold, state) : [])
      : candidateSourceRefs(mark.parts, state);
    for (const ref of refs) {
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
 * The commit trigger.
 *
 * The ROI half asks the economic question: commit when the marks that could apply
 * RIGHT NOW would free enough to pay for the rewrite. The pressure half reuses the
 * ladder's own refold threshold and stays underneath as the SAFETY backstop -- it
 * fires when the window is nearly full, which is the worst moment to discover the
 * marks are worth nothing (the rep4 abort fired there with zero pending marks). The
 * agent's own commit is authoritative and immediate regardless of either.
 */
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
 * doorless in the stale zone and costs nothing, so what a pass accumulates is never a
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
  if (candidate.kind === "consolidation") return deterministicConsolidationBrief(candidate, state);
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
 * Peek is the ephemeral read: look, decide, discard. Its own tool result is a
 * completed read batch, so at the next commit it folds away automatically, unless
 * the agent committed to the fold it peeked by expanding or protecting it.
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
    const peeked: string[] = [];
    let everyCallIsPeek = true;
    for (const { call } of entries) {
      const args = toolCallArguments(snapshot, call.assistantIndex, call.id);
      const action = args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>).action
        : undefined;
      const id = args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>).id
        : undefined;
      if (action !== "peek" || typeof id !== "string" || !id) { everyCallIsPeek = false; break; }
      peeked.push(id);
    }
    if (!everyCallIsPeek) continue;
    // The agent committed to what it peeked: leave the read in the raw window.
    if (peeked.some((id) => state.expanded.includes(id) || peekedFoldProtected(snapshot, state, id))) continue;
    const refs = entries
      .sort((left, right) => left.index - right.index)
      .map(({ index }) => snapshot.mapped[index].ref!);
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
    for (const ref of candidateSourceRefs(mark.parts, state)) keys.add(objectRefKey(ref));
  }
  return keys;
}

/** What is still on the table after the marks in hand: the steering number and its parts. */
export interface UnmarkedRemainder {
  /** Stale tool results outside the fresh tail that no fold and no pending mark owns. */
  spans: number;
  tokens: number;
  /** Unmarked stale tokens as a share of the non-fresh window. The steering number. */
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
 */
export function unmarkedRemainder(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  charsPerToken: number,
  limit = MAX_UNMARKED_CANDIDATES,
): UnmarkedRemainder {
  const perToken = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : ESTIMATED_BYTES_PER_TOKEN;
  const claimed = claimedRefKeys(state);
  const candidates: Array<{ id: string; tokens: number }> = [];
  let unmarkedBytes = 0;
  let staleBytes = 0;
  for (const item of snapshot.mapped) {
    if (!item.ref || messageRole(item.message) !== "toolResult") continue;
    if (snapshot.toolProtectedIndices.has(item.index)) continue;
    const size = bytes(item.message);
    staleBytes += size;
    if (claimed.has(objectRefKey(item.ref))) continue;
    unmarkedBytes += size;
    candidates.push({ id: item.ref.entryId, tokens: Math.ceil(size / perToken) });
  }
  candidates.sort((left, right) => right.tokens - left.tokens || (left.id < right.id ? -1 : 1));
  return {
    spans: candidates.length,
    tokens: Math.ceil(unmarkedBytes / perToken),
    share: staleBytes > 0 ? unmarkedBytes / staleBytes : 0,
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
 * Agent judgment leads; automation guarantees the floor. If the marks the agent made
 * would free less than the target share of the window, automation adds the stalest
 * unprotected eligible SPANS until they do: completed tool batches, raw narrative
 * chapters, and, once the stale region carries enough unpinned folds, the placeholders
 * themselves. One law proposes all three, which is what makes chapters and nested folds
 * reachable from the commit path at all.
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
  maxTokens?: number;
}): { state: ActiveContextState; absorbed: AbsorbedWedge[] } {
  const { snapshot } = input;
  const maxTokens = input.maxTokens ?? MAX_WEDGE_ABSORB_TOKENS;
  const charsPerToken = Number.isFinite(input.charsPerToken) && input.charsPerToken > 0
    ? input.charsPerToken
    : ESTIMATED_BYTES_PER_TOKEN;
  const exclude = input.excludeRefKeys ?? new Set<string>();
  let state = input.state;
  const absorbed: AbsorbedWedge[] = [];
  const indexByKey = new Map(snapshot.mapped.flatMap((item) =>
    item.ref ? [[objectRefKey(item.ref), item.index] as const] : []));
  const markInterval = (mark: PendingFoldMark): { start: number; end: number } | null => {
    const indices = candidateSourceRefs(mark.parts, state)
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
      if (gapTokens > maxTokens) continue;
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
  /** Guarded marks the pressure waiver released into this commit, oldest first. */
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
   * How many guarded marks the pressure waiver releases anyway, oldest first. The
   * guard protects an in-flight excursion; it may never cost the session its ability
   * to send a request at all. See `guardWaiverCount`.
   */
  guardWaiver?: number;
}): Promise<CommitEpochResult> {
  const marks = pendingMarks(input.state);
  const retained: PendingMark[] = [];
  const waived: PendingMark[] = [];
  const guardReasons = new Map<string, string>();
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
    // Oldest first: the newest reads are the ones the excursion is about to use, so
    // they are the last evidence the waiver surrenders.
    guarded.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
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
      if (markEligibility(input.snapshot, input.state, mark) === "protected") retained.push(mark);
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
  // Oldest first, then by id: a chapter mark that absorbs an earlier tool-result
  // mark must find that child already folded, which is transcript order.
  const ordered = [...marks].sort((left, right) =>
    left.ordinal - right.ordinal || left.id.localeCompare(right.id));
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
      const sourceRefs = candidateSourceRefs(parts, state);
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
