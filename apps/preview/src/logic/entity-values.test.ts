import type { VaultEntitiesSnapshot } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { entityValuesFromSnapshot } from "./entity-values";

function snapshot(entities: VaultEntitiesSnapshot["entities"]): VaultEntitiesSnapshot {
	return { entities } as VaultEntitiesSnapshot;
}

function fileEntity(
	id: string,
	properties: Record<string, unknown>,
	deletedAt: number | null = null,
): VaultEntitiesSnapshot["entities"][number] {
	return {
		id,
		type: "brainstorm/File/v1",
		properties,
		createdAt: 0,
		updatedAt: 0,
		deletedAt,
		ownerAppId: "io.brainstorm.files",
	};
}

describe("entityValuesFromSnapshot", () => {
	it("returns the entity's bound-property bag", () => {
		const snap = snapshot([fileEntity("ent_1", { name: "lotr.pdf", values: { author: "Tolkien" } })]);
		expect(entityValuesFromSnapshot(snap, "ent_1")).toEqual({ author: "Tolkien" });
	});

	it("returns {} for an entity with no values bag", () => {
		const snap = snapshot([fileEntity("ent_1", { name: "lotr.pdf" })]);
		expect(entityValuesFromSnapshot(snap, "ent_1")).toEqual({});
	});

	it("returns null for a null id or an unknown / deleted entity", () => {
		const snap = snapshot([fileEntity("ent_1", { values: { a: 1 } }, 123)]);
		expect(entityValuesFromSnapshot(snap, null)).toBeNull();
		expect(entityValuesFromSnapshot(snap, "missing")).toBeNull();
		expect(entityValuesFromSnapshot(snap, "ent_1")).toBeNull();
	});
});
