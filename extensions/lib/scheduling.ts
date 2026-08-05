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

export interface MarkAccounting {
  pending: number;
  agentMarks: number;
  ladderMarks: number;
  freedBytes: number;
  freedTokens: number;
  freedWindowShare: number;
  rewriteTokens: number;
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
  let earliest = -1;
  for (const mark of marks) {
    freedBytes += markFreedBytes(snapshot, state, mark);
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
  return {
    pending: marks.length,
    agentMarks: marks.filter((mark) => mark.origin === "agent").length,
    ladderMarks: marks.filter((mark) => mark.origin === "ladder").length,
    freedBytes,
    freedTokens,
    freedWindowShare: snapshot.contextWindow > 0 ? freedTokens / snapshot.contextWindow : 0,
    rewriteTokens: estimatedTokens(rewriteBytes),
  };
}

/**
 * The commit trigger. It deliberately reuses the ladder's own refold/consolidation
 * threshold instead of inventing one: below it the ladder only marks, at it the
 * accumulated marks become a single rewrite, and the hard provider fence is above it.
 */
export function epochCommitDue(snapshot: ActiveContextSnapshot, ratio: number | null): boolean {
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
      origin: "ladder",
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
}): PendingFoldMark[] {
  const { snapshot } = input;
  const target = input.targetShare ?? EPOCH_COMMIT_TARGET_WINDOW_SHARE;
  const claimed = claimedRefKeys(input.state);
  const marks: PendingFoldMark[] = [];
  let state = input.state;
  let share = markAccounting(snapshot, state).freedWindowShare;
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
    share = markAccounting(snapshot, state).freedWindowShare;
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
}

export interface CommitEpochResult {
  state: ActiveContextState;
  applied: AppliedMark[];
  refused: RefusedMark[];
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
}): Promise<CommitEpochResult> {
  const marks = pendingMarks(input.state);
  let state = withPendingMarks(input.state, []);
  const applied: AppliedMark[] = [];
  const refused: RefusedMark[] = [];
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
      });
    }
  }
  return { state, applied, refused };
}

/** The scheduling block reported by the status action. */
export function schedulingStatus(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  mode: string;
  ratio: number | null;
}): Record<string, unknown> {
  const accounting = markAccounting(input.snapshot, input.state);
  return {
    mode: input.mode,
    ...accounting,
    targetWindowShare: EPOCH_COMMIT_TARGET_WINDOW_SHARE,
    tailAdjacentMessages: EPOCH_TAIL_ADJACENT_MESSAGES,
    commitDue: epochCommitDue(input.snapshot, input.ratio),
    commitRatio: input.snapshot.policy.refoldRatio,
    marks: pendingMarks(input.state).map((mark) => ({
      mark: mark.mark,
      id: mark.id,
      origin: mark.origin,
      ordinal: mark.ordinal,
      ...(mark.mark === "fold" ? { kind: mark.kind, brief: mark.brief } : {}),
    })),
    actions: { commit: { action: "commit" } },
  };
}
