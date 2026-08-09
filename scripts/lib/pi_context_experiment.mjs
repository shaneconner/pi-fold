// Fold-vs-compaction experiment contract.
//
// Derived from the soak lineage (scripts/lib/pi_context_soak_attestation.mjs): external
// pacing, one real Pi session per run, one user message, artifact-only adjudication.
// Every primitive that already exists there is IMPORTED, never re-implemented here; this
// module adds only what the experiment needs on top: arms, stage plans as data, mechanical
// probe ground truth, the reread-tax hash, and the blind-grading separation.
//
// Spec: wiki meta/memory/folds/pi_context_governor/fold-vs-compaction_experiment.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  RUNTIME_HOME,
  assertSoak,
  exactKeys,
  sha256Json,
  sha256Text,
} from "./pi_context_soak_attestation.mjs";

// Version 2 (2026-08-09): recall-first probes. Conversation-class probe kinds
// (stage-fact, stage-binding) with per-stage audit code words, file-line-count
// retired, wc -l line semantics, whole-checkout symbol uniqueness. Version-1 plans
// and manifests are a different protocol and do not revalidate under this code.
export const EXPERIMENT_PROTOCOL_VERSION = 2;

// (a) pifold: active-context runtime ON, native auto-compaction OFF.
// (b) native: pi-fold OFF, Pi native auto-compaction ON.
// (c) unmanaged: both OFF; the run terminates at window overflow, which is the datum.
export const EXPERIMENT_ARMS = Object.freeze(["pifold", "native", "unmanaged"]);
export const EXPERIMENT_MODES = Object.freeze(["smoke", "full"]);
// Shipped pi-fold package options (gate 24); each variant is an experiment condition.
export const EXPERIMENT_GUIDANCE_PROFILES = Object.freeze(["pressure", "curation", "minimal"]);
// Fold scheduling is the second shipped dial: fold as soon as a batch is eligible, or
// batch the eligible spans into an epoch. It is an experiment condition, so it is pinned
// in the run config and the manifest exactly like the guidance profile.
export const EXPERIMENT_FOLD_SCHEDULING = Object.freeze(["immediate", "epoch"]);
// Immediate scheduling refuses to fold a peek result, so a peek-heavy arm accumulates a
// copy of evidence the runtime already holds. The third condition dial hands that supply
// back without moving any ladder threshold.
export const EXPERIMENT_DEFAULT_FOLD_PEEK_RESULTS = false;
export const EXPERIMENT_DEFAULT_FOLD_SCHEDULING = "immediate";
// `guidedCuration` was the fourth condition dial: announce the pending epoch commit and
// give the agent a bounded last call to curate what is about to fold. It is RETIRED as of
// the append-only build and tolerated on read only, exactly like `reliabilityLevers`:
// reps 15-21 recorded it and their run configs are immutable data, so they must keep
// adjudicating. Nothing emits it any more. The announcement it named is gone because a
// warning has to arrive before the event it warns about, which means breaking a prefix
// nothing else was breaking; the commit trigger it gated survives and now fires silently.
// (This replaced the iteration-2 reliability-lever set, which pi-fold collapsed into
// unconditional defaults: those option keys no longer exist in the runtime.)
export const EXPERIMENT_DEFAULT_GUIDED_CURATION = false;
// A deployment FACT, not a condition dial: the provider's TOTAL admission window for the
// models whose wire has proven it serves past the per-request input descriptor. Rep 14
// (luna-20260805) recorded 14 provider-reported requests over the 272,000-token
// descriptor, peak 342,539, all served and billed. Rep 16 then aborted after running
// every curation threshold against the descriptor budget (255,616) because no deployment
// passed this fact into the registration; pi-fold's runtime falls back to descriptor
// mode when the fact is absent, which is the conservative default for an unlisted model.
export const EXPERIMENT_PROVIDER_TOTAL_WINDOWS = Object.freeze({ "gpt-5.6-luna": 400_000 });
// Pi's default "auto" transport rides a WebSocket whose follow-ups are DELTA requests
// against connection-scoped server state; every drop re-sends the full context, usually
// onto a cold backend. Rep 17 measured the bill: raw pooled cache share 0.390 against a
// mechanism-limited 0.864. Every run is pinned to SSE so both arms pay the same,
// prefix-cache-routed transport and the comparison is deterministic.
export const EXPERIMENT_TRANSPORT = "sse";
export const EXPERIMENT_TRANSPORTS = Object.freeze(["sse", "websocket", "auto"]);
// The epoch scheduler's implementation, pinned the moment it exists in the runtime and
// REQUIRED once a run asks for epoch scheduling.
export const EXPERIMENT_SCHEDULING_SOURCE = "extensions/lib/scheduling.ts";

// Constants, not knobs: the supervisor recomputes the required root and refuses a run
// directory outside it, and an override set in the launching shell is not in the
// systemd-run --setenv list, so a configurable root would have the supervisor reject the
// very run it was just handed. Relocating run state is a one-line edit and a commit.
export const EXPERIMENT_RUN_ROOT = join(RUNTIME_HOME, "pi-fold-runs");
export const EXPERIMENT_STATE_ROOT = join(EXPERIMENT_RUN_ROOT, "state", "ops", "pi-context-experiment");
export const EXPERIMENT_TMP_ROOT = join(EXPERIMENT_RUN_ROOT, "tmp");
// The exact environment a run attests, named ONCE. The supervisor builds this object and
// the run-config validator checks it; when the two each carried their own copy of the list
// they drifted, and the drift only surfaced when a launched run died at validation. The
// pi-subagents pins left with the deployment that used to load them: this harness registers
// the runtime itself and never imports that package, so pinning it attested a dependency no
// run actually had.
export const EXPERIMENT_DEPENDENCY_KEYS = Object.freeze([
  "piPackageJson", "piDistTree", "piNodeModulesTree", "nodeExecutable",
]);

export const EXPERIMENT_TOOL_NAME = "repo_stage";
export const EXPERIMENT_MARKER_ENTRY = "pi-fold-context-experiment-marker-v1";
export const EXPERIMENT_RUNNER_MODE = "systemd-supervised-single-session";
export const EXPERIMENT_BEHAVIORAL_MODE = "staged-repo-comprehension-marathon";
export const EXPERIMENT_TERMINAL_STABILIZATION_MS = 2 * 60 * 1_000;

// The model may read the pinned checkout freely: rereading after a stop-the-world event is
// the behaviour under measurement, so removing the read tool would destroy the metric.
export const EXPERIMENT_ALLOWED_TOOLS = Object.freeze(["read", EXPERIMENT_TOOL_NAME]);
export const EXPERIMENT_PIFOLD_EXTRA_TOOLS = Object.freeze(["pi_fold_context"]);

// Pacing exists to keep stage RELEASE external (soak integrity), not to burn wall-clock:
// wall-clock is a measured variable here, so the gate is a floor, not a stretcher.
export const EXPERIMENT_MODE_PLANS = Object.freeze({
  // 58 payload stages x ~48k chars is ~2.8M chars, roughly 700k estimated tokens of fresh
  // read-only material through a 272k window: enough for the native arm to cross three
  // compactions, which is the spec's pressure requirement.
  full: Object.freeze({
    stageCount: 64,
    stageIntervalMs: 15_000,
    watchdogMs: 300 * 60 * 1_000,
    heartbeatMs: 30_000,
    payloadTargetChars: 48_000,
    payloadFloorChars: 24_000,
    probeStages: Object.freeze([16, 32, 48, 64]),
    // One kind list PER WAVE (probeKinds[i] belongs to probeStages[i]). Conversation-class
    // kinds discriminate context loss (the answer exists only in the earlier conversation);
    // the one repo-class control (alternating definition-line / symbol-file by wave) keeps
    // continuity with iterations 1-5. Scored separately: a combined total would let the
    // re-derivable answers mask the ones that matter.
    probeKinds: Object.freeze([
      Object.freeze(["stage-fact", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["stage-fact", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["stage-fact", "stage-fact", "stage-binding", "repo"]),
      Object.freeze(["stage-fact", "stage-fact", "stage-binding", "repo"]),
    ]),
    deliverableEvery: 8,
    revisitEvery: 3,
  }),
  smoke: Object.freeze({
    stageCount: 8,
    stageIntervalMs: 5_000,
    watchdogMs: 45 * 60 * 1_000,
    heartbeatMs: 5_000,
    payloadTargetChars: 12_000,
    payloadFloorChars: 6_000,
    // Deliverable cadence must not collide with the probe stages, or a mode plan silently
    // produces zero deliverables and the blind grading leg has nothing to grade.
    probeStages: Object.freeze([4, 8]),
    // Smoke has only three carrier stages under the <= ceil(ordinal/2) eligibility rule
    // (1 and 2 by wave one, 3 by wave two), so each wave carries ONE conversation kind;
    // both kinds still get exercised across the run.
    probeKinds: Object.freeze([
      Object.freeze(["stage-fact", "repo"]),
      Object.freeze(["stage-binding", "repo"]),
    ]),
    deliverableEvery: 3,
    revisitEvery: 2,
  }),
});

// Named, not hidden: token mass per tool result is an ESTIMATE. Byte mass in the same
// report is exact. Provider-attributed usage never comes from this function.
export const TOKEN_ESTIMATOR_ID = "utf8-bytes-div-4-ceil";

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_40 = /^[0-9a-f]{40}$/;

export function assertExperiment(condition, message) {
  assertSoak(condition, message);
}

// Every required key present, no key outside required ∪ optional. Used where a condition
// dial was added after runs were already sealed: those artifacts are still exactly shaped,
// they simply predate the dial, and refusing to adjudicate them would destroy evidence.
export function keysWithin(value, required, optional) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const present = new Set(Object.keys(value));
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => present.has(key)) &&
    [...present].every((key) => allowed.has(key));
}

