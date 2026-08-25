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
  assertExperiment,
  buildIncludeResolver,
  plantedWordCollisions,
  corpusManifestSha256,
  extractDefinitions,
  fileFacts,
  quotedIncludeSpecs,
  seededShuffle,
  stagePayloadText,
  stagePlanSha256,
  validateStagePlan,
  visibleStage,
} from "./lib/pi_context_experiment.mjs";
import {
  buildEndBlockAdjacency,
  buildStaleArtifacts,
  rarestIncludeHops,
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
    // NAMED, NOT DELIVERED (Shane, 2026-08-25). The harness used to paste the bodies in after
    // this sentence; it names the paths and the model opens them itself, so the source lands
    // on the tool-result channel a real session uses.
    //
    // NO PROTOCOL VOCABULARY (Shane, 2026-08-25). This closed with "Files in this stage: ..."
    // and that word is the whole tell: it tells the model the run is a numbered sequence
    // whose units are the thing to keep facts against, which is the premise the exam tests.
    // A person hands over a list of files; they do not number the handover.
    `Read these files from the ${stage.repoKey} checkout at /work and build an accurate working`,
    `model of what they do, what they depend on, and which names they export:`,
    `${files.map((file) => file.path).join(", ")}.`,
  ].join(" ");
}

// The same ask with no protocol vocabulary in it (Shane, 2026-08-25). It used to say
// "CROSS-REFERENCE them against material you already worked through earlier in this session,
// specifically stage N", which names the numbering, names the session, and states that
// earlier material is being held against the model, three tells in one sentence. The earlier
// group is identified by its FILES, which is how a person would refer to it, and the ordinal
// is not passed in at all any more.
function revisitInstruction(stage, files, earlier) {
  return [
    `Read these files from the ${stage.repoKey} checkout at /work:`,
    `${files.map((file) => file.path).join(", ")}.`,
    `Then work out how they connect to this earlier group: ${earlier.paths.join(", ")}.`,
    "Name every call, trait, type or route that crosses between the two groups, and say which",
    "of the earlier files supplied each fact.",
  ].join(" ");
}

function deliverableInstruction() {
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
    //
    // AND NO RETENTION DIRECTIVE (Shane, 2026-08-25). It used to require concrete facts
    // "first seen in stage N and stage M" connected to "what you read in stage O", which
    // names the numbering AND states outright that earlier material must still be held.
    // Asking how the pieces fit together is the same analytical work with none of that said.
    `Reply with a short structured note (200-400 words) summarising what you now understand`,
    `about the components read so far and how the pieces fit together.`,
  ].join(" ");
}

