import {
  denseOwnArrayValues,
  evidenceRef,
  evidenceValue,
  isPlainRecord,
  sha256Text,
  stableStringify,
} from "../json.ts";
import {
  bytes,
  clone,
  messageRole,
  ownValue,
  sessionEntryMessages,
} from "./canonical.ts";
import {
  ACTIVE_CONTEXT_POLICY,
  BYTES_PER_TOKEN_FLOOR,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
  DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  DEFAULT_CONTEXT_WINDOW,
  READ_ONLY_TOOLS_DEFAULT,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  BranchObject,
  CompleteTurn,
  MappedMessage,
} from "./policy.ts";

export function terminalAssistant(message: unknown): boolean {
  if (messageRole(message) !== "assistant") return false;
  const stop = ownValue(message, "stopReason");
  return stop === "stop" || stop === "length";
}

export function completeTurns(messages: unknown[]): CompleteTurn[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) if (messageRole(messages[index]) === "user") starts.push(index);
  const turns: CompleteTurn[] = [];
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    const start = starts[cursor];
    const limit = starts[cursor + 1] ?? messages.length;
    let end = limit;
    while (end > start && (messageRole(messages[end - 1]) === "custom" ||
        messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
    if (end > start && terminalAssistant(messages[end - 1])) turns.push({ start, end });
  }
  return turns;
}

/**
 * Native compaction may resume the assistant after a summary without replaying
 * the compacted user message. Once a later user message exists, that closed
 * assistant/tool prefix is stale evidence, not part of the fresh user tail.
 * Keep the native summary itself raw and require a terminal assistant boundary.
 */
export function leadingCompactionContinuation(messages: unknown[]): CompleteTurn | null {
  if (messageRole(messages[0]) !== "compactionSummary") return null;
  let firstUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messageRole(messages[index]) === "user") { firstUser = index; break; }
  }
  if (firstUser <= 1 || messageRole(messages[1]) !== "assistant") return null;
  let end = firstUser;
  while (end > 1 && (messageRole(messages[end - 1]) === "custom" ||
      messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
  return end > 1 && terminalAssistant(messages[end - 1]) ? { start: 1, end } : null;
}

export function isReadOnlyContextTool(
  name: string,
  args?: unknown,
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): boolean {
  if (readOnlyTools.has(name)) return true;
  if (name !== toolName || !isPlainRecord(args) || ownValue(args, "action") !== "status") return false;
  const allowed = new Set(["action", "offset", "limit"]);
  const keys = Reflect.ownKeys(args);
  for (let index = 0; index < keys.length; index += 1) {
    if (typeof keys[index] !== "string" || !allowed.has(keys[index] as string)) return false;
  }
  return true;
}

export function exactToolCallParts(content: unknown): unknown[] | null {
  const parts = denseOwnArrayValues(content);
  if (!parts) return null;
  const calls: unknown[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (ownValue(parts[index], "type") === "toolCall") calls.push(parts[index]);
  }
  return calls;
}

export interface ValidatedToolBatch {
  calls: Array<{ id: string; name: string; assistantIndex: number; resultIndex: number }>;
}

export interface ScannedToolBatches extends ValidatedToolBatch {
  unsafeIndices: Set<number>;
}

/** Validate each same-assistant tool batch inside one complete turn; results never cross a batch. */
export function scanTurnToolBatches(
  messages: unknown[],
  turn: CompleteTurn,
  allowIncomplete = false,
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): ScannedToolBatches | null {
  if (!Number.isSafeInteger(turn.start) || !Number.isSafeInteger(turn.end) ||
      turn.start < 0 || turn.end > messages.length || turn.start >= turn.end) return null;
  const terminal = terminalAssistant(messages[turn.end - 1]);
  if (!terminal && !allowIncomplete) return null;
  const batches: Array<{
    assistantIndex: number;
    end: number;
    safe: boolean;
    calls: Array<{ id: string; name: string; assistantIndex: number; resultIndex: number }>;
  }> = [];
  const unsafeIndices = new Set<number>();
  let index = turn.start;
  while (index < turn.end) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "assistant" && terminal && index === turn.end - 1) {
      index += 1;
      continue;
    }
    if (role !== "assistant" || ownValue(message, "stopReason") !== "toolUse") {
      if (role === "assistant" || role === "toolResult") unsafeIndices.add(index);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < turn.end && messageRole(messages[end]) === "toolResult") end += 1;
    const content = denseOwnArrayValues(ownValue(message, "content"));
    const rawCalls = exactToolCallParts(ownValue(message, "content")) ?? [];
    const calls = new Map<string, { id: string; name: string; assistantIndex: number }>();
    const results = new Map<string, { name: string; resultIndex: number }>();
    let safe = Boolean(content && rawCalls.length);
    for (const part of rawCalls) {
      const id = ownValue(part, "id");
      const name = ownValue(part, "name");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          calls.has(id) || !isReadOnlyContextTool(name, ownValue(part, "arguments"), toolName, readOnlyTools)) safe = false;
      else calls.set(id, { id, name, assistantIndex: index });
    }
    for (let resultIndex = index + 1; resultIndex < end; resultIndex += 1) {
      const result = messages[resultIndex];
      const id = ownValue(result, "toolCallId");
      const name = ownValue(result, "toolName");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          ownValue(result, "isError") !== false || results.has(id)) safe = false;
      else results.set(id, { name, resultIndex });
    }
    const validated: ScannedToolBatches["calls"] = [];
    if (calls.size !== results.size) safe = false;
    for (const call of calls.values()) {
      const result = results.get(call.id);
      if (!result || result.name !== call.name) safe = false;
      else validated.push({ ...call, resultIndex: result.resultIndex });
    }
    batches.push({ assistantIndex: index, end, safe, calls: validated });
    index = end;
  }

  const owners = new Map<string, number>();
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    for (const call of batches[batchIndex].calls) {
      const owner = owners.get(call.id);
      if (owner === undefined) owners.set(call.id, batchIndex);
      else {
        batches[owner].safe = false;
        batches[batchIndex].safe = false;
      }
    }
  }

  const calls: ScannedToolBatches["calls"] = [];
  for (const batch of batches) {
    if (batch.safe) calls.push(...batch.calls);
    else for (let unsafe = batch.assistantIndex; unsafe < batch.end; unsafe += 1) unsafeIndices.add(unsafe);
  }
  return { calls, unsafeIndices };
}

