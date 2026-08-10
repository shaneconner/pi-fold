import type { EvidenceRef } from "../json.ts";
import {
  denseOwnArrayValues,
  objectRefKey,
} from "../json.ts";
import {
  bytes,
  contentText,
  messageRole,
  ownValue,
  usefulBrief,
} from "./canonical.ts";
import {
  exactMapped,
  foldInterval,
  orderedRoots,
  refsInOrder,
  refsProtected,
  toolRefsProtected,
  visibleCollapsedRoots,
} from "./measurement.ts";
import {
  flattenFoldRefs,
  foldMap,
} from "./persistence.ts";
import {
  ACTIVE_CONTEXT_POLICY,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  MAX_FOLD_SPAN_CHARS,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  ActiveFold,
  CompleteTurn,
  FoldCandidate,
  FoldKind,
  FoldPart,
  MappedMessage,
} from "./policy.ts";
import {
  chapterSegments,
  currentTurnBoundary,
  scanTurnToolBatches,
  structurallyClosedChapterUnits,
  terminalAssistant,
} from "./transcript.ts";
import type { ChapterUnit } from "./transcript.ts";

export interface ResultCall {
  id: string;
  name: string;
  batch: string[];
  assistantIndex: number;
}

export const RESULT_CALL_INDEXES = new WeakMap<ActiveContextSnapshot, {
  strict?: Map<number, ResultCall>;
  consumed?: Map<number, ResultCall>;
}>();

export function resultCallIndex(snapshot: ActiveContextSnapshot, allowConsumedIncomplete: boolean): Map<number, ResultCall> {
  const cached = RESULT_CALL_INDEXES.get(snapshot) ?? {};
  const key = allowConsumedIncomplete ? "consumed" : "strict";
  if (cached[key]) return cached[key]!;
  const indexed = new Map<number, ResultCall>();
  const segments: Array<{ turn: CompleteTurn; complete: boolean }> = snapshot.completeTurns.map((turn) => ({
    turn,
    complete: true,
  }));
  if (allowConsumedIncomplete) {
    const completeStarts = new Set(snapshot.completeTurns.map((turn) => turn.start));
    const starts = snapshot.messages.flatMap((message, index) => messageRole(message) === "user" ? [index] : []);
    for (let cursor = 0; cursor < starts.length; cursor += 1) {
      if (completeStarts.has(starts[cursor])) continue;
      segments.push({
        turn: { start: starts[cursor], end: starts[cursor + 1] ?? snapshot.messages.length },
        complete: false,
      });
    }
  }
  segments.sort((left, right) => left.turn.start - right.turn.start);
  for (const { turn, complete } of segments) {
    const validated = scanTurnToolBatches(
      snapshot.messages,
      turn,
      allowConsumedIncomplete,
      snapshot.toolName,
      snapshot.blacklistAutoFoldTools,
      snapshot.readOnlyContextActions,
    );
    if (!validated) continue;
    const batches = new Map<number, string[]>();
    for (const call of validated.calls) {
      const batch = batches.get(call.assistantIndex) ?? [];
      batch.push(call.id);
      batches.set(call.assistantIndex, batch);
    }
    for (const call of validated.calls) {
      if (allowConsumedIncomplete) {
        let laterGenerations = 0;
        for (let index = call.resultIndex + 1; index < turn.end; index += 1) {
          const message = snapshot.messages[index];
          if (messageRole(message) !== "assistant") continue;
          if (ownValue(message, "stopReason") === "toolUse") laterGenerations += 1;
          else if (complete && terminalAssistant(message)) laterGenerations = Math.max(laterGenerations, 1);
        }
        if ((complete && laterGenerations < 1) || (!complete && laterGenerations < 2)) continue;
      }
      indexed.set(call.resultIndex, {
        id: call.id,
        name: call.name,
        assistantIndex: call.assistantIndex,
        batch: batches.get(call.assistantIndex)!,
      });
    }
  }
  cached[key] = indexed;
  RESULT_CALL_INDEXES.set(snapshot, cached);
  return indexed;
}

export function resultCall(
  snapshot: ActiveContextSnapshot,
  resultIndex: number,
  allowConsumedIncomplete = false,
): ResultCall | null {
  return resultCallIndex(snapshot, allowConsumedIncomplete).get(resultIndex) ?? null;
}

export const TOOL_CALL_ARGUMENTS = new WeakMap<ActiveContextSnapshot, Map<number, Map<string, unknown>>>();

export function toolCallArguments(snapshot: ActiveContextSnapshot, assistantIndex: number, id: string): unknown {
  let assistants = TOOL_CALL_ARGUMENTS.get(snapshot);
  if (!assistants) {
    assistants = new Map();
    TOOL_CALL_ARGUMENTS.set(snapshot, assistants);
  }
  let calls = assistants.get(assistantIndex);
  if (!calls) {
    calls = new Map();
    const assistant = snapshot.messages[assistantIndex];
    for (const part of denseOwnArrayValues(ownValue(assistant, "content")) ?? []) {
      if (ownValue(part, "type") !== "toolCall") continue;
      const callId = ownValue(part, "id");
      if (typeof callId === "string" && callId) calls.set(callId, ownValue(part, "arguments"));
    }
    assistants.set(assistantIndex, calls);
  }
  return calls.get(id);
}

/**
 * Anchor budgets for a stage-identified brief. They exist to keep the composed brief
 * inside the hard 1200-character brief cap with the generic prose trimmed away: an
 * argument list, a leading label from the result head, and the result TAIL, which is
 * where a staged chain puts its keys and a report puts its conclusion.
 */
export const IDENTIFIED_BRIEF_ARGUMENT_CHARS = 240;
export const IDENTIFIED_BRIEF_VALUE_CHARS = 96;
export const IDENTIFIED_BRIEF_HEAD_CHARS = 160;
export const IDENTIFIED_BRIEF_TAIL_CHARS = 120;
export const IDENTIFIED_BRIEF_CALLS_CHARS = 400;

