#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const jitiPath = join(projectRoot, "node_modules", "jiti", "lib", "jiti.mjs");
if (!existsSync(jitiPath)) throw new Error("Could not resolve package-local jiti for the active-context verifier");
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url);
const context = await jiti.import(join(projectRoot, "extensions", "active-context.ts"));
const json = await jiti.import(join(projectRoot, "extensions", "json.ts"));
const piFold = await jiti.import(join(projectRoot, "extensions", "index.js"));
const summarizerFactory = await jiti.import(join(projectRoot, "extensions", "summarizer.js"));

const LEGACY_REPRODUCTION_FIXTURE = Object.freeze({
  originName: "Quorum",
  registration: Object.freeze({
    toolName: "quorum_context",
    entryTypePrefix: "quorum-active-context",
    commandNames: Object.freeze({ status: "quorum-context", fold: "fold-context" }),
    toolLabel: "Quorum Active Context",
    brandNoun: "Quorum",
  }),
  toolName: "quorum_context",
  commands: Object.freeze(["fold-context", "quorum-context"]),
  statusKey: "quorum-active-context",
  statusText: "quorum_context folds: 0 · provider usage unmeasured",
  entryTypes: Object.freeze([
    "quorum-active-context-fold-record",
    "quorum-active-context-state",
    "quorum-native-compaction-decision",
    "quorum-native-compaction-receipt",
    "quorum-provider-context-measurement",
  ]),
  projectionTypes: Object.freeze([
    "quorum-active-context-advisory",
    "quorum-active-context-milestone",
  ]),
  source: "quorum/active-context",
  placeholderPrefix: "[Quorum active-context fold ",
  milestonePrefix: "[Quorum context milestone ",
  advisoryPrefix: "[Quorum context advisory] ",
  placeholder: (fold) => [
    `[Quorum active-context fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=root; children=0; previous=none; next=none.`,
    `Expand exactly: quorum_context {"action":"expand","id":"${fold.id}"}`,
    "List/page exactly: quorum_context {\"action\":\"status\"}",
  ].join("\n"),
  milestoneText: "[Quorum context milestone tools; session active-context-t] The read-only tool-fold rung begins at 71%. Eligible completed tool batches can be folded now; current endpoint ids are in the live advisory.",
  advisoryText: "[Quorum context advisory] pressure 80%; milestone tools; eligible read-only batch endpoints: none; eligibleChapter endpoints: none; session milestone count: 1.",
  blockedCompaction: "blocked stock automatic compaction; Quorum context folding remains authoritative",
  completedCompaction: "native compaction completed; Quorum folding state rebuilt",
  compactionNotice: "Pi native compaction ran; Quorum folding state was rebuilt.",
  hardFenceNote: "Provider context reached the hard Quorum fence without a newly committed lossless fold. The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.",
  mcpToolName: "mcp__quorum__fetch",
  mcpOwnerKind: "quorum-mcp",
  mcpOwnerId: "quorum:active-context-test",
  evidenceDirectory: "quorum-evidence",
  mcpServer: "quorum",
  mcpFallbackServer: "quorum",
});

const MODEL_BRIEF = async () => ({
  brief: "The exact stale evidence records the completed inspection and its factual result.",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  effort: "medium",
  toolCalls: 0,
  launchContractDigest: "a".repeat(64),
});

function near(actual, expected, tolerance = 1e-9, label = "number") {
  assert(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

function customEntry(customType, data, id, parentId = null) {
  return { type: "custom", id, parentId, customType, data: structuredClone(data) };
}

function makeFixture({
  sessionId = "active-context-test",
  turns = 8,
  tools = true,
  resultChars = 10_000,
  chapterChars = 0,
  mentionToolName = false,
  peekTurns = [],
  peekTargetId = "fold_probe",
  policy = {},
  contextWindow = 272_000,
} = {}) {
  const peekAt = new Set(peekTurns);
  const entries = [];
  const messages = [];
  const turnEntries = [];
  let parentId = null;
  let sequence = 0;
  const add = (message) => {
    const id = `${sessionId}-entry-${String(++sequence).padStart(3, "0")}`;
    entries.push({ type: "message", id, parentId, message });
    messages.push(message);
    parentId = id;
    return id;
  };
  for (let turn = 0; turn < turns; turn += 1) {
    const ids = [];
    const named = mentionToolName ? " Ask active_context for the exact candidate." : "";
    ids.push(add({
      role: "user",
      content: [{
        type: "text",
        text: `Task ${turn}: inspect exact evidence.${named}${" u".repeat(chapterChars)}`,
      }],
      timestamp: sequence,
    }));
    if (tools) {
      const peek = peekAt.has(turn);
      ids.push(add({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: `call-${turn}`,
          name: peek ? "active_context" : "read",
          arguments: peek ? { action: "peek", id: peekTargetId } : { path: `file-${turn}.txt` },
        }],
        stopReason: "toolUse",
        timestamp: sequence,
      }));
      ids.push(add({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: peek ? "active_context" : "read",
        content: [{ type: "text", text: `Result ${turn}: ${"r".repeat(resultChars)}` }],
        isError: false,
        timestamp: sequence,
      }));
    }
    ids.push(add({
      role: "assistant",
      content: [{
        type: "text",
        text: `Completed task ${turn}.${" a".repeat(chapterChars)}`,
      }],
      stopReason: "stop",
      timestamp: sequence,
    }));
    turnEntries.push(ids);
  }
  const snapshot = context.mapActiveContext({
    sessionId,
    eventMessages: messages,
    contextEntries: entries,
    policy,
    contextWindow,
  });
  return { sessionId, entries, messages, snapshot, turnEntries, contextWindow };
}

async function commitCandidate(
  state,
  snapshot,
  candidate,
  { brief, summarize = MODEL_BRIEF, generation = 1, now = 1 } = {},
) {
  assert(candidate, "Expected an eligible fold candidate");
  const prepared = await context.prepareFold({
    candidate, snapshot, state, generation, brief, summarize, now: () => now,
  });
  assert.equal(context.preparedFoldError({ prepared, snapshot, state, generation }), null);
  return {
    prepared,
    state: context.commitPreparedFold({ prepared, snapshot, state, generation }),
  };
}

function makeRuntime(built, {
  toolName,
  toolLabel,
  brandNoun,
  entryTypePrefix,
  commandPrefix,
  commandNames,
  summarizeContextSpan,
  initialEntries,
  readOnlyTools,
  blockingTools,
  isMcpTool,
  evidenceIngestion,
  summarizer,
  guidance,
  surfacing,
  foldScheduling,
  setSuggestionSourceRegistrar,
  loadHostModule,
  packageRegistration = false,
  sessionFile = join(tmpdir(), "pi-fold-test-session.jsonl"),
} = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const appended = [];
  const notifications = [];
  const statuses = [];
  const branch = structuredClone(initialEntries ?? built.entries);
  const messages = structuredClone(built.messages);
  let usage = { tokens: 0, contextWindow: built.contextWindow ?? 272_000 };
  let sequence = 0;
  let aborts = 0;
  const appendBranch = (entry) => {
    const value = structuredClone(entry);
    value.parentId ??= branch.at(-1)?.id ?? null;
    branch.push(value);
    return value;
  };
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    async appendEntry(customType, data) {
      const entry = customEntry(
        customType,
        data,
        `runtime-custom-${String(++sequence).padStart(4, "0")}`,
        branch.at(-1)?.id ?? null,
      );
      appended.push(entry);
      branch.push(entry);
    },
  };
  const runtime = {
    built, handlers, tools, commands, appended, notifications, statuses, branch, messages,
    get usage() { return usage; },
    set usage(value) { usage = value; },
    get aborts() { return aborts; },
    appendMessage(message, label = "provider") {
      const entry = {
        type: "message",
        id: `${label}-${String(++sequence).padStart(4, "0")}`,
        parentId: branch.at(-1)?.id ?? null,
        message: structuredClone(message),
      };
      appendBranch(entry);
      messages.push(structuredClone(message));
      return entry.message;
    },
  };
  runtime.ctx = {
    model: { provider: "openai-codex", id: "gpt-test" },
    thinkingLevel: "max",
    getContextUsage: () => structuredClone(usage),
    abort() { aborts += 1; },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(key, text) { statuses.push({ key, text }); },
    },
    sessionManager: {
      getSessionId: () => built.sessionId,
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      buildContextEntries: () => branch,
      buildSessionContext: () => ({ messages }),
    },
  };
  const registrationOptions = {
    ...(toolName ? { toolName } : {}),
    ...(toolLabel ? { toolLabel } : {}),
    ...(brandNoun ? { brandNoun } : {}),
    ...(entryTypePrefix ? { entryTypePrefix } : {}),
    ...(commandPrefix ? { commandPrefix } : {}),
    ...(commandNames ? { commandNames } : {}),
    ...(summarizeContextSpan ? { summarizeContextSpan } : {}),
    ...(readOnlyTools ? { readOnlyTools } : {}),
    ...(blockingTools ? { blockingTools } : {}),
    ...(isMcpTool ? { isMcpTool } : {}),
    ...(evidenceIngestion === undefined ? {} : { evidenceIngestion }),
    ...(summarizer === undefined ? {} : { summarizer }),
    ...(guidance === undefined ? {} : { guidance }),
    ...(surfacing === undefined ? {} : { surfacing }),
    ...(foldScheduling === undefined ? {} : { foldScheduling }),
    ...(setSuggestionSourceRegistrar ? { setSuggestionSourceRegistrar } : {}),
  };
  runtime.registration = packageRegistration
    ? piFold.registerPiFold(pi, registrationOptions, loadHostModule)
    : context.registerActiveContext(pi, registrationOptions);
  return runtime;
}

async function settle(cycles = 4) {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function startRuntime(runtime) {
  await runtime.handlers.get("session_start")({}, runtime.ctx);
  return runtime.handlers.get("context")({ messages: runtime.messages }, runtime.ctx);
}

function measuredAssistant(tokens, contextWindow, suffix = "measurement") {
  return {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: suffix }],
    provider: "openai-codex",
    model: "gpt-test",
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
    timestamp: tokens,
    contextWindow,
  };
}

async function measure(runtime, tokens, contextWindow = runtime.usage.contextWindow, suffix) {
  runtime.usage = { tokens, contextWindow };
  const message = runtime.appendMessage(
    measuredAssistant(tokens, contextWindow, suffix ?? `measurement-${tokens}-${runtime.branch.length}`),
    "provider-measurement",
  );
  await runtime.handlers.get("message_end")({ message }, runtime.ctx);
  await settle();
  return message;
}

async function project(runtime) {
  return runtime.handlers.get("context")({ messages: runtime.messages }, runtime.ctx);
}

async function toolStatus(runtime, toolName = "active_context", detail) {
  return runtime.tools.get(toolName).execute(
    "status-call",
    { action: "status", ...(detail ? { detail } : {}) },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
}

function materialized(runtime, sessionId = runtime.built.sessionId) {
  return context.materializeActiveContextState(runtime.branch, sessionId);
}

function stateEntry(sessionId, state, id = "seed-state", parentId = null) {
  return customEntry(context.ACTIVE_CONTEXT_STATE_ENTRY, state, id, parentId);
}

async function chapterForest(count) {
  const built = makeFixture({
    turns: Math.max(9, count + 4),
    tools: false,
    chapterChars: 3_500,
    policy: { freshTurns: 1, freshBytes: 0, minChapterChars: 1 },
    contextWindow: 100_000,
  });
  let state = context.emptyActiveContextState(built.sessionId);
  for (let turn = 0; turn < count; turn += 1) {
    const candidate = context.manualFoldCandidate(
      built.snapshot,
      state,
      [built.turnEntries[turn][0], built.turnEntries[turn].at(-1)],
    );
    state = (await commitCandidate(state, built.snapshot, candidate, {
      brief: `Complete chapter ${turn} remains independently pageable and exactly recoverable.`,
      now: turn + 1,
    })).state;
  }
  return { ...built, state };
}

async function collectRegistrationSurface(registration, mcpToolName) {
  const scratch = await mkdtemp(join(tmpdir(), "pi-fold-branding-"));
  try {
    const runtimeOptions = {
      ...registration,
      packageRegistration: true,
      sessionFile: join(scratch, "session.jsonl"),
      isMcpTool: (name) => name === mcpToolName || name === "opaque_mcp_tool",
    };
    const runtime = makeRuntime(
      makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
      runtimeOptions,
    );
    const tool = [...runtime.tools.values()][0];
    await startRuntime(runtime);
    const initialStatus = structuredClone(runtime.statuses.at(-1));
    await measure(runtime, 80_000, 100_000);
    const foldedProjection = await project(runtime);
    const foldedRecord = runtime.appended.find((entry) => entry.customType.endsWith("-fold-record"));
    assert(foldedRecord?.data?.fold, `Branding fixture produced no fold: ${json.stableStringify({
      toolName: tool.name, appendedTypes: runtime.appended.map((entry) => entry.customType),
    })}`);
    const placeholderTexts = foldedProjection.messages.flatMap((message) => {
      const content = message?.content;
      if (typeof content === "string" && content.includes("Topology: kind=")) return [content];
      if (!Array.isArray(content)) return [];
      return content.flatMap((part) =>
        typeof part?.text === "string" && part.text.includes("Topology: kind=") ? [part.text] : []);
    });
    const advisoryRuntime = makeRuntime(
      makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      runtimeOptions,
    );
    await startRuntime(advisoryRuntime);
    await measure(advisoryRuntime, 80_000, 100_000);
    const advisoryProjection = await project(advisoryRuntime);
    const advisoryMessages = advisoryProjection.messages.filter((message) =>
      typeof message?.customType === "string" &&
      (message.customType.endsWith("-milestone") || message.customType.endsWith("-advisory")));

    await runtime.handlers.get("session_before_compact")({ reason: "threshold" }, runtime.ctx);
    const blockedStatus = await toolStatus(runtime, tool.name);

    const compactionEntry = {
      type: "compaction",
      id: "branding-native-compaction",
      parentId: runtime.branch.at(-1)?.id ?? null,
      timestamp: new Date(0).toISOString(),
    };
    runtime.branch.push(compactionEntry);
    await runtime.handlers.get("session_compact")({
      reason: "manual",
      willRetry: false,
      fromExtension: false,
      compactionEntry,
    }, runtime.ctx);
    await project(runtime);
    const completedStatus = await toolStatus(runtime, tool.name);

    const evidenceProjection = await runtime.handlers.get("tool_result")({
      toolName: mcpToolName,
      toolCallId: "branding-mcp-call",
      isError: false,
      content: [{ type: "text", text: "m".repeat(20_000) }],
      details: { structuredContent: { payload: "p".repeat(20_000) } },
    }, runtime.ctx);
    const fallbackEvidenceProjection = await runtime.handlers.get("tool_result")({
      toolName: "opaque_mcp_tool",
      toolCallId: "branding-mcp-fallback-call",
      isError: false,
      content: [{ type: "text", text: "f".repeat(20_000) }],
      details: { structuredContent: { payload: "b".repeat(20_000) } },
    }, runtime.ctx);

    const fenceRuntime = makeRuntime(
      makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      runtimeOptions,
    );
    await startRuntime(fenceRuntime);
    await measure(fenceRuntime, 95_000, 100_000);
    await project(fenceRuntime);
    const fenceStatus = await toolStatus(fenceRuntime, [...fenceRuntime.tools.keys()][0]);

    return {
      toolName: tool.name,
      toolLabel: tool.label,
      commands: [...runtime.commands.keys()].sort(),
      initialStatus,
      entryTypes: [...new Set(runtime.appended.map((entry) => entry.customType))].sort(),
      fold: {
        id: foldedRecord.data.fold.id,
        brief: foldedRecord.data.fold.brief,
        kind: foldedRecord.data.fold.kind,
      },
      placeholderTexts,
      projectionTypes: advisoryMessages.map((message) => message.customType).sort(),
      advisoryTexts: advisoryMessages.map((message) => message.content),
      projectionSources: advisoryMessages.map((message) => message.details?.source),
      blockedCompaction: blockedStatus.details.automatic.lastCompactionDecision?.reason,
      completedCompaction: completedStatus.details.automatic.lastCompactionDecision?.reason,
      compactionNotices: runtime.notifications.map((notice) => notice.message),
      hardFenceNote: fenceStatus.details.automatic.pendingContextNote,
      evidence: {
        ownerKind: evidenceProjection.details.evidence.owner.kind,
        ownerId: evidenceProjection.details.evidence.owner.id,
        path: evidenceProjection.details.evidence.path,
        mcpServer: evidenceProjection.details.mcpServer,
        fallbackMcpServer: fallbackEvidenceProjection.details.mcpServer,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gateRegistration() {
  const defaults = makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }));
  assert.deepEqual([...context.READ_ONLY_TOOLS_DEFAULT], ["read", "grep", "find", "ls"]);
  assert.deepEqual([...defaults.tools.keys()], ["active_context"]);
  assert.deepEqual([...defaults.commands.keys()].sort(), ["context", "fold-context"]);
  await startRuntime(defaults);

  const custom = makeRuntime(makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }), {
    toolName: "ctx_tool",
    entryTypePrefix: "custom-context",
    commandPrefix: "sandbox",
  });
  assert.deepEqual([...custom.tools.keys()], ["ctx_tool"]);
  assert.deepEqual([...custom.commands.keys()].sort(), ["sandbox-context", "sandbox-fold-context"]);
  await startRuntime(custom);
  await measure(custom, 80_000, 100_000);
  const types = custom.appended.map((entry) => entry.customType);
  assert(types.includes("custom-context-provider-context-measurement"));
  assert(types.includes("custom-context-fold-record"));
  assert(types.includes("custom-context-state"));
  assert(types.every((type) => type.startsWith("custom-context-")));

  const named = makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }), {
    commandNames: { status: "context", fold: "fold-context" },
  });
  assert.deepEqual([...named.commands.keys()].sort(), ["context", "fold-context"]);
  assert.throws(() => makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }), {
    commandNames: { status: "same", fold: "same" },
  }).tools, /distinct kebab-case/i);
  return {
    defaultTool: "active_context",
    defaultReadOnlyTools: [...context.READ_ONLY_TOOLS_DEFAULT],
    defaultCommands: [...defaults.commands.keys()].sort(),
    commands: [...custom.commands.keys()].sort(),
    namedCommands: [...named.commands.keys()].sort(),
    customTypes: types,
  };
}

