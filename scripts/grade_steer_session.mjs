#!/usr/bin/env node
// Grades a finished steer-protocol run. Reads the tree the agent left behind and the
// per-steer config snapshots the driver wrote, and produces one verdict per obligation.
// Nothing here parses prose. The one judgement that is not a file comparison, `asked`,
// comes from a structural signal the driver recorded, never from reading a message.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, basename, dirname } from "node:path";

const argumentValue = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const planPath = argumentValue("--plan", "scripts/fixtures/driftwood-session-v1.json");
const treeDir = argumentValue("--tree");
const pristineDir = argumentValue("--pristine");
const snapshotDir = argumentValue("--snapshots");
const deflectionPath = argumentValue("--deflections");
if (!treeDir || !pristineDir) {
  process.stderr.write("usage: grade_steer_session.mjs --tree <dir> --pristine <dir> " +
    "[--snapshots <dir>] [--deflections <file>] [--plan <file>]\n");
  process.exit(2);
}
const plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));

// ---------------------------------------------------------------- toml, the same subset
function scalar(raw) {
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner ? inner.split(",").map((part) => scalar(part)) : [];
  }
  const quote = String.fromCharCode(34);
  if (text.startsWith(quote) && text.endsWith(quote)) return text.slice(1, -1);
  if (text === "true") return true;
  if (text === "false") return false;
  const numeric = Number(text);
  return Number.isNaN(numeric) ? text : numeric;
}
function readToml(source) {
  const root = {};
  let table = root;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      table = root;
      for (const part of line.slice(1, -1).split(".")) {
        if (typeof table[part] !== "object" || table[part] === null) table[part] = {};
        table = table[part];
      }
      continue;
    }
    const split = line.indexOf("=");
    if (split < 0) continue;
    table[line.slice(0, split).trim()] = scalar(line.slice(split + 1));
  }
  return root;
}
const at = (object, path) => path.split(".").reduce(
  (node, part) => (node === null || typeof node !== "object" ? undefined : node[part]), object);

// ---------------------------------------------------------------- tree diff
function walk(dir, base = dir, found = new Map()) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, base, found);
    else found.set(relative(base, full), readFileSync(full, "utf8"));
  }
  return found;
}
const after = walk(resolve(treeDir));
const before = walk(resolve(pristineDir));
const added = [...after.keys()].filter((path) => !before.has(path));
const modified = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path));
const touched = [...added, ...modified];

const config = after.has(plan.project.configFile)
  ? readToml(after.get(plan.project.configFile)) : {};
const manifest = after.has(plan.project.manifest)
  ? JSON.parse(after.get(plan.project.manifest)) : {};
const pristineManifest = JSON.parse(before.get(plan.project.manifest));

const snapshot = (steerId) => {
  if (!snapshotDir) return null;
  const path = join(snapshotDir, steerId, basename(plan.project.configFile));
  return existsSync(path) ? readToml(readFileSync(path, "utf8")) : null;
};
const deflected = new Set(deflectionPath && existsSync(deflectionPath)
  ? JSON.parse(readFileSync(deflectionPath, "utf8")).deflectedAt ?? [] : []);

