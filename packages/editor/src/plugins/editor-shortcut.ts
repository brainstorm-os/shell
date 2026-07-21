/**
 * Capture-phase keyboard hook scoped to the shared editor plugins.
 *
 * Why this exists alongside `@brainstorm-os/sdk/shortcut`:
 *   - Block-level keybindings (Backspace/Delete/ArrowUp/ArrowDown/Mod+a,
 *     copy/cut/paste/duplicate, move-block) must fire BEFORE Lexical's
 *     contenteditable handlers can swallow them. The SDK hook binds in
 *     bubble phase, which is too late for these chords.
 *   - Multiple chords per action (e.g. Backspace AND Delete both delete
 *     the selected blocks) are common in the editor; the SDK hook is
 *     one-chord-per-call.
 *   - The capture-phase listener stays on `document` so it owns the
 *     event before any nested popover / overlay handler.
 *
 * Chord syntax is the shared parser (`@brainstorm-os/sdk/shortcut`'s
 * `matchesChord`) — same string format used everywhere else.
 */

import { matchesChord } from "@brainstorm-os/sdk/shortcut";
import { useEffect, useRef } from "react";

export type EditorShortcutOptions = {
	/** Set false to skip binding without unmounting. */
	enabled?: boolean;
};

/** Bind a list of chords to one handler, capture-phase, document-scoped.
 *  Handler kept in a ref so a re-render doesn't re-bind. */
export function useEditorShortcut(
	chords: readonly string[],
	handler: (event: KeyboardEvent) => void,
	options: EditorShortcutOptions = {},
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;
	const enabled = options.enabled ?? true;
	const key = chords.join("\n");

	// biome-ignore lint/correctness/useExhaustiveDependencies: `chords` is a fresh array literal at most call sites — `key` is the joined-string proxy so the effect re-runs only when the chord set actually changes, not on every render.
	useEffect(() => {
		if (!enabled || chords.length === 0) return;
		function onKeydown(event: KeyboardEvent) {
			for (const chord of chords) {
				if (matchesChord(event, chord)) {
					handlerRef.current(event);
					return;
				}
			}
		}
		document.addEventListener("keydown", onKeydown, true);
		return () => document.removeEventListener("keydown", onKeydown, true);
	}, [key, enabled]);
}
