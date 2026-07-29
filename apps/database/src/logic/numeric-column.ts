/**
 * Numeric-column detection (POLISH-PROP-2) — decides which grid columns
 * right-align (header + cells + inline editor) so their numerals share an
 * edge with the footer aggregate, per the standard table convention.
 *
 * Numeric means "renders numerals as text": Number-typed columns (including
 * currency / percent / duration formats), formula columns (arithmetic →
 * number), and rollups whose aggregation yields a number. ProgressBar /
 * Rating views draw graphics, not numerals, and stay left-aligned; date
 * rollups (earliest / latest) render dates and stay left-aligned too.
 */

import {
	type ColumnSpec,
	type PropertyDef,
	PropertyView,
	ValueType,
	defaultViewFor,
} from "@brainstorm-os/sdk-types";
import { AggregationKind } from "./aggregations";
import { parseAggregationKind } from "./rollup";

const NON_NUMERIC_ROLLUPS: ReadonlySet<AggregationKind> = new Set([
	AggregationKind.None,
	AggregationKind.Earliest,
	AggregationKind.Latest,
]);

const GRAPHICAL_NUMBER_VIEWS: ReadonlySet<PropertyView> = new Set([
	PropertyView.ProgressBar,
	PropertyView.Rating,
]);

export function isNumericColumn(column: ColumnSpec, def: PropertyDef | null): boolean {
	if (column.formula) return true;
	if (column.rollup) {
		return !NON_NUMERIC_ROLLUPS.has(parseAggregationKind(column.rollup.aggregation));
	}
	if (!def || def.valueType !== ValueType.Number) return false;
	return !GRAPHICAL_NUMBER_VIEWS.has(defaultViewFor(def));
}
