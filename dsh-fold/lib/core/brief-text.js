/* THE BOUNDING PRIMITIVES. Pure string rules, no fold state and no host types, so a
   second consumer can hold the same rules rather than a second implementation of them.
   Extracted 2026-08-30 when the DeepSeek Harness build became the third runtime that
   needs them: dsh-fold mirrors this file and nothing else from lib.

   Every deterministic cut in the runtime runs through boundedSubject so a bound always
   leaves its mark: "..." means exactly "content continues in the exact source", and a
   reader never mistakes a cut value for a complete one. oneLine collapses whitespace
   then delegates; factualValue sanitizes then delegates through oneLine. No other site
   slices. Gate 136 pins this.

   The two brief predicates take their bounds as required arguments here. Their callers
   in canonical.ts re-export them with the policy defaults applied, so every existing
   call site is unchanged and the policy stays owned by policy.ts. */
export function boundedSubject(text, budget) {
    if (text.length <= budget)
        return text;
    let kept = text.slice(0, Math.max(0, budget - 3)).trimEnd();
    const finalCode = kept.charCodeAt(kept.length - 1);
    if (finalCode >= 0xd800 && finalCode <= 0xdbff)
        kept = kept.slice(0, -1);
    return `${kept}...`;
}
export function oneLine(value, maximum) {
    return boundedSubject(value.replace(/\s+/g, " ").trim(), maximum);
}
/* THE TOOL-CLIP VIEW HEAD (2026-08-24). A clipped result keeps its opening verbatim,
   not collapsed: the view stays a readable result head in place, unlike a brief's
   one-line quote. The paragraph rule is gate 134's: an opening block terminated by a
   blank line is kept whole up to the cap; a result that is bulk from line one keeps its
   first cap's worth. The caller states the cut, per gate 136: the marker rides beside
   the count of what it hides, never silently. */
export function toolClipHead(text, cap) {
    const lines = String(text ?? "").split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
        if (line.trim())
            kept.push(line);
        else if (kept.length)
            break;
    }
    const paragraph = kept.join("\n");
    const head = paragraph.length > 0 && paragraph.length <= cap
        ? paragraph
        : String(text ?? "").slice(0, cap);
    return head;
}
export function usefulBriefWithin(value, maximum, toolName) {
    if (typeof value !== "string")
        return false;
    const brief = value.trim();
    if (!brief || brief.length > maximum)
        return false;
    const factualLines = [];
    const lines = brief.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const text = lines[index].trim();
        if (!text || text.toLowerCase().includes(toolName.toLowerCase()) ||
            /^\[[^\]]*(?:fold|active-context)[^\]]*\]$/i.test(text))
            continue;
        if (/^(?:topology\b|expand\b|refold\b|list(?:\/page)?\b|page\b|action\b|fold(?:ed)?\s+(?:placeholder|uid|id)\b|(?:this\s+)?fold\b.*\b(?:expand|refold|placeholder|topology|uid|id)\b|(?:parent|children?|previous|next|navigation)\s*[:=])/i.test(text))
            continue;
        factualLines.push(text);
    }
    const factual = factualLines.join(" ").trim();
    return /[A-Za-z0-9]{3,}/.test(factual);
}
export function structurallyValidBriefWithin(value, maximum) {
    if (typeof value !== "string")
        return false;
    const brief = value.trim();
    return Boolean(brief) && brief.length <= maximum &&
        (brief.match(/[A-Za-z0-9]/g)?.length ?? 0) >= 3;
}
/* THE DIVIDED SEATING (extracted 2026-08-30 for the same second consumer). A brief that
   names several subjects does NOT concatenate and slice: a slice at the cap drops whole
   subjects with no statement that it did, which is the silent-cut defect gate 136 exists
   to refuse, one level up. Instead the room left by the lead is divided.

   Two bounds, in order. The count-slice first: room admits at most one subject per
   minSubjectChars, because a share below that names nothing a reader can use, and every
   subject past that count is DROPPED AND COUNTED in the tail. Then the char division
   over the subjects that did seat, ascending by length so a short subject claims only
   what it needs and returns the rest to the pool; the longest subject is bounded last
   against everything the shorter ones gave back, which is what lets a note shorter than
   its fair share ride whole. Ties hold source order, so the output is deterministic.

   Every cut inside a seated subject goes through boundedSubject, so it carries the
   marker. The caller owns the lead, the minimum and the noun the tail counts, because
   those are policy; the division is not. */
export function seatSubjects(subjects, lead, options) {
    const separator = options.separator ?? " | ";
    const room = options.total - lead.length - 1;
    const named = Math.max(1, Math.min(subjects.length, Math.floor((room + separator.length) / (options.minSubjectChars + separator.length))));
    const omitted = subjects.length - named;
    const tail = omitted ? `${separator}${omitted} more ${options.omittedNoun}` : "";
    const budget = room - tail.length - separator.length * (named - 1);
    const order = subjects.slice(0, named).map((text, index) => ({ text, index })).sort((a, b) => a.text.length - b.text.length || a.index - b.index);
    const bounded = new Array(named);
    let left = budget;
    for (let taken = 0; taken < order.length; taken += 1) {
        const owed = Math.max(1, Math.floor(left / (order.length - taken)));
        const kept = boundedSubject(order[taken].text, owed);
        bounded[order[taken].index] = kept;
        left -= kept.length;
    }
    return `${lead}${bounded.join(separator)}${tail}.`.replace(/\s+/g, " ").trim();
}
//# sourceMappingURL=brief-text.js.map