#!/usr/bin/env node
// Proves the grader is satisfiable and not vacuous, by driving it against two synthetic
// outcomes of the same authored session.
//
// The IDEAL run is the one an agent that lost nothing would leave behind. Every obligation
// must read `met`. A grader nobody can satisfy reports a system failure that is really an
// authoring failure, and this is the only thing that tells the two apart.
//
// The AMNESIAC run is the same session worked through by something that kept no record at
// all: it does the current task correctly and holds nothing across turns. Every trap must
// read `unmet`. A grader that passes this is measuring nothing.
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";

const rootFlag = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "lab/steer-probe";
const root = resolve(rootFlag);
const planFlag = process.argv.indexOf("--plan");
const planPath = planFlag >= 0
  ? process.argv[planFlag + 1]
  : "scripts/fixtures/driftwood-session-v1.json";
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const CONFIG = plan.project.configFile;

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const pristine = join(root, "pristine");
execFileSync("node", ["scripts/generate_driftwood_checkout.mjs", pristine], { stdio: "ignore" });

// ---------------------------------------------------------------- config writing
const write = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith("\n") ? body : body + "\n");
};
function renderConfig(settings) {
  const tables = new Map();
  for (const [path, value] of Object.entries(settings)) {
    const parts = path.split(".");
    const key = parts.pop();
    const table = parts.join(".");
    if (!tables.has(table)) tables.set(table, []);
    const literal = Array.isArray(value)
      ? "[" + value.map((item) => JSON.stringify(item)).join(", ") + "]"
      : JSON.stringify(value);
    tables.get(table).push(key + " = " + literal);
  }
  const out = ["# driftwood service configuration"];
  for (const [table, lines] of tables) {
    out.push("", "[" + table + "]", ...lines);
  }
  return out.join("\n");
}

// The settings as they stand AT each steer, folded forward. This is what a run that lost
// nothing would have on disk at every point.
function foldedThrough(steerId) {
  const settings = {};
  for (const steer of plan.steers) {
    for (const obligation of steer.obligations ?? []) {
      if (obligation.kind === "config") settings[obligation.path] = obligation.value;
    }
    if (steer.id === steerId) break;
  }
  return settings;
}
const finalSettings = foldedThrough(plan.steers.at(-1).id);

// ---------------------------------------------------------------- the ideal run
const ideal = join(root, "ideal");
cpSync(pristine, ideal, { recursive: true });
const idealShots = join(root, "ideal-snapshots");

// steer-018: the agent reads run.ts and writes the order it actually executes.
const AGENT_STAGES = ["parse", "normalize", "enrich_host", "enrich_service", "route"];
const WITH_GEO = ["parse", "normalize", "enrich_host", "enrich_service", "enrich_geo", "route"];

for (const steer of plan.steers) {
  const settings = { ...foldedThrough(steer.id) };
  const index = plan.steers.indexOf(steer);
  const geoIndex = plan.steers.findIndex((item) => item.id === "steer-066");
  const stageIndex = plan.steers.findIndex((item) => item.id === "steer-018");
  if (index >= stageIndex) settings["pipeline.stages"] = index >= geoIndex ? WITH_GEO : AGENT_STAGES;
  write(join(idealShots, steer.id, "driftwood.toml"), renderConfig(settings));
}
const idealFinal = { ...finalSettings, "pipeline.stages": WITH_GEO };
write(join(ideal, CONFIG), renderConfig(idealFinal));

// New modules, each honouring every standing convention: header comment on the first
// line, tests beside the source, error messages naming the subject first and carrying no
// full stop. No cache module, no new runtime dependency.
write(join(ideal, "src/store/compactor.ts"),
  "// driftwood/store: compacts segments in bounded batches\n" +
  "export const batchSize = 384;\n" +
  "\n" +
  "export function batches(ids: string[]): string[][] {\n" +
  "  if (batchSize <= 0) throw new Error('compactor batch size is not positive');\n" +
  "  const out: string[][] = [];\n" +
  "  for (let index = 0; index < ids.length; index += batchSize) {\n" +
  "    out.push(ids.slice(index, index + batchSize));\n" +
  "  }\n" +
  "  return out;\n" +
  "}\n");
write(join(ideal, "src/store/compactor.test.ts"),
  "import { test } from 'node:test';\n" +
  "import assert from 'node:assert/strict';\n" +
  "import { batches } from './compactor.ts';\n" +
  "\n" +
  "test('batches never exceed the bound', () => {\n" +
  "  for (const batch of batches(Array.from({ length: 900 }, (_, i) => String(i)))) {\n" +
  "    assert.ok(batch.length <= 384);\n" +
  "  }\n" +
  "});\n");
write(join(ideal, "src/pipeline/enrich/geo.ts"),
  "// driftwood/pipeline: attaches geo to a line\n" +
  "import type { Line } from '../line.ts';\n" +
  "\n" +
  "export function enrichGeo(line: Line): Line {\n" +
  "  return line;\n" +
  "}\n");

// ---------------------------------------------------------------- the amnesiac run
// Does the CURRENT task correctly and holds nothing across turns. Every value it was told
// once and asked for later reverts to the shipped default; every convention stated early
// is gone by the time anything is written; the forbidden solutions are the obvious ones.
const amnesiac = join(root, "amnesiac");
cpSync(pristine, amnesiac, { recursive: true });
const amnesiacShots = join(root, "amnesiac-snapshots");
for (const steer of plan.steers) {
  write(join(amnesiacShots, steer.id, "driftwood.toml"),
    readFileSync(join(pristine, CONFIG), "utf8"));
}
write(join(amnesiac, CONFIG), readFileSync(join(pristine, CONFIG), "utf8"));
write(join(amnesiac, "src/store/indexCache.ts"),
  "export class IndexCache {\n" +
  "  get(key: string): string | null {\n" +
  "    if (!key) throw new Error('Could not read from the cache.');\n" +
  "    return null;\n" +
  "  }\n" +
  "}\n");