// ---------------------------------------------------------------------------
// Pinned public OSS corpora. Permissive licence, well known, mid-size, and big
// enough that read-only stage payloads keep the tool-fold cadence eligible.
// Stats measured 2026-08-05 from the pinned commit (non-test source only).
// ---------------------------------------------------------------------------
export const EXPERIMENT_REPOS = Object.freeze({
  curl: Object.freeze({
    key: "curl",
    url: "https://github.com/curl/curl.git",
    commit: "133785b15936d9417fdc41f77b87304b6bf458d5",
    license: "curl (MIT/X derivative)",
    language: "c",
    sourceGlobExtensions: Object.freeze([".c", ".h"]),
    sourceRoots: Object.freeze(["lib", "src"]),
    excludePathParts: Object.freeze([]),
    stats: Object.freeze({ sourceFiles: 474, sourceLines: 199_634, sourceChars: 6_195_580 }),
  }),
  django: Object.freeze({
    key: "django",
    url: "https://github.com/django/django.git",
    commit: "30ebe0001c1d10bebc68567f796d821f7b309f4d",
    license: "BSD-3-Clause",
    language: "python",
    sourceGlobExtensions: Object.freeze([".py"]),
    sourceRoots: Object.freeze(["django"]),
    excludePathParts: Object.freeze([]),
    stats: Object.freeze({ sourceFiles: 908, sourceLines: 165_501, sourceChars: 5_920_377 }),
  }),
  ripgrep: Object.freeze({
    key: "ripgrep",
    url: "https://github.com/BurntSushi/ripgrep.git",
    commit: "3fce3b5bb0236da2df6d99672afb8a719642eca7",
    license: "MIT OR Unlicense",
    language: "rust",
    sourceGlobExtensions: Object.freeze([".rs"]),
    sourceRoots: Object.freeze(["crates"]),
    excludePathParts: Object.freeze(["tests"]),
    stats: Object.freeze({ sourceFiles: 90, sourceLines: 49_690, sourceChars: 1_684_756 }),
  }),
  gin: Object.freeze({
    key: "gin",
    url: "https://github.com/gin-gonic/gin.git",
    commit: "34dac209ffb6ef85cc78c5d217bbb7ad001d68fd",
    license: "MIT",
    language: "go",
    sourceGlobExtensions: Object.freeze([".go"]),
    sourceRoots: Object.freeze(["."]),
    excludePathParts: Object.freeze(["_test.go"]),
    stats: Object.freeze({ sourceFiles: 59, sourceLines: 8_196, sourceChars: 240_000 }),
  }),
  flask: Object.freeze({
    key: "flask",
    url: "https://github.com/pallets/flask.git",
    commit: "6a2f545bfd8ed31e19066a299296917e034aca58",
    license: "BSD-3-Clause",
    language: "python",
    sourceGlobExtensions: Object.freeze([".py"]),
    sourceRoots: Object.freeze(["src"]),
    excludePathParts: Object.freeze(["tests"]),
    stats: Object.freeze({ sourceFiles: 24, sourceLines: 9_502, sourceChars: 330_000 }),
  }),
});

// curl is the default. It is the only registered candidate whose corpus (474 files,
// 199,634 lines, 6.2M chars in lib/ + src/) carries enough fresh read-only material to push
// the native arm through THREE compactions in one run while still leaving headroom, and its
// lib/ internals are densely cross-referential, so revisit stages are real work rather than
// synthetic. django is the like-sized alternate; ripgrep is the short-corpus fallback whose
// 1.68M chars fit a single window pass and are useful for mechanism debugging, not pressure.
export const EXPERIMENT_DEFAULT_REPO = "curl";

// ---------------------------------------------------------------------------
// Deterministic seeded ordering. Stage plans are DATA and must be byte-reproducible
// from (repo commit, mode, seed) alone.
// ---------------------------------------------------------------------------
export function seededSequence(seed, count) {
  assertExperiment(typeof seed === "string" && seed.length > 0, "Seeded sequence requires a seed");
  assertExperiment(Number.isSafeInteger(count) && count >= 0, "Seeded sequence requires a count");
  const values = [];
  let digest = createHash("sha256").update(seed, "utf8").digest();
  let offset = 0;
  while (values.length < count) {
    if (offset + 4 > digest.length) {
      digest = createHash("sha256").update(digest).digest();
      offset = 0;
    }
    values.push(digest.readUInt32BE(offset));
    offset += 4;
  }
  return values;
}

