// @vitest-environment jsdom
/**
 * Grid view structural integration — proves the dnd-kit wiring is on
 * each sortable header cell under a real React mount (the actual reorder
 * algorithm is covered by the `computeColumnReorder` unit test;
 * simulating dnd-kit's drag lifecycle end-to-end in jsdom is famously
 * brittle — `scrollIntoView` and `getBoundingClientRect` both stub to
 * zero, so the KeyboardSensor's coordinate math doesn't resolve).
 */

import { PropertyFormat, ValueType } from "@brainstorm/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregationKind } from "../logic/aggregations";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { installPropertyDefResolver } from "../logic/property-resolver";
import type { ColumnSpec, GridLayoutOptions } from "../types/list-view";
import { EditableTitle, GridView, type GridViewProps, OpenRecordButton } from "./grid-view";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("Expected value to be present");
	}
	return value;
}

const ENTITY: EntityRow = {
	id: "ent_1",
	type: "brainstorm/Task/v1",
	properties: { title: "Buy milk", status: "todo" },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
};

const COMPILED: CompiledView = {
	rows: [ENTITY],
	groups: [],
};

const LAYOUT: GridLayoutOptions = {
	rowHeight: "comfortable",
	showRowNumbers: false,
	pinFirstColumn: true,
};

const columns = (ids: string[]): ColumnSpec[] =>
	ids.map((id) => ({ propertyId: id, width: 160, visible: true }));

type Harness = { container: HTMLDivElement; root: Root; cleanup: () => void };

function mountGrid(props: GridViewProps): Harness {
	const container = document.createElement("div");
	const stage = document.createElement("div");
	stage.className = "db-stage__body";
	stage.style.height = "400px";
	stage.style.overflow = "auto";
	stage.append(container);
	document.body.append(stage);
	const root = createRoot(container);
	act(() => root.render(<GridView {...props} />));
	return {
		container,
		root,
		cleanup: () => {
			act(() => root.unmount());
			stage.remove();
		},
	};
}

