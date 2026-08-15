// The per-query attribution lens: for one FACT STRING and one moment in a sealed
// session (a provider request's leaf), say where that fact's bytes sat. The four
// classes partition what a model could have done about it:
//
//   visible-raw    the fact rode the projection as ordinary entry text
//   visible-brief  the fact rode the projection inside a visible fold brief
//   recoverable    the fact sat inside a fold (source bytes, or a hidden child's
//                  brief) one peek or expand away, but nothing visible carried it
//   absent         the fact was nowhere on the branch at that moment; when it
//                  exists on a DEAD branch the off-branch entries are named,
//                  which is what a native compaction's discard looks like
//
// The branch at the request's leaf IS the visible window for both arms, which is
// what makes the lens uniform: a native session simply has no fold state, so
// everything on the branch is raw and the interesting native classes are
// visible-raw versus absent-with-off-branch-entries. The pifold reading loads
// the fold forest with the RUNTIME'S OWN materializeStatePersistence rather
// than refolding the delta chain here, so the lens cannot drift from what the
// session actually reconstructs; the runtime module is a parameter because it
// is TypeScript and the caller owns the jiti import.
//
// Entry text deliberately counts text parts, tool call names and arguments, and
// tool result text, and EXCLUDES thinking: reasoning items are provider-held
// and are not replayed as readable text, and fold sources store the same entry
// shapes, so one definition of "the fact's bytes" serves every class.

// A full sealed run can hold enough transcript state that repeatedly rebuilding
// the fold forest in one process exhausts the host. The sweep owns one fixed
// batch size, not a tuning surface: each batch exits before the next starts.
export const ATTRIBUTION_BATCH_ROWS = 4;

export function attributionBatchStarts(rowCount) {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error("attribution row count must be a non-negative safe integer");
  }
  return Array.from(
    { length: Math.ceil(rowCount / ATTRIBUTION_BATCH_ROWS) },
    (_, index) => index * ATTRIBUTION_BATCH_ROWS,
  );
}

export function entryText(entry) {
  const message = entry?.message;
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "toolCall") {
      parts.push(String(part.name ?? ""));
      if (part.arguments !== undefined) parts.push(JSON.stringify(part.arguments));
    }
  }
  return parts.join("\n");
}

export function branchTo(entries, leafId) {
  const byId = new Map();
  for (const entry of entries) if (entry?.id) byId.set(entry.id, entry);
  if (!byId.has(leafId)) throw new Error(`attribution leaf ${leafId} is not in the session`);
  const branch = [];
  const seen = new Set();
  for (let id = leafId; id !== null && id !== undefined;) {
    if (seen.has(id)) throw new Error(`attribution branch cycles at ${id}`);
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) throw new Error(`attribution branch breaks at ${id}: parent missing`);
    branch.push(entry);
    id = entry.parentId ?? null;
  }
  branch.reverse();
  return branch;
}

// Walk the same fold forest the runtime projects. A revealed parent does not
// reveal a collapsed child: renderFoldParts routes that child back through
// renderFold, so the child's brief is visible and its source stays recoverable.
// Protection can reveal either level independently, and a rebrief override is
// the visible brief because foldBrief is the runtime's one accessor.
export function projectionCarriers({ runtime, state, snapshot }) {
  const byId = new Map(state.folds.map((fold) => [fold.id, fold]));
  const expanded = new Set(state.expanded ?? []);
  const visibleBriefIds = new Set();
  const visibleSourceEntryIds = new Set();
  const coveredEntryIds = new Set();
  const roots = state.folds.filter((fold) => fold.parentId === null);
  const walk = (fold) => {
    const refs = runtime.flattenFoldRefs(fold, state);
    const revealed = expanded.has(fold.id) || (fold.kind === "tool-result"
      ? runtime.toolRefsProtected(refs, state, snapshot)
      : runtime.refsProtected(refs, state, snapshot));
    if (!revealed) {
      visibleBriefIds.add(fold.id);
      return;
    }
    for (const part of fold.parts) {
      if (part.kind === "raw") visibleSourceEntryIds.add(part.ref.entryId);
      else {
        const child = byId.get(part.foldId);
        if (!child) throw new Error(`attribution fold ${fold.id} is missing child ${part.foldId}`);
        walk(child);
      }
    }
  };
  for (const root of roots) {
    for (const ref of runtime.flattenFoldRefs(root, state)) coveredEntryIds.add(ref.entryId);
    walk(root);
  }
  const brief = (fold) => ({ foldId: fold.id, brief: String(runtime.foldBrief(fold, state) ?? "") });
  return {
    visibleBriefs: state.folds.filter((fold) => visibleBriefIds.has(fold.id)).map(brief),
    recoverableBriefs: state.folds.filter((fold) => !visibleBriefIds.has(fold.id)).map(brief),
    coveredEntryIds,
    visibleSourceEntryIds,
  };
}

