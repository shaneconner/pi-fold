// Pi extension for one fold-vs-compaction experiment run.
//
// Derived from the retired soak extension (in git history through 09a4ea5). Same shape:
// an externally paced,
// nonce-chained stage tool, hash-chained ledgers, artifact-only evidence. Differences are
// the ones the experiment needs:
//   - the active-context runtime is registered ONLY for the pifold arm, and with the run's
//     guidance profile, so the arm IS the runtime configuration;
//   - context-tool actions are NOT policy-restricted: expand/protect/refold usage is a
//     first-class metric here, and the soak's status/fold allowlist would suppress it;
//   - a native compaction is RECORDED, not latched as a failure: for the native arm it is
//     the event under measurement;
//   - every tool result is hashed into a ledger so the reread tax is measurable.

import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
// The measured runtime is this repo's own package, not a consumer's deployed copy: the
// bytes under test are tracked, so the run seal pins exactly what executed.
import { registerActiveContext } from "../extensions/active-context.ts";
import { registerEvidenceIngestion } from "../extensions/evidence.js";
import {
  PI_FOLD_ACTIVE_CONTEXT_REGISTRATION,
  PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY,
  PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY,
  PI_FOLD_READ_ONLY_TOOLS,
} from "./lib/pi_fold_identity.mjs";
import {
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS,
  EXPERIMENT_DEFAULT_FOLD_SCHEDULING,
  EXPERIMENT_MARKER_ENTRY,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  EXPERIMENT_TOOL_NAME,
  assertExperiment,
  estimateTokens,
  isWindowOverflow,
  stageCallDisposition,
  toolResultContentSha256,
  toolResultText,
} from "./lib/pi_context_experiment.mjs";
import {
  appendJsonLineFsync,
  exactKeys,
  monotonicMs,
  processStartTicks,
  sha256Json,
  sha256Text,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";

// repo_stage returns pinned source bytes and mutates nothing, so it is foldable: stale
// stage results become eligible tool-fold batches and the autonomous ladder fires on
// cadence rather than on the model volunteering (the soak minor-3 lesson).
const EXPERIMENT_READ_ONLY_TOOLS = new Set([...PI_FOLD_READ_ONLY_TOOLS, EXPERIMENT_TOOL_NAME]);

function allStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, result);
  else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) allStrings(value[key], result);
  }
  return result;
}

function appendFailure(config, phase, detail) {
  appendJsonLineFsync(join(config.runDir, "failure-latch.jsonl"), {
    version: 1,
    runId: config.runId,
    phase,
    detail: String(detail).slice(0, 2_048),
    wallMs: Date.now(),
    monotonicMs: monotonicMs(),
  });
}

function waitForFile(path, directory, signal, deadlineMs) {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      watcher.close();
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new Error("Experiment stage wait was aborted"));
    const watcher = watch(directory, (_event, filename) => {
      if (filename && join(directory, String(filename)) === path && existsSync(path)) finish();
    });
    const timeout = setTimeout(() => finish(new Error("Experiment stage response deadline expired")), deadlineMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (existsSync(path)) finish();
  });
}

function responseIdentity(response) {
  const { responseSha256: _response, paceRecordSha256: _pace, ...identity } = response;
  return sha256Json(identity);
}

function readMarkerIndex(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "custom" && branch[index]?.customType === EXPERIMENT_MARKER_ENTRY) return index;
  }
  return -1;
}