/** Every scalar argument of a call, in stable key order, bounded per value and in total. */
export function identifiedCallArguments(
  args: unknown,
  factual: (value: string, maximum: number) => string,
): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const pairs: string[] = [];
  for (const key of Object.keys(args as Record<string, unknown>).sort()) {
    const value = ownValue(args, key);
    const text = typeof value === "string"
      ? value
      : (typeof value === "number" || typeof value === "boolean" ? String(value) : "");
    if (!text.trim()) continue;
    pairs.push(`${factual(key, 40)}=${factual(text, IDENTIFIED_BRIEF_VALUE_CHARS)}`);
  }
  return oneLine(pairs.join(", "), IDENTIFIED_BRIEF_ARGUMENT_CHARS);
}

/** The last characters of a result, which is the region a truncated read never shows. */
export function identifiedResultTail(
  message: unknown,
  factual: (value: string, maximum: number) => string,
): string {
  const text = String(contentText(message) ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return factual(text.slice(Math.max(0, text.length - IDENTIFIED_BRIEF_TAIL_CHARS)), IDENTIFIED_BRIEF_TAIL_CHARS);
}

/**
 * The stage-identified brief. The generic prose is trimmed to a few words so the
 * character budget buys ANCHORS instead: which call this was, with which arguments,
 * what the result opened with, and what it ENDED with. The tail anchor is the point
 * of the whole change: a reader deciding which fold holds a chain key can only tell
 * from the tail, and a generic sentence never carried one.
 */
export function stageIdentifiedToolBrief(input: {
  snapshot: ActiveContextSnapshot;
  refs: EvidenceRef[];
  calls: ResultCall[];
  factualValue: (value: string, maximum: number) => string;
  factualToolName: (name: string) => string;
}): string | null {
  const { snapshot, refs, calls, factualValue, factualToolName } = input;
  const messages = refs.map((ref) => exactMapped(snapshot, ref)?.message ?? null);
  if (messages.some((message) => message === null)) return null;
  const signatures = calls.map((call) => {
    const args = identifiedCallArguments(
      toolCallArguments(snapshot, call.assistantIndex, call.id),
      factualValue,
    );
    return args ? `${factualToolName(call.name)}(${args})` : factualToolName(call.name);
  });
  const label = factualValue(
    String(contentText(messages[0]) ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "",
    IDENTIFIED_BRIEF_HEAD_CHARS,
  );
  const tail = identifiedResultTail(messages.at(-1), factualValue);
  const composed = [
    `Read ${oneLine(signatures.join("; "), IDENTIFIED_BRIEF_CALLS_CHARS)}`,
    label ? `opens "${label}"` : "",
    tail ? `ends "${tail}"` : "",
    calls.length > 1 ? `${calls.length} exact results here` : "exact source here",
  ].filter(Boolean).join(" · ");
  const bounded = oneLine(composed, ACTIVE_CONTEXT_POLICY.maxBriefChars);
  return usefulBrief(bounded, ACTIVE_CONTEXT_POLICY.maxBriefChars, snapshot.toolName) ? bounded : null;
}

/**
 * The fold ids a batch of tool results PEEKED, or null if the batch is not one.
 *
 * A peek result is the one tool output whose bytes the runtime already holds: it is a
 * copy of a fold's own stored source. Reclaiming it therefore has an identity the
 * ordinary tool-fold path does not have, and that identity has to be derivable from the
 * transcript alone, because whichever mechanism claims the copy (the epoch's own
 * reclaim marking or the doorless ladder) the record it leaves behind must still point
 * back at the source.
 */
export function peekedSourceFoldIds(
  snapshot: ActiveContextSnapshot,
  refs: readonly EvidenceRef[],
): string[] | null {
  if (!refs.length) return null;
  const ids: string[] = [];
  for (const ref of refs) {
    const item = exactMapped(snapshot, ref);
    if (!item) return null;
    const call = resultCall(snapshot, item.index, true);
    if (!call || call.name !== snapshot.toolName) return null;
    const args = toolCallArguments(snapshot, call.assistantIndex, call.id);
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const record = args as Record<string, unknown>;
    const id = record.id;
    if (record.action !== "peek" || typeof id !== "string" || !id) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length ? ids : null;
}

/**
 * The brief a reclaimed peek copy leaves behind: a pointer, not a summary.
 *
 * The copy's content is the source fold's content, so summarizing it again would mint
 * a second description of bytes that already have one. What the agent needs from the
 * placeholder is the id it already used once, so re-reading the verbatim content is the
 * same one-hop peek it was before the reclaim.
 */
export function peekReclaimBrief(sourceFoldIds: readonly string[]): string {
  const named = sourceFoldIds.join(", ");
  return sourceFoldIds.length === 1
    ? `Peek copy of fold ${named}, reclaimed: the copy was a duplicate of that fold's own stored ` +
      `source, which stays verbatim and one hop away by peeking ${named} again.`
    : `Peek copies of folds ${named}, reclaimed: the copies duplicated those folds' own stored ` +
      "sources, which stay verbatim and one hop away by peeking each id again.";
}

export function automaticToolBrief(snapshot: ActiveContextSnapshot, candidate: FoldCandidate): string {
  const refs = candidate.kind === "tool-result" && candidate.parts.every((part) => part.kind === "raw")
    ? candidate.parts.map((part) => (part as Extract<FoldPart, { kind: "raw" }>).ref)
    : [];
  const calls = refs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    const call = item ? resultCall(snapshot, item.index, true) : null;
    if (!call) throw new Error("Automatic tool brief lost its validated call");
    return call;
  });
  if (!calls.length || new Set(calls.map((call) => call.assistantIndex)).size !== 1) {
    throw new Error("Automatic tool brief crossed a validated assistant batch");
  }
  const first = calls[0];
  const factualValue = (value: string, maximum: number): string => value
    .replace(new RegExp(snapshot.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "active-context service")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
  const factualBriefValue = (value: string): string => factualValue(value, 120);
  const factualToolName = (name: string): string => name.toLowerCase() === snapshot.toolName.toLowerCase()
    ? "active-context status inspection"
    : factualBriefValue(name);
  const args = toolCallArguments(snapshot, first.assistantIndex, first.id);
  // A peek copy is named by what it copied, before anything else. The stage-identified
  // brief below describes a result by its own head and tail, which for a peek copy is a
  // second description of a fold that already has one; the pointer is what makes the
  // reclaim recoverable, so it comes first and it is derived here rather than at the one
  // call site that happens to know a reclaim is under way.
  const peeked = peekedSourceFoldIds(snapshot, refs);
  if (peeked) return peekReclaimBrief(peeked);
  // Exact anchors before generic prose: one sentence per tool made every fold of that
  // tool carry the SAME brief, so no index could answer which fold holds a given stage.
  const identified = stageIdentifiedToolBrief({ snapshot, refs, calls, factualValue, factualToolName });
  if (identified) return identified;
  const targets: string[] = [];
  for (const key of ["path", "address", "query", "url", "action", "id"]) {
    const value = ownValue(args, key);
    if (typeof value === "string" && value.trim()) targets.push(`${key}=${factualBriefValue(value)}`);
  }
  const target = targets.length ? ` for ${targets.join(", ")}` : "";
  if (calls.length === 1) {
    return `Completed read-only ${factualToolName(first.name)}${target}; its exact stale output remains recoverable from this fold.`;
  }
  const names = [...new Set(calls.map((call) => factualToolName(call.name)))].sort().join("/");
  return `Completed one read-only ${names} batch with ${calls.length} exact results${target}; every stale output remains recoverable from this fold.`;
}

export function deterministicConsolidationBrief(candidate: FoldCandidate, state: ActiveContextState): string {
  const byId = foldMap(state);
  const subjects = candidate.parts.flatMap((part) => {
    if (part.kind !== "fold") return [];
    const child = byId.get(part.foldId);
    return child ? [child.brief.replace(/\s+/g, " ").trim()] : [];
  });
  const text = `Grouped completed context covering: ${subjects.join(" ")}`.replace(/\s+/g, " ").trim();
  if (text.length <= ACTIVE_CONTEXT_POLICY.maxBriefChars) return text;
  let bounded = text.slice(0, ACTIVE_CONTEXT_POLICY.maxBriefChars - 1).trimEnd();
  const finalCode = bounded.charCodeAt(bounded.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) bounded = bounded.slice(0, -1);
  return `${bounded}.`;
}

/**
 * Every fold kind, as a span may contain it.
 *
 * The agent path composes with this set: a mark's span may include folds of any kind and
 * any count, and the fold it commits re-parents them. Automation composes with a NARROWER
 * set, because its own restraint is the counting rule (placeholders are span material
 * only at or above `thresholds.consolidateAfter`), not a rule about shape.
 */
export const ALL_FOLD_KINDS: ReadonlySet<FoldKind> =
  new Set<FoldKind>(["tool-result", "chapter", "consolidation"]);

/** The first pinned fold a span would nest, or null when the span swallows no pin. */
export function pinnedChildFold(
  parts: FoldPart[],
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): ActiveFold | null {
  const byId = foldMap(state);
  for (const part of parts) {
    if (part.kind !== "fold") continue;
    const child = byId.get(part.foldId);
    if (!child) continue;
    const refs = flattenFoldRefs(child, state);
    const pinned = child.kind === "tool-result"
      ? toolRefsProtected(refs, state, snapshot)
      : refsProtected(refs, state, snapshot);
    if (pinned) return child;
  }
  return null;
}

/**
 * The one refusal nesting keeps.
 *
 * A span may take in any fold, so the pin is the sole thing that can stop it, and a pin
 * is a promise to hold bytes raw. Nesting one would put a fold the agent asked to keep
 * visible behind a placeholder, so the span is refused by name with the release valve
 * in it, the same texture the pinned-share cap uses.
 */
export function pinnedNestingRefusal(pinned: ActiveFold, toolName: string): string {
  return `fold refused: ${pinned.id} is pinned, and nesting it would hide context you asked to keep. ` +
    `Release it with ${toolName} {"action":"unprotect","ids":["${pinned.id}"]} first, ` +
    "or name a span that stops at its boundary.";
}

export function partsForRange(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  start: number,
  end: number,
  allowedChildKinds: ReadonlySet<FoldKind>,
): FoldPart[] | null {
  const roots = orderedRoots(state, snapshot);
  for (const root of roots) {
    const overlaps = root.start <= end && start <= root.end;
    if (!overlaps) continue;
    if (root.start < start || root.end > end || !allowedChildKinds.has(root.fold.kind)) return null;
  }
  const childAt = new Map(roots
    .filter((root) => root.start >= start && root.end <= end)
    .map((root) => [root.start, root]));
  const parts: FoldPart[] = [];
  for (let index = start; index <= end;) {
    const child = childAt.get(index);
    if (child) {
      parts.push({ kind: "fold", foldId: child.fold.id });
      index = child.end + 1;
      continue;
    }
    const ref = snapshot.mapped[index]?.ref;
    if (!ref) return null;
    parts.push({ kind: "raw", ref });
    index += 1;
  }
  return parts;
}

export function candidateSourceRefs(parts: FoldPart[], state: ActiveContextState): EvidenceRef[] {
  const byId = foldMap(state);
  return parts.flatMap((part) => {
    if (part.kind === "raw") return [part.ref];
    const child = byId.get(part.foldId);
    if (!child) throw new Error(`Missing candidate child ${part.foldId}`);
    return flattenFoldRefs(child, state);
  });
}

export function chapterUnits(snapshot: ActiveContextSnapshot): ChapterUnit[] {
  return chapterSegments(snapshot.messages)
    .flatMap((segment) => structurallyClosedChapterUnits(snapshot.messages, segment));
}

/**
 * Folds the automatic law may treat as span material.
 *
 * Membership, not position: every visible collapsed root counts unless the agent pinned
 * it or the fresh tail covers it, and an EXPANDED fold is not a placeholder at all. One
 * predicate answers all of it, because that is the same question `refsProtected` already
 * asks of a span's evidence.
 */
export function unpinnedStaleFolds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): Array<{ fold: ActiveFold; start: number; end: number }> {
  return visibleCollapsedRoots(state, snapshot)
    .filter(({ fold }) => !refsProtected(flattenFoldRefs(fold, state), state, snapshot));
}

/** Whether fold placeholders currently count as ordinary material for an automatic span. */
export function foldsAreSpanMaterial(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): boolean {
  return unpinnedStaleFolds(snapshot, state).length >= snapshot.thresholds.consolidateAfter;
}

/**
 * The stalest contiguous run of unpinned folds, read as ONE span.
 *
 * This is not a rung with a trigger of its own: it only ever runs once placeholders are
 * span material, and then it is just the case where the span happens to contain nothing
 * but folds. A tool-result placeholder nests through the chapter span instead, which is
 * where the forest law already allows it.
 */
export function selectAutomaticFoldRun(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): FoldCandidate | null {
  // The counting rule is the whole trigger: below it there is no run to compose.
  if (!foldsAreSpanMaterial(snapshot, state)) return null;
  // A fold's own evidence is claimed BY that fold, so the raw-key claim set every other
  // selector reads says nothing here. What a run must not touch is a fold some pending
  // mark already spoke for, which is a claim on the fold ITSELF.
  const spokenFor = new Set<string>();
  for (const mark of state.pendingMarks ?? []) {
    if (mark.mark === "refold") spokenFor.add(mark.id);
    else for (const part of mark.parts) if (part.kind === "fold") spokenFor.add(part.foldId);
  }
  const roots = unpinnedStaleFolds(snapshot, state).filter(({ fold }) =>
    (fold.kind === "chapter" || fold.kind === "consolidation") && !spokenFor.has(fold.id));
  // No shaping constants: the run is as wide as the transcript makes it, trimmed only by
  // the one bound a fold record has, which is how many exact references it may carry.
  const candidateFor = (selected: typeof roots): FoldCandidate | null => {
    for (let width = selected.length; width >= 2; width -= 1) {
      const parts: FoldPart[] = selected.slice(0, width)
        .map(({ fold }) => ({ kind: "fold", foldId: fold.id }));
      const sourceRefs = candidateSourceRefs(parts, state);
      if (sourceRefs.length <= snapshot.policy.maxFoldSourceRefs) {
        return { kind: "consolidation", parts, sourceRefs };
      }
    }
    return null;
  };
  let run: typeof roots = [];
  for (const root of roots) {
    if (!run.length || root.start === run.at(-1)!.end + 1) {
      run.push(root);
      continue;
    }
    const candidate = candidateFor(run);
    if (candidate) return candidate;
    run = [root];
  }
  return candidateFor(run);
}

/** One completed batch the automatic law may take, with the indices it covers. */
export interface AutomaticToolBatch {
  refs: EvidenceRef[];
  indices: number[];
  bytes: number;
}

/**
 * MEMBERSHIP, WRITTEN ONCE: every completed tool batch the automatic law may take,
 * stalest first, whether or not anything has claimed it yet.
 *
 * A batch is a member when it is complete and validated, its tool is not blacklisted
 * (`resultCall` runs the batch scan with the deployment's list), its evidence carries
 * exact refs in branch order, it is inside the record's reference bound, it is large
 * enough to be worth a placeholder, and neither an agent pin nor the fresh byte tail
 * covers any part of it. There is no position in that list. A prefix of the window is
 * not more foldable than the middle of it, and the middle is not a wall: it is whatever
 * the ladder has not needed yet plus whatever the agent pinned (Shane 2026-08-10).
 *
 * Ownership is deliberately NOT membership. A batch some fold or pending mark already
 * speaks for is still a member of the class; it is simply taken. The selector filters on
 * ownership because it must propose something new, and the announcement counts the class
 * because that is the mass a commit can reach. One definition, two readings of it.
 */
export function automaticToolBatches(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): AutomaticToolBatch[] {
  const groups = new Map<number, Array<{ item: MappedMessage; call: NonNullable<ReturnType<typeof resultCall>> }>>();
  for (const item of snapshot.mapped) {
    if (messageRole(item.message) !== "toolResult") continue;
    const call = resultCall(snapshot, item.index, true);
    if (!call) continue;
    const group = groups.get(call.assistantIndex) ?? [];
    group.push({ item, call });
    groups.set(call.assistantIndex, group);
  }
  const batches: AutomaticToolBatch[] = [];
  for (const group of groups.values()) {
    const expected = group[0].call.batch;
    const ids = new Set(group.map(({ call }) => call.id));
    const refs = group.map(({ item }) => item.ref);
    if (ids.size !== expected.length || expected.some((id) => !ids.has(id)) ||
        refs.some((ref) => !ref || ref.role !== "toolResult")) continue;
    const exactRefs = refs as EvidenceRef[];
    const size = group.reduce((total, { item }) => total + bytes(item.message), 0);
    if (exactRefs.length > snapshot.policy.maxFoldSourceRefs ||
        toolRefsProtected(exactRefs, state, snapshot) || refsInOrder(snapshot, exactRefs) === null ||
        size < snapshot.policy.minToolChars) continue;
    batches.push({ refs: exactRefs, indices: group.map(({ item }) => item.index), bytes: size });
  }
  return batches;
}

/**
 * The stalest member batch nothing has claimed. `claimed` lets a caller exclude evidence
 * already spoken for by something that is not yet a fold (a pending mark), so repeated
 * calls walk forward instead of returning the same batch.
 */
export function selectAutomaticToolBatch(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimed: ReadonlySet<string> = new Set<string>(),
): FoldCandidate[] {
  const owned = new Set([...claimed, ...state.folds.flatMap((fold) => fold.parts.flatMap((part) =>
    part.kind === "raw" ? [objectRefKey(part.ref)] : []))]);
  for (const batch of automaticToolBatches(snapshot, state)) {
    if (batch.refs.some((ref) => owned.has(objectRefKey(ref)))) continue;
    return [{
      kind: "tool-result",
      parts: batch.refs.map((ref) => ({ kind: "raw", ref })),
      sourceRefs: batch.refs,
    }];
  }
  return [];
}

/**
 * The re-fold path.
 *
 * An expansion is a deliberate act, and the way to make it permanent is a pin: a pinned
 * fold is never re-folded, and a leased one is held for the term of its lease. Anything
 * else the agent opened is an ordinary member of the foldable class again, so automation
 * may return it to its placeholder, stalest and narrowest first.
 */
export function selectAutomaticRefold(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimedFoldIds: ReadonlySet<string> = new Set<string>(),
): string | null {
  const candidates = state.expanded.flatMap((id) => {
    if (claimedFoldIds.has(id)) return [];
    const fold = state.folds.find((item) => item.id === id);
    const interval = fold ? foldInterval(fold, state, snapshot) : null;
    const protectedSource = fold && (fold.kind === "tool-result"
      ? toolRefsProtected(flattenFoldRefs(fold, state), state, snapshot)
      : refsProtected(flattenFoldRefs(fold, state), state, snapshot));
    return fold && interval && !protectedSource && !state.leases[id]
      ? [{ id, ...interval }]
      : [];
  }).sort((left, right) => left.end - right.end || (left.end - left.start) - (right.end - right.start));
  return candidates[0]?.id ?? null;
}

export function resolveFoldInputIds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): Array<{ start: number; end: number; fold?: ActiveFold }> {
  if (!ids.length || ids.length > 64 || ids.some((id) => !id)) throw new Error("fold requires 1-64 nonempty ids");
  const values = ids.map((id) => {
    const fold = state.folds.find((item) => item.id === id);
    if (fold) {
      if (fold.parentId !== null) throw new Error(`Fold ${id} is already nested under ${fold.parentId}`);
      const interval = foldInterval(fold, state, snapshot);
      if (!interval) throw new Error(`Fold ${id} is not active in the Pi context event`);
      return { ...interval, fold };
    }
    const item = snapshot.mapped.find((candidate) => candidate.ref?.entryId === id);
    if (!item?.ref) throw new Error(`Unknown active-context source ${id}`);
    return { start: item.index, end: item.index };
  });
  values.sort((left, right) => left.start - right.start);
  return values;
}

