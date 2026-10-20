import { describe, expect, it } from "vitest";
import { SplitStep, clampSplitRatio } from "./split-layout";
import {
	INITIAL_SPLIT_STATE,
	SplitEventKind,
	SplitOrder,
	SplitPane,
	type SplitState,
	leftRatioOf,
	reduceSplit,
} from "./split-state";

const WIDTH = 1206;
const open = (): SplitState => reduceSplit(INITIAL_SPLIT_STATE, { kind: SplitEventKind.OpenSide });

describe("reduceSplit", () => {
	it("opening the side pane splits with the side on the right, focused", () => {
		expect(open()).toEqual({
			open: true,
			order: SplitOrder.PrimaryFirst,
			focused: SplitPane.Side,
			primaryRatio: 0.5,
		});
	});

	it("closing the side pane returns to a single, primary-focused view", () => {
		const closed = reduceSplit(open(), { kind: SplitEventKind.CloseSide });
		expect(closed.open).toBe(false);
		expect(closed.focused).toBe(SplitPane.Primary);
	});

	it("promoting the side pane (primary emptied) also leaves a single view", () => {
		const s = reduceSplit(open(), { kind: SplitEventKind.PromoteSide });
		expect(s.open).toBe(false);
		expect(s.focused).toBe(SplitPane.Primary);
	});

	it("remembers the width for the next split in the same window", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.SetLeftRatio, leftRatio: 0.3, width: WIDTH });
		s = reduceSplit(s, { kind: SplitEventKind.CloseSide });
		s = reduceSplit(s, { kind: SplitEventKind.OpenSide });
		expect(leftRatioOf(s)).toBeCloseTo(0.3);
	});

	it("swap moves the panes without resizing them", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.SetLeftRatio, leftRatio: 0.3, width: WIDTH });
		s = reduceSplit(s, { kind: SplitEventKind.Swap });
		expect(s.order).toBe(SplitOrder.SideFirst);
		expect(s.primaryRatio).toBeCloseTo(0.3);
		expect(leftRatioOf(s)).toBeCloseTo(0.7);
		s = reduceSplit(s, { kind: SplitEventKind.Swap });
		expect(s.order).toBe(SplitOrder.PrimaryFirst);
	});

	it("a divider drag after a swap still resizes the pane under the pointer", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.Swap });
		s = reduceSplit(s, { kind: SplitEventKind.SetLeftRatio, leftRatio: 0.4, width: WIDTH });
		expect(leftRatioOf(s)).toBeCloseTo(0.4);
		expect(s.primaryRatio).toBeCloseTo(0.6);
	});

	it("keyboard step moves the divider and clamps at the minimum", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.Step, step: SplitStep.Right, width: WIDTH });
		expect(leftRatioOf(s)).toBeCloseTo(0.55);
		for (let i = 0; i < 40; i++) {
			s = reduceSplit(s, { kind: SplitEventKind.Step, step: SplitStep.Right, width: WIDTH });
		}
		expect(leftRatioOf(s)).toBeCloseTo(clampSplitRatio(1, WIDTH));
	});

	it("focus-other toggles between the panes", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.FocusOther });
		expect(s.focused).toBe(SplitPane.Primary);
		s = reduceSplit(s, { kind: SplitEventKind.FocusOther });
		expect(s.focused).toBe(SplitPane.Side);
	});

	it("focus records the clicked pane", () => {
		const s = reduceSplit(open(), { kind: SplitEventKind.Focus, pane: SplitPane.Primary });
		expect(s.focused).toBe(SplitPane.Primary);
	});

	it("is inert while not split, returning the same state object", () => {
		const s = INITIAL_SPLIT_STATE;
		expect(reduceSplit(s, { kind: SplitEventKind.Swap })).toBe(s);
		expect(reduceSplit(s, { kind: SplitEventKind.FocusOther })).toBe(s);
		expect(reduceSplit(s, { kind: SplitEventKind.CloseSide })).toBe(s);
		expect(reduceSplit(s, { kind: SplitEventKind.Focus, pane: SplitPane.Side })).toBe(s);
		expect(reduceSplit(s, { kind: SplitEventKind.Step, step: SplitStep.Left, width: WIDTH })).toBe(s);
		expect(reduceSplit(s, { kind: SplitEventKind.SetLeftRatio, leftRatio: 0.2, width: WIDTH })).toBe(
			s,
		);
	});

	it("re-opening after a swap opens the side on the right again", () => {
		let s = reduceSplit(open(), { kind: SplitEventKind.Swap });
		s = reduceSplit(s, { kind: SplitEventKind.CloseSide });
		s = reduceSplit(s, { kind: SplitEventKind.OpenSide });
		expect(s.order).toBe(SplitOrder.PrimaryFirst);
	});
});
