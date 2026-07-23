// @vitest-environment jsdom
/**
 * The snap grid must surface only while an icon is actually being dragged —
 * a plain click (press → release below the movement slop) must never flash it.
 * Regression guard: `draggingId` used to be set on pointerdown, so every click
 * briefly painted the grid hairlines.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardIcon } from "../../preload";
import { DashboardIconsLayer } from "./icons-layer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function appIcon(target: string, x: number, y: number): DashboardIcon {
	return { kind: "app", target, label: target.toUpperCase(), x, y } as unknown as DashboardIcon;
}
const ICONS: Record<string, DashboardIcon> = {
	chat: appIcon("chat", 0, 0),
	mail: appIcon("mail", 8, 0),
};

function pointer(type: string, init: PointerEventInit): Event {
	// jsdom lacks a full PointerEvent constructor in some versions; a MouseEvent
	// carries every field React's synthetic pointer handlers read here.
	const ev = new MouseEvent(type, { bubbles: true, ...init });
	Object.assign(ev, { pointerId: init.pointerId ?? 1 });
	return ev;
}

describe("DashboardIconsLayer — drag reveals the snap grid, a click does not", () => {
	let host: HTMLDivElement;
	let root: Root;
	let onMoveIcon: ReturnType<typeof vi.fn<(id: string, x: number, y: number) => void>>;

	beforeEach(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
		// setPointerCapture/releasePointerCapture aren't implemented in jsdom.
		Element.prototype.setPointerCapture = () => undefined;
		Element.prototype.releasePointerCapture = () => undefined;
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

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(
				<DashboardIconsLayer
					icons={ICONS}
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

	const surface = () => host.querySelector<HTMLElement>(".dashboard-icons");
	const btn = (id: string) =>
		host.querySelector<HTMLElement>(`[data-testid="dashboard-icon-${id}"]`);

	it("keeps the grid hidden through a press-and-release click", async () => {
		await mount();
		const target = btn("chat");
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);

		act(() => target?.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 40, clientY: 40 })));
		// Still just a press — no grid.
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);

		act(() =>
			target?.dispatchEvent(pointer("pointerup", { button: 0, clientX: 42, clientY: 41, buttons: 0 })),
		);
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);
		expect(onMoveIcon).not.toHaveBeenCalled();
	});

	it("reveals the grid once movement crosses the slop, and commits on release", async () => {
		await mount();
		const target = btn("chat");

		act(() => target?.dispatchEvent(pointer("pointerdown", { button: 0, clientX: 40, clientY: 40 })));
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);

		// Under the slop — still hidden.
		act(() =>
			target?.dispatchEvent(pointer("pointermove", { clientX: 43, clientY: 42, buttons: 1 })),
		);
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);

		// Past the 5px slop — grid appears.
		act(() =>
			target?.dispatchEvent(pointer("pointermove", { clientX: 120, clientY: 90, buttons: 1 })),
		);
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(true);

		act(() =>
			target?.dispatchEvent(
				pointer("pointerup", { button: 0, clientX: 120, clientY: 90, buttons: 0 }),
			),
		);
		expect(surface()?.classList.contains("dashboard-icons--dragging")).toBe(false);
		expect(onMoveIcon).toHaveBeenCalledTimes(1);
	});
});
