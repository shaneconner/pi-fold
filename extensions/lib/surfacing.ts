import { stableStringify } from "../json.ts";
import {
  clone,
  contentText,
  messageRole,
} from "./canonical.ts";
import {
  foldDepth,
  orderedFoldTree,
} from "./folding.ts";
import {
  foldInterval,
  refsProtected,
  toolRefsProtected,
} from "./measurement.ts";
import {
  flattenFoldRefs,
  foldBrief,
} from "./persistence.ts";
import {
  SURFACING_CHAR_BUDGET,
  SURFACING_COOLDOWN_ORDINALS,
  SURFACING_DEPTH_WEIGHT,
  SURFACING_LEXICAL_WEIGHT,
  SURFACING_MAX_DEPTH,
  SURFACING_MAX_LOG_RECORDS,
  SURFACING_MAX_TASK_CHARS,
  SURFACING_MAX_TEXT_CHARS,
  SURFACING_MIN_SCORE,
  SURFACING_OUTCOME_WINDOW_ORDINALS,
  SURFACING_RECENCY_WEIGHT,
  SURFACING_RECENT_TASK_SPANS,
  SURFACING_SOURCE_ID,
  SURFACING_TOP_K,
} from "./policy.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  SuggestionSource,
  SuggestionSourceInput,
  SurfacingCandidate,
  SurfacingRecord,
  SurfacingSuggestion,
} from "./policy.ts";

/**
 * Deterministic, model-free surfacing. Every input is either the transcript's own
 * ordering or the durable log: no wall clock, no randomness, no embedding call, so
 * the same session state always produces the same slate in the same order.
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

export function surfacingTokens(value: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of value.toLowerCase().split(/[^a-z0-9_]+/)) {
    const token = raw.replace(/^_+|_+$/g, "");
    if (token.length < 4 || SURFACING_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

/** The most recent user/assistant text spans: what the session is working on right now. */
export function recentTaskText(
  snapshot: Pick<ActiveContextSnapshot, "messages">,
  spans = SURFACING_RECENT_TASK_SPANS,
): string[] {
  const collected: string[] = [];
  let chars = 0;
  for (let index = snapshot.messages.length - 1; index >= 0 && collected.length < spans; index -= 1) {
    const message = snapshot.messages[index];
    const role = messageRole(message);
    if (role !== "user" && role !== "assistant") continue;
    const text = contentText(message).trim();
    if (!text) continue;
    const bounded = text.slice(0, SURFACING_MAX_TASK_CHARS - chars);
    if (!bounded) break;
    collected.push(bounded);
    chars += bounded.length;
    if (chars >= SURFACING_MAX_TASK_CHARS) break;
  }
  return collected.reverse();
}

export function taskTokenSet(
  snapshot: Pick<ActiveContextSnapshot, "messages">,
  spans = SURFACING_RECENT_TASK_SPANS,
): ReadonlySet<string> {
  return new Set(surfacingTokens(recentTaskText(snapshot, spans).join(" ")));
}

/** Share of the candidate's own vocabulary the recent task text also uses. */
export function lexicalOverlap(candidateText: string, taskTokens: ReadonlySet<string>): number {
  const tokens = surfacingTokens(candidateText);
  if (!tokens.length || !taskTokens.size) return 0;
  let matched = 0;
  for (const token of tokens) if (taskTokens.has(token)) matched += 1;
  return matched / tokens.length;
}

export function roundedScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

export function scoreSurfacingCandidate(
  candidate: SurfacingCandidate,
  taskTokens: ReadonlySet<string>,
  positionCeiling: number,
): number {
  const lexical = lexicalOverlap(candidate.text, taskTokens);
  const position = candidate.position ?? 0;
  const recency = positionCeiling > 0 ? Math.max(0, Math.min(1, position / positionCeiling)) : 0;
  const depth = Math.min(Math.max(0, candidate.depth ?? 0), SURFACING_MAX_DEPTH) / SURFACING_MAX_DEPTH;
  return roundedScore(
    SURFACING_LEXICAL_WEIGHT * lexical +
    SURFACING_RECENCY_WEIGHT * recency +
    SURFACING_DEPTH_WEIGHT * depth,
  );
}

