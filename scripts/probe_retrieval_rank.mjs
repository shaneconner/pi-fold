#!/usr/bin/env node

// Offline, experiment-only rank-only BM25 falsifier over sealed pi-fold sessions.
//
// This is the queued complete-evidence successor test to the historical shadow:
// every eligible fold is a candidate, every candidate document is its complete
// projection text (text parts, tool call names, and tool call arguments), and
// nothing is sliced, capped, or prefiltered. The scorer returns ranks only.
// There is no threshold anywhere in this experiment and no threshold may
// rescue failure. Exact answers are joined afterward as labels. Nothing is
// surfaced to a model, no provider or network calls happen, no shipped runtime
// option or folding behavior changes, and active-context mark nomination is
// outside this build.
//
// The promote and kill criteria are pre-registered and pinned here as
// constants. A corpus below the minimum needed-question floor is refused by
// name rather than scored thin. A sealed run whose durable state the current
// runtime refuses to load is excluded by name beside the result, never
// silently dropped.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RETRIEVAL_SHADOW_BM25_B,
  RETRIEVAL_SHADOW_BM25_K1,
  buildRetrievalShadowIndex,
  retrievalShadowRawBm25,
  retrievalShadowTokens,
} from "./probe_retrieval_shadow.mjs";

export const RETRIEVAL_RANK_PROTOCOL_VERSION = 1;
export const RETRIEVAL_RANK_SCORER_ID = "bm25-complete-evidence-rank-v1";
export const RETRIEVAL_RANK_MINIMUM_NEEDED_QUESTIONS = 20;
export const RETRIEVAL_RANK_PROMOTE_RECALL_AT_5 = 0.80;
export const RETRIEVAL_RANK_PROMOTE_RECALL_AT_1 = 0.50;
export const RETRIEVAL_RANK_KILL_RECALL_AT_5 = 0.60;
export const RETRIEVAL_RANK_KILL_NEWEST_FIRST_MARGIN = 0.10;

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OPS_ROOT = join(
  process.env.HOME ?? "", "pi-fold-runs", "state", "ops", "pi-context-experiment");
const DEFAULT_OUTPUT_ROOT = join(PROJECT, "lab", "retrieval-rank");
const HARNESS_JSONL = new Set([
  "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
  "tool-results.jsonl", "worker-events.jsonl",
]);
const CARRIAGE_PRECEDENCE = ["visible-raw", "visible-brief", "recoverable", "absent"];

