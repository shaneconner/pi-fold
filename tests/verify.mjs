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
    "quorum-context-event",
    "quorum-native-compaction-decision",
    "quorum-native-compaction-receipt",
    "quorum-provider-context-measurement",
  ]),
  projectionTypes: Object.freeze([
    "quorum-active-context-advisory",
    "quorum-active-context-milestone",
  ]),
  receiptType: "quorum-active-context-receipts",
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
  advisoryText: "[Quorum context advisory] pressure 80%; milestone tools; headroom 10000 of 90000 tokens; unmarked share 100%; 0 pending mark(s), 0 eligible now, together freeing about 0 tokens of the 0 marked; eligible read-only batch endpoints: none; eligibleChapter endpoints: none; session milestone count: 0.",
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
  resultTail = null,
  readArguments = null,
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
          arguments: peek
            ? { action: "peek", id: peekTargetId }
            : (readArguments ? readArguments(turn) : { path: `file-${turn}.txt` }),
        }],
        stopReason: "toolUse",
        timestamp: sequence,
      }));
      ids.push(add({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: peek ? "active_context" : "read",
        content: [{
          type: "text",
          text: `Result ${turn}: ${"r".repeat(resultChars)}${resultTail ? ` ${resultTail(turn)}` : ""}`,
        }],
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
  foldPeekResults,
  guidedCuration,
  providerTotalWindow,
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
    ...(foldPeekResults === undefined ? {} : { foldPeekResults }),
    ...(guidedCuration === undefined ? {} : { guidedCuration }),
    ...(providerTotalWindow === undefined ? {} : { providerTotalWindow }),
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

function measuredAssistant(tokens, contextWindow, suffix = "measurement", stopReason = "stop") {
  return {
    role: "assistant",
    stopReason,
    content: [{ type: "text", text: suffix }],
    provider: "openai-codex",
    model: "gpt-test",
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
    timestamp: tokens,
    contextWindow,
  };
}

async function measure(runtime, tokens, contextWindow = runtime.usage.contextWindow, suffix, stopReason) {
  runtime.usage = { tokens, contextWindow };
  const message = runtime.appendMessage(
    measuredAssistant(
      tokens,
      contextWindow,
      suffix ?? `measurement-${tokens}-${runtime.branch.length}`,
      stopReason,
    ),
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

/** Adjacent chapters small enough that merging several stays inside the bite-size cap. */
async function smallChapterForest(count) {
  const built = makeFixture({
    turns: Math.max(16, count + 10),
    tools: false,
    chapterChars: 900,
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
    "pi-fold-context-event",
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
  // The budget is spent on DELIVERY, so an advisory that reached the agent releases
  // its arm and does not replay on the next projection of the same plateau.
  const repeatedProjection = await project(jump);
  const repeatedMilestone = repeatedProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-milestone");
  assert.equal(repeatedMilestone, undefined,
    "A delivered milestone replayed on the next projection of the same plateau");
  let jumpStatus = await toolStatus(jump);
  assert.deepEqual(jumpStatus.details.automatic.advisory.delivered, { chapters: 1 });
  assert.equal(jumpStatus.details.automatic.advisory.armed, undefined);
  jump.usage = { tokens: 233_920, contextWindow: 100_000 };
  const changedWindowProjection = await project(jump);
  const changedWindowMilestone = changedWindowProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-milestone");
  assert.equal(changedWindowMilestone, undefined,
    "A delivered milestone re-armed when the reported window changed");

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
  // The budget is spent where the advisory REACHES the agent, so the second delivery
  // is counted by the projection that carries it, not by the measurement that armed it.
  const rearmed = await project(jump);
  assert(rearmed.messages.some((message) =>
    message.customType === "pi-fold-active-context-milestone"),
  "The re-armed rung did not deliver a second advisory");
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
  await project(reloaded);
  // Deliveries are durable: a reload carries the spent budget and does not replay.
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
  const durableEntries = (entries) => entries.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event"));
  const branchBefore = json.stableStringify(durableEntries(runtime.branch));
  const appendedBefore = durableEntries(runtime.appended).length;
  const status = await toolStatus(runtime, "active_context", "fold_candidates");
  assert.equal(json.stableStringify(status.details.candidates), json.stableStringify(expected));
  assert.equal(status.details.automatic.measurementFresh, false);
  assert.equal(status.details.candidates.wouldFireNow, null);
  assert.equal(status.details.candidates.blockedBy, "measurement-stale");
  assert(status.details.candidates.tool, "Stale-measurement fixture lacked an otherwise eligible rung");
  // Every context-management call is recorded in the durable event stream by design,
  // so the property under test is that nothing else moved: no state event, no fold
  // record, no projection change.
  assert.equal(json.stableStringify(durableEntries(runtime.branch)), branchBefore);
  assert.equal(durableEntries(runtime.appended).length, appendedBefore);
  assert(runtime.appended.some((entry) => entry.customType === "pi-fold-context-event"),
    "A status call was not recorded in the context-event stream");
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
  // The object list lives behind its own paged query now that the index is dieted.
  const smallObjects = (await toolStatus(small, undefined, "objects")).details.objects;
  const wideObjects = (await toolStatus(wide, undefined, "objects")).details.objects;

  // Behavioral: identical content, small window → the three oldest turns escape
  // the capped tail and form an eligible chapter; wide window → the uncapped
  // floor covers the whole projection and nothing is foldable.
  const smallFree = smallObjects.filter((object) => !object.protected).length;
  const wideFree = wideObjects.filter((object) => !object.protected).length;
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
      'Closed chapters fold from the eligibleChapter endpoints in active_context {"action":"status"}; ' +
      'active_context {"action":"fold","ids":["<start>","<end>"],"brief":"<factual brief>"} folds one with ' +
      "your own brief instead of a generated one.",
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
  // REACTIVE framing: every dosage reports what is happening and names the actions that
  // change it. None of them asks the agent to fold proactively, because the runtime
  // folds either way and advice it can only take by interrupting its own task is noise.
  assert(curationTexts.notice.includes("the ladder is folding stale spans as it fills"));
  assert(curationTexts.notice.includes(
    'active_context {"action":"fold","marks":[{"ids":["<start>","<end>"],"brief":"<factual brief>"}]}'));
  assert(curationTexts.notice.includes("Continuing the task is the default"));
  assert(curationTexts.tools.includes("what the ladder reclaims first"));
  assert(curationTexts.tools.includes('{"action":"rebrief","id":"<fold-id>","brief":"<factual brief>"}'));
  assert(curationTexts.chapters.includes("the next thing the ladder consolidates"));
  assert(curationTexts.chapters.includes(
    '{"action":"fold","ids":["<fold-id>","<fold-id>"],"brief":"<factual brief>"}'));
  assert(curationTexts.chapters.includes("leaving the oldest material deepest and still exactly recoverable"));
  assert(curationTexts.chapters.includes('{"action":"reboundary","ids":["<start>","<end>"]}'));
  assert(Object.values(curationTexts).every((text) => !text.includes("\u2014")));
  // Nothing in any dosage tells the agent to fold, and nothing asks it a question.
  for (const [milestone, text] of Object.entries(curationTexts)) {
    assert.equal(/\?/.test(text), false, `The ${milestone} dosage asks a question`);
    assert.equal(/^\[[^\]]+\]\s+(?:Fold|Curate|Please)\b/.test(text), false,
      `The ${milestone} dosage opens with an instruction rather than a report`);
  }
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
  const durableEntries = (entries) => entries.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event"));
  const branchBefore = json.stableStringify(durableEntries(runtime.branch));
  const appendedBefore = durableEntries(runtime.appended).length;
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
  assert.equal(json.stableStringify(durableEntries(runtime.branch)), branchBefore);
  assert.equal(durableEntries(runtime.appended).length, appendedBefore);

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
  assert(bounded.sourceBytes > context.PEEK_DEFAULT_MAX_BYTES);
  // The DEFAULT read is the bounded index view: head and tail, with the omitted
  // middle stated, because a head-only bound drops exactly where conclusions live.
  assert.equal(bounded.returnedBytes, context.PEEK_DEFAULT_MAX_BYTES);
  assert.equal(bounded.view, "index");
  assert(bounded.omittedBytes > 0);
  assert.equal(bounded.source.startsWith(complete.slice(0, 100)), true);
  assert(bounded.source.includes(`[${bounded.omittedBytes} exact source bytes omitted]`));
  assert(bounded.source.endsWith(complete.slice(-100)), "A default peek dropped the tail");
  assert(bounded.note.startsWith("Bounded read:"));
  assert(bounded.note.includes(String(bounded.sourceBytes)));
  // A bounded peek must name the WIDER read and repeat the continuation AFTER the
  // source bytes, where the reader decides its next action; a complete peek carries
  // neither. The head-and-tail view means there is no separate tail read to offer.
  assert.deepEqual(bounded.wider, {
    action: "peek",
    id: oversized.prepared.id,
    bytes: Math.min(bounded.sourceBytes, context.ACTIVE_CONTEXT_POLICY.maxChapterChars),
  });
  assert(bounded.truncationReminder.startsWith("STOP:"));
  assert(bounded.truncationReminder.includes(String(bounded.omittedBytes)));
  assert(bounded.truncationReminder.includes("the head and tail are both above"));
  assert.equal(Object.keys(bounded).indexOf("truncationReminder"), Object.keys(bounded).length - 1);
  assert(Object.keys(bounded).indexOf("source") === Object.keys(bounded).length - 2);
  assert.equal(peek.details.wider, undefined);
  assert.equal(peek.details.truncationReminder, undefined);

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
  const appendedBefore = runtime.appended.filter((entry) =>
    entry.customType !== "pi-fold-context-event").length;
  const again = await project(runtime);
  assert.equal(surfacingCarrier(again).length, 1);
  assert.equal(json.stableStringify(surfacingCarrier(again)), json.stableStringify(carrier));
  assert.equal(runtime.appended.filter((entry) =>
    entry.customType !== "pi-fold-context-event").length, appendedBefore);

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

  // Peek is the accept signal and stays ephemeral: no durable STATE entry of its own.
  // The context-event stream still records the attempt, which is the whole point of it.
  const durableBefore = runtime.branch.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event")).length;
  await runtime.tools.get("active_context").execute(
    "peek-suggested", { action: "peek", id: target }, new AbortController().signal, undefined, runtime.ctx,
  );
  assert.equal(runtime.branch.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event")).length, durableBefore);
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
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
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
async function scriptedSession(foldScheduling, extra = {}) {
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
    { ...(foldScheduling ? { foldScheduling } : {}), ...extra },
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
  assert.deepEqual([...[...runtime.tools.values()][0].parameters.properties.action.enum],
    [...context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS]);
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
  assert.match(refusal.details.refused[0].reason, /still fresh or protected/);
  assert.equal(materialized(blocked).folds.length, 0);

  return {
    toolActions: context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.length,
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

// Recaptured at the lever collapse (0333f13) by replaying `scriptedSession()`. It moved
// once, deliberately: stage-identified briefs and ephemeral peek are unconditional now,
// and both are part of the durable fold record and the projection. The pin's JOB is
// unchanged -- immediate mode is a fixed point that no later change may drift -- and
// only a deliberate change to immediate-mode behaviour may move it again.
// The v0.1.1 value was 95ea5b10be6918027ee2fd877c1f68698c0ae2325aff8799923e42c4dc442e4f.
const IMMEDIATE_SCRIPTED_STATE_DIGEST =
  "35518fbd949c8744ac561682304bd797d9665491bbabfe4443898b8dc62f0e6e";

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
  // The freeing target is the thermostat's: at least the standing floor, and deeper
  // when occupancy is above the lower line the commit is folding down to.
  assert(epoch.targetWindowShare >= context.EPOCH_COMMIT_TARGET_WINDOW_SHARE);
  assert.equal(epoch.targetWindowShare, Math.max(
    context.EPOCH_COMMIT_TARGET_WINDOW_SHARE, epoch.hysteresisTargetShare));
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

/**
 * Mark always means mark.
 *
 * Epoch mode once folded a tail-adjacent span inline, on the reasoning that a span
 * within a few messages of the tail invalidates almost nothing. Retained marks made
 * that special case incoherent: "fold" sometimes meant "fold now" and sometimes meant
 * "decide now, apply later", and which one you got depended on arithmetic the caller
 * could not see. The exemption is gone, and this pins its absence.
 */
async function gateMarkAlwaysMeansMark() {
  const runtime = await epochToolRuntime({ turns: 14 });
  const built = runtime.built;

  const distant = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[0][2]],
    brief: "The oldest completed inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(distant.details.marked, true);
  const near = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[10][2]],
    brief: "The recently completed inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(near.details.marked, true, "A tail-adjacent span still folded inline");
  const state = materialized(runtime);
  assert.equal(state.folds.length, 0, "A fold landed without a commit");
  assert.equal(state.pendingMarks.length, 2);

  // And the geometry the exemption used is gone from the surface entirely, so nothing
  // can reinstate it by reading a constant that still exists.
  assert.equal(context.tailAdjacent, undefined, "The tail-adjacent exemption is still callable");
  assert.equal(context.EPOCH_TAIL_ADJACENT_MESSAGES, undefined);
  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(Object.hasOwn(scheduling, "tailAdjacentMessages"), false);

  const committed = await toolCall(runtime, { action: "commit" });
  assert.equal(committed.details.applied.length, 2, "One commit did not apply both marks");
  assert.equal(materialized(runtime).pendingMarks, undefined);
  return {
    distantMarked: true,
    tailAdjacentMarked: true,
    foldsBeforeCommit: state.folds.length,
    appliedInOneCommit: committed.details.applied.length,
  };
}

/**
 * A transcript whose only bulk is peek output. Immediate mode classifies no peek batch
 * as a foldable read, so the ladder is STARVED: it measures the pressure and has nothing
 * to take. The override hands it exactly that supply back.
 */
function peekOnlyFixture() {
  return makeFixture({
    turns: 8,
    resultChars: 10_000,
    contextWindow: 100_000,
    peekTurns: [0, 1, 2, 3, 4, 5, 6, 7],
    peekTargetId: "fold_probe",
  });
}

async function climb(runtime) {
  await measure(runtime, 10_000, 100_000);
  await measure(runtime, 20_000, 100_000);
  await measure(runtime, 40_000, 100_000);
  await measure(runtime, 60_000, 100_000);
  await measure(runtime, 80_000, 100_000);
  return materialized(runtime);
}

async function gatePeekFoldOverride() {
  // Stock immediate mode: every rung sees the same pressure and cannot act.
  const starved = makeRuntime(peekOnlyFixture());
  await startRuntime(starved);
  const starvedState = await climb(starved);
  assert.equal(starvedState.folds.length, 0,
    "Stock immediate mode folded a peek batch it does not classify as a read");
  const starvedStatus = await toolStatus(starved);
  assert.equal(starvedStatus.details.automatic.foldPeekResults, false);
  assert(starvedStatus.details.automatic.pressureRatio >= 0.75,
    "The starved fixture never reached the tool-fold rung");

  // Same transcript, same measurements, override on: the rung now has supply.
  const built = peekOnlyFixture();
  const runtime = makeRuntime(built, { foldPeekResults: true });
  await startRuntime(runtime);
  const state = await climb(runtime);
  assert(state.folds.length >= 1, "The override left the ladder starved");
  assert(state.folds.every((fold) => fold.kind === "tool-result"));
  const peekResultIds = new Set(built.turnEntries.map((ids) => ids[2]));
  const sources = state.folds.flatMap((fold) => fold.parts.map((part) => part.ref.entryId));
  assert(sources.length >= 1 && sources.every((id) => peekResultIds.has(id)),
    "A fold reclaimed something other than a peek result");
  const status = await toolStatus(runtime);
  assert.equal(status.details.automatic.foldPeekResults, true);

  // Onset, not just eventual behavior: the first measurement that authorizes a tool
  // fold under the override still authorizes nothing without it.
  const early = makeRuntime(peekOnlyFixture(), { foldPeekResults: true });
  await startRuntime(early);
  await measure(early, 10_000, 100_000);
  await measure(early, 40_000, 100_000);
  const earlyState = materialized(early);
  assert.equal(earlyState.folds.length, 1, "The override did not act at the cadence rung");

  const earlyStarved = makeRuntime(peekOnlyFixture());
  await startRuntime(earlyStarved);
  await measure(earlyStarved, 10_000, 100_000);
  await measure(earlyStarved, 40_000, 100_000);
  assert.equal(materialized(earlyStarved).folds.length, 0);

  // Only booleans configure it; a truthy string is a misconfiguration, not an opt-in.
  assert.throws(
    () => makeRuntime(peekOnlyFixture(), { foldPeekResults: "true" }),
    /foldPeekResults must be a boolean/,
  );

  const reclaimed = state.folds.reduce((total, fold) => total + fold.sourceChars, 0);
  const spent = state.folds.reduce((total, fold) => total + fold.placeholderChars, 0);
  return {
    starvedFolds: starvedState.folds.length,
    overrideFolds: state.folds.length,
    onsetFoldsWithOverride: earlyState.folds.length,
    onsetFoldsWithout: 0,
    reclaimedChars: reclaimed,
    placeholderChars: spent,
    nonBooleanRefused: true,
  };
}

async function gatePeekFoldOverrideAbsence() {
  // Absent and explicitly false are the same deployment, byte for byte, and both are
  // the digest gate 33 pins to the pre-scheduling release.
  const absent = await scriptedSession();
  const disabled = await scriptedSession(undefined, { foldPeekResults: false });
  const digest = normalizedStateDigest(materialized(absent));
  assert.equal(normalizedStateDigest(materialized(disabled)), digest,
    "An explicit foldPeekResults:false diverged from the stock deployment");
  assert.equal(digest, IMMEDIATE_SCRIPTED_STATE_DIGEST,
    "The peek-fold option moved the immediate-mode durable state");
  assert.equal(
    json.stableStringify((await project(absent)).messages),
    json.stableStringify((await project(disabled)).messages),
    "An explicit foldPeekResults:false changed the projection",
  );
  assert.deepEqual(
    [...[...disabled.tools.values()][0].parameters.properties.action.enum],
    [...context.ACTIVE_CONTEXT_TOOL_ACTIONS],
    "The peek-fold option changed the tool surface",
  );

  // A transcript that the override WOULD change is unchanged without it: absence is
  // proved on the sensitive fixture, not only on one that has no peeks in it.
  const sensitive = makeRuntime(peekOnlyFixture(), { foldPeekResults: false });
  await startRuntime(sensitive);
  assert.equal((await climb(sensitive)).folds.length, 0);

  // Epoch scheduling still carries peek foldability with it; the option is the way
  // immediate mode reaches the same classification, not a second switch on top of it.
  const epoch = makeRuntime(peekOnlyFixture(), { foldScheduling: "epoch" });
  await startRuntime(epoch);
  assert.equal((await toolStatus(epoch)).details.automatic.foldPeekResults, true);
  const epochOff = makeRuntime(peekOnlyFixture(), {
    foldScheduling: "epoch", foldPeekResults: false,
  });
  await startRuntime(epochOff);
  assert.equal((await toolStatus(epochOff)).details.automatic.foldPeekResults, false);
  return {
    digest,
    absentEqualsDisabled: true,
    sensitiveFixtureFolds: 0,
    epochDefault: true,
    epochOverridable: true,
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
      context.READ_ONLY_TOOLS_DEFAULT, context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
    ),
    true,
  );
  assert.equal(
    context.isReadOnlyContextTool(
      "active_context", { action: "peek", id: "x", brief: "no" }, "active_context",
      context.READ_ONLY_TOOLS_DEFAULT, context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
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

function peekSnapshot(built, { messages = built.messages } = {}) {
  return context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: messages,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
  });
}

function advisoryMessages(projection) {
  return projection.messages.filter((message) =>
    typeof message?.customType === "string" && message.customType.endsWith("-advisory"));
}

async function runAdvisorySession(options) {
  const runtime = makeRuntime(
    makeFixture({ turns: 12, resultChars: 9_000, contextWindow: 272_000 }),
    options,
  );
  await startRuntime(runtime);
  const advisories = [];
  for (const tokens of [40_000, 140_000, 200_000, 210_000, 220_000, 235_000, 240_000, 245_000]) {
    await measure(runtime, tokens, 272_000);
    advisories.push(...advisoryMessages(await project(runtime)));
  }
  return { runtime, advisories };
}

async function gateProjectionInstrumentation() {
  // The comparison itself. A pure append leaves the whole previous prefix intact,
  // which is exactly the condition under which a positional cache should hit.
  const base = ["a", "b", "c"];
  assert.deepEqual(context.compareProjections(base, ["a", "b", "c"]), {
    change: "identical", previousCount: 3, nextCount: 3, appendedCount: 0, firstDivergentIndex: null,
  });
  assert.deepEqual(context.compareProjections(base, ["a", "b", "c", "d"]), {
    change: "append", previousCount: 3, nextCount: 4, appendedCount: 1, firstDivergentIndex: null,
  });
  assert.deepEqual(context.compareProjections(base, ["a", "z", "c", "d"]), {
    change: "rewrite", previousCount: 3, nextCount: 4, appendedCount: 1, firstDivergentIndex: 1,
  });
  // A shorter projection is a rewrite even with an intact prefix: a fold removed rows.
  assert.equal(context.compareProjections(base, ["a", "b"]).change, "rewrite");
  assert.equal(context.compareProjections(null, base).change, "append");

  // The two dials are independent. A miss on a projection that only GREW is
  // provider-side by construction: no byte we control moved.
  const ledger = context.emptyLedger();
  ledger.projections = 4;
  assert.deepEqual(
    context.observeCacheUsage(ledger, { usage: { input: 200_000, cacheRead: 0 }, change: "append" }),
    { ordinal: 4, change: "append", inputTokens: 200_000, cacheReadTokens: 0, providerSideMiss: true },
  );
  assert.equal(
    context.observeCacheUsage(ledger, { usage: { input: 200_000, cacheRead: 0 }, change: "rewrite" })
      .providerSideMiss,
    false,
  );
  assert.equal(
    context.observeCacheUsage(ledger, { usage: { input: 200_000, cacheRead: 180_000 }, change: "append" })
      .providerSideMiss,
    false,
  );
  assert.equal(ledger.observedMisses, 2);
  assert.equal(ledger.providerSideMisses, 1);
  assert.equal(context.observeCacheUsage(ledger, { usage: null, change: "append" }), null);

  // End to end. The same session reports rewrites it caused separately from misses it
  // merely observed, and the per-message digests make the append case provable.
  const runtime = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    {},
  );
  await startRuntime(runtime);
  await project(runtime);
  await project(runtime);
  let ledgerNow = (await toolStatus(runtime)).details.automatic.instrumentation;
  assert.equal(ledgerNow.enabled, true);
  assert.equal(ledgerNow.projectionRewrites, 0, "An unchanged reprojection counted as a rewrite");
  assert(ledgerNow.projectionsUnchanged >= 1);

  for (const tokens of [78_000, 82_000, 86_000, 88_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  ledgerNow = (await toolStatus(runtime)).details.automatic.instrumentation;
  assert(materialized(runtime).folds.length >= 1, "The fixture never folded");
  assert(ledgerNow.projectionRewrites >= 1, "A fold was not counted as a projection rewrite");
  assert.equal(
    ledgerNow.projections,
    ledgerNow.projectionRewrites + ledgerNow.projectionAppends + ledgerNow.projectionsUnchanged,
  );
  // The measured harness reports every response with cacheRead 0, so the misses are
  // all observed; the ones on projections we did not rewrite are the provider's.
  assert(ledgerNow.observedCacheMisses >= 1);
  assert(ledgerNow.providerSideCacheMisses <= ledgerNow.observedCacheMisses);
  // The split is exhaustive and is exactly the rewrite/append classification.
  const misses = ledgerNow.cacheObservations.filter((item) => item.cacheReadTokens === 0);
  assert.equal(misses.length, ledgerNow.observedCacheMisses);
  assert.equal(
    misses.filter((item) => item.change !== "rewrite").length,
    ledgerNow.providerSideCacheMisses,
  );

  const rewrite = ledgerNow.projectionRecords.find((record) => record.change === "rewrite");
  assert.equal(typeof rewrite.firstDivergentIndex, "number",
    "A rewrite recorded no divergence point");
  const appended = ledgerNow.projectionRecords.filter((record) => record.change === "append");
  assert(appended.every((record) => record.firstDivergentIndex === null),
    "An append recorded a prefix divergence");
  assert(ledgerNow.projectionRecords.every((record) => /^[a-f0-9]{64}$/.test(record.prefixSha256)));
  assert(ledgerNow.projectionRecords.length <= 64, "The record ring is unbounded");
  assert(ledgerNow.cacheObservations.every((item) =>
    typeof item.inputTokens === "number" && typeof item.cacheReadTokens === "number"));

  // It reaches the envelope the harness reads alongside the existing accounting.
  const epoch = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    { foldScheduling: "epoch" },
  );
  await startRuntime(epoch);
  await measure(epoch, 78_000, 100_000);
  await project(epoch);
  const committed = await toolCall(epoch, { action: "commit" });
  assert.equal(typeof committed.details.estimatedFreedTokens, "number");
  assert.equal(typeof committed.details.instrumentation.projectionRewrites, "number");
  assert.equal(typeof committed.details.instrumentation.providerSideCacheMisses, "number");

  // The context-event stream rides the same ledger and lands durably, which is what
  // an external adjudicator reads: an attempt record for every call, accepted or not.
  await toolCall(epoch, { action: "status" });
  await toolCall(epoch, { action: "peek", id: "no-such-fold" }).catch(() => undefined);
  const events = (await toolStatus(epoch)).details.automatic.instrumentation.events;
  const attempts = events.filter((event) => event.kind === "context.attempt");
  assert(attempts.some((event) => event.ok === true && event.action === "status"));
  const refused = attempts.find((event) => event.ok === false);
  assert(refused, "A refused context call was not recorded");
  assert.equal(refused.action, "peek");
  assert.match(refused.error, /Unknown active-context fold/);
  assert(epoch.appended.some((entry) => entry.customType === "pi-fold-context-event"),
    "The context-event stream never reached a durable session entry");

  return {
    projections: ledgerNow.projections,
    projectionRewrites: ledgerNow.projectionRewrites,
    projectionAppends: ledgerNow.projectionAppends,
    projectionsUnchanged: ledgerNow.projectionsUnchanged,
    observedCacheMisses: ledgerNow.observedCacheMisses,
    providerSideCacheMisses: ledgerNow.providerSideCacheMisses,
    envelopeCarriesLedger: true,
  };
}

async function gateAdvisoryDelivery() {
  // The defect, isolated. Identical pressure schedule; the only difference is whether
  // the ladder has anything to fold, which is to say whether the session is real.
  const idle = makeRuntime(makeFixture({ turns: 12, tools: false, contextWindow: 272_000 }));
  await startRuntime(idle);
  let idleAdvisories = 0;
  for (const tokens of [40_000, 140_000, 200_000, 220_000, 240_000]) {
    await measure(idle, tokens, 272_000);
    idleAdvisories += advisoryMessages(await project(idle)).length;
  }
  assert(idleAdvisories >= 1, "The idle-ladder session never delivered an advisory");

  // A WORKING ladder is the case that used to go dark: an automatic fold in the same
  // context pass cleared the arm before the projection carrying it was ever built, so
  // the budget drained with zero deliveries. The budget is spent on delivery now.
  const lit = await runAdvisorySession({});
  const litState = (await toolStatus(lit.runtime)).details.automatic.advisory;
  assert(lit.advisories.length >= 1, "Delivery counting did not light the channel");
  assert(materialized(lit.runtime).folds.length >= 1, "The lit fixture stopped folding");
  // The books now balance: one budget unit per advisory that actually reached the agent.
  assert.equal(
    Object.values(litState.delivered).reduce((sum, count) => sum + count, 0),
    lit.advisories.length,
  );
  assert.equal(litState.armed, undefined, "A delivered advisory stayed armed and would repeat");

  // Content is keyed on what the agent can act on, and freed mass is in TOKENS.
  const text = String(lit.advisories.at(-1).content);
  assert.match(text, /headroom \d+ of \d+ tokens/);
  assert.match(text, /unmarked share \d+%/);
  assert.match(text, /freeing about \d+ tokens/);
  assert.equal(/freeing about \d+%/.test(text), false, "Freed mass was reported as a percentage");
  assert.equal(/headroom \d+%/.test(text), false, "Headroom was reported as a percentage");
  // An advisory states capacity and stops. It carried an imperative continuation
  // clause for one day (2efc81e, reverted): it commanded behavior rather than
  // reporting state, and it was not in position in either death it was written for.
  // The wording is factual to its last character.
  assert.match(text, /session milestone count: \d+\.$/,
    "A delivered advisory did not end with its factual content");
  assert.equal(/CONTINUE|not a message to answer|carry on/i.test(text), false,
    "A delivered advisory told the agent what to do");
  assert.equal(Object.hasOwn(context, "ADVISORY_CONTINUATION_CLAUSE"), false,
    "The continuation clause is still constructible");

  // The ratchet repair. A milestone that armed and was cleared before it spoke used to
  // be locked out forever, because the high-water mark had already passed its
  // threshold. An undelivered milestone stays armable.
  const schedule = guidanceSchedule(272_000, "pressure");
  const tools = schedule.rungs.find((rung) => rung.milestone === "tools");
  const ratcheted = {
    ...context.emptyActiveContextState("ratchet"),
    advisory: { highWater: 0.99, delivered: {} },
  };
  const scheduleKey = "a".repeat(64);
  const legacy = context.updateAdvisoryMilestone(ratcheted, tools.threshold, schedule, false, scheduleKey);
  assert.equal(legacy.milestone, null, "The legacy ratchet no longer locks out a passed rung");
  const repaired = context.updateAdvisoryMilestone(
    ratcheted, tools.threshold, schedule, false, scheduleKey, true,
  );
  assert.equal(repaired.milestone, "tools", "An undelivered milestone stayed locked out");
  // Once delivered, it does not repeat on the same plateau.
  const afterDelivery = context.recordAdvisoryDelivery(repaired.state, "tools");
  assert.equal(afterDelivery.advisory.delivered.tools, 1);
  assert.equal(afterDelivery.advisory.armed, undefined);
  assert.equal(
    context.updateAdvisoryMilestone(afterDelivery, tools.threshold, schedule, false, scheduleKey, true)
      .milestone,
    null,
  );

  return {
    idleLadderAdvisories: idleAdvisories,
    workingLadderAdvisories: lit.advisories.length,
    deliveriesRecorded: Object.values(litState.delivered).reduce((sum, count) => sum + count, 0),
    ratchetLockedOutBefore: true,
    ratchetRepaired: true,
  };
}

async function gateStatusIndexDiet() {
  const built = makeFixture({ turns: 16, resultChars: 9_000, contextWindow: 100_000 });
  const fat = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(fat);
  const lean = makeRuntime(makeFixture({ turns: 16, resultChars: 9_000, contextWindow: 100_000 }), {
    foldScheduling: "epoch",
  });
  await startRuntime(lean);
  for (const tokens of [78_000, 84_000, 88_000]) {
    await measure(fat, tokens, 100_000);
    await project(fat);
    await measure(lean, tokens, 100_000);
    await project(lean);
  }
  const leanStatus = (await toolStatus(lean)).details;
  const pagedFolds = (await toolStatus(lean, "active_context", "folds")).details;
  const pagedObjects = (await toolStatus(lean, "active_context", "objects")).details;
  assert(leanStatus.totalFolds >= 3, "The fixture built too small an index to measure");

  // The tree and the object list stop riding along; the counts stay, and the full
  // lists are reachable behind an explicit paged query.
  assert.equal(leanStatus.index, "diet");
  assert.equal(Object.hasOwn(leanStatus, "folds"), false);
  assert.equal(Object.hasOwn(leanStatus, "objects"), false);
  assert(Array.isArray(pagedFolds.folds) && Array.isArray(pagedObjects.objects));
  assert(bytesOf(leanStatus) < bytesOf(pagedFolds), "The diet payload was not smaller");
  const fatStatus = pagedFolds;

  // What replaces them answers the question the peeks were asking: which fold has X.
  assert(leanStatus.topFolds.length >= 1 && leanStatus.topFolds.length <= 5);
  assert(leanStatus.topFolds.every((row) => row.startId && row.endId && row.brief && row.peek));
  const reclaimable = leanStatus.topFolds.map((row) => row.reclaimableBytes);
  assert.deepEqual(reclaimable, [...reclaimable].sort((left, right) => right - left));
  const someSource = fatStatus.folds[0].sourceIds[0];
  const mapped = leanStatus.sourceMap.find(([entryId]) => entryId === someSource);
  assert(mapped, "The source map cannot answer which fold holds a known source id");
  assert.equal(mapped[1], fatStatus.folds[0].id);
  assert.equal(leanStatus.sourceMapTotal >= leanStatus.sourceMap.length, true);

  // Truthful headroom and the mark shares are on the payload the agent already reads.
  assert.equal(typeof leanStatus.headroomTokens, "number");
  assert.equal(leanStatus.budgetTokens, 90_000);
  assert.equal(typeof leanStatus.eligibleMarkedShare, "number");
  assert.equal(leanStatus.pendingMarks, leanStatus.eligibleMarks + leanStatus.retainedMarks);

  // The full tree stays reachable, explicitly and paged, and never auto-injected.
  const schema = [...lean.tools.values()][0].parameters.properties.detail.enum;
  assert.deepEqual([...schema], ["fold_candidates", "tree", "folds", "objects"]);
  assert(pagedFolds.folds.length >= 1);
  assert.equal(pagedFolds.index, undefined);
  assert.deepEqual(
    pagedFolds.folds.map((row) => row.id),
    fatStatus.folds.map((row) => row.id),
  );
  // A paged row must carry the brief, or paging the tree returns opaque ids and the
  // agent is pushed straight back into the whole-fold peek the diet exists to avoid.
  const tree = (await toolStatus(lean, "active_context", "tree")).details.tree;
  const treeBriefs = new Map(tree.map((row) => [row.id, row.brief]));
  assert(pagedFolds.folds.every((row) => typeof row.brief === "string" && row.brief.length >= 1),
    "A paged fold row carries no brief");
  assert(pagedFolds.folds.every((row) => row.brief === treeBriefs.get(row.id)),
    "A paged fold row disagrees with the tree row about the brief");
  assert(pagedFolds.folds.every((row) => Number.isSafeInteger(row.sourceChars) && row.sourceChars > 0),
    "A paged fold row carries no sourceChars");
  assert(pagedObjects.objects.length >= 1);
  assert(Array.isArray((await toolStatus(lean, "active_context", "tree")).details.tree));

  // The paged details are part of the surface, and an unknown one still names the set.
  assert.deepEqual(
    [...[...lean.tools.values()][0].parameters.properties.detail.enum],
    ["fold_candidates", "tree", "folds", "objects"],
  );
  await assert.rejects(
    () => toolCall(lean, { action: "status", detail: "everything" }),
    /status detail must be one of 'fold_candidates', 'tree', 'folds', 'objects'/,
  );

  return {
    folds: leanStatus.totalFolds,
    fatStatusBytes: bytesOf(fatStatus),
    dietStatusBytes: bytesOf(leanStatus),
    savedBytes: bytesOf(fatStatus) - bytesOf(leanStatus),
    pagedBriefs: pagedFolds.folds.length,
    topFolds: leanStatus.topFolds.length,
    sourceMapEntries: leanStatus.sourceMap.length,
    pagedFoldsMatchDefault: true,
  };
}

async function gateEligibleShareCommitTrigger() {
  // The trigger itself, in isolation. Pressure is a safety property; the ROI question
  // is whether the marks that could apply NOW are worth one rewrite.
  const built = makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const threshold = context.EPOCH_ELIGIBLE_SHARE_COMMIT_THRESHOLD;
  assert.equal(threshold, 0.30);
  assert.equal(context.epochCommitDue(snapshot, 0.50), false);
  assert.equal(context.epochCommitDue(snapshot, 0.90), true, "The pressure backstop stopped firing");
  assert.equal(context.epochCommitDue(snapshot, 0.50, threshold + 0.01), true);
  assert.equal(context.epochCommitDue(snapshot, 0.50, threshold - 0.01), false);
  assert.equal(context.epochCommitDue(snapshot, 0.50, threshold), true, "The threshold is exclusive");
  // Retained marks are not eligible mass, so they never trip the ROI trigger.
  assert.equal(context.epochCommitDue(snapshot, 0.50, 0), false);

  // End to end: the same session commits far below the 0.85 pressure threshold once
  // the eligible marked mass is worth it, and the anchor does not.
  const roi = makeRuntime(
    makeFixture({ turns: 12, resultChars: 28_000, contextWindow: 100_000 }),
    { foldScheduling: "epoch" },
  );
  await startRuntime(roi);
  // The anchor carries the same shape with a fraction of the mass, so its marks never
  // become worth a rewrite and only the pressure backstop can commit it.
  const anchor = makeRuntime(makeFixture({ turns: 12, resultChars: 3_000, contextWindow: 100_000 }), {
    foldScheduling: "epoch",
  });
  await startRuntime(anchor);
  for (const tokens of [76_000, 77_000, 78_000, 79_000, 80_000]) {
    await measure(roi, tokens, 100_000);
    await project(roi);
    await measure(anchor, tokens, 100_000);
    await project(anchor);
  }
  const roiStatus = (await toolStatus(roi)).details.automatic.scheduling;
  const anchorStatus = (await toolStatus(anchor)).details.automatic.scheduling;
  assert.equal(roiStatus.commitTrigger.mode, "eligible-share");
  assert.equal(anchorStatus.commitTrigger.eligibleShareThreshold,
    context.EPOCH_ELIGIBLE_SHARE_COMMIT_THRESHOLD);
  assert.equal(anchorStatus.commitTrigger.roiDue, false,
    "The anchor fixture already reached the ROI threshold");
  assert.equal(roiStatus.commitTrigger.pressureDue, false, "The fixture reached the pressure backstop");
  assert(materialized(roi).folds.length >= 1,
    `The ROI trigger never fired: ${json.stableStringify(roiStatus.commitTrigger)}`);
  assert.equal(materialized(anchor).folds.length, 0,
    "The pressure anchor committed below its threshold");
  assert(anchorStatus.pending >= 1, "The anchor accumulated no marks to compare against");

  // Pressure remains the backstop above it, and the manual commit stays immediate.
  await measure(anchor, 88_000, 100_000);
  await project(anchor);
  assert(materialized(anchor).folds.length >= 1, "The pressure backstop stopped committing");

  const manual = makeRuntime(makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000 }), {
    foldScheduling: "epoch",
  });
  await startRuntime(manual);
  await measure(manual, 76_000, 100_000);
  await project(manual);
  const manualStatus = (await toolStatus(manual)).details.automatic.scheduling;
  assert.equal(manualStatus.commitTrigger.eligibleShareThreshold, 0.30);
  assert.equal(manualStatus.commitTrigger.roiDue, false);
  const committed = await toolCall(manual, { action: "commit" });
  assert(committed.details.applied.length >= 1,
    "The agent's own commit was not authoritative below the ROI threshold");

  // guidedCuration is the one iteration-4 condition, and it needs a commit to announce.
  assert.throws(
    () => makeRuntime(built, { guidedCuration: true }).tools,
    /guidedCuration requires epoch fold scheduling/,
  );

  return {
    roiThreshold: manualStatus.commitTrigger.eligibleShareThreshold,
    roiEligibleShare: roiStatus.commitTrigger.eligibleShare,
    roiFolds: materialized(roi).folds.length,
    anchorFoldsAtSamePressure: 0,
    anchorPendingMarks: anchorStatus.pending,
    pressureBackstopIntact: true,
    manualCommitApplied: committed.details.applied.length,
  };
}

async function gateRetainedPendingMarks() {
  const fixture = { turns: 10, resultChars: 8_000, contextWindow: 100_000 };
  const built = makeFixture(fixture);
  const freshSpan = [built.turnEntries[9][0], built.turnEntries[9].at(-1)];

  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);
  const tool = [...runtime.tools.values()][0];
  assert.deepEqual([...tool.parameters.properties.action.enum], [
    ...context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS,
  ]);

  // Mark always means mark: the fresh span is accepted, and no byte moved.
  const before = bytesOf((await project(runtime)).messages);
  const marked = await toolCall(runtime, {
    action: "fold", ids: freshSpan, brief: "The closing task stays exactly recoverable behind this fold.",
  });
  assert.equal(marked.details.marked, true);
  assert.equal(marked.details.eligibleNow, false);
  assert.equal(bytesOf((await project(runtime)).messages), before, "A mark moved projection bytes");
  const pendingId = marked.details.id;
  assert.equal(materialized(runtime).pendingMarks.length, 1);

  // A tail-adjacent span no longer takes the inline shortcut: it is a mark too.
  const tailSpan = [built.turnEntries[8][0], built.turnEntries[8].at(-1)];
  const tailMark = await toolCall(runtime, {
    action: "fold", ids: tailSpan, brief: "The previous task stays exactly recoverable behind this fold.",
  });
  assert.equal(tailMark.details.marked, true, "A tail-adjacent span still folded inline");
  assert.equal(materialized(runtime).folds.length, 0);

  // A stale span alongside them, so one commit has both kinds of mark to sort.
  const staleSpan = [built.turnEntries[1][0], built.turnEntries[1].at(-1)];
  const staleMark = await toolCall(runtime, {
    action: "fold", ids: staleSpan, brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  assert.equal(staleMark.details.eligibleNow, true);

  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(scheduling.pending, 3);
  assert.equal(scheduling.eligibleMarks + scheduling.retainedMarks, 3);
  assert(scheduling.eligibleMarks >= 1, "The stale mark was not counted as eligible");
  assert(scheduling.retainedMarks >= 1, "The fresh mark was not counted as retained");
  assert(scheduling.marks.every((mark) => ["eligible", "protected"].includes(mark.eligibility)));

  // The commit applies what it can and KEEPS the rest, with the reason stated.
  const committed = await toolCall(runtime, { action: "commit" });
  assert(committed.details.retainedMarks >= 1, "An ineligible mark was dropped by the commit");
  assert(committed.details.applied.length >= 1, "The eligible mark was not applied");
  assert.equal(
    committed.details.applied.length + committed.details.retainedMarks,
    committed.details.pending,
  );
  const survivors = materialized(runtime).pendingMarks;
  assert(survivors.some((mark) => mark.id === pendingId), "The retained mark did not survive the commit");
  const retainedRefusal = committed.details.refused.find((item) => item.id === pendingId);
  assert.equal(retainedRefusal.retained, true);
  assert.match(retainedRefusal.reason, /stays pending until it is eligible/);

  // Retention is not a leak: the agent can withdraw a standing decision.
  const withdrawn = await toolCall(runtime, { action: "unmark", ids: [pendingId] });
  assert.equal(withdrawn.details.unmarked.length, 1);
  assert.equal(withdrawn.details.unmarked[0].id, pendingId);
  assert(!(materialized(runtime).pendingMarks ?? []).some((mark) => mark.id === pendingId));
  await assert.rejects(
    () => toolCall(runtime, { action: "unmark", ids: [pendingId] }),
    /No pending mark named/,
  );

  // Marks exist only where a commit does, so immediate mode keeps the narrower surface.
  const immediateMode = makeRuntime(makeFixture(fixture), {});
  await startRuntime(immediateMode);
  const immediateActions = [...immediateMode.tools.values()][0].parameters.properties.action.enum;
  assert.equal(immediateActions.includes("unmark"), false);
  assert.equal(immediateActions.includes("commit"), false);
  assert(immediateActions.includes("rebrief") && immediateActions.includes("reboundary"),
    "The correction verbs are not epoch-only and must exist in immediate mode");

  return {
    freshSpanRefusedBefore: true,
    freshSpanMarkedNow: true,
    tailAdjacentSpecialCaseDissolved: true,
    pendingAfterCommit: survivors.length,
    retainedAtCommit: committed.details.retainedMarks,
    appliedAtCommit: committed.details.applied.length,
    unmarked: withdrawn.details.unmarked.length,
  };
}

async function gateTruthfulCapacityAdmission() {
  // The arithmetic first. A 272k per-request descriptor assumes a full output
  // reservation; the truthful budget is the 400k serving window minus the reservation
  // actually in force, which is ~128k of headroom the descriptor hides.
  const descriptor = context.capacityAccounting({
    window: 272_000, truthful: false, descriptorWindow: 272_000, usedTokens: 297_000,
  });
  const truthful = context.capacityAccounting({
    window: 400_000, truthful: true, descriptorWindow: 272_000, usedTokens: 297_000,
  });
  assert.equal(descriptor.budgetTokens, 255_616);
  assert.equal(truthful.budgetTokens, 383_616);
  assert.equal(descriptor.headroomTokens, 255_616 - 297_000);
  assert.equal(truthful.headroomTokens, 383_616 - 297_000);
  assert(descriptor.headroomTokens < 0 && truthful.headroomTokens > 0);
  assert.equal(truthful.descriptorWindow, 272_000);
  assert.equal(context.capacityAccounting({
    window: 400_000, truthful: true, descriptorWindow: null, usedTokens: null,
  }).headroomTokens, null);

  // The rep4 abort, replayed. The same measured load aborts against the descriptor
  // and is admitted against the truthful budget, and the provider had in fact accepted
  // 339,689 tokens in that very session.
  const fixture = () => makeFixture({ turns: 3, tools: false, contextWindow: 272_000 });
  const stale = makeRuntime(fixture());
  await startRuntime(stale);
  await measure(stale, 297_000, 272_000);
  await project(stale);
  assert(stale.aborts >= 1, "The descriptor fence did not abort at 297k against 272k");

  const honest = makeRuntime(fixture(), { providerTotalWindow: 400_000 });
  await startRuntime(honest);
  await measure(honest, 297_000, 272_000);
  await project(honest);
  assert.equal(honest.aborts, 0, "The truthful budget aborted inside real headroom");
  const capacity = (await toolStatus(honest)).details.automatic.capacity;
  assert.equal(capacity.mode, "truthful");
  assert.equal(capacity.window, 400_000);
  assert.equal(capacity.descriptorWindow, 272_000);
  assert.equal(capacity.budgetTokens, 383_616);
  assert.equal(capacity.usedTokens, 297_000);
  assert.equal(capacity.headroomTokens, 86_616);
  assert.equal((await toolStatus(stale)).details.automatic.capacity.mode, "descriptor");
  // The measured proof the descriptor was wrong: the provider accepted 339,689
  // tokens in the same session whose 297k projection the descriptor fence rejected.
  assert(339_689 > descriptor.budgetTokens, "The descriptor budget already covered the accepted request");
  assert(339_689 < truthful.budgetTokens, "The truthful budget does not cover the accepted request");

  // Admission control: a read whose exact stored size will not fit is refused BEFORE
  // it executes, and the refusal is constructible.
  const built = makeFixture({ turns: 10, resultChars: 20_000, contextWindow: 400_000 });
  const runtime = makeRuntime(built, { providerTotalWindow: 400_000 });
  await startRuntime(runtime);
  await measure(runtime, 320_000, 400_000);
  await project(runtime);
  const folds = materialized(runtime).folds;
  assert(folds.length >= 1, "The admission fixture produced no fold to read");
  const big = folds[0];
  const status = (await toolStatus(runtime)).details.automatic.capacity;
  assert.equal(status.mode, "truthful");
  assert(status.headroomTokens > 0);

  // Squeeze the headroom below the fold's stored size, then read it.
  await measure(runtime, 383_000, 400_000);
  const headroom = (await toolStatus(runtime)).details.automatic.capacity.headroomTokens;
  assert.equal(headroom, 616);
  const bytesPerToken = (await toolStatus(runtime)).details.automatic.capacity.bytesPerToken;
  assert(big.sourceChars / bytesPerToken > headroom, "The fixture fold already fits the headroom");
  const refusal = await toolCall(runtime, { action: "peek", id: big.id }).catch((error) => String(error));
  assert.match(refusal, /was refused before it could cross the fence/);
  assert.match(refusal, /Free room or read less/);
  const alternatives = JSON.parse(refusal.slice(refusal.indexOf("[")));
  assert(alternatives.length >= 1, "A refusal named no constructible next action");
  assert(alternatives.some((item) => item.action === "peek" || item.action === "status"));
  const expandRefusal = await toolCall(runtime, { action: "expand", id: big.id })
    .catch((error) => String(error));
  assert.match(expandRefusal, /expand of .* was refused/);

  // The narrowing the refusal offered is real: it executes and it fits.
  const slice = alternatives.find((item) => item.action === "peek" && item.bytes);
  assert(slice, "The refusal offered no bounded slice");
  assert(slice.bytes / bytesPerToken <= headroom);
  const narrowed = await toolCall(runtime, slice);
  assert.equal(narrowed.details.returnedBytes, slice.bytes);
  assert.equal(narrowed.details.truncated, true);

  // Room restored, the identical read executes: admission governs, it does not deny.
  const open = makeRuntime(built, { providerTotalWindow: 400_000 });
  await startRuntime(open);
  await measure(open, 320_000, 400_000);
  await project(open);
  await measure(open, 100_000, 400_000);
  await project(open);
  const whole = await toolCall(open, {
    action: "peek", id: big.id, bytes: context.ACTIVE_CONTEXT_POLICY.maxChapterChars,
  });
  assert.equal(whole.details.truncated, false);
  assert.equal((await toolStatus(open)).details.automatic.capacity.mode, "truthful");

  // An unmeasured read is admitted and says so rather than stalling on absent data.
  assert.equal(context.admissionVerdict({
    requestedBytes: 10_000_000,
    capacity: context.capacityAccounting({
      window: 400_000, truthful: true, descriptorWindow: null, usedTokens: null,
    }),
    bytesPerToken: 4,
  }).reason, "unmeasured");

  return {
    descriptorBudget: descriptor.budgetTokens,
    truthfulBudget: truthful.budgetTokens,
    hiddenHeadroomTokens: truthful.budgetTokens - descriptor.budgetTokens,
    descriptorAborts: stale.aborts,
    truthfulAborts: honest.aborts,
    refusedTokens: Math.ceil(big.sourceChars / bytesPerToken),
    headroomTokens: headroom,
    alternativesOffered: alternatives.length,
    narrowedBytes: narrowed.details.returnedBytes,
  };
}

async function gateEphemeralPeekReclamation() {
  // A fold the agent can actually peek. Entry ids are positional and the fold's refs
  // come from a later turn, so the id does not depend on what the earlier peek names.
  const probe = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 9], peekTargetId: "placeholder",
  });
  const seed = context.emptyActiveContextState(probe.sessionId);
  const candidate = context.selectAutomaticToolBatch(peekSnapshot(probe), seed, 1)[0];
  const foldId = (await commitCandidate(seed, peekSnapshot(probe), candidate, {
    brief: "The exact stale inspection result stays recoverable behind this fold.",
  })).prepared.id;

  const built = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 9], peekTargetId: foldId,
  });
  const state = (await commitCandidate(
    context.emptyActiveContextState(built.sessionId),
    peekSnapshot(built),
    context.selectAutomaticToolBatch(
      peekSnapshot(built), context.emptyActiveContextState(built.sessionId), 1,
    )[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;
  assert.equal(state.folds[0].id, foldId, "The peeked fold id shifted with the peek argument");

  const on = peekSnapshot(built);
  // The raw duplicate mass a projection would carry if consumed peeks were kept.
  const baseline = context.projectActiveContext(on, { ...state, pinnedPeeks: [foldId] });
  const reclaimed = context.projectActiveContext(on, state);

  // Both peeks sit before the last assistant message, so both have been consumed.
  const consumed = context.reclaimedPeeks(on, state);
  assert.equal(consumed.length, 2, "Consumed peek reads were not identified");
  assert.deepEqual(consumed.map((item) => item.foldId), [foldId, foldId]);
  assert(bytesOf(reclaimed) < bytesOf(baseline), "Reclaiming consumed peeks freed nothing");
  assert.equal(baseline.length, reclaimed.length, "Reclamation changed the message count");

  const stubs = reclaimed.filter((message) =>
    message?.role === "toolResult" && String(message.content?.[0]?.text ?? "").includes("peek reclaimed"));
  assert.equal(stubs.length, 2);
  assert(stubs.every((message) => String(message.content[0].text).includes(foldId)));
  assert(stubs.every((message) => String(message.content[0].text).includes('"retain":true')));
  assert(stubs.every((message) => String(message.content[0].text).includes('"offset"')));
  // The deletion is tail-local and never touches call/result linkage.
  context.assertProjectionPreservesToolLinkage(built.messages, reclaimed);

  // The newest peek has not been read by any model call yet, so it stays raw.
  const unconsumed = peekSnapshot(built, { messages: built.messages.slice(0, -1) });
  const stillFresh = context.reclaimedPeeks(unconsumed, state);
  assert.equal(stillFresh.length, 1, "The unread peek at the tail was reclaimed");
  assert.equal(stillFresh[0].index, context.reclaimedPeeks(on, state)[0].index);

  // Expanding is committing to the fold; pinning is committing to the read. Either
  // one keeps the exact source in the window.
  assert.deepEqual(context.reclaimedPeeks(on, { ...state, expanded: [foldId] }), []);
  const pinned = context.withPinnedPeek(state, foldId, true);
  assert.deepEqual(pinned.pinnedPeeks, [foldId]);
  assert.deepEqual(context.reclaimedPeeks(on, pinned), []);
  assert.equal(context.withPinnedPeek(pinned, foldId, false).pinnedPeeks, undefined);
  assert.equal(bytesOf(context.projectActiveContext(on, pinned)), bytesOf(baseline));

  // A pin is durable state, and it never leaks into a session that did not pin.
  const roundTrip = context.parseActiveContextState(
    JSON.parse(json.stableStringify(pinned)), built.sessionId,
  );
  assert.deepEqual(roundTrip.pinnedPeeks, [foldId]);
  assert.throws(
    () => context.parseActiveContextState(
      { ...JSON.parse(json.stableStringify(state)), pinnedPeeks: ["no-such-fold"] }, built.sessionId,
    ),
    /Invalid active-context pinned peeks/,
  );

  // End to end, and in immediate mode: reclamation applies to both schedulers, the
  // envelope says the read is ephemeral, and retain persists the choice.
  const runtime = makeRuntime(built, {});
  await startRuntime(runtime);
  await measure(runtime, 80_000, 100_000);
  await project(runtime);
  assert(materialized(runtime).folds.some((fold) => fold.id === foldId),
    "The runtime ladder did not fold the batch the transcript peeks");
  const read = await toolCall(runtime, { action: "peek", id: foldId });
  assert.equal(read.details.retained, false);
  assert.match(String(read.details.lifetime), /one model call/);
  assert.equal(read.details.offset, 0);
  const slice = await toolCall(runtime, { action: "peek", id: foldId, offset: 64, bytes: 2_048 });
  assert.equal(slice.details.offset, 64);
  assert.equal(slice.details.returnedBytes, 2_048);
  assert.equal(slice.details.truncated, true);
  assert.equal(slice.details.nextOffset, 64 + 2_048);
  assert.equal(slice.details.view, "slice");
  const kept = await toolCall(runtime, { action: "peek", id: foldId, retain: true });
  assert.equal(kept.details.retained, true);
  assert.deepEqual(materialized(runtime).pinnedPeeks, [foldId]);
  const status = (await toolStatus(runtime)).details.automatic.peek;
  assert.equal(status.defaultMaxBytes, context.PEEK_DEFAULT_MAX_BYTES);
  assert.deepEqual(status.pinned, [foldId]);
  assert.equal(status.reclaimed.length, 0, "A pinned read was still counted as reclaimable");
  await toolCall(runtime, { action: "peek", id: foldId, retain: false });
  assert.equal(materialized(runtime).pinnedPeeks, undefined);
  assert.equal((await toolStatus(runtime)).details.automatic.peek.reclaimed.length, 2);

  // The peek and epoch surfaces must describe units of WORK, not units of
  // conversation. Text presupposing a turn-ending reply rides in the tool surface of
  // every request, and a single-turn staged agent reads it as permission to reply.
  const immediate = makeRuntime(built, {});
  await startRuntime(immediate);
  const epoch = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(epoch);
  const sentences = (text) => text.split(/(?<=\.)\s+/).filter(Boolean);
  const baseSentences = new Set(sentences([...immediate.tools.values()][0].description));
  const additions = sentences([...epoch.tools.values()][0].description)
    .filter((sentence) => !baseSentences.has(sentence));
  assert(additions.length >= 1, "The epoch surface added nothing to assert over");
  assert(additions.some((sentence) => /epoch mode/.test(sentence)));
  const everySentence = [...baseSentences, ...additions];
  for (const phrase of ["the reply", "between tasks"]) {
    assert(!everySentence.some((sentence) => sentence.includes(phrase)),
      `The tool surface says "${phrase}"`);
  }
  assert(everySentence.some((sentence) => /one model call/.test(sentence)),
    "The peek lifetime is no longer stated in the tool surface");

  return {
    epochSurfaceAdditions: additions.length,
    reclaimedPeeks: consumed.length,
    reclaimedBytes: bytesOf(baseline) - bytesOf(reclaimed),
    unreadPeekKeptRaw: stillFresh.length,
    pinnedKeepsSourceRaw: true,
    expandedKeepsSourceRaw: true,
    sliceBytes: slice.details.returnedBytes,
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
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
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
 *
 * Reachability is the property, not the mechanism: a refold decision taken on a pass
 * whose epoch applied nothing lands as a MARK and re-collapses at the next commit,
 * which is the batching contract gate 55 pins.
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
    if (!materialized(runtime).expanded.includes(target)) break;
  }
  assert.equal(materialized(runtime).expanded.includes(target), false,
    `The refold rung never fired in epoch mode: ${kinds.join(",")}`);
  assert(["refold", "epoch-commit"].includes(kinds.at(-1)),
    `The fold re-collapsed outside the refold rung: ${kinds.join(",")}`);
  assert(kinds.includes("mark") || kinds.includes("refold"),
    `The refold decision was never taken: ${kinds.join(",")}`);

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

/**
 * The index defect the iteration-2 forensics found: every fold of the same read-only
 * tool carried the SAME generic sentence, so no agent could tell which fold held the
 * stage it needed and no run, control included, ever peeked the right one. A
 * stage-identified brief carries the call arguments and the result TAIL, which is
 * where a staged chain keeps its key.
 */
async function gateStageIdentifiedBriefs() {
  const fixture = {
    turns: 8,
    resultChars: 10_000,
    contextWindow: 100_000,
    resultTail: (turn) => `NEXT_KEY=stage-${turn}-7f3a`,
    // Arguments no whitelist ever named: this is the shape that collapsed every
    // repo_stage fold onto one sentence in the measured runs.
    readArguments: (turn) => ({ stage: turn }),
  };
  const identifiedRuntime = makeRuntime(makeFixture(fixture), {});
  await startRuntime(identifiedRuntime);
  await measure(identifiedRuntime, 80_000, 100_000);
  await project(identifiedRuntime);
  await measure(identifiedRuntime, 88_000, 100_000);
  await project(identifiedRuntime);
  const identified = materialized(identifiedRuntime).folds
    .filter((fold) => fold.kind === "tool-result");
  assert(identified.length >= 2, "The identified fixture folded fewer than two tool results");

  const generic = makeRuntime(makeFixture(fixture));
  await startRuntime(generic);
  await measure(generic, 80_000, 100_000);
  await project(generic);
  await measure(generic, 88_000, 100_000);
  await project(generic);
  const identifiedBriefs = identified.map((fold) => fold.brief);
  assert.equal(new Set(identifiedBriefs).size, identified.length,
    "Two stage-identified briefs are identical");
  for (const brief of identifiedBriefs) {
    assert(brief.length <= 1_200, `A stage-identified brief exceeded the hard cap: ${brief.length}`);
    assert(context.usefulBrief(brief, 1_200, "active_context"), "A stage-identified brief is not factual");
    assert(/stage=\d+/.test(brief), `A stage-identified brief lost its arguments: ${brief}`);
    assert(/NEXT_KEY=stage-\d+-7f3a/.test(brief), `A stage-identified brief lost its tail anchor: ${brief}`);
  }

  // The goal itself: pick a stage by its distinctive tail token and land on the fold
  // that holds exactly that stage's result, with no peek and no expand.
  const target = identifiedBriefs
    .map((brief, index) => ({ brief, fold: identified[index] }))
    .find(({ brief }) => brief.includes("NEXT_KEY=stage-1-7f3a"));
  assert(target, "No fold brief identified stage 1 by its tail token");
  const sourceIds = target.fold.parts
    .filter((part) => part.kind === "raw")
    .map((part) => part.ref.entryId);
  const stageOneResult = identifiedRuntime.built.turnEntries[1][2];
  assert.deepEqual(sourceIds, [stageOneResult],
    "The brief that named stage 1 does not hold stage 1's result");

  return {
    identifiedFolds: identified.length,
    distinctIdentifiedBriefs: new Set(identifiedBriefs).size,
    maximumBriefChars: Math.max(...identifiedBriefs.map((brief) => brief.length)),
    tailAnchored: true,
  };
}

/**
 * A commit must never fold what the CURRENT excursion just gathered. Measured
 * 2026-08-06 (rep 8): nineteen folds landed between the agent's last read result and
 * its next reply, so the agent answered from a window where its own just-gathered
 * evidence had become placeholders. The fresh tail is a BYTE bound and did not catch
 * it; the boundary that matters is the last terminal assistant message.
 */
async function currentTurnRuntime() {
  // The fixture stays INSIDE the serving budget on purpose: the guard is a
  // batching-economics rule, and above the budget the transmission fence waives it to
  // keep the request sendable. Gate 56 measures that regime.
  //
  // The declared token counts are also kept CONSISTENT with the fixture's byte size,
  // at roughly four serialized chars per token. The fence calibrates itself against the
  // session's own measured chars-per-token, so a fixture that claims 88,000 tokens for
  // a 170,000-char projection is describing a session that genuinely cannot send its
  // next request, and the fence is right to reduce it.
  const runtime = makeRuntime(
    makeFixture({ turns: 40, resultChars: 4_000, contextWindow: 200_000 }),
    { foldScheduling: "epoch" },
  );
  await startRuntime(runtime);
  for (const tokens of [152_000, 156_000, 160_000, 164_000, 168_000]) {
    await measure(runtime, tokens, 200_000);
  }
  const before = (materialized(runtime).pendingMarks ?? []).map((mark) => mark.id);

  // The current excursion: ten read batches gathered since the last reply, far past
  // the 24,000-byte fresh tail, so nothing but the turn boundary protects them.
  const excursion = [];
  for (let step = 0; step < 10; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: `excursion-${step}`,
        name: "read",
        arguments: { path: `excursion-${step}.txt` },
      }],
      stopReason: "toolUse",
      timestamp: 900 + step,
    }, "excursion");
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `excursion-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Excursion ${step}: ${"e".repeat(12_000)}` }],
      isError: false,
      timestamp: 900 + step,
    }, "excursion");
    excursion.push(runtime.branch.at(-1).id);
  }
  // Two further tool-calling generations, so the consumed-batch index accepts reads
  // inside a turn the agent has not closed yet.
  for (let step = 0; step < 2; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Still working ${step}.` }],
      stopReason: "toolUse",
      timestamp: 950 + step,
    }, "excursion");
  }
  await project(runtime);
  return { runtime, before, excursion };
}

async function gateCurrentTurnCommitGuard() {
  const { runtime, before, excursion } = await currentTurnRuntime();
  assert(before.length >= 3, "The fixture accumulated too few pre-turn marks to measure");

  // The agent marks its own just-gathered reads, one batch at a time.
  for (const id of excursion) await toolCall(runtime, { action: "fold", ids: [id] });
  const state = materialized(runtime);
  const snapshot = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 200_000,
  });
  const turnKeys = context.currentTurnRefKeys(snapshot);
  assert.equal(turnKeys.size, excursion.length, "The turn boundary did not find the excursion");

  // The mass split this gate exists to exercise: a large share of the ELIGIBLE marked
  // mass was gathered in the current turn, so freshness alone would let it fold.
  const eligible = state.pendingMarks.filter((mark) =>
    context.markEligibility(snapshot, state, mark) === "eligible");
  const eligibleTurn = eligible.filter((mark) =>
    context.markTouchesCurrentTurn(state, mark, turnKeys));
  const mass = (marks) => marks.reduce((total, mark) =>
    total + context.markFreedBytes(snapshot, state, mark), 0);
  const turnShare = mass(eligibleTurn) / mass(eligible);
  assert(eligibleTurn.length >= 3 && turnShare >= 0.5,
    `Current-turn eligible mass share was ${turnShare}; the fixture proves nothing`);

  // The commit fires with the turn still OPEN.
  await measure(runtime, 176_000, 200_000, undefined, "toolUse");
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "No commit epoch ran");
  assert.equal(epoch.currentTurnRetained, eligibleTurn.length + (state.pendingMarks.length - eligible.length),
    "The epoch did not retain every current-turn mark");

  // Only the older half folded, and nothing the current turn gathered moved a byte.
  const after = materialized(runtime);
  const foldedKeys = new Set(after.folds.flatMap((fold) =>
    fold.parts.filter((part) => part.kind === "raw").map((part) => json.objectRefKey(part.ref))));
  assert(![...turnKeys].some((key) => foldedKeys.has(key)),
    "A commit folded evidence the current turn had just gathered");
  assert(epoch.appliedMarks >= 1, "The guard starved the commit of its older marks");

  // Retained, not dropped: every guarded mark survives with its reason stated and is
  // still pending for the commit after the turn closes.
  const guarded = epoch.refused.filter((mark) => /current turn/.test(mark.reason));
  assert.equal(guarded.length, epoch.currentTurnRetained);
  assert(guarded.every((mark) => mark.retained === true));
  const stillPending = new Set((after.pendingMarks ?? []).map((mark) => mark.id));
  assert(guarded.every((mark) => stillPending.has(mark.id)),
    "A guarded mark was refused without staying pending");

  // The guard is what held that evidence and not the fresh tail: the same marks
  // apply the moment the turn closes and its evidence ages, which the closing pass of
  // the epoch-batching gate measures end to end.
  return {
    preTurnMarks: before.length,
    excursionBatches: excursion.length,
    eligibleCurrentTurnMarks: eligibleTurn.length,
    currentTurnMassShare: Number(turnShare.toFixed(3)),
    appliedMarks: epoch.appliedMarks,
    currentTurnRetained: epoch.currentTurnRetained,
    currentTurnFolds: 0,
  };
}

/**
 * Pinned peek mass is ineligible for reclamation by construction. Measured 2026-08-06
 * (rep 7): retain-pinned peeks held the eligible share below the ROI threshold, no
 * commit ever fired, the window grew to 235k tokens, and no accounting field named
 * the cause. Two things have to hold: the mass is VISIBLE, and the pressure backstop
 * keeps reclaiming non-pinned evidence no matter what the ineligible marks add up to.
 */
async function gatePinnedMassBackstop() {
  // A session whose window carries two pinned peek reads of a real fold.
  const probe = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 8], peekTargetId: "placeholder",
  });
  const seed = context.emptyActiveContextState(probe.sessionId);
  const foldId = (await commitCandidate(
    seed, peekSnapshot(probe), context.selectAutomaticToolBatch(peekSnapshot(probe), seed, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).prepared.id;
  const built = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 8], peekTargetId: foldId,
  });
  const empty = context.emptyActiveContextState(built.sessionId);
  const snapshot = peekSnapshot(built);
  const folded = (await commitCandidate(
    empty, snapshot, context.selectAutomaticToolBatch(snapshot, empty, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;
  assert.equal(folded.folds[0].id, foldId, "The peeked fold id shifted with the peek argument");

  // Unpinned, those reads are reclaimable mass and count as nothing pinned.
  assert.equal(context.markAccounting(snapshot, folded).pinnedBytes, 0);
  const pinned = context.withPinnedPeek(folded, foldId, true);
  const pinnedAccounting = context.markAccounting(snapshot, pinned);
  assert(pinnedAccounting.pinnedBytes > 0, "Pinned peek mass is still invisible in the accounting");
  assert.equal(pinnedAccounting.pinnedResults, 2);
  assert.deepEqual(context.reclaimedPeeks(snapshot, pinned), [], "A pinned read was reclaimed anyway");

  // The starvation itself: marks the commit cannot apply inflate the freed share the
  // top-up measures against, so the top-up concludes its work is already done.
  const wide = makeFixture({ turns: 24, resultChars: 26_000, contextWindow: 100_000 });
  const wideSnapshot = wide.snapshot;
  let starved = context.emptyActiveContextState(wide.sessionId);
  const ineligible = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const resultId = wide.turnEntries[turn][2];
    const candidate = context.manualFoldCandidate(wideSnapshot, starved, [resultId], { allowProtected: true });
    const mark = context.foldMarkFor({
      candidate,
      brief: context.automaticToolBrief(wideSnapshot, candidate),
      briefProvenance: { kind: "deterministic" },
      origin: "agent",
      ordinal: turn,
    });
    starved = context.addPendingMark(starved, mark).state;
    ineligible.push(...candidate.sourceRefs);
  }
  // Exactly the rep-7 shape: the agent protected what it marked, so none of it can move.
  starved = { ...starved, protected: ineligible.map((ref) => structuredClone(ref)) };
  const starvedAccounting = context.markAccounting(wideSnapshot, starved);
  assert.equal(starvedAccounting.eligibleMarks, 0, "The fixture left an applicable mark");
  assert(starvedAccounting.freedWindowShare >= context.EPOCH_COMMIT_TARGET_WINDOW_SHARE,
    `Ineligible marks reached only ${starvedAccounting.freedWindowShare} of the target`);

  const anchorTopUp = context.topUpMarks({ snapshot: wideSnapshot, state: starved, ordinal: 100 });
  const eligibleTopUp = context.topUpMarks({
    snapshot: wideSnapshot, state: starved, ordinal: 100, eligibleOnly: true,
  });
  assert.equal(anchorTopUp.length, 0, "The anchor top-up is no longer starved; the fixture proves nothing");
  assert(eligibleTopUp.length >= 1, "The backstop top-up stayed starved by ineligible mass");
  let toppedUp = starved;
  for (const mark of eligibleTopUp) toppedUp = context.addPendingMark(toppedUp, mark).state;
  const toppedUpAccounting = context.markAccounting(wideSnapshot, toppedUp);
  assert(toppedUpAccounting.eligibleMarks >= 1);
  assert(toppedUpAccounting.eligibleFreedWindowShare > 0,
    "The topped-up commit would still free nothing");
  // The pressure backstop itself is untouched and still fires on ratio alone.
  assert.equal(context.epochCommitDue(wideSnapshot, 0.85, { eligibleShareThreshold: 0.30, eligibleShare: 0 }), true);

  // And a live commit reports the pinned mass in its own envelope.
  const runtime = makeRuntime(
    makeFixture({ turns: 40, resultChars: 20_000, contextWindow: 100_000 }),
    {
      foldScheduling: "epoch",

    },
  );
  await startRuntime(runtime);
  for (const tokens of [76_000, 78_000, 80_000]) await measure(runtime, tokens, 100_000);
  await measure(runtime, 88_000, 100_000);
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "The pressure backstop did not commit");
  assert.equal(epoch.trigger, "window-pressure");
  assert(epoch.appliedMarks >= 1, "The backstop commit applied nothing");
  assert.equal(typeof epoch.pinnedBytes, "number");

  return {
    pinnedBytes: pinnedAccounting.pinnedBytes,
    pinnedResults: pinnedAccounting.pinnedResults,
    ineligibleFreedShare: Number(starvedAccounting.freedWindowShare.toFixed(3)),
    anchorTopUpMarks: anchorTopUp.length,
    backstopTopUpMarks: eligibleTopUp.length,
    backstopEligibleShare: Number(toppedUpAccounting.eligibleFreedWindowShare.toFixed(3)),
    backstopAppliedMarks: epoch.appliedMarks,
  };
}

/**
 * Peek lifetime as a per-call decision. The deployment default answers whether peeks
 * are ephemeral HERE; only the caller knows whether THIS read is a glance or a fact
 * it is about to work from. The override runs in both directions and the envelope
 * states the lifetime the read actually has.
 */
async function gatePerPeekEphemeral() {
  const probe = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 8], peekTargetId: "placeholder",
  });
  const seed = context.emptyActiveContextState(probe.sessionId);
  const foldId = (await commitCandidate(
    seed, peekSnapshot(probe), context.selectAutomaticToolBatch(peekSnapshot(probe), seed, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).prepared.id;

  // Two peeks of that fold: the first opts out of reclamation, the second opts in.
  const built = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [0, 8], peekTargetId: foldId,
  });
  const withOverrides = structuredClone(built.messages);
  const overrides = new Map([[0, false], [1, true]]);
  let seen = 0;
  for (const message of withOverrides) {
    if (message.role !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type !== "toolCall" || part.arguments?.action !== "peek") continue;
      const decision = overrides.get(seen);
      seen += 1;
      if (decision !== undefined) part.arguments.ephemeral = decision;
    }
  }
  assert.equal(seen, 2, "The fixture did not carry two peek calls");
  const empty = context.emptyActiveContextState(built.sessionId);
  const base = peekSnapshot(built);
  const state = (await commitCandidate(
    empty, base, context.selectAutomaticToolBatch(base, empty, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;

  const snapshotWith = (options) => context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: withOverrides,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
    ...options,
  });

  // Ephemeral is the DEFAULT lifetime: a peek copies a fold's stored source back into
  // the window and the fold store still holds it losslessly, so both reads release.
  const bothDefault = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
  });
  assert.equal(context.reclaimedPeeks(bothDefault, state).length, 2);

  // The per-call override decides ONE read in either direction, because only the caller
  // knows whether this read is a glance or a fact it is about to work from.
  const overridden = snapshotWith({});
  const reclaimedOverridden = context.reclaimedPeeks(overridden, state);
  assert.equal(reclaimedOverridden.length, 1, "The per-peek override held nothing back");
  assert.equal(reclaimedOverridden[0].foldId, foldId);
  assert(bytesOf(context.projectActiveContext(overridden, state)) >
    bytesOf(context.projectActiveContext(bothDefault, state)),
    "The opted-out read was released anyway");

  // The lifetime function itself: an explicit boolean wins, absence is ephemeral.
  assert.equal(context.peekLifetimeIsEphemeral(undefined), true);
  assert.equal(context.peekLifetimeIsEphemeral(false), false);
  assert.equal(context.peekLifetimeIsEphemeral(true), true);

  // The envelope tells the truth in both directions, and the schema carries both params.
  const runtime = makeRuntime(built, {});
  await startRuntime(runtime);
  await measure(runtime, 80_000, 100_000);
  await project(runtime);
  const liveFold = materialized(runtime).folds[0]?.id;
  assert(liveFold, "The live fixture folded nothing to peek");
  const properties = [...runtime.tools.values()][0].parameters.properties;
  assert.equal(properties.ephemeral.type, "boolean");
  assert.equal(properties.retain.type, "boolean");
  const released = await toolCall(runtime, { action: "peek", id: liveFold });
  assert.match(released.details.lifetime, /^one model call:/);
  const durable = await toolCall(runtime, { action: "peek", id: liveFold, ephemeral: false });
  assert.match(durable.details.lifetime, /^durable:/);
  await assert.rejects(
    () => toolCall(runtime, { action: "peek", id: liveFold, ephemeral: "yes" }),
    /peek ephemeral must be a boolean/,
  );
  // retain is the durable PIN on the fold, which outranks either lifetime.
  const pinned = await toolCall(runtime, { action: "peek", id: liveFold, retain: true });
  assert.equal(pinned.details.retained, true);
  assert.match(pinned.details.lifetime, /^pinned:/);
  assert.deepEqual(materialized(runtime).pinnedPeeks, [liveFold]);

  return {
    defaultReclaimed: context.reclaimedPeeks(bothDefault, state).length,
    overriddenReclaimed: reclaimedOverridden.length,
    schemaKeys: Object.keys(properties).length,
  };
}

/**
 * The sealed spine, as a deployment now writes it. Every reliability lever rep 14
 * sealed is unconditional, so what remains is one experiment condition and one
 * deployment fact; the behaviour under test is identical to the twelve-lever runs.
 */
const SEALED_SPINE = Object.freeze({
  foldScheduling: "epoch",
  providerTotalWindow: 100_000,
});

/**
 * A session in the shape the guard was built for: a long excursion of read batches
 * with NO terminal assistant message after them, so every result belongs to the turn
 * still in progress.
 */
async function sealedSpineExcursionRuntime(overrides = {}) {
  const runtime = makeRuntime(
    makeFixture({ turns: 6, resultChars: 2_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, ...overrides },
  );
  await startRuntime(runtime);
  for (let step = 0; step < 24; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `exc-${step}`, name: "read", arguments: { path: `exc-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 900 + step,
    }, "excursion");
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `exc-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Excursion ${step}: ${"e".repeat(12_000)}` }],
      isError: false,
      timestamp: 900 + step,
    }, "excursion");
  }
  // Two further tool-calling generations, so the consumed-batch index accepts reads
  // inside a turn the agent has not closed yet.
  for (let step = 0; step < 2; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Still working ${step}.` }],
      stopReason: "toolUse",
      timestamp: 950 + step,
    }, "excursion");
  }
  await project(runtime);
  return runtime;
}

/**
 * Epoch batching under the FULL lever set. The economic property of epoch scheduling
 * is that folds land in commit epochs and nowhere else: a projection rewrite outside
 * one buys a single fold at the price of the whole prefix cache.
 *
 * Measured 2026-08-06 (rep 10, all twelve levers, foldScheduling epoch): 52 contiguous
 * fold-record blocks of exactly ONE fold each against two real commit accountings, a
 * median per-request cache share of 0.000, and pending marks frozen at nine for the
 * whole run. The current-turn guard retained every mark, so the epoch applied nothing
 * and paid for no rewrite, and the inline rung folded one batch per pass ANYWAY -- the
 * same evidence the guard had just protected, because the inline selection did not
 * exclude what a pending mark already claimed. The iteration-1 control (epoch, levers
 * off) batched 8-16 folds per block and produced no singles.
 */
async function gateEpochBatchingUnderFullLevers() {
  const runtime = await sealedSpineExcursionRuntime();
  const passes = [];
  const step = async (tokens) => {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    const state = materialized(runtime);
    const action = (await toolStatus(runtime)).details.automatic.lastAutomaticAction;
    passes.push({
      tokens,
      marks: state.pendingMarks?.length ?? 0,
      folds: state.folds.length,
      kind: action?.kind ?? null,
      appliedMarks: action?.epoch ? action.epoch.appliedMarks : null,
      retainedMarks: action?.epoch ? action.epoch.retainedMarks : null,
      guardWaived: action?.epoch ? action.epoch.guardWaived : null,
      waivedMarks: action?.epoch ? action.epoch.waivedMarks : null,
    });
    return passes.at(-1);
  };

  // Below the commit threshold every pass MARKS and moves no byte.
  const below = [];
  for (const tokens of [76_000, 77_000, 78_000, 79_000, 80_000, 81_000, 82_000, 83_000, 84_000]) {
    below.push(await step(tokens));
  }
  assert(below.every((pass) => pass.kind === "mark"),
    `A pass below the commit threshold did not mark: ${below.map((pass) => pass.kind).join(",")}`);
  assert.equal(below.at(-1).folds, 0, "A fold landed below the commit threshold");
  assert.equal(below.at(-1).marks - below[0].marks, below.length - 1,
    "Marks did not accumulate one per pass below the threshold");

  // Above the backstop, with the turn still OPEN, the guard would retain every mark
  // and starve the commit. Survivability outranks the guard there: the waiver releases
  // the OLDEST guarded marks, so the accumulated batch lands in ONE commit instead of
  // dribbling out as one inline fold per pass, and the waiver is in the accounting.
  const accumulated = below.at(-1).marks;
  const above = [];
  for (let index = 0; index < 8; index += 1) above.push(await step(86_000 + index * 100));
  const waivers = above.filter((pass) => pass.guardWaived === true);
  assert(waivers.length >= 1,
    `The starved commit never waived the guard: ${
      above.map((pass) => `${pass.kind}/applied=${pass.appliedMarks}`).join(",")}`);
  const firstWaiver = waivers[0];
  assert(firstWaiver.waivedMarks >= 1, "The waiver released no mark");
  assert(firstWaiver.appliedMarks >= 1, "The waived commit still applied nothing");
  assert(firstWaiver.retainedMarks >= 1,
    "The waiver surrendered the newest reads instead of keeping them protected");
  assert(firstWaiver.appliedMarks >= 4,
    `The waived commit applied ${firstWaiver.appliedMarks} marks; the batch did not land together`);
  assert(above.every((pass) => pass.guardWaived !== true || pass.waivedMarks > 0),
    "A commit reported a waiver that released nothing");

  // The rep10 property still holds everywhere: no pass folds unless a commit epoch
  // applied at least one mark, so folds never dribble out one rewrite at a time.
  assert(passes.every((pass, index) =>
    index === 0 || pass.folds === passes[index - 1].folds || pass.appliedMarks > 0),
    "A fold landed outside a commit epoch that applied marks");
  const foldingPasses = passes.filter((pass, index) =>
    index > 0 && pass.folds > passes[index - 1].folds);
  assert(foldingPasses.length <= Math.ceil(above.length / 2),
    `${foldingPasses.length} of ${passes.length} passes moved bytes; batching degraded to per-pass folding`);
  assert(foldingPasses.length >= 1, "Nothing ever reduced the window above the backstop");
  // The waiver releases a BATCH or nothing: a lone guarded mark never buys a rewrite.
  assert(waivers.every((pass) => pass.waivedMarks >= 2),
    `A waiver released ${waivers.map((pass) => pass.waivedMarks).join(",")} marks; the batch floor is not holding`);

  // The turn closes and its evidence ages past the fresh window. Now ONE commit
  // applies the whole accumulated batch in a single rewrite.
  const pendingAtClose = materialized(runtime).pendingMarks.length;
  const foldsAtClose = materialized(runtime).folds.length;
  for (let turn = 0; turn < 3; turn += 1) {
    runtime.appendMessage({
      role: "user", content: [{ type: "text", text: `Next task ${turn}.` }], timestamp: 990 + turn,
    }, "closing");
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Completed the follow-up ${turn}.` }],
      stopReason: "stop",
      timestamp: 990 + turn,
    }, "closing");
  }
  await project(runtime);
  await measure(runtime, 87_000, 100_000);
  const closing = (await toolStatus(runtime)).details.automatic.lastAutomaticAction;
  assert(closing.epoch, "The closed turn did not open a commit epoch");
  assert(closing.epoch.retainedMarks <= 1,
    `The guard still held ${closing.epoch.retainedMarks} marks after the turn closed`);
  assert(closing.epoch.appliedMarks >= closing.epoch.pendingMarks - 1,
    "The closing commit left more than the newest mark behind");
  assert(closing.epoch.appliedMarks >= 5,
    `The commit applied ${closing.epoch.appliedMarks} marks; the batch never formed`);
  const foldsAdded = materialized(runtime).folds.length - foldsAtClose;
  assert(foldsAdded >= closing.epoch.appliedMarks,
    `The batched commit added ${foldsAdded} folds; the accumulated marks did not land together`);
  assert.equal(materialized(runtime).pendingMarks, undefined, "The batched commit left marks pending");

  return {
    belowThresholdPasses: below.length,
    belowThresholdFolds: below.at(-1).folds,
    accumulatedMarks: accumulated,
    waivedCommits: waivers.length,
    marksReleasedByFirstWaiver: firstWaiver.waivedMarks,
    marksKeptProtected: firstWaiver.retainedMarks,
    passesThatMovedBytes: foldingPasses.length,
    passesTotal: passes.length,
    marksAtClose: pendingAtClose,
    committedInOneEpoch: true,
    appliedInOneCommit: closing.epoch.appliedMarks,
    foldsAddedByThatCommit: foldsAdded,
  };
}

