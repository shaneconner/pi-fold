const loadPiHost = () => import("@earendil-works/pi-coding-agent");

function normalizeSummarizer(summarizer) {
  if (summarizer === "session" || summarizer === "deterministic") return summarizer;
  if (!summarizer || typeof summarizer !== "object" || Array.isArray(summarizer) ||
      typeof summarizer.provider !== "string" || !summarizer.provider ||
      typeof summarizer.model !== "string" || !summarizer.model ||
      (summarizer.effort !== undefined &&
        (typeof summarizer.effort !== "string" || !summarizer.effort))) {
    throw new Error(
      'summarizer must be "session", "deterministic", or an object with nonempty provider and model strings',
    );
  }
  return {
    provider: summarizer.provider,
    model: summarizer.model,
    ...(summarizer.effort === undefined ? {} : { effort: summarizer.effort }),
  };
}

export function createSummarizeContextSpan(summarizer = "session", loadHostModule = loadPiHost) {
  const configured = normalizeSummarizer(summarizer);
  if (configured === "deterministic") return undefined;
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
    const prompt = `Write a factual brief of at most ${request.maxBriefChars} characters. ` +
      `Use no preamble and no Markdown headers.\n\n${request.sourceText}`;
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
    return {
      brief,
      provider: model.provider,
      model: model.id,
      effort,
      toolCalls: 0,
    };
  };
}
