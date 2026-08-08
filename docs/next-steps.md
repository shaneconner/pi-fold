# pi-fold: next steps

Queued work, recorded 2026-08-08. Ordering is not priority.

## Agent control surface

- **Pin and unpin expanded folds.** An agent that expands a fold has made a decision, and the
  ladder can currently refold it out from under that decision. Pinning makes the decision durable
  until the agent releases it.
- **Simplify the argument surface.** The action arguments were designed when a fold applied at the
  moment of the tool call. Folding is now an automated batch event, so several arguments describe
  a control the agent no longer exercises per call. Reduce them to what still means something.
- **A hook before the fold event.** Give the agent a last chance to mark spans before a commit
  fires, so the batch reflects its judgment rather than only the ladder's top-up.

## Thresholds, and who sets them

Expose a small set of window thresholds that either the user or the agent can set:

- **Max context window size.** The upper target: the occupancy that triggers a fold event.
- **Protected fresh tail.** A marked fold does not apply while its span is still inside this
  range, so recent work is never folded out from under the turn that is using it.
- **Stale tail.** Tool results and unpinned folds inside this range are eligible to fold.
- **Max post-fold window size.** The lower target: how small the window must be after a fold event.
  This is what decides how much folds automatically when the agent's own marks do not free enough.

## User control

- **User triggered fold events**, with the thresholds above settable at the same time.

## Observability

- **Instrument tool call usage** so errors, low usage, and problematic outcomes are visible.
  The rep-23 finding that the agent never called the context tool at all was discovered by hand,
  after the run. That should have been a reported number.

## Surfacing

- **Surface potentially relevant folds to the agent.** This was built and it worked, but the
  delivery mechanism was an ephemeral tail message, and in the Codex implementation those mutated
  the context window on every pass despite sitting at the tail. A slate shown once and withdrawn
  next pass is a show-then-retract: the bytes occupy prefix positions in one request and different
  bytes occupy them in the next, so the cached prefix dies. It was removed for that reason, not
  because the idea was wrong. Any future version has to deliver a suggestion without the window
  changing underneath it, which likely means the marks live outside the window and land at a fold
  event.

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
