#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const probeName = `.pi-readonly-probe-${randomUUID().replaceAll("-", "")}`;
const projectProbe = join(projectRoot, probeName);
const attractorProbe = join(dirname(projectRoot), "attractor", probeName);
const lakeProbe = join(dirname(projectRoot), "quorum-prod-lake", probeName);
const piPackageRoot = "/home/shane/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function executeWrapped(command) {
  return execFileSync("/bin/bash", ["-lc", command], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const jiti = createJiti(import.meta.url);
const { registerChildAgentPolicy, sandboxedReadOnlyCommand } = await jiti.import(
  join(projectRoot, ".pi", "extensions", "quorum", "agent-child.mjs"),
);

for (const path of [projectProbe, attractorProbe, lakeProbe]) rmSync(path, { force: true });

try {
  const direct = sandboxedReadOnlyCommand(
    [
      "test -r AGENTS.md",
      "test -x .venv/bin/python",
      "test -r .pi/pi-subagents/package.json",
      "test -d /home/shane/attractor",
      "test -d /home/shane/quorum-prod-lake",
      "test -z \"${PI_SESSION_ID:-}\"",
      "test ! -e /home/shane/.ssh",
      "test -r \"$PI_CODING_AGENT_ROOT/package.json\"",
      "printf ephemeral > /tmp/read-only-ok",
      "test -s /tmp/read-only-ok",
      `if touch ${JSON.stringify(projectProbe)} 2>/dev/null; then exit 91; fi`,
      `if touch ${JSON.stringify(attractorProbe)} 2>/dev/null; then exit 92; fi`,
      `if touch ${JSON.stringify(lakeProbe)} 2>/dev/null; then exit 93; fi`,
      "printf readonly-ok",
    ].join("; "),
    projectRoot,
    projectRoot,
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      LANG: process.env.LANG,
      TERM: "dumb",
      PI_SESSION_ID: "must-not-leak",
      PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: piPackageRoot,
    },
  );
  assert(executeWrapped(direct) === "readonly-ok", "Direct read-only sandbox did not execute");

  let networkBlocked = false;
  try {
    executeWrapped(sandboxedReadOnlyCommand(
      "/usr/bin/curl --fail --silent --show-error --max-time 2 https://example.com >/dev/null",
      projectRoot,
      projectRoot,
      process.env,
    ));
  } catch {
    networkBlocked = true;
  }
  assert(networkBlocked, "Read-only child unexpectedly reached the network");

  let unixSocketBlocked = false;
  try {
    executeWrapped(sandboxedReadOnlyCommand(
      "/usr/bin/python3.14 -c \"import socket; socket.socket(socket.AF_UNIX)\"",
      projectRoot,
      projectRoot,
      process.env,
    ));
  } catch {
    unixSocketBlocked = true;
  }
  assert(unixSocketBlocked, "Read-only child created an AF_UNIX socket");

  const previousAgent = process.env.PI_SUBAGENT_CHILD_AGENT;
  try {
    const localHandlers = new Map();
    const localTools = new Map();
    process.env.PI_SUBAGENT_CHILD_AGENT = "reviewer";
    registerChildAgentPolicy({
      registerTool(tool) { localTools.set(tool.name, tool); },
      on(event, handler) { localHandlers.set(event, handler); },
    }, { toolSurface: "local" });
    const localToolCall = localHandlers.get("tool_call");
    assert(localToolCall, "Local read-only child policy did not register its tool guard");
    const event = {
      toolName: "bash",
      input: {
        command: [
          "rg -q 'THE WIKI IS THE BIBLE' AGENTS.md",
          "git diff --check",
          "node --check .pi/extensions/quorum/agent.js",
          `if { printf blocked > ${JSON.stringify(projectProbe)}; } 2>/dev/null; then exit 94; fi`,
          "printf hook-readonly-ok",
        ].join("; "),
      },
    };
    const decision = await localToolCall(event, { cwd: projectRoot });
    assert(!decision?.block, `Read-only Bash was blocked: ${decision?.reason ?? "unknown"}`);
    assert(event.input.command.includes("/usr/bin/bwrap"), "Read-only Bash was not rewritten through Bubblewrap");
    assert(event.input.command.includes("--seccomp"), "Read-only Bash omitted seccomp");
    assert(executeWrapped(event.input.command) === "hook-readonly-ok", "Rewritten read-only Bash failed");
    assert(!(await localToolCall({ toolName: "read", input: { path: "AGENTS.md" } }, { cwd: projectRoot }))?.block, "Governed repository read was blocked");
    assert(!(await localToolCall({ toolName: "read", input: { path: "/etc/hosts" } }, { cwd: projectRoot }))?.block, "Local read was unnecessarily narrowed");
    for (const [toolName, input] of [
      ["web_search", { query: "public package documentation" }],
      ["source_check", { claim: "Pi supports extensions" }],
      ["fetch_content", { url: "https://example.com" }],
      ["get_search_content", { responseId: "test" }],
    ]) {
      assert(!(await localToolCall({ toolName, input }, { cwd: projectRoot }))?.block, `Local child cannot use ${toolName}`);
    }
    assert(localTools.has("quorum_commit"), "Child policy registration drifted");

    const webHandlers = new Map();
    process.env.PI_SUBAGENT_CHILD_AGENT = "web-researcher";
    registerChildAgentPolicy({
      registerTool() {},
      on(eventName, handler) { webHandlers.set(eventName, handler); },
    }, { toolSurface: "web" });
    const webToolCall = webHandlers.get("tool_call");
    assert(webToolCall, "Web child policy did not register its tool guard");
    const searchInput = { query: "official Pi coding agent documentation" };
    assert(!(await webToolCall({ toolName: "web_search", input: searchInput }, { cwd: projectRoot }))?.block, "Web search was blocked");
    assert(searchInput.provider === undefined && searchInput.workflow === undefined, "Web search policy forced provider/workflow selection");
    const sourceInput = { claim: "Pi supports extensions" };
    assert(!(await webToolCall({ toolName: "source_check", input: sourceInput }, { cwd: projectRoot }))?.block, "Source check was blocked");
    assert(sourceInput.provider === undefined, "Source check policy forced a provider");
    assert(!(await webToolCall({ toolName: "get_search_content", input: { responseId: "test" } }, { cwd: projectRoot }))?.block, "Stored web evidence paging was blocked");
    const fetchInput = { url: "https://example.com", forceClone: true };
    assert(!(await webToolCall({ toolName: "fetch_content", input: fetchInput }, { cwd: projectRoot }))?.block, "Public HTTP content retrieval was blocked");
    assert(fetchInput.forceClone === false, "Web child can force Git clone persistence");
    assert((await webToolCall({ toolName: "fetch_content", input: { url: "/etc/hosts" } }, { cwd: projectRoot }))?.block, "Web child can fetch local paths");
    for (const [toolName, input] of [
      ["read", { path: "AGENTS.md" }],
      ["bash", { command: "pwd" }],
      ["inspect_repo", { action: "list" }],
      ["wiki_read", { address: "meta" }],
    ]) {
      assert((await webToolCall({ toolName, input }, { cwd: projectRoot }))?.block, `Web child can call forbidden tool ${toolName}`);
    }
    assert(!(await webToolCall({ toolName: "web_search", input: { query: "x", provider: "openai" } }, { cwd: projectRoot }))?.block, "Web child cannot select an available provider");
    assert(!(await webToolCall({ toolName: "web_search", input: { query: "x", includeContent: true } }, { cwd: projectRoot }))?.block, "Web child cannot request remote full-page evidence");
  } finally {
    if (previousAgent === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previousAgent;
  }

  for (const path of [projectProbe, attractorProbe, lakeProbe]) {
    assert(!existsSync(path), `Read-only sandbox mutated ${path}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceReadable: true,
    checksExecutable: true,
    projectWriteBlocked: true,
    dependencyWritesBlocked: true,
    ephemeralTmpWritable: true,
    environmentScrubbed: true,
    networkBlocked: true,
    unixSocketBlocked: true,
    toolCallHookRewritten: true,
    localReadPermissive: true,
    localWebToolsAvailable: true,
    webSearchIsolated: true,
    piRuntimeReadable: true,
  })}\n`);
} finally {
  for (const path of [projectProbe, attractorProbe, lakeProbe]) rmSync(path, { force: true });
}
