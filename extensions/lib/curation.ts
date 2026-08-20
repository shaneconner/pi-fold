import { boundReceiptText } from "./measurement.ts";
import {
  contextBrand,
  CONTEXT_MARK_RESPONSE_BYTES,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_CONTEXT_RECEIPTS,
} from "./policy.ts";

export function markAwarenessText(input: {
  held: ReadonlyArray<{ id: string; kind: string; tokens: number }>;
  remainder: { spans: number; tokens: number; share: number; candidates: ReadonlyArray<{ id: string; tokens: number }> };
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const { remainder } = input;
  const held = input.held.length
    ? input.held.map((span) => `${span.id} (${span.kind}, about ${span.tokens} tokens)`).join("; ")
    : "none";
  const candidates = remainder.candidates.length
    ? remainder.candidates.map((item) => `${item.id} (about ${item.tokens} tokens)`).join("; ")
    : "none";
  return boundReceiptText([
    `[${brand} marks] Held until they age out or the next fold event: ${held}.`,
    `Unmarked remainder: ${remainder.spans} span(s), about ${remainder.tokens} tokens of stale mass, ` +
      `${Math.round(remainder.share * 100)}% of the non-fresh window.`,
    `Largest unmarked by reclaim value: ${candidates}.`,
    `Mark several spans in one ${input.toolName} call: one call, and this whole picture comes back with it.`,
  ].join("\n"), CONTEXT_MARK_RESPONSE_BYTES, `[${brand} marks] Held; the remainder is unavailable this pass.`);
}

export function contextRiderText(input: {
  toolName: string;
  brandNoun?: string;
  pendingAgentMarks: number;
  eligibleMarks: number;
  freedTokens: number;
  eligibleFreedTokens: number;
  anchors: string[];
  pinnedShare: number;
  maxPinnedShare: number;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const anchors = input.anchors.length
    ? input.anchors.slice(0, 3).join(", ")
    : "none";
  const pinnedPercent = Math.round(input.pinnedShare * 100);
  const capPercent = Math.round(input.maxPinnedShare * 100);
  return boundReceiptText(
    [
      `[${brand} notice] A fold commit just landed; the next one will batch every pending mark ` +
        "into one rewrite, and marks are free until then.",
      "Mark FINISHED units at their clean boundaries; batches beat singles: " +
        `${input.toolName} {"action":"fold","marks":[{"ids":["<start>","<end>"],"brief":"<factual brief>"}]} ` +
        "carries several decisions into that single rewrite, each keeping your brief instead of a " +
        `generated one. ${input.pendingAgentMarks} of your mark(s) pending; ` +
        `${input.eligibleMarks} mark(s) eligible now, freeing about ${input.eligibleFreedTokens} ` +
        `of the ${input.freedTokens} marked token(s).`,
      `Completed units ready to mark, largest first: ${anchors}.`,
      `Pinning: ${input.toolName} {"action":"protect","ids":["<entry-id>"]} holds entries raw through ` +
        `every fold, and {"action":"unprotect"} releases them. Pinned context is ${pinnedPercent}% of ` +
        `the working window against a ${capPercent}% cap; at the cap, protect refuses until ` +
        "something is released.",
    ].join("\n"),
    2_048,
    `[${brand} notice] Post-commit curation details are unavailable this pass.`,
  );
}

export function stewardAdvisoryText(input: {
  toolName: string;
  brandNoun?: string;
  usedTokens: number;
  budgetTokens: number;
  inflowTokens: number;
  candidates: ReadonlyArray<{ id: string; tokens: number }>;
  rebriefTargets: ReadonlyArray<{ id: string; kind: string }>;
  pendingAgentMarks: number;
  eligibleMarks: number;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const headroom = Math.max(0, input.budgetTokens - input.usedTokens);
  const lines = [
    `[${brand} steward] The next automatic fold epoch is close: about ${headroom} tokens of ` +
      `headroom remain against a ${input.budgetTokens}-token serving budget, and recent requests ` +
      `have grown by about ${input.inflowTokens} tokens each.`,
  ];
  if (input.candidates.length) {
    lines.push(
      "Unmarked completed units, largest first: " +
        input.candidates.map((item) => `${item.id} (about ${item.tokens} tokens)`).join("; ") + ".",
      "Mark finished units now with your own briefs, several in one call: " +
        `${input.toolName} {"action":"fold","marks":[{"ids":["<start>","<end>"],"brief":"<factual brief>"}]}. ` +
        "Whatever stays unmarked will be folded automatically at the epoch with a deterministic brief.",
    );
  }
  if (input.rebriefTargets.length) {
    lines.push(
      "Standing folds carrying deterministic briefs, newest first: " +
        input.rebriefTargets.map((fold) => `${fold.id} (${fold.kind})`).join("; ") + ".",
      `Replace any with your own factual brief: ${input.toolName} ` +
        '{"action":"rebrief","id":"<fold-id>","brief":"<factual brief>"}. ' +
        "Your brief rides the placeholder and index from the next request on; write it while " +
        "you still remember what the fold holds.",
    );
  }
  lines.push(
    `${input.pendingAgentMarks} of your mark(s) pending; ${input.eligibleMarks} mark(s) eligible now.`);
  return boundReceiptText(
    lines.join("\n"),
    2_048,
    `[${brand} steward] The next automatic fold epoch is close; details are unavailable this pass.`,
  );
}

export interface ContextReceipt {
  kind: string;
  ordinal: number;
  trigger: string | null;
  foldsCommitted: number;
  foldsCreated: number;
  freedTokens: number;
  occupancyBefore: number | null;
  occupancyAfter: number | null;
  spansFolded: number;
  toolResultsFolded: number;
  splitFolds: number;
  splitFromChars: number;
  absorbedWedges: number;
  recovered: boolean;
  protectedBytes: number;
  note: string | null;
}

export function contextReceipt(input: Partial<ContextReceipt> & { kind: string; ordinal: number }): ContextReceipt {
  return {
    kind: input.kind,
    ordinal: input.ordinal,
    trigger: input.trigger ?? null,
    foldsCommitted: input.foldsCommitted ?? 0,
    foldsCreated: input.foldsCreated ?? 0,
    freedTokens: input.freedTokens ?? 0,
    occupancyBefore: input.occupancyBefore ?? null,
    occupancyAfter: input.occupancyAfter ?? null,
    spansFolded: input.spansFolded ?? 0,
    toolResultsFolded: input.toolResultsFolded ?? 0,
    splitFolds: input.splitFolds ?? 0,
    splitFromChars: input.splitFromChars ?? 0,
    absorbedWedges: input.absorbedWedges ?? 0,
    recovered: input.recovered ?? false,
    protectedBytes: input.protectedBytes ?? 0,
    note: input.note ?? null,
  };
}

export function withReceipt(
  receipts: readonly ContextReceipt[],
  receipt: ContextReceipt,
  maximum = MAX_CONTEXT_RECEIPTS,
): ContextReceipt[] {
  const next = [...receipts, receipt];
  return next.length > maximum ? next.slice(next.length - maximum) : next;
}

export function receiptLine(receipt: ContextReceipt): string {
  const occupancy = receipt.occupancyBefore !== null && receipt.occupancyAfter !== null
    ? `Occupancy ${receipt.occupancyBefore}→${receipt.occupancyAfter} tokens.`
    : "";
  const folded = receipt.spansFolded || receipt.toolResultsFolded
    ? `${receipt.spansFolded} span(s) folded, ${receipt.toolResultsFolded} tool result(s) folded.`
    : "";
  const parts = [
    `${receipt.kind}${receipt.trigger ? ` (${receipt.trigger})` : ""} at ordinal ${receipt.ordinal}:`,
    receipt.foldsCommitted ? `${receipt.foldsCommitted} mark(s) committed,` : "",
    receipt.foldsCreated ? `${receipt.foldsCreated} fold(s) created,` : "",
    `about ${receipt.freedTokens} tokens freed.`,
    occupancy,
    folded,
    receipt.splitFolds
      ? `A ${receipt.splitFromChars}-char span was split into ${receipt.splitFolds} bite-sized folds.`
      : "",
    receipt.absorbedWedges
      ? `${receipt.absorbedWedges} short stale span(s) wedged between folds were absorbed into their ` +
        "later neighbour rather than left as crumbs."
      : "",
    receipt.recovered
      ? "This ran as overflow recovery: the request would not have been transmissible, and it was rebuilt rather than dropped."
      : "",
    receipt.protectedBytes
      ? `${receipt.protectedBytes} byte(s) stay pinned under protect; unprotect releases them when the work moves on.`
      : "",
    receipt.note ?? "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function receiptBlockText(input: {
  receipts: readonly ContextReceipt[];
  toolName: string;
  brandNoun?: string;
}): string | null {
  if (!input.receipts.length) return null;
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const header =
    `[${brand} actions] Recent automatic context actions, newest last. Exact source remains expandable.`;
  const verbs = `Correct any of it: ${input.toolName} ` +
    "{\"action\":\"expand\",\"id\":\"<fold-id>\"} restores a span in place; " +
    "{\"action\":\"rebrief\",\"id\":\"<fold-id>\",\"brief\":\"<factual brief>\"} replaces a brief that " +
    "does not describe what you needed; {\"action\":\"reboundary\",\"id\":\"<fold-id>\"} returns a " +
    "mis-cut fold to raw so you can fold the span you meant.";
  const fixed = Buffer.byteLength(header, "utf8") + Buffer.byteLength(verbs, "utf8") + 1;
  if (fixed > CONTEXT_RECEIPT_BLOCK_BYTES) {
    return `[${brand} actions] Recent automatic context actions are unavailable this pass.`;
  }
  let remaining = CONTEXT_RECEIPT_BLOCK_BYTES - fixed;
  const kept: string[] = [];
  for (let index = input.receipts.length - 1; index >= 0; index -= 1) {
    const line = receiptLine(input.receipts[index]);
    if (Buffer.byteLength(line, "utf8") + 1 > remaining) {
      if (!kept.length && remaining > 1) kept.push(boundReceiptText(line, remaining - 1, ""));
      break;
    }
    remaining -= Buffer.byteLength(line, "utf8") + 1;
    kept.unshift(line);
  }
  return [header, ...kept, verbs].join("\n");
}
