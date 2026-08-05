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
} from "./policy.ts";
import { contextBrand, DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN } from "./policy.ts";

export { ADVISORY_BUDGETS };

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
  const { armed: _armed, ...advisory } = current;
  return { ...state, advisory };
}

export function advisorySchedule(
  snapshot: Pick<ActiveContextSnapshot, "policy" | "contextWindow">,
): AdvisorySchedule {
  const rungs = [
    { milestone: "notice" as const, threshold: 0.50, budget: ADVISORY_BUDGETS.notice },
    { milestone: "tools" as const, threshold: snapshot.policy.toolFoldRatio - 0.04,
      budget: ADVISORY_BUDGETS.tools },
    { milestone: "chapters" as const, threshold: snapshot.policy.prepareRatio - 0.05,
      budget: ADVISORY_BUDGETS.chapters },
    { milestone: "urgent" as const, threshold: hardFenceRatio(snapshot) - 0.03,
      budget: ADVISORY_BUDGETS.urgent },
  ];
  for (let index = rungs.length - 2; index >= 0; index -= 1) {
    rungs[index].threshold = Math.min(rungs[index].threshold, rungs[index + 1].threshold - 0.02);
  }
  for (const rung of rungs) rung.threshold = Math.max(0, Math.min(1, rung.threshold));
  return {
    key: sha256Value(rungs.map(({ milestone, threshold }) => ({ milestone, threshold }))),
    rungs,
  };
}

export function updateAdvisoryMilestone(
  currentState: ActiveContextState,
  ratio: number,
  schedule: AdvisorySchedule,
  scheduleChanged: boolean,
  scheduleKey: string,
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
  const crossed = schedule.rungs.filter((rung) =>
    highWater < rung.threshold && ratio >= rung.threshold &&
    (current.delivered[rung.milestone] ?? 0) < rung.budget);
  const selected = crossed.at(-1) ?? null;
  const delivered = { ...current.delivered };
  if (selected) delivered[selected.milestone] = (delivered[selected.milestone] ?? 0) + 1;
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

export function milestoneText(
  milestone: AdvisoryMilestone,
  sessionId: string,
  threshold: number,
  toolName: string,
  brandNoun = DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN,
): string {
  const percent = Math.round(threshold * 100);
  const prefix = `[${contextBrand(brandNoun)} milestone ${milestone}; session ${sessionId.slice(0, 16)}]`;
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

export function liveAdvisoryText(input: {
  milestone: AdvisoryMilestone;
  ratio: number;
  toolEndpoints: string[];
  chapterEndpoints: string[];
  remediationCount: number;
  brandNoun?: string;
}): string {
  const tools = input.toolEndpoints.length
    ? input.toolEndpoints.slice(0, 3).join(", ")
    : "none";
  const chapter = input.chapterEndpoints.length
    ? `${input.chapterEndpoints[0]}..${input.chapterEndpoints.at(-1)}`
    : "none";
  return boundReceiptText(
    `[${contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN)} advisory] ` +
      `pressure ${Math.round(input.ratio * 100)}%; milestone ${input.milestone}; ` +
      `eligible read-only batch endpoints: ${tools}; eligibleChapter endpoints: ${chapter}; ` +
      `session milestone count: ${input.remediationCount}.`,
    2_048,
    `[${contextBrand(input.brandNoun ?? DEFAULT_ACTIVE_CONTEXT_BRAND_NOUN)} advisory] ` +
      "Live pressure details are unavailable.",
  );
}
