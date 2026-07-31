// @vitest-environment jsdom
/**
 * Popover React render/close + DOM-twin mount/dismiss. Both must dismiss on
 * backdrop and on the (injectable) Escape matcher, and both read every
 * string from the injected labels (no bare strings in the chrome).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopoverElement } from "./create-popover-element";
import { Popover } from "./popover";
import { DEFAULT_POPOVER_LABELS, resolvePopoverLabels } from "./popover-labels";
import { PopoverBodyPadding, PopoverSize } from "./popover-shared";

describe("resolvePopoverLabels", () => {
	it("returns defaults and merges a partial override", () => {
		expect(resolvePopoverLabels()).toBe(DEFAULT_POPOVER_LABELS);
		expect(resolvePopoverLabels({ close: "Fermer" })).toEqual({
			region: DEFAULT_POPOVER_LABELS.region,
			close: "Fermer",
		});
	});
});

describe("<Popover>", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("renders title/body/footer with the size + padding classes", () => {
		act(() =>
			root.render(
				<Popover
					title="Hi"
					onClose={() => undefined}
					size={PopoverSize.Large}
					bodyPadding={PopoverBodyPadding.Comfortable}
					footer={<button type="button">ok</button>}
					testId="pp"
				>
					<p>body</p>
				</Popover>,
			),
		);
		const panel = host.querySelector<HTMLElement>('[data-testid="pp"]');
		expect(panel?.className).toContain("bs-popover__panel--large");
		expect(host.querySelector(".bs-popover__body--comfortable")).not.toBeNull();
		expect(host.querySelector(".bs-popover__footer")).not.toBeNull();
		expect(host.textContent).toContain("Hi");
		expect(host.textContent).toContain("body");
	});

	it("uses injected close label on the backdrop + close button", () => {
		act(() =>
			root.render(
				<Popover title="t" onClose={() => undefined} labels={{ close: "Dismiss" }}>
					x
				</Popover>,
			),
		);
		const labelled = host.querySelectorAll('[aria-label="Dismiss"]');
		expect(labelled.length).toBe(2);
	});

	it("closes on backdrop click and on Escape, opts out when matcher is null", () => {
		const onClose = vi.fn();
		act(() =>
			root.render(
				<Popover title="t" onClose={onClose}>
					x
				</Popover>,
			),
		);
		host.querySelector<HTMLButtonElement>(".bs-popover__backdrop")?.click();
		expect(onClose).toHaveBeenCalledTimes(1);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose).toHaveBeenCalledTimes(2);

		const onClose2 = vi.fn();
		act(() =>
			root.render(
				<Popover title="t" onClose={onClose2} escapeMatcher={null}>
					x
				</Popover>,
			),
		);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose2).not.toHaveBeenCalled();
	});
});

describe("createPopoverElement", () => {
	it("mounts into body, renders chrome, closes on backdrop", () => {
		const onClose = vi.fn();
		const h = createPopoverElement({
			title: "Confirm",
			body: "Are you sure?",
			onClose,
			footer: document.createElement("button"),
			testId: "dom-pp",
		});
		expect(document.body.contains(h.element)).toBe(true);
		expect(h.element.querySelector(".bs-popover__title")?.textContent).toBe("Confirm");
		expect(h.element.querySelector('[data-testid="dom-pp"]')).not.toBeNull();
		expect(h.element.querySelector(".bs-popover__footer")).not.toBeNull();
		h.element.querySelector<HTMLButtonElement>(".bs-popover__backdrop")?.click();
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(document.body.contains(h.element)).toBe(false);
	});

	it("closes on Escape via the default matcher and detaches the listener", () => {
		const onClose = vi.fn();
		const h = createPopoverElement({ title: "t", body: "b", onClose });
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(document.body.contains(h.element)).toBe(false);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("opts out of Escape when matcher is null and close() is idempotent", () => {
		const onClose = vi.fn();
		const h = createPopoverElement({
			title: "t",
			body: document.createElement("span"),
			onClose,
			escapeMatcher: null,
		});
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose).not.toHaveBeenCalled();
		h.close();
		h.close();
		expect(document.body.contains(h.element)).toBe(false);
	});

	it("adds the content-fit modifier only when asked", () => {
		const bare = createPopoverElement({ title: "t", body: "b", onClose: () => undefined });
		expect(
			bare.element.querySelector(".bs-popover__panel")?.classList.contains("bs-popover__panel--fit"),
		).toBe(false);
		bare.close();
		const fit = createPopoverElement({
			title: "t",
			body: "b",
			onClose: () => undefined,
			fitContent: true,
		});
		const panel = fit.element.querySelector(".bs-popover__panel");
		expect(panel?.classList.contains("bs-popover__panel--fit")).toBe(true);
		// The size variant is still applied — fit drops the min-height, nothing else.
		expect(panel?.classList.contains("bs-popover__panel--medium")).toBe(true);
		fit.close();
	});

	it("honours a custom escape matcher", () => {
		const onClose = vi.fn();
		createPopoverElement({
			title: "t",
			body: "b",
			onClose,
			escapeMatcher: (e) => e.key === "q",
		});
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(onClose).not.toHaveBeenCalled();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "q", cancelable: true }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
