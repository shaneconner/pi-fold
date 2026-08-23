#!/usr/bin/env node
// Resumes a checkpoint under one arm and asks for every anchor once.
//
//   node scripts/run_replay_resume.mjs --arm native|pifold --checkpoint lab/checkpoint-a --run-dir <dir>
//
// The checkpoint is COPIED per arm. Both arms must resume byte-identical prior state, and a
// run that wrote back into the shared file would hand the second arm the first arm's
// shedding. This is the property the whole comparison rests on, so it is asserted by hash
// rather than assumed from the copy.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { PI_INSTALL_ROOT, fileSha256 } from "./lib/pi_context_soak_attestation.mjs";
import {
  EXPERIMENT_TRANSPORT, EXPERIMENT_PROVIDER_RETRY, assertExperiment,
  compactionReserveTokens, compactionTriggerShare,
} from "./lib/pi_context_experiment.mjs";
import { endBlockPromptFor, gradeReplayAnswer } from "./lib/replay_session.mjs";

const R = PI_INSTALL_ROOT;
const {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(R, "dist", "index.js")));

const argumentValue = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const arm = argumentValue("--arm");
assertExperiment(["native", "pifold"].includes(arm), "Resume needs --arm native or pifold");
const checkpoint = resolve(argumentValue("--checkpoint") ?? "lab/checkpoint-a");
const runDir = resolve(argumentValue("--run-dir") ?? `lab/resume-${arm}`);
const budget = Number(argumentValue("--budget", "251520"));
const querySeed = argumentValue("--query-seed", "3c81e7d0b46a92f5");

const manifest = JSON.parse(readFileSync(`${checkpoint}.manifest.json`, "utf8"));
const sessionDir = join(runDir, "session");
const workDir = join(runDir, "work");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
const sessionFile = join(sessionDir, basename(manifest.sessionFile));
copyFileSync(manifest.sessionFile, sessionFile);
assertExperiment(fileSha256(sessionFile) === fileSha256(manifest.sessionFile),
  "The copied checkpoint differs from the one the manifest names");

const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
const model = modelRuntime.getModel(
  argumentValue("--provider", "openai-codex"), argumentValue("--model", "gpt-5.6-sol"));
assertExperiment(model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0,
  "Resume could not resolve its model");
assertExperiment(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0,
  "Pinned model declares no output maximum");

const compaction = compactionReserveTokens({
  descriptorWindow: model.contextWindow, servingBudgetTokens: budget,
  share: compactionTriggerShare("full"),
});
const settings = SettingsManager.inMemory({
  compaction: { enabled: arm === "native", reserveTokens: compaction.reserveTokens },
  branchSummary: { skipPrompt: true },
  transport: EXPERIMENT_TRANSPORT,
  retry: { ...EXPERIMENT_PROVIDER_RETRY },
});

const extensionFactories = [];
if (arm === "pifold") {
  const { createJiti } = await import(
    pathToFileURL(join(R, "node_modules", "jiti", "lib", "jiti.mjs")));
  const jiti = createJiti(import.meta.url, {
    fsCache: false,
    alias: {
      "@earendil-works/pi-coding-agent": join(R, "dist", "index.js"),
      "@earendil-works/pi-tui": join(R, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
      typebox: join(R, "node_modules", "typebox", "build", "index.mjs"),
    },
  });
  const project = resolve(new URL("..", import.meta.url).pathname);
  const { registerActiveContext } = await jiti.import(join(project, "extensions", "active-context.ts"));
  const { registerEvidenceIngestion } = await jiti.import(join(project, "extensions", "evidence.js"));
  extensionFactories.push((pi) => {
    registerEvidenceIngestion(pi);
    return registerActiveContext(pi, { providerInputBudget: budget });
  });
}

const manager = SessionManager.open(sessionFile, sessionDir, workDir);
const loader = new DefaultResourceLoader({
  cwd: workDir, agentDir: getAgentDir(), settingsManager: settings,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: true, systemPrompt: undefined, appendSystemPrompt: [], extensionFactories,
});
await loader.reload();
const created = await createAgentSession({
  cwd: workDir, resourceLoader: loader, sessionManager: manager, modelRuntime, model,
  settingsManager: settings, thinkingLevel: argumentValue("--effort", "xhigh"),
});
assertExperiment(!(created.extensionsResult?.errors ?? []).length,
  `Resume extension load failed: ${JSON.stringify(created.extensionsResult?.errors)}`);
const session = created.session;
await session.bindExtensions({ mode: "print" });

const openedEntries = manager.getEntries().length;
const openedContext = manager.buildContextEntries().length;
const startedAt = Date.now();

// `session.prompt()` returns {} on this Pi build, so the reply is read from the transcript.
// See the journal entry of 2026-08-23: reading result.text here is what made a dead
// deflection path look like a run with no questions in it.
const replyAfter = async (text) => {
  await session.prompt(text, { expandPromptTemplates: false });
  const entries = manager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role !== "assistant") continue;
    const out = (message.content ?? [])
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (out.trim().length > 0) return out;
  }
  return "";
};

const facts = manifest.placements.map(({ id, kind, segment, value }) => ({ id, kind, segment, value }));
const prompt = endBlockPromptFor(facts, querySeed);
const answer = await replyAfter(prompt);
assertExperiment(answer.trim().length > 0, "The resumed session returned no text to grade");
const grade = gradeReplayAnswer({ facts, querySeed, answer });

const shed = {
  compactions: manager.getEntries().filter((entry) => entry.type === "compaction").length,
  foldRecords: manager.getEntries().filter((entry) =>
    typeof entry.type === "string" && entry.type.includes("fold-record")).length,
};
const report = {
  arm, budget, checkpoint,
  checkpointTokens: manifest.tokens,
  checkpointSha256: fileSha256(manifest.sessionFile),
  openedEntries, openedContext, shed,
  elapsedMs: Date.now() - startedAt,
  prompt, answer, grade,
  byDepth: grade.results.map((row) => {
    const placed = manifest.placements.find((item) => item.id === row.id);
    return { id: row.id, plantedAtToken: placed.atToken,
      tokensSince: manifest.tokens - placed.atToken, verdict: row.verdict };
  }).sort((left, right) => right.tokensSince - left.tokensSince),
};
writeFileSync(join(runDir, "resume-report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  arm, shed, openedEntries, openedContext,
  correct: grade.correct, wrong: grade.wrong, absent: grade.absent,
  byDepth: report.byDepth,
}, null, 2)}\n`);
