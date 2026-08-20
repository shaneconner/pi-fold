// Build 4 Step 0: the offline brief-function study. For every probe fact in a
// sealed campaign that sits inside folded source at end of run, ask which brief
// FUNCTIONS would have carried the fact into their brief, under the one policy
// cap that governs every real brief. No provider is contacted; everything is
// read from sealed artifacts and the runtime's own state materialization.
//
//   node scripts/probe_brief_function_carriage.mjs <campaign-dir> [<campaign-dir> ...]
//
// The shipped baseline is the ACTUAL brief each fold carries in sealed state
// (runtime.foldBrief), so the study's anchor is what really ran, not a
// reimplementation. Candidate functions are GENERIC text heuristics only: the
// anti-overfit guard below refuses any candidate whose source mentions the
// seeded vocabulary or ledger shapes, because a matcher tuned to what the
// harness plants would score perfectly and mean nothing (Shane, 2026-08-20).
// Results are reported separately for seeded ledger facts and natural repo
// facts for the same reason. Survival is judged under the runtime's own
// end-of-run VISIBILITY rule (projectionCarriers): a collapsed fold shows its
// own brief and a hidden child's brief carries nothing, so a fact that only a
// consolidated-away child brief held reads as not carried, exactly as the
// projection would render it. The first draft counted any brief on the fold
// chain and read 94 to 100 percent; the visible rule reads 43 percent natural
// and ZERO seeded, and the gap is consolidation dilution, not extraction.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = "--study-run";
const OUT_DIR = join(PROJECT, "lab", "build4-step0");
const OUT_FILE = join(OUT_DIR, "brief-function-study.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readJsonl = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

// ---------------------------------------------------------------------------
// Candidate brief functions. Each takes the fold's claimed entries in span
// order as [{role, text}] plus a byte budget, and returns one brief string.
// Generic heuristics only; see the guard below.

function capJoin(pieces, cap) {
  const kept = [];
  let used = 0;
  for (const piece of pieces) {
    const text = piece.trim();
    if (!text) continue;
    if (used + text.length + 1 > cap) {
      if (!kept.length) kept.push(text.slice(0, cap));
      break;
    }
    kept.push(text);
    used += text.length + 1;
  }
  return kept.join("\n");
}

/** The last assistant message in the span, whole, capped. */
function lastAssistant(entries, cap) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].role === "assistant" && entries[index].text.trim()) {
      return entries[index].text.trim().slice(0, cap);
    }
  }
  return "";
}

/** Every assistant message's head, 160 chars each, span order. */
function assistantNotes(entries, cap) {
  return capJoin(
    entries.filter((entry) => entry.role === "assistant")
      .map((entry) => entry.text.trim().slice(0, 160)),
    cap);
}

/** First and last paragraph of every claimed entry, span order. */
function headTail(entries, cap) {
  const pieces = [];
  for (const entry of entries) {
    const paragraphs = entry.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (!paragraphs.length) continue;
    pieces.push(paragraphs[0]);
    if (paragraphs.length > 1) pieces.push(paragraphs[paragraphs.length - 1]);
  }
  return capJoin(pieces, cap);
}

/** Sentences ranked by rare-token density against the whole session. */
function salience(entries, cap, documentFrequency, documentCount) {
  const sentences = [];
  for (const entry of entries) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+|\n+/)) {
      const trimmed = sentence.trim();
      if (trimmed.length < 20 || trimmed.length > 400) continue;
      const tokens = trimmed.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [];
      if (!tokens.length) continue;
      const score = tokens.reduce((sum, token) =>
        sum + Math.log(documentCount / (1 + (documentFrequency.get(token) ?? 0))), 0) / tokens.length;
      sentences.push({ trimmed, score, order: sentences.length });
    }
  }
  const chosen = [...sentences].sort((a, b) => b.score - a.score);
  const kept = [];
  let used = 0;
  for (const sentence of chosen) {
    if (used + sentence.trimmed.length + 1 > cap) continue;
    kept.push(sentence);
    used += sentence.trimmed.length + 1;
  }
  return kept.sort((a, b) => a.order - b.order).map((s) => s.trimmed).join("\n");
}

