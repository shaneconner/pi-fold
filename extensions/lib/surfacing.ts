import { stableStringify } from "../json.ts";
import {
  clone,
  contentText,
  messageRole,
  ownValue,
} from "./canonical.ts";
import {
  foldDepth,
  orderedFoldTree,
} from "./folding.ts";
import {
  boundReceiptText,
  exactMapped,
  foldInterval,
  refsProtected,
  toolRefsProtected,
} from "./measurement.ts";
import {
  flattenFoldRefs,
  foldBrief,
} from "./persistence.ts";
import {
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  MAX_SURFACING_LINE_BYTES,
  SURFACING_BM25_B,
  SURFACING_BM25_K1,
  SURFACING_BRIEF_HIT,
  SURFACING_CONTENT_HIT,
  SURFACING_DIVERGENCE_MARGIN,
  SURFACING_HOOK_CHARS,
  SURFACING_IGNORE_LIMIT,
  SURFACING_INTENT_ARGUMENT_CHARS,
  SURFACING_INTENT_ARGUMENT_KEYS,
  SURFACING_INTENT_CHARS,
  SURFACING_INTENT_RECENCY_SHARE,
  SURFACING_MAX_CONTENT_CHARS,
  SURFACING_MAX_LEDGER_RECORDS,
  SURFACING_OUTCOME_WINDOW_ORDINALS,
  SURFACING_PROVENANCE_TERMS,
  SURFACING_SLATE_SIZE,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  SurfacingCandidate,
  SurfacingRecord,
  SurfacingSuggestion,
  SurfacingTransition,
} from "./policy.ts";
import { exactToolCallParts } from "./transcript.ts";

/**
 * THE SURFACING SLATE.
 *
 * An agent cannot peek a fold it does not know to want. The placeholder it can see is
 * the brief, so a fold whose brief already says what it holds is already discoverable
 * and needs nothing from this module. The case worth spending bytes on is the inverse:
 * the fold's stored CONTENT matches what the session is doing right now and its BRIEF
 * does not say so. That divergence, content hit against brief miss, is the whole
 * trigger, and it is why two channels are scored instead of one.
 *
 * Everything here is deterministic and model-free. Every input is the transcript's own
 * ordering or the durable ledger: no wall clock, no randomness, no embedding call, so
 * the same forest against the same intent always produces the same slate. The named
 * second tier is a small embedding model over the same two channels; it drops in as a
 * second scorer without moving anything else, and it is NOT in this build.
 */

const SURFACING_STOPWORDS: ReadonlySet<string> = new Set([
  "about", "after", "again", "against", "already", "also", "another", "because", "been",
  "before", "being", "between", "both", "came", "come", "could", "does", "doing", "done",
  "down", "during", "each", "either", "else", "even", "ever", "every", "exact", "exactly",
  "first", "from", "have", "having", "here", "into", "just", "keep", "kept", "like", "made",
  "make", "many", "more", "most", "much", "must", "need", "next", "none", "only", "other",
  "over", "same", "should", "since", "some", "such", "take", "than", "that", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "under", "until", "upon",
  "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "would",
  "your",
]);

/**
 * Tokens WITH repetition, because BM25 reads term frequency. The old selector deduped
 * here, which was correct for an overlap ratio and would silently flatten tf to 1.
 */
