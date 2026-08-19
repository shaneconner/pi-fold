#!/usr/bin/env node

// A bounded, subscription-only probe for the provider shape produced by pi-fold and Pi:
//
//   project raw -> commit a real fold -> expand -> refold
//   project stable context -> append one temporary carrier -> withdraw it
//
// The fold and projection states come from the shipped active-context implementation.
// Pi's own convertToLlm transform and openai-codex-responses adapter serialize every
// request. The payload observer validates and hashes that serialization but never edits it.
//
//   node scripts/probe_subscription_cache_projection.mjs
//   node scripts/probe_subscription_cache_projection.mjs --live
//   node scripts/probe_subscription_cache_projection.mjs --live --repetitions=1

import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import {
  SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
  SUBSCRIPTION_CACHE_ENDPOINT,
  SUBSCRIPTION_CACHE_MAX_REPETITIONS,
  SUBSCRIPTION_CACHE_MINIMUM_TOKENS,
  SUBSCRIPTION_CACHE_MODEL,
  SUBSCRIPTION_CACHE_PROVIDER,
  assertImplicitSubscriptionEnvelope,
  assertSubscriptionDestination,
  assertSubscriptionModel,
  normalizedSubscriptionUsage,
  subscriptionRequestSucceeded,
} from "./probe_subscription_cache_topology.mjs";

export const SUBSCRIPTION_CACHE_PROJECTION_PROTOCOL_VERSION = 1;

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const REQUEST_TIMEOUT_MS = 120_000;
const PROJECTION_CONTEXT_WINDOW = 32_000;
const BRANCH_SEQUENCE = Object.freeze([
  "raw-projection",
  "folded-projection",
  "expanded-projection",
  "refolded-projection",
]);
const CARRIER_SEQUENCE = Object.freeze([
  "prefix-warm",
  "temporary-carrier-present",
  "temporary-carrier-withdrawn",
]);
const SYSTEM_PROMPT = "Return exactly OK and nothing else.";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha256 = (value) => sha256(JSON.stringify(value));
const jsonCharacters = (value) => JSON.stringify(value).length;

function assertProbe(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRepetitions(value) {
  assertProbe(Number.isSafeInteger(value) && value >= 1 &&
    value <= SUBSCRIPTION_CACHE_MAX_REPETITIONS,
  `Repetitions must be an integer from 1 through ${SUBSCRIPTION_CACHE_MAX_REPETITIONS}`);
}

function itemEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function serializedItemPrefix(prefix, value) {
  return Array.isArray(prefix) && Array.isArray(value) && prefix.length <= value.length &&
    prefix.every((item, index) => itemEqual(item, value[index]));
}

export function commonSerializedItemPrefix(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return 0;
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && itemEqual(left[index], right[index])) index += 1;
  return index;
}

let projectionModulesPromise;

async function projectionModules() {
  projectionModulesPromise ??= (async () => {
    const activeContext = await createJiti(import.meta.url)
      .import(join(PROJECT, "extensions", "active-context.ts"));
    const toolSurface = await createJiti(import.meta.url)
      .import(join(PROJECT, "extensions", "lib", "tool-surface.ts"));
    const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const messagesModule = await import(pathToFileURL(
      join(dirname(codingAgentEntry), "core", "messages.js")).href);
    assertProbe(typeof messagesModule.convertToLlm === "function",
      "Installed Pi does not expose its convertToLlm implementation");
    return {
      activeContext,
      buildActiveContextTool: toolSurface.buildActiveContextTool,
      convertToLlm: messagesModule.convertToLlm,
    };
  })();
  return projectionModulesPromise;
}

export async function convertSubscriptionProjectionMessages(agentMessages) {
  const { convertToLlm } = await projectionModules();
  return convertToLlm(agentMessages);
}

function transcript(sessionId) {
  const entries = [];
  const messages = [];
  let parentId = null;
  let ordinal = 0;
  const add = (message) => {
    ordinal += 1;
    const id = `${sessionId}-entry-${String(ordinal).padStart(3, "0")}`;
    const value = { ...message, timestamp: ordinal };
    entries.push({ type: "message", id, parentId, message: value });
    messages.push(value);
    parentId = id;
    return id;
  };
  return { entries, messages, add };
}

