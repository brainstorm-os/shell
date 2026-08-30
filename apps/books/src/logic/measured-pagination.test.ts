/** Layout-measured pagination (F-500) — page breaks packed from real block
 *  geometry. The headline invariant is that a page never holds more than fits:
 *  the char-budget model it replaces overflowed 61 of 77 pages on a real EPUB,
 *  and `.books__page`'s `overflow: hidden` silently ate the difference. */
import { describe, expect, it } from "vitest";
import { BlockKind, type ContentBlock, type SpineItem, indexSpineItem } from "./content";
import { type BlockMetrics, paginateMeasured } from "./measured-pagination";

const PAGE = 100;

function para(text: string): ContentBlock {
	return { kind: BlockKind.Paragraph, text };
}

function item(...blocks: ContentBlock[]): SpineItem {
	return { title: "T", blocks };
}

/** Uniform metrics: every block `height` tall with a 10px trailing margin. */
function metrics(heights: readonly number[], lines = 1): BlockMetrics[] {
	return heights.map((height) => ({ height, marginBottom: 10, lines }));
}

/** The height one page's blocks actually occupy, mirroring what the browser
 *  lays out — the assertion the old model could not make. */
function occupied(
	spineItem: ReturnType<typeof indexSpineItem>,
	blockMetrics: readonly BlockMetrics[],
	from: number,
	to: number,
): number {
	let total = 0;
	spineItem.blocks.forEach((indexed, i) => {
		if (indexed.end <= from || indexed.start >= to) return;
		const m = blockMetrics[i];
		if (m) total += m.height + m.marginBottom;
	});
	return total;
}

