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
// rollup per arm. Numeric answers are also tried zero-padded because the
// workload's agents write stage numbers both ways, and a carriage claim that
// misses a format is a false absence.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const campaignDir = process.argv[2];
if (!campaignDir) {
  process.stderr.write("usage: node scripts/attribute_probe_carriage.mjs <campaign-dir>\n");
  process.exit(2);
}

const { createJiti } = await import(pathToFileURL(join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs")));
const runtime = await createJiti(import.meta.url).import(join(PROJECT, "extensions", "active-context.ts"));
const attribution = await import(pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
const identity = await import(pathToFileURL(join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
const experiment = await import(pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));

const readJsonl = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const plan = JSON.parse(readFileSync(join(campaignDir, "stages-full.json"), "utf8"));
const probesById = new Map();
const collect = (node) => {
  if (Array.isArray(node)) { for (const item of node) collect(item); return; }
  if (!node || typeof node !== "object") return;
  const id = node.probeId ?? node.id;
  if (typeof id === "string" && id.startsWith("probe-") && typeof node.expectedAnswer === "string" &&
    !probesById.has(id)) probesById.set(id, node);
  for (const value of Object.values(node)) collect(value);
};
collect(plan);

const HARNESS_JSONL = new Set(["provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl",
  "failure-latch.jsonl", "tool-results.jsonl", "worker-events.jsonl"]);
const variantsOf = (probe) => {
  const value = probe.expectedAnswer;
  const padded = /^\d+$/.test(value) && value.length === 1 ? [value, `0${value}`] : [value];
  // A one-or-two-digit value is a substring of half the transcript, so its bare
  // carriage means nothing; the binding is the only attributable form and the
  // value column says so instead of reporting a vacuous visible-raw.
  const numeric = /^\d{1,2}$/.test(value);
  const row = /trace-[a-d]-0\d/.exec(String(probe.question ?? ""))?.[0] ?? null;
  const bindings = row ? padded.map((item) => `${row}: ${item}`) : null;
  return { values: numeric ? null : padded, bindings, row };
};
const RANK = { "visible-raw": 0, "visible-brief": 1, recoverable: 2, absent: 3 };
const best = (readings) => readings.sort((a, b) => RANK[a.classification] - RANK[b.classification])[0];

const rollup = new Map();
for (const runName of readdirSync(join(campaignDir, "runs")).sort()) {
  const runDir = join(campaignDir, "runs", runName);
  const evidencePath = join(runDir, "experiment-evidence.json");
  if (!existsSync(evidencePath)) continue;
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const sessionName = readdirSync(runDir).find((name) =>
    name.endsWith(".jsonl") && !HARNESS_JSONL.has(name));
  if (!sessionName) { process.stderr.write(`${runName}: no session file\n`); continue; }
  const sessionId = sessionName.replace(/\.jsonl$/, "").split("_").at(-1);
  const entries = readJsonl(join(runDir, sessionName));
  const requests = readJsonl(join(runDir, "provider-requests.jsonl"));
  for (const verdictRow of evidence.probeVerdicts ?? []) {
    try {
      const probe = probesById.get(verdictRow.probeId);
      if (!probe) continue;
      const found = attribution.requestForAnswer({
        entries, requests, answerText: `${verdictRow.probeId}:`,
      });
      const label = (reading) => reading.classification === "absent" && reading.offBranchEntryIds
        ? "absent-off-branch" : reading.classification;
      const attributeAll = (facts) => facts && label(best(facts.map((fact) => attribution.attributeFactInSession({
        runtime, entries, sessionId, leafId: found.request.leafId, fact,
        stateEntryType: identity.PI_FOLD_STATE_ENTRY,
        foldRecordEntryType: identity.PI_FOLD_FOLD_RECORD_ENTRY,
      }))));
      const { values, bindings } = variantsOf(probe);
      const row = {
        runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        probeId: verdictRow.probeId, verdict: verdictRow.verdict,
        ...(found ? {
          ordinal: found.request.ordinal,
          valueCarriage: values ? attributeAll(values) : "numeric-not-attributed",
          bindingCarriage: bindings ? attributeAll(bindings) : null,
        } : { ordinal: null, valueCarriage: "no-answer-found", bindingCarriage: null }),
      };
      process.stdout.write(`${JSON.stringify(row)}\n`);
      const key = `${evidence.arm}-rep${evidence.repetition} ${verdictRow.verdict} ${row.valueCarriage}` +
        (row.bindingCarriage ? ` binding:${row.bindingCarriage}` : "");
      rollup.set(key, (rollup.get(key) ?? 0) + 1);
    } catch (error) {
      // The runtime refuses to load a state written by a build carrying retired
      // fields, and a branch that reaches such a record is unreadable by law.
      // The refusal stands; the sweep's duty is to NAME each probe it therefore
      // cannot attribute instead of thinning coverage quietly. Anything else
      // rethrows: a sweep that swallowed unknown errors would report absences
      // it never checked.
      if (!/retired field/.test(String(error?.message ?? error))) throw error;
      const note = { runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        probeId: verdictRow.probeId, verdict: verdictRow.verdict,
        unreadable: String(error.message).split("\n")[0] };
      process.stdout.write(`${JSON.stringify(note)}\n`);
      const key = `${evidence.arm}-rep${evidence.repetition} ${verdictRow.verdict} state-unreadable`;
      rollup.set(key, (rollup.get(key) ?? 0) + 1);
    }
  }
  // THE END BLOCK'S HIDDENNESS CERTIFICATION (task #79 build 3): every withheld
  // query's expected value attributed at the request that answered the end
  // block, so a value that was VISIBLE at answer time is reported beside the
  // verdict rather than letting a match read as recall. Runs sealed before the
  // instrument carry no endBlock and are skipped: there is nothing to certify.
  if (evidence.endBlock?.rows) {
    const runConfig = JSON.parse(readFileSync(join(runDir, "run-config.json"), "utf8"));
    const plan = JSON.parse(readFileSync(runConfig.planPath, "utf8"));
    const questions = experiment.endBlockQuestions(plan.ledger, runConfig.querySeed);
    const verdictOf = new Map(evidence.endBlock.rows.map((row) => [row.id, row]));
    // One answering request for the whole block: the first end-block id that
    // resolves locates it, and every value is attributed at that request.
    let blockRequest = null;
    for (const item of questions) {
      blockRequest = attribution.requestForAnswer({
        entries, requests, answerText: `${item.id}:`,
      });
      if (blockRequest) break;
    }
    const attributeValue = (fact) => {
      try {
        const reading = attribution.attributeFactInSession({
          runtime, entries, sessionId, leafId: blockRequest.request.leafId, fact,
          stateEntryType: identity.PI_FOLD_STATE_ENTRY,
          foldRecordEntryType: identity.PI_FOLD_FOLD_RECORD_ENTRY,
        });
        return reading.classification === "absent" && reading.offBranchEntryIds
          ? "absent-off-branch" : reading.classification;
      } catch (error) {
        if (!/retired field/.test(String(error?.message ?? error))) throw error;
        return "state-unreadable";
      }
    };
    for (const item of questions) {
      const verdictRow = verdictOf.get(item.id) ?? null;
      if (item.kind === "table") {
        for (const entry of plan.ledger.table) {
          const rowVerdict = verdictRow?.rows?.find((row) => row.row === entry.row) ?? null;
          const row = {
            runId: runName, arm: evidence.arm, repetition: evidence.repetition,
            endBlockId: `${item.id}#${String(entry.row).padStart(2, "0")}`, kind: "table-row",
            verdict: rowVerdict === null ? null
              : rowVerdict.match ? "match" : rowVerdict.answered ? "mismatch" : "unanswered",
            ...(blockRequest ? {
              ordinal: blockRequest.request.ordinal,
              valueCarriage: attributeValue(entry.value),
            } : { ordinal: null, valueCarriage: "no-answer-found" }),
          };
          process.stdout.write(`${JSON.stringify(row)}\n`);
          const key = `${evidence.arm}-rep${evidence.repetition} end:table-row ` +
            `${row.verdict} ${row.valueCarriage}`;
          rollup.set(key, (rollup.get(key) ?? 0) + 1);
        }
        continue;
      }
      const verdict = verdictRow === null ? null
        : item.kind === "checksum" ? verdictRow.verdict
        : verdictRow.recallOfRecord === null ? "unanswered"
        : verdictRow.recallOfRecord ? "recall-of-record" : "not-own-record";
      const row = {
        runId: runName, arm: evidence.arm, repetition: evidence.repetition,
        endBlockId: item.id, kind: item.kind, verdict,
        ...(blockRequest ? {
          ordinal: blockRequest.request.ordinal,
          valueCarriage: attributeValue(item.expectedAnswer),
          withdrawnCarriage: item.withdrawnAnswer === null
            ? null : attributeValue(item.withdrawnAnswer),
        } : { ordinal: null, valueCarriage: "no-answer-found", withdrawnCarriage: null }),
      };
      process.stdout.write(`${JSON.stringify(row)}\n`);
      const key = `${evidence.arm}-rep${evidence.repetition} end:${item.kind} ` +
        `${row.verdict} ${row.valueCarriage}` +
        (row.withdrawnCarriage ? ` withdrawn:${row.withdrawnCarriage}` : "");
      rollup.set(key, (rollup.get(key) ?? 0) + 1);
    }
  }
}
process.stdout.write("=== rollup (arm-rep verdict value-carriage [binding-carriage]: count) ===\n");
for (const [key, count] of [...rollup.entries()].sort()) {
  process.stdout.write(`${key}: ${count}\n`);
}
