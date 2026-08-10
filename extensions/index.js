import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";
import { createSummarizeContextSpan } from "./summarizer.js";

export function registerPiFold(pi, options = {}, loadHostModule) {
  const {
    evidenceIngestion = true,
    isMcpTool,
    summarizer = "session",
    ...activeContextOptions
  } = options;
  // `summarizeContextSpan` left the public surface: it is the runtime's INTERNAL
  // brief-generator interface, and `summarizer` is the declarative way to choose one.
  // Refused by name rather than forwarded, because forwarding it would be overwritten
  // by the generator built below and hand the caller the opposite of what it asked for.
  if (Object.hasOwn(options, "summarizeContextSpan")) {
    throw new Error("summarizeContextSpan is no longer an option: choose a brief generator with " +
      "summarizer (\"session\", \"deterministic\", or { provider, model, effort })");
  }
  const configuredSummarizer = createSummarizeContextSpan(summarizer, loadHostModule);
  if (evidenceIngestion) {
    registerEvidenceIngestion(pi, {
      isMcpTool,
      entryTypePrefix: activeContextOptions.entryTypePrefix,
    });
  }
  return registerActiveContext(pi, {
    ...activeContextOptions,
    ...(configuredSummarizer ? { summarizeContextSpan: configuredSummarizer } : {}),
  });
}

export default function piFold(pi, options) {
  return registerPiFold(pi, options);
}
