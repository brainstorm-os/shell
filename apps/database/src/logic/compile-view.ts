/**
 * Compile a `ListView` against a set of resolved entity rows: apply the
 * view's filter overlay, sort, and group-by, returning rendered ordering
 * that every view kind consumes.
 *
 * Long-term keystone: every renderer (grid / list / gallery / board /
 * calendar / timeline) consumes the same `CompiledView`. Swapping in the
 * entities service is a substitution of the entity source — the renderer
 * code reading `CompiledView` doesn't change.
 */

import {
	EmptyPlacement,
	FilterGroupOp,
	type FilterNode,
	FilterNodeKind,
	type ListView,
	type PropertyPredicate,
	SortDirection,
	type SortKey,
} from "../types";
import { evaluatePredicate } from "./evaluate-predicate";
import { type EntityRow, readPropertyPath } from "./in-memory-entities";

export type CompiledView = {
	rows: ReadonlyArray<EntityRow>;
	/** Group-by buckets — empty when `view.groupBy === null`. Insertion order
	 *  is the group's declared display order (vocabulary → declared order,
	 *  boolean → true / false, entityRef → first-seen). */
	groups: ReadonlyArray<{ key: string | null; label: string; rows: ReadonlyArray<EntityRow> }>;
};

/**
 * `labelFor` resolves a group key to a human label — used so a board
 * grouped by an entity-reference property (`projectId` → a `Project/v1`)
 * shows the project's name, not the raw `proj-0` id. Returns `undefined`
 * to fall back to the key verbatim (the normal vocabulary/string case).
 */
export function compileView(
	view: ListView,
	entities: ReadonlyArray<EntityRow>,
	labelFor?: (key: string) => string | undefined,
	orderFor?: (key: string) => number | undefined,
): CompiledView {
	const flatFilter = flattenFilter(view.filters);
	const filtered = flatFilter
		? entities.filter((e) => evaluatePredicate(e, flatFilter))
		: entities.slice();
	const sorted = applySorts(filtered, view.sorts);
	const ordered =
		view.manualOrder && view.manualOrder.length > 0
			? applyManualOrder(sorted, view.manualOrder)
			: sorted;
	const groups =
		view.groupBy === null ? [] : groupRows(ordered, view.groupBy.propertyId, labelFor, orderFor);
	return { rows: ordered, groups };
}

/** Reorder `rows` to match `order` (entity ids from a drag-reorder).
 *  Listed ids follow `order`'s sequence; rows not in `order` keep their
 *  incoming relative position, appended after. Pure + stable so a
 *  re-render with the same order is a no-op. */
export function applyManualOrder(
	rows: ReadonlyArray<EntityRow>,
	order: ReadonlyArray<string>,
): EntityRow[] {
	const rank = new Map(order.map((id, i) => [id, i] as const));
	const listed: EntityRow[] = [];
	const rest: EntityRow[] = [];
	for (const r of rows) {
		if (rank.has(r.id)) listed.push(r);
		else rest.push(r);
	}
	listed.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
	return [...listed, ...rest];
}

export function flattenFilter(node: FilterNode | null): PropertyPredicate | null {
	if (node === null) return null;
	if (node.kind === FilterNodeKind.Predicate) return node.predicate;
	const children = node.children
		.map((c) => flattenFilter(c))
		.filter((p): p is PropertyPredicate => p !== null);
	if (children.length === 0) return null;
	const base: PropertyPredicate =
		children.length === 1
			? (children[0] as PropertyPredicate)
			: node.op === FilterGroupOp.And
				? { $and: children }
				: { $or: children };
	// A negated group (9.12.21) wraps its AND/OR predicate in `$not`.
	return node.negate ? { $not: base } : base;
}

export function applySorts(
	rows: ReadonlyArray<EntityRow>,
	sorts: ReadonlyArray<SortKey>,
): EntityRow[] {
	if (sorts.length === 0) return rows.slice();
	const out = rows.slice();
	out.sort((a, b) => {
		for (const sort of sorts) {
			if (sort.direction === SortDirection.Manual) continue;
			const cmp = compareForSort(a, b, sort);
			if (cmp !== 0) return cmp;
		}
		return 0;
	});
	return out;
}