export function chapterRangeIsUnitAligned(snapshot: ActiveContextSnapshot, start: number, end: number): boolean {
  const units = chapterUnits(snapshot).filter((unit) => unit.end > start && unit.start <= end);
  if (!units.length || units[0].start !== start || units.at(-1)!.end !== end + 1) return false;
  if (new Set(units.map((unit) => unit.turnStart)).size > snapshot.policy.maxChapterTurns) return false;
  return units.every((unit, index) => index === 0 || unit.start === units[index - 1].end);
}

/**
 * Bite-sized folds.
 *
 * A fold is only navigable if reading one back is cheap. Measured 2026-08-06 (rep 6):
 * one 60,432-byte chapter fold hid the fact the run needed in its tail, and every peek
 * of it was either truncated short of the answer or too expensive to widen. So a span
 * whose content exceeds the cap becomes SEQUENTIAL folds, each with its own brief,
 * split only at structurally closed unit boundaries -- never mid-entry.
 *
 * A single unit that alone exceeds the cap is returned whole: there is no valid
 * interior boundary, and refusing to fold it would leave the biggest span in the
 * window as the one thing nothing may reclaim. The caller reports the split.
 */
export function splitCandidateBySize(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  candidate: FoldCandidate,
  maxChars: number = MAX_FOLD_SPAN_CHARS,
): FoldCandidate[] {
  // A tool-result fold owns exactly one validated assistant batch and a consolidation
  // owns whole child folds; neither has an interior boundary to split on.
  if (candidate.kind !== "chapter") return [candidate];
  const refs = candidate.sourceRefs.length ? candidate.sourceRefs : candidateSourceRefs(candidate.parts, state);
  const indices = refs.map((ref) => exactMapped(snapshot, ref)?.index ?? -1);
  if (!indices.length || indices.some((index) => index < 0)) return [candidate];
  const start = Math.min(...indices);
  const end = Math.max(...indices);
  if (spanBytes(snapshot, start, end + 1) <= maxChars) return [candidate];
  const units = chapterUnits(snapshot).filter((unit) => unit.start >= start && unit.end <= end + 1);
  if (units.length < 2) return [candidate];
  const split: FoldCandidate[] = [];
  const emit = (from: number, to: number): boolean => {
    const parts = partsForRange(snapshot, state, from, to, new Set<FoldKind>(["tool-result"]));
    if (!parts) return false;
    split.push({ kind: "chapter", parts, sourceRefs: candidateSourceRefs(parts, state) });
    return true;
  };
  let runStart = units[0].start;
  let runBytes = 0;
  for (const unit of units) {
    const size = spanBytes(snapshot, unit.start, unit.end);
    if (runBytes > 0 && runBytes + size > maxChars) {
      if (!emit(runStart, unit.start - 1)) return [candidate];
      runStart = unit.start;
      runBytes = 0;
    }
    runBytes += size;
  }
  if (runBytes > 0 && !emit(runStart, units.at(-1)!.end - 1)) return [candidate];
  return split.length ? split : [candidate];
}

