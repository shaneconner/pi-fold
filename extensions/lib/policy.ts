import type { EvidenceRef } from "../json.ts";

/**
 * THE deployment identity. One package, one brand, no constructor options.
 *
 * These were five public knobs through 1.0.2, on the theory that the runtime was a
 * generic framework a host would brand. It is not: it is a branded package with one
 * deployment, and the knobs bought nothing but a namespace a consumer could strand its
 * own durable state under. They are hardwired here and REFUSED by name at the package
 * entry. An internal seam survives on `registerActiveContext`, because the neutrality
 * gate has to register a synthetic brand to prove none of it leaks into these defaults,
 * and the experiment harness registers this same identity explicitly so the sealed runs
 * keep their entry types.
 */
export const DEFAULT_ACTIVE_CONTEXT_TOOL_NAME = "pi_fold_context";
export const DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX = "pi-fold-active-context";
export const DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL = "pi-fold Active Context";
export const DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN = "pi-fold";
export const DEFAULT_ACTIVE_CONTEXT_COMMAND_NAMES = Object.freeze({
  status: "pi-fold-context",
  fold: "fold-context",
});

export function entryTypeNamespace(entryTypePrefix: string): string {
  const suffix = "-active-context";
  return entryTypePrefix.endsWith(suffix) && entryTypePrefix.length > suffix.length
    ? entryTypePrefix.slice(0, -suffix.length)
    : entryTypePrefix;
}

export function activeContextSource(entryTypePrefix: string): string {
  const namespace = entryTypeNamespace(entryTypePrefix);
  return namespace === entryTypePrefix ? entryTypePrefix : `${namespace}/active-context`;
}

export function activeContextBrand(brandNoun: string): string {
  return /active-context$/i.test(brandNoun) ? brandNoun : `${brandNoun} active-context`;
}

export function contextBrand(brandNoun: string): string {
  return /context$/i.test(brandNoun) ? brandNoun : `${brandNoun} context`;
}

const DEFAULT_ENTRY_NAMESPACE = entryTypeNamespace(DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX);
export const ACTIVE_CONTEXT_STATE_ENTRY = `${DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX}-state`;
export const ACTIVE_CONTEXT_FOLD_RECORD_ENTRY = `${DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX}-fold-record`;
export const NATIVE_COMPACTION_RECEIPT_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-native-compaction-receipt`;
export const NATIVE_COMPACTION_DECISION_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-native-compaction-decision`;
export const PROVIDER_CONTEXT_MEASUREMENT_ENTRY = `${DEFAULT_ENTRY_NAMESPACE}-provider-context-measurement`;
export const ACTIVE_CONTEXT_STATUS_KEY = DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX;
/**
 * The action surface, whole. There was a second, narrower list while immediate
 * scheduling existed; epoch is the only scheduler now, so marks always exist and
 * `unmark` is an ordinary verb: a mark is a standing decision rather than a one-shot
 * attempt, so withdrawing one needs a verb of its own. The correction verbs are here
 * for the same reason: curation the agent cannot fix afterwards is curation it will
 * not risk making.
 *
 * There is deliberately NO agent-callable commit verb. Marking is the agent's job and
 * folding is the runtime's, and a verb the runtime is entitled to overrule is surface
 * without function: measured 2026-08-07 (rep 17), the agent called commit twice and the
 * runtime correctly held it both times. The internal commit paths -- the epoch commit,
 * the gated commit, the fence and the recovery lane -- are unchanged and unexposed.
 */
export const ACTIVE_CONTEXT_TOOL_ACTIONS = Object.freeze([
  "status", "peek", "fold", "expand", "refold", "protect", "unprotect",
  "rebrief", "reboundary", "unmark",
] as const);
export type ActiveContextToolAction = typeof ACTIVE_CONTEXT_TOOL_ACTIONS[number];
export const USER_RESCUE_MAX_SOURCE_CHARS = 512_000;
export const DEFAULT_CONTEXT_WINDOW = 272_000;
export const EXPAND_LEASE_GENERATIONS = 8;
export const MAX_EXPAND_LEASES = 64;
export const MAX_ADVISORY_DELIVERIES_PER_MILESTONE = 16;

// Surfacing SELECTOR structure. These stay INTERNAL constants rather than public
// options: they are the knobs the surfacing experiment is meant to settle, and an
// option surface fixed before the acted/used/ignored data exists would freeze a guess.
// The per-request ephemeral carrier that once rendered the slate is deleted, and its
// enable flag with it; the slate rides the commit-boundary carriers and status only.

/** BM25's canonical parameters, and memex's fold lane runs on exactly these. */
export const SURFACING_BM25_K1 = 1.5;
export const SURFACING_BM25_B = 0.75;
/**
 * The divergence trigger, as three numbers on one 0..1 scale.
 *
 * The scale is the share of the query's own saturation ceiling a document reaches, so
 * 1.0 would be every query term saturated in one document and a strong real match lands
 * in the third of the range these numbers sit in. CONTENT_HIT is the cry-wolf guard:
 * below it the fold does not match the task at all and nothing else matters. BRIEF_HIT
 * is the visibility line: at or above it the placeholder already says what the fold
 * holds, so the agent can see it and a suggestion repeats the window back to itself.
 * The MARGIN keeps the pair from meeting in the middle, where both readings are weak
 * and neither says anything.
 */
