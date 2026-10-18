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
 * Nested editors (an editable transclusion body mounted inside a host
 * document, B11.22) sit INSIDE the host's root, and these listeners are
 * document-scoped — so a chord typed in the nested editor would also fire the
 * host's handler and act on the host's stale selection. A hook mounted under
 * a composer therefore ignores keydowns whose target belongs to a different,
 * nested Lexical root.
 *
 * Chord syntax is the shared parser (`@brainstorm-os/sdk/shortcut`'s
 * `matchesChord`) — same string format used everywhere else.
 */

import { matchesChord } from "@brainstorm-os/sdk/shortcut";
import { LexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useContext, useEffect, useRef } from "react";

/** Whether `event` originated inside a Lexical editor nested within `root`
 *  (not `root` itself). Events outside any editor (block-selection mode blurs
 *  the root to `<body>`) are NOT nested. */
export function isEventInNestedEditor(event: Event, root: HTMLElement | null): boolean {
	if (!root) return false;
	const target = event.target;
	if (!(target instanceof Element)) return false;
	const owner = target.closest('[data-lexical-editor="true"]');
	return owner !== null && owner !== root && root.contains(owner);
}

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
	const composer = useContext(LexicalComposerContext);
	const editorRef = useRef(composer?.[0] ?? null);
	editorRef.current = composer?.[0] ?? null;
	const enabled = options.enabled ?? true;
	const key = chords.join("\n");

	// biome-ignore lint/correctness/useExhaustiveDependencies: `chords` is a fresh array literal at most call sites — `key` is the joined-string proxy so the effect re-runs only when the chord set actually changes, not on every render.
	useEffect(() => {
		if (!enabled || chords.length === 0) return;
		function onKeydown(event: KeyboardEvent) {
			const editor = editorRef.current;
			if (editor && isEventInNestedEditor(event, editor.getRootElement())) return;
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
