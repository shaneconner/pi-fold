// /fold-settings: user-facing configuration for the deployment options that are
// otherwise code. The storage stays exactly what registerPiFold accepts (the
// thresholds object set whole, providerInputBudget already net); this module only
// changes the experience: one validation path, an in-TUI editor over a JSON file,
// and every state that reaches disk already passed resolveThresholds.
//
// The editor is built from pi-tui's own SettingsList and Input so it looks and
// behaves like Pi's native /settings screen, and ALL key handling goes through
// matchesKey: raw byte matching froze the editor on terminals in application
// cursor mode, where arrows arrive as SS3 (\x1bOA) rather than CSI (\x1b[A).
//
// The steppable rows CYCLE through allowed values the way /settings cycles its
// discrete options, with each row's list filtered against the CURRENT invariants,
// so a combination resolveThresholds would refuse is never even selectable. The
// input budget is genuinely free-form and keeps an Input submenu.

import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Container, Input, Key, matchesKey, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
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
	{ id: "maxTarget", label: "Commit trigger", description: "Occupancy share of the budget that fires a fold epoch (maxTarget)" },
	{ id: "minTarget", label: "Post-commit aim", description: "Share the epoch cuts back down toward (minTarget)" },
	{ id: "freshTail", label: "Fresh tail", description: "Protected recent share that never folds (freshTail)" },
	{ id: "consolidateAfter", label: "Consolidation divisor", description: "Parents owed per epoch = visible roots divided by this (consolidateAfter)" },
	{ id: "providerInputBudget", label: "Input budget", description: "Net input tokens the deployment may fill; empty derives it from the model window (providerInputBudget)" },
];

// The cycle lattices. Shares step in cents so no float drift reaches a threshold;
// each row's list is FILTERED against the current draft before display, which is
// what makes an invalid combination unselectable rather than an error message.
const SHARE_STEPS: Record<"maxTarget" | "minTarget" | "freshTail", { min: number; max: number; step: number }> = {
	maxTarget: { min: 0.40, max: 0.95, step: 0.05 },
	minTarget: { min: 0.05, max: 0.60, step: 0.05 },
	freshTail: { min: 0.01, max: 0.15, step: 0.01 },
};

const CONSOLIDATE_CHOICES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

function shareCandidates(id: "maxTarget" | "minTarget" | "freshTail"): number[] {
	const { min, max, step } = SHARE_STEPS[id];
	const values: number[] = [];
	for (let cents = Math.round(min * 100); cents <= Math.round(max * 100); cents += Math.round(step * 100)) {
		values.push(cents / 100);
	}
	return values;
}

function allowedValues(id: FoldSettingId, thresholds: ActiveContextThresholds, budgetTokens: number): string[] {
	if (id === "consolidateAfter") return CONSOLIDATE_CHOICES.map(String);
	if (id === "providerInputBudget") return [];
	const { minTarget, maxTarget, freshTail } = thresholds;
	let candidates: number[];
	if (id === "maxTarget") {
		candidates = shareCandidates("maxTarget").filter((v) => v > minTarget && v - minTarget >= freshTail && v > freshTail);
	} else if (id === "minTarget") {
		candidates = shareCandidates("minTarget").filter((v) => v < maxTarget && maxTarget - v >= freshTail);
	} else {
		candidates = shareCandidates("freshTail").filter((v) => v < maxTarget && maxTarget - v >= freshTail);
	}
	// Entries carry the SAME display format as currentValue: SettingsList cycles by
	// indexOf(currentValue), so a format mismatch wraps every first press to the head.
	return candidates.map((v) => `${v.toFixed(2)} · ${Math.round(v * budgetTokens).toLocaleString("en-US")} tok`);
}

function rowRawValue(settings: FoldSettingsFile, id: FoldSettingId): string {
	if (id === "providerInputBudget") {
		return settings.providerInputBudget != null ? String(settings.providerInputBudget) : "";
	}
	const thresholds = settings.thresholds ?? DEFAULT_THRESHOLDS;
	return String(thresholds[id]);
}

function rowDisplayValue(settings: FoldSettingsFile, id: FoldSettingId, budgetTokens: number): string {
	if (id === "providerInputBudget") {
		return settings.providerInputBudget != null ? `${settings.providerInputBudget.toLocaleString("en-US")} tokens` : "auto";
	}
	const raw = rowRawValue(settings, id);
	if (id === "consolidateAfter") return raw;
	// toFixed(2) matches the cycle entries exactly; String(0.8) renders "0.8" while
	// the cycle list carries "0.80", and SettingsList cycles by indexOf(currentValue).
	return `${Number(raw).toFixed(2)} · ${Math.round(Number(raw) * budgetTokens).toLocaleString("en-US")} tok`;
}

// The frame Pi's own /settings screen draws around its list. Implemented locally
// rather than imported because jiti keeps a separate module cache: the border's
// default color closure would bind to a different theme instance than the one the
// editor receives, so the color always arrives explicitly.
class SettingsBorder {
	constructor(private readonly color: (text: string) => string) {}
	invalidate(): void {}
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}

// The free-form editor behind the budget row's submenu: an Input prefilled with
// the raw value; Enter applies through applyFoldSettingsEdit and only a valid
// result calls done, so an invalid state can never reach the list, the file, or
// registration. Composition mirrors the native SelectSubmenu.
class BudgetValueEditor extends Container {
	private readonly input = new Input();
	private readonly errorText = new Text("", 0, 0);

