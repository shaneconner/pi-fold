// /fold-settings: user-facing configuration for the deployment options that are
// otherwise code. The storage stays exactly what registerPiFold accepts (the
// thresholds object set whole, providerInputBudget already net); this module only
// changes the experience: one validation path, an in-TUI editor over a JSON file,
// and every state that reaches disk already passed resolveThresholds.
//
// The editor component is hand-rolled against the raw handleInput contract on
// purpose: extensions/ is imported by the gate suite under plain jiti, and pi-tui
// is not hoisted to this package's root. No pi-tui import may reach this file.

import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_THRESHOLDS,
	resolveThresholds,
	servingBudgetTokens,
	ThresholdPolicyError,
	type ActiveContextThresholds,
} from "./lib/policy.ts";

export const DEFAULT_FOLD_SETTINGS_PATH = join(
	homedir(),
	".config",
	"pi-fold",
	"settings.json",
);

export interface FoldSettingsFile {
	thresholds?: ActiveContextThresholds;
	providerInputBudget?: number | null;
}

const SETTING_IDS = [
	"maxTarget",
	"minTarget",
	"freshTail",
	"consolidateAfter",
	"providerInputBudget",
] as const;

export type FoldSettingId = (typeof SETTING_IDS)[number];

function readProportion(raw: string, field: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0 || value >= 1) {
		throw new ThresholdPolicyError(
			field,
			`thresholds.${field} must be a proportion above 0 and below 1`,
		);
	}
	return value;
}

// One edit, applied against the WHOLE draft: the merged thresholds object is
// re-validated through resolveThresholds so cross-field invariants
// (minTarget < maxTarget, gap >= freshTail) hold at every saved state, never
// only in the file's final form. Returns the next whole draft or a named error.
export function applyFoldSettingsEdit(
	draft: FoldSettingsFile,
	id: FoldSettingId,
	rawValue: string,
): { ok: true; draft: FoldSettingsFile } | { ok: false; error: string } {
	try {
		if (id === "providerInputBudget") {
			const text = rawValue.trim();
			if (text === "" || text.toLowerCase() === "auto") {
				return { ok: true, draft: { ...draft, providerInputBudget: null } };
			}
			const value = Number(text);
			if (!Number.isSafeInteger(value) || value <= 0) {
				return {
					ok: false,
					error: "providerInputBudget must be a positive integer token count (or empty for auto)",
				};
			}
			return { ok: true, draft: { ...draft, providerInputBudget: value } };
		}
		if (id === "consolidateAfter") {
			const value = Number(rawValue.trim());
			if (!Number.isSafeInteger(value) || value < 1) {
				return {
					ok: false,
					error: "thresholds.consolidateAfter must be a positive integer count",
				};
			}
			const thresholds = resolveThresholds({
				...(draft.thresholds ?? DEFAULT_THRESHOLDS),
				consolidateAfter: value,
			});
			return { ok: true, draft: { ...draft, thresholds } };
		}
		const value = readProportion(rawValue.trim(), id);
		const thresholds = resolveThresholds({
			...(draft.thresholds ?? DEFAULT_THRESHOLDS),
			[id]: value,
		});
		return { ok: true, draft: { ...draft, thresholds } };
	} catch (error) {
		if (error instanceof ThresholdPolicyError) return { ok: false, error: error.message };
		throw error;
	}
}

export function loadFoldSettingsFile(path: string = DEFAULT_FOLD_SETTINGS_PATH): FoldSettingsFile {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	for (const key of Object.keys(parsed)) {
		if (key !== "thresholds" && key !== "providerInputBudget") {
			throw new Error(`fold settings file has no ${key} field: the surface is thresholds, providerInputBudget`);
		}
	}
	const settings: FoldSettingsFile = {};
	if (parsed.thresholds !== undefined) {
		settings.thresholds = resolveThresholds(parsed.thresholds);
	}
	if (parsed.providerInputBudget !== undefined && parsed.providerInputBudget !== null) {
		const value = parsed.providerInputBudget;
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error("providerInputBudget must be a positive integer token count");
		}
		settings.providerInputBudget = value;
	}
	return settings;
}

