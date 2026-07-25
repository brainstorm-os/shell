// @vitest-environment jsdom
/**
 * `<LayoutView>` (Stage 8.3) — the render pipeline over `Layout/v1`.
 *
 * The two contracts worth pinning here are the ones a screenshot would
 * not catch: **DOM order is reading order** (so `Tab` and a screen
 * reader follow doc 27's accessibility contract even when CSS moves
 * cells elsewhere), and **one property cell = one subscription** (so a
 * write repaints one cell, not the layout).
 */

import {
	type LayoutCell,
	LayoutCellKind,
	type LayoutDef,
	LayoutMode,
	type PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { EntityRow } from "../in-memory-entities";
import { LayoutView } from "./LayoutView";
import { createLayoutValueSource, staticLayoutValueSource } from "./value-source";

const DEFS: Record<string, PropertyDef> = {
	name: { key: "name", name: "Name", icon: null, valueType: ValueType.Text },
	email: { key: "email", name: "Email", icon: null, valueType: ValueType.Text },
	phone: { key: "phone", name: "Phone", icon: null, valueType: ValueType.Text },
};
const propertyDef = (key: string): PropertyDef | undefined => DEFS[key];

const entity: EntityRow = {
	id: "ent_1",
	type: "io.example/Person/v1",
	properties: { kind: "person" },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
};

const prop = (id: string, property: string, extra: Partial<LayoutCell> = {}): LayoutCell =>
	({ id, kind: LayoutCellKind.Property, property, ...extra }) as LayoutCell;

const def = (partial: Partial<LayoutDef>): LayoutDef => ({
	mode: LayoutMode.Stacked,
	scope: { kind: "type", target: "io.example/Person/v1" },
	context: null,
	cells: [],
	...partial,
});

type Harness = { container: HTMLDivElement; root: Root; cleanup: () => void };

function mount(): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		container,
		root,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const cellIds = (container: HTMLElement): (string | null)[] =>
	Array.from(container.querySelectorAll("[data-cell-id]")).map((el) =>
		el.getAttribute("data-cell-id"),
	);

describe("<LayoutView>", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = mount();
	});
	afterEach(() => harness.cleanup());

	function render(layout: LayoutDef, extra: Record<string, unknown> = {}): void {
		act(() => {
			harness.root.render(
				<LayoutView
					layout={layout}
					entity={entity}
					propertyDef={propertyDef}
					values={staticLayoutValueSource({ name: "Ada" })}
					{...extra}
				/>,
			);
		});
	}

	it("renders one element per cell, tagged with its id", () => {
		render(def({ cells: [prop("a", "name"), prop("b", "email")] }));
		expect(cellIds(harness.container)).toEqual(["a", "b"]);
	});

	it("puts the container's mode on the root for CSS + assertions", () => {
		render(def({ mode: LayoutMode.Grid, cells: [prop("a", "name")] }));
		expect(harness.container.querySelector(".bs-layout")?.getAttribute("data-layout-mode")).toBe(
			"grid",
		);
	});

	it("DOM order follows readingOrder, not the cells array", () => {
		render(
			def({
				cells: [prop("a", "name"), prop("b", "email"), prop("c", "phone")],
				readingOrder: ["c", "a", "b"],
			}),
		);
		expect(cellIds(harness.container)).toEqual(["c", "a", "b"]);
	});

	it("grid places cells by col/row while DOM order stays row-major", () => {
		render(
			def({
				mode: LayoutMode.Grid,
				cells: [
					prop("bottom", "phone", { grid: { col: 1, row: 2 } }),
					prop("top", "name", { grid: { col: 1, row: 1 } }),
				],
			}),
		);
		expect(cellIds(harness.container)).toEqual(["top", "bottom"]);
		const bottom = harness.container.querySelector<HTMLElement>('[data-cell-id="bottom"]');
		expect(bottom?.style.gridRow).toBe("2");
	});

	it("freeform positions absolutely and sizes the canvas to its content", () => {
		render(
			def({
				mode: LayoutMode.Freeform,
				cells: [prop("a", "name", { freeform: { x: 20, y: 30, width: 100, height: 40 } })],
				readingOrder: ["a"],
			}),
		);
		const cell = harness.container.querySelector<HTMLElement>('[data-cell-id="a"]');
		expect(cell?.style.position).toBe("absolute");
		expect(cell?.style.left).toBe("20px");
		const root = harness.container.querySelector<HTMLElement>(".bs-layout--freeform");
		expect(root?.style.width).toBe("120px");
		expect(root?.style.height).toBe("70px");
	});

	it("omits a cell whose condition fails", () => {
		render(
			def({
				cells: [prop("a", "name"), prop("b", "phone", { condition: { $eq: { kind: "company" } } })],
			}),
		);
		expect(cellIds(harness.container)).toEqual(["a"]);
	});

	it("renders a group's children inside it, under the group's own mode", () => {
		render(
			def({
				cells: [
					{
						id: "g",
						kind: LayoutCellKind.Group,
						label: "Contact",
						mode: LayoutMode.Grid,
						cells: [prop("g1", "email"), prop("g2", "phone")],
					} as LayoutCell,
				],
			}),
		);
		const group = harness.container.querySelector<HTMLElement>('[data-cell-id="g"]');
		expect(group?.querySelector(".bs-layout--grid")).not.toBeNull();
		expect(group?.querySelectorAll("[data-cell-id]").length).toBe(2);
		expect(harness.container.querySelector(".bs-layout__group-label")?.textContent).toBe("Contact");
	});

	it("renders text and divider cells", () => {
		render(
			def({
				cells: [
					{ id: "t", kind: LayoutCellKind.Text, text: "Hello" } as LayoutCell,
					{ id: "d", kind: LayoutCellKind.Divider } as LayoutCell,
				],
			}),
		);
		expect(harness.container.querySelector(".bs-layout__text")?.textContent).toBe("Hello");
		expect(harness.container.querySelector(".bs-layout__divider")).not.toBeNull();
	});

	it("resolves a text cell's textKey through the host's t()", () => {
		render(
			def({ cells: [{ id: "t", kind: LayoutCellKind.Text, textKey: "greeting" } as LayoutCell] }),
			{ seams: { t: (key: string) => (key === "greeting" ? "Bonjour" : key) } },
		);
		expect(harness.container.querySelector(".bs-layout__text")?.textContent).toBe("Bonjour");
	});

	it("routes block + chrome cells to the host seams", () => {
		const renderBlock = vi.fn(() => <span data-testid="block">block!</span>);
		const renderChrome = vi.fn(() => <span data-testid="chrome">chrome!</span>);
		render(
			def({
				cells: [
					{ id: "b", kind: LayoutCellKind.Block, block: "io.example/recent" } as LayoutCell,
					{ id: "c", kind: LayoutCellKind.Chrome, chrome: "actionBar" } as LayoutCell,
				],
			}),
			{ seams: { renderBlock, renderChrome } },
		);
		expect(renderBlock).toHaveBeenCalledOnce();
		expect(renderChrome).toHaveBeenCalledOnce();
		expect(harness.container.querySelector('[data-testid="block"]')).not.toBeNull();
		expect(harness.container.querySelector('[data-testid="chrome"]')).not.toBeNull();
	});

	it("a seam cell with no host renderer shows a visible placeholder, never nothing", () => {
		render(
			def({
				cells: [{ id: "c", kind: LayoutCellKind.Chrome, chrome: "actionBar" } as LayoutCell],
			}),
		);
		const placeholder = harness.container.querySelector('[data-placeholder="chrome"]');
		expect(placeholder?.textContent).toContain("actionBar");
	});

	it("a cell's display override wins over the property's own default view", () => {
		// `checkbox` is the Boolean default; the cell asks for a toggle instead.
		render(
			def({
				cells: [prop("a", "flag", { display: { view: PropertyView.Toggle } })],
			}),
			{
				propertyDef: (key: string) =>
					key === "flag"
						? { key: "flag", name: "Flag", icon: null, valueType: ValueType.Boolean }
						: undefined,
			},
		);
		const cell = harness.container.querySelector('[data-cell-id="a"]');
		expect(cell?.querySelector("[data-placeholder]")).toBeNull();
		expect(cell?.innerHTML).toContain("toggle");
	});

	it("a property with no schema shows a placeholder instead of throwing", () => {
		render(def({ cells: [prop("a", "not-a-property")] }));
		expect(harness.container.querySelector('[data-placeholder="property"]')?.textContent).toBe(
			"not-a-property",
		);
	});
});

