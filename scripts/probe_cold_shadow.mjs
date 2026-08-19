#!/usr/bin/env node

// Offline, experiment-only cold-detection shadow over sealed pi-fold sessions.
//
// This tests the conductor idea from the neighbouring Accordion project at our
// own evidence bar: can a local probe model's value-weighted, anchor-relative
// attention pick material to fold away that is LESS needed later than what the
// runtime's staleness ordering actually folded? Units are the runtime's own
// fold units read from its fold records, timeline-shifted: at each commit
// cohort's decision moment the cold policy folds the same number of units,
// coldest first, from the units the runtime itself proved foldable. Labels are
// exact answer-needle bytes of questions delivered after the moment, joined
// only after scoring. Nothing is surfaced to a model in any live session, no
// provider or network calls happen here, no shipped runtime option or folding
// behavior changes, and active-context mark nomination is outside this build:
// low attention alone must never commit a fold.
//
// The smoke extraction exposed that this runtime's fold layer has almost no
// which-unit freedom: it folds every completed batch behind the fresh tail, so
// an equal-count selection comparison is near-vacuous by construction. That is
// itself a finding, and the pre-registered line was corrected BEFORE any score
// existed. The primary metric is ordering quality: within each cohort, each
// policy orders the same rankable units for folding (staleness oldest-first,
// matching the runtime's stalest-first law; cold coldest-first), and each
// later-needed unit gets a normalized fold position. The kill line is pinned
// as a constant: the cold ordering must place later-needed units at a strictly
// higher mean normalized fold position (folded later, preserved longer) than
// the staleness ordering, or the cold conductor is killed on this corpus. The
// equal-count replay is kept as a secondary, reported beside its vacuity. No
// threshold may rescue failure and nothing is promoted either way. A unit
// whose prompt exceeds the probe model's declared bound is refused by name and
// counted, never sliced, and an unrankable unit leaves BOTH orderings so
// neither policy is judged on material the other cannot see.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COLD_SHADOW_PROTOCOL_VERSION = 1;
export const COLD_SHADOW_SCORER_ID = "qwen3-value-weighted-anchor-ratio-v1";
export const COLD_SHADOW_KILL_RULE =
  "the cold ordering must place later-needed units at a strictly higher mean normalized fold " +
  "position than the staleness ordering";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OPS_ROOT = join(
  process.env.HOME ?? "", "pi-fold-runs", "state", "ops", "pi-context-experiment");
const DEFAULT_OUTPUT_ROOT = join(PROJECT, "lab", "cold-shadow");
const HARNESS_JSONL = new Set([
  "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
  "tool-results.jsonl", "worker-events.jsonl",
]);

