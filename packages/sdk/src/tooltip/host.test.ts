// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountTooltipHost } from "./host";

/**
 * The delegated tooltip controller renders the `.bs-tooltip` chip for any
 * `[data-bs-tooltip]` element on hover (after a delay) or focus (immediate),
 * and tears it down on leave / dismiss. These assert the wiring; the visual
 * entrance is CSS (`tooltip.css`).
 */

function makeButton(label: string, shortcut?: string): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.setAttribute("aria-label", label);
	btn.dataset.bsTooltip = label;
	if (shortcut) btn.dataset.bsTooltipShortcut = shortcut;
	document.body.appendChild(btn);
	return btn;
}

function chip(): HTMLElement | null {
	return document.querySelector(".bs-tooltip");
}

describe("mountTooltipHost", () => {
	let dispose: () => void;

	beforeEach(() => {
		vi.useFakeTimers();
		dispose = mountTooltipHost();
	});

	afterEach(() => {
		dispose();
		vi.useRealTimers();
		document.body.replaceChildren();
	});

	it("shows the chip after the hover delay and hides on pointer-out", () => {
		const btn = makeButton("Hide source list");
		btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		expect(chip()).toBeNull();

		vi.advanceTimersByTime(400);
		const shown = chip();
		expect(shown).not.toBeNull();
		expect(shown?.textContent).toBe("Hide source list");

		btn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("shows immediately on focus", () => {
		const btn = makeButton("New note");
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()?.textContent).toBe("New note");

		btn.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("renders the shortcut chord as a dimmed segment", () => {
		const btn = makeButton("Command palette", "⌘K");
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		const chord = chip()?.querySelector(".bs-tooltip__chord");
		expect(chord?.textContent).toBe("⌘K");
		expect(chip()?.textContent).toBe("Command palette⌘K");
	});

	it("ignores elements without a label", () => {
		const plain = document.createElement("button");
		document.body.appendChild(plain);
		plain.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		vi.advanceTimersByTime(400);
		expect(chip()).toBeNull();
	});

	it("falls back to aria-label for an icon-only button with no data-bs-tooltip", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Move up");
		btn.innerHTML = "<svg></svg>"; // icon, no visible text
		document.body.appendChild(btn);
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()?.textContent).toBe("Move up");
	});

	it("does NOT show a chip on a button with visible text", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Save");
		btn.textContent = "Save changes";
		document.body.appendChild(btn);
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("does NOT chip an icon button that still has a native title (no double-stack)", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Clear");
		btn.title = "Clear"; // not yet migrated — keep its OS tooltip, no chip
		btn.innerHTML = "<svg></svg>";
		document.body.appendChild(btn);
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("explicit data-bs-tooltip wins even when a native title is present", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Prev");
		btn.dataset.bsTooltip = "Previous match";
		btn.title = "Prev"; // disabled-state fallback still allowed alongside the chip
		btn.innerHTML = "<svg></svg>";
		document.body.appendChild(btn);
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()?.textContent).toBe("Previous match");
	});

	it("honors data-bs-no-tooltip opt-out", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Muted");
		btn.dataset.bsNoTooltip = "";
		btn.innerHTML = "<svg></svg>";
		document.body.appendChild(btn);
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("opens when hovering the icon child of an icon-only button", () => {
		const btn = document.createElement("button");
		btn.setAttribute("aria-label", "Zoom in");
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		btn.appendChild(svg);
		document.body.appendChild(btn);
		svg.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		vi.advanceTimersByTime(400);
		expect(chip()?.textContent).toBe("Zoom in");
	});

	it("dismisses on scroll and on Escape", () => {
		const btn = makeButton("Settings");
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).not.toBeNull();
		window.dispatchEvent(new Event("scroll"));
		expect(chip()).toBeNull();

		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(chip()).toBeNull();
	});

	it("does NOT re-show on the focus a pointer press grants (no press-blink)", () => {
		const btn = makeButton("Workflow actions");
		// Hover shows the chip.
		btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		vi.advanceTimersByTime(400);
		expect(chip()).not.toBeNull();

		// A press dismisses it; the focus the press grants must NOT re-pop it.
		btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).toBeNull();
	});

	it("suppresses the hover chip on a pressed trigger until the pointer leaves", () => {
		const btn = makeButton("Workflow actions");
		btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		// Still hovering the just-pressed trigger — no chip while the menu is open.
		btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		vi.advanceTimersByTime(400);
		expect(chip()).toBeNull();

		// Leaving then re-hovering clears suppression and shows again.
		btn.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
		btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		vi.advanceTimersByTime(400);
		expect(chip()).not.toBeNull();
	});

	it("still shows on keyboard focus after a keydown clears pointer modality", () => {
		// Simulate a prior mouse interaction, then keyboard navigation.
		document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
		const btn = makeButton("Settings");
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).not.toBeNull();
	});

	it("is refcounted — a second mount keeps listeners alive until both dispose", () => {
		const second = mountTooltipHost();
		dispose(); // drop the first; listeners must persist
		const btn = makeButton("Still works");
		btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).not.toBeNull();
		second();
		// After the last dispose, hovering does nothing.
		document.body.replaceChildren();
		const btn2 = makeButton("Gone");
		btn2.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(chip()).toBeNull();
		// Re-arm for afterEach's dispose() call.
		dispose = mountTooltipHost();
	});
});

/**
 * The chip's legibility is pure CSS, so it is asserted against the source
 * stylesheet: the surface must be theme-inverse tokens, never a hardcoded
 * colour. A fixed rgba(20,20,20) chip was invisible on every dark theme —
 * the surface and the toolbar it floated over were the same near-black.
 */
describe("tooltip chip surface (stylesheet invariants)", () => {
	const css = readFileSync(join(__dirname, "tooltip.css"), "utf8");
	const chipRule = css
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("}")
		.find((block) => block.includes(".bs-tooltip {"));

	it("paints the inverse-of-theme surface pair, not a fixed colour", () => {
		expect(chipRule).toBeDefined();
		expect(chipRule).toContain("background: var(--color-background-inverse)");
		expect(chipRule).toContain("color: var(--color-text-inverse)");
	});

	it("declares no literal colour anywhere in the chip chrome", () => {
		const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(declarations).not.toMatch(/(background|color):\s*(#|rgba?\()/);
	});
});
