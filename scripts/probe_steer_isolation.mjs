#!/usr/bin/env node
// Proves the steer run's namespace holds what it should and nothing else.
//
// Shane, on why: "be sure to bubblewrap them or whatever we need to in order to isolate
// their environment / config setup. We don't want any leaks/cheating." The v4 protocol
// learned this the hard way: five sealed runs walked from the session file to the run
// config to the plan and read the answer key. Here the plan carries every obligation and
// every expected setting, so the test is not that reading it is denied but that it is
// ABSENT, along with anything naming where it lives.
//
// Runs both arms in ready-only mode, which boots a real session inside the real namespace
// and stops before the first prompt, so this costs nothing at a provider.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sandboxArgv, SANDBOX_PATHS } from "./lib/pi_context_sandbox.mjs";

const rootArgument = process.argv[2] && !process.argv[2].startsWith("--")
  ? process.argv[2]
  : "lab/steer-isolation";
const root = resolve(rootArgument);
rmSync(root, { recursive: true, force: true });
rmSync(`${root}.pifold.sandbox`, { recursive: true, force: true });

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) { process.stdout.write(`OK   ${label}\n`); return; }
  failures += 1;
  process.stdout.write(`FAIL ${label} ${JSON.stringify(detail ?? null)}\n`);
};
const walk = (dir, found = []) => {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
  return found;
};

// ---------------------------------------------------------------- the argv itself
const argv = sandboxArgv({
  checkoutDir: "/tmp/checkout", sessionDir: "/tmp/session", runDir: "/tmp/run",
  harnessDir: "/tmp/harness", piRoot: "/tmp/pi", nodeExecutable: "/tmp/node",
  homeDir: "/tmp/home", identityDir: "/tmp/identity", agentDir: "/tmp/agent",
  authPath: "/tmp/auth.json", scratchDir: "/tmp/scratch",
  workWritable: true, workerScript: "run_steer_session_worker.mjs",
});
const at = argv.indexOf("/tmp/checkout");
check("the checkout is bound read-write", argv[at - 1] === "--bind" && argv[at + 1] === SANDBOX_PATHS.work,
  { flag: argv[at - 1], target: argv[at + 1] });
check("the v4 checkout stays read-only", sandboxArgv({
  checkoutDir: "/tmp/checkout", sessionDir: "/tmp/session", runDir: "/tmp/run",
  harnessDir: "/tmp/harness", piRoot: "/tmp/pi", nodeExecutable: "/tmp/node",
  homeDir: "/tmp/home", identityDir: "/tmp/identity", agentDir: "/tmp/agent",
  authPath: "/tmp/auth.json", scratchDir: "/tmp/scratch",
})[at - 1] === "--ro-bind");
check("the namespace unshares everything and clears the environment",
  argv.includes("--unshare-all") && argv.includes("--clearenv") && argv.includes("--die-with-parent"));
check("the steer worker is the entry point",
  argv.at(-2).endsWith("run_steer_session_worker.mjs"), argv.at(-2));
for (const forbidden of [".canon", "docs", "lab", "campaign"]) {
  check(`nothing binds ${forbidden}`, !argv.some((piece) =>
    typeof piece === "string" && piece.split("/").includes(forbidden)), forbidden);
}

// ---------------------------------------------------------------- a real boot, both arms
const planFlag = process.argv.indexOf("--plan");
const planPath = planFlag >= 0
  ? process.argv[planFlag + 1]
  : "scripts/fixtures/driftwood-session-v1.json";
const planBasename = planPath.split("/").pop();
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const expectedTools = {
  pifold: ["bash", "edit", "pi_fold_context", "read", "write"],
  native: ["bash", "edit", "read", "write"],
};
for (const arm of ["pifold", "native"]) {
  const runDir = `${root}.${arm}`;
  for (const stale of [runDir, `${runDir}.sandbox`, `${runDir}.pristine`, `${runDir}.snapshots`]) {
    rmSync(stale, { recursive: true, force: true });
  }
  execFileSync("node", ["scripts/run_steer_session.mjs", "--run-dir", runDir, "--arm", arm,
    "--plan", planPath, "--ready-only"], { encoding: "utf8", stdio: "pipe" });

  const ready = JSON.parse(readFileSync(join(runDir, "worker-ready.json"), "utf8"));
  check(`${arm}: the tool surface is stock plus its own arm`,
    JSON.stringify([...ready.tools].sort()) === JSON.stringify(expectedTools[arm]), ready.tools);
  check(`${arm}: the worker is the namespace's own child`, ready.workerPid === 2, ready.workerPid);
  check(`${arm}: the harness deleted its own source`,
    readdirSync(`${runDir}.sandbox/harness`).length === 0);

  // THE POINT OF THE WHOLE THING. Every file on the bound side of the boundary, read, and
  // nothing in it may carry an obligation, an expected value, or the plan's own path.
  const bound = [...walk(runDir), ...walk(`${runDir}.sandbox`)];
  const answers = [];
  for (const file of bound) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (/"obligations"|restoresFrom|supersedes|valueUnstated|authorNote/.test(text)) {
      answers.push(`${file}: obligation shape`);
    }
    if (text.includes(planBasename)) answers.push(`${file}: names the plan`);
  }
  check(`${arm}: no obligation and no plan path is reachable from inside`,
    answers.length === 0, answers.slice(0, 6));

  // And the settings the session decides must not be sitting in the checkout either, which
  // is the crutch scan the supervisor already ran; re-checked here against the LIVE tree.
  const validated = execFileSync("node", ["scripts/validate_steer_session.mjs",
    "--checkout", join(runDir, "repo")], { encoding: "utf8" });
  check(`${arm}: the checkout does not carry any decided value`,
    /PASS steer session validation/.test(validated));

  check(`${arm}: the snapshots live outside the bind`,
    existsSync(`${runDir}.snapshots`) && !existsSync(join(runDir, "snapshots")));
  check(`${arm}: the manifest lives outside the bind`,
    existsSync(`${runDir}.manifest.json`) && !existsSync(join(runDir, "manifest.json")));
}

process.stdout.write(`${JSON.stringify({ steers: plan.steers.length, arms: 2 })}\n`);
process.stdout.write(failures === 0 ? "PASS steer isolation probe\n" : "FAIL steer isolation probe\n");
process.exitCode = failures === 0 ? 0 : 1;