async function gateNeutralDefaultBranding() {
  const surface = await collectRegistrationSurface({}, "mcp__docs__fetch");
  assert.equal(surface.toolName, "active_context");
  assert.equal(surface.toolLabel, "Active Context");
  assert.deepEqual(surface.commands, ["context", "fold-context"]);
  assert.deepEqual(surface.initialStatus, {
    key: "pi-fold-active-context",
    text: "active_context folds: 0 · provider usage unmeasured",
  });
  assert.deepEqual(surface.entryTypes, [
    "pi-fold-active-context-fold-record",
    "pi-fold-active-context-state",
    "pi-fold-native-compaction-decision",
    "pi-fold-native-compaction-receipt",
    "pi-fold-provider-context-measurement",
  ]);
  assert(surface.placeholderTexts.some((text) => text.startsWith("[active-context fold ")));
  assert.deepEqual(surface.projectionTypes, [
    "pi-fold-active-context-advisory",
    "pi-fold-active-context-milestone",
  ]);
  assert(surface.advisoryTexts.some((text) => text.startsWith("[active-context milestone ")));
  assert(surface.advisoryTexts.some((text) => text.startsWith("[active-context advisory] ")));
  assert.deepEqual(surface.projectionSources, ["pi-fold/active-context", "pi-fold/active-context"]);
  assert.equal(
    surface.blockedCompaction,
    "blocked stock automatic compaction; active-context folding remains authoritative",
  );
  assert.equal(
    surface.completedCompaction,
    "native compaction completed; active-context folding state rebuilt",
  );
  assert(surface.compactionNotices.includes(
    "Pi native compaction ran; active-context folding state was rebuilt.",
  ));
  assert.equal(
    surface.hardFenceNote,
    "Provider context reached the hard active-context fence without a newly committed lossless fold. " +
      "The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.",
  );
  assert.equal(surface.evidence.ownerKind, "pi-fold-mcp");
  assert.equal(surface.evidence.ownerId, "pi-fold:active-context-test");
  assert(surface.evidence.path.includes("/pi-fold-evidence/"));
  assert.equal(surface.evidence.mcpServer, "docs");
  assert.equal(surface.evidence.fallbackMcpServer, "pi-fold");
  assert.equal(new RegExp(LEGACY_REPRODUCTION_FIXTURE.originName, "i").test(json.stableStringify(surface)), false);
  return {
    tool: surface.toolName,
    label: surface.toolLabel,
    commands: surface.commands,
    entryTypes: surface.entryTypes,
    evidenceOwner: surface.evidence.ownerKind,
    mcpServer: surface.evidence.mcpServer,
    originOccurrences: 0,
  };
}

async function gateLegacyBrandingReproduction() {
  const fixture = LEGACY_REPRODUCTION_FIXTURE;
  const surface = await collectRegistrationSurface(fixture.registration, fixture.mcpToolName);
  assert.equal(surface.toolName, fixture.toolName);
  assert.equal(surface.toolLabel, fixture.registration.toolLabel);
  assert.deepEqual(surface.commands, fixture.commands);
  assert.deepEqual(surface.initialStatus, { key: fixture.statusKey, text: fixture.statusText });
  assert.deepEqual(surface.entryTypes, fixture.entryTypes);
  assert(surface.placeholderTexts.some((text) => text.startsWith(fixture.placeholderPrefix)));
  assert(surface.placeholderTexts.includes(fixture.placeholder(surface.fold)));
  assert.deepEqual(surface.projectionTypes, fixture.projectionTypes);
  assert(surface.advisoryTexts.some((text) => text.startsWith(fixture.milestonePrefix)));
  assert(surface.advisoryTexts.some((text) => text.startsWith(fixture.advisoryPrefix)));
  assert.deepEqual(surface.advisoryTexts, [fixture.milestoneText, fixture.advisoryText]);
  assert.deepEqual(surface.projectionSources, [fixture.source, fixture.source]);
  assert.equal(surface.blockedCompaction, fixture.blockedCompaction);
  assert.equal(surface.completedCompaction, fixture.completedCompaction);
  assert(surface.compactionNotices.includes(fixture.compactionNotice));
  assert.equal(surface.hardFenceNote, fixture.hardFenceNote);
  assert.equal(surface.evidence.ownerKind, fixture.mcpOwnerKind);
  assert.equal(surface.evidence.ownerId, fixture.mcpOwnerId);
  assert(surface.evidence.path.includes(`/${fixture.evidenceDirectory}/`));
  assert.equal(surface.evidence.mcpServer, fixture.mcpServer);
  assert.equal(surface.evidence.fallbackMcpServer, fixture.mcpFallbackServer);
  return {
    tool: surface.toolName,
    label: surface.toolLabel,
    commands: surface.commands,
    entryTypes: surface.entryTypes,
    exactCompactionNotices: 3,
    evidenceOwner: surface.evidence.ownerKind,
    evidenceDirectory: fixture.evidenceDirectory,
    mcpServer: surface.evidence.mcpServer,
  };
}

async function gateFoldLattice() {
  const validBatchMessages = [
    { role: "user", content: [{ type: "text", text: "Inspect both sources." }] },
    { role: "assistant", content: [
      { type: "toolCall", id: "batch-read", name: "read", arguments: {} },
      { type: "toolCall", id: "batch-grep", name: "grep", arguments: {} },
    ], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "batch-read", toolName: "read", isError: false,
      content: [{ type: "text", text: "parallel read ".repeat(300) }] },
    { role: "toolResult", toolCallId: "batch-grep", toolName: "grep", isError: false,
      content: [{ type: "text", text: "parallel grep ".repeat(300) }] },
    { role: "assistant", content: [{ type: "text", text: "Inspection complete." }], stopReason: "stop" },
    { role: "user", content: [{ type: "text", text: "Fresh work." }] },
    { role: "assistant", content: [{ type: "text", text: "Fresh work complete." }], stopReason: "stop" },
  ];
  const entries = validBatchMessages.map((message, index) => ({
    type: "message",
    id: `batch-${String(index + 1).padStart(3, "0")}`,
    parentId: index ? `batch-${String(index).padStart(3, "0")}` : null,
    message,
  }));
  const snapshot = context.mapActiveContext({
    sessionId: "batch-session",
    eventMessages: validBatchMessages,
    contextEntries: entries,
    policy: { freshTurns: 1, freshBytes: 0, minToolChars: 100 },
  });
  assert.equal(context.validateTurnToolBatch(validBatchMessages, { start: 0, end: 5 }).calls.length, 2);
  const missingResult = structuredClone(validBatchMessages);
  missingResult.splice(2, 1);
  assert.equal(context.validateTurnToolBatch(missingResult, { start: 0, end: 4 }), null);
  const mutating = structuredClone(validBatchMessages);
  mutating[1].content[0].name = "write";
  mutating[2].toolName = "write";
  assert.equal(context.validateTurnToolBatch(mutating, { start: 0, end: 5 }), null);

  const empty = context.emptyActiveContextState("batch-session");
  const [candidate] = context.selectAutomaticToolBatch(snapshot, empty, 0.80);
  assert.equal(candidate.sourceRefs.length, 2);
  const committed = await commitCandidate(empty, snapshot, candidate, {
    brief: context.automaticToolBrief(snapshot, candidate),
  });
  const validated = context.validateFoldForest(committed.state.folds);
  assert.equal(validated.length, 1);
  assert.throws(() => context.validateFoldForest([validated[0], structuredClone(validated[0])]),
    /Invalid active-context fold/);
  const digestDrift = structuredClone(validated);
  digestDrift[0].sourceSha256 = "0".repeat(64);
  assert.throws(() => context.validateFoldForest(digestDrift), /source digest drift/);
  const parentDrift = structuredClone(validated);
  parentDrift[0].parentId = "missing-parent";
  assert.throws(() => context.validateFoldForest(parentDrift), /parent drift/);
  const structurallyValidHistoricalBrief = structuredClone(validated);
  structurallyValidHistoricalBrief[0].brief = "active_context";
  assert.equal(context.validateFoldForest(structurallyValidHistoricalBrief).length, 1);
  await assert.rejects(() => context.prepareFold({
    candidate,
    snapshot,
    state: empty,
    generation: 1,
    brief: "active_context",
  }), /Supplied brief must be non-structural/);

  const recovered = context.recoverFoldMessages({
    foldId: committed.prepared.id,
    state: committed.state,
    entries,
    sessionId: "batch-session",
  });
  const expected = candidate.sourceRefs.map((ref) => entries.find((entry) => entry.id === ref.entryId).message);
  assert.equal(json.stableStringify(recovered), json.stableStringify(expected));
  assert.equal(json.sha256Value(recovered), json.sha256Value(expected));

  const projection = context.projectActiveContext(snapshot, committed.state);
  const placeholders = projection.filter((message) =>
    message.role === "toolResult" && JSON.stringify(message).includes(committed.prepared.id));
  assert.deepEqual(placeholders.map((message) => message.toolCallId), ["batch-read", "batch-grep"]);
  return {
    forest: "validated",
    historicalShapeBrief: "structural-only",
    creationBrief: "tool-aware",
    recoveredSha256: json.sha256Value(recovered),
    atomicToolResults: placeholders.map((message) => message.toolCallId),
  };
}

async function gateAutonomousLadder() {
  const toolBuilt = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const noAdvisory = context.emptyActiveContextState(toolBuilt.sessionId);
  delete noAdvisory.advisory;
  assert.equal(context.selectAutomaticCandidate(toolBuilt.snapshot, noAdvisory, 0.80).kind, "tool-result");

  const toolRuntime = makeRuntime(toolBuilt);
  await startRuntime(toolRuntime);
  await measure(toolRuntime, 50_000, 100_000);
  const milestoneState = materialized(toolRuntime);
  assert.equal(milestoneState.folds.length, 0);
  assert.equal(milestoneState.advisory.highWater, 0.50);
  const measurement = await measure(toolRuntime, 80_000, 100_000);
  const toolState = materialized(toolRuntime);
  assert.equal(toolState.folds.length, 1, "One pass performed more than one structural action");
  assert.equal(toolState.folds[0].kind, "tool-result");
  const toolRuntimeStatus = await toolStatus(toolRuntime);
  assert.equal(toolRuntimeStatus.details.automatic.lastAutomaticAction.kind, "tool-fold");
  const structuralBefore = toolRuntime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  await toolRuntime.handlers.get("message_end")({ message: measurement }, toolRuntime.ctx);
  await settle();
  const structuralAfter = toolRuntime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  assert.equal(structuralAfter, structuralBefore, "Stale projection measurement authorized work");

  const refoldBuilt = makeFixture({ turns: 4, resultChars: 10_000, contextWindow: 100_000 });
  const refoldEmpty = context.emptyActiveContextState(refoldBuilt.sessionId);
  const refoldCandidate = context.selectAutomaticCandidate(refoldBuilt.snapshot, refoldEmpty, 0.80);
  const refoldCommitted = await commitCandidate(refoldEmpty, refoldBuilt.snapshot, refoldCandidate, {
    brief: "The completed read remains exact and is temporarily expanded for inspection.",
  });
  const expanded = context.setFoldProjectionState(
    refoldCommitted.state, refoldCommitted.prepared.id, "expanded",
  );
  const refoldBranch = [...refoldBuilt.entries, stateEntry(
    refoldBuilt.sessionId, expanded, "expanded-state", refoldBuilt.entries.at(-1).id,
  )];
  const refoldRuntime = makeRuntime(refoldBuilt, { initialEntries: refoldBranch });
  await startRuntime(refoldRuntime);
  await measure(refoldRuntime, 85_000, 100_000);
  const refoldState = materialized(refoldRuntime);
  assert.deepEqual(refoldState.expanded, []);
  assert.equal((await toolStatus(refoldRuntime)).details.automatic.lastAutomaticAction.kind, "refold");

  // Six adjacent stale roots exercise the bounded consolidation path.
  const forest = await chapterForest(6);
  const runtimeForestSnapshot = context.mapActiveContext({
    sessionId: forest.sessionId,
    eventMessages: forest.messages,
    contextEntries: forest.entries,
    contextWindow: 100_000,
  });
  const runtimeForestStatus = context.activeContextStatus(runtimeForestSnapshot, forest.state);
  assert.equal(
    context.selectAutomaticCandidate(runtimeForestSnapshot, forest.state, 0.85)?.kind,
    "consolidation",
    `Default-policy forest did not expose consolidation: ${JSON.stringify(runtimeForestStatus.folds)}`,
  );
  const consolidationBranch = [...forest.entries, stateEntry(
    forest.sessionId, forest.state, "forest-state", forest.entries.at(-1).id,
  )];
  const consolidationRuntime = makeRuntime(forest, { initialEntries: consolidationBranch });
  await startRuntime(consolidationRuntime);
  await measure(consolidationRuntime, 85_000, 100_000);
  const consolidationState = materialized(consolidationRuntime);
  const consolidationStatus = await toolStatus(consolidationRuntime);
  assert.equal(
    consolidationState.folds.filter((fold) => fold.parentId === null).length,
    1,
    JSON.stringify(consolidationStatus.details.automatic),
  );
  assert.equal(consolidationState.folds.find((fold) => fold.kind === "consolidation").parts.length, 6);
  assert.equal(consolidationStatus.details.automatic.lastAutomaticAction.kind, "consolidation");

  const chapterBuilt = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: 272_000,
  });
  const chapterRuntime = makeRuntime(chapterBuilt);
  await startRuntime(chapterRuntime);
  await measure(chapterRuntime, 244_800, 272_000);
  await settle();
  const preparedStatus = await toolStatus(chapterRuntime);
  assert.equal(preparedStatus.details.automatic.pressureRatio, 0.90);
  assert.equal(typeof preparedStatus.details.automatic.preparedFoldId, "string");
  assert.equal(preparedStatus.details.automatic.lastAutomaticAction, null);
  const fenceTokens = 272_000 - context.ACTIVE_CONTEXT_POLICY.responseReserve;
  await measure(chapterRuntime, fenceTokens, 272_000);
  const chapterStatus = await toolStatus(chapterRuntime);
  assert.equal(chapterStatus.details.automatic.lastAutomaticAction.kind, "chapter-fold");
  const durableChapter = chapterRuntime.appended.find((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY && entry.data.fold.kind === "chapter");
  assert(durableChapter, "Prepared chapter did not persist its immutable fold record at the fence");
  assert.equal(chapterStatus.details.automatic.automaticSuspended, false);
  return {
    toolAt: 0.80,
    monotonicTokens: [50_000, 80_000],
    milestonePersistedBeforeFold: milestoneState.advisory.highWater,
    oneActionFolds: toolState.folds.length,
    staleMeasurement: "no-op",
    refoldAt: 0.85,
    consolidationAt: 0.85,
    preparedAt: 0.90,
    committedAtFence: fenceTokens / 272_000,
  };
}

function guidanceSchedule(contextWindow, guidance) {
  return context.advisorySchedule({
    policy: context.ACTIVE_CONTEXT_POLICY,
    contextWindow,
  }, guidance);
}

function scheduleMap(contextWindow, guidance) {
  return Object.fromEntries(guidanceSchedule(contextWindow, guidance).rungs
    .map((rung) => [rung.milestone, rung]));
}

