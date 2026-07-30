// @vitest-environment jsdom
import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Popover } from "./popover";
import {
	_resetPopoverStackForTests,
	getPopoverStackIds,
	registerPopover,
	stackDepthOf,
} from "./popover-stack";
import { PopoverSize } from "./popover-types";

describe("popover stack — inertness bookkeeping", () => {
	beforeEach(() => _resetPopoverStackForTests());
	afterEach(() => _resetPopoverStackForTests());

	function el(): HTMLElement {
		const node = document.createElement("div");
		document.body.appendChild(node);
		return node;
	}

	it("leaves a lone popover interactive", () => {
		const only = el();
		registerPopover("a", only);
		expect(getPopoverStackIds()).toHaveLength(1);
		expect(only.hasAttribute("inert")).toBe(false);
		expect(only.hasAttribute("aria-hidden")).toBe(false);
	});

	it("makes every popover below the top inert and hidden from AT", () => {
		const first = el();
		const second = el();
		const third = el();
		registerPopover("a", first);
		registerPopover("b", second);
		registerPopover("c", third);
		for (const below of [first, second]) {
			expect(below.hasAttribute("inert")).toBe(true);
			expect(below.getAttribute("aria-hidden")).toBe("true");
		}
		expect(third.hasAttribute("inert")).toBe(false);
		expect(third.hasAttribute("aria-hidden")).toBe(false);
	});

	it("un-inerts the new top synchronously on unregister — the focus restore depends on it", () => {
		const parent = el();
		const child = el();
		registerPopover("parent", parent);
		const closeChild = registerPopover("child", child);
		expect(parent.hasAttribute("inert")).toBe(true);
		closeChild();
		expect(parent.hasAttribute("inert")).toBe(false);
		expect(parent.hasAttribute("aria-hidden")).toBe(false);
	});

	it("resolves an unregistered id to the depth it is about to land on", () => {
		// A popover reads its depth during its FIRST render, before the mount
		// effect registers it — that fallback is what makes the stacked styling
		// correct on the first paint instead of flashing un-stacked.
		expect(stackDepthOf([], "pending")).toBe(0);
		expect(stackDepthOf(["parent"], "pending")).toBe(1);
		expect(stackDepthOf(["parent", "child"], "child")).toBe(1);
		expect(stackDepthOf(["parent", "child"], "parent")).toBe(0);
	});

	it("is idempotent when the same unregister runs twice", () => {
		const parent = el();
		const child = el();
		registerPopover("parent", parent);
		const closeChild = registerPopover("child", child);
		closeChild();
		closeChild();
		expect(getPopoverStackIds()).toHaveLength(1);
		expect(parent.hasAttribute("inert")).toBe(false);
	});
});

describe("Popover — a confirm stacked over a picker stays readable", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;

	beforeEach(() => {
		_resetPopoverStackForTests();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
		_resetPopoverStackForTests();
	});

	/** Mirrors the real shape: a picker `<Popover>` whose row button opens a
	 *  consent `<Popover>` (what `confirm()` renders) on top of it. */
	function Harness() {
		const [parent, setParent] = useState(true);
		const [child, setChild] = useState(false);
		if (!parent) {
			return child ? (
				<Popover
					title="Install Client Pulse?"
					onClose={() => setChild(false)}
					size={PopoverSize.Small}
					testId="child-panel"
				>
					<p>Version 1.0.0</p>
				</Popover>
			) : null;
		}
		return (
			<Popover title="Install from vault" onClose={() => undefined} size={PopoverSize.Medium}>
				<button type="button" data-testid="row-install" onClick={() => setChild(true)}>
					Install
				</button>
				<button type="button" data-testid="close-parent" onClick={() => setParent(false)}>
					Close picker
				</button>
				{child ? (
					<Popover
						title="Install Client Pulse?"
						onClose={() => setChild(false)}
						size={PopoverSize.Small}
						testId="child-panel"
					>
						<p>Version 1.0.0</p>
					</Popover>
				) : null}
			</Popover>
		);
	}

	function roots(): HTMLElement[] {
		return [...document.querySelectorAll<HTMLElement>(".popover")];
	}

	it("renders the lone picker as glass, un-lifted and interactive", () => {
		act(() => root.render(<Harness />));
		const [picker] = roots();
		expect(roots()).toHaveLength(1);
		expect(picker?.className).toBe("popover");
		expect(picker?.getAttribute("data-popover-depth")).toBe("0");
		expect(picker?.style.zIndex).toBe("");
		expect(picker?.hasAttribute("inert")).toBe(false);
		expect(document.querySelector(".popover__panel")?.classList.contains("glass")).toBe(true);
	});

	it("gives the stacked confirm an opaque panel, a lift and a blurred scrim class", () => {
		act(() => root.render(<Harness />));
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="row-install"]')?.click());
		const [picker, confirmRoot] = roots();
		expect(roots()).toHaveLength(2);
		expect(confirmRoot?.classList.contains("popover--stacked")).toBe(true);
		expect(confirmRoot?.getAttribute("data-popover-depth")).toBe("1");
		expect(confirmRoot?.style.zIndex).toBe("calc(var(--z-popover) + 1)");
		// The readability fix: the upper panel is NOT glass, so the picker's body
		// text and footer buttons cannot composite through it.
		const confirmPanel = document.querySelector<HTMLElement>('[data-testid="child-panel"]');
		expect(confirmPanel?.classList.contains("popover__panel--solid")).toBe(true);
		expect(confirmPanel?.classList.contains("glass")).toBe(false);
		// …and the picker is still glass — the single-dialog look is untouched.
		expect(picker?.querySelector(".popover__panel")?.classList.contains("glass")).toBe(true);
	});

	it("makes the picker inert while the confirm is open, and live again after", () => {
		act(() => root.render(<Harness />));
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="row-install"]')?.click());
		const [picker, confirmRoot] = roots();
		expect(picker?.hasAttribute("inert")).toBe(true);
		expect(picker?.getAttribute("aria-hidden")).toBe("true");
		expect(confirmRoot?.hasAttribute("inert")).toBe(false);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(roots()).toHaveLength(1);
		expect(picker?.hasAttribute("inert")).toBe(false);
		expect(picker?.hasAttribute("aria-hidden")).toBe(false);
	});

	it("un-stacks back to glass when the dialog underneath closes first", () => {
		act(() => root.render(<Harness />));
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="row-install"]')?.click());
		expect(document.querySelectorAll(".popover--stacked")).toHaveLength(1);
		act(() => document.querySelector<HTMLButtonElement>('[data-testid="close-parent"]')?.click());
		const [only] = roots();
		expect(roots()).toHaveLength(1);
		expect(only?.classList.contains("popover--stacked")).toBe(false);
		expect(only?.getAttribute("data-popover-depth")).toBe("0");
		expect(only?.querySelector(".popover__panel")?.classList.contains("glass")).toBe(true);
	});

	it("traps focus in the confirm and hands it back to the picker row on close", () => {
		act(() => root.render(<Harness />));
		const row = document.querySelector<HTMLButtonElement>('[data-testid="row-install"]');
		row?.focus();
		act(() => row?.click());
		const confirmPanel = document.querySelector<HTMLElement>('[data-testid="child-panel"]');
		expect(confirmPanel?.contains(document.activeElement)).toBe(true);

		act(() => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(document.activeElement).toBe(row);
	});
});
