#!/usr/bin/env node

// One steer-protocol run of one arm, inside its own mount namespace. A single real Pi
// session driven by authored user turns that arrive one at a time over the run
// directory, with the agent's half entirely its own.
//
// WHAT THIS WORKER IS NOT ALLOWED TO HOLD. The plan carries every obligation, every
// superseded value and every expected setting, so it stays on the host and this process
// never sees it. What crosses is one steer's text, released after the previous turn ended,
// and unlinked once read. The per-steer config snapshots the grader needs are taken by the
// SUPERVISOR from the host side of the bind, because a snapshot directory inside the
// namespace would be a complete answer sheet for the clobber.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  EXPERIMENT_PROVIDER_RETRY,
  PI_STOCK_TOOLS,
  armRuntimeConfiguration,
  assertExperiment,
  compactionReserveTokens,
  compactionTriggerShare,
} from "./lib/pi_context_experiment.mjs";
import {
  SANDBOX_PATHS,
  deleteHarnessSource,
  harnessSourceRemains,
} from "./lib/pi_context_sandbox.mjs";
import {
  assertReleasedSteer,
  deflectionFor,
  endsOnQuestion,
  steerRequestPath,
  steerResponsePath,
  validateSteerRunConfig,
} from "./lib/steer_session.mjs";
import {
  assertSanitizedRuntimeEnvironment,
  directoryTreeSha256,
  fileSha256,
  monotonicMs,
  PI_INSTALL_ROOT,
  readJson,
  sha256Json,
  verifySourceHashes,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_ROOT = PI_INSTALL_ROOT;
const configPath = process.argv[2];
assertExperiment(configPath && existsSync(configPath), "Steer worker requires a run config path");
const config = validateSteerRunConfig(JSON.parse(readFileSync(configPath, "utf8")));
const configSha256 = fileSha256(configPath);
assertSanitizedRuntimeEnvironment(process.env);
assertExperiment(process.ppid === 1 && config.runDir === SANDBOX_PATHS.run &&
  config.repoDir === SANDBOX_PATHS.work && config.sessionDir === SANDBOX_PATHS.session,
"Steer worker is not running inside its own mount namespace");

const workerDependencyHashes = {
  piPackageJson: fileSha256(join(PI_ROOT, "package.json")),
  piDistTree: directoryTreeSha256(join(PI_ROOT, "dist")),
  piNodeModulesTree: directoryTreeSha256(join(PI_ROOT, "node_modules")),
  nodeExecutable: fileSha256(process.execPath),
};
assertExperiment(JSON.stringify(workerDependencyHashes) === JSON.stringify(config.dependencyHashes),
  "Steer worker dependency hashes differ from its supervisor attestation");
verifySourceHashes(PROJECT, config.sourceHashes);

const {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")));
const { createJiti } = await import(
  pathToFileURL(join(PI_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")));
const jiti = createJiti(import.meta.url, {
  // No transpile cache: jiti writes compiled .ts beside the project's node_modules by
  // default, and inside the namespace that path does not exist, so it falls back to
  // TMPDIR, which is the model's own scratch.
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
    // The fold editor's renderer imports Pi's TUI package. It resolves normally in the
    // checkout, and inside the namespace only aliased names resolve at all.
    "@earendil-works/pi-tui": join(PI_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: join(PI_ROOT, "node_modules", "typebox", "build", "index.mjs"),
  },
});
// THE REAL EXTENSION, not a harness wrapper. The steer protocol has no stage tool and no
// ledger tool, so the pifold arm registers exactly what the published package registers.
const { registerActiveContext } = await jiti.import(
  join(PROJECT, "extensions", "active-context.ts"));
const { registerEvidenceIngestion } = await jiti.import(
  join(PROJECT, "extensions", "evidence.js"));
verifySourceHashes(PROJECT, config.sourceHashes);

const armRuntime = armRuntimeConfiguration(config.arm);

// THE HARNESS DELETES ITS OWN SOURCE before the model takes a turn. Every module above is
// resident and the config has been read, so nothing reads these bytes again. What goes is
// a description of the measurement sitting where `grep` can reach it, and the run config
// beside it. The mount point cannot be removed from inside, so the contents go.
deleteHarnessSource();
assertExperiment(harnessSourceRemains().length === 0,
  "Steer worker could not delete its own harness source");

const started = monotonicMs();
const deflectedAt = [];
const delivered = [];
let manager = null;
let session = null;
let failure = null;

const writeReport = (extra) => {
  try {
    writeFileSync(join(config.runDir, "worker-report.json"), `${JSON.stringify({
      version: 1,
      runId: config.runId,
      arm: config.arm,
      planId: config.planId,
      configSha256,
      steersDelivered: delivered.length,
      steerCount: config.steerCount,
      deflectedAt,
      sessionId: manager?.getSessionId?.() ?? null,
      sessionFile: manager?.getSessionFile?.() ?? null,
      elapsedMs: monotonicMs() - started,
      ...extra,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch { /* Already written by the ordinary path, or the directory is gone. */ }
};
// KILLED FROM OUTSIDE STILL WRITES (gate 55's law). The supervisor's SIGTERM ends the
// process where it stands, and a run without this file cannot be adjudicated at all.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    writeReport({ ok: false, terminatedBySignal: signal, error: `Steer worker terminated by ${signal}` });
    process.exit(1);
  });
}

try {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const model = modelRuntime.getModel(config.model.provider, config.model.id);
  assertExperiment(model && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0,
    `Pinned model ${config.model.provider}/${config.model.id} is unavailable`);
  // NO output ceiling of our own. The descriptor's own maxTokens is what the model says
  // it can write; anything here is a guess that truncates the answer instead of
  // shortening it. A descriptor declaring none is a config to refuse.
  assertExperiment(Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0,
    `Pinned model ${config.model.provider}/${config.model.id} declares no output maximum`);

  assertExperiment(directoryTreeSha256(config.repoDir) === config.checkoutSha256,
    "The checkout this worker was handed is not the one the supervisor generated");

  manager = SessionManager.create(config.repoDir, config.sessionDir);

  const compactionTrigger = compactionReserveTokens({
    descriptorWindow: model.contextWindow,
    servingBudgetTokens: config.providerInputBudget ?? model.contextWindow,
    share: compactionTriggerShare("full"),
  });
  const isolatedSettings = SettingsManager.inMemory({
    compaction: {
      enabled: armRuntime.nativeCompactionEnabled,
      reserveTokens: compactionTrigger.reserveTokens,
    },
    branchSummary: { skipPrompt: true },
    transport: config.transport,
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
    // NO SYSTEM PROMPT OF OUR OWN, which is the point of the protocol. The agent is doing
    // ordinary work for an ordinary user; nothing tells it it is being measured, and gate
    // 62's scan covers the steer text because the steer text is the only surface left.
    systemPrompt: undefined,
    appendSystemPrompt: [],
    extensionFactories: armRuntime.activeContextEnabled
      ? [(pi) => {
        registerEvidenceIngestion(pi);
        return registerActiveContext(pi, {
          ...(config.providerInputBudget === undefined
            ? {} : { providerInputBudget: config.providerInputBudget }),
          ...(config.thresholds === undefined ? {} : { thresholds: config.thresholds }),
        });
      }]
      : [],
  });
  await loader.reload();
  assertExperiment(loader.getAppendSystemPrompt().length === 0,
    "Steer resource loader discovered an external appended system prompt");
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
    `Steer extension load failed: ${JSON.stringify(created.extensionsResult?.errors)}`);
  await session.bindExtensions({ mode: "print" });
  // STOCK TOOLS, and the checkout is writable, because the deliverable IS the tree the
  // agent leaves behind. The boundary is the filesystem, not the tool list.
  const tools = session.getActiveToolNames()
    .filter((name) => PI_STOCK_TOOLS.includes(name) || name.startsWith("pi_fold"));
  session.setActiveToolsByName(tools);

  writeJsonExclusive(join(config.runDir, "worker-ready.json"), {
    version: 1,
    runId: config.runId,
    arm: config.arm,
    workerPid: process.pid,
    sessionFile: manager.getSessionFile(),
    checkoutSha256: config.checkoutSha256,
    modelDescriptorSha256: sha256Json(model),
    tools,
  });

  // A SMOKE MODE, and it has to ride in the config rather than the environment: bwrap
  // clears the environment, so a flag exported beside the spawn never arrives.
  if (config.readyOnly === true) {
    writeReport({ ok: true, readyOnly: true });
    process.exit(0);
  }

  const waitFor = async (path) => {
    for (;;) {
      if (existsSync(path)) return readJson(path);
      if (monotonicMs() - started > config.watchdogMs) {
        throw new Error(`Steer worker timed out waiting for ${path}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  for (let ordinal = 1; ordinal <= config.steerCount; ordinal += 1) {
    writeJsonExclusive(steerRequestPath(config.runDir, ordinal), {
      version: 1, runId: config.runId, ordinal, deliveredSoFar: delivered.length,
    });
    const steer = assertReleasedSteer(await waitFor(steerResponsePath(config.runDir, ordinal)));
    const result = await session.prompt(steer.text, { expandPromptTemplates: false });
    delivered.push(steer.id);
    // ONE DEFLECTION, THEN ON. A person answers a direct question, and a driver that never
    // did would be uncanny enough for the agent to notice. What it must never do is answer
    // a question about a DECISION, so the reply is a shrug from the plan's fixed list and
    // the steer id is recorded, which is how the grader tells an honest ask from a silent
    // miss. Structural: the last non-empty line ends with a question mark, nothing about
    // the question is interpreted, and the same rule fires in both arms.
    const closing = typeof result?.text === "string" ? result.text : String(result ?? "");
    if (endsOnQuestion(closing)) {
      const shrug = deflectionFor({ deflections: config.deflections }, ordinal);
      if (shrug) {
        deflectedAt.push(steer.id);
        await session.prompt(shrug, { expandPromptTemplates: false });
      }
    }
    // Read once, then gone: a run walked from inside holds at most the steer it is on.
    try { unlinkSync(steerResponsePath(config.runDir, ordinal)); } catch { /* already gone */ }
  }
  writeReport({ ok: delivered.length === config.steerCount, error: null });
  process.exit(delivered.length === config.steerCount ? 0 : 1);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  writeReport({ ok: false, error: failure });
  process.stderr.write(`${failure}\n`);
  process.exit(1);
}
