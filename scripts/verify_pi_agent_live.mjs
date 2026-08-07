#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const piRoot = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";
const sessionDir = `/home/shane/quorum-run/tmp/pi_agent_live_verify_${process.pid}`;
const testedCommit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} = await import(pathToFileURL(join(piRoot, "dist", "index.js")));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function resultText(result) {
  return (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function waitForPersistedChild(asyncDir, timeoutMs = 120_000) {
  const statusPath = join(asyncDir, "status.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const lifecycle = JSON.parse(await readFile(statusPath, "utf8"));
      const sessionFile = lifecycle.steps?.[0]?.sessionFile;
      if (lifecycle.state === "running" && typeof sessionFile === "string" && existsSync(sessionFile)) return lifecycle;
      if (lifecycle.state !== "running" && lifecycle.state !== "queued") {
        throw new Error(`Child became ${lifecycle.state} before an interruptible session was persisted`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for persisted child session in ${asyncDir}`);
}

await mkdir(sessionDir, { recursive: true });
const sessionManager = SessionManager.create(projectRoot, sessionDir);
let extensionsResult;
const createRuntime = async ({ cwd, sessionManager: nextSessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  const created = await createAgentSessionFromServices({
    services,
    sessionManager: nextSessionManager,
    sessionStartEvent,
  });
  extensionsResult = created.extensionsResult;
  return { ...created, services, diagnostics: services.diagnostics };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: projectRoot,
  agentDir: getAgentDir(),
  sessionManager,
});
try {
const session = runtime.session;
const extensionErrors = extensionsResult?.errors ?? [];
assert(extensionErrors.length === 0, `Pi extension load failed: ${JSON.stringify(extensionErrors)}`);
await session.bindExtensions({ mode: "print" });
const agent = session.agent.state.tools.find((tool) => tool.name === "Agent");
assert(agent, "Governed Agent tool is not active in a fresh Pi runtime");

async function call(params, { allowError = false } = {}) {
  const result = await agent.execute(randomUUID(), params, new AbortController().signal, undefined);
  if (!allowError && result?.isError) throw new Error(resultText(result));
  return result;
}

const retainedJobs = [];
  const listed = await call({ action: "list" });
  assert(listed.details?.packageStatus?.includes("resume"), "Fresh runtime did not advertise package-owned resume RPC");

  const foreground = await call({
    profile: "researcher",
    tier: "drone",
    task: "Return exactly FOREGROUND-ATTESTED. Do not call tools.",
  });
  const foregroundJob = foreground.details.job;
  retainedJobs.push(foregroundJob.jobId);
  assert(foregroundJob.status === "completed", "Foreground governed child did not complete");
  assert(foregroundJob.nodes[0].output.includes("FOREGROUND-ATTESTED"), "Foreground runtime attestation did not preserve output");
  const foregroundRevived = await call({
    action: "resume",
    job_id: foregroundJob.jobId,
    message: "Return exactly FOREGROUND-REVIVED. Do not call tools.",
  });
  assert(foregroundRevived.details.job.revivals?.length === 1, "Foreground governed resume lineage was not recorded");
  const foregroundRevivedCompleted = await call({ action: "wait", job_id: foregroundJob.jobId, timeout_seconds: 300 });
  assert(foregroundRevivedCompleted.details.job.status === "completed", "Foreground revival did not complete");
  assert(
    foregroundRevivedCompleted.details.job.nodes[0].output.includes("FOREGROUND-REVIVED"),
    "Foreground revival did not preserve context and follow-up delivery",
  );

  const seedStarted = await call({
    action: "run",
    profile: "researcher",
    tier: "drone",
    background: true,
    timeout_seconds: 300,
    task: "Run one read-only Bash check: `test -r AGENTS.md`. Return exactly REVIVE-SEED. Do not modify anything.",
  });
  const seedJob = seedStarted.details.job;
  retainedJobs.push(seedJob.jobId);
  const seedCompleted = await call({ action: "wait", job_id: seedJob.jobId, timeout_seconds: 300 });
  assert(seedCompleted.details.job.status === "completed", "Seed child did not complete");
  assert(seedCompleted.details.job.nodes[0].output.includes("REVIVE-SEED"), "Seed child output marker is missing");

  const webStarted = await call({
    action: "run",
    profile: "web-researcher",
    tier: "drone",
    background: true,
    timeout_seconds: 300,
    task: "Call web_search for `official Pi coding agent documentation`, then call fetch_content for `https://pi.dev/`. Return the markers WEB-SEED and WEB-FETCHED plus one resulting URL. Do not request local access.",
  });
  const webJob = webStarted.details.job;
  retainedJobs.push(webJob.jobId);
  const webCompleted = await call({ action: "wait", job_id: webJob.jobId, timeout_seconds: 300 });
  assert(webCompleted.details.job.status === "completed", "Isolated web child did not complete");
  assert(webCompleted.details.job.nodes[0].output.includes("WEB-SEED"), "Isolated web child search marker is missing");
  assert(webCompleted.details.job.nodes[0].output.includes("WEB-FETCHED"), "Isolated web child full-fetch marker is missing");

  const revived = await call({
    action: "resume",
    job_id: seedJob.jobId,
    message: "Return exactly REVIVE-FOLLOWUP. Do not call tools.",
  });
  assert(revived.details.job.revivals?.length === 1, "Governed resume lineage was not recorded");
  const revivedCompleted = await call({ action: "wait", job_id: seedJob.jobId, timeout_seconds: 300 });
  assert(revivedCompleted.details.job.status === "completed", "Revived child did not complete");
  assert(
    revivedCompleted.details.job.nodes[0].output.includes("REVIVE-FOLLOWUP"),
    "Revived child did not preserve context and follow-up delivery",
  );

  const interruptStarted = await call({
    action: "run",
    profile: "researcher",
    tier: "drone",
    background: true,
    timeout_seconds: 300,
    task: "Use read-only Bash to run `/bin/sleep 90`, then return SHOULD-NOT-APPEAR. Do not modify anything.",
  });
  const interruptJob = interruptStarted.details.job;
  retainedJobs.push(interruptJob.jobId);
  await waitForPersistedChild(interruptJob.packageSpawn.details.asyncDir);
  await call({ action: "interrupt", job_id: interruptJob.jobId });
  const paused = await call(
    { action: "wait", job_id: interruptJob.jobId, timeout_seconds: 120 },
    { allowError: true },
  );
  assert(paused.details.job.packageLifecycle?.state === "paused", "Soft interrupt did not produce a resumable paused lifecycle");
  assert(paused.details.job.status === "failed", "Paused partial work was mislabeled as success");

  await call({
    action: "resume",
    job_id: interruptJob.jobId,
    message: "Do not sleep. Return exactly REVIVE-AFTER-INTERRUPT.",
  });
  const afterInterrupt = await call({ action: "wait", job_id: interruptJob.jobId, timeout_seconds: 300 });
  assert(afterInterrupt.details.job.status === "completed", "Interrupted child revival did not complete");
  assert(
    afterInterrupt.details.job.nodes[0].output.includes("REVIVE-AFTER-INTERRUPT"),
    "Interrupted child did not receive the governed resume message",
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    testedCommit,
    testedLaunchContractDigest: foregroundJob.nodes[0].launchContractDigest,
    freshRuntime: true,
    packageStatus: listed.details.packageStatus,
    foregroundJobId: foregroundJob.jobId,
    seedJobId: seedJob.jobId,
    seedRunId: seedJob.packageRunId,
    webJobId: webJob.jobId,
    webRunId: webJob.packageRunId,
    revivedRunId: revived.details.job.packageRunId,
    interruptJobId: interruptJob.jobId,
    interruptedRunId: interruptJob.packageRunId,
    postInterruptRunId: afterInterrupt.details.job.packageRunId,
    foregroundRuntimeAttested: true,
    foregroundPackageOwnedResume: true,
    localReadOnlyBash: true,
    isolatedWebSearch: true,
    isolatedWebFetch: true,
    packageOwnedResume: true,
    packageOwnedInterrupt: true,
    pausedWasNotSuccess: true,
    extensionErrors: [],
    retainedJobs,
    sessionFile: session.sessionFile,
  })}\n`);
} finally {
  await runtime.dispose();
}
