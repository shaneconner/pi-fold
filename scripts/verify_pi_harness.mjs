#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";
import {
  loadAgentConfiguration,
  resolveAgentLaunch,
} from "../.pi/extensions/quorum/agent-profiles.mjs";
import {
  loadQuorumServer,
  StdioMcpClient,
} from "../.pi/extensions/quorum/mcp-client.mjs";
import { validateExposureDescriptor } from "../.pi/extensions/quorum/runtime.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const requiredTools = new Set([
  "wiki_read",
  "wiki_search",
  "wiki_refine",
  "wiki_create",
  "journal_read",
  "journal_log",
  "memory_context",
  "memory_status",
]);
const expectedSubagentCommit = "01a1c3f3fb46362127f8a5808c8a00925d38229d";
const expectedPackages = [
  `git:github.com/shaneconner/pi-subagents@${expectedSubagentCommit}`,
  "npm:@narumitw/pi-plan-mode@0.31.0",
  "npm:@juicesharp/rpiv-ask-user-question@2.1.0",
  "npm:@juicesharp/rpiv-todo@2.1.0",
  "npm:pi-web-access@0.14.0",
];
const webToolNames = ["web_search", "source_check", "fetch_content", "get_search_content"];
const childExtension = "/home/shane/quorum/.pi/extensions/quorum/child.mjs";
const webExtension = "/home/shane/quorum/.pi/npm/node_modules/pi-web-access/index.ts";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function verifyPackagePolicy() {
  const settings = readJson(join(projectRoot, ".pi", "settings.json"));
  assert(JSON.stringify(settings.packages) === JSON.stringify(expectedPackages), "Project Pi packages are not exact governed pins");
  assert(settings.compaction?.enabled === false, "Stock Pi automatic compaction must remain disabled");
  assert(!Object.hasOwn(settings, "summaryCheckpoints"), "Project settings depend on a patched-Pi summaryCheckpoints key");
  assert(settings.branchSummary?.skipPrompt === true, "Tree navigation still prompts for a forbidden summary checkpoint");
  assert(settings.subagents?.disableBuiltins !== true, "Community pi-subagents builtins are unnecessarily disabled");
  assert(settings.subagents?.modelScope?.enforce !== true, "Quorum must not impose a speculative model-scope denylist");
  const scoutOverride = settings.subagents?.agentOverrides?.scout;
  assert(
    scoutOverride?.tools?.includes("read") &&
      scoutOverride.tools.includes("bash") &&
      scoutOverride.tools.includes("web_search") &&
      !scoutOverride.tools.includes("write") &&
      scoutOverride.extensions?.includes(childExtension) &&
      scoutOverride.extensions.includes(webExtension),
    "Builtin scout must retain governed local inspection plus web-research capability",
  );
  assert(!settings.packages.some((value) => value.includes("pi-goal")), "pi-goal must not be installed");
  assert(
    JSON.stringify(settings.skills) === JSON.stringify(["-skills/news-themes/SKILL.md"]),
    "news-themes must remain installed but disabled in the project skill catalog",
  );

  const manifest = readJson(join(projectRoot, ".pi", "npm", "package.json"));
  const expectedDependencies = Object.fromEntries(
    expectedPackages
      .filter((value) => value.startsWith("npm:"))
      .map((value) => {
        const match = /^npm:(.+)@([^@]+)$/.exec(value);
        return [match[1], match[2]];
      }),
  );
  assert(
    JSON.stringify(manifest.dependencies) === JSON.stringify(Object.fromEntries(Object.entries(expectedDependencies).sort())),
    ".pi/npm/package.json must use exact versions with no caret ranges",
  );

  const lock = readJson(join(projectRoot, ".pi", "npm", "package-lock.json"));
  assert(lock.lockfileVersion === 3, ".pi/npm/package-lock.json must be a current governed lock");
  assert(
    JSON.stringify(lock.packages?.[""]?.dependencies) === JSON.stringify(manifest.dependencies),
    ".pi/npm/package-lock.json root dependencies drifted from the exact manifest",
  );
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    assert(entry?.version === version && typeof entry.integrity === "string", `Locked package ${name}@${version} lacks exact integrity`);
  }
  const embeddedHostPeers = Object.keys(lock.packages ?? {}).filter((path) =>
    /^node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(path));
  assert(
    embeddedHostPeers.length === 0,
    `Extension lock embeds a second Pi runtime instead of using host peers: ${embeddedHostPeers.join(", ")}`,
  );

  const subagentPackageRoot = realpathSync(join(projectRoot, ".pi", "pi-subagents"));
  const observedSubagentCommit = execFileSync(
    "git",
    ["-C", subagentPackageRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert(
    observedSubagentCommit === expectedSubagentCommit,
    `pi-subagents checkout drift: expected ${expectedSubagentCommit}, observed ${observedSubagentCommit}`,
  );
  const subagentManifest = readJson(join(subagentPackageRoot, "package.json"));
  assert(subagentManifest.name === "pi-subagents", "Stable pi-subagents alias resolves to the wrong package");
  for (const path of ["src/runs/foreground/execution.ts", "src/runs/background/subagent-runner.ts"]) {
    assert(
      readFileSync(join(subagentPackageRoot, path), "utf8").includes('"--no-approve"'),
      `${path} must prevent child startup from resolving or mutating project package caches`,
    );
  }

  const subagentConfigPath = join(homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
  assert(existsSync(subagentConfigPath), `Missing pi-subagents runtime policy: ${subagentConfigPath}`);
  const subagentConfig = readJson(subagentConfigPath);
  assert(subagentConfig.artifactDir === "session", "pi-subagents artifacts must stay out of the repository");
  assert(subagentConfig.fleetView === true, "pi-subagents FleetView must stay enabled");
  assert(subagentConfig.maxSubagentDepth === 4, "pi-subagents nesting depth must remain 4");
  assert(subagentConfig.maxSubagentSpawnsPerSession === 0, "pi-subagents sessions must be explicitly unlimited");
  assert(
    !Object.hasOwn(subagentConfig, "turnBudget") && !Object.hasOwn(subagentConfig, "toolBudget"),
    "Optional pi-subagents turn/tool budgets must remain absent",
  );
  assert(
    subagentConfig.globalConcurrencyLimit === 256 &&
      subagentConfig.parallel?.maxTasks === 128 &&
      subagentConfig.parallel?.concurrency === 64,
    "pi-subagents fleet ceilings drifted",
  );
  assert(
    subagentConfig.scheduledRuns?.enabled === true && subagentConfig.scheduledRuns?.maxPending === 128,
    "Explicit package-owned scheduling must remain available at the 128-job ceiling",
  );
  assert(
    subagentConfig.intercomBridge?.mode === "always" && subagentConfig.intercomBridge?.resultDelivery === false,
    "Native supervisor coordination must stay active without unavailable external grouped-result delivery",
  );

  const planPath = join(homedir(), ".pi", "agent", "pi-plan-mode.json");
  assert(existsSync(planPath), `Missing Plan-mode policy: ${planPath}`);
  const plan = readJson(planPath);
  for (const tool of ["inspect_repo", "wiki_read", "wiki_search", "subagent"]) {
    assert(plan.defaultPlanTools?.includes(tool), `Plan mode is missing governed tool ${tool}`);
  }
  assert(
    JSON.stringify(plan.allowedPlanSubagents) === JSON.stringify([
      "planner", "researcher", "reviewer", "web-researcher", "scout", "context-builder", "oracle", "advisor",
    ]),
    "Plan mode read-only/advisory subagent access drifted",
  );

  const voiceSettings = readJson(join(homedir(), ".pi", "agent", "settings.json"));
  assert(
    voiceSettings.packages?.includes("npm:@juicesharp/rpiv-voice@2.1.0"),
    "Exact user-level rpiv-voice package is not installed",
  );
  return { settings, manifest, planPath, subagentConfigPath, subagentPackageRoot };
}

async function verifyAgentContracts() {
  const configuration = loadAgentConfiguration(projectRoot);
  const names = configuration.profiles.map((profile) => profile.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["context-summarizer", "implementer", "planner", "researcher", "reviewer", "web-researcher"]),
    `Unexpected governed profiles: ${names.join(", ")}`,
  );
  for (const profile of configuration.profiles) {
    const text = readFileSync(profile.filePath, "utf8");
    assert(text.includes(`tool-surface: ${profile.toolSurface}`), `${profile.name} lacks an explicit tool surface`);
    assert(text.includes(`thinking: ${profile.packageThinking}`), `${profile.name} lacks explicit package effort`);
    const isContextSummarizer = profile.name === "context-summarizer";
    if (isContextSummarizer) {
      assert(/^extensions:\s*$/m.test(text), "Context summarizer loads an extension");
      assert(/^subagentOnlyExtensions:\s*$/m.test(text), "Context summarizer loads a child-only extension");
    } else {
      const expectedEntrypoint = profile.toolSurface === "web"
        ? "extensions: .pi/extensions/quorum/web-child.mjs"
        : "extensions: .pi/extensions/quorum/child.mjs";
      assert(text.includes(expectedEntrypoint), `${profile.name} does not load its canonical Quorum child entrypoint`);
    }
    const declaredTools = new Set((/^tools:[ \t]*(.*)$/m.exec(text)?.[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    const declaredChildExtensions = new Set((/^subagentOnlyExtensions:[ \t]*(.*)$/m.exec(text)?.[1] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
    if (isContextSummarizer) {
      assert(declaredTools.size === 0 && declaredChildExtensions.size === 0, "Context summarizer is not no-tools/no-extensions");
      assert(text.includes("inheritProjectContext: false"), "Context summarizer inherits project context");
      assert(text.includes("inheritSkills: false"), "Context summarizer inherits skills");
    } else {
      assert(declaredChildExtensions.size === 1, `${profile.name} loads an unexpected child-only extension`);
    }
    if (profile.toolSurface === "web") {
      assert(text.includes("inheritProjectContext: false"), `${profile.name} inherits local project context`);
      assert(text.includes("inheritSkills: false"), `${profile.name} inherits local skills`);
      assert(declaredChildExtensions.has(webExtension), `${profile.name} lacks the web extension`);
      for (const tool of webToolNames) assert(declaredTools.has(tool), `${profile.name} lacks bounded web tool ${tool}`);
      for (const tool of ["read", "bash", "inspect_repo", "wiki_read", "recall"]) {
        assert(!declaredTools.has(tool), `${profile.name} combines web egress with local tool ${tool}`);
      }
    } else if (!isContextSummarizer) {
      assert(text.includes("inheritProjectContext: true"), `${profile.name} does not inherit project canon`);
      assert(declaredChildExtensions.has(webExtension), `${profile.name} lacks the installed web extension`);
      for (const tool of webToolNames) assert(declaredTools.has(tool), `${profile.name} lacks web tool ${tool}`);
      assert(text.includes("Never place credentials or private source text in a query"), `${profile.name} lacks the web trust-boundary instruction`);
    }
    if (profile.mode === "read-only") {
      assert(!/^tools:.*\b(edit|write)\b/m.test(text), `${profile.name} exposes a mutation tool`);
      assert(!/^turnBudget:/m.test(text), `${profile.name} reintroduced an arbitrary turn cap`);
      assert(!/^toolBudget:/m.test(text), `${profile.name} reintroduced an arbitrary tool-call cap`);
      if (profile.toolSurface === "local" && !isContextSummarizer) {
        assert(declaredTools.has("bash"), `${profile.name} lacks sandboxed read-only shell checks`);
        assert(declaredTools.has("inspect_repo"), `${profile.name} lacks read-only repository inspection`);
        assert(text.includes("filesystem-read-only"), `${profile.name} does not explain the read-only Bash boundary`);
      }
    } else {
      assert(declaredTools.has("bash"), `${profile.name} lacks sandboxed writer shell access`);
      assert(!declaredTools.has("edit") && !declaredTools.has("write"), `${profile.name} exposes unsandboxed direct mutation tools`);
      assert(text.includes("execute outside that mount boundary"), `${profile.name} does not explain the direct-tool exclusion`);
      assert(declaredTools.has("quorum_commit"), `${profile.name} lacks the controlled commit tool`);
    }
  }

  const jiti = createJiti(import.meta.url, {
    alias: {
      typebox: join(projectRoot, ".pi", "npm", "node_modules", "typebox", "build", "index.mjs"),
      "@earendil-works/pi-coding-agent": join(
        homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js",
      ),
    },
  });
  const { registerReloadRuntime } = await jiti.import(
    join(projectRoot, ".pi", "extensions", "quorum", "index.js"),
  );
  const reloadCommands = new Map();
  const reloadTools = new Map();
  const queuedReloads = [];
  registerReloadRuntime({
    registerCommand(name, command) { reloadCommands.set(name, command); },
    registerTool(tool) { reloadTools.set(tool.name, tool); },
    queueCommand(name, args) { queuedReloads.push({ name, args }); },
  });
  let reloadCalls = 0;
  await reloadCommands.get("reload-runtime").handler("", { reload: async () => { reloadCalls += 1; } });
  assert(reloadCalls === 1, "Reload command did not invoke Pi's native ctx.reload exactly once");
  const reloadResult = await reloadTools.get("reload_runtime").execute();
  assert(reloadResult.terminate === true, "Reload tool did not terminate its stale-runtime tool loop");
  assert(
    JSON.stringify(queuedReloads) === JSON.stringify([{ name: "reload-runtime", args: undefined }]),
    "Reload tool did not use Pi's native settled command queue when available",
  );
  const stockReloadTools = new Map();
  registerReloadRuntime({
    registerCommand() {},
    registerTool(tool) { stockReloadTools.set(tool.name, tool); },
  });
  let directReloadCalls = 0;
  const stockReloadResult = await stockReloadTools.get("reload_runtime").execute(
    "reload-direct", {}, new AbortController().signal, undefined,
    { reload: async () => { directReloadCalls += 1; } },
  );
  assert(
    stockReloadResult.isError !== true && stockReloadResult.details?.method === "tool-context" && directReloadCalls === 1,
    "Reload tool did not use stock Pi's tool-context reload seam exactly once",
  );
  const unavailableReloadResult = await stockReloadTools.get("reload_runtime").execute();
  assert(
    unavailableReloadResult.isError === true && unavailableReloadResult.details?.reloadAvailable === false,
    "Reload tool did not fail explicitly when neither stock reload seam is available",
  );
  const { resolveSubagentLaunchContract } = await jiti.import(
    join(projectRoot, ".pi", "pi-subagents", "src", "api", "preflight.ts"),
  );
  const contracts = [];
  for (const profile of configuration.profiles) {
    const launch = resolveAgentLaunch(configuration, profile.name, "openai-codex");
    const result = await resolveSubagentLaunchContract({
      agent: profile.name,
      agentScope: "project",
      cwd: projectRoot,
      task: "non-executing harness preflight",
      context: "fresh",
      model: launch.fullModel,
      thinking: launch.thinking,
      preferredProvider: launch.provider,
      runId: `verify-${profile.name}`,
      artifacts: false,
    });
    assert(result.ok, `pi-subagents preflight failed for ${profile.name}: ${result.message}`);
    assert(result.contract.agent.source === "project", `${profile.name} did not resolve to project scope`);
    assert(result.contract.agent.filePath === profile.filePath, `${profile.name} resolved to the wrong definition`);
    const expectedModel = `${launch.fullModel}:${launch.thinking}`;
    assert(result.contract.model === expectedModel, `${profile.name} resolved model drift: expected ${expectedModel}, observed ${result.contract.model}`);
    assert(result.contract.thinking === launch.thinking, `${profile.name} resolved effort drift: expected ${launch.thinking}, observed ${result.contract.thinking}`);
    assert(result.contract.modelCandidates?.[0] === expectedModel, `${profile.name} primary model candidate is not the governed tuple`);
    assert(result.contract.model.startsWith("openai-codex/"), `${profile.name} crossed providers`);
    const effectiveTools = new Set(result.contract.tools.effectiveAllowlist);
    if (profile.name === "context-summarizer") {
      assert(effectiveTools.size === 0, "Context summarizer preflight gained tools");
      assert(result.contract.context === "fresh", "Context summarizer preflight is not fresh");
      assert(result.contract.tools.disableAmbientExtensions === true, "Context summarizer retained ambient extensions");
      assert(result.contract.inheritProjectContext === false && result.contract.inheritSkills === false,
        "Context summarizer inherited project context or skills");
      assert(result.contract.model === "openai-codex/gpt-5.6-luna:medium",
        `Context summarizer tuple drifted: ${result.contract.model}`);
    } else if (profile.toolSurface === "web") {
      assert(effectiveTools.has("web_search") && !effectiveTools.has("read"), `${profile.name} preflight broke web-only isolation`);
    } else {
      assert(effectiveTools.has("read") && effectiveTools.has("web_search"), `${profile.name} preflight lost local or web capability`);
    }
    contracts.push({
      profile: profile.name,
      mode: profile.mode,
      surface: profile.toolSurface,
      model: result.contract.model,
      digest: result.contract.digest,
      tools: result.contract.tools.effectiveAllowlist.length,
    });
  }

  for (const builtin of ["worker", "oracle", "scout", "delegate"]) {
    const result = await resolveSubagentLaunchContract({
      agent: builtin,
      agentScope: "project",
      cwd: projectRoot,
      artifacts: false,
    });
    assert(result.ok && result.contract.agent.source === "builtin", `Community builtin ${builtin} is not launchable`);
    if (builtin === "scout") {
      assert(result.contract.tools.effectiveAllowlist.includes("web_search"), "Builtin scout override lost web_search");
      assert(!result.contract.tools.effectiveAllowlist.includes("write"), "Builtin scout retained uncontained project mutation");
      assert(
        result.contract.tools.configuredExtensions.includes(childExtension),
        "Builtin scout does not load the real Quorum child policy",
      );
      assert(result.contract.tools.disableAmbientExtensions, "Builtin scout also loads conflicting ambient project extensions");
    }
  }

  const {
    activeToolNames,
    agentContextAttribution,
    assertGovernedAsyncOwnership,
    assertGovernedResumeContract,
    assertObservedLaunchContractDigest,
    assertPlanModeLaunch,
    assertResponseAttribution,
    boundedDelegationEvidence,
    callSubagentRpc,
    captureCoordinatorIdentity,
    composeAgentContextTask,
    coordinatorLiveness,
    currentRevival,
    executionRequest,
    markInterruptedForeground,
    normalizeAgentContext,
    packageLifecycleStartupPending,
    rawSubagentPolicy,
    registerAgentTool,
    resumeSourceRunId,
    retryableReadOnlyStartupFailure,
    runWithClassifiedStartupRetry,
    withJobReconciliation,
  } = await jiti.import(
    join(projectRoot, ".pi", "extensions", "quorum", "agent.js"),
  );
  assert(
    rawSubagentPolicy(configuration, { chain: [{ agent: "researcher" }, { agent: "web-researcher" }] }, "openai-codex") === null,
    "Read-only mixed-tool chains were unnecessarily blocked",
  );
  assert(
    rawSubagentPolicy(configuration, { tasks: [{ agent: "researcher" }, { agent: "web-researcher" }] }, "openai-codex") === null,
    "Read-only local/web parallel evidence fan-out was blocked",
  );
  assert(rawSubagentPolicy(configuration, { action: "resume" }, "openai-codex") === null, "Package-owned lifecycle actions are unnecessarily blocked");
  assert(rawSubagentPolicy(configuration, { agent: "delegate", task: "bounded task" }, "openai-codex") === null, "Community package agents are unnecessarily blocked");
  assert(
    rawSubagentPolicy(configuration, { agent: "implementer", task: "edit" }, "openai-codex")?.includes("committed worktree handoff"),
    "Governed implementer can bypass its committed worktree handoff",
  );
  const coordinatorHandlers = new Map();
  let completionSubscriptions = 0;
  let completionUnsubscriptions = 0;
  let registeredAgentTool;
  registerAgentTool({
    events: {
      on() {
        completionSubscriptions += 1;
        return () => { completionUnsubscriptions += 1; };
      },
    },
    on(event, handler) { coordinatorHandlers.set(event, handler); },
    registerTool(tool) { registeredAgentTool = tool; },
    registerCommand() {},
  });
  coordinatorHandlers.get("session_shutdown")({}, { ui: { setStatus() {} } });
  assert(completionSubscriptions === 1 && completionUnsubscriptions === 1, "Agent async completion subscription leaks across shutdown/reload");
  assert(
    registeredAgentTool?.parameters?.properties?.tasks?.maxItems === undefined &&
      registeredAgentTool?.parameters?.properties?.chain?.maxItems === undefined &&
      registeredAgentTool?.parameters?.properties?.timeout_seconds?.default === undefined &&
      registeredAgentTool?.parameters?.properties?.timeout_seconds?.maximum === undefined,
    "Agent tool schema reintroduced a Quorum-owned child-count or default runtime limit",
  );
  const contextSchema = registeredAgentTool?.parameters?.properties?.context;
  assert(
    contextSchema?.properties?.mode?.enum?.join(",") === "fresh,fork" &&
      contextSchema?.properties?.sessions?.items?.required?.join(",") === "session_id,seq_lo,seq_hi" &&
      registeredAgentTool?.parameters?.properties?.tasks?.items?.properties?.context === contextSchema &&
      registeredAgentTool?.parameters?.properties?.chain?.items?.properties?.context === contextSchema,
    "Context is not one shared typed input for single, parallel, and chain agents",
  );
  const researcherProfile = configuration.profiles.find((profile) => profile.name === "researcher");
  const webProfile = configuration.profiles.find((profile) => profile.name === "web-researcher");
  assert(researcherProfile?.tools?.includes("wiki_read") && researcherProfile.tools.includes("expand"),
    "Governed profile parsing omitted context retrieval tools");
  const curatedContext = {
    mode: "fork",
    seed: "Known invariant: qmem remains the only durable memory owner.",
    wiki: ["art_df1ddb3879917212"],
    folds: ["fold-context-example"],
    sessions: [{ session_id: "session-context-example", seq_lo: 4, seq_hi: 9 }],
  };
  const normalizedContext = normalizeAgentContext(curatedContext);
  const contextTask = composeAgentContextTask("Review the adapter.", normalizedContext, researcherProfile);
  assert(
    normalizedContext.mode === "fork" &&
      contextTask.includes('wiki_read address="art_df1ddb3879917212"') &&
      contextTask.includes('expand fold_id="fold-context-example" scope=span') &&
      contextTask.includes('expand session_id="session-context-example" seq_lo=4 seq_hi=9 scope=span') &&
      contextTask.endsWith("## Delegated task\nReview the adapter."),
    "Typed Context did not compose exact wiki/fold/session routes into the Agent task",
  );
  const contextAttribution = agentContextAttribution(normalizedContext);
  assert(
    contextAttribution.mode === "fork" && /^[a-f0-9]{64}$/.test(contextAttribution.digest) &&
      contextAttribution.seed?.sha256 && !JSON.stringify(contextAttribution).includes(curatedContext.seed),
    "Context attribution is missing its exact digest or leaked the raw seed",
  );
  let contextCapabilityBlocked = false;
  try {
    composeAgentContextTask("Should fail.", { wiki: ["meta/memory"] }, webProfile);
  } catch (error) {
    contextCapabilityBlocked = String(error).includes("missing wiki_read");
  }
  assert(contextCapabilityBlocked, "A context route was accepted for an Agent without its retrieval tool");
  const contextLaunch = resolveAgentLaunch(configuration, "researcher", "openai-codex", "drone");
  const contextRequest = executionRequest(
    "context-job",
    "context-node",
    contextLaunch,
    contextTask,
    projectRoot,
    undefined,
    { context: "fork" },
  );
  assert(
    contextRequest.context === "fork" && contextRequest.task === contextTask,
    "The package delegation request lost Context mode or its compiled task",
  );
  const nativeContextContract = await resolveSubagentLaunchContract({
    agent: "researcher",
    agentScope: "project",
    cwd: projectRoot,
    task: contextTask,
    context: "fork",
    model: contextLaunch.fullModel,
    thinking: contextLaunch.thinking,
    artifacts: false,
    runId: "verify-typed-context",
  });
  assert(
    nativeContextContract.ok && nativeContextContract.contract.context === "fork" &&
      /^[a-f0-9]{64}$/.test(nativeContextContract.contract.launchContractDigest),
    "pi-subagents did not bind fork context into its native launch contract",
  );
  const changedContextContract = await resolveSubagentLaunchContract({
    agent: "researcher",
    agentScope: "project",
    cwd: projectRoot,
    task: contextTask,
    context: "fresh",
    model: contextLaunch.fullModel,
    artifacts: false,
    runId: "verify-typed-context",
  });
  assert(
    changedContextContract.ok &&
      changedContextContract.contract.launchContractDigest !== nativeContextContract.contract.launchContractDigest,
    "pi-subagents launch attribution did not bind the rendered Context task and mode",
  );
  let pollutedContextIteratorExecutions = 0;
  const originalArrayIterator = Array.prototype[Symbol.iterator];
  const originalArrayJoin = Array.prototype.join;
  const originalStringTrim = String.prototype.trim;
  const originalSafeInteger = Number.isSafeInteger;
  try {
    Array.prototype[Symbol.iterator] = function poisonedContextIterator() {
      pollutedContextIteratorExecutions += 1;
      throw new Error("poisoned context iterator executed");
    };
    Array.prototype.join = () => { throw new Error("poisoned context join executed"); };
    String.prototype.trim = () => { throw new Error("poisoned context trim executed"); };
    Number.isSafeInteger = () => { throw new Error("poisoned context integer validator executed"); };
    const hardenedContext = normalizeAgentContext({
      wiki: ["meta/memory"],
      sessions: [{ session_id: "session", seq_lo: 1, seq_hi: 2 }],
    });
    composeAgentContextTask("Hardened.", hardenedContext, researcherProfile);
  } finally {
    Array.prototype[Symbol.iterator] = originalArrayIterator;
    Array.prototype.join = originalArrayJoin;
    String.prototype.trim = originalStringTrim;
    Number.isSafeInteger = originalSafeInteger;
  }
  assert(pollutedContextIteratorExecutions === 0, "Context validation dispatched through mutable array iteration");
  let contextAccessorExecutions = 0;
  const accessorContext = {};
  Object.defineProperty(accessorContext, "seed", {
    enumerable: true,
    get() {
      contextAccessorExecutions += 1;
      return "unsafe";
    },
  });
  let accessorBlocked = false;
  try {
    normalizeAgentContext(accessorContext);
  } catch (error) {
    accessorBlocked = String(error).includes("accessor property");
  }
  assert(accessorBlocked && contextAccessorExecutions === 0, "Context validation executed an accessor");
  let inheritedContextGetterExecutions = 0;
  let inheritedArraySetterExecutions = 0;
  const inheritedRouteInput = { wiki: ["art_exact"] };
  Object.defineProperty(Object.prototype, "wiki", {
    configurable: true,
    get() {
      inheritedContextGetterExecutions += 1;
      return ["inherited-route"];
    },
  });
  Object.defineProperty(Array.prototype, "0", {
    configurable: true,
    set() {
      inheritedArraySetterExecutions += 1;
    },
  });
  let prototypeSafeContext;
  let prototypeSafeTask;
  try {
    prototypeSafeContext = normalizeAgentContext(inheritedRouteInput);
    prototypeSafeTask = composeAgentContextTask("Prototype safe.", prototypeSafeContext, researcherProfile);
  } finally {
    delete Object.prototype.wiki;
    delete Array.prototype[0];
  }
  assert(
    inheritedContextGetterExecutions === 0 && inheritedArraySetterExecutions === 0 &&
      prototypeSafeContext.wiki?.[0] === "art_exact" && !prototypeSafeTask.includes("inherited-route"),
    "Context normalization dispatched inherited getters/setters or invented/dropped a route",
  );
  let inheritedToJsonGetterExecutions = 0;
  let inheritedToJsonMethodExecutions = 0;
  Object.defineProperty(Array.prototype, "toJSON", {
    configurable: true,
    get() {
      inheritedToJsonGetterExecutions += 1;
      return function poisonedToJson() {
        inheritedToJsonMethodExecutions += 1;
        return [];
      };
    },
  });
  let leftContextDigest;
  let rightContextDigest;
  try {
    leftContextDigest = agentContextAttribution({ wiki: ["art_left"] }).digest;
    rightContextDigest = agentContextAttribution({ wiki: ["art_right"] }).digest;
  } finally {
    delete Array.prototype.toJSON;
  }
  assert(
    inheritedToJsonGetterExecutions === 0 && inheritedToJsonMethodExecutions === 0 &&
      leftContextDigest !== rightContextDigest,
    "Context attribution dispatched inherited toJSON or collapsed distinct route digests",
  );
  for (const invalidContext of [
    { mode: undefined },
    { seed: undefined },
    { wiki: undefined },
    { sessions: [{ session_id: "session", seq_lo: undefined, seq_hi: 2 }] },
    { sessions: [{ session_id: "session" }] },
  ]) {
    let rejected = false;
    try {
      normalizeAgentContext(invalidContext);
    } catch {
      rejected = true;
    }
    assert(rejected, `Runtime Context validation accepted schema-invalid input ${JSON.stringify(invalidContext)}`);
  }

  const workflowStateRoot = join(tmpdir(), `pi-agent-workflow-verify-${process.pid}`);
  rmSync(workflowStateRoot, { recursive: true, force: true });
  const workflowHandlers = new Map();
  const workflowRequests = [];
  let workflowAgentTool;
  const workflowPi = {
    async exec() {
      return { code: 0, stdout: `${workflowStateRoot}\n`, stderr: "" };
    },
    getActiveTools() { return []; },
    events: {
      on(name, handler) {
        const handlers = workflowHandlers.get(name) ?? [];
        handlers.push(handler);
        workflowHandlers.set(name, handlers);
        return () => workflowHandlers.set(name, handlers.filter((candidate) => candidate !== handler));
      },
      emit(name, payload) {
        if (name === "subagents:rpc:v1:request" && payload?.method === "spawn") {
          workflowRequests.push(payload);
          const replyName = `subagents:rpc:v1:reply:${payload.requestId}`;
          const reply = {
            version: 1,
            requestId: payload.requestId,
            method: "spawn",
            success: true,
            data: {
              text: "started",
              details: { asyncId: `native-${workflowRequests.length}`, context: payload.params.context },
            },
          };
          for (const handler of workflowHandlers.get(replyName) ?? []) handler(reply);
          return;
        }
        for (const handler of workflowHandlers.get(name) ?? []) handler(payload);
      },
    },
    on() {},
    registerCommand() {},
    registerTool(tool) { workflowAgentTool = tool; },
  };
  registerAgentTool(workflowPi);
  const workflowCtx = {
    cwd: projectRoot,
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    modelRegistry: {
      getAvailable() {
        return ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((id) => ({
          provider: "openai-codex",
          id,
          reasoning: true,
        }));
      },
    },
    sessionManager: {
      getSessionId: () => "workflow-context-session",
      getSessionFile: () => "/tmp/workflow-context-session.jsonl",
    },
  };
  try {
    const parallelWorkflow = await workflowAgentTool.execute(
      "verify-parallel-context",
      {
        tasks: [
          { profile: "researcher", task: "Map A.", context: { mode: "fresh", wiki: ["meta/memory"] } },
          { profile: "reviewer", task: "Review B.", context: { mode: "fresh", seed: "B evidence" } },
        ],
      },
      new AbortController().signal,
      undefined,
      workflowCtx,
    );
    const chainWorkflow = await workflowAgentTool.execute(
      "verify-chain-context",
      {
        chain: [
          { profile: "researcher", task: "Build evidence.", context: { mode: "fork", wiki: ["meta/memory"] } },
          { profile: "reviewer", task: "Review {previous}", context: { mode: "fork", seed: "Review context" } },
        ],
      },
      new AbortController().signal,
      undefined,
      workflowCtx,
    );
    assert(
      parallelWorkflow.details?.workflow?.runId === "native-1" &&
        chainWorkflow.details?.workflow?.runId === "native-2" && workflowRequests.length === 2,
      "Governed multi-agent Context did not launch through package-native workflows",
    );
    const parallelParams = workflowRequests[0].params;
    const chainParams = workflowRequests[1].params;
    assert(
      parallelParams.async === true && parallelParams.context === "fresh" && parallelParams.tasks?.length === 2 &&
        !parallelParams.chain && chainParams.async === true && chainParams.context === "fork" &&
        chainParams.chain?.length === 2 && !chainParams.tasks && chainParams.chain[1].task.includes("{previous}"),
      "Context workflow adapter changed package mode, topology, or chain substitution",
    );
    assert(
      parallelWorkflow.details.workflow.contracts.every((contract) => /^[a-f0-9]{64}$/.test(contract.preflightLaunchContractDigest)) &&
        chainWorkflow.details.workflow.contracts.every((contract) => contract.context.mode === "fork"),
      "Package-native workflow omitted preflight/context attribution",
    );
    let writerWorkflowBlocked = false;
    try {
      await workflowAgentTool.execute(
        "verify-writer-workflow",
        {
          chain: [
            { profile: "implementer", task: "Edit." },
            { profile: "reviewer", task: "Review {previous}" },
          ],
        },
        new AbortController().signal,
        undefined,
        workflowCtx,
      );
    } catch (error) {
      writerWorkflowBlocked = String(error).includes("Package-native workflows are read-only");
    }
    assert(writerWorkflowBlocked && workflowRequests.length === 2, "A multi-writer workflow started outside one governed worktree");
  } finally {
    rmSync(workflowStateRoot, { recursive: true, force: true });
  }
  assert(
    activeToolNames({ getActiveTools: () => ["read", "plan_mode_complete"] }).has("plan_mode_complete"),
    "Agent wrapper does not recognize Pi's string-valued active tool list; Plan-mode writer refusal would fail open",
  );
  assert(
    activeToolNames({ getAllTools: () => [{ name: "read" }, { name: "plan_mode_complete" }] }).has(
      "plan_mode_complete",
    ),
    "Agent wrapper fallback does not recognize object-valued tool metadata",
  );
  const planPi = { getActiveTools: () => ["read", "plan_mode_complete"] };
  let planWriterBlocked = false;
  try {
    assertPlanModeLaunch(planPi, [resolveAgentLaunch(configuration, "implementer", "openai-codex")]);
  } catch (error) {
    planWriterBlocked = String(error).includes("only read-only governed profiles");
  }
  assert(planWriterBlocked, "Plan mode did not refuse the governed write profile");
  assertPlanModeLaunch(planPi, [resolveAgentLaunch(configuration, "researcher", "openai-codex")]);
  const reconciliationOrder = [];
  await Promise.all([
    withJobReconciliation("verify-job-queue", async () => {
      reconciliationOrder.push("first:start");
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      reconciliationOrder.push("first:end");
    }),
    withJobReconciliation("verify-job-queue", async () => {
      reconciliationOrder.push("second:start");
      reconciliationOrder.push("second:end");
    }),
  ]);
  assert(
    JSON.stringify(reconciliationOrder) ===
      JSON.stringify(["first:start", "first:end", "second:start", "second:end"]),
    `Per-job lifecycle reconciliation is not serialized: ${JSON.stringify(reconciliationOrder)}`,
  );
  const ownedAsyncMetadata = {
    jobId: "owned-async-job",
    parentSessionId: "session-id",
    parentSessionFile: "/session.jsonl",
  };
  assertGovernedAsyncOwnership(
    ownedAsyncMetadata,
    { sessionId: "/session.jsonl" },
    "session-id",
    "/session.jsonl",
  );
  for (const [metadata, lifecycle, activeId, activeFile] of [
    [{ ...ownedAsyncMetadata, parentSessionId: "foreign" }, { sessionId: "/session.jsonl" }, "session-id", "/session.jsonl"],
    [ownedAsyncMetadata, { sessionId: "/foreign.jsonl" }, "session-id", "/session.jsonl"],
    [ownedAsyncMetadata, { sessionId: "/session.jsonl" }, "session-id", "/different.jsonl"],
  ]) {
    let blocked = false;
    try {
      assertGovernedAsyncOwnership(metadata, lifecycle, activeId, activeFile);
    } catch {
      blocked = true;
    }
    assert(blocked, "Cross-session async ownership drift did not fail closed");
  }

  const attributedLaunch = {
    provider: "openai-codex",
    fullModel: "openai-codex/gpt-5.6-sol",
    thinking: "high",
  };
  assertResponseAttribution(
    { model: "openai-codex/gpt-5.6-sol:high", thinking: "high" },
    attributedLaunch,
  );
  const authoritativeLaunchDigest = "a".repeat(64);
  assertObservedLaunchContractDigest(authoritativeLaunchDigest, authoritativeLaunchDigest);
  let launchDigestDriftBlocked = false;
  try {
    assertObservedLaunchContractDigest("b".repeat(64), authoritativeLaunchDigest);
  } catch {
    launchDigestDriftBlocked = true;
  }
  assert(launchDigestDriftBlocked, "A present but non-authoritative delegation launch digest was accepted");
  for (const response of [
    { thinking: "high" },
    { model: "openai-codex/gpt-5.6-sol:high" },
    { model: "openai-codex/gpt-5.6-sol:low", thinking: "high" },
    { model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  ]) {
    let blocked = false;
    try {
      assertResponseAttribution(response, attributedLaunch);
    } catch {
      blocked = true;
    }
    assert(blocked, "Delegated execution with missing observed attribution did not fail closed");
  }
  const partialEvidence = boundedDelegationEvidence(
    {
      runId: "package-run-1",
      currentTool: "inspect_repo",
      recentOutput: "e".repeat(20_000),
      toolCount: 9,
      durationMs: 12_345,
    },
    () => "2026-07-26T00:00:00.000Z",
  );
  assert(partialEvidence.observedAt === "2026-07-26T00:00:00.000Z", "Partial evidence lacks an observation time");
  assert(partialEvidence.runId === "package-run-1", "Partial evidence omitted the package revival target");
  assert(partialEvidence.recentOutput.includes("Partial evidence truncated"), "Partial evidence is not bounded");
  assert(Buffer.byteLength(partialEvidence.recentOutput, "utf8") < 9_000, "Partial evidence cap is ineffective");
  const stat = `123 (pi coordinator) S ${Array(18).fill("0").join(" ")} 456 0`;
  const coordinatorIdentity = await captureCoordinatorIdentity(123, {
    readProc: async () => stat,
    localHostname: "host-a",
  });
  assert(coordinatorIdentity.startTicks === "456", "Coordinator PID reuse token was parsed incorrectly");
  assert(
    await coordinatorLiveness(coordinatorIdentity, { readProc: async () => stat, localHostname: "host-a" }) === "live",
    "Live foreground coordinator was not recognized",
  );
  const reusedStat = `123 (pi coordinator) S ${Array(18).fill("0").join(" ")} 789 0`;
  assert(
    await coordinatorLiveness(coordinatorIdentity, { readProc: async () => reusedStat, localHostname: "host-a" }) === "dead",
    "Reused coordinator PID was not classified as dead",
  );
  assert(
    packageLifecycleStartupPending({ packageStartedAt: "2026-07-26T00:00:00.000Z" }, Date.parse("2026-07-26T00:00:10.000Z")),
    "Async startup lifecycle race is not tolerated inside the bounded grace window",
  );
  assert(
    !packageLifecycleStartupPending({ packageStartedAt: "2026-07-26T00:00:00.000Z" }, Date.parse("2026-07-26T00:00:16.000Z")),
    "Missing async lifecycle status is tolerated beyond the bounded grace window",
  );
  const resumableNode = {
    contractDigest: "contract-digest",
    launchContractDigest: "launch-contract-digest",
    agentDefinitionDigest: "agent-definition-digest",
    mode: "read-only",
  };
  assertGovernedResumeContract({ schemaVersion: 2 }, resumableNode);
  for (const [metadata, node] of [
    [{ schemaVersion: 1 }, resumableNode],
    [{ schemaVersion: 2 }, { ...resumableNode, mode: "write" }],
    [{ schemaVersion: 2 }, { ...resumableNode, launchContractDigest: undefined }],
  ]) {
    let blocked = false;
    try {
      assertGovernedResumeContract(metadata, node);
    } catch {
      blocked = true;
    }
    assert(blocked, "Governed resume accepted an unversioned, writable, or unattributed source");
  }
  const interrupted = {
    status: "running",
    nodes: [{ status: "running", partialEvidence: { runId: "foreground-run-1" } }],
  };
  assert(markInterruptedForeground(interrupted, () => "interrupted-at"), "Interrupted foreground job was not classified");
  assert(
    interrupted.nodes[0].resumeSourceRunId === "foreground-run-1",
    "Interrupted foreground job did not preserve its package revival target",
  );
  assert(
    resumeSourceRunId(interrupted, interrupted.nodes[0]) === "foreground-run-1",
    "Governed resume did not resolve the attributed node run",
  );
  assert(
    currentRevival({ revivals: [{ runId: "old" }, { runId: "current" }] }, "current")?.runId === "current",
    "Revival lifecycle lookup failed",
  );

  let invalidRpcEnvelope = false;
  const rpcHandlers = new Map();
  const rpcPi = {
    events: {
      on(event, handler) {
        rpcHandlers.set(event, handler);
        return () => rpcHandlers.delete(event);
      },
      emit(event, payload) {
        if (event !== "subagents:rpc:v1:request") return;
        const reply = {
          version: 1,
          requestId: payload.requestId,
          method: invalidRpcEnvelope ? "status" : payload.method,
          success: true,
          data: { ok: true },
        };
        queueMicrotask(() => rpcHandlers.get(`subagents:rpc:v1:reply:${payload.requestId}`)?.(reply));
      },
    },
  };
  assert((await callSubagentRpc(rpcPi, "ping", {}, 1_000)).ok, "Attributed package RPC reply failed");
  invalidRpcEnvelope = true;
  let invalidRpcBlocked = false;
  try {
    await callSubagentRpc(rpcPi, "ping", {}, 1_000);
  } catch {
    invalidRpcBlocked = true;
  }
  assert(invalidRpcBlocked, "Package RPC reply with method drift did not fail closed");

  const readOnlyLaunch = { profile: { mode: "read-only" } };
  const writerLaunch = { profile: { mode: "write" } };
  const zeroActivityFailure = {
    status: "failed",
    error: "Subagent produced no output (possible model cold-start or empty response).",
    usage: { turns: 0, toolCalls: 0 },
  };
  assert(
    retryableReadOnlyStartupFailure(zeroActivityFailure, readOnlyLaunch),
    "Read-only zero-activity startup failures are not classified for bounded retry",
  );
  assert(
    !retryableReadOnlyStartupFailure(zeroActivityFailure, writerLaunch),
    "Writer startup failures must never be retried automatically",
  );
  assert(
    !retryableReadOnlyStartupFailure({ ...zeroActivityFailure, status: "timed_out" }, readOnlyLaunch),
    "Read-only absolute timeouts must not be replayed automatically",
  );
  for (const error of [
    "Subagent timed out after 300000ms.",
    "temporarily unavailable: deadline exceeded",
    "request aborted after maximum runtime",
    "operation expired",
  ]) {
    assert(
      !retryableReadOnlyStartupFailure({ ...zeroActivityFailure, error }, readOnlyLaunch),
      `Timeout/deadline failure was replayable: ${error}`,
    );
  }
  assert(
    !retryableReadOnlyStartupFailure(
      { ...zeroActivityFailure, error: "temporarily unavailable" },
      readOnlyLaunch,
    ),
    "Unclassified transient text must not be treated as a positive startup classification",
  );
  assert(
    !retryableReadOnlyStartupFailure(
      { status: "failed", error: zeroActivityFailure.error },
      readOnlyLaunch,
    ),
    "Missing activity telemetry must not be treated as affirmative zero activity",
  );
  assert(
    !retryableReadOnlyStartupFailure(
      { ...zeroActivityFailure, usage: { turns: 1, toolCalls: 0 } },
      readOnlyLaunch,
    ),
    "Failures after child activity must not be replayed automatically",
  );
  const retryResponses = [
    { ...zeroActivityFailure, runId: "attempt-1" },
    { status: "completed", runId: "attempt-2", usage: { turns: 1, toolCalls: 0 } },
  ];
  const observedBackoff = [];
  const retried = await runWithClassifiedStartupRetry(
    readOnlyLaunch,
    async (attempt) => retryResponses[attempt - 1],
    { wait: async (milliseconds) => observedBackoff.push(milliseconds) },
  );
  assert(retried.attempts.length === 2, "Classified read-only startup retry was not bounded to one replay");
  assert(retried.response.runId === "attempt-2", "Classified retry did not return the successful second attempt");
  assert(
    JSON.stringify(observedBackoff) === JSON.stringify([750]),
    `Classified retry backoff drifted: ${JSON.stringify(observedBackoff)}`,
  );
  const writerAttempt = await runWithClassifiedStartupRetry(
    writerLaunch,
    async () => ({ ...zeroActivityFailure, runId: "writer-attempt" }),
    { wait: async () => { throw new Error("writer retry must not wait"); } },
  );
  assert(writerAttempt.attempts.length === 1, "Writer startup failure was replayed automatically");
  const {
    cleanupStaleGovernedChildHomes,
    prepareGovernedChildEnvironment,
    registerChildAgentPolicy,
  } = await jiti.import(join(projectRoot, ".pi", "extensions", "quorum", "agent-child.mjs"));
  const staleChildHome = join(tmpdir(), `quorum-pi-child-stale-${process.pid}`);
  mkdirSync(staleChildHome, { recursive: true });
  writeFileSync(join(staleChildHome, "stale"), "stale\n");
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(staleChildHome, oldTime, oldTime);
  cleanupStaleGovernedChildHomes(tmpdir());
  assert(!existsSync(staleChildHome), "Governed child home janitor retained stale state");

  const localEnvironment = {
    HOME: "/home/tester",
    PATH: process.env.PATH,
    EXA_API_KEY: "must-be-cleared",
    GH_TOKEN: "must-be-cleared",
    OP_SESSION_TEST: "must-be-cleared",
    PI_ALLOW_BROWSER_COOKIES: "1",
    PI_CODING_AGENT_DIR: "/sensitive/config",
  };
  const localEnvironmentResult = prepareGovernedChildEnvironment(localEnvironment, tmpdir(), "local");
  try {
    assert(localEnvironment.HOME === localEnvironmentResult.home, "Governed local child did not receive an isolated home");
    assert(localEnvironment.QUORUM_MEMORY_DATA === "/home/tester/quorum-memory", "Local child memory path was not preserved explicitly");
    assert(localEnvironment.PYTHONPATH === "/home/tester/attractor", "Local child MCP dependency path retained ambient values");
    for (const name of ["EXA_API_KEY", "GH_TOKEN", "OP_SESSION_TEST", "PI_ALLOW_BROWSER_COOKIES", "PI_CODING_AGENT_DIR", "GIT_CONFIG_GLOBAL"]) {
      assert(localEnvironment[name] === undefined, `Governed local child retained ambient credential/config ${name}`);
    }
  } finally {
    rmSync(localEnvironmentResult.home, { recursive: true, force: true });
  }

  const webEnvironment = {
    HOME: "/home/tester",
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    PI_SUBAGENT_CHILD: "1",
    PI_SUBAGENT_CHILD_AGENT: "web-researcher",
    PI_SUBAGENT_AMBIENT_API_KEY: "must-be-cleared",
    ANTHROPIC_API_KEY: "must-be-cleared",
    AWS_ACCESS_KEY_ID: "must-be-cleared",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
    NPM_TOKEN: "must-be-cleared",
    OPENAI_API_KEY: "must-be-cleared",
    QUORUM_MEMORY_DATA: "/private/memory",
    PYTHONPATH: "/private/python",
    GIT_CONFIG_GLOBAL: "/private/gitconfig",
  };
  const webEnvironmentResult = prepareGovernedChildEnvironment(webEnvironment, tmpdir(), "web");
  try {
    assert(webEnvironmentResult.home !== localEnvironmentResult.home, "Governed child homes are predictable or reused");
    assert(webEnvironment.HOME === webEnvironmentResult.home, "Governed web child did not receive an isolated home");
    assert(webEnvironment.PI_SUBAGENT_CHILD_AGENT === "web-researcher", "Web child lost package lifecycle identity");
    for (const name of ["PI_SUBAGENT_AMBIENT_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS", "NPM_TOKEN", "OPENAI_API_KEY", "QUORUM_MEMORY_DATA", "PYTHONPATH"]) {
      assert(webEnvironment[name] === undefined, `Governed web child retained ambient credential/config ${name}`);
    }
    assert(
      webEnvironment.GIT_DIR === "/dev/null"
        && webEnvironment.GIT_WORK_TREE === "/dev/null"
        && webEnvironment.GIT_CONFIG_GLOBAL === "/dev/null"
        && webEnvironment.GIT_CONFIG_SYSTEM === "/dev/null",
      "Governed web child retained repository or host Git configuration",
    );
    const webConfig = readJson(webEnvironmentResult.webConfig);
    assert(webConfig.provider === "auto" && webConfig.githubClone.enabled === false, "Isolated child web config forces a provider or enables cloning");
  } finally {
    rmSync(webEnvironmentResult.home, { recursive: true, force: true });
  }

  const previousChildAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  try {
    const localHandlers = new Map();
    process.env.PI_SUBAGENT_CHILD_AGENT = "researcher";
    const localRuntime = registerChildAgentPolicy({
      on(event, handler) { localHandlers.set(event, handler); },
      registerTool() {},
    }, { toolSurface: "local" });
    const localToolCall = localHandlers.get("tool_call");
    assert(localToolCall, "Local child runtime did not install its authorization guard");
    assert(!(await localToolCall({ toolName: "read", input: { path: "AGENTS.md" } }, { cwd: projectRoot }))?.block, "Local child cannot read governed source");
    assert(!(await localToolCall({ toolName: "read", input: { path: "/etc/hosts" } }, { cwd: projectRoot }))?.block, "Local child read was unnecessarily narrowed");
    const localSearchInput = { query: "public package documentation" };
    assert(!(await localToolCall({ toolName: "web_search", input: localSearchInput }, { cwd: projectRoot }))?.block, "Local child cannot use web search");
    assert(localSearchInput.provider === undefined, "Local child web search forced a provider");
    assert(localRuntime.status() === "child-policy: researcher/local", "Local child runtime bound the wrong profile");

    const scoutHandlers = new Map();
    process.env.PI_SUBAGENT_CHILD_AGENT = "scout";
    const scoutRuntime = registerChildAgentPolicy({
      on(event, handler) { scoutHandlers.set(event, handler); },
      registerTool() {},
    }, { toolSurface: "local" });
    const scoutToolCall = scoutHandlers.get("tool_call");
    assert(
      !(await scoutToolCall({ toolName: "web_search", input: { query: "public package documentation" } }, { cwd: projectRoot }))?.block,
      "Community scout cannot use its declared web_search tool",
    );
    assert(
      (await scoutToolCall({ toolName: "write", input: { path: "escape.txt", content: "blocked" } }, { cwd: projectRoot }))?.block,
      "Community scout can mutate the project without a governed writer worktree",
    );
    const scoutBash = { toolName: "bash", input: { command: "git status --short" } };
    assert(!(await scoutToolCall(scoutBash, { cwd: projectRoot }))?.block, "Community scout lost read-only Bash inspection");
    assert(scoutBash.input.command.includes("/usr/bin/bwrap"), "Community scout Bash did not use the read-only sandbox");
    assert(scoutRuntime.status() === "child-policy: scout/local", "Community scout runtime lost package identity");

    const webHandlers = new Map();
    process.env.PI_SUBAGENT_CHILD_AGENT = "web-researcher";
    const webRuntime = registerChildAgentPolicy({
      on(event, handler) { webHandlers.set(event, handler); },
      registerTool() {},
    }, { toolSurface: "web" });
    const webToolCall = webHandlers.get("tool_call");
    const webInput = { query: "official Pi documentation" };
    assert(!(await webToolCall({ toolName: "web_search", input: webInput }, { cwd: projectRoot }))?.block, "Web child cannot use search");
    assert(webInput.provider === undefined && webInput.workflow === undefined, "Web search policy overrode package provider/workflow selection");
    const sourceInput = { claim: "Pi has extensions" };
    assert(!(await webToolCall({ toolName: "source_check", input: sourceInput }, { cwd: projectRoot }))?.block, "Web child cannot use source checking");
    assert(sourceInput.provider === undefined, "Source checking policy forced a provider");
    assert(!(await webToolCall({ toolName: "get_search_content", input: { responseId: "x" } }, { cwd: projectRoot }))?.block, "Web child cannot page stored search evidence");
    const fetchInput = { url: "https://example.com", forceClone: true };
    assert(!(await webToolCall({ toolName: "fetch_content", input: fetchInput }, { cwd: projectRoot }))?.block, "Web child cannot retrieve public HTTP content");
    assert(fetchInput.forceClone === false, "Web child can force a Git clone side effect");
    assert((await webToolCall({ toolName: "fetch_content", input: { url: "file:///etc/hosts" } }, { cwd: projectRoot }))?.block, "Web child can fetch local files");
    for (const toolName of ["read", "bash", "inspect_repo", "wiki_read"]) {
      assert((await webToolCall({ toolName, input: {} }, { cwd: projectRoot }))?.block, `Web child can call forbidden local tool ${toolName}`);
    }
    assert(webRuntime.status() === "child-policy: web-researcher/web", "Web child runtime bound the wrong profile");
  } finally {
    if (previousChildAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previousChildAgent;
  }

  const childExtensionPath = join(projectRoot, ".pi", "extensions", "quorum", "child.mjs");
  const webChildExtensionPath = join(projectRoot, ".pi", "extensions", "quorum", "web-child.mjs");
  const runtimeExtensionPath = join(projectRoot, ".pi", "extensions", "quorum", "runtime.mjs");
  assert(existsSync(childExtensionPath), "Dependency-free Quorum child extension is missing");
  assert(existsSync(webChildExtensionPath), "Policy-only Quorum web-child extension is missing");
  assert(existsSync(runtimeExtensionPath), "Shared Quorum MCP runtime extension is missing");
  const childSource = readFileSync(childExtensionPath, "utf8");
  const webChildSource = readFileSync(webChildExtensionPath, "utf8");
  const runtimeSource = readFileSync(runtimeExtensionPath, "utf8");
  assert(
    !runtimeSource.includes("projectionRefusal") &&
      runtimeSource.includes('pi.on("agent_settled", async') &&
      runtimeSource.includes("model: exactModel") &&
      runtimeSource.includes("activateEphemeralMemoryProjection") &&
      runtimeSource.includes('pi.appendEntry("quorum-memory-influence"') &&
      !runtimeSource.includes('message: {\n          customType: "quorum-project-memory"') &&
      childSource.includes("runtime.activateEphemeralMemoryProjection()"),
    "Live memory injection can persist recommendation payloads, lose influence receipts, or misattribute exposure telemetry",
  );
  assert(!childSource.includes("pi-subagents/src"), "Quorum child entrypoint imports coordinator-only pi-subagents source");
  assert(!webChildSource.includes("registerQuorumRuntime") && !webChildSource.includes("runtime.mjs"), "Web child entrypoint loads local memory/runtime services");
  const childPolicySource = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "agent-child.mjs"), "utf8");
  assert(childPolicySource.includes("/usr/bin/bwrap"), "Writer bash is not routed through Bubblewrap");
  assert(childPolicySource.includes('"--unshare-all"'), "Writer bash sandbox does not isolate namespaces/network");
  assert(childPolicySource.includes('"--ro-bind", "/", "/"'), "Writer bash sandbox does not make the host root read-only");
  assert(childPolicySource.includes('"--tmpfs", "/run"'), "Writer bash sandbox exposes host runtime sockets");
  assert(childPolicySource.includes('"--tmpfs", "/home/shane"'), "Writer bash sandbox exposes host home sockets and secrets");
  assert(childPolicySource.includes('"--seccomp", "3"'), "Writer bash sandbox does not load its syscall policy");
  assert(
    childPolicySource.includes("WRITER_SECCOMP_BPF_BASE64") && childPolicySource.includes("io_uring"),
    "Writer syscall policy does not close AF_UNIX and io_uring socket escapes",
  );
  assert(childPolicySource.includes("quorum_commit"), "Controlled writer commit tool is missing from child policy");
  for (const toolName of webToolNames) {
    assert(childPolicySource.includes(`"${toolName}"`), `Child policy omits governed web tool ${toolName}`);
  }
  assert(
    childPolicySource.includes("WEB_CHILD_TOOLS") &&
      childPolicySource.includes("WEB_EGRESS_TOOLS") &&
      childPolicySource.includes("absolute public HTTP(S) URLs") &&
      childPolicySource.includes("prepareGovernedChildEnvironment") &&
      !childPolicySource.includes("governedChildReadPolicy"),
    "Child policy does not preserve the local/web trust boundary with permissive local reads",
  );

  const agentSource = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "agent.js"), "utf8");
  assert(agentSource.includes("SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION"), "Agent wrapper is not using delegation v2");
  assert(agentSource.includes("resolveSubagentLaunchContract"), "Agent wrapper is not using pi-subagents preflight");
  assert(
    !agentSource.includes("MAX_CONCURRENCY") &&
      !agentSource.includes("mapWithLimit") &&
      !agentSource.includes("Promise.all(metadata.nodes.map") &&
      agentSource.includes('callSubagentRpc(pi, "spawn", {') &&
      agentSource.includes('mode === "parallel" ? { tasks: nativeItems } : { chain: nativeItems }'),
    "Agent wrapper must hand multi-agent graph execution to pi-subagents",
  );
  assert(
    !agentSource.includes("context: contexts[index]") && !agentSource.includes("context: context,\n") &&
      agentSource.includes("const payload = `${stableStringify(value)}\\n`") &&
      agentSource.includes("contextMode: context.mode") &&
      agentSource.includes("contextAttribution: agentContextAttribution(context)"),
    "Agent metadata persists raw curated Context instead of mode/routes/hashes",
  );
  assert(
    !agentSource.includes("params.timeout_seconds ??") &&
      !agentSource.includes('maximum: 86400') &&
      agentSource.includes("timeoutSeconds === undefined ? {} : { timeoutMs"),
    "Agent wrapper must not add a default child timeout",
  );
  assert(!agentSource.includes("systemd-run"), "Retired bespoke systemd child runtime is still present");
  assert(agentSource.includes("run_pi_subagent.sh"), "Agent wrapper does not clear inherited coordinator provenance");
  assert(
    agentSource.includes('"cancel", "steer", "interrupt", "resume", "clean"') &&
      agentSource.includes('callSubagentRpc(\n              pi,\n              "steer"') &&
      agentSource.includes('callSubagentRpc(pi, "interrupt"') &&
      agentSource.includes('callSubagentRpc(pi, "resume"') &&
      agentSource.includes("assertGovernedResumeContract") &&
      agentSource.includes("profileContentDigest") &&
      !agentSource.includes("profileRuntimeDigest") &&
      agentSource.includes('outputMode: "file-only"') &&
      agentSource.includes('const requiredMethods = ["status", "spawn", "steer", "interrupt", "resume"]'),
    "Governed package-owned steering and revival surface is incomplete",
  );
  assert(
    agentSource.includes("requestAsyncStop(asyncDir") &&
      agentSource.includes('transport: "pi-subagents-control-inbox"') &&
      !agentSource.includes('callSubagentRpc(pi, "stop"'),
    "Governed cancellation does not use the package-owned, session-attributed control inbox",
  );
  assert(
    agentSource.includes("worktreeGitDir") &&
      agentSource.includes("worktreeCommonDir") &&
      agentSource.includes("identityDrifted"),
    "Writer finalization does not pin and revalidate Git administrative identity",
  );
  assert(agentSource.includes("ATOMIC_WRITE_QUEUES"), "Agent metadata writes are not serialized per job path");
  assert(agentSource.includes("${randomUUID()}.tmp"), "Agent metadata temp files are not collision-resistant");
  assert(
    agentSource.includes("persistedJobs.map(async (job)") && agentSource.includes("refreshAsyncJob(job)"),
    "Agent list does not reconcile stale package-owned background lifecycle state",
  );
  assert(
    agentSource.includes("JOB_RECONCILIATION_QUEUES") &&
      agentSource.includes("const current = await loadJob(stateRoot, metadata.jobId)"),
    "Background lifecycle reconciliation does not serialize and reload canonical job state",
  );
  assert(
    agentSource.includes("coordinatorIdentity: await captureCoordinatorIdentity()") &&
      agentSource.includes("const liveness = await coordinatorLiveness(current.coordinatorIdentity)") &&
      agentSource.includes('if (liveness !== "dead")'),
    "Foreground stale recovery can fail another live or unverifiable coordinator",
  );
  assert(
    agentSource.includes("classified-read-only-zero-activity-startup-failure"),
    "Agent wrapper lacks attributed bounded retry for zero-activity read-only startup failures",
  );
  assert(existsSync(join(projectRoot, "scripts", "run_pi_subagent.sh")), "Canonical child launch wrapper is missing");
  assert(
    existsSync(join(projectRoot, "scripts", "verify_pi_writer_sandbox.mjs")),
    "Writer sandbox verification script is missing",
  );
  assert(!existsSync(join(projectRoot, "scripts", "run_pi_agent_job.mjs")), "Retired bespoke child runner still exists");

  const activeContextPath = join(projectRoot, ".pi", "extensions", "quorum", "active-context.ts");
  const sharedJsonPath = join(projectRoot, ".pi", "extensions", "quorum", "json.ts");
  const retiredContextRoot = join(projectRoot, ".pi", "extensions", "quorum", "context");
  const projectSettings = JSON.parse(readFileSync(join(projectRoot, ".pi", "settings.json"), "utf8"));
  assert(existsSync(activeContextPath), "Pi active-context folding service is missing");
  assert(existsSync(sharedJsonPath), "Shared exact JSON/hash helper is missing");
  assert(!existsSync(retiredContextRoot), "Retired context-governor module tree still exists");
  assert(!existsSync(join(projectRoot, ".pi", "context-governor.json")), "Retired context-governor config still exists");
  assert(projectSettings.compaction?.enabled === false, "Stock Pi automatic compaction must remain disabled");
  assert(!Object.hasOwn(projectSettings, "summaryCheckpoints"), "Patched-Pi summary settings remain in project config");
  assert(projectSettings.branchSummary?.skipPrompt === true, "Tree summary prompts must default off");

  const extensionIndex = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "index.js"), "utf8");
  const extensionBase = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "base.js"), "utf8");
  const activeContextSource = readFileSync(activeContextPath, "utf8");
  const contextRuntimeSource = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "runtime.mjs"), "utf8");
  assert(
    extensionBase.includes("registerActiveContext") &&
      extensionIndex.includes("export function registerQuorumExtension") &&
      extensionIndex.includes("activeContextEnabled = ACTIVE_CONTEXT_ENABLED") &&
      extensionIndex.includes("if (memoryProjectionEnabled)") &&
      extensionIndex.includes("const ACTIVE_CONTEXT_ENABLED = true") &&
      !extensionIndex.includes("registerNativeCheckpointGuards") &&
      !extensionIndex.includes("registerContextGovernor"),
    "Quorum extension must retain only the accepted active-context replacement with proven registration enabled",
  );
  for (const soakScript of [
    "run_pi_context_soak.mjs", "run_pi_context_soak_worker.mjs",
    "adjudicate_pi_context_soak.mjs", "verify_pi_context_soak.mjs",
    "verify_pi_context_soak_boot.mjs",
  ]) {
    assert(existsSync(join(projectRoot, "scripts", soakScript)), `Missing context soak script ${soakScript}`);
  }
  assert(existsSync(join(projectRoot, "scripts", "launch_pi_context_soak.sh")) &&
    existsSync(join(projectRoot, "scripts", "adjudicate_pi_context_soak.sh")),
  "Missing sanitized context soak launcher or adjudicator");
  assert(
    activeContextSource.includes('name: "quorum_context"') &&
      activeContextSource.includes('"folded" | "expanded"') &&
      activeContextSource.includes('pi.on("context"') &&
      activeContextSource.includes('pi.on("turn_end"') &&
      activeContextSource.includes("selectAutomaticToolBatch") &&
      activeContextSource.includes("selectAutomaticRefold") &&
      activeContextSource.includes("projectWithContextGuidance") &&
      activeContextSource.includes("projectionSlateCandidates") &&
      activeContextSource.includes("abortUnsafeHardContext") &&
      activeContextSource.includes("Pi hard-fence abort capability is unavailable") &&
      !activeContextSource.includes('pi.on("before_provider_request"') &&
      activeContextSource.includes('pi.on("session_before_compact"') &&
      activeContextSource.includes('reason === "threshold"') &&
      activeContextSource.includes('reason === "overflow"') &&
      activeContextSource.includes("return { cancel: true }") &&
      !activeContextSource.includes('action: "handled"') &&
      !activeContextSource.includes('action: "cancel"') &&
      !activeContextSource.includes("automatic-tool") &&
      !activeContextSource.includes("agent-only") &&
      !activeContextSource.includes("QUORUM_CONTEXT_GOVERNOR_MODE"),
    "Active context must remain reversible/pageable, keep durable guidance gated off, and fail closed at the hard fence",
  );
  assert(
    contextRuntimeSource.includes("memory_context") && contextRuntimeSource.includes("ctx.abort()"),
    "Required fail-closed memory_context admission was weakened",
  );
  assert(
    agentSource.includes('const CONTEXT_SUMMARIZER_PROVIDER = "openai-codex"') &&
      agentSource.includes('const CONTEXT_SUMMARIZER_MODEL = "gpt-5.6-luna"') &&
      agentSource.includes('const CONTEXT_SUMMARIZER_THINKING = "medium"') &&
      agentSource.includes("beforeRefs") && agentSource.includes("afterRefs") &&
      agentSource.includes("finish(rejectPromise, error)") &&
      agentSource.includes("pi-subagents"),
    "Exact pi-subagents Luna-medium context-brief contract drifted",
  );
  assert(existsSync(join(projectRoot, "scripts", "verify_pi_context_service.mjs")), "Active-context verifier is missing");
  assert(!existsSync(join(projectRoot, "scripts", "replay_pi_context.mjs")), "Retired context replay verifier still exists");
  assert(!existsSync(join(projectRoot, "scripts", "verify_pi_context_governor.mjs")), "Retired governor verifier still exists");
  return contracts;
}

