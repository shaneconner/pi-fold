import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { denseOwnArrayValues, evidenceValue, isPlainRecord, ownDataProperty, stableStringify } from "./json.ts";
import { DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX, entryTypeNamespace } from "./lib/policy.ts";

export const EVIDENCE_REFERENCE_VERSION = 1;
export const TOOL_RESULT_PROJECTION_BYTES = 16 * 1024;
export const AGENT_RESULT_PROJECTION_BYTES = 24 * 1024;
export const MAX_EVIDENCE_SOURCE_BYTES = 512 * 1024 * 1024;

const AGENT_TEXT_PROJECTION_BYTES = 4 * 1024;
const AGENT_DETAILS_PROJECTION_BYTES = 12 * 1024;
const MAX_AGENT_JOBS = 8;
const MAX_AGENT_NODES_PER_JOB = 4;
const MAX_AGENT_PROFILES = 16;
const OWNER_KINDS = new Set(["pi-session", "pi-subagents", "pi-fold-mcp"]);
const DEFAULT_EVIDENCE_DIRECTORY = "pi-fold-evidence";
const evidenceProjectors = new Map();

export function registerEvidenceProjector(toolName, projector) {
  if (typeof toolName !== "string" || !toolName.trim()) {
    throw new Error("Evidence projector toolName must be a non-empty string");
  }
  if (typeof projector !== "function") {
    throw new Error("Evidence projector must be a function");
  }
  evidenceProjectors.set(toolName, projector);
}

const SOURCE_CHUNK_BYTES = 1024 * 1024;
const defineProperty = Object.defineProperty;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const numberIsSafeInteger = Number.isSafeInteger;
const ownKeys = Reflect.ownKeys;

