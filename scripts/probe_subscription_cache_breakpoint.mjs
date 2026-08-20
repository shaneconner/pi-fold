#!/usr/bin/env node

// A bounded, subscription-only RE-TEST of the explicit prompt-cache fields.
//
// The 2026-08-16 probe sent the documented field names and the ChatGPT Codex
// subscription endpoint rejected them as API-preview fields; the topology
// harness therefore measures implicit behavior only. The platform-API docs
// read on 2026-08-19 describe the same fields as available on GPT-5.6 and
// later: request-level `prompt_cache_options.mode: "explicit"` (which disables
// implicit checkpoints for the request), block-level
// `prompt_cache_breakpoint: {"mode": "explicit"}` (up to four writes per
// request, reads over up to the latest fifty breakpoints). This probe asks one
// question of the actual wire Pi can reach: are those fields accepted TODAY,
// and if so, does a byte-identical reuse read cache at the marked boundary?
//
// Attribution is control-first: every repetition sends an implicit-mode
// control on its own cache key, and a failure THERE is an envelope failure
// that yields no field verdict at all. Only with a healthy envelope does an
// explicit-lane rejection become `rejected-by-name`, with the provider's
// status and error text captured verbatim. An accepted explicit request is
// judged by its reuse: `accepted-effective` when the byte-identical reuse
// reads at least the cacheable minimum, `accepted-without-reuse-evidence`
// when it does not, each repetition classified on its own and the cross-run
// verdict `mixed` by name when repetitions disagree.
//
//   node scripts/probe_subscription_cache_breakpoint.mjs
//   node scripts/probe_subscription_cache_breakpoint.mjs --live [--repetitions=1..5]
//
// The default dry run prints the manifest and performs no network calls. No
// provider output ceiling is ever sent.

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
  assertImplicitSubscriptionPayload,
  assertSubscriptionDestination,
  assertSubscriptionModel,
  normalizedSubscriptionUsage,
  subscriptionRequestSucceeded,
} from "./probe_subscription_cache_topology.mjs";

export const BREAKPOINT_PROTOCOL_VERSION = 1;
export const BREAKPOINT_REQUEST_OPTIONS = Object.freeze({ mode: "explicit" });
export const BREAKPOINT_BLOCK_MARKER = Object.freeze({ mode: "explicit" });
export const BREAKPOINT_SEQUENCE = Object.freeze([
  "implicit-control", "explicit-first", "explicit-reuse",
]);
export const BREAKPOINT_OUTCOMES = Object.freeze([
  "envelope-failure", "rejected-by-name", "accepted-without-reuse-evidence", "accepted-effective",
]);

