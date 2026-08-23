# Steer protocol (v1)

The measurement protocol that replaces staged probes. Authored 2026-08-22.

## What changed and why

Protocol v4 scripted both halves of the session. A stage tool delivered work, the agent
answered a probe, and a grader parsed the answer out of prose. That made the session
artificial and the grading fragile at the same time, and the two faults compounded: the
only way to keep grading tractable was to keep the session unnatural.

The steer protocol scripts the user side and leaves the agent side free. User turns are
authored, fixed, and byte-identical across arms and reps. What the agent does in response
is its own. This is the shape of a real session: the human's half is what it is, the
agent's half varies. Obligations are keyed to user turns, so transcripts may diverge
without the grading diverging.

Nothing is graded from prose. Every measurement is an assertion against the filesystem
the agent worked in.

## The session

A generated project, `driftwood`, a log ingestion and alerting service in TypeScript.
The checkout is deterministic and identical for both arms. The agent is given ordinary
maintenance and feature work. Volume comes from real reading, editing and test runs,
which is also what makes the folded material realistic.

A driver delivers the authored user turns in order. It never says the word remember, it
never names a test, and it never asks the agent to keep track of anything. Gate 62's
instruction scan extends over every steer's text.

## The clobber

The spine of the measurement. At a designated steer the driver overwrites
`config/driftwood.toml` with the pristine shipped defaults and the user says so plainly,
as a person who clobbered a file would. Every setting decided across the whole session
has to be restored from record, because the crutch is gone for real.

This is why config values carry the weight. An agent that writes a value down early does
not need to recall it, so a stated-once-written-early value measures nothing. After the
clobber it measures everything.

## The crutch rule

Any artifact the agent maintains that records decisions is a memory aid, and it destroys
what this protocol measures. No ADR directory, no decisions log, no notes file, and no
changelog, however normal that is on a real project. No steer may ask for one.

The same rule one layer down: a decided value must not be recoverable from the checkout.
Every decided value differs from the shipped default, and the validator refuses a plan
where any decided key and value appear together in a generated source file. Otherwise the
agent greps its way past both arms and the experiment measures nothing.

## Obligation kinds

An obligation is a deterministic assertion. Grading folds the obligations in steer order
and compares against the tree the run left behind.

- `config` a key in a TOML file holds a value. Carries `supersedes` when it replaces an
  earlier steer's value, and `restoresFrom` when the steer's own text does not name the
  value and the agent must recover it from the superseded steer.
- `convention` a named rule holds over every file matching a glob that the run created or
  modified after a given steer. Rules are functions, not patterns in JSON.
- `absence` no file matching a glob exists, and no listed dependency appears in the
  manifest. This is how negative space is measured.
- `manifest` a manifest path equals a pinned value.
- `selfConsistent` a value in the final tree stands in a named relation to a value the
  agent itself produced earlier. No ground truth of ours is involved.

## Trap taxonomy

Six kinds, each measured by an obligation above.

1. **Standing convention.** Stated once, governs everything after, never restated. Caught
   by `convention` on files written hundreds of thousands of tokens later.
2. **Supersession.** A value stated, then changed. Correct answer is the later one. Tests
   ordering rather than presence.
3. **Restoration.** X, then Y, then back to X, where the restoring steer does NOT name the
   number. Presence of X is no longer evidence: a last-value-wins summary holds Y and
   cannot answer at all.
4. **Negative space.** A prohibition stated once, then a later task whose obvious solution
   violates it. Measured by `absence`.
5. **Rejected alternative.** A choice made once with a reason, recurring later in a
   different module. Measured by `config` plus `absence` of the rejected mechanism.
6. **Self-contradiction.** The agent's own earlier output is the ground truth. Measured by
   `selfConsistent`, which is why it needs nothing from us to be gradable.

## Grading

Per obligation: `met`, `unmet`, or `asked`. The third exists because an agent that says it
has lost a setting and asks for it is behaving honestly, and scoring that as a pass would
flatter the system while scoring it as a plain miss would misreport what happened. It is
counted and reported separately, never folded into either.

Recovery cost rides the shared recovery-window lens: peeks, expands and re-reads between
the steer and the obligation being met, plus distance to the last reset (compaction for
native, committed fold epoch for pifold).

## What carries over from v4