// The view a classification reads: computed once per (session, leaf) and reused
// across every fact probed at that moment. The snapshot is rebuilt from the
// exact branch with the runtime's own mapper before the runtime's projection
// carriers are walked, so expansion, protection and evidence identity share
// the implementation that built the provider request.
export function carriageView({
  runtime, branch, sessionId, stateEntryType, foldRecordEntryType, providerInputBudget,
}) {
  const { state } = runtime.materializeStatePersistence(
    branch, sessionId, stateEntryType, foldRecordEntryType);
  const eventMessages = branch.flatMap((entry) => runtime.sessionEntryMessages(entry));
  const declaredBudget = typeof providerInputBudget === "number" &&
    Number.isFinite(providerInputBudget) && providerInputBudget > 0;
  const snapshot = runtime.mapActiveContext({
    sessionId,
    eventMessages,
    contextEntries: branch,
    ...(declaredBudget ? { contextWindow: providerInputBudget, netBudget: true } : {}),
  });
  const carriers = projectionCarriers({ runtime, state, snapshot });
  return {
    branch,
    ...carriers,
    folds: state.folds.length,
    revision: state.revision,
  };
}

export function classifyFactCarriage(view, fact) {
  if (typeof fact !== "string" || !fact) throw new Error("attribution needs a non-empty fact string");
  const visibleRawEntryIds = [];
  const recoverableSourceEntryIds = [];
  for (const entry of view.branch) {
    if (entry?.type !== "message") continue;
    if (!entryText(entry).includes(fact)) continue;
    const hidden = view.coveredEntryIds.has(entry.id) && !view.visibleSourceEntryIds.has(entry.id);
    (hidden ? recoverableSourceEntryIds : visibleRawEntryIds).push(entry.id);
  }
  const visibleBriefFoldIds = view.visibleBriefs
    .filter((item) => item.brief.includes(fact)).map((item) => item.foldId);
  const recoverableBriefFoldIds = view.recoverableBriefs
    .filter((item) => item.brief.includes(fact)).map((item) => item.foldId);
  const classification = visibleRawEntryIds.length ? "visible-raw"
    : visibleBriefFoldIds.length ? "visible-brief"
    : (recoverableSourceEntryIds.length || recoverableBriefFoldIds.length) ? "recoverable"
    : "absent";
  return {
    classification,
    visibleRawEntryIds,
    visibleBriefFoldIds,
    recoverableSourceEntryIds,
    recoverableBriefFoldIds,
  };
}

export function attributeFactInView({ view, entries, fact }) {
  const result = classifyFactCarriage(view, fact);
  if (result.classification === "absent") {
    const onBranch = new Set(view.branch.map((entry) => entry.id));
    const offBranchEntryIds = [];
    for (const entry of entries) {
      if (entry?.type !== "message" || onBranch.has(entry.id)) continue;
      if (entryText(entry).includes(fact)) offBranchEntryIds.push(entry.id);
    }
    if (offBranchEntryIds.length) return { ...result, offBranchEntryIds };
  }
  return result;
}

// The whole reading for one fact at one leaf, with the off-branch tail that
// names a discard: absent on the branch while present on a dead one is what
// native compaction leaves behind, and naming the entries keeps the claim
// checkable instead of inferred.
export function attributeFactInSession({
  runtime, entries, sessionId, leafId, fact, stateEntryType, foldRecordEntryType, providerInputBudget,
}) {
  const branch = branchTo(entries, leafId);
  const view = carriageView({
    runtime, branch, sessionId, stateEntryType, foldRecordEntryType, providerInputBudget,
  });
  return attributeFactInView({ view, entries, fact });
}

// The answering request for a piece of response text: the entry that CONTAINS
// the text descends from the leaf its request was built on, so the nearest
// ancestor that is some request's leaf names the request. Interleaved custom
// records between the leaf and the response are why this walks rather than
// reading the parent alone.
export function requestForAnswer({ entries, requests, answerText }) {
  const byId = new Map();
  for (const entry of entries) if (entry?.id) byId.set(entry.id, entry);
  const leafToRequest = new Map();
  for (const request of requests) {
    if (request?.leafId) leafToRequest.set(request.leafId, request);
  }
  const answer = entries.find((entry) =>
    entry?.type === "message" && entry.message?.role === "assistant" &&
    entryText(entry).includes(answerText));
  if (!answer) return null;
  for (let id = answer.parentId; id !== null && id !== undefined;) {
    const request = leafToRequest.get(id);
    if (request) return { request, answerEntryId: answer.id };
    id = byId.get(id)?.parentId ?? null;
  }
  return null;
}
