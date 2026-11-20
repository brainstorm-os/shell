/**
 * Which note an editor instance is editing. Slash commands receive only the
 * editor, and a command that creates a sub-page must record its parent on the
 * new page (IE-12 site membership), so the editor's mount registers it here.
 */

import type { LexicalEditor } from "lexical";

const hostNoteIds = new WeakMap<LexicalEditor, string>();

export function setHostNoteId(editor: LexicalEditor, noteId: string | undefined): void {
	if (noteId) hostNoteIds.set(editor, noteId);
	else hostNoteIds.delete(editor);
}

export function getHostNoteId(editor: LexicalEditor): string | undefined {
	return hostNoteIds.get(editor);
}