Gate 62's test-awareness scan, now over steer text. Gate 67's out-of-checkout read
refusal. Gate 70's collision discipline, restated as the crutch rule above. Gate 72's
resume progress bound. Gate 55's rescued worker report. The arm-symmetric worker.

## What is retired

The stage tool and its NEXT_KEY pull loop, the reconstruction table, the checksum singles,
the three-hop ledger with its record-and-echo protocol, and the withheld end block. All of
it existed to make prose gradable, and the filesystem does that job without any of it.

## Scale (v2 plan, 2026-08-22)

The v1 plan ran once, as native rep1: 72 steers, 72 delivered, 29 minutes, 0 deflections,
28 of 32 obligations met. It measured nothing about the question, because the session
reached roughly 67,400 model-visible tokens against a 251,520 serving budget and Pi never
compacted. A run in which neither arm sheds is a control, not a treatment.

The first repair attempted was a smaller serving budget, and it was wrong. A 40,000-token
window is not a configuration anyone deploys, and at that size a single file read is a
large fraction of the window, so the agent stops doing work and starts managing its
context. That is a different system from the one under test. The budget stays at 251,520
against the 272,000-token descriptor, and the workload grows instead.

Where the tokens actually came from in rep1, measured from the sealed session:

| source | chars | share |
| --- | --- | --- |
| tool results | 221,496 | 82.1% |
| assistant text | 29,619 | 11.0% |
| thinking | 12,052 | 4.5% |
| user steers | 6,030 | 2.2% |
| tool call arguments | 542 | 0.2% |

Tool output is the whole budget, and inside it `bash` was 158,573 against `read` at
58,305. Steer count is not the lever and prose is not the lever. Breadth is: an operation
that walks a family costs what the family costs.

So v2 grows the world and the work, and freezes the instrument.

**The checkout** goes from 171 files and 175,741 bytes to 560 files and 674,017 bytes. The
six families are grown from a cross product rather than hand listed, because a log service
carrying 150 parsers and 110 alert conditions is the ordinary case: formats 40 to 150,
conditions 30 to 110, enrichers 25 to 90, codecs 20 to 75, sources 12 to 45, routes 15 to
55. Generation stays deterministic and seedless in the names, so every arm and every rep
gets a byte-identical tree.

One name had to be refused. The codec cross product produced `index_cache`, and steer-026
forbids `src/**/*cache*` for the rest of the session. A pristine checkout that violates an
absence obligation on turn one makes that trap unscorable, so the `cache` component became
`column`.

**The suite** goes from 9 tests to 534, generated per item alongside the estate it covers,
and one run now emits 31,075 chars. That single number is the largest lever in the build.
It lands in `tests/`, the legacy directory, on purpose: the convention steer at steer-021
tells the agent to put tests beside the source, and a tree that demonstrates the new
pattern would let an agent that lost the steer recover it by imitation. The repo has to
demonstrate the pattern the session is migrating away from.

**The plan** goes from 72 steers to 271, and not one authored steer changes. All 32
obligations, all six trap types, the clobber and the expected final config carry across
byte-identical; what is added is 199 steers of ordinary work between them, weighted 101
surveys, 46 suite runs, 52 single reads. The added text is generated from templates over
the estate and passes the same crutch and awareness scans as the authored steers.

What that buys is distance, which is the thing the traps are actually made of:

| span | v1 | v2 | what it tests |
| --- | --- | --- | --- |
| steer-023 to steer-070 | 47 | 196 | sweep_batch decided, compactor derives it |
| steer-018 to steer-066 | 48 | 191 | pipeline order captured, enrich_geo added |
| steer-006 to steer-063 | 57 | 209 | snake_case stated, then the clobber |
| steer-026 to steer-060 | 34 | 137 | no-cache stated, then re-tested |

The first two spans are exactly the two obligations rep1 lost.

Projected cumulative content is roughly 3.18M chars, near 795,000 tokens, from 46 suite
runs at 31,075 chars, 101 surveys at roughly 12,000, 52 reads at roughly 2,500, and the
assistant text between them. Against a trigger at 201,216 with each shed freeing roughly
half the window, that is about six sheds per arm. It is a projection from measured
component sizes, not a measurement, and the native arm settles it.

`driftwood-session-v1.json` stays where it is. rep1 was graded against it and its
provenance should remain readable; v2 is selected with `--plan` rather than by replacing
the default.
