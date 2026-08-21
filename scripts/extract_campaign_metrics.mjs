#!/usr/bin/env node

// Lift the campaign's numbers out of the sealed corpus into one durable, portable file.
//
// The sealed run trees are not movable: their run-configs carry absolute plan paths, their
// worker reports carry absolute session files, and run-config.json is itself hash-sealed
// inside the candidate artifacts, so no rewrite survives its own seal. This reads them
// where they stand and writes a self-contained extract that has no absolute paths in it,
// so the numbers outlive the trees they came from.
//
// It refuses a corpus that was adjudicated by more than one adjudicator, on the same rule
// the grader applies: a pooled number means nothing unless every run behind it was
// measured the same way. Re-adjudicate first.
//
//   node scripts/extract_campaign_metrics.mjs --corpus <dir> --out <file.json>

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertExperiment } from "./lib/pi_context_experiment.mjs";
import { readJson, sha256Json } from "./lib/pi_context_soak_attestation.mjs";

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

/** Every adjudicated run under a corpus root, newest adjudicator sidecar preferred. */
function collectRuns(corpusRoot) {
  const runs = [];
  for (const campaign of readdirSync(corpusRoot).sort()) {
    const runsDir = join(corpusRoot, campaign, "runs");
    if (!existsSync(runsDir)) continue;
    // The runs directory also holds supervisor logs, so only descend into directories.
    for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (!entry.isDirectory()) continue;
      const runDir = join(runsDir, entry.name);
      const sidecars = readdirSync(runDir)
        .filter((f) => /^experiment-evidence\.[0-9a-f]{8}\.json$/.test(f)).sort();
      const path = sidecars.length
        ? join(runDir, sidecars[sidecars.length - 1])
        : join(runDir, "experiment-evidence.json");
      if (!existsSync(path)) continue;
      runs.push(readJson(path));
    }
  }
  return runs;
}

/**
 * One run, reduced to what a write-up or a re-analysis actually needs. Absolute paths are
 * deliberately dropped: runDir and evidencePath name a machine, and the run id plus the
 * evidence hashes already identify the run uniquely.
 */
function extractRun(run) {
  const counterfactual = run.contextEvents?.counterfactual ?? null;
  return {
    runId: run.runId,
    campaignId: run.campaignId,
    arm: run.arm,
    repetition: run.repetition,
    mode: run.mode,
    condition: {
      guidance: run.guidance,
      foldScheduling: run.foldScheduling,
      foldPeekResults: run.foldPeekResults,
      guidedCuration: run.guidedCuration,
      providerInputBudget: run.providerInputBudget,
      transport: run.transport,
    },
    workload: run.workload ?? null,
    usage: run.usage
      ? {
        requests: run.usage.requests,
        inputFresh: run.usage.inputFresh,
        cacheRead: run.usage.cacheRead,
        cacheWrite: run.usage.cacheWrite,
        output: run.usage.output,
        reasoning: run.usage.reasoning,
        totalTokens: run.usage.totalTokens,
        wallClockMs: run.usage.wallClockMs,
        meanCacheShare: run.usage.meanCacheShare,
        pooledCacheShare: run.usage.pooledCacheShare,
        mutations: run.usage.mutations,
      }
      : null,
    // The two-lens convention: the raw wire share beside the mechanism-limited
    // counterfactual, so a wire epoch can never be mistaken for a property of folding.
    contextEvents: run.contextEvents
      ? {
        events: run.contextEvents.events,
        byKind: run.contextEvents.byKind,
        prefixEvents: run.contextEvents.prefixEvents,
        prefixRewrites: run.contextEvents.prefixRewrites,
        structuralRewrites: run.contextEvents.structuralRewrites,
        surfaceRewrites: run.contextEvents.surfaceRewrites,
        commits: run.contextEvents.commits,
        folds: run.contextEvents.folds,
        counterfactualPooledCacheShare: counterfactual?.pooledCacheShare ?? null,
        counterfactualByRequestClass: counterfactual?.byRequestClass ?? null,
        observedCacheByRequestClass: run.contextEvents.observedCache?.byRequestClass ?? null,
        // Pre-steward evidence carries no lens; null distinguishes "not measured"
        // from a measured zero-crossing session.
        steward: run.contextEvents.steward ?? null,
      }
      : null,
    rereadTax: run.rereadTax ?? null,
    stopTheWorld: run.stopTheWorld ?? null,
    curation: run.curation ?? null,
    // The outcome lenses the steward paper reads beside the cache tables: the
    // adjudicator's graded probe verdicts, the graded end-block rows, and the
    // billed dollars, carried whole so the portable corpus is the one source.
    probeVerdicts: run.probeVerdicts ?? null,
    endBlock: run.endBlock ?? null,
    billed: run.billed ?? null,
    thinkTime: run.thinkTime ? { medianMs: run.thinkTime.medianMs, p95Ms: run.thinkTime.p95Ms, maxMs: run.thinkTime.maxMs } : null,
    overflowPoint: run.overflowPoint ?? null,
    probes: run.probes ?? [],
    deliverables: (run.deliverables ?? []).map((d) => ({ id: d.id, textSha256: d.textSha256 ?? null })),
    // Kept so a reader can re-verify against the sealed tree if it still exists.
    evidence: run.evidence ?? null,
  };
}

const corpus = resolve(argumentValue("--corpus") ?? "");
const out = resolve(argumentValue("--out") ?? "");
assertExperiment(existsSync(corpus), `No corpus at ${corpus}`);
assertExperiment(out.endsWith(".json"), "--out must be a .json path");

const runs = collectRuns(corpus);
assertExperiment(runs.length > 0, `No adjudicated runs under ${corpus}`);

const adjudicators = new Set(runs.map((run) => run.evidence?.adjudicatorSourceSha256));
assertExperiment(adjudicators.size === 1,
  `Corpus mixes adjudicator versions (${[...adjudicators].map((s) => String(s).slice(0, 8)).sort().join(", ")}); ` +
  "re-adjudicate every run under one adjudicator before extracting");

const extracted = runs.map(extractRun);
const payload = {
  version: 1,
  corpusLabel: basename(corpus),
  adjudicatorSourceSha256: [...adjudicators][0],
  runCount: extracted.length,
  campaigns: [...new Set(extracted.map((r) => r.campaignId))].sort(),
  arms: [...new Set(extracted.map((r) => r.arm))].sort(),
  runs: extracted,
};
payload.extractSha256 = sha256Json(payload);
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({
  runs: payload.runCount,
  campaigns: payload.campaigns,
  arms: payload.arms,
  adjudicator: payload.adjudicatorSourceSha256.slice(0, 8),
  extractSha256: payload.extractSha256.slice(0, 16),
  out,
}, null, 2)}\n`);
