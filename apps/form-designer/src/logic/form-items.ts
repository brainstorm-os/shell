/**
 * The Form Designer's **item tree** (8.10.3) — the authoring model behind
 * a form that is more than a flat field list.
 *
 * 8.10.1's model was one item kind: a property field. Doc 27's layouts
 * have six, and now that the 8.3 pipeline renders them and 8.4 draws
 * chrome, the designer can author three: a **field**, a **group** (a
 * labelled section with its own optional mode), and a **chrome cell**.
 *
 * Two deliberate limits, both about the *builder surface* rather than
 * the contract:
 *
 * - **One level of nesting.** `Layout/v1` allows groups inside groups;
 *   the builder offers groups containing fields. A tree editor with
 *   arbitrary depth is a different UI problem, and every form the
 *   designer has been asked for so far is one level. Deeper layouts
 *   still load, render and round-trip — `cellsToItems` flattens nested
 *   groups it can't represent rather than dropping their fields.
 * - **The leaf stays `FormField`.** Fill, validation and the create path
 *   all operate on a flat field list, so they keep working unchanged on
 *   `itemFields(items)` instead of learning to walk a tree.
 */

import {
	type ChromeKind,
	type LayoutCell,
	LayoutCellKind,
	type LayoutMode,
	isChromeKind,
} from "@brainstorm-os/sdk-types";
import { type FormField, readCellLabel } from "./form-model";

export enum FormItemKind {
	Field = "field",
	Group = "group",
	Chrome = "chrome",
}

export type FormGroup = {
	/** Creation-time identity, and the persisted cell id. Fields key on
	 *  their `property`; a group and a chrome cell have no natural key, so
	 *  without this a reorder would make React reuse the wrong card and a
	 *  section's label input would follow the position, not the section. */
	id: string;
	label?: string;
	/** A group may compose with its own mode (doc 27 §modes). Absent ⇒ it
	 *  inherits the form's. */
	mode?: LayoutMode;
	fields: FormField[];
};

export type FormChrome = {
	id: string;
	chrome: ChromeKind;
	options?: Record<string, unknown>;
};

export type FormItem =
	| { kind: FormItemKind.Field; field: FormField }
	| { kind: FormItemKind.Group; group: FormGroup }
	| { kind: FormItemKind.Chrome; chrome: FormChrome };

export const fieldItem = (field: FormField): FormItem => ({ kind: FormItemKind.Field, field });
export const groupItem = (group: FormGroup): FormItem => ({ kind: FormItemKind.Group, group });
export const chromeItem = (chrome: FormChrome): FormItem => ({ kind: FormItemKind.Chrome, chrome });

/**
 * Every property field in document order, flattened out of the tree.
 * The fill surface, the required-field validation and the create path
 * all consume this — a group is presentation, not a data boundary, so
 * none of them needs to know the tree exists.
 */
export function itemFields(items: readonly FormItem[]): FormField[] {
	const fields: FormField[] = [];
	for (const item of items) {
		if (item.kind === FormItemKind.Field) fields.push(item.field);
		else if (item.kind === FormItemKind.Group) fields.push(...item.group.fields);
	}
	return fields;
}

/** Whether a property is already placed anywhere in the tree — the
 *  add-field picker excludes these. */
export function itemsContainProperty(items: readonly FormItem[], property: string): boolean {
	return itemFields(items).some((field) => field.property === property);
}

/** Stable cell id for the nth top-level item. Deterministic, so
 *  re-saving an unchanged form keeps the ids `readingOrder` references. */
export function itemCellId(item: FormItem, index: number): string {
	switch (item.kind) {
		case FormItemKind.Field:
			return `field-${index}`;
		case FormItemKind.Group:
			return item.group.id;
		default:
			return item.chrome.id;
	}
}

let seq = 0;
/** A fresh item id. Prefixed by kind so a persisted cell id still reads
 *  as what it is when someone opens the entity. */
