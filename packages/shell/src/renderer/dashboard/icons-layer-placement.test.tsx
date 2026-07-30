// @vitest-environment jsdom
/**
 * POLISH-LAY-9 — the renderer owns icon placement.
 *
 * Main installs/pins an icon with NO position (`UNPLACED_ICON_POSITION`)
 * because the install slot has to wrap at a column bound derived from the icon
 * surface's width, which only this layer can see. These tests pin the two
 * halves of that contract: an unplaced icon is painted in a free ON-SCREEN slot
 * and persisted, and a fleet wider than the viewport wraps to the next row
 * instead of running off an edge that cannot be scrolled to.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardIcon } from "../../preload";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_BUTTON_W,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	UNPLACED_ICON_POSITION,
} from "../../shared/dashboard-icon-grid";
import { DashboardIconsLayer } from "./icons-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The stage the POLISH-LAY-9 capture was taken on. */
const STAGE_W = 1440;
const STAGE_H = 900;

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function appIcon(target: string, x: number, y: number): DashboardIcon {
	return { kind: "app", target, label: target.toUpperCase(), x, y } as unknown as DashboardIcon;
}

function unplacedIcon(target: string): DashboardIcon {
	return appIcon(target, UNPLACED_ICON_POSITION.x, UNPLACED_ICON_POSITION.y);
}

/** Right edge, in surface pixels, of an icon painted at column `col`. */
function boxRight(col: number): number {
	return GRID_OUTER_MARGIN + col * GRID_UNIT + ICON_BUTTON_W;
}

describe("DashboardIconsLayer — renderer-owned placement", () => {
	let host: HTMLDivElement;
	let root: Root;
	let onMoveIcon: ReturnType<typeof vi.fn<(id: string, x: number, y: number) => void>>;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		Element.prototype.getBoundingClientRect = () =>
			({ width: STAGE_W, height: STAGE_H, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				listRunning: () => Promise.resolve([]),
				onRunningChanged: () => () => undefined,
				onBadgesChanged: () => () => undefined,
				listInstalled: () => Promise.resolve([]),
				iconUrl: (id: string) => `brainstorm://app-icon/${id}`,
			},
		};
		onMoveIcon = vi.fn<(id: string, x: number, y: number) => void>();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	async function mount(icons: Record<string, DashboardIcon>): Promise<void> {
		await act(async () => {
			root.render(
				<DashboardIconsLayer
					icons={icons}
					pins={{}}
					onMoveIcon={onMoveIcon}
					onActivate={() => undefined}
					gridMigrated={true}
					onGridMigrated={() => undefined}
				/>,
			);
		});
		await act(async () => undefined);
	}

	/** The column the layer actually painted this icon at (`--icon-col`). */
	function paintedCol(id: string): number {
		const el = host.querySelector<HTMLElement>(`[data-testid="dashboard-icon-${id}"]`);
		if (!el) throw new Error(`no icon ${id}`);
		return Number(el.style.getPropertyValue("--icon-col"));
	}

	function paintedRow(id: string): number {
		const el = host.querySelector<HTMLElement>(`[data-testid="dashboard-icon-${id}"]`);
		if (!el) throw new Error(`no icon ${id}`);
		return Number(el.style.getPropertyValue("--icon-row"));
	}

	it("places an icon that arrived without a position, on-screen, and persists it", async () => {
		await mount({ notes: appIcon("notes", 0, 0), newcomer: unplacedIcon("newcomer") });

		// Painted immediately — the install reveal doesn't wait for the store to
		// round-trip, and never flashes at the sentinel's negative cell.
		expect(paintedCol("newcomer")).toBe(ICON_FOOTPRINT_W);
		expect(paintedRow("newcomer")).toBe(0);
		expect(boxRight(paintedCol("newcomer"))).toBeLessThanOrEqual(STAGE_W);
		expect(onMoveIcon).toHaveBeenCalledWith("newcomer", ICON_FOOTPRINT_W, 0);
	});

	it("does not re-issue the write while the store round-trips", async () => {
		const icons = { notes: appIcon("notes", 0, 0), newcomer: unplacedIcon("newcomer") };
		await mount(icons);
		expect(onMoveIcon).toHaveBeenCalledTimes(1);
		// Same snapshot again (the store hasn't echoed the move back yet).
		await mount({ ...icons });
		expect(onMoveIcon).toHaveBeenCalledTimes(1);
		// And once it does echo back, the icon is simply placed — no further write.
		await mount({ notes: appIcon("notes", 0, 0), newcomer: appIcon("newcomer", 11, 0) });
		expect(onMoveIcon).toHaveBeenCalledTimes(1);
	});

	it("wraps a fleet wider than the viewport onto the next row instead of off the edge", async () => {
		// The captured fleet: 20 seeded apps written by main's unbounded placer at
		// 0,0 · 11,0 … 209,0, plus the newly installed app that used to land at
		// 220,0 = 1760px on this 1440px stage.
		const icons: Record<string, DashboardIcon> = {};
		for (let i = 0; i < 20; i++) icons[`app${i}`] = appIcon(`app${i}`, i * ICON_FOOTPRINT_W, 0);
		icons.newcomer = unplacedIcon("newcomer");

		await mount(icons);

		for (const id of Object.keys(icons)) {
			expect(boxRight(paintedCol(id))).toBeLessThanOrEqual(STAGE_W);
		}
		// The newcomer and the four apps already past the fold sit on row 2 —
		// the newcomer after them, since it is placed clear of every icon the
		// layer just put there.
		expect(paintedRow("newcomer")).toBe(ICON_FOOTPRINT_H);
		expect(paintedCol("newcomer")).toBe(4 * ICON_FOOTPRINT_W);
		for (const [i, id] of ["app16", "app17", "app18", "app19"].entries()) {
			expect(paintedRow(id)).toBe(ICON_FOOTPRINT_H);
			expect(paintedCol(id)).toBe(i * ICON_FOOTPRINT_W);
		}
		// Rescuing an off-screen icon is a view-model decision only — the user's
		// stored arrangement is theirs, and widening the window must restore it.
		// Only the icon that genuinely had no position is written back, and the
		// cell it gets can't collide with a rescued icon's STORED cell either
		// (that one is past `maxIconCol`, this one is inside the column bound).
		expect(onMoveIcon.mock.calls).toEqual([["newcomer", 4 * ICON_FOOTPRINT_W, ICON_FOOTPRINT_H]]);
	});

	it("stacks into a single column on a viewport too narrow for two icons", async () => {
		Element.prototype.getBoundingClientRect = () =>
			({ width: 140, height: STAGE_H, x: 0, y: 0, top: 0, left: 0 }) as DOMRect;
		await mount({ a: unplacedIcon("a"), b: unplacedIcon("b") });

		expect(paintedCol("a")).toBe(0);
		expect(paintedRow("a")).toBe(0);
		expect(paintedCol("b")).toBe(0);
		expect(paintedRow("b")).toBe(ICON_FOOTPRINT_H);
	});
});
