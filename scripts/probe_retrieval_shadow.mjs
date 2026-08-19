#!/usr/bin/env node

// Offline, experiment-only retrieval scoring over sealed pi-fold sessions.
//
// The scorer sees only a question, fold briefs, and the deleted selector's
// historically bounded fold content. Exact answers are joined afterward as
// labels. Nothing is surfaced to a model, no provider is called, and no shipped
// runtime option or folding behavior changes.

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

export const RETRIEVAL_SHADOW_PROTOCOL_VERSION = 1;
export const RETRIEVAL_SHADOW_SCORER_ID = "bm25-content-brief-v1";
export const RETRIEVAL_SHADOW_CONTENT_CHARS = 20_000;
export const RETRIEVAL_SHADOW_BM25_K1 = 1.5;
export const RETRIEVAL_SHADOW_BM25_B = 0.75;
export const RETRIEVAL_SHADOW_DEPLOYED_CONTENT_HIT = 0.25;
export const RETRIEVAL_SHADOW_DEPLOYED_BRIEF_HIT = 0.15;
export const RETRIEVAL_SHADOW_DEPLOYED_MARGIN = 0.10;

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUTPUT_ROOT = join(PROJECT, "lab", "retrieval-shadow");
const HARNESS_JSONL = new Set([
  "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
  "tool-results.jsonl", "worker-events.jsonl",
]);

const STOPWORDS = new Set([
  "about", "after", "again", "against", "already", "also", "another", "because", "been",
  "before", "being", "between", "both", "came", "come", "could", "does", "doing", "done",
  "down", "during", "each", "either", "else", "even", "ever", "every", "exact", "exactly",
  "first", "from", "have", "having", "here", "into", "just", "keep", "kept", "like", "made",
  "make", "many", "more", "most", "much", "must", "need", "next", "none", "only", "other",
  "over", "same", "should", "since", "some", "such", "take", "than", "that", "their", "them",
  "then", "there", "these", "they", "this", "those", "through", "under", "until", "upon",
  "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "would",
  "your",
]);