function buildPlan({
  repo, mode, seed, facts, contentSeed, querySeed, checkoutDir, paths,
}) {
  const modePlan = EXPERIMENT_MODE_PLANS[mode];
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
    const isRevisit = ordinal > modePlan.revisitEvery && ordinal % modePlan.revisitEvery === 0;
    skeletons.push({
      ordinal,
      kind: isRevisit ? "revisit" : "read",
      files: takeFiles(modePlan.payloadTargetChars),
    });
  }

  // THE AUDIT TRACES AND THE CODE WORDS ARE DELETED (Shane, 2026-08-25).
  //
  // They were the last two instruments that could only be expressed in protocol vocabulary,
  // and between them they wrote "AUDIT TRACE trace-a, step 02", "Audit note: the code word
  // for stage 03 is ...", "name the 2nd file assigned by the stage you recorded as
  // trace-a-01" and "Record it on its own line as `trace-a-02: <path>`" into the model's
  // own instructions: 24 trace headers, 102 code-word mentions and 83 audit notes across a
  // 64-stage plan. sol-20260825-readfull proved what that buys. Native's compaction summary
  // came back organised as "Stage 01 analyzed ...", "Stage 02 analyzed ...", with a
  // "Critical Context" section listing every code word with its corrections resolved, and
  // every trace answer. (The words themselves are NOT quoted here: this file is copied into
  // the sandbox, and the seeded-token scan catches a planted value sitting anywhere the
  // model's own grep can reach it.) The model had correctly read
  // the run as an exam over numbered units and was keeping an index against them, which is
  // the premise the experiment is supposed to withhold.
  //
  // Nothing replaces them. Recall is measured by material a working session would actually
  // contain: the stale artifacts, which ask the model to correct an out-of-date note, and
  // the end block, which asks which files came in around a named one. Neither says a
  // numbering exists, and neither can be answered by transcribing a summary's own headings.
  //
  // Sealed plans keep theirs and keep validating: `plan.chains`, `codeWord`, `codeWordReissue`
  // and `chainStep` stay in the shape and stay graded, exactly as the probe waves did.
  const chains = [];

  // Pass 3: instructions and payload hashes.
  const stages = [];
  for (const { ordinal, kind, files: takenFacts } of skeletons) {
    const deliverable = ordinal % modePlan.deliverableEvery === 0
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
      deliverable.instructions = deliverableInstruction();
    }

    const files = takenFacts;
    let instructions;
    if (kind === "revisit") {
      // The exclusion set went with the chains: it existed only so a revisit could not name
      // both a chain link's stage number and that link's path in one instruction.
      const earlierStage = stages.find((stage) => stage.files.length > 0 &&
        stage.ordinal >= Math.max(1, Math.floor(ordinal / 3)) && stage.ordinal < ordinal) ??
        stages.find((stage) => stage.files.length > 0);
      assertExperiment(earlierStage, `Revisit stage ${ordinal} has no earlier stage to name`);
      instructions = revisitInstruction({ repoKey: repo.key }, files, {
        paths: earlierStage.files.map((file) => file.path),
      });
    } else {
      instructions = readInstruction({ repoKey: repo.key }, files);
    }

    // NOTHING IS WOVEN IN AFTER THE ASK ANY MORE. The audit step, the code word and its
    // withdrawal used to append here, in that order; all three are deleted above.
    const stage = {
      ordinal,
      kind,
      instructions,
      // Always null, for the same reason `probes` is always empty: sealed plans carry
      // these and every reader still keys off them; nothing this builder makes fills them.
      codeWord: null,
      codeWordReissue: null,
      chainStep: null,
      files: files.map((fact) => ({
        path: fact.path, sha256: fact.sha256, lines: fact.lines, chars: fact.chars, bytes: fact.bytes,
      })),
      // Always empty. The field stays because a sealed plan carries its waves here and
      // every reader still keys off it; nothing this builder makes ever fills it.
      probes: [],
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

  // THE CROSS-REFERENCE RELATION IS A PROPERTY OF THE CORPUS (2026-08-26). "This file's
  // include of X resolves to Y" used to be read off the audit trace chains' INC links, and
  // when the chains went with the de-priming deletion (e656ff0) full mode stopped staging
  // altogether: crossref is one of its four schemas and had nothing left to draw. The
  // relation never needed a chain. One hop per staged file that has a resolvable quoted
  // include, in stage order, resolved through the same two primitives the adjudicator
  // grades an agent's own answer with, so the instrument cannot disagree with its ground
  // truth. Recorded in the plan, which is what lets the ask be regenerated from the plan
  // alone exactly as it was from the chains.
  const resolveInclude = buildIncludeResolver(paths);
  const resolvedIncludes = stages.flatMap((stage) => stage.files.map((file) => ({
    stage: stage.ordinal,
    input: file.path,
    targets: [...new Set(quotedIncludeSpecs(readFileSync(join(checkoutDir, file.path), "utf8"))
      .map((spec) => resolveInclude(file.path, spec))
      .filter((resolved) => resolved !== null && resolved !== file.path))],
  })));
  const includeHops = rarestIncludeHops(resolvedIncludes);

  // The asks are built and validated BEFORE the plan literal, so a geometry that cannot
  // seat them (too few delivered stages, an ask with an empty window, a field planted with
  // its own truth) refuses staging rather than shipping a plan the runtime cannot honour.
  const staleArtifacts = buildStaleArtifacts({
    stages, chains, includeHops, contentSeed, querySeed,
    schemas: modePlan.artifacts.schemas, fieldCount: modePlan.artifacts.fields,
  });
  const artifactVerdict = validateStaleArtifacts({
    artifacts: staleArtifacts, stages, chains, includeHops, contentSeed, querySeed,
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
    includeHops,
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
  // The hidden mass rides the FROZEN seeds, never the campaign seed, so the same material
  // appears in every campaign this checkout stages and the seed redraw loop below can
  // never re-roll it.
  const hiddenMassSeeds = JSON.parse(readFileSync(HIDDEN_MASS_SEEDS_PATH, "utf8"));
  assertExperiment(/^[0-9a-f]{16,64}$/.test(hiddenMassSeeds.contentSeed ?? ""),
    `${HIDDEN_MASS_SEEDS_PATH} carries no contentSeed`);
  // The stale artifacts need the query seed too, and for the same reason the ledger needs
  // the content seed: both were drawn and committed before any rep existed, so no material
  // and no selection can be tuned to a readout.
  assertExperiment(/^[0-9a-f]{16,64}$/.test(hiddenMassSeeds.querySeed ?? ""),
    `${HIDDEN_MASS_SEEDS_PATH} carries no querySeed`);

  // Chain construction and the code-word collision scan both refuse on bad seeds
  // (roughly half of smoke seeds are chain-unconstructible on the real corpus). An
  // undrawn seed is redrawn up to a bound and every refusal is recorded; a pinned
  // --seed makes ONE attempt, so a published seed reproduces exactly or refuses.
  let plan = null;
  let seed = seedArgument ?? freshChallenge().slice(0, 32);
  const refusedSeeds = [];
  for (;;) {
    try {
      // The collision scan outlives the code words: it now guards the ONE planted set left,
      // the seeded values the stale artifacts carry, which are answerable from disk exactly
      // as a code word would have been if the checkout already contained them.
      // The path universe the scan collects is the same one an agent resolves a quoted
      // include against, and the cross-reference relation is read against it, so it is
      // taken from here rather than rebuilt from the staged subset.
      const { paths } = collectCheckoutDefinitions(checkoutDir, []);
      plan = buildPlan({
        repo, mode, seed, facts, checkoutDir, paths,
        contentSeed: hiddenMassSeeds.contentSeed,
        querySeed: hiddenMassSeeds.querySeed,
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
