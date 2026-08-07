#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMemoryInfluenceReceipt,
  buildMemoryInfluenceReceiptFromPending,
  crossRuntimeDigest,
  projectEphemeralMemory,
  registerQuorumRuntime,
  validateExposureDescriptor,
  validateInfluenceManifest,
  validateMemoryInfluenceReceipt,
} from "../.pi/extensions/quorum/runtime.mjs";
import { stableStringify } from "../.pi/extensions/quorum/json.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const model = "openai-codex/gpt-test:high";
const sourceSha256 = "a".repeat(64);
const recommendation = '- **Wiki** "Canonical memory page" — `wiki_read({"address": "meta/memory"})`';
const contextText = `<project-memory>\n# Selected across memory horizons\n${recommendation}\n</project-memory>`;
const candidate = {
  version: 1, key: "wiki:art_memory", kind: "wiki", domain: "system", horizon: "semantic",
  source_id: "art_memory", source_version: `b2b256:${sourceSha256}`,
  route: { tool: "wiki_read", arguments: { address: "meta/memory" } },
  token_cost: 10, expansion_cost: 1, rank: 0, score: 1, confidence: "strong",
  freshness: "current", locked_owner: false, collapse_key: "art_memory",
  generator: "test", generator_version: "test", recency: null,
};
const exposureBasis = {
  version: 1,
  policyVersion: "fixed-memory-slate-v2",
  query: { sha256: "1".repeat(64), chars: 42, estimatedTokens: 11 },
  baselineQueryChars: 400,
  baselineSha256: "2".repeat(64),
  baselineBytes: 400,
  visibleSha256: sha(contextText),
  visibleChars: Array.from(contextText).length,
  visibleBytes: Buffer.byteLength(contextText),
  model,
  actualExposure: "unified-fixed-slate",
  candidateCount: 1,
  candidates: [candidate],
  slate: {
    version: 1, policyVersion: "fixed-memory-slate-v2", domain: "system",
    tokenBudget: 1500, tokenCost: 10, selected: [candidate.key], rejected: [], slateId: "4".repeat(64),
  },
  generatorLatencyMs: { wiki: 1, journal: 2, durable_fold: 3, projection: 0 },
  poolLimits: { wiki: 13, journal: 8, durable_fold: 8, projection: 16 },
};
const exposure = { ...exposureBasis, exposureDigest: crossRuntimeDigest(exposureBasis) };
const manifest = [{
  version: 1,
  candidateKey: candidate.key,
  kind: candidate.kind,
  sourceId: candidate.source_id,
  sourceVersion: candidate.source_version,
  sourceSha256,
  route: candidate.route,
  recommendation,
  recommendationSha256: sha(recommendation),
  recommendationBytes: Buffer.byteLength(recommendation),
}];
assert.deepEqual(validateExposureDescriptor(exposure, model), exposure);
assert.throws(() => validateExposureDescriptor({ ...exposure, payload: recommendation }, model), /invalid or unbounded/);
assert.throws(() => validateExposureDescriptor({ ...exposure, model: "other/model:off" }, model), /invalid or unbounded/);
assert.throws(() => validateExposureDescriptor({ ...exposure, exposureDigest: "f".repeat(64) }, model), /digest drift/);
const badRouteBasis = {
  ...exposureBasis,
  candidates: [{ ...candidate, route: { tool: "bash", arguments: { command: "echo unsafe" } } }],
};
assert.throws(() => validateExposureDescriptor({
  ...badRouteBasis, exposureDigest: crossRuntimeDigest(badRouteBasis),
}, model), /candidate is invalid/);
assert.deepEqual(validateInfluenceManifest(exposure, manifest), manifest);
assert.throws(() => validateInfluenceManifest(exposure, [{ ...manifest[0], recommendation: "drift" }]), /drift/);

