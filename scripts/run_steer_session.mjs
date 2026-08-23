#!/usr/bin/env node

// Supervises one steer-protocol run: builds the namespace, spawns the worker inside it,
// releases the authored steers one at a time, and takes the per-steer config snapshots the
// grader needs.
//
// THE PLAN NEVER CROSSES. This process holds the whole authored session, obligations and
// expected values included; the worker sees one steer's text at a time and nothing else.
// The snapshots are taken from THIS side of the bind for the same reason: a snapshot
// directory inside the namespace would hand the clobber back its own answer sheet.
//
//   node scripts/run_steer_session.mjs --run-dir <dir> --arm pifold|native \
//        [--plan scripts/fixtures/driftwood-session-v1.json] [--ready-only]

import { spawn } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPERIMENT_TRANSPORT,
  assertExperiment,
} from "./lib/pi_context_experiment.mjs";
import {
  STEER_HARNESS_SOURCE,
  SANDBOX_PATHS,
  SANDBOX_WORKER_PID,
  sandboxArgv,
  sandboxIdentityFiles,
} from "./lib/pi_context_sandbox.mjs";
import {
  STEER_ARMS,
  STEER_IPC_DIRECTORIES,
  releasedSteer,
  steerRequestPath,
  steerResponsePath,
  validateSteerRunConfig,
} from "./lib/steer_session.mjs";
import {
  PI_INSTALL_ROOT,
  directoryTreeSha256,
  fileSha256,
  monotonicMs,
  readJson,
  sha256Text,
  writeJsonExclusive,
} from "./lib/pi_context_soak_attestation.mjs";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_HOME = process.env.HOME;

const argumentValue = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const runDir = resolve(argumentValue("--run-dir") ?? "");
const arm = argumentValue("--arm");
const planPath = resolve(argumentValue("--plan", "scripts/fixtures/driftwood-session-v1.json"));
const readyOnly = process.argv.includes("--ready-only");
// The serving budget the arm declares. Same value the sealed campaigns used, so Pi's
// compaction trigger sits where the corpus says it sits.
const budgetArgument = argumentValue("--budget", "251520");
const budget = budgetArgument === "none" ? null : Number(budgetArgument);
assertExperiment(runDir && STEER_ARMS.includes(arm),
  `Steer run requires --run-dir and --arm ${STEER_ARMS.join("|")}`);
assertExperiment(!existsSync(runDir), `Run directory already exists: ${runDir}`);

const plan = JSON.parse(readFileSync(planPath, "utf8"));
assertExperiment(plan.protocol === "steer/v1", `Plan is ${plan.protocol}, not steer/v1`);
const planSha256 = sha256Text(readFileSync(planPath, "utf8"));

// The steer session validator is the gate that clears a plan to run at all, and the crutch
// scan inside it is the half that needs the checkout. Running it here means a campaign
// cannot start on a plan whose values are greppable out of the tree the agent works in.
const runId = `${basename(runDir)}-${arm}`;
mkdirSync(runDir, { recursive: false, mode: 0o700 });
for (const relative of STEER_IPC_DIRECTORIES) mkdirSync(join(runDir, relative), { mode: 0o700 });

// A FRESH, WRITABLE CHECKOUT PER RUN. The graded material is the tree the agent leaves
// behind, so this one is bound read-write and a pristine copy is generated beside the run
// for the grader to diff against. The generator is deterministic, so both arms and every
// repetition start byte-identical.
const repoDir = join(runDir, "repo");
const pristineDir = `${runDir}.pristine`;
execFileSync("node", [join(PROJECT, "scripts", "generate_driftwood_checkout.mjs"), repoDir],
  { stdio: "ignore" });
execFileSync("node", [join(PROJECT, "scripts", "generate_driftwood_checkout.mjs"), pristineDir],
  { stdio: "ignore" });
const validation = execFileSync("node", [
  join(PROJECT, "scripts", "validate_steer_session.mjs"), "--plan", planPath,
  "--checkout", repoDir,
], { encoding: "utf8" });
assertExperiment(/PASS steer session validation/.test(validation),
  "The steer plan does not validate against the generated checkout");

