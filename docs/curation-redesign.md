# Curation redesign: the runtime cuts, the agent edits

Shane, 2026-08-23. This replaces the ask-the-agent-to-mark design with an
annotate-what-was-already-cut design. It is a developer change, not a research one: the
measurements that motivated it are done, and what follows is the shape and the removals.

## Why

Three measurements from the 2026-08-23 counterfactual sweep, run against real compaction
boundaries in sessions already on disk:

1. **Agent marking changed nothing.** Asked at the commit boundary with the runtime's own
   advisory standing, an agent marked six spans with 9,450 characters of briefs and produced
   a projection byte-identical to the same arm with no agent at all: same visible count, same
   fold count, same aborts. It marks what the ladder would have taken anyway.
2. **The ask can silently never fire.** With the deep commit path running, the steward band
   never opened at any boundary in a three-boundary session, so the agent was never invited
   once. A mechanism whose failure mode is doing nothing quietly is not one to keep.
3. **Nothing supports fresh-tail protection.** It was the leading hypothesis for a cadence
   effect and direct measurement refuted it: commit count does not move with cadence at all.

The diagnosis is not that agents cannot curate. It is that they are asked at the wrong
moment, about material they saw long ago, when the only information available is staleness,
which the runtime already has. The agent's advantage is knowing what mattered, and it has
that when the content is fresh.

## The new shape

### 1. The runtime cuts continuously, behind the agent

A fold frontier tracks the last position covered by a fold. As work completes, raw context
accumulates between the frontier and the head of the window. When that exceeds
`minFoldChars`, the runtime creates a fold over that range and advances the frontier.

Creation is not application. A created fold is a pending mark, and pending marks are
byte-inert: nothing moves, the projection does not change, the prefix cache is untouched.
This is the existing epoch model and needs no new machinery. The agent keeps seeing the raw
material until a commit actually applies the fold.

### 2. The agent is told, and invited to brief

When folds are created the agent gets an ephemeral notice naming them: this fold covers these
messages, this many tokens, no brief yet. It is invited to add one. The notice rides a single
turn, the way an ephemeral peek does, so it never accumulates.

The invitation is batched rather than continuous: it appears when unbriefed folds reach a
threshold, not on every cut. A notice per fold would be noise, and noise is how guidance gets
ignored.

### 3. Briefs never touch the window

A brief supplied for a pending fold is stored in state and rendered nowhere. It reaches the
projection only when the fold is applied at commit, at which point that placeholder is being
written for the first time anyway. So annotating costs nothing in the window and invalidates
no prefix cache. This is already true of mark briefs today and is stated here because it is
the property the design depends on.

### 4. The commit applies only as deep as it needs

At the epoch, pending folds are applied stalest first, only until the min target is reached.
Whatever is not needed stays pending, still annotatable, still editable. The window is never
cut deeper than the budget requires, and material the agent may still want stays raw for as
long as there is room for it.

### 5. Consolidation is announced the same way

When standing folds reach `consolidateAfter`, they are marked for consolidation at the next
commit and the agent is told, with the same invitation to brief the parent that will absorb
them. Same carrier, same ephemerality, same batching.

### 6. The tool edits rather than creates

The agent no longer chooses spans from nothing. It adjusts what the runtime already cut:

- `brief` attaches or replaces the brief on a pending fold.
- `reboundary` re-cuts a span, merging or splitting what the runtime chose.
- `unmark` withdraws a pending fold that should not be taken.
- `peek`, `expand`, `refold`, `pin`, `unpin`, `status` are unchanged.

`fold` as a create-a-mark action is removed.

## What comes out

Aggressively, because the point of a redesign is to leave less behind than it found:

| removed | why |
|---|---|
| `thresholds.freshTail`, its validation, its settings row, its zone arithmetic | Nothing supports it. Stalest-first ordering plus the band already keep recent material last in line, and a created fold is inert until commit, so the agent still sees fresh material regardless. |
| the steward band: `STEWARD_WARNING_SHARE`, `stewardReading`, `appendSteward`, the steward projection carrier, `context.steward` | The ask moves to fold time. A band that exists to time a pre-commit invitation has nothing left to time. |
| `stewardAdvisoryText` | Its whole content is a pre-commit invitation to create marks. |
| `contextRiderText` and the rider carrier | Same: a post-commit invitation to create marks. Replaced by the post-fold notice. |
| the `guidance` option and `guidance.actionResponses` | The guidance it switched is being replaced wholesale. |
| the `fold` tool action and its bulk `marks` array | The runtime does the cutting. |

Retired gate numbers stay spent. Behaviour that is removed loses its gate; behaviour that is
added lands with one.

