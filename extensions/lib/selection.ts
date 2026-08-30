import type { EvidenceRef } from "../json.ts";
import { boundedSubject, oneLine, seatSubjects, toolClipHead } from "./brief-text.ts";
export { oneLine, seatSubjects, toolClipHead };
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
  visibleCollapsedRoots,
} from "./measurement.ts";
import {
  directFoldOwners,
  flattenFoldRefs,
  foldBrief,
  foldMap,
} from "./persistence.ts";
import {
  ACTIVE_CONTEXT_POLICY,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
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
  scanTurnToolBatches,
  structurallyClosedChapterUnits,
  deadAssistant,
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
          // A dead turn's own terminal grants the point a finished turn's does: the turn
          // is only in completeTurns because a user message already stands after it, so
          // no later response will ever consume this batch, and demanding one anyway is
          // the hold that deadlocked sol-20260826-full2 (the 423KB peek copy behind an
          // errored assistant, ineligible for thirty-five aborting passes).
          else if (complete && (terminalAssistant(message) || deadAssistant(message))) {
            laterGenerations = Math.max(laterGenerations, 1);
          }
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

export const IDENTIFIED_BRIEF_ARGUMENT_CHARS = 240;
export const IDENTIFIED_BRIEF_VALUE_CHARS = 96;
// A composed stage-identified brief is held to the ONE policy cap, maxBriefChars
// (Shane 2026-08-14: "2k brief is more appropriate"). The head keeps the
// result's leading paragraph and gets exactly what remains of the cap after the
// parts that identify the fold (call signatures, tail anchor, fixed text), so
// the paragraph takes every character the contract can give it. The 1,100
// sub-cap this replaced held 100 below a separate 1,200 supplied maximum as
// headroom for commit-time gap absorption's appended sentence; the absorption
// eligibility law (gate 136) removed that hazard, and both smaller numbers went
// with it. Gate 134 pins the paragraph surviving.
// The head bound for a result with NO terminated opening paragraph: its first
// line, exactly the pre-paragraph behaviour.
export const IDENTIFIED_BRIEF_HEAD_CHARS = 160;
export const IDENTIFIED_BRIEF_TAIL_CHARS = 120;
export const IDENTIFIED_BRIEF_CALLS_CHARS = 400;

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

export function identifiedResultTail(
  message: unknown,
  factual: (value: string, maximum: number) => string,
): string {
  const text = String(contentText(message) ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return factual(text.slice(Math.max(0, text.length - IDENTIFIED_BRIEF_TAIL_CHARS)), IDENTIFIED_BRIEF_TAIL_CHARS);
}

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
  // THE LEADING PARAGRAPH, not the first line (Shane 2026-08-14). A tool result
  // that opens with a header line and then states, in prose, what the caller must
  // do or know had everything after that header dropped: the head kept ONE line
  // and the header was it. sol-20260814-traps rep 1 is what that costs. A stage
  // result opens "STAGE 09 / read" and carries its audit note, including a code
  // word and a correction WITHDRAWING an earlier one, on the next line. The fold
  // committed at entry 121 with a head of "STAGE 09 / read", the model brief that
  // did carry both facts landed at entry 311, and the answer at entry 185 in
  // between was a fabricated code word present nowhere in the run.
  //
  // Reading to the first blank line is the generic form of that: a result whose
  // payload follows a blank line contributes its whole opening paragraph, and a
  // result that is bulk from line one contributes exactly what it did before. The
  // deterministic brief is what a fold is COMMITTED with, so it has to stand alone
  // the moment the fold appears, and never be the thing an async upgrade rescues.
  // Paragraph-shaped means TERMINATED: an opening block is only kept whole when
  // a blank line ends it before the bulk. A result that is bulk from its first
  // line has no opening prose to keep, and handing its first thousand characters
  // to the brief is noise that inflates every status page and shrinks every
  // fold's reclaimable mass; that result contributes its first line, exactly as
  // before.
  const leadingParagraph = (message: unknown): string | null => {
    const lines = String(contentText(message) ?? "").split(/\r?\n/);
    const kept: string[] = [];
    for (const line of lines) {
      if (line.trim()) kept.push(line.trim());
      else if (kept.length) return kept.join(" ");
    }
    return null;
  };
  const tail = identifiedResultTail(messages.at(-1), factualValue);
  // THE AGENT'S OWN CLOSING NOTES (Shane 2026-08-14). The batch the fold absorbs
  // runs past its results: the assistant text between the last result and the
  // next batch's work is the agent recording what it just derived, and
  // sol-20260814-traps rep 2 lost trace-a-02 and trace-d-05 because those lines
  // lived nowhere else. Each assistant message contributes its leading
  // paragraph, INCLUDING the one that also opens the next batch: in a
  // pull-shaped session the agent closes batch N and calls batch N+1 in one
  // message (36 of rep 3's 37 assistant messages carry text and the next call
  // together), so the text is collected before the tool-calling break, and
  // ownership stays with batch N because batch N+1's own walk starts after
  // its own results. The walk stops at the first user turn or tool result,
  // and after consuming one tool-calling assistant.
  const resultIndices = refs.map((ref) => exactMapped(snapshot, ref)?.index ?? -1);
  const noteTexts: string[] = [];
  for (let index = Math.max(...resultIndices) + 1; index < snapshot.mapped.length; index += 1) {
    const message = snapshot.mapped[index]?.message;
    const role = messageRole(message);
    if (role !== "assistant") break;
    const paragraphText = assistantNoteText(message);
    if (paragraphText) noteTexts.push(paragraphText);
    const callsTools = (denseOwnArrayValues(ownValue(message, "content")) ?? [])
      .some((part) => ownValue(part, "type") === "toolCall");
    if (callsTools) break;
  }
  // Compose the identifying parts FIRST, then hand the paragraph what is left of
  // the bound. A fixed head allowance either starves the paragraph or outgrows
  // the composed contract; the remainder does neither. The head is seated before
  // the notes: the instruction prose won gate 134 on sealed evidence, so when
  // both are long the head keeps its allowance and the notes take the remainder.
  const assemble = (label: string, noted: string): string => [
    `Read ${oneLine(signatures.join("; "), IDENTIFIED_BRIEF_CALLS_CHARS)}`,
    label ? `opens "${label}"` : "",
    tail ? `ends "${tail}"` : "",
    noted ? `agent noted "${noted}"` : "",
    calls.length > 1 ? `${calls.length} exact results here` : "exact source here",
  ].filter(Boolean).join(" · ");
  // A present label costs its own wrapper on top of the fixed parts: the
  // ` · opens "` prefix and closing quote are 11 characters that assemble("")
  // does not count, because an empty label drops the whole term.
  const headAllowance = Math.max(0, ACTIVE_CONTEXT_POLICY.maxBriefChars - assemble("", "").length - 11);
  const paragraph = leadingParagraph(messages[0]);
  const label = paragraph !== null
    ? factualValue(paragraph, headAllowance)
    : factualValue(
      String(contentText(messages[0]) ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "",
      IDENTIFIED_BRIEF_HEAD_CHARS,
    );
  // The notes wrapper costs 18 characters the empty form does not count, the
  // same accounting as the label's 11.
  const notesAllowance = Math.max(0, ACTIVE_CONTEXT_POLICY.maxBriefChars - assemble(label, "").length - 18);
  const noted = noteTexts.length ? factualValue(noteTexts.join(" · "), notesAllowance) : "";
  const bounded = oneLine(assemble(label, noted), ACTIVE_CONTEXT_POLICY.maxBriefChars);
  return usefulBrief(bounded, ACTIVE_CONTEXT_POLICY.maxBriefChars, snapshot.toolName) ? bounded : null;
}

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
  const factualValue = (value: string, maximum: number): string => oneLine(
    value
      .replace(new RegExp(snapshot.toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "active-context service")
      .replace(/[\u0000-\u001f\u007f]+/g, " "),
    maximum,
  );
  const factualBriefValue = (value: string): string => factualValue(value, 120);
  const factualToolName = (name: string): string => name.toLowerCase() === snapshot.toolName.toLowerCase()
    ? "active-context status inspection"
    : factualBriefValue(name);
  const args = toolCallArguments(snapshot, first.assistantIndex, first.id);
  const peeked = peekedSourceFoldIds(snapshot, refs);
  if (peeked) return peekReclaimBrief(peeked);
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

const MIN_SUBJECT_CHARS = 24;
const CHAPTER_NOTE_CHARS = 160;

// The leading paragraph of an assistant message read as the agent's own note.
// Unlike a tool result's opening prose, an unterminated block is KEPT: the
// whole message is the agent's words, so a note with no blank line is a
// one-paragraph note, not bulk to refuse.
function assistantNoteText(message: unknown): string {
  const lines = String(contentText(message) ?? "").split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (line.trim()) kept.push(line.trim());
    else if (kept.length) break;
  }
  return kept.join(" ");
}

// THE one bounding primitive (Shane 2026-08-14). Every deterministic brief cut
// runs through here so a bound always leaves its mark: "..." means exactly
// "content continues in the exact source", and a reader never mistakes a cut
// value for a complete one. oneLine collapses whitespace then delegates;
// factualValue sanitizes then delegates through oneLine. No other site slices.

export function deterministicConsolidationBrief(
  candidate: FoldCandidate,
  state: ActiveContextState,
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  snapshot?: ActiveContextSnapshot,
): string {
  const byId = foldMap(state);
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sanitize = (value: string): string => value
    .replace(new RegExp(escapedToolName, "gi"), "active-context service")
    .replace(/\s+/g, " ")
    .trim();
  let foldCount = 0;
  let spanStart = Number.MAX_SAFE_INTEGER;
  let spanEnd = -1;
  const seat = (ref: EvidenceRef): void => {
    const item = snapshot ? exactMapped(snapshot, ref) : null;
    if (!item) return;
    spanStart = Math.min(spanStart, item.index);
    spanEnd = Math.max(spanEnd, item.index);
  };
  const childSubjects = candidate.parts.flatMap((part) => {
    if (part.kind === "fold") {
      const child = byId.get(part.foldId);
      if (!child) return [];
      foldCount += 1;
      for (const ref of flattenFoldRefs(child, state)) seat(ref);
      return [sanitize(foldBrief(child, state))];
    }
    seat(part.ref);
    return [];
  });
  // The agent's own recorded words are the ONLY carrier a derived fact ever
  // has (sol-20260814-traps rep 2 lost trace-a-02 and trace-d-05 exactly here:
  // each lived in one assistant turn between two tool batches, the parent
  // indexed only its children's briefs, and the value reached zero briefs), so
  // every assistant message the group hides contributes its leading paragraph
  // as its OWN subject, sharing the division with the child briefs. The child
  // briefs are not trusted to carry the notes for it: a child's subject is
  // truncated to its division share, and a note past the cut is the rep-2
  // loss again one level up, so a note rides whole or not at all, which the
  // ascending-length division guarantees for anything shorter than its fair
  // share. The span is WALKED rather than read off the candidate's raw parts,
  // because absorption geometry varies: rep 2 held its notes as unclaimed raw
  // parts while denser sessions claim the same assistant text into a child's
  // interval, and both spellings hide the same words. Non-assistant gaps
  // contribute nothing: their facts live in the folds beside them. Without a
  // snapshot the exact text is unreadable and the output is the
  // pre-2026-08-14 bytes exactly.
  const notes: string[] = [];
  if (snapshot && spanEnd >= 0) {
    for (let index = spanStart; index <= spanEnd; index += 1) {
      const item = snapshot.mapped[index];
      if (!item?.message) continue;
      if (messageRole(item.message) !== "assistant") continue;
      const noteText = assistantNoteText(item.message);
      if (noteText) notes.push(sanitize(boundedSubject(noteText, CHAPTER_NOTE_CHARS)));
    }
  }
  const noteCount = notes.length;
  const subjects = [...childSubjects, ...notes];
  if (!subjects.length) return "Grouped completed context covering no readable folds.";
  const lead = noteCount
    ? `Grouped completed context covering ${foldCount} folds and ${noteCount} agent notes: `
    : `Grouped completed context covering ${subjects.length} folds: `;
  // With notes in the division, what the count-slice drops may be a note rather
  // than a fold, so the tail only claims folds when folds are all it holds.
  return seatSubjects(subjects, lead, {
    total: ACTIVE_CONTEXT_POLICY.maxBriefChars,
    minSubjectChars: MIN_SUBJECT_CHARS,
    omittedNoun: noteCount ? "in this group" : "folds in this group",
  });
}

export const ALL_FOLD_KINDS: ReadonlySet<FoldKind> =
  new Set<FoldKind>(["tool-result", "chapter", "consolidation"]);

export const NO_FOLD_KINDS: ReadonlySet<FoldKind> = new Set<FoldKind>();

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
    const pinned = refsProtected(refs, state, snapshot);
    if (pinned) return child;
  }
  return null;
}

