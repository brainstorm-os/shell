// @vitest-environment happy-dom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockButton } from "./LockButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("LockButton", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
	});

	function render(locked: boolean, onToggle: () => void): HTMLButtonElement {
		act(() => {
			root.render(
				createElement(LockButton, {
					locked,
					onToggle,
					lockLabel: "Lock (read-only)",
					unlockLabel: "Unlock",
				}),
			);
		});
		const btn = container.querySelector<HTMLButtonElement>(".bs-lock-button");
		if (!btn) throw new Error("LockButton did not render");
		return btn;
	}

	it("shows the lock action + unpressed state when unlocked", () => {
		const btn = render(false, () => {});
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		expect(btn.getAttribute("aria-label")).toBe("Lock (read-only)");
		expect(btn.dataset.bsTooltip).toBe("Lock (read-only)");
	});

	it("shows the unlock action + pressed state when locked", () => {
		const btn = render(true, () => {});
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		expect(btn.getAttribute("aria-label")).toBe("Unlock");
		expect(btn.dataset.bsTooltip).toBe("Unlock");
	});

	it("uses only the custom tooltip — no native `title` (no double tooltip)", () => {
		const btn = render(false, () => {});
		expect(btn.hasAttribute("title")).toBe(false);
	});

	it("fires onToggle on click", () => {
		const onToggle = vi.fn();
		const btn = render(false, onToggle);
		act(() => btn.click());
		expect(onToggle).toHaveBeenCalledTimes(1);
	});
});