## The suite itself is over-grown

Shane, 2026-08-23: at most 50 gates, and the slowest justify themselves hardest. The suite
now times every gate and prints the slowest twelve, because a gate earns its wall clock the
same way it earns its existence, by what it would catch.

The starting position was 110 gates in 232 seconds, and four of them were 61% of that.
Gate 98's 65.9 seconds turned out to be the instrument's first catch: it built the most
expensive fixture in the suite and its per-fold audit loop ran zero times, so it was
proving nothing at any price. After stages 1 to 6 the position is 97 gates in 304 seconds:

| gate | seconds | share | asserts/s | name |
|---|---|---|---|---|
| 58 | 67.9 | 22.3% | 0.5 | Fence margin, calibration recency & commit depth |
| 50 | 45.6 | 15.0% | 0.9 | Projection instrumentation |
| 12 | 41.3 | 13.6% | 3.4 | B2 expand leases |
| 81 | 24.5 | 8.1% | 1.7 | Status pages are bounded |
| 89 | 20.7 | 6.8% | 0.8 | Protect is a durable pin |

Assertions per second is the second instrument and it reads across the suite: gate 67
proves 1,465 things in 12.9 seconds and gate 58 proves 35 in 67.9. A gate at the bottom of
that column is either building a fixture far larger than its claim needs or asserting far
less than its fixture supports, and both are worth knowing before deciding what to cut.

### Where it landed

**43 gates, 4,536 assertions, about 200 seconds.** The assertion count is unchanged from
the 97-gate suite: nothing was dropped, twenty-seven families were merged into one gate
each, and every retired number stays spent. Merging is on one rule, that the sections
prove ONE law and differ only in how it can break: the append-only family is a tool call
that mutates, a standing fact that moves, a second structural mutation in one handoff and
a rewrite nothing accounts for, which is four ways to lose the same property.

Merging costs resolution, so the suite now times each SECTION as well as each gate and
prints both tables. That is the instrument that found the rest:

| what | was | now | why |
|---|---|---|---|
| gate 58's deep-commit section | 61.6s | 9.0s | Its trigger is a DECLARED occupancy, so the 30-turn 12,000-char fixture was projecting 360,000 characters per cycle to prove a ratchet that needs only enough stale mass to reach. |
| gate 50's page-trim probe | 41.4s | 4.7s | Ninety projections over the 14-turn folded fixture, to prove a status page trims. A projection record is the same size whatever it summarizes, so it runs on a 2-turn runtime now. |
| gate 12's lease-cap loop | 40.9s | 11.3s | It materialized durable state once per iteration to re-read parentage, and materializing replays the whole branch, which grows by a state entry on every expand. Quadratic in the harness, not in the runtime. The fence refusal already carries the same information. |
| the frontier itself | 137ms/pass | skipped | Not a test change. Exhausting the selector costs a window scan per staged cut plus one to come back empty, and once everything foldable is staged every later pass paid that last scan for an answer that could not have changed. |

Two gates were examined and left alone, which is the instrument working in the other
direction: the pinned-mass claim needs two committed roots and its fixture is at the floor
that produces them, and the status paging claim needs ten folds, which needs mass, because
a batch under `minFoldChars` is not cut at all. Both are slow because their subject is.

Consolidation runs on the same rule as the code: a gate whose subject another gate already
pins is deleted rather than kept for completeness, and a gate that costs a minute to prove
something a cheaper fixture proves is rewritten or dropped. Retired numbers stay spent.

## Order of work

Each stage leaves the suite green.

1. Remove fresh-tail. Self-contained: policy, settings, transcript, folding.
2. Remove the steward band and the rider, with their carriers and events.
3. Add the fold frontier and proactive creation.
4. Add the post-fold notice and its batching.
5. Move the tool surface from create to edit.
6. Consolidation announcement.

## What stages 1 to 6 actually built

Written down because several of these are decisions the design above did not anticipate,
and the reasons are worth more than the code.

**The frontier is a selector loop, not a pointer.** `frontierMarks()` exhausts
`selectAutomaticSpan` on every projection pass and stages each candidate stalest first.
There is no "last position covered", because the ladder's own selector already answers
"what is the next thing worth folding" and a second definition of the frontier would drift
from it. The `minFoldChars` threshold therefore stays in the selector, which is where the
first cut of this got it wrong: it gated on the tool-only unmarked remainder and never
fired at all on a chapter-heavy session.

**Cuts write no persistence boundary of their own.** A cut is derived from its span, so a
restart re-cuts identical spans with identical ids, and the only thing that must survive is
a brief the agent wrote, which its own action persists. Persisting at the frontier instead
cost a durable write per projection pass and its branch entry rebuilt the projection, which
gates 110 and 111 caught as an occupancy anchor that had stopped reading the provider's own
count.