export function pinnedNestingRefusal(pinned: ActiveFold, toolName: string): string {
  return `fold refused: ${pinned.id} is pinned, and nesting it would hide context you asked to keep. ` +
    `Release it with ${toolName} {"action":"unpin","ids":["${pinned.id}"]} first, ` +
    "or name a span that stops at its boundary.";
}

export function foldedSpanRefusal(ownerId: string, subject: string, toolName: string): string {
  return `fold refused: ${subject} is already folded inside ${ownerId}, so there is nothing ` +
    `left to fold there. Read it with ${toolName} {"action":"peek","id":"${ownerId}"}, restore it ` +
    `with ${toolName} {"action":"expand","id":"${ownerId}"}, or name a span that reaches past it.`;
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

export function unpinnedStaleFolds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): Array<{ fold: ActiveFold; start: number; end: number }> {
  return visibleCollapsedRoots(state, snapshot)
    .filter(({ fold }) => !refsProtected(flattenFoldRefs(fold, state), state, snapshot));
}

export function pendingMarkClaims(
  state: ActiveContextState,
): { foldIds: Set<string>; refKeys: Set<string> } {
  const foldIds = new Set<string>();
  const refKeys = new Set<string>();
  for (const mark of state.pendingMarks ?? []) {
    if (mark.mark === "refold") {
      foldIds.add(mark.id);
      continue;
    }
    for (const part of mark.parts) {
      if (part.kind === "fold") foldIds.add(part.foldId);
      else refKeys.add(objectRefKey(part.ref));
    }
  }
  return { foldIds, refKeys };
}

