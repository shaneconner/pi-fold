#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { createJiti } from "../.pi/pi-subagents/node_modules/jiti/lib/jiti.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSandbox(command, workspace, readOnlyBinds = []) {
  const wrapped = sandboxedWriterCommand(command, workspace, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG,
    TERM: "dumb",
    PI_SESSION_ID: "must-not-leak",
  }, readOnlyBinds);
  return execFileSync("/bin/bash", ["-lc", wrapped], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const jiti = createJiti(import.meta.url);
const { registerChildAgentPolicy, sandboxedWriterCommand } = await jiti.import(
  join(projectRoot, ".pi", "extensions", "quorum", "agent-child.mjs"),
);
const { finalizeWorkspace, inspectWorkspace } = await jiti.import(
  join(projectRoot, ".pi", "extensions", "quorum", "agent.js"),
);
const scratchRoot = execFileSync(
  "/usr/bin/python3.14",
  [
    "-c",
    `from config.paths import quorum_tmp_path; print(quorum_tmp_path('pi_writer_sandbox_verify_${process.pid}'))`,
  ],
  { cwd: projectRoot, encoding: "utf8" },
).trim().split("\n").at(-1);
if (!scratchRoot) throw new Error("quorum_tmp_path returned no writer-sandbox scratch root");

rmSync(scratchRoot, { recursive: true, force: true });
const workspace = join(scratchRoot, "worktree");
const outside = join(projectRoot, `.pi-writer-sandbox-forbidden-${process.pid}`);
const stateRoot = execFileSync(
  "/usr/bin/python3.14",
  ["-c", "from config.paths import quorum_data_path; print(quorum_data_path('pi-agents'))"],
  { cwd: projectRoot, encoding: "utf8" },
).trim().split("\n").at(-1);
const jobId = randomUUID().replaceAll("-", "");
const dependencyProbeName = `.writer-probe-${jobId}`;
const jobDir = join(stateRoot, jobId);
mkdirSync(workspace, { recursive: true, mode: 0o700 });
mkdirSync(join(workspace, ".pi"), { recursive: true, mode: 0o700 });
rmSync(outside, { force: true });
symlinkSync(outside, join(workspace, "outside-link"));
const hostServiceRoot = join(scratchRoot, "host-service");
mkdirSync(hostServiceRoot, { recursive: true, mode: 0o700 });
const hostService = createServer((socket) => socket.end("host-service"));
const priorCwd = process.cwd();
process.chdir(hostServiceRoot);
try {
  // A relative bind avoids Linux's 108-byte sockaddr_un limit under long pytest temp roots.
  await new Promise((resolvePromise, rejectPromise) => {
    hostService.once("error", rejectPromise);
    hostService.listen("service.sock", resolvePromise);
  });
} finally {
  process.chdir(priorCwd);
}

try {
  const output = runSandbox(
    [
      "test -r /etc/hostname",
      "test -z \"${PI_SESSION_ID:-}\"",
      "test ! -S /home/shane/quorum-memory/embed.sock",
      "if find / -xdev -type s -print -quit 2>/dev/null | grep -q .; then exit 92; fi",
      "printf %s \"quoted ' payload\" > inside.txt",
      `if printf blocked > ${JSON.stringify(outside)} 2>/dev/null; then exit 91; fi`,
      "if printf blocked > outside-link 2>/dev/null; then exit 93; fi",
      "printf sandbox-ok",
    ].join("; "),
    workspace,
  );
  assert(output === "sandbox-ok", `Unexpected writer sandbox output: ${JSON.stringify(output)}`);
  assert(readFileSync(join(workspace, "inside.txt"), "utf8") === "quoted ' payload", "Writer sandbox lost shell quoting");
  assert(!existsSync(outside), "Writer sandbox wrote outside the authorized worktree");

  assert(existsSync("/usr/bin/curl"), "Writer sandbox verification requires /usr/bin/curl");
  let networkBlocked = false;
  try {
    runSandbox(
      "/usr/bin/curl --fail --silent --show-error --max-time 2 https://example.com >/dev/null",
      workspace,
    );
  } catch {
    networkBlocked = true;
  }
  assert(networkBlocked, "Writer sandbox unexpectedly allowed outbound network access");

  let visibleHostSocketBlocked = false;
  try {
    runSandbox(
      "/usr/bin/python3.14 -c \"import socket; s=socket.socket(socket.AF_UNIX); s.connect('/visible-host-service/service.sock')\"",
      workspace,
      [{ source: hostServiceRoot, target: "/visible-host-service" }],
    );
  } catch {
    visibleHostSocketBlocked = true;
  }
  assert(visibleHostSocketBlocked, "Writer sandbox connected to a deliberately visible host AF_UNIX socket");

  cpSync(join(projectRoot, ".agents"), join(workspace, ".agents"), { recursive: true });
  execFileSync("git", ["-C", workspace, "init", "--quiet"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Quorum Sandbox Verify"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "sandbox-verify@invalid"]);
  writeFileSync(join(workspace, "baseline.txt"), "baseline\n");
  execFileSync("git", ["-C", workspace, "add", "--all"]);
  execFileSync("git", ["-C", workspace, "commit", "--quiet", "-m", "baseline"]);
  const baseCommit = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(workspace, "change.txt"), "governed change\n");

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  mkdirSync(jobDir, { recursive: false, mode: 0o700 });
  writeFileSync(
    join(jobDir, "metadata.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      jobId,
      status: "running",
      workspaces: [{
        id: "workspace-0",
        path: workspace,
        repo: projectRoot,
        authorized: true,
        allowedProfiles: ["implementer"],
      }],
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(event, handler) { handlers.set(event, handler); },
    async exec(command, args, options = {}) {
      if (command === "/usr/bin/python3.14" && args.includes("-c")) {
        return { code: 0, stdout: `${stateRoot}\n`, stderr: "", killed: false };
      }
      try {
        const stdout = execFileSync(command, args, {
          cwd: options.cwd,
          encoding: "utf8",
          timeout: options.timeout,
        });
        return { code: 0, stdout, stderr: "", killed: false };
      } catch (error) {
        return {
          code: Number.isInteger(error.status) ? error.status : 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
          killed: Boolean(error.killed),
        };
      }
    },
  };
  const priorChild = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "implementer";
  try {
    registerChildAgentPolicy(pi, { toolSurface: "local" });
    const toolCall = handlers.get("tool_call");
    assert(toolCall, "Child policy did not register its tool_call guard");
    assert(
      (await toolCall({ toolName: "write", input: { path: "direct.txt", content: "blocked" } }, { cwd: workspace }))?.block,
      "Writer exposed direct file mutation outside the Bubblewrap boundary",
    );
    assert(
      (await toolCall({ toolName: "write", input: { path: outside, content: "blocked" } }, { cwd: workspace }))?.block,
      "Writer direct file tool can escape its authorized worktree",
    );
    const symlinkDecision = await toolCall(
      { toolName: "write", input: { path: "outside-link", content: "blocked" } },
      { cwd: workspace },
    );
    if (!symlinkDecision?.block) writeFileSync(join(workspace, "outside-link"), "escaped\n");
    assert(symlinkDecision?.block && !existsSync(outside), "Writer direct file tool followed an escaping symlink");
    const bashEvent = {
      toolName: "bash",
      input: {
        command: [
          "test -x .venv/bin/python",
          "test -r .pi/npm/package.json",
          "test -d /home/shane/attractor",
          "test -d /home/shane/quorum-prod-lake",
          `if touch .venv/${dependencyProbeName} 2>/dev/null; then exit 94; fi`,
          `if touch .pi/npm/${dependencyProbeName} 2>/dev/null; then exit 95; fi`,
          `if touch /home/shane/attractor/${dependencyProbeName} 2>/dev/null; then exit 96; fi`,
          `if touch /home/shane/quorum-prod-lake/${dependencyProbeName} 2>/dev/null; then exit 97; fi`,
          "if { printf blocked > outside-link; } 2>/dev/null; then exit 98; fi",
          "printf hook-ok > hook.txt",
        ].join("; "),
      },
    };
    const decision = await toolCall(bashEvent, { cwd: workspace });
    assert(!decision?.block, `Authorized writer bash was blocked: ${decision?.reason ?? "unknown"}`);
    assert(bashEvent.input.command.includes("/usr/bin/bwrap"), "Writer bash hook did not rewrite the command");
    execFileSync("/bin/bash", ["-lc", bashEvent.input.command], { cwd: workspace });
    assert(readFileSync(join(workspace, "hook.txt"), "utf8") === "hook-ok", "Rewritten writer bash did not execute");

    const commitTool = tools.get("quorum_commit");
    assert(commitTool, "Child policy did not register quorum_commit");
    await commitTool.execute("verify-commit", { message: "verify controlled commit" }, undefined, undefined, {
      cwd: workspace,
    });
  } finally {
    if (priorChild === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = priorChild;
  }
  const committed = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["-C", workspace, "status", "--porcelain=v1"], { encoding: "utf8" }).trim();
  assert(committed !== baseCommit, "quorum_commit did not create a descendant commit");
  assert(status === "", `quorum_commit left a dirty worktree: ${status}`);

  const identityRepo = join(scratchRoot, "identity-repo");
  const foreignRepo = join(scratchRoot, "foreign-repo");
  const identityWorktree = join(scratchRoot, "identity-worktree");
  for (const repo of [identityRepo, foreignRepo]) {
    mkdirSync(repo, { recursive: true, mode: 0o700 });
    execFileSync("git", ["-C", repo, "init", "--quiet"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Quorum Sandbox Verify"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "sandbox-verify@invalid"]);
    writeFileSync(join(repo, "base.txt"), `${repo}\n`);
    execFileSync("git", ["-C", repo, "add", "--all"]);
    execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "baseline"]);
  }
  const identityBase = execFileSync("git", ["-C", identityRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const identityBranch = "quorum-agent/identity-check";
  execFileSync("git", ["-C", identityRepo, "worktree", "add", "--quiet", "-b", identityBranch, identityWorktree, identityBase]);
  const workspaceRecord = {
    path: identityWorktree,
    repo: identityRepo,
    branch: identityBranch,
    baseCommit: identityBase,
    worktreeGitDir: execFileSync(
      "git",
      ["-C", identityWorktree, "rev-parse", "--path-format=absolute", "--absolute-git-dir"],
      { encoding: "utf8" },
    ).trim(),
    worktreeCommonDir: execFileSync(
      "git",
      ["-C", identityWorktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8" },
    ).trim(),
    authorized: true,
    preserved: true,
  };
  const cleanIdentity = await inspectWorkspace(pi, workspaceRecord);
  assert(!cleanIdentity.identityDrifted, "Clean linked-worktree identity was rejected");

  writeFileSync(join(identityWorktree, "dirty.txt"), "uncommitted\n");
  const finalizedDirty = await finalizeWorkspace(pi, { ...workspaceRecord }, true);
  assert(finalizedDirty.preserved && finalizedDirty.dirty, "Dirty worktree was not preserved");
  assert(
    finalizedDirty.policyFailure?.includes("staged, unstaged, or unmerged"),
    `Dirty worktree did not produce a policy failure: ${finalizedDirty.policyFailure ?? "missing"}`,
  );
  rmSync(join(identityWorktree, "dirty.txt"));

  writeFileSync(join(identityWorktree, "child.txt"), "descendant\n");
  execFileSync("git", ["-C", identityWorktree, "add", "--all"]);
  execFileSync("git", ["-C", identityWorktree, "commit", "--quiet", "-m", "child descendant"]);
  writeFileSync(join(identityRepo, "coordinator.txt"), "advanced\n");
  execFileSync("git", ["-C", identityRepo, "add", "--all"]);
  execFileSync("git", ["-C", identityRepo, "commit", "--quiet", "-m", "advance coordinator"]);
  const finalizedBaseDrift = await finalizeWorkspace(pi, { ...workspaceRecord }, true);
  assert(finalizedBaseDrift.preserved && finalizedBaseDrift.baseDrifted, "Coordinator-base drift was not preserved");
  assert(
    finalizedBaseDrift.policyFailure?.includes("coordinator HEAD drifted"),
    `Base drift did not produce a policy failure: ${finalizedBaseDrift.policyFailure ?? "missing"}`,
  );

  writeFileSync(join(identityWorktree, ".git"), `gitdir: ${join(foreignRepo, ".git")}\n`);
  const driftedIdentity = await inspectWorkspace(pi, workspaceRecord);
  assert(driftedIdentity.identityDrifted, "Foreign Git administrative directory was not detected");
  const finalizedIdentity = await finalizeWorkspace(pi, { ...workspaceRecord }, true);
  assert(finalizedIdentity.preserved, "Identity-drifted worktree was not preserved");
  assert(
    finalizedIdentity.policyFailure?.includes("administrative identity"),
    `Identity drift did not produce a policy failure: ${finalizedIdentity.policyFailure ?? "missing"}`,
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      workspace,
      outsideWriteBlocked: true,
      symlinkEscapeBlocked: true,
      networkBlocked: true,
      hostSocketsHidden: true,
      visibleHostSocketBlocked: true,
      toolCallHookRewritten: true,
      readOnlyDependencyBindsVerified: true,
      controlledCommit: true,
      dirtyWorktreePreserved: true,
      baseDriftPreserved: true,
      gitIdentityDriftBlocked: true,
    })}\n`,
  );
} finally {
  await new Promise((resolvePromise) => hostService.close(resolvePromise));
  for (const root of [
    join(projectRoot, ".venv"),
    join(projectRoot, ".pi", "npm"),
    join(projectRoot, "..", "attractor"),
    join(projectRoot, "..", "quorum-prod-lake"),
  ]) {
    rmSync(join(root, dependencyProbeName), { force: true });
  }
  rmSync(outside, { force: true });
  rmSync(jobDir, { recursive: true, force: true });
  rmSync(scratchRoot, { recursive: true, force: true });
}
