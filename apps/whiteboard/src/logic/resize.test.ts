import { describe, expect, it } from "vitest";
import { NodeKind } from "../types/node";
import {
	CORNER_HANDLES,
	RESIZE_HANDLES,
	type ResizeBounds,
	ResizeHandle,
	computeResizeSnap,
	isResizableKind,
	minSizeFor,
	movesBottom,
	movesLeft,
	movesRight,
	movesTop,
	resizeBounds,
} from "./resize";
import type { SnapRect } from "./snap";
import { SnapAxis } from "./snap";

const START: ResizeBounds = { x: 50, y: 40, width: 100, height: 80 };
const FREE = { minWidth: 10, minHeight: 10, lockAspect: false };

const right = (b: ResizeBounds) => b.x + b.width;
const bottom = (b: ResizeBounds) => b.y + b.height;

describe("resizeBounds — anchoring per handle", () => {
	it("SE grows both axes, top-left anchored", () => {
		const b = resizeBounds(START, ResizeHandle.SouthEast, 20, 10, FREE);
		expect(b).toEqual({ x: 50, y: 40, width: 120, height: 90 });
	});

	it("NW moves both near edges, bottom-right anchored", () => {
		const b = resizeBounds(START, ResizeHandle.NorthWest, 20, 10, FREE);
		expect(b).toEqual({ x: 70, y: 50, width: 80, height: 70 });
		expect(right(b)).toBe(right(START));
		expect(bottom(b)).toBe(bottom(START));
	});

	it("NE anchors bottom-left", () => {
		const b = resizeBounds(START, ResizeHandle.NorthEast, 20, -10, FREE);
		expect(b).toEqual({ x: 50, y: 30, width: 120, height: 90 });
		expect(b.x).toBe(START.x);
		expect(bottom(b)).toBe(bottom(START));
	});

	it("SW anchors top-right", () => {
		const b = resizeBounds(START, ResizeHandle.SouthWest, -20, 10, FREE);
		expect(b).toEqual({ x: 30, y: 40, width: 120, height: 90 });
		expect(right(b)).toBe(right(START));
		expect(b.y).toBe(START.y);
	});

	it("edge handles move exactly one axis", () => {
		expect(resizeBounds(START, ResizeHandle.East, 25, 99, FREE)).toEqual({ ...START, width: 125 });
		expect(resizeBounds(START, ResizeHandle.South, 99, 25, FREE)).toEqual({ ...START, height: 105 });
		const w = resizeBounds(START, ResizeHandle.West, -25, 99, FREE);
		expect(w).toEqual({ x: 25, y: 40, width: 125, height: 80 });
		const n = resizeBounds(START, ResizeHandle.North, 99, -25, FREE);
		expect(n).toEqual({ x: 50, y: 15, width: 100, height: 105 });
	});
});

