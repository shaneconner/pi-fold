// Stale-artifact collection: the v5 graded instrument (Shane, 2026-08-25).
//
// WHY THIS REPLACES THE SEEDED LEDGER. On 2026-08-25 the sealed corpus showed that a
// native run's table score IS its compaction summary's table content, as a SET identity:
// nativefence rep4 carried rows {1..7} in its final summary and scored exactly {1..7},
// contiguous from row 1, so the first summary truncated and Pi's "PRESERVE all existing
// information" update pass froze that truncation for the rest of the run. The ledger's
// shape (enumerated rows, key-value checksums, short opaque tokens, each stated in a
// sentence that names itself as audit data) is near-ideal for that ratchet, so 26 of 30
// points measured transcription rather than recall. Measured on the same run's final
// summary: ledger table values 16/16 present, trace-chain answers 21/24, and STAGE FILE
// MEMBERSHIP 70 of 263 (26.6 percent), with 37 of 64 stages naming no file at all.
//
// So the material here is stage membership and its relations. It satisfies three
// properties the ledger did not:
//   - TRANSCRIPT-ONLY. Stage responses are truncated on read (gate 74) and the grouping of
//     files into passes is harness-invented, so it cannot be re-derived from the checkout.
//   - INCIDENTAL. It is never announced. It is just the work description ("Files in this
//     stage: ..."), which is why the summarizer compresses 64 stages of it into one line
//     per range instead of transcribing it.
//   - WORKED FOR. The model read those files, together, in one message. Remembering what
//     came in alongside something is what a long session is supposed to preserve.
//
// AND THE COLLECTION IS A STALE ARTIFACT, NOT A QUESTION. The harness drops a plausible,
// out-of-date project file into the checkout immediately before asking about it,
// pre-populated with WRONG values, and asks the model to bring it up to date. It edits
// with stock read/edit/write. No bespoke tool, no question format, no probe ids, nothing
// announcing a test. The wrong values make it self-scoring against copying and yield three
// distinguishable outcomes per field where a probe yields two:
//     corrected                    -> real recall
//     left stale                   -> no recall (or copied the file back)
//     changed to something else    -> confabulation
// An explicit "unverified" marker is a FOURTH outcome, scored as abstention rather than
// failure, because declining to change a value you are unsure of is honest behaviour.
//
// RE-INJECTION IS THE HAZARD THIS FILE IS BUILT AROUND. An artifact shows the model most of
// the truth in order to ask which parts are wrong, so after each ask those groupings are
// back in the window and the next summary can capture them. Three bounds, all asserted by
// the validator: every ask covers a DISJOINT set of stages; a HELD-OUT set that no ask
// touches is reserved for the end block; and the asks rotate schema, subject and wording so
// the shape never becomes a recognisable ritual that teaches what to hoard.

import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, statSync, truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  assertExperiment,
  seededSequence,
  seededShuffle,
} from "./pi_context_experiment.mjs";

// ---------------------------------------------------------------------------
// The four schemas. Shane 2026-08-25: "not the same type of information either
// otherwise they'll just say to capture any data in this format". Each ask
// rotates BOTH the file shape and the relation it asks about, and the request
// wording differs every time so the ask never becomes a ritual.
// ---------------------------------------------------------------------------

// IN-RUN schemas, and the END-BLOCK schema that is never one of them.
//
// Shane 2026-08-25: "remember not to ask the same question type at each gate as they will
// be primed to capture something once asked about a type of thing." Rotating the schemas
// is not enough on its own. Asking a type ONCE teaches that the type gets asked about, and
// the model hoards that type for the rest of the run, so an end block asking a relation any
// ask already used measures the priming rather than what the mechanism preserved. The end
// block therefore owns a relation no in-run ask can touch, and the validator refuses an
// overlap by name.
//
// It also forced a cut. `inventory` (file -> pass) was the INVERSE of `manifest`
// (pass -> files), which is one type of thing wearing two schemas: a model that starts
// keeping "which files were in which pass" answers both, so the second ask would have
// scored the first ask's priming. `extent` replaces it with a cardinality, which needs the
// same material and is a different question about it.
export const ARTIFACT_SCHEMAS = Object.freeze(["manifest", "worklog", "extent", "crossref"]);

// Adjacency needs BOTH grouping and sequence and is neither, so no in-run ask primes for
// it. It is the end block's alone.
export const ARTIFACT_END_BLOCK_SCHEMA = "adjacency";

export const ARTIFACT_UNVERIFIED = "unverified";

// `fieldCount` is a MAXIMUM, not a promise. A smoke plan runs eight stages and one short
// chain, so a schema's material can seat fewer fields than a full plan's; the ask takes
// what exists and the floor below is what refuses a geometry too thin to measure anything.
// Two is the floor because a single-field ask is one coin flip.
export const ARTIFACT_MIN_FIELDS = 2;

