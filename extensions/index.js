import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";
import { createSummarizeContextSpan } from "./summarizer.js";

/**
 * THE public surface: six options, and every name outside them is refused.
 *
 * Unknown keys used to spread through silently, which made every deletion a no-op rather
 * than an error and handed a deployment the opposite of what it asked for. A caller that
 * passes a name believes it bought behavior, so a name this package does not sell is a
 * throw with the replacement named in it.
 */
const PUBLIC_OPTIONS = Object.freeze([
  "thresholds", "summarizer", "providerInputBudget", "autoFoldableTools",
  "evidenceIngestion", "guidance",
]);

/**
 * Options that left the surface, each answered by name. Deployment identity is hardwired:
 * this is a branded package with one deployment, not a framework a host rebrands, and a
 * consumer that moved `entryTypePrefix` stranded its own durable folds under a namespace
 * nothing would read back.
 */
const REFUSED_OPTIONS = Object.freeze({
  toolName: "the deployment identity is hardwired to pi-fold: the tool is pi_fold_context",
  toolLabel: "the deployment identity is hardwired to pi-fold",
  brandNoun: "the deployment identity is hardwired to pi-fold",
  entryTypePrefix: "the deployment identity is hardwired to pi-fold: durable state lives " +
    "under pi-fold-active-context, and moving it would strand every fold already written",
  commandPrefix: "the deployment identity is hardwired to pi-fold: the commands are " +
    "/pi-fold-context and /fold-context",
  commandNames: "the deployment identity is hardwired to pi-fold: the commands are " +
    "/pi-fold-context and /fold-context",
  isMcpTool: "MCP tools are recognized by the mcp__server__tool naming convention. The " +
    "predicate defaulted to false, so conventionally named MCP tools were never classified " +
    "unless a host supplied one, which is a documented feature that never ran",
  readOnlyTools: "renamed autoFoldableTools: same set, and the name now says what it " +
    "controls, which is whose results may fold without a mark",
  providerTotalWindow: "renamed providerInputBudget, and it is ALREADY NET: pass the tokens " +
    "the deployment may actually fill, not the total window the runtime then subtracts a " +
    "guessed output reservation from",
  summarizeContextSpan: "choose a brief generator with summarizer (\"session\", " +
    "\"deterministic\", or { provider, model, effort })",
});

export function registerPiFold(pi, options = {}, loadHostModule) {
  for (const name of Object.keys(options)) {
    if (Object.hasOwn(REFUSED_OPTIONS, name)) {
      throw new Error(`${name} is no longer an option: ${REFUSED_OPTIONS[name]}`);
    }
    if (!PUBLIC_OPTIONS.includes(name)) {
      throw new Error(`${name} is not a pi-fold option: the surface is ` +
        `${PUBLIC_OPTIONS.join(", ")}`);
    }
  }
  const { evidenceIngestion = true, summarizer = "session", ...activeContextOptions } = options;
  const configuredSummarizer = createSummarizeContextSpan(summarizer, loadHostModule);
  if (evidenceIngestion) registerEvidenceIngestion(pi);
  return registerActiveContext(pi, {
    ...activeContextOptions,
    ...(configuredSummarizer ? { summarizeContextSpan: configuredSummarizer } : {}),
  });
}

export default function piFold(pi, options) {
  return registerPiFold(pi, options);
}
