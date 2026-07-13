/**
 * Shortcut registry per.
 *
 *   Two layers:
 *     - Shell layer — always active. Owns `<shell/...>` ids. The chord can be
 *       rebound, but never disabled out of existence (rebinding to nothing
 *       just clears the chord; the action stays).
 *     - App layer  — active only when an app has OS-level focus. Owns
 *       `<app-id>/<id>` ids.
 *
 *   Conflicts:
 *     - Cross-layer conflicts: **app wins** when focused. This module reports
 *       the conflict for UI ("X conflicts with shell binding") but lets the
 *       app's chord live.
 *     - Within a layer: shell ships no internal conflicts; an app's manifest
 *       conflicts are install-time rejected (manifest validator job). User
 *       rebindings within a layer surface "this conflicts with Y" and the
 *       caller picks resolution.
 *
 *   This module owns the in-memory bindings table; persistence lives in
 *   `bindings-store.ts`. Both are pure code (no Electron deps).
 */

import type { ShortcutRegistration } from "../apps/manifest";
import { normalizeChord } from "./chord";

export { normalizeChord };

export type ShortcutAction = {
	/** `shell/<id>` or `<app-id>/<id>`. */
	id: string;
	/** Layer the action belongs to. */
	layer: "shell" | "app";
	/** App id when `layer === "app"`. */
	appId?: string;
	/** Default chord declared by the manifest / shell ship-set. */
	defaultChord: string | null;
	/** Display label. */
	label: string;
	/** Optional scope hint per : "window" | "editor" | "selection" | custom. */
	scope?: string;
	/** App layer only — manifest declared this binding *intentionally* shadows
	 *  a shell binding (per §App opt-in shadowing). Shell still wins
	 *  delivery at runtime; the flag is metadata for UI surfaces (install
	 *  prompt, settings panel) so the user can see what an app is claiming. */
	shadowsShell?: boolean;
	/** App layer only — true when registered at runtime via
	 *  `services.shortcuts.register` (state-dependent actions) instead of
	 *  the manifest. Dynamic bindings shadow static ones with the same id
	 *  (last-write-wins inside the app's namespace) and are cleared when
	 *  the app's last window closes. Iteration 6.10c. */
	dynamic?: boolean;
	/** Shell layer only — true when the action opens a UI on the dashboard
	 *  (launcher, settings, cheatsheet, …) and therefore needs the
	 *  dashboard window focused when fired from an app window. Defaults to
	 *  `true` for backwards-compat; set to `false` for silent shell
	 *  actions like `shell/appearance.toggle` that have no surface — those
	 *  should NOT yank focus away from the currently active app window. */
	surfacesOnDashboard?: boolean;
};

/** Wire shape for runtime-registered dynamic shortcuts. Identical to the
 *  manifest's `ShortcutRegistration` so `services.shortcuts.register` and
 *  the install-time mirror share one declaration form. */
export type DynamicShortcutDeclaration = {
	id: string;
	default: string;
	label: string;
	scope?: string;
	shadowsShell?: boolean;
};

/** What the registry holds after applying user overrides. */
export type ResolvedBinding = {
	action: ShortcutAction;
	/** Effective chord — user override if set, else default. `null` means
	 *  "no chord; action is only invokable via menu / palette / cheatsheet". */
	chord: string | null;
	/** Origin of the current chord. */
	source: "default" | "user-override" | "cleared";
};

export type ConflictReport = {
	chord: string;
	bindings: Array<{ id: string; layer: "shell" | "app"; appId?: string }>;
};

