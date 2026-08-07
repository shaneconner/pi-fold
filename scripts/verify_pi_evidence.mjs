#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RESULT_PROJECTION_BYTES,
  TOOL_RESULT_PROJECTION_BYTES,
  pinEvidenceFile,
  registerEvidenceIngestion,
  utf8Head,
  utf8Tail,
  writeEvidenceArtifact,
} from "../.pi/extensions/quorum/evidence.js";
import { stableStringify } from "../.pi/extensions/quorum/json.ts";
import { StdioMcpClient } from "../.pi/extensions/quorum/mcp-client.mjs";

const root = join(tmpdir(), `quorum-evidence-verify-${randomUUID()}`);
const sessionFile = join(root, "session.jsonl");
const sessionId = "evidence-session";
await mkdir(root, { recursive: true });
await writeFile(sessionFile, "", "utf8");

try {
  const unicode = `${"é🙂漢字".repeat(8000)}END`;
  const head = utf8Head(unicode, 4097);
  const tail = utf8Tail(unicode, 4097);
  assert(Buffer.byteLength(head, "utf8") <= 4097);
  assert(Buffer.byteLength(tail, "utf8") <= 4097);
  assert(!head.includes("�") && !tail.includes("�"));
  assert(tail.endsWith("END"));

  const payload = Buffer.from("immutable payload\n", "utf8");
  const [first, second] = await Promise.all([
    writeEvidenceArtifact({
      sessionFile,
      ownerKind: "pi-session",
      ownerId: sessionId,
      bytes: payload,
      mediaType: "text/plain",
      encoding: "utf-8",
      source: { toolName: "read", toolCallId: "dedup-a", artifactKind: "test" },
    }),
    writeEvidenceArtifact({
      sessionFile,
      ownerKind: "pi-session",
      ownerId: sessionId,
      bytes: payload,
      mediaType: "text/plain",
      encoding: "utf-8",
      source: { toolName: "read", toolCallId: "dedup-b", artifactKind: "test" },
    }),
  ]);
  assert.equal(first.path, second.path);
  assert.equal(first.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.deepEqual(await readFile(first.path), payload);
  assert.equal((await stat(first.path)).mode & 0o777, 0o444);

  const mutableSource = join(root, "pi-bash-output.log");
  const fullBash = `${"early\n".repeat(5000)}FINAL\n`;
  await writeFile(mutableSource, fullBash, "utf8");
  const pinned = await pinEvidenceFile({
    sessionFile,
    ownerKind: "pi-session",
    ownerId: sessionId,
    sourcePath: mutableSource,
    source: { toolName: "bash", toolCallId: "bash-pin", artifactKind: "bash-full-output" },
  });
  assert.notEqual(pinned.path, mutableSource);
  assert.equal(await readFile(pinned.path, "utf8"), fullBash);
  assert.equal(pinned.bytes, Buffer.byteLength(fullBash));
  const [sourceIdentity, artifactIdentity] = await Promise.all([stat(mutableSource), stat(pinned.path)]);
  assert(sourceIdentity.dev !== artifactIdentity.dev || sourceIdentity.ino !== artifactIdentity.ino);
  assert.notEqual(sourceIdentity.mode & 0o200, 0);
  assert.equal(artifactIdentity.mode & 0o777, 0o444);
  await writeFile(mutableSource, "mutated", "utf8");
  assert.equal(await readFile(mutableSource, "utf8"), "mutated");
  assert.equal(await readFile(pinned.path, "utf8"), fullBash);
  await writeFile(mutableSource, fullBash, "utf8");

  const handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); } };
  registerEvidenceIngestion(pi, { isMcpTool: (name) => name === "wiki_read" });
  const handler = handlers.get("tool_result");
  assert(handler);
  const ctx = {
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };

  const readText = `${"read-line-é🙂\n".repeat(3000)}read-end`;
  const readProjection = await handler({
    toolName: "read",
    toolCallId: "read-large",
    isError: false,
    content: [{ type: "text", text: readText }],
    details: { truncation: { truncated: true } },
  }, ctx);
  assert(readProjection.details.evidence);
  assert(Buffer.byteLength(readProjection.content[0].text, "utf8") < Buffer.byteLength(readText, "utf8"));
  assert.equal(await readFile(readProjection.details.evidence.path, "utf8"), readText);
  assert.equal(readProjection.details.evidence.projection.sourceBytes, Buffer.byteLength(readText));
  assert(readProjection.details.evidence.projection.replacementBytes > 0);

  const bashProjection = await handler({
    toolName: "bash",
    toolCallId: "bash-large",
    isError: false,
    content: [{ type: "text", text: fullBash.slice(-50_000) }],
    details: { fullOutputPath: mutableSource, truncation: { truncated: true } },
  }, ctx);
  assert.equal(bashProjection.details.fullOutputPath, bashProjection.details.evidence.path);
  assert(bashProjection.content[0].text.includes("FINAL"));
  assert.equal(await readFile(bashProjection.details.evidence.path, "utf8"), fullBash);

  const marker = `mcp-marker-${randomUUID()}`;
  const mcpResult = {
    content: [{ type: "text", text: "bounded lead" }],
    details: { rawResult: { structuredContent: { marker, body: "x".repeat(TOOL_RESULT_PROJECTION_BYTES * 2) } } },
  };
  const mcpProjection = await handler({
    toolName: "wiki_read",
    toolCallId: "mcp-large",
    isError: false,
    ...mcpResult,
  }, ctx);
  assert.equal(mcpProjection.details.mcpServer, "quorum");
  assert(!JSON.stringify(mcpProjection).includes(marker));
  assert((await readFile(mcpProjection.details.evidence.path, "utf8")).includes(marker));

  const agentMarker = `agent-marker-${randomUUID()}`;
  const agentProjection = await handler({
    toolName: "Agent",
    toolCallId: "agent-list-large",
    isError: false,
    content: [{ type: "text", text: "Governed Agent jobs" }],
    details: {
      job: {
        schemaVersion: 2,
        jobId: "job-current",
        packageRunId: "package-run-current",
        status: "completed",
        provider: "openai-codex",
        nodes: [{ id: "node-0", profile: "reviewer", status: "completed", output: `${agentMarker}${"y".repeat(TOOL_RESULT_PROJECTION_BYTES * 2)}` }],
      },
      profiles: [{ name: "reviewer", description: "Read-only reviewer", mode: "read-only", systemPrompt: "secret".repeat(5000) }],
      jobs: [{
        schemaVersion: 2,
        jobId: "job-large",
        packageRunId: "package-run-large",
        status: "completed",
        provider: "openai-codex",
        nodes: [{ id: "node-0", profile: "reviewer", status: "completed", output: `${agentMarker}${"x".repeat(TOOL_RESULT_PROJECTION_BYTES * 2)}` }],
      }],
      packageStatus: "z".repeat(TOOL_RESULT_PROJECTION_BYTES * 2),
    },
  }, ctx);
  assert.equal(agentProjection.details.evidence.owner.kind, "pi-subagents");
  assert.equal(agentProjection.details.evidence.owner.id, "package-run-current");
  assert.equal(agentProjection.details.jobs[0].jobId, "job-large");
  assert(Buffer.byteLength(stableStringify(agentProjection), "utf8") <= AGENT_RESULT_PROJECTION_BYTES);
  assert(!JSON.stringify(agentProjection).includes(agentMarker));
  assert((await readFile(agentProjection.details.evidence.path, "utf8")).includes(agentMarker));

  const ingestionFailureEvent = {
    toolName: "read",
    toolCallId: "ingestion-failure",
    isError: false,
    content: [{ type: "text", text: "q".repeat(TOOL_RESULT_PROJECTION_BYTES * 2) }],
    details: undefined,
  };
  const ingestionFailureBefore = stableStringify(ingestionFailureEvent);
  await assert.rejects(
    handler(ingestionFailureEvent, {
      sessionManager: { getSessionFile: () => undefined, getSessionId: () => sessionId },
    }),
    /absolute Pi session file/,
  );
  assert.equal(stableStringify(ingestionFailureEvent), ingestionFailureBefore);

  const failed = await handler({
    toolName: "read",
    toolCallId: "failed",
    isError: true,
    content: [{ type: "text", text: "x".repeat(TOOL_RESULT_PROJECTION_BYTES * 2) }],
    details: undefined,
  }, ctx);
  assert.equal(failed, undefined);

  const serverScript = join(root, "oversized-mcp-server.mjs");
  await writeFile(serverScript, [
    "process.stdin.once('data', () => {",
    "  const message = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 'x', body: 'x'.repeat(4096) } };",
    "  process.stdout.write(JSON.stringify(message) + '\\n');",
    "});",
  ].join("\n"), "utf8");
  const client = new StdioMcpClient({
    command: process.execPath,
    args: [serverScript],
    cwd: root,
    env: {},
    maxFrameBytes: 1024,
  });
  await assert.rejects(client.start(), /frame exceeds 1024 bytes/);
  await client.close();

  console.log(JSON.stringify({
    ok: true,
    utf8Bounded: true,
    atomicContentAddressedDedup: true,
    immutableBashPin: true,
    boundedReadProjection: true,
    boundedMcpProjection: true,
    boundedAgentProjection: true,
    failedEvidenceStayedRaw: true,
    ingestionFailurePreservedOriginal: true,
    mcpFrameGuardBeforeParse: true,
    digest: first.sha256,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
