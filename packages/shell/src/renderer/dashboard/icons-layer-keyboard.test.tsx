// @vitest-environment jsdom
/**
 * KBN-S-dashboard — the dashboard icon grid's spatial keyboard contract. A
 * `group` of native icon buttons navigated by macOS-Desktop-style spatial
 * arrows (`Orientation.Spatial` over each icon's `{col,row}` cell): one Tab stop
 * into the grid, arrows move the roving cursor to the nearest icon in that
 * direction, Enter activates. Pure geometry is covered by `spatial-grid.test.ts`.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardIcon } from "../../preload";
import { DashboardIconsLayer } from "./icons-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}

// Insertion order = composite index order. 2×2 block:
//   a(0,0) b(1,0)
//   c(0,1) d(1,1)
function icon(target: string, x: number, y: number): DashboardIcon {
	return { kind: "app", target, label: target.toUpperCase(), x, y } as unknown as DashboardIcon;
}
const ICONS: Record<string, DashboardIcon> = {
	a: icon("a", 0, 0),
	b: icon("b", 1, 0),
	c: icon("c", 0, 1),
	d: icon("d", 1, 1),
};

describe("DashboardIconsLayer — KBN-S-dashboard spatial keyboard", () => {
	let host: HTMLDivElement;
	let root: Root;
	let onActivate: Mock<(id: string, icon: DashboardIcon) => void>;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				listRunning: () => Promise.resolve([]),
				onRunningChanged: () => () => undefined,
				onBadgesChanged: () => () => undefined,
				listInstalled: () => Promise.resolve([]),
				iconUrl: (id: string) => `brainstorm://app-icon/${id}`,
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		onActivate = vi.fn<(id: string, icon: DashboardIcon) => void>();
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(
				<DashboardIconsLayer
					icons={ICONS}
					pins={{}}
					onMoveIcon={() => undefined}
					onActivate={onActivate}
					gridMigrated={true}
					onGridMigrated={() => undefined}
				/>,
			);
		});
		await act(async () => undefined);
	}

	const grid = () => host.querySelector<HTMLElement>(".dashboard-icons");
	const tileAt = (index: number) =>
		host.querySelector<HTMLElement>(`.dashboard-icons [data-composite-index="${index}"]`);
	const press = (key: string) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		act(() => {
			grid()?.dispatchEvent(ev);
		});
		return ev;
	};

	it("is a labelled group of native icon buttons with a single Tab stop (roving cursor)", async () => {
		await mount();
		expect(grid()?.getAttribute("role")).toBe("group");
		expect(grid()?.tabIndex).toBe(0);
		expect(grid()?.hasAttribute("aria-label")).toBe(true);
		// Native buttons: no item role, no selection-state attribute.
		expect(tileAt(0)?.hasAttribute("role")).toBe(false);
		expect(tileAt(0)?.hasAttribute("aria-selected")).toBe(false);
		// Cursor at index 0; only it is in the Tab order.
		expect(tileAt(0)?.tabIndex).toBe(0);
		expect(tileAt(1)?.tabIndex).toBe(-1);
		expect(tileAt(3)?.tabIndex).toBe(-1);
	});

	it("arrow keys move the cursor to the spatial nearest icon", async () => {
		await mount();
		// a(0,0) → Right → b(1,0) [index 1].
		press("ArrowRight");
		expect(tileAt(1)?.tabIndex).toBe(0);
		// b(1,0) → Down → d(1,1) [index 3].
		press("ArrowDown");
		expect(tileAt(3)?.tabIndex).toBe(0);
		// d(1,1) → Down → no icon below, cursor sits.
		press("ArrowDown");
		expect(tileAt(3)?.tabIndex).toBe(0);
		// d(1,1) → Left → c(0,1) [index 2].
		press("ArrowLeft");
		expect(tileAt(2)?.tabIndex).toBe(0);
	});

	it("Enter activates the cursor's icon", async () => {
		await mount();
		press("ArrowRight"); // cursor → b
		press("Enter");
		expect(onActivate).toHaveBeenCalledWith("b", ICONS.b);
	});
});