function absorbableGap(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  from: number,
  to: number,
  claims: { refKeys: Set<string> },
): boolean {
  if (from > to) return true;
  const parts = partsForRange(snapshot, state, from, to, NO_FOLD_KINDS);
  if (!parts) return false;
  const refs = parts.flatMap((part) => part.kind === "raw" ? [part.ref] : []);
  if (refs.length !== parts.length || refsProtected(refs, state, snapshot)) return false;
  return !refs.some((ref) => claims.refKeys.has(objectRefKey(ref)));
}

function windowToolLinkage(snapshot: ActiveContextSnapshot): Map<string, { call: number; result: number }> {
  const linkage = new Map<string, { call: number; result: number }>();
  const at = (id: string): { call: number; result: number } => {
    const existing = linkage.get(id);
    if (existing) return existing;
    const created = { call: -1, result: -1 };
    linkage.set(id, created);
    return created;
  };
  for (let index = 0; index < snapshot.messages.length; index += 1) {
    const message = snapshot.messages[index];
    const role = messageRole(message);
    if (role === "assistant") {
      for (const part of denseOwnArrayValues(ownValue(message, "content")) ?? []) {
        if (ownValue(part, "type") !== "toolCall") continue;
        const id = ownValue(part, "id");
        if (typeof id === "string" && id) at(id).call = index;
      }
    } else if (role === "toolResult") {
      const id = ownValue(message, "toolCallId");
      if (typeof id === "string" && id) at(id).result = index;
    }
  }
  return linkage;
}