export const SURFACING_CONTENT_HIT = 0.25;
export const SURFACING_BRIEF_HIT = 0.15;
export const SURFACING_DIVERGENCE_MARGIN = 0.10;
/** Precision budget, not a rate limit: at most one suggestion per delivery point. */
export const SURFACING_SLATE_SIZE = 1;
/** One clock. It is the outcome window AND the cooldown: no re-offer before an answer. */
export const SURFACING_OUTCOME_WINDOW_ORDINALS = 12;
/** Offered this many times and never taken, and the fold leaves the candidate set. */
export const SURFACING_IGNORE_LIMIT = 2;
/** Distinct content-only terms downstream that grade an acted suggestion as used. */
export const SURFACING_PROVENANCE_TERMS = 3;
export const SURFACING_INTENT_CHARS = 1_200;
export const SURFACING_INTENT_ARGUMENT_CHARS = 120;
export const SURFACING_INTENT_RECENCY_SHARE = 0.5;
export const SURFACING_INTENT_ARGUMENT_KEYS: readonly string[] = Object.freeze([
  "path", "file_path", "query", "pattern", "command", "brief", "id",
]);
export const SURFACING_MAX_CONTENT_CHARS = 20_000;
export const SURFACING_MAX_LEDGER_RECORDS = 256;
export const SURFACING_HOOK_CHARS = 160;

// Conservative LOWER bound on UTF-8 bytes per provider token, used only to cap
// the protected byte tail as a share of a small window; never to estimate usage.
export const BYTES_PER_TOKEN_FLOOR = 2;

// Two-phase fold scheduling, and the only scheduler. A provider prefix cache is
// positional: any mid-window edit invalidates every byte after it, so the cost of
// folding is dominated by how OFTEN the projection changes, not by how much it saves.
// A fold decision is therefore a free MARK, and a later COMMIT applies every pending
// mark in one rewrite. The alternative shipped as an option through 1.0.2 and was
// deleted once measured: applying each fold where it was made cost 54 prefix rewrites
// and a 0.193 pooled cache share against epoch's 0.919 on the same task.

// Epoch knobs stay INTERNAL constants for the same reason the surfacing knobs do:
// they are what the round-2 cost measurement exists to settle, and an option surface
// fixed before that data would freeze a guess.
/**
 * The reclaim floor, and the single constant that decides whether a commit is worth
 * firing at all.
 *
 * Measured on memex (19,082 calls, 254 sessions): a token-weighted pooled cache share
 * of 89.9% across two provider wires, with steady-state requests at 91.6% and any
 * request following a mutation at 15.7%. A fold costs exactly what one user message
 * costs. Their mutations are 5.3% of requests; rep 14's were about 34%, and that
 * FREQUENCY difference is the entire gap between their 90% and our 64% -- the
 * per-mutation penalty is the same on both.
 *
 * So a commit that would free less than this share of the truthful budget does not
 * fire: it defers and accumulates until it is worth a full prefix. A request whose
 * projection exceeds the provider input budget is rejected outright, so recovery must
 * produce a window that fits; the hard fence and overflow recovery fire regardless.
 */
export const COMMIT_RECLAIM_FLOOR_SHARE = 0.02;

/**
 * The pin ceiling (Shane 2026-08-09): protect may hold at most this share of the
 * truthful serving budget raw. Protect was a per-entry promise with no mass bound,
 * so a protect-happy agent could pin the window solid and leave every commit
 * nothing to reclaim; past the cap, protect refuses with the cap named and
 * unprotect is the release valve. A constant, not a knob.
 */
export const MAX_PINNED_SHARE = 0.25;

// ---------------------------------------------------------------------------
// THE THERMOSTAT. One declared object, one denominator, five numbers.
//
// Occupancy used to be a cluster: a trigger share of the budget, a post-commit target
// share of the budget, a freeing floor stated as a share of the WINDOW, a fresh tail
// stated in turns and bytes with a small-window byte cap, and a consolidation count.
// Three of those divided by a different denominator than the other two, so the same
// English word meant two numbers five to ten points apart at large windows. They are
// one decision, so they are one object, and every one of them is now a proportion of
// `capacityAccounting.budgetTokens` -- the truthful serving budget, the same value the
// fence, the estimator and the trigger already read.
//
// User-set, never agent-set (Sol 2026-08-09): an agent that can widen freshTail, shrink
// staleTail or move maxTarget to the fence neutralizes the governor without ever
// calling a verb it is not entitled to. Agent authority stays where it already is --
// mark, unmark, protect, unprotect -- and status may REPORT these values.
// ---------------------------------------------------------------------------

/** The five numbers that decide when a commit fires, how deep it cuts, and what it may reach. */
export interface ActiveContextThresholds {
  /** Occupancy of the serving budget that fires an automatic commit. */
  maxTarget: number;
  /** Occupancy an automatic commit folds down toward. The hysteresis gap is maxTarget - minTarget. */
  minTarget: number;
  /** Newest share of the serving budget where nothing folds, marked or not. */
  freshTail: number;
  /** Oldest share of the serving budget where automation may fold every unpinned foldable. */
  staleTail: number;
  /** Unpinned folds in the stale zone at or above which placeholders become span material. */
  consolidateAfter: number;
}