describe("<LayoutView> per-cell subscriptions", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = mount();
	});
	afterEach(() => harness.cleanup());

	it("subscribes once per property cell — to its own key only", () => {
		const source = createLayoutValueSource({ name: "Ada", email: "a@b.c" });
		const subscribed: string[] = [];
		const spy = {
			get: source.get,
			subscribe: (property: string, cb: () => void) => {
				subscribed.push(property);
				return source.subscribe(property, cb);
			},
		};
		act(() => {
			harness.root.render(
				<LayoutView
					layout={def({ cells: [prop("a", "name"), prop("b", "email")] })}
					entity={entity}
					propertyDef={propertyDef}
					values={spy}
				/>,
			);
		});
		expect([...subscribed].sort()).toEqual(["email", "name"]);
	});

	it("a write to one property notifies only that cell's listener", () => {
		const source = createLayoutValueSource({ name: "Ada", email: "a@b.c" });
		const notifies: Record<string, number> = { name: 0, email: 0 };
		const spy = {
			get: source.get,
			subscribe: (property: string, cb: () => void) =>
				source.subscribe(property, () => {
					notifies[property] = (notifies[property] ?? 0) + 1;
					cb();
				}),
		};
		act(() => {
			harness.root.render(
				<LayoutView
					layout={def({ cells: [prop("a", "name"), prop("b", "email")] })}
					entity={entity}
					propertyDef={propertyDef}
					values={spy}
				/>,
			);
		});

		act(() => source.set("name", "Grace"));

		expect(notifies.name).toBe(1);
		expect(notifies.email).toBe(0);
	});

	it("a property cell shows the source's value, and repaints when it changes", () => {
		const source = createLayoutValueSource({ name: "Ada" });
		act(() => {
			harness.root.render(
				<LayoutView
					layout={def({ cells: [prop("a", "name")] })}
					entity={entity}
					propertyDef={propertyDef}
					values={source}
					readOnly
				/>,
			);
		});
		const cell = harness.container.querySelector('[data-cell-id="a"]');
		expect(cell?.textContent).toContain("Ada");

		act(() => source.set("name", "Grace"));

		expect(cell?.textContent).toContain("Grace");
	});
});
