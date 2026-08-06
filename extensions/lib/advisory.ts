import { sha256Value } from "../json.ts";
import { clone } from "./canonical.ts";
import {
  boundReceiptText,
  hardFenceRatio,
} from "./measurement.ts";
import { ADVISORY_BUDGETS, validAdvisoryState } from "./persistence.ts";
import type {
  ActiveContextSnapshot,
  ActiveContextState,
  AdvisoryMilestone,
  GuidanceProfile,
  SurfacingSuggestion,
} from "./policy.ts";
import {
  contextBrand,
  DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  DEFAULT_GUIDANCE_PROFILE,
  GUIDANCE_PROFILES,
} from "./policy.ts";

export { ADVISORY_BUDGETS };

/**
 * Every delivered advisory ends with this clause. An advisory is ambient state, not a
 * prompt: the agent alone decides whether to act on it, and it must never read as a
 * message that wants an answer.
 */
export const ADVISORY_CONTINUATION_CLAUSE =
  "This is a background capacity note, not a message to answer: act on it only if you " +
  "judge the moment right, and in every case CONTINUE the task you were working on.";

export interface AdvisorySchedule {
  key: string;
  rungs: Array<{ milestone: AdvisoryMilestone; threshold: number; budget: number }>;
}

export function advisoryState(state: ActiveContextState): NonNullable<ActiveContextState["advisory"]> {
  if (state.advisory === undefined) return { highWater: 0, delivered: {} };
  if (!validAdvisoryState(state.advisory)) {
    throw new Error("Corrupt in-memory advisory state (no silent fallback)");
  }
  return clone(state.advisory);
}

export function clearArmedAdvisory(state: ActiveContextState): ActiveContextState {
  const current = advisoryState(state);
  if (!current.armed) return state;
  const advisory = { ...current };
  delete advisory.armed;
  return { ...state, advisory };
}

export function normalizeGuidanceProfile(guidance: unknown = DEFAULT_GUIDANCE_PROFILE): GuidanceProfile {
  if (!GUIDANCE_PROFILES.includes(guidance as GuidanceProfile)) {
    throw new Error('guidance must be "pressure", "curation", or "minimal"');
  }
  return guidance as GuidanceProfile;
}

function guidanceRungs(
  snapshot: Pick<ActiveContextSnapshot, "policy" | "contextWindow">,
  guidance: GuidanceProfile,
): AdvisorySchedule["rungs"] {
  const urgent = {
    milestone: "urgent" as const,
    threshold: hardFenceRatio(snapshot) - 0.03,
    budget: ADVISORY_BUDGETS.urgent,
  };
  if (guidance === "minimal") return [urgent];
  return [
    ...(guidance === "curation"
      ? [{ milestone: "orientation" as const, threshold: 0.25, budget: ADVISORY_BUDGETS.orientation }]
      : []),
    { milestone: "notice" as const, threshold: 0.50, budget: ADVISORY_BUDGETS.notice },
    { milestone: "tools" as const, threshold: snapshot.policy.toolFoldRatio - 0.04,
      budget: ADVISORY_BUDGETS.tools },
    { milestone: "chapters" as const, threshold: snapshot.policy.prepareRatio - 0.05,
      budget: ADVISORY_BUDGETS.chapters },
    urgent,
  ];
}

export function advisorySchedule(
  snapshot: Pick<ActiveContextSnapshot, "policy" | "contextWindow">,
  guidance: GuidanceProfile = DEFAULT_GUIDANCE_PROFILE,
): AdvisorySchedule {
  const rungs = guidanceRungs(snapshot, guidance);
  for (let index = rungs.length - 2; index >= 0; index -= 1) {
    rungs[index].threshold = Math.min(rungs[index].threshold, rungs[index + 1].threshold - 0.02);
  }
  for (const rung of rungs) rung.threshold = Math.max(0, Math.min(1, rung.threshold));
  return {
    key: sha256Value(rungs.map(({ milestone, threshold }) => ({ milestone, threshold }))),
    rungs,
  };
}

/**
 * Record that an armed advisory actually REACHED the agent.
 *
 * The budget used to be spent when a milestone armed. Any automatic fold in the same
 * context pass then cleared the arm before the projection was built, so a working
 * ladder drained every milestone budget without ever emitting a word. Measured
 * 2026-08-06 on an identical pressure schedule: an idle-ladder session delivered 7
 * advisories, and a tool-using session delivered 0 while reporting notice, tools and
 * chapters each "delivered" once. All four instrumented runs were the second case.
 */
export function recordAdvisoryDelivery(
  state: ActiveContextState,
  milestone: AdvisoryMilestone,
): ActiveContextState {
  const current = advisoryState(state);
  const delivered = { ...current.delivered };
  delivered[milestone] = (delivered[milestone] ?? 0) + 1;
  const advisory = { ...current, delivered };
  delete advisory.armed;
  return { ...state, advisory };
}