async function gateAdvisoryMilestones() {
  const wide = scheduleMap(272_000);
  near(wide.notice.threshold, 0.50);
  near(wide.tools.threshold, 0.71);
  near(wide.chapters.threshold, 0.85);
  near(Number(wide.urgent.threshold.toFixed(4)), 0.9098, 1e-9, "rounded urgent threshold");
  assert.deepEqual(
    [wide.notice.budget, wide.tools.budget, wide.chapters.budget, wide.urgent.budget],
    [2, 2, 2, 3],
  );
  const narrow = scheduleMap(100_000);
  near(narrow.tools.threshold, 0.71);
  near(narrow.chapters.threshold, 0.85);

  const noFold = makeFixture({ turns: 3, tools: false, contextWindow: 272_000 });
  const jump = makeRuntime(noFold);
  await startRuntime(jump);
  await measure(jump, 108_800, 272_000);
  await project(jump);
  await measure(jump, 233_920, 272_000);
  const firstProjection = await project(jump);
  const projected = firstProjection.messages.filter((message) =>
    ["pi-fold-active-context-milestone", "pi-fold-active-context-advisory"].includes(message.customType));
  assert.equal(projected.length, 2);
  assert(projected.every((message) => message.role === "custom" && message.details?.ephemeral === true));
  assert.equal(projected[0].timestamp, 0);
  assert(Buffer.byteLength(projected[1].content, "utf8") <= 2_048);
  const repeatedProjection = await project(jump);
  const repeatedMilestone = repeatedProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-milestone");
  assert.equal(json.stableStringify(repeatedMilestone), json.stableStringify(projected[0]));
  let jumpStatus = await toolStatus(jump);
  assert.deepEqual(jumpStatus.details.automatic.advisory.delivered, { chapters: 1 });
  assert.equal(jumpStatus.details.automatic.advisory.armed.milestone, "chapters");
  near(jumpStatus.details.automatic.advisory.armed.threshold, wide.chapters.threshold);
  assert.match(jumpStatus.details.automatic.advisory.armed.scheduleKey, /^[a-f0-9]{64}$/);
  jump.usage = { tokens: 233_920, contextWindow: 100_000 };
  const changedWindowProjection = await project(jump);
  const changedWindowMilestone = changedWindowProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-milestone");
  assert.equal(json.stableStringify(changedWindowMilestone), json.stableStringify(projected[0]),
    "An armed milestone hook changed bytes when the reported window changed");

  await measure(jump, 196_520, 272_000);
  await project(jump);
  await measure(jump, 233_920, 272_000);
  jumpStatus = await toolStatus(jump);
  assert.equal(jumpStatus.details.automatic.advisory.delivered.chapters, 1,
    "A rung re-armed at exactly 0.85×threshold");
  await project(jump);
  await measure(jump, 196_519, 272_000);
  await project(jump);
  await measure(jump, 233_920, 272_000);
  jumpStatus = await toolStatus(jump);
  assert.equal(jumpStatus.details.automatic.advisory.delivered.chapters, 2);

  const durableProjectionEntries = jump.appended.filter((entry) =>
    /(?:advisory|guidance|milestone)/.test(entry.customType));
  assert.equal(durableProjectionEntries.length, 0);
  const reloaded = makeRuntime(
    { ...noFold, messages: jump.messages },
    { initialEntries: jump.branch },
  );
  await startRuntime(reloaded);
  const reloadProjection = await project(reloaded);
  const reloadedMilestone = reloadProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-milestone");
  assert.equal(reloadedMilestone.content, projected[0].content);
  assert.equal((await toolStatus(reloaded)).details.automatic.advisory.delivered.chapters, 2);

  const historicalBudgets = Object.fromEntries(Object.entries(context.ADVISORY_BUDGETS)
    .map(([milestone, budget]) => [milestone, budget + 1]));
  const historicalBudgetState = context.emptyActiveContextState("historical-budget");
  historicalBudgetState.advisory = { highWater: 1, delivered: historicalBudgets };
  assert.deepEqual(
    context.parseActiveContextState(historicalBudgetState, "historical-budget").advisory.delivered,
    historicalBudgets,
  );

  const budgetRuntime = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 272_000 }));
  await startRuntime(budgetRuntime);
  const cycle = async (target, drop, count) => {
    for (let index = 0; index < count; index += 1) {
      await measure(budgetRuntime, Math.round(target * 272_000), 272_000, `target-${target}-${index}`);
      await project(budgetRuntime);
      await measure(budgetRuntime, Math.round(drop * 272_000), 272_000, `drop-${drop}-${index}`);
      await project(budgetRuntime);
    }
    await measure(budgetRuntime, Math.round(target * 272_000), 272_000, `exhausted-${target}`);
    await project(budgetRuntime);
  };
  await measure(budgetRuntime, 108_800, 272_000);
  await project(budgetRuntime);
  await cycle(0.51, 0.40, 2);
  await cycle(0.72, 0.59, 2);
  await cycle(0.86, 0.70, 2);
  await cycle(0.92, 0.76, 3);
  const delivered = (await toolStatus(budgetRuntime)).details.automatic.advisory.delivered;
  assert.deepEqual(delivered, { notice: 2, tools: 2, chapters: 2, urgent: 3 });
  assert.equal(budgetRuntime.appended.filter((entry) =>
    /(?:advisory|guidance|milestone)/.test(entry.customType)).length, 0);
  return {
    wide: {
      notice: wide.notice.threshold,
      tools: wide.tools.threshold,
      chapters: wide.chapters.threshold,
      urgent: Number(wide.urgent.threshold.toFixed(4)),
    },
    narrow: { tools: narrow.tools.threshold, chapters: narrow.chapters.threshold },
    budgets: delivered,
    projectionTypes: projected.map((message) => message.customType),
    milestoneTimestamp: projected[0].timestamp,
    armedTextWindowChange: "byte-stable",
    historicalBudgetCheckpoint: historicalBudgets,
    advisoryBytes: Buffer.byteLength(projected[1].content, "utf8"),
    reloadReplay: 1,
    durableProjectionEntries: 0,
  };
}

async function gateOverflowRegression() {
  const runtime = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }));
  await startRuntime(runtime);
  await measure(runtime, 110_000, 100_000);
  await project(runtime);
  await project(runtime);
  let status = await toolStatus(runtime);
  assert.equal(status.details.automatic.advisory.highWater, 1);
  assert.equal(status.details.automatic.automaticSuspended, false);
  assert(runtime.aborts >= 1, "Overflow did not reach the hard-fence abort");
  await measure(runtime, 60_000, 100_000);
  status = await toolStatus(runtime);
  assert.equal(status.details.automatic.pressureRatio, 0.60);
  assert.equal(status.details.automatic.providerMeasurement.tokens, 60_000);
  assert.equal(status.details.automatic.automaticSuspended, false);
  return {
    overflowRatio: 1.1,
    highWater: 1,
    hardFenceAborts: runtime.aborts,
    nextRatio: status.details.automatic.pressureRatio,
    suspended: false,
  };
}

async function gateLegacyLunaRegression() {
  const built = makeFixture({ turns: 6, resultChars: 10_000, contextWindow: 100_000 });
  const empty = context.emptyActiveContextState(built.sessionId);
  const candidate = context.selectAutomaticCandidate(built.snapshot, empty, 0.80);
  const committed = await commitCandidate(empty, built.snapshot, candidate);
  const legacyFold = structuredClone(committed.prepared.fold);
  legacyFold.provenance = {
    kind: "luna",
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    launchContractDigest: "a".repeat(64),
  };
  context.validateFoldForest([legacyFold]);
  const legacyState = {
    ...committed.state,
    folds: [legacyFold],
    advisory: { highWater: 0, delivered: {} },
  };
  const record = {
    version: 1,
    sessionId: built.sessionId,
    foldId: legacyFold.id,
    recordSha256: json.sha256Value(legacyFold),
    fold: legacyFold,
  };
  const checkpoint = {
    version: 2,
    kind: "checkpoint",
    sessionId: built.sessionId,
    revision: legacyState.revision,
    foldRefs: [{ id: legacyFold.id, sha256: record.recordSha256 }],
    expanded: [],
    protected: [],
    prepared: null,
    advisory: structuredClone(legacyState.advisory),
    stateSha256: json.sha256Value(legacyState),
  };
  const recordEntry = customEntry(
    context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY,
    record,
    "legacy-luna-record",
    built.entries.at(-1).id,
  );
  const checkpointEntry = customEntry(
    context.ACTIVE_CONTEXT_STATE_ENTRY,
    checkpoint,
    "legacy-luna-state",
    recordEntry.id,
  );
  const originalRecordBytes = json.stableStringify(recordEntry.data);
  const runtime = makeRuntime(built, {
    initialEntries: [...built.entries, recordEntry, checkpointEntry],
    summarizeContextSpan: MODEL_BRIEF,
  });
  await startRuntime(runtime);
  const loaded = materialized(runtime);
  assert.equal(loaded.folds[0].provenance.kind, "luna");
  const slate = context.projectionSlateCandidates(loaded, built.snapshot);
  assert.equal(slate.find((item) => item.source_id === legacyFold.id).generator, "projection-model");
  const next = context.selectAutomaticToolBatch(built.snapshot, loaded, 1)[0];
  assert(next, "Legacy fixture lacked a second tool fold for round-trip persistence");
  const response = await runtime.tools.get("active_context").execute(
    "legacy-round-trip",
    { action: "fold", ids: next.sourceRefs.map((ref) => ref.entryId) },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  assert.equal(response.details.provenance.kind, "model");
  assert.equal(runtime.notifications.filter((notice) => /Conflicting durable/.test(notice.message)).length, 0);
  const durableLegacy = runtime.branch.find((entry) => entry.id === "legacy-luna-record");
  assert.equal(json.stableStringify(durableLegacy.data), originalRecordBytes);
  assert.equal(runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY &&
    entry.data.foldId === legacyFold.id).length, 0);
  assert.equal(materialized(runtime).folds.find((fold) => fold.id === legacyFold.id).provenance.kind, "luna");
  return {
    durableKind: "luna",
    payloadKind: response.details.provenance.kind,
    slateGenerator: "projection-model",
    conflictingErrors: 0,
    durableRecordBytesUnchanged: true,
  };
}

async function gatePoisonedFloorRegression() {
  const built = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    mentionToolName: true,
  });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const status = await toolStatus(runtime);
  assert(status.details.eligibleChapter, "Chapter-only fixture has no eligible chapter");
  const action = structuredClone(status.details.eligibleChapter.action);
  delete action.brief;
  const response = await runtime.tools.get("active_context").execute(
    "poisoned-floor",
    action,
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  assert.equal(response.details.kind, "chapter");
  assert.equal(response.details.provenance.kind, "deterministic");
  assert(response.details.brief.length > 20 && response.details.brief.length <= 1_200);
  assert(!/active_context/i.test(response.details.brief));
  assert.equal(materialized(runtime).folds.at(-1).kind, "chapter");
  return {
    committed: true,
    provenance: response.details.provenance.kind,
    brief: response.details.brief,
  };
}

async function gateHistoricalTolerance() {
  const built = makeFixture({ turns: 3, tools: false });
  const historicalDefault = customEntry(
    "pi-fold-active-context-guidance-reduction",
    { malformed: true },
    "historical-default-guidance",
    built.entries.at(-1).id,
  );
  const historicalCustom = customEntry(
    "custom-context-guidance-action",
    { malformed: true },
    "historical-custom-guidance",
    historicalDefault.id,
  );
  const runtime = makeRuntime(built, {
    entryTypePrefix: "custom-context",
    initialEntries: [...built.entries, historicalDefault, historicalCustom],
  });
  await startRuntime(runtime);
  const status = await toolStatus(runtime);
  assert.equal(status.details.automatic.historicalGuidanceEntries, 2);
  assert.equal(runtime.notifications.filter((notice) => /malformed.*guidance/i.test(notice.message)).length, 0);
  return { defaultAndCustomSkipped: status.details.automatic.historicalGuidanceEntries, thrown: false };
}

async function gateCompactionPolicy() {
  const runtime = makeRuntime(makeFixture({ turns: 3, tools: false }));
  await startRuntime(runtime);
  const hook = runtime.handlers.get("session_before_compact");
  const manual = await hook({ reason: "manual" }, runtime.ctx);
  const threshold = await hook({ reason: "threshold" }, runtime.ctx);
  const overflow = await hook({ reason: "overflow" }, runtime.ctx);
  assert.equal(manual, undefined);
  assert.deepEqual(threshold, { cancel: true });
  assert.deepEqual(overflow, { cancel: true });
  return { manual: "pass-through", threshold: "cancel", overflow: "cancel" };
}

async function gatePersistenceChain() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 80_000, 100_000);
  const recordIndex = runtime.appended.findIndex((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY);
  const stateIndex = runtime.appended.findIndex((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY);
  assert(recordIndex >= 0 && stateIndex > recordIndex, "Fold record did not precede state");
  const firstState = materialized(runtime);
  const foldId = firstState.folds[0].id;
  await runtime.tools.get("active_context").execute(
    "expand-for-delta",
    { action: "expand", id: foldId },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  const finalState = materialized(runtime);
  assert(finalState.expanded.includes(foldId));

  const orphanBranch = runtime.branch.filter((entry) =>
    entry.customType !== context.ACTIVE_CONTEXT_STATE_ENTRY);
  const orphanState = context.materializeActiveContextState(orphanBranch, built.sessionId);
  assert.equal(orphanState.folds.length, 0);
  const orphanRuntime = makeRuntime(built, { initialEntries: orphanBranch });
  await orphanRuntime.handlers.get("session_start")({}, orphanRuntime.ctx);
  assert.equal(orphanRuntime.notifications.filter((notice) => /state was ignored/i.test(notice.message)).length, 0);

  const brokenDigest = structuredClone(runtime.branch);
  const lastState = brokenDigest.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1);
  lastState.data.stateSha256 = "0".repeat(64);
  assert.throws(() => context.materializeActiveContextState(brokenDigest, built.sessionId),
    /state digest drift/);
  const brokenBase = structuredClone(runtime.branch);
  const lastDelta = brokenBase.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1);
  assert.equal(lastDelta.data.kind, "delta");
  lastDelta.data.baseStateSha256 = "f".repeat(64);
  assert.throws(() => context.materializeActiveContextState(brokenBase, built.sessionId),
    /Broken active-context delta chain/);

  const prePhaseState = {
    version: 1,
    sessionId: "pre-phase-a",
    revision: 0,
    folds: [],
    expanded: [],
    protected: [],
  };
  const prePhaseCheckpoint = {
    version: 2,
    kind: "checkpoint",
    sessionId: "pre-phase-a",
    revision: 0,
    foldRefs: [],
    expanded: [],
    protected: [],
    prepared: null,
    stateSha256: json.sha256Value(prePhaseState),
  };
  const migrated = context.materializeActiveContextState([
    customEntry(context.ACTIVE_CONTEXT_STATE_ENTRY, prePhaseCheckpoint, "pre-phase-checkpoint"),
  ], "pre-phase-a");
  assert.deepEqual(migrated.advisory, { highWater: 0, delivered: {} });
  assert.equal(migrated.tokensSinceToolFold, 0);
  assert.deepEqual(migrated.leases, {});
  const migrationBuilt = makeFixture({
    sessionId: "pre-phase-a",
    turns: 3,
    tools: false,
    contextWindow: 100_000,
  });
  const migrationRuntime = makeRuntime(migrationBuilt, { initialEntries: [
    ...migrationBuilt.entries,
    customEntry(
      context.ACTIVE_CONTEXT_STATE_ENTRY,
      prePhaseCheckpoint,
      "pre-phase-runtime-checkpoint",
      migrationBuilt.entries.at(-1).id,
    ),
  ] });
  await startRuntime(migrationRuntime);
  await measure(migrationRuntime, 10_000, 100_000);
  assert.equal(materialized(migrationRuntime).tokensSinceToolFold, 0);
  await measure(migrationRuntime, 20_000, 100_000);
  assert.equal(materialized(migrationRuntime).tokensSinceToolFold, 10_000);
  return {
    appendOrder: [runtime.appended[recordIndex].customType, runtime.appended[stateIndex].customType],
    orphanFoldRecords: orphanBranch.filter((entry) =>
      entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length,
    orphanActiveFolds: orphanState.folds.length,
    digestChain: "verified",
    prePhaseAdvisory: migrated.advisory,
    prePhaseCadence: migrated.tokensSinceToolFold,
    prePhaseLeases: migrated.leases,
    prePhaseRewrite: "canonical-phase-b-delta",
  };
}

async function gateCadenceToolFolds() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 10_000, 100_000);
  assert.equal(materialized(runtime).tokensSinceToolFold, 0);
  await measure(runtime, 20_000, 100_000);
  assert.equal(materialized(runtime).tokensSinceToolFold, 10_000);
  await measure(runtime, 40_000, 100_000);
  let state = materialized(runtime);
  assert.equal(state.folds.length, 1);
  assert.equal(state.folds[0].kind, "tool-result");
  assert.equal(state.tokensSinceToolFold, 0);

  await measure(runtime, 45_000, 100_000);
  state = materialized(runtime);
  assert.equal(state.folds.length, 1, "Unsatisfied cadence authorized a second tool fold");
  assert.equal(state.tokensSinceToolFold, 5_000);
  await runtime.handlers.get("model_select")({}, runtime.ctx);
  await measure(runtime, 55_000, 100_000);
  assert.equal(materialized(runtime).tokensSinceToolFold, 5_000,
    "First measurement after model_select inflated cadence from a null baseline");
  await measure(runtime, 60_000, 100_000);
  state = materialized(runtime);
  assert.equal(state.tokensSinceToolFold, 10_000);
  assert.equal(state.folds.length, 1);
  const reloaded = makeRuntime(
    { ...built, messages: runtime.messages },
    { initialEntries: runtime.branch },
  );
  await startRuntime(reloaded);
  assert.equal(materialized(reloaded).tokensSinceToolFold, 10_000);
  return {
    firedAtRatio: 0.40,
    monotonicTokens: [10_000, 20_000, 40_000, 45_000, 55_000, 60_000],
    cadenceNeed: context.toolFoldCadence(100_000),
    resetAfterFold: 0,
    unsatisfiedFolds: state.folds.length,
    postModelSelectSeed: 5_000,
    reloadedCounter: materialized(reloaded).tokensSinceToolFold,
  };
}

