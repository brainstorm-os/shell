/**
 * Rollup creation candidates (9.12.17) — the pure, vault-shape-driven core
 * behind the "Add rollup…" flow (relation → target property → aggregation).
 *
 * The Database mostly runs without a property catalog (it infers defs from
 * data — see `effective-def.ts`), so candidate discovery is **data-driven**:
 *   - A *relation* candidate is any property whose values, run through the
 *     engine's `linkedEntityIds`, resolve to ≥1 live entity in the vault. The
 *     set of those entities' `type`s is the relation's target type(s). This
 *     finds real relations whether or not a catalog def exists; a plain
 *     string/number column never matches (entity ids are opaque).
 *   - A *target* candidate is any (non-system, non-relation) property present
 *     on the linked entities, with its `ValueType` inferred from a sample so
 *     the aggregation set + value formatting are correct.
 *   - The *aggregation* options are the type-scoped set from `aggregations.ts`.
 *
 * Display names layer a catalog/`nameOf` lookup over the raw key, falling back
 * to `humanize` — so a `prop_…` key reads "Fee", not "Prop Mpx6…".
 */

import { type ColumnSpec, ValueType } from "@brainstorm-os/sdk-types";
import { AggregationKind, aggregationLabel, aggregationsForValueType } from "./aggregations";
import { inferPropertyDef } from "./effective-def";
import type { EntityRow } from "./in-memory-entities";
import { linkedEntityIds } from "./rollup";

/** A property that links the source rows to other entities — a rollup source. */
export type RelationCandidate = {
	key: string;
	name: string;
	/** Distinct types of the entities this relation resolves to. */
	targetTypes: ReadonlyArray<string>;
};

/** A property on the related entities that a rollup can aggregate. */
export type TargetCandidate = {
	key: string;
	name: string;
	valueType: ValueType;
};

/** An aggregation choice for the picker's final step. */
export type AggregationOption = {
	kind: AggregationKind;
	label: string;
};

/** Metadata fields that are never meaningful rollup targets (they're shell-
 *  owned or the relation plumbing itself). */
const NON_TARGET_KEYS: ReadonlySet<string> = new Set([
	"id",
	"type",
	"icon",
	"createdAt",
	"updatedAt",
	"deletedAt",
]);

/** Sample a property across rows for the first typeable value, returning the
 *  inferred `ValueType` (Text when nothing types — count family still applies). */
function inferValueType(key: string, rows: ReadonlyArray<EntityRow>): ValueType {
	for (const row of rows) {
		const value = row.properties[key];
		if (value === null || value === undefined || value === "") continue;
		const def = inferPropertyDef(key, value);
		if (def) return def.valueType;
	}
	return ValueType.Text;
}

/** Relations available as rollup sources on `rows`: every property whose
 *  values resolve to live entities in `byId`. `nameOf` maps a key to its
 *  display name (catalog name, else the humanized key). */
export function rollupRelationCandidates(
	rows: ReadonlyArray<EntityRow>,
	byId: ReadonlyMap<string, EntityRow>,
	nameOf: (key: string) => string,
): RelationCandidate[] {
	const targetTypesByKey = new Map<string, Set<string>>();
	for (const row of rows) {
		for (const [key, value] of Object.entries(row.properties)) {
			if (NON_TARGET_KEYS.has(key)) continue;
			const ids = linkedEntityIds(value);
			if (ids.length === 0) continue;
			for (const id of ids) {
				const linked = byId.get(id);
				if (!linked) continue;
				let types = targetTypesByKey.get(key);
				if (!types) {
					types = new Set<string>();
					targetTypesByKey.set(key, types);
				}
				types.add(linked.type);
			}
		}
	}
	return [...targetTypesByKey.entries()]
		.map(([key, types]) => ({ key, name: nameOf(key), targetTypes: [...types] }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Target properties a rollup over `relationKey` can read: every (non-system)
 *  property present on the linked entities, with its inferred value type. */
export function rollupTargetCandidates(
	relationKey: string,
	rows: ReadonlyArray<EntityRow>,
	byId: ReadonlyMap<string, EntityRow>,
	nameOf: (key: string) => string,
): TargetCandidate[] {
	const linked: EntityRow[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const id of linkedEntityIds(row.properties[relationKey])) {
			if (seen.has(id)) continue;
			const entity = byId.get(id);
			if (!entity) continue;
			seen.add(id);
			linked.push(entity);
		}
	}
	const keys = new Set<string>();
	for (const entity of linked) {
		for (const key of Object.keys(entity.properties)) {
			if (NON_TARGET_KEYS.has(key)) continue;
			keys.add(key);
		}
	}
	return [...keys]
		.map((key) => ({ key, name: nameOf(key), valueType: inferValueType(key, linked) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** The aggregation choices to offer for a target of `valueType` (drops the
 *  no-op `None`, which would make a blank column). */
export function rollupAggregationOptions(valueType: ValueType): AggregationOption[] {
	return aggregationsForValueType(valueType)
		.filter((kind) => kind !== AggregationKind.None)
		.map((kind) => ({ kind, label: aggregationLabel(kind) }));
}

/** The default header label for a rollup: "<Aggregation> of <Target>", e.g.
 *  "Sum of Fee". */
export function defaultRollupName(targetName: string, aggregation: AggregationKind): string {
	return `${aggregationLabel(aggregation)} of ${targetName}`;
}

/** A spec-derived, stable synthetic column id — distinct per (relation, target,
 *  aggregation) so the same rollup is never added twice and React keys stay
 *  stable across rebuilds. */
export function rollupColumnId(
	relationKey: string,
	targetPropertyKey: string,
	aggregation: AggregationKind,
): string {
	return `rollup:${relationKey}:${targetPropertyKey}:${aggregation}`;
}

/** Build the `ColumnSpec` for a chosen rollup, ready to append to a view's
 *  columns. The aggregation is stored as its string value (the `ColumnRollup`
 *  wire shape). */
export function buildRollupColumn(opts: {
	relationKey: string;
	targetPropertyKey: string;
	targetName: string;
	aggregation: AggregationKind;
	name?: string;
}): ColumnSpec {
	return {
		propertyId: rollupColumnId(opts.relationKey, opts.targetPropertyKey, opts.aggregation),
		visible: true,
		rollup: {
			relationKey: opts.relationKey,
			targetPropertyKey: opts.targetPropertyKey,
			aggregation: opts.aggregation,
			name: opts.name ?? defaultRollupName(opts.targetName, opts.aggregation),
		},
	};
}
