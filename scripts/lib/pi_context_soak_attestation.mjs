import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync,
  readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * The launch identity, read from the password database rather than from $HOME.
 *
 * This is deliberate and load-bearing. The sanitized-environment check below asserts that
 * HOME is pinned to an expected value; deriving that expectation from process.env.HOME
 * would compare the variable under test against itself and assert nothing at all. userInfo()
 * reads the passwd entry for the real uid, so the pin still means what it says on any
 * machine, and the harness stops encoding one operator's home directory in its source.
 */
const IDENTITY = userInfo();
export const RUNTIME_HOME = IDENTITY.homedir;
export const RUNTIME_USER = IDENTITY.username;
export const RUNTIME_XDG_DIR = `/run/user/${IDENTITY.uid}`;
/** Where the Pi build under measurement is installed, relative to that same identity. */
export const PI_INSTALL_ROOT =
  join(RUNTIME_HOME, ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent");

export const SOAK_PROTOCOL_VERSION = 1;
export const SOAK_MODE_ACCEPTANCE = "acceptance";
export const SOAK_MODE_CALIBRATION = "calibration";
export const SOAK_MODE_VERIFICATION = "verification";
export const SOAK_STAGE_COUNT = 19;
export const SOAK_CALIBRATION_STAGE_COUNT = 8;
export const SOAK_CALIBRATION_STAGE_INTERVAL_MS = 60_000;
export const SOAK_CALIBRATION_WATCHDOG_MS = 30 * 60 * 1_000;
export const SOAK_CALIBRATION_HEARTBEAT_MS = 5_000;
export const SOAK_STAGE_INTERVAL_MS = 10 * 60 * 1_000;
export const SOAK_MIN_DURATION_MS = 3 * 60 * 60 * 1_000;
export const SOAK_PACING_FLOOR_MS = SOAK_STAGE_COUNT * SOAK_STAGE_INTERVAL_MS;
export const SOAK_WATCHDOG_MS = 255 * 60 * 1_000;
export const SOAK_HEARTBEAT_MS = 30_000;
export const SOAK_MAX_HEARTBEAT_GAP_MS = 90_000;
export const SOAK_STAGE_CHARS = 30_000;
export const SOAK_VERIFICATION_STAGE_INTERVAL_MS = 1_000;
export const SOAK_VERIFICATION_WATCHDOG_MS = 8 * 60 * 1_000;
export const SOAK_VERIFICATION_HEARTBEAT_MS = 2_000;
export const SOAK_MIN_DURABLE_FOLDS = 1;
export const SOAK_TERMINAL_STABILIZATION_MS = 2 * 60 * 1_000;
export const SOAK_TOOL_NAME = "archive_stage";
// This is a model-call policy, not a claim about the runtime's registered schema.
export const SOAK_MODEL_CONTEXT_ACTIONS = Object.freeze(["status", "fold"]);
export const SOAK_BEHAVIORAL_MODE = "extension-advisory-supervised-archive";
export const SOAK_RUNNER_MODE = "systemd-supervised-single-session";
export const SOAK_SANITIZED_ENV_MARKER = "PI_FOLD_SANITIZED";
export const SOAK_FORBIDDEN_ENV_KEYS = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "BASH_ENV", "ENV", "NODE_TLS_REJECT_UNAUTHORIZED",
  "PI_CODING_AGENT_DIR", "OPENAI_BASE_URL", "OPENAI_API_BASE", "HTTP_PROXY", "HTTPS_PROXY",
  "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CEILING_DIRECTORIES", "GIT_NAMESPACE",
]);

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_32 = /^[0-9a-f]{32}$/;
const RUN_ID = /^[0-9TZ_.:-]+-[0-9a-f]{12}$/;
const UNIT = /^pi-fold-context-soak-[a-z0-9_.@-]+\.service$/;