function snapshot(activeContext, sessionId, built) {
  return activeContext.mapActiveContext({
    sessionId,
    eventMessages: built.messages,
    contextEntries: built.entries,
    contextWindow: PROJECTION_CONTEXT_WINDOW,
  });
}

function textMessage(role, text, extra = {}) {
  return { role, content: [{ type: "text", text }], ...extra };
}

function makeRequest(convertToLlm, label, projectionState, agentMessages, expectation) {
  const llmMessages = convertToLlm(agentMessages);
  return {
    label,
    projectionState,
    agentMessages,
    llmMessages,
    expectation,
  };
}

function isMessagePrefix(prefix, value) {
  return prefix.length <= value.length &&
    prefix.every((message, index) => itemEqual(message, value[index]));
}

async function branchLane(identity, modules) {
  const { activeContext, convertToLlm } = modules;
  const sessionId = `projection-${identity}`;
  const built = transcript(sessionId);
  const identityMarker = `REAL-PROJECTION-${identity}`;
  const rawMarker = `RAW-MIDDLE-${identity}`;
  const stableTailMarker = `STABLE-TAIL-${identity}`;

  built.add(textMessage("user", `${identityMarker}. ` +
    "Stable anchor alpha beta gamma delta epsilon. ".repeat(420)));
  built.add(textMessage("assistant", "The stable anchor is recorded.", { stopReason: "stop" }));
  built.add(textMessage("user", "Inspect the exact target evidence."));
  built.add({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `read-${identity}`,
      name: "read",
      arguments: { path: "cache-topology-target.txt" },
    }],
    stopReason: "toolUse",
  });
  const targetId = built.add({
    role: "toolResult",
    toolCallId: `read-${identity}`,
    toolName: "read",
    content: [{ type: "text", text: `${rawMarker}. ` +
      "Exact target chronology kappa lambda mu nu. ".repeat(420) }],
    isError: false,
  });
  built.add(textMessage("assistant", "The exact target evidence is recorded.",
    { stopReason: "stop" }));
  built.add(textMessage("user", `${stableTailMarker}. ` +
    "Stable context after the mutable span theta iota zeta. ".repeat(420)));
  built.add(textMessage("assistant", "The stable tail is recorded.", { stopReason: "stop" }));
  built.add(textMessage("user", "Return exactly OK."));

  const initialSnapshot = snapshot(activeContext, sessionId, built);
  const emptyState = activeContext.emptyActiveContextState(sessionId);
  const candidate = activeContext.manualFoldCandidate(initialSnapshot, emptyState, [targetId]);
  assertProbe(candidate.kind === "tool-result",
    "The real projection fixture did not select its exact tool result");
  const prepared = await activeContext.prepareFold({
    candidate,
    snapshot: initialSnapshot,
    state: emptyState,
    generation: 1,
    brief: "cache-topology-target.txt recorded exact target chronology for the projection probe.",
    now: () => 1,
  });
  const foldedState = activeContext.commitPreparedFold({
    prepared,
    snapshot: initialSnapshot,
    state: emptyState,
    generation: 1,
  });
  const expandedState = activeContext.setFoldProjectionState(
    foldedState, prepared.id, "expanded");
  const refoldedState = activeContext.setFoldProjectionState(
    expandedState, prepared.id, "folded");
  const foldMarker = `[pi-fold active-context fold ${prepared.id}]`;

  const rawMessages = activeContext.projectActiveContext(initialSnapshot, emptyState);
  built.add(textMessage("assistant", "OK", { stopReason: "stop" }));
  built.add(textMessage("user", "Return exactly OK after the fold commit."));
  const foldedSnapshot = snapshot(activeContext, sessionId, built);
  const foldedMessages = activeContext.projectActiveContext(foldedSnapshot, foldedState);

  built.add({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `expand-${identity}`,
      name: "pi_fold_context",
      arguments: { action: "expand", id: prepared.id },
    }],
    stopReason: "toolUse",
  });
  built.add({
    role: "toolResult",
    toolCallId: `expand-${identity}`,
    toolName: "pi_fold_context",
    content: [{ type: "text", text: `Expanded ${prepared.id}; exact source is visible.` }],
    isError: false,
  });
  const expandedSnapshot = snapshot(activeContext, sessionId, built);
  const expandedMessages = activeContext.projectActiveContext(expandedSnapshot, expandedState);

  built.add({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: `refold-${identity}`,
      name: "pi_fold_context",
      arguments: { action: "refold", id: prepared.id },
    }],
    stopReason: "toolUse",
  });
  built.add({
    role: "toolResult",
    toolCallId: `refold-${identity}`,
    toolName: "pi_fold_context",
    content: [{ type: "text", text: `Refolded ${prepared.id}; the brief is visible.` }],
    isError: false,
  });
  const refoldedSnapshot = snapshot(activeContext, sessionId, built);
  const refoldedMessages = activeContext.projectActiveContext(refoldedSnapshot, refoldedState);

  assertProbe(isMessagePrefix(rawMessages, expandedMessages),
    "Expanded production projection does not revisit the earlier raw request prefix");
  assertProbe(isMessagePrefix(foldedMessages, refoldedMessages),
    "Refolded production projection does not revisit the earlier folded request prefix");
  const targetIndex = initialSnapshot.mapped.find((item) => item.ref?.entryId === targetId)?.index;
  assertProbe(Number.isSafeInteger(targetIndex), "Target evidence lost its mapped position");
  assertProbe(JSON.stringify(rawMessages[targetIndex]).includes(rawMarker) &&
    !JSON.stringify(foldedMessages[targetIndex]).includes(rawMarker) &&
    JSON.stringify(foldedMessages[targetIndex]).includes(foldMarker),
  "The real fold did not replace only the target evidence with its production placeholder");
  assertProbe(rawMessages.slice(0, targetIndex).every((message, index) =>
    itemEqual(message, foldedMessages[index])),
  "Material before the real fold changed");
  assertProbe(rawMessages.slice(targetIndex + 1).every((message, index) =>
    itemEqual(message, foldedMessages[targetIndex + 1 + index])),
  "Material after the real fold changed before the later request tail");
  const peekDetails = activeContext.peekFoldSource({
    foldId: prepared.id,
    state: foldedState,
    entries: built.entries,
    sessionId,
  });
  const peekResult = activeContext.toolPayload(peekDetails);
  assertProbe(typeof peekDetails.sourceSha256 === "string" &&
    peekDetails.sourceSha256.length === 64,
  "Production peek did not carry the fold source digest");

  const expected = (raw, folded) => ({
    identityMarker,
    markersPresent: [identityMarker, stableTailMarker, raw ? rawMarker : foldMarker],
    markersAbsent: [raw ? foldMarker : rawMarker],
    raw,
    folded,
    carrier: false,
  });
  return {
    name: "real-projection-branch",
    cacheKey: `pf-real-${identity}`,
    foldId: prepared.id,
    targetIndex,
    peekResult,
    expectedPeekSourceSha256: peekDetails.sourceSha256,
    requests: [
      makeRequest(convertToLlm, BRANCH_SEQUENCE[0], "raw", rawMessages, expected(true, false)),
      makeRequest(convertToLlm, BRANCH_SEQUENCE[1], "folded", foldedMessages, expected(false, true)),
      makeRequest(convertToLlm, BRANCH_SEQUENCE[2], "expanded", expandedMessages, expected(true, false)),
      makeRequest(convertToLlm, BRANCH_SEQUENCE[3], "refolded", refoldedMessages, expected(false, true)),
    ],
  };
}

