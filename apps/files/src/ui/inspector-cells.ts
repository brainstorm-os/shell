/**
 * Pure defs-bridge for the inspector's editable metadata cells (9.8.13).
 *
 * The Properties tab edits `name` + `description` through the SHARED
 * `@brainstorm-os/sdk` property cells (the same Plain / Multiline cells the
 * Database grid + properties panels use), so Files never hand-rolls a
 * text input. A cell needs a `PropertyDef`; Files has no property catalog,
 * so we synthesise a minimal scalar Text def per field (name = single-line
 * Plain view, description = wrapping Multiline view) and map the stored
 * string ↔ the cell's `string | null` scalar both ways. Kept pure +
 * app-local (not extracted) so it's unit-testable without a React tree and
 * carries no UI; the Database app's `EditableCell` is too coupled to its
 * own catalog/`db-cell-bridge` to reuse here.
 */

import { type PropertyDef, PropertyView, ValueType } from "@brainstorm-os/sdk-types";

/** The editable scalar-text fields the inspector exposes. The enum value
 *  IS the entity `properties` key, per the no-string-discriminator
 *  convention. */
export enum EditableField {
	Name = "name",
	Description = "description",
}

/** Synthesise the scalar Text def that drives a field's cell. `name` rests
 *  as single-line (`Plain`); `description` wraps (`Multiline`). The label
 *  is injected (t-translated by the caller) so this stays render-free. */
export function fieldDef(field: EditableField, label: string): PropertyDef {
	return {
		key: field,
		name: label,
		icon: null,
		valueType: ValueType.Text,
		display: {
			view: field === EditableField.Name ? PropertyView.Plain : PropertyView.Multiline,
		},
	};
}

/** Read a field's stored value as the cell's scalar shape (`string | null`).
 *  A missing / non-string property is the canonical empty `null`. */
export function readFieldValue(
	properties: Record<string, unknown>,
	field: EditableField,
): string | null {
	const raw = properties[field];
	return typeof raw === "string" ? raw : null;
}

/** Map the cell's committed scalar back to the stored string. `null` /
 *  non-string (the cell can only emit `string | null`) collapses to an
 *  empty string so the write is always a defined value. */
export function toStoredValue(next: unknown): string {
	return typeof next === "string" ? next : "";
}
