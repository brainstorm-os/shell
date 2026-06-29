/**
 * React host for the Journal day-body editor island.
 *
 * Wraps `<JournalEntryEditor>` in the shell-installed `YDocResolverProvider`
 * and owns the per-note blank-render recovery budget (F-236): when the Y.Doc
 * has content but Lexical rendered none (an apply/observeDeep race that lost a
 * seeded / cold-reopened body), the editor asks to remount.
 *
 * A naive same-id key bump does NOT heal it. `useYDoc` resolves the replica
 * during *render* but releases it in an effect *cleanup*, so a key bump renders
 * the new editor (→ `resolve(id)`, which returns the SAME already-populated doc
 * because the old handle's ref hasn't dropped yet) before the old editor's
 * cleanup runs. The entry never reaches refs 0, so it's never retained/revived
 * as a fresh replica — the new binding observes a full doc, gets zero
 * `observeDeep` events, and stays blank through every attempt. So recovery
 * renders an explicit unmount GAP (`null`) for a frame: the old editor fully
 * releases (ref → 0 → the resolver retains the live replica), then the remount
 * revives it into a FRESH doc whose snapshot re-applies after the new binding's
 * `observeDeep` — the path that reliably hydrates.
 *
 * `key={noteId}` remains load-bearing for the day switch — React must FULLY
 * unmount the prior subtree (its `useYDoc(id)` + `<CollaborationPlugin>`) and
 * remount against the new note, else the title swaps but the contenteditable
 * keeps the prior day's text. Same discipline as the Notes editor caller.
 *
 * Standalone (`vite preview`) exposes no resolver — the parent renders the
 * read-only fallback paragraph instead of mounting this island.
 */

import type { SelectionCommentAnchor } from "@brainstorm/editor";
import { YDocProvider, type YDocResolver, useBlankRecoveryGap } from "@brainstorm/react-yjs";
import { JournalEntryEditor } from "../entry-editor";
import type { JournalCommentHooks, JournalDenormalizeFn } from "../entry-editor-mount";

export type EntryEditorIslandProps = {
	resolver: YDocResolver;
	noteId: string;
	/** When `false`, the entry is locked (read-only). Defaults to editable. */
	editable?: boolean;
	seedBody?: unknown;
	onDenormalize?: JournalDenormalizeFn;
	comments?: JournalCommentHooks;
	/** Hint shown while the body is empty (the "Write…" prompt on an
	 *  entry-less day before the user types). */
	placeholder?: string;
};

export function EntryEditorIsland({
	resolver,
	noteId,
	editable,
	seedBody,
	onDenormalize,
	comments,
	placeholder,
}: EntryEditorIslandProps) {
	// `gapped` renders the editor away for one frame to force a full release →
	// revive cycle (see the file header); never paints between in practice
	// because recovery is rare and the prior state was already blank. The
	// shared hook owns the budget + the rAF gap (used identically by Notes).
	const { gapped, onRecoverBlank, onRecoverReset } = useBlankRecoveryGap(noteId);

	return (
		<YDocProvider resolver={resolver}>
			{gapped ? null : (
				<JournalEntryEditor
					key={noteId}
					noteId={noteId}
					editable={editable ?? true}
					seedBody={seedBody}
					{...(placeholder ? { placeholder } : {})}
					onRecoverBlank={onRecoverBlank}
					onRecoverReset={onRecoverReset}
					{...(onDenormalize ? { onDenormalize } : {})}
					{...(comments
						? {
								onCommentSelection: comments.onSelection,
								onCommentBlockClick: comments.onBlockClick,
							}
						: {})}
				/>
			)}
		</YDocProvider>
	);
}