export function assertSoak(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertSanitizedRuntimeEnvironment(environment, { requireMarker = true } = {}) {
  assertSoak(environment && typeof environment === "object", "Invalid runtime environment");
  const present = SOAK_FORBIDDEN_ENV_KEYS.filter((key) => Object.hasOwn(environment, key));
  assertSoak(present.length === 0, `Unsafe inherited soak environment: ${present.join(",")}`);
  if (requireMarker) {
    assertSoak(environment[SOAK_SANITIZED_ENV_MARKER] === "1",
      "Soak runtime lacks its sanitized-environment launch marker");
    assertSoak(environment.PATH === "/usr/local/bin:/usr/bin:/bin" &&
      environment.HOME === RUNTIME_HOME && environment.XDG_RUNTIME_DIR === RUNTIME_XDG_DIR,
    "Soak runtime PATH/HOME/XDG runtime are not pinned");
  }
  return true;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value) {
  assertSoak(typeof value === "string", "sha256Text requires a string");
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function sha256Json(value) {
  return sha256Text(JSON.stringify(value));
}

export function fileSha256(path) {
  return sha256Bytes(readFileSync(path));
}

export function directoryTreeSha256(root) {
  assertSoak(typeof root === "string" && existsSync(root), `Missing dependency tree ${root}`);
  const hash = createHash("sha256");
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        hash.update(`D\0${relative}\0${stat.mode & 0o777}\n`);
        walk(path, relative);
      } else if (stat.isFile()) {
        hash.update(`F\0${relative}\0${stat.mode & 0o777}\0${stat.size}\0`);
        hash.update(fileSha256(path));
        hash.update("\n");
      } else if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        assertSoak(!target.startsWith("/"), `Dependency tree contains an absolute symlink: ${relative}`);
        hash.update(`L\0${relative}\0${target}\n`);
      } else {
        throw new Error(`Dependency tree contains an unsupported inode: ${relative}`);
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

export function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function freshChallenge() {
  return randomBytes(32).toString("hex");
}

export function monotonicMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function durableWrite(path, text, flags = "wx", mode = 0o600) {
  const fd = openSync(path, flags, mode);
  try {
    const buffer = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      assertSoak(written > 0, `Durable write made no progress: ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeJsonExclusive(path, value) {
  durableWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonPublished(path, value) {
  const temporary = `${path}.pending-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    // The final path is an O_EXCL-style hard-link publication of an already
    // complete, fsynced inode. Readers can observe ENOENT or the whole JSON,
    // never the partially written final path that writeJsonExclusive exposes.
    durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
    linkSync(temporary, path);
    unlinkSync(temporary);
    const directoryFd = openSync(dirname(path), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export function validateTerminalAcceptanceSeal(value) {
  assertSoak(exactKeys(value, [
    "version", "terminal", "runId", "codeCommit", "evidenceSha256", "manifestSha256",
    "sealedWallMs", "acceptance",
  ]) && value.version === 1 && value.terminal === true && value.acceptance === true &&
    typeof value.runId === "string" && value.runId.length > 0 &&
    /^[0-9a-f]{40}$/.test(value.codeCommit) && HEX_64.test(value.evidenceSha256) &&
    HEX_64.test(value.manifestSha256) && Number.isSafeInteger(value.sealedWallMs) &&
    value.sealedWallMs > 0,
  "Invalid terminal acceptance seal");
  return structuredClone(value);
}

export function writeTerminalAcceptanceSeal(path, value) {
  validateTerminalAcceptanceSeal(value);
  assertSoak(exactKeys(value, [
    "version", "terminal", "runId", "codeCommit", "evidenceSha256", "manifestSha256",
    "sealedWallMs", "acceptance",
  ]) && value.version === 1 && value.terminal === true && value.acceptance === true &&
    Object.keys(value).at(-1) === "acceptance",
  "Invalid terminal acceptance seal shape or publication order");
  // The canonical path is created with O_EXCL and the acceptance bit is the
  // final JSON field. A crash before that field leaves only invalid,
  // non-authorizing JSON; there is no pre-seal true-bearing temp file.
  writeJsonExclusive(path, value);
  const directoryFd = openSync(dirname(path), "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  durableWrite(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
  const directoryFd = openSync(dirname(path), "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

export function appendJsonLineFsync(path, value) {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return [];
  return text.trimEnd().split("\n").map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`Invalid JSONL ${path}:${index + 1}: ${String(error)}`); }
  });
}

export function processStartTicks(pid) {
  assertSoak(Number.isSafeInteger(pid) && pid > 0, "Invalid process PID");
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").trim().split(" ");
  const ticks = Number(fields[21]);
  assertSoak(Number.isSafeInteger(ticks) && ticks > 0, `Invalid start ticks for PID ${pid}`);
  return ticks;
}

export function bootId() {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  assertSoak(/^[0-9a-f-]{36}$/.test(value), "Invalid Linux boot ID");
  return value;
}

export function assertRunId(value) {
  assertSoak(typeof value === "string" && RUN_ID.test(value), "Invalid soak run ID");
  return value;
}

export function assertUnitName(value) {
  assertSoak(typeof value === "string" && UNIT.test(value), "Invalid soak systemd unit");
  return value;
}

export function parseSystemdShow(text) {
  const result = {};
  for (const line of String(text).trim().split("\n")) {
    if (!line) continue;
    const split = line.indexOf("=");
    assertSoak(split > 0, `Invalid systemd property: ${line}`);
    result[line.slice(0, split)] = line.slice(split + 1);
  }
  return result;
}

export function parseSystemdExecStart(value) {
  const match = /^\{ path=([^ ;]+) ; argv\[\]=(.+?) ; ignore_errors=/.exec(String(value));
  assertSoak(match && match[1] === "/usr/bin/node", "Systemd executable path is not exact stock Node");
  const argv = match[2].trim().split(/ +/u);
  assertSoak(argv.every((part) => part && !part.includes("\\x")),
    "Systemd argv uses unsupported escaping");
  return { path: match[1], argv };
}

export function validateRunConfig(value, { allowCalibration = true } = {}) {
  const keys = [
    "version", "runId", "runDir", "mode", "unit", "invocationId", "supervisorPid",
    "supervisorStartTicks", "bootId", "codeCommit", "codeTree", "firstChallenge",
    "stageCount", "stageIntervalMs", "minimumDurationMs", "watchdogMs", "heartbeatMs",
    "createdWallMs", "createdMonotonicMs", "sourceHashes", "dependencyHashes", "calibration",
  ];
  assertSoak(exactKeys(value, keys), "Invalid soak run config shape");
  assertSoak(value.version === SOAK_PROTOCOL_VERSION, "Soak config version drifted");
  assertRunId(value.runId);
  assertSoak(typeof value.runDir === "string" && value.runDir.endsWith(`/${value.runId}`),
    "Soak run directory drifted");
  assertSoak(value.mode === SOAK_MODE_ACCEPTANCE ||
    (allowCalibration && [SOAK_MODE_CALIBRATION, SOAK_MODE_VERIFICATION].includes(value.mode)),
    "Invalid soak mode");
  assertUnitName(value.unit);
  assertSoak(HEX_32.test(value.invocationId), "Invalid systemd invocation ID");
  assertSoak(Number.isSafeInteger(value.supervisorPid) && value.supervisorPid > 0 &&
    Number.isSafeInteger(value.supervisorStartTicks) && value.supervisorStartTicks > 0,
  "Invalid supervisor process identity");
  assertSoak(/^[0-9a-f-]{36}$/.test(value.bootId), "Invalid config boot ID");
  assertSoak(/^[0-9a-f]{40}$/.test(value.codeCommit) && /^[0-9a-f]{40}$/.test(value.codeTree),
    "Invalid source commit/tree");
  assertSoak(HEX_64.test(value.firstChallenge), "Invalid first challenge");
  if (value.mode === SOAK_MODE_ACCEPTANCE) {
    assertSoak(value.stageCount === SOAK_STAGE_COUNT && value.stageIntervalMs === SOAK_STAGE_INTERVAL_MS &&
      value.minimumDurationMs === SOAK_MIN_DURATION_MS && value.watchdogMs === SOAK_WATCHDOG_MS &&
      value.heartbeatMs === SOAK_HEARTBEAT_MS,
    "Acceptance soak constants drifted");
    assertSoak(exactKeys(value.calibration, [
      "runId", "candidateReportSha256", "evidenceSha256", "projectedWallClockMs",
      "providerTurnP95Ms", "projectedProviderTurns", "observedSealingMs", "accepted",
    ]) && value.calibration.accepted === true &&
      RUN_ID.test(value.calibration.runId) && HEX_64.test(value.calibration.candidateReportSha256) &&
      HEX_64.test(value.calibration.evidenceSha256) &&
      Number.isSafeInteger(value.calibration.projectedWallClockMs) &&
      value.calibration.projectedWallClockMs <= SOAK_WATCHDOG_MS &&
      Number.isSafeInteger(value.calibration.providerTurnP95Ms) && value.calibration.providerTurnP95Ms > 0 &&
      Number.isSafeInteger(value.calibration.projectedProviderTurns) && value.calibration.projectedProviderTurns > 0 &&
      Number.isSafeInteger(value.calibration.observedSealingMs) && value.calibration.observedSealingMs >= 0,
    "Acceptance soak lacks a passing calibration attestation");
  } else if (value.mode === SOAK_MODE_CALIBRATION) {
    assertSoak(value.stageCount === SOAK_CALIBRATION_STAGE_COUNT &&
      value.stageIntervalMs === SOAK_CALIBRATION_STAGE_INTERVAL_MS &&
      value.minimumDurationMs === 0 && value.watchdogMs === SOAK_CALIBRATION_WATCHDOG_MS &&
      value.heartbeatMs === SOAK_CALIBRATION_HEARTBEAT_MS && value.calibration === null,
    "Calibration soak constants are invalid");
  } else {
    assertSoak(value.stageCount === SOAK_STAGE_COUNT &&
      value.stageIntervalMs === SOAK_VERIFICATION_STAGE_INTERVAL_MS &&
      value.minimumDurationMs === 0 && value.watchdogMs === SOAK_VERIFICATION_WATCHDOG_MS &&
      value.heartbeatMs === SOAK_VERIFICATION_HEARTBEAT_MS && value.calibration === null,
    "Verification soak constants are invalid");
  }
  assertSoak(Number.isSafeInteger(value.createdWallMs) && value.createdWallMs > 0 &&
    Number.isSafeInteger(value.createdMonotonicMs) && value.createdMonotonicMs > 0,
  "Invalid soak creation clocks");
  assertSoak(value.sourceHashes && typeof value.sourceHashes === "object" && !Array.isArray(value.sourceHashes) &&
    Object.keys(value.sourceHashes).length >= 6 && Object.values(value.sourceHashes).every((hash) => HEX_64.test(hash)),
  "Invalid soak source hashes");
  assertSoak(exactKeys(value.dependencyHashes, [
    "piPackageJson", "piDistTree", "piNodeModulesTree", "piSubagentsPackageJson",
    "piSubagentsSrcTree", "nodeExecutable",
  ]) && Object.values(value.dependencyHashes).every((hash) => HEX_64.test(hash)),
  "Invalid soak dependency hashes");
  return structuredClone(value);
}

export function paceRecordIdentity(record) {
  const { recordSha256: _ignored, ...identity } = record;
  return sha256Json(identity);
}

export function validatePaceRecords(records, config) {
  validateRunConfig(config);
  assertSoak(Array.isArray(records) && records.length === config.stageCount,
    `Pace record count drifted: ${records?.length}/${config.stageCount}`);
  let previousSha = null;
  let previousRelease = config.createdMonotonicMs;
  let expectedChallengeSha256 = sha256Text(config.firstChallenge);
  const seenChallenges = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertSoak(exactKeys(record, [
      "version", "runId", "stage", "challengeSha256", "requestSha256", "responseSha256",
      "contentSha256", "nextChallengeSha256", "requestedWallMs", "requestedMonotonicMs",
      "releasedWallMs", "releasedMonotonicMs", "priorRecordSha256", "recordSha256",
    ]), `Invalid pace record shape at ${index + 1}`);
    assertSoak(record.version === 1 && record.runId === config.runId && record.stage === index + 1 &&
      HEX_64.test(record.challengeSha256) && HEX_64.test(record.requestSha256) &&
      HEX_64.test(record.responseSha256) && HEX_64.test(record.contentSha256) &&
      HEX_64.test(record.nextChallengeSha256) && record.priorRecordSha256 === previousSha &&
      record.recordSha256 === paceRecordIdentity(record) &&
      record.challengeSha256 === expectedChallengeSha256,
    `Pace identity drift at stage ${index + 1}`);
    assertSoak(!seenChallenges.has(record.challengeSha256), `Reused stage challenge ${index + 1}`);
    seenChallenges.add(record.challengeSha256);
    assertSoak(Number.isSafeInteger(record.requestedWallMs) && Number.isSafeInteger(record.releasedWallMs) &&
      Number.isSafeInteger(record.requestedMonotonicMs) && Number.isSafeInteger(record.releasedMonotonicMs) &&
      record.requestedMonotonicMs <= record.releasedMonotonicMs,
    `Invalid pace clocks at stage ${index + 1}`);
    assertSoak(record.releasedMonotonicMs - previousRelease >= config.stageIntervalMs,
      `Stage ${index + 1} released before its external pacing gate`);
    previousRelease = record.releasedMonotonicMs;
    previousSha = record.recordSha256;
    expectedChallengeSha256 = record.nextChallengeSha256;
  }
  const elapsedMs = records.at(-1).releasedMonotonicMs - config.createdMonotonicMs;
  if (config.mode === SOAK_MODE_ACCEPTANCE) {
    assertSoak(elapsedMs >= SOAK_PACING_FLOOR_MS && elapsedMs >= SOAK_MIN_DURATION_MS,
      `Soak pacing duration is too short: ${elapsedMs}`);
  }
  return { elapsedMs, finalRecordSha256: previousSha, stages: records.length };
}

export function validateExternalClockBounds({
  config, systemdStartMonotonicMs, systemdExitMonotonicMs, paceRecords, heartbeatRecords,
  supervisor, worker,
}) {
  assertSoak(Number.isSafeInteger(systemdStartMonotonicMs) &&
    Number.isSafeInteger(systemdExitMonotonicMs) && systemdExitMonotonicMs > systemdStartMonotonicMs,
  "Invalid external systemd monotonic bounds");
  assertSoak(config.createdMonotonicMs >= systemdStartMonotonicMs &&
    config.createdMonotonicMs - systemdStartMonotonicMs <= 2 * 60 * 1_000,
  "Soak creation clock is not bound to systemd start");
  const monotonicValues = [
    ...paceRecords.flatMap((record) => [record.requestedMonotonicMs, record.releasedMonotonicMs]),
    ...heartbeatRecords.map((record) => record.monotonicMs),
    supervisor?.startedMonotonicMs,
    supervisor?.finishedMonotonicMs,
    worker?.workerStartedMonotonicMs,
    worker?.workerFinishedMonotonicMs,
  ];
  assertSoak(monotonicValues.every((value) => Number.isSafeInteger(value) &&
    value >= systemdStartMonotonicMs && value <= systemdExitMonotonicMs),
  "Soak artifact clock falls outside the retained systemd interval");
  let priorWall = config.createdWallMs;
  for (const record of paceRecords) {
    assertSoak(Number.isSafeInteger(record.requestedWallMs) && Number.isSafeInteger(record.releasedWallMs) &&
      record.requestedWallMs >= priorWall && record.releasedWallMs >= record.requestedWallMs,
    `Pace wall clock moved backwards at stage ${record.stage}`);
    priorWall = record.releasedWallMs;
  }
  let priorHeartbeatWall = config.createdWallMs;
  for (const record of heartbeatRecords) {
    assertSoak(Number.isSafeInteger(record.wallMs) && record.wallMs >= priorHeartbeatWall,
      `Heartbeat wall clock moved backwards at ordinal ${record.ordinal}`);
    priorHeartbeatWall = record.wallMs;
  }
  return {
    startMonotonicMs: systemdStartMonotonicMs,
    exitMonotonicMs: systemdExitMonotonicMs,
  };
}

export function validateHeartbeatRecords(records, config, finalMonotonicMs) {
  assertSoak(Array.isArray(records) && records.length > 0, "Soak heartbeat trace is empty");
  let previous = config.createdMonotonicMs;
  let previousSha = null;
  for (const [index, record] of records.entries()) {
    assertSoak(exactKeys(record, [
      "version", "runId", "ordinal", "wallMs", "monotonicMs", "workerPid", "workerStartTicks",
      "sessionBytes", "sessionMtimeMs", "priorRecordSha256", "recordSha256",
    ]), `Invalid heartbeat shape ${index + 1}`);
    const { recordSha256, ...identity } = record;
    assertSoak(record.version === 1 && record.runId === config.runId && record.ordinal === index + 1 &&
      record.priorRecordSha256 === previousSha && recordSha256 === sha256Json(identity) &&
      Number.isSafeInteger(record.monotonicMs) && record.monotonicMs > previous &&
      record.monotonicMs - previous <= SOAK_MAX_HEARTBEAT_GAP_MS,
    `Heartbeat chain drift at ${index + 1}`);
    previous = record.monotonicMs;
    previousSha = recordSha256;
  }
  assertSoak(finalMonotonicMs - previous <= SOAK_MAX_HEARTBEAT_GAP_MS,
    "Final soak heartbeat gap is too large");
  return { count: records.length, finalRecordSha256: previousSha };
}

export function validateProviderExchange(records) {
  assertSoak(Array.isArray(records), "Invalid provider exchange ledger");
  const io = records.filter((record) =>
    record?.kind === "provider-request" || record?.kind === "provider-response");
  assertSoak(io.length > 0 && io.length % 2 === 0, "Provider exchange ledger is incomplete");
  const pairs = [];
  const requestIds = new Set();
  const responseIds = new Set();
  for (let index = 0; index < io.length; index += 2) {
    const request = io[index];
    const response = io[index + 1];
    assertSoak(request.kind === "provider-request" && response.kind === "provider-response" &&
      response.requestOrdinal === request.ordinal &&
      response.requestRecordSha256 === request.recordSha256 &&
      response.requestLeafId === request.leafId && response.provider === request.provider &&
      response.model === request.model && Number.isSafeInteger(request.monotonicMs) &&
      Number.isSafeInteger(response.monotonicMs) && response.monotonicMs >= request.monotonicMs &&
      HEX_64.test(request.recordSha256) && HEX_64.test(response.messageSha256),
    `Provider exchange identity drifted at pair ${index / 2 + 1}`);
    assertSoak(!requestIds.has(request.recordSha256) && !responseIds.has(response.messageSha256),
      `Provider exchange replayed at pair ${index / 2 + 1}`);
    requestIds.add(request.recordSha256);
    responseIds.add(response.messageSha256);
    pairs.push({ request, response });
  }
  return pairs;
}

export function providerRuntimeProjection(
  records,
  observedStageCount,
  { sealingOverheadMs = 5 * 60 * 1_000, safetyMarginMs = 0 } = {},
) {
  assertSoak(Number.isSafeInteger(observedStageCount) && observedStageCount > 0,
    "Invalid provider projection stage count");
  const pairs = validateProviderExchange(records);
  const durations = pairs.map(({ request, response }) => response.monotonicMs - request.monotonicMs)
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .sort((left, right) => left - right);
  const p95 = durations.length
    ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const projectedProviderTurns = Math.max(
    SOAK_STAGE_COUNT,
    Math.ceil(pairs.length / observedStageCount * SOAK_STAGE_COUNT),
  );
  assertSoak(Number.isSafeInteger(sealingOverheadMs) && sealingOverheadMs >= 0 &&
    Number.isSafeInteger(safetyMarginMs) && safetyMarginMs >= 0,
  "Invalid provider projection sealing allowance");
  const projectedWallClockMs = p95 === null ? null
    : SOAK_PACING_FLOOR_MS + projectedProviderTurns * p95 + sealingOverheadMs + safetyMarginMs;
  return {
    observedProviderRequests: pairs.length,
    observedAssistantResponses: pairs.length,
    pairedProviderTurns: durations.length,
    providerTurnP95Ms: p95,
    projectedProviderTurns,
    projectedWallClockMs,
    sealingOverheadMs,
    safetyMarginMs,
    watchdogMs: SOAK_WATCHDOG_MS,
    accepted: p95 !== null && pairs.length >= observedStageCount &&
      projectedWallClockMs <= SOAK_WATCHDOG_MS,
  };
}

export function verifySourceHashes(project, sourceHashes) {
  assertSoak(sourceHashes && typeof sourceHashes === "object" && !Array.isArray(sourceHashes),
    "Invalid source-hash attestation");
  for (const [relative, expected] of Object.entries(sourceHashes)) {
    assertSoak(typeof relative === "string" && !relative.startsWith("/") &&
      !relative.split("/").includes("..") && HEX_64.test(expected),
    `Invalid source-hash route ${relative}`);
    const path = join(project, relative);
    assertSoak(existsSync(path) && fileSha256(path) === expected,
      `Pinned soak source hash drifted: ${relative}`);
  }
  return true;
}

export function artifactStat(path) {
  const stat = statSync(path);
  return { bytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), sha256: fileSha256(path) };
}
