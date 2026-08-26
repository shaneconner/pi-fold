/**
 * Wording rule for everything in this file: describe units of WORK, never units of
 * conversation. Text that presupposes turn-ending replies ("after the reply",
 * "between tasks") tells a single-turn staged agent that a reply is the natural next
 * move, and it rides in the tool surface of every request. It is the top unproven
 * suspect for the iteration-2 phase flips, and saying the true thing instead costs
 * nothing: the next model call that reads a result, a natural boundary in the work.
 */

import { MEMORY_BODY_CHARS, MEMORY_KEY_CHARS, MEMORY_KEYS_MAX } from "./policy.ts";

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
    ? ` Peek is the point read: it returns one fold's index view -- nested folds' briefs seated shallowest first inside the byte budget with the omitted rows counted, plus the head and tail of that fold's own span with the omitted middle stated -- for any fold id, ancestors still collapsed, changing nothing. It serves ONE level: raw entries come back exactly, folds nested inside stay placeheld, and peeking a child id you see there returns that child's own bytes, so anything folded is one hop away at any depth. It returns at most ${input.defaultPeekBytes} bytes unless you widen it with bytes, and it is EPHEMERAL by default: the bytes ride only until your next message, your reply then the surviving trace, so extract what your current task needs from them in that reply. Peeking again is lossless and costs one append, so a read you turn out to need twice is cheap; pass ephemeral false when you need the bytes standing across several turns. Expand is the durable in-place restoration.`
    : "";
  const correctionGuidance = input.allowedActions.includes("reboundary")
    ? " Curation is correctable: reboundary with ids re-cuts a span into exactly one fold, which merges adjacent folds when the span covers several and splits one when the span sits inside it. Reboundary with a single id returns that fold's span to raw. A brief is written when you mark the span; a standing fold's brief is not rewritten, because rewriting it rewrites the projection at that fold's placeholder and costs the whole prefix cache from there on."
    : "";
  const pinGuidance = input.allowedActions.includes("pin")
    ? " Pin with ids holds folds or entries against automatic folding, consolidation and refolding until unpin releases them, so an expanded span you still need stays expanded. Pin reveals nothing on its own: a folded span stays folded, just held. Pinning moves no context bytes, and fold receipts report how much mass you have pinned."
    : "";
  const epochGuidance = input.allowedActions.includes("brief")
    ? " THE RUNTIME CUTS THE FOLDS AND YOU ANNOTATE THEM. As raw material piles up it is cut into pending folds behind you, stalest first. A pending fold moves NO context bytes: you keep seeing the raw material exactly as it is, and the fold reaches your window only when a commit applies it. You are told when folds are cut and which ones carry no brief yet. Answer with brief, one id and one sentence: you know why the span mattered and what you will want back from it, and the deterministic brief that fills the gap reads the span alone and does not. Writing a brief on a pending fold is FREE, because the fold is not in your window yet; briefing a standing fold is refused, because its placeholder is in your window and rewriting it rewrites your context from that point on. reboundary re-cuts a span the runtime got wrong, unmark withdraws a cut you do not want taken, and when to commit stays the runtime's to decide."
    : "";
  const recoveryGuidance = input.allowedActions.includes("expand")
    ? " A fold brief is an index entry, not the source: when a question or task depends on material that is folded, peek or expand that fold and answer from the exact bytes, never from memory of them. Recalling folded detail without reopening it is how specifics get misremembered."
    : "";
  const memoryGuidance = input.allowedActions.includes("remember")
    ? ` WORKING MEMORY: a session-scoped dictionary you maintain beside the fold index. remember with key and body writes or updates an entry (${MEMORY_KEY_CHARS}-character keys, ${MEMORY_BODY_CHARS}-character bodies, ${MEMORY_KEYS_MAX} entries); an empty body removes it; recall with keys reads bodies back, or everything when keys is omitted. The bodies live outside your window: only a one-glance table of contents rides your context, refreshed at each commit, so writing an entry costs your window almost nothing. Keep entries current as the work moves: when a fact an entry records changes, or new information lands that belongs in one, update it then rather than at the end.`
    : "";
  const standingGuidance = " Folding is automatic, lossless and recoverable: the runtime folds stale spans on its own when the window needs room, nothing is ever discarded, and every folded span keeps its exact source. You are never asked to make room and no fold is ever announced in advance. Work normally and let it happen.";
  return {
    name: input.name,
    label: input.label,
    description: input.fullSurface
      ? `Page, peek, brief, expand, refold, pin, or re-cut exact Pi active-context evidence.${peekGuidance}${correctionGuidance}${pinGuidance}${epochGuidance}${recoveryGuidance}${memoryGuidance}${standingGuidance} Mutations persist immediately and affect the next model call inside the same continuing turn; no turn boundary is required. Supplied fold briefs have a hard ${input.maxBriefChars}-character maximum.`
      : `Use only the configured active-context actions: ${input.allowedActions.join(", ")}.${peekGuidance}${correctionGuidance}${pinGuidance}${epochGuidance}${recoveryGuidance}${memoryGuidance}${standingGuidance} Supplied fold briefs have a hard ${input.maxBriefChars}-character maximum.`,
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
          description: "Brief only: what you will want back from this pending fold that " +
            "its automatic brief cannot know. Your sentence is kept BESIDE the automatic " +
            `brief, never instead of it, at most ${input.maxBriefChars} characters. Free ` +
            "to write, because the fold it names is not in your window yet.",
        },
        offset: { type: "integer", minimum: 0 },
        ephemeral: {
          type: "boolean",
          description: "Peek only. Default TRUE: the returned bytes ride your context " +
            "exactly until your next message, then their place holds a one-line " +
            "placeholder and your reply is the surviving trace, so extract what you need " +
            "into that reply. Peeking again is lossless. Pass false to keep the result " +
            "standing like any other tool result, which is what you want when the bytes " +
            "have to survive several turns of work.",
        },
        bytes: {
          type: "integer",
          minimum: input.minPeekSliceBytes,
          description: `Peek only: bytes of exact source to return, widening or narrowing the ${input.defaultPeekBytes}-byte default.`,
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        detail: { type: "string", enum: [...input.statusDetails] },
        ...(input.allowedActions.includes("remember")
          ? {
            key: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_KEY_CHARS,
              description: "remember only: the working-memory entry to write, update or " +
                "(with an empty body) remove.",
            },
            body: {
              type: "string",
              maxLength: MEMORY_BODY_CHARS,
              description: "remember only: the entry's full text, replacing what the key " +
                "held. Empty removes the entry.",
            },
            keys: {
              type: "array",
              minItems: 1,
              maxItems: MEMORY_KEYS_MAX,
              items: { type: "string", minLength: 1 },
              description: "recall only: the working-memory entries to read. Omit to read " +
                "every entry.",
            },
          }
          : {}),
      },
    },
    execute: input.handler,
  };
}

export function buildActiveContextCommands(input: {
  statusName: string;
  foldName: string;
  editorName: string;
  statusHandler: CommandHandler;
  foldHandler: CommandHandler;
  editorHandler: CommandHandler;
}) {
  return [
    {
      name: input.statusName,
      description: "Show active-context fold roots and paging state",
      handler: input.statusHandler,
    },
    {
      name: input.foldName,
      description: "Commit every staged fold in one epoch; with explicit ids, folds exactly that span now; " +
        "works without a main-model request",
      handler: input.foldHandler,
    },
    {
      name: input.editorName,
      description: "Open the context window editor: occupancy, fold roots and briefs, staged marks, pins",
      handler: input.editorHandler,
    },
  ];
}