async function gateExpandLeases() {
  const built = makeFixture({ turns: 4, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 10_000, 100_000);
  await measure(runtime, 40_000, 100_000);
  const foldId = materialized(runtime).folds[0].id;
  await runtime.tools.get("active_context").execute(
    "lease-expand",
    { action: "expand", id: foldId },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  assert.equal(materialized(runtime).leases[foldId], 8);
  for (let index = 0; index < 7; index += 1) {
    await measure(runtime, 85_000 + index, 100_000, `lease-measurement-${index + 1}`);
  }
  let state = materialized(runtime);
  assert(state.expanded.includes(foldId));
  assert.equal(state.leases[foldId], 1);

  const reloaded = makeRuntime(
    { ...built, messages: runtime.messages },
    { initialEntries: runtime.branch },
  );
  await startRuntime(reloaded);
  assert.equal(materialized(reloaded).leases[foldId], 1);
  await measure(reloaded, 85_007, 100_000, "lease-measurement-8");
  state = materialized(reloaded);
  assert(!state.expanded.includes(foldId));
  assert.equal(state.leases[foldId], undefined);

  const wide = await chapterForest(65);
  const boundedRuntime = makeRuntime(wide, { initialEntries: [
    ...wide.entries,
    stateEntry(wide.sessionId, wide.state, "lease-bound-state", wide.entries.at(-1).id),
  ] });
  await startRuntime(boundedRuntime);
  const rootIds = wide.state.folds.filter((fold) => fold.parentId === null).map((fold) => fold.id);
  for (const id of rootIds) {
    await boundedRuntime.tools.get("active_context").execute(
      `expand-${id}`,
      { action: "expand", id },
      new AbortController().signal,
      undefined,
      boundedRuntime.ctx,
    );
  }
  const bounded = materialized(boundedRuntime);
  assert.equal(Object.keys(bounded.leases).length, 64);
  const boundedReload = makeRuntime(wide, { initialEntries: boundedRuntime.branch });
  await startRuntime(boundedReload);
  assert.deepEqual(materialized(boundedReload).leases, bounded.leases);
  return {
    remainingAfterSeven: 1,
    refoldedAfterEight: !state.expanded.includes(foldId),
    boundedLeases: Object.keys(bounded.leases).length,
    reloadRemainingCounts: true,
  };
}

async function gateWidthConsolidation() {
  const wide = await chapterForest(11);
  const originalRoots = wide.state.folds.filter((fold) => fold.parentId === null).map((fold) => fold.id);
  const runtime = makeRuntime(wide, { initialEntries: [
    ...wide.entries,
    stateEntry(wide.sessionId, wide.state, "width-state", wide.entries.at(-1).id),
  ] });
  await startRuntime(runtime);
  await measure(runtime, 30_000, 100_000);
  const state = materialized(runtime);
  const consolidation = state.folds.find((fold) =>
    fold.kind === "consolidation" && fold.parentId === null);
  assert(consolidation);
  assert.deepEqual(consolidation.parts.map((part) => part.foldId), originalRoots.slice(0, 5));

  const ten = await chapterForest(10);
  const tenRuntime = makeRuntime(ten, { initialEntries: [
    ...ten.entries,
    stateEntry(ten.sessionId, ten.state, "ten-width-state", ten.entries.at(-1).id),
  ] });
  await startRuntime(tenRuntime);
  await measure(tenRuntime, 30_000, 100_000);
  assert.equal(materialized(tenRuntime).folds.filter((fold) => fold.kind === "consolidation").length, 0);

  const children = originalRoots.slice(0, 2).map((id) => wide.state.folds.find((fold) => fold.id === id));
  const parts = children.map((fold) => ({ kind: "fold", foldId: fold.id }));
  const sourceRefs = children.flatMap((fold) => context.flattenFoldRefs(fold, wide.state));
  await assert.rejects(() => context.prepareFold({
    candidate: { kind: "consolidation", parts, sourceRefs },
    snapshot: wide.snapshot,
    state: wide.state,
    generation: 1,
    brief: `A factual but deliberately non-shrinking consolidation ${"x".repeat(1_100)}`,
  }), /materially reduce/);
  return {
    firedAtRatio: 0.30,
    selectedRoots: consolidation.parts.map((part) => part.foldId),
    tenRootsAction: null,
    byteShrinkGate: "enforced",
  };
}

async function gateQuietWarming() {
  const chapterBuilt = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: 100_000,
  });
  let summaryCalls = 0;
  const summarize = async () => {
    summaryCalls += 1;
    return MODEL_BRIEF();
  };
  const warm = makeRuntime(chapterBuilt, { summarizeContextSpan: summarize });
  await startRuntime(warm);
  await measure(warm, 60_000, 100_000);
  await settle(8);
  const warmedStatus = await toolStatus(warm);
  let warmState = materialized(warm);
  assert.equal(summaryCalls, 1);
  assert(warmState.prepared, JSON.stringify(warmedStatus.details.automatic));
  assert.equal(warmState.folds.length, 0);
  assert.equal(warmedStatus.details.automatic.preparedFoldId, warmState.prepared.id);
  assert.equal(warmedStatus.details.automatic.lastAutomaticAction, null);
  const narrowFenceTokens = Math.round(context.hardFenceRatio({ contextWindow: 100_000 }) * 100_000);
  await measure(warm, narrowFenceTokens, 100_000);
  warmState = materialized(warm);
  assert.equal(warmState.folds.filter((fold) => fold.kind === "chapter").length, 1);

  let refusedCalls = 0;
  const toolRuntime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
    { summarizeContextSpan: async () => { refusedCalls += 1; return MODEL_BRIEF(); } },
  );
  await startRuntime(toolRuntime);
  await measure(toolRuntime, 10_000, 100_000);
  await measure(toolRuntime, 60_000, 100_000);
  assert.equal(refusedCalls, 0);
  assert.equal(materialized(toolRuntime).prepared, undefined);
  assert.equal(materialized(toolRuntime).folds[0].kind, "tool-result");

  const floor = makeRuntime(chapterBuilt);
  await startRuntime(floor);
  await measure(floor, 60_000, 100_000);
  assert.equal(materialized(floor).prepared, undefined);
  await measure(floor, narrowFenceTokens, 100_000);
  const floorState = materialized(floor);
  assert.equal(floorState.folds.filter((fold) => fold.kind === "chapter").length, 1);
  assert.equal(floorState.folds.find((fold) => fold.kind === "chapter").provenance.kind, "deterministic");

  let fenceCalls = 0;
  const fence = makeRuntime(chapterBuilt, {
    summarizeContextSpan: async () => {
      fenceCalls += 1;
      return MODEL_BRIEF();
    },
  });
  await startRuntime(fence);
  const fenceTokens = narrowFenceTokens;
  await measure(fence, fenceTokens, 100_000);
  const fenceChapter = materialized(fence).folds.find((fold) => fold.kind === "chapter");
  assert.equal(fenceCalls, 1);
  assert.equal(fenceChapter?.provenance.kind, "model");
  return {
    warmedAtRatio: 0.60,
    warmCalls: summaryCalls,
    committedAtFence: true,
    deterministicPriorityRefusedWarm: refusedCalls === 0,
    noSummarizerWarmCalls: 0,
    fenceFloor: "deterministic",
    summarizerFenceJump: fenceChapter.provenance.kind,
  };
}

async function gateFoldCandidatesDetail() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 80_000, 100_000);
  const snapshot = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const state = materialized(runtime);
  const expected = context.foldCandidatesDetail(snapshot, state, 0.80, {
    summarizerAvailable: false,
    measurementFresh: false,
    automaticFailure: false,
    preparing: false,
  });
  const branchBefore = json.stableStringify(runtime.branch);
  const appendedBefore = runtime.appended.length;
  const status = await toolStatus(runtime, "active_context", "fold_candidates");
  assert.equal(json.stableStringify(status.details.candidates), json.stableStringify(expected));
  assert.equal(status.details.automatic.measurementFresh, false);
  assert.equal(status.details.candidates.wouldFireNow, null);
  assert.equal(status.details.candidates.blockedBy, "measurement-stale");
  assert(status.details.candidates.tool, "Stale-measurement fixture lacked an otherwise eligible rung");
  assert.equal(json.stableStringify(runtime.branch), branchBefore);
  assert.equal(runtime.appended.length, appendedBefore);
  return {
    selectorIdentical: true,
    wouldFireNow: status.details.candidates.wouldFireNow,
    blockedBy: status.details.candidates.blockedBy,
    cadence: status.details.candidates.cadence,
    width: status.details.candidates.width,
    durableMutations: 0,
  };
}

async function gateBlockingToolHarvest() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 20_000, 100_000);
  await measure(runtime, 25_000, 100_000);
  await measure(runtime, 30_000, 100_000);
  const hook = runtime.handlers.get("tool_call");
  const before = runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  assert.equal(hook({ toolName: "read" }, runtime.ctx), undefined);
  await settle();
  assert.equal(runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length, before);
  assert.equal(hook({ toolName: "Agent" }, runtime.ctx), undefined);
  assert.equal(hook({ toolName: "Agent" }, runtime.ctx), undefined);
  await settle(8);
  const after = runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  assert.equal(after, before + 1);
  assert.equal((await toolStatus(runtime)).details.automatic.pressureRatio, 0.30);
  await measure(runtime, 31_000, 100_000);
  await runtime.handlers.get("turn_end")({}, runtime.ctx);
  assert.equal(hook({ toolName: "Agent" }, runtime.ctx), undefined);
  await settle(8);
  const afterTurnReset = runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  assert.equal(afterTurnReset, after + 1, "turn_end did not reset the blocking-tool harvest latch");

  let warmStarted = false;
  let warmAborted = false;
  const warmRuntime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
    {
      summarizeContextSpan: ({ signal }) => new Promise((_resolve, reject) => {
        warmStarted = true;
        signal.addEventListener("abort", () => {
          warmAborted = true;
          reject(new Error("warm preparation canceled for deterministic harvest"));
        }, { once: true });
      }),
    },
  );
  await startRuntime(warmRuntime);
  await measure(warmRuntime, 50_000, 100_000);
  await measure(warmRuntime, 60_000, 100_000);
  assert.equal(warmStarted, true);
  assert.equal((await toolStatus(warmRuntime)).details.automatic.preparing, true);
  assert.equal(warmRuntime.handlers.get("tool_call")({ toolName: "Agent" }, warmRuntime.ctx), undefined);
  await settle(8);
  assert.equal(warmAborted, true);
  assert.equal(materialized(warmRuntime).folds.filter((fold) => fold.kind === "tool-result").length, 1);
  return {
    ratio: 0.30,
    monotonicTokens: [20_000, 25_000, 30_000, 31_000],
    firstBlockingCallFolds: 1,
    secondBlockingCallFolds: 0,
    nonBlockingCallFolds: 0,
    turnEndResetFolds: 1,
    warmInFlightHarvest: "committed",
  };
}

async function gateWireForwardBackwardNote() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 50_000, 100_000);
  await measure(runtime, 80_000, 100_000);
  const canonicalDeltaEntry = runtime.branch.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1);
  assert.equal(canonicalDeltaEntry.data.kind, "delta");
  assert(Object.hasOwn(canonicalDeltaEntry.data, "tokensSinceToolFold"));
  assert(Object.hasOwn(canonicalDeltaEntry.data, "leases"));

  // An older exact-record reader rejects the newer optional state fields. That
  // forward incompatibility is expected until the next explicit wire bump;
  // immutable fold-record entries remain independently valid evidence.
  const phaseADeltaKeys = new Set([
    "version", "kind", "sessionId", "revision", "baseRevision", "baseStateSha256",
    "addFoldRefs", "removeFoldIds", "expanded", "protected", "prepared", "advisory",
    "stateSha256",
  ]);
  assert.throws(() => {
    const unexpected = Object.keys(canonicalDeltaEntry.data).filter((key) => !phaseADeltaKeys.has(key));
    if (unexpected.length) throw new Error(`Phase-A strict reader rejects fields: ${unexpected.join(",")}`);
  }, /tokensSinceToolFold,leases/);

  const foldRecordEntry = runtime.branch.find((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY);
  assert(foldRecordEntry);
  assert.equal(foldRecordEntry.data.recordSha256, json.sha256Value(foldRecordEntry.data.fold));
  const firstRead = materialized(runtime);
  const secondRead = context.materializeActiveContextState(runtime.branch, built.sessionId);
  assert.equal(json.stableStringify(secondRead), json.stableStringify(firstRead));
  assert.equal(secondRead.folds.some((fold) => fold.id === foldRecordEntry.data.foldId), true);
  return {
    monotonicTokens: [50_000, 80_000],
    phaseABaseRead: "expected-rejection-of-phase-b-state",
    foldRecord: "sha256-verified",
    phaseBCanonicalDeltaReread: true,
  };
}

async function gateFollowupFencesAndAnchors() {
  const fallbackHardFenceRatio = (
    context.DEFAULT_CONTEXT_WINDOW - context.ACTIVE_CONTEXT_POLICY.responseReserve
  ) / context.DEFAULT_CONTEXT_WINDOW;
  near(context.hardFenceRatio({ contextWindow: 16_000 }), 0.90, 1e-12, "16k fence");
  near(context.hardFenceRatio({ contextWindow: 17_000 }), 0.90, 1e-12, "17k fence");
  near(
    context.hardFenceRatio({ contextWindow: 0 }),
    fallbackHardFenceRatio,
    1e-12,
    "fallback fence",
  );
  const tiny = [];
  for (const contextWindow of [16_000, 17_000]) {
    const runtime = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow }));
    await startRuntime(runtime);
    const automatic = (await toolStatus(runtime)).details.automatic;
    near(automatic.hardFenceRatio, 0.90, 1e-12, `${contextWindow} status fence`);
    assert.equal(automatic.responseReserve, Math.floor(contextWindow * 0.1));
    assert.equal(automatic.windowSource, "reported");
    tiny.push({ contextWindow, reserve: automatic.responseReserve, fence: automatic.hardFenceRatio });
  }

  const fallback = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 0 }));
  await startRuntime(fallback);
  const fallbackAutomatic = (await toolStatus(fallback)).details.automatic;
  assert.equal(fallbackAutomatic.windowSource, "fallback");
  near(
    fallbackAutomatic.hardFenceRatio,
    fallbackHardFenceRatio,
    1e-12,
    "fallback status fence",
  );

  const staleBuilt = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const stale = makeRuntime(staleBuilt);
  stale.appendMessage(measuredAssistant(80_000, 100_000, "unbound-historical-measurement"));
  await startRuntime(stale);
  const staleStatus = await toolStatus(stale);
  assert.equal(staleStatus.details.automatic.measurementFresh, false);
  assert.equal(materialized(stale).folds.length, 0);
  assert.equal(stale.appended.filter((entry) =>
    entry.customType === context.PROVIDER_CONTEXT_MEASUREMENT_ENTRY).length, 0);

  const harvestDisabled = makeRuntime(
    makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
    { blockingTools: [] },
  );
  await startRuntime(harvestDisabled);
  assert.equal((await toolStatus(harvestDisabled)).details.automatic.freeHarvest, "disabled");
  return {
    tiny,
    fallback: {
      fence: fallbackAutomatic.hardFenceRatio,
      windowSource: fallbackAutomatic.windowSource,
    },
    unboundMeasurement: "stale-no-rebind",
    freeHarvest: "disabled",
  };
}

async function gateFreshTailShareCap() {
  // One fixture shape, two windows. Total projection ~<24k bytes, so the legacy
  // fixed floor protects EVERYTHING at a wide window, while the share cap
  // (min(24k, window × 0.25 × 2 bytes/token)) frees the oldest turns at 16k.
  const shape = { turns: 6, resultChars: 2_200 };
  const small = makeRuntime(makeFixture({ ...shape, contextWindow: 16_000 }));
  await startRuntime(small);
  const smallDetail = (await toolStatus(small, undefined, "fold_candidates")).details;
  assert.equal(smallDetail.rawTailMinimumBytes, 8_000);

  const wide = makeRuntime(makeFixture({ ...shape, contextWindow: 272_000 }));
  await startRuntime(wide);
  const wideDetail = (await toolStatus(wide, undefined, "fold_candidates")).details;
  assert.equal(wideDetail.rawTailMinimumBytes, 24_000);

  // Behavioral: identical content, small window → the three oldest turns escape
  // the capped tail and form an eligible chapter; wide window → the uncapped
  // floor covers the whole projection and nothing is foldable.
  const smallFree = smallDetail.objects.filter((object) => !object.protected).length;
  const wideFree = wideDetail.objects.filter((object) => !object.protected).length;
  assert.equal(smallFree, 12, "small window must free the three oldest turns");
  assert.equal(wideFree, 0, "wide window floor must keep this projection fully protected");
  assert.notEqual(smallDetail.candidates.chapter, null, "small window must expose an eligible chapter");
  assert.equal(wideDetail.candidates.chapter, null, "wide window must expose no chapter");

  // Fallback window (unknown) keeps the legacy floor untouched.
  const fallback = makeRuntime(makeFixture({ ...shape, contextWindow: 0 }));
  await startRuntime(fallback);
  const fallbackDetail = (await toolStatus(fallback, undefined, "fold_candidates")).details;
  assert.equal(fallbackDetail.rawTailMinimumBytes, 24_000);
  return {
    smallWindowTailBytes: smallDetail.rawTailMinimumBytes,
    wideWindowTailBytes: wideDetail.rawTailMinimumBytes,
    smallWindowFreedObjects: smallFree,
    wideWindowFreedObjects: wideFree,
    fallbackTailBytes: fallbackDetail.rawTailMinimumBytes,
  };
}

