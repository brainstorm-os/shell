/**
 * Pure form model — the translation layer between the Form Designer's
 * editable field list and the persisted `brainstorm/Layout/v1` entity,
 * plus the fill-mode mapping from collected values to a new entity's
 * `properties`. No DOM / React here so it gets node-environment unit
 * coverage.
 *
 * A *form* is a `LayoutDef` in `LayoutMode.Stacked`, any-context
 * (`context: null`), whose cells are all `PropertyCell`s — one per
 * field, in document order (stacked mode reads order from the array).
 * An optional per-field label is carried on the cell's
 * `display.options.label` so a field round-trips as a single cell (no
 * sibling `TextCell` to keep in sync).
 *
 * The Layout entity's `properties` carry the `LayoutDef` fields plus the
 * human `name` and the `targetType` the form creates — `FormProperties`.
 * `scope` is type-scoped to the target type (a form is "the shape of a
 * new <targetType>"), matching the PropertySchema overlay model.
 */

import {
	type LayoutCell,
	LayoutCellKind,
	type LayoutContext,
	type LayoutDef,
	LayoutMode,
	type PropertyCell,
	type PropertyPredicate,
	type Scope,
} from "@brainstorm-os/sdk-types";

/** Default target type for a new form — the generic `Object/v1` the
 *  Database app registers. The builder lets the user pick another. */
export const DEFAULT_TARGET_TYPE = "brainstorm/Object/v1";

/** One editable field in the builder. `property` is a PropertyDef `key`;
 *  `label` overrides the property's own name when set. `condition` is an
 *  optional conditional-visibility rule (8.10.4) — the field shows only
 *  when the predicate holds against the in-progress fill values. It
 *  rides the layout cell's canonical `condition` field (the shared
 *  property-predicate language, never a second mini-language). */
export type FormField = {
	property: string;
	label?: string;
	condition?: PropertyPredicate;
};

/** The `properties` payload of a Form's `Layout/v1` entity. */
export type FormProperties = {
	name: string;
	mode: LayoutMode;
	context: LayoutContext | null;
	targetType: string;
	cells: PropertyCell[];
	readingOrder?: string[];
};

/** Stable cell id for the nth field. Deterministic so re-saving an
 *  unchanged form keeps stable ids (referenced by `readingOrder`). */
export function fieldCellId(index: number): string {
	return `field-${index}`;
}

/** Build the ordered `PropertyCell` list from a field list. The optional
 *  per-field label rides on `display.options.label`. */
export function fieldsToCells(fields: readonly FormField[]): PropertyCell[] {
	return fields.map((field, index) => {
		const cell: PropertyCell = {
			kind: LayoutCellKind.Property,
			id: fieldCellId(index),
			property: field.property,
		};
		const label = field.label?.trim();
		if (label) cell.display = { options: { label } };
		if (field.condition) cell.condition = field.condition;
		return cell;
	});
}

/** Move the field at `from` to sit at index `to`, returning a new array
 *  (pure — never mutates `fields`). Out-of-range indices, or a no-op
 *  move, return the input unchanged. Backs both the keyboard up/down
 *  reorder and drag-to-reorder so the two paths share one ordering rule. */
export function moveField(fields: readonly FormField[], from: number, to: number): FormField[] {
	if (from < 0 || from >= fields.length) return fields.slice();
	const clamped = to < 0 ? 0 : to >= fields.length ? fields.length - 1 : to;
	if (clamped === from) return fields.slice();
	const next = fields.slice();
	const [moved] = next.splice(from, 1);
	if (!moved) return fields.slice();
	next.splice(clamped, 0, moved);
	return next;
}

/** Read the editable field list back from a saved form's cells —
 *  property + optional label, in document order. Non-property cells
 *  (out of v1's builder surface) are skipped. */