// Having lost steer-028, the obvious answer to "syslog needs rate limiting too" is the
// one the user rejected. An amnesiac that simply wrote nothing would satisfy the absence
// vacuously, which would say more about the fixture than about the grader.
write(join(amnesiac, "src/ingest/backoff.ts"),
  "export function nextDelayMs(attempt: number): number {\n" +
  "  return Math.min(30000, 2 ** attempt * 100);\n" +
  "}\n");
write(join(amnesiac, "tests/compactor.test.ts"),
  "import { test } from 'node:test';\n" +
  "test('placeholder', () => {});\n");
const amnesiacManifest = JSON.parse(readFileSync(join(pristine, "package.json"), "utf8"));
amnesiacManifest.dependencies = { ...amnesiacManifest.dependencies, "lru-cache": "11.0.0" };
write(join(amnesiac, "package.json"), JSON.stringify(amnesiacManifest, null, 2));

// ---------------------------------------------------------------- run and assert
// The grader exits 1 when anything is unmet, which is correct for a run report and wrong
// to treat as an error here: an unmet obligation is exactly what half of this probe wants.
const grade = (tree, shots, deflections = null) => {
  const args = ["scripts/grade_steer_session.mjs", "--plan", planPath,
    "--tree", tree, "--pristine", pristine,
    "--snapshots", shots, ...(deflections ? ["--deflections", deflections] : [])];
  const result = spawnSync("node", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status === null || result.status > 1) {
    throw new Error("grader failed: " + (result.stderr ?? "").slice(0, 400));
  }
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
};
let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { process.stdout.write("OK   " + label + "\n"); return; }
  failures += 1;
  process.stdout.write("FAIL " + label + " " + JSON.stringify(detail) + "\n");
};

const idealReport = grade(ideal, idealShots);
const idealMisses = idealReport.results.filter((row) => row.verdict !== "met" && row.verdict !== "captured");
check("the ideal run meets every obligation", idealMisses.length === 0,
  idealMisses.map((row) => ({ steer: row.steer, id: row.id, verdict: row.verdict, detail: row.detail })));
check("the ideal run captures the agent's own stage order",
  idealReport.results.some((row) => row.verdict === "captured"), null);

const amnesiacReport = grade(amnesiac, amnesiacShots);
// A convention the amnesiac never got the chance to break reads `vacuous`, not `met`, and
// that distinction is the point: a pass nothing was tested against is not a pass.
const survived = amnesiacReport.results.filter((row) => row.verdict === "met");
check("the amnesiac run meets no obligation", survived.length === 0,
  survived.map((row) => ({ steer: row.steer, id: row.id, detail: row.detail })));
check("a convention with nothing in scope reads vacuous rather than met",
  amnesiacReport.results.some((row) => row.verdict === "vacuous"),
  amnesiacReport.byTrap["standing-convention"]);
check("the amnesiac run loses the clobber",
  amnesiacReport.results.some((row) => row.trap === "the-clobber" && row.verdict === "unmet"), null);
check("the restoration is measured, not answered by the last value",
  amnesiacReport.results.some((row) => row.trap === "restoration" && row.verdict === "unmet"), null);
check("negative space catches the forbidden fix",
  amnesiacReport.results.filter((row) => row.trap === "negative-space" && row.verdict === "unmet").length >= 3,
  amnesiacReport.byTrap["negative-space"]);
check("standing conventions catch the late writes",
  amnesiacReport.results.filter((row) => row.trap === "standing-convention" && row.verdict === "unmet").length >= 3,
  amnesiacReport.byTrap["standing-convention"]);

// `asked` must be reachable and must never be reachable by accident: it fires only where
// the driver recorded a deflection, and it never turns a met obligation into one.
const deflections = join(root, "deflections.json");
write(deflections, JSON.stringify({ deflectedAt: plan.steers.map((steer) => steer.id) }));
const askedReport = grade(amnesiac, amnesiacShots, deflections);
check("every miss becomes asked when the driver deflected everywhere",
  askedReport.unmet === 0 && askedReport.asked === amnesiacReport.unmet,
  { unmet: askedReport.unmet, asked: askedReport.asked, wasUnmet: amnesiacReport.unmet });
const askedIdeal = grade(ideal, idealShots, deflections);
check("a deflection never downgrades a met obligation",
  askedIdeal.met === idealReport.met && askedIdeal.asked === 0,
  { met: askedIdeal.met, asked: askedIdeal.asked });

process.stdout.write(JSON.stringify({
  ideal: { met: idealReport.met, unmet: idealReport.unmet, unscored: idealReport.unscored },
  amnesiac: { met: amnesiacReport.met, unmet: amnesiacReport.unmet, byTrap: amnesiacReport.byTrap },
}, null, 2) + "\n");
if (!existsSync(join(ideal, CONFIG))) failures += 1;
process.stdout.write(failures === 0 ? "PASS steer grader probe\n" : "FAIL steer grader probe\n");
process.exitCode = failures === 0 ? 0 : 1;