function assertShadow(condition, message) {
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

export function retrievalShadowTokens(value) {
  const tokens = [];
  for (const raw of String(value ?? "").toLowerCase().split(/[^a-z0-9_]+/)) {
    const token = raw.replace(/^_+|_+$/g, "");
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function buildRetrievalShadowIndex(documents) {
  const indexed = new Map();
  const documentFrequency = new Map();
  let totalLength = 0;
  for (const document of documents) {
    assertShadow(typeof document?.key === "string" && document.key,
      "retrieval shadow document needs a key");
    const frequencies = new Map();
    for (const token of document.tokens ?? []) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    indexed.set(document.key, { length: (document.tokens ?? []).length, frequencies });
    totalLength += (document.tokens ?? []).length;
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return {
    documents: indexed,
    documentFrequency,
    count: documents.length,
    averageLength: documents.length ? totalLength / documents.length : 0,
  };
}

export function retrievalShadowIdf(index, term) {
  const frequency = index.documentFrequency.get(term) ?? 0;
  if (!frequency) return 0;
  return Math.log(1 + (index.count - frequency + 0.5) / (frequency + 0.5));
}

export function retrievalShadowRawBm25(index, key, queryTerms) {
  const document = index.documents.get(key);
  if (!document || !document.length) return 0;
  let score = 0;
  for (const term of queryTerms) {
    const frequency = document.frequencies.get(term);
    if (!frequency) continue;
    const denominator = frequency + RETRIEVAL_SHADOW_BM25_K1 *
      (1 - RETRIEVAL_SHADOW_BM25_B +
        RETRIEVAL_SHADOW_BM25_B * (document.length / (index.averageLength || 1)));
    score += retrievalShadowIdf(index, term) *
      ((frequency * (RETRIEVAL_SHADOW_BM25_K1 + 1)) / denominator);
  }
  return score;
}

function roundedUnitScore(value) {
  return Math.round(Math.max(0, Math.min(1, value)) * 10_000) / 10_000;
}

function documentKey(channel, id) {
  return `${channel}::${id}`;
}

// Labels are intentionally absent from this interface. Callers may carry any
// additional metadata on a candidate, but only id, brief, and scoredContent
// enter the index or score.
export function scoreRetrievalShadowCandidates({ query, candidates }) {
  assertShadow(typeof query === "string" && query.trim(), "retrieval shadow needs a query");
  assertShadow(Array.isArray(candidates), "retrieval shadow candidates must be an array");
  const ids = candidates.map((candidate) => candidate?.id);
  assertShadow(ids.every((id) => typeof id === "string" && id),
    "every retrieval shadow candidate needs an id");
  assertShadow(new Set(ids).size === ids.length, "retrieval shadow candidate ids must be unique");
  const documents = candidates.flatMap((candidate) => [
    {
      key: documentKey("brief", candidate.id),
      tokens: retrievalShadowTokens(candidate.brief),
    },
    {
      key: documentKey("content", candidate.id),
      tokens: retrievalShadowTokens(candidate.scoredContent),
    },
  ]);
  const index = buildRetrievalShadowIndex(documents);
  const queryTerms = new Set(retrievalShadowTokens(query));
  const documentFrequency = [...index.documentFrequency.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  let ceiling = 0;
  for (const term of queryTerms) {
    ceiling += retrievalShadowIdf(index, term) * (RETRIEVAL_SHADOW_BM25_K1 + 1);
  }
  const rows = candidates.map((candidate) => {
    const rawContentScore = retrievalShadowRawBm25(
      index, documentKey("content", candidate.id), queryTerms);
    const rawBriefScore = retrievalShadowRawBm25(
      index, documentKey("brief", candidate.id), queryTerms);
    const contentScore = ceiling > 0 ? roundedUnitScore(rawContentScore / ceiling) : 0;
    const briefScore = ceiling > 0 ? roundedUnitScore(rawBriefScore / ceiling) : 0;
    return {
      id: candidate.id,
      rawContentScore,
      rawBriefScore,
      contentScore,
      briefScore,
      margin: roundedUnitScore(contentScore - briefScore),
    };
  });
  const rawContentOrder = [...rows].sort((left, right) =>
    right.rawContentScore - left.rawContentScore || left.id.localeCompare(right.id));
  const contentOrder = [...rows].sort((left, right) =>
    right.contentScore - left.contentScore || left.id.localeCompare(right.id));
  const briefOrder = [...rows].sort((left, right) =>
    right.rawBriefScore - left.rawBriefScore || left.id.localeCompare(right.id));
  const marginOrder = [...rows].sort((left, right) =>
    right.margin - left.margin || right.contentScore - left.contentScore ||
    left.id.localeCompare(right.id));
  const rawContentRank = new Map(rawContentOrder.map((row, index) => [row.id, index + 1]));
  const contentRank = new Map(contentOrder.map((row, index) => [row.id, index + 1]));
  const briefRank = new Map(briefOrder.map((row, index) => [row.id, index + 1]));
  const marginRank = new Map(marginOrder.map((row, index) => [row.id, index + 1]));
  return {
    scorer: {
      id: RETRIEVAL_SHADOW_SCORER_ID,
      version: RETRIEVAL_SHADOW_PROTOCOL_VERSION,
      direction: "higher-is-more-relevant",
      normalization: "raw BM25 divided by the query IDF ceiling and clamped to [0,1]",
      k1: RETRIEVAL_SHADOW_BM25_K1,
      b: RETRIEVAL_SHADOW_BM25_B,
    },
    corpus: {
      documents: index.count,
      averageTokens: index.averageLength,
      vocabularyTerms: documentFrequency.length,
      documentFrequencySha256: jsonSha256(documentFrequency),
    },
    queryTerms: [...queryTerms].sort(),
    ceiling,
    rows: rows.map((row) => ({
      ...row,
      rawContentRank: rawContentRank.get(row.id),
      contentRank: contentRank.get(row.id),
      briefRank: briefRank.get(row.id),
      marginRank: marginRank.get(row.id),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function bestClassification(readings) {
  const rank = { "visible-raw": 0, "visible-brief": 1, recoverable: 2, absent: 3 };
  return [...readings].sort((left, right) =>
    (rank[left.classification] ?? 4) - (rank[right.classification] ?? 4))[0];
}

function scoreDecision(query, ranking, threshold) {
  const ordered = [...query.candidates].sort((left, right) =>
    left[`${ranking}Rank`] - right[`${ranking}Rank`]);
  const selected = ordered[0] ?? null;
  const scoreField = ranking === "content" ? "contentScore" : "margin";
  if (!selected || selected[scoreField] < threshold) return null;
  return selected;
}

function decisionMetrics(queries, ranking, threshold) {
  const needed = queries.filter((query) => query.retrievalNeeded).length;
  let offers = 0;
  let usefulOffers = 0;
  let relevantOffers = 0;
  let unneededOffers = 0;
  let wrongCandidateOffers = 0;
  for (const query of queries) {
    const selected = scoreDecision(query, ranking, threshold);
    if (!selected) continue;
    offers += 1;
    if (selected.relevant) relevantOffers += 1;
    else wrongCandidateOffers += 1;
    if (!query.retrievalNeeded) unneededOffers += 1;
    if (query.retrievalNeeded && selected.relevant) usefulOffers += 1;
  }
  const precision = offers ? usefulOffers / offers : null;
  const recall = needed ? usefulOffers / needed : null;
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null : (2 * precision * recall) / (precision + recall);
  return {
    threshold,
    offers,
    usefulOffers,
    relevantOffers,
    unneededOffers,
    wrongCandidateOffers,
    neededQueries: needed,
    precision,
    recall,
    f1,
  };
}

function thresholdSweep(queries, ranking) {
  const points = Array.from({ length: 101 }, (_, index) =>
    decisionMetrics(queries, ranking, index / 100));
  const nonempty = points.filter((point) => point.offers > 0);
  const bestF1 = [...nonempty].filter((point) => point.f1 !== null)
    .sort((left, right) => right.f1 - left.f1 || right.threshold - left.threshold)[0] ?? null;
  const atPrecision = (minimum) => [...nonempty]
    .filter((point) => point.precision !== null && point.precision >= minimum)
    .sort((left, right) => right.recall - left.recall ||
      right.precision - left.precision || right.threshold - left.threshold)[0] ?? null;
  return {
    ranking,
    score: ranking === "content" ? "normalized content BM25" : "content-minus-brief margin",
    descriptiveOnly: true,
    bestF1,
    precisionAtLeast50: atPrecision(0.5),
    precisionAtLeast75: atPrecision(0.75),
    precisionAtLeast90: atPrecision(0.9),
    points,
  };
}

function rankingMetrics(queries, rankField, predicate = () => true) {
  const evaluable = queries.filter((query) =>
    predicate(query) && query.candidates.some((candidate) => candidate.relevant));
  const bestRanks = evaluable.map((query) => Math.min(...query.candidates
    .filter((candidate) => candidate.relevant).map((candidate) => candidate[rankField])));
  return {
    queries: evaluable.length,
    hitAt1: bestRanks.filter((rank) => rank <= 1).length,
    hitAt3: bestRanks.filter((rank) => rank <= 3).length,
    hitAt5: bestRanks.filter((rank) => rank <= 5).length,
    meanReciprocalRank: bestRanks.length
      ? bestRanks.reduce((total, rank) => total + 1 / rank, 0) / bestRanks.length : null,
    medianBestRank: bestRanks.length
      ? [...bestRanks].sort((a, b) => a - b)[Math.floor((bestRanks.length - 1) / 2)] : null,
  };
}

export function summarizeRetrievalShadowQueries(queries) {
  assertShadow(Array.isArray(queries), "retrieval shadow summary needs query rows");
  const candidateRows = queries.reduce((total, query) => total + query.candidates.length, 0);
  const relevantCandidateRows = queries.reduce((total, query) => total +
    query.candidates.filter((candidate) => candidate.relevant).length, 0);
  const relevantOutsideScoringCap = queries.reduce((total, query) => total +
    query.candidates.filter((candidate) => candidate.relevant && !candidate.labelInScoredContent).length, 0);
  const evaluable = queries.filter((query) =>
    query.candidates.some((candidate) => candidate.relevant));
  const relevantInScoringCap = (query) => query.candidates.some((candidate) =>
    candidate.relevant && candidate.labelInScoredContent);
  const neededEvaluable = evaluable.filter((query) => query.retrievalNeeded);
  const deployed = queries.map((query) => {
    const selected = [...query.candidates].filter((candidate) =>
      candidate.contentScore >= RETRIEVAL_SHADOW_DEPLOYED_CONTENT_HIT &&
      candidate.briefScore < RETRIEVAL_SHADOW_DEPLOYED_BRIEF_HIT &&
      candidate.margin >= RETRIEVAL_SHADOW_DEPLOYED_MARGIN)
      .sort((left, right) => right.margin - left.margin ||
        right.contentScore - left.contentScore || left.id.localeCompare(right.id))[0] ?? null;
    return { query, selected };
  });
  const deployedOffers = deployed.filter((row) => row.selected);
  const deployedUseful = deployedOffers.filter((row) =>
    row.query.retrievalNeeded && row.selected.relevant).length;
  return {
    queries: queries.length,
    queryKinds: Object.fromEntries([...new Set(queries.map((query) => query.kind))].sort()
      .map((kind) => [kind, queries.filter((query) => query.kind === kind).length])),
    carriage: Object.fromEntries([...new Set(queries.map((query) => query.carriage))].sort()
      .map((value) => [value, queries.filter((query) => query.carriage === value).length])),
    retrievalNeededQueries: queries.filter((query) => query.retrievalNeeded).length,
    queriesWithRelevantCandidate: queries.filter((query) =>
      query.candidates.some((candidate) => candidate.relevant)).length,
    candidateRows,
    relevantCandidateRows,
    relevantOutsideScoringCap,
    scoringCapCoverage: {
      evaluableQueries: evaluable.length,
      queriesWithRelevantCarrierInCap: evaluable.filter(relevantInScoringCap).length,
      queriesWithEveryRelevantCarrierOutsideCap:
        evaluable.filter((query) => !relevantInScoringCap(query)).length,
      retrievalNeededQueries: neededEvaluable.length,
      retrievalNeededWithRelevantCarrierInCap:
        neededEvaluable.filter(relevantInScoringCap).length,
      retrievalNeededWithEveryRelevantCarrierOutsideCap:
        neededEvaluable.filter((query) => !relevantInScoringCap(query)).length,
    },
    ranking: {
      rawContentAll: rankingMetrics(queries, "rawContentRank"),
      rawContentWhenNeeded: rankingMetrics(queries, "rawContentRank", (query) => query.retrievalNeeded),
      contentAll: rankingMetrics(queries, "contentRank"),
      contentWhenNeeded: rankingMetrics(queries, "contentRank", (query) => query.retrievalNeeded),
      briefAll: rankingMetrics(queries, "briefRank"),
      briefWhenNeeded: rankingMetrics(queries, "briefRank", (query) => query.retrievalNeeded),
      marginAll: rankingMetrics(queries, "marginRank"),
      marginWhenNeeded: rankingMetrics(queries, "marginRank", (query) => query.retrievalNeeded),
      newestAll: rankingMetrics(queries, "newestRank"),
      newestWhenNeeded: rankingMetrics(queries, "newestRank", (query) => query.retrievalNeeded),
    },
    deployedScoreGateCounterfactual: {
      queryDefinition: "isolated exact question, not the historical multi-question intent tail",
      suppressionAndCarrierExcluded: true,
      contentHit: RETRIEVAL_SHADOW_DEPLOYED_CONTENT_HIT,
      briefHit: RETRIEVAL_SHADOW_DEPLOYED_BRIEF_HIT,
      margin: RETRIEVAL_SHADOW_DEPLOYED_MARGIN,
      offers: deployedOffers.length,
      usefulOffers: deployedUseful,
      precision: deployedOffers.length ? deployedUseful / deployedOffers.length : null,
      recall: queries.some((query) => query.retrievalNeeded)
        ? deployedUseful / queries.filter((query) => query.retrievalNeeded).length : null,
    },
    thresholdSweeps: {
      content: thresholdSweep(queries, "content"),
      margin: thresholdSweep(queries, "margin"),
    },
    interpretation: "descriptive paired-corpus result; thresholds are not promoted on this corpus",
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
    assertShadow(traceRow, `${query.id} has a numeric answer without an attributable trace row`);
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
    if (seen.has(id)) throw new Error(`retrieval shadow branch cycles at ${id}`);
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
  assertShadow(names.length === 1, `${basename(runDir)} has ${names.length} session files`);
  return join(runDir, names[0]);
}

function foldContent(runtime, fold, state, snapshot) {
  const pieces = [];
  for (const ref of runtime.flattenFoldRefs(fold, state)) {
    const item = runtime.exactMapped(snapshot, ref);
    if (!item) continue;
    const text = runtime.contentText(item.message).trim();
    if (text) pieces.push(text);
  }
  return pieces.join("\n");
}

function retrievalCandidates(runtime, state, snapshot) {
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
      const fullContent = foldContent(runtime, fold, state, snapshot);
      if (!fullContent) return [];
      const scoredContent = fullContent.slice(0, RETRIEVAL_SHADOW_CONTENT_CHARS);
      const brief = String(runtime.foldBrief(fold, state) ?? "");
      return [{
        id: fold.id,
        kind: fold.kind,
        parentId: fold.parentId,
        depth: runtime.foldDepth(state, fold),
        position: interval.end,
        sourceCount: refs.length,
        brief,
        fullContent,
        scoredContent,
      }];
    });
}

function stateView({ runtime, attribution, identity, entries, sessionId, leafId, providerInputBudget }) {
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
    ...attribution.projectionCarriers({ runtime, state, snapshot }),
  };
}

function labelQuery({ attribution, view, needles, candidates, scored }) {
  const carriageReadings = needles.map((needle) =>
    attribution.classifyFactCarriage(view, needle));
  const carriage = bestClassification(carriageReadings)?.classification ?? "absent";
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const newestRank = new Map([...candidates].sort((left, right) =>
    right.position - left.position || left.id.localeCompare(right.id))
    .map((candidate, index) => [candidate.id, index + 1]));
  return {
    carriage,
    retrievalNeeded: carriage === "recoverable",
    candidates: scored.rows.map((score) => {
      const candidate = byId.get(score.id);
      assertShadow(candidate, `score names missing candidate ${score.id}`);
      const relevant = needles.some((needle) => candidate.fullContent.includes(needle));
      return {
        ...score,
        kind: candidate.kind,
        parentId: candidate.parentId,
        depth: candidate.depth,
        position: candidate.position,
        newestRank: newestRank.get(candidate.id),
        sourceCount: candidate.sourceCount,
        briefChars: candidate.brief.length,
        fullContentChars: candidate.fullContent.length,
        scoredContentChars: candidate.scoredContent.length,
        contentTruncated: candidate.fullContent.length > candidate.scoredContent.length,
        briefSha256: sha256(candidate.brief),
        fullContentSha256: sha256(candidate.fullContent),
        scoredContentSha256: sha256(candidate.scoredContent),
        relevant,
        labelInBrief: needles.some((needle) => candidate.brief.includes(needle)),
        labelInScoredContent: needles.some((needle) => candidate.scoredContent.includes(needle)),
      };
    }),
  };
}

function runQueries({
  runtime, attribution, identity, experiment, runDir, plan, runConfig, evidence,
}) {
  const sessionPath = sessionFile(runDir);
  const sessionName = basename(sessionPath);
  const sessionId = sessionName.replace(/\.jsonl$/, "").split("_").at(-1);
  const entries = readJsonl(sessionPath);
  const requests = readJsonl(join(runDir, "provider-requests.jsonl"));
  const probes = collectProbes(plan);
  const querySpecs = [];
  for (const verdict of evidence.probeVerdicts ?? []) {
    const probe = probes.get(verdict.probeId);
    assertShadow(probe, `${evidence.runId} plan has no ${verdict.probeId}`);
    if (probe.kind === "derivation-control") continue;
    querySpecs.push({
      id: probe.id ?? probe.probeId,
      kind: `ordinary:${probe.kind}`,
      question: probe.question,
      expectedAnswer: probe.expectedAnswer,
      answerVerdict: verdict.verdict,
      deliveryMatch: `${verdict.probeId}:`,
      deliveryRole: "toolResult",
    });
  }
  const endQuestions = experiment.endBlockQuestions(plan.ledger, runConfig.querySeed)
    .filter((query) => query.kind !== "table");
  const endVerdicts = new Map((evidence.endBlock?.rows ?? []).map((row) => [row.id, row]));
  for (const query of endQuestions) {
    const verdict = endVerdicts.get(query.id) ?? null;
    querySpecs.push({
      id: query.id,
      kind: `end-block:${query.kind}`,
      question: query.question,
      expectedAnswer: query.expectedAnswer,
      answerVerdict: query.kind === "checksum" ? verdict?.verdict ?? null
        : verdict?.recallOfRecord === true ? "recall-of-record"
          : verdict?.recallOfRecord === false ? "not-own-record" : null,
      deliveryMatch: "Before we close out the assignment",
      deliveryRole: "user",
    });
  }
  const stateCache = new Map();
  const rows = [];
  for (const spec of querySpecs) {
    const delivery = entries.find((entry) => entry?.type === "message" &&
      entry.message?.role === spec.deliveryRole &&
      messageEntryText(attribution, entry).includes(spec.deliveryMatch));
    assertShadow(delivery, `${evidence.runId}/${spec.id} has no delivery entry`);
    const request = firstProviderRequestAfter(entries, requests, delivery.id);
    assertShadow(request, `${evidence.runId}/${spec.id} has no first provider request`);
    let cached = stateCache.get(request.leafId);
    if (!cached) {
      const view = stateView({
        runtime, attribution, identity, entries, sessionId, leafId: request.leafId,
        providerInputBudget: runConfig.providerInputBudget,
      });
      cached = { view, candidates: retrievalCandidates(runtime, view.state, view.snapshot) };
      stateCache.set(request.leafId, cached);
    }
    const needles = queryNeedles(spec);
    assertShadow(needles.every((needle) => !spec.question.includes(needle)),
      `${evidence.runId}/${spec.id} leaks its answer into the scorer query`);
    const scored = scoreRetrievalShadowCandidates({
      query: spec.question,
      candidates: cached.candidates,
    });
    const labeled = labelQuery({
      attribution, view: cached.view, needles, candidates: cached.candidates, scored,
    });
    rows.push({
      runId: evidence.runId,
      repetition: evidence.repetition,
      queryId: spec.id,
      kind: spec.kind,
      questionSha256: sha256(spec.question),
      questionChars: spec.question.length,
      answerNeedleSha256: needles.map(sha256),
      answerVerdict: spec.answerVerdict,
      deliveryEntryId: delivery.id,
      firstRequestOrdinal: request.ordinal,
      firstRequestLeafId: request.leafId,
      stateRevision: cached.view.state.revision,
      queryTerms: scored.queryTerms,
      scoreCeiling: scored.ceiling,
      scoreCorpus: scored.corpus,
      carriage: labeled.carriage,
      retrievalNeeded: labeled.retrievalNeeded,
      candidateCount: labeled.candidates.length,
      candidates: labeled.candidates,
    });
  }
  return {
    runId: evidence.runId,
    repetition: evidence.repetition,
    codeCommit: evidence.codeCommit ?? null,
    sessionSha256: sha256(readFileSync(sessionPath)),
    providerRequestsSha256: sha256(readFileSync(join(runDir, "provider-requests.jsonl"))),
    queryCount: rows.length,
    queryRows: rows,
  };
}

function eligibleRunDirs(campaignDir) {
  const runsDir = join(campaignDir, "runs");
  assertShadow(existsSync(runsDir), `campaign has no runs directory: ${campaignDir}`);
  return readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .map((entry) => join(runsDir, entry.name)).filter((runDir) => {
      const evidencePath = join(runDir, "experiment-evidence.json");
      const configPath = join(runDir, "run-config.json");
      if (!existsSync(evidencePath) || !existsSync(configPath)) return false;
      const evidence = readJson(evidencePath);
      const config = readJson(configPath);
      return evidence.arm === "pifold" && evidence.endBlock?.delivered === true &&
        config.arm === "pifold";
    }).sort();
}

function assertOutputPath(path) {
  const resolved = resolve(path);
  const rel = relative(DEFAULT_OUTPUT_ROOT, resolved);
  assertShadow(rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)),
    `retrieval shadow output must stay under ${DEFAULT_OUTPUT_ROOT}`);
  return resolved;
}

export async function runRetrievalShadowCampaign(campaignDir) {
  const resolvedCampaign = resolve(campaignDir);
  const runDirs = eligibleRunDirs(resolvedCampaign);
  assertShadow(runDirs.length >= 2,
    `retrieval shadow requires at least two completed pifold runs, found ${runDirs.length}`);
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const runtime = await jiti.import(join(PROJECT, "extensions", "active-context.ts"));
  const attribution = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
  const identity = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const experiment = await import(pathToFileURL(
    join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));
  const runs = [];
  let commonPlanSha256 = null;
  let commonPlanFileSha256 = null;
  let commonPlanPath = null;
  for (const runDir of runDirs) {
    const evidence = readJson(join(runDir, "experiment-evidence.json"));
    const runConfig = readJson(join(runDir, "run-config.json"));
    const planPath = resolve(runConfig.planPath);
    const planBytes = readFileSync(planPath);
    const plan = JSON.parse(planBytes);
    const planSha256 = experiment.stagePlanSha256(plan);
    const planFileSha256 = sha256(planBytes);
    assertShadow(planSha256 === runConfig.planSha256,
      `${evidence.runId} plan hash does not match run config`);
    if (commonPlanSha256 === null) {
      commonPlanSha256 = planSha256;
      commonPlanFileSha256 = planFileSha256;
      commonPlanPath = planPath;
    } else {
      assertShadow(planSha256 === commonPlanSha256,
        `${evidence.runId} does not share the campaign plan`);
      assertShadow(planFileSha256 === commonPlanFileSha256,
        `${evidence.runId} does not share the same plan file bytes`);
    }
    assertShadow(plan.version === 4, `${evidence.runId} is not a protocol-v4 hidden-mass plan`);
    runs.push(runQueries({
      runtime, attribution, identity, experiment, runDir, plan, runConfig, evidence,
    }));
  }
  const queryRows = runs.flatMap((run) => run.queryRows);
  const stable = {
    protocolVersion: RETRIEVAL_SHADOW_PROTOCOL_VERSION,
    experiment: "offline full-candidate retrieval shadow",
    campaignLabel: basename(resolvedCampaign),
    campaignPathSha256: sha256(resolvedCampaign),
    planSha256: commonPlanSha256,
    planFileSha256: commonPlanFileSha256,
    planPathSha256: sha256(commonPlanPath),
    scorer: {
      id: RETRIEVAL_SHADOW_SCORER_ID,
      version: RETRIEVAL_SHADOW_PROTOCOL_VERSION,
      candidateSource: "eligible collapsed folds at the first provider request after question delivery",
      querySource: "one exact withheld question isolated from its delivered multi-question block",
      labels: "exact transcript-only answer bytes joined after scoring",
      purpose: "reconstruct the deleted selector's score geometry before testing a successor",
      contentCharacters: RETRIEVAL_SHADOW_CONTENT_CHARS,
      k1: RETRIEVAL_SHADOW_BM25_K1,
      b: RETRIEVAL_SHADOW_BM25_B,
      providerCalls: 0,
      carrierMessages: 0,
      runtimeMutations: 0,
    },
    source: {
      scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      runtimeSha256: sha256(readFileSync(join(PROJECT, "extensions", "active-context.ts"))),
      attributionSha256: sha256(readFileSync(
        join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs"))),
    },
    limitations: [
      "Both repetitions share one frozen plan and query seed, so threshold sweeps are descriptive, not validation.",
      "Questions are isolated counterfactually; the live workload delivered them in multi-question blocks.",
      "Candidate relevance is exact answer-byte containment, not a human semantic-relevance judgment.",
      "Only folded-context retrieval is scored; active-context mark nomination is outside this build.",
      "The deleted selector's 20,000-character scoring cap is reproduced and measured against full-content relevance; it is not endorsed for a successor.",
      "Historical content extraction uses message text and does not index structured tool-call names or arguments.",
      "The mixed brief-and-content corpus and normalized margin reproduce the deleted policy; their scores are not calibrated probabilities.",
      "No suggestion carrier is emitted, so this experiment measures rank and score geometry, not uptake.",
    ],
    summary: summarizeRetrievalShadowQueries(queryRows),
    runs,
  };
  return {
    ...stable,
    evidenceSha256: jsonSha256(stable),
  };
}

function parseCli(argv) {
  let campaign = null;
  let output = null;
  let help = false;
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--campaign=")) campaign = argument.slice("--campaign=".length);
    else if (argument.startsWith("--output=")) output = argument.slice("--output=".length);
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!help) assertShadow(campaign, "--campaign=<sealed-campaign-dir> is required");
  return { campaign, output, help };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/probe_retrieval_shadow.mjs --campaign=<sealed-campaign-dir> " +
      "[--output=<path-under-lab/retrieval-shadow>]\n" +
      "Scores sealed sessions offline. It makes no provider or network calls.\n");
    return;
  }
  const report = await runRetrievalShadowCampaign(options.campaign);
  if (options.output) {
    const output = assertOutputPath(options.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "w" });
    const compactSweep = (sweep) => ({
      ranking: sweep.ranking,
      score: sweep.score,
      bestF1: sweep.bestF1,
      precisionAtLeast50: sweep.precisionAtLeast50,
      precisionAtLeast75: sweep.precisionAtLeast75,
      precisionAtLeast90: sweep.precisionAtLeast90,
    });
    process.stdout.write(`${JSON.stringify({
      output,
      evidenceSha256: report.evidenceSha256,
      summary: {
        ...report.summary,
        thresholdSweeps: {
          content: compactSweep(report.summary.thresholdSweeps.content),
          margin: compactSweep(report.summary.thresholdSweeps.margin),
        },
      },
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Retrieval shadow probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
