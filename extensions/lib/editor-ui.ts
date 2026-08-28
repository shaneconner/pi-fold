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
	/** Estimated tokens this staged mark frees at the next commit; proposed blocks only. */
	tokens?: number;
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
		/** Automatic folding has stopped. The editor is the surface a person opens in order
		 *  to ACT, and without this it priced a countdown to a commit that cannot fire. */
		suspended?: boolean;
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
	// THE SAME ALPHABET /fold-status USES. The editor drew its empty cells with the middle
	// dot that also separates the fields on that very line, so the bar's tail and the
	// line's punctuation were the same glyph doing two jobs.
	return `${"▇".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 12) : id;
}

/**
 * MARK ORIGINS IN THE READER'S OWN WORDS. The state's names are for the state: "ladder"
 * is this runtime's internal name for its own automatic marking pass, and a person
 * reading a proposed row needs to know WHO proposed the fold, not which code path
 * staged it. An unrecognized origin passes through rather than being hidden, because a
 * name we do not have a word for is still better than a blank.
 *
 * ONE WORD FOR ONE THING (2026-08-28): the rows said PROPOSED while the header said
 * staged, for the same marks on the same screen, which asks a reader to learn that two
 * words mean one thing before they can read either line.
 */
const ORIGIN_WORDS: Record<string, string> = {
	ladder: "automatic",
	agent: "the model",
	user: "you",
};

function originWord(origin: string | undefined): string {
	if (!origin) return "staged";
	return ORIGIN_WORDS[origin] ?? origin;
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
			// "user×2 assistant×3" put the count behind the same bare multiplication sign the
			// fold rows just lost. Count first, noun second, like everything else here.
			block.rolesSummary = [...roles.entries()].map(([role, count]) => `${count} ${role}`).join(", ");
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
			// The mapped window already knows what this entry IS; a proposed row that
			// names only an id makes the user peek elsewhere to judge the mark.
			const [mappedEntry] = helpers.mappedRange(at, at);
			entries.push({ id: entryId, role: mappedEntry?.role ?? "", preview: mappedEntry?.preview ?? "" });
		}
		if (entries.length && Number.isFinite(start)) {
			blocks.push({
				type: "proposed",
				id: mark.id,
				startPosition: start,
				endPosition: end,
				origin: mark.origin,
				brief: mark.brief,
				tokens: (mark as { tokens?: number }).tokens,
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

/** Detail rows: the full preview (to 480 chars) wrapped like a brief, under the
 *  entry's own row. One long truncated line plus a mid-word continuation hid the
 *  middle of the text; wrapping shows all of it in reading order. */
function detailChunks(preview: string): string[] {
	return briefChunks(preview.slice(0, 480));
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
	/** A PROPOSED row: withdrawable with u. */
	proposedMarkId?: string;
}

/** What laying a mark over a span WOULD commit: the size the user sees before staging. */
export interface SpanCost {
	entries: number;
	tokens: number;
}

export interface FoldEditorActions {
	/** Live would-be fold size for a span of mapped indices, any order. */
	spanCost?: (from: number, to: number) => SpanCost;
	/** Stage a USER mark over two raw entry ids through the validated path. The
	 *  brief is what the user typed; empty means the deterministic brief. */
	onStageMark?: (fromId: string, toId: string, brief?: string) => Promise<void>;
	/** Withdraw one staged mark by id (the tool's unmark path). */
	onWithdrawMark?: (markId: string) => Promise<void>;
	/** Pin or unpin one raw entry; the handler decides which from current state. */
	onTogglePin?: (entryId: string) => Promise<void>;
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
	/** Brief capture: after the second m, the user types an optional brief; Enter
	 *  stages with it (empty keeps the deterministic brief), Esc returns to the span. */
	private briefMode = false;
	private briefBuffer = "";
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
		// THE ROW SAYS WHAT WAS FOLDED (2026-08-28). It read "fold fold_a1b2c3 chapter ×9":
		// the word "fold" twice (the ▸ glyph is already the word), thirteen columns of an
		// id nothing in this view accepts as input, and the brief that says what the fold
		// COVERS hidden behind Enter. Twelve roots differed only by hex, which recreates
		// inside the editor the exact defect /fold-status was rewritten to remove.
		//
		// The id is dropped rather than trailed: it is unusable here, the expanded state
		// still carries it on the end bookend, and a trailing id is what truncation eats
		// first anyway. "×9" becomes a counted noun, because ×9 could be entries, nesting
		// depth or generations and the reader has no way to tell which.
		const kindLabel = `${block.kind} · ${block.sourceCount} ` +
			`${block.sourceCount === 1 ? "entry" : "entries"}`;
		const marker = isOpen ? "\u25bc" : "\u25b8";
		const foldCursor = this.selectedKey === foldKey ? "\u276f" : " ";
		const [foldHead] = briefChunks(block.brief ?? "");
		rows.push({
			key: foldKey,
			text: `${foldCursor}${this.color("success", `${pad}${marker} ${kindLabel}`)}` +
				`${foldHead ? ` · ${foldHead}` : ""}`,
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
			const quoted = !detailed && entry.preview
				? this.color("dim", ` \u201c${entry.preview.slice(0, 48)}\u201d`)
				: "";
			const entryCursor = this.selectedKey === entryKey ? "\u276f" : " ";
			rows.push({
				key: entryKey,
				text: `${entryCursor}${pad}    ${this.color("dim", `\u00b7 ${entry.role} ${shortId(entry.id)}${this.pinnedBadge(entry.id)}`)}${quoted}`,
				toggleId: null,
				entryPreview: entry.preview,
			});
			if (detailed) {
				let detailOrdinal = 0;
				for (const chunk of detailChunks(entry.preview)) {
					rows.push({
						key: `${entryKey}:d${detailOrdinal}`,
						text: `${pad}      ${this.color("dim", chunk)}`,
						toggleId: null,
					});
					detailOrdinal += 1;
				}
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
				const sizeNote = typeof block.tokens === "number"
					? ` · frees ~${block.tokens.toLocaleString("en-US")} tokens` : "";
				const [stagedHead] = briefChunks(block.brief ?? "");
				rows.push({
					key: block.id,
					// Same treatment as the fold row: no id, a counted noun, and the brief seated
					// as the tail so it is what degrades if the terminal is narrow.
					text: `${cursor}${this.color(color, `\u25c7 staged by ${originWord(block.origin)}`)}` +
						` · ${block.sourceCount} ${block.sourceCount === 1 ? "entry" : "entries"}${sizeNote}` +
						`${stagedHead ? ` · ${stagedHead}` : ""}` +
						`${this.selectedKey === block.id ? " · u:withdraw" : ""}`,
					toggleId: block.id,
					proposedMarkId: block.id,
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
						// Role and preview come off the mapped window (buildFoldEditorData
						// resolves them); an entry that fell off the map renders id-only.
						const label = ["\u00b7", entry.role, `${shortId(entry.id)}${this.pinnedBadge(entry.id)}`]
							.filter(Boolean).join(" ");
						const quoted = entry.preview ? ` \u201c${entry.preview.slice(0, 48)}\u201d` : "";
						rows.push({
							key: entryKey,
							text: `${this.selectedKey === entryKey ? "\u276f" : " "}    ${this.color("dim", `${label}${quoted}`)}`,
							toggleId: null,
							entryPreview: entry.preview,
						});
					}
				}
			} else {
				const label = `\u00b7 raw · ${block.sourceCount} ` +
					`${block.sourceCount === 1 ? "entry" : "entries"}` +
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
						// A MARK POINT SHOWS WHAT IT IS (2026-08-23): the row carries its content
						// preview, because this is where the user decides what to fold. Enter
						// deepens it in place, exactly like a fold's entries; before this the
						// toggle set detail state no raw row ever read back.
						const detailed = this.detailedEntry === entryKey;
						const quoted = !detailed && entry.preview
							? this.color("dim", ` \u201c${entry.preview.slice(0, 48)}\u201d`)
							: "";
						rows.push({
							key: entryKey,
							text: `${cursor}    ${this.color("dim", `\u00b7 ${entry.role} ${shortId(entry.id)}${pinBadge}`)}${badge}${quoted}`,
							toggleId: null,
							entryPreview: entry.preview,
							...(markable ? { markable: true, entryIndex: entry.index, entryId: entry.id } : {}),
						});
						if (detailed) {
							let detailOrdinal = 0;
							for (const chunk of detailChunks(entry.preview)) {
								rows.push({
									key: `${entryKey}:d${detailOrdinal}`,
									text: `      ${this.color("dim", chunk)}`,
									toggleId: null,
								});
								detailOrdinal += 1;
							}
						}
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
		if (this.briefMode) {
			this.handleBriefInput(data);
			return;
		}
		if (data === "u") {
			this.handleWithdrawKey();
			return;
		}
		if (data === "p") {
			this.handlePinKey();
			return;
		}
		if (data === "m") {
			this.handleMarkKey();
			return;
		}
		if (this.kb.matches(data, "tui.select.cancel")) {
			// ESCAPE CANCELS WORK FIRST, STEPWISE: the brief line, then the anchor, and
			// only then the editor. Nothing the user laid down is lost by one press.
			if (this.anchor !== null) {
				this.anchor = null;
				this.notice = null;
				return;
			}
			this.closed = true;
			this.done();
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

	/** THE MARK KEY. On a raw entry: first press anchors, second press opens the BRIEF
	 *  LINE. Enter stages (typed brief; empty keeps the deterministic one), Esc steps
	 *  back to the span. The view never mutates state -- staging goes through the
 *  injected callback, which is the SAME validated path the agent's tool action runs,
 *  origin "user". */
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
		// SECOND BOUNDARY LAID DOWN: capture an optional brief before staging.
		this.briefMode = true;
		this.briefBuffer = "";
	}

	private handleBriefInput(data: string): void {
		if (data === "\r" || data === "\n") {
			const brief = this.briefBuffer.trim();
			this.briefMode = false;
			void this.stageSpan(brief === "" ? undefined : brief);
			return;
		}
		if (data === "\x1b") {
			this.briefMode = false;
			this.briefBuffer = "";
			return;
		}
		if (data === "\x7f" || data === "\b") {
			this.briefBuffer = this.briefBuffer.slice(0, -1);
			return;
		}
		// Printable characters only; multi-byte escape sequences are refused whole.
		if (data.length === 1 && data >= " " && data !== "\x7f") {
			if (this.briefBuffer.length < 2_000) this.briefBuffer += data;
		}
	}

	private stageSpan(brief?: string): Promise<void> {
		if (!this.anchor) return Promise.resolve();
		if (!this.actions.onStageMark) {
			this.notice = "staging is not wired in this view";
			return Promise.resolve();
		}
		const fromId = this.anchor.id;
		// The selection cannot move while the brief line holds it: handleBriefInput
		// consumes every key, so the selected row IS the span's second boundary.
		const current = this.visibleRows().find((candidate) => candidate.key === this.selectedKey);
		const toId = current?.entryId ?? "";
		if (!toId) return Promise.resolve();
		this.staging = true;
		this.notice = null;
		return this.actions.onStageMark(fromId, toId, brief)
			.then(() => {
				this.staging = false;
				this.anchor = null;
			})
			.catch((error: unknown) => {
				this.staging = false;
				this.notice = error instanceof Error ? error.message : String(error);
			});
	}

	/** u ON A PROPOSED ROW withdraws that staged mark (the tool's unmark path). */
	private handleWithdrawKey(): void {
		if (this.staging || this.briefMode) return;
		const row = this.visibleRows().find((candidate) => candidate.key === this.selectedKey);
		if (!row || !row.proposedMarkId) return;
		if (!this.actions.onWithdrawMark) {
			this.notice = "withdrawing is not wired in this view";
			return;
		}
		this.staging = true;
		this.notice = null;
		void this.actions.onWithdrawMark(row.proposedMarkId)
			.then(() => {
				this.staging = false;
			})
			.catch((error: unknown) => {
				this.staging = false;
				this.notice = error instanceof Error ? error.message : String(error);
			});
	}

	/** p ON A RAW ENTRY toggles its pin (the tool's pin/unpin path). */
	private handlePinKey(): void {
		if (this.staging || this.briefMode) return;
		const row = this.visibleRows().find((candidate) => candidate.key === this.selectedKey);
		if (!row || !row.markable || !row.entryId) return;
		if (!this.actions.onTogglePin) {
			this.notice = "pinning is not wired in this view";
			return;
		}
		this.staging = true;
		this.notice = null;
		void this.actions.onTogglePin(row.entryId)
			.then(() => {
				this.staging = false;
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
		// UNMEASURED IS PROSE, NEVER A BAR. An empty bar beside "?%" reads to the eye as
		// a window that is 0 percent full, which is a guess wearing the costume of a
		// measurement: the exact failure the other three surfaces already refuse, on the
		// one surface the rule was never checked against. Nothing here is estimated.
		if (occupancy.usedTokens === null || !(occupancy.budgetTokens > 0)) {
			lines.push(truncateToWidth(
				"window not measured yet; the first model response will measure it", width));
			for (const line of this.stagedLines()) lines.push(truncateToWidth(line, width));
			return lines;
		}
		// A WHOLE PERCENT. The tenth was false precision on a figure that moves with every
		// message, and it read as a measurement finer than the thing being measured. The
		// other three human surfaces round, so this one does too. Past the guard above,
		// both values are known, so neither can render as "?".
		const percent = Math.round((occupancy.usedTokens / occupancy.budgetTokens) * 100);
		const usedTokensText = occupancy.usedTokens.toLocaleString("en-US");
		// The DISTANCE to the commit, not just the share it fires at. "commit at 80%" is
		// a property of the configuration; "29,674 to go" is the answer to the question
		// the reader actually has, and it is the same number /fold-status states.
		const headroom = occupancy.usedTokens !== null && occupancy.budgetTokens > 0 && !occupancy.commitDue
			? ` (${Math.round(occupancy.commitOccupancy * occupancy.budgetTokens - occupancy.usedTokens)
				.toLocaleString("en-US")} to go)`
			: "";
		// Same ordering rule as the line below it: the raw token pair is the most
		// expendable thing here, because the percentage in front of it already says what
		// it says. At 80 columns the first draft cut the headroom instead.
		// A STOPPED WINDOW IS TOLD SO, NOT GIVEN A COUNTDOWN. Every other surface reports
		// the suspension and this one alone kept pricing the distance to a commit that
		// will not happen, which is the one state here that can cost somebody a session.
		const timing = occupancy.suspended
			? " · FOLDING STOPPED"
			: ` · commit at ${(occupancy.commitOccupancy * 100).toFixed(0)}%${headroom}` +
				`${occupancy.commitDue ? " · COMMIT DUE" : ""}`;
		lines.push(truncateToWidth(
			`${occupancyBar(occupancy.usedTokens, occupancy.budgetTokens)} ` +
			`${percent}%${timing}` +
			` · ${usedTokensText}/${occupancy.budgetTokens.toLocaleString("en-US")}`,
			width,
		));
		for (const line of this.stagedLines()) lines.push(truncateToWidth(line, width));
		return lines;
	}

	/**
	 * ORDERED SO TRUNCATION COSTS THE LEAST. This line is cut to the terminal's width, and
	 * at 100 columns the first draft lost the pin count off the end while spending its
	 * width on who staged what. What the marks free and what is pinned are facts about the
	 * window; the origin breakdown is colour, so it goes last.
	 */
	private stagedLines(): string[] {
		const { pending } = this.data;
		// The same vocabulary as ORIGIN_WORDS above, inflected for a count rather than a
		// label: "1 automatic" and "2 by the model" read where "2 the model" does not.
		// Only origins that actually staged something are listed, because a run of zeroes
		// spends the line's width saying nothing happened three different ways.
		const origins = [
			pending.ladderMarks > 0 ? `${pending.ladderMarks} automatic` : "",
			pending.agentMarks > 0 ? `${pending.agentMarks} by the model` : "",
			pending.userMarks > 0 ? `${pending.userMarks} yours` : "",
		].filter((part) => part !== "").join(", ");
		// TWO LINES RATHER THAN ONE THAT RUNS OFF THE TERMINAL. At 97 characters the single
		// line ended mid-phrase at "2 by the model" on any normal window; vertical space is
		// cheaper than a sentence cut in half. The facts about the window come first and
		// who staged what follows, so a narrow terminal still keeps the first line whole.
		// "folds" not "marks": /fold-status and the always-on line both say folds, and one
		// object carrying two nouns on adjacent surfaces is a thing to learn for nothing.
		const staged = [`staged: ${pending.count} fold${pending.count === 1 ? "" : "s"}` +
			` · frees ~${pending.freedTokens.toLocaleString("en-US")} tokens at commit` +
			` · ${this.data.pinned.length} pinned`];
		if (origins) staged.push(`staged by: ${origins}`);
		return staged;
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
			// THE PROJECT'S OWN BOUNDING LAW (gate 136): "..." means content continues in the
			// source and never appears when nothing was cut. Header lines already take the
			// default marker; body rows passed "" and were cut mid-word in silence, so the
			// display layer contradicted the rule the briefs it displays all obey.
			.map((row) => truncateToWidth(row.text, width));
		// THE WOULD-BE FOLD SIZE (Shane, 2026-08-23): while a span is being laid down,
		// the footer states what the second mark point would commit, in the runtime's
		// own token arithmetic -- the same numbers the staged mark will answer with.
		const footers: string[] = [];
		if (this.anchor !== null && !this.briefMode && this.actions.spanCost) {
			const current = rows.find((row) => row.key === this.selectedKey);
			if (current && current.markable && current.entryIndex !== undefined) {
				const cost = this.actions.spanCost(this.anchor.index, current.entryIndex);
				footers.push(truncateToWidth(
					`\u25c6 mark from ${shortId(this.anchor.id)} \u2192 ${shortId(String(current.entryId))}: ` +
					`would fold ${cost.entries} ${cost.entries === 1 ? "entry" : "entries"} · ~${cost.tokens.toLocaleString("en-US")} tokens · m:stage`,
					width, ""));
			}
		}
		if (this.staging) footers.push(truncateToWidth("staging\u2026", width, ""));
		else if (this.briefMode) {
			footers.push(truncateToWidth(
				`brief: ${this.briefBuffer}\u2588 · Enter:stage${this.briefBuffer ? " with brief" : " deterministic"} · Esc:back to span`,
				width, ""));
		} else if (this.notice) footers.push(truncateToWidth(this.notice, width, ""));
		return [
			...header,
			"",
			...body,
			...footers,
			// p AND u CHANGE STATE AND WERE NAMED NOWHERE, while the header prints a pin count
			// on every render. "raw span" stays: it is the word explaining why m does
			// nothing on a fold row. The width comes out of enter and arrows instead.
			truncateToWidth("enter:open · arrows:move · m:mark raw span · p:pin · u:withdraw · esc:close", width),
		];
	}
}
