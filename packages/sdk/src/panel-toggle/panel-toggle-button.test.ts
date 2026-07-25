/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from "vitest";
import { createPanelToggleButton } from "./panel-toggle-button";
import { PanelSide } from "./panel-toggle-icon";

const LABELS = { show: "Show sidebar", hide: "Hide sidebar" };

describe("createPanelToggleButton", () => {
	it("paints the canonical class + aria + label + icon on construction", () => {
		const { element } = createPanelToggleButton({
			side: PanelSide.Left,
			open: true,
			onClick: () => {},
			labels: LABELS,
		});
		expect(element.className).toBe("bs-panel-toggle");
		expect(element.type).toBe("button");
		expect(element.getAttribute("aria-pressed")).toBe("true");
		expect(element.getAttribute("aria-label")).toBe("Hide sidebar");
		// Enabled → animated chip via data-bs-tooltip, no native title.
		expect(element.dataset.bsTooltip).toBe("Hide sidebar");
		expect(element.hasAttribute("title")).toBe(false);
		expect(element.querySelector("svg")).not.toBeNull();
	});

	it("render(false) repaints aria + label + icon (drops the active fill)", () => {
		const { element, render } = createPanelToggleButton({
			side: PanelSide.Left,
			open: true,
			onClick: () => {},
			labels: LABELS,
		});
		render(false);
		expect(element.getAttribute("aria-pressed")).toBe("false");
		expect(element.getAttribute("aria-label")).toBe("Show sidebar");
		expect(element.dataset.bsTooltip).toBe("Show sidebar");
		expect(element.hasAttribute("title")).toBe(false);
		// Closed = no active-fill rect, just the outer frame.
		expect(element.querySelectorAll("rect")).toHaveLength(1);
	});

	it("click invokes onClick", () => {
		const onClick = vi.fn();
		const { element } = createPanelToggleButton({
			side: PanelSide.Right,
			open: false,
			onClick,
			labels: LABELS,
		});
		element.click();
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("setDisabled gates the click and reflects on the element", () => {
		const onClick = vi.fn();
		const { element, setDisabled } = createPanelToggleButton({
			side: PanelSide.Left,
			open: false,
			onClick,
			labels: LABELS,
		});
		setDisabled(true);
		expect(element.disabled).toBe(true);
		element.click();
		expect(onClick).not.toHaveBeenCalled();
		setDisabled(false);
		element.click();
		expect(onClick).toHaveBeenCalledOnce();
	});

	it("propagates ariaControls + testId when provided", () => {
		const { element } = createPanelToggleButton({
			side: PanelSide.Left,
			open: true,
			onClick: () => {},
			labels: LABELS,
			ariaControls: "notes-nav",
			testId: "toolbar-sidebar",
		});
		expect(element.getAttribute("aria-controls")).toBe("notes-nav");
		expect(element.dataset.testid).toBe("toolbar-sidebar");
	});

	it("hint overrides the show/hide label so a disabled toggle explains itself", () => {
		const { element } = createPanelToggleButton({
			side: PanelSide.Right,
			open: false,
			onClick: () => {},
			labels: LABELS,
			disabled: true,
			hint: "Select a row first",
		});
		expect(element.getAttribute("aria-label")).toBe("Select a row first");
		expect(element.dataset.bsTooltip).toBe("Select a row first");
		// A disabled control fires no pointer events, so the animated tooltip
		// chip can't open — the native title is what explains it.
		expect(element.title).toBe("Select a row first");
	});

	it("setHint swaps the override and restores the show/hide label when cleared", () => {
		const { element, setHint, setDisabled } = createPanelToggleButton({
			side: PanelSide.Right,
			open: false,
			onClick: () => {},
			labels: LABELS,
		});
		setDisabled(true);
		setHint("Nothing to inspect");
		expect(element.getAttribute("aria-label")).toBe("Nothing to inspect");
		expect(element.title).toBe("Nothing to inspect");
		setDisabled(false);
		setHint(undefined);
		expect(element.getAttribute("aria-label")).toBe("Show sidebar");
		expect(element.hasAttribute("title")).toBe(false);
	});

	it("setHint keeps the current open-state (does not reset the icon)", () => {
		const { element, render, setHint } = createPanelToggleButton({
			side: PanelSide.Left,
			open: false,
			onClick: () => {},
			labels: LABELS,
		});
		render(true);
		setHint("Busy");
		expect(element.getAttribute("aria-pressed")).toBe("true");
		expect(element.querySelectorAll("rect")).toHaveLength(2);
	});
});
