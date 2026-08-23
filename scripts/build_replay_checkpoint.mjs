#!/usr/bin/env node
// Writes a Pi session FILE from the sol corpus, with anchors planted at known depths, so a
// later run can resume it. This is the "prior state of the world" half of the instrument.
//
//   node scripts/build_replay_checkpoint.mjs --out <dir> [--anchors 6] [--tokens 900000]
//
// THE FILE IS WRITTEN THROUGH SessionManager, never hand-assembled. The format has a header,
// parent links and ids, and a transcript this project hand-rolled would be a second
// implementation of Pi's serializer that drifts from it silently. Appending to a persisted
// manager is exactly what Pi does; what does NOT work is appending to a LIVE session and
// expecting the next prompt to carry it, which is the defect that invalidated the first
// replay build.
//
// ANCHORS ARE ORDINARY. Each is one user sentence stating a value plus the reply a person
// would have gotten, in the voice of the surrounding work. Nothing marks them, nothing asks
// the model to hold them, and the values are `lv-` tokens generated from a frozen seed and
// asserted absent from the replayed text, so an anchor is answerable only from the record.
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_INSTALL_ROOT } from "./lib/pi_context_soak_attestation.mjs";
import { assertExperiment } from "./lib/pi_context_experiment.mjs";
import { loadTrajectories, toPiMessage, replayTokens } from "./lib/replay_corpus.mjs";
import {
  REPLAY_PROTOCOL, buildReplayFacts, factStatement, factAcknowledgement,
  assertNoCorpusCollision,
} from "./lib/replay_session.mjs";

const { SessionManager } = await import(pathToFileURL(join(PI_INSTALL_ROOT, "dist", "index.js")));

const argumentValue = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const outDir = resolve(argumentValue("--out") ?? "lab/checkpoint");
const anchors = Number(argumentValue("--anchors", "6"));
const targetTokens = Number(argumentValue("--tokens", "900000"));
const corpusPath = resolve(argumentValue("--corpus", "lab/corpus/traces.jsonl"));
const contentSeed = argumentValue("--content-seed", "9f4b2c7e15a03d68");

const sessionDir = join(outDir, "session");
const workDir = join(outDir, "work");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const facts = buildReplayFacts({ contentSeed, segments: anchors });
const { trajectories } = await loadTrajectories(corpusPath, { minMessages: 6 });
assertExperiment(trajectories.length > 0, "Checkpoint corpus produced no trajectories");

// Anchors sit at even depths through the transcript, the first early enough to be many
// boundaries old at question time and the last still well before the end.
const spend = targetTokens / (anchors + 1);
const manager = SessionManager.create(workDir, sessionDir);

let planted = 0;
let tokens = 0;
let used = 0;
const placements = [];
const chosen = [];
while (planted < anchors && used < trajectories.length) {
  const trajectory = trajectories[used];
  used += 1;
  if (trajectory.chars > spend * 4) continue;
  for (const message of trajectory.messages) manager.appendMessage(toPiMessage(message));
  chosen.push(trajectory);
  tokens += replayTokens(trajectory.chars);
  if (tokens >= spend * (planted + 1)) {
    const fact = facts[planted];
    manager.appendMessage({ role: "user", content: [{ type: "text", text: factStatement(fact) }] });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: factAcknowledgement(fact) }] });
    placements.push({ ...fact, atToken: tokens, atEntry: manager.getEntries().length });
    planted += 1;
  }
}
assertExperiment(planted === anchors,
  `Only ${planted} of ${anchors} anchors placed; corpus exhausted at ${tokens} tokens`);

assertNoCorpusCollision(facts, chosen
  .flatMap((item) => item.messages)
  .map((message) => (typeof message.content === "string" ? message.content : ""))
  .join("\n"));

const sessionFile = manager.getSessionFile();
assertExperiment(typeof sessionFile === "string" && sessionFile.length > 0,
  "The checkpoint manager persisted no session file");

// The answer key lives OUTSIDE the checkpoint, next to it rather than in it, because the
// checkpoint is what a run is handed and a key inside it is an answer sheet.
const manifest = {
  protocol: REPLAY_PROTOCOL, contentSeed, anchors,
  sessionFile, workDir,
  entries: manager.getEntries().length,
  tokens,
  trajectories: chosen.length,
  placements,
};
writeFileSync(`${outDir}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  sessionFile, bytes: statSync(sessionFile).size, entries: manifest.entries,
  tokens, trajectories: chosen.length,
  anchorDepths: placements.map((item) => item.atToken),
}, null, 2)}\n`);
