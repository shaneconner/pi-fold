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
  EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS,
  EXPERIMENT_DEFAULT_FOLD_SCHEDULING,
  EXPERIMENT_DEFAULT_GUIDED_CURATION,
  EXPERIMENT_PROVIDER_TOTAL_WINDOWS,
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
  CONVERSATION_PROBE_KINDS,
  REPO_PROBE_KINDS,
  armRuntimeConfiguration,
  assertBlindPacket,
  buildConversationProbes,
  buildProbes,
  codeWordSentence,
  computeRereadTax,
  contextEventMetrics,
  corpusManifestSha256,
  deliverableTranscripts,
  estimateTokens,
  extractDefinitions,
  fileFacts,
  isWindowOverflow,
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
} from "./lib/pi_context_experiment.mjs";
import { directoryTreeSha256, sha256Text, verifySourceHashes } from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const source = (relative) => readFileSync(join(PROJECT, relative), "utf8");
const checks = {};

// ---------------------------------------------------------------------------
// GATE 1 - arm contract
// ---------------------------------------------------------------------------
assert.deepEqual([...EXPERIMENT_ARMS], ["pifold", "native", "unmanaged"]);
assert.deepEqual(armRuntimeConfiguration("pifold"),
  { activeContextEnabled: true, nativeCompactionEnabled: false, toleratesOverflow: false });
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
    nativeCompactionEnabled: false,
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
  ...manifest, runtime: { ...manifest.runtime, nativeCompactionEnabled: true },
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
// The guidance profile is RETIRED. It shaped the milestone and live-advisory copy, and
// both carriers are deleted, so a run that recorded a profile would be attesting to a
// condition that changed nothing. The key stays readable for reps 15-21; no producer
// may emit it, and the runtime no longer accepts it.
for (const [name, text] of [["extension", extension], ["worker", worker], ["supervisor", supervisor]]) {
  assert(!/guidance: config\.guidance|--guidance/.test(text),
    `${name} still carries the retired guidance profile condition`);
}
assert(extension.includes('pi.on("session_before_compact"') &&
  extension.includes("openStopTheWorld(\"native-compaction\"") &&
  extension.includes("if (config.arm !== \"native\")"),
"native compaction must be recorded as an event and only latched when the arm forbids it");
assert(extension.includes("appendToolResult({") && extension.includes("toolResultContentSha256(content)"),
  "every tool result must be hashed into the reread-tax ledger");
assert(worker.includes("compaction: { enabled: armRuntime.nativeCompactionEnabled") &&
  worker.includes("thinkingLevel: config.model.effort") &&
  worker.includes("validateExperimentManifest({"),
"the worker must drive compaction from the arm, pin effort, and emit a validated manifest");
assert(worker.includes("checkoutSha256 === config.targetTreeSha256"),
  "the worker must pin its checkout against the staged corpus");
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
// GATE 17 - fold scheduling is threaded from the launcher to the registration
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...EXPERIMENT_FOLD_SCHEDULING], ["immediate", "epoch"]);
  assert.equal(EXPERIMENT_DEFAULT_FOLD_SCHEDULING, "immediate");
  assert.equal(EXPERIMENT_SCHEDULING_SOURCE, "extensions/lib/scheduling.ts");
  // Runs sealed before the dial existed carry no key and still adjudicate.
  validateExperimentRunConfig(runConfig);
  validateExperimentRunConfig({ ...runConfig, foldScheduling: "epoch" });
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldScheduling: "eventual" }),
    /fold scheduling is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldSchedule: "epoch" }),
    /run config shape/);
  validateExperimentManifest(manifest);
  validateExperimentManifest({ ...manifest, foldScheduling: "epoch" });
  assert.throws(() => validateExperimentManifest({ ...manifest, foldScheduling: "eventual" }),
    /fold scheduling is not a shipped package option/);
  assert.throws(() => validateExperimentManifest({ ...manifest, foldSchedule: "epoch" }),
    /manifest shape/);
  assert(supervisor.includes('argumentValue("--fold-scheduling"') &&
    supervisor.includes("EXPERIMENT_FOLD_SCHEDULING.includes(foldScheduling)") &&
    supervisor.includes("experimentSourceHashes(foldScheduling)") &&
    supervisor.includes("schedulingPresent || foldScheduling !== \"epoch\"") &&
    supervisor.includes("runtimePaths.includes(EXPERIMENT_SCHEDULING_SOURCE) === schedulingPresent") &&
    supervisor.includes("foldScheduling,"),
  "the supervisor must accept --fold-scheduling, pin the whole runtime source tree, require the scheduler for epoch, and record it in the run config");
  assert(worker.includes("foldScheduling: config.foldScheduling ?? EXPERIMENT_DEFAULT_FOLD_SCHEDULING"),
    "the worker must record the run's fold scheduling in the sealed manifest");
  assert(extension.includes("foldScheduling: config.foldScheduling ?? EXPERIMENT_DEFAULT_FOLD_SCHEDULING"),
    "the extension must pass fold scheduling into the active-context registration");
  assert(launcher.includes("--fold-scheduling") &&
    launcher.includes('case "$FOLD_SCHEDULING" in immediate|epoch)'),
  "the shell launcher must accept and validate --fold-scheduling");
  checks.foldSchedulingThreadedFromLauncherToRegistration = true;
}