/** Exact serialized size of a candidate's whole span, folds and raw entries alike. */
export function candidateSpanChars(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  candidate: FoldCandidate,
): number {
  const refs = candidate.sourceRefs.length ? candidate.sourceRefs : candidateSourceRefs(candidate.parts, state);
  const indices = refs.map((ref) => exactMapped(snapshot, ref)?.index ?? -1).filter((index) => index >= 0);
  if (!indices.length) return 0;
  return spanBytes(snapshot, Math.min(...indices), Math.max(...indices) + 1);
}

/** Exact serialized size of a half-open mapped message range. */
export function spanBytes(snapshot: ActiveContextSnapshot, start: number, end: number): number {
  return bytes(snapshot.messages.slice(start, end));
}

/** One auto-snap the runtime applied to a requested span, reported never inferred. */
export interface SpanCorrection {
  from: string[];
  to: string[];
  reason: string;
}

export interface SnappedFoldSpan {
  candidate: FoldCandidate;
  corrections: SpanCorrection[];
}

/**
 * Resolve a requested span, correcting it where a correction exists.
 *
 * A span the agent got slightly wrong -- crossing a fold it forgot about, reaching
 * into the turn still in flight, landing mid-unit -- is a span it MEANT, and refusing
 * it teaches the agent that curating is a coin flip. So an invalid span SNAPS to the
 * nearest valid edge and the correction is stated in the result. Rejection is reserved
 * for a request with no valid interpretation at all, and it says exactly what failed.
 */