export function seededShuffle(items, seed) {
  const ordered = [...items];
  const draws = seededSequence(seed, Math.max(ordered.length - 1, 0));
  for (let index = ordered.length - 1; index > 0; index -= 1) {
    const swap = draws[ordered.length - 1 - index] % (index + 1);
    [ordered[index], ordered[swap]] = [ordered[swap], ordered[index]];
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Mechanical ground truth. Every probe answer is EXTRACTED from the pinned file at
// staging time; no answer is ever authored by hand or by a model.
// ---------------------------------------------------------------------------
const DEFINITION_PATTERNS = Object.freeze([
  { kind: "fn", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  // The tail matters: `struct X {` / `struct X;` / `struct X<T>(` open a DEFINITION,
  // while `struct X *arg,` inside a C parameter list is a USE. The first smoke probed
  // cram.c line 50 (`struct Curl_creds *creds,`) as "defined on line 50" and every
  // arm reasonably answered the enclosing function instead.
  { kind: "struct", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|;|\(|$)/ },
  { kind: "enum", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|;|$)/ },
  { kind: "trait", pattern: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*(?:\{|:|$)/ },
  { kind: "func", pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "type", pattern: /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "def", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { kind: "class", pattern: /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/ },
]);

export function extractDefinitions(text) {
  assertExperiment(typeof text === "string", "Definition extraction requires file text");
  const definitions = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length > 400) continue;
    for (const { kind, pattern } of DEFINITION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      definitions.push({ line: index + 1, identifier: match[1], kind });
      break;
    }
  }
  return definitions;
}

export function fileFacts(repoRoot, absolutePath) {
  const text = readFileSync(absolutePath, "utf8");
  const path = relative(repoRoot, absolutePath);
  assertExperiment(path && !path.startsWith(".."), `File escapes the pinned repo root: ${absolutePath}`);
  return {
    path,
    sha256: sha256Text(text),
    // wc -l semantics: the count of newline characters. split("\n").length reads one
    // high on newline-terminated files and gave one probe a defensible second answer.
    lines: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    definitions: extractDefinitions(text),
    text,
  };
}

// Repo-class control probes, extracted mechanically from the pinned bytes. These are
// re-derivable by rereading the checkout, which is exactly why they are only the
// CONTROL now: conversation-class probes (below) are the discriminating instrument.
// file-line-count is retired: its truth semantics were ambiguous, it was noise, and
// it invited extra file reads that moved the token comparison.
export function buildProbes({ facts, seed, count, uniqueIdentifiers, rotationOffset = 0 }) {
  assertExperiment(Array.isArray(facts) && facts.length > 0, "Probe construction requires staged files");
  assertExperiment(Number.isSafeInteger(count) && count > 0, "Probe construction requires a count");
  const probes = [];
  const ordered = seededShuffle(facts.map((fact) => fact.path), `${seed}:probe-files`);
  const draws = seededSequence(`${seed}:probe-draws`, count * 4);
  let drawIndex = 0;
  for (let index = 0; probes.length < count && index < ordered.length * 3; index += 1) {
    const fact = facts.find((candidate) => candidate.path === ordered[index % ordered.length]);
    if (!fact) continue;
    const rotation = (probes.length + rotationOffset) % 2;
    if (rotation === 0 && fact.definitions.length > 0) {
      const definition = fact.definitions[draws[drawIndex++] % fact.definitions.length];
      probes.push({
        id: `probe-${String(probes.length + 1).padStart(2, "0")}`,
        kind: "definition-line",
        question: `In the file ${fact.path}, which identifier is defined on line ${definition.line}? Answer with the identifier only.`,
        expectedAnswer: definition.identifier,
        sourcePath: fact.path,
        sourceLine: definition.line,
      });
      continue;
    }
    const unique = fact.definitions.find((definition) =>
      uniqueIdentifiers.get(definition.identifier) === fact.path);
    if (!unique) continue;
    probes.push({
      id: `probe-${String(probes.length + 1).padStart(2, "0")}`,
      kind: "symbol-file",
      question: `Which repository-relative file defines ${unique.identifier}? Answer with the path only.`,
      expectedAnswer: fact.path,
      sourcePath: fact.path,
      sourceLine: unique.line,
    });
  }
  assertExperiment(probes.length === count,
    `Pinned corpus yielded ${probes.length} mechanical probes, needed ${count}`);
  return probes;
}

export function uniqueIdentifierIndex(facts) {
  const seen = new Map();
  const ambiguous = new Set();
  for (const fact of facts) {
    for (const definition of fact.definitions) {
      if (seen.has(definition.identifier) && seen.get(definition.identifier) !== fact.path) {
        ambiguous.add(definition.identifier);
      } else {
        seen.set(definition.identifier, fact.path);
      }
    }
  }
  for (const identifier of ambiguous) seen.delete(identifier);
  return seen;
}

// ---------------------------------------------------------------------------
// Conversation-class probes. The answer exists ONLY in the earlier conversation:
// a code word delivered once inside a stage instruction, or the stage-to-file
// binding the seeded shuffle created. Ground truth is derivable at staging time
// (the harness authored it), and rereading the checkout cannot recover it.
// ---------------------------------------------------------------------------
export const CONVERSATION_PROBE_KINDS = Object.freeze(["stage-fact", "stage-binding"]);
export const REPO_PROBE_KINDS = Object.freeze(["definition-line", "symbol-file"]);
export const CODE_WORD_PATTERN = /^cw-[0-9a-f]{6}$/;

export function stageCodeWords(seed, stageCount) {
  const draws = seededSequence(`${seed}:code-words`, stageCount);
  const words = draws.map((value) => `cw-${value.toString(16).padStart(8, "0").slice(0, 6)}`);
  assertExperiment(new Set(words).size === words.length,
    "Stage code words collided; stage the campaign with a different seed");
  return words;
}

export function codeWordSentence(ordinal, codeWord) {
  return `Audit note: the code word for stage ${String(ordinal).padStart(2, "0")} is ${codeWord}.`;
}

// One carrier stage per probe, never reused across the whole plan: a probed span,
// once peeked or answered, is refreshed at the tail, and a second probe against it
// would measure that refresh instead of recall.
export function buildConversationProbes({ stages, probeOrdinal, seed, kinds, usedStages }) {
  assertExperiment(Array.isArray(stages) && Number.isSafeInteger(probeOrdinal),
    "Conversation probes require the stages built so far");
  assertExperiment(Array.isArray(kinds) && kinds.every((kind) => CONVERSATION_PROBE_KINDS.includes(kind)),
    "Conversation probe kinds must be stage-fact or stage-binding");
  const eligible = stages.filter((stage) => stage.kind !== "probe" &&
    stage.ordinal <= Math.ceil(probeOrdinal / 2) && !usedStages.has(stage.ordinal));
  assertExperiment(eligible.length >= kinds.length,
    `Probe stage ${probeOrdinal} has ${eligible.length} unused carrier stages, needs ${kinds.length}`);
  const order = seededShuffle(eligible.map((stage) => stage.ordinal), `${seed}:carriers`);
  const probes = [];
  for (const [index, kind] of kinds.entries()) {
    const ordinal = order[index];
    const carrier = stages.find((stage) => stage.ordinal === ordinal);
    usedStages.add(ordinal);
    const label = String(ordinal).padStart(2, "0");
    if (kind === "stage-fact") {
      assertExperiment(typeof carrier.codeWord === "string" && CODE_WORD_PATTERN.test(carrier.codeWord),
        `Carrier stage ${ordinal} has no code word`);
      probes.push({
        id: "",
        kind,
        question: `What was the audit code word given in stage ${label}'s instructions? ` +
          "Answer with the code word only.",
        expectedAnswer: carrier.codeWord,
        sourceStage: ordinal,
      });
    } else {
      assertExperiment(carrier.files.length > 0, `Carrier stage ${ordinal} delivered no files`);
      probes.push({
        id: "",
        kind,
        question: `Which repository-relative file was the FIRST file delivered in stage ${label}? ` +
          "Answer with the path only.",
        expectedAnswer: carrier.files[0].path,
        sourceStage: ordinal,
      });
    }
  }
  return probes;
}

// ---------------------------------------------------------------------------
// Stage plan: DATA, hashed. The hash is pinned into every run manifest.
// ---------------------------------------------------------------------------
export function stagePlanSha256(plan) {
  assertExperiment(plan && typeof plan === "object", "Stage plan hashing requires a plan object");
  const { planSha256: _ignored, ...identity } = plan;
  return sha256Json(identity);
}

// The corpus fingerprint every run re-derives from its own detached worktree and asserts
// against the plan: a run whose checkout differs from the staged bytes is not the experiment.
export function corpusManifestSha256(entries) {
  assertExperiment(Array.isArray(entries) && entries.length > 0, "Corpus fingerprint requires files");
  return sha256Json([...entries]
    .map((entry) => ({ path: entry.path, sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path)));
}

export function stagePayloadText(stage) {
  assertExperiment(stage && typeof stage === "object", "Stage payload requires a stage");
  // Hard gate: ground truth is extracted at staging time and must never be rendered into a
  // payload the session can see. stagePlanForRun() strips it; this refuses if it did not.
  assertExperiment((stage.probes ?? []).every((probe) => !Object.hasOwn(probe, "expectedAnswer")),
    `Stage ${stage.ordinal} payload still carries probe ground truth`);
  const header = [
    `STAGE ${String(stage.ordinal).padStart(2, "0")} / ${stage.kind}`,
    stage.instructions,
  ];
  if (stage.kind === "probe") {
    header.push("", "QUESTIONS (answer each from what you already know; cite where you learned it):");
    for (const probe of stage.probes) header.push(`- ${probe.id}: ${probe.question}`);
  }
  if (stage.deliverable) header.push("", `DELIVERABLE ${stage.deliverable.id}: ${stage.deliverable.instructions}`);
  const body = stage.files.map((file) =>
    `\n----- BEGIN ${file.path} (${file.lines} lines) -----\n${file.text}\n----- END ${file.path} -----\n`).join("");
  return `${header.join("\n")}\n${body}\nNEXT_KEY: ${stage.nextKeyPlaceholder ?? "<supervisor>"}\n`;
}

export function validateStagePlan(plan) {
  assertExperiment(exactKeys(plan, [
    "version", "mode", "repo", "seed", "stageCount", "stageIntervalMs", "watchdogMs",
    "heartbeatMs", "corpus", "stages", "probeCount", "deliverableCount", "planSha256",
  ]), "Invalid stage plan shape");
  assertExperiment(plan.version === EXPERIMENT_PROTOCOL_VERSION, "Stage plan protocol version drifted");
  assertExperiment(EXPERIMENT_MODES.includes(plan.mode), "Invalid stage plan mode");
  const modePlan = EXPERIMENT_MODE_PLANS[plan.mode];
  assertExperiment(plan.stageCount === modePlan.stageCount &&
    plan.stageIntervalMs === modePlan.stageIntervalMs &&
    plan.watchdogMs === modePlan.watchdogMs && plan.heartbeatMs === modePlan.heartbeatMs,
  "Stage plan constants drifted from its mode plan");
  assertExperiment(exactKeys(plan.repo, ["key", "url", "commit", "license", "language", "treeSha256"]) &&
    Object.hasOwn(EXPERIMENT_REPOS, plan.repo.key) &&
    plan.repo.commit === EXPERIMENT_REPOS[plan.repo.key].commit &&
    plan.repo.url === EXPERIMENT_REPOS[plan.repo.key].url &&
    HEX_40.test(plan.repo.commit) && HEX_64.test(plan.repo.treeSha256),
  "Stage plan repo pin is invalid or unregistered");
  assertExperiment(Array.isArray(plan.stages) && plan.stages.length === plan.stageCount,
    "Stage plan stage count drifted");
  let probeCount = 0;
  let deliverableCount = 0;
  const carrierStages = new Set();
  const seenCodeWords = new Set();
  for (const [index, stage] of plan.stages.entries()) {
    assertExperiment(exactKeys(stage, [
      "ordinal", "kind", "instructions", "files", "probes", "deliverable", "payloadChars",
      "payloadSha256", "codeWord",
    ]) && stage.ordinal === index + 1 &&
      ["read", "revisit", "probe"].includes(stage.kind) &&
      typeof stage.instructions === "string" && stage.instructions.length > 0 &&
      Array.isArray(stage.files) && Array.isArray(stage.probes),
    `Invalid stage shape at ${index + 1}`);
    assertExperiment((stage.kind === "probe") === modePlan.probeStages.includes(stage.ordinal) &&
      (stage.kind === "probe") === (stage.probes.length > 0),
    `Stage ${index + 1} disagrees with the mode plan about being a probe wave`);
    // The code word is the conversation-fact channel: exactly one per payload stage,
    // woven into the instructions, absent from probe stages, never repeated.
    if (stage.kind === "probe") {
      assertExperiment(stage.codeWord === null, `Probe stage ${index + 1} carries a code word`);
    } else {
      assertExperiment(typeof stage.codeWord === "string" && CODE_WORD_PATTERN.test(stage.codeWord) &&
        stage.instructions.includes(stage.codeWord) && !seenCodeWords.has(stage.codeWord),
      `Stage ${index + 1} code word is missing, malformed, unwoven, or repeated`);
      seenCodeWords.add(stage.codeWord);
    }
    for (const file of stage.files) {
      assertExperiment(exactKeys(file, ["path", "sha256", "lines", "chars", "bytes"]) &&
        HEX_64.test(file.sha256) && Number.isSafeInteger(file.lines) && file.lines > 0,
      `Invalid staged file at stage ${index + 1}`);
    }
    for (const probe of stage.probes) {
      if (CONVERSATION_PROBE_KINDS.includes(probe.kind)) {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "sourceStage",
        ]) && typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          Number.isSafeInteger(probe.sourceStage) && probe.sourceStage >= 1 &&
          probe.sourceStage < stage.ordinal,
        `Invalid conversation probe shape at stage ${index + 1}`);
        // One probe per carrier stage across the WHOLE plan: a probed span refreshes
        // at the tail once answered, and a second probe would measure the refresh.
        assertExperiment(!carrierStages.has(probe.sourceStage),
          `Carrier stage ${probe.sourceStage} is probed twice`);
        carrierStages.add(probe.sourceStage);
        const carrier = plan.stages[probe.sourceStage - 1];
        assertExperiment(carrier && carrier.kind !== "probe",
          `Conversation probe at stage ${index + 1} targets a probe stage`);
        if (probe.kind === "stage-fact") {
          assertExperiment(probe.expectedAnswer === carrier.codeWord,
            `stage-fact probe at stage ${index + 1} disagrees with carrier ${probe.sourceStage}`);
        } else {
          assertExperiment(carrier.files.length > 0 && probe.expectedAnswer === carrier.files[0].path,
            `stage-binding probe at stage ${index + 1} disagrees with carrier ${probe.sourceStage}`);
        }
      } else {
        assertExperiment(exactKeys(probe, [
          "id", "kind", "question", "expectedAnswer", "sourcePath", "sourceLine",
        ]) && REPO_PROBE_KINDS.includes(probe.kind) &&
          typeof probe.expectedAnswer === "string" && probe.expectedAnswer.length > 0 &&
          Number.isSafeInteger(probe.sourceLine) && probe.sourceLine > 0,
        `Invalid probe shape at stage ${index + 1}`);
      }
      probeCount += 1;
    }
    if (stage.deliverable) {
      assertExperiment(exactKeys(stage.deliverable, ["id", "instructions", "referencesStages"]) &&
        Array.isArray(stage.deliverable.referencesStages) &&
        stage.deliverable.referencesStages.every((value) =>
          Number.isSafeInteger(value) && value >= 1 && value < stage.ordinal),
      `Invalid deliverable at stage ${index + 1}`);
      deliverableCount += 1;
    }
    assertExperiment(HEX_64.test(stage.payloadSha256) && Number.isSafeInteger(stage.payloadChars) &&
      stage.payloadChars > 0, `Invalid payload attestation at stage ${index + 1}`);
    if (stage.kind !== "probe") {
      assertExperiment(stage.payloadChars >= modePlan.payloadFloorChars,
        `Stage ${index + 1} payload is below the fold-eligibility floor`);
    }
  }
  assertExperiment(plan.probeCount === probeCount && plan.deliverableCount === deliverableCount &&
    probeCount > 0 && deliverableCount > 0, "Stage plan probe/deliverable counts drifted");
  // Every stage payload is unique bytes. A harness-induced repeat would land in the reread
  // tax as if the model had re-read it, so revisit stages carry instructions, never resent
  // file bodies: the only way a payload hash can repeat is a model-initiated read.
  const payloadHashes = plan.stages.map((stage) => stage.payloadSha256);
  assertExperiment(new Set(payloadHashes).size === payloadHashes.length,
    "Stage plan repeats a payload: the reread tax could not distinguish harness from model");
  const stagedPaths = plan.stages.flatMap((stage) => stage.files.map((file) => file.path));
  assertExperiment(new Set(stagedPaths).size === stagedPaths.length,
    "Stage plan delivers the same file twice");
  // Grading flattens every wave into one packet and joins answers to ground truth by id,
  // so an id repeated across waves would leave the grader joining by position.
  const probeIds = plan.stages.flatMap((stage) => stage.probes.map((probe) => probe.id));
  assertExperiment(new Set(probeIds).size === probeIds.length, "Stage plan repeats a probe id");
  assertExperiment(plan.planSha256 === stagePlanSha256(plan), "Stage plan hash does not cover its own body");
  return plan;
}