// A relation each schema asks about, and what makes it hard.
//   manifest   pass -> files            grouping     (transcript-only)
//   worklog    subsystem -> order       sequence     (transcript-only)
//   extent     pass -> size             cardinality  (transcript-only)
//   crossref   file -> include target   relationship (RE-DERIVABLE; see below)
//   adjacency  pass -> neighbour        END BLOCK ONLY, never asked in run
//
// crossref is deliberately kept even though a model can re-open the file and
// resolve the include itself. It is the CONTROL: it measures re-derivation where
// the other three measure recall, and a run that aces crossref while failing
// manifest is telling us it worked rather than remembered. Its fields carry
// `rederivable: true` so grading never pools the two.
const SCHEMA_RELATIONS = Object.freeze({
  manifest: Object.freeze({ relation: "pass-to-files", rederivable: false }),
  worklog: Object.freeze({ relation: "subsystem-to-order", rederivable: false }),
  extent: Object.freeze({ relation: "pass-to-size", rederivable: false }),
  crossref: Object.freeze({ relation: "file-to-include-target", rederivable: true }),
  adjacency: Object.freeze({ relation: "pass-to-neighbour", rederivable: false }),
});

// The request wording, one per schema, deliberately unlike each other and unlike
// anything that announces a test. Gate 62's TEST_AWARENESS_PATTERNS scan these.
const SCHEMA_REQUESTS = Object.freeze({
  manifest: "I found this in my notes from an earlier pass over the tree. It has drifted " +
    "from what we actually worked through, and I would rather not re-derive it from scratch. " +
    "Could you fix the entries you can speak to and leave anything you are unsure about alone?",
  worklog: "Here is the running worklog. It got jumbled when I moved things around and I " +
    "no longer trust the ordering. Put these back in the order we actually covered them, " +
    "and mark anything you cannot place rather than guessing at it.",
  extent: "These counts came from a tally I no longer trust; a few of them are off. " +
    "Set the ones you can vouch for to the right number and leave the others as they are.",
  crossref: "The cross-reference index has some broken links in it. Where you can, point " +
    "each one at the file it actually resolves to; where you cannot, say so in place.",
});

// Where each schema lands in the checkout. Plausible project locations, never a
// directory the corpus itself uses, so a planted file can never shadow curl source.
const SCHEMA_PATHS = Object.freeze({
  manifest: "notes/review-passes.md",
  worklog: "notes/worklog.md",
  extent: "notes/tally.md",
  crossref: "notes/xref.md",
});

export function artifactSchemaRelation(schema) {
  const entry = SCHEMA_RELATIONS[schema];
  assertExperiment(entry !== undefined, `Unknown stale-artifact schema ${schema}`);
  return entry;
}

export function artifactRequestText(schema) {
  const text = SCHEMA_REQUESTS[schema];
  assertExperiment(typeof text === "string", `Unknown stale-artifact schema ${schema}`);
  return text;
}

export function artifactPath(schema) {
  const path = SCHEMA_PATHS[schema];
  assertExperiment(typeof path === "string", `Unknown stale-artifact schema ${schema}`);
  return path;
}

// ---------------------------------------------------------------------------
// Ask geometry: which stages each ask may draw on, and which are held out.
// ---------------------------------------------------------------------------

/**
 * Split the run into one subject window per ask plus a HELD-OUT tail the end block
 * owns alone.
 *
 * An ask may only draw subjects from stages STRICTLY BEFORE it, because a stage the
 * model has not seen yet is not a memory question, and it may not draw from a window
 * another ask already used, because the first ask puts its own answers back in the
 * window and a second ask over the same stages would score that re-injection.
 *
 * The held-out set is the reason the end block can still measure anything: no artifact
 * ever names those stages, so nothing re-injects them and the only carrier is whatever
 * the mechanism under test preserved.
 */
export function artifactWindows({ eligible, askCount, holdOutShare = 0.25 }) {
  assertExperiment(Array.isArray(eligible) && eligible.length > 0,
    "Artifact windows require the eligible stage ordinals");
  assertExperiment(Number.isSafeInteger(askCount) && askCount > 0,
    "Artifact windows require a positive ask count");
  assertExperiment(holdOutShare > 0 && holdOutShare < 1,
    "Artifact hold-out share must sit strictly between 0 and 1");

  // ELIGIBLE, not every ordinal: a stage that delivered no files (today, the probe
  // stages) has no membership to remember and cannot be anyone's subject.
  const ordered = [...eligible].sort((left, right) => left - right);
  const heldOutCount = Math.max(1, Math.round(ordered.length * holdOutShare));
  assertExperiment(ordered.length - heldOutCount >= askCount,
    `${ordered.length} eligible stages cannot seat ${askCount} asks beside a hold-out of ${heldOutCount}`);

  // Hold out an INTERLEAVED set rather than a suffix. A suffix hold-out would make every
  // end-block subject recent, which measures the tail of the window rather than the whole
  // run; taking every k-th stage spreads the held-out subjects across the entire span so
  // the end block asks about early material the way it asks about late material.
  const stride = ordered.length / heldOutCount;
  const heldOut = new Set();
  for (let index = 0; index < heldOutCount; index += 1) {
    heldOut.add(ordered[Math.min(ordered.length - 1, Math.floor(index * stride))]);
  }

  const subjectStages = ordered.filter((ordinal) => !heldOut.has(ordinal));

  // One window per ask, in run order, each ask asking about the window that closed
  // before it. The ask itself sits after its own window so every subject is already past.
  const windows = [];
  const per = Math.floor(subjectStages.length / askCount);
  for (let index = 0; index < askCount; index += 1) {
    const start = index * per;
    const end = index === askCount - 1 ? subjectStages.length : start + per;
    windows.push(subjectStages.slice(start, end));
  }
  return { heldOut: [...heldOut].sort((left, right) => left - right), windows };
}

