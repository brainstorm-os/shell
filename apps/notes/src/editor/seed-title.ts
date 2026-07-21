/**
 * seed-title — builds a `shouldBootstrap`-compatible initializer that
 * seeds a TitleNode (+ trailing paragraph) into a fresh Y.Doc.
 *
 * Why this exists: Lexical 0.21's `CollaborationPlugin` forbids
 * `editorState` and instead owns bootstrap behind a length check on the
 * root XmlText. Passing this function via `initialEditorState` lets us
 * carry the StoredNote's display title (legacy notes, journal date-key
 * notes, compose-intent seeds) into a fresh body — without bypassing
 * the CRDT and without forking @lexical/yjs. The function is idempotent
 * across concurrent opens by construction: it only runs on the first
 * client to attach to an empty doc (`root._xmlText._length === 0`); a
 * second client sees the already-seeded XmlText and skips its own
 * bootstrap.
 *
 * Trim semantics match the rest of Notes (the sidebar / `<header>`
 * already display `note.title.trim()`): a whitespace-only stored title
 * is treated as no title and the TitleNode is left empty so the
 * TitlePlugin's RootNode-transform-driven invariant ("root.firstChild
 * is always a TitleNode") fills the gap.
 */

import { $createTitleNode } from "@brainstorm-os/editor";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	type RootNode,
} from "lexical";

/** Seed an empty note root with its canonical starting shape: a TitleNode
 *  (carrying the trimmed `storedTitle`, if any) + a trailing ParagraphNode.
 *  The single source of truth for what a fresh note looks like — both
 *  `makeNoteBootstrap` (the `CollaborationPlugin` bootstrap path) and
 *  `normalizeEmptyDoc` (the empty-doc safety net) call it, so the two can
 *  race on a fresh doc without ever producing divergent trees. The caller
 *  guarantees `root` is empty. */
export function $seedEmptyNoteBody(root: RootNode, storedTitle: string): void {
	const seed = storedTitle.trim();
	const title = $createTitleNode();
	if (seed.length > 0) title.append($createTextNode(seed));
	root.append(title, $createParagraphNode());
}

export function makeNoteBootstrap(storedTitle: string): (editor: LexicalEditor) => void {
	return (editor: LexicalEditor) => {
		void editor;
		const root = $getRoot();
		if (!root.isEmpty()) return;
		$seedEmptyNoteBody(root, storedTitle);
	};
}