/** Built-in shell shortcuts per §Shell layer. */
export const DEFAULT_SHELL_SHORTCUTS: readonly Omit<ShortcutAction, "layer">[] = [
	// Cmd+K — macOS reserves Cmd+Space for Spotlight / the input-source
	// switcher, so that chord never reaches Brainstorm even when focused.
	{ id: "shell/launcher", defaultChord: "CmdOrCtrl+K", label: "Open Launcher" },
	// Browse-first start-menu grid of every installed app (the launcher palette
	// above is type-to-find; this is the grid you browse + pin from).
	{ id: "shell/app-grid", defaultChord: "CmdOrCtrl+Shift+Space", label: "Show All Apps" },
	// Same palette as the launcher — a second chord for Windows/Linux users who
	// expect Ctrl+Space. Does not reach the app on macOS when the OS owns
	// Cmd+Space for input switching.
	{ id: "shell/search", defaultChord: "CmdOrCtrl+Space", label: "Search Vault" },
	{ id: "shell/settings", defaultChord: "CmdOrCtrl+,", label: "Open Settings" },
	{ id: "shell/marketplace", defaultChord: "CmdOrCtrl+Shift+P", label: "Open Marketplace" },
	{ id: "shell/bin", defaultChord: "CmdOrCtrl+Shift+B", label: "Open Bin" },
	{ id: "shell/new", defaultChord: "CmdOrCtrl+N", label: "New" },
	// Ctrl+Tab (literal Control on every platform — Cmd+Tab is OS-reserved on
	// macOS, so CmdOrCtrl would never reach us there). Reverse cycle on
	// Ctrl+Shift+Tab. Release-to-commit (let go of Ctrl) is handled in
	// shortcut-setup.ts; the matcher only sees the keydown.
	{ id: "shell/switch-window", defaultChord: "Ctrl+Tab", label: "Switch Windows" },
	{
		id: "shell/switch-window-prev",
		defaultChord: "Ctrl+Shift+Tab",
		label: "Switch Windows (Reverse)",
	},
	{ id: "shell/close-window", defaultChord: "CmdOrCtrl+W", label: "Close Window" },
	{ id: "shell/quit", defaultChord: "CmdOrCtrl+Q", label: "Quit Brainstorm" },
	{ id: "shell/cheatsheet", defaultChord: "CmdOrCtrl+Shift+K", label: "Show Shortcuts Cheatsheet" },
	{ id: "shell/help", defaultChord: "?", label: "Contextual Help" },
	{
		id: "shell/appearance.toggle",
		defaultChord: "CmdOrCtrl+Shift+L",
		label: "Toggle Light / Dark Appearance",
		// Silent action — toggles theme tokens, opens no overlay. The
		// dashboard handler applies the cycle; we still dispatch the action
		// there, but the chord must NOT yank focus away from the active app
		// window. Bug 2026-05-23: hitting Cmd+Shift+L in any app pulled the
		// dashboard forward, blurring the user's current task.
		surfacesOnDashboard: false,
	},
	{ id: "shell/vault-switcher", defaultChord: "CmdOrCtrl+Shift+V", label: "Switch Vault" },
] as const;

export class ShortcutRegistry {
	private readonly actions = new Map<string, ShortcutAction>();
	private readonly overrides = new Map<string, string | null>(); // id → user-set chord or null="cleared"
	/** Dynamic-source app shortcuts (6.10c). Separate map so the same
	 *  `app/<appId>/<id>` key can hold a dynamic binding that shadows a
	 *  static manifest entry without being clobbered when the manifest
	 *  set is re-registered (e.g. on dev hot-reload). Cleared on the
	 *  app's last window close. */
	private readonly dynamic = new Map<string, ShortcutAction>();
	/** Per-app active scope reported via `setActiveScope` (6.10c). The
	 *  cheatsheet aggregator filters app bindings by this. `null` means
	 *  "no scope reported" — the aggregator treats that as "include
	 *  every binding for the app" (no narrow filter applied). */
	private readonly activeScopes = new Map<string, string | null>();
	/** Cached resolved shell-layer bindings (`shellBindings()`). Built on
	 *  demand, invalidated whenever a shell action or override changes.
	 *  Hot-path: every `before-input-event` runs through this. */
	private shellBindingsCache: ResolvedBinding[] | null = null;

	/** Register shell-side shortcuts. Idempotent — re-registering an id replaces. */
	registerShell(actions: readonly Omit<ShortcutAction, "layer">[] = DEFAULT_SHELL_SHORTCUTS): void {
		for (const action of actions) {
			this.actions.set(action.id, { ...action, layer: "shell" });
		}
		this.shellBindingsCache = null;
	}

