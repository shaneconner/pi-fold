#!/usr/bin/env node

// One fold-vs-compaction run of one arm: a single real Pi session, one user message,
// externally paced stages, artifact-only evidence. Derived from
// the retired soak worker (in git history through 09a4ea5); the session-driving
// machinery is unchanged and
// the archive stages are replaced by the staged repo-comprehension workload.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_BEHAVIORAL_MODE,
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_MARKER_ENTRY,
  closedBookPrompt,
  closedBookQuestions,
  closedBookSystemPrompt,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_RUNNER_MODE,
  EXPERIMENT_TERMINAL_STABILIZATION_MS,
  EXPERIMENT_TOOL_NAME,
  armRuntimeConfiguration,
  assertExperiment,
  corpusManifestSha256,
  isWindowOverflow,
  validateExperimentManifest,
  validateExperimentRunConfig,
  validateStagePlan,
} from "./lib/pi_context_experiment.mjs";
import {
  assertSanitizedRuntimeEnvironment,
  directoryTreeSha256,
  fileSha256,
  monotonicMs,
  PI_INSTALL_ROOT,
  processStartTicks,
  readJson,
  sha256Json,
  sha256Text,
  verifySourceHashes,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = PI_INSTALL_ROOT;
const configPath = process.argv[2];
assertExperiment(configPath && existsSync(configPath), "Experiment worker requires a run config path");
const config = validateExperimentRunConfig(JSON.parse(readFileSync(configPath, "utf8")));
assertSanitizedRuntimeEnvironment(process.env);
assertExperiment(process.ppid === config.supervisorPid &&
  processStartTicks(process.ppid) === config.supervisorStartTicks,
"Experiment worker is not a direct child of the attested supervisor");

const workerDependencyHashes = {
  piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
  piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
  piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
  nodeExecutable: fileSha256(process.execPath),
};
assertExperiment(JSON.stringify(workerDependencyHashes) === JSON.stringify(config.dependencyHashes),
  "Experiment worker dependency hashes differ from its supervisor attestation");
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
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
    typebox: join(PI_ROOT, "node_modules", "typebox", "build", "index.mjs"),
  },
});
const { createPiContextExperimentExtension } = await jiti.import(
  join(PROJECT, "scripts", "pi_context_experiment_extension.mjs"),
);
const { materializeActiveContextState, recoverFoldMessages } = await jiti.import(
  join(PROJECT, "extensions", "active-context.ts"),
);
const { PI_FOLD_STATE_ENTRY, PI_FOLD_FOLD_RECORD_ENTRY } = await jiti.import(
  join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs"),
);
verifySourceHashes(PROJECT, config.sourceHashes);

// A closed-book session runs the SAME worker scaffolding (readiness, watchdog,
// quiescence, manifest, report) with the workload swapped for the bare question
// list: no extension, no tools, no checkout, one user message.
const closedBook = config.sessionType === EXPERIMENT_CLOSED_BOOK_LABEL;
const armRuntime = closedBook
  ? { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: false }
  : armRuntimeConfiguration(config.arm);
const plan = validateStagePlan(readJson(config.planPath));
assertExperiment(plan.planSha256 === config.planSha256 && plan.mode === config.mode &&
  plan.repo.commit === config.targetCommit, "Stage plan does not match the run config pin");

// Pin the checkout: every byte this run will read is the byte that was staged.
// A closed-book session has no checkout to pin; its corpus statement is the plan's.
const stagedFiles = plan.stages.flatMap((stage) => stage.files);
const observed = closedBook ? [] : stagedFiles.map((file) => {
  const path = join(config.repoDir, file.path);
  assertExperiment(existsSync(path), `Pinned checkout is missing ${file.path}`);
  return { path: file.path, sha256: sha256Text(readFileSync(path, "utf8")) };
});
const checkoutSha256 = closedBook ? null : corpusManifestSha256(observed);
assertExperiment(closedBook || checkoutSha256 === config.targetTreeSha256,
  "Pinned checkout does not reproduce the staged corpus fingerprint");

function workloadSystemPrompt() {
  return [
    "You are a careful software analyst carrying out one continuous repository comprehension",
    "assignment. Read what you are given accurately, keep an exact working memory of the",
    "identifiers, paths and line positions you have seen, cross-reference new material against",
    "earlier material, and write the deliverables you are asked for. Work in one continuous run",
    "and finish only after the assignment ends.",
  ].join(" ");
}

