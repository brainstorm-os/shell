/**
 * @vitest-environment jsdom
 *
 * Renderer tests for the "Add formula…" authoring affordance on the
 * view-settings Properties page (9.12.17 — formula slice-2 creation flow).
 * Drives the real DOM popover: open settings → Properties → Add formula → fill
 * the expression → submit, asserting the host `onAdd` gets the built column.
 */

import {
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
	mountMenuHost,
} from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formulaColumnId } from "../logic/formula";
import type {
	BoardLayoutOptions,
	ColumnSpec,
	GridLayoutOptions,
	ListView,
} from "../types/list-view";
import { ListViewKind } from "../types/list-view";
import {
	type ViewSettingsProps,
	closeViewSettings,
	openViewSettings,
	resetViewSettingsPage,
} from "./view-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GRID_LAYOUT: GridLayoutOptions = {
	rowHeight: "comfortable",
	showRowNumbers: false,
	pinFirstColumn: false,
};

function makeView(columns: ColumnSpec[] = []): ListView {
	return {
		id: "view-1",
		listId: "list-1",
		name: "Engagements",
		icon: null,
		kind: ListViewKind.Grid,
		filters: null,
		sorts: [],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns,
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: GRID_LAYOUT,
	};
}

function open(opts: { withFormula?: boolean } = {}): {
	onAdd: ReturnType<typeof vi.fn>;
	onChange: ReturnType<typeof vi.fn>;
	onClose: ReturnType<typeof vi.fn>;
} {
	const withFormula = opts.withFormula ?? true;
	const onAdd = vi.fn();
	const onChange = vi.fn();
	const onClose = vi.fn();
	const anchor = document.createElement("button");
	document.body.appendChild(anchor);
	resetViewSettingsPage();
	// A real column keeps the Properties page reachable regardless of the
	// formula hook (so the no-formula case can still navigate there).
	const props: ViewSettingsProps = {
		view: makeView([{ propertyId: "fee", visible: true }]),
		availableProperties: ["fee", "quantity"],
		onChange,
		onClose,
		...(withFormula ? { formula: { onAdd } } : {}),
	};
	openViewSettings(anchor, props);
	return { onAdd, onChange, onClose };
}

function $<T extends HTMLElement>(testid: string): T {
	const el = document.querySelector<T>(`[data-testid="${testid}"]`);
	if (!el) throw new Error(`missing [data-testid="${testid}"]`);
	return el;
}

function addedColumn(onAdd: ReturnType<typeof vi.fn>): ColumnSpec {
	const call = onAdd.mock.calls[0];
	if (!call) throw new Error("onAdd not called");
	return call[0] as ColumnSpec;
}

function click(el: HTMLElement): void {
	el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Navigate the popover from the root to the Properties sub-page (where the
 *  "Add formula…" affordance lives) by clicking its labelled nav row. */
function gotoProperties(): void {
	const rows = [...document.querySelectorAll<HTMLElement>(".db-popover__nav-row")];
	const row = rows.find((r) => r.textContent?.includes("Properties"));
	if (!row) throw new Error("Properties nav row not found");
	click(row);
}

function type(input: HTMLInputElement, value: string): void {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
	closeViewSettings();
	document.body.replaceChildren();
});

describe("view-settings — Add formula affordance", () => {
	it("offers the Add formula button on the Properties page", () => {
		open();
		gotoProperties();
		// Drilling into Add formula opens the authoring page (expression field).
		click($("db-view-settings-add-formula"));
		expect(document.querySelector('[data-testid="db-formula-expression"]')).not.toBeNull();
	});

	it("builds and adds a column for a valid expression", () => {
		const { onAdd } = open();
		gotoProperties();
		click($("db-view-settings-add-formula"));
		type($<HTMLInputElement>("db-formula-expression"), "{fee} * {quantity}");
		type($<HTMLInputElement>("db-formula-name"), "Total fee");
		click($("db-formula-submit"));

		expect(onAdd).toHaveBeenCalledTimes(1);
		const column = addedColumn(onAdd);
		expect(column.propertyId).toBe(formulaColumnId("{fee} * {quantity}"));
		expect(column.formula).toEqual({ expression: "{fee} * {quantity}", name: "Total fee" });
	});

	it("blocks a syntax error and surfaces the message", () => {
		const { onAdd } = open();
		gotoProperties();
		click($("db-view-settings-add-formula"));
		type($<HTMLInputElement>("db-formula-expression"), "{fee} +");
		const message = $("db-formula-message");
		expect(message.hidden).toBe(false);
		expect(message.dataset.kind).toBe("syntax");
		expect(($("db-formula-submit") as HTMLButtonElement).disabled).toBe(true);

		click($("db-formula-submit"));
		expect(onAdd).not.toHaveBeenCalled();
	});

	it("warns on an unknown reference but still allows adding it", () => {
		const { onAdd } = open();
		gotoProperties();
		click($("db-view-settings-add-formula"));
		type($<HTMLInputElement>("db-formula-expression"), "{margin} + 1");
		const message = $("db-formula-message");
		expect(message.dataset.kind).toBe("unknown-reference");
		// Recoverable — the submit button is not disabled.
		expect(($("db-formula-submit") as HTMLButtonElement).disabled).toBe(false);

		click($("db-formula-submit"));
		expect(onAdd).toHaveBeenCalledTimes(1);
		const column = addedColumn(onAdd);
		expect(column.formula?.expression).toBe("{margin} + 1");
	});

	it("uses the expression as the name when the name is left blank", () => {
		const { onAdd } = open();
		gotoProperties();
		click($("db-view-settings-add-formula"));
		type($<HTMLInputElement>("db-formula-expression"), "{fee} + 1");
		click($("db-formula-submit"));
		const column = addedColumn(onAdd);
		expect(column.formula?.name).toBe("{fee} + 1");
	});

	it("hides the affordance when the host provides no formula hook", () => {
		open({ withFormula: false });
		gotoProperties();
		expect(document.querySelector('[data-testid="db-view-settings-add-formula"]')).toBeNull();
	});
});

