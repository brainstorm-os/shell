/**
 * 9.12.8 — persist user-created ListViews through the entities service.
 *
 * The view-lifecycle iteration's storage half: user-created views move from
 * the per-device kv payload (`PersistedState.userViews`) to
 * `brainstorm/ListView/v1` entities, so a view created on one device exists
 * everywhere the vault syncs and a ListView id is a real openable object
 * (the manifest already registers the type + a primary opener). Mirrors
 * `list-persistence` (9.3.5.V 7b-wire) exactly — same service slice, same
 * create-or-update keyed by the view's own id, same reconcile diff through
 * the shared `planEntityReconcile`. Vault-derived views (`view_vault_*`)
 * are NOT persisted here — they regenerate from the snapshot every load and
 * their user tweaks ride in `viewOverrides`.
 */

import {
	LIST_VIEW_ENTITY_TYPE,
	entityToListView,
	listViewToEntityProperties,
} from "@brainstorm-os/sdk";
import type { EntitiesService, ListView } from "@brainstorm-os/sdk-types";
import { type ReconcilePlan, planEntityReconcile } from "./list-persistence";

/** The slice of the entities service this adapter needs — identical to
 *  `ListEntitiesService` so one injected stub serves both reconcilers. */
export type ViewEntitiesService = Pick<
	EntitiesService,
	"create" | "update" | "delete" | "query" | "get"
>;

/** Load every user-created ListView from `entities.db`. Rows the codec
 *  rejects (foreign type, missing listId, unknown kind) are filtered out,
 *  so one bad row never breaks the load. */
export async function loadUserViews(svc: ViewEntitiesService): Promise<ListView[]> {
	const rows = await svc.query({ type: LIST_VIEW_ENTITY_TYPE });
	const views: ListView[] = [];
	for (const row of rows) {
		const view = entityToListView(row);
		if (view) views.push(view);
	}
	return views;
}

/** Create-or-update a user ListView as a `brainstorm/ListView/v1` entity,
 *  keyed by the view's own id (so a re-save overwrites in place). */
export async function saveUserView(svc: ViewEntitiesService, view: ListView): Promise<void> {
	const properties = listViewToEntityProperties(view);
	const existing = await svc.get(view.id);
	if (existing) {
		await svc.update(view.id, properties);
	} else {
		await svc.create(LIST_VIEW_ENTITY_TYPE, properties, view.id);
	}
}

/** Remove a user ListView (soft-delete through the entities service). */
export async function deleteUserView(svc: ViewEntitiesService, id: string): Promise<void> {
	await svc.delete(id);
}

/** Canonical serialized form of a ListView for change detection. */
export function serializeViewForReconcile(view: ListView): string {
	return JSON.stringify(view);
}

export type ViewReconcilePlan = ReconcilePlan<ListView>;

export function planViewReconcile(
	current: ListView[],
	snapshot: ReadonlyMap<string, string>,
): ViewReconcilePlan {
	return planEntityReconcile(current, snapshot, serializeViewForReconcile);
}
