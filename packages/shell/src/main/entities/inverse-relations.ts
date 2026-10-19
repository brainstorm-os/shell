/**
 * Two-way relations (9.12.25) — the pure planner behind `PropertyDef.inverseOf`.
 *
 * When A.`rel` gains B, B.`inverse` must gain A; when it loses B, B loses A;
 * when A is deleted every far end drops A; when a pair is first declared, the
 * existing one-sided references backfill. This module only PLANS those far-end
 * writes from before/after property bags — the entities service applies them,
 * after checking every far end can take the write (capability + read-only lock)
 * so a refusal never leaves the pair half-applied.
 *
 * Value shapes follow the property catalog: a single-valued relation
 * (`count.max === 1`) stores a bare id; a multi-valued one stores
 * `{ value: id }` envelopes. A legacy bare-string array is preserved as-is.
 * Setting a single-valued far end DISPLACES its previous target, whose own
 * side then drops the far entity — one bounded extra hop, never a cascade.
 */

import { type PropertyDef, RESERVED_PROPERTY_KEYS, ValueType } from "@brainstorm-os/sdk-types";
import { readEntityRefIds } from "./derive-property-ref-links";

/** Property key → its paired key. Symmetric: a pair declared on one side maps
 *  both ways. A property that would pair with two different partners is
 *  ambiguous and pairs with neither. A reserved (host-owned) key never pairs,
 *  whatever the catalog says — it would let any write overwrite provenance. */
export type InversePairs = ReadonlyMap<string, string>;

export function inversePairs(defs: ReadonlyArray<PropertyDef>): InversePairs {
	const refs = new Map<string, PropertyDef>();
	for (const d of defs) {
		if (d.valueType === ValueType.EntityRef && !RESERVED_PROPERTY_KEYS.includes(d.key)) {
			refs.set(d.key, d);
		}
	}
	const pairs = new Map<string, string>();
	const ambiguous = new Set<string>();
	const bind = (a: string, b: string): void => {
		const prior = pairs.get(a);
		if (prior !== undefined && prior !== b) ambiguous.add(a);
		else pairs.set(a, b);
	};
	for (const d of refs.values()) {
		if (!d.inverseOf || !refs.has(d.inverseOf)) continue;
		bind(d.key, d.inverseOf);
		bind(d.inverseOf, d.key);
	}
	for (const [key, partner] of [...pairs]) {
		if (ambiguous.has(key) || ambiguous.has(partner)) pairs.delete(key);
	}
	return pairs;
}

/** Whether a relation stores many ids (envelopes) or one bare id. */
export type Multiplicity = (key: string) => boolean;

export function multiplicityOf(defs: ReadonlyArray<PropertyDef>): Multiplicity {
	const multi = new Map(defs.map((d) => [d.key, (d.count?.max ?? 1) > 1] as const));
	return (key) => multi.get(key) ?? false;
}

export function withRef(value: unknown, id: string, multi: boolean): unknown {
	if (!multi) return id;
	const ids = readEntityRefIds(value);
	if (ids.includes(id)) return value;
	const arr = Array.isArray(value) ? value : [];
	const bareStrings = arr.length > 0 && arr.every((v) => typeof v === "string");
	return [...arr, bareStrings ? id : { value: id }];
}

export function withoutRef(value: unknown, id: string): unknown {
	if (Array.isArray(value)) {
		return value.filter((v) => readEntityRefIds(v)[0] !== id);
	}
	return readEntityRefIds(value)[0] === id ? null : value;
}

export type FarWrite = {
	entityId: string;
	patch: Record<string, unknown>;
};

/** Reads an entity's CURRENT property bag (null ⇒ missing / deleted). */
export type ReadProps = (entityId: string) => Readonly<Record<string, unknown>> | null;

/**
 * Plan the far-end writes implied by one entity's property change. `before`
 * is `{}` for a create; `after` is `{}` for a delete. Returns one write per
 * touched far entity with its full patched values (patches to the same far
 * entity are folded), excluding the entity itself.
 */
export function planInverseWrites(input: {
	entityId: string;
	before: Readonly<Record<string, unknown>>;
	after: Readonly<Record<string, unknown>>;
	pairs: InversePairs;
	multi: Multiplicity;
	read: ReadProps;
}): FarWrite[] {
	const { entityId, before, after, pairs, multi, read } = input;
	const pending = new Map<string, Record<string, unknown>>();
	const current = (farId: string, key: string): unknown => {
		const staged = pending.get(farId);
		if (staged && key in staged) return staged[key];
		return read(farId)?.[key];
	};
	const stage = (farId: string, key: string, value: unknown): void => {
		const patch = pending.get(farId) ?? {};
		patch[key] = value;
		pending.set(farId, patch);
	};

	for (const [key, inverse] of pairs) {
		if (!(key in before) && !(key in after)) continue;
		const was = new Set(readEntityRefIds(before[key]));
		const now = new Set(readEntityRefIds(after[key]));
		for (const farId of was) {
			if (now.has(farId) || farId === entityId || read(farId) === null) continue;
			stage(farId, inverse, withoutRef(current(farId, inverse), entityId));
		}
		for (const farId of now) {
			if (was.has(farId) || farId === entityId || read(farId) === null) continue;
			const prior = current(farId, inverse);
			if (!multi(inverse)) {
				const displaced = readEntityRefIds(prior)[0];
				if (displaced !== undefined && displaced !== entityId && read(displaced) !== null) {
					stage(displaced, key, withoutRef(current(displaced, key), farId));
				}
			}
			stage(farId, inverse, withRef(prior, entityId, multi(inverse)));
		}
	}
	pending.delete(entityId);
	return [...pending].map(([id, patch]) => ({ entityId: id, patch }));
}

/**
 * Plan the one-time backfill when `key` ⇄ `inverse` is first paired: every
 * entity referencing X through either side makes X reference it back. Rows
 * are the live entity property bags; the result folds per far entity.
 */
export function planInverseBackfill(input: {
	key: string;
	inverse: string;
	rows: ReadonlyArray<{ id: string; properties: Readonly<Record<string, unknown>> }>;
	multi: Multiplicity;
}): FarWrite[] {
	const { key, inverse, rows, multi } = input;
	const live = new Map(rows.map((r) => [r.id, r.properties] as const));
	const pending = new Map<string, Record<string, unknown>>();
	const current = (id: string, k: string): unknown => {
		const staged = pending.get(id);
		return staged && k in staged ? staged[k] : live.get(id)?.[k];
	};
	const link = (fromId: string, viaKey: string, backKey: string): void => {
		for (const farId of readEntityRefIds(live.get(fromId)?.[viaKey])) {
			if (farId === fromId || !live.has(farId)) continue;
			const prior = current(farId, backKey);
			if (readEntityRefIds(prior).includes(fromId)) continue;
			if (!multi(backKey) && readEntityRefIds(prior).length > 0) continue;
			const patch = pending.get(farId) ?? {};
			patch[backKey] = withRef(prior, fromId, multi(backKey));
			pending.set(farId, patch);
		}
	};
	for (const r of rows) {
		link(r.id, key, inverse);
		if (inverse !== key) link(r.id, inverse, key);
	}
	return [...pending].map(([entityId, patch]) => ({ entityId, patch }));
}
