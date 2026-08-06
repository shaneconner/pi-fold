/**
 * Wording rule for everything in this file: describe units of WORK, never units of
 * conversation. Text that presupposes turn-ending replies ("after the reply",
 * "between tasks") tells a single-turn staged agent that a reply is the natural next
 * move, and it rides in the tool surface of every request. It is the top unproven
 * suspect for the iteration-2 phase flips, and saying the true thing instead costs
 * nothing: the next model call that reads a result, a natural boundary in the work.
 */

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
  ephemeralPeek?: boolean;
  perPeekEphemeral?: boolean;
  statusDetails: readonly string[];
  minPeekSliceBytes: number;
  handler: ToolHandler;
}) {
  const peekGuidance = input.allowedActions.includes("peek")
    ? " Peek is the ephemeral point read: it returns one fold's exact source at any depth, ancestors still collapsed, and changes nothing, so the content arrives as a tool result that can later fold away as a completed read batch; expand is the durable in-place restoration. Narrow a large read with offset and bytes, or peek a child fold id."
    : "";
  const reclaimGuidance = input.ephemeralPeek && input.allowedActions.includes("peek")
    ? " Peek results live for one model call: once the next model call that reads one has run, its duplicate bytes leave the projection and the fold keeps the exact source. Pass retain true to keep a result in the window, and retain false to release it again."
    : "";
  const commitGuidance = input.allowedActions.includes("commit")
    ? " Fold scheduling is epoch mode: fold records a pending mark and moves no context bytes, and commit applies every pending mark in one rewrite. Mark freely as you work; commit at a natural boundary in the work, or let window pressure commit for you."
    : "";
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, fold, expand, refold, or protect exact Pi active-context evidence.${peekGuidance}${reclaimGuidance}${commitGuidance} Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard 1200-character maximum.`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${peekGuidance}${reclaimGuidance}${commitGuidance} Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard 1200-character maximum.`,
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
        bytes: {
          type: "integer",
          minimum: input.minPeekSliceBytes,
          description: "Peek only: bytes of exact source to return from offset, for a bounded slice of a large fold.",
        },
        ...(input.ephemeralPeek
          ? {
            retain: {
              type: "boolean",
              description: "Peek only: keep this result in the window instead of letting it be reclaimed after one model call.",
            },
          }
          : {}),
        ...(input.perPeekEphemeral
          ? {
            ephemeral: {
              type: "boolean",
              description: "Peek only: decide this read's lifetime yourself. True releases its duplicate bytes once a model call has read them; false keeps them for as long as any other tool result.",
            },
          }
          : {}),
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: [...input.statusDetails] },
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
