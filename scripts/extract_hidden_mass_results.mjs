#!/usr/bin/env node

// Reduce one sealed hidden-mass campaign to a portable, deterministic result.
// The source trees carry machine-local absolute paths inside their seals, so
// this extract keeps their hashes and findings while emitting no local path.
//
//   node scripts/extract_hidden_mass_results.mjs <campaign-dir>
//
// JSON is written to stdout. The carriage sweep runs through its fixed-size
// child batches first; a partial sweep is a hard failure, never a thinner file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { branchTo } from "./lib/pi_context_attribution.mjs";
import { corpusManifestSha256 } from "./lib/pi_context_experiment.mjs";
import { directoryTreeSha256, sha256Json } from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = fileURLToPath(import.meta.url);
const CARRIAGE_SCRIPT = join(PROJECT, "scripts", "attribute_probe_carriage.mjs");
const ATTRIBUTION_HELPER = join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs");
const FOLD_IDENTITY = join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs");
const EXPERIMENT_CONTRACT = join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs");
const ATTESTATION_HELPER = join(PROJECT, "scripts", "lib", "pi_context_soak_attestation.mjs");
const RUNTIME_TREE = join(PROJECT, "extensions");
const campaignDir = process.argv[2];
if (!campaignDir) {
  process.stderr.write("usage: node scripts/extract_hidden_mass_results.mjs <campaign-dir>\n");
  process.exit(2);
}

