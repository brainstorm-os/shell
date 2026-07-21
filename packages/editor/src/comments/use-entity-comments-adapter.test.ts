import { COMMENT_TYPE_URL, type VaultEntitiesSnapshot } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { commentEntitiesFromSnapshot } from "./use-entity-comments-adapter";

function entity(over: Partial<VaultEntitiesSnapshot["entities"][number]> & { id: string }) {
	return {
		type: COMMENT_TYPE_URL,
		properties: { documentId: "note-1", blockId: "__document", body: "hi" },
		createdAt: 1,
		updatedAt: 2,
		deletedAt: null,
		ownerAppId: "notes",
		...over,
	};
}

function snapshot(entities: ReturnType<typeof entity>[]): VaultEntitiesSnapshot {
	return { entities, links: [] };
}

describe("commentEntitiesFromSnapshot", () => {
	it("keeps Comment/v1 entities and maps to the shared CommentEntity shape", () => {
		const out = commentEntitiesFromSnapshot(snapshot([entity({ id: "c1" })]));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({
			id: "c1",
			type: COMMENT_TYPE_URL,
			createdBy: "",
			createdAt: 1,
			updatedAt: 2,
		});
	});

	it("excludes soft-deleted comments", () => {
		const out = commentEntitiesFromSnapshot(
			snapshot([entity({ id: "c1", deletedAt: 99 }), entity({ id: "c2" })]),
		);
		expect(out.map((c) => c.id)).toEqual(["c2"]);
	});

	it("excludes foreign entity types", () => {
		const out = commentEntitiesFromSnapshot(
			snapshot([entity({ id: "n1", type: "io.brainstorm.notes/Note/v1" }), entity({ id: "c1" })]),
		);
		expect(out.map((c) => c.id)).toEqual(["c1"]);
	});

	it("returns an empty list for a snapshot with no comments", () => {
		expect(commentEntitiesFromSnapshot(snapshot([]))).toEqual([]);
	});
});
