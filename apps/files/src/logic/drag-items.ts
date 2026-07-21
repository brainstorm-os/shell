/**
 * Build the cross-app drag payload (`ObjectDragItem`, §Part
 * III, DND-4) for a drag starting on a Files content row. Reference-only by
 * construction — ids + label + optional icon glyph, never the entity's bytes or
 * property values.
 *
 * Drag-the-set semantics (mirrors the Database grid): if the entry the gesture
 * began on is part of the current selection, the drag carries the WHOLE
 * selection in on-screen order; otherwise it carries only that one entry (so a
 * plain drag of an unselected row doesn't surprise-drag a stale selection).
 */

import type { ObjectDragItem } from "@brainstorm-os/sdk-types";
import { dragItemsForSelection } from "@brainstorm-os/sdk/object-dnd";
import { type Entity, readName } from "../types/entity";
import type { SelectionState } from "./selection";

function toDragItem(entity: Entity): ObjectDragItem {
	const icon = entity.properties.icon;
	const item: ObjectDragItem = {
		entityId: entity.id,
		entityType: entity.type,
		label: readName(entity),
	};
	if (typeof icon === "string" && icon.length > 0) item.iconRef = icon;
	return item;
}

export function dragItemsForEntry(
	dragged: Entity,
	selection: SelectionState,
	entries: readonly Entity[],
): ObjectDragItem[] {
	return dragItemsForSelection(dragged, selection.selected, entries, (e) => e.id, toDragItem);
}
