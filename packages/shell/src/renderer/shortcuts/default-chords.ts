/**
 * Renderer-side action id → default chord lookup.
 *
 * Mirrors the chords the main-process `ShortcutRegistry` ships with (per
 * `main/shortcuts/shortcut-registry.ts` `DEFAULT_SHELL_SHORTCUTS`) plus the
 * component-scoped ids that aren't surfaced as user-rebindable shortcuts in
 * the cheatsheet but still go through the registry per the workflow rule
 * in §Keyboard handling.
 *
 * When the main-process registry's per-renderer push lands, this file
 * becomes the seed and the live override stream takes over. The action id
 * is the stable contract.
 */

const DEFAULT_CHORDS: Record<string, string | null> = {
	// Shell layer (mirrors DEFAULT_SHELL_SHORTCUTS in the main registry)
	"shell/launcher": "CmdOrCtrl+K",
	"shell/app-grid": "CmdOrCtrl+Shift+Space",
	"shell/search": "CmdOrCtrl+Space",
	"shell/settings": "CmdOrCtrl+,",
	"shell/marketplace": "CmdOrCtrl+Shift+P",
	"shell/bin": "CmdOrCtrl+Shift+B",
	"shell/new": "CmdOrCtrl+N",
	"shell/switch-window": "Ctrl+Tab",
	"shell/switch-window-prev": "Ctrl+Shift+Tab",
	"shell/close-window": "CmdOrCtrl+W",
	"shell/quit": "CmdOrCtrl+Q",
	"shell/cheatsheet": "CmdOrCtrl+Shift+K",
	"shell/help": "?",
	"shell/appearance.toggle": "CmdOrCtrl+Shift+L",
	"shell/vault-switcher": "CmdOrCtrl+Shift+V",

	// Help-1 — search-input chord while the Help overlay is open. The
	// `useShortcut` only binds while the overlay is mounted, so it doesn't
	// clash with `editor/find` in other surfaces.
	"shell/help.search": "CmdOrCtrl+F",

	// Component-scoped ids — uniform across popovers / dialogs / lists.
	//
	// KBN-2: `shell/popover.close` is INFORMATIONAL — the cheatsheet ("Escape
	// closes the popover") still renders from this entry, but no renderer
	// component binds it via `useShortcut` anymore. Escape on overlay surfaces
	// is delivered by the document-level handler installed in `dashboard.tsx`
	// (`installEscapeHandler` from `@brainstorm-os/sdk/a11y`) which drains the
	// LIFO of `useEscapeStackEntry` registrations.
	"shell/popover.close": "Escape",
	"shell/popover.confirm": "Enter",
	"shell/popover.confirm-secondary": "Space",
	"shell/list.next": "ArrowDown",
	"shell/list.previous": "ArrowUp",
	"shell/list.next-horizontal": "ArrowRight",
	"shell/list.previous-horizontal": "ArrowLeft",
	"shell/list.cycle-next": "Tab",
	"shell/list.cycle-previous": "Shift+Tab",

	// App layer — the shared in-app back/forward every first-party app
	// binds via `@brainstorm-os/sdk/nav-history` (NAV_*_CHORD). Apps bind
	// these directly (the SDK chord layer has no registry dependency); the
	// ids here are the stable contract for the cheatsheet + the future
	// live-override stream. Alt+Arrow is a second binding the SDK adds.
	"app/nav.back": "CmdOrCtrl+[",
	"app/nav.forward": "CmdOrCtrl+]",

	// In-document find & replace (B9.1c), bound in every text app via
	// `@brainstorm-os/sdk/find-replace` `attachFindShortcuts`. As with nav,
	// apps bind directly — these ids are the stable cheatsheet contract.
	// One representative chord each (the SDK binds the full set incl. the
	// input-local Enter/Shift+Enter).
	"editor/find": "CmdOrCtrl+F",
	"editor/find.replace": "CmdOrCtrl+Alt+F",
	"editor/find.next": "CmdOrCtrl+G",
	"editor/find.previous": "CmdOrCtrl+Shift+G",
	"editor/find.close": "Escape",

	// Settings → Devices (10.5b — pairing UX). Component-scoped — not in
	// the user-rebindable shell layer; declared here so the registry path
	// is uniform and the cheatsheet can surface them later.
	"shell.devices.addDevice": "CmdOrCtrl+N",
	"shell.devices.confirmMatch": "Enter",
	"shell.devices.cancelPairing": "Escape",
};

export function defaultChordFor(id: string): string | null {
	return id in DEFAULT_CHORDS ? (DEFAULT_CHORDS[id] ?? null) : null;
}

/** For tests / future integration with the main-process registry. */
export function registerDefaultChord(id: string, chord: string | null): void {
	DEFAULT_CHORDS[id] = chord;
}
