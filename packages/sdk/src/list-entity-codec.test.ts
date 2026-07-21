import { type Entity, IconKind, type List, ListSourceKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { LIST_ENTITY_TYPE, entityToList, listToEntityProperties } from "./list-entity-codec";

const NOW = 1_700_000_000_000;

function sampleList(overrides: Partial<List> = {}): List {
	return {
		id: "list-projects",
		name: "Projects",
		icon: { kind: IconKind.Emoji, value: "📁" },
		description: "All active projects",
		source: { kind: ListSourceKind.ByType, types: ["brainstorm/Project/v1"] },
		members: {
			include: [{ entityId: "ent-1", addedAt: NOW, by: "user" }],
			exclude: [{ entityId: "ent-2", removedAt: NOW, by: "app:io.brainstorm.database" }],
		},
		views: ["view-grid", "view-board"],
		defaultViewId: "view-grid",
		defaultTemplate: null,
		createdAt: NOW,
		updatedAt: NOW + 5,
		...overrides,
	};
}

/** Build the entity a round-trip produces: properties from the codec +
 *  the id/timestamps the Entity carries. */
function asEntity(list: List): Entity {
	return {
		id: list.id,
		type: LIST_ENTITY_TYPE,
		properties: listToEntityProperties(list),
		createdBy: "io.brainstorm.database",
		createdAt: list.createdAt,
		updatedAt: list.updatedAt,
	};
}

describe("list-entity-codec", () => {
	it("LIST_ENTITY_TYPE is the canonical Collection type url", () => {
		expect(LIST_ENTITY_TYPE).toBe("brainstorm/List/v1");
	});

	it("properties omit the Entity-owned fields (id, timestamps)", () => {
		const props = listToEntityProperties(sampleList());
		expect(props).not.toHaveProperty("id");
		expect(props).not.toHaveProperty("createdAt");
		expect(props).not.toHaveProperty("updatedAt");
		expect(Object.keys(props).sort()).toEqual(
			[
				"defaultTemplate",
				"defaultViewId",
				"description",
				"icon",
				"members",
				"name",
				"source",
				"views",
			].sort(),
		);
	});

	it("round-trips a well-formed List (list → entity → list)", () => {
		const list = sampleList();
		expect(entityToList(asEntity(list))).toEqual(list);
	});

	it("round-trips a query-less manual List (null source)", () => {
		const list = sampleList({ source: null, defaultViewId: null, icon: null });
		expect(entityToList(asEntity(list))).toEqual(list);
	});

	it("returns null for a non-List entity", () => {
		const notAList: Entity = {
			id: "x",
			type: "brainstorm/Task/v1",
			properties: { name: "nope" },
			createdBy: "io.brainstorm.tasks",
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(entityToList(notAList)).toBeNull();
	});

	it("coerces a malformed entity to safe defaults (never throws)", () => {
		const malformed: Entity = {
			id: "list-bad",
			type: LIST_ENTITY_TYPE,
			properties: {
				name: 42, // wrong type
				icon: "not-an-object", // wrong type
				description: null, // missing → ""
				source: ["array-not-object"], // invalid → null
				members: { include: "nope" }, // partial/invalid
				views: ["ok", 7, null], // mixed → filtered
				defaultViewId: 12, // wrong type → null
			},
			createdBy: "io.brainstorm.database",
			createdAt: NOW,
			updatedAt: NOW,
		};
		const list = entityToList(malformed);
		expect(list).not.toBeNull();
		expect(list?.name).toBe("");
		expect(list?.icon).toBeNull();
		expect(list?.description).toBe("");
		expect(list?.source).toBeNull();
		expect(list?.members).toEqual({ include: [], exclude: [] });
		expect(list?.views).toEqual(["ok"]);
		expect(list?.defaultViewId).toBeNull();
		expect(list?.id).toBe("list-bad");
	});

	it("reads timestamps + id from the Entity, not from properties", () => {
		const entity = asEntity(sampleList({ createdAt: 1000, updatedAt: 2000 }));
		const list = entityToList(entity);
		expect(list?.id).toBe("list-projects");
		expect(list?.createdAt).toBe(1000);
		expect(list?.updatedAt).toBe(2000);
	});

	it("preserves member-override audit fields through the round-trip", () => {
		const list = sampleList();
		const back = entityToList(asEntity(list));
		expect(back?.members.include[0]).toEqual({ entityId: "ent-1", addedAt: NOW, by: "user" });
		expect(back?.members.exclude[0]).toEqual({
			entityId: "ent-2",
			removedAt: NOW,
			by: "app:io.brainstorm.database",
		});
	});
});