function carrierLane(identity, modules) {
  const { activeContext, convertToLlm } = modules;
  const sessionId = `carrier-${identity}`;
  const built = transcript(sessionId);
  const identityMarker = `REAL-CARRIER-${identity}`;
  const carrierMarker = `TEMPORARY-CARRIER-${identity}`;
  const emptyState = activeContext.emptyActiveContextState(sessionId);

  built.add(textMessage("user", `${identityMarker}. ` +
    "Stable temporary-carrier prefix alpha beta gamma delta epsilon. ".repeat(420)));
  built.add(textMessage("assistant", "The stable prefix is recorded.", { stopReason: "stop" }));
  built.add(textMessage("user", "Return exactly OK."));
  const warmSnapshot = snapshot(activeContext, sessionId, built);
  const warmMessages = activeContext.projectActiveContext(warmSnapshot, emptyState);

  built.add(textMessage("assistant", "OK", { stopReason: "stop" }));
  built.add(textMessage("user", "Use surfaced context only if it is relevant."));
  const carrierSnapshot = snapshot(activeContext, sessionId, built);
  const durableCarrierPrefix = activeContext.projectActiveContext(carrierSnapshot, emptyState);
  const carrier = {
    role: "custom",
    customType: "pi-fold-cache-topology-probe",
    content: `${carrierMarker}. This projection-only suggestion may disappear after one request.`,
    display: false,
    details: { ephemeral: true, source: "subscription-cache-projection-probe" },
    timestamp: 1_000,
  };
  const carrierMessages = [...durableCarrierPrefix, carrier];

  built.add(textMessage("assistant", "No surfaced evidence was needed.", { stopReason: "stop" }));
  built.add(textMessage("user", "Return exactly OK after withdrawing the carrier."));
  const withdrawnSnapshot = snapshot(activeContext, sessionId, built);
  const withdrawnMessages = activeContext.projectActiveContext(withdrawnSnapshot, emptyState);

  assertProbe(isMessagePrefix(warmMessages, durableCarrierPrefix) &&
    isMessagePrefix(warmMessages, withdrawnMessages),
  "The stable production projection is not a prefix on both carrier requests");
  assertProbe(isMessagePrefix(durableCarrierPrefix, withdrawnMessages),
    "Withdrawing the carrier changed durable context that preceded it");
  assertProbe(carrierMessages.at(-1)?.role === "custom" && carrier.details.ephemeral === true,
    "The temporary carrier does not use Pi's projection-only custom-message shape");

  const expected = (carrierPresent) => ({
    identityMarker,
    markersPresent: [identityMarker, ...(carrierPresent ? [carrierMarker] : [])],
    markersAbsent: carrierPresent ? [] : [carrierMarker],
    raw: false,
    folded: false,
    carrier: carrierPresent,
  });
  return {
    name: "temporary-carrier",
    cacheKey: `pf-carrier-${identity}`,
    carrierMarker,
    requests: [
      makeRequest(convertToLlm, CARRIER_SEQUENCE[0], "stable", warmMessages, expected(false)),
      makeRequest(convertToLlm, CARRIER_SEQUENCE[1], "carrier-present",
        carrierMessages, expected(true)),
      makeRequest(convertToLlm, CARRIER_SEQUENCE[2], "carrier-withdrawn",
        withdrawnMessages, expected(false)),
    ],
  };
}

