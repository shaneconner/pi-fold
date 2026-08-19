#!/usr/bin/env node

// A bounded, subscription-only probe for the two cache shapes pi-fold may rely on:
//
//   raw -> fold -> expand -> refold
//   stable prefix -> temporary suffix -> removed/replaced suffix
//
// No explicit breakpoint field is sent. The ChatGPT Codex subscription endpoint rejected
// those API-preview fields in the probe that motivated this harness, so this measures only
// the implicit cache behavior Pi can actually reach through its OAuth-backed provider.
//
//   node scripts/probe_subscription_cache_topology.mjs
//   node scripts/probe_subscription_cache_topology.mjs --live
//   node scripts/probe_subscription_cache_topology.mjs --live --repetitions=1

import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SUBSCRIPTION_CACHE_TOPOLOGY_PROTOCOL_VERSION = 1;
export const SUBSCRIPTION_CACHE_PROVIDER = "openai-codex";
export const SUBSCRIPTION_CACHE_MODEL = "gpt-5.6-luna";
export const SUBSCRIPTION_CACHE_API = "openai-codex-responses";
export const SUBSCRIPTION_CACHE_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const SUBSCRIPTION_CACHE_MINIMUM_TOKENS = 1_024;
export const SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS = 3;
export const SUBSCRIPTION_CACHE_MAX_REPETITIONS = 5;

const REQUEST_TIMEOUT_MS = 120_000;
const BRANCH_SEQUENCE = Object.freeze(["raw-first", "folded-first", "raw-again", "folded-again"]);
const SUFFIX_SEQUENCE = Object.freeze([
  "prefix-warm", "temporary-suffix-present", "temporary-suffix-replaced",
]);
const PROVIDER_CEILING_FIELDS = Object.freeze(["max_output_tokens", "max_tokens", "maxTokens"]);
const EXPLICIT_CACHE_FIELDS = Object.freeze([
  "prompt_cache_options", "prompt_cache_breakpoint", "prompt_cache_retention",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const inputText = (role, text) => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});
const inputSha256 = (input) => sha256(JSON.stringify(input));
const inputCharacters = (input) => JSON.stringify(input).length;

function assertProbe(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRepetitions(value) {
  assertProbe(Number.isSafeInteger(value) && value >= 1 && value <= SUBSCRIPTION_CACHE_MAX_REPETITIONS,
    `Repetitions must be an integer from 1 through ${SUBSCRIPTION_CACHE_MAX_REPETITIONS}`);
}

function nestedField(value, names) {
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (names.includes(key)) return key;
    const found = nestedField(child, names);
    if (found) return found;
  }
  return null;
}

export function assertImplicitSubscriptionEnvelope(payload, { cacheKey }) {
  assertProbe(payload && typeof payload === "object" && !Array.isArray(payload),
    "Provider payload is not an object");
  assertProbe(payload.prompt_cache_key === cacheKey,
    "Provider payload lost the repetition's cache key");
  const ceiling = nestedField(payload, PROVIDER_CEILING_FIELDS);
  assertProbe(ceiling === null, `Refusing provider output ceiling field ${ceiling}`);
  const explicitCache = nestedField(payload, EXPLICIT_CACHE_FIELDS);
  assertProbe(explicitCache === null,
    `Refusing unsupported explicit cache field ${explicitCache} on the subscription endpoint`);
  return true;
}

export function assertImplicitSubscriptionPayload(payload, { cacheKey, input }) {
  assertImplicitSubscriptionEnvelope(payload, { cacheKey });
  assertProbe(payload.input === input,
    "Provider payload does not carry the exact topology input object");
  return true;
}

