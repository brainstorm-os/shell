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
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$insertNodes,
	$isParagraphNode,
	$isRangeSelection,
	type LexicalEditor,
	type SerializedEditorState,
} from "lexical";
import { type CaptureLinePart, CapturePartKind } from "../logic/capture-filing";

let captured: LexicalEditor | null = null;
let capturedNoteId: string | null = null;

/** Capture the live editor together with the entry it is mounted on, so a
 *  programmatic write can prove it targets the document on screen. */
export function setJournalEditor(editor: LexicalEditor, noteId: string): void {
	captured = editor;
	capturedNoteId = noteId;
}

/** Clear only if `editor` is the live one — guards a cross-day remount
 *  (new mounts, old unmounts) from nulling the freshly-captured editor. */
export function clearJournalEditor(editor: LexicalEditor): void {
	if (captured !== editor) return;
	captured = null;
	capturedNoteId = null;
}

export function hasJournalEditor(): boolean {
	return captured !== null;
}

/** The entry the live editor is mounted on, or null when none is. */
export function journalEditorNoteId(): string | null {
	return capturedNoteId;
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

/** Append one captured line (9.16.14) as a new paragraph at the END of the
 *  day — never at the caret, so a capture never splices into whatever the
 *  user was mid-way through. A fresh day's lone empty paragraph is reused
 *  rather than left as a blank first line. Committed synchronously, so the
 *  returned state is what the denormaliser mirrors into the `body` snippet
 *  (the interaction-gated autosave never sees this programmatic edit).
 *  Null when no editor is mounted, or when the mounted editor is not on
 *  `noteId` — the capture resolved the day to one entry and must write
 *  through that entry's live document, never a sibling's. */
export function appendJournalLine(
	noteId: string,
	parts: readonly CaptureLinePart[],
): SerializedEditorState | null {
	if (!captured || capturedNoteId !== noteId) return null;
	const editor = captured;
	editor.update(
		() => {
			const root = $getRoot();
			const last = root.getLastChild();
			const reuse =
				root.getChildrenSize() === 1 &&
				$isParagraphNode(last) &&
				last.getTextContent().trim() === "" &&
				last.getChildrenSize() === 0;
			const paragraph = reuse && $isParagraphNode(last) ? last : $createParagraphNode();
			for (const part of parts) {
				paragraph.append(
					part.kind === CapturePartKind.Mention
						? $createMentionNode(part.entityId, part.entityType, part.label)
						: $createTextNode(part.text),
				);
			}
			if (paragraph !== last) root.append(paragraph);
		},
		{ discrete: true },
	);
	return editor.getEditorState().toJSON();
}
