// The replay protocol: facts planted into a replayed transcript at known depths, asked
// once at the end, graded by exact token match.
//
// WHAT THIS FIXES. steer rep2 crossed its trigger exactly once, and native scored 30 of 31
// because nothing ever forced it to look back: every fact it needed was either in the
// compaction summary or sitting on disk in the config file it could re-read. A ceiling
// that high cannot show an improvement. Here a fact is a token that exists nowhere except
// the one sentence that stated it, several boundaries back, and the only way to answer is
// to still hold it.
//
// DEPTH IS THE MEASUREMENT, not pass or fail. Each fact records how many boundaries
// happened after it was planted, so the result is a curve of recall against distance
// rather than a single score. An arm that holds everything for one boundary and nothing
// for four is a different system from one that decays gently, and a single number hides
// exactly that.
import {
  ledgerTokens, plantedWordCollisions, seededShuffle, assertExperiment,
} from "./pi_context_experiment.mjs";

export const REPLAY_PROTOCOL = "replay/v1";

// Facts are stated in the voice of the work around them. Nothing here tells the model a
// value matters, asks it to hold one, or reads as instrumentation: gate 62's rule is that
// the only surface the agent sees must look like ordinary conversation, and an injected
// turn is a surface. The acknowledgement is what a person would have gotten back.
export const REPLAY_FACT_KINDS = Object.freeze([
  Object.freeze({
    id: "build-tag",
    state: (value) => `the build tag for this run is ${value}.`,
    ack: (value) => `Got it, tagging the build ${value}.`,
    ask: "the build tag for the run",
  }),
  Object.freeze({
    id: "ticket",
    state: (value) => `this work is tracked under ${value}, in case it comes up.`,
    ack: (value) => `Noted, ${value} is the tracking id.`,
    ask: "the tracking id the work sits under",
  }),
  Object.freeze({
    id: "bucket",
    state: (value) => `artifacts from this go to the ${value} bucket.`,
    ack: (value) => `Understood, artifacts to ${value}.`,
    ask: "the bucket artifacts go to",
  }),
  Object.freeze({
    id: "baseline",
    state: (value) => `the baseline revision we're comparing against is ${value}.`,
    ack: (value) => `Right, baseline is ${value}.`,
    ask: "the baseline revision being compared against",
  }),
  Object.freeze({
    id: "owner",
    state: (value) => `${value} is the on-call owner for this service this week.`,
    ack: (value) => `Noted, ${value} owns it this week.`,
    ask: "who was on call for the service",
  }),
  Object.freeze({
    id: "endpoint",
    state: (value) => `the staging endpoint for this is ${value}.`,
    ack: (value) => `Got it, staging endpoint ${value}.`,
    ask: "the staging endpoint",
  }),
]);

/**
 * One fact per segment, cycling the kinds so no two adjacent facts share a phrasing. The
 * value comes from the frozen content seed, so a campaign is reproducible from its seed
 * alone and the plan carries no value a run could read.
 */
export function buildReplayFacts({ contentSeed, segments }) {
  assertExperiment(Number.isSafeInteger(segments) && segments >= 2,
    "A replay needs at least two segments to put a boundary between plant and question");
  const values = ledgerTokens(contentSeed, segments);
  return values.map((value, index) => {
    const kind = REPLAY_FACT_KINDS[index % REPLAY_FACT_KINDS.length];
    return { id: `fact-${String(index + 1).padStart(2, "0")}`, kind: kind.id, segment: index, value };
  });
}

export function factStatement(fact) {
  const kind = REPLAY_FACT_KINDS.find((item) => item.id === fact.kind);
  assertExperiment(kind, `Unknown replay fact kind ${fact.kind}`);
  return kind.state(fact.value);
}

export function factAcknowledgement(fact) {
  const kind = REPLAY_FACT_KINDS.find((item) => item.id === fact.kind);
  assertExperiment(kind, `Unknown replay fact kind ${fact.kind}`);
  return kind.ack(fact.value);
}

/**
 * The one question, asked once, after every segment has been replayed. Order is shuffled
 * by the QUERY seed rather than the content seed, so what was planted and what order it is
 * asked in cannot be derived from one another. Byte-identical across arms by construction.
 */
export function endBlockPromptFor(facts, querySeed) {
  const asked = seededShuffle(facts, `${querySeed}:replay-order`);
  const lines = asked.map((fact, index) => {
    const kind = REPLAY_FACT_KINDS.find((item) => item.id === fact.kind);
    return `${index + 1}. ${kind.ask}`;
  });
  return [
    "before I hand this off, read back a few things from earlier in this session:",
    "",
    ...lines,
    "",
    `answer with one numbered line each, the value only. if you do not have one, write "${REPLAY_UNKNOWN}" for that line rather than guessing.`,
  ].join("\n");
}

export const REPLAY_UNKNOWN = "unknown";

/**
 * Grades an answer by exact token match. Absolute and parseable, which is the whole reason
 * the values are opaque tokens: there is no judgement call and no model in the loop.
 * `wrong` and `absent` are kept apart because a confident wrong answer and an honest
 * abstention are different failures and only one of them is dangerous.
 */
export function gradeReplayAnswer({ facts, querySeed, answer }) {
  const asked = seededShuffle(facts, `${querySeed}:replay-order`);
  const text = String(answer ?? "");
  const lines = text.split("\n");
  const results = asked.map((fact, index) => {
    const numbered = lines.find((line) => new RegExp(`^\\s*${index + 1}\\s*[.)]`).test(line)) ?? "";
    const found = numbered.match(/lv-[0-9a-f]{6}/)?.[0] ?? null;
    const abstained = /\bunknown\b/i.test(numbered) && found === null;
    return {
      id: fact.id,
      kind: fact.kind,
      segment: fact.segment,
      askedAs: index + 1,
      expected: fact.value,
      answered: found,
      verdict: found === fact.value ? "correct" : abstained ? "absent" : found ? "wrong" : "absent",
    };
  });
  return {
    correct: results.filter((row) => row.verdict === "correct").length,
    wrong: results.filter((row) => row.verdict === "wrong").length,
    absent: results.filter((row) => row.verdict === "absent").length,
    results,
  };
}

/**
 * Refuses a corpus that already contains a value we are about to plant. Without this a
 * fact could be answered from unrelated replayed text, and the run would score recall it
 * never tested.
 */
export function assertNoCorpusCollision(facts, corpusText) {
  const planted = new Set(facts.map((fact) => fact.value));
  const hits = plantedWordCollisions(corpusText, planted);
  assertExperiment(hits.length === 0,
    `Replay corpus already contains planted values: ${[...new Set(hits)].join(", ")}`);
  return true;
}
