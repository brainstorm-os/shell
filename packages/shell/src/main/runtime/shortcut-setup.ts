/**
 * Wires the ShortcutRegistry's shell layer into the dashboard / app windows
 * via `webContents.on("before-input-event", …)`.
 *
 *   - Shell shortcuts fire **only when a Brainstorm window has OS focus**.
 *     They do NOT capture OS-wide chords, so well-known OS bindings like
 *     macOS `Cmd+Space` (input-source switcher / Spotlight) keep working
 *     when Brainstorm is in the background.
 *   - Per-app shortcuts will be delivered the same way once apps land their
 *     manifest shortcuts (Stage 9 wires `before-input-event` on app
 *     windows). This module's `attach(webContents)` is the entry point.
 *
 * Why not `globalShortcut`? It registers OS-wide; that conflicts with the
 * principle from that Brainstorm is a
 * desktop-citizen, not a Spotlight clone. `before-input-event` is the
 * focus-scoped alternative recommended by Electron's docs for shortcuts
 * that should "work in the app but not steal the chord globally".
 */

import { BrowserWindow, type Input, type WebContents } from "electron";
import { ShortcutRegistry } from "../shortcuts/shortcut-registry";
import { surfaceWindow } from "../window/reveal-window";
import { SHELL_ACTION_CHANNEL } from "./menu-setup";

export type ShortcutSetupOptions = {
	registry?: ShortcutRegistry;
	getDashboard: () => WebContents | null;
	/** Live count of open app windows. The window-switcher chords (Ctrl+Tab /
	 *  Ctrl+Shift+Tab) only intercept when there are ≥2 windows to switch
	 *  between — otherwise the chord falls through so a focused app (Browser,
	 *  Code Editor) keeps Ctrl+Tab for its own in-app tab cycling. Defaults to
	 *  a value that always intercepts when omitted (tests / legacy callers). */
	getWindowCount?: () => number;
};

const SWITCH_WINDOW = "shell/switch-window";
const SWITCH_WINDOW_PREV = "shell/switch-window-prev";
/** Shell action sent on modifier-release while the switcher is open. */
const SWITCH_WINDOW_COMMIT_ACTION = "switch-window-commit";

export type ShortcutSetup = {
	registry: ShortcutRegistry;
	/** Attach the shell-layer `before-input-event` listener to a Brainstorm
	 *  window. The listener stays alive for the window's lifetime; pass each
	 *  new BrowserWindow's webContents here at create time. */
	attach: (webContents: WebContents) => void;
	/** No-op kept for API compatibility with the previous global-shortcut
	 *  implementation; before-input-event listeners are GC'd with their
	 *  webContents and we don't track them outside that. */
	registerAll: () => void;
	unregisterAll: () => void;
};

export function createShortcutSetup(options: ShortcutSetupOptions): ShortcutSetup {
	const registry = options.registry ?? new ShortcutRegistry();
	if (!options.registry) {
		registry.registerShell();
	}

	const attached = new WeakSet<WebContents>();
	const getWindowCount = options.getWindowCount ?? (() => 2);
	// True between dispatching a switch-window(-prev) open and the user
	// releasing the modifier. Shared across every attached window because the
	// modifier may be released on whichever window currently holds focus
	// (focus moves to the dashboard once the overlay surfaces).
	let switcherOpen = false;

	function attach(webContents: WebContents): void {
		if (attached.has(webContents)) return;
		attached.add(webContents);
		webContents.on("before-input-event", (event, input) => {
			const dashboard = options.getDashboard();
			if (!dashboard || dashboard.isDestroyed()) return;

			// Release-to-commit (classic Alt+Tab): letting go of Ctrl while the
			// switcher is open commits the highlighted window. Fires on whichever
			// window has focus, so we listen on every attached webContents.
			if (input.type === "keyUp") {
				if (switcherOpen && input.key === "Control") {
					switcherOpen = false;
					dashboard.send(SHELL_ACTION_CHANNEL, { action: SWITCH_WINDOW_COMMIT_ACTION });
				}
				return;
			}
			if (input.type !== "keyDown") return;
			const id = matchShellShortcut(registry, input);
			if (!id) return;
			// With <2 windows there is nothing to switch to — let the focused app
			// keep Ctrl+Tab instead of swallowing it.
			if ((id === SWITCH_WINDOW || id === SWITCH_WINDOW_PREV) && getWindowCount() < 2) {
				return;
			}
			if (id === SWITCH_WINDOW || id === SWITCH_WINDOW_PREV) switcherOpen = true;
			event.preventDefault();
			// Shell actions that open a UI on the dashboard (launcher,
			// settings, cheatsheet, …) need the dashboard focused when
			// fired from an app window. Silent actions like
			// `shell/appearance.toggle` set `surfacesOnDashboard: false`
			// and must NOT yank focus away from the active app window.
			const action = registry.shellBindings().find((b) => b.action.id === id)?.action;
			const surfaces = action?.surfacesOnDashboard !== false;
			if (surfaces && dashboard.id !== webContents.id) {
				const window = BrowserWindow.fromWebContents(dashboard);
				if (window) surfaceWindow(window);
			}
			dashboard.send(SHELL_ACTION_CHANNEL, { action: actionFor(id) });
		});
	}

	return {
		registry,
		attach,
		registerAll: () => undefined,
		unregisterAll: () => undefined,
	};
}

