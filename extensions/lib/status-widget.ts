/**
 * Two different readings, with two explicitly different scales:
 * usage is a forty-cell token gauge; items is a schematic of context in source order.
 * A minimum-width item is NOT a token measurement. Keeping these apart lets every
 * displayed fold have its own body and separator without overstating occupancy.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const FOLD_BAR_WIDTH = 40;

export type SegmentKind =
  | "fold-span" | "fold-truncation" | "fold-consolidation"
  | "staged-span" | "staged-truncation" | "staged-consolidation"
  | "raw" | "pinned";

/** Boundaries belong to pending items, not to raster cells. IDs retain nesting. */
export interface BarBoundary { id: string; kind: SegmentKind }
export interface BarSegment {
  kind: SegmentKind;
  /** Never coalesce distinct folds, even adjacent folds of the same kind. */
  foldId?: string;
  starts: BarBoundary[];
  ends: BarBoundary[];
}

export interface FoldBarModel {
  brand: string;
  share: number | null;
  commitShare: number;
  aimShare: number;
  mapped: boolean;
  segments: BarSegment[];
  stagedMarks: number;
  stagedSpans: number;
  stagedTruncations: number;
  stagedConsolidations: number;
  /** Collapsed items actually placed in the diagram, not their edges or descendants. */
  folds: number;
  foldSpans: number;
  foldTruncations: number;
  foldConsolidations: number;
  unplacedItems: number;
  pinnedRefs: number;
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

// Fixed categorical samples spanning Crameri batlow: pin .10, pending tool .36,
// span .53, consolidation .66, folded tool .80, span .90, consolidation 1.0.
// Offline CAM02-UCS lightness adjustment seats foregrounds at >=4.6:1 against
// #202122 / white (hue coordinates held, sRGB clipped). These are Batlow-DERIVED
// categorical inks, not a claim that lightness measures the amount of compression.
// Raw and family totals stay neutral. No palette-generation dependency ships.
const ON_DARK = {
  raw: "#858A90", pinned: "#668DB3", "staged-truncation": "#68936F", "staged-span": "#948B31",
  "staged-consolidation": "#CF9340", "fold-truncation": "#FBA689",
  "fold-span": "#FDB9C2", "fold-consolidation": "#FACCFA",
} as const;
const ON_LIGHT = {
  raw: "#697078", pinned: "#0F3C5F", "staged-truncation": "#477150", "staged-span": "#80761F",
  "staged-consolidation": "#A0691B", "fold-truncation": "#AA624A",
  "fold-span": "#9E656E", "fold-consolidation": "#8F6891",
} as const;

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

/** Only occupancy belongs on this scale. Diagram items never move its targets. */
export function foldBarCells(model: FoldBarModel, width = FOLD_BAR_WIDTH): boolean[] {
  const filled = Math.max(0, Math.min(width, Math.round((model.share ?? 0) * width)));
  return Array.from({ length: width }, (_, index) => index < filled);
}

export function foldBarTicks(model: FoldBarModel, width = FOLD_BAR_WIDTH): Map<number, "aim" | "commit"> {
  const at = (share: number): number => Math.max(0, Math.min(width - 1, Math.round(share * width) - 1));
  return new Map([[at(model.aimShare), "aim"], [at(model.commitShare), "commit"]]);
}

export function foldBarPlainText(model: FoldBarModel): string {
  return renderFoldBar(model, Number.POSITIVE_INFINITY, { fg: (_c, t) => t, bold: (t) => t });
}

/** Complete sections only. Omission is named, never drawn as one apparently merged fold. */
function fitSections(sections: string[], width: number): string {
  if (visibleWidth(sections.join(" ")) <= width) return sections.join(" ");
  let prefix = "";
  for (let i = 0; i < sections.length; i += 1) {
    const next = prefix + (prefix ? " " : "") + sections[i];
    const tail = ` … +${sections.length - i - 1} sections`;
    if (visibleWidth(next + tail) > width) {
      return truncateToWidth(`${prefix}${prefix ? " " : ""}… +${sections.length - i} sections`, width, "");
    }
    prefix = next;
  }
  return prefix;
}

/** Returns one prose line, or two lines each independently bounded to terminal width. */
export function renderFoldBar(model: FoldBarModel, width: number, theme: FoldBarTheme): string {
  const muted = (text: string): string => theme.fg("muted", text);
  const neutral = (text: string): string => theme.fg("text", text);
  const cut = (text: string): string => truncateToWidth(text, width, theme.fg("dim", "..."));
  const brand = theme.fg("dim", model.brand);
  if (model.stopped) {
    return cut(`${brand} ${theme.fg("error", theme.bold("FOLDING STOPPED"))}` +
      (model.share === null ? "" : neutral(` · ${Math.round(model.share * 100)}% full`)));
  }
  if (model.share === null) {
    return cut(`${brand} ${muted(`not measured yet · folds automatically at ${Math.round(model.commitShare * 100)}%`)}`);
  }
  const palette = lightBackground(theme) ? ON_LIGHT : ON_DARK;
  const ink = (kind: SegmentKind, text: string): string => {
    if (theme.getColorMode?.() === "truecolor") return truecolor(palette[kind], text);
    if (kind === "pinned") return theme.fg("accent", text);
    if (kind === "raw") return theme.fg("dim", text);
    return theme.fg(kind.startsWith("staged") ? "text" : "muted", text);
  };
  const ticks = foldBarTicks(model);
  const gauge = foldBarCells(model).map((filled, i) => ticks.has(i)
    ? neutral(theme.bold("┆"))
    : theme.fg(filled ? "muted" : "dim", filled ? "█" : "░")).join("");
  const pct = Math.round(model.share * 100);
  let reading: string;
  if (model.staleAfterCommit) reading = muted(`${pct}% before the commit`);
  else {
    const when = model.share < model.commitShare ? `commit at ${Math.round(model.commitShare * 100)}%`
      : model.weighed ? "commit held" : "at commit point";
    reading = `${neutral(`${pct}%`)} · ${muted(when)} · ${muted(`aim ${Math.round(model.aimShare * 100)}%`)}`;
  }
  const usageLine = cut(`${muted("usage ")}${gauge} ${reading}`);
  if (!model.mapped) return `${usageLine}\n${cut(muted("items not mapped yet"))}`;

  // Bodies retain at least 5/8 height, independent of their boundary marks. A full
  // column separates sections, including two tiny neighbouring folds of the same kind.
  // Pending ranges get high-contrast brackets at BOTH ends. A consolidation's brackets
  // can surround several existing folded items, rather than replacing them with an edge.
  const glyphs: Record<SegmentKind, string> = {
    raw: "█", pinned: "█", "staged-truncation": "▇", "staged-span": "▆",
    "staged-consolidation": "▆", "fold-truncation": "▆", "fold-span": "▆", "fold-consolidation": "▅",
  };
  const sections = model.segments.map((segment) =>
    segment.starts.map((edge) => ink(edge.kind, theme.bold("["))).join("") +
    ink(segment.kind, glyphs[segment.kind].repeat(2)) +
    segment.ends.map((edge) => ink(edge.kind, theme.bold("]"))).join(""));
  const kinds = (parts: Array<[number, string, SegmentKind]>): string => {
    const named = parts.filter(([n]) => n > 0)
      .map(([n, noun, kind]) => ink(kind, `${n} ${noun}${n === 1 ? "" : "s"}`));
    return named.length ? ` (${named.join(theme.fg("dim", ", "))})` : "";
  };
  const inventory: string[] = [];
  if (model.stagedMarks > 0) inventory.push(neutral(`${model.stagedMarks} pending`) + kinds([
    [model.stagedSpans, "span", "staged-span"], [model.stagedTruncations, "tool", "staged-truncation"],
    [model.stagedConsolidations, "group", "staged-consolidation"],
  ]));
  if (model.folds > 0) inventory.push(neutral(`${model.folds} folded`) + kinds([
    [model.foldSpans, "span", "fold-span"], [model.foldTruncations, "tool", "fold-truncation"],
    [model.foldConsolidations, "group", "fold-consolidation"],
  ]));
  if (model.pinnedRefs > 0) inventory.push(ink("pinned", `${model.pinnedRefs} pinned`));
  if (model.unplacedItems > 0) inventory.push(muted(`${model.unplacedItems} not mapped`));
  const label = inventory.join(theme.fg("dim", " · "));
  // Reserve room for the inventory where possible. Below that, preserve the diagram
  // and its explicit overflow count; the right-hand label is what gets truncated.
  const diagramWidth = Math.max(0, Math.min(width - 6,
    Math.max(FOLD_BAR_WIDTH, width - visibleWidth(label) - 8)));
  const diagram = fitSections(sections, diagramWidth);
  return `${usageLine}\n${cut(`${muted("items ")}${diagram}${label ? `  ${label}` : ""}`)}`;
}
