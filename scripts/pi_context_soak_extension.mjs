import { existsSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { registerQuorumExtension } from "../.pi/extensions/quorum/index.js";
import {
  ACTIVE_CONTEXT_TOOL_ACTIONS,
  ADVISORY_BUDGETS,
  materializeActiveContextState,
  recoverFoldMessages,
  registerActiveContext,
} from "../.pi/extensions/quorum/active-context.ts";
import {
  QUORUM_ACTIVE_CONTEXT_REGISTRATION,
  QUORUM_FOLD_RECORD_ENTRY,
  QUORUM_NATIVE_COMPACTION_DECISION_ENTRY as NATIVE_COMPACTION_DECISION_ENTRY,
  QUORUM_NATIVE_COMPACTION_RECEIPT_ENTRY as NATIVE_COMPACTION_RECEIPT_ENTRY,
  QUORUM_READ_ONLY_TOOLS,
  QUORUM_STATE_ENTRY,
} from "../.pi/extensions/quorum/identity.js";
import {
  SOAK_ADVISORY_HOOK_PREFIX,
  SOAK_MARKER_ENTRY,
  SOAK_MODEL_CONTEXT_ACTIONS,
  SOAK_TOOL_NAME,
  appendJsonLineFsync,
  assertBlindVisibleText,
  assertSoak,
  exactKeys,
  monotonicMs,
  processStartTicks,
  sha256Json,
  sha256Text,
  writeJsonPublished,
} from "./lib/pi_context_soak_attestation.mjs";

// Quorum's foldable set plus the soak-only archive tool. archive_stage returns
// deterministic filler and mutates nothing; making it read-only lets stale stage
// results enter B1 cadence folds during the pressure climb. The max(12k, 6% of
// window) cadence is crossed repeatedly by 19 x 30k-char stages.
const SOAK_READ_ONLY_TOOLS = new Set([...QUORUM_READ_ONLY_TOOLS, SOAK_TOOL_NAME]);

function allStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, result);
  else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) allStrings(value[key], result);
  }
  return result;
}

function providerToolName(tool) {
  return tool?.name ?? tool?.function?.name ?? tool?.custom?.name ?? null;
}

function providerToolParameters(tool) {
  if (tool?.name) return tool.parameters;
  if (tool?.function?.name) return tool.function.parameters;
  if (tool?.custom?.name) return tool.custom.parameters;
  return null;
}

function providerContextToolActions(tools) {
  const matches = tools.filter((tool) => providerToolName(tool) === "quorum_context");
  if (matches.length !== 1) return null;
  const actions = providerToolParameters(matches[0])?.properties?.action?.enum;
  return Array.isArray(actions) ? actions : null;
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
    const abort = () => finish(new Error("Archive stage wait was aborted"));
    const watcher = watch(directory, (_event, filename) => {
      if (filename && join(directory, String(filename)) === path && existsSync(path)) finish();
    });
    const timeout = setTimeout(() => finish(new Error("Archive stage response deadline expired")), deadlineMs);
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
    if (branch[index]?.type === "custom" && branch[index]?.customType === SOAK_MARKER_ENTRY) return index;
  }
  return -1;
}

