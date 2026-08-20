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
    ? ` Peek is the point read: it returns one fold's index view -- every nested fold's brief in full, plus the head and tail of that fold's own span with the omitted middle stated -- for any fold id, ancestors still collapsed, changing nothing. It serves ONE level: raw entries come back exactly, folds nested inside stay placeheld, and peeking a child id you see there returns that child's own bytes, so anything folded is one hop away at any depth. It returns at most ${input.defaultPeekBytes} bytes unless you widen it with bytes, and it stays in the window like any other tool result; pass ephemeral true and it instead rides only until your next message, your reply then the surviving trace, so write down what matters before you answer. Expand is the durable in-place restoration.`
    : "";
  const correctionGuidance = input.allowedActions.includes("rebrief")
    ? " Curation is correctable: rebrief replaces a fold's brief, and reboundary with ids re-cuts a span into exactly one fold, which merges adjacent folds when the span covers several and splits one when the span sits inside it. Reboundary with a single id returns that fold's span to raw."
    : "";
  const pinGuidance = input.allowedActions.includes("protect")
    ? " Protect is the pin: protect with ids holds folds or entries against automatic folding, consolidation and refolding until unprotect releases them, so an expanded span you still need stays expanded. Protect reveals nothing on its own: a folded span stays folded, just held. Pinning moves no context bytes, and fold receipts report how much mass you have pinned."
    : "";
  const epochGuidance = input.allowedActions.includes("unmark")
    ? " Fold scheduling is epoch mode: fold records pending marks and moves no context bytes, and the runtime applies every pending mark in one rewrite when the fold event fires. Mark SEVERAL spans in one call: marks carries several {ids, brief} pairs, and one call answers with your whole picture, every span now held plus the unmarked remainder and what share of the non-fresh window it is. Between fold events nothing else in your context changes, so that result is where the picture lives. Mark freely as you work; when to fold is the runtime's to decide, and unmark withdraws a mark you no longer want."
    : "";
  const recoveryGuidance = input.allowedActions.includes("expand")
    ? " A fold brief is an index entry, not the source: when a question or task depends on material that is folded, peek or expand that fold and answer from the exact bytes, never from memory of them. Recalling folded detail without reopening it is how specifics get misremembered."
    : "";
  const standingGuidance = " Folding is automatic, lossless and recoverable: the runtime folds stale spans on its own when the window needs room, nothing is ever discarded, and every folded span keeps its exact source. You are never asked to make room and no fold is ever announced in advance. Work normally and let it happen.";
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, fold, expand, refold, protect, rebrief, or re-cut exact Pi active-context evidence.${peekGuidance}${correctionGuidance}${pinGuidance}${epochGuidance}${recoveryGuidance}${standingGuidance} Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard ${input.maxBriefChars}-character maximum.`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${peekGuidance}${correctionGuidance}${pinGuidance}${epochGuidance}${recoveryGuidance}${standingGuidance} Call fold only by copying the exact eligibleChapter.action returned by status; if status has no eligibleChapter, continue the task without folding. Supplied fold briefs have a hard ${input.maxBriefChars}-character maximum.`,
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
              brief: {
                type: "string",
                minLength: 1,
                maxLength: input.maxBriefChars,
                description: "Write one for every span you mark. You know why the span mattered and " +
                  "what you will want back from it; the deterministic brief that fills the gap " +
                  "reads the span alone and does not.",
              },
            },
          },
        },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: input.maxBriefChars,
          description: `Factual fold brief, at most ${input.maxBriefChars} characters.`,
        },
        offset: { type: "integer", minimum: 0 },
        ephemeral: {
          type: "boolean",
          description: "Peek only: the returned bytes ride your context exactly until your " +
            "next message, then their place holds a one-line placeholder and your reply is " +
            "the surviving trace. Default false: the result stays like any other tool result.",
        },
        bytes: {
          type: "integer",
          minimum: input.minPeekSliceBytes,
          description: `Peek only: bytes of exact source to return, widening or narrowing the ${input.defaultPeekBytes}-byte default.`,
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
      description: "Losslessly fold a stale context span, or \"commit\" to apply every eligible mark now; " +
        "works without a main-model request",
      handler: input.foldHandler,
    },
  ];
}
