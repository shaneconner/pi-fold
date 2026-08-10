# pi-fold: next steps

Queued work, recorded 2026-08-10. Ordering is not priority. Entries from earlier
revisions of this file that shipped (the durable pin, the pre-commit last call, the
exposed thresholds, the user-triggered fold event, tool-usage instrumentation, and
the surfacing slate) left the list with their builds; git history holds them.

## Overflow recovery

- **The fold-side record at the hard fence.** A session already parked at the
  provider-window fence aborts the retried pass before the projection budget runs,
  so an armed rollback there leaves no fold-side recovery record, and the
  adjudication lens counts the episode as a rollback without recovery. The terminal
  behavior is right either way; what is missing is the record. The fix is one
  ordering decision, letting the rejection-armed pass reach the projection budget
  before the lagging abort, with a gate asserting a fold-side record for every
  armed rollback.
- **The giant message.** After a rollback and a full commit, the triggering message
  alone can still exceed the budget. Candidate shape: ingest the oversized message
  as evidence and fold it on arrival, so the window carries its brief and the exact
  bytes stay one peek away.
- **An attempt cap.** Pi retries a rejected request once. Decide what the lane does
  when the retry overflows again, rather than inheriting the one-shot by accident.

## Agent control surface

- **Simplify the argument surface.** The action arguments were designed when a fold applied at the
  moment of the tool call. Folding is now an automated batch event, so several arguments describe
  a control the agent no longer exercises per call. Reduce them to what still means something.

## Fold interiors

- **Auto-fold what a folded span contains.** (Shane, 2026-08-08.) When a span folds, the tool
  results and any unpinned folds inside it should collapse too, so that expanding the outer fold
  one level returns structure (briefs of the units inside) rather than every raw byte the span
  ever held. Expand is already outside-in one level at a time; this makes the levels real at fold
  time instead of only at consolidation time. The natural default is tool results always, since
  they are the mass (see the peek-mass finding), with sub-span briefs only where a unit boundary
  already exists. Marking gives this for free: when a span is marked, mark its interior tool
  results too, and the whole structure lands in the same commit, so it costs zero extra rewrites.
  Not an argument surface (Shane, 2026-08-08): every fold already carries an ID, and peek on an
  ID returns just that fold's source as a tool result at any depth, which stays the deep-read
  path. Expand stays limited to briefs present in the current window. The open design question
  is deep expand in place: expanding a nested fold's ID directly at its own depth, with
  everything above it staying folded. Needs thinking out before it becomes a build.

## Measurement

- **A new experiment design for transcript recall.** The current probes ask about repository facts,
  which are re-derivable by rereading the repo, so they do not discriminate context loss. Probe
  instead against facts that exist only in the earlier conversation. Fix the known harness defects
  first: the file line count is reported as `split("\n").length`, one more than `wc -l`, and one
  symbol-file probe has a defensible wrong answer. Both change the plan hash, so they force a new
  baseline.
- **Grade the slate in the field.** The surfacing slate ships fully instrumented: every
  suggestion is graded acted, used, or ignored, and the harness reads first-hop peek precision
  per arm. The memex fold-lane accept rate of 2.2 percent is the floor the mechanism exists to
  beat, and the next campaign carries that comparison.
