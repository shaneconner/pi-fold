/**
 * Tree rollback on provider input-overflow.
 *
 * A request whose projection exceeds the provider input budget is rejected outright.
 * The recovery is not a deeper fold, it is a rollback: move the session leaf back to
 * just before the entry that failed, let the retried request's own projection pass do
 * the ordinary fold commit, and tell the agent what happened. Everything here is pure:
 * the surface probes, the error-entry search and the replayability test. The lane that
 * uses them lives in `active-context.ts`, because it is the only place that owns the
 * session handle and the event stream.
 *
 * The whole file is written against pi 0.83.0 internals that the extension contract
 * does not promise. That is deliberate and it is why the probes exist: a surface that
 * moved is a lane that refuses to arm, loudly, rather than a rollback that half runs.
 */

/** One probed surface: what was asked of it, and whether it answered. */
export interface RollbackProbe {
  name: string;
  present: boolean;
  /** Null when the surface carries no arity contract. */
  arity: number | null;
  expectedArity: number | null;
  /** A surface the lane cannot run without. */
  required: boolean;
}

export interface RollbackProbeReport {
  probes: RollbackProbe[];
  failures: string[];
  /** Every REQUIRED surface answered. */
  armed: boolean;
}

/**
 * The session-manager surfaces the lane calls, and the arities it calls them with.
 *
 * `branch` and `resetLeaf` are the rollback itself; `appendLabelChange` is the lineage
 * marker, and it must run BEFORE the branch because it appends at the current leaf and
 * advances it, so a label applied afterwards lands on the surviving path instead of the
 * abandoned one. The readers are required because the lane cannot locate the error
 * entry without them.
 */
const SESSION_MANAGER_PROBES: ReadonlyArray<{ name: string; arity: number | null; required: boolean }> = Object.freeze([
  { name: "branch", arity: 1, required: true },
  { name: "resetLeaf", arity: 0, required: true },
  { name: "getLeafId", arity: 0, required: true },
  { name: "getEntry", arity: 1, required: true },
  { name: "getBranch", arity: 0, required: true },
  { name: "buildContextEntries", arity: 0, required: true },
  { name: "appendLabelChange", arity: 2, required: true },
]);

export function probeRollbackSurfaces(sessionManager: unknown): RollbackProbeReport {
  const probes: RollbackProbe[] = [];
  const failures: string[] = [];
  const host = sessionManager as Record<string, unknown> | null | undefined;
  for (const expected of SESSION_MANAGER_PROBES) {
    const member = host && typeof host === "object" ? host[expected.name] : undefined;
    const present = typeof member === "function";
    const arity = present ? (member as (...args: unknown[]) => unknown).length : null;
    probes.push({
      name: `sessionManager.${expected.name}`,
      present,
      arity,
      expectedArity: expected.arity,
      required: expected.required,
    });
    if (!present) {
      if (expected.required) failures.push(`sessionManager.${expected.name} is missing`);
      continue;
    }
    // Arity is advisory on purpose: a host that adds an optional parameter has not
    // broken the call, and refusing to arm over it would be a false alarm. A MISSING
    // parameter has broken it, so the probe fails only when the surface takes fewer
    // arguments than the lane passes.
    if (expected.arity !== null && arity !== null && arity < expected.arity && expected.required) {
      failures.push(`sessionManager.${expected.name} takes ${arity} argument(s), the lane passes ${expected.arity}`);
    }
  }
  return { probes, failures, armed: failures.length === 0 };
}

/** The keys `_runAutoCompaction` puts on the overflow event, and the lane reads. */
const OVERFLOW_EVENT_KEYS: ReadonlyArray<string> = Object.freeze([
  "reason", "willRetry", "branchEntries", "signal",
]);

export function overflowEventShape(event: unknown): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const record = event as Record<string, unknown> | null | undefined;
  for (const key of OVERFLOW_EVENT_KEYS) {
    if (!record || typeof record !== "object" || !Object.prototype.hasOwnProperty.call(record, key)) {
      missing.push(key);
    }
  }
  return { ok: missing.length === 0, missing };
}

function entryMessage(entry: unknown): Record<string, unknown> | null {
  const record = entry as Record<string, unknown> | null | undefined;
  if (!record || typeof record !== "object" || record.type !== "message") return null;
  const message = record.message;
  return message && typeof message === "object" ? message as Record<string, unknown> : null;
}

