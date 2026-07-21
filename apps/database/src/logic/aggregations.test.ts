import { PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	AggregationKind,
	AggregationUnit,
	aggregationsForValueType,
	computeAggregation,
	defaultAggregationFor,
	formatAggregation,
} from "./aggregations";

function val(kind: AggregationKind, values: readonly unknown[]): number | null {
	return computeAggregation(kind, values).value;
}

describe("aggregationsForValueType", () => {
	it("offers the universal count family for every type", () => {
		for (const vt of [ValueType.Text, ValueType.Number, ValueType.Date, ValueType.Boolean]) {
			const kinds = aggregationsForValueType(vt);
			expect(kinds[0]).toBe(AggregationKind.None);
			expect(kinds).toContain(AggregationKind.CountAll);
			expect(kinds).toContain(AggregationKind.CountValues);
			expect(kinds).toContain(AggregationKind.CountUnique);
		}
	});

	it("adds numeric aggregations only for Number", () => {
		expect(aggregationsForValueType(ValueType.Number)).toContain(AggregationKind.Sum);
		expect(aggregationsForValueType(ValueType.Text)).not.toContain(AggregationKind.Sum);
	});

	it("adds earliest/latest only for Date", () => {
		expect(aggregationsForValueType(ValueType.Date)).toContain(AggregationKind.Earliest);
		expect(aggregationsForValueType(ValueType.Number)).not.toContain(AggregationKind.Earliest);
	});

	it("adds checked aggregations only for Boolean", () => {
		expect(aggregationsForValueType(ValueType.Boolean)).toContain(AggregationKind.CheckedPercent);
		expect(aggregationsForValueType(ValueType.Text)).not.toContain(AggregationKind.CheckedPercent);
	});
});

describe("count aggregations", () => {
	const rows = [1, "", "x", null, undefined, [], "x"];

	it("CountAll counts every row including empties", () => {
		expect(val(AggregationKind.CountAll, rows)).toBe(7);
	});

	it("CountValues counts non-empty cells (empty string / null / [] excluded)", () => {
		expect(val(AggregationKind.CountValues, rows)).toBe(3);
	});

	it("CountEmpty counts the empty cells", () => {
		expect(val(AggregationKind.CountEmpty, rows)).toBe(4);
	});

	it("CountUnique de-dupes non-empty values", () => {
		expect(val(AggregationKind.CountUnique, rows)).toBe(2); // 1, "x"
	});

	it("None always yields null", () => {
		expect(val(AggregationKind.None, rows)).toBeNull();
	});
});

describe("numeric aggregations", () => {
	const nums = [10, 20, 30, "40", "n/a", null];

	it("Sum adds numeric cells, parsing numeric strings", () => {
		expect(val(AggregationKind.Sum, nums)).toBe(100);
	});

	it("Average divides by the numeric-cell count, not row count", () => {
		expect(val(AggregationKind.Average, nums)).toBe(25);
	});

	it("Min / Max ignore non-numeric cells", () => {
		expect(val(AggregationKind.Min, nums)).toBe(10);
		expect(val(AggregationKind.Max, nums)).toBe(40);
	});

	it("Range is max minus min", () => {
		expect(val(AggregationKind.Range, nums)).toBe(30);
	});

	it("Median handles odd and even counts", () => {
		expect(val(AggregationKind.Median, [3, 1, 2])).toBe(2);
		expect(val(AggregationKind.Median, [1, 2, 3, 4])).toBe(2.5);
	});

	it("returns null over a column with no numeric cells", () => {
		expect(val(AggregationKind.Sum, ["a", null, ""])).toBeNull();
		expect(val(AggregationKind.Min, [])).toBeNull();
	});

	it("does not coerce booleans into the numeric set", () => {
		expect(val(AggregationKind.Sum, [true, true, 5])).toBe(5);
	});
});

describe("boolean aggregations", () => {
	const flags = [true, false, true, "true", "false", null];

	it("CheckedCount counts truthy booleans + 'true' strings", () => {
		expect(val(AggregationKind.CheckedCount, flags)).toBe(3);
	});

	it("CheckedPercent is checked / total rows as a 0–1 ratio", () => {
		const r = computeAggregation(AggregationKind.CheckedPercent, flags);
		expect(r.value).toBeCloseTo(3 / 6);
		expect(r.unit).toBe(AggregationUnit.Ratio);
	});

	it("CheckedPercent is null over no rows", () => {
		expect(val(AggregationKind.CheckedPercent, [])).toBeNull();
	});
});