// The stage plan carries expected answers; the RUN payload must never see them.
export function stagePlanForRun(plan) {
  validateStagePlan(plan);
  return {
    ...plan,
    stages: plan.stages.map((stage) => ({
      ...stage,
      probes: stage.probes.map((probe) => {
        const { expectedAnswer: _hidden, sourcePath: _path, sourceLine: _line,
          sourceStage: _stage, ...visible } = probe;
        return visible;
      }),
    })),
  };
}

// ---------------------------------------------------------------------------
// Run manifest: pins everything the publication has to be able to reproduce.
// ---------------------------------------------------------------------------
export function validateExperimentManifest(manifest) {
  // `reliabilityLevers` is a RETIRED condition key, tolerated on read only: sealed run
  // manifests are immutable data and runs 10-14 recorded it. Nothing emits it any more.
  assertExperiment(keysWithin(manifest, [
    "version", "runId", "campaignId", "arm", "mode", "ordinal", "repetition",
    "seed", "model", "runtime", "target", "plan", "pacing", "createdWallMs",
  ], ["guidance", "foldScheduling", "foldPeekResults", "guidedCuration", "providerTotalWindow", "transport", "reliabilityLevers"]),
  "Invalid experiment manifest shape");
  assertExperiment(manifest.foldScheduling === undefined ||
    EXPERIMENT_FOLD_SCHEDULING.includes(manifest.foldScheduling),
  "Manifest fold scheduling is not a shipped package option");
  assertExperiment(manifest.foldPeekResults === undefined ||
    typeof manifest.foldPeekResults === "boolean",
  "Manifest peek-fold condition is not a boolean");
  assertExperiment(manifest.guidedCuration === undefined ||
    typeof manifest.guidedCuration === "boolean",
  "Manifest guided-curation condition is not a boolean");
  assertExperiment(manifest.providerTotalWindow === undefined ||
    (Number.isSafeInteger(manifest.providerTotalWindow) && manifest.providerTotalWindow > 0),
  "Manifest provider total window is invalid");
  assertExperiment(manifest.transport === undefined || EXPERIMENT_TRANSPORTS.includes(manifest.transport),
    "Manifest transport is not a known Pi transport");
  assertExperiment(manifest.version === EXPERIMENT_PROTOCOL_VERSION, "Manifest protocol version drifted");
  assertExperiment(EXPERIMENT_ARMS.includes(manifest.arm), "Manifest arm is not one of the three arms");
  assertExperiment(EXPERIMENT_MODES.includes(manifest.mode), "Manifest mode is invalid");
  assertExperiment(manifest.guidance === undefined ||
    EXPERIMENT_GUIDANCE_PROFILES.includes(manifest.guidance),
  "Manifest guidance profile is not a shipped package option");
  assertExperiment(Number.isSafeInteger(manifest.ordinal) && manifest.ordinal > 0 &&
    Number.isSafeInteger(manifest.repetition) && manifest.repetition > 0,
  "Manifest ordinal/repetition are invalid");
  assertExperiment(typeof manifest.seed === "string" && manifest.seed.length >= 16,
    "Manifest seed is missing or too short");
  assertExperiment(exactKeys(manifest.model, ["provider", "id", "effort", "contextWindow", "maxTokens",
    "descriptorSha256"]) &&
    [manifest.model.provider, manifest.model.id, manifest.model.effort].every((part) =>
      typeof part === "string" && part.length > 0) &&
    Number.isSafeInteger(manifest.model.contextWindow) && manifest.model.contextWindow > 0 &&
    HEX_64.test(manifest.model.descriptorSha256),
  "Manifest model pin is incomplete: provider, model id and effort are all required");
  assertExperiment(exactKeys(manifest.runtime, [
    "codeCommit", "codeTree", "piVersion", "sourceHashes", "dependencyHashes", "activeContextEnabled",
    "nativeCompactionEnabled",
  ]) && HEX_40.test(manifest.runtime.codeCommit) && HEX_40.test(manifest.runtime.codeTree) &&
    typeof manifest.runtime.piVersion === "string" &&
    typeof manifest.runtime.activeContextEnabled === "boolean" &&
    typeof manifest.runtime.nativeCompactionEnabled === "boolean",
  "Manifest runtime pin is incomplete");
  // The arm IS the runtime configuration; a manifest that disagrees with its arm is a lie.
  const expected = {
    pifold: { activeContextEnabled: true, nativeCompactionEnabled: false },
    native: { activeContextEnabled: false, nativeCompactionEnabled: true },
    unmanaged: { activeContextEnabled: false, nativeCompactionEnabled: false },
  }[manifest.arm];
  assertExperiment(manifest.runtime.activeContextEnabled === expected.activeContextEnabled &&
    manifest.runtime.nativeCompactionEnabled === expected.nativeCompactionEnabled,
  `Manifest runtime configuration contradicts arm ${manifest.arm}`);
  assertExperiment(exactKeys(manifest.target, ["repoKey", "url", "commit", "treeSha256", "checkoutSha256"]) &&
    Object.hasOwn(EXPERIMENT_REPOS, manifest.target.repoKey) &&
    manifest.target.commit === EXPERIMENT_REPOS[manifest.target.repoKey].commit &&
    HEX_64.test(manifest.target.treeSha256) && HEX_64.test(manifest.target.checkoutSha256),
  "Manifest target-repo pin is incomplete or unregistered");
  assertExperiment(exactKeys(manifest.plan, ["planSha256", "stageCount", "probeCount", "deliverableCount"]) &&
    HEX_64.test(manifest.plan.planSha256) && Number.isSafeInteger(manifest.plan.stageCount) &&
    manifest.plan.stageCount === EXPERIMENT_MODE_PLANS[manifest.mode].stageCount,
  "Manifest stage-plan pin is incomplete");
  assertExperiment(exactKeys(manifest.pacing, ["stageIntervalMs", "watchdogMs", "heartbeatMs"]) &&
    manifest.pacing.stageIntervalMs === EXPERIMENT_MODE_PLANS[manifest.mode].stageIntervalMs &&
    manifest.pacing.watchdogMs === EXPERIMENT_MODE_PLANS[manifest.mode].watchdogMs,
  "Manifest pacing drifted from its mode plan");
  assertExperiment(Number.isSafeInteger(manifest.createdWallMs) && manifest.createdWallMs > 0,
    "Manifest creation clock is invalid");
  return manifest;
}

