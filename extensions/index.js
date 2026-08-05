import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";

export function registerPiFold(pi, {
  toolName = "active_context",
  entryTypePrefix = "pi-fold-active-context",
  commandPrefix = "",
  summarizeContextSpan,
  setProjectionProvider,
  toolActions,
  blockingTools,
  readOnlyTools,
  isMcpTool = () => false,
} = {}) {
  const stem = commandPrefix ? `${commandPrefix.replace(/-+$/, "")}-` : "";
  registerEvidenceIngestion(pi, { isMcpTool });
  return registerActiveContext(pi, {
    toolName,
    entryTypePrefix,
    commandNames: { status: `${stem}context`, fold: `${stem}fold-context` },
    summarizeContextSpan,
    setProjectionProvider,
    toolActions,
    blockingTools,
    readOnlyTools,
  });
}

export default function piFold(pi, options) {
  return registerPiFold(pi, options);
}
