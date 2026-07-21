// @vitest-environment jsdom
import type { Entity, EntityQuery } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIST_ENTITY_TYPE } from "../list-entity-codec";
import {
	type CollectionsEntitiesService,
	listCollectionsForObject,
	toggleCollectionMembership,
} from "./collections";
import { closeObjectMenu, openObjectMenu } from "./open-object-menu";

const NOW = 1_700_000_000_000;

function listEntity(id: string, name: string, includeIds: string[] = []): Entity {
	return {
		id,
		type: LIST_ENTITY_TYPE,
		properties: {
			name,
			icon: null,
			description: "",
			source: null,
			members: {
				include: includeIds.map((entityId) => ({ entityId, addedAt: NOW, by: "user" })),
				exclude: [],
			},
			views: [],
			defaultViewId: null,
		},
		createdBy: "io.brainstorm.test",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function fakeService(seed: Entity[] = []) {
	const store = new Map<string, Entity>(seed.map((e) => [e.id, e]));
	const svc: CollectionsEntitiesService & { store: Map<string, Entity> } = {
		store,
		query: async (q: EntityQuery) =>
			[...store.values()].filter((e) => (q.type ? e.type === q.type : true)),
		get: async (id) => store.get(id) ?? null,
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
	};
	return svc;
}

describe("listCollectionsForObject", () => {
	it("returns each user Collection with this entity's manual-membership state", async () => {
		const svc = fakeService([
			listEntity("c1", "Reading", ["note-1"]),
			listEntity("c2", "Archive", []),
		]);
		const options = await listCollectionsForObject(svc, "note-1");
		expect(options.map((o) => [o.name, o.isMember])).toEqual([
			["Reading", true],
			["Archive", false],
		]);
	});

	it("drops foreign / malformed rows (codec returns null)", async () => {
		const svc = fakeService([
			listEntity("c1", "Reading"),
			{
				id: "t1",
				type: "brainstorm/Task/v1",
				properties: { name: "task" },
				createdBy: "x",
				createdAt: NOW,
				updatedAt: NOW,
			},
		]);
		const options = await listCollectionsForObject(svc, "anything");
		expect(options.map((o) => o.id)).toEqual(["c1"]);
	});
});

describe("toggleCollectionMembership", () => {
	it("adds a manual member (writes members.include)", async () => {
		const svc = fakeService([listEntity("c1", "Reading")]);
		const result = await toggleCollectionMembership(svc, "c1", "note-1", true, "notes");
		expect(result).toBe(true);
		const members = svc.store.get("c1")?.properties.members as { include: { entityId: string }[] };
		expect(members.include.map((m) => m.entityId)).toEqual(["note-1"]);
	});

	it("removes a manual member", async () => {
		const svc = fakeService([listEntity("c1", "Reading", ["note-1"])]);
		const result = await toggleCollectionMembership(svc, "c1", "note-1", false, "notes");
		expect(result).toBe(false);
		const members = svc.store.get("c1")?.properties.members as { include: unknown[] };
		expect(members.include).toEqual([]);
	});

	it("does not write when membership is already in the requested state", async () => {
		const svc = fakeService([listEntity("c1", "Reading", ["note-1"])]);
		const updateSpy = vi.spyOn(svc, "update");
		await toggleCollectionMembership(svc, "c1", "note-1", true, "notes");
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("records the originating app on the membership (by: app:<id>)", async () => {
		const svc = fakeService([listEntity("c1", "Reading")]);
		await toggleCollectionMembership(svc, "c1", "note-1", true, "notes");
		const members = svc.store.get("c1")?.properties.members as { include: { by: string }[] };
		expect(members.include[0]?.by).toBe("app:notes");
	});

	it("returns false for an unknown Collection id", async () => {
		const svc = fakeService();
		expect(await toggleCollectionMembership(svc, "missing", "note-1", true, "notes")).toBe(false);
	});
});

describe("openObjectMenu — Add to collection integration", () => {
	afterEach(() => {
		closeObjectMenu();
		document.body.innerHTML = "";
	});

	const runtime = (caps: string[]) => ({ capabilities: caps, services: {} });
	const point = { x: 10, y: 10 };

	function menuLabels(): string[] {
		return [...document.querySelectorAll(".bs-object-menu__item")].map((el) =>
			(el.textContent ?? "").trim(),
		);
	}

	it("omits Add to collection without the write capability", async () => {
		const svc = fakeService([listEntity("c1", "Reading")]);
		await openObjectMenu(point, {
			target: { entityId: "note-1" },
			runtime: runtime([]),
			collections: { service: svc, appId: "notes" },
		});
		expect(menuLabels()).not.toContain("Add to collection…");
	});

	it("shows Add to collection when cap + service present, and opens the picker", async () => {
		const svc = fakeService([listEntity("c1", "Reading", ["note-1"]), listEntity("c2", "Archive")]);
		await openObjectMenu(point, {
			target: { entityId: "note-1" },
			runtime: runtime(["entities.write:brainstorm/List/v1"]),
			collections: { service: svc, appId: "notes" },
		});
		expect(menuLabels()).toContain("Add to collection…");

		const addItem = [...document.querySelectorAll(".bs-object-menu__item")].find(
			(el) => (el.textContent ?? "").trim() === "Add to collection…",
		) as HTMLButtonElement;
		addItem.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(menuLabels().sort()).toEqual(["Archive", "Reading"]);
	});

	it("toggling a non-member row writes the membership", async () => {
		const svc = fakeService([listEntity("c2", "Archive")]);
		await openObjectMenu(point, {
			target: { entityId: "note-1" },
			runtime: runtime(["entities.write:*"]),
			collections: { service: svc, appId: "notes" },
		});
		const addItem = [...document.querySelectorAll(".bs-object-menu__item")].find(
			(el) => (el.textContent ?? "").trim() === "Add to collection…",
		) as HTMLButtonElement;
		addItem.click();
		await Promise.resolve();
		await Promise.resolve();

		const archiveRow = [...document.querySelectorAll(".bs-object-menu__item")].find(
			(el) => (el.textContent ?? "").trim() === "Archive",
		) as HTMLButtonElement;
		archiveRow.click();
		await Promise.resolve();
		await Promise.resolve();

		const members = svc.store.get("c2")?.properties.members as {
			include: { entityId: string }[];
		};
		expect(members.include.map((m) => m.entityId)).toEqual(["note-1"]);
	});

	it("shows the empty state when there are no collections", async () => {
		const svc = fakeService();
		await openObjectMenu(point, {
			target: { entityId: "note-1" },
			runtime: runtime(["entities.write:brainstorm/List/v1"]),
			collections: { service: svc, appId: "notes" },
		});
		const addItem = [...document.querySelectorAll(".bs-object-menu__item")].find(
			(el) => (el.textContent ?? "").trim() === "Add to collection…",
		) as HTMLButtonElement;
		addItem.click();
		await Promise.resolve();
		await Promise.resolve();
		expect(menuLabels()).toContain("No collections yet");
	});
});
