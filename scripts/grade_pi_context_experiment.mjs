#!/usr/bin/env node

// Blind grading for a fold-vs-compaction campaign.
//
// The grader sees: a rubric, the mechanically extracted ground truth, and anonymised
// submissions. It never sees an arm, a guidance profile, a run id, a runtime configuration,
// or an ordering that encodes any of them. The mapping from submission id back to run lives
// in a SEPARATE directory and is only rejoined at analysis time.
//
//   node scripts/grade_pi_context_experiment.mjs --campaign-dir <dir> [--dry-run] \
//        [--grader-provider openai-codex] [--grader-model gpt-5.6-terra] [--grader-effort medium]

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertBlindPacket,
  assertExperiment,
  seededShuffle,
  submissionId,
  validateStagePlan,
} from "./lib/pi_context_experiment.mjs";
import {
  fileSha256,
  freshChallenge,
  readJson,
  sha256Json,
  sha256Text,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";

export const GRADING_RUBRIC = Object.freeze({
  version: 1,
  probe: [
    "correct: the answer matches the ground truth exactly, or differs only in surrounding words.",
    "partial: the answer names the right file or right symbol family but the specific value is wrong.",
    "incorrect: the answer contradicts the ground truth.",
    "absent: no answer was given for this probe id.",
  ],
  deliverable: [
    "completeness 0-5: does the note cover the components it was asked to cover?",
    "earlyFactAccuracy 0-5: are the cited early facts (paths, identifiers, line positions) correct and specific, rather than vague or invented?",
    "crossReference 0-5: does it actually connect the earlier material to the later material, rather than listing them separately?",
  ],
  instructions: [
    "Grade each submission independently and only on its own content.",
    "Do not speculate about how a submission was produced; there is no information about that and none is relevant.",
    "Answer with one JSON object and nothing else.",
  ],
});

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function adjudicatorSourceSha8() {
  return fileSha256(
    join(dirname(fileURLToPath(import.meta.url)), "adjudicate_pi_context_experiment.mjs"),
  ).slice(0, 8);
}

function collectRunEvidence(campaignDir) {
  const runsDir = join(campaignDir, "runs");
  assertExperiment(existsSync(runsDir), `Campaign has no runs directory at ${runsDir}`);
  // Prefer the re-adjudication sidecar produced by the adjudicator in THIS checkout
  // (experiment-evidence.<sha8>.json, named by adjudicator source hash) over the sealed
  // original, so recovered extractions reach the grading packet deterministically.
  const adjudicatorSha8 = adjudicatorSourceSha8();
  const evidence = [];
  for (const name of readdirSync(runsDir).sort()) {
    const runDir = join(runsDir, name);
    const sidecar = join(runDir, `experiment-evidence.${adjudicatorSha8}.json`);
    const path = existsSync(sidecar) ? sidecar : join(runDir, "experiment-evidence.json");
    if (!existsSync(path)) continue;
    evidence.push(readJson(path));
  }
  assertExperiment(evidence.length > 0, "Campaign has no adjudicated runs to grade");
  return evidence;
}

function groundTruthFromPlans(evidence) {
  const plans = new Map();
  for (const run of evidence) {
    if (plans.has(run.evidence.planSha256)) continue;
    const planPath = join(run.runDir, "run-config.json");
    const plan = validateStagePlan(readJson(readJson(planPath).planPath));
    plans.set(plan.planSha256, plan);
  }
  assertExperiment(plans.size === 1,
    "Campaign mixes stage plans; grading must compare submissions against one ground truth");
  const plan = [...plans.values()][0];
  return {
    planSha256: plan.planSha256,
    probes: plan.stages.flatMap((stage) => stage.probes.map((probe) => ({
      probeId: probe.id,
      kind: probe.kind,
      question: probe.question,
      expectedAnswer: probe.expectedAnswer,
      sourcePath: probe.sourcePath,
      sourceLine: probe.sourceLine,
    }))),
    deliverables: plan.stages.flatMap((stage) => stage.deliverable
      ? [{ id: stage.deliverable.id, instructions: stage.deliverable.instructions }]
      : []),
  };
}

function buildPacketAndKey(evidence, salt) {
  const groundTruth = groundTruthFromPlans(evidence);
  const submissions = evidence.map((run) => ({
    submissionId: submissionId(run.runId, salt),
    probeAnswers: run.probes.flatMap((probe) => probe.answers.map((answer) => ({
      probeId: answer.probeId,
      answerText: answer.answerText ?? "",
    }))),
    deliverables: run.deliverables.map((deliverable) => ({
      id: deliverable.id,
      text: deliverable.text ?? "",
    })),
  }));
  // Submission ORDER must not encode the arm either: the run listing is arm-ordered on disk.
  const ordered = seededShuffle(submissions, `${salt}:submission-order`);
  const packet = {
    version: 1,
    rubric: GRADING_RUBRIC,
    groundTruth,
    submissions: ordered,
  };
  assertBlindPacket(packet);
  const key = {
    version: 1,
    saltSha256: sha256Text(salt),
    packetSha256: sha256Json(packet),
    mapping: evidence.map((run) => ({
      submissionId: submissionId(run.runId, salt),
      runId: run.runId,
      runDir: run.runDir,
      arm: run.arm,
      guidance: run.guidance,
      repetition: run.repetition,
    })),
  };
  return { packet, key, salt };
}

function graderPrompt(packet, submission) {
  return [
    "You are grading one anonymous submission against a fixed rubric and a fixed ground truth.",
    "",
    "RUBRIC:",
    JSON.stringify(packet.rubric, null, 2),
    "",
    "GROUND TRUTH:",
    JSON.stringify(packet.groundTruth, null, 2),
    "",
    "SUBMISSION:",
    JSON.stringify(submission, null, 2),
    "",
    "Reply with exactly one JSON object of the form:",
    '{"submissionId": "...", "probeScores": [{"probeId": "...", "verdict": "correct|partial|incorrect|absent", "note": "..."}],',
    ' "deliverableScores": [{"id": "...", "completeness": 0, "earlyFactAccuracy": 0, "crossReference": 0, "note": "..."}]}',
  ].join("\n");
}

function parseGraderJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  assertExperiment(start >= 0 && end > start, "Grader response contained no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

async function gradeLive(packet, grader, workDir) {
  const {
    createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager,
    SettingsManager,
  } = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const discovered = modelRuntime.getModel(grader.provider, grader.id);
  assertExperiment(discovered, `Grader model ${grader.provider}/${grader.id} is unavailable`);
  const scores = [];
  for (const submission of packet.submissions) {
    const sessionDir = join(workDir, submission.submissionId);
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(sessionDir, sessionDir);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      branchSummary: { skipPrompt: true },
    });
    const loader = new DefaultResourceLoader({
      cwd: sessionDir,
      agentDir: getAgentDir(),
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "You are a strict, literal grader. You answer with one JSON object and nothing else.",
      appendSystemPrompt: [],
      extensionFactories: [{
        name: "grader-tool-fence",
        factory(pi) {
          // A grader has no business touching the filesystem or the network.
          pi.on("tool_call", () => ({ block: true, reason: "Grading is a single reasoning pass." }));
        },
      }],
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: sessionDir,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime,
      model: { ...discovered, maxTokens: 8_192 },
      settingsManager: settings,
      thinkingLevel: grader.effort,
    });
    await created.session.bindExtensions({ mode: "print" });
    await created.session.prompt(graderPrompt(packet, submission), { expandPromptTemplates: false });
    const branch = manager.getBranch();
    const terminal = [...branch].reverse().find((entry) => entry?.type === "message" &&
      entry.message?.role === "assistant");
    const text = Array.isArray(terminal?.message?.content)
      ? terminal.message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
      : String(terminal?.message?.content ?? "");
    created.session.dispose();
    const parsed = parseGraderJson(text);
    assertExperiment(parsed.submissionId === submission.submissionId,
      `Grader returned scores for ${parsed.submissionId}, expected ${submission.submissionId}`);
    scores.push(parsed);
  }
  return scores;
}

