import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";

export {
  applyFoldSettingsEdit,
  loadFoldSettingsFile,
  readFoldSettingsFile,
  registerFoldSettings,
  saveFoldSettingsFile,
} from "./settings.ts";

const PUBLIC_OPTIONS = Object.freeze([
  "thresholds", "providerInputBudget", "blacklistAutoFoldTools", "toolFoldThreshold",
  "workingMemory", "postFoldNotice",
]);

const GENERATOR_DELETED = "the model brief generator is deleted (2026-08-14): across 15 sealed " +
  "generator runs, 75 percent of its 1,186 upgraded briefs were never consulted or never became " +
  "visible, and the no-generator build scored the same for less. Every fold carries its " +
  "deterministic brief; sessions already holding model briefs keep them on load";

const INVERTED_AUTO_FOLD_LIST = "renamed blacklistAutoFoldTools, and the sense is INVERTED: " +
  "every completed tool batch folds unmarked, and the list names the exceptions whose " +
  "results must stay raw. An allow-list moved across verbatim would bar exactly the tools " +
  "it meant to permit";

const REFUSED_OPTIONS = Object.freeze({
  guidance: "deleted 2026-08-23: it switched the copy that taught the agent to " +
    "CHOOSE SPANS, and the agent does not choose spans. The runtime cuts at the frontier and " +
    "the agent annotates what it cut, so the guidance it switched is replaced wholesale by " +
    "the post-fold notice, which is not optional: a fold the agent is never told about is one " +
    "it can never brief",
  toolName: "the deployment identity is hardwired to pi-fold: the tool is pi_fold_context",
  toolLabel: "the deployment identity is hardwired to pi-fold",
  brandNoun: "the deployment identity is hardwired to pi-fold",
  entryTypePrefix: "the deployment identity is hardwired to pi-fold: durable state lives " +
    "under pi-fold-active-context, and moving it would strand every fold already written",
  commandPrefix: "the deployment identity is hardwired to pi-fold: the commands are " +
    "/fold, /fold-editor, /fold-status and /fold-settings",
  commandNames: "the deployment identity is hardwired to pi-fold: the commands are " +
    "/fold, /fold-editor, /fold-status and /fold-settings",
  isMcpTool: "MCP tools are recognized by the mcp__server__tool naming convention. The " +
    "predicate defaulted to false, so conventionally named MCP tools were never classified " +
    "unless a host supplied one, which is a documented feature that never ran",
  readOnlyTools: INVERTED_AUTO_FOLD_LIST,
  autoFoldableTools: INVERTED_AUTO_FOLD_LIST,
  evidenceIngestion: "evidence ingestion is always on: the hook always registers, oversized " +
    "tool results are pinned to read-only 0444 artifacts under the session directory, and " +
    "the 512 MB session cap is a constant. Exact recovery is what the folds promise, and a " +
    "switch that removed the anchors removed the promise",
  providerTotalWindow: "renamed providerInputBudget, and it is ALREADY NET: pass the tokens " +
    "the deployment may actually fill, not the total window the runtime then subtracts a " +
    "guessed output reservation from",
  summarizer: GENERATOR_DELETED,
  summarizeContextSpan: GENERATOR_DELETED,
});

export function registerPiFold(pi, options = {}) {
  for (const name of Object.keys(options)) {
    if (Object.hasOwn(REFUSED_OPTIONS, name)) {
      throw new Error(`${name} is no longer an option: ${REFUSED_OPTIONS[name]}`);
    }
    if (!PUBLIC_OPTIONS.includes(name)) {
      throw new Error(`${name} is not a pi-fold option: the surface is ` +
        `${PUBLIC_OPTIONS.join(", ")}`);
    }
  }
  registerEvidenceIngestion(pi);
  return registerActiveContext(pi, options);
}

export default function piFold(pi, options) {
  return registerPiFold(pi, options);
}