/**
 * The proven values, and the reason each one is the number it is.
 *
 * maxTarget 0.80: Shane's RULING after rep 15. Below this line the runtime is quiet --
 * nothing folds automatically at all -- so the line is where the fold event should
 * happen, and the remaining fifth of the budget is the runway the commit itself spends.
 *
 * minTarget 0.35: the thermostat's lower line, and the reason event spacing is
 * structural rather than hoped for. Rep 13's crumb ratchet fired, freed a little and
 * re-fired, so the window climbed a staircase of mutations; folding down to a lower
 * line means the next event cannot arrive until inflow has refilled a 45-point gap.
 * Rep 13's largest measured inflow step was 27,815 tokens against a 400,000 window,
 * about 7 points, so six worst-case steps land between events.
 *
 * freshTail 0.02: today's protected tail, re-denominated. The proven tail was 24,000
 * serialized bytes; at the estimator's 4 bytes per token that is 6,000 tokens, and
 * against the reference serving budget of 383,616 tokens (a 400,000-token window minus
 * the 16,384-token response reserve) that is 1.564%, rounded UP to 0.02 so the
 * re-denomination never narrows protection at the reference deployment.
 *
 * staleTail 0.78: today's automation reach, re-denominated. Before this build every
 * byte outside the fresh tail was automation-eligible, so at the trigger the reach was
 * exactly maxTarget - freshTail. That is also the largest value the non-overlap
 * invariant admits, so the default reproduces the proven behavior and the middle zone
 * is what a user opens by lowering it.
 *
 * consolidateAfter 10: the proven count (the retired width rung counted the same roots
 * against the same line). Placeholder briefs are about 300 tokens, so ten siblings cost
 * under 1% of budget, and ten keeps an overnight session within two hops of any
 * verbatim byte. A count, not a proportion: table-of-contents readability does not
 * scale with window size, and a proportion would add a second denominator to the one
 * thing this object exists to make singular.
 */
export const DEFAULT_THRESHOLDS: Readonly<ActiveContextThresholds> = Object.freeze({
  maxTarget: 0.80,
  minTarget: 0.35,
  freshTail: 0.02,
  staleTail: 0.78,
  consolidateAfter: 10,
});

/**
 * The smallest serving budget this package supports, in tokens.
 *
 * Derived from the package's own two largest bounded replies: one status payload
 * (CONTEXT_STATUS_RESPONSE_BYTES, 24,000) plus one default peek
 * (PEEK_DEFAULT_MAX_BYTES, 16,000) is 40,000 bytes, which at the estimator's 4 bytes
 * per token is 10,000 tokens. A budget that cannot hold the largest pair of answers
 * this package can emit back to back cannot serve the surface it ships, so registration
 * refuses it by name rather than folding its way into an unservable session.
 */
export const MINIMUM_SUPPORTED_BUDGET_TOKENS = 10_000;

/**
 * The narrowest fresh tail that still protects anything, in tokens: one minimum tool
 * result (`minToolChars` 2,000 bytes) at the estimator's 4 bytes per token. A tail
 * thinner than the smallest thing automation will ever fold protects nothing.
 */
export const MINIMUM_FRESH_TAIL_TOKENS = 500;

export class ThresholdPolicyError extends Error {
  readonly invariant: string;
  constructor(invariant: string, message: string) {
    super(message);
    this.name = "ThresholdPolicyError";
    this.invariant = invariant;
  }
}

function thresholdProportion(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ThresholdPolicyError(field, `thresholds.${field} must be a proportion above 0 and below 1`);
  }
  return value;
}

/**
 * The whole object, validated atomically, or an error naming the invariant that failed.
 *
 * Atomic because these are five halves of one decision: validating them one at a time is
 * how a trigger moved from 0.50 to 0.80 while its target stayed at 0.35 and the
 * docstring kept arguing a 15-point gap that had become 45. Never clamped: a policy that
 * cannot be served is a registration error, not a value to quietly rewrite (Sol).
 */