/** Ids suppressed by hysteresis: suggested recently, not acted on, still inside the cooldown. */
export function cooledDownIds(
  log: readonly SurfacingRecord[],
  ordinal: number,
  cooldown = SURFACING_COOLDOWN_ORDINALS,
): Set<string> {
  const suppressed = new Set<string>();
  for (const record of log) {
    if (record.outcome === "accept" || record.ordinal === ordinal) continue;
    if (ordinal < record.ordinal + cooldown) suppressed.add(surfacingKey(record.source, record.id));
  }
  return suppressed;
}

export function surfacingKey(source: string, id: string): string {
  return `${source}::${id}`;
}

export function rankSurfacingCandidates(input: {
  candidates: readonly SurfacingCandidate[];
  taskTokens: ReadonlySet<string>;
  positionCeiling: number;
  suppressed?: ReadonlySet<string>;
  topK?: number;
  minimumScore?: number;
  charBudget?: number;
}): SurfacingSuggestion[] {
  const topK = input.topK ?? SURFACING_TOP_K;
  const minimumScore = input.minimumScore ?? SURFACING_MIN_SCORE;
  const charBudget = input.charBudget ?? SURFACING_CHAR_BUDGET;
  const scored = input.candidates
    .map((candidate) => ({
      ...candidate,
      text: candidate.text.replace(/\s+/g, " ").trim().slice(0, SURFACING_MAX_TEXT_CHARS),
      score: scoreSurfacingCandidate(candidate, input.taskTokens, input.positionCeiling),
    }))
    .filter((candidate) => candidate.text && candidate.score >= minimumScore &&
      !input.suppressed?.has(surfacingKey(candidate.source, candidate.id)))
    // Ties break on source then id so the slate never depends on candidate arrival order.
    .sort((left, right) => right.score - left.score ||
      left.source.localeCompare(right.source) || left.id.localeCompare(right.id));
  const selected: SurfacingSuggestion[] = [];
  let used = 0;
  for (const candidate of scored) {
    if (selected.length >= topK) break;
    const cost = candidate.text.length + candidate.id.length + candidate.route.length +
      (candidate.alternateRoute?.length ?? 0);
    if (used + cost > charBudget) continue;
    used += cost;
    selected.push(candidate);
  }
  return selected;
}

/** The session's monotonic transcript ordinal; recency and cooldown are measured in these. */
export function surfacingOrdinal(snapshot: Pick<ActiveContextSnapshot, "mapped">): number {
  return snapshot.mapped.length;
}

export function surfacingLog(state: Pick<ActiveContextState, "surfacing">): SurfacingRecord[] {
  return state.surfacing ? clone(state.surfacing) : [];
}

/**
 * Property ORDER is load-bearing: the state digest is a stable stringify, so a
 * `surfacing` key assigned onto a state that did not already carry one would land
 * after `pendingMarks`/`advisory`/`prepared` and replay as digest drift. Rebuild the
 * tail of the record in the same order `parseActiveContextState` produces.
 */
export function withSurfacingLog(
  state: ActiveContextState,
  log: readonly SurfacingRecord[],
): ActiveContextState {
  const bounded = log.slice(Math.max(0, log.length - SURFACING_MAX_LOG_RECORDS));
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

/** A shown suggestion the agent never peeked or expanded inside the outcome window is a reject. */
export function resolvedSurfacingLog(
  log: readonly SurfacingRecord[],
  ordinal: number,
  outcomeWindow = SURFACING_OUTCOME_WINDOW_ORDINALS,
): SurfacingRecord[] {
  return log.map((record) => record.outcome === "shown" && ordinal > record.ordinal + outcomeWindow
    ? { ...record, outcome: "reject" as const }
    : { ...record });
}

/** Marks a suggestion accepted when the agent peeks or expands it inside the outcome window. */
export function acceptSurfacingSuggestion(
  state: ActiveContextState,
  id: string,
  ordinal: number,
  outcomeWindow = SURFACING_OUTCOME_WINDOW_ORDINALS,
): ActiveContextState {
  const log = surfacingLog(state);
  let changed = false;
  const next = log.map((record) => {
    if (record.id !== id || record.outcome !== "shown" || ordinal > record.ordinal + outcomeWindow) return record;
    changed = true;
    return { ...record, outcome: "accept" as const };
  });
  return changed ? withSurfacingLog(state, next) : state;
}

/** The built-in source: every currently collapsed fold, nested ones included. */
export function foldBriefCandidates(input: SuggestionSourceInput): SurfacingCandidate[] {
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
    return [{
      source: SURFACING_SOURCE_ID,
      id: fold.id,
      text: foldBrief(fold, state),
      route: `${toolName} {"action":"expand","id":"${fold.id}"}`,
      alternateRoute: `${toolName} {"action":"peek","id":"${fold.id}"}`,
      position: interval.end,
      depth: foldDepth(state, fold),
    }];
  });
}

