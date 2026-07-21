/**
 * Shared "drag-the-set" selection logic for cross-app drag sources (DND-4). The
 * rule is identical across every source app (Database rows, Files entries, …):
 * if the entity the gesture began on is part of a multi-selection, the drag
 * carries the WHOLE selection in on-screen order; otherwise it carries only that
 * one entity. Only the per-app adapters differ — how to read an entity's id and
 * how to project it to an `ObjectDragItem` (title/icon) — so those are passed in
 * and the logic lives here once (CLAUDE.md DRY: two call sites → one helper).
 */

import type { ObjectDragItem } from "@brainstorm-os/sdk-types";

export function dragItemsForSelection<T>(
	dragged: T,
	selectedIds: ReadonlySet<string>,
	ordered: readonly T[],
	getId: (item: T) => string,
	toItem: (item: T) => ObjectDragItem,
): ObjectDragItem[] {
	if (selectedIds.has(getId(dragged)) && selectedIds.size > 1) {
		return ordered.filter((item) => selectedIds.has(getId(item))).map(toItem);
	}
	return [toItem(dragged)];
}
