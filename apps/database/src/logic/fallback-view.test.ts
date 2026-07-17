/**
 * F-393 — a `List/v1` without views must still open. The Anytype importer
 * mints Collections with `views: []`, and `selectList` → `resolveListView`
 * silently no-ops on a view-less List (sidebar row highlights, main pane
 * never changes). The synthesized fallback Grid closes that gap for every
 * producer, not just the importer.
 */

import { LIST_ENTITY_TYPE, entityToList, listToEntityProperties } from "@brainstorm/sdk";
import type { List as SdkList } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import type { List } from "../types/list";
import { ListViewKind } from "../types/list-view";
import { FALLBACK_VIEW_ID_PREFIX, fallbackViewId, synthesizeFallbackViews } from "./fallback-view";
import type { EntityRow } from "./in-memory-entities";
import { resolveListView } from "./list-crud";

const NOW = 1_752_700_000_000;

function makeList(overrides: Partial<List>): List {
	return {
		id: "list_x",
		name: "X",
		icon: null,
		description: "",
		source: null,
		members: { include: [], exclude: [] },
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function makeEntity(id: string, properties: Record<string, unknown>): EntityRow {
	return { id, type: "test/Note/v1", properties, createdAt: NOW, updatedAt: NOW, deletedAt: null };
}

/** The exact List shape the Anytype importer mints for a Collection
 *  (anytype-import.ts): manual members, `views: []`, no default view —
 *  round-tripped through the shared codec like the app loads it. */
function importedCollection(): List {
	const minted: SdkList = {
		id: "anytype-list-bafystunden-0a1b2c3d",
		name: "Stunden",
		icon: null,
		description: "",
		source: null,
		members: {
			include: [
				{ entityId: "ent_1", addedAt: NOW, by: "user" },
				{ entityId: "ent_2", addedAt: NOW, by: "user" },
			],
			exclude: [],
		},
		views: [],
		defaultViewId: null,
		defaultTemplate: null,
		createdAt: NOW,
		updatedAt: NOW,
	};
	const entity = {
		id: minted.id,
		type: LIST_ENTITY_TYPE,
		properties: listToEntityProperties(minted) as unknown as Record<string, unknown>,
		createdBy: "shell:import",
		createdAt: NOW,
		updatedAt: NOW,
	};
	const list = entityToList(entity);
	if (!list) throw new Error("codec rejected the imported collection");
	return list as unknown as List;
}

describe("synthesizeFallbackViews", () => {
	it("gives an imported view-less collection an openable Grid (F-393 repro)", () => {
		const list = importedCollection();
		// Repro of the bug: with no views, the open path resolves nothing.
		expect(resolveListView([], undefined, list.defaultViewId)).toBeUndefined();

		const entities = [
			makeEntity("ent_1", { title: "Stunde 8", tags: ["Kapitel 8"] }),
			makeEntity("ent_2", { title: "Stunde 9" }),
		];
		const views = synthesizeFallbackViews([list], [], entities);
		expect(views).toHaveLength(1);
		const view = views[0];
		if (!view) throw new Error("no view synthesized");
		expect(view.listId).toBe(list.id);
		expect(view.kind).toBe(ListViewKind.Grid);
		// Now the open path resolves — clicking the List shows its members.
		expect(resolveListView(views, undefined, list.defaultViewId)).toBe(view.id);
	});

	it("derives columns from the members present in the snapshot", () => {
		const list = importedCollection();
		const entities = [
			makeEntity("ent_1", { title: "Stunde 8", tags: ["Kapitel 8"] }),
			makeEntity("ent_2", { title: "Stunde 9", tags: ["Kapitel 9"] }),
			makeEntity("ent_other", { unrelated: "x" }),
		];
		const [view] = synthesizeFallbackViews([list], [], entities);
		const columns = view?.columns.map((c) => c.propertyId) ?? [];
		expect(columns[0]).toBe("title");
		expect(columns).toContain("tags");
		expect(columns).not.toContain("unrelated");
	});

	it("falls back to a title column when no member resolves", () => {
		const [view] = synthesizeFallbackViews([importedCollection()], [], []);
		expect(view?.columns.map((c) => c.propertyId)).toEqual(["title"]);
	});

	it("is a no-op for lists that already have a view", () => {
		const list = makeList({ id: "list_ok", views: ["view_1"], defaultViewId: "view_1" });
		const existing = synthesizeFallbackViews(
			[list],
			[
				{
					id: "view_1",
					listId: "list_ok",
					name: "Grid",
					icon: null,
					kind: ListViewKind.Grid,
					filters: null,
					sorts: [],
					groupBy: null,
					coverProperty: null,
					cardSubtitleProperty: null,
					columns: [],
					defaultTypeUrl: null,
					defaultTemplate: null,
					pageSize: 50,
					layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true },
				},
			],
			[],
		);
		expect(existing).toEqual([]);
	});

	it("mints a stable vault-derived id so it is regenerated, never persisted", () => {
		const list = importedCollection();
		const [first] = synthesizeFallbackViews([list], [], []);
		const [second] = synthesizeFallbackViews([list], [], []);
		expect(first?.id).toBe(second?.id);
		expect(first?.id).toBe(fallbackViewId(list.id));
		// The `view_vault_` prefix is the app's "regenerated on every rebuild"
		// classification (isVaultDerivedViewId) — overrides re-layer, the view
		// itself is never written to entities.db as a user view.
		expect(first?.id.startsWith("view_vault_")).toBe(true);
		expect(FALLBACK_VIEW_ID_PREFIX.startsWith("view_vault_")).toBe(true);
	});
});
