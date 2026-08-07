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
  statusDetails: readonly string[];
  minPeekSliceBytes: number;
  defaultPeekBytes: number;
  handler: ToolHandler;
}) {
  const peekGuidance = input.allowedActions.includes("peek")
    ? ` Peek is the ephemeral point read: it returns one fold's index view -- every nested fold's brief in full, plus the head and tail of the raw source with the omitted middle stated -- at any depth, ancestors still collapsed, changing nothing. It returns at most ${input.defaultPeekBytes} bytes unless you widen it with bytes, and it lives for one model call unless you pass ephemeral false or retain true. Expand is the durable in-place restoration.`
    : "";
  const correctionGuidance = input.allowedActions.includes("rebrief")
    ? " Curation is correctable: rebrief replaces a fold's brief, and reboundary with ids re-cuts a span into exactly one fold, which merges adjacent folds when the span covers several and splits one when the span sits inside it. Reboundary with a single id returns that fold's span to raw."
    : "";
  // Marking is yours, folding is the runtime's. The epoch guidance says how marks
  // behave and stops there: there is no agent-callable commit verb to describe.
  const epochGuidance = input.allowedActions.includes("unmark")
    ? " Fold scheduling is epoch mode: fold records pending marks and moves no context bytes, and the runtime applies every pending mark in one rewrite when the fold event fires. Mark SEVERAL spans in one call: marks carries several {ids, brief} pairs, and one call answers with your whole picture, every span now held plus the unmarked remainder and what share of the non-fresh window it is. Between fold events nothing else in your context changes, so that result is where the picture lives. Mark freely as you work; when to fold is the runtime's to decide, and unmark withdraws a mark you no longer want."
    : "";
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, fold, expand, refold, protect, rebrief, or re-cut exact Pi active-context evidence.${peekGuidance}${correctionGuidance}${epochGuidance} Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard 1200-character maximum.`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${peekGuidance}${correctionGuidance}${epochGuidance} Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard 1200-character maximum.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: input.allowedActions },
        ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
        id: { type: "string", minLength: 1 },
        marks: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          description: "Fold only: several spans with their own briefs in one call, which is the shape to prefer. An invalid or overlapping span is corrected to the nearest valid edge and the correction is reported back.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ids"],
            properties: {
              ids: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
              brief: { type: "string", minLength: 1, maxLength: input.maxBriefChars },
            },
          },
        },
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
          description: `Peek only: bytes of exact source to return, widening or narrowing the ${input.defaultPeekBytes}-byte default.`,
        },
        retain: {
          type: "boolean",
          description: "Peek only: keep this result in the window instead of letting it be reclaimed after one model call.",
        },
        ephemeral: {
          type: "boolean",
          description: "Peek only: decide this read's lifetime yourself. True, the default, releases its duplicate bytes once a model call has read them; false keeps them for as long as any other tool result.",
        },
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
