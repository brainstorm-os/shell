/**
 * EditableCell — the one bridge that makes a Database property value
 * editable in place, reusing the shared `@brainstorm/sdk` property cells
 * (the same cells the properties panel + editor block use). Drop-in for
 * the read-only `paintPropertyValue` `<DomSlot>` every view used before.
 *
 * It resolves the column's `PropertyDef`, and:
 *   - if the property has no def, or its value type has no editing cell
 *     (e.g. RichText body), or no `onEdit` was supplied, it renders the
 *     existing imperative paint unchanged (read-only — zero visual change);
 *   - otherwise it renders the SDK cell for the def's default view, with
 *     the value adapted through `db-cell-bridge` both ways and `onChange`
 *     routed to the app's optimistic `persistEntityPatch` via `onEdit`.
 *
 * One `<PropertiesProvider>` (mounted at the view root in `app.ts`) gives
 * every cell the vault's property + dictionary catalog, so Tag / Link
 * editors work; this component itself is provider-agnostic.
 */

import { type PropertyDef, defaultViewFor } from "@brainstorm/sdk-types";
import { getCell } from "@brainstorm/sdk/property-ui";
import type { ReactElement } from "react";
import { toCellValue, toDbValue } from "../logic/db-cell-bridge";
import { type EntityRow, readPropertyPath } from "../logic/in-memory-entities";
import { paintPropertyValue } from "../render/cells";
import { DomSlot } from "./dom-slot";

export type EntityPropertyEdit = (entity: EntityRow, propertyId: string, value: unknown) => void;

export function EditableCell({
	entity,
	propertyId,
	def,
	suggestions,
	layout,
	onEdit,
	autoEdit,
	onAutoEditHandled,
}: {
	entity: EntityRow;
	propertyId: string;
	/** The effective def for this column (catalog or inferred); `null` ⇒
	 *  render read-only. Computed once per column by the view. */
	def: PropertyDef | null;
	/** Existing distinct values for a select-like text column — the cell edits
	 *  them as a type-or-pick combobox (DS-cell-combobox-1). Absent ⇒ plain
	 *  inline editor. */
	suggestions?: readonly string[] | undefined;
	layout: "cell" | "inline";
	onEdit: EntityPropertyEdit | undefined;
	/** Keyboard begin-editing signal (the grid's Enter-to-edit, 12.4); the SDK
	 *  cell opens its editor on the rising edge. Read-only paints ignore it. */
	autoEdit?: boolean;
	onAutoEditHandled?: () => void;
}): ReactElement {
	const raw = readPropertyPath(entity, propertyId);
	const Cell = def ? getCell(def.valueType, defaultViewFor(def)) : undefined;

	if (!onEdit || !def || !Cell) {
		return (
			<DomSlot
				build={() => paintPropertyValue(entity, propertyId, layout)}
				deps={[entity.id, propertyId, raw]}
			/>
		);
	}

	return (
		<Cell
			property={def}
			value={toCellValue(def, raw)}
			onChange={(next) => onEdit(entity, propertyId, toDbValue(def, next))}
			readOnly={false}
			noteId={entity.id}
			siblings={entity.properties}
			{...(suggestions !== undefined ? { suggestions } : {})}
			{...(autoEdit !== undefined ? { autoEdit } : {})}
			{...(onAutoEditHandled !== undefined ? { onAutoEditHandled } : {})}
		/>
	);
}