export function createPiContextSoakExtension(config) {
  let expectedStage = 1;
  let expectedChallenge = config.firstChallenge;
  let requestOrdinal = 0;
  let priorRequestRecordSha256 = null;
  let eventOrdinal = 0;
  let priorEventRecordSha256 = null;
  let inFlight = false;
  let inFlightProviderRequest = null;
  const usedToolCallIds = new Set();
  let priorFoldCount = 0;
  let priorHookSha256 = [];
  let contextToolDefinition = null;
  const requestsDir = join(config.runDir, "ipc", "requests");
  const responsesDir = join(config.runDir, "ipc", "responses");
  const projectionLog = join(config.runDir, "provider-requests.jsonl");
  const eventLog = join(config.runDir, "worker-events.jsonl");

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

  return {
    name: "quorum-context-soak",
    factory(pi) {
      // This observer precedes the active-context cancellation handler so even
      // a canceled stock/native compaction attempt irreversibly fails the soak.
      pi.on("session_before_compact", (event) => {
        appendFailure(config, "compaction-attempt", event.reason ?? "unknown");
      });
      const registerTool = pi.registerTool.bind(pi);
      pi.registerTool = (definition) => {
        if (definition?.name === "quorum_context") contextToolDefinition = definition;
        return registerTool(definition);
      };
      try {
        registerQuorumExtension(pi, {
          activeContextEnabled: false,
          memoryProjectionEnabled: false,
          mcpRuntimeEnabled: false,
          agentToolEnabled: false,
        });
        registerActiveContext(pi, {
          ...QUORUM_ACTIVE_CONTEXT_REGISTRATION,
          readOnlyTools: SOAK_READ_ONLY_TOOLS,
        });
      } finally {
        pi.registerTool = registerTool;
      }
      assertSoak(contextToolDefinition, "Active-context registration did not expose quorum_context");

      pi.registerTool({
        name: SOAK_TOOL_NAME,
        label: "Archive Stage",
        description: "Return the next factual archive packet for the current opaque key.",
        promptSnippet: "Read one nonce-bound archive packet at a time.",
        promptGuidelines: ["Use only the NEXT_KEY returned by the preceding archive packet."],
        executionMode: "sequential",
        parameters: Type.Object({
          key: Type.String({ minLength: 64, maxLength: 64 }),
        }, { additionalProperties: false }),
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
          if (inFlight) {
            appendFailure(config, "parallel-stage", toolCallId);
            return { content: [{ type: "text", text: "Another archive stage is already pending." }], isError: true };
          }
          if (usedToolCallIds.has(toolCallId) || expectedStage > config.stageCount ||
              params.key !== expectedChallenge) {
            appendFailure(config, "invalid-stage-capability", `${toolCallId}:${expectedStage}`);
            return { content: [{ type: "text", text: "The archive key is stale or out of order." }], isError: true };
          }
          inFlight = true;
          usedToolCallIds.add(toolCallId);
          try {
            const status = await contextToolDefinition.execute(
              `soak-runtime-observation-${expectedStage}`,
              { action: "status" },
              signal,
              undefined,
              ctx,
            );
            const details = status?.details ?? {};
            appendEvent("runtime-observation", {
              stage: expectedStage,
              available: details.available === true,
              pressureRatio: details.automatic?.pressureRatio ?? null,
              hardFenceRatio: details.automatic?.hardFenceRatio ?? null,
              providerMeasurement: details.automatic?.providerMeasurement ?? null,
              automaticSuspended: details.automatic?.automaticSuspended ?? null,
              advisory: details.automatic?.advisory ?? null,
              armedMilestone: details.automatic?.armedMilestone ?? null,
              foldCount: details.totalFolds ?? null,
            });
          } catch (error) {
            appendFailure(config, "runtime-observation", error instanceof Error ? error.message : String(error));
            throw error;
          }
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
              stage: expectedStage,
              requestSha256: request.requestSha256,
              toolCallId,
            });
            await waitForFile(responsePath, responsesDir, signal, config.watchdogMs);
            const response = JSON.parse(readFileSync(responsePath, "utf8"));
            assertSoak(exactKeys(response, [
              "version", "runId", "stage", "challengeSha256", "requestSha256", "content",
              "contentSha256", "nextChallenge", "nextChallengeSha256", "releasedWallMs",
              "releasedMonotonicMs", "paceRecordSha256", "responseSha256",
            ]), "Invalid supervisor response shape");
            assertSoak(response.version === 1 && response.runId === config.runId &&
              response.stage === expectedStage && response.challengeSha256 === request.challengeSha256 &&
              response.requestSha256 === request.requestSha256 &&
              response.contentSha256 === sha256Text(response.content) &&
              response.nextChallengeSha256 === sha256Text(response.nextChallenge) &&
              response.responseSha256 === responseIdentity(response),
            "Supervisor response identity drifted");
            assertBlindVisibleText(`archive response ${expectedStage}`, response.content);
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
              wallMs: Date.now(),
              monotonicMs: monotonicMs(),
              priorRecordSha256: priorRequestRecordSha256,
            };
            const projectionRecord = {
              ...projectionIdentity,
              recordSha256: sha256Json(projectionIdentity),
            };
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
        // A quorum_context action outside the soak's model allowlist is POLICY
        // refusal, not an integrity failure: with automatic folds live, models
        // legitimately probe expand/refold on the briefs they see. Block and
        // record it; only a tool outside the inventory latches the run red.
        if (event.toolName === "quorum_context" &&
            !SOAK_MODEL_CONTEXT_ACTIONS.includes(event.input?.action)) {
          appendEvent("blocked-context-action", {
            toolCallId: event.toolCallId,
            action: typeof event.input?.action === "string" ? event.input.action : null,
          });
          return { block: true, reason: "This acceptance run permits only status and fold context actions." };
        }
        if (event.toolName !== SOAK_TOOL_NAME && event.toolName !== "quorum_context") {
          appendFailure(config, "forbidden-tool", `${event.toolName}:${event.toolCallId}`);
          return { block: true, reason: "This acceptance run permits only archive progression and model context actions." };
        }
        appendEvent("tool-call", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          action: event.input?.action ?? null,
        });
        return undefined;
      });

      pi.on("context", (event, ctx) => {
        const strings = allStrings(event.messages);
        const hooks = strings.filter((text) => text.startsWith(SOAK_ADVISORY_HOOK_PREFIX));
        const branch = ctx.sessionManager.getBranch();
        let foldCount = 0;
        const recoveries = [];
        let advisory = null;
        try {
          const sessionId = ctx.sessionManager.getSessionId();
          const state = materializeActiveContextState(branch, sessionId,
            QUORUM_STATE_ENTRY, QUORUM_FOLD_RECORD_ENTRY);
          foldCount = state.folds.length;
          advisory = state.advisory ?? { highWater: 0, delivered: {} };
          for (const [milestone, delivered] of Object.entries(state.advisory?.delivered ?? {})) {
            assertSoak(delivered <= ADVISORY_BUDGETS[milestone],
              `Advisory milestone ${milestone} exceeded its delivery budget`);
          }
          for (const fold of state.folds) {
            recoveries.push({
              foldId: fold.id,
              sha256: sha256Json(recoverFoldMessages({
                foldId: fold.id,
                state,
                entries: branch,
                sessionId,
              })),
            });
          }
          const hookSha256 = hooks.map(sha256Text);
          const uncleared = foldCount > priorFoldCount
            ? priorHookSha256.filter((hash) => hookSha256.includes(hash)) : [];
          assertSoak(uncleared.length === 0,
            "A committed fold left its prior armed milestone hook projected");
          priorFoldCount = Math.max(priorFoldCount, foldCount);
          priorHookSha256 = hookSha256;
        } catch (error) {
          appendFailure(config, "fold-recovery", error instanceof Error ? error.message : String(error));
          throw error;
        }
        const identity = {
          version: 1,
          runId: config.runId,
          ordinal: ++requestOrdinal,
          kind: "context-projection",
          leafId: ctx.sessionManager.getLeafId(),
          markerIndex: readMarkerIndex(ctx),
          messageCount: event.messages.length,
          projectedMessagesSha256: sha256Json(event.messages),
          hookCount: hooks.length,
          hookSha256: hooks.map(sha256Text),
          hookBytes: hooks.map((text) => Buffer.byteLength(text, "utf8")),
          foldCount,
          recoveries,
          advisory,
          signalAborted: ctx.signal?.aborted === true,
          wallMs: Date.now(),
          monotonicMs: monotonicMs(),
          priorRecordSha256: priorRequestRecordSha256,
        };
        const record = { ...identity, recordSha256: sha256Json(identity) };
        appendJsonLineFsync(projectionLog, record);
        priorRequestRecordSha256 = record.recordSha256;
        if (identity.signalAborted) appendFailure(config, "context-aborted", identity.leafId ?? "no-leaf");
        const emergency = branch.find((entry) => entry?.type === "custom" && [
          NATIVE_COMPACTION_DECISION_ENTRY,
          NATIVE_COMPACTION_RECEIPT_ENTRY,
        ].includes(entry.customType));
        if (emergency) appendFailure(config, "emergency-entry", emergency.customType);
      });

      pi.on("before_provider_request", (event, ctx) => {
        if (inFlightProviderRequest) {
          appendFailure(config, "parallel-provider-request", inFlightProviderRequest.recordSha256);
          throw new Error("A provider request began before its predecessor produced an assistant response");
        }
        const strings = allStrings(event.payload);
        const hooks = strings.filter((text) => text.startsWith(SOAK_ADVISORY_HOOK_PREFIX));
        const providerTools = Array.isArray(event.payload?.tools) ? event.payload.tools : [];
        const providerToolNames = providerTools.map(providerToolName);
        const contextToolActions = providerContextToolActions(providerTools);
        if (JSON.stringify(contextToolActions) !== JSON.stringify(ACTIVE_CONTEXT_TOOL_ACTIONS)) {
          appendFailure(config, "provider-context-schema", JSON.stringify(contextToolActions));
          throw new Error("Provider payload advertised forbidden or missing quorum_context actions");
        }
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
          systemPromptSha256: sha256Text(ctx.getSystemPrompt()),
          providerToolsSha256: sha256Json(providerTools),
          providerToolNames,
          contextToolActions,
          hookCount: hooks.length,
          hookSha256: hooks.map(sha256Text),
          hookBytes: hooks.map((text) => Buffer.byteLength(text, "utf8")),
          wallMs: Date.now(),
          monotonicMs: monotonicMs(),
          priorRecordSha256: priorRequestRecordSha256,
        };
        const record = { ...identity, recordSha256: sha256Json(identity) };
        appendJsonLineFsync(projectionLog, record);
        priorRequestRecordSha256 = record.recordSha256;
        inFlightProviderRequest = {
          ordinal: record.ordinal,
          recordSha256: record.recordSha256,
          leafId: record.leafId,
        };
      });

      pi.on("tool_result", (event) => {
        if (event.toolName !== "quorum_context" || event.isError === true) return;
        appendEvent("model-context-result", {
          toolCallId: event.toolCallId ?? null,
          automaticSuspended: event.details?.automatic?.automaticSuspended ?? null,
          pressureRatio: event.details?.automatic?.pressureRatio ?? null,
          foldCount: event.details?.totalFolds ?? null,
        });
        if (event.details?.automatic?.automaticSuspended === true) {
          appendFailure(config, "automatic-suspended", event.details.automatic.boundaryFailure ?? "unknown");
          throw new Error("Active-context automation suspended during the advisory soak");
        }
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
          appendFailure(config, "non-terminal-provider-response", reason);
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
        appendEvent("session-shutdown");
      });
    },
  };
}