function linkageClosedSpan(
  snapshot: ActiveContextSnapshot,
  start: number,
  end: number,
): { start: number; end: number } {
  const linkage = windowToolLinkage(snapshot);
  let from = start;
  let to = end;
  for (let pass = 0; pass <= linkage.size; pass += 1) {
    let moved = false;
    for (const { call, result } of linkage.values()) {
      if (call < 0 || result < 0) continue;
      const callInside = call >= from && call <= to;
      const resultInside = result >= from && result <= to;
      if (callInside === resultInside) continue;
      if (call < from) { from = call; moved = true; }
      if (result > to) { to = result; moved = true; }
    }
    if (!moved) break;
  }
  return { start: from, end: to };
}

function consolidationCandidate(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  members: Array<{ fold: ActiveFold; start: number; end: number }>,
  claims: { refKeys: Set<string> },
): FoldCandidate | null {
  const span = linkageClosedSpan(snapshot, members[0].start, members.at(-1)!.end);
  const parts = partsForRange(snapshot, state, span.start, span.end, ALL_FOLD_KINDS);
  if (!parts) return null;
  const ids = new Set(members.map(({ fold }) => fold.id));
  const children = parts.flatMap((part) => part.kind === "fold" ? [part.foldId] : []);
  if (children.length !== ids.size || children.some((id) => !ids.has(id))) return null;
  const raw = parts.flatMap((part) => part.kind === "raw" ? [part.ref] : []);
  if (refsProtected(raw, state, snapshot)) return null;
  if (raw.some((ref) => claims.refKeys.has(objectRefKey(ref)))) return null;
  const sourceRefs = candidateSourceRefs(parts, state);
  return { kind: "consolidation", parts, sourceRefs };
}

