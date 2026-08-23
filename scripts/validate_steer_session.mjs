#!/usr/bin/env node
// Validates an authored steer session (protocol steer/v1) before a campaign spends
// anything on it. Everything here is a refusal a bad plan should hit at authoring time
// rather than a surprise a grader hits after six hours of runtime.
//
// Optional: --checkout <dir> runs the crutch scan against a generated checkout, which is
// the one check that needs the project to exist. Without it the scan is REPORTED AS NOT
// RUN rather than skipped quietly, because a plan that has not had it is not cleared.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const failures = [];
const notes = [];
const fail = (id, message) => failures.push(`${id}: ${message}`);

const argumentValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
};
const planPath = argumentValue("--plan") ?? "scripts/fixtures/driftwood-session-v1.json";
const checkoutDir = argumentValue("--checkout");
const plan = JSON.parse(readFileSync(resolve(planPath), "utf8"));

if (plan.protocol !== "steer/v1") fail("plan", `protocol is ${plan.protocol}, not steer/v1`);

// ---------------------------------------------------------------- shape and ordering
const steers = plan.steers ?? [];
const byId = new Map();
steers.forEach((steer, index) => {
  if (byId.has(steer.id)) fail(steer.id, "duplicate steer id");
  byId.set(steer.id, { ...steer, index });
  if (typeof steer.text !== "string" || steer.text.trim().length === 0) {
    fail(steer.id, "steer has no text");
  }
});
const earlier = (fromId, targetId) => {
  const from = byId.get(fromId);
  const target = byId.get(targetId);
  if (!target) { fail(fromId, `references unknown steer ${targetId}`); return null; }
  if (target.index >= from.index) { fail(fromId, `references ${targetId}, which is not earlier`); return null; }
  return target;
};

// ---------------------------------------------------------------- the crutch rule
// No steer may ask the agent to keep a record. An artifact that records decisions is a
// memory aid, and a session containing one measures the aid rather than the system.
const CRUTCH = [
  /\bchangelog\b/i, /\badr\b/i, /decision (log|record|doc)/i, /\bnotes? file\b/i,
  /keep (a |track of )?(a )?(record|log|note)/i, /write (it |that )?down/i,
  /\bscratch ?pad\b/i, /running (list|log|summary)/i,
];
// And no steer may tell the agent it is being tested or what to hold on to. This is
// gate 62's scan, over steer text instead of over a system prompt.
const AWARENESS = [
  /\bremember\b/i, /\brecall\b/i, /\bmemor(y|ise|ize)\b/i, /\bcontext window\b/i,
  /\bcompact(ion|ed)?\b/i, /\bfold(ing|s)?\b/i, /\bexperiment\b/i, /\bevaluat(e|ion)\b/i,
  /\bbenchmark\b/i, /you (will|might|may) be (asked|tested)/i, /\bprobe\b/i,
  /keep (an )?exact/i, /\bverbatim\b/i, /\bdon't forget\b/i, /\blater I'll ask\b/i,
];
for (const steer of steers) {
  for (const pattern of CRUTCH) {
    if (pattern.test(steer.text)) fail(steer.id, `steer text asks for a record (${pattern})`);
  }
  for (const pattern of AWARENESS) {
    if (pattern.test(steer.text)) fail(steer.id, `steer text leaks the measurement (${pattern})`);
  }
}

// ---------------------------------------------------------------- config obligations
const pristine = plan.pristine?.[plan.project.configFile] ?? {};
const settings = new Map();          // path -> { value, steerId }
const decided = [];                  // every config obligation, in steer order
for (const steer of steers) {
  for (const obligation of steer.obligations ?? []) {
    if (obligation.kind !== "config") continue;
    decided.push({ steer, obligation });
    const { path, value } = obligation;

    // A decided value that equals the shipped default is invisible after the clobber:
    // restoring it and never having known it produce the same file.
    if (Object.hasOwn(pristine, path) &&
        JSON.stringify(pristine[path]) === JSON.stringify(value)) {
      fail(steer.id, `${path} is decided as the shipped default, so the clobber gives it away`);
    }

    if (obligation.supersedes) {
      const target = earlier(steer.id, obligation.supersedes);
      if (target) {
        const prior = (target.obligations ?? []).find((item) => item.kind === "config" && item.path === path);
        if (!prior) fail(steer.id, `supersedes ${target.id}, which never set ${path}`);
        else if (JSON.stringify(prior.value) === JSON.stringify(value) && !obligation.restoresFrom) {
          fail(steer.id, `supersedes ${target.id} with the same value, so nothing is being tested`);
        }
      }
    }

    // A restoration is only a restoration if the steer withholds the number. Naming it
    // turns the trap into an ordinary supersession that any summary answers.
    if (obligation.restoresFrom) {
      const target = earlier(steer.id, obligation.restoresFrom);
      if (target) {
        const original = (target.obligations ?? []).find((item) => item.kind === "config" && item.path === path);
        if (!original) fail(steer.id, `restoresFrom ${target.id}, which never set ${path}`);
        else if (JSON.stringify(original.value) !== JSON.stringify(value)) {
          fail(steer.id, `restoresFrom ${target.id}, whose value was ${JSON.stringify(original.value)}, not ${JSON.stringify(value)}`);
        }
      }
      if (obligation.valueUnstated !== true) fail(steer.id, "a restoration must set valueUnstated");
      if (String(steer.text).includes(String(value))) {
        fail(steer.id, `restoration states its own value ${value} in the steer text`);
      }
    }

    // A derived value is carried by ONE earlier steer and by nothing else. The carrier
    // must state it and the asking steer must not.
    if (obligation.derivesFrom) {
      const target = earlier(steer.id, obligation.derivesFrom);
      if (target && !String(target.text).includes(String(value)) &&
          !(target.obligations ?? []).some((item) => JSON.stringify(item.value) === JSON.stringify(value))) {
        fail(steer.id, `derivesFrom ${target.id}, which never states ${JSON.stringify(value)}`);
      }
      if (String(steer.text).includes(String(value))) {
        fail(steer.id, `derived value ${value} is restated in the asking steer, so nothing is carried`);
      }
    }

    settings.set(path, { value, steerId: steer.id });
  }
}

