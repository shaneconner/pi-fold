#!/usr/bin/env node
// The other half of the compaction-loss measurement: what pi-fold WOULD have done at the
// same boundaries, computed rather than run.
//
//   node scripts/analyze_fold_counterfactual.mjs <session.jsonl> [--limit N] [--json out]
//
// WHY THIS IS COMPUTABLE. Native's summary came out of a model call and cannot be
// recomputed. Folding is deterministic: same entries, same occupancy, same projection. So
// for a session that really compacted we can replay its own entries through the real fold
// runtime at the occupancy the real compaction fired at, and read off the projection it
// would have produced. No provider, no second run, and the arms see byte-identical input
// because it is literally the same file.
//
// THE HOST IS A SHIM, not a simulation of Pi. The runtime asks a host for four things: the
// branch, the occupancy, somewhere to append its own records, and a way to speak. Everything
// else it computes. tests/verify.mjs builds the same shim for the gate suite; this is the
// analysis-side copy, kept small on purpose, because the thing under test is the runtime and
// a large shim starts deciding the answer.
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_INSTALL_ROOT } from "./lib/pi_context_soak_attestation.mjs";
import { PI_FOLD_ACTIVE_CONTEXT_REGISTRATION } from "./lib/pi_fold_identity.mjs";
import {
  addLiterals, contextText, emptyLiterals, entryContextText, LITERAL_KINDS,
} from "./lib/transcript_literals.mjs";

const TOOL_NAME = PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.toolName;

const sessionPath = process.argv[2];
if (!sessionPath) {
  process.stderr.write("usage: analyze_fold_counterfactual.mjs <session.jsonl> [--limit N]\n");
  process.exit(2);
}
const arg = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const limit = Number(arg("--limit", "0")) || Infinity;
const jsonOut = arg("--json");
const budget = Number(arg("--budget", "251520"));
// THE LADDER RUN IS THE FLOOR, NOT THE DESIGN. Without this flag the runtime folds by age
// alone, because nothing marked anything: that is what pi-fold does when the agent ignores
// it entirely, and it is the honest lower bound to quote. The shipped path is agent-governed
// and the tool prefers ONE bulk call carrying several {ids, brief} pairs, so measuring only
// the unattended ladder measures the mechanism with its main input held at zero.
const retroMark = process.argv.includes("--retro-mark");
// The agent calls are the only expensive part of this instrument, and a metric added later
// should never be a reason to buy them again. Writing each boundary's projection out makes
// every later measurement an offline pass over what was already computed.
const saveProjections = arg("--save-projections");
// Retro-marking is one agent session per boundary and roughly ten dollars each, so a long
// session has to be sampled rather than covered. Every Nth boundary is asked and the rest
// run the ladder alone, in ONE pass over one runtime, so the sampled boundaries sit in a
// session that folded normally around them rather than in a session that was asked at every
// step. What is skipped is stated on the row, never left to be inferred from a missing field.
const retroEvery = Math.max(1, Number(arg("--retro-every", "1")) || 1);
// "Recoverable" is a claim about the mechanism, and left unchecked it is only a restatement
// of the architecture: of course nothing is lost, the design says so. This expands every
// standing fold once the last boundary is measured and reads the literals back out of the
// restored projection, which turns the claim into a number that can come out wrong.
const verifyRecoverable = process.argv.includes("--verify-recoverable");
// The widest slice the surface allows. A fold whose own span exceeds it comes back as head
// and tail with the middle stated as omitted, so what this measures is a FLOOR on recovery:
// the omitted middle is counted as unrecovered even though a narrower read would reach it.
// Folds nested inside are peeked separately, which is where most of a large fold's material
// actually lives.
const PEEK_VERIFY_BYTES = 200_000;
// THE CONTROL ARM. Retro-marking does not only add an agent: probing mid-span commits the
// epoch at points the boundary-only ladder never commits at, so "ladder at boundaries" and
// "agent asked mid-span" differ in two ways at once and the difference between them cannot
// be attributed to the agent. This runs the identical probe cadence and never calls a model,
// which isolates the ask as the only remaining difference.
const probeOnly = process.argv.includes("--probe-only");
// A DIAGNOSTIC, not a mode to report from. The boundary-only ladder commits through
// `session_before_compact`, which can spend the guard waiver and cut deep; the mid-span
// probe relies on the band-top commit, which deliberately takes a null waiver so it never
// spends the open turn. Those two paths shed very differently, and this fires the boundary
// commit at every probe so the difference can be attributed rather than guessed at.
const probeCommit = process.argv.includes("--probe-commit");
// How many messages may arrive between commit opportunities. A live session gets one after
// every response, so the default of 8 is a cost compromise and nothing more; if it changes
// the answer then it is an artifact of this harness rather than a property of the runtime,
// which is exactly what running it at 1 is for.
const probeStride = Math.max(1, Number(arg("--probe-stride", "8")) || 8);
const stopOnAbort = process.argv.includes("--stop-on-abort");
// The control suppresses the ask, so combining it with the ask is a contradiction rather
// than a combination. Passed together it silently produced a control arm and reported it as
// an agent run that cost nothing, which is a result that looks like a finding.
if (probeOnly && retroMark) {
  throw new Error("--probe-only is the no-agent control; pass one of --probe-only or --retro-mark");
}