// ---------------------------------------------------------------------------
// Field construction, one builder per schema. Every truth is READ from the plan's
// own stage composition; nothing is authored. Every stale value is drawn from the
// same universe as its truth, so a wrong value is always plausible and a model
// cannot spot the plant by shape alone.
// ---------------------------------------------------------------------------

/**
 * A seeded shuffle with NO FIXED POINTS.
 *
 * A plain shuffle is wrong here: the worklog plants an order, and any entry the shuffle
 * happens to leave in its own place is planted with its own truth, so a model that never
 * touched the file would score a correction for it. The validator caught exactly that on
 * the first real plan (af-04 entry-04). Fixed points are repaired by swapping each with
 * its neighbour, which preserves the seeded arrangement everywhere else.
 */
export function seededDerangement(items, seed) {
  assertExperiment(Array.isArray(items) && items.length > 1,
    "A derangement needs at least two entries");
  const order = seededShuffle(items, seed);
  for (let index = 0; index < order.length; index += 1) {
    if (order[index] !== items[index]) continue;
    const swap = index === order.length - 1 ? index - 1 : index + 1;
    [order[index], order[swap]] = [order[swap], order[index]];
  }
  assertExperiment(order.every((value, index) => value !== items[index]),
    "Derangement left an entry in its own position");
  return order;
}

function wrongPick(candidates, truth, draw) {
  const others = candidates.filter((candidate) => candidate !== truth);
  assertExperiment(others.length > 0, "A stale value needs at least one alternative to draw");
  return others[draw % others.length];
}

function manifestFields({ stages, window, seed, fieldCount }) {
  const subjects = seededShuffle(window, `${seed}:manifest:subjects`).slice(0, fieldCount);
  const draws = seededSequence(`${seed}:manifest:values`, subjects.length);
  // The substituted path is drawn from OUTSIDE this note. Every file is delivered exactly
  // once, so a wrong path taken from a pass the note also lists shows the same file under
  // two headings: a visible inconsistency a careful reader resolves without remembering
  // anything, which would score as recall. Measured at 1 of 6 fields before this.
  const seated = new Set(subjects.flatMap((ordinal) =>
    (stages.find((candidate) => candidate.ordinal === ordinal)?.files ?? []).map((file) => file.path)));
  const allPaths = stages.flatMap((stage) => stage.files.map((file) => file.path))
    .filter((path) => !seated.has(path));
  return subjects.sort((left, right) => left - right).map((ordinal, index) => {
    const stage = stages.find((candidate) => candidate.ordinal === ordinal);
    assertExperiment(stage !== undefined, `Artifact subject names no stage ${ordinal}`);
    const truth = stage.files.map((file) => file.path).sort();
    // Exactly one path in the listing is wrong, drawn from a DIFFERENT pass. One wrong
    // entry per field is what makes "left stale" and "corrected" separable: a field the
    // model never touched still reads as the stale listing, and a corrected one differs
    // in exactly the substituted path.
    const swapIndex = draws[index] % truth.length;
    const stale = [...truth];
    stale[swapIndex] = wrongPick(allPaths, truth[swapIndex], draws[index]);
    return {
      // NUMBERED BY POSITION IN THE NOTE, never by the harness stage ordinal. A note that
      // labels its third entry "pass-27" hands the model a stage number it was never given
      // as a fact, and the pass is identified by the files listed under it anyway, which is
      // what the model actually read.
      key: `pass-${String(index + 1).padStart(2, "0")}`,
      subjectStage: ordinal,
      truth,
      // SORTED, so a listing the model never touched parses back byte-identical to what was
      // planted. Leaving the substitution in place broke sort order, and the parser sorts,
      // so three of four fields read as neither truth nor plant: the planted file graded
      // itself as confabulation.
      stale: [...stale].sort(),
      rederivable: false,
    };
  });
}