export function cellsToFields(cells: readonly LayoutCell[]): FormField[] {
	const fields: FormField[] = [];
	for (const cell of cells) {
		if (cell.kind !== LayoutCellKind.Property || !cell.property) continue;
		const field: FormField = { property: cell.property };
		const label = readCellLabel(cell);
		if (label) field.label = label;
		if (cell.condition) field.condition = cell.condition;
		fields.push(field);
	}
	return fields;
}

function readCellLabel(cell: PropertyCell): string | undefined {
	const raw = cell.display?.options?.label;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** Type-scoped overlay for a form: it describes the shape of a new
 *  `targetType` entity, so the layout is scoped to that type. */
export function formScope(targetType: string): Scope {
	return { kind: "type", target: targetType };
}

/** Assemble the full `FormProperties` payload for persistence. Stacked
 *  mode + any-context; `readingOrder` is document order (the stacked
 *  default) made explicit so the saved layout is unambiguous. */
export function buildFormProperties(input: {
	name: string;
	targetType: string;
	fields: readonly FormField[];
}): FormProperties {
	const cells = fieldsToCells(input.fields);
	return {
		name: input.name.trim(),
		mode: LayoutMode.Stacked,
		context: null,
		targetType: input.targetType,
		cells,
		readingOrder: cells.map((cell) => cell.id),
	};
}

/** The `LayoutDef` view of a saved form — for validation / resolver use.
 *  (The persisted entity stores the same fields flat in `properties`
 *  alongside `name` + `targetType`; this projects just the LayoutDef.) */
export function toLayoutDef(props: FormProperties): LayoutDef {
	return {
		mode: props.mode,
		scope: formScope(props.targetType),
		context: props.context,
		cells: props.cells,
		...(props.readingOrder ? { readingOrder: props.readingOrder } : {}),
	};
}

/** Read a saved entity's `properties` into a typed `FormProperties`,
 *  tolerating partial / foreign shapes (defaults applied). */
export function readFormProperties(raw: Record<string, unknown>): FormProperties {
	const name = typeof raw.name === "string" ? raw.name : "";
	const targetType =
		typeof raw.targetType === "string" && raw.targetType.length > 0
			? raw.targetType
			: DEFAULT_TARGET_TYPE;
	const cells = Array.isArray(raw.cells) ? (raw.cells as PropertyCell[]) : [];
	const readingOrder = Array.isArray(raw.readingOrder)
		? (raw.readingOrder as string[])
		: cells.map((cell) => cell.id);
	return {
		name,
		mode: LayoutMode.Stacked,
		context: null,
		targetType,
		cells,
		readingOrder,
	};
}

/** Map collected fill values (keyed by property key) to the new entity's
 *  `properties`. A `name` is always present (the entity title) — falls
 *  back to a sensible default when the form has no name field. Only
 *  fields present in the form are written; empty / nullish values are
 *  dropped so the new entity isn't littered with nulls. */
export function fillValuesToProperties(input: {
	fields: readonly FormField[];
	values: Readonly<Record<string, unknown>>;
	fallbackName: string;
}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of input.fields) {
		const value = input.values[field.property];
		if (isEmptyValue(value)) continue;
		out[field.property] = value;
	}
	if (typeof out.name !== "string" || out.name.trim().length === 0) {
		out.name = input.fallbackName;
	}
	return out;
}

/** True when a collected fill value carries no real content — nullish, a
 *  blank/whitespace string, or an empty array. The single source of truth
 *  for "is this field empty" shared by the value mapper and validation. */
export function isEmptyValue(value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (typeof value === "string") return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/** The form fields whose collected value is empty. In Fill mode every
 *  declared field is required, so this is the set of validation errors
 *  that must block Create (F-239). Returned in document order, so the
 *  first entry is the first invalid field to focus. */
export function emptyFillFields(input: {
	fields: readonly FormField[];
	values: Readonly<Record<string, unknown>>;
}): FormField[] {
	return input.fields.filter((field) => isEmptyValue(input.values[field.property]));
}
