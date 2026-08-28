import {
  denseOwnArrayValues,
  evidenceSha256,
  isPlainRecord,
  stableStringify,
} from "../json.ts";
import { ACTIVE_CONTEXT_POLICY, DEFAULT_ACTIVE_CONTEXT_TOOL_NAME } from "./policy.ts";
import type { ActiveContextState } from "./policy.ts";

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : stableStringify(value), "utf8");
}

/**
 * Does `heldText`, the serialization of the first `held` elements, stand as a prefix of
 * `bodyText`, the serialization of the whole array?
 *
 * ARRAY SERIALIZATION IS PREFIX-FREE BY CONSTRUCTION, which is the whole reason this can be
 * answered from a string the caller already has instead of by serializing a slice. `safeJson`
 * emits `[`, then the elements separated by `,`, then `]`: no whitespace, no trailing comma.
 * So the serialization of the first `held` elements is exactly the head of the whole one with
 * `]` in place of the `,` that follows element `held - 1`.
 *
 * The two ends break that rule and are branched on rather than argued away. At `held` 0 the
 * prefix is `[]` and there is no comma to match, so testing `"[," ` would be nonsense. At
 * `held === length` there is no following element and the two strings are simply equal.
 *
 * The comma is the reason this is not a bare `startsWith`, and it is worth being exact about
 * when it earns its place. JSON's object and string forms SELF-TERMINATE, with `}` and a
 * closing quote, so for the message arrays this has one caller for, a bare `startsWith` would
 * happen to agree. Numbers do not self-terminate: `[1]` is a leading substring of `[12]` and
 * a bare `startsWith` accepts it. The separator is what makes the predicate correct for any
 * array rather than for today's caller, and a false positive in that caller splices a stale
 * head in front of a live tail. Gate 154 drives the numeric case for exactly this reason.
 */
export function serializedPrefixHolds(
  bodyText: string,
  heldText: string | null | undefined,
  held: number,
  length: number,
): boolean {
  if (heldText === null || heldText === undefined || length < held) return false;
  if (held === 0) return heldText === "[]";
  if (held === length) return bodyText === heldText;
  return bodyText.startsWith(`${heldText.slice(0, -1)},`);
}

export function boundedUtf8(text: string, maximumBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maximumBytes) return text;
  return buffer.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/, "");
}

export function utf8Slice(text: string, offsetBytes: number): string {
  if (offsetBytes <= 0) return text;
  const buffer = Buffer.from(text, "utf8");
  if (offsetBytes >= buffer.length) return "";
  return buffer.subarray(offsetBytes).toString("utf8").replace(/^�/, "");
}

export function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const expected = new Set(keys);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expected.size) return false;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
}

export function messageRole(message: unknown): string | null {
  const role = ownValue(message, "role");
  return typeof role === "string" && role ? role : null;
}

export function contentText(message: unknown): string {
  const content = ownValue(message, "content");
  if (typeof content === "string") return content;
  const parts = denseOwnArrayValues(content);
  if (!parts) return "";
  const text: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part && typeof part === "object" && ownValue(part, "type") === "text") {
      text.push(String(ownValue(part, "text") ?? ""));
    }
  }
  return text.join("\n");
}

export function sessionEntryMessages(entry: Record<string, unknown>): unknown[] {
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message as Record<string, unknown>;
    if ((message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
        message.content == null) {
      return [{ ...message, content: [] }];
    }
    return [message];
  }
  const timestamp = new Date(String(entry.timestamp)).getTime();
  if (entry.type === "custom_message") {
    return [{
      role: "custom",
      customType: entry.customType,
      content: entry.content ?? [],
      display: entry.display,
      details: entry.details,
      timestamp,
    }];
  }
  if (entry.type === "branch_summary" && entry.summary) {
    return [{ role: "branchSummary", summary: entry.summary, fromId: entry.fromId, timestamp }];
  }
  if (entry.type === "compaction") {
    return [{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp }];
  }
  return [];
}

export type UniqueMessageAnchor = {
  index: number;
  entryId: string;
  message: unknown;
};

export function uniqueMessageDigestAnchor(
  entries: readonly unknown[],
  messageSha256: string,
): UniqueMessageAnchor | null {
  let anchor: UniqueMessageAnchor | null = null;
  let digestMatches = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object") continue;
    const entryId = ownValue(entry, "id");
    if (typeof entryId !== "string" || !entryId) continue;
    const messages = sessionEntryMessages(entry as Record<string, unknown>);
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      let digest = "";
      try { digest = evidenceSha256(messages[messageIndex]); } catch { continue; }
      if (digest !== messageSha256) continue;
      digestMatches += 1;
      anchor = { index, entryId, message: messages[messageIndex] };
    }
  }
  if (digestMatches !== 1 || !anchor) return null;
  let identityMatches = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (ownValue(entries[index], "id") === anchor.entryId) identityMatches += 1;
  }
  return identityMatches === 1 ? anchor : null;
}

export function emptyActiveContextState(sessionId: string): ActiveContextState {
  if (!sessionId) throw new Error("Active context requires a Pi session ID");
  return {
    version: 1,
    sessionId,
    revision: 0,
    folds: [],
    expanded: [],
    protected: [],
    tokensSinceToolFold: 0,
    leases: {},
    advisory: { highWater: 0, delivered: {} },
  };
}

export function usefulBrief(
  value: unknown,
  maximum = ACTIVE_CONTEXT_POLICY.maxBriefChars,
  toolName = DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
): value is string {
  if (typeof value !== "string") return false;
  const brief = value.trim();
  if (!brief || brief.length > maximum) return false;
  const factualLines: string[] = [];
  const lines = brief.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text || text.toLowerCase().includes(toolName.toLowerCase()) ||
        /^\[[^\]]*(?:fold|active-context)[^\]]*\]$/i.test(text)) continue;
    if (/^(?:topology\b|expand\b|refold\b|list(?:\/page)?\b|page\b|action\b|fold(?:ed)?\s+(?:placeholder|uid|id)\b|(?:this\s+)?fold\b.*\b(?:expand|refold|placeholder|topology|uid|id)\b|(?:parent|children?|previous|next|navigation)\s*[:=])/i.test(text)) continue;
    factualLines.push(text);
  }
  const factual = factualLines.join(" ").trim();
  return /[A-Za-z0-9]{3,}/.test(factual);
}

export function structurallyValidBrief(value: unknown, maximum = ACTIVE_CONTEXT_POLICY.maxBriefChars): value is string {
  if (typeof value !== "string") return false;
  const brief = value.trim();
  return Boolean(brief) && brief.length <= maximum &&
    (brief.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 3;
}
