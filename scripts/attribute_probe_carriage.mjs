// Sweep a sealed campaign and attribute every probe's expected answer at the
// request that answered it: was the truth visible raw, visible in a brief, one
// peek away, or absent, and when a question names a trace row, was the BINDING
// (`row: value`) ever stated at all. The distinction earned its keep on its
// first run: rep 4's log entry said three missed bindings were recorded in
// channels briefs do not claim, and this sweep showed they were never recorded
// anywhere, so the miss class was re-derivation without recovery, not carriage.
//
//   node scripts/attribute_probe_carriage.mjs <campaign-dir>
//
// Reads only sealed artifacts; writes nothing. One JSON line per probe, then a
// rollup per arm. The parent runs fixed four-row child batches so a completed
// sweep does not depend on one process retaining every reconstructed forest.
// Numeric answers are also tried zero-padded because the workload's agents
// write stage numbers both ways, and a carriage claim that misses a format is a
// false absence.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ATTRIBUTION_BATCH_ROWS,
  attributionBatchStarts,
} from "./lib/pi_context_attribution.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = fileURLToPath(import.meta.url);
const INTERNAL_BATCH_FLAG = "--attribution-batch";
const campaignDir = process.argv[2];
if (!campaignDir) {
  process.stderr.write("usage: node scripts/attribute_probe_carriage.mjs <campaign-dir>\n");
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonl = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

function expandedRowCount(evidence) {
  const probes = evidence.probeVerdicts?.length ?? 0;
  const endBlock = (evidence.endBlock?.rows ?? []).reduce(
    (count, row) => count + (row.kind === "table" ? (row.rows?.length ?? 0) : 1),
    0,
  );
  return probes + endBlock;
}

function rollupKey(row) {
  if (row.probeId) {
    const carriage = row.unreadable ? "state-unreadable" : row.valueCarriage;
    return `${row.arm}-rep${row.repetition} ${row.verdict} ${carriage}` +
      (row.bindingCarriage ? ` binding:${row.bindingCarriage}` : "");
  }
  return `${row.arm}-rep${row.repetition} end:${row.kind} ${row.verdict} ${row.valueCarriage}` +
    (row.withdrawnCarriage ? ` withdrawn:${row.withdrawnCarriage}` : "");
}

function runCampaignParent() {
  const runsDir = join(campaignDir, "runs");
  if (!existsSync(runsDir)) throw new Error(`campaign has no runs directory: ${campaignDir}`);
  const rollup = new Map();
  const runEntries = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of runEntries) {
    const evidencePath = join(runsDir, entry.name, "experiment-evidence.json");
    if (!existsSync(evidencePath)) continue;
    const totalRows = expandedRowCount(readJson(evidencePath));
    for (const start of attributionBatchStarts(totalRows)) {
      const child = spawnSync(process.execPath, [
        SCRIPT, campaignDir, INTERNAL_BATCH_FLAG, entry.name, String(start),
      ], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (child.error) throw child.error;
      if (child.status !== 0) {
        throw new Error(
          `attribution batch failed for ${entry.name} rows ${start}-${start + ATTRIBUTION_BATCH_ROWS - 1}: ` +
          `${child.stderr.trim() || `exit ${child.status}`}`,
        );
      }
      const lines = child.stdout.split("\n").filter(Boolean);
      const expected = Math.min(ATTRIBUTION_BATCH_ROWS, totalRows - start);
      if (lines.length !== expected) {
        throw new Error(
          `attribution batch for ${entry.name} at row ${start} emitted ${lines.length}, expected ${expected}`,
        );
      }
      for (const line of lines) {
        const row = JSON.parse(line);
        process.stdout.write(`${JSON.stringify(row)}\n`);
        const key = rollupKey(row);
        rollup.set(key, (rollup.get(key) ?? 0) + 1);
      }
    }
  }
  process.stdout.write("=== rollup (arm-rep verdict value-carriage [binding-carriage]: count) ===\n");
  for (const [key, count] of [...rollup.entries()].sort()) {
    process.stdout.write(`${key}: ${count}\n`);
  }
}

async function runAttributionBatch(runName, startText) {
  if (runName !== basename(runName)) throw new Error("attribution batch run must be a directory name");
  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start % ATTRIBUTION_BATCH_ROWS !== 0) {
    throw new Error(`invalid attribution batch start: ${startText}`);
  }

  const attribution = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
  const { createJiti } = await import(
    pathToFileURL(join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs")));
  const runtime = await createJiti(import.meta.url)
    .import(join(PROJECT, "extensions", "active-context.ts"));
  const identity = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const experiment = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));

  const runDir = join(campaignDir, "runs", runName);
  const evidencePath = join(runDir, "experiment-evidence.json");
  if (!existsSync(evidencePath)) throw new Error(`${runName}: no experiment evidence`);
  const evidence = readJson(evidencePath);
  const totalRows = expandedRowCount(evidence);
  if (start >= totalRows) throw new Error(`${runName}: batch start ${start} is past ${totalRows} rows`);
  const runConfig = readJson(join(runDir, "run-config.json"));
  const plan = readJson(runConfig.planPath);
  const probesById = new Map();
  const collectProbes = (node) => {
    if (Array.isArray(node)) { for (const item of node) collectProbes(item); return; }
    if (!node || typeof node !== "object") return;
    const id = node.probeId ?? node.id;
    if (typeof id === "string" && id.startsWith("probe-") &&
        typeof node.expectedAnswer === "string" && !probesById.has(id)) {
      probesById.set(id, node);
    }
    for (const value of Object.values(node)) collectProbes(value);
  };
  collectProbes(plan);

  const harnessJsonl = new Set([
    "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
    "tool-results.jsonl", "worker-events.jsonl",
  ]);
  const sessionName = readdirSync(runDir).sort().find((name) =>
    name.endsWith(".jsonl") && !harnessJsonl.has(name));
  if (!sessionName) throw new Error(`${runName}: no session file`);
  const sessionId = sessionName.replace(/\.jsonl$/, "").split("_").at(-1);
  const entries = readJsonl(join(runDir, sessionName));
  const requests = readJsonl(join(runDir, "provider-requests.jsonl"));
  const batchEnd = Math.min(start + ATTRIBUTION_BATCH_ROWS, totalRows);
  const selected = (index) => index >= start && index < batchEnd;
  let rowIndex = 0;
  let emitted = 0;
  const emit = (row) => {
    process.stdout.write(`${JSON.stringify(row)}\n`);
    emitted += 1;
  };
  const variantsOf = (probe) => {
    const value = probe.expectedAnswer;
    const padded = /^\d+$/.test(value) && value.length === 1 ? [value, `0${value}`] : [value];
    // A one-or-two-digit value is a substring of half the transcript, so its
    // bare carriage means nothing. The binding is the attributable form.
    const numeric = /^\d{1,2}$/.test(value);
    const traceRow = /trace-[a-d]-0\d/.exec(String(probe.question ?? ""))?.[0] ?? null;
    const bindings = traceRow ? padded.map((item) => `${traceRow}: ${item}`) : null;
    return { values: numeric ? null : padded, bindings };
  };
  const rank = { "visible-raw": 0, "visible-brief": 1, recoverable: 2, absent: 3 };
  const best = (readings) => readings.sort(
    (a, b) => rank[a.classification] - rank[b.classification])[0];
  const label = (reading) => reading.classification === "absent" && reading.offBranchEntryIds
    ? "absent-off-branch" : reading.classification;
  let cachedLeafId = null;
  let cachedView = null;
  const attributeOne = (leafId, fact) => {
    if (leafId !== cachedLeafId) {
      const branch = attribution.branchTo(entries, leafId);
      cachedView = attribution.carriageView({
        runtime, branch, sessionId,
        stateEntryType: identity.PI_FOLD_STATE_ENTRY,
        foldRecordEntryType: identity.PI_FOLD_FOLD_RECORD_ENTRY,
        providerInputBudget: runConfig.providerInputBudget,
      });
      cachedLeafId = leafId;
    }
    return attribution.attributeFactInView({ view: cachedView, entries, fact });
  };

  for (const verdictRow of evidence.probeVerdicts ?? []) {
    const thisRow = rowIndex;
    rowIndex += 1;
    if (!selected(thisRow)) continue;
    try {
      const probe = probesById.get(verdictRow.probeId);
      if (!probe) throw new Error(`${runName}: plan has no ${verdictRow.probeId}`);
      const found = attribution.requestForAnswer({
        entries, requests, answerText: `${verdictRow.probeId}:`,
      });
      const attributeAll = (facts) => facts && label(best(
        facts.map((fact) => attributeOne(found.request.leafId, fact))));
      const { values, bindings } = variantsOf(probe);
      emit({
        runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        probeId: verdictRow.probeId, verdict: verdictRow.verdict,
        ...(found ? {
          ordinal: found.request.ordinal,
          valueCarriage: values ? attributeAll(values) : "numeric-not-attributed",
          bindingCarriage: bindings ? attributeAll(bindings) : null,
        } : { ordinal: null, valueCarriage: "no-answer-found", bindingCarriage: null }),
      });
    } catch (error) {
      // Old sealed state can carry a field the current runtime explicitly
      // retired. Name that refusal per probe; every other error stays fatal.
      if (!/retired field/.test(String(error?.message ?? error))) throw error;
      emit({
        runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        probeId: verdictRow.probeId, verdict: verdictRow.verdict,
        unreadable: String(error.message).split("\n")[0],
      });
    }
  }

  // Every withheld value is attributed at the one request that answered the
  // end block. A table question expands to one emitted row per ledger row.
  if (evidence.endBlock?.rows) {
    const questions = experiment.endBlockQuestions(plan.ledger, runConfig.querySeed);
    const verdictOf = new Map(evidence.endBlock.rows.map((row) => [row.id, row]));
    let blockRequest = null;
    for (const item of questions) {
      blockRequest = attribution.requestForAnswer({
        entries, requests, answerText: `${item.id}:`,
      });
      if (blockRequest) break;
    }
    const attributeValue = (fact) => {
      try {
        return label(attributeOne(blockRequest.request.leafId, fact));
      } catch (error) {
        if (!/retired field/.test(String(error?.message ?? error))) throw error;
        return "state-unreadable";
      }
    };
    for (const item of questions) {
      const verdictRow = verdictOf.get(item.id) ?? null;
      if (item.kind === "table") {
        for (const ledgerRow of plan.ledger.table) {
          const thisRow = rowIndex;
          rowIndex += 1;
          if (!selected(thisRow)) continue;
          const rowVerdict = verdictRow?.rows?.find((row) => row.row === ledgerRow.row) ?? null;
          emit({
            runId: runName, arm: evidence.arm, repetition: evidence.repetition,
            endBlockId: `${item.id}#${String(ledgerRow.row).padStart(2, "0")}`,
            kind: "table-row",
            verdict: rowVerdict === null ? null
              : rowVerdict.match ? "match" : rowVerdict.answered ? "mismatch" : "unanswered",
            ...(blockRequest ? {
              ordinal: blockRequest.request.ordinal,
              valueCarriage: attributeValue(ledgerRow.value),
            } : { ordinal: null, valueCarriage: "no-answer-found" }),
          });
        }
        continue;
      }
      const thisRow = rowIndex;
      rowIndex += 1;
      if (!selected(thisRow)) continue;
      const verdict = verdictRow === null ? null
        : item.kind === "checksum" ? verdictRow.verdict
        : verdictRow.recallOfRecord === null ? "unanswered"
        : verdictRow.recallOfRecord ? "recall-of-record" : "not-own-record";
      emit({
        runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        endBlockId: item.id, kind: item.kind, verdict,
        ...(blockRequest ? {
          ordinal: blockRequest.request.ordinal,
          valueCarriage: attributeValue(item.expectedAnswer),
          withdrawnCarriage: item.withdrawnAnswer === null
            ? null : attributeValue(item.withdrawnAnswer),
        } : { ordinal: null, valueCarriage: "no-answer-found", withdrawnCarriage: null }),
      });
    }
  }

  if (rowIndex !== totalRows) {
    throw new Error(`${runName}: enumerated ${rowIndex} rows, evidence declares ${totalRows}`);
  }
  const expected = batchEnd - start;
  if (emitted !== expected) {
    throw new Error(`${runName}: batch emitted ${emitted} rows, expected ${expected}`);
  }
}

const flagIndex = process.argv.indexOf(INTERNAL_BATCH_FLAG);
if (flagIndex < 0) {
  runCampaignParent();
} else {
  await runAttributionBatch(process.argv[flagIndex + 1], process.argv[flagIndex + 2]);
}