export function snapFoldCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  options: { allowProtected?: boolean } = {},
): SnappedFoldSpan {
  let directError: Error;
  try {
    return { candidate: manualFoldCandidate(snapshot, state, ids, options), corrections: [] };
  } catch (error) {
    directError = error instanceof Error ? error : new Error(String(error));
  }
  // Nearest first, then the other readings of the same intent. A span that cuts into one
  // fold has exactly two endpoint corrections -- absorb it, or step past it -- and which
  // one survives depends on structure the caller cannot see. A whole fold left inside the
  // corrected span is no longer a reason to fail: the span nests it. What still fails is
  // a span with no valid frame at all, and a pin the span would swallow.
  const alternatives = snapSpanAlternatives(snapshot, state, ids);
  let lastError: Error = directError;
  for (const snapped of alternatives) {
    try {
      return {
        candidate: manualFoldCandidate(snapshot, state, snapped.ids, options),
        corrections: snapped.corrections,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  // A suggestion the caller cannot act on is worse than no suggestion: never name a
  // "nearest valid span" this same validation just refused. Nothing snapped, so the
  // refusal is the direct one, stated once.
  throw new Error(
    `${directError.message}. No corrected reading of that span is constructible`,
    { cause: lastError },
  );
}

/**
 * Every constructible reading of a requested span, nearest intent first.
 *
 * The three endpoint modes move the EDGES; the fourth reading moves the FRAME, reading
 * the span as the whole folds it cuts into. The frame reading survives the nesting law
 * because it is still the faithful one where the endpoints cannot snap to closed units:
 * the folds themselves already tile the range exactly.
 */
export function snapSpanAlternatives(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): Array<{ ids: string[]; corrections: SpanCorrection[] }> {
  const seen = new Set<string>();
  const readings = [
    ...(["nearest", "exclude", "absorb"] as const)
      .map((mode) => snapSpanIds(snapshot, state, ids, mode)),
    snapSpanToWholeFolds(snapshot, state, ids),
  ];
  return readings.flatMap((snapped) => {
    if (!snapped) return [];
    const key = snapped.ids.join("\u0000");
    if (seen.has(key)) return [];
    seen.add(key);
    return [snapped];
  });
}

/**
 * The requested span read as the whole folds it cuts into.
 *
 * Constructible only when the outward snap lands on a contiguous tiling of two or more
 * foldable roots: then the span the agent named IS those folds, and consolidating them
 * is the one reading that both covers what was asked for and validates.
 */
export function snapSpanToWholeFolds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): { ids: string[]; corrections: SpanCorrection[] } | null {
  let outward: ReturnType<typeof snapToFoldBoundaries>;
  try { outward = snapToFoldBoundaries(snapshot, state, ids); }
  catch { return null; }
  if (!outward.corrections.length) return null;
  const tiling = orderedRoots(state, snapshot)
    .filter((root) => root.start >= outward.start && root.end <= outward.end);
  if (tiling.length < 2) return null;
  if (tiling[0].start !== outward.start || tiling.at(-1)!.end !== outward.end) return null;
  if (tiling.some((root, index) => index > 0 && root.start !== tiling[index - 1].end + 1)) return null;
  if (tiling.some((root) => root.fold.kind === "tool-result")) return null;
  return {
    ids: tiling.map((root) => root.fold.id),
    corrections: [{
      ...outward.corrections[0],
      reason: `span cut into ${tiling.length} folds; corrected outward to their whole ` +
        `boundaries and read as a consolidation of ${tiling.map((root) => root.fold.id).join(", ")}`,
    }],
  };
}

/**
 * The correction itself: pull the endpoints out of any fold they cut through, out of
 * the turn still in flight, and onto structurally closed unit boundaries.
 */
export function snapSpanIds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  /** How an endpoint inside a fold is read: by distance, or always one way. */
  mode: "nearest" | "absorb" | "exclude" = "nearest",
): { ids: string[]; corrections: SpanCorrection[] } | null {
  let resolved: Array<{ start: number; end: number; fold?: ActiveFold }>;
  // An unknown id has no nearest valid edge: there is nothing to snap TO.
  try { resolved = resolveFoldInputIds(snapshot, state, ids); }
  catch { return null; }
  const requested = [resolved[0].start, resolved.at(-1)!.end] as [number, number];
  let [start, end] = requested;
  const corrections: SpanCorrection[] = [];
  const note = (reason: string): void => {
    corrections.push({
      from: [entryIdAt(snapshot, requested[0]), entryIdAt(snapshot, requested[1])],
      to: [entryIdAt(snapshot, start), entryIdAt(snapshot, end)],
      reason,
    });
  };
  const units = chapterUnits(snapshot);
  // Each correction can undo another: pulling an endpoint onto a unit boundary can put
  // it back inside a fold, and clamping the width can cut one in half. So the passes run
  // to a FIXED POINT rather than once each. After the first pass an endpoint inside a
  // fold always absorbs it, which is outward and therefore terminating: stepping past a
  // fold here would drop material the agent named, and nesting no longer loses anything.
  for (let pass = 0; pass < state.folds.length + 2; pass += 1) {
    const passStart = start;
    const passEnd = end;
    for (const root of orderedRoots(state, snapshot)) {
      if (start > root.start && start <= root.end) {
        const absorb = pass > 0 || mode === "absorb" ||
          (mode === "nearest" && start - root.start <= root.end + 1 - start);
        start = absorb ? root.start : root.end + 1;
        note(`span started inside ${root.fold.id}; corrected to its ` +
          `${absorb ? "start" : "far"} boundary`);
      }
      if (end >= root.start && end < root.end) {
        const absorb = pass > 0 || mode === "absorb" ||
          (mode === "nearest" && root.end - end <= end - (root.start - 1));
        end = absorb ? root.end : root.start - 1;
        note(`span ended inside ${root.fold.id}; corrected to its ` +
          `${absorb ? "end" : "near"} boundary`);
      }
    }
    const boundary = currentTurnBoundary(snapshot);
    if (boundary >= 0 && end > boundary) {
      end = boundary;
      note("span reached into the turn still in flight; corrected back to the last closed turn");
    }
    const startUnit = units.find((unit) => start >= unit.start && start < unit.end);
    if (startUnit && startUnit.start !== start) {
      start = startUnit.start;
      note("span started mid-unit; corrected to the start of its closed user/assistant/tool unit");
    }
    const endUnit = units.find((unit) => end >= unit.start && end < unit.end);
    if (endUnit && endUnit.end - 1 !== end) {
      end = endUnit.end - 1;
      note("span ended mid-unit; corrected to the end of its closed user/assistant/tool unit");
    }
    // A chapter spans at most a few closed turns. A longer request is a span the agent
    // meant, so it is CLAMPED to what one fold may hold rather than refused; the
    // remainder stays raw and is the agent's to fold next.
    const covered = units.filter((unit) => unit.start >= start && unit.end <= end + 1);
    if (covered.length) {
      const turns: number[] = [];
      let clamped = end;
      for (const unit of covered) {
        if (!turns.includes(unit.turnStart)) {
          if (turns.length >= snapshot.policy.maxChapterTurns) break;
          turns.push(unit.turnStart);
        }
        clamped = unit.end - 1;
      }
      if (clamped < end) {
        end = clamped;
        note(`span covered more than the ${snapshot.policy.maxChapterTurns}-turn chapter limit; ` +
          "corrected to the last turn that fits");
      }
    }
    if (start === passStart && end === passEnd) break;
  }
  if (!corrections.length || end < start ||
      !snapshot.mapped[start]?.ref || !snapshot.mapped[end]?.ref) return null;
  return { ids: [entryIdAt(snapshot, start), entryIdAt(snapshot, end)], corrections };
}

/**
 * Snap a span OUTWARD to whole-fold boundaries.
 *
 * The re-boundary verb operates on folds, so a span that cuts one in half has exactly
 * one sane reading: the agent meant that fold. Outward rather than nearest, because
 * losing a fold the agent did not name is the surprising outcome and re-cutting a
 * slightly larger span is not.
 */
export function snapToFoldBoundaries(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): { start: number; end: number; ids: string[]; covered: ActiveFold[]; corrections: SpanCorrection[] } {
  const resolved = resolveFoldInputIds(snapshot, state, ids);
  const requested: [number, number] = [resolved[0].start, resolved.at(-1)!.end];
  let [start, end] = requested;
  const corrections: SpanCorrection[] = [];
  // Fixed point: absorbing one fold can pull the span across the next.
  for (let pass = 0; pass < state.folds.length + 1; pass += 1) {
    let moved = false;
    for (const root of orderedRoots(state, snapshot)) {
      if (root.end < start || root.start > end) continue;
      if (root.start < start) { start = root.start; moved = true; }
      if (root.end > end) { end = root.end; moved = true; }
    }
    if (!moved) break;
  }
  if (start !== requested[0] || end !== requested[1]) {
    corrections.push({
      from: [entryIdAt(snapshot, requested[0]), entryIdAt(snapshot, requested[1])],
      to: [entryIdAt(snapshot, start), entryIdAt(snapshot, end)],
      reason: "span partially covered one or more folds; corrected outward to their whole boundaries",
    });
  }
  const covered = orderedRoots(state, snapshot)
    .filter((root) => root.start >= start && root.end <= end)
    .map((root) => root.fold);
  return { start, end, ids: [entryIdAt(snapshot, start), entryIdAt(snapshot, end)], covered, corrections };
}

export function entryIdAt(snapshot: ActiveContextSnapshot, index: number): string {
  return snapshot.mapped[index]?.ref?.entryId ?? `position-${index}`;
}

export function manualFoldCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  /**
   * Accept a span that is still fresh or protected. Only a caller that will DEFER the
   * fold may pass this: it relaxes eligibility, never structure, so contiguity, unit
   * alignment and batch completeness are still enforced and the commit still refuses
   * to apply a mark whose span is protected at commit time.
   */
  options: { allowProtected?: boolean } = {},
): FoldCandidate {
  const blockedTool = (refs: EvidenceRef[]): boolean =>
    !options.allowProtected && toolRefsProtected(refs, state, snapshot);
  const blocked = (refs: EvidenceRef[]): boolean =>
    !options.allowProtected && refsProtected(refs, state, snapshot);
  const bounded = (candidate: FoldCandidate): FoldCandidate => {
    if (candidate.sourceRefs.length > snapshot.policy.maxFoldSourceRefs) {
      throw new Error(`Folds may include at most ${snapshot.policy.maxFoldSourceRefs} exact source references`);
    }
    return candidate;
  };
  const selected = resolveFoldInputIds(snapshot, state, ids);
  const start = selected[0].start;
  const end = selected.at(-1)!.end;
  const one = selected.length === 1 ? selected[0] : null;
  if (selected.every((item) => !item.fold && snapshot.mapped[item.start].ref?.role === "toolResult")) {
    const refs = selected.map((item) => snapshot.mapped[item.start].ref!);
    const calls = selected.map((item) => resultCall(snapshot, item.start, true));
    const first = calls[0];
    const completeBatch = first && calls.every((call) => call && call.assistantIndex === first.assistantIndex) &&
      calls.length === first.batch.length &&
      new Set(calls.map((call) => call!.id)).size === first.batch.length &&
      first.batch.every((id) => calls.some((call) => call!.id === id));
    if (completeBatch && !blockedTool(refs)) {
      return bounded({ kind: "tool-result", parts: refs.map((ref) => ({ kind: "raw", ref })), sourceRefs: refs });
    }
    if (one && first && first.batch.length === 1 && !blockedTool(refs)) {
      return bounded({ kind: "tool-result", parts: [{ kind: "raw", ref: refs[0] }], sourceRefs: refs });
    }
  }
  const exactFolds = selected.every((item) => item.fold && item.fold.kind !== "tool-result") &&
    selected.every((item, index) => index === 0 || item.start === selected[index - 1].end + 1);
  if (exactFolds && selected.length >= 2) {
    const parts: FoldPart[] = selected.map((item) => ({ kind: "fold", foldId: item.fold!.id }));
    const refs = candidateSourceRefs(parts, state);
    const pinnedChild = pinnedChildFold(parts, state, snapshot);
    if (pinnedChild) throw new Error(pinnedNestingRefusal(pinnedChild, snapshot.toolName));
    if (blocked(refs)) throw new Error("Manual consolidation contains protected evidence");
    return bounded({ kind: "consolidation", parts, sourceRefs: refs });
  }
  if (!chapterRangeIsUnitAligned(snapshot, start, end)) {
    throw new Error("Chapter folds must align to a contiguous structurally closed user/assistant/tool-batch range");
  }
  const parts = partsForRange(snapshot, state, start, end, ALL_FOLD_KINDS);
  if (!parts) {
    // Two shapes reach here, and they are different asks. A span INSIDE one fold is
    // material that is already folded, so there is no fold to make and the useful answer
    // names the fold holding it. A span that merely cuts one is a boundary the snap
    // corrects, and it says which fold moved the edge.
    const cut = orderedRoots(state, snapshot).filter((root) => root.start <= end && start <= root.end);
    const container = cut.find((root) => root.start <= start && root.end >= end);
    throw new Error(container
      ? `That span is already folded inside ${container.fold.id}; peek or expand ${container.fold.id} instead`
      : `Fold span partially overlaps ${cut.map((root) => root.fold.id).join(", ")}`);
  }
  const swallowedPin = pinnedChildFold(parts, state, snapshot);
  if (swallowedPin) throw new Error(pinnedNestingRefusal(swallowedPin, snapshot.toolName));
  const refs = candidateSourceRefs(parts, state);
  if (blocked(refs)) throw new Error("Manual chapter contains fresh, unfinished, unmatched, unmapped, or protected evidence");
  return bounded({ kind: "chapter", parts, sourceRefs: refs });
}

