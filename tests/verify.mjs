#!/usr/bin/env node

import assert from "node:assert/strict";
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
  handoffCompaction: "Acme context handed the prefix off losslessly instead of compacting it",
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

const NO_FRESH_TAIL = Object.freeze({ ...context.DEFAULT_THRESHOLDS, freshTail: 1e-9 });

/** A fresh tail wide enough that the newest turns are unfoldable at fixture scale. */
const WIDE_FRESH_TAIL = Object.freeze({ ...context.DEFAULT_THRESHOLDS, freshTail: 0.10 });

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
  // Which tool the fixture's batches call. Every completed batch is auto-foldable now,
  // so this changes what the ladder is being shown, not whether it may act.
  toolName = "read",
  resultChars = 10_000,
  chapterChars = 0,
  mentionToolName = false,
  peekTurns = [],
  peekTargetId = "fold_probe",
  resultTail = null,
  readArguments = null,
  turnText = null,
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
    ...(thresholds ? { thresholds } : {}),
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
  commandNames,
  summarizeContextSpan,
  initialEntries,
  blacklistAutoFoldTools,
  thresholds,
  guidance,
  retiredOptions,
  summarizer,
  removedOptions,
  registerEvidence = false,
  providerInputBudget,
  loadHostModule,
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
    sendMessage(message, options) { steered.push({ message, options }); },
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
    ...(summarizeContextSpan ? { summarizeContextSpan } : {}),
    ...(blacklistAutoFoldTools ? { blacklistAutoFoldTools } : {}),
    ...(thresholds ? { thresholds } : {}),
    ...(guidance ? { guidance } : {}),
    ...(retiredOptions ?? {}),
    ...(summarizer === undefined ? {} : { summarizer }),
    // Deleted options, forwarded verbatim so gate 68 can prove they are REFUSED.
    ...(removedOptions ?? {}),
    ...(providerInputBudget === undefined ? {} : { providerInputBudget }),
  };
  if (packageRegistration) {
    runtime.registration = piFold.registerPiFold(pi, registrationOptions, loadHostModule);
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
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
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
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
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

/**
 * The forest as the snap sees it, plus the stalest turn nothing has folded yet.
 *
 * One selection law means automation folds and consolidates on its own schedule, so a
 * fixed turn index is not a span the agent can still fold: by the second commit it may
 * already be inside a consolidation. The crossing-span gates ask the forest instead.
 */
function foldableSpan(runtime, built, contextWindow = 100_000) {
  const state = materialized(runtime);
  const snapshot = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow,
  });
  const roots = context.orderedRoots(state, snapshot);
  const indexOf = new Map(snapshot.mapped.flatMap((item, index) => item.ref ? [[item.ref.entryId, index]] : []));
  const covered = (index) => roots.some((root) => index >= root.start && index <= root.end);
  const turn = built.turnEntries.find((entries) => {
    const indices = entries.map((id) => indexOf.get(id) ?? -1);
    return indices.every((index) => index >= 0 && !covered(index));
  });
  return { state, snapshot, roots, indexOf, covered, turn };
}

/**
 * A span that starts strictly inside one root fold and ends outside every fold, and that
 * the snap can actually correct.
 *
 * The constructibility test is not decoration. Under the count law a parent can span ten
 * children plus their gaps, and absorbing one of those into a CHAPTER reading exceeds the
 * few-turn chapter limit, so which crossing has a corrected reading is a property of the
 * forest the ladder happened to build. The gate is about the correction being reported by
 * name, so the span it asks about is searched for rather than assumed. A forest where NO
 * crossing is constructible returns null and the caller says so.
 */