describe("resizeBounds — minimum clamp, no inversion", () => {
	it("clamps a far-edge collapse at the minimum (anchor untouched)", () => {
		const b = resizeBounds(START, ResizeHandle.SouthEast, -1000, -1000, FREE);
		expect(b).toEqual({ x: 50, y: 40, width: 10, height: 10 });
	});

	it("clamps a near-edge collapse at the minimum (far edges untouched)", () => {
		const b = resizeBounds(START, ResizeHandle.NorthWest, 1000, 1000, FREE);
		expect(b.width).toBe(10);
		expect(b.height).toBe(10);
		expect(right(b)).toBe(right(START));
		expect(bottom(b)).toBe(bottom(START));
	});

	it("never inverts nor undercuts min, and never moves the anchor (generative)", () => {
		// Deterministic LCG — the suite must not flake.
		let seed = 0x2f6e2b1;
		const rnd = (): number => {
			seed = (seed * 48271) % 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

		for (let i = 0; i < 500; i++) {
			const start: ResizeBounds = {
				x: int(-400, 400),
				y: int(-400, 400),
				width: int(10, 500),
				height: int(10, 500),
			};
			const handle = RESIZE_HANDLES[int(0, RESIZE_HANDLES.length - 1)] as ResizeHandle;
			const dx = int(-600, 600);
			const dy = int(-600, 600);
			const b = resizeBounds(start, handle, dx, dy, FREE);

			expect(b.width).toBeGreaterThanOrEqual(FREE.minWidth);
			expect(b.height).toBeGreaterThanOrEqual(FREE.minHeight);
			// The anchored edges never move.
			if (!movesLeft(handle)) expect(b.x).toBe(start.x);
			if (!movesRight(handle)) expect(right(b)).toBe(right(start));
			if (!movesTop(handle)) expect(b.y).toBe(start.y);
			if (!movesBottom(handle)) expect(bottom(b)).toBe(bottom(start));
		}
	});
});

describe("resizeBounds — aspect lock", () => {
	const LOCKED = { minWidth: 10, minHeight: 10, lockAspect: true };

	it("a corner drag preserves the start ratio, anchored on the opposite corner", () => {
		const b = resizeBounds(START, ResizeHandle.SouthEast, 40, 0, LOCKED);
		expect(b.width / b.height).toBeCloseTo(START.width / START.height, 10);
		expect(b.x).toBe(START.x);
		expect(b.y).toBe(START.y);
		// The dominant axis (x, +40) drives the scale.
		expect(b.width).toBeCloseTo(140, 10);
		expect(b.height).toBeCloseTo(112, 10);
	});

	it("NW keeps the bottom-right corner pinned under lock", () => {
		const b = resizeBounds(START, ResizeHandle.NorthWest, -50, 0, LOCKED);
		expect(b.width / b.height).toBeCloseTo(START.width / START.height, 10);
		expect(right(b)).toBeCloseTo(right(START), 10);
		expect(bottom(b)).toBeCloseTo(bottom(START), 10);
	});

	it("an edge drag under lock scales the cross axis about its centre, anchor edge fixed", () => {
		const b = resizeBounds(START, ResizeHandle.East, 100, 0, LOCKED);
		expect(b.width / b.height).toBeCloseTo(START.width / START.height, 10);
		expect(b.x).toBe(START.x);
		// Cross-axis centre preserved.
		expect(b.y + b.height / 2).toBeCloseTo(START.y + START.height / 2, 10);
	});

	it("the min re-floors the scale so BOTH dimensions stay legal and in ratio", () => {
		const c = { minWidth: 40, minHeight: 40, lockAspect: true };
		const b = resizeBounds(START, ResizeHandle.SouthEast, -1000, -1000, c);
		expect(b.width).toBeGreaterThanOrEqual(c.minWidth);
		expect(b.height).toBeGreaterThanOrEqual(c.minHeight);
		expect(b.width / b.height).toBeCloseTo(START.width / START.height, 10);
	});
});

describe("computeResizeSnap — the moving edge magnetises, the anchor never does", () => {
	const NEIGHBOUR: SnapRect = { x: 240, y: 0, width: 180, height: 180 };
	const MIN = { minWidth: 10, minHeight: 10 };

	it("snaps a growing right edge to the neighbour's left edge", () => {
		const raw: ResizeBounds = { x: 0, y: 0, width: 236, height: 180 };
		const { bounds, guides } = computeResizeSnap(raw, ResizeHandle.East, [NEIGHBOUR], 6, MIN);
		expect(bounds.width).toBe(240);
		expect(bounds.x).toBe(0);
		expect(guides).toHaveLength(1);
		expect(guides[0]?.axis).toBe(SnapAxis.Vertical);
		expect(guides[0]?.pos).toBe(240);
	});

	it("snaps a moving left edge by shifting x AND width (right edge anchored)", () => {
		const raw: ResizeBounds = { x: 416, y: 0, width: 100, height: 100 };
		const { bounds } = computeResizeSnap(raw, ResizeHandle.West, [NEIGHBOUR], 6, MIN);
		// Neighbour's right edge is 420.
		expect(bounds.x).toBe(420);
		expect(bounds.width).toBe(96);
		expect(bounds.x + bounds.width).toBe(516);
	});

	it("never snaps the anchored edge (E handle ignores lines near the left edge)", () => {
		const near: SnapRect = { x: 2, y: 0, width: 50, height: 50 };
		const raw: ResizeBounds = { x: 0, y: 0, width: 600, height: 100 };
		const { bounds, guides } = computeResizeSnap(raw, ResizeHandle.East, [near], 6, MIN);
		expect(bounds.x).toBe(0);
		expect(bounds.width).toBe(600);
		expect(guides).toHaveLength(0);
	});

	it("skips a snap that would undercut the minimum", () => {
		const raw: ResizeBounds = { x: 236, y: 0, width: 10, height: 10 };
		const { bounds } = computeResizeSnap(raw, ResizeHandle.West, [NEIGHBOUR], 6, MIN);
		// Snapping left edge to 240 would shrink width to 6 (< min 10).
		expect(bounds).toEqual(raw);
	});

	it("a vertical-only handle produces no horizontal-axis snap", () => {
		const raw: ResizeBounds = { x: 236, y: 100, width: 100, height: 78 };
		const { bounds, guides } = computeResizeSnap(raw, ResizeHandle.South, [NEIGHBOUR], 6, MIN);
		expect(bounds.x).toBe(236);
		expect(bounds.width).toBe(100);
		// Bottom edge 178 is within 6 of the neighbour's bottom (180).
		expect(bounds.height).toBe(80);
		expect(guides).toHaveLength(1);
		expect(guides[0]?.axis).toBe(SnapAxis.Horizontal);
	});
});

describe("kind table", () => {
	it("has a minimum for every kind, all positive", () => {
		for (const kind of Object.values(NodeKind)) {
			const m = minSizeFor(kind);
			expect(m.minWidth).toBeGreaterThan(0);
			expect(m.minHeight).toBeGreaterThan(0);
		}
	});

	it("groups are the one non-resizable kind (their box is derived)", () => {
		for (const kind of Object.values(NodeKind)) {
			expect(isResizableKind(kind)).toBe(kind !== NodeKind.Group);
		}
	});

	it("exposes the four corners as a stable subset", () => {
		for (const h of CORNER_HANDLES) expect(RESIZE_HANDLES).toContain(h);
	});
});
