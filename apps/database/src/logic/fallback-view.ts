/**
 * F-393 — synthesize a default Grid view for any List that has none.
 *
 * A `brainstorm/List/v1` entity is a cross-app object: the Anytype importer
 * mints one per Collection (`views: []`), and any app holding the List write
 * capability may create one without views. The Database app's open path
 * (`selectList` → `resolveListView`) silently no-ops on a view-less List, so
 * such a List showed in the sidebar (with its member badge) but clicking it
 * never changed the main pane. Rather than making every producer mint a
 * ListView, the consumer synthesizes one:
 *
 *   - **Stable, vault-derived id** (`view_vault_listfallback_<listId>`): the
 *     `view_vault_` prefix means it is never persisted as a user view and the
 *     user's tweaks to it ride the existing per-view `viewOverrides`
 *     mechanism, exactly like the type-list grids `buildVaultLists` mints.
 *   - **Columns from the members**: derived over the List's manual
 *     `members.include` rows present in the snapshot (`deriveColumns`), so an
 *     imported collection opens on a grid of its members' real properties.
 *
 * Pure + deterministic — call it at every state-composition point; it only
 * returns views for lists that still have none.
 */

import type { List } from "../types/list";
import { EmptyPlacement, type ListView, ListViewKind, SortDirection } from "../types/list-view";
import type { EntityRow } from "./in-memory-entities";
import { deriveColumns } from "./vault-lists";

/** Rides the `view_vault_` prefix so `isVaultDerivedViewId` classifies it as
 *  regenerated (never persisted as a user view, overrides re-layered). */
export const FALLBACK_VIEW_ID_PREFIX = "view_vault_listfallback_";

export function fallbackViewId(listId: string): string {
	return `${FALLBACK_VIEW_ID_PREFIX}${listId}`;
}

/** Synthesize a Grid view for every list in `lists` that has no view in
 *  `views`. `entities` (the current snapshot's rows) feeds column derivation;
 *  members missing from it simply don't contribute columns (`title` is the
 *  floor). Returns only the new views — the caller appends them. */
export function synthesizeFallbackViews(
	lists: ReadonlyArray<List>,
	views: ReadonlyArray<ListView>,
	entities: ReadonlyArray<EntityRow>,
): ListView[] {
	const listIdsWithViews = new Set(views.map((v) => v.listId));
	const byId = new Map(entities.map((e) => [e.id, e] as const));
	const out: ListView[] = [];
	for (const list of lists) {
		if (listIdsWithViews.has(list.id)) continue;
		const members = list.members.include
			.map((m) => byId.get(m.entityId))
			.filter((e): e is EntityRow => e !== undefined);
		out.push(fallbackGridView(list.id, deriveColumns(members)));
	}
	return out;
}

function fallbackGridView(listId: string, columnIds: string[]): ListView {
	return {
		id: fallbackViewId(listId),
		listId,
		name: "Grid",
		icon: null,
		kind: ListViewKind.Grid,
		filters: null,
		sorts: [
			{
				propertyId: "updatedAt",
				direction: SortDirection.Desc,
				emptyPlacement: EmptyPlacement.End,
			},
		],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns: columnIds.map((propertyId, i) => ({
			propertyId,
			width: i === 0 ? 280 : 160,
			visible: true,
		})),
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: {
			rowHeight: "comfortable",
			showRowNumbers: false,
			pinFirstColumn: true,
		},
	};
}