// ---------------------------------------------------------------------------
// Run config: the supervisor -> worker contract, revalidated on both sides.
// ---------------------------------------------------------------------------
export const EXPERIMENT_RUN_CONFIG_KEYS = Object.freeze([
  "version", "runId", "runDir", "campaignId", "arm", "mode", "repetition",
  "ordinal", "seed", "unit", "invocationId", "supervisorPid", "supervisorStartTicks",
  "bootId", "codeCommit", "codeTree", "firstChallenge", "stageCount", "stageIntervalMs",
  "watchdogMs", "heartbeatMs", "createdWallMs", "createdMonotonicMs", "sourceHashes",
  "dependencyHashes", "planPath", "planSha256", "repoDir", "targetCommit", "targetTreeSha256",
  "model",
]);

// Added after the first sealed campaign: runs written before the dial existed carry no
// foldScheduling key and adjudicate as EXPERIMENT_DEFAULT_FOLD_SCHEDULING. `reliabilityLevers`
// is retired and tolerated on read only, so sealed runs 10-14 still adjudicate.
export const EXPERIMENT_RUN_CONFIG_OPTIONAL_KEYS = Object.freeze([
  "guidance", "foldScheduling", "foldPeekResults", "guidedCuration", "providerTotalWindow", "transport", "reliabilityLevers",
]);

export function validateExperimentRunConfig(value) {
  assertExperiment(keysWithin(value, EXPERIMENT_RUN_CONFIG_KEYS, EXPERIMENT_RUN_CONFIG_OPTIONAL_KEYS),
    "Invalid experiment run config shape");
  assertExperiment(value.foldScheduling === undefined ||
    EXPERIMENT_FOLD_SCHEDULING.includes(value.foldScheduling),
  "Run config fold scheduling is invalid");
  assertExperiment(value.foldPeekResults === undefined || typeof value.foldPeekResults === "boolean",
    "Run config peek-fold condition is invalid");
  assertExperiment(value.guidedCuration === undefined || typeof value.guidedCuration === "boolean",
    "Run config guided-curation condition is invalid");
  assertExperiment(value.providerTotalWindow === undefined ||
    (Number.isSafeInteger(value.providerTotalWindow) && value.providerTotalWindow > 0),
  "Run config provider total window is invalid");
  assertExperiment(value.transport === undefined || EXPERIMENT_TRANSPORTS.includes(value.transport),
    "Run config transport is not a known Pi transport");
  assertExperiment(value.version === EXPERIMENT_PROTOCOL_VERSION, "Run config protocol version drifted");
  assertExperiment(EXPERIMENT_ARMS.includes(value.arm), "Run config arm is invalid");
  assertExperiment(EXPERIMENT_MODES.includes(value.mode), "Run config mode is invalid");
  assertExperiment(value.guidance === undefined ||
    EXPERIMENT_GUIDANCE_PROFILES.includes(value.guidance),
  "Run config guidance profile is invalid");
  const modePlan = EXPERIMENT_MODE_PLANS[value.mode];
  assertExperiment(value.stageCount === modePlan.stageCount &&
    value.stageIntervalMs === modePlan.stageIntervalMs &&
    value.watchdogMs === modePlan.watchdogMs && value.heartbeatMs === modePlan.heartbeatMs,
  "Run config pacing drifted from its mode plan");
  assertExperiment(typeof value.runDir === "string" && value.runDir.endsWith(`/${value.runId}`),
    "Run directory does not carry its run id");
  assertExperiment(typeof value.campaignId === "string" && value.campaignId.length > 0,
    "Run config lacks a campaign id");
  assertExperiment(Number.isSafeInteger(value.repetition) && value.repetition > 0 &&
    Number.isSafeInteger(value.ordinal) && value.ordinal > 0,
  "Run config repetition/ordinal are invalid");
  assertExperiment(HEX_64.test(value.firstChallenge), "Run config first challenge is invalid");
  assertExperiment(HEX_40.test(value.codeCommit) && HEX_40.test(value.codeTree) &&
    HEX_40.test(value.targetCommit), "Run config commit pins are invalid");
  assertExperiment(HEX_64.test(value.planSha256) && HEX_64.test(value.targetTreeSha256),
    "Run config plan/target hashes are invalid");
  assertExperiment(typeof value.repoDir === "string" && value.repoDir.startsWith(`${value.runDir}/`),
    "The pinned checkout must live inside the run directory");
  assertExperiment(exactKeys(value.model, ["provider", "id", "effort"]) &&
    [value.model.provider, value.model.id, value.model.effort].every((part) =>
      typeof part === "string" && part.length > 0),
  "Run config must pin provider, model id and effort explicitly");
  assertExperiment(value.sourceHashes && typeof value.sourceHashes === "object" &&
    Object.values(value.sourceHashes).every((hash) => HEX_64.test(hash)) &&
    Object.keys(value.sourceHashes).length >= 6, "Run config source hashes are invalid");
  assertExperiment(exactKeys(value.dependencyHashes, EXPERIMENT_DEPENDENCY_KEYS) &&
    Object.values(value.dependencyHashes).every((hash) => HEX_64.test(hash)),
  "Run config dependency hashes are invalid");
  return structuredClone(value);
}

