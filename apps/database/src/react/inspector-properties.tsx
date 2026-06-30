/**
 * InspectorProperties — the selected entity's property list in the Database
 * inspector, rendered through the SHARED `<PropertiesPanel>` content (the same
 * `.bs-props` rows every other app's inspector uses) so the property surface is
 * identical across apps. The header is hidden — the imperative inspector prints
 * its own "Properties" section title above this subtree.
 *
 * Each row resolves an effective def (catalog, else inferred from the value)
 * for the label, and supplies an `EditableCell` as the row's `valueNode`:
 * `EditableCell` mounts the matching shared cell when editable and falls back
 * to the read-only paint otherwise (arrays / rich text / system fields), so a
 * heterogeneous property bag still renders richly — richer than the panel's
 * default scalar cell. Wrapped by the caller in `<PropertiesProvider>` so Tag /
 * Link editors reach the vault catalog.
 */

import { type PropertyDef, ValueType } from "@brainstorm/sdk-types";
import { PropertiesPanel, type PropertiesPanelRow } from "@brainstorm/sdk/properties-panel";
import type { ReactElement } from "react";
import { effectiveColumnDef } from "../logic/effective-def";
import { type EntityRow, readPropertyPath } from "../logic/in-memory-entities";
import { humanize } from "../ui/humanize";
import { EditableCell, type EntityPropertyEdit } from "./editable-cell";

/** Properties the inspector renders elsewhere (title in the header, cover
 *  band, name as the heading) — skipped from the value list. */
const SKIP_KEYS: ReadonlySet<string> = new Set(["title", "name", "cover"]);

export function InspectorProperties({
	entity,
	onEdit,
}: {
	entity: EntityRow;
	/** Absent ⇒ the record is read-only (locked): every cell paints read-only. */
	onEdit: EntityPropertyEdit | undefined;
}): ReactElement {
	const keys = Object.keys(entity.properties).filter((k) => !SKIP_KEYS.has(k));
	const rows: PropertiesPanelRow[] = keys.map((key) => {
		// One effective def drives both the label and the editing cell: a
		// user-created property has a generated key (`prop_<…>`) but a real
		// display name in the catalog, so the row must read "Status", not
		// "Prop Mpx6xww2 2vzk7i" (F-017, inspector surface).
		const def = effectiveColumnDef(key, [entity]);
		const labelDef: PropertyDef = {
			key,
			name: def?.name?.trim() ? def.name : humanize(key),
			icon: def?.icon ?? null,
			valueType: def?.valueType ?? ValueType.Text,
		};
		return {
			def: labelDef,
			value: readPropertyPath(entity, key),
			valueNode: (
				<EditableCell entity={entity} propertyId={key} def={def} layout="cell" onEdit={onEdit} />
			),
		};
	});
	return <PropertiesPanel title="" hideHeader rows={rows} entityId={entity.id} />;
}
