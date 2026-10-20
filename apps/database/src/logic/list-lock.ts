/**
 * The read-only lock on a List (9.16.14). A locked List refuses every
 * membership write — toggle add/remove, bulk add, file drop, board drop,
 * "+ New" pinning — the same reading the SDK object menu's
 * `toggleCollectionMembership` and Journal apply. The lock is the shared
 * `properties.locked` (`@brainstorm-os/sdk/entity-lock`); the List codec
 * decodes it at load, and `withLiveListLocks` keeps it current when another
 * surface flips it while Database is open.
 */

import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";
import type { List } from "../types/list";
import type { EntityRow } from "./in-memory-entities";

export function isListLocked(list: Pick<List, "locked"> | null | undefined): boolean {
	return list?.locked === true;
}

/** The Lists with `locked` re-read from their live entity rows. A List with
 *  no row in the snapshot (vault-derived, not yet synced) keeps what it had. */
export function withLiveListLocks(lists: readonly List[], rows: readonly EntityRow[]): List[] {
	const ids = new Set(lists.map((l) => l.id));
	const lockedById = new Map<string, boolean>();
	for (const row of rows) if (ids.has(row.id)) lockedById.set(row.id, isEntityLocked(row));
	return lists.map((list) => {
		const live = lockedById.get(list.id);
		if (live === undefined || live === isListLocked(list)) return list;
		if (live) return { ...list, locked: true };
		const { locked: _dropped, ...unlocked } = list;
		return unlocked;
	});
}
