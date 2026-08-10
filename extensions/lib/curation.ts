import { objectRefKey } from "../json.ts";
import {
  bytes,
  messageRole,
} from "./canonical.ts";
import { boundReceiptText } from "./measurement.ts";
import {
  contextBrand,
  CONTEXT_MARK_RESPONSE_BYTES,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  CURATION_GATE_MAX_ROUNDS,
  CURATION_REMINDER_SHARES,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_CONTEXT_RECEIPTS,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
} from "./policy.ts";

/**
 * Guided curation.
 *
 * The ladder's commit triggers are correct and silent. Silent is the problem: the
 * agent learns that its evidence became placeholders by reading a placeholder, which
 * is the one moment it can no longer do anything about it. So a commit is ANNOUNCED
 * before it happens, early enough that reacting is still cheap, and the announcement
 * carries what is about to happen, what it costs, and the actions that change it.
 *
 * Everything here is deterministic: transcript ordinals, measured tokens and byte
 * counts only. No wall clock and no randomness.
 */

export interface StaleToolMass {
  /** Serialized bytes of tool results outside the fresh tail and outside every fold. */
  bytes: number;
  /** How many tool results that mass is spread over. */
  results: number;
}

/**
 * Tool-result mass a commit could actually reach: outside the fresh tail, outside any
 * protection, and not already owned by a fold. Occupancy alone would announce commits
 * that have nothing to fold; this is the second signal that says the announcement is
 * about to be worth something.
 */
export function staleToolMass(
  snapshot: ActiveContextSnapshot,
  state: ActiveContextState,
): StaleToolMass {
  const owned = new Set(state.folds.flatMap((fold) =>
    fold.parts.flatMap((part) => part.kind === "raw" ? [objectRefKey(part.ref)] : [])));
  let total = 0;
  let results = 0;
  for (const item of snapshot.mapped) {
    if (!item.ref || messageRole(item.message) !== "toolResult") continue;
    if (snapshot.toolProtectedIndices.has(item.index)) continue;
    if (owned.has(objectRefKey(item.ref))) continue;
    total += bytes(item.message);
    results += 1;
  }
  return { bytes: total, results };
}

export interface CurationSignals {
  /** Measured provider tokens as a share of the truthful serving budget; null unmeasured. */
  occupancy: number | null;
  /** The trigger line this occupancy is read against: thresholds.maxTarget. */
  maxTarget: number;
  occupancyTokens: number | null;
  /** THE serving budget: one resolved value, the same one the fence and estimator use. */
  budgetTokens: number;
  window: number;
  /** Stale tool mass as a share of the serving budget, in the session's own tokens. */
  staleToolShare: number;
  staleToolTokens: number;
  staleToolResults: number;
  /** Marks a commit could apply right now. */
  eligibleFolds: number;
}

/**
 * Both signals are measured against ONE resolved serving budget, handed in by the
 * caller that owns the capacity accounting. Nothing here re-derives a window from a
 * descriptor: rep 15's trigger and gate ran the whole run against a 272,000-token
 * per-request descriptor while the fence used the truthful 383,616, because the budget
 * was computed twice from two different places.
 */
export function curationSignals(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  usedTokens: number | null;
  budgetTokens: number;
  /** The resolved serving WINDOW the budget was taken from, reported for audit. */
  window: number;
  /** The session's own measured serialized chars per token; never a fixed constant. */
  charsPerToken: number;
  eligibleFolds: number;
}): CurationSignals {
  const mass = staleToolMass(input.snapshot, input.state);
  const charsPerToken = Number.isFinite(input.charsPerToken) && input.charsPerToken > 0
    ? input.charsPerToken
    : 4;
  const staleToolTokens = Math.ceil(mass.bytes / charsPerToken);
  return {
    maxTarget: input.snapshot.thresholds.maxTarget,
    occupancy: input.usedTokens === null || input.budgetTokens <= 0
      ? null
      : input.usedTokens / input.budgetTokens,
    occupancyTokens: input.usedTokens,
    budgetTokens: input.budgetTokens,
    window: input.window,
    staleToolShare: input.budgetTokens > 0 ? staleToolTokens / input.budgetTokens : 0,
    staleToolTokens,
    staleToolResults: mass.results,
    eligibleFolds: input.eligibleFolds,
  };
}

/**
 * ONE signal. Occupancy of the serving budget reaches maxTarget, and a commit is due.
 *
 * The second signal is gone with the announcement it guarded. It existed because the
 * trigger ANNOUNCED a commit before running one, and announcing a commit that has
 * nothing stale to fold is a false statement in the window; the announcement was
 * deleted when its cache cost was measured, and the AND-condition outlived its reason.
 * A commit with nothing eligible now simply applies nothing and says so, which the
 * reclaim floor and the eligibility accounting already report. Stale mass is still
 * measured and still reported; it is no longer a condition on the trigger.
 */