export function selectAutomaticConsolidations(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): FoldCandidate[] {
  const width = snapshot.thresholds.consolidateAfter;
  if (!Number.isInteger(width) || width < 1) return [];
  const claims = pendingMarkClaims(state);
  const eligible = unpinnedStaleFolds(snapshot, state)
    .filter(({ fold }) => !claims.foldIds.has(fold.id));
  const groups: FoldCandidate[] = [];
  let run: typeof eligible = [];
  const close = (): void => {
    for (let at = 0; at + width <= run.length; at += width) {
      const candidate = consolidationCandidate(snapshot, state, run.slice(at, at + width), claims);
      if (candidate) groups.push(candidate);
    }
    run = [];
  };
  for (const root of eligible) {
    const previous = run.at(-1);
    if (previous && !absorbableGap(snapshot, state, previous.end + 1, root.start - 1, claims)) close();
    run.push(root);
  }
  close();
  return groups;
}

export interface AutomaticToolBatch {
  refs: EvidenceRef[];
  indices: number[];
  bytes: number;
}

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
    const size = group.reduce((total, { item }) => total + messageBytes(item.message), 0);
    if (refsProtected(exactRefs, state, snapshot) || refsInOrder(snapshot, exactRefs) === null ||
        size < snapshot.thresholds.minFoldChars) continue;
    batches.push({ refs: exactRefs, indices: group.map(({ item }) => item.index), bytes: size });
  }
  return batches;
}

/**
 * The serialized size of ONE transcript message, derived once per message object.
 *
 * `selectAutomaticSpan` tries the batch lane first, so this runs up to
 * MAX_FRONTIER_CUTS_PER_PASS times per context event from `frontierMarks`, once per staged
 * mark in a fill, and again from `unmarkedRemainder`. Everything else in
 * `automaticToolBatches` was already memoized; this was not, and it ran BEFORE the
 * eligibility filter, on every complete group including ones that go on to be refused.
 *
 * IT IS KEYED ON THE MESSAGE OBJECT, which is only useful because of where the object comes
 * from: `snapshot.mapped[i].message` is `input.eventMessages[index]` VERBATIM
 * (transcript.ts:494-508), so it is the same object across every snapshot derived from the
 * same session, and the memo hits. `snapshot.messages` is `clone(input.eventMessages)`
 * (transcript.ts:531), fresh objects on every derivation, so a caller reading THAT would
 * never hit and should not be routed here.
 *
 * Deliberately NOT a wrapper on `bytes()`, which is also called on transient arrays
 * (folding.ts, scheduling.ts) whose keys could never hit and would only grow the map.
 *
 * The accepted cost is gate 121's: a message mutated in place keeps its first size.
 */
