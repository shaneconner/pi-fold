import { registerActiveContext } from "./active-context.ts";
import { registerEvidenceIngestion } from "./evidence.js";

function withNeutralCommands(pi, commandPrefix) {
  return new Proxy(pi, {
    get(target, property) {
      if (property !== "registerCommand") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (name, command) => {
        const commandStem = commandPrefix ? `${commandPrefix.replace(/-+$/, "")}-` : "";
        const foldCommand = `${commandStem}fold-context`;
        if (name === foldCommand) return target.registerCommand(foldCommand, command);
        if (typeof name === "string" && name.startsWith(commandStem) && name.endsWith("-context")) {
          return target.registerCommand(`${commandStem}context`, command);
        }
        throw new Error(`Unexpected active-context command registration: ${String(name)}`);
      };
    },
  });
}

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
  registerEvidenceIngestion(pi, { isMcpTool });
  return registerActiveContext(withNeutralCommands(pi, commandPrefix), {
    toolName,
    entryTypePrefix,
    commandPrefix,
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
