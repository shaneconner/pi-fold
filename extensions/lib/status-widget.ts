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

/** Everything the row reads. Built by the runtime on every status update. */
export interface FoldBarModel {
  brand: string;
  /** The provider's own count against the serving budget, or null when unmeasured. */
  share: number | null;
  /** maxTarget and minTarget of the live thresholds, as shares. */
  commitShare: number;
  aimShare: number;
  /** Share of the budget standing marks would free at the next commit (estimated). */
  stagedShare: number;
  stagedMarks: number;
  stagedTokens: number;
  /** Share of the budget the standing folds' placeholders occupy (estimated). */
  foldedShare: number;
  folds: number;
  /** Tokens the standing folds hide: source minus placeholder, summed over the forest. */
  hiddenTokens: number;
  /** Whether a band-top commit has already been weighed against the current count. */
  weighed: boolean;
  /** A commit landed after the count `share` reads; the number is from before it. */
  staleAfterCommit: boolean;
  /** The suspension message when automatic folding has stopped, else null. */
  stopped: string | null;
}

/** The subset of pi's Theme the row uses. */
export interface FoldBarTheme {
  fg(color: "dim" | "muted" | "text" | "warning" | "error", text: string): string;
  bold(text: string): string;
  getColorMode?(): "truecolor" | "256color";
  getFgAnsi?(color: "text"): string;
  name?: string;
}

// Crameri batlow10, three classes per background. Classes 3, 6 and 8 (0-indexed) read on
// a dark terminal; the lightest of them is 1.7:1 against white, so a light terminal steps
// two classes darker (2, 5 and 6), the same triple the README's light figure uses.
const BATLOW_ON_DARK = { raw: "#3C6D56", staged: "#D29343", folded: "#FDB7BC" } as const;
const BATLOW_ON_LIGHT = { raw: "#1C5A62", staged: "#9D892B", folded: "#D29343" } as const;

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

type Cell = "folded" | "staged" | "raw" | "empty";
// SCORED CELLS (Shane 2026-09-03): the README figure draws every cell as its own rectangle
// with a hairline gap, and the full-width block fused adjacent cells into one solid run,
// so the terminal read as a different figure. The left seven-eighths block leaves an
// eighth of each cell empty on the right, which is the same score in a glyph. Staged and
// raw share the glyph and differ by colour; the shade glyph is gone because at a small
// font its texture read as a solid block anyway.
const GLYPH: Record<Cell, string> = { folded: "▂", staged: "▉", raw: "▉", empty: "░" };

/** The bar's cells, oldest on the left, before any tick is laid over them. */
export function foldBarCells(model: FoldBarModel, width: number = FOLD_BAR_WIDTH): Cell[] {
  const share = model.share ?? 0;
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  const folded = Math.min(filled, Math.round(model.foldedShare * width));
  const staged = Math.min(filled - folded, Math.round(model.stagedShare * width));
  const cells: Cell[] = [];
  for (let i = 0; i < width; i += 1) {
    if (i < folded) cells.push("folded");
    else if (i < folded + staged) cells.push("staged");
    else if (i < filled) cells.push("raw");
    else cells.push("empty");
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
  const BATLOW = lightBackground(theme) ? BATLOW_ON_LIGHT : BATLOW_ON_DARK;
  const ink: Record<Cell, (text: string) => string> = {
    raw: (t) => rich ? truecolor(BATLOW.raw, t) : theme.fg("muted", t),
    staged: (t) => rich ? truecolor(BATLOW.staged, t) : theme.fg("text", t),
    folded: (t) => rich ? truecolor(BATLOW.folded, t) : theme.fg("dim", t),
    empty: (t) => theme.fg("dim", t),
  };
  const cells = foldBarCells(model);
  const ticks = foldBarTicks(model);
  let bar = "";
  for (let i = 0; i < cells.length; i += 1) {
    const tick = ticks.get(i);
    if (tick === "commit") bar += theme.fg("warning", "│");
    else if (tick === "aim") bar += theme.fg("dim", "│");
    else bar += ink[cells[i]](GLYPH[cells[i]]);
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
    else if (model.weighed) parts.push(theme.fg("muted", "commit held"));
    else parts.push(theme.fg("warning", "COMMIT DUE"));
  }
  // THE COUNT AND THE TOKENS, BOTH, FOR WHAT IS STAGED. The staged cells draw the spans'
  // share of the budget and the count says how many spans, and a reader took the cells
  // for a count ("33 staged" over seven cells, Shane 2026-09-04); the token figure is
  // what joins them, and it is honest now that pricing follows the image law
  // (measurement.ts pricedBytes; "5.8M to free" beside a 1M window was 83 screenshots'
  // base64 counted as text). The unit is written out because pi's k/M read as megabytes.
  if (model.stagedMarks > 0) {
    parts.push(ink.staged(model.stagedTokens > 0
      ? `${model.stagedMarks} staged, ${formatTokens(model.stagedTokens)} tokens`
      : `${model.stagedMarks} staged`));
  }
  if (model.folds > 0) {
    parts.push(ink.folded(`${model.folds} fold${model.folds === 1 ? "" : "s"} hide ${formatTokens(model.hiddenTokens)} tokens`));
  }
  // NO BRAND IN FRONT OF THE BAR (Shane 2026-09-02): the bar identifies itself, and the
  // two prose states above keep the brand because nothing else on them says whose they are.
  const line = `${bar} ${parts.join(theme.fg("dim", " · "))}`;
  return truncateToWidth(line, width, theme.fg("dim", "..."));
}