export function resolveThresholds(value: unknown): ActiveContextThresholds {
  if (value === undefined) return { ...DEFAULT_THRESHOLDS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ThresholdPolicyError("shape", "thresholds must be an object with all five fields");
  }
  const supplied = value as Record<string, unknown>;
  const fields = ["maxTarget", "minTarget", "freshTail", "staleTail", "consolidateAfter"] as const;
  for (const key of Object.keys(supplied)) {
    if (!(fields as readonly string[]).includes(key)) {
      throw new ThresholdPolicyError("shape", `thresholds has no ${key} field`);
    }
  }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(supplied, field)) {
      throw new ThresholdPolicyError("shape", `thresholds must declare ${field}; the object is set whole or not at all`);
    }
  }
  const maxTarget = thresholdProportion(supplied.maxTarget, "maxTarget");
  const minTarget = thresholdProportion(supplied.minTarget, "minTarget");
  const freshTail = thresholdProportion(supplied.freshTail, "freshTail");
  const staleTail = thresholdProportion(supplied.staleTail, "staleTail");
  const consolidateAfter = supplied.consolidateAfter;
  if (typeof consolidateAfter !== "number" || !Number.isInteger(consolidateAfter) || consolidateAfter < 1) {
    throw new ThresholdPolicyError("consolidateAfter", "thresholds.consolidateAfter must be a positive integer count");
  }
  // L < M: the thermostat needs a gap to fold down into.
  if (!(minTarget < maxTarget)) {
    throw new ThresholdPolicyError("minTarget<maxTarget",
      "thresholds.minTarget must sit below thresholds.maxTarget, or a commit has no depth to reach");
  }
  // F < M: a fresh tail wider than the trigger is a window that triggers on protection.
  if (!(freshTail < maxTarget)) {
    throw new ThresholdPolicyError("freshTail<maxTarget",
      "thresholds.freshTail must sit below thresholds.maxTarget, or the trigger fires on protected mass alone");
  }
  // S <= M - F: the zones may not overlap at the trigger.
  if (!(staleTail <= maxTarget - freshTail)) {
    throw new ThresholdPolicyError("staleTail<=maxTarget-freshTail",
      "thresholds.staleTail must not overlap the fresh tail at the trigger (staleTail <= maxTarget - freshTail)");
  }
  // G >= F: one refill of the protected tail must not re-arm the trigger by itself.
  if (!(maxTarget - minTarget >= freshTail)) {
    throw new ThresholdPolicyError("gap>=freshTail",
      "the hysteresis gap (maxTarget - minTarget) must be at least thresholds.freshTail, " +
      "or refilling the protected tail alone re-fires the trigger");
  }
  // P + F < M, in TOKENS at the smallest supported budget, so rounding cannot slip past:
  // the pin ceiling plus the structurally fresh tail is the floor a commit can never get
  // under, and a trigger at or below that floor announces commits with nothing to reclaim.
  const pinned = Math.ceil(MAX_PINNED_SHARE * MINIMUM_SUPPORTED_BUDGET_TOKENS);
  const fresh = Math.ceil(freshTail * MINIMUM_SUPPORTED_BUDGET_TOKENS);
  if (!(pinned + fresh < Math.floor(maxTarget * MINIMUM_SUPPORTED_BUDGET_TOKENS))) {
    throw new ThresholdPolicyError("pinnedPlusFreshTail<maxTarget",
      `the pin ceiling (${MAX_PINNED_SHARE}) plus thresholds.freshTail must stay below ` +
      `thresholds.maxTarget at the ${MINIMUM_SUPPORTED_BUDGET_TOKENS}-token minimum supported budget`);
  }
  return { maxTarget, minTarget, freshTail, staleTail, consolidateAfter };
}

/**
 * The tiny-window refusal, evaluated once at registration against the declared budget.
 * Reject, never clamp: a deployment whose window cannot carry the policy it asked for
 * gets told so with both numbers rather than a silently different governor.
 */
export function assertThresholdsServable(thresholds: ActiveContextThresholds, budgetTokens: number): void {
  if (!Number.isFinite(budgetTokens) || budgetTokens < MINIMUM_SUPPORTED_BUDGET_TOKENS) {
    throw new ThresholdPolicyError("minimumBudget",
      `a ${Math.floor(budgetTokens)}-token serving budget is below the ` +
      `${MINIMUM_SUPPORTED_BUDGET_TOKENS}-token minimum this package supports`);
  }
  const freshTokens = Math.floor(thresholds.freshTail * budgetTokens);
  if (freshTokens < MINIMUM_FRESH_TAIL_TOKENS) {
    throw new ThresholdPolicyError("freshTailTokens",
      `thresholds.freshTail is ${freshTokens} tokens of a ${Math.floor(budgetTokens)}-token serving budget, ` +
      `below the ${MINIMUM_FRESH_TAIL_TOKENS}-token minimum one foldable unit needs`);
  }
}

/**
 * THE serving budget, from one window, by one formula.
 *
 * The output reservation is what makes the budget differ from the window, so it is
 * subtracted exactly once and everything downstream -- the fence, the estimator, the
 * trigger, and every threshold proportion -- divides by the same number.
 */
/**
 * A zone width in serialized BYTES, from a share of the serving budget.
 *
 * The thresholds are proportions of one denominator and a transcript position is a byte
 * count, so exactly one conversion stands between them: the estimator's bytes per token.
 * It is stated here, once, so the fresh tail and the stale tail are cut by one ruler.
 */