/**
 * The transmission fence, and the guard waiver that serves it.
 *
 * Measured 2026-08-06 (rep 11): the hard fence gates on `measurements.latestRatio`,
 * which describes the request the provider already ANSWERED. The last measurement read
 * 359,625 tokens of a 400,000 window (ratio 0.937 against a 0.959 fence) so nothing
 * aborted, and the projection that went out was 1,831,936 chars -- about 458k estimated
 * tokens, 1.2x the window. The provider rejected it twice and the worker died at stage
 * 39 of 64. Nothing in that run ever measured the request about to be SENT.
 *
 * The run also proved the guard boundary can never advance: all 58 assistant messages
 * carried stopReason "toolUse" and not one was terminal, so `currentTurnBoundary` sat
 * at -1 the whole session and every mark was guarded forever. The only marks that ever
 * landed came from the agent's own two explicit commits.
 */
async function gateProjectionBudgetFence() {
  // The waiver arithmetic first, in isolation.
  const built = makeFixture({ turns: 8, resultChars: 4_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const waiver = (ratio, guardedMarks, otherApplicableMarks = 0) =>
    context.guardWaiverCount({ snapshot, ratio, guardedMarks, otherApplicableMarks });
  assert.equal(waiver(0.5, 8), 0, "The guard was waived below the pressure backstop");
  assert.equal(waiver(0.86, 8, 3), 0, "The guard was waived while the commit had other work");
  assert.equal(waiver(0.86, 8), 6, "The starved waiver did not keep the newest reads protected");
  assert.equal(waiver(0.86, 3), 0, "A sub-batch waiver bought a rewrite for almost nothing");
  assert.equal(waiver(0.99, 3), 3, "The hard fence did not waive every guarded mark");
  assert.equal(waiver(0.99, 1), 1, "The hard fence honoured the batch floor it must ignore");
  assert.equal(waiver(null, 8), 0, "An unmeasured ratio waived the guard");

  // A session whose PROJECTION is far past the serving budget while the last measured
  // ratio is calm: exactly the rep11 shape, where the excursion outgrew the window
  // between one provider response and the next request.
  const runtime = makeRuntime(
    makeFixture({ turns: 40, resultChars: 12_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 100_000 },
  );
  await startRuntime(runtime);
  for (let step = 0; step < 12; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `over-${step}`, name: "read", arguments: { path: `over-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 800 + step,
    }, "excursion");
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `over-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Overflow ${step}: ${"o".repeat(24_000)}` }],
      isError: false,
      timestamp: 800 + step,
    }, "excursion");
  }
  for (let step = 0; step < 2; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Still working ${step}.` }],
      stopReason: "toolUse",
      timestamp: 850 + step,
    }, "excursion");
  }
  // The boundary the guard depends on never advanced: not one terminal assistant
  // message exists in this session, which is what rep11 measured.
  const openSnapshot = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const boundary = context.currentTurnBoundary(openSnapshot);
  assert(boundary < runtime.messages.length - 24,
    "The turn boundary advanced into the excursion, so the starving guard is not being measured");
  assert(context.currentTurnRefKeys(openSnapshot).size >= 12,
    "The guard does not hold the excursion, so there is nothing for the waiver to release");

  // A calm measured ratio, well under the hard fence: the lagging fence sees nothing.
  await measure(runtime, 70_000, 100_000, undefined, "toolUse");
  const status = await toolStatus(runtime);
  const budgetTokens = status.details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 90_000, "The serving budget is not the window minus the reservation");
  assert(status.details.automatic.pressureRatio < context.hardFenceRatio({ contextWindow: 100_000 }),
    "The measured ratio already sat at the hard fence, so the lagging fence would have caught it");

  // The request is built. Either it now fits, or it was aborted; it is NEVER sent over
  // budget. Both outcomes are proven against the same projection the host would send.
  const projection = await project(runtime);
  const abortedRequests = runtime.aborts;
  const settled = (await toolStatus(runtime)).details.automatic;
  // Weighed the way the FENCE weighs it: the session's own measured chars per token,
  // not a fixed constant the fence stopped using.
  const projectedTokens = Math.ceil(bytesOf(projection.messages) / settled.projectionCharsPerToken);
  const reduction = settled.overBudgetReduction;
  assert(reduction, "The over-budget projection was neither reduced nor recorded");
  assert(reduction.estimatedTokensBefore > budgetTokens,
    `The fixture projected ${reduction.estimatedTokensBefore} tokens, inside the ${budgetTokens} budget`);
  assert(reduction.estimatedTokensAfter < reduction.estimatedTokensBefore,
    "The emergency reduction freed nothing");
  if (reduction.transmitted) {
    assert(projectedTokens <= budgetTokens,
      `A projection of ${projectedTokens} tokens was transmitted against a ${budgetTokens} budget`);
  } else {
    assert(abortedRequests >= 1, "An over-budget projection was transmitted without an abort");
  }

  // The reduction ran at fence pressure: it applied marks and held NOTHING back.
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "The over-budget path never opened a commit epoch");
  assert(epoch.appliedMarks >= 1, "The fence-level commit applied nothing");
  assert.equal(epoch.retainedMarks, 0, "The fence left marks guarded while the request would not fit");

  // The rep11 shape exactly: the excursion is the ONLY foldable evidence, so the
  // top-up has nothing unguarded to reach for and the fence waiver is the only thing
  // standing between the session and an untransmittable request.
  const guardedOnly = makeRuntime(
    makeFixture({ turns: 8, tools: false, chapterChars: 40, contextWindow: 100_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 100_000 },
  );
  await startRuntime(guardedOnly);
  for (let step = 0; step < 14; step += 1) {
    guardedOnly.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `only-${step}`, name: "read", arguments: { path: `only-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 800 + step,
    }, "excursion");
    guardedOnly.appendMessage({
      role: "toolResult",
      toolCallId: `only-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Only ${step}: ${"o".repeat(30_000)}` }],
      isError: false,
      timestamp: 800 + step,
    }, "excursion");
  }
  for (let step = 0; step < 2; step += 1) {
    guardedOnly.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Still working ${step}.` }],
      stopReason: "toolUse",
      timestamp: 850 + step,
    }, "excursion");
  }
  await measure(guardedOnly, 70_000, 100_000, undefined, "toolUse");
  await project(guardedOnly);
  const guardedStatus = (await toolStatus(guardedOnly)).details.automatic;
  const guardedEpoch = guardedStatus.lastAutomaticAction?.epoch;
  assert(guardedEpoch, "The all-guarded session never opened a commit epoch at the fence");
  assert.equal(guardedEpoch.guardWaived, true,
    "The fence did not waive the guard when every mark was current-turn");
  assert(guardedEpoch.waivedMarks >= 1, "The fence waiver released no mark");
  assert.equal(guardedEpoch.retainedMarks, 0, "The fence held marks back with the request unsendable");
  assert(materialized(guardedOnly).folds.length >= 1, "The fence-level waiver folded nothing");

  // The invariant, stated once: a projection the fence weighs as over budget is never
  // transmitted. It may still be RETURNED -- an aborted turn hands back the projection,
  // never the raw corpus -- but the abort is what stops the send.
  const abortsBeforeFinal = runtime.aborts;
  const finalProjection = await project(runtime);
  const finalStatus = (await toolStatus(runtime)).details.automatic;
  const finalTokens = Math.ceil(bytesOf(finalProjection.messages) / finalStatus.projectionCharsPerToken);
  assert(finalTokens <= budgetTokens || runtime.aborts > abortsBeforeFinal,
    `A ${finalTokens}-token projection was transmitted against a ${budgetTokens}-token budget`);
  assert(bytesOf(finalProjection.messages) < bytesOf(runtime.messages),
    "An aborted pass handed back the raw branch instead of the projection");

  return {
    waiverBelowBackstop: 0,
    waiverWhenStarved: waiver(0.86, 8),
    waiverAtFence: waiver(0.99, 3),
    budgetTokens,
    projectedTokensBefore: reduction.estimatedTokensBefore,
    projectedTokensAfter: reduction.estimatedTokensAfter,
    transmitted: reduction.transmitted === true,
    aborts: runtime.aborts,
    fenceAppliedMarks: epoch.appliedMarks,
    allGuardedWaivedMarks: guardedEpoch.waivedMarks,
    allGuardedFolds: materialized(guardedOnly).folds.length,
  };
}

