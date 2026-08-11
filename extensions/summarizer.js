const loadPiHost = () => import("@earendil-works/pi-coding-agent");

function normalizeSummarizer(summarizer) {
  // "deterministic" was a way to select the FAILURE PATH on purpose. Every summarizer
  // failure already falls back to the deterministic brief, so the value bought nothing a
  // failure does not, while reading as a third generator a deployment had to choose
  // between. The generator stays; the value that named it does not.
  if (summarizer === "deterministic") {
    throw new Error('summarizer has no "deterministic" value: the deterministic brief is the ' +
      "automatic fallback whenever a summarizer fails, not a mode to select");
  }
  if (summarizer === "session") return summarizer;
  if (!summarizer || typeof summarizer !== "object" || Array.isArray(summarizer) ||
      typeof summarizer.provider !== "string" || !summarizer.provider ||
      typeof summarizer.model !== "string" || !summarizer.model ||
      (summarizer.effort !== undefined &&
        (typeof summarizer.effort !== "string" || !summarizer.effort))) {
    throw new Error(
      'summarizer must be "session" or an object with nonempty provider and model strings',
    );
  }
  return {
    provider: summarizer.provider,
    model: summarizer.model,
    ...(summarizer.effort === undefined ? {} : { effort: summarizer.effort }),
  };
}

/**
 * The runtime hands the generator two BOUNDED orientation slices beside the span: up to
 * two messages and 12,000 characters either side, hashed into the fold identity. They are
 * labelled distinctly here rather than pasted in, because a model that cannot tell the
 * span from its surroundings briefs the surroundings. An absent slice arrives as the
 * empty-orientation literal, and a label with "[]" under it reads as content.
 */
const EMPTY_ORIENTATION = "[]";

function orientationBlock(label, text) {
  return typeof text === "string" && text && text !== EMPTY_ORIENTATION
    ? `${label}:\n${text}`
    : `${label}: none.`;
}

/**
 * A brief does two jobs at once, so the request says both: it summarizes the span, and it
 * tells the agent what expanding or peeking that fold would return, which is the whole
 * basis on which the agent decides to dig back in. Naming the concrete contents is what
 * makes the second job possible: an abstract description of a span is not a statement of
 * what is recoverable from it.
 */
/**
 * A GROUP is briefed under one extra rule: every child gets a share.
 *
 * A parent is what the ladder builds when folds pile up, and its brief is the only index
 * of what the group holds. A brief that covers the first two children richly and drops the
 * other eight closes them: the agent has no way to know the eighth is in there, so it never
 * expands to find out. Coverage beats depth at this rung, and the children are numbered in
 * the payload so "every one of them" is a countable instruction rather than a wish.
 */
function groupCoverageRule(children) {
  return `The span is a GROUP of ${children} folded children, numbered 1 to ${children} ` +
    "below, each with its own brief and then its contents; folds nested inside a child " +
    "stay folded and appear as placeholders, and a child marked collapsed shows only its " +
    "brief. Your brief is the only index of this group, so give EVERY one of the " +
    `${children} children a share of it: name what each one holds in the order they ` +
    "appear. A child you leave out is a child the agent cannot know to look for. Prefer " +
    "one concrete clause per child over a full account of the first few.";
}