function worklogFields({ stages, window, seed, fieldCount }) {
  const subjects = seededShuffle(window, `${seed}:worklog:subjects`).slice(0, fieldCount)
    .sort((left, right) => left - right);
  // The truth is the ORDER these passes happened in, so the field value is the pass's
  // rank among the subjects rather than its ordinal: the model is being asked to sequence
  // what it saw, not to recall a harness number it was never given as a fact.
  const stale = seededDerangement(subjects, `${seed}:worklog:order`);
  assertExperiment(stale.length === subjects.length, "Worklog stale order lost an entry");
  return subjects.map((ordinal, index) => {
    const stage = stages.find((candidate) => candidate.ordinal === ordinal);
    assertExperiment(stage !== undefined, `Artifact subject names no stage ${ordinal}`);
    return {
      // Keyed by the leading file, which is what the model actually read: a harness entry
      // number was never a fact it was given. The graded value is where the entry belongs
      // in the sequence, so the parse of every schema returns the same key -> value shape.
      key: stage.files[0].path,
      subjectStage: ordinal,
      truth: index + 1,
      stale: stale.indexOf(ordinal) + 1,
      rederivable: false,
    };
  });
}

function extentFields({ stages, window, seed, fieldCount }) {
  // How many files a pass carried. The same material as the manifest, asked as a
  // cardinality rather than a listing, so a model hoarding one does not get the other for
  // free. The subject is named by its FIRST file, which is what the model actually read;
  // naming it by a harness pass number would ask about a fact it was never given.
  const subjects = seededShuffle(window, `${seed}:extent:subjects`).slice(0, fieldCount)
    .sort((left, right) => left - right);
  const draws = seededSequence(`${seed}:extent:values`, subjects.length);
  return subjects.map((ordinal, index) => {
    const stage = stages.find((candidate) => candidate.ordinal === ordinal);
    assertExperiment(stage !== undefined, `Artifact subject names no stage ${ordinal}`);
    const truth = stage.files.length;
    // A wrong count is drawn NEAR the truth, never from the whole range: an off-by-four
    // tally is a typo a reader would catch without remembering anything, and the field
    // would then measure arithmetic plausibility rather than recall.
    const offset = (draws[index] % 2 === 0 ? 1 : -1) * (1 + (draws[index] % 2));
    return {
      key: stage.files[0].path,
      subjectStage: ordinal,
      truth,
      stale: Math.max(1, truth + offset) === truth ? truth + 1 : Math.max(1, truth + offset),
      rederivable: false,
    };
  });
}

function crossrefFields({ chains, stages, seed, fieldCount }) {
  // The include hops of the audit trace chains: "this file's include of X resolves to Y".
  // A relationship between two earlier items, and the one schema a model can answer by
  // re-opening the file, which is why its fields are marked rederivable.
  const hops = chains.flatMap((chain) =>
    chain.links
      .filter((link) => link.hop === "INC")
      .map((link) => ({ chainId: chain.id, input: link.input, truth: link.expectedAnswer })));
  assertExperiment(hops.length > 0, "No include hops exist to build a cross-reference index");
  const chosen = seededShuffle(hops, `${seed}:crossref:subjects`).slice(0, fieldCount);
  const draws = seededSequence(`${seed}:crossref:values`, chosen.length);
  // A broken link is drawn from EVERY delivered path, not only from the other include
  // targets. Smoke mode runs one short chain, so the target pool can hold a single entry
  // and `wrongPick` had nothing to draw: staging died with "a stale value needs at least
  // one alternative to draw". A link pointing at some other file in the tree is exactly as
  // plausible as one pointing at another chain's target, and the wider pool exists at every
  // mode.
  const targets = [
    ...hops.map((hop) => hop.truth),
    ...(stages ?? []).flatMap((stage) => (stage.files ?? []).map((file) => file.path)),
  ];
  return chosen.map((hop, index) => ({
    key: String(hop.input),
    truth: String(hop.truth),
    stale: String(wrongPick(targets, hop.truth, draws[index])),
    rederivable: true,
  }));
}

// ---------------------------------------------------------------------------
// The plan surface
// ---------------------------------------------------------------------------

/**
 * Build the stale-artifact asks for a plan. A pure function of (stages, chains,
 * contentSeed, querySeed): the same inputs regenerate the same asks byte for byte,
 * which is what lets the validator re-derive the whole set and refuse any drift.
 */