function providerToolContract(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function projectionTools(modules) {
  const { activeContext, buildActiveContextTool } = modules;
  const execute = async () => ({ content: [{ type: "text", text: "Probe fixture only." }] });
  return [
    {
      name: "read",
      label: "Read",
      description: "Read a file from the working tree.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      execute,
    },
    buildActiveContextTool({
      name: activeContext.DEFAULT_ACTIVE_CONTEXT_TOOL_NAME,
      label: activeContext.DEFAULT_ACTIVE_CONTEXT_TOOL_LABEL,
      allowedActions: activeContext.ACTIVE_CONTEXT_TOOL_ACTIONS,
      fullSurface: true,
      maxBriefChars: activeContext.ACTIVE_CONTEXT_POLICY.maxBriefChars,
      statusDetails: ["fold_candidates", "tree", "folds", "objects"],
      minPeekSliceBytes: activeContext.PEEK_MIN_SLICE_BYTES,
      defaultPeekBytes: activeContext.PEEK_DEFAULT_MAX_BYTES,
      handler: execute,
    }),
  ];
}

export async function buildSubscriptionCacheProjectionPlan({
  nonce = randomBytes(8).toString("hex"),
  repetitions = SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
} = {}) {
  assertProbe(/^[a-z0-9-]{8,32}$/.test(nonce),
    "Probe nonce must contain 8 through 32 lowercase letters, digits, or hyphens");
  assertRepetitions(repetitions);
  const modules = await projectionModules();
  const tools = projectionTools(modules);
  const plans = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    plans.push({
      repetition,
      lanes: [
        await branchLane(`${nonce}-r${repetition}`, modules),
        carrierLane(`${nonce}-r${repetition}`, modules),
      ],
    });
  }
  return {
    protocolVersion: SUBSCRIPTION_CACHE_PROJECTION_PROTOCOL_VERSION,
    nonce,
    repetitions,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    plans,
  };
}

