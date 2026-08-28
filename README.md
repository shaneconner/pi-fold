# pi-fold

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.21856873.svg)](https://doi.org/10.5281/zenodo.21856873)

Agent-governed lossless context folding for Pi. A session folds its own transcript instead of losing it: the stale end collapses into short briefs while the exact originals stay on disk, addressed and verified by SHA-256, one tool call away.

The full write-up, with interactive versions of every mechanism on this page and the complete measurement story, is at [shaneconner.com/projects/pi-fold](https://shaneconner.com/projects/pi-fold/).

![pi-fold folding a session in place: marks outline completed spans as the session works, and the marks commit together at a fold event](https://raw.githubusercontent.com/shaneconner/pi-fold/main/media/fold-demo.gif)

*The mechanism, drawn. One session runs as the transcript it is, user messages in cream, the agent's replies in green, tool results a quieter shade of the same green. Marks outline spans as they complete and move nothing; the next fold event commits every standing mark in one rewrite, two outlined spans collapsing to two briefs at once. The exact messages stay on disk, addressed and verified by SHA-256, and expanding a brief brings them back byte for byte. Illustrative animation, not a screen capture, and it draws the 2.x surface, where the agent laid the marks and a protected fresh tail held the newest turns; since 3.0 the runtime lays each mark the moment a unit completes and the agent's job is the brief, so the marks arrive earlier and nothing waits to age out. The measured numbers are further down. A 6 MB mp4 of the same clip is at [media/fold-demo.mp4](https://github.com/shaneconner/pi-fold/blob/main/media/fold-demo.mp4).*

## Install

```sh
pi install npm:pi-fold
```

Node 22 or later, Pi 0.83 or later. Licensed under [MIT](./LICENSE).

pi-fold serves the working tier of a four-tier memory stack. [pi-canon](https://github.com/shaneconner/pi-canon) is a separate, optional package serving the long-term tiers, the journal episodic and the canon semantic; the two compose but neither requires the other.

## What it is

pi-fold registers one tool, `pi_fold_context`, and gives the session's own agent nine actions over its transcript: `status`, `peek`, `brief`, `expand`, `refold`, `pin`, `unpin`, `reboundary`, and `unmark`. It also registers `/fold`, `/fold-editor`, `/fold-status` and `/fold-settings` for the human.

A fold takes a contiguous span of session entries and replaces it, in the window only, with a short brief. The entries themselves go to a fold store, byte for byte, addressed by their SHA-256 hash. The brief carries a handle, the handle resolves to the original, and expansion restores the exact bytes after verifying the hash. A fold is therefore a claim the runtime can check, not a claim the reader has to trust.

Everything else follows from one invariant, and it is the reason several otherwise reasonable features are not here.

**A provider prefix cache is positional.** It replays the longest byte-identical prefix of the prompt, so one changed byte at offset K discards everything cached after K. The cost of a mutation has nothing to do with its size: deleting a single character in the middle of a large window and rewriting a hundred thousand tokens near the end of it bill the same way, because both invalidate the same suffix.

**So the runtime may move a byte in the window only at a moment it is already rewriting the window**, which is a commit or a fold. Everything else is a pure append at the tail, and an appended byte is never later altered, shortened, removed, or repositioned. Stated plainly: never mutate the window, and never show something and then take it back. The second half is the one that costs features. Anything that displays state and then updates it in place is out, however useful the display was, because updating in place is a mid-prefix write with better manners.

Pinning is the other half of governing a window. `pin` holds entries raw through every fold, automatic or marked, so it is how an agent keeps a span expanded on purpose. It is tracked as a claim beside the marks and reported with them, and it frees nothing: the commit still takes its drop from whatever is left, so pinned mass makes the rest of the window fold sooner. A pinned share cap stops that from becoming a window nothing can reclaim.

**Marks are free, because a mark moves nothing.** The runtime stages the marks itself: the moment a tool batch or a chapter closes, the frontier cuts it into a pending fold mark, event by event, up to eight cuts per pass, stalest first. A mark lives in durable session state, outside the window; the projection stays byte-identical and the cached prefix survives. What the agent owns is the words. Once enough cut folds are waiting, one bounded notice names them, and `brief` writes the agent's own sentence onto a pending fold for free, because the brief reaches the window only when the commit writes that placeholder for the first time. A supplied brief is kept verbatim; a fold left unbriefed commits with a deterministic brief the runtime writes from the span itself, and the provenance records which happened.

Curation is correctable until the commit. `reboundary` with ids re-cuts a span into exactly one fold, merging adjacent cuts when the span covers several and splitting one when the span sits inside it; with a single id it returns that fold's span to raw. `unmark` withdraws a pending mark entirely, and `brief` may be rewritten on a pending fold any number of times at no cost. A standing fold's brief is never rewritten, because rewriting it rewrites the projection at that fold's placeholder and costs the whole prefix cache from there on.

**A commit is the one moment bytes move, and every accumulated decision lands at once.** It goes through the preparation and commit machinery every fold has always used, so a committed mark produces the ordinary fold record. Committing is the runtime's call, not a verb the agent can spend: measured 2026-08-07, an agent given the verb called it twice and the runtime correctly held it both times, which is surface without function.

**Folds are lossless, and there are two ways back in.** Folds form a DAG whose leaves are the exact session entries, and every fold record keeps ordered references down to those leaves. `peek` is the cheap read: it returns one fold's exact SHA-256-verified source as a tool result, at any depth, with the ancestors still collapsed, without touching the projection. It takes `offset` and `bytes` for a bounded slice, and any child fold id is peekable, so a large fold has a narrow read. A peek is ephemeral by default: the bytes ride the window until the model's next message, then their place holds a one-line placeholder and the reply that used them is the surviving trace, so an agent extracts what it needs into that reply. Peeking again is lossless and costs one append, and `ephemeral: false` keeps a result standing when the bytes are needed across several turns. The default follows what agents actually chose: on the sealed run measured for this, six of seven peeks asked for ephemeral at first exposure, and the one durable read was the probe that needed the bytes to persist. `expand` is the commitment, restoring that source in place until the fold is refolded, outside-in and one level at a time. Looking is not the same as taking, and most of the time an agent needs to check one detail rather than reopen an hour of work.

When the agent never annotates, the same folds still happen with deterministic briefs: the cuts are the runtime's either way, and only the words on them change. Pinned and blacklisted material never folds, and the fresh end of the window is protected structurally, because an incomplete unit is never proposable and the commit cuts stalest first and stops at its aim. A session that never calls the tool degrades gracefully into lossless hierarchical compaction.

## What we found, and what we cannot say

The campaigns behind this package were built to reproduce specific things we believed compaction handled badly. That makes them useful and it also makes them narrow. They are not a neutral sample of real work, and nothing here estimates how any of this behaves in a production workflow, because that is not something this setup can test.

The first thing they settled is that native compaction is strong. It is the right default for most sessions: it costs nothing to adopt, it needs no tool surface, and models are trained under it and are good at choosing what to write down. Where a later campaign de-primed its own instrument and asked a fairer question, compaction beat folding on both score and cost. The improvements we could measure reliably were in cost and wall clock rather than in capability.

Lossless recall is real, and it is worth less on its own than it sounds. An agent in a real deployment can usually reach its own transcript and find the same information by other means, so a mechanism that keeps the bytes addressable is a convenience rather than a capability nobody else has. What the campaigns kept pointing at instead was the pairing: rotate stale context out of the window, and keep what has to survive in a long-term memory store. That was the largest saving we found that did not cost answer quality.

So the claim is bounded. Inside these benchmarks there is a large efficiency opportunity, in money and in time, at matching answer quality. Outside them we are not making claims. pi-fold is a solution that suited our needs, offered in case it suits yours; it is not a replacement for summarization and there is no suggestion it fits every workflow.

### The setup we would recommend

Deterministic briefs alongside a long-term memory store.

Rotation and retention are different jobs. Rotation gets stale material out of the window. Retention keeps what the session learned. A handoff summary does both in one pass, which is why it works and also where it runs out: it is durable context living in exactly one record, written once under time pressure, and bounded by the window it has to fit inside. Folding is the rotation half and only that half. A store is the other: many records rather than one, each at its own address, written as the work happens, and it outlives the session.

The [rotation and retention](https://doi.org/10.5281/zenodo.22146898) campaign measured the pairing. Given the same external store, native compaction and folding answered the withheld exam identically, with no wrong answers on either. What separated them was the bill, and the folding arm paid about half. Letting the model write its own briefs, rather than taking the runtime's deterministic ones, produced the worst score in that campaign, which is why the recommendation names them.

[pi-canon](https://github.com/shaneconner/pi-canon) is the store this line built, developed alongside pi-fold and kept a separate package on purpose: the two jobs are separate, so the two packages are. Nothing here depends on it. The fold asks a store for two properties only, somewhere durable to put knowledge and an address the agent can follow back, and any long-term memory offering both should compose the same way. Only pi-canon was tested.

## Folding against compaction

Compaction does not continue a session, it starts a new one. Pi's native compaction summarizes the transcript, discards the originals, and begins again from the summary. In the run measured below that is literal rather than rhetorical: native compacted three times, and the request immediately after each one carried a prompt of exactly zero tokens, 369.0k to 0k, then 364.6k to 0k, then 363.0k to 0k. A continuation does not restart at zero. The handoff is also written before the end, so the freshest material is exactly what is missing from it, and what a summarizer drops as bookkeeping is what becomes unrecoverable.

Folding keeps the turn. Occupancy crosses a threshold, spans fold in place, and the session continues holding a verified copy of everything it folded. The window stays inside a band instead of sweeping the whole allotment: the same measured run put native between 0k and 369.0k across 117 requests, with 12 of them served above 300k, while the folding arm ran between 1.1k and 236.9k across 82 requests and never entered that zone. Roughly the same mean window, 140.9k against 138.8k; what differs is the range. That matters because behavior is not constant across it. You are not running one system at two sizes; you are running a different system at 40k than at 400k.

## Measured results

The first campaign behind these tables contains two experiments. The first, here, is pi-fold against Pi's native compaction. The second, further down under [epoch fold scheduling](#epoch-fold-scheduling), is pi-fold against itself with fold scheduling as the only variable. A later transcript-only hidden-mass campaign is reported separately below, with its own protocol and claim limits.

One 64-stage staged assignment over the curl C repository: one Pi session per run, one user message, and the agent calls a `repo_stage` tool 64 times inside a single agentic turn. Model gpt-5.6-sol at xhigh effort, provider openai-codex. The 272,000-token figure in these tables is the transport's per-request input descriptor, which is what pi-fold budgeted against; the Codex catalog actually serves gpt-5.6 at a 372,000-token cap, which is where the native arm lived, peaking at 369.0k before each compaction. One arm runs pi-fold, the other runs Pi's native compaction.

There is one run per arm, and native did not finish: it ended its turn at stage 56 of 64. That leaves two pairings, and both are reported here rather than the flattering one.

The measurement is written up as a paper, with the figure sources, the redacted per-request ledgers, and the campaign log deposited beside it: [doi.org/10.5281/zenodo.21856873](https://doi.org/10.5281/zenodo.21856873). The story of how the campaigns got here is on Medium, in four parts, from [compaction doesn't have to mean starting over](https://medium.com/@shane.conner/compaction-doesnt-have-to-mean-starting-over-89c0b319d1a6) to [a compaction summary is one record doing a store's job](https://medium.com/@shane.conner/a-compaction-summary-is-one-record-doing-a-stores-job-3f46212ef059).

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

Full method, artifact hashes and per-iteration history: [docs/fold_vs_compaction/experiment-log.md](https://github.com/shaneconner/pi-fold/blob/main/docs/fold_vs_compaction/experiment-log.md). Queued work: [docs/next-steps.md](https://github.com/shaneconner/pi-fold/blob/main/docs/next-steps.md).

### The exam this campaign retired

A follow-up campaign planted seeded values only in the transcript and withheld a final block of questions until all 64 stages were delivered. It produced a scoreboard that earlier releases of this README published, and that scoreboard is withdrawn. The successor campaign found the instrument was measuring itself: most of its points sat on block-shaped lookups, which is a summarizer's strongest behavior, and its in-run probe waves were practice for its own final exam. De-primed, the compaction arm beat the folding arm on both score and cost. No numerical version of that comparison survives as a standing result.

What survives is narrower and is separately gated: across every folding run, the folded bytes stayed retrievable to the last request. The full chronology, the stop rule and all 102 certified rows are in the [experiment log](https://github.com/shaneconner/pi-fold/blob/main/docs/fold_vs_compaction/experiment-log.md) and [hidden-mass-results.json](https://github.com/shaneconner/pi-fold/blob/main/docs/fold_vs_compaction/hidden-mass-results.json). The campaign and its retraction are written up at [doi.org/10.5281/zenodo.21980747](https://doi.org/10.5281/zenodo.21980747) and [doi.org/10.5281/zenodo.22143915](https://doi.org/10.5281/zenodo.22143915).

## How it works

pi-fold maps canonical session entries into a fold lattice. Collapsed folds double as a browsable index of earlier work: the briefs sit in the stable prefix of the window, which providers typically serve from cache, so the agent can page through them at little cost, note which spans matter to its current task, expand those, and leave the rest folded. `status` with `detail: "tree"` lists every fold, nested ones included, in transcript order with its depth and parent.

The cutting is the runtime's. As units complete, the frontier stages each one as a pending fold mark, at the level of events rather than turns: a completed tool batch is proposable the moment its results land, and an incomplete one never is. The agent's actions ride on top: it briefs the cut folds in its own words, expands any fold whose detail is needed again, dissolves a mis-cut boundary with `reboundary`, withdraws a mark with `unmark`, and pins entries that must stay raw. Curation the agent cannot fix afterwards is curation it will not risk making, which is why `reboundary` is part of the ordinary surface rather than an extra.

Every fold obeys the same structural rules. Folds nest rather than partially overlap. Chapter folds align to closed user, assistant and tool-batch units, consolidations take two or more adjacent folds, and pinned or blacklisted evidence never folds. The frontier keeps its own cuts bite-sized, because nobody vouched for a bigger boundary, and a fold that hides more than it says is a fold nobody reads back. A span someone names, through `reboundary` or the editor, is taken whole at any size: a person or the agent cut that boundary on purpose, and a large fold stays cheap to read because peek takes an offset and a byte count, states the middle it omitted, and reads any child fold by id.

The automatic law folds only completed tool batches and structurally closed chapters, absorbs only the tool-result folds inside a chapter's own span, and treats fold placeholders as ordinary span material once the window carries `consolidateAfter` unpinned folds, which keeps the brief index tidy long before pressure matters. Briefs are bounded at 2,000 characters each, one cap for supplied and runtime-written briefs alike, so the visible index normally costs a low single-digit share of the window. Automatic foldability is membership, not position: a span folds because it is a completed tool batch or older material a chapter can compose, and what holds it back is the agent's pins and the blacklist. Openness is structural and event-level: an incomplete tool batch is never proposable, and the routine commit cuts stalest first and stops at its aim, so the newest events stay raw for exactly as long as there is room for them.

Tool results get a second, lighter treatment at the same commit. Results sitting in the oldest `toolFoldThreshold` share of the projected window, half of it by default, are clipped in view: the identifying head stays, the rest becomes a marker naming the entry id that peeks it back, and the stored bytes are untouched, so a later fold of that span still encodes the full result. The clip rides the commit's own rewrite and never moves a byte on its own. Pass `toolFoldThreshold: 0` to turn it off.

Below `maxTarget` occupancy of the serving budget, 80% by default, the window is quiet: marks accumulate but nothing commits, because a commit is an epoch transition that risks the whole prefix cache, and the cadence has to be the fewest commits that still keep the window inside its budget. The remaining fifth of the budget is the runway the commit itself spends. Every occupancy number in this document is a share of that one serving budget: there is a single denominator, `capacityAccounting.budgetTokens`, and no threshold is stated against the raw provider window.

Every brief is deterministic, written by the runtime from the span itself with no model call: a tool fold carries the call, its arguments, the head and tail of the result, and the agent's own notes from the batch; a chapter carries its opening text and every assistant note in span order; a consolidation indexes each child. A model-written brief generator shipped through 1.0.x and was deleted on its own measurement: across 15 sealed runs it wrote 1,186 upgraded briefs, 75 percent of which were never consulted by the agent or never became visible before the session ended, and a build with the generator removed scored the same recall for less money. The agent that wants better words on a fold writes them itself: `brief` puts them on the pending fold and a supplied brief is kept verbatim. There is no way to rewrite a standing fold's brief, because doing so rewrites the projection at that fold's placeholder and costs the whole prefix cache from there on. Sessions already holding model-written briefs keep them on load.

The serving budget is what the deployment states it may fill, because the per-request max-input descriptor a provider advertises assumes a full output reservation and understates the real ceiling. With no `providerInputBudget` supplied the runtime falls back to the transport's descriptor and estimates a reservation out of it, which is the conservative default for a model it has no budget fact for; the descriptor is reported in status either way, so the gap stays auditable. A provider-window fence aborts an unsafe request before transmission if no lossless fold can make room, and says so out of band rather than by writing into the window.

Pi's automatic compaction stays enabled underneath pi-fold; there is no setting to turn off. The runtime intercepts every compaction pass and answers it by kind. A threshold pass is cancelled outright, because the fold commit at `maxTarget` fires first and folding remains authoritative. An overflow pass, the one Pi starts when the provider rejects a request as too large and is prepared to retry, becomes a recovery in the shape of `/tree`, automated: the failed path is labeled with its lineage, the session branches back to the last message before the error, and the retried pass folds and commits before it transmits, so the re-issued message fits inside a window that kept its folds and its exact originals. The agent gets one notice that a rollback and commit happened. A trailing assistant message still holding unanswered tool calls is not replayed, and the notice says so. Manual `/compact` passes through untouched as the user's escape hatch. Turning Pi's automatic compaction off removes the hook this lane arms on: the runtime still classifies an overflow when it appears, but reports that it cannot roll back rather than guessing at a tree whose agent state disagrees with it.

Evidence ingestion writes read-only artifact files under the session directory's `pi-fold-evidence/`, sets them to mode `0444`, and enforces a 512 MB session cap. These immutable files provide exact-recovery anchors for oversized tool results. It is always on and there is no setting to turn it off: the artifacts are what an oversized result folds against, so a deployment that stopped writing them would keep its folds and lose what makes them lossless.

## Epoch fold scheduling

Folding is cheap to decide and expensive to apply, and the expense has nothing to do with how much a fold saves. The bill is set by how often the projection changes, not by how many tokens each change reclaims: a session that folds once per turn re-sends its prefix once per turn. So epoch scheduling is the only scheduler. The frontier records pending marks for free as units complete, `unmark` withdraws a standing decision, and one commit applies every pending mark in a single projection rewrite. Applying each fold at the moment it was made shipped as an option through 1.0.2 and was deleted once measured: on the pairing below it cost 54 prefix rewrites where epoch paid 3.

Two runs from the campaign put a number on the difference. This is the second of the two experiments: pi-fold against itself, both runs on gpt-5.6-luna, same plan, same seed, same configuration with fold scheduling as the only variable. It is internally controlled, and its numbers are not comparable across to the gpt-5.6-sol pairings above. Applying folds immediately spent 19,623,502 fresh input tokens across 105 requests at a pooled cache share of 0.119. Recording marks and landing them together spent 3,603,440 across 99 requests at 0.756: a 5.4x reduction in the tokens the provider had to read for the first time, carrying the total from 22,316,589 tokens down to 14,818,833. Epoch was slower in wall clock on that pairing, 33.5 minutes against 26.7, so the trade bought tokens and not time, and it is one run per arm rather than a rate.

A commit fires on one condition: occupancy reaching `maxTarget` of the serving budget. Nothing else fires one automatically. It applies marks stalest first and stops once the window is back at `minTarget`, so the newest events stay raw, a mark past the bound waits for the next epoch, and the gap between the two lines is the hysteresis that makes the spacing structural rather than hoped for. A pending mark that has become protected refuses at commit by name, leaving the rest of the epoch to apply. Reading never interferes: `peek` appends a tool result and never edits the prefix, so checking what a fold holds costs nothing a commit has to pay for.

Staged cuts are announced while a brief can still change what a fold will say. Once three or more staged folds are waiting without an agent brief, one notice of at most 2,400 bytes is appended once per frozen projection, naming the cut folds with their kinds and estimated sizes and showing the `brief` call that annotates them. It is appended rather than re-rendered, so it never moves, never costs the cache, and never asks twice. Whatever is still unbriefed when the commit fires folds with the brief the runtime wrote. Every curation action answers with the same arithmetic, because an agent sees no occupancy and no threshold and cannot aim at a drop nobody states: what the next commit must free, and what the standing marks will free when it runs. `pi_fold_context {"action":"status"}` reports the pending marks under `automatic.scheduling` with their origin and both estimates.

## Reclaiming peek output

A `peek` returns a fold's exact stored source, bounded by the chapter cap. That copy then sits in the window as raw evidence while the fold it came from sits beside it as a placeholder: the same bytes, held twice, and the copy is the one automatic folding cannot take. A runtime that does not classify a peek batch as a completed read measures the pressure at every rung and finds nothing eligible. On a workload that peeks freely this is the whole failure: a measured 64-stage session ended with 14 raw peek results holding 1.9M characters, 82% of everything still unfolded, while the runtime had already folded 53 of the 56 stage results and had no supply left.

So a peek result is classified as a completed read, unconditionally. The peek batch is eligible for the same tool rung under the same protections: protected evidence is still refused, and the fold record is the ordinary reversible one, so the source recovers exactly. Nothing about the commit's thresholds changes; only what counts as foldable does. The cost is that a peeked span the agent is about to work from can fold back before it is used, which means peeking again to read it; the duplicate window it otherwise leaves behind is the larger bill.

## What the invariant cost

Three separate features shipped that each rewrote the window mid-prefix, and each carried a code comment asserting the edit was tail-local and therefore safe. In all three cases the comment was the marker of the bug, and it was the reason the bug survived review: the reasoning looked done, so nobody redid it.

Peek reclamation was the costliest. It removed duplicate bytes from the window after a peek, deferring the removal until a later assistant message existed so the edit would land behind the tail. That deferral is what makes it look tail-local and what guarantees it is not: waiting for a later message is precisely the condition under which the window has already grown over the site of the edit. Measured 2026-08-07, two such reclamations cost 100k fresh tokens. A peek is now append-only, and its duplicate bytes are reclaimed by the tool-fold rung at the next commit, the one moment a rewrite is already being paid for.

The ephemeral surfacing slate failed the same way, and the idea was not the problem: it scored the fold set against the live window and offered the agent a short slate worth peeking at, and the selection was useful. The delivery was a show-then-retract, shown on one pass and withdrawn on the next so a recomputed slate could take its place, which kills the cached prefix. Re-homed to the commit boundary as one persisted suggestion per epoch, the sealed corpus showed 86 surfacings with 7 taken, all seven on earlier builds, so the subsystem was deleted whole. Anticipatory guidance went with it: pressure milestones, the live advisory, curation reminders. Guidance about a coming event has to arrive before the event, so it can never ride a rewrite the runtime was already paying for; it has to create one. What is left in the window is a bounded receipt of what the runtime just did, built only when a commit produced one, landing inside the freeze.

Earlier releases read those runs as evidence about agents: eleven runs at a voluntary fold share of 0.00, and three runs built to invite curation producing 0, 1 and 0 voluntary folds. That reading is withdrawn. Two things made marking impossible rather than unattractive in those runs. The ladder marked on every measurement, so by the time any invitation reached the agent there was nothing unclaimed left to name, which the records show directly: the unmarked remainder was zero at every measured crossing. And the invitation was anchored to the serving budget rather than to the commit threshold, which on a real deployment puts it above the threshold rather than below it, so it arrived after the commit was already due. Both are fixed. The numbers stand as measurements of that design; they are not evidence about what an agent will do, and the question is open until it is measured on a runtime where marking is possible.

Truthful capacity accounting, admission control on `peek` and `expand`, retained pending marks, the pinned-mass backstop and the append-only projection itself all shipped as individually opt-in levers. All of them are now simply how pi-fold works, and the flags are gone rather than deprecated; git history is the lineage.

`pi_fold_context {"action":"status"}` reports real projection rewrites separately from observed provider-side cache misses: a miss on a projection the runtime did not rewrite is provider-side by construction, and conflating the two hides exactly the bug this invariant exists to prevent. On the complete 64-stage run that instrument read 76 pure appends, 6 rewrites, and 0 unattributed rewrites.

## Relation to prior work

pi-fold combines two recent lines of work in one mechanism. Lossless hierarchical compaction, exemplified by LCM ([arXiv:2605.04050](https://arxiv.org/abs/2605.04050)) with an interactive walkthrough at [losslesscontext.ai](https://www.losslesscontext.ai/), builds a summary DAG over older messages with lossless pointers to every original, but the system alone decides when to compact and the folds accrete from the beginning of the conversation as it ages, so the cuts track position. Self-GC ([arXiv:2607.00692](https://arxiv.org/abs/2607.00692)) treats context as indexed, recoverable objects with fold, mask and prune actions, proposed by a side-channel planner under harness enforcement. In pi-fold the runtime cuts in-band at event boundaries and the session agent holds the annotation and correction verbs over the cuts, so what a fold says can track relevance; a session that never touches the tool degrades into lossless hierarchical compaction.

Context-Folding ([arXiv:2510.11967](https://arxiv.org/abs/2510.11967), ByteDance Seed) has the agent branch into a sub-trajectory and fold it on completion, with the behavior shaped by reinforcement learning; the fold keeps a summary of the outcome rather than a lossless path back. MemGPT and its successor [Letta](https://github.com/letta-ai/letta) are the canonical agent-held memory-verb systems: the agent edits its own memory blocks and archives while the window pages against external stores. Two things separate pi-fold from that line. First, what is governed: Letta manages traffic between the window and outside storage, and when its message queue overflows the in-window record becomes a lossy recursive summary; pi-fold restructures the transcript in place. Second, recovery: theirs is retrieval, a search that re-ingests whatever comes back as new tokens; ours is expansion, which restores the exact folded entries after SHA-256 verification.

The placement is narrow. The lossless DAG is shared ground. The distinguishing claim is agent curation, and the measured run never exercised it, so the numbers above belong to the fallback. The part that is new is stated here and not yet measured.

The design also pairs with Pi's session trees: a fold's collapsed-or-expanded state is a natural unit for curating exactly which context a subagent or workflow leg inherits.

## Configuration

The package entry calls `registerPiFold(pi)` with the defaults below, and that is the whole surface: six options, one of which no longer appears in the settings screen and three of which are off unless a host asks for them, and every other name is refused with the replacement or the deletion reason named in the message. A host still passing `summarizer` or `guidance` is refused with the deletion message rather than silently ignored. Hosts that call the named `registerPiFold` export directly may pass an options object. Replacement sets replace the defaults; they are not additive.

Four commands ship for the human: `/fold-status` (fold roots and paging state), `/fold` (commit every staged mark in one epoch; with explicit ids, folds exactly that span now), `/fold-editor` (the interactive map of the working window: occupancy against the serving budget, fold roots with their briefs, staged marks, pins; Enter expands a fold or deepens an entry's preview, `m` lays a user mark over a raw span with an optional typed brief, `u` withdraws a staged mark, `p` pins or unpins, and every gesture runs the same validated paths the agent's tool actions run), and `/fold-settings` (edit the configuration below from inside the TUI). The settings command reads and writes `~/.config/pi-fold/settings.json`, whose only key is `thresholds`; each edit is applied against the whole current object and re-validated through the same `resolveThresholds` path registration uses, so only a policy that would register is ever written. A missing file means package defaults. A stored file never stops the agent: one written before a setting existed is migrated, keeping every value it carries, gaining the new one at its default, and rewritten whole so a partial object is never re-read against later defaults; a file that is genuinely invalid is left alone, the package defaults apply, and `/fold-settings` names the reason. The four values in `thresholds` are everything a person tunes: `maxTarget` is when to fold, `minTarget` is how far down, `consolidateAfter` is how wide a group gets a parent, and `minFoldChars` is how big a fold has to be to be worth making.

| Option | Default | Effect |
| --- | --- | --- |
| `thresholds` | `{ maxTarget: 0.80, minTarget: 0.20, consolidateAfter: 10, minFoldChars: 8000 }` | The band, set whole or not at all. The first two are proportions of the serving budget: fold at `maxTarget`, fold down to `minTarget`. Against a 272,000-token descriptor the defaults hold the session in roughly a 55k to 250k band: the trigger fires at 80% and the session runs one epoch's inflow past it before the commit lands, and the aim cuts back to about 55k. The floor is where the cadence is bought. Every commit re-reads roughly `minTarget` of the budget uncached, so a shallower cut buys less runway for nearly the same bill: the rewrite tax is `minTarget / (maxTarget - minTarget)`, 0.33 at 0.80/0.20 against 1.0 at 0.80/0.40. 0.20 is the floor the campaign reported above actually ran. `consolidateAfter` is a positive integer count of visible roots per parent owed. `minFoldChars` is the size in characters a fold has to reach to be worth making, and the same number is the floor a gap between two folds has to clear to stay raw: anything smaller is absorbed by the fold beside it. Characters rather than tokens because a token means a different amount of text on every wire. Validated atomically at registration, and an impossible policy is refused by name rather than clamped. User policy only: no agent action can read it back as a mutable surface, though status reports the values. |
| `providerInputBudget` | the transport's descriptor | Machine surface, off the `/fold-settings` screen as of 2.1: the tokens this deployment may actually put into a request, already net of whatever output reservation it holds back. Every ratio, fence and budget divides by it directly, and pi-fold subtracts nothing from a declared value. It exists for a harness that needs runs comparable across descriptor changes. Shares otherwise apply to the model's own window: the runtime falls back to the transport's descriptor and estimates the reservation out of it, and the descriptor is reported in status either way, so the gap stays auditable. |
| `blacklistAutoFoldTools` | `new Set()` | The exception list. Every completed tool batch is foldable by the runtime on its own, without an agent mark; name a tool here and its results stay raw instead. Empty by default, because foldability is not the protection: pins are, and they apply to a blacklisted tool and an ordinary one alike. Pass a `ReadonlySet<string>`. Blacklisting is not free: the mass stays in the window until a chapter fold takes it, and a closed unit that alone exceeds the chapter cap is reclaimed whole rather than in pieces. |
| `toolFoldThreshold` | `0.50` | The tool-call diet. A share in `[0, 1)`: tool results sitting in the oldest that-share of the projected window are clipped in view at each commit, the identifying head kept and the full bytes peek-recoverable behind the entry id the marker names. 0.50 is what the campaign above ran on every folding repetition from the third onward, so the default is the measured value rather than the absence of one. Pass `0` to turn the diet off, which is worth doing if a session's tool results are small enough that the clip pays for nothing. |
| `postFoldNotice` | `false` | The invitation switch. By default no carrier invites a brief and every fold goes out with the deterministic brief the runtime writes from the span itself, which is the shape that won the campaign reported above. Pass `true` to append a standing invitation asking the agent to improve a brief while the fold is still pending. The tradeoff stated plainly: an agent never told a fold happened is one that will not think to annotate it, and inviting it to annotate scored worse than leaving it alone. The agent verbs stay on the tool either way. |
| `workingMemory` | off | The digest channel: a session-scoped ordered dictionary the agent keeps beside the fold index, `remember` writing or removing an entry, `recall` reading bodies on demand, and the projection carrying one table of contents refreshed at each commit. Off unless asked for. It earned its place in a measured gap, where running tallies were the one thing the index lost, and it stays separable because it is not the index. |

### Migrating from 2.x

Version 3.0 moves the cutting from the agent to the runtime, on the first live session's measurement: a session that never closes its turn never handed the old design a boundary to fold at, so the guard that waited for one held everything while occupancy climbed. Boundaries are now events, not turns.

- The `fold` action is deleted from the tool surface. The runtime stages every completed unit itself; the agent annotates with `brief`, corrects with `reboundary` and `unmark`, and protects with `pin`.
- Remove `guidance`. The option is refused by name: it switched the copy that taught the agent to choose spans, and the agent no longer chooses spans. The post-fold notice replaced it and has its own option as of 3.1, `postFoldNotice`, which defaults false: the deterministic shape is the one the campaign measured. Pass `true` for the invitation.
- `thresholds.freshTail` is gone: fresh-tail protection is deleted, because openness is structural per event and the commit's depth bound already stops at the aim. A settings file carrying the key is migrated by dropping it, with every tuned value kept.
- The default `thresholds` are `maxTarget: 0.80` and `minTarget: 0.20`, which against a 272,000-token descriptor holds a session in roughly a 55k to 250k band.
- Existing sessions remain readable, folds and briefs included.

### Projection candidate records

`registerPiFold` returns `{ projectionCandidates }`, a provider a host may call with a Pi context. It emits one record per visible collapsed fold. The fields and current values are:

| Field | Emitted value |
| --- | --- |
| `version` | `1` |
| `key` | `"projection:<fold-id>"` |
| `kind` | `"projection"` |
| `domain` | `"system"` |
| `horizon` | `"working"` |
| `source_id` | Fold ID. |
| `source_version` | Exact source SHA-256. |
| `route` | `{ tool: "pi_fold_context", arguments: { action: "expand", id: <fold-id> } }` |
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
node scripts/verify_pi_context_experiment.mjs
```
