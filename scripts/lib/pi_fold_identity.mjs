// The harness's deployment identity.
//
// pi-fold's registration defaults are neutral by design: tool name, entry types, commands
// and rendered strings exist only through a deployment's registration block. The experiment
// IS a deployment, so it carries one, and the runtime under measurement is wired the same
// way a consumer wires it.
//
// Renamed from the quorum-branded identity on 2026-08-07, when the harness stopped reading
// its runtime out of a consumer's `.pi/` tree. Sessions sealed before that date carry
// `quorum-active-context-*` entry types and a `quorum_context` tool name; they are readable
// only from the archived corpus, and the boundary is recorded in the experiment log.

// No import of the runtime's own `entryTypeNamespace`: the adjudicator and the graders run
// under plain node with no TypeScript loader, and this module has to be readable from
// there. The namespace is therefore written out below, and a verification gate imports the
// runtime function to assert the two still agree.

// Which tool results the ladder may treat as replayable evidence. The experiment exposes
// only `read` and the stage tool, so this set is the generic read-only surface rather than
// any one consumer's tool catalogue; the stage tool is added at registration, where its
// name is known.
export const PI_FOLD_AUTO_FOLDABLE_TOOLS = Object.freeze(new Set([
  "read", "grep", "find", "ls",
  "web_search", "source_check", "fetch_content", "get_search_content",
]));

export const PI_FOLD_ACTIVE_CONTEXT_REGISTRATION = Object.freeze({
  toolName: "pi_fold_context",
  entryTypePrefix: "pi-fold-active-context",
  commandNames: Object.freeze({ status: "pi-fold-context", fold: "fold-context" }),
  toolLabel: "pi-fold Active Context",
  brandNoun: "pi-fold",
  autoFoldableTools: PI_FOLD_AUTO_FOLDABLE_TOOLS,
});

const PREFIX = PI_FOLD_ACTIVE_CONTEXT_REGISTRATION.entryTypePrefix;
// `entryTypeNamespace` strips a trailing "-active-context"; gated against the runtime.
export const PI_FOLD_ENTRY_NAMESPACE = "pi-fold";
const NAMESPACE = PI_FOLD_ENTRY_NAMESPACE;

export const PI_FOLD_STATE_ENTRY = `${PREFIX}-state`;
export const PI_FOLD_FOLD_RECORD_ENTRY = `${PREFIX}-fold-record`;
export const PI_FOLD_STATUS_KEY = PREFIX;
export const PI_FOLD_PROVIDER_CONTEXT_MEASUREMENT_ENTRY = `${NAMESPACE}-provider-context-measurement`;
export const PI_FOLD_NATIVE_COMPACTION_RECEIPT_ENTRY = `${NAMESPACE}-native-compaction-receipt`;
export const PI_FOLD_NATIVE_COMPACTION_DECISION_ENTRY = `${NAMESPACE}-native-compaction-decision`;