export function createPiContextExperimentExtension(config) {
  const pifold = config.arm === "pifold";
  const allowedTools = new Set([
    ...EXPERIMENT_ALLOWED_TOOLS,
    ...(pifold ? EXPERIMENT_PIFOLD_EXTRA_TOOLS : []),
  ]);
  let expectedStage = 1;
  let expectedChallenge = config.firstChallenge;
  let requestOrdinal = 0;
  let priorRequestRecordSha256 = null;
  let eventOrdinal = 0;
  let priorEventRecordSha256 = null;
  let toolResultOrdinal = 0;
  let priorToolResultSha256 = null;
  let inFlight = false;
  // Wrong-key calls are recoverable behavior with a red line: see the stale-key block.
  const STALE_KEY_MISS_BUDGET = 8;
  let staleKeyMisses = 0;
  // Native-arm overflow errors are compaction breaths, bounded so a stuck loop latches.
  const OVERFLOW_BREATH_BUDGET = 12;
  let overflowBreaths = 0;
  let inFlightProviderRequest = null;
  let pendingStopTheWorld = null;
  const usedToolCallIds = new Set();
  let contextToolDefinition = null;
  const requestsDir = join(config.runDir, "ipc", "requests");
  const responsesDir = join(config.runDir, "ipc", "responses");
  const projectionLog = join(config.runDir, "provider-requests.jsonl");
  const eventLog = join(config.runDir, "worker-events.jsonl");
  const toolResultLog = join(config.runDir, "tool-results.jsonl");
  const stopTheWorldLog = join(config.runDir, "stop-the-world.jsonl");

  const appendEvent = (kind, details = {}) => {
    const identity = {
      version: 1,
      runId: config.runId,
      ordinal: ++eventOrdinal,
      kind,
      wallMs: Date.now(),
      monotonicMs: monotonicMs(),
      details,
      priorRecordSha256: priorEventRecordSha256,
    };
    const record = { ...identity, recordSha256: sha256Json(identity) };
    appendJsonLineFsync(eventLog, record);
    priorEventRecordSha256 = record.recordSha256;
  };

  const appendToolResult = ({ toolName, toolCallId, content, isError }) => {
    const text = toolResultText(content);
    const identity = {
      version: 1,
      runId: config.runId,
      ordinal: ++toolResultOrdinal,
      toolName: toolName ?? null,
      toolCallId: toolCallId ?? null,
      isError: isError === true,
      contentSha256: toolResultContentSha256(content),
      chars: text.length,
      bytes: Buffer.byteLength(text, "utf8"),
      tokensEstimated: estimateTokens(text),
      wallMs: Date.now(),
      monotonicMs: monotonicMs(),
      priorRecordSha256: priorToolResultSha256,
    };
    const record = { ...identity, recordSha256: sha256Json(identity) };
    appendJsonLineFsync(toolResultLog, record);
    priorToolResultSha256 = record.recordSha256;
  };

  const openStopTheWorld = (kind, detail) => {
    pendingStopTheWorld = {
      version: 1,
      runId: config.runId,
      kind,
      detail: String(detail ?? "").slice(0, 512),
      openedWallMs: Date.now(),
      openedMonotonicMs: monotonicMs(),
      stage: expectedStage,
    };
  };

  const closeStopTheWorld = () => {
    if (!pendingStopTheWorld) return;
    const record = {
      ...pendingStopTheWorld,
      closedWallMs: Date.now(),
      closedMonotonicMs: monotonicMs(),
    };
    record.timeToFirstProductiveRequestMs = record.closedMonotonicMs - record.openedMonotonicMs;
    appendJsonLineFsync(stopTheWorldLog, record);
    pendingStopTheWorld = null;
  };

  return {
    name: "pi-fold-context-experiment",
    factory(pi) {
      // Native compaction is an EVENT here, not a latch: the native arm is supposed to
      // produce them. It is only a defect when the arm forbids it.
      pi.on("session_before_compact", (event) => {
        openStopTheWorld("native-compaction", event.reason ?? "unknown");
        appendEvent("native-compaction", { reason: event.reason ?? null, stage: expectedStage });
        if (config.arm !== "native") {
          appendFailure(config, "unexpected-native-compaction", event.reason ?? "unknown");
        }
      });

      if (pifold) {
        const registerTool = pi.registerTool.bind(pi);
        pi.registerTool = (definition) => {
          if (definition?.name === PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.toolName) {
            contextToolDefinition = definition;
          }
          return registerTool(definition);
        };
        try {
          // Evidence ingestion, then the runtime. This is the same pair the previous
          // deployment bootstrap produced with its agent, MCP and memory layers disabled;
          // no summarizer is configured, so fold briefs stay deterministic.
          registerEvidenceIngestion(pi, {
            isMcpTool: () => false,
            entryTypePrefix: PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix,
          });
          registerActiveContext(pi, {
            ...PI_FOLD_ACTIVE_CONTEXT_REGISTRATION,
            readOnlyTools: EXPERIMENT_READ_ONLY_TOOLS,
            // The second condition dial: fold as soon as a batch is eligible, or batch the
            // eligible spans into an epoch. Pinned in the run config and the manifest.
            foldScheduling: config.foldScheduling ?? EXPERIMENT_DEFAULT_FOLD_SCHEDULING,
            // The third condition dial: whether the ladder may reclaim the runtime's own
            // peek output. Pinned in the run config and the manifest.
            foldPeekResults: config.foldPeekResults ?? EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS,
            // The deployment fact, when the run config carries one: without it the
            // runtime measures every threshold against the per-request descriptor.
            ...(config.providerTotalWindow === undefined ? {} : { providerTotalWindow: config.providerTotalWindow }),
          });
        } finally {
          pi.registerTool = registerTool;
        }
        assertExperiment(contextToolDefinition,
          "Active-context registration did not expose the context tool for the pifold arm");
      }

      pi.registerTool({
        name: EXPERIMENT_TOOL_NAME,
        label: "Repository Stage",
        description: "Return the next staged block of pinned repository material for the current key.",
        promptSnippet: "Request one nonce-bound repository stage at a time.",
        promptGuidelines: ["Use only the NEXT_KEY returned by the preceding stage."],
        executionMode: "sequential",
        parameters: Type.Object({
          key: Type.String({ minLength: 64, maxLength: 64 }),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, signal, _onUpdate, _ctx) {
          if (inFlight) {
            appendFailure(config, "parallel-stage", toolCallId);
            return { content: [{ type: "text", text: "Another stage is already pending." }], isError: true };
          }
          const disposition = stageCallDisposition({
            expectedStage, stageCount: config.stageCount, toolCallId, usedToolCallIds,
          });
          if (disposition.kind === "replay") {
            appendFailure(config, "invalid-stage-capability", `${toolCallId}:${expectedStage}`);
            return { content: [{ type: "text", text: "The stage key is stale or out of order." }], isError: true };
          }
          if (disposition.kind === "post-plan") {
            // The plan is complete. A trailing call after the last stage is a finished
            // assignment being tidy, NOT a capability breach: latching it voided a
            // completed 64/64 native run that made exactly one such call.
            appendEvent("post-plan-stage-call", { toolCallId, stage: expectedStage });
            return { content: [{ type: "text", text: disposition.text }] };
          }
          if (params.key !== expectedChallenge) {
            // A wrong key is BEHAVIOR, not an integrity breach: under pressure the nonce
            // gets folded or compacted away, and recovering it (peek, expand, reread) is
            // exactly what the experiment measures. Rep 1 saw the pifold arm lose the key
            // at stage 57, get this error, peek the fold, and finish all 64 stages —
            // killed only by the latch. Bounded so a key-guessing loop still latches red.
            staleKeyMisses += 1;
            appendEvent("stale-stage-key", {
              toolCallId, stage: expectedStage, misses: staleKeyMisses,
            });
            if (staleKeyMisses > STALE_KEY_MISS_BUDGET) {
              appendFailure(config, "invalid-stage-capability", `${toolCallId}:${expectedStage}`);
              return { content: [{ type: "text", text: "The stage key is stale or out of order." }], isError: true };
            }
            return { content: [{ type: "text", text:
              "That key is not the current NEXT_KEY. Recover the exact NEXT_KEY issued by " +
              "the most recent completed stage (it may be inside a folded or compacted " +
              "span) and call again." }], isError: true };
          }
          inFlight = true;
          usedToolCallIds.add(toolCallId);
          const requestIdentity = {
            version: 1,
            runId: config.runId,
            stage: expectedStage,
            challenge: expectedChallenge,
            challengeSha256: sha256Text(expectedChallenge),
            toolCallId,
            workerPid: process.pid,
            workerStartTicks: processStartTicks(process.pid),
            requestedWallMs: Date.now(),
            requestedMonotonicMs: monotonicMs(),
          };
          const request = { ...requestIdentity, requestSha256: sha256Json(requestIdentity) };
          const requestPath = join(requestsDir, `stage-${String(expectedStage).padStart(2, "0")}.json`);
          const responsePath = join(responsesDir, `stage-${String(expectedStage).padStart(2, "0")}.json`);
          try {
            writeJsonPublished(requestPath, request);
            appendEvent("stage-request", {
              stage: expectedStage, requestSha256: request.requestSha256, toolCallId,
            });
            await waitForFile(responsePath, responsesDir, signal, config.watchdogMs);
            const response = JSON.parse(readFileSync(responsePath, "utf8"));
            assertExperiment(exactKeys(response, [
              "version", "runId", "stage", "challengeSha256", "requestSha256", "content",
              "contentSha256", "payloadSha256", "nextChallenge", "nextChallengeSha256",
              "releasedWallMs", "releasedMonotonicMs", "paceRecordSha256", "responseSha256",
            ]), "Invalid supervisor response shape");
            assertExperiment(response.version === 1 && response.runId === config.runId &&
              response.stage === expectedStage && response.challengeSha256 === request.challengeSha256 &&
              response.requestSha256 === request.requestSha256 &&
              response.contentSha256 === sha256Text(response.content) &&
              response.nextChallengeSha256 === sha256Text(response.nextChallenge) &&
              response.responseSha256 === responseIdentity(response),
            "Supervisor response identity drifted");
            const stage = expectedStage;
            expectedStage += 1;
            expectedChallenge = response.nextChallenge;
            const projectionIdentity = {
              version: 1,
              runId: config.runId,
              ordinal: ++requestOrdinal,
              kind: "stage-result",
              stage,
              requestSha256: request.requestSha256,
              responseSha256: response.responseSha256,
              paceRecordSha256: response.paceRecordSha256,
              payloadSha256: response.payloadSha256,
              wallMs: Date.now(),
              monotonicMs: monotonicMs(),
              priorRecordSha256: priorRequestRecordSha256,
            };
            const projectionRecord = { ...projectionIdentity, recordSha256: sha256Json(projectionIdentity) };
            appendJsonLineFsync(projectionLog, projectionRecord);
            priorRequestRecordSha256 = projectionRecord.recordSha256;
            appendEvent("stage-result", { stage, responseSha256: response.responseSha256 });
            return {
              content: [{ type: "text", text: response.content }],
              details: {
                version: 1,
                runId: config.runId,
                stage,
                requestSha256: request.requestSha256,
                responseSha256: response.responseSha256,
                contentSha256: response.contentSha256,
                payloadSha256: response.payloadSha256,
                paceRecordSha256: response.paceRecordSha256,
                releasedMonotonicMs: response.releasedMonotonicMs,
              },
            };
          } catch (error) {
            appendFailure(config, "stage-execution", error instanceof Error ? error.message : String(error));
            throw error;
          } finally {
            inFlight = false;
          }
        },
      });

      pi.on("tool_call", (event) => {
        if (!allowedTools.has(event.toolName)) {
          appendFailure(config, "forbidden-tool", `${event.toolName}:${event.toolCallId}`);
          return { block: true, reason: "This run permits only repository reading and stage progression." };
        }
        appendEvent("tool-call", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          action: event.input?.action ?? null,
        });
        return undefined;
      });

      pi.on("tool_result", (event) => {
        appendToolResult({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          content: event.content ?? event.result?.content ?? null,
          isError: event.isError,
        });
        if (event.toolName === PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.toolName && event.isError !== true) {
          appendEvent("context-tool-result", {
            toolCallId: event.toolCallId ?? null,
            action: event.details?.action ?? null,
            foldId: event.details?.id ?? null,
            automaticSuspended: event.details?.automatic?.automaticSuspended ?? null,
            pressureRatio: event.details?.automatic?.pressureRatio ?? null,
            foldCount: event.details?.totalFolds ?? null,
          });
        }
      });

      pi.on("context", (event, ctx) => {
        const identity = {
          version: 1,
          runId: config.runId,
          ordinal: ++requestOrdinal,
          kind: "context-projection",
          leafId: ctx.sessionManager.getLeafId(),
          markerIndex: readMarkerIndex(ctx),
          messageCount: event.messages.length,
          projectedMessagesSha256: sha256Json(event.messages),
          projectedChars: allStrings(event.messages).reduce((total, text) => total + text.length, 0),
          signalAborted: ctx.signal?.aborted === true,
          wallMs: Date.now(),
          monotonicMs: monotonicMs(),
          priorRecordSha256: priorRequestRecordSha256,
        };
        const record = { ...identity, recordSha256: sha256Json(identity) };
        appendJsonLineFsync(projectionLog, record);
        priorRequestRecordSha256 = record.recordSha256;
        if (identity.signalAborted) appendFailure(config, "context-aborted", identity.leafId ?? "no-leaf");
        const native = ctx.sessionManager.getBranch().find((entry) => entry?.type === "compaction" ||
          (entry?.type === "custom" && [
            PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY,
            PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY,
          ].includes(entry.customType)));
        if (native && config.arm !== "native") {
          appendFailure(config, "unexpected-native-entry", native.customType ?? native.type);
        }
      });

      pi.on("before_provider_request", (event, ctx) => {
        if (inFlightProviderRequest) {
          appendFailure(config, "parallel-provider-request", inFlightProviderRequest.recordSha256);
          throw new Error("A provider request began before its predecessor produced an assistant response");
        }
        const providerTools = Array.isArray(event.payload?.tools) ? event.payload.tools : [];
        const identity = {
          version: 1,
          runId: config.runId,
          ordinal: ++requestOrdinal,
          kind: "provider-request",
          leafId: ctx.sessionManager.getLeafId(),
          markerIndex: readMarkerIndex(ctx),
          provider: ctx.model?.provider ?? null,
          model: ctx.model?.id ?? null,
          thinkingLevel: ctx.thinkingLevel ?? null,
          payloadSha256: sha256Json(event.payload),
          payloadChars: allStrings(event.payload).reduce((total, text) => total + text.length, 0),
          systemPromptSha256: sha256Text(ctx.getSystemPrompt()),
          providerToolsSha256: sha256Json(providerTools),
          providerToolNames: providerTools.map((tool) =>
            tool?.name ?? tool?.function?.name ?? tool?.custom?.name ?? null),
          wallMs: Date.now(),
          monotonicMs: monotonicMs(),
          priorRecordSha256: priorRequestRecordSha256,
        };
        const record = { ...identity, recordSha256: sha256Json(identity) };
        appendJsonLineFsync(projectionLog, record);
        priorRequestRecordSha256 = record.recordSha256;
        inFlightProviderRequest = {
          ordinal: record.ordinal, recordSha256: record.recordSha256, leafId: record.leafId,
        };
        // The first provider request AFTER a stop-the-world event closes it: that gap is
        // the time-to-first-productive-request the experiment reports per event.
        closeStopTheWorld();
      });

      pi.on("message_end", (event) => {
        const reason = event.message?.role === "assistant" ? event.message.stopReason : null;
        if (event.message?.role === "assistant") {
          if (!inFlightProviderRequest) {
            appendFailure(config, "orphan-provider-response", sha256Json(event.message));
            throw new Error("An assistant response has no exact provider-request identity");
          }
          const identity = {
            version: 1,
            runId: config.runId,
            ordinal: ++requestOrdinal,
            kind: "provider-response",
            requestOrdinal: inFlightProviderRequest.ordinal,
            requestRecordSha256: inFlightProviderRequest.recordSha256,
            requestLeafId: inFlightProviderRequest.leafId,
            messageSha256: sha256Json(event.message),
            provider: event.message.provider ?? null,
            model: event.message.model ?? null,
            stopReason: event.message.stopReason ?? null,
            usage: event.message.usage ?? null,
            wallMs: Date.now(),
            monotonicMs: monotonicMs(),
            priorRecordSha256: priorRequestRecordSha256,
          };
          const record = { ...identity, recordSha256: sha256Json(identity) };
          appendJsonLineFsync(projectionLog, record);
          priorRequestRecordSha256 = record.recordSha256;
          inFlightProviderRequest = null;
        }
        if (reason === "error" || reason === "aborted" || reason === "length") {
          // The unmanaged arm is EXPECTED to end this way: the overflow point is its datum.
          appendEvent("non-terminal-provider-response", { stopReason: reason, stage: expectedStage });
          const overflowBreath = config.arm === "native" && reason === "error" &&
            isWindowOverflow(event.message?.errorMessage ?? "");
          if (overflowBreath) {
            // Overflow -> native compaction -> retry is the native arm's lifecycle and a
            // stop-the-world datum, not an integrity failure (rep 1: 3 breaths, 64/64
            // stages, killed only by this latch). Bounded: a compaction loop that cannot
            // make progress still latches red.
            overflowBreaths += 1;
            if (overflowBreaths > OVERFLOW_BREATH_BUDGET) {
              appendFailure(config, "non-terminal-provider-response", `${reason}:overflow-loop`);
            }
          } else if (config.arm !== "unmanaged") {
            appendFailure(config, "non-terminal-provider-response", reason);
          }
        }
        appendEvent("message-end", {
          role: event.message?.role ?? null,
          stopReason: reason,
          messageSha256: sha256Json(event.message),
        });
      });

      pi.on("agent_end", (event) => {
        appendEvent("agent-end", { messageCount: event.messages?.length ?? null });
      });
      pi.on("session_shutdown", () => {
        if (inFlightProviderRequest) {
          appendFailure(config, "provider-request-without-response", inFlightProviderRequest.recordSha256);
        }
        if (pendingStopTheWorld) {
          // An event that never saw another productive request still gets a record, with an
          // explicit null duration rather than a fabricated one.
          appendJsonLineFsync(stopTheWorldLog, {
            ...pendingStopTheWorld,
            closedWallMs: null,
            closedMonotonicMs: null,
            timeToFirstProductiveRequestMs: null,
          });
          pendingStopTheWorld = null;
        }
        appendEvent("session-shutdown");
      });
    },
  };
}