export function updateAdvisoryMilestone(
  currentState: ActiveContextState,
  ratio: number,
  schedule: AdvisorySchedule,
  scheduleChanged: boolean,
  scheduleKey: string,
  /** Spend the milestone budget on DELIVERY rather than on arming. */
  countOnDelivery = false,
): { state: ActiveContextState; milestone: AdvisoryMilestone | null } {
  const current = advisoryState(currentState);
  if (scheduleChanged) {
    return {
      state: { ...currentState, advisory: { ...current, highWater: Math.min(1, ratio) } },
      milestone: null,
    };
  }
  let highWater = current.highWater;
  for (let index = schedule.rungs.length - 1; index >= 0; index -= 1) {
    const rung = schedule.rungs[index];
    if ((current.delivered[rung.milestone] ?? 0) > 0 && ratio < 0.85 * rung.threshold) {
      highWater = Math.min(highWater, index > 0 ? schedule.rungs[index - 1].threshold : 0);
    }
  }
  let selected: AdvisorySchedule["rungs"][number] | null;
  if (countOnDelivery) {
    // Only ever the highest rung the current pressure has reached, so a plateau does
    // not replay a descending cascade of stale milestones. A rung that has never been
    // DELIVERED stays armable even after the high-water mark has passed it: the old
    // ratchet locked out every rung that armed once and was cleared before it spoke.
    const reached = schedule.rungs.filter((rung) => ratio >= rung.threshold).at(-1) ?? null;
    const deliveries = reached ? current.delivered[reached.milestone] ?? 0 : 0;
    selected = reached && deliveries < reached.budget &&
      (highWater < reached.threshold || deliveries === 0)
      ? reached
      : null;
  } else {
    const crossed = schedule.rungs.filter((rung) =>
      highWater < rung.threshold && ratio >= rung.threshold &&
      (current.delivered[rung.milestone] ?? 0) < rung.budget);
    selected = crossed.at(-1) ?? null;
  }
  const delivered = { ...current.delivered };
  if (selected && !countOnDelivery) {
    delivered[selected.milestone] = (delivered[selected.milestone] ?? 0) + 1;
  }
  const armed = selected
    ? { milestone: selected.milestone, threshold: selected.threshold, scheduleKey }
    : current.armed;
  return {
    state: {
      ...currentState,
      advisory: {
        highWater: Math.min(1, Math.max(highWater, ratio)),
        delivered,
        ...(armed ? { armed } : {}),
      },
    },
    milestone: selected?.milestone ?? null,
  };
}

function curationText(milestone: AdvisoryMilestone, percent: number, toolName: string): string {
  if (milestone === "orientation") {
    return "Collapsed folds are a browsable index of the work behind you, and their briefs sit in the cached " +
      `prefix of the window, so paging that index costs almost nothing. Page it with ${toolName} ` +
      `{"action":"status"} and expand what the current task needs with ${toolName} ` +
      '{"action":"expand","id":"<fold-id>"}.';
  }
  if (milestone === "notice") {
    return `Context is ${percent}% full; curate it against the task you are on now. Fold the spans that task ` +
      `no longer needs with ${toolName} ` +
      '{"action":"fold","ids":["<start>","<end>"],"brief":"<factual brief>"}, and keep what must stay raw out ' +
      `of every fold with ${toolName} {"action":"protect","ids":["<entry-id>"]}.`;
  }
  if (milestone === "tools") {
    return "Completed read-only tool batches are the cheapest thing to fold, and their endpoint ids are in the " +
      "live advisory. Fold the batches whose detail this task is finished with; each one expands back to the " +
      `exact entries later with ${toolName} {"action":"expand","id":"<fold-id>"}.`;
  }
  return "Fold up: hand two or more adjacent folds of finished work to " +
    `${toolName} {"action":"fold","ids":["<fold-id>","<fold-id>"],"brief":"<factual brief>"} so they nest in ` +
    "one deeper fold, leaving the oldest material deepest and still exactly recoverable. A closed chapter " +
    `folds first, from the eligibleChapter endpoints in ${toolName} {"action":"status"}.`;
}

