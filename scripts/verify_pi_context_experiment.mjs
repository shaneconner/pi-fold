#!/usr/bin/env node

// Offline verification of the fold-vs-compaction harness contract. No provider calls, no
// live runs: this is the gate that must pass before the coordinator spends wall-clock on a
// smoke, and again before the full campaign. Soak-verifier style: every gate proves a
// specific failure is REJECTED, not merely that the happy path returns.
//
//   node scripts/verify_pi_context_experiment.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPERIMENT_ARMS,
  EXPERIMENT_BRIEF_GENERATOR,
  EXPERIMENT_DEFAULT_GUIDED_CURATION,
  EXPERIMENT_PROVIDER_INPUT_BUDGETS,
  EXPERIMENT_TRANSPORT,
  EXPERIMENT_TRANSPORTS,
  EXPERIMENT_DEFAULT_REPO,
  EXPERIMENT_FOLD_SCHEDULING,
  EXPERIMENT_GUIDANCE_PROFILES,
  EXPERIMENT_MODES,
  EXPERIMENT_MODE_PLANS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_REPOS,
  EXPERIMENT_SCHEDULING_SOURCE,
  MUTATION_ABSOLUTE_TOLERANCE_TOKENS,
  TOKEN_ESTIMATOR_ID,
  CODE_WORD_PATTERN,
  CONTEXT_EVENT_SUFFIX,
  CONVERSATION_PROBE_KINDS,
  FOLD_RECORD_SUFFIX,
  REPO_PROBE_KINDS,
  armRuntimeConfiguration,
  assertBlindPacket,
  buildConversationProbes,
  buildProbes,
  codeWordSentence,
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
  probeProvenance,
  quotedIncludeSpecs,
  traceStepTranscripts,
  traceStepVerdicts,
  visibleStage,
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_SESSION_TYPES,
  closedBookPrompt,
  closedBookQuestions,
  closedBookSystemPrompt,
  closedBookTranscript,
} from "./lib/pi_context_experiment.mjs";
import {
  PI_INSTALL_ROOT,
  directoryTreeSha256,
  sha256Json,
  sha256Text,
  verifySourceHashes,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relative) => readFileSync(join(PROJECT, relative), "utf8");
const checks = {};

// ---------------------------------------------------------------------------
// GATE 1 - arm contract
// ---------------------------------------------------------------------------
assert.deepEqual([...EXPERIMENT_ARMS], ["pifold", "native", "unmanaged"]);
// The pifold arm runs compaction ON: the runtime's overflow recovery lane arms off
// `session_before_compact`, so an arm with compaction off would be measuring a deployment
// nobody is asked to run.
assert.deepEqual(armRuntimeConfiguration("pifold"),
  { activeContextEnabled: true, nativeCompactionEnabled: true, toleratesOverflow: false });
assert.deepEqual(armRuntimeConfiguration("native"),
  { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false });