async function gateEvidenceIngestionSwitch() {
  const scratch = await mkdtemp(join(tmpdir(), "pi-fold-no-evidence-"));
  try {
    const sessionFile = join(scratch, "session.jsonl");
    const runtime = makeRuntime(makeFixture({ turns: 4, resultChars: 20_000 }), {
      packageRegistration: true,
      sessionFile,
      evidenceIngestion: false,
      isMcpTool: () => true,
    });
    assert.equal(runtime.handlers.has("tool_result"), false);
    await startRuntime(runtime);
    assert.equal(existsSync(sessionFile), false);
    assert.equal(existsSync(join(scratch, "pi-fold-evidence")), false);
    return {
      toolResultEvidenceHook: "absent",
      sessionArtifact: "absent",
      evidenceDirectory: "absent",
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gateSummarizerOption() {
  const measureForModel = async (runtime, tokens, model) => {
    runtime.usage = { tokens, contextWindow: 100_000 };
    const message = runtime.appendMessage({
      ...measuredAssistant(tokens, 100_000, `summarizer-measurement-${tokens}`),
      provider: model.provider,
      model: model.id,
    }, "summarizer-measurement");
    await runtime.handlers.get("message_end")({ message }, runtime.ctx);
    await settle();
  };
  const sessionModel = { provider: "fake-session", id: "brief-model", reasoning: true };
  let loaderCalls = 0;
  let createCalls = 0;
  let completionCalls = 0;
  let completionRequest;
  const loadHostModule = async () => {
    loaderCalls += 1;
    return {
      ModelRuntime: {
        async create() {
          createCalls += 1;
          return {
            getModel() { return undefined; },
            async completeSimple(model, request, options) {
              completionCalls += 1;
              completionRequest = structuredClone({ model, request, options: {
                maxTokens: options.maxTokens,
                signalIdentical: options.signal instanceof AbortSignal,
                reasoning: options.reasoning,
              } });
              return {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "not part of the brief" },
                  { type: "text", text: "The fake session model records " },
                  { type: "text", text: "the exact bounded chapter." },
                ],
              };
            },
          };
        },
      },
    };
  };
  const built = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: 100_000,
  });
  const session = makeRuntime(built, { packageRegistration: true, loadHostModule });
  session.ctx.model = sessionModel;
  assert.equal(loaderCalls, 0);
  await startRuntime(session);
  assert.equal(loaderCalls, 0, "Default registration imported the host before a model brief was requested");
  const fenceTokens = Math.round(context.hardFenceRatio({ contextWindow: 100_000 }) * 100_000);
  await measureForModel(session, fenceTokens, sessionModel);
  await settle(8);
  const modelFold = materialized(session).folds.find((fold) => fold.kind === "chapter");
  assert(modelFold, json.stableStringify({
    loaderCalls,
    createCalls,
    completionCalls,
    automatic: (await toolStatus(session)).details.automatic,
    notifications: session.notifications,
    state: materialized(session),
  }));
  assert.equal(modelFold.brief, "The fake session model records the exact bounded chapter.");
  assert.deepEqual(modelFold.provenance, {
    kind: "model",
    provider: sessionModel.provider,
    model: sessionModel.id,
    effort: "max",
  });
  assert.equal(loaderCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(completionCalls, 1);
  assert.equal(completionRequest.model.provider, sessionModel.provider);
  assert.equal(completionRequest.model.id, sessionModel.id);
  assert.equal(completionRequest.request.messages.length, 1);
  assert.equal(completionRequest.request.messages[0].role, "user");
  assert(completionRequest.request.messages[0].content.startsWith(
    "Write a factual brief of at most 1200 characters. Use no preamble and no Markdown headers.\n\n",
  ));
  assert.equal(completionRequest.options.maxTokens, 512);
  assert.equal(completionRequest.options.signalIdentical, true);
  assert.equal(completionRequest.options.reasoning, "max");

  let deterministicLoaderCalls = 0;
  const deterministic = makeRuntime(built, {
    packageRegistration: true,
    summarizer: "deterministic",
    loadHostModule: async () => {
      deterministicLoaderCalls += 1;
      throw new Error("deterministic mode loaded the host");
    },
  });
  await startRuntime(deterministic);
  await measure(deterministic, fenceTokens, 100_000);
  assert.equal(deterministicLoaderCalls, 0);
  assert.equal(
    materialized(deterministic).folds.find((fold) => fold.kind === "chapter")?.provenance.kind,
    "deterministic",
  );

  let failureCompletionCalls = 0;
  const failure = makeRuntime(built, {
    packageRegistration: true,
    loadHostModule: async () => ({
      ModelRuntime: {
        async create() {
          return {
            async completeSimple() {
              failureCompletionCalls += 1;
              throw new Error("fake completion failed");
            },
          };
        },
      },
    }),
  });
  failure.ctx.model = sessionModel;
  await startRuntime(failure);
  await measureForModel(failure, fenceTokens, sessionModel);
  assert.equal(failureCompletionCalls, 1);
  assert.equal(
    materialized(failure).folds.find((fold) => fold.kind === "chapter")?.provenance.kind,
    "deterministic",
  );

  assert.throws(() => makeRuntime(built, {
    packageRegistration: true,
    summarizer: "session",
    summarizeContextSpan: MODEL_BRIEF,
  }), /summarizer and summarizeContextSpan cannot be configured together/);
  assert.throws(() => makeRuntime(built, {
    packageRegistration: true,
    summarizer: { provider: "fake-session" },
  }), /nonempty provider and model strings/);
  assert.throws(() => makeRuntime(built, {
    packageRegistration: true,
    summarizer: { model: "brief-model" },
  }), /nonempty provider and model strings/);

  let escapeLoaderCalls = 0;
  const escape = makeRuntime(built, {
    packageRegistration: true,
    summarizeContextSpan: MODEL_BRIEF,
    loadHostModule: async () => {
      escapeLoaderCalls += 1;
      throw new Error("custom callback loaded the built-in summarizer host");
    },
  });
  await startRuntime(escape);
  await measure(escape, fenceTokens, 100_000);
  assert.equal(escapeLoaderCalls, 0);
  assert.equal(
    materialized(escape).folds.find((fold) => fold.kind === "chapter")?.provenance.kind,
    "model",
  );

  let registryLoaderCalls = 0;
  let registryCreateCalls = 0;
  const registryCompletionOptions = [];
  const registryModel = { provider: "fake-registry", id: "explicit-model", reasoning: true };
  const explicit = summarizerFactory.createSummarizeContextSpan({
    provider: registryModel.provider,
    model: registryModel.id,
    effort: "low",
  }, async () => {
    registryLoaderCalls += 1;
    return {
      ModelRuntime: {
        async create() {
          registryCreateCalls += 1;
          return {
            getModel(provider, model) {
              return provider === registryModel.provider && model === registryModel.id
                ? registryModel
                : undefined;
            },
            async completeSimple(_model, _request, options) {
              registryCompletionOptions.push(options);
              return { content: [{ type: "text", text: "Explicit registry brief." }] };
            },
          };
        },
      },
    };
  });
  const request = {
    sourceText: "Exact source span.",
    maxBriefChars: 1_200,
    signal: new AbortController().signal,
  };
  const explicitFirst = await explicit(request, { thinkingLevel: "max" });
  const explicitSecond = await explicit(request, { thinkingLevel: "max" });
  assert.deepEqual(explicitFirst, {
    brief: "Explicit registry brief.",
    provider: registryModel.provider,
    model: registryModel.id,
    effort: "low",
    toolCalls: 0,
  });
  assert.deepEqual(explicitSecond, explicitFirst);
  assert.equal(registryLoaderCalls, 1);
  assert.equal(registryCreateCalls, 1);
  assert.equal(registryCompletionOptions.length, 2);
  assert(registryCompletionOptions.every((options) => options.signal === request.signal));
  assert(registryCompletionOptions.every((options) => options.maxTokens === 512));
  assert(registryCompletionOptions.every((options) => options.reasoning === "low"));

  return {
    default: modelFold.provenance,
    toolCalls: 0,
    hostLoads: loaderCalls,
    runtimeCreates: createCalls,
    deterministic: "no-host-load",
    failureFallback: "deterministic",
    exclusiveOptions: "enforced",
    malformedObjects: "rejected",
    customCallback: "unchanged",
    explicitRegistryRuntimeCreates: registryCreateCalls,
  };
}

async function gateGuidanceProfiles() {
  const expectedPressureTexts = [
    "[active-context milestone notice; session active-context-t] Context pressure has crossed 50%. " +
      'Automatic folding is available. Inspect candidates exactly with active_context {"action":"status"}.',
    "[active-context milestone tools; session active-context-t] The read-only tool-fold rung begins at 71%. " +
      "Eligible completed tool batches can be folded now; current endpoint ids are in the live advisory.",
    "[active-context milestone chapters; session active-context-t] The chapter preparation rung begins at 85%. " +
      'Use eligibleChapter endpoints with active_context {"action":"fold","ids":["<start>","<end>"],' +
      '"brief":"<factual brief>"}.',
    "[active-context milestone urgent; session active-context-t] The hard context fence is near. The next " +
      "automatic action is a committed chapter fold or the provider request is aborted before transmission.",
  ];
  const textFor = (rung, guidance) => context.milestoneText(
    rung.milestone, "active-context-test", rung.threshold, "active_context", undefined, guidance);
  const advisoryRun = async (guidance, steps) => {
    const runtime = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 272_000 }), { guidance });
    await startRuntime(runtime);
    const texts = [];
    for (const tokens of steps) {
      await measure(runtime, tokens, 272_000);
      const projection = await project(runtime);
      for (const message of projection.messages) {
        if (message?.customType === "pi-fold-active-context-milestone") texts.push(message.content);
      }
    }
    return { texts, delivered: (await toolStatus(runtime)).details.automatic.advisory.delivered };
  };

  const pressure = guidanceSchedule(272_000);
  const pressureMap = scheduleMap(272_000);
  assert.deepEqual(guidanceSchedule(272_000, "pressure"), pressure);
  assert.equal(pressure.key, "e42777638607eb2e822996a1da9aa88217082e1d1a2e010e2f54c4e7f2bf93e8");
  assert.deepEqual(pressure.rungs.map((rung) => rung.milestone), ["notice", "tools", "chapters", "urgent"]);
  assert.deepEqual(pressure.rungs.map((rung) => textFor(rung, undefined)), expectedPressureTexts);
  assert.deepEqual(pressure.rungs.map((rung) => textFor(rung, "pressure")), expectedPressureTexts);
  const defaultRun = await advisoryRun(undefined, [233_920]);
  const pressureRun = await advisoryRun("pressure", [233_920]);
  assert.deepEqual(defaultRun.texts, [expectedPressureTexts[2]]);
  assert.deepEqual(pressureRun.texts, defaultRun.texts);
  assert.deepEqual(pressureRun.delivered, { chapters: 1 });

  const curation = guidanceSchedule(272_000, "curation");
  const curationMap = scheduleMap(272_000, "curation");
  assert.deepEqual(curation.rungs.map((rung) => rung.milestone),
    ["orientation", "notice", "tools", "chapters", "urgent"]);
  near(curationMap.orientation.threshold, 0.25);
  assert.equal(curationMap.orientation.budget, 1);
  assert.equal(context.ADVISORY_BUDGETS.orientation, 1);
  for (const milestone of ["notice", "tools", "chapters", "urgent"]) {
    near(curationMap[milestone].threshold, pressureMap[milestone].threshold, 1e-9, milestone);
    assert.equal(curationMap[milestone].budget, pressureMap[milestone].budget);
  }
  const curationTexts = Object.fromEntries(curation.rungs.map((rung) => [rung.milestone, textFor(rung, "curation")]));
  assert.equal(curationTexts.urgent, expectedPressureTexts[3]);
  assert(curationTexts.orientation.includes("browsable index of the work behind you"));
  assert(curationTexts.orientation.includes("briefs sit in the cached prefix of the window"));
  assert(curationTexts.orientation.includes('Page it with active_context {"action":"status"}'));
  assert(curationTexts.orientation.includes(
    'expand what the current task needs with active_context {"action":"expand","id":"<fold-id>"}'));
  assert(curationTexts.notice.includes("curate it against the task you are on now"));
  assert(curationTexts.notice.includes(
    'Fold the spans that task no longer needs with active_context {"action":"fold"'));
  assert(curationTexts.notice.includes(
    'keep what must stay raw out of every fold with active_context {"action":"protect","ids":["<entry-id>"]}'));
  assert(curationTexts.tools.includes("Fold the batches whose detail this task is finished with"));
  assert(curationTexts.chapters.includes("Fold up: hand two or more adjacent folds of finished work"));
  assert(curationTexts.chapters.includes(
    '{"action":"fold","ids":["<fold-id>","<fold-id>"],"brief":"<factual brief>"}'));
  assert(curationTexts.chapters.includes("leaving the oldest material deepest and still exactly recoverable"));
  assert(Object.values(curationTexts).every((text) => !text.includes("\u2014")));
  const curationRun = await advisoryRun("curation", [81_600, 27_200, 81_600]);
  assert.deepEqual(curationRun.texts, [curationTexts.orientation]);
  assert.deepEqual(curationRun.delivered, { orientation: 1 });

  const minimal = guidanceSchedule(272_000, "minimal");
  assert.deepEqual(minimal.rungs.map((rung) => rung.milestone), ["urgent"]);
  near(minimal.rungs[0].threshold, pressureMap.urgent.threshold);
  const minimalRun = await advisoryRun("minimal", [108_800, 196_520, 233_920, 250_240]);
  assert.deepEqual(minimalRun.texts, [expectedPressureTexts[3]]);
  assert.deepEqual(minimalRun.delivered, { urgent: 1 });

  assert.throws(() => makeRuntime(makeFixture({ turns: 3, tools: false }), { guidance: "aggressive" }),
    /guidance must be "pressure", "curation", or "minimal"/);
  assert.throws(() => makeRuntime(makeFixture({ turns: 3, tools: false }),
    { packageRegistration: true, guidance: 3 }), /guidance must be/);

  return {
    pressureScheduleKey: pressure.key,
    pressureRungs: pressure.rungs.map((rung) => rung.milestone),
    defaultMatchesPressure: true,
    curationRungs: curation.rungs.map((rung) => rung.milestone),
    orientation: { threshold: curationMap.orientation.threshold, budget: curationMap.orientation.budget },
    curationDelivered: curationRun.delivered,
    curationUrgentText: "unchanged",
    minimalRungs: minimal.rungs.map((rung) => rung.milestone),
    minimalDelivered: minimalRun.delivered,
    invalidGuidance: "rejected",
  };
}

async function gatePeekAndFoldIndex() {
  const forest = await chapterForest(2);
  const chapterIds = forest.state.folds.filter((fold) => fold.parentId === null).map((fold) => fold.id);
  const consolidated = await commitCandidate(
    forest.state,
    forest.snapshot,
    context.manualFoldCandidate(forest.snapshot, forest.state, chapterIds),
    { brief: "Grouped two complete chapters whose exact sources stay recoverable at depth.", now: 9 },
  );
  const consolidationId = consolidated.prepared.id;
  const childId = chapterIds[0];
  const runtime = makeRuntime(forest, { initialEntries: [
    ...forest.entries,
    stateEntry(forest.sessionId, consolidated.state, "peek-state", forest.entries.at(-1).id),
  ] });
  await startRuntime(runtime);
  const seeded = materialized(runtime);
  const projectionBefore = json.stableStringify(context.projectActiveContext(forest.snapshot, seeded));
  const branchBefore = json.stableStringify(runtime.branch);
  const appendedBefore = runtime.appended.length;
  assert(projectionBefore.includes(consolidationId));
  assert.equal(projectionBefore.includes(childId), false);

  const peek = await runtime.tools.get("active_context").execute(
    "peek-nested",
    { action: "peek", id: childId },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  const afterPeek = materialized(runtime);
  assert.equal(afterPeek.revision, seeded.revision);
  assert.deepEqual(afterPeek.expanded, seeded.expanded);
  assert.equal(json.stableStringify(context.projectActiveContext(forest.snapshot, afterPeek)), projectionBefore);
  assert.equal(json.stableStringify(runtime.branch), branchBefore);
  assert.equal(runtime.appended.length, appendedBefore);

  const childFold = seeded.folds.find((fold) => fold.id === childId);
  const restored = context.renderFold(
    childFold,
    { ...seeded, expanded: [consolidationId, childId] },
    forest.snapshot,
  );
  assert.equal(peek.details.source, json.stableStringify(restored));
  assert.equal(peek.details.sourceCount, restored.length);
  assert.equal(peek.details.truncated, false);
  assert.equal(peek.details.depth, 1);
  assert.equal(peek.details.parentId, consolidationId);
  assert.equal(peek.details.sourceSha256, childFold.sourceSha256);

  const big = makeFixture({
    turns: 3,
    resultChars: 150_000,
    policy: { freshTurns: 1, freshBytes: 0, minToolChars: 100 },
    contextWindow: 1_000_000,
  });
  const emptyBig = context.emptyActiveContextState(big.sessionId);
  const [batch] = context.selectAutomaticToolBatch(big.snapshot, emptyBig, 0.80);
  const oversized = await commitCandidate(emptyBig, big.snapshot, batch, {
    brief: context.automaticToolBrief(big.snapshot, batch),
  });
  const peekArguments = {
    foldId: oversized.prepared.id,
    state: oversized.state,
    entries: big.entries,
    sessionId: big.sessionId,
  };
  const bounded = context.peekFoldSource(peekArguments);
  const complete = json.stableStringify(context.recoverFoldMessages(peekArguments));
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.sourceBytes, Buffer.byteLength(complete, "utf8"));
  assert(bounded.sourceBytes > context.ACTIVE_CONTEXT_POLICY.maxChapterChars);
  assert.equal(bounded.returnedBytes, context.ACTIVE_CONTEXT_POLICY.maxChapterChars);
  assert.equal(bounded.source, complete.slice(0, bounded.source.length));
  assert(bounded.note.startsWith("Truncated:"));
  assert(bounded.note.includes(String(bounded.sourceBytes)));

  const tree = (await toolStatus(runtime, "active_context", "tree")).details.tree;
  assert.deepEqual(tree.map((row) => [row.id, row.depth, row.parentId, row.state, row.peekable]), [
    [consolidationId, 0, null, "folded", true],
    [chapterIds[0], 1, consolidationId, "folded", true],
    [chapterIds[1], 1, consolidationId, "folded", true],
  ]);
  assert(tree.every((row) => row.brief && row.sourceCount > 0 && row.kind));
  assert.deepEqual(
    context.visibleCollapsedFolds(seeded, forest.snapshot).map((fold) => fold.id),
    [consolidationId],
  );
  const plain = await toolStatus(runtime, "active_context");
  assert.equal(plain.details.tree, undefined);
  assert.equal(plain.details.totalFolds, 3);
  const candidates = await toolStatus(runtime, "active_context", "fold_candidates");
  assert.equal(candidates.details.tree, undefined);
  assert(candidates.details.candidates);

  await assert.rejects(() => runtime.tools.get("active_context").execute(
    "peek-unknown",
    { action: "peek", id: "no-such-fold" },
    new AbortController().signal,
    undefined,
    runtime.ctx,
  ), /Unknown active-context fold/);
  return {
    peekedDepth: peek.details.depth,
    peekedParent: peek.details.parentId === consolidationId,
    exactSourceMatchesExpansion: true,
    revisionUnchanged: afterPeek.revision === seeded.revision,
    boundedReturnedBytes: bounded.returnedBytes,
    boundedTotalBytes: bounded.sourceBytes,
    treeDepths: tree.map((row) => row.depth),
    visibleRoots: 1,
    unknownIdRejected: true,
  };
}