/** Validate a complete turn as wholly read-only. Granular callers may still use its safe batches. */
export function validateTurnToolBatch(
  messages: unknown[],
  turn: CompleteTurn,
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
  readOnlyTools: ReadonlySet<string> = READ_ONLY_TOOLS_DEFAULT,
): ValidatedToolBatch | null {
  const scanned = scanTurnToolBatches(messages, turn, false, toolName, readOnlyTools);
  return scanned && scanned.unsafeIndices.size === 0 ? { calls: scanned.calls } : null;
}

export interface ChapterUnit {
  start: number;
  end: number;
  turnStart: number;
}

/**
 * Structural chapter segments are deliberately independent of terminal turns.
 * A long-running user turn is one segment even while the coordinator continues
 * issuing tools; a later user message closes the preceding segment without
 * making that boundary either necessary or sufficient for folding.
 */
export function chapterSegments(messages: unknown[]): CompleteTurn[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messageRole(messages[index]) === "user") starts.push(index);
  }
  const segments: CompleteTurn[] = [];
  if (messageRole(messages[0]) === "compactionSummary") {
    const end = starts[0] ?? messages.length;
    if (end > 1) segments.push({ start: 1, end });
  }
  for (let cursor = 0; cursor < starts.length; cursor += 1) {
    const start = starts[cursor];
    let end = starts[cursor + 1] ?? messages.length;
    while (end > start && (messageRole(messages[end - 1]) === "custom" ||
        messageRole(messages[end - 1]) === "bashExecution")) end -= 1;
    if (end > start) segments.push({ start, end });
  }
  return segments;
}

/**
 * Build indivisible structurally closed units. Chapters may summarize completed
 * mutating and failed work, including an old prefix of the currently running
 * turn. Every tool-use assistant must own one complete, unique result batch;
 * any pending, unmatched, or unknown shape protects its entire segment.
 */
