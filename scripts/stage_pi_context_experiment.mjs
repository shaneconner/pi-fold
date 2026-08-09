#!/usr/bin/env node

// Stage a fold-vs-compaction campaign: pin the target OSS repo at its commit, extract
// probe ground truth MECHANICALLY from the pinned bytes, and emit the stage plan as data.
//
// The plan is hashed; every run manifest pins that hash. Nothing here talks to a model.
//
//   node scripts/stage_pi_context_experiment.mjs --campaign-dir <dir> --mode smoke|full \
//        [--repo ripgrep|gin|flask] [--seed <hex>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  EXPERIMENT_DEFAULT_REPO,
  EXPERIMENT_MODES,
  EXPERIMENT_MODE_PLANS,
  EXPERIMENT_PROTOCOL_VERSION,
  EXPERIMENT_REPOS,
  CONVERSATION_PROBE_KINDS,
  assertExperiment,
  auditDelivery,
  auditStepId,
  auditStepSentence,
  buildAuditTraces,
  buildChainLinkProbes,
  buildConversationProbes,
  buildDerivationControlProbes,
  buildEchoProbes,
  buildIncludeResolver,
  buildProbes,
  codeWordSentence,
  corpusManifestSha256,
  extractDefinitions,
  fileFacts,
  quotedIncludeSpecs,
  seededShuffle,
  stageCodeWords,
  stagePayloadText,
  stagePlanSha256,
  uniqueIdentifierIndex,
  validateStagePlan,
  visibleStage,
} from "./lib/pi_context_experiment.mjs";
import { freshChallenge, sha256Text, writeJsonExclusive } from "./lib/pi_context_soak_attestation.mjs";

const MIN_FILE_LINES = 60;
const MAX_FILE_LINES = 2_500;

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function git(args, options = {}) {
  return execFileSync("/usr/bin/git", args, {
    ...options,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function cloneAtCommit(repo, mirrorDir, checkoutDir) {
  if (!existsSync(mirrorDir)) {
    mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
    git(["init", "--quiet", "--bare", mirrorDir]);
    git(["-C", mirrorDir, "remote", "add", "origin", repo.url]);
  }
  git(["-C", mirrorDir, "fetch", "--quiet", "--depth", "1", "origin", repo.commit]);
  const head = git(["-C", mirrorDir, "rev-parse", "FETCH_HEAD"]).trim();
  assertExperiment(head === repo.commit,
    `Fetched ${head} for ${repo.key}, expected the pinned ${repo.commit}`);
  // Detached worktrees, not shared-index checkouts: every run gets its own pinned tree and
  // its own index, so arms can be staged and run concurrently without racing.
  if (!existsSync(checkoutDir)) {
    git(["-C", mirrorDir, "worktree", "add", "--quiet", "--detach", checkoutDir, repo.commit]);
  }
  return { mirrorDir, checkoutDir, commit: head };
}

function collectSourceFiles(repo, checkoutDir) {
  const roots = repo.sourceRoots.map((root) => root === "." ? checkoutDir : join(checkoutDir, root));
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      const relativePath = relative(checkoutDir, path);
      if (!repo.sourceGlobExtensions.some((extension) => name.endsWith(extension))) continue;
      if (repo.excludePathParts.some((part) => relativePath.includes(part))) continue;
      found.push(path);
    }
  };
  for (const root of roots) {
    assertExperiment(existsSync(root), `Pinned repo is missing its source root ${root}`);
    walk(root);
  }
  assertExperiment(found.length > 0, "Pinned repo yielded no source files");
  return found;
}

// symbol-file probes claim THE defining file, so uniqueness has to hold over the whole
// checkout, not just the collected source roots: a vendored or test copy of a symbol
// would give the probe a second defensible answer. Every text file in the tree votes.
// The same walk asserts no staged code word already exists anywhere in the checkout,
// since arms can read the checkout and a collision would make a conversation probe
// answerable from disk.
const MAX_DEFINITION_SCAN_BYTES = 2_000_000;

function collectCheckoutDefinitions(checkoutDir, codeWords) {
  const codeWordSet = new Set(codeWords);
  const entries = [];
  // EVERY file votes in include resolution (paths), because that is the universe
  // the agent resolves a quoted include against; only text files small enough to
  // scan vote in the symbol index (entries).
  const paths = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) continue;
      paths.push(relative(checkoutDir, path));
      if (stat.size > MAX_DEFINITION_SCAN_BYTES) continue;
      const raw = readFileSync(path);
      if (raw.subarray(0, 8192).includes(0)) continue;
      const text = raw.toString("utf8");
      const collision = (text.match(/cw-[0-9a-f]{6}/g) ?? []).find((word) => codeWordSet.has(word));
      assertExperiment(!collision,
        `Code word ${collision} already exists in ${relative(checkoutDir, path)}; restage with a different seed`);
      entries.push({ path: relative(checkoutDir, path), definitions: extractDefinitions(text) });
    }
  };
  walk(checkoutDir);
  assertExperiment(entries.length > 0, "Pinned checkout yielded no text files for the symbol index");
  return { entries, paths };
}

