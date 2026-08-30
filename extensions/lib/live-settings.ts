// THE CHANNEL FROM /fold-settings TO THE RUNNING RUNTIME.
//
// THE NEED, from a live session (2026-08-29). /fold-settings wrote the file and nothing
// else: `registerPiFold` resolves thresholds, toolFoldThreshold and the notice settings
// ONCE at registration, so a session kept the settings pi booted with while the screen showed
// what the person had just chosen. Shane's terminal held both at once, "Start folding at
// 40%" on the screen over "commit at 90%" on the status line, and neither surface said
// why. The file was the durable truth and the running session was not reading it.
//
// The two halves are registered independently, `registerFoldSettings(pi)` and
// `registerPiFold(pi, settings)`, in either order, and neither returns a handle the other
// can hold. What they do share is the HOST OBJECT, so that is the channel: the runtime
// hangs an applier off `pi` under a registry symbol, and the settings screen looks for it
// when a person saves an edit, which is long after both registrations have run. Late
// binding is what makes the order irrelevant.
//
// A MODULE-LEVEL SLOT WAS THE OTHER CANDIDATE AND IT IS WORSE: the applier would then be
// process-global, every gate that registers a runtime would leave one standing, and a
// screen in one host could push settings into a runtime in another. Keeping it on the
// host means an unregistered host simply has no applier, which is a state the screen can
// read and state honestly rather than a state it has to guess at.
//
// Symbol.for, not a fresh Symbol: the global registry keys by string, so a package loaded
// twice through different module caches (jiti in the suite, pi's own loader in the
// deployment) still agrees on the property.

import type { ActiveContextThresholds } from "./policy.ts";

/**
 * What the settings screen hands the runtime: exactly the settings FILE's shape, where an
 * absent field means the package default rather than "leave it alone". The runtime
 * resolves it the same way it resolves its registration options, through one code path,
 * so a value cannot mean one thing at boot and another at an edit.
 */
export interface LiveFoldSettings {
	thresholds?: ActiveContextThresholds;
	toolFoldThreshold?: number;
	preCommitNotice?: boolean;
	noticeLeadShare?: number;
}

/** Refuses by throwing, exactly as registration does, and leaves the runtime untouched. */
export type LiveSettingsApplier = (settings: LiveFoldSettings, ctx?: unknown) => void;

const LIVE_SETTINGS = Symbol.for("pi-fold.live-settings");

export function publishLiveSettings(host: any, apply: LiveSettingsApplier): void {
	// A HOST THAT REFUSES THE PROPERTY IS NOT A FAILURE. Nothing about folding depends on
	// this channel: without it the file is still written and the next start still reads
	// it, which is the behaviour every build before this one had.
	try { host[LIVE_SETTINGS] = apply; } catch { }
}

/** Whether an edit saved now would reach a running runtime. The settings screen states
 *  which of the two it is instead of promising the one it cannot deliver. */
export function liveSettingsReachable(host: any): boolean {
	try { return typeof host?.[LIVE_SETTINGS] === "function"; }
	catch { return false; }
}

/**
 * Push settings into the runtime registered on this host. Returns false when there is
 * none, and lets the applier's own refusal THROW: the caller decides what a refusal
 * means, and swallowing it here would leave a screen believing it had applied a value
 * the runtime rejected.
 */
export function applyLiveSettings(host: any, settings: LiveFoldSettings, ctx?: unknown): boolean {
	let apply: LiveSettingsApplier | undefined;
	try { apply = host?.[LIVE_SETTINGS]; } catch { return false; }
	if (typeof apply !== "function") return false;
	apply(settings, ctx);
	return true;
}
