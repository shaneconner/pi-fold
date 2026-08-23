// The literal classes both halves of the compaction measurement judge carriage by.
//
// ONE DEFINITION, TWO CONSUMERS. `analyze_compaction_loss.mjs` reads what native's summary
// dropped and `analyze_fold_counterfactual.mjs` reads what folding's projection kept, and
// the only reason those two numbers can be put beside each other is that they are counting
// the same things. A second copy of these regexes is a silent divergence waiting to happen,
// and it would land in exactly the comparison the whole analysis rests on.
//
// Each class is chosen because later work must reproduce it EXACTLY or be wrong: a path that
// comes back with one segment changed does not open, an identifier recalled with different
// casing does not resolve, a number recalled approximately is a wrong answer that looks like
// a right one. Prose can be paraphrased and stay true; none of these can.
export const LITERAL_PATTERNS = Object.freeze({
  path: /(?:[\w.-]+\/){1,}[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|toml|yaml|yml|py|rs|go|sh)/g,
  identifier: /\b(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*){1,}|[a-z][a-z0-9]*(?:_[a-z0-9]+){1,})\b/g,
  number: /(?<![\w.])\d{3,}(?![\w.])/g,
});

export const LITERAL_KINDS = Object.freeze(Object.keys(LITERAL_PATTERNS));

// Words so common in this domain that their presence says nothing about carriage.
export const LITERAL_STOPWORDS = new Set([
  "package_json", "node_modules", "use_strict", "to_string", "type_error",
]);

export function extractLiterals(text) {
  const found = { path: new Set(), identifier: new Set(), number: new Set() };
  for (const [kind, pattern] of Object.entries(LITERAL_PATTERNS)) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (kind === "identifier" && (value.length < 8 || LITERAL_STOPWORDS.has(value))) continue;
      found[kind].add(value);
    }
  }
  return found;
}

// Accumulate into caller-owned sets, so a long span is never joined into one string first.
// The counterfactual walks millions of characters per boundary and building that string to
// run a regex over it is measurement overhead charged to the thing being measured.
export function addLiterals(into, text) {
  for (const [kind, pattern] of Object.entries(LITERAL_PATTERNS)) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (kind === "identifier" && (value.length < 8 || LITERAL_STOPWORDS.has(value))) continue;
      into[kind].add(value);
    }
  }
  return into;
}

export const emptyLiterals = () => ({ path: new Set(), identifier: new Set(), number: new Set() });

// A transcript message rendered as the TEXT it contributes to a context window.
//
// IMAGES ARE NOT TEXT. A single screenshot rides in the session file as a base64 `data`
// field, and one span of the 2026-07-27 session carried five of them totalling 5,756,246
// characters. Stringifying those parts counted 1.4M tokens of base64 as if it were context,
// which put the fold arm 4.5x over the occupancy native actually reported and drove the
// projection fence to abort 49 requests. It also fed the literal regexes: base64 is full of
// mixed-case runs and digit runs, so the identifier and number classes were counting image
// bytes as facts. Skipped entirely, the way a provider that receives an image as an image
// rather than as a string does.
//
// Reasoning is skipped for the same reason it always was: it is not carried forward.
export function contextText(message) {
  const parts = message?.content ?? [];
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return JSON.stringify(parts ?? "");
  const out = [];
  for (const part of parts) {
    if (typeof part?.text === "string") out.push(part.text);
    else if (typeof part?.thinking === "string") continue;
    else if (part?.type === "image" || typeof part?.data === "string") continue;
    else out.push(JSON.stringify(part ?? ""));
  }
  return out.join("\n");
}

export const entryContextText = (entry) => contextText(entry?.message);
