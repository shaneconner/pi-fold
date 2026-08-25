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

import { Socket } from "node:net";
import { Type } from "typebox";
// The measured runtime is this repo's own package, not a consumer's deployed copy: the
// bytes under test are tracked, so the run seal pins exactly what executed.
import { registerActiveContext } from "../extensions/active-context.ts";
import { registerEvidenceIngestion } from "../extensions/evidence.js";
import {
  collectArtifact,
  plantArtifact,
} from "./lib/pi_context_artifacts.mjs";
import {
  PI_FOLD_ACTIVE_CONTEXT_REGISTRATION,
  PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY,
  PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY,
} from "./lib/pi_fold_identity.mjs";
import {
  EXPERIMENT_ALLOWED_TOOLS,
  EXPERIMENT_MARKER_ENTRY,
  isExperimentMarkerEntry,
  EXPERIMENT_PIFOLD_EXTRA_TOOLS,
  readEscapesCheckout,
  PI_OUTPUT_BUDGET,
  assertExperiment,
  estimateTokens,
  isWindowOverflow,
  nativeCompactionDisposition,
  servedOutputBudget,
  toolResultContentSha256,
  toolResultText,
} from "./lib/pi_context_experiment.mjs";
import {
  exactKeys,
  monotonicMs,
  processStartTicks,
  sha256Json,
  sha256Text,
} from "./lib/pi_context_soak_attestation.mjs";
import { DELIVERY_FD, appendRunChannel } from "./lib/pi_context_sandbox.mjs";

function allStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, result);
  else if (value && typeof value === "object") {
    for (const key of Object.keys(value)) allStrings(value[key], result);
  }
  return result;
}

function appendFailure(config, phase, detail) {
  appendRunChannel("failure-latch.jsonl", {
    version: 1,
    runId: config.runId,
    phase,
    detail: String(detail).slice(0, 2_048),
    wallMs: Date.now(),
    monotonicMs: monotonicMs(),
  });
}

// THE DELIVERY CHANNEL (2026-08-25). This used to be two directories the model shared,
// `ipc/requests` and `ipc/responses`, watched for a file to appear. It is one duplex socket
// on an inherited descriptor now, so the round-trip that paces the run leaves no trace in any
// namespace the model can reach and the response is consumed by definition rather than by a
// truncate the next reader has to be trusted to perform. Line-delimited JSON, strictly one
// request in flight, because the worker asks for exactly one stage at a time and waits.
function openDeliveryChannel(fd) {
  const socket = new Socket({ fd, readable: true, writable: true });
  socket.setEncoding("utf8");
  // UNREFERENCED, or the worker never exits (2026-08-25, found by sol-20260825-fdsmoke).
  // A socket is a libuv handle and an open one holds the event loop up on its own. Both arms
  // of that smoke delivered all 8 stages, answered the end block, wrote their manifest and
  // their report, printed the final summary line, ran off the end of the worker script, and
  // then sat there: the supervisor waits on the child's exit, so a run that had done every
  // piece of its work correctly was going to be killed at the 90 minute watchdog and reported
  // as a failure. Nothing needs this handle to hold the loop: the worker awaits one stage at a
  // time and the per-request timer below is referenced, so the loop stays up exactly as long
  // as a request is actually in flight and not one moment longer.
  socket.unref();
  let buffered = "";
  let waiting = null;
  const settle = (error, value) => {
    if (!waiting) return;
    const pending = waiting;
    waiting = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  };
  socket.on("data", (chunk) => {
    buffered += chunk;
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim().length > 0) settle(null, JSON.parse(line));
    }
  });
  socket.on("error", (error) => settle(error));
  // A closed channel with a request in flight is a supervisor that went away, which is a
  // failure of the run rather than a stage that is merely slow: say so instead of waiting
  // out the watchdog.
  socket.on("close", () => settle(new Error("The supervisor closed the delivery channel")));
  return (request, deadlineMs) => {
    if (waiting) throw new Error("The delivery channel already has a request in flight");
    const answered = new Promise((resolve, reject) => {
      waiting = {
        resolve,
        reject,
        timer: setTimeout(
          () => settle(new Error("Experiment stage response deadline expired")), deadlineMs),
      };
    });
    socket.write(`${JSON.stringify(request)}\n`);
    return answered;
  };
}

