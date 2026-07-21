/**
 * buildJournalDenormalizer — the Journal half of the shared editor save
 * contract (see `@brainstorm-os/editor`'s `denormalizeBody`).
 *
 * The rich body persists automatically through the Y.Doc resolver
 * (`services.entities.applyDoc`). This callback keeps the entity's
 * denormalised `body` snippet in sync so the calendar strip, week / month
 * overviews and word counts reflect the edit without re-resolving the
 * Y.Doc per cell. Mounted via the interaction-gated `AutosavePlugin`, so
 * the mount-settle / hydration echo never fires a spurious write.
 *
 * It writes `body` (the clipped snippet) + `wordCount` (over the WHOLE
 * body, not the snippet — recomputing from the clip would cap the count)
 * — but NOT `title`. A Journal entry is
 * identified by its ISO-date title (`projectJournalEntries` parses the
 * day from `properties.title` and drops any entry whose title isn't a
 * canonical date). Overwriting the title with a body heading would erase
 * the entry from every Journal surface.
 */

import { denormalizeBody } from "@brainstorm-os/editor";
import type { SerializedEditorState } from "lexical";

export type EntryUpdateFn = (id: string, patch: Record<string, unknown>) => unknown;

export type DenormalizedEntry = { snippet: string; wordCount: number };

export function buildJournalDenormalizer(
	update: EntryUpdateFn,
	noteId: string,
	/** Invoked synchronously with the freshly computed snippet + word count
	 *  on every save. The app uses it to mirror the values into local state
	 *  and the live word-count readout WITHOUT a full repaint — a repaint
	 *  would tear the focused editor host out of the DOM and drop the caret. */
	onComputed?: (result: DenormalizedEntry) => void,
): (state: SerializedEditorState) => void {
	return (state) => {
		const { snippet, wordCount } = denormalizeBody(state);
		void update(noteId, { body: snippet, wordCount });
		onComputed?.({ snippet, wordCount });
	};
}
