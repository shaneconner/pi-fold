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
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { boundedSubject, oneLine, seatSubjects } from "./core/brief-text.js";
/** Fold makes no provider call, so the envelope records the mechanism instead. */
const FOLD_PROVIDER = 'fold';
const FOLD_MODEL = 'deterministic-brief';
/**
 * Longest a single subject may run before it is cut. A brief exists to let the
 * reader decide whether to go and read the original, not to replace it.
 */
const SUBJECT_CHARS = 160;
/**
 * Narrowest share worth seating. Below this a subject names nothing a reader can
 * act on, so the subject is dropped and counted rather than seated as a stub.
 */
const MIN_SUBJECT_CHARS = 24;
/**
 * The recoverability sentence, which is the whole difference between this brief
 * and a summary. It rides WHOLE or the brief is not built at all: it is sized out
 * of the seating budget up front rather than appended and sliced, because a brief
 * that loses the sentence telling the reader the originals are still there is
 * exactly the silent cut the bounding rules exist to refuse.
 */
const RECOVERY_NOTE = ' The originals are unchanged in the session log and can be read back by their shadowed seqs.';
/** Visible text of a block set, with reasoning and images left out by kind. */
const textOf = (content) => content
    .filter((block) => block.type === 'text')
    .map(block => block.text)
    .join('\n');
/**
 * One subject, bounded and ready to seat.
 *
 * The seating closes the sentence, so a subject that already ends in a period
 * would double it. A cut marker is left alone: its three dots are the statement
 * that content continues, not punctuation to tidy.
 */
const asSubject = (text) => {
    const bounded = oneLine(text, SUBJECT_CHARS);
    return bounded.endsWith('...') || !bounded.endsWith('.') ? bounded : bounded.slice(0, -1);
};
/**
 * The leading paragraph, read as the writer's own note.
 *
 * An unterminated block is KEPT, unlike a tool result's opening prose: the whole
 * message is the writer's words, so a note with no blank line is a one-paragraph
 * note rather than bulk to refuse.
 */
const leadingParagraph = (text) => {
    const kept = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.trim())
            kept.push(line.trim());
        else if (kept.length)
            break;
    }
    return kept.join(' ');
};
/**
 * Compaction that folds rather than summarizes.
 *
 * Everything except the replacement content comes from the basic engine, which
 * is deliberate: pressure policy, retention, range selection and the durable
 * transaction are the parts that must not diverge from the host, and a fold that
 * reimplemented them would drift from the seam it depends on.
 */
export class FoldCompactionEngine extends BasicCompactionEngine {
    static inject = ['llm', 'tokenMeter', 'sessions'];
    maxBriefChars;
    constructor(ctx, config = {}) {
        super(ctx, config);
        this.maxBriefChars = config.maxBriefChars ?? 2000;
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
    async summarize(input) {
        return {
            summary: [{ type: 'text', text: this.brief(input.messages) }],
            provider: FOLD_PROVIDER,
            model: FOLD_MODEL,
        };
    }
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
    brief(messages) {
        const toolNames = new Map();
        for (const message of messages) {
            for (const block of message.content) {
                if (block.type === 'tool-call')
                    toolNames.set(String(block.id), block.name);
            }
        }
        const subjects = [];
        let results = 0;
        let notes = 0;
        for (const message of messages) {
            const result = message.content.find(block => block.type === 'tool-result');
            if (result !== undefined && result.type === 'tool-result') {
                const named = toolNames.get(String(result.toolCallId)) ?? 'tool';
                const outcome = result.isError === true ? 'failed' : 'returned';
                const head = oneLine(textOf(result.content), SUBJECT_CHARS);
                subjects.push(asSubject(boundedSubject(`${named} ${outcome}: ${head}`, SUBJECT_CHARS)));
                results += 1;
                continue;
            }
            if (message.role === 'system')
                continue;
            const paragraph = leadingParagraph(textOf(message.content));
            if (!paragraph)
                continue;
            subjects.push(asSubject(paragraph));
            if (message.role === 'assistant')
                notes += 1;
        }
        if (subjects.length === 0) {
            return `Folded ${messages.length} messages holding no readable text.${RECOVERY_NOTE}`;
        }
        const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
        const lead = `Folded ${count(messages.length, 'message')} covering `
            + `${count(results, 'tool result')} and ${count(notes, 'agent note')}: `;
        return seatSubjects(subjects, lead, {
            total: this.maxBriefChars - RECOVERY_NOTE.length,
            minSubjectChars: MIN_SUBJECT_CHARS,
            omittedNoun: 'more in this span',
        }) + RECOVERY_NOTE;
    }
}
export default FoldCompactionEngine;
/** Exported for the gate suite, which pins the cuts rather than trusting them. */
export const FOLD_LIMITS = { SUBJECT_CHARS, MIN_SUBJECT_CHARS };
//# sourceMappingURL=index.js.map