function assertCold(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonSha256(value) {
  return sha256(JSON.stringify(value));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sessionFile(runDir) {
  const names = readdirSync(runDir).filter((name) =>
    name.endsWith(".jsonl") && !HARNESS_JSONL.has(name)).sort();
  assertCold(names.length === 1, `${basename(runDir)} has ${names.length} session files`);
  return join(runDir, names[0]);
}

function collectProbes(plan) {
  const probes = new Map();
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    const id = value.probeId ?? value.id;
    if (typeof id === "string" && id.startsWith("probe-") &&
        typeof value.question === "string" && typeof value.expectedAnswer === "string" &&
        !probes.has(id)) probes.set(id, value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(plan);
  return probes;
}

function queryNeedles(query) {
  const answer = String(query.expectedAnswer);
  if (/^\d{1,2}$/.test(answer)) {
    const traceRow = /trace-[a-d]-0\d/.exec(query.question)?.[0];
    assertCold(traceRow, `${query.id} has a numeric answer without an attributable trace row`);
    return [`${traceRow}: ${answer}`, `${traceRow}: ${answer.padStart(2, "0")}`];
  }
  return [answer];
}

// The runtime's own fold units, read from its fold records. A record carries
// the complete fold object at creation; raw refs name entries directly and
// fold parts name child folds whose own records came earlier.
export function coldUnitsFromRecords(recordEntries) {
  const foldsById = new Map();
  const records = [];
  for (const entry of recordEntries) {
    const fold = entry.data?.fold;
    assertCold(fold?.id, "cold shadow fold record carries no fold");
    foldsById.set(fold.id, fold);
    records.push({ foldId: fold.id, entryId: entry.id });
  }
  // A unit is a fold's DIRECT raw contribution: the entries whose visibility
  // THIS fold's creation removed. Children absorbed by a later parent were
  // already folded and belong to their own units; a parent with no direct raw
  // parts reclaims brief space only and is excluded by name from this
  // comparison rather than double-counting its children.
  const units = [];
  const briefOnly = [];
  for (const { foldId, entryId } of records) {
    const fold = foldsById.get(foldId);
    const entryIds = (fold.parts ?? []).filter((part) => part.kind === "raw")
      .map((part) => part.ref.entryId);
    if (!entryIds.length) { briefOnly.push(foldId); continue; }
    units.push({
      unitId: foldId,
      recordEntryId: entryId,
      kind: fold.kind,
      parentId: fold.parentId ?? null,
      entryIds,
    });
  }
  return { units, briefOnlyUnitIds: briefOnly };
}

// Commit cohorts: fold records grouped by the nearest preceding provider
// request on the final branch. The decision moment is that request; records
// before the first request have no decision moment and are named, not scored.
export function coldCohorts({ units, branchIndexById, requestIndexes }) {
  const sortedRequests = [...requestIndexes].sort((left, right) => left.index - right.index);
  const cohorts = new Map();
  const preCommit = [];
  for (const unit of units) {
    const recordIndex = branchIndexById.get(unit.recordEntryId);
    assertCold(recordIndex !== undefined,
      `cold shadow fold record ${unit.unitId} is off the final branch`);
    let moment = null;
    for (const request of sortedRequests) {
      if (request.index < recordIndex) moment = request;
      else break;
    }
    if (!moment) { preCommit.push(unit.unitId); continue; }
    if (!cohorts.has(moment.momentId)) {
      cohorts.set(moment.momentId, { momentId: moment.momentId, momentIndex: moment.index, unitIds: [] });
    }
    cohorts.get(moment.momentId).unitIds.push(unit.unitId);
  }
  return {
    cohorts: [...cohorts.values()].sort((left, right) => left.momentIndex - right.momentIndex),
    preCommitUnitIds: preCommit,
  };
}

// Eligibility at a moment: the unit exists in full, is not yet folded by the
// policy being simulated, and sits behind the freshness fence, which is the
// newest entry the runtime itself reached at this cohort. The staleness picks
// are eligible by construction, so the cold policy always has enough choices.
export function coldEligible({ unit, momentIndex, fenceIndex, foldedSet, entryIndexById }) {
  if (foldedSet.has(unit.unitId)) return false;
  let newest = -1;
  for (const entryId of unit.entryIds) {
    const index = entryIndexById.get(entryId);
    if (index === undefined || index > momentIndex) return false;
    if (index > newest) newest = index;
  }
  return newest <= fenceIndex;
}

// Deterministic cold selection: lowest anchor-relative ratio first, unit id as
// the tie-break. A unit without a finite score (a named scoring refusal) is
// not selectable, and the caller reports how many such units each cohort had.
export function coldSelect({ eligibleUnitIds, ratios, count }) {
  const scoreable = eligibleUnitIds.filter((unitId) => Number.isFinite(ratios.get(unitId)));
  const picked = [...scoreable].sort((left, right) =>
    ratios.get(left) - ratios.get(right) || left.localeCompare(right)).slice(0, count);
  assertCold(picked.length === Math.min(count, scoreable.length),
    "cold selection lost a pick");
  return picked;
}

// Point-biserial correlation between a numeric score and a boolean label.
export function pointBiserial(rows) {
  const scores = rows.map((row) => row.score);
  const labels = rows.map((row) => (row.label ? 1 : 0));
  const n = rows.length;
  if (!n) return null;
  const positives = labels.reduce((total, value) => total + value, 0);
  if (positives === 0 || positives === n) return null;
  const mean = scores.reduce((total, value) => total + value, 0) / n;
  const sd = Math.sqrt(scores.reduce((total, value) => total + (value - mean) ** 2, 0) / n);
  if (!sd) return null;
  const meanPositive = rows.filter((row) => row.label)
    .reduce((total, row) => total + row.score, 0) / positives;
  const meanNegative = rows.filter((row) => !row.label)
    .reduce((total, row) => total + row.score, 0) / (n - positives);
  return ((meanPositive - meanNegative) / sd) *
    Math.sqrt((positives / n) * ((n - positives) / n));
}

// The policy replay and pre-registered verdict. Scores and labels meet here
// for the first time: the scorer never saw a label and the labels never saw a
// score. Both policies fold the same number of units per cohort; the cold
// policy's cumulative folded set feeds its own later eligibility.
export function coldComparison({ runs }) {
  const totals = {
    cohorts: 0,
    unitsFolded: { staleness: 0, cold: 0 },
    neededUnitsFolded: { staleness: 0, cold: 0 },
    neededBytesFolded: { staleness: 0, cold: 0 },
    bytesFolded: { staleness: 0, cold: 0 },
    scoringRefusals: 0,
    shortCohorts: 0,
  };
  const questionRows = [];
  const correlationRows = [];
  const orderingRows = [];
  for (const run of runs) {
    const unitById = new Map(run.units.map((unit) => [unit.unitId, unit]));
    const coldFolded = new Set();
    const stalenessFolded = new Set();
    const foldEvents = { staleness: new Map(), cold: new Map() };
    for (const cohort of run.cohorts) {
      totals.cohorts += 1;
      const ratios = new Map(cohort.scores.map((score) => [score.unitId, score.ratio]));
      totals.scoringRefusals += cohort.scores.filter((score) =>
        !Number.isFinite(score.ratio)).length;
      const eligibleCold = cohort.eligibleUnitIds.filter((unitId) => !coldFolded.has(unitId));
      const count = cohort.stalenessPickIds.length;
      const coldPicks = coldSelect({ eligibleUnitIds: eligibleCold, ratios, count });
      if (coldPicks.length < count) totals.shortCohorts += 1;
      for (const [policy, picks, folded] of [
        ["staleness", cohort.stalenessPickIds, stalenessFolded],
        ["cold", coldPicks, coldFolded],
      ]) {
        for (const unitId of picks) {
          folded.add(unitId);
          foldEvents[policy].set(unitId, cohort.momentIndex);
          const unit = unitById.get(unitId);
          assertCold(unit, `${policy} folded unknown unit ${unitId}`);
          totals.unitsFolded[policy] += 1;
          totals.bytesFolded[policy] += unit.bytes;
          if (cohort.laterNeededUnitIds.includes(unitId)) {
            totals.neededUnitsFolded[policy] += 1;
            totals.neededBytesFolded[policy] += unit.bytes;
          }
        }
      }
      // Primary ordering metric: both policies order the same rankable set.
      const rankable = cohort.eligibleUnitIds.filter((unitId) =>
        Number.isFinite(ratios.get(unitId)));
      if (rankable.length >= 2) {
        const byCold = [...rankable].sort((left, right) =>
          ratios.get(left) - ratios.get(right) || left.localeCompare(right));
        const byStale = [...rankable].sort((left, right) =>
          unitById.get(left).newestEntryIndex - unitById.get(right).newestEntryIndex ||
          left.localeCompare(right));
        for (const unitId of rankable) {
          if (!cohort.laterNeededUnitIds.includes(unitId)) continue;
          orderingRows.push({
            runId: run.runId,
            momentId: cohort.momentId,
            unitId,
            rankableUnits: rankable.length,
            coldPosition: (byCold.indexOf(unitId) + 1) / rankable.length,
            stalenessPosition: (byStale.indexOf(unitId) + 1) / rankable.length,
          });
        }
      }
      for (const score of cohort.scores) {
        if (!Number.isFinite(score.ratio)) continue;
        correlationRows.push({
          score: score.ratio,
          recency: unitById.get(score.unitId).newestEntryIndex,
          momentIndex: cohort.momentIndex,
          label: cohort.laterNeededUnitIds.includes(score.unitId),
        });
      }
    }
    for (const question of run.questions) {
      const carriers = question.carrierUnitIds;
      if (!carriers.length) continue;
      const hiddenUnder = (events) => carriers.every((unitId) =>
        events.has(unitId) && events.get(unitId) < question.answerMomentIndex);
      questionRows.push({
        runId: run.runId,
        queryId: question.queryId,
        carriers: carriers.length,
        hiddenUnderStaleness: hiddenUnder(foldEvents.staleness),
        hiddenUnderCold: hiddenUnder(foldEvents.cold),
      });
    }
  }
  const mean = (values) => values.length
    ? values.reduce((total, value) => total + value, 0) / values.length : null;
  const ordering = {
    laterNeededPlacements: orderingRows.length,
    meanColdPosition: mean(orderingRows.map((row) => row.coldPosition)),
    meanStalenessPosition: mean(orderingRows.map((row) => row.stalenessPosition)),
    rows: orderingRows,
  };
  assertCold(ordering.laterNeededPlacements > 0,
    "cold shadow has no later-needed placements to judge; the corpus cannot decide the kill line");
  const killed = !(ordering.meanColdPosition > ordering.meanStalenessPosition);
  return {
    totals,
    ordering,
    questions: questionRows,
    correlations: {
      coldnessVersusLaterNeeded: pointBiserial(correlationRows.map((row) => ({
        score: row.score, label: row.label }))),
      recencyVersusLaterNeeded: pointBiserial(correlationRows.map((row) => ({
        score: row.momentIndex - row.recency, label: row.label }))),
      scoredPairs: correlationRows.length,
    },
    verdict: {
      killRule: COLD_SHADOW_KILL_RULE,
      killed,
      reason: `mean normalized fold position of later-needed units: cold ` +
        `${ordering.meanColdPosition}, staleness ${ordering.meanStalenessPosition}` +
        (killed ? "; cold is not strictly later" : "; cold folds needed material later"),
      equalCountReplay: {
        nearVacuous: true,
        note: "this runtime folds every completed batch behind the fresh tail, so equal-count selection has almost no freedom; reported as context, not the registered line",
        neededUnitsFolded: totals.neededUnitsFolded,
      },
      promoted: false,
    },
  };
}

function branchOrder(attribution, entries) {
  const leaf = [...entries].reverse().find((entry) => entry?.id);
  const branch = attribution.branchTo(entries, leaf.id);
  return new Map(branch.map((entry, index) => [entry.id, index]));
}

function anchorText(attribution, branchEntries, momentIndex) {
  let user = "";
  let assistant = "";
  for (let index = momentIndex; index >= 0 && (!user || !assistant); index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user" && !user) user = attribution.entryText(entry);
    if (role === "assistant" && !assistant) assistant = attribution.entryText(entry);
  }
  return [user, assistant].filter(Boolean).join("\n\n");
}

async function extractRun({ attribution, identity, campaign, runDir, plan, runConfig, evidence }) {
  const sessionPath = sessionFile(runDir);
  const entries = readJsonl(sessionPath);
  const requests = readJsonl(join(runDir, "provider-requests.jsonl"))
    .filter((request) => request?.kind === "provider-request" && request.leafId);
  const indexById = branchOrder(attribution, entries);
  const branchEntries = [];
  for (const entry of entries) {
    const index = indexById.get(entry.id);
    if (index !== undefined) branchEntries[index] = entry;
  }
  const recordEntries = entries.filter((entry) =>
    entry?.type === "custom" && entry.customType === identity.PI_FOLD_FOLD_RECORD_ENTRY &&
    indexById.has(entry.id));
  const { units: rawUnits, briefOnlyUnitIds } = coldUnitsFromRecords(recordEntries);
  const units = rawUnits.map((unit) => {
    const text = unit.entryIds.map((entryId) => {
      const index = indexById.get(entryId);
      return index === undefined ? "" : attribution.entryText(branchEntries[index]).trim();
    }).filter(Boolean).join("\n");
    const entryIndexes = unit.entryIds.map((entryId) => indexById.get(entryId))
      .filter((index) => index !== undefined);
    return {
      ...unit,
      text,
      bytes: text.length,
      newestEntryIndex: entryIndexes.length ? Math.max(...entryIndexes) : -1,
    };
  });
  const requestIndexes = requests.map((request) => ({
    momentId: `${evidence.runId}#${request.ordinal}`,
    ordinal: request.ordinal,
    index: indexById.get(request.leafId),
  })).filter((request) => request.index !== undefined);
  const { cohorts, preCommitUnitIds } = coldCohorts({
    units, branchIndexById: indexById, requestIndexes });

  // Questions and needles for labels and for the consequence metric.
  const probes = collectProbes(plan);
  const questionSpecs = [];
  for (const verdict of evidence.probeVerdicts ?? []) {
    const probe = probes.get(verdict.probeId);
    assertCold(probe, `${evidence.runId} plan has no ${verdict.probeId}`);
    if (probe.kind === "derivation-control") continue;
    questionSpecs.push({
      id: probe.id ?? probe.probeId,
      question: probe.question,
      expectedAnswer: probe.expectedAnswer,
      deliveryMatch: `${verdict.probeId}:`,
      deliveryRole: "toolResult",
    });
  }
  if (plan.version === 4 && runConfig.querySeed != null && evidence.endBlock) {
    const experiment = await import(pathToFileURL(
      join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));
    for (const query of experiment.endBlockQuestions(plan.ledger, runConfig.querySeed)
      .filter((item) => item.kind !== "table")) {
      questionSpecs.push({
        id: query.id,
        question: query.question,
        expectedAnswer: query.expectedAnswer,
        deliveryMatch: "Before we close out the assignment",
        deliveryRole: "user",
      });
    }
  }
  const questions = [];
  for (const spec of questionSpecs) {
    const delivery = branchEntries.find((entry) => entry?.type === "message" &&
      entry.message?.role === spec.deliveryRole &&
      attribution.entryText(entry).includes(spec.deliveryMatch));
    assertCold(delivery, `${evidence.runId}/${spec.id} has no delivery entry`);
    const deliveryIndex = indexById.get(delivery.id);
    const needles = queryNeedles(spec);
    questions.push({
      queryId: spec.id,
      deliveryIndex,
      answerMomentIndex: deliveryIndex,
      needleSha256: needles.map(sha256),
      needles,
      carrierUnitIds: units.filter((unit) =>
        needles.some((needle) => unit.text.includes(needle))).map((unit) => unit.unitId),
    });
  }

  const entryIndexById = indexById;
  const stalenessFolded = new Set();
  const manifestMoments = [];
  const labelCohorts = [];
  for (const cohort of cohorts) {
    const pickUnits = cohort.unitIds.map((unitId) => units.find((unit) => unit.unitId === unitId));
    const fenceIndex = Math.max(...pickUnits.map((unit) => unit.newestEntryIndex));
    const eligible = units.filter((unit) => coldEligible({
      unit, momentIndex: cohort.momentIndex, fenceIndex,
      foldedSet: stalenessFolded, entryIndexById,
    })).map((unit) => unit.unitId);
    for (const unitId of cohort.unitIds) {
      assertCold(eligible.includes(unitId),
        `${evidence.runId} staleness pick ${unitId} is not eligible at its own cohort`);
      stalenessFolded.add(unitId);
    }
    const laterNeeded = units.filter((unit) => eligible.includes(unit.unitId) &&
      questions.some((question) => question.deliveryIndex > cohort.momentIndex &&
        question.needles.some((needle) => unit.text.includes(needle))))
      .map((unit) => unit.unitId);
    manifestMoments.push({
      momentId: cohort.momentId,
      momentIndex: cohort.momentIndex,
      anchorText: anchorText(attribution, branchEntries, cohort.momentIndex),
      cohortSize: cohort.unitIds.length,
      eligibleUnitIds: eligible,
    });
    labelCohorts.push({
      momentId: cohort.momentId,
      momentIndex: cohort.momentIndex,
      stalenessPickIds: cohort.unitIds,
      eligibleUnitIds: eligible,
      laterNeededUnitIds: laterNeeded,
    });
  }
  const scoringPairs = manifestMoments.reduce(
    (total, moment) => total + moment.eligibleUnitIds.length, 0);
  return {
    manifest: {
      runId: evidence.runId,
      campaign,
      sessionSha256: sha256(readFileSync(sessionPath)),
      moments: manifestMoments,
      units: Object.fromEntries(units.map((unit) => [unit.unitId, { text: unit.text }])),
      scoringPairs,
    },
    labels: {
      runId: evidence.runId,
      campaign,
      cohorts: labelCohorts,
      units: units.map(({ text, ...unit }) => unit),
      questions: questions.map(({ needles, ...question }) => question),
      preCommitUnitIds,
      briefOnlyUnitIds,
    },
  };
}

function assertOutputPath(path) {
  const resolved = resolve(path);
  const rel = relative(DEFAULT_OUTPUT_ROOT, resolved);
  assertCold(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)),
    `cold shadow output must stay under ${DEFAULT_OUTPUT_ROOT}`);
  return resolved;
}

async function runExtract({ opsRoot, runIds, outDir }) {
  const attribution = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
  const identity = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const manifests = [];
  const labels = [];
  for (const campaign of readdirSync(opsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    const runsDir = join(opsRoot, campaign, "runs");
    if (!existsSync(runsDir)) continue;
    for (const name of readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const runDir = join(runsDir, name);
      const evidencePath = join(runDir, "experiment-evidence.json");
      const configPath = join(runDir, "run-config.json");
      if (!existsSync(evidencePath) || !existsSync(configPath)) continue;
      const evidence = readJson(evidencePath);
      if (!runIds.includes(evidence.runId)) continue;
      const runConfig = readJson(configPath);
      const plan = readJson(runConfig.planPath);
      const extracted = await extractRun({
        attribution, identity, campaign, runDir, plan, runConfig, evidence });
      manifests.push(extracted.manifest);
      labels.push(extracted.labels);
    }
  }
  assertCold(manifests.length === runIds.length,
    `cold shadow expected ${runIds.length} runs, extracted ${manifests.length}`);
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "cold-manifest-v1.json");
  const labelsPath = join(outDir, "cold-labels-v1.json");
  writeFileSync(manifestPath, `${JSON.stringify({
    protocolVersion: COLD_SHADOW_PROTOCOL_VERSION,
    scorerId: COLD_SHADOW_SCORER_ID,
    runs: manifests,
  }, null, 2)}\n`);
  writeFileSync(labelsPath, `${JSON.stringify({
    protocolVersion: COLD_SHADOW_PROTOCOL_VERSION,
    runs: labels,
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    manifest: manifestPath,
    labels: labelsPath,
    runs: manifests.map((manifest) => ({
      runId: manifest.runId,
      moments: manifest.moments.length,
      units: Object.keys(manifest.units).length,
      scoringPairs: manifest.scoringPairs,
    })),
  }, null, 2)}\n`);
}

async function runSummarize({ outDir, scoresPath, output }) {
  const manifest = readJson(join(outDir, "cold-manifest-v1.json"));
  const labelData = readJson(join(outDir, "cold-labels-v1.json"));
  const scoreData = readJson(scoresPath);
  assertCold(scoreData.manifestSha256 === sha256(readFileSync(join(outDir, "cold-manifest-v1.json"))),
    "cold shadow scores were not computed from this manifest");
  const scoresByRun = new Map(scoreData.runs.map((run) => [run.runId, run]));
  const runs = labelData.runs.map((labelRun) => {
    const scoredRun = scoresByRun.get(labelRun.runId);
    assertCold(scoredRun, `cold shadow scores are missing run ${labelRun.runId}`);
    const scoreIndex = new Map(scoredRun.scores.map((score) =>
      [`${score.momentId}::${score.unitId}`, score]));
    return {
      runId: labelRun.runId,
      units: labelRun.units,
      questions: labelRun.questions,
      cohorts: labelRun.cohorts.map((cohort) => ({
        ...cohort,
        scores: cohort.eligibleUnitIds.map((unitId) => {
          const score = scoreIndex.get(`${cohort.momentId}::${unitId}`);
          assertCold(score, `cold shadow score missing for ${cohort.momentId}::${unitId}`);
          return { unitId, ratio: score.refused ? Number.NaN : score.ratio };
        }),
      })),
    };
  });
  const comparison = coldComparison({ runs });
  const stable = {
    protocolVersion: COLD_SHADOW_PROTOCOL_VERSION,
    experiment: "offline cold-detection shadow: value-weighted anchor-relative attention versus staleness",
    scorer: {
      id: COLD_SHADOW_SCORER_ID,
      version: COLD_SHADOW_PROTOCOL_VERSION,
      probe: scoreData.model ?? null,
      signal: "readout-row attention weighted by attended value-vector norm, unit mass over unit tokens divided by anchor mass over anchor tokens",
      providerCalls: 0,
      carrierMessages: 0,
      runtimeMutations: 0,
      thresholds: 0,
    },
    corpus: {
      runs: runs.map((run) => ({
        runId: run.runId,
        cohorts: run.cohorts.length,
        units: run.units.length,
        preCommitUnitIds: labelData.runs.find((item) => item.runId === run.runId).preCommitUnitIds,
      })),
    },
    source: {
      scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      scorerScriptSha256: scoreData.scriptSha256 ?? null,
      manifestSha256: scoreData.manifestSha256,
      scoresSha256: sha256(readFileSync(scoresPath)),
    },
    limitations: [
      "This is a selection-time comparison over the runtime's own fold units, not a counterfactual session replay; visibility downstream of a different fold history is approximated by cumulative folded sets.",
      "The probe model reads reconstructed prompts, not the serving model's own attention.",
      "Later-needed labels are exact answer-needle bytes of questions delivered after the moment; semantic need is broader.",
      "A unit whose prompt exceeds the probe's declared token bound is refused by name and is not selectable by the cold policy; refusal counts are reported.",
      "The freshness fence is the newest entry the runtime reached at each cohort, a proxy for its hold rules.",
    ],
    comparison,
  };
  const report = { ...stable, evidenceSha256: jsonSha256(stable) };
  const resolved = assertOutputPath(output);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: resolved,
    evidenceSha256: report.evidenceSha256,
    totals: comparison.totals,
    correlations: comparison.correlations,
    questions: comparison.questions,
    verdict: comparison.verdict,
  }, null, 2)}\n`);
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  const options = { opsRoot: DEFAULT_OPS_ROOT, runIds: [], outDir: DEFAULT_OUTPUT_ROOT };
  for (const argument of rest) {
    if (argument.startsWith("--ops=")) options.opsRoot = argument.slice("--ops=".length);
    else if (argument.startsWith("--run=")) options.runIds.push(argument.slice("--run=".length));
    else if (argument.startsWith("--out=")) options.outDir = argument.slice("--out=".length);
    else if (argument.startsWith("--scores=")) options.scoresPath = argument.slice("--scores=".length);
    else if (argument.startsWith("--output=")) options.output = argument.slice("--output=".length);
    else assertCold(false, `unknown argument: ${argument}`);
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseCli(process.argv.slice(2));
  if (command === "extract") {
    assertCold(options.runIds.length > 0, "extract needs at least one --run=RUN_ID");
    await runExtract(options);
    return;
  }
  if (command === "summarize") {
    assertCold(options.scoresPath, "summarize needs --scores=FILE");
    assertCold(options.output, "summarize needs --output=FILE");
    await runSummarize(options);
    return;
  }
  process.stdout.write([
    "probe_cold_shadow.mjs - offline cold-detection shadow (no provider or network calls)",
    "",
    "  extract   --run=RUN_ID... [--ops=DIR] [--out=DIR]   build scorer manifest + labels",
    "  summarize --scores=FILE --output=FILE [--out=DIR]   join scores, replay policies, verdict",
    "",
  ].join("\n"));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Cold shadow failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