/** Lines dense in identifier-shaped or numeric tokens, span order. */
function dataLines(entries, cap) {
  const pieces = [];
  for (const entry of entries) {
    for (const line of entry.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 300) continue;
      const dataTokens = trimmed.match(/\b(?=\w*\d)[\w./-]{4,}\b|\b\d{2,}\b/g) ?? [];
      if (dataTokens.length >= 1) pieces.push(trimmed);
    }
  }
  return capJoin(pieces, cap);
}

const CANDIDATES = { lastAssistant, assistantNotes, headTail, salience, dataLines };

// The anti-overfit guard: a candidate that names the seeded vocabulary or the
// ledger's shapes is measuring the harness, not a brief function. The literals
// are assembled at runtime so the guard does not trip on its own definition.
const FORBIDDEN = ["lv" + "-", "cw" + "-", "led" + "ger", "trace" + "-a", "reconstruction " + "table"];
for (const [name, fn] of Object.entries(CANDIDATES)) {
  const body = fn.toString().toLowerCase();
  for (const literal of FORBIDDEN) {
    if (body.includes(literal)) {
      throw new Error(`candidate ${name} references seeded shape "${literal}"; the study refuses it`);
    }
  }
}

// ---------------------------------------------------------------------------
// Fact collection: natural repo probes and seeded ledger values, kept apart.

function factVariants(value) {
  const padded = /^\d+$/.test(value) && value.length === 1 ? [value, `0${value}`] : [value];
  return padded;
}

