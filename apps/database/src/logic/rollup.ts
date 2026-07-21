/**
 * Rollups across a relation (9.12.17 slice 1 — the engine) — pure reducers
 * that aggregate a property of a row's *related* entities.
 *
 * A rollup answers "total fee across an engagement's deliverables" or "sum of
 * open-pipeline value across a client's deals": given a source row, the
 * EntityRef **relation** property that links it to other entities, and a
 * **target** property on those entities, it gathers the target values from the
 * linked rows and runs them through the same `computeAggregation` reducers the
 * footer uses (DRY — the rollup *is* an aggregation over a related set, not a
 * column). Kept dependency-light (rows + an id→row map in, an
 * `AggregationResult` out) so the resolution + math unit-tests without the grid;
 * `formatAggregation(result, targetDef)` formats it in the target's own units.
 */

import type { ColumnRollup } from "@brainstorm-os/sdk-types";
import { AggregationKind, type AggregationResult, computeAggregation } from "./aggregations";
import type { EntityRow } from "./in-memory-entities";

/** A rollup column's configuration: which relation to walk, which property to
 *  read on each linked entity, and how to aggregate the gathered values. */
export type RollupSpec = {
	/** Property key of the EntityRef relation on the source row. */
	relationKey: string;
	/** Property key to read on each linked (related) entity. */
	targetPropertyKey: string;
	/** Reducer applied to the gathered target values (reuses the footer set;
	 *  `Sum` is the engagement-fees default the caller typically picks). */
	aggregation: AggregationKind;
};

/** Extract the linked entity ids from a relation property's stored value.
 *  Handles every EntityRef shape the property system writes: a scalar id
 *  (single relation), a `LabeledValue[]` envelope (`{value:id}[]`, multi
 *  relation), or a bare `string[]`. Blanks and non-string ids drop. */
export function linkedEntityIds(relationValue: unknown): string[] {
	if (typeof relationValue === "string") {
		return relationValue.length > 0 ? [relationValue] : [];
	}
	if (!Array.isArray(relationValue)) return [];
	const ids: string[] = [];
	for (const el of relationValue) {
		const id =
			typeof el === "string"
				? el
				: el && typeof el === "object" && "value" in el
					? (el as { value: unknown }).value
					: null;
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}

/**
 * Compute a rollup for one source row: walk its `relationKey` relation to the
 * linked entities, read each one's `targetPropertyKey`, and aggregate. Missing
 * links (an id with no entity in the map, e.g. a deleted target) are skipped —
 * they contribute no value, exactly like an empty cell in the footer. The
 * result carries the same `unit` the chosen aggregation always does, so the
 * caller can `formatAggregation(result, targetDef)` for currency/duration/etc.
 */
export function computeRollup(
	source: EntityRow,
	spec: RollupSpec,
	entitiesById: ReadonlyMap<string, EntityRow>,
): AggregationResult {
	const ids = linkedEntityIds(source.properties[spec.relationKey]);
	const values: unknown[] = [];
	for (const id of ids) {
		const linked = entitiesById.get(id);
		if (!linked) continue;
		values.push(linked.properties[spec.targetPropertyKey]);
	}
	return computeAggregation(spec.aggregation, values);
}

/** Build an `id → row` lookup over a live entity set for `computeRollup`.
 *  Deleted rows are excluded so a rollup never counts a soft-deleted target. */
export function entitiesById(rows: readonly EntityRow[]): Map<string, EntityRow> {
	const map = new Map<string, EntityRow>();
	for (const row of rows) {
		if (row.deletedAt != null) continue;
		map.set(row.id, row);
	}
	return map;
}

const AGGREGATION_VALUES: ReadonlySet<string> = new Set(Object.values(AggregationKind));

/** Coerce a persisted `ColumnRollup.aggregation` (a plain string, since the
 *  sdk-types leaf type can't reference this enum) back to an `AggregationKind`.
 *  An unknown / future value falls back to `CountValues` — a count is always
 *  meaningful for any target type, so a forward-incompatible spec degrades to a
 *  sensible reading rather than throwing. */
export function parseAggregationKind(value: string): AggregationKind {
	return AGGREGATION_VALUES.has(value) ? (value as AggregationKind) : AggregationKind.CountValues;
}

/** Lift a view-column `ColumnRollup` (the persisted, string-aggregation shape)
 *  into the engine's `RollupSpec`. */
export function columnRollupToSpec(rollup: ColumnRollup): RollupSpec {
	return {
		relationKey: rollup.relationKey,
		targetPropertyKey: rollup.targetPropertyKey,
		aggregation: parseAggregationKind(rollup.aggregation),
	};
}
