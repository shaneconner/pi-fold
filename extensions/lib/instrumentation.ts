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
 * THE context-management event stream.
 *
 * One stream, one envelope, one naming convention. Every context event this runtime
 * produces -- tool attempts and their refusals, span corrections, gate lifecycle,
 * receipts, commits, absorptions, splits, recoveries, projections and provider usage --
 * lands here as a flat JSONL-style record, and every record is also appended as a
 * durable session entry so an analyst can reconstruct the whole timeline from session
 * artifacts alone.
 *
 * The envelope is fixed and self-describing:
 *   v            schema version of the envelope
 *   seq          monotonic per session, from 1, so records order without a clock
 *   kind         "context.<noun>", the only field a reader must know to dispatch
 *   session_id   the session these events belong to
 *   ordinal      transcript position, the deterministic clock this runtime reasons in
 *   at           wall-clock milliseconds, the join key against provider-side telemetry
 *   revision     durable state revision at emit time
 *
 * Everything after the envelope is a FLAT snake_case payload. Records are not shaped
 * around any metric we compute today: a reader that wants a number we never thought of
 * should be able to get it with a query rather than a code change. Nothing nests, and
 * anything one-to-many (a correction, an absorbed wedge, a created fold) is its own
 * record referencing the record it belongs to by `seq`.
 */
export const CONTEXT_EVENT_SCHEMA_VERSION = 1;

export interface ContextEvent {
  v: number;
  seq: number;
  kind: string;
  session_id: string;
  ordinal: number;
  at: number;
  revision: number;
  [field: string]: unknown;
}

export type ContextEventKind =
  /** One context-management tool call, accepted or refused. */
  | "context.attempt"
  /** One auto-snap applied to a requested span, referencing its attempt. */
  | "context.correction"
  /** One protect or unprotect: durable pin bookkeeping; no window bytes move. */
  | "context.protect"
  /** The resolved serving budget, stated once at startup so a live run can prove it. */
  | "context.capacity"
  /** One evaluation of the guided-curation last-call gate. */
  | "context.gate"
  /** One sparse occupancy reminder delivered into the window. */
  | "context.reminder"
  /** One receipt delivered into the window. */
  | "context.receipt"
  /** One commit epoch: the single mutation an epoch pays for. */
  | "context.commit"
  /** One fold created, by the ladder or by the agent. */
  | "context.fold"
  /** One boundary sliver absorbed into its later neighbour. */
  | "context.absorb"
  /** One oversized span split into sequential bite-sized folds. */
  | "context.split"
  /** One overflow rollback and the recovery that followed it. */
  | "context.recovery"
  /** One projection built, classified against the one before it. */
  | "context.projection"
  /** One provider response, which is where this stream joins provider usage. */
  | "context.usage"
  /** One handoff, compared byte-for-byte against the previous transmitted projection. */
  | "context.prefix";

/**
 * Where the prefix first differs from the previous TRANSMITTED projection, in chars.
 *
 * A positional cache is keyed on a byte prefix, so the message-level classification is
 * not enough to attribute a miss: the analyst needs the position, and only the runtime
 * knows why a byte at that position moved. This is the cheap half -- both projections
 * are in hand at handoff -- and it is emission only. No analysis of it belongs here.
 */
export function prefixDivergence(
  previous: string | null,
  next: string,
): { index: number | null; identicalChars: number; identicalShare: number } {
  if (previous === null) return { index: null, identicalChars: 0, identicalShare: 0 };
  const shared = Math.min(previous.length, next.length);
  let index = 0;
  while (index < shared && previous.charCodeAt(index) === next.charCodeAt(index)) index += 1;
  const diverged = index < shared || next.length < previous.length;
  return {
    index: diverged ? index : null,
    identicalChars: index,
    identicalShare: next.length > 0 ? index / next.length : 0,
  };
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
  /** The stream itself, oldest first. Bounded in memory; durable in full. */
  events: ContextEvent[];
  /** The monotonic sequence every record carries. */
  sequence: number;
  countsByKind: Record<string, number>;
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
    sequence: 0,
    countsByKind: {},
  };
}

/**
 * Stamp the envelope and append. The in-memory ring is the status view and is bounded;
 * the durable session entry is the audit copy and is not.
 */
export function recordContextEvent(
  ledger: InstrumentationLedger,
  kind: ContextEventKind,
  envelope: { session_id: string; ordinal: number; revision: number; at: number },
  payload: Record<string, unknown> = {},
): ContextEvent {
  ledger.sequence += 1;
  const record: ContextEvent = {
    v: CONTEXT_EVENT_SCHEMA_VERSION,
    seq: ledger.sequence,
    kind,
    session_id: envelope.session_id,
    ordinal: envelope.ordinal,
    at: envelope.at,
    revision: envelope.revision,
    ...payload,
  };
  ledger.countsByKind[kind] = (ledger.countsByKind[kind] ?? 0) + 1;
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
 *
 * A rewrite used to be charged to us unconditionally, and that hid the whole rep 21
 * finding: a rewrite that preserved 99.86% of the prompt still read back as ours, so
 * our own metrics reported a negligible divergence and a total cache loss and never
 * put the two side by side. Attribution now asks how much of the previous prompt the
 * rewrite actually kept. If we preserved nearly all of it and the provider still
 * served nothing, our divergence cannot account for the loss and the miss is theirs.
 * That is a claim about ATTRIBUTION, not about cost: a preserved-share miss is still
 * a full rebuild, and it is still worth not causing.
 */
export const PROVIDER_SIDE_MISS_PRESERVED_SHARE = 0.99;

export function observeCacheUsage(
  ledger: InstrumentationLedger,
  input: { usage: unknown; change: ProjectionChange; preservedShare?: number | null },
): CacheObservation | null {
  const usage = input.usage;
  const inputTokens = ownValue(usage, "input");
  const cacheReadTokens = ownValue(usage, "cacheRead");
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0 ||
      typeof cacheReadTokens !== "number" || !Number.isFinite(cacheReadTokens) ||
      cacheReadTokens < 0) return null;
  const missed = cacheReadTokens === 0;
  const preserved = typeof input.preservedShare === "number" && Number.isFinite(input.preservedShare)
    ? input.preservedShare
    : null;
  const observation: CacheObservation = {
    ordinal: ledger.projections,
    change: input.change,
    inputTokens,
    cacheReadTokens,
    providerSideMiss: missed && (input.change !== "rewrite" ||
      (preserved !== null && preserved >= PROVIDER_SIDE_MISS_PRESERVED_SHARE)),
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
    contextEvents: ledger.sequence,
    contextEventsByKind: { ...ledger.countsByKind },
  };
}
