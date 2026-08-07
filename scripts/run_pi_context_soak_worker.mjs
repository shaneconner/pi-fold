#!/usr/bin/env node

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SOAK_BEHAVIORAL_MODE,
  SOAK_EXPECTED_TOOL_NAMES,
  SOAK_MARKER_ENTRY,
  SOAK_MODEL_CONTEXT_ACTIONS,
  SOAK_MODE_ACCEPTANCE,
  SOAK_PI_SUBAGENTS_ROOT,
  SOAK_RUNNER_MODE,
  SOAK_TERMINAL_STABILIZATION_MS,
  SOAK_TOOL_NAME,
  assertBlindVisibleText,
  assertSanitizedRuntimeEnvironment,
  assertSoak,
  directoryTreeSha256,
  fileSha256,
  monotonicMs,
  processStartTicks,
  renderSoakPrompt,
  sha256Json,
  sha256Text,
  soakSystemPrompt,
  validateRunConfig,
  verifySourceHashes,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const configPath = process.argv[2];
assertSoak(configPath && existsSync(configPath), "Soak worker requires a run config path");
const config = validateRunConfig(JSON.parse(readFileSync(configPath, "utf8")));
assertSanitizedRuntimeEnvironment(process.env);
assertSoak(process.ppid === config.supervisorPid && processStartTicks(process.ppid) === config.supervisorStartTicks,
  "Soak worker is not a direct child of the attested supervisor");
const workerDependencyHashes = {
  piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
  piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
  piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
  piSubagentsPackageJson: fileSha256(join(SOAK_PI_SUBAGENTS_ROOT, "package.json")),
  piSubagentsSrcTree: directoryTreeSha256(join(SOAK_PI_SUBAGENTS_ROOT, "src")),
  nodeExecutable: fileSha256(process.execPath),
};
assertSoak(JSON.stringify(workerDependencyHashes) === JSON.stringify(config.dependencyHashes),
  "Soak worker dependency hashes differ from its supervisor attestation");
verifySourceHashes(PROJECT, config.sourceHashes);

const {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
const jitiPath = join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs");
assertSoak(jitiPath, "Soak worker cannot resolve jiti");
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
const {
  ACTIVE_CONTEXT_TOOL_ACTIONS,
  ADVISORY_BUDGETS,
  materializeActiveContextState,
  parseProviderContextMeasurementReceipt,
  recoverFoldMessages,
} = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "active-context.ts"));
const {
  QUORUM_PROVIDER_CONTEXT_MEASUREMENT_ENTRY: PROVIDER_CONTEXT_MEASUREMENT_ENTRY,
  QUORUM_STATE_ENTRY,
  QUORUM_FOLD_RECORD_ENTRY,
} = await jiti.import(join(PROJECT, ".pi", "extensions", "quorum", "identity.js"));
verifySourceHashes(PROJECT, config.sourceHashes);
assertSoak(JSON.stringify(workerDependencyHashes) === JSON.stringify({
  piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
  piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
  piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
  piSubagentsPackageJson: fileSha256(join(SOAK_PI_SUBAGENTS_ROOT, "package.json")),
  piSubagentsSrcTree: directoryTreeSha256(join(SOAK_PI_SUBAGENTS_ROOT, "src")),
  nodeExecutable: fileSha256(process.execPath),
}), "Soak runtime dependencies changed while loading the worker");

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
    const userText = `Archive inventory ${turn}; retain the exact factual record.`;
    const assistantText = paddedText(`RECENT_ARCHIVE_${turn}: `, 235_000);
    assertBlindVisibleText(`seed user ${turn}`, userText);
    assertBlindVisibleText(`seed assistant ${turn}`, assistantText);
    manager.appendMessage({ role: "user", content: userText, timestamp: timestamp++ });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      stopReason: "stop",
      usage: zeroUsage(),
      timestamp: timestamp++,
    });
  }
}