export function structurallyClosedChapterUnits(messages: unknown[], segment: CompleteTurn): ChapterUnit[] {
  const units: ChapterUnit[] = [];
  const ownedCalls = new Set<string>();
  for (let index = segment.start; index < segment.end;) {
    const message = messages[index];
    const role = messageRole(message);
    if (role === "toolResult") {
      index += 1;
      continue;
    }
    if (role !== "assistant") {
      units.push({ start: index, end: index + 1, turnStart: segment.start });
      index += 1;
      continue;
    }
    const stopReason = ownValue(message, "stopReason");
    const content = denseOwnArrayValues(ownValue(message, "content"));
    const rawCalls = exactToolCallParts(ownValue(message, "content")) ?? [];
    const toolShaped = stopReason === "toolUse" || rawCalls.length > 0;
    if (!toolShaped) {
      if (stopReason === "stop" || stopReason === "length" ||
          stopReason === "error" || stopReason === "aborted") {
        units.push({ start: index, end: index + 1, turnStart: segment.start });
      }
      index += 1;
      continue;
    }
    const calls = new Map<string, string>();
    let safe = Boolean(content && rawCalls.length &&
      (stopReason === "toolUse" || stopReason === "length" ||
        stopReason === "error" || stopReason === "aborted"));
    for (const part of rawCalls) {
      const id = ownValue(part, "id");
      const name = ownValue(part, "name");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name ||
          calls.has(id) || ownedCalls.has(id)) safe = false;
      else calls.set(id, name);
    }
    let end = index + 1;
    const results = new Map<string, string>();
    while (end < segment.end && messageRole(messages[end]) === "toolResult") {
      const id = ownValue(messages[end], "toolCallId");
      const name = ownValue(messages[end], "toolName");
      if (typeof id !== "string" || !id || typeof name !== "string" || !name || results.has(id)) safe = false;
      else results.set(id, name);
      end += 1;
    }
    if (calls.size !== results.size) safe = false;
    for (const [id, name] of calls) {
      if (results.get(id) !== name) {
        safe = false;
        break;
      }
    }
    if (safe) {
      for (const id of calls.keys()) ownedCalls.add(id);
      units.push({ start: index, end, turnStart: segment.start });
    }
    index = end;
  }
  return units;
}

export function unsafeChapterIndices(messages: unknown[]): Set<number> {
  const eligible = new Set<number>();
  const segments = chapterSegments(messages);
  for (const segment of segments) {
    const units = structurallyClosedChapterUnits(messages, segment);
    for (const unit of units) for (let index = unit.start; index < unit.end; index += 1) eligible.add(index);
  }
  const unsafe = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) if (!eligible.has(index)) unsafe.add(index);
  // The initiating request of the still-running segment remains raw even after
  // its older completed work has moved beyond the byte tail. It carries the
  // live marathon objective; subsequent structurally closed batches may fold.
  const current = segments.length ? segments[segments.length - 1] : undefined;
  if (current?.end === messages.length && !terminalAssistant(messages[current.end - 1]) &&
      messageRole(messages[current.start]) === "user") unsafe.add(current.start);
  return unsafe;
}

export function freshBoundary(messages: unknown[], turns: CompleteTurn[], policy: typeof ACTIVE_CONTEXT_POLICY): number {
  if (!messages.length) return 0;
  let unfinishedUser = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messageRole(messages[index]) !== "user") continue;
    let complete = false;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (turns[turnIndex].start === index) { complete = true; break; }
    }
    unfinishedUser = complete ? messages.length : index;
    break;
  }
  const leading = leadingCompactionContinuation(messages);
  let boundary = turns.length >= policy.freshTurns
    ? turns[turns.length - policy.freshTurns].start
    : leading?.end ?? 0;
  boundary = Math.min(boundary, unfinishedUser);
  while (boundary > 0) {
    const suffix: unknown[] = [];
    for (let index = boundary; index < messages.length; index += 1) suffix.push(messages[index]);
    if (bytes(suffix) >= policy.freshBytes) break;
    let previous: CompleteTurn | null = null;
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      if (turns[turnIndex].start < boundary) previous = turns[turnIndex];
    }
    if (!previous) { boundary = 0; break; }
    boundary = previous.start;
  }
  return boundary;
}

export function toolFreshIndices(
  messages: unknown[],
  turns: CompleteTurn[],
  policy: typeof ACTIVE_CONTEXT_POLICY,
): Set<number> {
  const protectedIndices = new Set<number>();
  const firstFreshTurn = Math.max(0, turns.length - policy.freshTurns);
  for (let turnIndex = firstFreshTurn; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    for (let index = turn.start; index < turn.end; index += 1) protectedIndices.add(index);
  }
  let tailBytes = 0;
  let boundary = messages.length;
  while (boundary > 0 && tailBytes < policy.freshBytes) {
    boundary -= 1;
    tailBytes += bytes(messages[boundary]);
  }
  for (let index = boundary; index < messages.length; index += 1) protectedIndices.add(index);
  return protectedIndices;
}

