import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { computeBacklinks } from "./backlinks";

function noteEntity(id: string, title: string, refIds: string[]): VaultEntity {
	return {
		id,
		type: "io.brainstorm.notes/Note/v1",
		properties: {
			title,
			body: {
				root: {
					type: "root",
					children: refIds.map((rid) => ({
						type: "mention",
						entityId: rid,
						entityType: "io.brainstorm.notes/Note/v1",
					})),
				},
			},
		},
	} as unknown as VaultEntity;
}

describe("computeBacklinks", () => {
	it("finds entities whose body mentions the current note", () => {
		const entities = [
			noteEntity("A", "Note A", ["TARGET"]),
			noteEntity("B", "Note B", ["other"]),
			noteEntity("C", "Note C", ["TARGET", "x"]),
			noteEntity("TARGET", "The target", []),
		];
		const result = computeBacklinks(entities, "TARGET");
		expect(result.map((b) => b.id).sort()).toEqual(["A", "C"]);
		expect(result.find((b) => b.id === "A")?.title).toBe("Note A");
	});

	it("never includes the note itself, even if self-referential", () => {
		const entities = [noteEntity("SELF", "Self", ["SELF"])];
		expect(computeBacklinks(entities, "SELF")).toEqual([]);
	});

	it("returns nothing for an empty id or no matches", () => {
		const entities = [noteEntity("A", "A", ["B"])];
		expect(computeBacklinks(entities, "")).toEqual([]);
		expect(computeBacklinks(entities, "Z")).toEqual([]);
	});

	it("falls back to the id when the entity has no title", () => {
		const e = {
			id: "X",
			type: "t",
			properties: {
				body: { root: { children: [{ type: "mention", entityId: "T" }] } },
			},
		} as unknown as VaultEntity;
		expect(computeBacklinks([e], "T")[0]?.title).toBe("X");
	});
});