const SURFACING_TASK_TEXT =
  "Which chapter remains independently pageable and recoverable in the complete index?";
const SURFACING_SOURCE = "fold-brief";

function taskSnapshotFor(snapshot, text = SURFACING_TASK_TEXT) {
  return {
    ...snapshot,
    messages: [...snapshot.messages, { role: "user", content: [{ type: "text", text }] }],
  };
}

function surfacingCarrier(projection, entryTypePrefix = "pi-fold-active-context") {
  return projection.messages.filter((message) => message?.customType === `${entryTypePrefix}-surfacing`);
}

async function surfacingFixture({ consolidate = false, taskText = SURFACING_TASK_TEXT, ...options } = {}) {
  const forest = await chapterForest(2);
  let state = forest.state;
  if (consolidate) {
    const chapterIds = context.orderedRoots(state, forest.snapshot).map((root) => root.fold.id);
    state = (await commitCandidate(
      state,
      forest.snapshot,
      context.manualFoldCandidate(forest.snapshot, state, chapterIds),
      { brief: "Grouped two complete chapters that remain independently pageable and recoverable.", now: 9 },
    )).state;
  }
  const runtime = makeRuntime(forest, {
    ...options,
    initialEntries: [
      ...forest.entries,
      stateEntry(forest.sessionId, state, "surfacing-state", forest.entries.at(-1).id),
    ],
  });
  if (taskText) {
    runtime.appendMessage(
      { role: "user", content: [{ type: "text", text: taskText }], timestamp: 9_000 },
      "surfacing-task",
    );
  }
  return { forest, state, runtime };
}

async function gateSurfacingSelector() {
  const source = await readFile(join(projectRoot, "extensions", "lib", "surfacing.ts"), "utf8");
  assert.equal(/Date\.now|Math\.random|new Date/.test(source), false,
    "The selector must be seedless: no wall clock and no randomness");

  const forest = await chapterForest(2);
  const taskTokens = context.taskTokenSet(taskSnapshotFor({ messages: [] }));
  const candidates = context.foldBriefCandidates({
    state: forest.state,
    snapshot: forest.snapshot,
    toolName: "active_context",
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.source), [SURFACING_SOURCE, SURFACING_SOURCE]);
  assert(candidates.every((candidate) => candidate.route.includes('"action":"expand"') &&
    candidate.alternateRoute.includes('"action":"peek"')));
  const positionCeiling = forest.snapshot.mapped.length - 1;
  const ranked = context.rankSurfacingCandidates({ candidates, taskTokens, positionCeiling });
  const repeated = context.rankSurfacingCandidates({ candidates, taskTokens, positionCeiling });
  const reversed = context.rankSurfacingCandidates({
    candidates: [...candidates].reverse(), taskTokens, positionCeiling,
  });
  assert.equal(json.stableStringify(ranked), json.stableStringify(repeated));
  assert.equal(json.stableStringify(ranked), json.stableStringify(reversed));
  assert.equal(ranked.length, 2);
  assert(ranked[0].score > ranked[1].score);
  // Equal lexical overlap: the later span wins on the recency component alone.
  assert.equal(ranked[0].id, candidates[1].id);

  const depthRanked = context.rankSurfacingCandidates({
    candidates: [
      { source: "probe", id: "shallow", text: "chapter remains independently pageable", route: "r", position: 4, depth: 0 },
      { source: "probe", id: "deep", text: "chapter remains independently pageable", route: "r", position: 4, depth: 4 },
    ],
    taskTokens,
    positionCeiling: 8,
  });
  assert.deepEqual(depthRanked.map((suggestion) => suggestion.id), ["deep", "shallow"]);
  assert(depthRanked[0].score - depthRanked[1].score > 0);

  const consolidated = await surfacingFixture({ consolidate: true, taskText: null });
  const nested = context.foldBriefCandidates({
    state: consolidated.state,
    snapshot: consolidated.forest.snapshot,
    toolName: "active_context",
  });
  assert.deepEqual(nested.map((candidate) => candidate.depth), [0, 1, 1]);
  return {
    seedless: true,
    candidates: candidates.length,
    deterministic: true,
    arrivalOrderIndependent: true,
    recencyOrder: [ranked[0].score, ranked[1].score],
    depthOrder: depthRanked.map((suggestion) => suggestion.id),
    nestedDepths: nested.map((candidate) => candidate.depth),
  };
}

async function gateSurfacingThresholdAndBudget() {
  // Structural components alone can never clear the bar: a suggestion always needs
  // lexical evidence that the span matches the task in hand.
  assert(context.SURFACING_RECENCY_WEIGHT + context.SURFACING_DEPTH_WEIGHT < context.SURFACING_MIN_SCORE);

  const forest = await chapterForest(2);
  const candidates = context.foldBriefCandidates({
    state: forest.state,
    snapshot: forest.snapshot,
    toolName: "active_context",
  });
  const unrelated = context.rankSurfacingCandidates({
    candidates,
    taskTokens: context.taskTokenSet(forest.snapshot),
    positionCeiling: forest.snapshot.mapped.length - 1,
  });
  assert.deepEqual(unrelated, []);

  const taskTokens = context.taskTokenSet(taskSnapshotFor({ messages: [] }));
  const many = Array.from({ length: 6 }, (_value, index) => ({
    source: "probe",
    id: `candidate-${index}`,
    text: "chapter remains independently pageable and recoverable",
    route: `route-${index}`,
    position: index,
    depth: 0,
  }));
  const topK = context.rankSurfacingCandidates({ candidates: many, taskTokens, positionCeiling: 5 });
  assert.equal(topK.length, context.SURFACING_TOP_K);
  assert(context.SURFACING_TOP_K >= 2 && context.SURFACING_TOP_K <= 3);
  const budgeted = context.rankSurfacingCandidates({
    candidates: many, taskTokens, positionCeiling: 5, charBudget: 140,
  });
  assert.equal(budgeted.length, 1);
  const raised = context.rankSurfacingCandidates({
    candidates: many, taskTokens, positionCeiling: 5, minimumScore: 0.99,
  });
  assert.deepEqual(raised, []);
  const carrier = context.surfacingText({ suggestions: topK, brandNoun: "pi-fold" });
  const silent = context.surfacingText({ suggestions: [], brandNoun: "pi-fold" });
  assert.equal(silent, null);
  assert(carrier.includes(topK[0].id) && carrier.includes("expand"));
  return {
    structuralWeightsBelowThreshold: true,
    unrelatedSuggestions: 0,
    topK: topK.length,
    budgetedSuggestions: budgeted.length,
    raisedThresholdSuggestions: 0,
    silentBelowThreshold: silent === null,
  };
}

async function gateSurfacingHysteresis() {
  const forest = await chapterForest(2);
  const snapshot = taskSnapshotFor(forest.snapshot);
  const sources = [context.FOLD_BRIEF_SUGGESTION_SOURCE];
  const first = context.updateSurfacing({ state: forest.state, snapshot, sources, toolName: "active_context" });
  assert.equal(first.suggestions.length, 2);
  assert.equal(first.state.surfacing.length, 2);
  assert(first.state.surfacing.every((record) => record.outcome === "shown" &&
    record.source === SURFACING_SOURCE && Number.isSafeInteger(record.ordinal)));

  // Re-projecting the same ordinal is one showing: same slate, no duplicate record.
  const second = context.updateSurfacing({ state: first.state, snapshot, sources, toolName: "active_context" });
  assert.equal(json.stableStringify(second.suggestions), json.stableStringify(first.suggestions));
  assert.equal(second.state, first.state);
  assert.equal(second.state.surfacing.length, 2);

  const ordinal = first.state.surfacing[0].ordinal;
  const suppressed = context.cooledDownIds(first.state.surfacing, ordinal + 1);
  assert.equal(suppressed.size, 2);
  const expired = context.cooledDownIds(
    first.state.surfacing,
    ordinal + context.SURFACING_COOLDOWN_ORDINALS,
  );
  assert.equal(expired.size, 0);
  const accepted = context.acceptSurfacingSuggestion(first.state, first.suggestions[0].id, ordinal);
  assert.equal(accepted.surfacing.filter((record) => record.outcome === "accept").length, 1);
  assert.equal(context.cooledDownIds(accepted.surfacing, ordinal + 1).size, 1);

  const expandedState = context.setFoldProjectionState(forest.state, first.suggestions[0].id, "expanded");
  const withoutExpanded = context.foldBriefCandidates({
    state: expandedState, snapshot: forest.snapshot, toolName: "active_context",
  });
  assert.equal(withoutExpanded.some((candidate) => candidate.id === first.suggestions[0].id), false);

  const protectedState = context.protectEvidence(
    forest.snapshot,
    forest.state,
    [first.suggestions[0].id],
    true,
  );
  const withoutProtected = context.foldBriefCandidates({
    state: protectedState, snapshot: forest.snapshot, toolName: "active_context",
  });
  assert.equal(withoutProtected.some((candidate) => candidate.id === first.suggestions[0].id), false);
  return {
    shown: first.suggestions.length,
    sameOrdinalIdempotent: true,
    cooldownSuppressed: suppressed.size,
    cooldownExpired: expired.size,
    acceptedExemptFromCooldown: true,
    expandedNeverSuggested: true,
    protectedNeverSuggested: true,
  };
}

async function gateSurfacingCarrier() {
  const { forest, state, runtime } = await surfacingFixture();
  const projection = await startRuntime(runtime);
  const carrier = surfacingCarrier(projection);
  assert.equal(carrier.length, 1);
  assert.equal(projection.messages.at(-1), carrier[0], "The carrier rides the tail, never the stable prefix");
  assert.equal(carrier[0].role, "custom");
  assert.equal(carrier[0].display, false);
  assert.equal(carrier[0].details.ephemeral, true);
  assert(carrier[0].content.includes('"action":"peek"'));
  assert(carrier[0].content.includes('"action":"expand"'));
  const shownIds = carrier[0].details.suggestions.map((suggestion) => suggestion.id);
  assert(shownIds.length >= 1);
  assert(shownIds.every((id) => carrier[0].content.includes(id)));

  // The carrier is never durable and never touches the fold lattice.
  assert.equal(runtime.branch.some((entry) => entry.customType?.endsWith("-surfacing")), false);
  assert.equal(runtime.appended.some((entry) => entry.customType?.endsWith("-surfacing")), false);
  const after = materialized(runtime);
  assert.deepEqual(after.folds.map((fold) => fold.id), state.folds.map((fold) => fold.id));
  assert.deepEqual(after.expanded, state.expanded);
  const prefix = projection.messages.slice(0, -1);
  assert.equal(prefix.some((message) => typeof message?.customType === "string" &&
    ["-milestone", "-advisory", "-surfacing"].some((suffix) => message.customType.endsWith(suffix))), false);

  // Re-projecting the same ordinal neither duplicates the carrier nor rewrites state.
  const appendedBefore = runtime.appended.length;
  const again = await project(runtime);
  assert.equal(surfacingCarrier(again).length, 1);
  assert.equal(json.stableStringify(surfacingCarrier(again)), json.stableStringify(carrier));
  assert.equal(runtime.appended.length, appendedBefore);

  // Urgent fence text never shares an advisory with suggestions.
  const fenced = await surfacingFixture({ consolidate: true });
  await startRuntime(fenced.runtime);
  await measure(fenced.runtime, 88_000, 100_000);
  const fencedProjection = await project(fenced.runtime);
  const milestone = fencedProjection.messages.filter((message) =>
    message?.customType === "pi-fold-active-context-milestone");
  assert.equal(milestone.length, 1);
  assert.equal(milestone[0].details.milestone, "urgent");
  assert.equal(surfacingCarrier(fencedProjection).length, 0);

  const disabled = await surfacingFixture({ surfacing: false });
  const disabledProjection = await startRuntime(disabled.runtime);
  assert.equal(surfacingCarrier(disabledProjection).length, 0);
  assert.equal(materialized(disabled.runtime).surfacing, undefined);
  const disabledStatus = await toolStatus(disabled.runtime);
  assert.deepEqual(disabledStatus.details.automatic.surfacing, {
    enabled: false, sources: [], shown: [], log: [],
  });
  return {
    carrierMessages: carrier.length,
    tailOnly: true,
    ephemeral: carrier[0].details.ephemeral,
    durableCarrierEntries: 0,
    foldStateUnchanged: true,
    reprojectionStable: true,
    urgentExcludesSuggestions: true,
    disabledCarrierMessages: 0,
    sessionId: forest.sessionId === runtime.built.sessionId,
  };
}

async function gateSuggestionSourceHook() {
  const registered = [];
  const { runtime } = await surfacingFixture({
    setSuggestionSourceRegistrar: (register) => registered.push(register),
  });
  assert.equal(registered.length, 1, "The registrar reaches the host exactly once");
  const register = registered[0];
  assert.equal(typeof runtime.registration.registerSuggestionSource, "function");

  const seen = [];
  const handle = register({
    id: "external-memory",
    candidates: (input) => {
      seen.push(Object.keys(input).sort().join(","));
      return [
        {
          id: "art_pageable_index",
          text: "Durable note: the chapter index remains independently pageable and recoverable.",
          route: 'recall {"address":"art_pageable_index"}',
        },
        { id: "", text: "malformed", route: "route" },
        { text: "no id", route: "route" },
        "not-an-object",
      ];
    },
  });
  assert.throws(() => register({ id: "external-memory", candidates: () => [] }),
    /already registered/);
  assert.throws(() => register({ id: "", candidates: () => [] }), /nonempty id/);
  register({ id: "faulty", candidates: () => { throw new Error("source is broken"); } });

  const projection = await startRuntime(runtime);
  const carrier = surfacingCarrier(projection);
  assert.equal(carrier.length, 1);
  assert.deepEqual(seen, ["snapshot,state,toolName"]);
  const shown = carrier[0].details.suggestions;
  assert(shown.some((suggestion) => suggestion.source === "external-memory" &&
    suggestion.id === "art_pageable_index"));
  assert(shown.some((suggestion) => suggestion.source === SURFACING_SOURCE));
  assert(carrier[0].content.includes('recall {"address":"art_pageable_index"}'));
  // A malformed candidate and a throwing source cost their own items, nothing else.
  assert.equal(shown.filter((suggestion) => suggestion.source === "external-memory").length, 1);

  const log = materialized(runtime).surfacing;
  assert(log.some((record) => record.source === "external-memory" && record.outcome === "shown"));
  handle.accepted("art_pageable_index");
  await project(runtime);
  assert.equal(materialized(runtime).surfacing
    .find((record) => record.id === "art_pageable_index").outcome, "accept");

  handle.unregister();
  const withdrawn = await project(runtime);
  assert.equal(surfacingCarrier(withdrawn)[0].details.suggestions
    .some((suggestion) => suggestion.source === "external-memory"), false);
  return {
    registrarDelivered: registered.length,
    sourceInput: seen[0],
    externalSuggestions: 1,
    malformedCandidatesDropped: 3,
    faultySourceIsolated: true,
    externalAccepted: true,
    unregistered: true,
  };
}