function appendValue(values, value) {
  defineProperty(values, String(values.length), {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function shortenString(value, maximumBytes) {
  return typeof value === "string" ? utf8Head(value, maximumBytes) : undefined;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

export function utf8Head(value, maximumBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

export function utf8Tail(value, maximumBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) return value;
  let start = source.length - maximumBytes;
  while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1;
  return source.subarray(start).toString("utf8");
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120);
}

function extensionFor(mediaType) {
  if (mediaType === "application/json") return ".json";
  if (mediaType?.startsWith("text/")) return ".txt";
  return ".bin";
}

async function verifyArtifact(path, sha256, bytes) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const file = await handle.stat({ bigint: true });
    if (!file.isFile() || file.size !== BigInt(bytes)) throw new Error(`Evidence artifact size drift at ${path}`);
    const observed = await hashOpenFile(handle, bytes);
    if (observed.bytes !== bytes || observed.sha256 !== sha256) {
      throw new Error(`Evidence artifact digest drift at ${path}`);
    }
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function installTemporary(root, temporary, sha256, bytes, mediaType, ownerKind) {
  const directory = join(root, safeSegment(ownerKind, "owner kind"), "sha256", sha256.slice(0, 2));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${sha256}${extensionFor(mediaType)}`);
  try {
    await link(temporary, path);
    await chmod(path, 0o444);
    await fsyncDirectory(directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await verifyArtifact(path, sha256, bytes);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return path;
}

async function temporaryPath(root) {
  const directory = join(root, ".tmp");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return join(directory, `.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
}

function ownerRoot(
  sessionFile,
  ownerKind,
  evidenceDirectory = DEFAULT_EVIDENCE_DIRECTORY,
  additionalOwnerKind = undefined,
) {
  if (typeof sessionFile !== "string" || !isAbsolute(sessionFile)) {
    throw new Error("Evidence ingestion requires an absolute Pi session file");
  }
  if (!OWNER_KINDS.has(ownerKind) && ownerKind !== additionalOwnerKind) {
    throw new Error(`Unsupported evidence owner kind: ${ownerKind}`);
  }
  if (safeSegment(evidenceDirectory, "evidence directory") !== evidenceDirectory) {
    throw new Error("Evidence directory must be one safe path segment");
  }
  return join(
    dirname(sessionFile),
    ownerKind === "pi-subagents" ? "subagent-artifacts/.evidence" : evidenceDirectory,
  );
}

function baseDescriptor({ ownerKind, ownerId, path, sha256, bytes, mediaType, encoding, source }) {
  return {
    version: EVIDENCE_REFERENCE_VERSION,
    owner: { kind: ownerKind, id: ownerId },
    artifactId: `sha256:${sha256}`,
    path,
    sha256,
    bytes,
    mediaType,
    encoding,
    range: null,
    source,
    projection: {
      strategy: "none",
      sourceBytes: bytes,
      replacementBytes: bytes,
    },
  };
}

export async function writeEvidenceArtifact({
  sessionFile,
  ownerKind,
  ownerId,
  bytes,
  mediaType = "application/octet-stream",
  encoding = "binary",
  source,
  evidenceDirectory = DEFAULT_EVIDENCE_DIRECTORY,
  additionalOwnerKind,
}) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (value.length > MAX_EVIDENCE_SOURCE_BYTES) throw new Error(`Evidence exceeds ${MAX_EVIDENCE_SOURCE_BYTES} bytes`);
  const root = ownerRoot(sessionFile, ownerKind, evidenceDirectory, additionalOwnerKind);
  const temporary = await temporaryPath(root);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const sha256 = createHash("sha256").update(value).digest("hex");
  const path = await installTemporary(root, temporary, sha256, value.length, mediaType, ownerKind);
  return baseDescriptor({ ownerKind, ownerId, path, sha256, bytes: value.length, mediaType, encoding, source });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function hashOpenFile(handle, maximumBytes = MAX_EVIDENCE_SOURCE_BYTES) {
  const hash = createHash("sha256");
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(SOURCE_CHUNK_BYTES, maximumBytes - position + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > maximumBytes) throw new Error(`Evidence source exceeds ${maximumBytes} bytes`);
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { sha256: hash.digest("hex"), bytes: position };
}

async function copyAndHashOpenFile(sourceHandle, destinationHandle, maximumBytes = MAX_EVIDENCE_SOURCE_BYTES) {
  const hash = createHash("sha256");
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(SOURCE_CHUNK_BYTES, maximumBytes - position + 1));
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    if (position + bytesRead > maximumBytes) throw new Error(`Evidence source exceeds ${maximumBytes} bytes`);
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
      if (!result.bytesWritten) throw new Error("Evidence snapshot write made no progress");
      written += result.bytesWritten;
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), bytes: position };
}

export async function pinEvidenceFile({
  sessionFile,
  ownerKind,
  ownerId,
  sourcePath,
  mediaType = "text/plain",
  encoding = "utf-8",
  source,
  evidenceDirectory = DEFAULT_EVIDENCE_DIRECTORY,
  additionalOwnerKind,
}) {
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new Error("Evidence source path must be absolute");
  const canonicalSource = await realpath(sourcePath);
  const root = ownerRoot(sessionFile, ownerKind, evidenceDirectory, additionalOwnerKind);
  const temporary = await temporaryPath(root);
  let sourceHandle;
  let destinationHandle;
  let snapshot;
  let failure;
  try {
    sourceHandle = await open(canonicalSource, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    destinationHandle = await open(temporary, "wx", 0o600);
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`Evidence source is not a regular file: ${canonicalSource}`);
    snapshot = await copyAndHashOpenFile(sourceHandle, destinationHandle);
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    const named = await stat(canonicalSource, { bigint: true });
    if (!sameIdentity(before, after) || !sameIdentity(after, named) || BigInt(snapshot.bytes) !== named.size) {
      throw new Error(`Evidence source changed while snapshotting: ${canonicalSource}`);
    }
  } catch (error) {
    failure = error;
  } finally {
    await sourceHandle?.close().catch((error) => { failure ??= error; });
    await destinationHandle?.close().catch((error) => { failure ??= error; });
  }
  if (failure) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw failure;
  }
  const path = await installTemporary(root, temporary, snapshot.sha256, snapshot.bytes, mediaType, ownerKind);
  return baseDescriptor({
    ownerKind,
    ownerId,
    path,
    sha256: snapshot.sha256,
    bytes: snapshot.bytes,
    mediaType,
    encoding,
    source,
  });
}

