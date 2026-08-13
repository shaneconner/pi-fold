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
  arity: number | null;
  expectedArity: number | null;
  required: boolean;
}

export interface RollbackProbeReport {
  probes: RollbackProbe[];
  failures: string[];
  armed: boolean;
}

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
    if (expected.arity !== null && arity !== null && arity < expected.arity && expected.required) {
      failures.push(`sessionManager.${expected.name} takes ${arity} argument(s), the lane passes ${expected.arity}`);
    }
  }
  return { probes, failures, armed: failures.length === 0 };
}

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

export function preStripHolds(input: {
  sessionMessagesBefore: number;
  sessionMessagesAfter: number;
  errorEntryMessages: number;
}): boolean {
  return input.sessionMessagesAfter === input.sessionMessagesBefore - input.errorEntryMessages;
}

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