function actionFor(id: string): string {
	return id.replace(/^shell\//, "");
}

/** Find the shell shortcut whose chord matches the input event. Returns the
 *  registry id (e.g. `shell/launcher`) or null. Hot path: runs per keystroke
 *  on every window, so `registry.shellBindings()` is the cached shell-only
 *  view rather than the sorted full `listAll()`. */
export function matchShellShortcut(registry: ShortcutRegistry, input: Input): string | null {
	for (const binding of registry.shellBindings()) {
		if (!binding.chord) continue;
		if (chordMatchesInput(binding.chord, input)) {
			return binding.action.id;
		}
	}
	return null;
}

/** Compare a `CmdOrCtrl+K`-style chord against an Electron `Input` record.
 *  CmdOrCtrl resolves to Cmd on darwin, Ctrl elsewhere.
 *
 *  ASCII-letter and digit chords match on `input.code` (layout-invariant),
 *  so `Cmd+Shift+L` keeps working on AZERTY / Cyrillic / Dvorak without the
 *  user re-binding per layout. Semantic keys (Space, Enter, Escape, Arrow*,
 *  Tab, punctuation) match on `input.key` — they're physically
 *  locale-independent in practice. Per
 *  §Delivery mechanics. */
export function chordMatchesInput(chord: string, input: Input): boolean {
	const parts = chord.split("+").map((p) => p.trim());
	const key = parts[parts.length - 1];
	if (!key) return false;
	const mods = parts.slice(0, -1);
	// 6.10e — cross-layer single-key suppression. Single-key chords (no
	// modifier, e.g. `?`, `/`, `Escape`) are renderer-side only. The
	// main-process `before-input-event` listener has no view of renderer
	// focus, so it can't tell whether the user is typing into an input —
	// refuse to deliver to avoid hijacking the keystroke. Renderer-side
	// `useShortcut` does the input-focus check and dispatches when safe.
	if (mods.length === 0) return false;

	const isMac = process.platform === "darwin";
	const wantCmd = mods.includes("Cmd") || (mods.includes("CmdOrCtrl") && isMac);
	const wantCtrl = mods.includes("Ctrl") || (mods.includes("CmdOrCtrl") && !isMac);
	const wantAlt = mods.includes("Alt");
	const wantShift = mods.includes("Shift");

	if (!!input.meta !== wantCmd) return false;
	if (!!input.control !== wantCtrl) return false;
	if (!!input.alt !== wantAlt) return false;
	if (!!input.shift !== wantShift) return false;

	const expectedCode = codeForKey(key);
	if (expectedCode && input.code) {
		return input.code === expectedCode;
	}
	return normalizeKey(input.key) === normalizeKey(key);
}

/** For ASCII letters and digits the layout-invariant identifier lives in
 *  `KeyboardEvent.code` (e.g. `KeyL`, `Digit3`). Returns null for keys that
 *  don't have a stable `code` mapping (semantic keys, punctuation), and
 *  callers fall back to `input.key`. */
function codeForKey(key: string): string | null {
	if (key.length === 1) {
		const upper = key.toUpperCase();
		if (upper >= "A" && upper <= "Z") return `Key${upper}`;
		if (upper >= "0" && upper <= "9") return `Digit${upper}`;
	}
	return null;
}

function normalizeKey(key: string): string {
	if (key === " ") return "Space";
	if (key.length === 1) return key.toUpperCase();
	return key;
}