function readInstruction(stage, files) {
  return [
    `Read every file delivered in this stage of ${stage.repoKey} and build an accurate working`,
    "model of what it does, what it depends on, and which names it exports.",
    `Files in this stage: ${files.map((file) => file.path).join(", ")}.`,
    "Record the specific identifiers and line positions you will need later; you will be asked",
    "about them after many further stages, and you may not get another delivery of these bytes.",
  ].join(" ");
}

function revisitInstruction(stage, files, earlier) {
  return [
    `Read the newly delivered files and then CROSS-REFERENCE them against material you`,
    `already received earlier in this session, specifically stage ${earlier.ordinal}`,
    `(${earlier.paths.join(", ")}).`,
    `New files in this stage: ${files.map((file) => file.path).join(", ")}.`,
    "Name every call, trait, type or route that crosses between the new files and that earlier",
    "material, and say explicitly where each earlier fact came from. Those earlier bytes are not",
    "resent: recover them however you must.",
  ].join(" ");
}

function probeInstruction() {
  return [
    "Answer the following recall questions about material delivered EARLIER in this session.",
    "Answer each one on its own line in the exact form `<probe-id>: <answer>`, then state in one",
    "sentence how you recovered each answer. Answer every question even if you are unsure.",
  ].join(" ");
}

function deliverableInstruction(ordinal, referencesStages) {
  return [
    `Write a short structured note (200-400 words) summarising what you now understand about the`,
    `components read so far. It MUST cite concrete facts (file paths, identifiers, line positions)`,
    `first seen in stage ${referencesStages.join(" and stage ")}, and it must state how each of`,
    `those earlier facts connects to what you read in stage ${ordinal}.`,
  ].join(" ");
}