async function waitForDurableTerminalQuiescence(
  manager, session, expectedProvider, expectedModel,
  timeoutMs = SOAK_TERMINAL_STABILIZATION_MS,
) {
  const deadline = monotonicMs() + timeoutMs;
  let priorIdentity = null;
  let stableChecks = 0;
  let lastCounts = null;
  while (monotonicMs() < deadline) {
    const branch = manager.getBranch();
    const terminal = lastConversationalMessage(branch);
    const terminalMessage = terminal?.message;
    const messageSha256 = terminalMessage?.role === "assistant" ? sha256Json(terminalMessage) : null;
    const terminalIndex = terminal?.id
      ? branch.findIndex((entry) => entry?.id === terminal.id)
      : -1;
    const measurements = messageSha256 ? branch.flatMap((entry, index) => {
      if (entry?.type !== "custom" || entry.customType !== PROVIDER_CONTEXT_MEASUREMENT_ENTRY ||
          entry.data?.messageSha256 !== messageSha256) return [];
      return [{
        index,
        receipt: parseProviderContextMeasurementReceipt(entry.data, manager.getSessionId()),
      }];
    }) : [];
    lastCounts = { branchEntries: branch.length, terminalMeasurements: measurements.length };
    const terminalCalls = Array.isArray(terminalMessage?.content)
      ? terminalMessage.content.filter((part) => part?.type === "toolCall")
      : [];
    const measured = terminalIndex >= 0 && terminalMessage?.role === "assistant" &&
      terminalMessage.provider === expectedProvider && terminalMessage.model === expectedModel &&
      terminalMessage.stopReason === "stop" && terminalCalls.length === 0 &&
      measurements.length === 1 &&
      measurements[0].receipt.provider === expectedProvider &&
      measurements[0].receipt.model === expectedModel &&
      session.isStreaming === false && session.pendingMessageCount === 0;
    const identity = measured
      ? `${branch.length}:${terminal.id}:${measurements[0].index}`
      : null;
    if (identity && identity === priorIdentity) stableChecks += 1;
    else stableChecks = 0;
    if (measured && stableChecks >= 4) return { terminal, terminalMessage, counts: lastCounts };
    priorIdentity = identity;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Terminal provider state did not become durably quiescent: ${JSON.stringify(lastCounts)}`,
  );
}

function lastConversationalMessage(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "message") return entries[index];
  }
  return null;
}

const workerStartedWallMs = Date.now();
const workerStartedMonotonicMs = monotonicMs();
const workerPid = process.pid;
const workerStartTicks = processStartTicks(workerPid);
const readyPath = join(config.runDir, "worker-ready.json");
const reportPath = join(config.runDir, "worker-report.json");
const failurePath = join(config.runDir, "failure-latch.jsonl");
let manager;
let session;
let report;
let contextTool;
let deadlineFired = false;

try {
  const piVersion = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")).version;
  assertSoak(piVersion === "0.83.0", `Soak baseline drifted from stock Pi 0.83.0 to ${piVersion}`);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const discoveredModel = modelRuntime.getModel("openai-codex", "gpt-5.6-sol");
  assertSoak(discoveredModel?.contextWindow === 272_000 &&
    discoveredModel.api === "openai-codex-responses" &&
    discoveredModel.baseUrl === "https://chatgpt.com/backend-api" &&
    modelRuntime.getRegisteredProviderConfig("openai-codex") === undefined,
  "Soak built-in provider/model descriptor is unavailable or overlaid");
  const modelDescriptorSha256 = sha256Json(discoveredModel);
  const model = { ...discoveredModel, maxTokens: 2_048 };
  const systemPrompt = soakSystemPrompt();

  manager = SessionManager.create(PROJECT, config.runDir);
  appendSeedHistory(manager);
  const markerId = manager.appendCustomEntry(SOAK_MARKER_ENTRY, {
    version: 1,
    runId: config.runId,
    configSha256: fileSha256(configPath),
    createdWallMs: Date.now(),
  });

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
    systemPrompt,
    appendSystemPrompt: [],
    extensionFactories: [createPiContextSoakExtension(config)],
  });
  await loader.reload();
  assertSoak(loader.getAppendSystemPrompt().length === 0,
    "Soak resource loader discovered an external appended system prompt");
  const created = await createAgentSession({
    cwd: PROJECT,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime,
    model,
    settingsManager: isolatedSettings,
    thinkingLevel: "xhigh",
  });
  session = created.session;
  assertSoak(!(created.extensionsResult?.errors ?? []).length,
    `Soak extension load failed: ${JSON.stringify(created.extensionsResult?.errors)}`);
  await session.bindExtensions({ mode: "print" });
  const settings = session.settingsManager.getCompactionSettings();
  assertSoak(settings.enabled === false && settings.reserveTokens === 16_384,
    `Soak compaction settings drifted: ${JSON.stringify(settings)}`);
  const activeToolNames = session.getActiveToolNames().sort();
  const activeToolSet = new Set(activeToolNames);
  const toolInventory = session.agent.state.tools
    .filter((tool) => activeToolSet.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      label: tool.label ?? null,
      description: tool.description ?? null,
      parameters: tool.parameters ?? null,
      executionMode: tool.executionMode ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assertSoak(JSON.stringify(activeToolNames) === JSON.stringify(SOAK_EXPECTED_TOOL_NAMES),
    `Soak tool inventory drifted: ${activeToolNames.join(",")}`);
  contextTool = session.agent.state.tools.find((tool) => tool.name === "quorum_context");
  const contextToolActions = contextTool?.parameters?.properties?.action?.enum;
  assertSoak(JSON.stringify(contextToolActions) === JSON.stringify(ACTIVE_CONTEXT_TOOL_ACTIONS),
    `Soak quorum_context action schema drifted: ${JSON.stringify(contextToolActions)}`);

  const prompt = renderSoakPrompt(config.firstChallenge);
  writeJsonExclusive(readyPath, {
    version: 1,
    runId: config.runId,
    workerPid,
    workerStartTicks,
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    markerId,
    activeToolNames,
    contextToolActions,
    toolInventorySha256: sha256Json(toolInventory),
    configuredSystemPromptSha256: sha256Text(systemPrompt),
    systemPromptSha256: sha256Text(session.systemPrompt),
    appendedSystemPromptCount: loader.getAppendSystemPrompt().length,
    promptSha256: sha256Text(prompt),
    readyWallMs: Date.now(),
    readyMonotonicMs: monotonicMs(),
  });

  const deadline = setTimeout(() => {
    deadlineFired = true;
    try {
      const fd = openSync(failurePath, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify({
          version: 1, runId: config.runId, phase: "worker-deadline", detail: config.watchdogMs,
          wallMs: Date.now(), monotonicMs: monotonicMs(),
        })}\n`);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch { /* The supervisor will also record the deadline. */ }
    void session.abort();
  }, config.watchdogMs);
  let terminalState;
  try {
    await session.prompt(prompt, { expandPromptTemplates: false });
    terminalState = await waitForDurableTerminalQuiescence(
      manager, session, model.provider, model.id,
    );
  } finally {
    clearTimeout(deadline);
  }

  const entries = manager.getBranch();
  const terminal = terminalState?.terminal ?? lastConversationalMessage(entries);
  const terminalMessage = terminalState?.terminalMessage ?? terminal?.message;
  assertSoak(!deadlineFired && terminalMessage?.role === "assistant" &&
    terminalMessage.provider === model.provider && terminalMessage.model === model.id &&
    terminalMessage.stopReason === "stop" &&
    (!Array.isArray(terminalMessage.content) || !terminalMessage.content.some((part) => part?.type === "toolCall")),
  "Soak worker did not end at one terminal provider stop");

  const finalStatus = await contextTool.execute(
    "soak-final-runtime-observation",
    { action: "status" },
    new AbortController().signal,
    undefined,
  );
  const finalStatusDetails = finalStatus?.details ?? {};
  assertSoak(finalStatusDetails.available === true,
    "Final active-context runtime status is unavailable");
  const activeState = materializeActiveContextState(entries, manager.getSessionId(),
    QUORUM_STATE_ENTRY, QUORUM_FOLD_RECORD_ENTRY);
  const advisory = activeState.advisory ?? { highWater: 0, delivered: {} };
  for (const [milestone, delivered] of Object.entries(advisory.delivered)) {
    assertSoak(delivered <= ADVISORY_BUDGETS[milestone],
      `Advisory milestone ${milestone} exceeded its delivery budget`);
  }
  const foldRecoveries = activeState.folds.map((fold) => ({
    foldId: fold.id,
    sha256: sha256Json(recoverFoldMessages({
      foldId: fold.id,
      state: activeState,
      entries,
      sessionId: manager.getSessionId(),
    })),
  }));

  report = {
    ok: true,
    acceptance: false,
    acceptanceCandidate: config.mode === SOAK_MODE_ACCEPTANCE,
    requiresIndependentAdjudication: true,
    version: 1,
    runId: config.runId,
    runnerMode: SOAK_RUNNER_MODE,
    behavioralMode: SOAK_BEHAVIORAL_MODE,
    workerPid,
    workerStartTicks,
    workerStartedWallMs,
    workerStartedMonotonicMs,
    workerFinishedWallMs: Date.now(),
    workerFinishedMonotonicMs: monotonicMs(),
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    markerId,
    piVersion,
    model: {
      provider: model.provider,
      id: model.id,
      api: model.api,
      baseUrl: model.baseUrl,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      descriptorSha256: modelDescriptorSha256,
    },
    thinkingLevel: "xhigh",
    settings,
    contextToolActions,
    modelContextActionAllowlist: [...SOAK_MODEL_CONTEXT_ACTIONS],
    finalRuntimeObservation: {
      pressureRatio: finalStatusDetails.automatic?.pressureRatio ?? null,
      hardFenceRatio: finalStatusDetails.automatic?.hardFenceRatio ?? null,
      providerMeasurement: finalStatusDetails.automatic?.providerMeasurement ?? null,
      automaticSuspended: finalStatusDetails.automatic?.automaticSuspended ?? null,
      advisory,
      foldCount: activeState.folds.length,
      foldRecoveries,
    },
    terminal: {
      entryId: terminal.id,
      stopReason: terminalMessage.stopReason,
      messageSha256: sha256Json(terminalMessage),
    },
    deadlineFired,
  };
} catch (error) {
  report = {
    ok: false,
    acceptance: false,
    acceptanceCandidate: false,
    requiresIndependentAdjudication: true,
    version: 1,
    runId: config.runId,
    workerPid,
    workerStartTicks,
    workerStartedWallMs,
    workerStartedMonotonicMs,
    workerFinishedWallMs: Date.now(),
    workerFinishedMonotonicMs: monotonicMs(),
    sessionId: manager?.getSessionId?.() ?? null,
    sessionFile: manager?.getSessionFile?.() ?? null,
    deadlineFired,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
  };
  process.exitCode = 1;
} finally {
  session?.dispose();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  acceptance: false,
  acceptanceCandidate: report.acceptanceCandidate,
  runId: config.runId,
  reportPath,
  sessionFile: report.sessionFile,
})}\n`);
