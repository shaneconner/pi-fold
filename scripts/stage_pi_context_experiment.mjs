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
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
  buildLedger,
  buildProbes,
  codeWordSentence,
  codeWordReissueSentence,
  ledgerSentencesForStage,
  ledgerTokensOf,
  plantedWordCollisions,
  stageCodeWordReissues,
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
import {
  buildEndBlockAdjacency,
  buildStaleArtifacts,
  validateStaleArtifacts,
} from "./lib/pi_context_artifacts.mjs";
import { freshChallenge, sha256Text, writeJsonExclusive } from "./lib/pi_context_soak_attestation.mjs";

const MIN_FILE_LINES = 60;
const MAX_FILE_LINES = 2_500;

// THE FROZEN CONTENT SEED. Sealed 2026-08-14, before rep 4's readout, so the
// hidden-mass instrument cannot have been tuned to observed behavior. The file
// is the ONLY source: a flag here would be a knob for re-rolling the mass.
const HIDDEN_MASS_SEEDS_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))),
  "docs", "fold_vs_compaction", "hidden-mass-seeds.json");

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
// The same walk asserts no planted word (code word or ledger token) already exists
// anywhere in the checkout, since arms can read the checkout and a collision would
// make a conversation fact answerable from disk.
const MAX_DEFINITION_SCAN_BYTES = 2_000_000;

function collectCheckoutDefinitions(checkoutDir, plantedWords) {
  const plantedSet = new Set(plantedWords);
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
      const collision = plantedWordCollisions(text, plantedSet)[0];
      assertExperiment(!collision,
        `Planted word ${collision} already exists in ${relative(checkoutDir, path)}: a code ` +
        "word collision restages with a new seed; a ledger collision means the frozen " +
        "content seed cannot stage this checkout");
      entries.push({ path: relative(checkoutDir, path), definitions: extractDefinitions(text) });
    }
  };
  walk(checkoutDir);
  assertExperiment(entries.length > 0, "Pinned checkout yielded no text files for the symbol index");
  return { entries, paths };
}

// The reading task, and nothing about how to remember it (Shane 2026-08-14). This
// used to close with "Record the specific identifiers and line positions you will
// need later", which names the exact three things the repo-class probes ask for.
// Keeping it was defensible while it was the only such line; the second-pass sweep
// found the same direction in the system prompt, and a hoarding instruction is
// still one when it is phrased as ordinary work. Building a working model of what
// the code does, depends on and exports is the assignment and is enough.
function readInstruction(stage, files) {
  return [
    `Read every file delivered in this stage of ${stage.repoKey} and build an accurate working`,
    "model of what it does, what it depends on, and which names it exports.",
    `Files in this stage: ${files.map((file) => file.path).join(", ")}.`,
  ].join(" ");
}

function revisitInstruction(stage, files, earlier) {
  return [
    `Read the newly delivered files and then CROSS-REFERENCE them against material you`,
    `already received earlier in this session, specifically stage ${earlier.ordinal}`,
    `(${earlier.paths.join(", ")}).`,
    `New files in this stage: ${files.map((file) => file.path).join(", ")}.`,
    "Name every call, trait, type or route that crosses between the new files and that earlier",
    "material, and say explicitly where each earlier fact came from.",
  ].join(" ");
}

function probeInstruction() {
  // ASKED AS A COLLEAGUE WOULD ASK, not as a quiz (Shane 2026-08-14). We obviously have to
  // ask, but the framing is a variable and it was set against us: telling a model its recall
  // is about to be scored is an instruction to hoard, and v3 already measured that shape
  // once when sol's summarizer carried 20, 38 and 54 code words verbatim through successive
  // summaries. The format line stays because the grading is mechanical; the premise goes.
  return [
    "Before we carry on, can you tell me a few things about the work so far?",
    "Put each answer on its own line as `<probe-id>: <answer>`, then say in one sentence where",
    "each one came from. If you are not sure of one, say so rather than guessing.",
  ].join(" ");
}

