/**
 * Bulk edit over a multi-selection (9.12.32): "Set property…" and "Add to
 * collection…". Each plan is ONE undo step — the inverse is captured up
 * front so the host can revert the whole batch at once. Locked records are
 * skipped (the advisory read-only lock gates every write path) and counted
 * so the host can say how many were left alone.
 */

import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";
import type { List } from "../types/list";
import { sourceMatches } from "./collections-for-entity";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";
import { AddOutcome, MembersCapacityError, addToList } from "./members";

export type EntityPatch = { id: string; patch: Record<string, unknown> };

export enum BulkUndoKind {
	SetProperty = "set-property",
	AddToCollection = "add-to-collection",
}

export type BulkUndo =
	| { kind: BulkUndoKind.SetProperty; revert: EntityPatch[] }
	| { kind: BulkUndoKind.AddToCollection; listId: string; previous: List };

export type BulkSetPlan = {
	apply: EntityPatch[];
	undo: BulkUndo;
	lockedSkipped: number;
};

/** Which selected rows the batch may touch: present, and not locked. */
function partition(
	rows: ReadonlyArray<EntityRow>,
	ids: ReadonlySet<string>,
): { writable: EntityRow[]; lockedSkipped: number } {
	const writable: EntityRow[] = [];
	let lockedSkipped = 0;
	for (const row of rows) {
		if (!ids.has(row.id)) continue;
		if (isEntityLocked(row)) lockedSkipped += 1;
		else writable.push(row);
	}
	return { writable, lockedSkipped };
}

/** Set `propertyId = value` on every writable selected row whose value
 *  differs. The undo restores each row's previous value (`null` for a
 *  property the row did not carry). */
export function planBulkSet(
	rows: ReadonlyArray<EntityRow>,
	ids: ReadonlySet<string>,
	propertyId: string,
	value: unknown,
): BulkSetPlan {
	const { writable, lockedSkipped } = partition(rows, ids);
	const apply: EntityPatch[] = [];
	const revert: EntityPatch[] = [];
	for (const row of writable) {
		const previous = row.properties[propertyId];
		if (Object.is(previous, value)) continue;
		apply.push({ id: row.id, patch: { [propertyId]: value } });
		revert.push({ id: row.id, patch: { [propertyId]: previous ?? null } });
	}
	return { apply, undo: { kind: BulkUndoKind.SetProperty, revert }, lockedSkipped };
}

export type BulkAddPlan = {
	next: List;
	added: number;
	lockedSkipped: number;
	/** Rows not added because the list hit the members hard cap. */
	overCapacity: number;
	undo: BulkUndo;
};

/** Add every writable selected row to `list` in one members write. */
export function planBulkAddToList(
	list: List,
	rows: ReadonlyArray<EntityRow>,
	ids: ReadonlySet<string>,
	db: InMemoryEntities,
	now: number = Date.now(),
): BulkAddPlan {
	const { writable, lockedSkipped } = partition(rows, ids);
	let members = list.members;
	let added = 0;
	let overCapacity = 0;
	for (const row of writable) {
		try {
			const result = addToList(members, row.id, {
				matchesSource: sourceMatches(row.id, list, db),
				by: "user",
				now,
			});
			if (result.outcome !== AddOutcome.NoOp) added += 1;
			members = result.members;
		} catch (error) {
			if (!(error instanceof MembersCapacityError)) throw error;
			overCapacity += 1;
		}
	}
	return {
		next: added > 0 ? { ...list, members, updatedAt: now } : list,
		added,
		lockedSkipped,
		overCapacity,
		undo: { kind: BulkUndoKind.AddToCollection, listId: list.id, previous: list },
	};
}
