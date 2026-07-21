/**
 * Renderer-side shortcut delivery hook per
 * and the workflow rule in
 * §Keyboard handling.
 *
 * This module is the **only** place in the renderer that translates browser
 * KeyboardEvents into action invocations. Every other component declares an
 * action id and calls `useShortcut(id, handler)` — raw `e.key === "..."`
 * listeners are a PR-blocker.
 *
 * Until the main-process shortcut registry's per-renderer push lands (a
 * follow-up iteration), this hook ships an interim chord parser sufficient
 * for component-scoped shortcuts like `Escape`, `Enter`, `Arrow…`, and
 * single-char modifier combos. The chord syntax matches the registry's
 * canonical form (`CmdOrCtrl+K`, `Shift+Enter`) so the binding contract is
 * already correct when the live override stream arrives.
 *
 * Action ids and their default chords live in `default-chords.ts`. New
 * actions are added there + (eventually) registered with the main-process
 * shortcut registry so they appear in the cheatsheet and in Settings.
 */

import { useEffect, useRef } from "react";
import { defaultChordFor } from "./default-chords";
import { isEditableElement } from "./is-editable";

/** Where the shortcut is active. `global` listens on window; `scope` on a
 *  specific element (focus must be inside it). */
export type ShortcutTarget =
	| { kind: "global" }
	| { kind: "scope"; ref: React.RefObject<HTMLElement | null> };

export type UseShortcutOptions = {
	/** Activation target. Default: `{ kind: "global" }`. */
	target?: ShortcutTarget;
	/** Set to false to temporarily disable without unmounting. */
	enabled?: boolean;
	/** Override the registry's default chord. Useful for tests; production
	 *  code should leave this unset and let the registry decide. */
	chord?: string | null;
};

/**
 * Bind a handler to a shortcut id. The id must exist in `default-chords.ts`
 * (which mirrors what the main-process registry will publish). The hook
 * looks up the effective chord and listens for it.
 *
 * Examples:
 *
 *   useShortcut("shell/popover.confirm", onConfirm);
 *   useShortcut("io.example.editor/save", onSave, { target: { kind: "scope", ref: editorRef } });
 *
 * For Escape on overlay surfaces, prefer `useEscapeStackEntry` from
 * `@brainstorm-os/sdk/a11y` (KBN-2) — it pushes onto the renderer-wide LIFO
 * the document-level Escape handler drains, so nested overlays unwind
 * topmost-first under one source of truth.
 */
export function useShortcut(
	id: string,
	handler: (event: KeyboardEvent) => void,
	options: UseShortcutOptions = {},
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	const enabled = options.enabled ?? true;
	const chord = options.chord !== undefined ? options.chord : defaultChordFor(id);

	useEffect(() => {
		if (!enabled || chord === null) return;
		const target = options.target ?? { kind: "global" as const };
		const eventTarget: HTMLElement | Window | null =
			target.kind === "scope" ? target.ref.current : window;
		if (!eventTarget) return;

		const listener = ((event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (!matchesChord(event, chord)) return;
			// 6.10e — cross-layer single-key suppression. Single-key chords
			// (no modifier, e.g. `?`, `/`, `Escape`) skip when focus is in
			// an editable element so the user can type the character.
			// Modifier chords (Cmd+?, Ctrl+Shift+K) always pass through.
			if (chordIsSingleKey(chord) && isEditableElement(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			handlerRef.current(event);
		}) as EventListener;

		eventTarget.addEventListener("keydown", listener);
		return () => eventTarget.removeEventListener("keydown", listener);
	}, [chord, enabled, options.target]);
}

/**
 * Check whether a browser KeyboardEvent satisfies a chord string. Chord
 * format: `[<Mod>+]<Key>` where `<Mod>` is one or more of `CmdOrCtrl`, `Mod`,
 * `Cmd`, `Ctrl`, `Alt`, `Shift` joined by `+`, and `<Key>` is the canonical key
 * name (`Escape`, `Enter`, `ArrowDown`, `Space`, `A`, etc.).
 */
export function matchesChord(event: KeyboardEvent, chord: string): boolean {
	const parts = chord.split("+").map((p) => p.trim());
	const key = parts[parts.length - 1];
	if (!key) return false;
	const mods = parts.slice(0, -1);

	const isMac =
		typeof navigator !== "undefined" &&
		/mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent);

	// `Mod` is the canonical cross-platform modifier token the chord-capture
	// system emits for user rebindings (Cmd on mac, Ctrl elsewhere) — same
	// semantics as `CmdOrCtrl`. Without aliasing it, `Mod+a` parsed to "no
	// modifier + a" and matched a PLAIN `a` keystroke once the override stream
	// feeds `Mod+…` chords here. Mirrors `@brainstorm-os/sdk/shortcut`.
	const wantMeta = mods.includes("CmdOrCtrl") || mods.includes("Mod");
	const wantCmd = mods.includes("Cmd") || (wantMeta && isMac);
	const wantCtrl = mods.includes("Ctrl") || (wantMeta && !isMac);
	const wantAlt = mods.includes("Alt");
	const wantShift = mods.includes("Shift");

	if (!!event.metaKey !== wantCmd) return false;
	if (!!event.ctrlKey !== wantCtrl) return false;
	if (!!event.altKey !== wantAlt) return false;
	if (!!event.shiftKey !== wantShift) return false;

	return normalizeKey(event.key) === normalizeKey(key);
}

function normalizeKey(key: string): string {
	if (key === " ") return "Space";
	if (key.length === 1) return key.toUpperCase();
	return key;
}

/** A chord is "single-key" when it carries no modifier (`Cmd`/`Ctrl`/
 *  `CmdOrCtrl`/`Alt`/`Shift`). Such chords are intentional plain
 *  keystrokes (`?`, `/`, `Escape`) — they're the ones that need
 *  editable-focus suppression per 6.10e. */
export function chordIsSingleKey(chord: string): boolean {
	const parts = chord.split("+").map((p) => p.trim());
	return parts.length <= 1;
}
