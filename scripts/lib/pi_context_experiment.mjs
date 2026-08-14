// Fold-vs-compaction experiment contract.
//
// Derived from the soak lineage (scripts/lib/pi_context_soak_attestation.mjs): external
// pacing, one real Pi session per run, one user message, artifact-only adjudication.
// Every primitive that already exists there is IMPORTED, never re-implemented here; this
// module adds only what the experiment needs on top: arms, stage plans as data, mechanical
// probe ground truth, the reread-tax hash, and the blind-grading separation.
//
// Spec: wiki meta/memory/folds/pi_context_governor/fold-vs-compaction_experiment.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import {
  RUNTIME_HOME,
  assertSoak,
  exactKeys,
  sha256Json,
  sha256Text,
} from "./pi_context_soak_attestation.mjs";

// Version 3 (2026-08-09): audit traces. Chains over the delivery history (hop
// alphabet SOF/FIN/INC, forced cycle, no repeated nodes) woven into ordinary stage
// instructions as labelled steps, each consuming the previous step's recorded value.
// Version 2 (2026-08-09) added the recall-first conversation probes (stage-fact,
// stage-binding) with per-stage audit code words. Earlier-version plans and
// manifests are a different protocol and do not revalidate under this code.
export const EXPERIMENT_PROTOCOL_VERSION = 3;

// (a) pifold: active-context runtime ON, native auto-compaction OFF.
// (b) native: pi-fold OFF, Pi native auto-compaction ON.
// (c) unmanaged: both OFF; the run terminates at window overflow, which is the datum.
export const EXPERIMENT_ARMS = Object.freeze(["pifold", "native", "unmanaged", "nativefence"]);

// THE MATCHED-TRIGGER ARM. `native` cannot answer the question that decides whether
// lossless folding earns its place, because Pi's own threshold check runs only after
// agent_end and before prompt submission (dist/core/agent-session.js:1508) and this
// workload is ONE prompt wrapping 64 stages. Measured on sol-20260813-paired: rep 1's
// agent_end fired once, after all 64 stages, and the arm recorded zero compaction passes
// while its projection sat inside Pi's nominal band on 24 of 110 requests. A `native` arm
// therefore compacts once, at the end, or never: it is not a comparator, it is a control
// for having no context management at all.
//
// `nativefence` supplies the missing comparator. It runs with the fold runtime OFF and
// the harness invoking `ctx.compact()` at the same occupancy pi-fold's projection fence
// actually fires at, so both arms transition for the same reason and differ only in WHAT
// the transition does: preserve the bytes losslessly, or replace them with a summary.
//
// The share is EMPIRICAL and says so. pi-fold's fence margin is
// `max(floorShare * window, estimatorError * estimate + expectedInflow)`, whose dynamic
// terms depend on runtime state the harness cannot reproduce, so a bit-identical formula
// is not available. This is the median occupancy at which rep 1's seven fence commits
// actually fired: 0.894, 0.942, 0.953, 0.913, 0.937, 0.911, 0.953. Because a match cannot
// be asserted it is MEASURED: both arms record the occupancy of every crossing, and the
// adjudicator reports the realized distributions side by side, so a drift between the
// triggers is visible in the result rather than assumed away.
export const MATCHED_FENCE_OCCUPANCY_SHARE = 0.937;

// A SMOKE MUST CROSS ITS OWN FENCE OR IT VALIDATES NOTHING. The first matched-trigger
// smoke (sol-20260814-matched rep 2) sealed green on both arms and recorded zero fence
// crossings, because eight stages peak near 0.20 occupancy and the full share is 0.937:
// the arm was proven to launch and seal, and the mechanism it exists for was never run.
// The compaction that smoke did record came from Pi's own agent_end path, `fromExtension`
// false, which is the very trigger gate 66 showed cannot fire mid-run.
//
// This is the same shape `compactionTriggerShare` already uses for the same reason, and
// the bound is the same: the share must sit below what the mode's stages actually
// accumulate, or the fence is unreachable in that mode by construction.
//
// The smoke share is BOUNDED FROM BELOW as well, which the first two smokes were not.
// Crossing the fence is necessary and not sufficient: Pi keeps `keepRecentTokens` of
// recent material and summarizes only what lies before the cut, so a fence that fires
// under that line aborts the turn (which `compact` does first, unconditionally) and then
// refuses. 0.12 of the serving budget is 30,182 estimated tokens, which leaves roughly
// 10,000 on the far side of a 20,000-token cut, and the smoke's own floor mass is 48,000.
export const MATCHED_FENCE_SHARES = Object.freeze({ full: 0.937, smoke: 0.12 });

export function matchedFenceShare(mode) {
  assertExperiment(EXPERIMENT_MODES.includes(mode), `Unknown mode ${mode}`);
  return MATCHED_FENCE_SHARES[mode];
}
export const EXPERIMENT_MODES = Object.freeze(["smoke", "full"]);
// A closed-book session receives ONLY the probe questions: no transcript, no stage
// payloads, no tools, no checkout. It publishes the prior-knowledge floor per probe
// class for a plan (curl is heavily trained on), so "the model might just know this"
// becomes a measured number instead of an objection. One session per PLAN, not per arm.
export const EXPERIMENT_SESSION_TYPES = Object.freeze(["arm", "closed-book"]);
export const EXPERIMENT_CLOSED_BOOK_LABEL = "closed-book";
// Shipped pi-fold package options (gate 24); each variant is an experiment condition.
export const EXPERIMENT_GUIDANCE_PROFILES = Object.freeze(["pressure", "curation", "minimal"]);
// `foldScheduling` was the second condition dial: fold as soon as a batch is eligible,
// or batch the eligible spans into an epoch. Epoch won the pairing (rep 2 immediate
// 0.193 pooled against rep 3 epoch 0.919) and is the runtime's only scheduler now, so
// the dial is RETIRED and its vocabulary survives for reading sealed artifacts only:
// reps 1-23 recorded it and their run configs are immutable data. `foldPeekResults`,
// the third dial, is retired the same way and for the same reason: peek results are
// foldable unconditionally. Nothing emits either key any more.
export const EXPERIMENT_FOLD_SCHEDULING = Object.freeze(["immediate", "epoch"]);
// `guidedCuration` was the fourth condition dial: announce the pending epoch commit and
// give the agent a bounded last call to curate what is about to fold. It is RETIRED as of
// the append-only build and tolerated on read only, exactly like `reliabilityLevers`:
// reps 15-21 recorded it and their run configs are immutable data, so they must keep
// adjudicating. Nothing emits it any more. The announcement it named is gone because a
// warning has to arrive before the event it warns about, which means breaking a prefix
// nothing else was breaking; the commit trigger it gated survives and now fires silently.
// (This replaced the iteration-2 reliability-lever set, which pi-fold collapsed into
// unconditional defaults: those option keys no longer exist in the runtime.)
export const EXPERIMENT_DEFAULT_GUIDED_CURATION = false;
// A deployment FACT, not a condition dial: the provider's TOTAL admission window for the
// models whose wire has proven it serves past the per-request input descriptor. Rep 14
// (luna-20260805) recorded 14 provider-reported requests over the 272,000-token
// descriptor, peak 342,539, all served and billed. Rep 16 then aborted after running
// every curation threshold against the descriptor budget (255,616) because no deployment
// passed this fact into the registration; pi-fold's runtime falls back to descriptor
// mode when the fact is absent, which is the conservative default for an unlisted model.
// sol shares luna's deployment: identical descriptor split (272k input + 128k output
// = 400k total), same provider family, and rep 15 proved the 400k serving budget on
// the wire for that family. An entry here is the difference between measuring curation
// thresholds against the true budget and rep 16's descriptor-mode abort.
// Stated as the SERVING BUDGET, already net of the deployment's output reservation,
// because that is the shape the runtime now takes: `providerInputBudget` passes straight
// through as the one denominator instead of being netted down by a guessed reservation.
// 383,616 (400,000 total less the 16,384 the runtime used to withhold) is the number
// every run through luna-20260810 rep 2 measured against. Rep 2 then falsified it for
// the luna deployment on its own wire: the sealed ledger's largest served request is
// 361,882 tokens and the provider refused at approximately 377,800 real (375,830
// estimated, estimator bias 1.0056), so luna's serving ceiling lies in (361,882,
// 377,800] and a 383,616 budget builds requests the wire will not take.
//
// All of that measured the wrong wall (2026-08-11). What the wire will ACCEPT is not what
// the session can USE, because Pi meters the answer against the descriptor rather than
// against the wire: it derives `max_output_tokens` per request as
// `contextWindow - estimate - 4096` (see PI_OUTPUT_BUDGET). Both deployments declare a
// 272,000 window, so past roughly 252,000 tokens of occupancy the subtraction starts
// eating the reply, and past roughly 268,000 it collapses to the API's 16-token floor.
// Sol-20260811 rep 2 ran against 383,616, did exactly what it was told, and sent 40
// percent of its requests asking a reasoning model at xhigh effort to answer in sixteen
// tokens; those failed 23.2 percent of the time against 3.9 percent for the rest. The
// 342,539-token requests rep 14 recorded were served and billed, and were also, on this
// arithmetic, requests the model had almost no room to answer.
//
// So the binding constraint is the declared window, and it is the same one for both
// deployments: 272,000 less Pi's 4,096 reserve less a real output budget. The output
// budget is 16,384 because that is the figure rep 1 established empirically, having died
// on stopReason "length" at 4,096. That is 251,520, and it sits well under luna's
// separately measured wire refusal, which no longer binds. The reservation idea was right
// all along; it was being subtracted from the wire's capacity instead of from the window
// Pi actually meters against.
//
// Runs sealed against 383,616 and 343,616 stay readable, because validation requires only
// a positive budget; their token numbers carry the differing denominator as a stated
// caveat, and their high-occupancy requests carry the starved-output caveat besides.
// Keyed by PROVIDER and model together: capacity is a fact about a deployment, and the
// same model id behind a different provider is a different deployment with a different
// wire, so a bare model key would hand it this fact incorrectly.
export const EXPERIMENT_PROVIDER_INPUT_BUDGETS = Object.freeze({
  "openai-codex/gpt-5.6-luna": 251_520,
  "openai-codex/gpt-5.6-sol": 251_520,
});
// The campaign's brief generator. Fold briefs are MODEL-WRITTEN in the shipped package,
// and the deterministic brief exists only as the automatic fallback when a generator
// fails, so an arm that registered the runtime with no generator wired measured the
// fallback in every fold and called it the mechanism. This descriptor is what the pifold
// arm registers, and it travels config -> manifest -> registration -> evidence so the
// brief regime of a sealed run is a readable fact rather than an inference from silence.
// A cheap model at medium effort: the brief is a bounded summary of a bounded span, and
// the frontier model's turn is the thing under measurement, not the summarizing.
// gpt-5.6-luna wrote this until 2026-08-11, when it went to 38 percent availability for
// this account for hours and took rep 4 with it while every other model on the same
// account answered. terra is the same generation, answers 4 of 4, and bills less per
// brief. The choice deliberately is not the session's own model: the descriptor exists
// because briefing with the arm's frontier model would bill the comparison for its own
// summarizing and confound the thing under measurement.
export const EXPERIMENT_BRIEF_GENERATOR = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-terra",
  effort: "medium",
});
// How much provider weather one run is allowed to survive. Pi retries a retryable
// assistant error by re-sending the same request after a backoff, having removed the
// failed attempt from agent state, so a retry costs zero tokens and changes nothing the
// trial measures. The budget therefore buys survival and nothing else, and Pi's default
// of 3 is too thin for a marathon: rep 4 of luna-20260810 spent all three on a single
// Codex overload sequence and lived with no margin left. Eight is the pin because the
// budget buys survival and eight attempts survived every weather this campaign has seen.
//
// The BASE is 1,000 rather than 2,000 because Pi computes the wait as
// `baseDelayMs * 2 ** (attempt - 1)` (agent-session.js) with no cap, so the base sets the
// whole schedule and the deep end grows fast either way. Rep 2 of sol-20260811 measured
// what the old base cost: 16 errored responses, each recovering after about 100 seconds,
// which is five retries of pure sleep (62s) plus a ~35s successful answer. That is 16.5
// minutes of a 303-minute run spent waiting rather than working, in a run that ended two
// stages short on its own deadline. Halving the base halves the sleep on the common case
// (31s for five attempts) while keeping all eight attempts and still reaching 64s deep in
// the schedule for a provider that is genuinely down; a fully spent budget now costs about
// four and a quarter minutes rather than eight and a half.
// Pinned rather than left ambient: retry settings otherwise come from whatever the
// machine's settings files happen to say, which is not a property a sealed run can state.
export const EXPERIMENT_PROVIDER_RETRY = Object.freeze({
  enabled: true,
  maxRetries: 8,
  baseDelayMs: 1_000,
});

// Pi derives the output budget per request rather than sending the model's own maximum:
// pi-ai `api/simple-options.js` computes `contextWindow - estimateContextTokens - 4096`,
// floors it at 1, takes the min against the caller's ceiling, and `api/openai-responses.js`
// then raises the result to the API's own minimum of 16 before sending it as
// `max_output_tokens`. `utils/estimate.js` does the estimate at four chars per token.
//
// The consequence is the defect that ruined rep 2 of sol-20260811. That descriptor declares
// `contextWindow: 272000`, which is a PRICING tier boundary, not capacity: its own cost
// table reads `inputTokensAbove: 272000`, and the provider was separately measured
// accepting 339,689. The run's serving budget was set from the measured capacity, so
// occupancy ran to 307k and beyond, the subtraction went negative, and 56 of 141 requests,
// 40 percent, went out asking a reasoning model at xhigh effort to answer in sixteen
// tokens. Those requests failed 23.2 percent of the time against 3.9 percent for requests
// that got the whole budget, and the failures were recorded as the bare word "error".
//
// So the arithmetic is reproduced here, and a run whose own thresholds drive it into the
// starved zone says so at the first request rather than at the seal.
export const PI_OUTPUT_BUDGET = Object.freeze({
  /** pi-ai `utils/estimate.js` CHARS_PER_TOKEN. */
  charsPerToken: 4,
  /** pi-ai `api/simple-options.js` CONTEXT_SAFETY_TOKENS. */
  safetyTokens: 4_096,
  /** pi-ai `api/openai-responses.js` OPENAI_RESPONSES_MIN_OUTPUT_TOKENS. */
  apiFloorTokens: 16,
  /**
   * Below this the session cannot write a staged deliverable, so a managed arm that reaches
   * it is misconfigured rather than unlucky. Rep 2's starved requests sat at the 16-token
   * floor, three orders of magnitude under this.
   */
  latchBelowTokens: 4_096,
});

/**
 * The `max_output_tokens` Pi will send for a request carrying `contextChars`, given the
 * model's declared window and output maximum. Mirrors the vendor arithmetic named above;
 * harness gate 52 reads Pi's source and fails when that arithmetic moves.
 */
/**
 * WHERE PI DECIDES TO SHED CONTEXT, and why the run has to choose it rather than take
 * Pi's default.
 *
 * `shouldCompact` fires when `contextTokens > contextWindow - reserveTokens` against the
 * DESCRIPTOR window. On gpt-5.6-sol that descriptor reads 272,000 and the default reserve
 * is 16,384, so Pi's trigger sits at 255,616 while the run's own serving budget is
 * 251,520: the projection fence is 4,096 tokens BELOW the trigger and always reaches the
 * window first. A managed arm on that ordering never sees the hook at all. sol-20260812
 * rep 9 is the measurement: its pifold arm ran six hours, peaked at 229,661 tokens, and
 * recorded ZERO compaction passes, while the native arm recorded four.
 *
 * That ordering was harmless while the fold runtime carried its own occupancy trigger and
 * cancelled every compaction it saw. It is fatal to a runtime whose only ordinary
 * mutation point IS the compaction boundary: the boundary never fires, and every commit
 * falls to the emergency fence, which is a different system from the one under test.
 *
 * So the reserve is DERIVED, and it puts Pi's trigger at the occupancy the retired
 * thermostat used to commit at. Both arms get it, which is what makes the pairing a
 * pairing: the same moment of "this session must shed context", and two answers to it.
 */
export function compactionReserveTokens({ descriptorWindow, servingBudgetTokens, share }) {
  assertExperiment(Number.isSafeInteger(descriptorWindow) && descriptorWindow > 0,
    "The descriptor window is required to place the compaction trigger");
  assertExperiment(Number.isSafeInteger(servingBudgetTokens) && servingBudgetTokens > 0,
    "The serving budget is required to place the compaction trigger");
  assertExperiment(typeof share === "number" && share > 0 && share < 1,
    "The compaction trigger share must sit strictly inside the serving budget");
  const triggerTokens = Math.floor(share * servingBudgetTokens);
  const reserveTokens = descriptorWindow - triggerTokens;
  const headroomTokens = servingBudgetTokens - triggerTokens;
  // THE HEADROOM IS THE PROPERTY, not the mere ordering: `share` is already below one, so
  // a trigger under the budget is arithmetic rather than a check. What can actually go
  // wrong is a trigger so close to the budget that the fence sits inside the gap and
  // reaches the window first anyway. The fence keeps a margin of
  // PROJECTION_FENCE_MARGIN_SHARE of the serving budget, so the trigger has to clear it.
  assertExperiment(headroomTokens >= PROJECTION_FENCE_MARGIN_SHARE * servingBudgetTokens,
    `The compaction trigger at ${triggerTokens} tokens leaves ${headroomTokens} tokens ` +
    `under the ${servingBudgetTokens}-token serving budget, inside the fence margin, so ` +
    "the fence still reaches the window before the boundary does");
  assertExperiment(reserveTokens > 0,
    `The descriptor window ${descriptorWindow} is under the ${triggerTokens}-token trigger`);
  return {
    reserveTokens,
    triggerTokens,
    headroomTokens,
    // What Pi's own default would have done, recorded because it is the misconfiguration
    // this function exists to correct and a reader should not have to rederive it.
    defaultTriggerTokens: descriptorWindow - PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
    defaultTriggerClearsTheBudget:
      descriptorWindow - PI_DEFAULT_COMPACTION_RESERVE_TOKENS < servingBudgetTokens,
  };
}

/** Pi `core/compaction/compaction.js` DEFAULT_COMPACTION_SETTINGS.reserveTokens. */
export const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
/** The share of the serving budget the projection fence keeps clear; gate 58 pins it. */
export const PROJECTION_FENCE_MARGIN_SHARE = 0.05;
/**
 * The trigger share for a mode, which is a MODE PLAN field because a smoke run cannot
 * reach the full run's line: see the smoke plan for the arithmetic. Every plan must state
 * one, so a mode added later cannot inherit a share that its own mass never crosses.
 */
export function compactionTriggerShare(mode) {
  const plan = EXPERIMENT_MODE_PLANS[mode];
  assertExperiment(plan, `Unknown experiment mode ${mode}`);
  assertExperiment(typeof plan.compactionTriggerShare === "number",
    `Experiment mode ${mode} states no compaction trigger share`);
  return plan.compactionTriggerShare;
}

export function servedOutputBudget({ contextWindow, contextChars, modelMaxTokens }) {
  const estimate = Math.ceil(contextChars / PI_OUTPUT_BUDGET.charsPerToken);
  const available = contextWindow - estimate - PI_OUTPUT_BUDGET.safetyTokens;
  const clamped = Math.min(modelMaxTokens, Math.max(1, available));
  return Math.max(clamped, PI_OUTPUT_BUDGET.apiFloorTokens);
}

// The package's own summarizer contract, revalidated on this side of the wire: the
// runtime accepts "session" or a provider/model/effort descriptor, and the harness only
// ever pins a descriptor, because "session" would brief with the arm's own frontier model
// and bill the comparison for it.
export function validBriefGenerator(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    exactKeys(value, ["provider", "model", "effort"]) &&
    [value.provider, value.model, value.effort].every((part) =>
      typeof part === "string" && part.length > 0);
}

// Pi's default "auto" transport rides a WebSocket whose follow-ups are DELTA requests
// against connection-scoped server state; every drop re-sends the full context, usually
// onto a cold backend. Rep 17 measured the bill: raw pooled cache share 0.390 against a
// mechanism-limited 0.864. Every run is pinned to SSE so both arms pay the same,
// prefix-cache-routed transport and the comparison is deterministic.
export const EXPERIMENT_TRANSPORT = "sse";
export const EXPERIMENT_TRANSPORTS = Object.freeze(["sse", "websocket", "auto"]);
// The epoch scheduler's implementation, pinned the moment it exists in the runtime and
// REQUIRED once a run asks for epoch scheduling.
export const EXPERIMENT_SCHEDULING_SOURCE = "extensions/lib/scheduling.ts";

// Constants, not knobs: the supervisor recomputes the required root and refuses a run
// directory outside it, and an override set in the launching shell is not in the
// systemd-run --setenv list, so a configurable root would have the supervisor reject the
// very run it was just handed. Relocating run state is a one-line edit and a commit.
export const EXPERIMENT_RUN_ROOT = join(RUNTIME_HOME, "pi-fold-runs");
export const EXPERIMENT_STATE_ROOT = join(EXPERIMENT_RUN_ROOT, "state", "ops", "pi-context-experiment");
// The exact environment a run attests, named ONCE. The supervisor builds this object and
// the run-config validator checks it; when the two each carried their own copy of the list
// they drifted, and the drift only surfaced when a launched run died at validation. The
// pi-subagents pins left with the deployment that used to load them: this harness registers
// the runtime itself and never imports that package, so pinning it attested a dependency no
// run actually had.
export const EXPERIMENT_DEPENDENCY_KEYS = Object.freeze([
  "piPackageJson", "piDistTree", "piNodeModulesTree", "nodeExecutable",
]);

export const EXPERIMENT_TOOL_NAME = "repo_stage";
export const EXPERIMENT_MARKER_ENTRY = "pi-fold-context-experiment-marker-v1";
export const EXPERIMENT_RUNNER_MODE = "systemd-supervised-single-session";
export const EXPERIMENT_BEHAVIORAL_MODE = "staged-repo-comprehension-marathon";
export const EXPERIMENT_TERMINAL_STABILIZATION_MS = 2 * 60 * 1_000;

// The model may read the pinned checkout freely: rereading after a stop-the-world event is
// the behaviour under measurement, so removing the read tool would destroy the metric.
export const EXPERIMENT_ALLOWED_TOOLS = Object.freeze(["read", EXPERIMENT_TOOL_NAME]);
export const EXPERIMENT_PIFOLD_EXTRA_TOOLS = Object.freeze(["pi_fold_context"]);

