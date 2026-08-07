#!/usr/bin/env node

// Offline verification of the fold-vs-compaction harness contract. No provider calls, no
// live runs: this is the gate that must pass before the coordinator spends wall-clock on a
// smoke, and again before the full campaign. Soak-verifier style: every gate proves a
// specific failure is REJECTED, not merely that the happy path returns.
//
//   node scripts/verify_pi_context_experiment.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  armRuntimeConfiguration,
  assertBlindPacket,
  buildProbes,
  computeRereadTax,
  contextEventMetrics,
  corpusManifestSha256,
  deliverableTranscripts,
  estimateTokens,
  extractDefinitions,
  fileFacts,
  isWindowOverflow,
  probeTranscripts,
  seededShuffle,
  stageCallDisposition,
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
} from "./lib/pi_context_experiment.mjs";
import { sha256Text } from "./lib/pi_context_soak_attestation.mjs";

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
}
checks.modePlansProduceProbesAndDeliverables = true;

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
  const facts = ["alpha.rs", "beta.rs"].map((name) => fileFacts(fixture, join(fixture, name)));
  const unique = uniqueIdentifierIndex(facts);
  assert.equal(unique.get("beta_only_helper"), "beta.rs");
  const probes = buildProbes({ facts, seed: "fixture-seed", count: 3, uniqueIdentifiers: unique });
  assert.equal(probes.length, 3);
  // Every answer is a fact of the pinned bytes, verified here against the file itself.
  for (const probe of probes) {
    const fact = facts.find((candidate) => candidate.path === probe.sourcePath);
    assert(fact, `probe ${probe.id} points at an unknown file`);
    if (probe.kind === "definition-line") {
      assert.equal(fact.text.split("\n")[probe.sourceLine - 1].includes(probe.expectedAnswer), true);
    } else if (probe.kind === "file-line-count") {
      assert.equal(probe.expectedAnswer, String(fact.lines));
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

  // -------------------------------------------------------------------------
  // GATE 4 - stage plan hashing + ground-truth containment
  // -------------------------------------------------------------------------
  const modePlan = EXPERIMENT_MODE_PLANS.smoke;
  const bulk = `x${"y".repeat(modePlan.payloadFloorChars + 1_000)}`;
  writeFileSync(join(fixture, "bulk-a.rs"), bulk);
  writeFileSync(join(fixture, "bulk-b.rs"), `${bulk}z`);
  const bulkFacts = ["bulk-a.rs", "bulk-b.rs"].map((name) => fileFacts(fixture, join(fixture, name)));
  const stageOf = (ordinal, kind, files, stageProbes, deliverable) => {
    const stage = {
      ordinal,
      kind,
      instructions: `stage ${ordinal} instructions`,
      files: files.map((fact) => ({
        path: fact.path, sha256: fact.sha256, lines: fact.lines, chars: fact.chars, bytes: fact.bytes,
      })),
      probes: stageProbes,
      deliverable,
      payloadChars: 0,
      payloadSha256: "0".repeat(64),
    };
    const payload = stagePayloadText({
      ...stage,
      files: files.map((fact) => ({ ...fact })),
      probes: stageProbes.map(({ expectedAnswer: _a, sourcePath: _p, sourceLine: _l, ...rest }) => rest),
    });
    stage.payloadChars = payload.length;
    stage.payloadSha256 = sha256Text(payload);
    return stage;
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
      if (modePlan.probeStages.includes(ordinal)) return stageOf(ordinal, "probe", [], probes, null);
      const files = [{ ...bulkFacts[ordinal % 2], path: `stage-${ordinal}.rs` }];
      const deliverable = ordinal % modePlan.deliverableEvery === 0
        ? { id: `deliverable-${ordinal}`, instructions: "write it", referencesStages: [1] }
        : null;
      return stageOf(ordinal, ordinal % modePlan.revisitEvery === 0 ? "revisit" : "read", files, [], deliverable);
    }),
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

  const runPlan = stagePlanForRun(plan);
  const runSerialized = JSON.stringify(runPlan);
  for (const probe of probes) {
    assert(!runSerialized.includes(probe.expectedAnswer) ||
      probe.kind === "symbol-file" || probe.kind === "file-line-count",
    "run-visible plan leaked a probe answer");
  }
  assert(runPlan.stages.every((stage) => stage.probes.every((probe) =>
    !Object.hasOwn(probe, "expectedAnswer") && !Object.hasOwn(probe, "sourceLine"))),
  "run-visible plan retained probe ground truth");
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
  runDir: "/home/shane/quorum-run/state/ops/pi-context-experiment/c1/runs/run-1",
  campaignId: "c1",
  arm: "native",
  mode: "smoke",
  guidance: "curation",
  repetition: 2,
  ordinal: 2,
  seed: "0011223344556677",
  unit: "quorum-pi-context-experiment-run-1.service",
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
    piSubagentsPackageJson: "d".repeat(64), piSubagentsSrcTree: "e".repeat(64),
    nodeExecutable: "f".repeat(64),
  },
  planPath: "/home/shane/quorum-run/state/ops/pi-context-experiment/c1/stages-smoke.json",
  planSha256: "2".repeat(64),
  repoDir: "/home/shane/quorum-run/state/ops/pi-context-experiment/c1/runs/run-1/repo",
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
  extension.includes("guidance: config.guidance,") &&
  extension.includes("if (pifold) {"),
