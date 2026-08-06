import { evidenceSha256, sha256Value } from "../json.ts";
import { ownValue } from "./canonical.ts";
import {
  MAX_CONTEXT_ATTEMPT_RECORDS,
  MAX_PROJECTION_HASH_RECORDS,
} from "./policy.ts";

/**
 * Projection instrumentation.
 *
 * The iteration-1 ledger reported 19 "observed mutations", and reconstruction showed
 * only 7 of them were projection rewrites this runtime performed. The other 12 were
 * provider-side cache misses on projections that had only GROWN: message count up by
 * one, no message removed, system prompt and tool digests constant, and the request
 * still re-paid ~200k fresh tokens. One dial counting both makes a scheduling lever
 * look responsible for a cost no scheduling lever can remove.
 *
 * So the two are counted separately, and the append case is made PROVABLE from
 * artifacts: per-message digests of consecutive projections show exactly where, or
 * whether, the prefix diverged.
 */

export type ProjectionChange = "identical" | "append" | "rewrite";

export interface ProjectionComparison {
  change: ProjectionChange;
  previousCount: number;
  nextCount: number;
  appendedCount: number;
  /** First index whose digest differs; null when the prefix is intact. */
  firstDivergentIndex: number | null;
}

export function messageDigests(messages: readonly unknown[]): string[] {
  return messages.map((message) => {
    try { return evidenceSha256(message); }
    catch { return sha256Value({ unhashable: true }); }
  });
}

/**
 * Compare two consecutive projections by per-message digest. A pure append leaves the
 * whole previous prefix intact, which is precisely the condition under which a
 * provider cache SHOULD hit; anything else is a rewrite this runtime caused.
 */
export function compareProjections(
  previous: readonly string[] | null,
  next: readonly string[],
): ProjectionComparison {
  if (!previous) {
    return {
      change: "append",
      previousCount: 0,
      nextCount: next.length,
      appendedCount: next.length,
      firstDivergentIndex: null,
    };
  }
  let firstDivergentIndex: number | null = null;
  const shared = Math.min(previous.length, next.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous[index] !== next[index]) { firstDivergentIndex = index; break; }
  }
  if (firstDivergentIndex !== null || next.length < previous.length) {
    return {
      change: "rewrite",
      previousCount: previous.length,
      nextCount: next.length,
      appendedCount: Math.max(0, next.length - previous.length),
      firstDivergentIndex: firstDivergentIndex ?? shared,
    };
  }
  return {
    change: next.length === previous.length ? "identical" : "append",
    previousCount: previous.length,
    nextCount: next.length,
    appendedCount: next.length - previous.length,
    firstDivergentIndex: null,
  };
}

export interface ProjectionRecord extends ProjectionComparison {
  ordinal: number;
  prefixSha256: string;
}

/** One provider response read against the projection that produced it. */
export interface CacheObservation {
  ordinal: number;
  change: ProjectionChange;
  inputTokens: number;
  cacheReadTokens: number;
  /** A fresh re-read of a prefix that did not move: nothing here is ours to fix. */
  providerSideMiss: boolean;
}

/**
 * The context-management event stream.
 *
 * Everything the agent tried and everything the runtime decided, adjudicable from the
 * session file. It records REJECTED calls as loudly as accepted ones: an agent that
 * cannot fold because its span keeps being refused looks identical, from fold records
 * alone, to an agent that never tried. Every record here is also appended as a durable
 * session entry, because an in-memory ledger is invisible to an external adjudicator.
 */
export type ContextEventRecord =
  | ContextAttemptRecord
  | CurationGateRecord
  | ContextReceiptRecord;

/** One context-management tool call, accepted or refused. */
export interface ContextAttemptRecord {
  version: 1;
  kind: "attempt";
  sessionId: string;
  action: string;
  ok: boolean;
  /** The exact validation text the caller received; null when the call succeeded. */
  error: string | null;
  /** Auto-snap corrections applied to the request before it was served. */
  corrections: Array<Record<string, unknown>>;
  /** How many {span, brief} pairs a batched mark call carried. */
  marks: number;
  argumentsSha256: string;
  ordinal: number;
  occurredAt: number;
}

/** One evaluation of the guided-curation last-call gate. */
export interface CurationGateRecord {
  version: 1;
  kind: "curation-gate";
  sessionId: string;
  event: "opened" | "held" | "proceeded";
  occupancy: number | null;
  staleToolShare: number;
  staleToolTokens: number;
  staleToolResults: number;
  eligibleFolds: number;
  roundsUsed: number;
  marksAddedDuringGate: number;
  proceededBy: string | null;
  ordinal: number;
  occurredAt: number;
}