export function assertSubscriptionModel(runtime, model) {
  assertProbe(model, `${SUBSCRIPTION_CACHE_MODEL} is unavailable in the local Codex catalog`);
  assertProbe(runtime.isUsingSubscription(SUBSCRIPTION_CACHE_PROVIDER),
    "Refusing probe: openai-codex is not using subscription credentials");
  assertProbe(runtime.isUsingOAuth(SUBSCRIPTION_CACHE_PROVIDER),
    "Refusing probe: openai-codex is not using OAuth");
  assertProbe(model.api === SUBSCRIPTION_CACHE_API,
    `Refusing probe: unexpected API adapter ${String(model.api)}`);
  const base = new URL(model.baseUrl);
  assertProbe(base.origin === "https://chatgpt.com" &&
    base.pathname.replace(/\/+$/, "") === "/backend-api",
  `Refusing probe: unexpected subscription base ${base.origin}${base.pathname}`);
  return true;
}

export function assertSubscriptionDestination(input, init) {
  const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const destination = new URL(raw);
  assertProbe(destination.href === SUBSCRIPTION_CACHE_ENDPOINT,
    `Blocked non-subscription destination ${destination.origin}${destination.pathname}`);
  const headers = new Headers(init?.headers);
  assertProbe(/^Bearer\s+\S+$/.test(headers.get("authorization") ?? ""),
    "Subscription request lacks bearer authentication");
  assertProbe((headers.get("chatgpt-account-id") ?? "").length > 0,
    "Subscription request lacks its ChatGPT account header");
  return destination.href;
}

function branchInputs(identity) {
  const stableA = `Cache topology identity ${identity}. ` +
    "Stable anchor material alpha beta gamma delta epsilon. ".repeat(420);
  const raw = "Raw historical span holds exact event payload and chronology. ".repeat(150);
  const folded =
    "Fold placeholder: exact historical span remains recoverable by stable identity. ".repeat(24);
  const stableB = "Stable context after the mutable span remains byte identical. ".repeat(150);
  const query = inputText("user", "Return exactly OK.");
  const assemble = (middle) => [
    inputText("developer", stableA),
    inputText("user", middle),
    inputText("developer", stableB),
    query,
  ];
  const rawInput = assemble(raw);
  const foldedInput = assemble(folded);
  return [
    { label: BRANCH_SEQUENCE[0], input: rawInput },
    { label: BRANCH_SEQUENCE[1], input: foldedInput },
    { label: BRANCH_SEQUENCE[2], input: rawInput },
    { label: BRANCH_SEQUENCE[3], input: foldedInput },
  ];
}

function suffixInputs(identity) {
  const prefix = `Cache topology identity ${identity}. ` +
    "Ephemeral experiment stable prefix alpha beta gamma delta epsilon. ".repeat(420);
  const temporary =
    "Temporary peek evidence is visible for this decision and may then disappear. ".repeat(150);
  const query = inputText("user", "Return exactly OK.");
  const assemble = (suffix) => [inputText("developer", prefix), inputText("user", suffix), query];
  return [
    { label: SUFFIX_SEQUENCE[0], input: assemble("Initial suffix used only to warm the stable prefix.") },
    { label: SUFFIX_SEQUENCE[1], input: assemble(temporary) },
    { label: SUFFIX_SEQUENCE[2],
      input: assemble("Durable conclusion: the temporary peek contained no relevant evidence.") },
  ];
}

export function buildSubscriptionCacheTopologyPlan({
  nonce = randomBytes(8).toString("hex"),
  repetitions = SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
} = {}) {
  assertProbe(/^[a-z0-9-]{8,32}$/.test(nonce),
    "Probe nonce must contain 8 through 32 lowercase letters, digits, or hyphens");
  assertRepetitions(repetitions);
  const plans = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const branchIdentity = `${nonce}-r${repetition}-branch`;
    const suffixIdentity = `${nonce}-r${repetition}-suffix`;
    plans.push({
      repetition,
      lanes: [
        {
          name: "branch-revisit",
          cacheKey: `pf-cache-${branchIdentity}`,
          requests: branchInputs(branchIdentity),
        },
        {
          name: "temporary-suffix",
          cacheKey: `pf-cache-${suffixIdentity}`,
          requests: suffixInputs(suffixIdentity),
        },
      ],
    });
  }
  return {
    protocolVersion: SUBSCRIPTION_CACHE_TOPOLOGY_PROTOCOL_VERSION,
    nonce,
    repetitions,
    plans,
  };
}