export function armRuntimeConfiguration(arm) {
  assertExperiment(EXPERIMENT_ARMS.includes(arm), `Unknown arm ${arm}`);
  return {
    pifold: { activeContextEnabled: true, nativeCompactionEnabled: false, toleratesOverflow: false },
    native: { activeContextEnabled: false, nativeCompactionEnabled: true, toleratesOverflow: false },
    unmanaged: { activeContextEnabled: false, nativeCompactionEnabled: false, toleratesOverflow: true },
  }[arm];
}

const WINDOW_OVERFLOW = /context (?:length|window)|maximum context|too many tokens|token limit|exceeds? the (?:model|context)|prompt is too long|input length/i;

export function isWindowOverflow(text) {
  return typeof text === "string" && WINDOW_OVERFLOW.test(text);
}

// ---------------------------------------------------------------------------
// Reread tax. Hash the tool-result payload; a hash seen earlier in-session means those
// bytes were ingested again. Byte mass is exact; token mass is the named estimate.
// ---------------------------------------------------------------------------
export function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

export function toolResultContentSha256(content) {
  return sha256Text(toolResultText(content));
}

export function estimateTokens(text) {
  assertExperiment(typeof text === "string", "Token estimation requires text");
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

// records: [{ ordinal, toolName, contentSha256, chars, bytes, tokensEstimated }] in session order.
export function computeRereadTax(records) {
  assertExperiment(Array.isArray(records), "Reread tax requires an ordered tool-result ledger");
  const firstSeen = new Map();
  const perHash = new Map();
  let repeatResults = 0;
  let repeatBytes = 0;
  let repeatTokensEstimated = 0;
  let totalBytes = 0;
  let totalTokensEstimated = 0;
  for (const record of records) {
    assertExperiment(exactKeys(record, [
      "ordinal", "toolName", "contentSha256", "chars", "bytes", "tokensEstimated",
    ]) && HEX_64.test(record.contentSha256) && Number.isSafeInteger(record.bytes) &&
      Number.isSafeInteger(record.tokensEstimated),
    `Invalid tool-result ledger record at ordinal ${record?.ordinal}`);
    totalBytes += record.bytes;
    totalTokensEstimated += record.tokensEstimated;
    if (firstSeen.has(record.contentSha256)) {
      repeatResults += 1;
      repeatBytes += record.bytes;
      repeatTokensEstimated += record.tokensEstimated;
      const entry = perHash.get(record.contentSha256);
      entry.repeats += 1;
      entry.repeatBytes += record.bytes;
      entry.repeatTokensEstimated += record.tokensEstimated;
      entry.repeatOrdinals.push(record.ordinal);
    } else {
      firstSeen.set(record.contentSha256, record.ordinal);
      perHash.set(record.contentSha256, {
        contentSha256: record.contentSha256,
        toolName: record.toolName,
        firstOrdinal: record.ordinal,
        repeats: 0,
        repeatBytes: 0,
        repeatTokensEstimated: 0,
        repeatOrdinals: [],
      });
    }
  }
  const repeated = [...perHash.values()]
    .filter((entry) => entry.repeats > 0)
    .sort((left, right) => right.repeatTokensEstimated - left.repeatTokensEstimated ||
      left.contentSha256.localeCompare(right.contentSha256));
  return {
    tokenEstimatorId: TOKEN_ESTIMATOR_ID,
    toolResults: records.length,
    distinctPayloads: firstSeen.size,
    repeatResults,
    repeatBytes,
    repeatTokensEstimated,
    totalBytes,
    totalTokensEstimated,
    repeatByteShare: totalBytes > 0 ? repeatBytes / totalBytes : 0,
    repeated,
  };
}

// ---------------------------------------------------------------------------
// Stage-tool disposition. One place decides what a repo_stage call IS, so the extension
// cannot accidentally latch a benign call: a completed plan answering one trailing call
// voided a finished 64/64 native run in rep 1.
// ---------------------------------------------------------------------------
export function stageCallDisposition({ expectedStage, stageCount, toolCallId, usedToolCallIds }) {
  assertExperiment(Number.isSafeInteger(expectedStage) && expectedStage > 0 &&
    Number.isSafeInteger(stageCount) && stageCount > 0, "Stage disposition requires stage counters");
  assertExperiment(typeof toolCallId === "string" && toolCallId.length > 0,
    "Stage disposition requires a tool call id");
  // A replayed tool call id is a real capability breach in either direction and stays latched.
  if (usedToolCallIds?.has?.(toolCallId)) return { kind: "replay", latch: true, isError: true };
  // The plan is complete. A trailing call is a finished assignment being tidy, not a
  // violation: it is answered plainly and NOTHING is written to the failure latch.
  if (expectedStage > stageCount) {
    return {
      kind: "post-plan",
      latch: false,
      isError: false,
      text: `plan complete: all ${stageCount} stages served`,
    };
  }
  return { kind: "serve", latch: false, isError: false };
}

// ---------------------------------------------------------------------------
// Transcript extraction. The model routinely answers a probe wave or writes a deliverable
// one message slot LATE, because it issues the next stage call first and only then writes
// prose. Extraction therefore scans FORWARD from the stage result instead of assuming the
// very next assistant message, and stage results are addressed by the stage ordinal the
// extension stamped into the tool-result details rather than by the position of the call
// in the transcript: one stale-key retry inserts an extra repo_stage call and shifts every
// positional index after it by one (measured in the pifold rep-2 run at call 41, which
// silently moved probe waves 48 and 64 and deliverable-56 onto the wrong window).
// ---------------------------------------------------------------------------
export function assistantText(entry) {
  const message = entry?.type === "message" ? entry.message : null;
  if (message?.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function stageResultIndexByOrdinal(entries) {
  const byStage = new Map();
  entries.forEach((entry, index) => {
    const message = entry?.type === "message" ? entry.message : null;
    if (message?.role !== "toolResult" || message.toolName !== EXPERIMENT_TOOL_NAME) return;
    if (message.isError === true) return;
    const stage = message.details?.stage;
    if (!Number.isSafeInteger(stage) || byStage.has(stage)) return;
    byStage.set(stage, index);
  });
  return byStage;
}

export function probeAnswerPattern(probeId) {
  return new RegExp(`^\\s*[-*]?\\s*${probeId}\\s*[:\\-]\\s*(.+)$`, "im");
}

export function deliverableHeadingPattern(deliverableId) {
  const suffix = /(\d+)$/.exec(String(deliverableId));
  if (!suffix) {
    return new RegExp(String(deliverableId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return new RegExp(`deliverable\\s*[-_ ]?\\s*0*${Number(suffix[1])}\\b`, "i");
}

// The first assistant message in [start, end) whose text satisfies `matches`, plus how many
// non-empty assistant messages were skipped to reach it. Deterministic and artifact-only.
function scanAssistantMessages(entries, start, end, matches) {
  let skipped = 0;
  for (let index = start; index < end; index += 1) {
    const text = assistantText(entries[index]).trim();
    if (!text) continue;
    if (matches(text)) return { index, text, skipped };
    skipped += 1;
  }
  return { index: -1, text: "", skipped };
}

export function probeTranscripts({ entries, plan }) {
  const stageIndex = stageResultIndexByOrdinal(entries);
  const probeStages = plan.stages.filter((stage) => stage.probes.length > 0);
  return probeStages.map((stage, position) => {
    const resultIndex = stageIndex.get(stage.ordinal);
    if (resultIndex === undefined) {
      return {
        stage: stage.ordinal, delivered: false, rawText: "", messagesSkipped: 0,
        answers: stage.probes.map((probe) => ({
          probeId: probe.id, kind: probe.kind, question: probe.question,
          answerText: null, parsed: false,
        })),
      };
    }
    // The answer surface runs to the NEXT PROBE WAVE, not to the next stage: an answer
    // can arrive many stages late, but never legitimately after the following wave.
    const nextProbeStage = probeStages[position + 1];
    const endIndex = (nextProbeStage === undefined
      ? undefined
      : stageIndex.get(nextProbeStage.ordinal)) ?? entries.length;
    const found = scanAssistantMessages(entries, resultIndex + 1, endIndex, (text) =>
      stage.probes.some((probe) => probeAnswerPattern(probe.id).test(text)));
    const rawText = found.text;
    return {
      stage: stage.ordinal,
      delivered: true,
      rawText,
      messagesSkipped: found.index >= 0 ? found.skipped : null,
      answers: stage.probes.map((probe) => {
        const match = probeAnswerPattern(probe.id).exec(rawText);
        return {
          probeId: probe.id,
          kind: probe.kind,
          question: probe.question,
          answerText: match ? match[1].trim() : null,
          parsed: Boolean(match),
        };
      }),
    };
  });
}

export function deliverableTranscripts({ entries, plan }) {
  const stageIndex = stageResultIndexByOrdinal(entries);
  const deliverableStages = plan.stages.filter((stage) => stage.deliverable);
  return deliverableStages.map((stage, position) => {
    const resultIndex = stageIndex.get(stage.ordinal);
    if (resultIndex === undefined) {
      return {
        id: stage.deliverable.id, stage: stage.ordinal, delivered: false, text: "",
        matchedHeading: false, messagesSkipped: 0,
      };
    }
    const nextDeliverableStage = deliverableStages[position + 1];
    const endIndex = (nextDeliverableStage === undefined
      ? undefined
      : stageIndex.get(nextDeliverableStage.ordinal)) ?? entries.length;
    const heading = deliverableHeadingPattern(stage.deliverable.id);
    // The heading always wins; a non-empty block is the fallback for a deliverable the
    // model wrote without titling it.
    const titled = scanAssistantMessages(entries, resultIndex + 1, endIndex,
      (text) => heading.test(text));
    const found = titled.index >= 0
      ? titled
      : scanAssistantMessages(entries, resultIndex + 1, endIndex, () => true);
    return {
      id: stage.deliverable.id,
      stage: stage.ordinal,
      delivered: true,
      text: found.text,
      matchedHeading: titled.index >= 0,
      messagesSkipped: found.index >= 0 ? found.skipped : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-request usage series and OBSERVED prefix invalidations.
//
// A mutation is defined against the PROVIDER's own accounting, not against any design's
// notion of what should have invalidated: a request whose cacheRead falls materially below
// the previous request's total input (cacheRead + inputFresh) re-paid for a prefix it had
// already paid for. interRequestWallMs sits beside it so a 0%-cached request can be
// attributed to a mutation rather than to provider cache TTL eviction (~5-10 minutes).
// ---------------------------------------------------------------------------
export const MUTATION_RELATIVE_TOLERANCE = 0.02;
export const MUTATION_ABSOLUTE_TOLERANCE_TOKENS = 1_024;

export function usageSeriesFromLedger(ledger) {
  assertExperiment(Array.isArray(ledger), "Usage series requires the provider ledger");
  const requestsByOrdinal = new Map(ledger
    .filter((record) => record?.kind === "provider-request")
    .map((record) => [record.ordinal, record]));
  const responses = ledger.filter((record) => record?.kind === "provider-response");
  const series = [];
  let previousTotalInput = null;
  let previousRequestWallMs = null;
  let mutations = 0;
  for (const response of responses) {
    const request = requestsByOrdinal.get(response.requestOrdinal) ?? null;
    const usage = response.usage && typeof response.usage === "object" ? response.usage : {};
    const inputFresh = Number.isFinite(usage.input) ? usage.input : 0;
    const cacheRead = Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
    const cacheWrite = Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
    const output = Number.isFinite(usage.output) ? usage.output : 0;
    const totalInput = inputFresh + cacheRead;
    const requestWallMs = Number.isFinite(request?.wallMs) ? request.wallMs : null;
    const tolerance = previousTotalInput === null ? 0 : Math.max(
      MUTATION_ABSOLUTE_TOLERANCE_TOKENS, MUTATION_RELATIVE_TOLERANCE * previousTotalInput);
    const mutation = previousTotalInput !== null && cacheRead < previousTotalInput - tolerance;
    if (mutation) mutations += 1;
    series.push({
      ordinal: series.length + 1,
      inputFresh,
      cacheRead,
      cacheWrite,
      output,
      cacheShare: totalInput > 0 ? cacheRead / totalInput : null,
      interRequestWallMs: requestWallMs !== null && previousRequestWallMs !== null
        ? requestWallMs - previousRequestWallMs : null,
      mutation,
    });
    previousTotalInput = totalInput;
    if (requestWallMs !== null) previousRequestWallMs = requestWallMs;
  }
  const shares = series.map((entry) => entry.cacheShare).filter((value) => value !== null);
  const pooledCacheRead = series.reduce((total, entry) => total + entry.cacheRead, 0);
  const pooledInput = series.reduce((total, entry) => total + entry.cacheRead + entry.inputFresh, 0);
  return {
    series,
    mutations,
    mutationRule: {
      definition: "cacheRead < previousRequest(cacheRead + inputFresh) - tolerance",
      relativeTolerance: MUTATION_RELATIVE_TOLERANCE,
      absoluteToleranceTokens: MUTATION_ABSOLUTE_TOLERANCE_TOKENS,
      comparableRequests: Math.max(series.length - 1, 0),
    },
    meanCacheShare: shares.length > 0
      ? shares.reduce((total, value) => total + value, 0) / shares.length : null,
    // Token-weighted: the headline as-deployed observation. meanCacheShare stays beside it
    // because a per-request mean hides which requests carried the mass.
    pooledCacheShare: pooledInput > 0 ? pooledCacheRead / pooledInput : null,
  };
}

// ---------------------------------------------------------------------------
// Context event stream metrics: the runtime's own canonical record of what happened to the
// projection, read from the session's context-event customs. Two lenses, both deterministic
// from recorded bytes:
//   - mutation accounting: a mutation is a context.prefix record with change "rewrite". It
//     is STRUCTURAL when cause_event_seqs attributes it to a commit or fold, and a SURFACE
//     rewrite otherwise. Rep 17's wire rule inferred 60 mutations against 38 actual
//     commits; the stream does not have to infer.
//   - mechanism-limited counterfactual: the pooled cache share an ideally behaved
//     positional cache would have served. Ideal cached tokens per request are the shared
//     prefix with the previous projection: divergent_tokens where a divergence was
//     recorded, the full previous projection on an append.
// The wire series (usageSeriesFromLedger) stays beside this as the as-deployed
// observation; the gap between the two lenses belongs to the wire, not the mechanism.
// ---------------------------------------------------------------------------
export const CONTEXT_EVENT_SUFFIX = "context-event";

export function contextEventMetrics(entries) {
  assertExperiment(Array.isArray(entries), "Context event metrics require session entries");
  const events = entries
    .filter((entry) => entry?.type === "custom" && typeof entry.customType === "string" &&
      entry.customType.endsWith(CONTEXT_EVENT_SUFFIX) && entry.data &&
      typeof entry.data === "object")
    .map((entry) => entry.data);
  const byKind = {};
  for (const event of events) byKind[event.kind] = (byKind[event.kind] ?? 0) + 1;
  const prefixes = events.filter((event) => event.kind === "context.prefix");
  const commits = events.filter((event) => event.kind === "context.commit");

  // Tool usage, per action, from the runtime's own attempt records. The rep-23
  // finding (the agent never called the context tool at all) was discovered by hand
  // after the run; every question of that class must be a reported number here.
  const attempts = events.filter((event) => event.kind === "context.attempt");
  const protects = events.filter((event) => event.kind === "context.protect");
  const foldEvents = events.filter((event) => event.kind === "context.fold");
  const byActionUsage = {};
  for (const attempt of attempts) {
    const action = typeof attempt.action === "string" && attempt.action ? attempt.action : "unknown";
    const bucket = byActionUsage[action] ?? (byActionUsage[action] = {
      attempts: 0, accepted: 0, errors: 0, corrected: 0,
      marksRequested: 0, firstOrdinal: null, lastOrdinal: null,
    });
    bucket.attempts += 1;
    if (attempt.ok === true) bucket.accepted += 1;
    else bucket.errors += 1;
    if (Number(attempt.corrections_applied) > 0) bucket.corrected += 1;
    bucket.marksRequested += Number.isFinite(attempt.marks_requested) ? attempt.marks_requested : 0;
    if (Number.isFinite(attempt.ordinal)) {
      bucket.firstOrdinal = bucket.firstOrdinal === null
        ? attempt.ordinal : Math.min(bucket.firstOrdinal, attempt.ordinal);
      bucket.lastOrdinal = bucket.lastOrdinal === null
        ? attempt.ordinal : Math.max(bucket.lastOrdinal, attempt.ordinal);
    }
  }
  // Committed curation mass by origin. A share alone can rise because the denominator
  // fell, so the absolute masses always travel with it.
  let agentFoldedSourceChars = 0;
  let ladderFoldedSourceChars = 0;
  let agentFoldedCount = 0;
  for (const fold of foldEvents) {
    const chars = Number.isFinite(fold.source_chars) ? fold.source_chars : 0;
    if (fold.origin === "agent") { agentFoldedSourceChars += chars; agentFoldedCount += 1; }
    else ladderFoldedSourceChars += chars;
  }
  const lastCommit = commits.length ? commits[commits.length - 1] : null;

  let prefixRewrites = 0;
  let structuralRewrites = 0;
  let surfaceRewrites = 0;
  let idealCachedTokens = 0;
  let projectedTokens = 0;
  const byRequestClass = {};
  let previousTokens = null;
  for (const prefix of prefixes) {
    const estimated = Number.isFinite(prefix.estimated_tokens) ? prefix.estimated_tokens : 0;
    const cause = typeof prefix.cause === "string" ? prefix.cause : "";
    if (prefix.change === "rewrite") {
      prefixRewrites += 1;
      if (cause.includes("context.commit") || cause.includes("context.fold")) {
        structuralRewrites += 1;
      } else {
        surfaceRewrites += 1;
      }
    }
    const cached = previousTokens === null ? 0
      : Number.isFinite(prefix.divergent_tokens)
        ? Math.min(prefix.divergent_tokens, previousTokens)
        : previousTokens;
    idealCachedTokens += cached;
    projectedTokens += estimated;
    const requestClass = typeof prefix.request_class === "string"
      ? prefix.request_class : "unknown";
    const bucket = byRequestClass[requestClass]
      ?? (byRequestClass[requestClass] = { requests: 0, idealCachedTokens: 0, projectedTokens: 0 });
    bucket.requests += 1;
    bucket.idealCachedTokens += cached;
    bucket.projectedTokens += estimated;
    previousTokens = estimated;
  }
  for (const bucket of Object.values(byRequestClass)) {
    bucket.counterfactualCacheShare = bucket.projectedTokens > 0
      ? bucket.idealCachedTokens / bucket.projectedTokens : null;
  }
  return {
    events: events.length,
    byKind,
    prefixEvents: prefixes.length,
    prefixRewrites,
    structuralRewrites,
    surfaceRewrites,
    mutationRule: {
      definition: "context.prefix change=rewrite; structural when cause_event_seqs names a commit or fold",
      comparableRequests: Math.max(prefixes.length - 1, 0),
    },
    commits: commits.filter((event) => event.deferred !== true).length,
    commitsDeferred: commits.filter((event) => event.deferred === true).length,
    folds: byKind["context.fold"] ?? 0,
    toolUsage: {
      attempts: attempts.length,
      zeroContextCalls: attempts.length === 0,
      errors: attempts.filter((event) => event.ok !== true).length,
      corrected: attempts.filter((event) => Number(event.corrections_applied) > 0).length,
      byAction: byActionUsage,
      protectEvents: protects.length,
      protectNoops: protects.filter((event) =>
        event.protected_refs_after === event.protected_refs_before).length,
      definition: "attempts are the runtime's context.attempt records; zeroContextCalls is the " +
        "rep-23 flag; corrected counts attempts whose spans were auto-snapped; protectNoops " +
        "are pins that changed no refs",
    },
    curationMass: {
      committedFolds: foldEvents.length,
      agentFoldedCount,
      agentFoldedSourceChars,
      ladderFoldedSourceChars,
      agentMarkSourcedShare: agentFoldedSourceChars + ladderFoldedSourceChars > 0
        ? agentFoldedSourceChars / (agentFoldedSourceChars + ladderFoldedSourceChars)
        : null,
      pendingMarksAtLastCommit: lastCommit && Number.isFinite(lastCommit.pending_marks)
        ? lastCommit.pending_marks : null,
      definition: "mass is fold-event source_chars split by mark origin; the share is " +
        "agent-mark-sourced, not causal agent contribution, and always travels with its " +
        "numerator and denominator",
    },
    counterfactual: {
      definition: "ideal cached = shared prefix tokens with the previous projection: " +
        "divergent_tokens where recorded, the full previous projection on an append",
      idealCachedTokens,
      projectedTokens,
      pooledCacheShare: projectedTokens > 0 ? idealCachedTokens / projectedTokens : null,
      byRequestClass,
    },
  };
}

// Stall proxy: the agent's own think time between stages. The supervisor's release gate
// delays RELEASE, never the model's next request, so this gap is the model's, not the
// harness's.
export function thinkTimeFromPace(paceRecords) {
  assertExperiment(Array.isArray(paceRecords), "Think time requires the pace ledger");
  const perStage = [];
  for (let index = 0; index + 1 < paceRecords.length; index += 1) {
    const released = paceRecords[index]?.releasedMonotonicMs;
    const requested = paceRecords[index + 1]?.requestedMonotonicMs;
    assertExperiment(Number.isFinite(released) && Number.isFinite(requested),
      `Pace ledger lacks monotonic clocks around stage ${paceRecords[index]?.stage}`);
    perStage.push({
      afterStage: paceRecords[index].stage ?? null,
      beforeStage: paceRecords[index + 1].stage ?? null,
      thinkMs: requested - released,
    });
  }
  const sorted = perStage.map((entry) => entry.thinkMs).sort((left, right) => left - right);
  const rank = (quantile) => sorted.length === 0
    ? null : sorted[Math.max(Math.ceil(quantile * sorted.length) - 1, 0)];
  return {
    definition: "pace[n+1].requestedMonotonicMs - pace[n].releasedMonotonicMs",
    samples: perStage.length,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
    p95Ms: rank(0.95),
    medianMs: rank(0.5),
    perStage,
  };
}

// ---------------------------------------------------------------------------
// Blind grading. The grader sees submissions; it never sees an arm, a run id, a
// guidance profile, or a runtime configuration.
// ---------------------------------------------------------------------------
export const BLIND_FORBIDDEN_KEYS = Object.freeze([
  "arm", "runId", "guidance", "runtime", "manifest", "activeContextEnabled",
  "nativeCompactionEnabled", "campaignId", "runDir", "sessionFile",
]);

export function submissionId(runId, salt) {
  assertExperiment(typeof runId === "string" && runId.length > 0, "Submission id requires a run id");
  assertExperiment(typeof salt === "string" && salt.length >= 16, "Submission id requires a campaign salt");
  return `sub-${sha256Text(`${salt}\u0000${runId}`).slice(0, 16)}`;
}

// Model-authored free text (deliverables, probe answers) is what the grader is FOR, so the
// arm-word scan cannot run over it: "native" and "pressure" are ordinary English and a
// session may legitimately use them. The scan therefore runs over the packet with those
// bodies elided, while the KEY scan runs over everything. Residual risk is stated openly:
// a session that narrates its own context management can self-identify, which is a property
// of the transcript, not of the packet builder, and is why arm identity also never appears
// in any structural field, id, ordering, or file name the grader receives.
export const BLIND_FREE_TEXT_KEYS = Object.freeze(["text", "answerText"]);

function elideFreeText(value) {
  if (Array.isArray(value)) return value.map(elideFreeText);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, BLIND_FREE_TEXT_KEYS.includes(key) ? "<free-text>" : elideFreeText(item)]));
}

export function assertBlindPacket(packet) {
  assertExperiment(packet && typeof packet === "object", "Blind packet must be an object");
  const serialized = JSON.stringify(elideFreeText(packet));
  for (const arm of EXPERIMENT_ARMS) {
    assertExperiment(!new RegExp(`\\b${arm}\\b`, "i").test(serialized),
      `Blind grading packet leaks the arm label ${arm}`);
  }
  for (const profile of EXPERIMENT_GUIDANCE_PROFILES) {
    assertExperiment(!new RegExp(`"guidance"|\\b${profile}\\b`, "i").test(serialized),
      `Blind grading packet leaks the guidance condition ${profile}`);
  }
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      assertExperiment(!BLIND_FORBIDDEN_KEYS.includes(key),
        `Blind grading packet carries the identifying key ${path}.${key}`);
      walk(value[key], `${path}.${key}`);
    }
  };
  walk(packet, "packet");
  return packet;
}