export function mapActiveContext(input: {
  sessionId: string;
  eventMessages: unknown[];
  contextEntries: Array<Record<string, unknown>>;
  projectEntry?: (entry: Record<string, unknown>) => unknown[];
  policy?: Partial<typeof ACTIVE_CONTEXT_POLICY>;
  toolName?: string;
  brandNoun?: string;
  entryTypePrefix?: string;
  readOnlyTools?: ReadonlySet<string>;
  contextWindow?: number;
}): ActiveContextSnapshot {
  const policy = Object.freeze({ ...ACTIVE_CONTEXT_POLICY, ...(input.policy ?? {}) }) as typeof ACTIVE_CONTEXT_POLICY;
  const projectEntry = input.projectEntry ?? sessionEntryMessages;
  const branchObjects: BranchObject[] = [];
  for (let entryIndex = 0; entryIndex < input.contextEntries.length; entryIndex += 1) {
    const entry = input.contextEntries[entryIndex];
    const entryId = typeof entry?.id === "string" ? entry.id : "";
    if (!entryId) continue;
    const projected = denseOwnArrayValues(projectEntry(entry));
    if (!projected) continue;
    for (let messageIndex = 0; messageIndex < projected.length; messageIndex += 1) {
      const message = projected[messageIndex];
      try {
        branchObjects.push({
          branchIndex: branchObjects.length,
          message,
          ref: evidenceRef(input.sessionId, entryId, message),
        });
      } catch {
        // Unknown persisted shapes stay unavailable rather than weakening exact refs.
      }
    }
  }

  const mapped: MappedMessage[] = [];
  let cursor = 0;
  for (let index = 0; index < input.eventMessages.length; index += 1) {
    const message = input.eventMessages[index];
    let wire: string | null = null;
    let digest: string | null = null;
    try {
      wire = stableStringify(evidenceValue(message));
      digest = sha256Text(wire);
    } catch {
      mapped.push({ index, message, ref: null });
      continue;
    }
    let match = -1;
    for (let branchIndex = cursor; branchIndex < branchObjects.length; branchIndex += 1) {
      const candidate = branchObjects[branchIndex];
      if (candidate.ref.sha256 === digest && stableStringify(evidenceValue(candidate.message)) === wire) {
        match = branchIndex;
        break;
      }
    }
    if (match < 0) mapped.push({ index, message, ref: null });
    else {
      mapped.push({ index, message, ref: branchObjects[match].ref });
      cursor = match + 1;
    }
  }

  const reportedContextWindow = typeof input.contextWindow === "number" &&
    Number.isFinite(input.contextWindow) && input.contextWindow > 0
    ? input.contextWindow
    : null;
  // A fixed byte floor can dominate a small or shrunken window. Cap the protected
  // tail at freshWindowShare of the window via a conservative bytes-per-token
  // floor: this binds only on genuinely small windows and never widens the
  // protected tail.
  const tailPolicy = reportedContextWindow === null ? policy : Object.freeze({
    ...policy,
    freshBytes: Math.min(policy.freshBytes, Math.floor(
      reportedContextWindow * policy.freshWindowShare * BYTES_PER_TOKEN_FLOOR)),
  });
  const turns = completeTurns(input.eventMessages);
  const boundary = freshBoundary(input.eventMessages, turns, tailPolicy);
  const protectedIndices = unsafeChapterIndices(input.eventMessages);
  const toolProtectedIndices = toolFreshIndices(input.eventMessages, turns, tailPolicy);
  // Chapter protection is set-shaped: preserve the newest complete turns and
  // raw byte tail, while allowing an older closed prefix of the current turn.
  for (const index of toolProtectedIndices) protectedIndices.add(index);
  for (let mappedIndex = 0; mappedIndex < mapped.length; mappedIndex += 1) {
    const item = mapped[mappedIndex];
    if (item.ref) continue;
    protectedIndices.add(item.index);
    toolProtectedIndices.add(item.index);
  }
  return {
    sessionId: input.sessionId,
    messages: clone(input.eventMessages),
    mapped,
    branchObjects,
    completeTurns: turns,
    freshBoundary: boundary,
    protectedIndices,
    toolProtectedIndices,
    policy: tailPolicy,
    toolName: input.toolName ?? DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
    brandNoun: input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
    entryTypePrefix: input.entryTypePrefix ?? DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
    readOnlyTools: input.readOnlyTools ?? READ_ONLY_TOOLS_DEFAULT,
    contextWindow: reportedContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    windowSource: reportedContextWindow === null ? "fallback" : "reported",
  };
}
