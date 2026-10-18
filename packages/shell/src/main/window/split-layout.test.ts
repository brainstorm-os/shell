import { describe, expect, it } from "vitest";
import {
	SPLIT_DEFAULT_RATIO,
	SPLIT_DIVIDER_PX,
	SPLIT_KEYBOARD_STEP,
	SPLIT_MIN_PANE_PX,
	SplitStep,
	clampSplitRatio,
	ratioFromDividerX,
	splitRects,
	stepSplitRatio,
} from "./split-layout";

const WIDE = 1206;
const body = { x: 0, y: 44, width: WIDE, height: 700 };

describe("clampSplitRatio", () => {
	it("passes a legal ratio through", () => {
		expect(clampSplitRatio(0.4, WIDE)).toBe(0.4);
	});

	it("keeps both panes at the minimum width", () => {
		const usable = WIDE - SPLIT_DIVIDER_PX;
		expect(clampSplitRatio(0, WIDE)).toBeCloseTo(SPLIT_MIN_PANE_PX / usable);
		expect(clampSplitRatio(1, WIDE)).toBeCloseTo(1 - SPLIT_MIN_PANE_PX / usable);
	});

	it("splits evenly when the window can't fit two minimum panes", () => {
		expect(clampSplitRatio(0.9, SPLIT_MIN_PANE_PX * 2)).toBe(SPLIT_DEFAULT_RATIO);
		expect(clampSplitRatio(0.1, 0)).toBe(SPLIT_DEFAULT_RATIO);
	});

	it("turns non-finite input into the default instead of NaN geometry", () => {
		expect(clampSplitRatio(Number.NaN, WIDE)).toBe(SPLIT_DEFAULT_RATIO);
		expect(clampSplitRatio(Number.POSITIVE_INFINITY, WIDE)).toBe(SPLIT_DEFAULT_RATIO);
	});
});

describe("stepSplitRatio", () => {
	it("moves the divider one keyboard step either way", () => {
		expect(stepSplitRatio(0.5, SplitStep.Left, WIDE)).toBeCloseTo(0.5 - SPLIT_KEYBOARD_STEP);
		expect(stepSplitRatio(0.5, SplitStep.Right, WIDE)).toBeCloseTo(0.5 + SPLIT_KEYBOARD_STEP);
	});

	it("stops at the minimum pane width", () => {
		let ratio = 0.5;
		for (let i = 0; i < 50; i++) ratio = stepSplitRatio(ratio, SplitStep.Left, WIDE);
		expect(ratio).toBeCloseTo(clampSplitRatio(0, WIDE));
	});
});

describe("splitRects", () => {
	it("lays two panes and the divider edge to edge across the body", () => {
		const r = splitRects(body, 0.5);
		expect(r.left).toEqual({ x: 0, y: 44, width: 600, height: 700 });
		expect(r.divider).toEqual({ x: 600, y: 44, width: SPLIT_DIVIDER_PX, height: 700 });
		expect(r.right).toEqual({ x: 606, y: 44, width: 600, height: 700 });
		expect(r.left.width + r.divider.width + r.right.width).toBe(WIDE);
	});

	it("clamps an illegal ratio before laying out", () => {
		const r = splitRects(body, 0.01);
		expect(r.left.width).toBe(SPLIT_MIN_PANE_PX);
	});
});

describe("ratioFromDividerX", () => {
	it("is the inverse of the divider position", () => {
		const r = splitRects(body, 0.3);
		const centre = r.divider.x + SPLIT_DIVIDER_PX / 2;
		expect(ratioFromDividerX(centre, body)).toBeCloseTo(0.3, 2);
	});

	it("honours a body that doesn't start at x=0", () => {
		const offset = { ...body, x: 100 };
		expect(ratioFromDividerX(100 + SPLIT_DIVIDER_PX / 2 + 600, offset)).toBeCloseTo(0.5, 5);
	});

	it("clamps a drag past either edge", () => {
		expect(ratioFromDividerX(-500, body)).toBeCloseTo(clampSplitRatio(0, WIDE));
		expect(ratioFromDividerX(5000, body)).toBeCloseTo(clampSplitRatio(1, WIDE));
	});
});