export function zoneBytes(share: number, budgetTokens: number): number {
  if (!Number.isFinite(share) || share <= 0 || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return 0;
  return Math.floor(share * budgetTokens * ESTIMATED_BYTES_PER_TOKEN);
}

export function servingBudgetTokens(window: number): number {
  const resolved = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  return resolved - Math.min(ACTIVE_CONTEXT_POLICY.responseReserve, Math.floor(resolved * 0.1));
}

export const MAX_PENDING_MARKS = 256;
/** Enough batches to actually reach the floor on a wide window before the loop exits. */
export const EPOCH_MAX_TOPUP_MARKS = 64;
/** Estimate only; provider token accounting always comes from a measured response. */
export const ESTIMATED_BYTES_PER_TOKEN = 4;
/** Rendered navigation/topology overhead assumed around a brief when estimating a placeholder. */
export const ESTIMATED_PLACEHOLDER_OVERHEAD_BYTES = 240;

// ---------------------------------------------------------------------------
// The reliability spine. Every behavior below shipped as an off-by-default lever
// through iterations 2 and 3 and was sealed ON by rep 14 (64/64), so it is now
// simply how pi-fold works: the flags and their conditional twins are gone, and
// git history is the lineage. What stays configurable is only what is genuinely a
// deployment fact (`providerTotalWindow`). The experiment conditions that used to sit
// beside it (`foldScheduling`, `foldPeekResults`, `guidedCuration`) are gone too: epoch
// scheduling, peek foldability and guided curation are simply how pi-fold works, and
// the harness keeps reading the keys only so sealed runs still validate.
//
// Sealed unconditional: admission control, retained pending marks, the eligible-share
// commit trigger, stage-identified briefs, the current-turn commit guard, the
// pinned-mass backstop, the status index diet, delivery-counted advisories, and
// projection instrumentation.
//
// NOT sealed, deleted: ephemeral peek and its per-call `ephemeral` override. It rewrote
// a consumed peek result in place on the theory the edit was tail-local. It is not: the
// rewrite waits for a later assistant message to exist, by which point the window has
// grown over it and the edit lands mid-prefix. Rep 22 measured two of them costing 100k
// fresh tokens. A peek is append-only; the tool-fold rung reclaims the duplicate bytes
// at the next commit, which is the one moment a rewrite is already being paid for.
// ---------------------------------------------------------------------------

/**
 * The provider serving window is the TOTAL admission budget minus whatever output
 * reservation the deployment actually asked for; the per-request max-input descriptor
 * assumes a full output reservation and understates the real ceiling. Measured
 * 2026-08-06: a run aborted at ~297k projected tokens against a 272k descriptor while
 * the same provider had just accepted 339,689 tokens. Declaring the total window is
 * the deployment's own fact, so it is the option; there is no separate boolean, and
 * an undeclared window falls back to the descriptor and SAYS so in the accounting.
 */

/** Narrowing is what makes a refusal governance instead of denial. */
export const PEEK_MIN_SLICE_BYTES = 1_024;

/** How many folds the dieted status payload ranks by what they would reclaim. */
export const STATUS_DIET_SUGGESTIONS = 5;

export const MAX_PROJECTION_HASH_RECORDS = 64;

// ---------------------------------------------------------------------------
// Guided curation: the two-signal curation trigger, its bounded last-call gate,
// and the reactive receipt block. It shipped as the one iteration-4 experiment
// condition and is unconditional now, so only the constants below remain.
// ---------------------------------------------------------------------------

/**
 * The three occupancy waypoints, as shares of the truthful serving budget.
 *
 * Each one lands exactly once per upward crossing as an append-once notice that then
 * persists in the window the way a tool result does: appended at the tail, closed over
 * by the freeze, never re-rendered mid-cycle, so it can never move a prefix byte. A
 * commit that drops occupancy back under a waypoint re-arms it; the next crossing is a
 * new event and gets a new notice.
 */
export const THRESHOLD_NOTICE_SHARES: readonly number[] = Object.freeze([0.25, 0.50, 0.75]);
/** Delivered notices kept rendered in the window; the oldest leaves the carrier, never the stream. */
export const MAX_THRESHOLD_NOTICES = 9;
/**
 * The two guidance surfaces, as ONE public option, both switches defaulting on.
 * Shane's ruling: notices and action responses are optional, and the default is yes.
 */
export interface ActiveContextGuidance {
  /** Append-once occupancy waypoints at 25/50/75 percent of the serving budget. */
  thresholdNotices: boolean;
  /** Persistent acknowledgements for the agent's own context actions. */
  actionResponses: boolean;
}

export const DEFAULT_GUIDANCE: ActiveContextGuidance = Object.freeze({
  thresholdNotices: true,
  actionResponses: true,
});

const GUIDANCE_KEYS: readonly (keyof ActiveContextGuidance)[] = Object.freeze([
  "thresholdNotices", "actionResponses",
]);

/**
 * Validated whole, like the thresholds: an unknown key is a typo, not a silent no-op.
 *
 * Booleans and nothing else. The dosage families that used to parameterize guidance
 * (profiles, reminder shares, milestone budgets) were deleted for measuring nothing
 * across eleven runs, and shares or per-notice keys here would rebuild them by another
 * name. An operator either wants the runtime to speak at the boundary or does not.
 */
export function resolveGuidance(value: unknown): ActiveContextGuidance {
  if (value === undefined) return DEFAULT_GUIDANCE;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("guidance must be an object of { thresholdNotices, actionResponses } booleans");
  }
  for (const key of Object.keys(value)) {
    if (!GUIDANCE_KEYS.includes(key as keyof ActiveContextGuidance)) {
      throw new Error(`guidance has no ${key} setting: the only keys are ` +
        `${GUIDANCE_KEYS.join(", ")}, and both are booleans`);
    }
  }
  const resolved = { ...DEFAULT_GUIDANCE } as ActiveContextGuidance;
  for (const key of GUIDANCE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const setting = (value as Record<string, unknown>)[key];
    if (typeof setting !== "boolean") throw new Error(`guidance.${key} must be a boolean`);
    resolved[key] = setting;
  }
  return Object.freeze(resolved);
}
/** The last-call is LITERAL persisted bytes; the bound is on the stored text itself. */
export const MAX_LAST_CALL_TEXT_BYTES = 2_048;
/** One notice is one waypoint line; a waypoint that becomes a paragraph is bloat. */
export const MAX_THRESHOLD_NOTICE_TEXT_BYTES = 512;
/**
 * The surfacing line's own bound, applied to the line and not to the carrier that
 * carries it, so a carrier's total overhead is its own bound plus this one and stays a
 * number a gate can pin. The 21.9% ephemeral-slate tax is what this is measured
 * against: one bounded line landing inside a rewrite the commit already paid for.
 */
