/**
 * Cross-app "Add to collection" data layer (9.3.5.V 7c).
 *
 * Now that user Lists/Collections are `brainstorm/List/v1` entities in
 * `entities.db`, any app holding `entities.read/write:brainstorm/List/v1`
 * can surface the same "Add to collection" affordance from the shared object
 * menu — listing the user's Collections and toggling THIS object's membership
 * — without each app reimplementing it. This is the headless data half; the
 * object-menu renderer (`openObjectMenu`) drives the picker chrome.
 *
 * Scope: the **manual** membership layer only (`members.include`). A
 * source/query Collection's rule-based membership is a Database concern — the
 * cross-app surface toggles the explicit inclusion a user clicks, which is
 * why `addToList`/`removeFromList` run with `matchesSource: false`.
 */

import type { Entity, EntityQuery, Icon, MemberOverrideSource } from "@brainstorm-os/sdk-types";
import { AddOutcome, RemoveOutcome, addToList, removeFromList } from "../collections";
import { LIST_ENTITY_TYPE, entityToList } from "../list-entity-codec";

/** The slice of the entities service the collection surface needs — narrowed
 *  so a host/test can inject a stub. Each method is a per-type-gated call on
 *  the real `services.entities`. */
export type CollectionsEntitiesService = {
	query(query: EntityQuery): Promise<Entity[]>;
	get(id: string): Promise<Entity | null>;
	update(id: string, patch: Record<string, unknown>): Promise<Entity>;
};

/** The capability an app must hold to write Collection membership — the same
 *  type-scoped grant Database already declares, narrow to `List/v1`. */
export const COLLECTIONS_WRITE_CAPABILITY = `entities.write:${LIST_ENTITY_TYPE}`;

/** One row in the collection picker — a user Collection plus whether THIS
 *  object is currently a manual member of it. */
export type CollectionOption = {
	id: string;
	name: string;
	icon: Icon | null;
	/** Manual member — the entity is in `members.include`. */
	isMember: boolean;
};

/** List the user's Collections with this entity's manual-membership state.
 *  Foreign rows / malformed Lists are dropped (the codec returns `null`), so
 *  one bad row never breaks the picker. */
export async function listCollectionsForObject(
	svc: CollectionsEntitiesService,
	entityId: string,
): Promise<CollectionOption[]> {
	const rows = await svc.query({ type: LIST_ENTITY_TYPE });
	const options: CollectionOption[] = [];
	for (const row of rows) {
		const list = entityToList(row);
		if (!list) continue;
		options.push({
			id: list.id,
			name: list.name,
			icon: list.icon,
			isMember: list.members.include.some((m) => m.entityId === entityId),
		});
	}
	return options;
}

/** Toggle this entity's MANUAL membership of a Collection. `add` is the
 *  intent (true = ensure member). Writes only when membership actually
 *  changed (so a no-op never broadcasts). Returns the resulting membership
 *  state; `false` if the Collection can't be loaded. */
export async function toggleCollectionMembership(
	svc: CollectionsEntitiesService,
	listId: string,
	entityId: string,
	add: boolean,
	appId: string,
): Promise<boolean> {
	const row = await svc.get(listId);
	const list = row ? entityToList(row) : null;
	if (!list) return false;
	const ctx = { matchesSource: false, by: `app:${appId}` as MemberOverrideSource };
	const result = add
		? addToList(list.members, entityId, ctx)
		: removeFromList(list.members, entityId, ctx);
	const changed = add ? result.outcome !== AddOutcome.NoOp : result.outcome !== RemoveOutcome.NoOp;
	if (changed) await svc.update(listId, { members: result.members });
	return add;
}