function buildPlan({ repo, mode, seed, facts, codeWords, uniqueIdentifiers, checkoutPaths }) {
  const modePlan = EXPERIMENT_MODE_PLANS[mode];
  assertExperiment(codeWords.length === modePlan.stageCount,
    "Stage code words must cover every stage");
  const eligible = facts.filter((fact) => fact.lines >= MIN_FILE_LINES && fact.lines <= MAX_FILE_LINES);
  assertExperiment(eligible.length >= modePlan.stageCount,
    `Pinned corpus has ${eligible.length} eligible files, fewer than ${modePlan.stageCount} stages`);
  const order = seededShuffle(eligible.map((fact) => fact.path), `${seed}:reading-order`);
  const byPath = new Map(eligible.map((fact) => [fact.path, fact]));
  let cursor = 0;
  const takeFiles = (targetChars) => {
    const taken = [];
    let chars = 0;
    while (cursor < order.length && (taken.length === 0 || chars < targetChars)) {
      const fact = byPath.get(order[cursor]);
      cursor += 1;
      if (!fact) continue;
      taken.push(fact);
      chars += fact.chars;
    }
    assertExperiment(taken.length > 0, "Pinned corpus exhausted before the stage plan completed");
    return taken;
  };

  // Pass 1: the delivery map alone. File assignment is untouched from protocol v2
  // (takeFiles runs in the same ordinal order), so the corpus workload is
  // unchanged; chains need the FINISHED map before any instruction is written.
  const skeletons = [];
  for (let ordinal = 1; ordinal <= modePlan.stageCount; ordinal += 1) {
    const isProbe = modePlan.probeStages.includes(ordinal);
    const isRevisit = !isProbe && ordinal > modePlan.revisitEvery && ordinal % modePlan.revisitEvery === 0;
    // The code word rides inside the instructions exactly once; the field is the
    // ground-truth copy the run-visible plan keeps only via that woven sentence.
    const codeWord = isProbe ? null : codeWords[ordinal - 1];
    skeletons.push({
      ordinal,
      kind: isProbe ? "probe" : isRevisit ? "revisit" : "read",
      files: isProbe ? [] : takeFiles(modePlan.payloadTargetChars),
      codeWord,
    });
  }

  // Pass 2: audit traces over the finished map. Quoted includes resolve against
  // the WHOLE checkout, the same universe the agent resolves against.
  const resolveInclude = buildIncludeResolver(checkoutPaths);
  const includeTargetCache = new Map();
  const includeTargets = (path) => {
    if (!includeTargetCache.has(path)) {
      const fact = byPath.get(path);
      assertExperiment(fact, `Include reader asked for the undelivered file ${path}`);
      includeTargetCache.set(path,
        quotedIncludeSpecs(fact.text).map((spec) => resolveInclude(path, spec)));
    }
    return includeTargetCache.get(path);
  };
  const chains = buildAuditTraces({
    stages: skeletons,
    seed,
    chainLength: modePlan.chainLength,
    startAfters: modePlan.chainStartAfters,
    earlyLaw: modePlan.chainEarlyLaw,
    includeTargets,
  });
  const chainStepByStage = new Map();
  const chainStageNodes = new Set();
  // Revisit instructions resend an earlier stage's ordinal and full path list,
  // so they must avoid every stage a chain RESOLVES to (both hop answers) and
  // every stage that DELIVERED a chain file (a later mention of a link answer
  // is refused by the plan's anti-leak scan).
  const revisitExcludedStages = new Set();
  const skeletonDelivery = auditDelivery(skeletons);
  for (const chain of chains) {
    for (const link of chain.links) {
      chainStepByStage.set(link.stage, {
        id: auditStepId(chain.id, link.index),
        chainId: chain.id,
        index: link.index,
        hop: link.hop,
        hopIndex: link.hopIndex,
        anchor: link.index === 1 ? link.input : null,
      });
      if (link.hop === "SOF") {
        chainStageNodes.add(link.expectedAnswer);
        revisitExcludedStages.add(link.expectedAnswer);
      }
      if (typeof link.expectedAnswer === "string") {
        const deliveredAt = skeletonDelivery.stageOfPath.get(link.expectedAnswer);
        if (deliveredAt !== undefined) revisitExcludedStages.add(deliveredAt);
      }
    }
  }

  // Pass 3: instructions, probes, payload hashes.
  const usedCarrierStages = new Set();
  const probedLinks = new Set();
  const probedChains = new Set();
  const echoedTargets = new Set();
  const stages = [];
  for (const { ordinal, kind, files: takenFacts, codeWord } of skeletons) {
    const isProbe = kind === "probe";
    const deliverable = ordinal % modePlan.deliverableEvery === 0 && !isProbe
      ? {
        id: `deliverable-${String(ordinal).padStart(2, "0")}`,
        instructions: "",
        referencesStages: [Math.max(1, Math.ceil(ordinal / 4)), Math.max(2, Math.ceil(ordinal / 2))]
          .filter((value, index, all) => value < ordinal && all.indexOf(value) === index),
      }
      : null;
    if (deliverable) {
      assertExperiment(deliverable.referencesStages.length > 0,
        `Deliverable at stage ${ordinal} has no earlier stage to reference`);
      deliverable.instructions = deliverableInstruction(ordinal, deliverable.referencesStages);
    }

    const files = takenFacts;
    let instructions;
    let probes = [];
    if (isProbe) {
      // Each wave follows the mode plan's kind schedule slot by slot: chain-link
      // probes target recorded audit-trace values, an echo restates an earlier
      // answer, conversation probes ask for facts that exist only in the earlier
      // transcript, the wave-64 derivation control prices the hop with nothing
      // to recall, and one repo-class control keeps the corpus baseline.
      const waveIndex = modePlan.probeStages.indexOf(ordinal);
      const waveKinds = modePlan.probeKinds[waveIndex];
      const countOf = (kind) => waveKinds.filter((candidate) => candidate === kind).length;
      const queues = {
        "chain-link": buildChainLinkProbes({
          chains, probeOrdinal: ordinal, seed: `${seed}:probe:${ordinal}`,
          count: countOf("chain-link"), probedLinks, probedChains,
        }),
        echo: buildEchoProbes({
          earlierWaves: stages.filter((stage) => stage.kind === "probe"),
          seed: `${seed}:probe:${ordinal}`,
          count: countOf("echo"), echoedTargets,
        }),
        "derivation-control": buildDerivationControlProbes({
          stages, chains, seed: `${seed}:probe:${ordinal}`,
          count: countOf("derivation-control"), includeTargets,
        }),
        conversation: buildConversationProbes({
          stages,
          probeOrdinal: ordinal,
          seed: `${seed}:probe:${ordinal}`,
          kinds: waveKinds.filter((kind) => CONVERSATION_PROBE_KINDS.includes(kind)),
          usedStages: usedCarrierStages,
          excludedBindingStages: chainStageNodes,
        }),
      };
      const earlierFacts = stages.flatMap((stage) =>
        stage.ordinal <= Math.ceil(ordinal / 2)
          ? stage.files.map((file) => byPath.get(file.path)).filter(Boolean)
          : []);
      assertExperiment(earlierFacts.length > 0, `Probe stage ${ordinal} has no early corpus`);
      queues.repo = buildProbes({
        facts: earlierFacts,
        seed: `${seed}:probe:${ordinal}`,
        count: countOf("repo"),
        uniqueIdentifiers,
        rotationOffset: waveIndex,
      });
      // Ids carry the wave ordinal so they are unique across the WHOLE plan: the
      // grading packet flattens every wave, and a repeated id would leave the
      // grader joining answers to ground truth by position.
      probes = waveKinds.map((kind) => {
        if (kind === "repo") return queues.repo.shift();
        if (CONVERSATION_PROBE_KINDS.includes(kind)) return queues.conversation.shift();
        return queues[kind].shift();
      }).map((probe, index) => ({
        ...probe,
        id: `probe-${String(ordinal).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
      }));
      instructions = probeInstruction();
    } else if (kind === "revisit") {
      const earlierStage = stages.find((stage) => stage.files.length > 0 &&
        stage.ordinal >= Math.max(1, Math.floor(ordinal / 3)) && stage.ordinal < ordinal &&
        !revisitExcludedStages.has(stage.ordinal)) ??
        stages.find((stage) => stage.files.length > 0 && !revisitExcludedStages.has(stage.ordinal));
      assertExperiment(earlierStage, `Revisit stage ${ordinal} has no chain-free earlier stage`);
      instructions = revisitInstruction({ repoKey: repo.key }, files, {
        ordinal: earlierStage.ordinal,
        paths: earlierStage.files.map((file) => file.path),
      });
    } else {
      instructions = readInstruction({ repoKey: repo.key }, files);
    }

    // Weave order is a law: base instructions, then the audit step (task state the
    // next step consumes), then the code word sentence LAST.
    const chainStep = chainStepByStage.get(ordinal) ?? null;
    if (chainStep !== null) instructions = `${instructions} ${auditStepSentence(chainStep)}`;
    if (codeWord !== null) instructions = `${instructions} ${codeWordSentence(ordinal, codeWord)}`;

    const stage = {
      ordinal,
      kind,
      instructions,
      codeWord,
      chainStep,
      files: files.map((fact) => ({
        path: fact.path, sha256: fact.sha256, lines: fact.lines, chars: fact.chars, bytes: fact.bytes,
      })),
      probes,
      deliverable,
      payloadChars: 0,
      payloadSha256: "0".repeat(64),
    };
    // Hash the payload the SESSION will see: ground truth stripped, supervisor nonce elided.
    const visible = {
      ...visibleStage(stage),
      files: files.map((fact) => ({ ...fact })),
    };
    const payload = stagePayloadText(visible);
    stage.payloadChars = payload.length;
    stage.payloadSha256 = sha256Text(payload);
    stages.push(stage);
  }

  const plan = {
    version: EXPERIMENT_PROTOCOL_VERSION,
    mode,
    repo: {
      key: repo.key,
      url: repo.url,
      commit: repo.commit,
      license: repo.license,
      language: repo.language,
      treeSha256: corpusManifestSha256(facts),
    },
    seed,
    stageCount: modePlan.stageCount,
    stageIntervalMs: modePlan.stageIntervalMs,
    watchdogMs: modePlan.watchdogMs,
    heartbeatMs: modePlan.heartbeatMs,
    corpus: {
      files: facts.length,
      eligibleFiles: eligible.length,
      lines: facts.reduce((total, fact) => total + fact.lines, 0),
      chars: facts.reduce((total, fact) => total + fact.chars, 0),
    },
    stages,
    chains,
    probeCount: stages.reduce((total, stage) => total + stage.probes.length, 0),
    deliverableCount: stages.filter((stage) => stage.deliverable).length,
    planSha256: "0".repeat(64),
  };
  plan.planSha256 = stagePlanSha256(plan);
  return validateStagePlan(plan);
}

let result;
try {
  const campaignDir = argumentValue("--campaign-dir");
  const mode = argumentValue("--mode");
  const repoKey = argumentValue("--repo", EXPERIMENT_DEFAULT_REPO);
  assertExperiment(campaignDir, "Staging requires --campaign-dir");
  assertExperiment(EXPERIMENT_MODES.includes(mode), "Staging requires --mode smoke|full");
  assertExperiment(Object.hasOwn(EXPERIMENT_REPOS, repoKey), `Unregistered target repo ${repoKey}`);
  const repo = EXPERIMENT_REPOS[repoKey];
  const seedArgument = argumentValue("--seed");
  assertExperiment(seedArgument === null || /^[0-9a-f]{16,64}$/.test(seedArgument),
    "Staging seed must be 16-64 lowercase hex characters");

  mkdirSync(campaignDir, { recursive: true, mode: 0o700 });
  const checkoutDir = join(campaignDir, "repo");
  const mirrorDir = join(campaignDir, "repo.git");
  cloneAtCommit(repo, mirrorDir, checkoutDir);
  const facts = collectSourceFiles(repo, checkoutDir).map((path) => fileFacts(checkoutDir, path));
  // Chain construction and the code-word collision scan both refuse on bad seeds
  // (roughly half of smoke seeds are chain-unconstructible on the real corpus). An
  // undrawn seed is redrawn up to a bound and every refusal is recorded; a pinned
  // --seed makes ONE attempt, so a published seed reproduces exactly or refuses.
  let plan = null;
  let seed = seedArgument ?? freshChallenge().slice(0, 32);
  const refusedSeeds = [];
  for (;;) {
    try {
      const codeWords = stageCodeWords(seed, EXPERIMENT_MODE_PLANS[mode].stageCount);
      const checkoutDefinitions = collectCheckoutDefinitions(checkoutDir, codeWords);
      plan = buildPlan({
        repo, mode, seed, facts, codeWords,
        uniqueIdentifiers: uniqueIdentifierIndex(checkoutDefinitions.entries),
        checkoutPaths: checkoutDefinitions.paths,
      });
      break;
    } catch (error) {
      if (seedArgument !== null || refusedSeeds.length >= 15) throw error;
      refusedSeeds.push({ seed, reason: error instanceof Error ? error.message : String(error) });
      seed = freshChallenge().slice(0, 32);
    }
  }
  const planPath = join(campaignDir, `stages-${mode}.json`);
  writeJsonExclusive(planPath, plan);
  result = {
    ok: true,
    planPath,
    planSha256: plan.planSha256,
    mode,
    repo: { key: repo.key, commit: repo.commit, license: repo.license },
    seed,
    refusedSeeds,
    corpus: plan.corpus,
    stageCount: plan.stageCount,
    probeCount: plan.probeCount,
    deliverableCount: plan.deliverableCount,
    payloadChars: plan.stages.reduce((total, stage) => total + stage.payloadChars, 0),
    mirrorDir,
    checkoutDir,
  };
} catch (error) {
  result = { ok: false, error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) };
  process.exitCode = 1;
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
