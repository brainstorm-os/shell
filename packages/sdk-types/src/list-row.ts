/**
 * What a "+ New" row IS in a Collection (`List/v1`) — the shared decision the
 * Database app's create path and the Agent app's row proposals (Agent-11d) both
 * need, so it lives in the contract leaf rather than app-side.
 *
 * A **typed list** (`ByType` source, e.g. Tasks) creates one entity of that type
 * and lets the source pick it up — the row already "belongs" by virtue of its
 * type. A **manual / custom collection** (no concrete type source — a CRM, a
 * reading list, anything the user built from scratch) has no type to mint, so it
 * creates a generic `brainstorm/Object/v1` — a blank object carrying only the
 * collection's own columns — and pins it into the collection's manual members so
 * it shows up. (Owner decision 2026-06-02, F-008b: collection rows are generic
 * Objects, not new user-defined types.)
 */

import { type ListSource, ListSourceKind } from "./list";

/** The generic object type minted for rows in a user-defined collection. */
export const GENERIC_OBJECT_TYPE = "brainstorm/Object/v1";

export type RowCreatePlan = {
	/** The entity type to instantiate for the new row. */
	type: string;
	/** Whether the new entity must be pinned into the list's manual members
	 *  (true for collections with no concrete type source). */
	addToMembers: boolean;
};

export function decideRowCreate(list: { source: ListSource | null } | null): RowCreatePlan {
	const source = list?.source;
	if (source && source.kind === ListSourceKind.ByType && source.types[0]) {
		return { type: source.types[0], addToMembers: false };
	}
	return { type: GENERIC_OBJECT_TYPE, addToMembers: true };
}