describe("paginateMeasured", () => {
	it("fills a page to the measured height and breaks before the overflowing block", () => {
		// 4 blocks of 30+10=40 each: two fit (80), the third would make 120.
		const spine = [indexSpineItem(item(para("aaaa"), para("bbbb"), para("cccc"), para("dddd")))];
		const pagination = paginateMeasured(spine, [metrics([30, 30, 30, 30])], PAGE);
		expect(pagination.pages).toHaveLength(2);
		expect(pagination.pages[0]?.range).toEqual({
			start: { spineIndex: 0, charOffset: 0 },
			end: { spineIndex: 0, charOffset: 8 },
		});
		expect(pagination.pages[1]?.range.end).toEqual({ spineIndex: 0, charOffset: 16 });
	});

	it("never packs a page beyond the available height", () => {
		const blocks = Array.from({ length: 40 }, (_, i) => para("x".repeat(i + 1)));
		const heights = blocks.map((_, i) => 12 + (i % 7) * 9);
		const spineItem = indexSpineItem(item(...blocks));
		const m = metrics(heights);
		const pagination = paginateMeasured([spineItem], [m], PAGE);
		for (const page of pagination.pages) {
			const used = occupied(spineItem, m, page.range.start.charOffset, page.range.end.charOffset);
			expect(used).toBeLessThanOrEqual(PAGE);
		}
	});

	it("covers every character exactly once, in order", () => {
		const blocks = Array.from({ length: 25 }, (_, i) => para("y".repeat(10 + i)));
		const spineItem = indexSpineItem(item(...blocks));
		const pagination = paginateMeasured([spineItem], [metrics(blocks.map(() => 45))], PAGE);
		let cursor = 0;
		for (const page of pagination.pages) {
			expect(page.range.start.charOffset).toBe(cursor);
			cursor = page.range.end.charOffset;
		}
		expect(cursor).toBe(spineItem.length);
	});

	it("splits a block taller than a whole page across pages", () => {
		// A 10-line, 500px block (50px/line) into a 100px page: 2 lines fit,
		// one is kept as re-wrap headroom, so each page takes 1 line = 10 chars.
		const spineItem = indexSpineItem(item(para("z".repeat(100))));
		const pagination = paginateMeasured(
			[spineItem],
			[[{ height: 500, marginBottom: 0, lines: 10 }]],
			PAGE,
		);
		expect(pagination.pages).toHaveLength(10);
		expect(pagination.pages[0]?.range.end.charOffset).toBe(10);
		expect(pagination.pages.at(-1)?.range.end.charOffset).toBe(100);
	});

	// A split chunk re-flows on its own; a word that straddled the cut can wrap
	// it one line further than the source block measured. Filling a split page
	// to the brim clipped the tail of a long verse paragraph by ~2px.
	it("keeps a line of headroom on a split page", () => {
		const spineItem = indexSpineItem(item(para("w".repeat(120))));
		const pagination = paginateMeasured(
			[spineItem],
			// 12 lines of 25px into a 100px page: 4 lines fit, 3 are used.
			[[{ height: 300, marginBottom: 0, lines: 12 }]],
			PAGE,
		);
		expect(pagination.pages[0]?.range.end.charOffset).toBe(30);
	});

	it("closes the page in progress before splitting an over-tall block", () => {
		const spineItem = indexSpineItem(item(para("aa"), para("b".repeat(50))));
		const pagination = paginateMeasured(
			[spineItem],
			[
				[
					{ height: 20, marginBottom: 10, lines: 1 },
					{ height: 400, marginBottom: 0, lines: 8 },
				],
			],
			PAGE,
		);
		expect(pagination.pages[0]?.range).toEqual({
			start: { spineIndex: 0, charOffset: 0 },
			end: { spineIndex: 0, charOffset: 2 },
		});
		expect(pagination.pages[1]?.range.start.charOffset).toBe(2);
	});

	it("leaves room for a split chunk's own trailing margin", () => {
		// 20 lines of 35px = 700px + a 16px margin into a 712px page: budgeting
		// the full page height would fit 20 lines and render 716px.
		const spineItem = indexSpineItem(item(para("v".repeat(200))));
		const pagination = paginateMeasured(
			[spineItem],
			[[{ height: 700, marginBottom: 16, lines: 20 }]],
			712,
		);
		const first = pagination.pages[0]?.range.end.charOffset ?? 0;
		// (712 - 16) / 35 = 19 lines fit, one is headroom => 18 lines of 10 chars.
		expect(first).toBe(180);
	});

	it("never spans spine items — a chapter always starts a new page", () => {
		const spine = [indexSpineItem(item(para("aa"))), indexSpineItem(item(para("bb")))];
		const pagination = paginateMeasured(spine, [metrics([20]), metrics([20])], PAGE);
		expect(pagination.pages).toHaveLength(2);
		expect(pagination.pages[0]?.range.start.spineIndex).toBe(0);
		expect(pagination.pages[1]?.range.start.spineIndex).toBe(1);
		for (const page of pagination.pages) {
			expect(page.range.start.spineIndex).toBe(page.range.end.spineIndex);
		}
	});

	it("keeps an empty spine item reachable as one empty page", () => {
		const pagination = paginateMeasured([indexSpineItem(item())], [[]], PAGE);
		expect(pagination.pages).toHaveLength(1);
		expect(pagination.pages[0]?.range).toEqual({
			start: { spineIndex: 0, charOffset: 0 },
			end: { spineIndex: 0, charOffset: 0 },
		});
	});

	it("reports total characters across the book", () => {
		const spine = [indexSpineItem(item(para("abc"))), indexSpineItem(item(para("de")))];
		expect(paginateMeasured(spine, [metrics([20]), metrics([20])], PAGE).totalChars).toBe(5);
	});

	it("falls back to zero-height for a block it has no metrics for", () => {
		const spineItem = indexSpineItem(item(para("aa"), para("bb")));
		const pagination = paginateMeasured([spineItem], [[]], PAGE);
		expect(pagination.pages).toHaveLength(1);
	});

	it("still makes progress when the page height is degenerate", () => {
		const spineItem = indexSpineItem(item(para("aa"), para("bb")));
		const pagination = paginateMeasured([spineItem], [metrics([50, 50])], 0);
		expect(pagination.pages.length).toBeGreaterThan(0);
		expect(pagination.pages.at(-1)?.range.end.charOffset).toBe(4);
	});
});