// Pacing exists to keep stage RELEASE external (soak integrity), not to burn wall-clock:
// wall-clock is a measured variable here, so the gate is a floor, not a stretcher.
export const EXPERIMENT_MODE_PLANS = Object.freeze({
  // 58 payload stages x ~48k chars is ~2.8M chars, roughly 700k estimated tokens of fresh
  // read-only material through a 272k window: enough for the native arm to cross three
  // compactions, which is the spec's pressure requirement.
  full: Object.freeze({
    stageCount: 64,
    stageIntervalMs: 15_000,
    // Six hours, raised from five (2026-08-11). The watchdog is a liveness bound on a hung
    // run, not a budget a healthy one should be racing: rep 2 of sol-20260811 ran 303
    // minutes and was cut two stages short of its 64, having spent about 31 minutes
    // recovering from errors and 16.5 more asleep in retry backoff. Both of those causes
    // are fixed in this build, but the margin they consumed was never really there. A
    // healthy run finishing an hour early costs nothing; one cut short at stage 62 costs
    // the whole repetition.
    watchdogMs: 360 * 60 * 1_000,
    heartbeatMs: 30_000,
    payloadTargetChars: 48_000,
    payloadFloorChars: 24_000,
    probeStages: Object.freeze([16, 32, 48, 64]),
    // One kind list PER WAVE (probeKinds[i] belongs to probeStages[i]), six fixed
    // slots. Chain-link probes target audit-trace values (derived class); wave 16
    // takes a third chain-link because no earlier wave exists to echo; wave 64
    // trades stage-binding for the one derivation control (same hop, anchor
    // supplied, nothing to recall). One stage-fact code word per wave stays as
    // the declared hoarding ceiling, and the one repo-class control keeps
    // continuity with iterations 1-5. Scored separately by class: a combined
    // total would let the re-derivable answers mask the ones that matter.
    probeKinds: Object.freeze([
      Object.freeze(["chain-link", "chain-link", "chain-link", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["chain-link", "chain-link", "echo", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["chain-link", "chain-link", "echo", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["chain-link", "chain-link", "echo", "stage-fact", "derivation-control", "repo"]),
    ]),
    deliverableEvery: 8,
    revisitEvery: 3,
    // Audit traces: 4 chains x 6 links, anchored progressively deeper into the run.
    // The early law guarantees wave 16 has aged links to probe; measured headroom on
    // the pinned curl corpus is 3-7 links at stage <= 8 across 12 seeds.
    chainLength: 6,
    chainStartAfters: Object.freeze([1, 8, 16, 24]),
    chainEarlyLaw: Object.freeze({ maxStage: 8, minLinks: 3 }),
    // Where the retired thermostat committed. See compactionReserveTokens.
    compactionTriggerShare: 0.80,
  }),
  smoke: Object.freeze({
    stageCount: 8,
    stageIntervalMs: 5_000,
    watchdogMs: 45 * 60 * 1_000,
    heartbeatMs: 5_000,
    // FULL-SIZED PAYLOADS, raised from 12,000/6,000 (2026-08-13). Pi refuses to compact a
    // session that fits inside its own recent-keep window: `prepareCompaction` cuts at
    // `keepRecentTokens` (20,000 by default) and returns undefined when nothing older than
    // the cut remains to summarize. Eight stages of a 6,000-char floor is 12,000 estimated
    // tokens, BELOW that floor, so the old smoke could not produce a compactable session at
    // any threshold: the matched fence fired at 12,737 tokens in rep 3 and the compaction
    // came straight back "Nothing to compact (session too small)". A smoke that cannot
    // reach the state it is smoking is not a smoke. At the floor these eight stages now
    // accumulate 48,000 estimated tokens, which clears the cut with material left on the
    // far side of it.
    payloadTargetChars: 48_000,
    payloadFloorChars: 24_000,
    // Deliverable cadence must not collide with the probe stages, or a mode plan silently
    // produces zero deliverables and the blind grading leg has nothing to grade.
    probeStages: Object.freeze([4, 8]),
    // Smoke has only three carrier stages under the <= ceil(ordinal/2) eligibility rule
    // (1 and 2 by wave one, 3 by wave two), so each wave carries ONE conversation kind;
    // both kinds still get exercised across the run, as do chain-link and echo,
    // so a broken builder or grader path cannot first appear in a 5-hour run.
    probeKinds: Object.freeze([
      Object.freeze(["chain-link", "stage-fact", "repo"]),
      Object.freeze(["chain-link", "echo", "stage-binding", "repo"]),
    ]),
    deliverableEvery: 3,
    revisitEvery: 2,
    // One chain of 3 links exercises every hop evaluator, the step renderer, and the
    // chain laws inside an 8-stage run: a broken chain must not first appear in a
    // 5-hour full run. Roughly half of seeds are unconstructible on the real corpus
    // (few delivered files to hop between), which the stager absorbs by redrawing
    // its seed; an explicitly pinned seed still refuses rather than shortening.
    chainLength: 3,
    chainStartAfters: Object.freeze([1]),
    chainEarlyLaw: Object.freeze({ maxStage: 2, minLinks: 1 }),
    // REACHABLE WITHIN THE SMOKE'S OWN MASS, which is the only reason the share is a mode
    // plan field rather than one constant: the full mode's 0.80 line sits further out than
    // eight stages can ever reach, and a smoke on that share crosses no boundary, folds
    // nothing, and reports a healthy managed arm that never exercised the one path it
    // exists to exercise. The bound is the run's own accumulated payload at the FLOOR, not
    // at the target, because a smoke that draws small stages must still cross.
    //
    // Raised from 0.03 with the payload floor (2026-08-13). Eight stages of a 24,000-char
    // floor is 48,000 estimated tokens, so 0.10 puts the trigger at 25,152, crossed around
    // the third stage at the floor and the second at the 48,000-char target. It also keeps
    // the ORDERING the full mode has, folding trigger below matched fence (0.80 below
    // 0.937 there, 0.10 below 0.12 here): a smoke that folded only after native would have
    // compacted would exercise the two mechanisms in the wrong order. The numbers differ
    // from a full rep; the PATH is identical, and the path is what a smoke is for.
    compactionTriggerShare: 0.10,
  }),
});

// Named, not hidden: token mass per tool result is an ESTIMATE. Byte mass in the same
// report is exact. Provider-attributed usage never comes from this function.
export const TOKEN_ESTIMATOR_ID = "utf8-bytes-div-4-ceil";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;

export function assertExperiment(condition, message) {
  assertSoak(condition, message);
}

// Every required key present, no key outside required ∪ optional. Used where a condition
// dial was added after runs were already sealed: those artifacts are still exactly shaped,
// they simply predate the dial, and refusing to adjudicate them would destroy evidence.
export function keysWithin(value, required, optional) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = new Set(Object.keys(value));
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => present.has(key)) &&
    [...present].every((key) => allowed.has(key));
}

// ---------------------------------------------------------------------------
// Pinned public OSS corpora. Permissive licence, well known, mid-size, and big
// enough that read-only stage payloads keep the tool-fold cadence eligible.
// Stats measured 2026-08-05 from the pinned commit (non-test source only).
// ---------------------------------------------------------------------------
export const EXPERIMENT_REPOS = Object.freeze({
  curl: Object.freeze({
    key: "curl",
    url: "https://github.com/curl/curl.git",
    commit: "133785b15936d9417fdc41f77b87304b6bf458d5",
    license: "curl (MIT/X derivative)",
    language: "c",
    sourceGlobExtensions: Object.freeze([".c", ".h"]),
    sourceRoots: Object.freeze(["lib", "src"]),
    excludePathParts: Object.freeze([]),
    stats: Object.freeze({ sourceFiles: 474, sourceLines: 199_634, sourceChars: 6_195_580 }),
  }),
  django: Object.freeze({
    key: "django",
    url: "https://github.com/django/django.git",
    commit: "30ebe0001c1d10bebc68567f796d821f7b309f4d",
    license: "BSD-3-Clause",
    language: "python",
    sourceGlobExtensions: Object.freeze([".py"]),
    sourceRoots: Object.freeze(["django"]),
    excludePathParts: Object.freeze([]),
    stats: Object.freeze({ sourceFiles: 908, sourceLines: 165_501, sourceChars: 5_920_377 }),
  }),
  ripgrep: Object.freeze({
    key: "ripgrep",
    url: "https://github.com/BurntSushi/ripgrep.git",
    commit: "3fce3b5bb0236da2df6d99672afb8a719642eca7",
    license: "MIT OR Unlicense",
    language: "rust",
    sourceGlobExtensions: Object.freeze([".rs"]),
    sourceRoots: Object.freeze(["crates"]),
    excludePathParts: Object.freeze(["tests"]),
    stats: Object.freeze({ sourceFiles: 90, sourceLines: 49_690, sourceChars: 1_684_756 }),
  }),
  gin: Object.freeze({
    key: "gin",
    url: "https://github.com/gin-gonic/gin.git",
    commit: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    license: "MIT",
    language: "go",
    sourceGlobExtensions: Object.freeze([".go"]),
    sourceRoots: Object.freeze(["."]),
    excludePathParts: Object.freeze(["_test.go"]),
    stats: Object.freeze({ sourceFiles: 59, sourceLines: 8_196, sourceChars: 240_000 }),
  }),
  flask: Object.freeze({
    key: "flask",
    url: "https://github.com/pallets/flask.git",
    commit: "6a2f545bfd8ed31e19066a299296917e034aca58",
    license: "BSD-3-Clause",
    language: "python",
    sourceGlobExtensions: Object.freeze([".py"]),
    sourceRoots: Object.freeze(["src"]),
    excludePathParts: Object.freeze(["tests"]),
    stats: Object.freeze({ sourceFiles: 24, sourceLines: 9_502, sourceChars: 330_000 }),
  }),
});

// curl is the default. It is the only registered candidate whose corpus (474 files,
// 199,634 lines, 6.2M chars in lib/ + src/) carries enough fresh read-only material to push
// the native arm through THREE compactions in one run while still leaving headroom, and its
// lib/ internals are densely cross-referential, so revisit stages are real work rather than
// synthetic. django is the like-sized alternate; ripgrep is the short-corpus fallback whose
// 1.68M chars fit a single window pass and are useful for mechanism debugging, not pressure.
export const EXPERIMENT_DEFAULT_REPO = "curl";

// ---------------------------------------------------------------------------
// Deterministic seeded ordering. Stage plans are DATA and must be byte-reproducible
// from (repo commit, mode, seed) alone.
// ---------------------------------------------------------------------------
export function seededSequence(seed, count) {
  assertExperiment(typeof seed === "string" && seed.length > 0, "Seeded sequence requires a seed");
  assertExperiment(Number.isSafeInteger(count) && count >= 0, "Seeded sequence requires a count");
  const values = [];
  let digest = createHash("sha256").update(seed, "utf8").digest();
  let offset = 0;
  while (values.length < count) {
    if (offset + 4 > digest.length) {
      digest = createHash("sha256").update(digest).digest();
      offset = 0;
    }
    values.push(digest.readUInt32BE(offset));
    offset += 4;
  }
  return values;
}

export function seededShuffle(items, seed) {
  const ordered = [...items];
  const draws = seededSequence(seed, Math.max(ordered.length - 1, 0));
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = draws[ordered.length - 1 - index] % (index + 1);
    [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Mechanical ground truth. Every probe answer is EXTRACTED from the pinned file at
// staging time; no answer is ever authored by hand or by a model.
// ---------------------------------------------------------------------------
const DEFINITION_PATTERNS = Object.freeze([
  { kind: "fn", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  // The tail matters: `struct X {` / `struct X;` / `struct X<T>(` open a DEFINITION,
  // while `struct X *arg,` inside a C parameter list is a USE. The first smoke probed
  // cram.c line 50 (`struct Curl_creds *creds,`) as "defined on line 50" and every
  // arm reasonably answered the enclosing function instead.
  { kind: "struct", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|;|\(|$)/ },
  { kind: "enum", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|;|$)/ },
  { kind: "trait", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|:|$)/ },
  { kind: "func", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "type", pattern: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "def", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
]);

export function extractDefinitions(text) {
  assertExperiment(typeof text === "string", "Definition extraction requires file text");
  const definitions = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length > 400) continue;
    for (const { kind, pattern } of DEFINITION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      definitions.push({ line: index + 1, identifier: match[1], kind });
      break;
    }
  }
  return definitions;
}

export function fileFacts(repoRoot, absolutePath) {
  const text = readFileSync(absolutePath, "utf8");
  const path = relative(repoRoot, absolutePath);
  assertExperiment(path && !path.startsWith(".."), `File escapes the pinned repo root: ${absolutePath}`);
  return {
    path,
    sha256: sha256Text(text),
    // wc -l semantics: the count of newline characters. split("\n").length reads one
    // high on newline-terminated files and gave one probe a defensible second answer.
    lines: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    definitions: extractDefinitions(text),
    text,
  };
}

// Repo-class control probes, extracted mechanically from the pinned bytes. These are
// re-derivable by rereading the checkout, which is exactly why they are only the
// CONTROL now: conversation-class probes (below) are the discriminating instrument.
// file-line-count is retired: its truth semantics were ambiguous, it was noise, and
// it invited extra file reads that moved the token comparison.
export function buildProbes({ facts, seed, count, uniqueIdentifiers, rotationOffset = 0 }) {
  assertExperiment(Array.isArray(facts) && facts.length > 0, "Probe construction requires staged files");
  assertExperiment(Number.isSafeInteger(count) && count > 0, "Probe construction requires a count");
  const probes = [];
  const ordered = seededShuffle(facts.map((fact) => fact.path), `${seed}:probe-files`);
  const draws = seededSequence(`${seed}:probe-draws`, count * 4);
  let drawIndex = 0;
  for (let index = 0; probes.length < count && index < ordered.length * 3; index += 1) {
    const fact = facts.find((candidate) => candidate.path === ordered[index % ordered.length]);
    if (!fact) continue;
    const rotation = (probes.length + rotationOffset) % 2;
    if (rotation === 0 && fact.definitions.length > 0) {
      const definition = fact.definitions[draws[drawIndex++] % fact.definitions.length];
      probes.push({
        id: `probe-${String(probes.length + 1).padStart(2, "0")}`,
        kind: "definition-line",
        question: `In the file ${fact.path}, which identifier is defined on line ${definition.line}? Answer with the identifier only.`,
        expectedAnswer: definition.identifier,
        sourcePath: fact.path,
        sourceLine: definition.line,
      });
      continue;
    }
    const unique = fact.definitions.find((definition) =>
      uniqueIdentifiers.get(definition.identifier) === fact.path);
    if (!unique) continue;
    probes.push({
      id: `probe-${String(probes.length + 1).padStart(2, "0")}`,
      kind: "symbol-file",
      question: `Which repository-relative file defines ${unique.identifier}? Answer with the path only.`,
      expectedAnswer: fact.path,
      sourcePath: fact.path,
      sourceLine: unique.line,
    });
  }
  assertExperiment(probes.length === count,
    `Pinned corpus yielded ${probes.length} mechanical probes, needed ${count}`);
  return probes;
}

export function uniqueIdentifierIndex(facts) {
  const seen = new Map();
  const ambiguous = new Set();
  for (const fact of facts) {
    for (const definition of fact.definitions) {
      if (seen.has(definition.identifier) && seen.get(definition.identifier) !== fact.path) {
        ambiguous.add(definition.identifier);
      } else {
        seen.set(definition.identifier, fact.path);
      }
    }
  }
  for (const identifier of ambiguous) seen.delete(identifier);
  return seen;
}

// ---------------------------------------------------------------------------
// Conversation-class probes. The answer exists ONLY in the earlier conversation:
// a code word delivered once inside a stage instruction, or the stage-to-file
// binding the seeded shuffle created. Ground truth is derivable at staging time
// (the harness authored it), and rereading the checkout cannot recover it.
// ---------------------------------------------------------------------------
export const CONVERSATION_PROBE_KINDS = Object.freeze(["stage-fact", "stage-binding"]);
export const REPO_PROBE_KINDS = Object.freeze(["definition-line", "symbol-file"]);
// Derived-class probes target audit-trace values: facts the agent COMPUTED earlier
// rather than received, so recall and re-derivation separate cleanly in grading.
export const DERIVED_PROBE_KINDS = Object.freeze(["chain-link", "derivation-control"]);

export function probeClassOf(kind) {
  if (CONVERSATION_PROBE_KINDS.includes(kind)) return "conversation";
  if (DERIVED_PROBE_KINDS.includes(kind)) return "derived";
  if (kind === "echo") return "echo";
  return "repository";
}
export const CODE_WORD_PATTERN = /^cw-[0-9a-f]{6}$/;

export function stageCodeWords(seed, stageCount) {
  const draws = seededSequence(`${seed}:code-words`, stageCount);
  const words = draws.map((value) => `cw-${value.toString(16).padStart(8, "0").slice(0, 6)}`);
  assertExperiment(new Set(words).size === words.length,
    "Stage code words collided; stage the campaign with a different seed");
  return words;
}

export function codeWordSentence(ordinal, codeWord) {
  return `Audit note: the code word for stage ${String(ordinal).padStart(2, "0")} is ${codeWord}.`;
}

// One carrier stage per probe, never reused across the whole plan: a probed span,
// once peeked or answered, is refreshed at the tail, and a second probe against it
// would measure that refresh instead of recall.
export function buildConversationProbes({
  stages, probeOrdinal, seed, kinds, usedStages, excludedBindingStages = new Set(),
}) {
  assertExperiment(Array.isArray(stages) && Number.isSafeInteger(probeOrdinal),
    "Conversation probes require the stages built so far");
  assertExperiment(Array.isArray(kinds) && kinds.every((kind) => CONVERSATION_PROBE_KINDS.includes(kind)),
    "Conversation probe kinds must be stage-fact or stage-binding");
  const eligible = stages.filter((stage) => stage.kind !== "probe" &&
    stage.ordinal <= Math.ceil(probeOrdinal / 2) && !usedStages.has(stage.ordinal));
  assertExperiment(eligible.length >= kinds.length,
    `Probe stage ${probeOrdinal} has ${eligible.length} unused carrier stages, needs ${kinds.length}`);
  const order = seededShuffle(eligible.map((stage) => stage.ordinal), `${seed}:carriers`);
  const probes = [];
  for (const kind of kinds) {
    // A stage-binding answer is the carrier's FIRST file, which a chain stage
    // node would also expose through its FIN link, so those stages never carry
    // a binding probe. Code words collide with nothing.
    const ordinal = order.find((candidate) => !usedStages.has(candidate) &&
      (kind !== "stage-binding" || !excludedBindingStages.has(candidate)));
    assertExperiment(ordinal !== undefined,
      `Probe stage ${probeOrdinal} has no legal carrier for ${kind}`);
    const carrier = stages.find((stage) => stage.ordinal === ordinal);
    usedStages.add(ordinal);
    const label = String(ordinal).padStart(2, "0");
    if (kind === "stage-fact") {
      assertExperiment(typeof carrier.codeWord === "string" && CODE_WORD_PATTERN.test(carrier.codeWord),
        `Carrier stage ${ordinal} has no code word`);
      probes.push({
        id: "",
        kind,
        question: `What was the audit code word given in stage ${label}'s instructions? ` +
          "Answer with the code word only.",
        expectedAnswer: carrier.codeWord,
        sourceStage: ordinal,
      });
    } else {
      assertExperiment(carrier.files.length > 0, `Carrier stage ${ordinal} delivered no files`);
      probes.push({
        id: "",
        kind,
        question: `Which repository-relative file was the FIRST file delivered in stage ${label}? ` +
          "Answer with the path only.",
        expectedAnswer: carrier.files[0].path,
        sourceStage: ordinal,
      });
    }
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Audit traces: chains over the DELIVERY HISTORY, woven into ordinary stage
// instructions as labelled steps. Each step consumes the value the previous step
// recorded, so the trace is live task state, not an audit artifact. The hop
// alphabet is frozen: SOF and FIN answers exist only in the transcript (the
// seeded stage-to-file shuffle is harness-owned and absent from disk); INC has a
// legal disk path costing one file read, GIVEN the predecessor. The cycle
// SOF -> FIN -> INC is forced from an SOF anchor step, so 2 of 3 links are
// unre-derivable at any price and 1 of 3 prices the internal cost gradient.
// ---------------------------------------------------------------------------
export const AUDIT_TRACE_IDS = Object.freeze(["trace-a", "trace-b", "trace-c", "trace-d"]);
export const AUDIT_HOP_CYCLE = Object.freeze(["SOF", "FIN", "INC"]);
export const AUDIT_INCLUDE_MAX_INDEX = 8;
// The declared counting rule, exactly as the step text states it: every line whose
// first non-space characters are #include (whitespace after # allowed) followed by
// a double-quoted path, in file order, including lines inside #if blocks. curl's
// lib/ + src/ carry 95 spaced "#  include" lines, so the whitespace allowance is
// required by the corpus, not a stylistic choice.
const AUDIT_INCLUDE_PATTERN = /^\s*#\s*include[ \t]+"([^"]+)"/;

export function quotedIncludeSpecs(text) {
  const specs = [];
  for (const line of text.split("\n")) {
    const match = AUDIT_INCLUDE_PATTERN.exec(line);
    if (match) specs.push(match[1]);
  }
  return specs;
}

// Resolution rule, declared in the step text: dir-relative against the including
// file first, otherwise the unique file with that basename, otherwise refused
// (null). The index spans the WHOLE checkout, because that is the universe the
// agent resolves against when it opens the file.
export function buildIncludeResolver(paths) {
  const all = new Set(paths);
  const byBase = new Map();
  for (const path of all) {
    const base = path.split("/").pop();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(path);
  }
  return (fromPath, spec) => {
    const direct = normalize(join(dirname(fromPath), spec)).replaceAll("\\", "/");
    if (all.has(direct)) return direct;
    const hits = byBase.get(spec.split("/").pop()) ?? [];
    return hits.length === 1 ? hits[0] : null;
  };
}

export function auditDelivery(stages) {
  const stageOfPath = new Map();
  const filesOfStage = new Map();
  for (const stage of stages) {
    const paths = stage.files.map((file) => file.path);
    filesOfStage.set(stage.ordinal, paths);
    for (const path of paths) if (!stageOfPath.has(path)) stageOfPath.set(path, stage.ordinal);
  }
  return { stageOfPath, filesOfStage };
}

// ONE evaluator. The stager computes expected answers through it at construction
// and the adjudicator re-evaluates agent hops through it at grading; two
// implementations would let the instrument disagree with its own ground truth.
export function evaluateAuditHop({ hop, hopIndex, input, delivery, includeTargets }) {
  assertExperiment(AUDIT_HOP_CYCLE.includes(hop), `Unknown audit hop ${hop}`);
  if (hop === "SOF") {
    const stage = delivery.stageOfPath.get(input);
    assertExperiment(Number.isSafeInteger(stage), `SOF hop input ${input} was never delivered`);
    return stage;
  }
  if (hop === "FIN") {
    const files = delivery.filesOfStage.get(input) ?? [];
    assertExperiment(Number.isSafeInteger(hopIndex) && hopIndex >= 1 && hopIndex <= files.length,
      `FIN hop needs file ${hopIndex} of stage ${input}`);
    return files[hopIndex - 1];
  }
  const targets = includeTargets(input);
  assertExperiment(Number.isSafeInteger(hopIndex) && hopIndex >= 1 &&
    hopIndex <= AUDIT_INCLUDE_MAX_INDEX && typeof targets[hopIndex - 1] === "string",
  `INC hop needs resolvable quoted include ${hopIndex} of ${input}`);
  return targets[hopIndex - 1];
}

export function auditStepId(chainId, index) {
  return `${chainId}-${String(index).padStart(2, "0")}`;
}

function ordinalWord(value) {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th");
  return `${value}${suffix}`;
}

// The step sentence is a pure function of the VISIBLE step fields: it names the
// previous step's label (or the literal anchor for step 01), never a value, and it
// declares its counting and resolution rules in full. No "remember", no "you will
// be asked": the trace is framed as the work itself.
export function auditStepSentence(step) {
  const id = auditStepId(step.chainId, step.index);
  const label = `AUDIT TRACE ${step.chainId}, step ${String(step.index).padStart(2, "0")}:`;
  const subject = step.index === 1
    ? `the file ${step.anchor}`
    : `the file you recorded as ${auditStepId(step.chainId, step.index - 1)}`;
  if (step.hop === "SOF") {
    return `${label} which stage of this session delivered ${subject}? ` +
      `Record it on its own line as \`${id}: <stage number>\`.`;
  }
  if (step.hop === "FIN") {
    return `${label} name the ${ordinalWord(step.hopIndex)} file delivered in the stage you ` +
      `recorded as ${auditStepId(step.chainId, step.index - 1)}, counting files in the order ` +
      `that stage delivered them. Record it on its own line as \`${id}: <repository-relative path>\`.`;
  }
  return `${label} open ${subject} and name the target of its ` +
    `${ordinalWord(step.hopIndex)} quoted include. Count every line whose first non-space ` +
    "characters are `#include` (whitespace after `#` allowed) followed by a double-quoted " +
    "path, in file order, including lines inside `#if` blocks. Give the target " +
    "repository-relative: resolve it against the including file's directory first, and " +
    "otherwise as the unique file in the checkout with that basename. " +
    `Record it on its own line as \`${id}: <repository-relative path>\`.`;
}

// Node keys are typed so a path can never collide with a stage ordinal.
const fileNode = (path) => `F:${path}`;
const stageNode = (ordinal) => `S:${ordinal}`;

// Seeded DFS with backtracking. Each step sits at the earliest legal payload stage
// after the previous step and after every input it needs is knowable; options are
// ordered by that earliest stage, ties broken by seed. Laws enforced during search:
// no node repeats inside a chain, no file node is shared between chains, at most
// one chain step per stage, step stages strictly increase, INC index <= 8, and a
// non-final INC target must already be delivered (the next SOF hop needs its
// stage; the final link has no successor, so any resolvable target is legal).
// Exhaustion REFUSES, never shortens: a variable-length chain would make the wave
// schedule non-uniform across seeds.
export function buildAuditTraces({ stages, seed, chainLength, startAfters, earlyLaw, includeTargets }) {
  assertExperiment(Array.isArray(stages) && stages.length > 0 &&
    Number.isSafeInteger(chainLength) && chainLength >= 2 &&
    Array.isArray(startAfters) && startAfters.length >= 1 &&
    startAfters.length <= AUDIT_TRACE_IDS.length &&
    typeof includeTargets === "function",
  "Audit traces need the delivery skeleton, a seed, and an include reader");
  const delivery = auditDelivery(stages);
  const payloadOrdinals = stages.filter((stage) => stage.files.length > 0)
    .map((stage) => stage.ordinal);
  const bannedFiles = new Set();
  const occupiedStages = new Set();
  const chains = [];
  const nextStage = (after, minStage) =>
    payloadOrdinals.find((ordinal) => ordinal > after && ordinal >= minStage &&
      !occupiedStages.has(ordinal)) ?? null;
  for (const [chainIndex, startAfter] of startAfters.entries()) {
    const id = AUDIT_TRACE_IDS[chainIndex];
    const anchorPool = [];
    for (const stage of stages) {
      if (stage.ordinal > startAfter) break;
      for (const file of stage.files) {
        if (!bannedFiles.has(fileNode(file.path))) anchorPool.push(file.path);
      }
    }
    let built = null;
    const dfs = (index, value, previousStage, seen, links) => {
      if (index > chainLength) {
        built = links.map((link) => ({ ...link }));
        return true;
      }
      const hop = AUDIT_HOP_CYCLE[(index - 1) % 3];
      const options = [];
      const consider = (hopIndex, answer, key, minStage) => {
        if (seen.has(key) || bannedFiles.has(key)) return;
        options.push({ hopIndex, answer, key, minStage });
      };
      if (hop === "SOF") {
        const answer = delivery.stageOfPath.get(value);
        if (answer !== undefined) consider(null, answer, stageNode(answer), answer + 1);
      } else if (hop === "FIN") {
        (delivery.filesOfStage.get(value) ?? []).forEach((path, position) => {
          consider(position + 1, path, fileNode(path), value + 1);
        });
      } else {
        // A non-final INC target must be DELIVERED (the next SOF hop needs its
        // stage). The final link may target a never-delivered file, but a
        // delivered one still binds to its delivery stage: a target delivered
        // AFTER the step would name the answer in a later instruction.
        const finalLink = index === chainLength;
        includeTargets(value).slice(0, AUDIT_INCLUDE_MAX_INDEX).forEach((target, position) => {
          if (typeof target !== "string") return;
          const deliveredAt = delivery.stageOfPath.get(target);
          if (!finalLink && deliveredAt === undefined) return;
          consider(position + 1, target, fileNode(target),
            deliveredAt === undefined ? 1 : deliveredAt + 1);
        });
      }
      const ranks = seededShuffle(options.map((_, position) => position),
        `${seed}:${id}:${index}:rank`);
      for (const [position, option] of options.entries()) option.rank = ranks.indexOf(position);
      options.sort((left, right) => left.minStage - right.minStage || left.rank - right.rank);
      for (const option of options) {
        const stage = nextStage(previousStage, option.minStage);
        if (stage === null) continue;
        seen.add(option.key);
        occupiedStages.add(stage);
        links.push({
          index, stage, hop, hopIndex: option.hopIndex, input: value,
          expectedAnswer: option.answer,
        });
        if (dfs(index + 1, option.answer, stage, seen, links)) return true;
        links.pop();
        occupiedStages.delete(stage);
        seen.delete(option.key);
      }
      return false;
    };
    for (const anchor of seededShuffle(anchorPool, `${seed}:${id}:anchors`)) {
      const seen = new Set([fileNode(anchor)]);
      if (dfs(1, anchor, delivery.stageOfPath.get(anchor), seen, [])) break;
    }
    assertExperiment(built !== null,
      `Audit trace ${id} is unconstructible; stage the campaign with a different seed`);
    chains.push({ id, links: built });
    bannedFiles.add(fileNode(built[0].input));
    for (const link of built) {
      if (typeof link.expectedAnswer === "string") bannedFiles.add(fileNode(link.expectedAnswer));
    }
  }
  const earlyLinks = chains.flatMap((chain) => chain.links)
    .filter((link) => link.stage <= earlyLaw.maxStage);
  assertExperiment(earlyLinks.length >= earlyLaw.minLinks,
    `Only ${earlyLinks.length} chain links landed at stage <= ${earlyLaw.maxStage}, ` +
    `need ${earlyLaw.minLinks}; stage the campaign with a different seed`);
  return chains;
}

// Chain-link probes ask for a value the agent RECORDED earlier. Selection laws:
// eligible links are unprobed steps aged past the carrier horizon; at least one
// draw comes from the oldest third of the pool so no wave tests only the newest
// link; once any chain has been probed, every later wave revisits a probed
// chain at least once (recall of a previous recall, structurally); no link is
// probed twice and no chain contributes two links to one wave. Exhaustion
// refuses and the stager redraws its seed.
export function buildChainLinkProbes({ chains, probeOrdinal, seed, count, probedLinks, probedChains }) {
  if (count === 0) return [];
  const keyOf = (chainId, index) => `${chainId}:${index}`;
  const horizon = Math.ceil(probeOrdinal / 2);
  const eligible = chains.flatMap((chain) => chain.links
    .filter((link) => link.stage <= horizon && !probedLinks.has(keyOf(chain.id, link.index)))
    .map((link) => ({ chain, link })));
  eligible.sort((left, right) => left.link.stage - right.link.stage);
  const oldestThird = new Set(eligible.slice(0, Math.ceil(eligible.length / 3))
    .map((entry) => keyOf(entry.chain.id, entry.link.index)));
  const requireRepeat = probedChains.size > 0;
  const ranked = seededShuffle(eligible, `${seed}:chain-links`);
  // count is at most 3 and the pool is small: exhaustive search over ranked
  // combinations, first fully legal draw wins, so selection is deterministic.
  const chosen = [];
  const search = (start) => {
    if (chosen.length === count) {
      return (!requireRepeat || chosen.some((entry) => probedChains.has(entry.chain.id))) &&
        chosen.some((entry) => oldestThird.has(keyOf(entry.chain.id, entry.link.index)));
    }
    for (let index = start; index < ranked.length; index += 1) {
      const entry = ranked[index];
      if (chosen.some((picked) => picked.chain.id === entry.chain.id)) continue;
      chosen.push(entry);
      if (search(index + 1)) return true;
      chosen.pop();
    }
    return false;
  };
  assertExperiment(search(0),
    `Probe stage ${probeOrdinal} cannot fill ${count} chain-link slots under the ` +
    "selection laws; stage the campaign with a different seed");
  return chosen.map(({ chain, link }) => {
    probedLinks.add(keyOf(chain.id, link.index));
    probedChains.add(chain.id);
    const stepId = auditStepId(chain.id, link.index);
    const answerForm = link.hop === "SOF" ? "stage number" : "repository-relative path";
    return {
      id: "",
      kind: "chain-link",
      question: "The dependency appendix lists each audit trace in order and its " +
        `${chain.id} step ${String(link.index).padStart(2, "0")} row is blank. ` +
        `What value did you record for ${stepId}? Answer with the ${answerForm} only.`,
      expectedAnswer: String(link.expectedAnswer),
      chainId: chain.id,
      linkIndex: link.index,
      sourceStage: link.stage,
    };
  });
}

// An echo probe restates the agent's own earlier ANSWER, so its truth is
// per-run: it carries no expected answer by construction and is graded only by
// the adjudicator, never in the blind packet. Targets are distinct chain-link
// probes from strictly earlier waves: a recall of a recall of a derived fact.
export function buildEchoProbes({ earlierWaves, seed, count, echoedTargets }) {
  if (count === 0) return [];
  const candidates = earlierWaves.flatMap((wave) => wave.probes
    .filter((probe) => probe.kind === "chain-link" && !echoedTargets.has(probe.id)));
  assertExperiment(candidates.length >= count,
    "Echo probes need unechoed chain-link probes from earlier waves");
  return seededShuffle(candidates, `${seed}:echo`).slice(0, count).map((target) => {
    echoedTargets.add(target.id);
    return {
      id: "",
      kind: "echo",
      question: `Audit trail: restate the answer you gave for ${target.id}, exactly ` +
        "as you gave it. Answer with that value only.",
      targetProbeId: target.id,
    };
  });
}

// The derivation control prices the INC hop with the anchor SUPPLIED: work
// competence with nothing to recall, calibrating every chain number in the run.
// The anchor is a delivered file on no chain, so the control never refreshes
// trace material.
export function buildDerivationControlProbes({ stages, chains, seed, count, includeTargets }) {
  if (count === 0) return [];
  const chainFiles = new Set(chains.flatMap((chain) => [
    chain.links[0].input,
    ...chain.links.map((link) => link.expectedAnswer)
      .filter((value) => typeof value === "string"),
  ]));
  const delivered = stages.flatMap((stage) => stage.files.map((file) => file.path))
    .filter((path) => !chainFiles.has(path));
  for (const path of seededShuffle(delivered, `${seed}:derivation-control`)) {
    const targets = includeTargets(path);
    const positions = targets
      .map((target, position) => typeof target === "string" ? position + 1 : null)
      .filter((position) => position !== null && position <= AUDIT_INCLUDE_MAX_INDEX);
    if (positions.length === 0) continue;
    const hopIndex = positions[seededSequence(`${seed}:derivation-control:${path}`, 1)[0] % positions.length];
    return [{
      id: "",
      kind: "derivation-control",
      question: `Control question, nothing to recall: starting from ${path}, name the ` +
        `target of its ${ordinalWord(hopIndex)} quoted include, using the same counting ` +
        "and resolution rules as the audit traces. Answer with the repository-relative path only.",
      expectedAnswer: targets[hopIndex - 1],
      sourcePath: path,
    }];
  }
  assertExperiment(false,
    "No delivered file can host the derivation control; stage the campaign with a different seed");
  return [];
}

// ---------------------------------------------------------------------------
// Stage plan: DATA, hashed. The hash is pinned into every run manifest.
// ---------------------------------------------------------------------------
export function stagePlanSha256(plan) {
  assertExperiment(plan && typeof plan === "object", "Stage plan hashing requires a plan object");
  const { planSha256: _ignored, ...identity } = plan;
  return sha256Json(identity);
}

// The corpus fingerprint every run re-derives from its own detached worktree and asserts
// against the plan: a run whose checkout differs from the staged bytes is not the experiment.
export function corpusManifestSha256(entries) {
  assertExperiment(Array.isArray(entries) && entries.length > 0, "Corpus fingerprint requires files");
  return sha256Json([...entries]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

export function stagePayloadText(stage) {
  assertExperiment(stage && typeof stage === "object", "Stage payload requires a stage");
  // Hard gate: ground truth is extracted at staging time and must never be rendered into a
  // payload the session can see. visibleStage() strips it; this refuses if it did not.
  assertExperiment((stage.probes ?? []).every((probe) =>
    HIDDEN_PROBE_KEYS.every((key) => !Object.hasOwn(probe, key))),
  `Stage ${stage.ordinal} payload still carries probe ground truth`);
  // A chain step is visible BY DESIGN: it names labels and rules, never values, so
  // it has no hidden keys to strip. Any key beyond the declared surface is drift.
  assertExperiment(stage.chainStep == null ||
    exactKeys(stage.chainStep, ["id", "chainId", "index", "hop", "hopIndex", "anchor"]),
  `Stage ${stage.ordinal} chain step carries keys beyond the visible surface`);
  const header = [
    `STAGE ${String(stage.ordinal).padStart(2, "0")} / ${stage.kind}`,
    stage.instructions,
  ];
  if (stage.kind === "probe") {
    header.push("", "QUESTIONS (answer each from what you already know; cite where you learned it):");
    for (const probe of stage.probes) header.push(`- ${probe.id}: ${probe.question}`);
  }
  if (stage.deliverable) header.push("", `DELIVERABLE ${stage.deliverable.id}: ${stage.deliverable.instructions}`);
  const body = stage.files.map((file) =>
    `\n----- BEGIN ${file.path} (${file.lines} lines) -----\n${file.text}\n----- END ${file.path} -----\n`).join("");
  return `${header.join("\n")}\n${body}\nNEXT_KEY: ${stage.nextKeyPlaceholder ?? "<supervisor>"}\n`;
}

export function validateStagePlan(plan) {
  assertExperiment(exactKeys(plan, [
    "version", "mode", "repo", "seed", "stageCount", "stageIntervalMs", "watchdogMs",
    "heartbeatMs", "corpus", "stages", "chains", "probeCount", "deliverableCount", "planSha256",
  ]), "Invalid stage plan shape");
  assertExperiment(plan.version === EXPERIMENT_PROTOCOL_VERSION, "Stage plan protocol version drifted");
  assertExperiment(EXPERIMENT_MODES.includes(plan.mode), "Invalid stage plan mode");
  const modePlan = EXPERIMENT_MODE_PLANS[plan.mode];
  assertExperiment(plan.stageCount === modePlan.stageCount &&
    plan.stageIntervalMs === modePlan.stageIntervalMs &&
    plan.watchdogMs === modePlan.watchdogMs && plan.heartbeatMs === modePlan.heartbeatMs,
  "Stage plan constants drifted from its mode plan");
  assertExperiment(exactKeys(plan.repo, ["key", "url", "commit", "license", "language", "treeSha256"]) &&
    Object.hasOwn(EXPERIMENT_REPOS, plan.repo.key) &&
    plan.repo.commit === EXPERIMENT_REPOS[plan.repo.key].commit &&
    plan.repo.url === EXPERIMENT_REPOS[plan.repo.key].url &&
    HEX_40.test(plan.repo.commit) && HEX_64.test(plan.repo.treeSha256),
  "Stage plan repo pin is invalid or unregistered");
  assertExperiment(Array.isArray(plan.stages) && plan.stages.length === plan.stageCount,
    "Stage plan stage count drifted");
  let probeCount = 0;
  let deliverableCount = 0;
  const carrierStages = new Set();
  const seenCodeWords = new Set();
  for (const [index, stage] of plan.stages.entries()) {
    assertExperiment(exactKeys(stage, [
      "ordinal", "kind", "instructions", "files", "probes", "deliverable", "payloadChars",
      "payloadSha256", "codeWord", "chainStep",
    ]) && stage.ordinal === index + 1 &&
      ["read", "revisit", "probe"].includes(stage.kind) &&
      typeof stage.instructions === "string" && stage.instructions.length > 0 &&
      Array.isArray(stage.files) && Array.isArray(stage.probes),
    `Invalid stage shape at ${index + 1}`);
    assertExperiment((stage.kind === "probe") === modePlan.probeStages.includes(stage.ordinal) &&
      (stage.kind === "probe") === (stage.probes.length > 0),
    `Stage ${index + 1} disagrees with the mode plan about being a probe wave`);
    if (stage.kind === "probe") {
      // The kind schedule is the contract: a wave whose slots drifted from the
      // mode plan is a different instrument.
      const waveKinds = modePlan.probeKinds[modePlan.probeStages.indexOf(stage.ordinal)];
      assertExperiment(stage.probes.length === waveKinds.length &&
        stage.probes.every((probe, position) => (waveKinds[position] === "repo"
          ? REPO_PROBE_KINDS.includes(probe.kind)
          : probe.kind === waveKinds[position])),
      `Stage ${index + 1} probe kinds drifted from the mode plan schedule`);
    }
    // The code word is the conversation-fact channel: exactly one per payload stage,
    // woven into the instructions, absent from probe stages, never repeated.
    if (stage.kind === "probe") {
      assertExperiment(stage.codeWord === null, `Probe stage ${index + 1} carries a code word`);
    } else {
      assertExperiment(typeof stage.codeWord === "string" && CODE_WORD_PATTERN.test(stage.codeWord) &&
        stage.instructions.includes(stage.codeWord) && !seenCodeWords.has(stage.codeWord),
      `Stage ${index + 1} code word is missing, malformed, unwoven, or repeated`);
      seenCodeWords.add(stage.codeWord);
    }
    for (const file of stage.files) {
      assertExperiment(exactKeys(file, ["path", "sha256", "lines", "chars", "bytes"]) &&
        HEX_64.test(file.sha256) && Number.isSafeInteger(file.lines) && file.lines > 0,
      `Invalid staged file at stage ${index + 1}`);
    }
    for (const probe of stage.probes) {
      if (CONVERSATION_PROBE_KINDS.includes(probe.kind)) {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "sourceStage",
        ]) && typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          Number.isSafeInteger(probe.sourceStage) && probe.sourceStage >= 1 &&
          probe.sourceStage < stage.ordinal,
        `Invalid conversation probe shape at stage ${index + 1}`);
        // One probe per carrier stage across the WHOLE plan: a probed span refreshes
        // at the tail once answered, and a second probe would measure the refresh.
        assertExperiment(!carrierStages.has(probe.sourceStage),
          `Carrier stage ${probe.sourceStage} is probed twice`);
        carrierStages.add(probe.sourceStage);
        const carrier = plan.stages[probe.sourceStage - 1];
        assertExperiment(carrier && carrier.kind !== "probe",
          `Conversation probe at stage ${index + 1} targets a probe stage`);
        if (probe.kind === "stage-fact") {
          assertExperiment(probe.expectedAnswer === carrier.codeWord,
            `stage-fact probe at stage ${index + 1} disagrees with carrier ${probe.sourceStage}`);
        } else {
          assertExperiment(carrier.files.length > 0 && probe.expectedAnswer === carrier.files[0].path,
            `stage-binding probe at stage ${index + 1} disagrees with carrier ${probe.sourceStage}`);
        }
      } else if (probe.kind === "chain-link") {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "chainId", "linkIndex", "sourceStage",
        ]) && typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          Number.isSafeInteger(probe.linkIndex) && probe.linkIndex >= 1,
        `Invalid chain-link probe shape at stage ${index + 1}`);
      } else if (probe.kind === "echo") {
        assertExperiment(exactKeys(probe, ["id", "kind", "question", "targetProbeId"]) &&
          typeof probe.targetProbeId === "string" && probe.targetProbeId.length > 0 &&
          !Object.hasOwn(probe, "expectedAnswer"),
        `Invalid echo probe shape at stage ${index + 1}`);
      } else if (probe.kind === "derivation-control") {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "sourcePath",
        ]) && typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          typeof probe.sourcePath === "string" && probe.sourcePath.length > 0,
        `Invalid derivation-control probe shape at stage ${index + 1}`);
      } else {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "sourcePath", "sourceLine",
        ]) && REPO_PROBE_KINDS.includes(probe.kind) &&
          typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          Number.isSafeInteger(probe.sourceLine) && probe.sourceLine > 0,
        `Invalid probe shape at stage ${index + 1}`);
      }
      probeCount += 1;
    }
    if (stage.deliverable) {
      assertExperiment(exactKeys(stage.deliverable, ["id", "instructions", "referencesStages"]) &&
        Array.isArray(stage.deliverable.referencesStages) &&
        stage.deliverable.referencesStages.every((value) =>
          Number.isSafeInteger(value) && value >= 1 && value < stage.ordinal),
      `Invalid deliverable at stage ${index + 1}`);
      deliverableCount += 1;
    }
    assertExperiment(HEX_64.test(stage.payloadSha256) && Number.isSafeInteger(stage.payloadChars) &&
      stage.payloadChars > 0, `Invalid payload attestation at stage ${index + 1}`);
    if (stage.kind !== "probe") {
      assertExperiment(stage.payloadChars >= modePlan.payloadFloorChars,
        `Stage ${index + 1} payload is below the fold-eligibility floor`);
    }
  }
  assertExperiment(plan.probeCount === probeCount && plan.deliverableCount === deliverableCount &&
    probeCount > 0 && deliverableCount > 0, "Stage plan probe/deliverable counts drifted");
  // Every stage payload is unique bytes. A harness-induced repeat would land in the reread
  // tax as if the model had re-read it, so revisit stages carry instructions, never resent
  // file bodies: the only way a payload hash can repeat is a model-initiated read.
  const payloadHashes = plan.stages.map((stage) => stage.payloadSha256);
  assertExperiment(new Set(payloadHashes).size === payloadHashes.length,
    "Stage plan repeats a payload: the reread tax could not distinguish harness from model");
  const stagedPaths = plan.stages.flatMap((stage) => stage.files.map((file) => file.path));
  assertExperiment(new Set(stagedPaths).size === stagedPaths.length,
    "Stage plan delivers the same file twice");
  // Grading flattens every wave into one packet and joins answers to ground truth by id,
  // so an id repeated across waves would leave the grader joining by position.
  const probeIds = plan.stages.flatMap((stage) => stage.probes.map((probe) => probe.id));
  assertExperiment(new Set(probeIds).size === probeIds.length, "Stage plan repeats a probe id");
  // -------------------------------------------------------------------------
  // Audit trace laws. Everything but INC file content is re-derivable from the
  // plan itself, so a tampered or drifted chain is refused at load; INC content
  // is verified at construction and re-verified by the gate suite against a
  // real checkout.
  // -------------------------------------------------------------------------
  const delivery = auditDelivery(plan.stages);
  assertExperiment(Array.isArray(plan.chains) &&
    plan.chains.length === modePlan.chainStartAfters.length,
  "Stage plan chain count disagrees with its mode plan");
  const chainFileNodes = new Set();
  const chainStageNodes = new Set();
  const linkByStage = new Map();
  for (const [chainIndex, chain] of plan.chains.entries()) {
    assertExperiment(exactKeys(chain, ["id", "links"]) &&
      chain.id === AUDIT_TRACE_IDS[chainIndex] &&
      Array.isArray(chain.links) && chain.links.length === modePlan.chainLength,
    `Invalid audit trace shape at chain ${chainIndex + 1}`);
    const seenNodes = new Set();
    const claimNode = (node) => {
      assertExperiment(!seenNodes.has(node), `${chain.id} repeats node ${node}`);
      seenNodes.add(node);
      if (node.startsWith("F:")) {
        assertExperiment(!chainFileNodes.has(node), `Chains share file node ${node}`);
        chainFileNodes.add(node);
      } else {
        chainStageNodes.add(Number(node.slice(2)));
      }
    };
    let previousStage = 0;
    for (const [linkIndex, link] of chain.links.entries()) {
      assertExperiment(exactKeys(link, [
        "index", "stage", "hop", "hopIndex", "input", "expectedAnswer",
      ]) && link.index === linkIndex + 1 && link.hop === AUDIT_HOP_CYCLE[linkIndex % 3],
      `Invalid link shape at ${chain.id} link ${linkIndex + 1}`);
      const carrier = plan.stages[link.stage - 1];
      assertExperiment(carrier && carrier.kind !== "probe" && link.stage > previousStage,
        `${chain.id} link ${link.index} is not on a strictly later payload stage`);
      previousStage = link.stage;
      assertExperiment(!linkByStage.has(link.stage),
        `Stage ${link.stage} carries two chain steps`);
      linkByStage.set(link.stage, { chainId: chain.id, link });
      if (linkIndex === 0) {
        claimNode(fileNode(link.input));
      } else {
        assertExperiment(link.input === chain.links[linkIndex - 1].expectedAnswer,
          `${chain.id} link ${link.index} does not consume the previous answer`);
      }
      if (link.hop === "SOF") {
        assertExperiment(link.hopIndex === null &&
          delivery.stageOfPath.get(link.input) === link.expectedAnswer &&
          link.expectedAnswer < link.stage,
        `${chain.id} link ${link.index} disagrees with the delivery map`);
        claimNode(stageNode(link.expectedAnswer));
      } else if (link.hop === "FIN") {
        const files = delivery.filesOfStage.get(link.input) ?? [];
        assertExperiment(Number.isSafeInteger(link.hopIndex) && link.hopIndex >= 1 &&
          files[link.hopIndex - 1] === link.expectedAnswer && link.input < link.stage,
        `${chain.id} link ${link.index} disagrees with the delivery map`);
        claimNode(fileNode(link.expectedAnswer));
      } else {
        // A delivered INC target must precede its step even on the final link:
        // a later delivery would name the answer in a later instruction.
        const deliveredAt = delivery.stageOfPath.get(link.expectedAnswer);
        assertExperiment(Number.isSafeInteger(link.hopIndex) && link.hopIndex >= 1 &&
          link.hopIndex <= AUDIT_INCLUDE_MAX_INDEX &&
          typeof link.expectedAnswer === "string" && link.expectedAnswer.length > 0 &&
          (deliveredAt === undefined
            ? link.index === modePlan.chainLength
            : deliveredAt < link.stage),
        `${chain.id} link ${link.index} INC target is not knowable at its step stage`);
        claimNode(fileNode(link.expectedAnswer));
      }
    }
  }
  // Steps and links are a bijection, and every step sentence is woven into its
  // carrier's instructions exactly as the renderer would speak it.
  for (const stage of plan.stages) {
    const bound = linkByStage.get(stage.ordinal);
    if (!bound) {
      assertExperiment(stage.chainStep === null,
        `Stage ${stage.ordinal} carries a chain step no chain claims`);
      continue;
    }
    const { chainId, link } = bound;
    assertExperiment(stage.chainStep !== null &&
      exactKeys(stage.chainStep, ["id", "chainId", "index", "hop", "hopIndex", "anchor"]) &&
      stage.chainStep.id === auditStepId(chainId, link.index) &&
      stage.chainStep.chainId === chainId && stage.chainStep.index === link.index &&
      stage.chainStep.hop === link.hop && stage.chainStep.hopIndex === link.hopIndex &&
      stage.chainStep.anchor === (link.index === 1 ? link.input : null) &&
      stage.instructions.includes(auditStepSentence(stage.chainStep)),
    `Stage ${stage.ordinal} chain step disagrees with ${chainId} link ${link.index}`);
  }
  const earlyLinks = plan.chains.flatMap((chain) => chain.links)
    .filter((link) => link.stage <= modePlan.chainEarlyLaw.maxStage);
  assertExperiment(earlyLinks.length >= modePlan.chainEarlyLaw.minLinks,
    "Stage plan has too few early chain links for its first probe wave");
  // Probe-side chain laws: every chain-link probe binds to a real link inside
  // the carrier horizon, no link is probed twice, no chain twice in one wave,
  // every wave draws from the oldest third of its eligible pool, every wave
  // after the first revisits a probed chain, echoes target distinct chain-link
  // probes from strictly earlier waves, the derivation control rides no chain
  // file, and stage-binding carriers avoid chain stage nodes.
  const probedLinkKeys = new Set();
  const probedChains = new Set();
  const echoedTargets = new Set();
  const earlierChainLinkIds = new Set();
  for (const stage of plan.stages) {
    if (stage.kind !== "probe") continue;
    const priorLinkKeys = new Set(probedLinkKeys);
    const priorChains = new Set(probedChains);
    const waveChains = new Set();
    const waveLinkKeys = [];
    for (const probe of stage.probes) {
      if (probe.kind === "chain-link") {
        const chain = plan.chains.find((candidate) => candidate.id === probe.chainId);
        const link = chain?.links[probe.linkIndex - 1];
        assertExperiment(link !== undefined && link.stage === probe.sourceStage &&
          String(link.expectedAnswer) === probe.expectedAnswer &&
          link.stage <= Math.ceil(stage.ordinal / 2),
        `chain-link probe at stage ${stage.ordinal} disagrees with its link`);
        const key = `${probe.chainId}:${probe.linkIndex}`;
        assertExperiment(!probedLinkKeys.has(key), `Chain link ${key} is probed twice`);
        assertExperiment(!waveChains.has(probe.chainId),
          `Wave ${stage.ordinal} probes chain ${probe.chainId} twice`);
        probedLinkKeys.add(key);
        probedChains.add(probe.chainId);
        waveChains.add(probe.chainId);
        waveLinkKeys.push(key);
      } else if (probe.kind === "echo") {
        assertExperiment(earlierChainLinkIds.has(probe.targetProbeId) &&
          !echoedTargets.has(probe.targetProbeId),
        `Echo at stage ${stage.ordinal} must target a distinct earlier chain-link probe`);
        echoedTargets.add(probe.targetProbeId);
      } else if (probe.kind === "derivation-control") {
        assertExperiment(delivery.stageOfPath.has(probe.sourcePath) &&
          !chainFileNodes.has(fileNode(probe.sourcePath)),
        `Derivation control at stage ${stage.ordinal} rides a chain file`);
      } else if (probe.kind === "stage-binding") {
        assertExperiment(!chainStageNodes.has(probe.sourceStage),
          `stage-binding probe at stage ${stage.ordinal} carries a chain stage node`);
      }
    }
    if (waveLinkKeys.length > 0) {
      const eligible = plan.chains.flatMap((chain) => chain.links
        .filter((link) => link.stage <= Math.ceil(stage.ordinal / 2) &&
          !priorLinkKeys.has(`${chain.id}:${link.index}`))
        .map((link) => ({ key: `${chain.id}:${link.index}`, stage: link.stage })))
        .sort((left, right) => left.stage - right.stage);
      const oldestThird = new Set(eligible.slice(0, Math.ceil(eligible.length / 3))
        .map((entry) => entry.key));
      assertExperiment(waveLinkKeys.some((key) => oldestThird.has(key)),
        `Wave ${stage.ordinal} never draws from the oldest third of its pool`);
      assertExperiment(priorChains.size === 0 ||
        [...waveChains].some((chainId) => priorChains.has(chainId)),
      `Wave ${stage.ordinal} never revisits a probed chain`);
    }
    for (const probe of stage.probes) {
      if (probe.kind === "chain-link") earlierChainLinkIds.add(probe.id);
    }
  }
  // A revisit instruction names an earlier stage together with its full path list,
  // which would hand over both hop answers for any stage a chain resolves to.
  for (const stage of plan.stages) {
    if (stage.kind !== "revisit") continue;
    const named = /specifically stage (\d+)/.exec(stage.instructions);
    assertExperiment(named === null || !chainStageNodes.has(Number(named[1])),
      `Revisit stage ${stage.ordinal} names a chain stage node`);
  }
  // Anti-leak scan over every INSTRUCTION SURFACE (stage instructions, probe
  // questions, deliverable instructions; file bodies are the corpus and exempt):
  // no path-valued link answer, and no (stage, path) pair belonging to an
  // SOF or FIN link, may appear at or after that link's step stage. Bare stage
  // ordinals are ordinary prose and are only refused PAIRED with their path.
  const surfaces = plan.stages.map((stage) => ({
    ordinal: stage.ordinal,
    text: [
      stage.instructions,
      ...stage.probes.map((probe) => probe.question),
      stage.deliverable === null ? "" : stage.deliverable.instructions,
    ].join("\n"),
  }));
  for (const chain of plan.chains) {
    for (const link of chain.links) {
      const pathAnswer = typeof link.expectedAnswer === "string" ? link.expectedAnswer : null;
      const pair = link.hop === "SOF"
        ? { stage: link.expectedAnswer, path: link.input }
        : link.hop === "FIN" ? { stage: link.input, path: link.expectedAnswer } : null;
      for (const surface of surfaces) {
        if (surface.ordinal < link.stage) continue;
        assertExperiment(pathAnswer === null || !surface.text.includes(pathAnswer),
          `Stage ${surface.ordinal} names the answer of ${chain.id} link ${link.index}`);
        assertExperiment(pair === null || !(surface.text.includes(pair.path) &&
          new RegExp(`\\bstage\\s+0*${pair.stage}\\b`, "i").test(surface.text)),
        `Stage ${surface.ordinal} pairs ${chain.id} link ${link.index}'s stage and path`);
      }
    }
  }
  assertExperiment(plan.planSha256 === stagePlanSha256(plan), "Stage plan hash does not cover its own body");
  return plan;
}