/**
 * What a projection weighs, and what it is made of, after the fence has acted.
 *
 * Measured 2026-08-06 (rep 12, running the fence from the previous fix). The fence
 * used a fixed four bytes per token over the SERIALIZED projection. That constant is
 * about raw text; a projection also carries roles, ids, custom types and JSON escaping.
 * The same workload ran at 4.7 serialized chars per measured token in rep11 and 7.0 in
 * rep12, so in rep12 the estimate was 76% high: a session sitting at 187,805 tokens of
 * a 400,000 window -- less than half full -- had its request judged over a 383,616
 * token budget, reduced, judged over again, and aborted. The worker died at stage 36
 * of 64 with 41 folds in hand and a window that was never actually full.
 *
 * The aborted pass then returned the RAW branch, which is how a 1,322,385-char
 * projection was recorded as 3,952,934 chars: not an exploding projection but the
 * corpus handed back in its place, the largest message list the session ever produced.
 */
async function gateProjectionCalibration() {
  // A session whose declared measurements say SEVEN serialized chars per token, which
  // is what rep12 actually ran at. Under the old fixed constant every one of these
  // projections reads as far over budget; against the session's own measured ratio
  // they are barely half of it.
  const built = makeFixture({ turns: 64, resultChars: 24_000, contextWindow: 400_000 });
  const runtime = makeRuntime(built, { ...SEALED_SPINE, providerTotalWindow: 400_000 });
  await startRuntime(runtime);
  const sevenChars = (chars) => Math.round(chars / 7);
  const baseline = bytesOf((await project(runtime)).messages);
  await measure(runtime, sevenChars(baseline), 400_000);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 383_616, "The truthful serving budget moved");

  const projection = await project(runtime);
  const projectedChars = bytesOf(projection.messages);
  const naiveTokens = context.estimatedTokens(projectedChars);
  const status = (await toolStatus(runtime)).details.automatic;
  // The separation this gate exists for: the fixed constant says over budget, the
  // session's own measured ratio says half full. rep12 died on that difference.
  assert(naiveTokens > budgetTokens,
    `The naive estimate was ${naiveTokens}, inside the ${budgetTokens} budget; the regression is not reproduced`);
  assert(sevenChars(projectedChars) < budgetTokens * 0.75,
    "The fixture is genuinely near the budget, so a reduction would be correct");
  // Once the session has calibrated, the fence leaves it alone: no further reduction
  // and no further abort, at a size the fixed constant called over budget.
  const abortsBefore = runtime.aborts;
  await project(runtime);
  assert.equal(runtime.aborts, abortsBefore,
    `A session at ${sevenChars(projectedChars)} real tokens was aborted against a ${budgetTokens} budget`);
  assert.equal((await toolStatus(runtime)).details.automatic.overBudgetReduction?.transmitted ?? true, true,
    "A calibrated, half-full session was still being reduced");

  // The estimator tracks the measured size: within 25% of what the provider counted for
  // a projection of this size, where the fixed constant was 76% high in rep12.
  const measuredTokens = sevenChars(projectedChars);
  const estimated = status.projectionEstimatedTokens;
  assert(typeof estimated === "number", "The status does not report what the fence weighed");
  const drift = Math.abs(estimated - measuredTokens) / measuredTokens;
  assert(drift <= 0.25,
    `The calibrated estimate drifted ${(drift * 100).toFixed(1)}% from the measured token count`);
  assert(Math.abs(status.projectionCharsPerToken - 7) <= 1.5,
    `The session calibrated to ${status.projectionCharsPerToken} chars per token, not the measured 7`);

  // Now force the fence with a genuinely oversized projection and keep going. Whatever
  // it does, the next projection is built FROM THE FOLD STATE and is never the corpus.
  const dense = makeRuntime(
    makeFixture({ turns: 40, resultChars: 20_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 100_000 },
  );
  await startRuntime(dense);
  // Calibrate on a healthy pass, then let the excursion outgrow that baseline by half.
  // This is the real over-budget shape: not a mis-estimated session, a session that
  // genuinely gathered more than it can send.
  await measure(dense, 84_000, 100_000);
  for (let step = 0; step < 12; step += 1) {
    dense.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `grow-${step}`, name: "read", arguments: { path: `grow-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 700 + step,
    }, "growth");
    dense.appendMessage({
      role: "toolResult",
      toolCallId: `grow-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Growth ${step}: ${"g".repeat(40_000)}` }],
      isError: false,
      timestamp: 700 + step,
    }, "growth");
  }
  const denseRaw = bytesOf(dense.messages);
  const afterFence = await project(dense);
  const reduction = (await toolStatus(dense)).details.automatic.overBudgetReduction;
  assert(reduction, "The oversized fixture never reached the fence");
  assert(reduction.estimatedTokensAfter < reduction.estimatedTokensBefore,
    "The emergency reduction freed nothing");
  assert(bytesOf(afterFence.messages) < denseRaw,
    "The pass that hit the fence handed back the raw branch instead of the projection");

  // Every subsequent pass keeps projecting from the durable folds: placeholders stay
  // placeholders, the raw sources never come back, and nothing approaches corpus size.
  const sizes = [];
  for (let step = 0; step < 6; step += 1) {
    await measure(dense, 84_000 + step * 100, 100_000, undefined, "toolUse");
    const pass = await project(dense);
    const state = materialized(dense);
    const serialized = json.stableStringify(pass.messages);
    const folded = state.folds.filter((fold) => fold.parentId === null && !state.expanded.includes(fold.id));
    assert(folded.length >= 1, "The reduced session lost its folds");
    for (const fold of folded) {
      assert(serialized.includes(fold.id),
        `Fold ${fold.id} vanished from the projection, which means the raw source came back`);
    }
    sizes.push(bytesOf(pass.messages));
  }
  assert(sizes.every((size) => size < denseRaw),
    `A projection reached corpus size after the fence: ${sizes.join(",")} against ${denseRaw} raw`);
  const growth = sizes.at(-1) - sizes[0];
  assert(growth < denseRaw / 2,
    `The projection grew ${growth} chars after the fence, which no fold state explains`);

  return {
    budgetTokens,
    naiveTokensOverBudget: naiveTokens > budgetTokens,
    measuredTokens,
    calibratedEstimate: estimated,
    driftPercent: Number((drift * 100).toFixed(1)),
    charsPerToken: Number(status.projectionCharsPerToken.toFixed(2)),
    fenceReducedFrom: reduction.estimatedTokensBefore,
    fenceReducedTo: reduction.estimatedTokensAfter,
    rawChars: denseRaw,
    projectionsAfterFence: sizes.length,
    largestProjectionAfterFence: Math.max(...sizes),
  };
}

/**
 * The last three feet of the window.
 *
 * Measured 2026-08-06 (rep 13), the healthiest lever run so far: 47 of 64 stages, fold
 * blocks of 14/20/10 then 4/2/2/3/2/2, zero guard waivers, and a provider rejection at
 * stage 48 with NO fence event all run. Three numbers explain it.
 *
 * The estimator was good but not perfect: against each measurement its error ran from
 * -2.4% to +5.4%. Inflow ran 8,589 to 27,815 tokens per request, median 13,865. And the
 * last measurement read 370,320 tokens against a 383,616 budget: 13,296 of headroom,
 * less than one median step. The fence weighed that request at 366,934, called it under
 * budget, and transmitted. The request AFTER it crossed the real limit. At 96% full an
 * estimator accurate to a few percent is still a coin flip, and the request that kills
 * the session is never the one being weighed.
 *
 * The commits were impotent for a separate reason: once the big stale mass was folded,
 * each commit freed less than one stage of inflow, so six of them carried the window
 * from 340k to 370k while the backstop fired the whole way.
 */
async function gateFenceMarginAndDepth() {
  const window = 200_000;
  const sevenChars = (chars) => Math.round(chars / 7);
  const runtime = makeRuntime(
    makeFixture({ turns: 80, resultChars: 10_000, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 183_616, "The truthful serving budget moved");

  // Climb toward the top of the window in real steps, declaring seven chars per token
  // throughout, which is what this workload actually measured.
  const climb = [];
  for (let step = 0; step < 12; step += 1) {
    const chars = bytesOf((await project(runtime)).messages);
    await measure(runtime, sevenChars(chars), window, undefined, "toolUse");
    const status = (await toolStatus(runtime)).details.automatic;
    climb.push({
      chars,
      declared: sevenChars(chars),
      estimate: status.projectionEstimatedTokens,
      margin: status.projectionMarginTokens,
      charsPerToken: status.projectionCharsPerToken,
      aborts: runtime.aborts,
      reduction: status.overBudgetReduction,
    });
    if (status.overBudgetReduction) break;
    // One stage of inflow: a payload of the size this workload actually gathers.
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `stage-${step}`, name: "read", arguments: { path: `stage-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 700 + step,
    }, "inflow");
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `stage-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Stage ${step}: ${"s".repeat(140_000)}` }],
      isError: false,
      timestamp: 700 + step,
    }, "inflow");
  }

  // The estimator tracks the declared reality closely -- this is not a calibration
  // failure -- and the fence still acted, because it stopped waiting for the wire.
  // The first pass has nothing measured yet and necessarily uses the bootstrap
  // constant; the drift claim is about the CALIBRATED estimator.
  const calibrated = climb.filter((entry) =>
    typeof entry.estimate === "number" && entry.charsPerToken !== context.ESTIMATED_BYTES_PER_TOKEN);
  assert(calibrated.length >= 2, "The climb never calibrated");
  const worstDrift = Math.max(...calibrated.map((entry) =>
    Math.abs(entry.estimate - entry.declared) / entry.declared));
  assert(worstDrift <= 0.1, `The calibrated estimate drifted ${(worstDrift * 100).toFixed(1)}% from measured`);
  const fired = climb.find((entry) => entry.reduction);
  assert(fired, "The fence never fired while the window filled, which is the rep13 death");
  assert(fired.reduction.estimatedTokensBefore < budgetTokens,
    `The fence waited until ${fired.reduction.estimatedTokensBefore} exceeded the ${budgetTokens} budget: that is the wire, not a margin`);
  assert(fired.reduction.crowded === true, "The reduction did not record why it fired");
  assert(fired.reduction.marginTokens >= 0.05 * window,
    `The margin was ${fired.reduction.marginTokens} tokens, under the floor share of the window`);
  assert(fired.reduction.estimatedTokensAfter < fired.reduction.estimatedTokensBefore,
    "The pre-wire reduction freed nothing");
  // The bootstrap pass of an already-huge session may still abort: it has nothing
  // measured yet. Once calibrated, a request inside the budget is REDUCED, never
  // aborted, which is the difference between surviving the top of the window and dying
  // at it.
  assert.equal(fired.reduction.transmitted, true,
    "The pre-wire reduction aborted a request that was inside the budget");
  assert.equal(fired.aborts, calibrated[0].aborts,
    "A calibrated pass inside the budget raised an abort");

  // Calibration recency: the session's ratio drifts from seven chars per token to five.
  // The estimate must follow it, because at this occupancy a stale ratio is the whole
  // error budget. The smallest recent ratio wins, so the dangerous direction is instant.
  const drifting = makeRuntime(
    makeFixture({ turns: 16, resultChars: 8_000, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(drifting);
  const ratios = [];
  for (const perToken of [7, 7, 7, 5, 5, 5]) {
    const chars = bytesOf((await project(drifting)).messages);
    await measure(drifting, Math.round(chars / perToken), window, undefined, "toolUse");
    const status = (await toolStatus(drifting)).details.automatic;
    ratios.push({
      perToken,
      declared: Math.round(chars / perToken),
      estimate: status.projectionEstimatedTokens,
      charsPerToken: status.projectionCharsPerToken,
      margin: status.projectionMarginTokens,
    });
  }
  const afterDrift = ratios.slice(-2);
  for (const entry of afterDrift) {
    const error = Math.abs(entry.estimate - entry.declared) / entry.declared;
    assert(error <= 0.1,
      `After the ratio drifted to ${entry.perToken}, the estimate was ${(error * 100).toFixed(1)}% off measured reality`);
    assert(entry.charsPerToken <= 5.5,
      `The session still weighs itself at ${entry.charsPerToken} chars per token after drifting to 5`);
  }
  // The one pass that CANNOT know is the first at the new ratio: nothing has measured
  // it yet. That is precisely what the margin is for, so the shortfall there must fit
  // inside the margin, and it must not repeat on the next pass.
  const transition = ratios[3];
  assert(transition.declared - transition.estimate <= transition.margin,
    `The drift cost ${transition.declared - transition.estimate} tokens against a ${transition.margin}-token margin`);
  assert(afterDrift.every((entry) => entry.estimate >= entry.declared * 0.95),
    "The estimate stayed optimistic after the session had measured its new ratio");

  // High-occupancy commit depth. The rep13 shape: the stale mass is folded, the window
  // is above the backstop, and what is left is the fresh tail plus the newest payloads.
  // Raising a target share reaches none of that, so the commits become crumbs and the
  // window ratchets UP through every one of them.
  const deep = makeRuntime(
    makeFixture({ turns: 30, resultChars: 12_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 100_000 },
  );
  await startRuntime(deep);
  const epochs = [];
  const projections = [];
  for (let step = 0; step < 10; step += 1) {
    // One more complete turn of inflow, so the newest turns are genuinely fresh.
    deep.appendMessage({
      role: "user", content: [{ type: "text", text: `Stage ${step}.` }], timestamp: 700 + step,
    }, "inflow");
    deep.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `deep-${step}`, name: "read", arguments: { path: `deep-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 700 + step,
    }, "inflow");
    deep.appendMessage({
      role: "toolResult",
      toolCallId: `deep-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Deep ${step}: ${"d".repeat(24_000)}` }],
      isError: false,
      timestamp: 700 + step,
    }, "inflow");
    deep.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Completed stage ${step}.` }],
      stopReason: "stop",
      timestamp: 700 + step,
    }, "inflow");
    await measure(deep, 86_000 + step * 100, 100_000);
    const action = (await toolStatus(deep)).details.automatic.lastAutomaticAction;
    if (action?.epoch) epochs.push(action.epoch);
    projections.push(bytesOf((await project(deep)).messages));
  }
  assert(epochs.length >= 3, `Only ${epochs.length} commit epochs ran; the ratchet is not being measured`);
  const shallow = epochs.filter((epoch) =>
    epoch.preDeepenFreedShare < Math.max(epoch.depthFloorShare, epoch.targetWindowShare));
  assert(shallow.length >= 1,
    "No commit was ever shallow, so the crumb-commit pattern is not being measured");
  for (const epoch of shallow) {
    assert.equal(epoch.deepenedTarget, true,
      `A commit freeing ${epoch.preDeepenFreedShare} of the window did not deepen against a ${epoch.depthFloorShare} floor`);
  }
  // Deepening has to REACH something the ordinary top-up could not: that is the whole
  // difference between reaching into the fresh tail and asking harder for mass that is
  // not there.
  const reached = shallow.filter((epoch) => epoch.deepenedMarks >= 1);
  assert(reached.length >= 1,
    `Deepening added no marks in ${shallow.length} shallow commits; it reached nothing the top-up had not`);
  // The property the rep13 ratchet violated: the window ends no larger than it started,
  // across a run where every pass added a stage of inflow.
  assert(projections.at(-1) <= projections[0],
    `The window ratcheted from ${projections[0]} to ${projections.at(-1)} chars across ${epochs.length} commits`);

  return {
    budgetTokens,
    climbSteps: climb.length,
    firedAtEstimate: fired.reduction.estimatedTokensBefore,
    firedMarginTokens: fired.reduction.marginTokens,
    headroomAtFiring: budgetTokens - fired.reduction.estimatedTokensBefore,
    reducedTo: fired.reduction.estimatedTokensAfter,
    worstDriftPercent: Number((worstDrift * 100).toFixed(1)),
    charsPerTokenAfterDrift: afterDrift.at(-1).charsPerToken,
    commitEpochs: epochs.length,
    shallowEpochs: shallow.length,
    deepenedEpochs: epochs.filter((epoch) => epoch.deepenedTarget === true).length,
    deepeningReachedMarks: reached.reduce((total, epoch) => total + epoch.deepenedMarks, 0),
    projectionFirst: projections[0],
    projectionLast: projections.at(-1),
  };
}