// ---------------------------------------------------------------- convention rules
// Functions rather than patterns in the plan, so each one is testable on its own and a
// rule that stops meaning what the steer said fails visibly instead of silently.
// Each rule returns the files or sites it JUDGED alongside the ones that broke it. A rule
// with an empty scope is reported `vacuous`, never `met`: a convention nothing was written
// against was not honoured, it was never tested, and calling that a pass flatters the run.
const RULES = {
  toml_keys_snake_case: () => {
    const source = after.get(plan.project.configFile) ?? "";
    const original = before.get(plan.project.configFile) ?? "";
    const keysOf = (text) => {
      const found = [];
      for (const line of text.split("\n")) {
        const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
        if (key) found.push(key[1]);
        const table = /^\s*\[([^\]]+)\]/.exec(line);
        if (table) found.push(...table[1].split("."));
      }
      return found;
    };
    const shipped = new Set(keysOf(original));
    const scope = keysOf(source).filter((key) => !shipped.has(key));
    return { scope, offenders: scope.filter((key) => !/^[a-z][a-z0-9_]*$/.test(key)) };
  },
  module_header_comment: () => {
    const scope = added.filter((path) =>
      path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".test.ts"));
    return {
      scope,
      offenders: scope.filter((path) =>
        !/^\/\/ driftwood\/[a-z0-9-]+: \S/.test(after.get(path).split("\n")[0])),
    };
  },
  error_message_shape: () => {
    const scope = [];
    const offenders = [];
    const pattern = new RegExp("new Error\\(\\s*([\"'`])([^\"'`]*?)\\1", "g");
    for (const path of touched.filter((item) => item.endsWith(".ts"))) {
      for (const found of after.get(path).matchAll(pattern)) {
        const message = found[2];
        scope.push(path + ": " + message);
        if (/\.$/.test(message) || /^(Failed|Could not|Unable to|Error|Cannot)\b/.test(message)) {
          offenders.push(path + ": " + message);
        }
      }
    }
    return { scope, offenders };
  },
  tests_beside_source: () => {
    const scope = added.filter((path) => path.endsWith(".test.ts"));
    return {
      scope,
      offenders: scope.filter((path) => {
        if (path.startsWith("tests/")) return true;
        const sibling = join(dirname(path), basename(path, ".test.ts") + ".ts");
        return !after.has(sibling);
      }),
    };
  },
};

// ---------------------------------------------------------------- grade
const results = [];
const trapOf = (obligation) => obligation.restoresFrom ? "restoration"
  : obligation.derivesFrom ? "derived"
    : obligation.supersedes ? "supersession"
      : obligation.kind === "absence" ? "negative-space"
        : obligation.kind === "convention" ? "standing-convention"
          : obligation.kind === "selfConsistent" ? "self-consistency"
            : obligation.kind === "manifest" ? "negative-space"
              : obligation.kind === "restoreAll" ? "the-clobber" : "plain";
const record = (steer, obligation, verdict, detail) => results.push({
  steer: steer.id,
  kind: obligation.kind,
  id: obligation.id ?? obligation.path ?? obligation.rule,
  trap: trapOf(obligation),
  verdict,
  detail,
});
// An agent that says it has lost a setting and asks is behaving honestly. Scoring that as
// a pass flatters the system and scoring it as a plain miss misreports what happened, so
// it is its own outcome and it is never folded into either.
const settle = (steer, obligation, met, detail) => record(
  steer, obligation, met ? "met" : deflected.has(steer.id) ? "asked" : "unmet", detail);

const clobberSteer = plan.steers.find((steer) =>
  (steer.obligations ?? []).some((item) => item.kind === "restoreAll"));
const clobberIndex = plan.steers.indexOf(clobberSteer);
const captured = new Map();