function collectFacts(plan) {
  const facts = [];
  const probes = [];
  const walk = (node) => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    const id = node.probeId ?? node.id;
    if (typeof id === "string" && id.startsWith("probe-") &&
        typeof node.expectedAnswer === "string" && !probes.some((p) => (p.probeId ?? p.id) === id)) {
      probes.push(node);
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(plan);
  for (const probe of probes) {
    const value = probe.expectedAnswer;
    // A one-or-two-digit value is a substring of half the transcript; its bare
    // carriage means nothing, so the study binds it to its trace row exactly
    // as the carriage sweep does, and skips it when no binding exists.
    if (/^\d{1,2}$/.test(value)) {
      const traceRow = /trace-[a-d]-0\d/.exec(String(probe.question ?? ""))?.[0] ?? null;
      if (!traceRow) continue;
      facts.push({ factId: probe.probeId ?? probe.id, factClass: "natural", kind: "probe",
        variants: factVariants(value).map((v) => `${traceRow}: ${v}`) });
      continue;
    }
    facts.push({ factId: probe.probeId ?? probe.id, factClass: "natural", kind: "probe",
      variants: factVariants(value) });
  }
  const ledger = plan.ledger ?? {};
  for (const row of ledger.table ?? []) {
    facts.push({ factId: `table-row-${row.row}`, factClass: "seeded", kind: "table-row",
      variants: [row.value] });
  }
  for (const single of ledger.singles ?? []) {
    facts.push({ factId: single.id, factClass: "seeded", kind: "checksum", variants: [single.value] });
  }
  for (const joinFact of ledger.joins ?? []) {
    facts.push({ factId: joinFact.id, factClass: "seeded", kind: "join",
      variants: [joinFact.expectedAnswer] });
  }
  for (const correction of ledger.corrections ?? []) {
    facts.push({ factId: correction.id, factClass: "seeded", kind: "correction",
      variants: [correction.value] });
  }
  return facts;
}

// ---------------------------------------------------------------------------

async function runChild(campaignDir, runName) {
  const attribution = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_attribution.mjs")));
  const { createJiti } = await import(
    pathToFileURL(join(PROJECT, "node_modules", "jiti", "lib", "jiti.mjs")));
  const runtime = await createJiti(import.meta.url)
    .import(join(PROJECT, "extensions", "active-context.ts"));
  const policy = await createJiti(import.meta.url)
    .import(join(PROJECT, "extensions", "lib", "policy.ts"));
  const identity = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_fold_identity.mjs")));
  const experiment = await import(
    pathToFileURL(join(PROJECT, "scripts", "lib", "pi_context_experiment.mjs")));

  const cap = policy.ACTIVE_CONTEXT_POLICY.maxBriefChars;
  const runDir = join(campaignDir, "runs", runName);
  const evidence = readJson(join(runDir, "experiment-evidence.json"));
  const plan = readJson(experiment.campaignPlanPath(campaignDir));
  const harnessJsonl = new Set([
    "provider-requests.jsonl", "pace.jsonl", "heartbeats.jsonl", "failure-latch.jsonl",
    "tool-results.jsonl", "worker-events.jsonl",
  ]);
  const sessionName = readdirSync(runDir).sort().find((name) =>
    name.endsWith(".jsonl") && !harnessJsonl.has(name));
  if (!sessionName) throw new Error(`${runName}: no session file`);
  const sessionId = sessionName.replace(/\.jsonl$/, "").split("_").at(-1);
  const runConfig = readJson(join(runDir, "run-config.json"));
  const entries = readJsonl(join(runDir, sessionName));
  const leaf = [...entries].reverse().find((entry) => entry?.id);
  const branch = attribution.branchTo(entries, leaf.id);
  const { state } = runtime.materializeStatePersistence(
    branch, sessionId, identity.PI_FOLD_STATE_ENTRY, identity.PI_FOLD_FOLD_RECORD_ENTRY);
  // Visibility under the real projection rule at end of run: a collapsed fold
  // shows its own brief; a revealed parent shows its children's positions. The
  // runtime's own carrier walk decides, so a fact inside a hidden child's
  // brief does not read as carried the way the naive fold-chain reading did
  // (every ancestor of a carrying entry claimed it, inflating carriers to the
  // chain depth).
  const eventMessages = branch.flatMap((entry) => runtime.sessionEntryMessages(entry));
  const snapshot = runtime.mapActiveContext({
    sessionId, eventMessages, contextEntries: branch,
    ...(Number.isFinite(runConfig.providerInputBudget) && runConfig.providerInputBudget > 0
      ? { contextWindow: runConfig.providerInputBudget, netBudget: true } : {}),
  });
  const visibleBriefIds = new Set(
    attribution.projectionCarriers({ runtime, state, snapshot }).visibleBriefs
      .map((item) => item.foldId));

  const byId = new Map(branch.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const spanOf = (fold) => runtime.flattenFoldRefs(fold, state)
    .map((ref) => byId.get(ref.entryId)).filter(Boolean)
    .map((entry) => ({ role: entry.message?.role ?? entry.type ?? "", text: attribution.entryText(entry) }));

  // Document frequency over the whole branch, for the salience candidate.
  const documentFrequency = new Map();
  for (const entry of branch) {
    const tokens = new Set(attribution.entryText(entry).toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? []);
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const folds = state.folds.filter((fold) => visibleBriefIds.has(fold.id)).map((fold) => {
    const span = spanOf(fold);
    const sourceText = span.map((part) => part.text).join("\n");
    const briefs = { shipped: String(runtime.foldBrief(fold, state) ?? "") };
    for (const [name, fn] of Object.entries(CANDIDATES)) {
      briefs[name] = name === "salience"
        ? fn(span, cap, documentFrequency, branch.length)
        : fn(span, cap);
    }
    return { id: fold.id, kind: fold.kind, sourceText, briefs };
  });

  const rows = [];
  const entriesCarrying = (fact) => branch.filter((entry) =>
    fact.variants.some((variant) => attribution.entryText(entry).includes(variant))).length;
  for (const fact of collectFacts(plan)) {
    const carriers = folds.filter((fold) =>
      fact.variants.some((variant) => fold.sourceText.includes(variant)));
    const survival = {};
    const briefChars = {};
    for (const name of ["shipped", ...Object.keys(CANDIDATES)]) {
      survival[name] = carriers.some((fold) =>
        fact.variants.some((variant) => fold.briefs[name].includes(variant)));
    }
    for (const name of ["shipped", ...Object.keys(CANDIDATES)]) {
      briefChars[name] = carriers.reduce((sum, fold) => sum + fold.briefs[name].length, 0);
    }
    rows.push({
      runId: runName, arm: evidence.arm, repetition: evidence.repetition,
      ...fact, variants: undefined,
      inFoldedSource: carriers.length > 0, foldCount: carriers.length,
      entryCount: entriesCarrying(fact),
      survival: carriers.length ? survival : null,
      briefChars: carriers.length ? briefChars : null,
    });
  }
  process.stdout.write(JSON.stringify({ runName, foldCount: state.folds.length, cap, rows }));
}

function runParent(campaignDirs) {
  const perRun = [];
  for (const campaignDir of campaignDirs) {
    const runsDir = join(campaignDir, "runs");
    if (!existsSync(runsDir)) throw new Error(`campaign has no runs directory: ${campaignDir}`);
    for (const entry of readdirSync(runsDir, { withFileTypes: true })
      .filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const evidencePath = join(runsDir, entry.name, "experiment-evidence.json");
      if (!existsSync(evidencePath)) continue;
      if (readJson(evidencePath).arm !== "pifold") continue;
      const child = spawnSync(process.execPath, [SCRIPT, campaignDir, CHILD_FLAG, entry.name],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (child.error) throw child.error;
      if (child.status !== 0) {
        throw new Error(`study child failed for ${entry.name}: ${child.stderr.trim() || child.status}`);
      }
      perRun.push({ campaign: basename(campaignDir), ...JSON.parse(child.stdout) });
      process.stderr.write(`studied ${entry.name}: ${JSON.parse(child.stdout).rows.length} facts\n`);
    }
  }

  const candidates = ["shipped", ...Object.keys(CANDIDATES)];
  const table = {};
  for (const factClass of ["natural", "seeded"]) {
    table[factClass] = {};
    const rows = perRun.flatMap((run) => run.rows)
      .filter((row) => row.factClass === factClass && row.inFoldedSource);
    for (const name of candidates) {
      const carried = rows.filter((row) => row.survival[name]).length;
      const chars = rows.reduce((sum, row) => sum + row.briefChars[name], 0);
      table[factClass][name] = {
        carried, of: rows.length,
        share: rows.length ? Number((carried / rows.length).toFixed(3)) : null,
        meanBriefChars: rows.length ? Math.round(chars / rows.length) : null,
      };
    }
  }
  const allRows = perRun.flatMap((run) => run.rows);
  const payload = {
    generatedFor: "build4-step0",
    campaigns: campaignDirs.map((dir) => basename(dir)),
    runs: perRun.map(({ campaign, runName, foldCount, cap }) => ({ campaign, runName, foldCount, cap })),
    factCounts: {
      total: allRows.length,
      inFoldedSource: allRows.filter((row) => row.inFoldedSource).length,
      notInFoldedSource: allRows.filter((row) => !row.inFoldedSource).length,
    },
    candidateNote: "survival = a VISIBLE fold (the runtime's own end-of-run carrier walk) " +
      "would carry the fact in its brief; identical rule for every candidate. Generality: lastAssistant and " +
      "assistantNotes read only what the agent chose to say; headTail is positional; salience " +
      "is corpus-statistical; dataLines favors identifier-dense lines and misses prose facts.",
    table,
    rows: allRows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`\n=== brief-function carriage (facts found in folded source) ===\n`);
  for (const factClass of ["natural", "seeded"]) {
    process.stdout.write(`${factClass}:\n`);
    for (const name of candidates) {
      const cell = table[factClass][name];
      process.stdout.write(`  ${name.padEnd(15)} ${String(cell.carried).padStart(3)}/${cell.of}` +
        `  share=${cell.share}  meanBriefChars=${cell.meanBriefChars}\n`);
    }
  }
  process.stdout.write(`written: ${OUT_FILE}\n`);
}

const args = process.argv.slice(2);
const childIndex = args.indexOf(CHILD_FLAG);
if (childIndex >= 0) {
  await runChild(args[0], args[childIndex + 1]);
} else {
  if (!args.length) {
    process.stderr.write("usage: node scripts/probe_brief_function_carriage.mjs <campaign-dir> ...\n");
    process.exit(2);
  }
  runParent(args);
}
