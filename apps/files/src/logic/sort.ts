/**
 * Sort options for the folder-contents list.
 *
 * Wire values mirror the `Folder/v1.sortBy` schema in
 * . `Manual` preserves the
 * current member order (i.e. drop the comparator) so future drag-to-
 * reorder + per-folder ordering can land without changing this surface.
 */

import { type Entity, hasDisplayName, readName, readSize } from "../types/entity";

export enum SortKey {
	Manual = "manual",
	Name = "name",
	Created = "created",
	Modified = "modified",
	Size = "size",
}

export enum SortDirection {
	Asc = "asc",
	Desc = "desc",
}

export const DEFAULT_SORT_KEY: SortKey = SortKey.Manual;
export const DEFAULT_SORT_DIRECTION: SortDirection = SortDirection.Asc;

/** The v1 default direction per sort key — Name asc, dates desc (newest
 *  first) feels natural in a Finder-like surface. */
export function defaultDirectionFor(key: SortKey): SortDirection {
	if (key === SortKey.Created || key === SortKey.Modified || key === SortKey.Size) {
		return SortDirection.Desc;
	}
	return SortDirection.Asc;
}

/** Return a new array sorted according to `key`+`direction`. Stable; for
 *  `Manual` returns the input order (a defensive copy so callers can mutate
 *  freely). Comparator uses `localeCompare` for names with `numeric:true`
 *  so `file2 < file10`. */
export function sortEntities(
	entities: readonly Entity[],
	key: SortKey,
	direction: SortDirection,
): Entity[] {
	const copy = entities.slice();
	if (key === SortKey.Manual) return copy;
	const sign = direction === SortDirection.Asc ? 1 : -1;
	copy.sort((a, b) => {
		// Untitled entities sink below named ones in a NAME sort, in BOTH
		// directions (outside the sign flip) — "(untitled)" is a display
		// fallback, and its "(" collating first put a wall of anonymous
		// tiles at the top of every vault view (F-424).
		if (key === SortKey.Name) {
			const aNamed = hasDisplayName(a);
			const bNamed = hasDisplayName(b);
			if (aNamed !== bNamed) return aNamed ? -1 : 1;
		}
		const cmp = compareBy(a, b, key);
		return cmp * sign;
	});
	return copy;
}

function compareBy(a: Entity, b: Entity, key: SortKey): number {
	if (key === SortKey.Name) {
		return readName(a).localeCompare(readName(b), undefined, {
			numeric: true,
			sensitivity: "base",
		});
	}
	if (key === SortKey.Created) return numericCompare(a.createdAt, b.createdAt);
	if (key === SortKey.Modified) return numericCompare(a.updatedAt, b.updatedAt);
	if (key === SortKey.Size) return numericCompare(readSize(a), readSize(b));
	return 0;
}

function numericCompare(a: number, b: number): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}
