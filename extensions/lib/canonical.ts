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

export function boundedUtf8(text: string, maximumBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maximumBytes) return text;
  // A multi-byte sequence cut by the bound decodes to one trailing replacement
  // character; dropping it keeps the slice an exact prefix of the source.
  return buffer.subarray(0, maximumBytes).toString("utf8").replace(/\uFFFD$/, "");
}

/**
 * The suffix of `text` beginning at a byte offset. A multi-byte sequence cut by the
 * offset decodes to one leading replacement character; dropping it keeps the slice an
 * exact suffix of the source, which is what makes a paged peek losslessly rejoinable.
 */
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

/** Pi's exact one-entry projection, kept local so this service has no second transcript owner. */
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
