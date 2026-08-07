#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";

const projectRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const sessionDir = `/home/shane/quorum-run/tmp/pi_interactions_verify_${process.pid}`;
function resolvePiBinary() {
  const explicit = process.env.PI_BINARY?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const quorumPi = "/home/shane/.npm-global/bin/pi";
  if (existsSync(quorumPi)) return quorumPi;
  const quorumCli = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
  if (existsSync(quorumCli)) return quorumCli;
  try {
    const discovered = execFileSync("bash", ["-c", "command -v pi"], {
      encoding: "utf8",
      env: process.env,
    }).trim();
    if (discovered) return discovered;
  } catch { /* Fall through to npm's active global prefix. */ }
  const prefix = execFileSync("npm", ["prefix", "--global"], { encoding: "utf8" }).trim();
  const candidate = join(prefix, "bin", "pi");
  assert(existsSync(candidate), `Unable to locate the active Pi executable at ${candidate}`);
  return candidate;
}
const piBinary = resolvePiBinary();
const piRoot = dirname(dirname(realpathSync(piBinary)));
const voiceRoot = "/home/shane/.pi/agent/npm/node_modules/@juicesharp/rpiv-voice";
const modelRoot = "/home/shane/.pi/models/whisper-base";
const quorumIndexSource = readFileSync(join(projectRoot, ".pi", "extensions", "quorum", "index.js"), "utf8");
const activeContextEnabled = /const\s+ACTIVE_CONTEXT_ENABLED\s*=\s*true\s*;/.test(quorumIndexSource);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wavSamples(path) {
  const wav = readFileSync(path);
  assert(wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE", "Voice fixture is not WAV");
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  assert(format?.encoding === 1 && format.bits === 16 && format.channels > 0 && data, "Voice fixture must be PCM16 WAV");
  const frames = Math.floor(data.length / (2 * format.channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    samples[frame] = data.readInt16LE(frame * format.channels * 2) / 32768;
  }
  return { samples, sampleRate: format.sampleRate };
}

const {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} = await import(pathToFileURL(join(piRoot, "dist", "index.js")));

let runtime;
try {
  const piVersion = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  assert(/^\d+\.\d+\.\d+/.test(piVersion), `Invalid Pi package version: ${piVersion}`);
  for (const path of [
    "/home/shane/.pi/agent/pi-plan-mode.json",
    "/home/shane/.pi/agent/extensions/subagent/config.json",
    join(voiceRoot, "package.json"),
    join(modelRoot, ".download-complete"),
  ]) assert(existsSync(path), `Missing interaction prerequisite: ${path}`);

  await mkdir(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(projectRoot, sessionDir);
  runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager: manager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd });
    const created = await createAgentSessionFromServices({ services, sessionManager: manager, sessionStartEvent });
    assert(!created.extensionsResult.errors.length, `Extension load failed: ${JSON.stringify(created.extensionsResult.errors)}`);
    return { ...created, services, diagnostics: services.diagnostics };
  }, {
    cwd: projectRoot,
    agentDir: getAgentDir(),
    sessionManager,
  });
  await runtime.session.bindExtensions({
    mode: "rpc",
    shutdownHandler: async () => {},
    commandContextActions: {
      waitForIdle: async () => {},
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => { await runtime.session.reload(); },
    },
  });
  assert(
    runtime.session.settingsManager.getCompactionSettings().enabled === false,
    "Fresh stock Pi session did not disable automatic native compaction",
  );
  assert(runtime.session.settingsManager.getBranchSummarySkipPrompt() === true,
    "Fresh stock Pi session did not keep summarized tree navigation disabled");

  let runner = runtime.session.extensionRunner;
  const requiredCommands = ["plan", "todos", "voice", "quorum-status", "agents", "reload-runtime"];
  if (activeContextEnabled) requiredCommands.push("quorum-context", "fold-context");
  for (const name of requiredCommands) {
    assert(runner.getCommand(name), `Missing /${name} command`);
  }
  if (!activeContextEnabled) {
    assert(!runner.getCommand("quorum-context") && !runner.getCommand("fold-context"),
      "Incident-disabled active-context commands were registered");
  }
  assert(!runner.getCommand("compact"), "Quorum shadows stock Pi's built-in /compact command");
  assert(typeof runtime.session.compact === "function", "Stock Pi native compaction API is unavailable");
  const defensiveSignal = new AbortController().signal;
  const compactGuard = await runner.emit({
    type: "session_before_compact",
    reason: "manual",
    willRetry: false,
    preparation: {},
    branchEntries: [],
    signal: defensiveSignal,
  });
  assert(compactGuard === undefined, "Extension shadowed explicit user /compact");
  const automaticCompactGuard = await runner.emit({
    type: "session_before_compact",
    reason: "threshold",
    willRetry: false,
    preparation: {},
    branchEntries: [],
    signal: defensiveSignal,
  });
  if (activeContextEnabled) {
    assert(automaticCompactGuard?.cancel === true,
      "Extension did not block an unexpected automatic native compaction callback");
  } else {
    assert(automaticCompactGuard === undefined,
      "Incident-disabled active-context unexpectedly handled automatic compaction");
  }
  const unsummarizedTree = await runner.emit({
    type: "session_before_tree",
    preparation: { userWantsSummary: false },
    signal: defensiveSignal,
  });
  assert(unsummarizedTree === undefined, "Extension blocked stock Pi unsummarized tree navigation");
  const summarizedTree = await runner.emit({
    type: "session_before_tree",
    preparation: { userWantsSummary: true },
    signal: defensiveSignal,
  });
  if (activeContextEnabled) {
    assert(summarizedTree?.cancel === true, "Extension did not cancel a forbidden branch-summary request");
  } else {
    assert(summarizedTree === undefined, "Incident-disabled active-context unexpectedly handled tree navigation");
  }
  const tools = () => new Map(runtime.session.agent.state.tools.map((tool) => [tool.name, tool]));
  assert(tools().has("ask_user_question") && tools().has("todo") && tools().has("Agent"), "Interaction tools are not active in RPC mode");
  assert(tools().has("quorum_context") === activeContextEnabled,
    "quorum_context tool registration disagrees with the incident gate");

  const askResult = await tools().get("ask_user_question").execute(
    "ask-smoke",
    { questions: [{ question: "Choose the harmless verifier outcome?", header: "Outcome", options: [
      { label: "Pass", description: "Accept the smoke path" },
      { label: "Cancel", description: "Exercise cancellation" },
    ] }] },
    new AbortController().signal,
    undefined,
    runner.createContext(),
  );
  assert(askResult.details?.cancelled === true, "RPC ask_user_question did not return a bounded cancellation without a host response");

  const plan = runner.getCommand("plan");
  await plan.handler("", runner.createCommandContext());
  assert(runtime.session.agent.state.tools.some((tool) => tool.name === "plan_mode_complete"), "Plan mode did not activate its completion tool");
  await plan.handler("exit", runner.createCommandContext());
  assert(!runtime.session.agent.state.tools.some((tool) => tool.name === "plan_mode_complete"), "Plan mode did not exit cleanly");

  const todoParams = { action: "create", subject: "Verify reload replay", description: "Ephemeral SDK smoke" };
  const todoResult = await tools().get("todo").execute(
    "todo-replay", todoParams, new AbortController().signal, undefined, runner.createContext(),
  );
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "todo-replay", name: "todo", arguments: todoParams }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "todo-replay",
    toolName: "todo",
    content: todoResult.content,
    details: todoResult.details,
    isError: false,
    timestamp: Date.now(),
  });

  const entriesBeforeReload = sessionManager.getEntries().length;
  await runner.getCommand("reload-runtime").handler("", runner.createCommandContext());
  runner = runtime.session.extensionRunner;
  for (const name of requiredCommands) assert(runner.getCommand(name), `/${name} did not survive reload`);
  assert(sessionManager.getEntries().length >= entriesBeforeReload,
    "Runtime reload unexpectedly removed canonical session evidence");
  assert(
    !sessionManager.getEntries().some((entry) => entry.type === "compaction" || entry.type === "branch_summary"),
    "Interaction smoke invoked native compaction or summarized tree navigation unexpectedly",
  );
  const replayResult = await runtime.session.agent.state.tools.find((tool) => tool.name === "todo").execute(
    "todo-list", { action: "list" }, new AbortController().signal, undefined, runner.createContext(),
  );
  assert(replayResult.details?.tasks?.some((task) => task.subject === "Verify reload replay"), "Todo state did not replay after reload");

  const runnerBeforeToolReload = runner;
  const entriesBeforeToolReload = sessionManager.getEntries().length;
  const reloadTool = tools().get("reload_runtime");
  assert(reloadTool, "LLM-callable reload_runtime tool is unavailable");
  const reloadToolResult = await reloadTool.execute(
    "reload-tool-smoke", {}, new AbortController().signal, undefined, runner.createContext(),
  );
  assert(reloadToolResult.isError !== true, `Tool-origin runtime reload failed: ${JSON.stringify(reloadToolResult)}`);
  assert(reloadToolResult.details?.reloaded === true && reloadToolResult.details?.method === "tool-context",
    `Stock Pi did not use direct tool-context reload: ${JSON.stringify(reloadToolResult.details)}`);
  runner = runtime.session.extensionRunner;
  assert(runner !== runnerBeforeToolReload, "Tool-origin reload did not rebuild the extension runner");
  assert(sessionManager.getEntries().length >= entriesBeforeToolReload,
    "Tool-origin runtime reload removed canonical session evidence");
  assert(!sessionManager.getEntries().some((entry) => entry.type === "compaction" || entry.type === "branch_summary"),
    "Tool-origin reload invoked native compaction or summarized tree navigation");
  for (const name of requiredCommands) assert(runner.getCommand(name), `/${name} did not survive tool-origin reload`);
  const postToolReloadTodo = await runtime.session.agent.state.tools.find((tool) => tool.name === "todo").execute(
    "todo-list-after-tool-reload", { action: "list" }, new AbortController().signal, undefined, runner.createContext(),
  );
  assert(postToolReloadTodo.details?.tasks?.some((task) => task.subject === "Verify reload replay"),
    "Todo state did not replay after tool-origin reload");

  const jiti = createJiti(import.meta.url);
  const { assertModelIntact, getModelPaths } = await jiti.import(join(voiceRoot, "audio", "model-download.ts"));
  const { createSttEngine } = await jiti.import(join(voiceRoot, "audio", "stt-engine.ts"));
  assertModelIntact();
  const engine = await createSttEngine({ ...getModelPaths(), language: "en" });
  const audio = wavSamples(join(modelRoot, "test_wavs", "0.wav"));
  const transcript = await engine.recognize(audio.samples, audio.sampleRate);
  engine.release();
  const normalized = transcript.toUpperCase();
  assert(normalized.includes("EARLY NIGHTFALL") && normalized.includes("YELLOW LAMPS"), `Unexpected local voice transcript: ${transcript}`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    piVersion,
    askUserQuestion: "rpc-cancelled-cleanly",
    planMode: "activated-and-exited",
    todoReloadReplay: true,
    reloadToolMethod: reloadToolResult.details.method,
    activeContextEnabled,
    automaticNativeCompaction: activeContextEnabled ? "disabled-and-guarded" : "disabled-with-handler-offline",
    voiceLocalTranscript: transcript,
    commandsAfterReload: requiredCommands,
  })}\n`);
} finally {
  try {
    if (runtime) await runtime.dispose();
  } finally {
    await rm(sessionDir, { recursive: true, force: true });
  }
}
