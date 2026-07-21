/**
 * Per-entity property values — pure helpers around a record's `values`
 * field (Notes stores it on each note; any consumer with a
 * `Record<propertyKey, unknown>` bag uses the same shape).
 *
 * Storage model: `values: Record<propertyKey, unknown>` — one entry per
 * property bound on that record. Definitions live in the vault-scoped
 * propertyStore; values live on the record. Hydration goes through
 * `migrateValuesField()` so older records with no `values` field
 * become `{}` rather than `undefined`.
 *
 * Post-VP-7 the value shape is cardinality-aware: scalar for
 * `count.max === 1`, `LabeledValue[]` envelope for multi. The
 * shell-side `coerceValue` / `emptyValueFor` / `isEmptyValue` helpers
 * already encode that distinction; this module is a thin wrapper that
 * persists / drops empty entries.
 *
 * Stage-9 migration: each entry of `values` becomes a property field
 * on the entity. The pure shape here translates 1:1.
 */

import type { PropertyDef, PropertyValueByValueType, ValueType } from "@brainstorm-os/sdk-types";
import { coerceValue, emptyValueFor, isEmptyValue } from "../properties-validate";

export type ValuesMap = Record<string, unknown>;

/** Read the value for `def.key` from a note's `values` map, coerced
 *  to the shape implied by `def` (scalar vs multi based on
 *  cardinality). A missing entry returns the shape's empty so cells
 *  never see `undefined`. */
export function readValue<V extends ValueType>(
	values: ValuesMap | undefined,
	def: PropertyDef & { valueType: V },
): PropertyValueByValueType[V] {
	if (!values || !(def.key in values)) return emptyValueFor(def);
	return coerceValue(def, values[def.key]);
}

/** Write the value for `def.key` to a (logically immutable) copy of
 *  `values`. Returns the new map; callers feed it into
 *  `useNotes.update(id, { values: next })`. Setting the shape-empty
 *  value clears the entry from the map rather than persisting an
 *  empty placeholder. */
export function writeValue<V extends ValueType>(
	values: ValuesMap | undefined,
	def: PropertyDef & { valueType: V },
	next: PropertyValueByValueType[V],
): ValuesMap {
	const out: ValuesMap = { ...(values ?? {}) };
	if (isEmptyValue(def, next)) {
		delete out[def.key];
	} else {
		out[def.key] = next;
	}
	return out;
}

/** Bind `def` onto a note WITHOUT a value yet. The panel renders a row
 *  for every key present in `values`, so binding needs the key present
 *  — but `writeValue` deletes empty values (clearing a value unbinds
 *  it), so seeding the empty value through `writeValue` is a no-op and
 *  the binding never persists (the "Add property" panel bug). This
 *  force-sets the key to its kind-empty value, and is a no-op if the
 *  key is already bound (never clobbers an existing value). */
export function bindValue<V extends ValueType>(
	values: ValuesMap | undefined,
	def: PropertyDef & { valueType: V },
): ValuesMap {
	const base = values ?? {};
	if (def.key in base) return base;
	return { ...base, [def.key]: emptyValueFor(def) };
}

/** Drop the entry for `key` from `values` regardless of property def
 *  (used when a `__propertyKey` is removed from a PropertyList block
 *  and the value should no longer be persisted). */
export function clearValue(values: ValuesMap | undefined, key: string): ValuesMap {
	if (!values || !(key in values)) return values ?? {};
	const out = { ...values };
	delete out[key];
	return out;
}

/** Hydrate the `values` field from a raw stored note. Older notes
 *  written before B5.3 have no field at all → `{}`. Anything that's
 *  not a plain object becomes `{}` (defensive — keeps the renderer
 *  from crashing on a corrupted row). */
export function migrateValuesField(raw: unknown): ValuesMap {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return raw as ValuesMap;
}
