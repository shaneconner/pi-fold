# dsh-fold

Lossless context folding for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The oldest span of a conversation is replaced by a brief that says what it held, and the originals stay exactly where they were.

The same idea also ships as [`pi-fold`](https://www.npmjs.com/package/pi-fold) for Pi, where it carries its own store. Here it does not need one.

## Install

```sh
dsh plugin --profile web add dsh-fold
```

Restart `dsh` afterwards. Substitute your own profile name for `web`. The bundle disables `compaction-basic` and installs itself in its place, because the Harness admits one compaction implementation per context.

## Why this is a summarizer and not an engine

Compaction in the Harness is already lossless. A surface replace shadows the span it covers rather than deleting it: the original nodes stay in the append-only session log and remain reachable by their shadowed seqs. Everything pi-fold buys with a content-addressed store on disk is free here.

So the part worth replacing is not the mechanism. It is what the replacement node says.

`BasicCompactionEngine` names `summarize()` as its sole subclass hook and keeps the replay and durable mutation strategy fixed. fold overrides that one method and inherits the rest: pressure policy, retention, range selection, tool-pairing balance at both edges, the compaction lock, and the durable transaction. Those are the parts that must not diverge from the host, and a fold that reimplemented them would drift away from the seam it depends on.

The result is left unmarked, which the seam documents as a result that does not identify a call through the context's LLM seam. That is deliberate. Folding costs no tokens and makes no provider call, which is the whole economic argument for it, so nothing here may quietly start making one.

## What the brief says

A brief is an index of the span, not a retelling of it. It names two carriers in surface order:

**Tool results**, named by the tool that produced them, correlated back through the call id in the same span, so a subject says what ran and not only what came back.

**Agent notes**, meaning the leading paragraph of an assistant message. This is not decoration. A value the agent derives and records once, in its own words between two tool batches, reaches no other carrier at all: in the pi-fold measurement campaign two probes were lost to exactly that shape, because the index was built from neighbouring subjects and the recorded line reached none of them. So a note is a first-class subject rather than something a neighbour is trusted to mention. User messages ride for the same reason.

Subjects are then seated by division rather than concatenated and sliced. The room the lead leaves admits at most one subject per 24 characters, and every subject past that count is dropped **and counted in the tail**, so the brief never silently claims to be a full index. The characters are then divided over the subjects that did seat, ascending by length, so a short subject claims only what it needs and hands the rest back; that is what lets a note shorter than its fair share ride whole instead of being cut to an equal split. Any cut inside a seated subject ends in `...`, which means exactly one thing: content continues in the exact original.

The sentence saying the originals are recoverable is sized out of the budget up front rather than appended and sliced, because a brief that loses that sentence is worse than no brief.

## Configuration

Set options on the plugin entry in your profile. Everything `compaction-basic` accepts is accepted here.

```yaml
- id: compaction-basic
  disabled: true
- insert:
    - id: fold
      name: 'dsh-fold'
      config:
        # Characters the whole brief may occupy.
        maxBriefChars: 2000
```

## Differences from the Pi build

No store. The Harness session log already holds the originals, so fold does not open one.

No fold tool yet. Under Pi the agent can peek at a fold, expand it and refold it. The Harness surface supports the shape (a replace whose start and end index are equal is a legal one-for-one state swap, and tool results have a purpose-built content-only rewrite), so expand and refold are reachable here; what is lost is granularity, since one folded node returns as one node rather than as the several it hid.

## Development

`src/core/brief-text.ts` is a generated mirror of `extensions/lib/brief-text.ts` in the [fold repository](https://github.com/shaneconner/fold), synced by `scripts/sync-plugin-core.mjs` and pinned byte for byte by gate 164. Never edit it here. Edit the source, re-run the sync, and rebuild.

```sh
npm run check   # typecheck the adapter
npm run build   # emit lib/
```

## License

MIT
