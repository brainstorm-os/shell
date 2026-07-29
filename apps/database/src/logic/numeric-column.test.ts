import {
	type ColumnSpec,
	type PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { AggregationKind } from "./aggregations";
import { isNumericColumn } from "./numeric-column";

function def(partial: Partial<PropertyDef>): PropertyDef {
	return { key: "prop_x", name: "X", icon: null, valueType: ValueType.Text, ...partial };
}

function col(partial: Partial<ColumnSpec>): ColumnSpec {
	return { propertyId: "prop_x", visible: true, ...partial };
}

describe("isNumericColumn", () => {
	it("right-aligns a plain Number column", () => {
		expect(isNumericColumn(col({}), def({ valueType: ValueType.Number }))).toBe(true);
	});

	it("right-aligns formatted Number columns (currency et al. keep Number valueType)", () => {
		expect(
			isNumericColumn(
				col({}),
				def({ valueType: ValueType.Number, display: { view: PropertyView.Pill } }),
			),
		).toBe(true);
	});

	it("keeps Text / Date / Boolean columns left-aligned", () => {
		expect(isNumericColumn(col({}), def({ valueType: ValueType.Text }))).toBe(false);
		expect(isNumericColumn(col({}), def({ valueType: ValueType.Date }))).toBe(false);
		expect(isNumericColumn(col({}), def({ valueType: ValueType.Boolean }))).toBe(false);
	});

	it("keeps graphical Number views (ProgressBar / Rating) left-aligned", () => {
		for (const view of [PropertyView.ProgressBar, PropertyView.Rating]) {
			expect(isNumericColumn(col({}), def({ valueType: ValueType.Number, display: { view } }))).toBe(
				false,
			);
		}
	});

	it("keeps a def-less column left-aligned", () => {
		expect(isNumericColumn(col({}), null)).toBe(false);
	});

	it("treats formula columns as numeric", () => {
		expect(isNumericColumn(col({ formula: { name: "Total", expression: "{a} + {b}" } }), null)).toBe(
			true,
		);
	});

	it("treats numeric-aggregation rollups as numeric, date rollups as not", () => {
		const rollup = (aggregation: string) =>
			col({
				rollup: { relationKey: "rel", targetPropertyKey: "amount", aggregation, name: "R" },
			});
		expect(isNumericColumn(rollup(AggregationKind.Sum), null)).toBe(true);
		expect(isNumericColumn(rollup(AggregationKind.CountValues), null)).toBe(true);
		expect(isNumericColumn(rollup(AggregationKind.Earliest), null)).toBe(false);
		expect(isNumericColumn(rollup(AggregationKind.Latest), null)).toBe(false);
		expect(isNumericColumn(rollup(AggregationKind.None), null)).toBe(false);
	});
});
