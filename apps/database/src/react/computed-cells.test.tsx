// @vitest-environment jsdom
/**
 * Computed-column cells (9.12.17 / DT-4) — the shared read-only rollup /
 * formula cells every surface mounts (grid cells + board/gallery/list cards).
 * The card views virtualize (zero-height in jsdom, cards don't mount), so the
 * card face is exercised through `CardFields` directly — the same node a card
 * mounts — with the rollup lookups supplied via `ComputedCellsProvider`,
 * exactly as each view provides them.
 */

import { PropertyFormat, ValueType } from "@brainstorm/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityRow } from "../logic/in-memory-entities";
import type { ColumnSpec } from "../types/list-view";
import { CardFields } from "./card-fields";
import {
	ComputedCellsProvider,
	FormulaCell,
	RollupCell,
	type RollupLookups,
	cardChips,
} from "./computed-cells";

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) {
		throw new Error("Expected value to be present");
	}
	return value;
}

const deliverable = (id: string, fee: number): EntityRow => ({
	id,
	type: "Deliverable",
	properties: { fee },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

const byId = new Map([deliverable("d_1", 1000), deliverable("d_2", 2500)].map((d) => [d.id, d]));

const engagement: EntityRow = {
	id: "eng_1",
	type: "Engagement",
	properties: { title: "Acme", deliverables: [{ value: "d_1" }, { value: "d_2" }] },
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
};

const ROLLUP_COLUMN: ColumnSpec = {
	propertyId: "rollup:deliverables:fee:sum",
	visible: true,
	rollup: {
		relationKey: "deliverables",
		targetPropertyKey: "fee",
		aggregation: "sum",
		name: "Total fee",
	},
};

const FORMULA_COLUMN: ColumnSpec = {
	propertyId: "formula:{hours} * {rate}",
	visible: true,
	formula: { expression: "{hours} * {rate}", name: "Billed" },
};

const LOOKUPS: RollupLookups = {
	byId,
	targetDefs: new Map([
		[
			ROLLUP_COLUMN.propertyId,
			{
				key: "fee",
				name: "Fee",
				icon: null,
				valueType: ValueType.Number,
				format: PropertyFormat.Currency,
				currency: "USD",
			},
		],
	]),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.innerHTML = "";
});

function mount(node: React.ReactElement): HTMLDivElement {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root?.render(node));
	return container;
}

describe("RollupCell — read-only computed aggregate (9.12.17)", () => {
	it("walks the relation and renders the summed target value", () => {
		const c = mount(
			<RollupCell
				rollup={must(ROLLUP_COLUMN.rollup)}
				entity={engagement}
				byId={byId}
				targetDef={null}
			/>,
		);
		const expected = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(3500);
		const cell = must(c.querySelector<HTMLElement>(".dbv-computed__value"));
		expect(cell.textContent).toBe(expected);
	});

	it("formats in the target property's units when a def is supplied (currency)", () => {
		const c = mount(
			<RollupCell
				rollup={must(ROLLUP_COLUMN.rollup)}
				entity={engagement}
				byId={byId}
				targetDef={must(LOOKUPS.targetDefs.get(ROLLUP_COLUMN.propertyId))}
			/>,
		);
		const cell = must(c.querySelector<HTMLElement>(".dbv-computed__value"));
		expect(cell.textContent).toContain("3,500");
		expect(cell.textContent).toContain("$");
	});
});