export function buildStaleArtifacts({
  stages, chains, contentSeed, querySeed, schemas: allowed, fieldCount,
}) {
  assertExperiment(Array.isArray(stages) && stages.length > 0,
    "Stale artifacts require the plan's stages");
  assertExperiment(typeof contentSeed === "string" && /^[0-9a-f]{16,64}$/.test(contentSeed),
    "Stale artifacts require the frozen content seed");
  assertExperiment(typeof querySeed === "string" && /^[0-9a-f]{16,64}$/.test(querySeed),
    "Stale artifacts require the frozen query seed");
  // The MODE names its schemas, because not every mode can exercise every one: smoke's
  // single short chain seats one crossref field, below the floor. Naming them states the
  // coverage instead of silently seating a thinner ask.
  assertExperiment(Array.isArray(allowed) && allowed.length > 0 &&
    allowed.every((schema) => ARTIFACT_SCHEMAS.includes(schema)) &&
    new Set(allowed).size === allowed.length,
  `Stale artifacts require a distinct subset of ${ARTIFACT_SCHEMAS.join(", ")}`);
  assertExperiment(Number.isSafeInteger(fieldCount) && fieldCount >= ARTIFACT_MIN_FIELDS,
    `Stale artifacts require at least ${ARTIFACT_MIN_FIELDS} fields per ask`);

  const eligible = stages.filter((stage) => (stage.files ?? []).length > 0).map((stage) => stage.ordinal);
  const stageCount = stages.length;
  const { heldOut, windows } = artifactWindows({ eligible, askCount: allowed.length });
  const seed = `${contentSeed}:${querySeed}:artifacts`;

  // Schema order is drawn from the QUERY seed, not the content seed: what is asked and in
  // what order is selection, and selection has always been the query seed's job.
  // Shuffled from a CANONICAL ORDER, so the result is a function of the schema SET rather
  // than of the order it arrived in. The validator regenerates from the built asks' own
  // schema list, which is already shuffled, and without this the shuffle applied twice and
  // every full-mode plan was refused as drift against itself.
  const schemas = seededShuffle([...allowed].sort(), `${querySeed}:artifact-schemas`);

  return schemas.map((schema, index) => {
    const window = windows[index];
    assertExperiment(window.length > 0, `Artifact ask ${index + 1} has an empty subject window`);
    // The ask fires one stage after its window closes, so every subject is already past
    // and the model is never asked about material it has not been given.
    const askStage = Math.min(stageCount, window[window.length - 1] + 1);
    const askSeed = `${seed}:${index}`;
    const fields = schema === "manifest" ? manifestFields({ stages, window, seed: askSeed, fieldCount })
      : schema === "worklog" ? worklogFields({ stages, window, seed: askSeed, fieldCount })
        : schema === "extent" ? extentFields({ stages, window, seed: askSeed, fieldCount })
          : crossrefFields({ chains: chains ?? [], stages, seed: askSeed, fieldCount });
    assertExperiment(fields.length >= ARTIFACT_MIN_FIELDS,
      `Artifact ask ${index + 1} (${schema}) seats ${fields.length} fields, below the ` +
      `floor of ${ARTIFACT_MIN_FIELDS}: this mode's geometry cannot measure it`);
    return {
      id: `af-${String(index + 1).padStart(2, "0")}`,
      schema,
      relation: artifactSchemaRelation(schema).relation,
      rederivable: artifactSchemaRelation(schema).rederivable,
      askStage,
      window,
      path: artifactPath(schema),
      request: artifactRequestText(schema),
      fields,
    };
  }).concat();
}

/**
 * The end block: one adjacency question per held-out pass, asked about a relation no
 * in-run artifact touched.
 *
 * The subjects are the held-out stages, which no ask ever re-injected, and the relation is
 * one no ask ever primed for. Both holds are needed. Holding out the stages alone still
 * lets an ask teach "groupings get asked about", after which the model keeps groupings for
 * the whole run and the end block scores that habit; holding out the relation alone lets
 * the asks put the very subjects back in the window.
 *
 * Adjacency is asked as a NEIGHBOUR rather than a pass number: what came in just before or
 * just after, identified by the files, because a harness pass number was never a fact the
 * model was given and asking for one measures whether it invented a counter.
 *
 * IT ASKS FOR ANY TWO, NOT FOR THE WHOLE PASS. Passes run from two files to nine, so an
 * exact-set answer would be near-impossible on the wide ones and nearly free on the narrow
 * ones, and the score would track pass width rather than memory. Naming any two is a
 * question a person would actually ask, and it grades as PRECISION over what was named,
 * which is the same difficulty whatever the pass holds.
 */
export const ADJACENCY_NAMES_WANTED = 2;
export function buildEndBlockAdjacency({ stages, heldOut, querySeed }) {
  assertExperiment(Array.isArray(heldOut) && heldOut.length > 0,
    "The end block needs held-out stages to ask about");
  assertExperiment(typeof querySeed === "string" && /^[0-9a-f]{16,64}$/.test(querySeed),
    "The end block requires the frozen query seed");
  const delivered = stages.filter((stage) => (stage.files ?? []).length > 0)
    .sort((left, right) => left.ordinal - right.ordinal);
  const positionOf = new Map(delivered.map((stage, index) => [stage.ordinal, index]));

  // Order is drawn from the query seed and ids are assigned AFTER the shuffle, so an id
  // carries no information about which subject it names (gate 71's law).
  const subjects = seededShuffle(heldOut, `${querySeed}:adjacency:order`);
  const draws = seededSequence(`${querySeed}:adjacency:side`, subjects.length);
  return subjects.map((ordinal, index) => {
    const position = positionOf.get(ordinal);
    assertExperiment(position !== undefined, `Held-out stage ${ordinal} delivered no files`);
    // Ask for whichever neighbour exists; at an edge there is only one direction to ask.
    const wantsBefore = position === delivered.length - 1 ? true
      : position === 0 ? false
        : draws[index] % 2 === 0;
    const neighbour = delivered[position + (wantsBefore ? -1 : 1)];
    assertExperiment(neighbour !== undefined, `Held-out stage ${ordinal} has no neighbour to ask about`);
    return {
      id: `eb-${String(index + 1).padStart(2, "0")}`,
      schema: ARTIFACT_END_BLOCK_SCHEMA,
      relation: artifactSchemaRelation(ARTIFACT_END_BLOCK_SCHEMA).relation,
      rederivable: false,
      subjectStage: ordinal,
      anchor: delivered[position].files[0].path,
      side: wantsBefore ? "before" : "after",
      wanted: ADJACENCY_NAMES_WANTED,
      truth: neighbour.files.map((file) => file.path).sort(),
    };
  });
}

