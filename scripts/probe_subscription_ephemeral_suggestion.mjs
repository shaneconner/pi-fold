#!/usr/bin/env node

// A bounded, subscription-only uptake probe for a one-request fold suggestion.
//
// Selection is deliberately perfect-oracle in this instrument. It measures only whether
// the carrier causes a useful first-hop peek when exact folded evidence is needed, whether
// the model ignores the same shape when the answer is already visible, and whether the
// carrier is absent from the request after a taken suggestion. It does not revive or judge
// any production selector.
//
//   node scripts/probe_subscription_ephemeral_suggestion.mjs
//   node scripts/probe_subscription_ephemeral_suggestion.mjs --live
//   node scripts/probe_subscription_ephemeral_suggestion.mjs --live --repetitions=1

import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  SUBSCRIPTION_CACHE_API,
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
import {
  buildSubscriptionCacheProjectionPlan,
  convertSubscriptionProjectionMessages,
} from "./probe_subscription_cache_projection.mjs";

export const EPHEMERAL_SUGGESTION_PROTOCOL_VERSION = 1;
export const EPHEMERAL_SUGGESTION_RELEVANT_LANE = "relevant-oracle";
export const EPHEMERAL_SUGGESTION_IRRELEVANT_LANE = "irrelevant-control";

const REQUEST_TIMEOUT_MS = 120_000;
const SYSTEM_PROMPT = "Complete the current request. Use tools only when they are needed, and never guess exact evidence.";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha256 = (value) => sha256(JSON.stringify(value));

