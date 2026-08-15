# pi-fold: post-2.0 release and research queue

Recorded 2026-08-15 after the protocol-v4 hidden-mass campaign closed. Git
history holds the longer design queue and every mechanism that shipped or was
deleted.

## Current stop

The campaign stops at two assigned attempts per arm. pi-fold completed two of
two; native completed zero of two after compaction lost a different continuation
key in each attempt. Launching native runs until one survived would condition the
comparison on success. No further provider run belongs to this campaign.

No new folding mechanism is promoted. The release candidate is the measured
runtime plus release hardening, migration notes, and the portable result extract.

## Release order

1. Tag the exact green commit as `v2.0.0` and create the GitHub release from its
   migration notes and result boundaries.
2. Let Shane publish the same commit to npm. The tarball version, lockfile and
   citation metadata must all read `2.0.0` before that step.
3. Reserve the follow-up Zenodo DOI, then write that identifier into the paper
   and citation metadata. Do not invent or prefill a DOI.
4. Publish the follow-up paper from
   `docs/fold_vs_compaction/hidden-mass-results.json`, not from copied numbers in
   the experiment log.

The paper's primary outcomes are attempt-level completion and record-time join
endpoints. The pi-fold end-block result is secondary and explicitly
recovery-assisted. There is no direct native end-block score, no cost ratio from
this campaign, and no population failure-rate estimate from two attempts.

## One later experiment worth doing

After the release and paper, preregister a fixed attempt count on a different
repository workload and model family, keep transcript-only seeded values, and
retain completion as a treatment outcome. Promotion requires the completion and
record-time endpoint directions to repeat without selecting a surviving native
run. A failed direction is a stop signal, not a prompt for mechanism work.

## Parked product questions

These are not 2.0 blockers and have no promoted build:

- Record fold-side recovery when an already fenced retry aborts before the
  projection budget runs.
- Decide how exact evidence ingestion should handle one message that exceeds the
  serving budget by itself.
- Reduce action arguments that no longer describe agent control under epoch
  scheduling.

Each waits for a named failure, one mechanism, and a gate before implementation.
