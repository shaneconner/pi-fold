import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";

export function registerPiFold(pi, options = {}) {
  const { isMcpTool, ...activeContextOptions } = options;
  registerEvidenceIngestion(pi, {
    isMcpTool,
    entryTypePrefix: activeContextOptions.entryTypePrefix,
  });
  return registerActiveContext(pi, activeContextOptions);
}

export default function piFold(pi, options) {
  return registerPiFold(pi, options);
}