/**
 * The two-signal curation trigger.
 *
 * Occupancy alone announces a commit that has nothing to fold; stale tool mass alone
 * announces one in a window with room to spare. Both, and the announcement is early
 * enough that reacting to it is still cheap.
 */
async function gateCurationTrigger() {
  const built = makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const state = context.emptyActiveContextState(built.sessionId);

  // Signal two, measured: tool-result mass outside the fresh tail and outside folds.
  const mass = context.staleToolMass(snapshot, state);
  assert(mass.results >= 1 && mass.bytes > 0, "The fixture carries no stale tool mass");
  const folded = (await commitCandidate(
    state, snapshot, context.selectAutomaticToolBatch(snapshot, state, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;
  const afterFold = context.staleToolMass(snapshot, folded);
  assert(afterFold.results < mass.results, "A folded batch still counted as stale tool mass");
  assert(afterFold.bytes < mass.bytes);

  const signals = (occupancyTokens, staleBytes) => ({
    occupancy: occupancyTokens === null ? null : occupancyTokens / 90_000,
    occupancyTokens,
    budgetTokens: 90_000,
    window: 100_000,
    staleToolShare: staleBytes / 4 / 100_000,
    staleToolTokens: Math.ceil(staleBytes / 4),
    staleToolResults: 4,
    eligibleFolds: 4,
  });
  const occupancyAt = (share) => Math.ceil(share * 90_000);
  const staleAt = (share) => share * 100_000 * 4;
  const fires = (occupancyShare, staleShare) =>
    context.curationTriggerFires(signals(occupancyAt(occupancyShare), staleAt(staleShare)));

  // Each side of each threshold, and the AND between them.
  assert.equal(context.CURATION_OCCUPANCY_SHARE, 0.50);
  assert.equal(context.CURATION_STALE_TOOL_SHARE, 0.20);
  assert.equal(fires(0.50, 0.20), true, "The trigger did not fire at both thresholds");
  assert.equal(fires(0.49, 0.20), false, "The trigger fired below the occupancy threshold");
  assert.equal(fires(0.50, 0.19), false, "The trigger fired below the stale-mass threshold");
  assert.equal(fires(0.99, 0.19), false, "Occupancy alone fired the trigger");
  assert.equal(fires(0.10, 0.99), false, "Stale mass alone fired the trigger");
  assert.equal(fires(0.80, 0.60), true);
  assert.equal(
    context.curationTriggerFires(signals(null, staleAt(0.9))),
    false,
    "An unmeasured window fired the trigger",
  );

  // Live: the signals the runtime reports come from the same measurement the fence uses.
  const runtime = makeRuntime(built, { ...SEALED_SPINE, guidedCuration: true });
  await startRuntime(runtime);
  await measure(runtime, 60_000, 100_000);
  await project(runtime);
  const live = (await toolStatus(runtime)).details.automatic.curation;
  assert.equal(live.guided, true);
  assert.equal(live.occupancyThreshold, 0.50);
  assert.equal(live.staleToolThreshold, 0.20);
  assert(live.signals, "The runtime reported no curation signals");
  assert(live.signals.occupancy > 0.5, "The live fixture did not reach the occupancy threshold");
  assert(live.signals.staleToolTokens > 0);

  return {
    staleResultsBefore: mass.results,
    staleResultsAfterFold: afterFold.results,
    occupancyThreshold: context.CURATION_OCCUPANCY_SHARE,
    staleThreshold: context.CURATION_STALE_TOOL_SHARE,
    liveOccupancy: Number(live.signals.occupancy.toFixed(3)),
    liveStaleShare: Number(live.signals.staleToolShare.toFixed(3)),
  };
}

/**
 * The bounded last-call gate.
 *
 * A gate that can stall a run is worse than no gate, so the termination property is
 * pinned first and directly: every evaluation either proceeds or spends a round, and
 * the round cap proceeds unconditionally. Continuing the task is the DEFAULT path.
 */
async function gateCurationLastCall() {
  const baseSignals = {
    occupancy: 0.7,
    occupancyTokens: 63_000,
    budgetTokens: 90_000,
    window: 100_000,
    staleToolShare: 0.3,
    staleToolTokens: 30_000,
    staleToolResults: 12,
    eligibleFolds: 6,
  };
  const advance = (gate, contextCalls) => context.advanceCurationGate({
    gate, ordinal: 100, signals: baseSignals, contextCalls, pendingMarks: 3,
  });

  // Opening never commits, and a pass that was not a context call proceeds at once.
  const opened = advance(null, 0);
  assert.equal(opened.event, "opened");
  assert.equal(opened.proceed, false);
  const quiet = advance(opened.gate, 0);
  assert.equal(quiet.event, "proceeded");
  assert.equal(quiet.proceededBy, "non-context-response");

  // Engaging holds the gate, and the cap proceeds regardless of further engagement.
  assert.equal(context.CURATION_GATE_MAX_ROUNDS, 2);
  const held = advance(opened.gate, 1);
  assert.equal(held.event, "held");
  assert.equal(held.roundsUsed, 1);
  const capped = advance(held.gate, 2);
  assert.equal(capped.event, "proceeded");
  assert.equal(capped.proceededBy, "round-cap");
  assert.equal(capped.gate, null);

  // The never-deadlock property, proven exhaustively rather than asserted: an agent
  // that calls context tools forever still reaches a commit within the cap.
  let gate = null;
  let calls = 0;
  let rounds = 0;
  for (let pass = 0; pass < 50; pass += 1) {
    calls += 5;
    const verdict = advance(gate, calls);
    gate = verdict.gate;
    rounds += 1;
    if (verdict.proceed) break;
  }
  assert.equal(gate, null, "An always-engaging agent never closed the gate");
  assert(rounds <= context.CURATION_GATE_MAX_ROUNDS + 1,
    `The gate held for ${rounds} passes against a cap of ${context.CURATION_GATE_MAX_ROUNDS}`);

  // End to end. The notice is delivered on the ephemeral carrier, not as a question,
  // and the commit it announced does not happen on the announcing pass.
  const runtime = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, guidedCuration: true },
  );
  await startRuntime(runtime);
  await measure(runtime, 60_000, 100_000, undefined, "toolUse");
  const announced = await project(runtime);
  const notice = announced.messages.find((message) =>
    message.customType === "pi-fold-active-context-curation");
  assert(notice, "The curation trigger fired without delivering a notice");
  assert.equal(notice.details.ephemeral, true);
  assert.equal(notice.display, false);
  assert.equal(notice.role, "custom");
  const text = String(notice.content);
  // The phase-token rule: operational status and available actions, never a question,
  // with continuing the task stated as the default.
  assert.equal(/\?/.test(text), false, "The last-call notice asks a question");
  assert.match(text, /Continuing the task is the default/);
  assert.match(text, /Occupancy \d+% of the \d+-token serving budget/);
  assert.match(text, /"action":"fold","marks"/);
  assert.match(text, /"action":"rebrief"/);
  assert.match(text, /"action":"reboundary"/);
  assert.match(text, /"action":"commit"/);
  const gateState = (await toolStatus(runtime)).details.automatic.curation.gate;
  assert(gateState, "The gate did not stay open after announcing");

  // Marks made DURING the gate join the same commit event: one mutation, not two.
  const foldsAtAnnounce = materialized(runtime).folds.length;
  const spans = [0, 1].map((turn) => runtime.built.turnEntries[turn][2]);
  const batched = await toolCall(runtime, {
    action: "fold",
    marks: spans.map((id, index) => ({
      ids: [id],
      brief: `Agent-curated span ${index}: the exact stale output stays recoverable behind this fold.`,
    })),
  });
  assert.equal(batched.details.marks.filter((mark) => mark.marked).length, 2);

  // The agent engaged, so it gets its grace round; then the cap proceeds regardless.
  runtime.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Continuing the task." }],
    stopReason: "toolUse",
    timestamp: 980,
  }, "continuation");
  for (const tokens of [61_000, 62_000, 63_000]) {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    await project(runtime);
  }
  const status = (await toolStatus(runtime)).details.automatic;
  const epoch = status.lastAutomaticAction?.epoch;
  assert(epoch, "The gate never proceeded to a commit");
  assert.match(String(epoch.trigger), /^guided-curation:/);
  assert(epoch.appliedMarks >= 2, "The commit did not carry the marks made during the gate");
  assert(materialized(runtime).folds.length > foldsAtAnnounce);
  assert.equal(status.curation.gate, null, "The gate stayed open after proceeding");

  // Every gate event is adjudicable from the durable stream.
  const events = status.instrumentation.events.filter((event) => event.kind === "context.gate");
  assert(events.some((event) => event.gate_event === "opened"));
  const proceeded = events.find((event) => event.gate_event === "proceeded");
  assert(proceeded, "No gate event recorded the commit proceeding");
  assert(["go", "non-context-response", "round-cap"].includes(proceeded.proceeded_by));
  assert(proceeded.marks_added >= 2, "The gate did not count the marks made inside it");
  assert(runtime.appended.some((entry) =>
    entry.customType === "pi-fold-context-event" && entry.data.kind === "context.gate"));

  return {
    maxRounds: context.CURATION_GATE_MAX_ROUNDS,
    passesToClose: rounds,
    noticeBytes: Buffer.byteLength(text, "utf8"),
    marksDuringGate: proceeded.marks_added,
    appliedInOneCommit: epoch.appliedMarks,
    proceededBy: proceeded.proceeded_by,
  };
}