const snapshotDir = `${runDir}.snapshots`;
mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
const configFileName = basename(plan.project.configFile);
const pristineConfig = readFileSync(join(pristineDir, plan.project.configFile), "utf8");
const snapshot = (steerId) => {
  const into = join(snapshotDir, steerId);
  mkdirSync(into, { recursive: true, mode: 0o700 });
  const live = join(repoDir, plan.project.configFile);
  writeFileSync(join(into, configFileName), existsSync(live) ? readFileSync(live, "utf8") : "");
};

// ---------------------------------------------------------------- the namespace
const sandboxRoot = `${runDir}.sandbox`;
const sessionDir = join(runDir, "session");
const harnessDir = join(sandboxRoot, "harness");
const homeDir = join(sandboxRoot, "home");
const agentDir = join(sandboxRoot, "agent");
const identityDir = join(sandboxRoot, "identity");
const scratchDir = join(sandboxRoot, "scratch");
for (const dir of [sessionDir, sandboxRoot, harnessDir, homeDir, agentDir, identityDir, scratchDir]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
for (const relative of STEER_HARNESS_SOURCE) {
  const target = join(harnessDir, relative);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(join(PROJECT, relative), target);
}
const identity = sandboxIdentityFiles(process.getuid(), process.getgid());
writeFileSync(join(identityDir, "passwd"), identity.passwd, { mode: 0o600 });
writeFileSync(join(identityDir, "group"), identity.group, { mode: 0o600 });
copyFileSync(join(RUNTIME_HOME, ".pi", "agent", "models-store.json"),
  join(agentDir, "models-store.json"));
const authPath = join(RUNTIME_HOME, ".pi", "agent", "auth.json");

// The worker recomputes both of these itself and refuses to run if either differs.
const workerDependencyHashes = {
  piPackageJson: fileSha256(join(PI_INSTALL_ROOT, "package.json")),
  piDistTree: directoryTreeSha256(join(PI_INSTALL_ROOT, "dist")),
  piNodeModulesTree: directoryTreeSha256(join(PI_INSTALL_ROOT, "node_modules")),
  nodeExecutable: fileSha256(process.execPath),
};
// Exactly the files the harness copy holds, because that copy is the PROJECT the worker
// verifies against. Hashing anything outside it would fail on a path that is not there.
const sourceHashes = Object.fromEntries(STEER_HARNESS_SOURCE
  .map((relative) => [relative, fileSha256(join(PROJECT, relative))]));

const config = validateSteerRunConfig({
  version: 1,
  runId,
  runDir: SANDBOX_PATHS.run,
  repoDir: SANDBOX_PATHS.work,
  sessionDir: SANDBOX_PATHS.session,
  arm,
  planId: plan.id,
  planSha256,
  steerCount: plan.steers.length,
  // The sealed campaign's own model and effort, because only this provider is
  // authenticated on this machine and its 272,000-token window is what the steer
  // protocol's length assumptions were written against.
  model: {
    provider: argumentValue("--provider", "openai-codex"),
    id: argumentValue("--model", "gpt-5.6-sol"),
    effort: argumentValue("--effort", "xhigh"),
  },
  transport: EXPERIMENT_TRANSPORT,
  dependencyHashes: workerDependencyHashes,
  sourceHashes,
  watchdogMs: Number(argumentValue("--watchdog-ms", String(8 * 60 * 60 * 1000))),
  createdWallMs: Date.now(),
  // The tree the agent starts from, attested. The worker recomputes it and refuses to run
  // if the checkout it was handed is not the one the generator produced.
  checkoutSha256: directoryTreeSha256(repoDir),
  deflections: plan.deflections,
  ...(budget === null ? {} : { providerInputBudget: budget }),
  ...(readyOnly ? { readyOnly: true } : {}),
});
// WRITTEN INTO THE HARNESS COPY, so the deletion that removes the harness source removes
// the config too. It carries no obligation and no expected value; the deflections in it
// are shrugs.
writeJsonExclusive(join(harnessDir, "config.json"), config);

const stdoutFd = openSync(join(runDir, "worker.stdout.log"), "wx", 0o600);
const stderrFd = openSync(join(runDir, "worker.stderr.log"), "wx", 0o600);
const argv = sandboxArgv({
  checkoutDir: repoDir, sessionDir, runDir, harnessDir,
  piRoot: PI_INSTALL_ROOT, nodeExecutable: process.execPath,
  homeDir, identityDir, agentDir, authPath, scratchDir,
  workWritable: true,
  workerScript: "run_steer_session_worker.mjs",
});
const worker = spawn(argv[0], argv.slice(1), {
  cwd: PROJECT,
  env: { PATH: process.env.PATH, HOME: RUNTIME_HOME },
  detached: false,
  stdio: ["ignore", stdoutFd, stderrFd],
});
closeSync(stdoutFd);
closeSync(stderrFd);
let workerExited = null;
worker.on("exit", (code, signal) => { workerExited = { code, signal }; });

const deadline = monotonicMs() + config.watchdogMs;
const waitFor = async (predicate, label) => {
  for (;;) {
    if (predicate()) return true;
    if (workerExited) return false;
    if (monotonicMs() > deadline) throw new Error(`Steer supervisor timed out on ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

let released = 0;
let failure = null;
try {
  const readyPath = join(runDir, "worker-ready.json");
  const ready = await waitFor(() => existsSync(readyPath), "worker readiness");
  assertExperiment(ready, "The steer worker exited before reporting readiness");
  const readiness = readJson(readyPath);
  assertExperiment(readiness.workerPid === SANDBOX_WORKER_PID,
    `Worker readiness came from namespace pid ${readiness.workerPid}`);
  assertExperiment(readiness.runId === runId && readiness.arm === arm,
    "Worker readiness identity drifted");

  if (readyOnly) {
    // The worker writes its report and exits on its own; killing it at readiness would
    // race that write and leave a run nothing can be read out of.
    await waitFor(() => existsSync(join(runDir, "worker-report.json")), "ready-only report");
  } else {
    for (let ordinal = 1; ordinal <= plan.steers.length; ordinal += 1) {
      const steer = plan.steers[ordinal - 1];
      const requested = await waitFor(
        () => existsSync(steerRequestPath(runDir, ordinal)), `steer ${ordinal} request`);
      if (!requested) break;
      // QUIESCENT BY CONSTRUCTION. The worker asks for steer N only once the turn for
      // N-1 has ended, so the tree is not being written while it is read and there is no
      // race to lose. The snapshot belongs to the PREVIOUS steer for the same reason.
      if (ordinal > 1) snapshot(plan.steers[ordinal - 2].id);
      // The driver effect lands BEFORE the steer that describes it, because the user in
      // the transcript is reporting something that has already happened to them.
      if (steer.driverEffect?.action === "resetFile") {
        assertExperiment(steer.driverEffect.file === plan.project.configFile,
          `Steer ${steer.id} resets a file the plan does not name as its config`);
        writeFileSync(join(repoDir, plan.project.configFile), pristineConfig);
      }
      writeJsonExclusive(steerResponsePath(runDir, ordinal),
        releasedSteer(steer, ordinal, plan.steers.length));
      released = ordinal;
    }
    if (released === plan.steers.length) {
      await waitFor(() => existsSync(join(runDir, "worker-report.json")), "worker report");
      snapshot(plan.steers.at(-1).id);
    }
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (!workerExited) {
    worker.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2_000));
    if (!workerExited) worker.kill("SIGKILL");
  }
}

const report = existsSync(join(runDir, "worker-report.json"))
  ? readJson(join(runDir, "worker-report.json")) : null;
const manifest = {
  version: 1,
  protocol: plan.protocol,
  runId,
  arm,
  planId: plan.id,
  planSha256,
  planPath,
  runDir,
  repoDir,
  pristineDir,
  snapshotDir,
  steerCount: plan.steers.length,
  steersReleased: released,
  readyOnly,
  workerExit: workerExited,
  workerReport: report,
  failure,
  finishedWallMs: Date.now(),
};
// OUTSIDE THE BIND. It names the plan's path on the host, and the run directory is
// mounted into the namespace for the whole run. Nothing that says where the answers live
// belongs on that side of the boundary, whatever the write order happens to be today.
writeJsonExclusive(`${runDir}.manifest.json`, manifest);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
process.exitCode = failure || (!readyOnly && released !== plan.steers.length) ? 1 : 0;