**Eight cuts per pass.** `MAX_FRONTIER_CUTS_PER_PASS` exists because the frontier rescans
the window per cut, which is quadratic in the pass: gate 64's 300-turn fixture went from
152 seconds to 5.3. Nothing is lost, because the next pass continues from where this one
stopped.

**The notice is an append, and a snapshot.** It is admitted once per frozen projection
through `carrierAdmitted`, so material arriving afterwards lands after it and the prefix in
front of it never moves. The first cut withdrew and re-pushed it at the tail every pass,
which moved the byte at its old index on a pass where nothing else had, and gates 110 and
111 read the whole projection as rewritten. The cost of that choice is that cuts staged
after the notice spoke wait for the next pass that rebuilds the projection anyway. The
trade is deliberate: an occupancy anchor is worth more than a fold id arriving one epoch
early. It never asks twice for a brief the agent has written, because the rebuild reads the
marks rather than its own last text.

**The notice seats its instruction first and lets the list give way.** `FOLD_NOTICE_BYTES`
is 1,200 and seats eight folds whole; past that the list states how many it could not name
and points at status. The first cut put the ids in the opening line and handed the whole
string to one bound, so a seven-fold batch spent its budget on ids and lost "writing this
costs your window nothing" off the end, which is the only fact in the notice the agent
cannot work out for itself.

**The commit is depth-bounded on the routine path only.** Once the frontier stages
everything, a commit that applied every pending mark would cut the window to the floor on
its first firing. `commitPendingMarks` takes an `applyTargetBytes` and stops at it, stalest
first, retaining rather than refusing what it does not reach. The bound is passed only by
`enforceBandTop`, never by the fence or the compaction boundary: those two carry a waiver
and own an emergency, and an emergency that stops at a target is not one.

**The band top is edge-triggered per measurement.** A depth-bounded commit at a parked
window fires a slice per projection pass forever, so `enforceBandTop` now commits once per
crossing of its own measurement rather than once per pass.

**Status carries `pendingFolds`.** The agent is told what was cut in the notice, but a
notice is a snapshot and the agent needs the live list to answer from. It reads from live
state, which also makes the frontier observable to the suite: cuts are derived and write
no record, so `materialized()` cannot see one until a brief or a commit carries it forward.

**Gate 141's law is inverted, and that is the point.** It used to read "the ladder stages
nothing until commit", which was correct while the agent chose spans: staging early would
have pre-empted the choice. The agent no longer chooses spans, so the same gate now reads
"the frontier cuts as material arrives; the commit fills what the agent left". The branch
name `ladder-stand-down` is now the opposite of what shipped.

## The sealed campaign, and how it was made readable again

Deleting the rider took its wire parsing with it, and every active-context state the
sol-20260815-hidden campaign sealed carries a rider key. The first re-extraction came back
with 102 rows of `state-unreadable` and every carriage finding zeroed, and the first
response to that was wrong: it treated the artifact as frozen and softened the binding to
a recorded reason. The corpus being unreadable is a defect, not a fact to record.

Two things were actually broken, and the rider was only one of them.

**The state digest, not the schema.** `semanticStateSha256` hashes the materialized state
object and the canonicalizer walks own keys in insertion order, so a field that is gone
changes the digest even though it changed nothing else. That is the whole of what the
rider touched on a load: no fold, no ref, no brief. So it is read, spent on the digest
through `legacyRiderStateSha256`, and dropped, joining the two legacy derivations already
living beside it for exactly this reason. The rider therefore comes off the retired-field
list: that refusal's own reason is a state the build cannot reproduce, and the list keeps
the fields that carried behaviour.

A delta names its base by the digest the base ENTRY recorded, so a legacy-written chain
needs both readings: the modern digest, for what this build writes next, and the written
one, for what the next entry will name. Carrying only the written one broke the pre-phase-A
migration, because the runtime's own next delta names the modern digest and its own write
then read as a broken chain. Both are carried, and the second is null whenever they agree,
which is every state this build wrote itself. That also closed a latent gap for the two
older legacy derivations.

**A predicate the lens still named.** `toolRefsProtected` was the fresh-tail aware variant
for tool-result folds. Fresh-tail protection is deleted and the runtime collapsed every
call site onto `refsProtected`, so the carriage lens does too, which is the only way it
keeps composing the runtime's own reading rather than drifting from it.