export function surfacingTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const raw of value.toLowerCase().split(/[^a-z0-9_]+/)) {
    const token = raw.replace(/^_+|_+$/g, "");
    if (token.length < 4 || SURFACING_STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function distinctSurfacingTokens(value: string): Set<string> {
  return new Set(surfacingTokens(value));
}

/**
 * The retrieval query is INTENT, never evidence.
 *
 * Measured on memex: a live window of 29,369 characters carried 29,244 characters of
 * raw tool output and 125 characters of the agent's own reasoning, so BM25 was matching
 * briefs against `read` and `shell` dumps and every retrieval number they had was that
 * one defect. Tool RESULTS are excluded here outright; a tool CALL counts as intent,
 * because the name plus its first meaningful argument is a statement of what the agent
 * is trying to do. Our workload is more tool-output-heavy than theirs, not less.
 */
export function toolCallIntent(message: unknown): string[] {
  const calls = exactToolCallParts(ownValue(message, "content"));
  if (!calls) return [];
  const pieces: string[] = [];
  for (const call of calls) {
    const name = ownValue(call, "name");
    if (typeof name !== "string" || !name) continue;
    const args = ownValue(call, "arguments");
    let argument = "";
    for (const key of SURFACING_INTENT_ARGUMENT_KEYS) {
      const value = ownValue(args, key);
      if (typeof value === "string" && value.trim()) {
        argument = value.trim().slice(0, SURFACING_INTENT_ARGUMENT_CHARS);
        break;
      }
    }
    pieces.push(argument ? `${name} ${argument}` : name);
  }
  return pieces;
}

/**
 * Intent pieces, newest half only. memex replayed 56 real retrieval targets against the
 * agent's own query: the oldest half of the same window scored MRR 0.0485 and 4 targets
 * in the top 5, the whole window 0.0573 and 4, the newest half 0.1071 and 10. The
 * control is the point -- the oldest half of the SAME window halves recall -- so this is
 * a position effect, not a length effect, and one constant settles it.
 */
export function surfacingIntentText(snapshot: Pick<ActiveContextSnapshot, "messages">): string {
  const newestFirst: string[] = [];
  let chars = 0;
  for (let index = snapshot.messages.length - 1; index >= 0 && chars < SURFACING_INTENT_CHARS; index -= 1) {
    const message = snapshot.messages[index];
    const role = messageRole(message);
    if (role === "toolResult") continue;
    const pieces = role === "assistant" ? toolCallIntent(message) : [];
    if (role === "user" || role === "assistant") {
      const text = contentText(message).trim();
      if (text) pieces.unshift(text);
    }
    for (const piece of pieces) {
      const bounded = piece.slice(0, SURFACING_INTENT_CHARS - chars);
      if (!bounded) break;
      newestFirst.push(bounded);
      chars += bounded.length;
    }
  }
  const kept = newestFirst.slice(0, Math.max(1, Math.ceil(newestFirst.length * SURFACING_INTENT_RECENCY_SHARE)));
  return kept.reverse().join("\n");
}

// ---------------------------------------------------------------------------
// BM25, stdlib only.
//
// One index over BOTH channels: each fold contributes a brief document and a content
// document, so document frequency, average length and the score normalizer are shared.
// memex's rule that two retrieval LANES must never share a floor holds -- these are two
// FIELDS of one lane, scored by one query against one corpus, and the divergence
// trigger is a subtraction, which is exactly the comparison a shared scale earns.
// ---------------------------------------------------------------------------

export interface SurfacingIndexDocument {
  length: number;
  frequencies: Map<string, number>;
}

export interface SurfacingIndex {
  documents: Map<string, SurfacingIndexDocument>;
  documentFrequency: Map<string, number>;
  count: number;
  averageLength: number;
}

export function surfacingDocumentKey(channel: "brief" | "content", id: string): string {
  return `${channel}::${id}`;
}

export function buildSurfacingIndex(
  documents: ReadonlyArray<{ key: string; tokens: readonly string[] }>,
): SurfacingIndex {
  const indexed = new Map<string, SurfacingIndexDocument>();
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const document of documents) {
    const frequencies = new Map<string, number>();
    for (const token of document.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    indexed.set(document.key, { length: document.tokens.length, frequencies });
    totalLength += document.tokens.length;
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return {
    documents: indexed,
    documentFrequency,
    count: documents.length,
    averageLength: documents.length ? totalLength / documents.length : 0,
  };
}

export function surfacingIdf(index: SurfacingIndex, term: string): number {
  const frequency = index.documentFrequency.get(term) ?? 0;
  if (!frequency) return 0;
  return Math.log(1 + (index.count - frequency + 0.5) / (frequency + 0.5));
}

/**
 * The saturation ceiling for one query: what a document scores when every query term is
 * saturated in it. Dividing by it turns BM25's unbounded score into an absolute 0..1
 * reading that means the same thing in both channels, which is what makes the
 * content-minus-brief margin a number rather than a coincidence of scale.
 */
export function surfacingScoreCeiling(index: SurfacingIndex, queryTerms: ReadonlySet<string>): number {
  let ceiling = 0;
  for (const term of queryTerms) ceiling += surfacingIdf(index, term) * (SURFACING_BM25_K1 + 1);
  return ceiling;
}

export function bm25Score(
  index: SurfacingIndex,
  key: string,
  queryTerms: ReadonlySet<string>,
): number {
  const document = index.documents.get(key);
  if (!document || !document.length) return 0;
  let score = 0;
  for (const term of queryTerms) {
    const frequency = document.frequencies.get(term);
    if (!frequency) continue;
    const denominator = frequency + SURFACING_BM25_K1 *
      (1 - SURFACING_BM25_B + SURFACING_BM25_B * (document.length / (index.averageLength || 1)));
    score += surfacingIdf(index, term) * ((frequency * (SURFACING_BM25_K1 + 1)) / denominator);
  }
  return score;
}

export function roundedScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

export function normalizedBm25(
  index: SurfacingIndex,
  key: string,
  queryTerms: ReadonlySet<string>,
  ceiling: number,
): number {
  if (ceiling <= 0) return 0;
  return roundedScore(bm25Score(index, key, queryTerms) / ceiling);
}

// ---------------------------------------------------------------------------
// Candidates: every collapsed fold, both channels.
// ---------------------------------------------------------------------------

/** The stored source of a fold, descendants included: the roll-up the content channel reads. */
export function foldContentText(
  fold: { id: string },
  state: ActiveContextState,
  snapshot: ActiveContextSnapshot,
): string {
  const record = state.folds.find((candidate) => candidate.id === fold.id);
  if (!record) return "";
  const pieces: string[] = [];
  let chars = 0;
  for (const ref of flattenFoldRefs(record, state)) {
    if (chars >= SURFACING_MAX_CONTENT_CHARS) break;
    const item = exactMapped(snapshot, ref);
    if (!item) continue;
    const text = contentText(item.message).trim();
    if (!text) continue;
    const bounded = text.slice(0, SURFACING_MAX_CONTENT_CHARS - chars);
    pieces.push(bounded);
    chars += bounded.length;
  }
  return pieces.join("\n");
}

/**
 * Eligibility, unchanged from the retained selector: a fold is a candidate only while
 * it is COLLAPSED (an expanded fold is already visible, so surfacing it is noise) and
 * only while nothing about it is pinned raw (a pin is the agent saying it wants those
 * bytes where they are).
 */
export function surfacingCandidates(input: {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  toolName: string;
}): SurfacingCandidate[] {
  const { state, snapshot, toolName } = input;
  const collapsed = orderedFoldTree(state, snapshot).filter((fold) => !state.expanded.includes(fold.id));
  return collapsed.flatMap((fold) => {
    const interval = foldInterval(fold, state, snapshot);
    if (!interval) return [];
    const refs = flattenFoldRefs(fold, state);
    const blocked = fold.kind === "tool-result"
      ? toolRefsProtected(refs, state, snapshot)
      : refsProtected(refs, state, snapshot);
    if (blocked) return [];
    const content = foldContentText(fold, state, snapshot);
    if (!content) return [];
    return [{
      id: fold.id,
      brief: foldBrief(fold, state),
      content,
      route: `${toolName} {"action":"peek","id":"${fold.id}"}`,
      position: interval.end,
      depth: foldDepth(state, fold),
    }];
  });
}

// ---------------------------------------------------------------------------
// The suppression ledger.
//
// One record per fold, not one per showing: the per-suggestion detail a bandit trains
// on is the EVENT STREAM, which is durable and unbounded, and duplicating it in durable
// state would put the suppression memory on a ring that can evict the very ignore it
// exists to remember.
// ---------------------------------------------------------------------------

export function surfacingLedger(state: Pick<ActiveContextState, "surfacing">): SurfacingRecord[] {
  return state.surfacing ? clone(state.surfacing) : [];
}

/**
 * Property ORDER matters here: the state digest is a stable stringify, so a
 * `surfacing` key assigned onto a state that did not already carry one would land
 * after `pendingMarks`/`advisory`/`prepared` and replay as digest drift. Rebuild the
 * tail of the record in the same order `parseActiveContextState` produces.
 */
export function withSurfacingLedger(
  state: ActiveContextState,
  ledger: readonly SurfacingRecord[],
): ActiveContextState {
  const bounded = ledger.slice(Math.max(0, ledger.length - SURFACING_MAX_LEDGER_RECORDS));
  const head = { ...state };
  delete head.surfacing;
  delete head.pendingMarks;
  delete head.advisory;
  delete head.prepared;
  return {
    ...head,
    ...(bounded.length ? { surfacing: clone(bounded) as SurfacingRecord[] } : {}),
    ...(state.pendingMarks?.length ? { pendingMarks: clone(state.pendingMarks) } : {}),
    ...(state.advisory ? { advisory: clone(state.advisory) } : {}),
    ...(state.prepared ? { prepared: clone(state.prepared) } : {}),
  };
}

/**
 * Silence is the default, so suppression is checked before anything is scored.
 *
 * Two rules, both memex's, both measured there. The COOLDOWN is the outcome window
 * itself: a fold is not offered again until its last offer has an answer, which is one
 * clock instead of two saying the same thing. The SILENCE is the decline rule: offered
 * twice, taken never, and the id leaves the candidate set permanently. memex's
 * strongest single discriminator was exactly this shape (47.7% of ignored candidates
 * had been shown three or more times and never taken, against 0% of accepted ones), and
 * it requires ZERO takes rather than a low ratio, because one acceptance proves the
 * fold can be useful and suppressing it afterwards is a false negative nothing can see.
 */
export function surfacingSuppressed(
  ledger: readonly SurfacingRecord[],
  ordinal: number,
): Set<string> {
  const suppressed = new Set<string>();
  for (const record of ledger) {
    if (record.taken === 0 && record.surfaced >= SURFACING_IGNORE_LIMIT) { suppressed.add(record.id); continue; }
    if (ordinal < record.ordinal + SURFACING_OUTCOME_WINDOW_ORDINALS) suppressed.add(record.id);
  }
  return suppressed;
}

/** Ids this ledger will never offer again, whatever the score. */
export function surfacingSilenced(ledger: readonly SurfacingRecord[]): Set<string> {
  return new Set(ledger.flatMap((record) =>
    record.taken === 0 && record.surfaced >= SURFACING_IGNORE_LIMIT ? [record.id] : []));
}

// ---------------------------------------------------------------------------
// Selection: score everything, surface almost nothing.
// ---------------------------------------------------------------------------

export interface SurfacingSelection {
  slate: SurfacingSuggestion[];
  considered: number;
  suppressed: number;
  divergent: number;
  /** The intent query the pass scored with; the carrier renders its hook from these. */
  queryTerms: Set<string>;
}

/**
 * The trigger is DIVERGENCE, not fused score. A fold that scores well on both channels
 * is a fold whose placeholder already says what it holds: the agent can see it, so
 * surfacing it spends bytes to repeat the window back to itself. What earns a
 * suggestion is content the brief does not name.
 */
export function selectSurfacingSlate(input: {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  toolName: string;
  ordinal: number;
}): SurfacingSelection {
  const candidates = surfacingCandidates(input);
  const queryTerms = distinctSurfacingTokens(surfacingIntentText(input.snapshot));
  const empty: SurfacingSelection = {
    slate: [],
    considered: candidates.length,
    suppressed: 0,
    divergent: 0,
    queryTerms,
  };
  if (!candidates.length || !queryTerms.size) return empty;
  const index = buildSurfacingIndex(candidates.flatMap((candidate) => [
    { key: surfacingDocumentKey("brief", candidate.id), tokens: surfacingTokens(candidate.brief) },
    { key: surfacingDocumentKey("content", candidate.id), tokens: surfacingTokens(candidate.content) },
  ]));
  const ceiling = surfacingScoreCeiling(index, queryTerms);
  const suppressed = surfacingSuppressed(surfacingLedger(input.state), input.ordinal);
  let suppressedCount = 0;
  const scored = candidates.flatMap((candidate) => {
    const contentScore = normalizedBm25(index, surfacingDocumentKey("content", candidate.id), queryTerms, ceiling);
    const briefScore = normalizedBm25(index, surfacingDocumentKey("brief", candidate.id), queryTerms, ceiling);
    const margin = roundedScore(contentScore - briefScore);
    if (contentScore < SURFACING_CONTENT_HIT || briefScore >= SURFACING_BRIEF_HIT ||
        margin < SURFACING_DIVERGENCE_MARGIN) return [];
    if (suppressed.has(candidate.id)) { suppressedCount += 1; return []; }
    return [{ ...candidate, contentScore, briefScore, margin, slot: 0 }];
  });
  // Ties break on id so the slate never depends on forest walk order.
  scored.sort((left, right) => right.margin - left.margin ||
    right.contentScore - left.contentScore || left.id.localeCompare(right.id));
  return {
    slate: scored.slice(0, SURFACING_SLATE_SIZE).map((suggestion, slot) => ({ ...suggestion, slot })),
    considered: candidates.length,
    suppressed: suppressedCount,
    divergent: scored.length,
    queryTerms,
  };
}

// ---------------------------------------------------------------------------
// Outcomes: acted, used, ignored.
// ---------------------------------------------------------------------------

export function issueSurfacing(
  state: ActiveContextState,
  id: string,
  ordinal: number,
): ActiveContextState {
  const ledger = surfacingLedger(state);
  const existing = ledger.find((record) => record.id === id);
  const next = existing
    ? ledger.map((record) => record.id === id
      ? { id, surfaced: record.surfaced + 1, taken: record.taken, ordinal, outcome: "shown" as const }
      : record)
    : [...ledger, { id, surfaced: 1, taken: 0, ordinal, outcome: "shown" as const }];
  return withSurfacingLedger(state, next);
}

/**
 * ACTED: a context verb targeted the surfaced fold while the offer was still open. The
 * clock restarts from the action, because the second label is graded from what the
 * agent did with what it retrieved.
 */
export function noteSurfacingAction(
  state: ActiveContextState,
  id: string,
  ordinal: number,
): ActiveContextState {
  const ledger = surfacingLedger(state);
  let changed = false;
  const next = ledger.map((record) => {
    if (record.id !== id || record.outcome !== "shown" ||
        ordinal > record.ordinal + SURFACING_OUTCOME_WINDOW_ORDINALS) return record;
    changed = true;
    return { id: record.id, surfaced: record.surfaced, taken: record.taken + 1, ordinal, outcome: "acted" as const };
  });
  return changed ? withSurfacingLedger(state, next) : state;
}

/**
 * USED, by provenance scan: terms the fold's CONTENT carries and its BRIEF does not,
 * appearing in the agent's own output or tool calls after it acted. Brief terms prove
 * nothing, because the placeholder was already in the window; content-only terms could
 * only have arrived through the retrieval. Optimizing clicks yields clickbait, so the
 * label a later bandit tunes on is this one, not the peek.
 */
export function surfacingProvenanceHit(input: {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  id: string;
  sinceOrdinal: number;
}): boolean {
  const { state, snapshot } = input;
  const fold = state.folds.find((record) => record.id === input.id);
  if (!fold) return false;
  const contentTerms = distinctSurfacingTokens(foldContentText(fold, state, snapshot));
  if (!contentTerms.size) return false;
  for (const term of distinctSurfacingTokens(foldBrief(fold, state))) contentTerms.delete(term);
  if (!contentTerms.size) return false;
  // The ordinal counts MAPPED entries, so the cut is the message index of the mapped
  // entry that ordinal names, not an index into `messages`: the two only coincide when
  // every message carries a ref, and a projection carrier is a message that does not.
  const position = Math.min(Math.max(0, input.sinceOrdinal), snapshot.mapped.length) - 1;
  const cutoff = position >= 0 ? snapshot.mapped[position].index : -1;
  const after = snapshot.messages.slice(cutoff + 1);
  const downstream = distinctSurfacingTokens(surfacingIntentText({ messages: after }));
  let matched = 0;
  for (const term of contentTerms) if (downstream.has(term)) matched += 1;
  return matched >= SURFACING_PROVENANCE_TERMS;
}

/**
 * Resolve every offer whose window has closed. A shown offer nobody acted on is
 * IGNORED; an acted offer whose content shows up downstream is USED, and one that does
 * not stays ACTED. Both grades are terminal; the transitions are returned so the caller
 * emits one stream record per state change instead of inferring them later.
 */
export function resolveSurfacing(input: {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  ordinal: number;
}): { state: ActiveContextState; transitions: SurfacingTransition[] } {
  const ledger = surfacingLedger(input.state);
  const transitions: SurfacingTransition[] = [];
  const next = ledger.map((record) => {
    if (input.ordinal <= record.ordinal + SURFACING_OUTCOME_WINDOW_ORDINALS) return record;
    if (record.outcome === "shown") {
      transitions.push({ id: record.id, from: "shown", to: "ignored", ordinal: input.ordinal });
      return { ...record, outcome: "ignored" as const };
    }
    if (record.outcome === "acted") {
      const used = surfacingProvenanceHit({
        state: input.state,
        snapshot: input.snapshot,
        id: record.id,
        sinceOrdinal: record.ordinal,
      });
      if (!used) return record;
      transitions.push({ id: record.id, from: "acted", to: "used", ordinal: input.ordinal });
      return { ...record, outcome: "used" as const };
    }
    return record;
  });
  if (!transitions.length) return { state: input.state, transitions };
  const state = withSurfacingLedger(input.state, next);
  const unchanged = stableStringify(input.state.surfacing ?? null) === stableStringify(state.surfacing ?? null);
  return { state: unchanged ? input.state : state, transitions };
}

// ---------------------------------------------------------------------------
// The carrier line.
// ---------------------------------------------------------------------------

/** The matched region of the content, so the agent sees WHY the fold surfaced. */
export function surfacingHook(content: string, queryTerms: ReadonlySet<string>): string {
  const flat = content.replace(/\s+/g, " ").trim();
  let start = 0;
  const lowered = flat.toLowerCase();
  for (const term of [...queryTerms].sort()) {
    const found = lowered.indexOf(term);
    if (found >= 0 && (start === 0 || found < start)) start = found;
  }
  // Back up to the start of the matched word so a hook never opens mid-token.
  while (start > 0 && /[a-z0-9_]/i.test(flat[start - 1])) start -= 1;
  const hook = flat.slice(start, start + SURFACING_HOOK_CHARS).trim();
  return hook.length < flat.length - start ? `${hook}...` : hook;
}

/**
 * One line, one suggestion, and the exact command to act on it. It says plainly what
 * the claim is (this fold holds matching content its brief does not name), so a false
 * positive costs a glance rather than a derailed turn, and it is hard-bounded because a
 * carrier that grows into the problem it reports has argued against itself.
 */
export function surfacingSlateText(input: {
  slate: readonly SurfacingSuggestion[];
  queryTerms: ReadonlySet<string>;
  brandNoun?: string;
}): string | null {
  if (!input.slate.length) return null;
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const suggestion = input.slate[0];
  const hook = surfacingHook(suggestion.content, input.queryTerms);
  return boundReceiptText(
    `[${brand} surfacing] Fold ${suggestion.id} holds material matching this task that its brief does ` +
      `not name: "${hook}". Read it with ${suggestion.route}.`,
    MAX_SURFACING_LINE_BYTES,
    `[${brand} surfacing] Fold ${suggestion.id} holds material matching this task; read it with ` +
      `${suggestion.route}.`,
  );
}
