# pi-fold

[![npm](https://img.shields.io/npm/v/pi-fold)](https://www.npmjs.com/package/pi-fold) [![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22142456.svg)](https://doi.org/10.5281/zenodo.22142456)

**Rotate stale text out of the context window without losing it, and spend the prefix cache once per commit instead of continuously.** The oldest part of a session collapses into short briefs while the exact originals stay on disk, one tool call away. Folding is automatic and needs no agent participation. The shipped shape is deterministic briefs paired with a durable memory store, which is the cheapest configuration measured that kept recall intact.

![pi-fold folding a session in place: marks outline completed spans as the session works, and the marks commit together at a fold event](https://raw.githubusercontent.com/shaneconner/fold/main/media/fold-demo.gif)

*Marks outline spans as they complete and move nothing; the next commit applies every standing mark in one rewrite. Expanding a brief brings the exact messages back byte for byte. Illustrative animation drawn on the 2.x surface, where the agent laid the marks; since 3.0 the runtime lays them.*

## Install

```sh
pi install npm:pi-fold
```

Node 22 or later, Pi 0.83 or later. MIT licensed.

Folding does not require a memory store, but every best result measured came from pairing it with one. The campaigns used [pi-canon](https://github.com/shaneconner/canon), installed separately. The two began as a single working setup and were split into separate extensions for modularity, and the experiments are what established that they work better as complements than either does alone. Only that pairing has been measured. Any durable long-term memory store is expected to compose the same way, though that is a suspicion rather than a result.

## What it does

Compaction replaces the transcript with a summary and discards the originals. Folding replaces stale spans with briefs and keeps the originals retrievable.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/shaneconner/fold/main/media/fold-vs-compaction-dark.svg">
  <img alt="Compaction turns the transcript into a summary and discards the originals, so the session starts over. pi-fold turns it into a brief and keeps the exact originals on disk, one peek or expand away, so the session keeps going." src="https://raw.githubusercontent.com/shaneconner/fold/main/media/fold-vs-compaction-light.svg">
</picture>

A fold takes a contiguous span of session entries and replaces it, in the window only, with a short brief. The entries go to a fold store byte for byte, addressed by their SHA-256 hash. The brief carries a handle, the handle resolves to the original, and expansion restores the exact bytes after verifying the hash.

The package registers one tool, `pi_fold_context`, with nine actions over the transcript: `status`, `peek`, `brief`, `expand`, `refold`, `pin`, `unpin`, `reboundary` and `unmark`. A session that never calls the tool still folds; it degrades into lossless hierarchical compaction.

## Results

One 64-stage assignment over the curl C repository, run as a single agentic turn. Same model, same 251,520-token serving budget, every run. After all 64 stages landed, one withheld message asked sixteen questions about material from across the whole session.

| Condition | Correct of 16 | Wrong | Cost | Fresh input | Cached input | Wall clock |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Compaction | 4 | 3 | $151.24 | 7.64M | 160.2M | 6.9h |
| Compaction + memory store | 14 | 0 | $201.70 | 9.65M | 231.7M | 9.0h |
| pi-fold, deterministic briefs | 11.3 avg | 3.5 avg | $93.65 | 5.74M | 91.2M | 4.6h |
| **pi-fold + memory store** | **14** | **0** | **$100.85** | **5.57M** | **102.2M** | **5.2h** |
| pi-fold, agent-written briefs | 3 | 9 | $111.96 | 7.12M | 108.8M | 5.4h |

*Fresh input is what the provider had to read for the first time; cached input is what it replayed. The deterministic-briefs row averages four runs that scored 14, 14, 9 and 8.*

Compare the two store-paired rows. Both scored 14 correct with none wrong, and folding cost half. That gap is request count rather than price: compaction needed roughly twice the provider requests for the same work, plus summarizer calls that never show up in its own ledger.

Compaction alone abstained nine times and was wrong three, so its dominant failure was declining rather than inventing, but it did invent. And the fold's deterministic runs are bimodal rather than average: two answered 14 with nothing wrong, two lost old material, and cost did not predict which. The store was tried once on each arm and both came back with nothing wrong, which is suggestive, not a rate.

Agent-written briefs scored worst of anything measured, which is why that invitation ships off.

Four papers with figure sources, redacted per-request ledgers and campaign logs are on Zenodo: [design and trace evaluation](https://doi.org/10.5281/zenodo.21856873), [working memory under context shedding](https://doi.org/10.5281/zenodo.21980746), [ephemeral retrieval](https://doi.org/10.5281/zenodo.22142454), and [rotation and retention](https://doi.org/10.5281/zenodo.22142456), which is the campaign above. Narrative versions on [Medium](https://medium.com/@shane.conner/a-compaction-summary-is-one-record-doing-a-stores-job-3f46212ef059), interactive versions at [shaneconner.com](https://shaneconner.com/projects/pi-fold/), and the full chronology in [the experiment log](https://github.com/shaneconner/fold/blob/main/docs/fold_vs_compaction/experiment-log.md).

## Limits

- **Native compaction is strong and is the right default for most sessions.** It needs no installation and no tool surface. This is an alternative for workflows where the numbers above matter, not a replacement.
- **The benchmark is narrow by construction.** It was built to reproduce specific things compaction handles badly, one to four runs per condition, and it says nothing about production behavior.
- **Folding is not a memory store.** It rotates transcript source out of the window; durable placement of what a session learned is a separate job, and the pairing is where the measured value sat.

## Configuration

`registerPiFold(pi)` works with no arguments, and the defaults are the configuration the campaign above actually ran: deterministic briefs, the invitation off, the tool-call diet at half the window, and a 0.80/0.20 band. Nothing here needs tuning.

The one thing worth adding is a long-term memory store. Rotation and retention are different jobs: folding gets stale material out of the window, a store keeps what the session learned. A handoff summary tries to do both in one record, written once under time pressure, bounded by the window it has to fit in. Folding is the rotation half and only that half.

Six options, and every other name is refused.

| Option | Default | Effect |
| --- | --- | --- |
| `thresholds` | `{ maxTarget: 0.80, minTarget: 0.20, consolidateAfter: 10, minFoldChars: 8000 }` | The band, set whole or not at all. The first two are proportions of the serving budget. `consolidateAfter` is how many visible roots a parent is owed. `minFoldChars` is the size a fold has to reach to be worth making, and the floor a gap between folds has to clear to stay raw. Validated atomically; an impossible policy is refused by name rather than clamped. |
| `providerInputBudget` | the transport's descriptor | The tokens this deployment may actually put in a request, already net of any output reservation. Every ratio, fence and budget on this page is a share of this one number. |
| `blacklistAutoFoldTools` | `new Set()` | The exception list. Every completed tool batch is foldable without an agent mark; name a tool here and its results stay raw. |
| `toolFoldThreshold` | `0.50` | The tool-call diet: a share in `[0, 1)` naming the oldest fraction of the window whose tool results are clipped in view. `0` turns it off. |
| `preCommitNotice` | `false` | The notice switch. False is the shape that won the campaign above: no carrier reaches the projection and every fold ships the runtime's own words. `true` states the window's status to the agent once per approach to a commit: where the commit fires, how far away it is, what is staged, what that frees, what is pinned and what the pin costs, with the verbs listed and no argument made for using any of them. |
| `noticeLeadShare` | `0.10` | How far below the commit trigger that notice speaks, as a share of the serving budget. A distance rather than a point, so it follows a band that moves. Read only when `preCommitNotice` is on. |

Four commands ship for the human: `/fold-status`, `/fold` (commit every staged mark now), `/fold-editor` (the interactive map of the window) and `/fold-settings` (edit the options above; each change is saved to `~/.config/pi-fold/settings.json` and takes effect in the running session).

## How it works

### The cache invariant

**A provider prefix cache is positional.** It replays the longest byte-identical prefix of the prompt, so one changed byte at offset K discards everything cached after K. The cost of a mutation has nothing to do with its size.

**So the runtime may move a byte in the window only at a moment it is already rewriting the window**, which is a commit or a fold. Everything else is a pure append, and an appended byte is never later altered, shortened, removed or repositioned. Never mutate the window, and never show something and then take it back. The second half is the one that costs features: anything that displays state and then updates it in place is out, because updating in place is a mid-prefix write with better manners.

### Marks and commits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/shaneconner/fold/main/media/marks-and-commits-dark.svg">
  <img alt="A completed unit becomes a pending mark that leaves the window and its cached prefix untouched. Marks repeat for free below maxTarget; at maxTarget one commit applies every standing mark in a single rewrite. From the brief, peek appends the exact bytes and expand restores them in place, both after verifying the SHA-256." src="https://raw.githubusercontent.com/shaneconner/fold/main/media/marks-and-commits-light.svg">
</picture>

A mark moves nothing. The moment a tool batch or chapter closes, the runtime cuts it into a pending mark, up to eight cuts per pass, stalest first. The mark lives in durable state outside the window, so the projection stays byte-identical and the cached prefix survives. Marks accumulate for free until one commit applies all of them in a single rewrite.

What the agent owns is the words. `brief` writes its own sentence onto a pending fold for free, because that brief reaches the window only when the commit writes the placeholder for the first time. A supplied brief is kept verbatim; an unbriefed fold commits with the deterministic brief the runtime writes from the span itself, and the provenance records which happened. Curation stays correctable until the commit: `reboundary` re-cuts a span, `unmark` withdraws a pending mark, and a pending brief can be rewritten any number of times at no cost. A standing fold's brief is never rewritten, because that rewrites the projection at its placeholder.

### The band

A commit fires on one condition: occupancy reaching `maxTarget` of the serving budget. It applies marks stalest first and stops at `minTarget`, so the newest events stay raw and a mark past the bound waits for the next epoch. Below `maxTarget` the window is quiet, because a commit is an epoch transition that risks the whole prefix cache and the right cadence is the fewest commits that keep the window inside its budget.

```
272,000  the transport's descriptor
─────────────────────────────────────────────────────
~250k    peak: inflow continues while the epoch computes
217,600  maxTarget 0.80   ← the commit fires here
   ⋮                        marks accumulate, free, quiet
 54,400  minTarget 0.20   ← the commit stops here
─────────────────────────────────────────────────────
```

Every commit re-reads roughly `minTarget` of the budget uncached, so a shallower cut buys less runway for nearly the same bill: the rewrite tax is `minTarget / (maxTarget - minTarget)`, 0.33 at 0.80/0.20 against 1.0 at 0.80/0.40.

### Peek and expand

`peek` returns a fold's exact SHA-256-verified source as a tool result at any depth, with the ancestors still collapsed. It appends and never edits the prefix, so checking what a fold holds costs nothing a commit has to pay for. It takes `offset` and `bytes` for a bounded slice and reads any child fold by id, so a large fold has a narrow read.

A peek is ephemeral by default: the bytes ride the window until the model's next message, then their place holds a one-line placeholder and the reply that used them is the surviving trace. Peeking again is lossless and costs one append. The default follows what the agent chose: on the run measured for it, six of seven peeks asked for ephemeral at first exposure. `expand` is the commitment, restoring the source in place until the fold is refolded. Looking is not the same as taking.

### Clipping, pins and the compaction path

Tool results get a second, lighter treatment at the same commit. Results in the oldest `toolFoldThreshold` share of the projected window, half of it by default, are clipped in view: the identifying head stays, the rest becomes a marker naming the entry id that peeks it back, and the stored bytes are untouched, so a later fold of that span still encodes the full result.

Briefs are bounded at 2,000 characters each, so the visible index normally costs a low single-digit share of the window. Folds nest rather than partially overlap, and collapsed folds double as a browsable index: `status` with `detail: "tree"` lists every fold in transcript order with its depth and parent. `pin` holds entries raw through every fold and frees nothing, so pinned mass makes the rest of the window fold sooner; a pinned-share cap stops that from becoming a window nothing can reclaim.

Pi's automatic compaction stays enabled underneath and is intercepted by kind. A threshold pass is cancelled, because the fold commit fires first. An overflow pass becomes an automated recovery: the session branches back to the last message before the error, and the retried pass folds and commits before transmitting. Manual `/compact` passes through untouched as the escape hatch.

Evidence ingestion writes read-only artifacts under the session directory's `pi-fold-evidence/` at mode `0444`, under a 512 MB session cap. It is always on: the artifacts are what an oversized result folds against, so a deployment that stopped writing them would keep its folds and lose what makes them lossless.

## Prior work

Two recent lines inform this one. Lossless hierarchical compaction, exemplified by LCM ([arXiv:2605.04050](https://arxiv.org/abs/2605.04050)) with a walkthrough at [losslesscontext.ai](https://www.losslesscontext.ai/), builds a summary DAG over older messages with lossless pointers to every original. Agentic context management, exemplified by [Letta](https://github.com/letta-ai/letta) and by [arXiv:2510.11967](https://arxiv.org/abs/2510.11967), gives the agent tools over its own memory. See also [arXiv:2607.00692](https://arxiv.org/abs/2607.00692).

What this one adds is an efficiency result, arrived at by running the mechanism repeatedly and following the bill. Rotation is the part every approach here shares. The cost sits in where the rewrites land, because a prefix cache charges by position rather than by size, so each fold is staged as a mark that moves nothing and one commit spends the cache for all of them at once. The same campaigns settled the recommended shape: deterministic briefs paired with a durable memory store, which held recall at the lowest cost and wall clock measured. Agent control over boundaries and brief text stays available, and the invitation to use it ships off.
