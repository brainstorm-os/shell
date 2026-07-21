import { LIST_ENTITY_TYPE } from "@brainstorm-os/sdk";
import {
	type Entity,
	type EntityQuery,
	IconKind,
	type List,
	ListSourceKind,
} from "@brainstorm-os/sdk-types";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ListEntitiesService,
	deleteUserList,
	loadUserLists,
	planListReconcile,
	saveUserList,
	serializeListForReconcile,
} from "./list-persistence";

const NOW = 1_700_000_000_000;

/** Minimal in-memory entities service covering the adapter's slice. */
function fakeEntities(seed: Entity[] = []) {
	const store = new Map<string, Entity>(seed.map((e) => [e.id, e]));
	const svc: ListEntitiesService & { store: Map<string, Entity> } = {
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

function sampleList(overrides: Partial<List> = {}): List {
	return {
		id: "list-projects",
		name: "Projects",
		icon: { kind: IconKind.Emoji, value: "📁" },
		description: "",
		source: { kind: ListSourceKind.ByType, types: ["brainstorm/Project/v1"] },
		members: { include: [], exclude: [] },
		views: ["view-grid"],
		defaultViewId: "view-grid",
		defaultTemplate: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

describe("list-persistence", () => {
	let svc: ReturnType<typeof fakeEntities>;
	beforeEach(() => {
		svc = fakeEntities();
	});

	it("creates a new List entity when none exists", async () => {
		await saveUserList(svc, sampleList());
		const row = svc.store.get("list-projects");
		expect(row?.type).toBe(LIST_ENTITY_TYPE);
		expect(row?.properties.name).toBe("Projects");
		expect(row?.properties).not.toHaveProperty("createdAt"); // Entity owns timestamps
	});

	it("updates in place on a second save (no duplicate)", async () => {
		await saveUserList(svc, sampleList());
		await saveUserList(svc, sampleList({ name: "Renamed" }));
		expect(svc.store.size).toBe(1);
		expect(svc.store.get("list-projects")?.properties.name).toBe("Renamed");
		expect(svc.store.get("list-projects")?.updatedAt).toBe(NOW + 1);
	});

	it("round-trips a saved List back through load (structural fields)", async () => {
		const list = sampleList();
		await saveUserList(svc, list);
		const [loaded] = await loadUserLists(svc);
		expect(loaded?.id).toBe(list.id);
		expect(loaded?.name).toBe(list.name);
		expect(loaded?.source).toEqual(list.source);
		expect(loaded?.views).toEqual(list.views);
		expect(loaded?.icon).toEqual(list.icon);
	});

	it("loads only List entities, filtering foreign types", async () => {
		svc = fakeEntities([
			{
				id: "t1",
				type: "brainstorm/Task/v1",
				properties: { name: "task" },
				createdBy: "io.brainstorm.tasks",
				createdAt: NOW,
				updatedAt: NOW,
			},
		]);
		await saveUserList(svc, sampleList());
		const lists = await loadUserLists(svc);
		expect(lists.length).toBe(1);
		expect(lists[0]?.id).toBe("list-projects");
	});

	it("deletes a List entity", async () => {
		await saveUserList(svc, sampleList());
		await deleteUserList(svc, "list-projects");
		expect(svc.store.has("list-projects")).toBe(false);
		expect(await loadUserLists(svc)).toEqual([]);
	});

	it("queries scoped to the List type", async () => {
		let queriedType: unknown;
		const spy: ListEntitiesService = {
			...svc,
			query: async (q) => {
				queriedType = q.type;
				return [];
			},
		};
		await loadUserLists(spy);
		expect(queriedType).toBe(LIST_ENTITY_TYPE);
	});
});

describe("planListReconcile", () => {
	function snapshotOf(lists: List[]): Map<string, string> {
		return new Map(lists.map((l) => [l.id, serializeListForReconcile(l)]));
	}

	it("saves a brand-new List and deletes nothing", () => {
		const list = sampleList();
		const plan = planListReconcile([list], new Map());
		expect(plan.toSave.map((l) => l.id)).toEqual(["list-projects"]);
		expect(plan.toDelete).toEqual([]);
	});

	it("is a no-op when nothing changed (amplification-loop guard)", () => {
		const list = sampleList();
		const plan = planListReconcile([list], snapshotOf([list]));
		expect(plan.toSave).toEqual([]);
		expect(plan.toDelete).toEqual([]);
	});

	it("flags only the List whose serialized form changed", () => {
		const a = sampleList({ id: "a", name: "A" });
		const b = sampleList({ id: "b", name: "B" });
		const snapshot = snapshotOf([a, b]);
		const plan = planListReconcile([{ ...a, name: "A2" }, b], snapshot);
		expect(plan.toSave.map((l) => l.id)).toEqual(["a"]);
		expect(plan.toDelete).toEqual([]);
	});

	it("queues a removed List id for deletion", () => {
		const a = sampleList({ id: "a" });
		const b = sampleList({ id: "b" });
		const plan = planListReconcile([a], snapshotOf([a, b]));
		expect(plan.toSave).toEqual([]);
		expect(plan.toDelete).toEqual(["b"]);
	});

	it("drives a real service: create, no-op, edit, delete round-trip", async () => {
		const svc = fakeEntities();
		const snapshot = new Map<string, string>();
		const apply = async (current: List[]) => {
			const plan = planListReconcile(current, snapshot);
			for (const id of plan.toDelete) {
				await deleteUserList(svc, id);
				snapshot.delete(id);
			}
			for (const l of plan.toSave) {
				await saveUserList(svc, l);
				snapshot.set(l.id, serializeListForReconcile(l));
			}
			return plan;
		};

		const list = sampleList();
		expect((await apply([list])).toSave.length).toBe(1);
		expect(svc.store.size).toBe(1);

		// Re-applying the identical state issues no writes.
		const noop = await apply([list]);
		expect(noop.toSave).toEqual([]);
		expect(noop.toDelete).toEqual([]);

		// An edit re-saves in place; removal soft-deletes.
		await apply([{ ...list, name: "Renamed" }]);
		expect(svc.store.get("list-projects")?.properties.name).toBe("Renamed");
		const del = await apply([]);
		expect(del.toDelete).toEqual(["list-projects"]);
		expect(await loadUserLists(svc)).toEqual([]);
	});
});
