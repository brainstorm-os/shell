// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
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

	it("controlled round-trip: activating flips aria-pressed + swaps the action label", () => {
		// The real per-app wiring: `locked` is controlled state, `onToggle`
		// persists `!locked`. After activation the SAME focused control must
		// read as pressed with the opposite action label — this state change on
		// the focused element is what a screen reader announces (the SDK toggle
		// pattern: aria-pressed, no separate live-region announce — same as
		// PanelToggleButton / the role="switch" toggle cell).
		function Host(): ReturnType<typeof LockButton> {
			const [locked, setLocked] = useState(false);
			return createElement(LockButton, {
				locked,
				onToggle: () => setLocked((v) => !v),
				lockLabel: "Lock (read-only)",
				unlockLabel: "Unlock",
			});
		}
		act(() => root.render(createElement(Host)));
		const btn = container.querySelector<HTMLButtonElement>(".bs-lock-button");
		if (!btn) throw new Error("LockButton did not render");

		act(() => btn.click());
		expect(btn.getAttribute("aria-pressed")).toBe("true");
		expect(btn.getAttribute("aria-label")).toBe("Unlock");

		act(() => btn.click());
		expect(btn.getAttribute("aria-pressed")).toBe("false");
		expect(btn.getAttribute("aria-label")).toBe("Lock (read-only)");
	});

	it("is a native button in the tab order (keyboard path: Tab → Space/Enter)", () => {
		// Keyboard reachability rides on NATIVE semantics — a real <button
		// type="button"> is focusable (tabIndex 0) and activates on Space/Enter
		// without any raw `e.key` handling (per 35-code-conventions §Keyboard).
		const btn = render(false, () => {});
		expect(btn.tagName).toBe("BUTTON");
		expect(btn.type).toBe("button");
		expect(btn.tabIndex).toBe(0);
		btn.focus();
		expect(document.activeElement).toBe(btn);
	});

	it("exposes exactly one accessible name — the icon is aria-hidden", () => {
		// The glyph must not leak into the accessible name; SRs read only the
		// action label (aria-label) + the pressed state.
		const btn = render(true, () => {});
		const svg = btn.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.getAttribute("aria-hidden")).toBe("true");
	});
});