export const FOLD_BRIEF_SUGGESTION_SOURCE: SuggestionSource = Object.freeze({
  id: SURFACING_SOURCE_ID,
  candidates: foldBriefCandidates,
});

export function collectSuggestionCandidates(
  sources: readonly SuggestionSource[],
  input: SuggestionSourceInput,
): SurfacingCandidate[] {
  return sources.flatMap((source) => {
    let produced: unknown;
    // One faulty external source may never take the carrier, the projection, or the
    // ladder down with it; it simply contributes nothing this pass.
    try { produced = source.candidates(input); }
    catch { return []; }
    if (!Array.isArray(produced)) return [];
    return produced.flatMap((candidate) => validSurfacingCandidate(candidate, source.id)
      ? [{ ...candidate, source: source.id }]
      : []);
  });
}

export function validSurfacingCandidate(value: unknown, sourceId: string): value is SurfacingCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<SurfacingCandidate>;
  return Boolean(sourceId) && typeof candidate.id === "string" && Boolean(candidate.id) &&
    typeof candidate.text === "string" && Boolean(candidate.text.trim()) &&
    typeof candidate.route === "string" && Boolean(candidate.route) &&
    (candidate.alternateRoute === undefined || typeof candidate.alternateRoute === "string") &&
    (candidate.position === undefined || Number.isFinite(candidate.position)) &&
    (candidate.depth === undefined || Number.isFinite(candidate.depth));
}

/**
 * One pass of the selector: resolve outstanding outcomes, rank what is eligible now,
 * and log what will be shown. Pure: the caller owns persistence and rendering.
 */
export function updateSurfacing(input: {
  state: ActiveContextState;
  snapshot: ActiveContextSnapshot;
  sources: readonly SuggestionSource[];
  toolName: string;
}): { state: ActiveContextState; suggestions: SurfacingSuggestion[] } {
  const { state, snapshot } = input;
  const ordinal = surfacingOrdinal(snapshot);
  const resolved = resolvedSurfacingLog(surfacingLog(state), ordinal);
  const shownAtOrdinal = new Set(resolved
    .filter((record) => record.ordinal === ordinal)
    .map((record) => surfacingKey(record.source, record.id)));
  const suggestions = rankSurfacingCandidates({
    candidates: collectSuggestionCandidates(input.sources, {
      state,
      snapshot,
      toolName: input.toolName,
    }),
    taskTokens: taskTokenSet(snapshot),
    positionCeiling: Math.max(0, snapshot.mapped.length - 1),
    suppressed: cooledDownIds(resolved, ordinal),
  });
  // Re-projecting the same ordinal re-renders the same slate; it is one showing,
  // so it neither duplicates a log record nor trips its own cooldown.
  const appended = suggestions.flatMap((suggestion) =>
    shownAtOrdinal.has(surfacingKey(suggestion.source, suggestion.id))
      ? []
      : [{
        source: suggestion.source,
        id: suggestion.id,
        score: suggestion.score,
        ordinal,
        outcome: "shown" as const,
      }]);
  const log = [...resolved, ...appended];
  const next = withSurfacingLog(state, log);
  const unchanged = stableStringify(state.surfacing ?? null) === stableStringify(next.surfacing ?? null);
  return { state: unchanged ? state : next, suggestions };
}