/**
 * Receipts: what the runtime did, reported as status rather than as advice.
 *
 * The tone rule is the point. The old guidance told the agent to fold proactively; a
 * receipt says this happened, you can react, and here is why reacting pays.
 */
async function gateContextReceipts() {
  const runtime = await sealedSpineExcursionRuntime();
  for (const tokens of [76_000, 80_000, 86_000, 86_500, 87_000]) {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
  }
  const projection = await project(runtime);
  const block = projection.messages.find((message) =>
    message.customType === "pi-fold-active-context-receipts");
  assert(block, "No receipt reached the window after an automatic commit");
  assert.equal(block.details.ephemeral, true);
  const text = String(block.content);
  assert(Buffer.byteLength(text, "utf8") <= context.CONTEXT_RECEIPT_BLOCK_BYTES,
    "The receipt block is over its hard cap");
  assert.match(text, /Recent automatic context actions/);
  assert.match(text, /tokens freed/);
  // Informatory, never exhortative: it names the correction verbs and asks nothing.
  assert.match(text, /"action":"rebrief"/);
  assert.match(text, /"action":"reboundary"/);
  assert.equal(/\?/.test(text), false, "A receipt asks the agent a question");
  assert.equal(/please|you should|make sure to|remember to/i.test(text), false,
    "A receipt exhorts rather than reports");

  // It PERSISTS: the next projection still carries it, and it stays bounded.
  const again = await project(runtime);
  const stillThere = again.messages.find((message) =>
    message.customType === "pi-fold-active-context-receipts");
  assert(stillThere, "The receipt vanished on the next projection");
  assert(Buffer.byteLength(String(stillThere.content), "utf8") <= context.CONTEXT_RECEIPT_BLOCK_BYTES,
    "The persisted receipt block grew past its cap");
  assert(stillThere.details.receipts.length >= 1);
  assert(stillThere.details.receipts.length <= context.MAX_CONTEXT_RECEIPTS,
    "The receipt ring grew unbounded across projections");

  // The ring evicts: a receipt ages out rather than growing the block forever.
  assert.equal(context.MAX_CONTEXT_RECEIPTS, 3);
  const many = Array.from({ length: 10 }, (_, index) =>
    context.contextReceipt({ kind: "epoch-commit", ordinal: index, freedTokens: 1_000 }));
  const ring = many.reduce((carry, receipt) => context.withReceipt(carry, receipt), []);
  assert.equal(ring.length, context.MAX_CONTEXT_RECEIPTS);
  assert.deepEqual(ring.map((receipt) => receipt.ordinal), [7, 8, 9]);
  const live = (await toolStatus(runtime)).details.automatic.curation.receipts;
  assert(live.length >= 1 && live.length <= context.MAX_CONTEXT_RECEIPTS);

  // And it is adjudicable: every delivery lands in the durable event stream.
  const events = (await toolStatus(runtime)).details.automatic.instrumentation.events
    .filter((event) => event.kind === "context.receipt");
  assert(events.length >= 1, "No receipt delivery reached the durable stream");
  assert(typeof events.at(-1).receipt_kind === "string");
  assert(runtime.appended.some((entry) =>
    entry.customType === "pi-fold-context-event" && entry.data.kind === "context.receipt"));

  // The carrier is ephemeral by construction: it is never a durable transcript entry.
  assert.equal(runtime.appended.filter((entry) =>
    /receipts|curation$/.test(entry.customType)).length, 0);

  return {
    receiptBlockBytes: Buffer.byteLength(text, "utf8"),
    cap: context.CONTEXT_RECEIPT_BLOCK_BYTES,
    liveReceipts: live.length,
    ringCap: context.MAX_CONTEXT_RECEIPTS,
    deliveriesRecorded: events.length,
  };
}