const handlers = new Map();
const commands = new Map();
const tools = new Map();
const appended = [];
const branch = [];
let sequence = 0;
let aborted = false;
let rejectInfluenceOnce = false;
let rejectPendingOnce = false;
const addEntry = (entry) => {
  const id = entry.id ?? `entry-${String(++sequence).padStart(3, "0")}`;
  const value = { id, parentId: branch.at(-1)?.id ?? null, ...entry };
  branch.push(value);
  return value;
};
const pi = {
  on(name, handler) {
    const values = handlers.get(name) ?? [];
    values.push(handler);
    handlers.set(name, values);
  },
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand(name, command) { commands.set(name, command); },
  getAllTools() { return [...tools.values()]; },
  getCommands() { return []; },
  async appendEntry(customType, data) {
    if (customType === "quorum-memory-influence-pending" && rejectPendingOnce) {
      rejectPendingOnce = false;
      throw new Error("pending outbox append unavailable");
    }
    if (customType === "quorum-memory-influence" && rejectInfluenceOnce) {
      rejectInfluenceOnce = false;
      throw new Error("influence append unavailable");
    }
    appended.push({ customType, data: structuredClone(data) });
    addEntry({ type: "custom", customType, data: structuredClone(data) });
  },
};
const ctx = {
  cwd: root,
  model: { provider: "openai-codex", id: "gpt-test" },
  thinkingLevel: "high",
  signal: new AbortController().signal,
  sessionManager: {
    getSessionId: () => "session-memory-test",
    getSessionFile: () => "/tmp/session-memory-test.jsonl",
    getBranch: () => branch,
  },
  ui: { setStatus() {}, notify() {} },
  abort() { aborted = true; },
};
let structuredOverride = null;
const fakeClient = {
  isRunning: false,
  async start() { this.isRunning = true; },
  async listTools() {
    return [{ name: "memory_context", title: "Memory context", description: "test", inputSchema: { type: "object" } }];
  },
  async callTool(name) {
    assert.equal(name, "memory_context");
    return { structuredContent: structuredOverride ?? {
      context: contextText, slate: { refused: false, exposure, influenceManifest: manifest },
    } };
  },
  async close() { this.isRunning = false; },
};
const runtime = registerQuorumRuntime(pi, { status: () => "test" }, {
  loadServer: async () => ({ command: "fake", args: [] }),
  createClient: () => fakeClient,
});
runtime.activateEphemeralMemoryProjection();

const emit = async (name, event = {}) => {
  let result;
  for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
};
const emitContext = async (messages) => {
  let current = structuredClone(messages);
  for (const handler of handlers.get("context") ?? []) {
    const result = await handler({ messages: current }, ctx);
    if (result?.messages) current = result.messages;
  }
  return current;
};

await emit("session_start");
await emit("before_agent_start", { prompt: "Use the canonical memory page for this task." });
assert.equal(aborted, false);
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-exposure").length, 1);
assert(!JSON.stringify(appended[0]).includes(recommendation), "Exposure descriptor leaked recommendation text");
assert.equal(appended.filter((entry) => entry.customType === "quorum-project-memory").length, 0);

const historical = [{
  role: "custom", customType: "quorum-project-memory", content: "persisted historical recommendation", timestamp: 1,
}];
for (let request = 0; request < 2; request += 1) {
  const projected = await emitContext(historical);
  const injected = projected.filter((message) => message.customType === "quorum-project-memory");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].content, contextText);
  assert.equal(injected[0].details.requestEphemeral, true);
}

await emit("tool_result", {
  toolName: "wiki_read", toolCallId: "tool-used", input: { address: "meta/memory" }, isError: false,
  content: [{ type: "text", text: "canonical result" }], details: {},
});
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-influence-pending").length, 1,
  "Followed route did not persist its exact influence outbox before Pi tool-result persistence");
addEntry({
  type: "message",
  message: {
    role: "toolResult", toolName: "wiki_read", toolCallId: "tool-used", isError: false,
    content: [{ type: "text", text: "bounded projection" }],
    details: {
      evidence: {
        owner: { kind: "quorum-mcp", id: "quorum:session-memory-test" },
        artifactId: `sha256:${"c".repeat(64)}`,
        path: `/tmp/evidence/${"c".repeat(64)}.json`, sha256: "c".repeat(64), bytes: 9001,
      },
    },
  },
});
await emit("turn_end");
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-influence").length, 1);
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-outcome").length, 1);
const usedReceipt = validateMemoryInfluenceReceipt(
  appended.find((entry) => entry.customType === "quorum-memory-influence").data,
);
assert.equal(usedReceipt.surfaced.text, recommendation);
assert.equal(usedReceipt.source.version, candidate.source_version);
assert.equal(usedReceipt.source.sha256, sourceSha256);
assert.deepEqual(usedReceipt.route, candidate.route);
assert.equal(usedReceipt.outcome, "used");
assert.equal(usedReceipt.result.entryId, branch.find((entry) => entry.message?.toolCallId === "tool-used").id);
assert.equal(usedReceipt.result.artifact.sha256, "c".repeat(64));
assert.equal((await emitContext([])).filter((message) => message.customType === "quorum-project-memory").length, 1,
  "Ephemeral memory did not survive later provider calls in the same agent run");