// ---------------------------------------------------------------- the clobber
const clobbers = steers.filter((steer) =>
  (steer.obligations ?? []).some((item) => item.kind === "restoreAll"));
if (clobbers.length !== 1) fail("plan", `${clobbers.length} clobber steers; the protocol expects exactly one`);
if (clobbers.length === 1) {
  const clobber = byId.get(clobbers[0].id);
  const effect = clobbers[0].driverEffect;
  if (effect?.action !== "resetFile" || effect.file !== plan.project.configFile) {
    fail(clobber.id, "the clobber steer carries no resetFile driver effect on the config");
  }
  const owed = decided.filter(({ steer }) => byId.get(steer.id).index < clobber.index);
  const paths = new Set(owed.map(({ obligation }) => obligation.path));
  if (paths.size < 8) fail(clobber.id, `only ${paths.size} settings are owed at the clobber; that is a thin probe`);
  notes.push(`clobber at ${clobber.id} owes ${paths.size} settings decided across ${owed.length} steers`);
}

// ---------------------------------------------------------------- other kinds
for (const steer of steers) {
  for (const obligation of steer.obligations ?? []) {
    if (obligation.kind === "convention") {
      // A convention may apply from its OWN steer onward, which is the ordinary case:
      // the user states the rule and it governs everything written from then on.
      if (obligation.appliesAfter && obligation.appliesAfter !== steer.id) {
        earlier(steer.id, obligation.appliesAfter);
      }
      if (!obligation.rule) fail(steer.id, "convention names no rule");
    }
    if (obligation.kind === "selfConsistent" && obligation.against) {
      const captured = steers.some((other) => (other.obligations ?? []).some((item) =>
        item.kind === "selfConsistent" && item.id === obligation.against && item.capture === true));
      if (!captured) fail(steer.id, `selfConsistent against ${obligation.against}, which nothing captures`);
    }
  }
}

// A convention is only a measurement if something is written long after it is stated.
for (const steer of steers) {
  for (const obligation of steer.obligations ?? []) {
    if (obligation.kind !== "convention") continue;
    const stated = byId.get(steer.id).index;
    const remaining = steers.length - stated;
    if (remaining < 20) fail(steer.id, `convention stated with only ${remaining} steers left to test it`);
  }
}

// ---------------------------------------------------------------- crutch scan
if (checkoutDir && existsSync(checkoutDir)) {
  // The rule is not "the number never appears". It is "the DECISION is not recoverable":
  // a logger with an `info` level tells the agent nothing about which level the user
  // chose, but a `level = "info"` sitting in a sample config hands the answer over. So
  // the scan looks for the value in ASSIGNMENT position against its own key, anywhere in
  // the tree except the live config file the clobber resets.
  const liveConfig = plan.project.configFile;
  for (const [path, { value, steerId }] of settings) {
    const key = path.split(".").pop();
    const literal = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // The trailing boundary is not optional: without it the shipped default 30 matches a
    // decided 3 as a prefix and every near-miss reads as a leak.
    const pattern = `["']?${key}["']?[[:space:]]*[=:][[:space:]]*["']?${literal}["']?([^0-9A-Za-z_]|$)`;
    let hits = "";
    try {
      hits = execFileSync("grep", ["-rIlE", "-e", pattern, checkoutDir], { encoding: "utf8" });
    } catch { hits = ""; }
    const files = hits.split("\n").filter(Boolean)
      .map((file) => file.replace(`${checkoutDir.replace(/\/$/, "")}/`, ""))
      .filter((file) => file !== liveConfig);
    if (files.length) {
      fail(steerId, `${path}=${JSON.stringify(value)} is recoverable from the checkout (${files.join(", ")})`);
    }
  }
  // And the live config must actually ship the pristine defaults, or the clobber resets
  // to something other than what the plan says it resets to.
  const shipped = readFileSync(resolve(checkoutDir, liveConfig), "utf8");
  for (const [path, value] of Object.entries(pristine)) {
    if (Array.isArray(value)) continue;
    const key = path.split(".").pop();
    const line = new RegExp(`^\\s*${key}\\s*=\\s*"?${String(value)}"?\\s*$`, "m");
    if (!line.test(shipped)) fail("checkout", `shipped config does not carry ${path} = ${value}`);
  }
  notes.push(`crutch scan ran against ${checkoutDir}`);
} else {
  notes.push("CRUTCH SCAN NOT RUN: pass --checkout <dir>. A plan without it is not cleared to run.");
}

// ---------------------------------------------------------------- report
const expected = Object.fromEntries([...settings].map(([path, { value }]) => [path, value]));
process.stdout.write(`${JSON.stringify({
  plan: plan.id,
  steers: steers.length,
  obligations: steers.reduce((total, steer) => total + (steer.obligations ?? []).length, 0),
  settingsDecided: settings.size,
  supersessions: decided.filter(({ obligation }) => obligation.supersedes).length,
  restorations: decided.filter(({ obligation }) => obligation.restoresFrom).length,
  derived: decided.filter(({ obligation }) => obligation.derivesFrom).length,
  expectedFinalConfig: expected,
}, null, 2)}\n`);
for (const note of notes) process.stdout.write(`NOTE ${note}\n`);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.stdout.write(`FAIL steer session validation: ${failures.length} problem(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("PASS steer session validation\n");
}
