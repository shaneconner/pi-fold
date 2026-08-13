#!/usr/bin/env node

// One fold-vs-compaction run of one arm: a single real Pi session, one user message,
// externally paced stages, artifact-only evidence. Derived from
// the retired soak worker (in git history through 09a4ea5); the session-driving
// machinery is unchanged and
// the archive stages are replaced by the staged repo-comprehension workload.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_BEHAVIORAL_MODE,
  EXPERIMENT_CLOSED_BOOK_LABEL,
  EXPERIMENT_COMPACTION_TRIGGER_SHARE,
  EXPERIMENT_MARKER_ENTRY,
  closedBookPrompt,
  closedBookQuestions,
  closedBookSystemPrompt,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_PROVIDER_RETRY,
  EXPERIMENT_RUNNER_MODE,
  EXPERIMENT_TERMINAL_STABILIZATION_MS,
  EXPERIMENT_TOOL_NAME,
  CONTEXT_EVENT_SUFFIX,
  armRuntimeConfiguration,
  assertExperiment,
  compactionReserveTokens,
  corpusManifestSha256,
  isWindowOverflow,
  receiptLens,
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

function resumePrompt(stage, stageCount) {
  return [
    `The assignment is not finished: stage ${stage} of ${stageCount} has not been delivered.`,
    `Recover the NEXT_KEY issued by the most recent completed stage and call`,
    `${EXPERIMENT_TOOL_NAME} with it. Do not write the closing synthesis until a stage returns END.`,
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
const stageNudges = [];
const stagesDelivered = () => {
  let delivered = 0;
  while (existsSync(join(config.runDir, "ipc", "responses",
    `stage-${String(delivered + 1).padStart(2, "0")}.json`))) delivered += 1;
  return delivered;
};
const latchedFailures = () => (existsSync(failurePath)
  ? readFileSync(failurePath, "utf8").split("\n").filter((line) => line.trim().length > 0).length
  : 0);
// A model that chose to end its turn is resumable. A harness that broke is not, and the
// difference is the whole reason this is a condition rather than an unconditional retry.
const modelEndedItsTurn = (state) => state?.terminalMessage?.stopReason === "stop" &&
  latchedFailures() === 0;

// A KILLED WORKER STILL WRITES ITS REPORT.
//
// The supervisor sends SIGTERM when its own deadline passes, and Node's default handler
// ends the process there and then: the `finally` at the bottom of this file that writes
// `worker-report.json` does not run, because a signal is not an unwound stack. So a run
// killed at the deadline left no report, and `adjudicate` refuses a run without one
// ("Run is incomplete: missing worker-report.json"). sol-20260812 rep 7's pifold arm lost
// six hours that way: it released all 64 of 64 stages, folded 27 commits with every
// receipt paid and no suspension, spent 281 further minutes recovering its own evidence
// through 83 distinct peeks, and none of it could be adjudicated or reported beside the
// native arm that ran in the same provider window. The evidence was all on disk. The one
// file that makes it readable was the one the kill prevented.
//
// This does not rescue the run, and it must not read as one: the report says ok false,
// names the signal, and the run still fails. It rescues the EVIDENCE, which is the thing
// six hours of provider spend actually bought.
const writeSignalReport = (signal) => {
  try {
    writeFileSync(reportPath, `${JSON.stringify({
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
      foldSummary: null,
      terminal: null,
      deadlineFired,
      // The distinguishing fact, and the reason this file is not a normal report: the run
      // was ended from outside rather than by anything the session did.
      terminatedBySignal: signal,
      error: { message: `Experiment worker terminated by ${signal}` },
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { /* Already written by the ordinary path, or the directory is gone. */ }
  process.exit(1);
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => writeSignalReport(signal));

try {
  const piVersion = JSON.parse(readFileSync(join(PI_ROOT, "package.json"), "utf8")).version;
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const discoveredModel = modelRuntime.getModel(config.model.provider, config.model.id);
  assertExperiment(discoveredModel && Number.isSafeInteger(discoveredModel.contextWindow) &&
    discoveredModel.contextWindow > 0,
  `Pinned model ${config.model.provider}/${config.model.id} is unavailable`);
  // The descriptor's output maximum is now the only one in play, so a descriptor that
  // declares none is a configuration this run cannot seal honestly rather than one to
  // paper over with a number of our own.
  assertExperiment(Number.isSafeInteger(discoveredModel.maxTokens) && discoveredModel.maxTokens > 0,
    `Pinned model ${config.model.provider}/${config.model.id} declares no output maximum`);
  const modelDescriptorSha256 = sha256Json(discoveredModel);
  // NO output ceiling of our own (Shane 2026-08-11). The descriptor's own maxTokens is
  // what the model says it can write; anything we put here is a guess that truncates the
  // answer instead of shortening it. This line used to read 4,096, which ended rep 1 on
  // stopReason "length", and the response was to raise it to 16,384 rather than to ask why
  // a ceiling was here at all. Pi still sends a value, because it derives one per request
  // as contextWindow - estimate - 4,096; that arithmetic is the run's business and is
  // recorded and latched on, but the descriptor's number is the only one we supply.
  const model = discoveredModel;
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

  // WHERE PI DECIDES TO SHED CONTEXT. Derived, not Pi's default: on this descriptor the
  // default reserve puts the trigger above the run's own serving budget, so the fence
  // reaches the window first and a managed arm never sees the hook at all. Both arms take
  // the same trigger, which is what makes the pairing a pairing.
  const compactionTrigger = compactionReserveTokens({
    descriptorWindow: discoveredModel.contextWindow,
    servingBudgetTokens: config.providerInputBudget ?? discoveredModel.contextWindow,
    share: EXPERIMENT_COMPACTION_TRIGGER_SHARE,
  });
  // The arm IS this settings object plus the extension's conditional registration.
  const isolatedSettings = SettingsManager.inMemory({
    compaction: {
      enabled: armRuntime.nativeCompactionEnabled,
      reserveTokens: compactionTrigger.reserveTokens,
    },
    branchSummary: { skipPrompt: true },
    // Pinned transport: "auto" rides WebSocket delta requests whose connection drops
    // re-send the full context cold. Old run configs carry no key and keep Pi's default.
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    // Every arm gets the same weather budget, so surviving a Codex overload is not a
    // difference between arms.
    retry: { ...EXPERIMENT_PROVIDER_RETRY },
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
  assertExperiment(settings.reserveTokens === compactionTrigger.reserveTokens,
    `Arm ${config.arm} did not get its compaction trigger: ${JSON.stringify(settings)}`);
  assertExperiment(session.settingsManager.getTransport() === (config.transport ?? "auto"),
    `Run transport pin did not reach the session: ${session.settingsManager.getTransport()}`);
  const retrySettings = session.settingsManager.getRetrySettings();
  assertExperiment(retrySettings.enabled === EXPERIMENT_PROVIDER_RETRY.enabled &&
    retrySettings.maxRetries === EXPERIMENT_PROVIDER_RETRY.maxRetries &&
    retrySettings.baseDelayMs === EXPERIMENT_PROVIDER_RETRY.baseDelayMs,
  `Run provider retry pin did not reach the session: ${JSON.stringify(retrySettings)}`);
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
      while (!closedBook && !deadlineFired && stagesDelivered() < plan.stageCount &&
        modelEndedItsTurn(terminalState)) {
        stageNudges.push({
          afterStage: stagesDelivered(), wallMs: Date.now(), monotonicMs: monotonicMs(),
        });
        await session.prompt(resumePrompt(stagesDelivered() + 1, plan.stageCount),
          { expandPromptTemplates: false });
        terminalState = await waitForDurableTerminalQuiescence(manager, session);
      }
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
  assertExperiment(closedBook || stagesDelivered() === plan.stageCount,
    `Experiment worker ended with ${stagesDelivered()} of ${plan.stageCount} stages delivered ` +
    `after ${stageNudges.length} resume prompt(s); last stop reason ` +
    `${terminalMessage?.stopReason ?? "none"} with ${latchedFailures()} latched failure(s)`);
  // A SUSPENDED RUNTIME IS A DEAD RUN, whatever it dies of afterwards.
  //
  // Checked BEFORE the terminal-stop assertion so the report names the cause instead of
  // the symptom. sol-20260812 reps 3 and 4 both ended on an aborted request and both said
  // so; what actually happened in each is that a commit twenty minutes earlier failed to
  // persist, folding switched off for the rest of the session, and occupancy then climbed
  // to the wall with nothing left that could reclaim it. The abort was the last event, not
  // the first. Only meaningful where folding runs at all.
  const foldFailures = armRuntime.activeContextEnabled
    ? entries
      .filter((entry) => typeof entry?.customType === "string" &&
        entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data?.kind === "context.suspend")
      .map((entry) => entry.data)
    : [];
  // Every announcement is fatal now: a transaction that fails suspends automatic folding on
  // the first one, and from that point the session folds nothing at all.
  const suspensions = foldFailures;
  assertExperiment(suspensions.length === 0,
    `Active-context folding was suspended during the run (${suspensions.length} announcement(s)); ` +
    `first at ordinal ${suspensions[0]?.ordinal} revision ${suspensions[0]?.state_revision} ` +
    `in phase ${suspensions[0]?.phase}: ${suspensions[0]?.error}`);
  // AN APPLIED COMMIT OWES A RECEIPT, and the stream alone can say whether it paid.
  //
  // `noteAutomaticReceipt` is the last statement of the rung application, after the folds
  // are emitted and before the state is persisted. So a commit that announces applied marks
  // and never delivers a receipt is a commit that threw partway: the folds are in the stream
  // and nowhere else, no fold record, no state entry, and the marks go back to pending.
  //
  // This is checked after the suspension, which carries the error verbatim and is the better
  // message when both fire, and before the terminal stop, which is the symptom. It earns its
  // place beside the announcement by being build-independent: measured across all six sealed
  // sol-20260812 runs, every healthy commit is followed by its receipt within ten to
  // twenty-three events and always before the next projection, and every lost one is followed
  // by no receipt at all and a next projection reading exactly `applied_marks` revisions lower
  // (99 to 85 at fourteen folds, 143 to 132 and 153 to 142 at eleven, 394 to 385 at nine).
  // Reps 3, 4 and 6 are the known losses. Rep 1 is the reason this exists: it lost fourteen
  // folds the same way on a build that predates every announcement, and nothing in the record
  // said so until this check was run against it.
  const contextEvents = armRuntime.activeContextEnabled
    ? entries
      .filter((entry) => typeof entry?.customType === "string" &&
        entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data?.kind)
      .map((entry) => entry.data)
    : [];
  const receipts = receiptLens(contextEvents);
  const unpaid = receipts.missing[0];
  assertExperiment(receipts.commitsWithoutReceipt === 0,
    `${receipts.commitsWithoutReceipt} of ${receipts.appliedCommits} applied commit(s) never ` +
    "delivered a receipt, so their folds left no record and their marks went back to pending; " +
    `first at seq ${unpaid?.seq} revision ${unpaid?.revision} applying ${unpaid?.appliedMarks} ` +
    `mark(s) on trigger ${unpaid?.trigger}, with the next projection reading revision ` +
    `${unpaid?.nextProjectionRevision} (${unpaid?.revisionsRolledBack} revisions back)`);
  assertExperiment(overflow || (terminalMessage?.role === "assistant" &&
    terminalMessage.stopReason === "stop"),
  "Experiment worker did not end at one terminal provider stop");

  let foldSummary = null;
  if (armRuntime.activeContextEnabled) {
    const activeState = materializeActiveContextState(entries, manager.getSessionId(),
      PI_FOLD_STATE_ENTRY, PI_FOLD_FOLD_RECORD_ENTRY);
    foldSummary = {
      foldCount: activeState.folds.length,
      // Recorded on a passing run too, so a clean stream says the check ran rather than
      // leaving it to be inferred from the absence of a failure. Zero of zero and zero of
      // twelve are different facts about a session.
      appliedCommits: receipts.appliedCommits,
      commitsWithoutReceipt: receipts.commitsWithoutReceipt,
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
    ...(config.providerInputBudget === undefined ? {} : { providerInputBudget: config.providerInputBudget }),
    // The brief generator travels the same road, so the sealed manifest states which
    // model wrote the run's fold briefs. An arm that registers no runtime records none.
    ...(config.briefGenerator === undefined ? {} : { briefGenerator: config.briefGenerator }),
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
    stagesDelivered: closedBook ? null : stagesDelivered(),
    stageNudges,
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
    stageNudges,
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
