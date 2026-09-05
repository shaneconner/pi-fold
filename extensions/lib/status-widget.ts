/**
 * THE FOLD BAR: one widget row above the footer, drawn by us rather than by the host.
 *
 * The always-on status line is a STRING handed to `ctx.ui.setStatus`, and everything a
 * bar would need is denied to a string: the host sorts statuses by key and joins them,
 * collapses runs of spaces, truncates from the right, and bakes ANSI that goes stale on a
 * theme switch. `ctx.ui.setWidget` hands us a component instead: `render(width)` receives
 * the terminal width, the row is ours alone, and the theme is read at render time so a
 * `/theme` switch repaints it. Placed below the editor it sits directly above the footer,
 * which is where Claude Code draws the same bar.
 *
 * WHAT THE BAR ARGUES: how full the window is against the two points where something
 * happens to it. The fill is read against ticks ON the bar at the aim (minTarget) and the
 * commit point (maxTarget). Inside the fill, oldest on the left: `▂` for the placeholders
 * of standing folds, `▓` for staged raw spans (what the next commit collapses), `▇` for
 * raw the ladder has not claimed. The label states what folding has already bought.
 *
 * THE BAR IS A FIXED WIDTH. A bar sized to the leftover width moves the commit tick
 * between renders, and the tick is the landmark the whole row exists to place the fill
 * against. What varies with the terminal is the label, cut from the right.
 *
 * WHAT IT WILL NOT DRAW: an unmeasured window (an empty bar is a guess drawn; law 2 of
 * the human surfaces), a suspended session (no bar promising a commit beside FOLDING
 * STOPPED; law 5), fold positions (a placeholder is a few hundred tokens against cells of
 * tens of thousands), and fold depth, which /fold-editor shows with a row per fold.
 *
 * COLOUR: raw, staged and folded form an ordered ladder of how much of the window each
 * state costs, so they are three classes sampled off Crameri's batlow, a perceptually
 * uniform, colour-vision-deficiency-safe sequential map; on a 256-colour terminal they
 * fall back to the theme's own names. Scaffolding (empty cells, the aim tick, the brand)
 * stays on the theme's dim ink; the commit tick takes the theme's warning colour, which
 * is what the host uses for its own context percentage past 70.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";

export const FOLD_BAR_WIDTH = 40;

/**
 * THE BAR IS A MAP (Shane 2026-09-05: "the scores were intended only to be in there to
 * show the fold marks"). Segments arrive in WINDOW ORDER, oldest first, each priced in
 * tokens by the image law, and the fill is scaled so the measured occupancy fills exactly
 * the cells the provider's count says it should. A cell takes the kind covering most of
 * it. A SCORE (the seven-eighths block, an eighth of the cell empty on the right) is drawn
 * only where a staged mark ENDS inside the cell; a solid block means no boundary here. A
 * cell can hold several boundaries and shows one score: a score means "at least one mark
 * ends here", never a count.
 */
export type SegmentKind =
  | "fold-span" | "fold-truncation" | "fold-consolidation"
  | "staged-span" | "staged-truncation"
  | "raw" | "pinned";

export interface BarSegment {
  kind: SegmentKind;
  /** Priced tokens this stretch of the window occupies. */
  tokens: number;
  /** A staged mark or a standing fold ends with this segment; the cell it falls in is scored. */
  markEnd?: boolean;
}

/** Everything the row reads. Built by the runtime on every status update. */
export interface FoldBarModel {
  brand: string;
  /** The provider's own count against the serving budget, or null when unmeasured. */
  share: number | null;
  /** maxTarget and minTarget of the live thresholds, as shares. */
  commitShare: number;
  aimShare: number;
  /** The window in order, oldest first, as priced segments. */
  segments: BarSegment[];
  stagedMarks: number;
  stagedSpans: number;
  stagedTruncations: number;
  stagedTokens: number;
  /** Visible roots, split by kind, and every fold in the forest. */
  folds: number;
  foldSpans: number;
  foldTruncations: number;
  foldConsolidations: number;
  totalFolds: number;
  /** Tokens the standing folds hide: source minus placeholder, summed over the forest. */
  hiddenTokens: number;
  /** Entries held raw on purpose. */
  pinnedRefs: number;
  /** Whether a band-top commit has already been weighed against the current count. */
  weighed: boolean;
  /** A commit landed after the count `share` reads; the number is from before it. */
  staleAfterCommit: boolean;
  /** The suspension message when automatic folding has stopped, else null. */
  stopped: string | null;
}