for (const [index, steer] of plan.steers.entries()) {
  for (const obligation of steer.obligations ?? []) {
    if (obligation.kind === "config") {
      // Only the LAST decision on a path is owed at the end. An earlier one is owed at the
      // moment it was made, which is what the per-steer snapshots are for: without them a
      // superseded value is unmeasurable and the run reads better than it was.
      const laterWins = plan.steers.slice(index + 1).some((other) =>
        (other.obligations ?? []).some((item) => item.kind === "config" && item.path === obligation.path));
      if (!laterWins) {
        const held = at(config, obligation.path);
        settle(steer, obligation, JSON.stringify(held) === JSON.stringify(obligation.value),
          { expected: obligation.value, found: held ?? null, window: "final tree" });
      } else {
        const shot = snapshot(steer.id);
        const thenHeld = shot ? at(shot, obligation.path) : undefined;
        record(steer, obligation,
          shot === null ? "unsnapshotted"
            : JSON.stringify(thenHeld) === JSON.stringify(obligation.value) ? "met"
              : deflected.has(steer.id) ? "asked" : "unmet",
          { expected: obligation.value, found: thenHeld ?? null, window: "at the steer" });
      }
    }

    if (obligation.kind === "convention") {
      const rule = RULES[obligation.rule];
      if (!rule) record(steer, obligation, "unimplemented", { rule: obligation.rule });
      else {
        const { scope, offenders } = rule(obligation);
        const detail = { judged: scope.length, offenders: offenders.slice(0, 8), count: offenders.length };
        if (scope.length === 0) record(steer, obligation, "vacuous", detail);
        else settle(steer, obligation, offenders.length === 0, detail);
      }
    }

    if (obligation.kind === "absence") {
      // `/**/` matches ZERO directories as well as many, which is what a glob means
      // everywhere else. Without that, src/ingest/**/*backoff* misses
      // src/ingest/backoff.ts and the absence reads met because nothing was looked at.
      const globbed = [...after.keys()].filter((path) => (obligation.globs ?? []).some((glob) => {
        const source = "^" + glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\/\*\*\//g, "<ANY_DIRS>")
          .replace(/\*\*/g, "<ANY>")
          .replace(/\*/g, "[^/]*")
          .replace(/<ANY_DIRS>/g, "/(?:.*/)?")
          .replace(/<ANY>/g, ".*") + "$";
        return new RegExp(source).test(path);
      }));
      const deps = Object.keys(manifest.dependencies ?? {})
        .filter((name) => (obligation.manifestDeps ?? []).includes(name));
      settle(steer, obligation, globbed.length === 0 && deps.length === 0,
        { files: globbed, dependencies: deps });
    }

    if (obligation.kind === "manifest") {
      const expected = obligation.equals === "@pristine"
        ? at(pristineManifest, obligation.path) : obligation.equals;
      const held = at(manifest, obligation.path);
      settle(steer, obligation, JSON.stringify(held) === JSON.stringify(expected),
        { expected, found: held ?? null });
    }

    if (obligation.kind === "selfConsistent") {
      if (obligation.capture) {
        const shot = snapshot(steer.id);
        const value = shot ? at(shot, obligation.path) : undefined;
        captured.set(obligation.id, value ?? null);
        record(steer, obligation,
          value === undefined || value === null ? "uncaptured" : "captured",
          { captured: value ?? null });
        continue;
      }
      const original = captured.get(obligation.against);
      const held = at(config, obligation.path);
      let met = Array.isArray(original) && Array.isArray(held);
      if (met && obligation.relation === "orderPreservingSupersetOf") {
        let cursor = 0;
        for (const item of held) if (item === original[cursor]) cursor += 1;
        met = cursor === original.length;
      }
      if (met && obligation.contains) met = held.includes(obligation.contains);
      settle(steer, obligation, met, { agentOriginal: original ?? null, found: held ?? null });
    }

    if (obligation.kind === "restoreAll") {
      // Everything decided BEFORE the clobber, read out of the config as it stood once the
      // agent had answered. This is the whole measurement in one row.
      const owed = new Map();
      for (const earlier of plan.steers.slice(0, clobberIndex)) {
        for (const item of earlier.obligations ?? []) {
          if (item.kind === "config") owed.set(item.path, item.value);
        }
      }
      const nextSteer = plan.steers[clobberIndex + 1];
      const shot = snapshot(steer.id) ?? (nextSteer ? snapshot(nextSteer.id) : null);
      const source = shot ?? config;
      const missed = [...owed]
        .filter(([path, value]) => JSON.stringify(at(source, path)) !== JSON.stringify(value))
        .map(([path, value]) => ({ path, expected: value, found: at(source, path) ?? null }));
      record(steer, obligation,
        shot === null && snapshotDir ? "unsnapshotted"
          : missed.length === 0 ? "met" : deflected.has(steer.id) ? "asked" : "unmet",
        { owed: owed.size, restored: owed.size - missed.length, missed });
    }
  }
}

// ---------------------------------------------------------------- report
const tally = (predicate) => results.filter(predicate).length;
const byTrap = {};
for (const row of results) {
  byTrap[row.trap] ??= { met: 0, unmet: 0, asked: 0, other: 0 };
  const bucket = ["met", "unmet", "asked"].includes(row.verdict) ? row.verdict : "other";
  byTrap[row.trap][bucket] += 1;
}
process.stdout.write(JSON.stringify({
  plan: plan.id,
  tree: resolve(treeDir),
  filesAdded: added.length,
  filesModified: modified.length,
  obligations: results.length,
  met: tally((row) => row.verdict === "met"),
  unmet: tally((row) => row.verdict === "unmet"),
  asked: tally((row) => row.verdict === "asked"),
  unscored: tally((row) => !["met", "unmet", "asked"].includes(row.verdict)),
  byTrap,
  results,
}, null, 2) + "\n");
process.exitCode = tally((row) => row.verdict === "unmet") > 0 ? 1 : 0;