export const MAX_SURFACING_LINE_BYTES = 384;

/** How many automatic-action receipts stay in the window; the oldest ages out. */
export const MAX_CONTEXT_RECEIPTS = 3;
/** Hard byte cap on the rendered receipt block, so a receipt can never itself bloat. */
export const CONTEXT_RECEIPT_BLOCK_BYTES = 900;
/** Durable instrumentation records kept in the in-memory ledger for status. */
export const MAX_CONTEXT_ATTEMPT_RECORDS = 128;

// ---------------------------------------------------------------------------
// The mark response.
//
// Measured 2026-08-07 (rep 17): every context action was followed by a projection
// REWRITE, never an append, because the surface answered a mark by refreshing blocks
// the agent had already paid to cache. A tail-appended tool result is the one place
// left that can inform the agent for free, so the awareness moved THERE and the
// projection went byte-frozen between fold events. The result is bounded on the same
// principle as the receipt block: a report about bloat that becomes bloat has argued
// against itself.
// ---------------------------------------------------------------------------

/** Hard byte cap on the rendered awareness block a mark call answers with. */
export const CONTEXT_MARK_RESPONSE_BYTES = 900;
/**
 * Hard byte cap on one serialized status payload, every detail variant included.
 * Measured 2026-08-07 (rep 19): six paged status results accumulated to ~254k tokens
 * and the seventh answered with 526KB, 6.2x the remaining headroom, aborting the
 * request. Paging already existed; nothing FORCED it. Above the cap the listing is
 * truncated at a unit boundary and a continuation names the next offset, so the
 * biggest possible status answer is about 6k tokens and the rest is another page.
 */
export const CONTEXT_STATUS_RESPONSE_BYTES = 24_000;
/** How many unmarked candidates the awareness block names; the remainder is an aggregate. */
export const MAX_UNMARKED_CANDIDATES = 3;

// ---------------------------------------------------------------------------
// Bite-sized folds and bounded peeks. These two constants are one decision read
// from two ends, so they are stated together and kept equal.
//
// Measured 2026-08-06 (rep 6): a single 60,432-byte chapter fold hid the needed
// fact in its tail, and every peek of it was either truncated short of the answer
// or too expensive to widen. A fold is only navigable if reading one back is cheap,
// so a fold's source is capped and an oversized span is SPLIT into sequential
// bounded folds, each with its own brief. The peek bound is the same number, so a
// default peek of one bite-sized fold returns it whole -- about 4,000 tokens, a
// read any session can afford -- and only a legacy oversized fold is ever truncated.
// ---------------------------------------------------------------------------

/** A fold whose exact source exceeds this is split into sequential bounded folds. */
export const MAX_FOLD_SPAN_CHARS = 16_000;
/**
 * The other bound: a SLIVER of stale raw content hugging a fold boundary is absorbed
 * into its later neighbour inside a commit the epoch already paid for.
 *
 * The threshold is deliberately tiny, measured in the session's own calibrated TOKENS,
 * and it is not pressure-scaled. Non-sequential curation is a first-class state: an
 * agent may hold folds at 10:20, 40:55 and 60:70 with raw spans between them ON
 * PURPOSE, and a mechanism that swallowed those gaps would quietly turn pi-fold into
 * system-controlled compaction with the curation element deleted. 256 tokens is about
 * one short prompt or one one-line result -- nobody deliberately keeps a sliver that
 * small as standing context -- and it sits an order of magnitude under the minimum
 * chapter size the ladder itself will fold. Anything larger stays raw permanently,
 * however ragged the projection looks; the ladder's ordinary fold eligibility is the
 * only thing that ever touches it, and absorption never becomes a second folding path.
 *
 * Later, not earlier, because extending the LATER fold backward mutates at a shallower
 * prefix position and preserves more of the cache. There is no content-affinity logic,
 * every absorption is receipted, and a wrong grouping is one `reboundary` away.
 */
export const MAX_WEDGE_ABSORB_TOKENS = 256;
/** What a peek returns without an explicit widening argument. */
export const PEEK_DEFAULT_MAX_BYTES = 16_000;
/** Head share of a truncated peek; the remainder is the tail, where conclusions live. */
export const PEEK_HEAD_SHARE = 0.6;

// ---------------------------------------------------------------------------
// Overflow rollback and recovery.
// ---------------------------------------------------------------------------

/**
 * How many times one inflow may be recovered before the runtime gives up.
 *
 * A provider context-overflow rejection mutates nothing durable -- the assistant
 * message never lands and the projection is rebuilt per request -- so recovery is a
 * reduction plus a rebuild, not a branch rewind. Two attempts is the cap: the first
 * folds at fence pressure with the guard fully waived, the second reaches into the
 * fresh tail, and a third would be asking the same question of the same evidence.
 * Past it the run fails LOUDLY, because an inflow that cannot fit after maximal
 * folding is a genuine impossibility rather than a recoverable state.
 */
export const OVERFLOW_RECOVERY_MAX_ATTEMPTS = 2;

/**
 * Active-context tool actions that read without mutating, so their results may fold.
 *
 * A peek copies a fold's own stored source back into the window, so leaving it raw is a
 * pure duplicate of evidence the runtime already holds and the tool-fold rung reclaims
 * it. There was a narrower set while immediate scheduling existed, reached by opting
 * out; epoch is the only scheduler now and this classification is unconditional.
 */
