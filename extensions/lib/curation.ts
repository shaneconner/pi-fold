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

const STATUS_BAR_WIDTH = 24;

/**
 * /fold-status: THE TEXT VIEW, FOR A PERSON.
 *
 * What this replaced said, in full: "Active context: 12 fold(s), roots a1b2, c3d4. Use
 * pi_fold_context status for exact recursive actions." Three things were wrong with it.
 * It told a HUMAN to call an AGENT tool they have no way to invoke. It printed fold ids,
 * which are addresses for a machine and noise for a reader. And it answered a question
 * nobody asks (how many folds exist) while leaving the only ones they do ask unanswered:
 * how full am I, when does something happen, and what can I do about it.
 *
 * The command survives rather than being deleted because it is the documented fallback
 * when /fold-editor cannot open, which is any session without an interactive UI. That
 * makes it the ONLY window view some deployments ever get, so it carries what the editor
 * header carries and closes by naming the two commands that act.
 *
 * Occupancy is stated as the provider's own measurement when there is one, and as
 * "not measured yet" when there is not. It is never guessed: a made-up percentage is
 * worse than an absent one, and this runtime has already paid once for treating an
 * estimate as though it were a fact.
 */
export function foldStatusText(input: {
  brand?: string;
  usedTokens: number | null;
  budgetTokens: number;
  commitAtShare: number;
  aimShare: number;
  roots: number;
  totalFolds: number;
  stagedMarks: number;
  stagedTokens: number;
  briefedMarks: number;
  pinned: number;
  suspended: string | null;
  foldCommand: string;
  editorCommand: string;
}): string {
  const brand = contextBrand(input.brand ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const n = (value: number): string => Math.round(value).toLocaleString("en-US");
  const lines: string[] = [`[${brand} status]`];

  if (input.usedTokens === null || !(input.budgetTokens > 0)) {
    lines.push("  Window   not measured yet; the first provider response sets it.");
  } else {
    const share = input.usedTokens / input.budgetTokens;
    const filled = Math.max(0, Math.min(STATUS_BAR_WIDTH, Math.round(share * STATUS_BAR_WIDTH)));
    const bar = `${"▇".repeat(filled)}${"░".repeat(STATUS_BAR_WIDTH - filled)}`;
    lines.push(`  Window   ${bar}  ${Math.round(share * 100)}%  ` +
      `${n(input.usedTokens)} / ${n(input.budgetTokens)} tokens`);
    const commitAt = input.commitAtShare * input.budgetTokens;
    // The headroom is what a person actually wants: not the trigger's share, but how much
    // further this session goes before anything happens to it.
    lines.push(share >= input.commitAtShare
      ? `           At the commit point (${Math.round(input.commitAtShare * 100)}%); ` +
        `the next pass folds down toward ${Math.round(input.aimShare * 100)}%.`
      : `           Commits at ${Math.round(input.commitAtShare * 100)}%, ` +
        `${n(commitAt - input.usedTokens)} tokens away.`);
  }

  lines.push(input.totalFolds === 0
    ? "  Folded   nothing yet."
    : `  Folded   ${n(input.totalFolds)} fold${input.totalFolds === 1 ? "" : "s"}` +
      `, ${n(input.roots)} at the top level. Every one keeps its exact source.`);

  if (input.stagedMarks > 0) {
    // Staged mass is the number that explains the next commit's size, and "costs nothing
    // until then" is the fact a reader needs to not act on it prematurely.
    const briefed = input.briefedMarks > 0
      ? `${n(input.briefedMarks)} with a written brief`
      : input.stagedMarks === 1 ? "carrying the runtime's own brief" : "all carrying runtime briefs";
    lines.push(`  Staged   ${n(input.stagedMarks)} mark${input.stagedMarks === 1 ? "" : "s"}` +
      ` holding about ${n(input.stagedTokens)} tokens, ${briefed}.` +
      `${input.stagedMarks === 1 ? " It moves" : " They move"} nothing until a commit.`);
  }
  if (input.pinned > 0) {
    lines.push(`  Pinned   ${n(input.pinned)} entr${input.pinned === 1 ? "y" : "ies"} held raw, ` +
      "never folded and freeing nothing.");
  }
  if (input.suspended) {
    lines.push(`  STOPPED  Automatic folding is suspended: ${oneLine(input.suspended, 160)}`);
  }
  // The closing line offers only what is actually available: proposing a commit with
  // nothing staged is an instruction that does nothing, which is the failure the deleted
  // fence made unforgivable.
  lines.push(input.stagedMarks > 0
    ? `  ${input.foldCommand} commits them now; ${input.editorCommand} opens the window to steer it.`
    : `  ${input.editorCommand} opens the window; ${input.foldCommand} commits once marks are staged.`);
  return lines.join("\n");
}
