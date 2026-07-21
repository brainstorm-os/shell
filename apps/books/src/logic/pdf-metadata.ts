/**
 * Pure PDF-metadata → entity enrichment. When a PDF first opens, the
 * reader already holds an open pdf.js document; this module turns its
 * embedded `info` dictionary (and a freshly-stored cover URL) into the
 * `Book/v1` property patch that backfills the catalog — author from the
 * document's `Author` field, the universal `properties.cover` from the
 * page-one render. Both are *backfill only*: a value the user already set
 * is never clobbered (we only enrich an empty author / a cover-less book).
 *
 * DOM-free + engine-free so every branch is unit-tested; the canvas render
 * + cover upload glue lives in `render/pdf-cover.ts` + the app.
 */

import { CoverKind } from "@brainstorm-os/sdk-types";

/** The slice of pdf.js `getMetadata().info` we read. Structurally typed —
 *  no dependency on pdf.js's large `.d.ts`. */
export type PdfInfo = {
	Title?: unknown;
	Author?: unknown;
};

function cleanString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The author to write, or `null` when there's nothing to enrich (the book
 *  already has an author, or the document carries none). */
export function pdfAuthorEnrichment(info: PdfInfo | null, currentAuthor: string): string | null {
	if (currentAuthor.trim().length > 0) return null;
	const author = cleanString(info?.Author);
	return author.length > 0 ? author : null;
}

/** A better display title from the document's embedded `Title`, or `null`.
 *  Only offered when the current name is empty or still the import-time
 *  filename stem (`fromFilename`) — never overrides a user rename. */
export function pdfTitleEnrichment(
	info: PdfInfo | null,
	currentName: string,
	fromFilename: string,
): string | null {
	const current = currentName.trim();
	if (current.length > 0 && current !== fromFilename.trim()) return null;
	const title = cleanString(info?.Title);
	return title.length > 0 && title !== current ? title : null;
}

/** The universal `properties.cover` value for an uploaded cover image URL. */
export function coverPropertyValue(url: string): { kind: CoverKind.Image; value: string } {
	return { kind: CoverKind.Image, value: url };
}

export type EnrichmentFacts = {
	currentAuthor: string;
	currentName: string;
	/** The import-time filename stem, so a title enrichment can tell a
	 *  user rename from the default name. */
	fromFilename: string;
	hasCover: boolean;
	/** The freshly-stored cover URL, or `null` when no cover was rendered. */
	coverUrl: string | null;
};

/** Assemble the full `entities.update` patch from a document's info + the
 *  facts about the current row. Returns an empty object when nothing needs
 *  backfilling — callers skip the write on `Object.keys(patch).length === 0`. */
export function pdfEnrichmentPatch(
	info: PdfInfo | null,
	facts: EnrichmentFacts,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const author = pdfAuthorEnrichment(info, facts.currentAuthor);
	if (author) patch.author = author;
	const title = pdfTitleEnrichment(info, facts.currentName, facts.fromFilename);
	if (title) patch.name = title;
	if (!facts.hasCover && facts.coverUrl) patch.cover = coverPropertyValue(facts.coverUrl);
	return patch;
}