/**
 * The entry the provider rejected: the trailing assistant message whose stop reason is
 * the error pi turned the rejection into.
 *
 * It must be the last MESSAGE on the branch. Custom entries after it are telemetry --
 * this runtime's own event stream appends there -- and they go with the rollback, which
 * is what should happen to records of a request that never landed. A later CONVERSATION
 * entry is a different story: something else already moved the leaf, and rolling back to
 * this entry's parent would abandon work the lane never looked at.
 */
export function findOverflowErrorEntry(branchEntries: unknown[]): {
  id: string;
  parentId: string | null;
  index: number;
} | null {
  if (!Array.isArray(branchEntries) || !branchEntries.length) return null;
  let index = branchEntries.length - 1;
  while (index >= 0 && !entryMessage(branchEntries[index])) index -= 1;
  if (index < 0) return null;
  const entry = branchEntries[index] as Record<string, unknown>;
  const message = entryMessage(entry);
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return null;
  const id = typeof entry.id === "string" ? entry.id : "";
  if (!id) return null;
  const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
  return { id, parentId, index };
}

function contentParts(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is Record<string, unknown> =>
    Boolean(part) && typeof part === "object");
}

/**
 * Tool calls the rolled-back tail leaves unanswered.
 *
 * Possible only when a run died between persisting an assistant tool-call message and
 * persisting its results. A queued user turn after an unsatisfied tool call is a
 * malformed transcript for every provider, so this is the one shape where the rollback
 * happens and the replay does not.
 */
export function unansweredToolCalls(branchEntries: unknown[]): string[] {
  if (!Array.isArray(branchEntries) || !branchEntries.length) return [];
  const answered = new Set<string>();
  let pending: string[] = [];
  for (const entry of branchEntries) {
    const message = entryMessage(entry);
    if (!message) continue;
    if (message.role === "assistant") {
      const calls = contentParts(message)
        .filter((part) => part.type === "toolCall" && typeof part.id === "string")
        .map((part) => String(part.id));
      if (calls.length) pending = calls;
      else if (message.stopReason !== "error") pending = [];
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      answered.add(message.toolCallId);
    }
  }
  return pending.filter((id) => !answered.has(id));
}

/**
 * The invariant the whole lane rests on, stated as arithmetic.
 *
 * pi strips the trailing error message from `agent.state.messages` before it emits the
 * overflow event, so at the recovery point agent state already equals the rolled-back
 * branch, and moving the session leaf is the only step left. That equality is an
 * ordering of two internal steps rather than a promise, so it is measured instead of
 * assumed: the rebuilt session context must come back exactly the error entry's own
 * contribution shorter, no more and no less. More means the branch overshot; less means
 * it did not move, and either way the retry would send a window nobody built.
 */
export function preStripHolds(input: {
  sessionMessagesBefore: number;
  sessionMessagesAfter: number;
  errorEntryMessages: number;
}): boolean {
  return input.sessionMessagesAfter === input.sessionMessagesBefore - input.errorEntryMessages;
}

/**
 * The notice the agent reads on the retried turn.
 *
 * One message, because pi drains steering one at a time. It says the three things the
 * agent cannot see for itself: the request was rejected for size, the session rolled
 * back and folded, and its work continues from where it was.
 */
export function rollbackNoticeText(input: {
  brandNoun: string;
  toolName: string;
  tokensRolledBack: number;
  entriesAbandoned: number;
  replayed: boolean;
  replaySkipReason: string | null;
}): string {
  const head = "The provider rejected the last request because the context exceeded its input limit. " +
    `${input.brandNoun} rolled the session back past that request (${input.entriesAbandoned} entry(s), ` +
    `about ${input.tokensRolledBack} tokens, kept in the tree as an abandoned branch) and folded the ` +
    "stale window to make room.";
  if (input.replayed) {
    return `${head} The request is being reissued now, so continue the work you were doing; nothing was lost, ` +
      `and the folded material is still readable through ${input.toolName}.`;
  }
  return `${head} The request was NOT reissued: ${input.replaySkipReason ?? "the rolled-back tail is not replayable"}. ` +
    "Reissue the work yourself from the state you can see.";
}