const MESSAGE_BYTES = new WeakMap<object, number>();

export function messageBytes(message: unknown): number {
  const key = message && typeof message === "object" ? message as object : null;
  if (!key) return bytes(message);
  const memoized = MESSAGE_BYTES.get(key);
  if (memoized !== undefined) return memoized;
  const size = bytes(message);
  MESSAGE_BYTES.set(key, size);
  return size;
}

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

export function selectAutomaticRefold(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  claimedFoldIds: ReadonlySet<string> = new Set<string>(),
): string | null {
  const candidates = state.expanded.flatMap((id) => {
    if (claimedFoldIds.has(id)) return [];
    const fold = state.folds.find((item) => item.id === id);
    const interval = fold ? foldInterval(fold, state, snapshot) : null;
    const protectedSource = fold && (refsProtected(flattenFoldRefs(fold, state), state, snapshot));
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
  return units.every((unit, index) => index === 0 || unit.start === units[index - 1].end);
}

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

export function spanBytes(snapshot: ActiveContextSnapshot, start: number, end: number): number {
  return bytes(snapshot.messages.slice(start, end));
}

export interface SpanCorrection {
  from: string[];
  to: string[];
  reason: string;
}

export interface SnappedFoldSpan {
  candidate: FoldCandidate;
  corrections: SpanCorrection[];
}

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
  throw new Error(
    `${directError.message}. No corrected reading of that span is constructible`,
    { cause: lastError },
  );
}

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

export function snapSpanIds(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
  mode: "nearest" | "absorb" | "exclude" = "nearest",
): { ids: string[]; corrections: SpanCorrection[] } | null {
  let resolved: Array<{ start: number; end: number; fold?: ActiveFold }>;
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
    if (start === passStart && end === passEnd) break;
  }
  if (!corrections.length || end < start ||
      !snapshot.mapped[start]?.ref || !snapshot.mapped[end]?.ref) return null;
  return { ids: [entryIdAt(snapshot, start), entryIdAt(snapshot, end)], corrections };
}