export function newItemId(kind: FormItemKind): string {
	seq += 1;
	return `${kind}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stable cell id for the nth field inside the group at `groupIndex`. */
export function groupFieldCellId(groupIndex: number, fieldIndex: number): string {
	return `group-${groupIndex}-field-${fieldIndex}`;
}

function propertyCell(field: FormField, id: string): LayoutCell {
	const cell: LayoutCell = {
		kind: LayoutCellKind.Property,
		id,
		property: field.property,
	};
	const label = field.label?.trim();
	if (label) cell.display = { options: { label } };
	if (field.condition) cell.condition = field.condition;
	return cell;
}

/**
 * The layout cells for an item tree. `place` assigns grid placement to
 * the top-level cells (the form's own tracks); a group's children are
 * placed by the group's own mode, which for the builder's one-level tree
 * means document order.
 */
export function itemsToCells(
	items: readonly FormItem[],
	place?: (index: number) => { col: number; row: number } | undefined,
): LayoutCell[] {
	return items.map((item, index) => {
		const id = itemCellId(item, index);
		const grid = place?.(index);
		let cell: LayoutCell;
		switch (item.kind) {
			case FormItemKind.Field:
				cell = propertyCell(item.field, id);
				break;
			case FormItemKind.Group: {
				cell = {
					kind: LayoutCellKind.Group,
					id,
					cells: item.group.fields.map((field, fieldIndex) =>
						propertyCell(field, groupFieldCellId(index, fieldIndex)),
					),
					...(item.group.label?.trim() ? { label: item.group.label.trim() } : {}),
					...(item.group.mode ? { mode: item.group.mode } : {}),
				};
				break;
			}
			default:
				cell = {
					kind: LayoutCellKind.Chrome,
					id,
					chrome: item.chrome.chrome,
					...(item.chrome.options ? { options: item.chrome.options } : {}),
				};
		}
		if (grid) cell.grid = grid;
		return cell;
	});
}

/**
 * Read an item tree back from saved cells. A nested group's own groups
 * are **flattened into it** rather than dropped: the builder can't edit
 * depth, but losing a user's fields on load would be worse than showing
 * them one level up, and the round-trip stays lossless in field terms.
 * Cell kinds the builder has no surface for (`block`, `text`, `divider`)
 * are skipped — they were never authorable here.
 */
export function cellsToItems(cells: readonly LayoutCell[]): FormItem[] {
	const items: FormItem[] = [];
	for (const cell of cells) {
		switch (cell.kind) {
			case LayoutCellKind.Property: {
				if (!cell.property) break;
				items.push(fieldItem(toField(cell)));
				break;
			}
			case LayoutCellKind.Group: {
				const group: FormGroup = { id: cell.id, fields: flattenGroupFields(cell.cells) };
				if (cell.label?.trim()) group.label = cell.label.trim();
				if (cell.mode) group.mode = cell.mode;
				items.push(groupItem(group));
				break;
			}
			case LayoutCellKind.Chrome: {
				if (!isChromeKind(cell.chrome)) break;
				items.push(
					chromeItem({
						id: cell.id,
						chrome: cell.chrome,
						...(cell.options ? { options: cell.options } : {}),
					}),
				);
				break;
			}
			default:
				break;
		}
	}
	return items;
}

function flattenGroupFields(cells: readonly LayoutCell[]): FormField[] {
	const fields: FormField[] = [];
	for (const cell of cells) {
		if (cell.kind === LayoutCellKind.Property && cell.property) fields.push(toField(cell));
		else if (cell.kind === LayoutCellKind.Group) fields.push(...flattenGroupFields(cell.cells));
	}
	return fields;
}

function toField(cell: Extract<LayoutCell, { kind: LayoutCellKind.Property }>): FormField {
	const field: FormField = { property: cell.property };
	const label = readCellLabel(cell);
	if (label) field.label = label;
	if (cell.condition) field.condition = cell.condition;
	return field;
}

/** Move the item at `from` to sit at index `to` (pure). Same ordering
 *  rule as the flat field list it generalises. */
export function moveItem(items: readonly FormItem[], from: number, to: number): FormItem[] {
	if (from < 0 || from >= items.length) return items.slice();
	const clamped = to < 0 ? 0 : to >= items.length ? items.length - 1 : to;
	if (clamped === from) return items.slice();
	const next = items.slice();
	const [moved] = next.splice(from, 1);
	if (!moved) return items.slice();
	next.splice(clamped, 0, moved);
	return next;
}

/**
 * Move a top-level field INTO the group at `groupIndex` (appended), or
 * out of a group back to top level. The two directions are one function
 * because they are one user gesture — "this field belongs in / out of
 * that section" — and splitting them invites the two paths to drift.
 */
export function moveFieldIntoGroup(
	items: readonly FormItem[],
	fieldIndex: number,
	groupIndex: number,
): FormItem[] {
	const source = items[fieldIndex];
	const target = items[groupIndex];
	if (!source || source.kind !== FormItemKind.Field) return items.slice();
	if (!target || target.kind !== FormItemKind.Group) return items.slice();
	const next = items.slice();
	next[groupIndex] = groupItem({
		...target.group,
		fields: [...target.group.fields, source.field],
	});
	next.splice(fieldIndex, 1);
	return next;
}

/** Lift the `fieldIndex`th field out of the group at `groupIndex` and
 *  drop it directly after the group. */
export function moveFieldOutOfGroup(
	items: readonly FormItem[],
	groupIndex: number,
	fieldIndex: number,
): FormItem[] {
	const target = items[groupIndex];
	if (!target || target.kind !== FormItemKind.Group) return items.slice();
	const field = target.group.fields[fieldIndex];
	if (!field) return items.slice();
	const next = items.slice();
	next[groupIndex] = groupItem({
		...target.group,
		fields: target.group.fields.filter((_, index) => index !== fieldIndex),
	});
	next.splice(groupIndex + 1, 0, fieldItem(field));
	return next;
}