function assertRank(condition, message) {
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

// Labels are intentionally absent from this interface. Callers may carry any
// additional metadata on a candidate, but only id and document enter the index
// or score, and the returned order is deterministic in score then id whatever
// order the candidates arrived in.
export function scoreRetrievalRankCandidates({ query, candidates }) {
  assertRank(typeof query === "string" && query.length > 0,
    "retrieval rank needs a non-empty query");
  assertRank(Array.isArray(candidates), "retrieval rank needs a candidate array");
  const seen = new Set();
  const documents = candidates.map((candidate) => {
    assertRank(typeof candidate?.id === "string" && candidate.id,
      "retrieval rank candidate needs an id");
    assertRank(!seen.has(candidate.id), `retrieval rank candidate ${candidate.id} repeats`);
    seen.add(candidate.id);
    assertRank(typeof candidate.document === "string",
      `retrieval rank candidate ${candidate.id} needs a complete document string`);
    return { key: candidate.id, tokens: retrievalShadowTokens(candidate.document) };
  });
  const index = buildRetrievalShadowIndex(documents);
  const queryTerms = retrievalShadowTokens(query);
  const rows = candidates.map((candidate) => ({
    id: candidate.id,
    score: retrievalShadowRawBm25(index, candidate.id, queryTerms),
    documentTokens: index.documents.get(candidate.id).length,
  })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((row, position) => ({ ...row, rank: position + 1 }));
  return {
    queryTerms,
    corpus: {
      documents: index.count,
      averageDocumentTokens: index.averageLength,
      documentFrequencySha256: jsonSha256([...index.documentFrequency.entries()].sort()),
    },
    rows,
  };
}

// Rank metrics over the needed questions only, with the newest-first baseline
// computed from the same relevance labels. A needed question with no relevant
// candidate is a document-construction failure and is refused by name: the
// carriage lens said the fact is recoverable, so its bytes must sit inside
// some candidate document.
export function summarizeRetrievalRankQueries(queries) {
  assertRank(Array.isArray(queries), "retrieval rank summary needs a query array");
  const needed = queries.filter((query) => query.retrievalNeeded === true);
  let bm25At1 = 0;
  let bm25At5 = 0;
  let newestAt1 = 0;
  let newestAt5 = 0;
  let reciprocalSum = 0;
  for (const query of needed) {
    const relevant = query.candidates.filter((candidate) => candidate.relevant === true);
    assertRank(relevant.length > 0,
      `retrieval-rank-needed-without-relevant-candidate:${query.runId}/${query.queryId}`);
    const bestRank = Math.min(...relevant.map((candidate) => candidate.rank));
    const bestNewest = Math.min(...relevant.map((candidate) => candidate.newestRank));
    if (bestRank === 1) bm25At1 += 1;
    if (bestRank <= 5) bm25At5 += 1;
    if (bestNewest === 1) newestAt1 += 1;
    if (bestNewest <= 5) newestAt5 += 1;
    reciprocalSum += 1 / bestRank;
  }
  return {
    queries: queries.length,
    candidateRows: queries.reduce((total, query) => total + query.candidates.length, 0),
    neededQuestions: needed.length,
    carriage: Object.fromEntries(CARRIAGE_PRECEDENCE.map((classification) => [
      classification,
      queries.filter((query) => query.carriage === classification).length,
    ])),
    recallAt1: needed.length ? bm25At1 / needed.length : null,
    recallAt5: needed.length ? bm25At5 / needed.length : null,
    meanReciprocalRank: needed.length ? reciprocalSum / needed.length : null,
    newestFirstRecallAt1: needed.length ? newestAt1 / needed.length : null,
    newestFirstRecallAt5: needed.length ? newestAt5 / needed.length : null,
    hits: {
      bm25At1, bm25At5, newestFirstAt1: newestAt1, newestFirstAt5: newestAt5,
    },
  };
}

// The pre-registered decision. Kill is evaluated before promote so a scorer
// cannot promote while failing to beat newest-first; the criteria exist to
// falsify, and no threshold may rescue failure.
export function retrievalRankVerdict(summary) {
  assertRank(summary.neededQuestions >= RETRIEVAL_RANK_MINIMUM_NEEDED_QUESTIONS,
    `retrieval-rank-needed-floor:${summary.neededQuestions}<` +
    `${RETRIEVAL_RANK_MINIMUM_NEEDED_QUESTIONS}`);
  const newestMargin = summary.recallAt1 - summary.newestFirstRecallAt1;
  const reasons = [];
  if (summary.recallAt5 < RETRIEVAL_RANK_KILL_RECALL_AT_5) {
    reasons.push(`recallAt5 ${summary.recallAt5} < ${RETRIEVAL_RANK_KILL_RECALL_AT_5}`);
  }
  if (newestMargin < RETRIEVAL_RANK_KILL_NEWEST_FIRST_MARGIN) {
    reasons.push(`recallAt1 ${summary.recallAt1} beats newest-first ` +
      `${summary.newestFirstRecallAt1} by ${newestMargin}, below ` +
      `${RETRIEVAL_RANK_KILL_NEWEST_FIRST_MARGIN}`);
  }
  if (reasons.length) return { verdict: "kill", reasons };
  if (summary.recallAt5 >= RETRIEVAL_RANK_PROMOTE_RECALL_AT_5 &&
      summary.recallAt1 >= RETRIEVAL_RANK_PROMOTE_RECALL_AT_1) {
    return {
      verdict: "promote",
      reasons: [`recallAt5 ${summary.recallAt5} >= ${RETRIEVAL_RANK_PROMOTE_RECALL_AT_5}`,
        `recallAt1 ${summary.recallAt1} >= ${RETRIEVAL_RANK_PROMOTE_RECALL_AT_1}`],
    };
  }
  return {
    verdict: "neither",
    reasons: [`recallAt5 ${summary.recallAt5} and recallAt1 ${summary.recallAt1} ` +
      "sit between the pre-registered kill and promote lines; nothing is promoted"],
  };
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
    assertRank(traceRow, `${query.id} has a numeric answer without an attributable trace row`);
    return [`${traceRow}: ${answer}`, `${traceRow}: ${answer.padStart(2, "0")}`];
  }
  return [answer];
}

function messageEntryText(attribution, entry) {
  return entry?.type === "message" ? attribution.entryText(entry) : "";
}

function descendsFrom(entriesById, leafId, ancestorId) {
  const seen = new Set();
  for (let id = leafId; id !== null && id !== undefined;) {
    if (id === ancestorId) return true;
    if (seen.has(id)) throw new Error(`retrieval rank branch cycles at ${id}`);
    seen.add(id);
    id = entriesById.get(id)?.parentId ?? null;
  }
  return false;
}

function firstProviderRequestAfter(entries, requests, deliveryId) {
  const byId = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  return requests.filter((request) => request?.kind === "provider-request" && request.leafId &&
    descendsFrom(byId, request.leafId, deliveryId))
    .sort((left, right) => left.ordinal - right.ordinal)[0] ?? null;
}

function sessionFile(runDir) {
  const names = readdirSync(runDir).filter((name) =>
    name.endsWith(".jsonl") && !HARNESS_JSONL.has(name)).sort();
  assertRank(names.length === 1, `${basename(runDir)} has ${names.length} session files`);
  return join(runDir, names[0]);
}

// The complete-evidence document: every entry the fold's flattened refs name,
// read through the attribution lens's own entryText so text parts, tool call
// names, and tool call arguments all count, exactly as carriage classification
// counts them. Nothing is sliced.
function rankDocument(runtime, attribution, fold, state, entriesById) {
  const pieces = [];
  for (const ref of runtime.flattenFoldRefs(fold, state)) {
    const entry = entriesById.get(ref.entryId);
    if (!entry) continue;
    const text = attribution.entryText(entry).trim();
    if (text) pieces.push(text);
  }
  return pieces.join("\n");
}

function rankCandidates(runtime, attribution, state, snapshot, entriesById) {
  const expanded = new Set(state.expanded ?? []);
  return runtime.orderedFoldTree(state, snapshot).filter((fold) => !expanded.has(fold.id))
    .flatMap((fold) => {
      const interval = runtime.foldInterval(fold, state, snapshot);
      if (!interval) return [];
      const refs = runtime.flattenFoldRefs(fold, state);
      const blocked = fold.kind === "tool-result"
        ? runtime.toolRefsProtected(refs, state, snapshot)
        : runtime.refsProtected(refs, state, snapshot);
      if (blocked) return [];
      const document = rankDocument(runtime, attribution, fold, state, entriesById);
      if (!document) return [];
      return [{
        id: fold.id,
        kind: fold.kind,
        parentId: fold.parentId,
        depth: runtime.foldDepth(state, fold),
        position: interval.end,
        sourceCount: refs.length,
        document,
      }];
    });
}

function loadRunState({ runtime, attribution, identity, entries, sessionId, leafId,
  providerInputBudget }) {
  const branch = attribution.branchTo(entries, leafId);
  const { state } = runtime.materializeStatePersistence(
    branch, sessionId, identity.PI_FOLD_STATE_ENTRY, identity.PI_FOLD_FOLD_RECORD_ENTRY);
  const eventMessages = branch.flatMap((entry) => runtime.sessionEntryMessages(entry));
  const snapshot = runtime.mapActiveContext({
    sessionId,
    eventMessages,
    contextEntries: branch,
    ...(Number.isFinite(providerInputBudget) && providerInputBudget > 0
      ? { contextWindow: providerInputBudget, netBudget: true } : {}),
  });
  return {
    branch,
    state,
    snapshot,
    entriesById: new Map(branch.filter((entry) => entry?.id)
      .map((entry) => [entry.id, entry])),
    ...attribution.projectionCarriers({ runtime, state, snapshot }),
  };
}

function classifyNeedles(attribution, view, needles) {
  const classifications = needles.map((needle) =>
    attribution.classifyFactCarriage(view, needle).classification);
  for (const classification of CARRIAGE_PRECEDENCE) {
    if (classifications.includes(classification)) return classification;
  }
  return "absent";
}

function buildQuerySpecs({ experiment, plan, runConfig, evidence, probes }) {
  const specs = [];
  for (const verdict of evidence.probeVerdicts ?? []) {
    const probe = probes.get(verdict.probeId);
    assertRank(probe, `${evidence.runId} plan has no ${verdict.probeId}`);
    if (probe.kind === "derivation-control") continue;
    specs.push({
      id: probe.id ?? probe.probeId,
      kind: `ordinary:${probe.kind}`,
      question: probe.question,
      expectedAnswer: probe.expectedAnswer,
      deliveryMatch: `${verdict.probeId}:`,
      deliveryRole: "toolResult",
    });
  }
  if (plan.version === 4 && runConfig.querySeed != null && evidence.endBlock) {
    const endQuestions = experiment.endBlockQuestions(plan.ledger, runConfig.querySeed)
      .filter((query) => query.kind !== "table");
    for (const query of endQuestions) {
      specs.push({
        id: query.id,
        kind: `end-block:${query.kind}`,
        question: query.question,
        expectedAnswer: query.expectedAnswer,
        deliveryMatch: "Before we close out the assignment",
        deliveryRole: "user",
      });
    }
  }
  return specs;
}

function runQueries({ runtime, attribution, identity, experiment, campaign, runDir,
  plan, runConfig, evidence }) {
  const sessionPath = sessionFile(runDir);
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, "").split("_").at(-1);
  const entries = readJsonl(sessionPath);
  const requests = readJsonl(join(runDir, "provider-requests.jsonl"));
  const probes = collectProbes(plan);
  const specs = buildQuerySpecs({ experiment, plan, runConfig, evidence, probes });
  assertRank(specs.length > 0, `${evidence.runId} yields no scoreable questions`);
  const stateCache = new Map();
  const rows = [];
  for (const spec of specs) {
    const delivery = entries.find((entry) => entry?.type === "message" &&
      entry.message?.role === spec.deliveryRole &&
      messageEntryText(attribution, entry).includes(spec.deliveryMatch));
    assertRank(delivery, `${evidence.runId}/${spec.id} has no delivery entry`);
    const request = firstProviderRequestAfter(entries, requests, delivery.id);
    assertRank(request, `${evidence.runId}/${spec.id} has no first provider request`);
    let cached = stateCache.get(request.leafId);
    if (!cached) {
      const view = loadRunState({
        runtime, attribution, identity, entries, sessionId, leafId: request.leafId,
        providerInputBudget: runConfig.providerInputBudget,
      });
      cached = {
        view,
        candidates: rankCandidates(
          runtime, attribution, view.state, view.snapshot, view.entriesById),
      };
      stateCache.set(request.leafId, cached);
    }
    const needles = queryNeedles(spec);
    assertRank(needles.every((needle) => !spec.question.includes(needle)),
      `${evidence.runId}/${spec.id} leaks its answer into the scorer query`);
    const scored = scoreRetrievalRankCandidates({
      query: spec.question,
      candidates: cached.candidates,
    });
    const carriage = classifyNeedles(attribution, cached.view, needles);
    const byId = new Map(cached.candidates.map((candidate) => [candidate.id, candidate]));
    const newestRank = new Map([...cached.candidates].sort((left, right) =>
      right.position - left.position || left.id.localeCompare(right.id))
      .map((candidate, index) => [candidate.id, index + 1]));
    rows.push({
      runId: evidence.runId,
      campaign,
      repetition: evidence.repetition,
      queryId: spec.id,
      kind: spec.kind,
      questionSha256: sha256(spec.question),
      questionChars: spec.question.length,
      answerNeedleSha256: needles.map(sha256),
      deliveryEntryId: delivery.id,
      firstRequestOrdinal: request.ordinal,
      firstRequestLeafId: request.leafId,
      stateRevision: cached.view.state.revision,
      queryTerms: scored.queryTerms,
      corpus: scored.corpus,
      carriage,
      retrievalNeeded: carriage === "recoverable",
      candidateCount: cached.candidates.length,
      candidates: scored.rows.map((score) => {
        const candidate = byId.get(score.id);
        assertRank(candidate, `score names missing candidate ${score.id}`);
        return {
          ...score,
          kind: candidate.kind,
          parentId: candidate.parentId,
          depth: candidate.depth,
          position: candidate.position,
          newestRank: newestRank.get(candidate.id),
          sourceCount: candidate.sourceCount,
          documentChars: candidate.document.length,
          documentSha256: sha256(candidate.document),
          relevant: needles.some((needle) => candidate.document.includes(needle)),
        };
      }),
    });
  }
  return {
    runId: evidence.runId,
    campaign,
    repetition: evidence.repetition,
    codeCommit: evidence.codeCommit ?? null,
    planVersion: plan.version ?? null,
    planSha256: runConfig.planSha256,
    sessionSha256: sha256(readFileSync(sessionPath)),
    providerRequestsSha256: sha256(readFileSync(join(runDir, "provider-requests.jsonl"))),
    queryCount: rows.length,
    queryRows: rows,
  };
}