/** The subset of pi's Theme the row uses. */
export interface FoldBarTheme {
  fg(color: "dim" | "muted" | "text" | "warning" | "error" | "accent", text: string): string;
  bold(text: string): string;
  getColorMode?(): "truecolor" | "256color";
  getFgAnsi?(color: "text"): string;
  name?: string;
}

// Crameri batlow10 classes per background, raw at the dark end, staged marks in the
// middle, standing folds at the light end. THE PAIRS SIT A RUNG APART WITH A RUNG
// BETWEEN (Shane 2026-09-05: adjacent rungs were "a tad too close"): staged truncation
// olive against staged span peach, fold span pink against fold consolidation lilac, and
// the consolidation sliver is also drawn a step taller. The same inks colour the kind
// words on the label, so the text is the legend. The lightest classes vanish on white,
// so a light terminal steps the ladder darker.
const BATLOW_ON_DARK = {
  raw: "#3C6D56", "staged-truncation": "#9D892B", "staged-span": "#F8A17B",
  "fold-truncation": "#D29343", "fold-span": "#FDB7BC", "fold-consolidation": "#FACCFA",
} as const;
const BATLOW_ON_LIGHT = {
  raw: "#1C5A62", "staged-truncation": "#687B3E", "staged-span": "#D29343",
  "fold-truncation": "#9D892B", "fold-span": "#F8A17B", "fold-consolidation": "#FDB7BC",
} as const;

/**
 * WHICH WAY THE BACKGROUND GOES, read off the theme's own text colour rather than its
 * name: a theme whose body text is dark is drawn on a light background. pi hands the
 * text colour out as a truecolor escape, and a theme that does not (256-colour mode,
 * or a host without the accessor) falls back to the name, then to dark.
 */