/**
 * Loud auto-snap, batched marks, and the correction verbs.
 *
 * A span the agent got slightly wrong is a span it MEANT. Refusing it teaches the
 * agent that curating is a coin flip; correcting it silently teaches it that the fold
 * index cannot be trusted. So it snaps, and the correction is in the result.
 */
async function gateAutoSnapAndCorrections() {
  const runtime = await epochToolRuntime({ turns: 16, resultChars: 6_000 });
  const built = runtime.built;

  // One call, several spans, each with its own brief.
  const batched = await toolCall(runtime, {
    action: "fold",
    marks: [0, 1, 2].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  assert.equal(batched.details.marks.length, 3);
  assert(batched.details.marks.every((mark) => mark.marked === true));
  assert.equal(new Set(batched.details.marks.map((mark) => mark.id)).size, 3);
  assert.deepEqual(batched.details.corrections, []);
  assert.equal(materialized(runtime).pendingMarks.length, 3);
  const committed = await toolCall(runtime, { action: "commit" });
  assert.equal(committed.details.applied.length, 3, "The batch did not commit together");

  // A span that starts strictly INSIDE an existing fold snaps to that fold's boundary,
  // and the correction is reported by name rather than silently reinterpreted.
  await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[4][0], built.turnEntries[4].at(-1)],
    brief: "A whole closed turn whose exact evidence stays recoverable behind this fold.",
  });
  await toolCall(runtime, { action: "commit" });
  const existing = materialized(runtime).folds.find((fold) => fold.kind === "chapter");
  assert(existing && existing.parts.length >= 2, "The fixture built no multi-entry fold to cut into");
  const inside = existing.parts[1].kind === "raw"
    ? existing.parts[1].ref.entryId
    : existing.parts[1].foldId;
  const later = built.turnEntries[6].at(-1);
  const snapped = await toolCall(runtime, {
    action: "fold",
    ids: [inside, later],
    brief: "A corrected span whose exact evidence stays recoverable behind this fold.",
  });
  assert(snapped.details.corrections.length >= 1, "A crossing span was accepted uncorrected");
  const correction = snapped.details.corrections[0];
  assert(correction.reason.includes(existing.id),
    `The correction did not name the fold it crossed: ${correction.reason}`);
  assert.match(correction.reason, /corrected to/);
  assert.deepEqual(correction.from, [inside, later]);
  assert.equal(correction.to.length, 2);
  assert.notDeepEqual(correction.to, correction.from);

  // Rejection only where no valid interpretation exists, and it says what failed.
  await assert.rejects(
    () => toolCall(runtime, { action: "fold", ids: ["no-such-entry"] }),
    /Unknown active-context source no-such-entry/,
  );
  await assert.rejects(
    () => toolCall(runtime, { action: "fold", marks: [{ ids: [] }] }),
    /ids must contain 1-64 values/,
  );

  // Re-brief: the fold record is content-addressed and immutable, so the correction is
  // durable state beside it. The placeholder, the index and the suggestions follow it.
  const target = materialized(runtime).folds[0];
  const rebrief = await toolCall(runtime, {
    action: "rebrief",
    id: target.id,
    brief: "Corrected: this fold holds the exact stage-3 chain key the task needs.",
  });
  assert.equal(rebrief.details.previousBrief, target.brief);
  assert.deepEqual(materialized(runtime).briefs, {
    [target.id]: "Corrected: this fold holds the exact stage-3 chain key the task needs.",
  });
  assert.equal(materialized(runtime).folds.find((fold) => fold.id === target.id).brief, target.brief,
    "A re-brief mutated the immutable fold record");
  assert.equal(runtime.notifications.filter((notice) => /Conflicting durable/.test(notice.message)).length, 0);
  const snapshotNow = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  assert(context.foldPlaceholder(target, materialized(runtime), snapshotNow).includes("Corrected:"),
    "The placeholder did not carry the corrected brief");
  const paged = (await toolStatus(runtime, "active_context", "folds")).details.folds;
  assert(paged.find((row) => row.id === target.id).brief.startsWith("Corrected:"));
  await assert.rejects(
    () => toolCall(runtime, { action: "rebrief", id: target.id, brief: "  " }),
    /rebrief requires a nonempty brief/,
  );

  return {
    batchedMarks: batched.details.marks.length,
    appliedTogether: committed.details.applied.length,
    correctionsReported: snapped.details.corrections.length,
    correctionNamesFold: true,
    rebriefed: 1,
  };
}

