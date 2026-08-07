# Pi active-context production postmortem

Written 2026-08-01 against the first production rollout of the active-context runtime, which ran inside a consumer deployment branded `quorum`. The runtime is what later became the pi-fold package; the `quorum_context` tool name, the `Quorum` brand noun and the Luna chapter naming are that deployment's identity, preserved here because renaming them would falsify the record of what the session actually contained. This is the direct lineage of the guidance re-arming and guided-curation work: every "required policy change" below became a mechanism.

Snapshot report: `report.json` SHA-256 `165804889e644b18291eeabd70232e6ff290467ed7d41f5979709cd6f9980731`. The report itself, and the session it audits, are in the sealed archive recorded in `experiment-log.md`; they are not carried in this repo.

The report is a selected-branch audit of the canonical Pi session. Its epoch markers prevent historic native compactions from being mixed with the active-context rollout or the incident recoveries.

## Executive finding

The system succeeded when the model acted on guidance and failed when automatic fallback carried the workload. Automated chapters must remain an exceptional safety mechanism, not a normal rung we try to exercise. The acceptance target is:

- stock Pi automatic compaction: **0**;
- Quorum final-rung Luna chapters during normal operation: **0**;
- model-origin folds after ordinary extension guidance: repeated and causally receipted;
- pressure stays below the 75% deterministic fallback rung;
- an automatic fallback, if ever used, is surfaced to the model on the next safe context with an explicit suggestion to act earlier.

## Denominators

| Scope | `quorum_context` calls | Results | Fold records | Guidance | Native compactions |
|---|---:|---:|---:|---:|---:|
| Whole selected branch | 213 | 191 success / 21 error / 1 missing | 64 | 12 milestones / 4 actions | 48 historic |
| Active-context rollout | 64 | 59 success / 5 error | 64 | 12 milestones / 4 actions | 8 |
| Orphan incident recovery | 2 | 1 success / 1 error | 4 automatic | 0 | 1 explicit rescue |
| First→second rescue | 12 | 12 success | 5 supplied/model chapters | 5 milestones / 4 actions | 1 explicit rescue |
| Second→third rescue, gate off | 0 | 0 | 0 | 0 | 1 explicit rescue |

The active rollout's 64 records were internally complete: every unique record had exactly one state addition and there were no missing or orphan records. Shapes were 24 supplied chapters, 35 deterministic stale tool-result folds, 2 deterministic consolidations, and 3 Luna chapters.

## Incident

Assistant `8d8327e7` ended with `stopReason:"length"` while carrying a tool call. Automatic chapter `fold_e04524812f9fe5a5e735c559` selected that assistant but not matching error result `dece9224`. OpenAI then rejected the orphan result with `No tool call found for function call output`.

The production session reached 297,105/272,000 before the first explicit rescue. Subsequent recovery reached 310,791 before the second rescue. With registration deliberately disabled during repair, the continuing task reached 250,456 and required a third explicit `/compact`; that third event is containment evidence, not a policy failure from the repaired runtime.

## Active management versus fallback

`quorum_context fold` was called 29 times during the rollout: 24 succeeded and 5 failed. Those 24 successful supplied/model chapters are the useful numerator for proactive action. Automatic work produced 35 stale-tool folds, 2 consolidations, and 3 final-rung Luna chapters. The ratio is therefore 24 model folds versus 40 automatic reductions; automatic work dominated and final-rung use was non-zero.

After the first rescue, behavior improved sharply: five supplied folds succeeded, four were bound to guidance-action receipts, and no automatic fold occurred before the second rescue. That is the desired operating shape. The second rescue followed a deliberate gate-off reload that removed the active projection, not a failed automatic chapter in the repaired code.

## Guidance quality

The twelve delivery/acknowledgement receipts were:

