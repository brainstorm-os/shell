// @vitest-environment jsdom
/**
 * Window-switcher selection contract: MRU default selection (second entry, the
 * classic Alt+Tab "release to switch back" behaviour) and the `cycle` prop —
 * repeated `shell/switch-window` chords step the selection forward while the
 * overlay is open.
 */

import { WindowState } from "@brainstorm-os/protocol/window-types";
import type { WindowEntry } from "@brainstorm-os/protocol/window-types";
import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowSwitcher } from "./window-switcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(id: string, lastFocusedAt: number, focused = false): WindowEntry {
	return {
		id,
		appId: `io.example.${id}`,
		appName: `App ${id}`,
		windowId: "main",
		title: `Window ${id}`,
		route: null,
		monitorId: "m1",
		bounds: { x: 0, y: 0, width: 800, height: 600 },
		state: WindowState.Normal,
		focused,
		lastFocusedAt,
	};
}

// MRU order after sort: [c (300, focused), b (200), a (100)].
const ENTRIES = [entry("a", 100), entry("b", 200), entry("c", 300, true)];

describe("WindowSwitcher — selection + cycle", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onFocus: Mock<(id: string) => void>;
	let onClose: Mock<() => void>;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
		onFocus = vi.fn<(id: string) => void>();
		onClose = vi.fn<() => void>();
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	function mount(cycle: number): void {
		act(() => {
			root.render(
				<WindowSwitcher
					open={true}
					entries={ENTRIES}
					cycle={cycle}
					onFocus={onFocus}
					onClose={onClose}
				/>,
			);
		});
	}

	const selectedTitle = () =>
		document.querySelector(".window-switcher__row--selected .window-switcher__row-title")
			?.textContent;

	it("defaults the selection to the second-MRU window", () => {
		mount(0);
		expect(selectedTitle()).toBe("Window b");
	});

	it("steps the selection forward on each cycle bump, wrapping at the end", () => {
		mount(0);
		mount(1);
		expect(selectedTitle()).toBe("Window a");
		mount(2);
		expect(selectedTitle()).toBe("Window c"); // wraps back to MRU head
	});

	it("ignores an unchanged cycle value on re-render", () => {
		mount(0);
		mount(0);
		expect(selectedTitle()).toBe("Window b");
	});

	function render(props: {
		cycle?: number;
		cyclePrev?: number;
		commitSignal?: number;
		reverse?: boolean;
	}): void {
		act(() => {
			root.render(
				<WindowSwitcher open={true} entries={ENTRIES} onFocus={onFocus} onClose={onClose} {...props} />,
			);
		});
	}

	it("reverse-open highlights the most-distant (last MRU) window", () => {
		render({ reverse: true });
		expect(selectedTitle()).toBe("Window a"); // MRU [c, b, a] → last
	});

	it("steps backward on each cyclePrev bump", () => {
		render({ cyclePrev: 0 }); // default selection = second-MRU (b)
		render({ cyclePrev: 1 });
		expect(selectedTitle()).toBe("Window c"); // b → c (step back)
	});

	it("commitSignal commits the highlighted window and closes", () => {
		render({ commitSignal: 0 }); // selection defaults to b
		render({ commitSignal: 1 });
		expect(onFocus).toHaveBeenCalledWith("b");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