// The stage plan carries expected answers; the RUN payload must never see them.
// ONE list and ONE helper, used by every strip site (stager, supervisor, this
// function, and the verifier fixture): four hand-rolled destructurings drifted
// once already (the supervisor's kept only three keys), and a hidden field that
// reaches one site but not another is how a campaign voids itself silently.
export const HIDDEN_PROBE_KEYS = Object.freeze([
  "expectedAnswer", "sourcePath", "sourceLine", "sourceStage",
]);

export function visibleStage(stage) {
  return {
    ...stage,
    probes: stage.probes.map((probe) => Object.fromEntries(
      Object.entries(probe).filter(([key]) => !HIDDEN_PROBE_KEYS.includes(key)))),
  };
}

// Chain links carry the trace ground truth: the input is the previous step's
// answer and the expected answer is this step's, so both strip together.
export const HIDDEN_TRACE_LINK_KEYS = Object.freeze(["input", "expectedAnswer"]);

export function stagePlanForRun(plan) {
  validateStagePlan(plan);
  return {
    ...plan,
    stages: plan.stages.map(visibleStage),
    chains: plan.chains.map((chain) => ({
      ...chain,
      links: chain.links.map((link) => Object.fromEntries(
        Object.entries(link).filter(([key]) => !HIDDEN_TRACE_LINK_KEYS.includes(key)))),
    })),
  };
}

