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

import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Fold makes no provider call, so the envelope records the mechanism instead. */
const FOLD_PROVIDER = 'fold'
const FOLD_MODEL = 'deterministic-brief'

/**
 * Longest a single subject line may run before it is cut. A brief exists to let
 * the reader decide whether to go and read the original, not to replace it.
 */
const SUBJECT_CHARS = 160

export interface FoldConfig extends BasicCompactionConfig {
  /** Characters the whole brief may occupy. */
  maxBriefChars?: number
}

/**
 * Compaction that folds rather than summarizes.
 *
 * Everything except the replacement content comes from the basic engine, which
 * is deliberate: pressure policy, retention, range selection and the durable
 * transaction are the parts that must not diverge from the host, and a fold that
 * reimplemented them would drift from the seam it depends on.
 */
export class FoldCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  readonly maxBriefChars: number

  constructor(ctx: Context, config: FoldConfig = {}) {
    super(ctx, config)
    this.maxBriefChars = config.maxBriefChars ?? 2000
  }

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
  protected override async summarize(
    input: { readonly messages: readonly unknown[] },
  ): Promise<{
    summary: { type: 'text'; text: string }[]
    provider: string
    model: string
  }> {
    return {
      summary: [{ type: 'text', text: this.brief(input.messages) }],
      provider: FOLD_PROVIDER,
      model: FOLD_MODEL,
    }
  }

  /**
   * Describe a folded span in terms of what it contained, so a reader can tell
   * whether the original is worth recovering.
   *
   * TODO: this is the seam-proving placeholder. The real generator is the one in
   * the fold core, which seats each subject in a divided budget rather than
   * concatenating and slicing, so a group too wide to seat names how many it
   * could not name. Port it here once the seam is confirmed end to end.
   */
  private brief(messages: readonly unknown[]): string {
    const roles = new Map<string, number>()
    for (const message of messages) {
      const role = String((message as { role?: unknown }).role ?? 'unknown')
      roles.set(role, (roles.get(role) ?? 0) + 1)
    }
    const census = [...roles.entries()]
      .map(([role, count]) => `${count} ${role}`)
      .join(', ')
    const head = `[fold] ${messages.length} messages folded (${census}).`
    const note = 'The originals are unchanged in the session log and can be read back by their shadowed seqs.'
    return `${head} ${note}`.slice(0, this.maxBriefChars)
  }
}

export default FoldCompactionEngine

/** Exported for the gate suite, which pins the cut rather than trusting it. */
export const FOLD_LIMITS = { SUBJECT_CHARS } as const