const { createJiti } = await import(
  pathToFileURL(join(PI_INSTALL_ROOT, "node_modules", "jiti", "lib", "jiti.mjs")));
const jiti = createJiti(import.meta.url, {
  fsCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(PI_INSTALL_ROOT, "dist", "index.js"),
    "@earendil-works/pi-tui": join(PI_INSTALL_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: join(PI_INSTALL_ROOT, "node_modules", "typebox", "build", "index.mjs"),
  },
});
const project = new URL("..", import.meta.url).pathname;
const { registerActiveContext } = await jiti.import(join(project, "extensions", "active-context.ts"));
const { registerEvidenceIngestion } = await jiti.import(join(project, "extensions", "evidence.js"));

const settle = async (cycles = 4) => {
  for (let index = 0; index < cycles; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const textOf = entryContextText;
const messageText = contextText;

// `complete` is recorded rather than inferred, so a reader can never mistake a run the
// watchdog cut short for one that covered the whole session.
function writeReport(path, rows, session, complete, recovery = null) {
  const scored = rows.filter((row) => !row.error);
  const sum = (key) => scored.reduce((total, row) => total + (row[key] ?? 0), 0);
  writeFileSync(path, `${JSON.stringify({
    session, complete, boundaries: rows.length, ...(recovery ? { recovery } : {}), rows,
    overall: {
      spanPaths: sum("spanPaths"),
      nativeCarried: sum("nativeCarried"),
      foldVisible: sum("foldVisible"),
    },
  }, null, 2)}\n`);
}

function makeHost(branch, tokensOf) {
  const handlers = new Map();
  let aborts = 0;
  let sequence = 0;
  const appended = [];
  const notifications = [];
  // The tool is kept rather than dropped so retro-marking can hand a real model the REAL
  // surface: the runtime's own description, its own parameter schema, its own handler. A
  // schema written here to look like it would be measuring my transcription of the tool.
  const tools = new Map();
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    sendMessage() {},
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    async appendEntry(customType, data) {
      const entry = { type: customType, id: `cf-${String(++sequence).padStart(5, "0")}`,
        parentId: branch.at(-1)?.id ?? null, timestamp: new Date(0).toISOString(), ...data };
      appended.push(entry);
      branch.push(entry);
    },
  };
  const ctx = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    thinkingLevel: "xhigh",
    getContextUsage: () => ({ tokens: tokensOf(), contextWindow: 272_000 }),
    // A REFUSED REQUEST IS AN EVENT, not a no-op. When the projection will not fit, the
    // runtime aborts the request: the turn stops, and a real session recovers through the
    // rollback lane or a compaction boundary rather than sending more material into a window
    // that just refused it. Swallowing the abort let this harness keep feeding a refused
    // arm, which is why the probe arms carried on past the fence and produced projections
    // over budget that no real session would ever have been holding.
    abort() { aborts += 1; },
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {} },
    sessionManager: {
      getSessionId: () => "counterfactual",
      getSessionFile: () => "/dev/null",
      getBranch: () => branch,
      getEntries: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getEntry: (id) => branch.find((entry) => entry.id === id) ?? null,
      buildContextEntries: () => branch,
      buildSessionContext: () => ({
        messages: branch.filter((entry) => entry.type === "message").map((entry) => entry.message),
      }),
      appendLabelChange() { return null; },
      branch(targetId) { return targetId; },
      resetLeaf() {},
    },
  };
  return {
    pi, ctx, handlers, appended, notifications, tools,
    aborts: () => aborts,
  };
}

// ---------------------------------------------------------------- read the real session
const spans = [];
let current = [];
const compactions = [];
const reader = createInterface({
  input: createReadStream(sessionPath, { encoding: "utf8" }), crlfDelay: Infinity,
});
for await (const line of reader) {
  if (!line.trim()) continue;
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.type === "compaction") {
    compactions.push({ summary: String(entry.summary ?? ""), tokensBefore: entry.tokensBefore ?? null });
    spans.push(current);
    current = [];
    if (spans.length >= limit) break;
    continue;
  }
  if (entry.type !== "message") continue;
  current.push(entry);
}

// ---------------------------------------------------------------- retro-marking
// Shane's design: send an agent in place at each real boundary and let it cut the folds,
// seeing only the window it would have seen before the fold. NO FUTURE KNOWLEDGE is the
// whole discipline. The projection handed over stops at this boundary, so the agent cannot
// mark against what the session went on to need; an agent shown that would score this
// harness rather than the runtime.
let modelRuntime = null;
let model = null;
let convertToLlm = null;
if (retroMark) {
  const pi = await import(pathToFileURL(join(PI_INSTALL_ROOT, "dist", "index.js")));
  modelRuntime = await pi.ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  model = modelRuntime.getModel(arg("--provider", "openai-codex"), arg("--model", "gpt-5.6-sol"));
  if (!model) throw new Error("retro-marking could not resolve its model");
  // The projection is a PI transcript, not a provider one: fold placeholders and the steward
  // advisory ride as role "custom", which no provider understands. Pi converts them on the
  // way out (custom becomes a user turn carrying the same content) and this is that same
  // function, so the model sees the placeholders exactly as a live session would present
  // them rather than as something this script decided they should look like.
  convertToLlm = pi.convertToLlm;
}