// ---------------------------------------------------------------------------
// Run manifest: pins everything the publication has to be able to reproduce.
// ---------------------------------------------------------------------------
export function validateExperimentManifest(manifest) {
  // A closed-book manifest keeps every pin that has a referent (model, runtime code on
  // disk, the plan the questions derive from, the plan's corpus fingerprint) and drops
  // the ones that do not (arm conditions, pacing, a checkout that never existed). It
  // REQUIRES the question-list hash so the sealed session states exactly what it asked.
  if (manifest?.sessionType === EXPERIMENT_CLOSED_BOOK_LABEL) {
    assertExperiment(keysWithin(manifest, [
      "version", "runId", "campaignId", "sessionType", "arm", "mode", "ordinal", "repetition",
      "seed", "model", "runtime", "target", "plan", "questionsSha256", "createdWallMs",
    ], ["transport"]),
    "Invalid closed-book manifest shape");
    assertExperiment(manifest.version === EXPERIMENT_PROTOCOL_VERSION,
      "Closed-book manifest protocol version drifted");
    assertExperiment(manifest.arm === EXPERIMENT_CLOSED_BOOK_LABEL,
      "Closed-book manifest arm must be the closed-book label");
    assertExperiment(EXPERIMENT_MODES.includes(manifest.mode), "Manifest mode is invalid");
    assertExperiment(manifest.transport === undefined ||
      EXPERIMENT_TRANSPORTS.includes(manifest.transport),
    "Manifest transport is not a known Pi transport");
    assertExperiment(Number.isSafeInteger(manifest.ordinal) && manifest.ordinal > 0 &&
      Number.isSafeInteger(manifest.repetition) && manifest.repetition > 0,
    "Manifest ordinal/repetition are invalid");
    assertExperiment(typeof manifest.seed === "string" && manifest.seed.length >= 16,
      "Manifest seed is missing or too short");
    assertExperiment(exactKeys(manifest.model, ["provider", "id", "effort", "contextWindow",
      "maxTokens", "descriptorSha256"]) &&
      [manifest.model.provider, manifest.model.id, manifest.model.effort].every((part) =>
        typeof part === "string" && part.length > 0) &&
      Number.isSafeInteger(manifest.model.contextWindow) && manifest.model.contextWindow > 0 &&
      HEX_64.test(manifest.model.descriptorSha256),
    "Manifest model pin is incomplete: provider, model id and effort are all required");
    assertExperiment(exactKeys(manifest.runtime, [
      "codeCommit", "codeTree", "piVersion", "sourceHashes", "dependencyHashes",
      "activeContextEnabled", "nativeCompactionEnabled",
    ]) && HEX_40.test(manifest.runtime.codeCommit) && HEX_40.test(manifest.runtime.codeTree) &&
      typeof manifest.runtime.piVersion === "string" &&
      manifest.runtime.activeContextEnabled === false &&
      manifest.runtime.nativeCompactionEnabled === false,
    "Closed-book manifest runtime pin is incomplete or claims a managed runtime");
    assertExperiment(exactKeys(manifest.target, ["repoKey", "url", "commit", "treeSha256"]) &&
      Object.hasOwn(EXPERIMENT_REPOS, manifest.target.repoKey) &&
      manifest.target.commit === EXPERIMENT_REPOS[manifest.target.repoKey].commit &&
      HEX_64.test(manifest.target.treeSha256),
    "Closed-book manifest target pin is incomplete or unregistered");
    assertExperiment(exactKeys(manifest.plan, ["planSha256", "stageCount", "probeCount", "deliverableCount"]) &&
      HEX_64.test(manifest.plan.planSha256) && Number.isSafeInteger(manifest.plan.stageCount) &&
      manifest.plan.stageCount === EXPERIMENT_MODE_PLANS[manifest.mode].stageCount,
    "Manifest stage-plan pin is incomplete");
    assertExperiment(HEX_64.test(manifest.questionsSha256),
      "Closed-book manifest requires the question-list hash");
    assertExperiment(Number.isSafeInteger(manifest.createdWallMs) && manifest.createdWallMs > 0,
      "Manifest creation clock is invalid");
    return manifest;
  }
  // `reliabilityLevers` is a RETIRED condition key, tolerated on read only: sealed run
  // manifests are immutable data and runs 10-14 recorded it. Nothing emits it any more.
  assertExperiment(keysWithin(manifest, [
    "version", "runId", "campaignId", "arm", "mode", "ordinal", "repetition",
    "seed", "model", "runtime", "target", "plan", "pacing", "createdWallMs",
  ], ["sessionType", "guidance", "foldScheduling", "foldPeekResults", "guidedCuration", "providerTotalWindow", "providerInputBudget", "briefGenerator", "transport", "reliabilityLevers"]),
  "Invalid experiment manifest shape");
  assertExperiment(manifest.sessionType === undefined || manifest.sessionType === "arm",
    "Arm manifest carries a foreign session type");
  assertExperiment(manifest.foldScheduling === undefined ||
    EXPERIMENT_FOLD_SCHEDULING.includes(manifest.foldScheduling),
  "Manifest fold scheduling is not a shipped package option");
  assertExperiment(manifest.foldPeekResults === undefined ||
    typeof manifest.foldPeekResults === "boolean",
  "Manifest peek-fold condition is not a boolean");
  assertExperiment(manifest.guidedCuration === undefined ||
    typeof manifest.guidedCuration === "boolean",
  "Manifest guided-curation condition is not a boolean");
  assertExperiment(manifest.providerTotalWindow === undefined ||
    (Number.isSafeInteger(manifest.providerTotalWindow) && manifest.providerTotalWindow > 0),
  "Manifest provider total window is invalid");
  assertExperiment(manifest.providerInputBudget === undefined ||
    (Number.isSafeInteger(manifest.providerInputBudget) && manifest.providerInputBudget > 0),
  "Manifest provider input budget is invalid");
  // Only an arm that REGISTERS the runtime writes briefs, so only that arm may claim a
  // generator. A native or unmanaged manifest carrying one would be attesting to a brief
  // regime it never ran. Runs sealed before the descriptor existed carry no key and stay
  // readable: their briefs were the deterministic fallback throughout.
  assertExperiment(manifest.briefGenerator === undefined || validBriefGenerator(manifest.briefGenerator),
    "Manifest brief generator is not a provider/model/effort descriptor");
  assertExperiment(manifest.transport === undefined || EXPERIMENT_TRANSPORTS.includes(manifest.transport),
    "Manifest transport is not a known Pi transport");
  assertExperiment(manifest.version === EXPERIMENT_PROTOCOL_VERSION, "Manifest protocol version drifted");
  assertExperiment(EXPERIMENT_ARMS.includes(manifest.arm), "Manifest arm is not one of the three arms");
  assertExperiment(EXPERIMENT_MODES.includes(manifest.mode), "Manifest mode is invalid");
  assertExperiment(manifest.guidance === undefined ||
    EXPERIMENT_GUIDANCE_PROFILES.includes(manifest.guidance),
  "Manifest guidance profile is not a shipped package option");
  assertExperiment(Number.isSafeInteger(manifest.ordinal) && manifest.ordinal > 0 &&
    Number.isSafeInteger(manifest.repetition) && manifest.repetition > 0,
  "Manifest ordinal/repetition are invalid");
  assertExperiment(typeof manifest.seed === "string" && manifest.seed.length >= 16,
    "Manifest seed is missing or too short");
  assertExperiment(exactKeys(manifest.model, ["provider", "id", "effort", "contextWindow", "maxTokens",
    "descriptorSha256"]) &&
    [manifest.model.provider, manifest.model.id, manifest.model.effort].every((part) =>
      typeof part === "string" && part.length > 0) &&
    Number.isSafeInteger(manifest.model.contextWindow) && manifest.model.contextWindow > 0 &&
    HEX_64.test(manifest.model.descriptorSha256),
  "Manifest model pin is incomplete: provider, model id and effort are all required");
  assertExperiment(exactKeys(manifest.runtime, [
    "codeCommit", "codeTree", "piVersion", "sourceHashes", "dependencyHashes", "activeContextEnabled",
    "nativeCompactionEnabled",
  ]) && HEX_40.test(manifest.runtime.codeCommit) && HEX_40.test(manifest.runtime.codeTree) &&
    typeof manifest.runtime.piVersion === "string" &&
    typeof manifest.runtime.activeContextEnabled === "boolean" &&
    typeof manifest.runtime.nativeCompactionEnabled === "boolean",
  "Manifest runtime pin is incomplete");
  // The arm IS the runtime configuration; a manifest that disagrees with its arm is a lie.
  // Derived from the one arm table rather than copied beside it: a second copy is a thing
  // that drifts, and the copy is what a sealed manifest would be validated against.
  const expected = armRuntimeConfiguration(manifest.arm);
  assertExperiment(manifest.runtime.activeContextEnabled === expected.activeContextEnabled &&
    manifest.runtime.nativeCompactionEnabled === expected.nativeCompactionEnabled,
  `Manifest runtime configuration contradicts arm ${manifest.arm}`);
  // Only an arm that REGISTERS the runtime writes briefs, so only that arm may claim a
  // generator: a native or unmanaged manifest carrying one would attest to a brief regime
  // it never ran. Runs sealed before the descriptor existed carry no key and stay
  // readable, and their briefs were the deterministic fallback throughout.
  assertExperiment(manifest.briefGenerator === undefined || expected.activeContextEnabled,
    `Manifest arm ${manifest.arm} claims a brief generator but registers no runtime`);
  assertExperiment(exactKeys(manifest.target, ["repoKey", "url", "commit", "treeSha256", "checkoutSha256"]) &&
    Object.hasOwn(EXPERIMENT_REPOS, manifest.target.repoKey) &&
    manifest.target.commit === EXPERIMENT_REPOS[manifest.target.repoKey].commit &&
    HEX_64.test(manifest.target.treeSha256) && HEX_64.test(manifest.target.checkoutSha256),
  "Manifest target-repo pin is incomplete or unregistered");
  assertExperiment(exactKeys(manifest.plan, ["planSha256", "stageCount", "probeCount", "deliverableCount"]) &&
    HEX_64.test(manifest.plan.planSha256) && Number.isSafeInteger(manifest.plan.stageCount) &&
    manifest.plan.stageCount === EXPERIMENT_MODE_PLANS[manifest.mode].stageCount,
  "Manifest stage-plan pin is incomplete");
  assertExperiment(exactKeys(manifest.pacing, ["stageIntervalMs", "watchdogMs", "heartbeatMs"]) &&
    manifest.pacing.stageIntervalMs === EXPERIMENT_MODE_PLANS[manifest.mode].stageIntervalMs &&
    manifest.pacing.watchdogMs === EXPERIMENT_MODE_PLANS[manifest.mode].watchdogMs,
  "Manifest pacing drifted from its mode plan");
  assertExperiment(Number.isSafeInteger(manifest.createdWallMs) && manifest.createdWallMs > 0,
    "Manifest creation clock is invalid");
  return manifest;
}