function assertProbe(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRepetitions(value) {
  assertProbe(Number.isSafeInteger(value) && value >= 1 &&
    value <= SUBSCRIPTION_CACHE_MAX_REPETITIONS,
  `Repetitions must be an integer from 1 through ${SUBSCRIPTION_CACHE_MAX_REPETITIONS}`);
}

function lastTimestamp(messages) {
  return messages.reduce((latest, message) =>
    Number.isFinite(message?.timestamp) ? Math.max(latest, message.timestamp) : latest, 0);
}

function replaceLastUserMessage(messages, text) {
  const output = structuredClone(messages);
  let index = output.length - 1;
  while (index >= 0 && output[index]?.role !== "user") index -= 1;
  assertProbe(index >= 0, "Suggestion fixture has no current user request");
  output[index] = {
    ...output[index],
    content: [{ type: "text", text }],
  };
  return output;
}

export function ephemeralSuggestionCarrier({ marker, foldId }) {
  return {
    role: "custom",
    customType: "pi-fold-ephemeral-suggestion-probe",
    content: `${marker}. Potentially relevant exact evidence is folded under ${foldId}. ` +
      "If the current task needs a fact not present in its brief, use pi_fold_context " +
      `{"action":"peek","id":"${foldId}"}. Otherwise ignore this note. ` +
      "This projection-only note is available for this request only.",
    display: false,
    details: {
      ephemeral: true,
      source: "perfect-oracle-suggestion-probe",
      foldId,
      selector: "perfect-oracle",
    },
    timestamp: 0,
  };
}

function toolContract(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

async function suggestionLane({ repetition, condition, branch, convert }) {
  const relevant = condition === EPHEMERAL_SUGGESTION_RELEVANT_LANE;
  const identity = `${condition}-r${repetition}`;
  const marker = `EPHEMERAL-SUGGESTION-${sha256(identity).slice(0, 16)}`;
  const visibleAnswer = `visible-${sha256(`${identity}:visible`).slice(0, 20)}`;
  const expectedAnswer = relevant ? branch.expectedPeekSourceSha256 : visibleAnswer;
  const question = relevant
    ? "What exact 64-character sourceSha256 does the stored fold report? Return only that value."
    : `The answer is ${visibleAnswer}. Return exactly that value and do not do unrelated work.`;
  const foldedRequest = branch.requests.find((request) => request.label === "folded-projection");
  assertProbe(foldedRequest, "Production projection plan has no folded request");
  const durableAgentMessages = replaceLastUserMessage(foldedRequest.agentMessages, question);
  const carrier = ephemeralSuggestionCarrier({ marker, foldId: branch.foldId });
  carrier.timestamp = lastTimestamp(durableAgentMessages) + 1;
  const firstAgentMessages = [...durableAgentMessages, carrier];
  const firstMessages = await convert(firstAgentMessages);
  const serializedFirst = JSON.stringify(firstMessages);
  assertProbe(serializedFirst.includes(marker), "Pi conversion dropped the ephemeral suggestion");
  if (relevant) {
    assertProbe(!serializedFirst.includes(expectedAnswer),
      "The relevant suggestion request leaks the exact answer before peek");
    assertProbe(JSON.stringify(branch.peekResult).includes(expectedAnswer),
      "The production peek result does not carry the exact answer");
  } else {
    assertProbe(serializedFirst.includes(expectedAnswer),
      "The irrelevant control does not carry its visible answer");
  }
  return {
    condition,
    cacheKey: `pf-suggestion-${sha256(`${identity}:cache`).slice(0, 24)}`,
    foldId: branch.foldId,
    marker,
    expectedAnswer,
    durableAgentMessages,
    firstAgentMessages,
    firstMessages,
    ...(relevant ? { peekResult: branch.peekResult } : {}),
  };
}

export async function buildEphemeralSuggestionPlan({
  nonce = randomBytes(8).toString("hex"),
  repetitions = SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
} = {}) {
  assertProbe(/^[a-z0-9-]{8,32}$/.test(nonce),
    "Probe nonce must contain 8 through 32 lowercase letters, digits, or hyphens");
  assertRepetitions(repetitions);
  const relevantNonce = sha256(`${nonce}:relevant`).slice(0, 16);
  const irrelevantNonce = sha256(`${nonce}:irrelevant`).slice(0, 16);
  const [relevantProjection, irrelevantProjection] = await Promise.all([
    buildSubscriptionCacheProjectionPlan({ nonce: relevantNonce, repetitions }),
    buildSubscriptionCacheProjectionPlan({ nonce: irrelevantNonce, repetitions }),
  ]);
  const plans = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const relevantBranch = relevantProjection.plans[repetition - 1].lanes
      .find((lane) => lane.name === "real-projection-branch");
    const irrelevantBranch = irrelevantProjection.plans[repetition - 1].lanes
      .find((lane) => lane.name === "real-projection-branch");
    assertProbe(relevantBranch && irrelevantBranch, "Projection plan lost its real branch lane");
    plans.push({
      repetition,
      lanes: [
        await suggestionLane({
          repetition,
          condition: EPHEMERAL_SUGGESTION_RELEVANT_LANE,
          branch: relevantBranch,
          convert: convertSubscriptionProjectionMessages,
        }),
        await suggestionLane({
          repetition,
          condition: EPHEMERAL_SUGGESTION_IRRELEVANT_LANE,
          branch: irrelevantBranch,
          convert: convertSubscriptionProjectionMessages,
        }),
      ],
    });
  }
  return {
    protocolVersion: EPHEMERAL_SUGGESTION_PROTOCOL_VERSION,
    nonce,
    repetitions,
    systemPrompt: SYSTEM_PROMPT,
    tools: relevantProjection.tools,
    plans,
  };
}

export function ephemeralSuggestionManifest(plan) {
  return {
    protocolVersion: plan.protocolVersion,
    repetitions: plan.repetitions,
    initialRequests: plan.repetitions * 2,
    maximumRequests: plan.repetitions * 3,
    selector: "perfect-oracle fixture only",
    minimumCacheablePromptTokens: SUBSCRIPTION_CACHE_MINIMUM_TOKENS,
    systemPromptSha256: sha256(plan.systemPrompt),
    providerToolContractSha256: jsonSha256(toolContract(plan.tools)),
    conditions: [EPHEMERAL_SUGGESTION_RELEVANT_LANE, EPHEMERAL_SUGGESTION_IRRELEVANT_LANE],
    plans: plan.plans.map((repetition) => ({
      repetition: repetition.repetition,
      lanes: repetition.lanes.map((lane) => ({
        condition: lane.condition,
        cacheKeySha256: sha256(lane.cacheKey),
        foldId: lane.foldId,
        markerSha256: sha256(lane.marker),
        expectedAnswerSha256: sha256(lane.expectedAnswer),
        durableMessagesSha256: jsonSha256(lane.durableAgentMessages),
        firstMessagesSha256: jsonSha256(lane.firstMessages),
        firstMessageCount: lane.firstMessages.length,
        answerInitiallyVisible: lane.condition === EPHEMERAL_SUGGESTION_IRRELEVANT_LANE,
      })),
    })),
  };
}

export function assistantToolCalls(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "toolCall")
    : [];
}