function eligibleRuns(opsRoot) {
  assertRank(existsSync(opsRoot), `retrieval rank ops root missing: ${opsRoot}`);
  const runs = [];
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
      const config = readJson(configPath);
      if (evidence.arm !== "pifold" || config.arm !== "pifold") continue;
      runs.push({ campaign, runDir, evidence, config });
    }
  }
  return runs;
}

function assertOutputPath(path) {
  const resolved = resolve(path);
  const rel = relative(DEFAULT_OUTPUT_ROOT, resolved);
  assertRank(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)),
    `retrieval rank output must stay under ${DEFAULT_OUTPUT_ROOT}`);
  return resolved;
}

export async function runRetrievalRankSweep(opsRoot) {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const runtime = await jiti.import(join(PROJECT, "extensions", "active-context.ts"));
  const attribution = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
  const identity = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const experiment = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));
  const included = [];
  const excluded = [];
  for (const { campaign, runDir, evidence, config } of eligibleRuns(opsRoot)) {
    const plan = readJson(config.planPath);
    assertRank(experiment.stagePlanSha256(plan) === config.planSha256,
      `${evidence.runId} plan hash does not match run config`);
    const specCount = buildQuerySpecs({
      experiment, plan, runConfig: config, evidence, probes: collectProbes(plan),
    }).length;
    if (specCount === 0) {
      // A run sealed before the probe protocol carries nothing this falsifier
      // can measure; it is named beside the result, not silently dropped.
      excluded.push({ campaign, runId: evidence.runId, reason: "no-scoreable-questions" });
      continue;
    }
    const sessionPath = sessionFile(runDir);
    const entries = readJsonl(sessionPath);
    const requests = readJsonl(join(runDir, "provider-requests.jsonl"));
    const lastRequest = requests.filter((request) =>
      request?.kind === "provider-request" && request.leafId).at(-1);
    assertRank(lastRequest, `${evidence.runId} has no provider request with a leaf`);
    try {
      // State loadability is probed once at the run's last request; a runtime
      // refusal excludes the whole run by name. Every later failure is a
      // defect in this instrument and propagates instead of thinning coverage.
      loadRunState({
        runtime, attribution, identity, entries,
        sessionId: basename(sessionPath).replace(/\.jsonl$/, "").split("_").at(-1),
        leafId: lastRequest.leafId,
        providerInputBudget: config.providerInputBudget,
      });
    } catch (error) {
      excluded.push({
        campaign,
        runId: evidence.runId,
        reason: "state-unreadable",
        error: String(error?.message ?? error),
      });
      continue;
    }
    included.push(runQueries({
      runtime, attribution, identity, experiment, campaign, runDir,
      plan, runConfig: config, evidence,
    }));
  }
  const queryRows = included.flatMap((run) => run.queryRows);
  const summary = summarizeRetrievalRankQueries(queryRows);
  const decision = retrievalRankVerdict(summary);
  const stable = {
    protocolVersion: RETRIEVAL_RANK_PROTOCOL_VERSION,
    experiment: "offline rank-only complete-evidence BM25 falsifier",
    opsRootSha256: sha256(resolve(opsRoot)),
    scorer: {
      id: RETRIEVAL_RANK_SCORER_ID,
      version: RETRIEVAL_RANK_PROTOCOL_VERSION,
      candidateSource: "eligible collapsed folds at the first provider request after question delivery",
      querySource: "one exact withheld question isolated from its delivered block",
      labels: "exact transcript-only answer bytes joined after scoring",
      purpose: "falsify or promote rank-only BM25 shortlisting over complete fold evidence",
      documentSource: "complete projection text of every fold ref through the attribution lens: text parts, tool call names, and tool call arguments, unsliced",
      k1: RETRIEVAL_SHADOW_BM25_K1,
      b: RETRIEVAL_SHADOW_BM25_B,
      thresholds: 0,
      providerCalls: 0,
      carrierMessages: 0,
      runtimeMutations: 0,
    },
    criteria: {
      minimumNeededQuestions: RETRIEVAL_RANK_MINIMUM_NEEDED_QUESTIONS,
      promote: {
        recallAt5: RETRIEVAL_RANK_PROMOTE_RECALL_AT_5,
        recallAt1: RETRIEVAL_RANK_PROMOTE_RECALL_AT_1,
      },
      kill: {
        recallAt5Below: RETRIEVAL_RANK_KILL_RECALL_AT_5,
        newestFirstMarginBelow: RETRIEVAL_RANK_KILL_NEWEST_FIRST_MARGIN,
      },
      conflictRule: "kill is evaluated before promote; no threshold may rescue failure",
    },
    corpus: {
      runsIncluded: included.map((run) => ({
        runId: run.runId, campaign: run.campaign, planVersion: run.planVersion,
        queryCount: run.queryCount,
      })),
      runsExcluded: excluded,
    },
    source: {
      scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      bm25Sha256: sha256(readFileSync(
        join(PROJECT, "scripts", "probe_retrieval_shadow.mjs"))),
      runtimeSha256: sha256(readFileSync(join(PROJECT, "extensions", "active-context.ts"))),
      attributionSha256: sha256(readFileSync(
        join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs"))),
    },
    limitations: [
      "Needed questions from repetitions of one campaign share that campaign's plan and are not fully independent samples.",
      "Candidate relevance is exact answer-byte containment, not a human semantic-relevance judgment.",
      "Only folded-context retrieval is scored; active-context mark nomination is outside this build.",
      "Runs whose sealed state the current runtime refuses to load are excluded by name; exclusion follows state schema age, not scorer outcome.",
      "Rank quality does not measure uptake: no suggestion carrier is emitted.",
    ],
    summary,
    verdict: decision,
    runs: included,
  };
  return {
    ...stable,
    evidenceSha256: jsonSha256(stable),
  };
}

function parseCli(argv) {
  let opsRoot = DEFAULT_OPS_ROOT;
  let output = null;
  let help = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--ops=")) opsRoot = argument.slice("--ops=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else assertRank(false, `unknown argument: ${argument}`);
  }
  return { opsRoot, output, help };
}

async function main() {
  const { opsRoot, output, help } = parseCli(process.argv.slice(2));
  if (help) {
    process.stdout.write([
      "probe_retrieval_rank.mjs - offline rank-only complete-evidence BM25 falsifier",
      "",
      "Sweeps every sealed pifold run under the ops root, scores complete fold",
      "documents with rank-only BM25 at each question's answering request, and",
      "applies the pre-registered promote and kill criteria. Makes no provider",
      "or network calls and changes no runtime behavior.",
      "",
      "  --ops=DIR      campaign ops root (default: the local pi-fold-runs tree)",
      "  --output=FILE  write the full report under lab/retrieval-rank/",
      "",
    ].join("\n"));
    return;
  }
  const report = await runRetrievalRankSweep(opsRoot);
  if (output) {
    const resolved = assertOutputPath(output);
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      output: resolved,
      evidenceSha256: report.evidenceSha256,
      corpus: report.corpus,
      summary: report.summary,
      verdict: report.verdict,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Retrieval rank falsifier failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
