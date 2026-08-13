import { objectRefKey } from "../json.ts";
import {
  boundedUtf8,
  bytes,
  messageRole,
} from "./canonical.ts";
import { boundReceiptText } from "./measurement.ts";
import {
  contextBrand,
  CONTEXT_MARK_RESPONSE_BYTES,
  CONTEXT_RECEIPT_BLOCK_BYTES,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_CONTEXT_RECEIPTS,
  MAX_LAST_CALL_TEXT_BYTES,
  MAX_SURFACING_LINE_BYTES,
  MAX_THRESHOLD_NOTICE_TEXT_BYTES,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
} from "./policy.ts";

export interface StaleToolMass {
  bytes: number;
  results: number;
}

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
  occupancy: number | null;
  maxTarget: number;
  occupancyTokens: number | null;
  budgetTokens: number;
  window: number;
  staleToolShare: number;
  staleToolTokens: number;
  staleToolResults: number;
  eligibleFolds: number;
}

export function curationSignals(input: {
  snapshot: ActiveContextSnapshot;
  state: ActiveContextState;
  usedTokens: number | null;
  budgetTokens: number;
  window: number;
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

export function curationTriggerFires(signals: CurationSignals): boolean {
  return signals.occupancy !== null &&
    Number.isFinite(signals.occupancy) &&
    signals.occupancy >= signals.maxTarget;
}

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
  suggestion?: string | null;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const anchors = input.anchors.length
    ? input.anchors.slice(0, 3).join(", ")
    : "none";
  const pinnedPercent = Math.round(input.pinnedShare * 100);
  const capPercent = Math.round(input.maxPinnedShare * 100);
  return joinSurfacing(boundReceiptText(
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
  ), input.suggestion);
}

export function joinSurfacing(text: string, suggestion?: string | null): string {
  if (!suggestion) return text;
  return `${text}\n${boundedUtf8(suggestion, MAX_SURFACING_LINE_BYTES)}`;
}

export const LAST_CALL_WORDING =
  "Fold commit triggered, please add or edit marks, pin or unpin context based on foreseeable relevance.";

export function lastCallText(input: {
  signals: CurationSignals;
  unmarked: { spans: number; tokens: number };
  pendingMarks: number;
  peekReclaims?: number;
  suggestion?: string | null;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const { signals } = input;
  const occupancy = signals.occupancy === null ? "unmeasured" : `${Math.round(signals.occupancy * 100)}%`;
  const peekReclaims = input.peekReclaims ?? 0;
  return joinSurfacing(boundReceiptText([
    `[${brand} last call] ${LAST_CALL_WORDING}`,
    `Occupancy is ${occupancy} of the ${signals.budgetTokens}-token serving budget, at or past the ` +
      `${Math.round(signals.maxTarget * 100)}% commit line. Unmarked foldable mass: ` +
      `${input.unmarked.spans} span(s), about ${input.unmarked.tokens} tokens. ` +
      `Pending marks: ${input.pendingMarks}.`,
    peekReclaims > 0
      ? `Peek copies reclaimed by this commit: ${peekReclaims}. Each duplicates a fold you can peek ` +
        "again at any time, and its placeholder names that fold, so nothing becomes unreachable. " +
        "Pin one to keep the copy raw."
      : "",
    `Marks: ${input.toolName} ` +
      "{\"action\":\"fold\",\"marks\":[{\"ids\":[\"<start>\",\"<end>\"],\"brief\":\"<factual brief>\"}]} " +
      "adds or widens several in one call. Pins: {\"action\":\"protect\",\"ids\":[\"<entry-id>\"]} holds " +
      "entries raw through every fold, and {\"action\":\"unprotect\"} releases them.",
    "This is one round: the commit proceeds on the pass after your next response with whatever marks " +
      "exist. Continuing the task is the default; nothing here needs a reply.",
  ].filter(Boolean).join("\n"), MAX_LAST_CALL_TEXT_BYTES,
  `[${brand} last call] ${LAST_CALL_WORDING}`), input.suggestion);
}

export function thresholdNoticeText(input: {
  share: number;
  occupancyTokens: number;
  budgetTokens: number;
  maxTarget: number;
  toolName: string;
  brandNoun?: string;
}): string {
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  return boundReceiptText(
    `[${brand} notice] Context occupancy crossed ${Math.round(input.share * 100)}% of the ` +
      `${input.budgetTokens}-token serving budget (${input.occupancyTokens} tokens). Nothing folds before ` +
      `the fold commit at ${Math.round(input.maxTarget * 100)}%; marks and pins made now shape it: ` +
      `${input.toolName} {"action":"fold","marks":[{"ids":["<start>","<end>"],"brief":"<factual brief>"}]} ` +
      'or {"action":"protect","ids":["<entry-id>"]}.',
    MAX_THRESHOLD_NOTICE_TEXT_BYTES,
    `[${brand} notice] Context occupancy crossed ${Math.round(input.share * 100)}% of the serving budget.`,
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