export function milestoneText(
  milestone: AdvisoryMilestone,
  sessionId: string,
  threshold: number,
  toolName: string,
  brandNoun = DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
  guidance: GuidanceProfile = DEFAULT_GUIDANCE_PROFILE,
): string {
  const percent = Math.round(threshold * 100);
  const prefix = `[${contextBrand(brandNoun)} milestone ${milestone}; session ${sessionId.slice(0, 16)}]`;
  if (guidance === "curation" && milestone !== "urgent") {
    return `${prefix} ${curationText(milestone, percent, toolName)}`;
  }
  if (milestone === "notice") {
    return `${prefix} Context pressure has crossed ${percent}%. Automatic folding is available. ` +
      `Inspect candidates exactly with ${toolName} {"action":"status"}.`;
  }
  if (milestone === "tools") {
    return `${prefix} The read-only tool-fold rung begins at ${percent}%. ` +
      "Eligible completed tool batches can be folded now; current endpoint ids are in the live advisory.";
  }
  if (milestone === "chapters") {
    return `${prefix} The chapter preparation rung begins at ${percent}%. ` +
      `Use eligibleChapter endpoints with ${toolName} ` +
      '{"action":"fold","ids":["<start>","<end>"],"brief":"<factual brief>"}.';
  }
  return `${prefix} The hard context fence is near. The next automatic action is a committed chapter fold ` +
    "or the provider request is aborted before transmission.";
}

/**
 * The surfacing carrier. It rides the same ephemeral tail channel as the live
 * advisory: appended after the stable prefix, never durable, never a mutation of
 * the projection, and cleared whenever the next context event is built.
 */
export function surfacingText(input: {
  suggestions: readonly SurfacingSuggestion[];
  brandNoun?: string;
}): string | null {
  if (!input.suggestions.length) return null;
  const brand = contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN);
  const lines = input.suggestions.map((suggestion, index) => [
    `${index + 1}. ${suggestion.id}${suggestion.depth ? ` (depth ${suggestion.depth})` : ""}: ${suggestion.text}`,
    ...(suggestion.alternateRoute ? [`   peek (ephemeral read): ${suggestion.alternateRoute}`] : []),
    `   expand (durable restore): ${suggestion.route}`,
  ].join("\n"));
  return boundReceiptText(
    [
      `[${brand} suggestions] ${input.suggestions.length} collapsed span(s) look relevant to the current ` +
        "task. Peek reads one back ephemerally at any depth; expand restores it in place, outermost first. " +
        "Ignoring them is a valid answer.",
      ...lines,
    ].join("\n"),
    2_048,
    `[${brand} suggestions] Relevant collapsed spans are unavailable this pass.`,
  );
}

export interface AdvisoryCuration {
  /** Room left before the truthful fence, in tokens. */
  headroomTokens: number | null;
  budgetTokens: number;
  pendingMarks: number;
  eligibleMarks: number;
  /** What the pending marks would free, in TOKENS. A percentage is not actionable. */
  freedTokens: number;
  eligibleFreedTokens: number;
  /** The share of what the request currently pays for that no pending decision reclaims. */
  unmarkedShare: number;
}

export function liveAdvisoryText(input: {
  milestone: AdvisoryMilestone;
  ratio: number;
  toolEndpoints: string[];
  chapterEndpoints: string[];
  remediationCount: number;
  brandNoun?: string;
  curation?: AdvisoryCuration | null;
}): string {
  const tools = input.toolEndpoints.length
    ? input.toolEndpoints.slice(0, 3).join(", ")
    : "none";
  const chapter = input.chapterEndpoints.length
    ? `${input.chapterEndpoints[0]}..${input.chapterEndpoints.at(-1)}`
    : "none";
  const curation = input.curation
    ? `headroom ${input.curation.headroomTokens ?? "unmeasured"} of ${input.curation.budgetTokens} tokens; ` +
      `unmarked share ${Math.round(input.curation.unmarkedShare * 100)}%; ` +
      `${input.curation.pendingMarks} pending mark(s), ${input.curation.eligibleMarks} eligible now, ` +
      `together freeing about ${input.curation.eligibleFreedTokens} tokens of the ` +
      `${input.curation.freedTokens} marked; `
    : "";
  // The continuation clause is the LAST sentence on purpose. The advisory rides the
  // ephemeral tail of the projection, so it is the final thing the model reads before
  // choosing its next action; without an explicit "carry on", a session at a natural
  // pause treats the capacity note as the thing to answer and ends its turn (measured:
  // two staged-chain runs stopped mid-assignment on the first day deliveries worked).
  return boundReceiptText(
    `[${contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN)} advisory] ` +
      `pressure ${Math.round(input.ratio * 100)}%; milestone ${input.milestone}; ${curation}` +
      `eligible read-only batch endpoints: ${tools}; eligibleChapter endpoints: ${chapter}; ` +
      `session milestone count: ${input.remediationCount}. ` +
      ADVISORY_CONTINUATION_CLAUSE,
    2_048,
    `[${contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN)} advisory] ` +
      `Live pressure details are unavailable. ${ADVISORY_CONTINUATION_CLAUSE}`,
  );
}
