/**
 * Chart view data (9.12.30): the compiled view's group-by buckets reduced by
 * the shared aggregation engine into one value per category. Pure, so the
 * bar / line / pie / number renderers and the dashboard widget read one
 * tested shape.
 *
 * Colour (dataviz rule — identity follows the entity, fixed order, never
 * cycled): a pie gives each category a slot of the theme's categorical
 * palette in `CHART_SLOT_ORDER`, and anything past the last slot folds into
 * one "Other" slice rather than a generated hue. Bars and lines are a single
 * series, so they wear one hue.
 */

import { ChartType } from "../types/list-view";
import { AggregationKind, type AggregationResult, computeAggregation } from "./aggregations";
import type { CompiledView } from "./compile-view";
import { type EntityRow, readPropertyPath } from "./in-memory-entities";

/** The theme's categorical slots (`--color-graph-subject-N`) in an order whose
 *  ADJACENT pairs stay distinguishable under protan / deutan simulation
 *  (ΔE ≥ 11) and normal vision (ΔE ≥ 27) in the light and dark themes —
 *  validated with the dataviz palette checker. The raw subject order puts
 *  violet beside blue (ΔE 0.4 deutan), so it is never used as-is. */
export const CHART_SLOT_ORDER: readonly number[] = [3, 1, 4, 6, 5, 2, 8, 7];

export const CHART_OTHER_KEY = "\u0000other";

export type ChartDatum = {
	/** Group wire key (`""` for the empty group, `CHART_OTHER_KEY` for the
	 *  folded remainder). */
	key: string;
	label: string;
	value: number | null;
	count: number;
	/** CSS colour for a categorical mark (pie); `null` → the single-series hue. */
	color: string | null;
};

export type ChartModel = {
	kind: AggregationKind;
	data: ChartDatum[];
	total: AggregationResult;
};

export function chartSlotColor(index: number): string | null {
	const slot = CHART_SLOT_ORDER[index];
	return slot === undefined ? null : `var(--color-graph-subject-${slot})`;
}

export const CHART_SERIES_COLOR = chartSlotColor(0) as string;
export const CHART_OTHER_COLOR = "var(--text-faint)";

function reduce(
	kind: AggregationKind,
	rows: ReadonlyArray<EntityRow>,
	valueProperty: string | null,
): AggregationResult {
	if (kind === AggregationKind.CountAll || !valueProperty) {
		return computeAggregation(AggregationKind.CountAll, rows);
	}
	return computeAggregation(
		kind,
		rows.map((r) => readPropertyPath(r, valueProperty)),
	);
}

/** The aggregations a chart can plot — a row count, or a numeric reduction of
 *  a property (dates / checkbox ratios read poorly as bar lengths). */
export const CHART_AGGREGATIONS: readonly AggregationKind[] = [
	AggregationKind.CountAll,
	AggregationKind.Sum,
	AggregationKind.Average,
	AggregationKind.Median,
	AggregationKind.Min,
	AggregationKind.Max,
];

export function chartAggregationKind(
	aggregation: string,
	valueProperty: string | null,
): AggregationKind {
	const kind = CHART_AGGREGATIONS.find((k) => k === aggregation) ?? AggregationKind.CountAll;
	return valueProperty ? kind : AggregationKind.CountAll;
}

export function buildChartModel(
	compiled: CompiledView,
	chartType: ChartType,
	aggregation: string,
	valueProperty: string | null,
	labels: { empty: string; other: string; all: string },
): ChartModel {
	const kind = chartAggregationKind(aggregation, valueProperty);
	const total = reduce(kind, compiled.rows, valueProperty);
	const groups =
		compiled.groups.length > 0
			? compiled.groups
			: [{ key: null, label: labels.all, rows: compiled.rows }];
	const categorical = chartType === ChartType.Pie;
	const limit = categorical ? CHART_SLOT_ORDER.length : Number.POSITIVE_INFINITY;
	const kept = groups.length > limit ? groups.slice(0, limit - 1) : groups;
	const folded = groups.length > limit ? groups.slice(limit - 1) : [];
	const data: ChartDatum[] = kept.map((g, i) => ({
		key: g.key ?? "",
		label: g.key === null && compiled.groups.length > 0 ? labels.empty : g.label,
		value: reduce(kind, g.rows, valueProperty).value,
		count: g.rows.length,
		color: categorical ? chartSlotColor(i) : null,
	}));
	if (folded.length > 0) {
		const rows = folded.flatMap((g) => g.rows);
		data.push({
			key: CHART_OTHER_KEY,
			label: labels.other,
			value: reduce(kind, rows, valueProperty).value,
			count: rows.length,
			color: CHART_OTHER_COLOR,
		});
	}
	return { kind, data, total };
}

/** A "nice" axis maximum and tick step for `max` (1 / 2 / 5 × 10ⁿ). */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
	if (!(max > 0)) return { max: 1, step: 1 };
	const raw = max / ticks;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
	return { max: Math.ceil(max / step) * step, step };
}

/** Pie slice arcs (start / end angle in radians, clockwise from 12 o'clock)
 *  for the non-negative values; null / negative values take no arc. */
export function pieArcs(values: ReadonlyArray<number | null>): { start: number; end: number }[] {
	const clean = values.map((v) => (v !== null && v > 0 ? v : 0));
	const sum = clean.reduce((a, b) => a + b, 0);
	let angle = 0;
	return clean.map((v) => {
		const start = angle;
		angle += sum > 0 ? (v / sum) * Math.PI * 2 : 0;
		return { start, end: angle };
	});
}