function compareForSort(a: EntityRow, b: EntityRow, sort: SortKey): number {
	const va = readSortable(a, sort.propertyId);
	const vb = readSortable(b, sort.propertyId);
	const emptiness = handleEmpty(va, vb, sort.emptyPlacement);
	if (emptiness !== undefined) return sort.direction === SortDirection.Desc ? -emptiness : emptiness;
	const raw = compareValues(va, vb);
	return sort.direction === SortDirection.Desc ? -raw : raw;
}

function readSortable(entity: EntityRow, propertyId: string): unknown {
	const v = readPropertyPath(entity, propertyId);
	if (Array.isArray(v)) return v.length === 0 ? undefined : v[0];
	if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) {
		return (v as { value: unknown }).value;
	}
	return v;
}

function compareValues(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
	if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
	return 0;
}

/** Empty = null/undefined, empty string, or empty array — the same notion the
 *  aggregations / editable-cell paths use, so a row whose sort key is an empty
 *  multi-value (`[]`, e.g. no tags) lands with the other empties under
 *  `emptyPlacement` instead of being treated as a present value. */
function isEmpty(v: unknown): boolean {
	if (v === undefined || v === null) return true;
	if (typeof v === "string") return v.length === 0;
	if (Array.isArray(v)) return v.length === 0;
	return false;
}

function handleEmpty(a: unknown, b: unknown, placement: EmptyPlacement): number | undefined {
	const ae = isEmpty(a);
	const be = isEmpty(b);
	if (!ae && !be) return undefined;
	if (ae && be) return 0;
	if (placement === EmptyPlacement.None) return undefined;
	if (placement === EmptyPlacement.End) return ae ? 1 : -1;
	return ae ? -1 : 1;
}

export function groupRows(
	rows: ReadonlyArray<EntityRow>,
	propertyId: string,
	labelFor?: (key: string) => string | undefined,
	orderFor?: (key: string) => number | undefined,
): { key: string | null; label: string; rows: EntityRow[] }[] {
	const order: (string | null)[] = [];
	const byKey = new Map<string | null, EntityRow[]>();
	for (const e of rows) {
		const key = readGroupKey(e, propertyId);
		const bucket = byKey.get(key);
		if (bucket) {
			bucket.push(e);
		} else {
			byKey.set(key, [e]);
			order.push(key);
		}
	}
	// Default lane order follows the group property's own option order (a Select
	// reads in its defined funnel order, not first-seen data order — F-037).
	// Keys with a known option rank sort by it; the null/"Uncategorized" bucket
	// and any value not in the option list keep first-seen order, placed last. A
	// manual drag-reorder (board `groupOrder`) still overrides this downstream.
	if (orderFor) {
		const seen = new Map(order.map((key, i) => [key, i] as const));
		order.sort((a, b) => {
			const ra = a === null ? undefined : orderFor(a);
			const rb = b === null ? undefined : orderFor(b);
			if (ra !== undefined && rb !== undefined) return ra - rb;
			if (ra !== undefined) return -1;
			if (rb !== undefined) return 1;
			return (seen.get(a) ?? 0) - (seen.get(b) ?? 0);
		});
	}
	return order.map((key) => {
		const bucket = byKey.get(key);
		return {
			key,
			label: key === null ? "Uncategorized" : (labelFor?.(key) ?? key),
			rows: bucket ?? [],
		};
	});
}

export function readGroupKey(entity: EntityRow, propertyId: string): string | null {
	const v = readPropertyPath(entity, propertyId);
	if (v === undefined || v === null) return null;
	if (typeof v === "string") return v === "" ? null : v;
	if (typeof v === "number") return String(v);
	if (typeof v === "boolean") return v ? "Yes" : "No";
	if (Array.isArray(v)) {
		const first = v[0];
		if (first && typeof first === "object" && "value" in (first as Record<string, unknown>)) {
			return String((first as { value: unknown }).value ?? "") || null;
		}
		return first === undefined ? null : String(first);
	}
	if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
		const inner = (v as { value: unknown }).value;
		return inner === undefined || inner === null ? null : String(inner);
	}
	return null;
}
