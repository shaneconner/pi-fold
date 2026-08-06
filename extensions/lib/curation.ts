import { objectRefKey } from "../json.ts";
import {
  bytes,
  messageRole,
} from "./canonical.ts";
import { boundReceiptText } from "./measurement.ts";
import {
  contextBrand,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  CURATION_GATE_MAX_ROUNDS,
  CURATION_OCCUPANCY_SHARE,
  CURATION_REMINDER_SHARES,
  CURATION_STALE_TOOL_SHARE,
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
 * BOTH signals, never either. Occupancy alone announces a commit that has nothing to
 * fold; stale mass alone announces one in a window with room to spare.
 */
export function curationTriggerFires(signals: CurationSignals): boolean {
  return signals.occupancy !== null &&
    Number.isFinite(signals.occupancy) &&
    signals.occupancy >= CURATION_OCCUPANCY_SHARE &&
    signals.staleToolShare >= CURATION_STALE_TOOL_SHARE;
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
    `budget; nothing folds until ${Math.round(CURATION_OCCUPANCY_SHARE * 100)}%. Mark finished chapters as ` +
    `you go with ${input.toolName} {"action":"fold","marks":[{"ids":["<start>","<end>"],` +
    "\"brief\":\"<factual brief>\"}]} so the folds are neat when the fold event triggers.";
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
 * Shape rule, load-bearing: operational status plus available actions, with continuing
 * work as the stated default. A message shaped like a question inviting a chat-style
 * reply can make a single-turn agent emit a final answer and end its own run, so this
 * never asks anything and never implies a reply is expected.
 */
export function curationNoticeText(input: {
  signals: CurationSignals;
  roundsUsed: number;
  maxRounds?: number;
  pendingMarks: number;
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
      `${input.pendingMarks} mark(s) pending. A commit epoch will fold that mass into briefed placeholders; ` +
      "the exact source stays expandable and nothing is lost.",
    "Marking well is what makes this cheap: your briefs are what makes these spans findable later, and " +
      "spans batched into one commit rewrite the prefix once instead of once per fold, so the cache survives " +
      "and the next fold event arrives later.",
    `Available now: ${input.toolName} ` +
      "{\"action\":\"fold\",\"marks\":[{\"ids\":[\"<start>\",\"<end>\"],\"brief\":\"<factual brief>\"}]} " +
      "batches several spans with briefs in one call; " +
      "{\"action\":\"rebrief\",\"id\":\"<fold-id>\",\"brief\":\"<factual brief>\"} corrects an existing " +
      "brief; {\"action\":\"reboundary\",\"id\":\"<fold-id>\"} returns a mis-cut fold to raw so you can " +
      "re-fold it; {\"action\":\"commit\"} proceeds immediately.",
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
  return boundReceiptText([
    `[${brand} actions] Recent automatic context actions, newest last. Exact source remains expandable.`,
    ...input.receipts.map(receiptLine),
    `Correct any of it: ${input.toolName} ` +
      "{\"action\":\"expand\",\"id\":\"<fold-id>\"} restores a span in place; " +
      "{\"action\":\"rebrief\",\"id\":\"<fold-id>\",\"brief\":\"<factual brief>\"} replaces a brief that " +
      "does not describe what you needed; {\"action\":\"reboundary\",\"id\":\"<fold-id>\"} returns a " +
      "mis-cut fold to raw so you can fold the span you meant.",
  ].join("\n"), CONTEXT_RECEIPT_BLOCK_BYTES,
  `[${brand} actions] Recent automatic context actions are unavailable this pass.`);
}
