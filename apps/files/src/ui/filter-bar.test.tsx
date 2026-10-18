// @vitest-environment jsdom
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILE_FILTERS, KindFilter } from "../logic/filters";
import { FilterBar, FilterToggleButton } from "./filter-bar";

let root: Root | null = null;

function render(node: ReactNode): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => root?.render(node));
	return el;
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("FilterToggleButton", () => {
	it("reports pressed state and the active-filter count", () => {
		const el = render(
			<FilterToggleButton
				open
				filters={{ ...DEFAULT_FILE_FILTERS, kind: KindFilter.Image, extension: "png" }}
				onToggle={() => {}}
			/>,
		);
		const button = el.querySelector('[data-testid="toolbar-filter"]');
		expect(button?.getAttribute("aria-pressed")).toBe("true");
		expect(button?.querySelector(".bs-count-badge")?.textContent).toBe("2");
	});

	it("shows no badge when nothing is active", () => {
		const el = render(
			<FilterToggleButton open={false} filters={DEFAULT_FILE_FILTERS} onToggle={() => {}} />,
		);
		expect(el.querySelector(".bs-count-badge")).toBeNull();
	});
});

describe("FilterBar", () => {
	it("disables Clear until a filter is active, then clears", () => {
		const onClear = vi.fn();
		const el = render(
			<FilterBar
				filters={DEFAULT_FILE_FILTERS}
				extensions={["pdf"]}
				onChange={() => {}}
				onClear={onClear}
			/>,
		);
		const clear = el.querySelector<HTMLButtonElement>('[data-testid="filter-clear"]');
		expect(clear?.disabled).toBe(true);

		act(() =>
			root?.render(
				<FilterBar
					filters={{ ...DEFAULT_FILE_FILTERS, extension: "pdf" }}
					extensions={["pdf"]}
					onChange={() => {}}
					onClear={onClear}
				/>,
			),
		);
		expect(clear?.disabled).toBe(false);
		act(() => clear?.click());
		expect(onClear).toHaveBeenCalledOnce();
		expect(el.querySelector('[data-testid="filter-extension"]')?.textContent).toContain(".pdf");
	});
});