	/** Register an app's shortcuts. Replaces any prior set for that app id. */
	registerApp(appId: string, manifestShortcuts: readonly ShortcutRegistration[]): void {
		// Clear prior shortcuts for this app first so a downgrade-uninstall
		// doesn't leave orphans.
		for (const [id, action] of this.actions) {
			if (action.layer === "app" && action.appId === appId) {
				this.actions.delete(id);
			}
		}
		for (const s of manifestShortcuts) {
			const id = `${appId}/${s.id}`;
			this.actions.set(id, {
				id,
				layer: "app",
				appId,
				defaultChord: s.default,
				label: s.label,
				...(s.scope !== undefined ? { scope: s.scope } : {}),
				...(s.shadowsShell === true ? { shadowsShell: true } : {}),
			});
		}
	}

	unregisterApp(appId: string): void {
		for (const [id, action] of this.actions) {
			if (action.layer === "app" && action.appId === appId) {
				this.actions.delete(id);
			}
		}
		// Clear any overrides for this app too — its actions are gone.
		for (const id of this.overrides.keys()) {
			if (id.startsWith(`${appId}/`)) this.overrides.delete(id);
		}
		// Dynamic + active-scope are runtime state; clear on uninstall too.
		this.unregisterAllDynamic(appId);
	}

	/**
	 * 6.10c — register runtime (state-dependent) shortcuts for an app.
	 * Coexists with static manifest entries: a dynamic id `app/<appId>/<id>`
	 * shadows the static entry with the same id. Re-calling with the same id
	 * replaces the prior dynamic entry (last-write-wins per id).
	 */
	registerAppDynamic(appId: string, additions: readonly DynamicShortcutDeclaration[]): void {
		for (const s of additions) {
			const id = `${appId}/${s.id}`;
			this.dynamic.set(id, {
				id,
				layer: "app",
				appId,
				defaultChord: s.default,
				label: s.label,
				dynamic: true,
				...(s.scope !== undefined ? { scope: s.scope } : {}),
				...(s.shadowsShell === true ? { shadowsShell: true } : {}),
			});
		}
	}

	/** 6.10c — remove specific dynamic shortcuts by app-scoped id.
	 *  `ids` are relative (the same `id` form the app passed to
	 *  `registerAppDynamic`); they are namespaced to `<appId>/<id>`
	 *  before lookup. Unknown ids are silent no-ops. */
	unregisterAppDynamic(appId: string, ids: readonly string[]): void {
		for (const id of ids) {
			this.dynamic.delete(`${appId}/${id}`);
		}
	}

	/** 6.10c — clear ALL dynamic shortcuts + active-scope state for an app.
	 *  Called on the app's last-window-close (the dynamic lifetime contract
	 *  per §Aggregation). Idempotent. */
	unregisterAllDynamic(appId: string): void {
		const prefix = `${appId}/`;
		for (const id of this.dynamic.keys()) {
			if (id.startsWith(prefix)) this.dynamic.delete(id);
		}
		this.activeScopes.delete(appId);
	}

	/** 6.10c — record the currently-active scope reported by an app
	 *  (e.g. "editor", "selection"). `null` clears. Read by the
	 *  cheatsheet aggregator to filter narrow-scoped app bindings.
	 *  The active scope is in-memory only — never persisted. */
	setActiveScope(appId: string, scope: string | null): void {
		this.activeScopes.set(appId, scope);
	}

	/** 6.10c — current active scope for an app, or `null` if unset. */
	getActiveScope(appId: string): string | null {
		const v = this.activeScopes.get(appId);
		return v === undefined ? null : v;
	}

	/** Apply user-stored overrides (loaded from `shortcut-bindings.json`). */
	applyOverrides(entries: ReadonlyArray<{ id: string; chord: string | null }>): void {
		for (const entry of entries) {
			this.overrides.set(entry.id, entry.chord);
		}
		this.shellBindingsCache = null;
	}

	overrideOne(id: string, chord: string | null): void {
		this.overrides.set(id, chord);
		this.shellBindingsCache = null;
	}

	resetOverride(id: string): void {
		this.overrides.delete(id);
		this.shellBindingsCache = null;
	}