/** One receipt delivered into the window. */
export interface ContextReceiptRecord {
  version: 1;
  kind: "receipt";
  sessionId: string;
  receipt: Record<string, unknown>;
  ordinal: number;
  occurredAt: number;
}

export interface InstrumentationLedger {
  projections: number;
  /** Projections this runtime actually rewrote. The scheduling dial. */
  rewrites: number;
  appends: number;
  identical: number;
  /** Responses that re-read an unchanged prefix from scratch. The provider's dial. */
  providerSideMisses: number;
  observedMisses: number;
  records: ProjectionRecord[];
  observations: CacheObservation[];
  /** Context-management attempts, gate events and receipts, oldest first. */
  events: ContextEventRecord[];
  attempts: number;
  attemptErrors: number;
  autoSnapCorrections: number;
  curationGateEvents: number;
  receiptsDelivered: number;
}

export function emptyLedger(): InstrumentationLedger {
  return {
    projections: 0,
    rewrites: 0,
    appends: 0,
    identical: 0,
    providerSideMisses: 0,
    observedMisses: 0,
    records: [],
    observations: [],
    events: [],
    attempts: 0,
    attemptErrors: 0,
    autoSnapCorrections: 0,
    curationGateEvents: 0,
    receiptsDelivered: 0,
  };
}

/** Bounded append; the durable session entry is the audit copy, this ring is the status view. */
export function recordContextEvent(
  ledger: InstrumentationLedger,
  record: ContextEventRecord,
): ContextEventRecord {
  if (record.kind === "attempt") {
    ledger.attempts += 1;
    if (!record.ok) ledger.attemptErrors += 1;
    ledger.autoSnapCorrections += record.corrections.length;
  } else if (record.kind === "curation-gate") ledger.curationGateEvents += 1;
  else ledger.receiptsDelivered += 1;
  ledger.events.push(record);
  if (ledger.events.length > MAX_CONTEXT_ATTEMPT_RECORDS) {
    ledger.events = ledger.events.slice(ledger.events.length - MAX_CONTEXT_ATTEMPT_RECORDS);
  }
  return record;
}

function bounded<T>(values: T[], next: T): T[] {
  values.push(next);
  return values.length > MAX_PROJECTION_HASH_RECORDS
    ? values.slice(values.length - MAX_PROJECTION_HASH_RECORDS)
    : values;
}

export function recordProjection(
  ledger: InstrumentationLedger,
  comparison: ProjectionComparison,
  digests: readonly string[],
): void {
  ledger.projections += 1;
  if (comparison.change === "rewrite") ledger.rewrites += 1;
  else if (comparison.change === "append") ledger.appends += 1;
  else ledger.identical += 1;
  ledger.records = bounded(ledger.records, {
    ...comparison,
    ordinal: ledger.projections,
    // The prefix digest, not the whole projection: it is what a positional cache keys
    // on, so two equal values are the claim that a cache hit was available.
    prefixSha256: sha256Value(digests.slice(0, comparison.previousCount || digests.length)),
  });
}

/**
 * Read one provider response against the projection that produced it. A miss on a
 * projection that only grew is provider-side by construction: no byte we control
 * moved, so no scheduling change could have prevented the re-read.
 */
export function observeCacheUsage(
  ledger: InstrumentationLedger,
  input: { usage: unknown; change: ProjectionChange },
): CacheObservation | null {
  const usage = input.usage;
  const inputTokens = ownValue(usage, "input");
  const cacheReadTokens = ownValue(usage, "cacheRead");
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0 ||
      typeof cacheReadTokens !== "number" || !Number.isFinite(cacheReadTokens) ||
      cacheReadTokens < 0) return null;
  const missed = cacheReadTokens === 0;
  const observation: CacheObservation = {
    ordinal: ledger.projections,
    change: input.change,
    inputTokens,
    cacheReadTokens,
    providerSideMiss: missed && input.change !== "rewrite",
  };
  if (missed) ledger.observedMisses += 1;
  if (observation.providerSideMiss) ledger.providerSideMisses += 1;
  ledger.observations = bounded(ledger.observations, observation);
  return observation;
}

/** The compact ledger the evidence envelope carries; the record rings stay for audit. */
export function ledgerSummary(ledger: InstrumentationLedger): Record<string, unknown> {
  return {
    projections: ledger.projections,
    projectionRewrites: ledger.rewrites,
    projectionAppends: ledger.appends,
    projectionsUnchanged: ledger.identical,
    observedCacheMisses: ledger.observedMisses,
    providerSideCacheMisses: ledger.providerSideMisses,
    contextAttempts: ledger.attempts,
    contextAttemptErrors: ledger.attemptErrors,
    autoSnapCorrections: ledger.autoSnapCorrections,
    curationGateEvents: ledger.curationGateEvents,
    receiptsDelivered: ledger.receiptsDelivered,
  };
}