// ---------------------------------------------------------------------------
// GATE 21 - the peek-fold condition is threaded from the launcher to the registration
// ---------------------------------------------------------------------------
{
  assert.equal(EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS, false);
  // Runs sealed before the dial existed carry no key and still adjudicate.
  validateExperimentRunConfig(runConfig);
  validateExperimentRunConfig({ ...runConfig, foldPeekResults: true });
  validateExperimentRunConfig({ ...runConfig, foldPeekResults: false });
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldPeekResults: "true" }),
    /peek-fold condition is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, foldPeek: true }),
    /run config shape/);
  validateExperimentManifest({ ...manifest, foldPeekResults: true });
  assert.throws(() => validateExperimentManifest({ ...manifest, foldPeekResults: "true" }),
    /peek-fold condition is not a boolean/);
  assert.throws(() => validateExperimentManifest({ ...manifest, foldPeek: true }),
    /manifest shape/);
  assert(supervisor.includes('argumentValue("--fold-peek-results"') &&
    supervisor.includes('["true", "false"].includes(foldPeekResultsArgument)') &&
    supervisor.includes("foldPeekResults,"),
  "the supervisor must accept --fold-peek-results and record it in the run config");
  assert(worker.includes("foldPeekResults: config.foldPeekResults ?? EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS"),
    "the worker must record the run's peek-fold condition in the sealed manifest");
  assert(extension.includes("foldPeekResults: config.foldPeekResults ?? EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS"),
    "the extension must pass the peek-fold condition into the active-context registration");
  assert(launcher.includes("--fold-peek-results") &&
    launcher.includes('case "$FOLD_PEEK_RESULTS" in true|false)'),
  "the shell launcher must accept and validate --fold-peek-results");
  checks.foldPeekResultsThreadedFromLauncherToRegistration = true;
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
  assert(!/--guided-curation|--guidance|GUIDED_CURATION|GUIDANCE=/.test(launcher),
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
// GATE 23 - the provider-total-window deployment fact is resolved from the model pin and
// threaded supervisor -> run config -> manifest -> registration, so no run can measure
// its curation thresholds against the per-request descriptor budget again (rep 16's abort)
// ---------------------------------------------------------------------------
{
  // The fact is keyed by model id, and each entry is pinned to its evidence.
  assert.equal(EXPERIMENT_PROVIDER_TOTAL_WINDOWS["gpt-5.6-luna"], 400_000);
  assert.equal(EXPERIMENT_PROVIDER_TOTAL_WINDOWS["gpt-5.6-sol"], 400_000);
  validateExperimentRunConfig({ ...runConfig, providerTotalWindow: 400_000 });
  validateExperimentRunConfig(runConfig); // unlisted models carry no key: descriptor mode
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerTotalWindow: 0 }),
    /provider total window is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerTotalWindow: "400000" }),
    /provider total window is invalid/);
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, providerWindow: 400_000 }),
    /run config shape/);
  validateExperimentManifest({ ...manifest, providerTotalWindow: 400_000 });
  validateExperimentManifest(manifest);
  assert.throws(() => validateExperimentManifest({ ...manifest, providerTotalWindow: -1 }),
    /provider total window is invalid/);
  assert(supervisor.includes("EXPERIMENT_PROVIDER_TOTAL_WINDOWS[modelId] ?? null") &&
    supervisor.includes("{ providerTotalWindow }"),
  "the supervisor must resolve the deployment fact from the model pin and record it in the run config");
  assert(worker.includes("{ providerTotalWindow: config.providerTotalWindow }"),
    "the worker must pin the run's serving-budget fact in the sealed manifest");
  assert(extension.includes("{ providerTotalWindow: config.providerTotalWindow }"),
    "the extension must pass the deployment fact into the active-context registration");
  assert(adjudicator.includes("providerTotalWindow: config.providerTotalWindow ?? null"),
    "the adjudicator must echo the run's serving-budget fact into the evidence");
  checks.providerTotalWindowThreadedFromModelPinToRegistration = true;
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
  // The runtime is neutral: no deployment brand may be baked into it.
  assert(!identity.PI_FOLD_READ_ONLY_TOOLS.has("pi_fold_context"),
    "the deployment's own context tool must be added at registration, not carried in the read-only set");
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