function briefRequestPrompt(request) {
  const children = Number.isInteger(request.children) && request.children > 1
    ? request.children
    : 0;
  return [
    `Write a factual brief of at most ${request.maxBriefChars} characters covering the ` +
    "SPAN TO BRIEF below, and nothing else. The brief does two jobs at once: it " +
    "summarizes what the span contains, and it tells an agent what it would get back by " +
    "expanding or peeking this fold later, so the agent can decide whether to dig back " +
    "in. Once the span is folded the brief is its only visible trace, so name the " +
    "concrete things inside it: files, identifiers, decisions, results, errors. Do not " +
    "describe the span abstractly. The BEFORE and AFTER sections are orientation only: " +
    "they say where the span sits in the larger conversation, and their content is not " +
    "part of what you are briefing. Use no preamble and no Markdown headers." +
    (children ? `\n\n${groupCoverageRule(children)}` : ""),
    orientationBlock("BEFORE THE SPAN (orientation only, do not brief)", request.beforeText),
    `SPAN TO BRIEF:\n${request.sourceText}`,
    orientationBlock("AFTER THE SPAN (orientation only, do not brief)", request.afterText),
    // A second ask, and the only reason there is one: the first answer missed a criterion
    // this request stated, and the caller would otherwise have to cut the brief itself.
    ...(typeof request.cure === "string" && request.cure
      ? [`YOUR PREVIOUS ANSWER DID NOT MEET THE CRITERIA. ${request.cure}\nWrite the brief again.`]
      : []),
  ].join("\n\n");
}

export function createSummarizeContextSpan(summarizer = "session", loadHostModule = loadPiHost) {
  const configured = normalizeSummarizer(summarizer);
  if (typeof loadHostModule !== "function") {
    throw new Error("Summarizer host-module loader must be a function");
  }

  let runtimePromise;
  const getRuntime = () => {
    runtimePromise ??= Promise.resolve().then(async () => {
      const host = await loadHostModule();
      if (typeof host?.ModelRuntime?.create !== "function") {
        throw new Error("Pi host module does not export ModelRuntime.create()");
      }
      return host.ModelRuntime.create();
    });
    return runtimePromise;
  };

  return async (request, ctx) => {
    if (typeof request?.sourceText !== "string" ||
        !Number.isInteger(request?.maxBriefChars) || request.maxBriefChars < 1) {
      throw new Error("Summarizer request requires sourceText and a positive maxBriefChars integer");
    }

    let model;
    if (configured === "session") {
      if (ctx?.model === undefined) {
        throw new Error("Session summarizer requires an active session model");
      }
      model = ctx.model;
    } else {
      const runtime = await getRuntime();
      model = runtime.getModel(configured.provider, configured.model);
      if (!model) {
        throw new Error(`Summarizer model '${configured.provider}/${configured.model}' was not found`);
      }
    }

    const runtime = await getRuntime();
    const effort = configured !== "session" && configured.effort !== undefined
      ? configured.effort
      : typeof ctx?.thinkingLevel === "string" && ctx.thinkingLevel
        ? ctx.thinkingLevel
        : "none";
    const prompt = briefRequestPrompt(request);
    const completionOptions = { maxTokens: 512, signal: request.signal };
    if (model.reasoning && effort !== "none" && effort !== "off") {
      completionOptions.reasoning = effort;
    }
    const response = await runtime.completeSimple(model, {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, completionOptions);
    const brief = Array.isArray(response?.content)
      ? response.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim()
      : "";
    if (!brief) throw new Error("Summarizer returned no text");
    if (typeof model.provider !== "string" || !model.provider ||
        typeof model.id !== "string" || !model.id) {
      throw new Error("Resolved summarizer model lacks provider/id attribution");
    }
    // The generator bills outside the session, so this is the ONLY place its spend is
    // visible. Passed through when the provider reports it and omitted when it does not,
    // never defaulted to zero: an absent number and a free call are different facts.
    const usage = response?.usage && typeof response.usage === "object"
      ? {
        ...(Number.isFinite(response.usage.input) ? { input: response.usage.input } : {}),
        ...(Number.isFinite(response.usage.output) ? { output: response.usage.output } : {}),
        ...(Number.isFinite(response.usage.cacheRead) ? { cacheRead: response.usage.cacheRead } : {}),
        ...(Number.isFinite(response.usage.totalTokens) ? { totalTokens: response.usage.totalTokens } : {}),
        ...(Number.isFinite(response.usage?.cost?.total) ? { costTotal: response.usage.cost.total } : {}),
      }
      : null;
    return {
      brief,
      provider: model.provider,
      model: model.id,
      effort,
      toolCalls: 0,
      ...(usage && Object.keys(usage).length ? { usage } : {}),
    };
  };
}
