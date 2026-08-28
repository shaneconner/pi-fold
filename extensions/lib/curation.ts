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
  pinned: number;
  suspended: string | null;
  foldCommand: string;
  editorCommand: string;
}): string {
  const brand = contextBrand(input.brand ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const n = (value: number): string => Math.round(value).toLocaleString("en-US");
  const lines: string[] = [`[${brand} status]`];

  if (input.usedTokens === null || !(input.budgetTokens > 0)) {
    // "provider" is infrastructure vocabulary and "sets it" names no observable event.
    lines.push("  Window   not measured yet; the first model response will measure it.");
  } else {
    const share = input.usedTokens / input.budgetTokens;
    const filled = Math.max(0, Math.min(STATUS_BAR_WIDTH, Math.round(share * STATUS_BAR_WIDTH)));
    const bar = `${"▇".repeat(filled)}${"░".repeat(STATUS_BAR_WIDTH - filled)}`;
    lines.push(`  Window   ${bar}  ${Math.round(share * 100)}%  ` +
      `${n(input.usedTokens)} / ${n(input.budgetTokens)} tokens`);
    const commitAt = input.commitAtShare * input.budgetTokens;
    // The headroom is what a person actually wants: not the trigger's share, but how much
    // further this session goes before anything happens to it.
    //
    // A SUSPENDED SESSION IS PROMISED NOTHING. This line used to say "the next pass folds
    // down toward 20%" one line above "Automatic folding is suspended", so the surface
    // contradicted itself about the only thing the reader opened it to find out.
    lines.push(input.suspended
      ? `           At the ${Math.round(input.commitAtShare * 100)}% commit point.`
      : share >= input.commitAtShare
        ? `           At the ${Math.round(input.commitAtShare * 100)}% commit point; ` +
          `folding now targets ${Math.round(input.aimShare * 100)}%.`
        // "Commits at 80%" reads for a beat as a plural noun, or as a verb with no
        // subject, and the missing subject is the PRODUCT: no surface anywhere said the
        // runtime folds BY ITSELF, so a reader assembling this line with "/fold commits
        // them now" concludes they have installed a manual tool.
        : `           Folds automatically at ${Math.round(input.commitAtShare * 100)}%; ` +
          `${n(commitAt - input.usedTokens)} tokens away.`);
  }
  // THE STOP SITS DIRECTLY UNDER THE WINDOW, not below three rows of routine counts.
  // The order answers the reader's questions in the order they ask them: are we at the
  // threshold, will anything fold, and why not.
  if (input.suspended) {
    lines.push("  STOPPED  Automatic folding is suspended.");
    lines.push(`           Reason: ${oneLine(input.suspended, 160)}`);
  }

  // VISIBLE FIRST, AND THE UNIT NAMED. The always-on line counts visible roots and this
  // one led with the total, so the two surfaces looked like they disagreed about how many
  // folds exist. "Top level" is tree-implementation language; "visible" is what a reader
  // can check against the editor in front of them.
  lines.push(input.totalFolds === 0
    ? "  Folded   nothing yet."
    // "Each keeps its exact source" says the bytes survive but never says a SUMMARY stands
    // where they were, and the likeliest wrong model a reader forms is that folded
    // material is simply gone. One clause teaches what a fold actually is.
    : `  Folded   ${n(input.roots)} here, ${n(input.totalFolds)} with nesting; ` +
      "each a summary over its exact source.");

  if (input.stagedMarks > 0) {
    // TWO CORRECTIONS IN ONE LINE.
    //
    // It said "holding about 28,400 tokens" about a number that is the sum of
    // markFreedBytes: what a commit FREES, which is the same figure the editor header
    // prints as "frees". One surface called it held and the other called it freed, and
    // held was the wrong one.
    //
    // And the brief count is gone, input field and all. It counted provenance "supplied"
    // or "augmented", and a brief the USER types on the editor's brief line is "supplied",
    // so the row told a person the sentence they had just written was somebody else's.
    // Nothing on any surface can add a brief to an already-staged mark either, so it was
    // a number that could be wrong and could not be acted on.
    //
    // What remains leads with the fact that stops "staged" being read as "already
    // applied", and fits inside 80 columns, where the old 105-character line wrapped with
    // its continuation flush left inside the label field, reading as a fifth label.
    lines.push(`  Staged   ${n(input.stagedMarks)} fold${input.stagedMarks === 1 ? "" : "s"}; ` +
      `nothing moves until a commit frees about ${n(input.stagedTokens)} tokens.`);
  }
  if (input.pinned > 0) {
    lines.push(`  Pinned   ${n(input.pinned)} entr${input.pinned === 1 ? "y" : "ies"} ` +
      `stay${input.pinned === 1 ? "s" : ""} raw; ` +
      `${input.pinned === 1 ? "it does" : "they do"} not free space.`);
  }
  // The closing line offers only what is actually available: proposing a commit with
  // nothing staged is an instruction that does nothing, which is the failure the deleted
  // fence made unforgivable.
  // "commits them" took its antecedent from whichever row happened to come last, which is
  // Pinned as often as Staged. Name the object.
  lines.push(input.stagedMarks > 0
    // 78, not 80: pi-tui wraps at width minus two, so an 80-column line still wraps on an
    // 80-column terminal, and its continuation lands flush left in the label field.
    ? `  ${input.foldCommand} commits the staged folds; ${input.editorCommand} opens the window to steer it.`
    // THE FRESH SESSION IS WHERE THE WRONG MODEL FORMS, so this is the line that has to
    // say folding is automatic. A reader who meets the package here and reads only
    // command names concludes nothing happens unless they type one.
    : `  Folding is automatic; ${input.editorCommand} shows the window and ${input.foldCommand} commits early.`);
  return lines.join("\n");
}
