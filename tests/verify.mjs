#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const jitiPath = join(projectRoot, "node_modules", "jiti", "lib", "jiti.mjs");
if (!existsSync(jitiPath)) throw new Error("Could not resolve package-local jiti for the active-context verifier");
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url);
const context = await jiti.import(join(projectRoot, "extensions", "active-context.ts"));
const json = await jiti.import(join(projectRoot, "extensions", "json.ts"));

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
  policy = {},
  contextWindow = 272_000,
} = {}) {
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
    const named = mentionToolName ? " Ask quorum_context for the exact candidate." : "";
    ids.push(add({
      role: "user",
      content: [{
        type: "text",
        text: `Task ${turn}: inspect exact evidence.${named}${" u".repeat(chapterChars)}`,
      }],
      timestamp: sequence,
    }));
    if (tools) {
      ids.push(add({
        role: "assistant",
        content: [{
          type: "toolCall", id: `call-${turn}`, name: "read",
          arguments: { path: `file-${turn}.txt` },
        }],
        stopReason: "toolUse",
        timestamp: sequence,
      }));
      ids.push(add({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName: "read",
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
  entryTypePrefix,
  commandPrefix,
  commandNames,
  summarizeContextSpan,
  initialEntries,
  readOnlyTools,
  blockingTools,
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
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      buildContextEntries: () => branch,
      buildSessionContext: () => ({ messages }),
    },
  };
  context.registerActiveContext(pi, {
    ...(toolName ? { toolName } : {}),
    ...(entryTypePrefix ? { entryTypePrefix } : {}),
    ...(commandPrefix ? { commandPrefix } : {}),
    ...(commandNames ? { commandNames } : {}),
    ...(summarizeContextSpan ? { summarizeContextSpan } : {}),
    ...(readOnlyTools ? { readOnlyTools } : {}),
    ...(blockingTools ? { blockingTools } : {}),
  });
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

async function toolStatus(runtime, toolName = "quorum_context", detail) {
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

async function gateRegistration() {
  const defaults = makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }));
  assert.deepEqual([...defaults.tools.keys()], ["quorum_context"]);
  assert.deepEqual([...defaults.commands.keys()].sort(), ["fold-context", "quorum-context"]);
  await startRuntime(defaults);

  const custom = makeRuntime(makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }), {
    toolName: "ctx_tool",
    entryTypePrefix: "custom-context",
    commandPrefix: "sandbox",
  });
  assert.deepEqual([...custom.tools.keys()], ["ctx_tool"]);
  assert.deepEqual([...custom.commands.keys()].sort(), ["sandbox-fold-context", "sandbox-quorum-context"]);
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
    defaultTool: "quorum_context",
    defaultCommands: [...defaults.commands.keys()].sort(),
    commands: [...custom.commands.keys()].sort(),
    namedCommands: [...named.commands.keys()].sort(),
    customTypes: types,
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
  structurallyValidHistoricalBrief[0].brief = "quorum_context";
  assert.equal(context.validateFoldForest(structurallyValidHistoricalBrief).length, 1);
  await assert.rejects(() => context.prepareFold({
    candidate,
    snapshot,
    state: empty,
    generation: 1,
    brief: "quorum_context",
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

function scheduleMap(contextWindow) {
  return Object.fromEntries(context.advisorySchedule({
    policy: context.ACTIVE_CONTEXT_POLICY,
    contextWindow,
  }).rungs.map((rung) => [rung.milestone, rung]));
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
    ["quorum-active-context-milestone", "quorum-active-context-advisory"].includes(message.customType));
  assert.equal(projected.length, 2);
  assert(projected.every((message) => message.role === "custom" && message.details?.ephemeral === true));
  assert.equal(projected[0].timestamp, 0);
  assert(Buffer.byteLength(projected[1].content, "utf8") <= 2_048);
  const repeatedProjection = await project(jump);
  const repeatedMilestone = repeatedProjection.messages.find((message) =>
    message.customType === "quorum-active-context-milestone");
  assert.equal(json.stableStringify(repeatedMilestone), json.stableStringify(projected[0]));
  let jumpStatus = await toolStatus(jump);
  assert.deepEqual(jumpStatus.details.automatic.advisory.delivered, { chapters: 1 });
  assert.equal(jumpStatus.details.automatic.advisory.armed.milestone, "chapters");
  near(jumpStatus.details.automatic.advisory.armed.threshold, wide.chapters.threshold);
  assert.match(jumpStatus.details.automatic.advisory.armed.scheduleKey, /^[a-f0-9]{64}$/);
  jump.usage = { tokens: 233_920, contextWindow: 100_000 };
  const changedWindowProjection = await project(jump);
  const changedWindowMilestone = changedWindowProjection.messages.find((message) =>
    message.customType === "quorum-active-context-milestone");
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
    message.customType === "quorum-active-context-milestone");
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
  const response = await runtime.tools.get("quorum_context").execute(
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
  const response = await runtime.tools.get("quorum_context").execute(
    "poisoned-floor",
    action,
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  assert.equal(response.details.kind, "chapter");
  assert.equal(response.details.provenance.kind, "deterministic");
  assert(response.details.brief.length > 20 && response.details.brief.length <= 1_200);
  assert(!/quorum_context/i.test(response.details.brief));
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
    "quorum-active-context-guidance-reduction",
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
  await runtime.tools.get("quorum_context").execute(
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
  await runtime.tools.get("quorum_context").execute(
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
    await boundedRuntime.tools.get("quorum_context").execute(
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
  const status = await toolStatus(runtime, "quorum_context", "fold_candidates");
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

  // Phase A used an exact-record reader. Its rejection of Phase-B-only fields
  // is expected forward incompatibility until the next explicit wire bump;
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
  near(context.hardFenceRatio({ contextWindow: 16_000 }), 0.90, 1e-12, "16k fence");
  near(context.hardFenceRatio({ contextWindow: 17_000 }), 0.90, 1e-12, "17k fence");
  near(
    context.hardFenceRatio({ contextWindow: 0 }),
    context.ACTIVE_CONTEXT_POLICY.fallbackChapterFoldRatio,
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
    context.ACTIVE_CONTEXT_POLICY.fallbackChapterFoldRatio,
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
