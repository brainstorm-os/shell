/**
 * Bulk edit over a multi-selection (9.12.32): "Set property…" and "Add to
 * collection…". Each plan is ONE undo step — the inverse is captured up
 * front so the host can revert the whole batch at once. Locked records are
 * skipped (the advisory read-only lock gates every write path) and counted
 * so the host can say how many were left alone.
 */

import type { MemberExclude } from "@brainstorm-os/sdk-types";
import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";
import type { List } from "../types/list";
import { sourceMatches } from "./collections-for-entity";
import type { EntityRow, InMemoryEntities } from "./in-memory-entities";
import { isListLocked } from "./list-lock";
import { AddOutcome, MembersCapacityError, addToList } from "./members";

export type EntityPatch = { id: string; patch: Record<string, unknown> };

export enum BulkUndoKind {
	SetProperty = "set-property",
	AddToCollection = "add-to-collection",
}

/** How long the one-step bulk undo stays offered. A Mod+Z long after the
 *  batch is not a "take that back" the user can still picture. */
export const BULK_UNDO_TTL_MS = 60_000;

/** The undo is TARGETED, never a snapshot restore: it reverts only what the
 *  batch itself wrote, so later renames / pins / drops / cell edits made
 *  after the batch survive a late Mod+Z. */
export type BulkUndo =
	| {
			kind: BulkUndoKind.SetProperty;
			at: number;
			propertyId: string;
			/** The value the batch wrote — a row no longer holding it was edited
			 *  since, and its later edit wins over the undo. */
			applied: unknown;
			revert: EntityPatch[];
	  }
	| {
			kind: BulkUndoKind.AddToCollection;
			at: number;
			listId: string;
			/** Ids the batch appended to `include`. */
			included: string[];
			/** Exclude records the batch lifted. */
			unexcluded: MemberExclude[];
	  };

export function isBulkUndoLive(undo: BulkUndo | null, now: number = Date.now()): boolean {
	return undo !== null && now - undo.at <= BULK_UNDO_TTL_MS;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

export type BulkSetRevertPlan = {
	apply: EntityPatch[];
	/** Rows locked since the batch — the lock gates the revert too. */
	lockedSkipped: number;
	/** Rows edited since the batch — their newer value is kept. */
	changedSkipped: number;
};

/** The revert of a "Set property" batch against the rows as they are NOW:
 *  locked rows and rows whose value moved on since the batch are left alone. */
export function planBulkSetRevert(
	undo: Extract<BulkUndo, { kind: BulkUndoKind.SetProperty }>,
	rows: ReadonlyArray<EntityRow>,
): BulkSetRevertPlan {
	const byId = new Map(rows.map((r) => [r.id, r]));
	const apply: EntityPatch[] = [];
	let lockedSkipped = 0;
	let changedSkipped = 0;
	for (const entry of undo.revert) {
		const row = byId.get(entry.id);
		if (!row) continue;
		if (isEntityLocked(row)) {
			lockedSkipped += 1;
			continue;
		}
		if (!sameValue(row.properties[undo.propertyId], undo.applied)) {
			changedSkipped += 1;
			continue;
		}
		apply.push(entry);
	}
	return { apply, lockedSkipped, changedSkipped };
}

/** The list with an "Add to collection" batch taken back: the includes it
 *  appended are dropped and the excludes it lifted come back — everything
 *  else about the list (name, pins, later drops) is the CURRENT list's. */
export function revertBulkAdd(
	list: List,
	undo: Extract<BulkUndo, { kind: BulkUndoKind.AddToCollection }>,
	now: number = Date.now(),
): List {
	if (isListLocked(list)) return list;
	const included = new Set(undo.included);
	const include = list.members.include.filter((m) => !included.has(m.entityId));
	const present = new Set([
		...include.map((m) => m.entityId),
		...list.members.exclude.map((m) => m.entityId),
	]);
	const restored = undo.unexcluded.filter((m) => !present.has(m.entityId));
	if (include.length === list.members.include.length && restored.length === 0) return list;
	return {
		...list,
		members: { include, exclude: [...list.members.exclude, ...restored] },
		updatedAt: now,
	};
}

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
	now: number = Date.now(),
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
	return {
		apply,
		undo: { kind: BulkUndoKind.SetProperty, at: now, propertyId, applied: value, revert },
		lockedSkipped,
	};
}

export type BulkAddPlan = {
	next: List;
	added: number;
	lockedSkipped: number;
	/** Rows not added because the list hit the members hard cap. */
	overCapacity: number;
	/** The List itself is locked — nothing was added. */
	listLocked: boolean;
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
	if (isListLocked(list)) {
		return {
			next: list,
			added: 0,
			lockedSkipped,
			overCapacity: 0,
			listLocked: true,
			undo: {
				kind: BulkUndoKind.AddToCollection,
				at: now,
				listId: list.id,
				included: [],
				unexcluded: [],
			},
		};
	}
	let members = list.members;
	let added = 0;
	let overCapacity = 0;
	const included: string[] = [];
	const unexcluded: MemberExclude[] = [];
	for (const row of writable) {
		try {
			const lifted = members.exclude.find((m) => m.entityId === row.id);
			const result = addToList(members, row.id, {
				matchesSource: sourceMatches(row.id, list, db),
				by: "user",
				now,
			});
			if (result.outcome !== AddOutcome.NoOp) added += 1;
			if (lifted && !result.members.exclude.some((m) => m.entityId === row.id))
				unexcluded.push(lifted);
			if (result.outcome === AddOutcome.Included) included.push(row.id);
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
		listLocked: false,
		undo: { kind: BulkUndoKind.AddToCollection, at: now, listId: list.id, included, unexcluded },
	};
}
