// /fold-editor: the user's map of the active context window. V2.1: the DEFAULT view
// is the active window's TOP LEVEL -- raw gaps and ROOT folds only. Nested folds do
// not render until their parent is expanded, and an expanded fold exposes its actual
// MESSAGES as selectable rows, so navigation reaches entry level. Colored bookends
// carry the structure: theme success opens a fold, theme error closes it, accent/
// warning mark PROPOSED (staged) blocks, dim renders raw. V2.2: RAW ENTRIES ARE MARK
// POINTS. `m` anchors one, moving shows the live would-be fold size, and `m` again
// stages a USER mark through the callback the command handler supplies -- which runs
// the SAME validated staging path the agent's tool uses, origin "user". The view
// itself still holds no runtime reference and no mutation path: it computes nothing
// but the arithmetic it is handed (spanCost) and reports one intent (onStageMark).
// Everything else must stay skins over existing validated paths.
//
// Keys go through the INJECTED keybindings manager (/tree action names), so user
// rebinding works natively; the global pi-tui manager is the fallback. Raw byte
// matching froze the first settings editor on application-cursor-mode terminals.

import { getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

export interface FoldEditorEntry {
	id: string;
	role: string;
	preview: string;
	/** Position in the mapped window; present on raw entries, which are the mark points. */
	index?: number;
}

export interface FoldEditorBlock {
	type: "fold" | "proposed" | "raw";
	id: string;
	startPosition: number;
	endPosition: number;
	kind?: string;
	origin?: string;
	brief?: string;
	sourceCount?: number;
	rolesSummary?: string;
	/** Direct source entries of this fold (its messages), for drill-in. */
	entries: FoldEditorEntry[];
	/** Folds nested inside this one; hidden until the parent is expanded. */
	children: FoldEditorBlock[];
}

export interface FoldEditorData {
	title: string;
	occupancy: {
		usedTokens: number | null;
		budgetTokens: number;
		commitOccupancy: number;
		commitDue: boolean;
	};
	/** Top-level blocks only: raw gaps and ROOT folds, in window order. */
	blocks: FoldEditorBlock[];
	pending: {
		count: number;
		agentMarks: number;
		ladderMarks: number;
		userMarks: number;
		freedTokens: number;
	};
	pinned: string[];
}

const BAR_WIDTH = 24;
const MAX_VISIBLE_ROWS = 24;
const EXPANDED_ENTRY_CAP = 40;

export function occupancyBar(usedTokens: number | null, budgetTokens: number): string {
	const ratio = usedTokens !== null && budgetTokens > 0
		? Math.max(0, Math.min(1, usedTokens / budgetTokens))
		: 0;
	const filled = Math.round(ratio * BAR_WIDTH);
	return `${"█".repeat(filled)}${"·".repeat(BAR_WIDTH - filled)}`;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * Assemble the top-level window stream. Committed folds nest by containment (a fold
 * whose span sits inside another becomes a CHILD of the innermost container), so the
 * view can keep nested folds hidden until their ancestors expand. Staged marks stay
 * top-level: they propose RAW spans, and the user reads them against the gaps.
 */
export function buildFoldEditorData(
	snapshot: any,
	state: any,
	helpers: {
		foldRows: () => Array<{
			id: string; kind: string; brief: string; sourceCount: number;
			startPosition: number; endPosition: number;
			entries: FoldEditorEntry[];
		}>;
		pendingMarkRefs: () => Array<{ id: string; origin: string; brief: string; entryIds: string[] }>;
		mappedRange: (from: number, to: number) => FoldEditorEntry[];
		entryCount: number;
	},
): FoldEditorData["blocks"] {
	const nodes = new Map<string, FoldEditorBlock>();
	for (const row of helpers.foldRows()) {
		if (!Number.isFinite(row.startPosition) || !Number.isFinite(row.endPosition)) continue;
		nodes.set(row.id, {
			type: "fold",
			id: row.id,
			startPosition: row.startPosition,
			endPosition: row.endPosition,
			kind: row.kind,
			brief: row.brief,
			sourceCount: row.sourceCount,
			entries: row.entries,
			children: [],
		});
	}
	// Nest by containment: each node's parent is the SMALLEST other node whose span
	// contains it. Containment is NON-STRICT at both edges ON PURPOSE: a consolidated
	// parent spans exactly first-child-start..last-child-end, so children share their
	// boundary edges with it, and a strict test made every consolidated child render
	// top-level (the "ton of folds"). Equal spans tie-break by id for determinism.
	const ordered = [...nodes.values()].sort((a, b) =>
		a.startPosition - b.startPosition || a.endPosition - b.endPosition || a.id.localeCompare(b.id));
	const spanOf = (block: FoldEditorBlock): number => block.endPosition - block.startPosition;
	for (const node of ordered) {
		let parent: FoldEditorBlock | null = null;
		for (const candidate of ordered) {
			if (candidate === node) continue;
			const contains = candidate.startPosition <= node.startPosition &&
				candidate.endPosition >= node.endPosition;
			if (!contains) continue;
			const better = !parent ||
				spanOf(candidate) < spanOf(parent) ||
				(spanOf(candidate) === spanOf(parent) && candidate.id.localeCompare(parent.id) < 0);
			if (better) parent = candidate;
		}
		if (parent) parent.children.push(node);
	}
	const blocks: FoldEditorBlock[] = [];
	let cursor = 0;
	const pushGap = (to: number): void => {
		if (to < cursor) return;
		blocks.push({
			type: "raw",
			id: `raw:${cursor}-${to}`,
			startPosition: cursor,
			endPosition: to,
			sourceCount: to - cursor + 1,
			rolesSummary: "",
			entries: helpers.mappedRange(cursor, to),
			children: [],
		});
	};
	const childIds = new Set(nodes.size ? [] : []);
	for (const node of nodes.values()) for (const child of node.children) childIds.add(child.id);
	const topLevel = ordered.filter((node) => !childIds.has(node.id));
	for (const root of topLevel) {
		pushGap(root.startPosition - 1);
		blocks.push(root);
		cursor = Math.max(cursor, root.endPosition + 1);
	}
	pushGap(helpers.entryCount - 1);

	for (const block of blocks) {
		if (block.type === "raw") {
			const roles = new Map<string, number>();
			for (const entry of block.entries) roles.set(entry.role, (roles.get(entry.role) ?? 0) + 1);
			block.rolesSummary = [...roles.entries()].map(([role, count]) => `${role}×${count}`).join(" ");
		}
	}

	for (const mark of helpers.pendingMarkRefs()) {
		let start = Number.POSITIVE_INFINITY;
		let end = Number.NEGATIVE_INFINITY;
		const entries: FoldEditorEntry[] = [];
		for (const entryId of mark.entryIds) {
			const at = snapshot.mapped.findIndex((item: any) => item.ref?.entryId === entryId);
			if (at === -1) continue;
			start = Math.min(start, at);
			end = Math.max(end, at);
			entries.push({ id: entryId, role: "", preview: "" });
		}
		if (entries.length && Number.isFinite(start)) {
			blocks.push({
				type: "proposed",
				id: mark.id,
				startPosition: start,
				endPosition: end,
				origin: mark.origin,
				brief: mark.brief,
				sourceCount: entries.length,
				entries,
				children: [],
			});
		}
	}
	blocks.sort((a, b) => a.startPosition - b.startPosition || a.id.localeCompare(b.id));
	return blocks;
}

/** Split a brief into width-agnostic whitespace chunks so long briefs wrap. */
function briefChunks(brief: string): string[] {
	const flat = brief.replace(/\s+/g, " ").trim();
	if (!flat) return [];
	const chunks: string[] = [];
	let current = "";
	for (const word of flat.split(" ")) {
		if (current && `${current} ${word}`.length > 72) {
			chunks.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

interface RenderRow {
	key: string;
	text: string;
	/** Rows that answer Enter with a toggle (blocks) versus detail rows (entries). */
	toggleId: string | null;
	/** An entry row: Enter shows its full preview. */
	entryPreview?: string;
	/** A raw entry row: a mark point. Carries its mapped index and id for marking. */
	markable?: boolean;
	entryIndex?: number;
	entryId?: string;
}

/** What laying a mark over a span WOULD commit: the size the user sees before staging. */
export interface SpanCost {
	entries: number;
	tokens: number;
}

export interface FoldEditorActions {
	/** Live would-be fold size for a span of mapped indices, any order. */
	spanCost?: (from: number, to: number) => SpanCost;
	/** Stage a USER mark over two raw entry ids through the validated path. */
	onStageMark?: (fromId: string, toId: string) => Promise<void>;
}

type ThemeFn = (color: string, text: string) => string;

export class FoldEditorView {
	private data: FoldEditorData;
	private done: () => void;
	private theme: { fg?: ThemeFn };
	private kb: { matches(data: string, action: string): boolean };
	private actions: FoldEditorActions;
	private selectedKey: string;
	private expanded: Set<string> = new Set();
	private detailedEntry: string | null = null;
	private scroll = 0;
	/** The anchored mark point: first boundary of a span the user is laying down. */
	private anchor: { key: string; id: string; index: number } | null = null;
	/** True while onStageMark is in flight; the view stages nothing itself. */
	staging = false;
	/** Last staging outcome, rendered until the next action replaces it. */
	notice: string | null = null;
	closed = false;

	constructor(
		data: FoldEditorData,
		done: () => void,
		keybindings?: { matches(data: string, action: string): boolean } | null,
		theme?: unknown,
		actions?: FoldEditorActions | null,
	) {
		this.data = data;
		this.done = done;
		this.kb = keybindings ?? getKeybindings();
		this.theme = (theme as { fg?: ThemeFn }) ?? {};
		this.actions = actions ?? {};
		this.selectedKey = this.visibleRows()[0]?.key ?? "";
	}

	/** Swap in rebuilt data after a stage or an external state change, keeping the
	 *  selection when the row still exists. The command handler owns rebuilding. */
	refresh(data: FoldEditorData): void {
		this.data = data;
		if (!this.visibleRows().some((row) => row.key === this.selectedKey)) {
			this.selectedKey = this.visibleRows()[0]?.key ?? "";
		}
	}

	private color(color: string, text: string): string {
		return this.theme.fg ? this.theme.fg(color, text) : text;
	}

	private pinnedBadge(entryId: string): string {
		return this.data.pinned.includes(entryId) ? " 📌" : "";
	}

	private renderFold(block: FoldEditorBlock, depth: number, rows: RenderRow[], keyPrefix: string): void {
		// COLLAPSED = ONE ROW (Shane, 2026-08-22): "fold {id}" alone, no END bookend.
		// Start/end bookends exist only in the EXPANDED state. ROW KEYS ARE UNIQUE PER
		// LINE (ordinal-suffixed): sharing a key made every brief chunk of a fold carry
		// the selection cursor at once and broke up/down stepping through them.
		// NO NESTED TEMPLATE LITERALS: jiti mishandles `x === \`${prefix}\`` inside
		// template text expressions; keys are precomputed into locals.
		const foldKey = `${keyPrefix}${block.id}`;
		const isOpen = this.expanded.has(foldKey);
		const pad = "  ".repeat(depth);
		const kindLabel = `${block.kind} \u00d7${block.sourceCount}`;
		const marker = isOpen ? "\u25bc" : "\u25b8";
		const foldCursor = this.selectedKey === foldKey ? "\u276f" : " ";
		rows.push({
			key: foldKey,
			text: `${foldCursor}${this.color("success", `${pad}${marker} fold ${shortId(block.id)}`)} ${kindLabel}`,
			toggleId: foldKey,
		});
		if (!isOpen) return;
		let ordinal = 0;
		for (const chunk of briefChunks(block.brief ?? "")) {
			const briefKey = `${foldKey}:b${ordinal}`;
			ordinal += 1;
			const briefCursor = this.selectedKey === briefKey ? "\u276f" : " ";
			rows.push({ key: briefKey, text: `${briefCursor}${pad}    ${chunk}`, toggleId: null });
		}
		for (const child of block.children ?? []) {
			this.renderFold(child, depth + 1, rows, `${foldKey}>`);
		}
		const entries = (block.entries ?? []).slice(0, EXPANDED_ENTRY_CAP);
		for (const entry of entries) {
			const entryKey = `${foldKey}:${entry.id}`;
			const detailed = this.detailedEntry === entryKey;
			const preview = detailed
				? entry.preview.slice(0, 240)
				: entry.preview.slice(0, 48);
			const entryCursor = this.selectedKey === entryKey ? "\u276f" : " ";
			rows.push({
				key: entryKey,
				text: `${entryCursor}${pad}    ${this.color("dim", `\u00b7 ${entry.role} ${shortId(entry.id)}${this.pinnedBadge(entry.id)} \u201c${preview}\u201d`)}`,
				toggleId: null,
				entryPreview: entry.preview,
			});
			if (detailed && entry.preview.length > 240) {
				rows.push({
					key: `${entryKey}:more`,
					text: `${pad}    ${this.color("dim", entry.preview.slice(240, 480))}`,
					toggleId: null,
				});
			}
		}
		const endCursor = this.selectedKey === `${foldKey}:end` ? "\u276f" : " ";
		rows.push({
			key: `${foldKey}:end`,
			text: `${endCursor}${this.color("error", `${pad}\u25b2 end ${shortId(block.id)}`)}`,
			toggleId: foldKey,
		});
	}

	private visibleRows(): RenderRow[] {
		const rows: RenderRow[] = [];
		for (const block of this.data.blocks) {
			if (block.type === "fold") {
				this.renderFold(block, 0, rows, "");
				continue;
			}
			const isOpen = this.expanded.has(block.id);
			const cursor = this.selectedKey === block.id ? "\u276f" : " ";
			if (block.type === "proposed") {
				const isLadder = block.origin === "ladder";
				const color = isLadder ? "warning" : "accent";
				rows.push({
					key: block.id,
					text: `${cursor}${this.color(color, `\u25c7 PROPOSED (${block.origin}) ${shortId(block.id)}`)} \u00d7${block.sourceCount}`,
					toggleId: block.id,
				});
				if (isOpen) {
					let ordinal = 0;
					for (const chunk of briefChunks(block.brief ?? "")) {
						const briefKey = `${block.id}:b${ordinal}`;
						ordinal += 1;
						rows.push({ key: briefKey, text: `${this.selectedKey === briefKey ? "\u276f" : " "}    ${chunk}`, toggleId: null });
					}
					for (const entry of block.entries.slice(0, 60)) {
						const entryKey = `${block.id}:${entry.id}`;
						rows.push({
							key: entryKey,
							text: `${this.selectedKey === entryKey ? "\u276f" : " "}    ${this.color("dim", `\u00b7 ${entry.role} ${shortId(entry.id)}${this.pinnedBadge(entry.id)}`)}`,
							toggleId: null,
							entryPreview: entry.preview,
						});
					}
				}
			} else {
				const label = `\u00b7 raw \u00d7${block.sourceCount}` +
					`${block.rolesSummary ? ` ${block.rolesSummary}` : ""}`;
				rows.push({
					key: block.id,
					text: `${cursor}${this.color("dim", label)}`,
					toggleId: block.id,
				});
				if (isOpen) {
					let ordinal = 0;
					for (const entry of block.entries.slice(0, 60)) {
						const pinBadge = this.data.pinned.includes(entry.id) ? " \ud83d\udccc" : "";
						const entryKey = `${block.id}:${entry.id}:r${ordinal}`;
						ordinal += 1;
						const cursor = this.selectedKey === entryKey ? "\u276f" : " ";
						// A RAW ENTRY IS A MARK POINT (V2.2): the anchor wears a diamond, and
						// every raw entry can become one. Entries without a mapped index are
						// not markable because their span arithmetic would be a guess.
						const markable = typeof entry.index === "number";
						const anchoredHere = this.anchor !== null && this.anchor.key === entryKey;
						const badge = anchoredHere ? this.color("warning", " \u25c6 start") : "";
						rows.push({
							key: entryKey,
							text: `${cursor}    ${this.color("dim", `\u00b7 ${entry.role} ${shortId(entry.id)}${pinBadge}`)}${badge}`,
							toggleId: null,
							entryPreview: entry.preview,
							...(markable ? { markable: true, entryIndex: entry.index, entryId: entry.id } : {}),
						});
					}
				}
			}
		}
		return rows;
	}

	private move(delta: number): void {
		const rows = this.visibleRows();
		if (!rows.length) return;
		const at = rows.findIndex((row) => row.key === this.selectedKey);
		const next = at === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta));
		this.selectedKey = rows[next].key;
		this.scrollToSelection();
	}

	private scrollToSelection(): void {
		const rows = this.visibleRows();
		const at = rows.findIndex((row) => row.key === this.selectedKey);
		if (at === -1) return;
		if (at < this.scroll) this.scroll = at;
		else if (at >= this.scroll + MAX_VISIBLE_ROWS) this.scroll = at - MAX_VISIBLE_ROWS + 1;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.closed || !data) return;
		if (this.kb.matches(data, "tui.select.cancel")) {
			// ESCAPE CANCELS THE ANCHOR FIRST: laying down a span must be escapable
			// stepwise, and closing the editor mid-span would lose nothing but the work.
			if (this.anchor !== null) {
				this.anchor = null;
				return;
			}
			this.closed = true;
			this.done();
			return;
		}
		if (data === "m") {
			this.handleMarkKey();
			return;
		}
		if (this.kb.matches(data, "tui.select.up")) this.move(-1);
		else if (this.kb.matches(data, "tui.select.down")) this.move(1);
		else if (this.kb.matches(data, "tui.select.pageUp")) this.move(-10);
		else if (this.kb.matches(data, "tui.select.pageDown")) this.move(10);
		else if (this.kb.matches(data, "tui.editor.cursorLeft")) {
			const target = this.innermostOpenFold(this.selectedKey);
			if (target) {
				this.expanded.delete(target);
				this.selectedKey = target;
				this.scrollToSelection();
			}
		}
		else if (this.kb.matches(data, "tui.select.confirm") ||
			this.kb.matches(data, "tui.editor.cursorRight")) {
			const row = this.visibleRows().find((candidate) => candidate.key === this.selectedKey);
			if (!row) return;
			if (row.toggleId) {
				if (this.expanded.has(row.toggleId)) this.expanded.delete(row.toggleId);
				else this.expanded.add(row.toggleId);
				this.scrollToSelection();
			} else if (row.entryPreview !== undefined) {
				this.detailedEntry = this.detailedEntry === row.key ? null : row.key;
				this.scrollToSelection();
			}
		}
	}

	/** The deepest expanded fold named in a row key (keys look like "a>b:c"). */
	private innermostOpenFold(key: string): string | null {
		const chain = key.split(":")[0].split(">");
		for (let index = chain.length - 1; index >= 0; index -= 1) {
			if (this.expanded.has(chain[index])) return chain[index];
		}
		return null;
	}

	/** THE MARK KEY. On a raw entry: first press anchors, second press stages. The
	 *  view never mutates state -- staging goes through the injected callback, which
	 *  is the SAME validated path the agent's tool action runs, origin "user". */
	private handleMarkKey(): void {
		if (this.staging) return;
		const row = this.visibleRows().find((candidate) => candidate.key === this.selectedKey);
		if (!row || !row.markable || row.entryIndex === undefined || !row.entryId) return;
		if (this.anchor === null) {
			this.anchor = { key: row.key, id: row.entryId, index: row.entryIndex };
			this.notice = null;
			return;
		}
		if (this.anchor.key === row.key) {
			this.anchor = null;
			return;
		}
		if (!this.actions.onStageMark) {
			this.notice = "staging is not wired in this view";
			return;
		}
		const fromId = this.anchor.id;
		const toId = row.entryId;
		this.staging = true;
		this.notice = null;
		void this.actions.onStageMark(fromId, toId)
			.then(() => {
				this.staging = false;
				this.anchor = null;
			})
			.catch((error: unknown) => {
				this.staging = false;
				this.notice = error instanceof Error ? error.message : String(error);
			});
	}

	private headerLines(width: number): string[] {
		const lines: string[] = [];
		const { occupancy, pending } = this.data;
		lines.push(truncateToWidth(`── ${this.data.title} ──`, width));
		const percent = occupancy.usedTokens !== null && occupancy.budgetTokens > 0
			? ((occupancy.usedTokens / occupancy.budgetTokens) * 100).toFixed(1)
			: "?";
		lines.push(truncateToWidth(
			`${occupancyBar(occupancy.usedTokens, occupancy.budgetTokens)} ` +
			`${percent}% · ${occupancy.usedTokens ?? "?"}/${occupancy.budgetTokens} tokens · ` +
			`commit at ${(occupancy.commitOccupancy * 100).toFixed(0)}%` +
			`${occupancy.commitDue ? " · COMMIT DUE" : ""}`,
			width,
		));
		lines.push(truncateToWidth(
			`staged marks: ${pending.count} (${pending.agentMarks} agent, ${pending.ladderMarks} ladder` +
			`${pending.userMarks > 0 ? `, ${pending.userMarks} you` : ""})` +
			` · about ${pending.freedTokens.toLocaleString("en-US")} tokens freed when committed · ` +
			`pinned: ${this.data.pinned.length}`,
			width,
		));
		return lines;
	}

	render(width: number): string[] {
		const header = this.headerLines(width);
		const rows = this.visibleRows();
		if (!rows.length) {
			return [...header, "", truncateToWidth("(empty window)", width)];
		}
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - MAX_VISIBLE_ROWS)));
		const body = rows
			.slice(this.scroll, this.scroll + MAX_VISIBLE_ROWS)
			.map((row) => truncateToWidth(row.text, width, ""));
		// THE WOULD-BE FOLD SIZE (Shane, 2026-08-23): while a span is being laid down,
		// the footer states what the second mark point would commit, in the runtime's
		// own token arithmetic -- the same numbers the staged mark will answer with.
		const footers: string[] = [];
		if (this.anchor !== null && this.actions.spanCost) {
			const current = rows.find((row) => row.key === this.selectedKey);
			if (current && current.markable && current.entryIndex !== undefined) {
				const cost = this.actions.spanCost(this.anchor.index, current.entryIndex);
				footers.push(truncateToWidth(
					`\u25c6 mark from ${shortId(this.anchor.id)} \u2192 ${shortId(String(current.entryId))}: ` +
					`would fold ${cost.entries} ${cost.entries === 1 ? "entry" : "entries"} · ~${cost.tokens.toLocaleString("en-US")} tokens · m:stage`,
					width, ""));
			}
		}
		if (this.staging) footers.push(truncateToWidth("staging user mark\u2026", width, ""));
		else if (this.notice) footers.push(truncateToWidth(this.notice, width, ""));
		return [
			...header,
			"",
			...body,
			...footers,
			truncateToWidth("enter:expand/detail · arrows:navigate · m:mark raw span · esc:close", width, ""),
		];
	}
}