function deliverableInstruction(ordinal, referencesStages) {
  return [
    // IN THE REPLY, not on disk (Shane 2026-08-21: "We're asking for deliverables
    // rather than an actual conversational workflow almost"). "Write a short
    // structured note" plus a `write` tool plus the word deliverable is a pull
    // toward a file, and the smoke run took it: native's attempt on
    // /work/deliverable-03.md ran 2,404 bytes and carried four of the plan's own
    // expectedAnswer values, because a summary of the material is a summary of what
    // the probes ask about. On disk that is a grep-able answer index belonging to
    // neither mechanism under test. Naming the channel is ordinary task
    // specification, it is symmetric across arms, and it says nothing about what to
    // remember or that anything will be asked later.
    `Reply with a short structured note (200-400 words) summarising what you now understand about the`,
    `components read so far. It MUST cite concrete facts (file paths, identifiers, line positions)`,
    `first seen in stage ${referencesStages.join(" and stage ")}, and it must state how each of`,
    `those earlier facts connects to what you read in stage ${ordinal}.`,
  ].join(" ");
}

function buildPlan({
  repo, mode, seed, facts, codeWords, reissueWords, ledger, uniqueIdentifiers, checkoutPaths,
  contentSeed, querySeed,
}) {
  const modePlan = EXPERIMENT_MODE_PLANS[mode];
  assertExperiment(codeWords.length === modePlan.stageCount,
    "Stage code words must cover every stage");
  assertExperiment(reissueWords.length === modePlan.stageCount,
    "Reissue code words must cover every stage");
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
      codeWordReissue: null,
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

  // Pass 2b: code word reissues, AFTER the chains, because a withdrawal names an
  // earlier stage number and the plan's anti-leak law refuses any stage whose
  // text carries both a chain link's stage and that link's path. Revisit
  // instructions already obey this rule for the same reason; a withdrawal is the
  // same shape and obeys it the same way, by declining the announcer rather than
  // by weakening the law. Every reissueEvery-th payload stage has its word
  // withdrawn, announced at the first legal payload stage at least reissueGap
  // later. A stage with no legal announcer left in the run is simply not
  // withdrawn: a correction has to be DELIVERED to be recalled.
  const chainResolvedStages = new Set();
  for (const chain of chains) {
    for (const link of chain.links) {
      // SOF answers with a stage and is anchored by a path; FIN is the reverse.
      // Either way the link BINDS one stage to one path, and the anti-leak law
      // refuses any text carrying both.
      if (link.hop === "SOF") chainResolvedStages.add(link.expectedAnswer);
      if (link.hop === "FIN") chainResolvedStages.add(link.input);
    }
  }
  for (const skeleton of skeletons) {
    if (skeleton.kind === "probe") continue;
    if (skeleton.ordinal % modePlan.reissueEvery !== 0) continue;
    // Excluding every chain-resolved stage is SUFFICIENT rather than merely
    // careful: the only text a withdrawal adds is a mention of stage S, so the
    // law can newly fire only where some link binds S to a path the announcing
    // stage already names. A stage no link resolves to has no such path, and the
    // announcer's own text was already legal. Predicting the paths instead
    // failed: a chain step names its ANCHOR path in its own step sentence, not
    // just the files that stage delivered.
    if (chainResolvedStages.has(skeleton.ordinal)) continue;
    const announcer = skeletons.find((candidate) => candidate.kind !== "probe" &&
      candidate.ordinal >= skeleton.ordinal + modePlan.reissueGap &&
      candidate.codeWordReissue === null);
    if (announcer === undefined) continue;
    announcer.codeWordReissue = {
      stage: skeleton.ordinal,
      codeWord: reissueWords[skeleton.ordinal - 1],
    };
  }

  // Pass 3: instructions, probes, payload hashes.
  const usedCarrierStages = new Set();
  const probedLinks = new Set();
  const probedChains = new Set();
  const echoedTargets = new Set();
  const stages = [];
  for (const { ordinal, kind, files: takenFacts, codeWord, codeWordReissue } of skeletons) {
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
          // Waves alternate between demanding a carrier whose code word was
          // withdrawn and one whose word still stands, wherever the mode's
          // carrier horizon can supply both.
          requireReissued: modePlan.reissueAlternates ? waveIndex % 2 === 0 : null,
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
    // next step consumes), then the ledger block in ledgerSentencesForStage's own
    // canonical order, then the code word sentence LAST with its withdrawal after
    // it, so the two code-word notes still read in the order they were issued.
    const chainStep = chainStepByStage.get(ordinal) ?? null;
    if (chainStep !== null) instructions = `${instructions} ${auditStepSentence(chainStep)}`;
    for (const sentence of ledgerSentencesForStage(ledger, ordinal)) {
      instructions = `${instructions} ${sentence}`;
    }
    if (codeWord !== null) instructions = `${instructions} ${codeWordSentence(ordinal, codeWord)}`;
    // The withdrawal rides LAST, after this stage's own code word, so the two
    // audit notes read in the order they were issued.
    if (codeWordReissue !== null) {
      instructions = `${instructions} ` +
        `${codeWordReissueSentence(codeWordReissue.stage, codeWordReissue.codeWord)}`;
    }

    const stage = {
      ordinal,
      kind,
      instructions,
      codeWord,
      codeWordReissue,
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

  // The asks are built and validated BEFORE the plan literal, so a geometry that cannot
  // seat them (too few delivered stages, an ask with an empty window, a field planted with
  // its own truth) refuses staging rather than shipping a plan the runtime cannot honour.
  const staleArtifacts = buildStaleArtifacts({
    stages, chains, contentSeed, querySeed,
    schemas: modePlan.artifacts.schemas, fieldCount: modePlan.artifacts.fields,
  });
  const artifactVerdict = validateStaleArtifacts({
    artifacts: staleArtifacts, stages, chains, contentSeed, querySeed,
    fieldCount: modePlan.artifacts.fields,
  });

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
    ledger,
    // THE v5 STALE ARTIFACTS (2026-08-25). Built from the plan's own stages and chains
    // once the geometry exists, because every subject is a pass that actually happened and
    // every truth is read from what that pass delivered. Both seeds are the FROZEN ones,
    // never the campaign seed: the material must not be re-rollable by restaging, exactly
    // as the ledger's is not. The end block's adjacency questions ride the query seed
    // alone, since which subject is asked in what order has always been selection.
    staleArtifacts,
    endBlockAdjacency: buildEndBlockAdjacency({
      stages, heldOut: artifactVerdict.heldOut, querySeed,
    }),
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
  // The ledger rides the frozen content seed, never the campaign seed: the same
  // hidden mass appears in every campaign this checkout stages, and the seed
  // redraw loop below can never re-roll it.
  const hiddenMassSeeds = JSON.parse(readFileSync(HIDDEN_MASS_SEEDS_PATH, "utf8"));
  assertExperiment(/^[0-9a-f]{16,64}$/.test(hiddenMassSeeds.contentSeed ?? ""),
    `${HIDDEN_MASS_SEEDS_PATH} carries no contentSeed`);
  // The stale artifacts need the query seed too, and for the same reason the ledger needs
  // the content seed: both were drawn and committed before any rep existed, so no material
  // and no selection can be tuned to a readout.
  assertExperiment(/^[0-9a-f]{16,64}$/.test(hiddenMassSeeds.querySeed ?? ""),
    `${HIDDEN_MASS_SEEDS_PATH} carries no querySeed`);
  const ledger = buildLedger({ mode, contentSeed: hiddenMassSeeds.contentSeed });
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
      const reissueWords = stageCodeWordReissues(seed, EXPERIMENT_MODE_PLANS[mode].stageCount);
      // Every planted set faces the collision scan: a reissued word or a ledger
      // token that already exists in the checkout is answerable from disk
      // exactly as an original code word would be.
      const checkoutDefinitions = collectCheckoutDefinitions(checkoutDir,
        [...codeWords, ...reissueWords, ...ledgerTokensOf(ledger)]);
      plan = buildPlan({
        repo, mode, seed, facts, codeWords, reissueWords, ledger,
        contentSeed: hiddenMassSeeds.contentSeed,
        querySeed: hiddenMassSeeds.querySeed,
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
