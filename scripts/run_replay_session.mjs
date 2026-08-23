#!/usr/bin/env node
// Drives one replay session: seeds a transcript from the sol corpus, plants a fact before
// each boundary, forces the runtime to shed, and asks for every fact once at the end.
//
//   node scripts/run_replay_session.mjs --arm native|pifold --run-dir <dir> [--segments 5]
//
// THE SESSION IS IN MEMORY, and that is a correctness requirement rather than a
// convenience. A replay asks the model to recall a token from earlier in its own
// transcript, and a persisted transcript is a file `bash` can read: an agent that thought
// to look would score perfectly without holding anything, and looking would be the
// rational move. Nothing on disk inside the run holds a planted value. The corpus does not
// either, because the values are generated from a frozen seed and asserted absent from the
// replayed text before anything starts.
//
// ONE REQUEST PER SEGMENT. Appending messages costs nothing and fires no hook; the
// runtime only sheds when a request is built. So each segment ends with a single cheap
// turn, which is the moment occupancy is measured and the moment a boundary happens.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { PI_INSTALL_ROOT } from "./lib/pi_context_soak_attestation.mjs";
import {
  EXPERIMENT_TRANSPORT, EXPERIMENT_PROVIDER_RETRY, assertExperiment,
  compactionReserveTokens, compactionTriggerShare,
} from "./lib/pi_context_experiment.mjs";
import { loadTrajectories, toPiMessage, trajectoryChars, replayTokens } from "./lib/replay_corpus.mjs";
import {
  REPLAY_PROTOCOL, buildReplayFacts, factStatement, factAcknowledgement,
  endBlockPromptFor, gradeReplayAnswer, assertNoCorpusCollision,
} from "./lib/replay_session.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = PI_INSTALL_ROOT;
const {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));

const argumentValue = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const arm = argumentValue("--arm");
assertExperiment(["native", "pifold"].includes(arm), "Replay needs --arm native or pifold");
const runDir = resolve(argumentValue("--run-dir") ?? `lab/replay-${arm}`);
const segments = Number(argumentValue("--segments", "5"));
const budget = Number(argumentValue("--budget", "251520"));
const corpusPath = resolve(argumentValue("--corpus", "lab/corpus/traces.jsonl"));
const contentSeed = argumentValue("--content-seed", "9f4b2c7e15a03d68");
const querySeed = argumentValue("--query-seed", "3c81e7d0b46a92f5");
const workDir = resolve(argumentValue("--work-dir", `${runDir}/work`));

