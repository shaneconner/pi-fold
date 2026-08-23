import { boundReceiptText } from "./measurement.ts";
import {
  contextBrand,
  CONTEXT_MARK_RESPONSE_BYTES,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_CONTEXT_RECEIPTS,
} from "./policy.ts";

/**
 * WHERE THE AGENT STANDS AGAINST THE NEXT COMMIT (Shane, 2026-08-22).
 *
 * The answer to every mark is the arithmetic of the epoch it is heading for: what the
 * commit has to free, what these marks will free when it runs, and what the ladder will
 * take by staleness if nothing else is marked. Ten to seventeen spans is a whole epoch's
 * drop at a real serving budget, and one call carries sixty-four, so the number is worth
 * stating: it turns marking from a gesture into something an agent can finish.
 */
export function markAwarenessText(input: {
  held: ReadonlyArray<{ id: string; kind: string; tokens: number }>;
  remainder: { spans: number; tokens: number; share: number; candidates: ReadonlyArray<{ id: string; tokens: number }> };
  coverage?: { targetTokens: number; markedTokens: number; remainingTokens: number; covered: boolean };
  claims?: { pinnedTokens: number; pinnedRefs: number; unclaimedTokens: number };
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const { remainder, coverage, claims } = input;
  const held = input.held.length
    ? input.held.map((span) => `${span.id} (${span.kind}, about ${span.tokens} tokens)`).join("; ")
    : "none";
  const candidates = remainder.candidates.length
    ? remainder.candidates.map((item) => `${item.id} (about ${item.tokens} tokens)`).join("; ")
    : "none";
  const lines = [
    `[${brand} marks] Held until they age out or the next fold event: ${held}.`,
  ];
  if (coverage && coverage.targetTokens > 0) {
    lines.push(coverage.covered
      ? `Your marks cover the next commit: it needs to free about ${coverage.targetTokens} tokens ` +
        `and they free about ${coverage.markedTokens}, so nothing will be folded automatically ` +
        "unless the window grows before then."
      : `The next commit must free about ${coverage.targetTokens} tokens; your marks free about ` +
        `${coverage.markedTokens}, leaving about ${coverage.remainingTokens} tokens the ladder ` +
        "will take from the stale end with deterministic briefs. Both numbers are as of now and " +
        "rise as new results arrive.");
  }
  if (claims && claims.pinnedTokens > 0) {
    lines.push(
      `Pinned and held raw: about ${claims.pinnedTokens} tokens across ${claims.pinnedRefs} entry(s). ` +
        "A pin keeps a span expanded and out of every fold, and it frees nothing, so the drop " +
        "above still has to come from what is left.");
  }
  lines.push(
    `Unmarked remainder: ${remainder.spans} span(s), about ${remainder.tokens} tokens of stale mass, ` +
      `${Math.round(remainder.share * 100)}% of the non-fresh window.`,
    `Largest unmarked by reclaim value: ${candidates}.`,
    `Mark several spans in one ${input.toolName} call, and pin anything you want kept expanded: ` +
      `${input.toolName} {"action":"pin","ids":["<entry-id>"]}. One call either way, and this ` +
      "whole picture comes back with it.",
  );
  return boundReceiptText(lines.join("\n"), CONTEXT_MARK_RESPONSE_BYTES,
    `[${brand} marks] Held; the remainder is unavailable this pass.`);
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
      `Pinning: ${input.toolName} {"action":"pin","ids":["<entry-id>"]} holds entries raw through ` +
        `every fold, and {"action":"unpin"} releases them. Pinned context is ${pinnedPercent}% of ` +
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
  /** Occupancy at which the epoch fires, which is what "imminent" is measured against. */
  triggerTokens: number;
  inflowTokens: number;
  candidates: ReadonlyArray<{ id: string; tokens: number }>;
  coverage?: { targetTokens: number; markedTokens: number; remainingTokens: number; covered: boolean };
  claims?: { pinnedTokens: number; pinnedRefs: number; unclaimedTokens: number };
  pendingAgentMarks: number;
  eligibleMarks: number;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const headroom = Math.max(0, input.triggerTokens - input.usedTokens);
  const coverage = input.coverage;
  const lines = [
    `[${brand} steward] A fold commit is imminent: about ${headroom} tokens of room remain ` +
      `before it fires, and recent requests have grown by about ${input.inflowTokens} tokens each, ` +
      "so this may be your last turn to choose what folds and what its brief says.",
  ];
  if (coverage && coverage.targetTokens > 0) {
    lines.push(coverage.covered
      ? `That commit must free about ${coverage.targetTokens} tokens and your marks already cover ` +
        "it, so nothing will be chosen for you unless the window grows first."
      : `That commit must free about ${coverage.targetTokens} tokens. Your marks cover about ` +
        `${coverage.markedTokens}; the remaining ${coverage.remainingTokens} will be taken from the ` +
        "stale end by age, with briefs written by the runtime rather than by you.");
  }
  if (input.candidates.length) {
    lines.push(
      "Finished units you have not marked, largest first: " +
        input.candidates.map((item) => `${item.id} (about ${item.tokens} tokens)`).join("; ") + ".",
      "Mark them now, as many as you like in ONE call, each with the brief you want its " +
        `placeholder to carry: ${input.toolName} ` +
        '{"action":"fold","marks":[{"ids":["<start>","<end>"],"brief":"<factual brief>"},' +
        '{"ids":["<start>","<end>"],"brief":"<factual brief>"}]}. ' +
        "A brief you write is what you will read later; a brief the runtime writes is a summary " +
        "of shape rather than of meaning. Peek returns any fold's exact bytes afterwards, so " +
        "marking loses nothing.",
      `Anything you want to keep EXPANDED, pin instead: ${input.toolName} ` +
        '{"action":"pin","ids":["<entry-id>"]} holds those entries raw through every fold. ' +
        "A pin frees nothing, so the commit still takes its drop from whatever is left.",
    );
  }
  if (input.claims && input.claims.pinnedTokens > 0) {
    lines.push(`Already pinned and held raw: about ${input.claims.pinnedTokens} tokens ` +
      `across ${input.claims.pinnedRefs} entry(s).`);
  }
  lines.push(
    `${input.pendingAgentMarks} of your mark(s) pending; ${input.eligibleMarks} mark(s) eligible now.`);
  return boundReceiptText(
    lines.join("\n"),
    2_048,
    `[${brand} steward] A fold commit is imminent; details are unavailable this pass.`,
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
      ? `${receipt.protectedBytes} byte(s) stay pinned; unpin releases them when the work moves on.`
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
    "{\"action\":\"reboundary\",\"id\":\"<fold-id>\"} returns a mis-cut fold to raw so you can " +
    "fold the span you meant.";
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