assert.deepEqual(armRuntimeConfiguration("unmanaged"),
  { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: true });
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
  const stageOf = (ordinal, kind, files, stageProbes, deliverable, chainStep = null) => {
    const codeWord = kind === "probe" ? null : fixtureWord(ordinal);
    // Weave order mirrors the stager: base, then the audit step, code word LAST.
    let instructions = `stage ${ordinal} instructions`;
    if (chainStep !== null) instructions = `${instructions} ${auditStepSentence(chainStep)}`;
    if (codeWord !== null) instructions = `${instructions} ${codeWordSentence(ordinal, codeWord)}`;
    const stage = {
      ordinal,
      kind,
      instructions,
      codeWord,
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
// The registration is the arm, and a brief generator is part of it: the package writes
// fold briefs with a model and keeps the deterministic brief as the failure fallback, so
// an arm registered without a generator measures the fallback and calls it the mechanism.
assert(extension.includes("createSummarizeContextSpan(config.briefGenerator, loadHostModule)") &&
  extension.includes("{ summarizeContextSpan }"),
"the extension must build the run's brief generator from the config descriptor and register it");
assert(!extension.includes("no summarizer is configured"),
  "the extension still says it wires no summarizer");
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
assert(worker.includes("compaction: { enabled: armRuntime.nativeCompactionEnabled") &&
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
  // shape the runtime now takes. The two entries differ because they are two separate
  // deployment facts: rep 2 of luna-20260810 proved luna's wire refuses below 383,616
  // (largest served 361,882, refused at approximately 377,800), so luna pins the
  // corrected 343,616 while sol keeps the 383,616 its own sealed lane measured against
  // without ever recording a refusal.
  assert.equal(EXPERIMENT_PROVIDER_INPUT_BUDGETS["openai-codex/gpt-5.6-luna"], 343_616);
  assert.equal(EXPERIMENT_PROVIDER_INPUT_BUDGETS["openai-codex/gpt-5.6-sol"], 383_616);
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
  assert(staging.includes("collectCheckoutDefinitions(checkoutDir, codeWords)") &&
    staging.includes("uniqueIdentifierIndex(checkoutDefinitions.entries)") &&
    staging.includes("checkoutPaths: checkoutDefinitions.paths"),
  "symbol uniqueness, code-word collisions, and include resolution must be judged " +
  "over the whole checkout");
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

  const closedRunConfig = (({ guidance: _g, ...rest }) => rest)({
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
      max_attempts: 2, tokens_before: 40_000, tokens_after: 40_000, budget_tokens: 50_400,
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
      max_attempts: 2, tokens_before: 52_000, tokens_after: 52_000, budget_tokens: 50_400,
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
      max_attempts: 2, tokens_before: 51_000, tokens_after: 40_000, budget_tokens: 50_400,
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
  // A cheap model at medium effort: the brief is a bounded summary of a bounded span, and
  // the arm's own frontier model is the thing under measurement, not the summarizing.
  assert.deepEqual({ ...EXPERIMENT_BRIEF_GENERATOR },
    { provider: "openai-codex", model: "gpt-5.6-luna", effort: "medium" });

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

  assert(supervisor.includes("briefGenerator: EXPERIMENT_BRIEF_GENERATOR") &&
    supervisor.includes("armRuntimeConfiguration(arm).activeContextEnabled"),
  "the supervisor must pin the campaign's brief generator onto the arm that folds");
  assert(worker.includes("{ briefGenerator: config.briefGenerator }"),
    "the worker must seal the run's brief generator into the manifest");
  assert(extension.includes("{ summarizeContextSpan }"),
    "the extension must pass the generator into the active-context registration");
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
  const { join: preLaneJoin, ...preLaneKinds } = preLane;
  assert.deepEqual(preLaneKinds, creationTimeCount(preLaneRun));
  assert.deepEqual(preLaneKinds, { model: 0, deterministic: 2 });
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

  const { experimentSummarizeContextSpan } = await jiti.import(
    join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"));
  assert.equal(experimentSummarizeContextSpan({ arm: "pifold" }), undefined,
    "a run config with no descriptor must register no generator and fall back deterministically");
  // Driven against a FAKE host module: verification resolves no model and calls no
  // provider. What is under test is that the harness reaches the PACKAGE's builder, so the
  // arm briefs the way a consumer's deployment briefs.
  const briefModel = { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true };
  const prompts = [];
  const generate = experimentSummarizeContextSpan(
    { arm: "pifold", briefGenerator: EXPERIMENT_BRIEF_GENERATOR },
    async () => ({
      ModelRuntime: {
        async create() {
          return {
            getModel(provider, model) {
              return provider === briefModel.provider && model === briefModel.id ? briefModel : undefined;
            },
            async completeSimple(_model, completion) {
              prompts.push(completion.messages[0].content);
              return { content: [{ type: "text", text: "Stage 12 released the nonce." }] };
            },
          };
        },
      },
    }),
  );
  assert.equal(typeof generate, "function");
  assert.deepEqual(await generate({
    sourceText: "STAGE BODY: the stage tool returned NEXT_KEY and four files.",
    beforeText: "[]",
    afterText: "[]",
    maxBriefChars: 1_200,
    signal: new AbortController().signal,
  }, {}), {
    brief: "Stage 12 released the nonce.",
    provider: briefModel.provider,
    model: briefModel.id,
    effort: EXPERIMENT_BRIEF_GENERATOR.effort,
    toolCalls: 0,
  });
  assert(prompts.length === 1 && prompts[0].includes("SPAN TO BRIEF:") &&
    prompts[0].includes("expanding or peeking this fold later"),
  "the arm must brief through the package's own request contract, not a harness copy");
  checks.briefGeneratorThreadedFromCampaignPinToRegistration = true;
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