	constructor(
		private readonly themeLike: any,
		initialValue: string,
		private readonly apply: (raw: string) => { ok: true; display: string } | { ok: false; error: string },
		private readonly done: (displayValue?: string) => void,
	) {
		super();
		const theme = this.themeLike;
		this.addChild(new Text(theme.bold(theme.fg("accent", "Input budget")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Net input tokens the deployment may fill; empty or auto derives it from the model window."), 0, 0));
		this.addChild(new Spacer(1));
		this.input.setValue(initialValue);
		// setValue parks the cursor at 0; a prefilled editor must start at the end,
		// or typing inserts at the front and backspace deletes nothing.
		(this.input as any).cursor = initialValue.length;
		this.input.onSubmit = () => this.submit();
		this.input.onEscape = () => this.done();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.errorText);
		this.addChild(new Text(theme.fg("dim", "  Enter to apply · Esc to go back"), 0, 0));
	}

	private submit(): void {
		const result = this.apply(this.input.getValue());
		if (!result.ok) {
			this.errorText.setText(this.themeLike.fg("error", `  ${result.error}`));
			return;
		}
		this.done(result.display);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

// The /fold-settings screen itself: a SettingsList over the five rows, styled off
// the live theme, with every applied change persisted immediately the way Pi's own
// /settings persists. Steppable rows cycle; only the budget row opens an editor.
export class FoldSettingsEditor extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		private draft: FoldSettingsFile,
		private readonly budgetTokens: number,
		private readonly settingsPath: string,
		private readonly themeLike: any,
		private readonly done: (saved: boolean) => void,
	) {
		super();
		const theme = this.themeLike;
		this.addChild(new SettingsBorder((text) => theme.fg("border", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi-fold settings")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Shares are of the serving budget; edits save immediately. Enter cycles a value."), 0, 0));
		this.addChild(new Spacer(1));
		// SettingsList takes its own theme shape; adapt it off the live theme.
		const listTheme = {
			label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
			value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text: string) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			hint: (text: string) => theme.fg("dim", text),
		};
		this.settingsList = new SettingsList(
			EDITOR_ROWS.map((row) => ({
				id: row.id,
				label: row.label,
				description: row.description,
				currentValue: rowDisplayValue(draft, row.id, budgetTokens),
				values: allowedValues(row.id, draft.thresholds ?? DEFAULT_THRESHOLDS, budgetTokens),
				submenu: row.id === "providerInputBudget"
					? (_current: string, submenuDone: (displayValue?: string) => void) =>
						new BudgetValueEditor(
							themeLike,
							rowRawValue(draft, row.id),
							(raw) => this.applyEdit(row.id, raw),
							submenuDone,
						)
					: undefined,
			})),
			EDITOR_ROWS.length + 2,
			listTheme,
			(id, newValue) => this.applyCycled(id as FoldSettingId, newValue),
			() => this.done(true),
		);
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to cycle · Esc to close"), 0, 0));
		this.addChild(new SettingsBorder((text) => theme.fg("border", text)));
	}

	private applyCycled(id: FoldSettingId, display: string): void {
		// The budget row reaches this handler too: SettingsList re-fires onChange with
		// the submenu's DISPLAY string when its editor closes, and parseFloat would
		// read "300,000 tokens" as 300. The submenu path already applied and saved it.
		if (id === "providerInputBudget") return;
		const raw = id === "consolidateAfter" ? display : parseFloat(display).toFixed(2);
		const result = applyFoldSettingsEdit(this.draft, id, raw);
		// Unreachable while the cycle lists stay filtered against the draft; kept as
		// the guard so the validation path owns every write regardless.
		if (!result.ok) return;
		this.draft = result.draft;
		saveFoldSettingsFile(this.settingsPath, this.draft);
		// Re-filter every other row's cycle against the new draft and refresh its
		// displayed token equivalent.
		for (const row of EDITOR_ROWS) {
			const item = (this.settingsList as any).items.find((candidate: any) => candidate.id === row.id);
			if (!item) continue;
			item.currentValue = rowDisplayValue(this.draft, row.id, this.budgetTokens);
			if (row.id !== "providerInputBudget") {
				item.values = allowedValues(row.id, this.draft.thresholds ?? DEFAULT_THRESHOLDS, this.budgetTokens);
			}
		}
	}

	private applyEdit(id: FoldSettingId, raw: string): { ok: true; display: string } | { ok: false; error: string } {
		const result = applyFoldSettingsEdit(this.draft, id, raw);
		if (!result.ok) return result;
		this.draft = result.draft;
		saveFoldSettingsFile(this.settingsPath, this.draft);
		for (const row of EDITOR_ROWS) {
			const item = (this.settingsList as any).items.find((candidate: any) => candidate.id === row.id);
			if (item) item.currentValue = rowDisplayValue(this.draft, row.id, this.budgetTokens);
		}
		return { ok: true, display: rowDisplayValue(this.draft, id, this.budgetTokens) };
	}

	handleInput(data: string): void {
		// An open submenu owns Escape (it cancels the edit, not the screen).
		if (this.settingsList.submenuComponent) {
			this.settingsList.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.done(true);
			return;
		}
		this.settingsList.handleInput(data);
	}
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
			await ctx.ui.custom((_tui: unknown, theme: any, _keybindings: unknown, done: (saved: boolean) => void) =>
				new FoldSettingsEditor(draft, budgetTokens, settingsPath, theme, done));
		},
	});
}
