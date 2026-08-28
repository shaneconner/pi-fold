// /fold-settings: user-facing configuration for the deployment options that are
// otherwise code. The storage stays exactly what registerPiFold accepts (the
// thresholds object set whole); this module only
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
	DEFAULT_TOOL_FOLD_THRESHOLD,
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
	// TWO INDEPENDENT SCALARS, NOT A SECOND WHOLE-OBJECT (2026-08-28). The thresholds
	// object is stored whole because its fields carry cross-field invariants and a partial
	// one would silently mean whatever the defaults are at read time. These two answer to
	// nothing but themselves, so absent simply means the package default, which is what
	// lets an older file gain them without a migration.
	toolFoldThreshold?: number;
	postFoldNotice?: boolean;
}

// The four settings, named once. This was a hand-written union until the migration
// below needed the same names at runtime; deriving the type from the array is what
// keeps the two readings from drifting apart.
const THRESHOLD_FIELDS = [
	"maxTarget",
	"minTarget",
	"consolidateAfter",
	"minFoldChars",
] as const;

// The settings that are NOT thresholds. Each is a top-level scalar with its own
// validation and no relationship to any other value on the screen.
const SCALAR_FIELDS = ["toolFoldThreshold", "postFoldNotice"] as const;

export type FoldSettingId = typeof THRESHOLD_FIELDS[number] | typeof SCALAR_FIELDS[number];

function isThresholdField(id: FoldSettingId): id is typeof THRESHOLD_FIELDS[number] {
	return (THRESHOLD_FIELDS as readonly string[]).includes(id);
}

