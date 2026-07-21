/**
 * Build the cross-app drag payload (`ObjectDragItem`, §Part
 * III) for a drag starting on a Database row. Reference-only by construction —
 * ids + label + optional icon glyph, never the row's property values.
 *
 * Drag-the-set semantics (mirrors Files): if the row the gesture began on is
 * part of the current selection, the drag carries the WHOLE selection; otherwise
 * it carries only that one row (so a plain drag of an unselected row doesn't
 * surprise-drag a stale selection).
 */

import type { ObjectDragItem } from "@brainstorm-os/sdk-types";
import { dragItemsForSelection } from "@brainstorm-os/sdk/object-dnd";
import { entityTitle } from "../render/cells";
import type { EntityRow } from "./in-memory-entities";

function toDragItem(entity: EntityRow): ObjectDragItem {
	const icon = entity.properties.icon;
	const item: ObjectDragItem = {
		entityId: entity.id,
		entityType: entity.type,
		label: entityTitle(entity),
	};
	if (typeof icon === "string" && icon.length > 0) item.iconRef = icon;
	return item;
}

export function dragItemsForRow(
	dragged: EntityRow,
	selectedIds: ReadonlySet<string>,
	rows: readonly EntityRow[],
): ObjectDragItem[] {
	return dragItemsForSelection(dragged, selectedIds, rows, (r) => r.id, toDragItem);
}
