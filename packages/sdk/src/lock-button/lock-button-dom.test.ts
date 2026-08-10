// @vitest-environment happy-dom
/**
 * Lock-5(c) — the DOM twin of `<LockButton>`, for the apps whose chrome is
 * still imperative (Database's inspector header). Database shipped a
 * hand-rolled copy of this button that also `hidden` itself whenever the
 * inspector wasn't on exactly one record: a control that vanishes is a
 * control the user cannot find, and it takes its own explanation with it.
 */

import { describe, expect, it, vi } from "vitest";
import { createLockButton } from "./lock-button-dom";

const LABELS = { lock: "Lock (read-only)", unlock: "Unlock" };

describe("createLockButton", () => {
	it("is a native button carrying the shared chrome class", () => {
		const handle = createLockButton({ locked: false, onToggle: () => {}, labels: LABELS });
		expect(handle.element.tagName).toBe("BUTTON");
		expect(handle.element.type).toBe("button");
		expect(handle.element.classList.contains("header-icon-btn")).toBe(true);
		expect(handle.element.classList.contains("bs-lock-button")).toBe(true);
	});

	it("paints the action label + pressed state for each lock state", () => {
		const handle = createLockButton({ locked: false, onToggle: () => {}, labels: LABELS });
		expect(handle.element.getAttribute("aria-pressed")).toBe("false");
		expect(handle.element.getAttribute("aria-label")).toBe("Lock (read-only)");
		expect(handle.element.dataset.bsTooltip).toBe("Lock (read-only)");

		handle.render(true);
		expect(handle.element.getAttribute("aria-pressed")).toBe("true");
		expect(handle.element.getAttribute("aria-label")).toBe("Unlock");
	});

	it("fires onToggle with the CURRENT lock state, so the host writes the flip", () => {
		const onToggle = vi.fn();
		const handle = createLockButton({ locked: false, onToggle, labels: LABELS });
		handle.element.click();
		expect(onToggle).toHaveBeenCalledWith(false);

		handle.render(true);
		handle.element.click();
		expect(onToggle).toHaveBeenLastCalledWith(true);
	});

	it("goes DISABLED WITH A HINT rather than hidden when it cannot act", () => {
		// The replacement for Database's `hidden = true`: the affordance stays
		// where the user learned it is, and says what to do instead.
		const handle = createLockButton({ locked: false, onToggle: () => {}, labels: LABELS });
		handle.setHint("Select a single record to lock it");
		expect(handle.element.hidden).toBe(false);
		expect(handle.element.disabled).toBe(true);
		// A disabled control fires no pointer events, so the animated tooltip
		// chip cannot open — the native `title` is the only explanation left.
		expect(handle.element.title).toBe("Select a single record to lock it");
		expect(handle.element.getAttribute("aria-label")).toBe("Select a single record to lock it");
	});

	it("never fires while disabled", () => {
		const onToggle = vi.fn();
		const handle = createLockButton({ locked: false, onToggle, labels: LABELS });
		handle.setHint("Select a single record to lock it");
		handle.element.click();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("clearing the hint restores the live action label + tooltip", () => {
		const handle = createLockButton({ locked: true, onToggle: () => {}, labels: LABELS });
		handle.setHint("Select a single record to lock it");
		handle.setHint(undefined);
		expect(handle.element.disabled).toBe(false);
		expect(handle.element.hasAttribute("title")).toBe(false);
		expect(handle.element.getAttribute("aria-label")).toBe("Unlock");
		expect(handle.element.dataset.bsTooltip).toBe("Unlock");
	});

	it("renders exactly one accessible name — the glyph is aria-hidden", () => {
		const handle = createLockButton({ locked: false, onToggle: () => {}, labels: LABELS });
		const svg = handle.element.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
	});
});
