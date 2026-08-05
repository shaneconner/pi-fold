import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";
import { createSummarizeContextSpan } from "./summarizer.js";

export function registerPiFold(pi, options = {}, loadHostModule) {
  const {
    evidenceIngestion = true,
    isMcpTool,
    summarizer = "session",
    summarizeContextSpan,
    ...activeContextOptions
  } = options;
  if (Object.hasOwn(options, "summarizer") && summarizeContextSpan !== undefined) {
    throw new Error("summarizer and summarizeContextSpan cannot be configured together");
  }
  const configuredSummarizer = summarizeContextSpan ??
    createSummarizeContextSpan(summarizer, loadHostModule);
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
