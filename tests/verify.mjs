#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const evidenceModule = await jiti.import(join(projectRoot, "extensions", "evidence.js"));

// One synthetic deployment identity, written out in full, so every brand-derived string
// the runtime renders is asserted against a literal rather than another derivation of
// itself. The runtime ships no identity of its own: a deployment supplies the tool name,
// entry types, commands and rendered strings, and this fixture proves that parameter
// actually reaches every surface.
//
// The brand is deliberately neither pi-fold nor any real deployment. The neutrality gate
// asserts this brand appears NOWHERE in the default surface, and the defaults are
// themselves pi-fold-branded, so naming the fixture after this package would make that
// assertion vacuous.
const DEPLOYMENT_IDENTITY_FIXTURE = Object.freeze({
  originName: "Acme",
  registration: Object.freeze({
    toolName: "acme_context",
    entryTypePrefix: "acme-active-context",
    commandNames: Object.freeze({ status: "acme-context", fold: "fold-context" }),
    toolLabel: "Acme Active Context",
    brandNoun: "Acme",
  }),
  toolName: "acme_context",
  commands: Object.freeze(["acme-context", "fold-context"]),
  statusKey: "acme-active-context",
  statusText: "acme_context folds: 0 · provider usage unmeasured",
  entryTypes: Object.freeze([
    "acme-active-context-fold-record",
    "acme-active-context-state",
    "acme-context-event",
    "acme-native-compaction-decision",
    "acme-native-compaction-receipt",
    "acme-provider-context-measurement",
  ]),
  receiptType: "acme-active-context-receipts",
  receiptPrefix: "[Acme context actions] ",
  source: "acme/active-context",
  placeholderPrefix: "[Acme active-context fold ",
  placeholder: (fold) => [
    `[Acme active-context fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=root; children=0; previous=none; next=none.`,
    `Expand exactly: acme_context {"action":"expand","id":"${fold.id}"}`,
    "List/page exactly: acme_context {\"action\":\"status\"}",
  ].join("\n"),
  blockedCompaction: "blocked stock automatic compaction; Acme context folding remains authoritative",
  completedCompaction: "native compaction completed; Acme folding state rebuilt",
  compactionNotice: "Pi native compaction ran; Acme folding state was rebuilt.",
  hardFenceNote: "Provider context reached the hard Acme fence without a newly committed lossless fold. The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.",
  mcpToolName: "mcp__acme__fetch",
  mcpOwnerKind: "acme-mcp",
  mcpOwnerId: "acme:active-context-test",
  evidenceDirectory: "acme-evidence",
  mcpServer: "acme",
  mcpFallbackServer: "acme",
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
  surfacing,
  foldScheduling,
  foldPeekResults,
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
    ...(surfacing === undefined ? {} : { surfacing }),
    ...(foldScheduling === undefined ? {} : { foldScheduling }),
    ...(foldPeekResults === undefined ? {} : { foldPeekResults }),
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

function contextEvents(runtime, from = 0) {
  return runtime.appended
    .slice(from)
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);
}

/**
 * THE COMMIT EPOCH, REACHED THROUGH ITS REAL TRIGGER.
 *
 * There is no agent-callable commit verb: marking is the agent's job and folding is the
 * runtime's. A fixture that needs the epoch to run therefore drives window pressure and
 * reads the epoch back out of the canonical event stream, which is where an external
 * adjudicator reads it from too. The returned shape mirrors the fields the old commit
 * payload carried, so the assertions that used to read a tool result read this instead.
 */
async function runtimeCommit(runtime, {
  tokens,
  contextWindow,
  suffix,
  stopReason = "toolUse",
  measured = true,
} = {}) {
  const window = contextWindow ?? runtime.usage.contextWindow;
  const from = runtime.appended.length;
  if (measured) {
    await measure(runtime, tokens ?? Math.ceil(window * 0.95), window, suffix, stopReason);
  }
  await project(runtime);
  await settle();
  const records = contextEvents(runtime, from);
  const commits = records.filter((record) => record.kind === "context.commit");
  // One pass can carry more than one epoch (the handoff and the projection each run
  // the ladder), so the fixture reads the epoch that FIRED, and the folds of them all.
  const commit = commits.find((record) => record.deferred === false) ?? commits.at(-1) ?? null;
  const folds = records.filter((record) => record.kind === "context.fold");
  const total = (field) => commits.reduce((sum, record) => sum + (record[field] ?? 0), 0);
  return {
    records,
    commits,
    commit,
    fired: Boolean(commit) && commit.deferred === false,
    deferred: commit ? commit.deferred : null,
    reason: commit ? commit.reason : null,
    applied: folds.map((record) => ({
      id: record.mark_id,
      foldId: record.fold_id,
      kind: record.fold_kind,
      origin: record.origin,
    })),
    appliedMarks: total("applied_marks"),
    refusedMarks: total("refused_marks"),
    deferredMarks: commit?.deferred_marks ?? 0,
    pending: commit?.pending_marks ?? 0,
    eligibleMarks: commit?.eligible_marks ?? null,
    freedTokens: total("freed_tokens"),
  };
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

/**
 * Collect one paged status listing COMPLETELY, through bounded pages. A truncated
 * page names the next offset in its continuation marker; an untruncated folds or
 * objects page still advances through the ordinary limit-paging offsets; an
 * untruncated tree page carries everything from its offset and ends the walk.
 */
async function pagedStatusRows(runtime, detail, toolName = "active_context") {
  const rows = [];
  const pages = [];
  let offset = 0;
  for (let page = 0; page < 128; page += 1) {
    const result = await runtime.tools.get(toolName).execute(
      `paged-${detail}-${page}`,
      { action: "status", detail, ...(offset ? { offset } : {}) },
      new AbortController().signal,
      undefined,
      runtime.ctx,
    );
    const payload = result.details;
    rows.push(...payload[detail]);
    pages.push({ bytes: Buffer.byteLength(result.content[0].text, "utf8"), payload });
    let next = null;
    if (typeof payload.continuation === "string") {
      const named = payload.continuation.match(/continue at (\{[^}]*\})/);
      if (named) next = JSON.parse(named[1]).offset;
    }
    if (next === null && detail !== "tree") {
      next = detail === "objects" ? payload.nextObjectOffset : payload.nextOffset;
    }
    if (typeof next !== "number" || next <= offset) break;
    offset = next;
  }
  return { rows, pages };
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

async function chapterForest(count, chapterChars = 3_500) {
  const built = makeFixture({
    turns: Math.max(9, count + 4),
    tools: false,
    chapterChars,
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
    // The receipt is the only carrier a deployment renders now, so it is the only one
    // whose branding can be wrong. It rides the fold that the branding fixture already
    // performs, which is why there is no separate advisory runtime any more.
    const carrierMessages = foldedProjection.messages.filter((message) =>
      typeof message?.customType === "string" && message.customType.endsWith("-receipts"));

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
      carrierTypes: carrierMessages.map((message) => message.customType).sort(),
      carrierTexts: carrierMessages.map((message) => message.content),
      carrierSources: carrierMessages.map((message) => message.details?.source),
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
  assert.deepEqual(surface.carrierTypes, ["pi-fold-active-context-receipts"]);
  assert(surface.carrierTexts.some((text) => text.startsWith("[active-context actions] ")));
  assert.deepEqual(surface.carrierSources, ["pi-fold/active-context"]);
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
  assert.equal(new RegExp(DEPLOYMENT_IDENTITY_FIXTURE.originName, "i").test(json.stableStringify(surface)), false);
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

async function gateDeploymentBrandingReproduction() {
  const fixture = DEPLOYMENT_IDENTITY_FIXTURE;
  const surface = await collectRegistrationSurface(fixture.registration, fixture.mcpToolName);
  assert.equal(surface.toolName, fixture.toolName);
  assert.equal(surface.toolLabel, fixture.registration.toolLabel);
  assert.deepEqual(surface.commands, fixture.commands);
  assert.deepEqual(surface.initialStatus, { key: fixture.statusKey, text: fixture.statusText });
  assert.deepEqual(surface.entryTypes, fixture.entryTypes);
  assert(surface.placeholderTexts.some((text) => text.startsWith(fixture.placeholderPrefix)));
  assert(surface.placeholderTexts.includes(fixture.placeholder(surface.fold)));
  assert.deepEqual(surface.carrierTypes, [fixture.receiptType]);
  assert(surface.carrierTexts.some((text) => text.startsWith(fixture.receiptPrefix)));
  assert.deepEqual(surface.carrierSources, [fixture.source]);
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

async function gateOverflowRegression() {
  const runtime = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }));
  await startRuntime(runtime);
  await measure(runtime, 110_000, 100_000);
  await project(runtime);
  await project(runtime);
  let status = await toolStatus(runtime);
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
  assert.equal(runtime.notifications.filter((notice) => /malformed.*guidance/i.test(notice.message)).length, 0);
  assert(status.details.automatic, "A branch carrying historical guidance entries failed to materialize");
  return { historicalGuidanceEntriesTolerated: true, thrown: false };
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

  const wide = await chapterForest(65, 350);
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
  await measure(runtime, 88_000, 100_000);
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

/**
 * No tracked file may name a person's home directory.
 *
 * This is a publication rule before it is a hygiene rule: the repo goes public, and an
 * absolute home path both identifies its author and hard-codes one machine into work
 * that other people are meant to reproduce. The harness carried 68 of them when it was
 * adopted. Every root it needs is now derived at runtime from the password database, so
 * a new one appearing is a regression rather than a style lapse.
 *
 * No allowlist, deliberately: an exception list is how the first one comes back. A
 * fixture that needs a home-shaped string writes an obviously synthetic one.
 */
async function gateNoOperatorPaths() {
  const grep = spawnSync("git", [
    "-C", projectRoot, "grep", "-I", "-n", "-E", "/(home|Users)/[A-Za-z0-9._-]+", "--", ".",
  ], { encoding: "utf8" });
  assert(grep.error === undefined, `git grep did not run: ${grep.error?.message}`);
  // Exit 1 is git grep's "no matches", which is the passing case. Anything above that is
  // a broken invocation, and treating it as success would make this gate vacuous.
  assert(grep.status === 0 || grep.status === 1,
    `git grep failed with status ${grep.status}: ${grep.stderr}`);
  const offenders = grep.stdout.split("\n").filter((line) => line.trim().length > 0);
  assert.deepEqual(offenders, [],
    `Tracked files name an operator home directory:\n${offenders.join("\n")}`);

  // Prove the pattern is not inert. The known-bad samples are ASSEMBLED rather than
  // written out, because a literal one in this file would be found by the gate itself.
  const known = [["", "home", "someone", "x"].join("/"), ["", "Users", "someone"].join("/")];
  for (const sample of known) {
    assert(new RegExp("/(home|Users)/[A-Za-z0-9._-]+").test(sample),
      `The pattern failed to match ${sample}, so the gate proves nothing`);
  }
  return { trackedOffenders: 0, knownBadSamples: known.length };
}

/**
 * extensions/evidence.js ships to npm, and until now its primitives were covered only
 * by a harness script that could not load in this repo at all. The properties that
 * matter are the ones the fold lattice leans on: a projection may replace a payload in
 * the window only because the payload itself is still recoverable byte for byte, so an
 * artifact must be addressed by its content, written once, and never writable again.
 */
async function gateEvidencePrimitives() {
  const {
    AGENT_RESULT_PROJECTION_BYTES, TOOL_RESULT_PROJECTION_BYTES,
    pinEvidenceFile, utf8Head, utf8Tail, writeEvidenceArtifact,
  } = evidenceModule;
  assert(Number.isInteger(TOOL_RESULT_PROJECTION_BYTES) && TOOL_RESULT_PROJECTION_BYTES > 0);
  assert(AGENT_RESULT_PROJECTION_BYTES >= TOOL_RESULT_PROJECTION_BYTES,
    "An agent result projects less generously than a tool result");

  // A byte budget cut through a multi-byte codepoint would put U+FFFD in the window and
  // silently corrupt the very evidence the projection points at.
  const unicode = `${"é🙂漢字".repeat(8000)}END`;
  const head = utf8Head(unicode, 4097);
  const tail = utf8Tail(unicode, 4097);
  assert(Buffer.byteLength(head, "utf8") <= 4097 && Buffer.byteLength(tail, "utf8") <= 4097);
  assert(!head.includes("�") && !tail.includes("�"), "A budget split a codepoint");
  assert(unicode.startsWith(head) && unicode.endsWith(tail) && tail.endsWith("END"));

  const root = await mkdtemp(join(tmpdir(), "pi-fold-evidence-"));
  try {
    const sessionFile = join(root, "session.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const owner = { sessionFile, ownerKind: "pi-session", ownerId: "evidence-session" };

    // Content addressing, proved by racing two writes of identical bytes: one artifact.
    const payload = Buffer.from("immutable payload\n", "utf8");
    const [first, second] = await Promise.all([
      writeEvidenceArtifact({ ...owner, bytes: payload, mediaType: "text/plain", encoding: "utf-8",
        source: { toolName: "read", toolCallId: "dedup-a", artifactKind: "test" } }),
      writeEvidenceArtifact({ ...owner, bytes: payload, mediaType: "text/plain", encoding: "utf-8",
        source: { toolName: "read", toolCallId: "dedup-b", artifactKind: "test" } }),
    ]);
    assert.equal(first.path, second.path, "Identical bytes wrote two artifacts");
    assert.equal(first.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.deepEqual(await readFile(first.path), payload);
    assert.equal((await stat(first.path)).mode & 0o777, 0o444, "An artifact stayed writable");

    // Pinning copies rather than references: the source may still churn afterwards.
    const mutable = join(root, "pi-bash-output.log");
    const full = `${"early\n".repeat(5000)}FINAL\n`;
    await writeFile(mutable, full, "utf8");
    const pinned = await pinEvidenceFile({ ...owner, sourcePath: mutable,
      source: { toolName: "bash", toolCallId: "bash-pin", artifactKind: "bash-full-output" } });
    assert.notEqual(pinned.path, mutable);
    assert.equal(pinned.bytes, Buffer.byteLength(full));
    const [sourceStat, pinnedStat] = await Promise.all([stat(mutable), stat(pinned.path)]);
    assert(sourceStat.dev !== pinnedStat.dev || sourceStat.ino !== pinnedStat.ino,
      "The pin is a hardlink, so mutating the source would rewrite the evidence");
    assert.equal(pinnedStat.mode & 0o777, 0o444);
    await writeFile(mutable, "mutated", "utf8");
    assert.equal(await readFile(pinned.path, "utf8"), full, "A source rewrite reached the pin");

    return {
      toolProjectionBytes: TOOL_RESULT_PROJECTION_BYTES,
      agentProjectionBytes: AGENT_RESULT_PROJECTION_BYTES,
      contentAddressed: true,
      artifactMode: "0444",
      pinSurvivedSourceRewrite: true,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
  // 68,000 against the 90,000-token serving budget: above the tool-fold rung so the
  // ladder marks, below the 0.80 curation trigger so nothing commits. Mark inertness
  // is only a claim about passes where the runtime was NOT going to rewrite anyway;
  // over the trigger the rewrite belongs to the commit, not to the mark.
  await measure(runtime, 76_000, 100_000);
  const marked = materialized(runtime);
  assert.equal(marked.folds.length, 0, "A mark folded evidence");
  assert.equal(marked.pendingMarks.length, 1);
  assert.equal(marked.pendingMarks[0].mark, "fold");
  assert.equal(marked.pendingMarks[0].kind, "tool-result");
  assert.equal(marked.pendingMarks[0].origin, "ladder");

  // Read the scheduling surface while the mark is still PENDING. A tool call is not a
  // context pass and cannot commit; project() is, and at this occupancy the curation
  // trigger is live, so a projection built first would report the mark already spent.
  const pendingStatus = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(pendingStatus.mode, "epoch");
  assert(pendingStatus.pending >= 1, "The ladder mark was not pending before any context pass");
  assert(pendingStatus.freedWindowShare > 0);
  assert(pendingStatus.rewriteTokens > 0);

  // The whole point: marking moves no projection byte. The durable projection is still
  // the raw transcript, verbatim -- and now there is no ephemeral tail to except,
  // because between commits the runtime renders nothing at all.
  const markedProjection = await project(runtime);
  const durable = (messages) => messages.filter((message) =>
    typeof message?.customType !== "string" ||
    !message.customType.startsWith(context.DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX));
  // The mark moved nothing. Stated the way gate 87 states it, because the ladder now
  // marks at an occupancy where the commit trigger is also live: the projection may
  // differ from the raw transcript ONLY if a commit ran on this pass. With no commit
  // the bytes must be identical, which is the whole claim about marking.
  const committedHere = runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data)
    .some((record) => record.kind === "context.commit" && record.deferred === false);
  if (!committedHere) {
    assert.equal(
      json.stableStringify(durable(markedProjection.messages)),
      json.stableStringify(runtime.messages),
      "A pending mark changed the projection",
    );
  } else {
    assert.equal(materialized(runtime).folds.length > 0, true,
      "A commit ran on the mark pass but folded nothing, so the rewrite bought nothing");
  }

  const status = await toolStatus(runtime);
  const scheduling = status.details.automatic.scheduling;
  assert.equal(scheduling.mode, "epoch");

  // The epoch runs on window pressure, not on an agent verb: there is no commit action
  // to call. The invariants are unchanged, read off the canonical stream instead.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert.equal(committed.refusedMarks, 0);
  const after = materialized(runtime);
  // Whichever lane got there first -- the silent curation trigger on the projection
  // pass, or this pressure commit -- the invariants are the same: no mark is left
  // pending, and every mark that existed became a fold. What is NOT permitted is a
  // mark that quietly disappears without folding.
  // Track the ORIGINAL mark by id rather than demanding an empty pending set: later
  // occupancy can accrue new marks that the current-turn guard rightly retains, and
  // conflating "this mark folded" with "nothing is pending" would hide that.
  assert(after.folds.some((fold) => fold.id === marked.pendingMarks[0].id),
    "The ladder mark never became a fold");
  assert.equal((after.pendingMarks ?? []).some((mark) => mark.id === marked.pendingMarks[0].id), false,
    "The ladder mark was still pending after it had already folded");
  const committedProjection = await project(runtime);
  assert(bytesOf(committedProjection.messages) < rawBytes,
    "The commit epoch did not shrink the projection");

  // A protected span refuses at commit with a message rather than folding.
  const blocked = await epochToolRuntime();
  await measure(blocked, 80_000, 100_000);
  const pending = materialized(blocked).pendingMarks[0];
  const sourceIds = pending.parts.map((part) => part.ref.entryId);
  await toolCall(blocked, { action: "protect", ids: sourceIds });
  const refusal = await runtimeCommit(blocked, { tokens: 88_000, contextWindow: 100_000 });
  // Protection is adjudicated BEFORE the fold is prepared, so the mark is held rather
  // than terminally refused: it never folds, and it is never silently dropped either.
  assert.equal(refusal.applied.some((mark) => mark.id === pending.id), false,
    "A protected span folded");
  assert(refusal.deferredMarks >= 1, "The protected mark was neither folded nor held");
  assert((materialized(blocked).pendingMarks ?? []).some((mark) => mark.id === pending.id),
    "The protected mark was dropped by the commit that refused to apply it");
  assert.equal(materialized(blocked).folds.some((fold) => fold.id === pending.id), false,
    "A protected span produced a fold record");

  return {
    toolActions: context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    markedFolds: marked.folds.length,
    pendingAfterMark: marked.pendingMarks.length,
    projectionUnchangedByMark: true,
    committedFolds: after.folds.length,
    pendingAfterCommit: 0,
    protectedHeld: refusal.deferredMarks,
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
// Moved by the append-only build, for two removed FIELDS and no behaviour change:
//   - `surfacing`, the suggestion log: the selector was its only writer, and nothing
//     renders a suggestion any more.
//   - `advisory`, the pressure high-water and milestone budgets: nothing arms a
//     milestone any more, because an advisory has to arrive before the pressure it
//     warns about and so can only ever ride a pass the runtime was not already
//     rewriting.
// Every scripted session now serializes without those two fields; no immediate-mode
// BEHAVIOUR moved. Prior values, newest first:
//   ea1b456e0288acd366143fcd511856ffad618a8c8c747ae4d90293b05876d9e4 (surfacing removed)
//   35518fbd949c8744ac561682304bd797d9665491bbabfe4443898b8dc62f0e6e (pre-append-only)
const IMMEDIATE_SCRIPTED_STATE_DIGEST =
  "8859a2eb10b328bfc9c77135bc5e69090c779d2106306613ff5198110ba3f70a";

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
  // The commit verb is gone from EVERY surface now, epoch mode included.
  const immediateCommit = await toolCall(runtime, { action: "commit" }).catch((error) => error);
  assert.match(String(immediateCommit), /'commit' is not enabled/);
  assert.equal(context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.includes("commit"), false,
    "The epoch surface still exposes an agent-callable commit verb");

  // The same scripted session in epoch mode reaches a DIFFERENT state, which is the
  // whole point; immediate mode is what must not move.
  const epoch = await scriptedSession("epoch");
  assert.notEqual(normalizedStateDigest(materialized(epoch)), digest);

  // The same digest, from the other side: absent and explicitly false are one
  // deployment, byte for byte, so the peek-fold override cannot move immediate mode.
  const disabled = await scriptedSession(undefined, { foldPeekResults: false });
  assert.equal(normalizedStateDigest(materialized(disabled)), digest,
    "An explicit foldPeekResults:false diverged from the stock deployment");
  assert.equal(
    json.stableStringify((await project(runtime)).messages),
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
  const epochPeek = makeRuntime(peekOnlyFixture(), { foldScheduling: "epoch" });
  await startRuntime(epochPeek);
  assert.equal((await toolStatus(epochPeek)).details.automatic.foldPeekResults, true);
  const epochOff = makeRuntime(peekOnlyFixture(), {
    foldScheduling: "epoch", foldPeekResults: false,
  });
  await startRuntime(epochOff);
  assert.equal((await toolStatus(epochOff)).details.automatic.foldPeekResults, false);

  return {
    digest,
    pendingMarksKey: "absent",
    stateEvents: stateEvents.length,
    toolActions: context.ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    commitRefusedInImmediateMode: true,
    absentEqualsDisabled: true,
    sensitiveFixtureFolds: 0,
    epochDefault: true,
    epochOverridable: true,
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
  assert.equal(agentFold.details.ok, true);
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
  assert.equal(distant.details.ok, true);
  const near = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[10][2]],
    brief: "The recently completed inspection is stale and its exact output stays recoverable.",
  });
  assert.equal(near.details.ok, true, "A tail-adjacent span still folded inline");
  const state = materialized(runtime);
  assert.equal(state.folds.length, 0, "A fold landed without a commit");
  assert.equal(state.pendingMarks.length, 2);

  // And the geometry the exemption used is gone from the surface entirely, so nothing
  // can reinstate it by reading a constant that still exists.
  assert.equal(context.tailAdjacent, undefined, "The tail-adjacent exemption is still callable");
  assert.equal(context.EPOCH_TAIL_ADJACENT_MESSAGES, undefined);
  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(Object.hasOwn(scheduling, "tailAdjacentMessages"), false);

  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  const appliedIds = new Set(committed.applied.map((mark) => mark.id));
  assert(appliedIds.has(distant.details.id), "The distant mark was not applied");
  assert.equal(committed.records.filter((record) => record.kind === "context.commit").length, 1,
    "Both marks needed more than one commit");
  // Both marks are consumed by that one commit: applied outright, or merged into an
  // adjacent fold by the wedge absorber, which rides the same rewrite.
  assert.equal(materialized(runtime).pendingMarks, undefined,
    "A mark survived the commit that should have consumed it");
  assert(materialized(runtime).folds.length >= 2, "The tail-adjacent span never folded");
  return {
    distantMarked: true,
    tailAdjacentMarked: true,
    foldsBeforeCommit: state.folds.length,
    appliedInOneCommit: committed.applied.length,
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
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert.equal(committed.commit.peek_marks, 1, "The peek read was not auto-marked by the epoch");
  assert.equal(committed.commit.agent_marks, 1);
  const peekFold = committed.applied.find((mark) => mark.origin === "agent");
  assert(peekFold, "The auto-marked peek read was not applied");
  const folded = materialized(runtime);
  assert(folded.folds.some((fold) => fold.id === peekFold.foldId && fold.kind === "tool-result"),
    "The peek read did not become a tool-result fold");
  return {
    peekMarks: marks.length,
    peekMarkOrigin: marks[0].origin,
    expandedPeekExempt: true,
    immediateModePeekMarks: 0,
    autoFoldedOnCommit: committed.applied.length,
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

  // The record ring itself: every record keys on a prefix digest, and the ring is
  // bounded. Restated at iteration 8 against the ring's own constructor: the status
  // page now delivers a bounded tail of these records, so the page is no longer the
  // place to prove ring-construction properties.
  const recordLedger = context.emptyLedger();
  context.recordProjection(recordLedger, context.compareProjections(null, ["a", "b"]), ["da", "db"]);
  context.recordProjection(recordLedger, context.compareProjections(["a", "b"], ["a", "z"]), ["da", "dz"]);
  assert(recordLedger.records.every((record) => /^[a-f0-9]{64}$/.test(record.prefixSha256)),
    "A projection record carries no prefix digest");
  assert.equal(recordLedger.records.at(-1).firstDivergentIndex, 1);
  for (let index = 0; index < 70; index += 1) {
    context.recordProjection(
      recordLedger,
      context.compareProjections(["a"], ["a", `x${index}`]),
      ["da", `dx${index}`],
    );
  }
  assert.equal(recordLedger.records.length, context.MAX_PROJECTION_HASH_RECORDS,
    "The record ring is unbounded");

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
  // Restated at iteration 8: the per-observation content is read from the DURABLE
  // context.usage and context.projection events, the same ledger records on the
  // carrier an external adjudicator reads. The status page now delivers a bounded
  // newest-kept tail of these arrays, so it stops being the completeness witness.
  const usageEvents = contextEvents(runtime).filter((event) => event.kind === "context.usage");
  assert.equal(
    usageEvents.filter((event) => event.cache_read_tokens === 0).length,
    ledgerNow.observedCacheMisses,
  );
  assert.equal(
    usageEvents.filter((event) => event.provider_side_miss).length,
    ledgerNow.providerSideCacheMisses,
  );
  assert.equal(
    usageEvents.filter((event) =>
      event.cache_read_tokens === 0 && event.projection_change !== "rewrite").length,
    ledgerNow.providerSideCacheMisses,
  );

  const projectionEvents = contextEvents(runtime)
    .filter((event) => event.kind === "context.projection");
  const rewrite = projectionEvents.find((event) => event.change === "rewrite");
  assert.equal(typeof rewrite.first_divergent_index, "number",
    "A rewrite recorded no divergence point");
  const appended = projectionEvents.filter((event) => event.change === "append");
  assert(appended.every((event) => event.first_divergent_index === null),
    "An append recorded a prefix divergence");
  assert(ledgerNow.projectionRecords.length <= 64, "The record ring is unbounded");
  assert(usageEvents.every((event) =>
    typeof event.input_tokens === "number" && typeof event.cache_read_tokens === "number"));

  // It reaches the envelope the harness reads alongside the existing accounting.
  const epoch = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    { foldScheduling: "epoch" },
  );
  await startRuntime(epoch);
  // Below the curation trigger (0.80 of the 90,000-token budget), so the explicit
  // commit below is the FIRST one and still has marks to apply. Above it the quiet
  // runtime commits on its own and the explicit call finds nothing left to do.
  await measure(epoch, 68_000, 100_000);
  await project(epoch);
  const committed = await runtimeCommit(epoch, { tokens: 88_000, contextWindow: 100_000 });
  assert.equal(typeof committed.commit.freed_tokens, "number");
  const epochLedger = (await toolStatus(epoch)).details.automatic.instrumentation;
  assert.equal(typeof epochLedger.projectionRewrites, "number");
  assert.equal(typeof epochLedger.providerSideCacheMisses, "number");

  // The context-event stream rides the same ledger and lands durably, which is what
  // an external adjudicator reads: an attempt record for every call, accepted or not.
  // Restated at iteration 8: read from the durable stream itself; the status page
  // carries a bounded tail of it.
  await toolCall(epoch, { action: "status" });
  await toolCall(epoch, { action: "peek", id: "no-such-fold" }).catch(() => undefined);
  const attempts = contextEvents(epoch).filter((event) => event.kind === "context.attempt");
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
  const leanResult = await toolStatus(lean);
  const pagedFoldsResult = await toolStatus(lean, "active_context", "folds");
  const leanStatus = leanResult.details;
  const pagedFolds = pagedFoldsResult.details;
  const pagedObjects = (await toolStatus(lean, "active_context", "objects")).details;
  assert(leanStatus.totalFolds >= 3, "The fixture built too small an index to measure");

  // The tree and the object list stop riding along; the counts stay, and the full
  // lists are reachable behind an explicit paged query.
  assert.equal(leanStatus.index, "diet");
  assert.equal(Object.hasOwn(leanStatus, "folds"), false);
  assert.equal(Object.hasOwn(leanStatus, "objects"), false);
  assert(Array.isArray(pagedFolds.folds) && Array.isArray(pagedObjects.objects));
  // Restated at iteration 8: the diet's relative claim (smaller than the paged
  // payload) became an absolute one. Every status page, diet and paged alike, now
  // fits the hard byte cap, so "smaller than a 92KB page" is subsumed by "bounded".
  for (const result of [leanResult, pagedFoldsResult]) {
    assert(Buffer.byteLength(result.content[0].text, "utf8") <= context.CONTEXT_STATUS_RESPONSE_BYTES,
      "A status page exceeded the hard byte cap");
  }
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
  // The tree is read through its bounded pages, which is how an agent now reads it.
  const tree = (await pagedStatusRows(lean, "tree")).rows;
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
    pagedStatusBytes: Buffer.byteLength(pagedFoldsResult.content[0].text, "utf8"),
    dietStatusBytes: Buffer.byteLength(leanResult.content[0].text, "utf8"),
    statusByteCap: context.CONTEXT_STATUS_RESPONSE_BYTES,
    pagedBriefs: pagedFolds.folds.length,
    topFolds: leanStatus.topFolds.length,
    sourceMapEntries: leanStatus.sourceMap.length,
    pagedFoldsMatchDefault: true,
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
  // Accept-and-hold: a fresh span is ACCEPTED and deferred, never refused.
  assert.equal(marked.details.ok, true);
  assert.equal(marked.details.deferred, true);
  assert.equal(bytesOf((await project(runtime)).messages), before, "A mark moved projection bytes");
  const pendingId = marked.details.id;
  assert.equal(materialized(runtime).pendingMarks.length, 1);

  // A tail-adjacent span no longer takes the inline shortcut: it is a mark too.
  const tailSpan = [built.turnEntries[8][0], built.turnEntries[8].at(-1)];
  const tailMark = await toolCall(runtime, {
    action: "fold", ids: tailSpan, brief: "The previous task stays exactly recoverable behind this fold.",
  });
  assert.equal(tailMark.details.ok, true, "A tail-adjacent span still folded inline");
  assert.equal(materialized(runtime).folds.length, 0);

  // A stale span alongside them, so one commit has both kinds of mark to sort.
  const staleSpan = [built.turnEntries[1][0], built.turnEntries[1].at(-1)];
  const staleMark = await toolCall(runtime, {
    action: "fold", ids: staleSpan, brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  assert.equal(staleMark.details.deferred, false);

  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(scheduling.pending, 3);
  assert.equal(scheduling.eligibleMarks + scheduling.retainedMarks, 3);
  assert(scheduling.eligibleMarks >= 1, "The stale mark was not counted as eligible");
  assert(scheduling.retainedMarks >= 1, "The fresh mark was not counted as retained");
  assert(scheduling.marks.every((mark) => ["eligible", "protected"].includes(mark.eligibility)));

  // The commit applies what it can and KEEPS the rest, with the reason stated.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.deferredMarks >= 1, "An ineligible mark was dropped by the commit");
  assert(committed.applied.length >= 1, "The eligible mark was not applied");
  assert.equal(committed.applied.length + committed.deferredMarks, committed.pending);
  assert.equal(committed.refusedMarks, 0, "A held mark was counted as a terminal refusal");
  const survivors = materialized(runtime).pendingMarks;
  assert(survivors.some((mark) => mark.id === pendingId), "The retained mark did not survive the commit");

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
    retainedAtCommit: committed.deferredMarks,
    appliedAtCommit: committed.applied.length,
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

  const truthfulRuntime = makeRuntime(fixture(), { providerTotalWindow: 400_000 });
  await startRuntime(truthfulRuntime);
  await measure(truthfulRuntime, 297_000, 272_000);
  await project(truthfulRuntime);
  assert.equal(truthfulRuntime.aborts, 0, "The truthful budget aborted inside real headroom");
  const capacity = (await toolStatus(truthfulRuntime)).details.automatic.capacity;
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
    truthfulAborts: truthfulRuntime.aborts,
    refusedTokens: Math.ceil(big.sourceChars / bytesPerToken),
    headroomTokens: headroom,
    alternativesOffered: alternatives.length,
    narrowedBytes: narrowed.details.returnedBytes,
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
  const rider = await epochToolRuntime({ turns: 40 });
  await measure(rider, 78_000, 100_000);
  const pendingId = materialized(rider).pendingMarks[0].id;
  await runtimeCommit(rider, { tokens: 88_000, contextWindow: 100_000 });
  const riderState = materialized(rider);
  const target = riderState.folds[0].id;
  // A span the pressure commit left raw: the epoch reaches further than the single mark
  // the agent path used to apply, so the second mark has to be chosen, not assumed.
  const covered = new Set();
  const walk = (parts) => {
    for (const part of parts) {
      if (part.kind === "raw") covered.add(part.ref.entryId);
      else walk(riderState.folds.find((fold) => fold.id === part.foldId)?.parts ?? []);
    }
  };
  for (const fold of riderState.folds) walk(fold.parts);
  const freeEntry = rider.built.turnEntries
    .slice(1, -3)
    .map((entries) => entries[2])
    .find((id) => !covered.has(id));
  assert(freeEntry, "The pressure commit left the rider fixture nothing to mark");
  await toolCall(rider, { action: "fold", ids: [freeEntry],
    brief: "A second completed inspection is stale and its exact output stays recoverable." });
  assert.equal(materialized(rider).pendingMarks.length, 1);
  // The commit left the window near the fence; the restore needs room to land in.
  await measure(rider, 55_000, 100_000);
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
  //
  // Recompute the expectation against the state as it stands at the MOMENT the epoch
  // runs, not against the snapshot taken further up. Under the quiet cadence a commit
  // can land between the two, and an expectation derived from a stale pending set
  // measures the gap between the snapshots rather than the guard.
  const atEpoch = materialized(runtime);
  const epochSnap = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 200_000,
  });
  const epochKeys = context.currentTurnRefKeys(epochSnap);
  // The property, stated directly: EVERY pending mark that touches the still-open turn
  // is retained. The old expectation added the non-eligible marks on top, which held
  // only because that fixture's whole pending set was current-turn; with the quiet
  // cadence the set also carries older marks, and adding them measured nothing.
  const epochTurnMarks = (atEpoch.pendingMarks ?? []).filter((mark) =>
    context.markTouchesCurrentTurn(atEpoch, mark, epochKeys));
  assert(epochTurnMarks.length >= 3,
    `Only ${epochTurnMarks.length} current-turn marks survived to the epoch`);
  await measure(runtime, 176_000, 200_000, undefined, "toolUse");
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "No commit epoch ran");
  assert.equal(epoch.currentTurnRetained, epochTurnMarks.length,
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

  // Unprotected, those reads are ordinary ladder food and count as nothing held.
  assert.equal(context.markAccounting(snapshot, folded).pinnedBytes, 0);
  // Protection is now the ONLY way a peek read is held back from the ladder: peek
  // results are append-only, so the mass that can starve a commit is the mass the
  // agent protected outright.
  const peekRefs = snapshot.mapped
    .filter((item) => item.ref && ["call-0", "call-8"].includes(item.message?.toolCallId))
    .map((item) => item.ref);
  assert.equal(peekRefs.length, 2, "The fixture did not carry two peek results");
  const held = { ...folded, protected: peekRefs.map((ref) => structuredClone(ref)) };
  const heldAccounting = context.markAccounting(snapshot, held);
  assert(heldAccounting.pinnedBytes > 0, "Protected peek mass is still invisible in the accounting");
  assert.equal(heldAccounting.pinnedResults, 2);

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
    pinnedBytes: heldAccounting.pinnedBytes,
    pinnedResults: heldAccounting.pinnedResults,
    ineligibleFreedShare: Number(starvedAccounting.freedWindowShare.toFixed(3)),
    anchorTopUpMarks: anchorTopUp.length,
    backstopTopUpMarks: eligibleTopUp.length,
    backstopEligibleShare: Number(toppedUpAccounting.eligibleFreedWindowShare.toFixed(3)),
    backstopAppliedMarks: epoch.appliedMarks,
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
  const marksAtCloseIds = new Set(materialized(runtime).pendingMarks.map((mark) => mark.id));
  const pendingAtClose = marksAtCloseIds.size;
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
  // The ACCUMULATED batch leaves nothing behind. What may still be pending afterwards is
  // a mark this same pass created by topping the epoch up, over a span the fresh window
  // still protects -- refused with a stated reason and retained, never silently dropped.
  const stillPending = materialized(runtime).pendingMarks ?? [];
  assert(stillPending.every((mark) => !marksAtCloseIds.has(mark.id)),
    `The batched commit left ${stillPending.filter((mark) => marksAtCloseIds.has(mark.id)).length} ` +
    "accumulated marks pending");
  assert(stillPending.every((mark) => closing.epoch.refused.some((refusal) =>
    refusal.id === mark.id && refusal.retained === true && typeof refusal.reason === "string")),
  "A mark survived the batched commit without a stated retention reason");
  assert(stillPending.length <= 1,
    `The batched commit left ${stillPending.length} marks pending; only the newest read may survive it`);

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
    marksStillPending: stillPending.length,
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
    makeFixture({ turns: 16, resultChars: 12_000, contextWindow: 34_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 34_000 },
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
      content: [{ type: "text", text: `Overflow ${step}: ${"o".repeat(6_000)}` }],
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
    contextWindow: 34_000,
  });
  const boundary = context.currentTurnBoundary(openSnapshot);
  assert(boundary < runtime.messages.length - 24,
    "The turn boundary advanced into the excursion, so the starving guard is not being measured");
  assert(context.currentTurnRefKeys(openSnapshot).size >= 12,
    "The guard does not hold the excursion, so there is nothing for the waiver to release");

  // A calm measured ratio, well under the hard fence: the lagging fence sees nothing.
  await measure(runtime, 24_000, 34_000, undefined, "toolUse");
  const status = await toolStatus(runtime);
  const budgetTokens = status.details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 30_600, "The serving budget is not the window minus the reservation");
  assert(status.details.automatic.pressureRatio < context.hardFenceRatio({ contextWindow: 34_000 }),
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
    makeFixture({ turns: 8, tools: false, chapterChars: 40, contextWindow: 34_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 34_000 },
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
  await measure(guardedOnly, 24_000, 34_000, undefined, "toolUse");
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
  // NOTE ON SCOPE. Exactly ONE thing was dropped from this gate: the assertions that
  // the fence FIRES AND REDUCES, which gate 56 ("neither reduced nor recorded") and
  // gate 58 ("never fired while the window filled") both cover, gate 58 with a margin
  // requirement this gate never had.
  //
  // Two properties stay because nothing else covers them:
  //   - the fixed 4-byte constant is DECISION-CHANGING. naiveTokens > budget while the
  //     session's own measured ratio puts it under three quarters full. Gate 58 bounds
  //     estimator DRIFT against the declared token count; it never compares a
  //     fixed-constant estimate to the serving budget, so only this gate proves the
  //     rep12 regression reproduces on a half-full session.
  //   - post-fence integrity: six passes after the fence acts, every durable top-level
  //     fold id still appears in the projection and nothing approaches corpus size.
  //     That is the tail of the rep12 death, where an aborted pass handed back the raw
  //     branch and a 1,322,385-char projection was recorded as 3,952,934.
  // A session whose declared measurements say SEVEN serialized chars per token, which
  // is what rep12 actually ran at. Under the old fixed constant every one of these
  // projections reads as far over budget; against the session's own measured ratio
  // they are barely half of it.
  const built = makeFixture({ turns: 64, resultChars: 2_200, contextWindow: 40_000 });
  const runtime = makeRuntime(built, { ...SEALED_SPINE, providerTotalWindow: 40_000 });
  await startRuntime(runtime);
  const sevenChars = (chars) => Math.round(chars / 7);
  const baseline = bytesOf((await project(runtime)).messages);
  await measure(runtime, sevenChars(baseline), 40_000);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 36_000, "The truthful serving budget moved");

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
  // Stated so it can fail: a calibrated half-full session must record NO reduction at
  // all. The previous form was `?.transmitted ?? true`, which passes when the field is
  // null -- that is, in exactly the case it claimed to be checking.
  assert.equal((await toolStatus(runtime)).details.automatic.overBudgetReduction, null,
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
    makeFixture({ turns: 12, resultChars: 8_000, contextWindow: 12_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 12_000 },
  );
  await startRuntime(dense);
  // Calibrate on a healthy pass, then let the excursion outgrow that baseline by half.
  // This is the real over-budget shape: not a mis-estimated session, a session that
  // genuinely gathered more than it can send.
  await measure(dense, 10_080, 12_000);
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
      content: [{ type: "text", text: `Growth ${step}: ${"g".repeat(4_800)}` }],
      isError: false,
      timestamp: 700 + step,
    }, "growth");
  }
  dense.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Gathered the excursion." }],
    stopReason: "stop",
    timestamp: 760,
  }, "growth");
  const denseRaw = bytesOf(dense.messages);
  const afterFence = await project(dense);
  await settle();
  // THAT the fence acts is gate 56's and gate 58's job, and both test it harder than
  // this fixture did: gate 56 asserts the reduction is recorded, gate 58 asserts it
  // fires with a margin before the budget rather than after it. What is unique HERE is
  // what happens on the passes AFTER the fence has acted, so the pre-conditions are
  // observed rather than asserted.
  //
  // Note on the quiet cadence, measured: the commit fires on this same pass and takes
  // the foldable mass first, so the fence's own rung finds nothing to fold and ABORTS
  // the pass instead of reducing it. That is the correct safety ordering -- refusing to
  // transmit beats transmitting over budget -- and it is why overBudgetReduction is
  // null here despite the projection genuinely shrinking. The shrink is the commit's.
  assert(bytesOf(afterFence.messages) < denseRaw,
    "The pass that hit the fence handed back the raw branch instead of the projection");

  // Every subsequent pass keeps projecting from the durable folds: placeholders stay
  // placeholders, the raw sources never come back, and nothing approaches corpus size.
  const sizes = [];
  for (let step = 0; step < 6; step += 1) {
    await measure(dense, 10_080 + step * 12, 12_000, undefined, "toolUse");
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
    rawChars: denseRaw,
    projectionAfterFenceChars: bytesOf(afterFence.messages),
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
  const window = 20_000;
  const sevenChars = (chars) => Math.round(chars / 7);
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 18_000, "The truthful serving budget moved");

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
      content: [{ type: "text", text: `Stage ${step}: ${"s".repeat(10_000)}` }],
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
  // Held at 4,000 result chars: calibration needs 20,000 measured chars and 5,000
  // measured tokens per pass, absolute floors this section cannot scale under.
  const drifting = makeRuntime(
    makeFixture({ turns: 16, resultChars: 4_000, contextWindow: 200_000 }),
    { ...SEALED_SPINE, providerTotalWindow: 200_000 },
  );
  await startRuntime(drifting);
  const ratios = [];
  for (const perToken of [7, 7, 7, 5, 5, 5]) {
    const chars = bytesOf((await project(drifting)).messages);
    await measure(drifting, Math.round(chars / perToken), 200_000, undefined, "toolUse");
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
  for (let step = 0; step < 5; step += 1) {
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
    staleToolShare: staleBytes / 4 / 90_000,
    staleToolTokens: Math.ceil(staleBytes / 4),
    staleToolResults: 4,
    eligibleFolds: 4,
  });
  const occupancyAt = (share) => Math.ceil(share * 90_000);
  const staleAt = (share) => share * 90_000 * 4;
  const fires = (occupancyShare, staleShare) =>
    context.curationTriggerFires(signals(occupancyAt(occupancyShare), staleAt(staleShare)));

  // Each side of each threshold, and the AND between them.
  assert.equal(context.CURATION_OCCUPANCY_SHARE, 0.80);
  assert.equal(context.CURATION_STALE_TOOL_SHARE, 0.20);
  assert.equal(fires(0.80, 0.20), true, "The trigger did not fire at both thresholds");
  assert.equal(fires(0.79, 0.20), false, "The trigger fired below the occupancy threshold");
  assert.equal(fires(0.80, 0.19), false, "The trigger fired below the stale-mass threshold");
  assert.equal(fires(0.99, 0.19), false, "Occupancy alone fired the trigger");
  assert.equal(fires(0.10, 0.99), false, "Stale mass alone fired the trigger");
  assert.equal(fires(0.90, 0.60), true);
  assert.equal(
    context.curationTriggerFires(signals(null, staleAt(0.9))),
    false,
    "An unmeasured window fired the trigger",
  );

  // Live: the signals the runtime reports come from the same measurement the fence uses.
  const runtime = makeRuntime(built, { ...SEALED_SPINE });
  await startRuntime(runtime);
  await measure(runtime, 76_000, 100_000);
  await project(runtime);
  const live = (await toolStatus(runtime)).details.automatic.curation;
  assert.equal(live.occupancyThreshold, 0.80);
  assert.equal(live.staleToolThreshold, 0.20);
  assert(live.signals, "The runtime reported no curation signals");
  assert(live.signals.occupancy > 0.8, "The live fixture did not reach the occupancy threshold");
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
  // Restated at iteration 8: read the durable stream directly; the status page
  // carries a bounded tail of it.
  const events = contextEvents(runtime).filter((event) => event.kind === "context.receipt");
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
  assert(batched.details.marks.every((mark) => mark.ok === true));
  assert.equal(new Set(batched.details.marks.map((mark) => mark.id)).size, 3);
  assert.deepEqual(batched.details.corrections, []);
  assert.equal(materialized(runtime).pendingMarks.length, 3);
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  const batchIds = new Set(batched.details.marks.map((mark) => mark.id));
  assert.equal(committed.records.filter((record) => record.kind === "context.commit").length, 1,
    "The batch did not commit together");
  assert.equal((materialized(runtime).pendingMarks ?? []).filter((mark) => batchIds.has(mark.id)).length, 0,
    "The batch did not commit together");

  // A span that starts strictly INSIDE an existing fold snaps to that fold's boundary,
  // and the correction is reported by name rather than silently reinterpreted.
  await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[4][0], built.turnEntries[4].at(-1)],
    brief: "A whole closed turn whose exact evidence stays recoverable behind this fold.",
  });
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
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
  const correction = snapped.details.corrections.find((item) =>
    json.stableStringify(item.from) === json.stableStringify([inside, later])) ??
    snapped.details.corrections[0];
  assert(correction.reason.includes(existing.id),
    `The correction did not name the fold it crossed: ${correction.reason}`);
  assert.match(correction.reason, /corrected (to|outward)/);
  assert.deepEqual([...correction.from].sort(), [inside, later].sort());
  assert.equal(correction.to.length, 2);
  assert.notDeepEqual(correction.to, correction.from);

  // The snap invariant, over every span this fixture can express: what comes back is a
  // span this same validation accepts, and what does not come back is refused ONCE. A
  // refusal may never answer with a "nearest valid span" the same check then rejects.
  //
  // Measured 2026-08-06: a span cutting into the fold on its LEFT and the fold on its
  // RIGHT had no endpoint correction at all -- absorb, exclude and nearest each left a
  // whole chapter inside the span, which a chapter may not swallow -- and the snap
  // proposed one anyway, so the agent was handed a correction that could not be applied.
  const invariantState = materialized(runtime);
  const invariantSnapshot = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const spanIds = invariantSnapshot.mapped.filter((item) => item.ref).map((item) => item.ref.entryId);
  let snapAccepted = 0;
  let snapCorrected = 0;
  let snapRefused = 0;
  for (let left = 0; left < spanIds.length; left += 1) {
    for (let right = left; right < spanIds.length; right += 1) {
      let resolved;
      try {
        resolved = context.snapFoldCandidate(
          invariantSnapshot, invariantState, [spanIds[left], spanIds[right]], { allowProtected: true });
      } catch (error) {
        snapRefused += 1;
        assert(!/was also refused/.test(error.message) && !/nearest valid span/.test(error.message),
          `A refusal proposed a span that failed the same validation: ${error.message}`);
        continue;
      }
      snapAccepted += 1;
      if (resolved.corrections.length) snapCorrected += 1;
      // Validated by construction, and it must still say what it moved.
      assert(resolved.candidate.sourceRefs.length >= 1, "A snapped candidate carries no evidence");
      assert(resolved.corrections.every((entry) =>
        typeof entry.reason === "string" && entry.reason.length > 0),
      "A snapped candidate reported a correction with no reason");
    }
  }
  assert(snapCorrected >= 1, "No span in the fixture exercised the snap");
  assert(snapRefused >= 1, "No span in the fixture exercised the refusal");

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
  // Restated at iteration 8: the row is found by walking the bounded pages, which is
  // how an agent reaches any fold row now that one page never exceeds the byte cap.
  const paged = (await pagedStatusRows(runtime, "folds")).rows;
  assert(paged.find((row) => row.id === target.id).brief.startsWith("Corrected:"));
  await assert.rejects(
    () => toolCall(runtime, { action: "rebrief", id: target.id, brief: "  " }),
    /rebrief requires a nonempty brief/,
  );

  return {
    batchedMarks: batched.details.marks.length,
    appliedTogether: committed.applied.length,
    correctionsReported: snapped.details.corrections.length,
    snapAccepted,
    snapCorrected,
    snapRefused,
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
  const window = 56_000;
  const runtime = makeRuntime(
    makeFixture({ turns: 12, resultChars: 12_000, contextWindow: window }),
    { ...SEALED_SPINE, providerTotalWindow: window },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, window - Math.floor(window * 0.1));

  // Calibrate against the fixture's own size, then climb to rep13's position: measured
  // occupancy just under the budget with one ordinary inflow step still to come.
  const baseline = bytesOf((await project(runtime)).messages);
  const charsPerToken = 4;
  await measure(runtime, Math.round(baseline / charsPerToken), window);
  for (const tokens of [41_200, 45_300, 48_800, 49_700]) {
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
  await measure(capped, 28_000, window);
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
  await toolCall(runtime, { action: "status", detail: "fold_candidates" });
  await toolCall(runtime, { action: "fold", ids: ["no-such-entry"] }).catch(() => undefined);
  await toolCall(runtime, { action: "fold", marks: [{ ids: ["also-missing"] }] }).catch(() => undefined);
  await toolCall(runtime, {
    action: "fold",
    marks: [0, 1].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
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
  await runtimeCommit(runtime, { tokens: 94_000, contextWindow: 100_000 });
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
  const attemptsNow = stream().filter((record) => record.kind === "context.attempt").length;
  assert.equal(summary.contextEventsByKind["context.attempt"] + 1, attemptsNow,
    "The attempt ledger and the durable stream disagree about how many calls were made");
  assert(summary.events.every((event) => event.v === context.CONTEXT_EVENT_SCHEMA_VERSION));

  return {
    kinds: [...kinds].sort(),
    records: stream().length,
    attempts: attemptsNow,
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
    "reclaimedPeeks", "peekReclaimText", "peekLifetimeIsEphemeral", "withPinnedPeek",
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
  // Peek is APPEND-ONLY, so the two arguments that steered its reclamation are gone
  // from the surface entirely rather than collapsed to a default.
  assert.equal(properties.retain, undefined, "retain survived the peek reclamation cut");
  assert.equal(properties.ephemeral, undefined, "ephemeral survived the peek reclamation cut");
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

/**
 * The quiet runtime, and the rep-15 storm replay.
 *
 * Rep 15 accumulated stale mass early and the eligible-share cadence trigger fired 164
 * commit events from ordinal 17, every one of them bypassing the announced gate. Under
 * guided curation that trigger is gone: below the curation threshold NOTHING folds
 * automatically, however much marked mass has piled up.
 */
async function gateQuietRuntimeStormReplay() {
  const built = makeFixture({ turns: 20, resultChars: 14_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built, { ...SEALED_SPINE });
  await startRuntime(runtime);
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);
  const commits = () => stream().filter((record) =>
    record.kind === "context.commit" && record.deferred === false);

  // Stale mass from the earliest ordinals, exactly the rep-15 shape.
  await toolCall(runtime, {
    action: "fold",
    marks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  const marked = (await toolStatus(runtime)).details.automatic.scheduling;
  assert(marked.eligibleFreedWindowShare >= context.EPOCH_ELIGIBLE_SHARE_COMMIT_THRESHOLD,
    `The replay needs mass over the old cadence threshold; it carried ${marked.eligibleFreedWindowShare}`);

  // The whole climb below the threshold: not one automatic commit, not one new fold.
  const foldsBefore = materialized(runtime).folds.length;
  // Small inflow steps on purpose: the transmission fence reduces when a projection is
  // CROWDED (estimate plus margin over budget), and the margin grows with the inflow
  // step. This gate is about the curation flow, so the safety net must stay unarmed.
  for (const tokens of [24_000, 34_000, 44_000, 54_000, 62_000, 68_000]) {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    await project(runtime);
  }
  await settle();
  assert.equal(commits().length, 0,
    `The runtime folded ${commits().length} time(s) below the curation threshold`);
  assert.equal(materialized(runtime).folds.length, foldsBefore);

  // Crossing the threshold lands exactly ONE deep commit, and says NOTHING first.
  //
  // Which lane carries it is not the property under test: at 0.80 of a 90,000-token
  // synthetic budget the fence's crowded margin (a share of the estimator's own error)
  // sits right on the trigger, so the sanctioned safety net can reach the same commit
  // one pass before the trigger does. What is pinned is the count -- one deep event,
  // not a storm -- and the SILENCE in front of it. An announcement has to arrive before
  // the commit it announces, so it can only ever ride a pass the runtime was not
  // already rewriting; that is a cache break bought to say something the agent has
  // never once acted on (voluntary fold share 0.00 across eleven runs).
  await measure(runtime, 72_100, 100_000, undefined, "toolUse");
  const crossing = await project(runtime);
  await settle();
  assert.equal(
    crossing.messages.some((message) =>
      typeof message?.customType === "string" &&
      /-(curation|advisory|milestone|surfacing)$/.test(message.customType)),
    false,
    "Crossing the curation threshold rendered a carrier",
  );

  runtime.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Continuing the task." }],
    stopReason: "toolUse",
    timestamp: 990,
  }, "continuation");
  await measure(runtime, 72_600, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  const afterGate = commits().length;
  assert.equal(afterGate, 1, `The crossing produced ${afterGate} commit events instead of one`);
  const commit = commits()[0];
  assert.match(String(commit.trigger), /^(curation-trigger|window-pressure)$/);
  assert(commit.applied_marks >= 5,
    `The commit applied ${commit.applied_marks} marks; it was not the ONE deep event`);

  // Quiet again once occupancy falls back below the threshold.
  await measure(runtime, 40_000, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  assert.equal(commits().length, 1, "The runtime kept folding after the commit");

  // The retune itself, and the parts of the thermostat that did NOT move.
  assert.equal(context.CURATION_OCCUPANCY_SHARE, 0.80);
  assert.equal(context.CURATION_TARGET_OCCUPANCY_SHARE, 0.35);
  assert.equal(context.COMMIT_RECLAIM_FLOOR_SHARE, 0.02);

  // Plain epoch scheduling is unchanged: the cadence trigger is the guided-mode deletion.
  const plain = makeRuntime(
    makeFixture({ turns: 20, resultChars: 14_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE },
  );
  await startRuntime(plain);
  await toolCall(plain, {
    action: "fold",
    marks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((turn) => ({
      ids: [plain.built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  await measure(plain, 40_000, 100_000, undefined, "toolUse");
  await project(plain);
  await settle();
  // There is ONE cadence now. The eligible-share trigger is deleted outright -- it was
  // an economic trigger that bought a cache rebuild with marks that had not earned one,
  // and it fired 164 times from ordinal 17 in rep 15. A commit below the curation
  // trigger and below the pressure backstop is exactly the storm this gate replays.
  const plainCommits = plain.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  assert.equal(plainCommits.length, 0,
    `Something committed below both triggers: ${plainCommits.map((r) => r.trigger).join(",")}`);

  return {
    commitsBelowThreshold: 0,
    commitsAfterGate: afterGate,
    deepCommitMarks: commit.applied_marks,
    commitTrigger: commit.trigger,
    plainModeCommits: plainCommits.length,
    occupancyShare: context.CURATION_OCCUPANCY_SHARE,
  };
}

/**
 * ONE serving budget. The descriptor understates the wire; the trigger, the gate, the
 * reminders and the fence must all read the same truthful number, and the run must be
 * able to prove which number it got from the stream alone.
 */
async function gateOneTruthfulBudget() {
  const built = makeFixture({ turns: 16, resultChars: 30_000, contextWindow: 272_000 });
  const runtime = makeRuntime(built, {
    foldScheduling: "epoch",
    // The live shape: a 272,000-token per-request descriptor over a 400,000 window.
    providerTotalWindow: 400_000,
  });
  await startRuntime(runtime);
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // Line one of the stream states the resolved budget.
  const capacity = stream().find((record) => record.kind === "context.capacity");
  assert(capacity, "The run never stated its resolved serving budget");
  assert.equal(capacity.mode, "truthful");
  assert.equal(capacity.window_tokens, 400_000);
  assert.equal(capacity.budget_tokens, 383_616);
  assert.equal(capacity.descriptor_window, 272_000);

  await measure(runtime, 180_000, 272_000, undefined, "toolUse");
  await project(runtime);
  await measure(runtime, 330_000, 272_000, undefined, "toolUse");
  const announced = await project(runtime);
  await settle();

  // Every curation-side record carries the truthful budget, and none carries the
  // descriptor's 255,616.
  const budgeted = stream().filter((record) =>
    typeof record.budget_tokens === "number");
  assert(budgeted.length >= 2, "No budgeted records were emitted");
  for (const record of budgeted) {
    assert.equal(record.budget_tokens, 383_616,
      `${record.kind} carried ${record.budget_tokens} instead of the truthful budget`);
  }
  const commitRecord = stream().find((record) => record.kind === "context.commit");
  assert(commitRecord, "The runtime never committed at truthful occupancy");
  assert.equal(commitRecord.window_tokens, 400_000);
  // The receipt is the ONE carrier left, and it quotes the same truthful budget the
  // stream does. Nothing in the window may quote the per-request descriptor.
  const projected = json.stableStringify(announced.messages);
  assert.equal(/255616/.test(projected), false,
    "The projection quoted the descriptor budget instead of the serving budget");

  // The status surface reads the same source.
  const status = (await toolStatus(runtime)).details.automatic;
  assert.equal(status.capacity.budgetTokens, 383_616);
  assert.equal(status.capacity.descriptorWindow, 272_000);
  assert.equal(status.curation.signals.budgetTokens, 383_616);

  return {
    mode: capacity.mode,
    budgetTokens: capacity.budget_tokens,
    descriptorWindow: capacity.descriptor_window,
    budgetedRecords: budgeted.length,
  };
}

/**
 * Accept and hold. A mark over a still-fresh span is scheduled, never refused, and it
 * folds in a LATER commit once the span ages out -- never in the commit while fresh.
 */
async function gateAcceptAndHold() {
  const fixture = { turns: 10, resultChars: 8_000, contextWindow: 100_000 };
  const built = makeFixture(fixture);
  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);

  const freshSpan = [built.turnEntries[9][0], built.turnEntries[9].at(-1)];
  const held = await toolCall(runtime, {
    action: "fold", ids: freshSpan, brief: "The closing task stays exactly recoverable behind this fold.",
  });
  assert.equal(held.details.ok, true, "A fresh span was not accepted");
  assert.equal(held.details.deferred, true);
  assert.match(String(held.details.scheduled), /folds at the first commit after it ages out/);
  assert.match(String(held.details.activation), /held, not refused/);
  // Refusal language is reserved for the unconstructible.
  assert.equal(/refus/i.test(JSON.stringify(held.details.marks)), false,
    "A held mark was described as a refusal");
  const heldId = held.details.id;

  const staleSpan = [built.turnEntries[1][0], built.turnEntries[1].at(-1)];
  const stale = await toolCall(runtime, {
    action: "fold", ids: staleSpan, brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  assert.equal(stale.details.ok, true);
  assert.equal(stale.details.deferred, false);

  // The commit while the span is still fresh: it applies the stale mark and HOLDS the
  // fresh one, and the stream says deferred rather than refused.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.applied.length >= 1);
  assert.equal(committed.applied.some((mark) => mark.id === heldId), false,
    "A fresh span was folded by the commit that should have held it");
  assert.equal(committed.deferredMarks >= 1, true);
  assert.equal(committed.refusedMarks, 0, "A held mark was counted as a refusal");
  assert((materialized(runtime).pendingMarks ?? []).some((mark) => mark.id === heldId),
    "The held mark did not survive its commit");

  // Age the span out with new turns, and the LATER commit folds it.
  const aged = makeFixture({ ...fixture, turns: 14, sessionId: built.sessionId });
  for (const entry of aged.entries.slice(built.entries.length)) runtime.branch.push(entry);
  runtime.messages.length = 0;
  runtime.messages.push(...aged.messages);
  const later = await runtimeCommit(runtime, { tokens: 92_000, contextWindow: 100_000 });
  // It folds under its own id, or merged into the adjacent fold the absorber rode into
  // the same rewrite. Either way it is no longer a standing decision, and never refused.
  assert.equal((materialized(runtime).pendingMarks ?? []).some((mark) => mark.id === heldId), false,
    "The held mark never folded after its span aged out");
  assert(later.applied.some((mark) => mark.origin === "agent"),
    "The aged span folded as something other than the agent's own curation");
  assert.equal(later.refusedMarks, 0, "The aged mark was refused rather than folded");

  return {
    heldAccepted: held.details.ok,
    heldDeferred: held.details.deferred,
    foldedWhileFresh: false,
    foldedLater: true,
    deferredAtFirstCommit: committed.deferredMarks,
  };
}

/** Copy that carries the WHY and the numbers, and receipts that keep their verbs. */
async function gateCurationCopyAndReceipts() {
  const runtime = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE },
  );
  await startRuntime(runtime);
  await measure(runtime, 76_000, 100_000, undefined, "toolUse");
  await project(runtime);
  // The WHY now lives in the tool description, which rides the STABLE PREFIX and is
  // therefore cached from the first request onward. That is the only place a standing
  // fact can be stated for free; the notice that used to carry it was rebuilt per pass.
  const description = [...runtime.tools.values()][0].description;
  assert.match(description, /Folding is automatic, lossless and recoverable/);
  assert.match(description, /no fold is ever announced in advance/);

  // Receipts carry concrete impact and keep their correction verbs.
  const receipt = context.contextReceipt({
    kind: "epoch-commit",
    ordinal: 42,
    trigger: "curation-trigger",
    foldsCommitted: 4,
    foldsCreated: 4,
    freedTokens: 31_000,
    occupancyBefore: 76_000,
    occupancyAfter: 45_000,
    spansFolded: 1,
    toolResultsFolded: 3,
  });
  const line = context.receiptLine(receipt);
  assert.match(line, /Occupancy 76000→45000 tokens/);
  assert.match(line, /1 span\(s\) folded, 3 tool result\(s\) folded/);
  const block = context.receiptBlockText({ receipts: [receipt], toolName: "active_context" });
  assert.match(block, /"action":"rebrief"/);
  assert.match(block, /"action":"reboundary"/);
  assert.match(block, /"action":"expand"/);

  // The rollback receipt says where it landed and what overfilled.
  const rollback = context.receiptLine(context.contextReceipt({
    kind: "overflow-recovery",
    ordinal: 51,
    trigger: "provider-rejection:400",
    freedTokens: 120_000,
    occupancyBefore: 420_000,
    occupancyAfter: 300_000,
    recovered: true,
    note: "A rollback was required: the provider rejected the last request, which overfilled the " +
      "serving budget at 420000 estimated tokens against 383616. 1 reduction(s) landed it at 300000 " +
      "tokens. Nothing durable was written for it, and the request was rebuilt inside the budget " +
      "rather than dropped.",
  }));
  assert.match(rollback, /overfilled the serving budget at 420000 estimated tokens against 383616/);
  assert.match(rollback, /landed it at 300000 tokens/);

  return {
    standingFactsInStablePrefix: true,
    receiptImpact: line.includes("→"),
    correctionVerbsKept: true,
  };
}

/**
 * One structural mutation per handoff.
 *
 * Rep 15 landed two context.commit records 50ms apart inside one ordinal (revisions 14
 * and 15): the announced commit ran, the rebuilt projection was still inside the fence
 * margin, and the crowded reduction committed a second time in the same pass. Two real
 * mutations, two prefix rewrites, one model call.
 */
async function gateMutationBudgetPerHandoff() {
  const runtime = makeRuntime(
    makeFixture({ turns: 18, resultChars: 14_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE },
  );
  await startRuntime(runtime);
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // Drive the pass that used to double-commit: announce, proceed, and leave the rebuilt
  // projection crowded enough for the budget lane to want a second commit.
  for (const tokens of [70_000, 78_000, 82_000, 86_000, 90_000]) {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    await project(runtime);
    await settle();
  }

  const records = stream();
  const handoffs = [];
  let current = [];
  for (const record of records) {
    if (record.kind === "context.commit" && record.deferred === false) current.push(record);
    if (record.kind === "context.prefix") { handoffs.push(current); current = []; }
  }
  handoffs.push(current);
  for (const [index, batch] of handoffs.entries()) {
    assert(batch.length <= 1,
      `Handoff ${index} carried ${batch.length} structural mutations: ${batch.map((record) => record.trigger)}`);
  }
  // The invariant is enforced, not hoped for: a second attempt in one handoff is
  // recorded as a deferral with its reason, never silently dropped.
  const deferrals = records.filter((record) =>
    record.kind === "context.commit" && record.reason === "mutation-budget-spent");
  for (const deferral of deferrals) {
    assert.equal(deferral.deferred, true);
    assert.equal(deferral.applied_marks, 0);
    assert(deferral.mutations_since_handoff >= 1);
  }
  const mutations = records.filter((record) =>
    record.kind === "context.commit" && record.deferred === false);
  assert(mutations.length >= 1, "The replay never committed at all");

  return {
    handoffs: handoffs.length,
    maxMutationsPerHandoff: Math.max(0, ...handoffs.map((batch) => batch.length)),
    mutations: mutations.length,
    budgetDeferrals: deferrals.length,
  };
}

/**
 * MARKING IS THE AGENT'S, FOLDING IS THE RUNTIME'S.
 *
 * There is no agent-callable commit verb on any surface: not in the action enum, not in
 * the schema, not in the tool description, not in the curation notice, not in the
 * scheduling status block, and not in a refusal's suggested alternatives. What the verb
 * used to reach is untouched: the marks it would have applied still fold, driven by the
 * runtime's own trigger.
 */
async function gateNoAgentCommitVerb() {
  assert.equal(context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.includes("commit"), false,
    "The epoch action surface still carries the commit verb");
  for (const kept of ["fold", "unmark", "status", "expand", "peek", "refold", "rebrief", "reboundary"]) {
    assert(context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.includes(kept),
      `The deletion took ${kept} with it`);
  }

  const runtime = await epochToolRuntime({ turns: 14, resultChars: 8_000 });
  const tool = [...runtime.tools.values()][0];
  assert.deepEqual([...tool.parameters.properties.action.enum],
    [...context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS]);
  assert.equal(tool.parameters.properties.action.enum.includes("commit"), false);
  assert.equal(/\bcommit\b/.test(tool.description), false,
    `The tool description still teaches a commit verb: ${tool.description}`);
  assert(tool.description.includes("epoch mode"), "The epoch guidance went with the verb");
  await assert.rejects(() => toolCall(runtime, { action: "commit" }), /'commit' is not enabled/);

  // The status block advertises no commit action either.
  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(Object.hasOwn(scheduling, "actions"), false,
    "The scheduling status block still hands back a commit action");
  const marked = await toolCall(runtime, {
    action: "fold",
    ids: [runtime.built.turnEntries[1][0], runtime.built.turnEntries[1].at(-1)],
    brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  assert.equal(marked.details.ok, true);
  assert.equal(/\bcommit action\b/.test(json.stableStringify(marked.details)), false,
    "A fold reply still points the agent at a commit action");

  // The curation notice offers the correction verbs and nothing that no longer exists.
  const notice = context.curationNoticeText({
    signals: {
      occupancy: 0.86, occupancyTokens: 86_000, budgetTokens: 100_000, window: 100_000,
      staleToolShare: 0.3, staleToolTokens: 30_000, staleToolResults: 6, eligibleFolds: 4,
    },
    roundsUsed: 1, pendingMarks: 4, toolName: "active_context",
  });
  assert.equal(/"action":"commit"/.test(notice), false,
    "The last-call notice still offers a commit verb");
  assert(notice.includes('"action":"fold"') && notice.includes('"action":"rebrief"'),
    "The notice lost the verbs that do exist");

  // And the machinery is intact: the marks still fold, on the runtime's own trigger.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.fired, "The internal commit stopped firing with the verb");
  assert(committed.applied.length >= 1, "The internal commit applied nothing");
  assert.equal(materialized(runtime).pendingMarks, undefined);
  assert(materialized(runtime).folds.length >= 1);

  return {
    epochActions: context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    commitInSurface: false,
    internalCommitApplied: committed.applied.length,
  };
}

/**
 * NO COMMIT THAT FREES CRUMBS, ON ANY PATH.
 *
 * The reclaim floor used to be waived by standing at the fence RATIO, which is a
 * prediction and not an inability to send: measured rep 17, fence-path commits fired at
 * eligible-freed shares as low as 0.018. Now only genuine overflow is exempt, and a
 * below-floor commit is a true no-op that says so in the stream.
 */
async function gateNoYieldCommitGuard() {
  assert.equal(context.COMMIT_RECLAIM_FLOOR_SHARE, 0.02);

  // A crowded window whose foldable mass is already spent: every commit path measures
  // below the floor, so nothing fires and nothing is rewritten.
  const runtime = await epochToolRuntime({ turns: 10, resultChars: 1_400, contextWindow: 400_000 });
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // One real decision to commit, whose whole mass is crumbs against this window.
  const marked = await toolCall(runtime, {
    action: "fold",
    ids: [runtime.built.turnEntries[1][0], runtime.built.turnEntries[1].at(-1)],
    brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  assert.equal(marked.details.ok, true);

  // Climb past the pressure backstop and up to the fence RATIO, but stay under the
  // serving budget: crowded and predicted-unsafe, yet perfectly able to send.
  for (const tokens of [345_000, 355_000, 365_000, 375_000]) {
    await measure(runtime, tokens, 400_000, undefined, "toolUse");
    await project(runtime).catch(() => undefined);
    await settle();
  }
  const commits = stream().filter((record) => record.kind === "context.commit");
  const belowFloor = commits.filter((record) =>
    typeof record.eligible_freed_share === "number" &&
    record.eligible_freed_share < context.COMMIT_RECLAIM_FLOOR_SHARE &&
    record.deferred === false);
  assert.deepEqual(belowFloor.map((record) => record.trigger), [],
    "A commit fired below the reclaim floor");
  const deferrals = commits.filter((record) => record.reason === "below-reclaim-floor");
  assert(deferrals.length >= 1, "The fixture never reached the guard");
  for (const deferral of deferrals) {
    assert.equal(deferral.deferred, true);
    assert.equal(deferral.applied_marks, 0, "A deferred commit still applied marks");
    assert.equal(deferral.reclaim_floor_share, context.COMMIT_RECLAIM_FLOOR_SHARE);
    assert(deferral.eligible_freed_share < context.COMMIT_RECLAIM_FLOOR_SHARE);
    // A true no-op: no fold record is joined to a deferred commit.
    assert.equal(stream().some((record) =>
      record.kind === "context.fold" && record.commit_seq === deferral.seq), false,
    "A deferred commit rewrote the projection anyway");
  }

  // Safety still outranks economy: a projection past the serving budget recovers,
  // whatever it frees.
  const overflow = makeRuntime(
    makeFixture({ turns: 16, resultChars: 12_000, contextWindow: 60_000 }),
    { foldScheduling: "epoch" },
  );
  await startRuntime(overflow);
  await measure(overflow, 55_000, 60_000, undefined, "toolUse");
  await project(overflow).catch(() => undefined);
  await settle();
  const recovery = overflow.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data)
    .filter((record) => record.kind === "context.recovery" || record.kind === "context.commit");
  assert(recovery.some((record) => record.deferred === false || record.kind === "context.recovery"),
    "Genuine overflow was held back by the economy guard");

  return {
    reclaimFloorShare: context.COMMIT_RECLAIM_FLOOR_SHARE,
    commits: commits.length,
    belowFloorCommits: belowFloor.length,
    floorDeferrals: deferrals.length,
  };
}

/**
 * MECHANISM 1 and 2. The frozen surface.
 *
 * Rep 17 forensics (2026-08-07): every context-tool attempt was followed by a
 * projection REWRITE, never an append. Measured next-request prefix identity per
 * action: status 0.60-0.90, held commit 0.013-0.103, peek 0.96. The system prompt and
 * the tool array were byte-constant all run, so the divergence lived in the rendered
 * blocks a context action refreshed. Provider prefix caches are positional, so each of
 * those refreshes was a cache kill; the run posted 0.390 pooled cache share against a
 * mechanism-limited 0.864.
 *
 * The rule this gate pins: between fold events the projection is byte-frozen, and the
 * only change a context action may cause is the append of its own tool result.
 */
async function gateFrozenSurface() {
  const runtime = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE },
  );
  await startRuntime(runtime);
  // Crowd the window so the occupancy signals are real. A freeze proved on an empty
  // projection proves nothing. There is no carrier to wait for any more: the runtime
  // renders nothing between commits, which is the property under test.
  await measure(runtime, 48_000, 100_000, undefined, "toolUse");
  const seeded = await project(runtime);
  assert(seeded.messages.length >= 10, "The fixture never crowded the window");
  assert.equal(
    seeded.messages.some((message) =>
      typeof message?.customType === "string" &&
      /-(curation|advisory|milestone|surfacing)$/.test(message.customType)),
    false,
    "A pre-commit guidance carrier reached the projection",
  );

  const digest = async () => json.stableStringify((await project(runtime)).messages);
  const before = await digest();
  const built = runtime.built;

  // A mark: several spans in one call, which is the shape the copy now asks for.
  const marked = await toolCall(runtime, {
    action: "fold",
    marks: [
      { ids: [built.turnEntries[0][2]], brief: "The first completed inspection stays exactly recoverable." },
      { ids: [built.turnEntries[1][2]], brief: "The second completed inspection stays exactly recoverable." },
    ],
  });
  assert.equal(marked.details.ok, true);
  assert(materialized(runtime).pendingMarks.length >= 2, "The batch marked nothing");
  assert.equal(await digest(), before, "A mark moved a projection byte");

  // Status: the index render used to refresh in place. It answers in its own result now.
  const status = await toolStatus(runtime);
  assert.equal(status.details.version, 1);
  assert.equal(await digest(), before, "A status call moved a projection byte");

  // Peek, including a refused one: an attempt is an attempt.
  await toolCall(runtime, { action: "peek", id: "no-such-fold" }).catch(() => undefined);
  assert.equal(await digest(), before, "A peek attempt moved a projection byte");

  // MECHANISM 2. Nothing anywhere in the projected bytes renders the held marks.
  const pending = materialized(runtime).pendingMarks;
  assert(pending.length >= 2);
  for (const mark of pending) {
    assert.equal(before.includes(mark.id), false, `Pending mark ${mark.id} was rendered into the projection`);
  }
  assert.equal(/\bmark\(s\) pending\b|\bpending mark/i.test(before), false,
    "The projection renders pending-mark state");

  // The tail still appends: a new raw message extends the frozen projection and
  // changes nothing before it. That is the one sanctioned non-fold change.
  await measure(runtime, 50_000, 100_000, undefined, "toolUse");
  const grown = (await project(runtime)).messages;
  const held = JSON.parse(before);
  assert(grown.length > held.length, "The projection did not grow with the new message");
  assert.equal(json.stableStringify(grown.slice(0, held.length)), before,
    "An appended message rewrote the frozen prefix");

  // And the freeze does not break folding: the fold event is still free to rewrite.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.applied.length >= 1, "The fold event applied nothing");
  const after = await digest();
  assert.notEqual(after, before, "The fold event did not rewrite the projection");
  // A rewrite, not a longer append: some entry the frozen surface already held now
  // reads differently. That is the sanctioned mutation, and it must still be reachable.
  const rewritten = JSON.parse(after);
  const shared = Math.min(rewritten.length, grown.length);
  assert(
    rewritten.slice(0, shared).some((message, index) =>
      json.stableStringify(message) !== json.stableStringify(grown[index])),
    "The fold event only appended; it never folded",
  );
  // MECHANISM 2, the other half: the folds appear once the event materializes them.
  assert(materialized(runtime).folds.length >= 1);
  assert(after.includes(materialized(runtime).folds[0].id),
    "The committed fold never reached the projection");

  // MECHANISM 3, and the pass this gate was missing. The fold event is allowed ONE
  // rewrite; the freeze then has to re-arm. A surface that never freezes again pays a
  // rewrite on every later request, and no check that stops at the fold can see it --
  // which is how a latched freeze survived a green suite while the runtime paid it on
  // most of a run. Append once more and demand the post-fold projection back verbatim.
  await measure(runtime, 52_000, 100_000, undefined, "toolUse");
  const rearmed = (await project(runtime)).messages;
  assert(rearmed.length > rewritten.length,
    "The projection did not grow with the message that followed the fold event");
  const divergence = rewritten.findIndex((message, index) =>
    json.stableStringify(message) !== json.stableStringify(rearmed[index]));
  assert.equal(divergence, -1,
    `The freeze never re-armed: the post-fold prefix diverged at index ${divergence}`);

  return {
    markFrozen: true,
    statusFrozen: true,
    peekFrozen: true,
    pendingRendered: false,
    tailAppends: grown.length - held.length,
    foldEventRewrites: true,
    committedFolds: materialized(runtime).folds.length,
    reArmedAfterFold: true,
    postFoldAppends: rearmed.length - rewritten.length,
  };
}

/**
 * MECHANISM 3. The mark response carries the awareness.
 *
 * A tail-appended tool result is the one cache-free place left to inform the agent, so
 * the picture the projection stopped rendering lives here: what is held, what is left
 * as an aggregate with a bounded head, and the one percentage worth steering by.
 */
async function gateMarkResponseAwareness() {
  const runtime = await epochToolRuntime({ turns: 14, resultChars: 9_000 });
  const built = runtime.built;
  const reply = await toolCall(runtime, {
    action: "fold",
    marks: [
      { ids: [built.turnEntries[0][2]], brief: "The first completed inspection stays exactly recoverable." },
      { ids: [built.turnEntries[1][2]], brief: "The second completed inspection stays exactly recoverable." },
    ],
  });
  const details = reply.details;
  assert.equal(details.ok, true);

  // (a) Every span now HELD, with its kind and its approximate mass.
  assert.equal(Array.isArray(details.held), true);
  assert.equal(details.held.length, materialized(runtime).pendingMarks.length);
  assert(details.held.length >= 2, "The batch held fewer spans than it marked");
  assert(details.held.every((span) =>
    typeof span.id === "string" && typeof span.kind === "string" &&
    typeof span.tokens === "number" && span.tokens > 0),
  "A held span was reported without id, kind or tokens");
  assert.match(String(details.heldNote), /held until it ages out or the next fold event/);

  // (b) The remainder as an AGGREGATE, plus a bounded head of the largest candidates.
  assert.equal(typeof details.unmarkedSpans, "number");
  assert(details.unmarkedSpans >= 1, "The crowded fixture reported nothing left unmarked");
  assert(details.unmarkedTokens > 0);
  assert(details.unmarkedCandidates.length <= context.MAX_UNMARKED_CANDIDATES,
    "The candidate list is unbounded");
  assert(details.unmarkedCandidates.length < details.unmarkedSpans,
    "The candidate list is the exhaustive list");
  assert(details.unmarkedCandidates.every((item) =>
    typeof item.id === "string" && typeof item.tokens === "number"));
  const ordered = details.unmarkedCandidates.map((item) => item.tokens);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => right - left),
    "The candidates are not ordered by reclaim value");

  // (c) The steering number: unmarked share of the non-fresh window.
  assert.equal(typeof details.unmarkedShare, "number");
  assert(details.unmarkedShare > 0 && details.unmarkedShare <= 1);

  // All of it inside the receipt block's byte discipline.
  const awareness = String(details.awareness);
  const awarenessBytes = Buffer.byteLength(awareness, "utf8");
  assert(awarenessBytes <= context.CONTEXT_MARK_RESPONSE_BYTES,
    `The awareness block ran to ${awarenessBytes} bytes over the ${context.CONTEXT_MARK_RESPONSE_BYTES} cap`);
  assert.match(awareness, /Held until they age out or the next fold event/);
  assert.match(awareness, /Unmarked remainder: \d+ span\(s\)/);
  assert.match(awareness, /% of the non-fresh window/);
  assert.match(awareness, /Largest unmarked by reclaim value/);
  assert.match(awareness, /Mark several spans in one/);

  // The marks the caller named are in the picture it got back.
  const heldIds = new Set(details.held.map((span) => span.id));
  assert(details.marks.every((mark) => mark.ok !== true || heldIds.has(mark.id)),
    "A mark this call accepted is missing from the held picture");

  return {
    heldSpans: details.held.length,
    unmarkedSpans: details.unmarkedSpans,
    unmarkedTokens: details.unmarkedTokens,
    candidates: details.unmarkedCandidates.length,
    candidateCap: context.MAX_UNMARKED_CANDIDATES,
    awarenessBytes,
    cap: context.CONTEXT_MARK_RESPONSE_BYTES,
  };
}

/** MECHANISM 4. Every surface that describes marking asks for a BATCH. */
async function gateBatchedMarkCopy() {
  const runtime = await epochToolRuntime();
  const description = [...runtime.tools.values()][0].description;
  assert.match(description, /Mark SEVERAL spans in one call/);
  assert.match(description, /one call answers with your whole picture/);
  assert.match(description, /unmarked remainder/);
  assert.match(description, /Between fold events nothing else in your context changes/);
  assert.match(description, /that result is where the picture lives/);
  const marks = [...runtime.tools.values()][0].parameters.properties.marks;
  assert.match(marks.description, /which is the shape to prefer/);

  const signals = {
    occupancy: 0.5, occupancyTokens: 50_000, budgetTokens: 100_000, window: 100_000,
    staleToolShare: 0.3, staleToolTokens: 30_000, staleToolResults: 6, eligibleFolds: 4,
  };
  const reminder = context.curationReminderText({ signals, toolName: "active_context" });
  assert.match(reminder, /Mark SEVERAL finished chapters in one call/);
  assert.match(reminder, /one call answers with everything held plus what is still unmarked/);
  // The tool surface's own vocabulary rule: nothing here invites a chat-style answer.
  assert.equal(/\bthe reply\b/.test(reminder), false, "The reminder says \"the reply\"");
  assert.equal(reminder.includes("\n"), false, "The reminder stopped being one line");

  const notice = context.curationNoticeText({ signals, roundsUsed: 1, toolName: "active_context" });
  assert.match(notice, /marks SEVERAL spans in one call/);
  assert.match(notice, /answers with everything held plus what is still unmarked/);
  // MECHANISM 2 at the copy level: the notice no longer renders held-mark state.
  assert.equal(/mark\(s\) pending/.test(notice), false,
    "The last-call notice still renders pending-mark state");

  const reply = await toolCall(runtime, {
    action: "fold",
    ids: [runtime.built.turnEntries[0][2]],
    brief: "One completed inspection stays exactly recoverable behind this mark.",
  });
  assert.match(String(reply.details.activation), /Mark several spans in one call/);
  assert.match(String(reply.details.activation), /nothing else in your\s+context changed/);

  return { description: true, reminder: true, notice: true, activation: true };
}

/**
 * The rep-19 window shape: paged active_context status calls whose results pile up
 * as stale mass, followed by fresh work. Each status call carries the detail
 * argument the runtime's own paging block advertises.
 */
function makeStatusResultFixture({
  sessionId = "status-mass",
  statusTurns = 6,
  statusChars = 40_000,
  trailingTurns = 4,
  trailingChars = 0,
  contextWindow = 100_000,
  policy = {},
} = {}) {
  const entries = [];
  const messages = [];
  const statusResultIds = [];
  let parentId = null;
  let sequence = 0;
  const add = (message) => {
    const id = `${sessionId}-entry-${String(++sequence).padStart(3, "0")}`;
    entries.push({ type: "message", id, parentId, message });
    messages.push(message);
    parentId = id;
    return id;
  };
  for (let turn = 0; turn < statusTurns; turn += 1) {
    add({
      role: "user",
      content: [{ type: "text", text: `Page ${turn}: check the context state.` }],
      timestamp: sequence,
    });
    add({
      role: "assistant",
      content: [{
        type: "toolCall",
        id: `status-${turn}`,
        name: "active_context",
        arguments: { action: "status", detail: "folds", offset: turn * 40, limit: 40 },
      }],
      stopReason: "toolUse",
      timestamp: sequence,
    });
    statusResultIds.push(add({
      role: "toolResult",
      toolCallId: `status-${turn}`,
      toolName: "active_context",
      content: [{ type: "text", text: `Status page ${turn}: ${"s".repeat(statusChars)}` }],
      isError: false,
      timestamp: sequence,
    }));
    add({
      role: "assistant",
      content: [{ type: "text", text: `Reviewed status page ${turn}.` }],
      stopReason: "stop",
      timestamp: sequence,
    });
  }
  for (let turn = 0; turn < trailingTurns; turn += 1) {
    add({
      role: "user",
      content: [{ type: "text", text: `Task ${turn}: continue the work.${" t".repeat(trailingChars)}` }],
      timestamp: sequence,
    });
    add({
      role: "assistant",
      content: [{ type: "text", text: `Completed task ${turn}.` }],
      stopReason: "stop",
      timestamp: sequence,
    });
  }
  const snapshot = context.mapActiveContext({
    sessionId,
    eventMessages: messages,
    contextEntries: entries,
    policy,
    contextWindow,
  });
  return { sessionId, entries, messages, snapshot, statusResultIds, contextWindow };
}

async function gateStatusPagesAreBounded() {
  assert.equal(context.CONTEXT_STATUS_RESPONSE_BYTES, 24_000);

  // A session with many folds, so every listing variant has real mass to page.
  const built = makeFixture({ turns: 24, resultChars: 12_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);
  for (const tokens of [76_000, 80_000, 84_000, 88_000, 92_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  const allFoldIds = materialized(runtime).folds.map((fold) => fold.id).sort();
  assert(allFoldIds.length >= 10, "The fixture built too few folds to force paging");

  // Every detail variant fits the cap, and the marker appears on every truncated page.
  const measured = {};
  for (const detail of [undefined, "fold_candidates", "tree", "folds", "objects"]) {
    const result = await toolStatus(runtime, "active_context", detail);
    const delivered = Buffer.byteLength(result.content[0].text, "utf8");
    assert(delivered <= context.CONTEXT_STATUS_RESPONSE_BYTES,
      `status detail=${detail ?? "default"} delivered ${delivered} bytes over the cap`);
    assert.equal(typeof result.details.continuation, "string",
      `status detail=${detail ?? "default"} truncated without a continuation marker`);
    assert.equal(result.details.continuation.includes("\n"), false,
      "The continuation marker is not one line");
    measured[detail ?? "default"] = delivered;
  }

  // Paging through the continuation offsets yields every fold id exactly once, for
  // both fold listings; the object listing pages completely the same way.
  for (const detail of ["folds", "tree"]) {
    const { rows, pages } = await pagedStatusRows(runtime, detail);
    assert(pages.length >= 2, `detail=${detail} never needed a second page`);
    assert(pages.every((page) => page.bytes <= context.CONTEXT_STATUS_RESPONSE_BYTES));
    const ids = rows.map((row) => row.id);
    assert.equal(ids.length, new Set(ids).size, `detail=${detail} paged a fold id twice`);
    assert.deepEqual([...ids].sort(), allFoldIds, `detail=${detail} paging lost a fold id`);
  }
  const objectsWalk = await pagedStatusRows(runtime, "objects");
  const objectIds = objectsWalk.rows.map((row) => row.id);
  assert.equal(objectIds.length, new Set(objectIds).size, "objects paging repeated a row");
  assert.equal(objectIds.length, objectsWalk.pages[0].payload.totalObjects,
    "objects paging lost a row");

  // The marker appears EXACTLY when truncation happened: a small session's page is
  // whole and unmarked.
  const small = makeRuntime(makeFixture({ turns: 2, resultChars: 400, contextWindow: 100_000 }));
  await startRuntime(small);
  for (const detail of [undefined, "fold_candidates", "tree", "folds", "objects"]) {
    const result = await toolStatus(small, "active_context", detail);
    assert(Buffer.byteLength(result.content[0].text, "utf8") <= context.CONTEXT_STATUS_RESPONSE_BYTES);
    assert.equal(result.details.continuation, undefined,
      `An untruncated status page (detail=${detail ?? "default"}) carried a continuation marker`);
  }

  // The diet paging block says pages are bounded, without a question or an em dash.
  const diet = (await toolStatus(runtime)).details;
  assert.equal(diet.paging.note, "Results are delivered in bounded pages.");
  assert.equal(/—/.test(JSON.stringify(diet)), false, "An em dash reached the status surface");

  return {
    cap: context.CONTEXT_STATUS_RESPONSE_BYTES,
    folds: allFoldIds.length,
    pageBytes: measured,
    foldPages: (await pagedStatusRows(runtime, "folds")).pages.length,
    treePages: (await pagedStatusRows(runtime, "tree")).pages.length,
  };
}

async function gateStatusResultsAreLadderFood() {
  // The classifier's allowlist, pinned. Before this build the status surface was
  // ['action', 'offset', 'limit']: the exact paged call the runtime's own paging
  // block advertises carries detail, so every paged status batch classified unsafe
  // and no automatic rung could reclaim it. Rep 19 died with six such results
  // holding 66% of a 383,616-token budget.
  assert.deepEqual(
    {
      status: [...context.READ_ONLY_CONTEXT_ACTION_ARGUMENTS.status],
      peek: [...context.READ_ONLY_CONTEXT_ACTION_ARGUMENTS.peek],
    },
    { status: ["action", "detail", "offset", "limit"], peek: ["action", "id"] },
  );
  const pagedShape = { action: "status", detail: "folds", offset: 40, limit: 40 };
  assert.equal(context.isReadOnlyContextTool("active_context", pagedShape), true,
    "The advertised paged status call still classifies unsafe");
  assert.equal(context.isReadOnlyContextTool("active_context", { action: "status", detail: "tree" }), true);
  // Classification is allowlist-driven: one argument outside the surface and the
  // batch is unsafe, which is exactly how the detail-carrying shape was rejected
  // before 'detail' joined the list above.
  assert.equal(context.isReadOnlyContextTool("active_context", { ...pagedShape, verbose: true }), false);

  // The batch scanner agrees end to end: the status-with-detail batch is validated.
  // The trailing turns carry real mass so the fresh-byte tail ends inside them and
  // the status result is genuinely stale.
  const built = makeStatusResultFixture({
    statusTurns: 1,
    statusChars: 30_000,
    trailingTurns: 4,
    trailingChars: 4_000,
    contextWindow: 100_000,
  });
  const scanned = context.scanTurnToolBatches(built.messages, { start: 0, end: 4 });
  assert(scanned && scanned.calls.length === 1 && scanned.unsafeIndices.size === 0,
    "The status-with-detail batch did not validate read-only-safe");

  // Once stale, the automatic tool rung selects and folds it.
  const state = context.emptyActiveContextState(built.sessionId);
  const candidate = context.selectAutomaticToolForRung(built.snapshot, state, 0.80);
  assert(candidate, "The stale status batch was not selected by the tool rung");
  assert.equal(candidate.kind, "tool-result");
  assert.deepEqual(candidate.sourceRefs.map((ref) => ref.entryId), [built.statusResultIds[0]]);
  const committed = await commitCandidate(state, built.snapshot, candidate);
  const fold = committed.state.folds.at(-1);
  assert.equal(fold.kind, "tool-result");
  assert.deepEqual(fold.parts.map((part) => part.ref.entryId), [built.statusResultIds[0]]);
  const before = bytesOf(context.projectActiveContext(built.snapshot, state));
  const after = bytesOf(context.projectActiveContext(built.snapshot, committed.state));
  assert(before - after >= 30_000 * 0.9,
    `Folding the status result freed only ${before - after} bytes`);

  // And in the running ladder: the rung folds it without any agent action.
  const runtime = makeRuntime(makeStatusResultFixture({
    statusTurns: 1,
    statusChars: 30_000,
    trailingTurns: 4,
    trailingChars: 4_000,
    contextWindow: 100_000,
  }));
  await startRuntime(runtime);
  await measure(runtime, 80_000, 100_000);
  await project(runtime);
  await settle();
  const folds = materialized(runtime).folds;
  const statusFold = folds.find((item) => item.kind === "tool-result" &&
    item.parts.some((part) => part.kind === "raw" && part.ref.entryId === runtime.built.statusResultIds[0]));
  assert(statusFold, "The running ladder never folded the stale status result");
  assert(runtime.appended.some((entry) =>
    entry.customType === "pi-fold-active-context-fold-record" && entry.data.foldId === statusFold.id),
  "No durable fold record named the status fold");

  return {
    statusArguments: [...context.READ_ONLY_CONTEXT_ACTION_ARGUMENTS.status],
    scannerValidated: true,
    rungSelected: true,
    freedBytes: before - after,
    ladderFoldId: statusFold.id,
  };
}

/**
 * Turns whose tool is NOT read-only, so the chapter encoding must inline the whole
 * result: this is the shape whose closed unit can exceed maxChapterChars, exactly
 * how rep 19's status units encoded to 146k-331k chars before this build.
 */
function makeOpaqueToolFixture({ sessionId, resultSizes, contextWindow = 400_000 }) {
  const entries = [];
  const messages = [];
  let parentId = null;
  let sequence = 0;
  const add = (message) => {
    const id = `${sessionId}-entry-${String(++sequence).padStart(3, "0")}`;
    entries.push({ type: "message", id, parentId, message });
    messages.push(message);
    parentId = id;
    return id;
  };
  resultSizes.forEach((size, turn) => {
    add({
      role: "user",
      content: [{ type: "text", text: `Step ${turn}: run the build stage.` }],
      timestamp: sequence,
    });
    add({
      role: "assistant",
      content: [{
        type: "toolCall", id: `bash-${turn}`, name: "bash", arguments: { command: `stage-${turn}` },
      }],
      stopReason: "toolUse",
      timestamp: sequence,
    });
    add({
      role: "toolResult",
      toolCallId: `bash-${turn}`,
      toolName: "bash",
      content: [{ type: "text", text: `Stage ${turn} log: ${"b".repeat(size)}` }],
      isError: false,
      timestamp: sequence,
    });
    add({
      role: "assistant",
      content: [{ type: "text", text: `Stage ${turn} done.` }],
      stopReason: "stop",
      timestamp: sequence,
    });
  });
  for (let turn = 0; turn < 4; turn += 1) {
    add({
      role: "user",
      content: [{ type: "text", text: `Task ${turn}: continue.${" t".repeat(4_000)}` }],
      timestamp: sequence,
    });
    add({
      role: "assistant",
      content: [{ type: "text", text: `Completed task ${turn}.` }],
      stopReason: "stop",
      timestamp: sequence,
    });
  }
  const snapshot = context.mapActiveContext({
    sessionId, eventMessages: messages, contextEntries: entries, policy: {}, contextWindow,
  });
  return { sessionId, entries, messages, snapshot };
}

async function gateNoPermanentlyUnfoldableUnit() {
  // One closed unit bigger than the whole chapter cap. Before this build the
  // selector broke on the cap BEFORE its single-unit acceptance, so the biggest
  // span in the window was exactly the one thing no automatic rung could reclaim.
  const giant = makeOpaqueToolFixture({ sessionId: "giant-unit", resultSizes: [140_000] });
  assert.equal(giant.snapshot.policy.maxChapterChars, 128_000);
  const units = context.chapterUnits(giant.snapshot);
  const state = context.emptyActiveContextState(giant.sessionId);
  const candidate = context.selectAutomaticChapter(giant.snapshot, state);
  assert(candidate, "The oversized unit left the chapter rung with nothing to select");
  const encoded = context.encodedFoldSource(giant.snapshot, state, candidate.parts, "chapter");
  assert(Buffer.byteLength(encoded, "utf8") > giant.snapshot.policy.maxChapterChars,
    "The fixture unit is not actually above the chapter cap");
  // A single unit, exactly: every source ref lies inside one closed unit's range.
  const indices = candidate.sourceRefs.map((ref) =>
    giant.snapshot.mapped.findIndex((item) => item.ref?.entryId === ref.entryId));
  const unit = units.find((item) => indices.every((index) =>
    index >= item.start && index < item.end));
  assert(unit, "The oversized candidate spans more than one closed unit");
  // No interior boundary exists, so the splitter returns it whole and it folds.
  assert.equal(context.splitCandidateBySize(giant.snapshot, state, candidate).length, 1);
  const committed = await commitCandidate(state, giant.snapshot, candidate);
  assert.equal(committed.state.folds.length, 1);
  assert.equal(committed.state.folds[0].kind, "chapter");
  const before = bytesOf(context.projectActiveContext(giant.snapshot, state));
  const after = bytesOf(context.projectActiveContext(giant.snapshot, committed.state));
  assert(before - after >= 140_000 * 0.9,
    `Folding the oversized unit freed only ${before - after} bytes`);

  // Composition keeps its caps: over inline units the selector still builds
  // multi-unit chapters, and a composed chapter never exceeds the bite-size bound,
  // let alone maxChapterChars. Only the single closed unit may exceed them.
  const multi = makeOpaqueToolFixture({
    sessionId: "multi-unit",
    resultSizes: [5_000, 5_000, 5_000, 5_000],
  });
  const multiState = context.emptyActiveContextState(multi.sessionId);
  const multiCandidate = context.selectAutomaticChapter(multi.snapshot, multiState);
  assert(multiCandidate, "The multi-unit fixture selected nothing");
  const multiEncoded = context.encodedFoldSource(
    multi.snapshot, multiState, multiCandidate.parts, "chapter",
  );
  assert(multiCandidate.sourceRefs.length > candidate.sourceRefs.length,
    "The cap exception collapsed ordinary composition to single units");
  assert(Buffer.byteLength(multiEncoded, "utf8") <= context.MAX_FOLD_SPAN_CHARS,
    "A composed multi-unit chapter exceeded the bite-size bound");
  assert(Buffer.byteLength(multiEncoded, "utf8") <= multi.snapshot.policy.maxChapterChars,
    "A composed multi-unit chapter exceeded maxChapterChars");
  const multiIndices = multiCandidate.sourceRefs.map((ref) =>
    multi.snapshot.mapped.findIndex((item) => item.ref?.entryId === ref.entryId));
  const multiUnits = context.chapterUnits(multi.snapshot).filter((item) =>
    multiIndices.some((index) => index >= item.start && index < item.end));
  assert(multiUnits.length >= 2, "The cap check collapsed composition to single units");

  return {
    maxChapterChars: giant.snapshot.policy.maxChapterChars,
    oversizedUnitBytes: Buffer.byteLength(encoded, "utf8"),
    freedBytes: before - after,
    multiUnitChapterBytes: Buffer.byteLength(multiEncoded, "utf8"),
    multiUnitCount: multiUnits.length,
  };
}

/**
 * THE APPEND-ONLY CONTRACT, read off the runtime own stream.
 *
 * This is the gate that would have caught the slate, and it is the reason this build
 * exists. Rep 21 measured what the absence of it cost: a 1503-character suggestion
 * carrier, rebuilt at the tail of every pass, preserved 99.86% of a 1.5M-character
 * prompt by our own accounting and still cost 16 FULL cache rebuilds -- 3.71M tokens,
 * 21.9% of every input token in the run. The runtime metrics never flagged it because
 * they measured divergence SIZE, and prefix caching does not price divergence by size.
 * A tail block cannot be stable: the next pass appends after it, so the block is
 * positionally displaced every time whatever it says.
 *
 * The rule, stated so that a build cannot drift back: the projection may only be
 * REWRITTEN by a commit or a fold. Every other pass appends or is identical. A carrier
 * the runtime wants to render must therefore ride a commit, where the break is already
 * paid for and the freeze closes over it.
 *
 * The stream is the witness because it is what the experiment adjudicates. If this gate
 * passes and a run still shows unattributed rewrites, the disagreement is a bug in the
 * runtime rather than in the analysis, and that is the point of pinning it here.
 */
/**
 * A SUCCESSFUL peek never rewrites the window.
 *
 * Rep 22 (2026-08-07) measured the failure this gate exists to prevent. A peek result
 * used to be reclaimed in place once a model call had seen it, on the stated theory
 * that the edit was "tail-local by construction". It is not. The result is tail-local
 * only when it ARRIVES; reclamation deliberately waits for a later assistant message,
 * and by then the window has grown over it, so the edit lands mid-prefix. Two peeks
 * diverged the prompt at message 52 and 72 and cost 58,424 and 42,342 fresh tokens,
 * about 23 percent of the run's entire fresh input.
 *
 * The duplicate bytes are still reclaimed; `ephemeralPeekMarks` folds the read at the
 * next commit, which is the one moment a rewrite is already being paid for.
 */
async function gatePeekIsAppendOnly() {
  // Two-phase, because the fold id the peek names must be the id the commit produces.
  const probe = makeFixture({
    turns: 12, resultChars: 12_000, contextWindow: 100_000, peekTurns: [3], peekTargetId: "placeholder",
  });
  const seed = context.emptyActiveContextState(probe.sessionId);
  const foldId = (await commitCandidate(
    seed, epochSnapshot(probe), context.selectAutomaticToolBatch(epochSnapshot(probe), seed, 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).prepared.id;
  const built = makeFixture({
    turns: 12, resultChars: 12_000, contextWindow: 100_000, peekTurns: [3], peekTargetId: foldId,
  });
  const snapshot = epochSnapshot(built);
  const state = (await commitCandidate(
    context.emptyActiveContextState(built.sessionId), snapshot,
    context.selectAutomaticToolBatch(snapshot, context.emptyActiveContextState(built.sessionId), 1)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;

  // Eight later turns sit after the peek, so a model call has long since read it. That
  // is the ENTIRE precondition the old reclamation waited for.
  const source = snapshot.messages.find((message) => message?.toolCallId === "call-3");
  assert(source, "The fixture never carried a peek result");
  const projected = context.projectActiveContext(snapshot, state)
    .find((message) => message?.toolCallId === "call-3");
  assert(projected, "The peek result vanished from the projection");
  assert.deepEqual(projected.content, source.content,
    "The projection rewrote a consumed peek result in place");

  // Protecting or expanding it changes nothing either: there is no lever here any more.
  for (const variant of [
    { ...state, expanded: [foldId] },
    { ...state, protected: [] },
  ]) {
    const again = context.projectActiveContext(snapshot, variant)
      .find((message) => message?.toolCallId === "call-3");
    assert.deepEqual(again.content, source.content, "A peek result moved under a state variant");
  }

  // The bytes are still reclaimed, by the mark that folds the read at the NEXT commit.
  const marks = context.ephemeralPeekMarks({ snapshot, state, ordinal: 1 });
  assert.equal(marks.length, 1, "The consumed peek read is not queued for a commit");
  assert.equal(marks[0].origin, "agent");

  return {
    peekedFold: foldId,
    laterTurns: 8,
    projectedBytes: Buffer.byteLength(JSON.stringify(projected.content), "utf8"),
    identicalToSource: true,
    queuedForCommit: marks.length,
  };
}

async function gateProjectionIsAppendOnly() {
  const runtime = await epochToolRuntime({ turns: 16, resultChars: 8_000 });
  const built = runtime.built;
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // Exercise every lane that used to render something: status, a refused call, a peek,
  // a batched mark, and a long occupancy climb that crosses the commit trigger twice.
  await toolCall(runtime, { action: "status" });
  await toolCall(runtime, { action: "peek", id: "no-such-fold" }).catch(() => undefined);
  await toolCall(runtime, {
    action: "fold",
    marks: [0, 1, 2].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  for (const tokens of [40_000, 56_000, 68_000, 76_000, 82_000, 88_000, 60_000, 72_000, 84_000]) {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    await project(runtime);
    await settle();
  }

  const prefixes = stream().filter((record) => record.kind === "context.prefix");
  assert(prefixes.length >= 8, `The climb produced only ${prefixes.length} prefix records`);
  const rewrites = prefixes.filter((record) => record.change === "rewrite");

  // EVERY rewrite names a commit or a fold. An "unattributed" rewrite is the signature
  // of exactly the bug this gate exists to prevent, so it is named in the failure.
  const unattributed = rewrites.filter((record) =>
    !/context\.(commit|fold)/.test(String(record.cause ?? "")));
  assert.deepEqual(
    unattributed.map((record) => ({
      seq: record.seq,
      cause: record.cause,
      requestClass: record.request_class,
      keptChars: record.identical_chars,
      previousChars: record.previous_chars,
    })),
    [],
    "A projection was rewritten by something that was not a commit or a fold",
  );

  // And the runtime did fold, so the gate is not passing on an empty climb.
  assert(rewrites.length >= 1, "Nothing ever committed, so append-only proves nothing here");
  assert(materialized(runtime).folds.length >= 1, "The climb folded nothing");

  // The carrier ledger: between commits the projection carries no runtime block at all.
  const projection = await project(runtime);
  const carriers = projection.messages.filter((message) =>
    typeof message?.customType === "string" &&
    /-(curation|advisory|milestone|surfacing)$/.test(message.customType));
  assert.deepEqual(carriers.map((message) => message.customType), [],
    "A pre-commit guidance carrier reached the projection");

  return {
    prefixRecords: prefixes.length,
    rewrites: rewrites.length,
    unattributedRewrites: unattributed.length,
    appends: prefixes.length - rewrites.length,
    folds: materialized(runtime).folds.length,
  };
}

async function gateRep19ShapeResolves() {
  // The death pattern, replayed at scale: six large stale paged-status results
  // holding about two thirds of the serving budget (rep 19: ~254k of 383,616
  // tokens) at high occupancy, then a window-pressure commit. In rep 19 this mass
  // was immortal and the runtime aborted the request.
  const built = makeStatusResultFixture({
    statusTurns: 6,
    statusChars: 41_000,
    trailingTurns: 4,
    trailingChars: 4_500,
    contextWindow: 100_000,
  });
  const runtime = makeRuntime(built, { foldScheduling: "epoch" });
  await startRuntime(runtime);
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.fired, "The window-pressure commit never fired");
  assert.equal(committed.commit.trigger, "window-pressure");

  // The eligible share is an order of magnitude over the reclaim floor: the status
  // mass is ladder food now, not immortal weight.
  assert.equal(committed.commit.reclaim_floor_share, context.COMMIT_RECLAIM_FLOOR_SHARE);
  assert(committed.commit.eligible_freed_share >= 10 * context.COMMIT_RECLAIM_FLOOR_SHARE,
    `Eligible share ${committed.commit.eligible_freed_share} is not an order of magnitude over the floor`);

  // The commit reclaims the status mass itself, oldest first, until the thermostat's
  // freeing target is met; the remainder stays eligible for the next event rather
  // than immortal, which is the rep-19 inversion.
  const folded = new Set(materialized(runtime).folds.flatMap((fold) =>
    fold.parts.flatMap((part) => part.kind === "raw" ? [part.ref.entryId] : [])));
  const foldedStatusResults = built.statusResultIds.filter((id) => folded.has(id));
  assert(foldedStatusResults.length >= 4,
    `Only ${foldedStatusResults.length} of ${built.statusResultIds.length} status results folded`);
  assert(committed.freedTokens >= 50_000,
    `The commit freed only ${committed.freedTokens} tokens of ~96k of status mass`);

  // The projection lands under budget without recourse to the recovery lane.
  await project(runtime);
  await settle();
  const automatic = (await toolStatus(runtime)).details.automatic;
  assert(typeof automatic.projectionEstimatedTokens === "number" &&
    automatic.projectionEstimatedTokens < automatic.projectionBudgetTokens,
    `The projection still estimates ${automatic.projectionEstimatedTokens} tokens against ` +
    `a ${automatic.projectionBudgetTokens}-token budget`);
  assert.equal(contextEvents(runtime).filter((event) => event.kind === "context.recovery").length, 0,
    "The reclaim needed the recovery lane");
  assert.equal(automatic.recovery.attempts, 0);
  assert.equal(runtime.aborts, 0, "A request was aborted at the fence");

  return {
    trigger: committed.commit.trigger,
    eligibleFreedShare: committed.commit.eligible_freed_share,
    reclaimFloorShare: context.COMMIT_RECLAIM_FLOOR_SHARE,
    statusResultsFolded: foldedStatusResults.length,
    statusResultsInWindow: built.statusResultIds.length,
    freedTokens: committed.freedTokens,
    projectionEstimatedTokens: automatic.projectionEstimatedTokens,
    projectionBudgetTokens: automatic.projectionBudgetTokens,
    recoveryAttempts: 0,
  };
}

async function gateProtectIsDurablePin() {
  // Protect is the pin. It must hold an expanded fold against the refold rung after
  // the lease runs out, hold entries out of commits, release on unprotect, land on
  // the event stream as context.protect, and be advertised in the description text,
  // because a verb nobody can discover is a verb nobody uses.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);
  const description = [...runtime.tools.values()][0].description;
  assert(description.includes("Protect is the pin"), "The pin is not advertised in the tool surface");

  for (const tokens of [70_000, 80_000, 86_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  await settle();
  const folds = materialized(runtime).folds;
  assert(folds.length >= 2, "Pressure must have produced at least two committed folds");
  const foldId = folds[0].id;
  // A second expanded fold stays UNpinned, so the refold rung has work to commit
  // while the pin is live and the pinned-mass accounting has a commit to ride.
  const unpinnedFoldId = folds[1].id;
  await toolCall(runtime, { action: "expand", id: foldId });
  await toolCall(runtime, { action: "protect", ids: [foldId] });
  await toolCall(runtime, { action: "expand", id: unpinnedFoldId });
  const pinned = stream().filter((record) => record.kind === "context.protect");
  assert.equal(pinned.length, 1, "A protect action must land exactly one context.protect record");
  assert.equal(pinned[0].protect, true);
  assert.equal(pinned[0].ids, foldId);
  assert(pinned[0].protected_refs_after > pinned[0].protected_refs_before,
    "Protecting a fold must add its evidence refs to the durable pin set");

  // Ten measured requests above the refold ratio: the 8-generation lease is long
  // exhausted, and the pin is the only thing keeping the span expanded.
  for (let index = 0; index < 10; index += 1) {
    await measure(runtime, 86_000 + index, 100_000, `pin-measurement-${index + 1}`);
    await project(runtime);
  }
  let state = materialized(runtime);
  assert(state.expanded.includes(foldId),
    "The pin must hold an expanded fold against the refold rung after the lease expires");
  assert.equal(state.leases[foldId], undefined, "The lease should be exhausted; only the pin holds");

  // Commits under pressure report the mass the pin held out of reach. Only commits
  // AFTER the pin landed can testify to it.
  const pinSeq = pinned[0].seq;
  const applied = stream().filter((record) =>
    record.kind === "context.commit" && record.deferred === false && record.seq > pinSeq);
  assert(applied.length >= 1, "The unpinned expanded fold must have produced an applied commit under pressure");
  assert(applied.every((record) =>
    Number.isSafeInteger(record.protected_stale_bytes) && Number.isSafeInteger(record.protected_stale_refs)),
    "Applied commits must carry the pinned-mass accounting");
  assert(applied.some((record) => record.protected_stale_bytes > 0),
    "A commit under a live pin must report nonzero protected stale mass");

  // Unpin: the release lands on the stream, the pin set drains, and the ladder may
  // reclaim the span again.
  await toolCall(runtime, { action: "unprotect", ids: [foldId] });
  const releases = stream().filter((record) =>
    record.kind === "context.protect" && record.protect === false);
  assert.equal(releases.length, 1);
  assert.equal(materialized(runtime).protected.length, 0, "Unprotect must drain the refs protect added");
  for (let index = 0; index < 3; index += 1) {
    await measure(runtime, 91_000 + index, 100_000, `unpin-measurement-${index + 1}`);
    await project(runtime);
  }
  state = materialized(runtime);
  assert(!state.expanded.includes(foldId), "After unprotect the refold rung must reclaim the span");
  assert(!state.expanded.includes(unpinnedFoldId), "The unpinned expanded fold should have been refolded under pressure");
  return {
    advertised: true,
    pinnedRefs: pinned[0].protected_refs_after,
    heldThroughMeasurements: 10,
    appliedCommitsWhilePinned: applied.length,
    maxProtectedStaleBytes: Math.max(...applied.map((record) => record.protected_stale_bytes)),
    refoldedAfterRelease: !state.expanded.includes(foldId),
  };
}

async function gateRecoveryNormAdvertised() {
  // The recovery norm. In the sol-20260809 rep-3 full run the model answered recall
  // questions about folded stages from memory and fabricated plausible values, while
  // every placeholder stated the exact expand call: the syntax was discoverable, the
  // norm was not. The norm rides the stable tool surface on BOTH description branches,
  // and disappears only when expand itself is not an allowed action.
  const surface = await jiti.import(join(projectRoot, "extensions", "lib", "tool-surface.ts"));
  const policy = await jiti.import(join(projectRoot, "extensions", "lib", "policy.ts"));
  const describe = (allowedActions, fullSurface) => surface.buildActiveContextTool({
    name: "active_context",
    label: "Active context",
    allowedActions,
    fullSurface,
    maxBriefChars: 1200,
    statusDetails: [],
    minPeekSliceBytes: 1,
    defaultPeekBytes: 4096,
    handler: async () => null,
  }).description;
  const norm = "A fold brief is an index entry, not the source";
  const full = describe([...policy.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS], true);
  assert(full.includes(norm), "The recovery norm is missing from the full surface");
  assert(full.includes("peek or expand that fold"), "The norm must name the recovery verbs");
  const configured = describe(["status", "expand"], false);
  assert(configured.includes(norm), "The recovery norm is missing from the configured surface");
  const noExpand = describe(["status", "fold"], false);
  assert(!noExpand.includes(norm), "A surface without expand must not preach a verb it lacks");
  return { advertisedOnFull: true, advertisedOnConfigured: true, silentWithoutExpand: true };
}

async function gateRiderIsOneLiteralPerEpoch() {
  // The rider is the one action-prompt carrier: composed at a fold commit, persisted
  // as LITERAL bytes, rendered beside the receipt inside the rewrite that commit
  // already paid for, never regenerated, replaced only by the next epoch's rider.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  for (const tokens of [70_000, 80_000, 86_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  await settle();
  const state = materialized(runtime);
  assert(state.folds.length >= 1, "Pressure must have produced a committed fold");
  assert(state.rider, "A commit must persist a rider");
  const appliedCommits = () => contextEvents(runtime)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  assert.equal(state.rider.epoch, appliedCommits().at(-1).seq,
    "The rider's epoch is the commit event it followed");
  const firstText = state.rider.text;
  const firstEpoch = state.rider.epoch;
  assert(firstText.length > 0 && firstText.length <= 4_096);
  const riderEntries = (projection) => projection.messages.filter((message) =>
    typeof message?.customType === "string" && message.customType.endsWith("-rider"));
  let riders = riderEntries(await project(runtime));
  assert.equal(riders.length, 1, "Exactly one rider entry rides the projection");
  assert.equal(riders[0].content, firstText, "The rider renders the persisted literal bytes");
  // Re-render with no commit in between: the SAME bytes, and still exactly one entry.
  riders = riderEntries(await project(runtime));
  assert.equal(riders.length, 1, "A frozen pass must not stack a second rider");
  assert.equal(riders[0].content, firstText, "A re-render must never regenerate the rider");
  assert.equal(materialized(runtime).rider.text, firstText);
  // Drive a later epoch the way gate 89 does: expand a fold so the refold rung has
  // new eligible mass, then hold pressure at the plateau until a commit applies it.
  // The rider must be REPLACED, not stacked, and the event stream must carry at
  // most one context.rider per epoch.
  await toolCall(runtime, { action: "expand", id: state.folds[0].id });
  for (let index = 0; index < 10 && materialized(runtime).rider.epoch === firstEpoch; index += 1) {
    await measure(runtime, 86_500 + index, 100_000, `rider-epoch-${index}`);
    await project(runtime);
    await settle();
  }
  const later = materialized(runtime);
  assert(later.rider.epoch > firstEpoch, "A later commit must open a new rider epoch");
  assert.equal(later.rider.epoch, appliedCommits().at(-1).seq);
  const riderEvents = contextEvents(runtime).filter((record) => record.kind === "context.rider");
  assert(riderEvents.length >= 2, "Rider emission must land on the canonical event stream");
  assert.equal(new Set(riderEvents.map((record) => record.epoch)).size, riderEvents.length,
    "At most one rider per fold epoch");
  assert.equal(riderEntries(await project(runtime)).length, 1,
    "Later epochs replace the rider entry rather than stacking it");
  // The rider is a projection carrier ONLY: no tool-result content anywhere in the
  // branch or the projection may carry its header.
  const headerMark = " notice] A fold commit just landed";
  const projection = await project(runtime);
  const toolResultTexts = [...runtime.branch, ...projection.messages]
    .filter((entry) => (entry?.message ?? entry)?.role === "toolResult")
    .map((entry) => JSON.stringify((entry?.message ?? entry).content ?? ""));
  assert(toolResultTexts.length > 0, "The fixture must actually carry tool results");
  assert(toolResultTexts.every((text) => !text.includes(headerMark)),
    "The rider must never land inside tool-result content");
  return {
    epochs: riderEvents.length,
    riderEvents: riderEvents.length,
    literalBytes: firstText.length,
    replacedNotStacked: true,
  };
}

async function gatePinnedShareCap() {
  // The pin ceiling: protect refuses past MAX_PINNED_SHARE of the working window,
  // names the cap and the release valve, and pins NOTHING on refusal. Under the cap
  // the verb works exactly as before.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  for (const tokens of [70_000, 80_000, 86_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  await settle();
  const folds = materialized(runtime).folds;
  assert(folds.length >= 2, "Pressure must have produced at least two committed folds");
  const refusal = await toolCall(runtime, { action: "protect", ids: folds.map((fold) => fold.id) })
    .catch((error) => error);
  assert.match(String(refusal), /pinned-share cap/,
    "Pinning everything must refuse past the cap");
  assert.match(String(refusal), new RegExp(`${Math.round(context.MAX_PINNED_SHARE * 100)}%`),
    "The refusal must name the cap");
  assert.match(String(refusal), /unprotect/, "The refusal must name the release valve");
  assert.equal(materialized(runtime).protected.length, 0, "A refused protect must pin nothing");
  const smallest = [...folds].sort((left, right) =>
    (left.sourceChars ?? 0) - (right.sourceChars ?? 0))[0];
  await toolCall(runtime, { action: "protect", ids: [smallest.id] });
  const pinned = materialized(runtime).protected.length;
  assert(pinned > 0, "A pin under the cap must still land");
  return { cap: context.MAX_PINNED_SHARE, refused: true, pinnedUnderCap: pinned };
}

async function gateRiderContentLaw() {
  // The rider carries decisions, never pressure readouts: pin verbs and the pinned
  // share against its cap IN, raw occupancy and unmarked percentages OUT, bounded,
  // and byte-deterministic for identical inputs.
  const input = {
    toolName: "active_context",
    pendingAgentMarks: 2,
    eligibleMarks: 3,
    freedTokens: 1_200,
    eligibleFreedTokens: 800,
    anchors: ["entry-a", "entry-b", "entry-c"],
    pinnedShare: 0.12,
    maxPinnedShare: context.MAX_PINNED_SHARE,
  };
  const text = context.contextRiderText(input);
  assert(text.includes('"action":"protect"') && text.includes("unprotect"),
    "The rider must carry both pin verbs");
  assert(text.includes("12%") && text.includes(`${Math.round(context.MAX_PINNED_SHARE * 100)}% cap`),
    "The rider must state the pinned share against its cap");
  assert(text.includes("entry-a, entry-b, entry-c"), "The rider must carry the anchors");
  assert(text.includes("800") && text.includes("1200"),
    "The rider must carry the eligible/freed token numbers");
  assert(!/occupanc|unmarked|% full|distance|headroom/i.test(text),
    "Raw pressure readouts stay out of the rider");
  assert(Buffer.byteLength(text, "utf8") <= 2_048, "The rider is hard-bounded");
  assert.equal(text, context.contextRiderText(input), "Identical inputs give identical bytes");
  const empty = context.contextRiderText({ ...input, anchors: [], pinnedShare: 0 });
  assert(empty.includes("none"), "An empty anchor list says so instead of vanishing");
  return { bounded: true, deterministic: true, verbs: ["protect", "unprotect"] };
}

const gates = [
  [1, "Registration & parse", gateRegistration],
  [2, "Fold lattice & recovery", gateFoldLattice],
  [3, "Autonomous ladder", gateAutonomousLadder],
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
  [21, "Deployment branding reproduction", gateDeploymentBrandingReproduction],
  [22, "Evidence ingestion switch", gateEvidenceIngestionSwitch],
  [23, "Summarizer option", gateSummarizerOption],
  [25, "Peek and fold index", gatePeekAndFoldIndex],
  [26, "Surfacing selector", gateSurfacingSelector],
  [27, "Surfacing threshold & budget", gateSurfacingThresholdAndBudget],
  [28, "Surfacing hysteresis", gateSurfacingHysteresis],
  [32, "Epoch mark/commit lifecycle", gateEpochMarkCommit],
  [33, "Immediate-mode byte identity & peek-fold override absence", gateImmediateByteIdentity],
  [34, "Epoch quota top-up", gateEpochQuotaTopUp],
  [35, "Mark always means mark", gateMarkAlwaysMeansMark],
  [36, "Ephemeral peek auto-mark", gateEphemeralPeekMark],
  [37, "Commit on threshold", gateCommitOnThreshold],
  [38, "Scheduling wire round-trip", gateSchedulingWireRoundTrip],
  [39, "Epoch mark accumulation", gateMarkAccumulation],
  [40, "Epoch inline rung reachability", gateEpochInlineRungs],
  [41, "Surfacing key-order digest stability", gateSurfacingKeyOrder],
  [42, "Peek-fold override reaches a starved ladder", gatePeekFoldOverride],
  [45, "Truthful capacity & admission control", gateTruthfulCapacityAdmission],
  [46, "Retained pending marks", gateRetainedPendingMarks],
  [48, "Status index diet", gateStatusIndexDiet],
  [85, "Evidence artifacts are content-addressed and immutable", gateEvidencePrimitives],
  [86, "No operator home paths in tracked files", gateNoOperatorPaths],
  [50, "Projection instrumentation", gateProjectionInstrumentation],
  [51, "Stage-identified fold briefs", gateStageIdentifiedBriefs],
  [52, "Current-turn commit guard", gateCurrentTurnCommitGuard],
  [53, "Pinned mass backstop", gatePinnedMassBackstop],
  [55, "Epoch batching under the full lever set", gateEpochBatchingUnderFullLevers],
  [56, "Projection budget fence & guard waiver", gateProjectionBudgetFence],
  [57, "Fixed-constant misjudgement & post-fence integrity", gateProjectionCalibration],
  [58, "Fence margin, calibration recency & commit depth", gateFenceMarginAndDepth],
  [59, "Two-signal curation trigger", gateCurationTrigger],
  [61, "Context action receipts", gateContextReceipts],
  [62, "Batched marks & loud auto-snap", gateAutoSnapAndCorrections],
  [63, "Symmetric re-boundary", gateSymmetricReboundary],
  [64, "Bite-sized folds & auto-split", gateBiteSizedFolds],
  [65, "Wedge absorption & the anti-LCM pin", gateWedgeAbsorption],
  [66, "Overflow rollback & recovery", gateOverflowRecovery],
  [67, "Context event stream", gateContextEventStream],
  [68, "Lever collapse", gateLeverCollapse],
  [69, "Quiet runtime & rep-15 storm replay", gateQuietRuntimeStormReplay],
  [70, "One truthful serving budget", gateOneTruthfulBudget],
  [72, "Accept-and-hold marks", gateAcceptAndHold],
  [73, "Standing facts ride the stable prefix", gateCurationCopyAndReceipts],
  [74, "One structural mutation per handoff", gateMutationBudgetPerHandoff],
  [75, "No agent-callable commit verb", gateNoAgentCommitVerb],
  [76, "No-yield commit guard on every path", gateNoYieldCommitGuard],
  [78, "Frozen surface & invisible marks", gateFrozenSurface],
  [79, "Mark response awareness", gateMarkResponseAwareness],
  [80, "Batched-mark copy", gateBatchedMarkCopy],
  [81, "Status pages are bounded", gateStatusPagesAreBounded],
  [82, "Status results are ladder food", gateStatusResultsAreLadderFood],
  [83, "No permanently unfoldable unit", gateNoPermanentlyUnfoldableUnit],
  [84, "The rep-19 shape resolves", gateRep19ShapeResolves],
  [87, "The projection is append-only", gateProjectionIsAppendOnly],
  [88, "A peek never rewrites the window", gatePeekIsAppendOnly],
  [89, "Protect is a durable pin", gateProtectIsDurablePin],
  [90, "Recovery is the stated norm", gateRecoveryNormAdvertised],
  [91, "The rider is one literal per epoch", gateRiderIsOneLiteralPerEpoch],
  [92, "The pinned-share cap refuses", gatePinnedShareCap],
  [93, "The rider carries decisions, not readouts", gateRiderContentLaw],
];

const gateFilter = (process.env.GATES ?? "")
  .split(",")
  .map((part) => Number.parseInt(part.trim(), 10))
  .filter((number) => Number.isInteger(number));
const selected = gateFilter.length ? gates.filter(([number]) => gateFilter.includes(number)) : gates;
if (gateFilter.length) {
  process.stdout.write(
    `PARTIAL RUN: GATES=${gateFilter.join(",")} selects ${selected.length}/${gates.length} gates. This is NOT a shipping verdict.\n`,
  );
}

let failures = 0;
for (const [number, name, run] of selected) {
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
