#!/usr/bin/env node

/** One blind stock-Pi workload: normal extension guidance must elicit agent-managed folds. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const PI_ROOT = process.env.QUORUM_PI_ROOT ?? join(
  homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent",
);
const PORTABLE_MANIFEST_PREFLIGHT = process.env.QUORUM_CANARY_DRY_RUN === "1" &&
  process.env.QUORUM_CANARY_CALIBRATION_MANIFEST_ONLY === "1";
const STATE_ROOT = PORTABLE_MANIFEST_PREFLIGHT
  ? join(tmpdir(), "quorum-archive-evidence-canary")
  : "/home/shane/quorum-run/state/ops/archive-evidence-canary";
const FALLBACK_ROOT = PORTABLE_MANIFEST_PREFLIGHT ? tmpdir() : "/home/shane/quorum-run/tmp";
const EXPECTED_CONTEXT_WINDOW = 272_000;
const EXPECTED_RESERVE_TOKENS = 16_384;
const BOUNDED_OUTPUT_TOKENS = 2_048;
const MAX_CHAIN_FILES = 30;
const MIN_CHAIN_FILES = 1;
const CALIBRATED_PREFIX_FILES = 17;
const CHAIN_FILES = MAX_CHAIN_FILES;
const CHAIN_FILE_CHARS = 30_000;
// Three complete pre-prompt turns stay protected while the live marathon is
// structurally open. No pre-prompt evidence is eligible to satisfy fold acceptance.
const PROTECTED_SEED_CHARS = 235_000;
const REQUIRED_AGENT_FOLDS = 2;
const BEHAVIORAL_CANARY_MODE = "extension-guidance-only-blind-workload";
const MAX_PROVIDER_CHECKPOINTS = 80;
const CANARY_DEADLINE_MS = 15 * 60 * 1_000;
const MIN_ACCEPTANCE_DURATION_MS = 3 * 60 * 60 * 1_000;
const LIVE_PREFIX_CALIBRATION = Object.freeze({
  reportPath: "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T18-10-00-406Z/report.json",
  reportSha256: "8548b58e04670259fcfb824b75c491317c6dce63da4817af4ad5999be1bbf018",
  sessionPath: "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T18-10-00-406Z/2026-08-01T18-10-00-450Z_019fbe84-c682-74d8-b4a0-22667d7cc6de.jsonl",
  sessionSha256: "bba69543f4a40896582b08fd3fa8836944fde063c76ed60743279884544812a7",
  manifestPath: join(PROJECT, "tests", "fixtures", "pi_context", "live_canary_prefix_calibration.json"),
  manifestSha256: "619f859f7e3f2e804b6a9ff44bb246d7c68e0b7739893c4abceeaff7b0fd9e40",
});
const HELD_CALIBRATION = Object.freeze({
  reportPath: "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T01-37-37-593Z/report.json",
  reportSha256: "4047bbbdfffc44f235b7c2c518e7dc71a84fd370494891ed569ff317b8f5ffab",
  sessionPath: "/home/shane/quorum-run/state/ops/pi-context-clean-canary/2026-08-01T01-37-37-593Z/2026-08-01T01-37-37-634Z_019fbaf8-3962-7093-b62d-2b9718a022cc.jsonl",
  sessionSha256: "fb5525809d0b4455580e4992e49976d9a632c4a356fd2a97ed97c3ea787f9517",
  manifestPath: join(PROJECT, "tests", "fixtures", "pi_context", "held_under_pressure_calibration.json"),
  manifestSha256: "ac27152121ae91fa3dddab5bd47eb982a4b87d675e20cfaef20c2c6f19dd59ac",
  seedChars: 465_000,
  chainFiles: 12,
  firstProviderTokens: 79_259,
  finalProviderTokens: 127_778,
  guidanceTokens: 136_000,
});

const jitiPath = [
  join(PROJECT, ".pi", "pi-subagents", "node_modules", "jiti", "lib", "jiti.mjs"),
  join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs"),
].find(existsSync);
if (!jitiPath) throw new Error("Could not resolve jiti for the behavioral context canary");
const { createJiti } = await import(pathToFileURL(jitiPath));
const {
  createAgentSession,
  ModelRuntime,
  SessionManager,
} = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
const { calculateContextTokens, estimateContextTokens } = await import(pathToFileURL(
  join(PI_ROOT, "dist", "core", "compaction", "index.js"),
));
const jiti = createJiti(import.meta.url);
const contextRuntime = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "active-context.ts"));
const identity = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "identity.js"));
const jsonRuntime = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "json.ts"));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function heldCalibrationAttestation() {
  assert(existsSync(HELD_CALIBRATION.manifestPath),
    "Committed held-calibration manifest is missing");
  assert(fileSha256(HELD_CALIBRATION.manifestPath) === HELD_CALIBRATION.manifestSha256,
    "Committed held-calibration manifest hash drifted");
  const manifest = JSON.parse(readFileSync(HELD_CALIBRATION.manifestPath, "utf8"));
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  assert(exactKeys(manifest, [
    "version", "source", "seedChars", "chainFiles", "firstProviderTokens",
    "finalProviderTokens", "guidanceTokens", "checkpoints",
  ]) && manifest.version === 1 &&
    exactKeys(manifest.source, ["reportSha256", "sessionSha256"]) &&
    manifest.source.reportSha256 === HELD_CALIBRATION.reportSha256 &&
    manifest.source.sessionSha256 === HELD_CALIBRATION.sessionSha256 &&
    manifest.seedChars === HELD_CALIBRATION.seedChars &&
    manifest.chainFiles === HELD_CALIBRATION.chainFiles &&
    manifest.firstProviderTokens === HELD_CALIBRATION.firstProviderTokens &&
    manifest.finalProviderTokens === HELD_CALIBRATION.finalProviderTokens &&
    manifest.guidanceTokens === HELD_CALIBRATION.guidanceTokens && Array.isArray(manifest.checkpoints),
  "Committed held-calibration manifest schema drifted");
  const checkpoints = manifest.checkpoints.map((item, index) => {
    assert(exactKeys(item, ["tokens", "timestamp"]) && Number.isSafeInteger(item.tokens) && item.tokens > 0 &&
      Number.isSafeInteger(item.timestamp) && item.timestamp >= 0 &&
      (index === 0 || item.timestamp > manifest.checkpoints[index - 1].timestamp),
    "Committed held-calibration checkpoint drifted");
    return { tokens: item.tokens, timestamp: item.timestamp };
  });
  const manifestOnly = process.env.QUORUM_CANARY_DRY_RUN === "1" &&
    process.env.QUORUM_CANARY_CALIBRATION_MANIFEST_ONLY === "1";
  const hasReport = !manifestOnly && existsSync(HELD_CALIBRATION.reportPath);
  const hasSession = !manifestOnly && existsSync(HELD_CALIBRATION.sessionPath);
  assert(hasReport === hasSession, "Held raw calibration evidence is only partially available");
  let evidenceSource = "committed-derived-manifest";
  if (hasReport && hasSession) {
    assert(fileSha256(HELD_CALIBRATION.reportPath) === HELD_CALIBRATION.reportSha256,
      "Held calibration report hash drifted");
    assert(fileSha256(HELD_CALIBRATION.sessionPath) === HELD_CALIBRATION.sessionSha256,
      "Held calibration session hash drifted");
    const rawCheckpoints = readFileSync(HELD_CALIBRATION.sessionPath, "utf8").trim().split("\n").flatMap((line) => {
      const entry = JSON.parse(line);
      const message = entry.type === "message" ? entry.message : null;
      const tokens = message?.role === "assistant" ? measuredTokens(message) : null;
      return tokens === null ? [] : [{ tokens, timestamp: message.timestamp }];
    });
    assert(JSON.stringify(rawCheckpoints) === JSON.stringify(checkpoints),
      "Held raw calibration checkpoints differ from the committed manifest");
    evidenceSource = "hash-verified-raw-session";
  }
  assert(checkpoints[0]?.tokens === HELD_CALIBRATION.firstProviderTokens &&
    checkpoints.at(-1)?.tokens === HELD_CALIBRATION.finalProviderTokens,
  "Held calibration provider checkpoints drifted");
  const durations = checkpoints.slice(1).map((item, index) => item.timestamp - checkpoints[index].timestamp)
    .sort((left, right) => left - right);
  const p95StageMs = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  const projectedCheckpoints = Math.ceil(checkpoints.length / HELD_CALIBRATION.chainFiles * CHAIN_FILES);
  const projectedFirstProviderTokens = Math.round(
    HELD_CALIBRATION.firstProviderTokens * (PROTECTED_SEED_CHARS * 3) / HELD_CALIBRATION.seedChars,
  );
  const measuredTokensPerFile = (
    HELD_CALIBRATION.finalProviderTokens - HELD_CALIBRATION.firstProviderTokens
  ) / HELD_CALIBRATION.chainFiles;
  const projectedNoFoldFinalTokens = Math.round(
    projectedFirstProviderTokens + measuredTokensPerFile * CHAIN_FILES,
  );
  return {
    ...HELD_CALIBRATION,
    evidenceSource,
    providerCheckpoints: checkpoints.length,
    elapsedMs: checkpoints.at(-1).timestamp - checkpoints[0].timestamp,
    p95StageMs,
    projectedCheckpoints,
    projectedWallClockMs: p95StageMs * projectedCheckpoints,
    projectedFirstProviderTokens,
    measuredTokensPerFile,
    projectedNoFoldFinalTokens,
    projectedAfterTwoSmallFolds: Math.round(
      projectedNoFoldFinalTokens - measuredTokensPerFile * REQUIRED_AGENT_FOLDS,
    ),
  };
}

function livePrefixCalibrationAttestation() {
  assert(existsSync(LIVE_PREFIX_CALIBRATION.manifestPath),
    "Committed live-prefix calibration manifest is missing");
  assert(fileSha256(LIVE_PREFIX_CALIBRATION.manifestPath) === LIVE_PREFIX_CALIBRATION.manifestSha256,
    "Committed live-prefix calibration manifest hash drifted");
  const manifest = JSON.parse(readFileSync(LIVE_PREFIX_CALIBRATION.manifestPath, "utf8"));
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  assert(exactKeys(manifest, [
    "version", "source", "sourceChainFiles", "targetChainFiles", "thresholds",
    "targetPrefix", "firstExcluded",
  ]) && manifest.version === 1 &&
    exactKeys(manifest.source, ["reportSha256", "sessionSha256", "sessionId"]) &&
    exactKeys(manifest.thresholds, ["urgentTokens", "automaticToolTokens"]) &&
    exactKeys(manifest.targetPrefix, [
      "completedFiles", "entryId", "tokens", "stopReason", "tool", "action",
    ]) && exactKeys(manifest.firstExcluded, [
      "file", "entryId", "tokens", "stopReason", "tool",
    ]), "Committed live-prefix calibration schema drifted");
  assert(manifest.source.reportSha256 === LIVE_PREFIX_CALIBRATION.reportSha256 &&
    manifest.source.sessionSha256 === LIVE_PREFIX_CALIBRATION.sessionSha256 &&
    typeof manifest.source.sessionId === "string" && manifest.source.sessionId &&
    manifest.sourceChainFiles === 18 && manifest.targetChainFiles === CALIBRATED_PREFIX_FILES &&
    manifest.targetPrefix.completedFiles === CALIBRATED_PREFIX_FILES &&
    manifest.firstExcluded.file === CALIBRATED_PREFIX_FILES + 1 &&
    manifest.thresholds.urgentTokens <= manifest.targetPrefix.tokens &&
    manifest.targetPrefix.tokens < manifest.thresholds.automaticToolTokens &&
    manifest.firstExcluded.tokens >= manifest.thresholds.automaticToolTokens,
  "Committed live-prefix calibration bounds drifted");
  const manifestOnly = process.env.QUORUM_CANARY_DRY_RUN === "1" &&
    process.env.QUORUM_CANARY_CALIBRATION_MANIFEST_ONLY === "1";
  const hasReport = !manifestOnly && existsSync(LIVE_PREFIX_CALIBRATION.reportPath);
  const hasSession = !manifestOnly && existsSync(LIVE_PREFIX_CALIBRATION.sessionPath);
  assert(hasReport === hasSession, "Live-prefix raw calibration evidence is only partially available");
  let evidenceSource = "committed-derived-manifest";
  if (hasReport && hasSession) {
    assert(fileSha256(LIVE_PREFIX_CALIBRATION.reportPath) === LIVE_PREFIX_CALIBRATION.reportSha256,
      "Live-prefix calibration report hash drifted");
    assert(fileSha256(LIVE_PREFIX_CALIBRATION.sessionPath) === LIVE_PREFIX_CALIBRATION.sessionSha256,
      "Live-prefix calibration session hash drifted");
    const report = JSON.parse(readFileSync(LIVE_PREFIX_CALIBRATION.reportPath, "utf8"));
    assert(report.sessionFile === LIVE_PREFIX_CALIBRATION.sessionPath &&
      report.observations?.pressureAbortFired === true &&
      report.observations?.highWaterTokens === manifest.firstExcluded.tokens &&
      report.nativeCounts?.compactions === 0 && report.nativeCounts?.decisions === 0 &&
      report.nativeCounts?.receipts === 0,
    "Live-prefix calibration report facts drifted");
    const entries = readFileSync(LIVE_PREFIX_CALIBRATION.sessionPath, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const verifyCheckpoint = (checkpoint, action) => {
      const entry = entries.find((candidate) => candidate.id === checkpoint.entryId);
      const message = entry?.type === "message" ? entry.message : null;
      const calls = Array.isArray(message?.content)
        ? message.content.filter((part) => part?.type === "toolCall") : [];
      const call = calls.find((part) => part.name === checkpoint.tool &&
        (action === null || part.arguments?.action === action));
      assert(message?.stopReason === checkpoint.stopReason && measuredTokens(message) === checkpoint.tokens && call,
        `Live-prefix checkpoint ${checkpoint.entryId} drifted`);
    };
    verifyCheckpoint(manifest.targetPrefix, manifest.targetPrefix.action);
    verifyCheckpoint(manifest.firstExcluded, null);
    evidenceSource = "hash-verified-live-prefix";
  }
  return {
    ...manifest,
    ...LIVE_PREFIX_CALIBRATION,
    evidenceSource,
    projectedHighWaterTokens: manifest.targetPrefix.tokens,
    headroomTokens: manifest.thresholds.automaticToolTokens - manifest.targetPrefix.tokens,
  };
}

function activeContextEnabled() {
  const source = readFileSync(join(PROJECT, ".pi", "extensions", "quorum", "index.js"), "utf8");
  return /const\s+ACTIVE_CONTEXT_ENABLED\s*=\s*true\s*;/.test(source);
}

function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function paddedText(prefix, chars, phrase = "Completed archival evidence remains exact and recoverable. ") {
  let text = prefix;
  while (text.length < chars) text += phrase;
  return text.slice(0, chars);
}

function appendSeedHistory(manager) {
  let timestamp = Date.now() - 100_000;
  for (let turn = 0; turn < 3; turn += 1) {
    manager.appendMessage({
      role: "user", content: `Archive inventory ${turn}; retain the exact factual record.`, timestamp: timestamp++,
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: paddedText(`RECENT_ARCHIVE_${turn}: `, PROTECTED_SEED_CHARS) }],
      stopReason: "stop", usage: zeroUsage(), timestamp: timestamp++,
    });
  }
}

const HIDDEN_CONTEXT_CRITERIA = /(?:\bquorum_context\b|\bcontexts?\b|\bfold(?:s|ed|ing)?\b|\bcompact(?:s|ed|ing|ion)?\b|\bthresholds?\b|\bguidance\b)/i;

function assertBlindVisibleText(label, text) {
  assert(typeof text === "string" && !HIDDEN_CONTEXT_CRITERIA.test(text),
    `Behavioral ${label} leaked its hidden context-management acceptance criteria`);
}

function visibleMessageText(message) {
  if (typeof message?.content === "string") return [message.content];
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((part) => typeof part?.text === "string" ? [part.text] : []);
}

function blindWorkloadPrompt(firstPath) {
  const prompt = [
    `Follow the archival evidence chain beginning at ${firstPath}.`,
    "Read the NEXT path found in each file until NEXT is END.",
    "Keep a cumulative factual analysis while working and do not skip a stage.",
    "Finish with a concise marker-to-claim list plus any anomalies. Complete this as one continuous run.",
  ].join(" ");
  assertBlindVisibleText("prompt", prompt);
  return prompt;
}

function blindWorkloadAttestation(manager, chain, prompt) {
  const seedTexts = manager.buildSessionContext().messages.flatMap(visibleMessageText);
  const evidenceTexts = chain.paths.flatMap((path) => [path, readFileSync(path, "utf8")]);
  const visibleCorpus = [prompt, ...seedTexts, ...evidenceTexts];
  for (const [index, text] of visibleCorpus.entries()) {
    assertBlindVisibleText(`visible corpus item ${index}`, text);
  }
  return {
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    visibleCorpusSha256: createHash("sha256").update(JSON.stringify(visibleCorpus)).digest("hex"),
    hiddenCriteriaTermsAbsent: true,
    seedMessages: manager.buildSessionContext().messages.length,
    evidenceFiles: chain.paths.length,
    behaviorPromptSource: "runtime-extension-guidance-only",
  };
}

async function writeEvidenceChain(runDir) {
  const evidenceDir = join(runDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });
  const markers = [];
  const paths = Array.from({ length: CHAIN_FILES }, (_, index) =>
    join(evidenceDir, `archive-${String(index + 1).padStart(2, "0")}.txt`));
  const renderStage = (index, next) => {
    const marker = `CANARY_MARKER_${String(index + 1).padStart(2, "0")}`;
    const prefix = `${marker}\nCLAIM: archive stage ${index + 1} completed with deterministic evidence.\n`;
    const suffix = `\nNEXT: ${next}\n`;
    return paddedText(
      prefix,
      CHAIN_FILE_CHARS - suffix.length,
      `Archive ${index + 1} evidence is factual and complete. `,
    ) + suffix;
  };
  for (let index = 0; index < paths.length; index += 1) {
    markers.push(`CANARY_MARKER_${String(index + 1).padStart(2, "0")}`);
    const next = index + 1 < paths.length ? paths[index + 1] : "END";
    await writeFile(paths[index], renderStage(index, next));
  }
  let cutoffIndex = null;
  return {
    firstPath: paths[0], paths, markers,
    get cutoffIndex() { return cutoffIndex; },
    closeAt(path) {
      const index = paths.indexOf(path);
      if (index < 0) return null;
      if (cutoffIndex !== null) return cutoffIndex === index
        ? { file: index + 1, path, marker: markers[index] } : null;
      writeFileSync(path, renderStage(index, "END"));
      cutoffIndex = index;
      return { file: index + 1, path, marker: markers[index] };
    },
  };
}

function measuredTokens(message) {
  if (message?.role !== "assistant" ||
      (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") ||
      !message.usage || typeof message.usage !== "object") return null;
  const tokens = calculateContextTokens(message.usage);
  return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
}

function customEntries(manager, customType) {
  return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === customType);
}

function nativeCounts(manager) {
  const entries = manager?.getEntries?.() ?? [];
  return {
    compactions: entries.filter((entry) => entry.type === "compaction").length,
    decisions: entries.filter((entry) => entry.type === "custom" &&
      entry.customType === identity.QUORUM_NATIVE_COMPACTION_DECISION_ENTRY).length,
    receipts: entries.filter((entry) => entry.type === "custom" &&
      entry.customType === identity.QUORUM_NATIVE_COMPACTION_RECEIPT_ENTRY).length,
  };
}

function toolCalls(entries, name, action, provider, model) {
  return entries.flatMap((entry) => {
    const message = entry.type === "message" ? entry.message : null;
    if (message?.role !== "assistant" || message.provider !== provider || message.model !== model ||
        measuredTokens(message) === null || !Array.isArray(message.content)) return [];
    return message.content.filter((part) => {
      if (part?.type !== "toolCall" || part.name !== name) return false;
      const args = part.arguments;
      return action === undefined || (args && typeof args === "object" && args.action === action);
    }).map((part) => ({
      entryId: entry.id, id: part.id, arguments: part.arguments,
      provider: message.provider, model: message.model, tokens: measuredTokens(message),
    }));
  });
}

function gitAttestation() {
  const head = execFileSync("git", ["-C", PROJECT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", PROJECT, "status", "--porcelain", "-z"], { encoding: "utf8" })
    .split("\0").filter(Boolean).map((line) => line.slice(3));
  const runtimeDirty = dirty.filter((path) =>
    path === "AGENTS.md" || path === "CLAUDE.md" || path.startsWith(".pi/") ||
    path.startsWith("qmem/") || path === "scripts/inject_memory_context.sh" ||
    path === "scripts/run_pi_context_canary.mjs");
  assert(runtimeDirty.length === 0, `Canary runtime paths are dirty: ${runtimeDirty.join(", ")}`);
  return { head, project: PROJECT, dirtyPaths: dirty, runtimeDirtyPaths: runtimeDirty };
}

const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runDir = join(STATE_ROOT, runId);
const preferredReportPath = join(runDir, "report.json");
const fallbackReportPath = join(FALLBACK_ROOT, `pi-context-canary-failure-${process.pid}.json`);
let reportPath = fallbackReportPath;
let manager;
let session;
let report;
let revision = null;
let calibration = null;
let prefixCalibration = null;
let activeContextGate = null;
let observations = null;
let workloadPrompt = null;
let workload = null;
const compactionEvents = [];
let providerCheckpointEvents = 0;
let deadlineFired = false;
let pressureAbortFired = false;
let pressureStopRequested = false;
let awarenessSeen = false;
let adaptiveCutoffError = null;

try {
  await mkdir(STATE_ROOT, { recursive: true });
  await mkdir(FALLBACK_ROOT, { recursive: true });
  await mkdir(runDir, { recursive: false });
  reportPath = preferredReportPath;

  const piVersion = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")).version;
  assert(piVersion === "0.83.0", `Canary baseline drifted from stock Pi 0.83.0 to ${piVersion}`);
  revision = gitAttestation();
  calibration = heldCalibrationAttestation();
  prefixCalibration = livePrefixCalibrationAttestation();
  activeContextGate = activeContextEnabled();
  const modelRuntime = await ModelRuntime.create();
  const discoveredModel = modelRuntime.getModel("openai-codex", "gpt-5.6-sol");
  assert(discoveredModel, "openai-codex/gpt-5.6-sol is unavailable");
  assert(discoveredModel.contextWindow === EXPECTED_CONTEXT_WINDOW,
    `Model window drifted: ${discoveredModel.contextWindow}`);
  const calibratedGuidanceTokens = Math.ceil(
    contextRuntime.ACTIVE_CONTEXT_POLICY.guidanceRatio * EXPECTED_CONTEXT_WINDOW,
  );
  const calibratedUrgentTokens = Math.ceil((
    contextRuntime.ACTIVE_CONTEXT_POLICY.warningRatio +
    (contextRuntime.ACTIVE_CONTEXT_POLICY.toolFoldRatio -
      contextRuntime.ACTIVE_CONTEXT_POLICY.warningRatio) / 2
  ) * EXPECTED_CONTEXT_WINDOW);
  const calibratedAutomaticToolTokens = Math.ceil(
    contextRuntime.ACTIVE_CONTEXT_POLICY.toolFoldRatio * EXPECTED_CONTEXT_WINDOW,
  );
  assert(prefixCalibration.thresholds.urgentTokens === calibratedUrgentTokens &&
    prefixCalibration.thresholds.automaticToolTokens === calibratedAutomaticToolTokens &&
    prefixCalibration.projectedHighWaterTokens >= calibratedUrgentTokens &&
    prefixCalibration.projectedHighWaterTokens < calibratedAutomaticToolTokens,
  `Live-prefix calibration misses the urgent-to-automatic window: ${JSON.stringify(prefixCalibration)}`);
  const model = { ...discoveredModel, maxTokens: BOUNDED_OUTPUT_TOKENS };
  const chain = await writeEvidenceChain(runDir);
  const requestedChainPaths = new Set();

  manager = SessionManager.create(PROJECT, runDir);
  appendSeedHistory(manager);
  workloadPrompt = blindWorkloadPrompt(chain.firstPath);
  workload = blindWorkloadAttestation(manager, chain, workloadPrompt);
  const seededEstimate = estimateContextTokens(manager.buildSessionContext().messages).tokens;
  const promptStartEntries = manager.getEntries().length;

  if (process.env.QUORUM_CANARY_DRY_RUN === "1") {
    const adaptiveProbe = chain.closeAt(chain.paths[CALIBRATED_PREFIX_FILES - 1]);
    const adaptiveProbeBody = readFileSync(adaptiveProbe.path, "utf8");
    assert(adaptiveProbe.file === CALIBRATED_PREFIX_FILES &&
      adaptiveProbeBody.length === CHAIN_FILE_CHARS && adaptiveProbeBody.endsWith("\nNEXT: END\n"),
    "Adaptive chain cutoff probe failed");
    report = {
      ok: true, dryRun: true, acceptance: false, preflightOnly: true,
      runDir, reportPath, piVersion, revision, calibration, prefixCalibration, activeContextGate,
      behavioralMode: BEHAVIORAL_CANARY_MODE,
      workload,
      sessionFile: manager.getSessionFile(), seededEstimate,
      model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      chain: {
        files: chain.paths.length,
        calibratedPrefixFiles: CALIBRATED_PREFIX_FILES,
        firstPath: chain.firstPath,
        markers: chain.markers,
        adaptiveStopTokens: calibratedGuidanceTokens,
        automaticAbortTokens: calibratedAutomaticToolTokens,
        adaptiveProbe: { ...adaptiveProbe, bytes: adaptiveProbeBody.length, next: "END" },
      },
      nativeCounts: nativeCounts(manager),
    };
  } else {
    assert(activeContextGate, "Live canary refuses to run while ACTIVE_CONTEXT_ENABLED is false");
    const created = await createAgentSession({
      cwd: PROJECT, sessionManager: manager, modelRuntime, model, thinkingLevel: "minimal",
    });
    session = created.session;
    assert(!(created.extensionsResult?.errors ?? []).length,
      `Extension load errors: ${JSON.stringify(created.extensionsResult.errors)}`);
    await session.bindExtensions({ mode: "print" });
    const settings = session.settingsManager.getCompactionSettings();
    assert(settings.enabled === false,
      `Stock Pi automatic compaction must be disabled: ${JSON.stringify(settings)}`);
    assert(settings.reserveTokens === EXPECTED_RESERVE_TOKENS,
      `Effective reserve drifted: ${JSON.stringify(settings)}`);
    assert(session.model?.contextWindow === EXPECTED_CONTEXT_WINDOW &&
      session.model?.maxTokens === BOUNDED_OUTPUT_TOKENS,
    `Bounded model was not installed: ${JSON.stringify(session.model)}`);
    const automaticToolTokens = calibratedAutomaticToolTokens;
    const chainPathSet = new Set(chain.paths);
    const contextTool = session.agent.state.tools.find((tool) => tool.name === "quorum_context");
    assert(contextTool, "Fresh runtime lacks quorum_context");
    session.setActiveToolsByName(["read", "quorum_context"]);
    assert(JSON.stringify(session.getActiveToolNames().sort()) === JSON.stringify(["quorum_context", "read"]),
      `Canary tool surface drifted: ${session.getActiveToolNames().join(",")}`);
    session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        compactionEvents.push(structuredClone(event));
      }
      if (event.type === "message_end") {
        const message = event.message;
        const checkpointTokens = message?.role === "assistant" && message.provider === model.provider &&
          message.model === model.id ? measuredTokens(message) : null;
        if (checkpointTokens !== null) {
          providerCheckpointEvents += 1;
          const readCall = Array.isArray(message.content) ? message.content.find((part) =>
            part?.type === "toolCall" && part.name === "read" &&
            typeof part.arguments?.path === "string" && chainPathSet.has(part.arguments.path)) : null;
          const readPath = readCall?.arguments?.path ?? null;
          const firstRequestForPath = readPath !== null && !requestedChainPaths.has(readPath);
          if (checkpointTokens >= automaticToolTokens) {
            pressureAbortFired = true;
            void session.abort();
          } else {
            if (checkpointTokens >= calibratedGuidanceTokens) awarenessSeen = true;
            if (awarenessSeen && customEntries(
              manager, contextRuntime.GUIDANCE_OBLIGATION_ACTION_ENTRY,
            ).length >= REQUIRED_AGENT_FOLDS) pressureStopRequested = true;
            if (pressureStopRequested && firstRequestForPath && chain.cutoffIndex === null) {
              try {
                if (!chain.closeAt(readPath)) throw new Error(`Unknown adaptive chain path ${readPath}`);
              } catch (error) {
                adaptiveCutoffError = error instanceof Error ? error.message : String(error);
                void session.abort();
              }
            }
            if (providerCheckpointEvents > MAX_PROVIDER_CHECKPOINTS) void session.abort();
          }
          if (readPath !== null) requestedChainPaths.add(readPath);
        }
      }
    });

    const prompt = workloadPrompt;
    const deadline = setTimeout(() => {
      deadlineFired = true;
      void session.abort();
    }, CANARY_DEADLINE_MS);
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
    } finally {
      clearTimeout(deadline);
    }
    const entries = manager.getEntries();
    const runEntries = entries.slice(promptStartEntries);
    const runEntryIndex = new Map(runEntries.map((entry, index) => [entry.id, index]));
    const foldCalls = toolCalls(runEntries, "quorum_context", "fold", model.provider, model.id);
    const statusCalls = toolCalls(runEntries, "quorum_context", "status", model.provider, model.id);
    const readCalls = toolCalls(runEntries, "read", undefined, model.provider, model.id);
    const pairedReadResults = readCalls.map((call) => {
      const callIndex = runEntryIndex.get(call.entryId);
      const result = runEntries.slice(callIndex + 1).find((entry) => {
        const message = entry.type === "message" ? entry.message : null;
        return message?.role === "toolResult" && message.toolCallId === call.id &&
          message.toolName === "read";
      });
      assert(result?.message?.isError === false,
        `Read call ${call.id} lacks a successful result`);
      const text = (Array.isArray(result.message.content) ? result.message.content : [])
        .map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
      return { ...call, callIndex, resultIndex: runEntryIndex.get(result.id), text };
    });
    const completedChainFiles = chain.cutoffIndex === null ? 0 : chain.cutoffIndex + 1;
    const stageResults = chain.paths.slice(0, completedChainFiles).map((path, index) => {
      const reads = pairedReadResults.filter((item) => item.arguments?.path === path);
      assert(reads.length > 0, `Adaptive chain stage ${index + 1} has no successful read result`);
      const next = index + 1 < completedChainFiles ? chain.paths[index + 1] : "END";
      const pointer = reads.find((item) => item.text.includes(`NEXT: ${next}`));
      assert(pointer, `Adaptive chain stage ${index + 1} lacks its successful NEXT result`);
      return { path, next, pointer };
    });
    for (let index = 1; index < stageResults.length; index += 1) {
      const firstCall = Math.min(...pairedReadResults
        .filter((item) => item.arguments?.path === stageResults[index].path)
        .map((item) => item.callIndex));
      assert(firstCall > stageResults[index - 1].pointer.resultIndex,
        `Adaptive chain stage ${index + 1} began before stage ${index} completed`);
    }
    const assistants = runEntries.filter((entry) => entry.type === "message" &&
      entry.message?.role === "assistant" && entry.message.provider === model.provider &&
      entry.message.model === model.id && measuredTokens(entry.message) !== null);
    const observedProviderTokens = assistants.map((entry) => measuredTokens(entry.message));
    observations = {
      branchEntries: entries.length,
      runEntries: runEntries.length,
      readCalls: readCalls.length,
      successfulReadResults: pairedReadResults.length,
      statusCalls: statusCalls.length,
      foldCalls: foldCalls.length,
      completedChainFiles,
      maxChainFiles: MAX_CHAIN_FILES,
      chainCutoffFile: chain.cutoffIndex === null ? null : chain.cutoffIndex + 1,
      pressureStopRequested,
      awarenessSeen,
      adaptiveCutoffError,
      providerTokens: observedProviderTokens,
      providerCheckpointEvents,
      maxProviderCheckpoints: MAX_PROVIDER_CHECKPOINTS,
      deadlineMs: CANARY_DEADLINE_MS,
      deadlineFired,
      pressureAbortFired,
      highWaterTokens: observedProviderTokens.length ? Math.max(...observedProviderTokens) : null,
      nativeCounts: nativeCounts(manager),
      compactionEvents: structuredClone(compactionEvents),
      customEntryCounts: {
        states: customEntries(manager, identity.QUORUM_STATE_ENTRY).length,
        foldRecords: customEntries(manager, identity.QUORUM_FOLD_RECORD_ENTRY).length,
        guidance: customEntries(manager, contextRuntime.GUIDANCE_DELIVERY_ENTRY).length,
        guidanceActions: customEntries(manager, contextRuntime.GUIDANCE_OBLIGATION_ACTION_ENTRY).length,
        guidanceReductions: customEntries(manager, contextRuntime.GUIDANCE_REDUCTION_ENTRY).length,
        guidanceFallbacks: customEntries(manager, contextRuntime.GUIDANCE_AUTOMATIC_FALLBACK_ENTRY).length,
        providerMeasurements: customEntries(manager, identity.QUORUM_PROVIDER_CONTEXT_MEASUREMENT_ENTRY).length,
      },
    };
    assert(!deadlineFired, `Canary exceeded its ${CANARY_DEADLINE_MS}ms deadline`);
    assert(adaptiveCutoffError === null, `Adaptive chain cutoff failed: ${adaptiveCutoffError}`);
    assert(!pressureAbortFired,
      `Canary reached the ${calibratedAutomaticToolTokens}-token automatic rung and was aborted`);
    assert(providerCheckpointEvents <= MAX_PROVIDER_CHECKPOINTS,
      `Canary exceeded ${MAX_PROVIDER_CHECKPOINTS} provider checkpoints`);
    assert(pressureStopRequested && chain.cutoffIndex !== null,
      "Adaptive chain never closed after awareness and two attributed folds");
    assert(completedChainFiles >= MIN_CHAIN_FILES && completedChainFiles === stageResults.length,
      `Agent did not traverse the adaptive chain contiguously: ${completedChainFiles}/${stageResults.length}`);
    assert(readCalls.length >= completedChainFiles,
      `Agent did not traverse the complete adaptive chain: ${readCalls.length}/${completedChainFiles}`);
    assert(statusCalls.length >= REQUIRED_AGENT_FOLDS,
      `Agent did not repeatedly inspect context in-turn: ${statusCalls.length}`);
    assert(foldCalls.length >= REQUIRED_AGENT_FOLDS,
      `Agent did not perform repeated in-turn folds: ${foldCalls.length}/${REQUIRED_AGENT_FOLDS}`);

    assert(assistants.length >= completedChainFiles,
      `Too few real provider checkpoints for a marathon turn: ${assistants.length}`);
    assert(assistants.at(-1).message.stopReason === "stop",
      `Marathon did not end in a terminal assistant response: ${assistants.at(-1).message.stopReason}`);
    const providerTokens = observedProviderTokens;
    const highWaterTokens = Math.max(...providerTokens);
    const chapterTokens = model.contextWindow - settings.reserveTokens;
    const guidanceTokens = Math.ceil(contextRuntime.ACTIVE_CONTEXT_POLICY.guidanceRatio * model.contextWindow);
    const actionTokens = Math.ceil(contextRuntime.ACTIVE_CONTEXT_POLICY.warningRatio * model.contextWindow);
    const urgentTokens = Math.ceil((
      contextRuntime.ACTIVE_CONTEXT_POLICY.warningRatio +
      (contextRuntime.ACTIVE_CONTEXT_POLICY.toolFoldRatio - contextRuntime.ACTIVE_CONTEXT_POLICY.warningRatio) / 2
    ) * model.contextWindow);
    assert(providerTokens[0] < guidanceTokens,
      `Protected seed started above guidance instead of crossing it live: ${providerTokens[0]}/${guidanceTokens}`);
    assert(highWaterTokens >= guidanceTokens,
      `Marathon never crossed awareness pressure: ${highWaterTokens}/${guidanceTokens}`);
    assert(highWaterTokens < automaticToolTokens,
      `Agent reached the 75% automatic tool rung: ${highWaterTokens}/${automaticToolTokens}`);
    assert(highWaterTokens < chapterTokens,
      `Agent reached the final Quorum rung: ${highWaterTokens}/${chapterTokens}`);
    assert(providerTokens.some((tokens, index) => index > 0 && tokens < providerTokens[index - 1]),
      "No provider-confirmed context reduction followed an agent fold");

    const runner = session.extensionRunner;
    const statusResult = await contextTool.execute(
      randomUUID(), { action: "status", offset: 0, limit: 10 },
      new AbortController().signal, undefined, runner.createContext(),
    );
    assert(statusResult?.isError !== true, `Final quorum_context status failed: ${JSON.stringify(statusResult)}`);
    const status = statusResult.details;
    const state = contextRuntime.materializeActiveContextState(manager.getBranch(), manager.getSessionId(),
      identity.QUORUM_STATE_ENTRY, identity.QUORUM_FOLD_RECORD_ENTRY);
    const guidanceDeliveryEntries = customEntries(manager, contextRuntime.GUIDANCE_DELIVERY_ENTRY)
      .map((entry) => ({
        entry,
        receipt: contextRuntime.parseGuidanceDelivery(entry.data, manager.getSessionId()),
      }));
    const guidanceDeliveries = guidanceDeliveryEntries.map(({ receipt }) => receipt);
    const guidanceActionReceipts = customEntries(manager, contextRuntime.GUIDANCE_OBLIGATION_ACTION_ENTRY)
      .map((entry) => contextRuntime.parseGuidanceObligationActionReceipt(
        entry.data, manager.getSessionId(),
      ));
    const guidanceReductionReceipts = customEntries(manager, contextRuntime.GUIDANCE_REDUCTION_ENTRY)
      .map((entry) => contextRuntime.parseGuidanceReductionReceipt(entry.data, manager.getSessionId()));
    const guidanceFallbackReceipts = customEntries(
      manager, contextRuntime.GUIDANCE_AUTOMATIC_FALLBACK_ENTRY,
    ).map((entry) => contextRuntime.parseGuidanceAutomaticFallbackReceipt(
      entry.data, manager.getSessionId(),
    ));
    assert(guidanceDeliveries.length >= REQUIRED_AGENT_FOLDS,
      `Provider-confirmed guidance deliveries are absent: ${JSON.stringify(guidanceDeliveries)}`);
    assert(guidanceActionReceipts.length >= REQUIRED_AGENT_FOLDS &&
      guidanceDeliveries.length === guidanceActionReceipts.length &&
      new Set(guidanceActionReceipts.map((receipt) => receipt.receiptKey)).size === guidanceActionReceipts.length &&
      new Set(guidanceActionReceipts.map((receipt) => receipt.deliveryKey)).size === guidanceActionReceipts.length &&
      new Set(guidanceActionReceipts.map((receipt) => receipt.toolCallId)).size === guidanceActionReceipts.length &&
      new Set(guidanceActionReceipts.map((receipt) => receipt.foldId)).size === guidanceActionReceipts.length,
    `Immutable guidance action receipts are incomplete or ambiguous: ${JSON.stringify(guidanceActionReceipts)}`);
    assert(guidanceReductionReceipts.length === guidanceActionReceipts.length &&
      new Set(guidanceReductionReceipts.map((receipt) => receipt.receiptKey)).size === guidanceReductionReceipts.length &&
      new Set(guidanceReductionReceipts.map((receipt) => receipt.actionReceiptKey)).size === guidanceReductionReceipts.length,
    `Guidance reductions do not map one-to-one onto actions: ${JSON.stringify(guidanceReductionReceipts)}`);
    assert(guidanceFallbackReceipts.length === 0,
      `Automatic context fallback fired: ${JSON.stringify(guidanceFallbackReceipts)}`);
    assert(status.automatic?.lastAutomaticAction === null,
      `Automatic rung fired instead of agent management: ${JSON.stringify(status.automatic?.lastAutomaticAction)}`);

    const fullEntryIndex = new Map(entries.map((entry, index) => [entry.id, index]));
    const runEntryIds = new Set(runEntryIndex.keys());
    const successfulFoldResults = foldCalls.flatMap((call) => {
      const callIndex = runEntryIndex.get(call.entryId);
      if (callIndex === undefined) return [];
      return runEntries.flatMap((entry, resultIndex) => {
        const message = entry.type === "message" ? entry.message : null;
        return resultIndex > callIndex && message?.role === "toolResult" && message.toolCallId === call.id &&
          message.toolName === "quorum_context" && message.isError === false &&
          message.details?.action === "fold" && typeof message.details?.id === "string"
          ? [{ call, callIndex, resultEntryId: entry.id, resultIndex, foldId: message.details.id }]
          : [];
      });
    });
    assert(successfulFoldResults.length >= REQUIRED_AGENT_FOLDS,
      `Model-origin fold calls did not produce repeated successful fold results: ${successfulFoldResults.length}`);
    assert(new Set(successfulFoldResults.map((item) => item.foldId)).size === successfulFoldResults.length,
      `Model-origin fold IDs are not unique: ${JSON.stringify(successfulFoldResults)}`);
    const stateFoldIds = new Set(state.folds.map((fold) => fold.id));
    assert(state.folds.length === successfulFoldResults.length &&
      successfulFoldResults.every((item) => stateFoldIds.has(item.foldId)),
    `Durable folds differ from successful model-origin folds: ${JSON.stringify(successfulFoldResults)}`);

    const causalFolds = successfulFoldResults.map((item) => {
      const fold = state.folds.find((candidate) => candidate.id === item.foldId);
      const callEntry = runEntries[item.callIndex];
      const callMessageSha256 = jsonRuntime.evidenceSha256(callEntry.message);
      const actionReceipt = guidanceActionReceipts.find((receipt) =>
        receipt.toolCallId === item.call.id && receipt.foldId === item.foldId &&
        receipt.toolResultEntryId === item.resultEntryId) ?? null;
      let delivery = null;
      let reduction = null;
      if (actionReceipt) {
        assert(actionReceipt.assistantEntryId === item.call.entryId &&
          actionReceipt.assistantMessageSha256 === callMessageSha256 &&
          actionReceipt.provider === model.provider && actionReceipt.model === model.id,
        `Fold ${item.foldId} action receipt is not bound to its provider/model assistant call`);
        delivery = guidanceDeliveryEntries.find(({ receipt }) =>
          receipt.deliveryKey === actionReceipt.deliveryKey) ?? null;
        assert(delivery, `Fold ${item.foldId} action receipt lacks its durable delivery`);
        contextRuntime.validateGuidanceObligationActionReceipt({
          receipt: actionReceipt,
          delivery: delivery.receipt,
          entries: manager.getBranch(),
          state,
          sessionId: manager.getSessionId(),
        });
        reduction = guidanceReductionReceipts.find((receipt) =>
          receipt.actionReceiptKey === actionReceipt.receiptKey) ?? null;
        assert(reduction, `Fold ${item.foldId} action receipt lacks its exact-revision reduction`);
        contextRuntime.validateGuidanceReductionReceipt({
          receipt: reduction,
          delivery: delivery.receipt,
          action: actionReceipt,
          entries: manager.getBranch(),
          state,
          sessionId: manager.getSessionId(),
        });
      }
      const refs = contextRuntime.flattenFoldRefs(fold, state);
      assert(refs.length > 0 && refs.every((ref) => runEntryIds.has(ref.entryId)),
        `Fold ${item.foldId} includes pre-prompt held evidence`);
      assert(refs.every((ref) => runEntryIndex.get(ref.entryId) < item.callIndex),
        `Fold ${item.foldId} includes evidence that did not precede its model call`);
      const resultFullIndex = fullEntryIndex.get(item.resultEntryId);
      assert(Number.isSafeInteger(resultFullIndex), `Fold ${item.foldId} result is absent from the canonical branch`);
      const durableStateEntry = entries.slice(0, resultFullIndex).reverse().find((entry) =>
        entry.type === "custom" && entry.customType === identity.QUORUM_STATE_ENTRY);
      const projectionRevision = durableStateEntry?.data?.revision;
      assert(Number.isSafeInteger(projectionRevision),
        `Fold ${item.foldId} lacks a preceding durable projection revision`);
      const measurementEntry = entries.slice(resultFullIndex + 1).find((entry) =>
        entry.type === "custom" && entry.customType === identity.QUORUM_PROVIDER_CONTEXT_MEASUREMENT_ENTRY &&
        entry.data?.provider === model.provider && entry.data?.model === model.id &&
        entry.data?.projectionRevision === projectionRevision && Number.isFinite(entry.data?.tokens) &&
        (reduction
          ? entry.data?.messageSha256 === reduction.afterMessageSha256
          : entry.data.tokens < item.call.tokens));
      assert(measurementEntry,
        `Fold ${item.foldId} lacks a later durable provider measurement for revision ${projectionRevision}`);
      assert(measurementEntry.data.tokens < item.call.tokens,
        `Fold ${item.foldId} has no provider-confirmed reduction: ${item.call.tokens} -> ${measurementEntry.data.tokens}`);
      if (reduction) {
        assert(reduction.afterMessageSha256 === measurementEntry.data.messageSha256 &&
          reduction.afterTokens === measurementEntry.data.tokens &&
          reduction.durableRevision === projectionRevision,
        `Fold ${item.foldId} reduction receipt differs from its provider measurement`);
      }
      const recovered = contextRuntime.recoverFoldMessages({
        foldId: fold.id, state, entries: manager.getBranch(), sessionId: manager.getSessionId(),
      });
      assert(recovered.length > 0, `Fold ${fold.id} did not recover exact Pi evidence`);
      return {
        foldId: fold.id,
        callEntryId: item.call.entryId,
        callMessageSha256,
        resultEntryId: item.resultEntryId,
        receiptKey: actionReceipt?.receiptKey ?? null,
        deliveryKey: delivery?.receipt.deliveryKey ?? null,
        reductionReceiptKey: reduction?.receiptKey ?? null,
        sourceEntryIds: refs.map((ref) => ref.entryId),
        projectionRevision,
        beforeTokens: item.call.tokens,
        afterTokens: measurementEntry.data.tokens,
        afterMeasurementSha256: measurementEntry.data.messageSha256,
        recoveredSha256: jsonRuntime.sha256Value(recovered),
      };
    });
    assert(new Set(causalFolds.map((item) => item.projectionRevision)).size === causalFolds.length,
      "Multiple accepted folds share one durable projection revision");
    assert(new Set(causalFolds.map((item) => item.afterMeasurementSha256)).size === causalFolds.length,
      "One provider measurement was reused to prove multiple fold reductions");
    const attributedCausalFolds = causalFolds.filter((item) => item.receiptKey !== null);
    assert(attributedCausalFolds.length === guidanceActionReceipts.length &&
      attributedCausalFolds.length >= REQUIRED_AGENT_FOLDS,
    "Guidance action receipts do not map one-to-one onto successful model folds");

    const independentManager = SessionManager.open(manager.getSessionFile(), undefined, PROJECT);
    const independentEntries = independentManager.getBranch();
    const independentState = contextRuntime.materializeActiveContextState(
      independentEntries, independentManager.getSessionId(),
    );
    const independentDeliveries = customEntries(
      independentManager, contextRuntime.GUIDANCE_DELIVERY_ENTRY,
    ).map((entry) => contextRuntime.parseGuidanceDelivery(
      entry.data, independentManager.getSessionId(),
    ));
    const independentActionReceipts = customEntries(
      independentManager, contextRuntime.GUIDANCE_OBLIGATION_ACTION_ENTRY,
    ).map((entry) => contextRuntime.parseGuidanceObligationActionReceipt(
      entry.data, independentManager.getSessionId(),
    ));
    const independentReductionReceipts = customEntries(
      independentManager, contextRuntime.GUIDANCE_REDUCTION_ENTRY,
    ).map((entry) => contextRuntime.parseGuidanceReductionReceipt(
      entry.data, independentManager.getSessionId(),
    ));
    const independentRecovery = attributedCausalFolds.map((item) => {
      const receipt = independentActionReceipts.find((candidate) => candidate.receiptKey === item.receiptKey);
      assert(receipt, `Independent reopen lost guidance action receipt ${item.receiptKey}`);
      const delivery = independentDeliveries.find((candidate) =>
        candidate.deliveryKey === receipt.deliveryKey);
      assert(delivery, `Independent reopen lost guidance delivery ${receipt.deliveryKey}`);
      contextRuntime.validateGuidanceObligationActionReceipt({
        receipt,
        delivery,
        entries: independentEntries,
        state: independentState,
        sessionId: independentManager.getSessionId(),
      });
      const reduction = independentReductionReceipts.find((candidate) =>
        candidate.actionReceiptKey === receipt.receiptKey);
      assert(reduction?.receiptKey === item.reductionReceiptKey,
        `Independent reopen lost guidance reduction ${item.reductionReceiptKey}`);
      contextRuntime.validateGuidanceReductionReceipt({
        receipt: reduction,
        delivery,
        action: receipt,
        entries: independentEntries,
        state: independentState,
        sessionId: independentManager.getSessionId(),
      });
      const recovered = contextRuntime.recoverFoldMessages({
        foldId: item.foldId,
        state: independentState,
        entries: independentEntries,
        sessionId: independentManager.getSessionId(),
      });
      const recoveredSha256 = jsonRuntime.sha256Value(recovered);
      assert(recoveredSha256 === item.recoveredSha256,
        `Independent reopen recovery drifted for ${item.foldId}`);
      return {
        foldId: item.foldId,
        receiptKey: item.receiptKey,
        reductionReceiptKey: reduction.receiptKey,
        recoveredSha256,
      };
    });
    assert(independentRecovery.length >= REQUIRED_AGENT_FOLDS,
      `Independent reopen recovered only ${independentRecovery.length} attributed folds`);

    const native = nativeCounts(manager);
    assert(native.compactions === 0 && native.decisions === 0 && native.receipts === 0,
      `Zero-native acceptance failed: ${JSON.stringify(native)}`);
    assert(compactionEvents.length === 0,
      `Stock Pi emitted compaction lifecycle events: ${JSON.stringify(compactionEvents)}`);
    const finalText = assistants.at(-1).message.content
      .filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const firstMarker = chain.markers[0];
    const lastMarker = chain.markers[completedChainFiles - 1];
    assert(finalText.includes(firstMarker) && finalText.includes(lastMarker) &&
      finalText.includes(`archive-${String(completedChainFiles).padStart(2, "0")}.txt`),
    `Final synthesis omitted the completed chain range: ${firstMarker}..${lastMarker}`);

    const providerCheckpoints = assistants.map((entry, index) => ({
      entryId: entry.id,
      timestamp: entry.message.timestamp,
      tokens: providerTokens[index],
      stopReason: entry.message.stopReason,
    }));
    const stageDurationsMs = providerCheckpoints.slice(1).map((item, index) =>
      item.timestamp - providerCheckpoints[index].timestamp);
    const elapsedMs = providerCheckpoints.at(-1).timestamp - providerCheckpoints[0].timestamp;
    report = {
      ok: true,
      acceptance: false,
      calibrationOnly: true,
      acceptanceReason: "This bounded behavioral calibration cannot authorize registration; acceptance requires a separate run lasting at least three wall-clock hours.",
      minimumAcceptanceDurationMs: MIN_ACCEPTANCE_DURATION_MS,
      elapsedMs,
      runDir,
      reportPath,
      sessionId: session.sessionId, sessionFile: manager.getSessionFile(),
      piVersion, revision, calibration, prefixCalibration, activeContextGate,
      behavioralMode: BEHAVIORAL_CANARY_MODE,
      workload,
      model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens },
      settings, seededEstimate, chapterTokens, guidanceTokens, actionTokens, urgentTokens, automaticToolTokens,
      firstProviderTokens: providerTokens[0], highWaterTokens, finalTokens: providerTokens.at(-1),
      providerTokens, providerCheckpoints, stageDurationsMs,
      providerCheckpointEvents, maxProviderCheckpoints: MAX_PROVIDER_CHECKPOINTS,
      deadlineMs: CANARY_DEADLINE_MS, deadlineFired, pressureAbortFired,
      pressureStopRequested, awarenessSeen, adaptiveCutoffError,
      completedChainFiles, maxChainFiles: MAX_CHAIN_FILES,
      chainCutoffFile: chain.cutoffIndex === null ? null : chain.cutoffIndex + 1,
      readCalls: readCalls.length, statusCalls: statusCalls.length, foldCalls: foldCalls.length,
      foldIds: state.folds.map((fold) => fold.id),
      modelOriginFoldIds: successfulFoldResults.map((item) => item.foldId),
      causalFolds,
      guidanceDeliveries,
      guidanceActionReceipts,
      guidanceReductionReceipts,
      guidanceFallbackReceipts,
      independentRecovery,
      nativeCounts: native, compactionEvents,
    };
  }
} catch (error) {
  report = {
    ok: false, acceptance: false, runDir, reportPath,
    revision, calibration, prefixCalibration, activeContextGate, observations,
    behavioralMode: BEHAVIORAL_CANARY_MODE,
    workload,
    sessionFile: manager?.getSessionFile?.() ?? null,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
    nativeCounts: nativeCounts(manager), compactionEvents,
  };
} finally {
  session?.dispose();
  try {
    await mkdir(join(reportPath, ".."), { recursive: true });
  } catch { /* reportPath parent was already created or fallback remains available */ }
  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    reportPath = fallbackReportPath;
    await writeFile(reportPath, `${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
  }
}

await new Promise((resolve, reject) => {
  process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
process.exit(report?.ok ? 0 : 1);
