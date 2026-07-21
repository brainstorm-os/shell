// @vitest-environment jsdom
/**
 * KBN-S-marketplace — the overlay's keyboard contract. The sidebar panel nav is
 * a vertical composite listbox (mirrors Settings); the kind-filter chips are a
 * horizontal tablist; F6 jumps sidebar↔main; the overlay is focus-trapped.
 * Pure listing filters live in `listing-filters.test.ts`.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marketplace } from "./marketplace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Marketplace — KBN-S-marketplace keyboard", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;

	beforeEach(() => {
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			marketplace: {
				listings: () => Promise.resolve([]),
				sources: () => Promise.resolve([]),
				checkUpdates: () => Promise.resolve([]),
				applyUpdate: () => Promise.resolve({ ok: true }),
			},
			dashboard: { on: () => () => undefined },
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
		onClose = vi.fn<() => void>();
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(<Marketplace onClose={onClose} />);
		});
	}

	const nav = () => host.querySelector<HTMLElement>(".marketplace__nav");
	const navOptions = () => host.querySelectorAll<HTMLElement>('.marketplace__nav [role="option"]');
	const chips = () => host.querySelector<HTMLElement>(".marketplace__chips");
	const tabs = () => host.querySelectorAll<HTMLElement>('.marketplace__chips [role="tab"]');
	const main = () => host.querySelector<HTMLElement>(".marketplace__main");
	const press = (target: EventTarget | null, key: string) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		act(() => {
			target?.dispatchEvent(ev);
		});
		return ev;
	};

	it("renders the panel nav as a hook-stamped vertical listbox with the active panel selected", async () => {
		await mount();
		expect(nav()?.getAttribute("role")).toBe("listbox");
		expect(nav()?.getAttribute("aria-orientation")).toBe("vertical");
		// PANELS: Discover(0), Browse(1, default), Library(2), Updates(3), Sources(4).
		expect(navOptions()).toHaveLength(5);
		expect(navOptions()[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("ArrowDown in the panel nav switches the active panel", async () => {
		await mount();
		press(nav(), "ArrowDown");
		// Browse(1) → Library(2).
		expect(navOptions()[2]?.getAttribute("aria-selected")).toBe("true");
	});

	it("renders the kind-filter chips as a hook-stamped horizontal tablist", async () => {
		await mount();
		expect(chips()?.getAttribute("role")).toBe("tablist");
		expect(chips()?.getAttribute("aria-orientation")).toBe("horizontal");
		expect(tabs()).toHaveLength(3);
		expect(tabs()[0]?.getAttribute("aria-selected")).toBe("true");
	});

	it("ArrowRight in the chips moves the active kind filter", async () => {
		await mount();
		press(chips(), "ArrowRight");
		// All(0) → Apps(1).
		expect(tabs()[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("F6 jumps from the sidebar to the main region", async () => {
		await mount();
		press(document, "F6");
		expect(document.activeElement).toBe(main());
	});

	it("focus-traps into the panel on open and closes on Escape", async () => {
		await mount();
		const panel = host.querySelector(".marketplace__panel");
		expect(panel?.contains(document.activeElement)).toBe(true);
		press(document, "Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
