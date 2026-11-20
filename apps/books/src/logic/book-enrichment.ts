/**
 * Catalog backfill for a reflowable book (EPUB / FB2) from the metadata its
 * own file carries: the real title, the author, an embedded cover. Backfill
 * only — a value the user set is never overwritten. The title is replaced
 * only while the book still carries a name derived from its filename.
 */

import { titleFromName } from "./book-import";
import { UNTITLED_BOOK } from "./epub-content";
import { coverPropertyValue, pdfAuthorEnrichment } from "./pdf-metadata";

export type ReflowEnrichmentFacts = {
	currentName: string;
	currentAuthor: string;
	/** The backing file's name, to recognise a still-default book title. */
	fileName: string;
	hasCover: boolean;
	/** The freshly-stored cover URL, or `null` when none was extracted. */
	coverUrl: string | null;
};

/** Every title Books has ever derived from `fileName`: today's (which drops
 *  a compound `.fb2.epub`), and the earlier one that dropped only the final
 *  extension — the name existing vault rows still carry. */
function filenameTitles(fileName: string): string[] {
	const base = fileName.replace(/^.*[\\/]/, "");
	return [titleFromName(fileName), base.replace(/\.[^.]+$/, ""), base];
}

export function isFilenameTitle(currentName: string, fileName: string): boolean {
	const current = currentName.trim();
	return current.length === 0 || filenameTitles(fileName).includes(current);
}

export function reflowEnrichmentPatch(
	meta: { title: string; author: string },
	facts: ReflowEnrichmentFacts,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const author = pdfAuthorEnrichment({ Author: meta.author }, facts.currentAuthor);
	if (author) patch.author = author;
	const title = meta.title.trim();
	if (
		title.length > 0 &&
		title !== UNTITLED_BOOK &&
		title !== facts.currentName.trim() &&
		isFilenameTitle(facts.currentName, facts.fileName)
	) {
		patch.name = title;
	}
	if (!facts.hasCover && facts.coverUrl) patch.cover = coverPropertyValue(facts.coverUrl);
	return patch;
}
