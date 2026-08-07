#!/usr/bin/env node

import { rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nonce = randomUUID().replaceAll("-", "");
const stateRoot = join(tmpdir(), `quorum-agent-lifecycle-${nonce}`);
const packageRoot = join(tmpdir(), `pi-subagents-uid-${userInfo().uid}`, "async-subagent-runs");
const parentSessionFile = join(stateRoot, "parent-session.jsonl");
const reviewerProfilePath = join(projectRoot, ".agents", "agents", "reviewer.md");
const reviewerProfileDigest = createHash("sha256").update(readFileSync(reviewerProfilePath)).digest("hex");
const previousStateRoot = process.env.QUORUM_AGENT_STATE_DIR;
const testedCommit = execFileSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function persistJob(metadata) {
  mkdirSync(metadata.jobDir, { recursive: true });
  writeFileSync(join(metadata.jobDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function readJob(jobId) {
  return JSON.parse(readFileSync(join(stateRoot, jobId, "metadata.json"), "utf8"));
}

function baseJob(jobId, overrides = {}) {
  const jobDir = join(stateRoot, jobId);
  return {
    version: 1,
    schemaVersion: 2,
    jobId,
    jobDir,
    status: "failed",
    mode: "single",
    provider: "openai-codex",
    parentSessionId: "parent-session-id",
    parentSessionFile,
    workspaces: [],
    nodes: [{
      index: 0,
      profile: "reviewer",
      profileFilePath: reviewerProfilePath,
      profileContentDigest: reviewerProfileDigest,
      contractDigest: "contract-digest",
      launchContractDigest: "launch-contract-digest",
      agentDefinitionDigest: "agent-definition-digest",
      mode: "read-only",
      provider: "openai-codex",
      tier: "flagship",
      status: "failed",
      fullModel: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      resumeSourceRunId: `source-${jobId}`,
      error: "coordinator interrupted",
    }],
    ...overrides,
  };
}

const rpcRequests = [];
const handlers = new Map();
const tools = new Map();
const pi = {
  events: {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    emit(event, payload) {
      if (event !== "subagents:rpc:v1:request") return;
      rpcRequests.push(payload);
      const data = payload.method === "resume"
        ? {
            text: "Revived async subagent.",
            details: {
              asyncId: `revived-${payload.params.id}`,
              asyncDir: join(packageRoot, `revived-${payload.params.id}`),
              launchContractDigest: "revived-launch-contract-digest",
              sourceLaunchContractDigest: "launch-contract-digest",
            },
          }
        : { text: `Interrupt requested for ${payload.params.id}.`, details: {} };
      queueMicrotask(() => handlers.get(`subagents:rpc:v1:reply:${payload.requestId}`)?.({
        version: 1,
        requestId: payload.requestId,
        method: payload.method,
        success: true,
        data,
      }));
    },
  },
  on(event, handler) {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  async exec(command) {
    if (command === "/usr/bin/python3.14") return { code: 0, stdout: `${stateRoot}\n`, stderr: "" };
    throw new Error(`Unexpected lifecycle verifier command: ${command}`);
  },
};
const ctx = {
  cwd: projectRoot,
  sessionManager: {
    getSessionId: () => "parent-session-id",
    getSessionFile: () => parentSessionFile,
  },
};

process.env.QUORUM_AGENT_STATE_DIR = stateRoot;
mkdirSync(stateRoot, { recursive: true });
writeFileSync(parentSessionFile, "", "utf8");

try {
  const jiti = createJiti(import.meta.url);
  const { registerAgentTool } = await jiti.import(join(projectRoot, ".pi", "extensions", "quorum", "agent.js"));
  registerAgentTool(pi, projectRoot);
  const agent = tools.get("Agent");
  assert(agent, "Agent tool was not registered");

  const resumeJob = baseJob("aaaaaaaaaaaaaaaa");
  await persistJob(resumeJob);
  const resumed = await agent.execute(
    "resume-call",
    { action: "resume", job_id: resumeJob.jobId, message: "Finish the focused review." },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert(!resumed.isError, "Governed resume returned an error");
  const resumedMetadata = readJob(resumeJob.jobId);
  assert(resumedMetadata.status === "running", "Governed resume did not reactivate the job");
  assert(
    resumedMetadata.packageRunId === `revived-source-${resumeJob.jobId}`,
    "Governed resume did not persist the package-owned revival run",
  );
  assert(resumedMetadata.nodes[0].resumeSourceRunId === resumedMetadata.packageRunId, "Node revival target did not advance");
  assert(resumedMetadata.revivals?.[0]?.sourceRunId === `source-${resumeJob.jobId}`, "Revival lineage was not persisted");
  assert(resumedMetadata.revivals?.[0]?.sourceLaunchContractDigest === "launch-contract-digest", "Revival source contract was not preserved");
  assert(resumedMetadata.nodes[0].launchContractDigest === "revived-launch-contract-digest", "Revived launch contract did not advance");
  const resumeRequest = rpcRequests.find((request) => request.method === "resume");
  assert(resumeRequest, "Governed resume did not use package RPC");
  assert(resumeRequest.params.outputMode === "file-only", "Revived output is not file-owned evidence");
  assert(
    resumeRequest.params.output === join(resumeJob.jobDir, "revival-1-output.md"),
    "Revived output escaped the governed job directory",
  );
  const revivedAsyncDir = join(packageRoot, resumedMetadata.packageRunId);
  await mkdir(revivedAsyncDir, { recursive: true });
  await writeFile(resumeRequest.params.output, "revived final answer\n", "utf8");
  await writeFile(
    join(revivedAsyncDir, "status.json"),
    `${JSON.stringify({
      runId: resumedMetadata.packageRunId,
      sessionId: parentSessionFile,
      state: "complete",
      steps: [{
        agent: "reviewer",
        status: "complete",
        model: "openai-codex/gpt-5.6-sol:high",
        thinking: "high",
        launchContractDigest: "revived-launch-contract-digest",
        exitCode: 0,
      }],
    }, null, 2)}\n`,
    "utf8",
  );
  const reconciled = await agent.execute(
    "resume-status",
    { action: "status", job_id: resumeJob.jobId },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert(!reconciled.isError, "Completed revival was not reconciled as success");
  const reconciledMetadata = readJob(resumeJob.jobId);
  assert(reconciledMetadata.status === "completed", "Revived terminal lifecycle did not complete the governed job");
  assert(reconciledMetadata.nodes[0].output === "revived final answer", "Revived final output was not authoritative");
  assert(reconciledMetadata.revivals[0].status === "completed", "Revival lineage did not record terminal success");

  const failedTerminalJob = baseJob("abababababababab", {
    status: "running",
    packageRunId: "failed-terminal-run",
    activePackageNodeIndex: 0,
    packageSpawn: { details: { asyncDir: join(packageRoot, "failed-terminal-run") } },
    packageStartedAt: new Date().toISOString(),
  });
  failedTerminalJob.nodes[0].status = "running";
  failedTerminalJob.nodes[0].outputPath = join(failedTerminalJob.jobDir, "background-output.md");
  await persistJob(failedTerminalJob);
  await mkdir(join(packageRoot, "failed-terminal-run"), { recursive: true });
  await writeFile(failedTerminalJob.nodes[0].outputPath, "must not become success\n", "utf8");
  await writeFile(
    join(packageRoot, "failed-terminal-run", "status.json"),
    `${JSON.stringify({
      runId: "failed-terminal-run",
      sessionId: parentSessionFile,
      state: "complete",
      steps: [{
        agent: "reviewer",
        status: "failed",
        error: "synthetic child failure evidence",
        model: "openai-codex/gpt-5.6-sol:high",
        thinking: "high",
        launchContractDigest: "launch-contract-digest",
        exitCode: 0,
      }],
    }, null, 2)}\n`,
    "utf8",
  );
  const failedTerminal = await agent.execute(
    "failed-terminal-status",
    { action: "status", job_id: failedTerminalJob.jobId },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert(failedTerminal.isError, "Failed package step was mislabeled as governed success");
  const failedTerminalMetadata = readJob(failedTerminalJob.jobId);
  assert(failedTerminalMetadata.status === "failed", "Failed package step completed the governed job");
  assert(failedTerminalMetadata.nodes[0].error.includes("synthetic child failure evidence"), "Package step failure evidence was discarded");

  const stoppedJob = baseJob("bbbbbbbbbbbbbbbb", {
    packageRunId: "source-bbbbbbbbbbbbbbbb",
    packageLifecycle: { state: "stopped" },
  });
  await persistJob(stoppedJob);
  await rejects(
    () => agent.execute(
      "stopped-resume",
      { action: "resume", job_id: stoppedJob.jobId, message: "Continue." },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /stopped and is intentionally non-resumable/,
  );

  const writerJob = baseJob("cccccccccccccccc", {
    nodes: [{
      index: 0,
      profile: "implementer",
      mode: "write",
      status: "failed",
      fullModel: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      resumeSourceRunId: "writer-source",
    }],
  });
  await persistJob(writerJob);
  await rejects(
    () => agent.execute(
      "writer-resume",
      { action: "resume", job_id: writerJob.jobId, message: "Continue." },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /Writer revival is not constructible/,
  );

  const parallelTemplate = baseJob("eeeeeeeeeeeeeeee").nodes[0];
  const parallelJob = baseJob("eeeeeeeeeeeeeeee", {
    mode: "parallel",
    nodes: [
      { ...parallelTemplate, index: 0, resumeSourceRunId: "parallel-source-0" },
      { ...parallelTemplate, index: 1, resumeSourceRunId: "parallel-source-1" },
    ],
  });
  await persistJob(parallelJob);
  await rejects(
    () => agent.execute(
      "parallel-ambiguous-resume",
      { action: "resume", job_id: parallelJob.jobId, message: "Continue." },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /node_index is required/,
  );
  await agent.execute(
    "parallel-indexed-resume",
    { action: "resume", job_id: parallelJob.jobId, node_index: 1, message: "Finish node one." },
    new AbortController().signal,
    undefined,
    ctx,
  );
  const parallelMetadata = readJob(parallelJob.jobId);
  assert(parallelMetadata.activePackageNodeIndex === 1, "Indexed parallel revival targeted the wrong governed node");
  assert(parallelMetadata.revivals[0].sourceRunId === "parallel-source-1", "Indexed parallel revival used a sibling run");

  const interruptJob = baseJob("dddddddddddddddd", {
    status: "running",
    packageRunId: "interrupt-package-run",
    packageSpawn: {
      details: { asyncDir: join(packageRoot, "interrupt-package-run") },
    },
    nodes: [{
      index: 0,
      profile: "reviewer",
      mode: "read-only",
      status: "running",
      fullModel: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      resumeSourceRunId: "interrupt-package-run",
    }],
  });
  await persistJob(interruptJob);
  await mkdir(interruptJob.packageSpawn.details.asyncDir, { recursive: true });
  await writeFile(
    join(interruptJob.packageSpawn.details.asyncDir, "status.json"),
    `${JSON.stringify({
      runId: interruptJob.packageRunId,
      sessionId: parentSessionFile,
      state: "running",
      steps: [{ status: "running" }],
    }, null, 2)}\n`,
    "utf8",
  );
  const interrupted = await agent.execute(
    "interrupt-call",
    { action: "interrupt", job_id: interruptJob.jobId },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert(!interrupted.isError, "Governed interrupt returned an error");
  const interruptedMetadata = readJob(interruptJob.jobId);
  assert(interruptedMetadata.interruptions?.[0]?.runId === interruptJob.packageRunId, "Interrupt lineage was not persisted");
  assert(rpcRequests.some((request) => request.method === "interrupt"), "Governed interrupt did not use package RPC");

  process.stdout.write(`${JSON.stringify({
    ok: true,
    testedCommit,
    packageOwnedResume: true,
    outputConfined: true,
    terminalEvidenceReconciled: true,
    terminalFailureEvidenceRejected: true,
    stoppedNonResumable: true,
    writerRevivalBlocked: true,
    indexedParallelResume: true,
    packageOwnedInterrupt: true,
    ownershipPersisted: true,
  })}\n`);
} finally {
  if (previousStateRoot === undefined) delete process.env.QUORUM_AGENT_STATE_DIR;
  else process.env.QUORUM_AGENT_STATE_DIR = previousStateRoot;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(join(packageRoot, "failed-terminal-run"), { recursive: true, force: true });
  for (const request of rpcRequests) {
    if (request.method === "interrupt") {
      rmSync(join(packageRoot, request.params.id), { recursive: true, force: true });
    } else if (request.method === "resume") {
      rmSync(join(packageRoot, `revived-${request.params.id}`), { recursive: true, force: true });
    }
  }
}