describe("GridView — structural DnD wiring", () => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		document.body.innerHTML = "";
	});

	it("renders one pinned Name + one sortable cell per non-title column", () => {
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status", "priority", "due"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const heads = h.container.querySelectorAll<HTMLElement>(".dbv-grid__cell--head");
		expect(heads.length).toBe(4);
		const sortable = h.container.querySelectorAll<HTMLElement>("[data-prop]");
		expect(Array.from(sortable).map((el) => el.dataset.prop)).toEqual(["status", "priority", "due"]);
	});

	it("pluralizes the footer row count (1 row, not 1 rows)", () => {
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const total = must(h.container.querySelector<HTMLElement>(".dbv-grid__foot-total"));
		expect(total.textContent?.replace(/\s+/g, " ").trim()).toBe("1 row");
	});

	it("uses the plural form for multiple rows", () => {
		const two: CompiledView = {
			rows: [ENTITY, { ...ENTITY, id: "ent_2", properties: { title: "Buy eggs" } }],
			groups: [],
		};
		h = mountGrid({
			compiled: two,
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const total = must(h.container.querySelector<HTMLElement>(".dbv-grid__foot-total"));
		expect(total.textContent?.replace(/\s+/g, " ").trim()).toBe("2 rows");
	});

	it("exposes the grid as a single composite Tab stop with a cell cursor (12.4)", () => {
		// Cell-level keyboard nav: DOM focus lives on the `role="grid"` table
		// container (one Tab stop), and the cursor is conveyed by
		// `aria-activedescendant`. The referenced cell only mounts when its row
		// is in the virtual window (zero-height under jsdom), so we assert the
		// container wiring, not the cell element.
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status", "priority"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const table = must(h.container.querySelector<HTMLElement>(".dbv-grid__table"));
		expect(table.getAttribute("role")).toBe("grid");
		expect(table.getAttribute("tabindex")).toBe("0");
		// One non-empty row → the cursor starts on the first cell.
		expect(table.getAttribute("aria-activedescendant")).toBeTruthy();
		// The header row is no longer its own Tab stop — only programmatically
		// focusable (-1), so the grid container owns keyboard focus.
		const head = must(h.container.querySelector<HTMLElement>(".dbv-grid__row--head"));
		expect(head.getAttribute("tabindex")).toBe("-1");
	});

	it("drops the cell cursor for an empty result set (12.4)", () => {
		h = mountGrid({
			compiled: { rows: [], groups: [] },
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const table = must(h.container.querySelector<HTMLElement>(".dbv-grid__table"));
		expect(table.getAttribute("role")).toBe("grid");
		expect(table.getAttribute("aria-activedescendant")).toBeNull();
	});

	it("attaches dnd-kit a11y attributes to every sortable header cell", () => {
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status", "priority"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const sortable = h.container.querySelectorAll<HTMLElement>("[data-prop]");
		expect(sortable.length).toBe(2);
		for (const cell of sortable) {
			// dnd-kit assigns these via `useSortable({ attributes })` —
			// load-bearing for keyboard sensors + screen-reader semantics.
			expect(cell.getAttribute("role")).toBe("columnheader");
			expect(cell.getAttribute("aria-roledescription")).toBe("sortable column");
			expect(cell.getAttribute("tabindex")).toBe("0");
		}
	});

	it("renders a rollup column read-only: header name + computed aggregate over related rows", () => {
		// An Engagement linking to two Deliverables (fee 1000 + 2500), with the
		// deliverables present in `allRows` (a different type, absent from the
		// view's own rows).
		const engagement: EntityRow = {
			id: "eng_1",
			type: "Engagement",
			properties: { title: "Acme", deliverables: [{ value: "d_1" }, { value: "d_2" }] },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		const deliverable = (id: string, fee: number): EntityRow => ({
			id,
			type: "Deliverable",
			properties: { fee },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		});
		const rollupColumn: ColumnSpec = {
			propertyId: "rollup:deliverables:fee:sum",
			visible: true,
			rollup: {
				relationKey: "deliverables",
				targetPropertyKey: "fee",
				aggregation: "sum",
				name: "Total fee",
			},
		};
		h = mountGrid({
			compiled: { rows: [engagement], groups: [] },
			columns: [rollupColumn],
			allRows: [engagement, deliverable("d_1", 1000), deliverable("d_2", 2500)],
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		// Header reads the rollup's display name, not the synthetic id; the
		// rollup column gets no footer aggregation button (it IS an aggregation).
		const head = must(
			h.container.querySelector<HTMLElement>('[data-prop="rollup:deliverables:fee:sum"]'),
		);
		expect(head.textContent).toContain("Total fee");
		expect(h.container.querySelectorAll(".dbv-grid__foot-button").length).toBe(0);
	});

	it("pins the Name column outside the sortable set (no data-prop, not draggable)", () => {
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const heads = h.container.querySelectorAll<HTMLElement>(".dbv-grid__cell--head");
		// First head is Name (pinned), no `data-prop`.
		expect(heads[0]?.textContent).toContain("Name");
		expect(heads[0]?.hasAttribute("data-prop")).toBe(false);
		expect(heads[0]?.hasAttribute("aria-roledescription")).toBe(false);
	});

	it("renders the title column with `touch-action: none` + `user-select: none` (dnd-kit pointer prerequisites)", () => {
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const sortable = h.container.querySelector<HTMLElement>("[data-prop]");
		expect(sortable).not.toBeNull();
		const style = must(sortable).style;
		expect(style.touchAction).toBe("none");
		expect(style.userSelect).toBe("none");
	});

	it("renders an aggregation footer: row total + a default per-column aggregation", () => {
		const rows: EntityRow[] = [
			{ ...ENTITY, id: "a", properties: { title: "A", score: 10 } },
			{ ...ENTITY, id: "b", properties: { title: "B", score: 20 } },
		];
		h = mountGrid({
			compiled: { rows, groups: [] },
			columns: columns(["score"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const foot = must(h.container.querySelector<HTMLElement>(".dbv-grid__row--foot"));
		// Title cell shows the row total.
		expect(foot.querySelector(".dbv-grid__foot-total")?.textContent).toContain("2 rows");
		// Numeric column defaults to Sum (10 + 20 = 30).
		const button = must(foot.querySelector<HTMLButtonElement>(".dbv-grid__foot-button"));
		expect(button.querySelector(".dbv-grid__foot-kind")?.textContent).toBe("Sum");
		expect(button.querySelector(".dbv-grid__foot-value")?.textContent).toBe("30");
	});

	it("reads the persisted aggregation from the column spec (not the type default)", () => {
		const rows: EntityRow[] = [
			{ ...ENTITY, id: "a", properties: { title: "A", score: 10 } },
			{ ...ENTITY, id: "b", properties: { title: "B", score: 20 } },
		];
		h = mountGrid({
			compiled: { rows, groups: [] },
			// The column carries a persisted Average choice (9.12.18) — survives
			// reload via the view override, so the footer must honor it over Sum.
			columns: [{ propertyId: "score", width: 160, visible: true, aggregation: "average" }],
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		const button = must(h.container.querySelector<HTMLButtonElement>(".dbv-grid__foot-button"));
		expect(button.querySelector(".dbv-grid__foot-kind")?.textContent).toBe("Average");
		expect(button.querySelector(".dbv-grid__foot-value")?.textContent).toBe("15");
	});

	it("opens the aggregation picker on footer click and persists the chosen kind", () => {
		const rows: EntityRow[] = [
			{ ...ENTITY, id: "a", properties: { title: "A", score: 10 } },
			{ ...ENTITY, id: "b", properties: { title: "B", score: 20 } },
		];
		const onSetColumnAggregation = vi.fn();
		h = mountGrid({
			compiled: { rows, groups: [] },
			columns: columns(["score"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
			onSetColumnAggregation,
		});
		const button = must(h.container.querySelector<HTMLButtonElement>(".dbv-grid__foot-button"));
		act(() => button.click());
		// A fancy menu of the numeric aggregations opens; pick "Average".
		const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".bs-object-menu__item"));
		const labels = items.map((el) => el.querySelector(".bs-object-menu__label")?.textContent);
		expect(labels).toContain("Sum");
		expect(labels).toContain("Average");
		const average = must(
			items.find((el) => el.querySelector(".bs-object-menu__label")?.textContent === "Average"),
		);
		act(() => average.click());
		expect(onSetColumnAggregation).toHaveBeenCalledWith("score", AggregationKind.Average);
	});
});

describe("EditableTitle — inline rename for generic-Object rows (F-014)", () => {
	// The grid body virtualizes (zero-height in jsdom), so the title cell is
	// exercised through the EditableTitle component directly — the same node
	// GridCell mounts for a `brainstorm/Object/v1` row when `onEdit` is wired.
	let root: Root | null = null;
	let container: HTMLDivElement | null = null;

	const obj: EntityRow = {
		id: "obj_1",
		type: "brainstorm/Object/v1",
		properties: { name: "Untitled" },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};

	function mount(onEdit: GridViewProps["onEdit"]): HTMLDivElement {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root?.render(<EditableTitle entity={obj} onEdit={must(onEdit)} />));
		return container;
	}

	afterEach(() => {
		act(() => root?.unmount());
		root = null;
		container?.remove();
		container = null;
		document.body.innerHTML = "";
	});

	it("commits a new name to `properties.name` on double-click → type → Enter", () => {
		const onEdit = vi.fn();
		const c = mount(onEdit);
		const trigger = must(c.querySelector<HTMLButtonElement>(".dbv-grid__title-label--editable"));
		expect(trigger.textContent).toBe("Untitled");
		act(() => trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		const input = must(c.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		// Edit starts from the raw stored name (selected for overtype).
		expect(input.value).toBe("Untitled");
		input.value = "Acme Corp";
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onEdit).toHaveBeenCalledWith(obj, "name", "Acme Corp");
		// Returns to the read-only label after commit.
		expect(c.querySelector(".dbv-grid__title-input")).toBeNull();
	});

	it("commits on blur (click away)", () => {
		const onEdit = vi.fn();
		const c = mount(onEdit);
		const trigger = must(c.querySelector<HTMLButtonElement>(".dbv-grid__title-label--editable"));
		act(() => trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		const input = must(c.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		input.value = "Globex";
		// React maps `onBlur` to the delegated, bubbling `focusout` event.
		act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
		expect(onEdit).toHaveBeenCalledWith(obj, "name", "Globex");
	});

	it("discards the edit on Escape (no write, reverts to label)", () => {
		const onEdit = vi.fn();
		const c = mount(onEdit);
		const trigger = must(c.querySelector<HTMLButtonElement>(".dbv-grid__title-label--editable"));
		act(() => trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		const input = must(c.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		input.value = "Discarded";
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(onEdit).not.toHaveBeenCalled();
		expect(c.querySelector(".dbv-grid__title-input")).toBeNull();
	});

	it("does not write when the name is unchanged", () => {
		const onEdit = vi.fn();
		const c = mount(onEdit);
		const trigger = must(c.querySelector<HTMLButtonElement>(".dbv-grid__title-label--editable"));
		act(() => trigger.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		const input = must(c.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onEdit).not.toHaveBeenCalled();
	});
});

describe("EditableTitle — create/Rename keyboard handoff (F-215/F-216)", () => {
	// "+ New" used to leave focus on the toolbar button: everything typed
	// went nowhere and every Enter re-fired the button — another blank row
	// (a real session minted 13 Untitleds from two name-entry attempts).
	// The handoff: the host marks the new row's id pending; when its title
	// cell mounts, `autoEdit` opens the inline editor, focus moves OFF the
	// button INTO the input, and the consume callback clears the pending id
	// exactly once. Component-level for the same reason as the F-014 suite
	// above (the grid body virtualizes to zero height in jsdom).
	let root: Root | null = null;
	let container: HTMLDivElement | null = null;

	const fresh: EntityRow = {
		id: "obj_new",
		type: "brainstorm/Object/v1",
		properties: { name: "Untitled" },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};

	afterEach(() => {
		act(() => root?.unmount());
		root = null;
		container?.remove();
		container = null;
		document.body.innerHTML = "";
	});

	it("create → typing lands in the title editor → Enter commits exactly one name (no extra rows)", () => {
		// The toolbar "+ New" stand-in: focused, and counting activations —
		// the F-215 failure mode was Enter re-firing this exact button.
		const newButton = document.createElement("button");
		const mintRow = vi.fn();
		newButton.addEventListener("click", mintRow);
		document.body.append(newButton);
		newButton.focus();
		expect(document.activeElement).toBe(newButton);

		const onEdit = vi.fn();
		const onAutoEditHandled = vi.fn();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
			root?.render(
				<EditableTitle entity={fresh} onEdit={onEdit} autoEdit onAutoEditHandled={onAutoEditHandled} />,
			),
		);

		// The editor opened unprompted (no dblclick) and took the keyboard.
		const input = must(container.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		expect(document.activeElement).toBe(input);
		expect(onAutoEditHandled).toHaveBeenCalledTimes(1);

		// Typing replaces the selected "Untitled"; Enter commits the name.
		input.value = "Dana Okafor";
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onEdit).toHaveBeenCalledTimes(1);
		expect(onEdit).toHaveBeenCalledWith(fresh, "name", "Dana Okafor");
		// The button never re-fired — no blank-row flood.
		expect(mintRow).not.toHaveBeenCalled();
		expect(container.querySelector(".dbv-grid__title-input")).toBeNull();
	});

	it("a re-render without autoEdit does not reopen the editor (pending id consumed once)", () => {
		const onEdit = vi.fn();
		const onAutoEditHandled = vi.fn();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
			root?.render(
				<EditableTitle entity={fresh} onEdit={onEdit} autoEdit onAutoEditHandled={onAutoEditHandled} />,
			),
		);
		const input = must(container.querySelector<HTMLInputElement>(".dbv-grid__title-input"));
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		// The host cleared the pending id — the next paint passes autoEdit=false.
		act(() =>
			root?.render(
				<EditableTitle
					entity={fresh}
					onEdit={onEdit}
					autoEdit={false}
					onAutoEditHandled={onAutoEditHandled}
				/>,
			),
		);
		expect(container.querySelector(".dbv-grid__title-input")).toBeNull();
		expect(onAutoEditHandled).toHaveBeenCalledTimes(1);
	});
});

describe("GridView — pending title edit plumbing (F-215)", () => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		document.body.innerHTML = "";
	});

	it("accepts a pending id for a row outside the (jsdom zero-height) window without consuming it", () => {
		const onPendingTitleEditHandled = vi.fn();
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["status"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			pendingTitleEditId: "ent_1",
			onPendingTitleEditHandled,
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onReorderColumns: vi.fn(),
		});
		// jsdom's zero-height viewport never mounts the row, so the pending
		// edit stays pending — the host keeps re-passing it until a real
		// paint consumes it. The load-bearing assertion: an unmounted target
		// must NOT be reported handled (that would drop the handoff).
		expect(onPendingTitleEditHandled).not.toHaveBeenCalled();
	});
});

describe("OpenRecordButton — explicit inspector open (F-023)", () => {
	let root: Root | null = null;
	let container: HTMLDivElement | null = null;

	const obj: EntityRow = {
		id: "obj_open",
		type: "brainstorm/Object/v1",
		properties: { name: "Acme" },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};

	afterEach(() => {
		act(() => root?.unmount());
		root = null;
		container?.remove();
		container = null;
		document.body.innerHTML = "";
	});

	it("opens the inspector on click and stops propagation (never also selects the row)", () => {
		const onOpenInspector = vi.fn();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() => root?.render(<OpenRecordButton entity={obj} onOpenInspector={onOpenInspector} />));
		const btn = must(container.querySelector<HTMLButtonElement>(".dbv-grid__open"));
		// The F-023 fight was select+open coupled; the button must stop the
		// click from bubbling to the row's onClick (which selects).
		const event = new MouseEvent("click", { bubbles: true });
		const stop = vi.spyOn(event, "stopPropagation");
		act(() => btn.dispatchEvent(event));
		expect(onOpenInspector).toHaveBeenCalledWith(obj);
		expect(stop).toHaveBeenCalled();
	});
});

describe("GridView — column header label (F-017)", () => {
	let h: Harness | null = null;
	afterEach(() => {
		h?.cleanup();
		h = null;
		document.body.innerHTML = "";
		// Reset the global catalog resolver so it doesn't leak into other tests.
		installPropertyDefResolver(() => undefined);
	});

	const headLabels = (container: HTMLElement): string[] =>
		Array.from(container.querySelectorAll<HTMLElement>("[data-prop]")).map((el) =>
			(el.textContent ?? "").trim(),
		);

	it("shows a user-created property's display name, not its generated key", () => {
		// A property created via the inline form has a generated key but a real
		// display name in the catalog. The header must read the name.
		installPropertyDefResolver((id) =>
			id === "prop_mpx6xww2"
				? { key: "prop_mpx6xww2", name: "Status", icon: null, valueType: ValueType.Text }
				: undefined,
		);
		h = mountGrid({
			compiled: {
				rows: [{ ...ENTITY, properties: { title: "A", prop_mpx6xww2: "Lead" } }],
				groups: [],
			},
			columns: columns(["prop_mpx6xww2"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onEdit: vi.fn(),
		});
		expect(headLabels(h.container)).toEqual(["Status"]);
	});

	it("falls back to the humanized key when the catalog resolves no def", () => {
		installPropertyDefResolver(() => undefined);
		h = mountGrid({
			compiled: COMPILED,
			columns: columns(["due_date"]),
			layout: LAYOUT,
			selectedIds: new Set(),
			onSelect: () => {},
			onOpen: () => {},
			onOpenInspector: () => {},
			onEdit: vi.fn(),
		});
		expect(headLabels(h.container)).toEqual(["Due date"]);
	});
});