describe("FormulaCell — read-only computed expression (9.12.17)", () => {
	it("evaluates the expression against the row's properties", () => {
		const row: EntityRow = {
			id: "r1",
			type: "Engagement",
			properties: { hours: 10, rate: 150 },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		const c = mount(<FormulaCell formula={must(FORMULA_COLUMN.formula)} entity={row} />);
		const cell = must(c.querySelector<HTMLElement>(".dbv-computed__value"));
		expect(cell.textContent).toBe((1500).toLocaleString());
	});

	it("renders an error chip with the message as tooltip when evaluation fails", () => {
		const row: EntityRow = {
			id: "r1",
			type: "Engagement",
			properties: { hours: "n/a" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		const c = mount(<FormulaCell formula={must(FORMULA_COLUMN.formula)} entity={row} />);
		const chip = must(c.querySelector<HTMLElement>(".dbv-computed__error"));
		expect(chip.textContent).toBe("⚠");
		expect(chip.getAttribute("title")).toBeTruthy();
		expect(c.querySelector(".dbv-computed__value")).toBeNull();
	});
});

describe("CardFields — computed columns on cards (DT-4 rollup UI)", () => {
	const STATUS_COLUMN: ColumnSpec = { propertyId: "status", width: 160, visible: true };

	function mountFields(lookups: RollupLookups | null): {
		c: HTMLDivElement;
		onEdit: ReturnType<typeof vi.fn>;
	} {
		const onEdit = vi.fn();
		const fields = (
			<CardFields
				entity={engagement}
				columns={[STATUS_COLUMN, ROLLUP_COLUMN, FORMULA_COLUMN]}
				columnDefs={
					new Map([
						["status", null],
						[ROLLUP_COLUMN.propertyId, null],
						[FORMULA_COLUMN.propertyId, null],
					])
				}
				onEdit={onEdit}
			/>
		);
		const c = mount(
			lookups ? <ComputedCellsProvider value={lookups}>{fields}</ComputedCellsProvider> : fields,
		);
		return { c, onEdit };
	}

	it("renders a labeled read-only rollup field: the column's own name + the computed value", () => {
		const { c } = mountFields(LOOKUPS);
		const field = must(c.querySelector<HTMLElement>('[data-computed="true"]'));
		expect(must(field.querySelector(".dbv-card__field-label")).textContent).toBe("Total fee");
		const value = must(field.querySelector<HTMLElement>(".dbv-computed__value"));
		expect(value.textContent).toContain("3,500");
		expect(value.textContent).toContain("$");
		// Read-only: no editable cell mounts inside a computed field.
		expect(field.querySelector("input, button, [contenteditable]")).toBeNull();
	});

	it("renders the formula field labeled by the formula's name", () => {
		const { c } = mountFields(LOOKUPS);
		const labels = Array.from(c.querySelectorAll('[data-computed="true"] .dbv-card__field-label'));
		expect(labels.map((el) => el.textContent)).toEqual(["Total fee", "Billed"]);
	});

	it("degrades to an empty aggregate outside a provider (no crash, no editor)", () => {
		const { c } = mountFields(null);
		const field = must(c.querySelector<HTMLElement>('[data-computed="true"]'));
		// Empty lookups: every link dangles, so the rollup reads as an empty
		// aggregation — but the field still mounts read-only.
		expect(field.querySelector(".dbv-computed__value")).not.toBeNull();
		expect(field.querySelector("input, button, [contenteditable]")).toBeNull();
	});
});

describe("cardChips — read-only chip strip with computed columns", () => {
	it("computes a rollup chip and skips the title column", () => {
		const chips = cardChips(
			engagement,
			[
				{ propertyId: "title", visible: true },
				ROLLUP_COLUMN,
				{ propertyId: "missing", visible: true },
			],
			LOOKUPS,
		);
		expect(chips.map((chip) => chip.id)).toEqual([ROLLUP_COLUMN.propertyId]);
		expect(must(chips[0]).text).toContain("3,500");
	});

	it("drops a formula chip whose evaluation errors", () => {
		const chips = cardChips(engagement, [FORMULA_COLUMN], LOOKUPS);
		expect(chips).toEqual([]);
	});

	it("evaluates a formula chip against the row", () => {
		const row: EntityRow = {
			id: "r1",
			type: "Engagement",
			properties: { hours: 2, rate: 100 },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		const chips = cardChips(row, [FORMULA_COLUMN], LOOKUPS);
		expect(chips.map((chip) => chip.text)).toEqual([(200).toLocaleString()]);
	});
});
