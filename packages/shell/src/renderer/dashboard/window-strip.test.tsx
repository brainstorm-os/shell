// @vitest-environment jsdom
/**
 * KBN — the running-windows strip's toolbar keyboard contract. A horizontal
 * toolbar composite: ←/→ move a roving cursor across the open-window buttons
 * (one Tab stop), Enter focuses the cursor's window. Toolbar items are native
 * buttons — no item role, no selection-state attribute (the cursor is the only
 * "current item" signal; the focused-window highlight is separate OS focus).
 */

import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowStrip } from "./window-strip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Pre-sorted by appId so cursor index 0 = "w-alpha".
const ENTRIES = [
	{ id: "w-alpha", appId: "a", appName: "Alpha", windowId: "1", focused: true, state: "normal" },
	{ id: "w-bravo", appId: "b", appName: "Bravo", windowId: "1", focused: false, state: "normal" },
	{
		id: "w-charlie",
		appId: "c",
		appName: "Charlie",
		windowId: "1",
		focused: false,
		state: "normal",
	},
] as unknown as WindowEntry[];

describe("WindowStrip — KBN toolbar keyboard", () => {
	let host: HTMLDivElement;
	let root: Root;
	let onFocus: Mock<(id: string) => void>;

	const noop = () => undefined;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		onFocus = vi.fn<(id: string) => void>();
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	function mount(): void {
		act(() => {
			root.render(
				<WindowStrip
					entries={ENTRIES}
					monitors={[]}
					onFocus={onFocus}
					onClose={noop}
					onMinimize={noop}
					onTile={noop}
					onMoveToMonitor={noop}
				/>,
			);
		});
	}

	const strip = () => host.querySelector<HTMLElement>(".window-strip");
	const tiles = () => host.querySelectorAll<HTMLElement>(".window-strip__tile");
	const press = (key: string) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		act(() => {
			strip()?.dispatchEvent(ev);
		});
		return ev;
	};

	it("is a hook-stamped horizontal toolbar; items are plain buttons (no role / no selection state)", () => {
		mount();
		expect(strip()?.getAttribute("role")).toBe("toolbar");
		expect(strip()?.getAttribute("aria-orientation")).toBe("horizontal");
		expect(tiles()).toHaveLength(3);
		const first = tiles()[0];
		// Toolbar items keep their native button role — no role="option" stamped.
		expect(first?.hasAttribute("role")).toBe(false);
		expect(first?.hasAttribute("aria-selected")).toBe(false);
		expect(first?.hasAttribute("aria-checked")).toBe(false);
		// Roving tabindex: only the cursor is in the Tab order.
		expect(first?.tabIndex).toBe(0);
		expect(tiles()[1]?.tabIndex).toBe(-1);
	});

	it("ArrowRight / ArrowLeft move the roving cursor", () => {
		mount();
		press("ArrowRight");
		expect(tiles()[1]?.tabIndex).toBe(0);
		expect(tiles()[0]?.tabIndex).toBe(-1);
		press("ArrowLeft");
		expect(tiles()[0]?.tabIndex).toBe(0);
	});

	it("Enter focuses the cursor's window", () => {
		mount();
		press("ArrowRight"); // cursor → Bravo
		press("Enter");
		expect(onFocus).toHaveBeenCalledWith("w-bravo");
	});

	it("surfaces scroll buttons only when the track overflows (the reach-stranded-tiles fix)", () => {
		mount();
		// jsdom does no layout, so a fresh strip reports 0 scroll metrics → no overflow.
		expect(host.querySelector(".window-strip__scroll")).toBeNull();

		// Simulate many windows: track wider than the viewport, scrolled to middle.
		const el = strip();
		if (!el) throw new Error("strip missing");
		Object.defineProperty(el, "clientWidth", { value: 100, configurable: true });
		Object.defineProperty(el, "scrollWidth", { value: 400, configurable: true });
		Object.defineProperty(el, "scrollLeft", { value: 50, configurable: true, writable: true });
		act(() => {
			el.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		// Both directions are scrollable from the middle → both buttons appear.
		expect(host.querySelector(".window-strip__scroll--left")).not.toBeNull();
		expect(host.querySelector(".window-strip__scroll--right")).not.toBeNull();

		// Scrolled to the far left → only the right button remains.
		Object.defineProperty(el, "scrollLeft", { value: 0, configurable: true, writable: true });
		act(() => {
			el.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		expect(host.querySelector(".window-strip__scroll--left")).toBeNull();
		expect(host.querySelector(".window-strip__scroll--right")).not.toBeNull();
	});
});
