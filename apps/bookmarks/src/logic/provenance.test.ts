import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	LARGE_PAGE_BLOCK_THRESHOLD,
	LARGE_PAGE_CHAR_THRESHOLD,
	countBlocks,
	estimateTextLength,
	isLargeCapture,
} from "./provenance";

function para(text: string): SerializedBlock {
	return { type: "paragraph", version: 1, children: [{ type: "text", version: 1, text }] };
}

describe("countBlocks", () => {
	it("counts nested children", () => {
		// 2 paragraphs, each with 1 text child → 4 nodes.
		expect(countBlocks([para("a"), para("b")])).toBe(4);
	});
	it("is 0 for empty / undefined", () => {
		expect(countBlocks([])).toBe(0);
		expect(countBlocks(undefined)).toBe(0);
	});
});

describe("estimateTextLength", () => {
	it("sums leaf text across the tree", () => {
		expect(estimateTextLength([para("hello"), para("world!")])).toBe(11);
	});
	it("is 0 with no text nodes", () => {
		expect(estimateTextLength([{ type: "horizontalrule", version: 1 }])).toBe(0);
		expect(estimateTextLength(undefined)).toBe(0);
	});
});

describe("isLargeCapture", () => {
	it("is false for empty / small bodies", () => {
		expect(isLargeCapture(undefined)).toBe(false);
		expect(isLargeCapture([])).toBe(false);
		expect(isLargeCapture([para("short article")])).toBe(false);
	});

	it("trips on the block-count threshold", () => {
		const many = Array.from({ length: LARGE_PAGE_BLOCK_THRESHOLD + 1 }, () => ({
			type: "horizontalrule" as const,
			version: 1,
		}));
		expect(countBlocks(many)).toBeGreaterThan(LARGE_PAGE_BLOCK_THRESHOLD);
		expect(isLargeCapture(many)).toBe(true);
	});

	it("trips on the character threshold even with few blocks", () => {
		const huge = [para("x".repeat(LARGE_PAGE_CHAR_THRESHOLD + 1))];
		expect(countBlocks(huge)).toBeLessThan(LARGE_PAGE_BLOCK_THRESHOLD);
		expect(isLargeCapture(huge)).toBe(true);
	});
});