export function oneLine(value: string, maximum: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  let bounded = text.slice(0, maximum).trimEnd();
  const finalCode = bounded.charCodeAt(bounded.length - 1);
  if (finalCode >= 0xd800 && finalCode <= 0xdbff) bounded = bounded.slice(0, -1);
  return bounded;
}

export function deterministicChapterBrief(
  refs: EvidenceRef[],
  messages: unknown[],
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
): string {
  if (refs.length !== messages.length || !refs.length) {
    throw new Error("Deterministic chapter brief requires aligned exact evidence");
  }
  const firstUser = messages.find((message) => messageRole(message) === "user");
  const firstAssistant = messages.find((message) =>
    messageRole(message) === "assistant" && contentText(message).trim());
  const toolCounts = new Map<string, number>();
  for (const message of messages) {
    if (messageRole(message) !== "assistant") continue;
    for (const part of denseOwnArrayValues(ownValue(message, "content")) ?? []) {
      if (ownValue(part, "type") !== "toolCall") continue;
      const name = ownValue(part, "name");
      if (typeof name === "string" && name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }
  const ask = oneLine(firstUser ? contentText(firstUser) : "No user ask in this span", 90);
  const assistant = oneLine(firstAssistant ? contentText(firstAssistant).split(/\r?\n/)[0] :
    "No assistant text in this span", 110);
  const tools = oneLine([...toolCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${count}×${name}`)
    .join(" ") || "no tools", 500);
  const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const composed = `User: ${ask} · Tools: ${tools} · Assistant: ${assistant}`
    .replace(new RegExp(escapeName(toolName), "gi"), "active-context service");
  if (usefulBrief(composed, ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName)) return composed;
  // Constant floor-of-the-floor: provably passes usefulBrief (no tool name, no structural pattern).
  return `Folded ${refs.length} exact messages from this span's complete turns.`;
}

export function deterministicChapterCandidateBrief(
  snapshot: ActiveContextSnapshot,
  candidate: FoldCandidate,
): string {
  const messages = candidate.sourceRefs.map((ref) => {
    const item = exactMapped(snapshot, ref);
    if (!item) throw new Error(`Exact Pi evidence drift for ${ref.entryId}`);
    return item.message;
  });
  return deterministicChapterBrief(candidate.sourceRefs, messages, snapshot.toolName);
}
