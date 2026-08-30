/**
 * Layout-measured pagination — page breaks derived from what the text
 * ACTUALLY occupies, not from a character budget.
 *
 * The original model (`charBudgetPaginator`) sized a page as
 * `columns × lines` of solid text. Prose is not solid: every paragraph ends
 * on a ragged part-empty line and adds a bottom margin, so the budget
 * over-filled the page and `.books__page`'s `overflow: hidden` silently ate
 * the excess. Measured against a real EPUB (a paragraph-dense Russian
 * translation) 61 of 77 pages overflowed, losing 17.6% of each page on
 * average and 73% at worst — text the reader could neither see nor scroll to.
 *
 * The renderer measures every block ONCE per (width × typography) into an
 * offscreen ruler and hands the metrics here; packing them into pages is then
 * pure arithmetic, so this stays unit-testable with no DOM. Locators are
 * untouched — a page is still a `LocatorRange` over character offsets, so
 * highlights, reading position and progress all keep working.
 */

import { type LocatorRange, makeLocator } from "../types/locator";
import type { IndexedSpineItem } from "./content";
import type { Page, Pagination } from "./pagination";

/** The measured geometry of one rendered block. */
export type BlockMetrics = {
	/** Height of the block's box in px, excluding its bottom margin. */
	height: number;
	/** The margin that follows the block in flow. `.books__page` establishes a
	 *  block formatting context (`overflow: hidden`), so even the last block's
	 *  margin counts toward the page's content height. */
	marginBottom: number;
	/** Rendered line count — only used to split a block taller than a whole
	 *  page, where the break must land mid-paragraph. */
	lines: number;
};

/** Per-spine-item block metrics, parallel to `IndexedSpineItem.blocks`. */
export type SpineMetrics = readonly (readonly BlockMetrics[])[];

const FALLBACK_METRICS: BlockMetrics = { height: 0, marginBottom: 0, lines: 1 };

/** The char ranges one spine item's pages cover, in reading order. */
function pageRangesForItem(
	item: IndexedSpineItem,
	metrics: readonly BlockMetrics[],
	pageHeight: number,
): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let pageStart = 0;
	let used = 0;

	item.blocks.forEach((indexed, index) => {
		const m = metrics[index] ?? FALLBACK_METRICS;
		const advance = m.height + m.marginBottom;
		const { start, end } = indexed;

		if (advance > pageHeight) {
			// A block taller than the page must break inside itself. Close the
			// page in progress, then slice the block by whole lines — the char
			// offsets are proportional because a line's character count is
			// near-constant within one block.
			if (used > 0) ranges.push([pageStart, start]);
			const lines = Math.max(1, m.lines);
			const lineHeight = Math.max(1, m.height / lines);
			// Every chunk is still rendered as the block it came from, so it
			// carries the block's trailing margin too — the lines only get what
			// is left after it. Budgeting the whole page height for lines put a
			// 20-line chunk plus its 16px margin into a 712px page.
			const usable = Math.max(lineHeight, pageHeight - m.marginBottom);
			const linesPerPage = Math.max(1, Math.floor(usable / lineHeight));
			// Each chunk re-wraps independently, and a word that straddled the
			// cut can push the chunk one line past what the whole block
			// measured — so a split page keeps a line of headroom. Without it
			// the tail of a long verse paragraph clipped by ~2px.
			const fitLines = linesPerPage > 1 ? linesPerPage - 1 : 1;
			const chars = Math.max(1, Math.ceil(((end - start) * fitLines) / lines));
			for (let offset = start; offset < end; offset += chars) {
				ranges.push([offset, Math.min(offset + chars, end)]);
			}
			pageStart = end;
			used = 0;
			return;
		}

		if (used > 0 && used + advance > pageHeight) {
			ranges.push([pageStart, start]);
			pageStart = start;
			used = advance;
			return;
		}
		used += advance;
	});

	// The tail page, plus the empty-spine-item case (a chapter with no blocks
	// still gets one page so it stays reachable from the TOC).
	if (used > 0 || ranges.length === 0) ranges.push([pageStart, item.length]);
	return ranges;
}

/**
 * Page breaks from measured block geometry. `availableHeight` is the reading
 * page's content-box height in px. Pages never span spine items (a chapter
 * always starts a new page), exactly as the char-budget model did.
 */
export function paginateMeasured(
	spine: readonly IndexedSpineItem[],
	metrics: SpineMetrics,
	availableHeight: number,
): Pagination {
	const pageHeight = Math.max(1, availableHeight);
	const pages: Page[] = [];
	let totalChars = 0;

	spine.forEach((item, spineIndex) => {
		totalChars += item.length;
		for (const [from, to] of pageRangesForItem(item, metrics[spineIndex] ?? [], pageHeight)) {
			const range: LocatorRange = {
				start: makeLocator(spineIndex, from),
				end: makeLocator(spineIndex, to),
			};
			pages.push({ index: pages.length, range });
		}
	});

	return { pages, totalChars };
}