The result: the re-extraction is **byte-identical to the published body**, with only
`runtimeTreeSha256` and `attributionHelperSha256` moving, which is exactly what the law
permits. That also measures two things worth having: the rider was inert for attribution,
and the fresh-tail collapse changed nothing about what was visible in 102 sealed probes.
The binding stays one equality.

## One finding to carry forward

`unmarkedRemainder` enumerates `automaticToolBatches` only, while `selectAutomaticSpan`
also proposes chapters. On a chapter-heavy session the remainder therefore under-reports
what is actually foldable. This is pre-existing, it is what broke the frontier's first cut,
and gate 106 records it rather than papering over it. Fixed the day after this was written:
the remainder now walks `selectAutomaticChapter` alongside the tool batches, and gate 141's
`remainderCountsChapters` claim pins a chapter-only session reporting 27 spans and 137,813
chars where the old definition reported zero.

## The thermostat, retuned to the corpus (2026-08-23)

Shane asked for a working band of roughly 100k to 250k tokens on the Codex Sol window.
The window was verified first: the descriptor is 272,000 and Pi derives the output ceiling
from it, the provider's real wall sits just above 372,000, and past 272,000 every request
bills at 2x input and 1.5x output, so 272,000 is a price cliff rather than a wall and the
band has to live under it.

Read against the 19 mature sealed pifold runs sharing the 251,520-token budget, the top of
the band was already delivered: the 0.80 trigger fires at 201,216 and the session runs a
median 36,000 tokens past it before the commit lands, peaking at a median 237,399 and a p90
of 247,551. Raising `maxTarget` toward 250k directly would have pushed the median peak over
the budget and into the fence. So the trigger stays at 0.80 and the overshoot is the
mechanism that reaches 250k.

The floor was the miss: 153 of 206 commit landings came to rest below 100,000 tokens, at a
median of 79,034, because the 0.20 aim sat far under the requested band and under
`MAX_PINNED_SHARE` besides, so a fully pinned session could never legally reach it.
`minTarget` moves 0.20 to 0.40, which is 102,246 tokens against the default descriptor.
Landings sit above the aim, so the observed floor lands near 100k rather than at 40% exactly.
The cost is the 2026-08-14 cadence argument running backwards, about a fifth more epochs for
the same session shape, bought deliberately: the floor is what holds 100k of raw recent
context across the whole cycle.

## The guard falls to the first live session (2026-08-23)

The redesign's first live run (sol-20260823-live, pifold rep 1, sandboxed, budget
251,520) caught what every suite fixture missed because fixtures close turns. The
workload is one user message and then tool calls all the way down; every assistant
response stops with toolUse, so the last terminal stop never advances and the
current-turn guard read the ENTIRE session as the open turn. Four band-top commits fired
at 208,234 / 225,906 / 236,742 / 241,394 tokens and each applied zero of its 15 to 18
marks. Occupancy rode to 240,948, 0.958 of budget, and the projection fence, which
waives the guard and carries no depth bound because it is an emergency, swept all 18
marks to a 7,908-token landing against the 100,608 aim. The sawtooth then repeated:
climb to the fence, sweep to near zero, five cycles observed. The old runtime survived
this shape only through last-call, which the redesign had deleted without replacing the
one duty it performed here.

Shane's ruling: "you're using turns as the boundaries, which should not be the case. It
should be at the most granular level, which is events." The current-turn guard and its
waiver machinery are deleted outright rather than re-scoped: markTouchesCurrentTurn,
currentTurnRefKeys, currentTurnBoundary, guardWaiverCount and both waiver constants are
gone, the manual-span clamp that snapped a user's span back to the last closed turn is
gone with them, and the class law's holds are now pinned and blacklisted alone. What
protects the working set is structural and event-level: an incomplete batch is never
proposable, the depth bound stops the routine commit at the aim, and the stalest-first
cut order leaves the newest events raw.

Deleting the guard exposed one real leak the guard had been masking: the closing
consolidation pass reruns the commit unbounded to seat parents on the same paid rewrite,
and the marks the depth cut had just retained were still pending, so the first unguarded
band-top commit folded all 24 fixture marks to the floor. The closing pass now commits
only the parents it seats, with the held-back marks set aside and restored.

Gate 09's open-turn claim now asserts the exact opposite of its guard-era text on the
same fixture: the band top itself applies (14 of 24, one a consolidation parent), stops
at the aim with shortfall zero, retains 11 by depth, keeps the newest batch raw and folds
the oldest. It fails on the pre-fix runtime with the live run's exact symptom, applied 0.
Gate 130 became "A boundary commits rather than no-op", gate 56's waiver-order fixture
became the depth-cut-order fixture with the same anti-digest concern, and gate 32's
held-parent deferral runs on a pin, the hold that remains.
