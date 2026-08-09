# pi-fold

Agent-governed lossless context folding for Pi. A session folds its own transcript instead of losing it: the stale end collapses into short briefs while the exact originals stay on disk, addressed and verified by SHA-256, one tool call away.

The full write-up, with interactive versions of every mechanism on this page and the complete measurement story, is at [shaneconner.com/projects/pi-fold](https://shaneconner.com/projects/pi-fold/).

![pi-fold folding a session in place: the agent marks spans as it works, the marks commit together at a fold event, and a mark inside the protected fresh tail is held until it ages out](https://raw.githubusercontent.com/shaneconner/pi-fold/main/media/fold-demo.gif)

*The mechanism, drawn. One session runs as the transcript it is, user messages in cream, the agent's replies in green, tool results a quieter shade of the same green. The agent calls `pi_fold_context mark` on spans it has finished with: each mark outlines the span it names and moves nothing, and the next fold event commits every standing mark in one rewrite, two outlined spans collapsing to two briefs at once while the ladder takes the unmarked stale end on its own. A dotted rule rides over the newest turns, the protected fresh tail: a mark that lands inside it is held at the fold event, so nothing folds out from under the turn still using it, and it commits a few turns later once it has aged out. The exact messages stay on disk, addressed and verified by SHA-256, and expanding a brief brings them back byte for byte. Illustrative animation, not a screen capture; the measured numbers are further down. A 6 MB mp4 of the same clip is at [media/fold-demo.mp4](https://github.com/shaneconner/pi-fold/blob/main/media/fold-demo.mp4).*

## Install

```sh
pi install npm:pi-fold
```

Node 22 or later, Pi 0.83 or later. Licensed under [MIT](./LICENSE).

## What it is

pi-fold registers one tool, `active_context`, and gives the session's own agent nine actions over its transcript: `status`, `peek`, `fold`, `expand`, `refold`, `protect`, `unprotect`, `rebrief`, and `reboundary`, plus `unmark` under epoch scheduling. It also registers `/context` and `/fold-context` for the human.

A fold takes a contiguous span of session entries and replaces it, in the window only, with a short brief. The entries themselves go to a fold store, byte for byte, addressed by their SHA-256 hash. The brief carries a handle, the handle resolves to the original, and expansion restores the exact bytes after verifying the hash. A fold is therefore a claim the runtime can check, not a claim the reader has to trust.

Everything else follows from one invariant, and it is the reason several otherwise reasonable features are not here.

**A provider prefix cache is positional.** It replays the longest byte-identical prefix of the prompt, so one changed byte at offset K discards everything cached after K. The cost of a mutation has nothing to do with its size: deleting a single character in the middle of a large window and rewriting a hundred thousand tokens near the end of it bill the same way, because both invalidate the same suffix.

**So the runtime may move a byte in the window only at a moment it is already rewriting the window**, which is a commit or a fold. Everything else is a pure append at the tail, and an appended byte is never later altered, shortened, removed, or repositioned. Stated plainly: never mutate the window, and never show something and then take it back. The second half is the one that costs features. Anything that displays state and then updates it in place is out, however useful the display was, because updating in place is a mid-prefix write with better manners.

**Marks are free, because a mark moves nothing.** Under `foldScheduling: "epoch"` a `fold` action records a pending mark and returns immediately. The mark lives in durable session state, outside the window; the projection stays byte-identical and the cached prefix survives. The agent can therefore mark as it works, the moment a span stops mattering, without weighing each fold against a cache invalidation.

**A commit is the one moment bytes move, and every accumulated decision lands at once.** It goes through the same preparation and commit machinery an immediate fold uses, so a committed mark and an immediate fold produce the identical fold record. Committing is the runtime's call, not a verb the agent can spend: measured 2026-08-07, an agent given the verb called it twice and the runtime correctly held it both times, which is surface without function.

**Folds are lossless, and there are two ways back in.** Folds form a DAG whose leaves are the exact session entries, and every fold record keeps ordered references down to those leaves. `peek` is the cheap read: it returns one fold's exact SHA-256-verified source as a tool result, at any depth, with the ancestors still collapsed, without touching the projection. It takes `offset` and `bytes` for a bounded slice, and any child fold id is peekable, so a large fold has a narrow read. `expand` is the commitment, restoring that source in place until the fold is refolded, outside-in and one level at a time. Looking is not the same as taking, and most of the time an agent needs to check one detail rather than reopen an hour of work.

When the agent does not act, an automatic ladder manages the window the same lossless way, and it is deliberately more conservative: completed read-only tool batches, structurally closed chapters, and consolidation of existing folds only past explicit thresholds. Only the oldest eligible context changes; the fresh window is never touched. A session that never calls the tool degrades gracefully into lossless hierarchical compaction.

## Folding against compaction

Compaction does not continue a session, it starts a new one. Pi's native compaction summarizes the transcript, discards the originals, and begins again from the summary. In the run measured below that is literal rather than rhetorical: native compacted three times, and the request immediately after each one carried a prompt of exactly zero tokens, 369.0k to 0k, then 364.6k to 0k, then 363.0k to 0k. A continuation does not restart at zero. The handoff is also written before the end, so the freshest material is exactly what is missing from it, and what a summarizer drops as bookkeeping is what becomes unrecoverable.

Folding keeps the turn. Occupancy crosses a threshold, spans fold in place, and the session continues holding a verified copy of everything it folded. The window stays inside a band instead of sweeping the whole allotment: the same measured run put native between 0k and 369.0k across 117 requests, with 12 of them served above 300k, while the folding arm ran between 1.1k and 236.9k across 82 requests and never entered that zone. Roughly the same mean window, 140.9k against 138.8k; what differs is the range. That matters because behavior is not constant across it. You are not running one system at two sizes; you are running a different system at 40k than at 400k.

## Measured results

The campaign behind these tables is two experiments. The first, here, is pi-fold against Pi's native compaction. The second, further down under [epoch fold scheduling](#epoch-fold-scheduling), is pi-fold against itself with fold scheduling as the only variable.

One 64-stage staged assignment over the curl C repository: one Pi session per run, one user message, and the agent calls a `repo_stage` tool 64 times inside a single agentic turn. Model gpt-5.6-sol at xhigh effort, provider openai-codex. The 272,000-token figure in these tables is the transport's per-request input descriptor, which is what pi-fold budgeted against; the Codex catalog actually serves gpt-5.6 at a 372,000-token cap, which is where the native arm lived, peaking at 369.0k before each compaction. One arm runs pi-fold, the other runs Pi's native compaction.

There is one run per arm, and native did not finish: it ended its turn at stage 56 of 64. That leaves two pairings, and both are reported here rather than the flattering one.

### Same seed, both cut at stage 56

**Basis:** each arm is cut at the ledger record that delivered the stage 56 payload, and usage and cost are summed from the same billed records at or before that cut, including native's three compaction records, which all precede it. Same seed, same plan hash `6ed7c5f9e957`, both runs on 2026-08-07.

| Measure | pi-fold | native | ratio |
| --- | ---: | ---: | :--- |
| Total tokens | 9,598,126 | 16,011,169 | 0.60x |
| Fresh input | 1,249,415 | 1,322,539 | 0.95x |
| Cache read | 8,309,760 | 14,602,240 | 0.57x |
| Output | 38,951 | 86,390 | 0.45x |
| Billed calls | 69 | 114 | 0.61x |
| Cost, Pi's own ledger | $11.57 | $21.00 | 0.55x, a 44.9% saving |
| Pooled cache share | 0.869 | 0.917 | inverted, see below |
| Peak request context | 236,861 | 369,024 | threshold 272,000 |
| Long-context surcharge | $0.00 | $4.50 on 17 requests | 21.4% of native's bill |
| Compactions | 0 | 3 | |
| Agent file reads | 27, 0.06 MB | 117, 0.93 MB | 4.3x the reads, 15x the bytes |
| Wall clock | 25.2 min | 42.7 min | 0.59x |

### Both complete, 64 of 64 stages

**Basis:** whole-run basis for both arms. Usage and cost are summed from every billed record in the full session ledger, message records plus native's three compaction records; the ledger is the source of truth for both tokens and dollars. The two runs sit on different days, so provider conditions differ.

| Measure | pi-fold | native | ratio |
| --- | ---: | ---: | :--- |
| Total tokens | 11,435,313 | 16,970,754 | 0.67x |
| Fresh input | 1,489,599 | 1,407,978 | 1.06x |
| Cache read | 9,895,936 | 15,510,016 | 0.64x |
| Output | 49,778 | 52,760 | 0.94x |
| Billed calls | 82 | 108 | 0.76x |
| Cost, Pi's own ledger | $13.89 | $21.18 | 0.66x, a 34.4% saving |
| Pooled cache share | 0.869 | 0.917 | inverted, see below |
| Peak request context | 236,861 | 368,639 | threshold 272,000 |
| Long-context surcharge | $0.00 | $4.81 on 20 requests | |
| Fold events / compactions | 6 fold events, 0 compactions | 3 compactions | |
| Agent file reads | 39, 3.84 MB | 108, 4.62 MB | 2.8x the reads |
| Wall clock | 34.2 min | 32.4 min | 1.06x, pi-fold slower |

**Where the cost numbers come from.** Cost is Pi's own per-request ledger accounting, not a rate card chosen for the writeup. Every billed record's cost equals that record's own usage priced at the tier Pi applied: base rates of $5.00/M input, $0.50/M cache read and $30.00/M output, and a long-context tier of $10.00/M, $1.00/M and $45.00/M on any request whose context exceeds the model's 272,000-token window. That reproduces the ledger to the cent on both arms, including pi-fold's complete-run total of $13.89. Reasoning tokens sit inside output and are not billed separately. Native's three compaction summarizations are themselves billed calls, $0.58 at stage 56 and $0.54 on the complete run.

**Caveats, because the numbers rest on them.**

- **Fresh input is essentially identical.** 0.95x at stage 56 and 1.06x on the complete pairing: neither runtime consistently reads less new material. The 6.4 million token gap at stage 56 is re-sent accumulated context, 6.29 million of it cache read alone, not a difference in how much material was consumed.
- **No wall-clock claim on the complete pairing.** pi-fold was 5.6% slower there, 34.2 minutes against 32.4. The wall-clock win belongs to the stage-56 pairing only.
- **The cache share runs backwards, and that is the useful finding.** Native holds the higher pooled share, 0.917 against 0.869, while spending 67% more tokens and billing 82% more dollars, because cache share measures how cheap each prompt was rather than how much prompt was needed.
- **Part of the cost gap is a pricing tier, not token volume.** At flat base rates native's stage-56 bill would be $16.51, a 29.9% saving rather than 44.9%, and its complete-run bill $16.38, a 15.2% saving. The tier is real money a native run really pays, but quote the flat-rate figures when the argument is about tokens rather than price schedules.
- **One run per arm.** Native never finished; the supervisor lost the worker at the stage-57 request, so the stage-56 cut excludes native's final 6 messages and $0.57 of ledger cost. The complete pairing ran on different days. The stage-56 pairing is same-day and is the stronger claim.
- **The agent never called the tool.** All 62 folds in that run were the automatic ladder's; every commit records zero agent marks. So these are the fallback's numbers, produced by the part of the design that is closest to prior work, with agent curation, the distinguishing claim, unexercised.
- **The reread story is a count, not a duplicate-payload metric.** It rests on file read count and bytes from disk, both in the tables above.

Full method, artifact hashes and per-iteration history: [docs/fold_vs_compaction/experiment-log.md](https://github.com/shaneconner/pi-fold/blob/main/docs/fold_vs_compaction/experiment-log.md). Queued work, including the open problem the results end on: [docs/next-steps.md](https://github.com/shaneconner/pi-fold/blob/main/docs/next-steps.md).

## How it works

pi-fold maps canonical session entries into a fold lattice. Collapsed folds double as a browsable index of earlier work: the briefs sit in the stable prefix of the window, which providers typically serve from cache, so the agent can page through them at little cost, note which spans matter to its current task, expand those, and leave the rest folded. `status` with `detail: "tree"` lists every fold, nested ones included, in transcript order with its depth and parent.

The agent's own actions come first. Through the context tool it folds any structurally closed span it judges stale, folds completed tool batches, consolidates two or more adjacent folds into a deeper one, expands any fold whose detail is needed again, re-briefs a fold whose summary reads wrong, dissolves a mis-cut boundary with `reboundary`, and protects entries that must stay raw. None of the ladder's pressure or width thresholds apply to these actions. Curation the agent cannot fix afterwards is curation it will not risk making, which is why the two correction verbs are part of the ordinary surface rather than an extra.

Every fold, agent-made or automatic, obeys the same structural rules. Folds nest rather than partially overlap. Chapter folds align to closed user, assistant and tool-batch units, consolidations take two or more adjacent folds, and protected or fresh evidence never folds.

The ladder's thresholds are explicit constants rather than knobs. It folds only completed read-only tool batches and structurally closed chapters, absorbs only the tool-result folds inside a chapter's own span, and creates folds of folds past more than ten visible collapsed folds, which keeps the brief index tidy long before pressure matters, or past 85% measured occupancy of the serving budget, at which point consolidation squeezes existing folds to reclaim room. Briefs are bounded at 1,200 characters each, so the visible index normally costs about 1% of the window. Cadence and fresh-tail rules prevent repeated or premature automatic folding.

Below 80% occupancy of the serving budget the runtime is quiet: nothing folds automatically at all, because a commit is an epoch transition that risks the whole prefix cache, and the cadence has to be the fewest commits that still keep the window inside its budget. The remaining fifth of the budget is the runway the commit itself spends.

Chapter briefs are generated by the session's model by default, using one request per fold with a bounded input span, bounded output, and no tool calls. Every summarizer failure falls back to a deterministic brief; set `summarizer: "deterministic"` to disable model calls entirely. The default spends provider tokens, as native compaction does. A cheaper model from the same provider is the recommended summarizer: a session on GPT 5.6 Sol can delegate fold briefs to GPT 5.6 Luna at medium effort with `summarizer: { provider: "openai", model: "gpt-5.6-luna", effort: "medium" }`, using the provider id from your Pi model registry.

The serving budget is the total window less the output reservation actually in force, because the per-request max-input descriptor a provider advertises assumes a full reservation and understates the real ceiling. With no `providerTotalWindow` supplied the runtime falls back to the transport's descriptor, which is the conservative default for a model it has no total-window fact for; the descriptor is reported in status either way, so the gap stays auditable. A provider-window fence aborts an unsafe request before transmission if no lossless fold can make room, and says so out of band rather than by writing into the window.

By default, evidence ingestion writes read-only artifact files under the session directory's `pi-fold-evidence/`, sets them to mode `0444`, and enforces a 512 MB session cap. These immutable files provide exact-recovery anchors for oversized tool results. Set `evidenceIngestion: false` to disable the hook and all evidence writes.

## Epoch fold scheduling

Folding is cheap to decide and expensive to apply, and the expense has nothing to do with how much a fold saves. The bill is set by how often the projection changes, not by how many tokens each change reclaims. A session that folds once per turn re-sends its prefix once per turn; a session that folds three times in total re-sends it three times.

`foldScheduling: "epoch"` splits folding into the two phases described above: a `fold` action records a free pending mark, `unmark` withdraws a standing decision, and a commit applies every pending mark in one projection rewrite. `"immediate"` remains the default, writing no pending-marks key and leaving existing state digests where they are.

Two runs from the campaign put a number on the difference. This is the second of the two experiments: pi-fold against itself, both runs on gpt-5.6-luna, same plan, same seed, same configuration with fold scheduling as the only variable. It is internally controlled, and its numbers are not comparable across to the gpt-5.6-sol pairings above. Applying folds immediately spent 19,623,502 fresh input tokens across 105 requests at a pooled cache share of 0.119. Recording marks and landing them together spent 3,603,440 across 99 requests at 0.756: a 5.4x reduction in the tokens the provider had to read for the first time, carrying the total from 22,316,589 tokens down to 14,818,833. Epoch was slower in wall clock on that pairing, 33.5 minutes against 26.7, so the trade bought tokens and not time, and it is one run per arm rather than a rate.

The agent is meant to lead here: mark as you work, and let the runtime pick the seam. The ladder is the fallback, exactly as it is for folding itself. Its own rung decisions become marks instead of folds, and it commits the epoch when its two signals agree, occupancy at 80% of the serving budget and enough stale tool mass outside the fresh tail for a commit to have something to work with, or under the pressure backstop. Each automatic commit carries a target: if the agent's marks would free less than a fifth of the window, the ladder tops the epoch up with the stalest unprotected completed tool batches until they do, and the commit result records which marks were the agent's and which were the top-up.

Three refinements keep the two phases from getting in the way. A fold whose span sits within the last few messages of the window applies immediately even in epoch mode, because almost nothing follows it to invalidate. An `expand` issued while marks are pending opens the commit epoch, so a restore plus a batch of folds costs one rewrite between them rather than two; `peek` stays immediate, since it appends a tool result and never edits the prefix. And a peek result is itself a completed read, so at the next commit it folds away automatically unless the agent committed to what it saw, which keeps look, decide, discard nearly free.

Protection is unchanged. Top-up never marks protected evidence, and a pending mark that has become protected refuses at commit with a message naming it, leaving the rest of the epoch to apply. `active_context {"action":"status"}` reports the pending marks under `automatic.scheduling` with their origin, the estimated share of the window a commit would free, and the estimated prefix tokens it would rewrite.

## Reclaiming peek output

A `peek` returns a fold's exact stored source, bounded by the chapter cap. That copy then sits in the window as raw evidence while the fold it came from sits beside it as a placeholder: the same bytes, held twice, and the copy is the one the ladder cannot take. Immediate mode does not classify a peek batch as a completed read, so every rung measures the pressure and finds nothing eligible. On a workload that peeks freely this is the whole failure: a measured 64-stage session ended with 14 raw peek results holding 1.9M characters, 82% of everything still unfolded, while the ladder had already folded 53 of its 56 stage results and had no supply left.

`foldPeekResults: true` hands that supply back. The peek batch becomes a completed read like any other, eligible for the same cadence rung under the same protections: the freshest turns and the byte tail still stay raw, protected evidence is still refused, and the fold record is the ordinary reversible one, so the source recovers exactly. Nothing about the ladder's thresholds changes; only what counts as foldable does. Epoch scheduling already carries this classification with it, and the option is how immediate mode reaches the same place.

Reach for it when the agent uses `peek` as a browsing verb rather than a rare lookup. Leave it off when a peeked span is normally the span the agent is about to work from, since folding it back means peeking again to read it.

## What the invariant cost

Three separate features shipped that each rewrote the window mid-prefix, and each carried a code comment asserting the edit was tail-local and therefore safe. In all three cases the comment was the marker of the bug, and it was also the reason the bug survived review: the reasoning looked done, so nobody redid it.

Peek reclamation was the costliest. It removed duplicate bytes from the window after a peek and deferred the removal until a later assistant message existed, so the edit would land behind the tail. That deferral is what makes it look tail-local and what guarantees it is not: waiting for a later message is precisely the condition under which the window has already grown over the site of the edit. Measured 2026-08-07, two such reclamations cost 100k fresh tokens. A peek is now append-only, and its duplicate bytes are reclaimed by the tool-fold rung at the next commit, the one moment a rewrite is already being paid for.

The ephemeral surfacing slate went the same way, and it deserves its own note because the idea was not the problem. It scored the fold set against the live window and offered the agent a short slate of folds worth peeking at or expanding, and the selection was useful. What failed was the delivery: the slate was shown on one pass and withdrawn on the next so a recomputed slate could take its place, which is a show-then-retract. Its bytes occupy prefix positions in one request and different bytes occupy them in the next, so the cached prefix dies. The selector and the suggestion-source interface are still in the tree and still gated off; nothing renders a suggestion in this build. Any future version has to put a suggestion in front of the agent without the window changing underneath it, and the shape that survives the invariant is the open problem in [docs/next-steps.md](https://github.com/shaneconner/pi-fold/blob/main/docs/next-steps.md).

Anticipatory guidance went with them: pressure milestones, the live advisory, curation reminders, the last-call notice. Guidance about a coming event has to arrive before the event, so it can never ride a rewrite the runtime was already paying for; it has to create one. Eleven runs also say the warning bought nothing: voluntary fold share was 0.00, and the three runs built specifically to invite curation produced 0, 1 and 0 voluntary folds. What is left in the window is a bounded receipt of what the runtime just did, built only when a commit produced one, landing inside the freeze, never rendered twice.

Earlier releases shipped truthful capacity accounting, admission control on `peek` and `expand`, retained pending marks, stage-identified fold briefs, the current-turn commit guard, the pinned-mass backstop, the status index diet and the append-only projection itself as individually opt-in levers. All of them are now simply how pi-fold works, and the flags are gone rather than deprecated; git history is the lineage.

`active_context {"action":"status"}` reports real projection rewrites separately from observed provider-side cache misses, per-message digests included: a miss on a projection the runtime did not rewrite is provider-side by construction, and conflating the two hides exactly the bug this invariant exists to prevent. On the complete 64-stage run that instrument read 76 pure appends, 6 rewrites, and 0 unattributed rewrites, with the six rewrites landing batches of 12, 14, 9, 11, 9 and 7 folds.

## Relation to prior work

pi-fold combines two recent lines of work in one mechanism. Lossless hierarchical compaction, exemplified by LCM ([arXiv:2605.04050](https://arxiv.org/abs/2605.04050)) with an interactive walkthrough at [losslesscontext.ai](https://www.losslesscontext.ai/), builds a summary DAG over older messages with lossless pointers to every original, but the system alone decides when to compact and the folds accrete from the beginning of the conversation as it ages, so the cuts track position. Self-GC ([arXiv:2607.00692](https://arxiv.org/abs/2607.00692)) treats context as indexed, recoverable objects with fold, mask and prune actions, proposed by a side-channel planner under harness enforcement. In pi-fold the session agent itself holds the verbs, in-band, so the cuts can track relevance instead; the automatic ladder is the fallback, and a session that never touches the tool degrades into lossless hierarchical compaction.

Context-Folding ([arXiv:2510.11967](https://arxiv.org/abs/2510.11967), ByteDance Seed) has the agent branch into a sub-trajectory and fold it on completion, with the behavior shaped by reinforcement learning; the fold keeps a summary of the outcome rather than a lossless path back. MemGPT and its successor [Letta](https://github.com/letta-ai/letta) are the canonical agent-held memory-verb systems: the agent edits its own memory blocks and archives while the window pages against external stores. Two things separate pi-fold from that line. First, what is governed: Letta manages traffic between the window and outside storage, and when its message queue overflows the in-window record becomes a lossy recursive summary; pi-fold restructures the transcript in place. Second, recovery: theirs is retrieval, a search that re-ingests whatever comes back as new tokens; ours is expansion, which restores the exact folded entries after SHA-256 verification.

The placement is narrow. The lossless DAG is shared ground. The distinguishing claim is agent curation, and the measured run never exercised it, so the numbers above belong to the fallback. The part that is new is stated here and not yet measured.

The design also pairs with Pi's session trees: a fold's collapsed-or-expanded state is a natural unit for curating exactly which context a subagent or workflow leg inherits.

## Configuration

The package entry calls `registerPiFold(pi)` with the defaults below. Hosts that call the named `registerPiFold` export directly may pass an options object. Replacement lists and sets replace the defaults; they are not additive.

| Option | Default | Effect |
| --- | --- | --- |
| `toolName` | `"active_context"` | Name of the registered context tool. |
| `toolLabel` | `"Active Context"` | Human-facing label for the registered context tool. |
| `brandNoun` | `"active-context"` | Short noun used in fold placeholders, fence text, and native-compaction notices. |
| `entryTypePrefix` | `"pi-fold-active-context"` | Prefix for durable state, fold-record and status identifiers. Its namespace also derives measurement/compaction entry types, status source metadata, MCP evidence ownership, the evidence directory, and the unparseable MCP-server fallback. Changing it starts a separate state namespace. |
| `commandPrefix` | `""` | Prefix for `/context` and `/fold-context`; trailing hyphens are removed. |
| `commandNames` | `undefined` | Optional full-name overrides for the effective defaults `{ status: "context", fold: "fold-context" }`. Both names must be distinct kebab-case strings; supplied values take precedence over `commandPrefix`. |
| `summarizer` | `"session"` | Brief generator: the live session model, `"deterministic"` for no model calls, or `{ provider, model, effort? }` resolved through Pi's model registry. Cannot be combined with `summarizeContextSpan`. |
| `summarizeContextSpan` | `undefined` | Optional async brief generator. Results must include a useful bounded brief, provider/model/effort attribution, and `toolCalls: 0`; failure uses the deterministic brief. |
| `foldScheduling` | `"immediate"` | `"immediate"` applies every fold when it is made. `"epoch"` makes a fold a free pending mark and applies all pending marks in one projection rewrite when the runtime commits. See [epoch fold scheduling](#epoch-fold-scheduling). |
| `foldPeekResults` | epoch mode `true`, immediate mode `false` | Classify a `peek` result as a completed read, so the tool-fold rung may reclaim it. See [reclaiming peek output](#reclaiming-peek-output). |
| `providerTotalWindow` | the transport's descriptor | Total serving window. Every ratio, fence and budget is computed against this minus the output reservation actually in force. Supply it when the deployment knows the real ceiling: the per-request max-input descriptor a provider advertises assumes a full reservation and understates it. The descriptor is read and reported in status either way, so the gap stays auditable. |
| `toolActions` | all nine actions, plus `unmark` in epoch mode | Replacement allowlist drawn from `status`, `peek`, `fold`, `expand`, `refold`, `protect`, `unprotect`, `rebrief`, `reboundary`, and `unmark`. There is deliberately no agent-callable `commit`: marking is the agent's job and folding is the runtime's. |
| `blockingTools` | `["Agent"]` | Replacement list of tool names that trigger one opportunistic stale-tool fold before the call. Use `[]` to disable it. |
| `readOnlyTools` | `new Set(["read", "grep", "find", "ls"])` | Replacement set of tool names whose completed batches may fold automatically. Defaults to Pi's built-in read-only tools. Pass a `ReadonlySet<string>`. |
| `isMcpTool` | `() => false` | Synchronous predicate enabling evidence ingestion for oversized structured MCP results. Names shaped as `mcp__<server>__<tool>` project the actual server; other names use the neutral namespace derived from `entryTypePrefix`. |
| `evidenceIngestion` | `true` | Set to `false` to register no evidence-ingestion hook and write no evidence artifacts. |
| `setProjectionProvider` | `undefined` | Optional host callback that receives the [projection-candidate provider](#projection-candidate-records). Normal Pi context events do not require it. |
| `setSuggestionSourceRegistrar` | `undefined` | Optional host callback that receives the suggestion-source registration function. Sources register and their accept reports persist, but nothing renders a suggestion in this build; see [what the invariant cost](#what-the-invariant-cost). |

### Projection candidate records

The provider emits one record per visible collapsed fold. The fields and current values are:

| Field | Emitted value |
| --- | --- |
| `version` | `1` |
| `key` | `"projection:<fold-id>"` |
| `kind` | `"projection"` |
| `domain` | `"system"` |
| `horizon` | `"working"` |
| `source_id` | Fold ID. |
| `source_version` | Exact source SHA-256. |
| `route` | `{ tool: <toolName>, arguments: { action: "expand", id: <fold-id> } }` |
| `token_cost` | Estimated replacement tokens, rounded up with a minimum of 1. |
| `expansion_cost` | Estimated exact-source tokens, rounded up with a minimum of 1. |
| `rank` | Zero-based position among emitted candidates. |
| `score` | Saved-byte fraction, capped at 1. |
| `raw_score` | Exact bytes saved by the fold. |
| `confidence` | `"exact"` |
| `freshness` | `"current"` |
| `locked_owner` | `false` |
| `collapse_key` | `"projection:<fold-id>"` |
| `generator` | `"projection-model"`, `"projection-deterministic"`, or `"projection-supplied"` from brief provenance. |
| `generator_version` | `"memory-slate-generators-v2"` |
| `recency` | `null` |

## Status

Stable. The option surface is settled and the append-only projection invariant is enforced by the gate suite, which is the contract: `tests/verify.mjs` covers the runtime and `scripts/verify_pi_context_experiment.mjs` covers the experiment harness. New behavior lands with its gate.

## Development

```sh
npm ci
npm run lint
npm test
```