/**
 * Re-boundary, in both directions, through one verb.
 *
 * `ids` names the span you want to BE one fold. That single rule merges N adjacent
 * folds when the span covers them and splits one fold when the span sits inside it,
 * and `id` alone stays the plain dissolve.
 */
async function gateSymmetricReboundary() {
  const forest = await smallChapterForest(4);
  const runtime = makeRuntime(forest, {
    initialEntries: [
      ...forest.entries,
      stateEntry(forest.sessionId, JSON.parse(json.stableStringify(forest.state)), "reboundary-state"),
    ],
  });
  await startRuntime(runtime);
  const seeded = materialized(runtime);
  const roots = context.orderedRoots(seeded, forest.snapshot);
  assert(roots.length >= 3, "The fixture did not seed enough adjacent folds to merge");

  // MERGE: a span covering several adjacent folds becomes exactly one fold.
  const first = roots[0];
  const third = roots[2];
  const startId = forest.snapshot.mapped[first.start].ref.entryId;
  const endId = forest.snapshot.mapped[third.end].ref.entryId;
  const merged = await toolCall(runtime, {
    action: "reboundary",
    ids: [startId, endId],
    brief: "Three completed chapters merged into one exactly recoverable span.",
  });
  assert.equal(merged.details.mode, "merge");
  assert.equal(merged.details.dissolved.length, 3);
  assert.equal(merged.details.created.length, 1, "A merge produced more than one fold");
  assert.equal(merged.details.created[0].brief,
    "Three completed chapters merged into one exactly recoverable span.");
  const afterMerge = materialized(runtime);
  assert.equal(afterMerge.folds.length, 2, "The merge left the dissolved folds behind");
  assert(!afterMerge.folds.some((fold) => merged.details.dissolved.includes(fold.id)));

  // A merge span that only PARTIALLY covers a fold snaps outward to whole boundaries,
  // loudly, because the re-boundary verb operates on folds.
  const remaining = context.orderedRoots(materialized(runtime), forest.snapshot);
  const partial = forest.snapshot.mapped[remaining[0].start + 1].ref.entryId;
  const partialEnd = forest.snapshot.mapped[remaining[0].end].ref.entryId;
  const corrected = await toolCall(runtime, {
    action: "reboundary",
    ids: [partial, partialEnd],
    brief: "The partially named span, re-cut to the whole fold it meant.",
  });
  assert(corrected.details.corrections.length >= 1, "A partial span was accepted uncorrected");
  assert.match(corrected.details.corrections[0].reason, /whole boundaries/);
  assert.equal(corrected.details.startId, forest.snapshot.mapped[remaining[0].start].ref.entryId);

  // DISSOLVE: `id` alone returns a mis-cut fold's span to raw so it can be re-folded.
  const dissolveTarget = context.orderedRoots(materialized(runtime), forest.snapshot)[0].fold;
  const before = bytesOf(context.projectActiveContext(forest.snapshot, materialized(runtime)));
  const dissolved = await toolCall(runtime, { action: "reboundary", id: dissolveTarget.id });
  assert.equal(dissolved.details.dissolved, true);
  assert(typeof dissolved.details.startId === "string");
  const afterDissolve = materialized(runtime);
  assert(!afterDissolve.folds.some((fold) => fold.id === dissolveTarget.id));
  assert(bytesOf(context.projectActiveContext(forest.snapshot, afterDissolve)) > before,
    "Dissolving a fold did not return its span to raw");

  return {
    mergedFolds: merged.details.dissolved.length,
    mergedInto: merged.details.created.length,
    partialSnapCorrections: corrected.details.corrections.length,
    dissolvedFolds: 1,
  };
}

/**
 * Bite-sized folds.
 *
 * Measured 2026-08-06 (rep 6): one 60,432-byte chapter fold hid the fact the run
 * needed in its tail. A fold is only navigable if reading one back is cheap, so the
 * ladder cannot build an oversized chapter and an oversized manual span is split.
 */