function runJsonGate(script, args = []) {
  const stdout = execFileSync(process.execPath, [join(projectRoot, "scripts", script), ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, report: JSON.parse(stdout) };
}

let client;
try {
  const packagePolicy = verifyPackagePolicy();
  const agentContracts = await verifyAgentContracts();
  // The dependency-free active-context gate runs before mutable live qmem checks.
  const serviceFirst = runJsonGate("verify_pi_context_service.mjs");
  const serviceSecond = runJsonGate("verify_pi_context_service.mjs");
  assert(serviceFirst.report.ok === true && serviceSecond.report.ok === true, "Active-context service gate failed");
  assert(serviceFirst.stdout === serviceSecond.stdout, "Active-context verifier is not byte-deterministic");
  const pureContextGates = {
    service: true,
    serviceRuns: 2,
    deterministic: true,
    fiveChapterConsolidation: serviceFirst.report.fiveChaptersConsolidated,
  };
  process.stderr.write(`${JSON.stringify({ gate: "pure-context", ...pureContextGates })}\n`);
  const server = await loadQuorumServer(projectRoot, {
    sessionId: "pi-harness-smoke",
    provider: "smoke",
    model: "smoke-model",
    reasoningLevel: "off",
  });
  client = new StdioMcpClient(server);
  const initialized = await client.start();
  const tools = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  const missing = [...requiredTools].filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Missing required Quorum tools: ${missing.join(", ")}`);
  const memoryContextTool = tools.find((tool) => tool.name === "memory_context");
  for (const field of ["structured", "baseline_query_chars", "token_budget", "domain", "projection_candidates", "model"]) {
    if (!memoryContextTool?.inputSchema?.properties?.[field]) throw new Error(`memory_context schema lacks ${field}`);
  }

  const contextQuery = "set up Pi with governed agents plan mode questions todos and the same Quorum tools as Claude Code";
  const [pageResult, contextResult, structuredContextResult] = await Promise.all([
    client.callTool("wiki_read", { address: "meta/memory/tooling/harness_wiring" }),
    client.callTool("memory_context", { query: contextQuery, max_chars: 30_000 }),
    client.callTool("memory_context", {
      query: contextQuery,
      max_chars: 30_000,
      structured: true,
      baseline_query_chars: 400,
      token_budget: 1500,
      domain: "system",
      projection_candidates: [],
      model: "smoke/smoke-model:off",
    }),
  ]);
  if (pageResult?.isError) throw new Error("wiki_read smoke call failed");
  const pageText = (pageResult.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const page = JSON.parse(pageText);
  if (page.article_id !== "art_d0a6215b40ec35a7") {
    throw new Error(`Unexpected harness-wiring owner: ${page.article_id ?? "missing"}`);
  }

  const contextText = (contextResult.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (!contextText.includes("<project-memory>") || !contextText.includes("harness_wiring")) {
    throw new Error("memory_context did not return the harness-wiring project-memory block");
  }
  const structuredContextText = (structuredContextResult.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const structuredContext = JSON.parse(structuredContextText);
  const influenceManifest = structuredContext.slate?.influenceManifest;
  if (
    structuredContext.slate?.refused !== false ||
    !Array.isArray(influenceManifest) ||
    (influenceManifest.length > 0 && !structuredContext.context.includes("# Selected across memory horizons")) ||
    (influenceManifest.length === 0 && structuredContext.context !== contextText)
  ) {
    throw new Error("Structured memory_context did not return a coherent selected-slate influence manifest");
  }
  validateExposureDescriptor(structuredContext.slate.exposure, "smoke/smoke-model:off");
  const exposureJson = JSON.stringify(structuredContext.slate.exposure);
  if (
    exposureJson.includes("recommendation") ||
    exposureJson.includes(contextQuery) ||
    structuredContext.slate.exposure.actualExposure !== "unified-fixed-slate" ||
    structuredContext.slate.exposure.model !== "smoke/smoke-model:off" ||
    !structuredContext.slate.exposure.visibleSha256
  ) {
    throw new Error("Structured memory_context leaked prompt/recommendation text or mislabeled live exposure");
  }
  for (const item of influenceManifest) {
    if (!structuredContext.context.includes(item.recommendation) ||
        createHash("sha256").update(item.recommendation, "utf8").digest("hex") !== item.recommendationSha256) {
      throw new Error("Structured memory_context influence manifest drifted from exact request-visible text");
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      protocolVersion: initialized.protocolVersion,
      toolCount: tools.length,
      owner: page.address,
      ownerId: page.article_id,
      memoryContextChars: contextText.length,
      packages: packagePolicy.settings.packages,
      planPolicy: packagePolicy.planPath,
      agentContracts,
      pureContextGates,
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
}
