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
//   - a native compaction is RECORDED, not latched as a failure, and it is judged by its
//     OUTCOME: the pifold arm runs with compaction enabled so the runtime's overflow lane
//     can arm off the hook, so a pass there is expected traffic and only a COMPLETED
//     compaction is a defect; for the native arm the completion is the event under
//     measurement;
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
} from "./lib/pi_fold_identity.mjs";
import {
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_LEDGER_TOOL_NAME,
  EXPERIMENT_MARKER_ENTRY,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  readEscapesCheckout,
  EXPERIMENT_TOOL_NAME,
  PI_OUTPUT_BUDGET,
  assertExperiment,
  estimateTokens,
  isWindowOverflow,
  nativeCompactionDisposition,
  matchedFenceShare,
  servedOutputBudget,
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
  // The model brief generator is deleted from the package (2026-08-14): every fold
  // briefs deterministically. A config that still asks for one is refused HERE, at the
  // only point that ever wired it, before any provider call; sealed manifests that
  // recorded a generator stay readable through validBriefGenerator and the adjudicator.
  assertExperiment(config.briefGenerator === undefined,
    "briefGenerator is deleted: the runtime briefs deterministically as of 2026-08-14, " +
    "and reproducing a generator campaign needs a checkout that predates the deletion");
  const pifold = config.arm === "pifold";
  // THE MATCHED-TRIGGER FENCE. Only the nativefence arm carries it, and only because Pi's
  // own threshold cannot: `_checkCompaction` runs after agent_end and before prompt
  // submission, and this workload is one prompt wrapping every stage, so on
  // sol-20260813-paired rep 1 it was evaluated exactly once, after all 64 stages, while
  // the projection sat inside its nominal band on 24 of 110 requests.
  const harnessFence = config.arm === "nativefence";
  // The SAME budget pi-fold measures its own fence against, so the two arms are compared
  // on one denominator rather than on two that merely look alike.
  const fenceBudgetTokens = config.providerInputBudget ?? null;
  const fenceThresholdTokens = fenceBudgetTokens === null
    ? null
    : Math.floor(matchedFenceShare(config.mode) * fenceBudgetTokens);
  assertExperiment(!harnessFence || Number.isSafeInteger(fenceThresholdTokens),
    "The matched-fence arm requires a declared providerInputBudget to fence against");
  // `abandonPending` is the one provider request each crossing is allowed to strand. See
  // the `before_provider_request` handler: it is armed at the crossing and consumed once.
  const fenceState = {
    crossings: 0, inFlight: false, lastTokens: null, abandonPending: false,
  };
  const compactionDisposition = nativeCompactionDisposition(config.arm);
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
  // The ledger's derive-and-record channel: tasks assigned by delivered stages,
  // results recorded through the ledger tool, stage progression gated on every
  // assigned task holding a record. Refusals are correctable and recorded, with
  // a generous bound so a loop that never records still fails by name rather
  // than by watchdog.
  const ledgerTasks = config.ledgerTasks ?? [];
  const ledgerRecords = new Map();
  const LEDGER_GATE_BUDGET = 24;
  let ledgerGateRefusals = 0;
  // Native-arm overflow errors are compaction breaths, bounded so a stuck loop latches.
  const OVERFLOW_BREATH_BUDGET = 12;
  let overflowBreaths = 0;
  // Provider errors waiting to learn whether the session recovered from them.
  const pendingProviderErrors = [];
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

  const safeArgumentsJson = (input) => {
    try { return JSON.stringify(input ?? null).slice(0, 2_048); }
    catch { return null; }
  };

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
      // Native compaction is an EVENT here, not a latch, and the event that counts is the
      // OUTCOME. The pifold arm runs with compaction enabled, so its hook fires are expected
      // traffic: the runtime cancels a threshold pass and converts an overflow pass into a
      // rollback, and neither reaches a summary. This handler returns nothing, which is what
      // lets the runtime's own handler, registered after it on the same event, return the
      // cancel that stops the pass.
      pi.on("session_before_compact", (event) => {
        const reason = event.reason ?? null;
        appendEvent("native-compaction-pass", {
          reason, willRetry: event.willRetry === true, stage: expectedStage,
        });
        if (compactionDisposition.stopsTheWorld) openStopTheWorld("native-compaction", reason ?? "unknown");
        // Only where compaction is switched off: there the hook cannot fire legitimately.
        if (compactionDisposition.latchOnPass) {
          appendFailure(config, "unexpected-native-compaction", reason ?? "unknown");
        }
      });

      // `session_compact` fires only after a summary has been appended and the transcript
      // replaced, so it is the honest completion witness: a cancelled or converted pass
      // never reaches it. The session's own compaction entry is the second witness, checked
      // on the branch by the context handler below.
      pi.on("session_compact", (event) => {
        appendEvent("native-compaction", {
          reason: event.reason ?? null,
          willRetry: event.willRetry === true,
          fromExtension: event.fromExtension === true,
          compactionEntryId: event.compactionEntry?.id ?? null,
          stage: expectedStage,
        });
        if (compactionDisposition.latchOnCompletion) {
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
          // deployment bootstrap produced with its agent, MCP and memory layers disabled.
          registerEvidenceIngestion(pi, {
            entryTypePrefix: PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix,
          });
          // No auto-fold blacklist: every completed tool batch is foldable unmarked, the
          // stage tool included, so stale stage results become eligible tool-fold batches
          // and the autonomous ladder fires on cadence rather than on the model
          // volunteering (the soak minor-3 lesson). The arm therefore runs the shipped
          // foldability law rather than a harness-only variant of it.
          registerActiveContext(pi, {
            ...PI_FOLD_ACTIVE_CONTEXT_REGISTRATION,
            // The deployment fact, when the run config carries one: without it the
            // runtime measures every threshold against the per-request descriptor.
            ...(config.providerInputBudget === undefined ? {} : { providerInputBudget: config.providerInputBudget }),
          });
        } finally {
          pi.registerTool = registerTool;
        }
        assertExperiment(contextToolDefinition,
          "Active-context registration did not expose the context tool for the pifold arm");
      }

      // The transcript-search tool is WITHDRAWN (Shane 2026-08-14; both external
      // reviews concurred). It ran in one sealed campaign and measured itself:
      // native answered probes off its own earlier answers, preserved verbatim by
      // Pi's compaction summary, and an arm holding exact archive search is not a
      // bytes-abandoned baseline. Each arm now carries only its shipped mechanism.

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
          // THE DERIVE-AND-RECORD CHANNEL ENDS IN A TOOL CALL THE WORKLOAD
          // ENFORCES (task #79 build 2). A bare record-it instruction is
          // silently skippable: rep 4 of sol-20260814-traps skipped all three
          // probed bindings and nothing recorded them anywhere, so the channel
          // measured re-derivation instead of recall. A fetch that arrives with
          // an assigned task unrecorded is refused with the exact repair and
          // the key unconsumed. ANY recorded value satisfies the gate (the task
          // text offers `unknown`), so correctness stays a grading question and
          // the gate cannot wedge a run that cannot derive.
          const owedTasks = ledgerTasks.filter((task) =>
            task.stage < expectedStage && !ledgerRecords.has(task.id));
          if (owedTasks.length > 0) {
            ledgerGateRefusals += 1;
            appendEvent("ledger-gate-refusal", {
              toolCallId,
              stage: expectedStage,
              owed: owedTasks.map((task) => task.id),
              refusals: ledgerGateRefusals,
            });
            if (ledgerGateRefusals > LEDGER_GATE_BUDGET) {
              appendFailure(config, "ledger-gate-loop", `${toolCallId}:${expectedStage}`);
              return { content: [{ type: "text", text: "The stage cannot be delivered." }], isError: true };
            }
            return { content: [{ type: "text", text:
              `Stage ${expectedStage} is not deliverable yet: ledger task(s) ` +
              `${owedTasks.map((task) => task.id).join(", ")} from the completed stages ` +
              `have no recorded result. Record each with the ${EXPERIMENT_LEDGER_TOOL_NAME} ` +
              "tool, then call again with the same key." }], isError: true };
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

      // The submission endpoint for the derive-and-record channel. The echo IS
      // the record: the result restates the id and value verbatim, so the
      // transcript carries the agent's own recorded derivation as a tool
      // result, the channel this workload's briefs and summaries demonstrably
      // carry. No verdict rides back: correctness is graded against the plan
      // after the run, an in-run verdict would prompt re-derivation the
      // instrument would then measure as recovery, and the expected values
      // never reach the run config at all. An unassigned id gets one answer
      // whether it is future or fictional, so the refusal can never confirm a
      // guessed task exists.
      pi.registerTool({
        name: EXPERIMENT_LEDGER_TOOL_NAME,
        label: "Ledger Record",
        description: "Record the result of an assigned ledger task for the current assignment.",
        promptSnippet: "Record each assigned ledger task's result once.",
        promptGuidelines: ["Use the task id given by the stage that assigned the task."],
        executionMode: "sequential",
        parameters: Type.Object({
          id: Type.String({ minLength: 1, maxLength: 64 }),
          value: Type.String({ minLength: 1, maxLength: 256 }),
        }, { additionalProperties: false }),
        async execute(toolCallId, params) {
          const assigned = ledgerTasks.find((task) => task.id === params.id &&
            task.stage < expectedStage);
          if (!assigned) {
            appendEvent("ledger-record-refused", {
              toolCallId, id: params.id, stage: expectedStage, cause: "unassigned",
            });
            return { content: [{ type: "text", text:
              `No ledger task with id ${params.id} has been assigned.` }], isError: true };
          }
          if (ledgerRecords.has(params.id)) {
            appendEvent("ledger-record-refused", {
              toolCallId, id: params.id, stage: expectedStage, cause: "already-recorded",
            });
            return { content: [{ type: "text", text:
              `Ledger task ${params.id} is already recorded as ` +
              `${ledgerRecords.get(params.id)}.` }], isError: true };
          }
          ledgerRecords.set(params.id, params.value);
          appendEvent("ledger-record", {
            toolCallId, id: params.id, value: params.value, afterStage: expectedStage - 1,
          });
          return { content: [{ type: "text", text:
            `Recorded ledger task ${params.id}: ${params.value}` }] };
        },
      });

      pi.on("tool_call", (event) => {
        if (!allowedTools.has(event.toolName)) {
          appendFailure(config, "forbidden-tool", `${event.toolName}:${event.toolCallId}`);
          return { block: true, reason: "This run permits only repository reading and stage progression." };
        }
        // READ IS CONFINED TO THE CHECKOUT (Shane 2026-08-14). Pi's read tool
        // resolves any relative or absolute path against cwd with no containment,
        // and the corpus sweep found 10 sealed runs that used that: 313 escaping
        // reads, 178 returning content, and 14 results across 5 runs carrying the
        // plan's own expectedAnswer, every one on a native or nativefence arm
        // (sol-20260812 native-rep9 walked /proc/self/cmdline to run-config.json
        // to stages-full.json and answered probe-64-06 verbatim off the key).
        // Containment, not spelling: the RESOLVED path is judged, because ".."
        // and absolute are also how legitimate reads inside the checkout arrive.
        // A blocked read is refused with a correctable reason rather than failing
        // the run: it leaked nothing, and the model can continue inside the
        // checkout. It is recorded as its own event so a run that probes the
        // boundary is visible in the artifacts.
        if (event.toolName === "read") {
          const requested = typeof event.input?.path === "string" ? event.input.path
            : typeof event.input?.file_path === "string" ? event.input.file_path : null;
          const { escapes, resolved, cause } = readEscapesCheckout(config.repoDir, requested);
          if (escapes) {
            appendEvent("read-escape-blocked", {
              toolCallId: event.toolCallId,
              requested,
              resolved,
              cause,
            });
            return { block: true, reason: cause === "missing-path"
              ? "This read named no path. Give one path relative to the checkout root."
              : "This run reads only files inside the repository checkout. " +
                "Give a path relative to the checkout root." };
          }
        }
        appendEvent("tool-call", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          action: event.input?.action ?? null,
          // Bounded arguments. A failed call whose arguments are gone cannot be told
          // apart as model misunderstanding versus runtime refusal.
          argumentsJson: safeArgumentsJson(event.input),
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
        if (event.toolName === PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.toolName) {
          // Errors are rows too: a failed context call used to survive only as an
          // anonymous isError line in tool-results.jsonl (the rep-23 class of misses).
          appendEvent("context-tool-result", {
            toolCallId: event.toolCallId ?? null,
            isError: event.isError === true,
            error: event.isError === true
              ? toolResultText(event.content ?? event.result?.content ?? null).slice(0, 512)
              : null,
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
        // A FENCED COMPACTION IS AN ABORT BY CONSTRUCTION, so this arm records one rather
        // than latching it. Pi's `compact` runs `_disconnectFromAgent()` and `await
        // abort()` as its FIRST two statements, before it has read a setting or checked
        // whether it can compact at all, so the live turn dies at every crossing and the
        // abort is the mechanism working rather than the harness breaking. It is
        // RECLASSIFIED, never swallowed: it gets its own event, the window is bounded to
        // the crossing that caused it, and an aborted context anywhere outside that window
        // latches exactly as it always has.
        if (identity.signalAborted) {
          if (fenceState.inFlight) {
            appendEvent("harness-fence-abort", {
              crossing: fenceState.crossings,
              leaf_id: identity.leafId ?? null,
            });
          } else {
            appendFailure(config, "context-aborted", identity.leafId ?? "no-leaf");
          }
        }
        const native = ctx.sessionManager.getBranch().find((entry) => entry?.type === "compaction" ||
          (entry?.type === "custom" && [
            PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY,
            PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY,
          ].includes(entry.customType)));
        // Second witness on the same outcome: the runtime writes its decision and receipt
        // entries from its own `session_compact` handler, so all three entry types appear on
        // the branch only once a compaction has actually completed.
        if (native && compactionDisposition.latchOnCompletion) {
          appendFailure(config, "unexpected-native-entry", native.customType ?? native.type);
        }
      });

      pi.on("before_provider_request", (event, ctx) => {
        if (inFlightProviderRequest) {
          // OUR OWN ABORT STRANDS ONE REQUEST PER CROSSING. This marker is cleared by the
          // assistant response its request produces, and an aborted request produces none:
          // rep 2 of sol-20260814-fenced opened a 174,562-char request 4ms after the fence
          // abort landed, that request died unanswered (13 requests, 12 responses), and the
          // next one read as parallel traffic and latched a capability breach that had not
          // happened. The allowance is armed at the crossing and consumed ONCE, so a second
          // stranded request, or any stranded request without a crossing behind it, is
          // still the breach this invariant exists to catch.
          if (fenceState.abandonPending) {
            fenceState.abandonPending = false;
            appendEvent("harness-fence-abandoned-request", {
              crossing: fenceState.crossings,
              record_sha256: inFlightProviderRequest.recordSha256,
            });
            inFlightProviderRequest = null;
          } else {
            appendFailure(config, "parallel-provider-request", inFlightProviderRequest.recordSha256);
            throw new Error("A provider request began before its predecessor produced an assistant response");
          }
        }
        const providerTools = Array.isArray(event.payload?.tools) ? event.payload.tools : [];
        const payloadChars = allStrings(event.payload).reduce((total, text) => total + text.length, 0);
        // What Pi will let this request WRITE, which is not a constant and is not ours to
        // set: see PI_OUTPUT_BUDGET. Recorded on every request so the starved case is
        // visible in the ledger rather than inferred from an error rate afterwards.
        // Close but not identical to Pi's own figure: this counts every string in the
        // payload where Pi estimates over the message list, so the two disagree by the
        // tool and system-prompt text. Far too small to matter against a 4,096-token latch
        // whose defect case sat at 16, and erring high is the safe direction for a floor.
        const outputBudgetTokens = Number.isSafeInteger(ctx.model?.contextWindow) &&
          Number.isSafeInteger(ctx.model?.maxTokens)
          ? servedOutputBudget({
            contextWindow: ctx.model.contextWindow,
            contextChars: payloadChars,
            modelMaxTokens: ctx.model.maxTokens,
          })
          : null;
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
          payloadChars,
          outputBudgetTokens,
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
        // A managed arm that starves its own output budget is misconfigured, and the failure
        // it produces looks like the provider's fault. The unmanaged arm is exempt because
        // filling the window until it breaks is precisely that arm's datum, and the native
        // arm is exempt because Pi's compaction trigger, not our thresholds, decides when it
        // sits high. Only the arm whose occupancy WE set is held to this.
        if (config.arm === "pifold") {
          // A descriptor the budget cannot be read from is not a reason to skip the check:
          // it is the check going quiet, which is the failure mode this whole lane exists
          // to end. Loud either way.
          if (outputBudgetTokens === null) {
            appendFailure(config, "unreadable-output-budget",
              `${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"} states no window or maximum`);
          } else if (outputBudgetTokens < PI_OUTPUT_BUDGET.latchBelowTokens) {
            appendFailure(config, "starved-output-budget",
              `${outputBudgetTokens} tokens at ${payloadChars} projected chars`);
          }
        }
        inFlightProviderRequest = {
          ordinal: record.ordinal, recordSha256: record.recordSha256, leafId: record.leafId,
        };
        // The first provider request AFTER a stop-the-world event closes it: that gap is
        // the time-to-first-productive-request the experiment reports per event.
        closeStopTheWorld();
      });

      pi.on("message_end", (event, ctx) => {
        const reason = event.message?.role === "assistant" ? event.message.stopReason : null;
        // THE FENCE FIRES ON WHAT THE PROVIDER COUNTED, on the same reading pi-fold's own
        // fence is anchored to, and it fires ONCE per crossing: `compact` does not await,
        // so without the in-flight latch a single crossing would queue one compaction per
        // message until the summary landed.
        if (harnessFence && event.message?.role === "assistant" && !fenceState.inFlight) {
          const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
          const tokens = typeof usage?.tokens === "number" ? usage.tokens : null;
          fenceState.lastTokens = tokens;
          if (tokens !== null && tokens > fenceThresholdTokens) {
            fenceState.inFlight = true;
            fenceState.crossings += 1;
            fenceState.abandonPending = true;
            appendEvent("harness-fence-crossing", {
              crossing: fenceState.crossings,
              occupancy_tokens: tokens,
              threshold_tokens: fenceThresholdTokens,
              occupancy_share: tokens / fenceBudgetTokens,
              share_rule: matchedFenceShare(config.mode),
              budget_tokens: fenceBudgetTokens,
            });
            ctx.compact({
              onComplete: () => {
                fenceState.inFlight = false;
                appendEvent("harness-fence-compacted", {
                  crossing: fenceState.crossings, serviced_by: "fence",
                });
              },
              // A FENCE THAT CANNOT COMPACT IS A DEAD ARM, so it says so and latches
              // rather than quietly leaving the window to grow unopposed. One outcome is
              // not that, and it is the one this arm turns out to produce most of the time.
              //
              // ALREADY COMPACTED IS THE CROSSING BEING SERVICED. `compact` aborts the live
              // turn before it prepares anything, and that abort ends the agent operation,
              // which is precisely the boundary Pi's own `_checkCompaction` runs at. Gate
              // 66 found that boundary never arrives during a single long pull-based turn;
              // the fence supplies one. In rep 1 of sol-20260814-fenced the crossing fired
              // at 51,853 tokens, the abort landed 18ms later, Pi's own threshold pass
              // opened 10ms after that and had summarized the branch 12.5 seconds later
              // (reason "threshold", fromExtension false, entry aed93cd9). Our manual
              // request then reached `prepareCompaction`, found a branch already ending in
              // a compaction entry, and threw. The crossing got exactly the compaction it
              // asked for, from the trigger the arm is matched to.
              //
              // Accepted only on PROOF of that, the compaction entry standing on the
              // branch, which is the same condition `prepareCompaction` refused on. The
              // message alone is never enough, and every other error still latches.
              onError: (error) => {
                fenceState.inFlight = false;
                const message = error?.message ?? String(error);
                const compacted = ctx.sessionManager.getBranch().at(-1)?.type === "compaction";
                if (/Already compacted/.test(message) && compacted) {
                  appendEvent("harness-fence-compacted", {
                    crossing: fenceState.crossings, serviced_by: "native-threshold",
                  });
                  return;
                }
                appendFailure(config, "harness-fence-compaction",
                  `${fenceState.crossings}:${message}`);
              },
            });
          }
        }
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
            // WHAT the provider said, not merely THAT it said no. Rep 2 of sol-20260811
            // recorded sixteen errors as the bare word "error", so the cause had to be
            // reconstructed by correlation from a run that was already dead; the text was
            // in hand the whole time and was only ever written to the failure path. A stop
            // reason without its message is a symptom with the diagnosis thrown away.
            errorMessage: typeof event.message.errorMessage === "string"
              ? event.message.errorMessage.slice(0, 2_048)
              : null,
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
          const errorMessage = event.message?.errorMessage ?? "";
          const windowOverflow = isWindowOverflow(errorMessage);
          const overflowBreath = config.arm === "native" && reason === "error" && windowOverflow;
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
            // A transport error the session then recovers from is the provider's weather,
            // not this trial's result. Pi retries a retryable assistant error and, in its
            // own words, removes the error message from agent state while keeping it in
            // the session for history, so the retried request carries a byte-identical
            // payload and the failed attempt bills zero tokens: nothing the trial measures
            // moved. Rep 4 of luna-20260810 is that case six times over, and rep 1 was
            // failed for it while completing every stage it planned (Shane 2026-08-11).
            //
            // Held, not forgiven. The error becomes a failure unless a later assistant
            // response actually succeeds, and anything still pending at shutdown latches.
            // Two exclusions keep the real failures red: the window wall is never weather
            // (Pi will not retry it either, since context overflow is compaction's job and
            // not retry's), and only "error" is eligible, because an abort means something
            // cancelled the run and "length" means the answer itself was truncated.
            if (reason === "error" && !windowOverflow) {
              pendingProviderErrors.push({
                stage: expectedStage,
                detail: errorMessage.slice(0, 2_048),
                wallMs: Date.now(),
                monotonicMs: monotonicMs(),
              });
            } else {
              appendFailure(config, "non-terminal-provider-response",
                windowOverflow ? `${reason}:window-overflow` : reason);
            }
          }
        } else if (reason && pendingProviderErrors.length) {
          // The session got an answer, so every error it was still carrying was survived.
          // Recorded with what it cost in attempts and wall time: a rep that recovered
          // forty times is a different quality of datum from one that never stumbled,
          // and that has to stay visible rather than being absorbed into silence.
          const recovered = pendingProviderErrors.splice(0, pendingProviderErrors.length);
          appendEvent("provider-error-recovered", {
            attempts: recovered.length,
            stage: expectedStage,
            recoveredAfterMs: monotonicMs() - recovered[0].monotonicMs,
            firstDetail: recovered[0].detail,
          });
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
        // The same one-per-crossing allowance: a run that ends while a crossing's stranded
        // request is still outstanding never had a response owed to it. Unarmed, this is
        // the unanswered request it always was.
        if (inFlightProviderRequest && fenceState.abandonPending) {
          fenceState.abandonPending = false;
          appendEvent("harness-fence-abandoned-request", {
            crossing: fenceState.crossings,
            record_sha256: inFlightProviderRequest.recordSha256,
          });
          inFlightProviderRequest = null;
        }
        if (inFlightProviderRequest) {
          appendFailure(config, "provider-request-without-response", inFlightProviderRequest.recordSha256);
        }
        // Held errors are only weather while the session goes on to answer. One still
        // held here never was survived: the run ended on it.
        for (const held of pendingProviderErrors.splice(0, pendingProviderErrors.length)) {
          appendFailure(config, "provider-error-unrecovered", held.detail || "error");
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