async function gateSurfacingLogging() {
  const { runtime } = await surfacingFixture();
  await startRuntime(runtime);
  const shownLog = materialized(runtime).surfacing;
  assert(shownLog.length >= 1);
  assert(shownLog.every((record) => record.outcome === "shown" &&
    typeof record.source === "string" && typeof record.id === "string" &&
    record.score >= 0 && record.score <= 1 && Number.isSafeInteger(record.ordinal)));
  const target = shownLog[0].id;

  // Peek is the accept signal and stays ephemeral: no durable entry of its own.
  const branchBefore = runtime.branch.length;
  await runtime.tools.get("active_context").execute(
    "peek-suggested", { action: "peek", id: target }, new AbortController().signal, undefined, runtime.ctx,
  );
  assert.equal(runtime.branch.length, branchBefore);
  const peeked = (await toolStatus(runtime)).details.automatic.surfacing.log;
  assert.equal(peeked.find((record) => record.id === target).outcome, "accept");
  await project(runtime);
  assert.equal(materialized(runtime).surfacing.find((record) => record.id === target).outcome, "accept");

  // Expanding a suggested fold is the other accept signal, and it persists at once.
  const expandTarget = shownLog.find((record) => record.id !== target)?.id ?? target;
  await runtime.tools.get("active_context").execute(
    "expand-suggested", { action: "expand", id: expandTarget }, new AbortController().signal,
    undefined, runtime.ctx,
  );
  assert.equal(materialized(runtime).surfacing.find((record) => record.id === expandTarget).outcome, "accept");

  // A shown suggestion nobody acts on inside the window is a reject.
  const stale = context.resolvedSurfacingLog(
    [{ source: SURFACING_SOURCE, id: "fold_ignored", score: 0.5, ordinal: 4, outcome: "shown" }],
    4 + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1,
  );
  assert.deepEqual(stale.map((record) => record.outcome), ["reject"]);
  const kept = context.resolvedSurfacingLog(
    [{ source: SURFACING_SOURCE, id: "fold_ignored", score: 0.5, ordinal: 4, outcome: "shown" }],
    4 + context.SURFACING_OUTCOME_WINDOW_ORDINALS,
  );
  assert.deepEqual(kept.map((record) => record.outcome), ["shown"]);

  // The log survives the durable wire and is refused when malformed.
  const roundTrip = materialized(runtime);
  assert.deepEqual(
    context.parseActiveContextState(roundTrip, runtime.built.sessionId).surfacing,
    roundTrip.surfacing,
  );
  assert.throws(() => context.parseSurfacingLog([
    { source: SURFACING_SOURCE, id: "fold_x", score: 2, ordinal: 1, outcome: "shown" },
  ]), /Invalid active-context surfacing log/);
  assert.throws(() => context.parseSurfacingLog([
    { source: SURFACING_SOURCE, id: "fold_x", score: 0.5, ordinal: 1, outcome: "maybe" },
  ]), /Invalid active-context surfacing log/);
  const bounded = context.withSurfacingLog(
    context.emptyActiveContextState("bounded-session"),
    Array.from({ length: context.SURFACING_MAX_LOG_RECORDS + 5 }, (_value, index) => ({
      source: SURFACING_SOURCE, id: `fold_${index}`, score: 0.5, ordinal: index, outcome: "shown",
    })),
  );
  assert.equal(bounded.surfacing.length, context.SURFACING_MAX_LOG_RECORDS);
  assert.equal(bounded.surfacing[0].id, "fold_5");
  assert.equal(context.withSurfacingLog(bounded, []).surfacing, undefined);
  return {
    shownRecords: shownLog.length,
    peekAccepted: true,
    peekDurableEntries: 0,
    expandAccepted: true,
    rejectedAfterWindow: true,
    wireRoundTrip: true,
    malformedRefused: 2,
    boundedLog: bounded.surfacing.length,
  };
}

function normalizedStateDigest(state) {
  const normalized = structuredClone(state);
  // createdAt is a wall clock and was never part of the comparable shape.
  normalized.folds = normalized.folds.map((fold) => ({ ...fold, createdAt: 0 }));
  return context.sha256Value(normalized);
}

function epochSnapshot(built) {
  return context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
    readOnlyContextActions: context.EPOCH_READ_ONLY_CONTEXT_ACTIONS,
  });
}

function toolCall(runtime, params, toolName = "active_context") {
  return runtime.tools.get(toolName).execute(
    `epoch-${params.action}`, params, new AbortController().signal, undefined, runtime.ctx,
  );
}

async function epochToolRuntime(fixture = {}) {
  const built = makeFixture({
    turns: 8, resultChars: 10_000, contextWindow: 100_000, ...fixture,
  });
  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);
  return runtime;
}

/**
 * The identical scripted session both modes must produce, so the immediate-mode
 * digest can be pinned against the pre-scheduling release.
 */
async function scriptedSession(foldScheduling) {
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
    foldScheduling ? { foldScheduling } : {},
  );
  await startRuntime(runtime);
  await measure(runtime, 50_000, 100_000);
  await project(runtime);
  await measure(runtime, 80_000, 100_000);
  await project(runtime);
  await measure(runtime, 88_000, 100_000);
  await project(runtime);
  return runtime;
}

async function gateEpochMarkCommit() {
  const runtime = await epochToolRuntime();
  const rawBytes = bytesOf((await project(runtime)).messages);
  assert.equal([...runtime.tools.values()][0].parameters.properties.action.enum.length, 8);
  await measure(runtime, 80_000, 100_000);
  const marked = materialized(runtime);
  assert.equal(marked.folds.length, 0, "A mark folded evidence");
  assert.equal(marked.pendingMarks.length, 1);
  assert.equal(marked.pendingMarks[0].mark, "fold");
  assert.equal(marked.pendingMarks[0].kind, "tool-result");
  assert.equal(marked.pendingMarks[0].origin, "ladder");

  // The whole point: marking moves no projection byte: the durable projection is
  // still the raw transcript, verbatim. Only the ephemeral advisory tail, appended
  // after the stable prefix, differs, and that channel is cache-neutral by design.
  const markedProjection = await project(runtime);
  const durable = (messages) => messages.filter((message) =>
    typeof message?.customType !== "string" ||
    !message.customType.startsWith(context.DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX));
  assert.equal(
    json.stableStringify(durable(markedProjection.messages)),
    json.stableStringify(runtime.messages),
    "A pending mark changed the projection",
  );

  const status = await toolStatus(runtime);
  const scheduling = status.details.automatic.scheduling;
  assert.equal(scheduling.mode, "epoch");
  assert(scheduling.pending >= 1);
  assert(scheduling.freedWindowShare > 0);
  assert(scheduling.rewriteTokens > 0);
  assert.equal(scheduling.commitDue, false);

  const committed = await toolCall(runtime, { action: "commit" });
  assert(committed.details.applied.length >= 1);
  assert.deepEqual(committed.details.refused, []);
  const after = materialized(runtime);
  assert.equal(after.pendingMarks, undefined);
  assert.equal(after.folds.length, committed.details.applied.length);
  const committedProjection = await project(runtime);
  assert(bytesOf(committedProjection.messages) < rawBytes,
    "The commit epoch did not shrink the projection");

  // A protected span refuses at commit with a message rather than folding.
  const blocked = await epochToolRuntime();
  await measure(blocked, 80_000, 100_000);
  const pending = materialized(blocked).pendingMarks[0];
  const sourceIds = pending.parts.map((part) => part.ref.entryId);
  await toolCall(blocked, { action: "protect", ids: sourceIds });
  const refusal = await toolCall(blocked, { action: "commit" });
  assert.deepEqual(refusal.details.applied, []);
  assert.equal(refusal.details.refused.length, 1);
  assert.match(refusal.details.refused[0].reason, /protected or fresh evidence/);
  assert.equal(materialized(blocked).folds.length, 0);

  return {
    toolActions: 8,
    markedFolds: marked.folds.length,
    pendingAfterMark: marked.pendingMarks.length,
    projectionUnchangedByMark: true,
    committedFolds: after.folds.length,
    pendingAfterCommit: 0,
    protectedRefusals: refusal.details.refused.length,
  };
}

function bytesOf(value) {
  return Buffer.byteLength(json.stableStringify(value), "utf8");
}

// Captured from v0.1.1 (main, 340ac8d) by replaying `scriptedSession()` there. Only a
// deliberate change to immediate-mode behavior may move it.
const IMMEDIATE_SCRIPTED_STATE_DIGEST =
  "95ea5b10be6918027ee2fd877c1f68698c0ae2325aff8799923e42c4dc442e4f";

async function gateImmediateByteIdentity() {
  const runtime = await scriptedSession();
  const state = materialized(runtime);
  assert.equal(state.pendingMarks, undefined, "Immediate mode wrote a pending-marks key");
  const digest = normalizedStateDigest(state);
  assert.equal(digest, IMMEDIATE_SCRIPTED_STATE_DIGEST,
    "Immediate-mode durable state drifted from the pre-scheduling release");

  // No wire event carries the new optional key, and the seven-action surface stands.
  const stateEvents = runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY);
  assert(stateEvents.length >= 1);
  assert(stateEvents.every((entry) => !Object.hasOwn(entry.data, "pendingMarks")));
  assert.deepEqual(
    [...[...runtime.tools.values()][0].parameters.properties.action.enum],
    [...context.ACTIVE_CONTEXT_TOOL_ACTIONS],
  );
  assert.equal([...runtime.tools.values()][0].description.includes("epoch mode"), false);
  const immediateCommit = await toolCall(runtime, { action: "commit" }).catch((error) => error);
  assert.match(String(immediateCommit), /'commit' is not enabled/);

  // The same scripted session in epoch mode reaches a DIFFERENT state, which is the
  // whole point; immediate mode is what must not move.
  const epoch = await scriptedSession("epoch");
  assert.notEqual(normalizedStateDigest(materialized(epoch)), digest);
  return {
    digest,
    pendingMarksKey: "absent",
    stateEvents: stateEvents.length,
    toolActions: context.ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    commitRefusedInImmediateMode: true,
  };
}

async function gateEpochQuotaTopUp() {
  const runtime = await epochToolRuntime({ turns: 14 });
  const built = runtime.built;
  // The agent marks one old batch by hand; the ladder must fill the rest.
  const agentFold = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[0][2]],
    brief: "The completed first inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(agentFold.details.marked, true);
  assert.equal(agentFold.details.scheduling, "epoch");
  const agentMarkId = agentFold.details.id;
  assert.equal(materialized(runtime).pendingMarks.length, 1);
  assert.equal(materialized(runtime).pendingMarks[0].origin, "agent");
  assert.equal(materialized(runtime).pendingMarks[0].briefProvenance.kind, "supplied");

  await measure(runtime, 88_000, 100_000);
  const status = await toolStatus(runtime);
  const epoch = status.details.automatic.lastAutomaticAction.epoch;
  assert.equal(status.details.automatic.lastAutomaticAction.kind, "epoch-commit");
  assert.equal(epoch.agentMarks, 1);
  assert(epoch.ladderMarks >= 1, "The quota top-up added nothing");
  assert(epoch.applied.some((item) => item.id === agentMarkId && item.origin === "agent"));
  assert(epoch.applied.some((item) => item.origin === "ladder"));
  assert.deepEqual(epoch.refused, []);

  // Adjudication visibility: a bound-out top-up or a dropped agent mark must be
  // readable from the epoch record alone, without re-deriving it from applied[].
  for (const key of ["pendingMarks", "agentMarks", "ladderMarks", "peekMarks", "topUpMarks",
    "appliedMarks", "refusedMarks", "freedWindowShare", "estimatedFreedTokens",
    "actualFreedWindowShare", "sourceBytesSaved", "targetWindowShare"]) {
    assert.equal(typeof epoch[key], "number", `epoch accounting is missing ${key}`);
  }
  assert.equal(epoch.appliedMarks, epoch.applied.length);
  assert.equal(epoch.refusedMarks, 0);
  assert.equal(epoch.pendingMarks, epoch.agentMarks + epoch.ladderMarks);
  assert(epoch.topUpMarks >= 1 && epoch.topUpMarks < context.EPOCH_MAX_TOPUP_MARKS);
  // This fixture runs the candidate pool dry before the floor, which is the other
  // legitimate exit; what must never happen silently is the mark CAP binding.
  assert(epoch.freedWindowShare > 0);
  assert(epoch.sourceBytesSaved > 0);
  assert.equal(epoch.targetWindowShare, context.EPOCH_COMMIT_TARGET_WINDOW_SHARE);
  const committed = materialized(runtime);
  assert.equal(committed.pendingMarks, undefined);
  assert.equal(committed.folds.length, epoch.applied.length);

  // Precedence: a quota that is already met adds nothing at all.
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  assert.deepEqual(
    context.topUpMarks({ snapshot, state: empty, ordinal: 1, targetShare: 0 }),
    [],
  );
  const hungry = context.topUpMarks({ snapshot, state: empty, ordinal: 1, targetShare: 1 });
  assert(hungry.length >= 2 && hungry.length <= context.EPOCH_MAX_TOPUP_MARKS);
  assert(hungry.every((mark) => mark.origin === "ladder"));
  assert.equal(new Set(hungry.map((mark) => mark.id)).size, hungry.length);
  return {
    agentMarks: epoch.agentMarks,
    topUpMarks: epoch.topUpMarks,
    freedWindowShare: epoch.freedWindowShare,
    ladderTopUps: epoch.ladderMarks,
    appliedInOneEpoch: epoch.applied.length,
    metQuotaAddsNothing: true,
    hungryTopUps: hungry.length,
    targetWindowShare: context.EPOCH_COMMIT_TARGET_WINDOW_SHARE,
  };
}

async function gateTailAdjacentExemption() {
  const runtime = await epochToolRuntime({ turns: 14 });
  const built = runtime.built;
  const snapshot = epochSnapshot(built);
  const distant = context.manualFoldCandidate(
    snapshot, context.emptyActiveContextState(built.sessionId), [built.turnEntries[0][2]],
  );
  const near = context.manualFoldCandidate(
    snapshot, context.emptyActiveContextState(built.sessionId), [built.turnEntries[10][2]],
  );
  const empty = context.emptyActiveContextState(built.sessionId);
  assert.equal(context.tailAdjacent(snapshot, distant, empty), false);
  assert.equal(context.tailAdjacent(snapshot, near, empty), true);

  // Geometry: the exemption is measured from the FIRST mapped source index, because a
  // positional cache is invalidated from the earliest byte a rewrite touches. A span
  // that ENDS at the tail but reaches back past the window is expensive, not cheap.
  const spanning = {
    kind: "chapter",
    parts: [...distant.parts, ...near.parts],
    sourceRefs: [...distant.sourceRefs, ...near.sourceRefs],
  };
  assert.equal(context.tailAdjacent(snapshot, spanning, empty), false,
    "A span reaching back from the tail was classified by its last index");
  const firstIndex = snapshot.mapped.findIndex((item) =>
    item.ref && json.objectRefKey(item.ref) === json.objectRefKey(spanning.sourceRefs[0]));
  const lastIndex = snapshot.mapped.findIndex((item) =>
    item.ref && json.objectRefKey(item.ref) === json.objectRefKey(spanning.sourceRefs.at(-1)));
  assert(snapshot.mapped.length - 1 - lastIndex <= context.EPOCH_TAIL_ADJACENT_MESSAGES,
    "The spanning fixture does not end inside the exemption window");
  assert(snapshot.mapped.length - 1 - firstIndex > context.EPOCH_TAIL_ADJACENT_MESSAGES,
    "The spanning fixture does not begin outside the exemption window");

  const marked = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[0][2]],
    brief: "The oldest completed inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(marked.details.marked, true);
  const applied = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[10][2]],
    brief: "The recently completed inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(applied.details.marked, undefined, "A tail-adjacent fold was deferred");
  assert.equal(typeof applied.details.id, "string");
  const state = materialized(runtime);
  assert.equal(state.folds.length, 1, "The tail-adjacent fold did not apply immediately");
  assert.equal(state.pendingMarks.length, 1);
  assert.notEqual(state.folds[0].id, state.pendingMarks[0].id);
  return {
    tailAdjacentMessages: context.EPOCH_TAIL_ADJACENT_MESSAGES,
    spanningToTailRefused: true,
    distantMarked: 1,
    tailAdjacentApplied: 1,
    immediateFolds: state.folds.length,
  };
}

