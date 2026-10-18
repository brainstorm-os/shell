import { describe, expect, it } from "vitest";
import { ChartType } from "../types/list-view";
import { AggregationKind } from "./aggregations";
import {
	CHART_OTHER_KEY,
	CHART_SLOT_ORDER,
	buildChartModel,
	chartAggregationKind,
	niceScale,
	pieArcs,
} from "./chart-data";
import type { CompiledView } from "./compile-view";
import type { EntityRow } from "./in-memory-entities";

function row(id: string, amount: number): EntityRow {
	return { id, type: "t", properties: { amount }, createdAt: 0, updatedAt: 0, deletedAt: null };
}

const LABELS = { empty: "No value", other: "Other", all: "All" };

function grouped(sizes: number[]): CompiledView {
	const rows: EntityRow[] = [];
	const groups = sizes.map((n, g) => {
		const bucket = Array.from({ length: n }, (_, i) => row(`${g}-${i}`, 10));
		rows.push(...bucket);
		return {
			key: g === 0 ? null : `g${g}`,
			label: g === 0 ? "Uncategorized" : `G${g}`,
			rows: bucket,
		};
	});
	return { rows, groups };
}

describe("buildChartModel (9.12.30)", () => {
	it("counts rows per group and labels the empty group", () => {
		const model = buildChartModel(grouped([1, 2, 3]), ChartType.Bar, "countAll", null, LABELS);
		expect(model.kind).toBe(AggregationKind.CountAll);
		expect(model.data.map((d) => [d.label, d.value])).toEqual([
			["No value", 1],
			["G1", 2],
			["G2", 3],
		]);
		expect(model.total.value).toBe(6);
		expect(model.data.every((d) => d.color === null)).toBe(true);
	});

	it("sums a numeric property", () => {
		const model = buildChartModel(grouped([0, 2]), ChartType.Bar, "sum", "amount", LABELS);
		expect(model.data[1]?.value).toBe(20);
		expect(model.total.value).toBe(20);
	});

	it("an ungrouped view is one 'All' datum; the Number form reads the total", () => {
		const compiled: CompiledView = { rows: [row("a", 1), row("b", 2)], groups: [] };
		const model = buildChartModel(compiled, ChartType.Number, "average", "amount", LABELS);
		expect(model.data).toHaveLength(1);
		expect(model.total.value).toBe(1.5);
	});

	it("pie slices take categorical slots in fixed order and fold the rest into Other", () => {
		const model = buildChartModel(
			grouped([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
			ChartType.Pie,
			"countAll",
			null,
			LABELS,
		);
		expect(model.data).toHaveLength(CHART_SLOT_ORDER.length);
		expect(model.data[0]?.color).toBe(`var(--color-graph-subject-${CHART_SLOT_ORDER[0]})`);
		const other = model.data.at(-1);
		expect(other?.key).toBe(CHART_OTHER_KEY);
		expect(other?.value).toBe(3);
	});

	it("falls back to a row count without a measured property", () => {
		expect(chartAggregationKind("sum", null)).toBe(AggregationKind.CountAll);
		expect(chartAggregationKind("earliest", "amount")).toBe(AggregationKind.CountAll);
		expect(chartAggregationKind("max", "amount")).toBe(AggregationKind.Max);
	});
});

describe("chart geometry", () => {
	it("rounds the axis to a 1/2/5 step", () => {
		expect(niceScale(87)).toEqual({ max: 100, step: 50 });
		expect(niceScale(0)).toEqual({ max: 1, step: 1 });
		expect(niceScale(7).max).toBeGreaterThanOrEqual(7);
	});

	it("splits a full turn proportionally, skipping empty values", () => {
		const arcs = pieArcs([1, null, 3]);
		expect(arcs[1]?.end).toBe(arcs[1]?.start);
		expect(arcs[2]?.end).toBeCloseTo(Math.PI * 2);
		expect(arcs[0]?.end).toBeCloseTo(Math.PI / 2);
	});
});