function workloadPrompt(firstChallenge) {
  return [
    `Begin the staged repository assignment with key ${firstChallenge}.`,
    `Call ${EXPERIMENT_TOOL_NAME} with the current key to receive each stage, carry out that`,
    "stage's instructions in full, and follow each NEXT_KEY until END.",
    "You may use the read tool on files inside this checkout whenever you need to.",
    "Do not skip, guess, duplicate, or combine stages. Finish with a short closing synthesis.",
    "Complete this as one continuous run.",
  ].join(" ");
}

function lastConversationalMessage(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "message") return entries[index];
  }
  return null;
}

async function waitForDurableTerminalQuiescence(manager, session, timeoutMs = EXPERIMENT_TERMINAL_STABILIZATION_MS) {
  const deadline = monotonicMs() + timeoutMs;
  let priorIdentity = null;
  let stableChecks = 0;
  while (monotonicMs() < deadline) {
    const branch = manager.getBranch();
    const terminal = lastConversationalMessage(branch);
    const message = terminal?.message;
    const settled = message?.role === "assistant" && session.isStreaming === false &&
      session.pendingMessageCount === 0;
    const identity = settled ? `${branch.length}:${terminal.id}` : null;
    if (identity && identity === priorIdentity) stableChecks += 1;
    else stableChecks = 0;
    if (settled && stableChecks >= 4) return { terminal, terminalMessage: message };
    priorIdentity = identity;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Terminal provider state did not become durably quiescent");
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
let deadlineFired = false;
let overflow = null;

try {
  const piVersion = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")).version;
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const discoveredModel = modelRuntime.getModel(config.model.provider, config.model.id);
  assertExperiment(discoveredModel && Number.isSafeInteger(discoveredModel.contextWindow) &&
    discoveredModel.contextWindow > 0,
  `Pinned model ${config.model.provider}/${config.model.id} is unavailable`);
  const modelDescriptorSha256 = sha256Json(discoveredModel);
  // 4,096 was too small in rep 1: xhigh reasoning plus a deliverable hit stopReason
  // "length" on the native arm at stage 39 and killed the worker.
  const model = { ...discoveredModel, maxTokens: 16_384 };
  const systemPrompt = closedBook ? closedBookSystemPrompt() : workloadSystemPrompt();

  manager = SessionManager.create(config.repoDir, config.runDir);
  const markerId = manager.appendCustomEntry(EXPERIMENT_MARKER_ENTRY, {
    version: 1,
    runId: config.runId,
    campaignId: config.campaignId,
    arm: config.arm,
    configSha256: fileSha256(configPath),
    planSha256: config.planSha256,
    createdWallMs: Date.now(),
  });

  // The arm IS this settings object plus the extension's conditional registration.
  const isolatedSettings = SettingsManager.inMemory({
    compaction: { enabled: armRuntime.nativeCompactionEnabled, reserveTokens: 16_384 },
    branchSummary: { skipPrompt: true },
    // Pinned transport: "auto" rides WebSocket delta requests whose connection drops
    // re-send the full context cold. Old run configs carry no key and keep Pi's default.
    ...(config.transport === undefined ? {} : { transport: config.transport }),
  });
  const loader = new DefaultResourceLoader({
    cwd: config.repoDir,
    agentDir: getAgentDir(),
    settingsManager: isolatedSettings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    appendSystemPrompt: [],
    extensionFactories: closedBook ? [] : [createPiContextExperimentExtension(config)],
  });
  await loader.reload();
  assertExperiment(loader.getAppendSystemPrompt().length === 0,
    "Experiment resource loader discovered an external appended system prompt");
  const created = await createAgentSession({
    cwd: config.repoDir,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime,
    model,
    settingsManager: isolatedSettings,
    thinkingLevel: config.model.effort,
  });
  session = created.session;
  assertExperiment(!(created.extensionsResult?.errors ?? []).length,
    `Experiment extension load failed: ${JSON.stringify(created.extensionsResult?.errors)}`);
  await session.bindExtensions({ mode: "print" });
  const settings = session.settingsManager.getCompactionSettings();
  assertExperiment(settings.enabled === armRuntime.nativeCompactionEnabled,
    `Arm ${config.arm} did not get its compaction configuration: ${JSON.stringify(settings)}`);
  assertExperiment(session.settingsManager.getTransport() === (config.transport ?? "auto"),
    `Run transport pin did not reach the session: ${session.settingsManager.getTransport()}`);
  const discoveredToolNames = session.getActiveToolNames().sort();
  const requiredTools = closedBook ? [] : [
    ...EXPERIMENT_ALLOWED_TOOLS,
    ...(armRuntime.activeContextEnabled ? EXPERIMENT_PIFOLD_EXTRA_TOOLS : []),
  ];
  assertExperiment(requiredTools.every((name) => discoveredToolNames.includes(name)),
    `Arm ${config.arm} is missing a required tool: ${discoveredToolNames.join(",")}`);
  // The allowed set is the EXPOSED set. The first smoke proved that merely latching
  // off-list calls red fails every arm: a repo-comprehension prompt with bash visible
  // gets bash used. The extension's forbidden-tool latch stays as the backstop.
  session.setActiveToolsByName([...requiredTools]);
  const activeToolNames = session.getActiveToolNames().sort();
  assertExperiment(JSON.stringify(activeToolNames) === JSON.stringify([...requiredTools].sort()),
    `Arm ${config.arm} tool restriction did not hold: ${activeToolNames.join(",")}`);
  assertExperiment(armRuntime.activeContextEnabled ||
    !activeToolNames.includes(EXPERIMENT_PIFOLD_EXTRA_TOOLS[0]),
  `Arm ${config.arm} exposed the active-context tool it must not have`);

  const prompt = closedBook ? closedBookPrompt(plan) : workloadPrompt(config.firstChallenge);
  writeJsonExclusive(readyPath, {
    version: 1,
    runId: config.runId,
    arm: config.arm,
    workerPid,
    workerStartTicks,
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    markerId,
    activeToolNames,
    configuredSystemPromptSha256: sha256Text(systemPrompt),
    systemPromptSha256: sha256Text(session.systemPrompt),
    appendedSystemPromptCount: loader.getAppendSystemPrompt().length,
    promptSha256: sha256Text(prompt),
    checkoutSha256,
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
    } catch { /* The supervisor also records the deadline. */ }
    void session.abort();
  }, config.watchdogMs);
  let terminalState = null;
  try {
    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
      terminalState = await waitForDurableTerminalQuiescence(manager, session);
    } catch (error) {
      const text = error instanceof Error ? `${error.message}` : String(error);
      // The unmanaged arm is expected to end at the wall. That is its measurement, not a
      // failure; every other arm must never reach it.
      if (armRuntime.toleratesOverflow && isWindowOverflow(text)) {
        overflow = { detected: "thrown-error", detail: text.slice(0, 2_048), monotonicMs: monotonicMs() };
      } else {
        throw error;
      }
    }
  } finally {
    clearTimeout(deadline);
  }

  const entries = manager.getBranch();
  const terminal = terminalState?.terminal ?? lastConversationalMessage(entries);
  const terminalMessage = terminalState?.terminalMessage ?? terminal?.message;
  if (!overflow && armRuntime.toleratesOverflow &&
      ["error", "length"].includes(terminalMessage?.stopReason)) {
    overflow = {
      detected: `stop-reason:${terminalMessage.stopReason}`,
      // The overflow text arrives in errorMessage, not content (observed: content []
      // with "Codex error: Your input exceeds the context window ..." alongside it).
      detail: [terminalMessage.errorMessage ?? "", JSON.stringify(terminalMessage.content ?? null)]
        .join("\n").slice(0, 2_048),
      monotonicMs: monotonicMs(),
    };
  }
  assertExperiment(!deadlineFired, "Experiment worker hit its watchdog deadline");
  assertExperiment(overflow || (terminalMessage?.role === "assistant" &&
    terminalMessage.stopReason === "stop"),
  "Experiment worker did not end at one terminal provider stop");

  let foldSummary = null;
  if (armRuntime.activeContextEnabled) {
    const activeState = materializeActiveContextState(entries, manager.getSessionId(),
      PI_FOLD_STATE_ENTRY, PI_FOLD_FOLD_RECORD_ENTRY);
    foldSummary = {
      foldCount: activeState.folds.length,
      expanded: [...(activeState.expanded ?? [])],
      protectedRefs: (activeState.protected ?? []).length,
      // Decisions the run ended still owing: marks the agent placed that no fold
      // event paid for. Attempted curation the committed-mass share cannot see.
      pendingMarks: (activeState.pendingMarks ?? []).length,
      pendingAgentMarks: (activeState.pendingMarks ?? [])
        .filter((mark) => mark?.origin === "agent").length,
      advisory: activeState.advisory ?? { highWater: 0, delivered: {} },
      foldRecoveries: activeState.folds.map((fold) => ({
        foldId: fold.id,
        kind: fold.kind,
        sha256: sha256Json(recoverFoldMessages({
          foldId: fold.id, state: activeState, entries, sessionId: manager.getSessionId(),
        })),
      })),
    };
  }

  const manifest = validateExperimentManifest(closedBook ? {
    version: EXPERIMENT_PROTOCOL_VERSION,
    runId: config.runId,
    campaignId: config.campaignId,
    sessionType: EXPERIMENT_CLOSED_BOOK_LABEL,
    arm: config.arm,
    mode: config.mode,
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    ordinal: config.ordinal,
    repetition: config.repetition,
    seed: config.seed,
    model: {
      provider: model.provider,
      id: model.id,
      effort: config.model.effort,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      descriptorSha256: modelDescriptorSha256,
    },
    runtime: {
      codeCommit: config.codeCommit,
      codeTree: config.codeTree,
      piVersion,
      sourceHashes: config.sourceHashes,
      dependencyHashes: config.dependencyHashes,
      activeContextEnabled: false,
      nativeCompactionEnabled: false,
    },
    target: {
      repoKey: plan.repo.key,
      url: plan.repo.url,
      commit: plan.repo.commit,
      treeSha256: config.targetTreeSha256,
    },
    plan: {
      planSha256: plan.planSha256,
      stageCount: plan.stageCount,
      probeCount: plan.probeCount,
      deliverableCount: plan.deliverableCount,
    },
    questionsSha256: sha256Json(closedBookQuestions(plan)),
    createdWallMs: config.createdWallMs,
  } : {
    version: EXPERIMENT_PROTOCOL_VERSION,
    runId: config.runId,
    campaignId: config.campaignId,
    arm: config.arm,
    mode: config.mode,
    // The deployment fact travels config -> manifest -> registration, so the sealed
    // manifest states which serving budget the run's thresholds were measured against.
    ...(config.providerTotalWindow === undefined ? {} : { providerTotalWindow: config.providerTotalWindow }),
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    ordinal: config.ordinal,
    repetition: config.repetition,
    seed: config.seed,
    model: {
      provider: model.provider,
      id: model.id,
      effort: config.model.effort,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      descriptorSha256: modelDescriptorSha256,
    },
    runtime: {
      codeCommit: config.codeCommit,
      codeTree: config.codeTree,
      piVersion,
      sourceHashes: config.sourceHashes,
      dependencyHashes: config.dependencyHashes,
      activeContextEnabled: armRuntime.activeContextEnabled,
      nativeCompactionEnabled: armRuntime.nativeCompactionEnabled,
    },
    target: {
      repoKey: plan.repo.key,
      url: plan.repo.url,
      commit: plan.repo.commit,
      treeSha256: config.targetTreeSha256,
      checkoutSha256,
    },
    plan: {
      planSha256: plan.planSha256,
      stageCount: plan.stageCount,
      probeCount: plan.probeCount,
      deliverableCount: plan.deliverableCount,
    },
    pacing: {
      stageIntervalMs: config.stageIntervalMs,
      watchdogMs: config.watchdogMs,
      heartbeatMs: config.heartbeatMs,
    },
    createdWallMs: config.createdWallMs,
  });
  writeJsonExclusive(join(config.runDir, "run-manifest.json"), manifest);

  report = {
    ok: true,
    requiresIndependentAdjudication: true,
    version: 1,
    runId: config.runId,
    arm: config.arm,
    runnerMode: EXPERIMENT_RUNNER_MODE,
    behavioralMode: EXPERIMENT_BEHAVIORAL_MODE,
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
    manifestSha256: sha256Json(manifest),
    settings,
    checkoutSha256,
    overflow,
    foldSummary,
    terminal: terminal ? {
      entryId: terminal.id,
      stopReason: terminalMessage?.stopReason ?? null,
      messageSha256: terminalMessage ? sha256Json(terminalMessage) : null,
    } : null,
    deadlineFired,
  };
} catch (error) {
  report = {
    ok: false,
    requiresIndependentAdjudication: true,
    version: 1,
    runId: config.runId,
    arm: config.arm,
    workerPid,
    workerStartTicks,
    workerStartedWallMs,
    workerStartedMonotonicMs,
    workerFinishedWallMs: Date.now(),
    workerFinishedMonotonicMs: monotonicMs(),
    sessionId: manager?.getSessionId?.() ?? null,
    sessionFile: manager?.getSessionFile?.() ?? null,
    overflow,
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
  runId: config.runId,
  arm: config.arm,
  reportPath,
  sessionFile: report.sessionFile,
  overflow: report.overflow,
})}\n`);