export function subscriptionCacheProjectionManifest(plan) {
  return {
    protocolVersion: plan.protocolVersion,
    repetitions: plan.repetitions,
    requestCount: plan.plans.reduce((count, repetition) =>
      count + repetition.lanes.reduce((laneCount, lane) => laneCount + lane.requests.length, 0), 0),
    minimumCacheablePromptTokens: SUBSCRIPTION_CACHE_MINIMUM_TOKENS,
    projectionContextWindow: PROJECTION_CONTEXT_WINDOW,
    systemPromptSha256: sha256(plan.systemPrompt),
    providerToolContractSha256: jsonSha256(providerToolContract(plan.tools)),
    sequences: {
      projectionBranch: [...BRANCH_SEQUENCE],
      temporaryCarrier: [...CARRIER_SEQUENCE],
    },
    plans: plan.plans.map((repetition) => ({
      repetition: repetition.repetition,
      lanes: repetition.lanes.map((lane) => ({
        name: lane.name,
        cacheKeySha256: sha256(lane.cacheKey),
        ...(lane.foldId ? { foldId: lane.foldId, targetIndex: lane.targetIndex } : {}),
        requests: lane.requests.map((request) => ({
          label: request.label,
          projectionState: request.projectionState,
          agentMessagesSha256: jsonSha256(request.agentMessages),
          llmMessagesSha256: jsonSha256(request.llmMessages),
          llmCharacters: jsonCharacters(request.llmMessages),
          messageCount: request.llmMessages.length,
          expectation: {
            raw: request.expectation.raw,
            folded: request.expectation.folded,
            carrier: request.expectation.carrier,
          },
        })),
      })),
    })),
  };
}

export function assertSerializedSubscriptionProjectionPayload(payload, { cacheKey, expectation }) {
  assertImplicitSubscriptionEnvelope(payload, { cacheKey });
  assertProbe(Array.isArray(payload.input) && payload.input.length > 0,
    "Pi's Codex adapter produced no serialized input events");
  assertProbe(payload.tool_choice === "none",
    "Projection probe did not disable provider tool selection");
  const serialized = JSON.stringify(payload.input);
  for (const marker of expectation.markersPresent) {
    assertProbe(serialized.includes(marker), `Serialized projection lost expected marker ${marker}`);
  }
  for (const marker of expectation.markersAbsent) {
    assertProbe(!serialized.includes(marker), `Serialized projection retained withdrawn marker ${marker}`);
  }
  return {
    inputSha256: sha256(serialized),
    inputCharacters: serialized.length,
    inputItems: payload.input.length,
  };
}

function cacheRead(row) {
  return Number.isFinite(row?.usage?.cacheRead) ? row.usage.cacheRead : 0;
}

export function classifySubscriptionCacheProjectionRepetition(rows) {
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  const required = [...BRANCH_SEQUENCE, ...CARRIER_SEQUENCE];
  const complete = required.every((label) => byLabel[label]);
  const allRequestsSucceeded = complete &&
    required.every((label) => subscriptionRequestSucceeded(byLabel[label]));
  if (!allRequestsSucceeded) {
    return {
      complete,
      allRequestsSucceeded,
      projectionBranchRevisitConfirmed: false,
      temporaryCarrierWithdrawalConfirmed: false,
      cacheConfirmed: false,
    };
  }

  const sharedForkRead = cacheRead(byLabel["folded-projection"]);
  const expandedRead = cacheRead(byLabel["expanded-projection"]);
  const refoldedRead = cacheRead(byLabel["refolded-projection"]);
  const carrierRead = cacheRead(byLabel["temporary-carrier-present"]);
  const withdrawnRead = cacheRead(byLabel["temporary-carrier-withdrawn"]);
  const sharedPrefixObserved = sharedForkRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS;
  const expandedBeyondFork = expandedRead - sharedForkRead;
  const refoldedBeyondFork = refoldedRead - sharedForkRead;
  const expandedBranchObserved = expandedRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS;
  const refoldedBranchObserved = refoldedRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS;
  const projectionBranchRevisitConfirmed = expandedBranchObserved && refoldedBranchObserved &&
    expandedBeyondFork > 0 && refoldedBeyondFork > 0;
  const temporaryCarrierWithdrawalConfirmed =
    carrierRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS && withdrawnRead >= carrierRead;
  return {
    complete,
    allRequestsSucceeded,
    sharedForkRead,
    sharedPrefixObserved,
    expandedRead,
    expandedBranchObserved,
    expandedBeyondFork,
    refoldedRead,
    refoldedBranchObserved,
    refoldedBeyondFork,
    projectionBranchRevisitConfirmed,
    temporaryCarrierRead: carrierRead,
    withdrawnRead,
    temporaryCarrierWithdrawalConfirmed,
    cacheConfirmed: projectionBranchRevisitConfirmed && temporaryCarrierWithdrawalConfirmed,
  };
}

