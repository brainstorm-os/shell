/**
 * @vitest-environment jsdom
 *
 * Tests for `openInlinePropertyForm` (9.3.5.U.b) — the SDK addition that
 * lets plain-DOM apps (Database column-adder, future Graph subject
 * picker, …) mount the shared property constructor inside the
 * picker-host root.
 *
 * The picker-host keeps a module-level singleton React root, so test
 * isolation hinges on every render/unmount being fully *settled* before the
 * next assertion. React commits the DOM in the mutation phase but flushes
 * passive effects (e.g. the modal's Escape `addEventListener` / its cleanup)
 * on a later scheduler tick — a `setTimeout` flush can race that, which made
 * these tests flaky under full-suite load. So every operation that triggers
 * a React update is wrapped in `flushSync`, which runs the update AND flushes
 * its passive effects synchronously. No timing-based waits remain.
 */

import { flushSync } from "react-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { closePicker, openIconPicker, openInlinePropertyForm } from "./picker-host";

// The icon picker virtualises its grid via ResizeObserver, which jsdom lacks.
beforeEach(() => {
	if (!("ResizeObserver" in globalThis)) {
		(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
});

const labels = {
	region: "New property",
	back: "Back",
	nameLabel: "Name",
	namePlaceholder: "Property name",
	kindLabel: "Kind",
	formatLabel: "Format",
	multiLabel: "Allow multiple",
	cancel: "Cancel",
	submit: "Create",
	kindText: "Text",
	kindNumber: "Number",
	kindBoolean: "Boolean",
	kindDate: "Date",
	kindSelect: "Select",
	kindRelation: "Relation",
	kindFile: "File",
	kindFormula: "Formula",
	formulaLabel: "Expression",
	formulaPlaceholder: "{a} * {b}",
	formulaHint: "Reference other properties with {braces}.",
	formatPlain: "Plain",
	formatUrl: "URL",
	formatEmail: "Email",
	formatPhone: "Phone",
	formatRichText: "Rich text",
	formatCurrency: "Currency",
	formatPercent: "Percent",
	formatDuration: "Duration",
	currencyLabel: "Currency",
	optionsLabel: "Options",
	optionsPlaceholder: "One per line",
	optionsHint: "One per line, or comma-separated.",
	relationTargetLabel: "Links to",
	relationTargetAny: "Anything",
};

/** Open synchronously — render committed + passive effects (Escape listener
 *  attach) flushed before this returns. */
function open(onCancel?: () => void): void {
	flushSync(() =>
		openInlinePropertyForm({ labels, onCommit: vi.fn(), ...(onCancel ? { onCancel } : {}) }),
	);
}

/** Dispatch an event and flush the React work its handler scheduled (e.g.
 *  the `closePicker()` render(null) + unmount cleanup) synchronously. */
function dispatchSync(target: EventTarget, event: Event): void {
	flushSync(() => target.dispatchEvent(event));
}

function teardown(): void {
	// Render null into the shared root AND flush the unmount synchronously so
	// the next test starts from a fully-settled state (panel gone, Escape
	// listener removed). The singleton root + container are intentionally
	// kept — detaching the container would orphan the next test's render.
	flushSync(() => closePicker());
}

describe("openInlinePropertyForm", () => {
	it("mounts the form inside a backdrop+panel with the region as the dialog label", () => {
		try {
			open();
			const backdrop = document.querySelector(".bs-picker-host__backdrop");
			const panel = backdrop?.querySelector(".bs-picker-host__panel");
			expect(backdrop).not.toBeNull();
			expect(panel).not.toBeNull();
			expect(panel?.getAttribute("role")).toBe("dialog");
			expect(panel?.getAttribute("aria-modal")).toBe("true");
			expect(panel?.getAttribute("aria-label")).toBe(labels.region);
			expect(panel?.querySelector(".bs-inline-property-form")).not.toBeNull();
		} finally {
			teardown();
		}
	});

	it("builds every text input on the shared .bs-input face (F-511e)", () => {
		try {
			open();
			const inputs = Array.from(
				document.querySelectorAll('.bs-inline-property-form input[type="text"]'),
			);
			expect(inputs.length).toBeGreaterThan(0);
			for (const input of inputs)
				expect(input.classList.contains("bs-input"), input.outerHTML).toBe(true);
		} finally {
			teardown();
		}
	});

	it("clicking the backdrop closes the picker and fires onCancel", () => {
		const onCancel = vi.fn();
		try {
			open(onCancel);
			const backdrop = document.querySelector(".bs-picker-host__backdrop");
			expect(backdrop).not.toBeNull();
			dispatchSync(backdrop as HTMLElement, new MouseEvent("mousedown", { bubbles: true }));
			expect(document.querySelector(".bs-picker-host__panel")).toBeNull();
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			teardown();
		}
	});

	it("clicking inside the panel does NOT close the picker (stopPropagation)", () => {
		const onCancel = vi.fn();
		try {
			open(onCancel);
			const panel = document.querySelector(".bs-picker-host__panel") as HTMLElement | null;
			expect(panel).not.toBeNull();
			dispatchSync(panel as HTMLElement, new MouseEvent("mousedown", { bubbles: true }));
			expect(document.querySelector(".bs-picker-host__panel")).not.toBeNull();
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			teardown();
		}
	});

	it("Escape closes the picker and fires onCancel (keyboard parity with the backdrop)", () => {
		const onCancel = vi.fn();
		try {
			open(onCancel);
			expect(document.querySelector(".bs-picker-host__panel")).not.toBeNull();
			dispatchSync(document, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(document.querySelector(".bs-picker-host__panel")).toBeNull();
			expect(onCancel).toHaveBeenCalledTimes(1);
		} finally {
			teardown();
		}
	});

	it("removes its Escape listener after close (no leaked handler reopening)", () => {
		const onCancel = vi.fn();
		try {
			open(onCancel);
			flushSync(() => closePicker());
			// A second Escape after the dialog is gone must not re-fire onCancel
			// — the unmount cleanup removed the capture-phase listener.
			dispatchSync(document, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			teardown();
		}
	});

	it("injects the host CSS exactly once across multiple opens", () => {
		try {
			open();
			flushSync(() => closePicker());
			open();
			const styleNodes = document.querySelectorAll('style[data-bs="bs-picker-host-inline-property"]');
			expect(styleNodes.length).toBe(1);
		} finally {
			teardown();
		}
	});

	it("closePicker drops the panel from the DOM", () => {
		try {
			open();
			expect(document.querySelector(".bs-picker-host__panel")).not.toBeNull();
			flushSync(() => closePicker());
			expect(document.querySelector(".bs-picker-host__panel")).toBeNull();
		} finally {
			teardown();
		}
	});
});

describe("openIconPicker", () => {
	it("Escape closes the icon picker (keyboard parity with the backdrop)", () => {
		try {
			flushSync(() => openIconPicker({ value: null, onChange: vi.fn() }));
			expect(document.querySelector(".icon-picker__panel")).not.toBeNull();
			dispatchSync(document, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(document.querySelector(".icon-picker__panel")).toBeNull();
		} finally {
			teardown();
		}
	});

	it("removes its Escape listener after close (no leaked handler)", () => {
		const onChange = vi.fn();
		try {
			flushSync(() => openIconPicker({ value: null, onChange }));
			flushSync(() => closePicker());
			dispatchSync(document, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			expect(document.querySelector(".icon-picker__panel")).toBeNull();
			expect(onChange).not.toHaveBeenCalled();
		} finally {
			teardown();
		}
	});
});