	/** Currently-effective binding for an action. Dynamic shadows static
	 *  with the same id (6.10c). */
	resolve(id: string): ResolvedBinding | null {
		const action = this.dynamic.get(id) ?? this.actions.get(id);
		if (!action) return null;
		if (this.overrides.has(id)) {
			const chord = this.overrides.get(id) ?? null;
			return { action, chord, source: chord === null ? "cleared" : "user-override" };
		}
		return { action, chord: action.defaultChord, source: "default" };
	}

	/** All resolved bindings, sorted by id for stable display. Dynamic
	 *  bindings shadow static ones with the same id (6.10c). */
	listAll(): ResolvedBinding[] {
		const seen = new Set<string>();
		const out: ResolvedBinding[] = [];
		for (const id of this.dynamic.keys()) {
			const resolved = this.resolve(id);
			if (resolved) {
				out.push(resolved);
				seen.add(id);
			}
		}
		for (const action of this.actions.values()) {
			if (seen.has(action.id)) continue;
			const resolved = this.resolve(action.id);
			if (resolved) out.push(resolved);
		}
		out.sort((a, b) => (a.action.id < b.action.id ? -1 : 1));
		return out;
	}

	/** Resolved shell-layer bindings only. Cached + reused across calls so the
	 *  per-keystroke `matchShellShortcut` path doesn't re-sort the whole
	 *  registry. Invalidated on `registerShell` / override mutations. */
	shellBindings(): readonly ResolvedBinding[] {
		if (this.shellBindingsCache) return this.shellBindingsCache;
		const out: ResolvedBinding[] = [];
		for (const action of this.actions.values()) {
			if (action.layer !== "shell") continue;
			const resolved = this.resolve(action.id);
			if (resolved) out.push(resolved);
		}
		this.shellBindingsCache = out;
		return out;
	}

	/** Snapshot of user overrides — feeds the persistence layer. */
	snapshotOverrides(): Array<{ id: string; chord: string | null }> {
		return [...this.overrides.entries()].map(([id, chord]) => ({ id, chord }));
	}

	/** Find every binding currently using `chord`. Useful for "this chord is
	 *  in use by X" warnings in the rebinding UI. Iterates `listAll()` so
	 *  dynamic + static + shell bindings are all considered (6.10c). */
	findByChord(chord: string): ResolvedBinding[] {
		const normalized = normalizeChord(chord);
		const out: ResolvedBinding[] = [];
		for (const binding of this.listAll()) {
			if (binding.chord && normalizeChord(binding.chord) === normalized) {
				out.push(binding);
			}
		}
		return out;
	}

	/** All conflicts (within and across layers). One report per chord with ≥2
	 *  bindings. Within-layer conflicts are surfaced as errors by callers;
	 *  cross-layer is a warning ("app overrides shell when focused"). */
	conflicts(): ConflictReport[] {
		const byChord = new Map<string, ResolvedBinding[]>();
		for (const binding of this.listAll()) {
			if (!binding.chord) continue;
			const normalized = normalizeChord(binding.chord);
			let set = byChord.get(normalized);
			if (!set) {
				set = [];
				byChord.set(normalized, set);
			}
			set.push(binding);
		}
		const out: ConflictReport[] = [];
		for (const [chord, bindings] of byChord) {
			if (bindings.length < 2) continue;
			out.push({
				chord,
				bindings: bindings.map((b) => {
					const entry: { id: string; layer: "shell" | "app"; appId?: string } = {
						id: b.action.id,
						layer: b.action.layer,
					};
					if (b.action.appId !== undefined) entry.appId = b.action.appId;
					return entry;
				}),
			});
		}
		return out;
	}
}

/**
 * Snapshot of effective shell-layer chords (default + any user override),
 * normalized for comparison. Consumed by the install-time validator to
 * detect manifest-vs-shell collisions (per §App opt-in shadowing).
 *
 * Resolves through the same `listAll()` path the matcher uses, so a user
 * who has rebound `shell/launcher` frees the original chord for apps.
 */
export function shellChordSet(registry: ShortcutRegistry): Set<string> {
	const out = new Set<string>();
	for (const binding of registry.listAll()) {
		if (binding.action.layer !== "shell") continue;
		if (!binding.chord) continue;
		out.add(normalizeChord(binding.chord));
	}
	return out;
}