let result;
try {
  const campaignDir = resolve(argumentValue("--campaign-dir") ?? "");
  assertExperiment(campaignDir && existsSync(campaignDir), "Grading requires --campaign-dir");
  const dryRun = process.argv.includes("--dry-run");
  const grader = {
    provider: argumentValue("--grader-provider", "openai-codex"),
    id: argumentValue("--grader-model", "gpt-5.6-terra"),
    effort: argumentValue("--grader-effort", "medium"),
  };
  const salt = argumentValue("--salt", freshChallenge());
  const evidence = collectRunEvidence(campaignDir);
  const { packet, key } = buildPacketAndKey(evidence, salt);

  // Packet and key never share a directory: the grading input tree can be handed to any
  // grader wholesale without carrying the arm mapping with it.
  // --regrade pools a fresh pass into directories suffixed by the adjudicator source hash
  // (the same convention as evidence sidecars), never touching an earlier pass.
  const regrade = process.argv.includes("--regrade");
  const dirSuffix = regrade ? `.${adjudicatorSourceSha8()}` : "";
  const gradingDir = join(campaignDir, `grading${dirSuffix}`);
  const keyDir = join(campaignDir, `grading-key${dirSuffix}`);
  mkdirSync(gradingDir, { recursive: true, mode: 0o700 });
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const packetPath = join(gradingDir, "packet.json");
  const keyPath = join(keyDir, "key.json");
  writeJsonExclusive(packetPath, packet);
  writeJsonExclusive(keyPath, key);
  assertExperiment(dirname(packetPath) !== dirname(keyPath),
    "Blind grading packet and its arm mapping must not share a directory");

  let scoresPath = null;
  let scores = null;
  if (!dryRun) {
    scores = await gradeLive(packet, grader, join(gradingDir, "sessions"));
    scoresPath = join(gradingDir, "scores.json");
    writeJsonExclusive(scoresPath, {
      version: 1,
      grader,
      packetSha256: sha256Json(packet),
      rubricSha256: sha256Json(GRADING_RUBRIC),
      scores,
    });
  }
  result = {
    ok: true,
    dryRun,
    campaignDir,
    packetPath,
    packetSha256: fileSha256(packetPath),
    keyPath,
    scoresPath,
    submissions: packet.submissions.length,
    probes: packet.groundTruth.probes.length,
    deliverables: packet.groundTruth.deliverables.length,
    grader,
    blind: true,
  };
} catch (error) {
  result = {
    ok: false,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