describe("view-settings — select rows (shared select-menu control)", () => {
	const BOARD_LAYOUT: BoardLayoutOptions = {
		columnWidth: 280,
		collapseEmptyColumns: false,
		cardPreview: "minimal",
	};

	let disposeMenuHost: () => void = () => {};

	beforeEach(() => {
		act(() => {
			disposeMenuHost = mountMenuHost();
		});
	});

	afterEach(() => {
		act(() => closeContextMenu());
		act(() => disposeMenuHost());
	});

	function openBoard(groupBy: { propertyId: string } | null = null): {
		onChange: ReturnType<typeof vi.fn>;
	} {
		const onChange = vi.fn();
		const anchor = document.createElement("button");
		document.body.appendChild(anchor);
		resetViewSettingsPage();
		const props: ViewSettingsProps = {
			view: {
				...makeView([{ propertyId: "status", visible: true }]),
				kind: ListViewKind.Board,
				layoutOptions: BOARD_LAYOUT,
				groupBy,
			},
			availableProperties: ["status", "owner"],
			onChange,
			onClose: vi.fn(),
		};
		openViewSettings(anchor, props);
		const rows = [...document.querySelectorAll<HTMLElement>(".db-popover__nav-row")];
		const row = rows.find((r) => r.textContent?.includes("Grouping"));
		if (!row) throw new Error("Grouping nav row not found");
		click(row);
		return { onChange };
	}

	function trigger(label: string): HTMLButtonElement {
		const el = document.querySelector<HTMLButtonElement>(`.bs-select[aria-label="${label}"]`);
		if (!el) throw new Error(`missing .bs-select trigger "${label}"`);
		return el;
	}

	function openItems(menuLabel: string): ContextMenuItem[] {
		const store = getActiveMenuStore();
		const open = store?.getAll().find((m) => m.id === `${CONTEXT_MENU_ID}:${menuLabel}`);
		expect(open, `menu ${menuLabel} should be open`).toBeDefined();
		return (open?.param.data as { items: ContextMenuItem[] }).items;
	}

	it("renders a .bs-select trigger instead of a native select", () => {
		openBoard();
		expect(document.querySelector("select")).toBeNull();
		const groupBy = trigger("Group by");
		expect(groupBy.getAttribute("aria-haspopup")).toBe("menu");
		// No groupBy set → the "— none —" clear option is the current value.
		expect(groupBy.querySelector(".bs-select__value")?.textContent).toBe("— none —");
	});

	it("opens the option list on click and commits a property pick", () => {
		const { onChange } = openBoard();
		act(() => trigger("Group by").click());
		const items = openItems("Group by");
		expect(items.map((it) => it.label)).toEqual(["— none —", "Status", "Owner"]);
		// The clear entry is the current value, so it carries the check.
		expect(items[0]?.selected).toBe(true);

		act(() => items[1]?.onSelect?.());
		expect(onChange).toHaveBeenCalledWith({ groupBy: { propertyId: "status" } });
		// The trigger reflects the pick without waiting for the host re-open.
		expect(trigger("Group by").querySelector(".bs-select__value")?.textContent).toBe("Status");
	});

	it('maps the clear entry (value "") back to a null group-by', () => {
		const { onChange } = openBoard({ propertyId: "status" });
		act(() => trigger("Group by").click());
		const items = openItems("Group by");
		expect(items[1]?.selected).toBe(true);

		act(() => items[0]?.onSelect?.());
		expect(onChange).toHaveBeenCalledWith({ groupBy: null });
	});
});
