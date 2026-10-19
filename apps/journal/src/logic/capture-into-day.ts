/**
 * Quick capture into the day (9.16.14) — resolve the day to its ONE entry,
 * then commit the capture through that entry's live document.
 *
 * `ensureEntry` is the same day resolution the list and the open-today path
 * use, so the capture lands in the entry on screen; `append` writes through
 * the mounted editor and refuses a document that is not the resolved entry's,
 * which keeps the denormalised `body` snippet and word count on the row the
 * list shows instead of a sibling row for the same day.
 */

import type { SerializedEditorState } from "lexical";
import {
	type CaptureLinePart,
	CaptureOutcome,
	type CaptureWriter,
	type FileableCollection,
	commitCapture,
} from "./capture-filing";
import { CaptureKind, routeCapture } from "./quick-capture";

export type CaptureIntoDayInput = {
	raw: string;
	collections: readonly FileableCollection[];
	writer: CaptureWriter | null;
	/** Resolve (creating when the day is unwritten) the entry id for today. */
	ensureEntry: () => Promise<string | null>;
	/** Append through the live editor mounted on `noteId`; null when it is not. */
	append: (noteId: string, parts: readonly CaptureLinePart[]) => SerializedEditorState | null;
	/** Mirror the appended state into the entry's `body` snippet. */
	denormalize: (noteId: string, state: SerializedEditorState) => void;
};

export type CaptureIntoDayResult = { outcome: CaptureOutcome; collectionName: string | null };

export async function captureIntoDay(input: CaptureIntoDayInput): Promise<CaptureIntoDayResult> {
	const route = routeCapture(input.raw, input.collections);
	if (route.kind === CaptureKind.Empty) {
		return { outcome: CaptureOutcome.Ignored, collectionName: null };
	}
	const noteId = await input.ensureEntry();
	const result = await commitCapture({
		raw: input.raw,
		collections: input.collections,
		writer: input.writer,
		canAppend: () => noteId !== null,
		append: (parts) => {
			if (noteId === null) return false;
			const state = input.append(noteId, parts);
			if (!state) return false;
			input.denormalize(noteId, state);
			return true;
		},
	});
	const collectionName =
		result.route.kind === CaptureKind.File ? result.route.collection.name : null;
	return { outcome: result.outcome, collectionName };
}
