/**
 * FindPlugin — wires the shared find & replace primitive into the Notes
 * editor (B9.1c). One `createFindController` per editor instance bound to
 * the Notes Lexical `TextSearchProvider` (B9.1b-adapter); the shared
 * `<FindBar>` (B9.1b-ui) is the UI; `attachFindShortcuts` binds the
 * canonical chords (`@brainstorm-os/sdk/find-replace`, the `nav-history`
 * adoption recipe). No app styling — the bar's `bs-find-bar` chrome is
 * shell-injected (the `.header-nav` precedent).
 *
 * Like BacklinksPlugin it renders outside the contenteditable; find is a
 * model primitive (OQ-185) so the editor-root click interceptor is
 * irrelevant here.
 */

import {
	FindBar,
	attachFindShortcuts,
	createFindController,
} from "@brainstorm-os/sdk/find-replace";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect, useMemo } from "react";
import { createLexicalSearchProvider } from "./find-provider";

export function FindPlugin() {
	const [editor] = useLexicalComposerContext();

	// One controller per editor instance. The composer remounts (keyed by
	// noteId) on note-switch, so a fresh controller + provider is created
	// for the new document — no stale match handles carry over.
	const controller = useMemo(
		() =>
			createFindController(createLexicalSearchProvider(editor), {
				persist: { key: "notes:find" },
			}),
		[editor],
	);

	// Closing on cleanup releases the controller's suppression source — without
	// this, switching notes while the bar is open leaks the `() => open`
	// closure into the module-level `Set` in `@brainstorm-os/sdk/shortcut/suppression`
	// forever, permanently suppressing every single-key chord across all apps.
	useEffect(() => {
		const detachChords = attachFindShortcuts(window, controller);
		return () => {
			detachChords();
			controller.close();
		};
	}, [controller]);

	// `find-replace` mode: the replace row is reachable whenever the bar
	// is open (open vs open-replace nicety folds into B9.2).
	return <FindBar controller={controller} mode="find-replace" />;
}