/**
 * Grade one adjacency answer as PRECISION over the files the model actually named.
 *
 * Every named file either belonged to the neighbouring pass or did not, so a model that
 * names two and gets both right scores 1.0 whether that pass held two files or nine. An
 * answer naming more than was asked for is truncated to the ask rather than rewarded for
 * volume, because listing a whole subsystem until something sticks is not recall. Naming
 * nothing is an abstention, not a zero: declining to guess is honest and the instrument
 * should be able to tell it apart from guessing wrong.
 */
export function gradeAdjacency({ question, named }) {
  assertExperiment(question && typeof question === "object",
    "Grading an adjacency answer requires its question");
  const answers = Array.isArray(named) ? named.map((value) => String(value).trim()).filter(Boolean) : [];
  if (answers.length === 0) return { id: question.id, outcome: "abstained", named: 0, correct: 0, precision: null };
  const considered = answers.slice(0, question.wanted ?? ADJACENCY_NAMES_WANTED);
  const truth = new Set(question.truth);
  const correct = considered.filter((path) => truth.has(path)).length;
  return {
    id: question.id,
    outcome: correct === considered.length ? "correct" : correct > 0 ? "partial" : "wrong",
    named: considered.length,
    correct,
    precision: correct / considered.length,
  };
}

export function staleArtifactsDigest(artifacts) {
  return createHash("sha256").update(JSON.stringify(artifacts), "utf8").digest("hex");
}

/**
 * Refuse any drift between a plan's recorded artifacts and what its own seeds
 * regenerate, and refuse a geometry that would measure re-injection instead of
 * recall. Gate 70's discipline, one instrument over.
 */
export function validateStaleArtifacts({ artifacts, stages, chains, contentSeed, querySeed, fieldCount }) {
  assertExperiment(Array.isArray(artifacts) && artifacts.length > 0,
    "A plan carrying stale artifacts must carry at least one ask");

  const regenerated = buildStaleArtifacts({
    stages, chains, contentSeed, querySeed, fieldCount,
    schemas: artifacts.map((ask) => ask.schema),
  });
  assertExperiment(staleArtifactsDigest(artifacts) === staleArtifactsDigest(regenerated),
    "Recorded stale artifacts do not match what the plan's own seeds regenerate");

  const seenSchemas = new Set();
  const seenStages = new Set();
  const seenPaths = new Set();
  for (const ask of artifacts) {
    assertExperiment(!seenSchemas.has(ask.schema),
      `Stale artifact schema ${ask.schema} is asked twice; the asks must rotate`);
    seenSchemas.add(ask.schema);
    assertExperiment(!seenPaths.has(ask.path),
      `Stale artifact path ${ask.path} is used twice`);
    seenPaths.add(ask.path);

    for (const ordinal of ask.window) {
      assertExperiment(!seenStages.has(ordinal),
        `Stage ${ordinal} is a subject of more than one stale artifact; the second would ` +
        "score the first's re-injection rather than recall");
      seenStages.add(ordinal);
      assertExperiment(ordinal < ask.askStage,
        `Stale artifact ${ask.id} asks about stage ${ordinal} at stage ${ask.askStage}, ` +
        "which the session has not reached");
    }

    for (const field of ask.fields) {
      assertExperiment(JSON.stringify(field.truth) !== JSON.stringify(field.stale),
        `Stale artifact ${ask.id} field ${field.key} is planted with its own truth, ` +
        "so leaving it alone would score as a correction");
      assertExperiment(field.rederivable === ask.rederivable,
        `Stale artifact ${ask.id} field ${field.key} disagrees with its schema about ` +
        "whether the answer can be re-derived from the checkout");
    }
  }

  // THE RELATION HOLD-OUT (Shane, 2026-08-25). Asking a type once teaches that the type
  // gets asked about, so an end block sharing a relation with any in-run ask scores the
  // habit that ask created rather than what the mechanism preserved.
  const endBlockRelation = artifactSchemaRelation(ARTIFACT_END_BLOCK_SCHEMA).relation;
  for (const ask of artifacts) {
    assertExperiment(ask.schema !== ARTIFACT_END_BLOCK_SCHEMA,
      `Stale artifact ${ask.id} asks the end block's own schema, so the end block would ` +
      "measure the priming this ask created");
    assertExperiment(ask.relation !== endBlockRelation,
      `Stale artifact ${ask.id} asks the end block's relation ${endBlockRelation}`);
  }
  // And no two asks share a relation either, for the same reason one layer down.
  const relations = artifacts.map((ask) => ask.relation);
  assertExperiment(new Set(relations).size === relations.length,
    "Two stale artifacts ask the same relation, so the second scores the first's priming");

  const { heldOut } = artifactWindows({
    eligible: stages.filter((stage) => (stage.files ?? []).length > 0).map((stage) => stage.ordinal),
    askCount: artifacts.length,
  });
  assertExperiment(heldOut.length > 0,
    "No stages are held out of the stale artifacts, so the end block has no uncontaminated subject");
  for (const ordinal of heldOut) {
    assertExperiment(!seenStages.has(ordinal),
      `Held-out stage ${ordinal} is also a stale-artifact subject`);
  }
  return { heldOut, subjectStages: [...seenStages].sort((left, right) => left - right) };
}