const assertResult = (condition, message) => {
  if (!condition) throw new Error(message);
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonl = (path) => readFileSync(path, "utf8").split("\n")
  .filter(Boolean).map((line) => JSON.parse(line));
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const rounded = (value, digits = 6) => Number(value.toFixed(digits));

function sumUsage(records) {
  const totals = {
    calls: records.length,
    inputFresh: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    totalTokens: 0,
    usd: 0,
  };
  for (const record of records) {
    const usage = record.usage;
    totals.inputFresh += usage.input ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.output += usage.output ?? 0;
    totals.reasoning += usage.reasoning ?? 0;
    totals.totalTokens += usage.totalTokens ?? 0;
    totals.usd += usage.cost?.total ?? 0;
  }
  totals.usd = rounded(totals.usd);
  return totals;
}

function addUsage(left, right) {
  return {
    calls: left.calls + right.calls,
    inputFresh: left.inputFresh + right.inputFresh,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    totalTokens: left.totalTokens + right.totalTokens,
    usd: rounded(left.usd + right.usd),
  };
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const value = row[field] ?? "null";
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const harnessJsonl = new Set([
  "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
  "tool-results.jsonl", "worker-events.jsonl", "stop-the-world.jsonl",
]);

function sessionPath(runDir) {
  const names = readdirSync(runDir).filter((name) =>
    name.endsWith(".jsonl") && !harnessJsonl.has(name)).sort();
  assertResult(names.length === 1, `${basename(runDir)}: expected one session JSONL, found ${names.length}`);
  return join(runDir, names[0]);
}

function endBlockSummary(evidence) {
  if (!evidence?.endBlock?.delivered) return null;
  const checksumRows = evidence.endBlock.rows.filter((row) => row.kind === "checksum");
  const joinRows = evidence.endBlock.rows.filter((row) => row.kind === "join");
  const table = evidence.endBlock.rows.find((row) => row.kind === "table");
  return {
    delivered: true,
    checksums: {
      matches: checksumRows.filter((row) => row.verdict === "match").length,
      total: checksumRows.length,
      correctedSubjects: checksumRows.filter((row) => row.corrected).length,
      withdrawnChosen: checksumRows.filter((row) => row.withdrawnMatch).length,
    },
    joins: {
      recordCorrect: joinRows.filter((row) => row.recordCorrect).length,
      recallOfRecord: joinRows.filter((row) => row.recallOfRecord).length,
      truthMatch: joinRows.filter((row) => row.truthMatch).length,
      total: joinRows.length,
    },
    reconstruction: {
      matches: table?.rowsCorrect ?? 0,
      answered: table?.rowsAnswered ?? 0,
      total: table?.rowsTotal ?? 0,
    },
    recovery: evidence.endBlock.recovery,
  };
}

function extractRun(runDir, carriageRows, plan) {
  const configPath = join(runDir, "run-config.json");
  const candidatePath = join(runDir, "candidate-report.json");
  const candidateSealPath = join(runDir, "candidate-seal.json");
  const workerPath = join(runDir, "worker-report.json");
  const workerEventsPath = join(runDir, "worker-events.jsonl");
  const providerPath = join(runDir, "provider-requests.jsonl");
  const evidencePath = join(runDir, "experiment-evidence.json");
  const manifestPath = join(runDir, "run-manifest.json");
  const session = sessionPath(runDir);
  const config = readJson(configPath);
  const candidate = readJson(candidatePath);
  const candidateSeal = readJson(candidateSealPath);
  const worker = readJson(workerPath);
  const evidence = existsSync(evidencePath) ? readJson(evidencePath) : null;
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const hashes = {
    runConfigSha256: sha256File(configPath),
    candidateReportSha256: sha256File(candidatePath),
    candidateSealSha256: sha256File(candidateSealPath),
    workerReportSha256: sha256File(workerPath),
    workerEventsSha256: sha256File(workerEventsPath),
    sessionSha256: sha256File(session),
    providerLedgerSha256: sha256File(providerPath),
    runManifestFileSha256: manifest ? sha256File(manifestPath) : null,
    runManifestSha256: manifest ? sha256Json(manifest) : null,
    experimentEvidenceSha256: evidence ? sha256File(evidencePath) : null,
  };
  assertResult(candidateSeal.runId === config.runId && candidateSeal.arm === config.arm,
    `${config.runId}: candidate seal names a different run`);
  assertResult(candidateSeal.candidateReportSha256 === hashes.candidateReportSha256,
    `${config.runId}: candidate report does not match its seal`);
  assertResult(candidateSeal.sessionSha256 === hashes.sessionSha256,
    `${config.runId}: session does not match its candidate seal`);
  for (const [name, digest] of [
    ["run-config.json", hashes.runConfigSha256],
    ["worker-report.json", hashes.workerReportSha256],
    ["worker-events.jsonl", hashes.workerEventsSha256],
    ["provider-requests.jsonl", hashes.providerLedgerSha256],
    [basename(session), hashes.sessionSha256],
    ...(manifest ? [["run-manifest.json", hashes.runManifestFileSha256]] : []),
  ]) {
    assertResult(candidate.artifacts?.[name]?.sha256 === digest,
      `${config.runId}: ${name} does not match the candidate report`);
  }
  if (evidence) {
    assertResult(evidence.ok === true, `${config.runId}: experiment evidence is not accepted`);
    assertResult(evidence.evidence?.candidateReportSha256 === hashes.candidateReportSha256,
      `${config.runId}: evidence does not name the sealed candidate report`);
    assertResult(evidence.evidence?.sessionSha256 === hashes.sessionSha256,
      `${config.runId}: evidence does not name the sealed session`);
    assertResult(evidence.evidence?.providerLedgerSha256 === hashes.providerLedgerSha256,
      `${config.runId}: evidence does not name the provider ledger`);
    assertResult(evidence.evidence?.manifestSha256 === hashes.runManifestSha256,
      `${config.runId}: evidence does not name the run manifest`);
  }
  const providerRows = readJsonl(providerPath);
  const workerEvents = readJsonl(workerEventsPath);
  const entries = readJsonl(session);
  const providerResponses = providerRows.filter((row) => row.kind === "provider-response" && row.usage);
  const lastRequest = providerRows.findLast((row) => row.kind === "provider-request");
  assertResult(lastRequest?.leafId, `${config.runId}: provider ledger has no final request leaf`);
  const activeBranch = branchTo(entries, lastRequest.leafId);
  const compactions = entries.filter((entry) => entry.type === "compaction" && entry.usage);
  const messageUsage = sumUsage(providerResponses);
  const compactionUsage = sumUsage(compactions);
  const allProviderUsage = addUsage(messageUsage, compactionUsage);
  const promptTokens = providerResponses.map((row) =>
    (row.usage.input ?? 0) + (row.usage.cacheRead ?? 0));
  const pooledDenominator = messageUsage.inputFresh + messageUsage.cacheRead;
  const expectedJoins = new Map(plan.ledger.joins.map((row) => [row.id, row.expectedAnswer]));
  const ledgerRecordCalls = [];
  for (const entry of activeBranch) {
    for (const part of entry.message?.content ?? []) {
      if (part.type !== "toolCall" || part.name !== "ledger_record") continue;
      const taskId = part.arguments?.id;
      if (!expectedJoins.has(taskId)) continue;
      ledgerRecordCalls.push({
        toolCallId: part.id,
        taskId,
        recordedValue: part.arguments?.value ?? null,
      });
    }
  }
  const ledgerOutcomes = workerEvents.filter((row) =>
    ["ledger-record", "ledger-record-refused"].includes(row.kind) &&
    expectedJoins.has(row.details?.id));
  const outcomesByCall = new Map();
  for (const outcome of ledgerOutcomes) {
    const toolCallId = outcome.details?.toolCallId;
    assertResult(typeof toolCallId === "string" && toolCallId.length > 0,
      `${config.runId}: ledger outcome lacks a tool-call identity`);
    assertResult(!outcomesByCall.has(toolCallId),
      `${config.runId}: ledger call ${toolCallId} has more than one outcome`);
    outcomesByCall.set(toolCallId, outcome);
  }
  assertResult(ledgerRecordCalls.every((call) => outcomesByCall.has(call.toolCallId)),
    `${config.runId}: a task-id ledger call has no authoritative worker outcome`);
  assertResult(ledgerOutcomes.every((outcome) =>
    ledgerRecordCalls.some((call) => call.toolCallId === outcome.details.toolCallId)),
  `${config.runId}: a task-id ledger outcome has no call on the final active branch`);
  const ledgerRecords = [...expectedJoins].map(([taskId, expectedValue]) => {
    const calls = ledgerRecordCalls.filter((row) => row.taskId === taskId);
    const accepted = calls.filter((call) =>
      outcomesByCall.get(call.toolCallId)?.kind === "ledger-record");
    const rejected = calls.filter((call) =>
      outcomesByCall.get(call.toolCallId)?.kind === "ledger-record-refused");
    assertResult(accepted.length === 1,
      `${config.runId}: ${taskId} has ${accepted.length} accepted records instead of one`);
    assertResult(accepted[0].recordedValue ===
      outcomesByCall.get(accepted[0].toolCallId)?.details?.value,
    `${config.runId}: ${taskId} accepted value differs between call and worker event`);
    const recordedValue = accepted[0].recordedValue;
    return {
      taskId,
      recordedValue,
      correct: recordedValue === expectedValue,
      acceptedRecords: accepted.length,
      taskIdCallAttempts: calls.length,
      rejectedTaskIdCallAttempts: rejected.length,
      rejectionCauses: countBy(rejected.map((call) => ({
        cause: outcomesByCall.get(call.toolCallId).details.cause,
      })), "cause"),
    };
  });
  const probeVerdicts = evidence?.probeVerdicts ?? [];
  const rowsForRun = carriageRows.filter((row) => row.runId === config.runId);
  const evidenceRowsExpected = evidence
    ? probeVerdicts.length + (evidence.endBlock?.rows ?? []).reduce(
      (count, row) => count + (row.kind === "table" ? row.rows.length : 1), 0)
    : 0;
  assertResult(rowsForRun.length === evidenceRowsExpected,
    `${config.runId}: carriage has ${rowsForRun.length} rows, expected ${evidenceRowsExpected}`);
  const completed = candidate.ok === true && worker.ok === true && candidate.stagesReleased === config.stageCount;
  return {
    runId: config.runId,
    arm: config.arm,
    repetition: config.repetition,
    codeCommit: config.codeCommit,
    codeTree: config.codeTree,
    completed,
    stages: {
      released: candidate.stagesReleased,
      planned: config.stageCount,
    },
    failure: completed ? null : {
      candidate: candidate.failure?.message ?? null,
      worker: worker.error?.message ?? worker.error ?? null,
      terminatedBySignal: worker.terminatedBySignal ?? candidate.terminatedBySignal ?? null,
    },
    usage: {
      messageResponses: messageUsage,
      nativeCompactions: compactionUsage,
      allProvider: allProviderUsage,
      pooledCacheShare: pooledDenominator ? messageUsage.cacheRead / pooledDenominator : null,
      longContextMessageCalls: promptTokens.filter((tokens) => tokens > 272_000).length,
      peakPromptTokens: promptTokens.length ? Math.max(...promptTokens) : null,
      wallClockMs: evidence?.usage?.wallClockMs ??
        Math.max(0, (worker.workerFinishedWallMs ?? 0) - (worker.workerStartedWallMs ?? 0)),
      comparisonDisposition: config.arm === "native" && config.repetition === 1
        ? "excluded-harness-runaway"
        : completed ? "completed-attempt" : "failed-attempt-only",
    },
    mechanism: {
      folds: worker.foldSummary?.foldCount ?? 0,
      foldCommits: worker.foldSummary?.appliedCommits ?? 0,
      unpaidFoldReceipts: worker.foldSummary?.commitsWithoutReceipt ?? 0,
      nativeCompactions: compactions.length,
    },
    ledgerRecords,
    ordinaryProbes: evidence ? {
      matches: probeVerdicts.filter((row) => row.verdict === "match").length,
      total: probeVerdicts.length,
    } : null,
    endBlock: endBlockSummary(evidence),
    carriage: evidence ? {
      rows: rowsForRun.length,
      probeValueClassifications: countBy(rowsForRun.filter((row) => row.probeId), "valueCarriage"),
      endBlockValueClassifications: countBy(rowsForRun.filter((row) => row.endBlockId), "valueCarriage"),
      withdrawnClassifications: countBy(
        rowsForRun.filter((row) => row.withdrawnCarriage), "withdrawnCarriage"),
    } : null,
    artifactHashes: hashes,
  };
}

assertResult(existsSync(join(campaignDir, "runs")), `campaign has no runs directory: ${campaignDir}`);
const runDirs = readdirSync(join(campaignDir, "runs"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) => join(campaignDir, "runs", entry.name));
assertResult(runDirs.length > 0, "campaign has no run directories");
const configs = runDirs.map((runDir) => readJson(join(runDir, "run-config.json")));
const commonConfig = (config) => ({
  planSha256: config.planSha256,
  mode: config.mode,
  stageCount: config.stageCount,
  model: config.model,
  transport: config.transport,
  providerInputBudget: config.providerInputBudget,
  targetCommit: config.targetCommit,
  targetTreeSha256: config.targetTreeSha256,
  dependencyHashes: config.dependencyHashes,
});
const configIdentity = JSON.stringify(commonConfig(configs[0]));
assertResult(configs.every((config) => JSON.stringify(commonConfig(config)) === configIdentity),
  "hidden-mass extract requires one plan, model, transport, budget, target, and dependency identity");
const plan = readJson(configs[0].planPath);
assertResult(plan.version === 4, `hidden-mass extract requires protocol v4, received ${plan.version}`);
assertResult(configs.every((config) => plan.planSha256 === config.planSha256),
  "plan file does not match every run configuration");
const stagedFiles = plan.stages.flatMap((stage) => stage.files);
assertResult(new Set(stagedFiles.map((file) => file.path)).size === stagedFiles.length,
  "hidden-mass plan stages repeat a staged source file");
assertResult(corpusManifestSha256(stagedFiles) === configs[0].targetTreeSha256,
  "run target fingerprint is not the staged path-plus-content corpus manifest");

const sweep = spawnSync(process.execPath, [CARRIAGE_SCRIPT, campaignDir], {
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});
if (sweep.error) throw sweep.error;
assertResult(sweep.status === 0,
  `carriage sweep failed: ${sweep.stderr.trim() || `exit ${sweep.status}`}`);
const carriageLines = sweep.stdout.split("\n");
const marker = carriageLines.findIndex((line) => line.startsWith("=== rollup"));
assertResult(marker >= 0, "carriage sweep emitted no complete rollup marker");
const carriageRows = carriageLines.slice(0, marker).filter(Boolean).map((line) => JSON.parse(line));

const runs = runDirs.map((runDir) => extractRun(runDir, carriageRows, plan));
const byArm = (arm) => runs.filter((run) => run.arm === arm);
const pifold = byArm("pifold");
const native = byArm("native");
assertResult(pifold.length === 2 && native.length === 2,
  "hidden-mass release result requires two assigned attempts per arm");
const ledgerTotals = (armRuns) => ({
  correct: armRuns.flatMap((run) => run.ledgerRecords).filter((row) => row.correct).length,
  unknown: armRuns.flatMap((run) => run.ledgerRecords)
    .filter((row) => row.recordedValue === "unknown").length,
  total: armRuns.flatMap((run) => run.ledgerRecords).length,
});
const ledgerCallTotals = (armRuns) => ({
  accepted: armRuns.flatMap((run) => run.ledgerRecords)
    .reduce((sum, row) => sum + row.acceptedRecords, 0),
  rejected: armRuns.flatMap((run) => run.ledgerRecords)
    .reduce((sum, row) => sum + row.rejectedTaskIdCallAttempts, 0),
  total: armRuns.flatMap((run) => run.ledgerRecords)
    .reduce((sum, row) => sum + row.taskIdCallAttempts, 0),
});
const endBlockCells = pifold.reduce((total, run) => total +
  run.endBlock.checksums.matches + run.endBlock.joins.recallOfRecord +
  run.endBlock.reconstruction.matches, 0);
const probeRows = carriageRows.filter((row) => row.probeId);
const endBlockRows = carriageRows.filter((row) => row.endBlockId);

const payload = {
  version: 3,
  campaignLabel: basename(campaignDir),
  protocolVersion: plan.version,
  planSha256: plan.planSha256,
  design: {
    model: configs[0].model,
    transport: configs[0].transport,
    providerInputBudget: configs[0].providerInputBudget,
    target: {
      commit: configs[0].targetCommit,
      sourceCorpusFiles: plan.corpus.files,
      sourceCorpusManifestSha256: plan.repo.treeSha256,
      stagedFiles: stagedFiles.length,
      stagedCorpusManifestSha256: configs[0].targetTreeSha256,
    },
    stages: plan.stageCount,
    attemptedAssignmentsPerArm: 2,
  },
  findings: {
    completion: {
      pifold: { completed: pifold.filter((run) => run.completed).length, attempted: pifold.length },
      native: { completed: native.filter((run) => run.completed).length, attempted: native.length },
    },
    ledgerRecordEndpoints: {
      pifold: ledgerTotals(pifold),
      native: ledgerTotals(native),
    },
    ledgerRecordTaskIdCallAttempts: {
      pifold: ledgerCallTotals(pifold),
      native: ledgerCallTotals(native),
    },
    ordinaryProbes: {
      pifold: {
        matches: pifold.reduce((sum, run) => sum + run.ordinaryProbes.matches, 0),
        total: pifold.reduce((sum, run) => sum + run.ordinaryProbes.total, 0),
      },
      native: null,
    },
    withheldEndBlock: {
      pifold: { matches: endBlockCells, total: 60, completedRuns: 2 },
      native: null,
    },
    certification: {
      rows: carriageRows.length,
      expectedRows: 102,
      matchingOrdinaryAnswersAbsentOffBranch: probeRows.filter((row) =>
        row.verdict === "match" && row.valueCarriage === "absent-off-branch").length,
      ordinaryMismatchesWithVisibleBrief: probeRows.filter((row) =>
        row.verdict === "mismatch" && row.valueCarriage === "visible-brief").length,
      ordinaryMismatchesRecoverable: probeRows.filter((row) =>
        row.verdict === "mismatch" && row.valueCarriage === "recoverable").length,
      endBlockValueCarriage: countBy(endBlockRows, "valueCarriage"),
    },
  },
  claimLimits: [
    "Two assigned attempts per arm do not estimate a population failure rate.",
    "Neither native attempt reached the withheld end block, so there is no direct cross-arm end-block score.",
    "Both pi-fold end-block turns used context recovery calls; at the answering requests 53 expected values were visible raw and seven were recoverable but not visible.",
    "The seven recoverable end-block values were answered correctly, but this result does not identify how their bytes reached the answer.",
    "Native repetition 1 is excluded from cost comparison because the unbounded resume defect produced 1,761 provider responses.",
    "The result covers one model, one frozen plan, and one repository workload.",
  ],
  runs,
  carriageRows,
  sourceHashes: {
    extractorSha256: sha256File(SCRIPT),
    carriageScriptSha256: sha256File(CARRIAGE_SCRIPT),
    attributionHelperSha256: sha256File(ATTRIBUTION_HELPER),
    foldIdentitySha256: sha256File(FOLD_IDENTITY),
    experimentContractSha256: sha256File(EXPERIMENT_CONTRACT),
    attestationHelperSha256: sha256File(ATTESTATION_HELPER),
    runtimeTreeSha256: directoryTreeSha256(RUNTIME_TREE),
  },
};
assertResult(payload.findings.certification.rows === payload.findings.certification.expectedRows,
  `carriage sweep is partial: ${payload.findings.certification.rows} of ` +
  `${payload.findings.certification.expectedRows} rows`);
payload.extractSha256 = sha256Json(payload);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
