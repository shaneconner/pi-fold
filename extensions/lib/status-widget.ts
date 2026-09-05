/** One full-height usage bar, coloured by six disjoint content categories. */
import { truncateToWidth } from "@earendil-works/pi-tui";

export const FOLD_BAR_WIDTH = 40;
// The first half of Batlow is compressed; the second half is still raw.
export const FOLD_BAR_KINDS = ["consolidated", "span", "tool", "pinned", "marked", "raw"] as const;
export type FoldBarKind = typeof FOLD_BAR_KINDS[number];
export type FoldBarMass = Record<FoldBarKind, number>;
export const emptyFoldBarMass = (): FoldBarMass => ({ consolidated: 0, span: 0, tool: 0, pinned: 0, marked: 0, raw: 0 });

export interface FoldBarModel {
  brand: string;
  share: number | null;
  commitShare: number;
  aimShare: number;
  /** Estimated visible mass, counted exactly once, in the category order above. */
  mass: FoldBarMass;
  mapped: boolean;
  folds: number;
  foldSpans: number;
  foldTruncations: number;
  foldConsolidations: number;
  pinnedRefs: number;
  stagedMarks: number;
  unplacedItems: number;
  weighed: boolean;
  staleAfterCommit: boolean;
  stopped: string | null;
}
export interface FoldBarTheme {
  fg(color: "dim" | "muted" | "text" | "warning" | "error" | "accent", text: string): string;
  bold(text: string): string;
  getColorMode?(): "truecolor" | "256color";
  getFgAnsi?(color: "text"): string;
  name?: string;
}

// Batlow samples at 0, .2, .4 | .6, .8, 1, in the requested category order.
// Static foreground lightness adjustments retain readable labels on dark/white
// reference backgrounds. No palette generator or new dependency ships.
const ON_DARK: Record<FoldBarKind, string> = {
  consolidated: "#6C89C7", span: "#5B919F", tool: "#729261",
  pinned: "#B38E2F", marked: "#FBA689", raw: "#FACCFA",
};
const ON_LIGHT: Record<FoldBarKind, string> = {
  consolidated: "#011959", span: "#185562", tool: "#577647",
  pinned: "#927012", marked: "#AA624A", raw: "#8F6891",
};

export function lightBackground(theme: FoldBarTheme): boolean {
  try {
    const match = /38;2;(\d+);(\d+);(\d+)/.exec(theme.getFgAnsi?.("text") ?? "");
    if (match) {
      const [r, g, b] = match.slice(1).map((v) => Number(v) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
    }
  } catch { }
  return /light/i.test(theme.name ?? "");
}
const truecolor = (hex: string, text: string): string => {
  const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `\x1b[38;2;${rgb.join(";")}m${text}\x1b[39m`;
};

/** Total fill is measured; the composition within it is estimated and grouped by kind.
 * No minimum-width items, boundary marks, or forced cells. Tiny shares can round away.
 */
export function foldBarCells(model: FoldBarModel, width = FOLD_BAR_WIDTH): Array<FoldBarKind | "empty" | "unknown"> {
  const filled = Math.max(0, Math.min(width, Math.round((model.share ?? 0) * width)));
  const total = FOLD_BAR_KINDS.reduce((sum, kind) => sum + model.mass[kind], 0);
  const cells: Array<FoldBarKind | "empty" | "unknown"> = [];
  let kindIndex = 0;
  let cumulative = model.mass[FOLD_BAR_KINDS[0]];
  for (let i = 0; i < width; i += 1) {
    if (i >= filled) { cells.push("empty"); continue; }
    if (!model.mapped || total <= 0) { cells.push("unknown"); continue; }
    const midpoint = (i + 0.5) * total / filled;
    while (kindIndex < FOLD_BAR_KINDS.length - 1 && cumulative < midpoint) {
      cumulative += model.mass[FOLD_BAR_KINDS[++kindIndex]];
    }
    cells.push(FOLD_BAR_KINDS[kindIndex]);
  }
  return cells;
}
export function foldBarTicks(model: FoldBarModel, width = FOLD_BAR_WIDTH): Map<number, "aim" | "commit"> {
  const at = (share: number): number => Math.max(0, Math.min(width - 1, Math.round(share * width) - 1));
  return new Map([[at(model.aimShare), "aim"], [at(model.commitShare), "commit"]]);
}
export function foldBarPlainText(model: FoldBarModel): string {
  return renderFoldBar(model, Number.POSITIVE_INFINITY, { fg: (_c, t) => t, bold: (t) => t });
}

export function renderFoldBar(model: FoldBarModel, width: number, theme: FoldBarTheme): string {
  const cut = (text: string): string => truncateToWidth(text, width, theme.fg("dim", "..."));
  const neutral = (text: string): string => theme.fg("text", text);
  const muted = (text: string): string => theme.fg("muted", text);
  const brand = theme.fg("dim", model.brand);
  if (model.stopped) return cut(`${brand} ${theme.fg("error", theme.bold("FOLDING STOPPED"))}` +
    (model.share === null ? "" : neutral(` · ${Math.round(model.share * 100)}% full`)));
  if (model.share === null) return cut(`${brand} ${muted(`not measured yet · folds automatically at ${Math.round(model.commitShare * 100)}%`)}`);
  const palette = lightBackground(theme) ? ON_LIGHT : ON_DARK;
  const ink = (kind: FoldBarKind, text: string): string => {
    if (theme.getColorMode?.() === "truecolor") return truecolor(palette[kind], text);
    if (kind === "pinned") return theme.fg("accent", text);
    return theme.fg(kind === "raw" ? "muted" : "text", text);
  };
  const ticks = foldBarTicks(model);
  const bar = foldBarCells(model).map((kind, i) => {
    if (ticks.has(i)) return neutral(theme.bold("┆"));
    if (kind === "empty") return theme.fg("dim", "░");
    if (kind === "unknown") return muted("█");
    return ink(kind, "█");
  }).join("");
  const pct = Math.round(model.share * 100);
  const parts: string[] = [];
  if (model.staleAfterCommit) parts.push(muted(`${pct}% before the commit`));
  else {
    const when = model.share < model.commitShare ? `commit at ${Math.round(model.commitShare * 100)}%`
      : model.weighed ? "commit held" : "at commit point";
    parts.push(neutral(`${pct}%`), muted(when));
  }
  if (model.mapped) {
    // N counts compressed folds. Pin/Mark are accompanying states, not added to N.
    const counts = [
      ink("consolidated", `${model.foldConsolidations} Cons.`), ink("span", `${model.foldSpans} Span`),
      ink("tool", `${model.foldTruncations} Tool`), ink("pinned", `${model.pinnedRefs} Pin`),
      ink("marked", `${model.stagedMarks} Mark`),
    ];
    parts.push(neutral(`${model.folds} Folds (`) + counts.join(muted(", ")) + neutral(")"));
    if (model.unplacedItems > 0) parts.push(muted(`${model.unplacedItems} not mapped`));
  } else parts.push(muted("mapping"));
  return cut(`${bar} ${parts.join(theme.fg("dim", " · "))}`);
}
