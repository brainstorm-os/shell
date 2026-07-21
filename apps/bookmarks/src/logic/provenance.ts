/**
 * Capture provenance + large-page detection (9.18.13).
 *
 * A captured bookmark body is a machine extraction of a live page, not the
 * original markup — readers deserve to know that, and to be warned when a page
 * was large enough that the extractor may have dropped the tail. Both signals
 * are derived purely from the stored `contentBlocks`, so this keystone is
 * DOM-free and unit-tested without the detail view.
 */

import type { SerializedBlock } from "@brainstorm-os/sdk-types";

/** A captured body past this many blocks is flagged "large" — the extractor's
 *  byte cap means very long pages may be truncated mid-article. Tuned so a
 *  normal long-read article (a few hundred paragraphs) stays unflagged. */
export const LARGE_PAGE_BLOCK_THRESHOLD = 600;

/** …or past this many characters of extracted text, whichever trips first. */
export const LARGE_PAGE_CHAR_THRESHOLD = 80_000;

/** Total block count, descending into `children` (the Lexical tree is nested:
 *  paragraphs hold text nodes, lists hold items, etc.). */
export function countBlocks(blocks: readonly SerializedBlock[] | undefined): number {
	if (!blocks) return 0;
	let total = 0;
	for (const b of blocks) {
		total += 1;
		if (Array.isArray(b.children)) total += countBlocks(b.children as SerializedBlock[]);
	}
	return total;
}

/** Approximate extracted-text length — sums the `text` of every leaf node in
 *  the tree. Used only to gauge page size, so a rough character count (not a
 *  grapheme count) is fine. */
export function estimateTextLength(blocks: readonly SerializedBlock[] | undefined): number {
	if (!blocks) return 0;
	let total = 0;
	for (const b of blocks) {
		if (typeof b.text === "string") total += b.text.length;
		if (Array.isArray(b.children)) total += estimateTextLength(b.children as SerializedBlock[]);
	}
	return total;
}

/**
 * Whether a captured body is large enough that the extractor may have dropped
 * content — trips on either the block-count or the character-count threshold.
 * Empty / absent content is never "large".
 */
export function isLargeCapture(blocks: readonly SerializedBlock[] | undefined): boolean {
	if (!blocks || blocks.length === 0) return false;
	return (
		countBlocks(blocks) > LARGE_PAGE_BLOCK_THRESHOLD ||
		estimateTextLength(blocks) > LARGE_PAGE_CHAR_THRESHOLD
	);
}