describe("formatAggregation", () => {
	it("renders None and null as an em-dash", () => {
		expect(
			formatAggregation({ kind: AggregationKind.None, value: null, unit: AggregationUnit.Count }),
		).toBe("—");
		expect(
			formatAggregation({ kind: AggregationKind.Sum, value: null, unit: AggregationUnit.Number }),
		).toBe("—");
	});

	it("formats counts / numbers with up to 2 fraction digits", () => {
		expect(
			formatAggregation({
				kind: AggregationKind.Average,
				value: 25.125,
				unit: AggregationUnit.Number,
			}),
		).toBe("25.13");
	});

	it("formats ratios as a percent", () => {
		expect(
			formatAggregation({
				kind: AggregationKind.CheckedPercent,
				value: 0.5,
				unit: AggregationUnit.Ratio,
			}),
		).toBe("50%");
	});

	it("formats timestamps as a medium date", () => {
		const out = formatAggregation({
			kind: AggregationKind.Earliest,
			value: Date.parse("2022-06-15T00:00:00Z"),
			unit: AggregationUnit.Timestamp,
		});
		expect(out).toMatch(/2022/);
	});

	it("renders a value-unit aggregation in the column's currency (F-029)", () => {
		const def = {
			key: "prop_deal",
			name: "Deal size",
			icon: null,
			valueType: ValueType.Number,
			format: PropertyFormat.Currency,
			currency: "USD",
		};
		const out = formatAggregation(
			{ kind: AggregationKind.Sum, value: 85000, unit: AggregationUnit.Number },
			def,
		);
		expect(out).toMatch(/\$|US\$/);
		expect(out).toMatch(/85,000/);
	});

	it("renders a percent-formatted column's aggregation as a percent", () => {
		const def = {
			key: "prop_margin",
			name: "Margin",
			icon: null,
			valueType: ValueType.Number,
			format: PropertyFormat.Percent,
		};
		expect(
			formatAggregation(
				{ kind: AggregationKind.Average, value: 0.25, unit: AggregationUnit.Number },
				def,
			),
		).toBe("25%");
	});

	it("renders a duration-formatted column's sum as hours (DT-3)", () => {
		const def = {
			key: "prop_hours",
			name: "Hours",
			icon: null,
			valueType: ValueType.Number,
			format: PropertyFormat.Duration,
		};
		// Total hours across an engagement's deliverables reads "40h 30m",
		// not a bare "40.5".
		expect(
			formatAggregation({ kind: AggregationKind.Sum, value: 40.5, unit: AggregationUnit.Number }, def),
		).toBe("40h 30m");
	});

	it("leaves a count-unit aggregation plain even with a currency def", () => {
		const def = {
			key: "prop_deal",
			name: "Deal size",
			icon: null,
			valueType: ValueType.Number,
			format: PropertyFormat.Currency,
			currency: "USD",
		};
		expect(
			formatAggregation(
				{ kind: AggregationKind.CountValues, value: 3, unit: AggregationUnit.Count },
				def,
			),
		).toBe("3");
	});
});

describe("defaultAggregationFor", () => {
	it("defaults numbers to Sum and everything else to CountValues", () => {
		expect(defaultAggregationFor(ValueType.Number)).toBe(AggregationKind.Sum);
		expect(defaultAggregationFor(ValueType.Text)).toBe(AggregationKind.CountValues);
		expect(defaultAggregationFor(ValueType.Date)).toBe(AggregationKind.CountValues);
	});
});

describe("date aggregations", () => {
	const t2020 = Date.parse("2020-01-01");
	const t2022 = Date.parse("2022-06-15");
	const dates = ["2022-06-15", "2020-01-01", t2022, "not-a-date", null];

	it("Earliest is the min timestamp across ISO strings + ms numbers", () => {
		const r = computeAggregation(AggregationKind.Earliest, dates);
		expect(r.value).toBe(t2020);
		expect(r.unit).toBe(AggregationUnit.Timestamp);
	});

	it("Latest is the max timestamp", () => {
		expect(val(AggregationKind.Latest, dates)).toBe(t2022);
	});

	it("ignores non-date numbers (a small int isn't a timestamp)", () => {
		expect(val(AggregationKind.Earliest, [5, 10, "not"])).toBeNull();
	});
});