- initial urgent at 96.4%, unacted;
- awareness/action/urgent at 50.2/66.1/71.2%, all unacted;
- awareness/action/urgent at 50.6/65.3/70.1%, all unacted;
- post-rescue awareness/awareness/awareness/action at 50.7/50.7/50.3/65.1%, all followed by model folds;
- post-rescue urgent at 70.7%, unacted.

Thus 4/12 milestones produced a fold and 8/12 did not. Guidance was actionable (the same model followed it four times) but one-shot delivery was not sticky enough. Persisted unacted milestones also suppressed equivalent guidance after reload. Calibration should preserve exact causal receipts while re-arming unacted action/urgent guidance after a distinct later successful response and on same-session restart. The ordinary workload used for acceptance must not mention folds or the metric; only production guidance may prompt action.

## Stale and protected context

The 35 deterministic tool records contained 38 complete tool-result batches, mostly one batch per fold. This indicates frequent fallback after ignored guidance, not evidence that the stale floor was too conservative. The incident was a structural closure bug, not candidate starvation. Retain the newest-three-turn and 24,000-byte raw floor until evidence shows it blocks safe reductions.

The durable 42-ref protection set was an emergency containment action applied after the first rescue; baseline explicit protection was zero. It must not be used to calibrate normal policy. Structural protections (live objective, newest three complete turns, 24,000 bytes, pending/unmatched/unknown/unmapped evidence) remain appropriate. The emergency 42-ref set was intentionally overconservative.

## Async and overflow behavior

Three Luna chapters committed in roughly 96 seconds during the orphan epoch, so Luna execution itself completed within its bound. It was nevertheless too late: pressure remained 287,448–300,351, the malformed projection kept provider context unsafe, and the sequence ended in `/compact`. Async completion alone is not sufficient.

The repaired path serializes authority→preparation→commit→projection across context callbacks; same-session lifecycle loads queue behind it; final pressure awaits the single bounded preparation; every durable revision gets one measurement attempt; duplicate, failed, missing, or unmapped hard-pressure contexts call stock `ctx.abort()` before provider transmission. Exact raw Pi messages remain canonical.

## Required policy and acceptance changes

1. Re-arm unacted action/urgent guidance after a distinct selected-branch provider response; restart may not treat an unacted receipt as completed guidance.
2. Keep automatic-trigger context notes, but make them explicit fallback feedback: what happened, exact recovery, and the concrete earlier `status`/`fold` behavior expected.
3. Add a blind behavioral canary. Its workload must never mention context management, folding, thresholds, or acceptance. The extension's normal guidance is the only prompt. An external harness adjudicates at least two exact model-origin folds, later provider reductions, pressure below 75%, terminal completion, zero automatic folds, and zero native compactions.
4. Retain the existing explicit-instruction canary only as held capability evidence; it cannot prove natural guidance efficacy.
5. Keep registration disabled until exact-target review and a fresh stock-Pi behavioral pass.

## Resolution

All five changes landed. Unacted action/urgent guidance now re-arms after a distinct selected-branch response and on restart; automatic triggers share one explicit fallback-feedback hook; the acceptance workload is behavior-blind and exact-revision causal. Deterministic verifier SHA-256 is `1d67a1b60f9e58888285335034ea65475df5e50b87f4d7d016d635391ced0b35`.

Fresh stock Pi 0.83.0 passed on gate commit `d11d060e3b3090fcaaa9d2902d765d6c9e477d51`: two model folds, reductions `142544→124725` and `184771→126546`, high-water `184771/272000`, terminal `stop`, and zero automatic/native actions. Report/session hashes are `9d4405733d49b47feb25195cf7f665c22f1918544c3f76715ebfaffe141b784e` and `9c412ba511ec586518b157b99f22a562e6bdd81b0cd2b19dc02b206647fdb87e`; portable manifest hash is `6df3a3306c48eb759548d2587146e90b9a11b3067a70fe60c79151695fb8a0f2`. Independent review approved. Registration is enabled for fresh runtimes.