mkdirSync(runDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

// Each segment must be big enough that appending it crosses the trigger from wherever the
// last shed left the window. Sized against the SHED point rather than the budget, because
// what has to be traversed is the gap between them.
const triggerTokens = Math.floor(compactionTriggerShare("full") * budget);
const segmentTokens = Math.ceil(triggerTokens * 0.75);

const facts = buildReplayFacts({ contentSeed, segments });

process.stdout.write(`loading corpus ${corpusPath}\n`);
const { trajectories } = await loadTrajectories(corpusPath, { minMessages: 6 });
assertExperiment(trajectories.length > 0, "Replay corpus produced no trajectories");

// Fill each segment with whole trajectories, largest first, so a segment is made of real
// sessions rather than a transcript cut mid-thought.
const target = segmentTokens * 4;
const pool = trajectories.filter((item) => item.chars <= target);
assertExperiment(pool.length > 0,
  `No trajectory fits a ${segmentTokens}-token segment; the smallest is ` +
  `${replayTokens(Math.min(...trajectories.map((item) => item.chars)))} tokens`);
const segmentPlan = [];
let cursor = 0;
for (let index = 0; index < segments; index += 1) {
  const chosen = [];
  let chars = 0;
  let scanned = 0;
  while (chars < target * 0.9 && scanned < pool.length) {
    const candidate = pool[(cursor + scanned) % pool.length];
    scanned += 1;
    if (chars + candidate.chars > target) continue;
    chosen.push(candidate);
    chars += candidate.chars;
  }
  cursor = (cursor + scanned) % pool.length;
  assertExperiment(chosen.length > 0, `Replay corpus exhausted at segment ${index + 1}`);
  segmentPlan.push({ index, trajectories: chosen, chars });
}
assertNoCorpusCollision(facts, segmentPlan
  .flatMap((segment) => segment.trajectories)
  .flatMap((item) => item.messages)
  .map((message) => (typeof message.content === "string" ? message.content : ""))
  .join("\n"));

process.stdout.write(`${JSON.stringify({
  protocol: REPLAY_PROTOCOL, arm, segments, budget, triggerTokens, segmentTokens,
  corpusTrajectories: trajectories.length,
  segmentSizes: segmentPlan.map((segment) => replayTokens(segment.chars)),
}, null, 2)}\n`);

// ---------------------------------------------------------------- session
const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const model = modelRuntime.getModel(
  argumentValue("--provider", "openai-codex"), argumentValue("--model", "gpt-5.6-sol"));
assertExperiment(model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0,
  "Replay could not resolve its model");
assertExperiment(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0,
  "Pinned model declares no output maximum");

const compaction = compactionReserveTokens({
  descriptorWindow: model.contextWindow,
  servingBudgetTokens: budget,
  share: compactionTriggerShare("full"),
});
const settings = SettingsManager.inMemory({
  compaction: { enabled: arm === "native", reserveTokens: compaction.reserveTokens },
  branchSummary: { skipPrompt: true },
  transport: EXPERIMENT_TRANSPORT,
  retry: { ...EXPERIMENT_PROVIDER_RETRY },
});

let registerActiveContext = null;
let registerEvidenceIngestion = null;
if (arm === "pifold") {
  const { createJiti } = await import(
    pathToFileURL(join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
      "@earendil-works/pi-tui": join(PI_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
      typebox: join(PI_ROOT, "node_modules", "typebox", "build", "index.mjs"),
    },
  });
  ({ registerActiveContext } = await jiti.import(join(PROJECT, "extensions", "active-context.ts")));
  ({ registerEvidenceIngestion } = await jiti.import(join(PROJECT, "extensions", "evidence.js")));
}

const manager = SessionManager.inMemory(workDir);
const loader = new DefaultResourceLoader({
  cwd: workDir, agentDir: getAgentDir(), settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: true, systemPrompt: undefined, appendSystemPrompt: [],
  extensionFactories: arm === "pifold"
    ? [(pi) => { registerEvidenceIngestion(pi); return registerActiveContext(pi, { providerInputBudget: budget }); }]
    : [],
});
await loader.reload();
const created = await createAgentSession({
  cwd: workDir, resourceLoader: loader, sessionManager: manager, modelRuntime, model,
  settingsManager: settings, thinkingLevel: argumentValue("--effort", "xhigh"),
});
const session = created.session;
await session.bindExtensions({ mode: "print" });

// ---------------------------------------------------------------- replay
const timeline = [];
const startedAt = Date.now();
for (const segment of segmentPlan) {
  for (const trajectory of segment.trajectories) {
    for (const message of trajectory.messages) manager.appendMessage(toPiMessage(message));
  }
  const fact = facts[segment.index];
  manager.appendMessage({ role: "user", content: [{ type: "text", text: factStatement(fact) }] });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: factAcknowledgement(fact) }] });

  const contextOf = () => {
    const entries = manager.buildContextEntries();
    const chars = entries.reduce((total, entry) =>
      total + JSON.stringify(entry?.message ?? entry).length, 0);
    return { entries: entries.length, tokens: replayTokens(chars) };
  };
  const compactionsSoFar = () =>
    manager.getEntries().filter((entry) => entry.type === "compaction").length;
  const entriesBefore = manager.getEntries().length;
  const contextBefore = contextOf();
  const compactionsBefore = compactionsSoFar();
  const result = await session.prompt("carry on where that left off; a one line status is fine.",
    { expandPromptTemplates: false });
  timeline.push({
    segment: segment.index + 1,
    fact: fact.id,
    plantedTokens: replayTokens(segment.chars),
    entriesBefore,
    entriesAfter: manager.getEntries().length,
    contextTokensBefore: contextBefore.tokens,
    contextEntriesBefore: contextBefore.entries,
    contextTokensAfter: contextOf().tokens,
    compactionsBefore,
    compactionsAfter: compactionsSoFar(),
    stop: result?.stop ?? null,
  });
  process.stdout.write(`segment ${segment.index + 1}/${segments} planted ${fact.id} ` +
    `(${replayTokens(segment.chars).toLocaleString()} tokens)\n`);
}

// ---------------------------------------------------------------- the question
const prompt = endBlockPromptFor(facts, querySeed);
const answer = await session.prompt(prompt, { expandPromptTemplates: false });
let answerText = typeof answer?.text === "string" ? answer.text : "";
if (answerText.trim().length === 0) {
  const entries = manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role !== "assistant") continue;
    answerText = (message.content ?? [])
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (answerText.trim().length > 0) break;
  }
}
assertExperiment(answerText.trim().length > 0,
  `The end block returned no text (stop=${JSON.stringify(answer?.stop ?? null)}); ` +
  "grading an empty answer would report absent for a request that never landed");
const grade = gradeReplayAnswer({ facts, querySeed, answer: answerText });

const totalCompactions = manager.getEntries().filter((entry) => entry.type === "compaction").length;
const foldRecords = manager.getEntries().filter((entry) =>
  typeof entry.type === "string" && entry.type.includes("fold-record")).length;

const report = {
  shed: { compactions: totalCompactions, foldRecords },
  protocol: REPLAY_PROTOCOL, arm, segments, budget, triggerTokens,
  contentSeed, querySeed,
  elapsedMs: Date.now() - startedAt,
  timeline,
  endBlockPrompt: prompt,
  answer: answerText,
  grade,
  // Depth is the point: how many boundaries stood between a fact and the question.
  byDepth: grade.results.map((row) => ({
    id: row.id, depth: segments - row.segment, verdict: row.verdict,
  })),
};
writeFileSync(`${runDir}/replay-report.json`, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  arm, shed: report.shed, correct: grade.correct, wrong: grade.wrong, absent: grade.absent,
  byDepth: report.byDepth,
}, null, 2)}\n`);
