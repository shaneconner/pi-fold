#!/usr/bin/env node

// Offline verification of the fold-vs-compaction harness contract. No provider calls, no
// live runs: this is the gate that must pass before the coordinator spends wall-clock on a
// smoke, and again before the full campaign. Soak-verifier style: every gate proves a
// specific failure is REJECTED, not merely that the happy path returns.
//
//   node scripts/verify_pi_context_experiment.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPERIMENT_ARMS,
  EXPERIMENT_DEFAULT_GUIDED_CURATION,
  EXPERIMENT_PROVIDER_INPUT_BUDGETS,
  EXPERIMENT_TRANSPORT,
  EXPERIMENT_TRANSPORTS,
  EXPERIMENT_DEFAULT_REPO,
  EXPERIMENT_FOLD_SCHEDULING,
  EXPERIMENT_GUIDANCE_PROFILES,
  PI_DEFAULT_COMPACTION_RESERVE_TOKENS,
  PROJECTION_FENCE_MARGIN_SHARE,
  compactionReserveTokens,
  compactionTriggerShare,
  EXPERIMENT_MODES,
  EXPERIMENT_MODE_PLANS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_PROVIDER_RETRY,
  EXPERIMENT_REPOS,
  EXPERIMENT_SCHEDULING_SOURCE,
  MUTATION_ABSOLUTE_TOLERANCE_TOKENS,
  PI_OUTPUT_BUDGET,
  servedOutputBudget,
  TOKEN_ESTIMATOR_ID,
  CODE_WORD_PATTERN,
  CONTEXT_EVENT_SUFFIX,
  CONVERSATION_PROBE_KINDS,
  FOLD_RECORD_SUFFIX,
  REPO_PROBE_KINDS,
  armRuntimeConfiguration,
  assertBlindPacket,
  buildConversationProbes,
  buildLedger,
  buildProbes,
  definitionSubject,
  codeWordSentence,
  codeWordReissueSentence,
  effectiveCodeWord,
  effectiveLedgerChecksum,
  endBlockPrompt,
  endBlockQuestions,
  endBlockVerdicts,
  EXPERIMENT_LEDGER_TOOL_NAME,
  LEDGER_TOKEN_PATTERN,
  LEDGER_UNKNOWN_VALUE,
  ledgerSentencesForStage,
  ledgerTaskSentence,
  ledgerTokensOf,
  plantedWordCollisions,
  reissueAnnouncedAt,
  stageCodeWordReissues,
  computeRereadTax,
  contextEventMetrics,
  MEMEX_FOLD_LANE_ACCEPT_RATE,
  corpusManifestSha256,
  deliverableTranscripts,
  endOfRunBriefProvenance,
  estimateTokens,
  extractDefinitions,
  fileFacts,
  isWindowOverflow,
  nativeCompactionDisposition,
  probeAnswerPattern,
  probeTranscripts,
  providerWeather,
  receiptLens,
  sessionLedgerLens,
  seededShuffle,
  stageCallDisposition,
  stageCodeWords,
  stagePayloadText,
  stagePlanForRun,
  stagePlanSha256,
  submissionId,
  thinkTimeFromPace,
  toolResultContentSha256,
  uniqueIdentifierIndex,
  usageSeriesFromLedger,
  outOfBandUsage,
  testAwarenessLeaks,
  EXPERIMENT_HISTORY_TOOL_NAME,
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_TOOL_NAME,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  billedCostFromLedger,
  unansweredRequestsFromLedger,
  LONG_CONTEXT_TIER_PROMPT_TOKENS,
  validateExperimentManifest,
  validateExperimentRunConfig,
  validateStagePlan,
  AUDIT_HOP_CYCLE,
  AUDIT_TRACE_IDS,
  DERIVED_PROBE_KINDS,
  HIDDEN_PROBE_KEYS,
  HIDDEN_TRACE_LINK_KEYS,
  auditStepId,
  auditStepSentence,
  buildAuditTraces,
  buildChainLinkProbes,
  buildDerivationControlProbes,
  buildEchoProbes,
  buildIncludeResolver,
  echoVerdicts,
  evaluateAuditHop,
  normalizeTraceAnswer,
  probeClassOf,
  probeMechanicalVerdicts,
  probeWaveRecovery,
  readEscapesCheckout,
  probeProvenance,
  quotedIncludeSpecs,
  traceStepTranscripts,
  traceStepVerdicts,
  visibleStage,
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_SESSION_TYPES,
  closedBookPrompt,
  closedBookQuestions,
  MATCHED_FENCE_OCCUPANCY_SHARE,
  MATCHED_FENCE_SHARES,
  matchedFenceShare,
  closedBookSystemPrompt,
  closedBookTranscript,
} from "./lib/pi_context_experiment.mjs";
import {
  PI_INSTALL_ROOT,
  directoryTreeSha256,
  sha256Json,
  sha256Text,
  verifySourceHashes,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relative) => readFileSync(join(PROJECT, relative), "utf8");
const checks = {};

// ---------------------------------------------------------------------------
// GATE 1 - arm contract
// ---------------------------------------------------------------------------
assert.deepEqual([...EXPERIMENT_ARMS], ["pifold", "native", "unmanaged", "nativefence"]);
// The pifold arm runs compaction ON: the runtime's overflow recovery lane arms off
// `session_before_compact`, so an arm with compaction off would be measuring a deployment
// nobody is asked to run.
assert.deepEqual(armRuntimeConfiguration("pifold"),
  { activeContextEnabled: true, nativeCompactionEnabled: true, toleratesOverflow: false });
assert.deepEqual(armRuntimeConfiguration("native"),
  { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false });
assert.deepEqual(armRuntimeConfiguration("unmanaged"),
  { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: true });
// THE MATCHED-TRIGGER ARM. Compaction ON because the harness invokes it; fold runtime OFF
// because a summary and a lossless fold are the two things this arm exists to tell apart.
// It is deliberately identical to `native` in configuration: what differs is that the
// harness fences it, and that difference lives in the extension rather than in a runtime
// option, so nothing experiment-only reaches the shipped package.
assert.deepEqual(armRuntimeConfiguration("nativefence"),
  { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false });
assert.deepEqual(armRuntimeConfiguration("nativefence"), armRuntimeConfiguration("native"));
// A COMPLETED COMPACTION IS THIS ARM'S DATUM, never its failure, and it stops the world
// exactly as `native` does. Deriving rather than restating it is the point: an arm added
// to the table gets its disposition from the same rule as every other.
assert.deepEqual(nativeCompactionDisposition("nativefence"),
  { latchOnPass: false, stopsTheWorld: true, latchOnCompletion: false });
// The share is a number the comparison rests on, so it is pinned rather than left to
// drift: it is the MEDIAN occupancy of sol-20260813-paired rep 1's seven fence commits
// (0.894, 0.942, 0.953, 0.913, 0.937, 0.911, 0.953), and it must sit inside that observed
// range or it is no longer the empirical match it claims to be.
assert.equal(MATCHED_FENCE_OCCUPANCY_SHARE, 0.937);
assert(MATCHED_FENCE_OCCUPANCY_SHARE > 0.894 && MATCHED_FENCE_OCCUPANCY_SHARE < 0.953,
  "The matched fence share left the range of crossings it was derived from");
assert.equal(matchedFenceShare("full"), MATCHED_FENCE_OCCUPANCY_SHARE);
assert.throws(() => matchedFenceShare("hybrid"), /Unknown mode/);
// EVERY MODE MUST BE ABLE TO REACH ITS OWN FENCE. The first matched-trigger smoke sealed
// green on both arms having never crossed once: eight stages peak near 0.20 occupancy
// against a 0.937 share, so the arm proved it could launch and never ran the mechanism it
// exists for. A share a mode cannot reach is an unreachable branch wearing a green tick.
//
// The bound is the mode's own accumulated payload, the same quantity gate 59 bounds the
// compaction trigger against: stages times the floor payload, at four chars per token,
// against the serving budget the fence is measured on.
// CROSSING IS NECESSARY AND NOT SUFFICIENT, which the first two smokes did not know.
// `prepareCompaction` cuts the branch at `keepRecentTokens` and returns undefined when
// nothing older than that cut is left to summarize, and `compact` disconnects the agent
// and aborts the live turn BEFORE it discovers that. A fence set under Pi's own floor
// therefore buys an aborted turn and no compaction at all: rep 3 of sol-20260814-matched
// crossed at 12,737 tokens against a 7,545 threshold and came straight back with "Nothing
// to compact (session too small)", one stage into an eight-stage run.
//
// Pi's floor is READ from Pi's source rather than restated here, on gate 52's rule: an
// upgrade that moves the number breaks this gate rather than silently unfencing a mode.
const piCompactionSource = readFileSync(
  join(PI_INSTALL_ROOT, "dist", "core", "compaction", "compaction.js"), "utf8");
const piKeepRecentTokens = Number(/keepRecentTokens:\s*(\d+)/.exec(piCompactionSource)?.[1]);
assert(Number.isSafeInteger(piKeepRecentTokens) && piKeepRecentTokens > 0,
  "Pi's compaction keep-recent floor could not be read, so no fence can be bounded against it");
// Enough has to lie on the far side of the cut that the summary is worth the turn it
// costs. A quarter of the kept window is the smallest slice that is plainly not noise.
const compactableFloorTokens = piKeepRecentTokens * 1.25;
for (const mode of EXPERIMENT_MODES) {
  const plan = EXPERIMENT_MODE_PLANS[mode];
  const share = matchedFenceShare(mode);
  assert(share > 0 && share < 1, `${mode} matched-fence share is not a share: ${share}`);
  // The floor binds every stage EXCEPT a probe (`stage.kind !== "probe"`), so a probe
  // stage guarantees nothing and counting it here would overstate what the mode is certain
  // to accumulate. The smoke's margin is narrow enough that the difference decides it.
  const payloadStages = plan.stageCount - plan.probeStages.length;
  const reachableTokens = (payloadStages * plan.payloadFloorChars) / 4;
  const budget = EXPERIMENT_PROVIDER_INPUT_BUDGETS["openai-codex/gpt-5.6-sol"];
  assert(share * budget < reachableTokens,
    `${mode} fences at ${Math.floor(share * budget)} tokens but its stages accumulate at ` +
    `most ${Math.floor(reachableTokens)}, so the fence can never be crossed in that mode`);
  assert(share * budget > compactableFloorTokens,
    `${mode} fences at ${Math.floor(share * budget)} tokens, inside Pi's own ` +
    `${piKeepRecentTokens}-token keep-recent window, so the crossing would abort the turn ` +
    "and then refuse to compact");
}
checks.everyModeCanReachItsMatchedFence = true;
assert.throws(() => armRuntimeConfiguration("hybrid"), /Unknown arm/);
checks.armContractExclusive = true;

// ---------------------------------------------------------------------------
// GATE 2 - mode plans; probe stages never collide with deliverable stages
// ---------------------------------------------------------------------------
for (const mode of EXPERIMENT_MODES) {
  const plan = EXPERIMENT_MODE_PLANS[mode];
  const deliverableStages = [];
  for (let ordinal = 1; ordinal <= plan.stageCount; ordinal += 1) {
    if (ordinal % plan.deliverableEvery === 0 && !plan.probeStages.includes(ordinal)) {
      deliverableStages.push(ordinal);
    }
  }
  assert(deliverableStages.length > 0, `${mode} mode plan yields no deliverable stage`);
  assert(plan.probeStages.length > 0, `${mode} mode plan yields no probe stage`);
  assert(plan.payloadFloorChars > 0 && plan.payloadTargetChars >= plan.payloadFloorChars);
  // One kind schedule per wave, each wave exactly one repo-class control, and the
  // conversation slots must be SATISFIABLE: carriers come from stages <= ceil(wave/2),
  // are never probe stages, and are never reused across the whole plan.
  assert.equal(plan.probeKinds.length, plan.probeStages.length,
    `${mode} probe kind schedule does not cover its waves`);
  const usedCarriers = new Set();
  for (const [waveIndex, ordinal] of plan.probeStages.entries()) {
    const kinds = plan.probeKinds[waveIndex];
    assert(kinds.every((kind) => kind === "repo" || kind === "echo" ||
      CONVERSATION_PROBE_KINDS.includes(kind) || DERIVED_PROBE_KINDS.includes(kind)),
    `${mode} wave ${ordinal} declares an unknown probe kind`);
    assert.equal(kinds.filter((kind) => kind === "repo").length, 1,
      `${mode} wave ${ordinal} must carry exactly one repo-class control`);
    // An echo restates an earlier wave's answer, so the first wave cannot carry
    // one; the derivation control calibrates the WHOLE run, so it sits last.
    if (waveIndex === 0) assert(!kinds.includes("echo"),
      `${mode} schedules an echo before any answer exists`);
    if (kinds.includes("derivation-control")) {
      assert.equal(waveIndex, plan.probeStages.length - 1,
        `${mode} schedules the derivation control before the last wave`);
    }
    const conversationSlots = kinds.filter((kind) => CONVERSATION_PROBE_KINDS.includes(kind)).length;
    const eligible = [];
    for (let stage = 1; stage <= Math.ceil(ordinal / 2); stage += 1) {
      if (!plan.probeStages.includes(stage) && !usedCarriers.has(stage)) eligible.push(stage);
    }
    assert(eligible.length >= conversationSlots,
      `${mode} wave ${ordinal} has ${eligible.length} unused carrier stages for ${conversationSlots} slots`);
    eligible.slice(0, conversationSlots).forEach((stage) => usedCarriers.add(stage));
  }
  const flatKinds = plan.probeKinds.flat();
  assert(CONVERSATION_PROBE_KINDS.every((kind) => flatKinds.includes(kind)),
    `${mode} never exercises every conversation probe kind`);
  assert(flatKinds.includes("chain-link") && flatKinds.includes("echo"),
    `${mode} never exercises the derived channel`);
}
// The declared full-mode totals are part of the instrument: one code word per
// wave stays as the hoarding ceiling, chain-link is the workhorse class.
{
  const totals = {};
  for (const kind of EXPERIMENT_MODE_PLANS.full.probeKinds.flat()) {
    totals[kind] = (totals[kind] ?? 0) + 1;
  }
  assert.deepEqual(totals, {
    "chain-link": 9, echo: 3, "stage-fact": 4, "stage-binding": 3,
    "derivation-control": 1, repo: 4,
  });
}
checks.modePlansProduceProbesAndDeliverables = true;
checks.probeKindSchedulesAreSatisfiable = true;

// ---------------------------------------------------------------------------
// GATE 3 - mechanical probe ground truth
// ---------------------------------------------------------------------------
const fixture = mkdtempSync(join(tmpdir(), "pi-context-experiment-fixture-"));
let plan;
try {
  const alpha = [
    "// alpha fixture",
    "pub struct AlphaConfig {",
    "    pub width: usize,",
    "}",
    "",
    "pub fn alpha_entry(config: AlphaConfig) -> usize {",
    "    config.width",
    "}",
  ].join("\n");
  const beta = [
    "// beta fixture",
    "pub trait BetaSink {",
    "    fn accept(&self, value: usize);",
    "}",
    "",
    "fn beta_only_helper(value: usize) -> usize {",
    "    value + 1",
    "}",
  ].join("\n");
  writeFileSync(join(fixture, "alpha.rs"), alpha);
  writeFileSync(join(fixture, "beta.rs"), beta);
  const definitions = extractDefinitions(alpha);
  assert.deepEqual(definitions, [
    { line: 2, identifier: "AlphaConfig", kind: "struct" },
    { line: 6, identifier: "alpha_entry", kind: "fn" },
  ]);
  // wc -l line semantics: newline-terminated and unterminated files agree, and the
  // retired split()-based count (which read one high on terminated files) stays dead.
  writeFileSync(join(fixture, "wc-terminated.txt"), "a\nb\n");
  writeFileSync(join(fixture, "wc-unterminated.txt"), "a\nb");
  writeFileSync(join(fixture, "wc-empty.txt"), "");
  assert.equal(fileFacts(fixture, join(fixture, "wc-terminated.txt")).lines, 2);
  assert.equal(fileFacts(fixture, join(fixture, "wc-unterminated.txt")).lines, 2);
  assert.equal(fileFacts(fixture, join(fixture, "wc-empty.txt")).lines, 0);
  const facts = ["alpha.rs", "beta.rs"].map((name) => fileFacts(fixture, join(fixture, name)));
  const unique = uniqueIdentifierIndex(facts);
  assert.equal(unique.get("beta_only_helper"), "beta.rs");
  const probes = buildProbes({ facts, seed: "fixture-seed", count: 3, uniqueIdentifiers: unique });
  assert.equal(probes.length, 3);
  // Repo probes are the two-kind control now: file-line-count is retired, and the
  // wave offset rotates which kind leads.
  assert.deepEqual(probes.map((probe) => probe.kind),
    ["definition-line", "symbol-file", "definition-line"]);
  assert.deepEqual(
    buildProbes({ facts, seed: "fixture-seed", count: 2, uniqueIdentifiers: unique, rotationOffset: 1 })
      .map((probe) => probe.kind),
    ["symbol-file", "definition-line"]);
  assert(probes.every((probe) => REPO_PROBE_KINDS.includes(probe.kind)));
  // A symbol-file question names the CONSTRUCT, not the bare identifier, so a
  // header declaring `struct X` and an implementation defining X-prefixed
  // functions stop being two defensible answers (Shane 2026-08-14).
  assert.equal(definitionSubject({ identifier: "gtls_shared_creds", kind: "struct" }),
    "struct gtls_shared_creds");
  assert.equal(definitionSubject({ identifier: "AlphaSink", kind: "trait" }), "trait AlphaSink");
  assert.equal(definitionSubject({ identifier: "alpha_entry", kind: "fn" }),
    "the function alpha_entry");
  assert.throws(() => definitionSubject({ identifier: "x" }), /identifier and a kind/);
  // Anti-vacuity: the qualifier must actually change the subject, or naming the
  // construct is decorative and the ambiguity survives.
  assert.notEqual(definitionSubject({ identifier: "gtls_shared_creds", kind: "struct" }),
    "gtls_shared_creds");
  for (const probe of probes.filter((candidate) => candidate.kind === "symbol-file")) {
    const fact = facts.find((candidate) => candidate.path === probe.sourcePath);
    const definition = fact.definitions.find((candidate) => candidate.line === probe.sourceLine);
    assert(definition, `symbol-file probe ${probe.id} points at no definition`);
    assert(probe.question.includes(`defines ${definitionSubject(definition)}?`),
      `symbol-file probe ${probe.id} did not name its construct: ${probe.question}`);
  }
  // Every answer is a fact of the pinned bytes, verified here against the file itself.
  for (const probe of probes) {
    const fact = facts.find((candidate) => candidate.path === probe.sourcePath);
    assert(fact, `probe ${probe.id} points at an unknown file`);
    if (probe.kind === "definition-line") {
      assert.equal(fact.text.split("\n")[probe.sourceLine - 1].includes(probe.expectedAnswer), true);
    } else {
      assert.equal(probe.expectedAnswer, fact.path);
    }
  }
  // Determinism: same seed, same probes; different seed, different probes.
  assert.deepEqual(buildProbes({ facts, seed: "fixture-seed", count: 3, uniqueIdentifiers: unique }), probes);
  // Seed sensitivity: over a set of seeds at least one plan must differ, or the seed is
  // decorative. (A two-file fixture can coincide on any single alternative seed.)
  const baseline = JSON.stringify(probes.map((probe) => probe.expectedAnswer));
  const seedVariants = ["seed-a", "seed-b", "seed-c", "seed-d"].map((seed) =>
    JSON.stringify(buildProbes({ facts, seed, count: 3, uniqueIdentifiers: unique })
      .map((probe) => probe.expectedAnswer)));
  assert(seedVariants.some((variant) => variant !== baseline),
    "probe construction ignores its seed");
  checks.probeGroundTruthMechanicalAndDeterministic = true;

  // Conversation-class machinery: code words are seeded, unique, well-formed, and the
  // carrier draw honours the eligibility window and the plan-wide no-reuse law.
  const words = stageCodeWords("code-word-seed", 64);
  assert.equal(words.length, 64);
  assert(words.every((word) => CODE_WORD_PATTERN.test(word)));
  assert.equal(new Set(words).size, words.length);
  assert.deepEqual(stageCodeWords("code-word-seed", 64), words);
  assert.notDeepEqual(stageCodeWords("other-seed", 64), words);
  assert.equal(codeWordSentence(7, words[6]),
    `Audit note: the code word for stage 07 is ${words[6]}.`);
  const carrierStages = [
    { ordinal: 1, kind: "read", codeWord: words[0], files: [{ path: "one.rs" }] },
    { ordinal: 2, kind: "read", codeWord: words[1], files: [{ path: "two.rs" }, { path: "extra.rs" }] },
    { ordinal: 3, kind: "revisit", codeWord: words[2], files: [{ path: "three.rs" }] },
    { ordinal: 4, kind: "probe", codeWord: null, files: [] },
  ];
  const usedStages = new Set();
  const waveOne = buildConversationProbes({
    stages: carrierStages, probeOrdinal: 4, seed: "wave-one", kinds: ["stage-fact"], usedStages,
  });
  assert.equal(waveOne.length, 1);
  assert.equal(waveOne[0].kind, "stage-fact");
  assert([1, 2].includes(waveOne[0].sourceStage), "wave-one carrier must be an early stage");
  assert.equal(waveOne[0].expectedAnswer, carrierStages[waveOne[0].sourceStage - 1].codeWord);
  assert(usedStages.has(waveOne[0].sourceStage));
  const waveTwo = buildConversationProbes({
    stages: carrierStages, probeOrdinal: 8, seed: "wave-two", kinds: ["stage-binding"], usedStages,
  });
  assert.equal(waveTwo[0].kind, "stage-binding");
  assert.notEqual(waveTwo[0].sourceStage, waveOne[0].sourceStage, "carriers must never be reused");
  assert.equal(waveTwo[0].expectedAnswer, carrierStages[waveTwo[0].sourceStage - 1].files[0].path);
  // Exhaustion refuses instead of degrading: no silent second probe against a carrier.
  assert.throws(() => buildConversationProbes({
    stages: carrierStages, probeOrdinal: 8, seed: "wave-three",
    kinds: ["stage-fact", "stage-binding"], usedStages,
  }), /unused carrier stages/);
  // Determinism from a clean slate.
  assert.deepEqual(buildConversationProbes({
    stages: carrierStages, probeOrdinal: 4, seed: "wave-one", kinds: ["stage-fact"], usedStages: new Set(),
  }), waveOne);
  checks.conversationProbesSeededCarriersNeverReused = true;

  // -------------------------------------------------------------------------
  // GATE 4 - stage plan hashing + ground-truth containment
  // -------------------------------------------------------------------------
  const modePlan = EXPERIMENT_MODE_PLANS.smoke;
  const bulk = `x${"y".repeat(modePlan.payloadFloorChars + 1_000)}`;
  writeFileSync(join(fixture, "bulk-a.rs"), bulk);
  writeFileSync(join(fixture, "bulk-b.rs"), `${bulk}z`);
  const bulkFacts = ["bulk-a.rs", "bulk-b.rs"].map((name) => fileFacts(fixture, join(fixture, name)));
  const fixtureWord = (ordinal) => `cw-${String(ordinal).padStart(6, "0")}`;
  // The seeded ledger every v4 plan carries. The fixture derives its own from a
  // fixture seed exactly as the stager derives the real one from the frozen
  // seed, so the validator's re-derivation law is exercised, not bypassed.
  const fixtureLedger = buildLedger({ mode: "smoke", contentSeed: "aabbccdd00112233" });
  const stageOf = (ordinal, kind, files, stageProbes, deliverable, chainStep = null,
    codeWordReissue = null) => {
    const codeWord = kind === "probe" ? null : fixtureWord(ordinal);
    // Weave order mirrors the stager: base, then the audit step, then the
    // ledger block, code word LAST, then any withdrawal of an earlier stage's word.
    let instructions = `stage ${ordinal} instructions`;
    if (chainStep !== null) instructions = `${instructions} ${auditStepSentence(chainStep)}`;
    for (const sentence of ledgerSentencesForStage(fixtureLedger, ordinal)) {
      instructions = `${instructions} ${sentence}`;
    }
    if (codeWord !== null) instructions = `${instructions} ${codeWordSentence(ordinal, codeWord)}`;
    if (codeWordReissue !== null) {
      instructions = `${instructions} ` +
        `${codeWordReissueSentence(codeWordReissue.stage, codeWordReissue.codeWord)}`;
    }
    const stage = {
      ordinal,
      kind,
      instructions,
      codeWord,
      codeWordReissue,
      chainStep,
      files: files.map((fact) => ({
        path: fact.path, sha256: fact.sha256, lines: fact.lines, chars: fact.chars, bytes: fact.bytes,
      })),
      probes: stageProbes,
      deliverable,
      payloadChars: 0,
      payloadSha256: "0".repeat(64),
    };
    const payload = stagePayloadText({
      ...visibleStage(stage),
      files: files.map((fact) => ({ ...fact })),
    });
    stage.payloadChars = payload.length;
    stage.payloadSha256 = sha256Text(payload);
    return stage;
  };
  // The smoke chain: SOF anchors on stage 1's first file, FIN takes its second,
  // INC lands on a later delivery. Steps sit at stages 2, 3 and 5.
  const fixtureChain = {
    id: "trace-a",
    links: [
      { index: 1, stage: 2, hop: "SOF", hopIndex: null, input: "stage-1.rs", expectedAnswer: 1 },
      { index: 2, stage: 3, hop: "FIN", hopIndex: 2, input: 1, expectedAnswer: "stage-1-extra.rs" },
      { index: 3, stage: 5, hop: "INC", hopIndex: 1, input: "stage-1-extra.rs", expectedAnswer: "stage-2.rs" },
    ],
  };
  const fixtureStepOf = (link) => ({
    id: auditStepId(fixtureChain.id, link.index),
    chainId: fixtureChain.id,
    index: link.index,
    hop: link.hop,
    hopIndex: link.hopIndex,
    anchor: link.index === 1 ? link.input : null,
  });
  const fixtureStepByStage = new Map(fixtureChain.links.map((link) => [link.stage, fixtureStepOf(link)]));
  // Smoke waves follow the mode plan schedule: [chain-link, stage-fact, repo] at
  // 4, [chain-link, echo, stage-binding, repo] at 8. Probes are hand-built
  // against known carriers and links so every cross-check is explicit.
  const waveProbes = {
    4: [
      {
        id: "probe-04-01",
        kind: "chain-link",
        question: "The dependency appendix lists each audit trace in order and its " +
          "trace-a step 01 row is blank. What value did you record for trace-a-01? " +
          "Answer with the stage number only.",
        expectedAnswer: "1",
        chainId: "trace-a",
        linkIndex: 1,
        sourceStage: 2,
      },
      {
        id: "probe-04-02",
        kind: "stage-fact",
        question: "What was the audit code word given in stage 01's instructions? " +
          "Answer with the code word only.",
        expectedAnswer: fixtureWord(1),
        sourceStage: 1,
      },
      { ...probes[0], id: "probe-04-03" },
    ],
    8: [
      {
        id: "probe-08-01",
        kind: "chain-link",
        question: "The dependency appendix lists each audit trace in order and its " +
          "trace-a step 02 row is blank. What value did you record for trace-a-02? " +
          "Answer with the repository-relative path only.",
        expectedAnswer: "stage-1-extra.rs",
        chainId: "trace-a",
        linkIndex: 2,
        sourceStage: 3,
      },
      {
        id: "probe-08-02",
        kind: "echo",
        question: "Audit trail: restate the answer you gave for probe-04-01, exactly " +
          "as you gave it. Answer with that value only.",
        targetProbeId: "probe-04-01",
      },
      {
        id: "probe-08-03",
        kind: "stage-binding",
        question: "Which repository-relative file was the FIRST file delivered in stage 03? " +
          "Answer with the path only.",
        expectedAnswer: "stage-3.rs",
        sourceStage: 3,
      },
      { ...probes[1], id: "probe-08-04" },
    ],
  };
  const repo = EXPERIMENT_REPOS[EXPERIMENT_DEFAULT_REPO];
  plan = {
    version: EXPERIMENT_PROTOCOL_VERSION,
    mode: "smoke",
    repo: {
      key: repo.key, url: repo.url, commit: repo.commit, license: repo.license,
      language: repo.language, treeSha256: corpusManifestSha256(bulkFacts),
    },
    seed: "0011223344556677",
    stageCount: modePlan.stageCount,
    stageIntervalMs: modePlan.stageIntervalMs,
    watchdogMs: modePlan.watchdogMs,
    heartbeatMs: modePlan.heartbeatMs,
    corpus: { files: 2, eligibleFiles: 2, lines: 2, chars: bulk.length * 2 },
    stages: Array.from({ length: modePlan.stageCount }, (_, index) => {
      const ordinal = index + 1;
      if (modePlan.probeStages.includes(ordinal)) {
        return stageOf(ordinal, "probe", [], waveProbes[ordinal], null);
      }
      const files = [{ ...bulkFacts[ordinal % 2], path: `stage-${ordinal}.rs` }];
      // Stage 1 delivers a second file so the chain's FIN hop has a target that
      // is not its own anchor.
      if (ordinal === 1) files.push({ ...bulkFacts[0], path: "stage-1-extra.rs" });
      const deliverable = ordinal % modePlan.deliverableEvery === 0
        ? { id: `deliverable-${ordinal}`, instructions: "write it", referencesStages: [1] }
        : null;
      return stageOf(ordinal, ordinal % modePlan.revisitEvery === 0 ? "revisit" : "read", files, [], deliverable,
        fixtureStepByStage.get(ordinal) ?? null);
    }),
    chains: [fixtureChain],
    ledger: fixtureLedger,
    probeCount: 0,
    deliverableCount: 0,
    planSha256: "0".repeat(64),
  };
  plan.probeCount = plan.stages.reduce((total, stage) => total + stage.probes.length, 0);
  plan.deliverableCount = plan.stages.filter((stage) => stage.deliverable).length;
  plan.planSha256 = stagePlanSha256(plan);
  validateStagePlan(plan);
  // The hash covers the body: any edit invalidates it, and re-hashing is idempotent.
  assert.equal(stagePlanSha256({ ...plan, planSha256: "f".repeat(64) }), plan.planSha256);
  const tampered = structuredClone(plan);
  tampered.stages[0].instructions += " (edited)";
  assert.throws(() => validateStagePlan(tampered), /hash does not cover/);
  const unpinned = structuredClone(plan);
  unpinned.repo.commit = "a".repeat(40);
  unpinned.planSha256 = stagePlanSha256(unpinned);
  assert.throws(() => validateStagePlan(unpinned), /repo pin is invalid/);
  const duplicated = structuredClone(plan);
  duplicated.stages[2].payloadSha256 = duplicated.stages[1].payloadSha256;
  duplicated.planSha256 = stagePlanSha256(duplicated);
  assert.throws(() => validateStagePlan(duplicated), /repeats a payload/);
  checks.stagePlanHashingCoversBodyAndRejectsTamper = true;
  checks.harnessPayloadsUniqueSoRereadTaxIsModelOnly = true;

  // The conversation-probe laws each refuse: a code word on a probe stage, a second
  // probe against one carrier, ground truth disagreeing with its carrier, and a
  // probe id repeated across waves (grading joins by id).
  const wordedProbe = structuredClone(plan);
  wordedProbe.stages[3].codeWord = "cw-00dead";
  wordedProbe.planSha256 = stagePlanSha256(wordedProbe);
  assert.throws(() => validateStagePlan(wordedProbe), /carries a code word/);
  const rewovenWord = structuredClone(plan);
  rewovenWord.stages[1].codeWord = rewovenWord.stages[0].codeWord;
  rewovenWord.planSha256 = stagePlanSha256(rewovenWord);
  assert.throws(() => validateStagePlan(rewovenWord), /missing, malformed, unwoven, or repeated/);
  const reusedCarrier = structuredClone(plan);
  reusedCarrier.stages[7].probes[2].sourceStage = 1;
  reusedCarrier.stages[7].probes[2].expectedAnswer = "stage-1.rs";
  reusedCarrier.planSha256 = stagePlanSha256(reusedCarrier);
  assert.throws(() => validateStagePlan(reusedCarrier), /probed twice/);
  const liedFact = structuredClone(plan);
  liedFact.stages[3].probes[1].expectedAnswer = "cw-00beef";
  liedFact.planSha256 = stagePlanSha256(liedFact);
  assert.throws(() => validateStagePlan(liedFact), /disagrees with carrier/);
  const reusedId = structuredClone(plan);
  reusedId.stages[7].probes[1].id = "probe-04-02";
  reusedId.planSha256 = stagePlanSha256(reusedId);
  assert.throws(() => validateStagePlan(reusedId), /repeats a probe id/);
  checks.conversationProbeLawsRejectTamper = true;

  const runPlan = stagePlanForRun(plan);
  const runSerialized = JSON.stringify(runPlan);
  for (const probe of probes) {
    assert(!runSerialized.includes(probe.expectedAnswer) || probe.kind === "symbol-file",
      "run-visible plan leaked a probe answer");
  }
  assert(runPlan.stages.every((stage) => stage.probes.every((probe) =>
    !Object.hasOwn(probe, "expectedAnswer") && !Object.hasOwn(probe, "sourceLine") &&
    !Object.hasOwn(probe, "sourceStage"))),
  "run-visible plan retained probe ground truth");
  assert(runPlan.chains.every((chain) => chain.links.every((link) =>
    HIDDEN_TRACE_LINK_KEYS.every((key) => !Object.hasOwn(link, key)))),
  "run-visible plan retained chain ground truth");
  // The stage-fact channel leaks its answer by DESIGN, in exactly one place: the
  // carrier's own instructions. Anywhere else and the probe stops measuring recall.
  for (const probe of plan.stages.flatMap((stage) => stage.probes)) {
    if (probe.kind !== "stage-fact") continue;
    const appearances = runPlan.stages.filter((stage) =>
      stage.instructions.includes(probe.expectedAnswer));
    assert.equal(appearances.length, 1, "stage-fact code word must appear exactly once");
    assert.equal(appearances[0].ordinal, probe.sourceStage,
      "stage-fact code word must appear in its carrier stage only");
  }
  assert.throws(() => stagePayloadText(plan.stages.find((stage) => stage.probes.length > 0)),
    /still carries probe ground truth/);
  checks.probeAnswersNeverReachTheSession = true;
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GATE 5 - manifest pinning
// ---------------------------------------------------------------------------
const repo = EXPERIMENT_REPOS[EXPERIMENT_DEFAULT_REPO];
const manifest = {
  version: EXPERIMENT_PROTOCOL_VERSION,
  runId: "2026-08-05T00-00-00Z-pifold-rep1-abcd1234",
  campaignId: "campaign-1",
  arm: "pifold",
  mode: "smoke",
  guidance: "pressure",
  ordinal: 1,
  repetition: 1,
  seed: "0011223344556677",
  model: {
    provider: "openai-codex", id: "gpt-5.6-sol", effort: "xhigh",
    contextWindow: 272_000, maxTokens: 4_096, descriptorSha256: "a".repeat(64),
  },
  runtime: {
    codeCommit: "b".repeat(40),
    codeTree: "c".repeat(40),
    piVersion: "0.83.0",
    sourceHashes: { "scripts/lib/pi_context_experiment.mjs": "d".repeat(64) },
    dependencyHashes: { piPackageJson: "e".repeat(64) },
    activeContextEnabled: true,
    nativeCompactionEnabled: true,
  },
  target: {
    repoKey: repo.key, url: repo.url, commit: repo.commit,
    treeSha256: "1".repeat(64), checkoutSha256: "1".repeat(64),
  },
  plan: {
    planSha256: "2".repeat(64),
    stageCount: EXPERIMENT_MODE_PLANS.smoke.stageCount,
    probeCount: 6,
    deliverableCount: 2,
  },
  pacing: {
    stageIntervalMs: EXPERIMENT_MODE_PLANS.smoke.stageIntervalMs,
    watchdogMs: EXPERIMENT_MODE_PLANS.smoke.watchdogMs,
    heartbeatMs: EXPERIMENT_MODE_PLANS.smoke.heartbeatMs,
  },
  endBlockSha256: "4".repeat(64),
  createdWallMs: 1_800_000_000_000,
};
validateExperimentManifest(manifest);
assert.throws(() => validateExperimentManifest({
  ...manifest, runtime: { ...manifest.runtime, nativeCompactionEnabled: false },
}), /contradicts arm pifold/);
assert.throws(() => validateExperimentManifest({
  ...manifest, arm: "native",
}), /contradicts arm native/);
assert.throws(() => validateExperimentManifest({
  ...manifest, model: { ...manifest.model, effort: "" },
}), /provider, model id and effort/);
assert.throws(() => validateExperimentManifest({
  ...manifest, target: { ...manifest.target, commit: "9".repeat(40) },
}), /target-repo pin/);
assert.throws(() => validateExperimentManifest({
  ...manifest, guidance: "aggressive",
}), /guidance profile/);
assert.throws(() => validateExperimentManifest({
  ...manifest, pacing: { ...manifest.pacing, watchdogMs: 1 },
}), /pacing drifted/);
for (const arm of EXPERIMENT_ARMS) {
  const runtime = armRuntimeConfiguration(arm);
  validateExperimentManifest({
    ...manifest,
    arm,
    runtime: {
      ...manifest.runtime,
      activeContextEnabled: runtime.activeContextEnabled,
      nativeCompactionEnabled: runtime.nativeCompactionEnabled,
    },
  });
}
checks.manifestPinsArmModelRuntimeTargetAndPlan = true;

const runConfig = {
  version: EXPERIMENT_PROTOCOL_VERSION,
  runId: "run-1",
  runDir: "/nonexistent/pi-fold-runs/state/ops/pi-context-experiment/c1/runs/run-1",
  campaignId: "c1",
  arm: "native",
  mode: "smoke",
  guidance: "curation",
  repetition: 2,
  ordinal: 2,
  seed: "0011223344556677",
  unit: "pi-fold-experiment-run-1.service",
  invocationId: "1".repeat(32),
  supervisorPid: 42,
  supervisorStartTicks: 99,
  bootId: "11111111-1111-1111-1111-111111111111",
  codeCommit: "b".repeat(40),
  codeTree: "c".repeat(40),
  firstChallenge: "4".repeat(64),
  stageCount: EXPERIMENT_MODE_PLANS.smoke.stageCount,
  stageIntervalMs: EXPERIMENT_MODE_PLANS.smoke.stageIntervalMs,
  watchdogMs: EXPERIMENT_MODE_PLANS.smoke.watchdogMs,
  heartbeatMs: EXPERIMENT_MODE_PLANS.smoke.heartbeatMs,
  createdWallMs: 1_800_000_000_000,
  createdMonotonicMs: 1_000,
  sourceHashes: Object.fromEntries(Array.from({ length: 6 }, (_, index) =>
    [`scripts/file-${index}.mjs`, String(index + 1).repeat(64).slice(0, 64)])),
  dependencyHashes: {
    piPackageJson: "a".repeat(64), piDistTree: "b".repeat(64), piNodeModulesTree: "c".repeat(64),
    nodeExecutable: "f".repeat(64),
  },
  planPath: "/nonexistent/pi-fold-runs/state/ops/pi-context-experiment/c1/stages-smoke.json",
  planSha256: "2".repeat(64),
  repoDir: "/nonexistent/pi-fold-runs/state/ops/pi-context-experiment/c1/runs/run-1/repo",
  targetCommit: repo.commit,
  targetTreeSha256: "3".repeat(64),
  model: { provider: "openai-codex", id: "gpt-5.6-sol", effort: "xhigh" },
  ledgerTasks: [{ id: "lt-01", stage: 3 }],
  querySeed: "04ce51d9cd78889e",
};
validateExperimentRunConfig(runConfig);
assert.throws(() => validateExperimentRunConfig({ ...runConfig, repoDir: "/tmp/elsewhere/repo" }),
  /checkout must live inside the run directory/);
assert.throws(() => validateExperimentRunConfig({ ...runConfig, model: { provider: "p", id: "m" } }),
  /run config shape|provider, model id and effort/);
assert.throws(() => validateExperimentRunConfig({ ...runConfig, watchdogMs: 5 }), /pacing drifted/);
checks.runConfigPinsCheckoutAndModelTriple = true;

// ---------------------------------------------------------------------------
// GATE 6 - reread-tax hashing determinism and repeat accounting
// ---------------------------------------------------------------------------
const payloadA = "alpha payload\nwith lines";
const payloadB = "beta payload";
assert.equal(toolResultContentSha256([{ type: "text", text: payloadA }]), sha256Text(payloadA));
assert.equal(toolResultContentSha256(payloadA), sha256Text(payloadA));
assert.equal(
  toolResultContentSha256([{ type: "text", text: payloadA }]),
  toolResultContentSha256([{ type: "text", text: payloadA }]),
);
assert.notEqual(toolResultContentSha256(payloadA), toolResultContentSha256(payloadB));
assert.equal(estimateTokens("abcd"), 1);
assert.equal(estimateTokens("abcde"), 2);
const ledgerRecord = (ordinal, toolName, text) => ({
  ordinal,
  toolName,
  contentSha256: toolResultContentSha256(text),
  chars: text.length,
  bytes: Buffer.byteLength(text, "utf8"),
  tokensEstimated: estimateTokens(text),
});
const rereadLedger = [
  ledgerRecord(1, "repo_stage", payloadA),
  ledgerRecord(2, "repo_stage", payloadB),
  ledgerRecord(3, "read", payloadA),
  ledgerRecord(4, "read", payloadA),
];
const tax = computeRereadTax(rereadLedger);
assert.equal(tax.tokenEstimatorId, TOKEN_ESTIMATOR_ID);
assert.equal(tax.toolResults, 4);
assert.equal(tax.distinctPayloads, 2);
assert.equal(tax.repeatResults, 2);
assert.equal(tax.repeatBytes, 2 * Buffer.byteLength(payloadA, "utf8"));
assert.equal(tax.repeatTokensEstimated, 2 * estimateTokens(payloadA));
assert.deepEqual(computeRereadTax(rereadLedger), tax, "reread tax is not deterministic");
assert.equal(computeRereadTax([ledgerRecord(1, "read", payloadA)]).repeatResults, 0);
assert.throws(() => computeRereadTax([{ ...rereadLedger[0], contentSha256: "nope" }]),
  /Invalid tool-result ledger record/);
checks.rereadTaxHashingDeterministicAndRepeatCounted = true;

// ---------------------------------------------------------------------------
// GATE 7 - blind grading label separation
// ---------------------------------------------------------------------------
const salt = "0".repeat(32);
assert.equal(submissionId("run-alpha", salt), submissionId("run-alpha", salt));
assert.notEqual(submissionId("run-alpha", salt), submissionId("run-beta", salt));
assert.notEqual(submissionId("run-alpha", salt), submissionId("run-alpha", "1".repeat(32)));
assert.throws(() => submissionId("run-alpha", "short"), /campaign salt/);
const goodPacket = {
  version: 1,
  rubric: { probe: ["correct"], deliverable: ["completeness"] },
  groundTruth: { planSha256: "2".repeat(64), probes: [{ probeId: "probe-01", expectedAnswer: "AlphaConfig" }] },
  submissions: [
    { submissionId: submissionId("run-alpha", salt), probeAnswers: [{ probeId: "probe-01", answerText: "AlphaConfig" }], deliverables: [{ id: "d1", text: "a note" }] },
  ],
};
assertBlindPacket(goodPacket);
assert.throws(() => assertBlindPacket({
  ...goodPacket,
  submissions: [{ ...goodPacket.submissions[0], arm: "pifold" }],
}), /identifying key|leaks the arm label/);
assert.throws(() => assertBlindPacket({
  ...goodPacket,
  submissions: [{ ...goodPacket.submissions[0], runId: "run-alpha" }],
}), /identifying key/);
assert.throws(() => assertBlindPacket({
  ...goodPacket,
  submissions: [{ ...goodPacket.submissions[0], guidance: "pressure" }],
}), /identifying key|leaks the guidance condition/);
assert.throws(() => assertBlindPacket({ ...goodPacket, condition: "pifold" }),
  /leaks the arm label pifold/);
assert.throws(() => assertBlindPacket({ ...goodPacket, note: "curation profile run" }),
  /leaks the guidance condition curation/);
// Model-authored free text is deliberately exempt from the word scan and must stay so:
// otherwise an ordinary English word in a deliverable would fail the packet.
assertBlindPacket({
  ...goodPacket,
  submissions: [{
    ...goodPacket.submissions[0],
    deliverables: [{ id: "d1", text: "The native handler applies pressure to the buffer." }],
  }],
});
// Order must not encode the arm either.
const submissionIds = ["a", "b", "c", "d", "e", "f"].map((name) => submissionId(`run-${name}`, salt));
assert.notDeepEqual(seededShuffle(submissionIds, `${salt}:submission-order`), submissionIds);
assert.deepEqual(
  seededShuffle(submissionIds, `${salt}:submission-order`),
  seededShuffle(submissionIds, `${salt}:submission-order`),
);
checks.blindGradingSeparatesLabelsIdsAndOrder = true;

// ---------------------------------------------------------------------------
// GATE 8 - overflow signature recognition (the unmanaged arm's datum)
// ---------------------------------------------------------------------------
assert.equal(isWindowOverflow("Request too large: maximum context length is 272000 tokens"), true);
assert.equal(isWindowOverflow("400 input length exceeds the model limit"), true);
assert.equal(isWindowOverflow("ECONNRESET while streaming"), false);
assert.equal(isWindowOverflow(null), false);
checks.windowOverflowSignatureRecognized = true;

// ---------------------------------------------------------------------------
// GATE 9 - source shape: the arm really is the runtime configuration
// ---------------------------------------------------------------------------
const extension = source("scripts/pi_context_experiment_extension.mjs");
const worker = source("scripts/run_pi_context_experiment_worker.mjs");
const supervisor = source("scripts/run_pi_context_experiment.mjs");
const adjudicator = source("scripts/adjudicate_pi_context_experiment.mjs");
const grader = source("scripts/grade_pi_context_experiment.mjs");
const launcher = source("scripts/launch_pi_context_experiment.sh");
const staging = source("scripts/stage_pi_context_experiment.mjs");

assert(extension.includes("const pifold = config.arm === \"pifold\"") &&
  extension.includes("registerActiveContext(pi, {") &&
  extension.includes("if (pifold) {"),
"the extension must register the active-context runtime only for the pifold arm");
// The model brief generator is DELETED from the package (2026-08-14): every fold briefs
// deterministically, and a config still asking for one must be refused at the only point
// that ever wired it, before any provider call, rather than silently measuring a build
// that cannot honour it. Sealed manifests that recorded a generator stay readable.
assert(extension.includes("config.briefGenerator === undefined") &&
  /briefGenerator is deleted/.test(extension),
"the extension must refuse a config that still asks for the deleted brief generator");
assert(!extension.includes("createSummarizeContextSpan") &&
  !extension.includes("summarizeContextSpan"),
"the extension still wires the deleted brief generator");
// The guidance profile is RETIRED. It shaped the milestone and live-advisory copy, and
// both carriers are deleted, so a run that recorded a profile would be attesting to a
// condition that changed nothing. The key stays readable for reps 15-21; no producer
// may emit it, and the runtime no longer accepts it.
for (const [name, text] of [["extension", extension], ["worker", worker], ["supervisor", supervisor]]) {
  assert(!/guidance: config\.guidance|--guidance/.test(text),
    `${name} still carries the retired guidance profile condition`);
}
assert(extension.includes('pi.on("session_before_compact"') &&
  extension.includes('pi.on("session_compact"') &&
  extension.includes("openStopTheWorld(\"native-compaction\"") &&
  extension.includes("nativeCompactionDisposition(config.arm)") &&
  extension.includes("compactionDisposition.latchOnCompletion"),
"native compaction must be recorded by outcome: every pass an event, the latch on completion");
assert(extension.includes("appendToolResult({") && extension.includes("toolResultContentSha256(content)"),
  "every tool result must be hashed into the reread-tax ledger");
assert(worker.includes("enabled: armRuntime.nativeCompactionEnabled,") &&
  worker.includes("thinkingLevel: config.model.effort") &&
  worker.includes("validateExperimentManifest(closedBook ? {"),
"the worker must drive compaction from the arm, pin effort, and emit a validated manifest");
assert(worker.includes("closedBook || checkoutSha256 === config.targetTreeSha256"),
  "the worker must pin its checkout against the staged corpus on every arm run");
assert(supervisor.includes("claimSlot(") && supervisor.includes("writeJsonExclusive(slotPath") &&
  supervisor.includes("worktree\", \"add\", \"--quiet\", \"--detach\""),
"the supervisor must claim an exclusive campaign slot and use a pinned detached worktree");
assert(supervisor.includes("renderStage(plan, planStage, repoDir, nextChallenge)") &&
  supervisor.includes("rendered payload does not match its planned hash"),
"the supervisor owns stage release and pin-checks the payload before splicing the nonce");
assert(adjudicator.includes("One-user-message contract broken") &&
  adjudicator.includes("computeRereadTax(rereadRecords)") &&
  adjudicator.includes("voluntaryFoldShare") &&
  adjudicator.includes("overflowPoint") &&
  adjudicator.includes("cacheRead") && adjudicator.includes("cacheWrite"),
"the adjudicator must report usage splits, reread tax, voluntary-fold share and the overflow point");
assert(adjudicator.includes("usageSeriesFromLedger(ledger)") &&
  adjudicator.includes("thinkTimeFromPace(paceRecords)") &&
  adjudicator.includes("probeTranscripts({ entries: runEntries, plan })") &&
  adjudicator.includes("headlineMutationMetric: \"usage.mutations\"") &&
  adjudicator.includes("totalFoldsCounts: \"fold-records\""),
"the adjudicator must report the per-request usage series, observed mutations and the stall proxy, and must say that totalFolds counts fold records");
assert(extension.includes("disposition.kind === \"post-plan\"") &&
  extension.includes("appendEvent(\"post-plan-stage-call\"") &&
  extension.includes("stageCallDisposition({"),
"a trailing stage call on a completed plan must be answered as an event, never latched");
assert(!adjudicator.includes("acceptance: true"),
  "the adjudicator must not authorize anything");
assert(grader.includes("assertBlindPacket(packet)") &&
  grader.includes("join(campaignDir, `grading-key${dirSuffix}`)") &&
  grader.includes("must not share a directory") &&
  grader.includes("adjudicatorSourceSha8()") &&
  grader.includes("--regrade"),
"the grader must build a blind packet, keep the arm mapping in a separate directory, prefer re-adjudication sidecars, and pool regrades into hash-suffixed directories");
assert(grader.includes("Campaign mixes adjudicator versions") &&
  grader.includes("new Set(evidence.map((run) => run.evidence.adjudicatorSourceSha256))") &&
  grader.includes("adjudicators.size === 1"),
"the grader must refuse a campaign whose runs were adjudicated by different adjudicator versions");
assert(launcher.startsWith("#!/bin/bash -p") &&
  launcher.includes("--setenv=PI_FOLD_SANITIZED=1") &&
  launcher.includes("UnsetEnvironment=NODE_OPTIONS") &&
  launcher.includes("refusing an experiment launch from a dirty worktree"),
"the launcher must sanitize its environment and refuse a dirty worktree");
// The unit deadline is DERIVED from the plan's watchdog and sits strictly above it.
//
// It was the literal `RuntimeMaxSec=305m`, correct only while the watchdog was 300
// minutes. Raising full mode to 360 on 2026-08-11 left it behind, and systemd then
// killed every full run 55 minutes early, during or after the closing phase and always
// before a seal: no full-mode run has sealed since, including one that had finished all
// 64 stages. Two literals that must agree and are written in different languages will
// drift again, so the launcher reads the number rather than restating it, and this
// asserts that it cannot go back to a literal.
assert(!/RuntimeMaxSec=[0-9]+(m|s|min)/.test(launcher),
  "the launcher writes a literal unit deadline again instead of deriving it from the plan");
assert(/WATCHDOG_MS=.*watchdogMs/.test(launcher) &&
  launcher.includes("RUNTIME_MAX_SEC=$(( WATCHDOG_MS / 1000 + 300 ))") &&
  launcher.includes('RuntimeMaxSec=${RUNTIME_MAX_SEC}s'),
"the launcher must derive its unit deadline from the plan's own watchdog, above that watchdog");
for (const [name, plan] of Object.entries(EXPERIMENT_MODE_PLANS)) {
  assert(Number.isFinite(plan.watchdogMs) && plan.watchdogMs > 0,
    `mode ${name} declares no usable watchdogMs for the launcher to derive a deadline from`);
}
assert(staging.includes("worktree\", \"add\", \"--quiet\", \"--detach\"") &&
  staging.includes("expected the pinned"),
"staging must fetch the pinned commit and check it out as a detached worktree");
checks.sourceShapeBindsArmToRuntime = true;

// ---------------------------------------------------------------------------
// GATE 10 - repo registry stats are present for every candidate
// ---------------------------------------------------------------------------
for (const [key, entry] of Object.entries(EXPERIMENT_REPOS)) {
  assert.equal(entry.key, key);
  assert(/^[0-9a-f]{40}$/.test(entry.commit), `${key} is not pinned to a commit`);
  assert(entry.license && entry.language, `${key} lacks licence or language`);
  assert(entry.stats.sourceFiles > 0 && entry.stats.sourceLines > 0 && entry.stats.sourceChars > 0,
    `${key} lacks measured corpus stats`);
}
// The default must be able to carry the full mode plan's payload demand.
const fullPlan = EXPERIMENT_MODE_PLANS.full;
const payloadStages = fullPlan.stageCount - fullPlan.probeStages.length;
assert(EXPERIMENT_REPOS[EXPERIMENT_DEFAULT_REPO].stats.sourceChars >=
  payloadStages * fullPlan.payloadTargetChars,
`default repo ${EXPERIMENT_DEFAULT_REPO} cannot supply ${payloadStages} stages of unique payload`);
checks.defaultRepoCarriesTheFullPlan = true;

// ---------------------------------------------------------------------------
// GATE 11 - end-to-end blind grading: the real script, a real packet, a real key
// ---------------------------------------------------------------------------
const campaign = mkdtempSync(join(tmpdir(), "pi-context-experiment-campaign-"));
try {
  const planPath = join(campaign, "stages-smoke.json");
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  for (const [index, arm] of EXPERIMENT_ARMS.entries()) {
    const runId = `2026-08-05T00-00-0${index}Z-${arm}-rep1-aaaa000${index}`;
    const runDir = join(campaign, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run-config.json"), JSON.stringify({ planPath }));
    writeFileSync(join(runDir, "experiment-evidence.json"), JSON.stringify({
      ok: true,
      runId,
      runDir,
      arm,
      guidance: "pressure",
      repetition: 1,
      probes: plan.stages.filter((stage) => stage.probes.length > 0).map((stage) => ({
        stage: stage.ordinal,
        delivered: true,
        rawText: "…",
        answers: stage.probes.map((probe) => ({
          probeId: probe.id, kind: probe.kind, question: probe.question,
          answerText: `an answer from ${arm}`, parsed: true,
        })),
      })),
      deliverables: plan.stages.filter((stage) => stage.deliverable).map((stage) => ({
        id: stage.deliverable.id, stage: stage.ordinal, delivered: true,
        text: "The native handler applies pressure to the buffer.",
      })),
      evidence: { planSha256: plan.planSha256 },
    }, null, 2));
  }
  const graded = spawnSync(process.execPath, [
    join(PROJECT, "scripts", "grade_pi_context_experiment.mjs"),
    "--campaign-dir", campaign, "--dry-run", "--salt", "0".repeat(32),
  ], { cwd: PROJECT, encoding: "utf8", timeout: 120_000 });
  assert.equal(graded.status, 0, `blind grading dry run failed: ${graded.stderr || graded.stdout}`);
  const gradingResult = JSON.parse(graded.stdout);
  assert.equal(gradingResult.ok, true);
  assert.equal(gradingResult.submissions, EXPERIMENT_ARMS.length);
  const packet = JSON.parse(readFileSync(gradingResult.packetPath, "utf8"));
  const key = JSON.parse(readFileSync(gradingResult.keyPath, "utf8"));
  assert.notEqual(dirname(gradingResult.packetPath), dirname(gradingResult.keyPath),
    "packet and key must not share a directory");
  const packetText = JSON.stringify(packet);
  for (const arm of EXPERIMENT_ARMS) {
    assert(!new RegExp(`"[^"]*${arm}[^"]*"\\s*:`).test(packetText),
      `packet exposes ${arm} as a field name`);
  }
  for (const mapping of key.mapping) {
    assert(!packetText.includes(mapping.runId), "packet leaks a run id");
    assert(packet.submissions.some((submission) => submission.submissionId === mapping.submissionId),
      "key maps a submission the packet does not contain");
  }
  // The key, and only the key, carries the arm assignment.
  assert.deepEqual([...key.mapping].map((entry) => entry.arm).sort(), [...EXPERIMENT_ARMS].sort());
  checks.blindGradingEndToEndKeepsTheKeyOutOfThePacket = true;
  // Ground truth reaches the grader with its class split: conversation probes
  // carry the carrier stage, derived probes the step stage or anchor file, repo
  // probes the file position, nothing is classless, and echo probes NEVER enter
  // the packet (their truth is per-run, which would encode the run identity).
  const gtProbes = packet.groundTruth.probes;
  assert(gtProbes.every((probe) => ["conversation", "derived", "repository"].includes(probe.class)));
  assert(gtProbes.every((probe) => probe.kind !== "echo"),
    "an echo probe reached the blind packet");
  assert(gtProbes.filter((probe) => probe.class === "conversation")
    .every((probe) => Number.isSafeInteger(probe.sourceStage) && !Object.hasOwn(probe, "sourcePath")));
  assert(gtProbes.filter((probe) => probe.kind === "chain-link")
    .every((probe) => Number.isSafeInteger(probe.sourceStage)));
  assert(gtProbes.filter((probe) => probe.class === "repository")
    .every((probe) => probe.sourcePath && probe.sourceLine > 0 && !Object.hasOwn(probe, "sourceStage")));
  assert(gtProbes.some((probe) => probe.class === "conversation") &&
    gtProbes.some((probe) => probe.class === "derived") &&
    gtProbes.some((probe) => probe.class === "repository"),
  "the packet must carry every graded probe class");
  const echoIds = new Set(plan.stages.flatMap((stage) =>
    stage.probes.filter((probe) => probe.kind === "echo").map((probe) => probe.id)));
  assert(echoIds.size > 0 && packet.submissions.every((submission) =>
    submission.probeAnswers.every((answer) => !echoIds.has(answer.probeId))),
  "an echo answer reached the blind packet");
  checks.gradingGroundTruthCarriesProbeClasses = true;
} finally {
  rmSync(campaign, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// GATE 12 - displaced probe/deliverable extraction
//
// The measured failure: in the pifold rep-2 full run the model answered probe waves 48
// and 64 one message slot LATE (it issued the next stage call first), and ONE stale-key
// retry at call 41 inserted an extra repo_stage result that shifted every positional index
// after it. The old extractor recorded rawText "" for wave 48, stage-63 prose for wave 64,
// and an empty deliverable-56. This fixture reproduces both faults at once.
// ---------------------------------------------------------------------------
{
  const displaced = [];
  let entryId = 0;
  const push = (message) => {
    displaced.push({ id: `entry-${String(entryId += 1).padStart(3, "0")}`, type: "message", message });
    return displaced.length - 1;
  };
  const assistant = (text, toolCallId) => push({
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...(toolCallId ? [{ type: "toolCall", id: toolCallId, name: "repo_stage", arguments: {} }] : []),
    ],
  });
  const stageResult = (toolCallId, stage) => push({
    role: "toolResult", toolName: "repo_stage", toolCallId, isError: false,
    content: [{ type: "text", text: `STAGE ${stage}` }], details: { stage },
  });
  assistant("", "c1"); stageResult("c1", 1);
  assistant("read stage 1", "c2"); stageResult("c2", 2);
  assistant("read stage 2", "c3");
  const stage3Result = stageResult("c3", 3);
  // The stale-key retry: an errored stage result with NO stage ordinal. Positional
  // extraction is off by one from here on; ordinal-addressed extraction is not.
  assistant("", "c-stale");
  push({
    role: "toolResult", toolName: "repo_stage", toolCallId: "c-stale", isError: true,
    content: [{ type: "text", text: "That key is not the current NEXT_KEY." }],
  });
  assistant("interim note about stage 3", "c4");
  const stage4Result = stageResult("c4", 4);
  const deliverable3Index = assistant("### Deliverable 03 — component model", "c5");
  stageResult("c5", 5);
  const probe4Index = assistant("probe-04-01: 1\nprobe-04-02: cw-000001\nprobe-04-03: AlphaConfig", "c6");
  stageResult("c6", 6);
  const deliverable6Index = assistant("an untitled deliverable body", "c7");
  stageResult("c7", 7);
  assistant("", "c8");
  stageResult("c8", 8);
  assistant("closing synthesis");

  const displacedProbes = probeTranscripts({ entries: displaced, plan });
  assert.deepEqual(displacedProbes.map((probe) => probe.stage),
    EXPERIMENT_MODE_PLANS.smoke.probeStages.slice());
  // Wave 4 was answered one message late, past a non-empty message that is not an answer.
  assert.equal(displacedProbes[0].rawText, displaced[probe4Index].message.content[0].text);
  assert.equal(displacedProbes[0].messagesSkipped, 1,
    "the displaced answer must be recorded as displaced, not silently relocated");
  assert.deepEqual(displacedProbes[0].answers.map((answer) => answer.answerText),
    ["1", "cw-000001", "AlphaConfig"]);
  assert(displacedProbes[0].answers.every((answer) => answer.parsed));
  // Wave 8 was genuinely never answered: the scan must NOT credit it with anything,
  // and its bound stops at the next wave's territory.
  assert.equal(displacedProbes[1].rawText, "");
  assert.equal(displacedProbes[1].messagesSkipped, null);
  assert(displacedProbes[1].answers.every((answer) => !answer.parsed && answer.answerText === null));

  const displacedDeliverables = deliverableTranscripts({ entries: displaced, plan });
  assert.deepEqual(displacedDeliverables.map((deliverable) => deliverable.id),
    ["deliverable-3", "deliverable-6"]);
  assert.equal(displacedDeliverables[0].text, displaced[deliverable3Index].message.content[0].text);
  assert.equal(displacedDeliverables[0].matchedHeading, true);
  assert.equal(displacedDeliverables[0].messagesSkipped, 1);
  // Untitled deliverable: the first non-empty block in the window is the fallback, and the
  // report says plainly that no heading matched.
  assert.equal(displacedDeliverables[1].text, displaced[deliverable6Index].message.content[0].text);
  assert.equal(displacedDeliverables[1].matchedHeading, false);

  // The naive "message immediately after the stage result" rule is what broke: prove the
  // fixture really does displace, so this gate cannot pass by accident.
  assert.equal(displaced[stage4Result + 1].message.content[0].text,
    "### Deliverable 03 — component model");
  assert.equal(displaced[stage3Result + 1].message.content.length, 1,
    "the stale-key retry must sit immediately after the stage-3 result");

  // A stage that never produced a result is reported as undelivered, never as empty prose.
  const truncated = displaced.slice(0, stage4Result);
  assert.deepEqual(probeTranscripts({ entries: truncated, plan })
    .map((probe) => probe.delivered), [false, false]);
  checks.displacedProbeAndDeliverableAnswersAreRecovered = true;
}

// ---------------------------------------------------------------------------
// GATE 13 - per-request usage series and OBSERVED prefix invalidations
// ---------------------------------------------------------------------------
{
  const ledger = [];
  const exchange = (ordinal, wallMs, usage) => {
    ledger.push({ kind: "provider-request", ordinal, wallMs });
    ledger.push({ kind: "provider-response", requestOrdinal: ordinal, usage });
  };
  exchange(1, 1_000, { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 10 });
  exchange(3, 3_000, { input: 200, cacheRead: 1_000, cacheWrite: 0, output: 20 });
  exchange(5, 9_000, { input: 5_000, cacheRead: 0, cacheWrite: 0, output: 30 });
  exchange(7, 10_000, { input: 100, cacheRead: 5_000, cacheWrite: 0, output: 40 });
  exchange(9, 11_000, { input: 60, cacheRead: 5_040, cacheWrite: 0, output: 50 });
  const usageSeries = usageSeriesFromLedger(ledger);
  assert.equal(usageSeries.series.length, 5);
  assert.deepEqual(usageSeries.series.map((entry) => entry.ordinal), [1, 2, 3, 4, 5]);
  // Only the third request re-paid for a prefix it had already paid for.
  assert.deepEqual(usageSeries.series.map((entry) => entry.mutation),
    [false, false, true, false, false]);
  assert.equal(usageSeries.mutations, 1);
  // The wall-clock gap is what separates a mutation from a provider cache TTL eviction.
  assert.deepEqual(usageSeries.series.map((entry) => entry.interRequestWallMs),
    [null, 2_000, 6_000, 1_000, 1_000]);
  assert.equal(usageSeries.series[0].cacheShare, 0);
  assert.equal(usageSeries.series[1].cacheShare, 1_000 / 1_200);
  assert.equal(usageSeries.mutationRule.absoluteToleranceTokens, MUTATION_ABSOLUTE_TOLERANCE_TOKENS);
  assert.equal(usageSeries.mutationRule.comparableRequests, 4);
  // A dip smaller than the tolerance is cache-block granularity, not an invalidation.
  const shallow = usageSeriesFromLedger([
    { kind: "provider-request", ordinal: 1, wallMs: 0 },
    { kind: "provider-response", requestOrdinal: 1, usage: { input: 100_000, cacheRead: 0 } },
    { kind: "provider-request", ordinal: 3, wallMs: 1_000 },
    { kind: "provider-response", requestOrdinal: 3, usage: { input: 1_500, cacheRead: 99_000 } },
  ]);
  assert.equal(shallow.mutations, 0);
  // Token-weighted pooled share beside the per-request mean: 11,040 cached of 17,400 input.
  assert.equal(usageSeries.pooledCacheShare, 11_040 / 17_400);
  assert.equal(usageSeriesFromLedger([]).pooledCacheShare, null);
  assert.deepEqual(usageSeriesFromLedger(ledger), usageSeries, "usage series is not deterministic");
  assert.equal(usageSeriesFromLedger([]).mutations, 0);
  checks.usageSeriesAttributesMutationsAgainstProviderCacheAccounting = true;
}

// ---------------------------------------------------------------------------
// GATE 14 - stall proxy: the agent's own think time between stages
// ---------------------------------------------------------------------------
{
  const pace = [
    { stage: 1, requestedMonotonicMs: 0, releasedMonotonicMs: 100 },
    { stage: 2, requestedMonotonicMs: 1_100, releasedMonotonicMs: 1_200 },
    { stage: 3, requestedMonotonicMs: 5_200, releasedMonotonicMs: 5_300 },
    { stage: 4, requestedMonotonicMs: 5_400, releasedMonotonicMs: 5_500 },
  ];
  const think = thinkTimeFromPace(pace);
  assert.equal(think.samples, 3);
  assert.deepEqual(think.perStage.map((entry) => entry.thinkMs), [1_000, 4_000, 100]);
  assert.deepEqual(think.perStage.map((entry) => entry.afterStage), [1, 2, 3]);
  assert.equal(think.maxMs, 4_000);
  assert.equal(think.p95Ms, 4_000);
  assert.equal(think.medianMs, 1_000);
  assert.equal(thinkTimeFromPace([]).samples, 0);
  assert.equal(thinkTimeFromPace([]).maxMs, null);
  assert.throws(() => thinkTimeFromPace([
    { stage: 1, releasedMonotonicMs: 0 }, { stage: 2 },
  ]), /lacks monotonic clocks/);
  checks.stallProxyMeasuresAgentThinkTimePerStage = true;
}

// ---------------------------------------------------------------------------
// GATE 15 - a completed plan answers a trailing stage call instead of latching it
//
// One trailing repo_stage call after stage 64 voided a completed 64/64 native run. A
// finished assignment being tidy is not a capability breach; a REPLAYED tool call id is.
// ---------------------------------------------------------------------------
{
  const used = new Set(["already-served"]);
  const serve = stageCallDisposition({
    expectedStage: 3, stageCount: 8, toolCallId: "fresh", usedToolCallIds: used,
  });
  assert.equal(serve.kind, "serve");
  assert.equal(serve.latch, false);
  const replay = stageCallDisposition({
    expectedStage: 3, stageCount: 8, toolCallId: "already-served", usedToolCallIds: used,
  });
  assert.deepEqual(replay, { kind: "replay", latch: true, isError: true });
  const postPlan = stageCallDisposition({
    expectedStage: 9, stageCount: 8, toolCallId: "trailing", usedToolCallIds: used,
  });
  assert.equal(postPlan.kind, "post-plan");
  assert.equal(postPlan.latch, false);
  assert.equal(postPlan.isError, false);
  assert.equal(postPlan.text, "plan complete: all 8 stages served");
  // A replay stays latched even after the plan is complete.
  assert.equal(stageCallDisposition({
    expectedStage: 9, stageCount: 8, toolCallId: "already-served", usedToolCallIds: used,
  }).kind, "replay");
  assert.throws(() => stageCallDisposition({
    expectedStage: 0, stageCount: 8, toolCallId: "x", usedToolCallIds: used,
  }), /stage counters/);
  checks.completedPlanAnswersTrailingStageCallWithoutLatching = true;
}

// ---------------------------------------------------------------------------
// GATE 16 - re-adjudication writes a named sidecar and never overwrites
// ---------------------------------------------------------------------------
{
  const reAdjudicator = source("scripts/adjudicate_pi_context_experiment.mjs");
  assert(reAdjudicator.includes("--re-adjudicate") &&
    reAdjudicator.includes("`experiment-evidence.${report.evidence.adjudicatorSourceSha256.slice(0, 8)}.json`") &&
    reAdjudicator.includes("writeJsonExclusive(evidencePath, report)"),
  "re-adjudication must write experiment-evidence.<first8 of adjudicatorSourceSha256>.json exclusively");
  assert(!/_v\d|evidence-new|evidence-old/.test(reAdjudicator),
    "the re-adjudication sidecar must not carry a version-suffix name");
  const rejected = spawnSync(process.execPath, [
    join(PROJECT, "scripts", "adjudicate_pi_context_experiment.mjs"),
    "/nonexistent-run-dir", "--rewrite-everything",
  ], { cwd: PROJECT, encoding: "utf8", timeout: 60_000 });
  assert.equal(rejected.status, 1);
  assert(/accepts only --re-adjudicate/.test(rejected.stdout),
    `unknown adjudicator flags must be refused: ${rejected.stdout}`);
  const missing = spawnSync(process.execPath, [
    join(PROJECT, "scripts", "adjudicate_pi_context_experiment.mjs"),
    "--re-adjudicate", "/nonexistent-run-dir",
  ], { cwd: PROJECT, encoding: "utf8", timeout: 60_000 });
  assert.equal(missing.status, 1);
  assert(/requires a run directory/.test(missing.stdout),
    `the flag must not be parsed as the run directory: ${missing.stdout}`);
  checks.reAdjudicationWritesANamedSidecarAndNeverOverwrites = true;
}

// ---------------------------------------------------------------------------
// GATE 17 - the fold-scheduling dial is retired: tolerated on read, emitted by nobody,
// and the epoch scheduler is pinned unconditionally
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...EXPERIMENT_FOLD_SCHEDULING], ["immediate", "epoch"]);
  assert.equal(EXPERIMENT_SCHEDULING_SOURCE, "extensions/lib/scheduling.ts");
  // Sealed run directories are immutable data: reps 1-23 recorded foldScheduling, and
  // the paper's second experiment is an immediate-vs-epoch pairing, so BOTH values must
  // keep validating on read. A run config written after the deletion carries no key.
  validateExperimentRunConfig(runConfig);
  validateExperimentRunConfig({ ...runConfig, foldScheduling: "epoch" });
  validateExperimentRunConfig({ ...runConfig, foldScheduling: "immediate" });
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldScheduling: "eventual" }),
    /fold scheduling is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldSchedule: "epoch" }),
    /run config shape/);
  validateExperimentManifest(manifest);
  validateExperimentManifest({ ...manifest, foldScheduling: "epoch" });
  validateExperimentManifest({ ...manifest, foldScheduling: "immediate" });
  assert.throws(() => validateExperimentManifest({ ...manifest, foldScheduling: "eventual" }),
    /fold scheduling is not a shipped package option/);
  assert.throws(() => validateExperimentManifest({ ...manifest, foldSchedule: "epoch" }),
    /manifest shape/);
  // NO PRODUCER. The runtime refuses the option at construction now, so a script that
  // still threaded it would abort the very run it configured.
  for (const [name, text] of [
    ["extension", extension], ["worker", worker], ["supervisor", supervisor],
  ]) {
    assert(!/foldScheduling/.test(text), `${name} still threads the retired fold-scheduling dial`);
  }
  // The epoch scheduler source is pinned unconditionally: a run that cannot pin the code
  // implementing its own condition is not the experiment.
  assert(supervisor.includes("experimentSourceHashes()") &&
    supervisor.includes("assertExperiment(existsSync(join(PROJECT, EXPERIMENT_SCHEDULING_SOURCE))") &&
    supervisor.includes("assertExperiment(runtimePaths.includes(EXPERIMENT_SCHEDULING_SOURCE)"),
  "the supervisor must pin the whole runtime source tree and require the epoch scheduler");
  // The adjudicator reports the key from artifacts that carry it, and reads an ABSENT
  // key as epoch: every pre-deletion artifact wrote it explicitly, so absent means the
  // run was configured after the deletion. Defaulting to the shipped-through-1.0.2
  // value here would publish every future epoch run as "immediate".
  assert(adjudicator.includes('foldScheduling: config.foldScheduling ?? "epoch"'),
    "the adjudicator must read an absent fold-scheduling key as epoch");
  checks.foldSchedulingRetiredAndReadOnly = true;
}

// ---------------------------------------------------------------------------
// GATE 21 - the peek-fold dial is retired: tolerated on read, emitted by nobody
// ---------------------------------------------------------------------------
{
  // Same precedent, same shape: reps 15-23 recorded it, so both values keep validating.
  validateExperimentRunConfig(runConfig);
  validateExperimentRunConfig({ ...runConfig, foldPeekResults: true });
  validateExperimentRunConfig({ ...runConfig, foldPeekResults: false });
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldPeekResults: "true" }),
    /peek-fold condition is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldPeek: true }),
    /run config shape/);
  validateExperimentManifest({ ...manifest, foldPeekResults: true });
  validateExperimentManifest({ ...manifest, foldPeekResults: false });
  assert.throws(() => validateExperimentManifest({ ...manifest, foldPeekResults: "true" }),
    /peek-fold condition is not a boolean/);
  assert.throws(() => validateExperimentManifest({ ...manifest, foldPeek: true }),
    /manifest shape/);
  for (const [name, text] of [
    ["extension", extension], ["worker", worker], ["supervisor", supervisor],
  ]) {
    assert(!/foldPeekResults/.test(text), `${name} still threads the retired peek-fold dial`);
  }
  assert(adjudicator.includes("foldPeekResults: config.foldPeekResults ?? true"),
    "the adjudicator must read an absent peek-fold key as foldable");
  checks.foldPeekResultsRetiredAndReadOnly = true;
}

// ---------------------------------------------------------------------------
// GATE 22 - guided curation is threaded from the launcher to the registration, and the
// retired reliability-lever condition is gone from scripts/ entirely
// ---------------------------------------------------------------------------
{
  assert.equal(EXPERIMENT_DEFAULT_GUIDED_CURATION, false);
  // Runs sealed before the dial existed carry no key and still adjudicate.
  validateExperimentRunConfig(runConfig);
  validateExperimentRunConfig({ ...runConfig, foldScheduling: "epoch", guidedCuration: true });
  validateExperimentRunConfig({ ...runConfig, guidedCuration: false });
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, guidedCuration: "true" }),
    /guided-curation condition is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, guidedCurated: true }),
    /run config shape/);
  assert.throws(() => validateExperimentManifest({ ...manifest, guidedCuration: "true" }),
    /guided-curation condition is not a boolean/);
  assert.throws(() => validateExperimentManifest({ ...manifest, guidedCurated: true }),
    /manifest shape/);
  // Sealed run directories are immutable data: runs 10-14 recorded reliabilityLevers and
  // runs 15-21 recorded guidedCuration and guidance, so reading them must still validate.
  validateExperimentRunConfig({ ...runConfig, reliabilityLevers: true });
  validateExperimentManifest({ ...manifest, reliabilityLevers: true });
  validateExperimentRunConfig({ ...runConfig, guidedCuration: true, guidance: "curation" });
  validateExperimentManifest({ ...manifest, guidedCuration: true, guidance: "curation" });

  // RETIRED CONDITION DIALS. `guidedCuration` announced a pending commit and gave the
  // agent a bounded last call; `guidance` chose between milestone/advisory copy sets.
  // Both are gone from the runtime, because an announcement has to arrive BEFORE the
  // event it announces and therefore has to break a prefix nothing else was breaking.
  // A producer that still emitted either would attest to a condition that changed
  // nothing, which is worse than not recording it at all: the run config is the
  // experiment's claim about what varied.
  for (const [name, text] of [
    ["extension", extension], ["worker", worker],
    ["supervisor", supervisor], ["adjudicator", adjudicator],
  ]) {
    assert(!/guidedCuration:|guidance: config\.guidance/.test(text),
      `${name} still emits a retired condition dial`);
  }
  assert(!/--guided-curation|--guidance|GUIDED_CURATION|GUIDANCE=/.test(launcher) &&
    !/--fold-scheduling|FOLD_SCHEDULING|--fold-peek-results|FOLD_PEEK_RESULTS/.test(launcher),
  "the shell launcher still accepts a retired condition dial");
  // Removal-and-debt: the retired option set must not survive anywhere in scripts/ as
  // callable code — an anti-pattern left callable gets recomposed. The needle is
  // assembled so this gate does not match itself.
  const retiredOptions = ["RELIABILITY", "LEVER"].join("_");
  const survivors = spawnSync("/usr/bin/grep", ["-rlF", retiredOptions, join(PROJECT, "scripts")],
    { encoding: "utf8" });
  assert.equal(survivors.status, 1,
    `${retiredOptions} must be purged from scripts/; still present in:\n${survivors.stdout}`);
  checks.retiredConditionDialsEmittedByNobody = true;
}

// ---------------------------------------------------------------------------
// GATE 23 - the provider-input-budget deployment fact is resolved from the PROVIDER and
// model pin together and threaded supervisor -> run config -> manifest -> registration, so
// no run can measure its curation thresholds against the per-request descriptor budget
// again (rep 16's abort), and the retired gross-window key stays readable on sealed runs
// ---------------------------------------------------------------------------
{
  // Keyed by provider AND model: capacity is a fact about a deployment, and the same
  // model id behind another provider is another wire. Stated already net, which is the
  // shape the runtime now takes.
  //
  // Both entries now hold the same number, and the reason is not that the wires turned out
  // alike. It is that the wire stopped being the binding constraint: Pi meters the ANSWER
  // against the descriptor's declared window, so a serving budget the wire would happily
  // accept still leaves the model no room to reply. Both deployments declare 272,000, so
  // both land on 272,000 less Pi's 4,096 reserve less the 16,384 of output that rep 1
  // established empirically by dying without it. Luna's separately measured wire refusal at
  // approximately 377,800 is real and simply no longer binds, which is why it is not the
  // number here.
  const OUTPUT_HEADROOM = 16_384;
  for (const key of ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"]) {
    assert.equal(EXPERIMENT_PROVIDER_INPUT_BUDGETS[key], 251_520, `${key} serving budget`);
    // Derived, not asserted as a magic number: a descriptor change must move this or fail.
    assert.equal(EXPERIMENT_PROVIDER_INPUT_BUDGETS[key],
      272_000 - PI_OUTPUT_BUDGET.safetyTokens - OUTPUT_HEADROOM,
      `${key} budget no longer matches the window arithmetic it is derived from`);
    // The property the number exists for: a request that fills the whole budget must still
    // be served a real answer rather than the API floor.
    assert.equal(
      servedOutputBudget({
        contextWindow: 272_000,
        contextChars: EXPERIMENT_PROVIDER_INPUT_BUDGETS[key] * PI_OUTPUT_BUDGET.charsPerToken,
        modelMaxTokens: 128_000,
      }),
      OUTPUT_HEADROOM,
      `${key} at full occupancy does not leave the model room to answer`);
  }
  // Anti-vacuity: the budget that shipped through sol-20260811 rep 2 fails that property,
  // which is the defect this correction exists to remove.
  assert.equal(
    servedOutputBudget({
      contextWindow: 272_000,
      contextChars: 383_616 * PI_OUTPUT_BUDGET.charsPerToken,
      modelMaxTokens: 128_000,
    }),
    PI_OUTPUT_BUDGET.apiFloorTokens,
    "the superseded 383,616 budget must still demonstrate the starvation it caused");
  assert.equal(EXPERIMENT_PROVIDER_INPUT_BUDGETS["gpt-5.6-sol"], undefined);
  validateExperimentRunConfig({ ...runConfig, providerInputBudget: 383_616 });
  validateExperimentRunConfig(runConfig); // unlisted deployments carry no key: descriptor mode
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerInputBudget: 0 }),
    /provider input budget is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerInputBudget: "383616" }),
    /provider input budget is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerWindow: 400_000 }),
    /run config shape/);
  validateExperimentManifest({ ...manifest, providerInputBudget: 383_616 });
  validateExperimentManifest(manifest);
  assert.throws(() => validateExperimentManifest({ ...manifest, providerInputBudget: -1 }),
    /provider input budget is invalid/);
  // The gross-window key is RETIRED, not forbidden: runs 15-23 recorded it and their
  // sealed configs are immutable data, so they must keep validating while nothing emits it.
  validateExperimentRunConfig({ ...runConfig, providerTotalWindow: 400_000 });
  validateExperimentManifest({ ...manifest, providerTotalWindow: 400_000 });
  assert.equal(supervisor.includes("EXPERIMENT_PROVIDER_TOTAL_WINDOWS"), false,
    "the supervisor still resolves the retired gross-window fact");
  assert(supervisor.includes("EXPERIMENT_PROVIDER_INPUT_BUDGETS[`${modelProvider}/${modelId}`] ?? null") &&
    supervisor.includes("{ providerInputBudget }"),
  "the supervisor must resolve the deployment fact from provider plus model and record it");
  assert(worker.includes("{ providerInputBudget: config.providerInputBudget }"),
    "the worker must pin the run's serving-budget fact in the sealed manifest");
  assert(extension.includes("{ providerInputBudget: config.providerInputBudget }"),
    "the extension must pass the deployment fact into the active-context registration");
  assert(adjudicator.includes("providerInputBudget: config.providerInputBudget ?? null"),
    "the adjudicator must echo the run's serving-budget fact into the evidence");
  checks.providerInputBudgetThreadedFromDeploymentPinToRegistration = true;
}

// ---------------------------------------------------------------------------
// GATE 24 - every run pins the SSE transport into the worker's isolated settings, so no
// arm rides WebSocket delta requests whose connection drops re-send the context cold
// ---------------------------------------------------------------------------
{
  assert.equal(EXPERIMENT_TRANSPORT, "sse");
  assert(EXPERIMENT_TRANSPORTS.includes(EXPERIMENT_TRANSPORT));
  validateExperimentRunConfig({ ...runConfig, transport: "sse" });
  validateExperimentRunConfig(runConfig); // pre-pin runs carry no key and still adjudicate
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, transport: "carrier-pigeon" }),
    /transport is not a known Pi transport/);
  validateExperimentManifest({ ...manifest, transport: "sse" });
  assert.throws(() => validateExperimentManifest({ ...manifest, transport: true }),
    /transport is not a known Pi transport/);
  assert(supervisor.includes("transport: EXPERIMENT_TRANSPORT"),
    "the supervisor must pin the experiment transport into every run config");
  assert(worker.includes("{ transport: config.transport }") &&
    worker.includes('getTransport() === (config.transport ?? "auto")'),
  "the worker must pass the pinned transport into the isolated settings and assert it reached the session");
  assert(adjudicator.includes('transport: config.transport ?? "auto"'),
    "the adjudicator must echo the run's transport into the evidence");
  checks.transportPinnedToSseForEveryRun = true;
}

// ---------------------------------------------------------------------------
// GATE 25 - mutation accounting and the mechanism-limited counterfactual come from the
// runtime's own context event stream, not wire inference: rep 17's wire rule counted 60
// mutations against 38 actual commits, and its raw pooled share of 0.390 hid a mechanism
// running at 0.864. Both lenses ship in the evidence, and neither replaces the other.
// ---------------------------------------------------------------------------
{
  const prefix = (ordinal, over) => ({ type: "custom", customType: "pi-fold-context-event",
    data: { kind: "context.prefix", ordinal, change: "append", divergent_tokens: null,
      estimated_tokens: 0, cause: "pure-append", request_class: "steady-state", ...over } });
  const custom = (data) => ({ type: "custom", customType: "pi-fold-context-event", data });
  const entries = [
    prefix(1, { estimated_tokens: 100 }),
    // Pure append: the whole previous projection is a cached prefix.
    prefix(2, { estimated_tokens: 300, cause: "unattributed" }),
    // Structural rewrite: a commit and its fold, divergence recorded mid-projection.
    custom({ kind: "context.commit", ordinal: 3, deferred: false, trigger: "gate" }),
    custom({ kind: "context.fold", ordinal: 3, fold_id: "fold_1", mark_id: "mark_1" }),
    prefix(3, { change: "rewrite", divergent_tokens: 120, estimated_tokens: 250,
      cause: "context.commit,context.fold", request_class: "after-fold" }),
    // Surface rewrite: no structural cause, the class iteration 7 freezes out.
    prefix(4, { change: "rewrite", divergent_tokens: 40, estimated_tokens: 260,
      cause: "unattributed" }),
    // A deferred commit mutates nothing and is counted apart from real commits.
    custom({ kind: "context.commit", ordinal: 5, deferred: true, reason: "below-reclaim-floor" }),
    prefix(5, { estimated_tokens: 400 }),
    // Non-stream customs are invisible to the metrics.
    { type: "custom", customType: "pi-fold-active-context-state", data: { kind: "context.prefix" } },
  ];
  const metrics = contextEventMetrics(entries);
  assert.equal(metrics.prefixEvents, 5);
  assert.equal(metrics.prefixRewrites, 2);
  assert.equal(metrics.structuralRewrites, 1);
  assert.equal(metrics.surfaceRewrites, 1);
  assert.equal(metrics.commits, 1);
  assert.equal(metrics.commitsDeferred, 1);
  assert.equal(metrics.folds, 1);
  assert.equal(metrics.byKind["context.prefix"], 5);
  // Ideal cached walks the recorded divergences: 0 + 100 + 120 + 40 + 260 of 1,310.
  assert.equal(metrics.counterfactual.idealCachedTokens, 520);
  assert.equal(metrics.counterfactual.projectedTokens, 1_310);
  assert.equal(metrics.counterfactual.pooledCacheShare, 520 / 1_310);
  assert.equal(metrics.counterfactual.byRequestClass["after-fold"].idealCachedTokens, 120);
  assert.equal(metrics.counterfactual.byRequestClass["steady-state"].requests, 4);
  // A recorded divergence beyond the previous projection cannot cache more than existed.
  const clamped = contextEventMetrics([prefix(1, { estimated_tokens: 100 }),
    prefix(2, { change: "rewrite", divergent_tokens: 999, estimated_tokens: 150,
      cause: "unattributed" })]);
  assert.equal(clamped.counterfactual.idealCachedTokens, 100);
  assert.equal(contextEventMetrics([]).counterfactual.pooledCacheShare, null);
  assert(adjudicator.includes("contextEventMetrics(runEntries)") &&
    adjudicator.includes("pooledCacheShare: usageSeries.pooledCacheShare") &&
    adjudicator.includes('headlineMutationMetric: "contextEvents.prefixRewrites"'),
  "the adjudicator must compute event-stream metrics, echo the pooled wire share, and name the stream as the headline mutation metric");
  checks.eventStreamMutationsAndCounterfactualAdjudicated = true;
}

// Ported from the retired soak verifier, which was this primitive's only executable
// coverage anywhere. verifySourceHashes stays LIVE on the experiment path: the worker
// checks the attested tree before a run and the supervisor re-checks it after, so a
// runtime that changed mid-campaign is caught rather than measured. The gate proves the
// REJECTION, not the happy path: a drifted byte must throw.
{
  const scratch = mkdtempSync(join(tmpdir(), "pi-context-source-hashes-"));
  try {
    writeFileSync(join(scratch, "source.txt"), "one");
    const treeBefore = directoryTreeSha256(scratch);
    verifySourceHashes(scratch, { "source.txt": sha256Text("one") });
    writeFileSync(join(scratch, "source.txt"), "two");
    assert.notEqual(directoryTreeSha256(scratch), treeBefore,
      "a rewritten file left the directory tree hash unmoved");
    assert.throws(() => verifySourceHashes(scratch, { "source.txt": sha256Text("one") }),
      /source hash drifted/);
    checks.sourceHashDriftRejected = true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// GATE 27  The harness identity agrees with the runtime that consumes it
//
// pi_fold_identity.mjs writes its entry-type namespace out as a literal so the adjudicator
// and the graders, which run under plain node with no TypeScript loader, can import it.
// That literal is a copy of what the runtime's entryTypeNamespace() computes, and a copy
// is a thing that drifts. Here, where jiti IS available, compute it and compare: if the
// runtime ever changes the rule, this fails instead of a run sealing entry types no reader
// looks for.
// ---------------------------------------------------------------------------
{
  const jitiPath = join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs");
  assert(existsSync(jitiPath), "could not resolve package-local jiti to check the identity namespace");
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const policy = await createJiti(import.meta.url).import(join(PROJECT, "extensions", "lib", "policy.ts"));
  const identity = await import(pathToFileURL(join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const prefix = identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix;
  assert.equal(policy.entryTypeNamespace(prefix), identity.PI_FOLD_ENTRY_NAMESPACE,
    "the identity module's written-out namespace no longer matches entryTypeNamespace()");
  assert.equal(identity.PI_FOLD_STATE_ENTRY, `${prefix}-state`);
  assert.equal(identity.PI_FOLD_FOLD_RECORD_ENTRY, `${prefix}-fold-record`);
  assert.equal(identity.PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY,
    `${identity.PI_FOLD_ENTRY_NAMESPACE}-native-compaction-decision`);
  assert.equal(identity.PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY,
    `${identity.PI_FOLD_ENTRY_NAMESPACE}-native-compaction-receipt`);
  // The registration block is identity ONLY. Foldability policy left it on 2026-08-10
  // when the auto-fold list inverted: the arm folds every completed tool batch unmarked,
  // exactly as a consumer's does, and a blacklist smuggled in here would make the measured
  // ladder a harness-only variant of the shipped one.
  assert(!Object.hasOwn(identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION, "blacklistAutoFoldTools") &&
    !Object.hasOwn(identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION, "autoFoldableTools"),
  "the harness identity must carry no auto-fold policy: the arm runs the shipped default");
  // Nor any brief-generator policy. Which model writes a run's briefs is a RUN fact that
  // travels the run config and gets sealed into that run's manifest; parked here it would
  // be invisible to the manifest and identical across every rep by construction.
  assert(!Object.hasOwn(identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION, "summarizeContextSpan") &&
    !Object.hasOwn(identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION, "summarizer") &&
    !Object.hasOwn(identity.PI_FOLD_ACTIVE_CONTEXT_REGISTRATION, "briefGenerator"),
  "the harness identity must carry no brief-generator policy: that fact belongs to the run");
  checks.harnessIdentityMatchesRuntimeNamespace = true;
}

// ---------------------------------------------------------------------------
// GATE 28 - tool usage is a reported number, never a hand discovery. The rep-23 run
// (zero context-tool calls, every fold ladder-origin) was found by manually reading a
// sealed run. contextEventMetrics must carry per-action outcomes, the zero-call flag,
// protect no-ops, and committed curation mass by origin with the share reported
// beside its numerator and denominator.
// ---------------------------------------------------------------------------
{
  const custom = (data) => ({ type: "custom", customType: "pi-fold-context-event", data });
  const entries = [
    custom({ kind: "context.attempt", ordinal: 4, action: "fold", ok: true,
      tool_call_id: "call_1", marks_requested: 2, corrections_applied: 1, error: null }),
    custom({ kind: "context.attempt", ordinal: 6, action: "fold", ok: false,
      tool_call_id: "call_2", marks_requested: 1, corrections_applied: 0,
      error: "No exact source spans matched" }),
    custom({ kind: "context.attempt", ordinal: 8, action: "protect", ok: true,
      tool_call_id: "call_3", marks_requested: 0, corrections_applied: 0, error: null }),
    custom({ kind: "context.protect", ordinal: 8, protect: true, ids: "fold_1",
      id_count: 1, protected_refs_before: 0, protected_refs_after: 3 }),
    custom({ kind: "context.protect", ordinal: 9, protect: true, ids: "fold_1",
      id_count: 1, protected_refs_before: 3, protected_refs_after: 3 }),
    custom({ kind: "context.commit", ordinal: 10, deferred: false, pending_marks: 2 }),
    custom({ kind: "context.fold", ordinal: 10, fold_id: "fold_2", origin: "agent",
      source_chars: 9_000 }),
    custom({ kind: "context.fold", ordinal: 10, fold_id: "fold_3", origin: "ladder",
      source_chars: 3_000 }),
  ];
  const metrics = contextEventMetrics(entries);
  assert.equal(metrics.toolUsage.attempts, 3);
  assert.equal(metrics.toolUsage.zeroContextCalls, false);
  assert.equal(metrics.toolUsage.errors, 1);
  assert.equal(metrics.toolUsage.corrected, 1);
  assert.equal(metrics.toolUsage.byAction.fold.attempts, 2);
  assert.equal(metrics.toolUsage.byAction.fold.accepted, 1);
  assert.equal(metrics.toolUsage.byAction.fold.errors, 1);
  assert.equal(metrics.toolUsage.byAction.fold.corrected, 1);
  assert.equal(metrics.toolUsage.byAction.fold.marksRequested, 3);
  assert.equal(metrics.toolUsage.byAction.fold.firstOrdinal, 4);
  assert.equal(metrics.toolUsage.byAction.fold.lastOrdinal, 6);
  assert.equal(metrics.toolUsage.byAction.protect.attempts, 1);
  assert.equal(metrics.toolUsage.protectEvents, 2);
  assert.equal(metrics.toolUsage.protectNoops, 1);
  assert.equal(metrics.curationMass.committedFolds, 2);
  assert.equal(metrics.curationMass.agentFoldedCount, 1);
  assert.equal(metrics.curationMass.agentFoldedSourceChars, 9_000);
  assert.equal(metrics.curationMass.ladderFoldedSourceChars, 3_000);
  assert.equal(metrics.curationMass.agentMarkSourcedShare, 0.75);
  assert.equal(metrics.curationMass.pendingMarksAtLastCommit, 2);
  // The empty run raises the flag instead of hiding it.
  assert.equal(contextEventMetrics([]).toolUsage.zeroContextCalls, true);
  assert.equal(contextEventMetrics([]).curationMass.agentMarkSourcedShare, null);
  checks.toolUsageIsAReportedNumber = true;
}

// ---------------------------------------------------------------------------
// GATE 46 - the B1 observability contract: every guidance carrier ships with its
// adjudicator lens in the same build. The last-call exposure-to-response attribution
// is a TABLE the adjudicator can read (one row per exposure, joined by exposure_seq,
// with the round's attempts counted between the two seqs), the threshold-notice log
// travels with its shares, and per-carrier byte overhead is summed from each carrier
// event's own chars field.
// ---------------------------------------------------------------------------
{
  const custom = (data) => ({ type: "custom", customType: "pi-fold-context-event", data });
  const entries = [
    custom({ kind: "context.notice", seq: 1, ordinal: 2, share: 0.25, occupancy: 0.26,
      occupancy_tokens: 23_400, budget_tokens: 90_000, max_target: 0.8, chars: 300 }),
    custom({ kind: "context.lastcall", seq: 2, ordinal: 6, occupancy: 0.89, max_target: 0.8,
      occupancy_tokens: 80_100, budget_tokens: 90_000, unmarked_stale_spans: 4,
      unmarked_stale_tokens: 30_000, pending_marks: 2, pending_agent_marks: 0, chars: 900 }),
    custom({ kind: "context.attempt", seq: 3, ordinal: 7, action: "fold", ok: true,
      tool_call_id: "call_9", marks_requested: 2, corrections_applied: 0, error: null }),
    custom({ kind: "context.attempt", seq: 4, ordinal: 7, action: "protect", ok: true,
      tool_call_id: "call_10", marks_requested: 0, corrections_applied: 0, error: null }),
    custom({ kind: "context.response", seq: 5, ordinal: 8, exposure_seq: 2, commit_seq: 6,
      trigger: "band-top", outcome: "responded", responded: true, context_calls: 2,
      marks_added: 2, protects: 1, unprotects: 0 }),
    custom({ kind: "context.commit", seq: 6, ordinal: 8, deferred: false, trigger: "band-top" }),
    custom({ kind: "context.rider", seq: 7, ordinal: 8, epoch: 6, chars: 800 }),
    // A second exposure nothing ever answered stays visible as an open row.
    custom({ kind: "context.lastcall", seq: 8, ordinal: 12, occupancy: 0.85, max_target: 0.8,
      occupancy_tokens: 76_500, budget_tokens: 90_000, unmarked_stale_spans: 1,
      unmarked_stale_tokens: 5_000, pending_marks: 0, pending_agent_marks: 0, chars: 880 }),
  ];
  const carriers = contextEventMetrics(entries).guidanceCarriers;
  assert.equal(carriers.lastCall.exposures, 2);
  assert.equal(carriers.lastCall.responses, 1);
  assert.equal(carriers.lastCall.responded, 1);
  assert.equal(carriers.lastCall.open, 1);
  assert.equal(carriers.lastCall.responseRate, 0.5);
  const row = carriers.lastCall.table[0];
  assert.equal(row.exposureSeq, 2);
  assert.equal(row.outcome, "responded");
  assert.equal(row.commitSeq, 6);
  assert.equal(row.contextCalls, 2);
  assert.equal(row.marksAdded, 2);
  assert.equal(row.protects, 1);
  assert.equal(row.attemptsInRound, 2);
  assert.equal(row.attemptActionsInRound.fold, 1);
  assert.equal(row.attemptActionsInRound.protect, 1);
  assert.equal(row.unmarkedStaleTokens, 30_000);
  assert.equal(carriers.lastCall.table[1].outcome, "open");
  assert.equal(carriers.notices.delivered, 1);
  assert.equal(carriers.notices.byShare["0.25"], 1);
  assert.equal(carriers.notices.chars, 300);
  assert.equal(carriers.carrierBytes.riderChars, 800);
  assert.equal(carriers.carrierBytes.lastCallChars, 1_780);
  assert.equal(carriers.carrierBytes.noticeChars, 300);
  assert.equal(carriers.carrierBytes.totalChars, 2_880);
  // The empty run reports the lens, not its absence.
  assert.equal(contextEventMetrics([]).guidanceCarriers.lastCall.exposures, 0);
  assert.equal(contextEventMetrics([]).guidanceCarriers.lastCall.responseRate, null);
  // The lens rides into every adjudicated report through contextEventMetrics.
  assert(adjudicator.includes("contextEventMetrics(runEntries)"),
    "the adjudicator must compute the guidance-carrier lenses from the event stream");
  checks.guidanceCarrierLensesAdjudicated = true;
}

// ---------------------------------------------------------------------------
// GATE 47 - the surfacing lens, under the same contract. A carrier without its lens is
// a carrier nobody can grade, so the slate ships with one row per suggestion joined to
// the outcome the runtime gave it, and first-hop peek precision is derivable per arm.
// memex's fold lane accepted at 2.2%; that number travels with the metric because it is
// the floor this design exists to beat, not a trophy.
// ---------------------------------------------------------------------------
{
  const custom = (data) => ({ type: "custom", customType: "pi-fold-context-event", data });
  const suggestion = (seq, ordinal, foldId, carrier, chars) => custom({
    kind: "context.suggestion", seq, ordinal, carrier, fold_id: foldId,
    content_score: 0.42, brief_score: 0.05, margin: 0.37, content_hit: 0.25, brief_hit: 0.15,
    divergence_margin: 0.1, slot: 0, slate_size: 1, fold_depth: 0,
    considered: 12, divergent: 2, suppressed: 1, intent_terms: 9, chars,
  });
  const entries = [
    suggestion(1, 10, "fold_a", "lastcall", 300),
    custom({ kind: "context.outcome", seq: 2, ordinal: 14, fold_id: "fold_a",
      from_outcome: "shown", outcome: "acted", outcome_ordinal: 14, window_ordinals: 12 }),
    custom({ kind: "context.outcome", seq: 3, ordinal: 27, fold_id: "fold_a",
      from_outcome: "acted", outcome: "used", outcome_ordinal: 27, window_ordinals: 12 }),
    suggestion(4, 30, "fold_b", "rider", 280),
    custom({ kind: "context.outcome", seq: 5, ordinal: 43, fold_id: "fold_b",
      from_outcome: "shown", outcome: "ignored", outcome_ordinal: 43, window_ordinals: 12 }),
    // Issued late: the run ended inside its window, which is an open row, not a miss.
    suggestion(6, 50, "fold_c", "lastcall", 290),
  ];
  const lens = contextEventMetrics(entries).guidanceCarriers.surfacing;
  assert.equal(lens.issued, 3);
  assert.equal(lens.acted, 1);
  assert.equal(lens.used, 1);
  assert.equal(lens.ignored, 1);
  assert.equal(lens.open, 1);
  assert.equal(lens.firstHopPeekPrecision, 1 / 3);
  assert.equal(lens.usedRate, 1 / 3);
  assert.equal(lens.memexFoldLaneAcceptRate, MEMEX_FOLD_LANE_ACCEPT_RATE);
  assert.equal(lens.beatsMemexFoldLane, true);
  assert.equal(lens.suppressionTransitions, 3);
  // Both channel scores, the divergence and the slate position are on every row: this
  // IS the bandit's training data, and a row that dropped them would be unlearnable.
  const [first] = lens.table;
  assert.equal(first.foldId, "fold_a");
  assert.equal(first.carrier, "lastcall");
  assert.equal(first.contentScore, 0.42);
  assert.equal(first.briefScore, 0.05);
  assert.equal(first.margin, 0.37);
  assert.equal(first.slot, 0);
  assert.equal(first.outcome, "used", "the grade must be the offer's TERMINAL outcome");
  assert.equal(lens.table[2].outcome, "open");
  assert.equal(lens.byCarrier.lastcall.issued, 2);
  assert.equal(lens.byCarrier.lastcall.used, 1);
  assert.equal(lens.byCarrier.rider.ignored, 1);
  // Per-carrier byte overhead: the slate's bytes are counted, and counted as riding the
  // carriers rather than as a carrier of their own, because that is what they do.
  const carrierBytes = contextEventMetrics(entries).guidanceCarriers.carrierBytes;
  assert.equal(carrierBytes.surfacingChars, 870);
  assert(carrierBytes.definition.includes("ALREADY INSIDE"));
  // The empty run reports the lens, not its absence.
  assert.equal(contextEventMetrics([]).guidanceCarriers.surfacing.issued, 0);
  assert.equal(contextEventMetrics([]).guidanceCarriers.surfacing.firstHopPeekPrecision, null);
  assert(adjudicator.includes("contextEventMetrics(runEntries)"),
    "the adjudicator must compute the surfacing lens from the event stream");
  checks.surfacingLensAdjudicated = true;
}

// ---------------------------------------------------------------------------
// GATE 29 - the observability capture is threaded end to end: the extension logs
// bounded arguments on every tool call and logs FAILED context calls as rows rather
// than anonymous errors, the runtime's attempt records carry the tool_call_id join
// key, the worker reports pending marks at run end, and the adjudicator joins the two
// streams by id and surfaces end-of-run curation state.
// ---------------------------------------------------------------------------
{
  assert(extension.includes("argumentsJson: safeArgumentsJson(event.input)"),
    "the extension no longer logs bounded tool-call arguments");
  assert(!extension.includes("event.isError !== true"),
    "the extension still skips failed context calls in the context-tool-result stream");
  assert(extension.includes("isError: event.isError === true,") &&
    extension.includes("? toolResultText(event.content ?? event.result?.content ?? null).slice(0, 512)"),
  "failed context calls must land as rows with bounded error text");
  const runtime = source("extensions/active-context.ts");
  assert(runtime.includes("tool_call_id: toolCallId,"),
    "context.attempt records must carry the tool_call_id join key");
  assert(worker.includes("pendingAgentMarks: (activeState.pendingMarks ?? [])"),
    "the worker must report pending agent marks at run end");
  assert(adjudicator.includes('joinKey: "tool_call_id"') &&
    adjudicator.includes("emittedWithoutAttempt") &&
    adjudicator.includes("pendingAgentMarks: workerReport?.foldSummary?.pendingAgentMarks"),
  "the adjudicator must join model-emitted calls to runtime attempts by id and surface end-of-run state");
  checks.observabilityThreadedEndToEnd = true;
}

// ---------------------------------------------------------------------------
// GATE 30 - the conversation-recall instrument is threaded end to end: the stager
// weaves seeded code words and refuses corpus collisions over the WHOLE checkout,
// probe ids are wave-scoped, the symbol index spans every text file in the tree,
// the grader forwards the class split, and the adjudicator reports parse rates
// per class before anyone opens the blind packet.
// ---------------------------------------------------------------------------
{
  assert(staging.includes("stageCodeWords(seed, EXPERIMENT_MODE_PLANS[mode].stageCount)"),
    "the stager must generate one seeded code word per stage");
  assert(staging.includes("codeWordSentence(ordinal, codeWord)"),
    "the stager must weave the code word into the stage instructions");
  assert(staging.includes("collectCheckoutDefinitions(checkoutDir,\n        [...codeWords, ...reissueWords, ...ledgerTokensOf(ledger)])") &&
    staging.includes("uniqueIdentifierIndex(checkoutDefinitions.entries)") &&
    staging.includes("checkoutPaths: checkoutDefinitions.paths"),
  "symbol uniqueness, planted-word collisions (code words AND ledger tokens), and include " +
  "resolution must be judged over the whole checkout");
  assert(staging.includes("const codeWord = isProbe ? null : codeWords[ordinal - 1];"),
    "probe stages must carry no code word");
  assert(staging.includes("usedCarrierStages"),
    "the carrier no-reuse set must span the whole plan, not one wave");
  assert(staging.includes("id: `probe-${String(ordinal).padStart(2, \"0\")}-${String(index + 1).padStart(2, \"0\")}`"),
    "probe ids must be wave-scoped so the grading join is by id, never by position");
  assert(staging.includes("...visibleStage(stage)"),
    "the stager's payload hash must strip hidden keys through the shared helper");
  assert(grader.includes('class: "conversation"') && grader.includes('class: "repository"') &&
    grader.includes("sourceStage: probe.sourceStage"),
  "the grader must forward the probe class split and the carrier stage");
  assert(adjudicator.includes("probeClassSummary"),
    "the adjudicator must report per-class parse rates");
  // The version bump found its first drift victim: the worker's sealed manifest
  // carried a literal 1 and died at validation on every arm of the first v2 launch.
  assert(worker.includes("version: EXPERIMENT_PROTOCOL_VERSION,"),
    "the worker manifest version must be the protocol constant, never a literal");
  // The answer pattern accepts the wave-scoped ids the sessions will actually echo.
  const pattern = probeAnswerPattern("probe-16-01");
  assert.equal(pattern.exec("probe-16-01: cw-ab12cd")?.[1], "cw-ab12cd");
  assert.equal(pattern.exec("- probe-16-01 - cw-ab12cd")?.[1], "cw-ab12cd");
  assert.equal(pattern.exec("probe-16-02: nope"), null);
  checks.conversationRecallInstrumentThreadedEndToEnd = true;
}

// ---------------------------------------------------------------------------
// GATE 31 - ONE strip helper, FOUR call sites. The supervisor's hand-rolled strip
// kept only three hidden keys while the other three sites kept four: harmless only
// because stagePayloadText renders id and question alone. A hidden field added
// under protocol v3 must be strippable by changing exactly one list.
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...HIDDEN_PROBE_KEYS],
    ["expectedAnswer", "sourcePath", "sourceLine", "sourceStage"]);
  const dirty = {
    ordinal: 5,
    probes: [{
      id: "probe-05-01", kind: "stage-fact", question: "q",
      expectedAnswer: "a", sourcePath: "p", sourceLine: 3, sourceStage: 2,
    }],
  };
  const clean = visibleStage(dirty);
  assert.deepEqual(clean.probes[0], { id: "probe-05-01", kind: "stage-fact", question: "q" });
  // The payload gate refuses EVERY hidden key, not only expectedAnswer.
  for (const key of HIDDEN_PROBE_KEYS) {
    assert.throws(() => stagePayloadText({
      ordinal: 5, kind: "probe", instructions: "x", files: [],
      probes: [{ id: "probe-05-01", kind: "stage-fact", question: "q", [key]: "leak" }],
    }), /still carries probe ground truth/, `payload gate ignores hidden key ${key}`);
  }
  // Every strip site goes through the ONE helper; no hand-rolled destructuring remains.
  for (const [name, text] of [
    ["stager", staging], ["supervisor", supervisor],
    ["lib", source("scripts/lib/pi_context_experiment.mjs")],
    ["verifier", source("scripts/verify_pi_context_experiment.mjs")],
  ]) {
    assert(text.includes("visibleStage("), `${name} does not use the shared strip helper`);
  }
  const handRolled = /expectedAnswer:\s*_/;
  assert(!handRolled.test(staging) && !handRolled.test(supervisor),
    "a hand-rolled probe strip survives outside the shared helper");
  checks.oneStripHelperFourCallSites = true;
}

// ---------------------------------------------------------------------------
// GATE 32 - audit hop alphabet and trace construction. ONE evaluator serves the
// stager and the adjudicator; construction is seeded, deterministic, and obeys
// the forced cycle, strictly increasing stages, and knowability at every step.
// ---------------------------------------------------------------------------
{
  // The declared counting rule: spaced "#  include" counts, #if blocks count,
  // angle-bracket includes never count.
  assert.deepEqual(quotedIncludeSpecs([
    "#include \"alpha.h\"",
    "#include <system.h>",
    "#ifdef GUARD",
    "  #  include \"beta.h\"",
    "#endif",
    "// #include \"comment.h\"",
  ].join("\n")), ["alpha.h", "beta.h"]);
  // Resolution: dir-relative first, then unique basename, ambiguity refused.
  const resolve = buildIncludeResolver([
    "lib/deep/alpha.h", "lib/alpha.h", "lib/only.h", "src/dupe.h", "lib/dupe.h",
  ]);
  assert.equal(resolve("lib/deep/user.c", "alpha.h"), "lib/deep/alpha.h");
  assert.equal(resolve("src/user.c", "only.h"), "lib/only.h");
  assert.equal(resolve("lib/x/user.c", "dupe.h"), null);
  // Synthetic delivery: 6 payload stages of 3 files with an include web dense
  // enough that seeds have genuine choices to diverge over.
  const web = new Map();
  const stages = Array.from({ length: 8 }, (_, index) => {
    const ordinal = index + 1;
    if ([4, 8].includes(ordinal)) return { ordinal, kind: "probe", files: [] };
    const files = ["x", "y", "z"].map((tag) => ({ path: `s${ordinal}/${tag}.c` }));
    return { ordinal, kind: "read", files };
  });
  const paths = stages.flatMap((stage) => stage.files.map((file) => file.path));
  for (const [position, path] of paths.entries()) {
    web.set(path, [paths[(position + 2) % paths.length], paths[(position + 5) % paths.length]]);
  }
  const includeTargets = (path) => web.get(path) ?? [];
  const shape = {
    stages, chainLength: 3, startAfters: [1],
    earlyLaw: { maxStage: 2, minLinks: 1 }, includeTargets,
  };
  const chains = buildAuditTraces({ ...shape, seed: "trace-seed" });
  assert.equal(chains.length, 1);
  assert.equal(chains[0].id, AUDIT_TRACE_IDS[0]);
  assert.deepEqual(chains[0].links.map((link) => link.hop), [...AUDIT_HOP_CYCLE]);
  let previousStage = 0;
  for (const [linkIndex, link] of chains[0].links.entries()) {
    assert(link.stage > previousStage, "step stages must strictly increase");
    assert(stages[link.stage - 1].kind !== "probe", "steps sit on payload stages only");
    previousStage = link.stage;
    // Every answer re-derives through the ONE evaluator.
    const delivery = {
      stageOfPath: new Map(stages.flatMap((stage) => stage.files.map((file) => [file.path, stage.ordinal]))),
      filesOfStage: new Map(stages.map((stage) => [stage.ordinal, stage.files.map((file) => file.path)])),
    };
    assert.equal(evaluateAuditHop({
      hop: link.hop, hopIndex: link.hopIndex, input: link.input, delivery, includeTargets,
    }), link.expectedAnswer);
    if (linkIndex > 0) assert.equal(link.input, chains[0].links[linkIndex - 1].expectedAnswer);
  }
  // Same seed, same chains; over a seed set, at least one construction differs.
  assert.deepEqual(buildAuditTraces({ ...shape, seed: "trace-seed" }), chains);
  const baseline = JSON.stringify(chains);
  assert(["s-a", "s-b", "s-c", "s-d"].some((seed) =>
    JSON.stringify(buildAuditTraces({ ...shape, seed })) !== baseline),
  "audit trace construction ignores its seed");
  // Evaluator refusals: unknown hops and out-of-range indexes throw, never guess.
  const delivery = {
    stageOfPath: new Map([["s1/x.c", 1]]),
    filesOfStage: new Map([[1, ["s1/x.c"]]]),
  };
  assert.throws(() => evaluateAuditHop({ hop: "DEF", hopIndex: 1, input: "s1/x.c", delivery, includeTargets }),
    /Unknown audit hop/);
  assert.throws(() => evaluateAuditHop({ hop: "SOF", hopIndex: null, input: "ghost.c", delivery, includeTargets }),
    /never delivered/);
  assert.throws(() => evaluateAuditHop({ hop: "FIN", hopIndex: 2, input: 1, delivery, includeTargets }),
    /needs file 2/);
  assert.throws(() => evaluateAuditHop({ hop: "INC", hopIndex: 9, input: "s1/x.c", delivery, includeTargets }),
    /resolvable quoted include/);
  checks.auditHopEvaluatorSharedSeededAndDeterministic = true;
}

// ---------------------------------------------------------------------------
// GATE 33 - exhaustion refuses, never shortens. A corpus with no include web
// cannot host a 3-link chain, and an unsatisfiable early law is a refusal too:
// a variable-length chain would make the wave schedule non-uniform across seeds.
// ---------------------------------------------------------------------------
{
  const stages = Array.from({ length: 8 }, (_, index) => {
    const ordinal = index + 1;
    if ([4, 8].includes(ordinal)) return { ordinal, kind: "probe", files: [] };
    return { ordinal, kind: "read", files: [{ path: `s${ordinal}/only.c` }, { path: `s${ordinal}/more.c` }] };
  });
  assert.throws(() => buildAuditTraces({
    stages, seed: "dry-seed", chainLength: 3, startAfters: [1],
    earlyLaw: { maxStage: 2, minLinks: 1 }, includeTargets: () => [],
  }), /unconstructible/);
  // Early law: no step can ever sit at stage 1, so maxStage 1 must refuse even
  // though the chain itself is constructible.
  const paths = stages.flatMap((stage) => stage.files.map((file) => file.path));
  const web = new Map(paths.map((path, position) => [path, [paths[(position + 3) % paths.length]]]));
  assert.throws(() => buildAuditTraces({
    stages, seed: "late-seed", chainLength: 3, startAfters: [1],
    earlyLaw: { maxStage: 1, minLinks: 1 }, includeTargets: (path) => web.get(path) ?? [],
  }), /chain links landed/);
  checks.auditTraceExhaustionRefusesNeverShortens = true;
}

// ---------------------------------------------------------------------------
// GATE 34 - the chain laws bind steps to the plan and reject tamper. The step
// sentences are pinned literally: they carry the declared counting and
// resolution rules, and a silent rewording would change the instrument.
// ---------------------------------------------------------------------------
{
  const [sofStep, finStep, incStep] = plan.stages
    .filter((stage) => stage.chainStep !== null)
    .map((stage) => stage.chainStep);
  assert.equal(auditStepSentence(sofStep),
    "AUDIT TRACE trace-a, step 01: which stage of this session delivered the file " +
    "stage-1.rs? Record it on its own line as `trace-a-01: <stage number>`.");
  assert.equal(auditStepSentence(finStep),
    "AUDIT TRACE trace-a, step 02: name the 2nd file delivered in the stage you " +
    "recorded as trace-a-01, counting files in the order that stage delivered them. " +
    "Record it on its own line as `trace-a-02: <repository-relative path>`.");
  assert.equal(auditStepSentence(incStep),
    "AUDIT TRACE trace-a, step 03: open the file you recorded as trace-a-02 and name " +
    "the target of its 1st quoted include. Count every line whose first non-space " +
    "characters are `#include` (whitespace after `#` allowed) followed by a " +
    "double-quoted path, in file order, including lines inside `#if` blocks. Give the " +
    "target repository-relative: resolve it against the including file's directory " +
    "first, and otherwise as the unique file in the checkout with that basename. " +
    "Record it on its own line as `trace-a-03: <repository-relative path>`.");
  // The step answer line parses with the probe parser: no new parser, no new law.
  assert.equal(probeAnswerPattern("trace-a-02").exec("trace-a-02: stage-1-extra.rs")?.[1],
    "stage-1-extra.rs");
  const rehash = (mutated) => {
    mutated.planSha256 = stagePlanSha256(mutated);
    return mutated;
  };
  const noChains = rehash(structuredClone(plan));
  noChains.chains = [];
  assert.throws(() => validateStagePlan(rehash(noChains)), /chain count disagrees/);
  const ontoProbe = structuredClone(plan);
  ontoProbe.chains[0].links[2].stage = 4;
  assert.throws(() => validateStagePlan(rehash(ontoProbe)), /strictly later payload stage/);
  const brokenChain = structuredClone(plan);
  brokenChain.chains[0].links[1].input = 99;
  assert.throws(() => validateStagePlan(rehash(brokenChain)), /does not consume the previous answer/);
  const liedSof = structuredClone(plan);
  liedSof.chains[0].links[0].expectedAnswer = 2;
  assert.throws(() => validateStagePlan(rehash(liedSof)), /disagrees with the delivery map/);
  const repeatedNode = structuredClone(plan);
  repeatedNode.chains[0].links[1].hopIndex = 1;
  repeatedNode.chains[0].links[1].expectedAnswer = "stage-1.rs";
  repeatedNode.chains[0].links[2].input = "stage-1.rs";
  assert.throws(() => validateStagePlan(rehash(repeatedNode)), /repeats node/);
  const strayStep = structuredClone(plan);
  strayStep.stages[5].chainStep = { ...strayStep.stages[1].chainStep };
  assert.throws(() => validateStagePlan(rehash(strayStep)), /no chain claims/);
  const unwoven = structuredClone(plan);
  unwoven.stages[1].instructions =
    unwoven.stages[1].instructions.replace(auditStepSentence(sofStep), "").trim();
  assert.throws(() => validateStagePlan(rehash(unwoven)), /chain step disagrees/);
  const leakyRevisit = structuredClone(plan);
  const revisit = leakyRevisit.stages.find((stage) => stage.kind === "revisit");
  revisit.instructions += " cross-reference specifically stage 1 (stage-1.rs, stage-1-extra.rs)";
  assert.throws(() => validateStagePlan(rehash(leakyRevisit)), /names a chain stage node/);
  checks.auditTraceLawsBindStepsAndRejectTamper = true;
}

// ---------------------------------------------------------------------------
// GATE 35 - step grading, end to end through the ONE evaluator. The self
// verdict re-runs the hop over the agent's OWN recorded predecessor, so
// "cannot do the derivation" and "lost the predecessor" separate: an agent that
// derives correctly from its own wrong value scores self-match on a link whose
// absolute verdict is a mismatch.
// ---------------------------------------------------------------------------
{
  assert.equal(normalizeTraceAnswer("  `lib/rand.h`. "), "lib/rand.h");
  assert.equal(normalizeTraceAnswer("\"7\","), "7");
  assert.equal(normalizeTraceAnswer(null), null);
  // Presentation forms of the SAME value, which the grader must not read as a
  // miss (Shane 2026-08-14). Emphasis, a leading ./, and a trailing line
  // position on a path.
  assert.equal(normalizeTraceAnswer("**lib/vtls/gtls.h**"), "lib/vtls/gtls.h");
  assert.equal(normalizeTraceAnswer("_lib/vtls/gtls.h_"), "lib/vtls/gtls.h");
  assert.equal(normalizeTraceAnswer("./lib/vtls/gtls.h"), "lib/vtls/gtls.h");
  assert.equal(normalizeTraceAnswer("`lib/vtls/gtls.h:43`"), "lib/vtls/gtls.h");
  assert.equal(normalizeTraceAnswer("lib/vtls/gtls.h:43:9"), "lib/vtls/gtls.h");
  // The line-suffix strip is confined to path-shaped values, so a
  // definition-line answer keeps its digits and a bare identifier is untouched.
  assert.equal(normalizeTraceAnswer("43"), "43");
  assert.equal(normalizeTraceAnswer("Curl_gtls_shared_creds_free"), "Curl_gtls_shared_creds_free");
  // The other direction, which is the property that matters: nothing above may
  // collapse two DIFFERENT values together. Both are the real mismatches from
  // the sol-20260814-deployment pifold arm, and both must stay mismatches.
  assert.notEqual(normalizeTraceAnswer("lib/vtls/gtls.c"), normalizeTraceAnswer("lib/vtls/gtls.h"));
  assert.notEqual(normalizeTraceAnswer("cw-509a30"), normalizeTraceAnswer("cw-668aac"));
  assert.notEqual(normalizeTraceAnswer("lib/vtls/gtls.h"), normalizeTraceAnswer("lib/vtls/gtls2.h"));
  assert.equal(probeClassOf("stage-fact"), "conversation");
  assert.equal(probeClassOf("chain-link"), "derived");
  assert.equal(probeClassOf("derivation-control"), "derived");
  assert.equal(probeClassOf("definition-line"), "repository");
  const entriesOf = (script) => {
    const entries = [];
    let entryId = 0;
    for (const [text, toolCallId, stage] of script) {
      entries.push({
        id: `entry-${String(entryId += 1).padStart(3, "0")}`, type: "message",
        message: {
          role: "assistant",
          content: [
            ...(text ? [{ type: "text", text }] : []),
            ...(toolCallId ? [{ type: "toolCall", id: toolCallId, name: "repo_stage", arguments: {} }] : []),
          ],
        },
      });
      if (stage !== undefined) {
        entries.push({
          id: `entry-${String(entryId += 1).padStart(3, "0")}`, type: "message",
          message: {
            role: "toolResult", toolName: "repo_stage", toolCallId, isError: false,
            content: [{ type: "text", text: `STAGE ${stage}` }], details: { stage },
          },
        });
      }
    }
    return entries;
  };
  // Steps sit at stages 2 (SOF), 3 (FIN) and 5 (INC). The agent records step 1
  // correctly, mis-copies step 2, then derives step 3 CORRECTLY from its own
  // wrong step-2 value.
  const entries = entriesOf([
    ["", "c1", 1], ["", "c2", 2],
    ["trace-a-01: `1`.", "c3", 3],
    ["trace-a-02: stage-1.rs", "c4", 4],
    ["", "c5", 5],
    ["notes\ntrace-a-03: stage-9.rs", "c6", 6],
    ["done"],
  ]);
  const transcripts = traceStepTranscripts({ entries, plan });
  assert.equal(transcripts.length, 1);
  assert.deepEqual(transcripts[0].steps.map((step) => [step.stepId, step.parsed]),
    [["trace-a-01", true], ["trace-a-02", true], ["trace-a-03", true]]);
  const selfWeb = (path) => path === "stage-1.rs" ? ["stage-9.rs"] : [];
  const verdicts = traceStepVerdicts({ transcripts, plan, includeTargets: selfWeb });
  assert.deepEqual(verdicts.chains[0].steps.map((step) => [step.verdictAbsolute, step.verdictSelf]), [
    ["match", "match"],
    ["mismatch", "mismatch"],
    ["mismatch", "match"],
  ]);
  assert.equal(verdicts.chains[0].integrityPrefix, 1);
  assert.deepEqual(verdicts.stepCompliance, { parsed: 3, total: 3 });
  // A pruned worktree reports not-evaluated for INC self, never a guess.
  const pruned = traceStepVerdicts({ transcripts, plan, includeTargets: () => null });
  assert.equal(pruned.chains[0].steps[2].verdictSelf, "not-evaluated");
  // A lost predecessor is its own outcome, distinct from a failed derivation.
  const skipped = entriesOf([
    ["", "c1", 1], ["", "c2", 2],
    ["trace-a-01: 1", "c3", 3],
    ["", "c4", 4], ["", "c5", 5],
    ["trace-a-03: stage-9.rs", "c6", 6],
    ["done"],
  ]);
  const skippedVerdicts = traceStepVerdicts({
    transcripts: traceStepTranscripts({ entries: skipped, plan }), plan, includeTargets: selfWeb,
  });
  assert.deepEqual(skippedVerdicts.chains[0].steps.map((step) => step.verdictSelf),
    ["match", "unanswered", "no-predecessor"]);
  // A step recorded after its consumer's stage is not a step: the value could
  // not have informed the chain, so the window closes at the next step's stage.
  const late = entriesOf([
    ["", "c1", 1], ["", "c2", 2], ["", "c3", 3],
    ["trace-a-01: 1"],
  ]);
  const lateSteps = traceStepTranscripts({ entries: late, plan }).flatMap((chain) => chain.steps);
  assert.equal(lateSteps[0].parsed, false);
  assert.equal(lateSteps[2].delivered, false);
  // The adjudicator threads the SHARED machinery: same transcripts, same
  // verdicts, the one evaluator inside them, and the derived class in the
  // parse-rate summary.
  assert(adjudicator.includes("traceStepTranscripts({ entries: runEntries, plan })") &&
    adjudicator.includes("traceStepVerdicts({ transcripts: auditTranscripts, plan, includeTargets })") &&
    adjudicator.includes("auditTraces,") &&
    adjudicator.includes("traceStepTranscriptSha256"),
  "the adjudicator must grade trace steps through the shared helpers");
  assert(adjudicator.includes('["conversation", "derived", "echo", "repository"]') &&
    adjudicator.includes("probeClassOf(answer.kind)"),
  "the adjudicator must report parse rates for the derived and echo classes");
  assert(adjudicator.includes("probeMechanicalVerdicts({ plan, transcripts: probes })") &&
    adjudicator.includes("probeVerdicts,"),
  "the adjudicator must report the mechanical headline verdicts");
  assert(source("scripts/lib/pi_context_experiment.mjs")
    .includes("expectedFromSelf = evaluateAuditHop({"),
  "the self verdict must re-derive through the ONE exported hop evaluator");
  checks.traceStepGradingSeparatesDerivationFromRecall = true;

  // Mechanical verdicts are the headline: exact match after the one normalizer,
  // stage answers numeric, chain-link rows carrying hop and lag, echo excluded.
  const verdictRows = probeMechanicalVerdicts({
    plan,
    transcripts: [{
      stage: 4,
      answers: [
        { probeId: "probe-04-01", kind: "chain-link", answerText: "stage 1", parsed: true },
        { probeId: "probe-04-02", kind: "stage-fact", answerText: "`cw-000001`", parsed: true },
        { probeId: "probe-04-03", kind: "definition-line", answerText: null, parsed: false },
      ],
    }, {
      stage: 8,
      answers: [
        { probeId: "probe-08-01", kind: "chain-link", answerText: "stage-1.rs", parsed: true },
        { probeId: "probe-08-02", kind: "echo", answerText: "whatever", parsed: true },
      ],
    }],
  });
  assert.deepEqual(verdictRows.map((row) => [row.probeId, row.verdict, row.hop, row.lag]), [
    ["probe-04-01", "match", "SOF", 2],
    ["probe-04-02", "match", null, null],
    ["probe-04-03", "unanswered", null, null],
    ["probe-08-01", "mismatch", "FIN", 5],
  ]);
  checks.mechanicalExactMatchIsTheHeadlineVerdict = true;
}

// ---------------------------------------------------------------------------
// GATE 36 - wave selection laws. Chain-link draws spread across chains and
// ages, echoes restate distinct earlier answers, and the derivation control
// never rides a chain file.
// ---------------------------------------------------------------------------
{
  const chains = [
    { id: "trace-a", links: [
      { index: 1, stage: 2, hop: "SOF", hopIndex: null, input: "a0", expectedAnswer: 1 },
      { index: 2, stage: 3, hop: "FIN", hopIndex: 2, input: 1, expectedAnswer: "a2" },
      { index: 3, stage: 5, hop: "INC", hopIndex: 1, input: "a2", expectedAnswer: "a3" },
    ] },
    { id: "trace-b", links: [
      { index: 1, stage: 6, hop: "SOF", hopIndex: null, input: "b0", expectedAnswer: 2 },
      { index: 2, stage: 7, hop: "FIN", hopIndex: 1, input: 2, expectedAnswer: "b2" },
      { index: 3, stage: 9, hop: "INC", hopIndex: 2, input: "b2", expectedAnswer: "b3" },
    ] },
  ];
  const probedLinks = new Set();
  const probedChains = new Set();
  const first = buildChainLinkProbes({
    chains, probeOrdinal: 16, seed: "w16", count: 2, probedLinks, probedChains,
  });
  assert.equal(first.length, 2);
  assert.notEqual(first[0].chainId, first[1].chainId, "one wave must not probe a chain twice");
  // Eligible pool at wave 16: five links, oldest third = stages 2 and 3.
  assert(first.some((probe) => probe.sourceStage <= 3), "the wave skipped the oldest third");
  const sofDraws = first.filter((probe) => probe.linkIndex === 1);
  assert(sofDraws.every((probe) => probe.question.includes("stage number")) &&
    first.filter((probe) => probe.linkIndex > 1)
      .every((probe) => probe.question.includes("repository-relative path")),
  "the answer form must follow the hop kind");
  assert.deepEqual(buildChainLinkProbes({
    chains, probeOrdinal: 16, seed: "w16", count: 2,
    probedLinks: new Set(), probedChains: new Set(),
  }), first, "chain-link selection ignores its seed inputs");
  // Once chain a is exhausted, the repeat-chain law cannot be satisfied and the
  // draw refuses rather than quietly dropping the law.
  assert.throws(() => buildChainLinkProbes({
    chains, probeOrdinal: 32, seed: "w32", count: 1,
    probedLinks: new Set(["trace-a:1", "trace-a:2", "trace-a:3"]),
    probedChains: new Set(["trace-a"]),
  }), /selection laws/);
  const echoedTargets = new Set();
  const earlierWaves = [{ probes: first.map((probe, position) => ({
    ...probe, id: `probe-16-0${position + 1}`,
  })) }];
  const echoes = buildEchoProbes({ earlierWaves, seed: "echo", count: 2, echoedTargets });
  assert.equal(echoes.length, 2);
  assert(echoes.every((probe) => !Object.hasOwn(probe, "expectedAnswer")),
    "an echo must never carry an expected answer");
  assert.notEqual(echoes[0].targetProbeId, echoes[1].targetProbeId);
  assert.throws(() => buildEchoProbes({ earlierWaves, seed: "echo-2", count: 1, echoedTargets }),
    /unechoed chain-link/);
  const control = buildDerivationControlProbes({
    stages: [{ ordinal: 1, kind: "read", files: [{ path: "a2" }, { path: "free.c" }] }],
    chains, seed: "control", count: 1,
    includeTargets: (path) => path === "free.c" ? ["inc.h"] : ["x.h"],
  });
  assert.equal(control[0].sourcePath, "free.c", "the control must never ride a chain file");
  assert.equal(control[0].expectedAnswer, "inc.h");
  checks.probeScheduleLawsSelectAcrossChainsAndAges = true;
}

// ---------------------------------------------------------------------------
// GATE 37 - anti-leak: no instruction surface may name a link answer at or
// after its step stage, nor pair an SOF/FIN link's stage with its path. File
// bodies are the corpus and are exempt.
// ---------------------------------------------------------------------------
{
  const rehash = (mutated) => {
    mutated.planSha256 = stagePlanSha256(mutated);
    return mutated;
  };
  const named = structuredClone(plan);
  named.stages[6].instructions += " compare against stage-1-extra.rs";
  assert.throws(() => validateStagePlan(rehash(named)), /names the answer/);
  const paired = structuredClone(plan);
  paired.stages[6].instructions += " cross-check stage 1 alongside stage-1.rs";
  assert.throws(() => validateStagePlan(rehash(paired)), /pairs trace-a link 1's stage and path/);
  checks.instructionSurfacesNeverLeakChainAnswers = true;

  // -------------------------------------------------------------------------
  // GATE 38 - echo grading. Consistency with the agent's OWN earlier answer is
  // the recall metric, truth sits beside it unsummed, and the money cell is
  // consistent-and-wrong: reproducing your own error is unfakeable event
  // recall, while inconsistent-but-right is re-derivation evidence.
  // -------------------------------------------------------------------------
  const echoWaves = (priorText, echoText) => [
    {
      stage: 4,
      answers: [{
        probeId: "probe-04-01", kind: "chain-link",
        answerText: priorText, parsed: priorText !== null,
      }],
    },
    {
      stage: 8,
      answers: [{
        probeId: "probe-08-02", kind: "echo",
        answerText: echoText, parsed: echoText !== null,
      }],
    },
  ];
  const cellOf = (priorText, echoText) => {
    const [row] = echoVerdicts({ plan, transcripts: echoWaves(priorText, echoText) });
    return [row.outcome, row.echoConsistent, row.priorCorrect, row.truthMatch];
  };
  assert.deepEqual(cellOf("1", "1"), ["consistent", true, true, true]);
  assert.deepEqual(cellOf("3", "3"), ["consistent", true, false, false],
    "consistent-and-wrong is the unfakeable event-recall cell");
  assert.deepEqual(cellOf("3", "1"), ["inconsistent", false, false, true],
    "inconsistent-but-right is re-derivation, never recall");
  assert.deepEqual(cellOf(null, "1"), ["unauthored", false, false, true]);
  assert.deepEqual(cellOf("1", null), ["unanswered", false, true, false]);
  // A stage-valued target is compared as a STRING for consistency: restating
  // "stage 1" when the prior said "1" is not verbatim recall.
  assert.deepEqual(cellOf("1", "stage 1"), ["inconsistent", false, true, true]);
  // Plan-side echo laws refuse a same-wave target and a smuggled answer.
  const rehash38 = (mutated) => {
    mutated.planSha256 = stagePlanSha256(mutated);
    return mutated;
  };
  const sameWave = structuredClone(plan);
  sameWave.stages[7].probes[1].targetProbeId = "probe-08-01";
  assert.throws(() => validateStagePlan(rehash38(sameWave)),
    /must target a distinct earlier chain-link probe/);
  const smuggled = structuredClone(plan);
  smuggled.stages[7].probes[1].expectedAnswer = "1";
  assert.throws(() => validateStagePlan(rehash38(smuggled)), /Invalid echo probe shape/);
  assert(adjudicator.includes("echoVerdicts({ plan, transcripts: probes })") &&
    adjudicator.includes("echoes,"),
  "the adjudicator must grade echoes through the shared helper");
  checks.echoConsistencyGradedBesideTruthNeverSummed = true;

  // -------------------------------------------------------------------------
  // GATE 39 - provenance from sealed artifacts. hoardCarry reads the compressed
  // representations symmetrically (fold briefs AND compaction summaries),
  // selfEcho reads the agent's own messages, producedBy attributes only on
  // deterministic links with everything else counted unattributed, and result
  // joins are by toolCallId even when entry order lies.
  // -------------------------------------------------------------------------
  const provenanceEntries = [];
  const provenancePush = (entry) => provenanceEntries.push(entry) - 1;
  const provenanceAssistant = (text, toolCalls = []) => provenancePush({
    type: "message",
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...toolCalls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
      ],
    },
  });
  const provenanceResult = (toolCallId, toolName, stage, text) => provenancePush({
    type: "message",
    message: {
      role: "toolResult", toolName, toolCallId, isError: false,
      content: [{ type: "text", text }],
      ...(stage === null ? {} : { details: { stage } }),
    },
  });
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    provenanceAssistant("", [[`c${ordinal}`, "repo_stage", {}]]);
    provenanceResult(`c${ordinal}`, "repo_stage", ordinal, `STAGE ${ordinal}`);
  }
  // Step recordings for links 1 and 2; a fold brief then CARRIES the step-2
  // value and the stage-1 code word forward, and a note re-authors the value.
  provenanceAssistant("trace-a-01: 1");
  provenanceAssistant("trace-a-02: stage-1-extra.rs");
  provenancePush({
    type: "custom", customType: "acme-fold-record",
    data: { fold: { brief: "folded span: cw-000001 and stage-1-extra.rs live here" } },
  });
  provenancePush({ type: "compaction", summary: "history condensed; nothing verbatim" });
  provenanceAssistant("note to self: stage-1-extra.rs matters");
  provenanceAssistant("", [["c4", "repo_stage", {}]]);
  provenanceResult("c4", "repo_stage", 4, "STAGE 4");
  // Recovery calls in the wave-4 window: a peek whose RESULT carries the
  // stage-fact answer, and a read of an unrelated path. The peek result is
  // written BEFORE the call entry to prove the join is by id, never by order.
  provenanceResult("c-peek", "pi_fold_context", null, "peeked span says cw-000001");
  provenanceAssistant("", [["c-peek", "pi_fold_context", { action: "peek" }]]);
  provenanceAssistant("", [["c-read", "read", { path: "unrelated.rs" }]]);
  provenanceResult("c-read", "read", null, "bytes of unrelated.rs");
  provenanceAssistant("probe-04-01: 1\nprobe-04-02: cw-000001\nprobe-04-03: unknown");
  const provenanceProbes = probeTranscripts({ entries: provenanceEntries, plan });
  const provenanceSteps = traceStepTranscripts({ entries: provenanceEntries, plan });
  const provenanceReport = probeProvenance({
    entries: provenanceEntries, plan, probes: provenanceProbes, steps: provenanceSteps,
  });
  const rowOf = (probeId) => provenanceReport.rows.find((row) => row.probeId === probeId);
  // chain-link probe-04-01: SOF answer "1" is numeric, so never scanned.
  assert.deepEqual(
    [rowOf("probe-04-01").scannable, rowOf("probe-04-01").hoardCarry, rowOf("probe-04-01").selfEcho],
    [false, null, null]);
  // stage-fact probe-04-02: the code word rode the fold brief (hoardCarry) but
  // was never re-authored by the agent (no selfEcho), and the answer is
  // attributed to the peek whose result contained it, joined by toolCallId.
  assert.deepEqual(
    [rowOf("probe-04-02").hoardCarry, rowOf("probe-04-02").selfEcho, rowOf("probe-04-02").producedBy],
    [true, false, "recovered"]);
  // repo probe-04-03: declined outranks every other attribution.
  assert.equal(rowOf("probe-04-03").producedBy, "declined");
  assert.deepEqual(provenanceReport.carriers.map((carrier) => carrier.kind),
    ["fold-brief", "compaction-summary"]);
  assert.equal(provenanceReport.waves[0].reads, 1);
  assert.equal(provenanceReport.waves[0].contextCalls, 1);
  // The step-2 value was hoard-carried AND self-echoed before any probe asked
  // for it: prove both detectors against the wave-8 chain-link probe by
  // extending the same session to wave 8 with an in-context answer.
  for (let ordinal = 5; ordinal <= 8; ordinal += 1) {
    provenanceAssistant("", [[`c${ordinal}`, "repo_stage", {}]]);
    provenanceResult(`c${ordinal}`, "repo_stage", ordinal, `STAGE ${ordinal}`);
  }
  provenanceAssistant("probe-08-01: stage-1-extra.rs\nprobe-08-02: 1\nprobe-08-03: stage-3.rs\nprobe-08-04: whatever");
  const extendedReport = probeProvenance({
    entries: provenanceEntries, plan,
    probes: probeTranscripts({ entries: provenanceEntries, plan }),
    steps: traceStepTranscripts({ entries: provenanceEntries, plan }),
  });
  const chainRow = extendedReport.rows.find((row) => row.probeId === "probe-08-01");
  assert.deepEqual(
    [chainRow.hoardCarry, chainRow.selfEcho, chainRow.producedBy],
    [true, true, "in-context"]);
  assert(extendedReport.rows.every((row) => row.kind !== "echo"),
    "echo probes have no provenance rows: their grading is consistency");
  assert(adjudicator.includes("probeProvenance({") && adjudicator.includes("provenance,"),
    "the adjudicator must report provenance from the shared helper");
  checks.provenanceAttributesOnlyOnDeterministicLinks = true;
}

// ---------------------------------------------------------------------------
// GATE 40 - closed-book floor session: the question list is every non-echo probe
// in wave order, the prompt is deterministic plan-derived bytes that never carry
// a session-event answer, the closed-book manifest round-trips its type while an
// arm manifest without one still validates, and a closed-book transcript grades
// through the SAME probeMechanicalVerdicts.
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...EXPERIMENT_SESSION_TYPES], ["arm", EXPERIMENT_CLOSED_BOOK_LABEL]);
  const questions = closedBookQuestions(plan);
  const nonEcho = plan.stages.flatMap((stage) =>
    stage.probes.filter((probe) => probe.kind !== "echo"));
  assert.deepEqual(questions.map((q) => q.id), nonEcho.map((probe) => probe.id),
    "closed-book questions are every non-echo probe in wave order");
  const prompt = closedBookPrompt(plan);
  assert.equal(prompt, closedBookPrompt(plan), "closed-book prompt bytes are deterministic");
  assert(closedBookSystemPrompt().length > 0);
  for (const q of questions) {
    assert(prompt.includes(`- ${q.id}: ${q.question}`), `closed-book prompt carries ${q.id}`);
  }
  assert(!prompt.includes("probe-08-02"), "echo questions never reach the closed-book prompt");
  // Session-event answers (code words, delivery order, chain values) must not be
  // derivable from the prompt itself: no conversation-class or chain-link expected
  // answer may appear anywhere in its bytes.
  for (const probe of nonEcho) {
    if (!["chain-link", "stage-fact", "stage-binding"].includes(probe.kind)) continue;
    if (typeof probe.expectedAnswer !== "string" || probe.expectedAnswer.length < 6) continue;
    assert(!prompt.includes(probe.expectedAnswer),
      `closed-book prompt leaks the answer to ${probe.id}`);
  }

  const closedManifest = {
    version: EXPERIMENT_PROTOCOL_VERSION,
    runId: "2026-08-09T00-00-00Z-closed-book-rep1-abcd1234",
    campaignId: "campaign-1",
    sessionType: EXPERIMENT_CLOSED_BOOK_LABEL,
    arm: EXPERIMENT_CLOSED_BOOK_LABEL,
    mode: "smoke",
    ordinal: 1,
    repetition: 1,
    seed: "0011223344556677",
    model: manifest.model,
    runtime: { ...manifest.runtime, activeContextEnabled: false, nativeCompactionEnabled: false },
    target: { repoKey: repo.key, url: repo.url, commit: repo.commit, treeSha256: "1".repeat(64) },
    plan: manifest.plan,
    questionsSha256: sha256Json(questions),
    createdWallMs: 1_800_000_000_000,
  };
  validateExperimentManifest(closedManifest);
  assert.throws(() => validateExperimentManifest({ ...closedManifest, arm: "pifold" }),
    /closed-book label/);
  assert.throws(() => validateExperimentManifest({ ...closedManifest, foldScheduling: "immediate" }),
    /closed-book manifest shape/i);
  assert.throws(() => validateExperimentManifest((({ questionsSha256: _q, ...rest }) => rest)(closedManifest)),
    /closed-book manifest shape|question-list hash/i);
  assert.throws(() => validateExperimentManifest({
    ...closedManifest, runtime: { ...closedManifest.runtime, activeContextEnabled: true },
  }), /claims a managed runtime/);
  assert.throws(() => validateExperimentManifest({
    ...closedManifest,
    target: { ...closedManifest.target, checkoutSha256: "1".repeat(64) },
  }), /target pin/);
  // Back-compat is the law, not luck: an arm manifest without a session type and one
  // stating "arm" explicitly both validate; an arm manifest may never claim the type.
  validateExperimentManifest(manifest);
  validateExperimentManifest({ ...manifest, sessionType: "arm" });
  assert.throws(() => validateExperimentManifest({ ...manifest, sessionType: "floor" }),
    /foreign session type/);

  const closedRunConfig = (({ guidance: _g, ledgerTasks: _l, querySeed: _q, ...rest }) => rest)({
    ...runConfig, sessionType: EXPERIMENT_CLOSED_BOOK_LABEL, arm: EXPERIMENT_CLOSED_BOOK_LABEL,
  });
  validateExperimentRunConfig(closedRunConfig);
  assert.throws(() => validateExperimentRunConfig({ ...closedRunConfig, arm: "native" }),
    /arm is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...closedRunConfig, foldScheduling: "immediate" }),
    /no referent/);

  const entries = [
    { type: "message", message: { role: "user", content: prompt } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text:
      "probe-04-01: 1\nprobe-04-02: not-the-word\nprobe-08-01: stage-1-extra.rs" }] } },
  ];
  const transcripts = closedBookTranscript({ entries, plan });
  assert(transcripts.flatMap((wave) => wave.answers).every((answer) => answer.kind !== "echo"),
    "closed-book transcripts never carry echo rows");
  const verdicts = probeMechanicalVerdicts({ plan, transcripts });
  const byId = new Map(verdicts.map((row) => [row.probeId, row.verdict]));
  assert.equal(byId.get("probe-04-01"), "match");
  assert.equal(byId.get("probe-04-02"), "mismatch");
  assert.equal(byId.get("probe-08-01"), "match");
  assert.equal(byId.get("probe-08-03"), "unanswered");
  assert(!byId.has("probe-08-02"), "echo probes never reach closed-book verdicts");
  checks.closedBookFloorGradesThroughTheSameVerdicts = true;
}

// ---------------------------------------------------------------------------
// GATE 48 - the rollback observability contract: the event kind ships with its
// adjudicator lens in the same build. Recovery FREQUENCY is one number and recovery
// COST is another, and neither is readable without joining the two records that make
// one episode: context.rollback is what left the branch, context.recovery is what the
// retried pass folded to make the shorter window fit. The join is by rollback_seq,
// never by order or clock, and an episode missing its fold-side half is reported
// rather than dropped, because that is what a retried request aborted before the
// projection budget leaves behind.
// ---------------------------------------------------------------------------
{
  const custom = (data) => ({ type: "custom", customType: "pi-fold-context-event", data });
  const entries = [
    // A recovered episode: rolled back, replayed, and folded down inside the budget.
    custom({ kind: "context.rollback", seq: 10, ordinal: 40, trigger: "session_before_compact",
      armed: true, disarm_reason: null, error_entry_id: "entry-a", old_leaf_id: "entry-a",
      new_leaf_id: "entry-parent", entries_abandoned: 1, occupancy_tokens_before: 49_700,
      tokens_rolled_back: 42, replayed: true, replay_skip_reason: null, notice_chars: 404,
      attempt_ordinal: 1, probes_passed: true }),
    // The ordinary commit of the retried pass did the folding, so the recovery loop's own
    // delta is zero and the episode's real cost is the freed count against the request
    // the provider refused. A lens reading the delta alone would price this rescue at 0.
    custom({ kind: "context.recovery", seq: 11, ordinal: 40, provider_status: 400, attempts: 1,
      tokens_before: 40_000, tokens_after: 40_000, budget_tokens: 50_400,
      margin_tokens: 2_520, recovered: true, rejected_tokens: 51_000, freed_tokens: 11_000,
      loop_reduced: false, rollback_seq: 10 }),
    // An unreplayable tail: the rollback still happened, the retry did not.
    custom({ kind: "context.rollback", seq: 20, ordinal: 55, trigger: "session_before_compact",
      armed: true, disarm_reason: null, error_entry_id: "entry-b", old_leaf_id: "entry-b",
      new_leaf_id: "entry-c", entries_abandoned: 2, occupancy_tokens_before: 52_000,
      tokens_rolled_back: 90, replayed: false,
      replay_skip_reason: "the rolled-back tail leaves 1 tool call(s) unanswered",
      notice_chars: 460, attempt_ordinal: 2, probes_passed: true }),
    custom({ kind: "context.recovery", seq: 21, ordinal: 55, provider_status: 400, attempts: 2,
      tokens_before: 52_000, tokens_after: 52_000, budget_tokens: 50_400,
      margin_tokens: 2_520, recovered: false, rejected_tokens: 52_000, freed_tokens: 0,
      loop_reduced: false, rollback_seq: 20 }),
    // A disarmed lane: nothing silent, and it never counts as a recovery.
    custom({ kind: "context.rollback", seq: 30, ordinal: 61, trigger: "message_end",
      armed: false, disarm_reason: "sessionManager.branch is missing", error_entry_id: null,
      old_leaf_id: null, new_leaf_id: null, entries_abandoned: 0, occupancy_tokens_before: 48_000,
      tokens_rolled_back: 0, replayed: false, replay_skip_reason: "lane-disarmed",
      notice_chars: 0, attempt_ordinal: 3, probes_passed: false }),
  ];
  const lens = contextEventMetrics(entries).rollback;
  assert.equal(lens.rollbacks, 3);
  assert.equal(lens.armed, 2);
  assert.equal(lens.disarmed, 1);
  assert.equal(lens.replayed, 1);
  assert.equal(lens.replayedShare, 0.5, "the replayed rate is measured over ARMED episodes only");
  assert.equal(lens.entriesAbandoned, 3);
  assert.equal(lens.tokensRolledBack, 132);
  assert.equal(lens.noticeChars, 404,
    "a skipped replay sends its notice to the user, so it is not window overhead");
  assert.equal(lens.byTrigger.session_before_compact, 2);
  assert.equal(lens.byTrigger.message_end, 1);
  assert.equal(lens.replaySkipReasons["lane-disarmed"], 1);
  assert.equal(Object.keys(lens.replaySkipReasons).length, 2);
  // The join, and the cost it makes readable.
  assert.equal(lens.join.joinKey, "rollback_seq");
  assert.equal(lens.join.recoveryRecords, 2);
  assert.equal(lens.join.joinedEpisodes, 2);
  assert.equal(lens.join.rollbacksWithoutRecovery, 1);
  assert.equal(lens.join.recoveriesWithoutRollback, 0);
  // RECOVERY COST IS MEASURED AGAINST THE REQUEST THAT WAS REFUSED, not against the
  // projection the recovery loop happened to start from. Both episodes here have a
  // loop-local delta of zero; only the freed count separates the rescue from the
  // unchanged request, and the cost number has to come from the same place the verdict
  // does or the two disagree on the same episode.
  assert.equal(lens.foldedTokensToRecover, 11_000);
  assert.equal(lens.unrecovered, 1);
  const first = lens.table[0];
  assert.equal(first.seq, 10);
  assert.equal(first.recoverySeq, 11);
  assert.equal(first.recovered, true);
  assert.equal(first.recoveredTokensBefore, 40_000);
  assert.equal(first.recoveredTokensAfter, 40_000);
  assert.equal(first.rejectedTokens, 51_000);
  assert.equal(first.recoveredFreedTokens, 11_000);
  assert.equal(lens.table[1].recoveredFreedTokens, 0,
    "an unchanged request cost nothing to not recover");
  // A stream from before the freed count exists still prices its episodes, from the only
  // number it carries.
  const legacy = contextEventMetrics([
    custom({ kind: "context.rollback", seq: 40, ordinal: 70, trigger: "session_before_compact",
      armed: true, disarm_reason: null, error_entry_id: "entry-d", old_leaf_id: "entry-d",
      new_leaf_id: "entry-e", entries_abandoned: 1, occupancy_tokens_before: 49_000,
      tokens_rolled_back: 40, replayed: true, replay_skip_reason: null, notice_chars: 400,
      attempt_ordinal: 1, probes_passed: true }),
    custom({ kind: "context.recovery", seq: 41, ordinal: 70, provider_status: 400, attempts: 1,
      tokens_before: 51_000, tokens_after: 40_000, budget_tokens: 50_400,
      margin_tokens: 2_520, recovered: true, rollback_seq: 40 }),
  ]).rollback;
  assert.equal(legacy.foldedTokensToRecover, 11_000, "a pre-freed-count stream lost its cost");
  assert.equal(legacy.table[0].recoveredFreedTokens, null);
  assert.equal(lens.table[2].recoverySeq, null, "a disarmed episode has no fold-side half");
  assert.equal(lens.table[2].disarmReason, "sessionManager.branch is missing");
  // A recovery with no rollback is a rejection recorded without a tree move, and it is
  // counted rather than silently joined to nothing.
  const orphan = contextEventMetrics([
    custom({ kind: "context.recovery", seq: 1, ordinal: 3, attempts: 1, tokens_before: 10,
      tokens_after: 5, recovered: true, rollback_seq: null }),
  ]).rollback;
  assert.equal(orphan.rollbacks, 0);
  assert.equal(orphan.join.recoveriesWithoutRollback, 1);
  // The empty run reports the lens, not its absence.
  assert.equal(contextEventMetrics([]).rollback.rollbacks, 0);
  assert.equal(contextEventMetrics([]).rollback.replayedShare, null);
  // The lens rides into every adjudicated report through contextEventMetrics.
  assert(adjudicator.includes("contextEventMetrics(runEntries)"),
    "the adjudicator must compute the rollback lens from the event stream");
  checks.rollbackLensAdjudicated = true;
}

// ---------------------------------------------------------------------------
// GATE 49 - a native compaction is recorded by OUTCOME, not by the hook firing. The
// pifold arm runs with pi's compaction ENABLED, because the runtime's overflow recovery
// lane arms off `session_before_compact`; there a fire is expected traffic, since the
// runtime cancels a threshold pass and converts an overflow pass into a tree rollback.
// What no arm but the native one may produce is a COMPLETED compaction, a summary that
// replaced the transcript. So: every pass is an event everywhere; a pass opens a
// stop-the-world record only where it runs to a summary; a pass latches on its own only
// where compaction is switched off and the hook therefore cannot fire legitimately; a
// completion latches everywhere except the arm whose datum it is. Driven through the real
// extension, on a real run directory, so the ledgers are the ones a run would seal.
// ---------------------------------------------------------------------------
{
  assert.deepEqual(nativeCompactionDisposition("pifold"),
    { latchOnPass: false, stopsTheWorld: false, latchOnCompletion: true });
  assert.deepEqual(nativeCompactionDisposition("native"),
    { latchOnPass: false, stopsTheWorld: true, latchOnCompletion: false });
  assert.deepEqual(nativeCompactionDisposition("unmanaged"),
    { latchOnPass: true, stopsTheWorld: false, latchOnCompletion: true });
  assert.throws(() => nativeCompactionDisposition("hybrid"), /Unknown arm/);

  const jitiPath = join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs");
  assert(existsSync(jitiPath), "could not resolve package-local jiti to drive the experiment extension");
  // The stage tool's parameter schema comes from typebox, which the harness gets from the
  // pi install the same way the worker resolves it. Resolving it here and not by luck means
  // a pi that moved the module fails this gate instead of a launched campaign.
  const typeboxPath = join(PI_INSTALL_ROOT, "node_modules", "typebox", "build", "index.mjs");
  assert(existsSync(typeboxPath), `the pi install does not carry typebox at ${typeboxPath}`);
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const { createPiContextExperimentExtension } = await createJiti(import.meta.url, {
    alias: { typebox: typeboxPath },
  }).import(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"));

  const readLedger = (runDir, name) => {
    const path = join(runDir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  // One pass, then optionally the completion, then shutdown so a stop-the-world record that
  // never saw another productive request is still flushed. Only the extension's own handler
  // is called: the runtime registers its own on the same events, and its cancel is what a
  // live pifold session would return, which is exactly the outcome being modelled here.
  const drive = (arm, { complete = false, branch = [] } = {}) => {
    const runDir = mkdtempSync(join(tmpdir(), `pi-fold-compaction-${arm}-`));
    const handlers = new Map();
    const pi = {
      on(name, handler) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(handler);
      },
      registerTool() {},
      registerCommand() {},
      sendMessage() {},
      async appendEntry() {},
    };
    createPiContextExperimentExtension({
      version: EXPERIMENT_PROTOCOL_VERSION,
      runId: `compaction-${arm}`,
      runDir,
      campaignId: "gate-49",
      arm,
      mode: "smoke",
      firstChallenge: "a".repeat(64),
      stageCount: EXPERIMENT_MODE_PLANS.smoke.stageCount,
      watchdogMs: EXPERIMENT_MODE_PLANS.smoke.watchdogMs,
    }).factory(pi);
    // The extension registers both compaction handlers at the TOP of its factory, before it
    // registers the runtime, and its own context projection handler after it. So the
    // experiment's compaction handler is first on its event and its context handler is last
    // on that one. The counts are pinned: a reordering that would send these events to the
    // runtime's handler instead fails here rather than silently measuring nothing.
    const registered = (name, expected) => {
      const list = handlers.get(name) ?? [];
      assert.equal(list.length, expected,
        `the ${name} registration shape changed; this gate would drive the wrong handler`);
      return list;
    };
    const runtimeShares = arm === "pifold" ? 2 : 1;
    registered("session_before_compact", runtimeShares)[0]({ reason: "threshold", willRetry: false });
    if (complete) {
      registered("session_compact", runtimeShares)[0]({
        reason: "threshold", willRetry: false, fromExtension: false,
        compactionEntry: { id: "compaction-entry-1" },
      });
    }
    if (branch.length > 0) {
      registered("context", runtimeShares).at(-1)({ messages: [] }, {
        signal: { aborted: false },
        sessionManager: { getBranch: () => branch, getLeafId: () => "leaf-1" },
      });
    }
    registered("session_shutdown", runtimeShares).at(-1)({ reason: "quit" });
    const result = {
      events: readLedger(runDir, "worker-events.jsonl"),
      failures: readLedger(runDir, "failure-latch.jsonl"),
      stops: readLedger(runDir, "stop-the-world.jsonl"),
    };
    rmSync(runDir, { recursive: true, force: true });
    return result;
  };

  // pifold: the fire is recorded and nothing else happens. No latch, no pause.
  const pifoldPass = drive("pifold");
  assert.deepEqual(pifoldPass.events.filter((event) => event.kind === "native-compaction-pass")
    .map((event) => event.details.reason), ["threshold"]);
  assert.equal(pifoldPass.failures.length, 0, "a cancelled pass is not a defect in the pifold arm");
  assert.equal(pifoldPass.stops.length, 0, "a cancelled pass stops no world");
  // pifold: a compaction that COMPLETED is the defect, and it says so by that name.
  const pifoldCompletion = drive("pifold", { complete: true });
  assert.deepEqual(pifoldCompletion.events.map((event) => event.kind).filter((kind) =>
    kind.startsWith("native-compaction")), ["native-compaction-pass", "native-compaction"]);
  assert.deepEqual(pifoldCompletion.failures.map((failure) => failure.phase),
    ["unexpected-native-compaction"]);
  assert.equal(pifoldCompletion.stops.length, 0);
  // native: the pass runs to a summary, so it pauses the run and latches nothing.
  const nativeCompletion = drive("native", { complete: true });
  assert.equal(nativeCompletion.failures.length, 0, "the native arm's compaction is its datum");
  assert.deepEqual(nativeCompletion.stops.map((record) => record.kind), ["native-compaction"]);
  assert.equal(nativeCompletion.stops[0].timeToFirstProductiveRequestMs, null,
    "an event that never saw another productive request records a null duration, not a made-up one");
  // unmanaged: compaction is switched off, so the fire alone is the defect.
  const unmanagedPass = drive("unmanaged");
  assert.deepEqual(unmanagedPass.failures.map((failure) => failure.phase),
    ["unexpected-native-compaction"]);
  assert.equal(unmanagedPass.stops.length, 0);
  // The branch is the second witness, and it carries the same outcome rule: the runtime
  // writes its decision and receipt entries from its own completion handler, so any of the
  // three entry types on the branch means a compaction finished.
  const compactionEntry = [{ type: "compaction", id: "compaction-entry-1" }];
  assert.deepEqual(drive("pifold", { branch: compactionEntry }).failures.map((failure) => failure.phase),
    ["unexpected-native-entry"]);
  assert.equal(drive("native", { branch: compactionEntry }).failures.length, 0);
  // The adjudicator judges the sealed run by the same rule, from the same helper.
  assert(adjudicator.includes("nativeCompactionDisposition(config.arm).latchOnCompletion"),
    "the adjudicator must derive its native-compaction invariant from the shared disposition");
  checks.nativeCompactionIsJudgedByOutcome = true;
}

// ---------------------------------------------------------------------------
// GATE 50 - fold briefs are MODEL-WRITTEN on the arm that folds, and the run says which
// model wrote them. The package writes briefs with a model and keeps the deterministic
// brief as the automatic failure fallback; the pifold arm registered the runtime with no
// generator wired, so every sealed run briefed deterministically and no artifact said so.
// The descriptor now travels config -> manifest -> registration exactly as the serving
// budget does, the adjudicator echoes it, and the per-fold provenance counts beside it say
// what the run actually got, so a rep that quietly fell back to the fallback is visible.
//
// Those counts are read at the END of the run (Shane 2026-08-11). A ladder fold commits
// with a deterministic brief and is upgraded to a model brief at a later commit boundary,
// and the fold record is immutable, so the creation-time count this gate used to pin
// reported the fallback for folds that finished the run model-briefed, potentially every
// one of them. The lens joins fold ids to the `brief_upgrade_ids` the commit records
// carry, and the second half of this gate pins that join.
// ---------------------------------------------------------------------------
{
  // The campaign pin is GONE (Shane 2026-08-14): the pifold arm runs with no
  // generator, measuring the condition both external reviews recommend making
  // permanent before any deletion of the upgrade lane. The descriptor VALIDATION
  // laws stay, because sealed runs carry descriptors and must keep reading; the
  // fixture descriptor below is a literal so this gate cannot depend on a pin
  // that no longer exists.
  const EXPERIMENT_BRIEF_GENERATOR = Object.freeze({
    provider: "openai-codex", model: "gpt-5.6-terra", effort: "medium",
  });

  // Only the arm that registers the runtime writes briefs, so only it may carry a
  // generator: on any other arm the descriptor would be a fact about nothing.
  validateExperimentRunConfig({ ...runConfig, arm: "pifold", briefGenerator: EXPERIMENT_BRIEF_GENERATOR });
  validateExperimentRunConfig(runConfig); // runs sealed before the descriptor existed
  for (const arm of ["native", "unmanaged"]) {
    assert.throws(() => validateExperimentRunConfig({
      ...runConfig, arm, briefGenerator: EXPERIMENT_BRIEF_GENERATOR,
    }), /carries a brief generator but registers no runtime/);
  }
  assert.throws(() => validateExperimentRunConfig({
    ...runConfig, arm: "closed-book", sessionType: "closed-book",
    briefGenerator: EXPERIMENT_BRIEF_GENERATOR,
  }), /arm-condition keys with no referent/);
  for (const malformed of [
    "session",
    { provider: "openai", model: "gpt-5.6-luna" },
    { provider: "openai", model: "gpt-5.6-luna", effort: "" },
    { provider: "openai", model: "gpt-5.6-luna", effort: "medium", temperature: 0 },
  ]) {
    assert.throws(() => validateExperimentRunConfig({
      ...runConfig, arm: "pifold", briefGenerator: malformed,
    }), /brief generator is not a provider\/model\/effort descriptor/, JSON.stringify(malformed));
  }
  validateExperimentManifest({ ...manifest, briefGenerator: EXPERIMENT_BRIEF_GENERATOR });
  validateExperimentManifest(manifest);
  assert.throws(() => validateExperimentManifest({
    ...manifest,
    arm: "native",
    runtime: {
      ...manifest.runtime,
      activeContextEnabled: armRuntimeConfiguration("native").activeContextEnabled,
      nativeCompactionEnabled: armRuntimeConfiguration("native").nativeCompactionEnabled,
    },
    briefGenerator: EXPERIMENT_BRIEF_GENERATOR,
  }), /claims a brief generator but registers no runtime/);
  assert.throws(() => validateExperimentManifest({
    ...manifest, briefGenerator: { provider: "openai" },
  }), /brief generator is not a provider\/model\/effort descriptor/);

  assert(!supervisor.includes("briefGenerator: EXPERIMENT_BRIEF_GENERATOR"),
    "the supervisor still pins a campaign generator, so the no-generator condition never runs");
  assert(!/EXPERIMENT_BRIEF_GENERATOR,/.test(supervisor),
    "the supervisor still imports the retired generator pin");
  // The generator is DELETED from the package (2026-08-14). No new manifest may carry
  // the field, so the worker no longer seals it, and the extension refuses a config
  // that still asks; the adjudicator keeps echoing what sealed runs recorded.
  assert(!worker.includes("briefGenerator: config.briefGenerator }"),
    "the worker still seals a brief generator the package cannot wire");
  assert(extension.includes("config.briefGenerator === undefined"),
    "the extension no longer refuses a config that asks for the deleted generator");
  assert(adjudicator.includes("briefGenerator: config.briefGenerator ?? null"),
    "the adjudicator must echo the run's brief generator into the evidence");
  // The intended regime and the observed one are different facts, and the evidence
  // carries both: a generator that failed every call leaves a full deterministic count.
  assert(adjudicator.includes("briefProvenance: endOfRunBriefProvenance(entries)"),
    "the adjudicator must read brief provenance through the end-of-run lens");

  // THE LENS READS THE END OF THE RUN, NOT THE MOMENT OF CREATION. A ladder fold commits
  // with a deterministic brief and is upgraded at a later commit boundary; the fold record
  // is immutable, so the upgrade rides that commit record's `brief_upgrade_ids` and a
  // creation-time count reports the fallback for a fold that ended the run model-briefed.
  const foldRecordEntry = (foldId, kind) => ({
    type: "custom",
    customType: `pi-fold-active-context${FOLD_RECORD_SUFFIX}`,
    data: { foldId, fold: { id: foldId, provenance: { kind } } },
  });
  const commitEntry = (fields) => ({
    type: "custom",
    customType: `pi-fold-${CONTEXT_EVENT_SUFFIX}`,
    data: { kind: "context.commit", applied_marks: 1, ...fields },
  });
  const creationTimeCount = (sealed) => sealed
    .filter((entry) => entry.customType.endsWith(FOLD_RECORD_SUFFIX))
    .reduce((result, entry) => {
      const kind = entry.data?.fold?.provenance?.kind ?? "unknown";
      result[kind] = (result[kind] ?? 0) + 1;
      return result;
    }, { model: 0, deterministic: 0 });

  const upgradedRun = [
    foldRecordEntry("fold_aaaaaaaaaaaaaaaaaaaaaaaa", "deterministic"),
    foldRecordEntry("fold_bbbbbbbbbbbbbbbbbbbbbbbb", "deterministic"),
    foldRecordEntry("fold_cccccccccccccccccccccccc", "supplied"),
    commitEntry({ brief_upgrades: 0, brief_upgrade_ids: "", brief_upgrade_failures: 0,
      brief_upgrades_waiting: 2 }),
    commitEntry({ brief_upgrades: 1, brief_upgrade_ids: "fold_aaaaaaaaaaaaaaaaaaaaaaaa",
      brief_upgrade_failures: 1, brief_upgrade_error: "brief upgrade: summarizer unavailable",
      brief_upgrades_waiting: 0 }),
  ];
  // ANTI-VACUITY. The reading this replaces is computed on the same fixture first: it
  // reports zero model briefs, so the joined number below cannot be passing by accident.
  const creationOnly = creationTimeCount(upgradedRun);
  assert.deepEqual(creationOnly, { model: 0, deterministic: 2, supplied: 1 });
  const joined = endOfRunBriefProvenance(upgradedRun);
  assert.equal(creationOnly.model, 0);
  assert.equal(joined.model, 1, "an upgraded fold must report the brief it ENDED the run with");
  // The fold nobody upgraded is untouched, and a kind the lane never handles is untouched.
  assert.equal(joined.deterministic, 1);
  assert.equal(joined.supplied, 1);
  assert.equal(joined.join.foldsUpgradedToModel, 1);
  assert.equal(joined.join.unmatchedUpgrades, 0);
  // A failure is a failure: counted, loud, and it moves nothing, because the fold kept the
  // deterministic brief its record states.
  assert.equal(joined.join.upgradeFailures, 1);
  assert.equal(joined.join.upgradesWaitingAtLastCommit, 0);

  // An upgrade naming a fold the run never sealed, and a fold named twice, are both
  // reported rather than counted: the join is by identity, deduplicated, so neither can
  // inflate the model bucket past the folds that exist.
  const strayRun = [
    foldRecordEntry("fold_aaaaaaaaaaaaaaaaaaaaaaaa", "deterministic"),
    commitEntry({ brief_upgrades: 2, brief_upgrade_failures: 0,
      brief_upgrade_ids: "fold_aaaaaaaaaaaaaaaaaaaaaaaa,fold_dddddddddddddddddddddddd" }),
    commitEntry({ brief_upgrades: 1, brief_upgrade_failures: 0,
      brief_upgrade_ids: "fold_aaaaaaaaaaaaaaaaaaaaaaaa" }),
  ];
  const stray = endOfRunBriefProvenance(strayRun);
  assert.equal(stray.model, 1);
  assert.equal(stray.deterministic, 0);
  assert.equal(stray.join.repeatedUpgradeIds, 1);
  assert.equal(stray.join.unmatchedUpgrades, 1);
  assert.deepEqual(stray.join.unmatchedUpgradeReasons, { "no-fold-record": 1 });
  assert.equal(stray.join.upgradesWaitingAtLastCommit, null,
    "a commit record with no waiting field states null, which is not the same as nothing owed");

  // THE PRE-LANE SHAPE. Every run sealed before the upgrade lane carries commit records
  // with no brief fields at all (verified against the sealed luna-20260810 rep 3 and
  // luna-20260807 rep 23 sessions), and those runs must read exactly as they always did.
  const preLaneRun = [
    foldRecordEntry("fold_aaaaaaaaaaaaaaaaaaaaaaaa", "deterministic"),
    foldRecordEntry("fold_bbbbbbbbbbbbbbbbbbbbbbbb", "deterministic"),
    commitEntry({ freed_tokens: 1_200 }),
  ];
  const preLane = endOfRunBriefProvenance(preLaneRun);
  const { join: preLaneJoin, generator: preLaneGenerator, ...preLaneKinds } = preLane;
  assert.deepEqual(preLaneKinds, creationTimeCount(preLaneRun));
  assert.deepEqual(preLaneKinds, { model: 0, deterministic: 2 });
  // A run that predates the generator-call record reports an empty rollup rather than a
  // missing one, so "no calls" and "not instrumented" read the same way they always did:
  // as zero, with the rates null rather than a fabricated 0.
  assert.equal(preLaneGenerator.calls, 0);
  assert.equal(preLaneGenerator.spansPerCall, null);
  assert.equal(preLaneGenerator.cureRate, null);

  // THE GENERATOR ROLLUP (Shane 2026-08-11: how often did agents cure, on which kind of
  // fold, and what did the summarizer spend). Four calls: a batch of automatic folds, its
  // cure, a consolidation on its own, and one call carrying both kinds.
  const briefEntry = (fields) => ({
    type: "custom",
    customType: `pi-fold-${CONTEXT_EVENT_SUFFIX}`,
    data: { kind: "context.brief", outcome: "ok", ...fields },
  });
  const rollup = endOfRunBriefProvenance([
    briefEntry({ group_spans: 0, leaf_spans: 6, source_chars: 60_000, brief_chars: 4_800,
      cure: false, usage: { input: 61_000, output: 900 } }),
    briefEntry({ group_spans: 0, leaf_spans: 2, source_chars: 20_000, brief_chars: 1_600,
      cure: true, usage: { input: 21_000, output: 300 } }),
    briefEntry({ group_spans: 1, leaf_spans: 0, source_chars: 180_000, brief_chars: 1_900,
      cure: false, usage: { input: 181_000, output: 400 } }),
    briefEntry({ group_spans: 1, leaf_spans: 3, source_chars: 90_000, brief_chars: 3_100,
      cure: false }),
    briefEntry({ outcome: "timeout", group_spans: 0, leaf_spans: 1, source_chars: 9_000 }),
  ]).generator;
  assert.equal(rollup.calls, 5);
  assert.equal(rollup.spans, 14);
  assert.equal(rollup.spansPerCall, 2.8, "the batching headline must be spans per call");
  assert.equal(rollup.cures, 1);
  assert.equal(rollup.curedSpans, 2);
  assert.equal(rollup.cureRate, 0.2);
  assert.deepEqual(rollup.outcomes, { ok: 4, timeout: 1 });
  // A pure-kind call lands in its own bucket; a call carrying both lands in neither, so no
  // token is ever attributed to a kind that did not spend it.
  assert.equal(rollup.byKind.automatic.calls, 3);
  assert.equal(rollup.byKind.automatic.spans, 9);
  assert.equal(rollup.byKind.automatic.usage.input, 82_000);
  assert.equal(rollup.byKind.consolidation.calls, 1);
  assert.equal(rollup.byKind.consolidation.usage.input, 181_000);
  assert.equal(rollup.byKind.mixed.calls, 1);
  assert.equal(rollup.byKind.mixed.spans, 4);
  assert.deepEqual(rollup.byKind.mixed.usage, {},
    "a mixed call reported no usage, so its bucket must state none rather than zero");
  // Usage that was never reported is counted as unknown, never as zero.
  assert.equal(rollup.byKind.mixed.callsWithoutUsage, 1);
  assert.equal(rollup.byKind.automatic.callsWithoutUsage, 1);
  // ANTI-VACUITY: the mixed call's tokens are absent from both pure buckets, which is the
  // whole reason the third bucket exists.
  assert.equal(
    rollup.byKind.automatic.usage.input + rollup.byKind.consolidation.usage.input, 263_000,
    "a mixed call's tokens leaked into a pure-kind bucket");
  assert.equal(preLaneJoin.upgradedFolds, 0);
  assert.equal(preLaneJoin.upgradeFailures, 0);
  assert.equal(preLaneJoin.upgradesWaitingAtLastCommit, null);
  // Both regimes present at zero on a run that folded nothing, which is the shape the
  // arms without the runtime report through this same lens.
  const empty = endOfRunBriefProvenance([]);
  assert.equal(empty.model, 0);
  assert.equal(empty.deterministic, 0);
  assert(adjudicator.includes("briefProvenance: endOfRunBriefProvenance(runEntries)"),
    "an arm that registers no runtime must report the same provenance shape");

  const jitiPath = join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs");
  assert(existsSync(jitiPath), "could not resolve package-local jiti to build the brief generator");
  const typeboxPath = join(PI_INSTALL_ROOT, "node_modules", "typebox", "build", "index.mjs");
  assert(existsSync(typeboxPath), `the pi install does not carry typebox at ${typeboxPath}`);
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const jiti = createJiti(import.meta.url, { alias: { typebox: typeboxPath } });
  // The counts the adjudicator reads come off the sealed fold record, so the record has
  // to carry the provenance in the first place.
  const persistence = await jiti.import(join(PROJECT, "extensions", "lib", "persistence.ts"));
  assert([...persistence.ACTIVE_FOLD_KEYS].includes("provenance"),
    "the sealed fold record no longer carries its brief provenance");

  // The refusal, driven rather than pattern-matched: a config that still asks for a
  // generator dies at extension creation, before any provider call, with the deletion
  // named; a config that asks for none constructs.
  const { createPiContextExperimentExtension } = await jiti.import(
    join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"));
  assert.throws(
    () => createPiContextExperimentExtension({
      arm: "pifold", briefGenerator: EXPERIMENT_BRIEF_GENERATOR,
    }),
    /briefGenerator is deleted: the runtime briefs deterministically as of 2026-08-14/,
    "a config carrying the deleted generator was not refused by name at extension creation");
  // The accept path stops at a LATER complaint, never this one: the same call minus the
  // descriptor must get past the refusal (the run-directory fields other gates supply are
  // absent here, so construction fails downstream, and that failure naming the generator
  // would mean the refusal fires on configs that ask for nothing).
  assert.throws(
    () => createPiContextExperimentExtension({ arm: "pifold" }),
    (error) => !/briefGenerator/.test(String(error)),
    "a generator-free config was refused as though it carried the deleted generator");
  checks.briefGeneratorRefusedAtRegistration = true;
}

// ---------------------------------------------------------------------------
// GATE 51 - a provider error the session RECOVERED from is the provider's weather, not
// the trial's result, and does not fail the run (Shane 2026-08-11). Pi retries a
// retryable assistant error by re-sending the same request after a backoff, having first
// removed the failed attempt from agent state while keeping it in the session as history,
// so the retried payload is byte-identical and the failed attempt bills zero tokens:
// nothing the trial measures moved. The latch counted every one of them anyway, which
// failed rep 1 of luna-20260810 after it completed every stage it planned, and would have
// failed rep 4 six times over while it ran clean.
//
// Held, not forgiven, and the gate's job is that distinction. An error only stops counting
// once a later assistant response actually succeeds; one still held when the session shuts
// down latches, because the run ended on it. Two exclusions keep the real failures red:
// the window wall is never weather (Pi will not retry it either, since context overflow is
// compaction's job), and only "error" is eligible, because an abort means something
// cancelled the run and "length" means the answer itself came back truncated. Rep 2 of
// this campaign died at the wall and MUST stay red, so that case is pinned by name.
//
// The recovery is reported rather than absorbed: a rep that stumbled forty times is a
// different quality of datum from one that never stumbled, and both reading as clean would
// be the real dishonesty.
// ---------------------------------------------------------------------------
{
  const jitiPath = join(PI_INSTALL_ROOT, "node_modules", "jiti", "lib", "jiti.mjs");
  const typeboxPath = join(PI_INSTALL_ROOT, "node_modules", "typebox", "build", "index.mjs");
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const { createPiContextExperimentExtension } = await createJiti(import.meta.url, {
    alias: { typebox: typeboxPath },
  }).import(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"));

  const readLines = (runDir, name) => {
    const path = join(runDir, name);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  // One assistant response per provider request, which is the shape the extension enforces:
  // a message_end with no request in flight is its own latch and would mask this one.
  const driveStops = (arm, stops) => {
    const runDir = mkdtempSync(join(tmpdir(), `pi-fold-weather-${arm}-`));
    const handlers = new Map();
    const pi = {
      on(name, handler) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(handler);
      },
      registerTool() {}, registerCommand() {}, sendMessage() {}, async appendEntry() {},
    };
    createPiContextExperimentExtension({
      version: EXPERIMENT_PROTOCOL_VERSION,
      runId: `weather-${arm}`,
      runDir,
      campaignId: "gate-51",
      arm,
      mode: "smoke",
      firstChallenge: "a".repeat(64),
      stageCount: EXPERIMENT_MODE_PLANS.smoke.stageCount,
      watchdogMs: EXPERIMENT_MODE_PLANS.smoke.watchdogMs,
    }).factory(pi);
    const ctx = {
      sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [] },
      // A whole descriptor, because gate 52 latches on one that states no window: this
      // fixture is exercising provider weather, and a request with healthy output headroom
      // is the condition under which weather is the only thing left to explain a failure.
      model: {
        provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 272_000, maxTokens: 128_000,
      },
      thinkingLevel: "xhigh",
      getSystemPrompt: () => "system",
      getEntries: () => [],
    };
    // The pifold arm puts the runtime on message_end and session_shutdown too, and the
    // experiment registers its own AFTER it, so the experiment's handler is the last one.
    // The counts are pinned: a reordering that would drive the runtime's handler instead
    // fails here rather than silently measuring nothing.
    const own = (name, expected) => {
      const list = handlers.get(name) ?? [];
      assert.equal(list.length, expected,
        `the ${name} registration shape changed; this gate would drive the wrong handler`);
      return list[list.length - 1];
    };
    const runtimeShares = arm === "pifold" ? 2 : 1;
    const request = own("before_provider_request", 1);
    const messageEnd = own("message_end", runtimeShares);
    for (const stop of stops) {
      request({ payload: { tools: [] } }, ctx);
      messageEnd({
        message: {
          role: "assistant",
          stopReason: stop.reason,
          errorMessage: stop.errorMessage ?? "",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
        },
      });
    }
    own("session_shutdown", runtimeShares)();
    return {
      failures: readLines(runDir, "failure-latch.jsonl"),
      events: readLines(runDir, "worker-events.jsonl"),
    };
  };

  const OVERLOAD = "Codex error: Our servers are currently overloaded. Please try again later.";
  const WALL = "Codex error: Your input exceeds the context window of this model.";

  // Rep 4's shape at full size: an overload, three more in one sequence, every one of them
  // answered by a later success. The run is clean and the weather is on the record.
  const recoveredRun = driveStops("pifold", [
    { reason: "toolUse" },
    { reason: "error", errorMessage: OVERLOAD },
    { reason: "toolUse" },
    { reason: "error", errorMessage: OVERLOAD },
    { reason: "error", errorMessage: OVERLOAD },
    { reason: "error", errorMessage: OVERLOAD },
    { reason: "toolUse" },
    { reason: "stop" },
  ]);
  assert.deepEqual(recoveredRun.failures, [],
    "a provider error the session recovered from must not fail the run");
  const recoveries = recoveredRun.events.filter((row) => row.kind === "provider-error-recovered");
  assert.equal(recoveries.length, 2, "each recovered sequence gets exactly one record");
  assert.deepEqual(recoveries.map((row) => row.details.attempts), [1, 3],
    "the record must carry what the sequence cost in failed attempts");
  // Anti-vacuity: the reading this gate replaces latched on this very run. Without it the
  // assertions above would pass on an extension that simply stopped latching anything.
  assert.equal(recoveredRun.events.filter((row) =>
    row.kind === "non-terminal-provider-response").length, 4,
  "the four errors must still be observed; only the verdict on them changed");
  const weather = providerWeather(recoveredRun.events);
  assert.equal(weather.recoveredSequences, 2);
  assert.equal(weather.recoveredAttempts, 4);
  assert.equal(weather.longestSequenceAttempts, 3);
  assert.equal(weather.nonTerminalStops, 4);

  // A recovered error costs the trial nothing in tokens and nothing in model input, but it
  // can still cost the whole prefix cache: the pinned transport rides WebSocket delta
  // requests, and a connection the error dropped re-sends the context cold. That lands on
  // pooled cache share, which is this campaign's headline, so it is counted rather than
  // absorbed. Rep 4 of luna-20260810 is the fixture's source: three cold restarts against
  // an unmoved projection, one restart whose cache survived.
  const responseLedger = (rows) => rows.flatMap((row) => [
    { kind: "context-projection", projectedChars: row.chars },
    { kind: "provider-request" },
    { kind: "provider-response", stopReason: row.stop, usage: { cacheRead: row.cacheRead, input: row.input } },
  ]);
  const cache = providerWeather([], responseLedger([
    // Cache intact across the stumble: the connection held.
    { stop: "toolUse", chars: 1000, cacheRead: 150_000, input: 3_000 },
    { stop: "error", chars: 1000, cacheRead: 0, input: 0 },
    { stop: "toolUse", chars: 1000, cacheRead: 152_000, input: 1_400 },
    // Cold restart: same projection either side, cache read fell to zero.
    { stop: "error", chars: 1000, cacheRead: 0, input: 0 },
    { stop: "toolUse", chars: 1000, cacheRead: 0, input: 163_000 },
    // The cache rebuilt, so the next stumble has something to lose again.
    { stop: "toolUse", chars: 1000, cacheRead: 160_000, input: 2_000 },
    // A fold moved the projection, so folding explains this miss just as well. The
    // experiment's own subject must never be laundered into the weather column.
    { stop: "error", chars: 1000, cacheRead: 0, input: 0 },
    { stop: "toolUse", chars: 400, cacheRead: 0, input: 84_000 },
  ]));
  assert.equal(cache.coldRestarts, 1, "only a miss against an unmoved projection is weather");
  assert.equal(cache.coldRestartFreshTokens, 163_000,
    "the fresh tokens a cold restart cost must be readable, not just its count");
  assert.equal(cache.cacheSurvivedRestarts, 1, "a stumble whose cache survived is not a cold restart");
  assert.equal(cache.unattributableCacheMisses, 1,
    "a miss a fold explains equally well is charged to neither column");

  // The cache half reads a run sealed before the recovery events existed, because it comes
  // off the provider ledger every run already carries. Pre-lane runs must not read as clean
  // weather simply because they predate the events.
  assert.equal(cache.recoveredSequences, 0, "no recovery events means no recovery counts");
  assert(cache.coldRestarts > 0, "but the cache reading still works without them");

  // The run ended on the error: nothing ever came back, so it was never survived.
  const strandedRun = driveStops("pifold", [
    { reason: "toolUse" },
    { reason: "error", errorMessage: OVERLOAD },
  ]);
  assert.equal(strandedRun.failures.length, 1, "an error the run never got past must latch");
  assert.equal(strandedRun.failures[0].phase, "provider-error-unrecovered");
  assert.deepEqual(providerWeather(strandedRun.events).recoveredSequences, 0,
    "an error that was never survived is a latch entry, never a recovery");

  // Rep 2 of luna-20260810 died here, and this is the case that must never be forgiven:
  // the wall is the one thing a managed arm exists to avoid. A later success does not
  // rescue it, which is exactly what separates it from weather.
  const wallRun = driveStops("pifold", [
    { reason: "error", errorMessage: WALL },
    { reason: "toolUse" },
    { reason: "stop" },
  ]);
  assert.equal(wallRun.failures.length, 1, "a window-overflow error must latch on a managed arm");
  assert.match(wallRun.failures[0].detail, /window-overflow/);
  assert.equal(providerWeather(wallRun.events).recoveredSequences, 0,
    "the wall must never be counted as weather the run recovered from");

  // An abort means something cancelled the run and a truncated answer is a changed answer.
  // Neither is the provider's weather, and a later success does not clear either.
  for (const reason of ["aborted", "length"]) {
    const run = driveStops("pifold", [
      { reason },
      { reason: "toolUse" },
      { reason: "stop" },
    ]);
    assert.equal(run.failures.length, 1, `a ${reason} stop must still latch`);
    assert.equal(run.failures[0].detail, reason);
  }

  // The unmanaged arm ends at the wall by design and latches none of this, and the native
  // arm's overflow breaths stay its own bounded lifecycle. Neither may be disturbed.
  assert.deepEqual(driveStops("unmanaged", [
    { reason: "error", errorMessage: WALL },
  ]).failures, [], "the unmanaged arm's overflow point is its datum, not a failure");
  const nativeBreaths = driveStops("native", [
    { reason: "error", errorMessage: WALL },
    { reason: "toolUse" },
    { reason: "stop" },
  ]);
  assert.deepEqual(nativeBreaths.failures, [],
    "a native overflow breath is compaction's lifecycle, bounded elsewhere by its budget");

  // The budget is pinned rather than ambient: retry settings otherwise come from whatever
  // the machine's settings files say, which is not a property a sealed run can state. Eight
  // because Pi's default of 3 was fully spent by one rep-4 sequence with no margin left.
  // The base is 1,000 because Pi's wait is `baseDelayMs * 2 ** (attempt - 1)` uncapped, so
  // the base sets the whole schedule: sol-20260811 rep 2 spent 16.5 minutes of 303 asleep
  // in backoff across 16 errored responses, in a run that ended two stages short.
  assert.deepEqual({ ...EXPERIMENT_PROVIDER_RETRY },
    { enabled: true, maxRetries: 8, baseDelayMs: 1_000 });
  // A fully spent budget must stay inside a few minutes of a run bounded at hours: the
  // schedule is the base doubling, so this is the property the base is chosen for.
  const spentMs = Array.from({ length: EXPERIMENT_PROVIDER_RETRY.maxRetries },
    (_unused, attempt) => EXPERIMENT_PROVIDER_RETRY.baseDelayMs * 2 ** attempt)
    .reduce((sum, value) => sum + value, 0);
  assert(spentMs <= 300_000,
    `a fully spent retry budget sleeps ${spentMs}ms, which is a wall-clock cost the run cannot absorb`);
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  assert(worker.includes("retry: { ...EXPERIMENT_PROVIDER_RETRY }"),
    "the worker must hand the pinned retry budget to the session it builds");
  assert(worker.includes("Run provider retry pin did not reach the session"),
    "a retry budget that did not reach the session must be loud, like the transport pin");

  checks.recoveredProviderWeatherDoesNotFailTheRun = true;
}

// GATE 52 - the run supplies no output ceiling of its own, and says what Pi's own ceiling
// arithmetic left it (Shane 2026-08-11: "Don't ever use maxtokens").
//
// A maxTokens value does not ask for a shorter answer, it stops the answer. This harness
// carried two of them: the worker cut the session to 16,384 and the grader to 8,192, on a
// descriptor that declares 128,000. Both are deleted here and neither may return.
//
// The larger defect is that Pi sends a ceiling whether or not a caller sets one, derived
// per request as `contextWindow - estimate - 4096`, floored at 1, then raised to the API's
// own minimum of 16. The pinned descriptor declares `contextWindow: 272000`, which its own
// cost table shows is a PRICING boundary (`inputTokensAbove: 272000`) while the provider
// was measured accepting 339,689. Sol-20260811 rep 2 set its serving budget from the
// measured capacity, ran occupancy past 300k, and sent 56 of 141 requests with
// `max_output_tokens: 16`. Those failed 23.2 percent of the time against 3.9 percent for
// requests that got the whole budget, and every failure was recorded as the bare word
// "error" with the provider's own message dropped on the floor.
//
// So three things are pinned: our arithmetic still matches Pi's, a managed arm that starves
// itself latches at the first request instead of at the seal, and a stop reason travels
// with what the provider actually said.
// ---------------------------------------------------------------------------
{
  const piOptions = readFileSync(
    join(PI_INSTALL_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "simple-options.js"),
    "utf8");
  const piEstimate = readFileSync(
    join(PI_INSTALL_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "estimate.js"),
    "utf8");
  const piResponses = readFileSync(
    join(PI_INSTALL_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist", "api", "openai-responses.js"),
    "utf8");
  // Drift detection, not reimplementation: the numbers below are the vendor's, and a Pi
  // upgrade that moves any of them must break this gate rather than silently invalidate the
  // budget the ledger reports.
  assert(piOptions.includes(`const CONTEXT_SAFETY_TOKENS = ${PI_OUTPUT_BUDGET.safetyTokens}`),
    "Pi's context safety reserve moved; PI_OUTPUT_BUDGET.safetyTokens no longer describes it");
  assert(piEstimate.includes(`const CHARS_PER_TOKEN = ${PI_OUTPUT_BUDGET.charsPerToken}`),
    "Pi's token estimator divisor moved; PI_OUTPUT_BUDGET.charsPerToken no longer describes it");
  assert(piResponses.includes(`const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = ${PI_OUTPUT_BUDGET.apiFloorTokens}`),
    "the Responses API output floor moved; PI_OUTPUT_BUDGET.apiFloorTokens no longer describes it");
  assert(piOptions.includes("model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS"),
    "Pi no longer derives the output budget by subtraction; servedOutputBudget must be re-read against it");
  assert(piOptions.includes("options?.maxTokens ?? model.maxTokens"),
    "Pi no longer falls back to the descriptor's own maximum; the no-ceiling posture must be re-examined");

  // The rep-2 geometry, reproduced. A healthy request gets the descriptor's maximum less
  // what the window has left; a request past the declared window gets the API floor.
  const WINDOW = 272_000, DECLARED_MAX = 128_000;
  const roomy = servedOutputBudget(
    { contextWindow: WINDOW, contextChars: 100_000 * 4, modelMaxTokens: DECLARED_MAX });
  assert.equal(roomy, DECLARED_MAX,
    "a request with room to spare must be served the descriptor's own maximum");
  const squeezed = servedOutputBudget(
    { contextWindow: WINDOW, contextChars: 200_000 * 4, modelMaxTokens: DECLARED_MAX });
  assert.equal(squeezed, WINDOW - 200_000 - PI_OUTPUT_BUDGET.safetyTokens,
    "once the window has less left than the descriptor allows, the remainder is what is served");
  assert(squeezed < DECLARED_MAX,
    "the squeezed case must actually be squeezed or it repeats the roomy one");
  const starved = servedOutputBudget(
    { contextWindow: WINDOW, contextChars: 320_000 * 4, modelMaxTokens: DECLARED_MAX });
  assert.equal(starved, PI_OUTPUT_BUDGET.apiFloorTokens,
    "a request past the declared window must be served the API floor, which is the rep-2 defect");
  assert(starved < PI_OUTPUT_BUDGET.latchBelowTokens,
    "the rep-2 defect must be on the latching side of the threshold or the latch is decorative");
  // The crossover is a property of the arithmetic, so it is asserted rather than assumed:
  // below this occupancy the budget is whole, above it the window starts eating the answer.
  const crossover = WINDOW - PI_OUTPUT_BUDGET.safetyTokens - PI_OUTPUT_BUDGET.latchBelowTokens;
  assert.equal(
    servedOutputBudget({ contextWindow: WINDOW, contextChars: crossover * 4, modelMaxTokens: DECLARED_MAX }),
    PI_OUTPUT_BUDGET.latchBelowTokens,
    "the latch threshold does not sit where the arithmetic puts it");

  const workerSource = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  const graderSource = readFileSync(join(PROJECT, "scripts", "grade_pi_context_experiment.mjs"), "utf8");
  const extensionSource = readFileSync(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"), "utf8");
  // Neither provider caller may set a ceiling. Matched on assignment so the word may still
  // appear in the comments that explain why it is gone, and in the manifest that records
  // the descriptor's own declared value.
  // Quoted or bare, camel or wire spelling: the ban is on the value reaching a provider,
  // not on one way of spelling the key.
  const assigns = (source) =>
    /["']?(?:maxTokens|max_tokens|max_output_tokens|max_completion_tokens)["']?\s*:\s*[0-9_]+/
      .test(source);
  assert(!assigns(workerSource), "the worker set an output ceiling again");
  assert(!assigns(graderSource), "the grader set an output ceiling again");
  assert(!assigns(extensionSource), "the experiment extension set an output ceiling");
  // Anti-vacuity: the matcher must catch every spelling of the thing it forbids, and must
  // still pass the shape that is allowed, which is recording the descriptor's own value.
  for (const defect of [
    "  const model = { ...discoveredModel, maxTokens: 16_384 };",
    `      model: { ...discovered, maxTokens: 8_192 },`,
    `  const params = { "max_output_tokens": 512 };`,
    `  const params = { max_tokens: 1024 };`,
  ]) {
    assert(assigns(defect), `the ceiling matcher does not recognise: ${defect.trim()}`);
  }
  assert(!assigns("      maxTokens: model.maxTokens,"),
    "the ceiling matcher must not forbid recording the descriptor's own declared value");
  assert(workerSource.includes("const model = discoveredModel;"),
    "the worker must hand the session the descriptor it discovered, unmodified");
  assert(workerSource.includes("declares no output maximum"),
    "a descriptor with no declared maximum must be refused rather than given one of ours");

  // The ledger must carry the budget and the provider's own words.
  assert(extensionSource.includes("outputBudgetTokens"),
    "the provider-request record must state the output budget the request was served");
  assert(/errorMessage:\s*typeof event\.message\.errorMessage/.test(extensionSource),
    "the provider-response record must carry the provider's message, not just its stop reason");
  assert(extensionSource.includes(`appendFailure(config, "starved-output-budget"`),
    "a starved output budget must latch rather than be left to show up as an error rate");
  assert(/config\.arm === "pifold"/.test(extensionSource),
    "the starvation latch must be scoped to the arm whose occupancy the run itself sets");
  // A guard that cannot read its inputs must say so rather than pass. Without this the
  // whole latch is one descriptor change away from being decorative.
  assert(extensionSource.includes(`appendFailure(config, "unreadable-output-budget"`),
    "a descriptor the output budget cannot be read from must latch, not silently skip the check");

  checks.noOutputCeilingAndTheServedBudgetIsRecorded = true;
}

// GATE 53 - a run whose folding SUSPENDED fails by that name, and fails on it before the
// symptom it eventually dies of.
//
// sol-20260812 reps 3 and 4 both ended on "Request was aborted" and both reported exactly
// that. Neither report was wrong and neither was useful. What happened in both was the
// same: the last applied commit of the run emitted its `context.commit` and eleven
// `context.fold` records, persisted none of them, rolled the state back (rep 3 from
// revision 143 to 134, rep 4 from 153 to 143), and suspended automatic folding. Suspension
// is permanent for the session, so occupancy then climbed with nothing able to reclaim it,
// and the request that finally died was twenty minutes downstream of the decision that
// killed it. Rep 2, same plan and same seed, ran ten applied commits with every fold
// landing, which is why this is worth a named latch rather than a tolerance.
//
// The runtime half of the fix is that suspension is now an event rather than a UI
// notification a headless host discards; this gate is the adjudication half. Scoped to the
// arm that folds, because a run with no folding runtime can never announce one.
// ---------------------------------------------------------------------------
{
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  const suspendCheck = worker.slice(
    worker.indexOf("const foldFailures = armRuntime.activeContextEnabled"),
    worker.indexOf("Experiment worker did not end at one terminal provider stop"),
  );
  assert(suspendCheck.length > 0,
    "the worker does not check the session for an announced folding suspension");
  assert(suspendCheck.includes(`entry.data?.kind === "context.suspend"`),
    "the suspension check does not read the runtime's own suspension event");
  assert(/assertExperiment\(suspensions\.length === 0/.test(suspendCheck),
    "an announced suspension does not fail the run");
  // Ordering is the point: the cause is asserted before the symptom, or the report names
  // the aborted request again and the suspension stays buried.
  assert(worker.indexOf("const foldFailures = armRuntime.activeContextEnabled") <
    worker.indexOf("Experiment worker did not end at one terminal provider stop"),
  "the suspension check runs after the terminal-stop check, so the report names the symptom");
  // Actionable, not merely red: the phase, the revision and the error itself travel.
  assert(/phase \$\{suspensions\[0\]\?\.phase\}/.test(suspendCheck) &&
    /revision \$\{suspensions\[0\]\?\.state_revision\}/.test(suspendCheck) &&
    /suspensions\[0\]\?\.error/.test(suspendCheck),
  "the suspension failure does not name the phase, the revision and the error");
  // Scoped to the arm that folds. Without this the unmanaged and native arms would be
  // judged against an event their runtime cannot emit.
  assert(suspendCheck.includes("armRuntime.activeContextEnabled"),
    "the suspension check is not scoped to the arm whose runtime can fold");

  // And the runtime really does announce it, which is what makes the check above more than
  // a source pin: the event kind is declared, and the suspension path emits it.
  const runtimeSource = readFileSync(join(PROJECT, "extensions", "active-context.ts"), "utf8");
  const suspendFn = runtimeSource.slice(
    runtimeSource.indexOf("const suspendAutomatic = ("),
    runtimeSource.indexOf("ladder.pendingContextNote = `Automatic context management suspended"),
  );
  assert(suspendFn.length > 0, "the suspension path was not found where it is pinned");
  assert(/emit\("context\.suspend"/.test(suspendFn),
    "suspending automatic folding still reports only through the host UI");
  assert(/state_revision/.test(suspendFn) && /durable_revision/.test(suspendFn),
    "the suspension event omits the two revisions whose disagreement is the symptom");
  assert(/outcome: "suspended"/.test(suspendFn),
    "the suspension record does not declare its outcome");
  // Every failed automatic transaction reaches that announcement, on the first one. A
  // bounded retry used to sit here and swallow the first three: it was removed because a
  // retry is a fallback, and a fallback is how a defect survives long enough to be a
  // mystery. The transaction must therefore hold no outcome of its own.
  const transaction = runtimeSource.slice(
    runtimeSource.indexOf("const runAutomaticTransaction = async ("),
    runtimeSource.indexOf("const queueAutomatic = ("),
  );
  assert(/suspendAutomatic\(error, phase, ctx, key, disposition\)/.test(transaction),
    "a failed automatic transaction no longer reaches the suspension announcement");
  assert(!/outcome: "retrying"/.test(transaction),
    "a failed automatic transaction still has an outcome that is not a suspension");
  // And BOTH automatic callers are inside it. Marking and committing are one
  // transaction, so a commit that vanishes at persistence restores the state it entered
  // with and announces itself for the same reason a mark does. The boundary used to
  // persist outside it, which left a discarded commit with nothing to roll back to.
  const queue = runtimeSource.slice(
    runtimeSource.indexOf("const queueAutomatic = ("),
    runtimeSource.indexOf("const projectionCandidates = ("),
  );
  for (const caller of ["attemptAutomaticRung", "attemptAutomaticCommit"]) {
    assert(new RegExp(`const ${caller} = \\([\\s\\S]*?queueAutomatic\\(`).test(queue),
      `${caller} reaches the ladder outside the durable transaction`);
  }
  const kinds = readFileSync(join(PROJECT, "extensions", "lib", "instrumentation.ts"), "utf8");
  assert(kinds.includes(`| "context.suspend"`),
    "context.suspend is not a declared kind of the canonical event stream");

  checks.suspendedFoldingFailsTheRunByName = true;
}

// GATE 54 - an applied commit owes a receipt, and a run where one goes unpaid fails on it.
//
// Gate 53 catches the loss through the runtime's own announcement. That works, and it only
// works on builds that announce. This is the same loss read from the event stream alone,
// which is what makes it worth having twice: `noteAutomaticReceipt` is the last statement of
// the rung application, so a commit that reports applied marks and never delivers a receipt
// threw partway through, leaving its folds in the stream and nowhere else, writing no fold
// record and no state entry, and putting its marks back to pending.
//
// Measured across all six sealed sol-20260812 runs. Reps 2 and 5 are clean. Reps 3, 4 and 6
// are the losses already named. Rep 1 is why this gate exists rather than being folded into
// gate 53: it lost fourteen folds at revision 99 on a build that announced nothing, its run
// report said nothing was wrong, and the loss sat unnamed in the record until this lens was
// run against it. Every loss so far shows the next projection reading exactly `applied_marks`
// revisions below the commit; the lens records that and does not require it, because a future
// loss that rolls back differently is still a loss.
// ---------------------------------------------------------------------------
{
  const commit = (seq, revision, appliedMarks, extra = {}) =>
    ({ kind: "context.commit", seq, revision, applied_marks: appliedMarks, deferred: false,
      trigger: "band-top", ...extra });
  const healthy = receiptLens([
    { kind: "context.capacity", seq: 1, revision: 0 },
    commit(2, 36, 10),
    { kind: "context.fold", seq: 3, revision: 36 },
    { kind: "context.absorb", seq: 4, revision: 36 },
    { kind: "context.receipt", seq: 5, revision: 36, receipt_kind: "epoch-commit" },
    { kind: "context.projection", seq: 6, revision: 36 },
  ]);
  // Anti-vacuity: a fixture with no applied commit would pass the clean assertion for the
  // wrong reason, and would say nothing about whether the lens can see a commit at all.
  assert(healthy.appliedCommits === 1,
    "the healthy fixture holds no applied commit, so a clean verdict on it means nothing");
  assert(healthy.commitsWithoutReceipt === 0 && healthy.missing.length === 0,
    "a commit whose receipt arrives before the next projection was read as unpaid");

  // The real shape of the loss, taken from rep 6: commit, response, folds, absorb, then a
  // projection reading nine revisions lower with no receipt anywhere between.
  const lost = receiptLens([
    commit(817, 394, 9),
    { kind: "context.response", seq: 818, revision: 394 },
    { kind: "context.fold", seq: 821, revision: 394 },
    { kind: "context.absorb", seq: 830, revision: 394 },
    { kind: "context.projection", seq: 832, revision: 385 },
    { kind: "context.receipt", seq: 850, revision: 385, receipt_kind: "epoch-commit" },
  ]);
  assert(lost.commitsWithoutReceipt === 1, "a commit that delivered no receipt was read as paid");
  assert(lost.missing[0].revision === 394 && lost.missing[0].nextProjectionRevision === 385 &&
    lost.missing[0].revisionsRolledBack === 9 && lost.missing[0].appliedMarks === 9,
  "the unpaid commit does not carry the revisions and the fold count needed to name it");
  // A receipt AFTER the next projection belongs to a later rung and must not pay this debt.
  // Without the projection boundary the lens would clear every loss that is followed by any
  // later healthy commit, which is most of them.
  assert(lost.receipts === 1,
    "the fixture's later receipt vanished, so the boundary is being tested against nothing");

  // A deferred commit and a commit that applied nothing are not debts. Both occur in every
  // run, and counting them would make the check fire constantly and be switched off.
  const notDebts = receiptLens([
    commit(10, 40, 0),
    commit(11, 40, 5, { deferred: true }),
    { kind: "context.projection", seq: 12, revision: 40 },
  ]);
  assert(notDebts.appliedCommits === 0 && notDebts.commitsWithoutReceipt === 0,
    "a deferred commit or a commit that applied nothing was counted as owing a receipt");

  // The worker reads that lens, fails on it, and names what it found.
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  const receiptCheck = worker.slice(
    worker.indexOf("const contextEvents = armRuntime.activeContextEnabled"),
    worker.indexOf("Experiment worker did not end at one terminal provider stop"),
  );
  assert(receiptCheck.length > 0, "the worker does not check the stream for an unpaid commit");
  assert(/const receipts = receiptLens\(contextEvents\)/.test(receiptCheck),
    "the worker derives the unpaid commits itself instead of reading the shared lens");
  assert(/assertExperiment\(receipts\.commitsWithoutReceipt === 0/.test(receiptCheck),
    "an applied commit that never delivered a receipt does not fail the run");
  assert(/unpaid\?\.seq/.test(receiptCheck) && /unpaid\?\.revision/.test(receiptCheck) &&
    /unpaid\?\.appliedMarks/.test(receiptCheck) && /unpaid\?\.nextProjectionRevision/.test(receiptCheck),
  "the unpaid-commit failure does not name the seq, the revisions and the fold count");
  assert(receiptCheck.includes("armRuntime.activeContextEnabled"),
    "the unpaid-commit check is not scoped to the arm whose runtime can fold");
  // Cause before symptom, and after the suspension, which carries the error verbatim and is
  // the better message on a build where both fire.
  assert(worker.indexOf("const suspensions = foldFailures") <
    worker.indexOf("const contextEvents = armRuntime.activeContextEnabled") &&
    worker.indexOf("const contextEvents = armRuntime.activeContextEnabled") <
    worker.indexOf("Experiment worker did not end at one terminal provider stop"),
  "the unpaid-commit check does not sit between the suspension and the terminal stop");
  // A clean run says so. Without this the only evidence the check ran is that nothing failed,
  // which reads the same as the check being absent.
  assert(/commitsWithoutReceipt: receipts\.commitsWithoutReceipt/.test(worker) &&
    /appliedCommits: receipts\.appliedCommits/.test(worker),
  "a passing run does not record how many commits were checked and how many went unpaid");

  // And the invariant is grounded in the runtime, not only in the fixtures: the receipt is
  // the last thing the COMMIT does, which is what makes its absence a throw. It used to
  // be the last thing the rung did, on two paths, because the rung owned the epoch; the
  // boundary owns it now and there is one path.
  const runtimeSource = readFileSync(join(PROJECT, "extensions", "active-context.ts"), "utf8");
  const commitEpoch = runtimeSource.slice(
    runtimeSource.indexOf("const runCommitEpoch = async ("),
    runtimeSource.indexOf("const clearCommitLatchBelowTrigger = ("),
  );
  assert(commitEpoch.length > 0, "the commit epoch was not found where it is pinned");
  const deliveries = [...commitEpoch.matchAll(/noteAutomaticReceipt\([^;]*\);\n(\s*)(\S[^\n]*)/g)];
  assert(deliveries.length >= 1,
    `the commit delivers a receipt on ${deliveries.length} path(s), and it has one to deliver on`);
  // Every delivery is the last thing that happens before the epoch is handed back. That is
  // what makes a missing receipt mean a throw rather than a path we forgot to instrument.
  for (const [, , next] of deliveries) {
    assert(next.startsWith("return epoch;"),
      `a receipt delivery is followed by ${JSON.stringify(next)} rather than by the return, ` +
      "so the commit can do more work after paying and a missing receipt stops meaning a throw");
  }
  // And the rung itself no longer pays one, because it no longer folds: it marks, and a
  // mark moves no bytes for a receipt to describe.
  const rung = runtimeSource.slice(
    runtimeSource.indexOf("const applyAutomaticRung = async ("),
    runtimeSource.indexOf("const runAutomaticTransaction = async ("),
  );
  assert(rung.length > 0, "the automatic rung application was not found where it is pinned");
  assert(!/noteAutomaticReceipt\(/.test(rung),
    "the rung pays a receipt for a mark, which moves no bytes for one to describe");

  checks.anAppliedCommitOwesAReceipt = true;
}

// GATE 55 - a worker killed from outside still writes its report, so the run stays readable.
//
// The supervisor sends SIGTERM when its deadline passes. Node's default handler ends the
// process there: the `finally` that writes `worker-report.json` does not run, because a
// signal is not an unwound stack. `adjudicate` refuses a run without that file, so a run
// killed at the deadline is not a failed run, it is an unreadable one.
//
// sol-20260812 rep 7's pifold arm is the case. It released all 64 of 64 stages, folded 27
// commits with every receipt paid and no suspension, then spent 281 more minutes recovering
// its own evidence through 83 distinct peeks before the deadline killed it. Six hours of
// provider spend, a complete session file on disk, and nothing that could be adjudicated or
// set beside the native arm that ran in the same window.
//
// The report this writes is explicitly a failure: ok false, the signal named, and the run
// still fails. That distinction is the whole point. It rescues the evidence, not the run.
// ---------------------------------------------------------------------------
{
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  assert(/process\.on\(signal, \(\) => writeSignalReport\(signal\)\)/.test(worker),
    "the worker installs no signal handler, so a SIGTERM still discards its report");
  const handler = worker.slice(
    worker.indexOf("const writeSignalReport = ("),
    worker.indexOf("for (const signal of ["),
  );
  assert(handler.length > 0, "the signal report writer was not found where it is pinned");
  // Both signals, because the supervisor sends SIGTERM and an operator sends SIGINT, and a
  // run killed by hand is worth exactly as much evidence as one killed by the deadline.
  assert(/\["SIGTERM", "SIGINT"\]/.test(worker),
    "the worker does not preserve its report on both the supervisor's signal and an operator's");
  // Synchronous, because a signal handler that awaits does not finish before the process ends.
  assert(/writeFileSync\(reportPath,/.test(handler) && !/await /.test(handler),
    "the signal report is written asynchronously, so the process can end before it lands");
  // Exclusive, so a worker that already wrote a real report cannot have it overwritten by
  // the signal that follows a normal exit.
  assert(/flag: "wx"/.test(handler),
    "the signal report can overwrite a report the ordinary path already wrote");
  // It must NOT read as a pass. A rescued report that said ok true would turn a killed run
  // into a clean one, which is worse than losing it.
  assert(/ok: false/.test(handler) && /requiresIndependentAdjudication: true/.test(handler),
    "the signal report does not declare itself a failure");
  assert(/terminatedBySignal: signal/.test(handler),
    "the signal report does not name the signal that ended the run");
  assert(/process\.exit\(1\)/.test(handler),
    "a signalled worker does not exit non-zero");
  // And the fields the adjudicator needs to read the run at all.
  for (const field of ["runId", "arm", "sessionId", "sessionFile", "deadlineFired",
    "workerStartedWallMs", "workerFinishedWallMs"]) {
    assert(new RegExp(`\\b${field}\\b`).test(handler),
      `the signal report omits ${field}, which the run cannot be read without`);
  }

  checks.aKilledWorkerStillWritesItsReport = true;
}

// GATE 56 - a model that ends its turn early is resumed; a harness that broke never is.
//
// The workload is pull-based: one prompt, and the agent fetches all 64 stages itself by
// following NEXT_KEY. Nothing made it keep pulling. sol-20260812 rep 8 lost BOTH arms to
// that in the same window: each answered stage 32's recall probe, ended its turn without
// calling the stage tool again, and the worker read a normal terminal stop and wrote
// `ok: true` over a run that had covered half the workload. Only the supervisor's
// stagesReleased 32 of 64 caught it. Rep 4 stopped at 32 too, rep 3 at 27, rep 1 at 18.
//
// The resume is deliberately narrow, because a nudge that fires on a broken harness would
// paper over exactly the failures this suite exists to surface (Shane 2026-08-13). It fires
// only when the model chose to end its turn: a clean "stop" with nothing in the failure
// latch. A stage tool erroring, a supervisor that stopped answering, an aborted or truncated
// response: none of those are resumable, and each still fails the run by name.
//
// The prompt withholds the key. A run whose agent has LOST the key is measuring recovery,
// which is what rep 1 recorded when the pifold arm lost it at stage 57, peeked the fold and
// finished all 64 stages. Handing the key back would delete that measurement.
// ---------------------------------------------------------------------------
{
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");

  const counterSource = worker.slice(
    worker.indexOf("const stagesDelivered = () => {"),
    worker.indexOf("const latchedFailures = () =>"),
  );
  assert(counterSource.length > 0, "the delivered-stage counter was not found where it is pinned");
  const scratch = mkdtempSync(join(tmpdir(), "pi-fold-gate56-"));
  try {
    mkdirSync(join(scratch, "ipc", "responses"), { recursive: true });
    const countStages = new Function("existsSync", "join", "config",
      `${counterSource}; return stagesDelivered;`)(existsSync, join, { runDir: scratch });
    assert.equal(countStages(), 0, "the counter claims delivered stages before any response exists");
    for (const stage of [1, 2, 3]) {
      writeFileSync(join(scratch, "ipc", "responses", `stage-0${stage}.json`), "{}\n");
    }
    assert.equal(countStages(), 3, "the counter miscounts the responses actually on disk");
    // Counts the run of stages actually delivered, not whatever files happen to be there:
    // a gap means the next stage never landed, which is the state a resume must act on.
    writeFileSync(join(scratch, "ipc", "responses", "stage-05.json"), "{}\n");
    assert.equal(countStages(), 3, "the counter reads past a gap and reports a run as further along");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const guardSource = worker.slice(
    worker.indexOf("const modelEndedItsTurn = "),
    worker.indexOf("\n\n// A COMPACTION IS AN ABORT,"),
  );
  assert(guardSource.length > 0, "the resume guard was not found where it is pinned");
  const guardWith = (latched) => new Function("latchedFailures",
    `${guardSource}; return modelEndedItsTurn;`)(() => latched);
  assert.equal(guardWith(0)({ terminalMessage: { stopReason: "stop" } }), true,
    "a clean model stop with a quiet latch is not resumable, so nothing would ever be nudged");
  for (const stopReason of ["error", "length", "aborted", null, undefined]) {
    assert.equal(guardWith(0)({ terminalMessage: { stopReason } }), false,
      `a run that ended on ${stopReason} is treated as a model ending its turn`);
  }
  assert.equal(guardWith(1)({ terminalMessage: { stopReason: "stop" } }), false,
    "a latched harness failure still resumes, so a broken harness is nudged past instead of reported");
  assert.equal(guardWith(0)(null), false, "a missing terminal state is treated as resumable");

  assert(/while \(!closedBook && !deadlineFired && stagesDelivered\(\) < plan\.stageCount &&\s*\(modelEndedItsTurn\(terminalState\) \|\| fenceCompactedSinceLastPrompt\(\)\)\)/.test(worker),
    "the resume loop is not bounded by the deadline, the plan count and the resume guards together");
  const resume = worker.slice(worker.indexOf("function resumePrompt("), worker.indexOf("function lastConversationalMessage("));
  assert(resume.length > 0, "the resume prompt was not found where it is pinned");
  assert(/Recover the NEXT_KEY/.test(resume) && !/challenge/i.test(resume),
    "the resume prompt hands the agent a key instead of making it recover one");
  assert(/stagesDelivered\(\) === plan\.stageCount/.test(worker),
    "a run that ends with stages undelivered does not fail by that name");
  assert(/stageNudges,/.test(worker) && /stagesDelivered: closedBook \? null : stagesDelivered\(\)/.test(worker),
    "the report does not carry what was delivered and what had to be nudged");

  checks.anEarlyModelStopIsResumedAndAShortRunFails = true;
}

// GATE 57 - a supervisor killed from outside still writes the run's candidate report, and
// does not wait forever for a worker that cannot answer.
//
// Gate 55 gave the WORKER a signal handler so a killed run stays readable. sol-20260812
// rep 9 is the case that handler cannot cover: signal handlers run on the event loop, and
// that worker held 98% of a core in synchronous JS for 118 minutes, so `systemctl stop`
// logged "Killing process 1004322 (node-MainThread) with signal SIGKILL" and the run left
// no worker report and no candidate report at all. Everything the six-hour arm measured
// had to be recovered by reading the session, pace and provider ledgers by hand.
//
// The supervisor is the process that CAN answer: it spends the run idle between IPC polls.
// It routes the signal into the same failure path a blown deadline takes, which latches,
// ends the worker and falls through to the finalization that writes the report. And it
// ends the worker on a bound, because a worker that cannot run its own handler cannot
// exit on request either, and waiting on one that never will is how the supervisor came to
// be killed beside it.
// ---------------------------------------------------------------------------
{
  const supervisor = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment.mjs"), "utf8");
  assert(/for \(const signal of \["SIGTERM", "SIGINT"\]\) \{\s*process\.on\(signal, \(\) => \{ terminationSignal \?\?= signal; \}\);/
    .test(supervisor),
  "the supervisor installs no handler for both signals, so a stop still discards its report");
  // FIRST in the wait loop. The deadline and the lost-worker checks both throw their own
  // message, and a run ended from outside reported under either of those names is the
  // "Request was aborted" problem again: true, and useless.
  const loop = supervisor.slice(supervisor.indexOf("async function supervisedWait("));
  assert(loop.indexOf("if (terminationSignal) throw") > 0 &&
    loop.indexOf("if (terminationSignal) throw") < loop.indexOf("exceeded its monotonic deadline"),
  "the wait loop does not read the signal, or reads it after the deadline it would be reported as");
  assert(/terminatedBySignal: terminationSignal,/.test(supervisor),
    "the candidate report does not name the signal that ended the run");

  // AND THE BOUND IS DRIVEN FOR REAL, against a child that ignores SIGTERM exactly as a
  // CPU-bound worker does. Extracted and evaluated rather than read, so this proves the
  // supervisor escapes rather than that the source contains a kill.
  const source = supervisor.slice(
    supervisor.indexOf("async function endWorker("),
    supervisor.indexOf("async function supervisedWait("),
  );
  assert(source.length > 0, "the worker termination helper was not found where it is pinned");
  const endWorker = new Function("WORKER_TERMINATION_GRACE_MS", `${source}\nreturn endWorker;`)(300);
  const stubborn = spawn(process.execPath, [
    "-e", "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); " +
      "setInterval(() => {}, 1000); console.log('ready');",
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const completion = new Promise((resolve) => {
    stubborn.on("exit", (code, signal) => resolve({ code, signal }));
  });
  // Its handlers must be installed before the first signal, or this would measure Node's
  // default handler and pass for the wrong reason.
  await new Promise((resolve) => stubborn.stdout.once("data", resolve));
  const startedMs = Date.now();
  const exit = await endWorker(stubborn, completion);
  const elapsedMs = Date.now() - startedMs;
  assert.equal(exit.signal, "SIGKILL",
    `a worker that ignored SIGTERM exited as ${JSON.stringify(exit)} rather than being ended`);
  assert(elapsedMs < 5_000,
    `the supervisor waited ${elapsedMs}ms on a worker that was never going to exit`);

  // ANTI-VACUITY: the same helper leaves a cooperative worker alone to exit on its own, so
  // the SIGKILL above is the stubborn case and not what every teardown does.
  const willing = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 50);"], { stdio: "ignore" });
  const willingCompletion = new Promise((resolve) => {
    willing.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const willingExit = await endWorker(willing, willingCompletion);
  assert.equal(willingExit.signal, "SIGTERM",
    `a cooperative worker exited as ${JSON.stringify(willingExit)} rather than on the first signal`);

  checks.aKilledSupervisorStillWritesTheCandidateReport = true;
}

// GATE 58 - the wall clock is reported beside the ledger that confounds it.
//
// A run's wall clock is not its provider latency. Every turn derives over the whole
// session, so a session that grows faster than the work does buys wall time nothing
// charged for. sol-20260812 rep 9's pifold arm wrote 309 state entries totalling 21.6MB,
// 68.0% of a 31.9MB session, against 0.93MB of projection actually sent, and held 98% of a
// core for 118 minutes while the native arm spent 24 seconds of CPU. `wallClockMs` alone
// could not tell that apart from folding being slow, and every wall-clock figure recorded
// before the state delta was fixed measured it.
//
// The lens reports and does not judge. There is no threshold, because the honest bound is
// the comparison between the two arms of one run and the native arm has no state entries
// at all. Driven with fixtures rather than matched against source, so it is the arithmetic
// under test.
// ---------------------------------------------------------------------------
{
  const stateEntry = (data) => ({ type: "custom", customType: "pi-fold-active-context-state", data });
  const ledger = sessionLedgerLens([
    { type: "message", message: { role: "user", content: "x" } },
    stateEntry({ revision: 1, briefs: { a: "b".repeat(100) }, pendingMarks: [] }),
    stateEntry({ revision: 2, briefs: { a: "b".repeat(400) }, pendingMarks: [1, 2] }),
    { type: "custom", customType: "pi-fold-active-context-fold-record", data: { fold: {} } },
  ], 10_000);
  assert.equal(ledger.stateEntries, 2, "the lens counted something other than the state entries");
  assert.equal(ledger.sessionEntries, 4, "the lens lost entries that are not state");
  assert(ledger.stateBytes > 500 && ledger.stateBytes < 10_000,
    `state bytes came back as ${ledger.stateBytes}`);
  assert.equal(ledger.stateShareOfSession, ledger.stateBytes / 10_000,
    "the share is not the state bytes over the session bytes");
  assert(ledger.largestStateEntryBytes > ledger.smallestStateEntryBytes,
    "the lens reported no growth across two entries of different size");
  // The field breakdown is the part that names the cause. Rep 9 was 81% briefs, and a
  // reader who only sees a total has to go and find that out.
  assert.equal(Object.keys(ledger.stateBytesByField)[0], "briefs",
    `the widest field came back as ${JSON.stringify(Object.keys(ledger.stateBytesByField))}`);
  // A run with no state entries at all is the native arm, and it must read as zero rather
  // than as missing: the comparison between the arms is the whole point of the lens.
  const bare = sessionLedgerLens([{ type: "message", message: {} }], 500);
  assert.equal(bare.stateEntries, 0);
  assert.equal(bare.stateBytes, 0);
  assert.equal(bare.stateShareOfSession, 0);
  assert.equal(bare.largestStateEntryBytes, null,
    "an arm that wrote no state reported a largest entry");
  assert.equal(sessionLedgerLens([], 0).stateShareOfSession, null,
    "an empty session divided by zero instead of declining to answer");

  const adjudicator = readFileSync(join(PROJECT, "scripts", "adjudicate_pi_context_experiment.mjs"), "utf8");
  assert(/sessionLedger: sessionLedgerLens\(entries, statSync\(sessionFile\)\.size\)/.test(adjudicator),
    "the adjudication report does not carry the ledger the wall clock is read against");

  checks.theWallClockIsReportedBesideItsLedger = true;
}

// ---------------------------------------------------------------------------
// GATE 59 - the compaction trigger clears the fence, and Pi's default does not.
//
// `shouldCompact` fires at `contextTokens > contextWindow - reserveTokens` against the
// DESCRIPTOR window. gpt-5.6-sol declares 272,000 and Pi's default reserve is 16,384, so
// the default trigger is 255,616 while the run's serving budget is 251,520: the
// projection fence is 4,096 tokens BELOW the trigger and always reaches the window first,
// and a managed arm never sees the hook at all. sol-20260812 rep 9 measured exactly that,
// six hours and zero compaction passes on the pifold arm against four on the native one.
//
// Harmless while the fold runtime carried its own occupancy trigger; fatal to one whose
// only ordinary mutation point IS the boundary. The reserve is derived now, and this gate
// pins BOTH halves: the derived trigger clears the fence margin, and Pi's default on this
// descriptor does NOT, because a gate that only checks the derived value would pass just
// as happily on a descriptor where the default was already fine and would never have
// caught rep 9. The worker is checked for using the derived value rather than a literal.
// ---------------------------------------------------------------------------
{
  const descriptorWindow = 272_000;
  const servingBudgetTokens = 251_520;
  const derived = compactionReserveTokens({
    descriptorWindow, servingBudgetTokens, share: compactionTriggerShare("full"),
  });
  assert.equal(derived.triggerTokens, 201_216,
    "the derived trigger is not the occupancy the retired thermostat committed at");
  // EVERY MODE STATES A SHARE ITS OWN MASS CAN CROSS. A smoke on the full run's line
  // reaches a tenth of it, crosses nothing, folds nothing, and reports a healthy managed
  // arm that never exercised the path it exists to exercise, which is the failure this
  // half prevents. The bound is the plan's own accumulated payload, not a number typed
  // beside the share.
  for (const mode of EXPERIMENT_MODES) {
    const plan = EXPERIMENT_MODE_PLANS[mode];
    const share = compactionTriggerShare(mode);
    const modeDerived = compactionReserveTokens({ descriptorWindow, servingBudgetTokens, share });
    // What the run actually accumulates, at the estimator the harness declares, counting
    // only the stages the floor binds: a probe stage is exempt from it and guarantees
    // nothing.
    const reachableTokens = Math.floor(
      ((plan.stageCount - plan.probeStages.length) * plan.payloadFloorChars) / 4);
    assert(modeDerived.triggerTokens < reachableTokens,
      `mode ${mode} places its compaction trigger at ${modeDerived.triggerTokens} tokens, past ` +
      `the ${reachableTokens} its own ${plan.stageCount} stages can accumulate at the payload ` +
      "floor, so no run in that mode ever crosses a boundary");
    // And it is not so low that the run spends itself crossing: at least two stages of
    // payload have to land before the first crossing, or the first stage folds itself.
    assert(modeDerived.triggerTokens > (2 * plan.payloadFloorChars) / 4,
      `mode ${mode} crosses its compaction trigger inside the first two stages`);
  }
  assert.throws(() => compactionTriggerShare("no-such-mode"), /Unknown experiment mode/);
  assert(derived.triggerTokens < servingBudgetTokens,
    "the derived compaction trigger does not clear the serving budget");
  assert(derived.headroomTokens >= PROJECTION_FENCE_MARGIN_SHARE * servingBudgetTokens,
    "the derived trigger sits inside the fence margin");
  // The half that makes it non-vacuous: Pi's own default on this descriptor is the
  // rep-9 configuration, and the record says so rather than leaving it to be rederived.
  assert.equal(derived.defaultTriggerTokens, descriptorWindow - PI_DEFAULT_COMPACTION_RESERVE_TOKENS);
  assert.equal(derived.defaultTriggerClearsTheBudget, false,
    "Pi's default already cleared the serving budget here, so this gate proves nothing " +
    "and the rep-9 measurement it was written from cannot be reproduced");
  // A trigger inside the fence margin is refused rather than accepted quietly, which is
  // the failure mode a share tuned by hand would reach.
  assert.throws(() => compactionReserveTokens({
    descriptorWindow, servingBudgetTokens, share: 0.96,
  }), /inside the fence margin/,
  "a compaction trigger inside the fence margin was accepted");
  assert.throws(() => compactionReserveTokens({
    descriptorWindow: 150_000, servingBudgetTokens, share: compactionTriggerShare("full"),
  }), /is under the/,
  "a descriptor window under the trigger produced a negative reserve");
  // And the worker takes the derived value rather than a literal, on both arms, and
  // checks that Pi actually received it.
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  assert(/reserveTokens: compactionTrigger\.reserveTokens/.test(worker),
    "the worker still pins a literal compaction reserve");
  assert(!/reserveTokens: 16_384/.test(worker),
    "the worker still carries Pi's default reserve, which is the rep-9 configuration");
  assert(/settings\.reserveTokens === compactionTrigger\.reserveTokens/.test(worker),
    "the worker does not check that its compaction trigger reached the session");

  checks.theCompactionTriggerClearsTheFence = true;
}

// GATE 60 - a forced compaction aborts the turn, so the fenced arm is resumed past its own
// abort and no other arm ever is.
//
// Pi's `compact` runs `_disconnectFromAgent()` and `await abort()` as its first two
// statements, before it reads a setting or checks whether it can compact at all. On the
// matched-fence arm that is not an edge case, it is every crossing: the turn dies mid tool
// call and the pull-based workload stops there unless something prompts it again.
// sol-20260814-matched rep 3 delivered 1 of 8 stages that way, terminal stop reason
// `toolUse`, which gate 56's guard correctly refuses to resume because nothing about it
// says the model chose to stop.
//
// So the abort is reclassified in exactly two places and nowhere else. The extension
// records `harness-fence-abort` instead of latching, but only while a crossing is in
// flight. The worker resumes, but only on evidence that a compaction COMPLETED since its
// last prompt. Both bounds are the gate: an abort with no completed compaction behind it
// is an ordinary abort and still ends the run, one completed compaction authorizes exactly
// one resume, and an arm that is not fenced is never resumed past an abort at all.
// ---------------------------------------------------------------------------
{
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  const source = worker.slice(
    worker.indexOf("const eventLogPath = join("),
    worker.indexOf("\n\n// A KILLED WORKER STILL WRITES ITS REPORT."),
  );
  assert(source.length > 0, "the fence resume rule was not found where it is pinned");

  const scratch = mkdtempSync(join(tmpdir(), "pi-fold-gate60-"));
  try {
    const eventLine = (kind) => `${JSON.stringify({ version: 1, kind, details: {} })}\n`;
    const build = (arm, latched) => new Function("join", "existsSync", "readFileSync",
      "config", "latchedFailures",
      `${source}; return { fenceCompactedSinceLastPrompt, fenceCompactions,` +
      " markResumed: () => { fenceCompactionsResumedPast = fenceCompactions(); } };")(
      join, existsSync, readFileSync, { runDir: scratch, arm }, () => latched);

    // No event log at all: nothing has crossed, so nothing is resumable.
    const fenced = build("nativefence", 0);
    assert.equal(fenced.fenceCompactions(), 0, "compactions are counted before any event exists");
    assert.equal(fenced.fenceCompactedSinceLastPrompt(), false,
      "a run with no completed compaction is resumable, so an ordinary abort would be nudged past");

    // A crossing that ABORTED and never completed is not a licence to continue: this is
    // precisely rep 3's state, and the run must still fail on it.
    const log = join(scratch, "worker-events.jsonl");
    writeFileSync(log, eventLine("harness-fence-crossing") + eventLine("harness-fence-abort"));
    assert.equal(fenced.fenceCompactions(), 0, "an abort is counted as a completed compaction");
    assert.equal(fenced.fenceCompactedSinceLastPrompt(), false,
      "a crossing that never compacted authorizes a resume");

    // A completed compaction authorizes exactly ONE resume, and the next one needs its own.
    writeFileSync(log, readFileSync(log, "utf8") + eventLine("harness-fence-compacted"));
    assert.equal(fenced.fenceCompactions(), 1, "a completed compaction is not counted");
    assert.equal(fenced.fenceCompactedSinceLastPrompt(), true,
      "a completed compaction does not authorize the resume the arm cannot continue without");
    fenced.markResumed();
    assert.equal(fenced.fenceCompactedSinceLastPrompt(), false,
      "the same compaction authorizes a second resume, so a stalled fence spins here");
    writeFileSync(log, readFileSync(log, "utf8") + eventLine("harness-fence-compacted"));
    assert.equal(fenced.fenceCompactedSinceLastPrompt(), true,
      "a second completed compaction does not authorize its own resume");

    // A LATCHED FAILURE STILL ENDS THE RUN. Gate 56's rule is not relaxed by this one:
    // whatever the fence did, a broken harness is reported rather than nudged past.
    assert.equal(build("nativefence", 1).fenceCompactedSinceLastPrompt(), false,
      "a latched harness failure is resumed past whenever a compaction happens to have completed");

    // AND NO OTHER ARM IS EVER RESUMED PAST AN ABORT, on the same evidence.
    for (const arm of EXPERIMENT_ARMS.filter((candidate) => candidate !== "nativefence")) {
      assert.equal(build(arm, 0).fenceCompactedSinceLastPrompt(), false,
        `the ${arm} arm is resumed past an abort, which is the failure gate 56 exists to report`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  assert(/const reason = modelEndedItsTurn\(terminalState\) \? "model-ended-turn" : "fence-compaction"/
    .test(worker), "a resume does not record which of the two conditions fired");

  // The extension's half: the reclassification is bounded to a crossing in flight, and the
  // latch is what happens otherwise. A blanket suppression here would make every aborted
  // context on this arm invisible, which is the failure this arm would be least able to see.
  const extension = readFileSync(
    join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"), "utf8");
  assert(/if \(identity\.signalAborted\) \{\s*if \(fenceState\.inFlight\) \{\s*appendEvent\("harness-fence-abort"/
    .test(extension), "an aborted context is not recorded against the crossing that caused it");
  assert(/\} else \{\s*appendFailure\(config, "context-aborted"/.test(extension),
    "an aborted context outside a crossing no longer latches");

  // AND THE CROSSING'S OWN OUTCOME, driven rather than matched. The abort creates the
  // boundary Pi's `_checkCompaction` runs at, so most crossings are serviced by Pi's own
  // threshold pass before our manual request is prepared, and the manual request then
  // throws "Already compacted". That is the arm working. It is accepted only against the
  // compaction entry actually standing on the branch, which is the same condition
  // `prepareCompaction` refused on: the message alone is a claim, not evidence.
  const onErrorBody = extension.slice(
    extension.indexOf("onError: (error) => {") + "onError: (error) => {".length,
    extension.indexOf("\n              },\n            });"),
  );
  assert(onErrorBody.length > 0, "the fence's error path was not found where it is pinned");
  const driveOnError = (message, lastEntryType) => {
    const emitted = [];
    const latched = [];
    const state = { crossings: 3, inFlight: true };
    new Function("fenceState", "ctx", "appendEvent", "appendFailure", "config",
      `return (error) => {${onErrorBody}};`)(
      state,
      { sessionManager: { getBranch: () => [{ type: "message" }, { type: lastEntryType }] } },
      (kind, details) => emitted.push({ kind, details }),
      (_config, phase, detail) => latched.push({ phase, detail }),
      {},
    )(new Error(message));
    assert.equal(state.inFlight, false,
      "a crossing that errored stays in flight, so no later crossing can ever fire");
    return { emitted, latched };
  };

  const serviced = driveOnError("Already compacted", "compaction");
  assert.deepEqual(serviced.latched, [],
    "a crossing serviced by Pi's own threshold pass is latched as a failure, which kills the arm");
  assert.equal(serviced.emitted.length, 1, "a serviced crossing records no completion");
  assert.equal(serviced.emitted[0].kind, "harness-fence-compacted",
    "a serviced crossing does not record the completion the worker resumes on");
  assert.equal(serviced.emitted[0].details.serviced_by, "native-threshold",
    "a serviced crossing does not name which trigger compacted it");

  // PROOF IS REQUIRED. The same message with no compaction on the branch is a real
  // failure, and every other message is one whatever the branch looks like.
  const unproven = driveOnError("Already compacted", "message");
  assert.deepEqual(unproven.emitted, [],
    "the fence accepts the error message alone, so a crossing that compacted nothing reads as serviced");
  assert.equal(unproven.latched.length, 1, "an unproven claim of compaction does not latch");
  for (const message of ["Nothing to compact (session too small)", "No model selected", "boom"]) {
    const failed = driveOnError(message, "compaction");
    assert.deepEqual(failed.emitted, [],
      `a crossing that failed with "${message}" records a completion`);
    assert.equal(failed.latched.length, 1,
      `a crossing that failed with "${message}" does not latch, so the window grows unopposed`);
    assert.equal(failed.latched[0].phase, "harness-fence-compaction",
      "a failed crossing latches under some other name");
  }

  // AND THE ONE REQUEST THE ABORT STRANDS. The in-flight marker is cleared by the assistant
  // response its request produces, and an aborted request produces none, so the next
  // request read as parallel traffic and latched a capability breach that had not happened.
  // The allowance is armed at the crossing and consumed once: a second stranded request, or
  // one with no crossing behind it, is still the breach the invariant exists to catch.
  assert(/fenceState\.crossings \+= 1;\s*fenceState\.abandonPending = true;/.test(extension),
    "the stranded-request allowance is not armed at the crossing that strands it");
  const guard = extension.slice(
    extension.indexOf("        if (inFlightProviderRequest) {\n          // OUR OWN ABORT"),
    extension.indexOf("\n        const providerTools ="),
  );
  assert(guard.length > 0, "the in-flight provider-request guard was not found where it is pinned");
  const driveGuard = (state, marker) => {
    const emitted = [];
    const latched = [];
    let threw = false;
    try {
      new Function("fenceState", "appendEvent", "appendFailure", "config",
        `return (inFlightProviderRequest) => {${guard}\n return inFlightProviderRequest; };`)(
        state, (kind, details) => emitted.push({ kind, details }),
        (_config, phase, detail) => latched.push({ phase, detail }), {})(marker);
    } catch { threw = true; }
    return { emitted, latched, threw };
  };
  const armed = { crossings: 2, abandonPending: true };
  const first = driveGuard(armed, { recordSha256: "abc" });
  assert.deepEqual(first.latched, [], "the request our own abort stranded is latched as parallel traffic");
  assert.equal(first.threw, false, "a stranded request still throws, so the run dies on our own abort");
  assert.equal(first.emitted[0]?.kind, "harness-fence-abandoned-request",
    "a stranded request is dropped without a record of it");
  assert.equal(armed.abandonPending, false, "the allowance is not consumed, so it covers every later request");
  const second = driveGuard(armed, { recordSha256: "def" });
  assert.equal(second.latched[0]?.phase, "parallel-provider-request",
    "a second stranded request on one crossing does not latch");
  assert.equal(second.threw, true, "a second stranded request does not stop the request that follows it");
  const unarmed = driveGuard({ crossings: 0, abandonPending: false }, { recordSha256: "ghi" });
  assert.equal(unarmed.latched[0]?.phase, "parallel-provider-request",
    "genuine parallel provider traffic no longer latches");
  assert.equal(unarmed.threw, true, "genuine parallel provider traffic is allowed to proceed");
  assert.deepEqual(driveGuard({ crossings: 0, abandonPending: true }, null).latched, [],
    "the guard acts when no request is in flight at all");

  // AND THE ADJUDICATOR'S OWN CONTRACT, which a resumed run necessarily breaks. The rule
  // was a bare count of one user message, enforcing that the workload is delivered as one
  // continuous task rather than fed turn by turn. That held only while nothing could
  // legitimately prompt again; this arm prompts once per compaction by construction. The
  // count is now checked against the resumes the worker RECORDED, so an extra user message
  // that no resume accounts for still breaks it, and the resumes are reported split by
  // cause: on this arm they are a cost of the mechanism, not an incident.
  assert(/const recordedResumes = Array\.isArray\(worker\.stageNudges\)/.test(adjudicator),
    "the resume count is not read from the worker's own record, so nothing constrains it");
  assert(/userMessages === 1 \+ recordedResumes/.test(adjudicator),
    "the user-message contract is not checked against the recorded resumes");
  assert(!/userMessages === 1,/.test(adjudicator),
    "the bare one-user-message count survives, so every resumed run fails adjudication");
  assert(/resumesAfterFenceCompaction:[\s\S]{0,160}"fence-compaction"/.test(adjudicator) &&
    /resumesAfterModelStop:[\s\S]{0,160}"model-ended-turn"/.test(adjudicator),
    "the adjudicated workload does not split resumes by what caused them");

  checks.aForcedCompactionAbortsTheTurnAndOnlyTheFencedArmResumes = true;
}

// GATE 61 - both arms' out-of-band provider calls are counted, and the bill is read rather
// than computed.
//
// `usage` is built from the provider ledger, and the ledger is written by the request hook.
// Neither arm's out-of-band calls reach that hook, so both were invisible: native's
// compaction summarizes the branch through its own request (every compaction window in
// sol-20260814-fenced-full rep 1 held zero ledger records across 88 to 118 seconds), and
// pi-fold's brief generator does the same one layer along. Rep 1 hid 1,586,200 fresh
// generator tokens on one arm and 75,375 compaction tokens on the other, and the arm with
// the larger hidden spend was the one the headline favoured. Reporting one and not the
// other is what makes a comparison dishonest, so the gate drives BOTH shapes.
//
// Cost is read from the records Pi already wrote, so the long-context tier is inside it.
// The crossing COUNT is separate and reported, because a declared serving budget decides
// that exposure silently: luna-20260807 declared none, native drifted to 369,024 tokens and
// crossed on 17 of 117 calls, and that surcharge was the entire cost result.
// ---------------------------------------------------------------------------
{
  const compactionEntry = (input, output, cost) => ({
    type: "compaction",
    usage: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 1, totalTokens: input + output, cost: { total: cost } },
  });
  const briefEntry = (input, output, cost) => ({
    type: "custom",
    data: { kind: "context.brief", usage: { input, output, cacheRead: 0, totalTokens: input + output, costTotal: cost } },
  });

  // AN ARM THAT MAKES NEITHER KIND OF CALL REPORTS ZEROS, never nulls: "none" is a
  // measurement here, and an absent field would read as "not looked for".
  const quiet = outOfBandUsage([{ type: "message" }, { type: "custom", data: { kind: "context.fold" } }]);
  assert.deepEqual(quiet.compaction, {
    calls: 0, inputFresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
    totalTokens: 0, costUsd: 0,
  }, "an arm that never compacted reports something other than zero compaction spend");
  assert.equal(quiet.totals.calls, 0, "a run with no out-of-band calls reports some");

  const native = outOfBandUsage([
    { type: "message" }, compactionEntry(8_306, 4_791, 0.18526), compactionEntry(23_468, 4_876, 0.26362),
  ]);
  assert.equal(native.compaction.calls, 2, "compaction entries are not counted as calls");
  assert.equal(native.compaction.inputFresh, 31_774, "compaction input is not summed");
  assert.equal(native.compaction.output, 9_667, "compaction OUTPUT is not summed, which is the billed token");
  assert(Math.abs(native.compaction.costUsd - 0.44888) < 1e-9, "compaction cost is not summed");
  assert.equal(native.briefGenerator.calls, 0, "a native run reports generator calls it never made");
  assert.equal(native.totals.output, 9_667, "the totals do not carry what the split does");

  const folded = outOfBandUsage([briefEntry(56_000, 1_100, 0.127), briefEntry(60_000, 1_200, 0.133)]);
  assert.equal(folded.briefGenerator.calls, 2, "generator records are not counted as calls");
  assert.equal(folded.briefGenerator.inputFresh, 116_000, "generator input is not summed");
  assert.equal(folded.compaction.calls, 0, "a folding run reports compactions it never ran");
  // A generator call that failed reports no usage and is still a call the run made, so the
  // count stays joinable against the lane's own records.
  const withFailure = outOfBandUsage([briefEntry(10, 1, 0.01), { type: "custom", data: { kind: "context.brief", outcome: "error" } }]);
  assert.equal(withFailure.briefGenerator.calls, 2, "a generator call that reported no usage is not counted as a call");
  assert.equal(withFailure.briefGenerator.inputFresh, 10, "a failed call invented usage it never reported");

  // THE BILL, read from the same records the tokens are read from.
  const response = (input, cacheRead, cost) => ({
    kind: "provider-response", requestOrdinal: 0,
    usage: cost === null ? { input, cacheRead } : { input, cacheRead, cost: { total: cost } },
  });
  const bill = billedCostFromLedger([
    { kind: "provider-request", ordinal: 1, payloadChars: 10 },
    response(1_000, 100_000, 0.5), response(2_000, 300_000, 4.81), response(3_000, 10_000, 0.25),
  ]);
  assert.equal(bill.messageCalls, 3, "the billed lens miscounts message calls");
  assert(Math.abs(bill.messageCallsUsd - 5.56) < 1e-9, "billed cost is not summed from the records");
  assert.equal(bill.longContextCalls, 1,
    "a call whose prompt passed the long-context tier is not counted, so a surcharged run reads like a base-tier one");
  assert.equal(bill.peakPromptTokens, 302_000, "the peak prompt is not the largest input plus cache read");
  assert.equal(bill.longContextTierPromptTokens, LONG_CONTEXT_TIER_PROMPT_TOKENS);
  // A provider that stopped reporting cost must not read as a cheap run.
  const partial = billedCostFromLedger([response(1, 1, 0.25), response(1, 1, null)]);
  assert.equal(partial.callsWithoutCost, 1, "a response carrying no cost is absorbed silently");
  assert(Math.abs(partial.messageCallsUsd - 0.25) < 1e-9, "a response with no cost invented one");

  // AND THE REQUESTS THAT WERE BUILT AND NEVER ANSWERED, a bound and never a total.
  const orphans = unansweredRequestsFromLedger([
    { kind: "provider-request", ordinal: 1, payloadChars: 100 },
    { kind: "provider-response", requestOrdinal: 1 },
    { kind: "provider-request", ordinal: 2, payloadChars: 964_700 },
    { kind: "provider-request", ordinal: 3, payloadChars: 942_853 },
  ]);
  assert.equal(orphans.count, 2, "a request that never produced a response is not reported");
  assert.equal(orphans.projectedChars, 1_907_553, "the unanswered mass is not summed");
  assert(/unknown/.test(orphans.billed),
    "the unanswered requests claim to know what the provider charged, which the artifacts cannot say");
  assert.equal(unansweredRequestsFromLedger([
    { kind: "provider-request", ordinal: 1 }, { kind: "provider-response", requestOrdinal: 1 },
  ]).count, 0, "a fully answered run reports unanswered requests");

  // And the adjudicator reports all of it rather than computing a bill of its own.
  assert(/outOfBand,/.test(adjudicator) && /totalUsd: billed\.messageCallsUsd \+ outOfBand\.totals\.costUsd/
    .test(adjudicator), "the adjudicated report does not carry the out-of-band spend or the total bill");
  assert(/unansweredRequests: unansweredRequestsFromLedger\(ledger\)/.test(adjudicator),
    "the adjudicated report drops the requests that were built and never answered");

  checks.bothArmsOutOfBandSpendAndTheBillAreReported = true;
}

// GATE 62 - no instruction surface tells the model it is being tested, and a plan that does
// cannot be launched.
//
// The plan's existing anti-leak scan looks for probe ANSWERS in instructions. This is the
// premise rather than the answers, and three surfaces carried it. It is not cosmetic: v3
// measured the same shape from the other direction when sol's summarizer carried 20, 38 and
// 54 code words verbatim through successive summaries because it could tell they mattered.
// A model told it is about to be quizzed optimizes for the quiz, and native's compaction
// summaries are exactly where that optimization would land.
// ---------------------------------------------------------------------------
{
  // The three historical strings, by their own bytes.
  for (const carrier of [
    "Record the identifiers you will need later; you will be asked about them after many stages.",
    "you may not get another delivery of these bytes",
    "Those earlier bytes are not resent: recover them however you must.",
    "Answer the following recall questions about material delivered EARLIER in this session.",
    "You will be quizzed on this.",
    "Your answers are graded.",
    // Hoarding direction: the second-pass carriers, by their own bytes.
    "Record the specific identifiers and line positions you will need later.",
    "keep an exact working memory of the identifiers, paths and line positions you have seen",
  ]) {
    assert(testAwarenessLeaks(carrier).length > 0,
      `the scan misses test-awareness framing: ${carrier.slice(0, 60)}`);
  }
  // AND IT DOES NOT FIRE ON THE WORK ITSELF. Stage instructions carry curl's own paths, and
  // `tests/` is a directory in that repository, so a general search for "test" would refuse
  // every plan the corpus can produce.
  for (const clean of [
    "Read every file delivered in this stage and build an accurate working model of what it does.",
    "Files in this stage: tests/unit/unit1300.c, lib/ftplistparser.h.",
    "Name every call, trait, type or route that crosses between the new files and that earlier material.",
    "Before we carry on, can you tell me a few things about the work so far?",
  ]) {
    assert.deepEqual(testAwarenessLeaks(clean), [],
      `the scan refuses ordinary working instructions: ${clean.slice(0, 60)}`);
  }
  assert.deepEqual(testAwarenessLeaks(undefined), [], "a stage with no deliverable breaks the scan");

  // THE LIVE PLAN, not a fixture of one: every surface the model will actually read.
  for (const stage of plan.stages) {
    assert.deepEqual(testAwarenessLeaks(stage.instructions), [],
      `stage ${stage.ordinal} instructions tell the model it is being tested`);
    assert.deepEqual(testAwarenessLeaks(stage.deliverable?.instructions), [],
      `stage ${stage.ordinal} deliverable tells the model it is being tested`);
  }

  // AND THE PLAN IS REFUSED rather than merely reported, so a reworded instruction cannot
  // reach a six-hour run.
  const poisoned = JSON.parse(JSON.stringify(plan));
  poisoned.stages[0].instructions += " You will be asked about them later.";
  assert.throws(() => validateStagePlan(poisoned), /tells the model it is being tested/,
    "a plan carrying the test premise still validates, so it could be launched");

  // The staging source no longer builds any of it.
  const staging = readFileSync(join(PROJECT, "scripts", "stage_pi_context_experiment.mjs"), "utf8");
  for (const gone of [
    "you will be asked", "may not get another delivery", "are not\n    resent",
    "recover them however you must", "Answer the following recall questions",
  ]) {
    assert(!staging.includes(gone), `the staging script still writes "${gone}"`);
  }
  // The working half of the instruction stays: dropping the premise must not drop
  // the task. What survives is the ASSIGNMENT, not a memory strategy.
  assert(staging.includes("build an accurate working") &&
    staging.includes("model of what it does, what it depends on, and which names it exports."),
  "the reading task was dropped along with the hoarding direction");
  // Scoped to the function BODY: the comment above it quotes the removed line on
  // purpose, and a scan of the whole file would be satisfied by deleting the
  // explanation rather than the instruction.
  const readBody = /function readInstruction\(stage, files\) \{\n  return \[\n([\s\S]*?)\n  \]/.exec(staging);
  assert(readBody, "the sweep cannot read readInstruction, so it is scanning nothing");
  assert.deepEqual(testAwarenessLeaks(readBody[1]), [],
    "the read instruction still tells the model what to hoard");
  const probeBody = /function probeInstruction\(\) \{[\s\S]*?return \[\n([\s\S]*?)\n  \]/.exec(staging);
  assert(probeBody, "the sweep cannot read probeInstruction, so it is scanning nothing");
  assert.deepEqual(testAwarenessLeaks(probeBody[1]), [],
    "the probe instruction still tells the model it is being tested");
  // A guess is not evidence of recall. Inviting one turned pi-fold's lost stage-15
  // code word into a confident cw-509a30 that exists nowhere in the plan, and the
  // run then found its own invention on a later search.
  assert(!/even if you are not certain/.test(probeBody[1]),
    "the probe instruction still licenses a guess over a check");

  // EVERY MODEL-FACING SURFACE THE WORKER BUILDS, not just the plan's. The system
  // prompt reaches more requests than any stage instruction and was never scanned,
  // which is how "keep an exact working memory of the identifiers, paths and line
  // positions you have seen" survived the first pass.
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");
  for (const [name, pattern] of [
    ["workloadSystemPrompt", /function workloadSystemPrompt\(\) \{\n  return \[\n([\s\S]*?)\n  \]/],
    ["workloadPrompt", /function workloadPrompt\(firstChallenge\) \{\n  return \[\n([\s\S]*?)\n  \]/],
    ["resumePrompt", /function resumePrompt\(stage, stageCount\) \{\n  return \[\n([\s\S]*?)\n  \]/],
  ]) {
    const found = pattern.exec(worker);
    assert(found, `the sweep cannot read ${name}, so it is scanning nothing`);
    assert.deepEqual(testAwarenessLeaks(found[1]), [],
      `${name} tells the model it is being tested or what to hoard`);
  }
  assert(!/keep an exact working memory/.test(worker),
    "the worker still directs the model's memory strategy");

  checks.noInstructionTellsTheModelItIsBeingTested = true;
}

// ---------------------------------------------------------------------------
// GATE 63 - the transcript-search tool is WITHDRAWN, and each arm carries only
// its shipped mechanism.
//
// The tool ran in exactly one sealed campaign, sol-20260814-traps, and measured
// itself: Pi's compaction summary preserves answered probes as a completed-work
// checklist, so the native arm re-read its own answers rather than exercising
// compaction, and its one genuine dig cost six refining queries. An arm holding
// an exact archive search is not a bytes-abandoned baseline (both external
// reviews, 2026-08-14). The tool name stays exported because the wave-recovery
// lens reads it out of sealed transcripts, where the searches really happened.
// ---------------------------------------------------------------------------
{
  // The ledger tool is arm-SYMMETRIC: both arms carry the identical workload
  // surface, so its presence changes nothing about this gate's law that no arm
  // holds a recovery mechanism the other lacks.
  assert.deepEqual([...EXPERIMENT_ALLOWED_TOOLS],
    ["read", EXPERIMENT_TOOL_NAME, EXPERIMENT_LEDGER_TOOL_NAME],
    "the primary surface is read, the stage tool and the ledger tool, and nothing else");
  assert(!EXPERIMENT_PIFOLD_EXTRA_TOOLS.includes(EXPERIMENT_HISTORY_TOOL_NAME),
    "the history tool came back as an arm-specific extra");
  assert.equal(EXPERIMENT_HISTORY_TOOL_NAME, "session_history",
    "the lens constant drifted, so sealed runs' searches would stop being readable");
  const extension = readFileSync(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"), "utf8");
  assert(!extension.includes("EXPERIMENT_HISTORY_TOOL_NAME,") ||
    !/registerTool\(\{\s*name: EXPERIMENT_HISTORY_TOOL_NAME/.test(extension),
  "the extension still registers the transcript-search tool");
  assert(!/searchSessionHistory/.test(extension),
    "the extension still carries the search implementation");
  const staging = readFileSync(join(PROJECT, "scripts", "stage_pi_context_experiment.mjs"), "utf8");
  assert(!staging.includes("session_history"),
    "a stage instruction names the withdrawn tool");
  checks.eachArmCarriesOnlyItsShippedMechanism = true;
}
// GATE 64 - the serving budget is a declared BASIS, and an arm that needs one cannot run
// without it.
//
// Declaring 251,520 is the descriptor window less Pi's reserve, and it caps both arms below
// the provider's 272,000 long-context tier by construction. luna-20260807 (Sol throughout;
// the campaign name is only a label) predates the constant: native drifted to 369,024 and
// was billed the surcharge on 17 of 117 calls at $20.99, while folding held pi-fold at
// 236,861 so it never left the base tier at $13.89. That surcharge was the whole cost
// result, and declaring a budget designs it out, which is how sol-20260814-fenced-full came
// back the other way at $20.88 to $13.74. Neither basis is wrong. Running one and reporting
// the other would be, so the basis is stated at launch and recorded in the manifest.
// ---------------------------------------------------------------------------
{
  const runner = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment.mjs"), "utf8");
  assert(/--provider-input-budget/.test(runner), "the run cannot declare its own basis");
  assert(/requestedBudget === null \|\| requestedBudget === "none"/.test(runner),
    "the budget is settable to an arbitrary number, which makes it a tuning dial rather than a basis");
  assert(/arm !== "nativefence" \|\| providerInputBudget !== null/.test(runner),
    "the matched-fence arm can be launched with no budget to fence against, and would die after being paid for");
  // The declared value still comes from the model pin and never from the flag: the flag can
  // only say "none", so a run cannot quietly serve a budget no deployment would have.
  assert(/EXPERIMENT_PROVIDER_INPUT_BUDGETS\[`\$\{modelProvider\}\/\$\{modelId\}`\]/.test(runner),
    "the declared budget stopped coming from the model pin");

  const launcher = readFileSync(join(PROJECT, "scripts", "launch_pi_context_experiment.sh"), "utf8");
  assert(/--provider-input-budget\)/.test(launcher) && /BUDGET_ARGS/.test(launcher),
    "the launcher cannot pass the basis through, so it could only be set by hand");
  assert(/none\) BUDGET_ARGS="--provider-input-budget none";; \*\)/.test(launcher),
    "the launcher accepts a basis it cannot mean");

  checks.theServingBudgetIsADeclaredBasis = true;
}

// ---------------------------------------------------------------------------
// GATE 65 - a code word that was WITHDRAWN and replaced, which is the case a
// single search gets wrong.
//
// searchSessionHistory returns the EARLIEST matches first, so one query on
// "code word for stage NN" surfaces the withdrawn value before its replacement.
// That is the exact query the native arm used to win probe-32-04 in
// sol-20260814-deployment, so this trap is aimed at the strategy that actually
// won rather than at a hypothetical one. The gate proves the trap TRAPS (a
// first-hit reader lands on the stale value), that both waves are measured (one
// carrier withdrawn, one standing), and that the asking does not give it away:
// the question is byte-identical either way, so the agent cannot tell a trapped
// carrier from a clean one by reading the question.
// ---------------------------------------------------------------------------
{
  const words = stageCodeWords("reissue-fixture", 8);
  const replacements = stageCodeWordReissues("reissue-fixture", 8);
  assert.equal(new Set([...words, ...replacements]).size, 16,
    "originals and replacements share a value, so a probe would have two right answers");
  // Stage 1's word is withdrawn at stage 3; stage 2's stands.
  const carriers = [
    { ordinal: 1, kind: "read", codeWord: words[0], codeWordReissue: null },
    { ordinal: 2, kind: "read", codeWord: words[1], codeWordReissue: null },
    { ordinal: 3, kind: "read", codeWord: words[2],
      codeWordReissue: { stage: 1, codeWord: replacements[0] } },
    { ordinal: 4, kind: "probe", codeWord: null, codeWordReissue: null },
  ];
  assert.equal(effectiveCodeWord(carriers, 1), replacements[0]);
  assert.equal(effectiveCodeWord(carriers, 2), words[1]);
  assert.notEqual(effectiveCodeWord(carriers, 1), words[0]);
  assert.equal(reissueAnnouncedAt(carriers, 1), 3);
  assert.equal(reissueAnnouncedAt(carriers, 2), null);

  // THE TRAP ITSELF. Both sentences answer the same text query, and the one an
  // earliest-first reading meets carries the withdrawn value alone: any naive
  // recovery over the raw transcript (a text search, a skim from the top) lands
  // on the stale value by construction, while chronological summarization must
  // carry the correction. The properties are asserted on the sentences
  // themselves, since the sentences are what any reader reads.
  const original = codeWordSentence(1, words[0]);
  const withdrawal = codeWordReissueSentence(1, replacements[0]);
  const phrase = "code word for stage 01";
  assert(original.includes(phrase) && withdrawal.includes(phrase),
    "the withdrawal must answer the same text query as the original, or it is not a trap");
  assert(original.includes(words[0]) && !original.includes(replacements[0]),
    "the earliest-met sentence already carries the correction, so the trap is vacuous");
  assert(withdrawal.includes(replacements[0]) && !withdrawal.includes(words[0]),
    "the correction does not carry the live value alone, so order stops mattering");

  // Wave selection: one wave demands a withdrawn carrier, the next a standing
  // one, and each expects the value that is LIVE for the carrier it drew.
  const withCarriers = (requireReissued) => buildConversationProbes({
    stages: carriers.map((stage) => ({ ...stage, files: [{ path: `f${stage.ordinal}.rs` }] })),
    probeOrdinal: 6,
    seed: "reissue-fixture",
    kinds: ["stage-fact"],
    usedStages: new Set(),
    requireReissued,
  })[0];
  const trappedProbe = withCarriers(true);
  const cleanProbe = withCarriers(false);
  assert.equal(trappedProbe.sourceStage, 1);
  assert.equal(trappedProbe.expectedAnswer, replacements[0]);
  assert.notEqual(trappedProbe.expectedAnswer, words[0]);
  // The clean carrier is whichever standing stage the shuffle drew. A stage that
  // ANNOUNCES a withdrawal is itself untrapped: its own word still stands, which
  // is why this reads the drawn ordinal rather than pinning one.
  assert.equal(reissueAnnouncedAt(carriers, cleanProbe.sourceStage), null);
  assert.equal(cleanProbe.expectedAnswer, words[cleanProbe.sourceStage - 1]);
  assert.notEqual(cleanProbe.sourceStage, trappedProbe.sourceStage);
  // No tell: the two questions differ only in the stage number they name.
  const anonymised = (probe) =>
    probe.question.replace(`stage ${String(probe.sourceStage).padStart(2, "0")}`, "stage NN");
  assert.equal(anonymised(trappedProbe), anonymised(cleanProbe));
  assert(!/reissu|withdraw|correct|replac|error/i.test(trappedProbe.question),
    "the question announces that a correction exists, and would measure the announcement");

  // Plan laws. Every mutation below was run against the unmutated plan first, so
  // none of these assertions passes by accident of an unrelated failure.
  const reseal = (mutated) => {
    mutated.planSha256 = stagePlanSha256(mutated);
    return mutated;
  };
  const carrierIndex = plan.stages.findIndex((stage) => stage.kind !== "probe");
  const announcerIndex = plan.stages.findIndex((stage) => stage.kind !== "probe" &&
    stage.ordinal > plan.stages[carrierIndex].ordinal);
  const carrierOrdinal = plan.stages[carrierIndex].ordinal;
  // The unmutated plan validates, which is what makes each throw below attributable.
  validateStagePlan(reseal(structuredClone(plan)));
  // A withdrawal must name an EARLIER stage.
  assert.throws(() => {
    const bad = structuredClone(plan);
    bad.stages[announcerIndex].codeWordReissue =
      { stage: bad.stages[announcerIndex].ordinal, codeWord: replacements[5] };
    validateStagePlan(reseal(bad));
  }, /reissues a stage that is not earlier/);
  // A withdrawal that changes nothing is not a withdrawal.
  assert.throws(() => {
    const bad = structuredClone(plan);
    const unchanged = bad.stages[carrierIndex].codeWord;
    bad.stages[announcerIndex].codeWordReissue = { stage: carrierOrdinal, codeWord: unchanged };
    bad.stages[announcerIndex].instructions +=
      ` ${codeWordReissueSentence(carrierOrdinal, unchanged)}`;
    validateStagePlan(reseal(bad));
  }, /malformed, unchanged, or repeated/);
  // A withdrawal the agent was never shown cannot be recalled.
  assert.throws(() => {
    const bad = structuredClone(plan);
    bad.stages[announcerIndex].codeWordReissue =
      { stage: carrierOrdinal, codeWord: replacements[5] };
    validateStagePlan(reseal(bad));
  }, /does not carry its reissue sentence/);
  // A stage-fact probe expecting the WITHDRAWN value is the defect this whole
  // mechanism exists to make impossible.
  assert.throws(() => {
    const bad = structuredClone(plan);
    const wave = bad.stages.find((stage) => stage.probes.some((probe) => probe.kind === "stage-fact"));
    const probe = wave.probes.find((candidate) => candidate.kind === "stage-fact");
    const target = bad.stages[probe.sourceStage - 1];
    const announcer = bad.stages.find((stage) => stage.kind !== "probe" &&
      stage.ordinal > target.ordinal && stage.ordinal < wave.ordinal);
    assert(announcer, "smoke fixture has no stage between the carrier and its wave");
    announcer.codeWordReissue = { stage: target.ordinal, codeWord: replacements[6] };
    announcer.instructions += ` ${codeWordReissueSentence(target.ordinal, replacements[6])}`;
    validateStagePlan(reseal(bad));
  }, /disagrees with carrier/);
  checks.aWithdrawnCodeWordTrapsAFirstHitSearch = true;
}

// ---------------------------------------------------------------------------
// GATE 66 - a wave that cost nothing to answer says so.
//
// The probe score alone hides which waves were free. In sol-20260814-deployment
// the native arm compacted at entries 99, 250, 329 and 457 while the waves
// landed at 91, 236, 321 and 470, so wave 16 was answered with NO compaction yet
// and stages 1-15 entirely raw. Occupancy is emergent and a static plan cannot
// schedule a wave to land after a reset, so the instrument reports the condition
// instead of pretending to control it. The same lens caught the other arm's
// failure from the opposite side: pifold answered wave 32 with zero recovery
// calls and lost both of its probes there, which is the shape of a guess.
// ---------------------------------------------------------------------------
{
  const entryAt = (index) => ({ id: `e${index}`, type: "message" });
  const toolResult = (toolName) => ({ type: "message", message: { role: "toolResult", toolName } });
  const entries = [
    toolResult(EXPERIMENT_TOOL_NAME),          // 0: wave one delivered
    toolResult("read"),                        // 1
    entryAt(2),                                // 2: wave one answered
    { type: "compaction" },                    // 3: the reset
    toolResult(EXPERIMENT_TOOL_NAME),          // 4: wave two delivered
    toolResult(EXPERIMENT_HISTORY_TOOL_NAME),  // 5
    toolResult(EXPERIMENT_HISTORY_TOOL_NAME),  // 6
    toolResult("pi_fold_context"),             // 7
    toolResult(EXPERIMENT_TOOL_NAME),          // 8: another stage, never recovery
    entryAt(9),                                // 9: wave two answered
  ];
  const transcripts = [
    { stage: 16, resultEntryIndex: 0, answerEntryIndex: 2 },
    { stage: 32, resultEntryIndex: 4, answerEntryIndex: 9 },
  ];
  const rows = probeWaveRecovery({ entries, transcripts });
  assert.equal(rows.length, 2);
  // THE FREE WAVE: nothing had reset yet, which is reported as null rather than
  // as a large distance that would read like the opposite.
  assert.equal(rows[0].lastResetKind, null);
  assert.equal(rows[0].entriesSinceReset, null);
  assert.equal(rows[0].fileReads, 1);
  assert.equal(rows[0].recoveryCalls, 1);
  // THE DUG WAVE, and the stage tool is never counted as recovery: asking for
  // the next stage is the workload, not an attempt to recover anything.
  assert.equal(rows[1].lastResetKind, "compaction");
  assert.equal(rows[1].entriesSinceReset, 1);
  assert.equal(rows[1].historySearches, 2);
  assert.equal(rows[1].contextToolCalls, 1);
  assert.equal(rows[1].fileReads, 0);
  assert.equal(rows[1].recoveryCalls, 3);
  // A committed fold epoch is the pifold arm's reset, so both arms report against
  // the same column rather than one of them reporting nothing.
  const folded = [
    { type: "custom", customType: `acme-${CONTEXT_EVENT_SUFFIX}`, data: { kind: "context.commit" } },
    toolResult(EXPERIMENT_TOOL_NAME),
    entryAt(2),
  ];
  const foldedRows = probeWaveRecovery({
    entries: folded, transcripts: [{ stage: 16, resultEntryIndex: 1, answerEntryIndex: 2 }],
  });
  assert.equal(foldedRows[0].lastResetKind, "commit");
  assert.equal(foldedRows[0].entriesSinceReset, 1);
  // ZERO RECOVERY IS REPORTABLE, which is the pifold wave-32 shape.
  assert.equal(foldedRows[0].recoveryCalls, 0);
  // An undelivered wave reports as such rather than throwing or scoring zero work.
  const missing = probeWaveRecovery({
    entries, transcripts: [{ stage: 48, resultEntryIndex: null, answerEntryIndex: null }],
  });
  assert.equal(missing[0].delivered, false);
  // The adjudicator actually reports it, or the lens is dead code.
  const grader = readFileSync(join(PROJECT, "scripts", "adjudicate_pi_context_experiment.mjs"), "utf8");
  assert(/probeWaveRecovery\(\{ entries: runEntries, transcripts: probes \}\)/.test(grader) &&
    /^\s*waveRecovery,$/m.test(grader),
  "the wave-recovery lens is computed but never reported");
  checks.aWaveThatCostNothingToAnswerSaysSo = true;
}

// ---------------------------------------------------------------------------
// GATE 67 - a read that leaves the checkout is refused, and containment is the
// RESOLVED path.
//
// Pi's read tool applies no containment of its own: resolveReadPathAsync
// resolves against cwd and reads whatever exists. The corpus sweep (2026-08-14,
// one predicate over every sealed run) found 10 runs that used it: 313 escaping
// reads, 178 returning content, 14 results across 5 runs carrying the plan's own
// expectedAnswer, every one on a native or nativefence arm. sol-20260812
// native-rep9 is the proof of use: /proc/self/cmdline to run-config.json to
// stages-full.json, then probe-64-06 answered verbatim off the key with a false
// provenance sentence. Zero pifold runs ever left the checkout, so the
// contamination inflated the arm pi-fold loses to.
//
// The judgment is containment, not spelling: ".." and absolute forms are also
// how legitimate reads INSIDE the checkout arrive (60 such across two pifold
// runs), so a string predicate is exactly wrong. And a blocked read is a
// refusal the model can correct, not a run failure: it leaked nothing.
//
// The 2026-08-14 external review then held the gate to its own prose: "resolved
// path" was proven only as normalized SPELLING, on a root that never existed.
// The gate now drives a real filesystem: the judged target is canonical, a link
// inside the checkout pointing outside is refused by where it LANDS, a
// symlinked alias of the root itself still admits its own files, a path that
// does not exist keeps the lexical verdict because it cannot leak, and a read
// naming NO path is refused as missing rather than coerced to the root and
// waved through, which was an allow on malformed input.
// ---------------------------------------------------------------------------
{
  const ground = mkdtempSync(join(tmpdir(), "pi-context-experiment-containment-"));
  const runDir = join(ground, "state", "campaign", "runs", "run-1");
  const repoDir = join(runDir, "repo");
  mkdirSync(join(repoDir, "lib", "vtls"), { recursive: true });
  mkdirSync(join(repoDir, "notes"), { recursive: true });
  mkdirSync(`${repoDir}-shadow`, { recursive: true });
  writeFileSync(join(repoDir, "lib", "vtls", "gtls.h"), "struct gtls;\n");
  writeFileSync(join(runDir, "run-config.json"), "{}\n");
  writeFileSync(join(ground, "state", "campaign", "stages-full.json"), "{}\n");
  writeFileSync(join(`${repoDir}-shadow`, "file.c"), "int shadow;\n");
  symlinkSync(join(runDir, "run-config.json"), join(repoDir, "notes", "current"));
  symlinkSync(join("..", "lib", "vtls", "gtls.h"), join(repoDir, "notes", "header"));
  symlinkSync(repoDir, join(ground, "repo-alias"));
  const inside = (path) => readEscapesCheckout(repoDir, path);
  // Stays: relative, absolute-inside, dot-segments that resolve back inside,
  // and the checkout root itself.
  assert.equal(inside("lib/vtls/gtls.h").escapes, false);
  assert.equal(inside(`${repoDir}/lib/vtls/gtls.h`).escapes, false);
  assert.equal(inside("lib/../lib/vtls/gtls.h").escapes, false);
  assert.equal(inside(".").escapes, false);
  // Refused: every route the contaminated runs actually took.
  assert.equal(inside("../run-config.json").escapes, true);
  assert.equal(inside("../../../stages-full.json").escapes, true);
  assert.equal(inside("/proc/self/cmdline").escapes, true);
  assert.equal(inside("/opt/checkout-elsewhere/scripts/stage_pi_context_experiment.mjs").escapes, true);
  // The sibling-prefix trap: a directory whose name merely STARTS with the
  // checkout root is outside it, which is why the boundary is root + separator.
  assert.equal(readEscapesCheckout(repoDir, `${repoDir}-shadow/file.c`).escapes, true);
  // A link is judged by where it LANDS. The spelling "notes/current" never
  // leaves the root; the filesystem object it names is the run configuration
  // one level up, and that is what the verdict reports.
  const followed = inside("notes/current");
  assert.equal(followed.escapes, true);
  assert.equal(followed.resolved, realpathSync.native(join(runDir, "run-config.json")));
  assert.equal(followed.cause, "link-target");
  // A link that lands inside stays readable, and so does the checkout reached
  // through a symlinked alias of its own root: canonical against canonical.
  assert.equal(inside("notes/header").escapes, false);
  assert.equal(readEscapesCheckout(join(ground, "repo-alias"), "lib/vtls/gtls.h").escapes, false);
  // A path that does not exist cannot leak and keeps the lexical verdict, in
  // both directions.
  assert.equal(inside("lib/never-written.c").escapes, false);
  assert.equal(inside("../never-written.json").escapes, true);
  // A read naming NO path is refused as missing, never coerced to the root.
  for (const missing of [undefined, null, "", "   "]) {
    const verdict = readEscapesCheckout(repoDir, missing);
    assert.equal(verdict.escapes, true, "a pathless read was waved through");
    assert.equal(verdict.resolved, null);
    assert.equal(verdict.cause, "missing-path");
  }
  // The resolved path travels with the verdict so the artifact names what was
  // actually judged, not what was typed.
  assert.equal(inside("../run-config.json").resolved,
    realpathSync.native(join(runDir, "run-config.json")));
  assert.throws(() => readEscapesCheckout("relative/repo", "x"), /absolute checkout root/);
  rmSync(ground, { recursive: true, force: true });
  // And the extension enforces it on the read tool through THIS predicate, with
  // the refusal correctable, the missing-path case named as its own correction,
  // and the attempt recorded as its own event.
  const extension = readFileSync(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"), "utf8");
  assert(/readEscapesCheckout\(config\.repoDir, requested\)/.test(extension),
    "the extension does not judge reads with the shared containment predicate");
  assert(/read-escape-blocked/.test(extension),
    "a blocked read leaves no event, so a probing run would be invisible");
  assert(/This run reads only files inside the repository checkout/.test(extension),
    "the refusal does not tell the model how to correct");
  assert(/This read named no path/.test(extension),
    "a pathless read is not refused with its own correction");
  assert(!/appendFailure\(config, "read-escape/.test(extension),
    "a blocked read latches a failure, which turns a leak-free refusal into a dead six-hour run");
  checks.aReadOutsideTheCheckoutIsRefusedByResolution = true;
}

// Gate 69 (2026-08-15): a fact's carriage is attributed at the answering request.
//
// The hidden-mass instrument stands on one primitive: for a fact string and a
// provider request, say whether the fact rode the projection raw, rode it inside
// a visible brief, sat one peek away, or was absent, with an absence that exists
// on a dead branch named as the off-branch entries a native discard leaves. The
// lens earned its gate on its first sealed sweep: rep 4's log entry claimed
// three missed bindings were "recorded in channels briefs do not claim", and the
// lens showed they were never recorded at all, in any format, in any channel.
// The classification half is pure and driven here across every class; the
// loader half composes the runtime's own materializeStatePersistence, exercised
// on the no-state branch shape a native session presents, so an arm with no
// fold records classifies raw-versus-absent through the same reading.
{
  const attribution = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")).href);
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, message, timestamp: 1 });
  const entries = [
    entry("e1", null, { role: "user", content: [{ type: "text", text: "the ask" }] }),
    entry("e2", "e1", { role: "toolResult", content: [{ type: "text", text: "covered fact cov-123" }] }),
    entry("e3", "e2", { role: "toolResult", content: [{ type: "text", text: "expanded fact exp-456" }] }),
    entry("e4", "e3", {
      role: "assistant",
      content: [
        { type: "text", text: "raw fact raw-789" },
        { type: "toolCall", id: "c1", name: "submit", arguments: { row: "arg-fact-000" } },
      ],
    }),
    { type: "custom", id: "x1", parentId: "e4", customType: "interleaved-record", data: {}, timestamp: 1 },
    entry("e5", "x1", { role: "assistant", content: [{ type: "text", text: "probe-1: answered" }] }),
    entry("e6", "e2", { role: "toolResult", content: [{ type: "text", text: "discarded fact dead-999" }] }),
  ];
  const branch = attribution.branchTo(entries, "e5");
  assert.deepEqual(branch.map((item) => item.id), ["e1", "e2", "e3", "e4", "x1", "e5"],
    "the branch walk does not follow the parent chain through interleaved records");
  const view = {
    branch,
    visibleBriefs: [{ foldId: "F1", brief: "root brief carrying bf-111" }],
    recoverableBriefs: [{ foldId: "F2", brief: "hidden child brief carrying cf-222" }],
    coveredEntryIds: new Set(["e2", "e3"]),
    visibleSourceEntryIds: new Set(["e3"]),
  };
  const classify = (fact) => attribution.classifyFactCarriage(view, fact).classification;
  assert.equal(classify("cov-123"), "recoverable", "a folded source did not classify recoverable");
  assert.equal(classify("exp-456"), "visible-raw", "an expanded fold's source did not classify raw");
  assert.equal(classify("raw-789"), "visible-raw", "plain assistant text did not classify raw");
  assert.equal(classify("arg-fact-000"), "visible-raw",
    "a tool call argument did not count as projection bytes, which is the channel rep 4 recorded in");
  assert.equal(classify("bf-111"), "visible-brief", "a visible root brief did not classify visible-brief");
  assert.equal(classify("cf-222"), "recoverable",
    "a hidden child brief classified as visible, so consolidation would hide nothing");
  assert.equal(classify("zz-none"), "absent", "an unstated fact did not classify absent");
  const detail = attribution.classifyFactCarriage(view, "cov-123");
  assert.deepEqual(detail.recoverableSourceEntryIds, ["e2"], "the recoverable carrier is not named");
  assert.equal(attribution.attributeFactInView({ view, entries, fact: "dead-999" }).classification,
    "absent", "a prebuilt carriage view drifted from the session reading");
  // The loader half on the native shape: no state records, so the runtime
  // materializes an empty forest and everything on the branch reads raw, while
  // a fact only on the dead fork is absent WITH its off-branch entries named.
  const jitiPath = join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs");
  assert(existsSync(jitiPath), "could not resolve package-local jiti for the attribution loader");
  const { createJiti } = await import(pathToFileURL(jitiPath));
  const runtimeForLens = await createJiti(import.meta.url)
    .import(join(PROJECT, "extensions", "active-context.ts"));
  // The nested projection is the case a flat expanded-ref set gets wrong. An
  // expanded parent renders the collapsed CHILD PLACEHOLDER, not the child's
  // raw source. Pin the runtime's rendered bytes first so the attribution
  // assertions below cannot pass by inventing a different projection law.
  const nestedSnapshotBase = runtimeForLens.mapActiveContext({
    sessionId: "attribution-fixture",
    eventMessages: branch.flatMap((item) => runtimeForLens.sessionEntryMessages(item)),
    contextEntries: branch,
    contextWindow: 100_000,
    netBudget: true,
  });
  const nestedSnapshot = {
    ...nestedSnapshotBase,
    protectedIndices: new Set(),
    toolProtectedIndices: new Set(),
  };
  const nestedRef = nestedSnapshot.mapped.find((item) => item.ref?.entryId === "e2")?.ref;
  assert(nestedRef, "the nested attribution fixture did not map its source entry");
  const childFold = {
    id: "fold_attribution_child",
    kind: "chapter",
    parentId: "fold_attribution_parent",
    parts: [{ kind: "raw", ref: nestedRef }],
    brief: "Nested child brief carries nested-brief-333.",
    provenance: { kind: "deterministic" },
    sourceSha256: nestedRef.sha256,
    sourceChars: 100,
    placeholderChars: 50,
    createdAt: 1,
  };
  const parentFold = {
    id: "fold_attribution_parent",
    kind: "consolidation",
    parentId: null,
    parts: [{ kind: "fold", foldId: childFold.id }],
    brief: "Parent brief carries parent-brief-444.",
    provenance: { kind: "deterministic" },
    sourceSha256: nestedRef.sha256,
    sourceChars: 100,
    placeholderChars: 50,
    createdAt: 2,
  };
  const nestedState = {
    ...runtimeForLens.emptyActiveContextState("attribution-fixture"),
    folds: [childFold, parentFold],
    expanded: [parentFold.id],
  };
  const nestedProjection = JSON.stringify(
    runtimeForLens.renderFold(parentFold, nestedState, nestedSnapshot));
  assert(nestedProjection.includes("nested-brief-333"),
    "the runtime did not render the collapsed child's brief under an expanded parent");
  assert(!nestedProjection.includes("covered fact cov-123"),
    "the runtime revealed a collapsed child's raw source under an expanded parent");
  const nestedCarriers = attribution.projectionCarriers({
    runtime: runtimeForLens, state: nestedState, snapshot: nestedSnapshot,
  });
  const nestedView = { branch, ...nestedCarriers };
  assert.equal(attribution.classifyFactCarriage(nestedView, "nested-brief-333").classification,
    "visible-brief", "a collapsed child under an expanded parent did not classify as a visible brief");
  assert.equal(attribution.classifyFactCarriage(nestedView, "cov-123").classification,
    "recoverable", "an expanded parent incorrectly made its collapsed child's source visible raw");
  // Collapse the parent and only its own brief remains visible. This catches a
  // second flat-walk failure: directFoldOwners maps evidence refs, not child
  // fold ids, so it cannot be used to decide which folds are roots.
  const collapsedCarriers = attribution.projectionCarriers({
    runtime: runtimeForLens,
    state: { ...nestedState, expanded: [] },
    snapshot: nestedSnapshot,
  });
  assert.deepEqual(collapsedCarriers.visibleBriefs.map((item) => item.foldId), [parentFold.id],
    "a collapsed parent's hidden child brief was classified as root-visible");
  assert(collapsedCarriers.recoverableBriefs.some((item) => item.foldId === childFold.id),
    "a child behind its parent was not kept recoverable");
  // Protection is the other runtime reveal path. It must expose the protected
  // child's source through both levels rather than leaving the lens behind the
  // provider projection.
  const protectedState = { ...nestedState, protected: [structuredClone(nestedRef)] };
  const protectedProjection = JSON.stringify(
    runtimeForLens.renderFold(parentFold, protectedState, nestedSnapshot));
  assert(protectedProjection.includes("covered fact cov-123"),
    "the runtime did not reveal explicitly protected nested source");
  const protectedCarriers = attribution.projectionCarriers({
    runtime: runtimeForLens, state: protectedState, snapshot: nestedSnapshot,
  });
  assert(protectedCarriers.visibleSourceEntryIds.has("e2"),
    "the attribution lens did not follow the runtime's protected-source reveal");
  const nativeReading = (fact) => attribution.attributeFactInSession({
    runtime: runtimeForLens, entries, sessionId: "attribution-fixture", leafId: "e5", fact,
    stateEntryType: "acme-active-context-state", foldRecordEntryType: "acme-active-context-fold-record",
  });
  assert.equal(nativeReading("raw-789").classification, "visible-raw",
    "the no-state branch did not read raw through the runtime loader");
  const discarded = nativeReading("dead-999");
  assert.equal(discarded.classification, "absent");
  assert.deepEqual(discarded.offBranchEntryIds, ["e6"],
    "a dead-branch fact did not name its off-branch entries, so a discard reads as never-stated");
  assert.equal(nativeReading("zz-none").offBranchEntryIds, undefined,
    "a never-stated fact grew off-branch entries it does not have");
  // The answer-to-request join walks ancestors to the request leaf, through the
  // interleaved record that sits between the leaf and the response.
  const joined = attribution.requestForAnswer({
    entries, requests: [{ leafId: "e4", ordinal: 7 }], answerText: "probe-1:",
  });
  assert.equal(joined?.request.ordinal, 7, "the answering request was not found through its leaf");
  assert.equal(joined?.answerEntryId, "e5");
  assert.equal(attribution.requestForAnswer({
    entries, requests: [{ leafId: "e4", ordinal: 7 }], answerText: "no such answer",
  }), null, "a missing answer did not return null");
  // A sealed full run exhausts memory if every reconstructed forest stays in
  // one process. The instrument owns a fixed four-row batch, releases each
  // child before the next, and keeps the heavy runtime import in the child.
  assert.equal(attribution.ATTRIBUTION_BATCH_ROWS, 4,
    "the carriage sweep's memory bound drifted from four rows");
  assert.deepEqual(attribution.attributionBatchStarts(0), []);
  assert.deepEqual(attribution.attributionBatchStarts(10), [0, 4, 8],
    "the carriage sweep does not cover every row once in fixed batches");
  assert.throws(() => attribution.attributionBatchStarts(-1), /non-negative safe integer/);
  const driver = readFileSync(join(PROJECT, "scripts", "attribute_probe_carriage.mjs"), "utf8");
  assert(/for \(const start of attributionBatchStarts\(totalRows\)\)/.test(driver),
    "the campaign sweep does not use the fixed batch partition");
  assert(/spawnSync\(process\.execPath/.test(driver),
    "the campaign sweep does not release one child before starting the next");
  assert(/if \(leafId !== cachedLeafId\)/.test(driver),
    "one batch rebuilds the same answering leaf for every fact");
  assert(/providerInputBudget: runConfig\.providerInputBudget/.test(driver),
    "the carriage snapshot does not use the run's declared serving budget");
  assert(driver.indexOf("const { createJiti }") > driver.indexOf("async function runAttributionBatch"),
    "the parent loads the transcript runtime before it delegates a bounded batch");
  // The release extract is the paper-facing source of numbers. It is complete,
  // self-hashed, portable, and bound to the current extractor and carriage lens.
  const resultPath = join(PROJECT, "docs", "fold_vs_compaction", "hidden-mass-results.json");
  assert(existsSync(resultPath), "the hidden-mass release result is missing");
  const releaseResult = JSON.parse(readFileSync(resultPath, "utf8"));
  const { extractSha256, ...resultBody } = releaseResult;
  assert.equal(extractSha256, sha256Json(resultBody),
    "the hidden-mass release result changed without regenerating its self-hash");
  assert.equal(releaseResult.version, 2,
    "the corrected nested-carriage semantics did not bump the portable result schema");
  assert.equal(releaseResult.planSha256,
    "eb488827c46ddf630f79b582f0b75070c54e73a65cdf4045002a6fc785e572db");
  assert.deepEqual(releaseResult.findings.completion, {
    pifold: { completed: 2, attempted: 2 },
    native: { completed: 0, attempted: 2 },
  });
  assert.deepEqual(releaseResult.findings.ledgerRecordEndpoints, {
    pifold: { correct: 8, unknown: 0, total: 8 },
    native: { correct: 0, unknown: 8, total: 8 },
  });
  assert.deepEqual(releaseResult.findings.ordinaryProbes,
    { pifold: { matches: 40, total: 42 }, native: null });
  assert.deepEqual(releaseResult.findings.withheldEndBlock,
    { pifold: { matches: 60, total: 60, completedRuns: 2 }, native: null });
  assert.equal(releaseResult.findings.certification.rows, 102);
  assert.equal(releaseResult.findings.certification.ordinaryMismatchesWithVisibleBrief, 1);
  assert.equal(releaseResult.findings.certification.ordinaryMismatchesRecoverable, 1);
  assert.deepEqual(releaseResult.findings.certification.endBlockValueCarriage,
    { recoverable: 7, "visible-raw": 53 },
  "the corrected carrier walk did not preserve the seven non-visible end-block matches");
  assert.equal(releaseResult.carriageRows.length, 102,
    "the portable result thinned the completed carriage sweep");
  assert.equal(new Set(releaseResult.carriageRows.map((row) =>
    `${row.runId}:${row.probeId ?? row.endBlockId}`)).size, 102,
  "the carriage result repeats a row while claiming full coverage");
  assert.equal(releaseResult.sourceHashes.extractorSha256,
    sha256Text(readFileSync(join(PROJECT, "scripts", "extract_hidden_mass_results.mjs"), "utf8")),
  "the result was not regenerated by the current extractor");
  assert.equal(releaseResult.sourceHashes.carriageScriptSha256, sha256Text(driver),
    "the result was not certified by the current carriage sweep");
  assert.equal(releaseResult.sourceHashes.attributionHelperSha256,
    sha256Text(readFileSync(join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs"), "utf8")),
  "the result does not bind the helper that classified its carriage rows");
  assert.equal(releaseResult.sourceHashes.runtimeTreeSha256,
    directoryTreeSha256(join(PROJECT, "extensions")),
  "the result does not bind the runtime tree that reconstructed its fold state and projection");
  assert(!/\/(?:home|tmp)\//.test(JSON.stringify(releaseResult)),
    "the portable result leaks a machine-local path");
  assert(!Object.hasOwn(releaseResult.design.model, "maxTokens"),
    "the result copied a provider ceiling instead of the declared serving basis");
  assert(releaseResult.claimLimits.some((line) => /no direct cross-arm end-block score/.test(line)),
    "the release result omits the missing-native-end-block claim boundary");
  assert(releaseResult.claimLimits.some((line) => /do not estimate a population failure rate/.test(line)),
    "the release result turns two attempts into a population estimate");
  assert(releaseResult.claimLimits.some((line) =>
    /seven were recoverable but not visible/.test(line)),
  "the release result hides the corrected non-visible end-block carriers");
  checks.aFactsCarriageIsAttributedAtTheAnsweringRequest = true;
}

// ---------------------------------------------------------------------------
// GATE 70 - the seeded ledger: transcript-only facts in three channels, and the
// derive-and-record channel ending in a tool call the workload enforces.
//
// Task #79 build 2 of 3 (ratified 2026-08-15). The audit traces' values are
// stages and paths, and rep 4 of sol-20260814-traps re-derived them at probe
// time, so the derived class stopped measuring recall; its three missed
// bindings were never recorded anywhere because a record-it instruction is
// silently skippable. The ledger's values are seeded tokens planted nowhere in
// the checkout (the read fence and the closed-book floor pin the transcript as
// the only source), the whole ledger is a pure function of (mode, contentSeed)
// with the seed frozen in docs/fold_vs_compaction/hidden-mass-seeds.json before
// rep 4's readout, and each join's task must be RECORDED through the ledger
// tool before the next stage is deliverable: the echo makes the record a tool
// result, no verdict rides back, and correctness is graded post-hoc against
// the plan the supervisor keeps.
// ---------------------------------------------------------------------------
{
  // The ledger is its seed's own derivation, byte for byte, and nothing else's.
  const gateSeed = "feedfacefeedface";
  const smokeLedger = buildLedger({ mode: "smoke", contentSeed: gateSeed });
  assert.equal(JSON.stringify(smokeLedger),
    JSON.stringify(buildLedger({ mode: "smoke", contentSeed: gateSeed })),
    "same seed, byte-identical ledger");
  assert.notEqual(JSON.stringify(smokeLedger),
    JSON.stringify(buildLedger({ mode: "smoke", contentSeed: "0123456789abcdef" })),
    "a different seed rolls different values");
  const fullLedger = buildLedger({ mode: "full", contentSeed: gateSeed });
  const fullTokens = ledgerTokensOf(fullLedger);
  assert(fullTokens.every((token) => LEDGER_TOKEN_PATTERN.test(token)),
    "every planted value wears the ledger token shape");
  assert.equal(new Set(fullTokens).size, fullTokens.length,
    "no token serves two roles");
  // Full-mode geometry: everything in the first half on payload stages, the
  // table one row per designated stage in stage order, joins three hops with
  // the mode's gap, corrections original-early correction-late.
  const fullModePlan = EXPERIMENT_MODE_PLANS.full;
  const firstHalfPayload = (stage) => stage >= 1 && stage <= fullModePlan.stageCount / 2 &&
    !fullModePlan.probeStages.includes(stage);
  const everyStageOf = (ledger) => [
    ...ledger.table.map((entry) => entry.stage),
    ...ledger.singles.map((single) => single.stage),
    ...ledger.joins.flatMap((join) => [...join.links.map((link) => link.stage), join.taskStage]),
    ...ledger.corrections.flatMap((correction) => [correction.stage, correction.correctionStage]),
  ];
  assert(everyStageOf(fullLedger).every(firstHalfPayload),
    "every ledger row lands on a first-half payload stage");
  assert.equal(fullLedger.table.length, 16, "sixteen reconstruction rows in full mode");
  assert.deepEqual(fullLedger.table.map((entry) => entry.row),
    Array.from({ length: 16 }, (_, index) => index + 1));
  assert(fullLedger.table.every((entry, index) => index === 0 ||
    entry.stage > fullLedger.table[index - 1].stage),
  "table rows ride strictly increasing stages, so row order is stage order");
  assert.equal(fullLedger.joins.length, 4);
  for (const join of fullLedger.joins) {
    assert.equal(join.links.length, 3, "full-mode joins walk three hops");
    const stages = [...join.links.map((link) => link.stage), join.taskStage];
    assert(stages.every((stage, index) => index === 0 ||
      stage - stages[index - 1] >= fullModePlan.ledger.minGap),
    "join rows and the task keep the mode's minimum gap");
    assert(join.links.every((link, index) => index === 0 ||
      link.subject === join.links[index - 1].value),
    "each hop consumes the previous hop's value");
    assert.equal(join.expectedAnswer, join.links.at(-1).value);
  }
  for (const correction of fullLedger.corrections) {
    assert(correction.correctionStage - correction.stage >= fullModePlan.ledger.minGap,
      "a correction sits at least the mode's gap after its original");
  }
  // The live checksum is the correction where one exists, and an unknown
  // subject refuses rather than answering.
  const corrected = fullLedger.corrections[0];
  assert.equal(effectiveLedgerChecksum(fullLedger, corrected.subject), corrected.value);
  const single = fullLedger.singles[0];
  assert.equal(effectiveLedgerChecksum(fullLedger, single.subject), single.value);
  assert.throws(() => effectiveLedgerChecksum(fullLedger, "lv-nowhere"), /No ledger checksum/);
  // The trap shape: original and correction answer the same text query, so
  // order is the only separator (gate 65's law on transcript-only facts).
  const queryPhrase = `the checksum recorded for ${corrected.subject} is`;
  for (const stage of [corrected.stage, corrected.correctionStage]) {
    const carrier = ledgerSentencesForStage(fullLedger, stage)
      .filter((sentence) => sentence.includes(queryPhrase));
    assert.equal(carrier.length, 1,
      `stage ${stage} must carry exactly one sentence answering the checksum query`);
  }
  // No woven sentence tells the model it is being tested, the task names the
  // tool, the task id, the anchor and the unknown escape, and the only token a
  // task sentence carries is its anchor: never the answer, never a hop value.
  for (let stage = 1; stage <= fullModePlan.stageCount; stage += 1) {
    for (const sentence of ledgerSentencesForStage(fullLedger, stage)) {
      assert.deepEqual(testAwarenessLeaks(sentence), [], sentence);
    }
  }
  const taskJoin = fullLedger.joins[0];
  const taskSentence = ledgerTaskSentence(taskJoin);
  assert(taskSentence.includes(EXPERIMENT_LEDGER_TOOL_NAME) &&
    taskSentence.includes(taskJoin.id) && taskSentence.includes(LEDGER_UNKNOWN_VALUE),
  "the task sentence names the tool, the task id and the unknown escape");
  const taskTokens = taskSentence.match(/lv-[0-9a-f]{6}/g) ?? [];
  assert(taskTokens.length > 0 &&
    taskTokens.every((token) => token === taskJoin.links[0].subject),
  "a task sentence names its anchor and no other token");
  // Plan laws, each probed against the shared fixture: a tampered value dies on
  // re-derivation, an unwoven sentence and a re-stated fact and a leaked token
  // each die by their own names.
  const rehash70 = (mutated) => {
    mutated.planSha256 = stagePlanSha256(mutated);
    return mutated;
  };
  const bent = structuredClone(plan);
  bent.ledger.table[0].value = "lv-000000";
  assert.throws(() => validateStagePlan(rehash70(bent)), /not its own content seed's derivation/);
  const wovenStages = plan.stages
    .map((stage) => ({ ordinal: stage.ordinal, sentences: ledgerSentencesForStage(plan.ledger, stage.ordinal) }))
    .filter((entry) => entry.sentences.length > 0);
  assert(wovenStages.length > 0, "the fixture plan must actually weave ledger sentences");
  const wovenOrdinal = wovenStages[0].ordinal;
  const wovenSentence = wovenStages[0].sentences[0];
  const unwovenPlan = structuredClone(plan);
  unwovenPlan.stages[wovenOrdinal - 1].instructions =
    unwovenPlan.stages[wovenOrdinal - 1].instructions.replace(` ${wovenSentence}`, "");
  assert.throws(() => validateStagePlan(rehash70(unwovenPlan)), /does not carry its ledger sentence/);
  const restated = structuredClone(plan);
  restated.stages[7].instructions += ` ${wovenSentence}`;
  assert.throws(() => validateStagePlan(rehash70(restated)), /appears 2 times/);
  const leakedToken = structuredClone(plan);
  leakedToken.stages[7].instructions += ` ${plan.ledger.table[0].value}`;
  assert.throws(() => validateStagePlan(rehash70(leakedToken)), /appears outside its own sentences/);
  // The run-visible plan keeps the geometry and loses every value and the seed
  // that would regenerate them.
  const visiblePlan = stagePlanForRun(plan);
  const visibleLedgerText = JSON.stringify(visiblePlan.ledger);
  assert(!visibleLedgerText.includes(plan.ledger.contentSeed),
    "the run-visible plan carries the seed that regenerates every value");
  for (const token of ledgerTokensOf(plan.ledger)) {
    assert(!visibleLedgerText.includes(token), "the run-visible plan carries a ledger value");
  }
  assert.deepEqual(visiblePlan.ledger.joins.map((join) => ({ id: join.id, taskStage: join.taskStage })),
    plan.ledger.joins.map((join) => ({ id: join.id, taskStage: join.taskStage })),
  "the run-visible plan keeps the task geometry the extension gates on");
  // The stager's collision scan sees ledger tokens exactly as it sees code words.
  assert.deepEqual(plantedWordCollisions(
    `int x; /* ${fullTokens[0]} */ cw-aaaaaa`, [fullTokens[0], "cw-bbbbbb"]), [fullTokens[0]]);
  assert.deepEqual(plantedWordCollisions("clean text", fullTokens), []);
  // Run-config laws: an arm config carries the schedule or refuses, a
  // closed-book config carrying one refuses as a no-referent key.
  assert.throws(() => validateExperimentRunConfig(
    (({ ledgerTasks: _tasks, ...rest }) => rest)(runConfig)),
  /must carry the plan's ledger task schedule/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, ledgerTasks: [] }),
    /must carry the plan's ledger task schedule/);
  assert.throws(() => validateExperimentRunConfig({
    ...runConfig, ledgerTasks: [{ id: "lt-01", stage: 99 }],
  }), /must carry the plan's ledger task schedule/);
  assert.throws(() => validateExperimentRunConfig((({ guidance: _g, ...rest }) => rest)({
    ...runConfig, sessionType: EXPERIMENT_CLOSED_BOOK_LABEL, arm: EXPERIMENT_CLOSED_BOOK_LABEL,
  })), /arm-condition keys with no referent/);
  // The endpoint, driven end to end through the real extension and the real IPC
  // dance: an unassigned id gets one answer whether future or fictional, the
  // gate refuses the next stage with the exact repair and the key unconsumed,
  // the echo restates the record verbatim, a duplicate names the standing
  // record, and the artifacts carry the record and the refusal with no latch.
  const jitiPath70 = join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs");
  assert(existsSync(jitiPath70), "could not resolve package-local jiti to drive the extension");
  const typeboxPath70 = join(PI_INSTALL_ROOT, "node_modules", "typebox", "build", "index.mjs");
  assert(existsSync(typeboxPath70), `the pi install does not carry typebox at ${typeboxPath70}`);
  const { createJiti: createJiti70 } = await import(pathToFileURL(jitiPath70));
  const { createPiContextExperimentExtension } = await createJiti70(import.meta.url, {
    alias: { typebox: typeboxPath70 },
  }).import(join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"));
  const runDir = mkdtempSync(join(tmpdir(), "pi-fold-ledger-gate-"));
  mkdirSync(join(runDir, "ipc", "requests"), { recursive: true });
  mkdirSync(join(runDir, "ipc", "responses"), { recursive: true });
  const keyOne = "1".repeat(64);
  const keyTwo = "2".repeat(64);
  const tools = new Map();
  const mockPi = {
    on() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    registerCommand() {},
    sendMessage() {},
    async appendEntry() {},
  };
  createPiContextExperimentExtension({
    version: EXPERIMENT_PROTOCOL_VERSION,
    runId: "ledger-gate",
    runDir,
    campaignId: "gate-70",
    arm: "native",
    mode: "smoke",
    firstChallenge: keyOne,
    stageCount: EXPERIMENT_MODE_PLANS.smoke.stageCount,
    watchdogMs: 10_000,
    ledgerTasks: [{ id: "lt-01", stage: 1 }],
  }).factory(mockPi);
  const stageTool = tools.get(EXPERIMENT_TOOL_NAME);
  const ledgerTool = tools.get(EXPERIMENT_LEDGER_TOOL_NAME);
  assert(stageTool && ledgerTool, "both workload tools must register on every arm");
  const earlyRecord = await ledgerTool.execute("t-early", { id: "lt-01", value: "lv-aaaaaa" });
  assert(earlyRecord.isError &&
    /No ledger task with id lt-01 has been assigned/.test(earlyRecord.content[0].text));
  const fictionalRecord = await ledgerTool.execute("t-fictional", { id: "lt-99", value: "x" });
  assert(fictionalRecord.isError);
  assert.equal(earlyRecord.content[0].text.replace("lt-01", "lt-99"),
    fictionalRecord.content[0].text,
    "one refusal for future and fictional ids, so a guess can never confirm a task exists");
  const serveStage = async (stage, key, nextKey, toolCallId) => {
    const requestPath = join(runDir, "ipc", "requests", `stage-${String(stage).padStart(2, "0")}.json`);
    const responsePath = join(runDir, "ipc", "responses", `stage-${String(stage).padStart(2, "0")}.json`);
    const pending = stageTool.execute(toolCallId, { key });
    const deadline = Date.now() + 5_000;
    while (!existsSync(requestPath)) {
      assert(Date.now() < deadline, `the stage tool never wrote its stage ${stage} request`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    const content = `stage ${stage} content`;
    const responseBase = {
      version: 1,
      runId: "ledger-gate",
      stage,
      challengeSha256: request.challengeSha256,
      requestSha256: request.requestSha256,
      content,
      contentSha256: sha256Text(content),
      payloadSha256: "0".repeat(64),
      nextChallenge: nextKey,
      nextChallengeSha256: sha256Text(nextKey),
      releasedWallMs: Date.now(),
      releasedMonotonicMs: 1,
    };
    const responseSha256 = sha256Json(responseBase);
    writeJsonPublished(responsePath,
      { ...responseBase, paceRecordSha256: "0".repeat(64), responseSha256 });
    return pending;
  };
  const stageOne = await serveStage(1, keyOne, keyTwo, "t-stage-1");
  assert(!stageOne.isError, "stage 1 has no assigned tasks and must deliver");
  const gatedFetch = await stageTool.execute("t-stage-2-gated", { key: keyTwo });
  assert(gatedFetch.isError &&
    /ledger task\(s\) lt-01/.test(gatedFetch.content[0].text) &&
    gatedFetch.content[0].text.includes(EXPERIMENT_LEDGER_TOOL_NAME) &&
    /call again with the same key/.test(gatedFetch.content[0].text),
  "the gate names the owed task, the tool and the repair");
  const recorded = await ledgerTool.execute("t-record", { id: "lt-01", value: "lv-123456" });
  assert(!recorded.isError);
  assert.equal(recorded.content[0].text, "Recorded ledger task lt-01: lv-123456",
    "the echo restates the record verbatim");
  const duplicate = await ledgerTool.execute("t-duplicate", { id: "lt-01", value: "lv-999999" });
  assert(duplicate.isError && /already recorded as lv-123456/.test(duplicate.content[0].text),
    "a second record is refused naming the standing one");
  const stageTwo = await serveStage(2, keyTwo, "3".repeat(64), "t-stage-2");
  assert(!stageTwo.isError, "the gate must release on the SAME key once the record exists");
  const gateEvents = readFileSync(join(runDir, "worker-events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const recordEvent = gateEvents.find((event) => event.kind === "ledger-record");
  assert(recordEvent && recordEvent.details.id === "lt-01" &&
    recordEvent.details.value === "lv-123456" && recordEvent.details.afterStage === 1,
  "the record lands in the hash-chained event ledger with its value");
  const refusalEvent = gateEvents.find((event) => event.kind === "ledger-gate-refusal");
  assert(refusalEvent && refusalEvent.details.owed.includes("lt-01") &&
    refusalEvent.details.stage === 2, "the refusal lands as its own event");
  assert(!existsSync(join(runDir, "failure-latch.jsonl")) ||
    readFileSync(join(runDir, "failure-latch.jsonl"), "utf8").trim() === "",
  "a correctable refusal latches nothing");
  rmSync(runDir, { recursive: true, force: true });
  // The frozen-seed law at the stager, and the supervisor forwarding ids and
  // stages only: expected values never reach the run config.
  const staging70 = readFileSync(join(PROJECT, "scripts", "stage_pi_context_experiment.mjs"), "utf8");
  assert(staging70.includes('"hidden-mass-seeds.json"'),
    "the stager must read the frozen seed file");
  assert(!staging70.includes("--content-seed"),
    "the content seed is frozen in the file, never a flag");
  assert(staging70.includes("ledgerSentencesForStage(ledger, ordinal)"),
    "the stager must weave through the shared helper the validator re-derives");
  const supervisor70 = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment.mjs"), "utf8");
  assert(supervisor70.includes(
    "ledgerTasks: plan.ledger.joins.map((join) => ({ id: join.id, stage: join.taskStage }))"),
  "the supervisor must forward the task schedule as ids and stages only");
  checks.theSeededLedgerWeavesThreeChannelsAndGatesProgressionOnRecords = true;
}

// ---------------------------------------------------------------------------
// GATE 71 - the withheld end block: one asking surface built at run time from
// (plan.ledger, querySeed), byte-identical across arms, absent from every
// pre-phase surface, and graded three ways.
//
// Task #79 build 3 of 3. The querySeed is frozen beside the contentSeed and
// governs ORDER only: every ledger fact is asked, ids are assigned after the
// shuffle so position reveals nothing, and the checksum question is ONE wording
// for corrected and uncorrected subjects alike (a question that acknowledged a
// correction only where one existed would announce the trap in the asking).
// Grading splits record correctness (fixed at record time, the ledger tool's
// event against the plan), recall fidelity against the agent's OWN record
// (faithfully restating your own error is unfakeable event recall; restating
// the truth instead is re-derivation evidence), and what the answers cost in
// recovery, with the reconstruction table graded row-exact and the
// withdrawn-value trap cell stated beside the verdict.
// ---------------------------------------------------------------------------
{
  const gateLedger = buildLedger({ mode: "full", contentSeed: "feedfacefeedface" });
  const gateSeed = "abcdef0123456789";
  // Purity: same inputs, byte-identical prompt; a different seed reorders the
  // SAME question set, because order is the only thing the seed may choose.
  const questions = endBlockQuestions(gateLedger, gateSeed);
  assert.equal(endBlockPrompt(gateLedger, gateSeed), endBlockPrompt(gateLedger, gateSeed),
    "same ledger and seed must produce byte-identical prompts");
  const reordered = endBlockQuestions(gateLedger, "1111111111111111");
  assert.deepEqual([...questions.map((item) => item.question)].sort(),
    [...reordered.map((item) => item.question)].sort(),
    "the seed governs order, never selection: every ledger fact is always asked");
  assert.notEqual(JSON.stringify(questions.map((item) => item.question)),
    JSON.stringify(reordered.map((item) => item.question)),
    "a different seed shuffles the order");
  assert.equal(questions.filter((item) => item.kind === "checksum").length,
    gateLedger.singles.length + gateLedger.corrections.length);
  assert.equal(questions.filter((item) => item.kind === "join").length, gateLedger.joins.length);
  assert.equal(questions.at(-1).id, "end-table");
  assert.deepEqual(questions.slice(0, -1).map((item) => item.id),
    questions.slice(0, -1).map((_, index) => `end-${String(index + 1).padStart(2, "0")}`),
    "ids are positional after the shuffle, so an id reveals nothing about channel");
  // One-wording law: corrected and uncorrected checksum questions differ only
  // in their subject token.
  const correctedQuestion = questions.find((item) =>
    item.kind === "checksum" && item.withdrawnAnswer !== null);
  const uncorrectedQuestion = questions.find((item) =>
    item.kind === "checksum" && item.withdrawnAnswer === null);
  assert.equal(correctedQuestion.question.replaceAll(correctedQuestion.subject, "X"),
    uncorrectedQuestion.question.replaceAll(uncorrectedQuestion.subject, "X"),
    "one wording for trapped and untrapped subjects, or the asking measures the announcement");
  // No test premise, and the questions exist in NO pre-phase surface: they are
  // built at run time and the plan never carries them.
  assert.deepEqual(testAwarenessLeaks(endBlockPrompt(gateLedger, gateSeed)), []);
  for (const item of endBlockQuestions(plan.ledger, gateSeed)) {
    for (const stage of plan.stages) {
      assert(!stage.instructions.includes(item.question),
        `stage ${stage.ordinal} carries an end-block question before the end`);
    }
  }
  // Grading cells, driven end to end through the transcript parser. The four
  // joins cover the whole split: faithful-to-a-wrong-record (the unfakeable
  // recall cell), truth-instead-of-record (re-derivation), no record at all,
  // and faithful-to-a-right-record. Checksums cover the trap cell, a clean
  // match, case normalization, and unanswered. The table mixes bare and padded
  // row numbers, one wrong row and one missing row.
  const byKind = (kind) => questions.filter((item) => item.kind === kind);
  const joinItems = byKind("join");
  const joinTruth = (item) => gateLedger.joins.find((join) => join.id === item.taskId);
  const checksumItems = byKind("checksum");
  const trapItem = checksumItems.find((item) => item.withdrawnAnswer !== null);
  const cleanCorrectedItem = checksumItems.find((item) =>
    item.withdrawnAnswer !== null && item !== trapItem);
  const plainItems = checksumItems.filter((item) => item.withdrawnAnswer === null);
  const answerLines = [
    `${trapItem.id}: ${trapItem.withdrawnAnswer}`,
    `${cleanCorrectedItem.id}: ${cleanCorrectedItem.expectedAnswer}`,
    `${plainItems[0].id}: ${plainItems[0].expectedAnswer.toUpperCase()}`,
    // plainItems[1] deliberately unanswered.
    `${joinItems[0].id}: lv-wrong1`,
    `${joinItems[1].id}: ${joinTruth(joinItems[1]).expectedAnswer}`,
    `${joinItems[2].id}: lv-orphan`,
    `${joinItems[3].id}: ${joinTruth(joinItems[3]).expectedAnswer}`,
    "end-table: reconstructed below.",
    ...gateLedger.table
      .filter((entry) => entry.row !== 6)
      .map((entry) => entry.row === 5
        ? `row ${String(entry.row).padStart(2, "0")}: lv-000bad`
        : entry.row === 3
          ? `row ${entry.row}: ${entry.value}`
          : `row ${String(entry.row).padStart(2, "0")}: ${entry.value}`),
  ].join("\n");
  const gateEntries = [
    { type: "message", message: { role: "user", content: endBlockPrompt(gateLedger, gateSeed) } },
    { type: "message", message: { role: "toolResult", toolName: "read", content: [] } },
    { type: "message", message: { role: "toolResult", toolName: EXPERIMENT_LEDGER_TOOL_NAME, content: [] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: answerLines }] } },
  ];
  const gateEvents = [
    { kind: "ledger-record", details: { id: joinItems[0].taskId, value: "lv-wrong1" } },
    { kind: "ledger-record", details: { id: joinItems[1].taskId, value: "lv-wrong2" } },
    // joinItems[2] has NO record event.
    { kind: "ledger-record", details: { id: joinItems[3].taskId, value: joinTruth(joinItems[3]).expectedAnswer } },
  ];
  const verdicts = endBlockVerdicts({
    entries: gateEntries, ledger: gateLedger, querySeed: gateSeed, events: gateEvents,
  });
  assert.equal(verdicts.delivered, true);
  const rowOf = (id) => verdicts.rows.find((row) => row.id === id);
  assert.deepEqual([rowOf(trapItem.id).verdict, rowOf(trapItem.id).withdrawnMatch],
    ["mismatch", true],
    "the withdrawn value is the trap cell, stated beside the verdict rather than inside it");
  assert.deepEqual([rowOf(cleanCorrectedItem.id).verdict, rowOf(cleanCorrectedItem.id).withdrawnMatch],
    ["match", false]);
  assert.equal(rowOf(plainItems[0].id).verdict, "match",
    "value comparison is normalized: an uppercased token still matches");
  assert.equal(rowOf(plainItems[1].id).verdict, "unanswered");
  const faithfulWrong = rowOf(joinItems[0].id);
  assert.deepEqual([faithfulWrong.recordCorrect, faithfulWrong.recallOfRecord, faithfulWrong.truthMatch],
    [false, true, false],
    "faithful recall of a wrong record is the unfakeable event-recall cell");
  const rederived = rowOf(joinItems[1].id);
  assert.deepEqual([rederived.recordCorrect, rederived.recallOfRecord, rederived.truthMatch],
    [false, false, true],
    "the truth instead of the record is re-derivation, never recall");
  const orphan = rowOf(joinItems[2].id);
  assert.deepEqual([orphan.recordedValue, orphan.recordCorrect, orphan.recallOfRecord],
    [null, null, null], "a missing record grades as null, never as a silent false");
  const faithfulRight = rowOf(joinItems[3].id);
  assert.deepEqual([faithfulRight.recordCorrect, faithfulRight.recallOfRecord, faithfulRight.truthMatch],
    [true, true, true]);
  const table = rowOf("end-table");
  assert.deepEqual([table.rowsTotal, table.rowsAnswered, table.rowsCorrect], [16, 15, 14],
    "row-exact: a bare row number parses, a padded one parses, a wrong value and a missing row each cost one");
  assert.deepEqual(table.rows.filter((row) => !row.match).map((row) => row.row), [5, 6]);
  // The recovery window counts the read and never the ledger tool: recording is
  // workload traffic, not recovery.
  assert.deepEqual([verdicts.recovery.fileReads, verdicts.recovery.contextToolCalls,
    verdicts.recovery.recoveryCalls], [1, 0, 1]);
  // A session that never carries the prompt reads as not delivered, loudly,
  // rather than being fuzzily matched.
  const undelivered = endBlockVerdicts({
    entries: [], ledger: gateLedger, querySeed: gateSeed, events: [],
  });
  assert.equal(undelivered.delivered, false);
  assert.equal(undelivered.recovery, null);
  // The wiring pins: the worker asks only after the whole workload delivered
  // cleanly and pins the exact bytes in its manifest; the adjudicator recomputes
  // the pin and grades through the shared lens; the supervisor reads the frozen
  // querySeed from the sealed seeds file.
  assert(worker.includes("endBlockPrompt(plan.ledger, config.querySeed)"),
    "the worker must build the end block from the plan's ledger and the frozen seed");
  assert(worker.includes("endBlockSha256: sha256Text(endBlockPrompt(plan.ledger, config.querySeed))"),
    "the worker manifest must pin the end block's exact bytes");
  assert(/stagesDelivered\(\) === plan\.stageCount &&\n\s*modelEndedItsTurn\(terminalState\)\) \{\n\s*await session\.prompt\(endBlockPrompt/.test(worker),
    "the end block is asked only after the whole workload was delivered cleanly");
  assert(adjudicator.includes(
    "manifest.endBlockSha256 === sha256Text(endBlockPrompt(plan.ledger, config.querySeed))"),
  "the adjudicator must recompute the end-block pin rather than trust it");
  assert(adjudicator.includes("endBlockVerdicts({"),
    "the adjudicator must grade the end block through the shared lens");
  assert(adjudicator.includes("userMessages === 1 + recordedResumes + endBlockDelivered"),
    "the one-user-message contract must count the identified end block, and only it");
  const supervisor71 = source("scripts/run_pi_context_experiment.mjs");
  assert(supervisor71.includes('"hidden-mass-seeds.json"') &&
    supervisor71.includes("querySeed: hiddenMassSeeds.querySeed"),
  "the supervisor must read the frozen query seed from the sealed seeds file");
  checks.theWithheldEndBlockAsksEverythingAndGradesThreeWays = true;
}

// GATE 72 - a resume that buys no progress fails the run by name, before the bill does.
//
// Gate 56 built the nudge and named the watchdog its only cadence bound; nothing bounded
// how many nudges a run could spend at one stage. sol-20260815-hidden native rep 1 is the
// proof: Pi's compaction summarized away stage 39's NEXT_KEY, the model correctly reported
// the key unrecoverable on every pass, and the worker re-prompted the same dead question
// every nine seconds for 4.3 hours, 1,761 provider responses and $127.68 for zero stages,
// until an outside SIGTERM ended it. The pifold arm recovered from the same loss class at
// stage 57 of an earlier rep in ONE resume (peeked the fold, finished), so the bound is
// three whole turns at one undelivered stage: generous against every observed recovery,
// and three nudges' spend against a dead run instead of a wall clock's.
//
// Delivery is the only progress signal that cannot be faked, so the streak is defined on
// stagesDelivered() alone and is reason-blind: a fence-compaction resume that lands
// nothing three turns running is the same dead run. The latch entry is written BEFORE the
// throw so the cause survives even a report that never lands (gate 55's lesson), and the
// thrown error carries the same name so the worker report and gate 53's reader agree.
// ---------------------------------------------------------------------------
{
  const worker = readFileSync(join(PROJECT, "scripts", "run_pi_context_experiment_worker.mjs"), "utf8");

  // The streak function, driven as a function per gate 56's pattern.
  const streakSource = worker.slice(
    worker.indexOf("const RESUME_TURNS_PER_STAGE"),
    worker.indexOf("\n\n// A KILLED WORKER STILL WRITES ITS REPORT."),
  );
  assert(streakSource.length > 0, "the resume progress bound was not found where it is pinned");
  const { limit, streak } = new Function(
    `${streakSource}; return { limit: RESUME_TURNS_PER_STAGE, streak: resumesWithoutProgress };`)();
  assert.equal(limit, 3, "the bound is not the three turns the defect record fixed it at");
  const nudge = (afterStage) => ({ afterStage });
  assert.equal(streak([], 39), 0, "an empty nudge history claims a streak");
  assert.equal(streak([nudge(12), nudge(12), nudge(12)], 12), 3,
    "three same-stage nudges do not count as three");
  // Progress resets the streak: nudges spent at EARLIER stages never count against the
  // stage now owed, however many there were.
  assert.equal(streak([nudge(12), nudge(12), nudge(12), nudge(13)], 13), 1,
    "a delivery does not reset the streak, so an honest recovery inherits a dead run's debt");
  assert.equal(streak([nudge(12), nudge(12), nudge(12)], 13), 0,
    "nudges at an earlier stage count against the stage now owed");
  assert.equal(streak([nudge(12), nudge(13), nudge(13)], 13), 2,
    "the streak is not the trailing run of same-stage nudges");

  // The wiring: the bound is checked inside the resume loop, before the nudge is recorded
  // and before the prompt is sent, and the refusal both latches and throws the same name.
  const loopStart = worker.indexOf("while (!closedBook && !deadlineFired && stagesDelivered() < plan.stageCount");
  const boundCheck = worker.indexOf("resumesWithoutProgress(stageNudges, delivered) >= RESUME_TURNS_PER_STAGE");
  const latchWrite = worker.indexOf('phase: "worker-resume-bound"');
  const boundThrow = worker.indexOf("throw new Error(detail)");
  const nudgePush = worker.indexOf("stageNudges.push(");
  const resumeSend = worker.indexOf("await session.prompt(resumePrompt(");
  assert(loopStart >= 0 && boundCheck > loopStart && boundCheck < nudgePush && nudgePush < resumeSend,
    "the bound does not run inside the resume loop before the nudge and the prompt");
  assert(latchWrite > boundCheck && boundThrow > latchWrite && boundThrow < nudgePush,
    "the refusal does not latch before it throws, inside the guarded branch");
  assert(/resume-loop-without-progress: stage \$\{delivered \+ 1\} of/.test(worker),
    "the failure does not name itself and the stage it is owed");

  checks.aResumeThatBuysNoProgressFailsByName = true;
}

assert.deepEqual([...EXPERIMENT_GUIDANCE_PROFILES], ["pressure", "curation", "minimal"]);
assert.deepEqual([...EXPERIMENT_MODES], ["smoke", "full"]);
assert(plan, "stage plan fixture did not survive gate 4");

const report = {
  ok: true,
  acceptance: false,
  version: EXPERIMENT_PROTOCOL_VERSION,
  arms: [...EXPERIMENT_ARMS],
  modes: Object.fromEntries(EXPERIMENT_MODES.map((mode) => [mode, EXPERIMENT_MODE_PLANS[mode]])),
  defaultRepo: EXPERIMENT_DEFAULT_REPO,
  checks,
};
assert(Object.values(checks).every((value) => value === true), "a gate did not report");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`PASS pi-context-experiment verification: ${Object.keys(checks).length} gates\n`);