const REQUEST_TIMEOUT_MS = 120_000;
const PROVIDER_CEILING_FIELDS = Object.freeze(["max_output_tokens", "max_tokens", "maxTokens"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const inputText = (role, text) => ({
  type: "message",
  role,
  content: [{ type: "input_text", text }],
});
const inputSha256 = (input) => sha256(JSON.stringify(input));

function assertProbe(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRepetitions(value) {
  assertProbe(Number.isSafeInteger(value) && value >= 1 && value <= SUBSCRIPTION_CACHE_MAX_REPETITIONS,
    `Repetitions must be an integer from 1 through ${SUBSCRIPTION_CACHE_MAX_REPETITIONS}`);
}

function breakpointInput(identity) {
  const stable = `Cache breakpoint identity ${identity}. ` +
    "Stable prefix material alpha beta gamma delta epsilon. ".repeat(420);
  return [
    inputText("developer", stable),
    inputText("user", "Return exactly OK."),
  ];
}

export function markedExplicitInput(input) {
  const marked = input.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));
  const lastMessage = marked.at(-1);
  const lastBlock = lastMessage.content.at(-1);
  lastBlock.prompt_cache_breakpoint = { ...BREAKPOINT_BLOCK_MARKER };
  return marked;
}

export function assertExplicitSubscriptionPayload(payload, { cacheKey, input }) {
  assertProbe(payload && typeof payload === "object", "Provider payload is not an object");
  assertProbe(payload.prompt_cache_key === cacheKey,
    "Provider payload does not carry the isolated probe cache key");
  for (const field of PROVIDER_CEILING_FIELDS) {
    assertProbe(!(field in payload), `Provider payload must not carry ${field}`);
  }
  assertProbe(payload.input === input,
    "Provider payload does not carry the exact marked input object");
  const options = payload.prompt_cache_options;
  assertProbe(options && options.mode === BREAKPOINT_REQUEST_OPTIONS.mode,
    "Explicit lane payload must declare prompt_cache_options.mode explicit");
  const lastBlock = input.at(-1).content.at(-1);
  assertProbe(lastBlock.prompt_cache_breakpoint?.mode === BREAKPOINT_BLOCK_MARKER.mode,
    "Explicit lane input must mark its final block as an explicit breakpoint");
  return true;
}

export function buildBreakpointPlan({
  nonce = randomBytes(8).toString("hex"),
  repetitions = SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
} = {}) {
  assertProbe(/^[a-z0-9-]{8,32}$/.test(nonce),
    "Probe nonce must contain 8 through 32 lowercase letters, digits, or hyphens");
  assertRepetitions(repetitions);
  const plans = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const controlIdentity = `${nonce}-r${repetition}-control`;
    const explicitIdentity = `${nonce}-r${repetition}-explicit`;
    const controlInput = breakpointInput(controlIdentity);
    const explicitInput = markedExplicitInput(breakpointInput(explicitIdentity));
    plans.push({
      repetition,
      requests: [
        {
          label: "implicit-control",
          explicit: false,
          cacheKey: `pf-cache-${controlIdentity}`,
          input: controlInput,
        },
        {
          label: "explicit-first",
          explicit: true,
          cacheKey: `pf-cache-${explicitIdentity}`,
          input: explicitInput,
        },
        {
          label: "explicit-reuse",
          explicit: true,
          conditionalOn: "explicit-first",
          cacheKey: `pf-cache-${explicitIdentity}`,
          input: explicitInput,
        },
      ],
    });
  }
  return { protocolVersion: BREAKPOINT_PROTOCOL_VERSION, nonce, repetitions, plans };
}

export function breakpointManifest(plan) {
  return {
    protocolVersion: plan.protocolVersion,
    repetitions: plan.repetitions,
    requestCount: plan.plans.reduce((count, repetition) => count + repetition.requests.length, 0),
    minimumCacheablePromptTokens: SUBSCRIPTION_CACHE_MINIMUM_TOKENS,
    sequence: [...BREAKPOINT_SEQUENCE],
    outcomes: [...BREAKPOINT_OUTCOMES],
    requestOptions: { ...BREAKPOINT_REQUEST_OPTIONS },
    blockMarker: { ...BREAKPOINT_BLOCK_MARKER },
    plans: plan.plans.map((repetition) => ({
      repetition: repetition.repetition,
      requests: repetition.requests.map((request) => ({
        label: request.label,
        explicit: request.explicit,
        conditionalOn: request.conditionalOn ?? null,
        cacheKeySha256: sha256(request.cacheKey),
        inputSha256: inputSha256(request.input),
      })),
    })),
  };
}

export function classifyBreakpointRepetition(rows) {
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  const control = byLabel["implicit-control"];
  const first = byLabel["explicit-first"];
  const reuse = byLabel["explicit-reuse"];
  if (!control || !subscriptionRequestSucceeded(control)) {
    return {
      outcome: "envelope-failure",
      fieldVerdict: false,
      detail: control
        ? `implicit control failed: ${control.error ?? control.stopReason}`
        : "implicit control missing",
    };
  }
  if (!first) {
    return { outcome: "envelope-failure", fieldVerdict: false, detail: "explicit-first missing" };
  }
  if (!subscriptionRequestSucceeded(first)) {
    return {
      outcome: "rejected-by-name",
      fieldVerdict: true,
      httpStatus: first.httpStatus,
      detail: String(first.error ?? first.stopReason),
    };
  }
  const reuseRead = Number.isFinite(reuse?.usage?.cacheRead) ? reuse.usage.cacheRead : 0;
  if (reuse && subscriptionRequestSucceeded(reuse) &&
      reuseRead >= SUBSCRIPTION_CACHE_MINIMUM_TOKENS) {
    return {
      outcome: "accepted-effective",
      fieldVerdict: true,
      reuseCacheRead: reuseRead,
      firstCacheWrite: Number.isFinite(first.usage?.cacheWrite) ? first.usage.cacheWrite : 0,
    };
  }
  return {
    outcome: "accepted-without-reuse-evidence",
    fieldVerdict: true,
    reuseCacheRead: reuseRead,
    detail: reuse && !subscriptionRequestSucceeded(reuse)
      ? `reuse failed: ${reuse.error ?? reuse.stopReason}`
      : "reuse read below the cacheable minimum",
  };
}