"the extension must register the active-context runtime only for the pifold arm, with the run's guidance profile");
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
  launcher.includes("--setenv=QUORUM_CONTEXT_SOAK_SANITIZED=1") &&
  launcher.includes("UnsetEnvironment=QUORUM_PI_ROOT NODE_OPTIONS") &&
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
  const probe4Index = assistant("probe-01: AlphaConfig\nprobe-02: 12\nprobe-03: beta.rs", "c6");
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
    ["AlphaConfig", "12", "beta.rs"]);
  assert(displacedProbes[0].answers.every((answer) => answer.parsed));
  // Wave 8 was genuinely never answered: the scan must NOT reach back for an earlier
  // wave's identically-named probe ids.
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
  assert.equal(EXPERIMENT_SCHEDULING_SOURCE, ".pi/extensions/quorum/lib/scheduling.ts");
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
    supervisor.includes("libPaths.includes(EXPERIMENT_SCHEDULING_SOURCE) === schedulingPresent") &&
    supervisor.includes("foldScheduling,"),
  "the supervisor must accept --fold-scheduling, pin the whole extension lib, require the scheduler for epoch, and record it in the run config");
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
  // pi-fold throws at registration when guided curation has no commit to announce, so the
  // combination must be refused at config time, on both the default and the explicit
  // immediate scheduler.
  assert.throws(() => validateExperimentRunConfig({ ...runConfig, guidedCuration: true }),
    /guided curation requires epoch fold scheduling/);
  assert.throws(() => validateExperimentRunConfig({
    ...runConfig, foldScheduling: "immediate", guidedCuration: true,
  }), /guided curation requires epoch fold scheduling/);
  validateExperimentManifest({ ...manifest, foldScheduling: "epoch", guidedCuration: true });
  assert.throws(() => validateExperimentManifest({ ...manifest, guidedCuration: "true" }),
    /guided-curation condition is not a boolean/);
  assert.throws(() => validateExperimentManifest({ ...manifest, guidedCuration: true }),
    /guided curation requires epoch fold scheduling/);
  assert.throws(() => validateExperimentManifest({ ...manifest, guidedCurated: true }),
    /manifest shape/);
  // Sealed run directories are immutable data: runs 10-14 recorded the retired condition
  // key, so reading them must still validate. Nothing emits it any more.
  validateExperimentRunConfig({ ...runConfig, reliabilityLevers: true });
  validateExperimentManifest({ ...manifest, reliabilityLevers: true });
  assert(supervisor.includes('argumentValue("--guided-curation"') &&
    supervisor.includes('["true", "false"].includes(guidedCurationArgument)') &&
    supervisor.includes('!guidedCuration || foldScheduling === "epoch"') &&
    supervisor.includes("guidedCuration,"),
  "the supervisor must accept --guided-curation, refuse it without epoch scheduling, and record it in the run config");
  assert(worker.includes("guidedCuration: config.guidedCuration ?? EXPERIMENT_DEFAULT_GUIDED_CURATION"),
    "the worker must record the run's guided-curation condition in the sealed manifest");
  assert(adjudicator.includes("guidedCuration: config.guidedCuration ?? EXPERIMENT_DEFAULT_GUIDED_CURATION"),
    "the adjudicator must echo the run's guided-curation condition into the evidence");
  assert(extension.includes("guidedCuration: config.guidedCuration ?? EXPERIMENT_DEFAULT_GUIDED_CURATION"),
    "the extension must pass guided curation into the active-context registration");
  assert(launcher.includes("--guided-curation") &&
    launcher.includes('case "$GUIDED_CURATION" in true|false)') &&
    launcher.includes('[ "$FOLD_SCHEDULING" = epoch ]'),
  "the shell launcher must accept, validate and epoch-couple --guided-curation");
  // Removal-and-debt: the retired option set must not survive anywhere in scripts/ as
  // callable code — an anti-pattern left callable gets recomposed. The needle is
  // assembled so this gate does not match itself.
  const retiredOptions = ["RELIABILITY", "LEVER"].join("_");
  const survivors = spawnSync("/usr/bin/grep", ["-rlF", retiredOptions, join(PROJECT, "scripts")],
    { encoding: "utf8" });
  assert.equal(survivors.status, 1,
    `${retiredOptions} must be purged from scripts/; still present in:\n${survivors.stdout}`);
  checks.guidedCurationThreadedFromLauncherToRegistration = true;
}

// ---------------------------------------------------------------------------
// GATE 23 - the provider-total-window deployment fact is resolved from the model pin and
// threaded supervisor -> run config -> manifest -> registration, so no run can measure
// its curation thresholds against the per-request descriptor budget again (rep 16's abort)
// ---------------------------------------------------------------------------
{
  // The fact is keyed by model id, and the one proven wire is pinned to its evidence.
  assert.equal(EXPERIMENT_PROVIDER_TOTAL_WINDOWS["gpt-5.6-luna"], 400_000);
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
  const prefix = (ordinal, over) => ({ type: "custom", customType: "quorum-context-event",
    data: { kind: "context.prefix", ordinal, change: "append", divergent_tokens: null,
      estimated_tokens: 0, cause: "pure-append", request_class: "steady-state", ...over } });
  const custom = (data) => ({ type: "custom", customType: "quorum-context-event", data });
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
    { type: "custom", customType: "quorum-active-context-state", data: { kind: "context.prefix" } },
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