function textContent(content) {
  const parts = denseOwnArrayValues(content);
  if (!parts) return "";
  let text = "";
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const value = ownDataProperty(part, "text");
    if (ownDataProperty(part, "type") !== "text" || typeof value !== "string") continue;
    if (text) text += "\n";
    text += value;
  }
  return text;
}

function hasImage(content) {
  const parts = denseOwnArrayValues(content);
  if (!parts) return false;
  for (let index = 0; index < parts.length; index += 1) {
    if (ownDataProperty(parts[index], "type") === "image") return true;
  }
  return false;
}

function referenceLine(descriptor) {
  return `[Exact evidence: ${descriptor.path}; sha256=${descriptor.sha256}; bytes=${descriptor.bytes}]`;
}

function replacementBytes(content, details) {
  return utf8Bytes(stableStringify({ content: evidenceValue(content), details: evidenceValue(details) }));
}

function copyOwnDataRecord(value) {
  const copied = {};
  if (!isPlainRecord(value)) return copied;
  const keys = ownKeys(value);
  for (let index = 0; index < keys.length && index < 64; index += 1) {
    const key = keys[index];
    if (typeof key !== "string") continue;
    const descriptor = getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) continue;
    defineProperty(copied, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copied;
}

export function projectEvidenceText(
  text,
  descriptor,
  strategy,
  originalDetails = undefined,
  tail = false,
  maximumPreviewBytes = TOOL_RESULT_PROJECTION_BYTES,
) {
  const preview = tail ? utf8Tail(text, maximumPreviewBytes) : utf8Head(text, maximumPreviewBytes);
  const content = [{ type: "text", text: `${preview}\n\n${referenceLine(descriptor)}` }];
  const details = copyOwnDataRecord(originalDetails);
  details.evidence = descriptor;
  descriptor.projection.strategy = strategy;
  for (let index = 0; index < 4; index += 1) {
    const next = replacementBytes(content, details);
    if (next === descriptor.projection.replacementBytes) break;
    descriptor.projection.replacementBytes = next;
  }
  return { content, details };
}

function shrinkArray(values) {
  if (values.length > 0) defineProperty(values, "length", { value: values.length - 1, writable: true });
}

function boundedNode(node) {
  if (!isPlainRecord(node)) return undefined;
  const response = ownDataProperty(node, "response");
  return {
    id: shortenString(ownDataProperty(node, "id"), 128),
    profile: shortenString(ownDataProperty(node, "profile"), 96),
    mode: shortenString(ownDataProperty(node, "mode"), 48),
    status: shortenString(ownDataProperty(node, "status"), 64),
    provider: shortenString(ownDataProperty(node, "provider"), 96),
    model: shortenString(ownDataProperty(node, "model"), 160),
    thinking: shortenString(ownDataProperty(node, "thinking"), 48),
    tier: shortenString(ownDataProperty(node, "tier"), 48),
    contractDigest: shortenString(ownDataProperty(node, "contractDigest"), 64),
    launchContractDigest: shortenString(ownDataProperty(node, "launchContractDigest"), 64),
    runId: shortenString(ownDataProperty(response, "runId") ?? ownDataProperty(node, "packageRunId"), 128),
    outputPath: shortenString(ownDataProperty(node, "outputPath"), 512),
    error: shortenString(ownDataProperty(node, "error"), 512),
  };
}

function boundedJob(job) {
  if (!isPlainRecord(job)) return undefined;
  const sourceNodes = denseOwnArrayValues(ownDataProperty(job, "nodes"));
  const nodes = [];
  if (sourceNodes) {
    for (let index = 0; index < sourceNodes.length && nodes.length < MAX_AGENT_NODES_PER_JOB; index += 1) {
      const node = boundedNode(sourceNodes[index]);
      if (node) appendValue(nodes, node);
    }
  }
  return {
    schemaVersion: numberIsSafeInteger(ownDataProperty(job, "schemaVersion")) ? ownDataProperty(job, "schemaVersion") : undefined,
    jobId: shortenString(ownDataProperty(job, "jobId"), 128),
    status: shortenString(ownDataProperty(job, "status"), 64),
    mode: shortenString(ownDataProperty(job, "mode"), 48),
    provider: shortenString(ownDataProperty(job, "provider"), 96),
    parentSessionId: shortenString(ownDataProperty(job, "parentSessionId"), 128),
    createdAt: shortenString(ownDataProperty(job, "createdAt"), 64),
    updatedAt: shortenString(ownDataProperty(job, "updatedAt"), 64),
    packageRunId: shortenString(ownDataProperty(job, "packageRunId"), 128),
    packageAsyncDir: shortenString(ownDataProperty(job, "packageAsyncDir"), 512),
    error: shortenString(ownDataProperty(job, "error"), 512),
    nodesTotal: sourceNodes?.length ?? 0,
    nodes,
  };
}

function boundedAgentDetails(details) {
  if (!isPlainRecord(details)) return {};
  const result = {};
  const job = boundedJob(ownDataProperty(details, "job"));
  if (job) result.job = job;

  const sourceJobs = denseOwnArrayValues(ownDataProperty(details, "jobs"));
  const jobs = [];
  if (sourceJobs) {
    for (let index = 0; index < sourceJobs.length && jobs.length < MAX_AGENT_JOBS; index += 1) {
      const projected = boundedJob(sourceJobs[index]);
      if (projected) appendValue(jobs, projected);
    }
    result.jobs = jobs;
    result.jobsTotal = sourceJobs.length;
    result.jobsShown = jobs.length;
  }

  const sourceProfiles = denseOwnArrayValues(ownDataProperty(details, "profiles"));
  const profiles = [];
  if (sourceProfiles) {
    for (let index = 0; index < sourceProfiles.length && profiles.length < MAX_AGENT_PROFILES; index += 1) {
      const profile = sourceProfiles[index];
      if (!isPlainRecord(profile)) continue;
      appendValue(profiles, {
        name: shortenString(ownDataProperty(profile, "name"), 96),
        description: shortenString(ownDataProperty(profile, "description"), 256),
        mode: shortenString(ownDataProperty(profile, "mode"), 48),
        defaultTier: shortenString(ownDataProperty(profile, "defaultTier"), 48),
      });
    }
    result.profiles = profiles;
    result.profilesTotal = sourceProfiles.length;
    result.profilesShown = profiles.length;
  }

  const workflow = ownDataProperty(details, "workflow");
  if (isPlainRecord(workflow)) {
    result.workflow = {
      mode: shortenString(ownDataProperty(workflow, "mode"), 48),
      packageRunId: shortenString(ownDataProperty(workflow, "packageRunId"), 128),
      packageAsyncDir: shortenString(ownDataProperty(workflow, "packageAsyncDir"), 512),
      status: shortenString(ownDataProperty(workflow, "status"), 64),
    };
  }
  result.packageStatus = shortenString(ownDataProperty(details, "packageStatus"), 512);
  result.jobId = shortenString(ownDataProperty(details, "jobId"), 128);

  while (utf8Bytes(stableStringify(result)) > AGENT_DETAILS_PROJECTION_BYTES) {
    if (jobs.length > 1) {
      shrinkArray(jobs);
      result.jobsShown = jobs.length;
      continue;
    }
    if (job?.nodes?.length > 0) {
      shrinkArray(job.nodes);
      continue;
    }
    if (jobs[0]?.nodes?.length > 0) {
      shrinkArray(jobs[0].nodes);
      continue;
    }
    if (jobs.length > 0) {
      shrinkArray(jobs);
      result.jobsShown = jobs.length;
      continue;
    }
    if (profiles.length > 0) {
      shrinkArray(profiles);
      result.profilesShown = profiles.length;
      continue;
    }
    if (result.packageStatus !== undefined) {
      delete result.packageStatus;
      continue;
    }
    if (result.workflow !== undefined) {
      delete result.workflow;
      continue;
    }
    if (result.job !== undefined) {
      delete result.job;
      continue;
    }
    break;
  }
  return result;
}

function boundedTruncation(value) {
  if (!isPlainRecord(value)) return undefined;
  const bounded = {};
  const stringFields = ["truncatedBy"];
  const integerFields = ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxLines", "maxBytes"];
  const booleanFields = ["truncated", "lastLinePartial", "firstLineExceedsLimit"];
  for (let index = 0; index < stringFields.length; index += 1) {
    const field = stringFields[index];
    const fieldValue = shortenString(ownDataProperty(value, field), 32);
    if (fieldValue !== undefined) bounded[field] = fieldValue;
  }
  for (let index = 0; index < integerFields.length; index += 1) {
    const field = integerFields[index];
    const fieldValue = ownDataProperty(value, field);
    if (numberIsSafeInteger(fieldValue) && fieldValue >= 0) bounded[field] = fieldValue;
  }
  for (let index = 0; index < booleanFields.length; index += 1) {
    const field = booleanFields[index];
    const fieldValue = ownDataProperty(value, field);
    if (typeof fieldValue === "boolean") bounded[field] = fieldValue;
  }
  return bounded;
}

function agentEvidenceOwnerId(details, toolCallId) {
  const job = ownDataProperty(details, "job");
  const workflow = ownDataProperty(details, "workflow");
  const candidates = [
    ownDataProperty(job, "packageRunId"),
    ownDataProperty(workflow, "packageRunId"),
    ownDataProperty(job, "jobId"),
    ownDataProperty(details, "jobId"),
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    const value = shortenString(candidates[index], 128);
    if (value) return value;
  }
  return `tool-call:${safeSegment(toolCallId, "Agent tool call id")}`;
}

function eventEnvelope(event) {
  return {
    version: 1,
    toolName: ownDataProperty(event, "toolName"),
    toolCallId: ownDataProperty(event, "toolCallId"),
    isError: ownDataProperty(event, "isError") === true,
    content: evidenceValue(ownDataProperty(event, "content")),
    details: evidenceValue(ownDataProperty(event, "details")),
  };
}

function mcpServerForTool(toolName, fallback) {
  if (!toolName.startsWith("mcp__")) return fallback;
  const remainder = toolName.slice("mcp__".length);
  const separator = remainder.indexOf("__");
  return separator > 0 && separator < remainder.length - 2
    ? remainder.slice(0, separator)
    : fallback;
}

export function registerEvidenceIngestion(pi, {
  isMcpTool = () => false,
  entryTypePrefix = DEFAULT_ACTIVE_CONTEXT_ENTRY_TYPE_PREFIX,
} = {}) {
  const evidenceNamespace = safeSegment(
    entryTypeNamespace(entryTypePrefix),
    "entry type namespace",
  );
  const mcpOwnerKind = `${evidenceNamespace}-mcp`;
  const evidenceDirectory = `${evidenceNamespace}-evidence`;
  pi.on("tool_result", async (event, ctx) => {
    if (ownDataProperty(event, "isError") === true) return;
    const toolName = ownDataProperty(event, "toolName");
    const toolCallId = ownDataProperty(event, "toolCallId");
    if (typeof toolName !== "string" || typeof toolCallId !== "string") return;
    if (hasImage(ownDataProperty(event, "content"))) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    const details = ownDataProperty(event, "details");
    if (ownDataProperty(details, "evidence") !== undefined) return;
    const fullOutputPath = ownDataProperty(details, "fullOutputPath");

    const projector = evidenceProjectors.get(toolName);
    if (projector) {
      return await projector({ event, ctx, sessionFile, sessionId, details, toolCallId });
    }

    if (toolName === "bash" && typeof fullOutputPath === "string" && isAbsolute(fullOutputPath)) {
      const descriptor = await pinEvidenceFile({
        sessionFile,
        ownerKind: "pi-session",
        ownerId: sessionId,
        sourcePath: fullOutputPath,
        source: { toolName, toolCallId, artifactKind: "bash-full-output" },
        evidenceDirectory,
      });
      const text = textContent(ownDataProperty(event, "content"));
      const truncation = boundedTruncation(ownDataProperty(details, "truncation"));
      const safeDetails = {
        ...(truncation ? { truncation } : {}),
        fullOutputPath: descriptor.path,
      };
      return projectEvidenceText(text, descriptor, "utf8-tail", safeDetails, true);
    }

    const text = textContent(ownDataProperty(event, "content"));
    if (toolName === "read" && utf8Bytes(text) > TOOL_RESULT_PROJECTION_BYTES) {
      const descriptor = await writeEvidenceArtifact({
        sessionFile,
        ownerKind: "pi-session",
        ownerId: sessionId,
        bytes: Buffer.from(text, "utf8"),
        mediaType: "text/plain",
        encoding: "utf-8",
        source: { toolName, toolCallId, artifactKind: "read-result" },
        evidenceDirectory,
      });
      const truncation = boundedTruncation(ownDataProperty(details, "truncation"));
      return projectEvidenceText(text, descriptor, "utf8-head", truncation ? { truncation } : undefined);
    }

    if (isMcpTool(toolName)) {
      const envelope = eventEnvelope(event);
      const serialized = `${stableStringify(envelope)}\n`;
      if (utf8Bytes(serialized) <= TOOL_RESULT_PROJECTION_BYTES) return;
      const descriptor = await writeEvidenceArtifact({
        sessionFile,
        ownerKind: mcpOwnerKind,
        ownerId: `${evidenceNamespace}:${sessionId}`,
        bytes: Buffer.from(serialized, "utf8"),
        mediaType: "application/json",
        encoding: "utf-8",
        source: { toolName, toolCallId, artifactKind: "mcp-tool-result" },
        evidenceDirectory,
        additionalOwnerKind: mcpOwnerKind,
      });
      return projectEvidenceText(text || "Oversized structured MCP result", descriptor, "utf8-head", {
        mcpServer: mcpServerForTool(toolName, evidenceNamespace),
      });
    }
  });
}

registerEvidenceProjector("Agent", async ({ event, ctx, sessionFile, sessionId, details, toolCallId }) => {
  const envelope = eventEnvelope(event);
  const serialized = `${stableStringify(envelope)}\n`;
  if (utf8Bytes(serialized) <= TOOL_RESULT_PROJECTION_BYTES) return;
  const descriptor = await writeEvidenceArtifact({
    sessionFile,
    ownerKind: "pi-subagents",
    ownerId: agentEvidenceOwnerId(details, toolCallId),
    bytes: Buffer.from(serialized, "utf8"),
    mediaType: "application/json",
    encoding: "utf-8",
    source: { toolName: "Agent", toolCallId, artifactKind: "governed-agent-result" },
  });
  const projection = projectEvidenceText(
    textContent(ownDataProperty(event, "content")) || "Governed Agent result",
    descriptor,
    "utf8-head",
    boundedAgentDetails(details),
    false,
    AGENT_TEXT_PROJECTION_BYTES,
  );
  if (utf8Bytes(stableStringify(projection)) > AGENT_RESULT_PROJECTION_BYTES) {
    throw new Error(`Governed Agent evidence projection exceeds ${AGENT_RESULT_PROJECTION_BYTES} bytes`);
  }
  return projection;
});