export function curationTriggerFires(signals: CurationSignals): boolean {
  return signals.occupancy !== null &&
    Number.isFinite(signals.occupancy) &&
    signals.occupancy >= signals.maxTarget;
}

/**
 * The sparse reminders.
 *
 * Two per window cycle, one line each, tail-appended, and informatory. Below the
 * curation threshold NOTHING folds automatically, so the only useful thing to say
 * before the fold event is: mark as you go, and the folds will be neat when it fires.
 * `fired` is the count already spent this cycle; a commit resets it to zero.
 */
export function dueReminderIndex(
  occupancy: number | null,
  fired: number,
  shares: readonly number[] = CURATION_REMINDER_SHARES,
): number | null {
  if (occupancy === null || !Number.isFinite(occupancy)) return null;
  for (let index = Math.max(0, Math.trunc(fired)); index < shares.length; index += 1) {
    if (occupancy >= shares[index]) return index;
  }
  return null;
}

export function curationReminderText(input: {
  signals: CurationSignals;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const occupancy = input.signals.occupancy === null
    ? "unmeasured"
    : `${Math.round(input.signals.occupancy * 100)}%`;
  return `[${brand} curation] Occupancy ${occupancy} of the ${input.signals.budgetTokens}-token serving ` +
    `budget; nothing folds until ${Math.round(input.signals.maxTarget * 100)}%. Mark SEVERAL finished ` +
    `chapters in one call with ${input.toolName} {"action":"fold","marks":[{"ids":["<start>","<end>"],` +
    "\"brief\":\"<factual brief>\"}]}: one call answers with everything held plus what is still " +
    "unmarked, so the folds are neat when the fold event triggers.";
}

/**
 * The awareness block a mark call answers with.
 *
 * The projection is byte-frozen between fold events, so this tool result is the ONLY
 * cache-free place left to tell the agent where it stands. It carries three things and
 * stops: what is now held, what is still on the table as an aggregate with a bounded
 * head of the largest names, and the one percentage worth steering by. It is hard
 * bounded on the receipt block's principle: awareness that becomes bloat is bloat.
 */
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

export type CurationProceedReason = "go" | "non-context-response" | "round-cap";

export interface CurationGate {
  openedOrdinal: number;
  /** Context passes consumed while open. Monotonic, and capped, so a stall is impossible. */
  roundsUsed: number;
  /** Context-tool calls counted at the last evaluated pass. */
  contextCallsAtLastRound: number;
  marksAtOpen: number;
  signals: CurationSignals;
}

export interface CurationGateVerdict {
  gate: CurationGate | null;
  event: "opened" | "held" | "proceeded";
  proceed: boolean;
  proceededBy: CurationProceedReason | null;
  roundsUsed: number;
}

/**
 * One evaluation of the gate, on one context pass.
 *
 * The termination argument, stated so it can be checked rather than trusted: every
 * evaluation either proceeds or increments `roundsUsed`, and `roundsUsed` proceeds
 * unconditionally once it reaches the cap. A pass whose response was not a
 * context-management call proceeds immediately, so continuing the task IS the default
 * path through the gate and no reply is ever required to make progress.
 */
export function advanceCurationGate(input: {
  gate: CurationGate | null;
  ordinal: number;
  signals: CurationSignals;
  /** Context-management tool calls observed in this session so far. */
  contextCalls: number;
  pendingMarks: number;
  maxRounds?: number;
}): CurationGateVerdict {
  const maxRounds = input.maxRounds ?? CURATION_GATE_MAX_ROUNDS;
  if (!input.gate) {
    return {
      gate: {
        openedOrdinal: input.ordinal,
        roundsUsed: 0,
        contextCallsAtLastRound: input.contextCalls,
        marksAtOpen: input.pendingMarks,
        signals: input.signals,
      },
      event: "opened",
      proceed: false,
      proceededBy: null,
      roundsUsed: 0,
    };
  }
  const roundsUsed = input.gate.roundsUsed + 1;
  const engaged = input.contextCalls > input.gate.contextCallsAtLastRound;
  if (engaged && roundsUsed < maxRounds) {
    return {
      gate: { ...input.gate, roundsUsed, contextCallsAtLastRound: input.contextCalls },
      event: "held",
      proceed: false,
      proceededBy: null,
      roundsUsed,
    };
  }
  return {
    gate: null,
    event: "proceeded",
    proceed: true,
    proceededBy: engaged ? "round-cap" : "non-context-response",
    roundsUsed,
  };
}

/**
 * The last-call notice.
 *
 * Shape rule, chosen deliberately: operational status plus available actions, with continuing
 * work as the stated default. A message shaped like a question inviting a chat-style
 * reply can make a single-turn agent emit a final answer and end its own run, so this
 * never asks anything and never implies a reply is expected.
 */
export function curationNoticeText(input: {
  signals: CurationSignals;
  roundsUsed: number;
  maxRounds?: number;
  toolName: string;
  brandNoun?: string;
}): string {
  const maxRounds = input.maxRounds ?? CURATION_GATE_MAX_ROUNDS;
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const { signals } = input;
  const occupancy = signals.occupancy === null ? "unmeasured" : `${Math.round(signals.occupancy * 100)}%`;
  const remaining = Math.max(0, maxRounds - input.roundsUsed);
  return boundReceiptText([
    `[${brand} curation] Occupancy ${occupancy} of the ${signals.budgetTokens}-token serving budget; ` +
      `${Math.round(signals.staleToolShare * 100)}% of the window is stale tool output outside the fresh tail ` +
      `(${signals.staleToolResults} result(s), about ${signals.staleToolTokens} tokens). ` +
      "A commit epoch will fold that mass into briefed placeholders; " +
      "the exact source stays expandable and nothing is lost.",
    "Marking well is what makes this cheap: your briefs are what makes these spans findable later, and " +
      "spans batched into one commit rewrite the prefix once instead of once per fold, so the cache survives " +
      "and the next fold event arrives later.",
    `Available now: ${input.toolName} ` +
      "{\"action\":\"fold\",\"marks\":[{\"ids\":[\"<start>\",\"<end>\"],\"brief\":\"<factual brief>\"}]} " +
      "marks SEVERAL spans in one call, and answers with everything held plus what is still unmarked; " +
      "{\"action\":\"rebrief\",\"id\":\"<fold-id>\",\"brief\":\"<factual brief>\"} corrects an existing " +
      "brief; {\"action\":\"reboundary\",\"id\":\"<fold-id>\"} returns a mis-cut fold to raw so you can " +
      "re-fold it.",
    "Continuing the task is the default: this commit proceeds on the next pass unless the next thing you do " +
      `is a ${input.toolName} call, and it proceeds regardless after ${remaining} more curation round(s).`,
  ].join("\n"), 2_048, `[${brand} curation] A commit epoch is due; details are unavailable this pass.`);
}

/** One automatic context action, reported back as status rather than as advice. */
export interface ContextReceipt {
  kind: string;
  ordinal: number;
  trigger: string | null;
  foldsCommitted: number;
  foldsCreated: number;
  freedTokens: number;
  /** Measured occupancy either side of the action, in tokens. The impact, concretely. */
  occupancyBefore: number | null;
  occupancyAfter: number | null;
  /** What the action actually folded, split the way an agent thinks about it. */
  spansFolded: number;
  toolResultsFolded: number;
  /** Bite-sized splitting, when an oversized span became sequential folds. */
  splitFolds: number;
  splitFromChars: number;
  /** Short stale spans a commit absorbed into their later neighbour fold. */
  absorbedWedges: number;
  /** Overflow recovery, when this action rebuilt a request the provider would reject. */
  recovered: boolean;
  /** Mass the agent's pins held out of this commit's reach, in bytes. */
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

/** Newest last, oldest evicted: a receipt block that can never grow into its own problem. */
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

/**
 * The receipt block. Informatory, never exhortative: it reports what the runtime did,
 * what it cost, and the verbs that correct it. Hard-bounded, because a report about
 * bloat that becomes bloat has argued against itself.
 */
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
  // The verbs are the only part of this block an agent can act on, and they sit last, so
  // a plain tail truncation drops them precisely when the report runs long -- which is
  // when a commit did the most and correcting it matters most. Reserve them, and spend
  // what remains on receipt lines newest-first: an older action that no longer fits is
  // the right thing to lose, and its structured record is still in the ring.
  const fixed = Buffer.byteLength(header, "utf8") + Buffer.byteLength(verbs, "utf8") + 1;
  if (fixed > CONTEXT_RECEIPT_BLOCK_BYTES) {
    return `[${brand} actions] Recent automatic context actions are unavailable this pass.`;
  }
  let remaining = CONTEXT_RECEIPT_BLOCK_BYTES - fixed;
  const kept: string[] = [];
  for (let index = input.receipts.length - 1; index >= 0; index -= 1) {
    const line = receiptLine(input.receipts[index]);
    if (Buffer.byteLength(line, "utf8") + 1 > remaining) {
      // Not even the newest line fits whole: carry as much of it as the reservation
      // leaves rather than reporting an action with no detail at all.
      if (!kept.length && remaining > 1) kept.push(boundReceiptText(line, remaining - 1, ""));
      break;
    }
    remaining -= Buffer.byteLength(line, "utf8") + 1;
    kept.unshift(line);
  }
  return [header, ...kept, verbs].join("\n");
}