async function gateBiteSizedFolds() {
  assert.equal(context.MAX_FOLD_SPAN_CHARS, 16_000);
  assert.equal(context.PEEK_DEFAULT_MAX_BYTES, 16_000);

  // The ladder: a session whose coherent chapters would run far past the cap.
  const runtime = makeRuntime(
    makeFixture({ turns: 24, tools: false, chapterChars: 2_000, contextWindow: 100_000 }),
    { providerTotalWindow: 100_000 },
  );
  await startRuntime(runtime);
  for (const tokens of [70_000, 78_000, 84_000, 88_000, 90_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  const state = materialized(runtime);
  const chapters = state.folds.filter((fold) => fold.kind === "chapter");
  assert(chapters.length >= 2, "The fixture produced too few chapters to measure");
  for (const fold of chapters) {
    assert(fold.sourceChars <= context.MAX_FOLD_SPAN_CHARS,
      `A ladder chapter is ${fold.sourceChars} chars, past the ${context.MAX_FOLD_SPAN_CHARS} cap`);
  }

  // A default peek of a bite-sized fold returns it WHOLE: the two constants cohere.
  await measure(runtime, 30_000, 100_000);
  const peeked = await toolCall(runtime, { action: "peek", id: chapters[0].id });
  assert.equal(peeked.details.truncated, false, "A default peek of a bite-sized fold was truncated");
  assert.equal(peeked.details.view, "complete");

  // The manual path: an oversized supplied span becomes sequential bounded folds, and
  // the split is reported rather than silent.
  const wide = makeFixture({ turns: 12, tools: false, chapterChars: 3_000, contextWindow: 100_000 });
  const empty = context.emptyActiveContextState(wide.sessionId);
  const oversized = context.manualFoldCandidate(wide.snapshot, empty, [
    wide.turnEntries[0][0], wide.turnEntries[3].at(-1),
  ]);
  const spanChars = context.candidateSpanChars(wide.snapshot, empty, oversized);
  assert(spanChars > context.MAX_FOLD_SPAN_CHARS, "The oversized fixture is not oversized");
  const parts = context.splitCandidateBySize(wide.snapshot, empty, oversized);
  assert(parts.length >= 2, "An oversized span was not split");
  for (const part of parts) {
    assert(context.candidateSpanChars(wide.snapshot, empty, part) <= context.MAX_FOLD_SPAN_CHARS,
      "A split part is still over the cap");
  }
  // Split only at closed unit boundaries: never mid-entry, so the parts tile the span.
  const partRefs = parts.flatMap((part) => part.sourceRefs.map((ref) => ref.entryId));
  assert.deepEqual(partRefs, oversized.sourceRefs.map((ref) => ref.entryId),
    "The split lost or reordered evidence");

  const manual = makeRuntime(wide, {});
  await startRuntime(manual);
  const folded = await toolCall(manual, {
    action: "fold",
    ids: [wide.turnEntries[0][0], wide.turnEntries[3].at(-1)],
    brief: "Four completed tasks whose exact evidence stays recoverable behind these folds.",
  });
  assert.equal(folded.details.folds.length, parts.length, "The manual fold did not split");
  assert(folded.details.corrections.some((item) => /split into \d+ sequential folds/.test(item.reason)),
    "The split was not reported");
  assert(materialized(manual).folds.every((fold) => fold.sourceChars <= context.MAX_FOLD_SPAN_CHARS));

  // A single unit that alone exceeds the cap is folded whole: there is no interior
  // boundary, and refusing would leave the biggest span as the one thing nothing takes.
  const huge = makeFixture({ turns: 6, tools: false, chapterChars: 12_000, contextWindow: 100_000 });
  const hugeEmpty = context.emptyActiveContextState(huge.sessionId);
  const units = context.chapterUnits(huge.snapshot);
  const oneUnit = units.find((unit) =>
    context.spanBytes(huge.snapshot, unit.start, unit.end) > context.MAX_FOLD_SPAN_CHARS);
  assert(oneUnit, "The huge fixture has no single unit past the cap");
  const single = {
    kind: "chapter",
    parts: context.partsForRange(huge.snapshot, hugeEmpty, oneUnit.start, oneUnit.end - 1, new Set()),
    sourceRefs: [],
  };
  single.sourceRefs = context.candidateSourceRefs(single.parts, hugeEmpty);
  assert(context.candidateSpanChars(huge.snapshot, hugeEmpty, single) > context.MAX_FOLD_SPAN_CHARS);
  assert.equal(context.splitCandidateBySize(huge.snapshot, hugeEmpty, single).length, 1);

  return {
    foldSpanCap: context.MAX_FOLD_SPAN_CHARS,
    ladderChapters: chapters.length,
    largestLadderChapter: Math.max(...chapters.map((fold) => fold.sourceChars)),
    manualSplitParts: folded.details.folds.length,
    unsplittableUnitFoldedWhole: true,
  };
}

/**
 * Wedge absorption, and the ANTI-LCM PIN.
 *
 * A sliver hugging a fold boundary is a crumb nothing will ever reclaim, so a commit
 * that is already paying for its rewrite swallows it. What absorption must NEVER do is
 * erode deliberate non-sequential curation: an agent holding folds with raw spans
 * between them chose that shape, and a mechanism that ate those gaps would turn
 * pi-fold into system-controlled compaction with the curation element deleted.
 */
async function gateWedgeAbsorption() {
  assert.equal(context.MAX_WEDGE_ABSORB_TOKENS, 256);
  const built = makeFixture({
    turns: 20, tools: false, chapterChars: 40, contextWindow: 100_000,
    policy: { freshTurns: 1, freshBytes: 0, minChapterChars: 1 },
  });
  const snapshot = built.snapshot;
  const empty = context.emptyActiveContextState(built.sessionId);
  const span = (turn) => [built.turnEntries[turn][0], built.turnEntries[turn].at(-1)];

  // Two marks with exactly one short turn wedged between them.
  const early = context.manualFoldCandidate(snapshot, empty, span(0));
  const late = context.manualFoldCandidate(snapshot, empty, span(2));
  let state = empty;
  for (const [index, candidate] of [early, late].entries()) {
    state = context.addPendingMark(state, context.foldMarkFor({
      candidate,
      brief: `Completed task ${index} stays exactly recoverable behind this fold.`,
      briefProvenance: { kind: "deterministic" },
      origin: "agent",
      ordinal: 1,
    })).state;
  }
  const absorbed = context.absorbWedgeMarks({ snapshot, state, charsPerToken: 4 });
  assert.equal(absorbed.absorbed.length, 1, "The wedge between two folds was not absorbed");
  assert(absorbed.absorbed[0].tokens <= context.MAX_WEDGE_ABSORB_TOKENS);
  assert(absorbed.absorbed[0].entries >= 1);
  // Later, not earlier: the LATER fold grew backward, which mutates at a shallower
  // prefix position and preserves more cache.
  const grown = context.pendingMarks(absorbed.state)
    .find((mark) => mark.id === absorbed.absorbed[0].intoMarkId);
  assert(grown, "The absorbing mark is not in the resulting state");
  const grownRefs = context.candidateSourceRefs(grown.parts, absorbed.state).map((ref) => ref.entryId);
  assert(grownRefs.includes(absorbed.absorbed[0].startId),
    "The absorbed wedge is not inside the later mark");
  assert(grownRefs.includes(built.turnEntries[2][0]), "The later fold's own span was dropped");
  assert(!grownRefs.includes(built.turnEntries[0][0]), "Absorption swallowed the earlier fold");
  assert(grown.brief.includes("absorbed at commit"), "The absorbing brief does not say so");

  // THE ANTI-LCM PIN. A deliberate multi-thousand-token raw gap between two folds is
  // the agent's curation and is structurally untouchable, at ANY occupancy and after
  // any number of commits. Only a sub-threshold sliver is ever taken.
  const wide = makeFixture({
    turns: 20, tools: false, chapterChars: 900, contextWindow: 100_000,
    policy: { freshTurns: 1, freshBytes: 0, minChapterChars: 1 },
  });
  const wideEmpty = context.emptyActiveContextState(wide.sessionId);
  const wideSpan = (turn) => [wide.turnEntries[turn][0], wide.turnEntries[turn].at(-1)];
  let wideState = wideEmpty;
  for (const [index, turn] of [0, 4].entries()) {
    wideState = context.addPendingMark(wideState, context.foldMarkFor({
      candidate: context.manualFoldCandidate(wide.snapshot, wideEmpty, wideSpan(turn)),
      brief: `Deliberately curated chapter ${index} stays exactly recoverable.`,
      briefProvenance: { kind: "deterministic" },
      origin: "agent",
      ordinal: 1,
    })).state;
  }
  const gapTokens = Math.ceil(
    context.spanBytes(wide.snapshot, wide.snapshot.mapped.findIndex((item) =>
      item.ref?.entryId === wide.turnEntries[1][0]),
    wide.snapshot.mapped.findIndex((item) => item.ref?.entryId === wide.turnEntries[4][0])) / 4,
  );
  assert(gapTokens > context.MAX_WEDGE_ABSORB_TOKENS * 4,
    `The deliberate gap is only ${gapTokens} tokens; it does not test the threshold`);
  for (let commit = 0; commit < 5; commit += 1) {
    const attempt = context.absorbWedgeMarks({
      snapshot: wide.snapshot, state: wideState, charsPerToken: 4,
    });
    assert.deepEqual(attempt.absorbed, [],
      `A deliberate ${gapTokens}-token gap was absorbed on commit ${commit}`);
    wideState = attempt.state;
  }

  // Marked and protected content is exempt at any size.
  const marked = context.addPendingMark(state, context.foldMarkFor({
    candidate: context.manualFoldCandidate(snapshot, empty, span(1)),
    brief: "The wedge itself is a standing decision the agent already made.",
    briefProvenance: { kind: "deterministic" },
    origin: "agent",
    ordinal: 2,
  })).state;
  assert.deepEqual(
    context.absorbWedgeMarks({ snapshot, state: marked, charsPerToken: 4 }).absorbed,
    [],
    "A marked wedge was absorbed",
  );
  const protectedRefs = [snapshot.mapped.find((item) =>
    item.ref?.entryId === built.turnEntries[1][0]).ref];
  const guardedState = { ...state, protected: protectedRefs };
  assert.deepEqual(
    context.absorbWedgeMarks({ snapshot, state: guardedState, charsPerToken: 4 }).absorbed,
    [],
    "A protected wedge was absorbed",
  );
  // The excluded set (the current excursion's own reads) is honoured too.
  assert.deepEqual(
    context.absorbWedgeMarks({
      snapshot,
      state,
      charsPerToken: 4,
      excludeRefKeys: new Set(protectedRefs.map((ref) => json.objectRefKey(ref))),
    }).absorbed,
    [],
    "An excluded wedge was absorbed",
  );

  return {
    thresholdTokens: context.MAX_WEDGE_ABSORB_TOKENS,
    absorbedSlivers: absorbed.absorbed.length,
    absorbedTokens: absorbed.absorbed[0].tokens,
    deliberateGapTokens: gapTokens,
    deliberateGapAbsorbed: 0,
    markedWedgeAbsorbed: 0,
  };
}

/**
 * Overflow rollback and recovery.
 *
 * rep 13's death shape: 370,320 measured tokens against a 383,616 budget, one ordinary
 * inflow step over the line, and the run ended. A provider rejection mutates nothing
 * durable -- the assistant message never lands and the projection is rebuilt from the
 * branch on the next request -- so the terminal path is a rollback, not a death.
 */
async function gateOverflowRecovery() {
  assert.equal(context.OVERFLOW_RECOVERY_MAX_ATTEMPTS, 2);
  const window = 200_000;
  const runtime = makeRuntime(
    makeFixture({ turns: 44, resultChars: 12_000, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, window - 16_384);

  // Calibrate against the fixture's own size, then climb to rep13's position: measured
  // occupancy just under the budget with one ordinary inflow step still to come.
  const baseline = bytesOf((await project(runtime)).messages);
  const charsPerToken = 4;
  await measure(runtime, Math.round(baseline / charsPerToken), window);
  for (const tokens of [150_000, 165_000, 178_000, 181_000]) {
    await measure(runtime, tokens, window);
    await project(runtime);
  }

  // The provider rejects the request the runtime believed was sendable. Nothing
  // durable was written for it: no assistant message, no state event of its own.
  const durableBefore = runtime.branch.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event")).length;
  await runtime.handlers.get("after_provider_response")({ status: 400 }, runtime.ctx);
  assert.equal(runtime.branch.filter((entry) =>
    !String(entry.customType ?? "").endsWith("-context-event")).length, durableBefore,
  "A rejected exchange wrote durable state");
  const pending = (await toolStatus(runtime)).details.automatic.recovery.pendingRejection;
  assert(pending, "The provider rejection was not observed");
  assert.equal(pending.status, 400);

  // The next request is REBUILT rather than dropped, and it is a sealed continuation.
  const recoveredProjection = await project(runtime);
  const recovery = (await toolStatus(runtime)).details.automatic.recovery;
  assert(recovery.last, "The recovery lane never ran");
  assert.equal(recovery.last.status, 400);
  assert(recovery.last.attempts >= 1 && recovery.last.attempts <= context.OVERFLOW_RECOVERY_MAX_ATTEMPTS);
  assert.equal(recovery.pendingRejection, null, "The rejection was not cleared by recovery");
  const rebuiltTokens = Math.ceil(bytesOf(recoveredProjection.messages) /
    (await toolStatus(runtime)).details.automatic.projectionCharsPerToken);
  assert(rebuiltTokens <= budgetTokens || runtime.aborts >= 1,
    `A ${rebuiltTokens}-token request was rebuilt over a ${budgetTokens}-token budget`);
  assert.equal(recovery.last.recovered, true, "The rebuilt request still does not fit");

  // The agent is told, through the receipt mechanism, what was folded to make room.
  const receipts = (await toolStatus(runtime)).details.automatic.curation.receipts;
  const rollback = receipts.find((receipt) => receipt.kind === "overflow-recovery");
  assert(rollback, "The rollback was not receipted");
  assert.equal(rollback.recovered, true);
  assert.match(String(rollback.note), /rollback was required/);
  assert.match(String(rollback.trigger), /^provider-rejection:400$/);
  const block = recoveredProjection.messages.find((message) =>
    message.customType === "pi-fold-active-context-receipts");
  assert(block, "The rollback receipt never reached the window");

  // The cap terminates PROVABLY: an accepted request resets it, and further rejections
  // beyond the cap are not recovered from, so the loop cannot run forever.
  const capped = makeRuntime(
    makeFixture({ turns: 8, tools: false, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(capped);
  await measure(capped, 100_000, window);
  await project(capped);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await capped.handlers.get("after_provider_response")({ status: 400 }, capped.ctx);
    await project(capped);
  }
  const cappedRecovery = (await toolStatus(capped)).details.automatic.recovery;
  assert(cappedRecovery.attempts <= context.OVERFLOW_RECOVERY_MAX_ATTEMPTS,
    `Recovery spent ${cappedRecovery.attempts} attempts against a cap of ` +
    `${context.OVERFLOW_RECOVERY_MAX_ATTEMPTS}`);
  assert.equal(cappedRecovery.pendingRejection, null,
    "A rejection past the cap was queued for another recovery");

  // A 429 is a rate limit, not an overflow, and is deliberately not recovered from.
  await capped.handlers.get("after_provider_response")({ status: 429 }, capped.ctx);
  assert.equal((await toolStatus(capped)).details.automatic.recovery.pendingRejection, null);

  return {
    budgetTokens,
    maxAttempts: context.OVERFLOW_RECOVERY_MAX_ATTEMPTS,
    recoveryAttempts: recovery.last.attempts,
    recovered: recovery.last.recovered,
    rebuiltTokens,
    cappedAttempts: cappedRecovery.attempts,
  };
}

/**
 * Attempt and error instrumentation, unconditional.
 *
 * The external adjudicator reads session artifacts. An agent whose spans keep being
 * refused looks identical, from fold records alone, to an agent that never tried to
 * curate at all, so a rejected call is recorded as loudly as an accepted one and the
 * exact validation text is kept verbatim.
 */
async function gateContextEventStream() {
  const runtime = await epochToolRuntime({ turns: 14, resultChars: 6_000 });
  const built = runtime.built;
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  await toolCall(runtime, { action: "status" });
  await toolCall(runtime, { action: "fold", ids: ["no-such-entry"] }).catch(() => undefined);
  await toolCall(runtime, { action: "fold", marks: [{ ids: ["also-missing"] }] }).catch(() => undefined);
  await toolCall(runtime, {
    action: "fold",
    marks: [0, 1].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  await toolCall(runtime, { action: "commit" });
  for (const tokens of [78_000, 84_000, 88_000, 92_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  await settle();

  // ONE stream, ONE envelope. Every record, whatever its kind, carries the same
  // self-describing header, so a reader dispatches on `kind` and nothing else.
  const records = stream();
  assert(records.length >= 8, "The stream is too sparse to be a timeline");
  for (const record of records) {
    assert.equal(record.v, context.CONTEXT_EVENT_SCHEMA_VERSION);
    assert.equal(typeof record.kind, "string");
    assert(record.kind.startsWith("context."), `A record kind is not namespaced: ${record.kind}`);
    assert.equal(record.session_id, built.sessionId);
    assert(Number.isSafeInteger(record.seq) && record.seq >= 1);
    assert(Number.isSafeInteger(record.ordinal) && record.ordinal >= 0);
    assert(Number.isSafeInteger(record.at) && record.at > 0);
    assert(Number.isSafeInteger(record.revision) && record.revision >= 0);
    // Flat: the payload is scalars, so a query never has to unpack anything.
    for (const [field, value] of Object.entries(record)) {
      assert.equal(/^[a-z][a-z0-9_]*$/.test(field), true, `Field ${field} is not snake_case`);
      assert(value === null || typeof value !== "object",
        `Field ${field} of ${record.kind} nests; the stream must stay flat`);
    }
  }
  // The sequence is monotonic and gapless, so records order without a clock.
  assert.deepEqual(records.map((record) => record.seq),
    records.map((_, index) => index + 1), "The sequence is not monotonic and gapless");

  // Attempts, including refusals, with the exact validation text kept verbatim.
  const attempts = records.filter((record) => record.kind === "context.attempt");
  assert(attempts.length >= 5, "Not every context-management call was recorded");
  const failures = attempts.filter((record) => record.ok === false);
  assert.equal(failures.length, 2, "A rejected call was not recorded as rejected");
  assert(failures.every((record) => typeof record.error === "string" && record.error.length > 0));
  assert(failures.some((record) => /Unknown active-context source no-such-entry/.test(record.error)),
    "The exact validation text was not kept verbatim");
  assert(attempts.some((record) => record.ok === true && record.error === null));
  assert(attempts.every((record) => /^[a-f0-9]{64}$/.test(record.arguments_sha256)));
  assert.equal(attempts.find((record) => record.marks_requested === 2) !== undefined, true,
    "A batched call did not record how many spans it carried");

  // Corrections are their own records, joined to their attempt by seq.
  const existing = materialized(runtime).folds[0];
  await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[4][0], built.turnEntries[4].at(-1)],
    brief: "A whole closed turn whose exact evidence stays recoverable behind this fold.",
  });
  await toolCall(runtime, { action: "commit" });
  const chapter = materialized(runtime).folds.find((fold) => fold.kind === "chapter");
  const insideId = chapter.parts[1].kind === "raw" ? chapter.parts[1].ref.entryId : chapter.parts[1].foldId;
  await toolCall(runtime, {
    action: "fold",
    ids: [insideId, built.turnEntries[4].at(-1)],
    brief: "A corrected span whose exact evidence stays recoverable behind this fold.",
  }).catch(() => undefined);
  await settle();
  const corrections = stream().filter((record) => record.kind === "context.correction");
  assert(corrections.length >= 1, "An auto-snap did not reach the stream as its own record");
  const correction = corrections.at(-1);
  assert(stream().some((record) =>
    record.kind === "context.attempt" && record.seq === correction.attempt_seq),
  "A correction references no attempt");
  assert.equal(typeof correction.reason, "string");
  assert.equal(typeof correction.corrected_start_id, "string");
  assert(correction.reason.includes(chapter.id) ||
    correction.reason.includes(existing.id) ||
    /corrected to/.test(correction.reason));

  // The timeline is reconstructable: commits, the folds they created, projections, the
  // per-handoff prefix comparison, and the provider usage the analyst joins against.
  const kinds = new Set(stream().map((record) => record.kind));
  for (const kind of [
    "context.attempt", "context.correction", "context.commit", "context.fold",
    "context.projection", "context.prefix", "context.usage",
  ]) {
    assert(kinds.has(kind), `The stream carries no ${kind} record`);
  }
  const commits = stream().filter((record) => record.kind === "context.commit");
  const folds = stream().filter((record) => record.kind === "context.fold");
  assert(folds.every((record) =>
    commits.some((commit) => commit.seq === record.commit_seq)),
  "A fold record references no commit");
  assert(commits.every((record) => Number.isSafeInteger(record.applied_marks)));

  // The rewrite-vs-miss discriminator: every transmitted projection carries the byte
  // position the prefix diverged at, the identical share, and OUR attribution for it.
  const prefixes = stream().filter((record) => record.kind === "context.prefix");
  assert(prefixes.length >= 2, "Too few handoffs to compare prefixes");
  for (const record of prefixes) {
    assert(record.divergent_char === null || Number.isSafeInteger(record.divergent_char));
    assert(record.divergent_tokens === null || Number.isSafeInteger(record.divergent_tokens));
    assert(Number.isSafeInteger(record.identical_chars));
    assert(record.identical_share >= 0 && record.identical_share <= 1);
    assert.equal(typeof record.cause, "string");
    assert.equal(typeof record.cause_event_seqs, "string");
  }
  assert(prefixes.some((record) => record.cause === "pure-append"),
    "No handoff was attributed as a pure append");
  const mutated = prefixes.find((record) => record.divergent_char !== null && record.cause !== "pure-append");
  assert(mutated, "No handoff recorded a prefix divergence to attribute");
  assert(mutated.cause === "unattributed" || mutated.cause.includes("context."),
    `A divergence cause is neither an event kind nor unattributed: ${mutated.cause}`);

  // Usage is the join key against provider-side telemetry.
  const usage = stream().filter((record) => record.kind === "context.usage");
  assert(usage.every((record) =>
    Number.isSafeInteger(record.input_tokens) && Number.isSafeInteger(record.cache_read_tokens) &&
    typeof record.provider === "string" && typeof record.message_sha256 === "string"));

  // The in-memory view and the durable stream are the same records, not two conventions.
  const summary = (await toolStatus(runtime)).details.automatic.instrumentation;
  await settle();
  assert.equal(stream().length, summary.contextEvents + 1,
    "The durable stream and the ledger disagree about how many events were emitted");
  assert.equal(summary.contextEventsByKind["context.attempt"], attempts.length + 1);
  assert(summary.events.every((event) => event.v === context.CONTEXT_EVENT_SCHEMA_VERSION));

  return {
    kinds: [...kinds].sort(),
    records: stream().length,
    attempts: attempts.length,
    refusals: failures.length,
    corrections: corrections.length,
    handoffs: prefixes.length,
    pureAppends: prefixes.filter((record) => record.cause === "pure-append").length,
  };
}

/**
 * The lever collapse, pinned from the outside.
 *
 * A deleted option that is silently ignored is worse than one that never existed: a
 * deployment carrying it would believe it had asked for something. Every collapsed
 * lever is refused by name, and the behaviour it used to gate is simply on.
 */
async function gateLeverCollapse() {
  const built = makeFixture({ turns: 8, resultChars: 6_000, contextWindow: 100_000 });
  const collapsed = [
    "ephemeralPeek", "perPeekEphemeral", "truthfulCapacity", "admissionControl",
    "retainPendingMarks", "eligibleShareCommit", "eligibleShareCommitThreshold",
    "statusIndexDiet", "advisoryDelivery", "projectionInstrumentation",
    "stageIdentifiedBriefs", "currentTurnCommitGuard", "pinnedMassBackstop",
  ];
  const surfaced = new Set(Object.keys(SEALED_SPINE));
  for (const option of collapsed) {
    assert.equal(surfaced.has(option), false, `${option} is still configured by the spine fixture`);
  }
  // The constants are gone from the module surface, so nothing can read one back.
  for (const name of [
    "DEFAULT_EPHEMERAL_PEEK", "DEFAULT_TRUTHFUL_CAPACITY", "DEFAULT_ADMISSION_CONTROL",
    "DEFAULT_RETAIN_PENDING_MARKS", "DEFAULT_ELIGIBLE_SHARE_COMMIT", "DEFAULT_STAGE_IDENTIFIED_BRIEFS",
    "DEFAULT_CURRENT_TURN_COMMIT_GUARD", "DEFAULT_PINNED_MASS_BACKSTOP", "DEFAULT_PER_PEEK_EPHEMERAL",
    "DEFAULT_STATUS_INDEX_DIET", "DEFAULT_ADVISORY_DELIVERY", "DEFAULT_PROJECTION_INSTRUMENTATION",
    "DEFAULT_PROVIDER_TOTAL_WINDOW", "RETAINED_MARK_ACTIVE_CONTEXT_TOOL_ACTIONS",
    "EPOCH_TAIL_ADJACENT_MESSAGES", "tailAdjacent",
  ]) {
    assert.equal(context[name], undefined, `${name} survived the collapse`);
  }

  // And the behaviour is on, in a runtime that configures nothing at all.
  const plain = makeRuntime(built, {});
  await startRuntime(plain);
  await measure(plain, 80_000, 100_000);
  await project(plain);
  const status = (await toolStatus(plain)).details.automatic;
  assert.equal(status.instrumentation.enabled, true, "Projection instrumentation is not unconditional");
  assert.equal((await toolStatus(plain)).details.index, "diet", "The status index diet is not unconditional");
  const properties = [...plain.tools.values()][0].parameters.properties;
  assert.equal(properties.retain.type, "boolean", "Ephemeral peek is not unconditional");
  assert.equal(properties.ephemeral.type, "boolean", "The per-peek override is not unconditional");
  assert.equal(properties.marks.type, "array", "Batched marks are not on the surface");
  const actions = [...properties.action.enum];
  assert(actions.includes("rebrief") && actions.includes("reboundary"),
    "The correction verbs are not on the immediate surface");
  const folds = materialized(plain).folds.filter((fold) => fold.kind === "tool-result");
  assert(folds.length >= 1, "The collapse fixture folded nothing");
  assert(/path=/.test(folds[0].brief), "Stage-identified briefs are not unconditional");
  // Capacity is truthful once the deployment declares its window, and says which mode.
  assert.equal(status.capacity.mode, "descriptor");
  const declared = makeRuntime(built, { providerTotalWindow: 400_000 });
  await startRuntime(declared);
  assert.equal((await toolStatus(declared)).details.automatic.capacity.mode, "truthful");

  // What stays configurable is exactly the experiment conditions plus the one fact.
  assert.throws(() => makeRuntime(built, { guidedCuration: "yes" }).tools,
    /guidedCuration must be a boolean/);
  assert.throws(() => makeRuntime(built, { providerTotalWindow: -1 }).tools,
    /providerTotalWindow must be a positive integer/);
  assert.throws(() => makeRuntime(built, { foldScheduling: "later" }).tools,
    /foldScheduling must be one of/);
  assert.equal(context.DEFAULT_GUIDED_CURATION, false);

  return {
    collapsedOptions: collapsed.length,
    survivingConstants: 0,
    unconditionalInstrumentation: true,
    unconditionalDiet: true,
    unconditionalPeekLifetime: true,
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
  [35, "Mark always means mark", gateMarkAlwaysMeansMark],
  [36, "Ephemeral peek auto-mark", gateEphemeralPeekMark],
  [37, "Commit on threshold", gateCommitOnThreshold],
  [38, "Scheduling wire round-trip", gateSchedulingWireRoundTrip],
  [39, "Epoch mark accumulation", gateMarkAccumulation],
  [40, "Epoch inline rung reachability", gateEpochInlineRungs],
  [41, "Surfacing key-order digest stability", gateSurfacingKeyOrder],
  [42, "Peek-fold override reaches a starved ladder", gatePeekFoldOverride],
  [43, "Peek-fold override absence is byte-identical", gatePeekFoldOverrideAbsence],
  [44, "Ephemeral peek reclamation", gateEphemeralPeekReclamation],
  [45, "Truthful capacity & admission control", gateTruthfulCapacityAdmission],
  [46, "Retained pending marks", gateRetainedPendingMarks],
  [47, "Eligible-share commit trigger", gateEligibleShareCommitTrigger],
  [48, "Status index diet", gateStatusIndexDiet],
  [49, "Advisory delivery accounting", gateAdvisoryDelivery],
  [50, "Projection instrumentation", gateProjectionInstrumentation],
  [51, "Stage-identified fold briefs", gateStageIdentifiedBriefs],
  [52, "Current-turn commit guard", gateCurrentTurnCommitGuard],
  [53, "Pinned mass backstop", gatePinnedMassBackstop],
  [54, "Peek lifetime default and per-call override", gatePerPeekEphemeral],
  [55, "Epoch batching under the full lever set", gateEpochBatchingUnderFullLevers],
  [56, "Projection budget fence & guard waiver", gateProjectionBudgetFence],
  [57, "Projection estimator calibration & post-fence integrity", gateProjectionCalibration],
  [58, "Fence margin, calibration recency & commit depth", gateFenceMarginAndDepth],
  [59, "Two-signal curation trigger", gateCurationTrigger],
  [60, "Bounded last-call gate", gateCurationLastCall],
  [61, "Context action receipts", gateContextReceipts],
  [62, "Batched marks & loud auto-snap", gateAutoSnapAndCorrections],
  [63, "Symmetric re-boundary", gateSymmetricReboundary],
  [64, "Bite-sized folds & auto-split", gateBiteSizedFolds],
  [65, "Wedge absorption & the anti-LCM pin", gateWedgeAbsorption],
  [66, "Overflow rollback & recovery", gateOverflowRecovery],
  [67, "Context event stream", gateContextEventStream],
  [68, "Lever collapse", gateLeverCollapse],
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
