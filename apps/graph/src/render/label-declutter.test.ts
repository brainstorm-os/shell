import { describe, expect, it } from "vitest";
import {
	LABEL_CHIP_EXTRA_X_PX,
	LABEL_MAX_WIDTH_PX,
	type LabelBox,
	declutterLabels,
	estimateLabelWidth,
	labelBoxHeight,
} from "./label-declutter";

function box(id: string, centerX: number, top: number, priority: number, width = 40): LabelBox {
	return { id, centerX, top, width, height: 12, priority };
}

describe("declutterLabels (F-230 overlap suppression)", () => {
	it("keeps all labels when none overlap", () => {
		const kept = declutterLabels([box("a", 0, 0, 1), box("b", 200, 0, 1), box("c", 0, 200, 1)]);
		expect(kept).toEqual(new Set(["a", "b", "c"]));
	});

	it("drops the lower-priority label when two overlap", () => {
		// Same centre → boxes overlap; b has the higher priority and wins.
		const kept = declutterLabels([box("a", 100, 100, 1), box("b", 100, 100, 5)]);
		expect(kept).toEqual(new Set(["b"]));
	});

	it("resolves a dense cluster down to the non-overlapping survivors", () => {
		// Four hub labels stacked on the same spot (the reported smear) collapse
		// to the single highest-priority one.
		const kept = declutterLabels([
			box("operating-hub", 300, 300, 4),
			box("content-calendar", 305, 302, 3),
			box("candidates", 302, 301, 2),
			box("priya", 304, 303, 1),
		]);
		expect(kept).toEqual(new Set(["operating-hub"]));
	});

	it("breaks priority ties by input order (stable)", () => {
		const kept = declutterLabels([box("first", 50, 50, 2), box("second", 52, 51, 2)]);
		expect(kept).toEqual(new Set(["first"]));
	});

	it("returns an empty set for no candidates", () => {
		expect(declutterLabels([])).toEqual(new Set());
	});
});

describe("estimateLabelWidth", () => {
	it("scales with character count", () => {
		expect(estimateLabelWidth("abc")).toBeGreaterThan(0);
		expect(estimateLabelWidth("abcdef")).toBeGreaterThan(estimateLabelWidth("abc"));
	});

	// The label is a chip (padding + 1px border) since POLISH-DSN-13, so its
	// screen footprint is wider than its glyph run. Measuring the glyphs alone
	// lets two chips overlap by the padding on both sides and the de-clutter
	// pass never sees it.
	it("counts the chip's padding + border, not just the glyphs", () => {
		expect(estimateLabelWidth("")).toBe(LABEL_CHIP_EXTRA_X_PX);
		expect(estimateLabelWidth("abc")).toBeGreaterThan(3 * 5.6);
	});

	// `.graph-canvas__label` clamps at `max-width: 180px` with border-box
	// sizing, so a 48-glyph name renders 180px wide — not the ~278px the raw
	// glyph estimate claims. An over-wide box drops neighbours that never
	// actually collided.
	it("clamps at the CSS max-width the chip renders at", () => {
		expect(estimateLabelWidth("x".repeat(48))).toBe(LABEL_MAX_WIDTH_PX);
	});
});

describe("labelBoxHeight", () => {
	it("adds the chip's vertical padding + border to the line box", () => {
		expect(labelBoxHeight(13)).toBeGreaterThan(13);
	});
});
