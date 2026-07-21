/**
 * Tests for the 9.12.8 ListView entity-persistence adapter — mirrors
 * `list-persistence.test.ts`: load filters bad rows, save is
 * create-or-update keyed by the view id, reconcile diffs only what
 * changed, and the codec round-trip survives the service hop.
 */

import { LIST_VIEW_ENTITY_TYPE } from "@brainstorm-os/sdk";
import {
	type Entity,
	type EntityQuery,
	type ListView,
	ListViewKind,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	type ViewEntitiesService,
	deleteUserView,
	loadUserViews,
	planViewReconcile,
	saveUserView,
	serializeViewForReconcile,
} from "./view-persistence";

const NOW = 1_700_000_000_000;

function fakeEntities(seed: Entity[] = []) {
	const store = new Map<string, Entity>(seed.map((e) => [e.id, e]));
	const svc: ViewEntitiesService & { store: Map<string, Entity> } = {
		store,
		get: async (id) => store.get(id) ?? null,
		query: async (q: EntityQuery) => {
			const type = q.type;
			return [...store.values()].filter((e) => (type ? e.type === type : true));
		},
		create: async (type, properties, id) => {
			const entity: Entity = {
				id: id ?? `gen-${store.size}`,
				type,
				properties,
				createdBy: "io.brainstorm.database",
				createdAt: NOW,
				updatedAt: NOW,
			};
			store.set(entity.id, entity);
			return entity;
		},
		update: async (id, patch) => {
			const prev = store.get(id);
			if (!prev) throw new Error(`no entity ${id}`);
			const next: Entity = {
				...prev,
				properties: { ...prev.properties, ...patch },
				updatedAt: NOW + 1,
			};
			store.set(id, next);
			return next;
		},
		delete: async (id) => {
			store.delete(id);
		},
	};
	return svc;
}

function makeView(id: string, name: string, kind: ListViewKind = ListViewKind.Grid): ListView {
	return {
		id,
		listId: "list_user_1",
		name,
		icon: null,
		kind,
		filters: null,
		sorts: [],
		groupBy: null,
		coverProperty: null,
		cardSubtitleProperty: null,
		columns: [{ propertyId: "name", width: 280, visible: true }],
		defaultTypeUrl: null,
		defaultTemplate: null,
		pageSize: 50,
		layoutOptions: { rowHeight: "comfortable", showRowNumbers: false, pinFirstColumn: true },
	};
}

describe("saveUserView / loadUserViews", () => {
	it("creates on first save, updates in place on re-save", async () => {
		const svc = fakeEntities();
		const view = makeView("view_u1", "My grid");
		await saveUserView(svc, view);
		expect(svc.store.get("view_u1")?.type).toBe(LIST_VIEW_ENTITY_TYPE);

		await saveUserView(svc, { ...view, name: "Renamed" });
		expect(svc.store.size).toBe(1);
		const loaded = await loadUserViews(svc);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.name).toBe("Renamed");
	});

	it("round-trips the full view shape through the service hop", async () => {
		const svc = fakeEntities();
		const view: ListView = {
			...makeView("view_u2", "Board", ListViewKind.Board),
			groupBy: { propertyId: "statusKey" },
			manualOrder: ["a", "b"],
		};
		await saveUserView(svc, view);
		const loaded = await loadUserViews(svc);
		expect(loaded[0]).toEqual(view);
	});

	it("filters out rows the codec rejects (one bad row never breaks the load)", async () => {
		const svc = fakeEntities([
			{
				id: "view_bad",
				type: LIST_VIEW_ENTITY_TYPE,
				properties: { kind: "grid" }, // no listId
				createdBy: "io.brainstorm.database",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: "not_a_view",
				type: "brainstorm/List/v1",
				properties: {},
				createdBy: "io.brainstorm.database",
				createdAt: NOW,
				updatedAt: NOW,
			},
		]);
		await saveUserView(svc, makeView("view_ok", "Fine"));
		const loaded = await loadUserViews(svc);
		expect(loaded.map((v) => v.id)).toEqual(["view_ok"]);
	});

	it("deleteUserView removes the entity", async () => {
		const svc = fakeEntities();
		await saveUserView(svc, makeView("view_u3", "Gone soon"));
		await deleteUserView(svc, "view_u3");
		expect(await loadUserViews(svc)).toEqual([]);
	});
});

describe("planViewReconcile", () => {
	it("saves only changed views and deletes removed ids", () => {
		const a = makeView("view_a", "A");
		const b = makeView("view_b", "B");
		const snapshot = new Map([
			["view_a", serializeViewForReconcile(a)],
			["view_gone", "{}"],
		]);
		const plan = planViewReconcile([a, { ...b, name: "B2" }], snapshot);
		expect(plan.toSave.map((v) => v.id)).toEqual(["view_b"]);
		expect(plan.toDelete).toEqual(["view_gone"]);
	});

	it("an unchanged set is a no-op plan (no writes, no broadcast)", () => {
		const a = makeView("view_a", "A");
		const snapshot = new Map([["view_a", serializeViewForReconcile(a)]]);
		const plan = planViewReconcile([a], snapshot);
		expect(plan.toSave).toEqual([]);
		expect(plan.toDelete).toEqual([]);
	});
});