export const PEEK_READ_ONLY_CONTEXT_ACTIONS: ReadonlySet<string> = new Set(["status", "peek"]);

export type MarkOrigin = "agent" | "ladder";

/** A fold decided but not yet applied: no projection byte has moved for it. */
export interface PendingFoldMark {
  mark: "fold";
  id: string;
  kind: FoldKind;
  parts: FoldPart[];
  brief: string;
  briefProvenance: BriefProvenance;
  origin: MarkOrigin;
  /** Transcript ordinal at mark time; orders the commit. Never a wall clock. */
  ordinal: number;
}

/** An expanded fold decided to return to its placeholder at the next commit. */
export interface PendingRefoldMark {
  mark: "refold";
  id: string;
  origin: MarkOrigin;
  ordinal: number;
}

export type PendingMark = PendingFoldMark | PendingRefoldMark;

export const ACTIVE_CONTEXT_POLICY = Object.freeze({
  refoldRatio: 0.85,
  prepareRatio: 0.90,
  warmRatio: 0.55,
  responseReserve: 16_384,
  minToolChars: 2_000,
  minChapterChars: 4_000,
  maxChapterChars: 128_000,
  maxChapterTurns: 4,
  maxSourceChars: 200_000,
  maxFoldSourceRefs: 256,
  maxBriefChars: 1_200,
  briefTimeoutMs: 120_000,
  orientationMessages: 2,
  maxOrientationChars: 12_000,
});

export type FoldKind = "tool-result" | "chapter" | "consolidation";
export type FoldPart = { kind: "raw"; ref: EvidenceRef } | { kind: "fold"; foldId: string };
export type BriefProvenance =
  | { kind: "supplied" }
  | { kind: "deterministic" }
  | {
      kind: "model" | "luna";
      provider: string;
      model: string;
      effort: string;
      launchContractDigest?: string;
    };

export interface ActiveFold {
  id: string;
  kind: FoldKind;
  parentId: string | null;
  parts: FoldPart[];
  brief: string;
  provenance: BriefProvenance;
  sourceSha256: string;
  sourceChars: number;
  placeholderChars: number;
  createdAt: number;
}

export interface PreparedFold {
  id: string;
  sessionId: string;
  generation: number;
  branchSha256: string;
  topologySha256: string;
  protectionSha256: string;
  sourceRefs: EvidenceRef[];
  sourceSha256: string;
  beforeRefs: EvidenceRef[];
  beforeSha256: string;
  afterRefs: EvidenceRef[];
  afterSha256: string;
  fold: ActiveFold;
}

/**
 * The graded success labels. `shown` is the open offer; the other three are terminal.
 * `acted` is a context verb on the surfaced fold inside the window, `used` is that plus
 * the retrieved content showing up in what the agent went on to say or call, and
 * `ignored` is a closed window with neither.
 */
export type SurfacingOutcome = "shown" | "acted" | "used" | "ignored";

/**
 * The durable SUPPRESSION ledger: one record per fold, not one per showing. The
 * per-suggestion detail a bandit trains on is the event stream, which is durable and
 * unbounded; this is only what the next selection pass must not forget.
 */
export interface SurfacingRecord {
  id: string;
  surfaced: number;
  taken: number;
  /** Transcript ordinal of the last state change; the cooldown and the window read it. */
  ordinal: number;
  outcome: SurfacingOutcome;
}

/** One suppression-state change, returned so the caller emits it rather than inferring it. */
export interface SurfacingTransition {
  id: string;
  from: SurfacingOutcome;
  to: SurfacingOutcome;
  ordinal: number;
}

/** One collapsed fold, scored on both channels. */
export interface SurfacingCandidate {
  id: string;
  /** What the placeholder shows: the brief channel. */
  brief: string;
  /** What the fold stores, descendants included: the content channel. */
  content: string;
  route: string;
  /** Transcript position of the fold's last entry; higher is more recent. Never a clock. */
  position: number;
  depth: number;
}

export interface SurfacingSuggestion extends SurfacingCandidate {
  contentScore: number;
  briefScore: number;
  margin: number;
  /** Slate position, from 0. One suggestion per delivery point, so today it is always 0. */
  slot: number;
}

export interface ActiveContextState {
  version: 1;
  sessionId: string;
  revision: number;
  folds: ActiveFold[];
  expanded: string[];
  protected: EvidenceRef[];
  tokensSinceToolFold: number;
  leases: Record<string, number>;
  surfacing?: SurfacingRecord[];
  /** Epoch scheduling only; omitted when empty so immediate-mode state digests never move. */
  pendingMarks?: PendingMark[];
  /** Retired with peek reclamation; carried only so pre-cut state still parses. */
  pinnedPeeks?: never;
  /**
   * Agent-corrected fold briefs, by fold id. A fold RECORD is content-addressed and
   * immutable -- rewriting its brief in place would report a conflicting durable fold
   * and suspend automatic management -- so a re-brief is durable state beside the
   * record rather than a mutation of it. Omitted when empty.
   */
  briefs?: Record<string, string>;
  prepared?: PreparedFold;
  advisory?: {
    highWater: number;
    delivered: Record<string, number>;
    armed?: { milestone: AdvisoryMilestone; threshold: number; scheduleKey: string };
  };
  /**
   * The one action-prompt carrier: computed at a fold commit, persisted as LITERAL
   * bytes so every re-render of the same epoch is byte-identical, replaced only by
   * the next epoch's rider. Omitted when absent so pre-rider state digests never move.
   */
  rider?: { epoch: number; text: string };
  /**
   * The armed pre-commit last-call: one exposure per band-top crossing, persisted as
   * LITERAL bytes like the rider. `exposure` is the context.lastcall event's stream
   * seq; `contextCalls` and `agentMarks` are the arming snapshot the response
   * attribution is measured against. Cleared by the commit that consumes it. Omitted
   * when absent so pre-last-call state digests never move.
   */
  lastCall?: { exposure: number; ordinal: number; contextCalls: number; agentMarks: number; text: string };
  /**
   * Threshold notices: `fired` is the waypoint shares spent this occupancy cycle
   * (re-armed by a commit that drops back under them), `ring` the delivered notices
   * still rendered in the window, literal bytes, oldest evicted. Omitted when absent.
   */
  notices?: { fired: number[]; ring: Array<{ share: number; ordinal: number; text: string }> };
}