export function assistantText(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "text")
      .map((part) => part.text ?? "").join("\n").trim()
    : "";
}

export function normalizedExactAnswer(value) {
  const text = String(value ?? "").trim();
  const quoted = text.match(/^(?:`([^`]+)`|"([^"]+)"|'([^']+)')$/);
  return (quoted ? quoted.slice(1).find((part) => part !== undefined) : text)?.trim() ?? "";
}

export function correctPeekCall(message, foldId) {
  const calls = assistantToolCalls(message);
  if (calls.length !== 1) return null;
  const [call] = calls;
  return call.name === "pi_fold_context" && call.arguments?.action === "peek" &&
    call.arguments?.id === foldId ? call : null;
}

export function assertEphemeralSuggestionPayload(payload, {
  cacheKey,
  marker,
  carrierPresent,
  expectedAnswer,
  answerPresent,
}) {
  assertImplicitSubscriptionEnvelope(payload, { cacheKey });
  assertProbe(payload.tool_choice === "auto", "Suggestion probe did not use automatic tool choice");
  assertProbe(Array.isArray(payload.input) && payload.input.length > 0,
    "Pi's Codex adapter produced no suggestion input events");
  const serialized = JSON.stringify(payload.input);
  assertProbe(serialized.includes(marker) === carrierPresent,
    carrierPresent ? "Serialized request lost the suggestion carrier" :
      "Serialized follow-up retained the one-request suggestion carrier");
  assertProbe(serialized.includes(expectedAnswer) === answerPresent,
    answerPresent ? "Serialized request lost its expected evidence" :
      "Serialized request leaked its expected evidence before peek");
  return {
    inputSha256: sha256(serialized),
    inputCharacters: serialized.length,
    inputItems: payload.input.length,
  };
}

function cacheRead(row) {
  return Number.isFinite(row?.usage?.cacheRead) ? row.usage.cacheRead : 0;
}

export function classifyEphemeralSuggestionRepetition(trial) {
  const relevant = trial?.relevant;
  const irrelevant = trial?.irrelevant;
  const relevantTaken = relevant?.correctPeek === true;
  const relevantUsed = relevantTaken && relevant?.exactAnswer === true;
  const carrierWithdrawn = relevantTaken && relevant?.carrierAbsentFromFollowup === true;
  const followupCachePreserved = relevantTaken &&
    cacheRead(relevant?.followupRow) >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS;
  const irrelevantIgnored = irrelevant?.toolCallCount === 0;
  const irrelevantAnswered = irrelevantIgnored && irrelevant?.exactAnswer === true;
  return {
    repetition: trial?.repetition ?? null,
    relevantTaken,
    relevantUsed,
    carrierWithdrawn,
    followupCachePreserved,
    irrelevantIgnored,
    irrelevantAnswered,
    confirmed: relevantUsed && carrierWithdrawn && followupCachePreserved && irrelevantAnswered,
  };
}

export function summarizeEphemeralSuggestionTrials(trials, repetitions) {
  assertRepetitions(repetitions);
  const perRepetition = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    perRepetition.push(classifyEphemeralSuggestionRepetition(
      trials.find((trial) => trial.repetition === repetition)));
  }
  const count = (field) => perRepetition.filter((entry) => entry[field] === true).length;
  const confirmedRepetitions = count("confirmed");
  return {
    requiredRepetitions: SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
    requestedRepetitions: repetitions,
    relevantOffers: repetitions,
    relevantTaken: count("relevantTaken"),
    relevantUsed: count("relevantUsed"),
    irrelevantOffers: repetitions,
    irrelevantIgnored: count("irrelevantIgnored"),
    irrelevantFalsePositivePeeks: repetitions - count("irrelevantIgnored"),
    carrierWithdrawnAfterEveryTakenOffer: perRepetition.every((entry) => entry.carrierWithdrawn),
    followupCachePreservedAfterEveryTakenOffer:
      perRepetition.every((entry) => entry.followupCachePreserved),
    confirmedRepetitions,
    promotionEligible: repetitions >= SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS &&
      confirmedRepetitions === repetitions,
    interpretation: "perfect-oracle carrier uptake only; no selector or threshold is evaluated",
    perRepetition,
  };
}

async function completeSuggestionRequest({
  runtime,
  model,
  plan,
  lane,
  phase,
  messages,
  carrierPresent,
  answerPresent,
  guardedFetch,
  onResult,
}) {
  let httpStatus = null;
  let sentShape = null;
  const result = await runtime.complete(model, {
    systemPrompt: plan.systemPrompt,
    messages,
    tools: plan.tools,
  }, {
    transport: "sse",
    sessionId: lane.cacheKey,
    cacheRetention: "short",
    fetch: guardedFetch,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: 0,
    toolChoice: "auto",
    onResponse: ({ status }) => { httpStatus = status; },
    onPayload: (payload) => {
      sentShape = assertEphemeralSuggestionPayload(payload, {
        cacheKey: lane.cacheKey,
        marker: lane.marker,
        carrierPresent,
        expectedAnswer: lane.expectedAnswer,
        answerPresent,
      });
      return payload;
    },
  });
  assertProbe(sentShape, `Pi's Codex adapter did not expose ${lane.condition}/${phase}`);
  const row = {
    repetition: lane.repetition,
    condition: lane.condition,
    phase,
    cacheKeySha256: sha256(lane.cacheKey),
    httpStatus,
    stopReason: result.stopReason,
    usage: normalizedSubscriptionUsage(result.usage),
    sentShape: {
      ...sentShape,
      carrierPresent,
      answerPresent,
      payloadObjectPreserved: true,
      outputCeilingPresent: false,
    },
    toolCalls: assistantToolCalls(result).map((call) => ({
      name: call.name,
      arguments: call.arguments,
    })),
    answer: assistantText(result),
    error: result.stopReason === "error" ? result.errorMessage : undefined,
  };
  onResult?.(row);
  assertProbe(subscriptionRequestSucceeded(row),
    `${lane.condition}/${phase} failed in repetition ${lane.repetition}: ` +
    `${result.errorMessage ?? result.stopReason}`);
  return { result, row };
}