export function serializedProjectionTopology(repetition, inputs) {
  const raw = inputs.get("raw-projection");
  const folded = inputs.get("folded-projection");
  const expanded = inputs.get("expanded-projection");
  const refolded = inputs.get("refolded-projection");
  const warm = inputs.get("prefix-warm");
  const carrier = inputs.get("temporary-carrier-present");
  const withdrawn = inputs.get("temporary-carrier-withdrawn");
  const complete = [raw, folded, expanded, refolded, warm, carrier, withdrawn]
    .every((value) => Array.isArray(value));
  if (!complete) return { repetition, complete: false, confirmed: false };
  const carrierWithdrawalCommonItems = commonSerializedItemPrefix(carrier, withdrawn);
  const rawPrefixOfExpanded = serializedItemPrefix(raw, expanded);
  const foldedPrefixOfRefolded = serializedItemPrefix(folded, refolded);
  const warmPrefixOfCarrier = serializedItemPrefix(warm, carrier);
  const warmPrefixOfWithdrawn = serializedItemPrefix(warm, withdrawn);
  const carrierWithdrawalForkAfterWarm = carrierWithdrawalCommonItems >= warm.length;
  return {
    repetition,
    complete: true,
    rawItems: raw.length,
    expandedItems: expanded.length,
    foldedItems: folded.length,
    refoldedItems: refolded.length,
    warmItems: warm.length,
    carrierItems: carrier.length,
    withdrawnItems: withdrawn.length,
    carrierWithdrawalCommonItems,
    rawPrefixOfExpanded,
    foldedPrefixOfRefolded,
    warmPrefixOfCarrier,
    warmPrefixOfWithdrawn,
    carrierWithdrawalForkAfterWarm,
    confirmed: rawPrefixOfExpanded && foldedPrefixOfRefolded && warmPrefixOfCarrier &&
      warmPrefixOfWithdrawn && carrierWithdrawalForkAfterWarm,
  };
}

export function summarizeSubscriptionCacheProjection(rows, repetitions, topologies) {
  assertRepetitions(repetitions);
  const topologyByRepetition = new Map(topologies.map((entry) => [entry.repetition, entry]));
  const perRepetition = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const cache = classifySubscriptionCacheProjectionRepetition(
      rows.filter((row) => row.repetition === repetition));
    const topology = topologyByRepetition.get(repetition) ??
      { repetition, complete: false, confirmed: false };
    perRepetition.push({
      repetition,
      ...cache,
      serializedTopologyConfirmed: topology.confirmed,
      confirmed: cache.cacheConfirmed && topology.confirmed,
    });
  }
  const confirmedRepetitions = perRepetition.filter((entry) => entry.confirmed).length;
  return {
    requiredRepetitions: SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
    requestedRepetitions: repetitions,
    confirmedRepetitions,
    projectionBranchRevisitConfirmedInEveryRepetition:
      perRepetition.every((entry) => entry.projectionBranchRevisitConfirmed),
    temporaryCarrierWithdrawalConfirmedInEveryRepetition:
      perRepetition.every((entry) => entry.temporaryCarrierWithdrawalConfirmed),
    serializedTopologyConfirmedInEveryRepetition:
      perRepetition.every((entry) => entry.serializedTopologyConfirmed),
    promotionEligible: repetitions >= SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS &&
      confirmedRepetitions === repetitions,
    perRepetition,
  };
}