// ---------------------------------------------------------------------------
// Run config: the supervisor -> worker contract, revalidated on both sides.
// ---------------------------------------------------------------------------
export const EXPERIMENT_RUN_CONFIG_KEYS = Object.freeze([
  "version", "runId", "runDir", "campaignId", "arm", "mode", "repetition",
  "ordinal", "seed", "unit", "invocationId", "supervisorPid", "supervisorStartTicks",
  "bootId", "codeCommit", "codeTree", "firstChallenge", "stageCount", "stageIntervalMs",
  "watchdogMs", "heartbeatMs", "createdWallMs", "createdMonotonicMs", "sourceHashes",
  "dependencyHashes", "planPath", "planSha256", "repoDir", "targetCommit", "targetTreeSha256",
  "model",
]);

// Tolerated on read, emitted by nothing. `foldScheduling`, `foldPeekResults`,
// `guidedCuration`, `reliabilityLevers` and now `providerTotalWindow` are all retired
// condition keys whose sealed run configs are immutable data, so runs 1-23 must keep
// adjudicating. A run config written after the retirement carries none of them, and
// carries `providerInputBudget` instead of the gross window.
export const EXPERIMENT_RUN_CONFIG_OPTIONAL_KEYS = Object.freeze([
  "sessionType", "guidance", "foldScheduling", "foldPeekResults", "guidedCuration",
  "providerTotalWindow", "providerInputBudget", "briefGenerator", "transport", "reliabilityLevers",
]);

export function validateExperimentRunConfig(value) {
  assertExperiment(keysWithin(value, EXPERIMENT_RUN_CONFIG_KEYS, EXPERIMENT_RUN_CONFIG_OPTIONAL_KEYS),
    "Invalid experiment run config shape");
  assertExperiment(value.foldScheduling === undefined ||
    EXPERIMENT_FOLD_SCHEDULING.includes(value.foldScheduling),
  "Run config fold scheduling is invalid");
  assertExperiment(value.foldPeekResults === undefined || typeof value.foldPeekResults === "boolean",
    "Run config peek-fold condition is invalid");
  assertExperiment(value.guidedCuration === undefined || typeof value.guidedCuration === "boolean",
    "Run config guided-curation condition is invalid");
  assertExperiment(value.providerTotalWindow === undefined ||
    (Number.isSafeInteger(value.providerTotalWindow) && value.providerTotalWindow > 0),
  "Run config provider total window is invalid");
  assertExperiment(value.providerInputBudget === undefined ||
    (Number.isSafeInteger(value.providerInputBudget) && value.providerInputBudget > 0),
  "Run config provider input budget is invalid");
  assertExperiment(value.briefGenerator === undefined || validBriefGenerator(value.briefGenerator),
    "Run config brief generator is not a provider/model/effort descriptor");
  assertExperiment(value.transport === undefined || EXPERIMENT_TRANSPORTS.includes(value.transport),
    "Run config transport is not a known Pi transport");
  assertExperiment(value.version === EXPERIMENT_PROTOCOL_VERSION, "Run config protocol version drifted");
  assertExperiment(value.sessionType === undefined ||
    EXPERIMENT_SESSION_TYPES.includes(value.sessionType),
  "Run config session type is invalid");
  // A closed-book run's "arm" is its own label, never one of the three arms: slot
  // claims, run ids and reports all key on it, so it can never collide with an arm.
  assertExperiment(value.sessionType === EXPERIMENT_CLOSED_BOOK_LABEL
    ? value.arm === EXPERIMENT_CLOSED_BOOK_LABEL
    : EXPERIMENT_ARMS.includes(value.arm),
  "Run config arm is invalid");
  assertExperiment(value.sessionType !== EXPERIMENT_CLOSED_BOOK_LABEL ||
    (value.foldScheduling === undefined && value.foldPeekResults === undefined &&
      value.guidance === undefined && value.guidedCuration === undefined &&
      value.briefGenerator === undefined),
  "Closed-book run config carries arm-condition keys with no referent");
  // A generator belongs to the arm that registers the runtime and writes briefs; on any
  // other arm the descriptor would be a fact about nothing.
  assertExperiment(value.briefGenerator === undefined ||
    (value.sessionType !== EXPERIMENT_CLOSED_BOOK_LABEL &&
      armRuntimeConfiguration(value.arm).activeContextEnabled),
  `Run config arm ${value.arm} carries a brief generator but registers no runtime`);
  assertExperiment(EXPERIMENT_MODES.includes(value.mode), "Run config mode is invalid");
  assertExperiment(value.guidance === undefined ||
    EXPERIMENT_GUIDANCE_PROFILES.includes(value.guidance),
  "Run config guidance profile is invalid");
  const modePlan = EXPERIMENT_MODE_PLANS[value.mode];
  assertExperiment(value.stageCount === modePlan.stageCount &&
    value.stageIntervalMs === modePlan.stageIntervalMs &&
    value.watchdogMs === modePlan.watchdogMs && value.heartbeatMs === modePlan.heartbeatMs,
  "Run config pacing drifted from its mode plan");
  assertExperiment(typeof value.runDir === "string" && value.runDir.endsWith(`/${value.runId}`),
    "Run directory does not carry its run id");
  assertExperiment(typeof value.campaignId === "string" && value.campaignId.length > 0,
    "Run config lacks a campaign id");
  assertExperiment(Number.isSafeInteger(value.repetition) && value.repetition > 0 &&
    Number.isSafeInteger(value.ordinal) && value.ordinal > 0,
  "Run config repetition/ordinal are invalid");
  assertExperiment(HEX_64.test(value.firstChallenge), "Run config first challenge is invalid");
  assertExperiment(HEX_40.test(value.codeCommit) && HEX_40.test(value.codeTree) &&
    HEX_40.test(value.targetCommit), "Run config commit pins are invalid");
  assertExperiment(HEX_64.test(value.planSha256) && HEX_64.test(value.targetTreeSha256),
    "Run config plan/target hashes are invalid");
  assertExperiment(typeof value.repoDir === "string" && value.repoDir.startsWith(`${value.runDir}/`),
    "The pinned checkout must live inside the run directory");
  assertExperiment(exactKeys(value.model, ["provider", "id", "effort"]) &&
    [value.model.provider, value.model.id, value.model.effort].every((part) =>
      typeof part === "string" && part.length > 0),
  "Run config must pin provider, model id and effort explicitly");
  assertExperiment(value.sourceHashes && typeof value.sourceHashes === "object" &&
    Object.values(value.sourceHashes).every((hash) => HEX_64.test(hash)) &&
    Object.keys(value.sourceHashes).length >= 6, "Run config source hashes are invalid");
  assertExperiment(exactKeys(value.dependencyHashes, EXPERIMENT_DEPENDENCY_KEYS) &&
    Object.values(value.dependencyHashes).every((hash) => HEX_64.test(hash)),
  "Run config dependency hashes are invalid");
  return structuredClone(value);
}

// The pifold arm runs with Pi's native compaction ENABLED, because that is the recommended
// deployment: the runtime intercepts every `session_before_compact`, cancels a threshold
// pass, and converts an overflow pass that will retry into a tree rollback and replay. The
// overflow recovery lane arms off that hook, so switching compaction off would switch the
// lane off with it and measure a deployment nobody is asked to run.
export function armRuntimeConfiguration(arm) {
  assertExperiment(EXPERIMENT_ARMS.includes(arm), `Unknown arm ${arm}`);
  return {
    pifold: { activeContextEnabled: true, nativeCompactionEnabled: true, toleratesOverflow: false },
    native: { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false },
    unmanaged: { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: true },
    // Compaction is ENABLED because the harness invokes it, and the fold runtime is OFF
    // because a summary and a lossless fold are the two things being told apart.
    nativefence: { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false },
  }[arm];
}

// A compaction PASS is not a compaction. Two of the three arms can now see the hook fire,
// and what separates them is the OUTCOME, so the experiment judges the outcome:
//
//   - every pass is recorded as an event on every arm, always;
//   - a pass stops the world only where it runs to a summary, which means compaction on and
//     no fold runtime in front of it: the pifold arm's passes are cancelled or converted, so
//     they pause nothing and open no stop-the-world record;
//   - a pass latches on the fire alone only where compaction is switched OFF, because there
//     the hook cannot fire for any legitimate reason;
//   - a COMPLETED compaction, meaning a summary that replaced the transcript, latches
//     everywhere except the arm whose datum it is.
export function nativeCompactionDisposition(arm) {
  const runtime = armRuntimeConfiguration(arm);
  const runsToCompletion = runtime.nativeCompactionEnabled && !runtime.activeContextEnabled;
  return {
    latchOnPass: !runtime.nativeCompactionEnabled,
    stopsTheWorld: runsToCompletion,
    latchOnCompletion: !runsToCompletion,
  };
}

const WINDOW_OVERFLOW = /context (?:length|window)|maximum context|too many tokens|token limit|exceeds? the (?:model|context)|prompt is too long|input length/i;

export function isWindowOverflow(text) {
  return typeof text === "string" && WINDOW_OVERFLOW.test(text);
}

// ---------------------------------------------------------------------------
// Reread tax. Hash the tool-result payload; a hash seen earlier in-session means those
// bytes were ingested again. Byte mass is exact; token mass is the named estimate.
// ---------------------------------------------------------------------------
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

export function toolResultContentSha256(content) {
  return sha256Text(toolResultText(content));
}