export function snapToFoldBoundaries(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
  ids: string[],
): { start: number; end: number; ids: string[]; covered: ActiveFold[]; corrections: SpanCorrection[] } {
  const resolved = resolveFoldInputIds(snapshot, state, ids);
  const requested: [number, number] = [resolved[0].start, resolved.at(-1)!.end];
  let [start, end] = requested;
  const corrections: SpanCorrection[] = [];
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
  options: { allowProtected?: boolean } = {},
): FoldCandidate {
  const blocked = (refs: EvidenceRef[]): boolean =>
    !options.allowProtected && refsProtected(refs, state, snapshot);
  const owners = directFoldOwners(state.folds);
  const bounded = (candidate: FoldCandidate): FoldCandidate => {
    for (const part of candidate.parts) {
      if (part.kind !== "raw") continue;
      const ownerId = owners.get(objectRefKey(part.ref));
      if (ownerId) throw new Error(foldedSpanRefusal(ownerId, part.ref.entryId, snapshot.toolName));
    }
    const only = candidate.parts.length === 1 ? candidate.parts[0] : null;
    if (only?.kind === "fold") {
      throw new Error(foldedSpanRefusal(only.foldId, "that span", snapshot.toolName));
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
    if (completeBatch && !blocked(refs)) {
      return bounded({ kind: "tool-result", parts: refs.map((ref) => ({ kind: "raw", ref })), sourceRefs: refs });
    }
    if (one && first && first.batch.length === 1 && !blocked(refs)) {
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
    const cut = orderedRoots(state, snapshot).filter((root) => root.start <= end && start <= root.end);
    const container = cut.find((root) => root.start <= start && root.end >= end);
    throw new Error(container
      ? foldedSpanRefusal(container.fold.id, "that span", snapshot.toolName)
      : `Fold span partially overlaps ${cut.map((root) => root.fold.id).join(", ")}`);
  }
  const swallowedPin = pinnedChildFold(parts, state, snapshot);
  if (swallowedPin) throw new Error(pinnedNestingRefusal(swallowedPin, snapshot.toolName));
  const refs = candidateSourceRefs(parts, state);
  if (blocked(refs)) throw new Error("Manual chapter contains fresh, unfinished, unmatched, unmapped, or protected evidence");
  return bounded({ kind: "chapter", parts, sourceRefs: refs });
}

// THE TOOL-CLIP VIEW HEAD (2026-08-24). A clipped result keeps its opening verbatim,
// not collapsed: the view stays a readable result head in place, unlike a brief's
// one-line quote. The paragraph rule is gate 134's: an opening block terminated by a
// blank line is kept whole up to the cap; a result that is bulk from line one keeps its
// first cap's worth. The caller states the cut, per gate 136: the marker rides beside
// the count of what it hides, never silently.

export function deterministicChapterBrief(
  refs: EvidenceRef[],
  messages: unknown[],
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
): string {
  if (refs.length !== messages.length || !refs.length) {
    throw new Error("Deterministic chapter brief requires aligned exact evidence");
  }
  // EVERY ENTRY IDENTIFIED IN SPAN ORDER (Shane 2026-08-24). The count-style brief
  // ("User: ... \u00b7 Tools: 3\u00d7bash \u00b7 Assistant: No assistant text in this span")
  // collapsed to the same anonymous line on every residue span of the pull workload:
  // sol-20260823-live rep 3 committed 188 byte-identical placeholders of that shape and
  // the agent re-peeked 76 folds 209 times to learn what each one held. The span's own
  // calls are the index: each call named with its arguments and its result's opening
  // line, an errored result marked, the user's ask and every assistant note seated in
  // span order, and what the cap refuses COUNTED rather than dropped (the gate-135 law
  // carried forward: a value recorded once in an assistant note between two batches must
  // reach the brief). Cuts run through oneLine, so "..." always means the exact source
  // continues.
  const callNames = new Map<string, string>();
  const pieces: string[] = [];
  for (const message of messages) {
    const role = messageRole(message);
    if (role === "user") {
      const ask = contentText(message);
      if (ask.trim()) pieces.push(`User asked: ${oneLine(ask, 120)}`);
    } else if (role === "assistant") {
      for (const part of denseOwnArrayValues(ownValue(message, "content")) ?? []) {
        if (ownValue(part, "type") !== "toolCall") continue;
        const id = ownValue(part, "id");
        const name = ownValue(part, "name");
        if (typeof id !== "string" || !id || typeof name !== "string" || !name) continue;
        let args = "{}";
        try {
          args = JSON.stringify(ownValue(part, "arguments") ?? {}) ?? "{}";
        } catch {
          args = "{unserializable}";
        }
        callNames.set(id, `${name}(${oneLine(args, 80)})`);
      }
      const note = assistantNoteText(message);
      if (note) pieces.push(`Noted: ${boundedSubject(note, CHAPTER_NOTE_CHARS)}`);
    } else if (role === "toolResult") {
      const id = ownValue(message, "toolCallId");
      const name = ownValue(message, "toolName");
      const head = (typeof id === "string" ? callNames.get(id) : undefined) ??
        (typeof name === "string" && name ? `${name}(...)` : "tool(...)");
      const errored = ownValue(message, "isError") === true ? " [errored]" : "";
      pieces.push(`${head}${errored} \u2192 "${oneLine(contentText(message), 90)}"`);
    }
  }
  const separator = " \u00b7 ";
  const compose = (kept: number): string => {
    const omitted = pieces.length - kept;
    const shown = pieces.slice(0, kept).join(separator);
    const tail = omitted ? `${kept ? separator : ""}${omitted} more entries in this span` : "";
    return `${shown}${tail}`;
  };
  let composed = compose(pieces.length);
  for (let kept = pieces.length; kept > 0 && composed.length > ACTIVE_CONTEXT_POLICY.maxBriefChars; kept -= 1) {
    composed = compose(kept - 1);
  }
  const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  composed = composed.replace(new RegExp(escapeName(toolName), "gi"), "active-context service");
  if (usefulBrief(composed, ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName)) return composed;
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