// One edit, applied against the WHOLE draft: the merged thresholds object is
// re-validated through resolveThresholds so cross-field invariants
// (minTarget < maxTarget) hold at every saved state, never
// only in the file's final form. Returns the next whole draft or a named error.
export function applyFoldSettingsEdit(
	draft: FoldSettingsFile,
	id: FoldSettingId,
	rawValue: string,
): { ok: true; draft: FoldSettingsFile } | { ok: false; error: string } {
	if (id === "postFoldNotice") {
		const raw = rawValue.trim().toLowerCase();
		if (raw !== "true" && raw !== "false") {
			return { ok: false, error: "postFoldNotice is on or off" };
		}
		return { ok: true, draft: { ...draft, postFoldNotice: raw === "true" } };
	}
	if (id === "toolFoldThreshold") {
		const value = Number(rawValue.trim());
		// The runtime's own range, restated here so the screen refuses before the file
		// does: [0, 1) with 0 meaning off. Absence would ALSO mean the default rather
		// than off, which is why 0 has to be expressible.
		if (!Number.isFinite(value) || value < 0 || value >= 1) {
			return { ok: false, error: "toolFoldThreshold is a share from 0 up to but not including 1; 0 turns it off" };
		}
		return { ok: true, draft: { ...draft, toolFoldThreshold: value } };
	}
	try {
		const value = Number(rawValue.trim());
		if ((id === "consolidateAfter" || id === "minFoldChars") && !Number.isSafeInteger(value)) {
			return { ok: false, error: `thresholds.${id} must be a whole number` };
		}
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

// Keys this package's own settings screen used to write. providerInputBudget left the
// user surface on 2026-08-21 and stayed a registration option for the harness.
const RETIRED_FILE_KEYS: readonly string[] = ["providerInputBudget"];

// Threshold fields this package's own surface used to write. freshTail was the fifth
// setting until 2026-08-23, when fresh-tail protection was deleted outright: nothing
// decided on it, and stale-first ordering already leaves recent material last. A stored
// file carrying it is a file /fold-settings itself wrote, so the field is dropped in
// migration, keeping every value the person actually tuned, rather than refused whole,
// which reverted maxTarget and minTarget to defaults over a key the person never chose.
const RETIRED_THRESHOLD_KEYS: readonly string[] = ["freshTail"];

export interface FoldSettingsLoad {
	settings: FoldSettingsFile;
	// Why the stored file was not used. Null when it was, including after a migration.
	refusal: string | null;
	// Fields the file predated were filled from the defaults and written back whole.
	migrated: boolean;
}

/**
 * A STORED FILE MAY NOT STOP THE AGENT (2026-08-22).
 *
 * The deployment calls this at module scope and hands the result to registerPiFold, so
 * anything thrown here is a pi that does not start: "Failed to load extension ... :
 * thresholds must declare minFoldChars". That is what shipping minFoldChars did to a
 * settings file written the day before, and a user's own config is data rather than
 * code: it may be refused, but it may not brick the session it configures.
 *
 * Two outcomes, and the split is deliberate.
 *
 * A file that is merely OLDER than the surface is MIGRATED. Fields it does not carry
 * are filled from the defaults, the whole object is validated the ordinary way, and the
 * result is written back so the file on disk is whole again, pinned at the value it was
 * migrated with. That keeps the values the person actually tuned and keeps the
 * whole-or-not-at-all law honest: a partial object never survives to be re-read against
 * a later set of defaults. A failed write-back is not fatal either; the migration stands
 * in memory and repeats harmlessly on the next boot.
 *
 * Anything else INVALID is refused by name and the package defaults are used, with the
 * reason kept for /fold-settings to state. The limit is stated rather than hidden: a
 * refused file reverts to defaults, and the settings screen is the only place that says
 * so, so a person who never opens it sees defaults without being told why.
 */
export function readFoldSettingsFile(path: string = DEFAULT_FOLD_SETTINGS_PATH): FoldSettingsLoad {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return { settings: {}, refusal: null, migrated: false };
		return { settings: {}, refusal: `fold settings file at ${path} could not be read: ${error?.message ?? error}`, migrated: false };
	}
	const refused = (reason: string): FoldSettingsLoad => ({
		settings: {},
		refusal: `${reason}. Package defaults are in force; /fold-settings writes a valid file.`,
		migrated: false,
	});
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch (error: any) {
		return refused(`fold settings file at ${path} is not valid JSON: ${error?.message ?? error}`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return refused(`fold settings file at ${path} must be a JSON object`);
	}
	// A key the surface RETIRED is dropped rather than refused: /fold-settings itself
	// wrote providerInputBudget until 2026-08-21, so refusing it would revert a file
	// this package created. A key that was never on the surface is still a refusal.
	let dropped = false;
	for (const key of Object.keys(parsed)) {
		if (key === "thresholds" || (SCALAR_FIELDS as readonly string[]).includes(key)) continue;
		if (RETIRED_FILE_KEYS.includes(key)) { delete parsed[key]; dropped = true; continue; }
		return refused(`fold settings file has no ${key} field: the surface is ` +
			`thresholds, ${SCALAR_FIELDS.join(", ")}`);
	}
	// The two scalars are validated the same way the editor validates them, through the
	// one path, so a hand-edited file cannot hold a value the screen would refuse.
	const scalars: FoldSettingsFile = {};
	for (const field of SCALAR_FIELDS) {
		if (parsed[field] === undefined) continue;
		const value = parsed[field];
		const applied = applyFoldSettingsEdit({}, field, String(value));
		if (!applied.ok) return refused(`fold settings ${field} is invalid: ${applied.error}`);
		// String("0.5") round-trips, but a JSON string would too, and the file's own type
		// has to be right or the value means something different on the next read.
		if (field === "postFoldNotice" && typeof value !== "boolean") {
			return refused("fold settings postFoldNotice must be true or false");
		}
		if (field === "toolFoldThreshold" && typeof value !== "number") {
			return refused("fold settings toolFoldThreshold must be a number");
		}
		Object.assign(scalars, applied.draft);
	}
	if (parsed.thresholds === undefined) {
		if (dropped) { try { saveFoldSettingsFile(path, scalars); } catch { } }
		return { settings: scalars, refusal: null, migrated: dropped };
	}
	const stored = parsed.thresholds;
	if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
		return refused("fold settings thresholds must be an object");
	}
	const supplied = { ...(stored as Record<string, unknown>) };
	for (const key of RETIRED_THRESHOLD_KEYS) {
		if (Object.prototype.hasOwnProperty.call(supplied, key)) { delete supplied[key]; dropped = true; }
	}
	const missing = THRESHOLD_FIELDS.filter((field) =>
		!Object.prototype.hasOwnProperty.call(supplied, field));
	try {
		const thresholds = resolveThresholds(missing.length
			? { ...Object.fromEntries(missing.map((field) => [field, DEFAULT_THRESHOLDS[field]])), ...supplied }
			: supplied);
		const migrated = missing.length > 0 || dropped;
		const settings: FoldSettingsFile = { thresholds, ...scalars };
		if (migrated) { try { saveFoldSettingsFile(path, settings); } catch { } }
		return { settings, refusal: null, migrated };
	} catch (error: any) {
		return refused(`fold settings file at ${path} is invalid: ${error?.message ?? error}`);
	}
}

export function loadFoldSettingsFile(path: string = DEFAULT_FOLD_SETTINGS_PATH): FoldSettingsFile {
	return readFoldSettingsFile(path).settings;
}

export function saveFoldSettingsFile(path: string, settings: FoldSettingsFile): void {
	const clean: FoldSettingsFile = {};
	if (settings.thresholds !== undefined) clean.thresholds = settings.thresholds;
	// Written only when SET. An absent scalar means the package default, and writing the
	// default out would pin today's value into a file that should follow the package.
	if (settings.toolFoldThreshold !== undefined) clean.toolFoldThreshold = settings.toolFoldThreshold;
	if (settings.postFoldNotice !== undefined) clean.postFoldNotice = settings.postFoldNotice;
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

// WRITTEN FOR THE READER, NOT THE IMPLEMENTER (2026-08-28). "Fires a fold epoch" and
// "parents owed per epoch = visible roots divided by this" are this codebase's words for
// its own internals, and a person setting a value should not have to learn them. Each
// description now says what the setting DOES to their session; the option name stays in
// parentheses as the bridge to the README table and to registerPiFold, which document
// these exact names.
const EDITOR_ROWS: readonly EditorRow[] = [
	{ id: "maxTarget", label: "Start folding at", description: "How full the window gets before pi-fold folds. Nothing moves below this (maxTarget)" },
	{ id: "minTarget", label: "Fold down to", description: "How empty a fold leaves the window. The gap between the two sets how often folding runs (minTarget)" },
	{ id: "consolidateAfter", label: "Folds per group", description: "Once this many folds are visible, pi-fold groups them under one (consolidateAfter)" },
	{ id: "minFoldChars", label: "Smallest fold", description: "Text this short is not worth folding on its own; it joins the fold beside it instead (minFoldChars)" },
	{ id: "toolFoldThreshold", label: "Clip old tool results", description: "The oldest share of the window shows tool results shortened, still recoverable in full. Off keeps them whole (toolFoldThreshold)" },
	{ id: "postFoldNotice", label: "Ask the model for briefs", description: "Invite the model to rewrite a fold's summary. Off is what the measured runs used (postFoldNotice)" },
];

// The cycle lattices. Shares step in cents so no float drift reaches a threshold;
// each row's list is FILTERED against the current draft before display, which is
// what makes an invalid combination unselectable rather than an error message.
const SHARE_STEPS: Record<"maxTarget" | "minTarget", { min: number; max: number; step: number }> = {
	maxTarget: { min: 0.40, max: 0.95, step: 0.05 },
	minTarget: { min: 0.05, max: 0.60, step: 0.05 },
};

const CONSOLIDATE_CHOICES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

// Characters, not tokens: a token means a different amount of text on every wire, and
// this is a number a person picks. The list starts at the hard floor the validator
// enforces, below which a placeholder can cost more than the source it replaces.
const MIN_FOLD_CHOICES = [2_000, 4_000, 6_000, 8_000, 12_000, 16_000, 24_000, 32_000];

// 0 IS ON THE LATTICE, and first, because absence means the package default rather than
// off: without a 0 here the only way to decline in-view clipping would be the file.
const TOOL_FOLD_CHOICES = [0, 0.25, 0.35, 0.50, 0.65, 0.75, 0.90];

function shareCandidates(id: "maxTarget" | "minTarget"): number[] {
	const { min, max, step } = SHARE_STEPS[id];
	const values: number[] = [];
	for (let cents = Math.round(min * 100); cents <= Math.round(max * 100); cents += Math.round(step * 100)) {
		values.push(cents / 100);
	}
	return values;
}

// The lattice a row steps along, as numbers. Display belongs to rowDisplayValue and
// only to it: this list is stepped, never shown.
function allowedValues(id: FoldSettingId, thresholds: ActiveContextThresholds): number[] {
	if (id === "toolFoldThreshold") return TOOL_FOLD_CHOICES;
	if (id === "consolidateAfter") return CONSOLIDATE_CHOICES;
	if (id === "minFoldChars") return MIN_FOLD_CHOICES;
	const { minTarget, maxTarget } = thresholds;
	return id === "maxTarget"
		? shareCandidates("maxTarget").filter((v) => v > minTarget)
		: shareCandidates("minTarget").filter((v) => v < maxTarget);
}

function rowRawValue(settings: FoldSettingsFile, id: FoldSettingId): string {
	// A SCALAR THAT IS ABSENT READS AS THE PACKAGE DEFAULT, never as zero or false. The
	// file omits what was never set on purpose, so the screen has to supply the same
	// value the runtime would, or the row would show a setting nobody chose.
	if (!isThresholdField(id)) {
		return id === "toolFoldThreshold"
			? String(settings.toolFoldThreshold ?? DEFAULT_TOOL_FOLD_THRESHOLD)
			: String(settings.postFoldNotice ?? false);
	}
	const thresholds = settings.thresholds ?? DEFAULT_THRESHOLDS;
	return String(thresholds[id]);
}

function rowDisplayValue(settings: FoldSettingsFile, id: FoldSettingId, budgetTokens: number): string {
	const raw = rowRawValue(settings, id);
	if (id === "postFoldNotice") return raw === "true" ? "on" : "off";
	if (id === "toolFoldThreshold") {
		// The share is of the window rather than of a budget, so it is stated as the
		// slice it names instead of the token count the other two shares translate to.
		return Number(raw) === 0 ? "off" : `oldest ${Math.round(Number(raw) * 100)}%`;
	}
	if (id === "consolidateAfter") return raw;
	if (id === "minFoldChars") return `${Number(raw).toLocaleString("en-US")} characters`;
	// A PERCENTAGE, like every other human surface. The screen used to read "0.80" while
	// the status line, /fold-status and the editor header all said "80%", so the one place
	// a person CHANGES the number spoke a different dialect from the three that report it.
	return `${Math.round(Number(raw) * 100)}% · ${Math.round(Number(raw) * budgetTokens).toLocaleString("en-US")} tokens`;
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
class FoldValueEditor extends Container {
	private readonly input = new Input();
	private readonly errorText = new Text("", 0, 0);

	constructor(
		private readonly themeLike: any,
		private readonly rowLabel: string,
		private readonly rowDescription: string,
		initialValue: string,
		private readonly apply: (raw: string) => { ok: true; display: string } | { ok: false; error: string },
		private readonly done: (displayValue?: string) => void,
	) {
		super();
		const theme = this.themeLike;
		this.addChild(new Text(theme.bold(theme.fg("accent", rowLabel)), 0, 0));
		this.addChild(new Text(theme.fg("muted", rowDescription), 0, 0));
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

	/** True until the first key: typing then REPLACES the prefill rather than
	 *  appending to it ("0.35" over "0.4" was landing as "0.40.35" and refusing).
	 *  Editing keys (backspace, arrows) keep the prefill for adjustment. */
	private pristine = true;

	handleInput(data: string): void {
		if (this.pristine && data.length === 1 && data >= " " && data !== "\x7f") {
			this.input.setValue("");
			(this.input as any).cursor = 0;
		}
		this.pristine = false;
		this.input.handleInput(data);
	}
}

// The /fold-settings screen itself: a SettingsList over the four rows, styled off
// the live theme, with every applied change persisted immediately the way Pi's own
// /settings persists. Left/right STEPS the selected row through its allowed
// increments (clamped at the range ends); Enter opens an exact-value editor.
export class FoldSettingsEditor extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		private draft: FoldSettingsFile,
		private readonly budgetTokens: number,
		private readonly settingsPath: string,
		private readonly themeLike: any,
		private readonly done: (saved: boolean) => void,
		// Why the stored file was not used, when it was not. This screen is the only
		// place a refused file is ever named, so it says so before showing the
		// defaults that took its place.
		notice: string | null = null,
	) {
		super();
		const theme = this.themeLike;
		this.addChild(new SettingsBorder((text) => theme.fg("border", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi-fold settings")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Percentages are of the usable window. Every change saves as you make it."), 0, 0));
		if (notice) this.addChild(new Text(theme.fg("error", notice), 0, 0));
		this.addChild(new Spacer(1));
		// SettingsList takes its own theme shape; adapt it off the live theme.
		const listTheme = {
			label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
			value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
			description: (text: string) => theme.fg("dim", text),
			cursor: theme.fg("accent", "→ "),
			// SettingsList ships its own hint, "Enter/Space to change · Esc to cancel", and
			// BOTH halves are wrong on this screen: Enter opens an exact-value editor rather
			// than cycling a value, and nothing is cancelled because every change is saved
			// the moment it is made. The hint function is ours and is handed the string, so
			// the correction happens here rather than being contradicted a line below.
			hint: (_text: string) => theme.fg("dim", "←→ adjust · Enter types an exact value · Esc closes"),
		};
		this.settingsList = new SettingsList(
			EDITOR_ROWS.map((row) => ({
				id: row.id,
				label: row.label,
				description: row.description,
				currentValue: rowDisplayValue(draft, row.id, budgetTokens),
				submenu: (_current: string, submenuDone: (displayValue?: string) => void) =>
					new FoldValueEditor(
						themeLike,
						row.label,
						row.description,
						rowRawValue(draft, row.id),
						(raw) => this.applyAndSave(row.id, raw),
						submenuDone,
					),
			})),
			EDITOR_ROWS.length + 2,
			listTheme,
			() => {},
			() => this.done(true),
		);
		this.addChild(this.settingsList);
		this.addChild(new SettingsBorder((text) => theme.fg("border", text)));
	}

	// One step along the row's allowed lattice, clamped at its ends. The lattice is
	// filtered against the CURRENT draft, so stepping can never leave the policy
	// surface; an exact off-lattice value arrives only through Enter's editor.
	private step(id: FoldSettingId, direction: number): void {
		// A SWITCH HAS NO LATTICE. Either direction moves to the other value, which is
		// what a person expects of a two-state row sitting among stepped ones.
		if (id === "postFoldNotice") {
			this.applyAndSave(id, rowRawValue(this.draft, id) === "true" ? "false" : "true");
			return;
		}
		const thresholds = this.draft.thresholds ?? DEFAULT_THRESHOLDS;
		const candidates = allowedValues(id, thresholds);
		const current = Number(rowRawValue(this.draft, id));
		const target = direction > 0
			? candidates.find((candidate) => candidate > current + 1e-9)
			: [...candidates].reverse().find((candidate) => candidate < current - 1e-9);
		if (target === undefined) return;
		this.applyAndSave(id, String(target));
	}

	private applyAndSave(id: FoldSettingId, raw: string): { ok: true; display: string } | { ok: false; error: string } {
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
		// An open submenu owns everything until it closes.
		if (this.settingsList.submenuComponent) {
			this.settingsList.handleInput(data);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.step(EDITOR_ROWS[this.settingsList.selectedIndex].id, -1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.step(EDITOR_ROWS[this.settingsList.selectedIndex].id, +1);
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
		description: "Configure pi-fold: commit band, consolidation, fold size, tool-result clipping, brief invitation",
		handler: async (_args: string, ctx: any) => {
			if (typeof ctx.ui?.custom !== "function") {
				throw new Error("/fold-settings needs an interactive UI; set thresholds in the settings file instead");
			}
			const stored = readFoldSettingsFile(settingsPath);
			const descriptorWindow = ctx.model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
			// SHARES APPLY TO THE MODEL WINDOW (Shane, 2026-08-21): providerInputBudget is
			// off the user surface, so what a share means is derived from the descriptor's
			// own window and nothing else. The registration option still exists for the
			// experiment harness, which declares a budget so runs stay comparable across
			// descriptor changes; no person has to know that to read this screen.
			const budgetTokens = servingBudgetTokens(descriptorWindow);
			await ctx.ui.custom((_tui: unknown, theme: any, _keybindings: unknown, done: (saved: boolean) => void) =>
				new FoldSettingsEditor(
					stored.settings, budgetTokens, settingsPath, theme, done, stored.refusal,
				));
		},
	});
}