export function lightBackground(theme: FoldBarTheme): boolean {
  try {
    const ansi = theme.getFgAnsi?.("text") ?? "";
    const match = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
    if (match) {
      const [r, g, b] = match.slice(1).map((v) => Number(v) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
    }
  } catch { }
  return /light/i.test(theme.name ?? "");
}

const truecolor = (hex: string, text: string): string => {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export interface BarCell { kind: SegmentKind | "empty"; scored: boolean }

/**
 * The cells, oldest on the left. The measured share fixes how many cells are filled; the
 * segments' priced tokens fix where each kind falls INSIDE that fill, so an estimate
 * places things and the provider's count sizes them. A pin is drawn at least one cell
 * wide, the one deliberate overstatement on the bar, because two pinned entries are a
 * fraction of a cell and would otherwise vanish.
 */
export function foldBarCells(model: FoldBarModel, width: number = FOLD_BAR_WIDTH): BarCell[] {
  const share = model.share ?? 0;
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  const cells: BarCell[] = Array.from({ length: width }, () => ({ kind: "empty", scored: false }));
  const total = model.segments.reduce((sum, segment) => sum + Math.max(0, segment.tokens), 0);
  if (filled === 0) return cells;
  // THE MEASURED FILL IS DRAWN WHATEVER THE WALK FOUND. Before the first context event
  // there is no snapshot to walk, and a session reloaded at 55% drew one sliver and
  // thirty-nine empty cells (Shane, 2026-09-05): the provider's count is a fact and an
  // empty bar beside it is a guess drawn. With nothing to class, the fill is raw.
  if (total <= 0) {
    for (let cell = 0; cell < filled; cell += 1) cells[cell].kind = "raw";
    return cells;
  }
  const scale = filled / total;
  const coverage: Array<Map<SegmentKind, number>> = Array.from({ length: filled }, () => new Map());
  let position = 0;
  for (const segment of model.segments) {
    const start = position;
    const end = position + Math.max(0, segment.tokens) * scale;
    position = end;
    for (let cell = Math.floor(start); cell < Math.min(filled, Math.ceil(end)); cell += 1) {
      const overlap = Math.min(end, cell + 1) - Math.max(start, cell);
      if (overlap <= 0) continue;
      const map = coverage[cell];
      map.set(segment.kind, (map.get(segment.kind) ?? 0) + overlap);
    }
    if (segment.markEnd) {
      const cell = Math.min(filled - 1, Math.max(0, Math.ceil(end) - 1));
      cells[cell].scored = true;
    }
  }
  // THE MARKS WIN THE CELL. A cell is tens of thousands of tokens and a mark a few
  // thousand, so "the kind covering most of the cell" painted every marked cell raw and
  // the truncations Shane asked to see were scored but green (2026-09-05). Raw fills only
  // a cell nothing else touches; among the rest, the widest coverage wins.
  for (let cell = 0; cell < filled; cell += 1) {
    let best: SegmentKind = "raw";
    let bestCover = -1;
    for (const [kind, cover] of coverage[cell]) {
      if (kind === "raw") continue;
      if (cover > bestCover) { best = kind; bestCover = cover; }
    }
    cells[cell].kind = best;
  }
  const pinnedTokens = model.segments.filter((segment) => segment.kind === "pinned")
    .reduce((sum, segment) => sum + segment.tokens, 0);
  if (pinnedTokens > 0 && !cells.some((cell) => cell.kind === "pinned")) {
    // Place the guaranteed pinned cell where the pinned mass actually sits.
    let at = 0;
    let seen = 0;
    for (const segment of model.segments) {
      if (segment.kind === "pinned") { at = Math.min(filled - 1, Math.floor(seen * scale)); break; }
      seen += Math.max(0, segment.tokens);
    }
    cells[at].kind = "pinned";
  }
  return cells;
}

/** Tick positions: the cell whose right edge is the share. */
export function foldBarTicks(model: FoldBarModel, width: number = FOLD_BAR_WIDTH): Map<number, "aim" | "commit"> {
  const at = (share: number): number => Math.max(0, Math.min(width - 1, Math.round(share * width) - 1));
  const ticks = new Map<number, "aim" | "commit">();
  ticks.set(at(model.aimShare), "aim");
  ticks.set(at(model.commitShare), "commit");
  return ticks;
}

/** The row without colour, for tests and for a host that strips ANSI. */
export function foldBarPlainText(model: FoldBarModel): string {
  return renderFoldBar(model, Number.POSITIVE_INFINITY, {
    fg: (_c, t) => t, bold: (t) => t,
  });
}

export function renderFoldBar(model: FoldBarModel, width: number, theme: FoldBarTheme): string {
  const brand = theme.fg("dim", model.brand);
  if (model.stopped) {
    const line = `${brand} ${theme.fg("error", theme.bold("FOLDING STOPPED"))}` +
      (model.share === null ? "" : theme.fg("text", ` · ${Math.round(model.share * 100)}% full`));
    return truncateToWidth(line, width, theme.fg("dim", "..."));
  }
  if (model.share === null) {
    return truncateToWidth(
      `${brand} ${theme.fg("muted", `not measured yet · folds automatically at ${Math.round(model.commitShare * 100)}%`)}`,
      width, theme.fg("dim", "..."));
  }
  const rich = theme.getColorMode?.() === "truecolor";
  const palette = lightBackground(theme) ? BATLOW_ON_LIGHT : BATLOW_ON_DARK;
  const ink = (kind: SegmentKind | "empty", text: string): string => {
    if (kind === "empty") return theme.fg("dim", text);
    if (kind === "pinned") return theme.fg("accent", text);
    if (rich) return truecolor(palette[kind], text);
    if (kind === "raw") return theme.fg("muted", text);
    if (kind.startsWith("staged")) return theme.fg("text", text);
    return theme.fg("dim", text);
  };
  // A SCORE IS A QUARTER GAP (Shane 2026-09-05: the eighth gap of U+2589 did not read at
  // his font): a scored full cell is U+258A, three quarters wide. A scored sliver is the
  // lower-left quadrant U+2596, half wide and half high, so a fold's edge shows the same
  // gap; a consolidation sliver is a step taller (U+2583 against U+2582) where it is not
  // scored, and its ink and the label carry the kind where it is.
  const glyph = (cell: BarCell): string => {
    if (cell.kind === "empty") return "░";
    if (cell.kind.startsWith("fold")) return cell.scored ? "▖" : cell.kind === "fold-consolidation" ? "▃" : "▂";
    return cell.scored ? "▊" : "█";
  };
  // THE KIND WORDS TAKE THEIR CELL INKS, named only when more than one kind is present.
  const kindClause = (parts: Array<[number, string, SegmentKind]>): string => {
    const named = parts.filter(([count]) => count > 0)
      .map(([count, noun, kind]) => ink(kind, `${count} ${noun}${count === 1 ? "" : "s"}`));
    return named.length > 1 ? ` (${named.join(theme.fg("dim", ", "))})` : "";
  };
  const cells = foldBarCells(model);
  const ticks = foldBarTicks(model);
  let bar = "";
  for (let i = 0; i < cells.length; i += 1) {
    const tick = ticks.get(i);
    // THE TICKS ARE OFF THE LADDER AND OFF THE FILL'S WEIGHT (Shane 2026-09-05): the commit
    // point is a heavy bar and the aim a dotted one, both in the theme's own text ink,
    // which no fill class uses, so they read as the frame the fill sits in.
    if (tick === "commit") bar += theme.fg("text", theme.bold("┃"));
    else if (tick === "aim") bar += theme.fg("text", "┆");
    else bar += ink(cells[i].kind, glyph(cells[i]));
  }
  const pct = Math.round(model.share * 100);
  const parts: string[] = [];
  // A READING FROM BEFORE THE COMMIT SAYS SO. The count only moves when the provider
  // answers, so right after a commit the bar showed the pre-commit percentage in the
  // same type as a live one and read as a commit that did nothing. No estimate is
  // drawn in its place: the freed bytes are transcript mass and the arithmetic would
  // go negative against the window.
  if (model.staleAfterCommit) {
    parts.push(theme.fg("muted", `${pct}% before the commit`));
  } else {
    parts.push(theme.fg("text", `${pct}%`));
    if (model.share < model.commitShare) parts.push(theme.fg("muted", `commit at ${Math.round(model.commitShare * 100)}%`));
    // NOT AN ALARM (Shane 2026-09-05: "reads as the user should do something"). The commit
    // is the runtime's to make; the row states where the window stands, in muted ink.
    else if (model.weighed) parts.push(theme.fg("muted", "commit held"));
    else parts.push(theme.fg("muted", "at commit point"));
  }
  // THE COUNT, ITS KINDS AND ITS TOKENS. Spans are chapters of the conversation and
  // truncations are tool results (Shane's word for the tool compression, 2026-09-05);
  // the kinds are named only when both are present. The tokens are what the staged cells
  // draw, priced by the image law, with the unit written out because k/M read as megabytes.
  if (model.stagedMarks > 0) {
    const kinds = kindClause([[model.stagedSpans, "span", "staged-span"], [model.stagedTruncations, "truncation", "staged-truncation"]]);
    const tokens = model.stagedTokens > 0 ? ink("staged-span", `, ${formatTokens(model.stagedTokens)} tokens`) : "";
    parts.push(`${ink("staged-span", `${model.stagedMarks} staged`)}${kinds}${tokens}`);
  }
  if (model.pinnedRefs > 0) parts.push(ink("pinned", `${model.pinnedRefs} pinned`));
  if (model.folds > 0) {
    const kinds = kindClause([
      [model.foldSpans, "span", "fold-span"], [model.foldTruncations, "truncation", "fold-truncation"],
      [model.foldConsolidations, "consolidation", "fold-consolidation"],
    ]);
    // The nested count is what consolidation made, so it wears the consolidation ink.
    const nested = model.totalFolds > model.folds ? ink("fold-consolidation", `, ${model.totalFolds} nested`) : "";
    parts.push(`${ink("fold-span", `${model.folds} fold${model.folds === 1 ? "" : "s"}`)}${kinds}${nested}` +
      ink("fold-span", ` hide ${formatTokens(model.hiddenTokens)} tokens`));
  }
  // NO BRAND IN FRONT OF THE BAR (Shane 2026-09-02): the bar identifies itself, and the
  // two prose states above keep the brand because nothing else on them says whose they are.
  const line = `${bar} ${parts.join(theme.fg("dim", " · "))}`;
  return truncateToWidth(line, width, theme.fg("dim", "..."));
}