async function gateEphemeralPeekMark() {
  const built = makeFixture({
    turns: 10, resultChars: 10_000, contextWindow: 100_000, peekTurns: [0], peekTargetId: "fold_probe",
  });
  const snapshot = epochSnapshot(built);
  const state = context.emptyActiveContextState(built.sessionId);
  const marks = context.ephemeralPeekMarks({ snapshot, state, ordinal: 1 });
  assert.equal(marks.length, 1, "The completed peek read was not marked for the next epoch");
  assert.equal(marks[0].kind, "tool-result");
  // A peek is agent-initiated, so its disposal is an agent mark, not a ladder one.
  assert.equal(marks[0].origin, "agent");
  assert.equal(marks[0].parts.length, 1);
  assert.equal(marks[0].parts[0].ref.entryId, built.turnEntries[0][2]);

  // The agent committed to what it peeked: the read stays raw.
  assert.deepEqual(
    context.ephemeralPeekMarks({
      snapshot, state: { ...state, expanded: ["fold_probe"] }, ordinal: 1,
    }),
    [],
  );

  // Immediate mode never classifies a peek result as a foldable read at all.
  const immediate = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
  });
  assert.deepEqual(context.ephemeralPeekMarks({ snapshot: immediate, state, ordinal: 1 }), []);
  assert.equal(
    context.isReadOnlyContextTool("active_context", { action: "peek", id: "fold_probe" }),
    false,
  );
  assert.equal(
    context.isReadOnlyContextTool(
      "active_context", { action: "peek", id: "fold_probe" }, "active_context",
      context.READ_ONLY_TOOLS_DEFAULT, context.EPOCH_READ_ONLY_CONTEXT_ACTIONS,
    ),
    true,
  );
  assert.equal(
    context.isReadOnlyContextTool(
      "active_context", { action: "peek", id: "x", brief: "no" }, "active_context",
      context.READ_ONLY_TOOLS_DEFAULT, context.EPOCH_READ_ONLY_CONTEXT_ACTIONS,
    ),
    false,
  );

  // End to end: the commit epoch folds the peek read without being asked.
  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);
  const committed = await toolCall(runtime, { action: "commit" });
  assert.equal(committed.details.applied.length, 1);
  assert.equal(committed.details.applied[0].origin, "agent");
  assert.equal(committed.details.agentMarks, 1);
  assert.equal(committed.details.ladderMarks, 0);
  assert.equal(committed.details.peekMarks, 1);
  const folded = materialized(runtime);
  assert.equal(folded.folds.length, 1);
  assert.equal(folded.folds[0].kind, "tool-result");
  return {
    peekMarks: marks.length,
    peekMarkOrigin: marks[0].origin,
    expandedPeekExempt: true,
    immediateModePeekMarks: 0,
    autoFoldedOnCommit: committed.details.applied.length,
  };
}

async function gateCommitOnThreshold() {
  const runtime = await epochToolRuntime({ turns: 12 });
  await measure(runtime, 78_000, 100_000);
  const belowStatus = await toolStatus(runtime);
  assert.equal(belowStatus.details.automatic.lastAutomaticAction.kind, "mark");
  assert.equal(belowStatus.details.automatic.scheduling.commitDue, false);
  assert.equal(
    belowStatus.details.automatic.scheduling.commitRatio,
    context.ACTIVE_CONTEXT_POLICY.refoldRatio,
  );
  assert.equal(materialized(runtime).folds.length, 0);
  const marksBelow = materialized(runtime).pendingMarks.length;
  assert(marksBelow >= 1);

  // Crossing the ladder's own refold/consolidation rung is the commit trigger; no
  // new threshold was introduced for scheduling.
  await measure(runtime, 86_000, 100_000);
  const aboveStatus = await toolStatus(runtime);
  assert.equal(aboveStatus.details.automatic.lastAutomaticAction.kind, "epoch-commit");
  assert.equal(aboveStatus.details.automatic.scheduling.commitDue, true);
  assert.equal(aboveStatus.details.automatic.scheduling.pending, 0);
  const committed = materialized(runtime);
  assert.equal(committed.pendingMarks, undefined);
  assert(committed.folds.length >= marksBelow);
  assert.equal(
    aboveStatus.details.automatic.lastAutomaticAction.epoch.trigger,
    "window-pressure",
  );

  // An expand with marks pending opens the epoch, so the restore plus the batch of
  // folds cost one rewrite rather than two.
  const rider = await epochToolRuntime({ turns: 12 });
  await measure(rider, 78_000, 100_000);
  const pendingId = materialized(rider).pendingMarks[0].id;
  await toolCall(rider, { action: "commit" });
  const target = materialized(rider).folds[0].id;
  await toolCall(rider, { action: "fold", ids: [rider.built.turnEntries[1][2]],
    brief: "A second completed inspection is stale and its exact output stays recoverable." });
  assert.equal(materialized(rider).pendingMarks.length, 1);
  const expanded = await toolCall(rider, { action: "expand", id: target });
  assert.equal(expanded.details.committedMarks.length, 1);
  assert.equal(materialized(rider).pendingMarks, undefined);
  assert(materialized(rider).expanded.includes(target));
  return {
    markedBelowThreshold: marksBelow,
    commitRatio: context.ACTIVE_CONTEXT_POLICY.refoldRatio,
    foldsAfterCommit: committed.folds.length,
    firstMark: pendingId.startsWith("fold_"),
    expandRidesCommit: true,
  };
}

async function gateSchedulingWireRoundTrip() {
  const built = makeFixture({ turns: 10, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  const marks = context.topUpMarks({ snapshot, state: empty, ordinal: 3, targetShare: 1 }).slice(0, 2);
  assert.equal(marks.length, 2);
  const state = context.withPendingMarks(empty, marks);
  assert.equal(state.pendingMarks.length, 2);

  const parsed = context.parseActiveContextState(state, built.sessionId);
  assert.deepEqual(parsed.pendingMarks, state.pendingMarks);
  const checkpoint = context.makeStateCheckpoint(state);
  assert.deepEqual(checkpoint.pendingMarks, state.pendingMarks);
  const restored = context.stateFromFoldRefs(checkpoint, checkpoint.foldRefs, new Map());
  assert.deepEqual(restored.pendingMarks, state.pendingMarks);
  const delta = context.makeStateDelta(empty, { ...state, revision: 1 });
  assert.deepEqual(delta.pendingMarks, state.pendingMarks);
  assert.equal(context.semanticStateSha256(restored), context.semanticStateSha256(state));

  // Empty is absent everywhere, so a pre-0.1.2 digest never moves.
  const cleared = context.withPendingMarks(state, []);
  assert.equal(cleared.pendingMarks, undefined);
  assert.equal(Object.hasOwn(context.makeStateCheckpoint(cleared), "pendingMarks"), false);
  assert.equal(context.semanticStateSha256(cleared), context.semanticStateSha256(empty));

  assert.throws(() => context.parsePendingMarks([{ ...marks[0], origin: "someone" }]),
    /Invalid active-context pending marks/);
  assert.throws(() => context.parsePendingMarks([{ ...marks[0], id: "fold_wrong" }]),
    /Invalid active-context pending marks/);
  assert.throws(() => context.parsePendingMarks([marks[0], structuredClone(marks[0])]),
    /Invalid active-context pending marks/);
  assert.throws(() => context.parseActiveContextState(
    { ...state, pendingMarks: [{ mark: "refold", id: "fold_missing", origin: "agent", ordinal: 1 }] },
    built.sessionId,
  ), /Invalid active-context pending marks/);
  assert.throws(() => context.parsePendingMarks(
    Array.from({ length: context.MAX_PENDING_MARKS + 1 }, () => marks[0]),
  ), /Invalid active-context pending marks/);

  // A mark whose evidence left the branch cannot survive projection.
  const projected = context.persistenceProjection(state, context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: [],
    contextEntries: [],
    contextWindow: built.contextWindow,
    readOnlyContextActions: context.EPOCH_READ_ONLY_CONTEXT_ACTIONS,
  }));
  assert.equal(projected.pendingMarks, undefined);
  return {
    marks: marks.length,
    checkpointRoundTrip: true,
    deltaRoundTrip: true,
    emptyOmitted: true,
    malformedRefused: 5,
    unmappedMarksDropped: true,
  };
}

/**
 * Below the commit threshold every eligible turn must mark NEW stale content. If the
 * selector cannot see the pending marks it re-proposes the batch already marked,
 * `addPendingMark` rejects the duplicate, and the epoch arrives with one mark and a
 * top-up doing all the work. That collapse is what this gate measures.
 */
async function gateMarkAccumulation() {
  const runtime = await epochToolRuntime({ turns: 40 });
  const growth = [];
  for (const tokens of [76_000, 78_000, 80_000, 82_000, 84_000]) {
    await measure(runtime, tokens, 100_000);
    growth.push(materialized(runtime).pendingMarks?.length ?? 0);
  }
  const marks = materialized(runtime).pendingMarks;
  assert(marks.length > 3, `Pending marks stalled at ${marks.length}; the selector re-proposed a marked batch`);
  assert.equal(new Set(marks.map((mark) => mark.id)).size, marks.length, "A mark was recorded twice");
  assert.deepEqual([...growth].sort((left, right) => left - right), growth, "Marks did not grow monotonically");
  assert.equal(growth.at(-1) - growth[0], growth.length - 1, "Marks did not grow one per eligible turn");
  // Marking is still byte-free: nothing folded on the way here.
  assert.equal(materialized(runtime).folds.length, 0);
  const claimed = context.claimedRefKeys(materialized(runtime));
  assert.equal(
    context.selectAutomaticToolBatch(epochSnapshot(runtime.built), materialized(runtime), 1, claimed)
      .some((candidate) => candidate.sourceRefs.some((ref) => claimed.has(json.objectRefKey(ref)))),
    false,
    "The selector still returns evidence a pending mark covers",
  );

  // At the commit the accumulated marks, not the top-up floor, do most of the freeing.
  await measure(runtime, 86_000, 100_000);
  const status = await toolStatus(runtime);
  const epoch = status.details.automatic.lastAutomaticAction.epoch;
  assert.equal(epoch.refusedMarks, 0);
  assert.equal(epoch.appliedMarks, epoch.pendingMarks);
  assert(epoch.pendingMarks > epoch.topUpMarks, "The top-up out-marked the accumulated epoch");
  assert(epoch.freedWindowShare >= context.EPOCH_COMMIT_TARGET_WINDOW_SHARE,
    "A full epoch freed less than the top-up floor alone");
  assert(epoch.appliedMarks >= marks.length + 1,
    "The accumulated marks did not all reach the commit");
  assert.equal(materialized(runtime).pendingMarks, undefined);
  return {
    growth,
    accumulatedMarks: marks.length,
    appliedMarks: epoch.appliedMarks,
    topUpMarks: epoch.topUpMarks,
    freedWindowShare: epoch.freedWindowShare,
    actualFreedWindowShare: epoch.actualFreedWindowShare,
  };
}

/**
 * Above the commit threshold we are already inside the epoch's rewrite turn, so every
 * inline rung stays reachable. Restricting the inline selection to prepared chapters
 * stranded the refold rung: a session whose reducible bytes sat in expanded folds
 * re-committed forever without ever re-collapsing one.
 */
async function gateEpochInlineRungs() {
  const wide = await epochToolRuntime({ turns: 40 });
  await measure(wide, 86_000, 100_000);
  const first = (await toolStatus(wide)).details.automatic.lastAutomaticAction;
  assert.equal(first.kind, "tool-fold", "The inline rung did not run inside the epoch's rewrite turn");
  assert.equal(typeof first.epoch, "object", "The inline rung replaced the epoch commit instead of riding it");

  const runtime = await epochToolRuntime({ turns: 12 });
  await measure(runtime, 86_000, 100_000);
  const target = materialized(runtime).folds[0].id;
  await toolCall(runtime, { action: "expand", id: target });
  assert(materialized(runtime).expanded.includes(target));
  let kinds = [];
  for (let step = 0; step < 12; step += 1) {
    await measure(runtime, 86_000 + step * 100, 100_000);
    const action = (await toolStatus(runtime)).details.automatic.lastAutomaticAction;
    kinds.push(action.kind);
    if (action.kind === "refold") break;
  }
  assert.equal(kinds.at(-1), "refold", `The refold rung never fired in epoch mode: ${kinds.join(",")}`);
  assert.equal(materialized(runtime).expanded.includes(target), false);

  // The mark-side branch for a refold selection maps to a refold mark, not a fold one.
  const snapshot = epochSnapshot(runtime.built);
  const refoldMark = context.ladderSelectionMark({
    snapshot,
    state: materialized(runtime),
    selection: { kind: "refold", foldId: target },
    ordinal: 7,
  });
  assert.deepEqual(refoldMark, { mark: "refold", id: target, origin: "ladder", ordinal: 7 });
  const claimedFolds = context.markedFoldIds(context.withPendingMarks(
    materialized(runtime), [refoldMark],
  ));
  assert.equal(claimedFolds.has(target), true);
  return {
    inlineRungInsideEpoch: first.kind,
    stepsToRefold: kinds.length,
    refoldRungReached: true,
    refoldMarkMapped: true,
  };
}

/**
 * `withSurfacingLog` must rebuild the record in canonical key order. Assigning
 * `.surfacing` onto a spread of a state that had no surfacing key lands it after
 * pendingMarks/advisory/prepared, and the stable-stringify digest then drifts from
 * the parsed replay of the same state.
 */
async function gateSurfacingKeyOrder() {
  const built = makeFixture({ turns: 10, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  const marks = context.topUpMarks({ snapshot, state: empty, ordinal: 3, targetShare: 1 }).slice(0, 2);
  const withMarks = context.withPendingMarks(empty, marks);
  assert.equal(Object.hasOwn(withMarks, "surfacing"), false, "The fixture already carries a surfacing key");
  const record = { source: "ladder", id: marks[0].id, score: 0.9, ordinal: 3, outcome: "shown" };
  const logged = context.withSurfacingLog(withMarks, [record]);
  assert.deepEqual(Object.keys(logged).filter((key) => key === "surfacing" || key === "pendingMarks"),
    ["surfacing", "pendingMarks"], "withSurfacingLog appended surfacing after pendingMarks");
  assert.deepEqual(
    Object.keys(logged),
    Object.keys(context.parseActiveContextState(logged, built.sessionId)),
    "withSurfacingLog produced a non-canonical key order",
  );
  assert.equal(
    context.semanticStateSha256(logged),
    context.semanticStateSha256(context.parseActiveContextState(logged, built.sessionId)),
    "A surfacing write drifted the replay digest",
  );
  assert.deepEqual(logged.pendingMarks, withMarks.pendingMarks);
  const cleared = context.withSurfacingLog(logged, []);
  assert.equal(cleared.surfacing, undefined);
  assert.equal(context.semanticStateSha256(cleared), context.semanticStateSha256(withMarks));
  return {
    canonicalKeyOrder: Object.keys(logged).join(","),
    digestStable: true,
    clearedRoundTrip: true,
  };
}

const gates = [
  [1, "Registration & parse", gateRegistration],
  [2, "Fold lattice & recovery", gateFoldLattice],
  [3, "Autonomous ladder", gateAutonomousLadder],
  [4, "Advisory milestones", gateAdvisoryMilestones],
  [5, "F1 regression (overflow)", gateOverflowRegression],
  [6, "F2 regression (legacy luna)", gateLegacyLunaRegression],
  [7, "F3 regression (poisoned floor)", gatePoisonedFloorRegression],
  [8, "Historical tolerance", gateHistoricalTolerance],
  [9, "Compaction policy", gateCompactionPolicy],
  [10, "Persistence chain", gatePersistenceChain],
  [11, "B1 cadence tool folds", gateCadenceToolFolds],
  [12, "B2 expand leases", gateExpandLeases],
  [13, "B3 width consolidation", gateWidthConsolidation],
  [14, "B4 quiet warming", gateQuietWarming],
  [15, "B5 fold_candidates detail", gateFoldCandidatesDetail],
  [16, "B6 blocking-tool harvest", gateBlockingToolHarvest],
  [17, "Phase-B wire forward/backward note", gateWireForwardBackwardNote],
  [18, "Follow-up fences & stale anchors", gateFollowupFencesAndAnchors],
  [19, "Fresh-tail share cap", gateFreshTailShareCap],
  [20, "Neutral default branding", gateNeutralDefaultBranding],
  [21, "Legacy branding reproduction", gateLegacyBrandingReproduction],
  [22, "Evidence ingestion switch", gateEvidenceIngestionSwitch],
  [23, "Summarizer option", gateSummarizerOption],
  [24, "Guidance profiles", gateGuidanceProfiles],
  [25, "Peek and fold index", gatePeekAndFoldIndex],
  [26, "Surfacing selector", gateSurfacingSelector],
  [27, "Surfacing threshold & budget", gateSurfacingThresholdAndBudget],
  [28, "Surfacing hysteresis", gateSurfacingHysteresis],
  [29, "Surfacing carrier ephemerality", gateSurfacingCarrier],
  [30, "Suggestion-source hook", gateSuggestionSourceHook],
  [31, "Surfacing accept/reject logging", gateSurfacingLogging],
  [32, "Epoch mark/commit lifecycle", gateEpochMarkCommit],
  [33, "Immediate-mode byte identity", gateImmediateByteIdentity],
  [34, "Epoch quota top-up", gateEpochQuotaTopUp],
  [35, "Tail-adjacent exemption", gateTailAdjacentExemption],
  [36, "Ephemeral peek auto-mark", gateEphemeralPeekMark],
  [37, "Commit on threshold", gateCommitOnThreshold],
  [38, "Scheduling wire round-trip", gateSchedulingWireRoundTrip],
  [39, "Epoch mark accumulation", gateMarkAccumulation],
  [40, "Epoch inline rung reachability", gateEpochInlineRungs],
  [41, "Surfacing key-order digest stability", gateSurfacingKeyOrder],
];

let failures = 0;
for (const [number, name, run] of gates) {
  try {
    const details = await run();
    process.stdout.write(`GATE ${String(number).padStart(2, "0")} ${name}: PASS ${json.stableStringify(details)}\n`);
  } catch (error) {
    failures += 1;
    process.stderr.write(`GATE ${String(number).padStart(2, "0")} ${name}: FAIL\n`);
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
}

process.stdout.write(`SUMMARY: ${failures === 0 ? "PASS" : "FAIL"} (${gates.length - failures}/${gates.length} gates)\n`);
if (failures) process.exitCode = 1;