export function subscriptionCacheTopologyManifest(plan) {
  return {
    protocolVersion: plan.protocolVersion,
    repetitions: plan.repetitions,
    requestCount: plan.plans.reduce((count, repetition) =>
      count + repetition.lanes.reduce((laneCount, lane) => laneCount + lane.requests.length, 0), 0),
    minimumCacheablePromptTokens: SUBSCRIPTION_CACHE_MINIMUM_TOKENS,
    sequences: {
      branchRevisit: [...BRANCH_SEQUENCE],
      temporarySuffix: [...SUFFIX_SEQUENCE],
    },
    plans: plan.plans.map((repetition) => ({
      repetition: repetition.repetition,
      lanes: repetition.lanes.map((lane) => ({
        name: lane.name,
        cacheKeySha256: sha256(lane.cacheKey),
        requests: lane.requests.map((request) => ({
          label: request.label,
          inputSha256: inputSha256(request.input),
          inputCharacters: inputCharacters(request.input),
        })),
      })),
    })),
  };
}

export function subscriptionRequestSucceeded(row) {
  return Number.isSafeInteger(row.httpStatus) && row.httpStatus >= 200 && row.httpStatus < 300 &&
    !["error", "aborted", "length"].includes(row.stopReason);
}

function cacheRead(row) {
  return Number.isFinite(row?.usage?.cacheRead) ? row.usage.cacheRead : 0;
}

export function classifySubscriptionCacheRepetition(rows) {
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  const required = [...BRANCH_SEQUENCE, ...SUFFIX_SEQUENCE];
  const complete = required.every((label) => byLabel[label]);
  const allRequestsSucceeded = complete &&
    required.every((label) => subscriptionRequestSucceeded(byLabel[label]));
  if (!allRequestsSucceeded) {
    return {
      complete,
      allRequestsSucceeded,
      branchRevisitConfirmed: false,
      temporarySuffixReplacementConfirmed: false,
      confirmed: false,
    };
  }

  const sharedForkRead = cacheRead(byLabel["folded-first"]);
  const rawReturnRead = cacheRead(byLabel["raw-again"]);
  const foldedReturnRead = cacheRead(byLabel["folded-again"]);
  const temporaryRead = cacheRead(byLabel["temporary-suffix-present"]);
  const replacementRead = cacheRead(byLabel["temporary-suffix-replaced"]);
  const sharedPrefixObserved = sharedForkRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS;
  const rawBranchBeyondFork = rawReturnRead - sharedForkRead;
  const foldedBranchBeyondFork = foldedReturnRead - sharedForkRead;
  const branchRevisitConfirmed = sharedPrefixObserved &&
    rawBranchBeyondFork > 0 && foldedBranchBeyondFork > 0;
  const temporarySuffixReplacementConfirmed =
    temporaryRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS && replacementRead >= temporaryRead;

  return {
    complete,
    allRequestsSucceeded,
    sharedForkRead,
    sharedPrefixObserved,
    rawReturnRead,
    rawBranchBeyondFork,
    foldedReturnRead,
    foldedBranchBeyondFork,
    branchRevisitConfirmed,
    temporarySuffixRead: temporaryRead,
    replacementRead,
    temporarySuffixReplacementConfirmed,
    confirmed: branchRevisitConfirmed && temporarySuffixReplacementConfirmed,
  };
}

export function summarizeSubscriptionCacheTopology(rows, repetitions) {
  assertRepetitions(repetitions);
  const perRepetition = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    perRepetition.push({
      repetition,
      ...classifySubscriptionCacheRepetition(rows.filter((row) => row.repetition === repetition)),
    });
  }
  const completedRepetitions = perRepetition.filter((entry) => entry.complete).length;
  const confirmedRepetitions = perRepetition.filter((entry) => entry.confirmed).length;
  return {
    requiredRepetitions: SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
    requestedRepetitions: repetitions,
    completedRepetitions,
    confirmedRepetitions,
    branchRevisitConfirmedInEveryRepetition: perRepetition.every((entry) => entry.branchRevisitConfirmed),
    temporarySuffixReplacementConfirmedInEveryRepetition:
      perRepetition.every((entry) => entry.temporarySuffixReplacementConfirmed),
    promotionEligible: repetitions >= SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS &&
      confirmedRepetitions === repetitions,
    perRepetition,
  };
}