const STEWARD_TYPE = `${PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix}-steward`;
const standingAdvisory = (projected) => (projected ?? []).some(
  (message) => message && typeof message === "object" && message.customType === STEWARD_TYPE);

// The tool result has to go back and the model has to get another turn. A single call
// measures nothing useful: the first thing a cold agent does with an unfamiliar surface is
// call status to see what is there, which is what the one-shot version recorded and then
// scored as "marked nothing". Bounded rounds, because an agent that keeps reading and never
// marks is itself a result and must not cost an unbounded number of calls to observe.
const RETRO_MAX_ROUNDS = 6;
// Every round re-sends the whole projection, so rounds are the cost. The first observed
// boundary spent $18.11 over eight rounds and staged twelve of its thirteen marks in the
// first four; the rest was status, an unmark and a re-fold. Two consecutive rounds that
// stage nothing new ends it. One barren round is allowed on purpose: checking your own work
// with status before continuing is legitimate, and cutting at the first is how a mid-course
// correction gets scored as an agent that stopped marking.
const RETRO_BARREN_LIMIT = 2;
// How often to give the runtime a commit opportunity while feeding a span in, and how full
// the window must be before it is worth the projection pass. Cost bounds on the search, not
// part of the mechanism.

const RETRO_PROBE_FLOOR = 0.65;

async function retroMarkAgent(projectionMessages, host, label) {
  const tool = host.tools.get(TOOL_NAME);
  if (!tool) return { error: "the runtime registered no fold tool" };
  // No systemPrompt and no instruction of mine. The invitation is already IN the projection:
  // the runtime appends the steward advisory itself, in its own words, at its own position,
  // stating the freeing target, what the marks cover and what the ladder takes otherwise.
  // A prompt of mine telling the model to fold would be measuring my prompt.
  const messages = convertToLlm(projectionMessages.map((message) => structuredClone(message)));
  const tools = [{ name: tool.name, description: tool.description, parameters: tool.parameters }];
  const rounds = [];
  let marks = 0;
  let markedIds = 0;
  let briefChars = 0;
  let refusals = 0;
  const briefs = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

  let barren = 0;
  for (let round = 0; round < RETRO_MAX_ROUNDS; round += 1) {
    const marksBefore = marks;
    let reply;
    try {
      // No output ceiling: the descriptor's own value travels. Project law, harness gate 52.
      reply = await modelRuntime.completeSimple(model, { messages, tools }, {
        thinkingLevel: "xhigh", maxRetries: 8,
      });
    } catch (error) {
      rounds.push({ error: String(error?.message ?? error).slice(0, 300) });
      break;
    }
    usage.input += reply?.usage?.input ?? 0;
    usage.output += reply?.usage?.output ?? 0;
    usage.cacheRead += reply?.usage?.cacheRead ?? 0;
    usage.cacheWrite += reply?.usage?.cacheWrite ?? 0;
    usage.cost += reply?.usage?.cost?.total ?? 0;
    if (reply?.stopReason === "error") {
      // A failed provider call comes back AS a message rather than as a throw, so without
      // this a dead call and a model that chose not to fold produce the same empty row.
      rounds.push({ error: String(reply.errorMessage ?? "provider error").slice(0, 300) });
      break;
    }
    const calls = (reply?.content ?? []).filter((part) => part?.type === "toolCall");
    const said = (reply?.content ?? []).filter((part) => part?.type === "text")
      .map((part) => part.text).join("\n");
    if (!calls.length) {
      rounds.push({ stopReason: reply?.stopReason ?? null, calls: 0, text: said.slice(0, 600) });
      break;
    }
    messages.push(reply);
    const actions = [];
    for (const call of calls) {
      const args = call.arguments ?? {};
      const staged = Array.isArray(args.marks) ? args.marks : (args.action === "fold" && args.ids ? [args] : []);
      for (const mark of staged) {
        marks += 1;
        markedIds += Array.isArray(mark.ids) ? mark.ids.length : 0;
        briefChars += typeof mark.brief === "string" ? mark.brief.length : 0;
        // The briefs ARE the product. Counting their characters and discarding their text
        // measures the agent's effort and never its judgement, and judgement is the whole
        // question: a deterministic brief is built from the span's own opening bytes, so
        // what an agent adds over that can only be read by reading what it wrote.
        briefs.push({ ids: mark.ids ?? [], brief: typeof mark.brief === "string" ? mark.brief : null });
      }
      let text;
      let ok = true;
      try {
        const out = await tool.execute(
          call.id, args, new AbortController().signal, () => {}, host.ctx);
        text = typeof out === "string" ? out : JSON.stringify(out ?? "");
      } catch (error) {
        // A refusal is a RESULT, not a crash: the surface refuses a span already inside a
        // fold, a brief that breaks its rules, an id that does not resolve. Which refusals a
        // cold agent walks into, and whether it corrects, is part of what this measures, and
        // the refusal goes back as the tool result exactly as it would in a live session.
        ok = false;
        refusals += 1;
        text = String(error?.message ?? error);
      }
      actions.push({ action: args.action ?? null, marks: staged.length, ok, text: text.slice(0, 300) });
      messages.push({
        role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: text.slice(0, 20_000) }],
        isError: !ok,
      });
    }
    rounds.push({ stopReason: reply?.stopReason ?? null, calls: calls.length,
      text: said.slice(0, 400), actions });
    barren = marks > marksBefore ? 0 : barren + 1;
    if (barren >= RETRO_BARREN_LIMIT) break;
  }
  return { label, rounds: rounds.length, marks, markedIds, briefChars, refusals, usage, briefs, detail: rounds };
}