export interface FoldRecordRef {
  id: string;
  sha256: string;
}

export interface FoldRecordEntry {
  version: 1;
  sessionId: string;
  foldId: string;
  recordSha256: string;
  fold: ActiveFold;
}

export interface ActiveContextCheckpointV2 {
  version: 2;
  kind: "checkpoint";
  sessionId: string;
  revision: number;
  foldRefs: FoldRecordRef[];
  expanded: string[];
  protected: EvidenceRef[];
  prepared: PreparedFold | null;
  tokensSinceToolFold?: number;
  leases?: Record<string, number>;
  surfacing?: SurfacingRecord[];
  pendingMarks?: PendingMark[];
  briefs?: Record<string, string>;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  rider?: NonNullable<ActiveContextState["rider"]>;
  lastCall?: NonNullable<ActiveContextState["lastCall"]>;
  notices?: NonNullable<ActiveContextState["notices"]>;
  stateSha256: string;
}

export interface ActiveContextDeltaV2 {
  version: 2;
  kind: "delta";
  sessionId: string;
  revision: number;
  baseRevision: number;
  baseStateSha256: string;
  addFoldRefs: FoldRecordRef[];
  removeFoldIds: string[];
  expanded: string[];
  protected: EvidenceRef[];
  prepared: PreparedFold | null;
  tokensSinceToolFold?: number;
  leases?: Record<string, number>;
  surfacing?: SurfacingRecord[];
  pendingMarks?: PendingMark[];
  briefs?: Record<string, string>;
  advisory?: NonNullable<ActiveContextState["advisory"]>;
  rider?: NonNullable<ActiveContextState["rider"]>;
  lastCall?: NonNullable<ActiveContextState["lastCall"]>;
  notices?: NonNullable<ActiveContextState["notices"]>;
  stateSha256: string;
}

export type ActiveContextStateWireV2 = ActiveContextCheckpointV2 | ActiveContextDeltaV2;

export interface MappedMessage {
  index: number;
  message: unknown;
  ref: EvidenceRef | null;
}

export interface BranchObject {
  branchIndex: number;
  message: unknown;
  ref: EvidenceRef;
}

export interface CompleteTurn {
  start: number;
  end: number;
}

export interface ActiveContextSnapshot {
  sessionId: string;
  messages: unknown[];
  mapped: MappedMessage[];
  branchObjects: BranchObject[];
  completeTurns: CompleteTurn[];
  freshBoundary: number;
  /**
   * Exclusive end of the STALE zone: indices below it are the oldest `staleTail` share
   * of the serving budget, and automation may reach nothing else. Between it and the
   * fresh boundary is the middle, which is agent judgment only.
   */
  staleBoundary: number;
  /** The five thermostat numbers in force for this session. */
  thresholds: ActiveContextThresholds;
  /** The serving budget the thresholds are proportions of. One denominator. */
  budgetTokens: number;
  protectedIndices: Set<number>;
  toolProtectedIndices: Set<number>;
  policy: typeof ACTIVE_CONTEXT_POLICY;
  toolName: string;
  brandNoun: string;
  entryTypePrefix: string;
  blacklistAutoFoldTools: ReadonlySet<string>;
  /** Active-context tool actions treated as read-only when classifying tool batches. */
  readOnlyContextActions: ReadonlySet<string>;
  contextWindow: number;
  windowSource: "reported" | "fallback";
}

export interface FoldCandidate {
  kind: FoldKind;
  parts: FoldPart[];
  sourceRefs: EvidenceRef[];
}

/**
 * The auto-fold exception list, EMPTY by default: every completed tool batch is foldable
 * by the ladder without an agent mark, and this names the tools whose results must stay
 * raw. The list ran the other way until the 2026-08-10 surface, as an allow-list seeded
 * with pi's four built-in readers, which meant a deployment's own tools were unfoldable
 * until someone remembered to name them and the ladder starved on exactly the results
 * that filled the window. Foldability was never the protection: pins, the three zones and
 * the fresh tail are, and they apply to a blacklisted tool and an ordinary one alike.
 */
export const AUTO_FOLD_BLACKLIST_DEFAULT: ReadonlySet<string> = new Set();

export type AdvisoryMilestone = "orientation" | "notice" | "tools" | "chapters" | "urgent";
