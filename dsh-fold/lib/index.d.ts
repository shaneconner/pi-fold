/**
 * Lossless context folding for DeepSeek Harness.
 *
 * The Harness already keeps what compaction shadows. A surface replace swaps a
 * span of nodes for one node, and the originals stay in the append-only session
 * log, reachable through their shadowed seqs. So the losslessness pi-fold buys
 * with a content-addressed store on disk is free here, and what remains is the
 * part that was always the point: what the replacement node says, and being able
 * to go back.
 *
 * That makes fold a summarizer substitution rather than a new engine. The basic
 * engine names `summarize()` as its sole subclass hook and keeps the replay and
 * durable mutation strategy fixed, so fold inherits range selection, tool-pairing
 * balance, the compaction lock and the durable transaction, and overrides only
 * what the replacement carries: a deterministic brief that cites the originals
 * rather than a model's reconstruction of them.
 *
 * @module dsh-fold
 */
import type { Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Message } from '@deepseek-ai/dsh-llm';
export interface FoldConfig extends BasicCompactionConfig {
    /** Characters the whole brief may occupy. */
    maxBriefChars?: number;
}
/**
 * Compaction that folds rather than summarizes.
 *
 * Everything except the replacement content comes from the basic engine, which
 * is deliberate: pressure policy, retention, range selection and the durable
 * transaction are the parts that must not diverge from the host, and a fold that
 * reimplemented them would drift from the seam it depends on.
 */
export declare class FoldCompactionEngine extends BasicCompactionEngine {
    static inject: string[];
    readonly maxBriefChars: number;
    constructor(ctx: Context, config?: FoldConfig);
    /**
     * Build the replacement content for one folded span.
     *
     * No provider call: the result is left unmarked, which the seam documents as a
     * result that does not identify a call through the LLM seam. That is the whole
     * economic argument for folding, so it must stay true.
     *
     * @param input - the shadowed region in surface order.
     * @returns brief content plus the envelope recorded with it.
     */
    protected summarize(input: {
        readonly messages: readonly Message[];
    }): Promise<{
        summary: {
            type: 'text';
            text: string;
        }[];
        provider: string;
        model: string;
    }>;
    /**
     * Describe a folded span in terms of what it contained, so a reader can tell
     * whether an original is worth recovering.
     *
     * Two carriers, in surface order. A TOOL RESULT is named by the tool that
     * produced it, correlated back through the call id in the same span, so the
     * subject says what ran rather than only what came back. An AGENT NOTE is the
     * leading paragraph of an assistant message: sol-20260814-traps rep 2 showed
     * that a value the agent derives and records once, in its own words between
     * two tool batches, reaches no other carrier at all, so the note is a
     * first-class subject rather than something a neighbouring subject is trusted
     * to mention. User messages ride for the same reason.
     *
     * The subjects are then seated by division rather than concatenated and
     * sliced: what does not fit is counted in the tail, so the brief never
     * silently claims to be a full index of the span.
     */
    private brief;
}
export default FoldCompactionEngine;
/** Exported for the gate suite, which pins the cuts rather than trusting them. */
export declare const FOLD_LIMITS: {
    readonly SUBJECT_CHARS: 160;
    readonly MIN_SUBJECT_CHARS: 24;
};
//# sourceMappingURL=index.d.ts.map