export async function runSubscriptionCacheProjectionProbe(plan, { onResult } = {}) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: true });
  const model = runtime.getModel(SUBSCRIPTION_CACHE_PROVIDER, SUBSCRIPTION_CACHE_MODEL);
  assertSubscriptionModel(runtime, model);

  const destinations = new Set();
  const guardedFetch = async (input, init) => {
    destinations.add(assertSubscriptionDestination(input, init));
    return globalThis.fetch(input, init);
  };
  const rows = [];
  const topologies = [];
  for (const repetition of plan.plans) {
    const serializedInputs = new Map();
    for (const lane of repetition.lanes) {
      for (const request of lane.requests) {
        let httpStatus = null;
        let sentShape = null;
        let serializedInput = null;
        const result = await runtime.complete(model, {
          systemPrompt: plan.systemPrompt,
          messages: request.llmMessages,
          tools: plan.tools,
        }, {
          transport: "sse",
          sessionId: lane.cacheKey,
          cacheRetention: "short",
          fetch: guardedFetch,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxRetries: 0,
          toolChoice: "none",
          onResponse: ({ status }) => { httpStatus = status; },
          onPayload: (payload) => {
            sentShape = assertSerializedSubscriptionProjectionPayload(payload, {
              cacheKey: lane.cacheKey,
              expectation: request.expectation,
            });
            serializedInput = structuredClone(payload.input);
            return payload;
          },
        });
        assertProbe(sentShape && serializedInput,
          `Pi's Codex adapter did not expose ${request.label} for inspection`);
        serializedInputs.set(request.label, serializedInput);
        const row = {
          repetition: repetition.repetition,
          lane: lane.name,
          label: request.label,
          projectionState: request.projectionState,
          cacheKeySha256: sha256(lane.cacheKey),
          llmMessagesSha256: jsonSha256(request.llmMessages),
          httpStatus,
          stopReason: result.stopReason,
          usage: normalizedSubscriptionUsage(result.usage),
          sentShape: {
            ...sentShape,
            payloadObjectPreserved: true,
            implicitCacheOnly: true,
            outputCeilingPresent: false,
          },
          error: result.stopReason === "error" ? result.errorMessage : undefined,
        };
        rows.push(row);
        onResult?.(row);
        assertProbe(subscriptionRequestSucceeded(row),
          `${request.label} failed in repetition ${repetition.repetition}: ` +
          `${result.errorMessage ?? result.stopReason}`);
      }
    }
    const topology = serializedProjectionTopology(repetition.repetition, serializedInputs);
    assertProbe(topology.confirmed,
      `Pi's serialized request topology drifted in repetition ${repetition.repetition}`);
    topologies.push(topology);
  }

  return {
    protocolVersion: plan.protocolVersion,
    live: true,
    provider: SUBSCRIPTION_CACHE_PROVIDER,
    model: model.id,
    api: model.api,
    subscription: runtime.isUsingSubscription(SUBSCRIPTION_CACHE_PROVIDER),
    oauth: runtime.isUsingOAuth(SUBSCRIPTION_CACHE_PROVIDER),
    endpoint: SUBSCRIPTION_CACHE_ENDPOINT,
    destinations: [...destinations],
    constraints: {
      transport: "sse",
      implicitCacheOnly: true,
      explicitCacheParameters: false,
      providerOutputCeiling: false,
      clientRetries: 0,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      productionFoldFunctions: true,
      piConvertToLlm: true,
      piCodexSerialization: true,
      payloadMutation: false,
    },
    manifest: subscriptionCacheProjectionManifest(plan),
    serializedTopologies: topologies,
    rows,
    verdict: summarizeSubscriptionCacheProjection(rows, plan.repetitions, topologies),
  };
}

function parseCli(argv) {
  let live = false;
  let repetitions = SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS;
  let help = false;
  for (const argument of argv) {
    if (argument === "--live") live = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("--repetitions=")) {
      repetitions = Number(argument.slice("--repetitions=".length));
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  assertRepetitions(repetitions);
  return { live, repetitions, help };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/probe_subscription_cache_projection.mjs [--live] [--repetitions=1..5]\n" +
      "Without --live, builds real projections, prints their manifest, and makes no network calls.\n");
    return;
  }
  const plan = await buildSubscriptionCacheProjectionPlan({ repetitions: options.repetitions });
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({
      live: false,
      networkRequests: 0,
      provider: SUBSCRIPTION_CACHE_PROVIDER,
      model: SUBSCRIPTION_CACHE_MODEL,
      endpoint: SUBSCRIPTION_CACHE_ENDPOINT,
      manifest: subscriptionCacheProjectionManifest(plan),
    }, null, 2)}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const report = await runSubscriptionCacheProjectionProbe(plan, {
    onResult: (row) => process.stderr.write(`${JSON.stringify(row)}\n`),
  });
  process.stdout.write(`${JSON.stringify({
    ...report,
    startedAt,
    finishedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Subscription cache projection probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