function responseIdentity(response) {
  const { responseSha256: _response, paceRecordSha256: _pace, ...identity } = response;
  return sha256Json(identity);
}

function readMarkerIndex(ctx) {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index]?.type === "custom" && isExperimentMarkerEntry(branch[index]?.customType)) return index;
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
  // THE MATCHED-TRIGGER FENCE IS GONE (2026-08-25). It existed for one reason, stated in
  // its own comment: Pi's `_checkCompaction` runs after agent_end and before prompt
  // submission, and the workload was ONE prompt wrapping every stage, so on
  // sol-20260813-paired rep 1 it was evaluated exactly once, after all 64 stages. Stages are
  // user messages now, so Pi evaluates its own threshold on every turn boundary and `native`
  // is the comparator on Pi's own trigger. With the fence went its abort, the abandoned
  // request and response allowances, the deferred stale-ctx verification and its witness
  // counter, and the resume that every abort required.
  // HOW A NATIVE COMPACTION IS RECORDED, per arm. This is not fence machinery and it
  // outlived the fence: the pifold arm runs with compaction enabled and its hook fires are
  // expected traffic, so what latches is the OUTCOME rather than the pass.
  const compactionDisposition = nativeCompactionDisposition(config.arm);
  const allowedTools = new Set([
    ...EXPERIMENT_ALLOWED_TOOLS,
    ...(pifold ? EXPERIMENT_PIFOLD_EXTRA_TOOLS : []),
  ]);
  let expectedStage = 1;
  let requestOrdinal = 0;
  let priorRequestRecordSha256 = null;
  let eventOrdinal = 0;
  let priorEventRecordSha256 = null;
  let toolResultOrdinal = 0;
  let priorToolResultSha256 = null;
  // The ledger's derive-and-record channel: tasks assigned by delivered stages,
  // results recorded through the ledger tool, stage progression gated on every
  // assigned task holding a record. Refusals are correctable and recorded, with
  // a generous bound so a loop that never records still fails by name rather
  // than by watchdog.
  // Native-arm overflow errors are compaction breaths, bounded so a stuck loop latches.
  const OVERFLOW_BREATH_BUDGET = 12;
  let overflowBreaths = 0;
  // Provider errors waiting to learn whether the session recovered from them.
  const pendingProviderErrors = [];
  let inFlightProviderRequest = null;
  let pendingStopTheWorld = null;
  let contextToolDefinition = null;
  // THE RUN DIRECTORY IS NOT IN THE NAMESPACE ANY MORE (2026-08-25). These were paths under
  // a directory the model shared; they are channel NAMES now, written to descriptors the
  // supervisor opened on the host, and the files land exactly where they always did. Only the
  // writer changed.
  // OPENED ON FIRST USE. A closed-book session delivers no stages and never opens it at all,
  // and the gate suite constructs this extension in processes that hold no such descriptor.
  let requestStage = null;
  const projectionLog = "provider-requests.jsonl";
  const eventLog = "worker-events.jsonl";
  const toolResultLog = "tool-results.jsonl";
  const stopTheWorldLog = "stop-the-world.jsonl";

  // ---------------------------------------------------------------------------
  // THE STALE-ARTIFACT BOUNDS (Shane 2026-08-25).
  //
  // A file the model populates is a disk-based memory the harness invented, which is gate
  // 74's lesson one artifact over: `ipc/responses/stage-NN.json` used to survive the run,
  // 27 of 64 carried seeded ledger values, and an arm that lost a stage could grep it back.
  // Left in place, a model writes correct values early and re-reads its own file late
  // instead of recalling anything, and BOTH arms score near-perfect while we measure the
  // filesystem. Three bounds, all required, all here:
  //
  //   1. DROP LATE     the artifact does not exist until the stage that asks about it
  //   2. CONSUME       truncated to zero the moment the next stage is requested, after
  //                    its contents are snapshotted where the model cannot reach
  //   3. BACKDATE      a "stale report from an earlier pass" whose mtime is thirty seconds
  //                    old is a tell, and `stat` is natural analyst behaviour
  //
  // Both the drop and the consume happen BETWEEN TURNS, driven by the worker, with the
  // model not running at all. That is strictly stronger than the old argument, which rested
  // on the model being blocked inside its own stage tool call: there is no turn in which the
  // file exists unexpectedly and the model can run.
  const staleArtifacts = new Map((config.staleArtifacts ?? []).map((ask) => [ask.askStage, ask]));
  const artifactLog = "stale-artifacts.jsonl";
  let plantedArtifact = null;

  const plantStaleArtifact = (stage) => {
    const ask = staleArtifacts.get(stage);
    if (!ask) return null;
    const planted = plantArtifact({ repoDir: config.repoDir, ask, referencePath: "README" });
    plantedArtifact = { ...ask, plantedAtStage: stage };
    appendEvent("stale-artifact-planted", {
      id: ask.id, schema: ask.schema, stage, path: ask.path,
      chars: planted.chars, sha256: sha256Text(ask.text), backdatedTo: planted.backdatedTo,
    });
    return ask;
  };

  // Snapshot then truncate. The snapshot is the whole measurement: it fixes what the model
  // wrote AT THIS INSTANT, which is what makes a later comparison unfakeable and is why
  // `ledger_record` is not needed to get that property. It lands in the run directory,
  // outside the checkout, where the model was never able to reach.
  const collectStaleArtifact = () => {
    if (!plantedArtifact) return null;
    const ask = plantedArtifact;
    plantedArtifact = null;
    const collected = collectArtifact({ repoDir: config.repoDir, ask });
    // The snapshot lands in the RUN directory, outside the checkout, where the model was
    // never able to reach.
    const identity = {
      version: 1,
      runId: config.runId,
      id: ask.id,
      schema: ask.schema,
      path: ask.path,
      plantedAtStage: ask.plantedAtStage,
      collectedAtStage: expectedStage,
      untouched: collected.untouched,
      missing: collected.missing,
      chars: collected.chars,
      returnedSha256: collected.returned === null ? null : sha256Text(collected.returned),
      plantedSha256: sha256Text(ask.text),
      returned: collected.returned,
      wallMs: Date.now(),
      monotonicMs: monotonicMs(),
    };
    appendRunChannel(artifactLog, { ...identity, recordSha256: sha256Json(identity) });
    appendEvent("stale-artifact-collected", {
      id: ask.id, schema: ask.schema, path: ask.path,
      untouched: identity.untouched, missing: identity.missing, chars: identity.chars,
    });
    return identity;
  };

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
    appendRunChannel(eventLog, record);
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
    appendRunChannel(toolResultLog, record);
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
    appendRunChannel(stopTheWorldLog, record);
    pendingStopTheWorld = null;
  };

  // ---------------------------------------------------------------------------
  // STAGE DELIVERY, DRIVEN BY THE WORKER (2026-08-25).
  //
  // This was a TOOL the model called with a 64-hex key it had to keep. Nothing here ever
  // needed the model to hold that key: `expectedStage` and the challenge were both this
  // closure's own variables, ordering and replay were enforced off `expectedStage`, and the
  // supervisor's request identity was built from the challenge this side held, never from
  // the one the model sent. `params.key` appeared exactly once in the whole file, in an
  // equality test against a value already in hand. It was an in-band retention probe on the
  // DELIVERY CHANNEL, and a structurally asymmetric one: pifold could peek a fold and
  // recover the nonce losslessly, while an arm that had just compacted might hold no copy
  // anywhere, so the arm that compacts could lose the ability to RECEIVE WORK. That is not
  // the thing under test, and in sol-20260825-v5smoke3 it ended the nativefence arm at 5/8.
  //
  // The IPC is unchanged and still ends at the supervisor, which remains the only renderer
  // and the only holder of the plan. What changed is who asks: the worker, between turns.
  //
  // THE EVENT STREAM KEEPS ONE WRITER. `appendEvent` carries an ordinal and a
  // priorRecordSha256 chain, so this stays here rather than moving to the worker, and the
  // worker drives it through the handle returned below.
  const deliverStage = async () => {
    const stage = expectedStage;
    assertExperiment(stage >= 1 && stage <= config.stageCount,
      `Stage ${stage} is outside the plan`);
    // COLLECT BEFORE SERVING. Whatever the model did to the last artifact is fixed here,
    // before it can see anything new, and the file is consumed in the same breath so it can
    // never be re-read later in place of remembering. The window is airtight for a stronger
    // reason than it used to be: the model is not merely blocked inside a tool call, it has
    // ENDED ITS TURN and is not running at all.
    collectStaleArtifact();
    const requestIdentity = {
      version: 1,
      runId: config.runId,
      stage,
      workerPid: process.pid,
      workerStartTicks: processStartTicks(process.pid),
      requestedWallMs: Date.now(),
      requestedMonotonicMs: monotonicMs(),
    };
    const request = { ...requestIdentity, requestSha256: sha256Json(requestIdentity) };
    try {
      requestStage = requestStage ?? openDeliveryChannel(DELIVERY_FD);
      appendEvent("stage-request", { stage, requestSha256: request.requestSha256 });
      const response = await requestStage(request, config.watchdogMs);
      assertExperiment(exactKeys(response, [
        "version", "runId", "stage", "requestSha256", "content",
        "contentSha256", "payloadSha256",
        "releasedWallMs", "releasedMonotonicMs", "paceRecordSha256", "responseSha256",
      ]), "Invalid supervisor response shape");
      assertExperiment(response.version === 1 && response.runId === config.runId &&
        response.stage === stage && response.requestSha256 === request.requestSha256 &&
        response.contentSha256 === sha256Text(response.content) &&
        response.responseSha256 === responseIdentity(response),
      "Supervisor response identity drifted");
      // CONSUMED BY CONSTRUCTION (gate 74, closed at the root). The stage's rendered text
      // used to arrive as a FILE and survive the whole run: in sealed native rep 5, 27 of 64
      // responses carried seeded values, so an arm that lost a stage could re-read it
      // verbatim off disk. It was truncated on read to close that, which worked but left the
      // recovery channel one missed truncate away from reopening. It arrives on a socket now
      // and is never written down at all.
      expectedStage += 1;
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
      appendRunChannel(projectionLog, projectionRecord);
      priorRequestRecordSha256 = projectionRecord.recordSha256;
      appendEvent("stage-result", { stage, responseSha256: response.responseSha256 });
      // DROP LATE: the artifact appears only now, as the stage that asks about it is
      // delivered, so it never sits in the checkout waiting to be found.
      const planted = plantStaleArtifact(stage);
      const text = planted
        ? `${response.content}\n\n${planted.request}\nThe file is at ${planted.path}.\n`
        : response.content;
      return { stage, text };
    } catch (error) {
      appendFailure(config, "stage-execution", error instanceof Error ? error.message : String(error));
      throw error;
    }
  };

  return {
    name: "pi-fold-context-experiment",
    // THE WORKER'S HANDLE. Stage delivery is no longer something the model asks for, so the
    // worker drives it: one `deliverStage()` per user message, then `collectPendingArtifact`
    // once more after the last stage so no populated note is left standing in the checkout.
    deliverStage,
    collectPendingArtifact: () => collectStaleArtifact(),
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
            // The deterministic condition: false silences the brief invitation, so
            // the arm measures the runtime's own words against the same plan.
            ...(config.postFoldNotice === undefined ? {} : { postFoldNotice: config.postFoldNotice }),
            // The band condition: an explicit thresholds object, validated whole by the
            // runtime's own resolveThresholds at registration.
            ...(config.thresholds === undefined ? {} : { thresholds: config.thresholds }),
            // The tool-call diet: the share point travels verbatim; the runtime's own
            // registration validation refuses anything outside the open interval.
            ...(config.toolFoldThreshold === undefined ? {} : { toolFoldThreshold: config.toolFoldThreshold }),
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


      // `ledger_record` IS DELETED (Shane, 2026-08-25: "I'd get rid of them for sure").
      //
      // It stood in the tool list every turn describing itself as "Record the result of an
      // assigned ledger task", with a promptSnippet saying to record each one once. A tool
      // whose name and description say RECORD THE RESULT tells the model continuously that
      // recording derived facts is the graded activity, which hands back most of what the
      // de-priming bought and does it every turn rather than once per compaction.
      //
      // Its one irreplaceable property was that the record is fixed AT RECORD TIME, which
      // is what made the faithful-to-wrong cell unfakeable. The stale artifact gives that
      // for free: the model writes its answer into the note and the harness snapshots the
      // file at the instant it collects it. Same unfakeable comparison, no bespoke tool.
      //
      // It arrived 2026-08-15 in the same commit as the ledger it served (f551657), so no
      // sealed run ever carried one without the other and the confound cannot be separated
      // out of the v4 corpus after the fact.

      // The tools whose containment can be judged from their own arguments.
      const PATH_FENCED_TOOLS = new Set(["read", "edit", "write"]);

      pi.on("tool_call", (event) => {
        if (!allowedTools.has(event.toolName)) {
          appendFailure(config, "forbidden-tool", `${event.toolName}:${event.toolCallId}`);
          // NEUTRAL, AND NAMING NOTHING (Shane, 2026-08-25). This said "This run permits only
          // repository reading and stage progression", which described a delivery protocol that
          // was deleted and told the model, in a refusal it could trigger deliberately, that it
          // was inside a managed run advancing through numbered units. A refusal is a
          // model-visible surface like any other. Currently unreachable, since the exposed and
          // allowed sets are identical, and live the moment they diverge.
          return { block: true, reason: `The ${event.toolName} tool is not available here.` };
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
        // EVERY TOOL THAT TAKES A PATH, not just `read` (2026-08-25). The fence was
        // `event.toolName === "read"` against an allowed set of read, bash, edit and write,
        // so `edit` and `write` could name any path in the namespace and were never checked.
        // `bash` takes a command rather than a path and cannot be fenced this way at all,
        // which is the finding the audit reported and which the mount is the real answer to;
        // this closes the two that CAN be checked rather than leaving them open because the
        // third is hard.
        if (PATH_FENCED_TOOLS.has(event.toolName)) {
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
              ? "No path was given. Give one path relative to the current directory."
              : "That path is outside the current directory. " +
                "Give a path relative to the current directory." };
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
        appendRunChannel(projectionLog, record);
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
          appendFailure(config, "context-aborted", identity.leafId ?? "no-leaf");
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
          appendFailure(config, "parallel-provider-request", inFlightProviderRequest.recordSha256);
          throw new Error("A provider request began before its predecessor produced an assistant response");
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
        appendRunChannel(projectionLog, record);
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
        // A LOCAL ZERO-USAGE ABORT MARKER never fires a crossing: the provider counted
        // nothing, so the occupancy reading is stale, and a marker that armed the
        // abandon allowance would consume it for ITSELF in the same pass, hiding the
        // orphan the seal exists to catch while leaving the fence's own stranded marker
        // to latch anyway.
        const markerUsage = event.message?.usage ?? {};
        const localAbortMarker = event.message?.role === "assistant" &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted") &&
          ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]
            .every((key) => !markerUsage[key]);
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
          appendRunChannel(projectionLog, record);
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
          appendRunChannel(stopTheWorldLog, {
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
