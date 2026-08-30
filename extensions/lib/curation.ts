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
 * THE PRE-COMMIT NOTICE: STATUS AT THE ONE MOMENT IT CAN STILL BE ACTED ON (2026-08-30).
 *
 * WHAT THIS REPLACED, AND WHY. Until 2026-08-30 this carrier was a brief SOLICITATION.
 * It fired on a count of unbriefed folds and its middle sentence read "You know why the
 * span mattered and what you will want back from it; the automatic brief reads the span
 * alone and does not." That is flattery in the shape of an instruction: it tells the
 * model it holds knowledge the runtime lacks at a moment when its actual grounds are a
 * fold id, a kind and a 160-character head. sol-20260826-full2 priced the result. Agent
 * briefs drew 3 correct against 9 wrong, the worst of every draw on the campaign, with
 * the errors tracking the annotations, which is why postFoldNotice was defaulted false
 * on 2026-08-28 rather than fixed. Shane, 2026-08-30: agent-provided briefs "spent
 * tokens to confuse themselves", so the carrier should be "less of a suggestion to add
 * briefs and more informatory".
 *
 * SO IT STATES AND DOES NOT ASK. Every sentence here is a fact the runtime measured:
 * where the commit fires, how far away it is, what is staged, how much that frees, what
 * is pinned and what the pin costs. The verbs are a REFERENCE LIST, seated last and
 * carrying no argument for using any of them. The agent is told what is true and what it
 * may do; it is not told that it knows something.
 *
 * IT SPEAKS ONCE PER APPROACH. The trigger is occupancy, not a fold count, and the caller
 * latches it on the crossing, so a window that sits in the band for twenty passes gets
 * one notice rather than twenty. It is ephemeral, so it never accumulates.
 *
 * THREE CORRECTIONS OF FACT the old copy could not carry, all of them load-bearing:
 * pinning is not preservation (folding already preserves; a pin keeps bytes RAW AND IN
 * VIEW and frees nothing), a staged span has not moved yet, and the headroom figure says
 * whether it was measured or estimated rather than presenting either as the other.
 */
export function foldNoticeText(input: {
  staged: ReadonlyArray<{ id: string; kind: string; tokens: number; brief?: string; briefed?: boolean }>;
  freedTokens: number;
  briefedCount: number;
  pinnedEntries: number;
  pinnedShare: number;
  maxPinnedShare: number;
  headroomTokens: number;
  commitAtShare: number;
  measured: boolean;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const n = (value: number): string => Math.round(value).toLocaleString("en-US");
  const pct = (share: number): string => `${Math.round(share * 100)}%`;
  // THE STATUS IS SEATED BEFORE THE LIST, and the list is what gives when the notice runs
  // out of room. Inherited unchanged from the solicitation, for the same reason: fold
  // count grows without limit and the status does not, so a wide batch must not be able
  // to push the facts off the end and leave a bare row of ids behind.
  //
  // MEASURED OR ESTIMATED, NAMED. The runtime's own law is that an estimate may schedule
  // work and may not veto a request; scheduling this notice off an estimate is squarely
  // inside that, but presenting an estimate as a count is not, so the basis rides along.
  const status = [
    `[${brand} folds] A commit fires at ${pct(input.commitAtShare)} of the serving budget: ` +
      `about ${n(input.headroomTokens)} tokens of headroom left ` +
      `(${input.measured ? "provider-measured" : "estimated; no provider count yet"}).`,
    `Staged: ${n(input.staged.length)} fold${input.staged.length === 1 ? "" : "s"}` +
      `, ${n(input.briefedCount)} carrying a brief you wrote` +
      `, freeing about ${n(input.freedTokens)} tokens when the commit applies them.`,
  ];
  if (input.pinnedEntries > 0) {
    status.push(`Pinned: ${n(input.pinnedEntries)} ` +
      `entr${input.pinnedEntries === 1 ? "y" : "ies"} held raw, ` +
      `${pct(input.pinnedShare)} of the window against a ${pct(input.maxPinnedShare)} cap.`);
  }
  status.push(
    "Nothing has moved yet: every byte these spans cover is still in front of you, and a " +
      "staged fold enters your window only when the commit applies it. Folded material " +
      "stays exactly recoverable through peek. A pin holds an entry raw and in view and " +
      "frees nothing toward the commit, so pinned mass makes the rest fold sooner.",
    `Verbs: ${input.toolName} {"action":"status"} · {"action":"brief","id":"<fold-id>","brief":"..."} · ` +
      '{"action":"reboundary","ids":[...]} · {"action":"unmark","ids":["<fold-id>"]} · ' +
      '{"action":"pin","ids":["<entry-id>"]} · {"action":"unpin","ids":["<entry-id>"]}.',
  );
  const head = status.join("\n");
  // WHAT IT COULD NOT NAME, IT COUNTS (gate 136's law, and gate 115's shape one level
  // out): a list that stops early and says nothing reads as a complete list.
  // EACH ROW IDENTIFIES ITS SPAN. The pending mark carries the deterministic brief the
  // runtime cut it with, and a notice that withholds it makes the agent guess: the
  // dogfooded 1M session answered "I need to brief three pending folds. What are they?
  // Likely: ..." from memory, and a wrong guess writes an accurate-sounding brief onto
  // the wrong fold. The row is the identification, and it now names EVERY staged fold
  // rather than only the unbriefed ones, because this is a status: a list that silently
  // omitted the briefed folds would understate what the commit is about to take.
  const NOTICE_ROW_CHARS = 160;
  const entries = input.staged
    .map((fold) => `${fold.id} (${fold.kind}, ~${fold.tokens} tokens` +
      `${fold.briefed ? ", briefed" : ""})` +
      (fold.brief ? `: ${oneLine(fold.brief, NOTICE_ROW_CHARS)}` : ""));
  const overflowText = (seated: number) =>
    `${input.toolName} {"action":"status"} lists the other ${input.staged.length - seated}.`;
  let seated = entries.length;
  let list = `Staged spans: ${entries.join("; ")}.`;
  while (seated > 0 && Buffer.byteLength(`${head}\n${list}`, "utf8") > FOLD_NOTICE_BYTES) {
    seated -= 1;
    list = seated === 0
      ? overflowText(0)
      : `Staged spans: ${entries.slice(0, seated).join("; ")}. ${overflowText(seated)}`;
  }
  return boundReceiptText(`${head}\n${list}`, FOLD_NOTICE_BYTES,
    `[${brand} folds] A commit is approaching; the staged list is unavailable this pass.`);
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
