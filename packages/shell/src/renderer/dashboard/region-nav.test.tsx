// @vitest-environment jsdom
/**
 * KBN-S-dashboard — F6 region-navigation contract.
 *
 * The dashboard wires the icon grid + the bottom window-strip/tray as two
 * `useRegionNavigation` regions (`RegionId.DashboardGrid` → `RegionId.SystemTray`)
 * so F6 / Shift+F6 jump focus between them. The full `<Dashboard>` is
 * impractical to render in jsdom (32 `window.brainstorm` call sites + lazy
 * surfaces), so — as with the spatial grid's isolated `IconsLayer` coverage —
 * this pins the exact region contract the dashboard relies on against the real
 * `useRegionNavigation` hook; the live surface is exercised on perf-CI.
 */

import { RegionId, useRegionNavigation } from "@brainstorm-os/sdk/a11y";
import { act, useMemo, useRef, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Mirrors the dashboard's region wiring (dashboard.tsx): two focusable regions
 *  in grid → tray order, cycled by F6. */
function DashboardRegionsHarness() {
	const gridRef = useRef<HTMLElement | null>(null);
	const trayRef = useRef<HTMLElement | null>(null);
	const [active, setActive] = useState<string>(RegionId.DashboardGrid);
	const regions = useMemo(
		() => [
			{ id: RegionId.DashboardGrid, label: "Dashboard icons", ref: gridRef },
			{ id: RegionId.SystemTray, label: "Window strip and status tray", ref: trayRef },
		],
		[],
	);
	useRegionNavigation({ regions, activeRegionId: active, onActiveRegionIdChange: setActive });
	return (
		<>
			<section ref={gridRef as React.RefObject<HTMLElement>} tabIndex={-1} data-region="grid" />
			<footer ref={trayRef as React.RefObject<HTMLElement>} tabIndex={-1} data-region="tray" />
		</>
	);
}

describe("dashboard F6 region navigation", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => root.render(<DashboardRegionsHarness />));
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	const pressF6 = (shift = false) => {
		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "F6", shiftKey: shift, bubbles: true, cancelable: true }),
			);
		});
	};
	const region = () => (document.activeElement as HTMLElement | null)?.dataset.region;

	it("F6 advances grid → tray → grid (wraps)", () => {
		pressF6();
		expect(region()).toBe("tray");
		pressF6();
		expect(region()).toBe("grid");
	});

	it("Shift+F6 steps backwards (grid → tray)", () => {
		pressF6(true);
		expect(region()).toBe("tray");
	});
});