export async function runEphemeralSuggestionProbe(plan, { onResult } = {}) {
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
  const trials = [];
  const record = (row) => {
    rows.push(row);
    onResult?.(row);
  };

  for (const repetitionPlan of plan.plans) {
    const relevantLane = repetitionPlan.lanes.find((lane) =>
      lane.condition === EPHEMERAL_SUGGESTION_RELEVANT_LANE);
    const irrelevantLane = repetitionPlan.lanes.find((lane) =>
      lane.condition === EPHEMERAL_SUGGESTION_IRRELEVANT_LANE);
    assertProbe(relevantLane && irrelevantLane, "Suggestion repetition lost one condition");
    relevantLane.repetition = repetitionPlan.repetition;
    irrelevantLane.repetition = repetitionPlan.repetition;

    const relevantFirst = await completeSuggestionRequest({
      runtime, model, plan, lane: relevantLane, phase: "suggestion",
      messages: relevantLane.firstMessages,
      carrierPresent: true,
      answerPresent: false,
      guardedFetch,
      onResult: record,
    });
    const peekCall = correctPeekCall(relevantFirst.result, relevantLane.foldId);
    let relevantFollowup = null;
    let exactRelevantAnswer = false;
    if (peekCall) {
      const toolResult = {
        role: "toolResult",
        toolCallId: peekCall.id,
        toolName: peekCall.name,
        content: relevantLane.peekResult.content,
        details: relevantLane.peekResult.details,
        isError: false,
        timestamp: (relevantFirst.result.timestamp ?? Date.now()) + 1,
      };
      const followupAgentMessages = [
        ...relevantLane.durableAgentMessages,
        relevantFirst.result,
        toolResult,
      ];
      const followupMessages = await convertSubscriptionProjectionMessages(followupAgentMessages);
      assertProbe(!JSON.stringify(followupMessages).includes(relevantLane.marker),
        "Taken suggestion leaked its carrier into the follow-up context");
      relevantFollowup = await completeSuggestionRequest({
        runtime, model, plan, lane: relevantLane, phase: "after-peek",
        messages: followupMessages,
        carrierPresent: false,
        answerPresent: true,
        guardedFetch,
        onResult: record,
      });
      exactRelevantAnswer = normalizedExactAnswer(assistantText(relevantFollowup.result)) ===
        relevantLane.expectedAnswer;
    }

    const irrelevantFirst = await completeSuggestionRequest({
      runtime, model, plan, lane: irrelevantLane, phase: "suggestion",
      messages: irrelevantLane.firstMessages,
      carrierPresent: true,
      answerPresent: true,
      guardedFetch,
      onResult: record,
    });
    const irrelevantCalls = assistantToolCalls(irrelevantFirst.result);
    trials.push({
      repetition: repetitionPlan.repetition,
      relevant: {
        correctPeek: Boolean(peekCall),
        toolCallCount: assistantToolCalls(relevantFirst.result).length,
        exactAnswer: exactRelevantAnswer,
        carrierAbsentFromFollowup: Boolean(relevantFollowup &&
          relevantFollowup.row.sentShape.carrierPresent === false),
        firstRow: relevantFirst.row,
        followupRow: relevantFollowup?.row ?? null,
      },
      irrelevant: {
        toolCallCount: irrelevantCalls.length,
        exactAnswer: normalizedExactAnswer(assistantText(irrelevantFirst.result)) ===
          irrelevantLane.expectedAnswer,
        firstRow: irrelevantFirst.row,
      },
    });
  }

  return {
    protocolVersion: plan.protocolVersion,
    live: true,
    provider: SUBSCRIPTION_CACHE_PROVIDER,
    model: model.id,
    api: model.api,
    expectedApi: SUBSCRIPTION_CACHE_API,
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
      selector: "perfect-oracle fixture only",
      shippedRuntimeMutation: false,
      payloadMutation: false,
    },
    manifest: ephemeralSuggestionManifest(plan),
    rows,
    trials,
    verdict: summarizeEphemeralSuggestionTrials(trials, plan.repetitions),
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
      "Usage: node scripts/probe_subscription_ephemeral_suggestion.mjs [--live] " +
      "[--repetitions=1..5]\n" +
      "Without --live, builds the perfect-oracle suggestion manifest and makes 0 network calls.\n");
    return;
  }
  const plan = await buildEphemeralSuggestionPlan({ repetitions: options.repetitions });
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({
      live: false,
      networkRequests: 0,
      provider: SUBSCRIPTION_CACHE_PROVIDER,
      model: SUBSCRIPTION_CACHE_MODEL,
      endpoint: SUBSCRIPTION_CACHE_ENDPOINT,
      manifest: ephemeralSuggestionManifest(plan),
    }, null, 2)}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const report = await runEphemeralSuggestionProbe(plan, {
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
    process.stderr.write(`Ephemeral suggestion probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
