import { boundReceiptText } from "./measurement.ts";
import { oneLine } from "./selection.ts";
import {
  contextBrand,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  FOLD_NOTICE_BYTES,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_CONTEXT_RECEIPTS,
} from "./policy.ts";

/**
 * THE POST-FOLD NOTICE: THE ONE MOMENT THE AGENT KNOWS SOMETHING THE RUNTIME DOES NOT.
 *
 * The runtime has just cut folds behind the agent, out of material the agent is still
 * looking at. It knows the spans, the sizes and the staleness; it does not know why any
 * of it mattered. So the notice states what was cut and asks for exactly one thing, a
 * brief, and it states the price of answering, which is nothing: the folds it names are
 * PENDING, so a brief written now is stored outside the projection and reaches the window
 * only when the commit writes that placeholder for the first time.
 *
 * It is batched rather than continuous. One notice per cut is noise, and noise is how
 * guidance gets ignored; this one appears when enough folds are standing unbriefed to be
 * worth a turn's attention, and it is ephemeral, so it never accumulates.
 */
export function foldNoticeText(input: {
  unbriefed: ReadonlyArray<{ id: string; kind: string; tokens: number; brief?: string }>;
  pending: number;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  // THE INSTRUCTION IS SEATED BEFORE THE LIST, and the list is what gives when the
  // notice runs out of room. The first cut of this built one string with the ids in the
  // opening line and handed the whole thing to the bound, so a seven-fold batch spent its
  // budget on ids and lost "here is how to answer" off the end: the agent was told which
  // folds were unbriefed and not told that briefing them was free, which is the only fact
  // in here it cannot work out for itself. Fold count grows without limit and the
  // instruction does not, so the instruction is fixed and the ids are the variable part.
  const head = [
    `[${brand} folds] ${input.unbriefed.length} of your ${input.pending} pending fold(s) carry ` +
      "no brief yet. These spans are cut but NOT folded: every byte they cover is still in " +
      "front of you exactly as it was, and they enter your window only when a commit " +
      "applies them.",
    `Give each one a sentence: ${input.toolName} {"action":"brief","id":"<fold-id>","brief":"..."}. ` +
      "You know why the span mattered and what you will want back from it; the automatic " +
      "brief reads the span alone and does not. Writing it now costs your window nothing, " +
      "because the fold is not in your window yet.",
    `Wrong boundary? ${input.toolName} {"action":"reboundary","ids":[...]} re-cuts it. ` +
      `Should not be taken at all? ${input.toolName} {"action":"unmark","ids":["<fold-id>"]}.`,
  ].join("\n");
  // WHAT IT COULD NOT NAME, IT COUNTS (gate 136's law, and gate 115's shape one level
  // out): a list that stops early and says nothing reads as a complete list.
  // EACH ROW IDENTIFIES ITS SPAN. The pending mark carries the deterministic brief the
  // runtime cut it with, and a notice that withholds it makes the agent guess: the
  // dogfooded 1M session answered "I need to brief three pending folds. What are they?
  // Likely: ..." from memory, and a wrong guess writes an accurate-sounding brief onto
  // the wrong fold. The head is the identification; the agent adds what it cannot know.
  const NOTICE_ROW_CHARS = 160;
  const entries = input.unbriefed
    .map((fold) => `${fold.id} (${fold.kind}, ~${fold.tokens} tokens)` +
      (fold.brief ? `: ${oneLine(fold.brief, NOTICE_ROW_CHARS)}` : ""));
  const overflowText = (seated: number) =>
    `${input.toolName} {"action":"status"} lists the other ${input.unbriefed.length - seated}.`;
  let seated = entries.length;
  let list = `Unbriefed: ${entries.join("; ")}.`;
  while (seated > 0 && Buffer.byteLength(`${head}\n${list}`, "utf8") > FOLD_NOTICE_BYTES) {
    seated -= 1;
    list = seated === 0
      ? overflowText(0)
      : `Unbriefed: ${entries.slice(0, seated).join("; ")}. ${overflowText(seated)}`;
  }
  return boundReceiptText(`${head}\n${list}`, FOLD_NOTICE_BYTES,
    `[${brand} folds] Pending folds are waiting for briefs; the list is unavailable this pass.`);
}

/**
 * THE WORKING MEMORY'S TABLE OF CONTENTS (Shane, 2026-08-26). One copy rides the
 * projection, refreshed at each commit by the carrier freeze: keys only, freshest first,
 * because the bodies live in state and are read on demand. The instruction is fixed and
 * the key list is the variable part, exactly as the fold notice above, and a list that
 * stops early counts what it dropped (gate 136's law). It shares FOLD_NOTICE_BYTES: both
 * are one-glance carriers and a second bound would be a knob with no second job.
 */
export function memoryTocText(input: {
  entries: ReadonlyArray<{ key: string; chars: number }>;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const head = [
    `[${brand} memory] Your working memory holds ${input.entries.length} ` +
      `entr${input.entries.length === 1 ? "y" : "ies"}, freshest first.`,
    `Read any of them with ${input.toolName} {"action":"recall","keys":["<key>"]}. ` +
      `Update an entry whose facts have changed, or add one, with ${input.toolName} ` +
      '{"action":"remember","key":"<key>","body":"..."}; an empty body removes the entry.',
  ].join("\n");
  const rows = input.entries.map((entry) => `${entry.key} (${entry.chars} chars)`);
  const overflowText = (seated: number) =>
    `${input.toolName} {"action":"recall"} lists the other ${input.entries.length - seated}.`;
  let seated = rows.length;
  let list = `Entries: ${rows.join("; ")}.`;
  while (seated > 0 && Buffer.byteLength(`${head}\n${list}`, "utf8") > FOLD_NOTICE_BYTES) {
    seated -= 1;
    list = seated === 0
      ? overflowText(0)
      : `Entries: ${rows.slice(0, seated).join("; ")}. ${overflowText(seated)}`;
  }
  return boundReceiptText(`${head}\n${list}`, FOLD_NOTICE_BYTES,
    `[${brand} memory] Working memory has entries; the list is unavailable this pass.`);
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
