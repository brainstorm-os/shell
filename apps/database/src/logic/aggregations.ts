/**
 * Column aggregations (9.12.18) — pure reducers over a column's raw values
 * for the grid footer + board-column count badges.
 *
 * Kept dependency-free (raw `unknown[]` in, structured result out) so the
 * numeric / date / boolean math is unit-tested without the grid surface. The
 * applicable set is type-scoped: every column offers the universal count
 * family; numbers add sum/avg/median/min/max/range; dates add earliest/latest;
 * booleans add checked count/percent. Formatting is a separate step so the
 * caller can localise.
 */

import { type PropertyDef, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { formatDuration } from "@brainstorm-os/sdk/property-ui/pure";

export enum AggregationKind {
	None = "none",
	CountAll = "countAll",
	CountValues = "countValues",
	CountEmpty = "countEmpty",
	CountUnique = "countUnique",
	Sum = "sum",
	Average = "average",
	Median = "median",
	Min = "min",
	Max = "max",
	Range = "range",
	CheckedCount = "checkedCount",
	CheckedPercent = "checkedPercent",
	Earliest = "earliest",
	Latest = "latest",
}

/** What `value` means for formatting: a plain count, a number in the column's
 *  own units, a Unix-ms timestamp, or a 0–1 ratio. */
export enum AggregationUnit {
	Count = "count",
	Number = "number",
	Timestamp = "timestamp",
	Ratio = "ratio",
}

export type AggregationResult = {
	kind: AggregationKind;
	/** Null when the aggregation has no defined value (e.g. Sum over no
	 *  numeric cells, Min over an empty column). `None` always yields null. */
	value: number | null;
	unit: AggregationUnit;
};

const UNIVERSAL: readonly AggregationKind[] = [
	AggregationKind.CountAll,
	AggregationKind.CountValues,
	AggregationKind.CountEmpty,
	AggregationKind.CountUnique,
];

const NUMERIC: readonly AggregationKind[] = [
	AggregationKind.Sum,
	AggregationKind.Average,
	AggregationKind.Median,
	AggregationKind.Min,
	AggregationKind.Max,
	AggregationKind.Range,
];

const DATE: readonly AggregationKind[] = [AggregationKind.Earliest, AggregationKind.Latest];

const BOOLEAN: readonly AggregationKind[] = [
	AggregationKind.CheckedCount,
	AggregationKind.CheckedPercent,
];

/** The aggregation kinds a column of `valueType` can offer (always
 *  `None`-prefixed + the universal count family, then type-specific). */
export function aggregationsForValueType(valueType: ValueType): readonly AggregationKind[] {
	const extra =
		valueType === ValueType.Number
			? NUMERIC
			: valueType === ValueType.Date
				? DATE
				: valueType === ValueType.Boolean
					? BOOLEAN
					: [];
	return [AggregationKind.None, ...UNIVERSAL, ...extra];
}

/** A value counts as "empty" when it's null/undefined, an empty string, or an
 *  empty array — the same notion the editable-cell / def-inference paths use. */
function isEmpty(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === "string") return value.length === 0;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/** Coerce to a finite number, or null. Numeric strings parse; booleans and
 *  non-numeric strings don't (a count column shouldn't sum "true"s). */
function toNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim().length > 0) {
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

/** Coerce to a Unix-ms timestamp, or null. Accepts a ms number (timestamp
 *  window) or an ISO/parseable date string. */
function toTimestamp(value: unknown): number | null {
	if (typeof value === "number") {
		return value >= 1_000_000_000_000 && value <= 4_000_000_000_000 ? value : null;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		const t = Date.parse(value);
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

function isChecked(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value === "true";
	return false;
}

function numbers(values: readonly unknown[]): number[] {
	const out: number[] = [];
	for (const v of values) {
		const n = toNumber(v);
		if (n !== null) out.push(n);
	}
	return out;
}

function timestamps(values: readonly unknown[]): number[] {
	const out: number[] = [];
	for (const v of values) {
		const t = toTimestamp(v);
		if (t !== null) out.push(t);
	}
	return out;
}

function result(
	kind: AggregationKind,
	value: number | null,
	unit: AggregationUnit,
): AggregationResult {
	return { kind, value, unit };
}

/** Compute an aggregation over a column's raw values. Total rows = the length
 *  of `values` (callers pass one entry per row, empties included). */
export function computeAggregation(
	kind: AggregationKind,
	values: readonly unknown[],
): AggregationResult {
	switch (kind) {
		case AggregationKind.None:
			return result(kind, null, AggregationUnit.Count);
		case AggregationKind.CountAll:
			return result(kind, values.length, AggregationUnit.Count);
		case AggregationKind.CountValues:
			return result(kind, values.filter((v) => !isEmpty(v)).length, AggregationUnit.Count);
		case AggregationKind.CountEmpty:
			return result(kind, values.filter(isEmpty).length, AggregationUnit.Count);
		case AggregationKind.CountUnique: {
			const seen = new Set<unknown>();
			for (const v of values) {
				if (isEmpty(v)) continue;
				seen.add(typeof v === "object" ? JSON.stringify(v) : v);
			}
			return result(kind, seen.size, AggregationUnit.Count);
		}
		case AggregationKind.Sum: {
			const ns = numbers(values);
			return result(
				kind,
				ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0),
				AggregationUnit.Number,
			);
		}
		case AggregationKind.Average: {
			const ns = numbers(values);
			return result(
				kind,
				ns.length === 0 ? null : ns.reduce((a, b) => a + b, 0) / ns.length,
				AggregationUnit.Number,
			);
		}
		case AggregationKind.Median: {
			const ns = numbers(values).sort((a, b) => a - b);
			if (ns.length === 0) return result(kind, null, AggregationUnit.Number);
			const mid = Math.floor(ns.length / 2);
			const median =
				ns.length % 2 === 0 ? ((ns[mid - 1] as number) + (ns[mid] as number)) / 2 : (ns[mid] as number);
			return result(kind, median, AggregationUnit.Number);
		}
		case AggregationKind.Min: {
			const ns = numbers(values);
			return result(kind, ns.length === 0 ? null : Math.min(...ns), AggregationUnit.Number);
		}
		case AggregationKind.Max: {
			const ns = numbers(values);
			return result(kind, ns.length === 0 ? null : Math.max(...ns), AggregationUnit.Number);
		}
		case AggregationKind.Range: {
			const ns = numbers(values);
			return result(
				kind,
				ns.length === 0 ? null : Math.max(...ns) - Math.min(...ns),
				AggregationUnit.Number,
			);
		}
		case AggregationKind.CheckedCount:
			return result(kind, values.filter(isChecked).length, AggregationUnit.Count);
		case AggregationKind.CheckedPercent:
			return result(
				kind,
				values.length === 0 ? null : values.filter(isChecked).length / values.length,
				AggregationUnit.Ratio,
			);
		case AggregationKind.Earliest: {
			const ts = timestamps(values);
			return result(kind, ts.length === 0 ? null : Math.min(...ts), AggregationUnit.Timestamp);
		}
		case AggregationKind.Latest: {
			const ts = timestamps(values);
			return result(kind, ts.length === 0 ? null : Math.max(...ts), AggregationUnit.Timestamp);
		}
		default:
			return result(AggregationKind.None, null, AggregationUnit.Count);
	}
}

const NUMBER_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const PERCENT_FMT = new Intl.NumberFormat(undefined, {
	style: "percent",
	maximumFractionDigits: 1,
});
const DATE_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

const currencyFormatters = new Map<string, Intl.NumberFormat>();
function currencyFormatter(code: string): Intl.NumberFormat {
	let f = currencyFormatters.get(code);
	if (!f) {
		try {
			f = new Intl.NumberFormat(undefined, { style: "currency", currency: code });
		} catch {
			f = NUMBER_FMT;
		}
		currencyFormatters.set(code, f);
	}
	return f;
}

/** Render an aggregation result to a display string. `None` and a null value
 *  both render as an em-dash so the footer cell is never blank-but-ambiguous.
 *  When the column's `def` carries a currency/percent format, a value-unit
 *  aggregation (Sum/Average/Min/…) renders in that format — so a Deal-size SUM
 *  reads "US$85,000.00", consistent with the cells, not a bare "85,000"
 *  (F-029). Count-unit aggregations stay plain (a count is never money). */
export function formatAggregation(result: AggregationResult, def?: PropertyDef): string {
	if (result.kind === AggregationKind.None || result.value === null) return "—";
	switch (result.unit) {
		case AggregationUnit.Count:
			return NUMBER_FMT.format(result.value);
		case AggregationUnit.Number:
			if (def?.format === PropertyFormat.Currency) {
				return currencyFormatter(def.currency ?? "USD").format(result.value);
			}
			if (def?.format === PropertyFormat.Percent) {
				return PERCENT_FMT.format(result.value);
			}
			if (def?.format === PropertyFormat.Duration) {
				return formatDuration(result.value);
			}
			return NUMBER_FMT.format(result.value);
		case AggregationUnit.Ratio:
			return PERCENT_FMT.format(result.value);
		case AggregationUnit.Timestamp:
			return DATE_FMT.format(new Date(result.value));
		default:
			return String(result.value);
	}
}

/** The default aggregation a column offers before the user picks one: a sum
 *  for numbers (the most-asked footer), else the non-empty value count. */
export function defaultAggregationFor(valueType: ValueType): AggregationKind {
	return valueType === ValueType.Number ? AggregationKind.Sum : AggregationKind.CountValues;
}

/** Short human label per aggregation — the footer button caption and the
 *  rollup aggregation-picker option label (one source of truth for both). */
const AGGREGATION_LABELS: Record<AggregationKind, string> = {
	[AggregationKind.None]: "None",
	[AggregationKind.CountAll]: "Count",
	[AggregationKind.CountValues]: "Filled",
	[AggregationKind.CountEmpty]: "Empty",
	[AggregationKind.CountUnique]: "Unique",
	[AggregationKind.Sum]: "Sum",
	[AggregationKind.Average]: "Average",
	[AggregationKind.Median]: "Median",
	[AggregationKind.Min]: "Min",
	[AggregationKind.Max]: "Max",
	[AggregationKind.Range]: "Range",
	[AggregationKind.CheckedCount]: "Checked",
	[AggregationKind.CheckedPercent]: "Checked %",
	[AggregationKind.Earliest]: "Earliest",
	[AggregationKind.Latest]: "Latest",
};

export function aggregationLabel(kind: AggregationKind): string {
	return AGGREGATION_LABELS[kind];
}
