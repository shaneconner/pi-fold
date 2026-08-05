type ToolHandler = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: unknown,
  ctx: any,
) => Promise<unknown>;

type CommandHandler = (args: string, ctx: any) => Promise<void> | void;

export function buildActiveContextTool(input: {
  name: string;
  label: string;
  allowedActions: readonly string[];
  fullSurface: boolean;
  maxBriefChars: number;
  handler: ToolHandler;
}) {
  const peekGuidance = input.allowedActions.includes("peek")
    ? " Peek is the ephemeral point read: it returns one fold's exact source at any depth, ancestors still collapsed, and changes nothing, so the content arrives as a tool result that can later fold away as a completed read batch; expand is the durable in-place restoration."
    : "";
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, fold, expand, refold, or protect exact Pi active-context evidence.${peekGuidance} Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard 1200-character maximum.`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${peekGuidance} Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard 1200-character maximum.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: input.allowedActions },
        ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
        id: { type: "string", minLength: 1 },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: input.maxBriefChars,
          description: "Factual fold brief; keep it at most 1000 characters to stay below the hard 1200-character limit.",
        },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: ["fold_candidates", "tree"] },
      },
    },
    execute: input.handler,
  };
}

export function buildActiveContextCommands(input: {
  statusName: string;
  foldName: string;
  statusHandler: CommandHandler;
  foldHandler: CommandHandler;
}) {
  return [
    {
      name: input.statusName,
      description: "Show active-context fold roots and paging state",
      handler: input.statusHandler,
    },
    {
      name: input.foldName,
      description: "Losslessly fold a stale context span; works without a main-model request",
      handler: input.foldHandler,
    },
  ];
}
