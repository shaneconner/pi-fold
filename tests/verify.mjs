#!/usr/bin/env node

import baseAssert from "node:assert/strict";

// EVERY ASSERTION IS COUNTED, because wall clock alone cannot tell a gate that proves
// something expensive from one that builds an expensive fixture and then proves nothing.
// Gate 98 spent a QUARTER of this suite driving a five-stage pinned-inflow phase whose
// audit loop ran over an empty array: the claim was vacuous, and the fresh-tail deletion
// it should have caught went straight through it. Assertions per gate, and per second of
// wall clock, is the reading that finds that class of rot. It is a suite instrument and
// not a gate: a low count is a question to answer, never a failure on its own.
const assertionCounts = new Map();
let assertionBucket = "startup";
const countAssertion = () => assertionCounts.set(assertionBucket, (assertionCounts.get(assertionBucket) ?? 0) + 1);
const COUNTED_ASSERTIONS = ["equal", "deepEqual", "notEqual", "notDeepEqual", "throws", "rejects", "match"];
const assert = Object.assign(
  (...args) => { countAssertion(); return baseAssert(...args); },
  Object.fromEntries(COUNTED_ASSERTIONS.map((name) => [
    name,
    (...args) => { countAssertion(); return baseAssert[name](...args); },
  ])),
);
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
const curationModule = await jiti.import(join(projectRoot, "extensions", "lib", "curation.ts"));
const piFold = await jiti.import(join(projectRoot, "extensions", "index.js"));
const evidenceModule = await jiti.import(join(projectRoot, "extensions", "evidence.js"));
const settingsModule = await jiti.import(join(projectRoot, "extensions", "settings.ts"));
const measurementModule = await jiti.import(join(projectRoot, "extensions", "lib", "measurement.ts"));
const persistenceModule = await jiti.import(join(projectRoot, "extensions", "lib", "persistence.ts"));
const policyModule = await jiti.import(join(projectRoot, "extensions", "lib", "policy.ts"));

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
  commands: Object.freeze(["acme-context", "fold-context", "fold-editor"]),
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
  // The topology neighbours are the one part of this literal that is not branding: an
  // epoch commit lands a BATCH of folds, so the first of them has a next sibling. The
  // siblings are passed in and every brand-derived token stays a literal.
  placeholder: (fold, topology) => [
    `[Acme active-context fold ${fold.id}]`,
    fold.brief,
    `Topology: kind=${fold.kind}; parent=root; children=0; previous=${topology.previous}; next=${topology.next}.`,
    `Expand exactly: acme_context {"action":"expand","id":"${fold.id}"}`,
    "List/page exactly: acme_context {\"action\":\"status\"}",
  ].join("\n"),
  handoffCompactionBrand: "Acme context ",
  completedCompaction: "native compaction completed; Acme folding state rebuilt",
  compactionNotice: "Pi native compaction ran; Acme folding state was rebuilt.",
  hardFenceNote: "Provider context reached the hard Acme fence without a newly committed lossless fold. The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.",
  mcpToolName: "mcp__acme__fetch",
  mcpOwnerKind: "acme-mcp",
  mcpOwnerId: "acme:active-context-test",
  evidenceDirectory: "acme-evidence",
  mcpServer: "acme",
});

/**
 * The fixture idiom for "nothing is protected by recency", stated in the one unit the
 * thermostat has. The protected tail is a SHARE of the serving budget, so a share that
 * rounds to zero bytes is how a fixture asks for no fresh tail: the old two-key
 * `{ freshTurns: 1, freshBytes: 0 }` override no longer exists to say it with.
 */
/**
 * A fixture's serving budget from the window it wants to model.
 *
 * `providerInputBudget` is ALREADY NET, so a fixture that used to declare a 100,000-token
 * total window and measure against the 90,000 the runtime netted out of it now declares
 * the 90,000 directly. Same arithmetic, stated once, on the caller's side of the API.
 */
const servingBudget = (window) => window - Math.min(16_384, Math.floor(window * 0.1));

const TINY_FOLD_FLOOR = Object.freeze({ ...context.DEFAULT_THRESHOLDS, minFoldChars: 1 });

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
  // Which tool the fixture's batches call. Every completed batch is auto-foldable now,
  // so this changes what the ladder is being shown, not whether it may act.
  toolName = "read",
  resultChars = 10_000,
  // Overrides the whole result body. Used by gate 134, where the SHAPE of the
  // result matters: a header line, then prose, then a blank line, then bulk.
  resultText = null,
  chapterChars = 0,
  mentionToolName = false,
  peekTurns = [],
  peekTargetId = "fold_probe",
  resultTail = null,
  readArguments = null,
  turnText = null,
  // Overrides the closing assistant text of each turn. Used by gate 135, where
  // an agent-recorded fact lives ONLY in that message and must survive the
  // consolidation that absorbs the turn as a gap.
  assistantText = null,
  // Pull-shaped session: ONE user prompt, then every turn is a single
  // assistant message carrying pullText(turn) beside the NEXT tool call, and
  // its result. This is the real worker geometry (rep 3: 36 of 37 assistant
  // messages carry text and the next call together); there is no standalone
  // closing assistant for a note to live in.
  pull = false,
  pullText = null,
  policy = {},
  thresholds,
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
    const named = mentionToolName ? " Ask pi_fold_context for the exact candidate." : "";
    if (pull) {
      if (turn === 0) {
        ids.push(add({
          role: "user",
          content: [{ type: "text", text: "Task: pull every stage and record findings as you go." }],
          timestamp: sequence,
        }));
      }
      const note = pullText && turn > 0 ? pullText(turn) : null;
      ids.push(add({
        role: "assistant",
        content: [
          ...(note ? [{ type: "text", text: note }] : []),
          {
            type: "toolCall",
            id: `call-${turn}`,
            name: toolName,
            arguments: readArguments ? readArguments(turn) : { path: `file-${turn}.txt` },
          },
        ],
        stopReason: "toolUse",
        timestamp: sequence,
      }));
      ids.push(add({
        role: "toolResult",
        toolCallId: `call-${turn}`,
        toolName,
        content: [{
          type: "text",
          text: resultText
            ? resultText(turn)
            : `Result ${turn}: ${"r".repeat(resultChars)}${resultTail ? ` ${resultTail(turn)}` : ""}`,
        }],
        isError: false,
        timestamp: sequence,
      }));
      turnEntries.push(ids);
      continue;
    }
    ids.push(add({
      role: "user",
      content: [{
        type: "text",
        text: `Task ${turn}: inspect exact evidence.${named}` +
          `${turnText ? ` ${turnText(turn)}` : ""}${" u".repeat(chapterChars)}`,
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
          name: peek ? "pi_fold_context" : toolName,
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
        toolName: peek ? "pi_fold_context" : toolName,
        content: [{
          type: "text",
          text: resultText
            ? resultText(turn)
            : `Result ${turn}: ${"r".repeat(resultChars)}${resultTail ? ` ${resultTail(turn)}` : ""}`,
        }],
        isError: false,
        timestamp: sequence,
      }));
    }
    ids.push(add({
      role: "assistant",
      content: [{
        type: "text",
        text: assistantText
          ? assistantText(turn)
          : `Completed task ${turn}.${" a".repeat(chapterChars)}`,
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
    ...(thresholds ? { thresholds } : {}),
  });
  return { sessionId, entries, messages, snapshot, turnEntries, contextWindow };
}

async function commitCandidate(
  state,
  snapshot,
  candidate,
  { brief, briefProvenance, generation = 1, now = 1 } = {},
) {
  assert(candidate, "Expected an eligible fold candidate");
  const prepared = await context.prepareFold({
    candidate, snapshot, state, generation, brief, briefProvenance, now: () => now,
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
  commandNames,
  initialEntries,
  blacklistAutoFoldTools,
  thresholds,
  retiredOptions,
  removedOptions,
  registerEvidence = false,
  // The degrade probe: a headless host may expose no sendMessage at all, and
  // the runtime must fall back to the appended advisory rather than throw.
  omitSendMessage = false,
  providerInputBudget,
  postFoldNotice,
  workingMemory,
  packageRegistration = false,
  sessionFile = join(tmpdir(), "pi-fold-test-session.jsonl"),
  // One injection point for a durable write that FAILS. Persistence is the only place
  // this runtime can lose a commit it has already computed, and a gate that cannot make
  // that write fail can only pin the source line rather than the behaviour.
  beforeAppend,
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
  const steered = [];
  const labels = [];
  const abandoned = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    ...(omitSendMessage ? {} : {
      sendMessage(message, options) { steered.push({ message, options }); },
    }),
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    async appendEntry(customType, data) {
      beforeAppend?.(customType, data);
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
    steered, labels, abandoned,
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
      getEntry: (id) => branch.find((entry) => entry.id === id) ?? null,
      buildContextEntries: () => branch,
      // Rebuilt from the TREE, the way pi rebuilds it, which is what makes the
      // rollback's pre-strip check a measurement rather than a tautology: agent state is
      // already one message short here, the tree is not.
      buildSessionContext: () => ({
        messages: branch.filter((entry) => entry.type === "message").map((entry) => entry.message),
      }),
      // The rollback surfaces, modelled the way pi implements them: a label appends at
      // the CURRENT leaf and advances it, and a branch moves the leaf without appending.
      // The abandoned entries stay in the file, which is what makes the tree lineage.
      appendLabelChange(entryId, label) {
        const entry = customEntry(
          "label",
          { entryId, label },
          `runtime-label-${String(++sequence).padStart(4, "0")}`,
          branch.at(-1)?.id ?? null,
        );
        labels.push({ entryId, label, id: entry.id });
        abandoned.push(entry);
        branch.push(entry);
        return entry;
      },
      branch(targetId) {
        const at = branch.findIndex((entry) => entry.id === targetId);
        if (at < 0) throw new Error(`No such entry: ${targetId}`);
        for (const entry of branch.slice(at + 1)) abandoned.push(entry);
        branch.length = at + 1;
        messages.length = branch.filter((entry) => entry.type === "message").length;
        return targetId;
      },
      resetLeaf() {
        for (const entry of branch) abandoned.push(entry);
        branch.length = 0;
        messages.length = 0;
      },
    },
  };
  const registrationOptions = {
    ...(toolName ? { toolName } : {}),
    ...(toolLabel ? { toolLabel } : {}),
    ...(brandNoun ? { brandNoun } : {}),
    ...(entryTypePrefix ? { entryTypePrefix } : {}),
    ...(commandNames ? { commandNames } : {}),
    ...(blacklistAutoFoldTools ? { blacklistAutoFoldTools } : {}),
    ...(thresholds ? { thresholds } : {}),
    ...(retiredOptions ?? {}),
    // Deleted options, forwarded verbatim so gate 68 can prove they are REFUSED.
    ...(removedOptions ?? {}),
    ...(providerInputBudget === undefined ? {} : { providerInputBudget }),
    ...(postFoldNotice === undefined ? {} : { postFoldNotice }),
    ...(workingMemory === undefined ? {} : { workingMemory }),
  };
  if (packageRegistration) {
    runtime.registration = piFold.registerPiFold(pi, registrationOptions);
  } else {
    // The internal seam. Evidence first, then the runtime, which is the order the
    // package entry uses; a deployment registering the seam directly (the experiment
    // harness, the branding fixture) wires the same pair by hand.
    if (registerEvidence) evidenceModule.registerEvidenceIngestion(pi, { entryTypePrefix });
    runtime.registration = context.registerActiveContext(pi, registrationOptions);
  }
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

/**
 * A provider input-overflow, delivered the way pi delivers one.
 *
 * The rejection never resolves a response, so there is no status code to observe. What
 * the extension sees is an assistant entry whose stop reason is "error", persisted on
 * the branch, followed by `session_before_compact` with reason "overflow" and willRetry
 * true -- at which point pi has ALREADY stripped that message from agent state, which is
 * what the harness models by leaving `messages` one short of the branch.
 */
async function overflow(runtime, { willRetry = true, tail } = {}) {
  const entry = runtime.appendMessage(tail ?? {
    role: "assistant",
    stopReason: "error",
    errorMessage: "prompt is too long: 410000 tokens > 400000 maximum",
    content: [{ type: "text", text: "" }],
    timestamp: 9_000,
  }, "provider-overflow");
  // pi's pre-strip: the error message leaves agent state before the event fires.
  runtime.messages.pop();
  void entry;
  const result = await runtime.handlers.get("session_before_compact")({
    reason: "overflow",
    willRetry,
    branchEntries: runtime.branch,
    preparation: {},
    signal: undefined,
  }, runtime.ctx);
  await settle();
  return result;
}

async function project(runtime) {
  return runtime.handlers.get("context")({ messages: runtime.messages }, runtime.ctx);
}

/**
 * THE COMMIT BOUNDARY. Pi fires this where it would otherwise compact, and it is the only
 * point at which the runtime mutates the projection. A fixture that needs a commit fires
 * it here rather than pushing occupancy over a threshold, because there is no threshold.
 */
async function compactBoundary(runtime, reason = "threshold") {
  const result = await runtime.handlers.get("session_before_compact")({
    reason,
    willRetry: false,
    branchEntries: runtime.branch,
    preparation: {},
    signal: undefined,
  }, runtime.ctx);
  await settle();
  return result;
}

/**
 * Drive one epoch to its commit. A measurement runs the ladder, which MARKS; the
 * boundary is where the epoch commits and folds apply. Gates whose invariant is about a
 * committed fold drive both halves through this, which is the same pressure drive gates
 * 88 through 93 use, named once.
 *
 * It stops AT the commit and does not project afterwards, because a projection runs the
 * ladder again and the mark it lands overwrites the epoch record the caller came for.
 * A gate that wants the post-commit view calls project() itself.
 */
async function measureAndCommit(
  runtime, tokens, contextWindow = runtime.usage.contextWindow, suffix, stopReason,
) {
  await measure(runtime, tokens, contextWindow, suffix, stopReason);
  await project(runtime);
  await settle();
  await compactBoundary(runtime);
  return materialized(runtime);
}

// The last terminal assistant stop, read inline where a fixture has to prove its shape:
// the runtime keeps no turn-scoped reading any more (the current-turn guard and its
// waiver were deleted 2026-08-23), so the suite computes the old boundary itself where
// a gate documents what that reading would have held.
function terminalStopIn(messages) {
  return messages.some((message) => message?.role === "assistant" &&
    (message.stopReason === "stop" || message.stopReason === "length"));
}

function toolResultRefKeys(snapshot) {
  return new Set(snapshot.mapped
    .filter((item) => item.ref && item.message?.role === "toolResult")
    .map((item) => json.objectRefKey(item.ref)));
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
  await compactBoundary(runtime);
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

async function toolStatus(runtime, toolName = "pi_fold_context", detail) {
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
async function pagedStatusRows(runtime, detail, toolName = "pi_fold_context") {
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
    thresholds: TINY_FOLD_FLOOR,
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
    thresholds: TINY_FOLD_FLOOR,
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

/** The root-sibling neighbours a rendered placeholder names, read off the committed state. */
function foldSiblings(branch, sessionId, foldId, entryTypePrefix) {
  const state = context.materializeActiveContextState(
    branch, sessionId, `${entryTypePrefix}-state`, `${entryTypePrefix}-fold-record`,
  );
  const position = new Map(branch.map((entry, index) => [entry.id, index]));
  // Siblings are transcript neighbours, not state-insertion neighbours, so the order is
  // rebuilt from where each root's earliest source entry sits in the branch.
  const roots = state.folds
    .filter((fold) => fold.parentId === null)
    .map((fold) => ({
      id: fold.id,
      at: Math.min(...context.flattenFoldRefs(fold, state)
        .map((ref) => position.get(ref.entryId) ?? Number.MAX_SAFE_INTEGER)),
    }))
    .sort((left, right) => left.at - right.at)
    .map((fold) => fold.id);
  const at = roots.indexOf(foldId);
  assert(at >= 0, "The rendered fold is not a root of the committed state");
  return { previous: at > 0 ? roots[at - 1] : "none", next: at < roots.length - 1 ? roots[at + 1] : "none" };
}

async function collectRegistrationSurface(registration, mcpToolName) {
  const scratch = await mkdtemp(join(tmpdir(), "pi-fold-branding-"));
  try {
    // The package entry when there is nothing to say, which is the point of hardwiring
    // the identity; the internal seam when a synthetic brand has to be registered, which
    // registerPiFold now refuses by name.
    const runtimeOptions = {
      ...registration,
      packageRegistration: Object.keys(registration).length === 0,
      registerEvidence: true,
      sessionFile: join(scratch, "session.jsonl"),
    };
    const runtime = makeRuntime(
      makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
      runtimeOptions,
    );
    const tool = [...runtime.tools.values()][0];
    await startRuntime(runtime);
    const initialStatus = structuredClone(runtime.statuses.at(-1));
    await measureAndCommit(runtime, 80_500, 100_000);
    const foldedProjection = await project(runtime);
    const foldedRecord = runtime.appended.find((entry) => entry.customType.endsWith("-fold-record"));
    assert(foldedRecord?.data?.fold, `Branding fixture produced no fold: ${json.stableStringify({
      toolName: tool.name, appendedTypes: runtime.appended.map((entry) => entry.customType),
    })}`);
    // Read while the committed batch is intact: the native-compaction replay below
    // rebuilds the state, and the placeholder under test was rendered from THIS one.
    const foldTopology = foldSiblings(
      runtime.branch, "active-context-test", foldedRecord.data.fold.id,
      foldedRecord.customType.replace(/-fold-record$/, ""),
    );
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

    // The boundary the fold above already crossed IS the compaction decision now, so the
    // branding of that decision is read from it rather than from a second probe call.
    const handoffStatus = await toolStatus(runtime, tool.name);

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
      foldTopology,
      placeholderTexts,
      carrierTypes: carrierMessages.map((message) => message.customType).sort(),
      carrierTexts: carrierMessages.map((message) => message.content),
      carrierSources: carrierMessages.map((message) => message.details?.source),
      handoffCompaction: handoffStatus.details.automatic.lastCompactionDecision?.reason,
      completedCompaction: completedStatus.details.automatic.lastCompactionDecision?.reason,
      compactionNotices: runtime.notifications.map((notice) => notice.message),
      hardFenceNote: fenceStatus.details.automatic.pendingContextNote,
      evidence: {
        ownerKind: evidenceProjection.details.evidence.owner.kind,
        ownerId: evidenceProjection.details.evidence.owner.id,
        path: evidenceProjection.details.evidence.path,
        mcpServer: evidenceProjection.details.mcpServer,
        fallbackProjection: fallbackEvidenceProjection,
      },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function gateRegistration() {
  const defaults = makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }));
  // The default auto-fold blacklist is EMPTY: every completed tool batch is foldable
  // unmarked. A non-empty default would be an allow-list wearing the new name.
  assert.deepEqual([...context.AUTO_FOLD_BLACKLIST_DEFAULT], []);
  assert.deepEqual([...defaults.tools.keys()], ["pi_fold_context"]);
  assert.deepEqual([...defaults.commands.keys()].sort(), ["fold", "fold-editor", "fold-status"]);
  await startRuntime(defaults);

  const custom = makeRuntime(makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }), {
    toolName: "ctx_tool",
    entryTypePrefix: "custom-context",
    commandNames: { status: "sandbox-context", fold: "sandbox-fold-context" },
  });
  assert.deepEqual([...custom.tools.keys()], ["ctx_tool"]);
  assert.deepEqual([...custom.commands.keys()].sort(), ["fold-editor", "sandbox-context", "sandbox-fold-context"]);
  await startRuntime(custom);
  // The measurement marks; the boundary is where the epoch commits and the fold record
  // is written. Both have to run before the deployment's entry types can all be observed.
  // Driven by hand because materialized() reads the DEFAULT entry types and this runtime
  // persists under the custom prefix.
  await measureAndCommit(custom, 80_500, 100_000);
  const types = custom.appended.map((entry) => entry.customType);
  assert(types.includes("custom-context-provider-context-measurement"));
  assert(types.includes("custom-context-fold-record"));
  assert(types.includes("custom-context-state"));
  assert(types.every((type) => type.startsWith("custom-context-")));

  const named = makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }), {
    commandNames: { status: "context", fold: "fold-context" },
  });
  assert.deepEqual([...named.commands.keys()].sort(), ["context", "fold-context", "fold-editor"]);
  assert.throws(() => makeRuntime(makeFixture({ turns: 4, resultChars: 3_000 }), {
    commandNames: { status: "same", fold: "same" },
  }).tools, /distinct kebab-case/i);
  return {
    defaultTool: "pi_fold_context",
    defaultAutoFoldBlacklist: [...context.AUTO_FOLD_BLACKLIST_DEFAULT],
    defaultCommands: [...defaults.commands.keys()].sort(),
    commands: [...custom.commands.keys()].sort(),
    namedCommands: [...named.commands.keys()].sort(),
    customTypes: types,
  };
}

async function gateNeutralDefaultBranding() {
  // The defaults ARE the deployment identity now: the five branding options left the
  // public surface, so this asserts the shipped identity rather than a neutral stand-in.
  // The fixture brand still has to appear nowhere in it, which is what keeps the seam
  // that renders the Acme surface honest instead of vacuous.
  const surface = await collectRegistrationSurface({}, "mcp__docs__fetch");
  assert.equal(surface.toolName, "pi_fold_context");
  assert.equal(surface.toolLabel, "pi-fold Active Context");
  assert.deepEqual(surface.commands, ["fold", "fold-editor", "fold-status"]);
  assert.deepEqual(surface.initialStatus, {
    key: "pi-fold-active-context",
    text: "pi_fold_context folds: 0 · provider usage unmeasured",
  });
  assert.deepEqual(surface.entryTypes, [
    "pi-fold-active-context-fold-record",
    "pi-fold-active-context-state",
    "pi-fold-context-event",
    "pi-fold-native-compaction-decision",
    "pi-fold-native-compaction-receipt",
    "pi-fold-provider-context-measurement",
  ]);
  assert(surface.placeholderTexts.some((text) => text.startsWith("[pi-fold active-context fold ")));
  assert.deepEqual(surface.carrierTypes, ["pi-fold-active-context-receipts"]);
  assert(surface.carrierTexts.some((text) => text.startsWith("[pi-fold context actions] ")));
  assert.deepEqual(surface.carrierSources, ["pi-fold/active-context"]);
  assert(String(surface.handoffCompaction).startsWith("pi-fold context "),
    `The boundary decision is not brand-derived: ${surface.handoffCompaction}`);
  assert.equal(
    surface.completedCompaction,
    "native compaction completed; pi-fold folding state rebuilt",
  );
  assert(surface.compactionNotices.includes(
    "Pi native compaction ran; pi-fold folding state was rebuilt.",
  ));
  assert.equal(
    surface.hardFenceNote,
    "Provider context reached the hard pi-fold fence without a newly committed lossless fold. " +
      "The provider request was aborted before transmission; run /compact or make an explicit bounded context fold.",
  );
  assert.equal(surface.evidence.ownerKind, "pi-fold-mcp");
  assert.equal(surface.evidence.ownerId, "pi-fold:active-context-test");
  assert(surface.evidence.path.includes("/pi-fold-evidence/"));
  assert.equal(surface.evidence.mcpServer, "docs");
  // The MCP predicate is gone and the mcp__server__tool convention is the rule, so a
  // name outside the convention is deliberately NOT classified as MCP: it produces no
  // MCP evidence projection at all rather than one under a fallback server. That is the
  // true behavior, asserted as such.
  assert.equal(surface.evidence.fallbackProjection, undefined);
  assert.equal(new RegExp(DEPLOYMENT_IDENTITY_FIXTURE.originName, "i").test(json.stableStringify(surface)), false);
  return {
    tool: surface.toolName,
    label: surface.toolLabel,
    commands: surface.commands,
    entryTypes: surface.entryTypes,
    evidenceOwner: surface.evidence.ownerKind,
    mcpServer: surface.evidence.mcpServer,
    unconventionalNameProjected: false,
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
  assert(surface.placeholderTexts.includes(fixture.placeholder(surface.fold, surface.foldTopology)));
  assert.deepEqual(surface.carrierTypes, [fixture.receiptType]);
  assert(surface.carrierTexts.some((text) => text.startsWith(fixture.receiptPrefix)));
  assert.deepEqual(surface.carrierSources, [fixture.source]);
  assert(String(surface.handoffCompaction).startsWith(fixture.handoffCompactionBrand),
    `The boundary decision is not brand-derived: ${surface.handoffCompaction}`);
  assert.equal(surface.completedCompaction, fixture.completedCompaction);
  assert(surface.compactionNotices.includes(fixture.compactionNotice));
  assert.equal(surface.hardFenceNote, fixture.hardFenceNote);
  assert.equal(surface.evidence.ownerKind, fixture.mcpOwnerKind);
  assert.equal(surface.evidence.ownerId, fixture.mcpOwnerId);
  assert(surface.evidence.path.includes(`/${fixture.evidenceDirectory}/`));
  assert.equal(surface.evidence.mcpServer, fixture.mcpServer);
  // Same convention under a deployment identity: `opaque_mcp_tool` is not shaped
  // mcp__server__tool, so nothing classifies it and no fallback server is minted.
  assert.equal(surface.evidence.fallbackProjection, undefined);
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
    thresholds: TINY_FOLD_FLOOR,
  });
  assert.equal(context.validateTurnToolBatch(validBatchMessages, { start: 0, end: 5 }).calls.length, 2);
  const missingResult = structuredClone(validBatchMessages);
  missingResult.splice(2, 1);
  assert.equal(context.validateTurnToolBatch(missingResult, { start: 0, end: 4 }), null);
  // An arbitrary tool, one nobody put on a list: its completed batch validates, because
  // foldability is the default now. The same batch stops validating when the deployment
  // blacklists that tool, which is the only thing the list does.
  const arbitrary = structuredClone(validBatchMessages);
  arbitrary[1].content[0].name = "write";
  arbitrary[2].toolName = "write";
  assert.equal(context.validateTurnToolBatch(arbitrary, { start: 0, end: 5 }).calls.length, 2);
  assert.equal(
    context.validateTurnToolBatch(
      arbitrary, { start: 0, end: 5 }, "pi_fold_context", new Set(["write"]),
    ),
    null,
  );

  const empty = context.emptyActiveContextState("batch-session");
  const [candidate] = context.selectAutomaticToolBatch(snapshot, empty);
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
  structurallyValidHistoricalBrief[0].brief = "pi_fold_context";
  assert.equal(context.validateFoldForest(structurallyValidHistoricalBrief).length, 1);
  // A REJECTED SUPPLIED BRIEF SAYS WHICH RULE IT MISSED. The refusal used to name the
  // character cap whatever the brief did wrong, which told an agent nothing when its brief
  // was well inside the cap and structural. It carries the generator's own complaint now,
  // so the caller is told what to change and can mark again with the material it still has.
  await assert.rejects(() => context.prepareFold({
    candidate,
    snapshot,
    state: empty,
    generation: 1,
    brief: "pi_fold_context",
  }), /Supplied brief rejected\./);
  await assert.rejects(() => context.prepareFold({
    candidate, snapshot, state: empty, generation: 1, brief: "pi_fold_context",
  }), (error) => {
    assert(/Name concrete things from the span/.test(error.message),
      `A structural brief was refused with ${JSON.stringify(error.message)}`);
    // The wrong rule must not be named: this brief is fifteen characters.
    assert(!new RegExp(String(context.ACTIVE_CONTEXT_POLICY.maxBriefChars)).test(error.message),
      "A fifteen-character brief was refused by naming the character cap");
    return true;
  });
  await assert.rejects(() => context.prepareFold({
    candidate, snapshot, state: empty, generation: 1,
    brief: `Real facts about the span. ${"padding ".repeat(400)}`,
  }), (error) => {
    assert(new RegExp(`limit is ${context.ACTIVE_CONTEXT_POLICY.agentBriefReserve}`).test(error.message),
      `An over-long brief was refused with ${JSON.stringify(error.message)}`);
    assert(/Cut detail, not subjects/.test(error.message),
      "The over-long refusal does not say how to shorten it");
    return true;
  });

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
  // ONE MUTATION PER BOUNDARY. The invariant is unchanged and still counted at full
  // strength: one structural mutation, however many marks it carries, and every fold it
  // created is a tool-result fold. What moved is which pass pays for it, because the
  // crossing is the boundary Pi fires rather than an occupancy threshold we watch.
  const beforeCrossing = toolRuntime.appended.length;
  const measurement = await measure(toolRuntime, 80_000, 100_000);
  await project(toolRuntime);
  await settle();
  await compactBoundary(toolRuntime);
  const crossingCommits = contextEvents(toolRuntime, beforeCrossing)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  const toolCommit = await runtimeCommit(toolRuntime, { measured: false });
  const toolState = materialized(toolRuntime);
  assert.equal(crossingCommits.length, 1,
    "The boundary crossing performed more than one structural action");
  assert.equal(
    toolCommit.commits.filter((record) => record.deferred === false).length,
    0,
    "A second boundary with nothing left to fold committed anyway",
  );
  assert(toolState.folds.some((fold) => fold.kind === "tool-result"),
    `The commit epoch folded no completed tool batch: ${JSON.stringify(
      toolState.folds.map((fold) => fold.kind))}`);
  // One law, so the same commit also reclaims the raw narrative around the batch: what
  // it may never produce is a fold of anything else.
  assert(toolState.folds.every((fold) => ["tool-result", "chapter"].includes(fold.kind)),
    JSON.stringify(toolState.folds.map((fold) => fold.kind)));
  const toolRuntimeStatus = await toolStatus(toolRuntime);
  assert.equal(toolRuntimeStatus.details.automatic.lastAutomaticAction.kind, "epoch-commit");
  const structuralBefore = toolRuntime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  await toolRuntime.handlers.get("message_end")({ message: measurement }, toolRuntime.ctx);
  await settle();
  const structuralAfter = toolRuntime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length;
  assert.equal(structuralAfter, structuralBefore, "Stale projection measurement authorized work");

  const refoldBuilt = makeFixture({
    turns: 10, resultChars: 10_000, contextWindow: 100_000, thresholds: context.DEFAULT_THRESHOLDS,
  });
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
  // Two crossings: the refold decision lands as a MARK on the first pass and applies at
  // the boundary that follows it, which is the same batching contract every other rung
  // now keeps.
  await measureAndCommit(refoldRuntime, 85_000, 100_000, "refold-mark");
  await measureAndCommit(refoldRuntime, 85_100, 100_000, "refold-commit");
  const refoldState = materialized(refoldRuntime);
  assert.deepEqual(refoldState.expanded, []);

  // The consolidation rung is gone; the count law stands in its place. Six adjacent
  // stale roots are under the width, so the count owes no parent and automation steps
  // over every placeholder. Pressure does not buy one: the law counts folds.
  const narrow = await chapterForest(6);
  const narrowSnapshot = context.mapActiveContext({
    sessionId: narrow.sessionId,
    eventMessages: narrow.messages,
    contextEntries: narrow.entries,
    contextWindow: 100_000,
  });
  assert.deepEqual(context.selectAutomaticConsolidations(narrowSnapshot, narrow.state), []);
  const narrowSpan = context.selectAutomaticSpan(narrowSnapshot, narrow.state);
  assert.equal(narrowSpan.kind, "chapter", "Below the rule, automation stopped folding raw spans");
  assert(narrowSpan.parts.every((part) => part.kind === "raw"),
    "A below-threshold automatic span swallowed a placeholder");
  assert.equal(
    context.selectAutomaticCandidate(narrowSnapshot, narrow.state, 0.85)?.kind ?? null,
    null,
    "A below-threshold forest still exposed a consolidation",
  );

  // At the count the parent is owed and the epoch builds it. Eleven roots owe ONE parent
  // of exactly ten, stalest first; the eleventh is remainder and is left alone, which is
  // where this differs from the crossing rule it replaced (that one took the whole run).
  const forest = await chapterForest(11);
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
  await measureAndCommit(consolidationRuntime, 85_000, 100_000, "consolidation-commit");
  const consolidationState = materialized(consolidationRuntime);
  const consolidationStatus = await toolStatus(consolidationRuntime);
  const consolidated = consolidationState.folds.find((fold) => fold.kind === "consolidation");
  assert(consolidated, JSON.stringify(consolidationStatus.details.automatic));
  assert.equal(consolidated.parentId, null);
  assert.equal(consolidated.parts.length, context.DEFAULT_THRESHOLDS.consolidateAfter,
    "The parent took other than consolidateAfter roots");
  assert(consolidated.parts.every((part) => part.kind === "fold"));

  const chapterBuilt = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: 272_000,
    thresholds: context.DEFAULT_THRESHOLDS,
  });
  const chapterRuntime = makeRuntime(chapterBuilt, { thresholds: context.DEFAULT_THRESHOLDS });
  await startRuntime(chapterRuntime);
  await measure(chapterRuntime, 244_800, 272_000);
  await settle();
  const preparedStatus = await toolStatus(chapterRuntime);
  assert.equal(preparedStatus.details.automatic.pressureRatio, 0.90);
  assert.equal(typeof preparedStatus.details.automatic.preparedFoldId, "string");
  assert.equal(preparedStatus.details.automatic.lastAutomaticAction, null);
  const fenceTokens = 272_000 - context.ACTIVE_CONTEXT_POLICY.responseReserve;
  const preparedId = preparedStatus.details.automatic.preparedFoldId;
  await measureAndCommit(chapterRuntime, fenceTokens, 272_000, "fence-commit");
  const chapterStatus = await toolStatus(chapterRuntime);
  // The prepared chapter reaches the window through the SAME commit every other fold
  // takes: the epoch applies it as a mark, so the action is the commit and the fold is
  // the one that was warmed.
  assert.equal(chapterStatus.details.automatic.lastAutomaticAction.kind, "epoch-commit");
  const durableChapter = chapterRuntime.appended.find((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY && entry.data.fold.kind === "chapter");
  assert(durableChapter, "Prepared chapter did not persist its immutable fold record at the fence");
  assert(materialized(chapterRuntime).folds.some((fold) => fold.id === preparedId),
    "The warmed preparation never became a fold");
  assert.equal(materialized(chapterRuntime).prepared, undefined,
    "A spent preparation is still standing after its commit");
  assert.equal(chapterStatus.details.automatic.automaticSuspended, false);
  return {
    toolAt: 0.80,
    monotonicTokens: [50_000, 80_000],
    milestonePersistedBeforeFold: milestoneState.advisory.highWater,
    oneActionFolds: toolState.folds.length,
    staleMeasurement: "no-op",
    refoldAt: 0.85,
    consolidateAfter: context.DEFAULT_THRESHOLDS.consolidateAfter,
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
  });
  await startRuntime(runtime);
  const loaded = materialized(runtime);
  assert.equal(loaded.folds[0].provenance.kind, "luna");
  const slate = context.projectionSlateCandidates(loaded, built.snapshot);
  assert.equal(slate.find((item) => item.source_id === legacyFold.id).generator, "projection-model");
  // The round trip is driven by the FRONTIER now: the runtime cuts the next tool batch on
  // its own and briefs it deterministically, which is the provenance this asserts. The
  // agent has no create verb to reach for.
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 1, "Legacy fixture lacked a second tool fold for round-trip persistence");
  assert.equal(cuts[0].briefProvenance.kind, "deterministic");
  assert.equal(runtime.notifications.filter((notice) => /Conflicting durable/.test(notice.message)).length, 0);
  const durableLegacy = runtime.branch.find((entry) => entry.id === "legacy-luna-record");
  assert.equal(json.stableStringify(durableLegacy.data), originalRecordBytes);
  assert.equal(runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY &&
    entry.data.foldId === legacyFold.id).length, 0);
  assert.equal(materialized(runtime).folds.find((fold) => fold.id === legacyFold.id).provenance.kind, "luna");
  return {
    durableKind: "luna",
    payloadKind: cuts[0].briefProvenance.kind,
    slateGenerator: "projection-model",
    conflictingErrors: 0,
    durableRecordBytesUnchanged: true,
  };
}

async function gatePoisonedFloorRegression() {
  // A 100,000-token window, so the marked chapter is worth more than the commit's
  // reclaim floor: below it the epoch rightly defers and there is no fold to read.
  const built = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    mentionToolName: true,
    contextWindow: 100_000,
  });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  // The floor under test is a BRIEF floor, and a brief is fixed at the decision. The
  // decision is the FRONTIER's now: the runtime cuts the chapter and briefs it
  // deterministically without being asked, which is the composition this gate exists to
  // hold to a floor. That makes the fixture stronger rather than weaker, because the
  // deterministic brief was previously reachable only by deleting the brief from a
  // status-advertised action, and it is now the only brief this span ever gets.
  const cuts = await frontierCuts(runtime);
  const marked = cuts.find((mark) => mark.kind === "chapter");
  assert(marked, "Chapter-only fixture produced no chapter cut");
  assert.equal(marked.briefProvenance.kind, "deterministic");
  assert(marked.brief.length > 20 &&
    marked.brief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars);
  assert(!/pi_fold_context/i.test(marked.brief), "The deterministic brief leaked the tool name");
  const committed = await measureAndCommit(runtime, 86_000, 100_000, "poisoned-floor-commit");
  const folded = committed.folds.find((fold) => fold.id === marked.id);
  assert(folded, "The floor-checked mark never became a fold");
  assert.equal(folded.kind, "chapter");
  assert.equal(folded.brief, marked.brief);
  assert.equal(folded.provenance.kind, "deterministic");
  return {
    marked: true,
    committed: true,
    provenance: marked.briefProvenance.kind,
    brief: marked.brief,
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
  assert.equal(manual, undefined);
  // An overflow Pi will RETRY is the rollback lane's, and it always cancels: the runtime
  // moves the branch back past the request the provider refused rather than compacting.
  const overflow = await hook({
    reason: "overflow", willRetry: true, branchEntries: runtime.branch,
  }, runtime.ctx);
  assert.deepEqual(overflow, { cancel: true });
  // A THRESHOLD BOUNDARY IS ALWAYS CANCELLED, INCLUDING WHEN IT HANDS OFF NOTHING.
  // A three-turn tool-free window has nothing eligible, and letting Pi compact there
  // would trade the losslessness claim for a quieter failure: the window is starved, and
  // the fence, the abort and the rollback lane are what say so. The decision record
  // names which of the two crossings happened; the answer to Pi is the same.
  const barren = await hook({
    reason: "threshold", willRetry: false, branchEntries: runtime.branch, preparation: {},
  }, runtime.ctx);
  assert.deepEqual(barren, { cancel: true });
  const barrenReason = (await toolStatus(runtime)).details.automatic.lastCompactionDecision?.reason;
  assert.match(barrenReason, /nothing eligible to hand off$/);
  const loaded = makeRuntime(makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000 }));
  await startRuntime(loaded);
  await measure(loaded, 80_000, 100_000);
  await project(loaded);
  await settle();
  const threshold = await loaded.handlers.get("session_before_compact")({
    reason: "threshold", willRetry: false, branchEntries: loaded.branch, preparation: {},
  }, loaded.ctx);
  await settle();
  assert.deepEqual(threshold, { cancel: true });
  return {
    manual: "pass-through",
    thresholdWithNothingToHandOff: "cancel",
    thresholdWithAHandoff: "cancel",
    overflow: "cancel",
  };
}

async function gatePersistenceChain() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  // The record-before-state ordering is a property of the COMMIT's write, so the epoch
  // is driven through the context pass that performs it.
  await measureAndCommit(runtime, 80_000, 100_000);
  const recordIndexes = runtime.appended
    .map((entry, index) => (entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY ? index : -1))
    .filter((index) => index >= 0);
  assert(recordIndexes.length > 0, "The commit wrote no fold record");
  // Stated against the state entry that ADDS the folds, because the epoch writes state
  // for the pending marks before any fold exists. The crash-safety claim is unchanged:
  // every fold record is durable before the state that adopts it.
  const stateIndex = runtime.appended.findIndex((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY &&
    (entry.data.addFoldRefs ?? entry.data.foldRefs ?? []).length > 0);
  assert(stateIndex > Math.max(...recordIndexes),
    "Fold records did not precede the state that adopts them");
  const firstState = materialized(runtime);
  const foldId = firstState.folds[0].id;
  await runtime.tools.get("pi_fold_context").execute(
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
    appendOrder: [runtime.appended[recordIndexes[0]].customType, runtime.appended[stateIndex].customType],
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

async function gateExpandLeases() {
  // Ten turns rather than four, so the commit below has enough to build a forest and the
  // lease has a standing fold to hold.
  const built = makeFixture({ turns: 10, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 10_000, 100_000);
  await measure(runtime, 40_000, 100_000);
  // The ladder marked; the lease this gate is about only exists once a commit has
  // turned that mark into a fold, so the epoch is driven to its commit first.
  await measureAndCommit(runtime, 85_000, 100_000, "lease-commit");
  // A ROOT, not folds[0]. The commit cuts deeper now that no proportion holds the tail
  // back, so it reaches the consolidation count and folds[0] can be a CHILD; expanding a
  // child is refused by name until its parent is expanded, which is the fence working.
  // A TOP-LEVEL fold, by parentage. The commit reaches the consolidation count now that
  // the frontier stages ahead of it, so `folds[0]` can be a CHILD, and expanding a child
  // is refused by name until its parent is expanded, which is the fence working.
  const topLevel = materialized(runtime).folds.filter((fold) => fold.parentId === null);
  assert(topLevel.length >= 1, "The commit built no top-level fold to lease");
  const foldId = topLevel[0].id;
  await runtime.tools.get("pi_fold_context").execute(
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
  // The lease runs out on the eighth generation. Under the epoch the refold it
  // authorizes is a DECISION, so it re-collapses at a commit rather than in place;
  // the property is that the exhausted lease reclaims the span, within a bound.
  let passes = 0;
  for (; passes < 12; passes += 1) {
    await measureAndCommit(reloaded, 85_007 + passes, 100_000, `lease-measurement-${passes + 8}`);
    if (!materialized(reloaded).expanded.includes(foldId)) break;
  }
  state = materialized(reloaded);
  assert(!state.expanded.includes(foldId),
    "The exhausted lease never re-collapsed the span");
  assert.equal(state.leases[foldId], undefined);

  const wide = await chapterForest(65, 350);
  // Consolidation held off, so the 65 roots stay 65 roots. The cap under test is on the
  // LEASE MAP and needs more expandable roots than the cap allows; at the shipped
  // consolidateAfter of 10 the ladder seats them under six parents before the loop starts
  // and the fixture measures consolidation instead, which gate 13 already owns.
  const boundedRuntime = makeRuntime(wide, {
    thresholds: { ...context.DEFAULT_THRESHOLDS, consolidateAfter: 100 },
    initialEntries: [
      ...wide.entries,
      stateEntry(wide.sessionId, wide.state, "lease-bound-state", wide.entries.at(-1).id),
    ],
  });
  await startRuntime(boundedRuntime);
  // Roots read from the LIVE state after the runtime loaded it, not from the fixture's own
  // copy: a projection pass runs the frontier and the ladder before this point, so the
  // parentage that governs the expand fence is whatever the runtime is holding now.
  const rootIds = materialized(boundedRuntime).folds
    .filter((fold) => fold.parentId === null).map((fold) => fold.id);
  for (const id of rootIds) {
    // Parentage changes UNDER this loop: expanding a root exposes its children as raw
    // material, the frontier cuts what it finds there, and a consolidation can seat a
    // fold that was top-level a moment ago under a new parent. The refusal below is the
    // reading, rather than a `materialized()` per iteration: materializing replays the
    // whole branch, the branch grows by a state entry on every expand, and the pre-check
    // was therefore quadratic in the harness rather than in the runtime. Measured at 40.9
    // of this gate's 41.7 seconds, and 0.8 after. The fence refusal carries exactly the
    // same information, so nothing about what the loop asks for has changed.
    try {
      await boundedRuntime.tools.get("pi_fold_context").execute(
        `expand-${id}`,
        { action: "expand", id },
        new AbortController().signal,
        undefined,
        boundedRuntime.ctx,
      );
    } catch (error) {
      // The fence refusing a child whose parent is folded is the fence working, and this
      // loop is measuring the LEASE CAP rather than the fence. Anything else is a real
      // failure and is rethrown.
      if (!/Expand parent /.test(String(error?.message ?? error))) throw error;
    }
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

/**
 * CONSOLIDATION IS A PURE FUNCTION OF THE COUNT (Shane 2026-08-10).
 *
 * The old gate read a crossing: at or above CONSOLIDATE_AFTER unpinned folds,
 * placeholders became ordinary span material and one run per pass composed. That premise
 * is gone. What is pinned here is the arithmetic: from a count of n visible unheld roots,
 * n / consolidateAfter parents MUST exist, each holding exactly consolidateAfter
 * consecutive roots stalest first, the remainder left alone, and all of them formed in
 * ONE commit epoch rather than one per pass. A hold splits the run and each side counts
 * on its own; gap material between children falls into the parent; nothing is nested that
 * cannot be read back out.
 *
 * The count is over EVERY kind, a parent included, so the rule runs to a fixpoint and the
 * forest gets DEEPER: ten parents are a group and their grandparent is what puts the
 * oldest context several layers down after a long session (Shane 2026-08-10).
 */
async function gateConsolidationCountingRule() {
  const width = context.DEFAULT_THRESHOLDS.consolidateAfter;
  const snapshotOf = (built) => context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
  });

  // Below the width the count owes nothing, and no automatic span may take a placeholder
  // by any other route: chapters are raw material at every count now.
  const belowRule = await chapterForest(width - 1);
  const belowSnapshot = snapshotOf(belowRule);
  assert.equal(context.unpinnedStaleFolds(belowSnapshot, belowRule.state).length, width - 1);
  assert.deepEqual(context.selectAutomaticConsolidations(belowSnapshot, belowRule.state), [],
    "A below-count forest still owed a parent");
  const belowSpan = context.selectAutomaticSpan(belowSnapshot, belowRule.state);
  assert(!belowSpan || belowSpan.parts.every((part) => part.kind === "raw"),
    "A below-count automatic span swallowed a placeholder");

  // TWO FULL GROUPS AND A REMAINDER, IN ONE EPOCH. 21 roots owe exactly two parents:
  // the first ten under the first, the next ten under the second, one left alone.
  const wide = await chapterForest(2 * width + 1);
  const wideSnapshot = snapshotOf(wide);
  const eligible = context.unpinnedStaleFolds(wideSnapshot, wide.state)
    .map(({ fold }) => fold.id);
  assert(eligible.length >= 2 * width, `The fixture offered only ${eligible.length} eligible roots`);
  const groups = context.selectAutomaticConsolidations(wideSnapshot, wide.state);
  assert.equal(groups.length, Math.floor(eligible.length / width),
    `${eligible.length} roots owed ${Math.floor(eligible.length / width)} parents, got ${groups.length}`);
  groups.forEach((group, index) => {
    assert.equal(group.kind, "consolidation");
    assert.deepEqual(
      group.parts.flatMap((part) => part.kind === "fold" ? [part.foldId] : []),
      eligible.slice(index * width, (index + 1) * width),
      "A parent took other than its consolidateAfter consecutive roots, stalest first",
    );
  });
  const runtime = makeRuntime(wide, { initialEntries: [
    ...wide.entries,
    stateEntry(wide.sessionId, wide.state, "count-state", wide.entries.at(-1).id),
  ] });
  await startRuntime(runtime);
  await measureAndCommit(runtime, 88_000, 100_000, "count-law-commit");
  const state = materialized(runtime);
  const parents = state.folds.filter((fold) => fold.kind === "consolidation");
  assert.equal(parents.length, groups.length,
    `One epoch owed ${groups.length} parents and built ${parents.length}`);
  for (const parent of parents) {
    assert.equal(parent.parts.filter((part) => part.kind === "fold").length, width,
      "A parent carried other than consolidateAfter children");
    for (const part of parent.parts) {
      if (part.kind !== "fold") continue;
      assert.equal(state.folds.find((fold) => fold.id === part.foldId)?.parentId, parent.id,
        "Consolidation removed a child instead of nesting it");
    }
  }
  // And the state the law forbids does not survive its own epoch: no unheld run of
  // eligible roots is left standing at or above the width.
  const afterSnapshot = context.mapActiveContext({
    sessionId: wide.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  assert.deepEqual(context.selectAutomaticConsolidations(afterSnapshot, state), [],
    "A full group survived the epoch that was supposed to form it");

  // GAPS FALL IN, HOLDS SPLIT THE RUN. Ten roots with raw turns between them: the parent's
  // span runs first child to last child and swallows the gaps. Pin one gap and the run
  // splits into two shorter runs, so the count owes nothing at all.
  const gapped = makeFixture({
    turns: 30,
    tools: false,
    chapterChars: 3_500,
    thresholds: TINY_FOLD_FLOOR,
    contextWindow: 100_000,
  });
  let gappedState = context.emptyActiveContextState(gapped.sessionId);
  for (let turn = 0; turn < 2 * width; turn += 2) {
    const candidate = context.manualFoldCandidate(gapped.snapshot, gappedState,
      [gapped.turnEntries[turn][0], gapped.turnEntries[turn].at(-1)]);
    gappedState = (await commitCandidate(gappedState, gapped.snapshot, candidate, {
      brief: `Complete chapter ${turn} remains independently pageable and exactly recoverable.`,
      now: turn + 1,
    })).state;
  }
  const gappedSnapshot = snapshotOf(gapped);
  const gapGroups = context.selectAutomaticConsolidations(gappedSnapshot, gappedState);
  assert.equal(gapGroups.length, 1, "Ten roots across raw gaps owed one parent");
  assert.equal(gapGroups[0].parts.filter((part) => part.kind === "fold").length, width);
  assert(gapGroups[0].parts.some((part) => part.kind === "raw"),
    "The parent's span skipped the raw gaps between its children instead of absorbing them");
  const gapRefs = gapGroups[0].parts.flatMap((part) => part.kind === "raw" ? [part.ref] : []);
  const heldState = {
    ...gappedState,
    protected: [structuredClone(gapRefs[Math.floor(gapRefs.length / 2)])],
  };
  assert.deepEqual(context.selectAutomaticConsolidations(gappedSnapshot, heldState), [],
    "A pinned span inside a gap was absorbed instead of splitting the run");

  // DEPTH. A parent is a root like any other, so `consolidateAfter` parents are a group
  // and what they make is a grandparent. Read at width 3 rather than 10, because the
  // property is the arithmetic running to a fixpoint and not the size of the fixture:
  // nine roots make three parents, and three parents make one grandparent.
  const deepWidth = 3;
  const deep = await chapterForest(deepWidth * deepWidth);
  const deepSnapshot = context.mapActiveContext({
    sessionId: deep.sessionId,
    eventMessages: deep.messages,
    contextEntries: deep.entries,
    contextWindow: 100_000,
    thresholds: { ...context.DEFAULT_THRESHOLDS, consolidateAfter: deepWidth },
  });
  let deepState = deep.state;
  const layers = [];
  for (let round = 0; round < 4; round += 1) {
    const owed = context.selectAutomaticConsolidations(deepSnapshot, deepState);
    if (!owed.length) break;
    layers.push(owed.length);
    for (const candidate of owed) {
      assert.equal(candidate.parts.filter((part) => part.kind === "fold").length, deepWidth);
      deepState = (await commitCandidate(deepState, deepSnapshot, candidate, {
        brief: context.deterministicConsolidationBrief(candidate, deepState),
        briefProvenance: "deterministic",
      })).state;
    }
  }
  assert.deepEqual(layers, [deepWidth, 1],
    `The count did not run to a fixpoint over its own parents: ${JSON.stringify(layers)}`);
  const deepRoots = deepState.folds.filter((fold) => fold.parentId === null);
  assert.equal(deepRoots.length, 1, "The fixpoint left more than one root standing");
  const depthOf = (fold) => 1 + Math.max(0, ...fold.parts
    .flatMap((part) => part.kind === "fold"
      ? [depthOf(deepState.folds.find((item) => item.id === part.foldId))]
      : []));
  assert.equal(depthOf(deepRoots[0]), 3, "The oldest context did not end up three layers down");

  // A PINNED ROOT IS A HOLD TOO, and the roots either side of it count separately.
  const pinnedForest = await chapterForest(width + 1);
  const pinnedRoots = pinnedForest.state.folds
    .filter((fold) => fold.parentId === null).map((fold) => fold.id);
  const pinnedFold = pinnedForest.state.folds.find((fold) => fold.id === pinnedRoots[0]);
  const pinnedState = {
    ...pinnedForest.state,
    protected: context.flattenFoldRefs(pinnedFold, pinnedForest.state).map((ref) => structuredClone(ref)),
  };
  const pinnedSnapshot = snapshotOf(pinnedForest);
  assert.equal(context.unpinnedStaleFolds(pinnedSnapshot, pinnedState).length, width,
    "The pinned fold is still counted by the law");
  const pinnedGroups = context.selectAutomaticConsolidations(pinnedSnapshot, pinnedState);
  assert.equal(pinnedGroups.length, 1);
  assert(pinnedGroups[0].parts.every((part) => part.foldId !== pinnedRoots[0]),
    "The parent swallowed a pinned fold");

  // LOSSLESS THROUGH THE PARENT. A nested child is still peekable by its own id and the
  // rescue read still resolves the parent to the original bytes.
  const nestedChild = parents[0].parts.find((part) => part.kind === "fold").foldId;
  const childSource = context.peekFoldSource({
    foldId: nestedChild,
    state,
    entries: runtime.branch,
    sessionId: wide.sessionId,
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
  }).source;
  const originalText = String(context.contentText(context.exactMapped(
    afterSnapshot, context.flattenFoldRefs(state.folds.find((fold) => fold.id === nestedChild), state)[0],
  ).message)).slice(0, 64);
  assert(childSource.includes(originalText), "A nested child stopped serving its own verbatim source");
  assert(json.stableStringify(context.recoverFoldMessages({
    foldId: parents[0].id,
    state,
    entries: runtime.branch,
    sessionId: wide.sessionId,
  })).includes(originalText), "The rescue read stopped resolving the parent to the original bytes");

  // And a consolidation still has to pay for itself in bytes.
  const children = eligible.slice(0, 2).map((id) => wide.state.folds.find((fold) => fold.id === id));
  const parts = children.map((fold) => ({ kind: "fold", foldId: fold.id }));
  const sourceRefs = children.flatMap((fold) => context.flattenFoldRefs(fold, wide.state));
  await assert.rejects(() => context.prepareFold({
    candidate: { kind: "consolidation", parts, sourceRefs },
    snapshot: wide.snapshot,
    state: wide.state,
    generation: 1,
    brief: `A factual but deliberately non-shrinking consolidation ${"x".repeat(1_900)}`,
    briefProvenance: "deterministic",
  }), /materially reduce/);
  return {
    consolidateAfter: width,
    belowCountRoots: width - 1,
    belowCountParents: 0,
    eligibleRoots: eligible.length,
    parentsOwed: groups.length,
    parentsBuiltInOneEpoch: parents.length,
    remainderLeftAlone: eligible.length % width,
    gapsAbsorbed: true,
    pinnedGapSplitsTheRun: true,
    pinnedRootExcluded: true,
    fixpointLayers: layers,
    oldestDepth: depthOf(deepRoots[0]),
    byteShrinkGate: "enforced",
  };
}

async function gateQuietWarming() {
  // The DEFAULT window, because the prepare band needs to exist: the hard fence is
  // (window - reserve) / window with the reserve capped at 16,384, so at windows of
  // 163,840 and below the fence sits at or under prepareRatio and a boundary commits
  // directly with nothing to warm. That is the accepted small-window behaviour; the
  // warming law is pinned at the geometry that has a band.
  const WINDOW = 272_000;
  const chapterBuilt = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: WINDOW,
    thresholds: context.DEFAULT_THRESHOLDS,
  });
  // Warming is quiet and DETERMINISTIC: below prepareRatio nothing warms, at
  // prepareRatio the chapter is prepared ahead of the boundary, and the boundary
  // commit lands exactly the prepared fold. A preparation is the fold computed
  // early, not a model call bought early; there is no generator to pay.
  const warm = makeRuntime(chapterBuilt, { thresholds: context.DEFAULT_THRESHOLDS });
  await startRuntime(warm);
  await measure(warm, Math.round(0.60 * WINDOW), WINDOW);
  await settle(8);
  assert.equal(materialized(warm).prepared, undefined,
    "A preparation started below prepareRatio");
  await measure(warm, Math.round(0.91 * WINDOW), WINDOW);
  await settle(8);
  const warmedStatus = await toolStatus(warm);
  let warmState = materialized(warm);
  assert(warmState.prepared, JSON.stringify(warmedStatus.details.automatic));
  assert.equal(warmState.folds.length, 0);
  assert.equal(warmedStatus.details.automatic.preparedFoldId, warmState.prepared.id);
  assert.equal(warmedStatus.details.automatic.lastAutomaticAction, null);
  const narrowFenceTokens = Math.round(context.hardFenceRatio({ contextWindow: WINDOW }) * WINDOW);
  const warmedId = warmState.prepared.id;
  await measureAndCommit(warm, narrowFenceTokens, WINDOW, "warm-fence-commit");
  warmState = materialized(warm);
  // The warmed chapter lands through the commit like every other fold. The commit is
  // free to carry more marks than the one that was warmed; what it may not do is leave
  // the warmed one behind.
  const warmChapters = warmState.folds.filter((fold) => fold.kind === "chapter");
  assert(warmChapters.length >= 1, "The fence commit folded no chapter");
  assert(warmChapters.some((fold) => fold.id === warmedId),
    "The warmed preparation never reached the window");
  assert.equal(warmChapters.find((fold) => fold.id === warmedId).provenance.kind, "deterministic");

  const toolRuntime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
  );
  await startRuntime(toolRuntime);
  await measure(toolRuntime, 10_000, 100_000);
  await measure(toolRuntime, 60_000, 100_000);
  assert.equal(materialized(toolRuntime).prepared, undefined);
  // The priority shows in what the COMMIT reaches for first: the deterministic tool
  // batch, never a warm chapter preparation. Reading it off the commit is stricter than
  // reading it off a mark, because a mark could still have been outranked on the way to
  // the fold. The old reading here, that NOTHING is staged below the threshold, is gate
  // 141's inverted law and is deleted rather than restated: the frontier cuts as material
  // arrives, so counting staged marks measures the frontier and not this gate's subject,
  // which is what a WARM PREPARATION may and may not do. `prepared` above is that
  // subject and it is unchanged.
  await measureAndCommit(toolRuntime, 88_000, 100_000, "tool-priority-commit");
  const toolFolds = materialized(toolRuntime).folds;
  assert(toolFolds.length >= 1, "The stale tool batch was never folded");
  assert.equal(toolFolds[0].kind, "tool-result",
    "The deterministic tool batch lost its priority over a warmed chapter");

  // A boundary arriving with NOTHING warmed still commits: the fence never depends on
  // a preparation having run.
  const floor = makeRuntime(chapterBuilt, { thresholds: context.DEFAULT_THRESHOLDS });
  await startRuntime(floor);
  await measure(floor, Math.round(0.60 * WINDOW), WINDOW);
  assert.equal(materialized(floor).prepared, undefined);
  await measureAndCommit(floor, narrowFenceTokens, WINDOW, "floor-fence-commit");
  const floorState = materialized(floor);
  const floorChapters = floorState.folds.filter((fold) => fold.kind === "chapter");
  assert(floorChapters.length >= 1, "The unwarmed fence commit folded no chapter");
  assert(floorChapters.every((fold) => fold.provenance.kind === "deterministic"));
  return {
    quietBelowPrepareRatio: true,
    warmedAtRatio: 0.91,
    committedAtFence: true,
    warmedProvenance: "deterministic",
    unwarmedFenceFloor: "deterministic",
  };
}

async function gateFoldCandidatesDetail() {
  // Wide enough that the commit which spends the measurement still leaves foldable
  // material behind: the property is that ONLY the stale measurement blocks the
  // selection, never a shortage of members.
  const built = makeFixture({ turns: 40, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  // The measurement a commit has already spent is a STALE measurement, which is the
  // precondition this gate reads the selector under. Under the epoch that spending
  // happens on the context pass, so the epoch is driven all the way through it.
  await measureAndCommit(runtime, 80_000, 100_000);
  const state = materialized(runtime);
  // Mapped the way the runtime maps. There is one basis now: foldability is membership,
  // so a snapshot is a function of the branch and the thresholds alone and this gate
  // compares the two selectors rather than two readings of the window.
  const snapshot = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
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
  const status = await toolStatus(runtime, "pi_fold_context", "fold_candidates");
  assert.equal(json.stableStringify(status.details.candidates), json.stableStringify(expected));
  assert.equal(status.details.automatic.measurementFresh, false);
  assert.equal(status.details.candidates.wouldFireNow, null);
  assert.equal(status.details.candidates.blockedBy, "measurement-stale");
  // One law, so the "otherwise eligible" selection is whatever the span law composes:
  // below the counting rule that is a tool batch or a raw chapter, never a consolidation.
  assert(status.details.candidates.tool ?? status.details.candidates.chapter ??
    status.details.candidates.consolidation,
  "Stale-measurement fixture lacked an otherwise eligible selection");
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

async function gateNoToolCallRewrite() {
  // Gate 16 was the blocking-tool free harvest: a `tool_call` listener that folded one
  // batch while the agent blocked on a subagent. It is deleted with `blockingTools`, and
  // this is Sol's replacement: no tool call may cause a projection mutation of its own.
  // The published mechanism is event-driven batching at occupancy, so the commit epoch
  // is the only path that moves a byte.
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 20_000, 100_000);
  await measure(runtime, 25_000, 100_000);
  await measure(runtime, 30_000, 100_000);
  assert.equal(runtime.handlers.get("tool_call"), undefined,
    "A tool_call listener survived the free-harvest deletion");
  const revisionBefore = materialized(runtime).revision;
  const foldsBefore = materialized(runtime).folds.length;
  for (const toolName of ["read", "Agent", "grep"]) {
    await runtime.tools.get("pi_fold_context").execute(
      `tool-${toolName}`, { action: "status" }, new AbortController().signal, undefined, runtime.ctx,
    );
  }
  await settle(8);
  assert.equal(materialized(runtime).revision, revisionBefore,
    "A tool call moved the durable revision without a commit");
  assert.equal(materialized(runtime).folds.length, foldsBefore);

  // The option itself is REFUSED by name, never ignored: a deployment still passing it
  // asked for per-tool-call folding and silence would hand it the opposite.
  assert.throws(
    () => makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      { retiredOptions: { blockingTools: ["Agent"] } }),
    /blockingTools is no longer an option/,
  );

  // THE ACCEPTED CONSEQUENCE, pinned so it stays a decision rather than a surprise.
  //
  // The tool rung has no door of its own, so it wins every automatic selection ahead
  // of chapter preparation: a TOOL-BEARING session never warms a chapter, and its
  // commits brief deterministically like everything else.
  const toolBearing = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
  );
  await startRuntime(toolBearing);
  await measure(toolBearing, 50_000, 100_000);
  await measure(toolBearing, 60_000, 100_000);
  const toolCommitted = await measureAndCommit(toolBearing, 86_000, 100_000, "tool-commit");
  assert.equal(materialized(toolBearing).prepared ?? undefined, undefined,
    "A tool-bearing session started a warm preparation the tool rung outranks");
  assert(toolCommitted.folds.length >= 1, "The tool-bearing commit folded nothing");
  assert(toolCommitted.folds.every((fold) => context.foldProvenance(fold, materialized(toolBearing)).kind === "deterministic"),
    `A tool-bearing commit produced a non-deterministic brief: ${JSON.stringify(
      toolCommitted.folds.map((fold) => fold.provenance.kind))}`);

  // THE WARM PATH STILL RUNS, and here is the fixture that keeps it pinned. With no
  // tool results there is no tool rung to outrank the chapter, so at prepareRatio the
  // chapter is prepared ahead of the boundary and the commit carries exactly it.
  const noTool = makeRuntime(
    makeFixture({
      turns: 8, tools: false, chapterChars: 3_500, contextWindow: 272_000,
      thresholds: context.DEFAULT_THRESHOLDS,
    }),
    { thresholds: context.DEFAULT_THRESHOLDS },
  );
  await startRuntime(noTool);
  await measure(noTool, Math.round(0.91 * 272_000), 272_000);
  await settle(8);
  const noToolPrepared = materialized(noTool).prepared;
  assert(noToolPrepared, "The warm preparation never started in a session with no tool rung");
  const noToolFence = Math.round(context.hardFenceRatio({ contextWindow: 272_000 }) * 272_000);
  const noToolCommitted = await measureAndCommit(noTool, noToolFence, 272_000, "warm-commit");
  assert(noToolCommitted.folds.length >= 1, "The warm commit folded nothing");
  assert(noToolCommitted.folds.some((fold) => fold.id === noToolPrepared.id),
    "The warm commit left the prepared chapter behind");
  return {
    toolCallListener: "absent",
    blockingToolsOption: "refused",
    revisionMovedByToolCall: false,
    toolBearingWarmed: false,
    toolBearingBriefs: "deterministic",
    noToolWarmed: true,
    noToolCommittedPrepared: true,
  };
}

async function gateWireForwardBackwardNote() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 50_000, 100_000);
  await measure(runtime, 80_000, 100_000);
  await measureAndCommit(runtime, 88_000, 100_000);
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

  return {
    tiny,
    fallback: {
      fence: fallbackAutomatic.hardFenceRatio,
      windowSource: fallbackAutomatic.windowSource,
    },
    unboundMeasurement: "stale-no-rebind",
  };
}

async function gateEvidenceIngestionIsUnconditional() {
  const scratch = await mkdtemp(join(tmpdir(), "pi-fold-evidence-always-"));
  try {
    const sessionFile = join(scratch, "session.jsonl");
    // No options at all: the plain package registration a host gets from `registerPiFold`.
    const runtime = makeRuntime(makeFixture({ turns: 4, resultChars: 20_000 }), {
      packageRegistration: true,
      sessionFile,
    });
    assert.equal(runtime.handlers.has("tool_result"), true,
      "The default registration wired no evidence hook");
    await startRuntime(runtime);
    const projection = await runtime.handlers.get("tool_result")({
      toolName: "mcp__docs__fetch",
      toolCallId: "unconditional-evidence-call",
      isError: false,
      content: [{ type: "text", text: "m".repeat(20_000) }],
      details: { structuredContent: { payload: "p".repeat(20_000) } },
    }, runtime.ctx);
    const path = projection.details.evidence.path;
    assert(path.includes("/pi-fold-evidence/"), path);
    assert.equal(existsSync(path), true, "The evidence artifact was never written");
    // Written read-only, as the artifacts must be: the recovery anchor cannot be a file a
    // later pass can edit.
    assert.equal((await stat(path)).mode & 0o777, 0o444);

    // And there is no way back to the old behavior through the door. The name is refused
    // rather than ignored, because a deployment still passing `evidenceIngestion: false`
    // believes it turned the writes off.
    assert.throws(
      () => makeRuntime(makeFixture({ turns: 4 }), {
        packageRegistration: true,
        retiredOptions: { evidenceIngestion: false },
      }).tools,
      /evidenceIngestion is no longer an option: evidence ingestion is always on/,
      "evidenceIngestion survived as a switch",
    );
    assert.throws(
      () => makeRuntime(makeFixture({ turns: 4 }), {
        packageRegistration: true,
        retiredOptions: { evidenceIngestion: true },
      }).tools,
      /evidence ingestion is always on/,
      "Passing the default value silently accepted a name the package no longer sells",
    );
    return {
      toolResultEvidenceHook: "present",
      evidenceArtifactMode: "0444",
      switchRefused: true,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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

  const peek = await runtime.tools.get("pi_fold_context").execute(
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
    thresholds: TINY_FOLD_FLOOR,
    contextWindow: 1_000_000,
  });
  const emptyBig = context.emptyActiveContextState(big.sessionId);
  const [batch] = context.selectAutomaticToolBatch(big.snapshot, emptyBig);
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
    bytes: Math.min(bounded.sourceBytes, context.ACTIVE_CONTEXT_POLICY.maxSourceChars),
  });
  assert(bounded.truncationReminder.startsWith("STOP:"));
  assert(bounded.truncationReminder.includes(String(bounded.omittedBytes)));
  assert(bounded.truncationReminder.includes("the head and tail are both above"));
  assert.equal(Object.keys(bounded).indexOf("truncationReminder"), Object.keys(bounded).length - 1);
  assert(Object.keys(bounded).indexOf("source") === Object.keys(bounded).length - 2);
  assert.equal(peek.details.wider, undefined);
  assert.equal(peek.details.truncationReminder, undefined);

  // AN EXPLICIT WIDENING STILL HAS A CEILING: the policy's own source cap, the same
  // number the `wider` hint has always offered. An unclamped `bytes` was the one door
  // left to a single result larger than any fold the runtime would cut.
  const widened = context.peekFoldSource({ ...peekArguments, maximumBytes: 10_000_000 });
  assert(widened.returnedBytes <= context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
    `an explicit bytes=10M read returned ${widened.returnedBytes} bytes past the source cap`);
  assert.equal(widened.truncated, bounded.sourceBytes > context.ACTIVE_CONTEXT_POLICY.maxSourceChars);

  const tree = (await toolStatus(runtime, "pi_fold_context", "tree")).details.tree;
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
  const plain = await toolStatus(runtime, "pi_fold_context");
  assert.equal(plain.details.tree, undefined);
  assert.equal(plain.details.totalFolds, 3);
  const candidates = await toolStatus(runtime, "pi_fold_context", "fold_candidates");
  assert.equal(candidates.details.tree, undefined);
  assert(candidates.details.candidates);

  await assert.rejects(() => runtime.tools.get("pi_fold_context").execute(
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

/**
 * THE DESCENDANT INDEX COUNTS AGAINST THE PEEK BUDGET (sol-20260826-full2, pifold rep 1).
 *
 * The byte bound used to govern `source` alone while the index rode free, so peeking the
 * root of a depth-18 consolidation tree returned 320 nested briefs, 423KB against a
 * stated 16KB bound, durably into a window already near its serving budget; the
 * projection fence then aborted every request for the rest of the run over that one tool
 * result. The law now: ONE budget governs the whole result. The index seats first, into
 * at most half the budget, shallowest rows first with walk order breaking ties, rows
 * whole, and the omitted counted in `indexOmitted` and stated in the note (gate 136's
 * rule); the source view takes what the seated rows leave. A leaf fold's read is
 * byte-identical to what it always was, which the oversized-fixture claim above pins.
 *
 * ANTI-VACUITY: the raw descendant rows are asserted to exceed the whole budget, so on
 * the pre-fix runtime, where the index is returned in full, the seated-bytes assertion
 * fails rather than passing emptily.
 */
async function gatePeekIndexIsBounded() {
  const built = makeFixture({
    turns: 28,
    tools: false,
    chapterChars: 3_500,
    thresholds: TINY_FOLD_FLOOR,
    contextWindow: 200_000,
  });
  let state = context.emptyActiveContextState(built.sessionId);
  const chapterIds = [];
  for (let turn = 0; turn < 24; turn += 1) {
    const candidate = context.manualFoldCandidate(
      built.snapshot,
      state,
      [built.turnEntries[turn][0], built.turnEntries[turn].at(-1)],
    );
    const landmark = `Chapter ${turn} recorded the full parse trail of file-${turn}.txt: ` +
      Array.from({ length: 24 }, (_, step) => `step-${turn}-${step} held v${turn * 100 + step}`).join("; ");
    const committed = await commitCandidate(state, built.snapshot, candidate, {
      brief: landmark, now: turn + 1,
    });
    state = committed.state;
    chapterIds.push(committed.prepared.id);
  }
  const innerA = await commitCandidate(
    state,
    built.snapshot,
    context.manualFoldCandidate(built.snapshot, state, chapterIds.slice(0, 10)),
    { brief: "Grouped the first ten chapters whose exact parse trails stay recoverable at depth.", now: 30 },
  );
  state = innerA.state;
  const innerB = await commitCandidate(
    state,
    built.snapshot,
    context.manualFoldCandidate(built.snapshot, state, chapterIds.slice(10, 20)),
    { brief: "Grouped the second ten chapters whose exact parse trails stay recoverable at depth.", now: 31 },
  );
  state = innerB.state;
  const root = await commitCandidate(
    state,
    built.snapshot,
    context.manualFoldCandidate(built.snapshot, state,
      [innerA.prepared.id, innerB.prepared.id, ...chapterIds.slice(20)]),
    { brief: "Grouped both chapter archives with the four closing chapters for one collapsed root.", now: 32 },
  );
  state = root.state;
  const rootFold = state.folds.find((fold) => fold.id === root.prepared.id);

  const raw = context.descendantIndexRows(rootFold, state);
  assert.equal(raw.length, 26, `the deep fixture built ${raw.length} descendants, not 26`);
  const rawBytes = Buffer.byteLength(json.stableStringify(raw), "utf8");
  assert(rawBytes > context.PEEK_DEFAULT_MAX_BYTES,
    `the raw index is ${rawBytes} bytes, too small to prove the bound matters`);

  const peek = context.peekFoldSource({
    foldId: rootFold.id,
    state,
    entries: built.entries,
    sessionId: built.sessionId,
  });
  const indexBudget = Math.floor(context.PEEK_DEFAULT_MAX_BYTES / 2);
  const seatedBytes = Buffer.byteLength(json.stableStringify(peek.index), "utf8");
  assert(seatedBytes <= indexBudget,
    `the seated index is ${seatedBytes} bytes against a ${indexBudget}-byte share`);
  assert(peek.indexOmitted > 0, "the over-budget index reported nothing omitted");
  assert.equal(peek.index.length + peek.indexOmitted, raw.length,
    "seated plus omitted does not account for every descendant");
  assert(peek.returnedBytes + seatedBytes <= context.PEEK_DEFAULT_MAX_BYTES,
    `source (${peek.returnedBytes}) plus index (${seatedBytes}) exceeds the one stated budget`);
  // Shallowest first, whole rows: the seated set is exactly the leading prefix of the
  // depth-ascending order (walk order breaking ties), so nothing deeper ever displaces
  // anything shallower and what is omitted is one contiguous deep tail. All-children
  // seating is NOT promised: a wide root whose child briefs run to the policy cap can
  // outgrow the index share, and then the cut lands inside depth 1 itself, stated the
  // same way (gate 115's rule for a group too wide to seat).
  const depthOrder = raw
    .map((row, walk) => ({ row, walk }))
    .sort((left, right) => Number(left.row.depth) - Number(right.row.depth) || left.walk - right.walk)
    .map(({ row }) => row.id);
  assert.deepEqual(
    peek.index.map((row) => row.id),
    depthOrder.slice(0, peek.index.length),
    "the seated index is not the shallowest-first prefix of the descendant order",
  );
  assert(peek.index.length > 0, "the bounded index seated nothing at all");
  assert(peek.note.includes(`seats the shallowest ${peek.index.length} of ${raw.length}`),
    "the note does not state the index cut");
  assert.deepEqual(peek.wider, {
    action: "peek",
    id: rootFold.id,
    bytes: Math.min(peek.sourceBytes, context.ACTIVE_CONTEXT_POLICY.maxSourceChars),
  }, "an index cut did not offer the wider read");
  // Widening buys the index back: at the source cap every descendant seats and the cut
  // vanishes from the note along with the field.
  const widened = context.peekFoldSource({
    foldId: rootFold.id,
    state,
    entries: built.entries,
    sessionId: built.sessionId,
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
  });
  assert.equal(widened.indexOmitted, undefined, "a widened read still cut the index");
  assert.equal(widened.index.length, raw.length);
  return {
    descendants: raw.length,
    rawIndexBytes: rawBytes,
    seatedRows: peek.index.length,
    seatedBytes,
    indexOmitted: peek.indexOmitted,
    widenedSeatsAll: widened.index.length === raw.length,
  };
}

/**
 * SILENCE IS THE DEFAULT, AND THE BUDGET IS PRECISION.
 *
 * One suggestion per delivery point, whatever else diverges, and the line it renders
 * carries its own byte bound so a carrier's total overhead is its bound plus this one.
 * The per-request ephemeral carrier stays dead: it cost 21.9% of every input token in
 * rep 21, and no amount of better ranking changes what a moving tail costs.
 */

/**
 * THE SUPPRESSION LIFECYCLE.
 *
 * Trust is spent, not renewed: a fold offered and not taken is offered once more, and
 * then never again. The cooldown IS the outcome window, so nothing is re-offered before
 * its last offer has an answer, and the answer is graded acted, used or ignored.
 */

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

function epochSnapshot(built) {
  return context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: built.contextWindow,
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  });
}

function toolCall(runtime, params, toolName = "pi_fold_context") {
  return runtime.tools.get(toolName).execute(
    `epoch-${params.action}`, params, new AbortController().signal, undefined, runtime.ctx,
  );
}

/**
 * The pending folds the RUNTIME cut, which is where a fixture gets a fold to work with
 * now that the agent has no create verb (Shane, 2026-08-23).
 *
 * A projection pass is what advances the frontier, so the pass is driven here rather than
 * left to whichever assertion happens to trigger one. Everything it returns is byte-inert:
 * the window still holds every raw byte these cuts cover.
 */
async function frontierCuts(runtime) {
  await project(runtime);
  await settle();
  // Read from STATUS, not from the durable record. A frontier cut is derived from its own
  // span and writes no persistence boundary of its own, so `materialized()` does not see
  // one until a brief or a commit carries it forward, which is the design and not a gap.
  return (await toolStatus(runtime)).details.automatic.pendingFolds ?? [];
}

/** The agent's whole remaining hand on a pending fold: one sentence, written for free. */
async function briefCut(runtime, mark, brief) {
  return toolCall(runtime, { action: "brief", id: mark.id ?? mark, brief });
}

async function epochToolRuntime({ omitSendMessage, ...fixture } = {}) {
  const built = makeFixture({
    turns: 8, resultChars: 10_000, contextWindow: 100_000, ...fixture,
  });
  const runtime = makeRuntime(built, {
    ...(omitSendMessage ? { omitSendMessage } : {}),
    ...(fixture.thresholds ? { thresholds: fixture.thresholds } : {}),
    ...(fixture.postFoldNotice === undefined ? {} : { postFoldNotice: fixture.postFoldNotice }),
  });
  await startRuntime(runtime);
  return runtime;
}

/**
 * The agent marks its stalest completed tool batch. Nothing stages between commits any
 * more (Shane, 2026-08-21), so a gate that needs a mark standing before the boundary
 * has to make one the way the agent does, through the tool.
 */
async function agentMarksBatch(runtime, index = 0, brief) {
  const cuts = await frontierCuts(runtime);
  assert(cuts.length > index, `The frontier cut ${cuts.length} folds, so there is no fold ${index} to brief`);
  const result = await briefCut(runtime, cuts[index],
    brief ?? `Completed inspection ${index + 1} stays exactly recoverable behind this fold.`);
  assert(!result.isError, `The agent's brief on cut ${index} was refused: ${JSON.stringify(result)}`);
  return cuts[index].id;
}

/** The agent briefs the first `count` folds the runtime cut, which is the whole batch shape now. */
async function agentBriefsCuts(runtime, count = 3, atLeast = 1) {
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= atLeast,
    `The frontier cut ${cuts.length} folds, fewer than the ${atLeast} this fixture needs`);
  count = Math.min(count, cuts.length);
  const briefed = [];
  for (let index = 0; index < count; index += 1) {
    const result = await briefCut(runtime, cuts[index],
      `Stale inspection ${index}: the exact output stays recoverable behind this fold.`);
    assert(!result.isError, `Brief ${index} was refused: ${JSON.stringify(result)}`);
    briefed.push(cuts[index].id);
  }
  return briefed;
}

async function gateEpochMarkCommit() {
  const runtime = await epochToolRuntime();
  const rawBytes = bytesOf((await project(runtime)).messages);
  assert.deepEqual([...[...runtime.tools.values()][0].parameters.properties.action.enum],
    [...context.ACTIVE_CONTEXT_TOOL_ACTIONS]);
  // 68,000 against the 90,000-token serving budget is 0.756 occupancy: below the band
  // top at 0.80 (72,000 tokens), so nothing commits. The marks are the RUNTIME's, cut at
  // the frontier, and the agent's contribution is the brief on one of them (gate 141).
  // Mark inertness is only a claim about passes where the runtime was NOT going to
  // rewrite anyway; over the trigger the rewrite belongs to the commit, not to the mark.
  const briefedId = await agentMarksBatch(runtime, 0);
  await measure(runtime, 68_000, 100_000);
  const marked = materialized(runtime);
  assert.equal(marked.folds.length, 0, "A pending mark folded evidence");
  assert(marked.pendingMarks.length >= 1, "The frontier cut nothing");
  assert.equal(marked.pendingMarks[0].mark, "fold");
  assert.equal(marked.pendingMarks[0].kind, "tool-result");
  assert(marked.pendingMarks.every((mark) => mark.origin === "ladder"),
    "A pending mark claimed an origin no verb can produce any more");
  const briefed = marked.pendingMarks.find((mark) => mark.id === briefedId);
  assert(briefed, "The briefed cut left the pending set");
  assert.equal(briefed.briefProvenance.kind, "supplied",
    "The agent's brief did not land on the fold it named");

  // Read the scheduling surface while the mark is still PENDING. A tool call is not a
  // context pass and cannot commit; project() is, and at this occupancy the curation
  // trigger is live, so a projection built first would report the mark already spent.
  const pendingStatus = (await toolStatus(runtime)).details.automatic.scheduling;
  assert.equal(pendingStatus.mode, "epoch");
  assert(pendingStatus.pending >= 1, "The ladder mark was not pending before any context pass");
  assert(pendingStatus.freedBudgetShare > 0);
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
  await agentMarksBatch(blocked, 0);
  await measure(blocked, 68_000, 100_000);
  const pending = materialized(blocked).pendingMarks[0];
  const sourceIds = pending.parts.map((part) => part.ref.entryId);
  await toolCall(blocked, { action: "pin", ids: sourceIds });
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

  // THE APPLY ORDER IS THE DEPENDENCY, NOT THE DIGEST, AND NOT TRANSCRIPT ORDER EITHER.
  //
  // Added 2026-08-10. Every mark one epoch proposes carries the same `ordinal`, so the
  // retired sort, `ordinal` then id, was mark-id order inside an epoch: a content hash
  // decided which span applied first. Its own comment named the invariant that matters,
  // that a span absorbing another mark's fold finds that child already folded, and
  // "oldest material first" is not that invariant: a parent CONTAINS its child, so the
  // earliest window index a parent covers is at or before the child's and transcript
  // order applies the PARENT first in exactly the case the invariant exists for.
  //
  // The cost of getting it wrong is not a reordering. `candidateSourceRefs` cannot
  // resolve a part naming a fold nobody holds, the apply loop catches the throw, and the
  // mark is refused with `retained: false`, so the parent applied one place too early
  // loses the decision outright. That refusal is asserted below as the negative probe.
  //
  // The fixture is one chapter and the tool-result fold it absorbs, placed at the batch
  // position where the digest order genuinely inverts them, and both disagreements are
  // asserted BEFORE the outcome: without them the check would pass under either ordering.
  const orderBuilt = makeFixture({
    sessionId: "apply-order-test", turns: 12, resultChars: 6_000, contextWindow: 100_000,
  });
  const orderSnapshot = epochSnapshot(orderBuilt);
  const orderEmpty = context.emptyActiveContextState(orderBuilt.sessionId);
  const orderIndexOfEntry = (entryId) =>
    orderSnapshot.mapped.findIndex((item) => item.ref?.entryId === entryId);
  // One whole task turn, read as the parent of its own batch: user text, the assistant
  // call, and the tool-result fold. The parent names the child by the id the child's
  // commit will mint, which is the id `foldMarkFor` already gives the mark.
  const orderPairAt = (index) => {
    const childCandidate = context.manualFoldCandidate(
      orderSnapshot, orderEmpty, [orderSnapshot.mapped[index].ref.entryId]);
    const child = context.foldMarkFor({
      candidate: childCandidate,
      brief: context.automaticToolBrief(orderSnapshot, childCandidate),
      briefProvenance: { kind: "deterministic" },
      origin: "ladder",
      ordinal: context.markOrdinal(orderSnapshot),
    });
    const parent = context.foldMarkFor({
      candidate: {
        kind: "chapter",
        parts: [
          { kind: "raw", ref: orderSnapshot.mapped[index - 2].ref },
          { kind: "raw", ref: orderSnapshot.mapped[index - 1].ref },
          { kind: "fold", foldId: child.id },
        ],
        // Empty on purpose: the refs this span covers cannot be resolved while its child
        // is a mark rather than a fold, and `foldMarkFor` reads only the kind and parts.
        sourceRefs: [],
      },
      brief: "One task turn kept whole, with the read it made already behind a placeholder.",
      briefProvenance: { kind: "deterministic" },
      origin: "ladder",
      ordinal: context.markOrdinal(orderSnapshot),
    });
    return { child, parent, index };
  };
  let orderPair = null;
  for (const item of orderSnapshot.mapped) {
    if (item.ref?.role !== "toolResult" || item.index < 2) continue;
    const pair = orderPairAt(item.index);
    // Only a position whose digests invert is worth running, and only a span that is
    // genuinely stale, so the commit refuses nothing for a reason other than order.
    if (pair.parent.id.localeCompare(pair.child.id) < 0 &&
        context.markEligibility(orderSnapshot, orderEmpty, pair.child) === "eligible") {
      orderPair = pair;
      break;
    }
  }
  assert(orderPair, "No stale batch in the fixture puts the parent first by mark id, so the orders cannot be told apart");
  let orderState = context.addPendingMark(orderEmpty, orderPair.child).state;
  orderState = context.addPendingMark(orderState, orderPair.parent).state;
  const orderMarks = context.pendingMarks(orderState);
  assert.equal(orderMarks.length, 2, "The apply-order fixture did not hold both marks");
  assert.equal(new Set(orderMarks.map((mark) => mark.ordinal)).size, 1,
    "The fixture's marks carry more than one ordinal, so the degenerate case is not being measured");
  // Disagreement one: the retired key applies the absorbing span first.
  assert.deepEqual(
    [...orderMarks].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((mark) => mark.id),
    [orderPair.parent.id, orderPair.child.id],
    "Ordinal-then-id no longer applies the parent first, so this fixture cannot tell the orders apart",
  );
  // Disagreement two: the parent's own material starts earlier, so oldest-material-first
  // would invert them too; and while the child is a mark the parent has no readable span
  // at all, which is why the order is read off the naming and not off the geometry.
  assert(orderIndexOfEntry(orderPair.parent.parts[0].ref.entryId) <
    orderIndexOfEntry(orderPair.child.parts[0].ref.entryId),
    "The parent's material does not start before its child's, so oldest-material-first would not invert them");
  // The unreadable start is now an ANSWER rather than a throw, and the answer is the
  // same number the retired local helper produced: past the newest entry. Re-derived
  // here because the readings stopped throwing, not because the claim changed; the
  // claim is still that the parent's start cannot be read while its child is a mark,
  // and `candidateSourceRefs` is asserted below to show the fixture is genuinely
  // dangling rather than quietly resolvable.
  assert.throws(() => context.candidateSourceRefs(orderPair.parent.parts, orderState),
    /Missing candidate child/,
    "The fixture's parent resolves after all, so nothing here is measuring an unminted child");
  assert.equal(context.markSpanStart(orderSnapshot, orderState, orderPair.parent),
    orderSnapshot.mapped.length,
    "A span naming an unminted child does not sort past the newest entry");
  // The negative probe: the same parent with no child to find is refused and DISCARDED,
  // which is exactly what the parent-first order produced.
  const orderAlone = await context.commitPendingMarks({
    snapshot: orderSnapshot,
    state: context.addPendingMark(orderEmpty, orderPair.parent).state,
    generation: 1,
    retainIneligible: true,
  });
  assert.equal(orderAlone.applied.length, 0, "A span whose child does not exist folded anyway");
  // Re-derived reason: the apply loop no longer lets `Missing candidate child` escape as
  // the receipt. Nothing pending names this child, so the mark can never resolve and the
  // drop says so by name. The disposition is unchanged, which is what this probe is for.
  assert.match(orderAlone.refused[0]?.reason ?? "", /no pending mark will mint/,
    "A span naming a fold nobody holds was refused for some other reason");
  assert.equal(orderAlone.refused[0].retained, false,
    "The refusal is retained, so applying the parent early no longer costs the decision");
  const orderCommit = await context.commitPendingMarks({
    snapshot: orderSnapshot,
    state: orderState,
    generation: 1,
    retainIneligible: true,
  });
  assert.deepEqual(orderCommit.applied.map((mark) => mark.id), [orderPair.child.id, orderPair.parent.id],
    "The commit did not apply the child before the span that absorbs it");
  assert.equal(orderCommit.refused.length, 0, "The apply-order commit refused a mark");
  const orderParentFold = orderCommit.state.folds.find((fold) => fold.id === orderPair.parent.id);
  assert(orderParentFold, "The absorbing span never folded");
  assert(context.childFoldIds(orderParentFold).includes(orderPair.child.id),
    "The parent folded without the child it names");
  assert.equal(orderCommit.state.folds.find((fold) => fold.id === orderPair.child.id)?.parentId,
    orderPair.parent.id, "The child did not end up nested under the span that absorbed it");

  return {
    toolActions: context.ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    markedFolds: marked.folds.length,
    pendingAfterMark: marked.pendingMarks.length,
    projectionUnchangedByMark: true,
    committedFolds: after.folds.length,
    pendingAfterCommit: 0,
    protectedHeld: refusal.deferredMarks,
    applyOrderIndex: orderPair.index,
    applyOrderIdOrderInvertsDependency: true,
    applyOrderParentDiscardedAlone: orderAlone.refused.length,
    applyOrderChildFirst: true,
  };
}

/**
 * Which lane asked for a brief. The preparation lanes name a candidate DIGEST; the
 * upgrade lane names the fold that already committed, because the candidate is that
 * fold. Gates that count preparations count them with this, so the upgrade lane adding
 * a caller does not read as a preparation nobody asked for.
 */

function bytesOf(value) {
  return Buffer.byteLength(json.stableStringify(value), "utf8");
}

async function gateEpochQuotaTopUp() {
  const runtime = await epochToolRuntime({ turns: 14 });
  // The frontier cuts and the agent briefs one of them; the commit must apply both that
  // one and the rest of the drop. The old fixture had the agent MARK one batch, which is
  // the verb that no longer exists.
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 2, "The frontier cut too little to measure a top-up around");
  const agentMarkId = cuts[0].id;
  const briefed = await briefCut(runtime, cuts[0],
    "The completed first inspection is stale and its exact output stays recoverable.");
  assert.equal(briefed.details.action, "brief");
  assert.equal(briefed.details.provenance, "agent");
  assert.equal((await frontierCuts(runtime)).filter((fold) => fold.briefed).length, 1);

  await measureAndCommit(runtime, 88_500, 100_000, "quota-round");
  const status = await toolStatus(runtime);
  // Inside the rewrite the commit already paid for, one further rung may follow it, so
  // the ACTION reported last is not always the commit. The epoch record is, and that is
  // what this gate reads: it rides on every action the pass produced.
  const epoch = status.details.automatic.lastAutomaticAction.epoch;
  assert(epoch, JSON.stringify(status.details.automatic.lastAutomaticAction));
  assert(epoch.ladderMarks >= 1, "The quota top-up added nothing");
  assert(epoch.applied.some((item) => item.id === agentMarkId),
    "The fold the agent briefed did not apply");
  assert(epoch.applied.some((item) => item.origin === "ladder"));
  assert.deepEqual(epoch.refused, []);

  // Adjudication visibility: a bound-out top-up or a dropped agent mark must be
  // readable from the epoch record alone, without re-deriving it from applied[].
  for (const key of ["pendingMarks", "agentMarks", "ladderMarks", "peekMarks", "topUpMarks",
    "appliedMarks", "refusedMarks", "freedBudgetShare", "estimatedFreedTokens",
    "actualFreedBudgetShare", "sourceBytesSaved", "targetBudgetShare"]) {
    assert.equal(typeof epoch[key], "number", `epoch accounting is missing ${key}`);
  }
  assert.equal(epoch.appliedMarks, epoch.applied.length);
  assert.equal(epoch.refusedMarks, 0);
  assert.equal(epoch.pendingMarks, epoch.agentMarks + epoch.ladderMarks + (epoch.userMarks ?? 0));
  // The top-up may now legitimately add NOTHING, and that is the frontier working rather
  // than the fill failing: the frontier has already cut everything the fill would have
  // reached for, so the fill finds the target covered and stops. What must still hold is
  // that the commit reaches its target from the pending set however that set was built,
  // and that the mark CAP is never what stopped it.
  assert(epoch.topUpMarks >= 0 && epoch.topUpMarks < context.MAX_PENDING_MARKS);
  assert(epoch.appliedMarks >= 2, "The commit reached its target with fewer marks than a batch");
  // This fixture runs the candidate pool dry before the floor, which is the other
  // legitimate exit; what must never happen silently is the mark CAP binding.
  assert(epoch.freedBudgetShare > 0);
  assert(epoch.sourceBytesSaved > 0);
  // The freeing target IS the hysteresis, on one denominator: what is used, less where
  // the thermostat lands, over the serving budget. The separate window-share floor is
  // gone, so there is one number to assert and this asserts equality rather than a
  // maximum. The gap it bottoms out at moves with the thermostat, 0.60 of budget at the
  // 2026-08-14 setting and 0.40 at the 2026-08-23 one, which is why the bound is
  // derived from the constants below rather than written as a literal here.
  assert.equal(epoch.targetBudgetShare, epoch.hysteresisTargetShare);
  near(epoch.targetBudgetShare,
    Math.max(0, (epoch.occupancyTokensBefore - context.DEFAULT_THRESHOLDS.minTarget * 90_000) / 90_000),
    1e-12, "freeing target");
  const committed = materialized(runtime);
  // What the depth cut retained survives as PENDING, not as a leak: the count in the
  // durable state is exactly what the receipt says was retained (2026-08-23; before the
  // cut existed this asserted the commit consumed every mark).
  assert.equal((committed.pendingMarks ?? []).length, epoch.retainedMarks,
    "The durable pending set disagrees with the receipt's retained count");
  // Every applied mark became a fold. The count is a floor rather than an equality: a
  // rung riding the same paid rewrite may add one more, which costs no extra
  // invalidation and is the reason inline rungs are allowed there at all.
  assert(committed.folds.length >= epoch.applied.length);
  for (const item of epoch.applied) {
    assert(committed.folds.some((fold) => fold.id === item.foldId),
      `An applied mark left no fold: ${item.foldId}`);
  }

  // Precedence: a quota that is already met adds nothing at all.
  const snapshot = epochSnapshot(runtime.built);
  const empty = context.emptyActiveContextState(runtime.built.sessionId);
  assert.deepEqual(
    context.topUpMarks({ snapshot, state: empty, ordinal: 1, targetShare: 0 }),
    [],
  );
  const hungry = context.topUpMarks({ snapshot, state: empty, ordinal: 1, targetShare: 1 });
  assert(hungry.length >= 2 && hungry.length <= context.MAX_PENDING_MARKS);
  assert(hungry.every((mark) => mark.origin === "ladder"));
  assert.equal(new Set(hungry.map((mark) => mark.id)).size, hungry.length);
  return {
    agentMarks: epoch.agentMarks,
    topUpMarks: epoch.topUpMarks,
    freedBudgetShare: epoch.freedBudgetShare,
    ladderTopUps: epoch.ladderMarks,
    appliedInOneEpoch: epoch.applied.length,
    metQuotaAddsNothing: true,
    hungryTopUps: hungry.length,
    targetBudgetShare: epoch.targetBudgetShare,
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

  // The "immediate mode marks no peek" case is gone with the immediate scheduler: there
  // is one scheduler now, so a snapshot built without the peek read-only actions is not
  // a second mode, and asserting a difference between them asserts nothing.
  // With one scheduler a bare peek is read-only on the default surface too, so the
  // classification no longer forks on which scheduler asked.
  assert.equal(
    context.isAutoFoldableToolCall("pi_fold_context", { action: "peek", id: "fold_probe" }),
    true,
  );
  assert.equal(
    context.isAutoFoldableToolCall(
      "pi_fold_context", { action: "peek", id: "fold_probe" }, "pi_fold_context",
      context.AUTO_FOLD_BLACKLIST_DEFAULT, context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
    ),
    true,
  );
  assert.equal(
    context.isAutoFoldableToolCall(
      "pi_fold_context", { action: "peek", id: "x", brief: "no" }, "pi_fold_context",
      context.AUTO_FOLD_BLACKLIST_DEFAULT, context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
    ),
    false,
  );

  // End to end: the commit epoch folds the peek read without being asked. RULING
  // (2026-08-10): the doorless ladder may legitimately claim a completed peek read
  // during the gated last-call round, so the property is not WHICH mechanism claimed
  // it. It is that the claim is single, the duplicate bytes fold at the commit, and
  // the recorded origin is truthful for whichever mechanism made the claim: agent when
  // a reclaim marking did, counted at exactly one of its two moments (the last-call
  // exposure or the commit itself), ladder when the doorless round got there first
  // (and then neither moment counts a peek mark).
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const peekReadId = built.turnEntries[0][2];
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  const folded = materialized(runtime);
  const owners = folded.folds.filter((fold) =>
    context.flattenFoldRefs(fold, folded).some((ref) => ref.entryId === peekReadId));
  assert.equal(owners.length, 1, "The peek read must be claimed by exactly one fold");
  assert.equal(owners[0].kind, "tool-result", "The peek read did not become a tool-result fold");
  const appliedRecord = committed.applied.find((mark) => mark.foldId === owners[0].id);
  assert(appliedRecord, "The peek fold did not land through the commit's applied marks");
  const exposureMarks = committed.records
    .filter((record) => record.kind === "context.lastcall")
    .reduce((sum, record) => sum + (record.peek_marks ?? 0), 0);
  const claimCount = exposureMarks + (committed.commit.peek_marks ?? 0);
  const originTruthful = appliedRecord.origin === "agent"
    ? claimCount === 1
    : appliedRecord.origin === "ladder" && claimCount === 0;
  assert(originTruthful,
    `The recorded origin '${appliedRecord.origin}' does not match the claiming mechanism ` +
    `(exposure peek marks ${exposureMarks}, commit peek marks ${committed.commit.peek_marks})`);
  // Whichever mechanism claimed it, the fold it left behind points back at what the
  // copy duplicated: the brief names the source fold, so the placeholder does too.
  assert(owners[0].brief.includes("fold_probe"),
    `The reclaimed peek copy's brief does not name its source fold: ${owners[0].brief}`);
  const foldRecord = committed.records.find((record) =>
    record.kind === "context.fold" && record.fold_id === owners[0].id);
  assert.equal(foldRecord.peek_of, "fold_probe", "The stream record does not name the peeked fold");
  return {
    peekMarks: marks.length,
    peekMarkOrigin: marks[0].origin,
    expandedPeekExempt: true,
    autoFoldedOnCommit: committed.applied.length,
    claimedBy: appliedRecord.origin,
    claimedAt: exposureMarks ? "exposure" : (committed.commit.peek_marks ? "commit" : "ladder"),
    pointsAt: foldRecord.peek_of,
  };
}

/**
 * PEEK COPIES ARE EPHEMERAL BY CONTRACT, AND THE RECLAIM CARRIES IDENTITY.
 *
 * A peek returns a fold's exact stored source, so the copy sits in the window as raw
 * mass beside that fold's own placeholder: the same bytes held twice. The window is
 * append-only, so the reclaim can only land at a commit boundary, and four properties
 * make the contract governable rather than merely economical.
 *
 * 1. The reclaim is MARKED AT THE EXPOSURE, not silently at the commit, so the pending
 *    disposal is visible during the one gated round.
 * 2. A pin is the veto, and it holds across the commit like any other pin. Lifting it
 *    hands the copy back to the next commit rather than dropping the decision.
 * 3. The record points back: the reclaim's brief and therefore its placeholder name the
 *    source fold, and the stream record names it as a field.
 * 4. The verbatim floor is untouched: peeking the source fold after the reclaim returns
 *    bytes identical to the peek that produced the copy.
 *
 * And the fresh tail is exempt with no exceptions: a copy inside it is not marked at
 * all, and simply waits for a commit after it ages out.
 */
async function gatePeekReclaimWithIdentity() {
  // BYTE IDENTITY, bracketing the exact commit that reclaims the copy. Two-phase,
  // because the fold id the peek names must be the id the commit produces.
  const probe = makeFixture({
    turns: 12, resultChars: 12_000, contextWindow: 100_000, peekTurns: [3], peekTargetId: "placeholder",
  });
  const probeSeed = context.emptyActiveContextState(probe.sessionId);
  const brief = "The exact stale inspection result stays recoverable behind this fold.";
  const foldId = (await commitCandidate(
    probeSeed, epochSnapshot(probe), context.selectAutomaticToolBatch(epochSnapshot(probe), probeSeed)[0],
    { brief },
  )).prepared.id;
  const built = makeFixture({
    turns: 12, resultChars: 12_000, contextWindow: 100_000, peekTurns: [3], peekTargetId: foldId,
  });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  const seeded = (await commitCandidate(
    empty, snapshot, context.selectAutomaticToolBatch(snapshot, empty)[0], { brief },
  )).state;
  const peekArguments = { state: seeded, entries: built.entries, sessionId: built.sessionId };
  const before = context.peekFoldSource({ ...peekArguments, foldId });

  const marks = context.ephemeralPeekMarks({ snapshot, state: seeded, ordinal: 1 });
  assert.equal(marks.length, 1, "The completed peek read was not queued for reclaim");
  assert(marks[0].brief.includes(foldId), `The reclaim mark does not name its source fold: ${marks[0].brief}`);
  const reclaimed = await context.commitPendingMarks({
    snapshot, state: context.withPendingMarks(seeded, marks), generation: 1,
  });
  assert.equal(reclaimed.applied.length, 1, "The reclaim mark did not apply");
  const copyFold = reclaimed.state.folds.find((fold) => fold.id === reclaimed.applied[0].foldId);
  assert.notEqual(copyFold.id, foldId, "The reclaim overwrote the source fold instead of pointing at it");
  assert(copyFold.brief.includes(foldId), "The reclaim minted an unrelated fold: its brief names no source");
  assert(context.foldPlaceholder(copyFold, reclaimed.state, snapshot).includes(foldId),
    "The placeholder the reclaim leaves behind does not name the source fold");
  // The source fold is untouched by the reclaim of its own copy, so the verbatim floor
  // is exactly where it was: the same id, the same bytes, the same one hop.
  const after = context.peekFoldSource({ ...peekArguments, state: reclaimed.state, foldId });
  assert.equal(json.stableStringify(after), json.stableStringify(before),
    "A re-peek after the reclaim did not return the original bytes");
  assert.equal(after.sourceSha256, before.sourceSha256);

  // THE RECLAIM RIDES THE COMMIT. Measuring proposes marks and moves no bytes, and the
  // peek copy that is about to be reclaimed is still verbatim in the projection, which
  // is what leaves room for a pin to veto it.
  const runtime = await epochToolRuntime({
    turns: 12, resultChars: 16_000, peekTurns: [1], peekTargetId: "fold_probe",
  });
  const peekEntryId = runtime.built.turnEntries[1][2];
  const rawCopy = runtime.built.messages.find((message) => message?.toolCallId === "call-1");
  // BELOW THE COMMIT TRIGGER, because since 2026-08-22 crossing it commits on the spot.
  // The pin has to be made while the copy is still raw, so the fixture has to give it a
  // pass where nothing has fired yet; that is the state this half of the gate is about.
  await measure(runtime, 60_000, 100_000);
  assert.equal(materialized(runtime).folds.length, 0, "The marking pass moved bytes");
  assert.deepEqual((await project(runtime)).messages.find((message) => message?.toolCallId === "call-1")?.content,
    rawCopy.content, "The peek copy moved before any commit");

  // THE PIN IS THE VETO. It is made before the commit, and the commit reclaims
  // everything else while the pinned copy stays raw.
  await toolCall(runtime, { action: "pin", ids: [peekEntryId] });
  const vetoed = await runtimeCommit(runtime, { tokens: 80_500, contextWindow: 100_000 });
  assert.equal(vetoed.fired, true, "The commit must still fire; a pin vetoes a fold, not the epoch");
  const pinnedState = materialized(runtime);
  assert.equal(
    pinnedState.folds.filter((fold) =>
      context.flattenFoldRefs(fold, pinnedState).some((ref) => ref.entryId === peekEntryId)).length,
    0,
    "A pinned peek copy was reclaimed anyway",
  );
  assert.deepEqual((await project(runtime)).messages.find((message) => message?.toolCallId === "call-1")?.content,
    rawCopy.content, "The pinned peek copy did not survive the commit verbatim");
  // The decision waits rather than being dropped. A pinned copy is not proposed at all
  // while the pin stands, so there is no mark to lose and nothing to clean up; what the
  // agent has to be able to rely on is that releasing the pin is ENOUGH, without asking
  // for the reclaim again. The commit below is the proof, and the assertion that used to
  // sit here read a pending mark that only existed because the ladder staged eagerly.
  // The claim is asserted on REFS above ("A pinned peek copy was reclaimed anyway") and
  // that is where it belongs. The brief-text probe that used to sit here matched any mark
  // whose deterministic brief happened to mention the probe fold, which under the frontier
  // is any chapter cut NEAR the pinned copy rather than one covering it. Matching prose to
  // decide what a mark covers was always the weaker reading; the ref walk is exact.
  await toolCall(runtime, { action: "unpin", ids: [peekEntryId] });
  await runtimeCommit(runtime, { tokens: 84_000, contextWindow: 100_000 });
  const releasedState = materialized(runtime);
  const owner = releasedState.folds.find((fold) =>
    context.flattenFoldRefs(fold, releasedState).some((ref) => ref.entryId === peekEntryId));
  assert(owner, "The released peek copy was never reclaimed");
  assert(owner.brief.includes("fold_probe"), "The released reclaim lost its pointer");

  // THE FRESH TAIL IS EXEMPT, NO EXCEPTIONS. A copy inside it is not marked at all; the
  // same copy, with later turns behind it, is.
  // THE RECENCY EXEMPTION IS GONE (Shane 2026-08-23). This used to prove a peek copy inside
  // the fresh tail was left alone and the same copy, aged out, reclaimed. Fresh-tail is
  // deleted, so a released peek copy is reclaimable wherever it sits, and how long the bytes
  // ride is the ephemeral lease's job rather than a recency share's. Gate 139 owns that.
  const aged = makeFixture({
    turns: 20, resultChars: 4_000, contextWindow: 100_000, peekTurns: [5], peekTargetId: "fold_probe",
  });
  const agedMarks = context.ephemeralPeekMarks({
    snapshot: epochSnapshot(aged), state: context.emptyActiveContextState(aged.sessionId), ordinal: 1,
  });
  assert.equal(agedMarks.length, 1, "A released peek copy was not reclaimed");
  return {
    reclaimPointsAt: foldId,
    bytesIdenticalAfterReclaim: true,
    pinnedCopySurvived: true,
    releasedCopyReclaimed: owner.id,
    recencyExemptionDeleted: true,
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
    {
      ordinal: 4,
      change: "append",
      inputTokens: 200_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      providerSideMiss: true,
    },
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
  const writeLedger = context.emptyLedger();
  const cacheWrite = context.observeCacheUsage(writeLedger, {
    usage: { input: 1_000, cacheRead: 0, cacheWrite: 4_096 }, change: "append",
  });
  assert.equal(cacheWrite.cacheWriteTokens, 4_096,
    "A provider cache write vanished from the runtime observation");
  assert.equal(cacheWrite.providerSideMiss, false,
    "A reported cache write was mislabeled as unexplained provider weather");

  // The record ring itself: every record keys on a prefix digest, and the ledger KEEPS
  // every one of them. It used to drop its oldest at a constant of 64, which was a second
  // bound on material that is already bounded where it is read: `boundStatusPayload` trims
  // exactly this listing to fit the page, newest kept, naming what it dropped. Trimming
  // here as well meant the page could never reach past the constant however it paged, and
  // the same pattern on `ledger.events` silently shortened the last-call attribution.
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
  assert.equal(recordLedger.records.length, 72,
    "The projection ledger dropped records that nothing asked it to drop");
  assert.equal(recordLedger.records[0].previousCount, 0,
    "The oldest projection record was evicted, so the page can never reach it");

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
    await measureAndCommit(runtime, tokens, 100_000);
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
  // What bounds these listings now, and the only thing that ever should have: the page
  // that serves them. The ledger keeps everything; `boundStatusPayload` trims whole
  // records off the newest-kept tail until the page fits, and says what it dropped. Driven
  // here against a ledger deliberately far longer than a page can carry, so the trim is
  // exercised rather than assumed.
  // ON ITS OWN RUNTIME, AND A SMALL ONE. The trim is a property of the RECORD COUNT
  // against the page, so the only thing this section needs from a fixture is that it
  // projects. Ninety passes over the 14-turn fixture above cost 34 seconds, 11 percent of
  // the whole suite, to prove one page trims; the same ninety passes here cost a fraction
  // of that and prove exactly the same thing, because a projection record is the same
  // size whatever it summarizes.
  const paged = makeRuntime(
    makeFixture({ turns: 2, resultChars: 400, contextWindow: 100_000 }), {},
  );
  await startRuntime(paged);
  for (let index = 0; index < 90; index += 1) await project(paged);
  const grown = (await toolStatus(paged)).details.automatic.instrumentation;
  assert(grown.projections > 64,
    `The runtime recorded ${grown.projections} projections, too few to outgrow the deleted bound`);
  // The page really trims rather than merely fitting: it holds fewer records than the
  // ledger recorded. Without this the assertion below would pass on a ledger that never
  // grew past a page and would say nothing about what replaced the constant.
  assert(grown.projectionRecords.length < grown.projections,
    `The page delivered all ${grown.projections} records, so its own trim never ran`);
  const pageResult = await toolStatus(paged);
  const pageBytes = Buffer.byteLength(pageResult.content[0].text, "utf8");
  assert(pageBytes <= context.CONTEXT_STATUS_RESPONSE_BYTES,
    `The status page served ${pageBytes} bytes against a ${context.CONTEXT_STATUS_RESPONSE_BYTES}-byte cap`);
  assert(usageEvents.every((event) =>
    typeof event.input_tokens === "number" && typeof event.cache_read_tokens === "number"));

  // It reaches the envelope the harness reads alongside the existing accounting.
  const epoch = makeRuntime(
    makeFixture({ turns: 14, resultChars: 9_000, contextWindow: 100_000 }),
    {},
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
  const fat = makeRuntime(built);
  await startRuntime(fat);
  const lean = makeRuntime(makeFixture({ turns: 16, resultChars: 9_000, contextWindow: 100_000 }));
  await startRuntime(lean);
  for (const tokens of [78_000, 84_000, 88_000]) {
    await measureAndCommit(fat, tokens, 100_000);
    await measureAndCommit(lean, tokens, 100_000);
  }
  const leanResult = await toolStatus(lean);
  const pagedFoldsResult = await toolStatus(lean, "pi_fold_context", "folds");
  const leanStatus = leanResult.details;
  const pagedFolds = pagedFoldsResult.details;
  const pagedObjects = (await toolStatus(lean, "pi_fold_context", "objects")).details;
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
  assert(Array.isArray((await toolStatus(lean, "pi_fold_context", "tree")).details.tree));

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
  // Turn 8, not the closing turn: the last turn of this fixture has no terminal assistant
  // message, so it is unfoldable for VALIDITY, and a span held for that reason would still
  // be held after the pin came off. The subject here is the pin.
  // EVERY entry of turn 8, not its endpoints. The frontier cuts tool batches, so a mark
  // over this turn covers its RESULT; pinning only the first and last entries leaves that
  // result free and holds nothing the commit was going to take.
  const heldSpan = [...built.turnEntries[7]];

  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const tool = [...runtime.tools.values()][0];
  assert.deepEqual([...tool.parameters.properties.action.enum], [
    ...context.ACTIVE_CONTEXT_TOOL_ACTIONS,
  ]);

  // A HELD SPAN IS A PINNED ONE NOW (Shane 2026-08-23). This used to hold the newest turn
  // because the fresh tail covered it; fresh-tail is deleted, so the remaining reason a
  // mark cannot commit yet is that its evidence is pinned. The subject is unchanged: a
  // mark the commit cannot take is ACCEPTED and kept, never refused, and can be withdrawn.
  //
  // THE ORDER IS NOW LOAD-BEARING and was not before. The agent used to mark a pinned span
  // and get an accepted-but-deferred answer. It cannot name a span at all now, and the
  // frontier never proposes protected evidence, so a pinned span is never cut in the first
  // place. The held state is reached the way a real session reaches it: the frontier cuts
  // while the span is free, and the pin lands afterwards on evidence a standing mark
  // already covers. That is the same state and a more honest route to it.
  const before = bytesOf((await project(runtime)).messages);
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 3, "The frontier cut too little to sort eligible from held");
  assert.equal(bytesOf((await project(runtime)).messages), before, "A frontier cut moved projection bytes");

  // The pin lands on the evidence one standing cut covers, which holds that cut and only
  // it. `heldSpan` is the turn the fixture picked out above.
  await toolCall(runtime, { action: "pin", ids: heldSpan });
  const heldMark = (await frontierCuts(runtime)).find((fold) => fold.id);
  assert(heldMark, "The pin left no standing mark to hold");

  const scheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert(scheduling.pending >= 3);
  assert.equal(scheduling.eligibleMarks + scheduling.retainedMarks, scheduling.pending);
  assert(scheduling.eligibleMarks >= 1, "The stale mark was not counted as eligible");
  assert(scheduling.retainedMarks >= 1, "The held mark was not counted as retained");
  assert(scheduling.marks.every((mark) => ["eligible", "protected"].includes(mark.eligibility)));

  // The commit applies what it can and KEEPS the rest, with the reason stated.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.deferredMarks >= 1, "An ineligible mark was dropped by the commit");
  assert(committed.applied.length >= 1, "The eligible mark was not applied");
  assert.equal(committed.applied.length + committed.deferredMarks, committed.pending);
  assert.equal(committed.refusedMarks, 0, "A held mark was counted as a terminal refusal");
  // IDENTIFIED BY WHAT IT IS, not by the id it started with. A mark's id derives from its
  // span, and a commit may absorb a short adjacent entry into that span, which legitimately
  // re-cuts it and mints a new id. Asserting on the original id measures whether absorption
  // happened rather than whether the held mark survived.
  const survivors = await frontierCuts(runtime);
  assert(survivors.length >= 1, "The retained mark did not survive the commit");
  const heldScheduling = (await toolStatus(runtime)).details.automatic.scheduling;
  assert(heldScheduling.marks.every((mark) => mark.eligibility === "protected"),
    "Something other than the held mark survived the commit");
  const heldId = survivors[0].id;

  // Retention is not a leak: the agent can withdraw a standing decision. Done while the mark
  // still stands, because the release below folds it and a folded span cannot be re-marked.
  const withdrawn = await toolCall(runtime, { action: "unmark", ids: [heldId] });
  assert.equal(withdrawn.details.unmarked.length, 1);
  assert.equal(withdrawn.details.unmarked[0].id, heldId);

  // A HELD MARK FOLDS ONCE THE HOLD IS RELEASED. This half came from gate 72, where the
  // release was a span aging out of the fresh tail; the tail is gone and the release is an
  // unpin, but the law is the same one: a mark the commit could not take is not lost, it is
  // waiting, and it lands under its own origin rather than being re-derived by the ladder.
  // Withdrawn AND still pinned, the span is proposable by nothing: the frontier will not
  // cut protected evidence, which is the class law, so the window stays quiet.
  assert.deepEqual(await frontierCuts(runtime), [],
    "The frontier re-cut evidence that is still pinned");
  // Release the pin and it is ordinary material again: the frontier cuts it and the next
  // commit takes it. A mark the commit could not take was never lost, only waiting.
  await toolCall(runtime, { action: "unpin", ids: heldSpan });
  const recut = await frontierCuts(runtime);
  assert(recut.length >= 1, "The frontier did not re-cut the span once its pin was released");
  const afterRelease = await runtimeCommit(runtime, { tokens: 92_000, contextWindow: 100_000 });
  assert.equal(afterRelease.refusedMarks, 0, "The released mark was refused rather than folded");
  assert.deepEqual(await frontierCuts(runtime), [],
    "The held mark never folded after its pin was released");

  return {
    heldSpanRefusedBefore: true,
    heldSpanMarkedNow: true,
    inlineShortcutDissolved: true,
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
  // Truthful means the DEPLOYMENT stated its serving budget, already net, so it passes
  // through untouched. The descriptor path is the only one that still estimates.
  const truthful = context.capacityAccounting({
    window: 383_616, truthful: true, descriptorWindow: 272_000, usedTokens: 297_000,
  });
  assert.equal(descriptor.budgetTokens, 255_616);
  assert.equal(truthful.budgetTokens, 383_616);
  assert.equal(descriptor.headroomTokens, 255_616 - 297_000);
  assert.equal(truthful.headroomTokens, 383_616 - 297_000);
  assert(descriptor.headroomTokens < 0 && truthful.headroomTokens > 0);
  assert.equal(truthful.descriptorWindow, 272_000);
  assert.equal(context.capacityAccounting({
    window: 383_616, truthful: true, descriptorWindow: null, usedTokens: null,
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

  const truthfulRuntime = makeRuntime(fixture(), { providerInputBudget: 383_616 });
  await startRuntime(truthfulRuntime);
  await measure(truthfulRuntime, 297_000, 272_000);
  await project(truthfulRuntime);
  assert.equal(truthfulRuntime.aborts, 0, "The truthful budget aborted inside real headroom");
  const capacity = (await toolStatus(truthfulRuntime)).details.automatic.capacity;
  assert.equal(capacity.mode, "truthful");
  // Window and budget are ONE number once the deployment declares its serving budget:
  // it stated what it may fill, so there is nothing left for this runtime to withhold.
  assert.equal(capacity.window, 383_616);
  assert.equal(capacity.outputReservation, 0);
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
  const runtime = makeRuntime(built, { providerInputBudget: 383_616 });
  await startRuntime(runtime);
  // Above the backstop, so the epoch commits and there is a stored fold to read: the
  // admission control under test is about reading a COMMITTED fold back.
  // Above the backstop, so the epoch commits and there is a stored fold to read: the
  // admission control under test is about reading a COMMITTED fold back.
  await measure(runtime, 320_000, 400_000);
  await measureAndCommit(runtime, 340_000, 400_000, "admission-commit");
  const status = (await toolStatus(runtime)).details.automatic.capacity;
  assert.equal(status.mode, "truthful");
  assert(status.headroomTokens > 0);

  // Squeeze the headroom below a fold's stored size, then read it. The fold is chosen
  // AFTER the squeeze: the squeeze itself is above the backstop, so it runs an epoch,
  // and a fold id read before it is an id that epoch may already have re-collapsed.
  await measure(runtime, 383_000, 400_000);
  const headroom = (await toolStatus(runtime)).details.automatic.capacity.headroomTokens;
  assert.equal(headroom, 616);
  const bytesPerToken = (await toolStatus(runtime)).details.automatic.capacity.bytesPerToken;
  const folds = materialized(runtime).folds;
  assert(folds.length >= 1, "The admission fixture produced no fold to read");
  const big = folds.find((fold) => fold.sourceChars / bytesPerToken > headroom);
  assert(big, "The fixture holds no fold larger than the squeezed headroom");
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
  // Sized against the estimator the ADMISSION VERDICT used, which is the conservative
  // fixed constant rather than the session's measured calibration: the verdict runs
  // before the read, where the only honest number is the bound. The session's own
  // chars-per-token is reported separately and is what the projection estimate uses.
  assert(slice.bytes <= headroom * context.ESTIMATED_BYTES_PER_TOKEN,
    `The offered slice of ${slice.bytes} bytes exceeds ${headroom} tokens of headroom`);
  assert(bytesPerToken > 0);
  const narrowed = await toolCall(runtime, slice);
  assert.equal(narrowed.details.returnedBytes, slice.bytes);
  assert.equal(narrowed.details.truncated, true);

  // Room restored, the identical read executes: admission governs, it does not deny.
  // Driven through the identical epochs, so it holds the identical forest: a fold id is
  // derived from its span, so the same drive over the same fixture reproduces it.
  const open = makeRuntime(built, { providerInputBudget: 383_616 });
  await startRuntime(open);
  await measure(open, 320_000, 400_000);
  await measureAndCommit(open, 340_000, 400_000, "admission-commit");
  await measure(open, 383_000, 400_000);
  assert(materialized(open).folds.some((fold) => fold.id === big.id),
    "The mirrored drive did not reproduce the fold under test");
  await measure(open, 100_000, 400_000);
  await project(open);
  const whole = await toolCall(open, {
    action: "peek", id: big.id, bytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
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
  // A delta carries the change: the marks that are new or rewritten, and the key order
  // that places them and states the removals. Gate 127 owns that rule; this is the wire
  // shape it produces for a state whose marks are all new.
  assert.equal(delta.pendingMarks, undefined, "The delta stated the whole mark array");
  assert.deepEqual(delta.addPendingMarks, state.pendingMarks);
  assert.deepEqual(delta.pendingMarkOrder, state.pendingMarks.map(context.pendingMarkKey));
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
  // Every rung reaches its effect through a MARK now, which is why this gate is about
  // reachability rather than about a rung firing inline. Restricting the inline
  // selection to prepared chapters used to strand the refold rung outright: a session
  // whose reducible bytes sat in expanded folds re-committed forever without ever
  // re-collapsing one. The route changed and the property did not.
  const runtime = await epochToolRuntime({ turns: 12 });
  await measureAndCommit(runtime, 86_100, 100_000);
  // A ROOT. Under the counting rule a commit may nest what it folds, and a child is
  // not expandable while its parent is still a placeholder.
  const target = materialized(runtime).folds.find((fold) => fold.parentId === null).id;
  await toolCall(runtime, { action: "expand", id: target });
  assert(materialized(runtime).expanded.includes(target));
  let kinds = [];
  for (let step = 0; step < 12; step += 1) {
    // Full request cycles: the refold decision lands as a mark on any pass, and the
    // commit that applies it runs at the boundary.
    await measureAndCommit(runtime, 86_200 + step * 100, 100_000);
    const action = (await toolStatus(runtime)).details.automatic.lastAutomaticAction;
    kinds.push(action.kind);
    if (!materialized(runtime).expanded.includes(target)) break;
  }
  assert.equal(materialized(runtime).expanded.includes(target), false,
    `The refold rung never fired in epoch mode: ${kinds.join(",")}`);
  assert(["refold", "epoch-commit"].includes(kinds.at(-1)),
    `The fold re-collapsed outside the refold rung: ${kinds.join(",")}`);
  // The decision itself is read off the canonical stream: the refold lands as a MARK
  // on a measured pass and the boundary applies it. What proves the decision was taken
  // is the applying commit plus the placeholder flip above.
  assert(contextEvents(runtime).some((record) =>
    record.kind === "context.commit" && record.deferred === false && record.applied_marks >= 1),
  `The refold decision was never applied by a commit: ${kinds.join(",")}`);

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
    stepsToRefold: kinds.length,
    refoldRungReached: true,
    refoldMarkMapped: true,
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
  // One structural mutation per handoff, so two folds need two epochs: the climb below
  // crosses the commit trigger more than once instead of projecting twice in a row.
  for (const tokens of [80_000, 88_000, 60_000, 84_000, 88_000]) {
    await measureAndCommit(identifiedRuntime, tokens, 100_000);
  }
  // A brief is fixed at the DECISION, so the decisions are what this gate reads: the
  // tool results this session committed plus the ones it has marked and not yet
  // committed. Both carry the brief and the span, and the claim is about the brief.
  // A decision is identified by its BRIEF, not by the kind the commit ended up giving
  // it. A tool batch marked in the quiet band can be grown into a chapter by wedge
  // absorption before it commits, and the brief it was decided with rides along; the
  // claim under test is that the brief still names its stage.
  const toolDecisions = (runtime) => {
    const state = materialized(runtime);
    return [...state.folds, ...(state.pendingMarks ?? [])]
      .filter((decision) => typeof decision.brief === "string" && /^Read read\(/.test(decision.brief));
  };
  const identified = toolDecisions(identifiedRuntime);
  assert(identified.length >= 2, "The identified fixture decided fewer than two tool results");

  const generic = makeRuntime(makeFixture(fixture));
  await startRuntime(generic);
  for (const tokens of [80_000, 88_000, 60_000, 84_000, 88_000]) {
    await measureAndCommit(generic, tokens, 100_000);
  }
  const identifiedBriefs = identified.map((fold) => fold.brief);
  assert.equal(new Set(identifiedBriefs).size, identified.length,
    "Two stage-identified briefs are identical");
  for (const brief of identifiedBriefs) {
    assert(brief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
      `A stage-identified brief exceeded the one policy cap: ${brief.length}`);
    assert(context.usefulBrief(brief, context.ACTIVE_CONTEXT_POLICY.maxBriefChars, "pi_fold_context"),
      "A stage-identified brief is not factual");
    assert(/stage=\d+/.test(brief), `A stage-identified brief lost its arguments: ${brief}`);
    assert(/NEXT_KEY=stage-\d+-7f3a/.test(brief), `A stage-identified brief lost its tail anchor: ${brief}`);
  }

  // The goal itself: pick a stage by its distinctive tail token and land on the fold
  // that holds exactly that stage's result, with no peek and no expand.
  // Every anchored decision is checked, not just one: the tail token has to lead to the
  // exact stage result it names, whichever stages this session's epochs happened to
  // decide on.
  const anchored = identified
    .map((decision) => ({ decision, named: /NEXT_KEY=stage-(\d+)-7f3a/.exec(decision.brief) }))
    .filter((item) => item.named);
  assert(anchored.length >= 2, "Fewer than two decisions identified their stage by tail token");
  const stageResultIds = new Map(identifiedRuntime.built.turnEntries
    .map((entries, turn) => [entries[2], turn]));
  for (const { decision, named } of anchored) {
    const stage = Number(named[1]);
    const sourceIds = decision.parts
      .filter((part) => part.kind === "raw")
      .map((part) => part.ref.entryId);
    // The stage the brief names is in there, and no OTHER stage's result is: a
    // decision that grew by absorption swallowed short adjacent entries, never another
    // tool result, so the brief and the bytes still describe the same stage.
    assert(sourceIds.includes(identifiedRuntime.built.turnEntries[stage][2]),
      `The brief that named stage ${stage} does not hold stage ${stage}'s result`);
    const otherStages = sourceIds
      .map((id) => stageResultIds.get(id))
      .filter((turn) => turn !== undefined && turn !== stage);
    assert.deepEqual(otherStages, [],
      `The brief that named stage ${stage} also holds stage(s) ${otherStages.join(",")}`);
  }

  return {
    identifiedDecisions: identified.length,
    distinctIdentifiedBriefs: new Set(identifiedBriefs).size,
    maximumBriefChars: Math.max(...identifiedBriefs.map((brief) => brief.length)),
    tailAnchored: true,
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
  // A session whose window carries two pinned peek reads of a real fold. The peeks sit
  // AFTER the stalest batch on purpose: one automatic law folds the oldest completed
  // batch first, and a peek read swallowed by that fold is mass no pin is holding.
  const probe = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [4, 8], peekTargetId: "placeholder",
  });
  const seed = context.emptyActiveContextState(probe.sessionId);
  const foldId = (await commitCandidate(
    seed, peekSnapshot(probe), context.selectAutomaticToolBatch(peekSnapshot(probe), seed)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).prepared.id;
  const built = makeFixture({
    turns: 10, resultChars: 12_000, contextWindow: 100_000, peekTurns: [4, 8], peekTargetId: foldId,
  });
  const empty = context.emptyActiveContextState(built.sessionId);
  const snapshot = peekSnapshot(built);
  const folded = (await commitCandidate(
    empty, snapshot, context.selectAutomaticToolBatch(snapshot, empty)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).state;
  assert.equal(folded.folds[0].id, foldId, "The peeked fold id shifted with the peek argument");

  // Unpinned, those reads are ordinary ladder food and count as nothing held.
  assert.equal(context.markAccounting(snapshot, folded).pinnedBytes, 0);
  // Protection is now the ONLY way a peek read is held back from the ladder: peek
  // results are append-only, so the mass that can starve a commit is the mass the
  // agent protected outright.
  const peekRefs = snapshot.mapped
    .filter((item) => item.ref && ["call-4", "call-8"].includes(item.message?.toolCallId))
    .map((item) => item.ref);
  assert.equal(peekRefs.length, 2, "The fixture did not carry two peek results");
  const held = { ...folded, protected: peekRefs.map((ref) => structuredClone(ref)) };
  const heldAccounting = context.markAccounting(snapshot, held);
  assert(heldAccounting.pinnedBytes > 0, "Protected peek mass is still invisible in the accounting");
  assert.equal(heldAccounting.pinnedResults, 2);

  // The starvation itself: marks the commit cannot apply inflate the freed share the
  // top-up measures against, so the top-up concludes its work is already done.
  // Eleven marked results, up from eight (2026-08-14): the adequacy floor below is the
  // hysteresis gap, and minTarget 0.35 -> 0.20 widened it 0.45 -> 0.60, so the fixture
  // owed more marked mass to stay a starvation proof rather than a shortfall. The
  // 2026-08-23 retune narrows the gap again to 0.40, so eleven now clears it with
  // margin; the count stays where the widest setting put it, because a fixture sized to
  // the loosest bound proves the same thing under every tighter one.
  const wide = makeFixture({ turns: 24, resultChars: 26_000, contextWindow: 100_000 });
  const wideSnapshot = wide.snapshot;
  let starved = context.emptyActiveContextState(wide.sessionId);
  const ineligible = [];
  for (let turn = 0; turn < 11; turn += 1) {
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
  // The fixture's whole point: these marks would free real mass on the WINDOW-share
  // reading, and none of it is eligible. The number is re-derived on the one
  // denominator, so it is stated against the hysteresis gap rather than the retired
  // window floor: maxTarget - minTarget is the shallowest freeing target that can fire.
  assert(starvedAccounting.freedBudgetShare >=
    context.DEFAULT_THRESHOLDS.maxTarget - context.DEFAULT_THRESHOLDS.minTarget,
    `Ineligible marks reached only ${starvedAccounting.freedBudgetShare} of the target`);

  const anchorTopUp = context.topUpMarks({
    snapshot: wideSnapshot, state: starved, ordinal: 100, targetShare: 0.40,
  });
  const eligibleTopUp = context.topUpMarks({
    snapshot: wideSnapshot, state: starved, ordinal: 100, eligibleOnly: true, targetShare: 0.40,
  });
  assert.equal(anchorTopUp.length, 0, "The anchor top-up is no longer starved; the fixture proves nothing");
  assert(eligibleTopUp.length >= 1, "The backstop top-up stayed starved by ineligible mass");
  let toppedUp = starved;
  for (const mark of eligibleTopUp) toppedUp = context.addPendingMark(toppedUp, mark).state;
  const toppedUpAccounting = context.markAccounting(wideSnapshot, toppedUp);
  assert(toppedUpAccounting.eligibleMarks >= 1);
  assert(toppedUpAccounting.eligibleFreedBudgetShare > 0,
    "The topped-up commit would still free nothing");
  // The pressure backstop itself is untouched and still fires on ratio alone.
  assert.equal(context.epochCommitDue(wideSnapshot, 0.85, { eligibleShareThreshold: 0.30, eligibleShare: 0 }), true);

  // And a live commit reports the pinned mass in its own envelope.
  const runtime = makeRuntime(
    makeFixture({ turns: 40, resultChars: 20_000, contextWindow: 100_000 }),
  );
  await startRuntime(runtime);
  for (const tokens of [76_000, 78_000, 80_000]) await measure(runtime, tokens, 100_000);
  await measureAndCommit(runtime, 88_500, 100_000);
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "The pressure backstop did not commit");
  // The FENCE commits this one, not the boundary: 88,500 tokens of declared occupancy
  // against a 90,000-token serving budget is a crowded projection, and the fence is the
  // path that owns a request already at the margin.
  assert(epoch.appliedMarks >= 1, "The backstop commit applied nothing");
  assert.equal(typeof epoch.pinnedBytes, "number");

  return {
    pinnedBytes: heldAccounting.pinnedBytes,
    pinnedResults: heldAccounting.pinnedResults,
    ineligibleFreedShare: Number(starvedAccounting.freedBudgetShare.toFixed(3)),
    anchorTopUpMarks: anchorTopUp.length,
    backstopTopUpMarks: eligibleTopUp.length,
    backstopEligibleShare: Number(toppedUpAccounting.eligibleFreedBudgetShare.toFixed(3)),
    backstopAppliedMarks: epoch.appliedMarks,
  };
}

/**
 * The sealed spine, as a deployment now writes it. Every reliability lever rep 14
 * sealed is unconditional, so what remains is one experiment condition and one
 * deployment fact; the behaviour under test is identical to the twelve-lever runs.
 */
const SEALED_SPINE = Object.freeze({
  providerInputBudget: 90_000,
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
  runtime.excursion = [];
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
    runtime.excursion.push(runtime.branch.at(-1).id);
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
 * The transmission fence, and the stalest-first cut order that serves it.
 *
 * Measured 2026-08-06 (rep 11): the hard fence gates on `measurements.latestRatio`,
 * which describes the request the provider already ANSWERED. The last measurement read
 * 359,625 tokens of a 400,000 window (ratio 0.937 against a 0.959 fence) so nothing
 * aborted, and the projection that went out was 1,831,936 chars -- about 458k estimated
 * tokens, 1.2x the window. The provider rejected it twice and the worker died at stage
 * 39 of 64. Nothing in that run ever measured the request about to be SENT.
 *
 * The run also proved a turn boundary can never advance on this shape: all 58 assistant
 * messages carried stopReason "toolUse" and not one was terminal. That reading killed
 * the current-turn guard on 2026-08-23; what this gate keeps from the guard era is the
 * ORDERING law its waiver carried, now owned by the depth cut.
 */
async function gateProjectionBudgetFence() {
  // THE CUT ORDER IS REAL STALENESS, NOT THE MARK-ID ACCIDENT.
  //
  // Added 2026-08-10 for the guard waiver, kept 2026-08-23 for the depth cut that
  // replaced it. Every mark one epoch proposes carries the same `ordinal`: it is the
  // transcript position at MARK time, so it records when the DECISION was made and
  // nothing about the age of what the decision covers. Ordering the cut by it falls
  // through to comparing mark ids, which are content hashes, and a digest would decide
  // which evidence the commit spends first. What the bound protects is the newest reads
  // an in-flight excursion is about to use, and that is a property of the SPAN, so the
  // order is the earliest window index each span covers, oldest first.
  //
  // The fixture's mark ids and its span order disagree, and that disagreement is
  // asserted BEFORE the outcome: without it the check would pass under either ordering.
  const orderSession = "waiver-order-test";
  const orderBatches = 8;
  // Six of the eight batches are marked, oldest first, so the cut has both marks to
  // spend and marks to hold and the boundary between them is what the order decides.
  const orderMarked = 6;
  const orderEntries = [];
  const orderMessages = [];
  const orderResultIds = [];
  let orderParent = null;
  const orderAdd = (message) => {
    const id = `${orderSession}-entry-${String(orderEntries.length + 1).padStart(3, "0")}`;
    orderEntries.push({ type: "message", id, parentId: orderParent, message });
    orderMessages.push(message);
    orderParent = id;
    return id;
  };
  orderAdd({
    role: "user",
    content: [{ type: "text", text: "One marathon task: keep reading and keep going." }],
    timestamp: 1,
  });
  for (let step = 0; step < orderBatches; step += 1) {
    orderAdd({
      role: "assistant",
      content: [{ type: "toolCall", id: `order-${step}`, name: "read", arguments: { path: `order-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 10 + step,
    });
    orderResultIds.push(orderAdd({
      role: "toolResult",
      toolCallId: `order-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Order ${step}: ${"z".repeat(6_000)}` }],
      isError: false,
      timestamp: 10 + step,
    }));
  }
  const orderSnapshot = context.mapActiveContext({
    sessionId: orderSession,
    eventMessages: orderMessages,
    contextEntries: orderEntries,
    contextWindow: 100_000,
  });
  assert(!terminalStopIn(orderMessages),
    "A turn closed in the cut-order fixture; the never-closing shape is the one under test");
  assert(orderBatches > orderMarked, "The fixture marked every batch it holds");
  let orderState = context.emptyActiveContextState(orderSession);
  for (const resultId of orderResultIds.slice(0, orderMarked)) {
    const candidate = context.manualFoldCandidate(
      orderSnapshot, orderState, [resultId], { allowProtected: true });
    orderState = context.addPendingMark(orderState, context.foldMarkFor({
      candidate,
      brief: context.automaticToolBrief(orderSnapshot, candidate),
      briefProvenance: { kind: "deterministic" },
      origin: "ladder",
      // ONE epoch proposed all of them, which is the shape that makes the ordinal mute.
      ordinal: context.markOrdinal(orderSnapshot),
    })).state;
  }
  const orderMarks = context.pendingMarks(orderState);
  assert.equal(orderMarks.length, orderMarked, "The waiver-order fixture did not mark every batch it names");
  assert.equal(new Set(orderMarks.map((mark) => mark.ordinal)).size, 1,
    "The fixture's marks carry more than one ordinal, so the degenerate case is not being measured");
  const bySpan = [...orderMarks]
    .sort((left, right) => context.markSpanStart(orderSnapshot, orderState, left) -
      context.markSpanStart(orderSnapshot, orderState, right))
    .map((mark) => mark.id);
  const byMarkId = [...orderMarks].sort((left, right) => left.id.localeCompare(right.id))
    .map((mark) => mark.id);
  // The bound is sized off the marks' own freed bytes so the cut stops after exactly
  // four of the six, and only the ORDER decides which four.
  const orderCut = 4;
  const spanOrdered = bySpan.map((id) => orderMarks.find((mark) => mark.id === id));
  const cutTarget = spanOrdered.slice(0, orderCut).reduce((total, mark) =>
    total + context.markFreedBytes(orderSnapshot, orderState, mark), 0);
  assert(cutTarget > 0, "The cut target is empty, so the bound cannot bind");
  // The fixture is only worth running while the two orders genuinely disagree, and this
  // is the disagreement that matters: by mark id the cut reaches the NEWEST span in the
  // set, which is the one evidence the bound exists to hold back.
  assert(byMarkId.slice(0, orderCut).includes(bySpan.at(-1)),
    "Mark-id order no longer spends the newest span, so this fixture cannot tell the orders apart");
  const released = await context.commitPendingMarks({
    snapshot: orderSnapshot,
    state: orderState,
    generation: 1,
    applyTargetBytes: cutTarget,
  });
  assert.deepEqual(released.applied.map((mark) => mark.id), bySpan.slice(0, orderCut),
    "The cut spent marks in an order span staleness does not explain");
  assert.deepEqual(context.pendingMarks(released.state).map((mark) => mark.id).sort(),
    [...bySpan.slice(orderCut)].sort(),
    "The bound held back something other than the newest material");

  // A session whose PROJECTION is far past the serving budget while the last measured
  // ratio is calm: exactly the rep11 shape, where the excursion outgrew the window
  // between one provider response and the next request.
  const runtime = makeRuntime(
    makeFixture({ turns: 16, resultChars: 12_000, contextWindow: 34_000 }),
    { ...SEALED_SPINE, providerInputBudget: 30_600 },
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
  assert(!terminalStopIn(runtime.messages.slice(-24)),
    "A terminal stop closed the excursion, so the rep11 shape is not being measured");
  assert(toolResultRefKeys(openSnapshot).size >= 12,
    "The excursion's reads are not mapped, so there is nothing for the fence to spend");

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
  assert.equal(epoch.retainedMarks, 0, "The fence left marks retained while the request would not fit");

  // THE STARVED SESSION: THE FOLD PATH REACHES, AND THE ROLLBACK STILL CARRIES IT.
  //
  // The rep11 shape exactly: 47 messages, one open excursion, no terminal assistant.
  //
  // RE-DERIVED 2026-08-10 (the open-turn commit fix). This section used to assert that
  // the stale boundary EQUALS the fresh boundary here and that automation therefore
  // folds and marks nothing at all -- "a window that is one open excursion cannot be
  // saved by either mechanism". The equality was the bug, not the law: the stale
  // boundary was clamped to the fresh boundary, and on a session that never closes a
  // turn that clamp is zero-width, which is how luna-20260810 pifold rep 2 reached
  // 375,830 tokens with 274,173 of them unmarked and never committed once.
  //
  // The stale zone is a byte prefix now, so it runs PAST the last closed turn into the
  // excursion and the fold path does reach real mass here. What this fixture still
  // proves is that reaching is not the same as saving: 420,000 chars of excursion
  // against a 30,600-token serving budget is a genuine impossibility, so the reduction
  // cannot close the gap, the abort holds, the rollback lane runs, and the recovery
  // record says recovered FALSE rather than dressing an unchanged request as a rescue.
  const guardedOnly = makeRuntime(
    makeFixture({ turns: 8, tools: false, chapterChars: 40, contextWindow: 34_000 }),
    { ...SEALED_SPINE, providerInputBudget: 30_600 },
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
  await measure(guardedOnly, 25_000, 34_000, undefined, "toolUse");
  await project(guardedOnly);
  await settle();
  const guardedSnapshot = context.mapActiveContext({
    sessionId: guardedOnly.built.sessionId,
    eventMessages: guardedOnly.messages,
    contextEntries: guardedOnly.branch,
    contextWindow: 34_000,
  });
  assert(!terminalStopIn(guardedOnly.messages.slice(-28)),
    "A turn closed inside the excursion, so the starving case is not being measured");
  const guardedMembers = context.automaticToolBatches(
    guardedSnapshot, context.emptyActiveContextState(guardedOnly.built.sessionId));
  assert(guardedMembers.length > 0,
    "The automatic law found no member inside the open excursion, so the reach is clamped again");
  assert(!guardedMembers.some((batch) =>
    batch.indices.includes(guardedSnapshot.messages.length - 1)),
  "The newest result is a member, so the fresh tail bounds nothing");
  assert(toolResultRefKeys(guardedSnapshot).size >= 12,
    "The excursion's reads are not mapped, so the starving case is not being measured");
  // The new truth, positively: the fold path found legal material inside the open
  // excursion and folded it. What it could not do is fold enough.
  const starvedFolds = materialized(guardedOnly).folds.length;
  assert(starvedFolds >= 1,
    "The fold path reached nothing on the open excursion, so the starvation is back");
  const guardedAbortsBeforeOverflow = guardedOnly.aborts;
  assert(guardedAbortsBeforeOverflow >= 1,
    "A projection the fold path cannot reduce far enough was transmitted instead of aborted");

  // THE ROLLBACK CARRIES IT. The provider rejects, the leaf moves back past the request
  // that failed, one notice is steered, and the retried pass runs the recovery lane.
  const guardedFrom = guardedOnly.appended.length;
  await overflow(guardedOnly);
  const guardedRollback = contextEvents(guardedOnly, guardedFrom)
    .find((record) => record.kind === "context.rollback");
  assert(guardedRollback, "The starved session got no rollback");
  assert.equal(guardedRollback.armed, true);
  assert.equal(guardedRollback.replayed, true, "The starved session's request was not reissued");
  assert.equal(guardedOnly.steered.filter((item) =>
    String(item.message?.customType ?? "").endsWith("-overflow-recovery")).length, 1,
  "The recovery queued more than one steered message");
  assert(!guardedOnly.branch.some((entry) => entry.message?.stopReason === "error"),
    "The rejected entry is still on the live branch");
  assert.equal(guardedOnly.labels.length, 1, "The abandoned path carries no lineage label");
  const guardedRetryFrom = guardedOnly.appended.length;
  await project(guardedOnly);
  await settle();
  const guardedRecovery = contextEvents(guardedOnly, guardedRetryFrom)
    .find((record) => record.kind === "context.recovery");
  assert(guardedRecovery, "The retried pass never ran the recovery lane");
  assert.equal(guardedRecovery.rollback_seq, guardedRollback.seq,
    "The fold-side record does not join the rollback that caused it");

  // AND THE LOUD FAILURE SURVIVES BOTH. This window is 420,000 chars of excursion
  // against a 30,600-token budget: the fold path reaches what the stale zone admits and
  // it is nowhere near enough, and the rollback can shorten nothing except the request
  // itself. So it still fails rather than sending something the provider will reject.
  // That is the impossibility this build never claimed to solve.
  assert.equal(guardedRecovery.recovered, false,
    "The starved fixture recovered, so it is no longer measuring the impossible case");
  // AND THE CLAIM IS BACKED, not asserted from our own estimate. The recovery pass
  // folded nothing, so the retried request is byte-identical to the one the provider
  // rejected, and the record says so in the two fields the verdict is derived from.
  assert.equal(guardedRecovery.loop_reduced, false, "The recovery loop reduced but reported nothing reduced");
  assert.equal(guardedRecovery.freed_tokens, 0, "The recovery pass freed tokens it did not report");
  assert.equal(guardedRecovery.rejected_tokens, guardedRecovery.tokens_after,
    "The rebuilt request differs in size from the one the provider rejected");
  assert(guardedOnly.aborts > guardedAbortsBeforeOverflow,
    "An over-budget projection was transmitted after the rollback");

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
    orderMarkedMarks: orderMarked,
    orderCut,
    orderIdOrderDiffersFromSpanOrder: true,
    orderCutStalestFirst: true,
    budgetTokens,
    projectedTokensBefore: reduction.estimatedTokensBefore,
    projectedTokensAfter: reduction.estimatedTokensAfter,
    transmitted: reduction.transmitted === true,
    aborts: runtime.aborts,
    fenceAppliedMarks: epoch.appliedMarks,
    starvedMemberBatches: guardedMembers.length,
    starvedFreshBoundary: guardedSnapshot.freshBoundary,
    starvedFolds: starvedFolds,
    starvedFoldsAfterRecovery: materialized(guardedOnly).folds.length,
    starvedRollbackReplayed: guardedRollback.replayed,
    starvedRecovered: guardedRecovery.recovered,
    starvedRecoveryLoopReduced: guardedRecovery.loop_reduced,
    starvedAborts: guardedOnly.aborts,
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
  const runtime = makeRuntime(built, { ...SEALED_SPINE, providerInputBudget: 36_000 });
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
    makeFixture({ turns: 12, resultChars: 8_000, contextWindow: 12_000, thresholds: context.DEFAULT_THRESHOLDS }),
    // A 12,000-token window can be served, but not by the default 2% fresh tail: at a
    // 10,800-token budget that is 216 tokens, under the one-foldable-unit floor. The
    // deployment declares a policy the window can carry, which is the designed answer to
    // a tiny window: reject the impossible one, do not silently clamp it.
    { ...SEALED_SPINE, providerInputBudget: 10_800, thresholds: context.DEFAULT_THRESHOLDS },
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
  // the pass instead of reducing it. That is the correct ordering: a request whose
  // projection exceeds the provider input budget is rejected outright, so recovery must
  // produce a window that fits -- and it is why overBudgetReduction is
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
  // An 18,000-token budget cannot carry the default 2% fresh tail (360 tokens, under
  // the one-foldable-unit floor), so this deployment declares a policy its window can
  // serve. That is the tiny-window contract: refuse the impossible, never clamp it.
  // STARVATION IS MASS THE LADDER MAY NOT TAKE, NOT MASS IT HAS NOT REACHED.
  //
  // This climb used to starve on inflow that was merely unfolded, which worked only
  // because a byte walk charged the folded head its raw bytes and froze the reach. That
  // walk is deleted: foldability is membership, so the same fixture folds each stage as
  // it arrives and sawtooths between 84k and 123k chars forever, which measures the
  // ladder keeping up rather than the fence. Untakeable now means declared untakeable, by
  // two standing refusals that hold at any occupancy: the deployment named this producer
  // unfoldable, so no tool batch forms, and the agent pinned the call inside each batch,
  // so no chapter span may contain it. The pin is the assistant message, not the result,
  // which costs a couple of hundred bytes against the 25% pinned-share ceiling, so the
  // fixture measures the fence rather than the ceiling.
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: window, thresholds: context.DEFAULT_THRESHOLDS }),
    {
      ...SEALED_SPINE,
      providerInputBudget: servingBudget(window),
      thresholds: context.DEFAULT_THRESHOLDS,
      blacklistAutoFoldTools: new Set(["stage_stream"]),
    },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, 18_000, "The truthful serving budget moved");

  // Climb toward the top of the window in real steps, declaring seven chars per token
  // throughout, which is what this workload actually measured.
  // Each measurement CLOSES its turn. The climb's subject is the estimator and the
  // margin, not the guard.
  //
  // RESTATED 2026-08-10 (the open-turn commit fix, then the class-law ruling). The reason
  // used to be that an inflow which never closes leaves every byte inside the open turn
  // "where the zone law admits nothing at any occupancy". That was the regression
  // talking: the automatic reach was a byte prefix clamped to the fresh boundary, so an
  // unclosed session had zero width and starved. Automation reaches an open excursion
  // now, with no turn-scoped hold left anywhere (the guard is deleted, 2026-08-23), so
  // what the climb measures is the estimator and the margin alone.
  // EIGHT STEPS, NOT TWELVE. The loop used to break the moment the fence recorded a
  // reduction, which on the old fixture happened around the fourth pass; with the starved
  // case deleted above nothing breaks it early and twelve passes cost this gate a fifth
  // of the whole suite to prove what four transmitted calibrated passes already prove.
  const climb = [];
  for (let step = 0; step < 12; step += 1) {
    const chars = bytesOf((await project(runtime)).messages);
    await measure(runtime, sevenChars(chars), window);
    await compactBoundary(runtime);
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
    // One stage of inflow: a payload of the size this workload actually gathers, asked
    // for by a user turn so the stage CLOSES, which keeps the current-turn guard out of
    // a climb that is about the estimator.
    runtime.appendMessage({
      role: "user", content: [{ type: "text", text: `Stage ${step}, please.` }], timestamp: 700 + step,
    }, "inflow");
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `stage-${step}`, name: "stage_stream", arguments: { path: `stage-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 700 + step,
    }, "inflow");
    const callEntryId = runtime.branch.at(-1).id;
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `stage-${step}`,
      toolName: "stage_stream",
      content: [{ type: "text", text: `Stage ${step}: ${"s".repeat(10_000)}` }],
      isError: false,
      timestamp: 700 + step,
    }, "inflow");
    // The pin lands on a current snapshot, so the stage has to be projected before the
    // agent can name it. One pin per stage, on the call rather than the payload.
    await project(runtime);
    const pinned = await toolCall(runtime, { action: "pin", ids: [callEntryId] });
    assert.equal(pinned.details.protectedRefs, step + 1,
      `The stage-${step} pin did not hold: ${JSON.stringify(pinned.details).slice(0, 200)}`);
  }

  // THE ESTIMATOR, MEASURED WHERE IT MEANS SOMETHING.
  //
  // The first pass has nothing measured yet and necessarily uses the bootstrap constant;
  // the drift claim is about the CALIBRATED estimator. A pass that ABORTED is excluded
  // for a different reason: it handed the host no projection, so the estimate it reports
  // describes the last projection that actually went out. Comparing that against a
  // declaration made for a projection nobody transmitted measures the abort, not the
  // estimator.
  const calibrated = climb.filter((entry) =>
    typeof entry.estimate === "number" && entry.charsPerToken !== context.ESTIMATED_BYTES_PER_TOKEN);
  assert(calibrated.length >= 2, "The climb never calibrated");
  const transmitted = calibrated.filter((entry, index) =>
    index === 0 || entry.aborts === calibrated[index - 1].aborts);
  assert(transmitted.length >= 4, "The climb never transmitted enough calibrated passes to weigh");
  const worstDrift = Math.max(...transmitted.map((entry) =>
    Math.abs(entry.estimate - entry.declared) / entry.declared));
  assert(worstDrift <= 0.1, `The calibrated estimate drifted ${(worstDrift * 100).toFixed(1)}% from measured`);
  // The margin is a share of the SERVING BUDGET, which is the one denominator: with the
  // budget declared already net there is no window behind it to take a share of.
  assert(transmitted.every((entry) => entry.margin >= 0.05 * budgetTokens),
    `A calibrated pass carried a margin under the floor share of the ${budgetTokens}-token budget`);

  // THE ORDINARY REACH WORKS WHILE THERE IS STALE MASS, AND THEN IT STOPS.
  //
  // The climb folds on the way up: the projection drops mid-climb, which is the band-top
  // commit reducing eligible stale material at ordinary depth. Once that mass is spent
  // the projection is one open middle and a fresh tail, and the zone law admits nothing
  // there at any occupancy. This fixture is the one the pass-3 fence rulings were
  // written from -- 132,906 to 200,299 chars over three passes while every fence pass
  // reclaimed nothing -- and the answer to it is no longer a deepened snapshot that
  // reaches into the middle. It is a rollback.
  const foldedOnTheWayUp = climb.some((entry, index) => index > 0 && entry.chars < climb[index - 1].chars);
  assert(foldedOnTheWayUp, "The ordinary reach never reduced the window while stale mass remained");
  assert(climb.at(-1).aborts > climb[0].aborts,
    "The climb transmitted instead of aborting");
  // The third claim here is DELETED, not weakened, and this is the one place it could be
  // read as a loss. It asserted `reduction === null` on the last pass: the fence reaching
  // the top with nothing left it may take. That fixture built its untakeable mass out of
  // a deployment blacklist plus a pin on each stage's CALL, and it only ever starved
  // because the fresh tail held the stage RESULTS back for free. A blacklist stops a
  // tool batch forming; it does not stop a chapter absorbing the same bytes (gate 98
  // separates the two laws), and pinning the results instead would spend the 25 percent
  // pinned-share ceiling this fixture exists to stay under. So with the proportion
  // deleted the starved pass is not constructible from this shape at all, and a fixture
  // that cannot reach its own subject is worth nothing.
  //
  // It is not unowned. Gate 98 drives a commit pass to the adjudication with nothing
  // proposable and pins the record it has to emit, the deferral, the zero counts and the
  // remainder beside them, on a fixture where the holds are stated rather than inherited
  // from a proportion. What is left here is what this gate uniquely owns: the estimator,
  // the margin floor, and the abort the rollback below needs the climb to reach.
  //
  // The loop no longer BREAKS, because the reduction it broke on is the deleted claim, so
  // it runs its full twelve and the abort arrives on the LAST one, which is what makes
  // this the most expensive gate in the suite. That was measured rather than assumed:
  // eight, nine, ten and eleven steps all transmit, and halving either the fixture or the
  // stage payload stops the climb reaching its budget at all. The abort is load-bearing
  // twice over, once for the assertion above and once as the precondition for the
  // hard-fence rollback below, which is the above-the-fence case gate 56 explicitly does
  // not cover. So the cost stays and is stated, rather than being traded for a fixture
  // that no longer reaches its own subject.

  // THE ROLLBACK CARRIES IT, and the loud failure survives when even that is not enough.
  //
  // One ordering to know about, and it is why the fold-side record is gate 56's
  // assertion and not this one: `abortUnsafeHardContext` runs earlier in the context
  // pass than the projection budget does, so a session whose MEASURED ratio is already
  // at the hard fence -- which this climb's is -- aborts the retried request before the
  // recovery lane is reached. The terminal answer is the same either way, an aborted
  // request rather than one the provider will reject, but the episode goes unrecorded on
  // the fold side. Gate 56's fixture sits below the fence ratio, so the lane runs there
  // and the join is asserted against it.
  const climbFrom = runtime.appended.length;
  await overflow(runtime);
  const climbRollback = contextEvents(runtime, climbFrom)
    .find((record) => record.kind === "context.rollback");
  assert(climbRollback, "The starved climb got no rollback");
  assert.equal(climbRollback.armed, true);
  assert.equal(climbRollback.replayed, true);
  assert.equal(runtime.steered.filter((item) =>
    String(item.message?.customType ?? "").endsWith("-overflow-recovery")).length, 1,
  "The recovery queued more than one steered message");
  assert(!runtime.branch.some((entry) => entry.message?.stopReason === "error"),
    "The rejected entry is still on the live branch");
  const abortsBeforeRetry = runtime.aborts;
  const retriedProjection = await project(runtime);
  await settle();
  assert(runtime.aborts > abortsBeforeRetry,
    "The retried request was transmitted against a budget it still does not fit");
  assert(retriedProjection.messages.length >= 1,
    "An aborted pass handed back nothing at all instead of the projection");

  // Calibration recency: the session's ratio drifts from seven chars per token to five.
  // The estimate must follow it, because at this occupancy a stale ratio is the whole
  // error budget. The smallest recent ratio wins, so the dangerous direction is instant.
  // Held at 4,000 result chars: calibration needs 20,000 measured chars and 5,000
  // measured tokens per pass, absolute floors this section cannot scale under.
  const drifting = makeRuntime(
    makeFixture({ turns: 16, resultChars: 4_000, contextWindow: 200_000 }),
    { ...SEALED_SPINE, providerInputBudget: 183_616 },
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
  // SIZED TO THE CLAIM, WHICH IS SMALLER THAN THE FIXTURE THAT FIRST CAUGHT IT. The
  // trigger here is the DECLARED occupancy below, not the fixture's own bytes, so the
  // 30-turn 12,000-char shape was paying for 360,000 characters of projection on every
  // one of eight cycles to prove a ratchet that needs only enough stale mass for repeated
  // commits to have something to reach. Measured: 61.6 seconds of an 80-second gate and a
  // fifth of the whole suite. At 12 turns and 8,000 chars the same eight commits run
  // against the same declared climb, and the assertions below are unchanged except for
  // the stage size they are stated in.
  const stageChars = 12_000;
  const deep = makeRuntime(
    makeFixture({ turns: 12, resultChars: 8_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE, providerInputBudget: 90_000 },
  );
  await startRuntime(deep);
  const epochs = [];
  const projections = [];
  // Eight cycles instead of five: with the last-call round in front of every band-top
  // commit, the rhythm is expose-then-commit across two request cycles, so three
  // commits need at least six, and the action is read after the context pass that can
  // carry the commit, deduplicated because it lingers across quiet passes.
  let previousEpochKey = null;
  const postCommitProjections = [];
  for (let step = 0; step < 8; step += 1) {
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
      content: [{ type: "text", text: `Deep ${step}: ${"d".repeat(stageChars)}` }],
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
    projections.push(bytesOf((await project(deep)).messages));
    await settle();
    const action = (await toolStatus(deep)).details.automatic.lastAutomaticAction;
    const epochKey = action?.epoch ? json.stableStringify(action.epoch) : null;
    if (epochKey && epochKey !== previousEpochKey) {
      epochs.push(action.epoch);
      postCommitProjections.push(projections.at(-1));
      previousEpochKey = epochKey;
    }
  }
  assert(epochs.length >= 2, `Only ${epochs.length} commit epochs ran; the ratchet is not being measured`);
  // DEPTH IS ORDINARY DEPTH NOW. There were three assertions here about a deepened
  // target, a pre-deepen freed share and the marks deepening added, and all three
  // described the fence-only snapshot that reached into the fresh tail. That snapshot is
  // gone, so a commit reaches as far as the stale zone offers and no further. What has
  // to survive is the property those assertions were serving: a commit that reaches
  // eligible mass keeps pace with inflow. It is asserted directly below, on the window
  // itself, rather than through the machinery that used to produce it.
  assert(epochs.every((epoch) => epoch.appliedMarks >= 1),
    "A commit epoch ran without applying a mark");
  assert(epochs.every((epoch) => epoch.guardWaived === undefined),
    "A commit receipt still carries guard-waiver vocabulary; the guard and its waiver are deleted");
  // The property the rep13 ratchet violated, measured at like phases of the rhythm:
  // across a run where every cycle added a 24,000-char stage of inflow, the window
  // just after the LAST commit has grown by less than ONE such stage since just after
  // the first. Commits that keep pace with inflow bound the window; the ratchet was
  // the unbounded staircase, 30,000 tokens up through six commits and into a
  // provider rejection.
  assert(postCommitProjections.at(-1) - postCommitProjections[0] < stageChars,
    `The window ratcheted from ${postCommitProjections[0]} to ${postCommitProjections.at(-1)} chars ` +
    `across ${epochs.length} commits`);

  return {
    budgetTokens,
    climbSteps: climb.length,
    transmittedCalibratedPasses: transmitted.length,
    worstDriftPercent: Number((worstDrift * 100).toFixed(1)),
    charsPerTokenAfterDrift: afterDrift.at(-1).charsPerToken,
    starvedClimbRollbackReplayed: climbRollback.replayed,
    commitEpochs: epochs.length,
    appliedPerEpoch: epochs.map((epoch) => epoch.appliedMarks),
    projectionFirst: projections[0],
    projectionLast: projections.at(-1),
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
  // Deliver the last-call, spend the gated round, and read the projection of the
  // commit pass itself: the receipt rides the rewrite that commit paid for.
  await project(runtime);
  await settle();
  await measure(runtime, 87_500, 100_000, undefined, "toolUse");
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
  assert.match(text, /"action":"expand"/);
  assert.match(text, /"action":"reboundary"/);
  assert.equal(/rebrief/.test(text), false, "The receipt still advertises the deleted action");
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
  await settle();
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
 * Bite-sized LADDER folds, and an agent span taken whole.
 *
 * Measured 2026-08-06 (rep 6): one 60,432-byte chapter fold hid the fact the run
 * needed in its tail. A fold is only navigable if reading one back is cheap, so the
 * ladder cannot build an oversized chapter.
 *
 * THE CAP CAME OFF THE AGENT'S OWN SPAN (Shane, 2026-08-22). It was applied to manual
 * marks too, and manual marks were its ONLY caller: the ladder never split, because
 * `selectAutomaticChapter` stops accumulating at the cap by itself. So the split
 * existed solely to overrule the one judgement the design is trying to encourage, and
 * it charged twice for doing so. One intended fold became five or ten placeholders,
 * and each piece was handed the SAME brief, so every one of them claimed to describe a
 * span it held a fraction of, while the correction text said "each with its own brief".
 *
 * What separates the two cases is who chose the boundary. A ladder fold is a span
 * nobody vouched for, so it stays small enough to read back cheaply. An agent fold is a
 * span the agent cut and wrote a brief for, and it is navigable by a route that did not
 * exist when rep 6 was measured: peek takes offset and bytes, states the omitted
 * middle, and reads any child id, so a large fold has a narrow read; an expand that
 * will not fit is refused with a bounded peek offered in its place.
 */
/**
 * THE BAND TOP COMMITS ON ITS OWN (Shane, 2026-08-22).
 *
 * Reported from a live 1M-window session: provider count 571,367 against a serving budget
 * of 1,032,192, the settings panel reading "Commit trigger 0.50 / 516,096 tok", and
 * `folds: 0`. Occupancy had stood 55,000 tokens above the stated trigger for most of a
 * session and nothing had ever committed.
 *
 * The label was not lying about the intent, it was lying about the runtime. There were
 * exactly two commit sites: `enforceProjectionBudget`, which measures against the WHOLE
 * serving budget plus a margin, and the compaction boundary, which is Pi's own threshold
 * near the top of the window. `maxTarget` reached neither. `epochCommitDue` existed and
 * was read only by `schedulingStatus`, for display. Every gate that produced a commit
 * reached it through `measureAndCommit`, which ends in `compactBoundary`, so the suite
 * agreed with the runtime and neither of them agreed with the panel.
 *
 * On a 251,520-token budget the gap is invisible: the fence sits close enough behind the
 * boundary that a commit lands either way. At 1M the two are half a million tokens apart,
 * and the session simply climbs.
 *
 * ONE IF STATEMENT, no latch (Shane: "if it's over we fold"). Every projection pass asks
 * whether occupancy is over `maxTarget` and commits when it is. Occupancy only moves when
 * the provider measures, and a second attempt inside one handoff defers on the mutation
 * budget, so this is one commit per pass while over and nothing more elaborate.
 */
async function gateBandTopCommits() {
  // maxTarget 0.50 RATHER THAN THE DEFAULT, which is the reported session's own setting
  // and the only way to separate the two triggers. At 0.80 on this budget the band top
  // lands inside the fence's margin and the fence fires first, which is exactly why a
  // 251,520-token campaign never exposed this and a 1M window did.
  const window = 200_000;
  const budget = 120_000;
  const thresholds = { ...context.DEFAULT_THRESHOLDS, maxTarget: 0.50, minTarget: 0.20 };
  const built = makeFixture({
    sessionId: "band-top", turns: 26, resultChars: 14_000, contextWindow: window,
  });
  const runtime = makeRuntime(built, { providerInputBudget: budget, thresholds });
  await startRuntime(runtime);
  const bandTop = thresholds.maxTarget * budget;
  const commits = () => contextEvents(runtime)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);

  // (a) UNDER IT, NOTHING.
  await measure(runtime, Math.round((thresholds.maxTarget - 0.15) * budget), window);
  await project(runtime);
  await settle();
  assert.equal(commits().length, 0, "A commit fired below the band top");

  // (b) OVER IT, A COMMIT, with no boundary call anywhere in this gate and a projection
  // nowhere near the serving budget the fence watches.
  await measure(runtime, Math.ceil(bandTop) + 4_000, window);
  await project(runtime);
  await settle();
  const fired = commits();
  assert.equal(fired.length, 1,
    `The band top produced ${fired.length} commits with no boundary and no fence`);
  assert.equal(fired[0].trigger, "band-top",
    `The commit that fired at the band top names itself ${fired[0].trigger}`);
  assert(fired[0].applied_marks > 0, "The band-top commit applied no marks");
  assert(materialized(runtime).folds.length > 0, "The band-top commit produced no folds");
  assert.equal(commits().filter((record) => record.trigger === "projection-budget").length, 0,
    "The fence fired, so this gate is measuring the fence and not the band top");

  // (c) THE CUT STOPS AT THE AIM. Routine housekeeping at a stated threshold takes a
  // null ratio, which arms the depth bound; the fence and the boundary carry a ratio
  // and no bound, because something has already gone wrong there. The guard-waiver
  // vocabulary the receipt used to carry is gone with the guard (2026-08-23).
  const epoch = (await toolStatus(runtime)).details.automatic.lastAutomaticAction?.epoch;
  assert(epoch, "The band-top commit left no epoch record");
  assert.equal(epoch.waivedMarks, undefined,
    "The receipt still carries guard-waiver vocabulary; the guard and its waiver are deleted");
  assert.equal(epoch.guardWaived, undefined,
    "The receipt still carries guard-waiver vocabulary; the guard and its waiver are deleted");

  return {
    budgetTokens: budget,
    bandTopTokens: Math.round(bandTop),
    bandTopCommits: commits().filter((record) => record.trigger === "band-top").length,
    foldsAfterCommit: materialized(runtime).folds.length,
    boundaryCalls: 0,
  };
}

async function gateBiteSizedFolds() {
  // THE TURN CAP WENT TOO (Shane, 2026-08-22: fewer moving parts). `maxChapterTurns` 4
  // bounded the same span a second way and in a second unit. On the ladder it was
  // redundant, because the walk already stops at MAX_FOLD_SPAN_CHARS and can only stop
  // EARLIER for a reason that is not about size. On the agent it was the last thing
  // standing between a mark and the whole window.

  assert.equal(context.MAX_FOLD_SPAN_CHARS, 16_000);
  assert.equal(context.PEEK_DEFAULT_MAX_BYTES, 16_000);

  // The ladder: a session whose coherent chapters would run far past the cap.
  const runtime = makeRuntime(
    makeFixture({ turns: 24, tools: false, chapterChars: 2_000, contextWindow: 100_000 }),
    { providerInputBudget: 90_000 },
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

  // THE MANUAL PATH: one span the agent named, one mark, one fold, one brief.
  const wide = makeFixture({ turns: 20, tools: false, chapterChars: 3_000, contextWindow: 100_000 });
  const empty = context.emptyActiveContextState(wide.sessionId);
  const oversized = context.manualFoldCandidate(wide.snapshot, empty, [
    wide.turnEntries[0][0], wide.turnEntries[9].at(-1),
  ]);
  const spanChars = context.candidateSpanChars(wide.snapshot, empty, oversized);
  assert(spanChars > context.MAX_FOLD_SPAN_CHARS,
    `The fixture span is ${spanChars} chars, not past the ${context.MAX_FOLD_SPAN_CHARS} cap`);
  // The splitter is DELETED rather than left unused, so nothing can quietly call it back.
  assert.equal(context.splitCandidateBySize, undefined,
    "the manual splitter is still callable");
  // So are the three caps that bounded the same span in three other units (Shane,
  // 2026-08-22). Turns, chapter chars, and exact refs: `maxChapterTurns` 4 and
  // `maxChapterChars` 128,000 were each redundant against MAX_FOLD_SPAN_CHARS on the
  // ladder and a hard stop on the agent, and `maxFoldSourceRefs` 256 was refusing the
  // exact shape the whole-span law exists to allow. The ref cap gets its own probe
  // below, because a policy field reading `undefined` proves only that it is gone.
  assert.equal(context.ACTIVE_CONTEXT_POLICY.maxChapterTurns, undefined,
    "the chapter turn cap is still declared");
  assert.equal(context.ACTIVE_CONTEXT_POLICY.maxChapterChars, undefined,
    "the chapter char cap is still declared");
  assert.equal(context.ACTIVE_CONTEXT_POLICY.maxFoldSourceRefs, undefined,
    "the fold source-ref cap is still declared");

  const manual = makeRuntime(wide, {});
  await startRuntime(manual);
  // THROUGH REBOUNDARY, which is the verb that still names a span. `fold` is deleted, but
  // the law it carried is not: a span the agent names becomes exactly ONE fold, however
  // far past the size cap it runs, rather than being split into a handful that each get a
  // copy of the same brief. Re-cutting is the one place a person or an agent still hands
  // the runtime a span, so it is where the law has to hold.
  const agentBrief = "Ten completed tasks whose exact evidence stays recoverable behind this fold.";
  const folded = await toolCall(manual, {
    action: "reboundary",
    ids: [wide.turnEntries[0][0], wide.turnEntries[9].at(-1)],
    brief: agentBrief,
  });
  assert.equal(folded.details.created.length, 1,
    `An agent span past the cap became ${folded.details.created.length} folds`);
  assert(!folded.details.corrections.some((item) => /split/.test(item.reason)),
    "The span was reported as split");
  assert(!folded.details.corrections.some((item) => /turn/.test(item.reason)),
    "The span was clamped back to a turn limit");
  const wholeCommitted = await measureAndCommit(manual, 86_000, 100_000, "whole-commit");
  const agentFold = wholeCommitted.folds.find((fold) => fold.brief.endsWith(` · Agent: ${agentBrief}`));
  assert(agentFold, "the agent's fold did not commit carrying its own words");
  assert.equal(agentFold.provenance.kind, "augmented",
    "an agent-briefed fold does not record augmented provenance");
  assert(agentFold.sourceChars > context.MAX_FOLD_SPAN_CHARS,
    `the committed agent fold is ${agentFold.sourceChars} chars, so it was bite-sized anyway`);
  assert.equal(wholeCommitted.folds.filter((fold) => fold.brief.endsWith(` · Agent: ${agentBrief}`)).length, 1,
    "one brief was handed to several folds, which is what the split used to do");

  // AND IT IS STILL NAVIGABLE, which is the property rep 6 actually lost. A default peek
  // of a large fold returns a bounded window and SAYS it is bounded rather than pretending
  // to be complete, so reading one back is cheap however large it is.
  const wholeState = materialized(manual);
  const committedId = wholeState.folds.find((fold) =>
    fold.brief.endsWith(` · Agent: ${agentBrief}`)).id;
  const widePeek = await toolCall(manual, { action: "peek", id: committedId });
  assert.equal(widePeek.details.truncated, true,
    "a peek of an oversized fold claims to be complete");
  assert(widePeek.details.omittedBytes > 0,
    "the bounded peek does not state what it omitted");
  assert.equal(widePeek.details.view, "index",
    "a bounded read of a large fold does not present itself as an index view");
  assert(widePeek.details.sourceBytes > context.MAX_FOLD_SPAN_CHARS,
    "the peeked fold is not actually large");
  // PAST THE OLD REF CAP, through the real tool. 256 was the number, and a window of
  // many small entries reaches it long before it reaches any size bound, so the cap
  // refused the whole-window mark by counting rather than by cost.
  const many = makeFixture({
    sessionId: "many-refs", turns: 300, tools: false, chapterChars: 1_000,
    contextWindow: 100_000,
  });
  const manyRuntime = makeRuntime(many, {});
  await startRuntime(manyRuntime);
  // Read at `manualFoldCandidate`, which is exactly where the cap used to throw "Folds may
  // include at most 256 exact source references", and which every span-naming verb goes
  // through. The tool call that used to drive this is gone with `fold`, and `reboundary`
  // is not a substitute here: it refuses this span on SIZE, at 1.1MB, which is a different
  // and still-live bound. Proving a deleted cap at the function that enforced it is the
  // stronger reading anyway, since it covers every caller rather than the one driven.
  assert.equal(context.ACTIVE_CONTEXT_POLICY.maxFoldSourceRefs, undefined);
  const manyRefCount = context.manualFoldCandidate(
    many.snapshot, context.emptyActiveContextState(many.sessionId),
    [many.turnEntries[0][0], many.turnEntries[250].at(-1)],
  ).sourceRefs.length;
  assert(manyRefCount > 256,
    `The span names ${manyRefCount} exact refs, so it never reached the old 256 cap`);

  const slice = await toolCall(manual,
    { action: "peek", id: committedId, offset: 200, bytes: 2_048 });
  assert.equal(slice.details.view, "slice", "a narrow read did not come back as a slice");
  assert(slice.details.returnedBytes <= 2_048,
    `a narrow read returned ${slice.details.returnedBytes} bytes against a 2,048 ask`);
  assert(slice.details.nextOffset > slice.details.offset,
    "a slice of a large fold offers no way to continue reading");

  return {
    foldSpanCap: context.MAX_FOLD_SPAN_CHARS,
    ladderChapters: chapters.length,
    largestLadderChapter: Math.max(...chapters.map((fold) => fold.sourceChars)),
    agentSpanChars: spanChars,
    agentSpanTurns: 10,
    chapterTurnCap: context.ACTIVE_CONTEXT_POLICY.maxChapterTurns ?? null,
    chapterCharCap: context.ACTIVE_CONTEXT_POLICY.maxChapterChars ?? null,
    foldSourceRefCap: context.ACTIVE_CONTEXT_POLICY.maxFoldSourceRefs ?? null,
    widestAgentMarkRefs: manyRefCount,
    agentRecutFolds: folded.details.created.length,
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
  // THE WEDGE THRESHOLD IS THE FOLD FLOOR (Shane, 2026-08-21). It was
  // MAX_WEDGE_ABSORB_TOKENS, a separate 256-token constant, and there is no reason for
  // a second number: a gap that could stand as a fold on its own is left for the ladder
  // to take on its own terms, and a gap that could not has no business staying raw.
  assert.equal(context.MAX_WEDGE_ABSORB_TOKENS, undefined,
    "The wedge still has a threshold of its own");
  const floor = context.DEFAULT_THRESHOLDS.minFoldChars;
  const built = makeFixture({
    turns: 20, tools: false, chapterChars: 40, contextWindow: 100_000,
    thresholds: context.DEFAULT_THRESHOLDS,
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
  assert(absorbed.absorbed[0].chars < floor,
    `A ${absorbed.absorbed[0].chars}-char wedge was absorbed against a ${floor}-char floor`);
  assert.equal(absorbed.absorbed[0].threshold ?? floor, floor);
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
    turns: 20, tools: false, chapterChars: 4_000, contextWindow: 100_000,
    thresholds: context.DEFAULT_THRESHOLDS,
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
  const gapChars = context.spanBytes(wide.snapshot, wide.snapshot.mapped.findIndex((item) =>
    item.ref?.entryId === wide.turnEntries[1][0]),
  wide.snapshot.mapped.findIndex((item) => item.ref?.entryId === wide.turnEntries[4][0]));
  assert(gapChars > floor,
    `The deliberate gap is only ${gapChars} chars against a ${floor}-char floor; ` +
    "it does not test the threshold");
  for (let commit = 0; commit < 5; commit += 1) {
    const attempt = context.absorbWedgeMarks({
      snapshot: wide.snapshot, state: wideState, charsPerToken: 4,
    });
    assert.deepEqual(attempt.absorbed, [],
      `A deliberate ${gapChars}-char gap was absorbed on commit ${commit}`);
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
    thresholdChars: floor,
    absorbedSlivers: absorbed.absorbed.length,
    absorbedChars: absorbed.absorbed[0].chars,
    deliberateGapChars: gapChars,
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
  const window = 56_000;
  const runtime = makeRuntime(
    makeFixture({ turns: 12, resultChars: 12_000, contextWindow: window }),
    { ...SEALED_SPINE, providerInputBudget: servingBudget(window) },
  );
  await startRuntime(runtime);
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, window - Math.floor(window * 0.1));
  const armed = (await toolStatus(runtime)).details.automatic.recovery.rollback;
  assert.equal(armed.armed, true, `The lane refused to arm: ${JSON.stringify(armed.probeFailures)}`);
  assert.deepEqual(armed.probeFailures, []);

  // Calibrate against the fixture's own size, then climb to rep13's position: measured
  // occupancy just under the budget with one ordinary inflow step still to come.
  const baseline = bytesOf((await project(runtime)).messages);
  await measure(runtime, Math.round(baseline / 4), window);
  for (const tokens of [41_200, 45_300, 48_800, 49_700]) {
    await measure(runtime, tokens, window);
    await project(runtime);
  }

  // THE ROLLBACK. The provider rejected the request the runtime believed was sendable.
  // pi turns that into an error entry, strips it from agent state and asks to compact;
  // this lane answers by moving the session leaf back past it instead.
  const leafBefore = runtime.ctx.sessionManager.getLeafId();
  const beforeRollback = runtime.appended.length;
  const result = await overflow(runtime);
  assert.deepEqual(result, { cancel: true }, "Pi's summarizer must never run on the overflow path");
  const errorEntry = runtime.abandoned.find((entry) => entry.message?.stopReason === "error");
  assert(errorEntry, "The rejected entry did not leave the branch");
  // The leaf lands on the rejected entry's parent. This runtime's own event stream
  // appends after that, advancing the leaf again, so what gets asserted is the position:
  // the parent is back on the branch and everything past it is telemetry of ours.
  assert(!runtime.branch.some((entry) => entry.id === errorEntry.id),
    "The rejected entry is still on the live branch");
  assert.notEqual(errorEntry.id, leafBefore === null ? "" : leafBefore);
  const parentAt = runtime.branch.findIndex((entry) => entry.id === errorEntry.parentId);
  assert(parentAt >= 0, "The rollback target is not on the branch");
  assert(runtime.branch.slice(parentAt + 1).every((entry) =>
    entry.customType === "pi-fold-context-event"),
  "The rollback left conversation entries past the leaf it moved to");

  // LINEAGE. The label is applied BEFORE the branch, so it rides the abandoned path.
  assert.equal(runtime.labels.length, 1, "The abandoned path carries no lineage label");
  assert.equal(runtime.labels[0].entryId, errorEntry.id);
  assert.match(runtime.labels[0].label, /overflow rollback$/);
  assert(runtime.abandoned.some((entry) => entry.id === runtime.labels[0].id),
    "The lineage label landed on the surviving branch instead of the abandoned one");

  // THE NOTICE, once. Steering drains one at a time, so a second would never arrive.
  assert.equal(runtime.steered.filter((item) =>
    String(item.message?.customType ?? "").endsWith("-overflow-recovery")).length, 1,
  "The recovery queued more than one steered message");
  const recoverySteer = runtime.steered.find((item) =>
    String(item.message?.customType ?? "").endsWith("-overflow-recovery"));
  assert.equal(recoverySteer.options.deliverAs, "steer");
  assert.equal(recoverySteer.message.customType, "pi-fold-active-context-overflow-recovery");
  assert.match(String(recoverySteer.message.content), /rolled the session back/);
  assert.match(String(recoverySteer.message.content), /reissued now/);

  const rollbackRecord = contextEvents(runtime, beforeRollback)
    .find((record) => record.kind === "context.rollback");
  assert(rollbackRecord, "The rollback was not recorded on the stream");
  assert.equal(rollbackRecord.trigger, "session_before_compact");
  assert.equal(rollbackRecord.armed, true);
  assert.equal(rollbackRecord.replayed, true);
  assert.equal(rollbackRecord.replay_skip_reason, null);
  assert.equal(rollbackRecord.error_entry_id, errorEntry.id);
  assert.equal(rollbackRecord.new_leaf_id, errorEntry.parentId);
  assert(rollbackRecord.entries_abandoned >= 1);
  assert(rollbackRecord.notice_chars > 0);
  assert.equal(rollbackRecord.probes_passed, true);

  // THE COMMIT, in the RETRIED pass and strictly before transmission. It is not run
  // synchronously inside the recovery: that would adjudicate a snapshot taken outside a
  // projection pass and then be evaluated again by the retry, which is two mutations.
  assert.equal(contextEvents(runtime, beforeRollback)
    .filter((record) => record.kind === "context.commit").length, 0,
  "The recovery committed synchronously instead of leaving it to the retried pass");
  const beforeRetry = runtime.appended.length;
  const retried = await project(runtime);
  await settle();
  const recoveryRecord = contextEvents(runtime, beforeRetry)
    .find((record) => record.kind === "context.recovery");
  assert(recoveryRecord, "The retried pass never ran the recovery lane");
  assert.equal(recoveryRecord.rollback_seq, rollbackRecord.seq,
    "The fold-side record does not join the rollback that caused it");
  const status = (await toolStatus(runtime)).details.automatic;
  assert.equal(status.recovery.pendingRejection, null, "The rejection was not cleared by recovery");
  assert.equal(status.recovery.rollback.last.replayed, true);
  // RECOVERY IS A CHANGE, NOT AN OPINION.
  //
  // RE-DERIVED 2026-08-10. This asserted `recovered === true` here, and `recovered` was
  // `!measured.over`: our own estimator answering the question the provider had just
  // answered differently. Measured 2026-08-10 (luna-20260810 pifold rep 2), that field
  // reported recovered twice on a window that had not moved a byte, and the run died
  // anyway. The verdict is derived from what the pass DID, and the two facts it derives
  // from ride the same record.
  //
  // RE-DERIVED AGAIN at the boundary build. The lane COMMITS now rather than marking, so
  // it can genuinely rebuild a smaller request; on this fixture it still rebuilds
  // nothing, because a three-turn tool-free window has nothing eligible to fold, and
  // that is the case the verdict has to get right. What retired with the mark-only lane
  // is the claim that the retry is byte-identical to the refused request: the loop used
  // to reproject on every mark and refresh the recorded size as a side effect, so the
  // two numbers agreed by construction rather than by measurement. They are taken at
  // different points and the record carries both.
  assert.equal(recoveryRecord.freed_tokens, 0,
    "The lane folded something, so this fixture no longer shows a pass that changed nothing");
  assert.equal(recoveryRecord.loop_reduced, false, "The lane reported a reduction it did not make");
  assert.equal(recoveryRecord.tokens_before, recoveryRecord.tokens_after,
    "The retried request changed size in a pass that folded nothing");
  assert.equal(status.recovery.last.recovered, false,
    "An unchanged request was reported as recovered from a provider rejection");
  const rebuiltTokens = Math.ceil(bytesOf(retried.messages) / status.projectionCharsPerToken);
  assert(rebuiltTokens <= budgetTokens || runtime.aborts >= 1,
    `A ${rebuiltTokens}-token request was rebuilt over a ${budgetTokens}-token budget`);
  const receipts = status.curation.receipts;
  const receipt = receipts.find((item) => item.kind === "overflow-recovery");
  assert(receipt, "The rollback was not receipted");
  assert.equal(receipt.recovered, false, "The window receipt claimed a rescue the stream did not");
  assert.match(String(receipt.note), /this pass made it no smaller/);
  assert.match(String(receipt.note), /is not a recovery/);

  // AND THE OTHER HALF OF THE VERDICT: A PASS THAT REALLY REBUILDS SAYS SO.
  //
  // The same lane on a window that is genuinely full of unfolded stale mass. The
  // recovery loop runs at fence pressure, folds, the request comes back smaller, and
  // only then is `recovered` true. Without this half, a runtime that reported recovered
  // false unconditionally would pass the honesty assertions above.
  const rebuilt = makeRuntime(
    makeFixture({ turns: 20, resultChars: 12_000, contextWindow: window }),
    { ...SEALED_SPINE, providerInputBudget: servingBudget(window) },
  );
  await startRuntime(rebuilt);
  // Measurement passes only: marks accumulate and no commit runs, so the rejection
  // arrives on a window nothing has folded yet.
  for (const tokens of [40_000, 44_000, 47_000, 49_000]) {
    await measure(rebuilt, tokens, window, undefined, "toolUse");
  }
  const rebuiltFrom = rebuilt.appended.length;
  await overflow(rebuilt);
  await project(rebuilt);
  await settle();
  const rebuiltRecovery = contextEvents(rebuilt, rebuiltFrom)
    .find((record) => record.kind === "context.recovery");
  assert(rebuiltRecovery, "The full window never ran the recovery lane");
  assert(rebuiltRecovery.rejected_tokens > rebuiltRecovery.tokens_after,
    `The retried request (${rebuiltRecovery.tokens_after}) is not smaller than the rejected one ` +
      `(${rebuiltRecovery.rejected_tokens})`);
  assert(rebuiltRecovery.freed_tokens > 0,
    `The pass rebuilt a smaller request and reported ${rebuiltRecovery.freed_tokens} tokens freed`);
  assert.equal(rebuiltRecovery.recovered, true,
    "A pass that folded the request down inside the budget did not report a recovery");
  const rebuiltReceipt = (await toolStatus(rebuilt)).details.automatic.curation.receipts
    .find((item) => item.kind === "overflow-recovery");
  assert(rebuiltReceipt, "The genuine recovery was not receipted");
  assert.equal(rebuiltReceipt.recovered, true);
  assert.match(String(rebuiltReceipt.note), /rollback was required/);

  // THE UNREPLAYABLE TAIL. A rolled-back tail with unanswered tool calls rolls back and
  // stops there: a user turn after an unsatisfied tool call is malformed for every
  // provider, so the notice goes to the human and nothing is steered.
  const orphan = makeRuntime(
    makeFixture({ turns: 8, tools: false, contextWindow: window }),
    { ...SEALED_SPINE, providerInputBudget: servingBudget(window) },
  );
  await startRuntime(orphan);
  await measure(orphan, 28_000, window);
  orphan.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "orphaned-call", name: "read", arguments: { path: "big.txt" } }],
    stopReason: "toolUse",
    timestamp: 8_500,
  }, "orphan");
  const orphanBefore = orphan.appended.length;
  await overflow(orphan);
  assert.equal(orphan.steered.length, 0, "An unreplayable tail still queued a retry");
  const orphanRecord = contextEvents(orphan, orphanBefore)
    .find((record) => record.kind === "context.rollback");
  assert(orphanRecord, "The unreplayable rollback was not recorded");
  assert.equal(orphanRecord.armed, true, "The rollback itself must still happen");
  assert.equal(orphanRecord.replayed, false);
  assert.match(String(orphanRecord.replay_skip_reason), /unanswered/);
  assert(orphan.labels.length === 1 && orphan.abandoned.some((entry) =>
    entry.message?.stopReason === "error"),
  "The rollback did not happen on the unreplayable path");
  assert.match(String(orphan.notifications.at(-1)?.message), /NOT reissued/);

  // REFUSE TO ARM. A pi whose session surface moved gets no rollback at all: the lane is
  // off, it says so on the stream and to the user, and the session behaves exactly as it
  // did before this build. Nothing silent, nothing half-performed.
  const mutilated = makeRuntime(
    makeFixture({ turns: 8, tools: false, contextWindow: window }),
    { ...SEALED_SPINE, providerInputBudget: servingBudget(window) },
  );
  delete mutilated.ctx.sessionManager.branch;
  mutilated.ctx.sessionManager.appendLabelChange = (only) => only;
  await startRuntime(mutilated);
  const disarmed = (await toolStatus(mutilated)).details.automatic.recovery.rollback;
  assert.equal(disarmed.armed, false, "A mutilated surface still armed the lane");
  assert.equal(disarmed.probeFailures.length, 2, JSON.stringify(disarmed.probeFailures));
  assert(disarmed.probeFailures.some((failure) => /branch is missing/.test(failure)));
  assert(disarmed.probeFailures.some((failure) => /appendLabelChange takes 1/.test(failure)));
  assert.match(String(mutilated.notifications.at(-1)?.message), /DISARMED/);
  await measure(mutilated, 28_000, window);
  const mutilatedBefore = mutilated.appended.length;
  await overflow(mutilated);
  const refusal = contextEvents(mutilated, mutilatedBefore)
    .find((record) => record.kind === "context.rollback");
  assert(refusal, "A disarmed lane failed silently");
  assert.equal(refusal.armed, false);
  assert.equal(refusal.replay_skip_reason, "lane-disarmed");
  assert.equal(refusal.probes_passed, false);
  assert.equal(mutilated.steered.length, 0);
  assert(mutilated.branch.some((entry) => entry.message?.stopReason === "error"),
    "A disarmed lane moved the leaf anyway");
  assert.match(String(mutilated.notifications.at(-1)?.message), /could not roll back/);

  // The probes are the version pin, and they are exact about what they demand.
  const probed = context.probeRollbackSurfaces({});
  assert.equal(probed.armed, false);
  assert.equal(probed.probes.length, 7);
  assert(probed.probes.every((probe) => probe.required));

  return {
    budgetTokens,
    entriesAbandoned: rollbackRecord.entries_abandoned,
    tokensRolledBack: rollbackRecord.tokens_rolled_back,
    noticeChars: rollbackRecord.notice_chars,
    steeredMessages: runtime.steered.length,
    rebuiltTokens,
    unchangedRequestRecovered: status.recovery.last.recovered,
    genuineRecoveryFreedTokens: rebuiltRecovery.freed_tokens,
    genuineRecoveryRecovered: rebuiltRecovery.recovered,
    replaySkipped: String(orphanRecord.replay_skip_reason).slice(0, 40),
    disarmedFailures: disarmed.probeFailures.length,
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
  // Wide enough that the pressure loop below leaves the agent a turn to fold. The
  // commits it drives take everything the class law offers now that no proportion holds
  // the tail back, so the fixture has to carry more than the commits will reach.
  const runtime = await epochToolRuntime({ turns: 26, resultChars: 6_000 });
  const built = runtime.built;
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  await toolCall(runtime, { action: "status" });
  await toolCall(runtime, { action: "status", detail: "fold_candidates" });
  // Two refusals, through the two verbs that still take names: a brief for a fold nobody
  // cut, and a re-cut of a span nobody has.
  await toolCall(runtime, { action: "brief", id: "no-such-entry", brief: "x" }).catch(() => undefined);
  await toolCall(runtime, { action: "reboundary", ids: ["also-missing"] }).catch(() => undefined);
  await agentBriefsCuts(runtime, 2);
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
  assert(failures.some((record) => /No pending fold no-such-entry/.test(record.error)),
    "The exact validation text was not kept verbatim");
  assert(attempts.some((record) => record.ok === true && record.error === null));
  assert(attempts.every((record) => /^[a-f0-9]{64}$/.test(record.arguments_sha256)));
  assert(attempts.some((record) => record.action === "brief"),
    "A brief did not reach the attempt stream");

  // Corrections are their own records, joined to their attempt by seq.
  // One turn held raw across the commit, so there is material in front of a standing fold
  // for the snap below to start from. The boundary commit is not depth-bounded and would
  // otherwise leave the window with no raw span anywhere.
  const snapHold = [...built.turnEntries[5]];
  await toolCall(runtime, { action: "pin", ids: snapHold });
  await runtimeCommit(runtime, { tokens: 94_000, contextWindow: 100_000 });
  // THE CORRECTION RECORD MOVES TO GATE 63, which owns re-boundary. It was produced by
  // `snapFoldCandidate` on the agent's `fold` path: a span that cut into a standing fold
  // was corrected to a valid edge and the correction reported by name. That path is
  // deleted with the verb, and the only remaining way to hand the runtime a span is
  // `reboundary`, whose snapping is gate 63's subject and whose fixture already holds it.
  // Driving it from here would mean rebuilding that fixture inside this one to reach a
  // record this gate does not otherwise care about: what this gate is for is the ENVELOPE,
  // the sequence, and that every kind the timeline needs is actually emitted.

  // The timeline is reconstructable: commits, the folds they created, projections, the
  // per-handoff prefix comparison, and the provider usage the analyst joins against.
  const kinds = new Set(stream().map((record) => record.kind));
  for (const kind of [
    "context.attempt", "context.commit", "context.fold",
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
    assert(record.cache_action === null || typeof record.cache_action === "string");
    assert(record.cache_action_seq === null || Number.isSafeInteger(record.cache_action_seq));
    assert.equal(typeof record.request_class, "string");
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
    Number.isSafeInteger(record.cache_write_tokens) &&
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
  const built = makeFixture({ turns: 8, resultChars: 12_000, contextWindow: 100_000 });
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
    // The dead carriers. Guidance dosage never spoke (voluntary fold share 0.00 across
    // eleven runs); the reminder shares and the round cap were superseded by the
    // threshold notices and the single last-call round; the milestone budgets went with
    // the delivery schedule they priced, leaving the `advisory` state field parseable
    // through its own milestone list.
    "GUIDANCE_PROFILES", "DEFAULT_GUIDANCE_PROFILE", "normalizeGuidanceProfile",
    "advisorySchedule", "milestoneText", "liveAdvisoryText", "updateAdvisoryMilestone",
    "recordAdvisoryDelivery", "clearArmedAdvisory", "advisoryState", "ADVISORY_BUDGETS",
    "CURATION_REMINDER_SHARES", "dueReminderIndex", "curationReminderText",
    "CURATION_GATE_MAX_ROUNDS", "advanceCurationGate", "curationNoticeText",
    "DEFAULT_SURFACING_ENABLED", "surfacingText",
    // The one-channel selector the two-channel one replaced: an overlap ratio scored
    // briefs alone, so it could only ever rank what the agent could already read.
    "rankSurfacingCandidates", "updateSurfacing", "taskTokenSet", "recentTaskText",
    "lexicalOverlap", "cooledDownIds", "acceptSurfacingSuggestion", "withSurfacingLog",
    "foldBriefCandidates", "FOLD_BRIEF_SUGGESTION_SOURCE", "collectSuggestionCandidates",
    "validSurfacingCandidate", "surfacingOrdinal", "surfacingKey", "resolvedSurfacingLog",
    "surfacingLog", "SURFACING_TOP_K", "SURFACING_MIN_SCORE", "SURFACING_CHAR_BUDGET",
    "SURFACING_COOLDOWN_ORDINALS", "SURFACING_LEXICAL_WEIGHT", "SURFACING_RECENCY_WEIGHT",
    "SURFACING_DEPTH_WEIGHT", "SURFACING_MAX_DEPTH", "SURFACING_MAX_TEXT_CHARS",
    "SURFACING_SOURCE_ID", "SURFACING_MAX_LOG_RECORDS", "SURFACING_RECENT_TASK_SPANS",
    "SURFACING_MAX_TASK_CHARS", "scoreSurfacingCandidate",
    // The two-channel BM25 selector and its ledger went 2026-08-14: the corpus held 86
    // surfacings with 7 taken, all seven on earlier builds, and a subsystem whose job is
    // to tell the model to reload what a brief omitted argues with the brief it rides on.
    // Recovery is pull-on-demand through peek/expand alone.
    "selectSurfacingSlate", "surfacingSlateText", "issueSurfacing", "noteSurfacingAction",
    "resolveSurfacing", "surfacingLedger", "surfacingSilenced", "surfacingCandidates",
    "buildSurfacingIndex", "bm25Score", "normalizedBm25", "surfacingIntentText",
    "surfacingHook", "surfacingProvenanceHit", "surfacingSuppressed", "withSurfacingLedger",
    "surfacingTokens", "distinctSurfacingTokens", "surfacingDocumentKey", "surfacingIdf",
    "surfacingScoreCeiling", "foldContentText", "toolCallIntent", "roundedScore",
    "validSurfacingRecord", "parseSurfacingLog", "SURFACING_MAX_LEDGER_RECORDS",
    "SURFACING_CONTENT_HIT", "SURFACING_BRIEF_HIT", "SURFACING_DIVERGENCE_MARGIN",
    "SURFACING_SLATE_SIZE", "SURFACING_OUTCOME_WINDOW_ORDINALS", "SURFACING_IGNORE_LIMIT",
    "SURFACING_PROVENANCE_TERMS", "SURFACING_INTENT_CHARS", "SURFACING_BM25_K1",
    "SURFACING_BM25_B", "MAX_SURFACING_LINE_BYTES", "STATUS_DIET_SUGGESTIONS",
  ]) {
    assert.equal(context[name], undefined, `${name} survived the collapse`);
  }
  // What the deletions had to LEAVE standing: the `advisory` state field is written into
  // every state and covered by the state digest, so its vocabulary stays and every sealed
  // run keeps materializing. Its per-milestone CEILING does not stay: sixteen bounded a
  // counter no code path increments, so it could only ever have refused a state this
  // runtime cannot write. The shape checks around it are what actually validate the field.
  //
  // Reopened and closed again 2026-08-13. The field is genuinely inert: nothing writes it,
  // `highWater` stays 0, `delivered` stays empty and `armed` is never set on any path. The
  // obvious repair is to delete it and have the digest keep digesting the constant, and
  // that does not work, because `stableStringify` walks a record in its OWN key order
  // rather than sorting. Re-adding the constant with a spread puts it LAST, which happens
  // to match a state that carries nothing after it and stops matching the moment one
  // carries `notices`: sol-20260812 rep 9 replays to revision 451 today and dies at
  // revision 6 that way. Preserving the digest therefore means reproducing a historical key
  // LAYOUT inside the digest function, which is more mechanism, and more fragile mechanism,
  // than the thirty bytes per state entry it would remove. The field stays until a digest
  // version bump is happening for another reason.
  assert.deepEqual([...context.ADVISORY_MILESTONES],
    ["orientation", "notice", "tools", "chapters", "urgent"]);
  assert.equal(context.MAX_ADVISORY_DELIVERIES_PER_MILESTONE, undefined,
    "A ceiling came back on a delivery counter nothing increments");
  assert.equal(context.validAdvisoryState({ highWater: 0.4, delivered: { notice: 2 } }), true);
  assert.equal(context.validAdvisoryState({ highWater: 0.4, delivered: { notice: -1 } }), false,
    "The advisory shape checks went with the ceiling");
  assert.equal(context.validAdvisoryState({ highWater: 0.4, delivered: { nonsense: 2 } }), false,
    "An unknown milestone parsed as valid advisory state");
  // The pressure rung no live reader consulted. The band's maxTarget is the trigger.
  assert.equal(context.ACTIVE_CONTEXT_POLICY.warningRatio, undefined);

  // And the behaviour is on, in a runtime that configures nothing at all. The epoch is
  // driven to its commit, because a mark moves no bytes and this gate reads the folds.
  const plain = makeRuntime(built, {});
  await startRuntime(plain);
  await measureAndCommit(plain, 80_000, 100_000, "collapse-commit");
  const status = (await toolStatus(plain)).details.automatic;
  assert.equal(Object.hasOwn(status, "warningRatio"), false,
    "The status block still reports a warning rung");
  assert.equal(Object.hasOwn(status, "surfacing"), false,
    "The status block still reports the deleted surfacing subsystem");
  assert.equal(status.instrumentation.enabled, true, "Projection instrumentation is not unconditional");
  assert.equal((await toolStatus(plain)).details.index, "diet", "The status index diet is not unconditional");
  const properties = [...plain.tools.values()][0].parameters.properties;
  // Peek is APPEND-ONLY, so the arguments that steered its RECLAMATION are gone
  // from the surface entirely rather than collapsed to a default. ephemeral
  // RETURNED 2026-08-20 (Build 4b, gate 139) as a DIFFERENT lever: the
  // iteration-2 parameter steered reclamation timing and stays dead with
  // retain; the returned one is a projection-visibility contract (one read,
  // the reply the surviving trace) that never touches the reclaimer, and its
  // own gate owns it. The lever collapse still holds: no knob steers
  // reclamation.
  assert.equal(properties.retain, undefined, "retain survived the peek reclamation cut");
  assert.equal(properties.ephemeral?.type, "boolean",
    "the ephemeral visibility contract left the peek surface");
  // `marks` is gone with the `fold` verb it batched. The lever collapse's claim is that no
  // KNOB steers reclamation, and a deleted argument is one fewer lever, so it is asserted
  // absent by name rather than quietly dropped from the list.
  assert.equal(properties.marks, undefined, "The batched-mark array survived the fold verb");
  assert.equal(properties.brief?.type, "string", "The brief argument left the surface");
  const actions = [...properties.action.enum];
  assert(actions.includes("reboundary"),
    "The correction verbs are not on the immediate surface");
  const folds = materialized(plain).folds.filter((fold) => fold.kind === "tool-result");
  assert(folds.length >= 1, "The collapse fixture folded nothing");
  assert(/path=/.test(folds[0].brief), "Stage-identified briefs are not unconditional");
  // Capacity is truthful once the deployment declares its window, and says which mode.
  assert.equal(status.capacity.mode, "descriptor");
  const declared = makeRuntime(built, { providerInputBudget: 383_616 });
  await startRuntime(declared);
  assert.equal((await toolStatus(declared)).details.automatic.capacity.mode, "truthful");

  // What stays configurable is exactly the experiment conditions plus the one fact.
  assert.throws(() => makeRuntime(built, { providerInputBudget: -1 }).tools,
    /providerInputBudget must be a positive integer/);
  // The scheduling collapse, pinned the same way: epoch is the only scheduler, peek
  // results are foldable, and the action surface is whole. A deployment still passing
  // one of the three deleted options is REFUSED by name rather than quietly handed the
  // opposite behavior.
  // The dead surfacing channel is refused the same way: projection candidates are what
  // registration RETURNS, and an external suggestion source has no carrier to render
  // into, so a host that still passes either one is told rather than quietly ignored.
  for (const [option, value] of [
    ["foldScheduling", "epoch"], ["foldScheduling", "immediate"],
    ["foldPeekResults", false], ["foldPeekResults", true],
    ["toolActions", ["status", "peek"]],
    ["setProjectionProvider", () => {}],
    ["setSuggestionSourceRegistrar", () => {}],
  ]) {
    assert.throws(() => makeRuntime(built, { removedOptions: { [option]: value } }).tools,
      new RegExp(`${option} is no longer an option`),
      `${option} was accepted after its deletion`);
  }
  assert.deepEqual(Object.keys(makeRuntime(built, {}).registration), ["projectionCandidates"]);
  assert.equal(context.DEFAULT_GUIDED_CURATION, undefined);
  assert.equal(context.FOLD_SCHEDULING_MODES, undefined);
  assert.equal(context.DEFAULT_FOLD_SCHEDULING, undefined);
  assert.equal(context.EPOCH_ACTIVE_CONTEXT_TOOL_ACTIONS, undefined);
  assert.equal(context.READ_ONLY_CONTEXT_ACTIONS_DEFAULT, undefined);

  return {
    collapsedOptions: collapsed.length,
    survivingConstants: 0,
    deadCarriersDeleted: 19,
    advisoryStateFieldKept: true,
    surfacingDeleted: true,
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
  await agentBriefsCuts(runtime, 10);
  const marked = (await toolStatus(runtime)).details.automatic.scheduling;
  // The rep-15 shape needs a marked pile large enough that the DELETED eligible-share
  // arm would have fired on it. That arm sat at 0.30 of the freed share, so the
  // precondition is stated as the literal it used to read, and the point of the gate is
  // that nothing fires on it now: the band top is the only trigger there is.
  assert.equal(context.EPOCH_ELIGIBLE_SHARE_COMMIT_THRESHOLD, undefined,
    "The eligible-share commit arm survived");
  assert(marked.eligibleFreedBudgetShare >= 0.30,
    `The replay needs mass the retired eligible-share arm would have fired on; it carried ${
      marked.eligibleFreedBudgetShare}`);

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
      /-(curation|advisory|milestone)$/.test(message.customType)),
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
  // ONE DEEP EVENT PER CYCLE IS GONE (Shane, 2026-08-22): "if it's over we fold". Over
  // the threshold, every pass commits, and the reclaim floor is what stops it rather than
  // a counter. The quiet property this gate is named for is unchanged and asserted below:
  // BELOW the threshold, nothing fires at all.
  const afterGate = commits().length;
  assert(afterGate >= 1, "The crossing produced no commit");
  const commit = commits()[0];
  assert(commit.applied_marks >= 5,
    `The commit applied ${commit.applied_marks} marks; it was not a deep event`);

  // Quiet again once occupancy falls back below the threshold.
  await measure(runtime, 40_000, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  assert.equal(commits().length, afterGate, "The runtime kept folding below the threshold");

  // The retune itself, and the parts of the thermostat that did NOT move. The two
  // occupancy constants are fields of the declared object now; their values are the
  // proven ones, unchanged.
  // 0.80 held at the retune (Shane 2026-08-23) on the corpus reading: across 19 mature
  // sealed runs the peak occupancy lands a median 36,000 tokens ABOVE the trigger, so
  // this share already puts the top of the band at 237,399 of a 251,520 budget, and
  // raising it toward that number directly would push the median peak into the fence.
  assert.equal(context.DEFAULT_THRESHOLDS.maxTarget, 0.80);
  // 0.20 (Shane 2026-08-28, on the sol-20260826-full2 verdict). It went to 0.40 on
  // 2026-08-23 to seat the floor near where commits land, and came back when the campaign
  // priced the cadence: the commit rewrite tax is minTarget / (maxTarget - minTarget),
  // 1.0 at 0.80/0.40 against 0.33 at 0.80/0.20, and every fold repetition from 3 onward
  // ran the shallower floor.
  assert.equal(context.DEFAULT_THRESHOLDS.minTarget, 0.20);
  // THE KNOWN LIMIT, ASSERTED RATHER THAN AVOIDED. The 0.40 default was partly chosen to
  // sit above MAX_PINNED_SHARE so a fully pinned session could reach the aim; 0.20 does
  // not, and that is the accepted state rather than an oversight. MAX_PINNED_SHARE is 0.25,
  // so a fully pinned session legally holds more than the aim asks for and the commit
  // stops short of it by construction rather than by fault. Pinned here so that moving
  // the aim back above the cap has to confront this note, and so that the shortfall is
  // known rather than discovered: the epoch reports targetBudgetShare beside
  // actualFreedBudgetShare, which is where an unreachable aim shows up as a stated fact.
  assert(context.DEFAULT_THRESHOLDS.minTarget < context.MAX_PINNED_SHARE,
    "The aim moved above the pinned-share cap again; the note beside it is now stale");
  assert.equal(context.COMMIT_RECLAIM_FLOOR_SHARE, 0.02);

  // Plain epoch scheduling is unchanged: the cadence trigger is the guided-mode deletion.
  const plain = makeRuntime(
    makeFixture({ turns: 20, resultChars: 14_000, contextWindow: 100_000 }),
    { ...SEALED_SPINE },
  );
  await startRuntime(plain);
  await agentBriefsCuts(plain, 10);
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
    // The live shape: a 272,000-token per-request descriptor over a deployment that
    // actually serves 383,616 input tokens. Declared already net, which is why nothing
    // downstream subtracts a reservation out of it a second time.
    providerInputBudget: 383_616,
  });
  await startRuntime(runtime);
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // Line one of the stream states the resolved budget.
  const capacity = stream().find((record) => record.kind === "context.capacity");
  assert(capacity, "The run never stated its resolved serving budget");
  assert.equal(capacity.mode, "truthful");
  assert.equal(capacity.window_tokens, 383_616);
  assert.equal(capacity.budget_tokens, 383_616);
  assert.equal(capacity.output_reservation ?? 0, 0,
    "A declared input budget must not be netted down a second time");
  assert.equal(capacity.descriptor_window, 272_000);

  await measure(runtime, 180_000, 272_000, undefined, "toolUse");
  await project(runtime);
  await measure(runtime, 330_000, 272_000, undefined, "toolUse");
  const announced = await project(runtime);
  await settle();
  await measureAndCommit(runtime, 331_000, 272_000, undefined, "toolUse");

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
  assert.equal(commitRecord.window_tokens, 383_616);
  // The receipt is the ONE carrier left, and it quotes the same truthful budget the
  // stream does. Nothing in the window may quote the per-request descriptor.
  const projected = json.stableStringify(announced.messages);
  assert.equal(/255616/.test(projected), false,
    "The projection quoted the descriptor budget instead of the serving budget");

  // The status surface reads the same source.
  const status = (await toolStatus(runtime)).details.automatic;
  assert.equal(status.capacity.budgetTokens, 383_616);
  assert.equal(status.capacity.descriptorWindow, 272_000);

  return {
    mode: capacity.mode,
    budgetTokens: capacity.budget_tokens,
    descriptorWindow: capacity.descriptor_window,
    budgetedRecords: budgeted.length,
  };
}

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
  const block = context.receiptBlockText({ receipts: [receipt], toolName: "pi_fold_context" });
  assert.match(block, /"action":"reboundary"/);
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
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 1, "The frontier cut nothing to commit");
  const marked = await briefCut(runtime, cuts[0],
    "An early completed task stays exactly recoverable behind this fold.");
  assert.equal(marked.details.action, "brief");

  // Climb past the pressure backstop and up to the fence RATIO, but stay under the
  // serving budget: crowded and predicted-unsafe, yet perfectly able to send.
  for (const tokens of [345_000, 355_000, 365_000, 375_000]) {
    await measureAndCommit(runtime, tokens, 400_000, undefined, "toolUse").catch(() => undefined);
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

  // A request whose projection exceeds the provider input budget is rejected outright,
  // so recovery must produce a window that fits: a projection past the serving budget
  // recovers, whatever it frees.
  const overflow = makeRuntime(
    makeFixture({ turns: 16, resultChars: 12_000, contextWindow: 60_000 }),
    {},
  );
  await startRuntime(overflow);
  await measureAndCommit(overflow, 55_000, 60_000, undefined, "toolUse").catch(() => undefined);
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
      /-(curation|advisory|milestone)$/.test(message.customType)),
    false,
    "A pre-commit guidance carrier reached the projection",
  );

  const digest = async () => json.stableStringify((await project(runtime)).messages);
  const before = await digest();

  // A BRIEF, which is the only edit the agent has that could plausibly move a byte and
  // must not: the fold it names is pending, so its words are stored outside the window.
  const briefedIds = await agentBriefsCuts(runtime, 2);
  const marked = { details: { ok: briefedIds.length === 2 } };
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
  // The ids appear in exactly one place, the ephemeral notice that asks for briefs, since
  // the agent cannot name a fold to brief it otherwise. Everywhere else the window holds
  // no trace of a pending mark, which is the claim.
  const pending = await frontierCuts(runtime);
  assert(pending.length >= 2);
  const noticeless = json.stableStringify(JSON.parse(before)
    .filter((message) => message?.customType !== "pi-fold-active-context-fold-notice"));
  for (const mark of pending) {
    assert.equal(noticeless.includes(mark.id), false,
      `Pending mark ${mark.id} was rendered into the window outside the notice`);
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
  // A ROOT, because one epoch can now build a parent as well as its children and a
  // nested child is behind its parent's placeholder by design; what the projection owes
  // is the forest read from its roots.
  assert(materialized(runtime).folds.length >= 1);
  const rootFold = materialized(runtime).folds.find((fold) => fold.parentId === null);
  assert(rootFold && after.includes(rootFold.id),
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
        name: "pi_fold_context",
        arguments: { action: "status", detail: "folds", offset: turn * 40, limit: 40 },
      }],
      stopReason: "toolUse",
      timestamp: sequence,
    });
    statusResultIds.push(add({
      role: "toolResult",
      toolCallId: `status-${turn}`,
      toolName: "pi_fold_context",
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
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  for (const tokens of [76_000, 80_000, 84_000, 88_000, 92_000]) {
    await measure(runtime, tokens, 100_000);
    await project(runtime);
  }
  const allFoldIds = materialized(runtime).folds.map((fold) => fold.id).sort();
  assert(allFoldIds.length >= 10, "The fixture built too few folds to force paging");

  // Every detail variant fits the cap, and the marker appears on every truncated page.
  const measured = {};
  let receiptTrimSeen = 0;
  for (const detail of [undefined, "fold_candidates", "tree", "folds", "objects"]) {
    const result = await toolStatus(runtime, "pi_fold_context", detail);
    const delivered = Buffer.byteLength(result.content[0].text, "utf8");
    assert(delivered <= context.CONTEXT_STATUS_RESPONSE_BYTES,
      `status detail=${detail ?? "default"} delivered ${delivered} bytes over the cap`);
    assert.equal(typeof result.details.continuation, "string",
      `status detail=${detail ?? "default"} truncated without a continuation marker`);
    assert.equal(result.details.continuation.includes("\n"), false,
      "The continuation marker is not one line");
    // A trimmed receipt row has no page, and the continuation must never point
    // at one: "full lists stay reachable" beside dropped receipt rows sent the
    // agent to a page that does not exist.
    if (result.details.continuation.includes("receipt row(s)")) {
      receiptTrimSeen += 1;
      assert(result.details.continuation.includes("the trimmed rows have no page"),
        `detail=${detail ?? "default"} trimmed receipt rows without saying they have no page`);
      assert.equal(result.details.continuation.includes("full lists stay reachable"), false,
        `detail=${detail ?? "default"} claimed full reachability over trimmed receipt rows`);
    }
    measured[detail ?? "default"] = delivered;
  }
  assert(receiptTrimSeen > 0,
    "No page trimmed receipt rows, so the no-page wording was never exercised");

  // Paging through the continuation offsets yields every fold id exactly once, for
  // both fold listings; the object listing pages completely the same way.
  // Each walk is kept: paging a listing to its end is the expensive part of this claim,
  // and the return value below used to walk both listings a SECOND time purely to report
  // their page counts.
  const walks = {};
  for (const detail of ["folds", "tree"]) {
    const { rows, pages } = walks[detail] = await pagedStatusRows(runtime, detail);
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
    const result = await toolStatus(small, "pi_fold_context", detail);
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
    foldPages: walks.folds.pages.length,
    treePages: walks.tree.pages.length,
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
    { status: ["action", "detail", "offset", "limit"],
      peek: ["action", "id", "offset", "bytes", "ephemeral"] },
  );
  const pagedShape = { action: "status", detail: "folds", offset: 40, limit: 40 };
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", pagedShape), true,
    "The advertised paged status call still classifies unsafe");
  // The peek half of the same class, found by the 2026-08-20 Build 4 scoping pass:
  // offset and bytes are advertised on the peek surface (the narrowing menu a
  // truncated peek explicitly offers), and before this build a narrowed or paged
  // peek carried an argument outside the allowlist, classified unsafe, and missed
  // the reclaimer exactly as the detail-carrying status shape once did.
  assert.equal(
    context.isAutoFoldableToolCall(
      "pi_fold_context", { action: "peek", id: "fold_probe", offset: 12_000, bytes: 4_096 }),
    true,
    "The advertised narrowed peek call still classifies unsafe");
  assert.equal(
    context.isAutoFoldableToolCall(
      "pi_fold_context", { action: "peek", id: "fold_probe", offset: 12_000, expand: true }),
    false,
    "An argument outside the peek surface classified as ladder food");
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { action: "status", detail: "tree" }), true);
  // Classification is allowlist-driven: one argument outside the surface and the
  // batch is unsafe, which is exactly how the detail-carrying shape was rejected
  // before 'detail' joined the list above.
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { ...pagedShape, verbose: true }), false);

  // The batch scanner agrees end to end: the status-with-detail batch is validated.
  // The trailing turns carry real mass so the fresh-byte tail ends inside them and
  // the status result is genuinely stale.
  const built = makeStatusResultFixture({
    statusTurns: 1,
    statusChars: 30_000,
    trailingTurns: 8,
    trailingChars: 4_000,
    contextWindow: 100_000,
  });
  const scanned = context.scanTurnToolBatches(built.messages, { start: 0, end: 4 });
  assert(scanned && scanned.calls.length === 1 && scanned.unsafeIndices.size === 0,
    "The status-with-detail batch did not validate read-only-safe");

  // Once stale, the automatic tool rung selects and folds it.
  const state = context.emptyActiveContextState(built.sessionId);
  const candidate = context.selectAutomaticToolBatch(built.snapshot, state)[0];
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
    trailingTurns: 8,
    trailingChars: 8_000,
    contextWindow: 100_000,
  }));
  await startRuntime(runtime);
  // A climb that crosses the commit trigger more than once: one structural mutation per
  // handoff, so the stale status result may not be the first thing an epoch reaches.
  for (const tokens of [80_000, 88_000, 60_000, 84_000, 88_000]) {
    await measureAndCommit(runtime, tokens, 100_000);
  }
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
 * Turns whose tool the deployment BLACKLISTED, so no tool rung may claim their results
 * and the chapter encoding must inline them whole: this is the shape whose closed unit
 * can exceed the bite-size bound, exactly how rep 19's status units encoded to 146k-331k
 * chars before this build. It took no blacklist to produce before 2026-08-10, when an
 * unlisted tool was one the ladder could not fold; a blacklisted tool is the only way
 * left to build the shape, which is the whole cost of naming one.
 */
function makeOpaqueToolFixture({
  sessionId,
  resultSizes,
  contextWindow = 400_000,
  blacklisted = true,
}) {
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
    sessionId,
    eventMessages: messages,
    contextEntries: entries,
    policy: {},
    contextWindow,
    ...(blacklisted ? { blacklistAutoFoldTools: new Set(["bash"]) } : {}),
  });
  return { sessionId, entries, messages, snapshot };
}

async function gateNoPermanentlyUnfoldableUnit() {
  // One closed unit bigger than the whole chapter cap. Before this build the
  // selector broke on the cap BEFORE its single-unit acceptance, so the biggest
  // span in the window was exactly the one thing no automatic rung could reclaim.
  // Two units: the oversized one this gate is about, and a second so the projection
  // reaches past the 0.10 fresh tail and the giant is genuinely stale.
  const giant = makeOpaqueToolFixture({
    sessionId: "giant-unit", resultSizes: [140_000, 140_000],
  });
  // THE CHAPTER CAP IS DELETED (Shane, 2026-08-22). `maxChapterChars` 128,000 sat above
  // MAX_FOLD_SPAN_CHARS 16,000 in the same monotonically growing walk, so the smaller
  // bound always broke first and the larger one never fired. What is left is the one
  // bound that does the work, and the single-unit acceptance that lets a unit past it.
  assert.equal(giant.snapshot.policy.maxChapterChars, undefined,
    "the chapter cap is still declared");
  const units = context.chapterUnits(giant.snapshot);
  const state = context.emptyActiveContextState(giant.sessionId);
  const candidate = context.selectAutomaticChapter(giant.snapshot, state);
  assert(candidate, "The oversized unit left the chapter rung with nothing to select");
  const encoded = context.encodedFoldSource(giant.snapshot, state, candidate.parts, "chapter");
  assert(Buffer.byteLength(encoded, "utf8") > context.MAX_FOLD_SPAN_CHARS,
    "The fixture unit is not actually above the bite-size bound");
  // A single unit, exactly: every source ref lies inside one closed unit's range.
  const indices = candidate.sourceRefs.map((ref) =>
    giant.snapshot.mapped.findIndex((item) => item.ref?.entryId === ref.entryId));
  const unit = units.find((item) => indices.every((index) =>
    index >= item.start && index < item.end));
  assert(unit, "The oversized candidate spans more than one closed unit");
  // It folds whole. Nothing bite-sizes it: the splitter is deleted (2026-08-22) and it
  // never ran on the ladder's own candidates anyway, since `selectAutomaticChapter`
  // stops accumulating at the cap by itself. The single-unit acceptance below the cap
  // check is what keeps the biggest span in the window from being the one thing no rung
  // can reclaim, which is this gate's whole subject.
  assert.equal(context.splitCandidateBySize, undefined,
    "the manual splitter is back, and it would cut this unit no rung could re-cut");
  const committed = await commitCandidate(state, giant.snapshot, candidate);
  assert.equal(committed.state.folds.length, 1);
  assert.equal(committed.state.folds[0].kind, "chapter");
  const before = bytesOf(context.projectActiveContext(giant.snapshot, state));
  const after = bytesOf(context.projectActiveContext(giant.snapshot, committed.state));
  assert(before - after >= 140_000 * 0.9,
    `Folding the oversized unit freed only ${before - after} bytes`);

  // Composition keeps its caps: over inline units the selector still builds
  // multi-unit chapters, and a composed chapter never exceeds the bite-size bound,
  // Only the single closed unit may exceed it.
  // Twelve units on a 100,000-token window: the 0.10 fresh tail protects 36,000 bytes
  // of the 90,000-token budget, so the fixture has to carry enough past it for the
  // selector to compose at all. Composition, not tail size, is what this asserts.
  const multi = makeOpaqueToolFixture({
    sessionId: "multi-unit",
    resultSizes: Array.from({ length: 12 }, () => 5_000),
    contextWindow: 100_000,
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
  const multiIndices = multiCandidate.sourceRefs.map((ref) =>
    multi.snapshot.mapped.findIndex((item) => item.ref?.entryId === ref.entryId));
  const multiUnits = context.chapterUnits(multi.snapshot).filter((item) =>
    multiIndices.some((index) => index >= item.start && index < item.end));
  assert(multiUnits.length >= 2, "The cap check collapsed composition to single units");

  // The same transcript with the tool NOT blacklisted, which is every deployment's
  // default: the oversized unit never reaches the chapter rung as 140k of inline bytes at
  // all, because the tool rung claims the result directly and the chapter encoding carries
  // a brief in its place. Both halves say the same thing, which is this gate's name: there
  // is no closed unit the automatic law cannot reclaim by SOME rung.
  const unlisted = makeOpaqueToolFixture({
    sessionId: "giant-unlisted", resultSizes: [140_000, 140_000], blacklisted: false,
  });
  const unlistedState = context.emptyActiveContextState(unlisted.sessionId);
  const [unlistedCandidate] = context.selectAutomaticToolBatch(unlisted.snapshot, unlistedState);
  assert(unlistedCandidate, "The oversized result was unreachable once the blacklist was empty");
  assert.equal(unlistedCandidate.kind, "tool-result");
  const unlistedCommitted = await commitCandidate(unlistedState, unlisted.snapshot, unlistedCandidate);
  const unlistedBefore = bytesOf(context.projectActiveContext(unlisted.snapshot, unlistedState));
  const unlistedAfter = bytesOf(context.projectActiveContext(unlisted.snapshot, unlistedCommitted.state));
  assert(unlistedBefore - unlistedAfter >= 140_000 * 0.9,
    `Folding the oversized result freed only ${unlistedBefore - unlistedAfter} bytes`);

  return {
    chapterCharCap: giant.snapshot.policy.maxChapterChars ?? null,
    foldSourceRefCap: giant.snapshot.policy.maxFoldSourceRefs ?? null,
    oversizedUnitBytes: Buffer.byteLength(encoded, "utf8"),
    freedBytes: before - after,
    multiUnitChapterBytes: Buffer.byteLength(multiEncoded, "utf8"),
    multiUnitCount: multiUnits.length,
    unlistedToolRung: "tool-result",
    unlistedFreedBytes: unlistedBefore - unlistedAfter,
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
    seed, epochSnapshot(probe), context.selectAutomaticToolBatch(epochSnapshot(probe), seed)[0],
    { brief: "The exact stale inspection result stays recoverable behind this fold." },
  )).prepared.id;
  const built = makeFixture({
    turns: 12, resultChars: 12_000, contextWindow: 100_000, peekTurns: [3], peekTargetId: foldId,
  });
  const snapshot = epochSnapshot(built);
  const state = (await commitCandidate(
    context.emptyActiveContextState(built.sessionId), snapshot,
    context.selectAutomaticToolBatch(snapshot, context.emptyActiveContextState(built.sessionId))[0],
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
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);

  // Exercise every lane that used to render something: status, a refused call, a peek,
  // a batched mark, and a long occupancy climb that crosses the commit trigger twice.
  await toolCall(runtime, { action: "status" });
  await toolCall(runtime, { action: "peek", id: "no-such-fold" }).catch(() => undefined);
  await agentBriefsCuts(runtime, 3);
  for (const tokens of [40_000, 56_000, 68_000, 76_000, 82_000, 88_000, 60_000, 72_000, 84_000]) {
    await measureAndCommit(runtime, tokens, 100_000, undefined, "toolUse");
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
    /-(curation|advisory|milestone)$/.test(message.customType));
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
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.fired, "The window-pressure commit never fired");

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
  // The pin must hold an expanded fold against the refold rung after the lease runs
  // out, hold entries out of commits, release on unpin, land on the event stream as
  // context.pin, and be advertised in the description text,
  // because a verb nobody can discover is a verb nobody uses.
  // Wider and lighter than the fixture this gate used to carry. One boundary lands the
  // whole accumulated batch, so a twelve-turn session commits two or three ROOTS and one
  // of them alone is past the 25% pinned-share cap: the pin under test would be refused
  // by the cap gate 92 pins, and this gate would be measuring that refusal instead.
  const runtime = await epochToolRuntime({ turns: 16, resultChars: 8000 });
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);
  const description = [...runtime.tools.values()][0].description;
  // The surface has to name BOTH halves, because a pin an agent cannot find the release
  // for is a leak: pinned mass counts against the cap gate 92 pins, and the agent is the
  // only thing that can give it back.
  assert(/\bPin with ids holds\b/.test(description), "The pin is not advertised in the tool surface");
  assert(/\bunpin releases\b/.test(description), "The surface names the pin without naming its release");

  // ONE crossing. Each one runs consolidation to a fixpoint, so three of them take a
  // thirty-turn session down to a single root and there is no second fold to leave
  // unpinned beside the pinned one.
  await measure(runtime, 70_000, 100_000);
  await measureAndCommit(runtime, 86_000, 100_000);
  await settle();
  // Roots only: consolidation nests under the counting rule, and a child cannot be
  // expanded while its parent is still a placeholder.
  const folds = materialized(runtime).folds.filter((fold) => fold.parentId === null);
  assert(folds.length >= 2, "Pressure must have produced at least two committed root folds");
  const foldId = folds[0].id;
  // A second expanded fold stays UNpinned, so the refold rung has work to commit
  // while the pin is live and the pinned-mass accounting has a commit to ride.
  const unpinnedFoldId = folds[1].id;
  await toolCall(runtime, { action: "expand", id: foldId });
  await toolCall(runtime, { action: "pin", ids: [foldId] });
  await toolCall(runtime, { action: "expand", id: unpinnedFoldId });
  const pinned = stream().filter((record) => record.kind === "context.pin");
  assert.equal(pinned.length, 1, "A pin action must land exactly one context.pin record");
  assert.equal(pinned[0].pin, true);
  assert.equal(pinned[0].ids, foldId);
  assert(pinned[0].protected_refs_after > pinned[0].protected_refs_before,
    "Pinning a fold must add its evidence refs to the durable pin set");

  // Ten measured requests above the refold ratio, each reaching the boundary: the
  // 8-generation lease is long exhausted, the refold the ladder proposes lands as a mark
  // and applies at the crossing, and the pin is the only thing keeping the span expanded.
  for (let index = 0; index < 10; index += 1) {
    await measureAndCommit(runtime, 86_000 + index, 100_000, `pin-measurement-${index + 1}`);
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
  await toolCall(runtime, { action: "unpin", ids: [foldId] });
  const releases = stream().filter((record) =>
    record.kind === "context.pin" && record.pin === false);
  assert.equal(releases.length, 1);
  assert.equal(materialized(runtime).protected.length, 0, "Unpin must drain the refs the pin added");
  for (let index = 0; index < 3; index += 1) {
    await measureAndCommit(runtime, 91_000 + index, 100_000, `unpin-measurement-${index + 1}`);
  }
  state = materialized(runtime);
  assert(!state.expanded.includes(foldId), "After unpin the refold rung must reclaim the span");
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
    name: "pi_fold_context",
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
  const full = describe([...policy.ACTIVE_CONTEXT_TOOL_ACTIONS], true);
  assert(full.includes(norm), "The recovery norm is missing from the full surface");
  assert(full.includes("peek or expand that fold"), "The norm must name the recovery verbs");
  const configured = describe(["status", "expand"], false);
  assert(configured.includes(norm), "The recovery norm is missing from the configured surface");
  const noExpand = describe(["status", "fold"], false);
  assert(!noExpand.includes(norm), "A surface without expand must not preach a verb it lacks");
  return { advertisedOnFull: true, advertisedOnConfigured: true, silentWithoutExpand: true };
}

async function gatePinnedShareCap() {
  // The pin ceiling: protect refuses past MAX_PINNED_SHARE of the working window,
  // names the cap and the release valve, and pins NOTHING on refusal. Under the cap
  // the verb works exactly as before.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  for (const tokens of [70_000, 80_000, 86_000]) {
    await measureAndCommit(runtime, tokens, 100_000);
  }
  await settle();
  const folds = materialized(runtime).folds;
  assert(folds.length >= 2, "Pressure must have produced at least two committed folds");
  const refusal = await toolCall(runtime, { action: "pin", ids: folds.map((fold) => fold.id) })
    .catch((error) => error);
  assert.match(String(refusal), /pinned-share cap/,
    "Pinning everything must refuse past the cap");
  assert.match(String(refusal), new RegExp(`${Math.round(context.MAX_PINNED_SHARE * 100)}%`),
    "The refusal must name the cap");
  assert.match(String(refusal), /unpin/, "The refusal must name the release valve");
  assert.equal(materialized(runtime).protected.length, 0, "A refused pin must pin nothing");
  // The smallest LEAF. Consolidation nests under the counting rule, so a root fold can
  // now hold the whole stale region and pinning it would exceed the cap on its own;
  // what the under-the-cap leg is about is that a modest pin still lands.
  const smallest = [...folds]
    .filter((fold) => !fold.parts.some((part) => part.kind === "fold"))
    .sort((left, right) => (left.sourceChars ?? 0) - (right.sourceChars ?? 0))[0];
  assert(smallest, "The fixture produced no leaf fold to pin");
  await toolCall(runtime, { action: "pin", ids: [smallest.id] });
  const pinned = materialized(runtime).protected.length;
  assert(pinned > 0, "A pin under the cap must still land");
  return { cap: context.MAX_PINNED_SHARE, refused: true, pinnedUnderCap: pinned };
}

/**
 * THE UNIFIED SPAN LAW, WHERE IT IS NEW.
 *
 * One law selects stale material at commit time, and what the span contains decides the
 * fold. An automatic CHAPTER is raw material at every count. Placeholders nest by one
 * route only, the count law, which owes a parent for every consolidateAfter eligible
 * roots; pins are exempt from the count and from the span; and the nesting is exactly ONE
 * level deep, because the parent stores its children as placeholders rather than
 * swallowing their bytes.
 */
async function gateUnifiedSpanLaw() {
  const below = await chapterForest(context.DEFAULT_THRESHOLDS.consolidateAfter - 1);
  const belowSnapshot = context.mapActiveContext({
    sessionId: below.sessionId,
    eventMessages: below.messages,
    contextEntries: below.entries,
    contextWindow: 100_000,
  });
  const belowSpan = context.selectAutomaticSpan(belowSnapshot, below.state);
  assert(belowSpan, "The below-rule law proposed nothing at all");
  assert(belowSpan.parts.every((part) => part.kind === "raw"),
    "A below-rule automatic span included a placeholder");
  assert.deepEqual(context.selectAutomaticConsolidations(belowSnapshot, below.state), []);

  // At the rule, one pinned fold and the rest as material.
  const forest = await chapterForest(context.DEFAULT_THRESHOLDS.consolidateAfter + 1);
  const roots = forest.state.folds.filter((fold) => fold.parentId === null).map((fold) => fold.id);
  const pinnedId = roots[0];
  const pinnedRefs = context.flattenFoldRefs(
    forest.state.folds.find((fold) => fold.id === pinnedId), forest.state,
  );
  const seedState = { ...forest.state, protected: pinnedRefs.map((ref) => structuredClone(ref)) };
  const runtime = makeRuntime(forest, { initialEntries: [
    ...forest.entries,
    stateEntry(forest.sessionId, seedState, "nesting-state", forest.entries.at(-1).id),
  ] });
  await startRuntime(runtime);
  await measureAndCommit(runtime, 86_000, 100_000, "nesting-commit");
  const state = materialized(runtime);
  const parent = state.folds.find((fold) => fold.kind === "consolidation" && fold.parentId === null);
  assert(parent, JSON.stringify(state.folds.map((fold) => [fold.id, fold.kind, fold.parentId])));
  const childIds = parent.parts.map((part) => part.foldId);
  assert(parent.parts.every((part) => part.kind === "fold"), "The nested parent kept raw parts");
  assert.equal(childIds.includes(pinnedId), false, "A pinned fold was auto-nested");
  assert.equal(state.folds.find((fold) => fold.id === pinnedId).parentId, null);
  for (const id of childIds) assert.equal(state.folds.find((fold) => fold.id === id).parentId, parent.id);

  // ONE level. Expanding the parent reveals its children as placeholders, and the raw
  // bytes underneath them stay behind the children's own folds.
  const snapshot = context.mapActiveContext({
    sessionId: forest.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const expandedState = context.setFoldProjectionState(state, parent.id, "expanded");
  const revealed = context.renderFold(parent, expandedState, snapshot);
  assert.equal(revealed.length, childIds.length,
    "Expanding the parent revealed more than one level");
  const revealedText = json.stableStringify(revealed);
  const child = state.folds.find((fold) => fold.id === childIds[0]);
  assert(revealedText.includes(child.brief), "The revealed level is not the child's placeholder");
  // THE LAW IS BYTE MASS, NOT CONTAINMENT, on this fixture: its message bodies are
  // uniform padding, so any deep-offset probe also matches inside the bounded opening a
  // head may legitimately quote (the ask at 120, a note at 160, a result opening at
  // 90), and a containment check can only measure the quote. What expanding one level
  // must NOT do is swallow the grandchildren's bytes: the revealed rendering stays
  // placeholder-sized while the raw mass stays behind the children's own folds.
  const grandchildBytes = childIds.reduce((total, id) => total +
    context.flattenFoldRefs(state.folds.find((fold) => fold.id === id), state)
      .reduce((sum, ref) => sum +
        String(context.contentText(context.exactMapped(snapshot, ref).message)).length, 0), 0);
  assert(grandchildBytes > 4 * revealedText.length,
    "Expanding the parent leaked the grandchildren's byte mass: " +
      `${revealedText.length} revealed against ${grandchildBytes} raw`);
  const grandchildText = String(context.contentText(
    context.exactMapped(snapshot, context.flattenFoldRefs(child, state)[0]).message,
  )).slice(220, 284);

  // Peek is the OTHER half of the contract, and it serves the same ONE level: the fold's
  // own stored span. A parent's span is its child placeholders, so peeking it can carry
  // no bytes from underneath them, and the verbatim floor is one hop away at every depth
  // because any id the read hands back peeks its own span. It still moves nothing.
  const before = json.stableStringify(context.projectActiveContext(snapshot, state));
  const peeked = await toolCall(runtime, { action: "peek", id: parent.id });
  const peekedText = peeked.content.map((part) => part.text ?? "").join(" ");
  assert(peeked.details.source.includes(childIds[0]),
    "Peek of a nested parent named no child to descend into");
  assert(peeked.details.source.includes('"placeholder":"fold"'),
    "Peek of a nested parent did not keep its children placeheld");
  assert(grandchildBytes > 4 * peekedText.length,
    "Peek of a nested parent leaked bytes from under its children: " +
      `${peekedText.length} peeked against ${grandchildBytes} raw`);
  // The child id, read the same way. Straight through the reader rather than the tool,
  // because this fixture sits at the fence on purpose and admission control is its own
  // law: what is under test here is the depth the read serves, not the room it needs.
  const peekedChild = context.peekFoldSource({
    foldId: childIds[0],
    state,
    entries: runtime.branch,
    sessionId: forest.sessionId,
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
  });
  assert(peekedChild.source.includes(grandchildText), "Peek of a child id lost the verbatim floor");
  // The rescue path is the other read and still resolves every depth, because restoring
  // context is exactly the case that needs the original bytes rather than the span.
  const rescued = json.stableStringify(context.recoverFoldMessages({
    foldId: parent.id,
    state,
    entries: runtime.branch,
    sessionId: forest.sessionId,
  }));
  assert(rescued.includes(grandchildText), "The rescue read stopped resolving to the original bytes");
  assert.equal(
    json.stableStringify(context.projectActiveContext(snapshot, materialized(runtime))),
    before,
    "Peek of a nested parent rewrote the window",
  );
  return {
    consolidateAfter: context.DEFAULT_THRESHOLDS.consolidateAfter,
    belowRuleSpanParts: belowSpan.parts.length,
    nestedChildren: childIds.length,
    pinnedExcluded: true,
    expandRevealedLevels: 1,
    peekRevealedLevels: 1,
    rescueDepth: "verbatim",
  };
}

/**
 * The agent half of the nesting law.
 *
 * A mark's span may include folds, any kind and any count, at any time: automation's
 * counting rule is a restraint on AUTOMATION, and an agent that could not fold across
 * the chapters automation made could not curate its own history. Nesting removes
 * nothing, so the only refusal left is the pin.
 */
/**
 * THE THERMOSTAT, VALIDATED AT CONSTRUCTION.
 *
 * The five numbers are five halves of one decision, so they are checked together and a
 * violation is REFUSED by the name of the invariant it broke. Never clamped: a policy a
 * deployment cannot serve is a registration error, not a value to quietly rewrite, and
 * a governor that silently became something else is worse than one that never started.
 */
async function gateThresholdConstruction() {
  const withField = (overrides) => ({ ...context.DEFAULT_THRESHOLDS, ...overrides });
  const refuses = (thresholds, invariant) => {
    let thrown = null;
    try {
      context.resolveThresholds(thresholds);
    } catch (error) {
      thrown = error;
    }
    assert(thrown, `A policy violating ${invariant} was accepted`);
    assert.equal(thrown.name, "ThresholdPolicyError",
      `${invariant} threw ${thrown.name} rather than the named policy error`);
    assert.equal(thrown.invariant, invariant,
      `Expected invariant ${invariant}, got ${thrown.invariant}: ${thrown.message}`);
    assert(thrown.message.length > 0, `${invariant} refused without saying why`);
    return thrown.invariant;
  };

  // The defaults are a valid policy, and resolving nothing yields exactly them.
  assert.deepEqual(context.resolveThresholds(undefined), { ...context.DEFAULT_THRESHOLDS });
  assert.deepEqual(context.resolveThresholds({ ...context.DEFAULT_THRESHOLDS }),
    { ...context.DEFAULT_THRESHOLDS });

  // Shape: set whole or not at all, and no field the object does not have.
  const shape = [
    refuses(null, "shape"),
    refuses([0.8, 0.35], "shape"),
    refuses({ maxTarget: 0.8 }, "shape"),
    refuses(withField({ extra: 1 }), "shape"),
  ];
  assert.equal(new Set(shape).size, 1);

  // Every proportion is a proportion, and the count is a count.
  const named = [];
  for (const field of ["maxTarget", "minTarget"]) {
    named.push(refuses(withField({ [field]: 0 }), field));
    named.push(refuses(withField({ [field]: 1 }), field));
    named.push(refuses(withField({ [field]: -0.1 }), field));
    named.push(refuses(withField({ [field]: "0.5" }), field));
    named.push(refuses(withField({ [field]: Number.NaN }), field));
  }
  named.push(refuses(withField({ consolidateAfter: 0 }), "consolidateAfter"));
  named.push(refuses(withField({ consolidateAfter: 2.5 }), "consolidateAfter"));
  named.push(refuses(withField({ consolidateAfter: "10" }), "consolidateAfter"));
  // The fold floor is a character count with a hard floor of its own: below it a
  // placeholder can cost more than the source it replaces, which was measured twice on
  // sol-20260814-traps rep 1 (2,726 source chars to 5,341 of placeholder, and 6,384 to
  // 10,531). A share, a fraction and a value under the floor are each refused by name.
  named.push(refuses(withField({ minFoldChars: 0 }), "minFoldChars"));
  named.push(refuses(withField({ minFoldChars: 1_999 }), "minFoldChars"));
  named.push(refuses(withField({ minFoldChars: 8_000.5 }), "minFoldChars"));
  named.push(refuses(withField({ minFoldChars: "8000" }), "minFoldChars"));
  named.push(refuses(withField({ minFoldChars: 0.5 }), "minFoldChars"));
  assert.equal(context.MINIMUM_FOLD_CHARS_FLOOR, 2_000,
    "The fold floor drifted from the value the refusal message states");
  assert.equal(context.resolveThresholds({
    ...context.DEFAULT_THRESHOLDS, minFoldChars: context.MINIMUM_FOLD_CHARS_FLOOR,
  }).minFoldChars, context.MINIMUM_FOLD_CHARS_FLOOR,
  "The floor itself is refused, so nothing can sit at it");

  // ONE ASSERTION PER ORDERING INVARIANT, each by the name it refuses under.
  const orderings = [
    // L < M: the thermostat needs a gap to fold down into.
    refuses(withField({ minTarget: 0.80, maxTarget: 0.80 }), "minTarget<maxTarget"),
    // F < M: a fresh tail wider than the trigger triggers on protection alone.
  ];
  assert.equal(new Set(orderings).size, orderings.length,
    "Two ordering violations refused under the same invariant name");

  // Servability, evaluated at REGISTRATION against the declared window.
  // The fresh-tail floor is driven with a DECLARED tail rather than the default one:
  // the default is 0.10 as of 2026-08-21, and 10 percent of the 10,000-token minimum
  const serving = [];
  for (const [thresholds, budget, invariant] of [
    [context.DEFAULT_THRESHOLDS, 9_000, "minimumBudget"],
  ]) {
    let thrown = null;
    try {
      context.assertThresholdsServable(thresholds, budget);
    } catch (error) {
      thrown = error;
    }
    assert(thrown, `A ${budget}-token budget was accepted`);
    assert.equal(thrown.invariant, invariant, thrown.message);
    serving.push(invariant);
  }
  context.assertThresholdsServable(context.DEFAULT_THRESHOLDS, 25_000);

  // THE POSITIONAL REACH IS NOT A SETTING ANY MORE. `staleTail` declared how far back
  // automation could reach as a byte prefix, and Shane's 2026-08-10 ruling deleted the
  // idea: foldability is a class a span belongs to, not a position it occupies. A
  // deployment that still passes the old field is refused by name rather than having it
  // quietly ignored, which is the only way a governing number may leave a public surface.
  assert.deepEqual(Object.keys(context.DEFAULT_THRESHOLDS).sort(),
    ["consolidateAfter", "maxTarget", "minFoldChars", "minTarget"],
    "The thermostat is not the four numbers it declares");
  // And nothing ELSE is a tuning number. minToolChars and minChapterChars were two
  // constants nobody could tell apart, collapsed into minFoldChars on 2026-08-21;
  // MAX_WEDGE_ABSORB_TOKENS was a third saying the same thing in tokens and is gone
  // with them. The names stay spent.
  for (const gone of ["minToolChars", "minChapterChars", "maxWedgeAbsorbTokens"]) {
    assert.equal(context.ACTIVE_CONTEXT_POLICY[gone], undefined,
      `${gone} outlived the setting that replaced it`);
  }
  assert.equal(context.MAX_WEDGE_ABSORB_TOKENS, undefined,
    "The wedge threshold is minFoldChars now; its old constant is still exported");
  refuses({ ...context.DEFAULT_THRESHOLDS, staleTail: 0.78 }, "shape");

  // And the same refusal reaches a real registration, by name, never clamped.
  assert.throws(
    () => makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      { thresholds: { ...context.DEFAULT_THRESHOLDS, staleTail: 0.78 } }),
    /thresholds has no staleTail field/,
  );
  // FRESH TAIL IS A SPENT NAME (Shane 2026-08-23). It was a standing promise that a share
  // of the window never folds, and nothing decided on it: stale-first ordering already
  // leaves recent material last, and a fold is inert until commit, so the agent keeps
  // seeing fresh material whether or not the tail is protected. A deployment still passing
  // it is refused by name for the same reason staleTail is, rather than quietly ignored.
  assert.throws(
    () => makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      { thresholds: { ...context.DEFAULT_THRESHOLDS, freshTail: 0.10 } }),
    /thresholds has no freshTail field/,
  );
  const clamped = makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }));
  await startRuntime(clamped);
  assert.deepEqual((await toolStatus(clamped)).details.automatic.thresholds,
    { ...context.DEFAULT_THRESHOLDS });
  return {
    defaults: { ...context.DEFAULT_THRESHOLDS },
    shapeRefusals: shape.length,
    fieldRefusals: named.length,
    orderingInvariants: orderings,
    servabilityInvariants: serving,
    clampedEver: false,
  };
}

/**
 * THE CLASS LAW.
 *
 * Automatic foldability is MEMBERSHIP, not position (Shane 2026-08-10). A span is
 * automatically foldable when it is a completed tool batch the deployment did not
 * blacklist, or older material a chapter or a consolidation can compose over. Two
 * things and only two things hold it back, and this gate names each of them:
 *
 *   pinned          the agent protected it, anywhere in the window;
 *   blacklisted     the deployment named the tool, so no batch forms over it.
 *
 * The list was four. The fresh tail went first (nothing decided on it; stale-first
 * ordering already leaves recent material last), and the current-turn guard went on
 * 2026-08-23 when the first live session showed its "turn" covering the whole window
 * (Shane: "It should be at the most granular level, which is events"). What replaced
 * them is not a hold but structure: an incomplete event is never proposable, and the
 * depth bound stops the routine commit at the aim, stalest first, so the newest events
 * stay raw for exactly as long as there is room for them.
 *
 * There is no third thing, and in particular there is no MIDDLE. The positional stale
 * prefix that used to be the automatic law's whole reach is deleted: it starved rep 2 by
 * collapsing to zero width and rep 3 by charging a folded head its raw bytes, and both
 * times the set-based protections above went on working exactly as written.
 */
async function gateThreeZones() {
  const thresholds = Object.freeze({
    maxTarget: 0.80, minTarget: 0.35, consolidateAfter: 10, minFoldChars: 8_000,
  });
  const built = makeFixture({
    turns: 30, resultChars: 8_000, contextWindow: 100_000, thresholds,
  });
  const snapshot = built.snapshot;
  const state = context.emptyActiveContextState(built.sessionId);
  // THREE HOLD CLASSES, not four (Shane 2026-08-23). Fresh-tail is deleted: it was a
  // standing promise that a share of the newest window never folds, and nothing decided on
  // it. Pinned, blacklisted and guarded are what remain, and every one of them is a
  // membership a span has or has not, never a position it occupies.
  assert(!("toolProtectedIndices" in snapshot),
    "The snapshot still carries a recency-protected set");
  // THE DELETED VARIABLE IS GONE FROM THE DATA, not merely unread.
  assert(!("staleBoundary" in snapshot), "The snapshot still carries a positional reach");
  assert(!("staleTail" in snapshot.thresholds), "The thermostat still carries a positional reach");

  // (a) THE LAW PROPOSES, AND NOTHING IT PROPOSES IS PINNED OR FRESH.
  const claimed = new Set();
  const proposed = [];
  const reached = [];
  for (let round = 0; round < 40; round += 1) {
    const candidate = context.selectAutomaticSpan(snapshot, state, claimed);
    if (!candidate) break;
    for (const ref of candidate.sourceRefs) {
      const item = snapshot.mapped.find((entry) => entry.ref &&
        json.objectRefKey(entry.ref) === json.objectRefKey(ref));
      assert(item, "An automatic span named evidence the snapshot does not hold");
      assert(!snapshot.protectedIndices.has(item.index),
        `Automation proposed index ${item.index}, which is unfoldable for validity`);
      claimed.add(json.objectRefKey(ref));
      reached.push(item.index);
    }
    proposed.push(candidate.kind);
  }
  assert(proposed.length >= 2, "The class law offered automation almost nothing");

  // (b) THE MIDDLE IS NOT A WALL. Under the positional law this fixture had a real middle
  // and the ladder stopped dead at its edge; the class law reaches every member the fresh
  // tail does not cover, so exhaustion means EXHAUSTED rather than blocked.
  const foldableIndices = snapshot.mapped
    .filter((item) => item.ref && item.message?.role === "toolResult" &&
      !snapshot.protectedIndices.has(item.index))
    .map((item) => item.index);
  assert(foldableIndices.length > 0, "The fixture holds no foldable tool results at all");
  const unreached = foldableIndices.filter((index) => !reached.includes(index));
  assert.deepEqual(unreached, [],
    `The ladder left ${unreached.length} unpinned member results untouched: ${unreached.join(", ")}`);
  assert(Math.max(...reached) >= Math.max(...foldableIndices),
    "The deepest proposal stopped short of the newest foldable member");
  assert.equal(context.selectAutomaticSpan(snapshot, state, claimed), null,
    "Automation kept proposing after every member was claimed");
  assert.deepEqual(context.selectAutomaticToolBatch(snapshot, state, claimed), []);

  // (c) BLACKLISTED IS NOT A MEMBER. The same window, with the fixture's only tool named
  // by the deployment: no batch forms over it, at any position.
  const blacklisted = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
    thresholds,
    blacklistAutoFoldTools: new Set(["read"]),
  });
  assert.deepEqual(context.selectAutomaticToolBatch(blacklisted, state), [],
    "A blacklisted tool's completed batch was still proposed as a tool fold");

  const staleEntry = built.turnEntries[1][2];
  const markFor = (entryId) => {
    const item = snapshot.mapped.find((entry) => entry.ref?.entryId === entryId);
    assert(item, `The fixture has no entry ${entryId}`);
    return {
      mark: "fold",
      id: `mark_${entryId}`,
      kind: "tool-result",
      parts: [{ kind: "raw", ref: item.ref }],
      brief: "The exact completed inspection stays recoverable behind this fold.",
      briefProvenance: { kind: "deterministic" },
      origin: "agent",
      ordinal: 1,
      index: item.index,
    };
  };
  const staleMark = markFor(staleEntry);
  assert.equal(context.markEligibility(snapshot, state, staleMark), "eligible",
    "A span held by no class at all was still not eligible to commit");

  // PINS ARE EXEMPT EVERYWHERE. Protect the older span and the law steps over it, at
  // whatever position it holds. This is the protection the positional prefix was
  // supposedly reinforcing, and it is the one that never failed.
  const pinnedRef = snapshot.mapped.find((entry) => entry.ref?.entryId === staleEntry).ref;
  const pinned = { ...state, protected: [structuredClone(pinnedRef)] };
  assert.equal(context.markEligibility(snapshot, pinned, staleMark), "protected",
    "A pinned span was still eligible");
  const pinnedKey = json.objectRefKey(pinnedRef);
  const pinnedClaims = new Set();
  for (let round = 0; round < 40; round += 1) {
    const candidate = context.selectAutomaticSpan(snapshot, pinned, pinnedClaims);
    if (!candidate) break;
    for (const ref of candidate.sourceRefs) {
      assert.notEqual(json.objectRefKey(ref), pinnedKey,
        "An automatic span swallowed a pinned entry");
      pinnedClaims.add(json.objectRefKey(ref));
    }
  }

  // GUARDED IS NO LONGER A HOLD (2026-08-23): the open turn's evidence stays proposable
  // and the commit spends it stalest-first under the depth bound. Gate 09 drives the
  // never-closing session end to end; this fixture closes every turn, so what it proves
  // is that the two holds above are the only refusals selection ever issues.

  return {
    freshBoundary: snapshot.freshBoundary,
    messages: snapshot.messages.length,
    spansProposed: proposed.length,
    memberResults: foldableIndices.length,
    memberResultsReached: foldableIndices.length,
    deepestProposedIndex: Math.max(...reached),
    blacklistedProposals: 0,
    staleMarkEligibility: "eligible",
    pinnedMarkEligibility: "protected",
  };
}

/**
 * THE CLASS LAW IS UNCONDITIONAL, AND THE LATCH QUESTION DISSOLVED.
 *
 * Three behaviors, each pinned by name: membership decides what folds at every
 * occupancy and the machinery that used to bend the rules at the fence is gone; the
 * reopen latch still holds a parked window; and a window at the fence with nothing the
 * law admits is aborted and then recovered by a rollback, not by a deeper fold.
 */
async function gateFenceOpensTheMiddle() {
  const thresholds = Object.freeze({
    maxTarget: 0.80, minTarget: 0.35, consolidateAfter: 10, minFoldChars: 8_000,
  });

  // (a) THE LAW IS UNCONDITIONAL, AND THE MACHINERY THAT BENT IT IS GONE.
  //
  // There was a fence-only snapshot here: at high occupancy it narrowed the reach rules
  // and extended automation across the middle, so a reduction that had to make a rejected
  // request sendable had mass to reach. It existed because folding harder was the
  // runtime's only answer to a provider rejection. The rollback lane is the answer now,
  // so the rules hold at every occupancy and there is exactly one set of them.
  assert.equal(typeof context.deepenedFenceSnapshot, "undefined",
    "The fence-only snapshot survived the rollback build");
  const source = await readFile(join(projectRoot, "extensions", "lib", "transcript.ts"), "utf8");
  assert(!/deepenedFenceSnapshot/.test(source), "deepenedFenceSnapshot is still reachable in the transcript module");
  assert(!/staleBoundary|staleTail/.test(source),
    "The positional reach survived in the transcript module");
  const runtimeSource = await readFile(join(projectRoot, "extensions", "active-context.ts"), "utf8");
  assert(!/deepenedFreshnessSnapshot|DEEPENED_FRESH_TAIL_SHARE/.test(runtimeSource),
    "The fence-only reach rules survived in the runtime");
  assert(!/fenceLevel \? new Set/.test(runtimeSource),
    "A fence-only zone waiver survived in the commit epoch");

  // (b) THE LAW ITSELF, BY CONSTRUCTION. Automation proposes members and nothing else.
  // `selectAutomaticSpan` is the ONLY producer of automatic spans, so exhausting it
  // against a pinned snapshot proves the reach rule over every span it can ever offer,
  // which a pressure run can only sample.
  const built = makeFixture({ turns: 30, resultChars: 8_000, contextWindow: 100_000, thresholds });
  const snapshot = built.snapshot;
  const state = context.emptyActiveContextState(built.sessionId);
  const exhaust = (against) => {
    const claims = new Set();
    const spans = [];
    for (let round = 0; round < 40; round += 1) {
      const candidate = context.selectAutomaticSpan(against, state, claims);
      if (!candidate) break;
      for (const ref of candidate.sourceRefs) claims.add(json.objectRefKey(ref));
      spans.push(candidate);
    }
    return spans;
  };
  const proposed = exhaust(snapshot);
  assert(proposed.length >= 1, "The class law proposed nothing at all");
  const reachedIndices = proposed.flatMap((candidate) => candidate.sourceRefs
    .map((ref) => snapshot.mapped.findIndex((item) => item.ref && json.objectRefKey(item.ref) === json.objectRefKey(ref)))
    .filter((index) => index >= 0));
  assert(reachedIndices.every((index) => !snapshot.protectedIndices.has(index)),
    `Automation proposed protected index ${reachedIndices.find((index) => snapshot.protectedIndices.has(index))}`);

  // The deployment blacklist is the same law read through the same producer, so it is
  // proved the same way: over EVERY span the selector can offer rather than over whichever
  // ones a pressure run happens to reach. Both directions, because "no tool fold formed"
  // is worth nothing without a run where one does.
  const blacklisted = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
    thresholds,
    blacklistAutoFoldTools: new Set(["read"]),  // the fixture's own producer
  });
  const toolSpansOpen = proposed.filter((candidate) => candidate.kind === "tool-result");
  const toolSpansBlacklisted = exhaust(blacklisted).filter((candidate) => candidate.kind === "tool-result");
  assert(toolSpansOpen.length >= 1,
    "No tool-result span is proposable at all, so the blacklist has nothing to withhold");
  assert.equal(toolSpansBlacklisted.length, 0,
    "The selector proposed a tool-result span over a blacklisted producer");

  // (c) AND THE RUNTIME REACHES IT THROUGH THAT PRODUCER, UNDER FENCE PRESSURE.
  //
  // (b) proves the selector. This proves the COMMIT PATH uses it: at the fence, with a
  // pin and a deployment blacklist both standing, every fold that lands is audited back
  // to the source indices it covers and none of them is held.
  //
  // This phase used to drain the ladder over eight projection rounds and then append five
  // pinned twelve-kilobyte stages, and it cost a QUARTER OF THE SUITE to assert nothing:
  // by construction the drain left nothing takeable and the inflow was entirely held, so
  // `landedAtFence` was EMPTY every run and the audit loop never executed once. It passed
  // the fresh-tail deletion straight through, still reading a snapshot field that no
  // longer exists. The repair is not a bigger fixture; it is to hold the pin and the
  // blacklist while material the ladder MAY take is still standing, and to fail when the
  // audit has no members rather than to report a pass over an empty set.
  const runtime = makeRuntime(
    makeFixture({ turns: 16, resultChars: 3_000, contextWindow: 34_000, thresholds }),
    {
      ...SEALED_SPINE,
      providerInputBudget: 30_600,
      thresholds,
      blacklistAutoFoldTools: new Set(["fence_stream"]),
    },
  );
  await startRuntime(runtime);
  const blacklistedIndices = new Set();
  // One blacklisted batch, declared untakeable by the DEPLOYMENT.
  runtime.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "fence-0", name: "fence_stream", arguments: { path: "fence-0.txt" } }],
    stopReason: "toolUse", timestamp: 960,
  }, "fence-inflow");
  blacklistedIndices.add(runtime.messages.length - 1);
  runtime.appendMessage({
    role: "toolResult", toolCallId: "fence-0", toolName: "fence_stream",
    content: [{ type: "text", text: `Fence 0: ${"f".repeat(9_000)}` }], isError: false, timestamp: 960,
  }, "fence-inflow");
  blacklistedIndices.add(runtime.messages.length - 1);
  runtime.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Fence stage 0 done." }],
    stopReason: "stop", timestamp: 960,
  }, "fence-inflow");
  await project(runtime);
  await settle();
  // And one span declared untakeable by the AGENT, on material the ladder would otherwise
  // reach: an early turn, which stale-first ordering puts at the front of the queue.
  // Every entry of the turn, not its endpoints: `pin` holds the refs it is NAMED, so a
  // two-id call leaves the middle of the turn takeable and a fold that takes it is
  // obeying the law rather than breaking it.
  const pinnedIds = new Set(built.turnEntries[1]);
  const pinned = await toolCall(runtime, { action: "pin", ids: [...pinnedIds] });
  assert.equal(pinned.details.protectedRefs, pinnedIds.size, "The fence pin did not hold every named entry");

  // AUDITED BY REF KEY, NOT BY POSITION. A landed fold is checked against the exact refs
  // the holds cover, because folding REPLACES branch entries with placeholders and every
  // position taken before a commit means something else after it. The first cut of this
  // repair mapped refs back to indices and every fold read as "outside the window".
  const preFence = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 30_600,
    netBudget: true,
    thresholds,
  });
  // THE TWO HOLDS ARE NOT THE SAME HOLD, and this gate used to conflate them. A pin means
  // nothing may cover the ref, of any kind. A blacklist means no TOOL-RESULT fold forms
  // over that producer; a chapter absorbing the batch as ordinary span is the rule
  // working, not a leak. The old fixture pinned each blacklisted call as well, so the
  // blacklist's own law was never once separated from the pin's and never tested.
  const pinnedRefs = new Set();
  const blacklistedRefs = new Set();
  for (const item of preFence.mapped) {
    if (!item.ref) continue;
    if (pinnedIds.has(item.ref.entryId)) pinnedRefs.add(json.objectRefKey(item.ref));
    if (blacklistedIndices.has(item.index)) blacklistedRefs.add(json.objectRefKey(item.ref));
  }
  assert.equal(pinnedRefs.size, pinnedIds.size, "The pin does not cover standing evidence");
  assert(blacklistedRefs.size >= 2, "The blacklisted batch is not standing evidence");

  const abortsBeforeFence = runtime.aborts;
  const beforeFence = runtime.appended.length;
  const landedAtFence = [];
  let known = new Set(materialized(runtime).folds.map((fold) => fold.id));
  for (const tokens of [26_000, 28_500, 30_400, 31_500]) {
    await measureAndCommit(runtime, tokens, 34_000, `fence-${tokens}`);
    const after = materialized(runtime);
    for (const fold of after.folds) {
      if (known.has(fold.id)) continue;
      landedAtFence.push({
        id: fold.id,
        kind: fold.kind,
        refs: context.flattenFoldRefs(fold, after).map((ref) => json.objectRefKey(ref)),
      });
    }
    known = new Set(after.folds.map((fold) => fold.id));
  }
  // THE AUDIT HAS MEMBERS. Without this the loop below is a pass over nothing, which is
  // the exact defect this gate shipped with.
  assert(landedAtFence.length >= 1,
    "No fold landed under fence pressure, so the commit path is not being audited at all");
  for (const fold of landedAtFence) {
    assert(fold.refs.length > 0, `Fold ${fold.id} landed covering no evidence at all`);
    assert(fold.refs.every((key) => !pinnedRefs.has(key)),
      `Fold ${fold.id} took pinned evidence at the fence`);
  }
  assert(runtime.aborts > abortsBeforeFence,
    "An untransmittable request went out instead of being aborted");

  // (d) A COMMIT PASS WITH NOTHING TO PROPOSE SAYS SO. It used to return silently, which
  // is how the rep-2 starvation stayed invisible for 25 stages: the pass that answered a
  // 274,173-token backlog left no record that a commit had been attempted at all. It
  // names itself now and carries the remainder beside the emptiness, so mass it names and
  // marks it cannot make are ONE contradiction rather than two questions. The remainder
  // counts MEMBER spans, the same enumeration the selectors propose out of: nonzero means
  // a pin, a blacklist or the guard is holding them, zero means there is nothing to hold.
  await measureAndCommit(runtime, 31_600, 34_000);
  await measureAndCommit(runtime, 31_700, 34_000);
  // A DEFERRAL IS NAMED, WHATEVER THE REASON. This read `nothing-proposable` alone, which
  // was the only starved shape while the ladder staged at commit time: the selectors came
  // up empty and the pass had zero pending marks. The frontier cuts ahead of the commit,
  // so the starved pass now usually arrives holding a mark it cannot apply and defers as
  // `below-reclaim-floor` instead. Naming one reason would have made this gate pass on
  // silence, since a pass that never emits also never emits the reason being matched. The
  // claim is the one the rep-2 starvation cost 25 stages to learn: a commit pass that
  // frees nothing SAYS SO, with its reason and its remainder on the record.
  const deferrals = contextEvents(runtime, beforeFence).filter((record) =>
    record.kind === "context.commit" && record.deferred === true);
  assert(deferrals.length >= 1, "A commit pass that freed nothing returned silently");
  for (const record of deferrals) {
    assert.equal(record.applied_marks, 0, "A deferral applied marks, so it did not defer");
    assert.equal(typeof record.reason, "string",
      "The deferral named no reason, so it says nothing the silence did not");
    assert(record.reason.length > 0);
    assert.equal(typeof record.unmarked_stale_spans, "number",
      "The deferral reported no remainder, so it says nothing the silence did not");
    assert.equal(record.stale_boundary, undefined,
      "The deferral still carries a positional boundary");
  }

  return {
    proposedSpans: proposed.length,
    deepestProposedIndex: Math.max(...reachedIndices),
    fenceSnapshotDeleted: true,
    fenceFolds: landedAtFence.length,
    pinnedRefs: pinnedRefs.size,
    blacklistedRefs: blacklistedRefs.size,
    toolSpansOpen: toolSpansOpen.length,
    toolSpansBlacklisted: toolSpansBlacklisted.length,
    deferralsNamed: deferrals.length,
    fenceAborts: runtime.aborts,
  };
}

/**
 * THE BAND TOP COMMITS IN A SESSION THAT NEVER CLOSES A TURN.
 *
 * The shape was first measured 2026-08-10 (luna-20260810 pifold rep 2, sealed run
 * 3705e0d4): one user message and 24 assistant messages, every one stopReason "toolUse",
 * so no turn ever closes. Back then two selector defects starved it; those are long
 * fixed and the membership half of this gate still pins them: a completed tool batch is
 * a member whether or not its turn ever closed.
 *
 * The commit half was REWRITTEN 2026-08-23, from the first live session of the redesign
 * (sol-20260823-live pifold rep 1). The current-turn guard held every mark the frontier
 * staged, because "current turn" was everything since the last terminal assistant stop
 * and this shape never has one: four band-top commits applied 0 of 15/16/17/18 marks,
 * occupancy rode 208,234 to 240,948 of a 251,520 budget (0.958), and the projection
 * fence swept all 18 marks at once to a 7,908-token landing against a 100,608 aim. The
 * guard and its waiver are DELETED (Shane: "you're using turns as the boundaries, which
 * should not be the case. It should be at the most granular level, which is events").
 * What protects the working set now is event-level and structural: an incomplete batch
 * is never proposable, the depth bound stops the routine commit at the aim, and the
 * stalest-first cut order leaves the newest events raw.
 *
 * So this gate now asserts the exact opposite of what its commit half asserted before,
 * on the same fixture: the BAND TOP ITSELF applies, stops at the aim, and retains the
 * newest material as pending rather than as guarded. It fails on the pre-fix runtime,
 * where the same drive applies zero marks.
 */
async function gateOpenTurnCommits() {
  // THE FIXTURE IS THE SHAPE. One user message, then nothing but tool-calling assistants
  // and their results. No terminal assistant anywhere, including the measurement
  // messages, so no turn ever closes.
  const sessionId = "open-turn-test";
  const window = 100_000;
  const providerInputBudget = 90_000;
  const batches = 24;
  const resultChars = 16_000;
  const entries = [];
  const messages = [];
  const resultEntryIds = [];
  let parentId = null;
  let sequence = 0;
  const add = (message) => {
    const id = `${sessionId}-entry-${String(++sequence).padStart(3, "0")}`;
    entries.push({ type: "message", id, parentId, message });
    messages.push(message);
    parentId = id;
    return id;
  };
  add({
    role: "user",
    content: [{ type: "text", text: "One marathon task: read the repository and keep going." }],
    timestamp: 1,
  });
  for (let step = 0; step < batches; step += 1) {
    add({
      role: "assistant",
      content: [{ type: "toolCall", id: `open-${step}`, name: "read", arguments: { path: `open-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 10 + step,
    });
    resultEntryIds.push(add({
      role: "toolResult",
      toolCallId: `open-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Open ${step}: ${"o".repeat(resultChars)}` }],
      isError: false,
      timestamp: 10 + step,
    }));
  }
  const built = {
    sessionId,
    entries,
    messages,
    contextWindow: window,
    turnEntries: [resultEntryIds],
    snapshot: context.mapActiveContext({
      sessionId, eventMessages: messages, contextEntries: entries, contextWindow: window,
    }),
  };
  const runtime = makeRuntime(built, { providerInputBudget });
  await startRuntime(runtime);

  // (a) THE FIXTURE REALLY IS THE SHAPE.
  const budgetTokens = (await toolStatus(runtime)).details.automatic.projectionBudgetTokens;
  assert.equal(budgetTokens, providerInputBudget,
    "The declared serving budget did not reach the runtime, so the netBudget path is not exercised");
  const snapshot = context.mapActiveContext({
    sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: providerInputBudget,
    netBudget: true,
  });
  assert.equal(snapshot.completeTurns.length, 0, "A turn closed in the open-turn fixture");
  assert(!terminalStopIn(runtime.messages),
    "A terminal assistant message reached the open-turn fixture");
  assert(bytesOf(runtime.messages) >= batches * resultChars,
    "The fixture is smaller than the batches it declares");
  assert(snapshot.thresholds.minFoldChars <= resultChars,
    "The fixture's results are under the minimum a fold may be");

  // (b) MEMBERSHIP, NOT POSITION. Foldability is membership, so a session that never
  // closed a turn still holds members. The old law made the automatic reach a byte
  // prefix clamped to the last closed turn, which is absent here, so every rung saw
  // nothing; the 2026-08-10 fix is still pinned by these two assertions.
  assert.equal(snapshot.freshBoundary, 0,
    "The fresh boundary is not zero, so the never-closing shape is not being measured");
  const members = context.automaticToolBatches(snapshot, context.emptyActiveContextState(sessionId));
  assert(members.length > 0,
    "No completed batch is a member in a session that never closed a turn: the clamp is back");

  // (c) AND THE OLD GUARD WOULD HAVE HELD ALL OF IT, recorded so the deletion stays a
  // decision: every member's refs sit past the last terminal stop, which is the whole
  // window here. Excluding that set at proposal time leaves the selector nothing, which
  // is why no exclusion at any granularity wider than the event can serve this shape.
  const turnScoped = toolResultRefKeys(snapshot);
  assert.equal(turnScoped.size, batches,
    "The turn-scoped reading does not cover the whole window, so the shape is not being measured");
  assert.equal(context.selectAutomaticSpan(snapshot, context.emptyActiveContextState(sessionId), turnScoped), null,
    "A turn-scoped exclusion left something proposable, so this fixture no longer " +
      "demonstrates why the old guard starved it");

  // (d) CLIMB WITH ZERO AGENT MARKS. Every measurement stops on toolUse, so the turn
  // stays open through the whole climb and the agent never marks anything itself.
  const bandTop = context.DEFAULT_THRESHOLDS.maxTarget * providerInputBudget;
  await measure(runtime, 60_000, window, undefined, "toolUse");
  await project(runtime);
  await settle();
  const commitFrom = runtime.appended.length;
  await measure(runtime, Math.ceil(bandTop) + 2_000, window, undefined, "toolUse");
  await project(runtime);
  await settle();

  // (e) THE BAND TOP APPLIES. This is the assertion the live run failed: the pre-fix
  // runtime emitted this same record with applied_marks 0 and every mark retained.
  const commit = contextEvents(runtime, commitFrom)
    .find((record) => record.kind === "context.commit" && record.deferred === false &&
      record.trigger === "band-top");
  assert(commit, "The band top did not commit in a session that never closed a turn");
  assert(commit.applied_marks > 0, `The band-top commit applied ${commit.applied_marks} marks`);
  assert(commit.freed_tokens > 0, `The band-top commit freed ${commit.freed_tokens} tokens`);
  assert.equal(commit.shortfall_share, 0,
    `The commit fell ${commit.shortfall_share} short of its freeing target`);

  // (f) AND STOPS AT THE AIM. The depth bound retains what the target does not need,
  // stalest first, so the newest events survive raw as PENDING marks rather than as
  // guarded ones: still briefable, still editable, folded only when a later commit
  // needs the depth.
  assert(commit.deferred_marks > 0,
    "The commit applied everything staged, so the depth bound is not binding and the " +
      "landing is the fence sweep the live run recorded");
  const committedState = materialized(runtime, sessionId);
  const foldedKeys = new Set(committedState.folds.flatMap((fold) =>
    fold.parts.flatMap((part) => (part.kind === "raw" ? [part.ref.entryId] : []))));
  assert(foldedKeys.size > 0, "Nothing was folded, so the depth cut proves nothing");
  assert(foldedKeys.has(resultEntryIds[0]),
    "The oldest batch survived raw, so the cut is not taking stalest first");
  assert(!foldedKeys.has(resultEntryIds.at(-1)),
    "The commit folded the newest batch, so the depth cut is not what protects the working set");
  const projection = await project(runtime);
  const projected = json.stableStringify(projection.messages);
  assert(projected.includes(`Open ${batches - 1}: `),
    "The newest batch did not survive raw in the projection");
  assert(!projected.includes(`Open 0: ${"o".repeat(resultChars)}`),
    "The oldest batch survived raw, so the commit moved nothing the stale end offered");

  // (g) THE CONSISTENCY INVARIANT, held from the 2026-08-10 fix: unmarked stale mass the
  // selector cannot propose is a window that will starve no matter what fires.
  const exposureSnapshot = context.mapActiveContext({
    sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: providerInputBudget,
    netBudget: true,
  });
  const exposureState = materialized(runtime, sessionId);
  const remainder = context.unmarkedRemainder(exposureSnapshot, exposureState, 4);
  if (remainder.spans > 0) {
    assert(context.selectAutomaticSpan(exposureSnapshot, exposureState) !== null,
      `${remainder.spans} unmarked stale spans stand that the selector cannot propose`);
  }

  return {
    completeTurns: snapshot.completeTurns.length,
    freshBoundary: snapshot.freshBoundary,
    memberBatches: members.length,
    messages: snapshot.messages.length,
    turnScopedRefKeys: turnScoped.size,
    proposableUnderTurnScopedExclusion: false,
    appliedMarks: commit.applied_marks,
    retainedByDepthBound: commit.deferred_marks,
    shortfallShare: commit.shortfall_share,
    freedTokens: commit.freed_tokens,
    unmarkedStaleSpans: remainder.spans,
    newestBatchFolded: false,
  };
}

/**
 * THE public surface: five options, and nothing else reaches the runtime.
 *
 * Every name outside the six is refused, and a name that was RENAMED is refused by its
 * old spelling with the new one in the message. Silence would be worse than a name that
 * never existed: an unknown key used to spread straight through, so a caller who passed
 * a deleted option believed it had bought behavior and got the opposite. `registerPiFold`
 * is the front door this gate measures; the internal seam is deliberately wider, and the
 * last leg proves the seam cannot be reached through the door.
 *
 * Six became five on 2026-08-10. `evidenceIngestion` is hardwired on, `autoFoldableTools`
 * inverted into `blacklistAutoFoldTools`, and `summarizer` lost `"deterministic"`, which
 * is the first REFUSED VALUE on this surface rather than a refused name.
 */
async function gatePublicOptionSurface() {
  const built = makeFixture({ turns: 4, resultChars: 3_000 });
  const register = (options) => makeRuntime(built, {
    ...options, packageRegistration: true, retiredOptions: options,
  }).tools;
  // The whole surface, exercised together: six names, all accepted at once. It was four
  // until `guidance` went with the agent's `fold` verb on 2026-08-23 (the copy it switched
  // taught the agent to choose spans, and the agent does not choose spans), four
  // again since 2026-08-24 with `toolFoldThreshold`, the tool-call diet's one public knob
  // (gate 148 owns its behaviour; this gate owns its seat on the surface), five since
  // 2026-08-26 with `workingMemory`, the digest channel's switch (gate 149 owns its
  // behaviour), and six since 2026-08-27 with `postFoldNotice`, the invitation switch
  // promoted on the fold-vs-compaction verdict (the silenced condition won the campaign;
  // gateFoldNoticeSilenced owns its behaviour and its acceptance at the door).
  const surface = makeRuntime(built, {
    packageRegistration: true,
    retiredOptions: {
      thresholds: context.DEFAULT_THRESHOLDS,
      providerInputBudget: 90_000,
      blacklistAutoFoldTools: new Set(["repo_stage"]),
      toolFoldThreshold: 0.5,
      workingMemory: true,
      postFoldNotice: false,
    },
  });
  assert.deepEqual(Object.keys(surface.registration), ["projectionCandidates"]);
  assert.deepEqual([...surface.tools.keys()], ["pi_fold_context"]);
  // The renames, each refused by its OLD name and each naming its replacement, because a
  // caller holding the old name needs the new one, not a shape error. Both spellings of
  // the auto-fold list are ALLOW-lists, so their refusals must also say the sense flipped:
  // forwarded verbatim, either one would bar exactly the tools it meant to permit.
  const renamed = [
    ["readOnlyTools", new Set(["read"]),
      /readOnlyTools is no longer an option: renamed blacklistAutoFoldTools, and the sense is INVERTED/],
    ["autoFoldableTools", new Set(["read", "repo_stage"]),
      /autoFoldableTools is no longer an option: renamed blacklistAutoFoldTools, and the sense is INVERTED/],
    ["providerTotalWindow", 400_000, /providerTotalWindow is no longer an option: renamed providerInputBudget/],
  ];
  for (const [option, value, message] of renamed) {
    assert.throws(() => register({ [option]: value }), message,
      `${option} was accepted after its rename`);
  }
  // The reshape is not just a rename: the value's MEANING changed, so the message says
  // already net rather than leaving a caller to move a gross window across.
  assert.throws(() => register({ providerTotalWindow: 400_000 }), /ALREADY NET/);
  // Deployment identity left the surface entirely. Each of the five is refused, and the
  // entry-type one says why moving it is worse than merely unsupported.
  for (const [option, value] of [
    ["toolName", "ctx_tool"], ["toolLabel", "Context"], ["brandNoun", "acme"],
    ["entryTypePrefix", "acme-active-context"], ["commandPrefix", "sandbox"],
    ["commandNames", { status: "ctx", fold: "fold-ctx" }],
  ]) {
    assert.throws(() => register({ [option]: value }),
      /is no longer an option: the deployment identity is hardwired to pi-fold/,
      `${option} survived the identity hardwiring`);
  }
  assert.throws(() => register({ entryTypePrefix: "acme-active-context" }), /strand every fold already written/);
  // The predicate whose default guaranteed it never ran.
  assert.throws(() => register({ isMcpTool: () => true }), /mcp__server__tool naming convention/);
  // The DELETED generator, refused under both its names with the corpus verdict in the
  // message: a deployment still passing either asked for model briefs, and silence would
  // read as having them. The message states what holds instead.
  assert.throws(() => register({ summarizeContextSpan: async () => ({ brief: "x" }) }),
    /summarizeContextSpan is no longer an option: the model brief generator is deleted/);
  assert.throws(() => register({ summarizer: "session" }),
    /summarizer is no longer an option: the model brief generator is deleted \(2026-08-14\)/);
  assert.throws(() => register({ summarizer: { provider: "openai", model: "gpt-brief", effort: "low" } }),
    /never consulted or never became visible.*deterministic brief.*keep them on load/s);
  // The MECHANISM that lost its switch. The switch is refused by name and the message says
  // the mechanism is on, not that the name is unknown: a deployment reading "unknown
  // option" would conclude the writes had stopped.
  assert.throws(() => register({ evidenceIngestion: false }),
    /evidenceIngestion is no longer an option: evidence ingestion is always on/);
  // A name this package never sold at all is refused with the whole surface named, so a
  // typo reports the three rather than failing somewhere downstream at runtime.
  assert.throws(() => register({ maxTarget: 0.8 }),
    /maxTarget is not a pi-fold option: the surface is thresholds, providerInputBudget, blacklistAutoFoldTools/);
  // And the deleted option is refused BY NAME with what replaced it, not as an unknown
  // word: a deployment that set it needs to know the notice is unconditional now.
  assert.throws(() => register({ guidance: { actionResponses: true } }),
    /guidance is no longer an option: deleted 2026-08-23/);
  assert.throws(() => register({ foldScheduling: "epoch" }), /foldScheduling is not a pi-fold option/);
  // The seam is not reachable through the door: the runtime still accepts a synthetic
  // brand when registered directly, which is what keeps the neutrality gate honest.
  const seam = makeRuntime(built, { toolName: "acme_context", brandNoun: "Acme" });
  assert.deepEqual([...seam.tools.keys()], ["acme_context"]);
  // The inverted name is refused at the seam too, so a direct registration cannot move an
  // allow-list across either. The seam is wider than the door; it is not laxer.
  assert.throws(() => makeRuntime(built, { retiredOptions: { autoFoldableTools: new Set(["read"]) } }),
    /autoFoldableTools is now blacklistAutoFoldTools, and the sense is INVERTED/);
  return {
    publicOptions: 6,
    renamesRefusedByOldName: renamed.length,
    identityOptionsRefused: 6,
    unknownNamesRefused: 2,
    refusedValues: 1,
    internalSeamReachableFromPackageEntry: false,
  };
}

/**
 * MECHANISM 5. The ladder stages nothing between epochs, and at the epoch it fills
 * whatever the agent's own marks did not cover. One commit, sized before it runs.
 *
 * Shane, 2026-08-21, dogfooding: the rung staged a mark on every measured response,
 * every turn end and every message end, so by the time an agent looked, every eligible
 * batch was already claimed and agent curation was structurally impossible. The corpus
 * says so without ambiguity: 30 sealed pifold runs, 2,529 automatic folds, ZERO
 * voluntary ones, and exactly one `fold` action attempted in the whole history. That is
 * not agents declining to curate. It is agents never being offered anything.
 *
 * The first cut of the fix over-corrected: any agent mark stood the ladder down for the
 * whole epoch. That commits at whatever depth the agent happened to reach, so one small
 * mark against a large drop commits a barely-moved window, and the next fence pass fires
 * a SECOND commit in the same cycle. Two commits is two prefix rewrites is two cache
 * misses, which is the cost the one-commit rule exists to prevent, and it is what made
 * gate 69 fail on the stand-down build.
 *
 * Shane's law (2026-08-21), stated in his own arithmetic: at the threshold we know the
 * distance from what is used now to the minTarget floor. Say 200k used, 100k floor, so
 * 100k has to go. The agent marked 30k of it. The ladder folds ~70k more from the stale
 * end, and BOTH land in one commit computed before the commit runs. The agent's marks
 * are counted toward the distance rather than displaced, and `claimedRefKeys` keeps the
 * fill off spans the agent already took.
 *
 * The classifier and the blacklist survive unchanged; what died is the eager staging.
 */
async function gateLadderFillsWhatTheAgentLeft() {
  // The classifier, unchanged: an arbitrary tool is foldable whatever its
  // arguments look like, and blacklisting it is the only thing that changes the answer.
  assert.equal(context.isAutoFoldableToolCall("bash", { command: "make" }), true);
  assert.equal(context.isAutoFoldableToolCall("write", { path: "x", contents: "y" }), true);
  assert.equal(
    context.isAutoFoldableToolCall("bash", { command: "make" }, "pi_fold_context", new Set(["bash"])),
    false,
  );
  // The one carve-out survives: the context tool's own MUTATING calls are never
  // auto-foldable, because a tool call may not cause a rewrite of its own batch.
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { action: "fold", ids: "e1" }), false);
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { action: "status" }), true);

  const shape = { turns: 8, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const bashResultIds = (built) => built.turnEntries.map((ids) => ids[2]);

  // BETWEEN EPOCHS THE LADDER CUTS AT THE FRONTIER, AND NOT BEFORE IT.
  //
  // This half INVERTED on 2026-08-23 and the inversion is the point of the redesign. It
  // used to read "the ladder stages nothing", which was the answer to eager staging
  // crowding the agent out of choosing spans. The agent no longer chooses spans: the
  // runtime cuts and the agent edits, so a cut standing in front of the agent is the
  // mechanism rather than the interference. What has to hold instead is that the cut is
  // BOUNDED by the threshold below and COSTS NOTHING until a commit applies it.
  const thin = await epochToolRuntime({ ...shape, turns: 1, resultChars: 2_000 });
  await measure(thin, 20_000, 100_000);
  await project(thin);
  await settle();
  assert.equal((await frontierCuts(thin)).length, 0,
    "The frontier cut a window holding less than minFoldChars of raw material");

  const quiet = await epochToolRuntime(shape);
  await measure(quiet, 20_000, 100_000);
  const cut = await frontierCuts(quiet);
  const cutProjection = await project(quiet);
  await settle();
  assert(cut.length >= 1, "The frontier cut nothing on a window full of raw material");
  assert(cut.every((mark) => mark.briefed === false),
    "A frontier cut arrived already briefed, so the agent has nothing to add");
  // AND THE CUT IS BYTE-INERT. The agent still sees every raw byte the cut covers, no
  // placeholder stands in for any of it, and nothing names the pending mark. This is the
  // property the whole design rests on: annotating a fold costs the window nothing,
  // because the fold is not in the window yet.
  // The ids DO appear, in one place: the ephemeral notice that asks for briefs, which is
  // the only way the agent can name a fold to brief it. Everywhere else the window is
  // untouched, and that is the claim: no placeholder stands in for any covered byte, and
  // every raw message the cuts cover is still there in full.
  const noticeType = "pi-fold-active-context-fold-notice";
  const body = cutProjection.messages.filter((message) => message?.customType !== noticeType);
  const bodyText = json.stableStringify(body);
  for (const mark of cut) {
    assert.equal(bodyText.includes(mark.id), false,
      `Frontier cut ${mark.id} was rendered into the window outside the notice`);
  }
  assert.equal(/pi-fold-active-context-fold\b/.test(bodyText), false,
    "A frontier cut put a fold placeholder in the window before any commit");
  for (const ids of quiet.built.turnEntries) {
    assert(quiet.branch.some((entry) => entry.id === ids[2]),
      `Raw entry ${ids[2]} left the branch before any commit`);
  }
  const again = json.stableStringify((await project(quiet)).messages);
  assert.equal(again, json.stableStringify(cutProjection.messages),
    "A second pass over the same window moved a byte");

  // AN EPOCH THE AGENT CURATED: the agent's mark applies, AND the ladder fills the
  // rest of the drop in the same commit. This is the assertion that inverted: the
  // stand-down build required every applied fold to be the agent's, which is what
  // commits a barely-moved window when the agent marks one small span.
  // WHAT THE AGENT CONTRIBUTES IS THE BRIEF, so that is what has to survive the commit.
  // This half used to read ORIGIN: an applied fold whose origin was "agent" proved the
  // agent's own span had not been displaced by the fill. There are no agent-origin spans
  // any more, because the agent does not choose spans. The property underneath it is
  // unchanged and is asserted directly: the words the agent wrote reach the projection
  // verbatim, on the fold it wrote them for, and the fill lands around it without
  // overwriting it.
  const curated = await epochToolRuntime(shape);
  const written = "One completed inspection stays exactly recoverable behind this fold.";
  const curatedCuts = await frontierCuts(curated);
  assert(curatedCuts.length >= 2, "The frontier left too little to measure a fill around");
  const briefedCut = curatedCuts[0];
  const marked = await briefCut(curated, briefedCut, written);
  assert(!marked.isError, "The agent's brief was refused");
  const curatedEpoch = await runtimeCommit(curated, { tokens: 95_000, contextWindow: 100_000 });
  assert(curatedEpoch.fired, "The curated epoch did not fire");
  const carried = curatedEpoch.applied.find((fold) => fold.id === briefedCut.id);
  assert(carried, `The briefed fold did not apply: ${JSON.stringify(curatedEpoch.applied)}`);
  const carriedFold = materialized(curated).folds.find((fold) => fold.id === briefedCut.id);
  assert(carriedFold, "The briefed fold left the forest");
  assert(carriedFold.brief.endsWith(` · Agent: ${written}`),
    `The commit overwrote the agent's own words: ${carriedFold.brief.slice(-200)}`);
  assert(carriedFold.brief.length > written.length + 12,
    "The composed brief carries no deterministic head beside the agent's words");
  assert.equal(carriedFold.provenance.kind, "augmented",
    "The agent's brief landed with someone else's provenance");
  // And the commit fills AROUND it rather than standing down at the one span it named.
  assert(curatedEpoch.applied.length >= 2,
    "The commit applied only the briefed fold, so it lands at whatever depth the agent reached");
  // ONE commit carries all of it. Two commits would be two prefix rewrites.
  assert.equal(curatedEpoch.commits.filter((record) => record.deferred === false).length, 1,
    `The drop was split across ${curatedEpoch.commits.length} commits instead of one`);
  const appliedIds = curatedEpoch.applied.map((fold) => fold.id);
  assert.equal(new Set(appliedIds).size, appliedIds.length,
    "Two applied folds shared a mark id, so the fill re-claimed a span");
  // A curated epoch reaches at least the depth an ignored one does, which is the whole
  // point: curating must not cost the window its drop.
  const ignoredForDepth = await epochToolRuntime(shape);
  const ignoredEpoch = await runtimeCommit(ignoredForDepth, { tokens: 95_000, contextWindow: 100_000 });
  assert(curatedEpoch.freedTokens >= ignoredEpoch.freedTokens * 0.9,
    `Curating cost the window its drop: curated freed ${curatedEpoch.freedTokens}, ` +
    `ignored freed ${ignoredEpoch.freedTokens}`);

  // AN EPOCH THE AGENT IGNORED: the ladder fills fresh at commit time, and the fill
  // covers the unlisted tool's completed batches.
  const runtime = await epochToolRuntime(shape);
  await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  const toolFolds = materialized(runtime).folds.filter((fold) => fold.kind === "tool-result");
  assert(toolFolds.length, "The commit-time fill never folded an unlisted tool's batch");
  assert(toolFolds.some((fold) =>
    fold.parts.some((part) => bashResultIds(runtime.built).includes(part.ref?.entryId))),
  "The fill covered something other than the bash results");

  // And with the tool blacklisted, the fill claims no tool batch at all. The chapter
  // fill may still take the span; the tool fill, which is what the list governs, may not.
  const barredRuntime = makeRuntime(makeFixture(shape), { blacklistAutoFoldTools: new Set(["bash"]) });
  await startRuntime(barredRuntime);
  await runtimeCommit(barredRuntime, { tokens: 95_000, contextWindow: 100_000 });
  assert.deepEqual(
    materialized(barredRuntime).folds.filter((fold) => fold.kind === "tool-result"), [],
    "The blacklisted tool's results were folded by the fill anyway",
  );
  return {
    defaultBlacklist: [...context.AUTO_FOLD_BLACKLIST_DEFAULT],
    frontierCutsBeforeAnyCommit: cut.length,
    thinWindowCuts: 0,
    curatedEpochOrigins: [...new Set(curatedEpoch.applied.map((fold) => fold.origin))],
    curatedFreedTokens: curatedEpoch.freedTokens,
    ignoredFreedTokens: ignoredEpoch.freedTokens,
    curatedCommits: curatedEpoch.commits.filter((record) => record.deferred === false).length,
    fillToolFolds: toolFolds.length,
    blacklistedFillToolFolds: 0,
  };
}

/**
 * DELIVERY IS CACHE-SAFE, OR IT DOES NOT HAPPEN.
 *
 * The slate has exactly two push carriers, and both of them ride a rewrite the runtime
 * was already paying for: the pre-commit last call and the post-commit rider. There is
 * no surfacing carrier of its own, because a block appended at a moving tail diverges
 * the prefix every pass whatever it says -- 21.9% of every input token in rep 21, on a
 * 1503-character slate against a 1.5M-character prompt.
 *
 * The third delivery point is status, and status is a READ: it reports what the next
 * carrier would say without issuing it, spending the precision budget, or moving a
 * suppression counter, because `status` is a read-only context action and the tool-batch
 * safety scan is built on read-only actions not writing durable state.
 */

/**
 * THE BRIEF UPGRADE RIDES THE COMMIT BOUNDARY.
 *
 * Fold briefs are model-written; the deterministic brief is the failure fallback. The
 * automatic ladder cannot wait on a provider inside a commit, so it commits deterministic
 * and the model brief lands as an UPGRADE on the NEXT commit, inside a rewrite the
 * session already paid for. This pins all four halves of that law: the upgrade happens,
 * it is visible in the stream, it never happens between boundaries, and it never touches
 * a brief the agent wrote. The failure leg is the fifth: a generator that throws leaves
 * the deterministic brief standing and says so on the record.
 */
function deepFreezeMarks(marks) {
  let frozen = 0;
  const walk = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    Object.freeze(value);
    frozen += 1;
    for (const inner of Array.isArray(value) ? value : Object.values(value)) walk(inner);
  };
  walk(marks);
  return frozen;
}

async function gateMarkReadsTakeAView() {
  const built = makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  const seeded = context.topUpMarks({ snapshot, state: empty, ordinal: 3, targetShare: 1 }).slice(0, 4);
  // Anti-vacuity: one mark cannot show a per-mark cost, and a fixture whose marks
  // resolve to nothing would let every reading below return without doing the work.
  assert(seeded.length >= 3,
    `The fixture seeded ${seeded.length} marks, too few to read a per-mark cost`);
  const state = context.withPendingMarks(empty, seeded);

  // The read is the state's own array, not a copy of it, and stays so across reads.
  const first = context.pendingMarks(state);
  assert.equal(first, state.pendingMarks, "A mark reading copied the state's own array");
  assert.equal(first, context.pendingMarks(state), "Two mark readings returned different arrays");
  assert.equal(context.pendingMarks(empty).length, 0, "An unmarked state did not read as empty");

  // Every reading now runs against a frozen array AND frozen marks. A reading that
  // mutates either the array or a mark's own fields throws here.
  const frozenObjects = deepFreezeMarks(state.pendingMarks);
  assert(Object.isFrozen(context.pendingMarks(state)),
    "The reading handed back something other than the frozen array, so the mutation check is vacuous");
  // Anti-vacuity: the deep freeze must have reached inside the marks, not just the array.
  // A mark carries parts, and a raw part carries a ref, so the count is well past one per
  // mark; a fixture whose marks were bare would make the deep half of this check empty.
  assert(frozenObjects > seeded.length * 2,
    `The deep freeze reached ${frozenObjects} objects for ${seeded.length} marks, so it never got inside them`);
  for (const mark of state.pendingMarks) {
    assert(Object.isFrozen(mark), `Mark ${mark.id} was not frozen, so a write to its fields would pass`);
    for (const part of mark.parts ?? []) {
      assert(Object.isFrozen(part), `A part of mark ${mark.id} was not frozen`);
    }
  }
  const accounting = context.markAccounting(snapshot, state);
  const claimed = context.claimedRefKeys(state);
  const marked = context.markedFoldIds(state);
  const duplicate = context.addPendingMark(state, seeded[0]);
  for (const mark of context.pendingMarks(state)) {
    assert(context.markEligibility(snapshot, state, mark),
      `Mark ${mark.id} read no eligibility at all`);
  }
  // Anti-vacuity: the accounting must have RESOLVED spans, which is the path that
  // consults the marks per mark. Zero freed bytes would mean nothing was walked.
  assert(accounting.freedBytes > 0,
    "The accounting freed no bytes, so the per-mark span resolution never ran");
  assert(claimed.size > 0, "The claimed keys resolved nothing, so no span was walked");
  assert.equal(duplicate.added, false, "A duplicate mark was added rather than refused");
  assert.equal(context.pendingMarks(state).length, seeded.length,
    "A reading changed how many marks the state holds");

  // The write path still owns its copy: a caller's array never becomes the state's.
  const handed = [...seeded.slice(0, 2)];
  const written = context.withPendingMarks(empty, handed);
  assert.notEqual(written.pendingMarks, handed, "The write path stored the caller's own array");
  handed.length = 0;
  assert.equal(written.pendingMarks.length, 2, "Emptying the caller's array reached committed state");
  assert.equal(context.pendingMarks(state).length, seeded.length,
    "The write path disturbed the state it was not given");

  return {
    marksRead: seeded.length,
    readIsStateArray: true,
    frozenDuringReadings: true,
    frozenObjects,
    accountingFreedBytes: accounting.freedBytes,
    claimedKeys: claimed.size,
    markedFoldIds: marked.size,
    writeCopies: true,
  };
}

/**
 * An evidence digest is derived once per message OBJECT.
 *
 * A digest canonicalizes and hashes the whole message, and these messages are transcript
 * entries in the tens of kilobytes. `exactMapped` recomputed one on every lookup to
 * confirm a ref that had itself been computed from that same object at mapping time, and
 * the selection, surfacing, ordering and accounting passes call `exactMapped` once per
 * ref, per fold, several times a turn. Replayed against the sealed sol-20260812 rep-2
 * session at its 85 percent point, that recomputation alone was 76 percent of all CPU:
 * 30 real messages took 48.1 seconds before and 9.3 after.
 *
 * The rule is gate 113's, applied one layer down. The session is append-only, entries are
 * never edited in place, so the derivation is kept against the OBJECT and a replaced
 * object misses rather than serving a stale answer.
 *
 * Two properties have to hold together and the gate pins both, because either alone can
 * be satisfied by a cache that is wrong. Content addressing must survive: two separate
 * objects carrying identical content still digest the same, so nothing keyed on identity
 * leaks into what a digest MEANS. And the keying must be real: a message whose content
 * differs digests differently even though it was built from the first one. The stated
 * cost of the memo is asserted rather than hidden, so it can never be mistaken for a bug
 * found later: a message mutated IN PLACE keeps its first digest.
 */
async function gateEvidenceDigestDerivedOncePerObject() {
  const body = "t".repeat(64_000);
  const make = () => ({
    role: "toolResult",
    toolCallId: "call-digest",
    toolName: "read",
    content: [{ type: "text", text: body }],
    isError: false,
  });
  const first = make();
  const digest = json.evidenceSha256(first);
  assert.equal(typeof digest, "string");
  assert.equal(digest.length, 64, "An evidence digest is not a sha256");
  // Anti-vacuity: a message small enough to hash for free would prove nothing about a
  // memo, and an empty body would make the mutation below unobservable either way.
  assert(JSON.stringify(first).length > 50_000,
    "The fixture message is too small for a recomputation to be worth avoiding");

  // Content addressing survives: a DIFFERENT object with identical content digests the
  // same, so the memo did not turn a content digest into an identity digest.
  assert.equal(json.evidenceSha256(make()), digest,
    "Two distinct objects with identical content digested differently");
  // The keying is real: content that differs digests differently.
  const changed = { ...make(), content: [{ type: "text", text: `${body}!` }] };
  assert.notEqual(json.evidenceSha256(changed), digest,
    "A message with different content reused another message's digest");
  // A replaced object misses rather than serving stale: same content, rebuilt, still
  // agrees with a digest computed on a path that never saw the original.
  assert.equal(json.evidenceSha256(structuredClone(first)), digest,
    "A rebuilt copy of the message did not digest to the same value");

  // The stated cost, asserted: an in-place edit keeps the first digest. This is the
  // behaviour the memo buys and it is pinned here so it stays a decision on the record.
  first.content[0].text = `${body} edited in place`;
  assert.equal(json.evidenceSha256(first), digest,
    "The digest is not kept against the object, so the memo is not in effect");
  // And the edited CONTENT still digests to something else when carried by a new object,
  // which is what keeps the mutation invisible only to the object that was already seen.
  assert.notEqual(json.evidenceSha256({ ...first, content: structuredClone(first.content) }), digest,
    "The edited content digests the same through a fresh object, so content is not being read at all");

  return {
    digestChars: digest.length,
    fixtureBytes: JSON.stringify(make()).length,
    contentAddressedAcrossObjects: true,
    distinctContentDistinctDigest: true,
    keptAgainstTheObject: true,
  };
}

/**
 * A BATCHED BRIEF NAMES THE BYTES IT WAS MADE FROM.
 *
 * `context.brief` carries a `source_sha256` that is supposed to say which source a brief
 * was generated from. A batched request holds its source on the spans and carries no
 * `sourceText` of its own, so the record hashed the empty string: every batched brief in
 * every session ever recorded reported the digest of "" beside a `source_chars` in the
 * hundred thousands. Since gate 118 made batching the normal path, that was the only value
 * the field ever took. A constant that looks like a measurement is worse than an absent one.
 *
 * Attribution was never lost, and this gate does not pretend otherwise: `fold_ids` names
 * every fold in the batch and is what a provenance join reads. What was lost is the ability
 * to say WHICH BYTES produced a brief, which is exactly the question worth asking when a
 * brief looks wrong.
 */
async function gateVanishedCommitAnnouncesItself() {
  const shape = { turns: 10, resultChars: 12_000, contextWindow: 100_000 };

  // 1. REACHABILITY, PROVEN RATHER THAN ASSUMED. Fold a real commit's worth of state, then
  //    project it against a snapshot whose branch no longer carries the evidence. If the
  //    arriving folds survive that, the silent branch below is unreachable and this whole
  //    gate would be theatre, so it is asserted first.
  const runtime = makeRuntime(makeFixture({ ...shape, sessionId: "vanish-reach" }));
  await startRuntime(runtime);
  await measureAndCommit(runtime, 80_000, 100_000);
  const committed = materialized(runtime);
  assert(committed.folds.length > 0, "The fixture folded nothing, so nothing could vanish");

  const stranded = context.persistenceProjection(committed, context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: [],
    contextEntries: [],
    contextWindow: runtime.built.contextWindow,
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  }));
  assert.equal(stranded.folds.length, 0,
    "A fold whose evidence left the branch survived the persistence projection");

  // 2. AND STRIPPED OF ITS FOLDS IT IS INDISTINGUISHABLE FROM THE STATE THAT PRECEDED IT.
  //    This is the trap: a write arrives carrying folds, the projection removes every one,
  //    and what is left compares byte-equal to what is already durable, so persist() reads
  //    it as "nothing changed". `sameStateProjection` normalizes the revision away, which is
  //    precisely why the comparison cannot tell a real no-op from a commit that evaporated.
  //    Only the fold sets are compared here; the surrounding bookkeeping a commit also moves
  //    (briefs, ledgers, and since the 2026-08-23 retune a staged frontier mark the
  //    shallower aim left pending) is not what makes the two states look alike in the
  //    live failure, so it is stripped alongside the folds rather than proven equal.
  const foldless = (state) => {
    const bare = { ...state, folds: [], expanded: [] };
    delete bare.pendingMarks;
    delete bare.briefs;
    return bare;
  };
  assert.equal(
    context.sameStateProjection(foldless(stranded), foldless(committed)),
    true,
    "Stripping the folds did not make the stranded write look like its predecessor",
  );
  assert(committed.folds.length > 0 && stranded.folds.length === 0,
    "The fixture did not actually strand any fold, so this proves nothing");

  // 3. SO THE SILENT RETURN MUST BE GUARDED. The condition is reachable and it is silent by
  //    construction, which is what killed sol-20260812 rep 3: a band-top commit at revision
  //    143 folded 579,489 source chars, durable state never passed 134, none of its 11 folds
  //    reached a record, and occupancy ran past its budget with nothing reported.
  const source = readFileSync(new URL("../extensions/active-context.ts", import.meta.url), "utf8");
  const guard = source.slice(
    source.indexOf("if (sameStateProjection(next, persistence.persisted))"),
    source.indexOf("persistence.state = clone(persistence.persisted);"),
  );
  assert(guard.length > 0, "The persistence no-op branch was not found where it is pinned");
  assert(/arrivingFoldIds\.length/.test(guard) && /throw new Error/.test(guard),
    "persist() still returns quietly when an arriving commit projects down to the durable baseline");
  assert(/Active-context commit discarded at persistence/.test(guard),
    "The raised failure does not name itself as a discarded commit");
  // Actionable, not merely present: it names how many folds were lost and the revision.
  assert(/arriving fold\(s\)/.test(guard) && /at revision \$\{/.test(guard),
    "The raised failure does not name the lost folds and the revision they were lost at");
  // The count is read BEFORE the projection, or it would always report zero.
  const preamble = source.slice(
    source.indexOf("let next = clone(persistence.state);"),
    source.indexOf("if (ctx && lifecycle.latestSnapshot?.sessionId === next.sessionId)"),
  );
  assert(/arrivingFoldIds/.test(preamble),
    "The arriving folds are counted after the projection that drops them, so the count is always zero");

  return {
    committedFolds: committed.folds.length,
    strandedFolds: stranded.folds.length,
    strandedLooksLikeNoOp: true,
    guarded: true,
  };
}

/**
 * SUSPENDING AUTOMATIC FOLDING IS AN EVENT.
 *
 * Gate 122 made a commit that vanishes at persistence RAISE. This is the other half: what
 * happens to the raise. It routes to `suspendAutomatic`, which latched the failure, wrote
 * a pending note, and called `ctx.ui.notify`. A headless host has no `ui`, so `safeNotify`
 * swallowed the only report, and the canonical event stream, the thing an adjudicator
 * actually reads, carried nothing at all.
 *
 * That is how sol-20260812 reps 3 and 4 died. In both, the LAST applied commit emitted its
 * `context.commit` and eleven `context.fold` records and persisted none of them: rep 3
 * committed at revision 143 with durable state stopped at 134, rep 4 at revision 153 with
 * durable state stopped at 143, neither wrote a single fold record for those eleven folds,
 * and both were one receipt short. The next projection in each read the rolled-back
 * revision and classified itself "append" while naming the commit as its cause. Nothing
 * folded again in either session; occupancy climbed unopposed and the run died at the
 * context wall. Rep 2, same plan and same seed, ran ten applied commits with every fold
 * landing, so the failure is rare rather than systemic, which is exactly why it has to be
 * on the record the first time it happens.
 *
 * The gate makes a durable write fail for real and reads the stream back.
 */
async function gateSuspensionAnnouncesItself() {
  const shape = { turns: 10, resultChars: 12_000, contextWindow: 100_000 };

  // 1. ANTI-VACUITY. The same fixture, unsabotaged, must commit folds and stay quiet. If it
  //    folded nothing there would be no durable write to fail, and if it announced a
  //    suspension anyway the assertions below would pass on an unrelated event.
  const clean = makeRuntime(makeFixture({ ...shape, sessionId: "suspend-clean" }));
  await startRuntime(clean);
  const cleanState = await measureAndCommit(clean, 80_000, 100_000);
  assert(cleanState.folds.length > 0, "The fixture folded nothing, so no durable write could fail");
  assert.equal(contextEvents(clean).filter((event) => event.kind === "context.suspend").length, 0,
    "A healthy commit announced a suspension");

  // 2. THE FAILURE, FOR REAL. A fold record is the first durable write a commit makes, so
  //    failing it reproduces the shape both dead runs left behind: folds computed, folds
  //    emitted, no record, state rolled back.
  let fault = "durable fold record refused by the fixture";
  let armed = true;
  const runtime = makeRuntime(makeFixture({ ...shape, sessionId: "suspend-loud" }), {
    beforeAppend(customType) {
      if (armed && customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY) throw new Error(fault);
    },
  });
  await startRuntime(runtime);
  // A clean rollback suspends on the first one now, so one failing commit is the whole
  // scenario. A second is driven anyway, to prove the announcement does not repeat itself
  // once folding has stopped and that nothing quietly resumed.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await measureAndCommit(runtime, 80_000 + attempt * 2_000, 100_000, `attempt-${attempt}`);
  }

  const announcements = () => contextEvents(runtime).filter((event) => event.kind === "context.suspend");
  const suspensions = () => announcements().filter((event) => event.outcome === "suspended");
  assert.equal(suspensions().length, 1,
    `Automatic folding was suspended without one announcement (got ${suspensions().length})`);
  const [suspend] = suspensions();

  // 3. IT NAMES THE CAUSE. A record that says only "something failed" would have left both
  //    dead runs exactly as unexplained as they were.
  assert(String(suspend.error).includes(fault),
    `The suspension does not carry the failure that caused it: ${suspend.error}`);
  assert(typeof suspend.phase === "string" && suspend.phase.length > 0,
    "The suspension does not say which lifecycle phase failed");
  assert.equal(suspend.repeat, false, "The first suspension reported itself as a repeat");
  assert(["none", "record-only", "state-committed"].includes(suspend.disposition),
    `The suspension does not classify what it left durable: ${suspend.disposition}`);

  // 4. IT CARRIES THE TWO REVISIONS WHOSE DISAGREEMENT IS THE SYMPTOM. In both dead runs the
  //    only visible trace was a projection reading a revision the commit had already passed.
  assert(Number.isSafeInteger(suspend.state_revision) && Number.isSafeInteger(suspend.durable_revision),
    "The suspension does not carry the in-memory and durable revisions");
  assert(Number.isSafeInteger(suspend.folds_durable) && Number.isSafeInteger(suspend.fold_records_durable),
    "The suspension does not say what durable state was left holding");

  // 5. AND FOLDING REALLY DID STOP, which is what makes the announcement worth having: a
  //    suspended session cannot reclaim anything, so every later measurement is inflow with
  //    no relief. Driving more pressure must produce no further applied commit.
  const before = contextEvents(runtime).filter(
    (event) => event.kind === "context.commit" && event.deferred === false).length;
  await measureAndCommit(runtime, 95_000, 100_000, "post-suspend");
  const after = contextEvents(runtime).filter(
    (event) => event.kind === "context.commit" && event.deferred === false).length;
  assert.equal(after, before, "Automatic folding kept committing after it reported itself suspended");

  // 6. REPEATS ARE BOUNDED BY DISTINCT CAUSES, NOT BY PASSES. The same message again adds
  //    nothing; a different message is new information and is reported once.
  assert.equal(suspensions().length, 1,
    "A suspended runtime re-announced the same failure on a later pass");
  fault = "a different durable refusal";
  armed = false;
  await measureAndCommit(runtime, 96_000, 100_000, "post-suspend-2");
  assert.equal(suspensions().length, 1,
    "A pass that failed nothing new still announced a suspension");

  return {
    announced: suspensions().length,
    phase: suspend.phase,
    disposition: suspend.disposition,
    stateRevision: suspend.state_revision,
    durableRevision: suspend.durable_revision,
    foldsStopped: after === before,
  };
}

/**
 * A FOLDED HEAD NEVER LIMITS REACH.
 *
 * The rep-3 shape at fixture scale: a head of tool results the ladder has ALREADY folded,
 * whose raw bytes alone exceed the whole window this fixture is measured against. Under
 * the positional law that head was charged its original mass against a byte allowance, so
 * the reach halted inside its own placeholders and every rung starved on a window that was
 * mostly foldable. Measured on the sealed rep-3 state 2026-08-10: 17 folded head results
 * cost 1,002,801 raw bytes against a 1,072,081-byte allowance, the reach froze at index 36
 * of 133, three passes had nothing proposable, and the run died against the fence at 0.972
 * occupancy with 25 takeable batches above the line.
 *
 * Spending PROJECTED bytes on the same walk was the first fix, and it worked; Shane's
 * ruling deleted the walk instead. The arithmetic here is membership arithmetic now: what
 * the head costs, raw or projected, decides nothing, because a batch is a member of the
 * foldable class or it is not and no accumulated prefix can spend that away.
 *
 * The property, in one line: folding must never shrink what folding can reach next.
 */
async function gateProjectedStaleBasis() {
  const budget = 60_000;
  const built = makeFixture({ turns: 40, resultChars: 12_000, contextWindow: budget });
  // Fold the head against a wide window, which is how the real prefix got there: earlier
  // commits, at earlier occupancies.
  const wide = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 400_000,
    netBudget: true,
  });
  let state = context.emptyActiveContextState(built.sessionId);
  const head = 17;
  for (let batch = 0; batch < head; batch += 1) {
    const candidate = context.selectAutomaticSpan(wide, state);
    assert(candidate, `The head ran out of foldable batches after ${batch}`);
    state = (await commitCandidate(state, wide, candidate, { now: batch + 1 })).state;
  }
  const snapshot = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: budget,
    netBudget: true,
  });

  // (a) THE FIXTURE REALLY IS THE SHAPE: the folded head alone outweighs the budget the
  // rest of the window has to fit inside, which is what made the byte walk starve.
  const foldedIndices = new Set(context.orderedRoots(state, snapshot)
    .flatMap((root) => Array.from({ length: root.end - root.start + 1 }, (_, step) => root.start + step)));
  assert.equal(context.orderedRoots(state, snapshot).length, head,
    "The head did not fold the roots it declares");
  let coveredRaw = 0;
  for (const index of foldedIndices) coveredRaw += bytesOf(built.messages[index]);
  assert(coveredRaw > snapshot.budgetTokens,
    `The folded head costs ${coveredRaw} raw bytes against a ${snapshot.budgetTokens}-token budget, so it does not starve a byte walk`);
  const prefixEnd = Math.max(...foldedIndices);

  // (b) AND THE LADDER REACHES STRAIGHT PAST IT. Every unfolded batch nothing holds is a
  // member, whatever the head cost, and the rung takes the stalest of them.
  const indexOf = new Map(snapshot.mapped.flatMap((item) =>
    item.ref ? [[json.objectRefKey(item.ref), item.index]] : []));
  const indices = (candidate) => candidate.sourceRefs.map((ref) => indexOf.get(json.objectRefKey(ref)) ?? -1);
  const reached = context.selectAutomaticSpan(snapshot, state);
  assert(reached, "The class law proposed nothing on a window full of unfolded batches");
  assert.equal(reached.kind, "tool-result", `The rung took a ${reached.kind}, not the tool batch`);
  const firstReached = Math.min(...indices(reached));
  assert(firstReached > prefixEnd,
    `The rung took index ${firstReached}, which is inside the folded head`);
  const nextUnfolded = built.messages.findIndex((message, index) =>
    index > prefixEnd && message?.role === "toolResult");
  assert.equal(firstReached, nextUnfolded,
    `The rung skipped past the stalest unfolded batch at ${nextUnfolded}`);

  // AND THE HEAD IS NOT WHAT DECIDES IT. The same window with no folds at all offers the
  // same members past the prefix, so reach is independent of what folding already took.
  const unfoldedState = context.emptyActiveContextState(built.sessionId);
  // THE POPULATION IS BOTH RUNGS. Automatic selection proposes a tool batch when one is
  // available and a CHAPTER otherwise, so a mirror that counts batches alone measures half
  // the ladder and disagrees with the remainder on any window carrying chapter material
  // (Shane, 2026-08-23). Derived here rather than imported, so this stays an independent
  // reading of the same law rather than a restatement of the runtime's own line.
  const memberIndices = (value) => {
    const members = new Set(context.automaticToolBatches(snapshot, value)
      .flatMap((batch) => batch.indices));
    const walked = new Set();
    for (let pass = 0; pass < snapshot.mapped.length; pass += 1) {
      const chapter = context.selectAutomaticChapter(snapshot, value, walked);
      if (!chapter) break;
      for (const ref of chapter.sourceRefs) {
        walked.add(json.objectRefKey(ref));
        const item = snapshot.mapped.find((entry) =>
          entry.ref && json.objectRefKey(entry.ref) === json.objectRefKey(ref));
        if (item) members.add(item.index);
      }
    }
    return members;
  };
  const withHead = memberIndices(state);
  const withoutHead = memberIndices(unfoldedState);
  const pastPrefix = (set) => [...set].filter((index) => index > prefixEnd).sort((a, b) => a - b);
  assert.deepEqual(pastPrefix(withHead), pastPrefix(withoutHead),
    "The folded head changed which spans past it are members, so folding still shrinks reach");
  assert(pastPrefix(withHead).length > 0, "There is nothing past the prefix to measure");

  // (c) AND THE COMMIT CLEARS THE FENCE LINE. Rep 3's window could not be transmitted at
  // all; the reconstruction under the class law frees enough to fit.
  const before = bytesOf(context.projectActiveContext(snapshot, state));
  assert(before / 4 > budget,
    `The fixture projects ${Math.round(before / 4)} tokens, already inside a ${budget}-token budget`);
  let marked = state;
  const marks = context.topUpMarks({
    snapshot, state: marked, ordinal: 1, targetShare: 1, eligibleOnly: true,
  });
  for (const mark of marks) {
    const addition = context.addPendingMark(marked, mark);
    if (addition.added) marked = addition.state;
  }
  const committed = await context.commitPendingMarks({
    snapshot, state: marked, generation: 1, retainIneligible: true, guardCurrentTurn: true,
  });
  const after = bytesOf(context.projectActiveContext(snapshot, committed.state));
  assert(committed.applied.length > 0, "The commit applied nothing");
  assert(after / 4 < budget,
    `The commit left ${Math.round(after / 4)} tokens against a ${budget}-token budget, still over the fence`);

  // (d) ONE DEFINITION OF STALE. What the last call announces is what the ladder can
  // take: the remainder counts member results and nothing else, which is the same
  // enumeration the selector picks its proposal out of.
  //
  // The scoping needs a HOLD to be visible at all, and it needs one stated rather than
  // assumed. This used to read the fresh tail, which held the newest results back for
  // free; with the proportion deleted every unclaimed result is a member and the two
  // counts came out equal, which reads as "the scoping is not being measured" because
  // that is exactly what it was. A pin is the hold that remains, so the fixture lays one.
  const pinnedTail = snapshot.mapped.find((item) =>
    item.ref && item.index > prefixEnd && item.message?.role === "toolResult");
  assert(pinnedTail, "There is no unfolded result past the prefix to hold");
  const held = context.protectEvidence(snapshot, state, [pinnedTail.ref.entryId], true);
  const remainder = context.unmarkedRemainder(snapshot, held, 4);
  const claimed = context.claimedRefKeys(held);
  const heldMembers = memberIndices(held);
  const announced = snapshot.mapped.filter((item) => item.ref && heldMembers.has(item.index) &&
    !claimed.has(json.objectRefKey(item.ref)));
  assert(remainder.spans > 0, "The remainder announced nothing on a window full of unfolded batches");
  assert.equal(remainder.spans, announced.length,
    `The remainder announced ${remainder.spans} spans against ${announced.length} members`);
  // THE PIN HAS TO REMOVE SOMETHING, or the scoping above is asserted against a population
  // nothing was ever held out of. Compared like with like: the same member population read
  // WITHOUT the pin. It used to compare members against every unclaimed tool result, which
  // stopped being a bound the moment chapters joined the population.
  const unheldMembers = memberIndices(state);
  const unheldAnnounced = snapshot.mapped.filter((item) => item.ref &&
    unheldMembers.has(item.index) && !claimed.has(json.objectRefKey(item.ref)));
  assert(unheldAnnounced.length > announced.length,
    `The pin removed nothing from the population (${unheldAnnounced.length} either way), ` +
    "so the scoping is not being measured");

  return {
    foldedHeadRoots: head,
    headRawBytes: coveredRaw,
    budgetTokens: snapshot.budgetTokens,
    prefixEnd,
    rungIndex: firstReached,
    membersPastPrefix: pastPrefix(withHead).length,
    membersPastPrefixUnfolded: pastPrefix(withoutHead).length,
    appliedMarks: committed.applied.length,
    projectionTokens: [Math.round(before / 4), Math.round(after / 4)],
    announcedMemberSpans: remainder.spans,
    memberSpansWithoutTheHold: unheldAnnounced.length,
  };
}

/**
 * A NAME THE STATE CANNOT RESOLVE IS ANSWERED, NOT THROWN AND NOT DISCARDED BLIND.
 *
 * A mark's parts name folds by id, and the state can stop holding one between the mark
 * and the commit: the `reboundary` dissolve removes a root while consulting only
 * `fold.parentId`, so nothing there consults the pending marks. Every reading that
 * merely REPORTS on a mark used to resolve that name through `candidateSourceRefs`,
 * which throws by design for a candidate being prepared, so `markAccounting` and
 * `schedulingStatus` threw out of an agent-facing status call and out of every commit
 * pass, on state the runtime itself had produced (Shane 2026-08-10).
 *
 * Two answers, and only two, because the eligibility reading already carries exactly
 * this vocabulary. Nothing standing will mint the fold: the decision can never be
 * honoured, so it is DROPPED with a receipt naming the fold, the way a brief upgrade
 * whose fold changed identity is dropped rather than deferred. Something standing will
 * mint it: the span is only unreadable this pass, so the mark DEFERS and stays pending.
 *
 * Anti-vacuity: each half asserts the unguarded resolution still throws on the very
 * parts under test, before asserting the answer, so a fixture that quietly stopped
 * dangling would fail here rather than pass hollow. The deferring half additionally
 * asserts the SAME parent is dropped when nothing pending names its child, so the
 * deferral is a decision rather than a blanket retain.
 */
async function gateDanglingChildMarks() {
  const childMarkAt = (snap, state, index) => {
    const candidate = context.manualFoldCandidate(snap, state, [snap.mapped[index].ref.entryId]);
    return context.foldMarkFor({
      candidate,
      brief: context.automaticToolBrief(snap, candidate),
      briefProvenance: { kind: "deterministic" },
      origin: "ladder",
      ordinal: context.markOrdinal(snap),
    });
  };
  // The absorbing span, named off the child the way `foldMarkFor` already names it: two
  // raw entries and the fold. Neither raw part is a tool result, which is what lets the
  // turn boundary hold the child without holding the parent.
  const parentMarkAt = (snap, index, child) => context.foldMarkFor({
    candidate: {
      kind: "chapter",
      parts: [
        { kind: "raw", ref: snap.mapped[index - 2].ref },
        { kind: "raw", ref: snap.mapped[index - 1].ref },
        { kind: "fold", foldId: child.id },
      ],
      // Empty on purpose: the refs cannot be resolved while the child is a mark.
      sourceRefs: [],
    },
    brief: "One task turn kept whole, with the read it made already behind a placeholder.",
    briefProvenance: { kind: "deterministic" },
    origin: "ladder",
    ordinal: context.markOrdinal(snap),
  });

  // HALF ONE: the fold is gone for good.
  const built = makeFixture({
    sessionId: "dangling-child-test", turns: 12, resultChars: 6_000, contextWindow: 100_000,
  });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  let dissolveIndex = -1;
  for (const item of snapshot.mapped) {
    if (item.ref?.role !== "toolResult" || item.index < 2) continue;
    if (context.markEligibility(snapshot, empty, childMarkAt(snapshot, empty, item.index)) === "eligible") {
      dissolveIndex = item.index;
      break;
    }
  }
  assert(dissolveIndex >= 0, "No stale batch in the fixture can fold, so nothing can be left dangling");
  const child = childMarkAt(snapshot, empty, dissolveIndex);
  const parent = parentMarkAt(snapshot, dissolveIndex, child);
  const childCommit = await context.commitPendingMarks({
    snapshot, state: context.addPendingMark(empty, child).state, generation: 1, retainIneligible: true,
  });
  assert.deepEqual(childCommit.applied.map((mark) => mark.id), [child.id], "The child never folded");
  const holding = context.addPendingMark(childCommit.state, parent).state;
  // The control: while the fold is held every reading is ordinary.
  assert.equal(context.markEligibility(snapshot, holding, parent), "eligible",
    "The parent is not applicable even before the dissolve, so the dissolve proves nothing");
  assert.equal(context.markAccounting(snapshot, holding).eligibleMarks, 1);

  // The dissolve, as `reboundary` performs it: the fold leaves the forest, the parents
  // are re-derived, and the pending mark naming it is never consulted.
  const dissolved = {
    ...holding,
    revision: holding.revision + 1,
    folds: context.deriveFoldParents(holding.folds.filter((fold) => fold.id !== child.id)),
    expanded: holding.expanded.filter((id) => id !== child.id),
  };
  assert.equal(dissolved.folds.length, holding.folds.length - 1, "The dissolve removed no fold");
  assert.throws(() => context.candidateSourceRefs(parent.parts, dissolved),
    /Missing candidate child/,
    "The dissolved fold still resolves, so nothing below is measuring a dangling mark");

  const accounting = context.markAccounting(snapshot, dissolved);
  assert.equal(accounting.pending, 1);
  assert.equal(accounting.eligibleMarks, 0, "A mark naming a dissolved fold counted as applicable");
  assert.equal(accounting.retainedMarks, 0, "A mark that can never resolve counted as waiting");
  const status = context.schedulingStatus({ snapshot, state: dissolved, ratio: 0.9 });
  assert.equal(status.marks.length, 1);
  assert.equal(status.marks[0].eligibility, "unfulfillable",
    "A mark naming a fold nothing will mint is not reported terminal");
  assert.equal(context.markSpanStart(snapshot, dissolved, parent), snapshot.mapped.length,
    "An unreadable span does not sort past the newest entry");
  assert(context.claimedRefKeys(dissolved).size >= 2,
    "The claimed keys lost the raw parts the dangling mark still names");
  assert.equal(context.markFreedBytes(snapshot, dissolved, parent), 0);

  const dropCommit = await context.commitPendingMarks({
    snapshot, state: dissolved, generation: 2, retainIneligible: true,
  });
  assert.equal(dropCommit.applied.length, 0, "A mark naming a dissolved fold folded anyway");
  assert.equal(dropCommit.refused.length, 1);
  assert.equal(dropCommit.refused[0].retained, false, "A mark that can never resolve was kept pending");
  assert(dropCommit.refused[0].reason.includes(child.id),
    "The drop receipt does not name the fold the decision lost");
  assert.match(dropCommit.refused[0].reason, /no pending mark will mint/);
  assert.equal(context.pendingMarks(dropCommit.state).length, 0, "The dropped mark is still pending");

  // HALF TWO: the fold is not gone, it is held back this pass.
  // The hold under test was the current-turn guard until its 2026-08-23 deletion; a pin
  // is the hold that remains reachable here, and it produces the same deferral shape: a
  // child over protected evidence stays pending, and a parent naming it defers rather
  // than dropping. (The depth bound cannot make this shape: an unresolved parent sorts
  // past every resolvable mark, so a cut that spares the child spares the parent too.)
  const openBuilt = makeFixture({
    sessionId: "dangling-defer-test", turns: 12, resultChars: 6_000, contextWindow: 100_000,
    thresholds: context.DEFAULT_THRESHOLDS,
  });
  const openMessages = [...openBuilt.messages];
  const openEntries = [...openBuilt.entries];
  let tailId = openEntries.at(-1).id;
  const appendOpen = (message) => {
    const id = `${openBuilt.sessionId}-excursion-${openEntries.length}`;
    openEntries.push({ type: "message", id, parentId: tailId, message });
    openMessages.push(message);
    tailId = id;
  };
  // An excursion that never closes its turn: five reads, no terminal assistant message.
  for (let step = 0; step < 5; step += 1) {
    appendOpen({
      role: "assistant",
      content: [{
        type: "toolCall", id: `excursion-${step}`, name: "read",
        arguments: { path: `excursion-${step}.txt` },
      }],
      stopReason: "toolUse",
      timestamp: 900 + step * 2,
    });
    appendOpen({
      role: "toolResult",
      toolCallId: `excursion-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Result excursion ${step}: ${"e".repeat(6_000)}` }],
      isError: false,
      timestamp: 901 + step * 2,
    });
  }
  const openSnapshot = context.mapActiveContext({
    sessionId: openBuilt.sessionId,
    eventMessages: openMessages,
    contextEntries: openEntries,
    contextWindow: openBuilt.contextWindow,
    thresholds: context.DEFAULT_THRESHOLDS,
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  });
  const openEmpty = context.emptyActiveContextState(openBuilt.sessionId);
  // The child is the excursion's first read, exactly where the guard-era fixture put
  // it; pinning its evidence below is what holds it back this pass.
  const heldIndex = openBuilt.messages.length + 1;
  assert.equal(openSnapshot.mapped[heldIndex]?.message?.role, "toolResult",
    "The excursion's first read is not where the fixture expects it");
  assert(heldIndex >= 2, "The window is too small to carry a parent span past the child");
  const heldChild = childMarkAt(openSnapshot, openEmpty, heldIndex);
  const heldParent = parentMarkAt(openSnapshot, heldIndex, heldChild);
  let openState = context.addPendingMark(openEmpty, heldChild).state;
  openState = context.addPendingMark(openState, heldParent).state;
  // The pin, and only the pin, is what holds the child: unpinned, the same child
  // applies, so the deferral below is not measuring some other hold.
  const closedTurn = await context.commitPendingMarks({
    snapshot: openSnapshot, state: context.addPendingMark(openEmpty, heldChild).state,
    generation: 1, retainIneligible: true,
  });
  assert.deepEqual(closedTurn.applied.map((mark) => mark.id), [heldChild.id],
    "The child is held by something other than the pin, so this half measures the wrong hold");
  assert.throws(() => context.candidateSourceRefs(heldParent.parts, openState),
    /Missing candidate child/,
    "The parent already resolves, so the deferral below is not being measured");

  const pinnedState = {
    ...openState,
    protected: [structuredClone(openSnapshot.mapped[heldIndex].ref)],
  };
  assert.equal(context.markEligibility(openSnapshot, pinnedState, heldChild), "protected",
    "The pin does not hold the child, so the deferral below is not being measured");
  const deferCommit = await context.commitPendingMarks({
    snapshot: openSnapshot, state: pinnedState, generation: 1,
    retainIneligible: true,
  });
  assert.equal(deferCommit.applied.length, 0, "The guarded child folded anyway");
  const parentReceipt = deferCommit.refused.find((item) => item.id === heldParent.id);
  assert(parentReceipt, "The parent whose child the guard held produced no receipt");
  assert.equal(parentReceipt.retained, true,
    "The parent naming a guard-held child was discarded rather than deferred");
  assert.match(parentReceipt.reason, /has not minted yet/);
  assert(parentReceipt.reason.includes(heldChild.id), "The deferral receipt does not name the fold it waits on");
  const stillPending = context.pendingMarks(deferCommit.state).map((mark) => mark.id);
  assert(stillPending.includes(heldParent.id), "The deferred parent is not pending for the next commit");
  assert(stillPending.includes(heldChild.id), "The guarded child is not pending for the next commit");
  assert(deferCommit.retained.some((mark) => mark.id === heldParent.id),
    "The commit record does not count the deferred parent as deferred");

  // The contrast: the same parent, with nothing standing to mint its child, is dropped.
  const aloneCommit = await context.commitPendingMarks({
    snapshot: openSnapshot, state: context.addPendingMark(openEmpty, heldParent).state,
    generation: 1, retainIneligible: true,
  });
  assert.equal(aloneCommit.refused.length, 1);
  assert.equal(aloneCommit.refused[0].retained, false,
    "A parent with nothing to wait for was deferred, so the defer is a blanket retain");
  assert.match(aloneCommit.refused[0].reason, /no pending mark will mint/);

  return {
    dissolvedFoldIndex: dissolveIndex,
    accountingAnswersAfterDissolve: true,
    statusEligibilityAfterDissolve: status.marks[0].eligibility,
    droppedRetained: dropCommit.refused[0].retained,
    pinnedChildIndex: heldIndex,
    deferredParentRetained: parentReceipt.retained,
    deferredStillPending: stillPending.length,
    sameParentDroppedAlone: aloneCommit.refused[0].retained,
  };
}

/**
 * OCCUPANCY IS WHAT THE PROVIDER COUNTED, PLUS WHAT ARRIVED AFTER IT.
 *
 * A whole-projection estimate divides every byte in the window by one rate, and one rate
 * does not fit the window's contents. Measured 2026-08-10 on the sealed rep-23 run, byte
 * exact against that run's own projection records: the estimate is unbiased at the
 * pre-commit peaks (provider over estimate, mean 1.004 across six) and over-reads the
 * post-fold troughs by 22 to 35 percent (mean ratio 0.784 across six). Encrypted
 * reasoning-signature blobs grew from 14.6 to 51.3 percent of projection bytes over that
 * run and price at a fitted 24.8 chars per token against 3.957 for ordinary content, so a
 * projection's rate depends on what it is made of. The runtime believed its floor climbed
 * 0.298 to 0.490 of budget while the provider read 0.276 to 0.382.
 *
 * Three cases, and the gate pins all three:
 *   - APPENDED: the provider's count for the projection this one extends, plus the rate
 *     applied to the appended bytes only.
 *   - REWRITTEN: the pass right after a commit rebuilds rather than appends, so the anchor
 *     describes a projection this one does not begin with. The whole-projection estimate
 *     stands, error and all, and the record says which reading it used. Measured on rep 23,
 *     that residual error is +27 to +35 percent, and this build does not fix it.
 *   - UNMEASURED: no accepted count, so the reading is exactly what it was before.
 *
 * ANTI-VACUITY: the two readings are shown to DIFFER on the fixture before anything asserts
 * which one the runtime used.
 */
async function gateAnchoredOccupancy() {
  const window = 400_000;
  const runtime = makeRuntime(
    makeFixture({ turns: 24, resultChars: 6_000, contextWindow: window }),
    { providerInputBudget: 360_000 },
  );
  await startRuntime(runtime);
  const projections = () => contextEvents(runtime).filter((event) => event.kind === "context.projection");

  // CASE 1: nothing measured yet. Exactly the old reading, and the record says so.
  const unmeasured = projections().at(-1);
  assert.equal(unmeasured.estimate_basis, "unmeasured", "A session with no provider count claimed an anchor");
  assert.equal(unmeasured.anchor_tokens, null);
  assert.equal(unmeasured.estimated_tokens, Math.ceil(unmeasured.chars / unmeasured.chars_per_token),
    "The unmeasured reading is not the whole-projection estimate it was before this build");

  // One ordinary pairing sets the calibration window, and the SIGNATURE-HEAVY pairing
  // after it declares eight serialized chars per token for the same session. The
  // calibration takes the minimum over its window, so later passes still divide by four:
  // that gap between the session's declared composition and its own rate is exactly the
  // trough over-read rep 23 measured, and it is what separates the two readings here.
  const ordinary = projections().at(-1);
  await measure(runtime, Math.ceil(ordinary.chars / 4), window);
  await project(runtime);
  await settle();
  const anchoredProjection = projections().at(-1);
  const anchorTokens = Math.ceil(anchoredProjection.chars / 8);
  await measure(runtime, anchorTokens, window);
  const afterAnchor = await project(runtime);
  await settle();

  // CASE 2: appended. The two readings are separable BEFORE anything asserts which one ran.
  const anchored = projections().at(-1);
  const estimateOnly = Math.ceil(anchored.chars / anchored.chars_per_token);
  const expectedAnchored = anchorTokens + Math.ceil((anchored.chars - anchoredProjection.chars) / anchored.chars_per_token);
  assert(Math.abs(estimateOnly - expectedAnchored) > expectedAnchored * 0.5,
    `The two readings agree to within ${Math.abs(estimateOnly - expectedAnchored)} tokens, so this fixture proves nothing`);
  assert.equal(anchored.estimate_basis, "anchored", "An appended projection did not use the provider's count");
  assert.equal(anchored.anchor_tokens, anchorTokens, "The record names a different anchor than the provider reported");
  assert.equal(anchored.delta_chars, anchored.chars - anchoredProjection.chars,
    "The delta is not the bytes appended since the anchored projection");
  assert.equal(anchored.estimated_tokens, expectedAnchored,
    "The anchored reading is not the provider count plus the appended delta");
  assert(bytesOf(afterAnchor.messages) > 0, "The anchored pass returned nothing");
  const anchoredStatus = (await toolStatus(runtime)).details.automatic;
  assert.equal(anchoredStatus.projectionEstimateBasis, "anchored");
  assert.equal(anchoredStatus.projectionAnchorTokens, anchorTokens);
  assert.equal(anchoredStatus.projectionEstimatedTokens, expectedAnchored,
    "Status reports a number no decision was made on");

  // CASE 3: the anchor is dropped when it can no longer describe the session. A model or
  // thinking-level change is a different tokenizer, so its counts describe nothing here.
  await runtime.handlers.get("model_select")({}, runtime.ctx);
  await project(runtime);
  await settle();
  const afterModelChange = projections().at(-1);
  assert.equal(afterModelChange.estimate_basis, "unmeasured",
    "A count taken under the previous model still anchored the reading");
  assert.equal(afterModelChange.estimated_tokens,
    Math.ceil(afterModelChange.chars / afterModelChange.chars_per_token));

  // CASE 4: rewritten. A commit rebuilds the projection, so the anchored one is no longer
  // a prefix of it: the reading falls back and SAYS it fell back.
  // A thin tail and a 4,000-char fold floor, declared: this fixture's subject is the
  // occupancy anchor, and it has to commit repeatedly inside a 40,000-token budget. The
  // 8,000-char default floor would leave its 6,000-char results unfoldable and the
  // 0.10 default tail would protect most of what remains, so neither default is what
  // this gate is measuring. Both are pinned by their own gates (19 and 96).
  const pressuredThresholds = { ...context.DEFAULT_THRESHOLDS, minFoldChars: 4_000 };
  const pressured = makeRuntime(
    makeFixture({
      turns: 20, resultChars: 6_000, contextWindow: 200_000, thresholds: pressuredThresholds,
    }),
    { thresholds: pressuredThresholds, providerInputBudget: 40_000 },
  );
  await startRuntime(pressured);
  const pressuredProjections = () => contextEvents(pressured).filter((event) => event.kind === "context.projection");
  const basis = new Set();
  for (let step = 0; step < 4; step += 1) {
    const current = pressuredProjections().at(-1);
    await measureAndCommit(pressured, Math.ceil(current.chars / 4), 200_000, undefined, "toolUse");
    await project(pressured);
    await settle();
    basis.add(pressuredProjections().at(-1).estimate_basis);
  }
  const rewritten = pressuredProjections().filter((event) => event.estimate_basis === "rewritten");
  assert(rewritten.length >= 1, "The pressured fixture never rebuilt a projection, so the fallback is untested");
  for (const record of rewritten) {
    assert.equal(record.estimated_tokens, Math.ceil(record.chars / record.chars_per_token),
      "A rewritten projection was read as an anchor plus a delta");
    assert.equal(record.delta_chars, null, "A rewritten projection reported a delta it cannot have");
  }

  // THE LAW, over every projection either runtime emitted: anchored readings are the
  // anchor plus the delta, and every other reading is the whole-projection estimate.
  const all = [...projections(), ...pressuredProjections()];
  for (const record of all) {
    if (record.estimate_basis === "anchored") {
      assert.equal(record.estimated_tokens,
        record.anchor_tokens + Math.ceil(record.delta_chars / record.chars_per_token),
        "An anchored reading is not its own parts");
    } else {
      assert.equal(record.estimated_tokens, Math.ceil(record.chars / record.chars_per_token),
        "A fallback reading is not the whole-projection estimate");
    }
  }

  return {
    unmeasuredTokens: unmeasured.estimated_tokens,
    anchorTokens,
    anchoredDeltaChars: anchored.delta_chars,
    anchoredTokens: anchored.estimated_tokens,
    estimateOnlyTokens: estimateOnly,
    separationTokens: Math.abs(estimateOnly - expectedAnchored),
    droppedOnModelChange: afterModelChange.estimate_basis,
    rewrittenReadings: rewritten.length,
    basisSeenUnderPressure: [...basis].sort(),
  };
}

/**
 * THE CALIBRATION HAZARD THIS BUILD DOES NOT FIX.
 *
 * The rate the fence divides by is the MINIMUM serialized chars per token over a window of
 * recent provider pairings, taken as the pessimistic choice: a rate that is too high
 * under-counts tokens and transmits a request the provider will reject. Measured 2026-08-10
 * on the sealed rep-23 run, that rule is not reliably pessimistic. Composition moves the
 * true rate: encrypted reasoning-signature blobs price at a fitted 24.8 chars per token
 * against 3.957 for ordinary content, and they grew from 14.6 to 51.3 percent of projection
 * bytes over one run. Once a signature-heavy phase has pushed every pairing in the window
 * up, fresh raw tool output arrives at a much lower true rate and the fence divides it by
 * the high one. Worst observed on that run: 3.1 percent under-read at 0.64 occupancy,
 * harmless there, not harmless near the fence.
 *
 * This gate pins the honest current behavior rather than asserting a property the rule
 * cannot deliver. Changing the calibration rule is a separate mechanism and is NOT part of
 * this build; anchoring occupancy narrows the hazard, it does not remove it:
 *   - what anchoring DOES fix: the rate no longer prices the bytes the provider already
 *     counted, so a mispriced calibration can only be wrong about the material appended
 *     since that count. Gate 110 measures that separation directly.
 *   - what it does NOT fix: the rate still prices the delta, and it prices the WHOLE
 *     projection on the one pass per cycle that rebuilds rather than appends. A raw-heavy
 *     delta after a signature-heavy phase is read at half its true size, and the fence
 *     transmits it.
 */
async function gateCalibrationHazard() {
  const window = 40_000;
  const budgetTokens = 36_000;
  // The signature-heavy phase: every pairing in the calibration window declares eight
  // serialized chars per token, which is what a projection half made of signature blobs
  // measures at. The window is six deep, so six of them leave the minimum at eight.
  const signatureRate = 8;
  // What raw tool output actually costs, fitted at 3.957 on rep 23 and rounded down here
  // so the gate never overstates the gap.
  const rawRate = 4;
  const runtime = makeRuntime(
    makeFixture({ turns: 24, resultChars: 5_000, contextWindow: window }),
    { providerInputBudget: budgetTokens },
  );
  await startRuntime(runtime);
  const projections = () => contextEvents(runtime).filter((event) => event.kind === "context.projection");
  for (let pass = 0; pass < 6; pass += 1) {
    const current = projections().at(-1);
    await measure(runtime, Math.ceil(current.chars / signatureRate), window);
    await project(runtime);
    await settle();
  }
  const calibrated = (await toolStatus(runtime)).details.automatic;
  // Within a rounding step of the declared rate: each pairing divides an integer char
  // count by an integer token count, so the minimum lands just under it.
  assert(Math.abs(calibrated.projectionCharsPerToken - signatureRate) < 0.01,
    `The window calibrated to ${calibrated.projectionCharsPerToken} chars per token, not the declared ${signatureRate}`);
  const anchorTokens = calibrated.projectionAnchorTokens;
  assert(typeof anchorTokens === "number" && anchorTokens > 0, "The signature-heavy phase left no anchor");

  // Now the raw-heavy excursion: ninety thousand chars of plain tool output, which the
  // fence divides by eight because that is every pairing it holds.
  const rawChars = 90_000;
  const chunk = Math.floor(rawChars / 6);
  for (let step = 0; step < 6; step += 1) {
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `raw-${step}`, name: "read", arguments: { path: `raw-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 8_000 + step,
    }, "raw-excursion");
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `raw-${step}`,
      toolName: "read",
      content: [{ type: "text", text: `Raw ${step}: ${"r".repeat(chunk)}` }],
      isError: false,
      timestamp: 8_000 + step,
    }, "raw-excursion");
  }
  const abortsBefore = runtime.aborts;
  await project(runtime);
  await settle();
  const raw = projections().at(-1);
  assert.equal(raw.estimate_basis, "anchored",
    "The raw excursion rebuilt the projection, so this measures the fallback rather than the delta");
  assert(raw.delta_chars >= rawChars, `Only ${raw.delta_chars} chars were appended`);

  // THE UNDER-READ, stated in the numbers the runtime actually used. The delta is priced
  // at the signature rate; at the raw rate it is twice that.
  const readTokens = raw.estimated_tokens;
  const trueTokens = anchorTokens + Math.ceil(raw.delta_chars / rawRate);
  assert.equal(readTokens, anchorTokens + Math.ceil(raw.delta_chars / calibrated.projectionCharsPerToken),
    "The reading is not the anchor plus the delta at the calibrated rate");
  assert(readTokens < budgetTokens,
    `The fixture reads ${readTokens} against a ${budgetTokens} budget, so nothing was transmitted under-read`);
  assert(trueTokens > budgetTokens,
    `At the raw rate the request is ${trueTokens} tokens, inside the ${budgetTokens} budget; the hazard is not reproduced`);
  // AND IT IS TRANSMITTED. No abort, no reduction: the fence saw a request that fits.
  assert.equal(runtime.aborts, abortsBefore, "The fixture aborted, so the under-read did not reach the wire");
  assert.equal((await toolStatus(runtime)).details.automatic.overBudgetReduction, null,
    "The fence reduced, so this is not the silent case the hazard names");

  // WHAT ANCHORING BOUGHT, on the same numbers: the mispriced rate reached the delta only.
  // Without the anchor the same rate would have priced every byte in the projection, and
  // that is the one pass per cycle -- the rebuild right after a commit -- where it still
  // does. Stated as a ratio so it cannot pass by accident.
  const exposedChars = raw.delta_chars;
  const exposureShare = exposedChars / raw.chars;
  assert(exposureShare < 0.5,
    `The rate priced ${(exposureShare * 100).toFixed(1)}% of the projection, so the anchor bounded nothing here`);

  return {
    calibratedCharsPerToken: calibrated.projectionCharsPerToken,
    anchorTokens,
    deltaChars: raw.delta_chars,
    readTokens,
    trueTokensAtRawRate: trueTokens,
    budgetTokens,
    underReadTokens: trueTokens - readTokens,
    transmittedOverBudget: trueTokens > budgetTokens && runtime.aborts === abortsBefore,
    rateExposedShareOfProjection: Number(exposureShare.toFixed(3)),
  };
}

/**
 * A span whose evidence a fold already owns is REFUSED by name, never thrown at.
 *
 * The collision this gate reproduces is the campaign's ordinary case, not a race: the
 * ladder folds a span under window pressure and the agent, curating alongside it, then
 * names evidence inside that span. Every other collision in this runtime answers with a
 * receipt and a correction; this one used to answer with "Evidence <id> has multiple
 * direct fold owners", the forest invariant, thrown out of the tool call.
 *
 * ANTI-VACUITY. The first leg builds by hand the exact candidate the old builder handed
 * to preparation and asserts it still reaches that invariant and still fails loudly. So
 * the fixture is proved to be a real collision before the refusal is asserted, and the
 * loud path is proved to still be loud: a corrupt forest is not made polite.
 */
async function gateOwnedSpanRefusal() {
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const snapshot = built.snapshot;
  const empty = context.emptyActiveContextState(built.sessionId);
  // The ladder's own span: one whole turn, tool result and all, folded as a chapter.
  const turn = built.turnEntries[1];
  const chapter = context.manualFoldCandidate(snapshot, empty, [turn[0], turn.at(-1)]);
  assert.equal(chapter.kind, "chapter");
  const resultRef = chapter.parts
    .flatMap((part) => part.kind === "raw" && part.ref.role === "toolResult" ? [part.ref] : [])[0];
  assert(resultRef, "The folded turn carried no tool result, so nothing inside it can be named again");
  const committed = await commitCandidate(empty, snapshot, chapter, {
    brief: "One completed inspection turn, its exact request and result recoverable behind this placeholder.",
  });
  const owner = committed.state.folds.find((fold) => fold.id === committed.prepared.id);
  assert(owner, "The chapter never landed in the forest");

  // ANTI-VACUITY: the pre-fix path, on this fixture, still throws the invariant.
  const collided = {
    kind: "tool-result",
    parts: [{ kind: "raw", ref: structuredClone(resultRef) }],
    sourceRefs: [structuredClone(resultRef)],
  };
  assert.notEqual(context.foldIdFor(collided.kind, collided.parts), owner.id,
    "The hand-built candidate is the owner itself, so it would fail as a duplicate rather than a collision");
  await assert.rejects(
    context.prepareFold({ candidate: collided, snapshot, state: committed.state, generation: 2 }),
    /multiple direct fold owners/,
    "Preparing a span the forest already owns no longer reaches the invariant, so the refusal below proves nothing",
  );

  // THE FIX: the same span, asked for the way an agent asks for it, comes back named.
  assert.throws(
    () => context.manualFoldCandidate(snapshot, committed.state, [resultRef.entryId]),
    (error) => error.message.includes(owner.id) && error.message.includes(resultRef.entryId) &&
      /peek/.test(error.message) && /expand/.test(error.message) &&
      !/multiple direct fold owners/.test(error.message),
    "A span already inside a fold was not refused by the owner's name with a next move",
  );
  // The mark path relaxes eligibility, never structure, so it is refused the same way.
  assert.throws(
    () => context.manualFoldCandidate(snapshot, committed.state, [resultRef.entryId], { allowProtected: true }),
    /is already folded inside/,
    "The mark path built a candidate over evidence a fold already owns",
  );
  // And a genuine corruption, which no agent input can produce because every stored state
  // passes the forest validator, is still the exception it always was.
  assert.throws(
    () => context.directFoldOwners([owner, { ...owner, id: `${owner.id}-twin` }]),
    /multiple direct fold owners/,
    "A forest with two owners for one ref was answered politely instead of loudly");

  // END TO END, through the tool the agent actually calls. The state does not move and
  // the attempt is recorded not-ok with the refusal text, which is what a rejected
  // context call looks like everywhere in this runtime.
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  // The frontier cuts and the commit applies; the fold that ends up owning the evidence is
  // read off the forest rather than named in advance.
  await frontierCuts(runtime);
  await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  const live = materialized(runtime).folds.find((fold) =>
    fold.parts.some((part) => part.ref?.entryId === resultRef.entryId));
  assert(live, "The runtime leg never folded the turn, so nothing owns the evidence yet");
  const before = materialized(runtime);
  const from = runtime.appended.length;
  // Through `brief`, the verb that still names a fold. Naming evidence a standing fold
  // already owns is refused BY THE OWNER'S NAME with the two reads that would work, which
  // is the whole subject; `fold` was the old door to the same refusal and it is gone.
  await assert.rejects(
    toolCall(runtime, { action: "brief", id: live.id, brief: "A rewritten brief." }),
    (error) => error.message.includes(live.id) && /standing fold/.test(error.message) &&
      /peek/.test(error.message) && /reboundary/.test(error.message) &&
      !/multiple direct fold owners/.test(error.message),
    "The tool call did not refuse a standing fold by name",
  );
  const attempts = contextEvents(runtime, from).filter((record) => record.kind === "context.attempt");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].ok, false, "A refused context call was recorded as accepted");
  assert(attempts[0].error.includes(live.id), "The recorded refusal does not name the owning fold");
  assert.deepEqual(materialized(runtime), before, "A refused fold moved durable state");
  return {
    ownerKind: owner.kind,
    preFixInvariantStillThrows: true,
    refusalNamesOwner: true,
    refusalNamesPeekAndRecut: true,
    corruptForestStillLoud: true,
    toolAttemptOk: false,
    stateUnchanged: true,
  };
}

/**
 * Evidence for an entry is derived once, and deriving it again answers the same bytes.
 *
 * The defect this pins cost 135 of 258 minutes on the 2026-08-11 rep: every snapshot
 * re-derived a stableStringify and a sha256 for every message the session had ever held,
 * so the work grew with total history while the window it projected into stayed flat.
 *
 * This gate asserts the INVARIANT, never a wall clock. A timing threshold would pass or
 * fail on machine load; "an entry already mapped is not mapped again" is the property,
 * and it is counted through the caller's own projectEntry rather than any exported
 * internal, so the cache has no test-only surface.
 */
async function gateIncrementalEvidenceMap() {
  const entryFor = (id, text) => ({
    id,
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
  });
  const BASE = 300;
  const APPENDED = 5;
  const entries = Array.from({ length: BASE }, (_, index) =>
    entryFor(`e${index}`, `body ${index} ${"x".repeat(160)}`));

  let derivations = 0;
  const counting = (entry) => { derivations += 1; return [entry.message]; };
  const mapWith = (list) => context.mapActiveContext({
    sessionId: "incremental-session",
    eventMessages: list.map((entry) => entry.message),
    contextEntries: list,
    projectEntry: counting,
  });

  const first = mapWith(entries);
  // ANTI-VACUITY: the first pass really did derive all of them, so a small second pass
  // cannot be an artifact of a fixture that never had work to do.
  assert.equal(derivations, BASE,
    `The first mapping derived ${derivations} of ${BASE} entries, so this gate proves nothing`);
  assert(first.mapped.some((entry) => entry.ref), "The first mapping produced no evidence refs at all");

  const appended = [...entries, ...Array.from({ length: APPENDED }, (_, index) =>
    entryFor(`n${index}`, `appended ${index}`))];
  derivations = 0;
  const second = mapWith(appended);
  assert.equal(derivations, APPENDED,
    `Mapping after appending ${APPENDED} entries re-derived ${derivations}: an entry already mapped was mapped again`);

  // EQUIVALENCE: the same session through objects the cache has never seen. Structurally
  // identical, referentially fresh, so this is a genuine rebuild rather than a second hit.
  const cloned = appended.map((entry) => structuredClone(entry));
  derivations = 0;
  const rebuilt = mapWith(cloned);
  assert.equal(derivations, cloned.length,
    "The clone did not force a full rebuild, so the equivalence comparison below is vacuous");
  assert.equal(
    json.stableStringify(second.mapped.map((entry) => entry.ref)),
    json.stableStringify(rebuilt.mapped.map((entry) => entry.ref)),
    "The memoized mapping and a full rebuild disagreed: this is a different answer, not a saved one",
  );

  // A different session over the same entry objects must not serve the first one's refs,
  // because an evidence ref is scoped to its session.
  derivations = 0;
  const otherSession = context.mapActiveContext({
    sessionId: "a-different-session",
    eventMessages: appended.map((entry) => entry.message),
    contextEntries: appended,
    projectEntry: counting,
  });
  assert.equal(derivations, appended.length, "A second session reused the first session's cached evidence");
  assert.notEqual(
    json.stableStringify(otherSession.mapped.map((entry) => entry.ref)),
    json.stableStringify(second.mapped.map((entry) => entry.ref)),
    "Two different sessions produced identical evidence refs",
  );

  return {
    baseEntries: BASE,
    firstPassDerivations: BASE,
    secondPassDerivations: APPENDED,
    rebuildDerivations: cloned.length,
    refsIdenticalToRebuild: true,
    sessionScoped: true,
  };
}

/**
 * Every generator call is on the record, and nothing about it is invented.
 *
 * The generator runs outside the session and off the turn, so its spend reaches no
 * provider ledger and its latency reaches no turn timing. Before this it was possible to
 * run for four hours and be unable to say what briefing cost.
 *
 * The load-bearing assertion is the COUNT: one record per invocation, counted against the
 * generator's own call log. That is what proves the wrapper sits on every path rather than
 * on the one path a fixture happened to exercise.
 */
async function gateParentBriefCoversEveryChild() {
  const cap = context.ACTIVE_CONTEXT_POLICY.maxBriefChars;
  const snapshotOf = (built, thresholds = context.DEFAULT_THRESHOLDS, policy) => context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
    thresholds,
    ...(policy ? { policy } : {}),
  });
  const marker = (index) => `SUBJECT${index}MARKER`;
  // A child brief that fills the cap by itself, which is what every parent in the rep was:
  // ten of these need ten times the budget, and that ratio is why no cap could hold a
  // concatenation. The marker is how the assertion below asks whether a child left a trace.
  const fatBrief = (index) => `${marker(index)} ${"recoverable detail ".repeat(200)}`.slice(0, cap);
  /** Rewrite every visible root's brief, keeping the marker each one was given. */
  const heavyBriefs = (state, text = fatBrief, offset = 0) => {
    const markers = new Map();
    let index = 0;
    const folds = state.folds.map((fold) => {
      if (fold.parentId !== null) return fold;
      const at = offset + index;
      index += 1;
      markers.set(fold.id, marker(at));
      return { ...fold, brief: text(at) };
    });
    return { state: { ...state, folds }, markers };
  };

  // RUNG ONE, at the real width: ten children, each brief at the cap.
  const width = context.DEFAULT_THRESHOLDS.consolidateAfter;
  const forest = await chapterForest(width);
  const snapshot = snapshotOf(forest);
  const heavy = heavyBriefs(forest.state);
  const [group] = context.selectAutomaticConsolidations(snapshot, heavy.state);
  assert(group, "The fixture owed no consolidation, so nothing below is being tested");
  const children = group.parts.flatMap((part) => part.kind === "fold" ? [part.foldId] : []);
  assert.equal(children.length, width, "The group did not take the full width");
  // ANTI-VACUITY: the children genuinely overflow, so coverage is a result and not an
  // accident of a fixture whose briefs happened to fit.
  const concatenated = children
    .map((id) => heavy.state.folds.find((fold) => fold.id === id).brief).join(" ");
  assert(concatenated.length > cap * 3,
    `The children total ${concatenated.length} characters against a ${cap} cap: too small to press it`);
  const parentBrief = context.deterministicConsolidationBrief(group, heavy.state);
  assert(parentBrief.length <= cap,
    `A parent brief ran to ${parentBrief.length} characters over a ${cap} cap`);
  const uncovered = children.filter((id) => !parentBrief.includes(heavy.markers.get(id)));
  assert.deepEqual(uncovered, [],
    `${uncovered.length} of ${width} children left no trace in their parent's brief`);

  // SLACK. A child that fits keeps its whole sentence: what the short ones do not spend is
  // what the long ones are cut with, so an even share is a floor and not a ceiling.
  const shortAt = 3;
  const shortText = `${marker(shortAt)} short and complete.`;
  const mixed = heavyBriefs(forest.state, (at) => at === shortAt ? shortText : fatBrief(at));
  const mixedBrief = context.deterministicConsolidationBrief(group, mixed.state);
  assert(mixedBrief.includes(shortText),
    "A child brief short enough to fit whole was cut anyway, so the share is a ceiling");
  assert(mixedBrief.length <= cap, "The mixed group overran the cap");

  // RUNG TWO, where the old shape collapsed to one of ten: every child here is itself a
  // parent whose brief fills the cap. Read at width three rather than ten because the law
  // is coverage and not arithmetic: nine chapters make three parents, three parents make
  // one grandparent, and the question at each rung is the same one.
  const deepWidth = 3;
  const deep = await chapterForest(deepWidth * deepWidth);
  const deepThresholds = { ...context.DEFAULT_THRESHOLDS, consolidateAfter: deepWidth };
  const deepSnapshot = snapshotOf(deep, deepThresholds);
  let deepState = deep.state;
  const rungs = [];
  for (let rung = 0; rung < 2; rung += 1) {
    const round = heavyBriefs(deepState, fatBrief, (rung + 1) * 100);
    const owed = context.selectAutomaticConsolidations(deepSnapshot, round.state);
    assert(owed.length, `Rung ${rung} owed no group`);
    let next = round.state;
    for (const candidate of owed) {
      const brief = context.deterministicConsolidationBrief(candidate, next);
      assert(brief.length <= cap, `A rung-${rung} parent brief overran the ${cap} cap`);
      const missing = candidate.parts.flatMap((part) => part.kind === "fold" &&
        !brief.includes(round.markers.get(part.foldId)) ? [part.foldId] : []);
      assert.deepEqual(missing, [],
        `Rung ${rung} closed ${missing.length} children: their parent's brief never names them`);
      next = (await commitCandidate(next, deepSnapshot, candidate, { brief, briefProvenance: "deterministic" })).state;
    }
    deepState = next;
    rungs.push(owed.length);
  }
  assert.deepEqual(rungs, [deepWidth, 1], `The fixture did not build two rungs: ${rungs}`);

  // MATERIAL, AT DEPTH ONE. The grandparent's children are opened and ITS grandchildren
  // stay folded, which is both the bound on the read and the same view expanding gives.
  const grandparent = deepState.folds.find((fold) => fold.parentId === null);
  const opened = JSON.parse(context.consolidationSourceText(deepSnapshot, deepState, grandparent.parts));
  assert.equal(opened.length, deepWidth, "The payload lost a child");
  assert(opened.every((entry, at) => entry.child === at + 1 && entry.of === deepWidth),
    "The children are not numbered in span order, so the request cannot count them");
  assert(opened.every((entry) => Array.isArray(entry.contents) && entry.contents.length),
    "A child arrived closed, so the generator would be briefing a brief");
  const nested = JSON.stringify(opened.map((entry) => entry.contents));
  assert(nested.includes("Expand exactly"),
    "The grandchildren were opened too: depth one is the bound the read is built on");
  const placeholdersOnly = context.encodedFoldSource(
    deepSnapshot, deepState, grandparent.parts, "consolidation");
  assert(nested.length > placeholdersOnly.length * 2,
    "The opened payload is no larger than the placeholders it replaces, so nothing was opened");

  // LARGEST FIRST. Three children of deliberately unequal size: one parent holding three
  // chapters beside two lone chapters. Taking the big one out buys back the most room for
  // the fewest subjects lost, which is why size decides and not position.
  const unevenWidth = 3;
  const uneven = await chapterForest(unevenWidth + 2);
  const unevenThresholds = { ...context.DEFAULT_THRESHOLDS, consolidateAfter: unevenWidth };
  const unevenSnapshot = snapshotOf(uneven, unevenThresholds);
  const [firstGroup] = context.selectAutomaticConsolidations(unevenSnapshot, uneven.state);
  assert(firstGroup, "The uneven fixture owed no first group");
  const unevenState = (await commitCandidate(uneven.state, unevenSnapshot, firstGroup, {
    brief: context.deterministicConsolidationBrief(firstGroup, uneven.state),
    briefProvenance: "deterministic",
  })).state;
  const [wideGroup] = context.selectAutomaticConsolidations(unevenSnapshot, unevenState);
  assert(wideGroup, "The uneven fixture owed no second group");
  const fullText = context.consolidationSourceText(unevenSnapshot, unevenState, wideGroup.parts);
  const full = JSON.parse(fullText);
  const sizes = full.map((entry) => JSON.stringify(entry.contents).length);
  const biggest = sizes.indexOf(Math.max(...sizes));
  assert(sizes[biggest] > Math.min(...sizes) * 2,
    `The children are too even to show which collapses first: ${sizes}`);
  // A budget that fits once the biggest child is closed and not before.
  const tightSnapshot = snapshotOf(uneven, unevenThresholds,
    { maxSourceChars: fullText.length - sizes[biggest] + 500 });
  const packed = JSON.parse(context.consolidationSourceText(tightSnapshot, unevenState, wideGroup.parts));
  assert.equal(packed.length, full.length, "Packing dropped a child instead of collapsing one");
  const collapsed = packed.flatMap((entry, at) => entry.collapsed ? [at] : []);
  assert.deepEqual(collapsed, [biggest],
    `Packing collapsed ${JSON.stringify(collapsed)} rather than the largest child alone`);
  assert(packed[biggest].brief && packed[biggest].foldId,
    "A collapsed child lost the brief and the id that are all it has left");
  assert(packed.every((entry, at) => entry.child === at + 1),
    "Packing reordered the children: what collapses is chosen by size, what SHOWS stays in span order");

  return {
    width,
    childrenCovered: children.length,
    childrenBriefChars: concatenated.length,
    parentBriefChars: parentBrief.length,
    rungs,
    openedChildren: opened.length,
    collapsedLargestFirst: collapsed,
  };
}

/**
 * A parent brief cannot inherit a structural tool name from a child.
 *
 * A model brief may validly name the active-context tool on one line and carry its facts
 * on later lines. The parent index turns every child brief into one line. Before this
 * gate, that made the tool name structural poison for the whole parent: `usefulBrief`
 * discarded the flattened line, `prepareFold` threw, and an inline consolidation rolled
 * back the epoch that had just committed.
 */
async function gateParentBriefCannotInheritToolName() {
  const toolName = "pi_fold_context";
  const forest = await chapterForest(context.DEFAULT_THRESHOLDS.consolidateAfter);
  const [candidate] = context.selectAutomaticConsolidations(forest.snapshot, forest.state);
  assert(candidate, "The fixture owed no parent, so no child brief can poison it");
  const childId = candidate.parts.find((part) => part.kind === "fold")?.foldId;
  assert(childId, "The consolidation candidate carried no child fold");

  const statusBrief =
    "`pi_fold_context` status reported revision 153 with 49 folds and no suspension.\n" +
    "Durable revision 142 held 38 fold records before the pending epoch.";
  assert(context.usefulBrief(statusBrief, context.ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName),
    "The child fixture itself is not a valid multi-line brief");
  const upgraded = {
    ...forest.state,
    briefs: {
      [childId]: {
        brief: statusBrief,
        provenance: {
          kind: "model",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      },
    },
  };

  // ANTI-VACUITY: flattening the valid child without sanitizing it really does poison
  // the parent line. This is the exact transformation that preceded the live throw.
  const poisoned = `Grouped completed context covering one fold: ${statusBrief.replace(/\s+/g, " ")}`;
  assert(!context.usefulBrief(poisoned, context.ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName),
    "The child tool name did not poison the unsanitized parent fixture");

  const parentBrief = context.deterministicConsolidationBrief(candidate, upgraded, toolName);
  assert(!parentBrief.toLowerCase().includes(toolName.toLowerCase()),
    "The parent retained the structural tool name from its child");
  assert(parentBrief.includes("active-context service") && parentBrief.includes("Durable revision 142"),
    "Sanitizing the tool name also discarded the child's factual subject");
  assert(context.usefulBrief(parentBrief, context.ACTIVE_CONTEXT_POLICY.maxBriefChars, toolName),
    "The sanitized parent brief is still structurally unusable");

  const committed = await commitCandidate(upgraded, forest.snapshot, candidate, {
    brief: parentBrief,
    briefProvenance: "deterministic",
    now: 154,
  });
  assert.equal(committed.state.folds.length, upgraded.folds.length + 1,
    "The parent did not survive prepare and commit");
  assert.equal(context.sameStateProjection(committed.state, upgraded), false,
    "A state with the new parent compared equal to its predecessor");

  return {
    childBriefValidBeforeFlattening: true,
    unsanitizedParentRejected: true,
    sanitizedParentAccepted: true,
    factualSubjectKept: true,
    committedParent: committed.prepared.id,
    changedStateIsNotANoOp: true,
  };
}

/**
 * No fold goes without a brief, and the agent is asked for it first.
 *
 * A mark is a decision about a span, and the agent making it knows why the span mattered
 * and what it will want back; the deterministic brief reads the span alone and knows only
 * what it says. So the request asks the agent for the brief, and the deterministic
 * composition is the fill rather than the default. What must never happen is a fold with
 * nothing in its place: the placeholder is all that stands where the bytes were, and an
 * empty one closes the span to whoever comes back for it.
 *
 * Three orders, one property. A supplied brief is kept verbatim and judged on EVERY path,
 * including the deferred one that skips preparation. A mark with no brief is filled
 * deterministically, and the mark says who wrote it. And no committed fold ever stands
 * with an empty placeholder.
 */
async function gateNoFoldWithoutABrief() {
  const shape = { turns: 10, resultChars: 9_000, contextWindow: 100_000, toolName: "bash" };

  // THE SURFACE ASKS. A mark's brief is optional in the schema because the fill exists,
  // so the request has to carry the expectation the schema cannot.
  const built = makeFixture(shape);
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const tool = [...runtime.tools.values()][0];
  const briefArgument = tool.parameters.properties.brief;
  assert(typeof briefArgument.description === "string" && /pending fold/i.test(briefArgument.description),
    "The brief argument does not say what it attaches to");

  // NO BRIEF: every fold the frontier cuts arrives with a deterministic one already, which
  // is the same law read from the other end. It was "a mark the agent left briefless gets
  // one"; it is now "no cut is ever made without one", which is strictly stronger, because
  // there is no longer any way for a fold to exist unbriefed even for one pass.
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 3, "The frontier cut too little to measure briefs against");
  for (const cut of cuts) {
    assert(typeof cut.brief === "string" && cut.brief.trim(),
      `Frontier cut ${cut.id} was made with no brief at all`);
    assert.equal(cut.briefProvenance.kind, "deterministic",
      "A deterministic fill was recorded as though the agent had written it");
    assert.equal(cut.briefed, false);
  }

  // SUPPLIED: kept verbatim, and it REPLACES the deterministic fill rather than joining it.
  const supplied = "The second inspection is stale; its exact stdout and the failing path stay recoverable.";
  const kept = await briefCut(runtime, cuts[1], supplied);
  assert.equal(kept.details.brief, supplied);
  const keptMark = (await frontierCuts(runtime)).find((fold) => fold.id === cuts[1].id);
  assert(keptMark, "The briefed cut left the pending set");
  assert.equal(keptMark.brief, supplied, "A supplied brief was rewritten");
  assert.equal(keptMark.briefProvenance.kind, "supplied", "A supplied brief lost its attribution");

  // A BAD SUPPLIED BRIEF IS REFUSED AS A MARK, ON THE PATH THAT SKIPS THE PREPARATION.
  //
  // `prepareFold` validates the brief it is handed, and the mark path skips it when the
  // span is protected or already prepared. On those paths the mark used to be accepted
  // carrying an unchecked brief, and the first check then happened inside the automatic
  // commit, where a throw suspends folding for the whole session. That is the position the
  // lost-commit defect occupied, reached over a sentence the agent wrote and was told was
  // fine. So: protect the span first, which is what makes the mark deferred, then mark it
  // with a brief that cannot pass.
  // A BAD SUPPLIED BRIEF IS REFUSED WHERE IT IS WRITTEN, not carried to the commit.
  //
  // The position this protects is unchanged: an unchecked brief reaching `commitPendingMarks`
  // throws inside the automatic transaction, which suspends folding for the whole session,
  // and it gets there over a sentence the agent wrote and was told was fine. The route in
  // used to be the mark paths that skip `prepareFold`; `brief` is now the only way an agent
  // writes one at all, so this is the single door and it is checked at it.
  const target = cuts[2];
  const before = (await frontierCuts(runtime)).find((fold) => fold.id === target.id);
  const refused = await toolCall(runtime, {
    action: "brief", id: target.id, brief: "pi_fold_context",
  }).catch((error) => ({ details: { error: String(error?.message ?? error) } }));
  const refusal = JSON.stringify(refused.details);
  assert(/Supplied brief rejected/.test(refusal),
    `A structural brief was not refused: ${refusal.slice(0, 400)}`);
  assert(/Name concrete things from the span/.test(refusal),
    "The refusal does not tell the agent what to write instead");
  const after = (await frontierCuts(runtime)).find((fold) => fold.id === target.id);
  assert.equal(after.brief, before.brief,
    "A brief that cannot pass was written anyway and left to throw at commit");
  // And the agent is not stranded: the same fold takes a good brief on the next call.
  const retried = await briefCut(runtime, target,
    "The third inspection recorded a failing path and its exact stdout, both recoverable.");
  assert.equal(retried.details.provenance, "agent",
    "The agent corrected the brief the refusal complained about and was refused again");

  // EVERY FOLD, AFTER THE LADDER RUNS: nothing stands with an empty placeholder.
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const folds = materialized(runtime).folds;
  assert(folds.length, "The fixture committed no folds, so this proves nothing");
  const empty = folds.filter((fold) => typeof fold.brief !== "string" || !fold.brief.trim());
  assert.deepEqual(empty.map((fold) => fold.id), [], "A committed fold carries no brief at all");

  return {
    schemaAsksForABrief: true,
    filledDeterministicallyWhenOmitted: true,
    suppliedKeptVerbatim: true,
    deferredBadBriefRefusedAtTheMark: true,
    agentCorrectedAndWasAccepted: true,
    committedFolds: folds.length,
    foldsWithoutABrief: empty.length,
  };
}

/**
 * A DELTA CARRIES THE CHANGE, NEVER A VALUE ITS BASE ALREADY HOLDS.
 *
 * The v1 checkpoint became a v2 delta and the envelope was done correctly, but only the
 * fold refs were ever diffed. The other ten fields were cloned whole onto a wire that
 * says `kind: "delta"`, which is why the shape looked finished and the payload was not.
 *
 * The brief map is the field that made it cost. On sol-20260812 rep 9 the state ledger
 * was 21.5 MB of a 31.7 MB session, briefs were 17.7 MB of that, 81 percent, and the
 * projection actually sent to the provider was 0.93 MB. The session file is what every
 * later turn's derivation reads, so the run burned 50.9 minutes of CPU over 116 minutes
 * of wall against the native arm's 24 seconds, and wall-clock stopped meaning anything.
 *
 * The invariant is not that a brief never changes: a sealed session written by a build
 * that still had `rebrief` carries overrides that were added, rewritten and removed over
 * its life. It is that the wire carries the difference from its base and nothing else, so
 * an addition, a rewrite and a removal all travel and an unchanged map travels nowhere.
 */
/**
 * A RETIRED STATE FIELD IS REFUSED BY NAME, NOT TOLERATED AND DROPPED.
 *
 * `lastCall` and `notices` were the occupancy thermostat's two announcements, and they
 * left the state schema with it. A durable state that still carries one was written by a
 * build that had them, and the honest answer is a refusal that says which field and why:
 * tolerating it and dropping it makes a version boundary look like a successful load, and
 * the state that comes back is not the state that was written.
 *
 * Gate 17 states the wire's policy from the older side, that an exact-record reader
 * rejects fields it does not know and a bump is explicit. This is the same policy read
 * from the newer side, and it is asserted on BOTH readers, because the v1 and v2 parsers
 * each build their own key list and a fix applied to one would leave the other silent.
 */
/**
 * A BOUNDARY THAT CANCELS PI'S COMPACTION MUST NOT THEN APPLY NOTHING.
 *
 * Measured on the sol-20260813 smoke, which is why this gate exists: the boundary fired,
 * cancelled the native compaction, retained all seven of its marks at 0.20 occupancy and
 * freed nothing, so the runtime told Pi not to compact and then handed back a
 * byte-identical projection. In the guard era the repair was a boundary-only waiver;
 * since the guard's 2026-08-23 deletion nothing retains an eligible mark at a boundary
 * in the first place, and what this gate pins is the outcome the waiver existed to buy:
 * a boundary at LOW occupancy, on a session that never closes a turn, commits real mass
 * rather than handing Pi's own threshold back the projection that just crossed it.
 * The boundary carries a ratio, so its commit takes everything eligible with no depth
 * bound; the depth bound is the band top's, and gate 09 pins that half.
 */
/**
 * WHAT THE SESSION SPENDS DERIVING ITSELF, ON THE RECORD AND SUMMABLE.
 *
 * PT-4 measured one derivation at 3.5s on a 7.1 MB session and 18.5s on a 16.7 MB one,
 * and the reading offered for sol-20260813-paired rep 2 was that terminal cost times the
 * request count. That arithmetic is invalid, and the outside review was right to reject
 * it: multiplying the FINAL derivation by every earlier request treats every early
 * request as though the session were already at its final size, which is exactly wrong
 * when growth over time is the asserted mechanism. The honest number is a sum of what
 * each derivation actually cost, and nothing recorded it.
 *
 * Every lifecycle event remaps the whole branch, so a turn's cost is however many
 * derivations its handlers run, not one. Carrying cumulative counters on the projection
 * lets a consumer difference consecutive projections for a per-request cost and read the
 * last one for the exact session total.
 *
 * This gate pins the counters against the DERIVATIONS rather than against a stopwatch: a
 * wall clock in a gate is a flake, so what is asserted is that the count advances by
 * exactly the number of derivations performed, that it is monotonic, and that time is
 * accumulated as a number that never decreases. The one timing assertion is the weakest
 * one that still has content: elapsed milliseconds are non-negative and finite.
 */
async function gateDerivationCostIsRecordedAndSummable() {
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultChars: 6_000, contextWindow: 100_000 }),
    { providerInputBudget: 90_000 },
  );
  await startRuntime(runtime);
  const projections = () => contextEvents(runtime)
    .filter((event) => event.kind === "context.projection");

  await measure(runtime, 40_000, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  const first = projections().at(-1);
  assert(first, "No projection was recorded at all");
  assert(Number.isSafeInteger(first.derivations) && first.derivations > 0,
    `A projection recorded ${first.derivations} derivations, so nothing is being counted`);
  assert(Number.isFinite(first.derive_ms) && first.derive_ms >= 0,
    `A projection recorded ${first.derive_ms} derive_ms`);

  // THE COUNTER TRACKS THE WORK. Each authoritative snapshot is one derivation, so
  // driving a known number of them must move the counter by exactly that number. This is
  // what makes the total a sum rather than an estimate.
  const before = projections().at(-1);
  const extra = 5;
  for (let i = 0; i < extra; i += 1) await toolStatus(runtime);
  await measure(runtime, 42_000, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  const after = projections().at(-1);
  assert(after.derivations > before.derivations,
    "Five status calls and a projection advanced the derivation counter by nothing");
  assert(after.derive_ms >= before.derive_ms,
    `derive_ms went backwards: ${before.derive_ms} then ${after.derive_ms}`);

  // MONOTONIC ACROSS EVERY PROJECTION IN THE SESSION. A counter that resets cannot be
  // differenced, which is the whole reason it is carried cumulatively.
  const series = projections();
  assert(series.length >= 2, "Too few projections to check monotonicity");
  for (let i = 1; i < series.length; i += 1) {
    assert(series[i].derivations >= series[i - 1].derivations,
      `Derivation count fell from ${series[i - 1].derivations} to ${series[i].derivations} ` +
      `at projection ${i}`);
    assert(series[i].derive_ms >= series[i - 1].derive_ms,
      `derive_ms fell from ${series[i - 1].derive_ms} to ${series[i].derive_ms} ` +
      `at projection ${i}`);
  }

  // AND THE PER-REQUEST COST IS RECOVERABLE, which is the property the whole record
  // exists for: consecutive projections difference to a positive number of derivations.
  const deltas = series.slice(1).map((event, i) => event.derivations - series[i].derivations);
  assert(deltas.some((delta) => delta > 0),
    "No pair of consecutive projections differences to any derivation, so per-request " +
    "cost cannot be recovered and only the session total is readable");

  // A ROLLBACK DOES NOT RETURN THE CPU. These are process counters, not state, so a
  // reset would misreport work that was genuinely performed.
  const spent = series.at(-1);
  assert(spent.derivations >= series[0].derivations,
    "The derivation counter reset during the session");
  return {
    projections: series.length,
    derivations: spent.derivations,
    hits: spent.derivation_hits,
    savedShare: spent.derivation_hits === undefined ? null
      : Number((spent.derivation_hits / (spent.derivation_hits + spent.derivations)).toFixed(3)),
    deriveMs: spent.derive_ms,
    maxPerRequestDerivations: Math.max(...deltas),
  };
}

/**
 * ONE CANONICALIZATION PER MESSAGE OBJECT, AND THE COST THAT BUYS IT.
 *
 * Mapping the branch canonicalized and hashed every event message on EVERY derivation,
 * then canonicalized a branch candidate again on each digest match: roughly twice the
 * session's bytes of stringify-and-sha, repeated for each of the ten or so derivations a
 * request runs. Measured on sol-20260813-paired rep 1's sealed session (330 messages,
 * 1,276 entries), one request's ten derivations cost 544 ms before and 247 ms after, with
 * the warm derivations falling from about 50 ms each to about 14 ms. The cold derivation
 * costs 18 ms MORE, which is the memo being populated and is the whole price.
 *
 * This is gate 121's rule one layer up, so it is pinned the same way and for the same
 * reason: content addressing must survive across distinct objects AND distinct content
 * must map distinctly, because either property alone admits a wrong cache. The one cost
 * is ASSERTED rather than left to be discovered as a bug: a message mutated in place
 * keeps its first canonical form. The session is append-only, so nothing mutates a
 * message that has already been mapped, and stating the limit is the honest alternative
 * to guarding against a case that cannot arise.
 */
async function gateCanonicalizationIsMemoizedPerMessageObject() {
  const sessionId = "canon-memo-test";
  const build = (texts) => {
    const entries = [];
    const messages = [];
    let parentId = null;
    texts.forEach((text, i) => {
      const message = { role: "user", content: [{ type: "text", text }], timestamp: i + 1 };
      const id = `${sessionId}-entry-${String(i + 1).padStart(3, "0")}`;
      entries.push({ type: "message", id, parentId, message });
      messages.push(message);
      parentId = id;
    });
    return { entries, messages };
  };
  const map = (built, eventMessages) => context.mapActiveContext({
    sessionId,
    eventMessages: eventMessages ?? built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
  });

  // (a) CONTENT ADDRESSING SURVIVES DISTINCT OBJECTS. The event message and the branch
  // entry's message are different objects carrying the same bytes, which is the ordinary
  // case: a memo keyed on identity alone would fail to map them to each other.
  const built = build(["alpha payload", "beta payload", "gamma payload"]);
  const copies = built.messages.map((message) => JSON.parse(JSON.stringify(message)));
  assert(copies.every((copy, i) => copy !== built.messages[i]),
    "The fixture reused the same objects, so distinct-object mapping is not being tested");
  const viaCopies = map(built, copies);
  assert.equal(viaCopies.mapped.length, copies.length);
  assert(viaCopies.mapped.every((item) => item.ref !== null),
    "A message whose content matches the branch exactly did not map, so content " +
    "addressing did not survive being a different object");

  // (b) DISTINCT CONTENT MAPS DISTINCTLY. If the memo ever returned one message's
  // canonical form for another, two different payloads would collide onto one ref.
  const refs = viaCopies.mapped.map((item) => item.ref.sha256);
  assert.equal(new Set(refs).size, refs.length,
    `Three distinct payloads produced ${new Set(refs).size} distinct refs: the memo is ` +
    "serving one message's canonical form for another");

  // Re-mapping the SAME objects is byte-identical, which is what makes a warm derivation
  // safe to serve from the memo at all.
  const again = map(built, copies);
  assert.deepEqual(again.mapped.map((item) => item.ref.sha256), refs,
    "A second derivation over the same objects produced different refs");

  // (c) THE STATED COST. A message mutated in place keeps its first canonical form. This
  // is asserted, not worked around: the session is append-only and nothing mutates an
  // already-mapped message, so the memo is allowed to be wrong about a case that does
  // not occur, and the gate records exactly how it is wrong.
  const mutable = build(["one", "two"]);
  const mapped = map(mutable);
  const firstRef = mapped.mapped[0].ref.sha256;
  mutable.messages[0].content[0].text = "one, changed after mapping";
  const afterMutation = map(mutable);
  assert.equal(afterMutation.mapped[0].ref.sha256, firstRef,
    "A message mutated in place produced a NEW canonical form. That is not a failure of " +
    "correctness for an append-only session, but it means this gate no longer describes " +
    "the memo and the comment above it is now wrong");

  // A genuinely new object with that same changed text is canonicalized afresh, so the
  // staleness above is bounded to the mutated object and does not spread.
  const rebuilt = build(["one, changed after mapping", "two"]);
  const rebuiltRef = map(rebuilt).mapped[0].ref.sha256;
  assert.notEqual(rebuiltRef, firstRef,
    "Changed content in a fresh object reused the stale canonical form, so the memo is " +
    "keyed on something other than the object");
  return {
    distinctObjectsMapped: viaCopies.mapped.filter((item) => item.ref).length,
    distinctRefs: new Set(refs).size,
    inPlaceMutationKeepsFirstForm: true,
    freshObjectRecomputes: true,
  };
}

async function gateBoundaryCommitsRatherThanNoOp() {
  // THE FIXTURE IS THE SHAPE, the same one gate 09 uses: one user message and nothing
  // after it but tool-calling assistants and their results, so no turn ever closes and
  // occupancy sits far under every emergency threshold when the boundary fires.
  const sessionId = "boundary-waiver-test";
  const window = 100_000;
  const providerInputBudget = 90_000;
  const build = () => {
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
    add({
      role: "user",
      content: [{ type: "text", text: "One marathon task: read the repository and keep going." }],
      timestamp: 1,
    });
    const resultEntryIds = [];
    for (let step = 0; step < 24; step += 1) {
      add({
        role: "assistant",
        content: [{
          type: "toolCall", id: `bw-${step}`, name: "read", arguments: { path: `bw-${step}.txt` },
        }],
        stopReason: "toolUse",
        timestamp: 10 + step,
      });
      resultEntryIds.push(add({
        role: "toolResult",
        toolCallId: `bw-${step}`,
        toolName: "read",
        content: [{ type: "text", text: `Batch ${step}: ${"b".repeat(12_000)}` }],
        isError: false,
        timestamp: 10 + step,
      }));
    }
    return {
      sessionId,
      entries,
      messages,
      contextWindow: window,
      turnEntries: [resultEntryIds],
      snapshot: context.mapActiveContext({
        sessionId, eventMessages: messages, contextEntries: entries, contextWindow: window,
      }),
    };
  };

  // Well under refoldRatio, which is 0.85 of the 90,000-token serving budget, and under
  // the band top: nothing but the boundary itself explains the commit below.
  const climb = [55_000, 57_000, 59_000, 61_000, 62_000, 62_500];
  const boundaryRun = makeRuntime(build(), { providerInputBudget });
  await startRuntime(boundaryRun);
  for (const tokens of climb) {
    await measure(boundaryRun, tokens, window, undefined, "toolUse");
    await project(boundaryRun);
    await settle();
  }
  const state = materialized(boundaryRun);
  context.mapActiveContext({
    sessionId,
    eventMessages: boundaryRun.messages,
    contextEntries: boundaryRun.branch,
    contextWindow: providerInputBudget,
    netBudget: true,
  });
  assert(!terminalStopIn(boundaryRun.messages),
    "A turn closed in the fixture, so the never-closing shape is not being measured");
  // The frontier cuts before the boundary (gate 141), and on this shape every one of
  // those cuts lands inside the turn that never closes: under the deleted guard the
  // boundary arrived with nothing applicable, which is the no-op this gate was born
  // from. The marks standing here are what the boundary spends.
  const pendingBefore = context.pendingMarks(state);
  assert(pendingBefore.length > 0,
    "Nothing is pending at the boundary, so the commit below proves nothing");

  const from = boundaryRun.appended.length;
  await compactBoundary(boundaryRun);
  const commit = contextEvents(boundaryRun, from)
    .find((record) => record.kind === "context.commit" && record.deferred === false);
  assert(commit, "The boundary did not commit at all");
  const occupancy = commit.occupancy_tokens_before / commit.budget_tokens;
  assert(occupancy < context.ACTIVE_CONTEXT_POLICY.refoldRatio,
    `The fixture sat at ${occupancy} occupancy, at or past the anchor, so the waiver did ` +
    "not need the boundary and this gate proves nothing");
  assert(commit.applied_marks > 0,
    "The boundary cancelled Pi's compaction and applied nothing, which hands Pi's own " +
    "threshold a projection byte-identical to the one that just crossed it");
  assert(commit.freed_tokens > 0, "The boundary commit freed nothing");
  // AND IT TAKES EVERYTHING ELIGIBLE. The boundary carries a ratio, so the depth bound
  // does not arm: Pi has already said this window must shrink, and a bound that left
  // depth on the table would hand the decision back half-answered. The receipt carries
  // no guard-waiver vocabulary any more, and that absence is pinned.
  assert.equal(commit.deferred_marks, 0,
    `The boundary retained ${commit.deferred_marks} marks while Pi asked the window to shrink`);
  assert.equal(commit.waived_marks, undefined,
    "The commit record still carries guard-waiver vocabulary; the guard and its waiver are deleted");
  return {
    boundaryOccupancy: Number(occupancy.toFixed(3)),
    anchor: context.ACTIVE_CONTEXT_POLICY.refoldRatio,
    pendingAtBoundary: pendingBefore.length,
    appliedAtBoundary: commit.applied_marks,
    deferredAtBoundary: commit.deferred_marks,
    freedTokens: commit.freed_tokens,
  };
}

async function gateRetiredStateFieldsAreRefusedByName() {
  // Wide enough to fold at the shipped defaults: a fold has to clear minFoldChars.
  const built = makeFixture({ turns: 10, resultChars: 10_000, contextWindow: 100_000 });
  const empty = context.emptyActiveContextState(built.sessionId);
  // Neither field can be produced any more: the schema does not declare them, so the
  // fixture states them as a build that HAD them would have written them.
  const retired = {
    lastCall: { exposure: 4, ordinal: 2, contextCalls: 0, agentMarks: 0, text: "[pi-fold last call] ..." },
    notices: { fired: [0.25], ring: [{ share: 0.25, ordinal: 1, text: "[pi-fold notice] ..." }] },
    // The surfacing ledger went with its subsystem 2026-08-14, so any session that
    // ever issued a suggestion carries this field and refuses here by name.
    surfacing: [{ id: "fold_0000000000000000", surfaced: 1, taken: 0, ordinal: 3, outcome: "shown" }],
  };
  // THE RIDER IS DELIBERATELY ABSENT FROM THAT LIST, and this is where the distinction is
  // stated. It went with the curation redesign on 2026-08-23 like the three above, and it
  // was put on the refusal list with them, which made every state the sol-20260815-hidden
  // campaign sealed unreadable and cost the hidden-mass result its 102 attributed carriage
  // rows. The refusal's own reason is "a state this build cannot reproduce", and the rider
  // was projection carrier text that touched no fold, no ref and no brief: the only thing
  // it changed on a load was the state digest, and `legacyRiderStateSha256` reproduces
  // that. So the list holds the fields that carried BEHAVIOUR, and a field whose loss is
  // reproducible is read, spent on the digest, and dropped (gate 17).
  assert.equal(Object.keys(retired).includes("rider"), false,
    "The rider is back on the refusal list, which makes every sealed campaign unreadable");
  const refusals = {};
  for (const [field, payload] of Object.entries(retired)) {
    // The v1 whole-state reader.
    assert.throws(
      () => context.materializeActiveContextState(
        [...built.entries, stateEntry(built.sessionId, { ...empty, [field]: payload })],
        built.sessionId,
      ),
      new RegExp(`retired field\\(s\\) ${field}`),
      `The v1 reader did not refuse ${field} by name`,
    );
    // And the v2 checkpoint reader, whose key list is built separately.
    const runtime = makeRuntime(built);
    await startRuntime(runtime);
    await measureAndCommit(runtime, 88_000, 100_000);
    const checkpoint = runtime.branch
      .filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1);
    assert(checkpoint, "The fixture wrote no v2 state entry to corrupt");
    const corrupted = structuredClone(checkpoint);
    corrupted.data = { ...corrupted.data, [field]: payload };
    assert.throws(
      () => context.materializeActiveContextState(
        [...runtime.branch.filter((entry) => entry !== checkpoint), corrupted],
        built.sessionId,
      ),
      new RegExp(`retired field\\(s\\) ${field}`),
      `The v2 reader did not refuse ${field} by name`,
    );
    refusals[field] = true;
  }
  // Both at once are named together rather than one at a time, so a state carrying two
  // does not need two loads to learn what is wrong with it.
  assert.throws(
    () => context.materializeActiveContextState(
      [...built.entries, stateEntry(built.sessionId, { ...empty, ...retired })],
      built.sessionId,
    ),
    /retired field\(s\) lastCall, notices, surfacing/,
    "A state carrying every retired field named only some of them",
  );
  // And the refusal is not a blanket rejection of unknown keys wearing a friendlier
  // message: a field that was never in the schema still fails the plain key check.
  assert.throws(
    () => context.materializeActiveContextState(
      [...built.entries, stateEntry(built.sessionId, { ...empty, neverExisted: 1 })],
      built.sessionId,
    ),
    /Invalid active-context state keys/,
    "An unknown key was reported as a retired field",
  );
  // The carriers and their bounds are gone with the fields, so nothing can write one back.
  for (const name of ["lastCallText", "thresholdNoticeText", "MAX_LAST_CALL_TEXT_BYTES",
    "MAX_THRESHOLD_NOTICE_TEXT_BYTES", "THRESHOLD_NOTICE_SHARES", "MAX_THRESHOLD_NOTICES",
    "curationSignals", "curationTriggerFires", "staleToolMass",
    // The redesign's own deletions: the rider's text builder and its byte bound, and the
    // steward band's advisory and its warning share.
    "contextRiderText", "MAX_RIDER_TEXT_BYTES", "validRiderState",
    "stewardAdvisoryText", "STEWARD_WARNING_SHARE"]) {
    assert.equal(context[name], undefined, `${name} outlived the state it served`);
  }
  return {
    refusedOnBothReaders: refusals,
    bothNamedTogether: true,
    unknownKeysStillPlain: true,
    retiredSurfaceRemoved: 9,
  };
}

async function gateDeltaCarriesOnlyBriefChanges() {
  // Consolidation held off. This gate needs two ROOTS to tell one brief's write from
  // another's, and at the shipped consolidateAfter of 10 the commit seats every fold this
  // fixture makes under a single parent. Gate 13 owns the consolidation count; what is
  // measured here is what a delta carries.
  const runtime = await epochToolRuntime({
    turns: 16, resultChars: 6_000,
    thresholds: { ...context.DEFAULT_THRESHOLDS, consolidateAfter: 100 },
  });
  const built = runtime.built;
  const newestDelta = () => {
    const data = runtime.branch
      .filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY)
      .map((entry) => entry.data).at(-1);
    assert.equal(data.kind, "delta", "The fixture wrote a checkpoint, so the delta path went untested");
    return data;
  };

  await agentBriefsCuts(runtime, 3);
  // THE BAND TOP, not the boundary. The boundary carries a waiver and is deliberately not
  // depth-bounded, so on this fixture it takes the whole window and consolidates it into a
  // single chapter, leaving one root and nothing to compare. Crossing the band top commits
  // only as deep as the budget asks, which leaves the several roots this gate reads.
  await measure(runtime, 76_000, 100_000);
  await project(runtime);
  await settle();
  // Roots, not folds: the commit consolidates, and expanding a child before its parent is
  // refused. Read off the live branch because the ladder chose the shape, not the fixture.
  const snapshotNow = () => context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const roots = context.orderedRoots(materialized(runtime), snapshotNow()).map((root) => root.fold);
  assert(roots.length >= 2,
    `The fixture committed ${roots.length} root folds; two are needed to tell one brief's write from another's`);
  const [first, second] = roots;

  // A brief at the policy cap, so a whole-map write could not hide inside the rest of the
  // wire. It ends on a period because the write path trims, and a trimmed brief is not
  // the string this gate then compares the replayed map against.
  const briefText = (name) => `${`Corrected ${name}: the exact bytes stay recoverable behind this fold. `
    .padEnd(context.ACTIVE_CONTEXT_POLICY.maxBriefChars - 1, "The span is unchanged beside it. ")}.`;

  // THE READER OUTLIVES THE WRITER. `rebrief` was deleted on 2026-08-21 and it was the
  // only verb that reliably wrote `state.briefs`, so nothing in a fresh session puts an
  // override there any more. The map is NOT retired: sessions written by builds that had
  // rebrief carry overrides on disk, and refusing to load them would strand every fold
  // those sessions folded. So the reader stays, and it has to keep winning over the
  // fold's own immutable brief exactly as before.
  const overridden = {
    ...materialized(runtime),
    briefs: { [first.id]: briefText("one") },
  };
  assert.equal(context.foldBrief(first, overridden), briefText("one"),
    "A brief override loaded from durable state no longer wins over the fold's own brief");
  assert.equal(first.brief === briefText("one"), false,
    "The fixture's fold already carries the override text, so the reader proves nothing");
  assert.equal(context.foldPlaceholder(first, overridden, snapshotNow()).includes("Corrected one"), true,
    "The placeholder stopped carrying a loaded override");
  assert.equal(materialized(runtime).briefs, undefined,
    "Something in a fresh session still writes a brief override");

  // Real mutations, so the branch this gate replays below is a chain rather than two
  // entries. Each one writes durable state and none of them touches a brief, which is
  // also the negative half of the claim: a write that changed no brief carries none.
  await toolCall(runtime, { action: "expand", id: second.id });
  await toolCall(runtime, { action: "pin", ids: [second.id] });
  await toolCall(runtime, { action: "unpin", ids: [second.id] });
  assert.equal(newestDelta().addBriefs, undefined,
    "The newest write changed no brief and carried one anyway");
  for (const entry of runtime.branch.filter((item) =>
    item.customType === context.ACTIVE_CONTEXT_STATE_ENTRY && item.data.kind === "delta")) {
    assert.equal(entry.data.briefs, undefined, "A write that changed no brief stated the whole map");
    assert.equal(entry.data.addBriefs, undefined, "A write that changed no brief carried one");
  }

  // The rest of the lane is driven as a pure function, the same way this gate's mark half
  // below is, because the write path can reach only one override per re-cut and the law
  // under test is about what a DELTA carries, not about how many verbs can produce one.
  // The base carries the session's REAL folds, because a brief override naming a fold
  // the state does not hold is refused on load, which is the right refusal and would
  // make a synthetic chain prove nothing.
  const briefBase = materialized(runtime);
  const withBriefs = (revision, briefs) => ({
    ...briefBase,
    revision,
    ...(Object.keys(briefs).length ? { briefs } : {}),
  });
  const oneBrief = withBriefs(2, { [first.id]: briefText("one") });
  const twoBriefs = withBriefs(3, { [first.id]: briefText("one"), [second.id]: briefText("two") });
  const rewritten = withBriefs(4, { [first.id]: briefText("one again"), [second.id]: briefText("two") });
  const dropped = withBriefs(5, { [second.id]: briefText("two") });

  const added = context.makeStateDelta(oneBrief, twoBriefs);
  assert.equal(added.briefs, undefined, "The delta stated the whole brief map");
  assert.deepEqual(Object.keys(added.addBriefs), [second.id], "The delta re-shipped a brief its base already held");

  // The write the defect made expensive: nothing about the briefs changed here, and the
  // whole map shipped anyway. It has to carry no brief key of any kind.
  const quietBrief = context.makeStateDelta(twoBriefs, { ...twoBriefs, revision: 9 });
  assert.equal(quietBrief.briefs, undefined);
  assert.equal(quietBrief.addBriefs, undefined, "A write that changed no brief carried one");
  assert.equal(quietBrief.removeBriefIds, undefined);
  assert(!JSON.stringify(quietBrief).includes("Corrected one"),
    "The write that changed no brief carried the brief's own bytes");

  assert.deepEqual(Object.keys(context.makeStateDelta(twoBriefs, rewritten).addBriefs), [first.id],
    "A rewrite did not travel as its own change");
  assert.deepEqual(context.makeStateDelta(twoBriefs, dropped).removeBriefIds, [first.id],
    "Dropping a brief did not travel");

  // The REPLAY half of this mechanism is pinned by the mark chain below, which builds a
  // whole session from scratch and materialises it. It is not repeated for briefs: with
  // `rebrief` deleted nothing in a live session writes an override, and a brief chain
  // hand-built beside the runtime's own fold records fails the state digest for reasons
  // that have nothing to do with briefs. What is left here is the claim that matters
  // now, which is what a brief delta CARRIES.

  const markFixture = makeFixture({
    turns: 10, resultChars: 10_000, contextWindow: 100_000, sessionId: "delta-marks",
  });
  const base = context.emptyActiveContextState("delta-marks");
  const proposed = context.topUpMarks({
    snapshot: epochSnapshot(markFixture), state: base, ordinal: 3, targetShare: 1,
  }).slice(0, 3);
  assert.equal(proposed.length, 3, "The mark fixture proposed too few marks to reorder");
  const key = context.pendingMarkKey;
  const withMarks = (revision, marks) =>
    context.withPendingMarks({ ...base, revision }, marks);
  const one = withMarks(1, proposed.slice(0, 1));
  const two = withMarks(2, proposed.slice(0, 2));
  const three = withMarks(3, proposed);
  const shuffled = withMarks(4, [proposed[2], proposed[0], proposed[1]]);
  const emptied = withMarks(5, []);

  const growth = context.makeStateDelta(one, two);
  assert.equal(growth.pendingMarks, undefined, "The delta stated the whole mark array");
  assert.deepEqual(growth.addPendingMarks, [proposed[1]],
    "The delta re-shipped a mark its base already held");
  assert.deepEqual(growth.pendingMarkOrder, [proposed[0], proposed[1]].map(key));

  const reorder = context.makeStateDelta(three, shuffled);
  assert.equal(reorder.addPendingMarks, undefined, "A reorder shipped marks the base already held");
  assert.deepEqual(reorder.pendingMarkOrder, [proposed[2], proposed[0], proposed[1]].map(key),
    "A reorder did not travel, so the replay would rebuild the wrong order");

  const cleared = context.makeStateDelta(three, emptied);
  assert.deepEqual(cleared.pendingMarkOrder, [], "Clearing the marks did not travel");
  assert.equal(cleared.addPendingMarks, undefined, "Clearing the marks carried marks with it");

  const quiet = context.makeStateDelta(three, { ...three, revision: 6 });
  assert.equal(quiet.addPendingMarks, undefined, "A write that changed no mark carried one");
  assert.deepEqual(quiet.pendingMarkOrder, proposed.map(key));
  assert(!JSON.stringify(quiet).includes(proposed[0].parts ? JSON.stringify(proposed[0].parts) : "\u0000"),
    "A write that changed no mark carried a mark's own bytes");

  // THE ROUND TRIP. Replaying the chain has to rebuild the marks the states held, in the
  // order they held them, from writes that never stated the array whole.
  const markChain = [
    stateEntry("delta-marks", context.makeStateCheckpoint(base), "marks-0"),
    stateEntry("delta-marks", context.makeStateDelta(base, one), "marks-1", "marks-0"),
    stateEntry("delta-marks", context.makeStateDelta(one, two), "marks-2", "marks-1"),
    stateEntry("delta-marks", context.makeStateDelta(two, three), "marks-3", "marks-2"),
    stateEntry("delta-marks", context.makeStateDelta(three, shuffled), "marks-4", "marks-3"),
  ];
  assert.deepEqual(
    context.materializeActiveContextState(markChain, "delta-marks").pendingMarks,
    shuffled.pendingMarks,
    "Replaying the chain did not reproduce the marks in the order the state held them",
  );
  assert.equal(
    context.materializeActiveContextState([
      ...markChain,
      stateEntry("delta-marks", context.makeStateDelta(shuffled, withMarks(5, [])), "marks-5", "marks-4"),
    ], "delta-marks").pendingMarks,
    undefined,
    "Replaying a cleared array left marks standing",
  );

  // A wire that states the whole array is replayed as the whole array, and may not also
  // state a change; additions without an order name marks nothing will place; and a key the
  // replay cannot resolve is refused rather than dropped, because a dropped mark is
  // evidence that never gets folded.
  const markSample = context.makeStateDelta(two, three);
  assert.throws(() => context.parseActiveContextStateV2(
    { ...markSample, pendingMarks: [] }, "delta-marks",
  ), /states the whole mark array and a change to it/);
  const orderless = structuredClone(markSample);
  delete orderless.pendingMarkOrder;
  assert.throws(() => context.parseActiveContextStateV2(orderless, "delta-marks"),
    /adds pending marks and states no order for them/);
  assert.throws(() => context.materializeActiveContextState([
    ...markChain.slice(0, 3),
    stateEntry("delta-marks", { ...markSample, pendingMarkOrder: [...markSample.pendingMarkOrder, "fold:fold_absent"] },
      "marks-broken", "marks-2"),
  ], "delta-marks"), /Unknown active-context pending mark/);
  assert.throws(() => context.materializeActiveContextState([
    ...markChain.slice(0, 3),
    stateEntry("delta-marks", { ...markSample, addPendingMarks: [proposed[0]] }, "marks-redundant", "marks-2"),
  ], "delta-marks"), /Redundant active-context pending mark/);

  // And a sealed session's whole-array deltas still replay.
  const legacyMarks = markChain.map((entry, at) => {
    if (at === 0) return entry;
    const data = structuredClone(entry.data);
    const held = context.materializeActiveContextState(markChain.slice(0, at + 1), "delta-marks");
    delete data.addPendingMarks;
    delete data.pendingMarkOrder;
    if (held.pendingMarks?.length) data.pendingMarks = held.pendingMarks;
    return { ...entry, data };
  });
  assert.deepEqual(
    context.materializeActiveContextState(legacyMarks, "delta-marks").pendingMarks,
    shuffled.pendingMarks,
    "A sealed session's whole-array marks no longer replay",
  );

  // A delta written before this change states the whole array, and sealed sessions hold
  // thousands of them. The presence of the whole field is the discriminator, not a
  // fallback: a wire that states it is replayed as stated, and it may not also state a
  // change to it. Driven on MARKS, which still have a live writer. The same claim for
  // BRIEFS is carried by the parser assertions below rather than by a replay, because
  // `rebrief` was deleted on 2026-08-21 and no live session writes an override any more;
  // a fixture cannot produce a state whose digest covers briefs it never held.
  const chain = runtime.branch.filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY);
  assert(chain.length > 3, "The fixture wrote too few state entries to exercise a chain");
  const legacyBranch = structuredClone(runtime.branch);
  for (const [at, entry] of legacyBranch.entries()) {
    if (entry.customType !== context.ACTIVE_CONTEXT_STATE_ENTRY || entry.data.kind !== "delta") continue;
    // The whole map AS OF this entry, which is what a pre-2026-08-13 writer put on the
    // wire. The resulting state is identical either way, so the digests still hold.
    const held = context.materializeActiveContextState(runtime.branch.slice(0, at + 1), built.sessionId);
    delete entry.data.addBriefs;
    delete entry.data.removeBriefIds;
    delete entry.data.addPendingMarks;
    delete entry.data.pendingMarkOrder;
    if (held.briefs) entry.data.briefs = held.briefs;
    if (held.pendingMarks?.length) entry.data.pendingMarks = held.pendingMarks;
  }
  const legacyReplay = context.materializeActiveContextState(legacyBranch, built.sessionId);
  assert.deepEqual(legacyReplay.briefs, materialized(runtime).briefs,
    "The whole-map rewrite changed the brief map the branch replays to");
  assert.deepEqual(legacyReplay.pendingMarks, materialized(runtime).pendingMarks,
    "A sealed session's whole-array marks no longer replay");

  const sample = structuredClone(chain.at(-1).data);
  assert.throws(() => context.parseActiveContextStateV2({
    ...sample,
    briefs: { [second.id]: briefText("two") },
    addBriefs: { [first.id]: briefText("one") },
  }, built.sessionId), /states the whole brief map and a change to it/,
  "A delta stating both the whole map and a change to it was accepted");
  assert.throws(() => context.parseActiveContextStateV2(
    { ...sample, removeBriefIds: [first.id, first.id] }, built.sessionId,
  ), /Invalid active-context delta brief removals/);

  // And the reader refuses a chain that would be ambiguous: a removal the base never
  // held, and an addition byte-identical to what the base already holds. Both are only
  // producible by a broken writer, and neither may be absorbed quietly.
  const brokenRemoval = structuredClone(runtime.branch);
  brokenRemoval.filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY)
    .at(-1).data.removeBriefIds = ["fold_never_written_here"];
  assert.throws(() => context.materializeActiveContextState(brokenRemoval, built.sessionId),
    /Unknown active-context brief removal/);
  // The REDUNDANT-addition refusal is not driven here any more. Reaching it needs a base
  // that already holds the brief being re-added, and with `rebrief` deleted no live
  // session writes one: injecting the first addition into an earlier delta changes the
  // state that entry's digest covers, so the replay dies of drift before it ever reads
  // the second. The refusal itself is untouched at persistence.ts, and the writer that
  // could produce the case is gone. Stated rather than quietly dropped.

  return {
    stateEntries: chain.length,
    unchangedWriteBytes: JSON.stringify(quietBrief).length,
    briefChars: briefText("one").length,
    additionsTravelled: 2,
    rewritesTravelled: 1,
    removalsTravelled: 1,
    unchangedMapTravelled: false,
    markAdditionsTravelled: growth.addPendingMarks.length,
    markReorderTravelled: true,
    marksShippedOnAReorder: 0,
    markClearTravelled: true,
  };
}

/**
 * THE USER'S OWN COMMIT ANNOUNCES A PERSISTENCE FAILURE TOO.
 *
 * `/context commit` ran the epoch, called persist inside a bare `try {} catch {}`, and then
 * told the user how many marks it had committed. Every automatic path routes that same
 * failure through the suspension: gate 122 raises it, gate 123 announces it, and gate 124
 * was retired so nothing swallows the first few quietly. This one path threw the error
 * away and reported success, which is gate 122's dead session with the user holding the
 * pen: folds in the event stream, nothing durable, a session that keeps computing folds it
 * will discard, and a message saying the opposite.
 */
// GATE 133 - a projection fingerprint is computed when one is asked for, and it is the one
// the eager map held.
//
// Replaying a ledger hashed the whole fold forest twice for every revision it had ever
// written. One revision is ever read, by one caller, on the restore path, and
// `materializeActiveContextState` takes `.state` and drops the map entirely, so a session
// paid for hundreds of digests nothing could reach. Profiled against sol-20260813-paired
// rep 1 at its full 1,276 entries, canonicalizing and hashing was 72% of a materialisation.
//
// The saving is worth nothing if a fingerprint changes, so the gate does not compare the
// lazy map against itself. Every revision is recomputed INDEPENDENTLY by replaying the
// branch up to the entry that wrote it and hashing the state that comes out, and the map
// has to agree with that. Laziness is then pinned where it lives: the replay records the
// revision and hashes nothing, and `get` is what hashes.
async function gateProjectionFingerprintsAreComputedOnDemand() {
  // Consolidation held off for the same reason as gate 127: two roots are needed to tell
  // one fingerprint from another, and the shipped count seats them all under one parent.
  const runtime = await epochToolRuntime({
    turns: 16, resultChars: 6_000,
    thresholds: { ...context.DEFAULT_THRESHOLDS, consolidateAfter: 100 },
  });
  const built = runtime.built;
  const sessionId = built.sessionId;
  const stateEntryType = context.ACTIVE_CONTEXT_STATE_ENTRY;
  const foldRecordEntryType = context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY;

  // More revisions than any reader wants, which is the case the eager map paid for.
  await agentBriefsCuts(runtime, 3);
  // The band top, not the boundary: same reason as gate 127, the unbounded boundary commit
  // consolidates this fixture into one chapter and leaves nothing to compare. The window is
  // then measured back down, because the expand below has to be admissible and nothing is
  // at the band top.
  await measure(runtime, 76_000, 100_000);
  await project(runtime);
  await settle();
  await measure(runtime, 30_000, 100_000);
  await project(runtime);
  await settle();
  const snapshotNow = () => context.mapActiveContext({
    sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const roots = context.orderedRoots(materialized(runtime), snapshotNow()).map((root) => root.fold);
  assert(roots.length >= 2, `The fixture committed ${roots.length} root folds; two are needed`);
  // Four durable writes, so several revisions exist to fingerprint. They used to be an
  // expand and two rebriefs; rebrief was deleted on 2026-08-21, and what this gate needs
  // is revisions, not any particular verb.
  await toolCall(runtime, { action: "expand", id: roots[0].id });
  await toolCall(runtime, { action: "pin", ids: [roots[1].id] });
  await toolCall(runtime, { action: "unpin", ids: [roots[1].id] });
  await toolCall(runtime, { action: "expand", id: roots[1].id });

  const persistence = context.materializeStatePersistence(
    runtime.branch, sessionId, stateEntryType, foldRecordEntryType);

  // INDEPENDENT RECOMPUTATION. Replay the branch up to each state entry and hash what comes
  // out; nothing here consults the lazy map to decide what the answer should be.
  const stateEntryIndices = runtime.branch
    .map((entry, index) => (entry?.customType === stateEntryType ? index : -1))
    .filter((index) => index >= 0);
  assert(stateEntryIndices.length >= 4,
    `The fixture wrote ${stateEntryIndices.length} state entries; several revisions are needed ` +
    "or the per-revision cost this removes never existed in the fixture");
  const revisionsChecked = new Set();
  for (const index of stateEntryIndices) {
    const at = context.materializeActiveContextState(
      runtime.branch.slice(0, index + 1), sessionId, stateEntryType, foldRecordEntryType);
    assert.deepEqual(persistence.projectionFingerprints.get(at.revision), {
      topologySha256: context.topologySha256(at),
      protectionSha256: context.protectionSha256(at),
    }, `The fingerprint for revision ${at.revision} is not the one that revision's state hashes to`);
    revisionsChecked.add(at.revision);
  }
  assert(revisionsChecked.size >= 3,
    `Only ${revisionsChecked.size} distinct revisions were checked, so the map was barely read`);

  // Computed ONCE. The same object comes back, so a second reader re-hashes nothing.
  const revision = Math.max(...revisionsChecked);
  const first = persistence.projectionFingerprints.get(revision);
  assert(first && typeof first.topologySha256 === "string", "A written revision has no fingerprint");
  assert.equal(persistence.projectionFingerprints.get(revision), first,
    "A second read rebuilt the fingerprint instead of returning the one already computed");

  // A revision the ledger never wrote has none, which is what the restore path reads when a
  // receipt names a revision this branch does not carry.
  assert.equal(persistence.projectionFingerprints.get(revision + 10_000), undefined,
    "A revision the ledger never wrote answers with a fingerprint");

  // AND THE LAZINESS ITSELF, pinned where it lives: the replay records the revision and
  // hashes nothing. Without this the map could be eager again and every assertion above
  // would still pass.
  const source = readFileSync(join(projectRoot, "extensions", "lib", "persistence.ts"), "utf8");
  const remember = source.slice(
    source.indexOf("const rememberProjection = ("),
    source.indexOf("rememberProjection();"),
  );
  assert(remember.length > 0, "the projection recorder was not found where it is pinned");
  assert(!/topologySha256|protectionSha256/.test(remember),
    "materialisation hashes every revision it records, which is the cost this gate removes");
  assert(/fingerprintSources\.set\(state\.revision, state\)/.test(remember),
    "the recorder no longer holds the revision's own state, so a fingerprint could read another's");

  return {
    stateEntries: stateEntryIndices.length,
    revisionsChecked: revisionsChecked.size,
    cachedOnSecondRead: true,
  };
}

async function gateUserCommitAnnouncesPersistenceFailure() {
  const shape = { turns: 12, resultChars: 16_000, contextWindow: 100_000 };
  const bank = async (runtime) => {
    await startRuntime(runtime);
    // 60,000 against the 90,000-token budget is below the band top, so nothing commits
    // on its own: the agent's mark waits and the command is what spends it, which is the
    // path under test.
    await agentMarksBatch(runtime, 0);
    await measure(runtime, 60_000, 100_000);
    assert((materialized(runtime).pendingMarks ?? []).length >= 1,
      "The quiet band accumulated no mark, so the command had nothing to commit");
  };

  // ANTI-VACUITY. Unsabotaged, the same command commits, persists and says so. Without
  // this the assertions below would pass on a command that never did anything.
  const clean = makeRuntime(makeFixture({ ...shape, sessionId: "user-commit-clean" }));
  // BARE IS THE COMMIT (Shane, dogfooding 2026-08-22): no arguments applies the staged
  // pile exactly as "commit" does. The old bare form rescue-folded an auto-offered
  // chapter instead, which read as the command ignoring the staged pile.
  const bare = makeRuntime(makeFixture({ ...shape, sessionId: "user-commit-bare" }));
  await bank(bare);
  await bare.commands.get("fold").handler("", bare.ctx);
  await settle();
  assert(materialized(bare).folds.length > 0, "The bare form committed nothing");
  assert(bare.notifications.some((notice) => /Committed \d+ mark/.test(notice.message)),
    "The bare form did not report what it committed");
  await bank(clean);
  await bank(clean);
  await clean.commands.get("fold").handler("commit", clean.ctx);
  await settle();
  assert(materialized(clean).folds.length > 0, "The clean command persisted no fold");
  assert.equal(contextEvents(clean).filter((event) => event.kind === "context.suspend").length, 0,
    "A healthy user commit announced a suspension");
  assert(clean.notifications.some((notice) => /Committed \d+ mark/.test(notice.message)),
    "The clean command did not report what it committed");

  // THE FAILURE, FOR REAL, through the same injection point gate 123 uses.
  const fault = "durable state entry refused by the fixture";
  let armed = false;
  const runtime = makeRuntime(makeFixture({ ...shape, sessionId: "user-commit-loud" }), {
    beforeAppend(customType) {
      if (armed && customType === context.ACTIVE_CONTEXT_STATE_ENTRY) throw new Error(fault);
    },
  });
  await bank(runtime);
  armed = true;
  await runtime.commands.get("fold").handler("commit", runtime.ctx);
  await settle();

  const suspensions = contextEvents(runtime).filter((event) =>
    event.kind === "context.suspend" && event.outcome === "suspended");
  assert.equal(suspensions.length, 1,
    `The user command lost its persistence and announced it ${suspensions.length} time(s)`);
  assert(String(suspensions[0].error).includes(fault),
    `The suspension does not carry the failure that caused it: ${suspensions[0].error}`);
  assert.equal(suspensions[0].phase, "user-command",
    `The suspension names ${suspensions[0].phase} rather than the path that failed`);

  // AND IT DOES NOT CLAIM A COMMIT. The user is told the command failed, by name, and is
  // never handed a count of marks that no durable state holds.
  assert(!runtime.notifications.some((notice) => /Committed \d+ mark/.test(notice.message)),
    "The command reported marks committed after its persistence failed");
  assert(runtime.notifications.some((notice) => notice.message.includes(fault)),
    "The user was never told the command failed");

  // AND FOLDING REALLY STOPPED. A suspended session cannot reclaim anything, so continuing
  // to compute folds is the part that turned one dropped commit into a dead session.
  const applied = () => contextEvents(runtime).filter((event) =>
    event.kind === "context.commit" && event.deferred === false).length;
  const before = applied();
  await measureAndCommit(runtime, 95_000, 100_000, "post-suspend");
  assert.equal(applied(), before, "Folding kept committing after the user command suspended it");

  return {
    announced: suspensions.length,
    phase: suspensions[0].phase,
    committedClaimedAfterFailure: false,
    foldsStopped: true,
    cleanCommandFolds: materialized(clean).folds.length,
  };
}

// ---------------------------------------------------------------------------
// GATE 134 - a fact stated in the result's opening prose survives the fold it is
// committed with, before any model brief exists.
//
// The deterministic brief kept the FIRST LINE of a result. A result that opens
// with a header and then states what matters in prose on the next line therefore
// committed a brief holding the header alone. sol-20260814-traps rep 1 is the
// bill: folds committed at entries 107/111/121 carrying "STAGE 09 / read", the
// probe answered at entry 185, and the model brief that did carry the code word
// and the correction WITHDRAWING an earlier one landing at entry 311, 126 entries
// too late. The arm answered with cw-b7e4c1, a code word present nowhere in the
// run, and cited a source it had never read.
//
// The rule this pins: what a fold is COMMITTED with must stand on its own the
// moment the fold becomes visible. An asynchronous upgrade may improve the prose
// later; it must never be the first carrier of a fact the model needs. So the
// gate holds the generator unresolved for the whole run and asserts against the
// projection anyway.
// ---------------------------------------------------------------------------
async function gateOpeningProseSurvivesDeterministicFolding() {
  const CODE_WORD = "cw-d7148b";
  const stageResult = (turn) => [
    `STAGE ${String(turn).padStart(2, "0")} / read`,
    "Read every file delivered in this stage and build a working model of it. " +
      `Files in this stage: lib/file-${turn}.c, lib/other-${turn}.h. ` +
      `Audit note: the code word for stage ${String(turn).padStart(2, "0")} is ${CODE_WORD}. ` +
      "Audit note: the code word given for stage 06 was issued in error; " +
      `the code word for stage 06 is ${CODE_WORD}.`,
    "",
    `----- BEGIN lib/file-${turn}.c -----`,
    "b".repeat(9_000),
    `----- END lib/file-${turn}.c -----`,
  ].join("\n");

  // There is no generator: every fold is committed with, and stays on, its
  // deterministic brief.
  const runtime = makeRuntime(
    makeFixture({ turns: 8, resultText: stageResult, contextWindow: 100_000 }),
  );
  await startRuntime(runtime);
  await measure(runtime, 92_000, 100_000);
  // The boundary is the ONLY point the runtime mutates the projection, so the
  // fold is committed here rather than by pushing occupancy over a threshold.
  await compactBoundary(runtime);

  const projected = (await project(runtime)).messages;
  const state = materialized(runtime);
  assert(state.folds.length > 0, "the fixture folded nothing, so the gate proves nothing");
  const text = JSON.stringify(projected);

  // THE CLAIM. The committed brief carries the prose fact, with no model brief in
  // existence anywhere in the run.
  assert(text.includes(CODE_WORD),
    "a fact stated in the result's opening prose did not survive the fold it was committed with");
  // And it is the DETERMINISTIC brief carrying it.
  assert(state.folds.every((fold) => fold.provenance.kind === "deterministic"),
    "a non-deterministic brief landed, so this does not prove the deterministic carrier");

  // Anti-vacuity, both directions. The header alone is not what is being matched,
  // and a run whose results carry no prose still folds without inventing one.
  assert(text.includes("STAGE 0"), "the header vanished, so the head is not being read at all");
  const bare = makeRuntime(
    makeFixture({ turns: 8, resultChars: 9_000, contextWindow: 100_000 }),
  );
  await startRuntime(bare);
  await measure(bare, 92_000, 100_000);
  await compactBoundary(bare);
  const bareText = JSON.stringify((await project(bare)).messages);
  assert(!bareText.includes(CODE_WORD), "the gate matches a fact the fixture never stated");

  // Every deterministic brief still honours the contract it is bounded by, so
  // widening the head cannot smuggle an oversized placeholder into the window.
  for (const fold of state.folds) {
    assert(typeof fold.brief === "string" && fold.brief.length > 0, "a fold committed with no brief");
    assert(fold.brief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
      `a deterministic brief ran to ${fold.brief.length} chars, past the ${context.ACTIVE_CONTEXT_POLICY.maxBriefChars} contract`);
  }
  return {
    folds: state.folds.length,
    proseFactInProjection: true,
    longestBrief: Math.max(...state.folds.map((fold) => fold.brief.length)),
  };
}

// ---------------------------------------------------------------------------
// GATE 135 - a fact the agent recorded in its own turn survives the folds
// that hide the turn, at both depths.
//
// sol-20260814-traps rep 2 (no generator) lost probe-32-01 and probe-48-01 to
// one shape: a chain value the agent derived and recorded ONCE, in its own
// assistant message, between two tool batches. The tool fold's brief centred
// the call and its result, the parent's index was built from the children's
// briefs alone, and the recorded line reached zero briefs: one assistant
// message held "trace-a-02: lib/amigaos.c" and no projection ever showed it
// again. Native lost its one rep-2 probe to the same class, which is what
// makes this a carrier worth a law rather than a workload quirk.
//
// Two carriers, because absorption geometry varies. The tool fold whose batch
// the note closes appends it as an "agent noted" clause, so the fact is
// visible from the moment the FIRST fold hides the turn. The consolidation
// parent walks its whole span and seats every hidden assistant message's
// leading paragraph as its OWN subject in the division, whether the entry is
// an unclaimed gap (rep 2's geometry) or claimed into a tool child's interval
// (the denser geometry this fixture produces); only a chapter or
// consolidation child's claim is skipped, because those briefs already select
// their own assistant lines. A note as its own subject is what the division
// seats whole; the same words inside a truncated child subject are not. There
// is no generator: what a fold is COMMITTED with must carry the fact.
//
// THE LAW, narrowed to what finite briefs honestly satisfy (Shane 2026-08-14):
// an assistant message's LEADING paragraph is a first-class brief subject, and
// no assistant-note omission is silent. It is NOT "every note is named": the
// note bound cuts at 160, the division caps a seated subject's share, and the
// count-slice bounds how many subjects seat at all, so a brief legally omits.
// What is universal is the statement: the lead counts every note the walk
// found, the tail counts every subject the slice dropped, and a cut inside a
// seated subject leaves gate 136's marker. Later paragraphs of a multi-
// paragraph message are outside the law: the leading paragraph is the note.
// ---------------------------------------------------------------------------
async function gateAgentNotesSurviveConsolidation() {
  const TRACE_FACT = "trace-a-02: lib/amigaos-fixture.c";
  const noteFor = (turn) => turn === 3
    ? `${TRACE_FACT}\nRecorded for the dependency appendix.`
    : `Completed task ${turn} and noted its outcome.`;
  // SIZED TO THE FOLD FLOOR. A tool batch under minFoldChars is not a candidate at all
  // and a chapter is measured on its OWN content, with each tool result standing in as
  // its brief, so the results carry the batch past the floor and the padded user text
  // carries the chapter past it. Twenty turns leaves ten visible roots for the parent.
  const runtime = makeRuntime(
    makeFixture({
      turns: 20, resultChars: 10_000, chapterChars: 2_000, contextWindow: 100_000,
      assistantText: noteFor,
    }),
  );
  await startRuntime(runtime);
  await measure(runtime, 92_000, 100_000);
  await compactBoundary(runtime);
  const projected = (await project(runtime)).messages;
  const state = materialized(runtime);
  const parents = state.folds.filter((fold) => fold.kind === "consolidation");
  assert(parents.length > 0, "the fixture consolidated nothing, so the gate proves nothing");

  // THE CLAIM, downstream first: the parent that hides turn 3 carries the
  // recorded line as a note subject, the lead says notes ride beside folds,
  // and the visible projection shows the fact.
  const carrier = parents.find((fold) => String(fold.brief).includes(TRACE_FACT));
  assert(carrier,
    "an agent-recorded fact did not survive into the parent that hid its turn");
  assert(/covering \d+ folds and \d+ agent notes: /.test(String(carrier.brief)),
    "the lead does not say the index carries agent notes beside child folds");
  assert(JSON.stringify(projected).includes(TRACE_FACT),
    "the fact is in a stored brief but absent from the visible projection");
  // And at the shallower depth this fixture drives: the chapter that first
  // hid the turn seated the fact as one of its notes, so it was visible from
  // the FIRST fold that hid it, not only once a parent formed.
  const chapter = state.folds.find((fold) =>
    fold.kind === "chapter" && String(fold.brief).includes(TRACE_FACT));
  assert(chapter, "no chapter brief carries the note from its own span");

  // The third kind. A shallower session tool-folds the note's own batch
  // instead of chaptering it, and there the tool fold's brief appends the
  // note as an agent-noted clause the moment the batch folds.
  const shallow = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000, assistantText: noteFor }),
  );
  await startRuntime(shallow);
  await measure(shallow, 92_000, 100_000);
  await compactBoundary(shallow);
  const shallowState = materialized(shallow);
  const closer = shallowState.folds.find((fold) => String(fold.brief).includes(TRACE_FACT));
  assert(closer, "no identified brief carries the note that closed its own batch");
  assert(String(closer.brief).includes("agent noted \""),
    "the brief carries the fact outside the agent-noted clause");
  assert(shallowState.folds.some((fold) => fold.kind === "tool-result" &&
    /agent noted "/.test(String(fold.brief))),
    "no tool-result fold appends its closing note, so the batch path is unproven");

  // The real worker geometry. Rep 3 of sol-20260814-traps carried text and
  // the next tool call in the same assistant message 36 times out of 37, so a
  // walk that breaks on a tool-calling assistant BEFORE reading it collects
  // nothing all session: the sealed session holds zero agent-noted clauses.
  // The note about batch 3 rides in the message that opens batch 4, and batch
  // 3's brief is the one that must carry it.
  const pullNote = (turn) => turn === 4
    ? `${TRACE_FACT}\nRecorded while pulling the next stage.`
    : `Stage ${turn - 1} done, pulling on.`;
  const pulled = makeRuntime(
    makeFixture({ turns: 12, resultChars: 10_000, contextWindow: 100_000, pull: true, pullText: pullNote }),
  );
  await startRuntime(pulled);
  await measure(pulled, 92_000, 100_000);
  await compactBoundary(pulled);
  const pulledState = materialized(pulled);
  const pulledCarrier = pulledState.folds.find((fold) =>
    String(fold.brief).includes(TRACE_FACT) && String(fold.brief).includes("agent noted \""));
  assert(pulledCarrier,
    "the pull-shaped session lost the note that shares a message with the next call");
  assert(JSON.stringify((await project(pulled)).messages).includes(TRACE_FACT),
    "the pull-shaped projection dropped the recorded fact");
  assert(state.folds.every((fold) => fold.provenance.kind === "deterministic"),
    "a non-deterministic brief landed, so this does not prove the deterministic carrier");

  // Anti-vacuity: a run whose assistant turns never state the fact must not
  // grow it.
  const bare = makeRuntime(
    makeFixture({ turns: 14, resultChars: 6_000, contextWindow: 100_000 }),
  );
  await startRuntime(bare);
  await measure(bare, 92_000, 100_000);
  await compactBoundary(bare);
  assert(!JSON.stringify((await project(bare)).messages).includes(TRACE_FACT),
    "the gate matches a fact the fixture never stated");

  // The no-snapshot reading is the pre-change output byte for byte: callers
  // that cannot read exact evidence lose nothing they ever had, keep the
  // plain fold-count lead, and never see a note.
  const liveSnapshot = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  const parentCandidate = { kind: "consolidation", parts: carrier.parts };
  const withSnapshot = context.deterministicConsolidationBrief(
    parentCandidate, materialized(runtime), "pi_fold_context", liveSnapshot);
  const withoutSnapshot = context.deterministicConsolidationBrief(
    parentCandidate, materialized(runtime), "pi_fold_context");
  assert(withSnapshot.includes(TRACE_FACT), "the snapshot reading dropped the note");
  assert(!withoutSnapshot.includes(TRACE_FACT));
  assert(/covering \d+ folds: /.test(withoutSnapshot),
    "the no-snapshot lead changed, so pre-change callers changed output");

  // Every brief still honours the bound it is composed to.
  for (const fold of state.folds) {
    assert(typeof fold.brief === "string" && fold.brief.length > 0, "a fold committed with no brief");
    assert(fold.brief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
      `a brief ran to ${fold.brief.length} chars, past the ${context.ACTIVE_CONTEXT_POLICY.maxBriefChars} contract`);
  }

  // THE OVER-BOUND FIXTURE: more subjects than the count-slice can seat, so
  // real notes drop, and the drop must be STATED, twice over. The lead counts
  // every note the walk found, the tail counts exactly what the slice dropped,
  // and seated plus dropped covers the counted whole; the dropped note itself
  // is provably absent, so the statement is doing work rather than decorating
  // a brief that seated everything. Notes seat after children in span order,
  // so the slice drops the latest notes first: the last landmark is the probe.
  const wideTurns = 90;
  const wide = makeFixture({
    turns: wideTurns, tools: false, chapterChars: 40, contextWindow: 100_000,
    thresholds: TINY_FOLD_FLOOR,
    assistantText: (turn) => `Landmark ${turn}: value-${turn} recorded.`,
  });
  let wideState = context.emptyActiveContextState(wide.sessionId);
  const wideChapters = [];
  for (let start = 0; start < wideTurns; start += 4) {
    const end = Math.min(start + 3, wideTurns - 1);
    const committed = await commitCandidate(
      wideState, wide.snapshot,
      context.manualFoldCandidate(wide.snapshot, wideState,
        wide.turnEntries.slice(start, end + 1).flat()),
      { brief: `Chapters ${start} through ${end} of the landmark ledger stay recoverable.` },
    );
    wideState = committed.state;
    wideChapters.push(wideState.folds.at(-1).id);
  }
  const wideBrief = context.deterministicConsolidationBrief(
    { kind: "consolidation", parts: wideChapters.map((foldId) => ({ kind: "fold", foldId })) },
    wideState, "pi_fold_context", wide.snapshot,
  );
  const wideLead = /covering (\d+) folds and (\d+) agent notes: /.exec(wideBrief);
  assert(wideLead, "the over-bound parent lost its counting lead");
  assert.equal(Number(wideLead[1]), wideChapters.length,
    "the lead does not count every child fold");
  assert.equal(Number(wideLead[2]), wideTurns,
    "the lead does not count every note the walk found, so an unseated note goes uncounted");
  const wideTail = / \| (\d+) more in this group\.$/.exec(wideBrief);
  assert(wideTail, "an over-bound division dropped subjects without stating the count");
  const wideDropped = Number(wideTail[1]);
  assert(wideDropped > 0, "the fixture failed to overrun the count-slice, so the tail proves nothing");
  const wideSeated = wideBrief
    .slice(wideBrief.indexOf(": ") + 2, wideBrief.length - wideTail[0].length)
    .split(" | ").length;
  assert.equal(wideSeated + wideDropped, Number(wideLead[1]) + Number(wideLead[2]),
    "seated subjects plus the stated drop do not cover the counted whole");
  assert(!wideBrief.includes(`value-${wideTurns - 1}`),
    "the last note seated after all, so no omission was exercised");
  assert(wideBrief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    "the over-bound brief escaped the one policy cap");

  return {
    parents: parents.length,
    carrierNotes: Number(/and (\d+) agent notes/.exec(String(carrier.brief))?.[1]),
    briefChars: String(carrier.brief).length,
    closerBriefChars: String(closer.brief).length,
    overBoundSubjects: Number(wideLead[1]) + Number(wideLead[2]),
    overBoundSeated: wideSeated,
    overBoundDropped: wideDropped,
  };
}

// GATE 136 - a deterministic brief's cut is stated, never silent
//
// Sol's 2026-08-14 review generalized what Codex found at two sites to the class:
// factualValue and oneLine both ended in a bare slice while between them bounding
// call arguments, signatures, opening prose, joined agent notes, chapter asks and
// tool summaries, so a reader could not tell a cut value from a complete one. One
// primitive now owns every cut and leaves one marker with one meaning, content
// continues in the exact source. Commit-time wedge absorption was the same defect
// with higher stakes: it appended its bookkeeping sentence and then sliced at the
// policy cap, so a brief near the cap silently lost the sentence naming its
// absorbed entries. That repair is ELIGIBILITY, not truncation: a wedge whose
// truthful suffix does not fit is not absorbed at all, because the proposed fold
// cannot satisfy its brief contract; the gap stays raw for a later commit.
async function gateBriefTruncationIsExplicit() {
  // The primitive through its exported delegate. An over-bound value carries the
  // marker inside its bound; a within-bound value is returned whole with no
  // marker, so the marker can never be decoration.
  const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
  const bounded = context.oneLine(long, 40);
  assert(bounded.endsWith("..."), "an over-bound oneLine value does not state its cut");
  assert(bounded.length <= 40, "the marker pushed oneLine past its bound");
  assert(bounded.startsWith("alpha bravo"), "the bound did not keep the head");
  assert.equal(context.oneLine("short value", 40), "short value",
    "a within-bound value gained a marker it did not earn");
  // Surrogate safety survives the delegation: a cut landing inside an astral
  // pair drops the dangling high surrogate rather than emitting it. The pair is
  // built from its code point so no literal astral byte rides in this file.
  const astral = `${"x".repeat(36)}${String.fromCodePoint(0x1f600)}tail of the value`;
  const cut = context.oneLine(astral, 40);
  assert(cut.endsWith("..."), "an astral cut does not state itself");
  const beforeMarker = cut.charCodeAt(cut.length - 4);
  assert(!(beforeMarker >= 0xd800 && beforeMarker <= 0xdbff),
    "the cut emitted a dangling high surrogate before its marker");

  // factualValue reaches the same primitive after sanitization, driven through
  // the public tool brief. Identical fixtures except the argument value: the
  // over-length path forces exactly one cut, and the short control proves the
  // brief carries no marker anywhere when nothing was cut.
  const briefFor = (path, resultText = null) => {
    const built = makeFixture({
      turns: 2, resultChars: 120, contextWindow: 272_000,
      readArguments: () => ({ path }),
      resultText,
      thresholds: TINY_FOLD_FLOOR,
    });
    const empty = context.emptyActiveContextState(built.sessionId);
    const [candidate] = context.selectAutomaticToolBatch(built.snapshot, empty);
    assert(candidate, "the fixture offered no completed tool batch");
    return context.automaticToolBrief(built.snapshot, candidate);
  };
  const longPath = `stage/${"segment/".repeat(60)}leaf.txt`;
  const cutBrief = briefFor(longPath);
  assert(cutBrief.includes("..."), "an over-length argument was cut without a marker");
  assert(cutBrief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    "the marked brief escaped the one policy cap");
  assert(context.usefulBrief(cutBrief, undefined, "pi_fold_context"),
    "the marked brief stopped being useful");
  const wholeBrief = briefFor("stage/leaf.txt");
  assert(!wholeBrief.includes("..."),
    "a brief with nothing cut carries a marker anyway, so the marker means nothing");
  assert(wholeBrief.includes("stage/leaf.txt"), "the whole argument did not survive whole");
  // ONE cap (Shane 2026-08-14: "2k brief is more appropriate"). The deleted
  // 1,100 sub-cap held the composed identified brief below a line the policy
  // never drew, so a long opening paragraph now seats past it, whole and
  // unmarked, inside the one policy cap: under the sub-cap this brief was
  // impossible.
  const wideBrief = briefFor("stage/leaf.txt",
    (turn) => `Stage ${turn} finding: ${"w".repeat(1_500)}\n\nbulk body follows here.`);
  assert(wideBrief.length > 1_100,
    "a long paragraph stayed under the deleted sub-cap, so a second bound still binds");
  assert(wideBrief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    "the wide brief escaped the one policy cap");
  assert(!wideBrief.includes("..."), "a paragraph with room to seat whole was cut anyway");

  // The wedge law, on gate 65's geometry: two marks, one short turn wedged
  // between them, the LATER mark's brief sized against the policy cap. The
  // suffix length is learned from a real absorption first, so the boundary
  // asserts sit at the exact fit and one past it rather than at a guess.
  // No fresh tail so both marks are foldable, and the DEFAULT fold floor, because the
  // floor is what decides a wedge: a gap under it is absorbed and a gap at or over it
  // stands as its own fold. A one-character floor leaves nothing absorbable at all.
  const wedgeFixture = () => makeFixture({
    turns: 20, tools: false, chapterChars: 40, contextWindow: 100_000,
    thresholds: context.DEFAULT_THRESHOLDS,
  });
  const built = wedgeFixture();
  const span = (turn) => [built.turnEntries[turn][0], built.turnEntries[turn].at(-1)];
  const empty = context.emptyActiveContextState(built.sessionId);
  const stateWith = (lateBrief) => {
    let state = empty;
    for (const [turn, brief] of [[0, "Completed early work stays exactly recoverable."], [2, lateBrief]]) {
      state = context.addPendingMark(state, context.foldMarkFor({
        candidate: context.manualFoldCandidate(built.snapshot, empty, span(turn)),
        brief,
        briefProvenance: { kind: "deterministic" },
        origin: "agent",
        ordinal: 1,
      })).state;
    }
    return state;
  };
  const shortLate = "Completed late work stays exactly recoverable.";
  const absorbed = context.absorbWedgeMarks({
    snapshot: built.snapshot, state: stateWith(shortLate), charsPerToken: 4,
  });
  assert.equal(absorbed.absorbed.length, 1, "the short-brief control did not absorb its wedge");
  const suffix = ` It also holds ${absorbed.absorbed[0].entries} short adjacent entry(s) absorbed at commit.`;
  const grown = context.pendingMarks(absorbed.state)
    .find((mark) => mark.id === absorbed.absorbed[0].intoMarkId);
  assert.equal(grown.brief, `${shortLate}${suffix}`,
    "the absorbing brief does not carry the whole truthful suffix");
  const cap = built.snapshot.policy.maxBriefChars;
  const pad = (length) => `Completed late work stays exactly recoverable. ${"fact ".repeat(cap)}`
    .slice(0, length);
  // Exact fit absorbs: eligibility is the contract being satisfiable, not a margin.
  const exactFit = pad(cap - suffix.length);
  const atFit = context.absorbWedgeMarks({
    snapshot: built.snapshot, state: stateWith(exactFit), charsPerToken: 4,
  });
  assert.equal(atFit.absorbed.length, 1, "an exact-fit brief was refused its absorption");
  const fitGrown = context.pendingMarks(atFit.state)
    .find((mark) => mark.id === atFit.absorbed[0].intoMarkId);
  assert.equal(fitGrown.brief.length, cap, "the exact fit did not land exactly at the cap");
  assert(fitGrown.brief.endsWith(suffix), "the exact-fit brief lost its suffix");
  // One character past the fit is ineligible: nothing absorbed, the mark's own
  // brief untouched, and no sliced sentence anywhere.
  const overFit = pad(cap - suffix.length + 1);
  const past = context.absorbWedgeMarks({
    snapshot: built.snapshot, state: stateWith(overFit), charsPerToken: 4,
  });
  assert.deepEqual(past.absorbed, [],
    "a wedge whose truthful suffix does not fit was absorbed anyway");
  const survivor = context.pendingMarks(past.state)
    .find((mark) => mark.brief === overFit);
  assert(survivor, "the ineligible mark's own brief did not survive untouched");

  return {
    markerBoundedChars: bounded.length,
    cutBriefChars: cutBrief.length,
    wholeBriefMarkers: 0,
    wideBriefChars: wideBrief.length,
    absorbSuffixChars: suffix.length,
    exactFitBriefChars: fitGrown.brief.length,
    pastFitAbsorbed: past.absorbed.length,
  };
}

// GATE 137 - cache accounting names the topology point a request follows.
//
// Marks and peeks do not move old projection bytes, while expand and refold switch
// between two exact branches. The provider decides whether either branch is still hot;
// the runtime's job is to make that result joinable to the action that selected it.
// This gate changes no cache policy and sends no provider parameter.
async function gateCacheTopologyAccounting() {
  // Results over the fold floor, so the agent's mark alone clears the reclaim floor and
  // the commit this gate reads actually fires.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 10_000 });
  const stream = () => contextEvents(runtime);
  const latestPrefix = () => stream().filter((record) => record.kind === "context.prefix").at(-1);

  const topologyCuts = await frontierCuts(runtime);
  assert(topologyCuts.length >= 1, "The frontier cut nothing to brief");
  await briefCut(runtime, topologyCuts[0],
    "The first completed inspection remains exactly recoverable behind this fold.");
  await project(runtime);
  await settle();
  const afterMark = latestPrefix();
  // A BRIEF IS STEADY STATE, and that is the finding rather than a fixture detail. The old
  // reading expected `after-mark`, a class that existed because accepting a mark was an
  // agent action the topology had to account for even though it moved nothing. Writing a
  // brief on a pending fold is not even that: no state the projection reads changes, so
  // the request that follows is indistinguishable from one that follows nothing at all.
  // The class is the measurement saying the edit was free.
  assert.equal(afterMark.request_class, "steady-state",
    "Writing a brief on a pending fold registered as a context mutation");
  assert.equal(afterMark.divergent_char, null,
    "Writing a brief moved old projection bytes before the commit");

  // Measured below the fence rather than against it: the expand this gate performs next
  // has to be admissible, and at 88,000 of a 90,000-token budget nothing is.
  const prefixes = () => stream().filter((record) => record.kind === "context.prefix");
  const beforeCommit = prefixes().length;
  const committed = await runtimeCommit(runtime, { tokens: 76_000, contextWindow: 100_000 });
  assert.equal(committed.fired, true, "The cache-topology fixture never reached a fold commit");
  // THE FIRST request after the fold, not the last one in the stream. Since 2026-08-22 a
  // commit fires on the projection pass that crosses the trigger, so the drive to it
  // leaves further passes behind and the topology point being asserted is not last.
  const afterCommit = prefixes()[beforeCommit];
  assert(afterCommit, "The commit produced no following request to classify");
  assert.equal(afterCommit.request_class, "after-fold");
  const root = materialized(runtime).folds.find((fold) => fold.parentId === null);
  assert(root, "The marked span did not produce a root fold");

  await toolCall(runtime, { action: "expand", id: root.id });
  await project(runtime);
  await settle();
  const afterExpand = latestPrefix();
  assert.equal(afterExpand.request_class, "after-expand");
  assert.equal(afterExpand.cache_action, "expand");
  assert.equal(afterExpand.change, "rewrite");
  assert.match(afterExpand.cause, /context\.attempt:expand/);

  await toolCall(runtime, { action: "refold", id: root.id });
  await project(runtime);
  await settle();
  const afterRefold = latestPrefix();
  assert.equal(afterRefold.request_class, "after-refold");
  assert.equal(afterRefold.cache_action, "refold");
  assert.equal(afterRefold.change, "rewrite");
  assert.match(afterRefold.cause, /context\.attempt:refold/);

  await toolCall(runtime, { action: "peek", id: root.id, offset: 0, bytes: 1_024 });
  await project(runtime);
  await settle();
  const afterPeek = latestPrefix();
  assert.equal(afterPeek.request_class, "after-peek");
  assert.equal(afterPeek.cache_action, "peek");
  assert.equal(afterPeek.divergent_char, null,
    "The read-only peek action rewrote the projection in the harness");

  return {
    requestClasses: [
      afterMark.request_class,
      afterCommit.request_class,
      afterExpand.request_class,
      afterRefold.request_class,
      afterPeek.request_class,
    ],
    markMovedBytes: false,
    branchSwitches: 2,
  };
}

// GATE 138 - the steward advisory invites marking one band before the epoch.
//
// The surfacing falsification program (experiment gates 77-94) killed every cheap
// judge, leaving the agent itself the only relevance judge standing. The steward
// advisory is that verdict as runtime behavior: an EPHEMERAL projection-tail
// carrier states mechanical facts only and invites marks with agent briefs before
// the epoch takes the remainder with deterministic ones. It never pretends
// judgment, never mutates the prefix, and never enters the durable stream.
//
// THE BAND IS ANCHORED TO THE COMMIT TRIGGER (Shane, 2026-08-22), which is the
// correction this gate exists to hold. It used to open one inflow step below the
// SERVING BUDGET, and on any real deployment that is ABOVE the trigger: at the
// sealed 251,520-token budget with maxTarget 0.80 the epoch fires at 201,216 while
// the old band opened near 226,520, so the advisory arrived after the commit was
// already due. That is the mechanical half of why the sealed corpus recorded zero
// voluntary folds in 30 runs and 2,529 automatic ones: the agent was asked to mark
// at a moment when marking could no longer change anything. The band now opens at
// trigger - max(10% of budget, one worst recent inflow step) and stands until the
// budget. The inflow term is not decoration: a single large result can step the
// window from under a fixed band to over the trigger in one arrival, and a band
// nothing lands inside never asks. Yielding inside the wall band is DELETED for
// the same reason it was wrong: that is where the forward-looking trigger fires,
// which is the last moment marking still decides what folds.
//
// One context.steward event per crossing, not per pass.

// ---------------------------------------------------------------------------
// GATE 139 - an ephemeral peek is consumed by the reply that follows it.
// Build 4b (Shane 2026-08-20): peek gains an opt-in ephemeral parameter. The
// default is unchanged: a bare peek's result stays in the window like any
// tool result. With ephemeral true, the result rides the projection exactly
// until the model's next message, the same answered reading as the directed
// ask, then its index holds a one-line placeholder and the reply is the
// surviving trace. The registry is in-memory on purpose: a restart forgets it
// and the result stays durable, the safe default, while the durable entry
// keeps the exact bytes for folding and rollback either way. A message
// already projection-shaped (a fold's deterministic tool brief carries the
// same toolCallId) is never touched: only the raw result is the ephemeral one.
// ---------------------------------------------------------------------------
async function gateEphemeralPeek() {
  const runtime = await epochToolRuntime({ turns: 14 });
  await measureAndCommit(runtime, 80_500, 100_000);
  const state = materialized(runtime);
  assert(state.folds.length >= 1);
  const foldId = state.folds[0].id;
  const tool = runtime.tools.get("pi_fold_context");

  // The parameter is on the schema, validated, and stays reclaimable: a peek
  // the ladder cannot claim would linger as exactly the mass this exists to shed.
  assert(tool.parameters.properties.ephemeral,
    "the tool schema does not offer the ephemeral parameter");
  assert([...context.READ_ONLY_CONTEXT_ACTION_ARGUMENTS.peek].includes("ephemeral"),
    "an ephemeral peek stopped being auto-foldable");
  await assert.rejects(
    tool.execute("peek-junk", { action: "peek", id: foldId, ephemeral: "yes" },
      new AbortController().signal, undefined, runtime.ctx),
    /peek ephemeral must be a boolean/);

  // EPHEMERAL IS THE DEFAULT (Shane, 2026-08-22), and it is decided by one predicate
  // rather than by three call sites reading the raw parameter. Only an explicit false
  // is durable: a bare call, and anything the validator already rejected, reads
  // ephemeral, so a caller that never learned the argument gets the cheap read and can
  // still recover the bytes by peeking again.
  assert.equal(context.peekIsEphemeral(undefined), true);
  assert.equal(context.peekIsEphemeral({}), true);
  assert.equal(context.peekIsEphemeral({ action: "peek" }), true);
  assert.equal(context.peekIsEphemeral({ ephemeral: true }), true);
  assert.equal(context.peekIsEphemeral({ ephemeral: false }), false,
    "an explicit false is the only way to hold a peek in the window");

  // The bare call takes the default, and the payload says which contract it got, so the
  // agent never has to infer it from the absence of a field.
  const bare = await tool.execute("peek-bare", { action: "peek", id: foldId },
    new AbortController().signal, undefined, runtime.ctx);
  assert(String(bare.details.ephemeral ?? "").includes("until your next message"),
    "a bare peek did not take the ephemeral default");
  assert(/ephemeral false/.test(String(bare.details.ephemeral ?? "")),
    "the ephemeral payload does not name the escape to a durable read");
  runtime.appendMessage({
    role: "toolResult", toolCallId: "peek-bare", toolName: "pi_fold_context",
    content: [{ type: "text", text: "BARE-SENTINEL-51kd" }], isError: false,
  });
  runtime.appendMessage({ role: "assistant", content: [{ type: "text", text: "read it." }] });
  assert(!json.stableStringify((await project(runtime)).messages).includes("BARE-SENTINEL-51kd"),
    "a bare peek outlived the reply, so the default did not flip");

  // The escape works and is the ONLY thing that holds a result: explicit false outlives
  // the reply, which is the stage-64 shape (bytes wanted standing across several turns).
  const durable = await tool.execute("peek-durable",
    { action: "peek", id: foldId, ephemeral: false },
    new AbortController().signal, undefined, runtime.ctx);
  assert.equal(durable.details.ephemeral, undefined,
    "a durable peek claimed the ephemeral contract");
  assert(String(durable.details.durable ?? "").includes("stays in your context"),
    "a durable peek does not state its own contract");
  runtime.appendMessage({
    role: "toolResult", toolCallId: "peek-durable", toolName: "pi_fold_context",
    content: [{ type: "text", text: "DURABLE-SENTINEL-2c9a" }], isError: false,
  });
  runtime.appendMessage({ role: "assistant", content: [{ type: "text", text: "noted." }] });
  const afterDurable = json.stableStringify((await project(runtime)).messages);
  assert(afterDurable.includes("DURABLE-SENTINEL-2c9a"),
    "an explicitly durable peek was withdrawn anyway");

  // The schema states the default the runtime actually applies, since the description is
  // the only place the agent reads it from.
  assert(/[Dd]efault TRUE/.test(tool.parameters.properties.ephemeral.description),
    "the schema still advertises the old default");

  // Ephemeral: visible until answered, then the placeholder takes its index.
  const peeked = await tool.execute("peek-ephemeral",
    { action: "peek", id: foldId, ephemeral: true },
    new AbortController().signal, undefined, runtime.ctx);
  assert(String(peeked.details.ephemeral ?? "").includes("until your next message"),
    "the payload does not state the one-read contract");
  runtime.appendMessage({
    role: "toolResult", toolCallId: "peek-ephemeral", toolName: "pi_fold_context",
    content: [{ type: "text", text: "EPHEMERAL-SENTINEL-77aq" }], isError: false,
  });
  const beforeAnswerMessages = (await project(runtime)).messages;
  const beforeAnswer = json.stableStringify(beforeAnswerMessages);
  assert(beforeAnswer.includes("EPHEMERAL-SENTINEL-77aq"),
    "the one read: the result must be visible until the model answers");
  runtime.appendMessage({ role: "assistant", content: [{ type: "text", text: "the figure is 41." }] });
  const projectedAfter = (await project(runtime)).messages;
  const afterText = json.stableStringify(projectedAfter);
  assert(!afterText.includes("EPHEMERAL-SENTINEL-77aq"),
    "a consumed ephemeral peek still projected its bytes");
  const placeholder = projectedAfter.find((message) =>
    message?.role === "toolResult" && message?.toolCallId === "peek-ephemeral");
  assert(placeholder, "the reply must take over the result's index, not erase it");
  assert.equal(placeholder.content[0].text,
    "Ephemeral peek consumed; the reply that followed it is the surviving trace.");
  assert.equal(placeholder.details.projection, "ephemeral-peek-consumed");
  assert(afterText.includes("the figure is 41."),
    "the surviving trace is the reply itself");

  // THE CACHE PROPERTY, which is the whole reason the mechanism is worth
  // having. A withdrawal is a TAIL edit: it changes one result's content and
  // leaves every earlier message alone, so the provider's implicit prefix
  // cache keeps everything up to the withdrawn index. Asserting only the
  // visibility semantics above let a defect ship: the freeze compares this
  // pass's body prefix against the previous one, a withdrawal edits a body
  // index INSIDE that prefix, the comparison failed, and the projection was
  // rebuilt from the body without the receipts and riders the freeze had
  // buried mid-array over the session. Divergence then landed on the FIRST
  // buried carrier instead of the withdrawn result, so a tail edit rewrote the
  // session's whole cached prefix. Measured on this fixture the identical
  // prefix fell to 82.5 percent against 99.6 for an ordinary append; the
  // sealed sol-20260820 campaign paid 55.1 percent where the mechanism owed
  // 99.5. The gate pins the position rather than a share, because the share is
  // a property of how much buried carriage a session happens to hold.
  const withdrawnIndex = projectedAfter.findIndex((message) =>
    message?.toolCallId === "peek-ephemeral");
  const buriedBefore = beforeAnswerMessages
    .map((message, index) => (typeof message?.customType === "string" ? index : -1))
    .filter((index) => index >= 0);
  assert(buriedBefore.some((index) => index < withdrawnIndex),
    "the fixture holds no buried carrier before the withdrawal, so the prefix assertion is vacuous");
  for (const index of buriedBefore) {
    assert.equal(
      json.stableStringify(projectedAfter[index] ?? null),
      json.stableStringify(beforeAnswerMessages[index] ?? null),
      `the withdrawal moved the buried carrier at index ${index}: the frozen prefix was rebuilt`);
  }
  for (let index = 0; index < withdrawnIndex; index += 1) {
    assert.equal(
      json.stableStringify(projectedAfter[index] ?? null),
      json.stableStringify(beforeAnswerMessages[index] ?? null),
      `a withdrawal at index ${withdrawnIndex} changed message ${index}: this is not a tail operation`);
  }

  // The attempt event carries the request's shape for the campaign lens.
  const attemptEvents = runtime.appended
    .filter((entry) => String(entry.customType ?? "").endsWith("-event"))
    .map((entry) => entry.data)
    .filter((data) => data?.kind === "context.attempt" && data.action === "peek");
  assert(attemptEvents.some((data) =>
    data.tool_call_id === "peek-ephemeral" && data.ephemeral === true),
  "the ephemeral peek's attempt does not say so");
  // EVERY peek attempt states which contract it took, rather than only the ephemeral
  // ones. With ephemerality the default, absence would otherwise mean two different
  // things: a durable read on this build, or any read at all on a build before the
  // argument existed. A campaign lens has to be able to tell those apart.
  assert(attemptEvents.some((data) =>
    data.tool_call_id === "peek-bare" && data.ephemeral === true),
  "a bare peek's attempt does not record the default it took");
  assert(attemptEvents.some((data) =>
    data.tool_call_id === "peek-durable" && data.ephemeral === false),
  "an explicitly durable peek's attempt does not record the choice");

  // A projection-shaped result with the same call id is never touched: after a
  // fold claims the batch, its deterministic tool brief carries the toolCallId.
  await tool.execute("peek-guard", { action: "peek", id: foldId, ephemeral: true },
    new AbortController().signal, undefined, runtime.ctx);
  runtime.appendMessage({
    role: "toolResult", toolCallId: "peek-guard", toolName: "pi_fold_context",
    content: [{ type: "text", text: "GUARD-BRIEF-3k1x" }], isError: false,
    details: { projection: "deterministic-read-only-tool-brief" },
  });
  runtime.appendMessage({ role: "assistant", content: [{ type: "text", text: "done." }] });
  const guarded = json.stableStringify((await project(runtime)).messages);
  assert(guarded.includes("GUARD-BRIEF-3k1x"),
    "a fold's own projection placeholder was overwritten by the ephemeral withdrawal");

  // Restart degrade: a fresh runtime has no registry, so the result stays.
  const resumed = makeRuntime(runtime.built,
    { initialEntries: structuredClone(runtime.branch) });
  resumed.messages.length = 0;
  resumed.messages.push(...structuredClone(runtime.messages));
  await startRuntime(resumed);
  const resumedText = json.stableStringify((await project(resumed)).messages);
  assert(resumedText.includes("EPHEMERAL-SENTINEL-77aq"),
    "a restart must degrade to durable, never to silent loss");

  return {
    ephemeralDefault: true,
    durableOnExplicitFalse: true,
    oneRead: true,
    placeholderKeepsIndex: true,
    prefixIntactBeforeWithdrawnIndex: true,
    buriedCarriersHeld: true,
    attemptSaysEphemeral: true,
    foldPlaceholderUntouched: true,
    restartDegradesToDurable: true,
  };
}

// ---------------------------------------------------------------------------
// GATE 143 - a mark answers with the arithmetic of the commit it is heading for.
//
// The corpus that read as "agents will not govern their context" was measuring a
// window where they could not: the ladder claimed every completed batch before the
// band was reached, so unmarked_spans was 0 at every sealed crossing and the one
// fold action ever attempted across 30 runs had nothing left to name. The scale is
// not the obstacle either. Sealed rep 2 of sol-20260815-hidden ran 7 applied commits
// at a 251,520-token budget with 13, 15, 12, 15, 11, 10 and 17 applied marks, mean
// 13,640 tokens per mark and a median fold of 57,050 source chars, so a whole
// epoch's drop is ten to seventeen spans and ONE call carries sixty-four of them.
//
// What was missing is the number. An agent sees no occupancy, no threshold and no
// minTarget, so "mark what you are done with" is an instruction it cannot aim. Every
// mark now answers with the drop the next commit is sized to, what the standing
// marks will free when it runs, and what the ladder will take by age if nothing else
// is marked, from ONE definition shared with the fill that enforces it and the
// advisory that warns about it.
// ---------------------------------------------------------------------------

async function gateFoldSettingsRoundTrip() {
  const scratch = await mkdtemp(join(tmpdir(), "fold-settings-"));
  const path = join(scratch, "settings.json");
  try {
    // A missing settings file means package defaults, not an error.
    assert.deepEqual(settingsModule.loadFoldSettingsFile(path), {});

    // Round-trip: what /fold-settings saves resolves byte-identically through the SAME
    // resolveThresholds path registerPiFold validates with. One validation path, no
    // friendlier shadow rules for the UI to drift against.
    const wanted = { thresholds: { ...context.DEFAULT_THRESHOLDS, maxTarget: 0.5 } };
    settingsModule.saveFoldSettingsFile(path, wanted);
    const loaded = settingsModule.loadFoldSettingsFile(path);
    assert.deepEqual(loaded, wanted);
    assert.deepEqual(context.resolveThresholds(loaded.thresholds), loaded.thresholds);

    // The write is atomic: no temp file survives the rename.
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(scratch).sort(), ["settings.json"]);

    // A STORED FILE MAY NOT STOP THE AGENT (2026-08-22, from a live failure). The
    // deployment loads this file at module scope and hands it to registerPiFold, so a
    // throw here is a pi that does not start at all: shipping minFoldChars did exactly
    // that to the settings file written the day before, with "Failed to load extension
    // ...: thresholds must declare minFoldChars". The registration law is untouched, and
    // it is asserted here so the split is visible: resolveThresholds still refuses a
    // partial object, and it is the FILE READER that repairs rather than throws.
    assert.throws(() => context.resolveThresholds({ maxTarget: 0.5 }), /must declare/);

    // THE EXACT SHAPE THAT FAILED: a thresholds object from before minFoldChars existed.
    // It loads, it keeps every value the person tuned, the new field arrives at its
    // default, and the file on disk is whole again, so a partial object never survives to
    // be re-read against some later set of defaults.
    const aged = join(scratch, "aged.json");
    await writeFile(aged, JSON.stringify({
      thresholds: { maxTarget: 0.5, minTarget: 0.2, consolidateAfter: 10 },
    }));
    const agedLoad = settingsModule.readFoldSettingsFile(aged);
    assert.equal(agedLoad.refusal, null, `an aged settings file was refused: ${agedLoad.refusal}`);
    assert.equal(agedLoad.migrated, true, "an aged settings file loaded without migrating");
    assert.equal(agedLoad.settings.thresholds.maxTarget, 0.5,
      "the migration lost a value the person had tuned");
    assert.equal(agedLoad.settings.thresholds.minFoldChars,
      context.DEFAULT_THRESHOLDS.minFoldChars);
    assert.deepEqual(JSON.parse(await readFile(aged, "utf8")).thresholds,
      agedLoad.settings.thresholds, "the migrated file was not written back whole");
    assert.deepEqual(settingsModule.readFoldSettingsFile(aged),
      { settings: agedLoad.settings, refusal: null, migrated: false },
      "the second read of a migrated file migrates again");

    // A retired file key is DROPPED, not refused: /fold-settings itself wrote
    // providerInputBudget until 2026-08-21 (Shane: "I don't know what input budget is"),
    // so refusing it would revert a file this package created. Shares apply to the
    // model's own window now; the registration option survives only for a harness that
    // needs runs comparable across descriptor changes.
    const budgetFile = join(scratch, "budget.json");
    await writeFile(budgetFile, JSON.stringify({
      providerInputBudget: 250_000, thresholds: { ...context.DEFAULT_THRESHOLDS },
    }));
    const budgetLoad = settingsModule.readFoldSettingsFile(budgetFile);
    assert.equal(budgetLoad.refusal, null);
    assert.equal(budgetLoad.migrated, true);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(budgetFile, "utf8"))), ["thresholds"],
      "the retired key survived the migration it should have been dropped by");

    // The same law one level down: a retired THRESHOLD field is dropped, not refused.
    // freshTail was the fifth setting until fresh-tail protection was deleted
    // (2026-08-23), so a stored file carrying it is a file /fold-settings itself wrote,
    // and refusing it whole reverted maxTarget and minTarget to defaults over a key the
    // person never chose. The exact live shape: Shane's own deployment file.
    const tailFile = join(scratch, "fresh-tail.json");
    await writeFile(tailFile, JSON.stringify({
      thresholds: { maxTarget: 0.4, minTarget: 0.1, freshTail: 0.05, consolidateAfter: 10, minFoldChars: 8000 },
    }));
    const tailLoad = settingsModule.readFoldSettingsFile(tailFile);
    assert.equal(tailLoad.refusal, null, `a fresh-tail era file was refused: ${tailLoad.refusal}`);
    assert.equal(tailLoad.migrated, true, "a fresh-tail era file loaded without migrating");
    assert.equal(tailLoad.settings.thresholds.maxTarget, 0.4,
      "the migration lost a tuned value while dropping the retired field");
    assert.equal(tailLoad.settings.thresholds.minTarget, 0.1);
    const tailWritten = JSON.parse(await readFile(tailFile, "utf8")).thresholds;
    assert.equal(Object.hasOwn(tailWritten, "freshTail"), false,
      "the retired threshold field survived the write-back");
    assert.deepEqual(tailWritten, tailLoad.settings.thresholds,
      "the migrated fresh-tail file was not written back whole");
    // And the registration path still refuses it by name: the drop is the FILE READER's
    // repair, not a loosening of the one validation law.
    assert.throws(() => context.resolveThresholds({ ...context.DEFAULT_THRESHOLDS, freshTail: 0.05 }),
      /no freshTail field/);

    // A file that is genuinely INVALID reverts to package defaults with the reason kept
    // for the settings screen, and is left exactly as the person wrote it, because
    // overwriting it with defaults would destroy what they were trying to fix.
    const cases = [
      ["bad-share.json", JSON.stringify({ thresholds: { ...context.DEFAULT_THRESHOLDS, maxTarget: 1.5 } }), /maxTarget/],
      ["crossed.json", JSON.stringify({ thresholds: { ...context.DEFAULT_THRESHOLDS, minTarget: 0.9 } }), /minTarget/],
      ["alien.json", JSON.stringify({ summarizer: "luna" }), /no summarizer field/],
      ["broken.json", "{not json", /not valid JSON/],
      ["array.json", "[]", /must be a JSON object/],
    ];
    for (const [name, body, pattern] of cases) {
      const file = join(scratch, name);
      await writeFile(file, body);
      const load = settingsModule.readFoldSettingsFile(file);
      assert.deepEqual(load.settings, {}, `${name} was partly applied instead of refused`);
      assert(load.refusal && pattern.test(load.refusal),
        `${name} did not name its reason: ${load.refusal}`);
      assert(/Package defaults are in force/.test(load.refusal),
        `${name} states no consequence: ${load.refusal}`);
      assert.equal(await readFile(file, "utf8"), body,
        `${name} was rewritten under the person who wrote it`);
      assert.deepEqual(settingsModule.loadFoldSettingsFile(file), {},
        `${name} threw out of the loader the deployment calls at module scope`);
    }

    // One edit at a time, each applied against the WHOLE draft and re-validated whole.
    let draft = {};
    const edit = settingsModule.applyFoldSettingsEdit;
    draft = edit(draft, "maxTarget", "0.5").draft;
    assert.equal(draft.thresholds.maxTarget, 0.5);
    assert.equal(draft.thresholds.minTarget, context.DEFAULT_THRESHOLDS.minTarget,
     "/an edit fills the rest of the object from the current defaults, never from nothing");
    assert.deepEqual(context.resolveThresholds(draft.thresholds), draft.thresholds);

    // A cross-field violation leaves the draft unchanged and names the invariant.
    const held = draft;
    const refused = edit(draft, "minTarget", "0.9");
    assert.equal(refused.ok, false);
    assert(/minTarget/.test(refused.error), `cross-field refusal named the field: ${refused.error}`);
    assert.deepEqual(draft, held, "a refused edit must not touch the draft");

    // Counts are counts, and the fold floor is a whole number of characters with a hard
    // minimum of its own: below it a placeholder can cost more than the source.
    assert.equal(edit(draft, "consolidateAfter", "0").ok, false);
    assert.equal(edit(draft, "minFoldChars", "1999").ok, false);
    assert.equal(edit(draft, "minFoldChars", "8000.5").ok, false);
    const raised = edit(draft, "minFoldChars", "12000");
    assert.equal(raised.ok, true, `raising the fold floor was refused: ${raised.error}`);
    assert.equal(raised.draft.thresholds.minFoldChars, 12_000);
    assert.deepEqual(context.resolveThresholds(raised.draft.thresholds), raised.draft.thresholds);

    // The command exists on the public surface under the family name.
    const registered = [];
    settingsModule.registerFoldSettings({
      registerCommand: (name, definition) => registered.push({ name, definition }),
    });
    assert.deepEqual(registered.map((entry) => entry.name), ["fold-settings"]);
    assert(/pi-fold/.test(registered[0].definition.description),
      "the settings command description does not name the package");

    // THE EDITOR ITSELF, driven through its real input path. The first shipped editor
    // matched raw CSI arrow bytes and FROZE on terminals in application cursor mode
    // (SS3 \x1bOB): enter and typed characters are identical in every mode, which is
    // exactly why the user could change a value and then neither escape nor move.
    // Every key must route through matchesKey, which carries both encodings.
    const editorPath = join(scratch, "editor.json");
    let closed = null;
    const themeLike = { fg: (_role, text) => text, bold: (text) => text };
    const editor = new settingsModule.FoldSettingsEditor(
      {}, 251_520, editorPath, themeLike, (saved) => { closed = saved; },
    );
    const renders = () => editor.render(120).join("\n");
    // Both encodings move the cursor; assert the SELECTION moved, not just that no
    // exception flew, because a dead key handler also throws nothing.
    editor.handleInput("\x1bOB");
    assert(renders().includes("→ Post-commit aim"), "SS3 down did not move the selection");
    editor.handleInput("\x1b[A");
    assert(renders().includes("→ Commit trigger"), "CSI up did not move the selection back");

    // Steppable rows respond to LEFT/RIGHT by moving one allowed increment, clamped
    // at the range ends; the lattice is filtered against the current draft so
    // stepping can never leave the policy surface. Enter opens an exact-value
    // editor, which is also the only path to an off-lattice value like 0.63.
    editor.handleInput("\x1bOC");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.maxTarget, 0.85,
      "SS3 right did not step maxTarget by one increment (0.80 -> 0.85)");
    editor.handleInput("\x1b[D");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.maxTarget, 0.8,
      "CSI left did not step maxTarget back down");
    for (let i = 0; i < 20; i++) editor.handleInput("\x1bOC");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.maxTarget, 0.95,
      "stepping past the top of the range was not clamped at 0.95");
    // Enter opens the exact editor prefilled; an off-lattice value lands verbatim.
    editor.handleInput("\r");
    assert(renders().includes("Enter to apply"), "the exact-value editor did not open");
    for (let i = 0; i < 6; i++) editor.handleInput("\x7f");
    for (const character of "0.63") editor.handleInput(character);
    editor.handleInput("\r");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.maxTarget, 0.63,
      "an exact off-lattice value did not reach disk");
    // TYPING REPLACES THE PREFILL (2026-08-23): the first printable keystroke clears
    // the prefilled value, so "0.7" lands as 0.7 rather than appending to "0.63" and
    // refusing; the backspace loops above still work because editing keys keep the
    // prefill for adjustment.
    editor.handleInput("\r");
    assert(renders().includes("Enter to apply"), "the exact editor did not reopen");
    for (const character of "0.7") editor.handleInput(character);
    editor.handleInput("\r");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.maxTarget, 0.7,
      "typing into the prefilled editor did not replace the prefill");
    // An invalid exact entry renders the named error and writes nothing.
    editor.handleInput("\x1b[B");
    editor.handleInput("\r");
    for (let i = 0; i < 6; i++) editor.handleInput("\x7f");
    for (const character of "0.9") editor.handleInput(character);
    editor.handleInput("\r");
    assert(renders().includes("must sit below"), "a cross-field violation rendered no error");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.minTarget,
      context.DEFAULT_THRESHOLDS.minTarget, "a refused submenu edit reached disk");
    editor.handleInput("\x1b");

    // A row whose DISPLAY string is not its value re-fires onChange when its editor
    // closes: parseFloat would read "12,000 chars" as 12 and silently overwrite the
    // saved value, which is what the budget row used to catch with "300,000 tokens".
    // The fold floor is that row now. Every row re-fires onChange after its editor
    // closes and the apply already happened on the submit path, so the handler must be
    // inert for every one of them.
    editor.handleInput("\x1b[B");
    editor.handleInput("\x1b[B");
    assert(renders().includes("→ Minimum fold size"),
      "two SS3 downs did not reach the minimum fold size row");
    editor.handleInput("\r");
    assert(renders().includes("Enter to apply"), "the fold floor submenu did not open");
    for (let i = 0; i < 8; i++) editor.handleInput("\x7f");
    for (const character of "12000") editor.handleInput(character);
    editor.handleInput("\r");
    assert.equal(JSON.parse(readFileSync(editorPath, "utf8")).thresholds.minFoldChars, 12_000,
      "the applied fold floor was corrupted by its own display string");

    // Escape inside an open submenu cancels THE SUBMENU, not the screen.
    editor.handleInput("\r");
    assert(renders().includes("Enter to apply"), "the submenu did not reopen");
    editor.handleInput("\x1b");
    assert(closed === null, "escape inside a submenu closed the whole editor");
    editor.handleInput("\x1b");
    assert.equal(closed, true, "escape on the main list did not close the editor");

    return {
      roundTrip: loaded,
      editedMaxTarget: draft.thresholds.maxTarget,
      crossFieldRefusal: refused.error,
      command: registered[0].name,
      editorClosedWith: closed,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * MECHANISM. /fold-editor is a READ-ONLY MAP of the working window: committed folds
 * wear COLORED BOOKENDS (theme success opens, theme error closes), staged marks are
 * PROPOSED blocks in the warning/accent color so the user sees what the next commit
 * would take, raw gaps summarize what stays unmarked, pins badge their entries, and
 * Enter drills into any block (a fold lists its brief and entries; a raw run lists
 * its entries). The handler assembles plain data; the view holds no runtime
 * reference and NO MUTATION PATH -- opening it cannot move a byte. Later edit
 * actions must be skins over existing validated paths, never logic here. Keys go
 * through the INJECTED keybindings manager (/tree action names, user rebinding and
 * both arrow encodings for free).
 */
/**
 * THE POST-FOLD NOTICE, AND CONSOLIDATION ANNOUNCED THE SAME WAY (Shane, 2026-08-23).
 *
 * The frontier cuts behind the agent (gate 141) and the agent annotates what it cut
 * (gate 116). This is the carrier between them, and it is the whole reason the redesign
 * is not just eager staging with a new name: a fold nobody is told about is a fold nobody
 * can brief, and the measured failure of the mechanism it replaces was silence. The
 * steward band never opened once across a three-boundary session, so the agent was never
 * invited at all and nothing said so.
 *
 * Three properties, and each of them replaced something that was tried first:
 *
 * BATCHED, because a notice per cut is noise and the frontier cuts often.
 *
 * APPENDED ONCE, because the first cut of this withdrew and re-pushed the carrier at the
 * tail every pass, which moved the byte at its old index on a pass where nothing else had
 * and cost the occupancy anchor its provider count (gates 110 and 111 caught it).
 *
 * AND IT STANDS DOWN, because a carrier that cannot stop asking is one the agent learns
 * to skip.
 */

/**
 * MECHANISM. THE DETERMINISTIC CONDITION (Shane, 2026-08-24; promoted to the public
 * surface 2026-08-27). `postFoldNotice: false` silences the brief invitation: the
 * frontier still cuts, the commit still lands, and every fold goes out with the
 * runtime's own deterministic words. Born as the experiment arm that priced the
 * annotation lane against the same plan; promoted when that arm won the
 * fold-vs-compaction campaign (14/14/9/8 correct across the silenced draws against the
 * invited condition's 3, the errors tracking the annotations), because a reader must be
 * able to run the winning shape. The agent verbs stay on the tool either way, so the
 * old refusal rationale, an agent that can never annotate what it is never told about,
 * is now the documented tradeoff of choosing false rather than a reason to bar the
 * choice.
 */
async function gateFoldNoticeSilenced() {
  const noticeType = "pi-fold-active-context-fold-notice";
  const notices = (projected) => projected.messages
    .filter((message) => message?.customType === noticeType);
  const runtime = await epochToolRuntime({ turns: 7, resultChars: 9_000, postFoldNotice: false });
  await measure(runtime, 20_000, 100_000);
  const cut = await frontierCuts(runtime);
  assert(cut.length >= context.UNBRIEFED_FOLDS_BEFORE_NOTICE,
    `The frontier cut ${cut.length} folds, under the batch the notice would speak past`);
  assert.equal(notices(await project(runtime)).length, 0,
    "The silenced runtime appended a notice anyway");
  // The commit lands and every fold carries the runtime's own words.
  const committed = await measureAndCommit(runtime, 86_000, 100_000);
  assert(committed.folds.length > 0, "The silenced condition folded nothing");
  for (const fold of committed.folds) {
    assert.equal(fold.provenance.kind, "deterministic",
      `Fold ${fold.id} carries ${fold.provenance.kind} provenance under the silenced condition`);
  }
  // A DEPLOYMENT OPTION since 2026-08-27 (Shane, on the campaign verdict: the silenced
  // deterministic condition won, so a deployment must be able to run the winning shape).
  // The door accepts the boolean and still refuses a non-boolean by name, so a truthy
  // string cannot silently keep the invitation on.
  piFold.registerPiFold(
    { registerTool() {}, registerCommand() {}, on() {} }, { postFoldNotice: false });
  assert.throws(
    () => piFold.registerPiFold(
      { registerTool() {}, registerCommand() {}, on() {} }, { postFoldNotice: "off" }),
    /postFoldNotice must be a boolean/,
    "registerPiFold accepted a non-boolean invitation switch");
  return {
    cutsStaged: cut.length,
    noticesWhileSilenced: 0,
    foldsCommitted: committed.folds.length,
    deterministicProvenance: true,
    publicOption: true,
  };
}

async function gateFoldNoticeInvitesBriefs() {
  const noticeType = "pi-fold-active-context-fold-notice";
  const notices = (projected) => projected.messages
    .filter((message) => message?.customType === noticeType);

  // BELOW THE BATCH IT SAYS NOTHING. One cut is not worth a turn's attention, and a
  // carrier that speaks on every cut is one the agent learns to skip.
  // THE DEFAULT IS SILENT (Shane 2026-08-28). postFoldNotice defaults false, the shape
  // the campaign measured, so every fixture below asks for the invitation explicitly and
  // this is the claim that the unasked-for runtime never speaks at all.
  const unasked = await epochToolRuntime({ turns: 7, resultChars: 9_000 });
  await measure(unasked, 20_000, 100_000);
  const unaskedCuts = await frontierCuts(unasked);
  assert(unaskedCuts.length >= context.UNBRIEFED_FOLDS_BEFORE_NOTICE,
    `The default-silence fixture cut ${unaskedCuts.length} folds, too few to have spoken`);
  assert.equal(notices(await project(unasked)).length, 0,
    "The notice spoke on a runtime that never asked for it");

  const thin = await epochToolRuntime({ turns: 2, resultChars: 9_000, postFoldNotice: true });
  await measure(thin, 20_000, 100_000);
  const thinCuts = await frontierCuts(thin);
  assert(thinCuts.length > 0 && thinCuts.length < context.UNBRIEFED_FOLDS_BEFORE_NOTICE,
    `The quiet fixture cut ${thinCuts.length} folds, so the silence below the batch is untested`);
  assert.equal(notices(await project(thin)).length, 0,
    "The notice spoke before a batch of unbriefed folds had built up");

  // PAST IT, IT NAMES EVERY UNBRIEFED FOLD AND ASKS FOR THE ONE THING THE AGENT HAS.
  // Seven turns is deliberate: the frontier stages at most MAX_FRONTIER_CUTS_PER_PASS in
  // a pass, so a fixture inside that bound has its whole frontier standing when the
  // notice first speaks and the naming can be checked for completeness rather than for
  // overlap.
  const runtime = await epochToolRuntime({ turns: 7, resultChars: 9_000, postFoldNotice: true });
  await measure(runtime, 20_000, 100_000);
  const cut = await frontierCuts(runtime);
  assert(cut.length >= context.UNBRIEFED_FOLDS_BEFORE_NOTICE &&
    cut.length <= context.MAX_FRONTIER_CUTS_PER_PASS,
  `The frontier cut ${cut.length} folds, outside the one-pass window this gate measures`);
  const spoken = notices(await project(runtime));
  assert.equal(spoken.length, 1, `The notice appeared ${spoken.length} times, not once`);
  const text = String(spoken[0].content);
  for (const fold of cut) {
    assert(text.includes(fold.id), `The notice does not name unbriefed fold ${fold.id}`);
  }
  const named = new Set(text.match(/fold_[0-9a-f]{16,}/g) ?? []);
  const standing = new Set(cut.map((fold) => fold.id));
  for (const id of named) assert(standing.has(id), `The notice named ${id}, which is not a pending fold`);
  // EACH ROW IDENTIFIES ITS SPAN (2026-08-24). The pending mark carries the
  // deterministic brief the runtime cut it with, and a notice that withheld it made the
  // dogfooded agent GUESS which spans its briefs were for ("I need to brief three
  // pending folds. What are they? Likely: ..."), where a wrong guess writes an
  // accurate-sounding brief onto the wrong fold. The head is the identification; a row
  // longer than its bound states the cut.
  for (const fold of cut) {
    assert(typeof fold.brief === "string" && fold.brief.length > 0,
      `Pending fold ${fold.id} carries no deterministic brief for its row to show`);
    assert(text.includes(`${fold.id} (`) && text.includes(fold.brief.slice(0, 40)),
      `The notice row for ${fold.id} does not carry its own head: ${fold.brief.slice(0, 60)}`);
  }
  assert(cut.some((fold) => fold.brief.length > 160) &&
    /\.\.\./.test(text), "No bounded row stated its cut");
  assert(/"action":"brief"/.test(text), "The notice does not say how to answer it");
  assert(/costs your window nothing/.test(text),
    "The notice does not state the price of answering, which is the reason to answer");
  assert(/still in front of you/.test(text),
    "The notice does not say the material it names is still raw");
  assert.equal(spoken[0].details.ephemeral, true, "The notice is not ephemeral");

  // IT IS AN APPEND, which is the property that makes the whole redesign affordable. A
  // quiet pass is byte-identical, and a pass that carries new material leaves every byte
  // in front of the new material exactly where it was, the notice included. The first cut
  // of this withdrew and re-pushed the carrier at the tail every pass, which moved the
  // byte at its old index and cost gates 110 and 111 their occupancy anchor.
  const before = (await project(runtime)).messages;
  assert.equal(json.stableStringify((await project(runtime)).messages),
    json.stableStringify(before), "A quiet pass moved a byte, so the notice is not an append");
  await measure(runtime, 21_000, 100_000);
  const after = (await project(runtime)).messages;
  assert(after.length > before.length, "The arriving measurement did not reach the projection");
  assert.equal(json.stableStringify(after.slice(0, before.length)),
    json.stableStringify(before),
    "New material rewrote the prefix in front of it, so the notice does not hold its index");

  // AND IT NEVER RE-ASKS FOR A BRIEF THE AGENT ALREADY WROTE. The notice is built from
  // live state on every pass the projection is rebuilt, so what the agent answered leaves
  // it: an epoch that applies the whole briefed batch leaves nothing for it to name.
  for (const fold of cut) {
    const result = await briefCut(runtime, fold,
      `Inspection ${fold.id.slice(5, 11)} stays exactly recoverable behind this fold.`);
    assert(!result.isError, `The brief on ${fold.id} was refused: ${JSON.stringify(result)}`);
  }
  assert((await frontierCuts(runtime)).every((fold) => fold.briefed),
    "A brief did not land on the fold it named");
  await measureAndCommit(runtime, 86_000, 100_000, "notice-stand-down");
  const answered = notices(await project(runtime));
  const stillNamed = new Set(String(answered[0]?.content ?? "").match(/fold_[0-9a-f]{16,}/g) ?? []);
  for (const id of standing) {
    assert(!stillNamed.has(id), `The notice kept asking for a brief the agent already wrote on ${id}`);
  }

  // WHEN IT RUNS OUT OF ROOM, THE LIST GIVES WAY AND SAYS SO. The instruction is fixed
  // and the fold count is not: the frontier stages faster than the agent answers, so the
  // pending set outgrows any bound eventually. Probed at the boundary rather than at a
  // guess, and from both sides, because a notice that silently stops listing reads as a
  // complete list, which is gate 136's law on a carrier the agent acts from.
  const wideList = (count) => curationModule.foldNoticeText({
    unbriefed: Array.from({ length: count }, (_, index) => ({
      id: `fold_${String(index).padStart(24, "0")}`, kind: "tool-result", tokens: 2_130,
    })),
    pending: count,
    toolName: "pi_fold_context",
  });
  let seatedWhole = 1;
  while (seatedWhole < 64 && !/lists the other/.test(wideList(seatedWhole))) seatedWhole += 1;
  assert(seatedWhole < 64, "The notice never states an omission, at any fold count");
  const whole = wideList(seatedWhole - 1);
  assert(!/lists the other/.test(whole),
    "The notice claimed an omission on a list it seated whole");
  assert(Buffer.byteLength(whole, "utf8") <= context.FOLD_NOTICE_BYTES,
    `A whole list ran to ${Buffer.byteLength(whole, "utf8")} bytes, past the notice bound`);
  const cutList = wideList(seatedWhole);
  assert(Buffer.byteLength(cutList, "utf8") <= context.FOLD_NOTICE_BYTES,
    `The bounded notice ran to ${Buffer.byteLength(cutList, "utf8")} bytes, past its own bound`);
  const seatedIds = (cutList.match(/fold_[0-9a-f]{16,}/g) ?? []).length;
  assert(new RegExp(`lists the other ${seatedWhole - seatedIds}\\.`).test(cutList),
    `The notice seated ${seatedIds} of ${seatedWhole} folds and miscounted the rest: ${cutList}`);
  for (const line of ['"action":"brief"', "costs your window nothing", "still in front of you"]) {
    assert(cutList.includes(line),
      `A 200-fold batch cost the notice its instruction: ${line} is gone`);
  }

  // CONSOLIDATION RIDES THE SAME CARRIER. A parent's brief indexes ten children and is
  // the entry the agent navigates by, so the parent is staged at the frontier and
  // announced like any other cut rather than being computed inside the commit, where
  // nothing the agent can reach ever sees it.
  const wide = await epochToolRuntime({ turns: 26, resultChars: 9_000 });
  await measureAndCommit(wide, 86_000, 100_000, "consolidation-epoch");
  const folds = materialized(wide).folds;
  const parents = folds.filter((fold) => folds.some((child) => child.parentId === fold.id));
  assert(parents.length >= 1,
    `The fixture built ${folds.length} folds and no consolidation parent, so nothing is announced`);
  for (const parent of parents) {
    assert(typeof parent.brief === "string" && parent.brief.trim(),
      `Consolidation parent ${parent.id} carries no brief`);
  }

  return {
    unbriefedBeforeNotice: context.UNBRIEFED_FOLDS_BEFORE_NOTICE,
    silentAt: thinCuts.length,
    cutsNamed: cut.length,
    noticesWhileUnbriefed: 1,
    quietPassIsByteIdentical: true,
    prefixHeldAcrossArrival: true,
    briefedFoldsStillNamed: 0,
    foldsSeatedWhole: seatedWhole - 1,
    consolidationParents: parents.length,
  };
}

async function gateFoldEditorRendersReadOnly() {
  const editorModule = await jiti.import(join(projectRoot, "extensions", "lib", "editor-ui.ts"));

  // Registered through the real command surface, described honestly.
  const runtime = await epochToolRuntime({ turns: 10, resultChars: 9_000 });
  const command = runtime.commands.get("fold-editor");
  assert(command, "/fold-editor is not registered");
  assert(/editor/i.test(command.description),
    `The editor command does not say what it is: ${command.description}`);

  // One committed fold (green/red bookends around it), one PROPOSED mark, one pin,
  // and at least one raw gap so all four shapes render from real state.
  //
  // The commit is driven SHALLOW on purpose. A boundary at 95,000 against this budget
  // asks to free more than the whole fixture holds, so it takes every span there is and
  // the mark and the pin below have nothing raw left to land on. The commit depth is
  // `used - minTarget * budget`, so the pressure is set just far enough above the floor
  // to buy one fold and no more. Fresh-tail used to leave the tail raw whatever the
  // depth; with the proportion deleted the fixture has to state what it wants directly.
  await measure(runtime, 40_000, 100_000);
  const editorCuts = await frontierCuts(runtime);
  assert(editorCuts.length >= 2, "The frontier cut too little for the editor to render");
  await briefCut(runtime, editorCuts[0], "A finished inspection stays exactly recoverable behind this fold.");
  // One span held RAW across the commit, so there is still something for the editor to
  // render as PROPOSED afterwards. The boundary commit carries a waiver and is deliberately
  // not depth-bounded, so without a hold it takes every pending cut and the editor has only
  // committed folds and pins left to show.
  const heldRaw = runtime.built.turnEntries[5];
  await toolCall(runtime, { action: "pin", ids: heldRaw });
  await runtimeCommit(runtime, { tokens: 26_000, contextWindow: 100_000 });
  await toolCall(runtime, { action: "unpin", ids: heldRaw });
  const stillPending = await frontierCuts(runtime);
  assert(stillPending.length >= 1, "The commit left nothing pending for the editor to show as proposed");
  await briefCut(runtime, stillPending[0], "A second finished inspection, still staged.");
  await toolCall(runtime, { action: "pin", ids: [runtime.built.turnEntries[7][2]] });

  // Drive the REAL handler with a THEMED ui: capture the view it opens and record
  // which theme colors the view asked for, proving bookends are colored by name.
  const opened = [];
  const colorsUsed = new Set();
  const themedUi = {
    fg: (color, text) => {
      colorsUsed.add(color);
      return `[${color}]${text}[/${color}]`;
    },
  };
  runtime.ctx.ui.custom = async (factory) => {
    opened.push(factory(null, themedUi, null, () => {}));
    return opened.at(-1);
  };
  await command.handler("", runtime.ctx);
  await settle();
  assert.equal(opened.length, 1, "the handler did not open exactly one editor");
  const liveView = opened[0];
  const rendered = liveView.render(140).join("\n");

  // THE BOOKENDS, COLORED BY THEME NAME.
  assert(/\[success\]\u25b8 fold/.test(rendered), "no green opening line on the committed fold");
  assert(!/\u25b2 end/.test(rendered), "a collapsed fold rendered an end bookend");
  // `warning` is the RUNTIME's proposal and `accent` is a person's. Every proposal on this
  // fixture is the frontier's, so warning is what it must ask for; gate 145 lays a user
  // mark in the editor and owns the accent half.
  assert(colorsUsed.has("success") && colorsUsed.has("warning"),
    `bookends did not ask for theme colors: ${[...colorsUsed].join(",")}`);

  // THE PROPOSED BLOCK: the staged mark renders distinct from committed folds.
  assert(/PROPOSED \(ladder\)/.test(rendered),
    "the runtime's pending cut does not render as a proposed block");
  assert(colorsUsed.has("accent") || colorsUsed.has("warning"),
    "proposed blocks did not ask for a distinct color");

  // RAW GAPS summarize what stays unmarked; pins badge their entries on drill-in.
  assert(/raw ×\d+/.test(rendered), "no raw-gap summary row");
  assert(/pinned: 1/.test(rendered), "the pin count is missing from the header");

  // DRILL-IN: expanding the committed fold reveals its brief; expanding the raw run
  // lists individual entries with the pin badged.
  const drillKb = { requested: "", matches: (_data, name) => name === drillKb.requested };
  drillKb.requested = "tui.select.down";
  liveView.handleInput("\x1b[B"); // onto the next block after the first
  drillKb.requested = "tui.select.confirm";
  liveView.handleInput("\r");
  const drilled = liveView.render(140).join("\n");
  assert(drilled !== rendered || drilled.includes("· "), "drill-in changed nothing");

  // THE VIEW NEVER SEES RUNTIME OBJECTS: buildFoldEditorBlocks returns plain data.
  const plain = editorModule.buildFoldEditorData(
    { mapped: [
      { ref: { entryId: "e0", role: "user" }, message: { role: "user", content: "hello" } },
      { ref: { entryId: "e1", role: "assistant" }, message: { role: "assistant", content: "hi" } },
    ] },
    { folds: [], protected: [] },
    {
      foldRows: () => [],
      pendingMarkRefs: () => [],
      mappedRange: (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => ({
        id: from + offset === 0 ? "e0" : "e1",
        role: from + offset === 0 ? "user" : "assistant",
        preview: "",
      })),
      entryCount: 2,
    },
  );
  assert.equal(plain.length, 1, "an uncovered stretch did not become one raw gap");
  assert.equal(plain[0].type, "raw", "the gap block has the wrong type");

  // A PROPOSED BLOCK'S ENTRIES RESOLVE OFF THE MAPPED WINDOW (2026-08-23): the
  // builder used to fabricate role "" and preview "" for staged marks, so drill-in
  // listed bare ids and the user had to peek elsewhere to judge the mark.
  const withMark = editorModule.buildFoldEditorData(
    { mapped: [
      { ref: { entryId: "e0", role: "user" }, message: { role: "user", content: "hello" } },
      { ref: { entryId: "e1", role: "assistant" }, message: { role: "assistant", content: "hi" } },
    ] },
    { folds: [], protected: [] },
    {
      foldRows: () => [],
      pendingMarkRefs: () => [{ id: "m1", origin: "ladder", brief: "b", entryIds: ["e0", "e1"] }],
      mappedRange: (from, to) => Array.from({ length: to - from + 1 }, (_, offset) => ({
        id: from + offset === 0 ? "e0" : "e1",
        role: from + offset === 0 ? "user" : "assistant",
        preview: from + offset === 0 ? "hello" : "hi",
      })),
      entryCount: 2,
    },
  );
  const proposedBlock = withMark.find((block) => block.type === "proposed");
  assert(proposedBlock, "the staged mark did not become a proposed block");
  assert.deepEqual(proposedBlock.entries.map((entry) => entry.role), ["user", "assistant"],
    "proposed entries do not carry their mapped roles");
  assert.deepEqual(proposedBlock.entries.map((entry) => entry.preview), ["hello", "hi"],
    "proposed entries do not carry their mapped previews");

  // LEFT COLLAPSES THE FOLD YOU ARE INSIDE: expand the parent, walk down into a
  // message row, and one Left folds the parent back up and lands on it.
  const leftKb = { requested: "", matches: (_data, name) => name === leftKb.requested };
  const leftView = new editorModule.FoldEditorView({
    title: "t",
    occupancy: { usedTokens: 50_000, budgetTokens: 100_000, commitOccupancy: 0.8, commitDue: false },
    blocks: [{
      type: "fold", id: "fold_p", startPosition: 0, endPosition: 3, kind: "chapter",
      brief: "parent brief", sourceCount: 3,
      children: [{
        type: "fold", id: "fold_c", startPosition: 1, endPosition: 2, kind: "tool-result",
        brief: "child brief", sourceCount: 1, children: [],
      }],
      entries: [
        { id: "e1", role: "user", preview: "first message" },
        { id: "e2", role: "toolResult", preview: "second message" },
      ],
    }],
    pending: { count: 0, agentMarks: 0, ladderMarks: 0, freedTokens: 0 },
    pinned: [],
  }, () => {}, leftKb);
  leftKb.requested = "tui.select.confirm";
  leftView.handleInput("\r"); // expand the parent: children and messages appear
  let out = leftView.render(140).join("\n");
  assert(out.includes("fold_c") && out.includes("first message"),
    "expanding the parent did not reveal child and messages");
  leftKb.requested = "tui.select.down";
  leftView.handleInput("\x1b[B"); // onto the child fold row
  leftView.handleInput("\x1b[B"); // onto the first message row
  out = leftView.render(140).join("\n");
  assert(/\u276f|❯/.test(out) && out.includes("first message"),
    "the message row did not take the highlight");
  leftKb.requested = "tui.editor.cursorLeft";
  leftView.handleInput("\x1b[D");
  out = leftView.render(140).join("\n");
  assert(!out.includes("fold_c") && !out.includes("first message"),
    "left did not collapse the containing fold");
  assert(leftView.selectedKey === "fold_p",
    `left did not land on the collapsed fold: ${leftView.selectedKey}`);

  // READ-ONLY, STRUCTURALLY: freeze the data and feed every navigation key. A view
  // that mutates its input throws under the freeze; nothing here does.
  const frozenData = Object.freeze({
    title: "t",
    occupancy: Object.freeze({ usedTokens: 50_000, budgetTokens: 100_000, commitOccupancy: 0.8, commitDue: false }),
    blocks: Object.freeze([Object.freeze({
      type: "fold", id: "fold_x", startPosition: 0, endPosition: 2, kind: "tool-result",
      brief: "b", sourceCount: 3,
    })]),
    pending: Object.freeze({ count: 1, agentMarks: 1, ladderMarks: 0, freedTokens: 100 }),
    pinned: Object.freeze([]),
  });
  let closed = 0;
  const byteKb = {
    "\x1b[A": "tui.select.up",
    "\x1b[B": "tui.select.down",
    "\x1b[5~": "tui.select.pageUp",
    "\x1b[6~": "tui.select.pageDown",
    "\r": "tui.select.confirm",
    "\x1b": "tui.select.cancel",
  };
  const frozenView = new editorModule.FoldEditorView(frozenData, () => { closed += 1; },
    { matches: (data, name) => byteKb[data] === name }, themedUi);
  for (const key of ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\r", "x"]) {
    frozenView.handleInput(key);
  }
  assert.equal(closed, 0, "navigation keys closed the editor");
  frozenView.handleInput("\x1b");
  assert.equal(closed, 1, "escape did not close the editor");
  assert.equal(frozenView.closed, true, "escape did not latch the closed state");
  frozenView.handleInput("\x1b");
  assert.equal(closed, 1, "escape after close re-fired done");

  // SCROLLING FOLLOWS THE SELECTION AND CLAMPS AT BOTH ENDS.
  const manyBlocks = Array.from({ length: 60 }, (_, i) => ({
    type: "fold", id: `fold_${String(i).padStart(2, "0")}`, startPosition: i * 3,
    endPosition: i * 3 + 1, kind: "tool-result", brief: "", sourceCount: 2,
  }));
  const scroller = new editorModule.FoldEditorView({
    title: "t",
    occupancy: { usedTokens: 50_000, budgetTokens: 100_000, commitOccupancy: 0.8, commitDue: false },
    blocks: manyBlocks,
    pending: { count: 0, agentMarks: 0, ladderMarks: 0, freedTokens: 0 },
    pinned: [],
  }, () => {}, null, themedUi);
  assert(scroller.render(140).join("\n").includes("fold_00"), "scrolling start is not the top");
  // SELECTION NAVIGATES ROWS: folds, their END bookends, and (once expanded) their
  // messages. 60 folds render 120 rows, so 119 downs land on the very last row.
  for (let i = 0; i < 200; i += 1) scroller.handleInput("\x1b[B");
  assert.equal(scroller.selectedKey, "fold_59",
    `two hundred downs did not clamp on the last row: ${scroller.selectedKey}`);
  const bottom = scroller.render(140).join("\n");
  assert(bottom.includes("fold_59"), "the last fold is not visible after clamping");
  assert(!bottom.includes("fold_00"), "stale top blocks stayed in the viewport");
  scroller.handleInput("\x1b[A");
  scroller.handleInput("\x1b[H");
  void scroller;

  return {
    registered: Boolean(command),
    coloredBookends: colorsUsed.has("success") && colorsUsed.has("error"),
    proposedDistinct: true,
    rawGapsSummarized: true,
    readOnlyUnderFreeze: true,
    scrollFollowsSelection: true,
  };
}

/**
 * MECHANISM. THE USER LAYS MARKS IN THE EDITOR (Shane, 2026-08-23). Raw entries are
 * MARK POINTS: `m` anchors one, moving prices the span live in the runtime's own
 * token arithmetic ("would fold N entries · ~T tokens"), and `m` again stages a
 * USER mark through stageFoldMarks -- the SAME validated path the tool's fold action
 * runs, origin "user", so it counts toward the commit's coverage and folds at the
 * epoch exactly as an agent mark does. The view computes nothing but the arithmetic
 * it is handed and reports one intent; escape cancels the anchor before it closes
 * the editor; an all-refused span throws before persisting, so the refusal lands in
 * the footer instead of a no-op state write.
 */
async function gateFoldEditorUserMarks() {
  const editorModule = await jiti.import(join(projectRoot, "extensions", "lib", "editor-ui.ts"));

  // THE FOLD FLOOR ABOVE THE WHOLE FIXTURE, so the frontier cuts nothing and the window
  // the editor opens on is raw. What this gate is for is the USER's own gesture: anchor,
  // move, price, stage through the validated path. With the frontier cutting as material
  // arrives, a default fixture hands the editor a window of proposed blocks and the
  // navigation never reaches a raw entry to anchor on, which measures the frontier rather
  // than the editor. Gate 142 renders a window that HAS been cut.
  const runtime = await epochToolRuntime({
    turns: 10, resultChars: 9_000,
    thresholds: { ...context.DEFAULT_THRESHOLDS, minFoldChars: 400_000 },
  });
  const command = runtime.commands.get("fold-editor");
  assert(command, "/fold-editor is not registered");
  await measure(runtime, 40_000, 100_000);

  // Open the REAL handler and drive the REAL view it returns.
  let view = null;
  let closedCount = 0;
  runtime.ctx.ui.custom = async (factory) => {
    view = factory(null, { fg: (color, text) => `[${color}]${text}[/${color}]` },
      { matches: (_data, name) => name === currentAction }, () => { closedCount += 1; });
    return view;
  };
  let currentAction = "";
  await command.handler("", runtime.ctx);
  await settle();
  assert(view, "the editor did not open");

  // The window is one raw gap with no folds: expand it and land on its first entry.
  currentAction = "tui.select.confirm";
  view.handleInput("\r");
  currentAction = "tui.select.down";
  view.handleInput("\x1b[B");
  const firstEntryRender = view.render(140).join("\n");
  assert(/· (user|assistant) /.test(firstEntryRender),
    `the expanded raw block lists no entries: ${firstEntryRender.slice(0, 400)}`);

  // A MARK POINT SHOWS WHAT IT IS (2026-08-23): the raw row carries a quoted content
  // preview, because this is where the user decides what to fold, and Enter deepens
  // it in place as wrapped detail rows. Before this, raw rows were id-only and the
  // Enter toggle set detail state no raw row ever read back: the press did nothing.
  assert(/\u201c.+\u201d/.test(firstEntryRender), "raw entry rows carry no content preview");
  currentAction = "tui.select.confirm";
  view.handleInput("\r");
  const detailedRender = view.render(140).join("\n");
  assert(detailedRender !== firstEntryRender, "Enter on a raw entry changed nothing");
  // A detail row is six spaces of indent straight into dim text (no cursor column, no
  // bullet); the viewport is capped at 24 body rows, so the LINE COUNT cannot carry
  // this assertion when the expanded block already fills it.
  assert(/^ {6}\[dim\]/m.test(detailedRender) && !/^ {6}\[dim\]/m.test(firstEntryRender),
    "detail added no wrapped rows under the entry");
  view.handleInput("\r");
  assert.equal(view.render(140).join("\n"), firstEntryRender,
    "a second Enter did not collapse the detail back to the plain row");
  currentAction = "tui.select.down";

  // FIRST m ANCHORS. The anchor row wears the diamond; nothing is staged yet.
  view.handleInput("m");
  const anchored = view.render(140).join("\n");
  assert(/\u25c6 start/.test(anchored), "the anchor row carries no diamond marker");
  assert(!/PROPOSED \(user\)/.test(anchored), "anchoring alone staged a mark");

  // MOVING PRICES THE SPAN LIVE: two entries covered, a token figure present.
  view.handleInput("\x1b[B");
  const priced = view.render(140).join("\n");
  assert(/would fold 2 entries/.test(priced),
    `the footer does not price the two-entry span: ${priced.slice(-600)}`);
  assert(/~[\d,]+ tokens/.test(priced), "the footer states no token figure");

  // SECOND m OPENS THE BRIEF LINE; Enter stages. Empty keeps the deterministic
  // brief. Staging goes through the validated path, origin "user". The view reports
  // one intent; the handler does the staging, persists, and refreshes the data.
  view.handleInput("m");
  const prompted = view.render(140).join("\n");
  assert(/brief: /.test(prompted) && /Enter:stage deterministic/.test(prompted),
    "the second mark point did not open the brief line");
  view.handleInput("\r");
  const deadline = Date.now() + 10_000;
  while (view.staging && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(!view.staging, "staging never finished");
  await settle();
  const stagedRender = view.render(140).join("\n");
  assert(/PROPOSED \(user\)/.test(stagedRender),
    `the staged user mark does not render as a proposed block: ${stagedRender.slice(0, 600)}`);
  assert(/, 1 you/.test(stagedRender), "the header does not count the user's mark");
  assert(runtime.notifications.some((notice) => /Staged user mark/.test(notice.message)),
    "staging did not tell the user what it did");

  // IT IS A REAL PENDING MARK in durable state, not a view fiction.
  const stateNow = materialized(runtime);
  assert(stateNow.folds.length === 0, "staging folded something before the commit");
  const stateEntries = runtime.branch.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY);
  assert(stateEntries.length > 0, "staging wrote no durable state entry");
  const newest = stateEntries.at(-1).data;
  const pendingFold = (newest.pendingMarks ?? []).find((mark) =>
    mark.mark === "fold" && mark.origin === "user");
  assert(pendingFold, `no pending mark with origin "user" in durable state: ${JSON.stringify(newest).slice(0, 300)}`);
  assert(pendingFold.briefProvenance.kind === "deterministic",
    "a user mark without a brief did not get the deterministic provenance");

  // ESCAPE CANCELS THE ANCHOR FIRST and closes the editor only on the second press.
  view.handleInput("\x1b[B");
  view.handleInput("m");
  assert(/\u25c6 start/.test(view.render(140).join("\n")), "re-anchoring failed");
  currentAction = "tui.select.cancel";
  view.handleInput("\x1b");
  assert(!view.closed, "escape closed the editor while an anchor was standing");
  assert(!/\u25c6 start/.test(view.render(140).join("\n")), "escape did not clear the anchor");
  view.handleInput("\x1b");
  assert(view.closed && closedCount === 1, "the second escape did not close the editor");

  // THE USER MARK COMMITS WITH THE EPOCH and the fold record carries its origin.
  const epoch = await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  assert(epoch.fired, `the commit did not fire: ${epoch.reason}`);
  const userFold = epoch.applied.find((mark) => mark.origin === "user");
  assert(userFold, `the user's mark did not apply at the commit: ${JSON.stringify(epoch.applied)}`);
  assert(userFold.foldId === pendingFold.id,
    "the applied user fold is not the mark the user staged");

  // THE VIEW STAYS PURE: no runtime objects, no mutation of its input data.
  const pureData = Object.freeze({
    title: "t",
    occupancy: Object.freeze({ usedTokens: 1_000, budgetTokens: 10_000, commitOccupancy: 0.8, commitDue: false }),
    blocks: Object.freeze([Object.freeze({
      type: "raw", id: "raw:0-1", startPosition: 0, endPosition: 1, sourceCount: 2,
      rolesSummary: "", entries: Object.freeze([
        Object.freeze({ id: "e0", role: "user", preview: "a", index: 0 }),
        Object.freeze({ id: "e1", role: "assistant", preview: "b", index: 1 }),
      ]), children: Object.freeze([]),
    })]),
    pending: Object.freeze({ count: 0, agentMarks: 0, ladderMarks: 0, userMarks: 0, freedTokens: 0 }),
    pinned: Object.freeze([]),
  });
  const intents = [];
  const pureByteKb = {
    "\r": "tui.select.confirm",
    "\x1b[B": "tui.select.down",
  };
  const pureView = new editorModule.FoldEditorView(pureData, () => {},
    { matches: (data, name) => pureByteKb[data] === name },
    null, { spanCost: () => ({ entries: 2, tokens: 777 }) });
  pureView.handleInput("\r"); // expand the raw block
  pureView.handleInput("\x1b[B"); // first entry
  pureView.handleInput("m"); // anchor
  pureView.handleInput("\x1b[B"); // second entry
  const pricedPure = pureView.render(140).join("\n");
  assert(/~777 tokens/.test(pricedPure),
    `the view did not use the injected spanCost: ${pricedPure.slice(-300)}`);
  void intents;

  return {
    anchoredAndPriced: true,
    stagedThroughValidatedPath: userFold.foldId === pendingFold.id,
    deterministicBriefForUserMark: pendingFold.briefProvenance.kind === "deterministic",
    escapeCancelsAnchorFirst: true,
    committedWithOriginUser: Boolean(userFold),
  };
}

/**
 * MECHANISM. THE EDITOR'S OTHER TWO SKINS (Shane, 2026-08-23). u ON A PROPOSED ROW
 * withdraws that staged mark through the tool's unmark path; p ON A RAW ENTRY pins
 * or unpins it through protectEvidence with the pinned-share cap; and a brief TYPED
 * into the capture line stages as a SUPPLIED brief with supplied provenance, judged
 * by the same contract the tool enforces. Withdrawal moves no bytes; the withdrawn
 * mark's span simply rejoins what the ladder may take.
 */
async function gateFoldEditorWithdrawPinBrief() {
  // Fold floor above the fixture, for gate 145's reason: this drives the USER's own
  // gestures, so the editor has to open on a raw window for the user to mark, withdraw and
  // pin inside.
  const runtime = await epochToolRuntime({
    turns: 10, resultChars: 9_000,
    thresholds: { ...context.DEFAULT_THRESHOLDS, minFoldChars: 400_000 },
  });
  const command = runtime.commands.get("fold-editor");
  await measure(runtime, 40_000, 100_000);

  let view = null;
  let closedCount = 0;
  runtime.ctx.ui.custom = async (factory) => {
    view = factory(null, { fg: (color, text) => `[${color}]${text}[/${color}]` },
      { matches: (_data, name) => name === currentAction }, () => { closedCount += 1; });
    return view;
  };
  let currentAction = "";
  await command.handler("", runtime.ctx);
  await settle();

  // Expand the raw gap; anchor its first entry; price to the third; type a BRIEF.
  currentAction = "tui.select.confirm";
  view.handleInput("\r");
  currentAction = "tui.select.down";
  view.handleInput("\x1b[B");
  view.handleInput("m"); // anchor
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  assert(/would fold 3 entries/.test(view.render(140).join("\n")),
    "the three-entry span was not priced");
  view.handleInput("m"); // open the brief line
  for (const ch of "Kept so the verdict can cite it verbatim") view.handleInput(ch);
  const briefLine = view.render(140).join("\n");
  assert(/brief: Kept so the verdict can cite it verbatim/.test(briefLine),
      `the typed brief did not render: ${briefLine.slice(-400)}`);
  assert(/Enter:stage with brief/.test(briefLine), "the footer did not say staging uses the brief");
  view.handleInput("\r"); // stage WITH the brief
  const deadline = Date.now() + 10_000;
  while (view.staging && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  await settle();

  // THE TYPED BRIEF RIDES THE MARK'S BRIEF: the mark path prepares immediately, so the
  // stored brief is the augmented composition with the typed words seated after the
  // deterministic head, and the provenance says so. Durable state carries both.
  const newestState = () => runtime.branch.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1).data;
  const userMark = (newestState().pendingMarks ?? []).find((mark) =>
    mark.mark === "fold" && mark.origin === "user");
  assert(userMark, "the briefed user mark never reached durable state");
  assert(userMark.brief.includes("verdict can cite it verbatim"),
    `the staged brief is not the typed one: ${userMark.brief}`);
  assert(userMark.briefProvenance.kind === "augmented",
    `a typed brief did not record augmented provenance: ${JSON.stringify(userMark.briefProvenance)}`);
  assert(/PROPOSED \(user\)/.test(view.render(140).join("\n")),
    "the briefed mark does not render as proposed");

  // u ON THE PROPOSED ROW WITHDRAWS IT through the unmark path: durable state drops
  // it, nothing folds, and the block leaves the render. Walk BY KEY: visible is not
  // selected, and the proposed block sorts above the raw gap it stages over.
  currentAction = "tui.select.up";
  let walked = 0;
  while (view.selectedKey !== userMark.id && walked++ < 100) {
    const before = view.selectedKey;
    view.handleInput("\x1b[A");
    if (view.selectedKey === before) break;
  }
  assert(view.selectedKey === userMark.id,
    `did not reach the proposed row: ${view.selectedKey}`);
  const marksBeforeWithdraw = (newestState().pendingMarks ?? []).length;
  view.handleInput("u");
  const withdrawDeadline = Date.now() + 10_000;
  while (view.staging && Date.now() < withdrawDeadline) await new Promise((r) => setTimeout(r, 5));
  await settle();
  assert((newestState().pendingMarks ?? []).length === marksBeforeWithdraw - 1,
    "withdrawal left the durable mark standing");
  assert(!view.render(140).join("\n").includes("PROPOSED (user)"),
    "the withdrawn mark still renders as proposed");
  assert(runtime.notifications.some((notice) => /Withdrew 1 staged mark/.test(notice.message)),
    "withdrawal did not announce itself");

  // p ON A RAW ENTRY PINS IT through protectEvidence; p again unpins. The pin badge,
  // the header count, and the canonical context.pin event all move. Raw entry rows
  // carry keys shaped "<block>:<entryId>:r<n>"; walk down onto one.
  currentAction = "tui.select.down";
  walked = 0;
  while (!/:r\d+$/.test(view.selectedKey) && walked++ < 100) {
    const before = view.selectedKey;
    view.handleInput("\x1b[B");
    if (view.selectedKey === before) break;
  }
  assert(/:r\d+$/.test(view.selectedKey), `did not reach a raw entry row: ${view.selectedKey}`);
  const fromEvents = runtime.appended.length;
  view.handleInput("p");
  const pinDeadline = Date.now() + 10_000;
  while (view.staging && Date.now() < pinDeadline) await new Promise((r) => setTimeout(r, 5));
  await settle();
  assert(/\ud83d\udccc/.test(view.render(140).join("\n")), "the pinned entry wears no badge");
  assert(/pinned: 1/.test(view.render(140).join("\n")), "the header did not count the pin");
  const pinEvents = contextEvents(runtime, fromEvents).filter((record) => record.kind === "context.pin");
  assert(pinEvents.length === 1 && pinEvents[0].pin === true,
    `pinning did not record exactly one context.pin event: ${JSON.stringify(pinEvents)}`);
  view.handleInput("p");
  while (view.staging) await new Promise((r) => setTimeout(r, 5));
  await settle();
  assert(!/\ud83d\udccc/.test(view.render(140).join("\n")) && /pinned: 0/.test(view.render(140).join("\n")),
    "the second p did not release the pin");

  void closedCount;
  return {
    briefCapturedAndSupplied: userMark.briefProvenance.kind === "supplied",
    withdrewThroughUnmarkPath: true,
    pinToggledBothWays: true,
    pinEventRecorded: pinEvents.length === 1,
  };
}

/**
 * REGISTRATION, PARSE AND DEPLOYMENT BRANDING
 *
 * One law: the runtime ships no identity of its own. Registration is where a deployment's
 * name reaches the surface, so what it registers and what it renders are the same claim
 * read at two distances.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   1: Registration & parse
 *   20: Neutral default branding
 *   21: Deployment branding reproduction
 */
async function gateRegistrationAndBranding() {
  return {
    registration: await claim("gateRegistration", gateRegistration),
    neutralDefaultBranding: await claim("gateNeutralDefaultBranding", gateNeutralDefaultBranding),
    deploymentBrandingReproduction: await claim("gateDeploymentBrandingReproduction", gateDeploymentBrandingReproduction),
  };
}

/**
 * THE DURABLE RECORD: LATTICE, CHAIN AND ROLLBACK
 *
 * One law: what is written survives, in order, and a write that fails leaves the previous
 * state standing. The lattice is the shape of the record and the chain is its history; a
 * lattice that survives a rollback its chain does not is not a durable record.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   2: Fold lattice & recovery
 *   10: Persistence chain
 */
async function gateDurableRecord() {
  return {
    foldLattice: await claim("gateFoldLattice", gateFoldLattice),
    persistenceChain: await claim("gatePersistenceChain", gatePersistenceChain),
  };
}

/**
 * THE LADDER REACHES EVERYTHING IT IS ALLOWED TO
 *
 * One law: automatic selection leaves nothing permanently unreachable. Bite-sized folds
 * are the ladder taking what it can rather than waiting for a perfect span, and the
 * no-permanently-unfoldable-unit claim is the same property stated as its failure.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   3: Autonomous ladder
 *   64: Bite-sized ladder folds; an agent span whole
 *   83: No permanently unfoldable unit
 */
async function gateLadderReach() {
  return {
    autonomousLadder: await claim("gateAutonomousLadder", gateAutonomousLadder),
    biteSizedFolds: await claim("gateBiteSizedFolds", gateBiteSizedFolds),
    noPermanentlyUnfoldableUnit: await claim("gateNoPermanentlyUnfoldableUnit", gateNoPermanentlyUnfoldableUnit),
  };
}

/**
 * HISTORICAL SESSIONS STILL LOAD AND STILL RESOLVE
 *
 * One law: a session written by an earlier build loads without a repair step. Each section
 * is one shape that was found in the wild: an overflow mid-write, a legacy luna state, a
 * poisoned floor, and the tolerance band that covers the rest.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   5: F1 regression (overflow)
 *   6: F2 regression (legacy luna)
 *   7: F3 regression (poisoned floor)
 *   8: Historical tolerance
 */
async function gateHistoricalShapes() {
  return {
    overflowRegression: await claim("gateOverflowRegression", gateOverflowRegression),
    legacyLunaRegression: await claim("gateLegacyLunaRegression", gateLegacyLunaRegression),
    poisonedFloorRegression: await claim("gatePoisonedFloorRegression", gatePoisonedFloorRegression),
    historicalTolerance: await claim("gateHistoricalTolerance", gateHistoricalTolerance),
  };
}

/**
 * THE COMPACTION BOUNDARY COMMITS
 *
 * One law: the boundary is a commit site, and it commits whatever the session's shape.
 * The policy decides what pi is told; the open-turn case is the shape that policy has to
 * survive, and a boundary that only commits on closed turns commits in no real session.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   9: Compaction policy
 *   106: The boundary commits with no turn ever closed
 */
async function gateCompactionBoundary() {
  return {
    compactionPolicy: await claim("gateCompactionPolicy", gateCompactionPolicy),
    openTurnCommits: await claim("gateOpenTurnCommits", gateOpenTurnCommits),
  };
}

/**
 * THE RUNGS BEYOND THE TOOL BATCH
 *
 * One law: the tool batch is the cheapest rung and not the only one. Warm chapters, the
 * quota top-up and the refold rung are the three ways the runtime reaches mass no batch
 * covers, and they share one selector, one epoch and one receipt.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   14: B4 quiet warming
 *   34: Epoch quota top-up
 *   40: The refold rung is reachable through a mark
 */
async function gateRungsBeyondTheBatch() {
  return {
    quietWarming: await claim("gateQuietWarming", gateQuietWarming),
    epochQuotaTopUp: await claim("gateEpochQuotaTopUp", gateEpochQuotaTopUp),
    epochInlineRungs: await claim("gateEpochInlineRungs", gateEpochInlineRungs),
  };
}

/**
 * STATUS IS BOUNDED, DIET-LIMITED AND ITSELF FOLDABLE
 *
 * One law: status is a tool result like any other. It answers in bounded pages, it puts
 * the index on a diet rather than truncating it silently, and what it returns is ladder
 * food, because a status surface exempt from folding is an unbounded leak.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   15: B5 fold_candidates detail
 *   48: Status index diet
 *   81: Status pages are bounded
 *   82: Status results are ladder food
 */
async function gateStatusSurface() {
  return {
    foldCandidatesDetail: await claim("gateFoldCandidatesDetail", gateFoldCandidatesDetail),
    statusIndexDiet: await claim("gateStatusIndexDiet", gateStatusIndexDiet),
    statusPagesAreBounded: await claim("gateStatusPagesAreBounded", gateStatusPagesAreBounded),
    statusResultsAreLadderFood: await claim("gateStatusResultsAreLadderFood", gateStatusResultsAreLadderFood),
  };
}

/**
 * THE PROJECTION IS APPEND-ONLY
 *
 * One law, and the one the whole design is bought with: between commits the projection
 * only grows at the tail. Four ways to break it, one gate: a tool call that mutates, a
 * standing fact that moves, a second structural mutation inside one handoff, and a
 * rewrite nothing accounts for.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   16: No tool call causes a rewrite
 *   73: Standing facts ride the stable prefix
 *   74: One structural mutation per handoff
 *   87: The projection is append-only
 */
async function gateAppendOnlyProjection() {
  return {
    noToolCallRewrite: await claim("gateNoToolCallRewrite", gateNoToolCallRewrite),
    curationCopyAndReceipts: await claim("gateCurationCopyAndReceipts", gateCurationCopyAndReceipts),
    mutationBudgetPerHandoff: await claim("gateMutationBudgetPerHandoff", gateMutationBudgetPerHandoff),
    projectionIsAppendOnly: await claim("gateProjectionIsAppendOnly", gateProjectionIsAppendOnly),
  };
}

/**
 * WIRE COMPATIBILITY AND STALE ANCHORS
 *
 * One law: a state written by another build is read as written. The forward and backward
 * notes are the wire's two directions; a stale anchor is the same defect after a fence,
 * where the state is this build's own and the reading is out of date.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   17: Phase-B wire forward/backward note
 *   18: Follow-up fences & stale anchors
 */
/**
 * A RIDER-ERA STATE STILL LOADS, AND THE RIDER STILL DOES NOTHING (Shane, 2026-08-23).
 *
 * The curation redesign deleted the rider and its wire parsing with it, and every state
 * the sol-20260815-hidden campaign sealed carries one. Retiring the field by name made
 * all of them unreadable, which cost the hidden-mass result its 102 attributed carriage
 * rows: the extract came back saying the instrument could not read its own evidence.
 *
 * What actually blocked the load was the DIGEST, not the schema. `semanticStateSha256`
 * hashes the materialized state object and the canonicalizer walks own keys in insertion
 * order, so a field that is gone changes the digest even though it changed nothing else.
 * The rider is therefore read, spent on the digest through `legacyRiderStateSha256`, and
 * dropped. That is not tolerate-and-forget, which is the silent path the retired-field
 * refusal exists to prevent: the value is USED, at the one point it can still be checked,
 * and the state that comes back is provably the state that was written.
 *
 * Driven against a real folded branch with one entry rewritten into what the rider-era
 * build would have written, rather than a hand-built fixture, so the claim is about a
 * load and not about a shape.
 */
async function gateLegacyRiderStateLoads() {
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 9_000 });
  await measureAndCommit(runtime, 86_000, 100_000, "rider-era-commit");
  const sessionId = runtime.built.sessionId;
  const modern = materialized(runtime);
  assert(modern.folds.length >= 1, "The fixture folded nothing, so there is no state worth reloading");

  // WHAT THE RIDER-ERA BUILD WROTE. The field sat immediately before `prepared` in the
  // materialized literal, and the digest it recorded was taken over that object.
  const rider = { text: "The runtime folded four stale batches; peek any of them.", highWater: 0.62 };
  const riderIndex = runtime.branch.findLastIndex((entry) =>
    entry?.customType === context.ACTIVE_CONTEXT_STATE_ENTRY);
  assert(riderIndex >= 0, "The committed branch carries no active-context state entry");
  const original = runtime.branch[riderIndex];
  const riderEra = {
    ...original,
    data: {
      ...original.data,
      rider,
      stateSha256: context.legacyRiderStateSha256(modern, rider),
    },
  };
  const branch = runtime.branch.map((entry, index) => (index === riderIndex ? riderEra : entry));

  // IT LOADS, and what comes back is the state that was written.
  const loaded = context.materializeActiveContextState(branch, sessionId);
  assert.deepEqual(
    { folds: loaded.folds, expanded: loaded.expanded, protected: loaded.protected, revision: loaded.revision },
    { folds: modern.folds, expanded: modern.expanded, protected: modern.protected, revision: modern.revision },
    "A rider-era state loaded as something other than what it recorded",
  );
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, "rider"), false,
    "The rider reached the materialized state instead of being spent on the digest");
  assert.equal(json.stableStringify(loaded).includes('"rider"'), false,
    "The rider survived somewhere inside the loaded state");

  // AND NOTHING WRITES ONE BACK: the next checkpoint this build takes of that state has
  // no rider key and hashes without one, so the field leaves the wire at the first write.
  const rewritten = context.makeStateCheckpoint(loaded);
  assert.equal(Object.prototype.hasOwnProperty.call(rewritten, "rider"), false,
    "A checkpoint taken after a rider-era load wrote the rider back out");
  assert.equal(rewritten.stateSha256, context.semanticStateSha256(loaded),
    "The rewritten checkpoint did not hash the state this build actually holds");
  assert.notEqual(rewritten.stateSha256, riderEra.data.stateSha256,
    "The fixture's rider-era digest equals the modern one, so the legacy derivation is untested");

  // A DIGEST THAT GENUINELY DRIFTED STILL FAILS. The legacy derivation is a second way to
  // be RIGHT, never a second way to pass: without this, a corrupted state carrying any
  // rider at all would have an extra chance to slip through.
  const drifted = runtime.branch.map((entry, index) => (index === riderIndex
    ? { ...riderEra, data: { ...riderEra.data, stateSha256: "f".repeat(64) } }
    : entry));
  assert.throws(() => context.materializeActiveContextState(drifted, sessionId),
    /digest drift/, "A rider-era state with a wrong digest was accepted");

  // AND THE FIELD IS NOT ON THE REFUSAL LIST, because the refusal's own reason is a state
  // this build cannot reproduce, and it can reproduce this one. The fields that carried
  // BEHAVIOUR stay refused by name.
  assert.throws(() => context.refuseRetiredStateFields({ lastCall: {} }), /retired field/);
  assert.throws(() => context.refuseRetiredStateFields({ notices: {} }), /retired field/);
  assert.throws(() => context.refuseRetiredStateFields({ surfacing: {} }), /retired field/);
  // Refused by name would throw here, and that refusal is what made the sealed campaign
  // unreadable. It returns instead, which is the whole repair in one line.
  context.refuseRetiredStateFields({ rider });

  return {
    foldsBefore: modern.folds.length,
    foldsAfterRiderEraLoad: loaded.folds.length,
    riderInLoadedState: false,
    riderInNextCheckpoint: false,
    driftStillRefused: true,
  };
}

async function gateWireCompatibility() {
  return {
    wireForwardBackwardNote: await claim("gateWireForwardBackwardNote", gateWireForwardBackwardNote),
    followupFencesAndAnchors: await claim("gateFollowupFencesAndAnchors", gateFollowupFencesAndAnchors),
    legacyRiderStateLoads: await claim("gateLegacyRiderStateLoads", gateLegacyRiderStateLoads),
  };
}

/**
 * EVIDENCE ARTIFACTS ARE CONTENT-ADDRESSED AND IMMUTABLE
 *
 * One law: exact recovery needs an anchor nothing can move. Ingestion is unconditional so
 * the anchor always exists, addressing is by content so it cannot be swapped, and the
 * no-operator-paths sweep is the same claim about the repo the artifacts are named in.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   22: Evidence ingestion is unconditional
 *   85: Evidence artifacts are content-addressed and immutable
 *   86: No operator home paths in tracked files
 */
async function gateEvidenceArtifacts() {
  return {
    evidenceIngestionIsUnconditional: await claim("gateEvidenceIngestionIsUnconditional", gateEvidenceIngestionIsUnconditional),
    evidencePrimitives: await claim("gateEvidencePrimitives", gateEvidencePrimitives),
    noOperatorPaths: await claim("gateNoOperatorPaths", gateNoOperatorPaths),
  };
}

/**
 * PEEK: ONE LEVEL, EPHEMERAL, APPEND-ONLY
 *
 * One law: a peek is a read and a read moves nothing. It serves one level, it is ephemeral
 * by default, the reply that follows it is the surviving trace, its bytes are reclaimed by
 * a mark rather than by a rewrite, and a copy it hands back keeps its identity.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   25: Peek and fold index
 *   36: Ephemeral peek auto-mark
 *   88: A peek never rewrites the window
 *   101: Peek copies reclaim with identity
 *   139: An ephemeral peek is consumed by the reply that follows it
 */
async function gatePeekSurface() {
  return {
    peekAndFoldIndex: await claim("gatePeekAndFoldIndex", gatePeekAndFoldIndex),
    peekIndexIsBounded: await claim("gatePeekIndexIsBounded", gatePeekIndexIsBounded),
    ephemeralPeekMark: await claim("gateEphemeralPeekMark", gateEphemeralPeekMark),
    peekIsAppendOnly: await claim("gatePeekIsAppendOnly", gatePeekIsAppendOnly),
    peekReclaimWithIdentity: await claim("gatePeekReclaimWithIdentity", gatePeekReclaimWithIdentity),
    ephemeralPeek: await claim("gateEphemeralPeek", gateEphemeralPeek),
  };
}

/**
 * THE MARK LIFECYCLE
 *
 * One law: a mark is a promise about a span, kept or answered. It is staged, retained when
 * a commit does not reach it, and answered rather than thrown when the fold it names is
 * gone or held.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   32: Epoch mark/commit lifecycle
 *   46: Retained pending marks
 *   109: A mark naming a fold that is gone or held is answered
 */
async function gateMarkLifecycle() {
  return {
    epochMarkCommit: await claim("gateEpochMarkCommit", gateEpochMarkCommit),
    retainedPendingMarks: await claim("gateRetainedPendingMarks", gateRetainedPendingMarks),
    danglingChildMarks: await claim("gateDanglingChildMarks", gateDanglingChildMarks),
  };
}

/**
 * INSTRUMENTATION: THE STREAM, THE COST AND THE CACHE
 *
 * One law: the runtime states what it did, in one canonical stream, with the price beside
 * it. The projection records, the event stream, the derivation cost and the cache topology
 * are four readings of the same ledger, and a reading missing from any is unaudited.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   50: Projection instrumentation
 *   67: Context event stream
 *   131: Derivation cost is recorded and summable
 *   137: Cache topology names marks and branch returns
 */
async function gateInstrumentation() {
  return {
    projectionInstrumentation: await claim("gateProjectionInstrumentation", gateProjectionInstrumentation),
    contextEventStream: await claim("gateContextEventStream", gateContextEventStream),
    derivationCostIsRecordedAndSummable: await claim("gateDerivationCostIsRecordedAndSummable", gateDerivationCostIsRecordedAndSummable),
    cacheTopologyAccounting: await claim("gateCacheTopologyAccounting", gateCacheTopologyAccounting),
  };
}

/**
 * EVERY FOLD CARRIES A BRIEF, AND THE BRIEF CARRIES THE FACTS
 *
 * One law: no fold goes without a brief, and a brief that drops the facts is worse than
 * none because the projection then reads as complete. Stage identity, the opening prose
 * and the agent's own notes are the three things measured sessions lost.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   51: Stage-identified fold briefs
 *   116: No fold goes without a brief
 *   134: Opening prose survives deterministic folding
 *   135: Agent notes survive; omission is stated
 */
/**
 * A chapter brief identifies every call in its span (2026-08-24, Shane approved the
 * shape). The count-style composition ("User: No user ask \u00b7 Tools: 3\u00d7bash \u00b7
 * Assistant: No assistant text in this span") collapsed to one anonymous line on every
 * residue span of the pull workload: rep 3 of sol-20260823-live committed 188
 * byte-identical placeholders of that shape. The chapter now indexes itself: each call
 * named with its arguments and its result's opening line, an errored result marked by
 * name, the user's ask and every assistant note seated in span order, our own tool
 * sanitized to "active-context service" so a brief never teaches tool syntax, and what
 * the cap refuses counted rather than dropped. Fails on the count-style runtime at its
 * first assertion.
 */
async function gateChapterBriefIdentifiesCalls() {
  const refFor = (index, role) => ({
    sessionId: "brief-fixture", entryId: `chapter-${index}`, role, sha256: `sha-${index}`,
  });
  const span = [
    { role: "assistant", content: [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "nl -ba lib/easy.c | sed -n '10,40p'" } },
    ], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false,
      content: [{ type: "text", text: "10  struct Curl_easy *data;\n11  CURLcode result;" }] },
    { role: "assistant", content: [
      { type: "text", text: "trace-a-06: lib/curl_sasl.h" },
      { type: "toolCall", id: "c2", name: "pi_fold_context", arguments: { action: "peek", id: "fold_deadbeef" } },
    ], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "c2", toolName: "pi_fold_context", isError: true,
      content: [{ type: "text", text: "Unknown active-context fold fold_deadbeef" }] },
  ];
  const refs = span.map((message, index) => refFor(index, message.role));
  const brief = context.deterministicChapterBrief(refs, span, "pi_fold_context");
  assert(/bash\(\{"command":"nl -ba lib\/easy\.c/.test(brief),
    `the call is not identified by its arguments: ${brief}`);
  assert(brief.includes('\u2192 "10 struct Curl_easy *data;'),
    `the result's opening line is missing: ${brief}`);
  assert(brief.includes("Noted: trace-a-06: lib/curl_sasl.h"),
    "the assistant note did not seat");
  assert(brief.includes("[errored]"), "the errored result is not marked");
  assert(!brief.toLowerCase().includes("pi_fold_context"),
    "the brief teaches the fold tool's name");
  assert(brief.includes("active-context service({"), "the sanitized call head is missing");
  assert(!brief.includes("No assistant text in this span") && !brief.includes("No user ask"),
    "the count-style vestige survived");

  // THE CAP COUNTS WHAT IT REFUSES. Enough calls to overflow maxBriefChars: the tail
  // names how many entries could not seat, and the total respects the one cap.
  const wide = [];
  for (let index = 0; index < 40; index += 1) {
    wide.push({ role: "assistant", content: [
      { type: "toolCall", id: `w${index}`, name: "bash",
        arguments: { command: `nl -ba lib/file-${index}.c | sed -n '1,40p' # ${"x".repeat(40)}` } },
    ], stopReason: "toolUse" });
    wide.push({ role: "toolResult", toolCallId: `w${index}`, toolName: "bash", isError: false,
      content: [{ type: "text", text: `line one of result ${index}: ${"y".repeat(120)}` }] });
  }
  const wideRefs = wide.map((message, index) => refFor(index + 100, message.role));
  const wideBrief = context.deterministicChapterBrief(wideRefs, wide, "pi_fold_context");
  assert(wideBrief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    `the composed brief broke the one cap: ${wideBrief.length}`);
  assert(/\d+ more entries in this span$/.test(wideBrief),
    "the refused entries are not counted");
  const seated = Number(wideBrief.match(/(\d+) more entries in this span$/)[1]);
  assert(seated > 0 && seated < 40, "the omitted count is not a genuine partition");

  // A user ask still leads its span.
  const asked = [
    { role: "user", content: [{ type: "text", text: "Please audit the DNS cache paths." }] },
    ...span,
  ];
  const askedRefs = asked.map((message, index) => refFor(index + 200, message.role));
  const askedBrief = context.deterministicChapterBrief(askedRefs, asked, "pi_fold_context");
  assert(askedBrief.startsWith("User asked: Please audit the DNS cache paths."),
    `the user ask does not lead: ${askedBrief}`);

  return {
    residueBriefChars: brief.length,
    overflowSeated: 40 - seated,
    overflowOmitted: seated,
  };
}

/**
 * A SUPPLIED BRIEF AUGMENTS THE HEAD, NEVER REPLACES IT (2026-08-24). rep 7 of
 * sol-20260823-live: supplied topic-summary briefs REPLACED the fact-carrying
 * deterministic head, the run's own briefs deleted the identification, and 74 of 95
 * peeks recovered values the briefs dropped, at ~$38 against the deterministic twin's
 * $22.56. The agent's words are judged against their own reserve so the refusal names
 * the budget the agent actually has, the head keeps the remainder of the one policy
 * cap, and ONLY the agent's own words take the composing path: a deterministic brief
 * arriving through the same door IS the head (the first live application composed the
 * head with itself), and a re-prepared augmented brief is already composed.
 */
async function gateSuppliedBriefAugmentsTheHead() {
  const built = makeFixture({
    turns: 9, tools: false, chapterChars: 3_500,
    thresholds: TINY_FOLD_FLOOR, contextWindow: 100_000,
  });
  const empty = context.emptyActiveContextState(built.sessionId);
  const candidate = context.manualFoldCandidate(
    built.snapshot, empty, [built.turnEntries[0][0], built.turnEntries[0].at(-1)]);
  const clause = "The DNS cache audit verdict lives behind this fold.";
  const seam = " · Agent: ";

  // (a) The agent's words commit composed, after the head, provenance augmented.
  const composed = await context.prepareFold({
    candidate, snapshot: built.snapshot, state: empty, generation: 1, brief: clause,
  });
  assert(composed.fold.brief.endsWith(`${seam}${clause}`),
    `the agent's words do not close the composed brief: ${composed.fold.brief.slice(-120)}`);
  assert(composed.fold.brief.length > clause.length + seam.length + 10,
    "no deterministic head is seated before the agent's words");
  assert.equal(composed.fold.provenance.kind, "augmented");
  assert(composed.fold.brief.length <= context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    "the composition broke the one policy cap");

  // (b) A deterministic brief through the same door IS the head: byte-identical, no
  // seam, no self-composition. This is the first live application's defect, pinned.
  const detBrief = context.deterministicChapterCandidateBrief(built.snapshot, candidate);
  const passed = await context.prepareFold({
    candidate, snapshot: built.snapshot, state: empty, generation: 1,
    brief: detBrief, briefProvenance: "deterministic",
  });
  assert.equal(passed.fold.brief, detBrief,
    "a deterministic brief was recomposed instead of passing through");
  assert.equal(passed.fold.provenance.kind, "deterministic");
  assert(!passed.fold.brief.includes(seam), "the head composed with itself");

  // (c) The refusal names the agent's own reserve, and the corrected retry lands.
  const over = `Real facts about the audited span. ${"detail ".repeat(120)}`;
  await assert.rejects(() => context.prepareFold({
    candidate, snapshot: built.snapshot, state: empty, generation: 1, brief: over,
  }), (error) => {
    assert(new RegExp(`limit is ${context.ACTIVE_CONTEXT_POLICY.agentBriefReserve}`)
      .test(error.message), `the refusal does not name the reserve: ${error.message}`);
    return true;
  });
  const corrected = await context.prepareFold({
    candidate, snapshot: built.snapshot, state: empty, generation: 1, brief: clause,
  });
  assert.equal(corrected.fold.provenance.kind, "augmented",
    "the corrected retry was not accepted composed");

  // (d) A re-prepared augmented brief is already composed: unchanged, one seam.
  const recut = await context.prepareFold({
    candidate, snapshot: built.snapshot, state: empty, generation: 1,
    brief: composed.fold.brief, briefProvenance: { kind: "augmented" },
  });
  assert.equal(recut.fold.brief, composed.fold.brief,
    "a re-cut recomposed a brief that was already composed");
  assert.equal(recut.fold.brief.split(seam).length, 2, "the re-cut doubled the seam");
  return {
    composedCarriesHeadAndClause: true,
    deterministicPassesThrough: true,
    refusalNamesReserve: context.ACTIVE_CONTEXT_POLICY.agentBriefReserve,
    reCutKeepsOneSeam: true,
  };
}

async function gateBriefContract() {
  return {
    stageIdentifiedBriefs: await claim("gateStageIdentifiedBriefs", gateStageIdentifiedBriefs),
    noFoldWithoutABrief: await claim("gateNoFoldWithoutABrief", gateNoFoldWithoutABrief),
    openingProseSurvivesDeterministicFolding: await claim("gateOpeningProseSurvivesDeterministicFolding", gateOpeningProseSurvivesDeterministicFolding),
    agentNotesSurviveConsolidation: await claim("gateAgentNotesSurviveConsolidation", gateAgentNotesSurviveConsolidation),
    chapterBriefIdentifiesCalls: await claim("gateChapterBriefIdentifiesCalls", gateChapterBriefIdentifiesCalls),
    suppliedBriefAugmentsTheHead: await claim("gateSuppliedBriefAugmentsTheHead", gateSuppliedBriefAugmentsTheHead),
  };
}

/**
 * PINS HOLD WHAT THEY ARE NAMED
 *
 * One law: a pin is a durable hold on the refs it names. The backstop is what happens when
 * pinned mass is the reason a commit cannot reach its target, which is the same law read
 * from the runtime's side rather than the agent's.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   53: Pinned mass backstop
 *   89: Protect is a durable pin
 */
async function gatePins() {
  return {
    pinnedMassBackstop: await claim("gatePinnedMassBackstop", gatePinnedMassBackstop),
    protectIsDurablePin: await claim("gateProtectIsDurablePin", gateProtectIsDurablePin),
  };
}

/**
 * THE PROJECTION BUDGET FENCE
 *
 * One law: the runtime never transmits a request it has measured as too large. The guard
 * waiver, the fixed-constant misjudgement, the margin, calibration recency and commit
 * depth are five ways that one decision is wrong, and they share one climb.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   56: Projection budget fence & guard waiver
 *   57: Fixed-constant misjudgement & post-fence integrity
 *   58: Fence margin, calibration recency & commit depth
 */
async function gateProjectionFence() {
  return {
    projectionBudgetFence: await claim("gateProjectionBudgetFence", gateProjectionBudgetFence),
    projectionCalibration: await claim("gateProjectionCalibration", gateProjectionCalibration),
    fenceMarginAndDepth: await claim("gateFenceMarginAndDepth", gateFenceMarginAndDepth),
  };
}

/**
 * WHAT THE RUNTIME TELLS THE AGENT
 *
 * One law: the runtime reports rather than advises. A receipt says what happened, the
 * post-fold notice says what was cut and what it costs to annotate, and neither asks the
 * agent to make room.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   61: Context action receipts
 *   147: The post-fold notice invites briefs, once, and stands down
 */
async function gateRuntimeSpeech() {
  return {
    contextReceipts: await claim("gateContextReceipts", gateContextReceipts),
    foldNoticeInvitesBriefs: await claim("gateFoldNoticeInvitesBriefs", gateFoldNoticeInvitesBriefs),
    foldNoticeSilenced: await claim("gateFoldNoticeSilenced", gateFoldNoticeSilenced),
  };
}

/**
 * OVERFLOW ROLLBACK AND RECOVERY
 *
 * One law: a rejected request is recovered from, once, and the recovery is stated. The
 * rollback is the mechanism and the advertised norm is its contract with the agent.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   66: Overflow rollback & recovery
 *   90: Recovery is the stated norm
 */
async function gateOverflowLane() {
  return {
    overflowRecovery: await claim("gateOverflowRecovery", gateOverflowRecovery),
    recoveryNormAdvertised: await claim("gateRecoveryNormAdvertised", gateRecoveryNormAdvertised),
  };
}

/**
 * SEALED SESSION SHAPES REPLAY
 *
 * One law: a shape measured in a sealed run stays resolved. Rep 19 and the rep-15 storm are
 * two such shapes, replayed rather than described.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   84: The rep-19 shape resolves
 *   69: Quiet runtime & rep-15 storm replay
 */
async function gateSealedShapes() {
  return {
    rep19ShapeResolves: await claim("gateRep19ShapeResolves", gateRep19ShapeResolves),
    quietRuntimeStormReplay: await claim("gateQuietRuntimeStormReplay", gateQuietRuntimeStormReplay),
  };
}

/**
 * THE CLASS LAW: MEMBERSHIP, NOT POSITION
 *
 * One law, and it is the one a position-based reading breaks: a span is held because of
 * what it IS, never because of where it sits. The unified span law is the statement, the
 * three-hold reading is the enumeration, and unconditionality at every occupancy is the
 * part a fence-only fixture cannot reach.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   94: One span law: raw, nested, pinned
 *   97: The class law: membership, not position
 *   98: The class law is unconditional
 */
async function gateClassLaw() {
  return {
    unifiedSpanLaw: await claim("gateUnifiedSpanLaw", gateUnifiedSpanLaw),
    threeZones: await claim("gateThreeZones", gateThreeZones),
    fenceOpensTheMiddle: await claim("gateFenceOpensTheMiddle", gateFenceOpensTheMiddle),
  };
}

/**
 * THE CONFIGURATION SURFACE
 *
 * One law: a configuration is validated at construction and a retired one is refused BY
 * NAME. Thresholds, the scheduling wire, the collapsed levers, the public option list and
 * the retired state fields are one surface, and silence on any of them hands a deployment
 * the opposite of what it asked for.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   96: Thresholds are validated at construction
 *   38: Scheduling wire round-trip
 *   68: Lever collapse
 *   102: The public option surface
 *   129: A retired state field is refused by name
 */
async function gateConfigurationSurface() {
  return {
    thresholdConstruction: await claim("gateThresholdConstruction", gateThresholdConstruction),
    schedulingWireRoundTrip: await claim("gateSchedulingWireRoundTrip", gateSchedulingWireRoundTrip),
    leverCollapse: await claim("gateLeverCollapse", gateLeverCollapse),
    publicOptionSurface: await claim("gatePublicOptionSurface", gatePublicOptionSurface),
    retiredStateFieldsAreRefusedByName: await claim("gateRetiredStateFieldsAreRefusedByName", gateRetiredStateFieldsAreRefusedByName),
  };
}

/**
 * OCCUPANCY IS ANCHORED, AND THE HAZARD THAT REMAINS
 *
 * One law, stated with its limit: occupancy reads the provider's own count plus what
 * arrived after it, and the minimum-over-window rule can still under-read a raw-heavy
 * projection. The gate that pins the anchor and the gate that pins what the anchor does
 * not fix are the same claim honestly told.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   110: Occupancy is anchored to what the provider counted
 *   111: The calibration hazard the anchor narrows but does not remove
 */
async function gateOccupancyAnchor() {
  return {
    anchoredOccupancy: await claim("gateAnchoredOccupancy", gateAnchoredOccupancy),
    calibrationHazard: await claim("gateCalibrationHazard", gateCalibrationHazard),
  };
}

/**
 * DERIVATION IS MEMOIZED PER OBJECT
 *
 * One law: derive once against the OBJECT, and let a replaced object miss rather than
 * serve stale. Entry evidence, mark readings, evidence digests, canonicalization and
 * projection fingerprints are five places the same quadratic was paid.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   113: Entry evidence is derived once, never rebuilt
 *   120: A mark reading takes a view; only a write copies
 *   121: An evidence digest is derived once per message object
 *   132: Canonicalization is memoized per message object
 *   133: A projection fingerprint is computed on demand
 */
/**
 * ROOT INTERVALS ARE DERIVED ONCE PER (STATE, SNAPSHOT) PAIR (2026-08-24).
 *
 * `partsForRange` opens with `orderedRoots`, and `selectAutomaticChapter` calls
 * `partsForRange` from a walk that is quadratic in units, so the cost was
 * O(units^2 x roots x folds) for an answer that cannot change inside a pass. The
 * derivation is O(roots x folds) on its own, because `foldInterval` calls
 * `flattenFoldRefs`, which rebuilds `foldMap` for every root it walks.
 *
 * Replaying sealed sol-20260823-live rep 3 at 125 folds, ONE frontier walk made 12,333
 * calls and spent 22.5 seconds, and 12,328 returned null without reading a single root,
 * because the automatic chapter passes an EMPTY allowed-child set and any overlap refuses.
 * At 140 folds the walk was 98.8 percent of the runtime's whole per-request cost, and the
 * gap between a response and the next projection ran 3s at zero folds to 164s past 150.
 * Across one run of this suite the memo turns 1,751,726 calls into 6,412 derivations.
 *
 * Fails on the pre-fix runtime at its FIRST assertion: an underived call builds a fresh
 * array every time, so identity cannot hold.
 */
async function gateOrderedRootsDerivedOncePerPair() {
  const { orderedRoots } = measurementModule;
  const built = await chapterForest(4);
  const { snapshot, state } = built;
  const roots = orderedRoots(state, snapshot);
  // Anti-vacuity: an empty forest would make every assertion below trivially true, and a
  // single root would not prove the sort survives the memo.
  assert(roots.length >= 4, `The fixture offered only ${roots.length} roots`);
  assert(state.folds.length >= 4, `The fixture committed only ${state.folds.length} folds`);

  // THE MEMO ITSELF: one pair derives once and every later reading is handed that array.
  assert.equal(orderedRoots(state, snapshot), roots,
    "orderedRoots derived twice for one (state, snapshot) pair");

  // KEYED ON THE OBJECTS, NEVER ON CONTENT. A replaced state MISSES and derives its own
  // answer, which is what stops a stale serve after any change: state is replaced rather
  // than mutated on every write, so identity keying is what makes the memo safe at all.
  const replacedState = { ...state, folds: state.folds.map((fold) => ({ ...fold })) };
  const replacedRoots = orderedRoots(replacedState, snapshot);
  assert.notEqual(replacedRoots, roots, "A replaced state was served the previous array");
  assert.deepEqual(replacedRoots.map(({ fold }) => fold.id), roots.map(({ fold }) => fold.id),
    "A replaced state with identical content derived a different forest");
  // And the same on the other key, because the pair is what the answer depends on.
  const replacedSnapshot = { ...snapshot };
  assert.notEqual(orderedRoots(state, replacedSnapshot), roots,
    "A replaced snapshot was served the previous array");

  // SPAN ORDER SURVIVES: the memo hands back the SORTED array, not insertion order.
  assert.deepEqual(roots.map(({ start }) => start),
    [...roots.map(({ start }) => start)].sort((left, right) => left - right),
    "The memoized roots are not in span order");

  // NO READING MUTATES WHAT THE MEMO HANDS OUT. The array is shared by every caller, so a
  // reading that sorts, pushes or splices it would poison every later reading. Gate 120
  // proved this for the mark accessor; the same hazard arrives here the moment the copy
  // stops being made, so the real call sites are driven against a FROZEN array and a
  // reading that starts mutating throws instead of quietly corrupting the forest.
  Object.freeze(roots);
  assert.equal(orderedRoots(state, snapshot), roots, "The frozen array is no longer the memoized one");
  const stale = context.unpinnedStaleFolds(snapshot, state);
  assert(Array.isArray(stale), "unpinnedStaleFolds did not read the frozen roots");
  const span = context.selectAutomaticSpan(snapshot, state);
  assert(span === null || typeof span === "object", "selectAutomaticSpan did not read the frozen roots");
  assert.equal(context.visibleCollapsedRoots(state, snapshot).length,
    roots.filter(({ fold }) => !state.expanded.includes(fold.id)).length,
    "visibleCollapsedRoots disagreed with the memoized forest");

  // THE ONE COST, ASSERTED RATHER THAN LEFT TO BE FOUND (gate 121's rule): a state mutated
  // IN PLACE keeps its first derivation. Nothing in the runtime mutates a committed state,
  // and this is the decision that makes that a requirement rather than a habit.
  const mutated = { ...state, folds: [...state.folds] };
  const firstOfMutated = orderedRoots(mutated, snapshot);
  mutated.folds.pop();
  assert.equal(orderedRoots(mutated, snapshot), firstOfMutated,
    "The forest is not kept against the state object, so the memo is not in effect");

  return {
    roots: roots.length,
    folds: state.folds.length,
    memoizedPerPair: true,
    replacedStateMisses: true,
    replacedSnapshotMisses: true,
    keptAgainstTheObject: true,
    readingsDoNotMutate: true,
  };
}

async function gateDerivationMemos() {
  return {
    incrementalEvidenceMap: await claim("gateIncrementalEvidenceMap", gateIncrementalEvidenceMap),
    markReadsTakeAView: await claim("gateMarkReadsTakeAView", gateMarkReadsTakeAView),
    evidenceDigestDerivedOncePerObject: await claim("gateEvidenceDigestDerivedOncePerObject", gateEvidenceDigestDerivedOncePerObject),
    canonicalizationIsMemoizedPerMessageObject: await claim("gateCanonicalizationIsMemoizedPerMessageObject", gateCanonicalizationIsMemoizedPerMessageObject),
    projectionFingerprintsAreComputedOnDemand: await claim("gateProjectionFingerprintsAreComputedOnDemand", gateProjectionFingerprintsAreComputedOnDemand),
    orderedRootsDerivedOncePerPair: await claim("gateOrderedRootsDerivedOncePerPair", gateOrderedRootsDerivedOncePerPair),
  };
}

/**
 * A PARENT BRIEF INDEXES EVERY CHILD
 *
 * One law: a parent's brief is the entry the agent navigates by, so every child appears in
 * it and nothing structural leaks into it. The tool-name inheritance is what happens when
 * that second half is missing, and it killed two sealed runs.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   115: A parent brief covers every child
 *   125: A parent brief cannot inherit a structural tool name
 */
async function gateParentBrief() {
  return {
    parentBriefCoversEveryChild: await claim("gateParentBriefCoversEveryChild", gateParentBriefCoversEveryChild),
    parentBriefCannotInheritToolName: await claim("gateParentBriefCannotInheritToolName", gateParentBriefCannotInheritToolName),
  };
}

/**
 * A LOST COMMIT AND A SUSPENDED RUNTIME ANNOUNCE THEMSELVES
 *
 * One law: the transitions that end folding for a session are never silent. A commit
 * discarded at persistence raises, and the suspension that raise causes writes to the
 * canonical stream rather than to a UI that a headless host does not have.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   122: A commit that vanishes at persistence announces itself
 *   123: Suspending automatic folding announces itself
 */
async function gateSilentFailures() {
  return {
    vanishedCommitAnnouncesItself: await claim("gateVanishedCommitAnnouncesItself", gateVanishedCommitAnnouncesItself),
    suspensionAnnouncesItself: await claim("gateSuspensionAnnouncesItself", gateSuspensionAnnouncesItself),
  };
}

/**
 * THE FRONTIER CUTS, THE BAND TOP COMMITS
 *
 * One law: the runtime decides WHEN, on its own, at both ends. The frontier cuts as
 * material arrives and the band top commits when occupancy reaches it, and neither waits
 * for the agent or for a turn to close.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   141: The frontier cuts as material arrives; the commit fills what the agent left
 *   144: The band top commits on its own
 */
/**
 * THE UNMARKED REMAINDER COUNTS EVERYTHING THE SELECTOR CAN REACH (Shane, 2026-08-23).
 *
 * It enumerated `automaticToolBatches` alone while `selectAutomaticSpan` proposes a
 * CHAPTER whenever no batch is available, so on a session with no tool results it reported
 * a remainder of zero over material automatic folding was about to take. Two things read
 * it and both were misled: the deferred-commit record, whose whole job is to say whether
 * the mass it could not reach is HELD or simply ABSENT, and the brief response, which
 * tells the agent how much is still unspoken for. It also broke the frontier's first cut,
 * which gated on this number before the threshold moved into the selector.
 *
 * The population is now walked WITH the selector rather than re-derived beside it, so it
 * cannot drift from what folding actually reaches.
 */
async function gateRemainderCountsChapters() {
  // No tool results at all, so every foldable thing here is a chapter and the old
  // population is empty by construction. That is what makes this fixture the probe: it
  // reads zero on the pre-fix runtime for a reason that is visible in the assertion below.
  // 2,500 chapter chars puts a user/assistant PAIR at roughly 10,000 characters, between
  // the shipped minFoldChars floor of 8,000 and the 16,000 bite-size cap, which is the
  // band a chapter has to land in to be selected at all. The shipped thresholds are used
  // rather than the tiny-floor fixture, because the reading under test is the one a real
  // deployment gets.
  const built = makeFixture({ turns: 14, tools: false, chapterChars: 2_500, contextWindow: 100_000 });
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
  assert.equal(context.automaticToolBatches(snapshot, empty).length, 0,
    "The fixture carries tool batches, so the tool-only population is not what is being measured");
  assert(context.selectAutomaticSpan(snapshot, empty),
    "Automatic folding cannot reach this fixture at all, so there is no remainder to report");

  const remainder = context.unmarkedRemainder(snapshot, empty, context.ESTIMATED_BYTES_PER_TOKEN);
  assert(remainder.spans >= 1 && remainder.chars > 0,
    `The remainder reported ${remainder.spans} spans and ${remainder.chars} chars over material ` +
    "the selector is about to fold");
  assert.equal(remainder.share, 1,
    "Nothing is claimed yet, so every foldable byte is unclaimed");

  // AND A CLAIM SUBTRACTS FROM IT. The population is the denominator, so a chapter the
  // frontier has already cut stays IN it and leaves the numerator, which is the whole
  // distinction the deferred-commit record draws between held mass and absent mass.
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 20_000, 100_000);
  const cuts = await frontierCuts(runtime);
  assert(cuts.length >= 1, "The frontier cut nothing on a chapter-only session");
  assert(cuts.every((fold) => fold.kind === "chapter"),
    `The chapter-only fixture produced ${cuts.map((fold) => fold.kind)}`);
  const live = (await toolStatus(runtime)).details.automatic;
  const claimedRemainder = context.unmarkedRemainder(
    context.mapActiveContext({
      sessionId: built.sessionId,
      eventMessages: runtime.messages,
      contextEntries: runtime.branch,
      contextWindow: 100_000,
    }),
    materialized(runtime),
    context.ESTIMATED_BYTES_PER_TOKEN,
  );
  assert(claimedRemainder.spans >= 1,
    "The chapter population vanished once the session had a state to read");
  void live;

  return {
    toolBatches: 0,
    chapterSpansCounted: remainder.spans,
    chapterCharsCounted: remainder.chars,
    frontierCutKinds: [...new Set(cuts.map((fold) => fold.kind))],
  };
}

async function gateFrontierAndTrigger() {
  return {
    ladderFillsWhatTheAgentLeft: await claim("gateLadderFillsWhatTheAgentLeft", gateLadderFillsWhatTheAgentLeft),
    bandTopCommits: await claim("gateBandTopCommits", gateBandTopCommits),
    remainderCountsChapters: await claim("gateRemainderCountsChapters", gateRemainderCountsChapters),
  };
}

/**
 * THE FOLD EDITOR
 *
 * One law: the editor is a view onto the same validated paths the tool uses. Rendering,
 * laying a mark, withdrawing one, pinning an entry and writing a brief all go through the
 * runtime rather than around it.
 *
 * Carries what these gates each proved on their own, and their numbers stay spent:
 *   142: The fold editor renders the working window read-only
 *   145: The user lays marks in the fold editor over the validated path
 *   146: The editor withdraws marks, pins entries and takes a written brief
 */
async function gateFoldEditor() {
  return {
    foldEditorRendersReadOnly: await claim("gateFoldEditorRendersReadOnly", gateFoldEditorRendersReadOnly),
    foldEditorUserMarks: await claim("gateFoldEditorUserMarks", gateFoldEditorUserMarks),
    foldEditorWithdrawPinBrief: await claim("gateFoldEditorWithdrawPinBrief", gateFoldEditorWithdrawPinBrief),
  };
}

/**
 * GATE 147: THE FRONTIER WAITS FOR THE BATCH (2026-08-24).
 *
 * The deep dive on sol-20260823-live found the tool-first preference in
 * selectAutomaticSpan starved to ZERO in production: the frontier cuts the moment a span
 * crosses minFoldChars, which on a pull-shaped session is always one turn before that
 * span's tool batch passes the consumption proof in resultCallIndex (two later
 * generations in an open turn). The chapter lane had no such proof, took the span, and
 * claimed the refs, so the batch that qualified one turn later found its material owned.
 * Rep 3 cut 219 chapters and zero tool folds over a transcript whose every span replays
 * as a tool-result when aged; 188 placeholders were byte-identical "User: No user ask ·
 * Tools: 1×repo_stage · Assistant: No assistant text", and the agent re-peeked 76 folds
 * 209 times to rebuild the index the brief should have carried, at $40.71 and a watchdog
 * death. The 2.x runtime cut 82 identified tool folds on the same geometry at $17.00.
 *
 * The floor: a stale span may be cut only when it ends before the second-newest open
 * generation (staleSpanMatureEnd), the same proof the batch lane already demands, so by
 * the time the chapter lane may touch material the tool lane has had its turn at it. A
 * closed session (terminal assistant) folds to its end exactly as before. This is not
 * gate 19/72's fresh-tail proportion returning: nothing reads bytes or shares.
 *
 * The gate drives the LIVE cadence: frontier passes as the transcript grows, pending
 * marks carried forward. On the pre-floor runtime every one of these cuts comes out a
 * chapter and the population assertion fails.
 *
 * THE FLOOR'S OTHER EDGE (2026-08-26): a consumption proof that waits for a response
 * that can never come holds material forever. The dead-turn claim below carries that
 * half; the doc for the wedge that forced it lives on the claim itself.
 */
async function gateFrontierWaitsForTheBatch() {
  const built = makeFixture({ pull: true, turns: 14, resultChars: 30_000 });
  const snapshotOver = (messages, entries) => context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: messages,
    contextEntries: entries,
    contextWindow: 272_000,
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  });
  let state = context.emptyActiveContextState(built.sessionId);
  const cuts = [];
  for (let n = 2; n <= built.messages.length; n += 1) {
    if (built.messages[n - 1].role !== "toolResult") continue;
    const head = built.messages.slice(0, n);
    const snapshot = snapshotOver(head, built.entries.slice(0, n));
    const matureEnd = context.staleSpanMatureEnd(head);
    for (const mark of context.frontierMarks({ snapshot, state, ordinal: n })) {
      for (const part of mark.parts) {
        if (part.kind !== "raw") continue;
        const item = context.exactMapped(snapshot, part.ref);
        assert(item && item.index < matureEnd,
          `a ${mark.kind} cut at pass ${n} reached index ${item?.index} past the maturity floor ${matureEnd}`);
      }
      const addition = context.addPendingMark(state, mark);
      if (addition.added) state = addition.state;
      cuts.push(mark);
    }
  }
  const toolCuts = cuts.filter((mark) => mark.kind === "tool-result");
  assert(cuts.length >= 8, `the incremental frontier cut only ${cuts.length} spans`);
  // THE POPULATION. This is the line the pre-floor runtime fails: chapters, every one.
  assert(toolCuts.length >= 8,
    `only ${toolCuts.length} of ${cuts.length} incremental cuts were identified tool folds`);
  for (const mark of toolCuts) {
    assert(/file-\d+\.txt/.test(mark.brief) && mark.brief.includes('opens "'),
      `a tool fold's deterministic brief lost the identified head: ${mark.brief.slice(0, 120)}`);
  }
  for (const mark of cuts) {
    if (mark.kind !== "tool-result") assert.equal(mark.kind, "chapter");
  }

  // THE FLOOR RELEASES ON CLOSE: a terminal assistant makes the whole transcript mature,
  // and the frontier reaches the remainder the open-session floor was holding.
  const closing = {
    role: "assistant",
    content: [{ type: "text", text: "All stages complete." }],
    stopReason: "stop",
    timestamp: 100_000,
  };
  const closedMessages = [...built.messages, closing];
  const closedEntries = [...built.entries, {
    type: "message", id: `${built.sessionId}-closing`, parentId: built.entries.at(-1).id, message: closing,
  }];
  assert.equal(context.staleSpanMatureEnd(closedMessages), closedMessages.length,
    "a closed session did not mature to its end");
  const closedSnapshot = snapshotOver(closedMessages, closedEntries);
  const more = context.frontierMarks({ snapshot: closedSnapshot, state, ordinal: 999 });
  assert(more.length >= 1, "a closed session left the held tail uncuttable");

  return {
    incrementalCuts: cuts.length,
    identifiedToolFolds: toolCuts.length,
    chapterCuts: cuts.length - toolCuts.length,
    closedTailCuts: more.length,
    deadTurnCloses: await claim("gateDeadTurnIsAClosedTurn", gateDeadTurnIsAClosedTurn),
  };
}

/**
 * A DEAD TURN IS A CLOSED TURN (sol-20260826-full2, pifold rep 1).
 *
 * The consumption proof demands a response AFTER a batch before its material may fold,
 * and a turn that ends in an errored assistant will never produce one: the projection
 * fence aborted a request that would not fit, the abort put an errored assistant at the
 * end of the turn holding the 423KB peek copy that made it not fit, the errored turn was
 * invisible to completeTurns, resultCallIndex and staleSpanMatureEnd alike, and the next
 * thirty-four requests aborted identically with the reclaimer finding nothing it was
 * allowed to touch. The session deadlocked by construction: folding waited for a
 * response, and the response waited for folding.
 *
 * The law now: a turn whose last word is an errored or aborted assistant, WITH A USER
 * MESSAGE ALREADY STANDING AFTER IT, is closed. Its own dead terminal grants the
 * consumption point a finished turn's terminal does, and maturity reaches through it.
 * The live tail keeps the strict rule, driven first: while the errored assistant is the
 * last message the turn may still be retried in place, so death alone closes nothing.
 *
 * On the pre-fix runtime the closed-half assertions fail: resultCall stays null, the
 * floor stays at zero, and the frontier cuts nothing.
 */
async function gateDeadTurnIsAClosedTurn() {
  const sessionId = "dead-turn-fixture";
  const payload = Array.from({ length: 900 }, (_, line) =>
    `payload line ${line}: the stage facts sit here and nowhere else`).join("\n");
  const messages = [
    { role: "user", content: [{ type: "text", text: "Read the payload files for this stage." }], timestamp: 1 },
    { role: "assistant", content: [
      { type: "toolCall", id: "c-read", name: "bash", arguments: { command: "cat payload.txt" } },
    ], stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "c-read", toolName: "bash", isError: false,
      content: [{ type: "text", text: payload }], timestamp: 3 },
    { role: "assistant", content: [], stopReason: "error", timestamp: 4 },
    { role: "user", content: [{ type: "text", text: "Next stage: keep going." }], timestamp: 5 },
  ];
  const entries = messages.map((message, index) => ({
    type: "message",
    id: `${sessionId}-entry-${index}`,
    parentId: index ? `${sessionId}-entry-${index - 1}` : null,
    message,
  }));
  const snapshotOver = (count) => context.mapActiveContext({
    sessionId,
    eventMessages: messages.slice(0, count),
    contextEntries: entries.slice(0, count),
    contextWindow: 272_000,
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  });

  // THE LIVE TAIL, STRICT: the errored assistant is the last message, the turn may
  // still be retried in place, and nothing about it is closed, consumed or mature.
  assert.equal(context.deadAssistant(messages[3]), true);
  assert.equal(context.deadAssistant(messages[0]), false, "a user message read as a dead assistant");
  assert.equal(context.terminalAssistant(messages[3]), false, "an errored stop read as a finished turn");
  const live = snapshotOver(4);
  assert.deepEqual(context.completeTurns(messages.slice(0, 4)), [],
    "a dead turn closed while it was still the live tail");
  assert.equal(context.staleSpanMatureEnd(messages.slice(0, 4)), 0,
    "maturity reached into a turn that may still be retried");
  assert.equal(context.resultCall(live, 2, true), null,
    "a live dead turn's batch became eligible before a user message stood after it");

  // THE CLOSED HALF: a user message stands after the dead turn, so it is over. The
  // turn is complete, its batch is eligible through its own dead terminal, maturity
  // reaches its end, and the frontier cuts the very material the wedge could not.
  const closed = snapshotOver(5);
  assert.deepEqual(context.completeTurns(messages), [{ start: 0, end: 4 }],
    "a dead turn with a user message after it did not close");
  assert.equal(context.staleSpanMatureEnd(messages), 4,
    "maturity did not reach through the closed dead turn");
  const call = context.resultCall(closed, 2, true);
  assert(call && call.id === "c-read",
    "the dead turn's batch is still ineligible with the turn closed");
  const cuts = context.frontierMarks({
    snapshot: closed,
    state: context.emptyActiveContextState(sessionId),
    ordinal: 1,
  });
  const cutIndices = cuts.flatMap((mark) => mark.parts
    .filter((part) => part.kind === "raw")
    .map((part) => context.exactMapped(closed, part.ref)?.index));
  assert(cutIndices.includes(2),
    `the frontier still cannot reach the dead turn's result; it cut ${JSON.stringify(cutIndices)}`);
  return {
    liveTailHeld: true,
    closedTurn: { start: 0, end: 4 },
    matureEnd: context.staleSpanMatureEnd(messages),
    eligibleCall: call.id,
    frontierCutIndices: cutIndices,
  };
}

/**
 * GATE 148: THE TOOL-CALL DIET (2026-08-24, Shane's ToolFoldThreshold).
 *
 * One new public option, `toolFoldThreshold` (a share in [0, 1), default 0.50 since
 * 2026-08-28 and off at 0): at COMMIT TIME ONLY, tool results inside the oldest share
 * of the projected window are clipped IN VIEW to an identified head with the cut stated
 * and the recovery named, the full bytes staying peek-recoverable behind the entry id
 * the marker carries. Small results are cheap and stay whole (toolClipFloorChars); the
 * win the option buys is the multi-kilobyte result the provider is being made to re-read.
 *
 * The laws, each driven below:
 *   - SELECTION mirrors the fold lanes' own holds one view over: mature only (the batch
 *     lane's consumption proof), unprotected, unblacklisted, over the floor, stalest
 *     first inside the zone, never twice.
 *   - The clip RIDES THE COMMIT's own transaction and revision: no non-commit pass ever
 *     adds one, moves one, or renders differently twice (the cache law), and the clip
 *     set travels the persistence wire with the state it landed in.
 *   - The marker is BYTE-ACCOUNTED: head plus hidden count equals the source, the head
 *     is toolClipHead's paragraph rule (gate 134's), and peek by the named entry id (or
 *     the call id) returns the full result byte-identical.
 *   - The clip is a LENS, never the record: a later fold of a clipped span encodes the
 *     RAW bytes, so losslessness is untouched (gate 108's spirit one mechanism over).
 *   - OFF means OFF: with the option absent the same drive commits the same folds with
 *     zero clips, no marker, and durable state identical but for the clip set.
 *   - The option is validated at registration by its own invariant name.
 */
const CLIP_GATE_THRESHOLDS = Object.freeze({
  ...context.DEFAULT_THRESHOLDS, maxTarget: 0.50, minTarget: 0.20,
});
const CLIP_GATE_WINDOW = 200_000;
const CLIP_GATE_BUDGET = 120_000;

/** Each result opens with a short paragraph (the head the clip keeps) and ends with a
 *  per-turn fact planted past the head cap, so "the clipped view lost it and the fold
 *  kept it" is measurable without self-similar containment probes (gate 94's lesson). */
function clipGateResultText(turn) {
  return `Result ${turn}: stage payload opens here.\n\n${"r".repeat(13_000)} deep-fact-${turn}-end`;
}

/**
 * The band-top drive gate 144 proved, reused verbatim: measured occupancy crosses
 * maxTarget x budget, the commit fires with the DEPTH BOUND armed, the cut takes stalest
 * first and stops at the aim, and the mature raw survivors are exactly the material the
 * diet's zone then reads. This is the only commit shape on which clips can land at all:
 * a deferred boundary returns before the clip pass, which is claim (c)'s atomicity from
 * the other side.
 */
async function driveClippedCommit(options = {}) {
  const built = makeFixture({
    sessionId: "tool-clip", turns: 26, resultText: clipGateResultText,
    contextWindow: CLIP_GATE_WINDOW,
  });
  const runtime = makeRuntime(built, {
    providerInputBudget: CLIP_GATE_BUDGET, thresholds: CLIP_GATE_THRESHOLDS, ...options,
  });
  await startRuntime(runtime);
  await measure(runtime, Math.ceil(CLIP_GATE_THRESHOLDS.maxTarget * CLIP_GATE_BUDGET) + 4_000,
    CLIP_GATE_WINDOW);
  await project(runtime);
  await settle();
  return { built, runtime };
}

function clipCommitsOf(runtime) {
  return contextEvents(runtime)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
}

function clipRawResult(runtime, callId) {
  const raw = runtime.messages.find((message) =>
    message?.role === "toolResult" && message.toolCallId === callId);
  assert(raw, `No raw tool result carries call id ${callId}`);
  return raw;
}

async function gateClipSelection() {
  // An OPEN pull session, so the maturity floor has something to hold: the newest
  // generations are still being consumed and their results must stay whole even when
  // the zone reaches them. Turn 3's result sits under toolClipFloorChars; every other
  // result is well over it.
  const small = 1_400;
  const resultText = (turn) => turn === 3
    ? `Result 3: small probe. ${"s".repeat(small)}`
    : clipGateResultText(turn);
  const built = makeFixture({ pull: true, turns: 9, resultText, contextWindow: 272_000 });
  const snapshot = built.snapshot;
  const empty = context.emptyActiveContextState(built.sessionId);
  assert(small < context.ACTIVE_CONTEXT_POLICY.toolClipFloorChars,
    "The fixture's small result is not under the floor, so the exemption is untestable");
  const clipsAt = (threshold, state = empty, blacklist = new Set()) =>
    context.toolClipAdditions({ snapshot, state, threshold, blacklist });

  const wide = clipsAt(0.95);
  const wideCalls = wide.map((clip) => clip.callId);
  assert(wide.length >= 2, `A 0.95 zone over eight oversized mature results clipped ${wide.length}`);
  assert(wideCalls.includes("call-0"), "The stalest oversized result escaped the widest zone");

  // THE FLOOR: a result at or under toolClipFloorChars stays whole. Clipping it buys
  // almost nothing and adds a peek indirection.
  assert(!wideCalls.includes("call-3"), "A result under the floor was clipped");

  // THE MATURITY FLOOR: the same consumption proof the batch lane demands (gate 147).
  // The pull session is open, so its newest generations are immature by construction.
  const matureEnd = context.staleSpanMatureEnd(built.messages);
  const indexOf = (callId) => built.messages.findIndex((message) =>
    message?.role === "toolResult" && message.toolCallId === callId);
  assert(indexOf("call-8") >= matureEnd,
    "The fixture's newest batch is already mature, so the exemption is untestable here");
  assert(!wideCalls.includes("call-8"), "An immature result was clipped");
  for (const clip of wide) {
    assert(indexOf(clip.callId) < matureEnd,
      `Clip ${clip.callId} sits past the maturity floor`);
  }

  // THE ZONE IS A PREFIX IN PROJECTED BYTES: a narrower share selects a stalest-first
  // subset of the wider one, never a different population.
  const narrow = clipsAt(0.35);
  assert(narrow.length >= 1 && narrow.length < wide.length,
    `A 0.35 zone selected ${narrow.length} of the wide zone's ${wide.length}`);
  assert.deepEqual(narrow.map((clip) => clip.callId), wideCalls.slice(0, narrow.length),
    "The narrow zone is not a stalest-first prefix of the wide one");

  // THE HOLDS: a blacklisted tool's results stay raw in view too; a pinned ref is a
  // durable hold; an already-clipped call is never re-added.
  assert.equal(clipsAt(0.95, empty, new Set(["read"])).length, 0,
    "A blacklisted tool's result was clipped");
  const pinnedRef = snapshot.mapped.find((item) => item.index === indexOf("call-0"))?.ref;
  assert(pinnedRef, "The fixture's stalest result has no evidence ref to pin");
  assert(!clipsAt(0.95, { ...empty, protected: [pinnedRef] })
    .some((clip) => clip.callId === "call-0"), "A pinned result was clipped");
  assert(!clipsAt(0.95, { ...empty, clips: [wide[0]] })
    .some((clip) => clip.callId === wide[0].callId), "A clip was re-added over itself");

  // THE WIRE: the clip set rides the state readers, and a corrupt list is refused by
  // name rather than read loosely.
  const seeded = JSON.parse(JSON.stringify({ ...empty, clips: wide }));
  assert.deepEqual(context.parseActiveContextState(seeded, built.sessionId).clips, wide);
  assert.throws(
    () => context.parseActiveContextState({ ...seeded, clips: [...wide, wide[0]] }, built.sessionId),
    /duplicate call id/);
  assert.throws(
    () => context.parseActiveContextState(
      { ...seeded, clips: [{ callId: "call-0", entryId: "e", extra: 1 }] }, built.sessionId),
    /Invalid active-context clip entry/);
  return { wideClips: wide.length, narrowClips: narrow.length, matureEnd };
}

async function gateClipCommitRendersAndRecovers() {
  const on = await driveClippedCommit({ retiredOptions: { toolFoldThreshold: 0.5 } });
  const fired = clipCommitsOf(on.runtime);
  assert.equal(fired.length, 1, `The band-top drive produced ${fired.length} commits`);
  assert(fired[0].applied_marks > 0, "The commit applied no folds, so there is no depth cut to survive");
  assert(fired[0].clipped_results >= 1,
    "The depth cut left mature raw results in the zone and the commit clipped none of them");
  const state = materialized(on.runtime);
  assert.equal(state.clips?.length ?? 0, fired[0].clipped_results,
    "The durable state and the commit record disagree on the clip count: the set did not survive the wire");

  // THE RENDER, BYTE-ACCOUNTED: every clip substitutes in place, identity preserved,
  // head + stated hidden count = the exact source, recovery named by entry id.
  const snapshotOf = (o) => context.mapActiveContext({
    sessionId: o.built.sessionId, eventMessages: o.runtime.messages,
    contextEntries: o.runtime.branch, contextWindow: CLIP_GATE_WINDOW,
  });
  const projected = context.projectActiveContext(snapshotOf(on), state);
  const clippedViews = projected.filter((message) =>
    message?.details?.projection === "tool-clip");
  assert.equal(clippedViews.length, state.clips.length,
    "The projection renders a different clip count than the state carries");
  const clip = state.clips[0];
  const view = clippedViews.find((message) => message.toolCallId === clip.callId);
  assert(view, `No clipped view carries call id ${clip.callId}`);
  const raw = clipRawResult(on.runtime, clip.callId);
  const full = context.contentText(raw);
  assert(full.length > context.ACTIVE_CONTEXT_POLICY.toolClipFloorChars,
    "The clipped result is under the floor, so the selection law is already broken");
  const head = context.toolClipHead(full, context.ACTIVE_CONTEXT_POLICY.toolClipHeadChars);
  assert.equal(view.content[0].text,
    `${head}\n... [${full.length - head.length} more chars clipped; ` +
    `{"action":"peek","id":"${clip.entryId}"} returns the full result]`);
  assert.equal(view.toolName, raw.toolName);
  assert.equal(view.timestamp, raw.timestamp);
  const turn = full.match(/^Result (\d+):/)[1];
  assert(!json.stableStringify(projected).includes(`deep-fact-${turn}-end`),
    "The clipped view still carries the deep bytes it claims to hide");

  // THE RECOVERY: peek by the entry id the marker names returns the full result
  // byte-identical; the call id answers too, honouring the byte bound.
  const peek = await toolCall(on.runtime,
    { action: "peek", id: clip.entryId, bytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars });
  assert.equal(peek.details.source, full, "The peek did not return the full result byte-identical");
  assert.equal(peek.details.truncated, false);
  assert.equal(peek.details.sourceChars, full.length);
  const byCall = await toolCall(on.runtime, { action: "peek", id: clip.callId, bytes: 2_000 });
  assert.equal(byCall.details.source, full.slice(0, 2_000));
  assert.equal(byCall.details.truncated, true);

  // THE CACHE LAW: a non-commit pass with unchanged clips adds nothing, moves nothing,
  // and renders byte-identically, which is what keeps the frozen prefix frozen.
  await project(on.runtime);
  await settle();
  await project(on.runtime);
  await settle();
  const after = materialized(on.runtime);
  assert.equal(after.clips.length, state.clips.length, "A non-commit pass moved the clip set");
  assert.equal(clipCommitsOf(on.runtime).length, 1, "A non-commit pass fired a commit");
  assert.equal(
    json.stableStringify(context.projectActiveContext(snapshotOf(on), after)),
    json.stableStringify(projected),
    "Two passes over unchanged clips rendered differently");

  // THE DEFAULT IS THE MEASURED VALUE (Shane 2026-08-28): an unconfigured runtime runs
  // the diet at DEFAULT_TOOL_FOLD_THRESHOLD rather than not at all, so absence is no
  // longer how a deployment says no.
  assert.equal(context.DEFAULT_TOOL_FOLD_THRESHOLD, 0.50);
  const unconfigured = await driveClippedCommit();
  const unconfiguredFired = clipCommitsOf(unconfigured.runtime);
  assert.equal(unconfiguredFired.length, 1);
  assert(unconfiguredFired[0].clipped_results > 0,
    "An unconfigured runtime did not run the diet its default names");

  // OFF MEANS OFF, and 0 is how it is said: the same drive commits the same folds with
  // zero clips and no marker, and the durable state differs by the clip set alone.
  const off = await driveClippedCommit({ retiredOptions: { toolFoldThreshold: 0 } });
  const offFired = clipCommitsOf(off.runtime);
  assert.equal(offFired.length, 1);
  assert.equal(offFired[0].clipped_results, 0, "The diet ran with no threshold configured");
  const offState = materialized(off.runtime);
  assert.equal(offState.clips, undefined, "A no-threshold run persisted a clip set");
  assert.equal(offFired[0].applied_marks, fired[0].applied_marks,
    "The diet changed WHAT the commit folded rather than only how survivors render");
  const strippedOn = { ...state };
  delete strippedOn.clips;
  // Identical but for the clip set and the wall clock: createdAt is the one field a
  // fold mints from the clock, so it is normalized before the byte comparison rather
  // than letting two otherwise-identical runs read as divergent.
  const clockless = (value) => json.stableStringify({
    ...value, folds: value.folds.map((fold) => ({ ...fold, createdAt: 0 })),
  });
  assert.equal(clockless(strippedOn), clockless(offState),
    "With the clips set aside, the two runs' durable state should be identical");
  assert(!json.stableStringify(context.projectActiveContext(snapshotOf(off), offState))
    .includes("more chars clipped"), "The no-threshold projection carries a clip marker");
  return { clippedResults: fired[0].clipped_results, appliedMarks: fired[0].applied_marks };
}

async function gateClipsNeverTouchTheFoldedBytes() {
  const { runtime } = await driveClippedCommit({ retiredOptions: { toolFoldThreshold: 0.5 } });
  const state = materialized(runtime);
  assert(state.clips?.length, "The drive landed no clips, so there is nothing to fold over");
  const clip = state.clips[0];
  const full = context.contentText(clipRawResult(runtime, clip.callId));
  const deep = `deep-fact-${full.match(/^Result (\d+):/)[1]}-end`;
  // A commit is one per crossing, so the second cut takes its own measurement before
  // the boundary fires; the boundary carries a ratio and no depth bound, so between the
  // two the clipped span is folded rather than surviving another shallow cut.
  await measure(runtime,
    Math.ceil(CLIP_GATE_THRESHOLDS.maxTarget * CLIP_GATE_BUDGET) + 8_000, CLIP_GATE_WINDOW);
  await project(runtime);
  await settle();
  await compactBoundary(runtime);
  const after = materialized(runtime);
  const owning = after.folds.find((fold) => (fold.parts ?? []).some((part) =>
    part.kind === "raw" && part.ref?.entryId === clip.entryId));
  assert(owning, "The boundary commit did not fold the clipped span");
  const peek = await toolCall(runtime,
    { action: "peek", id: owning.id, bytes: context.ACTIVE_CONTEXT_POLICY.maxSourceChars });
  assert(peek.details.source.includes(deep),
    "The fold lost the bytes the clip hid: the diet leaked from the view into the record");
  assert(!peek.details.source.includes("more chars clipped"),
    "The fold encoded the clipped VIEW rather than the raw bytes");
  return { owningFold: owning.kind, foldedSourceChars: peek.details.sourceChars ?? null };
}

async function gateClipOptionIsValidated() {
  const built = makeFixture({ turns: 2, resultChars: 2_000 });
  const refused = [1, -0.25, 1.5, "0.5", Number.NaN];
  for (const value of refused) {
    assert.throws(
      () => makeRuntime(built, { retiredOptions: { toolFoldThreshold: value } }),
      /toolFoldThreshold must be a share in \[0, 1\)/,
      `toolFoldThreshold ${String(value)} was accepted`);
  }
  // The half-open interval is accepted, 0 included: since 2026-08-28 the default is the
  // measured 0.50, so absence no longer means off and 0 is how a deployment says it.
  for (const value of [0, 0.05, 0.5, 0.937]) {
    makeRuntime(built, { retiredOptions: { toolFoldThreshold: value } });
  }
  return { refused: refused.length };
}

/**
 * A CLIP DELTA CARRIES THE CHANGE, NEVER THE WHOLE ARRAY (2026-08-24).
 *
 * `makeStateDelta` shipped `clips` whole on every write, which was 50.1 percent of all
 * state bytes on sealed sol-20260823-live rep 11 (472,750 of 942,902) and 49.2 percent on
 * rep 12, for an array that never held more than 34 entries. It is the third instance of
 * the defect the two comments above that line were written about: the brief map at 81
 * percent of state bytes, and the pending marks at 2.55 MB. The diet arrived without
 * inheriting their encoding.
 *
 * Clips are APPENDED and never edited, so the change is a count of what the base already
 * holds plus the ones that are new. The marks' order list would be WORSE than the bug
 * here, because a callId runs about a hundred characters and re-listing thirty of them on
 * every delta costs more than the array it replaces, which is why this carries a count.
 *
 * Fails on the pre-fix encoder at its first assertion, which is that a delta whose base
 * already holds clips does not restate them.
 */
async function gateClipDeltaCarriesOnlyTheChange() {
  const { makeStateDelta, makeStateCheckpoint, parseActiveContextState } = persistenceModule;
  const sessionId = "clip-delta";
  // Built through the runtime's own parser, because `stableStringify` walks own keys in
  // INSERTION order (the reason the legacy digest helpers in persistence.ts exist), so a
  // hand-ordered fixture digests differently from the state the reader reconstructs and
  // every replay below would fail on the fixture rather than on the encoding.
  const canonical = (state) => parseActiveContextState(state, sessionId, false);
  const clipAt = (index) => ({
    // A realistic callId, because its LENGTH is the whole reason this carries a count
    // rather than an order list: a short synthetic id would make the wrong encoding look
    // affordable and the assertion below vacuous.
    callId: `call_${"x".repeat(24)}${index}|fc_${"y".repeat(48)}${index}`,
    entryId: `entry-${index}`,
  });
  const withClips = (revision, count) => canonical({
    version: 1, sessionId, revision, folds: [], expanded: [], protected: [],
    tokensSinceToolFold: 0, leases: {},
    ...(count ? { clips: Array.from({ length: count }, (unused, index) => clipAt(index)) } : {}),
  });

  // Anti-vacuity: one clip is long enough that restating the array is a real cost, so a
  // delta that restated thirty of them could not hide inside the rest of the wire.
  assert(JSON.stringify(clipAt(0)).length > 100, "The fixture clip is too short to prove anything about bytes");

  // THE CHANGE, NOT THE ARRAY. Thirty clips already durable and one appended: the delta
  // states the base count and the single new clip, and never the thirty.
  const thirty = withClips(2, 30);
  const thirtyOne = withClips(3, 31);
  const appended = makeStateDelta(thirty, thirtyOne);
  assert.equal(appended.clips, undefined,
    "The delta restated the whole clips array instead of the change");
  assert.equal(appended.clipBase, 30, "The delta did not state what its base already holds");
  assert.equal(appended.addClips.length, 1, "The delta carried more than the one appended clip");
  assert.equal(appended.addClips[0].entryId, "entry-30");
  // The byte claim the defect is about, stated as a number rather than implied.
  assert(JSON.stringify(appended).length < JSON.stringify(thirtyOne.clips).length / 4,
    `A one-clip delta cost ${JSON.stringify(appended).length} bytes against an array of ` +
    `${JSON.stringify(thirtyOne.clips).length}`);

  // REPLAY IS EXACT, through the runtime's OWN reader rather than a copy of it here: a
  // gate that re-implements the reassembly proves only that the gate agrees with itself.
  const replayed = (wire, previous) => context.materializeActiveContextState([
    stateEntry(sessionId, makeStateCheckpoint(previous), "clip-base"),
    stateEntry(sessionId, wire, "clip-delta", "clip-base"),
  ], sessionId).clips ?? [];
  assert.deepEqual(replayed(appended, thirty), thirtyOne.clips,
    "The replayed clips are not the ones the delta was made from");

  // A ROLLBACK THAT SHORTENS THE ARRAY states a lower base and replays exactly. Nothing
  // edits a clip, so a shorter next is the only way the array can move backwards.
  const shrunk = makeStateDelta(thirtyOne, withClips(4, 12));
  assert.equal(shrunk.clipBase, 12, "A rollback did not state its lower base");
  assert.equal(shrunk.addClips, undefined, "A rollback invented clips to add");
  assert.deepEqual(replayed(shrunk, thirtyOne), withClips(4, 12).clips,
    "A rollback did not replay to the state it was made from");

  // THE FIRST CLIPS a session ever mints: no base, and every one of them is new.
  const first = makeStateDelta(withClips(2, 0), withClips(3, 3));
  assert.equal(first.clipBase, 0, "The first clips did not state an empty base");
  assert.equal(first.addClips.length, 3, "The first clips did not all travel");
  // A session that never clips carries no clip fields at all, so the wire is unchanged for
  // every deployment that leaves the diet off.
  const none = makeStateDelta(withClips(2, 0), withClips(3, 0));
  assert.equal(none.clipBase, undefined, "A diet-free session grew a clip field");
  assert.equal(none.addClips, undefined, "A diet-free session grew a clip field");

  // THE READER OUTLIVES THE WRITER. A delta written before this change states the whole
  // array, and sealed sessions replay it exactly as they did, which is the same
  // compatibility rule the briefs and the marks each carry.
  const legacy = { ...appended, clips: thirtyOne.clips };
  delete legacy.clipBase;
  delete legacy.addClips;
  assert.deepEqual(replayed(legacy, thirty), thirtyOne.clips,
    "A pre-change delta no longer replays its whole array");

  return {
    clipBytes: JSON.stringify(clipAt(0)).length,
    wholeArrayBytes: JSON.stringify(thirtyOne.clips).length,
    appendedDeltaBytes: JSON.stringify(appended).length,
    statesTheChange: true,
    rollbackStatesALowerBase: true,
    legacyWholeArrayStillReplays: true,
  };
}

/**
 * THE WORKING MEMORY (Shane, 2026-08-26).
 *
 * One law: the digest gets its own channel and the index stays mechanical. A maintained
 * digest (running tallies, current totals) is a different operation from a lossless
 * index, and the campaign measured what blending them costs: sol-20260826-full2 rep 4
 * invited agent prose into the index's briefs and answered nine end-block questions
 * confidently wrong where the deterministic arm answered zero wrong, while native's
 * maintained summary won exactly the running-tally artifact (6/6 against pifold's 0/6)
 * that no index operation can carry. So the working memory is a session-scoped ordered
 * dictionary in STATE: `remember` writes, updates or (empty body) removes an entry,
 * `recall` reads bodies on demand, and the projection carries ONE table of contents that
 * refreshes at each commit through the carrier freeze, so a quiet pass moves no byte.
 * Off by default: the option is the experiment's A/B seam and a deployment that does not
 * ask for the channel keeps yesterday's surface byte for byte.
 */
async function gateMemorySurfaceOff() {
  const built = makeFixture({ turns: 4, resultChars: 3_000 });
  // OFF IS THE DEFAULT, AND OFF IS YESTERDAY'S SURFACE. The action enum, the schema
  // properties and the description must be byte-identical to a build that never heard of
  // the working memory, so the option cannot leak wording into deployments that did not
  // ask for it.
  const off = makeRuntime(built);
  await startRuntime(off);
  const offTool = off.tools.get("pi_fold_context");
  assert.equal(offTool.parameters.properties.action.enum.includes("remember"), false,
    "remember is in the action enum with the working memory off");
  assert.equal(offTool.parameters.properties.action.enum.includes("recall"), false,
    "recall is in the action enum with the working memory off");
  for (const param of ["key", "body", "keys"]) {
    assert.equal(Object.hasOwn(offTool.parameters.properties, param), false,
      `The ${param} parameter is in the schema with the working memory off`);
  }
  assert.equal(offTool.description.includes("WORKING MEMORY"), false,
    "The tool description teaches the working memory while the option is off");
  let offRefusal = null;
  try {
    await toolCall(off, { action: "remember", key: "a", body: "b" });
  } catch (error) {
    offRefusal = error instanceof Error ? error.message : String(error);
  }
  assert(offRefusal !== null, "remember executed with the working memory off");
  assert.match(offRefusal, /not enabled/,
    "The off refusal does not say the action is not enabled");
  // ON, THE SURFACE TEACHES THE CHANNEL WITH ITS REAL CONSTANTS. The caps are stated
  // from policy, so a constant that moves cannot leave the tool text lying.
  const on = makeRuntime(built, { workingMemory: true });
  await startRuntime(on);
  const onTool = on.tools.get("pi_fold_context");
  for (const action of ["remember", "recall"]) {
    assert(onTool.parameters.properties.action.enum.includes(action),
      `${action} is missing from the action enum with the working memory on`);
  }
  assert.equal(onTool.parameters.properties.key.maxLength, policyModule.MEMORY_KEY_CHARS,
    "The key parameter does not state the key cap");
  assert.equal(onTool.parameters.properties.body.maxLength, policyModule.MEMORY_BODY_CHARS,
    "The body parameter does not state the body cap");
  assert(onTool.description.includes(`${policyModule.MEMORY_KEYS_MAX} entries`),
    "The description does not state the entry cap from the constant");
  assert.match(onTool.description, /table of contents/,
    "The description does not say only the table of contents rides the window");
  // The option is a boolean, refused by name otherwise.
  assert.throws(() => makeRuntime(built, { workingMemory: "yes" }),
    /workingMemory must be a boolean/, "A non-boolean workingMemory was accepted");
  return { offSurfaceUnchanged: true, capsStatedFromConstants: true };
}

async function gateMemoryDictionary() {
  const built = makeFixture({ turns: 4, resultChars: 3_000 });
  const runtime = makeRuntime(built, { workingMemory: true });
  await startRuntime(runtime);
  const payload = (result) => JSON.parse(result.content[0].text);
  const refusal = async (params) => {
    try {
      const result = await toolCall(runtime, params);
      return result?.isError ? String(result.content?.[0]?.text ?? "") : null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  // RECALL ON AN EMPTY MEMORY NAMES THE REPAIR, not a bare failure.
  const empty = await refusal({ action: "recall" });
  assert(empty !== null, "recall on an empty memory returned entries");
  assert.match(empty, /remember/, "The empty-memory refusal does not name remember as the repair");
  // WRITE, UPDATE, ORDER. Three entries, then an update, and the table of contents is
  // freshest first at every step: recency is the order the agent needs, because the
  // entry that just changed is the one the next read wants.
  for (const [key, body] of [["alpha", "first body"], ["beta", "second body"], ["gamma", "third body"]]) {
    const written = await toolCall(runtime, { action: "remember", key, body });
    assert(!written.isError, `remember ${key} was refused: ${JSON.stringify(written.content)}`);
  }
  const updated = payload(await toolCall(runtime, { action: "remember", key: "alpha", body: "first body, revised" }));
  assert.deepEqual(updated.entries.map((entry) => entry.key), ["alpha", "gamma", "beta"],
    "An updated entry did not move to the front of the table of contents");
  // RECALL READS BODIES: everything when keys is omitted, exactly the named ones
  // otherwise, and an unknown key is refused NAMING the keys that exist, because the
  // agent that misremembers a key is the agent that needs the list.
  const everything = payload(await toolCall(runtime, { action: "recall" }));
  assert.deepEqual(everything.entries.map((entry) => entry.body),
    ["first body, revised", "third body", "second body"],
    "recall does not return every body freshest first");
  const one = payload(await toolCall(runtime, { action: "recall", keys: ["beta"] }));
  assert.deepEqual(one.entries, [{ key: "beta", chars: "second body".length, body: "second body" }],
    "recall with keys does not return exactly the named entry");
  const unknown = await refusal({ action: "recall", keys: ["delta"] });
  assert(unknown !== null, "recall of an unknown key returned something");
  assert.match(unknown, /alpha.*gamma.*beta/s,
    "The unknown-key refusal does not list the keys that exist");
  // AN EMPTY BODY REMOVES, and removing what does not exist is refused with the list.
  const removed = payload(await toolCall(runtime, { action: "remember", key: "beta", body: "" }));
  assert.equal(removed.removed, true, "An empty body did not report the removal");
  assert.deepEqual(removed.entries.map((entry) => entry.key), ["alpha", "gamma"],
    "The removed entry still stands in the table of contents");
  const missing = await refusal({ action: "remember", key: "beta", body: "" });
  assert(missing !== null, "Removing an absent entry succeeded");
  // THE CAPS REFUSE BY NAME, stating the constant and the repair, never a bare limit.
  const longKey = await refusal({ action: "remember", key: "k".repeat(policyModule.MEMORY_KEY_CHARS + 1), body: "x" });
  assert(longKey !== null, "An over-cap key was accepted");
  assert.match(longKey, new RegExp(`${policyModule.MEMORY_KEY_CHARS}-character`),
    "The key refusal does not state the cap");
  const longBody = await refusal({ action: "remember", key: "wide", body: "b".repeat(policyModule.MEMORY_BODY_CHARS + 1) });
  assert(longBody !== null, "An over-cap body was accepted");
  assert.match(longBody,
    new RegExp(`${policyModule.MEMORY_BODY_CHARS}-character.*${policyModule.MEMORY_BODY_CHARS + 1}`, "s"),
    "The body refusal does not state the cap and the actual length");
  for (let index = 0; index < policyModule.MEMORY_KEYS_MAX - 2; index += 1) {
    const filled = await toolCall(runtime, { action: "remember", key: `fill-${index}`, body: "filler" });
    assert(!filled.isError, `Filling entry ${index} was refused`);
  }
  const over = await refusal({ action: "remember", key: "one-too-many", body: "x" });
  assert(over !== null, "A write past the entry cap was accepted");
  assert.match(over, new RegExp(`maximum of ${policyModule.MEMORY_KEYS_MAX}[\\s\\S]*Merge`),
    "The entry-cap refusal does not state the cap and the merge-or-remove repair");
  const atCap = await toolCall(runtime, { action: "remember", key: "alpha", body: "updates stay open at the cap" });
  assert(!atCap.isError, "Updating an existing entry was refused at the entry cap");
  // AND THE WRITES ARE DURABLE: the materialized state carries what the tool said it kept.
  const durable = materialized(runtime).memory ?? [];
  assert.equal(durable.length, policyModule.MEMORY_KEYS_MAX,
    "The durable state does not hold what the tool reported");
  assert.equal(durable.find((entry) => entry.key === "alpha")?.body, "updates stay open at the cap",
    "The durable body is not the last write");
  return { entriesExercised: policyModule.MEMORY_KEYS_MAX, capsRefuseByName: 3 };
}

async function gateMemoryTocOneCopyPerCommit() {
  const tocType = "pi-fold-active-context-memory-toc";
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built, { workingMemory: true });
  await startRuntime(runtime);
  // EMPTY MEMORY PROJECTS NOTHING: no carrier, no wording, no byte.
  const before = await project(runtime);
  assert.equal(before.messages.filter((message) => message?.customType === tocType).length, 0,
    "An empty working memory put a table of contents in the projection");
  // ONE COPY, AND A QUIET PASS MOVES NO BYTE. The carrier freeze is the refresh law:
  // between commits the copy stays buried at its index, so the occupancy anchor holds.
  await toolCall(runtime, { action: "remember", key: "tally", body: "three passes reviewed so far" });
  await toolCall(runtime, { action: "remember", key: "route", body: "the second pass owns the socket group" });
  const seated = await project(runtime);
  const tocs = seated.messages.filter((message) => message?.customType === tocType);
  assert.equal(tocs.length, 1, `${tocs.length} table-of-contents copies stand in one projection`);
  assert.match(tocs[0].content, /route[\s\S]*tally/,
    "The table of contents does not list the keys freshest first");
  assert.match(tocs[0].content, /"action":"recall"/,
    "The table of contents does not teach recall");
  const again = await project(runtime);
  assert.equal(json.stableStringify(again.messages), json.stableStringify(seated.messages),
    "A quiet pass over the same window moved a byte");
  // A WRITE BETWEEN COMMITS DOES NOT RE-RENDER THE CARRIER. The tool result is the live
  // view; the buried copy stays exactly where the freeze holds it, because a carrier
  // that moves on a quiet pass costs the whole prefix cache (the fold notice paid to
  // learn this and its comment records it).
  await toolCall(runtime, { action: "remember", key: "late", body: "arrived after the carrier seated" });
  const held = await project(runtime);
  const heldTocs = held.messages.filter((message) => message?.customType === tocType);
  assert.equal(heldTocs.length, 1, "A write between commits duplicated the carrier");
  assert.equal(heldTocs[0].content, tocs[0].content,
    "A write between commits re-rendered the buried carrier in place");
  // THE COMMIT REFRESHES IT: the old copy is gone, the fresh one lists the latest keys.
  const epoch = await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  assert(epoch.fired, "The commit did not fire, so the refresh is unproven");
  // The commit reclaimed the window, and the next measurement says so: without it the
  // occupancy anchor still reads the pre-commit 95 percent and the hard-context guard
  // returns the raw passthrough, which is that guard's own gate's subject, not this one's.
  await measure(runtime, 40_000, 100_000);
  const refreshed = await project(runtime);
  const after = refreshed.messages.filter((message) => message?.customType === tocType);
  assert.equal(after.length, 1, `${after.length} table-of-contents copies stand after the commit`);
  assert.match(after[0].content, /late/,
    "The refreshed table of contents does not carry the key written before the commit");
  assert.notEqual(after[0].content, tocs[0].content,
    "The table of contents did not refresh at the commit");
  return { copiesPerProjection: 1, refreshedAtCommit: true };
}

async function gateMemoryPersistence() {
  const sessionId = "memory-session";
  const base = {
    version: 1, sessionId, revision: 3, folds: [], expanded: [], protected: [],
    tokensSinceToolFold: 0, leases: {},
    memory: [
      { key: "tally", body: "three passes reviewed", ordinal: 1 },
      { key: "route", body: "socket group next", ordinal: 2 },
    ],
  };
  // THE CHECKPOINT CARRIES IT AND THE READER GIVES IT BACK.
  const checkpoint = persistenceModule.makeStateCheckpoint(base);
  assert.deepEqual(checkpoint.memory, base.memory, "The checkpoint does not carry the memory");
  const reread = persistenceModule.stateFromFoldRefs(checkpoint, checkpoint.foldRefs, new Map());
  assert.deepEqual(reread.memory, base.memory, "The memory does not survive the checkpoint round trip");
  // THE DELTA CARRIES THE WHOLE ARRAY, and a delta without the field replays EMPTY: the
  // discriminator rule the marks, the briefs and the clips already live by.
  const next = { ...base, revision: 4, memory: [{ key: "tally", body: "four passes reviewed", ordinal: 3 }] };
  const delta = persistenceModule.makeStateDelta(base, next);
  assert.deepEqual(delta.memory, next.memory, "The delta does not carry the whole array");
  const clearedTarget = { ...base, revision: 5 };
  delete clearedTarget.memory;
  const cleared = persistenceModule.makeStateDelta(next, clearedTarget);
  assert.equal(Object.hasOwn(cleared, "memory"), false,
    "A delta clearing the memory still carries the field, so absent cannot mean empty");
  // THE PARSER REFUSES what it cannot reproduce: a duplicate key, an over-cap store, a
  // malformed entry. Each by its own name.
  const reject = (memory, pattern, label) => assert.throws(
    () => persistenceModule.makeStateCheckpoint({ ...base, memory }), pattern, label);
  reject([{ key: "a", body: "x", ordinal: 1 }, { key: "a", body: "y", ordinal: 2 }],
    /duplicate key/, "A duplicate key was persisted");
  reject(Array.from({ length: policyModule.MEMORY_KEYS_MAX + 1 },
    (unused, index) => ({ key: `k${index}`, body: "x", ordinal: index })),
  new RegExp(`over ${policyModule.MEMORY_KEYS_MAX} entries`), "An over-cap store was persisted");
  reject([{ key: "a", body: "x", ordinal: 1, extra: true }],
    /working-memory entry/, "A malformed entry was persisted");
  // EMPTY AND ABSENT ARE THE SAME STATE, so a removal that empties the store cannot read
  // as a change forever after.
  const absent = { ...base };
  delete absent.memory;
  assert.equal(persistenceModule.sameStateProjection({ ...base, memory: [] }, absent), true,
    "An empty memory array reads as different from an absent one");
  return { wireForms: 2, refusalsByName: 3 };
}

async function gateWorkingMemory() {
  return {
    surfaceOffByDefault: await claim("gateMemorySurfaceOff", gateMemorySurfaceOff),
    dictionary: await claim("gateMemoryDictionary", gateMemoryDictionary),
    tocOneCopyPerCommit: await claim("gateMemoryTocOneCopyPerCommit", gateMemoryTocOneCopyPerCommit),
    persistenceRoundTrip: await claim("gateMemoryPersistence", gateMemoryPersistence),
  };
}

async function gateToolCallDiet() {
  return {
    clipSelection: await claim("gateClipSelection", gateClipSelection),
    clipCommitRendersAndRecovers: await claim("gateClipCommitRendersAndRecovers", gateClipCommitRendersAndRecovers),
    clipsNeverTouchTheFoldedBytes: await claim("gateClipsNeverTouchTheFoldedBytes", gateClipsNeverTouchTheFoldedBytes),
    clipOptionIsValidated: await claim("gateClipOptionIsValidated", gateClipOptionIsValidated),
    clipDeltaCarriesOnlyTheChange: await claim("gateClipDeltaCarriesOnlyTheChange", gateClipDeltaCarriesOnlyTheChange),
  };
}

const gates = [
  [1, "Registration, parse and deployment branding", gateRegistrationAndBranding],
  [2, "The durable record: lattice, chain and rollback", gateDurableRecord],
  [3, "The ladder reaches everything it is allowed to", gateLadderReach],
  [5, "Historical sessions still load and still resolve", gateHistoricalShapes],
  [9, "The compaction boundary commits", gateCompactionBoundary],
  // 11, 35, 39, 62, 75, 79, 80, 95 and 103 are retired together with the agent's `fold`
  // verb (Shane 2026-08-23). Every one of them pinned some property of THE AGENT CHOOSING
  // SPANS: that marking had no door below the band top (11), that a mark always marked
  // rather than folding (35), that marks accumulated across quiet passes (39), that a
  // batch of them auto-snapped loudly (62), that no commit verb sat beside them (75),
  // that the response taught the shape (79) and that the batched form was the one to
  // prefer (80), that agent spans nested where pins refused (95), and that one boolean
  // switched the copy teaching all of it (103).
  //
  // The agent does not choose spans any more. The runtime cuts at the frontier and the
  // agent annotates what it cut, so there is no create to have a door, a batch, a
  // response shape or a switch. What survives moved rather than vanished: the auto-snap
  // correction is gate 63's, which owns re-boundary; the action list is gate 102's, which
  // owns the public surface; and gate 141 owns what the frontier cuts and what the commit
  // then fills. The numbers stay spent.
  [12, "B2 expand leases", gateExpandLeases],
  [13, "Consolidation is the root count", gateConsolidationCountingRule],
  [14, "The rungs beyond the tool batch", gateRungsBeyondTheBatch],
  [15, "Status is bounded, diet-limited and itself foldable", gateStatusSurface],
  [16, "The projection is append-only", gateAppendOnlyProjection],
  [17, "Wire compatibility and stale anchors", gateWireCompatibility],
  // 19 is retired with fresh-tail protection (Shane 2026-08-23): it owned the one
  // proportion, and the proportion is deleted. Nothing decided on the tail boundary,
  // stale-first ordering already leaves recent material last in line, and a fold is
  // inert until commit so the agent keeps seeing fresh material regardless. The number
  // stays spent.
  [22, "Evidence artifacts are content-addressed and immutable", gateEvidenceArtifacts],
  // 23 is retired with the model brief generator (2026-08-14): it pinned the
  // dual-purpose brief prompt as a request contract, and the prompt is deleted.
  // 107 (the upgrade lane), 114 (generator call records), 118 (batched briefing)
  // and 126 (batch source attribution) retire with it; the corpus audit found 75
  // percent of 1,186 upgraded briefs never consulted or never visible. Numbers
  // stay spent so the history stays readable.
  [25, "Peek: one level, ephemeral, append-only", gatePeekSurface],
  [32, "The mark lifecycle", gateMarkLifecycle],
  [45, "Truthful capacity & admission control", gateTruthfulCapacityAdmission],
  [50, "Instrumentation: the stream, the cost and the cache", gateInstrumentation],
  [51, "Every fold carries a brief, and the brief carries the facts", gateBriefContract],
  [53, "Pins hold what they are named", gatePins],
  // 55 is retired (Shane 2026-08-23). It drove one fixture through the whole lever set and
  // read four claims off it: that marks accumulate one per pass, that the accumulated
  // batch lands in ONE commit, that no waiver fires below the fence, and that folds never
  // dribble. Every one of them was contingent on the agent marking the excursion by hand
  // while the ladder left the spine alone, and under the frontier the same fixture no
  // longer produces that state: the spine is cut and committed before the boundary is
  // reached, so the boundary sees only the guarded excursion, is genuinely starved, and
  // waives. Four rewrites in, each claim had moved somewhere it can actually be measured:
  // batching and the commit's fill to 141, the waiver and its release order to 130, the
  // band top firing once per crossing to 144. A fixture that needs its subject restated
  // every time the runtime changes was measuring the fixture. The number stays spent.
  [56, "The projection budget fence", gateProjectionFence],
  [61, "What the runtime tells the agent", gateRuntimeSpeech],
  [63, "Symmetric re-boundary", gateSymmetricReboundary],
  [65, "Wedge absorption & the anti-LCM pin", gateWedgeAbsorption],
  [66, "Overflow rollback and recovery", gateOverflowLane],
  [70, "One truthful serving budget", gateOneTruthfulBudget],
  // 72 is retired with fresh-tail (Shane 2026-08-23): its whole subject was a mark held
  // because its span was still fresh and folded once the span aged out, and there is no
  // aging out any more. Gate 46 carries accept-and-hold on the hold that remains, a pin,
  // including the release-then-fold half this gate owned. The number stays spent.
  [76, "No-yield commit guard on every path", gateNoYieldCommitGuard],
  [78, "Frozen surface & invisible marks", gateFrozenSurface],
  [84, "Sealed session shapes replay", gateSealedShapes],
  // 91 and 93 are retired with the rider (Shane 2026-08-23). Both pinned a POST-COMMIT
  // INVITATION TO CREATE MARKS: 91 that it was one literal per epoch, 93 that it carried
  // decisions rather than readouts. The runtime does the cutting now and the agent edits
  // what it cut, so there is no create to invite and no carrier to bound. The post-fold
  // notice that replaces it lands with its own gate. The numbers stay spent.
  [92, "The pinned-share cap refuses", gatePinnedShareCap],
  [94, "The class law: membership, not position", gateClassLaw],
  [96, "The configuration surface", gateConfigurationSurface],
  // 105 is retired, not free: its law inverted, twice. "Every completed tool batch folds
  // unmarked" staged marks on every measured response and crowded the agent out of
  // curation entirely -- dogfooding on 2026-08-21 showed an agent unable to mark
  // anything because the ladder had marked everything first, and the corpus agreed:
  // 30 sealed pifold runs, 2,529 automatic folds, zero voluntary ones. The ladder then
  // staged nothing between epochs. As of 2026-08-23 it stages again, at the frontier,
  // and the reason the objection no longer applies is that the agent is not being asked
  // to CHOOSE SPANS any more: the runtime cuts and the agent edits what it cut, so a cut
  // standing in front of the agent is the mechanism rather than the interference. Gate
  // 141 carries both halves, the frontier and the commit's fill.
  [141, "The frontier cuts, the band top commits", gateFrontierAndTrigger],
  [108, "A folded head never limits reach", gateProjectedStaleBasis],
  [110, "Occupancy is anchored, and the hazard that remains", gateOccupancyAnchor],
  [112, "A span already inside a fold is refused by name", gateOwnedSpanRefusal],
  [113, "Derivation is memoized per object", gateDerivationMemos],
  [115, "A parent brief indexes every child", gateParentBrief],
  // 117 retires with the generator too: it pinned the generator wire carrying no
  // maxTokens, and the package now makes zero provider calls of any kind. The law
  // itself stands in harness gate 52, which reads Pi's own derived ceiling.
  [122, "A lost commit and a suspended runtime announce themselves", gateSilentFailures],
  // 124 is retired, not free: the clean-rollback retry it pinned was deleted the day it
  // shipped, and reusing its number would make the history unreadable.
  // 37, 59, 99, 100 and 119 are retired with the thermostat. Each pinned an
  // ANNOUNCEMENT the occupancy trigger made on its way to a commit: the threshold
  // crossing, the two-signal curation trigger, the pre-commit last call, the threshold
  // notices, and the output wall's early crossing. The runtime commits at the
  // compaction boundary now, and a boundary Pi fires has nothing to announce in
  // advance. Their numbers stay spent for the same reason 124's does.
  [127, "A delta carries only what changed", gateDeltaCarriesOnlyBriefChanges],
  [130, "A boundary commits rather than no-op", gateBoundaryCommitsRatherThanNoOp],
  [128, "The user's commit announces a persistence failure", gateUserCommitAnnouncesPersistenceFailure],

  [136, "A brief's cut is stated, never silent", gateBriefTruncationIsExplicit],
  // 138 is retired with the steward band (Shane 2026-08-23). It pinned a PRE-COMMIT
  // invitation, timed one band before the epoch so the agent was asked while marking
  // could still matter. The ask moves to fold time, where the agent has just seen the
  // material, so a band whose whole job was timing that invitation has nothing left to
  // time. It also had a silent failure mode this gate could not see: measured against
  // real boundaries on 2026-08-23 the band never opened once in a three-boundary
  // session, so the agent was never invited at all. The number stays spent.
  [140, "Fold settings round-trip through one validation path", gateFoldSettingsRoundTrip],
  [142, "The fold editor", gateFoldEditor],
  [147, "The frontier waits for the batch", gateFrontierWaitsForTheBatch],
  [148, "The tool-call diet", gateToolCallDiet],
  [149, "The working memory", gateWorkingMemory],
  // 143 is retired with the agent's `fold` verb (Shane 2026-08-23). Its subject was the
  // ANSWER a mark comes back with: the drop the next commit has to make, what the mark
  // covers of it, and what the ladder takes otherwise, all so an agent choosing spans could
  // aim at a number. The agent does not choose spans, so there is no such answer to shape.
  // Its second half, that a pin is a claim on the window and pays nothing toward the drop,
  // is gate 92's (the pinned-share cap refuses) and gate 89's (protect is a durable pin),
  // both of which drive it on their own fixtures. The number stays spent.
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

// A MERGED GATE IS STILL SEVERAL CLAIMS, AND EACH ONE IS STILL TIMED. Consolidating the
// suite from 97 entries to 43 made the per-gate row coarser than the instrument it was
// bought with: "the projection budget fence costs 80 seconds" does not say which of its
// five claims spends them, and that is the number the decision needs. Every section of a
// merged gate runs through here, so the second table below reads at the old resolution
// while the registry reads at the new one. It found the deep-commit section spending 61.6
// of gate 56's 80 seconds on a fixture ten times larger than its own claim needed.
const claimTimings = [];
async function claim(name, run) {
  const startedAt = process.hrtime.bigint();
  try {
    return await run();
  } finally {
    claimTimings.push({ name, ms: Number(process.hrtime.bigint() - startedAt) / 1e6 });
  }
}

// EVERY GATE IS TIMED, and the slowest are listed at the end. A suite earns its wall clock
// the same way a gate earns its existence: by what it would catch. A gate that costs a
// minute and pins something another gate already pins is the first thing to go, and the only
// way to see that is to measure it rather than to guess at it.
let failures = 0;
const timings = [];
for (const [number, name, run] of selected) {
  const startedAt = process.hrtime.bigint();
  assertionBucket = number;
  try {
    const details = await run();
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    timings.push({ number, name, ms, assertions: assertionCounts.get(number) ?? 0 });
    process.stdout.write(`GATE ${String(number).padStart(2, "0")} ${name}: PASS ${json.stableStringify(details)}\n`);
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    timings.push({ number, name, ms, failed: true, assertions: assertionCounts.get(number) ?? 0 });
    failures += 1;
    process.stderr.write(`GATE ${String(number).padStart(2, "0")} ${name}: FAIL\n`);
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
}

const totalMs = timings.reduce((sum, row) => sum + row.ms, 0);
const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, Number(process.env.SLOWEST ?? 12));
process.stdout.write(`\nSUITE ${(totalMs / 1000).toFixed(1)}s over ${timings.length} gates\n`);
const totalAssertions = timings.reduce((sum, row) => sum + row.assertions, 0);
process.stdout.write(`${totalAssertions} assertions, ${(1000 * totalAssertions / totalMs).toFixed(1)} per second\n`);
process.stdout.write("slowest gates, which have the most to justify (asserts, and asserts per second):\n");
for (const row of slowest) {
  process.stdout.write(`  ${String(row.number).padStart(3)} ${(row.ms / 1000).toFixed(1).padStart(6)}s  ` +
    `${(100 * row.ms / totalMs).toFixed(1).padStart(5)}%  ${String(row.assertions).padStart(4)}a ` +
    `${(1000 * row.assertions / Math.max(row.ms, 1)).toFixed(1).padStart(6)}a/s  ${row.name}\n`);
}

if (claimTimings.length) {
  const claimTotal = claimTimings.reduce((sum, row) => sum + row.ms, 0);
  process.stdout.write(`slowest claims inside merged gates (${claimTimings.length} claims, ` +
    `${(claimTotal / 1000).toFixed(1)}s):\n`);
  for (const row of [...claimTimings].sort((a, b) => b.ms - a.ms).slice(0, Number(process.env.SLOWEST ?? 12))) {
    process.stdout.write(`  ${(row.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${(100 * row.ms / totalMs).toFixed(1).padStart(5)}%  ${row.name.replace(/^gate/, "")}\n`);
  }
}

// Counted over the gates that actually RAN. Subtracting failures from the whole table
// made a filtered run read like a fuller verdict than it was: fifteen failures out of
// fifteen selected printed as "63/78", which is the score of a run that never happened.
process.stdout.write(
  `SUMMARY: ${failures === 0 ? "PASS" : "FAIL"} (${selected.length - failures}/${selected.length} gates run` +
    `${selected.length === gates.length ? "" : `, ${gates.length} in the suite`})\n`,
);
if (failures) process.exitCode = 1;
