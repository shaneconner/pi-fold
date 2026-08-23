#!/usr/bin/env node
// Measures what a real native compaction DROPPED, from sessions that already happened.
//
//   node scripts/analyze_compaction_loss.mjs <session.jsonl> [--json out.json]
//
// WHY THIS NEEDS NO RUN. Compaction records a cut point (`firstKeptEntryId`) and a summary;
// it does NOT delete. So every session that ever compacted still holds both halves: the raw
// material that left the window, and the text that replaced it. The question "what does
// summarization lose" is therefore arithmetic over sessions already on disk, not an
// experiment to be staged, and it is free of the two problems that sank every staged
// version: nothing here was authored for a test, so there is no test-awareness, and nothing
// is graded from prose, so there is no judge.
//
// THE SPAN IS BETWEEN CONSECUTIVE COMPACTIONS. Compaction k replaces everything before its
// cut, but the material before compaction k-1 was already represented by summary k-1. What
// compaction k newly had to absorb is the span between them, so that is what its summary is
// held to.
//
// LITERALS, NOT MEANING. A path, a numeric constant or an identifier either occurs in the
// summary or it does not, and that is decidable without a model. Prose paraphrase is exactly
// what a judge would be needed for, so it is not counted either way: this measures carriage
// of the things later work has to name exactly, which is the class pi-fold claims to keep.
import { createReadStream, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { entryContextText, extractLiterals, LITERAL_KINDS } from "./lib/transcript_literals.mjs";

const sessionPath = process.argv[2];
if (!sessionPath) {
  process.stderr.write("usage: analyze_compaction_loss.mjs <session.jsonl> [--json out]\n");
  process.exit(2);
}
const jsonIndex = process.argv.indexOf("--json");
const jsonOut = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

// The three literal classes live in scripts/lib/transcript_literals.mjs, because the fold
// counterfactual judges carriage by the same ones and the two results are only comparable
// while they are counting the same things.
const extract = extractLiterals;

const textOf = entryContextText;

const boundaries = [];
let span = { path: new Set(), identifier: new Set(), number: new Set() };
let spanChars = 0;
let spanMessages = 0;

const reader = createInterface({
  input: createReadStream(sessionPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});
for await (const line of reader) {
  if (!line.trim()) continue;
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }

  if (entry.type === "compaction") {
    const summary = String(entry.summary ?? "");
    const kept = extract(summary);
    const row = { index: boundaries.length + 1, spanMessages, spanChars,
      summaryChars: summary.length, tokensBefore: entry.tokensBefore ?? null,
      costUsd: entry.usage?.cost?.total ?? null, classes: {} };
    for (const kind of LITERAL_KINDS) {
      const dropped = span[kind];
      const survived = [...dropped].filter((value) => kept[kind].has(value)).length;
      row.classes[kind] = {
        dropped: dropped.size,
        survived,
        rate: dropped.size === 0 ? null : survived / dropped.size,
      };
    }
    boundaries.push(row);
    span = { path: new Set(), identifier: new Set(), number: new Set() };
    spanChars = 0;
    spanMessages = 0;
    continue;
  }
  if (entry.type !== "message") continue;
  const text = textOf(entry);
  spanChars += text.length;
  spanMessages += 1;
  const found = extract(text);
  for (const kind of LITERAL_KINDS) for (const value of found[kind]) span[kind].add(value);
}

const rate = (kind) => {
  const rows = boundaries.filter((row) => row.classes[kind].rate !== null);
  if (rows.length === 0) return null;
  const dropped = rows.reduce((total, row) => total + row.classes[kind].dropped, 0);
  const survived = rows.reduce((total, row) => total + row.classes[kind].survived, 0);
  return { dropped, survived, rate: survived / dropped };
};

const report = {
  session: sessionPath,
  boundaries: boundaries.length,
  totalCostUsd: boundaries.reduce((total, row) => total + (row.costUsd ?? 0), 0),
  overall: Object.fromEntries(LITERAL_KINDS.map((kind) => [kind, rate(kind)])),
  perBoundary: boundaries,
};
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`${sessionPath}\n`);
process.stdout.write(`boundaries ${report.boundaries}, compaction cost $${report.totalCostUsd.toFixed(2)}\n\n`);
process.stdout.write("class        distinct dropped   survived in summary   carriage\n");
for (const [kind, value] of Object.entries(report.overall)) {
  if (!value) continue;
  process.stdout.write(`${kind.padEnd(12)}${String(value.dropped).padStart(16)}` +
    `${String(value.survived).padStart(22)}${(`${(100 * value.rate).toFixed(1)}%`).padStart(11)}\n`);
}
