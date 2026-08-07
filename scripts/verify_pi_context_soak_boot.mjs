#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SOAK_CALIBRATION_HEARTBEAT_MS,
  SOAK_CALIBRATION_STAGE_COUNT,
  SOAK_CALIBRATION_STAGE_INTERVAL_MS,
  SOAK_CALIBRATION_WATCHDOG_MS,
  SOAK_EXPECTED_TOOL_NAMES,
  SOAK_MODE_CALIBRATION,
  SOAK_PI_SUBAGENTS_ROOT,
  bootId,
  freshChallenge,
  monotonicMs,
  processStartTicks,
  readJson,
  readJsonLines,
  renderArchiveStage,
  sha256Json,
  sha256Text,
  soakSystemPrompt,
  validateRunConfig,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";
const PROJECT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
const jitiPath = join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs");
if (!existsSync(jitiPath)) throw new Error("Soak boot verifier cannot resolve stock-Pi jiti");
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
    typebox: join(PI_ROOT, "node_modules", "typebox", "build", "index.mjs"),
    "../../pi-subagents": SOAK_PI_SUBAGENTS_ROOT,
  },
});
const { createPiContextSoakExtension } = await jiti.import(
  join(PROJECT, "scripts", "pi_context_soak_extension.mjs"),
);
const { ACTIVE_CONTEXT_TOOL_ACTIONS } = await jiti.import(
  join(PROJECT, ".pi", "extensions", "quorum", "active-context.ts"),
);
const root = mkdtempSync("/home/shane/quorum-run/tmp/pi-context-soak-boot-");
for (const path of ["ipc", "ipc/requests", "ipc/responses"]) mkdirSync(join(root, path));
const runId = `2026-08-02T00-00-00Z-${freshChallenge().slice(0, 12)}`;
const sourceHashes = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
  `source-${index}`,
  String(index + 1).padStart(64, "0"),
]));
const config = validateRunConfig({
  version: 1,
  runId,
  runDir: join("/home/shane/quorum-run/state/ops/pi-context-hours-soak", runId),
  mode: SOAK_MODE_CALIBRATION,
  unit: "quorum-pi-context-soak-boot.service",
  invocationId: "1".repeat(32),
  supervisorPid: process.pid,
  supervisorStartTicks: processStartTicks(process.pid),
  bootId: bootId(),
  codeCommit: "2".repeat(40),
  codeTree: "3".repeat(40),
  firstChallenge: freshChallenge(),
  stageCount: SOAK_CALIBRATION_STAGE_COUNT,
  stageIntervalMs: SOAK_CALIBRATION_STAGE_INTERVAL_MS,
  minimumDurationMs: 0,
  watchdogMs: SOAK_CALIBRATION_WATCHDOG_MS,
  heartbeatMs: SOAK_CALIBRATION_HEARTBEAT_MS,
  createdWallMs: Date.now(),
  createdMonotonicMs: monotonicMs(),
  sourceHashes,
  dependencyHashes: {
    piPackageJson: "e".repeat(64),
    piDistTree: "f".repeat(64),
    piNodeModulesTree: "1".repeat(64),
    piSubagentsPackageJson: "3".repeat(64),
    piSubagentsSrcTree: "4".repeat(64),
    nodeExecutable: "2".repeat(64),
  },
  calibration: null,
});
config.runDir = root;
let session;
try {
  const isolatedSettings = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 16_384 },
    branchSummary: { skipPrompt: true },
  });
  const loader = new DefaultResourceLoader({
    cwd: PROJECT,
    agentDir: getAgentDir(),
    settingsManager: isolatedSettings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "You are a careful archival analyst.",
    appendSystemPrompt: [],
    extensionFactories: [createPiContextSoakExtension(config)],
  });
  await loader.reload();
  if (loader.getAppendSystemPrompt().length !== 0) {
    throw new Error("Soak boot discovered an external appended system prompt");
  }
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const model = runtime.getModel("openai-codex", "gpt-5.6-sol");
  if (!model || model.api !== "openai-codex-responses" ||
      model.baseUrl !== "https://chatgpt.com/backend-api" ||
      runtime.getRegisteredProviderConfig("openai-codex") !== undefined) {
    throw new Error("Soak boot did not isolate the built-in provider/model descriptor");
  }
  const manager = SessionManager.create(PROJECT, root);
  const created = await createAgentSession({
    cwd: PROJECT,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime: runtime,
    model: { ...model, maxTokens: 2_048 },
    settingsManager: isolatedSettings,
    thinkingLevel: "xhigh",
  });
  session = created.session;
  if ((created.extensionsResult?.errors ?? []).length) {
    throw new Error(`Soak boot extension errors: ${JSON.stringify(created.extensionsResult.errors)}`);
  }
  await session.bindExtensions({ mode: "print" });
  const tools = session.getActiveToolNames().sort();
  if (JSON.stringify(tools) !== JSON.stringify(SOAK_EXPECTED_TOOL_NAMES)) {
    throw new Error(`Soak boot tool inventory drifted: ${tools.join(",")}`);
  }
  const settings = session.settingsManager.getCompactionSettings();
  if (settings.enabled !== false) throw new Error("Soak boot enabled stock automatic compaction");
  const archiveTool = session.agent.state.tools.find((tool) => tool.name === "archive_stage");
  if (!archiveTool) throw new Error("Soak boot lacks archive_stage execution");
  const contextTool = session.agent.state.tools.find((tool) => tool.name === "quorum_context");
  const contextToolActions = contextTool?.parameters?.properties?.action?.enum;
  if (JSON.stringify(contextToolActions) !== JSON.stringify(ACTIVE_CONTEXT_TOOL_ACTIONS)) {
    throw new Error(`Soak boot active-context schema drifted: ${JSON.stringify(contextToolActions)}`);
  }
  const forbiddenContextAction = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "quorum_context",
    toolCallId: "boot-forbidden-unprotect",
    input: { action: "unprotect", ids: ["not-constructible"] },
  });
  const forbiddenContextActionRejected = forbiddenContextAction?.block === true;
  if (!forbiddenContextActionRejected) {
    throw new Error("Soak boot model policy allowed a forbidden context action");
  }
  let challenge = config.firstChallenge;
  const stageResults = [];
  for (let stage = 1; stage <= config.stageCount; stage += 1) {
    const toolCallId = `boot-stage-${stage}`;
    const allowed = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "archive_stage",
      toolCallId,
      input: { key: challenge },
    });
    if (allowed?.block) throw new Error(`Boot archive stage ${stage} was unexpectedly blocked`);
    const pending = archiveTool.execute(
      toolCallId,
      { key: challenge },
      new AbortController().signal,
      undefined,
      session.extensionRunner.createContext(),
    );
    const requestPath = join(root, "ipc", "requests", `stage-${String(stage).padStart(2, "0")}.json`);
    while (!existsSync(requestPath)) await new Promise((resolve) => setTimeout(resolve, 5));
    const request = readJson(requestPath);
    const nextChallenge = stage === config.stageCount ? "END" : String(stage + 10).padStart(64, "0");
    const content = renderArchiveStage(stage, nextChallenge);
    const responseBase = {
      version: 1, runId: config.runId, stage,
      challengeSha256: request.challengeSha256,
      requestSha256: request.requestSha256,
      content,
      contentSha256: sha256Text(content),
      nextChallenge,
      nextChallengeSha256: sha256Text(nextChallenge),
      releasedWallMs: Date.now(),
      releasedMonotonicMs: monotonicMs(),
    };
    writeJsonPublished(join(root, "ipc", "responses", `stage-${String(stage).padStart(2, "0")}.json`), {
      ...responseBase,
      paceRecordSha256: String(stage).padStart(64, "0"),
      responseSha256: sha256Json(responseBase),
    });
    const result = await pending;
    if (result.isError || result.details?.stage !== stage) throw new Error(`Boot IPC stage ${stage} failed`);
    stageResults.push(result.details.stage);
    challenge = nextChallenge;
  }
  const forbidden = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "read",
    toolCallId: "boot-forbidden-read",
    input: { path: "/tmp/forbidden" },
  });
  if (forbidden?.block !== true) throw new Error("Soak boot did not block a forbidden normal tool");
  await session.extensionRunner.emit({
    type: "session_before_compact",
    preparation: {},
    branchEntries: manager.getBranch(),
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  });
  const failureLatches = readJsonLines(join(root, "failure-latch.jsonl"));
  if (!failureLatches.some((entry) => entry.phase === "forbidden-tool") ||
      !failureLatches.some((entry) => entry.phase === "compaction-attempt")) {
    throw new Error("Soak boot failure latches did not observe forbidden/emergency paths");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    acceptance: false,
    preflightOnly: true,
    extensionErrors: 0,
    activeTools: tools,
    contextToolActions,
    forbiddenContextActionRejected,
    compactionEnabled: settings.enabled,
    isolatedSystemPrompt: session.systemPrompt.includes("careful archival analyst"),
    configuredSystemPromptSha256: sha256Text(soakSystemPrompt()),
    effectiveSystemPromptSha256: sha256Text(session.systemPrompt),
    projectContextAbsent: !session.systemPrompt.includes("THE WIKI IS THE BIBLE") &&
      !session.systemPrompt.includes("three wall-clock hours"),
    appendedSystemPromptCount: loader.getAppendSystemPrompt().length,
    modelConfigIsolated: true,
    ipcStages: stageResults,
    normalToolEventsObserved: true,
    forbiddenToolBlocked: true,
    compactionAttemptLatched: true,
  }, null, 2)}\n`);
} finally {
  session?.dispose();
  rmSync(root, { recursive: true, force: true });
}