// Gate 110: occupancy is anchored to the provider's OWN count on a measured response, so an
// assistant message carrying a usage figure is how any occupancy reaches the runtime at all.
// A live session gets one of these per turn for free; a replay has to supply them.
function measurementMessage(tokens) {
  return {
    role: "assistant", stopReason: "stop",
    content: [{ type: "text", text: "measurement" }],
    provider: "openai-codex", model: "gpt-5.6-sol",
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
    timestamp: tokens, contextWindow: 272_000,
  };
}

// CHARACTERS PER TOKEN IS READ FROM THE SESSION, not assumed.
//
// A flat chars/4 under-reads a coding transcript badly: code, JSON and paths tokenize nearer
// three characters per token, and on the 2026-07-27 18-boundary session the estimate came in
// 19% to 63% below what the provider actually counted, averaging about 40%. That is not a
// rounding error in a report, it is an input to the mechanism: occupancy is what the runtime
// folds against, so telling it the window holds 260,000 tokens when the provider says
// 371,588 makes folding fire late and shed too little, and the arm then runs over budget for
// reasons that have nothing to do with folding.
//
// The first boundary is the one place the fold arm provably holds exactly what native held,
// because nothing has been folded or compacted yet, so that compaction record calibrates the
// whole session for free. Later boundaries cannot be used the same way: by then native holds
// a summary where this arm holds a projection, and the two are no longer the same context.
const firstSpanChars = spans[0]?.reduce((total, entry) => total + textOf(entry).length, 0) ?? 0;
const measuredFirst = compactions[0]?.tokensBefore ?? null;
const charsPerToken = measuredFirst && firstSpanChars ? firstSpanChars / measuredFirst : 4;
const estimateTokens = (chars) => Math.ceil(chars / charsPerToken);
process.stdout.write(`chars per token: ${charsPerToken.toFixed(2)}` +
  `${measuredFirst ? ` (calibrated on the first boundary's ${measuredFirst} provider tokens)`
    : " (uncalibrated: this session reports no measured occupancy)"}\n`);

// ONE RUNTIME, ONE BRANCH, CARRIED. The first version of this built a fresh runtime per
// boundary over the raw accumulated history, which is a workload native never faced: native
// compacted at every boundary, so its context never exceeded its own trigger, while the fold
// arm was handed 2.3M tokens in one commit by boundary three. It then "kept" almost every
// path because it had barely shed anything, which flatters folding on carriage and buries it
// on compression for the same reason. Each arm has to compound its OWN reduction.
const rows = [];
let foldsSoFar = 0;
const working = [];
let occupancy = budget;
let inputChars = 0;
// Kept out of the rows on purpose: one boundary contributes tens of thousands of distinct
// identifiers, and writing them per row would make the report larger than the transcript.
const allSpanLiterals = emptyLiterals();
const host = makeHost(working, () => occupancy);
registerEvidenceIngestion(host.pi);
registerActiveContext(host.pi, { providerInputBudget: budget });
await host.handlers.get("session_start")?.({}, host.ctx);
const messages = [];

for (let index = 0; index < spans.length; index += 1) {
  let retroProbes = 0;
  let retro = null;
  // OCCUPANCY IS ANCHORED TO THE LAST MEASURED PROJECTION, and re-anchored every time one is
  // measured. Estimating it as "the projection at the previous BOUNDARY plus everything fed
  // since" is right when nothing commits in between and catastrophically wrong when
  // something does: a mid-span commit sheds real bytes and the estimate keeps climbing as if
  // it had not, so the runtime gets told it is over budget while folding is working. At
  // boundary 3 that drove occupancy past the serving budget and the fence aborted 94
  // requests, which read as folding getting worse the more often it commits. It was the
  // measurement refusing to notice that folding had happened.
  let baseline = rows.at(-1)?.projectionTokens ?? 0;
  let sinceBaseline = 0;
  const noticesBefore = host.notifications.length;
  const abortsBefore = host.aborts();
  const appendedBefore = host.appended.length;
  const probeLog = [];
  for (const [position, entry] of spans[index].entries()) {
    working.push(structuredClone(entry));
    const message = structuredClone(entry.message);
    messages.push(message);
    inputChars += messageText(message).length + 1;
    sinceBaseline += messageText(message).length + 1;
    // DRIVING AND ASKING ARE DIFFERENT BUDGETS. The first version capped both at twelve and
    // stopped driving entirely once an ask had happened, so at a boundary whose span is 2.3M
    // characters the runtime got twelve commit opportunities and then nothing: the remaining
    // messages piled up raw, occupancy passed the serving budget, and the fence aborted 26
    // requests while the projection ran to 492,628 tokens against a 374,103 budget. That
    // looked like folding getting worse the more often it commits, and it was the harness
    // withholding the commits. A live session gets an opportunity after every response, so
    // driving is uncapped; only the agent call, which is the only part that costs money, is
    // bounded, and it is bounded at one per boundary by `retro` alone.
    if (!(retroMark || probeOnly || probeCommit)) continue;
    // A REFUSED REQUEST MUST NOT SWITCH FOLDING OFF FOR THE REST OF THE SPAN. This used to
    // `continue` unconditionally once the arm had been refused, on the reasoning that a real
    // session stops rather than sending more into a window that just refused it. The effect
    // was far larger than intended: one mid-span abort ended every further commit
    // opportunity, so a 156-message span folded once at message 24 and then accumulated 130
    // messages raw. That, and not cadence, produced the "committing less often sheds more"
    // effect I chased for two hours, because stride only decided which single moment the one
    // surviving probe caught. A real session recovers, through the rollback lane or a
    // compaction boundary, so the abort is recorded and folding continues.
    if (stopOnAbort && host.aborts() > abortsBefore) continue;
    // THE AGENT HAS TO BE ASKED WHILE MARKING STILL CHANGES ANYTHING. The first version asked
    // at the boundary, after the drive sequence had already run, and by then the band-top
    // commit had fired on the opening projection pass and the ladder had taken all eighteen
    // folds: the agent was handed a window with nothing left to mark and answered by calling
    // status. That is exactly the mechanical failure the steward band was moved to fix, so
    // reproducing it here would measure the harness. Feed the span in, and ask at the first
    // moment the runtime is actually standing its advisory.
    const running = baseline + estimateTokens(sinceBaseline);
    // A deliberately low PRE-FILTER, not a copy of the band rule: it only decides when a
    // probe is worth its cost. Whether the band is open is read off the projection itself,
    // by the presence of the runtime's own steward message, so the rule stays in one place.
    if (running < RETRO_PROBE_FLOOR * budget) continue;
    if (position % probeStride !== 0 && position !== spans[index].length - 1) continue;
    retroProbes += 1;
    const alreadyAsked = retro !== null;
    // THE PROVIDER COUNTS WHAT IT WAS SENT. The runtime builds a projection, that projection
    // goes on the wire, and the count that comes back describes it. Anchoring gate 110's
    // measurement to the PRE-commit estimate instead tells the runtime the request was as
    // large as the window was before folding ran, so a commit that just freed 80,000 tokens
    // is reported as having freed nothing and the next pass folds against a number that
    // never existed. The estimate is only used to decide whether this pass is worth taking.
    occupancy = running;
    const projectedNow = await host.handlers.get("context")({ messages }, host.ctx);
    await settle();
    let probeChars = 0;
    for (const message of projectedNow?.messages ?? []) probeChars += messageText(message).length + 1;
    const sent = estimateTokens(probeChars);
    occupancy = sent;
    const carrier = measurementMessage(sent);
    working.push({ type: "message", id: `cf-probe-${index}-${position}`,
      parentId: working.at(-1)?.id ?? null, message: carrier });
    messages.push(carrier);
    inputChars += messageText(carrier).length + 1;
    await host.handlers.get("message_end")?.({ message: carrier }, host.ctx);
    await settle();
    if (probeCommit) {
      // WHERE the commits land, not just how many. Two arms can make the same number of
      // commits, fold the same mass, and end a boundary half a projection apart, which means
      // the interesting variable is which moment each commit caught. Recorded per probe so
      // that is readable instead of inferred.
      const foldsBefore = host.appended.filter((entry) => entry?.kind === "context.fold").length;
      await host.handlers.get("session_before_compact")?.({
        reason: "threshold", willRetry: false, branchEntries: working, preparation: {}, signal: undefined,
      }, host.ctx);
      await settle();
      const after = await host.handlers.get("context")({ messages }, host.ctx);
      let afterChars = 0;
      for (const message of after?.messages ?? []) afterChars += messageText(message).length + 1;
      const foldsAfter = host.appended.filter((entry) => entry?.kind === "context.fold").length;
      probeLog.push({
        position,
        of: spans[index].length,
        before: sent,
        after: estimateTokens(afterChars),
        folds: foldsAfter - foldsBefore,
      });
      baseline = estimateTokens(afterChars);
      occupancy = baseline;
      sinceBaseline = 0;
      continue;
    }
    baseline = sent;
    sinceBaseline = 0;
    if (alreadyAsked || index % retroEvery !== 0) continue;
    if (!standingAdvisory(projectedNow?.messages)) continue;
    if (probeOnly) {
      // The band opened and nobody was asked. Recorded so this arm is never mistaken for one
      // where the band never opened at all, which is a different thing entirely.
      retro = { asked: false, reason: "probe-only control", askedAtTokens: sent,
        askedAtMessage: position, probes: retroProbes };
      continue;
    }
    retro = await retroMarkAgent(projectedNow.messages, host, `boundary-${index + 1}@${position}`);
    retro.askedAtTokens = sent;
    retro.askedAtMessage = position;
    retro.probes = retroProbes;
    await settle();
  }
  const compaction = compactions[index];
  // OCCUPANCY IS THE FOLD ARM'S OWN, not native's. Native's `tokensBefore` describes a
  // context that had already discarded every earlier span, so feeding it here tells the
  // runtime it holds 250k while it is actually handed everything since the session began.
  // It then sizes its freeing target against the wrong number and sheds far too little.
  // What the provider would report to a folding session is the size of what that session
  // actually sent: its own last projection, plus the span that arrived after it.
  const tokens = baseline + estimateTokens(sinceBaseline);
  occupancy = tokens;

  // ALL THREE CLASSES, not paths alone. A path is the class a summary carries best, so
  // scoring the fold arm on paths is the reading most favourable to native: on this same
  // session native carried 5.2% of paths, 0.1% of identifiers and 0.2% of numbers. The
  // identifiers and numbers are the transcript-only facts, the ones a value computed in a
  // tool result and never written to a file falls into, and they are the whole reason the
  // difference between a summary and a lossless fold matters at all.
  const spanLiterals = emptyLiterals();
  for (const entry of spans[index]) addLiterals(spanLiterals, textOf(entry));
  for (const kind of LITERAL_KINDS) for (const value of spanLiterals[kind]) allSpanLiterals[kind].add(value);
  const summaryLiterals = addLiterals(emptyLiterals(), compaction.summary);
  const spanPaths = spanLiterals.path;
  const summaryPaths = summaryLiterals.path;

  let projected;
  try {
    await host.handlers.get("context")({ messages }, host.ctx);
    await settle();
    const measured = measurementMessage(tokens);
    working.push({ type: "message", id: `cf-measure-${index}`,
      parentId: working.at(-1)?.id ?? null, message: measured });
    messages.push(measured);
    inputChars += messageText(measured).length + 1;
    await host.handlers.get("message_end")?.({ message: measured }, host.ctx);
    await settle();
    await host.handlers.get("session_before_compact")?.({
      reason: "threshold", willRetry: false, branchEntries: working, preparation: {}, signal: undefined,
    }, host.ctx);
    await settle();
    projected = await host.handlers.get("context")({ messages }, host.ctx);
  } catch (error) {
    rows.push({ boundary: index + 1, error: String(error?.message ?? error).slice(0, 200) });
    continue;
  }
  const out = projected?.messages ?? messages;
  // Measured message by message rather than by joining the projection into one string.
  // At boundary three that string was over nine megabytes, rebuilt per boundary purely so a
  // regex could run over it, which is measurement overhead charged to the thing being
  // measured. Same numbers, no giant allocation.
  const visibleLiterals = emptyLiterals();
  let projectionChars = 0;
  // WHAT THE PROJECTION IS MADE OF. A projection that will not shrink is either full of raw
  // material folding was not allowed to touch, or full of placeholder text left behind by
  // the folding that already happened. Those are opposite problems with opposite fixes, and
  // a single token count cannot tell them apart.
  const composition = new Map();
  for (const message of out) {
    const text = messageText(message);
    projectionChars += text.length + 1;
    addLiterals(visibleLiterals, text);
    const kind = message?.role === "custom"
      ? String(message.customType ?? "custom").replace(`${PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix}-`, "")
      : String(message?.role ?? "unknown");
    composition.set(kind, (composition.get(kind) ?? 0) + text.length + 1);
  }
  const visible = visibleLiterals.path;
  const classes = Object.fromEntries(LITERAL_KINDS.map((kind) => {
    const span = [...spanLiterals[kind]];
    const carried = span.filter((value) => summaryLiterals[kind].has(value)).length;
    const shown = span.filter((value) => visibleLiterals[kind].has(value)).length;
    return [kind, {
      distinct: span.length,
      nativeCarried: carried,
      foldVisible: shown,
      // Folding is lossless: what the projection no longer shows is inside a fold and one
      // peek away, whereas what the summary no longer states is not in the session at all.
      // Stated as counts rather than left to be inferred from the difference.
      foldRecoverable: span.length - shown,
      nativeAbsent: span.length - carried,
    }];
  }));

  const nativeCarried = [...spanPaths].filter((value) => summaryPaths.has(value)).length;
  const foldVisible = [...spanPaths].filter((value) => visible.has(value)).length;
  rows.push({
    boundary: index + 1,
    tokensBefore: tokens,
    spanEntries: spans[index].length,
    spanChars: spans[index].reduce((total, entry) => total + textOf(entry).length, 0),
    spanPaths: spanPaths.size,
    nativeCarried,
    nativeRate: spanPaths.size ? nativeCarried / spanPaths.size : null,
    foldVisible,
    foldRate: spanPaths.size ? foldVisible / spanPaths.size : null,
    projectionMessages: out.length,
    composition: Object.fromEntries([...composition].sort((a, b) => b[1] - a[1])),
    inputMessages: messages.length,
    projectionChars,
    // A carriage rate means nothing without the compression that bought it. Native replaces
    // the whole pre-cut span with one summary; folding sheds only enough to meet its target.
    // If folding keeps more because it shed LESS, that is not a win, and putting both
    // projections on one scale is the only way to see it.
    projectionTokens: estimateTokens(projectionChars),
    inputTokens: estimateTokens(inputChars),
    nativeAfterTokens: estimateTokens(compaction.summary.length),
    // HOW MUCH EACH COMMIT ACTUALLY TOOK. A fold count says how many times folding fired and
    // nothing about whether it accomplished anything: an arm that commits constantly and
    // folds a few hundred characters each time looks busier than one that commits rarely and
    // takes the window down by a third. Fresh-tail is a hold class, so material that has just
    // arrived cannot be folded at all, and the question is whether a short cadence keeps
    // meeting a window whose bulk is ineligible. Grouped by commit so the per-commit depth is
    // readable rather than inferred.
    foldWork: (() => {
      // The sizes ride on the `context.fold` EVENT, not on the durable fold record: the
      // record is what persistence needs to rebuild a fold, the event is what the ledger
      // needs to explain one. Reading the record for source_chars silently returned zero.
      const fresh = host.appended.slice(appendedBefore)
        .filter((entry) => entry?.kind === "context.fold");
      const commits = new Set();
      let sourceChars = 0;
      let placeholderChars = 0;
      for (const entry of fresh) {
        if (entry.commit_seq !== undefined) commits.add(entry.commit_seq);
        sourceChars += Number(entry.source_chars ?? 0);
        placeholderChars += Number(entry.placeholder_chars ?? 0);
      }
      return {
        commits: commits.size,
        folds: fresh.length,
        sourceChars,
        placeholderChars,
        charsPerCommit: commits.size ? Math.round(sourceChars / commits.size) : 0,
        charsPerFold: fresh.length ? Math.round(sourceChars / fresh.length) : 0,
      };
    })(),
    probeLog,
    // A DELTA, not a running total: one host now spans every boundary, so the cumulative
    // count would silently report the whole session's folds at each row.
    foldRecords: (() => {
      const total = host.appended.filter((entry) =>
        typeof entry.type === "string" && entry.type.includes("fold-record")).length;
      const delta = total - foldsSoFar;
      foldsSoFar = total;
      return delta;
    })(),
    classes,
    // Every announcement the runtime made during this boundary, so a session whose folding
    // suspended is never reported as one that simply folded less.
    suspends: host.appended.filter((entry) => typeof entry.type === "string"
      && entry.type.includes("suspend")).length,
    aborts: host.aborts() - abortsBefore,
    notices: host.notifications.slice(noticesBefore).map((note) =>
      `${note.level}: ${String(note.message).slice(0, 300)}`),
    ...(retroMark || probeOnly
      ? { retro: retro ?? (index % retroEvery === 0
        ? { asked: false, reason: "the steward band never opened during this span", probes: retroProbes }
        : { asked: false, reason: `not sampled (--retro-every ${retroEvery})`, probes: 0 }) }
      : {}),
  });
  // WRITTEN AFTER EVERY BOUNDARY, not at the end. A sweep over a large session runs for
  // hours, and the first version wrote its json only on completion, so the watchdog that
  // killed it at ninety minutes destroyed every boundary it had already computed. Partial
  // results are worth keeping; a run that dies at boundary twelve should leave twelve rows.
  if (saveProjections) {
    mkdirSync(saveProjections, { recursive: true });
    writeFileSync(join(saveProjections, `boundary-${String(index + 1).padStart(3, "0")}.json`),
      `${JSON.stringify({
        session: sessionPath, boundary: index + 1, budget, retroMark,
        occupancyTokens: tokens, projectionChars,
        nativeSummary: compaction.summary, projection: out,
      })}\n`);
  }
  if (jsonOut) writeReport(jsonOut, rows, sessionPath, false);
  process.stdout.write(`boundary ${index + 1}/${spans.length} done ` +
    `(fold ${rows.at(-1)?.projectionTokens ?? "?"} tok, native ${rows.at(-1)?.nativeAfterTokens ?? "?"} tok)\n`);
}

// Run AFTER every boundary is measured, never between them: expanding is a real mutation of
// the projection, and doing it mid-run would hand the next boundary a window the arm would
// never have been holding.
let recovery = null;
if (verifyRecoverable) {
  // PEEK, NOT EXPAND. The first version expanded every fold at the end of the run and the
  // runtime refused all 42 of them, correctly: expand puts source back INTO the window and
  // 2.3M tokens of it does not fit in a 374k budget. That refusal is the projection fence
  // doing its job, and reading it as a recovery failure had the finding exactly backwards.
  // Recoverability means reachable one fold at a time, which is what peek is: bounded,
  // ephemeral, changes nothing, and it is the path an agent actually uses to answer from
  // folded material. Recovery is measured the way it would really be paid for.
  // The window an agent would be peeking FROM is the one the last commit left, not the
  // pre-commit state the boundary was measured at. Setting the host's own usage is not
  // enough: gate 110 anchors occupancy to the provider's count on a measured response, so
  // the fence was still reading the raw span the arm had just been handed, seeing 1.4M
  // tokens over budget and refusing every read. That says nothing about recoverability. One
  // measured response carrying the post-commit size is what a real session gets for free on
  // its very next request, and it is what the fence has to see before a peek means anything.
  const settled = rows.at(-1)?.projectionTokens ?? occupancy;
  occupancy = settled;
  const settleCarrier = measurementMessage(settled);
  working.push({ type: "message", id: "cf-verify-measure",
    parentId: working.at(-1)?.id ?? null, message: settleCarrier });
  messages.push(settleCarrier);
  await host.handlers.get("message_end")?.({ message: settleCarrier }, host.ctx);
  await settle();
  const tool = host.tools.get(TOOL_NAME);
  const back = emptyLiterals();
  const finalVisible = emptyLiterals();
  for (const message of (await host.handlers.get("context")({ messages }, host.ctx))?.messages ?? []) {
    addLiterals(finalVisible, messageText(message));
  }
  const seen = new Set();
  const failures = [];
  let peeked = 0;
  let peekChars = 0;
  let truncated = 0;
  const resultText = (out) => {
    const raw = typeof out === "string" ? out : JSON.stringify(out ?? "");
    try {
      const parsed = JSON.parse(raw);
      const parts = parsed?.content;
      if (Array.isArray(parts)) return parts.map((part) => part?.text ?? "").join("\n");
    } catch { /* a plain string result is already the text */ }
    return raw;
  };
  const FOLD_ID = /fold_[0-9a-f]{8,}/g;
  const queue = [];
  try {
    const status = await tool.execute("verify-status", { action: "status", detail: "folds" },
      new AbortController().signal, () => {}, host.ctx);
    for (const id of resultText(status).match(FOLD_ID) ?? []) if (!seen.has(id)) queue.push(id);
    // Breadth first over the whole forest: peeking serves ONE level, so a fold nested inside
    // the one just read is reachable only by peeking it in turn. Stopping at the roots would
    // count a parent's brief as recovery of its children's source.
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const out = await tool.execute(`verify-peek-${peeked}`,
          { action: "peek", id, bytes: PEEK_VERIFY_BYTES, ephemeral: true },
          new AbortController().signal, () => {}, host.ctx);
        peeked += 1;
        const text = resultText(out);
        peekChars += text.length;
        if (text.includes("omitted")) truncated += 1;
        addLiterals(back, text);
        for (const child of text.match(FOLD_ID) ?? []) if (!seen.has(child)) queue.push(child);
      } catch (error) {
        failures.push({ id, error: String(error?.message ?? error).slice(0, 200) });
      }
    }
    recovery = {
      method: "peek", folds: seen.size, peeked, failures: failures.slice(0, 20),
      failureCount: failures.length, peekChars, truncated,
      sourceChars: rows.reduce((total, row) => total + (row.spanChars ?? 0), 0),
      classes: Object.fromEntries(LITERAL_KINDS.map((kind) => {
        const all = [...allSpanLiterals[kind]];
        // Reachable means visible in the window OR returned by a peek. Counting peeks alone
        // would score a fact the agent can simply read as unrecovered.
        const byPeek = all.filter((value) => back[kind].has(value)).length;
        const reachable = all.filter((value) => back[kind].has(value) || finalVisible[kind].has(value)).length;
        return [kind, { distinct: all.length, byPeek, reachable, missing: all.length - reachable }];
      })),
    };
  } catch (error) {
    recovery = { method: "peek", error: String(error?.message ?? error).slice(0, 300), peeked };
  }
}

if (jsonOut) writeReport(jsonOut, rows, sessionPath, true, recovery);

process.stdout.write(
  "\nbnd  spanPaths   nativeKept    foldVisible  folds     inTok   foldTok    natTok\n");
for (const row of rows) {
  if (row.error) { process.stdout.write(`${String(row.boundary).padStart(3)}  ERROR ${row.error}\n`); continue; }
  process.stdout.write(`${String(row.boundary).padStart(3)}${String(row.spanPaths).padStart(11)}` +
    `${(`${row.nativeCarried} (${(100 * row.nativeRate).toFixed(0)}%)`).padStart(13)}` +
    `${(`${row.foldVisible} (${(100 * row.foldRate).toFixed(0)}%)`).padStart(15)}` +
    `${String(row.foldRecords).padStart(7)}${String(row.inputTokens).padStart(10)}` +
    `${String(row.projectionTokens).padStart(10)}${String(row.nativeAfterTokens).padStart(10)}\n`);
}

// The path row alone is the reading most favourable to native, so the classes it carries
// worst are printed beside it rather than left in the json for someone to go and find.
const scored = rows.filter((row) => !row.error && row.classes);
if (scored.length) {
  process.stdout.write("\nclass        distinct   native kept   fold visible  fold recoverable\n");
  for (const kind of LITERAL_KINDS) {
    const total = (key) => scored.reduce((sum, row) => sum + row.classes[kind][key], 0);
    const distinct = total("distinct");
    const pct = (value) => (distinct ? `${(100 * value / distinct).toFixed(1)}%` : "n/a");
    process.stdout.write(`${kind.padEnd(12)}${String(distinct).padStart(9)}` +
      `${`${total("nativeCarried")} (${pct(total("nativeCarried"))})`.padStart(14)}` +
      `${`${total("foldVisible")} (${pct(total("foldVisible"))})`.padStart(15)}` +
      `${`${total("foldRecoverable")} (${pct(total("foldRecoverable"))})`.padStart(18)}\n`);
  }
}
if (recovery) {
  if (recovery.error) process.stdout.write(`\nrecoverability check FAILED: ${recovery.error}\n`);
  else {
    process.stdout.write(`\nrecoverability by peek: ${recovery.peeked} of ${recovery.folds} ` +
      `fold(s) read, ${recovery.failureCount} refusal(s), ${recovery.truncated} truncated; ` +
      `${recovery.peekChars} chars returned against ${recovery.sourceChars} of span source\n`);
    for (const kind of LITERAL_KINDS) {
      const row = recovery.classes[kind];
      const pct = row.distinct ? `${(100 * row.reachable / row.distinct).toFixed(1)}%` : "n/a";
      process.stdout.write(`${kind.padEnd(12)}${String(row.distinct).padStart(9)} distinct  ` +
        `${String(row.byPeek).padStart(7)} by peek  ${String(row.reachable).padStart(7)} reachable (${pct})  ` +
        `${row.missing} MISSING\n`);
    }
  }
}
