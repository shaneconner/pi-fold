import { objectRefKey } from "../json.ts";
import {
  bytes,
  clone,
  messageRole,
} from "./canonical.ts";
import {
  commitPreparedFold,
  prepareFold,
  renderFold,
  renderFoldParts,
  setFoldProjectionState,
} from "./folding.ts";
import type { AutomaticRungSelection } from "./folding.ts";
import {
  foldInterval,
  refsProtected,
  toolRefsProtected,
} from "./measurement.ts";
import {
  flattenFoldRefs,
  foldIdFor,
  parsePendingMarks,
  pendingMarkKey,
} from "./persistence.ts";
import { terminalAssistant } from "./transcript.ts";
import {
  EPOCH_COMMIT_TARGET_WINDOW_SHARE,
  EPOCH_MAX_TOPUP_MARKS,
  EPOCH_TAIL_ADJACENT_MESSAGES,
  ESTIMATED_BYTES_PER_TOKEN,
  ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES,
  MAX_PENDING_MARKS,
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
  deterministicChapterCandidateBrief,
  deterministicConsolidationBrief,
  resultCall,
  selectAutomaticToolBatch,
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
 * Property ORDER is load-bearing: the state digest is a stable stringify, so an
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
 * A fold whose span BEGINS this close to the tail invalidates almost nothing, so it
 * applies immediately even in epoch mode. The measurement is the FIRST mapped source
 * index, not the last: a positional prefix cache is invalidated from the earliest
 * byte the rewrite touches, so a span reaching back from the tail is as expensive as
 * its oldest ref. Deterministic in mapped positions.
 */
export function tailAdjacent(
  snapshot: ActiveContextSnapshot,
  candidate: FoldCandidate,
  state: ActiveContextState,
): boolean {
  const refs = candidate.sourceRefs.length ? candidate.sourceRefs : candidateSourceRefs(candidate.parts, state);
  const indexByKey = new Map(snapshot.mapped.flatMap((item) =>
    item.ref ? [[objectRefKey(item.ref), item.index] as const] : []));
  let first = -1;
  for (const ref of refs) {
    const index = indexByKey.get(objectRefKey(ref));
    if (index === undefined) return false;
    if (first < 0 || index < first) first = index;
  }
  return first >= 0 && snapshot.mapped.length - 1 - first <= EPOCH_TAIL_ADJACENT_MESSAGES;
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
 * The evidence boundary of the CURRENT turn: the position of the last terminal
 * assistant message. Everything after it was gathered by the excursion still in
 * progress, which is exactly the evidence a commit must not fold.
 *
 * Measured 2026-08-06 (rep 8): nineteen folds landed between the last read result and
 * the agent's next reply, rewriting the projection from 938k to 487k chars, so the
 * agent answered from a window where its own just-gathered evidence had become
 * placeholders. Freshness in bytes did not catch it; the boundary is a TURN.
 */
export function currentTurnBoundary(snapshot: Pick<ActiveContextSnapshot, "messages">): number {
  let boundary = -1;
  for (let index = 0; index < snapshot.messages.length; index += 1) {
    if (terminalAssistant(snapshot.messages[index])) boundary = index;
  }
  return boundary;
}

/** Every tool-result evidence key produced since that boundary. */
export function currentTurnRefKeys(snapshot: ActiveContextSnapshot): Set<string> {
  const boundary = currentTurnBoundary(snapshot);
  const keys = new Set<string>();
  for (const item of snapshot.mapped) {
    if (item.index <= boundary || !item.ref) continue;
    if (messageRole(item.message) !== "toolResult") continue;
    keys.add(objectRefKey(item.ref));
  }
  return keys;
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
  freedWindowShare: number;
  rewriteTokens: number;
  /** Marks a commit could apply right now. */
  eligibleMarks: number;
  /** Marks whose span is still fresh or protected, waiting rather than lost. */
  retainedMarks: number;
  eligibleFreedBytes: number;
  eligibleFreedTokens: number;
  /** The ROI signal: eligible marked mass as a share of the truthful window. */
  eligibleFreedWindowShare: number;
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
  return {
    pending: marks.length,
    agentMarks: marks.filter((mark) => mark.origin === "agent").length,
    ladderMarks: marks.filter((mark) => mark.origin === "ladder").length,
    freedBytes,
    freedTokens,
    freedWindowShare: snapshot.contextWindow > 0 ? freedTokens / snapshot.contextWindow : 0,
    rewriteTokens: estimatedTokens(rewriteBytes),
    eligibleMarks,
    retainedMarks,
    eligibleFreedBytes,
    eligibleFreedTokens,
    eligibleFreedWindowShare: snapshot.contextWindow > 0
      ? eligibleFreedTokens / snapshot.contextWindow
      : 0,
  };
}

export interface CommitTriggerOptions {
  /**
   * Eligible marked mass, as a share of the truthful window, at which a commit is
   * worth its one rewrite. Null keeps the pressure trigger as the only trigger.
   */
  eligibleShareThreshold?: number | null;
  eligibleShare?: number | null;
}

/**
 * The commit trigger.
 *
 * The pressure trigger reuses the ladder's own refold threshold: below it the ladder
 * only marks, at it the accumulated marks become a single rewrite. That is a SAFETY
 * property, not an economic one -- it fires when the window is nearly full, which is
 * the worst moment to discover the marks are worth nothing. The rep4 abort fired at
 * that threshold with pending marks at zero and nothing to free.
 *
 * The ROI trigger asks the economic question instead: commit when the marks that
 * could apply RIGHT NOW would free enough to pay for the rewrite. Pressure stays as
 * the backstop underneath it, and the agent's own commit is always authoritative and
 * immediate regardless of either.
 */
export function epochCommitDue(
  snapshot: ActiveContextSnapshot,
  ratio: number | null,
  options: CommitTriggerOptions = {},
): boolean {
  const { eligibleShareThreshold, eligibleShare } = options;
  if (typeof eligibleShareThreshold === "number" && Number.isFinite(eligibleShareThreshold) &&
      typeof eligibleShare === "number" && Number.isFinite(eligibleShare) &&
      eligibleShare >= eligibleShareThreshold) return true;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= snapshot.policy.refoldRatio;
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
    brief: ladderBrief(input.snapshot, input.state, selection.candidate),
    briefProvenance: { kind: "deterministic" },
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

/** Every fold id already spoken for by a pending refold mark. */
export function markedFoldIds(state: ActiveContextState): Set<string> {
  const ids = new Set<string>();
  for (const mark of pendingMarks(state)) if (mark.mark === "refold") ids.add(mark.id);
  return ids;
}

/**
 * Agent judgment leads; automation guarantees the floor. If the marks the agent
 * made would free less than the target share of the window, the ladder adds the
 * stalest unprotected eligible tool batches until they do.
 */
export function topUpMarks(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  ordinal: number;
  targetShare?: number;
  /** Evidence keys the top-up may never propose, e.g. the current excursion's reads. */
  excludeRefKeys?: ReadonlySet<string>;
  /** Measure progress against ELIGIBLE mass, so pinned or protected marks never count. */
  eligibleOnly?: boolean;
}): PendingFoldMark[] {
  const { snapshot } = input;
  const target = input.targetShare ?? EPOCH_COMMIT_TARGET_WINDOW_SHARE;
  const claimed = claimedRefKeys(input.state);
  for (const key of input.excludeRefKeys ?? []) claimed.add(key);
  const marks: PendingFoldMark[] = [];
  let state = input.state;
  const progress = (value: ActiveContextState): number => {
    const accounting = markAccounting(snapshot, value);
    return input.eligibleOnly ? accounting.eligibleFreedWindowShare : accounting.freedWindowShare;
  };
  let share = progress(state);
  for (let attempt = 0; attempt < EPOCH_MAX_TOPUP_MARKS && share < target; attempt += 1) {
    const candidate = selectAutomaticToolBatch(snapshot, state, 1, claimed)[0];
    if (!candidate) break;
    const mark = foldMarkFor({
      candidate,
      brief: automaticToolBrief(snapshot, candidate),
      briefProvenance: { kind: "deterministic" },
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
}): Promise<CommitEpochResult> {
  const marks = pendingMarks(input.state);
  const retained: PendingMark[] = [];
  const guardReasons = new Map<string, string>();
  const currentTurn = input.guardCurrentTurn
    ? currentTurnRefKeys(input.snapshot)
    : new Set<string>();
  if (input.guardCurrentTurn) {
    const applicable: PendingMark[] = [];
    for (const mark of marks) {
      if (markTouchesCurrentTurn(input.state, mark, currentTurn)) {
        retained.push(mark);
        guardReasons.set(
          pendingMarkKey(mark),
          "evidence was gathered in the current turn; the mark stays pending until the turn closes",
        );
      } else applicable.push(mark);
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
  return { state, applied, refused, retained };
}

/** The scheduling block reported by the status action. */
export function schedulingStatus(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  mode: string;
  ratio: number | null;
  eligibleShareThreshold?: number | null;
}): Record<string, unknown> {
  const accounting = markAccounting(input.snapshot, input.state);
  const threshold = input.eligibleShareThreshold ?? null;
  return {
    mode: input.mode,
    ...accounting,
    targetWindowShare: EPOCH_COMMIT_TARGET_WINDOW_SHARE,
    tailAdjacentMessages: EPOCH_TAIL_ADJACENT_MESSAGES,
    commitDue: epochCommitDue(input.snapshot, input.ratio, {
      eligibleShareThreshold: threshold,
      eligibleShare: accounting.eligibleFreedWindowShare,
    }),
    commitTrigger: {
      mode: threshold === null ? "pressure" : "eligible-share",
      eligibleShareThreshold: threshold,
      eligibleShare: accounting.eligibleFreedWindowShare,
      backstopRatio: input.snapshot.policy.refoldRatio,
      pressureDue: epochCommitDue(input.snapshot, input.ratio),
      roiDue: threshold !== null && accounting.eligibleFreedWindowShare >= threshold,
    },
    commitRatio: input.snapshot.policy.refoldRatio,
    marks: pendingMarks(input.state).map((mark) => ({
      mark: mark.mark,
      id: mark.id,
      origin: mark.origin,
      ordinal: mark.ordinal,
      eligibility: markEligibility(input.snapshot, input.state, mark),
      ...(mark.mark === "fold" ? { kind: mark.kind, brief: mark.brief } : {}),
    })),
    actions: { commit: { action: "commit" } },
  };
}
