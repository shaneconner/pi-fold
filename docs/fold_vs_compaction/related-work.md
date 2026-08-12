# Related work

Folding a long agent transcript into summaries that can be expanded again is not a new
idea, and this section says so plainly before making any claim of our own. What follows
separates the work by what it actually is, because the category matters more than the
shared vocabulary: two of the closest-sounding systems are training methods rather than
harnesses, and the closest harness inverts the control model we are testing.

## Training methods

**FoldAgent** (arXiv 2510.11967) trains the folding behaviour itself, using an RL method
the authors call FoldGRPO. The agent branches a rollout, works inside the branch, and
returns carrying a self-chosen summary rather than the branch's full context. Reported on
BrowseComp and SWE-Bench Verified against ReAct and summary-agent baselines.

**AgentFold** (arXiv 2510.24699) reaches a similar place through supervised fine-tuning,
with folding at two scales: granular condensation of recent steps and deeper consolidation
of a finished sub-task. Reported at 36.2 on BrowseComp and 47.3 on BrowseComp-ZH.

Both establish the idea and the word. Neither is comparable to a harness: the folding lives
in the weights, the summaries are lossy by construction, and there is no expansion back to
exact bytes. They bound what an inference-time system may claim as novel about *folding*,
and they bound nothing about how one is engineered.

## Inference-time systems

**ARC, Addressable Recall Compaction** (arXiv 2607.25066) keeps every observation verbatim
in a content-addressed append-only store and replaces long observations in the active
transcript with citation stubs carrying an identifier and head/tail previews. The agent
dereferences a stub with an explicit recall verb. Compaction itself is automatic on
overflow: the agent chooses when to recall, never what to fold. Prompt prefix caching is
not discussed.

**Volt** and the **Lossless Context Management** family, including the `hermes-lcm` and
`lossless-claw` plugins, treat the transcript as immutable and maintain a DAG of summaries
over it. Volt's framing is the sharpest statement of the principle we also rely on:
summary nodes are materialized views over immutable history, a cache rather than a source
of truth.

Its scheduling is worth stating precisely, because it is easy to assume otherwise. LCM does
not rewrite the context on every summarization: above a soft token threshold it compacts
asynchronously and, in the paper's words, atomically swaps the resulting summary into the
context between LLM turns, and it explicitly acknowledges that the provider must then
regenerate the KV cache. A boundary is therefore not what separates this work from LCM, and
we do not claim it as a difference. What the paper does
not state is how many blocks one soft-threshold compaction covers; its hard-threshold
procedure is a loop that identifies the oldest block, summarizes it, and replaces it, one
summary node per iteration. And it reports no cache-hit rate, no cache share, and no token
cost: the mechanism is named and its consequence is left unmeasured.

`hermes-lcm` describes itself as cache-friendly but not cache-aware, and states that it does
not track live provider cache state.

**Accordion** is the nearest neighbour by construction: like this work it is an extension
for the same host agent, it folds reversibly, it protects a fresh tail, and it nests folds
into higher-level groups. Its control model is the interesting difference. By its own design
document the agent may not fold and may not peek; folding is performed by the user or by a
pluggable policy the project calls a conductor, and the agent is given expansion and recall
only. Its strongest conductor scores each block by the attention a small probe model pays to
it from a readout position, which is a genuinely different selection signal from the
staleness ordering used here.

Accordion's own exploration of relevance signals reports a result worth repeating because it
argues against a design choice we made: across a real session of 981 blocks, the correlation
between relevance-to-the-present and distance-from-the-tail was 0.007, and 9 of the 20
most relevant blocks sat in the older half. If that holds generally, recency is close to
uninformative about what an agent still needs. The authors are careful that their relevance
measure is a proxy they had not yet validated, and they ran no lexical baseline, so we treat
it as a serious open question rather than a settled finding.

## Independence and priority

This work was developed in parallel with Accordion, not derived from it. Accordion's first
commit is dated 2026-06-02 and this project's lineage begins on 2026-07-26. Accordion is
therefore earlier, and we make no priority claim over it. The overlap in vocabulary, fold
and unfold, digests, a protected working tail, is convergent rather than borrowed, which is
unsurprising given both were built with the same model as a collaborator. We cite the LCM
family as an acknowledged influence.

## What this work adds

Three things, stated at the strength the evidence supports.

**A measured cache consequence, not just a boundary.** Folding necessarily rewrites the
prompt prefix; nobody escapes that, and we do not claim to. Nor do we claim the boundary
itself: LCM already swaps atomically between turns and already says the KV cache must be
regenerated. Two things are ours. The first is the amortization ratio: marks accumulate and
apply together, so one prefix disturbance carries a whole commit's folds rather than one
summary node per replacement. The second, and the one we would defend hardest, is that the
consequence is measured rather than asserted.

Measured over one full run, on two lenses that should be read with their own denominators.
By the projection lens: 90 folds arrived across 10 applied commits, 9 of which minted folds,
for 10.0 folds per fold-minting commit, and of 131 projection handoffs 10 were rewrites, 110
were append-only and 11 were byte-identical. By the request lens, which counts only the 120
handoffs that produced a measured provider response: 104 append requests ran at 91.1 percent
cache share with 3 cold, 10 identical requests at 48.2 percent with 5 cold, and 6 rewrite
requests at 0.0 percent with 6 cold. Pooled cache share across the run was 84.5 percent, and
the rewrite requests accounted for 3.3 percent of all tokens.

The counterfactual is a bound rather than a measurement, and we state it as one: a design
that applies each fold as it is decided has an upper limit of one cache break per fold,
which here would have been up to 90 instead of 10. Measuring it properly requires an
in-place arm, which we have not yet run.

**A serving budget derived from the declared context window.** The output ceiling a host
derives is computed against the model descriptor's window, not against whatever the wire
happens to accept, so the budget that matters is the declared window minus the reservation.
We found no discussion of this distinction in the neighbouring systems.

**A controlled comparison rather than a benchmark score.** This is the contribution we would
defend hardest. The neighbouring systems report benchmark numbers or, in Accordion's case, a
single hackathon-scale run its authors explicitly label a signal rather than a guarantee.
What is reported here is an arm-versus-arm comparison on a staged repository-comprehension
marathon, with the source tree hash-pinned per run, external pacing, one real session per
run, and adjudication from sealed artifacts only.

## What this work does not show

The agent in the measured run issued 53 peek calls, 52 of which succeeded, 17 status calls,
and zero fold marks. All 90 folds were ladder-origin and every applied commit recorded zero
agent marks. In this workload, therefore, agent governance meant governance of **recovery**
and not of **selection**: the agent let the ladder choose what to fold and spent its agency
getting material back. That is still the axis on which this differs from Accordion, where
the agent may neither fold nor peek, but it is a narrower claim than agent-curated context
and we do not make the broader one here.

Every peek in that run was a peek rather than an expansion, which is the cache-preserving
recovery path, but the run did not test whether an agent under different instructions would
choose differently.