export function estimateTokens(text) {
  assertExperiment(typeof text === "string", "Token estimation requires text");
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

// records: [{ ordinal, toolName, contentSha256, chars, bytes, tokensEstimated }] in session order.
export function computeRereadTax(records) {
  assertExperiment(Array.isArray(records), "Reread tax requires an ordered tool-result ledger");
  const firstSeen = new Map();
  const perHash = new Map();
  let repeatResults = 0;
  let repeatBytes = 0;
  let repeatTokensEstimated = 0;
  let totalBytes = 0;
  let totalTokensEstimated = 0;
  for (const record of records) {
    assertExperiment(exactKeys(record, [
      "ordinal", "toolName", "contentSha256", "chars", "bytes", "tokensEstimated",
    ]) && HEX_64.test(record.contentSha256) && Number.isSafeInteger(record.bytes) &&
      Number.isSafeInteger(record.tokensEstimated),
    `Invalid tool-result ledger record at ordinal ${record?.ordinal}`);
    totalBytes += record.bytes;
    totalTokensEstimated += record.tokensEstimated;
    if (firstSeen.has(record.contentSha256)) {
      repeatResults += 1;
      repeatBytes += record.bytes;
      repeatTokensEstimated += record.tokensEstimated;
      const entry = perHash.get(record.contentSha256);
      entry.repeats += 1;
      entry.repeatBytes += record.bytes;
      entry.repeatTokensEstimated += record.tokensEstimated;
      entry.repeatOrdinals.push(record.ordinal);
    } else {
      firstSeen.set(record.contentSha256, record.ordinal);
      perHash.set(record.contentSha256, {
        contentSha256: record.contentSha256,
        toolName: record.toolName,
        firstOrdinal: record.ordinal,
        repeats: 0,
        repeatBytes: 0,
        repeatTokensEstimated: 0,
        repeatOrdinals: [],
      });
    }
  }
  const repeated = [...perHash.values()]
    .filter((entry) => entry.repeats > 0)
    .sort((left, right) => right.repeatTokensEstimated - left.repeatTokensEstimated ||
      left.contentSha256.localeCompare(right.contentSha256));
  return {
    tokenEstimatorId: TOKEN_ESTIMATOR_ID,
    toolResults: records.length,
    distinctPayloads: firstSeen.size,
    repeatResults,
    repeatBytes,
    repeatTokensEstimated,
    totalBytes,
    totalTokensEstimated,
    repeatByteShare: totalBytes > 0 ? repeatBytes / totalBytes : 0,
    repeated,
  };
}

// ---------------------------------------------------------------------------
// Stage-tool disposition. One place decides what a repo_stage call IS, so the extension
// cannot accidentally latch a benign call: a completed plan answering one trailing call
// voided a finished 64/64 native run in rep 1.
// ---------------------------------------------------------------------------
export function stageCallDisposition({ expectedStage, stageCount, toolCallId, usedToolCallIds }) {
  assertExperiment(Number.isSafeInteger(expectedStage) && expectedStage > 0 &&
    Number.isSafeInteger(stageCount) && stageCount > 0, "Stage disposition requires stage counters");
  assertExperiment(typeof toolCallId === "string" && toolCallId.length > 0,
    "Stage disposition requires a tool call id");
  // A replayed tool call id is a real capability breach in either direction and stays latched.
  if (usedToolCallIds?.has?.(toolCallId)) return { kind: "replay", latch: true, isError: true };
  // The plan is complete. A trailing call is a finished assignment being tidy, not a
  // violation: it is answered plainly and NOTHING is written to the failure latch.
  if (expectedStage > stageCount) {
    return {
      kind: "post-plan",
      latch: false,
      isError: false,
      text: `plan complete: all ${stageCount} stages served`,
    };
  }
  return { kind: "serve", latch: false, isError: false };
}

// ---------------------------------------------------------------------------
// Transcript extraction. The model routinely answers a probe wave or writes a deliverable
// one message slot LATE, because it issues the next stage call first and only then writes
// prose. Extraction therefore scans FORWARD from the stage result instead of assuming the
// very next assistant message, and stage results are addressed by the stage ordinal the
// extension stamped into the tool-result details rather than by the position of the call
// in the transcript: one stale-key retry inserts an extra repo_stage call and shifts every
// positional index after it by one (measured in the pifold rep-2 run at call 41, which
// silently moved probe waves 48 and 64 and deliverable-56 onto the wrong window).
// ---------------------------------------------------------------------------
export function assistantText(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function stageResultIndexByOrdinal(entries) {
  const byStage = new Map();
  entries.forEach((entry, index) => {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "toolResult" || message.toolName !== EXPERIMENT_TOOL_NAME) return;
    if (message.isError === true) return;
    const stage = message.details?.stage;
    if (!Number.isSafeInteger(stage) || byStage.has(stage)) return;
    byStage.set(stage, index);
  });
  return byStage;
}

export function probeAnswerPattern(probeId) {
  return new RegExp(`^\\s*[-*]?\\s*${probeId}\\s*[:\\-]\\s*(.+)$`, "im");
}

export function deliverableHeadingPattern(deliverableId) {
  const suffix = /(\d+)$/.exec(String(deliverableId));
  if (!suffix) {
    return new RegExp(String(deliverableId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return new RegExp(`deliverable\\s*[-_ ]?\\s*0*${Number(suffix[1])}\\b`, "i");
}

// The first assistant message in [start, end) whose text satisfies `matches`, plus how many
// non-empty assistant messages were skipped to reach it. Deterministic and artifact-only.
function scanAssistantMessages(entries, start, end, matches) {
  let skipped = 0;
  for (let index = start; index < end; index += 1) {
    const text = assistantText(entries[index]).trim();
    if (!text) continue;
    if (matches(text)) return { index, text, skipped };
    skipped += 1;
  }
  return { index: -1, text: "", skipped };
}

export function probeTranscripts({ entries, plan }) {
  const stageIndex = stageResultIndexByOrdinal(entries);
  const probeStages = plan.stages.filter((stage) => stage.probes.length > 0);
  return probeStages.map((stage, position) => {
    const resultIndex = stageIndex.get(stage.ordinal);
    if (resultIndex === undefined) {
      return {
        stage: stage.ordinal, delivered: false, rawText: "", messagesSkipped: 0,
        resultEntryIndex: null, answerEntryIndex: null,
        answers: stage.probes.map((probe) => ({
          probeId: probe.id, kind: probe.kind, question: probe.question,
          answerText: null, parsed: false,
        })),
      };
    }
    // The answer surface runs to the NEXT PROBE WAVE, not to the next stage: an answer
    // can arrive many stages late, but never legitimately after the following wave.
    const nextProbeStage = probeStages[position + 1];
    const endIndex = (nextProbeStage === undefined
      ? undefined
      : stageIndex.get(nextProbeStage.ordinal)) ?? entries.length;
    const found = scanAssistantMessages(entries, resultIndex + 1, endIndex, (text) =>
      stage.probes.some((probe) => probeAnswerPattern(probe.id).test(text)));
    const rawText = found.text;
    return {
      stage: stage.ordinal,
      delivered: true,
      rawText,
      messagesSkipped: found.index >= 0 ? found.skipped : null,
      resultEntryIndex: resultIndex,
      answerEntryIndex: found.index >= 0 ? found.index : null,
      answers: stage.probes.map((probe) => {
        const match = probeAnswerPattern(probe.id).exec(rawText);
        return {
          probeId: probe.id,
          kind: probe.kind,
          question: probe.question,
          answerText: match ? match[1].trim() : null,
          parsed: Boolean(match),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Closed-book floor session. The question list, the prompt and the transcript
// extraction are all derived from the plan alone, deterministically: the
// adjudicator recomputes the prompt bytes and refuses a session whose sealed
// prompt hash disagrees, which is the "no stage payload bytes" law in one line.
// Echo questions are excluded: their truth is per-run and meaningless cold.
// ---------------------------------------------------------------------------
export function closedBookQuestions(plan) {
  return plan.stages.flatMap((stage) => stage.probes
    .filter((probe) => probe.kind !== "echo")
    .map((probe) => ({ id: probe.id, question: probe.question })));
}

export function closedBookSystemPrompt() {
  return [
    "You are answering recall questions cold: there is no session history, no tool and no",
    "repository checkout available. Use only what you already know.",
  ].join(" ");
}

export function closedBookPrompt(plan) {
  const questions = closedBookQuestions(plan);
  assertExperiment(questions.length > 0, "Closed-book prompt requires a plan with probes");
  return [
    [
      "Answer the following questions. Some reference a staged reading session over the",
      `${plan.repo.key} repository at commit ${plan.repo.commit} that you have NOT seen and`,
      "cannot look at. Answer each question on its own line in the exact form",
      "`<probe-id>: <answer>`. Answer every question even if you are unsure, giving your",
      "best single answer.",
    ].join(" "),
    "",
    ...questions.map((probe) => `- ${probe.id}: ${probe.question}`),
  ].join("\n");
}

// Shaped like one probeTranscripts wave per real wave so probeMechanicalVerdicts
// grades a closed-book session UNCHANGED. There are no stages, so every answer is
// scanned for across ALL assistant text with the same parser and no window.
export function closedBookTranscript({ entries, plan }) {
  const combined = entries.map((entry) => assistantText(entry))
    .filter((text) => text.trim() !== "").join("\n");
  return plan.stages.filter((stage) => stage.probes.length > 0).map((stage) => ({
    stage: stage.ordinal,
    delivered: true,
    rawText: combined,
    messagesSkipped: null,
    resultEntryIndex: null,
    answerEntryIndex: null,
    answers: stage.probes.filter((probe) => probe.kind !== "echo").map((probe) => {
      const match = probeAnswerPattern(probe.id).exec(combined);
      return {
        probeId: probe.id,
        kind: probe.kind,
        question: probe.question,
        answerText: match ? match[1].trim() : null,
        parsed: Boolean(match),
      };
    }),
  }));
}

// Trace steps grade like probes but continuously: each chain step is a
// mechanically checkable recall event with no wave needed. A step's answer
// surface runs from its stage result to the SAME chain's next step stage (the
// value must exist before its consumer reads it), and to the end of the session
// for a final link. Steps parse with the probe parser: no new parser, no new law.
export function traceStepTranscripts({ entries, plan }) {
  const stageIndex = stageResultIndexByOrdinal(entries);
  return plan.chains.map((chain) => ({
    chainId: chain.id,
    steps: chain.links.map((link, position) => {
      const stepId = auditStepId(chain.id, link.index);
      const base = {
        stepId, chainId: chain.id, index: link.index, stage: link.stage,
        hop: link.hop, hopIndex: link.hopIndex,
      };
      const resultIndex = stageIndex.get(link.stage);
      if (resultIndex === undefined) {
        return {
          ...base, delivered: false, answerText: null, parsed: false, messagesSkipped: 0,
          resultEntryIndex: null, answerEntryIndex: null,
        };
      }
      const nextLink = chain.links[position + 1];
      const endIndex = (nextLink === undefined
        ? undefined
        : stageIndex.get(nextLink.stage)) ?? entries.length;
      const pattern = probeAnswerPattern(stepId);
      const found = scanAssistantMessages(entries, resultIndex + 1, endIndex,
        (text) => pattern.test(text));
      const match = pattern.exec(found.text);
      return {
        ...base,
        delivered: true,
        answerText: match ? match[1].trim() : null,
        parsed: Boolean(match),
        messagesSkipped: found.index >= 0 ? found.skipped : null,
        resultEntryIndex: resultIndex,
        answerEntryIndex: found.index >= 0 ? found.index : null,
      };
    }),
  }));
}

// The ONE normalizer, declared once for every trace verdict: trim, strip
// surrounding backticks and quotes and trailing punctuation. Identifiers and
// paths stay case-sensitive.
export function normalizeTraceAnswer(text) {
  if (typeof text !== "string") return null;
  let value = text.trim();
  for (;;) {
    const next = value.replace(/^[`"']+/, "").replace(/[`"'.,;:!?]+$/, "").trim();
    if (next === value) return value;
    value = next;
  }
}

// A stage answer may arrive as "7", "07" or "stage 7"; anything else is wrong.
function stageAnswerNumber(text) {
  const match = /^(?:stage\s+)?0*(\d+)$/i.exec(normalizeTraceAnswer(text) ?? "");
  return match ? Number(match[1]) : null;
}

// Absolute verdict: the agent's line against the harness walk. Self verdict: the
// hop re-evaluated through the ONE evaluator over the agent's OWN recorded
// predecessor, which separates "cannot do the derivation" from "lost the
// predecessor". INC self-evaluation reads the run's pinned worktree through the
// caller's includeTargets; a pruned run reports not-evaluated, never a guess.
export function traceStepVerdicts({ transcripts, plan, includeTargets = null }) {
  const delivery = auditDelivery(plan.stages);
  const linkOf = new Map();
  for (const chain of plan.chains) {
    for (const link of chain.links) linkOf.set(auditStepId(chain.id, link.index), link);
  }
  const chains = transcripts.map((chain) => {
    let integrityPrefix = 0;
    let integrityHeld = true;
    const steps = chain.steps.map((step, position) => {
      const link = linkOf.get(step.stepId);
      assertExperiment(link !== undefined, `Transcript step ${step.stepId} has no plan link`);
      const answersExpected = (expected) => (link.hop === "SOF"
        ? stageAnswerNumber(step.answerText) === expected
        : normalizeTraceAnswer(step.answerText) === expected);
      const verdictAbsolute = !step.parsed ? "unanswered"
        : answersExpected(link.expectedAnswer) ? "match" : "mismatch";
      if (integrityHeld && verdictAbsolute === "match") integrityPrefix += 1;
      else integrityHeld = false;
      let verdictSelf;
      if (!step.parsed) {
        verdictSelf = "unanswered";
      } else if (step.index === 1) {
        // The anchor is harness-given, so self and absolute coincide.
        verdictSelf = verdictAbsolute;
      } else {
        const previous = chain.steps[position - 1];
        const previousValue = !previous.parsed ? null
          : link.hop === "FIN" ? stageAnswerNumber(previous.answerText)
          : normalizeTraceAnswer(previous.answerText);
        if (previousValue === null || previousValue === "") {
          verdictSelf = "no-predecessor";
        } else if (link.hop === "INC" &&
          (typeof includeTargets !== "function" || includeTargets(previousValue) == null)) {
          verdictSelf = "not-evaluated";
        } else {
          let expectedFromSelf = null;
          try {
            expectedFromSelf = evaluateAuditHop({
              hop: link.hop, hopIndex: link.hopIndex, input: previousValue,
              delivery, includeTargets,
            });
          } catch {
            // The agent's predecessor admits no such hop (undelivered path, no
            // n-th file, no j-th include): nothing it answered can match.
            expectedFromSelf = null;
          }
          verdictSelf = expectedFromSelf !== null && answersExpected(expectedFromSelf)
            ? "match" : "mismatch";
        }
      }
      return { ...step, verdictAbsolute, verdictSelf };
    });
    return {
      chainId: chain.chainId,
      steps,
      compliance: { parsed: steps.filter((step) => step.parsed).length, total: steps.length },
      integrityPrefix,
    };
  });
  return {
    chains,
    stepCompliance: {
      parsed: chains.reduce((total, chain) => total + chain.compliance.parsed, 0),
      total: chains.reduce((total, chain) => total + chain.compliance.total, 0),
    },
  };
}

// Decision (Shane 2026-08-09): the headline verdict is mechanical exact match,
// with the blind LLM grader demoted to a second reader whose agreement rate is
// published. Echo probes are excluded here: their truth is per-run and graded
// separately as consistency with the agent's own earlier answer. Chain-link
// rows carry hop kind and lag (probe wave minus step stage) because the classes
// fail differently and must never be pooled.
export function probeMechanicalVerdicts({ plan, transcripts }) {
  const linkByProbe = new Map();
  for (const chain of plan.chains ?? []) {
    for (const link of chain.links) linkByProbe.set(`${chain.id}:${link.index}`, link);
  }
  const planProbes = new Map(plan.stages.flatMap((stage) =>
    stage.probes.map((probe) => [probe.id, probe])));
  const rows = [];
  for (const wave of transcripts) {
    for (const answer of wave.answers) {
      const probe = planProbes.get(answer.probeId);
      assertExperiment(probe !== undefined, `Transcript answer ${answer.probeId} has no plan probe`);
      if (probe.kind === "echo") continue;
      const link = probe.kind === "chain-link"
        ? linkByProbe.get(`${probe.chainId}:${probe.linkIndex}`) ?? null
        : null;
      const matches = link !== null && link.hop === "SOF"
        ? stageAnswerNumber(answer.answerText) === link.expectedAnswer
        : normalizeTraceAnswer(answer.answerText) === probe.expectedAnswer;
      rows.push({
        probeId: answer.probeId,
        kind: probe.kind,
        class: probeClassOf(probe.kind),
        wave: wave.stage,
        hop: link === null ? null : link.hop,
        lag: link === null ? null : wave.stage - link.stage,
        verdict: !answer.parsed ? "unanswered" : matches ? "match" : "mismatch",
      });
    }
  }
  return rows;
}

// Echo grading. echoConsistent is the recall metric: does the restated value
// equal the agent's OWN earlier answer, verbatim after the one normalizer.
// truthMatch is reported beside it and NEVER summed with it. The informative
// cell is consistent-and-wrong: reproducing your own error is unfakeable
// evidence of event recall, while inconsistent-but-right is re-derivation
// evidence. Consistency is a string comparison even for stage-valued targets:
// numeric equivalence would blur episodic recall into re-derivation.
// Unauthored (the target was never answered) and ambiguous (an answer that
// normalizes to nothing) are explicit non-scored outcomes.
export function echoVerdicts({ plan, transcripts }) {
  const planProbes = new Map(plan.stages.flatMap((stage) =>
    stage.probes.map((probe) => [probe.id, probe])));
  const linkByProbe = new Map();
  for (const chain of plan.chains ?? []) {
    for (const link of chain.links) linkByProbe.set(`${chain.id}:${link.index}`, link);
  }
  const answersById = new Map(transcripts.flatMap((wave) =>
    wave.answers.map((answer) => [answer.probeId, answer])));
  const rows = [];
  for (const wave of transcripts) {
    for (const answer of wave.answers) {
      const probe = planProbes.get(answer.probeId);
      assertExperiment(probe !== undefined, `Transcript answer ${answer.probeId} has no plan probe`);
      if (probe.kind !== "echo") continue;
      const target = planProbes.get(probe.targetProbeId);
      assertExperiment(target !== undefined && target.kind === "chain-link",
        `Echo ${probe.id} targets no chain-link probe`);
      const link = linkByProbe.get(`${target.chainId}:${target.linkIndex}`);
      const truthMatches = (text) => (link.hop === "SOF"
        ? /^(?:stage\s+)?0*(\d+)$/i.test(normalizeTraceAnswer(text) ?? "") &&
          Number(/0*(\d+)$/.exec(normalizeTraceAnswer(text))[1]) === link.expectedAnswer
        : normalizeTraceAnswer(text) === target.expectedAnswer);
      const prior = answersById.get(probe.targetProbeId) ?? null;
      const priorValue = prior !== null && prior.parsed
        ? normalizeTraceAnswer(prior.answerText) : null;
      const echoValue = answer.parsed ? normalizeTraceAnswer(answer.answerText) : null;
      const outcome = !answer.parsed ? "unanswered"
        : priorValue === null ? "unauthored"
        : priorValue === "" || echoValue === "" ? "ambiguous"
        : echoValue === priorValue ? "consistent" : "inconsistent";
      rows.push({
        probeId: probe.id,
        targetProbeId: probe.targetProbeId,
        wave: wave.stage,
        outcome,
        echoConsistent: outcome === "consistent",
        priorCorrect: priorValue !== null && truthMatches(prior.answerText),
        truthMatch: answer.parsed && truthMatches(answer.answerText),
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Provenance: offline, from sealed artifacts only. Where did each probe answer
// COME from? hoardCarry asks whether the answer rode the arm's compressed
// representation (fold briefs, compaction summaries) between its origin and the
// probe: both arms have one, so the comparison is symmetric and both rates get
// published. selfEcho asks whether the agent re-authored the answer in its own
// messages in between: note-taking is competent context management, detected,
// never forbidden, and out-of-echo recall is the headline. producedBy
// attributes only on deterministic links; everything else lands in an explicit
// unattributed count, reported, never distributed by guess. Result joins are by
// toolCallId, never by order or clock. Numeric answers are too common for
// verbatim scanning, so they are marked unscannable rather than guessed at.
// ---------------------------------------------------------------------------
const SCANNABLE_ANSWER = /^[A-Za-z0-9_./-]{6,}$/;
const DECLINED_ANSWER = /^(unknown|unsure|not\s+(sure|recorded|available|known)|n\/?a|none|cannot|can't|blank|-)\b/i;

function wholeWordIn(text, answer) {
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_./-])${escaped}(?![A-Za-z0-9_./-])`).test(text);
}

export function probeProvenance({ entries, plan, probes, steps }) {
  const carriers = [];
  entries.forEach((entry, index) => {
    if (entry?.type === "custom" && String(entry.customType ?? "").endsWith("-fold-record")) {
      const brief = entry.data?.fold?.brief;
      if (typeof brief === "string") carriers.push({ index, kind: "fold-brief", text: brief });
    } else if (entry?.type === "compaction" && typeof entry.summary === "string") {
      carriers.push({ index, kind: "compaction-summary", text: entry.summary });
    }
  });
  const resultByCallId = new Map();
  entries.forEach((entry) => {
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "toolResult") return;
    if (typeof message.toolCallId !== "string" || resultByCallId.has(message.toolCallId)) return;
    resultByCallId.set(message.toolCallId, {
      toolName: message.toolName,
      isError: message.isError === true,
      text: (message.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text).join("\n"),
    });
  });
  const planProbes = new Map(plan.stages.flatMap((stage) =>
    stage.probes.map((probe) => [probe.id, probe])));
  const chainById = new Map((plan.chains ?? []).map((chain) => [chain.id, chain]));
  const stepByStepId = new Map((steps ?? []).flatMap((chain) =>
    chain.steps.map((step) => [step.stepId, step])));
  const stageIndex = stageResultIndexByOrdinal(entries);
  const rows = [];
  const waves = [];
  for (const [position, wave] of probes.entries()) {
    if (!wave.delivered) continue;
    const nextWave = probes[position + 1];
    const windowEnd = wave.answerEntryIndex ?? nextWave?.resultEntryIndex ?? entries.length;
    const calls = [];
    for (let index = wave.resultEntryIndex + 1; index < windowEnd; index += 1) {
      const message = entries[index]?.message;
      if (entries[index]?.type !== "message" || message?.role !== "assistant") continue;
      for (const part of message.content ?? []) {
        if (part?.type !== "toolCall") continue;
        calls.push({ id: part.id, name: part.name, arguments: part.arguments ?? {} });
      }
    }
    const reads = calls.filter((call) => call.name === "read").map((call) => ({
      path: typeof call.arguments.path === "string" ? call.arguments.path : null,
      result: resultByCallId.get(call.id) ?? null,
    }));
    const contextCalls = calls.filter((call) => call.name !== "read" &&
      call.name !== EXPERIMENT_TOOL_NAME).map((call) => ({
      action: typeof call.arguments.action === "string" ? call.arguments.action : null,
      result: resultByCallId.get(call.id) ?? null,
    }));
    const readChars = reads.reduce((total, read) => total + (read.result?.text.length ?? 0), 0);
    let unattributed = 0;
    for (const answer of wave.answers) {
      const probe = planProbes.get(answer.probeId);
      assertExperiment(probe !== undefined, `Provenance answer ${answer.probeId} has no plan probe`);
      if (probe.kind === "echo") continue;
      const normalized = normalizeTraceAnswer(answer.answerText);
      const scannable = typeof probe.expectedAnswer === "string" &&
        SCANNABLE_ANSWER.test(probe.expectedAnswer) && /[A-Za-z]/.test(probe.expectedAnswer);
      // The origin is where the answer VALUE entered the transcript: the step's
      // recording message for chain-link, the carrier's stage result for
      // conversation probes. Repo-class answers never lived in the transcript.
      const origin = probe.kind === "chain-link"
        ? (stepByStepId.get(auditStepId(probe.chainId, probe.linkIndex))?.answerEntryIndex ??
          stageIndex.get(probe.sourceStage) ?? null)
        : CONVERSATION_PROBE_KINDS.includes(probe.kind)
          ? stageIndex.get(probe.sourceStage) ?? null
          : null;
      const scanEnd = wave.resultEntryIndex;
      const hoardCarry = !scannable || origin === null ? null
        : carriers.some((carrier) => carrier.index > origin && carrier.index < scanEnd &&
          wholeWordIn(carrier.text, probe.expectedAnswer));
      let selfEcho = null;
      if (scannable && origin !== null) {
        selfEcho = false;
        for (let index = origin + 1; index < scanEnd && !selfEcho; index += 1) {
          const message = entries[index]?.message;
          if (entries[index]?.type !== "message" || message?.role !== "assistant") continue;
          const text = (message.content ?? [])
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text).join("\n");
          if (text && wholeWordIn(text, probe.expectedAnswer)) selfEcho = true;
        }
      }
      const deterministicPaths = probe.kind === "chain-link"
        ? (() => {
          const chain = chainById.get(probe.chainId);
          const prefix = [chain.links[0].input];
          for (const link of chain.links.slice(0, probe.linkIndex)) {
            if (typeof link.expectedAnswer === "string") prefix.push(link.expectedAnswer);
          }
          return prefix;
        })()
        : probe.kind === "derivation-control" ? [probe.sourcePath] : [];
      let producedBy = null;
      if (answer.parsed) {
        if (DECLINED_ANSWER.test(answer.answerText ?? "")) producedBy = "declined";
        else if (scannable && contextCalls.some((call) =>
          call.result !== null && !call.result.isError && wholeWordIn(call.result.text, probe.expectedAnswer))) {
          producedBy = "recovered";
        } else if (deterministicPaths.length > 0 &&
          reads.some((read) => read.path !== null && deterministicPaths.includes(read.path))) {
          producedBy = "re-derived";
        } else if (reads.length === 0 && contextCalls.length === 0) {
          producedBy = "in-context";
        } else {
          producedBy = "unsupported";
          unattributed += 1;
        }
      }
      rows.push({
        probeId: probe.id,
        kind: probe.kind,
        class: probeClassOf(probe.kind),
        wave: wave.stage,
        scannable,
        hoardCarry,
        selfEcho,
        producedBy,
        normalizedAnswer: normalized,
      });
    }
    waves.push({
      stage: wave.stage,
      reads: reads.length,
      contextCalls: contextCalls.length,
      readChars,
      readTokensEstimated: Math.ceil(readChars / 4),
      unattributed,
    });
  }
  return { rows, waves, carriers: carriers.map(({ index, kind }) => ({ index, kind })) };
}

export function deliverableTranscripts({ entries, plan }) {
  const stageIndex = stageResultIndexByOrdinal(entries);
  const deliverableStages = plan.stages.filter((stage) => stage.deliverable);
  return deliverableStages.map((stage, position) => {
    const resultIndex = stageIndex.get(stage.ordinal);
    if (resultIndex === undefined) {
      return {
        id: stage.deliverable.id, stage: stage.ordinal, delivered: false, text: "",
        matchedHeading: false, messagesSkipped: 0,
      };
    }
    const nextDeliverableStage = deliverableStages[position + 1];
    const endIndex = (nextDeliverableStage === undefined
      ? undefined
      : stageIndex.get(nextDeliverableStage.ordinal)) ?? entries.length;
    const heading = deliverableHeadingPattern(stage.deliverable.id);
    // The heading always wins; a non-empty block is the fallback for a deliverable the
    // model wrote without titling it.
    const titled = scanAssistantMessages(entries, resultIndex + 1, endIndex,
      (text) => heading.test(text));
    const found = titled.index >= 0
      ? titled
      : scanAssistantMessages(entries, resultIndex + 1, endIndex, () => true);
    return {
      id: stage.deliverable.id,
      stage: stage.ordinal,
      delivered: true,
      text: found.text,
      matchedHeading: titled.index >= 0,
      messagesSkipped: found.index >= 0 ? found.skipped : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-request usage series and OBSERVED prefix invalidations.
//
// A mutation is defined against the PROVIDER's own accounting, not against any design's
// notion of what should have invalidated: a request whose cacheRead falls materially below
// the previous request's total input (cacheRead + inputFresh) re-paid for a prefix it had
// already paid for. interRequestWallMs sits beside it so a 0%-cached request can be
// attributed to a mutation rather than to provider cache TTL eviction (~5-10 minutes).
// ---------------------------------------------------------------------------
export const MUTATION_RELATIVE_TOLERANCE = 0.02;
export const MUTATION_ABSOLUTE_TOLERANCE_TOKENS = 1_024;

export function usageSeriesFromLedger(ledger) {
  assertExperiment(Array.isArray(ledger), "Usage series requires the provider ledger");
  const requestsByOrdinal = new Map(ledger
    .filter((record) => record?.kind === "provider-request")
    .map((record) => [record.ordinal, record]));
  const responses = ledger.filter((record) => record?.kind === "provider-response");
  const series = [];
  let previousTotalInput = null;
  let previousRequestWallMs = null;
  let mutations = 0;
  for (const response of responses) {
    const request = requestsByOrdinal.get(response.requestOrdinal) ?? null;
    const usage = response.usage && typeof response.usage === "object" ? response.usage : {};
    const inputFresh = Number.isFinite(usage.input) ? usage.input : 0;
    const cacheRead = Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
    const cacheWrite = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
    const output = Number.isFinite(usage.output) ? usage.output : 0;
    const totalInput = inputFresh + cacheRead;
    const requestWallMs = Number.isFinite(request?.wallMs) ? request.wallMs : null;
    const tolerance = previousTotalInput === null ? 0 : Math.max(
      MUTATION_ABSOLUTE_TOLERANCE_TOKENS, MUTATION_RELATIVE_TOLERANCE * previousTotalInput);
    const mutation = previousTotalInput !== null && cacheRead < previousTotalInput - tolerance;
    if (mutation) mutations += 1;
    series.push({
      ordinal: series.length + 1,
      inputFresh,
      cacheRead,
      cacheWrite,
      output,
      cacheShare: totalInput > 0 ? cacheRead / totalInput : null,
      interRequestWallMs: requestWallMs !== null && previousRequestWallMs !== null
        ? requestWallMs - previousRequestWallMs : null,
      mutation,
    });
    previousTotalInput = totalInput;
    if (requestWallMs !== null) previousRequestWallMs = requestWallMs;
  }
  const shares = series.map((entry) => entry.cacheShare).filter((value) => value !== null);
  const pooledCacheRead = series.reduce((total, entry) => total + entry.cacheRead, 0);
  const pooledInput = series.reduce((total, entry) => total + entry.cacheRead + entry.inputFresh, 0);
  return {
    series,
    mutations,
    mutationRule: {
      definition: "cacheRead < previousRequest(cacheRead + inputFresh) - tolerance",
      relativeTolerance: MUTATION_RELATIVE_TOLERANCE,
      absoluteToleranceTokens: MUTATION_ABSOLUTE_TOLERANCE_TOKENS,
      comparableRequests: Math.max(series.length - 1, 0),
    },
    meanCacheShare: shares.length > 0
      ? shares.reduce((total, value) => total + value, 0) / shares.length : null,
    // Token-weighted: the headline as-deployed observation. meanCacheShare stays beside it
    // because a per-request mean hides which requests carried the mass.
    pooledCacheShare: pooledInput > 0 ? pooledCacheRead / pooledInput : null,
  };
}

// The provider's second pricing tier. A request whose prompt passes this many tokens bills
// at a higher rate on every component. Pi's own recorded `usage.cost` ALREADY reflects it,
// so this constant exists to report EXPOSURE and never to compute money.
//
// It is the line the whole cost result used to turn on. luna-20260807 declared no serving
// budget: native drifted to 369,024 tokens and crossed on 17 of 117 calls for $20.99, while
// folding held pi-fold at 236,861 so it never left the base tier, at $13.89. Declaring a
// 251,520 budget and fencing native beneath it puts both arms under the line by
// construction, and sol-20260814-fenced-full rep 1 crossed it zero times on either arm.
// Neither configuration is wrong; reporting the crossings is what keeps them apart.
export const LONG_CONTEXT_TIER_PROMPT_TOKENS = 272_000;

const EMPTY_OUT_OF_BAND = Object.freeze({
  calls: 0, inputFresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
  totalTokens: 0, costUsd: 0,
});

function addUsage(into, usage, costUsd) {
  const read = (key) => (Number.isFinite(usage?.[key]) ? usage[key] : 0);
  return {
    calls: into.calls + 1,
    inputFresh: into.inputFresh + read("input"),
    cacheRead: into.cacheRead + read("cacheRead"),
    cacheWrite: into.cacheWrite + read("cacheWrite"),
    output: into.output + read("output"),
    reasoning: into.reasoning + read("reasoning"),
    totalTokens: into.totalTokens + read("totalTokens"),
    costUsd: into.costUsd + (Number.isFinite(costUsd) ? costUsd : 0),
  };
}

/**
 * WHAT A RUN SPENT WHERE ITS OWN PROVIDER LEDGER CANNOT SEE IT.
 *
 * Both arms call the provider outside the conversation, and neither call reaches
 * `before_provider_request`, so the ledger the usage totals are built from misses both.
 *
 *   - NATIVE'S COMPACTION summarizes the branch through its own request. Pi records the
 *     usage on the compaction ENTRY. Every compaction window in sol-20260814-fenced-full
 *     rep 1 held zero ledger records across 88 to 118 seconds: 5 calls, 75,375 fresh input,
 *     26,058 output, $1.16.
 *   - PI-FOLD'S BRIEF GENERATOR is the same shape one layer along, recorded on
 *     `context.brief`: 28 calls, 1,586,200 fresh input for 32,141 of output, $3.56, with
 *     cacheRead zero on every one because it runs a different model from the session it
 *     summarizes and so shares no prefix with it.
 *
 * Reporting one arm's hidden spend and not the other's is what would make the comparison
 * dishonest, so both are read from the same session file and returned under one shape. An
 * arm that makes neither kind of call reports zeros rather than nulls, because "none" is a
 * measurement here and absence would read as "not looked for".
 */
export function outOfBandUsage(entries) {
  assertExperiment(Array.isArray(entries), "Out-of-band usage requires the session entries");
  let compaction = { ...EMPTY_OUT_OF_BAND };
  let briefGenerator = { ...EMPTY_OUT_OF_BAND };
  for (const entry of entries) {
    if (entry?.type === "compaction") {
      compaction = addUsage(compaction, entry.usage, entry.usage?.cost?.total);
      continue;
    }
    const data = entry?.data;
    if (data?.kind !== "context.brief") continue;
    // A generator call that failed or timed out reports no usage and is still a call the
    // run made. Counting it keeps `calls` the number of times we asked, which is the
    // number the lane's own records can be joined against.
    briefGenerator = addUsage(briefGenerator, data.usage,
      data.usage?.costTotal ?? data.usage?.cost?.total);
  }
  const totals = ["inputFresh", "cacheRead", "cacheWrite", "output", "reasoning",
    "totalTokens", "costUsd", "calls"].reduce((into, key) => {
    into[key] = compaction[key] + briefGenerator[key];
    return into;
  }, {});
  return { compaction, briefGenerator, totals };
}

/**
 * WHAT PI BILLED, summed from the same records the tokens are summed from.
 *
 * Cost is read, never computed: Pi writes `usage.cost` on every provider response and on
 * every compaction entry, and those figures already carry the long-context tier. What is
 * computed here is only the EXPOSURE to that tier, the count of message calls whose prompt
 * passed it, because that count is what separates a run billed at one rate from a run
 * billed at two.
 */
export function billedCostFromLedger(ledger) {
  assertExperiment(Array.isArray(ledger), "Billed cost requires the provider ledger");
  const responses = ledger.filter((record) => record?.kind === "provider-response");
  let messageCallsUsd = 0;
  let longContextCalls = 0;
  let peakPromptTokens = 0;
  let callsWithoutCost = 0;
  for (const response of responses) {
    const usage = response.usage ?? {};
    const cost = usage.cost?.total;
    if (Number.isFinite(cost)) messageCallsUsd += cost; else callsWithoutCost += 1;
    const prompt = (Number.isFinite(usage.input) ? usage.input : 0) +
      (Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0);
    if (prompt > peakPromptTokens) peakPromptTokens = prompt;
    if (prompt > LONG_CONTEXT_TIER_PROMPT_TOKENS) longContextCalls += 1;
  }
  return {
    messageCalls: responses.length,
    messageCallsUsd,
    // Named rather than absorbed: a run whose provider stopped reporting cost would
    // otherwise read as a cheap run.
    callsWithoutCost,
    longContextCalls,
    longContextTierPromptTokens: LONG_CONTEXT_TIER_PROMPT_TOKENS,
    peakPromptTokens,
  };
}

/**
 * A REQUEST THAT WAS BUILT AND NEVER ANSWERED, which is a bound on a run's cost and not a
 * measurement of it.
 *
 * The fenced arm's compaction aborts the live turn, so the request in flight at each
 * crossing dies unanswered: 4 of them in sol-20260814-fenced-full rep 1, totalling
 * 3,825,542 projected chars. Whether the provider billed for those is not recoverable from
 * our artifacts, so they are reported as what they are and never folded into a total.
 */
export function unansweredRequestsFromLedger(ledger) {
  assertExperiment(Array.isArray(ledger), "Unanswered requests require the provider ledger");
  const answered = new Set(ledger
    .filter((record) => record?.kind === "provider-response")
    .map((record) => record.requestOrdinal));
  const orphans = ledger.filter((record) => record?.kind === "provider-request" &&
    !answered.has(record.ordinal));
  return {
    count: orphans.length,
    projectedChars: orphans.reduce((total, record) =>
      total + (Number.isFinite(record.payloadChars) ? record.payloadChars : 0), 0),
    billed: "unknown: a request aborted after it was built leaves no record of what the " +
      "provider charged for it",
  };
}

// ---------------------------------------------------------------------------
// Context event stream metrics: the runtime's own canonical record of what happened to the
// projection, read from the session's context-event customs. Two lenses, both deterministic
// from recorded bytes:
//   - mutation accounting: a mutation is a context.prefix record with change "rewrite". It
//     is STRUCTURAL when cause_event_seqs attributes it to a commit or fold, and a SURFACE
//     rewrite otherwise. Rep 17's wire rule inferred 60 mutations against 38 actual
//     commits; the stream does not have to infer.
//   - mechanism-limited counterfactual: the pooled cache share an ideally behaved
//     positional cache would have served. Ideal cached tokens per request are the shared
//     prefix with the previous projection: divergent_tokens where a divergence was
//     recorded, the full previous projection on an append.
// The wire series (usageSeriesFromLedger) stays beside this as the as-deployed
// observation; the gap between the two lenses belongs to the wire, not the mechanism.
// ---------------------------------------------------------------------------
export const CONTEXT_EVENT_SUFFIX = "context-event";

/**
 * THE SURFACING LENS. One row per suggestion issued, joined to the grade the runtime
 * gave it, so first-hop peek precision is derivable per arm rather than reconstructed
 * by hand after the run. memex's fold lane accepted at 2.2%, and that lane is the one
 * closest to this problem: it is the floor this design exists to beat, and it travels
 * with the number so nobody has to remember it.
 */
export const MEMEX_FOLD_LANE_ACCEPT_RATE = 0.022;

export function surfacingLens(events) {
  const suggestions = events.filter((event) => event.kind === "context.suggestion");
  const outcomes = events.filter((event) => event.kind === "context.outcome");
  const table = suggestions.map((suggestion, position) => {
    // The grade THIS offer earned: the LAST outcome for its fold before the same fold is
    // offered again. shown->acted->used is one offer walking to its terminal grade, so
    // taking the first transition would report every used suggestion as merely acted.
    const reoffered = suggestions.slice(position + 1)
      .find((later) => later.fold_id === suggestion.fold_id)?.seq ?? Infinity;
    const window = outcomes.filter((outcome) => outcome.fold_id === suggestion.fold_id &&
      outcome.seq > suggestion.seq && outcome.seq < reoffered);
    const graded = window.length ? window[window.length - 1] : null;
    return {
      seq: suggestion.seq,
      ordinal: Number.isFinite(suggestion.ordinal) ? suggestion.ordinal : null,
      carrier: typeof suggestion.carrier === "string" ? suggestion.carrier : null,
      foldId: typeof suggestion.fold_id === "string" ? suggestion.fold_id : null,
      contentScore: Number.isFinite(suggestion.content_score) ? suggestion.content_score : null,
      briefScore: Number.isFinite(suggestion.brief_score) ? suggestion.brief_score : null,
      margin: Number.isFinite(suggestion.margin) ? suggestion.margin : null,
      slot: Number.isFinite(suggestion.slot) ? suggestion.slot : null,
      considered: Number.isFinite(suggestion.considered) ? suggestion.considered : null,
      divergent: Number.isFinite(suggestion.divergent) ? suggestion.divergent : null,
      suppressed: Number.isFinite(suggestion.suppressed) ? suggestion.suppressed : null,
      chars: Number.isFinite(suggestion.chars) ? suggestion.chars : null,
      // "open" is a real state, not missing data: the run ended inside the window.
      outcome: graded ? graded.outcome ?? null : "open",
      outcomeOrdinal: graded && Number.isFinite(graded.outcome_ordinal) ? graded.outcome_ordinal : null,
    };
  });
  const count = (outcome) => table.filter((row) => row.outcome === outcome).length;
  const acted = count("acted");
  const used = count("used");
  const byCarrier = {};
  for (const row of table) {
    const bucket = byCarrier[row.carrier ?? "unknown"]
      ?? (byCarrier[row.carrier ?? "unknown"] = { issued: 0, acted: 0, used: 0, ignored: 0, chars: 0 });
    bucket.issued += 1;
    if (row.outcome === "acted" || row.outcome === "used") bucket.acted += 1;
    if (row.outcome === "used") bucket.used += 1;
    if (row.outcome === "ignored") bucket.ignored += 1;
    bucket.chars += row.chars ?? 0;
  }
  return {
    issued: suggestions.length,
    acted: acted + used,
    used,
    ignored: count("ignored"),
    open: count("open"),
    // A suggestion is one first hop offered; peeking or expanding the named fold inside
    // the window is that hop landing. This is the arm-(c) headline.
    firstHopPeekPrecision: suggestions.length > 0 ? (acted + used) / suggestions.length : null,
    usedRate: suggestions.length > 0 ? used / suggestions.length : null,
    memexFoldLaneAcceptRate: MEMEX_FOLD_LANE_ACCEPT_RATE,
    beatsMemexFoldLane: suggestions.length > 0
      ? (acted + used) / suggestions.length > MEMEX_FOLD_LANE_ACCEPT_RATE : null,
    suppressionTransitions: outcomes.length,
    byCarrier,
    table,
    definition: "one row per context.suggestion, joined to the LAST context.outcome for the " +
      "same fold_id before that fold is offered again; firstHopPeekPrecision is " +
      "acted-or-used over issued, and " +
      "\"open\" means the run ended before the outcome window closed",
  };
}

/**
 * THE ROLLBACK LENS. One row per overflow episode, so recovery frequency and recovery
 * COST read per arm rather than being reconstructed by hand after the run.
 *
 * Two records make one episode and they are joined by sequence, never by order or clock:
 * `context.rollback` is what left the branch, and `context.recovery` is what the retried
 * pass folded to make the shorter window fit. An episode with a rollback and no recovery
 * is not a bookkeeping gap: it is a retried request that never reached the projection
 * budget, and it is reported as such because that is the shape a lagging-fence abort
 * leaves behind.
 */
export function rollbackLens(events) {
  const rollbacks = events.filter((event) => event.kind === "context.rollback");
  const recoveries = events.filter((event) => event.kind === "context.recovery");
  const recoveryBySeq = new Map();
  for (const recovery of recoveries) {
    if (Number.isFinite(recovery.rollback_seq)) recoveryBySeq.set(recovery.rollback_seq, recovery);
  }
  const number = (value) => (Number.isFinite(value) ? value : 0);
  const table = rollbacks.map((rollback) => {
    const recovery = recoveryBySeq.get(rollback.seq) ?? null;
    return {
      seq: rollback.seq,
      ordinal: Number.isFinite(rollback.ordinal) ? rollback.ordinal : null,
      trigger: typeof rollback.trigger === "string" ? rollback.trigger : "unknown",
      armed: rollback.armed === true,
      disarmReason: typeof rollback.disarm_reason === "string" ? rollback.disarm_reason : null,
      entriesAbandoned: number(rollback.entries_abandoned),
      tokensRolledBack: number(rollback.tokens_rolled_back),
      occupancyTokensBefore: Number.isFinite(rollback.occupancy_tokens_before)
        ? rollback.occupancy_tokens_before : null,
      noticeChars: number(rollback.notice_chars),
      replayed: rollback.replayed === true,
      replaySkipReason: typeof rollback.replay_skip_reason === "string" ? rollback.replay_skip_reason : null,
      attemptOrdinal: Number.isFinite(rollback.attempt_ordinal) ? rollback.attempt_ordinal : null,
      // The fold-side half of the same episode.
      recoverySeq: recovery ? recovery.seq : null,
      recoveryAttempts: recovery ? number(recovery.attempts) : null,
      recoveredTokensBefore: recovery ? number(recovery.tokens_before) : null,
      recoveredTokensAfter: recovery ? number(recovery.tokens_after) : null,
      // What the episode actually took off the request the provider REFUSED, which is
      // the only baseline the recovered verdict is derived from. `tokens_before` is the
      // projection the recovery loop itself started from, and by then the ordinary
      // commit of the same pass has usually already run, so the loop-local delta reads
      // zero on episodes that genuinely rebuilt a smaller request.
      recoveredFreedTokens: recovery && Number.isFinite(recovery.freed_tokens)
        ? recovery.freed_tokens
        : null,
      rejectedTokens: recovery && Number.isFinite(recovery.rejected_tokens)
        ? recovery.rejected_tokens
        : null,
      recovered: recovery ? recovery.recovered === true : null,
    };
  });
  const armed = table.filter((row) => row.armed);
  const replayed = armed.filter((row) => row.replayed);
  const joined = table.filter((row) => row.recoverySeq !== null);
  const skipReasons = {};
  for (const row of table) {
    if (row.replayed) continue;
    const reason = row.replaySkipReason ?? (row.armed ? "unstated" : "lane-disarmed");
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }
  return {
    rollbacks: table.length,
    armed: armed.length,
    disarmed: table.length - armed.length,
    replayed: replayed.length,
    replayedShare: armed.length > 0 ? replayed.length / armed.length : null,
    replaySkipReasons: skipReasons,
    entriesAbandoned: table.reduce((total, row) => total + row.entriesAbandoned, 0),
    tokensRolledBack: table.reduce((total, row) => total + row.tokensRolledBack, 0),
    noticeChars: replayed.reduce((total, row) => total + row.noticeChars, 0),
    byTrigger: table.reduce((result, row) => {
      result[row.trigger] = (result[row.trigger] ?? 0) + 1;
      return result;
    }, {}),
    join: {
      joinKey: "rollback_seq",
      recoveryRecords: recoveries.length,
      joinedEpisodes: joined.length,
      rollbacksWithoutRecovery: table.length - joined.length,
      recoveriesWithoutRollback: recoveries.filter((recovery) =>
        !Number.isFinite(recovery.rollback_seq)).length,
    },
    // Recovery COST, which is what the frequency number is only half of. Read from the
    // episode's own freed count where the record carries one; older streams have only
    // the loop-local delta, which understates any episode the ordinary commit rescued.
    foldedTokensToRecover: joined.reduce((total, row) =>
      total + (row.recoveredFreedTokens === null
        ? Math.max(0, row.recoveredTokensBefore - row.recoveredTokensAfter)
        : Math.max(0, row.recoveredFreedTokens)), 0),
    unrecovered: joined.filter((row) => row.recovered === false).length,
    table,
    definition: "one row per context.rollback, joined to the context.recovery carrying the same " +
      "rollback_seq; noticeChars counts only replayed episodes because a skipped replay sends " +
      "its notice to the user rather than into the window, and rollbacksWithoutRecovery counts " +
      "retried requests that never reached the projection budget",
  };
}

/**
 * THE RECEIPT LENS: did every applied commit pay what it owed?
 *
 * `noteAutomaticReceipt` is the last statement of the rung application, reached after the
 * folds are emitted and before the state is persisted. A commit that announces applied
 * marks and delivers no receipt is therefore a commit that threw partway through: its
 * folds exist in the event stream and nowhere else, no fold record and no state entry
 * were written, and its marks went back to pending to be attempted and lost again.
 *
 * The window closes at the next projection, because a receipt belongs to the rung that
 * emitted it. Measured across all six sealed sol-20260812 runs, that window is never
 * tight: a healthy commit is followed by its receipt within ten to twenty-three events,
 * and no healthy commit has a projection between the two.
 *
 * The corroborating signature, recorded rather than asserted because it is a consequence
 * and not the rule: a lost commit's next projection reads exactly `applied_marks`
 * revisions below the commit. Rep 1 lost fourteen folds at revision 99 and read 85 next;
 * reps 3 and 4 lost eleven at 143 and 153 and read 132 and 142; rep 6 lost nine at 394
 * and read 385. Rep 1 matters most: it happened on a build with no announcement of any
 * kind, and nothing in that run's record named it until this lens was run against it.
 */
export function receiptLens(events) {
  const applied = [];
  const missing = [];
  for (let index = 0; index < events.length; index += 1) {
    const commit = events[index];
    if (commit.kind !== "context.commit" || commit.deferred || !(commit.applied_marks > 0)) continue;
    applied.push(commit);
    let paid = false;
    for (let ahead = index + 1; ahead < events.length; ahead += 1) {
      if (events[ahead].kind === "context.receipt") { paid = true; break; }
      if (events[ahead].kind === "context.projection") break;
    }
    if (paid) continue;
    const nextProjection = events.slice(index + 1).find((event) => event.kind === "context.projection");
    const nextProjectionRevision = Number.isFinite(nextProjection?.revision)
      ? nextProjection.revision
      : null;
    missing.push({
      seq: commit.seq,
      revision: Number.isFinite(commit.revision) ? commit.revision : null,
      appliedMarks: commit.applied_marks,
      trigger: typeof commit.trigger === "string" ? commit.trigger : "unknown",
      nextProjectionRevision,
      // True on every loss measured so far, and the reason the rollback is the whole
      // commit rather than part of it. Recorded, not required: a future loss that rolls
      // back differently is still a loss, and must not read as clean because it broke
      // the pattern.
      revisionsRolledBack: nextProjectionRevision === null || !Number.isFinite(commit.revision)
        ? null
        : commit.revision - nextProjectionRevision,
    });
  }
  return {
    appliedCommits: applied.length,
    receipts: events.filter((event) => event.kind === "context.receipt").length,
    commitsWithoutReceipt: missing.length,
    missing,
    definition: "one row per context.commit that applied at least one mark and was not deferred, " +
      "and for which no context.receipt appears before the next context.projection; the receipt " +
      "count is every receipt in the stream, which is larger than the commit count because the " +
      "overflow-recovery lane delivers its own",
  };
}

export const FOLD_RECORD_SUFFIX = "-fold-record";
export const STATE_ENTRY_SUFFIX = "-active-context-state";

/**
 * WHAT THE WALL CLOCK IS MEASURING BESIDE THE PROVIDER.
 *
 * A run's wall clock is not its provider latency. The runtime derives over the whole
 * session on every turn, so a session that grows faster than the work does buys wall time
 * that has nothing to do with folding, and comparing arms on the clock silently compares
 * their bookkeeping too.
 *
 * sol-20260812 rep 9 is the case that made this a lens rather than a note. Its pifold arm
 * wrote 309 active-context state entries totalling 21.6MB, 68.0% of a 31.9MB session,
 * against 0.93MB of projection actually sent to the provider, and held 98% of a core for
 * 118 minutes while the native arm spent 24 seconds of CPU. The cause was a state delta
 * that carried the whole brief map on every write; that is fixed, and every wall-clock
 * figure recorded before the fix measured it. This lens puts the same reading in the run
 * record so the next one is visible there rather than in a profiler six hours later.
 *
 * It reports rather than judges: there is no threshold here, because the honest bound is
 * the comparison between arms of the same run, and one arm has no state entries at all.
 */
export function sessionLedgerLens(entries, sessionBytes) {
  const states = entries.filter((entry) => entry?.type === "custom" &&
    typeof entry.customType === "string" && entry.customType.endsWith(STATE_ENTRY_SUFFIX));
  const sizes = states.map((entry) => JSON.stringify(entry).length);
  const stateBytes = sizes.reduce((total, size) => total + size, 0);
  const fields = {};
  for (const entry of states) {
    for (const [key, value] of Object.entries(entry.data ?? {})) {
      fields[key] = (fields[key] ?? 0) + JSON.stringify(value).length;
    }
  }
  return {
    sessionBytes,
    sessionEntries: entries.length,
    stateEntries: states.length,
    stateBytes,
    stateShareOfSession: sessionBytes > 0 ? stateBytes / sessionBytes : null,
    smallestStateEntryBytes: sizes.length ? Math.min(...sizes) : null,
    largestStateEntryBytes: sizes.length ? Math.max(...sizes) : null,
    stateBytesByField: Object.fromEntries(Object.entries(fields)
      .sort((left, right) => right[1] - left[1]).slice(0, 8)),
    definition: "the runtime's own durable state entries in the session file, measured " +
      "as written; wall clock is read against this because every turn derives over the " +
      "whole session and a growing ledger buys wall time no provider charged for",
  };
}

/**
 * THE BRIEF PROVENANCE LENS, read at the END of the run.
 *
 * A fold record is content-addressed and immutable, so it states the brief the fold was
 * CREATED with. That was the whole truth while a brief was written once. It is not any
 * more: a ladder fold commits with a deterministic brief and is upgraded to a model brief
 * at a later commit boundary, and the upgrade rides the `context.commit` record that
 * carried it rather than rewriting the fold record. Counting creation alone therefore
 * undercounts model briefs, to zero on a run where every ladder fold was later upgraded,
 * which is exactly the regime this campaign exists to measure.
 *
 * So the reading is a JOIN: fold records keyed by fold id, against the ids the commit
 * records name in `brief_upgrade_ids`. Any key other than `join` is a provenance kind.
 *
 * What the runtime guarantees: an upgrade applies only to a fold whose brief is still the
 * deterministic one and whose override slot is empty, the failed set blocks a retry, and
 * every applied upgrade is emitted on the commit record written in the same block. So a
 * fold is upgraded at most once and no applied upgrade is missing from the stream. The
 * lens does not lean on that: ids are deduplicated, and an id that matches no sealed
 * deterministic fold record moves nothing and is counted under its reason.
 *
 * What the runtime does not record, so this lens cannot show it: a finished brief whose
 * fold changed identity before the boundary is DROPPED silently, and the generator call it
 * spent leaves no trace. That gap does not bias the buckets, because a dropped upgrade
 * leaves the fold holding the deterministic brief its record already states.
 * `upgradesWaitingAtLastCommit` is the other half of the same gap, the work still owed
 * when the run ended, read off the last commit record that carries the field.
 *
 * One more brief mutation is NOT joined here and is stated rather than hidden: the agent's
 * own `rebrief` writes through the same override map, so a fold the agent rebriefed ends
 * the run with a supplied brief while its record still says how the fold was made. It is
 * left out because it is a different mutation with a different trace: no commit record
 * names it, and its fold id is in the tool-result payload rather than the event stream.
 * Neither sealed run in the campaign contains one.
 */
/**
 * What the brief generator was asked to do, and what it cost, from its own call records
 * (Shane 2026-08-11: how often did agents have to cure, on which kind of fold, and what
 * did the summarizer spend).
 *
 * Split by KIND because the two are different jobs: a consolidation reads a group of folds
 * opened one level down, an automatic fold reads raw evidence. A call can carry both, and
 * a mixed call's tokens are reported apart rather than divided by a rule nobody can check.
 * Usage is summed only where the provider reported it, and calls that reported none are
 * counted, because a call whose cost is unknown and a call that cost nothing are different
 * facts.
 */
function generatorCallRollup(custom) {
  const calls = custom
    .filter((entry) => entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data &&
      typeof entry.data === "object" && entry.data.kind === "context.brief")
    .map((entry) => entry.data);
  const bucket = () => ({
    calls: 0, spans: 0, sourceChars: 0, briefChars: 0, cures: 0, usage: {}, callsWithoutUsage: 0,
  });
  const buckets = { consolidation: bucket(), automatic: bucket(), mixed: bucket() };
  const outcomes = {};
  let spans = 0;
  let cures = 0;
  let curedSpans = 0;
  for (const call of calls) {
    outcomes[call.outcome ?? "unknown"] = (outcomes[call.outcome ?? "unknown"] ?? 0) + 1;
    const group = Number(call.group_spans) || 0;
    const leaf = Number(call.leaf_spans) || 0;
    const total = group + leaf;
    spans += total;
    if (call.cure === true) { cures += 1; curedSpans += total; }
    const into = group && leaf ? buckets.mixed : group ? buckets.consolidation : buckets.automatic;
    into.calls += 1;
    into.spans += total;
    into.sourceChars += Number(call.source_chars) || 0;
    into.briefChars += Number(call.brief_chars) || 0;
    if (call.cure === true) into.cures += 1;
    if (call.usage && typeof call.usage === "object") {
      for (const [field, value] of Object.entries(call.usage)) {
        if (Number.isFinite(value)) into.usage[field] = (into.usage[field] ?? 0) + value;
      }
    } else into.callsWithoutUsage += 1;
  }
  return {
    calls: calls.length,
    spans,
    // The whole point of batching, in one number: spans per call. A run that reads 1.0 here
    // is one where the lane never batched, whatever the code says.
    spansPerCall: calls.length ? Number((spans / calls.length).toFixed(2)) : null,
    outcomes,
    cures,
    curedSpans,
    cureRate: calls.length ? Number((cures / calls.length).toFixed(4)) : null,
    byKind: buckets,
    definition: "one record per generator call. `byKind` splits calls by whether every span " +
      "was a consolidation, every span an automatic fold, or the call carried both; a mixed " +
      "call's tokens are never divided between the two. `cures` counts second asks, which " +
      "is how often a brief missed the stated contract and was handed back with the complaint",
  };
}

export function endOfRunBriefProvenance(entries) {
  assertExperiment(Array.isArray(entries), "Brief provenance requires session entries");
  const custom = entries.filter((entry) => entry?.type === "custom" &&
    typeof entry.customType === "string");
  const foldRecords = custom.filter((entry) => entry.customType.endsWith(FOLD_RECORD_SUFFIX));
  const commits = custom
    .filter((entry) => entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data &&
      typeof entry.data === "object" && entry.data.kind === "context.commit")
    .map((entry) => entry.data);

  const upgraded = new Set();
  let repeatedUpgradeIds = 0;
  let upgradeFailures = 0;
  let upgradesWaitingAtLastCommit = null;
  for (const commit of commits) {
    const ids = typeof commit.brief_upgrade_ids === "string"
      ? commit.brief_upgrade_ids.split(",").filter(Boolean) : [];
    for (const id of ids) {
      if (upgraded.has(id)) { repeatedUpgradeIds += 1; continue; }
      upgraded.add(id);
    }
    if (Number.isFinite(commit.brief_upgrade_failures)) upgradeFailures += commit.brief_upgrade_failures;
    // Last one wins: a run that predates the lane carries the field on no commit record
    // and reports null, which is a different fact from nothing being owed.
    if (Number.isFinite(commit.brief_upgrades_waiting)) {
      upgradesWaitingAtLastCommit = commit.brief_upgrades_waiting;
    }
  }

  const counts = { model: 0, deterministic: 0 };
  const unmatchedReasons = {};
  let foldsUpgradedToModel = 0;
  for (const record of foldRecords) {
    const created = record.data?.fold?.provenance?.kind ?? "unknown";
    const foldId = record.data?.foldId;
    if (typeof foldId === "string" && upgraded.has(foldId)) {
      if (created === "deterministic") {
        foldsUpgradedToModel += 1;
        counts.model += 1;
        continue;
      }
      // The runtime never queues a fold that is not deterministic, so this is a defect
      // report, not a bucket: the fold is counted as the record states.
      unmatchedReasons["fold-not-deterministic-at-creation"] =
        (unmatchedReasons["fold-not-deterministic-at-creation"] ?? 0) + 1;
    }
    counts[created] = (counts[created] ?? 0) + 1;
  }
  const sealedFoldIds = new Set(foldRecords.map((record) => record.data?.foldId));
  const withoutRecord = [...upgraded].filter((id) => !sealedFoldIds.has(id)).length;
  if (withoutRecord > 0) unmatchedReasons["no-fold-record"] = withoutRecord;

  return {
    ...counts,
    generator: generatorCallRollup(custom),
    join: {
      joinKey: "fold_id",
      upgradedFolds: upgraded.size,
      foldsUpgradedToModel,
      unmatchedUpgrades: upgraded.size - foldsUpgradedToModel,
      unmatchedUpgradeReasons: unmatchedReasons,
      repeatedUpgradeIds,
      // Counted, never joined: the lane never retries a fold whose upgrade failed, so each
      // failure is a distinct fold, but the commit record carries the count and the last
      // error text without the ids. A failed fold keeps its deterministic brief and is
      // counted as deterministic above, so this number sits beside the buckets rather
      // than inside them.
      upgradeFailures,
      upgradesWaitingAtLastCommit,
      definition: "every key beside `join` is a brief provenance kind, counted per sealed " +
        "fold record and moved to model where a later context.commit record names that " +
        "fold id in brief_upgrade_ids; a run sealed before the upgrade lane carries no " +
        "such field and reads exactly as the creation-time count did",
    },
  };
}

export function contextEventMetrics(entries) {
  assertExperiment(Array.isArray(entries), "Context event metrics require session entries");
  const events = entries
    .filter((entry) => entry?.type === "custom" && typeof entry.customType === "string" &&
      entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data &&
      typeof entry.data === "object")
    .map((entry) => entry.data);
  const byKind = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  const prefixes = events.filter((event) => event.kind === "context.prefix");
  const commits = events.filter((event) => event.kind === "context.commit");

  // Tool usage, per action, from the runtime's own attempt records. The rep-23
  // finding (the agent never called the context tool at all) was discovered by hand
  // after the run; every question of that class must be a reported number here.
  const attempts = events.filter((event) => event.kind === "context.attempt");
  const protects = events.filter((event) => event.kind === "context.protect");
  const foldEvents = events.filter((event) => event.kind === "context.fold");
  const byActionUsage = {};
  for (const attempt of attempts) {
    const action = typeof attempt.action === "string" && attempt.action ? attempt.action : "unknown";
    const bucket = byActionUsage[action] ?? (byActionUsage[action] = {
      attempts: 0, accepted: 0, errors: 0, corrected: 0,
      marksRequested: 0, firstOrdinal: null, lastOrdinal: null,
    });
    bucket.attempts += 1;
    if (attempt.ok === true) bucket.accepted += 1;
    else bucket.errors += 1;
    if (Number(attempt.corrections_applied) > 0) bucket.corrected += 1;
    bucket.marksRequested += Number.isFinite(attempt.marks_requested) ? attempt.marks_requested : 0;
    if (Number.isFinite(attempt.ordinal)) {
      bucket.firstOrdinal = bucket.firstOrdinal === null
        ? attempt.ordinal : Math.min(bucket.firstOrdinal, attempt.ordinal);
      bucket.lastOrdinal = bucket.lastOrdinal === null
        ? attempt.ordinal : Math.max(bucket.lastOrdinal, attempt.ordinal);
    }
  }
  // Committed curation mass by origin. A share alone can rise because the denominator
  // fell, so the absolute masses always travel with it.
  let agentFoldedSourceChars = 0;
  let ladderFoldedSourceChars = 0;
  let agentFoldedCount = 0;
  for (const fold of foldEvents) {
    const chars = Number.isFinite(fold.source_chars) ? fold.source_chars : 0;
    if (fold.origin === "agent") { agentFoldedSourceChars += chars; agentFoldedCount += 1; }
    else ladderFoldedSourceChars += chars;
  }
  const lastCommit = commits.length ? commits[commits.length - 1] : null;

  let prefixRewrites = 0;
  let structuralRewrites = 0;
  let surfaceRewrites = 0;
  let idealCachedTokens = 0;
  let projectedTokens = 0;
  const byRequestClass = {};
  let previousTokens = null;
  for (const prefix of prefixes) {
    const estimated = Number.isFinite(prefix.estimated_tokens) ? prefix.estimated_tokens : 0;
    const cause = typeof prefix.cause === "string" ? prefix.cause : "";
    if (prefix.change === "rewrite") {
      prefixRewrites += 1;
      if (cause.includes("context.commit") || cause.includes("context.fold")) {
        structuralRewrites += 1;
      } else {
        surfaceRewrites += 1;
      }
    }
    const cached = previousTokens === null ? 0
      : Number.isFinite(prefix.divergent_tokens)
        ? Math.min(prefix.divergent_tokens, previousTokens)
        : previousTokens;
    idealCachedTokens += cached;
    projectedTokens += estimated;
    const requestClass = typeof prefix.request_class === "string"
      ? prefix.request_class : "unknown";
    const bucket = byRequestClass[requestClass]
      ?? (byRequestClass[requestClass] = { requests: 0, idealCachedTokens: 0, projectedTokens: 0 });
    bucket.requests += 1;
    bucket.idealCachedTokens += cached;
    bucket.projectedTokens += estimated;
    previousTokens = estimated;
  }
  for (const bucket of Object.values(byRequestClass)) {
    bucket.counterfactualCacheShare = bucket.projectedTokens > 0
      ? bucket.idealCachedTokens / bucket.projectedTokens : null;
  }

  // The B1 guidance-carrier lenses. Every carrier ships its event kind and its
  // adjudicator lens in the same build: the last-call exposure-to-response table,
  // the threshold-notice log, and the per-carrier byte overhead the 21.9% slate tax
  // is measured against.
  const lastCalls = events.filter((event) => event.kind === "context.lastcall");
  const responses = events.filter((event) => event.kind === "context.response");
  const notices = events.filter((event) => event.kind === "context.notice");
  const riders = events.filter((event) => event.kind === "context.rider");
  const responseByExposure = new Map(responses
    .filter((response) => Number.isFinite(response.exposure_seq))
    .map((response) => [response.exposure_seq, response]));
  const lastCallTable = lastCalls.map((exposure) => {
    const response = responseByExposure.get(exposure.seq) ?? null;
    const attemptsInRound = attempts.filter((attempt) =>
      attempt.seq > exposure.seq && (!response || attempt.seq < response.seq));
    return {
      exposureSeq: exposure.seq,
      ordinal: Number.isFinite(exposure.ordinal) ? exposure.ordinal : null,
      occupancy: Number.isFinite(exposure.occupancy) ? exposure.occupancy : null,
      maxTarget: Number.isFinite(exposure.max_target) ? exposure.max_target : null,
      pendingMarks: Number.isFinite(exposure.pending_marks) ? exposure.pending_marks : null,
      unmarkedStaleTokens: Number.isFinite(exposure.unmarked_stale_tokens)
        ? exposure.unmarked_stale_tokens : null,
      chars: Number.isFinite(exposure.chars) ? exposure.chars : null,
      outcome: response ? response.outcome ?? null : "open",
      commitSeq: response && Number.isFinite(response.commit_seq) ? response.commit_seq : null,
      contextCalls: response && Number.isFinite(response.context_calls) ? response.context_calls : null,
      marksAdded: response && Number.isFinite(response.marks_added) ? response.marks_added : null,
      protects: response && Number.isFinite(response.protects) ? response.protects : null,
      unprotects: response && Number.isFinite(response.unprotects) ? response.unprotects : null,
      attemptsInRound: attemptsInRound.length,
      attemptActionsInRound: attemptsInRound.reduce((result, attempt) => {
        const action = typeof attempt.action === "string" && attempt.action ? attempt.action : "unknown";
        result[action] = (result[action] ?? 0) + 1;
        return result;
      }, {}),
    };
  });
  const respondedExposures = lastCallTable.filter((row) => row.outcome === "responded").length;
  const carrierChars = (records) => records.reduce((sum, record) =>
    sum + (Number.isFinite(record.chars) ? record.chars : 0), 0);
  const guidanceCarriers = {
    lastCall: {
      exposures: lastCalls.length,
      responses: responses.length,
      responded: respondedExposures,
      silent: lastCallTable.filter((row) => row.outcome === "silent").length,
      lapsed: lastCallTable.filter((row) => row.outcome === "lapsed").length,
      open: lastCallTable.filter((row) => row.outcome === "open").length,
      responseRate: lastCalls.length > 0 ? respondedExposures / lastCalls.length : null,
      table: lastCallTable,
      definition: "one row per context.lastcall exposure, joined to its context.response by " +
        "exposure_seq; attemptsInRound counts context.attempt records between exposure and response",
    },
    notices: {
      delivered: notices.length,
      byShare: notices.reduce((result, notice) => {
        const share = Number.isFinite(notice.share) ? String(notice.share) : "unknown";
        result[share] = (result[share] ?? 0) + 1;
        return result;
      }, {}),
      chars: carrierChars(notices),
      definition: "context.notice records; a share appearing twice means a commit re-armed it " +
        "and the window crossed it again",
    },
    surfacing: surfacingLens(events),
    carrierBytes: {
      riderChars: carrierChars(riders),
      lastCallChars: carrierChars(lastCalls),
      noticeChars: carrierChars(notices),
      surfacingChars: carrierChars(events.filter((event) => event.kind === "context.suggestion")),
      totalChars: carrierChars(riders) + carrierChars(lastCalls) + carrierChars(notices),
      definition: "per-carrier byte overhead from each carrier event's own chars field; " +
        "the economics guardrail the 21.9% ephemeral-slate tax is measured against. " +
        "surfacingChars is counted separately and is ALREADY INSIDE riderChars and " +
        "lastCallChars, because the slate rides those carriers rather than one of its own",
    },
  };
  return {
    events: events.length,
    byKind,
    prefixEvents: prefixes.length,
    prefixRewrites,
    structuralRewrites,
    surfaceRewrites,
    mutationRule: {
      definition: "context.prefix change=rewrite; structural when cause_event_seqs names a commit or fold",
      comparableRequests: Math.max(prefixes.length - 1, 0),
    },
    commits: commits.filter((event) => event.deferred !== true).length,
    commitsDeferred: commits.filter((event) => event.deferred === true).length,
    rollback: rollbackLens(events),
    folds: byKind["context.fold"] ?? 0,
    toolUsage: {
      attempts: attempts.length,
      zeroContextCalls: attempts.length === 0,
      errors: attempts.filter((event) => event.ok !== true).length,
      corrected: attempts.filter((event) => Number(event.corrections_applied) > 0).length,
      byAction: byActionUsage,
      protectEvents: protects.length,
      protectNoops: protects.filter((event) =>
        event.protected_refs_after === event.protected_refs_before).length,
      definition: "attempts are the runtime's context.attempt records; zeroContextCalls is the " +
        "rep-23 flag; corrected counts attempts whose spans were auto-snapped; protectNoops " +
        "are pins that changed no refs",
    },
    curationMass: {
      committedFolds: foldEvents.length,
      agentFoldedCount,
      agentFoldedSourceChars,
      ladderFoldedSourceChars,
      agentMarkSourcedShare: agentFoldedSourceChars + ladderFoldedSourceChars > 0
        ? agentFoldedSourceChars / (agentFoldedSourceChars + ladderFoldedSourceChars)
        : null,
      pendingMarksAtLastCommit: lastCommit && Number.isFinite(lastCommit.pending_marks)
        ? lastCommit.pending_marks : null,
      definition: "mass is fold-event source_chars split by mark origin; the share is " +
        "agent-mark-sourced, not causal agent contribution, and always travels with its " +
        "numerator and denominator",
    },
    counterfactual: {
      definition: "ideal cached = shared prefix tokens with the previous projection: " +
        "divergent_tokens where recorded, the full previous projection on an append",
      idealCachedTokens,
      projectedTokens,
      pooledCacheShare: projectedTokens > 0 ? idealCachedTokens / projectedTokens : null,
      byRequestClass,
    },
    guidanceCarriers,
  };
}

// Stall proxy: the agent's own think time between stages. The supervisor's release gate
// delays RELEASE, never the model's next request, so this gap is the model's, not the
// harness's.
export function thinkTimeFromPace(paceRecords) {
  assertExperiment(Array.isArray(paceRecords), "Think time requires the pace ledger");
  const perStage = [];
  for (let index = 0; index + 1 < paceRecords.length; index += 1) {
    const released = paceRecords[index]?.releasedMonotonicMs;
    const requested = paceRecords[index + 1]?.requestedMonotonicMs;
    assertExperiment(Number.isFinite(released) && Number.isFinite(requested),
      `Pace ledger lacks monotonic clocks around stage ${paceRecords[index]?.stage}`);
    perStage.push({
      afterStage: paceRecords[index].stage ?? null,
      beforeStage: paceRecords[index + 1].stage ?? null,
      thinkMs: requested - released,
    });
  }
  const sorted = perStage.map((entry) => entry.thinkMs).sort((left, right) => left - right);
  const rank = (quantile) => sorted.length === 0
    ? null : sorted[Math.max(Math.ceil(quantile * sorted.length) - 1, 0)];
  return {
    definition: "pace[n+1].requestedMonotonicMs - pace[n].releasedMonotonicMs",
    samples: perStage.length,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    p95Ms: rank(0.95),
    medianMs: rank(0.5),
    perStage,
  };
}

// ---------------------------------------------------------------------------
// Blind grading. The grader sees submissions; it never sees an arm, a run id, a
// guidance profile, or a runtime configuration.
// ---------------------------------------------------------------------------
export const BLIND_FORBIDDEN_KEYS = Object.freeze([
  "arm", "runId", "guidance", "runtime", "manifest", "activeContextEnabled",
  "nativeCompactionEnabled", "campaignId", "runDir", "sessionFile",
  // Echo truth is per-run: any echo material would encode the run into the packet.
  "targetProbeId",
]);

export function submissionId(runId, salt) {
  assertExperiment(typeof runId === "string" && runId.length > 0, "Submission id requires a run id");
  assertExperiment(typeof salt === "string" && salt.length >= 16, "Submission id requires a campaign salt");
  return `sub-${sha256Text(`${salt}\u0000${runId}`).slice(0, 16)}`;
}

// Model-authored free text (deliverables, probe answers) is what the grader is FOR, so the
// arm-word scan cannot run over it: "native" and "pressure" are ordinary English and a
// session may legitimately use them. The scan therefore runs over the packet with those
// bodies elided, while the KEY scan runs over everything. Residual risk is stated openly:
// a session that narrates its own context management can self-identify, which is a property
// of the transcript, not of the packet builder, and is why arm identity also never appears
// in any structural field, id, ordering, or file name the grader receives.
export const BLIND_FREE_TEXT_KEYS = Object.freeze(["text", "answerText"]);

function elideFreeText(value) {
  if (Array.isArray(value)) return value.map(elideFreeText);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, BLIND_FREE_TEXT_KEYS.includes(key) ? "<free-text>" : elideFreeText(item)]));
}

export function assertBlindPacket(packet) {
  assertExperiment(packet && typeof packet === "object", "Blind packet must be an object");
  const serialized = JSON.stringify(elideFreeText(packet));
  for (const arm of EXPERIMENT_ARMS) {
    assertExperiment(!new RegExp(`\\b${arm}\\b`, "i").test(serialized),
      `Blind grading packet leaks the arm label ${arm}`);
  }
  for (const profile of EXPERIMENT_GUIDANCE_PROFILES) {
    assertExperiment(!new RegExp(`"guidance"|\\b${profile}\\b`, "i").test(serialized),
      `Blind grading packet leaks the guidance condition ${profile}`);
  }
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    assertExperiment(value.kind !== "echo",
      `Blind grading packet carries an echo probe at ${path}`);
    for (const key of Object.keys(value)) {
      assertExperiment(!BLIND_FORBIDDEN_KEYS.includes(key),
        `Blind grading packet carries the identifying key ${path}.${key}`);
      walk(value[key], `${path}.${key}`);
    }
  };
  walk(packet, "packet");
  return packet;
}

// What the provider's weather cost this run, kept beside the result rather than inside
// it. A recovered error changes nothing the trial measures (Pi re-sends the identical
// request and the failed attempt bills zero tokens), so it must not count against the
// arm; but a rep that stumbled forty times is a different quality of datum from one that
// never stumbled, and reading the same number from both would be the real dishonesty.
// Errors that were never survived do not appear here at all: those are latch entries.
export function providerWeather(workerEvents, providerLedger = []) {
  assertExperiment(Array.isArray(workerEvents), "Provider weather requires the worker event ledger");
  assertExperiment(Array.isArray(providerLedger), "Provider weather requires the provider ledger");
  const recovered = workerEvents.filter((row) => row?.kind === "provider-error-recovered");
  const observed = workerEvents.filter((row) => row?.kind === "non-terminal-provider-response");
  const attempts = recovered.reduce((total, row) => total + (Number(row.details?.attempts) || 0), 0);
  const recoveryMs = recovered.reduce((total, row) =>
    total + (Number(row.details?.recoveredAfterMs) || 0), 0);
  const worstRun = recovered.reduce((worst, row) =>
    Math.max(worst, Number(row.details?.attempts) || 0), 0);
  // What the weather cost the CACHE, which is the part that actually moves a headline.
  // The failed attempt bills nothing and the retried payload is byte identical, so the
  // model's input never changes; but the pinned transport rides WebSocket delta requests,
  // and a connection the error dropped re-sends the whole context cold. Observed on rep 4
  // of luna-20260810: three sequences came back with cacheRead at zero against a projection
  // whose char count had not moved, and one came back with its cache intact.
  //
  // Only an unchanged projection can be charged to weather. When the projection moved, a
  // fold rewrote the prefix and would have broken the cache by itself, which is the
  // experiment's own subject and must never be laundered into the weather column: those
  // are counted apart and attributed to neither.
  const responses = [];
  let projectedChars = null;
  for (const row of providerLedger) {
    if (row?.kind === "context-projection") projectedChars = row.projectedChars ?? null;
    if (row?.kind === "provider-response") {
      responses.push({
        stopReason: row.stopReason ?? null,
        cacheRead: Number(row.usage?.cacheRead) || 0,
        input: Number(row.usage?.input) || 0,
        projectedChars,
      });
    }
  }
  let coldRestarts = 0;
  let coldRestartFreshTokens = 0;
  let cacheSurvived = 0;
  let unattributable = 0;
  for (let index = 0; index < responses.length; index += 1) {
    if (responses[index].stopReason !== "error") continue;
    let after = index;
    while (after < responses.length && responses[after].stopReason === "error") after += 1;
    let before = index - 1;
    while (before >= 0 && responses[before].stopReason === "error") before -= 1;
    // The projection the LAST failed attempt carried: the retry re-sends that same request,
    // so this pair is the identical-payload check, not a comparison across the whole gap.
    const lastAttemptChars = responses[after - 1].projectedChars;
    index = after - 1;
    if (after >= responses.length || before < 0) continue;
    const unchanged = responses[after].projectedChars !== null &&
      responses[after].projectedChars === lastAttemptChars;
    if (responses[after].cacheRead === 0 && responses[before].cacheRead > 0) {
      if (unchanged) {
        coldRestarts += 1;
        coldRestartFreshTokens += responses[after].input;
      } else unattributable += 1;
    } else if (responses[after].cacheRead > 0) cacheSurvived += 1;
  }
  return {
    // Sequences the session came back from, and the failed attempts they cost.
    recoveredSequences: recovered.length,
    recoveredAttempts: attempts,
    // The longest single sequence: how close this run came to spending its whole budget.
    longestSequenceAttempts: worstRun,
    msSpentRecovering: recoveryMs,
    // Every non-terminal stop the run saw, recovered or not, so the two can be compared
    // without opening the latch: a gap between them is errors that were never survived.
    nonTerminalStops: observed.length,
    stages: recovered.map((row) => Number(row.details?.stage) || null),
    // Retries that reconnected cold, and the fresh tokens that would have been cache reads
    // had the weather held. Subtract these before reading a cache share as the arm's own.
    coldRestarts,
    coldRestartFreshTokens,
    cacheSurvivedRestarts: cacheSurvived,
    // A cache miss a fold could equally explain. Charged to neither column, on purpose.
    unattributableCacheMisses: unattributable,
  };
}