export function saveFoldSettingsFile(path: string, settings: FoldSettingsFile): void {
	const clean: FoldSettingsFile = {};
	if (settings.thresholds !== undefined) clean.thresholds = settings.thresholds;
	if (settings.providerInputBudget != null) clean.providerInputBudget = settings.providerInputBudget;
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(clean, null, 2)}\n`);
	renameSync(temporary, path);
}

interface EditorRow {
	id: FoldSettingId;
	label: string;
	description: string;
}

const EDITOR_ROWS: readonly EditorRow[] = [
	{ id: "maxTarget", label: "Commit trigger (maxTarget)", description: "Occupancy share that fires a fold epoch" },
	{ id: "minTarget", label: "Post-commit aim (minTarget)", description: "Share the epoch cuts back down toward" },
	{ id: "freshTail", label: "Fresh tail (freshTail)", description: "Protected recent share that never folds" },
	{ id: "consolidateAfter", label: "Consolidation divisor (consolidateAfter)", description: "Parents owed per epoch = visible roots divided by this" },
	{ id: "providerInputBudget", label: "Input budget (providerInputBudget)", description: "Net input tokens the deployment may fill; auto derives it from the model window" },
];

function rowDisplayValue(settings: FoldSettingsFile, id: FoldSettingId, budgetTokens: number): string {
	if (id === "providerInputBudget") {
		return settings.providerInputBudget != null ? String(settings.providerInputBudget) : "auto";
	}
	const thresholds = settings.thresholds ?? DEFAULT_THRESHOLDS;
	const value = thresholds[id];
	if (id === "consolidateAfter") return String(value);
	return `${value} (~${Math.round(value * budgetTokens).toLocaleString("en-US")} tokens)`;
}

class FoldSettingsEditor {
	private readonly rows = EDITOR_ROWS;
	private selected = 0;
	private editing = false;
	private buffer = "";
	private error: string | null = null;
	private saved = false;

	constructor(
		private draft: FoldSettingsFile,
		private readonly budgetTokens: number,
		private readonly done: (saved: boolean) => void,
	) {}

	private submit(): void {
		const row = this.rows[this.selected];
		const result = applyFoldSettingsEdit(this.draft, row.id, this.buffer);
		if (!result.ok) {
			this.error = result.error;
			return;
		}
		this.draft = result.draft;
		saveFoldSettingsFile(DEFAULT_FOLD_SETTINGS_PATH, this.draft);
		this.editing = false;
		this.buffer = "";
		this.error = null;
		this.saved = true;
	}

	handleInput(data: string): void {
		if (data === "\x03") {
			this.done(this.saved);
			return;
		}
		if (this.editing) {
			if (data === "\r") {
				this.submit();
				return;
			}
			if (data === "\x1b") {
				this.editing = false;
				this.buffer = "";
				this.error = null;
				return;
			}
			if (data === "\x7f" || data === "\b") {
				this.buffer = this.buffer.slice(0, -1);
				return;
			}
			if (data.length === 1 && data >= " ") this.buffer += data;
			return;
		}
		if (data === "\x1b[A") {
			this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
			return;
		}
		if (data === "\x1b[B") {
			this.selected = (this.selected + 1) % this.rows.length;
			return;
		}
		if (data === "\r") {
			this.editing = true;
			this.buffer = rowRawValue(this.draft, this.rows[this.selected].id);
			return;
		}
		if (data === "\x1b") this.done(this.saved);
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push("pi-fold settings");
		lines.push("");
		for (const [index, row] of this.rows.entries()) {
			const cursor = index === this.selected ? "> " : "  ";
			const value = this.editing && index === this.selected
				? this.buffer
				: rowDisplayValue(this.draft, row.id, this.budgetTokens);
			const label = cursor + row.label;
			const pad = Math.max(1, width - label.length - value.length - 2);
			lines.push(label + " ".repeat(pad) + value);
			if (index === this.selected) lines.push(`    ${row.description}`);
		}
		lines.push("");
		if (this.error) lines.push(`error: ${this.error}`);
		else if (this.editing) lines.push("Enter to apply · Esc to cancel the edit");
		else lines.push(this.saved ? "Saved · Enter to edit · Esc to close" : "Enter to edit · Esc to close");
		return lines.slice(0, Math.max(lines.length, 1));
	}
}

function rowRawValue(settings: FoldSettingsFile, id: FoldSettingId): string {
	if (id === "providerInputBudget") {
		return settings.providerInputBudget != null ? String(settings.providerInputBudget) : "";
	}
	const thresholds = settings.thresholds ?? DEFAULT_THRESHOLDS;
	return String(thresholds[id]);
}

export function registerFoldSettings(
	pi: any,
	options: { settingsPath?: string } = {},
): void {
	const settingsPath = options.settingsPath ?? DEFAULT_FOLD_SETTINGS_PATH;
	pi.registerCommand("fold-settings", {
		description: "Configure pi-fold: commit trigger, post-commit aim, fresh tail, consolidation divisor, input budget",
		handler: async (_args: string, ctx: any) => {
			if (typeof ctx.ui?.custom !== "function") {
				throw new Error("/fold-settings needs an interactive UI; set thresholds in the settings file instead");
			}
			const draft = loadFoldSettingsFile(settingsPath);
			const descriptorWindow = ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
			const budgetTokens = draft.providerInputBudget ?? servingBudgetTokens(descriptorWindow);
			await ctx.ui.custom((_tui: unknown, _theme: unknown, _keybindings: unknown, done: (saved: boolean) => void) =>
				new FoldSettingsEditor(draft, budgetTokens, settingsPath, done));
		},
	});
}