export function summarizeBreakpointProbe(rows, repetitions) {
  assertRepetitions(repetitions);
  const perRepetition = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    perRepetition.push({
      repetition,
      ...classifyBreakpointRepetition(rows.filter((row) => row.repetition === repetition)),
    });
  }
  const verdicts = new Set(perRepetition.map((entry) => entry.outcome));
  const decided = perRepetition.filter((entry) => entry.fieldVerdict);
  return {
    requiredRepetitions: SUBSCRIPTION_CACHE_DEFAULT_REPETITIONS,
    requestedRepetitions: repetitions,
    decidedRepetitions: decided.length,
    verdict: verdicts.size === 1 ? [...verdicts][0] : "mixed",
    perRepetition,
  };
}

export async function runBreakpointProbe(plan, { onResult } = {}) {
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
    const succeededLabels = new Set();
    for (const request of repetition.requests) {
      if (request.conditionalOn && !succeededLabels.has(request.conditionalOn)) {
        rows.push({
          repetition: repetition.repetition,
          label: request.label,
          skipped: `skipped:${request.conditionalOn}-not-accepted`,
        });
        continue;
      }
      let httpStatus = null;
      const result = await runtime.complete(model, {
        systemPrompt: "Return exactly OK and nothing else.",
        messages: [{ role: "user", content: "placeholder" }],
        tools: [],
      }, {
        transport: "sse",
        sessionId: request.cacheKey,
        cacheRetention: "short",
        fetch: guardedFetch,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        onResponse: ({ status }) => { httpStatus = status; },
        onPayload: (payload) => {
          const body = {
            ...payload,
            input: request.input,
            prompt_cache_key: request.cacheKey,
            tool_choice: "none",
          };
          if (request.explicit) {
            body.prompt_cache_options = { ...BREAKPOINT_REQUEST_OPTIONS };
            assertExplicitSubscriptionPayload(body,
              { cacheKey: request.cacheKey, input: request.input });
          } else {
            assertImplicitSubscriptionPayload(body,
              { cacheKey: request.cacheKey, input: request.input });
          }
          return body;
        },
      });
      const row = {
        repetition: repetition.repetition,
        label: request.label,
        explicit: request.explicit,
        cacheKeySha256: sha256(request.cacheKey),
        inputSha256: inputSha256(request.input),
        httpStatus,
        stopReason: result.stopReason,
        usage: normalizedSubscriptionUsage(result.usage),
        error: result.stopReason === "error" ? result.errorMessage : undefined,
      };
      rows.push(row);
      onResult?.(row);
      if (subscriptionRequestSucceeded(row)) succeededLabels.add(request.label);
      if (request.label === "implicit-control" && !subscriptionRequestSucceeded(row)) break;
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
      providerOutputCeiling: false,
      clientRetries: 0,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    },
    manifest: breakpointManifest(plan),
    rows,
    verdict: summarizeBreakpointProbe(rows, plan.repetitions),
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
      "Usage: node scripts/probe_subscription_cache_breakpoint.mjs [--live] [--repetitions=1..5]\n" +
      "Without --live, prints the request manifest and performs no network calls.\n");
    return;
  }
  const plan = buildBreakpointPlan({ repetitions: options.repetitions });
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({
      live: false,
      networkRequests: 0,
      provider: SUBSCRIPTION_CACHE_PROVIDER,
      model: SUBSCRIPTION_CACHE_MODEL,
      endpoint: SUBSCRIPTION_CACHE_ENDPOINT,
      manifest: breakpointManifest(plan),
    }, null, 2)}\n`);
    return;
  }
  const startedAt = new Date().toISOString();
  const report = await runBreakpointProbe(plan, {
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
    process.stderr.write(`Subscription cache breakpoint probe failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