/**
 * Grade one returned artifact against its plan. Four outcomes per field, never two:
 * a value the model restored, one it left as planted, one it replaced with something
 * that is neither, and one it explicitly declined to vouch for.
 */
/**
 * Is this answer the model declining to vouch for a value?
 *
 * A schema whose values are LISTS or POSITIONS has no obvious place to write a marker, and
 * the first end-to-end run showed the cost: a manifest field could never be scored
 * abstained, so an honest "I do not remember this pass" landed in the confabulation
 * bucket beside a fabricated one. A single-element list holding only the marker counts,
 * and so does a marker the worklog parser lifted off a line, because those are the shapes
 * the marker can actually take in those files.
 */
export function isAbstention(value) {
  if (typeof value === "string") return value.trim().toLowerCase() === ARTIFACT_UNVERIFIED;
  if (Array.isArray(value) && value.length === 1) return isAbstention(value[0]);
  return false;
}

export function gradeStaleArtifact({ ask, returned }) {
  assertExperiment(ask && typeof ask === "object", "Grading a stale artifact requires its ask");
  const answers = returned && typeof returned === "object" ? returned : {};
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const rows = ask.fields.map((field) => {
    const answer = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    const outcome = answer === undefined ? "missing"
      : isAbstention(answer) ? "abstained"
        : same(answer, field.truth) ? "corrected"
          : same(answer, field.stale) ? "stale"
            : "confabulated";
    return { key: field.key, outcome, rederivable: field.rederivable };
  });
  const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
  return {
    id: ask.id,
    schema: ask.schema,
    rederivable: ask.rederivable,
    fields: rows.length,
    corrected: count("corrected"),
    stale: count("stale"),
    confabulated: count("confabulated"),
    abstained: count("abstained"),
    missing: count("missing"),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Rendering and read-back.
//
// The artifact has to look like a project note a person left behind, and it has to be
// machine-readable afterwards without asking the model to follow a format. So each schema
// renders as ordinary markdown a analyst would write, and the parser reads that same
// markdown back leniently: the model is editing prose with `edit`, not filling in a form,
// and a parser that only accepts its own byte-exact output would score formatting.
//
// LENIENT ON SHAPE, STRICT ON VALUE. Whitespace, list markers, backticks and heading depth
// are all forgiven. The VALUE is compared exactly, because a path that is almost right is
// wrong and softening that would flatter every near miss.
// ---------------------------------------------------------------------------

const ARTIFACT_TITLES = Object.freeze({
  manifest: "Review passes",
  worklog: "Worklog",
  extent: "File tally",
  crossref: "Cross-reference index",
});

const clean = (text) => text.replace(/`/g, "").trim();

export function renderStaleArtifact(ask) {
  assertExperiment(ask && typeof ask === "object", "Rendering requires an ask");
  const lines = [`# ${ARTIFACT_TITLES[ask.schema]}`, ""];
  if (ask.schema === "manifest") {
    for (const field of ask.fields) {
      lines.push(`## ${field.key}`, "");
      for (const path of field.stale) lines.push(`- ${path}`);
      lines.push("");
    }
  } else if (ask.schema === "worklog") {
    // Rendered in the PLANTED order, which is what makes it a reordering task: the entry
    // numbers are positions in this file, not identities, so moving a line changes its
    // answer and nothing else has to be edited.
    const ordered = [...ask.fields].sort((left, right) => left.stale - right.stale);
    for (const [index, field] of ordered.entries()) lines.push(`${index + 1}. ${field.key}`);
    lines.push("");
  } else if (ask.schema === "extent") {
    lines.push("| entry | files |", "| --- | --- |");
    for (const field of ask.fields) lines.push(`| ${field.key} | ${field.stale} |`);
    lines.push("");
  } else {
    for (const field of ask.fields) lines.push(`- ${field.key} -> ${field.stale}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Read a returned artifact back as key -> value, forgiving every formatting difference the
 * model might introduce and none of the value ones.
 *
 * A key the model deleted outright is simply absent, which grades as `missing` rather than
 * as a wrong answer: deleting a line is not the same claim as changing it.
 */
export function parseStaleArtifact({ schema, text }) {
  assertExperiment(typeof text === "string", "Parsing a stale artifact requires its text");
  const lines = text.split("\n");
  const answers = {};
  if (schema === "manifest") {
    let current = null;
    for (const line of lines) {
      const heading = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
      if (heading) {
        const label = clean(heading[1]);
        // The document title is not a pass; only a heading that names a key opens one.
        current = /^pass-\d+$/i.test(label) ? label.toLowerCase() : null;
        if (current) answers[current] = [];
        continue;
      }
      const item = line.match(/^\s*[-*+]\s+(.*\S)\s*$/);
      if (item && current) answers[current].push(clean(item[1]));
    }
    for (const key of Object.keys(answers)) answers[key] = answers[key].sort();
  } else if (schema === "worklog") {
    // The answer is the POSITION each entry now sits at, so the parse counts entries in
    // file order and ignores whatever numbers the model left on them: a model that
    // reorders the lines without renumbering has still answered.
    let position = 0;
    for (const line of lines) {
      const item = line.match(/^\s*(?:\d+[.)]|[-*+])\s+(.*\S)\s*$/);
      if (!item) continue;
      let label = clean(item[1]);
      if (!label) continue;
      position += 1;
      // A POSITION cannot carry a marker, so an entry the model could not place is marked
      // in the only place there is: an annotation on its own line. It still occupies a
      // position, because the model left it in the file.
      const marked = label.match(/^(.*?)[\s(\[]*\b(unverified)\b[)\]]*$/i);
      const abstained = marked !== null && marked[1].trim().length > 0;
      if (abstained) label = marked[1].trim().replace(/[\s\-–—:,(]+$/, "");
      if (!Object.hasOwn(answers, label)) answers[label] = abstained ? ARTIFACT_UNVERIFIED : position;
    }
  } else if (schema === "extent") {
    for (const line of lines) {
      const row = line.match(/^\s*\|(.+)\|(.+)\|\s*$/);
      if (!row) continue;
      const key = clean(row[1]);
      const value = clean(row[2]);
      if (!key || /^-+$/.test(value) || key === "entry") continue;
      answers[key] = /^\d+$/.test(value) ? Number(value) : value;
    }
  } else {
    for (const line of lines) {
      const item = line.match(/^\s*[-*+]\s+(.+?)\s*(?:->|→|=>)\s*(.*\S)\s*$/);
      if (!item) continue;
      answers[clean(item[1])] = clean(item[2]);
    }
  }
  return answers;
}

// ---------------------------------------------------------------------------
// The three runtime bounds, as functions the gate can drive for real.
//
// They live here rather than inside the extension's registration closure so a gate can
// exercise them against a real directory instead of matching source lines. The extension
// composes them; it does not reimplement them.
// ---------------------------------------------------------------------------

/**
 * DROP LATE and BACKDATE. The artifact does not exist in the checkout until the moment it
 * is asked about, and its mtime is matched to the checkout's own timestamps: every source
 * file in a fresh worktree carries checkout time, so a note carrying today's date reads as
 * freshly planted while one carrying the tree's reads as part of it. `stat` and `ls -l` are
 * natural analyst behaviour, and the model has `bash`.
 *
 * A missing reference file is a weaker disguise, never a dead run, so the backdate is
 * skipped rather than thrown.
 */
export function plantArtifact({ repoDir, ask, referencePath, backdateDays = 3 }) {
  assertExperiment(typeof repoDir === "string" && repoDir.length > 0, "Planting requires a checkout");
  assertExperiment(ask && typeof ask.path === "string" && typeof ask.text === "string",
    "Planting requires an ask carrying its path and text");
  const absolute = join(repoDir, ask.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, ask.text, "utf8");
  let backdatedTo = null;
  try {
    const reference = statSync(join(repoDir, referencePath));
    const stamp = new Date(reference.mtimeMs - 86_400_000 * backdateDays);
    utimesSync(absolute, stamp, stamp);
    backdatedTo = stamp.toISOString();
  } catch { backdatedTo = null; }
  return { path: ask.path, chars: ask.text.length, backdatedTo };
}

/**
 * CONSUME ON WRITE. Snapshot first, then truncate: the snapshot fixes what the model wrote
 * at this instant, which is what makes a later comparison unfakeable and is why
 * `ledger_record` is not needed to get that property. Truncating before reading would
 * destroy the measurement with the file.
 *
 * TRUNCATED, never unlinked, for gate 74's reason: an empty file is not a recovery channel
 * and is still a receipt, and a path that vanishes where a note used to be is its own tell.
 */
export function collectArtifact({ repoDir, ask }) {
  assertExperiment(typeof repoDir === "string" && repoDir.length > 0, "Collecting requires a checkout");
  assertExperiment(ask && typeof ask.path === "string", "Collecting requires an ask carrying its path");
  const absolute = join(repoDir, ask.path);
  let returned = null;
  let missing = true;
  try {
    returned = readFileSync(absolute, "utf8");
    missing = false;
  } catch { returned = null; }
  try { if (existsSync(absolute)) truncateSync(absolute, 0); } catch { /* already gone */ }
  return {
    path: ask.path,
    missing,
    returned,
    untouched: returned === ask.text,
    chars: returned === null ? 0 : returned.length,
  };
}