function crossingSpan(runtime, built, contextWindow = 100_000) {
  const { state, snapshot, roots, covered } = foldableSpan(runtime, built, contextWindow);
  for (const root of roots) {
    for (let inside = root.start + 1; inside <= root.end; inside += 1) {
      if (!snapshot.mapped[inside]?.ref) continue;
      for (let after = root.end + 1; after < snapshot.mapped.length; after += 1) {
        if (!snapshot.mapped[after]?.ref || covered(after)) continue;
        const ids = [snapshot.mapped[inside].ref.entryId, snapshot.mapped[after].ref.entryId];
        try { context.snapFoldCandidate(snapshot, state, ids, { allowProtected: true }); }
        catch { continue; }
        return { root, ids };
      }
    }
  }
  return null;
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
  assert.deepEqual([...defaults.commands.keys()].sort(), ["fold-context", "pi-fold-context"]);
  await startRuntime(defaults);

  const custom = makeRuntime(makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }), {
    toolName: "ctx_tool",
    entryTypePrefix: "custom-context",
    commandNames: { status: "sandbox-context", fold: "sandbox-fold-context" },
  });
  assert.deepEqual([...custom.tools.keys()], ["ctx_tool"]);
  assert.deepEqual([...custom.commands.keys()].sort(), ["sandbox-context", "sandbox-fold-context"]);
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
  assert.deepEqual([...named.commands.keys()].sort(), ["context", "fold-context"]);
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
  assert.deepEqual(surface.commands, ["fold-context", "pi-fold-context"]);
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
  assert.equal(
    surface.handoffCompaction,
    "pi-fold context handed the prefix off losslessly instead of compacting it",
  );
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
  assert.equal(surface.handoffCompaction, fixture.handoffCompaction);
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
    policy: { minToolChars: 100 },
    thresholds: NO_FRESH_TAIL,
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
    assert(new RegExp(`limit is ${context.ACTIVE_CONTEXT_POLICY.maxBriefChars}`).test(error.message),
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
  assert.equal(crossingCommits[0].trigger, "compaction-boundary");
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
    summarizeContextSpan: MODEL_BRIEF,
  });
  await startRuntime(runtime);
  const loaded = materialized(runtime);
  assert.equal(loaded.folds[0].provenance.kind, "luna");
  const slate = context.projectionSlateCandidates(loaded, built.snapshot);
  assert.equal(slate.find((item) => item.source_id === legacyFold.id).generator, "projection-model");
  const next = context.selectAutomaticToolBatch(built.snapshot, loaded)[0];
  assert(next, "Legacy fixture lacked a second tool fold for round-trip persistence");
  const response = await runtime.tools.get("pi_fold_context").execute(
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
  const status = await toolStatus(runtime);
  assert(status.details.eligibleChapter, "Chapter-only fixture has no eligible chapter");
  const action = structuredClone(status.details.eligibleChapter.action);
  delete action.brief;
  const response = await runtime.tools.get("pi_fold_context").execute(
    "poisoned-floor",
    action,
    new AbortController().signal,
    undefined,
    runtime.ctx,
  );
  assert.equal(response.details.kind, "chapter");
  assert.equal(response.details.provenance.kind, "deterministic");
  assert(response.details.brief.length > 20 && response.details.brief.length <= 1_200);
  assert(!/pi_fold_context/i.test(response.details.brief));
  // The floor under test is a BRIEF floor, and a brief is fixed at the decision. Under
  // the epoch that decision is a mark, so the floor is read there first and then read
  // again off the fold the commit applies: the same bytes have to survive both.
  const marked = materialized(runtime).pendingMarks.at(-1);
  assert.equal(marked.kind, "chapter");
  assert.equal(marked.briefProvenance.kind, "deterministic");
  assert.equal(marked.brief, response.details.brief);
  const committed = await measureAndCommit(runtime, 86_000, 100_000, "poisoned-floor-commit");
  const folded = committed.folds.find((fold) => fold.id === marked.id);
  assert(folded, "The floor-checked mark never became a fold");
  assert.equal(folded.kind, "chapter");
  assert.equal(folded.brief, response.details.brief);
  assert.equal(folded.provenance.kind, "deterministic");
  return {
    marked: true,
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
  assert.equal(manual, undefined);
  // An overflow Pi will RETRY is the rollback lane's, and it always cancels: the runtime
  // moves the branch back past the request the provider refused rather than compacting.
  const overflow = await hook({
    reason: "overflow", willRetry: true, branchEntries: runtime.branch,
  }, runtime.ctx);
  assert.deepEqual(overflow, { cancel: true });
  // A THRESHOLD BOUNDARY IS ANSWERED BY WHAT IT COULD HAND OFF. A three-turn tool-free
  // window has nothing eligible, so the runtime lets Pi compact rather than cancelling a
  // compaction and leaving the window exactly as crowded as it found it. The same hook
  // on a window with foldable mass cancels, which is what gate 03 reads.
  const barren = await hook({ reason: "threshold" }, runtime.ctx);
  assert.equal(barren, undefined);
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
    thresholdWithNothingToHandOff: "pass-through",
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

async function gateDoorlessMarking() {
  // Gate 11 was the tool-fold cadence: a second scheduler, blind to occupancy, that
  // decided WHEN automation could mark a tool batch. It is deleted with its two
  // constants. Marking is doorless in the stale zone now: any pass may mark eligible
  // stale material, a mark moves no projection byte, and the only cap is the pending
  // bound. What decides when bytes move is the one commit trigger, and nothing else.
  const built = makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);

  // Three quiet passes, all far below the band top (0.80 of the 90,000-token budget is
  // 72,000 tokens). Marks accumulate on every one of them and no byte moves.
  const marksAfter = async (tokens) => {
    await measure(runtime, tokens, 100_000);
    const state = materialized(runtime);
    return { marks: (state.pendingMarks ?? []).length, folds: state.folds.length, state };
  };
  const first = await marksAfter(10_000);
  assert.equal(first.folds, 0);
  const second = await marksAfter(20_000);
  assert.equal(second.folds, 0, "A quiet pass folded");
  const third = await marksAfter(40_000);
  assert.equal(third.folds, 0, "A quiet pass folded");
  assert(third.marks >= second.marks && second.marks >= first.marks,
    "Marking went backwards below the band top");
  assert(third.marks > 0, "No pass below the band top marked anything");
  assert(third.state.pendingMarks.some((mark) => mark.kind === "tool-result" && mark.origin === "ladder"),
    "The doorless path never marked a completed tool batch");
  assert(third.state.pendingMarks.every((mark) => mark.origin === "ladder"),
    "A mark below the band top came from somewhere other than the ladder");
  // The stalest batch first: the law walks forward, it does not re-propose.
  const firstMark = third.state.pendingMarks.find((mark) => mark.kind === "tool-result");
  assert.deepEqual(firstMark.parts.map((part) => part.ref.entryId), [built.turnEntries[0][2]]);
  const markIds = third.state.pendingMarks.map((mark) => mark.id);
  assert.equal(new Set(markIds).size, markIds.length, "The doorless path proposed a span twice");
  assert(markIds.length <= context.MAX_PENDING_MARKS);

  // The projection has not moved through any of it: marks are decisions, not edits.
  assert.equal(runtime.appended.filter((entry) =>
    entry.customType === context.ACTIVE_CONTEXT_FOLD_RECORD_ENTRY).length, 0,
    "A mark wrote a fold record before any commit");

  // Crossing the band top applies them, in one rewrite, and the ids are unchanged: a
  // fold id derives from its marked span, so finding them IS the assertion that the
  // spans survived the wait intact.
  const beforeCommit = runtime.appended.length;
  const committed = await measureAndCommit(runtime, 86_500, 100_000, "band-top-commit");
  // THE RECEIPT TRAIL. Every accumulated mark is accounted for by id, three ways and no
  // fourth: applied as a fold under the id it was made with, still standing because the
  // commit found it ineligible, or absorbed -- wedge absorption grows a mark backward to
  // swallow a sliver, and a mark's id is derived from its span, so growing the span
  // mints a new id. The absorb record carries both ends of that rename, so the decision
  // the ladder made is followable to the fold that ended up holding it.
  const absorbs = contextEvents(runtime, beforeCommit)
    .filter((record) => record.kind === "context.absorb");
  const absorbedFrom = new Map(absorbs.map((record) => [record.from_mark_id, record.into_fold_id]));
  const stillPending = new Set((committed.pendingMarks ?? []).map((mark) => mark.id));
  for (const id of markIds) {
    if (committed.folds.some((fold) => fold.id === id) || stillPending.has(id)) continue;
    const renamed = absorbedFrom.get(id);
    assert(renamed,
      `A mark accumulated below the band top was neither applied, retained nor absorbed: ${id}`);
    assert(committed.folds.some((fold) => fold.id === renamed) || stillPending.has(renamed),
      `An absorbed mark's grown id ${renamed} leads nowhere`);
  }
  for (const record of absorbs) {
    assert.notEqual(record.from_mark_id, record.into_fold_id,
      "An absorb record reported a rename that renamed nothing");
    assert(record.entries >= 1 && record.tokens >= 0);
    assert(record.tokens <= record.threshold_tokens,
      "An absorption swallowed a gap above the wedge threshold");
  }
  assert(committed.folds.some((fold) => fold.id === firstMark.id),
    "The stalest accumulated tool batch never became a fold");
  assert(committed.folds.length >= 1);
  assert.equal(committed.tokensSinceToolFold, 0,
    "The applied fold did not reset the persisted counter");

  // The counter is still durable state on the wire; it just no longer gates anything.
  await measure(runtime, 89_000, 100_000);
  assert.equal(materialized(runtime).tokensSinceToolFold, 2_500);
  const reloaded = makeRuntime(
    { ...built, messages: runtime.messages },
    { initialEntries: runtime.branch },
  );
  await startRuntime(reloaded);
  assert.equal(materialized(reloaded).tokensSinceToolFold, 2_500);
  return {
    quietPassMarks: [first.marks, second.marks, third.marks],
    quietPassFolds: 0,
    foldRecordsBeforeCommit: 0,
    accumulatedBeforeCrossing: markIds.length,
    absorbedRenames: absorbs.length,
    appliedAtCrossing: committed.folds.length,
    pendingCap: context.MAX_PENDING_MARKS,
    reloadedCounter: materialized(reloaded).tokensSinceToolFold,
  };
}

async function gateExpandLeases() {
  const built = makeFixture({ turns: 4, resultChars: 10_000, contextWindow: 100_000 });
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  await measure(runtime, 10_000, 100_000);
  await measure(runtime, 40_000, 100_000);
  // The ladder marked; the lease this gate is about only exists once a commit has
  // turned that mark into a fold, so the epoch is driven to its commit first.
  await measureAndCommit(runtime, 85_000, 100_000, "lease-commit");
  const foldId = materialized(runtime).folds[0].id;
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
  const boundedRuntime = makeRuntime(wide, { initialEntries: [
    ...wide.entries,
    stateEntry(wide.sessionId, wide.state, "lease-bound-state", wide.entries.at(-1).id),
  ] });
  await startRuntime(boundedRuntime);
  const rootIds = wide.state.folds.filter((fold) => fold.parentId === null).map((fold) => fold.id);
  for (const id of rootIds) {
    await boundedRuntime.tools.get("pi_fold_context").execute(
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
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
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
    thresholds: { ...NO_FRESH_TAIL, consolidateAfter: deepWidth },
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
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxChapterChars,
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
    brief: `A factual but deliberately non-shrinking consolidation ${"x".repeat(1_100)}`,
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
  const chapterBuilt = makeFixture({
    turns: 8,
    tools: false,
    chapterChars: 3_500,
    contextWindow: 100_000,
  });
  let summaryCalls = 0;
  const summarize = async (request) => {
    if (!isBriefUpgradeRequest(request)) summaryCalls += 1;
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
  const warmedId = warmState.prepared.id;
  await measureAndCommit(warm, narrowFenceTokens, 100_000, "warm-fence-commit");
  warmState = materialized(warm);
  // The warmed chapter lands through the commit like every other fold. The commit is
  // free to carry more marks than the one that was warmed; what it may not do is leave
  // the warmed one behind, which is the model call this arm paid for.
  const warmChapters = warmState.folds.filter((fold) => fold.kind === "chapter");
  assert(warmChapters.length >= 1, "The fence commit folded no chapter");
  assert(warmChapters.some((fold) => fold.id === warmedId),
    "The warmed preparation never reached the window");
  assert.equal(warmChapters.find((fold) => fold.id === warmedId).provenance.kind, "model");

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
  // Below the commit threshold the quiet runtime MARKS rather than folds, so the
  // priority shows in what was marked: the deterministic tool batch, never a warm
  // chapter preparation. The commit that follows folds exactly that.
  const toolMarks = context.pendingMarks(materialized(toolRuntime));
  assert(toolMarks.length >= 1, "The stale tool batch was neither marked nor folded");
  assert(toolMarks.every((mark) => mark.kind === "tool-result"),
    JSON.stringify(toolMarks.map((mark) => mark.kind)));
  await measureAndCommit(toolRuntime, 88_000, 100_000, "tool-priority-commit");
  assert.equal(materialized(toolRuntime).folds[0].kind, "tool-result",
    "The deterministic tool batch lost its priority over a warmed chapter");

  const floor = makeRuntime(chapterBuilt);
  await startRuntime(floor);
  await measure(floor, 60_000, 100_000);
  assert.equal(materialized(floor).prepared, undefined);
  await measureAndCommit(floor, narrowFenceTokens, 100_000, "floor-fence-commit");
  const floorState = materialized(floor);
  const floorChapters = floorState.folds.filter((fold) => fold.kind === "chapter");
  assert(floorChapters.length >= 1, "The no-summarizer fence commit folded no chapter");
  assert(floorChapters.every((fold) => fold.provenance.kind === "deterministic"));

  let fenceCalls = 0;
  const fence = makeRuntime(chapterBuilt, {
    summarizeContextSpan: async (request) => {
      if (!isBriefUpgradeRequest(request)) fenceCalls += 1;
      return MODEL_BRIEF();
    },
  });
  await startRuntime(fence);
  const fenceTokens = narrowFenceTokens;
  await measureAndCommit(fence, fenceTokens, 100_000, "summarizer-fence-commit");
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
  // The tool rung has no door of its own any more, so it wins every automatic
  // selection ahead of chapter preparation. In a TOOL-BEARING session that means warm
  // model briefs never start and the commit's chapters COMMIT deterministic. The brief
  // quality that costs is bought back after the fact: the upgrade lane briefs those
  // folds between boundaries and the model brief rides the next commit (gate 107). So
  // the count here is preparations, which is what the scheduling claim is about.
  let toolBearingWarmCalls = 0;
  const toolBearing = makeRuntime(
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: 100_000 }),
    {
      summarizeContextSpan: async (request) => {
        if (!isBriefUpgradeRequest(request)) toolBearingWarmCalls += 1;
        return { brief: "A model brief that a tool-bearing session never asks for." };
      },
    },
  );
  await startRuntime(toolBearing);
  await measure(toolBearing, 50_000, 100_000);
  await measure(toolBearing, 60_000, 100_000);
  const toolCommitted = await measureAndCommit(toolBearing, 86_000, 100_000, "tool-commit");
  assert.equal(toolBearingWarmCalls, 0,
    "A tool-bearing session started a warm preparation the tool rung outranks");
  assert(toolCommitted.folds.length >= 1, "The tool-bearing commit folded nothing");
  assert(toolCommitted.folds.every((fold) => context.foldProvenance(fold, materialized(toolBearing)).kind === "deterministic"),
    `A tool-bearing commit produced a non-deterministic brief: ${JSON.stringify(
      toolCommitted.folds.map((fold) => fold.provenance.kind))}`);

  // THE WARM PATH STILL RUNS, and here is the fixture that keeps it pinned. With no
  // tool results there is no tool rung to outrank the chapter, so preparation warms,
  // the model brief is asked for, and the commit carries it.
  let noToolWarmCalls = 0;
  const noTool = makeRuntime(
    makeFixture({ turns: 8, tools: false, chapterChars: 3_500, contextWindow: 100_000 }),
    {
      summarizeContextSpan: async () => {
        noToolWarmCalls += 1;
        return {
          brief: "The exact completed chapter records its factual result and stays recoverable.",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          effort: "medium",
          toolCalls: 0,
        };
      },
    },
  );
  await startRuntime(noTool);
  await measure(noTool, 60_000, 100_000);
  await settle(8);
  const noToolCommitted = await measureAndCommit(noTool, 86_000, 100_000, "warm-commit");
  assert(noToolWarmCalls >= 1, "The warm preparation never started in a session with no tool rung");
  assert(noToolCommitted.folds.length >= 1, "The warm commit folded nothing");
  assert(noToolCommitted.folds.some((fold) => fold.provenance.kind === "model"),
    `The warm path produced no model brief: ${JSON.stringify(
      noToolCommitted.folds.map((fold) => fold.provenance.kind))}`);
  return {
    toolCallListener: "absent",
    blockingToolsOption: "refused",
    revisionMovedByToolCall: false,
    toolBearingWarmCalls,
    toolBearingBriefs: "deterministic",
    noToolWarmCalls,
    noToolModelBriefs: noToolCommitted.folds.filter((fold) =>
      fold.provenance.kind === "model").length,
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

async function gateFreshTailShareCap() {
  // One fixture shape, two windows, one rule. The protected tail used to be a fixed
  // 24,000-byte floor with a separate small-window cap at a quarter of the window; it is
  // now `freshTail` of the SERVING BUDGET, converted once at the estimator's 4 bytes per
  // token, so the tail scales with the budget instead of meeting a floor. At the
  // reference deployment the two agree within rounding (24,000 bytes was 6,000 tokens of
  // a 383,616-token budget, 1.56%, and freshTail is 0.02); at fixture scale the
  // proportion is what binds.
  const tailBytesFor = (window) => context.zoneBytes(
    context.DEFAULT_THRESHOLDS.freshTail, context.servingBudgetTokens(window),
  );
  const shape = { turns: 6, resultChars: 2_200 };
  const small = makeRuntime(makeFixture({ ...shape, contextWindow: 30_000 }));
  await startRuntime(small);
  const smallDetail = (await toolStatus(small, undefined, "fold_candidates")).details;
  assert.equal(smallDetail.rawTailMinimumBytes, tailBytesFor(30_000));
  assert.equal(smallDetail.rawTailMinimumBytes, 2_160);

  const wide = makeRuntime(makeFixture({ ...shape, contextWindow: 272_000 }));
  await startRuntime(wide);
  const wideDetail = (await toolStatus(wide, undefined, "fold_candidates")).details;
  assert.equal(wideDetail.rawTailMinimumBytes, tailBytesFor(272_000));
  assert.equal(wideDetail.rawTailMinimumBytes, 20_449);
  // The object list lives behind its own paged query now that the index is dieted.
  const smallObjects = (await toolStatus(small, undefined, "objects")).details.objects;
  const wideObjects = (await toolStatus(wide, undefined, "objects")).details.objects;

  // Behavioral: identical content, small budget → the older turns fall outside the
  // proportional tail and form an eligible chapter; wide budget → the tail covers the
  // whole projection and nothing is foldable.
  const smallFree = smallObjects.filter((object) => !object.protected).length;
  const wideFree = wideObjects.filter((object) => !object.protected).length;
  assert(smallFree > 0, "small budget must free the oldest turns");
  assert.equal(wideFree, 0, "wide budget tail must keep this projection fully protected");
  assert.notEqual(smallDetail.candidates.chapter, null, "small budget must expose an eligible chapter");
  assert.equal(wideDetail.candidates.chapter, null, "wide budget must expose no chapter");

  // An undeclared window falls back to the default, and the tail is that budget's share.
  const fallback = makeRuntime(makeFixture({ ...shape, contextWindow: 0 }));
  await startRuntime(fallback);
  const fallbackDetail = (await toolStatus(fallback, undefined, "fold_candidates")).details;
  assert.equal(fallbackDetail.rawTailMinimumBytes, tailBytesFor(context.DEFAULT_CONTEXT_WINDOW));

  // A window too small to carry the policy is REFUSED at registration, never clamped.
  assert.throws(
    () => makeRuntime(makeFixture({ ...shape, contextWindow: 16_000 }),
      { providerInputBudget: 14_400 }),
    /below the 500-token minimum one foldable unit needs/,
  );
  assert.throws(
    () => makeRuntime(makeFixture({ ...shape, contextWindow: 10_000 }),
      { providerInputBudget: 9_000 }),
    /below the 10000-token minimum this package supports/,
  );
  return {
    smallWindowTailBytes: smallDetail.rawTailMinimumBytes,
    wideWindowTailBytes: wideDetail.rawTailMinimumBytes,
    smallWindowFreedObjects: smallFree,
    wideWindowFreedObjects: wideFree,
    fallbackTailBytes: fallbackDetail.rawTailMinimumBytes,
    tinyWindowRegistration: "refused",
  };
}

/**
 * Evidence ingestion is UNCONDITIONAL, and no option reaches it.
 *
 * It shipped as a switch through the six-option surface, defaulting on. The switch was the
 * only public way to keep the folds and drop what makes them lossless: the 0444 artifacts
 * are the exact-recovery anchors an oversized tool result folds against, so a deployment
 * that turned ingestion off kept placeholders whose sources it could no longer produce.
 * Nothing else about the mechanism moved: the same hook, the same read-only mode, the same
 * 512 MB session cap, now constants rather than a choice.
 */
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
  let preparationCompletions = 0;
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
              if (completionCalls > 1) return { role: "assistant", content: [{ type: "text", text: "A later lane's brief." }] };
              preparationCompletions += 1;
              completionRequest = structuredClone({ model, request, options: {
                // Carried only when the caller set one, so the gate below can assert its
                // ABSENCE rather than its value: a key that is always present with an
                // undefined value would make "no ceiling was sent" untestable.
                ...("maxTokens" in options ? { maxTokens: options.maxTokens } : {}),
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
  // One completion per brief. The host fake cannot see which lane asked, and the upgrade
  // lane briefs the folds this same commit landed deterministic, so the pin is on the
  // preparation being FIRST and on the total staying inside the upgrade queue bound.
  assert.equal(preparationCompletions, 1);
  assert(completionCalls <= 1 + context.MAX_BRIEF_UPGRADE_QUEUE,
    `The summarizer was called ${completionCalls} times for one brief`);
  assert.equal(completionRequest.model.provider, sessionModel.provider);
  assert.equal(completionRequest.model.id, sessionModel.id);
  assert.equal(completionRequest.request.messages.length, 1);
  assert.equal(completionRequest.request.messages[0].role, "user");
  // The prompt the RUNTIME drives carries the same contract the direct call pins below:
  // the labelled span, both orientation labels, and the two purposes. The runtime supplies
  // the orientation slices from its own bounded computation, so whether a slice is present
  // or empty is the runtime's business; the labels are always there to be filled.
  const runtimeBriefPrompt = completionRequest.request.messages[0].content;
  for (const clause of [
    // Read from the policy rather than typed, so the gate pins that the cap REACHES the
    // model rather than pinning one particular cap.
    `Write a factual brief of at most ${context.ACTIVE_CONTEXT_POLICY.maxBriefChars} ` +
      "characters covering the SPAN TO BRIEF below",
    "expanding or peeking this fold later",
    "BEFORE THE SPAN (orientation only, do not brief)",
    "SPAN TO BRIEF:",
    "AFTER THE SPAN (orientation only, do not brief)",
    "Use no preamble and no Markdown headers.",
  ]) {
    assert(runtimeBriefPrompt.includes(clause),
      `the runtime-driven brief request lost "${clause}"`);
  }
  // NO token ceiling reaches the provider. maxTokens does not ask a model to be brief,
  // it cuts it off mid-answer, and a reasoning generator draws its thinking from the same
  // budget: the 2026-08-11 rep lost 22 percent of its calls to "Summarizer returned no
  // text" that way. Length is bounded by the stated limit, the cure, and the timeout.
  assert.equal("maxTokens" in completionRequest.options, false,
    "a token ceiling reached the provider: it truncates the answer instead of shortening it");
  assert.equal(completionRequest.options.signalIdentical, true);
  assert.equal(completionRequest.options.reasoning, "max");

  // "deterministic" was a public VALUE through the six-option surface, and it is refused
  // now: it named the failure path as though it were a third generator to choose between,
  // when every summarizer failure already falls back to exactly that brief. The refusal
  // says so rather than reporting a shape error, so a deployment holding the value learns
  // it lost nothing.
  for (const alongside of [{}, { providerInputBudget: 90_000 }]) {
    assert.throws(
      () => makeRuntime(built, { packageRegistration: true, ...alongside, summarizer: "deterministic" }),
      /summarizer has no "deterministic" value: the deterministic brief is the automatic fallback/,
      "summarizer: \"deterministic\" survived as a selectable mode",
    );
  }
  // The GENERATOR is untouched, and the seam that reaches it is the one the experiment
  // extension uses: register the runtime directly, wire no brief generator, and every
  // chapter brief is deterministic with no host module in the picture at all.
  const unwired = makeRuntime(built);
  await startRuntime(unwired);
  await measure(unwired, fenceTokens, 100_000);
  assert.equal(
    materialized(unwired).folds.find((fold) => fold.kind === "chapter")?.provenance.kind,
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
  // Both lanes meet the same broken generator: the preparation falls back, and the
  // upgrade lane finds the deterministic fold and fails on it once too. What the gate
  // pins is that a failure is a fallback rather than a retry loop.
  assert(failureCompletionCalls >= 1 && failureCompletionCalls <= 1 + context.MAX_BRIEF_UPGRADE_QUEUE,
    `A failing summarizer was called ${failureCompletionCalls} times`);
  const failureState = materialized(failure);
  const failureChapter = failureState.folds.find((fold) => fold.kind === "chapter");
  assert.equal(context.foldProvenance(failureChapter, failureState).kind, "deterministic");

  // `summarizeContextSpan` left the PUBLIC surface. It is the runtime's INTERNAL
  // brief-generator interface, and `summarizer` is the declarative way to choose one, so
  // the package refuses the name rather than forwarding a callback the summarizer choice
  // would overwrite. Refused whether or not a summarizer accompanies it.
  for (const alongside of [{ summarizer: "session" }, {}]) {
    assert.throws(() => makeRuntime(built, {
      packageRegistration: true,
      ...alongside,
      summarizeContextSpan: MODEL_BRIEF,
    }), /summarizeContextSpan is no longer an option/);
  }
  assert.throws(() => makeRuntime(built, {
    packageRegistration: true,
    summarizer: { provider: "fake-session" },
  }), /nonempty provider and model strings/);
  assert.throws(() => makeRuntime(built, {
    packageRegistration: true,
    summarizer: { model: "brief-model" },
  }), /nonempty provider and model strings/);

  // The seam itself still works, reached where it now lives: registerActiveContext takes
  // the generator directly, and a brief it produces is attributed to the model.
  const escape = makeRuntime(built, { summarizeContextSpan: MODEL_BRIEF });
  await startRuntime(escape);
  await measure(escape, fenceTokens, 100_000);
  assert.equal(
    materialized(escape).folds.find((fold) => fold.kind === "chapter")?.provenance.kind,
    "model",
  );

  let registryLoaderCalls = 0;
  let registryCreateCalls = 0;
  const registryCompletionOptions = [];
  const registryPrompts = [];
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
            async completeSimple(_model, completion, options) {
              registryCompletionOptions.push(options);
              registryPrompts.push(completion.messages[0].content);
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
  assert(registryCompletionOptions.every((options) => !("maxTokens" in options)),
    "a token ceiling reached the provider through the registry path");
  assert(registryCompletionOptions.every((options) => options.reasoning === "low"));

  // The request IS the contract, so it is pinned as one. A brief does two jobs at once:
  // it summarizes the span, and it states what expanding or peeking that fold would give
  // back, which is the only basis the agent has for deciding to dig in again. The
  // orientation slices the runtime computes and hashes into the fold identity are labelled
  // distinctly, because a model that cannot tell the span from its surroundings briefs the
  // surroundings. Every clause below would be missing from a thin "summarize this" prompt.
  await explicit({
    sourceText: "SPAN BODY: rewrote createSummarizeContextSpan and reran the gate suite.",
    beforeText: "BEFORE BODY: the operator asked for a model-written brief.",
    afterText: "AFTER BODY: the suite reported ninety green gates.",
    maxBriefChars: 1_200,
    signal: new AbortController().signal,
  }, { thinkingLevel: "max" });
  const oriented = registryPrompts.at(-1);
  assert(oriented.startsWith("Write a factual brief of at most 1200 characters covering the " +
    "SPAN TO BRIEF below, and nothing else."), oriented);
  for (const clause of [
    "it summarizes what the span contains, and it tells an agent what it would get back " +
    "by expanding or peeking this fold later",
    "the brief is its only visible trace",
    "name the concrete things inside it: files, identifiers, decisions, results, errors",
    "Do not describe the span abstractly.",
    "their content is not part of what you are briefing",
    "Use no preamble and no Markdown headers.",
  ]) {
    assert(oriented.includes(clause), `the brief request lost "${clause}"`);
  }
  const beforeSection = oriented.indexOf(
    "BEFORE THE SPAN (orientation only, do not brief):\nBEFORE BODY: the operator asked");
  const spanSection = oriented.indexOf(
    "SPAN TO BRIEF:\nSPAN BODY: rewrote createSummarizeContextSpan");
  const afterSection = oriented.indexOf(
    "AFTER THE SPAN (orientation only, do not brief):\nAFTER BODY: the suite reported");
  assert(beforeSection > 0 && spanSection > beforeSection && afterSection > spanSection,
    `the three sections must be distinctly labelled and in conversation order: ${oriented}`);

  // Empty orientation is the runtime's own literal for "no slice on this side". Pasted in
  // raw it reads as content, so it becomes a stated absence instead.
  await explicit({
    sourceText: "SPAN BODY: a span with nothing either side of it.",
    beforeText: "[]",
    afterText: "[]",
    maxBriefChars: 1_200,
    signal: new AbortController().signal,
  }, { thinkingLevel: "max" });
  const unoriented = registryPrompts.at(-1);
  assert(unoriented.includes("BEFORE THE SPAN (orientation only, do not brief): none.") &&
    unoriented.includes("AFTER THE SPAN (orientation only, do not brief): none.") &&
    !unoriented.includes("[]"),
  `empty orientation must read as an absence, never as content: ${unoriented}`);

  return {
    default: modelFold.provenance,
    toolCalls: 0,
    hostLoads: loaderCalls,
    runtimeCreates: createCalls,
    deterministicValue: "refused",
    unwiredSeamBriefs: "deterministic",
    failureFallback: "deterministic",
    publicSurfaceRefusals: 3,
    malformedObjects: "rejected",
    customCallback: "internal-seam",
    explicitRegistryRuntimeCreates: registryCreateCalls,
    briefRequestSections: ["instruction", "before", "span", "after"],
    briefRequestPurposes: ["summary", "what-expand-or-peek-returns"],
    emptyOrientation: "stated-absence",
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
    policy: { minToolChars: 100 },
    thresholds: NO_FRESH_TAIL,
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
    bytes: Math.min(bounded.sourceBytes, context.ACTIVE_CONTEXT_POLICY.maxChapterChars),
  });
  assert(bounded.truncationReminder.startsWith("STOP:"));
  assert(bounded.truncationReminder.includes(String(bounded.omittedBytes)));
  assert(bounded.truncationReminder.includes("the head and tail are both above"));
  assert.equal(Object.keys(bounded).indexOf("truncationReminder"), Object.keys(bounded).length - 1);
  assert(Object.keys(bounded).indexOf("source") === Object.keys(bounded).length - 2);
  assert.equal(peek.details.wider, undefined);
  assert.equal(peek.details.truncationReminder, undefined);

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
 * The surfacing fixture, built so both channels can be steered independently.
 *
 * Three folds. GOLD holds the answer in its stored content and says nothing about it in
 * its brief: the content-hit brief-miss case this mechanism exists for. VISIBLE holds
 * the same subject AND names it in the brief, so the agent can already see it from the
 * placeholder and surfacing it would repeat the window back to itself. OFF-TOPIC is
 * neither. The intent query names the subject the way an agent would.
 */
const SURFACING_INTENT =
  "Reconcile the tachyon ledger dispute: which replay settled the disputed reconciler entry?";
const SURFACING_SUBJECT =
  "the tachyon reconciler settled every disputed ledger entry by replaying it";
const SURFACING_FOLD_BRIEFS = [
  // GOLD: a true, factual brief that happens to name none of the subject's terms.
  "Completed unit from the middle of the run; source remains exactly recoverable.",
  // VISIBLE: the brief says exactly what the fold holds.
  `Notes on ${SURFACING_SUBJECT}, the disputed reconciler entry and its replay.`,
  // OFF-TOPIC.
  "Completed unit about unrelated packaging chores.",
];

async function surfacingForest() {
  const built = makeFixture({
    turns: 7,
    tools: false,
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
    contextWindow: 100_000,
    turnText: (turn) => turn <= 1
      ? `Working through ${SURFACING_SUBJECT}; the disputed reconciler entry replayed cleanly.`
      : "Packaging chores and unrelated bookkeeping.",
  });
  let state = context.emptyActiveContextState(built.sessionId);
  const ids = [];
  for (let turn = 0; turn < SURFACING_FOLD_BRIEFS.length; turn += 1) {
    const candidate = context.manualFoldCandidate(
      built.snapshot,
      state,
      [built.turnEntries[turn][0], built.turnEntries[turn].at(-1)],
    );
    const committed = await commitCandidate(state, built.snapshot, candidate, {
      brief: SURFACING_FOLD_BRIEFS[turn],
      now: turn + 1,
    });
    state = committed.state;
    ids.push(committed.prepared.fold.id);
  }
  // The QUERY is stated, not inherited: `messages` feeds the intent extractor and
  // `mapped` feeds the channels, so a fixture can steer one without touching the other.
  const snapshot = {
    ...built.snapshot,
    messages: [{ role: "user", content: [{ type: "text", text: SURFACING_INTENT }] }],
  };
  return { ...built, state, snapshot, gold: ids[0], visible: ids[1], offTopic: ids[2] };
}

/**
 * TWO CHANNELS, AND THE DIVERGENCE THAT TRIGGERS.
 *
 * The selector reads a fold twice: the brief the agent can already see, and the source
 * the placeholder is hiding. A suggestion is earned by the GAP, not by the score: a
 * fold whose brief already names what it holds is discoverable without help, so it is
 * not surfaced even when its content hits hardest. Everything is deterministic, so the
 * same forest against the same intent yields the same slate every pass.
 */
async function gateSurfacingChannels() {
  const source = await readFile(join(projectRoot, "extensions", "lib", "surfacing.ts"), "utf8");
  assert.equal(/Date\.now|Math\.random|new Date/.test(source), false,
    "The selector must be seedless: no wall clock and no randomness");

  const forest = await surfacingForest();
  const candidates = context.surfacingCandidates({
    state: forest.state, snapshot: forest.snapshot, toolName: "pi_fold_context",
  });
  assert.equal(candidates.length, 3);
  assert(candidates.every((candidate) => candidate.brief && candidate.content &&
    candidate.route.includes('"action":"peek"')));

  const queryTerms = context.distinctSurfacingTokens(context.surfacingIntentText(forest.snapshot));
  const index = context.buildSurfacingIndex(candidates.flatMap((candidate) => [
    { key: context.surfacingDocumentKey("brief", candidate.id), tokens: context.surfacingTokens(candidate.brief) },
    { key: context.surfacingDocumentKey("content", candidate.id), tokens: context.surfacingTokens(candidate.content) },
  ]));
  const ceiling = context.surfacingScoreCeiling(index, queryTerms);
  const scoreOf = (id) => ({
    content: context.normalizedBm25(index, context.surfacingDocumentKey("content", id), queryTerms, ceiling),
    brief: context.normalizedBm25(index, context.surfacingDocumentKey("brief", id), queryTerms, ceiling),
  });
  const gold = scoreOf(forest.gold);
  const visible = scoreOf(forest.visible);
  const offTopic = scoreOf(forest.offTopic);
  // Both channels are one scale, so the margin is a number rather than a coincidence.
  assert(gold.content >= context.SURFACING_CONTENT_HIT, "The gold fold's content did not hit");
  assert(gold.brief < context.SURFACING_BRIEF_HIT, "The gold fold's brief already said it");
  assert(visible.content >= context.SURFACING_CONTENT_HIT, "The visible fold's content did not hit");
  assert(visible.brief >= context.SURFACING_BRIEF_HIT, "The visible fold's brief did not read as a hit");
  assert(offTopic.content < context.SURFACING_CONTENT_HIT, "An off-topic fold cleared the content floor");

  const selection = context.selectSurfacingSlate({
    state: forest.state, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: 40,
  });
  assert.equal(selection.considered, 3);
  assert.deepEqual(selection.slate.map((suggestion) => suggestion.id), [forest.gold]);
  // The whole point, stated as an assertion: a brief-hit fold is NOT surfaced even
  // though its content hit, and the fold nobody could see from its placeholder is.
  assert.equal(selection.slate.some((suggestion) => suggestion.id === forest.visible), false,
    "A fold whose brief already names its content was surfaced anyway");
  assert.equal(selection.slate[0].margin,
    context.roundedScore(gold.content - gold.brief));
  assert(selection.slate[0].margin >= context.SURFACING_DIVERGENCE_MARGIN);

  const repeated = context.selectSurfacingSlate({
    state: forest.state, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: 40,
  });
  assert.equal(json.stableStringify(repeated.slate), json.stableStringify(selection.slate));

  // Intent is the query, and it is intent ONLY: a tool RESULT that screams the subject
  // must not pull the query toward itself, or every retrieval number is that defect.
  const noisy = {
    ...forest.snapshot,
    messages: [...forest.snapshot.messages, {
      role: "toolResult",
      toolCallId: "call-noise",
      toolName: "read",
      content: [{ type: "text", text: `${SURFACING_SUBJECT} `.repeat(200) }],
      isError: false,
    }],
  };
  assert.equal(context.surfacingIntentText(noisy).includes("tachyon"), true,
    "The user's own ask left the query");
  assert.equal(context.surfacingIntentText({ messages: [noisy.messages.at(-1)] }), "",
    "A tool result reached the intent query");
  // A tool CALL is intent: the name plus its first meaningful argument.
  assert.equal(context.surfacingIntentText({
    messages: [{
      role: "assistant",
      content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "reconciler.md" } }],
      stopReason: "toolUse",
    }],
  }), "read reconciler.md");
  return {
    candidates: candidates.length,
    goldScores: [gold.content, gold.brief],
    visibleScores: [visible.content, visible.brief],
    offTopicContent: offTopic.content,
    slate: selection.slate.map((suggestion) => suggestion.id),
    briefHitSuppressed: true,
    deterministic: true,
    intentOnly: true,
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
async function gateSurfacingSlateBounds() {
  assert.equal(context.SURFACING_SLATE_SIZE, 1);
  assert(context.SURFACING_BRIEF_HIT < context.SURFACING_CONTENT_HIT,
    "A brief hit at or above the content floor would surface nothing at all");
  assert(context.SURFACING_DIVERGENCE_MARGIN <= context.SURFACING_CONTENT_HIT - context.SURFACING_BRIEF_HIT ||
    context.SURFACING_DIVERGENCE_MARGIN > 0);

  const forest = await surfacingForest();
  // Two divergent folds, one delivery point, one suggestion.
  const rebriefed = { ...forest.state, briefs: { [forest.visible]: SURFACING_FOLD_BRIEFS[0] } };
  const wide = context.selectSurfacingSlate({
    state: rebriefed, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: 40,
  });
  assert.equal(wide.divergent, 2, "Both content-hit folds should have cleared the trigger");
  assert.equal(wide.slate.length, context.SURFACING_SLATE_SIZE);

  const line = context.surfacingSlateText({
    slate: wide.slate, queryTerms: wide.queryTerms, brandNoun: "Acme",
  });
  assert(line.includes(wide.slate[0].id) && line.includes('"action":"peek"'));
  assert(Buffer.byteLength(line, "utf8") <= context.MAX_SURFACING_LINE_BYTES,
    "The surfacing line exceeded its own bound");
  const huge = context.surfacingSlateText({
    slate: [{ ...wide.slate[0], content: "reconciler ".repeat(4_000) }],
    queryTerms: wide.queryTerms,
    brandNoun: "Acme",
  });
  assert(Buffer.byteLength(huge, "utf8") <= context.MAX_SURFACING_LINE_BYTES);
  assert.equal(context.surfacingSlateText({ slate: [], queryTerms: wide.queryTerms }), null);

  // The carrier bound and the line bound compose; neither eats the other.
  const carriers = {
    rider: context.contextRiderText({
      toolName: "pi_fold_context", brandNoun: "Acme", pendingAgentMarks: 2, eligibleMarks: 1,
      freedTokens: 900, eligibleFreedTokens: 400, anchors: ["a", "b", "c"],
      pinnedShare: 0.1, maxPinnedShare: 0.25, suggestion: line,
    }),
    lastCall: context.lastCallText({
      signals: { occupancy: 0.82, maxTarget: 0.8, budgetTokens: 90_000 },
      unmarked: { spans: 4, tokens: 2_000 }, pendingMarks: 2, toolName: "pi_fold_context",
      brandNoun: "Acme", suggestion: line,
    }),
  };
  assert(carriers.rider.endsWith(line) && carriers.lastCall.endsWith(line),
    "The slate line did not survive the carrier's own bound");
  assert(Buffer.byteLength(carriers.lastCall, "utf8") <=
    context.MAX_LAST_CALL_TEXT_BYTES + context.MAX_SURFACING_LINE_BYTES + 1);
  assert.equal(context.contextRiderText({
    toolName: "pi_fold_context", brandNoun: "Acme", pendingAgentMarks: 0, eligibleMarks: 0,
    freedTokens: 0, eligibleFreedTokens: 0, anchors: [], pinnedShare: 0, maxPinnedShare: 0.25,
  }).includes("surfacing"), false, "A silent pass still spent carrier bytes on surfacing");

  assert.equal(context.surfacingText, undefined, "The per-request surfacing carrier survived");
  assert.equal(context.DEFAULT_SURFACING_ENABLED, undefined, "The carrier's enable flag survived");
  return {
    slateSize: context.SURFACING_SLATE_SIZE,
    divergentCandidates: wide.divergent,
    lineBytes: Buffer.byteLength(line, "utf8"),
    lineBound: context.MAX_SURFACING_LINE_BYTES,
    carrierBytes: { rider: carriers.rider.length, lastCall: carriers.lastCall.length },
    silentPassCostsNothing: true,
    perRequestCarrier: "deleted",
  };
}

/**
 * THE SUPPRESSION LIFECYCLE.
 *
 * Trust is spent, not renewed: a fold offered and not taken is offered once more, and
 * then never again. The cooldown IS the outcome window, so nothing is re-offered before
 * its last offer has an answer, and the answer is graded acted, used or ignored.
 */
async function gateSurfacingSuppression() {
  const forest = await surfacingForest();
  const ordinal = 40;
  const first = context.issueSurfacing(forest.state, forest.gold, ordinal);
  assert.deepEqual(first.surfacing, [{
    id: forest.gold, surfaced: 1, taken: 0, ordinal, outcome: "shown",
  }]);
  // Cooldown: inside the window the same fold is not offered again, whatever it scores.
  assert.equal(context.surfacingSuppressed(first.surfacing, ordinal + 1).has(forest.gold), true);
  assert.equal(context.selectSurfacingSlate({
    state: first, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: ordinal + 1,
  }).slate.length, 0);
  assert.equal(context.surfacingSuppressed(first.surfacing,
    ordinal + context.SURFACING_OUTCOME_WINDOW_ORDINALS).has(forest.gold), false);

  // Window closed with no action: IGNORED, and the offer is spent.
  const closed = ordinal + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1;
  const ignoredOnce = context.resolveSurfacing({ state: first, snapshot: forest.snapshot, ordinal: closed });
  assert.deepEqual(ignoredOnce.transitions,
    [{ id: forest.gold, from: "shown", to: "ignored", ordinal: closed }]);
  assert.equal(ignoredOnce.state.surfacing[0].outcome, "ignored");
  const second = context.selectSurfacingSlate({
    state: ignoredOnce.state, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: closed,
  });
  assert.deepEqual(second.slate.map((suggestion) => suggestion.id), [forest.gold],
    "One ignore should not be a life sentence");

  // Ignored TWICE and the fold leaves the candidate set permanently: no cooldown to
  // wait out, no score high enough. memex's decline rule, and it wants zero takes.
  const reissued = context.issueSurfacing(ignoredOnce.state, forest.gold, closed);
  assert.equal(reissued.surfacing[0].surfaced, context.SURFACING_IGNORE_LIMIT);
  const twice = context.resolveSurfacing({
    state: reissued, snapshot: forest.snapshot,
    ordinal: closed + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1,
  });
  assert.equal(twice.state.surfacing[0].outcome, "ignored");
  assert.deepEqual([...context.surfacingSilenced(twice.state.surfacing)], [forest.gold]);
  for (const later of [closed + 100, closed + 10_000]) {
    assert.equal(context.selectSurfacingSlate({
      state: twice.state, snapshot: forest.snapshot, toolName: "pi_fold_context", ordinal: later,
    }).slate.length, 0, "A twice-ignored fold was resurfaced");
  }

  // ACTED resets the streak; a take proves the fold can be useful, so it is never
  // silenced on the strength of the ignores that came before.
  const acted = context.noteSurfacingAction(first, forest.gold, ordinal + 2);
  assert.deepEqual(acted.surfacing, [{
    id: forest.gold, surfaced: 1, taken: 1, ordinal: ordinal + 2, outcome: "acted",
  }]);
  assert.equal(context.surfacingSilenced(acted.surfacing).size, 0);
  assert.equal(context.noteSurfacingAction(acted, forest.gold, ordinal + 3), acted,
    "A second action on an already-graded offer moved the ledger");
  assert.equal(context.noteSurfacingAction(first, forest.gold,
    ordinal + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1), first,
    "An action after the window closed was still counted as a take");

  // USED, by provenance: content-only terms the brief never carried, showing up in what
  // the agent said next. Brief terms prove nothing, because they were already visible.
  const usedSnapshot = {
    ...forest.snapshot,
    messages: [...forest.messages, {
      role: "assistant",
      content: [{ type: "text", text: `The ${SURFACING_SUBJECT}, so the dispute is settled.` }],
      stopReason: "stop",
    }],
  };
  const used = context.resolveSurfacing({
    state: acted, snapshot: usedSnapshot,
    ordinal: ordinal + 2 + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1,
  });
  assert.equal(used.state.surfacing[0].outcome, "used");
  assert.deepEqual(used.transitions.map((transition) => transition.to), ["used"]);
  const unused = context.resolveSurfacing({
    state: acted, snapshot: forest.snapshot,
    ordinal: ordinal + 2 + context.SURFACING_OUTCOME_WINDOW_ORDINALS + 1,
  });
  assert.equal(unused.state.surfacing[0].outcome, "acted", "An unused retrieval was graded used");

  // Eligibility, unchanged: an expanded fold is already visible and a pinned one is
  // where the agent wants it. Neither is ever a candidate.
  const expanded = context.setFoldProjectionState(forest.state, forest.gold, "expanded");
  assert.equal(context.surfacingCandidates({
    state: expanded, snapshot: forest.snapshot, toolName: "pi_fold_context",
  }).some((candidate) => candidate.id === forest.gold), false);
  const pinned = context.protectEvidence(forest.snapshot, forest.state, [forest.gold], true);
  assert.equal(context.surfacingCandidates({
    state: pinned, snapshot: forest.snapshot, toolName: "pi_fold_context",
  }).some((candidate) => candidate.id === forest.gold), false);
  return {
    cooldownIsTheOutcomeWindow: context.SURFACING_OUTCOME_WINDOW_ORDINALS,
    ignoreLimit: context.SURFACING_IGNORE_LIMIT,
    silencedForever: [...context.surfacingSilenced(twice.state.surfacing)].length,
    labels: ["shown", "acted", "used", "ignored"],
    provenanceTerms: context.SURFACING_PROVENANCE_TERMS,
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

async function epochToolRuntime({ guidance, ...fixture } = {}) {
  const built = makeFixture({
    turns: 8, resultChars: 10_000, contextWindow: 100_000, ...fixture,
  });
  const runtime = makeRuntime(built, guidance ? { guidance } : {});
  await startRuntime(runtime);
  return runtime;
}

async function gateEpochMarkCommit() {
  const runtime = await epochToolRuntime();
  const rawBytes = bytesOf((await project(runtime)).messages);
  assert.deepEqual([...[...runtime.tools.values()][0].parameters.properties.action.enum],
    [...context.ACTIVE_CONTEXT_TOOL_ACTIONS]);
  // 68,000 against the 90,000-token serving budget is 0.756 occupancy: below the
  // band top at 0.80 (72,000 tokens), so the ladder marks and nothing commits. Mark
  // inertness is only a claim about passes where the runtime was NOT going to rewrite
  // anyway; over the trigger the rewrite belongs to the commit, not to the mark.
  await measure(runtime, 68_000, 100_000);
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
  await measure(blocked, 68_000, 100_000);
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
/**
 * An upgrade-lane call is one whose subject is a fold that already exists; a warm
 * preparation names a candidate that does not. Both request shapes are recognised because
 * the lane batches: one call carries many spans, each naming its own committed fold, while
 * `prepareFold` still asks about one candidate at a time.
 */
function isBriefUpgradeRequest(request) {
  const upgrades = (id) => typeof id === "string" && id.startsWith("fold_");
  if (Array.isArray(request?.spans)) {
    return request.spans.length > 0 && request.spans.every((span) => upgrades(span?.candidateId));
  }
  return upgrades(request?.candidateId);
}

/** Every fold a request names, whichever shape it arrived in. */
function requestFoldIds(request) {
  return Array.isArray(request?.spans)
    ? request.spans.map((span) => span?.candidateId)
    : [request?.candidateId];
}

/**
 * The spans a request carries. A batch states them; a single-span request IS one, so it is
 * read as a one-span batch and every caller can ask the same question of both.
 */
function requestSpans(request) {
  return Array.isArray(request?.spans) ? request.spans : [request];
}

/**
 * A generator stub that answers either shape with the same words: one brief for a single
 * span, one brief per span for a batch. `write` is given a fold id and returns its text.
 */
function briefAnswer(request, write) {
  const attribution = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    effort: "medium",
    toolCalls: 0,
    launchContractDigest: "b".repeat(64),
  };
  const ids = requestFoldIds(request);
  return Array.isArray(request?.spans)
    ? { briefs: ids.map((id) => write(id)), ...attribution }
    : { brief: write(ids[0]), ...attribution };
}

function bytesOf(value) {
  return Buffer.byteLength(json.stableStringify(value), "utf8");
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

  await measureAndCommit(runtime, 88_500, 100_000, "quota-round");
  const status = await toolStatus(runtime);
  // Inside the rewrite the commit already paid for, one further rung may follow it, so
  // the ACTION reported last is not always the commit. The epoch record is, and that is
  // what this gate reads: it rides on every action the pass produced.
  const epoch = status.details.automatic.lastAutomaticAction.epoch;
  assert(epoch, JSON.stringify(status.details.automatic.lastAutomaticAction));
  assert.equal(epoch.agentMarks, 1);
  assert(epoch.ladderMarks >= 1, "The quota top-up added nothing");
  assert(epoch.applied.some((item) => item.id === agentMarkId && item.origin === "agent"));
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
  assert.equal(epoch.pendingMarks, epoch.agentMarks + epoch.ladderMarks);
  assert(epoch.topUpMarks >= 1 && epoch.topUpMarks < context.MAX_PENDING_MARKS);
  // This fixture runs the candidate pool dry before the floor, which is the other
  // legitimate exit; what must never happen silently is the mark CAP binding.
  assert(epoch.freedBudgetShare > 0);
  assert(epoch.sourceBytesSaved > 0);
  // The freeing target IS the hysteresis, on one denominator: what is used, less where
  // the thermostat lands, over the serving budget. The separate window-share floor is
  // gone, so this asserts equality rather than a maximum against a number that could
  // never bind: at maxTarget 0.80 and minTarget 0.35 the hysteresis share bottoms out
  // at 0.45 of budget, and the retired floor was 0.40 of the WINDOW (0.405 of budget at
  // the fixture's 90,000-token budget behind a 100,000-token window).
  assert.equal(epoch.targetBudgetShare, epoch.hysteresisTargetShare);
  near(epoch.targetBudgetShare,
    Math.max(0, (epoch.occupancyTokensBefore - context.DEFAULT_THRESHOLDS.minTarget * 90_000) / 90_000),
    1e-12, "freeing target");
  const committed = materialized(runtime);
  assert.equal(committed.pendingMarks, undefined);
  // Every applied mark became a fold. The count is a floor rather than an equality: a
  // rung riding the same paid rewrite may add one more, which costs no extra
  // invalidation and is the reason inline rungs are allowed there at all.
  assert(committed.folds.length >= epoch.applied.length);
  for (const item of epoch.applied) {
    assert(committed.folds.some((fold) => fold.id === item.foldId),
      `An applied mark left no fold: ${item.foldId}`);
  }

  // Precedence: a quota that is already met adds nothing at all.
  const snapshot = epochSnapshot(built);
  const empty = context.emptyActiveContextState(built.sessionId);
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
  await measure(runtime, 80_000, 100_000);
  assert.equal(materialized(runtime).folds.length, 0, "The marking pass moved bytes");
  assert.deepEqual((await project(runtime)).messages.find((message) => message?.toolCallId === "call-1")?.content,
    rawCopy.content, "The peek copy moved before any commit");

  // THE PIN IS THE VETO. It is made before the commit, and the commit reclaims
  // everything else while the pinned copy stays raw.
  await toolCall(runtime, { action: "protect", ids: [peekEntryId] });
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
  // The decision waits rather than being dropped: the pin is a hold, so releasing it
  // hands the copy to the next commit without the agent having to ask again.
  assert((materialized(runtime).pendingMarks ?? []).some((mark) =>
    typeof mark.brief === "string" && mark.brief.includes("fold_probe")),
  "The vetoed reclaim was discarded instead of held");
  await toolCall(runtime, { action: "unprotect", ids: [peekEntryId] });
  await runtimeCommit(runtime, { tokens: 84_000, contextWindow: 100_000 });
  const releasedState = materialized(runtime);
  const owner = releasedState.folds.find((fold) =>
    context.flattenFoldRefs(fold, releasedState).some((ref) => ref.entryId === peekEntryId));
  assert(owner, "The released peek copy was never reclaimed");
  assert(owner.brief.includes("fold_probe"), "The released reclaim lost its pointer");

  // THE FRESH TAIL IS EXEMPT, NO EXCEPTIONS. A copy inside it is not marked at all; the
  // same copy, with later turns behind it, is.
  const fresh = makeFixture({
    turns: 6, resultChars: 4_000, contextWindow: 100_000, peekTurns: [5], peekTargetId: "fold_probe",
  });
  const freshSnapshot = epochSnapshot(fresh);
  const freshCopyIndex = freshSnapshot.mapped.findIndex((item) =>
    item.ref?.entryId === fresh.turnEntries[5][2]);
  assert(freshSnapshot.toolProtectedIndices.has(freshCopyIndex),
    "Fixture invariant: the newest peek copy must sit inside the fresh tail");
  assert.deepEqual(
    context.ephemeralPeekMarks({
      snapshot: freshSnapshot, state: context.emptyActiveContextState(fresh.sessionId), ordinal: 1,
    }),
    [],
    "A peek copy inside the fresh tail was marked for reclaim",
  );
  const aged = makeFixture({
    turns: 12, resultChars: 4_000, contextWindow: 100_000, peekTurns: [5], peekTargetId: "fold_probe",
  });
  const agedMarks = context.ephemeralPeekMarks({
    snapshot: epochSnapshot(aged), state: context.emptyActiveContextState(aged.sessionId), ordinal: 1,
  });
  assert.equal(agedMarks.length, 1, "The same copy, aged out of the fresh tail, must reclaim");
  return {
    reclaimPointsAt: foldId,
    bytesIdenticalAfterReclaim: true,
    pinnedCopySurvived: true,
    releasedCopyReclaimed: owner.id,
    freshTailExempt: true,
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
  for (let index = 0; index < 90; index += 1) await project(runtime);
  const grown = (await toolStatus(runtime)).details.automatic.instrumentation;
  assert(grown.projections > 64,
    `The runtime recorded ${grown.projections} projections, too few to outgrow the deleted bound`);
  // The page really trims rather than merely fitting: it holds fewer records than the
  // ledger recorded. Without this the assertion below would pass on a ledger that never
  // grew past a page and would say nothing about what replaced the constant.
  assert(grown.projectionRecords.length < grown.projections,
    `The page delivered all ${grown.projections} records, so its own trim never ran`);
  const pageResult = await toolStatus(runtime);
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
  const freshSpan = [built.turnEntries[9][0], built.turnEntries[9].at(-1)];

  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const tool = [...runtime.tools.values()][0];
  assert.deepEqual([...tool.parameters.properties.action.enum], [
    ...context.ACTIVE_CONTEXT_TOOL_ACTIONS,
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

  // There is one scheduler, so there is one surface: the old claim that a narrower
  // immediate surface hid unmark has nothing left to compare against. What survives is
  // the part that was never about the scheduler: withdrawal is offered on every
  // surface, committing never is, and the correction verbs ride alongside them.
  const plain = makeRuntime(makeFixture(fixture), {});
  await startRuntime(plain);
  const actions = [...plain.tools.values()][0].parameters.properties.action.enum;
  assert.equal(actions.includes("unmark"), true);
  assert.equal(actions.includes("commit"), false);
  assert(actions.includes("rebrief") && actions.includes("reboundary"),
    "The correction verbs must exist on the single surface");

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
 * Below the commit threshold every eligible turn must mark NEW stale content. If the
 * selector cannot see the pending marks it re-proposes the batch already marked,
 * `addPendingMark` rejects the duplicate, and the epoch arrives with one mark and a
 * top-up doing all the work. That collapse is what this gate measures.
 */
async function gateMarkAccumulation() {
  const runtime = await epochToolRuntime({ turns: 40 });
  const growth = [];
  // Five quiet passes: 60,000 to 68,000 against a 90,000-token budget is 0.667 to
  // 0.756 occupancy, all below the band top at 0.80 (72,000 tokens).
  for (const tokens of [60_000, 62_000, 64_000, 66_000, 68_000]) {
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
    context.selectAutomaticToolBatch(epochSnapshot(runtime.built), materialized(runtime), claimed)
      .some((candidate) => candidate.sourceRefs.some((ref) => claimed.has(json.objectRefKey(ref)))),
    false,
    "The selector still returns evidence a pending mark covers",
  );

  // At the commit the accumulated marks, not the top-up floor, do most of the freeing.
  await measureAndCommit(runtime, 86_500, 100_000, "accumulation-round");
  const status = await toolStatus(runtime);
  const epoch = status.details.automatic.lastAutomaticAction.epoch;
  assert.equal(epoch.refusedMarks, 0);
  // Applied = pending + closing. The epoch re-reads its own root count after its marks
  // land and parents what it just made, so it applies marks that were never pending.
  assert.equal(epoch.appliedMarks, epoch.pendingMarks + epoch.closingMarks);
  assert(epoch.pendingMarks > epoch.topUpMarks, "The top-up out-marked the accumulated epoch");
  assert(epoch.freedBudgetShare >= epoch.targetBudgetShare,
    "A full epoch freed less than the thermostat's own freeing target");
  assert(epoch.appliedMarks >= marks.length + 1,
    "The accumulated marks did not all reach the commit");
  assert.equal(materialized(runtime).pendingMarks, undefined);
  return {
    growth,
    accumulatedMarks: marks.length,
    appliedMarks: epoch.appliedMarks,
    topUpMarks: epoch.topUpMarks,
    freedBudgetShare: epoch.freedBudgetShare,
    actualFreedBudgetShare: epoch.actualFreedBudgetShare,
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
 * `withSurfacingLedger` must rebuild the record in canonical key order. Assigning
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
  const record = { id: marks[0].id, surfaced: 1, taken: 0, ordinal: 3, outcome: "shown" };
  const logged = context.withSurfacingLedger(withMarks, [record]);
  assert.deepEqual(Object.keys(logged).filter((key) => key === "surfacing" || key === "pendingMarks"),
    ["surfacing", "pendingMarks"], "withSurfacingLedger appended surfacing after pendingMarks");
  assert.deepEqual(
    Object.keys(logged),
    Object.keys(context.parseActiveContextState(logged, built.sessionId)),
    "withSurfacingLedger produced a non-canonical key order",
  );
  assert.equal(
    context.semanticStateSha256(logged),
    context.semanticStateSha256(context.parseActiveContextState(logged, built.sessionId)),
    "A surfacing write drifted the replay digest",
  );
  assert.deepEqual(logged.pendingMarks, withMarks.pendingMarks);
  const cleared = context.withSurfacingLedger(logged, []);
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
    assert(brief.length <= 1_200, `A stage-identified brief exceeded the hard cap: ${brief.length}`);
    assert(context.usefulBrief(brief, 1_200, "pi_fold_context"), "A stage-identified brief is not factual");
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
    {},
  );
  await startRuntime(runtime);
  // The quiet band: 0.80 of the 180,000-token serving budget is 144,000 tokens, so
  // these five passes accumulate marks and none of them commits.
  for (const tokens of [110_000, 118_000, 126_000, 134_000, 142_000]) {
    await measure(runtime, tokens, 200_000);
  }
  const before = (materialized(runtime).pendingMarks ?? []).map((mark) => mark.id);

  // The current excursion: ten read batches gathered since the last reply, far past
  // the protected tail (freshTail 0.02 of a 180,000-token budget is 14,400 bytes), so
  // nothing but the turn boundary protects them.
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
  // The gated last-call round, with the excursion still open on every pass.
  await project(runtime);
  await settle();
  await measureAndCommit(runtime, 176_500, 200_000, undefined, "toolUse");
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

  // Unprotected, those reads are ordinary ladder food and count as nothing held.
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
  assert.equal(epoch.trigger, "projection-budget");
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
 * Measured 2026-08-06 (rep 10, all twelve levers, epoch scheduling): 52 contiguous
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
  const step = async (tokens, round = false) => {
    await measure(runtime, tokens, 100_000, undefined, "toolUse");
    // A pass that reaches the BOUNDARY is a full request cycle: the measurement marks,
    // the context pass follows, and the boundary is where a commit can land, so the
    // record samples after it. A bare measurement moves nothing.
    if (round) {
      await project(runtime);
      await settle();
      await compactBoundary(runtime);
    }
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

  // Below the band top every pass MARKS and moves no byte. The band top is 0.80 of the
  // 90,000-token serving budget, so the quiet band on this fixture is under 72,000.
  const below = [];
  for (const tokens of [60_000, 64_000]) {
    below.push(await step(tokens));
  }
  assert(below.every((pass) => pass.kind === "mark"),
    `A pass below the commit threshold did not mark: ${below.map((pass) => pass.kind).join(",")}`);
  assert.equal(below.at(-1).folds, 0, "A fold landed below the commit threshold");
  assert.equal(below.at(-1).marks - below[0].marks, below.length - 1,
    "Marks did not accumulate one per pass below the threshold");

  // ABOVE THE BAND TOP, BELOW THE FENCE, WITH THE TURN STILL OPEN.
  //
  // The accumulated batch lands in ONE commit rather than dribbling out as an inline
  // fold per pass, and then the session goes quiet IN BYTES while the turn stays open.
  //
  // RE-DERIVED 2026-08-10 (the open-turn commit fix, then the class-law ruling). This
  // section used to assert that the open excursion is never even MARKED, on the reasoning
  // that the automatic reach ends at the last closed turn and so offers automation
  // nothing there. That reasoning was the defect: the reach was a byte prefix clamped to
  // the fresh boundary, so a session that never closes a turn had a zero-width reach and
  // starved outright (luna-20260810 pifold rep 2: 274,173 tokens of unmarked stale spans,
  // zero commits of any kind, two provider rejections). Foldability is membership now, so
  // the older excursion batches ARE proposable, and the open turn is protected where it
  // was always meant to be: at the commit, by the guard that has a waiver.
  //
  // What the gate measures instead is the property that actually matters economically,
  // and it is stronger than the old one: marks are free, folds are not. Automation marks
  // the excursion every pass and MOVES NO BYTE while the turn is open, because the guard
  // retains every one of those marks; the whole retained batch then lands in exactly one
  // commit at the moment the turn closes.
  //
  // The guard waiver still does NOT fire here. Below the fence the waiver only releases
  // a commit that would otherwise be starved, and this one has spine marks it can apply,
  // so the guard holds in full. Gate 56 holds the other half at fence level.
  const accumulated = below.at(-1).marks;
  const foldsAtCrossing = below.at(-1).folds;
  // The first step is a full request cycle that reaches the BOUNDARY, and the whole
  // accumulated batch lands there in one commit. The remaining steps are bare
  // measurements, the same parked-window shape this gate always pinned; the fixture
  // declares a high token count forever, so a projection pass here would put the
  // estimate inside the fence margin, and the margin lane is gate 56's subject, not
  // this one's. There is exactly one crossing because a second boundary with the batch
  // already landed has nothing but the open turn left, and the waiver would release it.
  const above = [];
  above.push(await step(86_000, true));
  for (let index = 1; index < 8; index += 1) above.push(await step(86_000 + index * 100));
  const commitPass = above.find((pass) => pass.appliedMarks !== null);
  assert(commitPass, "No commit epoch ran above the band top");
  assert(commitPass.appliedMarks >= accumulated,
    `The crossing applied ${commitPass.appliedMarks} of ${accumulated} accumulated marks; the batch did not land together`);
  assert(above.every((pass) => pass.guardWaived !== true),
    `A commit below the fence waived the current-turn guard: ${
      above.map((pass) => `${pass.kind}/waived=${pass.guardWaived}`).join(",")}`);
  assert(above.at(-1).folds > foldsAtCrossing,
    "The crossing folded nothing at all");
  // The guard, doing its own job at the commit rather than borrowing a zone's. The
  // crossing epoch RETAINED the open excursion's marks instead of refusing them, which
  // is the difference between "held until the turn closes" and "lost".
  assert(commitPass.retainedMarks > 0,
    "The crossing epoch retained nothing, so the current-turn guard held nothing back");
  // Marks are free; folds are not. Automation keeps proposing into the open excursion
  // and not one byte moves for it while the turn stays open.
  const openPasses = above.slice(above.indexOf(commitPass) + 1);
  assert(openPasses.length >= 3, "The fixture never sat on the open turn long enough to measure it");
  assert(openPasses.at(-1).marks > commitPass.appliedMarks,
    `Automation stopped proposing on the open turn at ${openPasses.at(-1).marks} marks`);
  assert(openPasses.every((pass) => pass.folds === commitPass.folds),
    `Bytes moved on the open turn: ${openPasses.map((pass) => pass.folds).join(",")}`);

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
  // No waiver fired at all below the fence, so the batch floor it used to enforce has
  // nothing to enforce here; gate 56 carries that assertion at fence level, where the
  // waiver is now the only place it lives.
  assert.deepEqual(above.filter((pass) => pass.waivedMarks > 0), []);

  // THE TURN CLOSES AND THE HELD BATCH LANDS, ONCE.
  //
  // RE-DERIVED 2026-08-10 with the section above. The claim here used to be that nothing
  // is left to collect when the turn closes, because nothing had been marked. Now the
  // excursion IS marked and the guard is holding all of it, so closing the turn releases
  // a batch, and the property under test is that it lands in ONE commit rather than one
  // fold per pass over three request cycles. That is the same economic law the rest of
  // this gate measures, applied at the only moment on this fixture where the hold ends.
  const marksAtCloseIds = new Set((materialized(runtime).pendingMarks ?? []).map((mark) => mark.id));
  const pendingAtClose = marksAtCloseIds.size;
  const foldsAtClose = materialized(runtime).folds.length;
  assert(pendingAtClose >= 12,
    `The guard held only ${pendingAtClose} marks, so the released batch is not worth measuring`);
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
  // Full request cycles at the same parked occupancy, with the guard now holding
  // nothing at all: the turn that protected the excursion is closed. Every one of the
  // three reaches the boundary, so a batch that dribbled would have three commits to
  // dribble into and the single-commit assertion below is a real one.
  const closingFrom = runtime.appended.length;
  for (const tokens of [87_000, 87_100, 87_200]) {
    await measureAndCommit(runtime, tokens, 100_000);
  }
  const closingSnapshot = context.mapActiveContext({
    sessionId: runtime.built.sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: 100_000,
  });
  assert.equal(context.currentTurnRefKeys(closingSnapshot).size, 0,
    "The closing turns never closed; the guard is still holding the excursion");
  const closingCommits = contextEvents(runtime, closingFrom)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  assert.equal(closingCommits.length, 1,
    `The released batch took ${closingCommits.length} commits over three request cycles`);
  // Plus whatever parents the epoch's own closing count owed over the folds it just
  // landed: those were never pending, and counting them as released would be a fiction.
  assert.equal(
    closingCommits[0].applied_marks - closingCommits[0].closing_consolidation_marks,
    pendingAtClose,
    `The commit applied ${closingCommits[0].applied_marks} of the ${pendingAtClose} marks the guard released`,
  );
  assert.equal(closingCommits[0].refused_marks, 0, "A released mark was refused rather than applied");
  assert(closingCommits[0].freed_tokens > 0, "The released batch freed nothing");
  assert(materialized(runtime).folds.length > foldsAtClose,
    "The guard released its batch and no fold landed for it");
  // What accumulates after is the NEXT batch, proposed against a window the commit just
  // shortened. It is bounded by what one pass can propose, and it has moved no bytes.
  const stillPending = materialized(runtime).pendingMarks ?? [];
  assert(stillPending.length <= 2,
    `The quiet window accumulated ${stillPending.length} marks after the batch landed`);

  return {
    belowThresholdPasses: below.length,
    belowThresholdFolds: below.at(-1).folds,
    accumulatedMarks: accumulated,
    waivedCommitsBelowFence: 0,
    accumulatedBeforeCrossing: accumulated,
    appliedAtCrossing: commitPass.appliedMarks,
    retainedAtCrossing: commitPass.retainedMarks,
    markedOnTheOpenTurn: openPasses.at(-1).marks,
    bytesMovedOnTheOpenTurn: 0,
    passesThatMovedBytes: foldingPasses.length,
    passesTotal: passes.length,
    marksHeldByTheGuard: pendingAtClose,
    marksStillPending: stillPending.length,
    committedInOneEpoch: true,
    commitsAfterTheTurnClosed: closingCommits.length,
    appliedAfterTheTurnClosed: closingCommits[0].applied_marks,
    foldsAfterTheTurnClosed: materialized(runtime).folds.length,
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

  // AND THE RELEASE ORDER IS REAL STALENESS, NOT THE MARK-ID ACCIDENT.
  //
  // Added 2026-08-10. Every mark one epoch proposes carries the same `ordinal`: it is the
  // transcript position at MARK time, so it records when the DECISION was made and
  // nothing about the age of what the decision covers. Ordering the release by it
  // therefore fell through to comparing mark ids, which are content hashes, and a digest
  // decided which evidence the guard surrendered first. What the waiver protects is the
  // newest reads an in-flight excursion is about to use, and that is a property of the
  // SPAN, so the order is the earliest window index each span covers, oldest first.
  //
  // The fixture is a session that never closes a turn, so the guard holds every mark and
  // the waiver is the only thing that can release one. Its mark ids and its span order
  // disagree, and that disagreement is asserted BEFORE the outcome: without it the check
  // would pass under either ordering.
  const orderSession = "waiver-order-test";
  const orderBatches = 8;
  // The newest batches sit in the fresh byte tail, where no candidate forms at all, so
  // the marks are the six oldest and the waiver's protection is measured among those.
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
  assert.equal(context.currentTurnBoundary(orderSnapshot), -1,
    "A turn closed in the waiver-order fixture, so the guard does not hold every mark");
  assert.equal(context.currentTurnRefKeys(orderSnapshot).size, orderBatches,
    "The guard does not hold every batch, so the release order is not being measured");
  assert(orderBatches > orderMarked, "The fixture marked into the fresh tail");
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
  // The bounded count and its arming threshold are the ones asserted above, reached
  // through the same arithmetic: only the ORDER is new.
  const orderWaiver = context.guardWaiverCount({
    snapshot: orderSnapshot, ratio: 0.86, guardedMarks: orderMarks.length, otherApplicableMarks: 0,
  });
  assert.equal(orderWaiver, orderMarked - context.GUARD_WAIVER_PROTECTED_MARKS,
    `The bounded release moved: ${orderWaiver} of ${orderMarked} guarded marks`);
  // The fixture is only worth running while the two orders genuinely disagree, and this
  // is the disagreement that matters: by mark id the release reaches the NEWEST span in
  // the set, which is the one evidence the guard exists to hold back.
  assert(byMarkId.slice(0, orderWaiver).includes(bySpan.at(-1)),
    "Mark-id order no longer releases the newest span, so this fixture cannot tell the orders apart");
  const released = await context.commitPendingMarks({
    snapshot: orderSnapshot,
    state: orderState,
    generation: 1,
    guardCurrentTurn: true,
    guardWaiver: orderWaiver,
  });
  assert.deepEqual(released.waived.map((mark) => mark.id), bySpan.slice(0, orderWaiver),
    "The waiver released marks in an order span staleness does not explain");
  assert.deepEqual(context.pendingMarks(released.state).map((mark) => mark.id).sort(),
    [...bySpan.slice(orderWaiver)].sort(),
    "The guard held back something other than the newest material");

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
  assert(context.currentTurnBoundary(guardedSnapshot) < guardedSnapshot.messages.length - 28,
    "A turn closed inside the excursion, so the starving case is not being measured");
  const guardedMembers = context.automaticToolBatches(
    guardedSnapshot, context.emptyActiveContextState(guardedOnly.built.sessionId));
  assert(guardedMembers.length > 0,
    "The automatic law found no member inside the open excursion, so the reach is clamped again");
  assert(!guardedMembers.some((batch) =>
    batch.indices.includes(guardedSnapshot.messages.length - 1)),
  "The newest result is a member, so the fresh tail bounds nothing");
  assert(context.currentTurnRefKeys(guardedSnapshot).size >= 12,
    "The guard does not hold the excursion, so the starving case is not being measured");
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
  assert.equal(guardedOnly.steered.length, 1, "The recovery queued more than one steered message");
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
    waiverBelowBackstop: 0,
    waiverWhenStarved: waiver(0.86, 8),
    waiverAtFence: waiver(0.99, 3),
    orderGuardedMarks: orderMarked,
    orderWaiver,
    orderIdOrderDiffersFromSpanOrder: true,
    orderReleasedStalestFirst: true,
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
    makeFixture({ turns: 12, resultChars: 8_000, contextWindow: 12_000, thresholds: WIDE_FRESH_TAIL }),
    // A 12,000-token window can be served, but not by the default 2% fresh tail: at a
    // 10,800-token budget that is 216 tokens, under the one-foldable-unit floor. The
    // deployment declares a policy the window can carry, which is the designed answer to
    // a tiny window: reject the impossible one, do not silently clamp it.
    { ...SEALED_SPINE, providerInputBudget: 10_800, thresholds: WIDE_FRESH_TAIL },
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
    makeFixture({ turns: 8, resultChars: 10_000, contextWindow: window, thresholds: WIDE_FRESH_TAIL }),
    {
      ...SEALED_SPINE,
      providerInputBudget: servingBudget(window),
      thresholds: WIDE_FRESH_TAIL,
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
  // now, and the guard adjudicates it at the commit. Closing every turn still matters
  // here for a simpler reason: it keeps the
  // guard out of the picture entirely, so what the climb measures is the estimator and
  // the margin rather than the guard-and-waiver case gate 56 owns.
  const climb = [];
  for (let step = 0; step < 12; step += 1) {
    const chars = bytesOf((await project(runtime)).messages);
    await measure(runtime, sevenChars(chars), window);
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
    const pinned = await toolCall(runtime, { action: "protect", ids: [callEntryId] });
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
    "The starved climb transmitted instead of aborting");
  assert.equal(climb.at(-1).reduction, null,
    "The starved climb recorded a reduction, so it is no longer measuring the starving case");

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
  assert.equal(runtime.steered.length, 1, "The recovery queued more than one steered message");
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
  const deep = makeRuntime(
    makeFixture({ turns: 30, resultChars: 12_000, contextWindow: 100_000 }),
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
  assert(epochs.every((epoch) => epoch.guardWaived !== true),
    "A commit below the fence waived the current-turn guard");
  // The property the rep13 ratchet violated, measured at like phases of the rhythm:
  // across a run where every cycle added a 24,000-char stage of inflow, the window
  // just after the LAST commit has grown by less than ONE such stage since just after
  // the first. Commits that keep pace with inflow bound the window; the ratchet was
  // the unbounded staircase, 30,000 tokens up through six commits and into a
  // provider rejection.
  assert(postCommitProjections.at(-1) - postCommitProjections[0] < 24_000,
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
  // and the correction is reported by name rather than silently reinterpreted. Both the
  // fold to cut into and the span that cuts it are read off the forest: one selection law
  // folds and consolidates on its own schedule, so a fixed turn index is not a span the
  // agent can still name by the time this arm runs.
  const foldable = foldableSpan(runtime, built);
  assert(foldable.turn, "The fixture left no unfolded turn for the agent to fold");
  await toolCall(runtime, {
    action: "fold",
    ids: [foldable.turn[0], foldable.turn.at(-1)],
    brief: "A whole closed turn whose exact evidence stays recoverable behind this fold.",
  });
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  const crossing = crossingSpan(runtime, built);
  assert(crossing, "The fixture built no fold with material after it to cut across");
  const existing = crossing.root.fold;
  const [inside, later] = crossing.ids;
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
  // The agent's fold action is a MARK, so the split is reported as marks. The cap is a
  // property of the decision and of the fold the commit makes from it, so both are read.
  assert.equal(folded.details.marks.length, parts.length, "The manual fold did not split");
  assert(folded.details.corrections.some((item) => /split into \d+ sequential folds/.test(item.reason)),
    "The split was not reported");
  const splitCommitted = await measureAndCommit(manual, 86_000, 100_000, "split-commit");
  assert(splitCommitted.folds.length >= 1, "The split marks never committed");
  assert(splitCommitted.folds.every((fold) => fold.sourceChars <= context.MAX_FOLD_SPAN_CHARS));

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
    manualSplitParts: folded.details.marks.length,
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
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
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
    policy: { minChapterChars: 1 },
    thresholds: NO_FRESH_TAIL,
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
  assert.equal(runtime.steered.length, 1, "The recovery queued more than one steered message");
  assert.equal(runtime.steered[0].options.deliverAs, "steer");
  assert.equal(runtime.steered[0].message.customType, "pi-fold-active-context-overflow-recovery");
  assert.match(String(runtime.steered[0].message.content), /rolled the session back/);
  assert.match(String(runtime.steered[0].message.content), /reissued now/);

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
  const foldable = foldableSpan(runtime, built);
  assert(foldable.turn, "The fixture left no unfolded turn for the agent to fold");
  await toolCall(runtime, {
    action: "fold",
    ids: [foldable.turn[0], foldable.turn.at(-1)],
    brief: "A whole closed turn whose exact evidence stays recoverable behind this fold.",
  });
  await runtimeCommit(runtime, { tokens: 94_000, contextWindow: 100_000 });
  const crossing = crossingSpan(runtime, built);
  assert(crossing, "The fixture built no fold with material after it to cut across");
  const chapter = crossing.root.fold;
  await toolCall(runtime, {
    action: "fold",
    ids: crossing.ids,
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
  // And the surfacing SELECTOR outlives the carrier that rendered it: it returns at the
  // commit boundary, now scoring both channels, with its suppression ledger.
  assert.equal(typeof context.selectSurfacingSlate, "function");
  assert.equal(typeof context.surfacingSlateText, "function");
  assert.equal(context.SURFACING_MAX_LEDGER_RECORDS, 256);
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
  assert.equal(Object.hasOwn(status.surfacing, "sources"), false,
    "The status block still reports an external suggestion-source registry");
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
    surfacingSelectorKept: true,
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
  // The FENCE commits this one: the fixture's declared occupancy puts the projection at
  // the margin, and the fence owns a request already there.
  assert.equal(commit.trigger, "projection-budget");
  assert(commit.applied_marks >= 5,
    `The commit applied ${commit.applied_marks} marks; it was not the ONE deep event`);

  // Quiet again once occupancy falls back below the threshold.
  await measure(runtime, 40_000, 100_000, undefined, "toolUse");
  await project(runtime);
  await settle();
  assert.equal(commits().length, 1, "The runtime kept folding after the commit");

  // The retune itself, and the parts of the thermostat that did NOT move. The two
  // occupancy constants are fields of the declared object now; their values are the
  // proven ones, unchanged.
  assert.equal(context.DEFAULT_THRESHOLDS.maxTarget, 0.80);
  assert.equal(context.DEFAULT_THRESHOLDS.minTarget, 0.35);
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
  // The gated last-call round; the commit lands on the context pass after it.
  await measure(runtime, 331_000, 272_000, undefined, "toolUse");
  await project(runtime);
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
  // The fresh tail is a SHARE now, and at fixture scale the default 2% of a
  // 90,000-token budget is 7,200 bytes, which one 8,000-char result already exceeds.
  // This gate is about what happens to a mark INSIDE the tail, so the deployment
  // declares a tail wide enough to hold the closing turn.
  const fixture = {
    turns: 10, resultChars: 8_000, contextWindow: 100_000, thresholds: WIDE_FRESH_TAIL,
  };
  const built = makeFixture(fixture);
  const runtime = makeRuntime(built, { thresholds: WIDE_FRESH_TAIL });
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
  const aged = makeFixture({ ...fixture, turns: 24, sessionId: built.sessionId });
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
  const block = context.receiptBlockText({ receipts: [receipt], toolName: "pi_fold_context" });
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
  assert.equal(context.ACTIVE_CONTEXT_TOOL_ACTIONS.includes("commit"), false,
    "The epoch action surface still carries the commit verb");
  for (const kept of ["fold", "unmark", "status", "expand", "peek", "refold", "rebrief", "reboundary"]) {
    assert(context.ACTIVE_CONTEXT_TOOL_ACTIONS.includes(kept),
      `The deletion took ${kept} with it`);
  }

  const runtime = await epochToolRuntime({ turns: 14, resultChars: 8_000 });
  const tool = [...runtime.tools.values()][0];
  assert.deepEqual([...tool.parameters.properties.action.enum],
    [...context.ACTIVE_CONTEXT_TOOL_ACTIONS]);
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

  // The live commit-boundary carriers offer the verbs that exist and nothing that does
  // not. The pre-B1 curation notice that used to stand here is deleted with its gate.
  const lastCall = context.lastCallText({
    signals: {
      occupancy: 0.86, maxTarget: 0.80, occupancyTokens: 86_000, budgetTokens: 100_000,
      window: 100_000, staleToolShare: 0.3, staleToolTokens: 30_000, staleToolResults: 6,
      eligibleFolds: 4,
    },
    unmarked: { spans: 6, tokens: 30_000 }, pendingMarks: 4, toolName: "pi_fold_context",
  });
  const receiptBlock = context.receiptBlockText({
    receipts: [context.contextReceipt({
      kind: "commit", ordinal: 4, foldsCommitted: 2, foldsCreated: 2, freedTokens: 9_000,
    })],
    toolName: "pi_fold_context",
  });
  for (const [surface, text] of [["last call", lastCall], ["receipt block", receiptBlock]]) {
    assert.equal(/"action":"commit"/.test(text), false,
      `The ${surface} still offers a commit verb`);
  }
  assert(lastCall.includes('"action":"fold"') && lastCall.includes('"action":"protect"'),
    "The last call lost the verbs that do exist");
  assert(receiptBlock.includes('"action":"rebrief"') && receiptBlock.includes('"action":"reboundary"'),
    "The receipt block lost the correction verbs");

  // And the machinery is intact: the marks still fold, on the runtime's own trigger.
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.fired, "The internal commit stopped firing with the verb");
  assert(committed.applied.length >= 1, "The internal commit applied nothing");
  assert.equal(materialized(runtime).pendingMarks, undefined);
  assert(materialized(runtime).folds.length >= 1);

  // THE COMPLEMENT: the USER can commit, and can do it below the band top.
  //
  // The model has no commit verb because a verb the runtime is entitled to overrule is
  // surface without function. A user is not overruled, so the one user command exists
  // and it is authoritative: below maxTarget it applies the eligible marks in hand with
  // no automatic top-up, which is banking the curation the session already made rather
  // than asking the runtime to pick more.
  const user = await epochToolRuntime({ turns: 14, resultChars: 8_000 });
  const command = user.commands.get("fold-context");
  assert(command, "The user fold command is not registered");
  assert(/commit/.test(command.description),
    `The user command does not advertise its commit form: ${command.description}`);
  // Quiet: 60,000 of a 90,000-token budget is 0.667, well below the 0.80 band top.
  await measure(user, 60_000, 100_000);
  await toolCall(user, {
    action: "fold",
    ids: [user.built.turnEntries[1][0], user.built.turnEntries[1].at(-1)],
    brief: "An early completed task stays exactly recoverable behind this fold.",
  });
  const pendingBefore = (materialized(user).pendingMarks ?? []).length;
  assert(pendingBefore >= 1, "The fixture had no mark for the user command to commit");
  const foldsBefore = materialized(user).folds.length;
  const quietStatus = (await toolStatus(user)).details.automatic.scheduling;
  assert.equal(quietStatus.commitDue, false,
    "The fixture was already over the band top; the user command proves nothing there");
  const beforeCommand = user.appended.length;
  await command.handler("commit", user.ctx);
  await settle();
  const userCommits = contextEvents(user, beforeCommand)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  assert.equal(userCommits.length, 1,
    `The user command fired ${userCommits.length} commits below the band top`);
  assert(userCommits[0].applied_marks >= 1, "The user commit applied nothing");
  assert.equal(userCommits[0].trigger, "user-command",
    `The user commit reported trigger ${userCommits[0].trigger}`);
  // No automatic top-up below the band top: it banks what is in hand and stops.
  assert.equal(userCommits[0].topup_marks, 0,
    `The user commit topped up ${userCommits[0].topup_marks} marks below the band top`);
  assert(materialized(user).folds.length > foldsBefore, "The user commit created no fold");
  // The model still cannot reach it, on the same runtime, at the same moment.
  await assert.rejects(() => toolCall(user, { action: "commit" }), /'commit' is not enabled/);

  return {
    epochActions: context.ACTIVE_CONTEXT_TOOL_ACTIONS.length,
    commitInSurface: false,
    internalCommitApplied: committed.applied.length,
    userCommandCommitsBelowBandTop: userCommits[0].applied_marks,
    userCommandTopUpBelowBandTop: 0,
    modelCommitStillRefused: true,
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

  // A request whose projection exceeds the provider input budget is rejected outright,
  // so recovery must produce a window that fits: a projection past the serving budget
  // recovers, whatever it frees.
  const overflow = makeRuntime(
    makeFixture({ turns: 16, resultChars: 12_000, contextWindow: 60_000 }),
    {},
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
    // Spans the ladder has not already spoken for. Marking is doorless now, so the
    // automatic path has claimed the stalest batches by the time the agent reaches for
    // one, and a span another mark already covers is correctly refused.
    marks: [
      { ids: [built.turnEntries[10][2]], brief: "A later completed inspection stays exactly recoverable." },
      { ids: [built.turnEntries[11][2]], brief: "The next completed inspection stays exactly recoverable." },
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
    // Spans the ladder has not already spoken for. Marking is doorless now, so the
    // automatic path has claimed the stalest batches by the time the agent reaches for
    // one, and a span another mark already covers is correctly refused.
    marks: [
      { ids: [built.turnEntries[10][2]], brief: "A later completed inspection stays exactly recoverable." },
      { ids: [built.turnEntries[11][2]], brief: "The next completed inspection stays exactly recoverable." },
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
    occupancy: 0.5, maxTarget: 0.80, occupancyTokens: 50_000, budgetTokens: 100_000,
    window: 100_000, staleToolShare: 0.3, staleToolTokens: 30_000, staleToolResults: 6,
    eligibleFolds: 4,
  };
  // The sub-commit waypoint. It replaced the two sparse curation reminders, and it
  // inherits their rule: one line, informatory, and the marking it names is the BATCH.
  const notice = context.thresholdNoticeText({
    share: 0.5, occupancyTokens: 50_000, budgetTokens: 100_000, maxTarget: 0.80,
    toolName: "pi_fold_context",
  });
  assert.match(notice, /"action":"fold","marks":\[\{"ids"/);
  // The tool surface's own vocabulary rule: nothing here invites a chat-style answer.
  assert.equal(/\bthe reply\b/.test(notice), false, "The notice says \"the reply\"");
  assert.equal(notice.includes("\n"), false, "The notice stopped being one line");

  const lastCall = context.lastCallText({
    signals, unmarked: { spans: 6, tokens: 30_000 }, pendingMarks: 4, toolName: "pi_fold_context",
  });
  assert.match(lastCall, /adds or widens several in one call/);
  assert.match(lastCall, /"action":"fold","marks":\[\{"ids"/);

  const reply = await toolCall(runtime, {
    action: "fold",
    ids: [runtime.built.turnEntries[0][2]],
    brief: "One completed inspection stays exactly recoverable behind this mark.",
  });
  assert.match(String(reply.details.activation), /Mark several spans in one call/);
  assert.match(String(reply.details.activation), /nothing else in your\s+context changed/);

  return { description: true, notice: true, lastCall: true, activation: true };
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
  for (const detail of [undefined, "fold_candidates", "tree", "folds", "objects"]) {
    const result = await toolStatus(runtime, "pi_fold_context", detail);
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
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", pagedShape), true,
    "The advertised paged status call still classifies unsafe");
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
    trailingTurns: 4,
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
    trailingTurns: 4,
    trailingChars: 4_000,
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
 * can exceed maxChapterChars, exactly how rep 19's status units encoded to 146k-331k
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

  // The same transcript with the tool NOT blacklisted, which is every deployment's
  // default: the oversized unit never reaches the chapter rung as 140k of inline bytes at
  // all, because the tool rung claims the result directly and the chapter encoding carries
  // a brief in its place. Both halves say the same thing, which is this gate's name: there
  // is no closed unit the automatic law cannot reclaim by SOME rung.
  const unlisted = makeOpaqueToolFixture({
    sessionId: "giant-unlisted", resultSizes: [140_000], blacklisted: false,
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
    maxChapterChars: giant.snapshot.policy.maxChapterChars,
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
  const runtime = makeRuntime(built);
  await startRuntime(runtime);
  const committed = await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  assert(committed.fired, "The window-pressure commit never fired");
  assert.equal(committed.commit.trigger, "projection-budget");

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
  // Wider and lighter than the fixture this gate used to carry. One boundary lands the
  // whole accumulated batch, so a twelve-turn session commits two or three ROOTS and one
  // of them alone is past the 25% pinned-share cap: the pin under test would be refused
  // by the cap gate 92 pins, and this gate would be measuring that refusal instead.
  const runtime = await epochToolRuntime({ turns: 16, resultChars: 8000 });
  const stream = () => runtime.appended
    .filter((entry) => entry.customType === "pi-fold-context-event")
    .map((entry) => entry.data);
  const description = [...runtime.tools.values()][0].description;
  assert(description.includes("Protect is the pin"), "The pin is not advertised in the tool surface");

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
  await toolCall(runtime, { action: "protect", ids: [foldId] });
  await toolCall(runtime, { action: "expand", id: unpinnedFoldId });
  const pinned = stream().filter((record) => record.kind === "context.protect");
  assert.equal(pinned.length, 1, "A protect action must land exactly one context.protect record");
  assert.equal(pinned[0].protect, true);
  assert.equal(pinned[0].ids, foldId);
  assert(pinned[0].protected_refs_after > pinned[0].protected_refs_before,
    "Protecting a fold must add its evidence refs to the durable pin set");

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
  await toolCall(runtime, { action: "unprotect", ids: [foldId] });
  const releases = stream().filter((record) =>
    record.kind === "context.protect" && record.protect === false);
  assert.equal(releases.length, 1);
  assert.equal(materialized(runtime).protected.length, 0, "Unprotect must drain the refs protect added");
  for (let index = 0; index < 3; index += 1) {
    await measureAndCommit(runtime, 91_000 + index, 100_000, `unpin-measurement-${index + 1}`);
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

async function gateRiderIsOneLiteralPerEpoch() {
  // The rider is the one action-prompt carrier: composed at a fold commit, persisted
  // as LITERAL bytes, rendered beside the receipt inside the rewrite that commit
  // already paid for, never regenerated, replaced only by the next epoch's rider.
  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  for (const tokens of [70_000, 80_000, 86_000]) {
    await measureAndCommit(runtime, tokens, 100_000);
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
  // A ROOT read at call time, not the fold this gate saw first: the passes between then
  // and here run the ladder, and the count law may have nested that fold under a parent,
  // where expanding it is refused until the parent opens.
  await toolCall(runtime, {
    action: "expand",
    id: materialized(runtime).folds.find((fold) => fold.parentId === null).id,
  });
  for (let index = 0; index < 10 && materialized(runtime).rider.epoch === firstEpoch; index += 1) {
    await measureAndCommit(runtime, 86_500 + index, 100_000, `rider-epoch-${index}`);
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
    await measureAndCommit(runtime, tokens, 100_000);
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
  // The smallest LEAF. Consolidation nests under the counting rule, so a root fold can
  // now hold the whole stale region and pinning it would exceed the cap on its own;
  // what the under-the-cap leg is about is that a modest pin still lands.
  const smallest = [...folds]
    .filter((fold) => !fold.parts.some((part) => part.kind === "fold"))
    .sort((left, right) => (left.sourceChars ?? 0) - (right.sourceChars ?? 0))[0];
  assert(smallest, "The fixture produced no leaf fold to pin");
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
    toolName: "pi_fold_context",
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
  await measureAndCommit(runtime, 88_000, 100_000, "nesting-commit");
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
  const grandchildText = String(context.contentText(
    context.exactMapped(snapshot, context.flattenFoldRefs(child, state)[0]).message,
  )).slice(0, 64);
  assert.equal(revealedText.includes(grandchildText), false,
    "Expanding the parent leaked the grandchild's exact bytes");

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
  assert.equal(peekedText.includes(grandchildText), false,
    "Peek of a nested parent leaked bytes from under its children");
  // The child id, read the same way. Straight through the reader rather than the tool,
  // because this fixture sits at the fence on purpose and admission control is its own
  // law: what is under test here is the depth the read serves, not the room it needs.
  const peekedChild = context.peekFoldSource({
    foldId: childIds[0],
    state,
    entries: runtime.branch,
    sessionId: forest.sessionId,
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxChapterChars,
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
  for (const field of ["maxTarget", "minTarget", "freshTail"]) {
    named.push(refuses(withField({ [field]: 0 }), field));
    named.push(refuses(withField({ [field]: 1 }), field));
    named.push(refuses(withField({ [field]: -0.1 }), field));
    named.push(refuses(withField({ [field]: "0.5" }), field));
    named.push(refuses(withField({ [field]: Number.NaN }), field));
  }
  named.push(refuses(withField({ consolidateAfter: 0 }), "consolidateAfter"));
  named.push(refuses(withField({ consolidateAfter: 2.5 }), "consolidateAfter"));
  named.push(refuses(withField({ consolidateAfter: "10" }), "consolidateAfter"));

  // ONE ASSERTION PER ORDERING INVARIANT, each by the name it refuses under.
  const orderings = [
    // L < M: the thermostat needs a gap to fold down into.
    refuses(withField({ minTarget: 0.80, maxTarget: 0.80 }), "minTarget<maxTarget"),
    // F < M: a fresh tail wider than the trigger triggers on protection alone.
    refuses(withField({ maxTarget: 0.40, minTarget: 0.30, freshTail: 0.40 }),
      "freshTail<maxTarget"),
    // G >= F: one refill of the protected tail must not re-arm the trigger by itself.
    refuses(withField({ maxTarget: 0.60, minTarget: 0.58, freshTail: 0.10 }),
      "gap>=freshTail"),
    // P + F < M: the pin ceiling plus the structurally fresh tail is the floor a commit
    // can never get under, and a trigger at or below it announces nothing reclaimable.
    // Ordered so only the pin sum fails: 0.20 >= 0.06 holds, while 0.25 + 0.06 does not
    // stay under 0.30.
    refuses(withField({ maxTarget: 0.30, minTarget: 0.10, freshTail: 0.06 }),
      "pinnedPlusFreshTail<maxTarget"),
  ];
  assert.equal(new Set(orderings).size, orderings.length,
    "Two ordering violations refused under the same invariant name");

  // Servability, evaluated at REGISTRATION against the declared window.
  const serving = [];
  for (const [budget, invariant] of [[9_000, "minimumBudget"], [14_400, "freshTailTokens"]]) {
    let thrown = null;
    try {
      context.assertThresholdsServable(context.DEFAULT_THRESHOLDS, budget);
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
    ["consolidateAfter", "freshTail", "maxTarget", "minTarget"],
    "The thermostat is not the four numbers it declares");
  refuses({ ...context.DEFAULT_THRESHOLDS, staleTail: 0.78 }, "shape");

  // And the same refusal reaches a real registration, by name, never clamped.
  assert.throws(
    () => makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      { thresholds: { ...context.DEFAULT_THRESHOLDS, staleTail: 0.78 } }),
    /thresholds has no staleTail field/,
  );
  assert.throws(
    () => makeRuntime(makeFixture({ turns: 3, tools: false, contextWindow: 100_000 }),
      { thresholds: withField({ maxTarget: 0.40, minTarget: 0.30, freshTail: 0.40 }) }),
    /thresholds\.freshTail must sit below thresholds\.maxTarget/,
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
 * blacklist, or older material a chapter or a consolidation can compose over. Four
 * things and only four things hold it back, and this gate names each of them:
 *
 *   pinned          the agent protected it, anywhere in the window;
 *   fresh tail      the guaranteed-raw newest bytes, marked or not;
 *   blacklisted     the deployment named the tool, so no batch forms over it;
 *   guarded         the open turn's own evidence, adjudicated once at the commit,
 *                   where it has a high-occupancy waiver.
 *
 * There is no fifth thing, and in particular there is no MIDDLE. The positional stale
 * prefix that used to be the automatic law's whole reach is deleted: it starved rep 2 by
 * collapsing to zero width and rep 3 by charging a folded head its raw bytes, and both
 * times the set-based protections above went on working exactly as written. What sits
 * between the fresh tail and the oldest material is whatever the ladder has not needed
 * yet plus whatever the agent pinned.
 */
async function gateThreeZones() {
  const thresholds = Object.freeze({
    maxTarget: 0.80, minTarget: 0.35, freshTail: 0.05, consolidateAfter: 10,
  });
  const built = makeFixture({
    turns: 30, resultChars: 8_000, contextWindow: 100_000, thresholds,
  });
  const snapshot = built.snapshot;
  const state = context.emptyActiveContextState(built.sessionId);
  assert(snapshot.freshBoundary < snapshot.messages.length, "The fixture has no fresh tail");
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
      const tail = candidate.kind === "tool-result"
        ? snapshot.toolProtectedIndices
        : snapshot.protectedIndices;
      assert(!tail.has(item.index),
        `Automation proposed index ${item.index} out of the guaranteed-raw fresh tail`);
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
      !snapshot.toolProtectedIndices.has(item.index))
    .map((item) => item.index);
  assert(foldableIndices.length > 0, "The fixture holds no foldable tool results at all");
  const unreached = foldableIndices.filter((index) => !reached.includes(index));
  assert.deepEqual(unreached, [],
    `The ladder left ${unreached.length} unpinned member results untouched: ${unreached.join(", ")}`);
  assert(Math.max(...reached) > snapshot.freshBoundary - 1 || snapshot.freshBoundary === 0 ||
    Math.max(...reached) >= Math.max(...foldableIndices),
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

  // FRESH TAIL: a mark inside it does not commit, and the SAME span outside it does.
  const freshEntry = built.turnEntries.at(-1)[2];
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
  const freshMark = markFor(freshEntry);
  const staleMark = markFor(staleEntry);
  assert(snapshot.toolProtectedIndices.has(freshMark.index),
    "The newest entry is not inside the fresh tail, so the tail is not being measured");
  assert(!snapshot.toolProtectedIndices.has(staleMark.index),
    "The older entry is inside the fresh tail, so the contrast is not being measured");
  // The fresh tail refuses by the same label protection uses, which is the point: from
  // the commit's side a fresh span and a pinned span are both simply unavailable.
  assert.notEqual(context.markEligibility(snapshot, state, freshMark), "eligible",
    "A mark inside the fresh tail was eligible to commit");
  assert.equal(context.markEligibility(snapshot, state, staleMark), "eligible",
    "A mark outside the fresh tail could not commit");
  // The same span, in a snapshot whose tail no longer covers it, commits.
  const narrowTail = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: 100_000,
    thresholds: NO_FRESH_TAIL,
  });
  assert.equal(context.markEligibility(narrowTail, state, freshMark), "eligible",
    "The same mark stayed unfoldable once it was outside the tail");

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

  // GUARDED IS THE FOURTH, and it is adjudicated at the COMMIT rather than here: the open
  // turn's evidence stays proposable, because a session that never closes a turn would
  // otherwise have nothing to offer, and the commit refuses it unless the high-occupancy
  // waiver releases it. Gate 52 pins the guard and gate 106 pins the waiver end to end;
  // this fixture closes every turn, so it has no open turn to speak for.
  assert.equal(context.currentTurnRefKeys(snapshot).size, 0,
    "The fixture left a turn open, so the guard belongs in this gate after all");

  return {
    freshBoundary: snapshot.freshBoundary,
    messages: snapshot.messages.length,
    spansProposed: proposed.length,
    memberResults: foldableIndices.length,
    memberResultsReached: foldableIndices.length,
    deepestProposedIndex: Math.max(...reached),
    blacklistedProposals: 0,
    freshMarkEligibility: context.markEligibility(snapshot, state, freshMark),
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
    maxTarget: 0.80, minTarget: 0.35, freshTail: 0.05, consolidateAfter: 10,
  });
  const built = makeFixture({
    turns: 30, resultChars: 8_000, contextWindow: 100_000, thresholds,
  });
  const snapshot = built.snapshot;
  const state = context.emptyActiveContextState(built.sessionId);

  // (a) THE LAW IS UNCONDITIONAL, AND THE MACHINERY THAT BENT IT IS GONE.
  //
  // There was a fence-only snapshot here: at high occupancy it narrowed the fresh tail
  // to a quarter and extended the automatic reach across the middle, so a reduction that
  // had to make a rejected request sendable had mass to reach. It existed because folding
  // harder was the runtime's only answer to a provider rejection. The rollback lane is
  // the answer now, so the rules hold at every occupancy and there is one set of them.
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

  // The law itself, asserted directly: automation proposes members and nothing else,
  // whatever the pressure. Nothing the fresh tail covers is reachable BY CONSTRUCTION
  // rather than by a pressure test that happened not to reach it.
  const claims = new Set();
  const proposed = [];
  for (let round = 0; round < 40; round += 1) {
    const candidate = context.selectAutomaticSpan(snapshot, state, claims);
    if (!candidate) break;
    for (const ref of candidate.sourceRefs) claims.add(json.objectRefKey(ref));
    proposed.push(candidate);
  }
  assert(proposed.length >= 1, "The class law proposed nothing at all");
  const reachedIndices = proposed.flatMap((candidate) => candidate.sourceRefs
    .map((ref) => snapshot.mapped.findIndex((item) => item.ref && json.objectRefKey(item.ref) === json.objectRefKey(ref)))
    .filter((index) => index >= 0));
  assert(reachedIndices.every((index) => !snapshot.protectedIndices.has(index)),
    `Automation proposed protected index ${reachedIndices.find((index) => snapshot.protectedIndices.has(index))}`);

  // (b) THE LATCH QUESTION DISSOLVES.
  //
  // The reopen latch is an economy rule: it keeps a window parked on the band top from
  // buying a prefix rewrite per pass. It used to be asserted here that the fence
  // BYPASSES it, because a request that does not fit is not economy. That bypass was the
  // fence racing the latch for a DEEPER commit, and there is no deeper commit any more:
  // the band-top commit already folds everything the stale zone offers, so a window that
  // reaches the fence has a latch holding back a commit with nothing to apply. Recovery
  // is a rollback now, not a trigger racing a latch. What remains is the pair this pins:
  // the latch holds a parked window, and a window at the fence with nothing the zone law
  // admits is ABORTED rather than transmitted.
  const runtime = makeRuntime(
    makeFixture({ turns: 40, resultChars: 3_000, contextWindow: 34_000, thresholds }),
    {
      ...SEALED_SPINE,
      providerInputBudget: 30_600,
      thresholds,
      blacklistAutoFoldTools: new Set(["fence_stream"]),
    },
  );
  await startRuntime(runtime);
  // First crossing: commits, and latches.
  await measureAndCommit(runtime, 26_000, 34_000, "latch-arm");
  const afterFirst = runtime.appended.length;
  // A second crossing with nothing new: the latch holds it.
  await measure(runtime, 26_100, 34_000);
  await project(runtime);
  await settle();
  const latched = contextEvents(runtime, afterFirst)
    .filter((record) => record.kind === "context.commit" && record.deferred === false);
  assert.equal(latched.length, 0,
    "A window parked on the band top committed again with no new eligible mass");
  // WHAT THE FENCE MAY TAKE, NOT WHETHER IT TAKES ANYTHING.
  //
  // This used to assert that no commit fires at the fence at all, on a fixture whose
  // stale zone was spent. That premise died with the raw-basis walk: the reach is a
  // share of the PROJECTED window now, so every commit uncovers a little more of it and
  // tail inflow keeps manufacturing reachable mass on its way in. Total starvation is
  // not producible by appending, and a gate that demanded it would be asserting that the
  // ladder stops working. Measured 2026-08-10: two commits fire here however the inflow
  // is shaped, including with a blacklisted producer whose every call is pinned.
  //
  // The protective purpose is untouched and is what this pins instead: the fence never
  // opens the FRESH TAIL and never takes what the agent pinned or the deployment
  // blacklisted. Every fold a fence-pressure pass lands is a member span, audited fold
  // by fold against the state as it stood when that pass ran. The ladder takes what the
  // class law offers, and the request that still does not fit is aborted rather than
  // transmitted.
  const zoneState = () => {
    const value = materialized(runtime);
    return {
      state: value,
      snapshot: context.mapActiveContext({
        sessionId: runtime.built.sessionId,
        eventMessages: runtime.messages,
        contextEntries: runtime.branch,
        contextWindow: 30_600,
        netBudget: true,
        thresholds,
      }),
    };
  };
  /** The folds a pass created, mapped back to the source indices they cover. */
  const foldsLandedBetween = (pre, post) => {
    const indexOf = new Map(pre.snapshot.mapped.flatMap((item) =>
      item.ref ? [[json.objectRefKey(item.ref), item.index]] : []));
    const known = new Set(pre.state.folds.map((fold) => fold.id));
    return post.state.folds.filter((fold) => !known.has(fold.id)).map((fold) => ({
      id: fold.id,
      kind: fold.kind,
      indices: context.flattenFoldRefs(fold, post.state)
        .map((ref) => indexOf.get(json.objectRefKey(ref)) ?? -1),
    }));
  };
  // Drain first, so the fence phase measures the law rather than a backlog: the ladder
  // takes everything the zone law offers, in as many passes as the widening reach needs,
  // and only then does the untakeable inflow arrive.
  let drained = false;
  for (let round = 0; round < 8 && !drained; round += 1) {
    const from = runtime.appended.length;
    await measure(runtime, 26_100 + round * 10, 34_000);
    await project(runtime);
    await settle();
    drained = contextEvents(runtime, from)
      .filter((record) => record.kind === "context.commit" && record.deferred === false).length === 0;
  }
  assert(drained, "The ladder never finished taking what the zone law offers");
  const beforeFence = runtime.appended.length;
  const abortsBeforeFence = runtime.aborts;
  // Declared untakeable, both ways at once: the deployment blacklisted the producer, so
  // no tool batch forms over it, and the agent pins the call inside each batch, so no
  // chapter span may contain it. The pin lands before the payload exists, which is the
  // order an agent actually works in and leaves no pass where the mass was takeable.
  const untakeable = new Set();
  const landedAtFence = [];
  for (let step = 0; step < 5; step += 1) {
    runtime.appendMessage({
      role: "user", content: [{ type: "text", text: `Fence stage ${step}.` }], timestamp: 960 + step,
    }, "fence-inflow");
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: `fence-${step}`, name: "fence_stream", arguments: { path: `fence-${step}.txt` } }],
      stopReason: "toolUse",
      timestamp: 960 + step,
    }, "fence-inflow");
    const callEntryId = runtime.branch.at(-1).id;
    const callIndex = runtime.messages.length - 1;
    const beforePin = zoneState();
    // The agent can only name a stage the runtime has seen, so the call is exposed for
    // exactly one pass before its pin lands. Anything the ladder takes in that pass was
    // genuinely takeable when it took it, and the assertions below still hold it to the
    // zone law; the pin counts from the moment it exists, which is what a pin means.
    await project(runtime);
    await settle();
    const pinned = await toolCall(runtime, { action: "protect", ids: [callEntryId] });
    assert.equal(pinned.details.protectedRefs, step + 1,
      `The fence-${step} pin did not hold: ${JSON.stringify(pinned.details).slice(0, 200)}`);
    untakeable.add(callIndex);
    landedAtFence.push(...foldsLandedBetween(beforePin, zoneState())
      .map((fold) => ({ ...fold, pre: beforePin })));
    const beforeResult = zoneState();
    runtime.appendMessage({
      role: "toolResult",
      toolCallId: `fence-${step}`,
      toolName: "fence_stream",
      content: [{ type: "text", text: `Fence ${step}: ${"f".repeat(12_000)}` }],
      isError: false,
      timestamp: 960 + step,
    }, "fence-inflow");
    untakeable.add(runtime.messages.length - 1);
    runtime.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Fence stage ${step} done.` }],
      stopReason: "stop",
      timestamp: 960 + step,
    }, "fence-inflow");
    await project(runtime);
    await settle();
    landedAtFence.push(...foldsLandedBetween(beforeResult, zoneState())
      .map((fold) => ({ ...fold, pre: beforeResult })));
  }
  const beforeFenceMeasurement = zoneState();
  await measure(runtime, 31_500, 34_000);
  await project(runtime);
  await settle();
  landedAtFence.push(...foldsLandedBetween(beforeFenceMeasurement, zoneState())
    .map((fold) => ({ ...fold, pre: beforeFenceMeasurement })));
  for (const fold of landedAtFence) {
    assert(fold.indices.length > 0 && fold.indices.every((index) => index >= 0),
      `Fold ${fold.id} landed on evidence outside the window`);
    assert(fold.indices.every((index) => !untakeable.has(index)),
      `Fold ${fold.id} took pinned or blacklisted evidence at the fence`);
    // Each kind against the tail its own renderer protects: a tool-result fold answers
    // to the tool tail, everything else to the chapter tail.
    const tail = fold.kind === "tool-result"
      ? fold.pre.snapshot.toolProtectedIndices
      : fold.pre.snapshot.protectedIndices;
    assert(fold.indices.every((index) => !tail.has(index)),
      `Fold ${fold.id} reached into the fresh tail at the fence`);
  }
  assert(runtime.aborts > abortsBeforeFence,
    "An untransmittable request went out instead of being aborted");
  // One more crossing, once the ladder has taken everything the zone law offers and only
  // the declared-untakeable mass is left. THIS is the starved pass now: the trigger
  // fires, the selectors have nothing, and the deferral has to say so.
  await measure(runtime, 31_600, 34_000);
  await project(runtime);
  await settle();
  // AND IT SAYS SO. A commit pass that reaches the adjudication with nothing proposable
  // used to return silently, which is how the rep-2 starvation stayed invisible for 25
  // stages: the last call announced 274,173 tokens of unmarked stale spans and the pass
  // that answered it left no record that a commit had even been attempted. It names
  // itself now, and it carries the remainder beside the emptiness so the two facts sit
  // on one record. The remainder counts MEMBER spans, which is the same enumeration the
  // selectors propose out of, so mass it names and marks it cannot make are the same
  // contradiction rather than two different questions. A starved window and a merely
  // exhausted one are told apart by the remainder alone: nonzero means the members are
  // held by a pin, a blacklist or the guard, and zero means there is nothing to hold.
  const nothingProposable = contextEvents(runtime, beforeFence).filter((record) =>
    record.kind === "context.commit" && record.reason === "nothing-proposable");
  assert(nothingProposable.length >= 1,
    "A commit pass with nothing to propose returned silently");
  for (const record of nothingProposable) {
    assert.equal(record.deferred, true);
    assert.equal(record.applied_marks, 0);
    assert.equal(record.pending_marks, 0);
    assert.equal(typeof record.unmarked_stale_spans, "number",
      "The deferral reported no remainder, so it says nothing the silence did not");
    assert.equal(record.stale_boundary, undefined,
      "The deferral still carries a positional boundary");
  }

  // (c) AND THE ROLLBACK IS THE RECOVERY. The one thing left that can shorten this
  // window is taking the request that failed off the branch.
  const fenceRollbackFrom = runtime.appended.length;
  await overflow(runtime);
  const fenceRollback = contextEvents(runtime, fenceRollbackFrom)
    .find((record) => record.kind === "context.rollback");
  assert(fenceRollback, "The fence-level session got no rollback");
  assert.equal(fenceRollback.armed, true);
  assert.equal(fenceRollback.replayed, true);
  assert.equal(runtime.steered.length, 1, "The recovery queued more than one steered message");
  assert(!runtime.branch.some((entry) => entry.message?.stopReason === "error"),
    "The rejected entry is still on the live branch");

  return {
    freshBoundary: snapshot.freshBoundary,
    proposedSpans: proposed.length,
    deepestProposedIndex: Math.max(...reachedIndices),
    fenceSnapshotDeleted: true,
    latchedCommits: latched.length,
    drainRounds: drained,
    fenceFolds: landedAtFence.length,
    fenceFoldDeepestIndex: landedAtFence.length ? Math.max(...landedAtFence.flatMap((fold) => fold.indices)) : -1,
    untakeableIndices: untakeable.size,
    nothingProposableRecords: nothingProposable.length,
    fenceAborts: runtime.aborts,
    fenceRollbackReplayed: fenceRollback.replayed,
  };
}

/**
 * THE BAND TOP COMMITS IN A SESSION THAT NEVER CLOSES A TURN.
 *
 * Measured 2026-08-10 (luna-20260810 pifold rep 2, sealed run 3705e0d4). One user
 * message and 24 assistant messages, every one of them stopReason "toolUse", so
 * `completeTurns` was empty for the whole session and `currentTurnBoundary` sat at -1.
 * The last call fired at 0.804 occupancy announcing 19 unmarked stale spans worth
 * 274,173 tokens, and no commit of any kind ever fired. The window climbed to 375,830
 * estimated tokens and the provider rejected it twice.
 *
 * Two independent defects each emptied the automatic selector on that shape, and either
 * alone was enough to starve it. The automatic reach was a position, and it was pinned
 * to the last CLOSED turn, which on this shape does not exist: every rung read an empty
 * region. And the commit pass handed `currentTurnRefKeys` to the top-up as an exclusion,
 * which on this shape is the entire window, so nothing was ever proposed and the guard
 * waiver written for exactly this starvation never had a guarded mark to count.
 *
 * The reach is not a position any more, so the first defect has no expression left to
 * come back in: what the selectors read is membership, and a completed tool batch is a
 * member whether or not its turn ever closed. What this gate holds unchanged is the
 * second half, which is the half that still has a moving part: the open turn is excluded
 * at the COMMIT, where the waiver can release it, and never at the proposal, where it
 * cannot. Counterfactual on the sealed state at ordinal 45: either fix alone yields 0
 * marks, both together yield 13 marks, 11 applied under a guard waiver of 11, about
 * 167,321 tokens freed.
 */
async function gateOpenTurnCommits() {
  // THE FIXTURE IS THE SHAPE. One user message, then nothing but tool-calling assistants
  // and their results. No terminal assistant anywhere, including the measurement
  // messages, so no turn ever closes.
  const sessionId = "open-turn-test";
  const window = 100_000;
  const providerInputBudget = 90_000;
  const batches = 24;
  const resultChars = 12_000;
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
  assert.equal(context.currentTurnBoundary(snapshot), -1,
    "A terminal assistant message reached the open-turn fixture");
  assert(bytesOf(runtime.messages) >= batches * resultChars,
    "The fixture is smaller than the batches it declares");
  assert(snapshot.policy.minToolChars <= resultChars,
    "The fixture's results are under the minimum a tool batch may fold");

  // (b) THE DIRECT REGRESSION ASSERTION. Foldability is membership, so a session that
  // never closed a turn still holds members. The old law made the automatic reach a byte
  // prefix clamped to the fresh boundary, which is 0 here, so every rung saw nothing.
  assert.equal(snapshot.freshBoundary, 0,
    "The fresh boundary is not zero, so the clamp is not being measured");
  const members = context.automaticToolBatches(snapshot, context.emptyActiveContextState(sessionId));
  assert(members.length > 0,
    "No completed batch is a member in a session that never closed a turn: the clamp is back");
  const newestIndex = snapshot.messages.length - 1;
  assert(!members.some((batch) => batch.indices.includes(newestIndex)),
    "The newest batch is a member, so the fresh tail bounds nothing");

  // (c) CLIMB WITH ZERO AGENT MARKS. Every measurement stops on toolUse, so the turn
  // stays open through the whole climb and the agent never marks anything itself.
  const bandTop = context.DEFAULT_THRESHOLDS.maxTarget * providerInputBudget;
  await measure(runtime, 60_000, window, undefined, "toolUse");
  await project(runtime);
  await settle();
  await measure(runtime, Math.ceil(bandTop) + 2_000, window, undefined, "toolUse");
  await project(runtime);
  await settle();

  // (d) THE CONSISTENCY INVARIANT, checked at the state the boundary will find.
  //
  // Unmarked stale mass the selector cannot propose is a window that will starve no
  // matter how often the boundary fires. In rep 2 that was 19 spans and 274,173 tokens,
  // which is the contradiction this asserts away.
  const exposureSnapshot = context.mapActiveContext({
    sessionId,
    eventMessages: runtime.messages,
    contextEntries: runtime.branch,
    contextWindow: providerInputBudget,
    netBudget: true,
  });
  const exposureState = materialized(runtime, sessionId);
  const remainder = context.unmarkedRemainder(exposureSnapshot, exposureState, 4);
  assert(remainder.spans > 0, "There is no unmarked stale mass here, so there is nothing to starve on");
  assert(context.selectAutomaticSpan(exposureSnapshot, exposureState) !== null,
    `${remainder.spans} unmarked stale spans stand that the selector cannot propose`);
  // AND THE SHAPE OF THE DEFECT, pinned so it cannot come back by another route. The
  // open turn is the WHOLE window here, so excluding it at proposal time leaves the
  // selector nothing; that is why the guard is adjudicated at the commit, where it has a
  // waiver, and never at the proposal, where it does not.
  const guarded = context.currentTurnRefKeys(exposureSnapshot);
  assert.equal(guarded.size, batches,
    "The guard does not hold the whole window, so the starving shape is not being measured");
  assert.equal(context.selectAutomaticSpan(exposureSnapshot, exposureState, guarded), null,
    "Excluding the open turn at proposal time left something proposable, so this fixture " +
      "no longer demonstrates why the exclusion had to move to the commit");

  // THE COMMIT, AT THE BOUNDARY, ON A SESSION THAT NEVER CLOSES A TURN. Every mark on
  // this shape belongs to the open turn, so applying any of them needs the guard waiver,
  // and the waiver only releases a STARVED commit once occupancy has reached
  // `refoldRatio` of the serving budget. Below that the boundary marks and holds, which
  // is the deferral the guard is for.
  const backstop = context.ACTIVE_CONTEXT_POLICY.refoldRatio * providerInputBudget;
  assert(backstop > bandTop, "The backstop is not above the band top on this deployment");
  const commitFrom = runtime.appended.length;
  await measureAndCommit(runtime, Math.ceil(backstop) + 3_000, window, undefined, "toolUse");
  const commit = contextEvents(runtime, commitFrom)
    .find((record) => record.kind === "context.commit" && record.deferred === false);
  assert(commit, "The boundary committed nothing in a session that never closed a turn");
  assert(commit.applied_marks > 0, `The commit applied ${commit.applied_marks} marks`);
  assert(commit.freed_tokens > 0, `The commit freed ${commit.freed_tokens} tokens`);
  assert(commit.waived_marks > 0,
    "The guard was not waived, so the commit did not apply the open turn's own evidence");
  // AND THE COMMIT IS AS DEEP AS THE THERMOSTAT ASKED. This is the second defect's own
  // assertion: the top-up is what carries a commit from whatever the per-pass ladder
  // happened to mark down to the target line, and handing it the open turn as an
  // exclusion made it propose nothing at all on this shape, because here the open turn
  // is the entire window. A commit that reaches the target only by the marks a few
  // measurement passes left lying around is the starvation with a smaller number on it.
  assert(commit.topup_marks > 0,
    "The top-up proposed nothing on a window that is one open turn");
  assert.equal(commit.shortfall_share, 0,
    `The commit fell ${commit.shortfall_share} short of its freeing target`);

  // AND THE PROTECTIONS SURVIVE THE FIX. The newest batch is inside the fresh tail, and
  // the fresh tail is a byte tail in `protectedIndices`, not a consequence of the clamp.
  const committedState = materialized(runtime, sessionId);
  const foldedKeys = new Set(committedState.folds.flatMap((fold) =>
    fold.parts.flatMap((part) => (part.kind === "raw" ? [part.ref.entryId] : []))));
  const newest = resultEntryIds.at(-1);
  assert(foldedKeys.size > 0, "Nothing was folded, so the fresh tail proves nothing");
  assert(!foldedKeys.has(newest), "The commit folded the newest batch out of the fresh tail");
  const projection = await project(runtime);
  const projected = json.stableStringify(projection.messages);
  assert(projected.includes(`Open ${batches - 1}: `),
    "The newest batch did not survive raw in the projection");
  assert(!projected.includes(`Open 0: ${"o".repeat(resultChars)}`),
    "The oldest batch survived raw, so the commit moved nothing the stale zone offered");

  return {
    completeTurns: snapshot.completeTurns.length,
    currentTurnBoundary: context.currentTurnBoundary(snapshot),
    freshBoundary: snapshot.freshBoundary,
    memberBatches: members.length,
    messages: snapshot.messages.length,
    unmarkedStaleSpans: remainder.spans,
    guardedRefKeys: guarded.size,
    proposableWithoutTheExclusion: true,
    proposableWithTheExclusion: false,
    appliedMarks: commit.applied_marks,
    topUpMarks: commit.topup_marks,
    waivedMarks: commit.waived_marks,
    shortfallShare: commit.shortfall_share,
    freedTokens: commit.freed_tokens,
    newestBatchFolded: false,
  };
}

async function gateAgentSpansNest() {
  const forest = await chapterForest(2);
  const roots = forest.state.folds.filter((fold) => fold.parentId === null);
  assert.equal(roots.length, 2, "The fixture did not build the two chapters to fold across");
  const childFold = roots[0];
  // One span: two chapters the automation-free fixture already folded, plus the raw turn
  // beside them. Under the old law this had no constructible reading at all.
  const ids = [forest.turnEntries[0][0], forest.turnEntries[2].at(-1)];
  const candidate = context.manualFoldCandidate(forest.snapshot, forest.state, ids);
  assert.equal(candidate.kind, "chapter");
  const foldParts = candidate.parts.filter((part) => part.kind === "fold");
  const rawParts = candidate.parts.filter((part) => part.kind === "raw");
  assert.equal(foldParts.length, 2, "The agent span did not take the chapters in whole");
  assert(rawParts.length >= 1, "The agent span carried no interstitial raw material");
  const committed = await commitCandidate(forest.state, forest.snapshot, candidate, {
    brief: "Grouped two folded chapters and the raw turn beside them; every byte stays recoverable.",
    now: 9,
  });
  const parent = committed.state.folds.find((fold) => fold.id === committed.prepared.id);
  assert.equal(parent.parentId, null);
  for (const root of roots) {
    const nested = committed.state.folds.find((fold) => fold.id === root.id);
    assert(nested, "Nesting removed a fold instead of re-parenting it");
    assert.equal(nested.parentId, parent.id, "A swallowed fold was not re-parented");
  }

  // One level, both ways. The parent serves its stored span: children placeheld, the raw
  // between them verbatim. The child id serves its own bytes in one hop.
  const peekArguments = {
    state: committed.state,
    entries: forest.entries,
    sessionId: forest.sessionId,
    maximumBytes: context.ACTIVE_CONTEXT_POLICY.maxChapterChars,
  };
  const peeked = context.peekFoldSource({ ...peekArguments, foldId: parent.id });
  const interstitial = String(context.contentText(
    context.exactMapped(forest.snapshot, rawParts[0].ref).message,
  )).slice(0, 64);
  const beneath = String(context.contentText(
    context.exactMapped(forest.snapshot, context.flattenFoldRefs(childFold, committed.state)[0]).message,
  )).slice(0, 64);
  assert(peeked.source.includes(childFold.id), "The parent's span named no child");
  assert(peeked.source.includes(interstitial), "The parent's span lost its interstitial raw bytes");
  assert.equal(peeked.source.includes(beneath), false,
    "The parent's span leaked bytes from under a child placeholder");
  const peekedChild = context.peekFoldSource({ ...peekArguments, foldId: childFold.id });
  assert(peekedChild.source.includes(beneath), "A child id did not peek its own verbatim source");
  assert.equal(peekedChild.truncated, false);

  // The pin is the whole refusal. It names the fold and the release valve.
  const pinned = {
    ...forest.state,
    protected: context.flattenFoldRefs(childFold, forest.state).map((ref) => structuredClone(ref)),
  };
  assert.throws(
    () => context.manualFoldCandidate(forest.snapshot, pinned, ids),
    (error) => error.message.includes(childFold.id) && /unprotect/.test(error.message),
    "A span that would swallow a pinned fold was not refused by name",
  );
  // Even a caller that may name protected spans, which every agent mark is, cannot
  // nest a pin: the relaxation is about eligibility, never about the promise.
  assert.throws(
    () => context.manualFoldCandidate(forest.snapshot, pinned, ids, { allowProtected: true }),
    /is pinned/,
    "The mark path nested a pinned fold",
  );
  return {
    nestedChildren: foldParts.length,
    interstitialRawParts: rawParts.length,
    peekRevealedLevels: 1,
    childPeekDepth: "verbatim",
    pinRefused: true,
  };
}

/**
 * THE public surface: five options, and nothing else reaches the runtime.
 *
 * Every name outside the five is refused, and a name that was RENAMED is refused by its
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
  // The whole surface, exercised together: five names, all accepted at once.
  const surface = makeRuntime(built, {
    packageRegistration: true,
    retiredOptions: {
      thresholds: context.DEFAULT_THRESHOLDS,
      summarizer: { provider: "openai", model: "gpt-brief", effort: "low" },
      providerInputBudget: 90_000,
      blacklistAutoFoldTools: new Set(["repo_stage"]),
      guidance: { thresholdNotices: true, actionResponses: true },
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
  // And the internal brief-generator seam, which `summarizer` is the declarative form of.
  // The message names the values that remain, so it must no longer offer "deterministic".
  assert.throws(() => register({ summarizeContextSpan: async () => ({ brief: "x" }) }),
    /choose a brief generator with summarizer \("session" or \{ provider, model, effort \}\)/);
  // The MECHANISM that lost its switch. The switch is refused by name and the message says
  // the mechanism is on, not that the name is unknown: a deployment reading "unknown
  // option" would conclude the writes had stopped.
  assert.throws(() => register({ evidenceIngestion: false }),
    /evidenceIngestion is no longer an option: evidence ingestion is always on/);
  // The refused VALUE, which no name-level check can catch: the option is on the surface
  // and this one setting of it is not. The message says the deterministic brief is still
  // the failure fallback, so the caller knows it kept the behavior it wanted.
  assert.throws(() => register({ summarizer: "deterministic" }),
    /summarizer has no "deterministic" value: the deterministic brief is the automatic fallback/);
  // A name this package never sold at all is refused with the whole surface named, so a
  // typo reports the five rather than failing somewhere downstream at runtime.
  assert.throws(() => register({ maxTarget: 0.8 }),
    /maxTarget is not a pi-fold option: the surface is thresholds, summarizer, providerInputBudget, blacklistAutoFoldTools, guidance/);
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
    publicOptions: 5,
    renamesRefusedByOldName: renamed.length,
    identityOptionsRefused: 6,
    unknownNamesRefused: 2,
    refusedValues: 1,
    internalSeamReachableFromPackageEntry: false,
  };
}

/**
 * EVERY completed tool batch folds unmarked. The blacklist is the exception, not the rule.
 *
 * The list ran the other way until 2026-08-10: an allow-list seeded with pi's four
 * built-in readers, so a deployment's own tools were unfoldable by the ladder until
 * someone remembered to name them, and the ladder starved on exactly the results that
 * filled the window. Foldability was never the protection. The pins, the three zones and
 * the fresh tail are, and they hold for a blacklisted tool and an ordinary one alike,
 * which is why the default list is empty and the zone leg below is part of this gate.
 *
 * `bash` is the probe on purpose: it is not one of the four names the old allow-list
 * carried, so every assertion here is one the previous surface would have failed.
 */
async function gateEveryToolBatchFoldsUnmarked() {
  // The classifier, before any ladder: an arbitrary tool is foldable whatever its
  // arguments look like, and blacklisting it is the only thing that changes the answer.
  assert.equal(context.isAutoFoldableToolCall("bash", { command: "make" }), true);
  assert.equal(context.isAutoFoldableToolCall("write", { path: "x", contents: "y" }), true);
  assert.equal(
    context.isAutoFoldableToolCall("bash", { command: "make" }, "pi_fold_context", new Set(["bash"])),
    false,
  );
  // The one carve-out survives the inversion: the context tool's own MUTATING calls are
  // never auto-foldable, because a tool call may not cause a rewrite of its own batch.
  // Its read-only actions still are.
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { action: "fold", ids: "e1" }), false);
  assert.equal(context.isAutoFoldableToolCall("pi_fold_context", { action: "status" }), true);

  const shape = { turns: 8, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const built = makeFixture(shape);
  const bashResultIds = built.turnEntries.map((ids) => ids[2]);
  // The rung selects the stale bash batch with no option set anywhere.
  const state = context.emptyActiveContextState(built.sessionId);
  const [candidate] = context.selectAutomaticToolBatch(built.snapshot, state);
  assert(candidate, "The tool rung selected nothing from an unlisted tool's completed batches");
  assert.equal(candidate.kind, "tool-result");
  assert(candidate.sourceRefs.every((ref) => bashResultIds.includes(ref.entryId)));

  // Named in the blacklist, the same transcript offers the rung nothing.
  const blacklisted = context.mapActiveContext({
    sessionId: built.sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: shape.contextWindow,
    blacklistAutoFoldTools: new Set(["bash"]),
  });
  assert.deepEqual(context.selectAutomaticToolBatch(blacklisted, state), [],
    "A blacklisted tool's completed batch was still selected unmarked");

  // The protections did not move. Foldability grants membership, never a waiver: every
  // ref the rung took sits outside the guaranteed-raw fresh tail, and it took the
  // stalest batch rather than the freshest.
  const takenIndices = candidate.sourceRefs.map((ref) =>
    built.snapshot.mapped.findIndex((item) => item.ref?.entryId === ref.entryId));
  assert(takenIndices.length && takenIndices.every((index) =>
    index >= 0 && !built.snapshot.toolProtectedIndices.has(index)),
  "The ladder reached into the fresh tail once the tool became foldable");
  assert(!candidate.sourceRefs.some((ref) => ref.entryId === bashResultIds.at(-1)),
    "The rung took the freshest batch");

  // End to end through the ladder, at the default registration a host gets: the epoch
  // commits and a tool-result fold covers bash results nobody marked and nobody listed.
  const runtime = makeRuntime(makeFixture(shape));
  await startRuntime(runtime);
  await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  const toolFolds = materialized(runtime).folds.filter((fold) => fold.kind === "tool-result");
  assert(toolFolds.length, "The running ladder never folded an unlisted tool's batch");
  assert(toolFolds.some((fold) =>
    fold.parts.some((part) => bashResultIds.includes(part.ref?.entryId))),
  "The tool-result folds covered something other than the bash results");
  assert.equal(contextEvents(runtime).filter((record) =>
    record.kind === "context.fold" && record.origin === "agent").length, 0,
  "The fold under test was agent-marked rather than automatic");

  // And with the tool blacklisted, the running ladder claims no tool batch at all. The
  // chapter rung may still take the span; the tool rung, which is what the list governs,
  // may not.
  const barred = makeRuntime(makeFixture(shape), { blacklistAutoFoldTools: new Set(["bash"]) });
  await startRuntime(barred);
  await runtimeCommit(barred, { tokens: 95_000, contextWindow: 100_000 });
  assert.deepEqual(
    materialized(barred).folds.filter((fold) => fold.kind === "tool-result"), [],
    "The blacklisted tool's results were folded by the tool rung anyway",
  );
  return {
    defaultBlacklist: [...context.AUTO_FOLD_BLACKLIST_DEFAULT],
    unlistedToolSelected: candidate.sourceRefs.length,
    blacklistedToolSelected: 0,
    selectionOutsideTheFreshTail: true,
    ladderToolFolds: toolFolds.length,
    contextToolMutatingActionsFoldable: false,
  };
}

/**
 * The guidance option: two booleans, on by default, and off means absent.
 *
 * Shane's ruling is that notices and action responses are optional with the default yes,
 * so this pins both halves. Off has to mean the carriers do not exist, not that they
 * render empty: an empty carrier still occupies prefix positions. And it has to change
 * NOTHING else, because the two surfaces are prose about the mechanism, never the
 * mechanism, and folding a session must not depend on whether the runtime narrates it.
 */
async function gateGuidanceOption() {
  // ONE boolean. The threshold-notice switch retired with the notices themselves: a
  // switch over something nothing emits is a setting a deployment can turn off and
  // observe no difference from, which is worse than no setting at all.
  assert.deepEqual({ ...context.DEFAULT_GUIDANCE }, { actionResponses: true });
  // Set whole or partially, but never with a key this option does not have: a typo that
  // silently keeps the default is how a deployment believes it turned something off.
  assert.throws(() => makeRuntime(makeFixture({ turns: 4 }), { guidance: { notices: false } }).tools,
    /guidance has no notices setting/);
  assert.throws(() => makeRuntime(makeFixture({ turns: 4 }), { guidance: { thresholdNotices: false } }).tools,
    /guidance has no thresholdNotices setting/);
  assert.throws(() => makeRuntime(makeFixture({ turns: 4 }), { guidance: { actionResponses: "no" } }).tools,
    /guidance.actionResponses must be a boolean/);
  assert.throws(() => makeRuntime(makeFixture({ turns: 4 }), { guidance: true }).tools,
    /guidance must be an object/);

  // The action response is the mark's prose, and off removes the prose alone: the same
  // mark is still accepted, still pending, still carries its accounting.
  const built = makeFixture({ turns: 12, resultChars: 12_000, contextWindow: 100_000 });
  const staleSpan = [built.turnEntries[1][0], built.turnEntries[1].at(-1)];
  const markOnce = async (guidance) => {
    const runtime = makeRuntime(built, guidance ? { guidance } : {});
    await startRuntime(runtime);
    return await toolCall(runtime, { action: "fold", ids: staleSpan });
  };
  const marked = await markOnce(undefined);
  assert.equal(typeof marked.details.awareness, "string", "The default swallowed the response");
  const silentMark = await markOnce({ actionResponses: false });
  assert.equal(silentMark.details.awareness, undefined, "A silenced action still answered");
  assert.equal(silentMark.details.activation, undefined);
  assert.equal(silentMark.isError, marked.isError);
  assert.equal(silentMark.details.pendingMarks, marked.details.pendingMarks,
    "Silencing the response changed what the mark did");
  assert.equal(silentMark.details.ok, marked.details.ok);
  assert.equal(silentMark.details.deferred, marked.details.deferred);
  return {
    defaultOn: true,
    guidanceKeys: Object.keys(context.DEFAULT_GUIDANCE),
    silencedResponseKeys: ["awareness", "activation"],
    markUnchangedWhenSilent: true,
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
async function gateSurfacingDeliveryRidesTheBoundary() {
  const source = await readFile(join(projectRoot, "extensions", "active-context.ts"), "utf8");
  const carriers = [...source.matchAll(/deliverSurfacing\(snapshot, "([a-z]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(carriers.sort(), ["rider"],
    "The slate is delivered somewhere other than the commit-boundary carrier");
  assert.equal(/customType: surfacingProjectionType/.test(source), false,
    "A surfacing carrier of its own reappeared in the projection");

  const runtime = await epochToolRuntime({ turns: 12, resultChars: 16_000 });
  await measure(runtime, 40_000, 100_000);
  const suggestions = () => contextEvents(runtime).filter((record) => record.kind === "context.suggestion");
  const before = suggestions().length;
  const status = (await toolStatus(runtime)).details.automatic.surfacing;
  for (const key of ["slate", "line", "ledger", "silenced", "considered", "divergent", "slateSize"]) {
    assert(Object.hasOwn(status, key), `The status surfacing block is missing ${key}`);
  }
  assert.equal(status.slateSize, context.SURFACING_SLATE_SIZE);
  assert(status.slate.length <= context.SURFACING_SLATE_SIZE);
  const ledgerBefore = json.stableStringify(materialized(runtime).surfacing ?? []);
  await toolStatus(runtime);
  assert.equal(json.stableStringify(materialized(runtime).surfacing ?? []), ledgerBefore,
    "Asking for status moved the suppression ledger");
  assert.equal(suggestions().length, before, "Asking for status issued a suggestion");
  return {
    pushCarriers: carriers,
    ownCarrier: "none",
    statusIsARead: true,
    statusSlate: status.slate.length,
    slateSize: status.slateSize,
  };
}

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
async function gateBriefUpgradesRideTheBoundary() {
  const shape = { turns: 12, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const requests = [];
  const upgradeText = (candidateId) =>
    `The folded span records the completed bash inspection under ${candidateId} and its factual result.`;
  const built = makeFixture(shape);
  const runtime = makeRuntime(built, {
    summarizeContextSpan: async (request) => {
      requests.push(request);
      return briefAnswer(request, upgradeText);
    },
  });
  await startRuntime(runtime);

  // An agent-written brief on a stale span, so this run carries both provenances into
  // the same commits.
  const suppliedBrief = "An early completed task stays exactly recoverable behind this fold.";
  const suppliedMark = await toolCall(runtime, {
    action: "fold",
    ids: [built.turnEntries[1][0], built.turnEntries[1].at(-1)],
    brief: suppliedBrief,
  });
  assert.equal(suppliedMark.details.ok, true);

  // BOUNDARY N.
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  const afterFirst = materialized(runtime);
  const deterministic = afterFirst.folds.filter((fold) => fold.provenance.kind === "deterministic");
  assert(deterministic.length, "The ladder committed no deterministic fold to upgrade");
  const supplied = afterFirst.folds.filter((fold) => fold.provenance.kind === "supplied");
  assert.equal(supplied.length, 1, "The agent's supplied brief did not commit as one fold");
  const target = deterministic[0];
  const deterministicBrief = target.brief;

  // The generator was handed the request contract, over the fold's own source.
  await settle();
  assert(requests.length, "No brief was requested for a fold committed deterministic");
  const request = requests.find((item) => requestFoldIds(item).includes(target.id));
  assert(request, `No brief request named the committed fold ${target.id}`);
  // Orientation, the cap and the signal belong to the CALL; the source belongs to each
  // span, because one call now briefs the whole commit.
  for (const field of ["beforeText", "beforeSha256", "afterText", "afterSha256",
    "maxBriefChars", "signal"]) {
    assert(request[field] !== undefined, `The upgrade request omitted ${field}`);
  }
  const targetSpan = request.spans.find((span) => span.candidateId === target.id);
  for (const field of ["sourceText", "sourceSha256", "sourceRefs"]) {
    assert(targetSpan[field] !== undefined, `The upgraded span omitted ${field}`);
  }
  assert.equal(targetSpan.sourceSha256, json.sha256Text(targetSpan.sourceText));
  assert.equal(request.maxBriefChars, context.ACTIVE_CONTEXT_POLICY.maxBriefChars);

  // BETWEEN THE BOUNDARIES: the brief is written and waiting, and not one byte moved.
  const between = bytesOf((await project(runtime)).messages);
  await settle();
  assert.equal(bytesOf((await project(runtime)).messages), between,
    "A finished brief upgrade rewrote the projection between commits");
  const midState = materialized(runtime);
  const midFold = midState.folds.find((fold) => fold.id === target.id);
  assert.equal(context.foldProvenance(midFold, midState).kind, "deterministic",
    "The upgrade applied outside a commit boundary");
  assert.equal(context.foldBrief(midFold, midState), deterministicBrief);

  // BOUNDARY N+1: new turns age in, the epoch commits again, and the upgrade rides it.
  const aged = makeFixture({ ...shape, turns: 24, sessionId: built.sessionId });
  for (const entry of aged.entries.slice(built.entries.length)) runtime.branch.push(entry);
  runtime.messages.length = 0;
  runtime.messages.push(...aged.messages);
  const from = runtime.appended.length;
  await runtimeCommit(runtime, { tokens: 92_000, contextWindow: 100_000, suffix: "second" });
  const commits = contextEvents(runtime, from).filter((record) =>
    record.kind === "context.commit" && record.deferred === false);
  assert(commits.length, "The second boundary never committed");
  const carrier = commits.find((record) => record.brief_upgrades > 0);
  assert(carrier, "No commit record reported the upgrade it carried");
  // The ceiling on one boundary is the work the lane can have outstanding, a queue's worth
  // waiting plus the calls in flight, because every finished brief lands. In FOLDS, since
  // that is what applies: each of those calls carries up to a batch width of spans.
  const outstandingCalls = context.MAX_BRIEF_UPGRADE_QUEUE + context.MAX_BRIEF_UPGRADES_IN_FLIGHT;
  const outstandingBound = outstandingCalls * context.MAX_BRIEF_BATCH_SPANS;
  assert(carrier.brief_upgrades <= outstandingBound,
    "A single boundary applied more upgrades than the lane can have outstanding");
  // The same bound in the unit the constants are written in, so a lane that quietly started
  // more calls than it may cannot hide inside a generous fold count.
  assert(carrier.brief_upgrade_calls <= outstandingCalls,
    "The lane had more calls queued and in flight than its constants allow");
  assert(carrier.brief_upgrade_ids.split(",").includes(target.id),
    "The commit record did not name the fold it upgraded");
  const afterSecond = materialized(runtime);
  const upgradedFold = afterSecond.folds.find((fold) => fold.id === target.id);
  // Read through the presentation lens, because a fold RECORD is immutable: the brief
  // and its generator live in the override map the agent's own rebrief writes to.
  const upgradedProvenance = context.foldProvenance(upgradedFold, afterSecond);
  assert.equal(upgradedProvenance.kind, "model", "The deterministic brief was never upgraded");
  assert.equal(upgradedProvenance.model, "gpt-5.6-luna");
  assert.equal(upgradedProvenance.provider, "openai-codex");
  assert.equal(context.foldBrief(upgradedFold, afterSecond), upgradeText(target.id));
  assert.notEqual(context.foldBrief(upgradedFold, afterSecond), deterministicBrief);
  // The record itself never moved, which is what keeps the durable ledger append-only.
  assert.equal(upgradedFold.brief, deterministicBrief);
  assert.equal(upgradedFold.provenance.kind, "deterministic");

  // Agent judgment outranks automation: a supplied brief is never sent and never moved.
  const suppliedAfter = afterSecond.folds.find((fold) => fold.id === supplied[0].id);
  assert.equal(context.foldProvenance(suppliedAfter, afterSecond).kind, "supplied",
    "An agent-written brief was upgraded");
  // Its text may have grown by an absorbed sliver, which is the wedge absorber's note
  // and not a rewrite of what the agent said; it is never the generator's brief.
  assert(context.foldBrief(suppliedAfter, afterSecond).startsWith(suppliedBrief),
    "The agent's own words were rewritten");
  assert.equal(context.foldBrief(suppliedAfter, afterSecond).includes(upgradeText(supplied[0].id)), false);
  assert.equal(requests.some((item) => requestFoldIds(item).includes(supplied[0].id)), false,
    "A supplied brief was sent to the generator");

  // THE FAILURE LEG. The deterministic brief stands, and the stream says why.
  let attempts = 0;
  const failing = makeRuntime(makeFixture(shape), {
    summarizeContextSpan: async () => {
      attempts += 1;
      throw new Error("summarizer unavailable for the upgrade lane");
    },
  });
  const failingBuilt = failing.built;
  await startRuntime(failing);
  await runtimeCommit(failing, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const failingAged = makeFixture({ ...shape, turns: 24, sessionId: failingBuilt.sessionId });
  for (const entry of failingAged.entries.slice(failingBuilt.entries.length)) failing.branch.push(entry);
  failing.messages.length = 0;
  failing.messages.push(...failingAged.messages);
  const failedFrom = failing.appended.length;
  await runtimeCommit(failing, { tokens: 92_000, contextWindow: 100_000, suffix: "second" });
  assert(attempts > 0, "The failing generator was never called");
  const failedCommits = contextEvents(failing, failedFrom).filter((record) =>
    record.kind === "context.commit" && record.deferred === false);
  const loud = failedCommits.find((record) => record.brief_upgrade_failures > 0);
  assert(loud, "A generator failure left no trace on any commit record");
  assert.equal(typeof loud.brief_upgrade_error, "string");
  assert(loud.brief_upgrade_error.includes("summarizer unavailable"),
    "The failure record did not carry the generator's own words");
  assert.equal(loud.brief_upgrades, 0);
  const failedState = materialized(failing);
  assert(failedState.folds.some((fold) => context.foldProvenance(fold, failedState).kind === "deterministic"),
    "A failed upgrade did not leave the deterministic brief in place");

  // THE DRAIN RATE.
  //
  // A slow generator is the ordinary case, not the failure case: the live run of
  // 2026-08-10 measured 6.9s, 9.4s and 14.3s a call. What the lane must not do is let
  // that latency, or the gap between ladder passes, decide how many folds carry a model
  // brief. This leg holds every call open on purpose, so what the lane does with the
  // time is observable rather than inferred from a race.
  const held = [];
  let open = 0;
  let peakOpen = 0;
  // Flipped for the window where the test drives no pass at all, so a call that starts
  // inside it can only have been started by another call finishing.
  let passesFrozen = false;
  const slowShape = { turns: 12, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  let grown = makeFixture(slowShape);
  const slow = makeRuntime(grown, {
    summarizeContextSpan: async (request) => {
      open += 1;
      peakOpen = Math.max(peakOpen, open);
      const call = {
        foldIds: requestFoldIds(request),
        openAtStart: open,
        startedWithoutPass: passesFrozen,
        release: null,
      };
      const completion = new Promise((resolve) => { call.release = resolve; });
      held.push(call);
      await completion;
      open -= 1;
      return briefAnswer(request, upgradeText);
    },
  });
  await startRuntime(slow);
  const ageAndCommit = async (round) => {
    const previous = grown.entries.length;
    grown = makeFixture({ ...slowShape, turns: 12 + 12 * round, sessionId: grown.sessionId });
    for (const entry of grown.entries.slice(previous)) slow.branch.push(entry);
    slow.messages.length = 0;
    slow.messages.push(...grown.messages);
    const at = slow.appended.length;
    await runtimeCommit(slow, { tokens: 88_000, contextWindow: 100_000, suffix: `slow-${round}` });
    await settle();
    return contextEvents(slow, at).filter((record) =>
      record.kind === "context.commit" && record.deferred === false);
  };
  let slowCommits = [];
  for (let round = 1; round <= 4; round += 1) slowCommits = [...slowCommits, ...await ageAndCommit(round)];
  assert(slowCommits.length >= 2, "The slow-generator fixture never reached a second boundary");

  // THE BOUND. More folds were offered to the lane than it may brief at once, and it
  // started exactly the constant, so the assertion below is not describing an idle lane.
  assert(held.length > 1, "The lane never held a second generator call open");
  assert.equal(peakOpen, context.MAX_BRIEF_UPGRADES_IN_FLIGHT,
    "The lane did not fill, or overran, its in-flight bound");
  assert.equal(held.length, context.MAX_BRIEF_UPGRADES_IN_FLIGHT,
    "A call started past the in-flight bound while every earlier call was still open");
  const backedUp = slowCommits.filter((record) =>
    record.brief_upgrades_waiting > context.MAX_BRIEF_UPGRADES_IN_FLIGHT);
  assert(backedUp.length, "Nothing was waiting behind the in-flight calls, so the bound never bound");
  assert.equal(slowCommits.every((record) => record.brief_upgrades === 0), true,
    "A brief landed on a boundary while its generator call was still open");

  // WHAT THE JAM COSTS, SAID OUT LOUD. With every call held open the queue fills, and a
  // leaf that arrives at a full queue is not deferred, it is finished: its source is exact
  // active evidence at that commit and a placeholder after it, so no later boundary can
  // brief it. That is the only permanent outcome in this lane and it used to be silent,
  // invisible to `brief_upgrades_waiting` precisely because a shed leaf is what is no
  // longer waiting. A slow generator would have shown falling brief quality and no cause.
  const shed = slowCommits.filter((record) => record.brief_upgrades_abandoned > 0);
  assert(shed.length,
    "The lane jammed for four boundaries and no commit reported shedding a single leaf");
  assert(shed.every((record) =>
    record.brief_upgrades_abandoned_ids.split(",").filter(Boolean).length ===
    record.brief_upgrades_abandoned),
  "A commit reported a shed count its named ids do not account for");
  // The bucket holds two causes. Everything shed HERE is shed for the jam, and a reason
  // list that does not line up with the id list names the wrong fold either way.
  assert(shed.every((record) =>
    record.brief_upgrades_abandoned_reasons.split(",").filter(Boolean).length ===
    record.brief_upgrades_abandoned &&
    record.brief_upgrades_abandoned_reasons.split(",").every((reason) => reason === "queue-full")),
  "A leaf shed by the jam was reported under another cause, or without one");
  // The shed leaves are real folds of this session, not a counter running on its own.
  const shedIds = new Set(shed.flatMap((record) =>
    record.brief_upgrades_abandoned_ids.split(",").filter(Boolean)));
  const slowFolds = new Set(materialized(slow).folds.map((fold) => fold.id));
  assert([...shedIds].every((id) => slowFolds.has(id)),
    "A commit named a shed fold the session does not hold");

  // ANTI-VACUITY. The second call started while the first was still open, so a lane with
  // one slot could not have started it, and no call here finished before its release:
  // under the previous behavior this timeline produces exactly one brief per boundary.
  assert.equal(held[1].openAtStart, 2,
    "The second call did not overlap the first, so the fixture proves nothing about concurrency");

  // A FINISHED CALL STARTS THE NEXT ONE. No pass runs inside this window.
  passesFrozen = true;
  const beforeRelease = held.length;
  held[0].release();
  await settle();
  assert(held.length > beforeRelease,
    "A finished call started nothing; the lane still waits for a ladder pass to drain");
  assert(held.at(-1).startedWithoutPass, "The lane's own drain did not start the last call");
  for (const call of held) call.release();
  await settle();

  // THE BOUNDARY CARRIES EVERY BRIEF THAT IS READY, WHICH IS MORE THAN ONE.
  const drainFrom = slow.appended.length;
  await ageAndCommit(5);
  const drained = contextEvents(slow, drainFrom).filter((record) =>
    record.kind === "context.commit" && record.deferred === false);
  const drainCarrier = drained.find((record) => record.brief_upgrades > 0);
  assert(drainCarrier, "No boundary carried the briefs the generator had written");
  assert(drainCarrier.brief_upgrades > 1,
    `A boundary carried ${drainCarrier.brief_upgrades} upgrade with more than one ready`);
  const carried = drainCarrier.brief_upgrade_ids.split(",").filter(Boolean);
  assert.equal(carried.length, drainCarrier.brief_upgrades);
  assert(drainCarrier.brief_upgrades <= outstandingBound,
    "A drained boundary carried more upgrades than the lane can have outstanding");
  // In CALLS, because one call now carries a whole commit's spans: the claim is that the
  // boundary's briefs came from more than one call, and that every call past the first was
  // started by the lane's own concurrency or its own drain rather than by a ladder pass.
  // Counting folds here would credit a single batch with proving concurrency it never had.
  const contributingCalls = held.filter((call) => call.foldIds.some((id) => carried.includes(id)));
  assert(contributingCalls.length > 1,
    "Every brief the boundary carried came from one call, so concurrency was never exercised");
  const beyondOneSlot = contributingCalls.filter((call) =>
    call.openAtStart > 1 || call.startedWithoutPass);
  assert(beyondOneSlot.length >= contributingCalls.length - 1,
    "The boundary's extra upgrades came from calls a one-slot lane could also have made");
  const drainedState = materialized(slow);
  for (const id of carried) {
    const fold = drainedState.folds.find((item) => item.id === id);
    assert(fold, `The commit record named a fold ${id} that is not in state`);
    const provenance = context.foldProvenance(fold, drainedState);
    assert.equal(provenance.kind, "model", `The upgrade named for ${id} did not land`);
    assert.equal(provenance.model, "gpt-5.6-luna");
    // Still the override map, still an immutable record underneath, at any drain rate.
    assert.equal(fold.provenance.kind, "deterministic");
  }
  // Nothing was held back for a later boundary: what the lane finished, the boundary took.
  const laterCarriers = drained.filter((record) =>
    record !== drainCarrier && record.brief_upgrades > 0);
  assert.equal(laterCarriers.length, 0, "A finished brief waited for a second boundary");
  // Nothing the lane started may outlive the gate: the drain keeps starting calls, so
  // the sweep runs until the queue behind it is empty.
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (const call of held) call.release();
    await settle();
  }

  return {
    upgradedFolds: carrier.brief_upgrades,
    inFlightBound: context.MAX_BRIEF_UPGRADES_IN_FLIGHT,
    peakInFlight: peakOpen,
    queueCap: context.MAX_BRIEF_UPGRADE_QUEUE,
    leavesShedWhileJammed: [...shedIds].length,
    upgradesOnTheDrainedBoundary: drainCarrier.brief_upgrades,
    beyondOneSlot: beyondOneSlot.length,
    projectionStableBetweenBoundaries: true,
    suppliedUntouched: true,
    failureIsLoud: loud.brief_upgrade_failures,
  };
}

/**
 * A reading of the pending marks takes a VIEW; only a write takes a copy.
 *
 * `markSpanRefs` resolves one mark's span and consults the pending marks to tell a
 * span that is merely deferred from one that is gone. Every reading that walks the
 * marks calls it once per mark: the accounting, the eligibility, the staleness, the
 * current-turn guard, the claimed keys, the absorption. While the read accessor deep
 * cloned, that made each pass quadratic in the mark count over an array that grows
 * with the epoch, and it profiled at 21 percent of a 120-turn session, ahead of every
 * projection, digest and hash in the runtime.
 *
 * The copy was never doing anything: nothing mutates what it hands back. So this pins
 * both halves rather than a stopwatch, which would only measure the machine. The read
 * is the state's own array, by IDENTITY, so a copy reintroduced anywhere fails here.
 * Every reading then runs against a FROZEN array, so a reading that starts mutating
 * throws instead of quietly relying on the copy that used to absorb it. And the write
 * path still takes its copy, so the caller's array cannot reach into committed state.
 *
 * The freeze is DEEP, and it has to be. A shallow freeze catches a reading that pushes,
 * splices or sorts the array, and misses the whole class the accessor change actually
 * opened: a write to `mark.brief`, to `mark.parts`, or to a part's own `ref`. While the
 * accessor cloned, that write landed on a throwaway and was invisible; against a view it
 * lands in committed state. Freezing the marks, their parts and the refs inside them is
 * what makes this gate's claim, that a reading which starts mutating throws, true of the
 * objects and not only of the array holding them.
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
async function gateBatchedBriefNamesItsSource() {
  const shape = { turns: 16, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const calls = [];
  const runtime = makeRuntime(makeFixture(shape), {
    summarizeContextSpan: async (request) => {
      calls.push(request);
      return briefAnswer(request, (id) => `Batched brief naming ${id} and the bash result it folded.`);
    },
  });
  await startRuntime(runtime);
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();

  const briefs = contextEvents(runtime).filter((event) => event.kind === "context.brief");
  const batched = briefs.filter((event) => event.spans > 1);
  // ANTI-VACUITY: without a real batch carrying real bytes there is nothing to digest.
  assert(batched.length > 0, "No batched brief was recorded, so this fixture proves nothing");
  const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
  for (const event of batched) {
    assert(event.source_chars > 0,
      "A batched brief reported no source chars, so its digest claim is untestable");
    assert.notEqual(event.source_sha256, EMPTY_SHA256,
      `A batched brief over ${event.source_chars} chars digested the EMPTY STRING`);
    assert(/^[a-f0-9]{64}$/.test(event.source_sha256),
      `A batched brief carried a malformed source digest: ${event.source_sha256}`);
    // Attribution is unchanged and still the join key.
    assert(Array.isArray(event.fold_ids) && event.fold_ids.length === event.spans,
      "A batched brief did not name one fold per span");
  }
  // The digest is of the SPANS, boundaries included: two batches carrying identical bytes
  // split differently must not collide, or the field cannot identify a call.
  const digestOf = (texts) => createHash("sha256").update(JSON.stringify(texts)).digest("hex");
  assert.notEqual(digestOf(["ab", "c"]), digestOf(["a", "bc"]),
    "Span boundaries are not part of the digest, so differently split batches collide");
  // And a batch's digest is reproducible from what the call actually carried.
  const upgrades = calls.filter(isBriefUpgradeRequest).filter((call) => call.spans.length > 1);
  assert(upgrades.length > 0, "No multi-span upgrade call was observed");
  const expected = digestOf(upgrades[0].spans.map((span) => span.sourceText));
  assert(batched.some((event) => event.source_sha256 === expected),
    "No recorded batched brief digest matched the spans the call carried");

  return {
    batchedBriefs: batched.length,
    spansInTheFirst: batched[0].spans,
    sourceCharsInTheFirst: batched[0].source_chars,
    digestsTheSpansNotTheEmptyString: true,
    boundariesIncluded: true,
  };
}

async function gateOneCallPerCommit() {
  const shape = { turns: 16, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const calls = [];
  const built = makeFixture(shape);
  const runtime = makeRuntime(built, {
    summarizeContextSpan: async (request) => {
      calls.push(request);
      return briefAnswer(request, (id) => `Batched brief naming ${id} and the bash result it folded.`);
    },
  });
  await startRuntime(runtime);
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();

  const upgradeCalls = calls.filter(isBriefUpgradeRequest);
  const briefedSpans = upgradeCalls.flatMap((call) => call.spans);
  const committed = materialized(runtime).folds
    .filter((fold) => fold.provenance.kind === "deterministic")
    .map((fold) => fold.id);
  // ANTI-VACUITY. The claim is that a commit's folds cost FEWER calls than folds, so the
  // fixture has to fold several and the old per-fold behavior has to be what fails here:
  // it would have produced exactly one call per span.
  assert(briefedSpans.length > 1,
    "The commit briefed one span, so this fixture cannot demonstrate batching");
  assert(upgradeCalls.length < briefedSpans.length,
    `${briefedSpans.length} spans still took ${upgradeCalls.length} calls: they were not batched`);
  assert.deepEqual([...briefedSpans.map((span) => span.candidateId)].sort(), [...committed].sort(),
    "The batches did not carry exactly the folds the commit made deterministic");
  // Packing is TIGHT: every call but the last is closed by a bound, not by indifference, so
  // a lane that sent one span per call while claiming to batch fails here.
  assert.equal(upgradeCalls.length, Math.ceil(briefedSpans.length / context.MAX_BRIEF_BATCH_SPANS),
    "The commit's spans were split across more calls than the batch width requires");
  for (const call of upgradeCalls) {
    // The source budget is the CALL's, the same ceiling one span was always held to, so the
    // queue's memory bound did not move when the unit changed.
    const chars = call.spans.reduce((sum, span) => sum + span.sourceText.length, 0);
    assert(chars <= context.ACTIVE_CONTEXT_POLICY.maxSourceChars,
      `A batch carried ${chars} source chars, past the ${context.ACTIVE_CONTEXT_POLICY.maxSourceChars} budget`);
    assert(call.spans.length <= context.MAX_BRIEF_BATCH_SPANS,
      "A batch carried more spans than the batch width allows");
    // Orientation is the run's and belongs to no brief, so it is stated once per call
    // rather than repeated per span.
    assert.equal(call.sourceText, undefined, "A batched request still carried a single span's source");
    for (const field of ["beforeText", "afterText", "maxBriefChars"]) {
      assert(call[field] !== undefined, `The batched request omitted the call-level ${field}`);
    }
  }
  const batch = upgradeCalls[0];

  // POSITION, NOT NAME. Every brief landed on the fold whose span sat at its index.
  const aged = makeFixture({ ...shape, turns: 32, sessionId: built.sessionId });
  for (const entry of aged.entries.slice(built.entries.length)) runtime.branch.push(entry);
  runtime.messages.length = 0;
  runtime.messages.push(...aged.messages);
  await runtimeCommit(runtime, { tokens: 92_000, contextWindow: 100_000, suffix: "second" });
  const applied = materialized(runtime);
  let landed = 0;
  for (const span of briefedSpans) {
    const fold = applied.folds.find((item) => item.id === span.candidateId);
    if (!fold) continue;
    const provenance = context.foldProvenance(fold, applied);
    if (provenance.kind !== "model") continue;
    landed += 1;
    assert(context.foldBrief(fold, applied).includes(span.candidateId),
      `The brief on ${span.candidateId} names a different fold, so the split misattributed it`);
  }
  assert(landed > 1, "Fewer than two batched briefs landed, so attribution was never tested");

  // THE CURE IS PER SPAN. The first answer leaves span 0 empty and overruns span 1; the
  // retry must carry exactly those two, and the untouched spans must not be re-asked.
  const cureCalls = [];
  // Narrower than the batching leg on purpose: this leg is about WHICH spans a cure
  // re-asks, so the commit must land in one batch or "cured once" would be counted per
  // batch and the selectivity claim would be about neither.
  const cureShape = { ...shape, turns: 10 };
  const cureBuilt = makeFixture(cureShape);
  const curing = makeRuntime(cureBuilt, {
    summarizeContextSpan: async (request) => {
      cureCalls.push(request);
      const isCure = typeof request.cure === "string" && request.cure.length > 0;
      return briefAnswer(request, (id) => {
        if (isCure) return `Cured brief for ${id}, within the stated limit.`;
        const at = request.spans.findIndex((span) => span.candidateId === id);
        if (at === 0) return "";
        if (at === 1) return `x${"y".repeat(context.ACTIVE_CONTEXT_POLICY.maxBriefChars * 2)}`;
        return `First-pass brief for ${id}, within the stated limit.`;
      });
    },
  });
  await startRuntime(curing);
  await runtimeCommit(curing, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const cureUpgrades = cureCalls.filter(isBriefUpgradeRequest);
  assert.equal(cureUpgrades.length, 2,
    `The cure fixture made ${cureUpgrades.length} calls; it must be one batch and one cure`);
  const first = cureUpgrades[0];
  const retry = cureUpgrades[1];
  assert(first.spans.length > 2, "The cure fixture needs more than two spans to show selectivity");
  assert.equal(retry.spans.length, 2,
    `The cure re-asked ${retry.spans.length} spans instead of the two that missed`);
  assert.deepEqual(
    retry.spans.map((span) => span.candidateId),
    first.spans.slice(0, 2).map((span) => span.candidateId),
    "The cure re-asked the wrong spans");
  assert(/Brief 1:/.test(retry.cure) && /Brief 2:/.test(retry.cure),
    "The cure did not name its complaints per span");

  // AND THE COMPLAINTS COME BACK KEYED TO THE SPAN, not to the subset that was last asked.
  // The two orders diverge the instant a cure re-asks a subset: here spans 1 and 3 fail and
  // spans 0 and 2 land, so the retry's list is [1, 3] and a caller reading it positionally
  // reports span 3's failure under span 1's name. Driven against the function directly,
  // because the runtime keeps only the last failure and one is not enough to show an order.
  const spans = [0, 1, 2, 3].map((index) => ({ candidateId: `span-${index}` }));
  const overLong = `x${"y".repeat(context.ACTIVE_CONTEXT_POLICY.maxBriefChars * 2)}`;
  const keyed = await context.generatedBriefs({
    summarize: async (request) => briefAnswer(request, (id) => {
      // Both failures survive their cure, and they fail DIFFERENTLY, which is the whole
      // point: one empty and one over the cap cannot be confused for each other.
      if (id === "span-1") return "";
      if (id === "span-3") return overLong;
      return `Good brief for ${id}, within the stated limit.`;
    }),
    request: { spans },
    spans,
    maxBriefChars: context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
    toolName: "acme_context",
  });
  assert.equal(keyed.complaints.length, spans.length,
    "The complaints came back shorter than the spans, so they cannot be read by span");
  assert(keyed.briefs[0] && keyed.briefs[2], "A span that met the contract was reported as failing");
  assert(!keyed.briefs[1] && !keyed.briefs[3], "A span that failed twice was reported as landing");
  assert.equal(keyed.complaints[0], null, "A span that landed carries a complaint");
  assert.equal(keyed.complaints[2], null, "A span that landed carries a complaint");
  assert(/empty|no brief|blank/i.test(keyed.complaints[1]),
    `Span 1 failed empty and its complaint reads ${JSON.stringify(keyed.complaints[1])}`);
  assert(/\b\d{4,}\b/.test(keyed.complaints[3]),
    `Span 3 failed over the cap and its complaint reads ${JSON.stringify(keyed.complaints[3])}`);
  // The two are not interchangeable, which is what makes the keying claim mean something.
  assert.notEqual(keyed.complaints[1], keyed.complaints[3],
    "Both failures carry the same complaint, so no ordering could be detected either way");

  return {
    complaintsKeyedBySpan: keyed.complaints.map((entry) => entry === null),
    callsForOneCommit: upgradeCalls.length,
    spansBriefed: briefedSpans.length,
    spansInTheFirstCall: batch.spans.length,
    batchWidth: context.MAX_BRIEF_BATCH_SPANS,
    briefsAttributedByPosition: landed,
    cureCalls: cureUpgrades.length,
    curedSpans: retry.spans.length,
    untouchedSpansNotReasked: first.spans.length - retry.spans.length,
  };
}

/**
 * A COMMIT THAT VANISHES AT PERSISTENCE ANNOUNCES ITSELF.
 *
 * `persistenceProjection` keeps only folds whose refs still resolve against the snapshot,
 * which is right when evidence has genuinely left the branch. But a write that ARRIVES
 * with new folds and projects down to something byte-equal to what is already durable has
 * had every one of them dropped, and the quiet return also resets in-memory state BACKWARDS
 * to the persisted revision. The marks go back to pending, the same commit is retried on the
 * next boundary, and it vanishes again, forever, with nothing reported.
 *
 * That is not hypothetical. sol-20260812 rep 3 ran a band-top commit at revision 143 that
 * folded 579,489 source chars into 85,463 of placeholder; durable state never passed 134,
 * none of its 11 folds reached a record, occupancy climbed unopposed past its budget and the
 * next request was refused. Nothing in the run said so, because a silent return is not a
 * failure. The same plan on the previous build committed 15 times with no gap at all.
 *
 * The sabotage here is the honest one: the summarizer empties the branch mid-commit, so the
 * folds the epoch is about to persist can no longer resolve. That is exactly the shape of
 * the live failure and it needs no access to internals.
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
  //    (briefs, ledgers) is not what makes the two states look alike in the live failure.
  assert.equal(
    context.sameStateProjection(
      { ...stranded, folds: [], expanded: [] },
      { ...committed, folds: [], expanded: [] },
    ),
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

  // (b) AND THE LADDER REACHES STRAIGHT PAST IT. Every unfolded batch outside the fresh
  // tail is a member, whatever the head cost, and the rung takes the stalest of them.
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
  const memberIndices = (value) => new Set(context.automaticToolBatches(snapshot, value)
    .flatMap((batch) => batch.indices));
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
  const remainder = context.unmarkedRemainder(snapshot, state, 4);
  const claimed = context.claimedRefKeys(state);
  const announced = snapshot.mapped.filter((item) => item.ref && withHead.has(item.index) &&
    !claimed.has(json.objectRefKey(item.ref)));
  assert(remainder.spans > 0, "The remainder announced nothing on a window full of unfolded batches");
  assert.equal(remainder.spans, announced.length,
    `The remainder announced ${remainder.spans} spans against ${announced.length} members`);
  const wholeWindow = snapshot.mapped.filter((item) =>
    item.ref && item.message?.role === "toolResult" && !claimed.has(json.objectRefKey(item.ref)));
  assert(wholeWindow.length > announced.length,
    "Every unclaimed tool result is a member, so the scoping is not being measured");

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
    wholeWindowToolResults: wholeWindow.length,
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
  assert.equal(context.markTouchesCurrentTurn(dissolved, parent, new Set(["dangling-probe"])), false);
  assert(context.claimedRefKeys(dissolved).size >= 2,
    "The claimed keys lost the raw parts the dangling mark still names");
  assert.equal(context.markFreedBytes(snapshot, dissolved, parent), 0);

  const dropCommit = await context.commitPendingMarks({
    snapshot, state: dissolved, generation: 2, retainIneligible: true, guardCurrentTurn: true,
  });
  assert.equal(dropCommit.applied.length, 0, "A mark naming a dissolved fold folded anyway");
  assert.equal(dropCommit.refused.length, 1);
  assert.equal(dropCommit.refused[0].retained, false, "A mark that can never resolve was kept pending");
  assert(dropCommit.refused[0].reason.includes(child.id),
    "The drop receipt does not name the fold the decision lost");
  assert.match(dropCommit.refused[0].reason, /no pending mark will mint/);
  assert.equal(context.pendingMarks(dropCommit.state).length, 0, "The dropped mark is still pending");

  // HALF TWO: the fold is not gone, it is held back this pass.
  const openBuilt = makeFixture({
    sessionId: "dangling-defer-test", turns: 12, resultChars: 6_000, contextWindow: 100_000,
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
    readOnlyContextActions: context.PEEK_READ_ONLY_CONTEXT_ACTIONS,
  });
  const openEmpty = context.emptyActiveContextState(openBuilt.sessionId);
  const turnKeys = context.currentTurnRefKeys(openSnapshot);
  assert.equal(turnKeys.size, 5, "The excursion did not leave five reads inside an open turn");
  const heldIndex = openSnapshot.mapped.findIndex((item) =>
    item.ref && turnKeys.has(json.objectRefKey(item.ref)));
  assert(heldIndex >= 2, "The open turn starts too early in the window to carry a parent span");
  const heldChild = childMarkAt(openSnapshot, openEmpty, heldIndex);
  const heldParent = parentMarkAt(openSnapshot, heldIndex, heldChild);
  let openState = context.addPendingMark(openEmpty, heldChild).state;
  openState = context.addPendingMark(openState, heldParent).state;
  // The guard, and only the guard, is what holds the child: with the turn closed the
  // same child applies, so the deferral below is not measuring some other hold.
  const closedTurn = await context.commitPendingMarks({
    snapshot: openSnapshot, state: context.addPendingMark(openEmpty, heldChild).state,
    generation: 1, retainIneligible: true,
  });
  assert.deepEqual(closedTurn.applied.map((mark) => mark.id), [heldChild.id],
    "The child is held by something other than the turn guard, so this half measures the wrong hold");
  assert.equal(context.markTouchesCurrentTurn(openState, heldChild, turnKeys), true,
    "The excursion's own read is outside the open turn, so nothing guards the child");
  assert.equal(context.markTouchesCurrentTurn(openState, heldParent, turnKeys), false,
    "The parent's readable parts sit inside the open turn, so the guard would hold it too");
  assert.throws(() => context.candidateSourceRefs(heldParent.parts, openState),
    /Missing candidate child/,
    "The parent already resolves, so the deferral below is not being measured");

  const deferCommit = await context.commitPendingMarks({
    snapshot: openSnapshot, state: openState, generation: 1,
    retainIneligible: true, guardCurrentTurn: true,
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
    generation: 1, retainIneligible: true, guardCurrentTurn: true,
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
    openTurnReads: turnKeys.size,
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
  const pressured = makeRuntime(
    makeFixture({ turns: 20, resultChars: 6_000, contextWindow: 200_000 }),
    { providerInputBudget: 40_000 },
  );
  await startRuntime(pressured);
  const pressuredProjections = () => contextEvents(pressured).filter((event) => event.kind === "context.projection");
  const basis = new Set();
  for (let step = 0; step < 4; step += 1) {
    const current = pressuredProjections().at(-1);
    await measure(pressured, Math.ceil(current.chars / 4), 200_000, undefined, "toolUse");
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
  const foldedTurn = built.turnEntries[1];
  await toolCall(runtime, { action: "fold", ids: [foldedTurn[0], foldedTurn.at(-1)] });
  await runtimeCommit(runtime, { tokens: 95_000, contextWindow: 100_000 });
  const live = materialized(runtime).folds.find((fold) =>
    fold.parts.some((part) => part.ref?.entryId === resultRef.entryId));
  assert(live, "The runtime leg never folded the turn, so nothing owns the evidence yet");
  const before = materialized(runtime);
  const from = runtime.appended.length;
  await assert.rejects(
    toolCall(runtime, { action: "fold", ids: [resultRef.entryId] }),
    (error) => error.message.includes(live.id) && /already folded inside/.test(error.message) &&
      /peek/.test(error.message) && /expand/.test(error.message) &&
      !/multiple direct fold owners/.test(error.message),
    "The tool call did not refuse a span the forest already owns by the owner's name",
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
    refusalNamesPeekAndExpand: true,
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
async function gateGeneratorCallsAreOnTheRecord() {
  const shape = { turns: 12, resultChars: 10_000, contextWindow: 100_000, toolName: "bash" };
  const USAGE = { input: 4321, output: 77, totalTokens: 4398, costTotal: 0.0123 };
  const briefFor = (candidateId) =>
    `The folded span records the completed bash inspection under ${candidateId} and its factual result.`;

  const observed = [];
  let mode = "usage";
  const built = makeFixture(shape);
  const runtime = makeRuntime(built, {
    summarizeContextSpan: async (request) => {
      observed.push(request);
      return {
        brief: briefFor(request.candidateId),
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        toolCalls: 0,
        ...(mode === "usage" ? { usage: { ...USAGE } } : {}),
      };
    },
  });
  await startRuntime(runtime);
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();

  const briefed = contextEvents(runtime).filter((record) => record.kind === "context.brief");
  // ANTI-VACUITY: the lane actually ran, so the equality below is not 0 === 0.
  assert(observed.length > 0, "The generator was never called, so this gate proves nothing");
  const laneCalls = observed.length;
  assert.equal(briefed.length, laneCalls,
    `${laneCalls} generator calls produced ${briefed.length} records: a call escaped the ledger`);

  const ok = briefed.filter((record) => record.outcome === "ok");
  assert.equal(ok.length, laneCalls, "A successful generator call was not recorded as ok");
  const sample = ok[0];
  // A batch names its folds in `fold_ids`; a single-span call names one in `fold_id`. Every
  // id the record claims must be an id the generator was actually handed, whichever it is.
  const recordedIds = Array.isArray(sample.fold_ids) && sample.fold_ids.length
    ? sample.fold_ids
    : [sample.fold_id];
  assert(observed.some((request) => {
    const given = requestFoldIds(request);
    return recordedIds.every((id) => given.includes(id));
  }), "The recorded fold ids match no call the generator was actually given");
  assert.equal(sample.provider, "openai-codex");
  assert.equal(sample.model, "gpt-5.6-terra");
  assert.equal(sample.effort, "medium");
  assert(sample.source_chars > 0 && /^[a-f0-9]{64}$/.test(sample.source_sha256),
    "The record does not say what the generator read");
  assert(sample.brief_chars > 0 && /^[a-f0-9]{64}$/.test(sample.brief_sha256),
    "The record does not say what the generator wrote");
  assert(Number.isInteger(sample.duration_ms) && sample.duration_ms >= 0, "No execution duration recorded");
  assert(Number.isInteger(sample.queued_ms) && sample.queued_ms >= 0,
    "No queue wait recorded, so a backed-up lane would read as a slow generator");
  assert.deepEqual(sample.usage, USAGE, "Provider usage was not passed through verbatim");

  // An absent cost and a zero cost are different facts, so the record must not invent one.
  mode = "no-usage";
  const quiet = makeFixture(shape);
  const quietCalls = [];
  const quietRuntime = makeRuntime(quiet, {
    summarizeContextSpan: async (request) => {
      quietCalls.push(request);
      return {
        brief: briefFor(request.candidateId),
        provider: "openai-codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        toolCalls: 0,
      };
    },
  });
  await startRuntime(quietRuntime);
  await runtimeCommit(quietRuntime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const quietRecords = contextEvents(quietRuntime).filter((record) => record.kind === "context.brief");
  assert.equal(quietRecords.length, quietCalls.length,
    "The no-usage fixture dropped a generator call from the ledger");
  assert(quietRecords.length, "The no-usage fixture produced no generator records");
  assert(quietRecords.every((record) => record.usage === null),
    "A generator that reported no usage was recorded as having reported some");

  // A failure is recorded and rethrown: this observes, it decides nothing, and the fold
  // keeps the deterministic brief it committed with.
  const failing = makeFixture(shape);
  const failingRuntime = makeRuntime(failing, {
    summarizeContextSpan: async () => { throw new Error("generator refused this span"); },
  });
  await startRuntime(failingRuntime);
  await runtimeCommit(failingRuntime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const failures = contextEvents(failingRuntime).filter((record) => record.kind === "context.brief");
  assert(failures.length, "A failing generator produced no record at all");
  assert(failures.every((record) => record.outcome === "error"), "A generator failure was not recorded as an error");
  assert(failures.every((record) => String(record.error).includes("generator refused this span")),
    "The recorded failure does not say what went wrong");
  assert(materialized(failingRuntime).folds.some((fold) => fold.provenance.kind === "deterministic"),
    "A recorded failure changed the fallback: the fold no longer keeps its deterministic brief");

  // A timeout is neither a refusal nor a provider fault, and telling them apart decides
  // whether to raise the bound or change the generator. Driven by the message the timeout
  // race actually throws, so the classifier is exercised without waiting out briefTimeoutMs.
  const timedOut = makeFixture(shape);
  const timedOutRuntime = makeRuntime(timedOut, {
    summarizeContextSpan: async () => { throw new Error("Brief upgrade exceeded 120000ms"); },
  });
  await startRuntime(timedOutRuntime);
  await runtimeCommit(timedOutRuntime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const timeouts = contextEvents(timedOutRuntime).filter((record) => record.kind === "context.brief");
  assert(timeouts.length, "The timeout fixture produced no generator records");
  assert(timeouts.every((record) => record.outcome === "timeout"),
    "A timed-out generator call was recorded as an ordinary error");

  return {
    generatorCalls: laneCalls,
    recordsEmitted: briefed.length,
    usagePassedThrough: true,
    absentUsageStaysAbsent: true,
    failureRecordedAndRethrown: true,
    timeoutDistinctFromError: true,
  };
}

/**
 * A parent's brief indexes EVERY child, and a group is briefed from material.
 *
 * The 2026-08-11 rep is the case. A parent's fallback brief concatenated its children's
 * briefs and sliced the result at the cap, so ten children whose briefs may each fill the
 * cap needed ten times the budget and the cut landed inside the first one or two. Every
 * parent in that run came out at exactly 1,200 characters; the bottom rung showed five of
 * ten children and every rung above it showed ONE, because at rung two the first child was
 * itself a capped parent and spent the whole budget alone. A group that cannot say what a
 * member holds cannot be navigated back into, and the agent went to disk instead.
 *
 * Two properties, at both rungs. COVERAGE: the budget is divided, so every child appears
 * whatever its neighbours cost, and a child short enough to fit keeps its whole sentence
 * because the ones that fit hand their remainder to the ones that do not. MATERIAL: the
 * generator reads the group at depth one, its children opened and the grandchildren left
 * as placeholders, so a brief describes the span rather than summarizing summaries; when
 * the opened children do not fit, the LARGEST collapses back to brief-only first, and only
 * as many collapse as the budget forces.
 *
 * The cure is the third: length is a criterion the request states, so a brief that misses
 * it is handed back once with the complaint rather than cut. One cure, and only for a
 * criterion: attribution drift is the harness's own wiring and fails on the first answer.
 */
async function gateParentBriefCoversEveryChild() {
  const cap = context.ACTIVE_CONTEXT_POLICY.maxBriefChars;
  const snapshotOf = (built, thresholds = NO_FRESH_TAIL, policy) => context.mapActiveContext({
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
  const deepThresholds = { ...NO_FRESH_TAIL, consolidateAfter: deepWidth };
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
      next = (await commitCandidate(next, deepSnapshot, candidate, { brief })).state;
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
  const unevenThresholds = { ...NO_FRESH_TAIL, consolidateAfter: unevenWidth };
  const unevenSnapshot = snapshotOf(uneven, unevenThresholds);
  const [firstGroup] = context.selectAutomaticConsolidations(unevenSnapshot, uneven.state);
  assert(firstGroup, "The uneven fixture owed no first group");
  const unevenState = (await commitCandidate(uneven.state, unevenSnapshot, firstGroup, {
    brief: context.deterministicConsolidationBrief(firstGroup, uneven.state),
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

  // THE CURE. A brief over the stated limit is answered with the complaint rather than cut,
  // exactly once, and the second answer stands on its own.
  const attribution = { provider: "openai-codex", model: "gpt-5.6-terra", effort: "medium", toolCalls: 0 };
  const good = `${marker(0)} the curl HTTP/2 stage, its CMakeLists survey, and the failing test it named.`;
  const asked = [];
  const cured = await context.generatedBrief({
    summarize: async (request) => {
      asked.push(request);
      return { ...attribution, brief: asked.length === 1 ? "x".repeat(cap + 400) : good };
    },
    request: { candidateId: "fold_cure", maxBriefChars: cap },
    maxBriefChars: cap,
    toolName: "pi_fold_context",
  });
  assert.equal(asked.length, 2, "An over-long brief was accepted or cut instead of being cured");
  assert.equal(cured.brief, good, "The cured answer was not the one kept");
  assert.equal(cured.cured, true, "A cured brief did not report that it took two asks");
  assert.equal(asked[0].cure, undefined, "The first ask carried a complaint about nothing");
  assert(String(asked[1].cure).includes(String(cap + 400)) && String(asked[1].cure).includes(String(cap)),
    `The complaint does not say what was wrong: ${asked[1].cure}`);
  assert.equal(cured.provenance.kind, "model", "A cured brief lost its model provenance");

  // Twice wrong is loud. Nothing is truncated into place, and the failure names the criterion.
  let stubborn = 0;
  await assert.rejects(async () => context.generatedBrief({
    summarize: async () => {
      stubborn += 1;
      return { ...attribution, brief: "y".repeat(cap + 1) };
    },
    request: { candidateId: "fold_stubborn", maxBriefChars: cap },
    maxBriefChars: cap,
    toolName: "pi_fold_context",
  }), (error) => /cure/.test(error.message) && error.message.includes(String(cap)),
  "A brief that stayed over the limit was not refused by the criterion it missed");
  assert.equal(stubborn, 2, "The cure is bounded at one extra ask");

  // Attribution is the harness's own wiring, so it is never handed back to be cured.
  let unattributed = 0;
  await assert.rejects(async () => context.generatedBrief({
    summarize: async () => {
      unattributed += 1;
      return { brief: good, provider: "", model: "", effort: "", toolCalls: 0 };
    },
    request: { candidateId: "fold_unattributed", maxBriefChars: cap },
    maxBriefChars: cap,
    toolName: "pi_fold_context",
  }), /attribution/, "Attribution drift was treated as something a second ask could mend");
  assert.equal(unattributed, 1, "Attribution drift bought a retry it must never buy");

  // THE LANE TAKES PARENTS. A group with a child still waiting on its own brief defers to
  // the next boundary rather than reading the sentence that brief is about to replace, and
  // when it does run it reads the numbered depth-one payload.
  const laneRequests = [];
  const laneThresholds = { ...context.DEFAULT_THRESHOLDS, consolidateAfter: 2 };
  const laneBuilt = makeFixture({
    turns: 14, resultChars: 9_000, contextWindow: 100_000, toolName: "bash",
    thresholds: laneThresholds,
  });
  const laneRuntime = makeRuntime(laneBuilt, {
    thresholds: laneThresholds,
    summarizeContextSpan: async (request) => {
      laneRequests.push(request);
      return { ...attribution, brief: `${marker(laneRequests.length)} briefed span with concrete detail.` };
    },
  });
  await startRuntime(laneRuntime);
  await runtimeCommit(laneRuntime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  await runtimeCommit(laneRuntime, { tokens: 92_000, contextWindow: 100_000 });
  await settle();
  // A deferred parent waits for a boundary, so the boundaries keep coming: the wait is
  // the mechanism, and a lane that never drains it would show up right here.
  await runtimeCommit(laneRuntime, { tokens: 94_000, contextWindow: 100_000 });
  await settle();
  // Per SPAN, because the lane batches: a group is one span inside a call that may carry
  // several, so asking the request whether it is a group would miss every batched parent.
  const groups = laneRequests.flatMap(requestSpans)
    .filter((span) => Number.isInteger(span.children) && span.children > 0);
  const parents = materialized(laneRuntime).folds.filter((fold) => fold.kind === "consolidation");
  assert(parents.length, "The lane fixture built no parent, so the queueing law is untested here");
  assert(groups.length, "A parent was built and no group was ever sent to the generator");
  const laneGroup = JSON.parse(groups[0].sourceText);
  assert.equal(laneGroup.length, groups[0].children, "The group payload and its stated child count disagree");
  // Nothing reaches the generator as a bare name. A folded child carries its brief and
  // either its contents or the note that it was collapsed; absorbed RAW evidence carries
  // its contents and has no brief to carry, because it is the exact evidence itself.
  assert(laneGroup.every((entry) => entry.contents || entry.collapsed),
    "A child reached the generator with neither its contents nor a collapse note");
  assert(laneGroup.filter((entry) => entry.foldId).every((entry) => entry.brief),
    "A folded child reached the generator without its brief");

  return {
    width,
    childrenCovered: children.length,
    childrenBriefChars: concatenated.length,
    parentBriefChars: parentBrief.length,
    rungs,
    openedChildren: opened.length,
    collapsedLargestFirst: collapsed,
    curedInOneExtraAsk: true,
    parentsBriefedByGenerator: groups.length,
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
 * and what it will want back; a generator reading the span alone knows only what the span
 * says. So the request asks the agent for the brief, and the summarizer is the fallback
 * rather than the default. What must never happen is a fold with nothing in its place: the
 * placeholder is all that stands where the bytes were, and an empty one closes the span to
 * whoever comes back for it.
 *
 * Three orders, one property. A supplied brief is kept verbatim and no generator is spent
 * on it. A mark with no brief is filled by the generator, and the receipt says who wrote
 * it. A generator that fails leaves the deterministic brief standing and the fold eligible
 * for the lane, so the gap is filled late rather than never.
 */
async function gateNoFoldWithoutABrief() {
  const shape = { turns: 10, resultChars: 9_000, contextWindow: 100_000, toolName: "bash" };
  const written = "The completed bash inspection printed the paths under lib and its exact output stays here.";
  const attribution = { provider: "openai-codex", model: "gpt-5.6-terra", effort: "medium", toolCalls: 0 };

  // THE SURFACE ASKS. A mark's brief is optional in the schema because the fallback exists,
  // so the request has to carry the expectation the schema cannot.
  const built = makeFixture(shape);
  const asked = [];
  const runtime = makeRuntime(built, {
    summarizeContextSpan: async (request) => {
      asked.push(request);
      return { ...attribution, brief: written };
    },
  });
  await startRuntime(runtime);
  const tool = [...runtime.tools.values()][0];
  const markBrief = tool.parameters.properties.marks.items.properties.brief;
  assert(typeof markBrief.description === "string" && /summarizer/i.test(markBrief.description),
    "The mark schema does not tell the agent that leaving the brief out hands it to the summarizer");

  // NO BRIEF: the generator fills it, and the mark says the model wrote it.
  const filled = await toolCall(runtime, { action: "fold", ids: [built.turnEntries[0][2]] });
  assert.equal(filled.details.ok, true, "A mark without a brief was refused instead of filled");
  assert(asked.length, "A mark arrived without a brief and no generator was asked for one");
  const gapMark = materialized(runtime).pendingMarks.at(-1);
  assert.equal(gapMark.brief, written, "The generated brief is not the one the mark carries");
  assert.equal(gapMark.briefProvenance.kind, "model",
    "A generated brief was recorded as though the agent had written it");

  // SUPPLIED: kept verbatim, and no generator call is spent on it.
  const supplied = "The second inspection is stale; its exact stdout and the failing path stay recoverable.";
  const spentBefore = asked.length;
  const kept = await toolCall(runtime, {
    action: "fold", ids: [built.turnEntries[1][2]], brief: supplied,
  });
  assert.equal(kept.details.ok, true);
  const keptMark = materialized(runtime).pendingMarks.at(-1);
  assert.equal(keptMark.brief, supplied, "A supplied brief was rewritten");
  assert.equal(keptMark.briefProvenance.kind, "supplied", "A supplied brief lost its attribution");
  assert.equal(asked.length, spentBefore,
    "A generator call was spent on a span the agent had already briefed");

  // A BAD SUPPLIED BRIEF IS REFUSED AS A MARK, ON THE PATH THAT SKIPS THE PREPARATION.
  //
  // `prepareFold` validates the brief it is handed, and the mark path skips it when the
  // span is protected or already prepared. On those paths the mark used to be accepted
  // carrying an unchecked brief, and the first check then happened inside the automatic
  // commit, where a throw suspends folding for the whole session. That is the position the
  // lost-commit defect occupied, reached over a sentence the agent wrote and was told was
  // fine. So: protect the span first, which is what makes the mark deferred, then mark it
  // with a brief that cannot pass.
  const guarded = built.turnEntries[2][2];
  const pinned = await toolCall(runtime, { action: "protect", ids: [guarded] });
  assert(pinned.details.protectedRefs > 0,
    "The fixture could not protect the span it needs deferred, so nothing here is deferred");
  const marksBefore = materialized(runtime).pendingMarks.length;
  const refused = await toolCall(runtime, {
    action: "fold", ids: [guarded], brief: "pi_fold_context",
  });
  const refusal = JSON.stringify(refused.details);
  assert(/Supplied brief rejected/.test(refusal),
    `A structural brief on a deferred span was not refused: ${refusal.slice(0, 400)}`);
  assert(/Name concrete things from the span/.test(refusal),
    "The refusal does not tell the agent what to write instead");
  assert.equal(materialized(runtime).pendingMarks.length, marksBefore,
    "A mark carrying a brief that cannot pass was accepted and left to throw at commit");
  // And the agent is not stranded: the same span takes a good brief on the next call.
  const retried = await toolCall(runtime, {
    action: "fold", ids: [guarded],
    brief: "The third inspection recorded a failing path and its exact stdout, both recoverable.",
  });
  assert.equal(retried.details.ok, true,
    "The agent corrected the brief the refusal complained about and was refused again");
  await toolCall(runtime, { action: "unprotect", ids: [guarded] });

  // EVERY FOLD, AFTER THE LADDER RUNS. The lane and the fallbacks together leave nothing
  // standing with an empty placeholder.
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
  await settle();
  const folds = materialized(runtime).folds;
  assert(folds.length, "The fixture committed no folds, so this proves nothing");
  const empty = folds.filter((fold) => typeof fold.brief !== "string" || !fold.brief.trim());
  assert.deepEqual(empty.map((fold) => fold.id), [], "A committed fold carries no brief at all");

  // A FAILING GENERATOR still leaves a brief: the deterministic one, standing where the
  // model's would have been, and the fold stays eligible for the lane to fill later.
  const failingBuilt = makeFixture(shape);
  const failingRuntime = makeRuntime(failingBuilt, {
    summarizeContextSpan: async () => { throw new Error("generator refused this span"); },
  });
  await startRuntime(failingRuntime);
  const survived = await toolCall(failingRuntime, {
    action: "fold", ids: [failingBuilt.turnEntries[0][2]],
  });
  assert.equal(survived.details.ok, true, "A generator failure refused the agent's mark");
  const fallbackMark = materialized(failingRuntime).pendingMarks.at(-1);
  assert(typeof fallbackMark.brief === "string" && fallbackMark.brief.trim(),
    "A generator failure left the mark with no brief at all");
  assert.equal(fallbackMark.briefProvenance.kind, "deterministic",
    "A failed generator was recorded as the author of the fallback");

  return {
    schemaAsksForABrief: true,
    generatedWhenOmitted: true,
    suppliedKeptVerbatim: true,
    deferredBadBriefRefusedAtTheMark: true,
    agentCorrectedAndWasAccepted: true,
    generatorCallsSpent: asked.length,
    committedFolds: folds.length,
    foldsWithoutABrief: empty.length,
    fallbackSurvivesFailure: true,
  };
}

/**
 * No token ceiling is ever sent, and a generator that thinks hard still answers.
 *
 * `maxTokens` does not ask a model for a shorter brief; it stops the model mid-answer. On
 * a reasoning generator the reasoning is drawn from the same budget, so the harder a span
 * is to read the less remains for the brief, until nothing remains and the response
 * carries no text at all. The 2026-08-11 rep ran with 512 and the ledger shows exactly
 * that: 6 of 27 calls (22%) failed with "Summarizer returned no text", every one after
 * 111 to 132 seconds of thinking; brief length correlated NEGATIVELY with call duration
 * at r = -0.575; calls under 20s averaged 1,028 characters and calls over 80s averaged
 * 369. The depth-one group payloads suffered worst, because the largest and most
 * interesting input provokes the most reasoning: two group briefs came back at 96 and 438
 * characters, which reads as weak summarization and was truncation.
 *
 * Three mechanisms bound length instead, and every one of them can explain itself to the
 * model: the limit stated in the request, the cure that hands an over-long brief back with
 * the complaint, and the caller's timeout for a genuine runaway. A token cut is the one
 * mechanism the model cannot see, plan around, or recover from (Shane 2026-08-11).
 */
async function gateNoTokenCeilingReachesTheProvider() {
  const seen = [];
  // A generator that spends most of a small budget thinking, then writes. Under a 512-token
  // ceiling the thinking alone would consume it and the text would never be reached; the
  // fixture reproduces that by refusing to answer when a ceiling is present.
  const loadHostModule = async () => ({
    ModelRuntime: {
      async create() {
        return {
          getModel: (provider, id) => ({ provider, id, reasoning: true }),
          async completeSimple(model, request, options) {
            seen.push(options);
            const thinking = "reasoned at length about the span".repeat(40);
            if ("maxTokens" in options) {
              // What the provider actually did: the budget went to reasoning and the
              // response arrived with thinking and no text.
              return { role: "assistant", content: [{ type: "thinking", thinking }] };
            }
            return {
              role: "assistant",
              content: [
                { type: "thinking", thinking },
                {
                  type: "text",
                  text: "Read extensions/lib/folding.ts and confirmed projectActiveContext returns " +
                    "the bounded projection; expanding recovers the exact call sites and the failing assertion.",
                },
              ],
            };
          },
        };
      },
    },
  });

  const summarize = summarizerFactory.createSummarizeContextSpan(
    { provider: "openai-codex", model: "gpt-5.6-terra", effort: "medium" },
    loadHostModule,
  );
  const result = await summarize({
    candidateId: "fold_ceiling",
    sourceText: "the exact bytes of one completed inspection",
    maxBriefChars: context.ACTIVE_CONTEXT_POLICY.maxBriefChars,
  });
  assert(seen.length, "the generator never reached the provider");
  assert(seen.every((options) => !("maxTokens" in options)),
    "a token ceiling was sent: it truncates the answer rather than shortening it");
  assert(context.usefulBrief(result.brief, context.ACTIVE_CONTEXT_POLICY.maxBriefChars, "pi_fold_context"),
    "a generator that thought at length did not produce a usable brief");

  // ANTI-VACUITY: the fixture genuinely fails when a ceiling IS present, so the assertion
  // above is about the runtime's behaviour and not about a fixture that always answers.
  const ceilinged = { ...seen[0], maxTokens: 512 };
  const runtime = await (await loadHostModule()).ModelRuntime.create();
  const starved = await runtime.completeSimple({}, {}, ceilinged);
  assert(!starved.content.some((part) => part.type === "text"),
    "the fixture answers even under a ceiling, so this gate would pass without the fix");

  // Reasoning still reaches the provider: deleting the ceiling must not delete the effort.
  assert(seen.every((options) => options.reasoning === "medium"),
    "the configured effort stopped reaching the provider");

  return {
    calls: seen.length,
    ceilingSent: false,
    reasoningStillSent: true,
    briefUsableAfterLongThinking: true,
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
 * The invariant is not that a brief never changes: the upgrade lane rewrites a
 * deterministic brief with a model one, and `rebrief` lets the agent correct either. It
 * is that the wire carries the difference from its base and nothing else, so an addition,
 * a rewrite and a removal all travel and an unchanged map travels nowhere.
 */
async function gateDeltaCarriesOnlyBriefChanges() {
  const runtime = await epochToolRuntime({ turns: 16, resultChars: 6_000 });
  const built = runtime.built;
  const newestDelta = () => {
    const data = runtime.branch
      .filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY)
      .map((entry) => entry.data).at(-1);
    assert.equal(data.kind, "delta", "The fixture wrote a checkpoint, so the delta path went untested");
    return data;
  };

  await toolCall(runtime, {
    action: "fold",
    marks: [0, 1, 2].map((turn) => ({
      ids: [built.turnEntries[turn][2]],
      brief: `Stale inspection ${turn}: the exact output stays recoverable behind this fold.`,
    })),
  });
  await runtimeCommit(runtime, { tokens: 88_000, contextWindow: 100_000 });
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
  // wire. It ends on a period because `rebrief` trims, and a trimmed brief is not the
  // string this gate then compares the replayed map against.
  const briefText = (name) => `${`Corrected ${name}: the exact bytes stay recoverable behind this fold. `
    .padEnd(context.ACTIVE_CONTEXT_POLICY.maxBriefChars - 1, "The span is unchanged beside it. ")}.`;

  await toolCall(runtime, { action: "rebrief", id: first.id, brief: briefText("one") });
  const afterFirst = newestDelta();
  assert.equal(afterFirst.briefs, undefined, "The delta stated the whole brief map");
  assert.deepEqual(Object.keys(afterFirst.addBriefs ?? {}), [first.id], "The rebrief did not name its own fold");

  // The write the defect made expensive: nothing about the briefs changed here, and the
  // whole map shipped anyway. It has to carry no brief key of any kind.
  await toolCall(runtime, { action: "expand", id: second.id });
  const unrelated = newestDelta();
  assert.equal(unrelated.briefs, undefined);
  assert.equal(unrelated.addBriefs, undefined, "A write that changed no brief carried one");
  assert.equal(unrelated.removeBriefIds, undefined);
  assert(!JSON.stringify(unrelated).includes("Corrected one"),
    "The write that changed no brief carried the brief's own bytes");

  await toolCall(runtime, { action: "rebrief", id: second.id, brief: briefText("two") });
  assert.deepEqual(Object.keys(newestDelta().addBriefs), [second.id], "The second rebrief re-shipped the first");
  await toolCall(runtime, { action: "rebrief", id: first.id, brief: briefText("one again") });
  assert.deepEqual(Object.keys(newestDelta().addBriefs), [first.id], "A rewrite did not travel as its own change");

  // Materialisation replays every entry in the branch, so this is the round trip: the map
  // the runtime holds has to be rebuildable from a chain that never stated it whole.
  assert.deepEqual(materialized(runtime).briefs, {
    [first.id]: briefText("one again"),
    [second.id]: briefText("two"),
  }, "Replaying the deltas did not reproduce the brief map");

  // REMOVAL. `reboundary` with an id alone dissolves the fold and drops its brief with it.
  await toolCall(runtime, { action: "reboundary", id: first.id });
  const afterDissolve = newestDelta();
  assert.deepEqual(afterDissolve.removeBriefIds, [first.id], "The dissolved fold's brief did not travel as a removal");
  assert.equal(afterDissolve.addBriefs, undefined, "A removal re-shipped the brief that stayed");
  assert.deepEqual(materialized(runtime).briefs, { [second.id]: briefText("two") },
    "Replaying the removal did not leave the surviving brief standing");

  // THE MARKS ARE THE SAME RULE ONE SHAPE ALONG, and the next largest field: 2.55 MB of
  // rep 9's 21.6 MB ledger, which a diff takes to 0.16 MB. They carry an ORDER as well as a
  // membership, and appending after removing does not always reproduce it (four of that
  // run's 309 writes), so the key order travels whole and states the removals by not naming
  // them. It is short beside the marks themselves, so there is no case to split and no
  // branch that can pick the wrong one.
  //
  // Driven against the encoding rather than through the runtime, the way gate 38 drives the
  // wire round trip: the reorder is the case that decides the design, and the ladder does
  // not reorder on demand.
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

  // A delta written before this change states the whole map, and sealed sessions hold
  // thousands of them. The presence of `briefs` is the discriminator, not a fallback: a
  // wire that states the map is replayed as the map, and it may not also state a change.
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
  assert.deepEqual(legacyReplay.briefs, { [second.id]: briefText("two") },
    "A sealed session's whole-map deltas no longer replay");
  assert.deepEqual(legacyReplay.pendingMarks, materialized(runtime).pendingMarks,
    "A sealed session's whole-array marks no longer replay");

  const sample = structuredClone(chain.at(-1).data);
  assert.throws(() => context.parseActiveContextStateV2(
    { ...sample, briefs: { [second.id]: briefText("two") } }, built.sessionId,
  ), /states the whole brief map and a change to it/,
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
  const redundant = structuredClone(runtime.branch);
  const redundantTail = redundant.filter((entry) => entry.customType === context.ACTIVE_CONTEXT_STATE_ENTRY).at(-1);
  delete redundantTail.data.removeBriefIds;
  redundantTail.data.addBriefs = { [second.id]: briefText("two") };
  assert.throws(() => context.materializeActiveContextState(redundant, built.sessionId),
    /Redundant active-context brief/);

  return {
    stateEntries: chain.length,
    unchangedWriteBytes: JSON.stringify(unrelated).length,
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
async function gateUserCommitAnnouncesPersistenceFailure() {
  const shape = { turns: 12, resultChars: 16_000, contextWindow: 100_000 };
  const bank = async (runtime) => {
    await startRuntime(runtime);
    // 60,000 against the 90,000-token budget is below the band top, so the ladder marks
    // and waits: the command is what commits, which is the path under test.
    await measure(runtime, 60_000, 100_000);
    assert((materialized(runtime).pendingMarks ?? []).length >= 1,
      "The quiet band accumulated no mark, so the command had nothing to commit");
  };

  // ANTI-VACUITY. Unsabotaged, the same command commits, persists and says so. Without
  // this the assertions below would pass on a command that never did anything.
  const clean = makeRuntime(makeFixture({ ...shape, sessionId: "user-commit-clean" }));
  await bank(clean);
  await clean.commands.get("fold-context").handler("commit", clean.ctx);
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
  await runtime.commands.get("fold-context").handler("commit", runtime.ctx);
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
  [11, "Marking is doorless below the band top", gateDoorlessMarking],
  [12, "B2 expand leases", gateExpandLeases],
  [13, "Consolidation is the root count", gateConsolidationCountingRule],
  [14, "B4 quiet warming", gateQuietWarming],
  [15, "B5 fold_candidates detail", gateFoldCandidatesDetail],
  [16, "No tool call causes a rewrite", gateNoToolCallRewrite],
  [17, "Phase-B wire forward/backward note", gateWireForwardBackwardNote],
  [18, "Follow-up fences & stale anchors", gateFollowupFencesAndAnchors],
  [19, "Fresh tail is one proportion", gateFreshTailShareCap],
  [20, "Neutral default branding", gateNeutralDefaultBranding],
  [21, "Deployment branding reproduction", gateDeploymentBrandingReproduction],
  [22, "Evidence ingestion is unconditional", gateEvidenceIngestionIsUnconditional],
  [23, "Summarizer option", gateSummarizerOption],
  [25, "Peek and fold index", gatePeekAndFoldIndex],
  [26, "Two surfacing channels, one divergence trigger", gateSurfacingChannels],
  [27, "One suggestion per delivery point, bounded", gateSurfacingSlateBounds],
  [28, "Surfacing suppression lifecycle", gateSurfacingSuppression],
  [32, "Epoch mark/commit lifecycle", gateEpochMarkCommit],
  [34, "Epoch quota top-up", gateEpochQuotaTopUp],
  [35, "Mark always means mark", gateMarkAlwaysMeansMark],
  [36, "Ephemeral peek auto-mark", gateEphemeralPeekMark],
  [38, "Scheduling wire round-trip", gateSchedulingWireRoundTrip],
  [39, "Epoch mark accumulation", gateMarkAccumulation],
  [40, "The refold rung is reachable through a mark", gateEpochInlineRungs],
  [41, "Surfacing key-order digest stability", gateSurfacingKeyOrder],
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
  [94, "One span law: raw, nested, pinned", gateUnifiedSpanLaw],
  [95, "Agent spans nest; pins refuse", gateAgentSpansNest],
  [96, "Thresholds are validated at construction", gateThresholdConstruction],
  [97, "The class law: membership, not position", gateThreeZones],
  [98, "The class law is unconditional", gateFenceOpensTheMiddle],
  [101, "Peek copies reclaim with identity", gatePeekReclaimWithIdentity],
  [102, "The public option surface", gatePublicOptionSurface],
  [105, "Every completed tool batch folds unmarked", gateEveryToolBatchFoldsUnmarked],
  [103, "Guidance is one boolean, default on", gateGuidanceOption],
  [104, "The slate rides the rider, and nothing else", gateSurfacingDeliveryRidesTheBoundary],
  [106, "The boundary commits with no turn ever closed", gateOpenTurnCommits],
  [107, "Model briefs upgrade on the commit boundary", gateBriefUpgradesRideTheBoundary],
  [108, "A folded head never limits reach", gateProjectedStaleBasis],
  [109, "A mark naming a fold that is gone or held is answered", gateDanglingChildMarks],
  [110, "Occupancy is anchored to what the provider counted", gateAnchoredOccupancy],
  [111, "The calibration hazard the anchor narrows but does not remove", gateCalibrationHazard],
  [112, "A span already inside a fold is refused by name", gateOwnedSpanRefusal],
  [113, "Entry evidence is derived once, never rebuilt", gateIncrementalEvidenceMap],
  [114, "Every generator call is on the record", gateGeneratorCallsAreOnTheRecord],
  [115, "A parent brief covers every child", gateParentBriefCoversEveryChild],
  [116, "No fold goes without a brief", gateNoFoldWithoutABrief],
  [117, "No token ceiling reaches the provider", gateNoTokenCeilingReachesTheProvider],
  [118, "A commit's spans are briefed in one call", gateOneCallPerCommit],
  [120, "A mark reading takes a view; only a write copies", gateMarkReadsTakeAView],
  [121, "An evidence digest is derived once per message object", gateEvidenceDigestDerivedOncePerObject],
  [122, "A commit that vanishes at persistence announces itself", gateVanishedCommitAnnouncesItself],
  [123, "Suspending automatic folding announces itself", gateSuspensionAnnouncesItself],
  [125, "A parent brief cannot inherit a structural tool name", gateParentBriefCannotInheritToolName],
  // 124 is retired, not free: the clean-rollback retry it pinned was deleted the day it
  // shipped, and reusing its number would make the history unreadable.
  // 37, 59, 99, 100 and 119 are retired with the thermostat. Each pinned an
  // ANNOUNCEMENT the occupancy trigger made on its way to a commit: the threshold
  // crossing, the two-signal curation trigger, the pre-commit last call, the threshold
  // notices, and the output wall's early crossing. The runtime commits at the
  // compaction boundary now, and a boundary Pi fires has nothing to announce in
  // advance. Their numbers stay spent for the same reason 124's does.
  [126, "A batched brief names the bytes it was made from", gateBatchedBriefNamesItsSource],
  [127, "A delta carries only what changed", gateDeltaCarriesOnlyBriefChanges],
  [128, "The user's commit announces a persistence failure", gateUserCommitAnnouncesPersistenceFailure],
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

// Counted over the gates that actually RAN. Subtracting failures from the whole table
// made a filtered run read like a fuller verdict than it was: fifteen failures out of
// fifteen selected printed as "63/78", which is the score of a run that never happened.
process.stdout.write(
  `SUMMARY: ${failures === 0 ? "PASS" : "FAIL"} (${selected.length - failures}/${selected.length} gates run` +
    `${selected.length === gates.length ? "" : `, ${gates.length} in the suite`})\n`,
);
if (failures) process.exitCode = 1;