rejectPendingOnce = true;
const errorTransform = await emit("tool_result", {
  toolName: "wiki_read", toolCallId: "tool-error", input: { address: "meta/memory" }, isError: true,
  content: [{ type: "text", text: "failed" }], details: {},
});
addEntry({
  type: "message",
  message: {
    role: "toolResult", toolName: "wiki_read", toolCallId: "tool-error", isError: true,
    content: [{ type: "text", text: "failed" }], details: errorTransform.details,
  },
});
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-influence-pending").length, 1);
assert(errorTransform.details.memoryInfluencePending, "Failed outbox append lacked canonical tool-result fallback");

// Simulate process loss after the exact acted recommendation outbox and canonical tool result persisted.
const recoveryHandlers = new Map();
const recoveryTools = new Map();
const recoveryPi = {
  on(name, handler) {
    const values = recoveryHandlers.get(name) ?? [];
    values.push(handler);
    recoveryHandlers.set(name, values);
  },
  registerTool(tool) { recoveryTools.set(tool.name, tool); },
  registerCommand() {}, getAllTools: () => [...recoveryTools.values()], getCommands: () => [],
  async appendEntry(customType, data) {
    if (customType === "quorum-memory-influence" && rejectInfluenceOnce) {
      rejectInfluenceOnce = false;
      throw new Error("influence append unavailable");
    }
    appended.push({ customType, data: structuredClone(data) });
    addEntry({ type: "custom", customType, data: structuredClone(data) });
  },
};
const recoveryRuntime = registerQuorumRuntime(recoveryPi, { status: () => "test" }, {
  loadServer: async () => ({ command: "fake", args: [] }), createClient: () => fakeClient,
});
recoveryRuntime.activateEphemeralMemoryProjection();
const emitRecovery = async (name, event = {}) => {
  let result;
  for (const handler of recoveryHandlers.get(name) ?? []) result = await handler(event, ctx);
  return result;
};
const errorEntry = branch.find((entry) => entry.message?.toolCallId === "tool-error");
const tamperedFinal = {
  ...buildMemoryInfluenceReceiptFromPending(errorTransform.details.memoryInfluencePending, {
    sessionId: "session-memory-test", entryId: errorEntry.id, toolName: "wiki_read", toolCallId: "tool-error",
    messageSha256: "9".repeat(64), artifact: null,
  }),
  route: { tool: "bash", arguments: { command: "arbitrary" } },
};
const tamperedEntry = addEntry({ type: "custom", customType: "quorum-memory-influence", data: tamperedFinal });
await emitRecovery("session_start");
aborted = false;
await emitRecovery("before_agent_start", { prompt: "Reject a tampered persisted final receipt." });
assert.equal(aborted, true, "Tampered final receipt suppressed pending recovery");
branch.splice(branch.indexOf(tamperedEntry), 1);

const validFinal = buildMemoryInfluenceReceiptFromPending(errorTransform.details.memoryInfluencePending, {
  sessionId: "session-memory-test", entryId: errorEntry.id, toolName: "wiki_read", toolCallId: "tool-error",
  messageSha256: "9".repeat(64), artifact: null,
});
const schemaValidBasis = {
  ...validFinal,
  route: { tool: "wiki_read", arguments: { address: "different-but-schema-valid" } },
};
delete schemaValidBasis.receiptDigest;
const schemaValidTampered = {
  ...schemaValidBasis,
  receiptDigest: sha(stableStringify(schemaValidBasis)),
};
validateMemoryInfluenceReceipt(schemaValidTampered);
const schemaTamperedEntry = addEntry({
  type: "custom", customType: "quorum-memory-influence", data: schemaValidTampered,
});
aborted = false;
await emitRecovery("before_agent_start", { prompt: "Reject schema-valid final/pending provenance drift." });
assert.equal(aborted, true, "Schema-valid tampered final suppressed pending recovery");
branch.splice(branch.indexOf(schemaTamperedEntry), 1);

