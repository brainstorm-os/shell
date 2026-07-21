/**
 * Journal day-body editor bridge (9.16.10).
 *
 * The day editor is a React island (`entry-editor.tsx`) but the "Link
 * entry" affordance lives in the plain-DOM `app.ts` shell. This module
 * holds the currently-mounted editor instance (captured via an
 * `EditorCapturePlugin` inside the island) so the affordance can insert a
 * real `MentionNode` reference into the body — the same node the `@`
 * typeahead creates, so the shell's `extractNoteReferences` walker surfaces
 * it as a two-way link.
 *
 * Capturing a single module-level editor matches the Journal app's
 * single-day-open model (only one entry editor is mounted at a time).
 */

import { $createMentionNode, applySuggestionInEditor } from "@brainstorm-os/editor";
import type { CommentAnchor } from "@brainstorm-os/sdk-types";
import {
	$createTextNode,
	$getRoot,
	$getSelection,
	$insertNodes,
	$isRangeSelection,
	type LexicalEditor,
} from "lexical";

let captured: LexicalEditor | null = null;

export function setJournalEditor(editor: LexicalEditor): void {
	captured = editor;
}

/** Clear only if `editor` is the live one — guards a cross-day remount
 *  (new mounts, old unmounts) from nulling the freshly-captured editor. */
export function clearJournalEditor(editor: LexicalEditor): void {
	if (captured === editor) captured = null;
}

export function hasJournalEditor(): boolean {
	return captured !== null;
}

/** Apply a suggestion thread's proposed edit to the live day editor (B11.9).
 *  False when no editor is mounted or the anchor is stale — the panel keeps
 *  the thread open. */
export function applyJournalSuggestion(
	anchor: CommentAnchor,
	replacement: string | undefined,
): boolean {
	if (!captured) return false;
	return applySuggestionInEditor(captured, anchor, replacement);
}

/** Insert an entity-reference mention at the editor's caret (or the end of
 *  the document when nothing is focused), followed by a trailing space.
 *  Returns false when no editor is mounted (preview / standalone) so the
 *  caller can no-op gracefully. */
export function insertEntityMention(entityId: string, entityType: string, label: string): boolean {
	if (!captured) return false;
	const editor = captured;
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) $getRoot().selectEnd();
		$insertNodes([$createMentionNode(entityId, entityType, label), $createTextNode(" ")]);
	});
	editor.focus();
	return true;
}
