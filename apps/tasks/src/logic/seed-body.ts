/**
 * Pure helpers for the lazy `notes: string` → universal-body migration
 * (9.14.6). A task created before the inspector existed carries its
 * content in a flat `notes` string; the inspector seeds the task's
 * Y.Doc body from that string on first open and clears the legacy field
 * once the body owns the content (so there's never a moment of data
 * loss, and never two competing sources of truth).
 *
 * The mechanics are the SHARED `@brainstorm/editor` legacy-text helpers
 * (Contacts' `bio` rides the same path); these wrappers keep the
 * task-vocabulary names the app + its tests use.
 */

import {
	hasLegacyText,
	plainTextToSerializedState,
	shouldClearLegacyText,
} from "@brainstorm/editor";
import type { SerializedEditorState } from "lexical";

export function notesStringToSerializedState(notes: string): SerializedEditorState {
	return plainTextToSerializedState(notes);
}

/** True when a legacy `notes` string is worth seeding into the body —
 *  i.e. there's actual content to carry over. */
export function hasLegacyNotes(notes: string | undefined | null): notes is string {
	return hasLegacyText(notes);
}

/**
 * Decide whether the first real body edit on a task should clear its
 * legacy `notes` string. Fires once per task: only when the task still
 * carries a non-empty `notes` AND this session hasn't already migrated
 * it (the caller tracks migrated ids in a Set).
 */
export function shouldClearLegacyNotes(
	notes: string | undefined | null,
	alreadyMigrated: boolean,
): boolean {
	return shouldClearLegacyText(notes, alreadyMigrated);
}
