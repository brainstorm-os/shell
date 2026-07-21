/**
 * Table-of-contents model — ONE entry shape (`title` + stable `Locator` +
 * nesting `depth`) for both reading surfaces, so the inspector renders a
 * TOC without branching on format:
 *
 *   • reflow (EPUB / sample): every spine item is a chapter — its locator
 *     is the chapter start (`{spineIndex, 0}`);
 *   • PDF: the document outline, flattened by the shared
 *     `resolvePdfOutline` (`@brainstorm-os/sdk/pdf-engine`) into 0-based page
 *     indices, which ARE the PDF locator's spine indices (9.21.5).
 *
 * Pure — no DOM, no pdf.js dep (the resolved outline entries come in).
 */

import type { PdfOutlineEntry } from "@brainstorm-os/sdk/pdf-engine";
import { type Locator, makeLocator } from "../types/locator";
import type { BookContent } from "./content";

export type TocEntry = {
	title: string;
	locator: Locator;
	/** Nesting level, 0 = top. Reflow chapters are flat (always 0). */
	depth: number;
};

/** Chapter list for a reflowable book — one entry per spine item. */
export function tocFromContent(content: BookContent): TocEntry[] {
	return content.spine.map((item, spineIndex) => ({
		title: item.title,
		locator: makeLocator(spineIndex, 0),
		depth: 0,
	}));
}

/** Map a resolved PDF outline onto TOC entries. Entries pointing past the
 *  document clamp out (skipped) — a malformed bookmark must not produce a
 *  dead row. */
export function tocFromPdfOutline(
	outline: readonly PdfOutlineEntry[],
	pageCount: number,
): TocEntry[] {
	return outline
		.filter((entry) => entry.pageIndex >= 0 && entry.pageIndex < pageCount)
		.map((entry) => ({
			title: entry.title,
			locator: makeLocator(entry.pageIndex, 0),
			depth: entry.depth,
		}));
}
