// @vitest-environment jsdom
/**
 * Gallery card in-place editing (9.12.23). The gallery body virtualizes
 * (zero-height in jsdom, so cards don't mount), so the editable field list is
 * exercised through `CardFields` directly — the same node a card mounts when
 * the view is given an `onEdit`. The editing interaction itself reuses the
 * shared `EditableCell` (covered by the grid's real-shell cell-editing spec).
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { type ReactElement, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityRow } from "../logic/in-memory-entities";
import type { ColumnSpec } from "../types/list-view";
import { CardFields } from "./card-fields";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("Expected a value");
	return value;
}

const ENTITY: EntityRow = {
	id: "ent_1",
	type: "brainstorm/Object/v1",
	properties: { status: "todo", score: 5 },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
};

const def = (key: string, name: string, valueType: ValueType): PropertyDef => ({
	key,
	name,
	icon: null,
	valueType,
});

const COLUMNS: ColumnSpec[] = [
	{ propertyId: "status", width: 160, visible: true },
	{ propertyId: "score", width: 160, visible: true },
];
const DEFS = new Map<string, PropertyDef | null>([
	["status", def("status", "Status", ValueType.Text)],
	["score", def("score", "Score", ValueType.Number)],
]);

describe("CardFields — gallery card editing (9.12.23)", () => {
	let root: Root | null = null;
	let container: HTMLDivElement | null = null;

	afterEach(() => {
		act(() => root?.unmount());
		root = null;
		container?.remove();
		container = null;
		document.body.innerHTML = "";
	});

	function mount(onEdit = vi.fn()): { container: HTMLDivElement; onEdit: ReturnType<typeof vi.fn> } {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
			root?.render(<CardFields entity={ENTITY} columns={COLUMNS} columnDefs={DEFS} onEdit={onEdit} />),
		);
		return { container, onEdit };
	}

	it("renders one labeled, editable field per visible column", () => {
		const { container: c } = mount();
		const fields = c.querySelectorAll(".dbv-card__field");
		expect(fields.length).toBe(2);
		const labels = Array.from(c.querySelectorAll(".dbv-card__field-label")).map(
			(el) => el.textContent,
		);
		expect(labels).toEqual(["Status", "Score"]);
		// Each field hosts a shared editing cell (not the read-only DOM paint).
		const values = Array.from(c.querySelectorAll(".dbv-card__field-value"));
		expect(values.length).toBe(2);
		expect(values.every((v) => v.querySelector('[class*="bs-cell"]') !== null)).toBe(true);
	});

	it("shields the card: a click inside the fields does not bubble to a parent handler", () => {
		// Mount inside a React parent whose onClick would (without the shield)
		// fire the card's select — the field list's onClick={stop} prevents it.
		const parentClick = vi.fn();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		const tree: ReactElement = createElement(
			"div",
			{ onClick: parentClick, className: "card-stub" },
			createElement(CardFields, {
				entity: ENTITY,
				columns: COLUMNS,
				columnDefs: DEFS,
				onEdit: vi.fn(),
			}),
		);
		act(() => root?.render(tree));
		const fields = must(container.querySelector<HTMLElement>(".dbv-card__fields"));
		act(() => fields.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(parentClick).not.toHaveBeenCalled();
	});
});
