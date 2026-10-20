/**
 * 9.3.5.V slice 7b — persist user-created Lists through the entities service.
 *
 * Replaces the Database app's localStorage `userLists` path with reads/writes
 * of `brainstorm/List/v1` entities, so a List is a vault-level object visible
 * cross-app (the prerequisite for 9.3.5.U.c's "Add to collection" from any
 * app, Welcome-2 template Collections, and the `9.12.13(c)` PinnedList).
 *
 * Pure orchestration over the injected entities service — the codec
 * (`@brainstorm-os/sdk`) owns the List ⇄ entity mapping; this owns the
 * create-or-update / query / delete calls. Vault-derived Lists (`list_vault_*`)
 * are NOT persisted here — they're regenerated from the vault snapshot on every
 * load, exactly as before; only user-created Lists round-trip through
 * `entities.db`.
 */

import { LIST_ENTITY_TYPE, entityToList, listToEntityProperties } from "@brainstorm-os/sdk";
import type { EntitiesService, List } from "@brainstorm-os/sdk-types";
import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";

/** The slice of the entities service this adapter needs — narrowed so a host
 *  can inject a stub and so the dependency is explicit. */
export type ListEntitiesService = Pick<
	EntitiesService,
	"create" | "update" | "delete" | "query" | "get"
>;

/** Load every user-created List from `entities.db`. Non-List rows (a mixed
 *  query, a foreign type) and rows the codec rejects are filtered out, so one
 *  bad row never breaks the load. */
export async function loadUserLists(svc: ListEntitiesService): Promise<List[]> {
	const rows = await svc.query({ type: LIST_ENTITY_TYPE });
	const lists: List[] = [];
	for (const row of rows) {
		const list = entityToList(row);
		if (list) lists.push(list);
	}
	return lists;
}

export enum SaveListOutcome {
	Created = "created",
	Saved = "saved",
	/** The persisted row is locked: nothing was written. `persisted` is the
	 *  row as it stands (null only when the row under this id is not a List),
	 *  so the caller can drop its stale local copy instead of showing a change
	 *  that never landed. */
	RefusedLocked = "refused-locked",
}

export type SaveListResult =
	| { outcome: SaveListOutcome.Created | SaveListOutcome.Saved }
	| { outcome: SaveListOutcome.RefusedLocked; persisted: List | null };

/** Create-or-update a user List as a `brainstorm/List/v1` entity, keyed by the
 *  List's own id (so a re-save overwrites in place). `get` decides the branch;
 *  the timestamps are owned by the entity, not the property bag.
 *
 *  The lock is re-read HERE, at the commit, not only at the writer's entry:
 *  every membership / rename / description write checks `isListLocked` up
 *  front, then awaits (entity creates, the 400 ms persist debounce) before
 *  this runs — a lock flipped by another surface in that window must still
 *  hold. The codec never re-encodes `locked`, so this patch is never the
 *  lock-only exemption; a locked row takes no write at all. */
export async function saveUserList(svc: ListEntitiesService, list: List): Promise<SaveListResult> {
	const properties = listToEntityProperties(list);
	const existing = await svc.get(list.id);
	if (!existing) {
		await svc.create(LIST_ENTITY_TYPE, properties, list.id);
		return { outcome: SaveListOutcome.Created };
	}
	if (isEntityLocked(existing)) {
		return { outcome: SaveListOutcome.RefusedLocked, persisted: entityToList(existing) };
	}
	await svc.update(list.id, properties);
	return { outcome: SaveListOutcome.Saved };
}

export enum DeleteListOutcome {
	Deleted = "deleted",
	RefusedLocked = "refused-locked",
}

export type DeleteListResult =
	| { outcome: DeleteListOutcome.Deleted }
	| { outcome: DeleteListOutcome.RefusedLocked; persisted: List | null };

/** Remove a user List (soft-delete through the entities service → Bin). Same
 *  commit-point lock re-read as {@link saveUserList}: a List locked since the
 *  delete was confirmed stays. */
export async function deleteUserList(
	svc: ListEntitiesService,
	id: string,
): Promise<DeleteListResult> {
	const existing = await svc.get(id);
	if (existing && isEntityLocked(existing)) {
		return { outcome: DeleteListOutcome.RefusedLocked, persisted: entityToList(existing) };
	}
	await svc.delete(id);
	return { outcome: DeleteListOutcome.Deleted };
}

/** Canonical serialized form of a List for change detection — both the
 *  load-time snapshot seed and the reconcile diff must agree on this so an
 *  unchanged List never reads as dirty. */
export function serializeListForReconcile(list: List): string {
	// The lock is read-only here (it flips through its own lock-only patch), so
	// a lock flip must never make the List look dirty and trigger a re-save.
	const { locked: _lock, ...persisted } = list;
	return JSON.stringify(persisted);
}

/** What a reconcile pass must apply to `entities.db`: the items whose
 *  serialized form changed since the last reconcile (`toSave`) and the ids
 *  the user removed (`toDelete`). Pure so the diff is unit-testable without a
 *  live service — the app applies it and updates its snapshot. */
export type ReconcilePlan<T> = { toSave: T[]; toDelete: string[] };

export type ListReconcilePlan = ReconcilePlan<List>;

/** Diff the current items against the previously-reconciled snapshot
 *  (id → serialized form). Skips unchanged items so a no-op persist issues
 *  no entity writes (and therefore no broadcast — the amplification-loop
 *  guard, [[feedback_coalesce_staleSub_callbacks]]). Shared by the List
 *  (7b-wire) and ListView (9.12.8) reconcile passes. */
export function planEntityReconcile<T extends { id: string }>(
	current: T[],
	snapshot: ReadonlyMap<string, string>,
	serialize: (item: T) => string,
): ReconcilePlan<T> {
	const currentIds = new Set(current.map((item) => item.id));
	const toDelete: string[] = [];
	for (const id of snapshot.keys()) {
		if (!currentIds.has(id)) toDelete.push(id);
	}
	const toSave: T[] = [];
	for (const item of current) {
		if (snapshot.get(item.id) !== serialize(item)) toSave.push(item);
	}
	return { toSave, toDelete };
}

export function planListReconcile(
	current: List[],
	snapshot: ReadonlyMap<string, string>,
): ListReconcilePlan {
	return planEntityReconcile(current, snapshot, serializeListForReconcile);
}