rejectInfluenceOnce = true;
aborted = false;
await emitRecovery("before_agent_start", { prompt: "Exercise failed final influence recovery append." });
assert.equal(aborted, true);
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-influence").length, 1,
  "Failed recovery append fabricated a completed receipt");
aborted = false;
await emitRecovery("before_agent_start", { prompt: "Retry pending influence recovery before new work." });
assert.equal(aborted, false);
const errorReceipt = appended
  .filter((entry) => entry.customType === "quorum-memory-influence")
  .map((entry) => validateMemoryInfluenceReceipt(entry.data))
  .find((entry) => entry.result.toolCallId === "tool-error");
assert.equal(errorReceipt.outcome, "error");
assert.equal(errorReceipt.result.artifact, null);

await Promise.all([emit("turn_end"), emit("agent_settled")]);
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-influence").length, 2,
  "Concurrent settlement duplicated an influence receipt");
const afterSettlement = await emitContext(historical);
assert.equal(afterSettlement.filter((message) => message.customType === "quorum-project-memory").length, 0,
  "Historical persisted recommendation remained active after settlement");
assert.equal(afterSettlement.length, 0);

const exposureCountBeforeDrift = appended.filter((entry) => entry.customType === "quorum-memory-exposure").length;
structuredOverride = {
  context: `${contextText}\nforged payload`,
  slate: { refused: false, exposure, influenceManifest: manifest },
};
aborted = false;
await emit("before_agent_start", { prompt: "Reject context that is not bound to its exposure." });
assert.equal(aborted, true);
assert.equal(appended.filter((entry) => entry.customType === "quorum-memory-exposure").length, exposureCountBeforeDrift);
structuredOverride = null;

const direct = buildMemoryInfluenceReceipt(
  { ...exposure, exposureId: "direct-exposure" }, manifest[0],
  { toolCallId: "direct-call", outcome: "used" },
  { sessionId: "s", entryId: "e", toolName: "wiki_read", toolCallId: "direct-call", messageSha256: "d".repeat(64), artifact: null },
);
assert.equal(validateMemoryInfluenceReceipt(direct).candidateKey, candidate.key);
assert.throws(() => validateMemoryInfluenceReceipt({
  ...direct,
  route: { tool: "bash", arguments: { command: "arbitrary" } },
}), /receipt evidence/);
assert.throws(() => validateMemoryInfluenceReceipt({
  ...direct,
  result: {
    ...direct.result,
    artifact: {
      owner: { kind: "not-an-owner", id: "x" }, artifactId: "not-content-addressed",
      path: "/tmp/not-a-digest", sha256: "e".repeat(64), bytes: Number.MAX_SAFE_INTEGER,
    },
  },
}), /artifact reference/);
assert.equal(projectEphemeralMemory(historical, null).length, 0);

const indexSource = readFileSync(join(root, ".pi/extensions/quorum/index.js"), "utf8");
assert(indexSource.indexOf("registerEvidenceIngestion(pi") < indexSource.indexOf("registerActiveContext(pi"));
assert(indexSource.indexOf("registerActiveContext(pi") < indexSource.indexOf("runtime.activateEphemeralMemoryProjection()"));
const runtimeSource = readFileSync(join(root, ".pi/extensions/quorum/runtime.mjs"), "utf8");
assert(!runtimeSource.includes('message: {\n          customType: "quorum-project-memory"'));
assert(runtimeSource.includes('pi.appendEntry("quorum-memory-influence"'));

process.stdout.write(`${JSON.stringify({
  ok: true,
  requestEphemeralProjectMemory: true,
  historicalRecommendationFiltered: true,
  repeatedProviderProjectionStable: true,
  payloadFreeExposure: true,
  exposureDigestAndContextBinding: true,
  kindSpecificRouteValidation: true,
  boundedArtifactValidation: true,
  actedInfluenceExact: true,
  errorInfluenceExact: true,
  canonicalToolEvidenceReference: true,
  contentAddressedArtifactReference: true,
  concurrentSettlementDeduplicated: true,
  influenceAppendRetry: true,
  restartOutboxRecovery: true,
  failedOutboxCanonicalFallback: true,
  tamperedFinalCannotSuppressRecovery: true,
  schemaValidFinalDriftCannotSuppressRecovery: true,
  activationOrder: ["evidence", "active-context", "ephemeral-memory"],
}, null, 2)}\n`);