export function normalizedSubscriptionUsage(usage) {
  const inputFresh = Number.isFinite(usage?.input) ? usage.input : 0;
  const cacheReadTokens = Number.isFinite(usage?.cacheRead) ? usage.cacheRead : 0;
  const cacheWrite = Number.isFinite(usage?.cacheWrite) ? usage.cacheWrite : 0;
  const output = Number.isFinite(usage?.output) ? usage.output : 0;
  return {
    inputFresh,
    cacheRead: cacheReadTokens,
    cacheWrite,
    output,
    promptTokens: inputFresh + cacheReadTokens + cacheWrite,
    totalTokens: Number.isFinite(usage?.totalTokens)
      ? usage.totalTokens
      : inputFresh + cacheReadTokens + cacheWrite + output,
  };
}

export async function runSubscriptionCacheTopologyProbe(plan, { onResult } = {}) {
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
  for (const repetition of plan.plans) {
    for (const lane of repetition.lanes) {
      for (const request of lane.requests) {
        let httpStatus = null;
        let sentShape = null;
        const result = await runtime.complete(model, {
          systemPrompt: "Return exactly OK and nothing else.",
          messages: [{ role: "user", content: "placeholder" }],
          tools: [],
        }, {
          transport: "sse",
          sessionId: lane.cacheKey,
          cacheRetention: "short",
          fetch: guardedFetch,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxRetries: 0,
          onResponse: ({ status }) => { httpStatus = status; },
          onPayload: (payload) => {
            const body = {
              ...payload,
              input: request.input,
              prompt_cache_key: lane.cacheKey,
              tool_choice: "none",
            };
            assertImplicitSubscriptionPayload(body,
              { cacheKey: lane.cacheKey, input: request.input });
            sentShape = {
              implicitCacheOnly: true,
              outputCeilingPresent: false,
              inputSha256: inputSha256(request.input),
            };
            return body;
          },
        });
        const row = {
          repetition: repetition.repetition,
          lane: lane.name,
          label: request.label,
          cacheKeySha256: sha256(lane.cacheKey),
          inputSha256: inputSha256(request.input),
          httpStatus,
          stopReason: result.stopReason,
          usage: normalizedSubscriptionUsage(result.usage),
          sentShape,
          error: result.stopReason === "error" ? result.errorMessage : undefined,
        };
        rows.push(row);
        onResult?.(row);
        assertProbe(subscriptionRequestSucceeded(row),
          `${request.label} failed in repetition ${repetition.repetition}: ` +
          `${result.errorMessage ?? result.stopReason}`);
      }
    }
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
    },
    manifest: subscriptionCacheTopologyManifest(plan),
    rows,
    verdict: summarizeSubscriptionCacheTopology(rows, plan.repetitions),
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
      "Usage: node scripts/probe_subscription_cache_topology.mjs [--live] [--repetitions=1..5]\n" +
      "Without --live, prints the request manifest and performs no network calls.\n");
    return;
  }
  const plan = buildSubscriptionCacheTopologyPlan({ repetitions: options.repetitions });
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({
      live: false,
      networkRequests: 0,
      provider: SUBSCRIPTION_CACHE_PROVIDER,
      model: SUBSCRIPTION_CACHE_MODEL,
      endpoint: SUBSCRIPTION_CACHE_ENDPOINT,
      manifest: subscriptionCacheTopologyManifest(plan),
    }, null, 2)}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const report = await runSubscriptionCacheTopologyProbe(plan, {
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
    process.stderr.write(`Subscription cache topology probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
