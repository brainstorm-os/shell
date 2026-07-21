import { COMMENT_TYPE_URL, type CommentDef, CommentKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type CommentEntitiesService,
	type CommentEntity,
	commentToEntityProperties,
	createEntityCommentsAdapter,
	entityToComment,
} from "./comments-adapter";

function comment(over: Partial<CommentDef> = {}): CommentDef {
	return {
		id: "cmt_1",
		kind: CommentKind.Comment,
		anchor: { entityId: "ent_doc", blockId: "blk_1" },
		body: "looks good",
		parentId: null,
		createdAt: 10,
		updatedAt: 20,
		resolvedAt: null,
		...over,
	};
}

function entity(over: Partial<CommentEntity> = {}): CommentEntity {
	return {
		id: "cmt_1",
		type: COMMENT_TYPE_URL,
		properties: {
			documentId: "ent_doc",
			blockId: "blk_1",
			body: "looks good",
			kind: CommentKind.Comment,
			parentId: null,
			resolvedAt: null,
		},
		createdBy: "ident_a",
		createdAt: 10,
		updatedAt: 20,
		...over,
	};
}

describe("comment codec", () => {
	it("round-trips through properties (Entity-owned fields excluded)", () => {
		const props = commentToEntityProperties(comment({ authorName: "Mira" }));
		expect(props).toMatchObject({
			documentId: "ent_doc",
			blockId: "blk_1",
			body: "looks good",
			kind: CommentKind.Comment,
			parentId: null,
			resolvedAt: null,
			authorName: "Mira",
		});
		// id / createdAt / updatedAt live on the entity, not in properties.
		expect(props.id).toBeUndefined();
		expect(props.createdAt).toBeUndefined();
	});

	it("serializes anchor quote + range + suggestion only when present", () => {
		const bare = commentToEntityProperties(comment());
		expect(bare.quote).toBeUndefined();
		expect(bare.rangeStart).toBeUndefined();
		expect(bare.suggestionReplacement).toBeUndefined();

		const rich = commentToEntityProperties(
			comment({
				kind: CommentKind.Suggestion,
				anchor: { entityId: "ent_doc", blockId: "blk_1", quote: "teh", range: { start: 2, end: 5 } },
				suggestion: { replacement: "the" },
			}),
		);
		expect(rich).toMatchObject({
			quote: "teh",
			rangeStart: 2,
			rangeEnd: 5,
			suggestionReplacement: "the",
		});
	});

	it("entityToComment reads timestamps + author from the entity", () => {
		const c = entityToComment(
			entity({
				properties: { documentId: "ent_doc", blockId: "blk_1", body: "hi", authorName: "Mira" },
			}),
		);
		expect(c).toMatchObject({
			id: "cmt_1",
			createdAt: 10,
			updatedAt: 20,
			authorId: "ident_a",
			authorName: "Mira",
		});
	});

	it("entityToComment returns null for a wrong type or a missing required field", () => {
		expect(entityToComment(entity({ type: "brainstorm/Note/v1" }))).toBeNull();
		expect(
			entityToComment(entity({ properties: { documentId: "ent_doc", blockId: "blk_1" } })),
		).toBeNull(); // no body
		expect(entityToComment(entity({ properties: { blockId: "blk_1", body: "hi" } }))).toBeNull(); // no documentId
	});

	it("entityToComment reconstructs anchor range + suggestion", () => {
		const c = entityToComment(
			entity({
				properties: {
					documentId: "ent_doc",
					blockId: "blk_1",
					body: "use this",
					kind: CommentKind.Suggestion,
					quote: "teh",
					rangeStart: 2,
					rangeEnd: 5,
					suggestionReplacement: "the",
				},
			}),
		);
		expect(c?.anchor.range).toEqual({ start: 2, end: 5 });
		expect(c?.suggestion).toEqual({ replacement: "the" });
	});
});

/** A minimal in-memory entities service driving one subscriber. */
function fakeService() {
	const rows: CommentEntity[] = [];
	let sub: ((e: CommentEntity[]) => void) | null = null;
	let seq = 0;
	const push = (): void => sub?.(rows.slice());
	return {
		rows,
		service: {
			query: async () => rows.slice(),
			subscribe(_q, onUpdate) {
				sub = onUpdate;
				onUpdate(rows.slice());
				return {
					unsubscribe: () => {
						sub = null;
					},
				};
			},
			create: async (type, properties) => {
				seq += 1;
				const e: CommentEntity = {
					id: `cmt_${seq}`,
					type,
					properties,
					createdBy: "ident_a",
					createdAt: seq,
					updatedAt: seq,
				};
				rows.push(e);
				push();
				return e;
			},
			update: async (id, patch) => {
				const e = rows.find((r) => r.id === id);
				if (!e) throw new Error("not found");
				e.properties = { ...e.properties, ...patch };
				push();
				return e;
			},
			delete: async (id) => {
				const i = rows.findIndex((r) => r.id === id);
				if (i >= 0) rows.splice(i, 1);
				push();
			},
		} satisfies CommentEntitiesService,
	};
}

describe("createEntityCommentsAdapter", () => {
	it("caches comments for its document and notifies on change", async () => {
		const { service } = fakeService();
		const adapter = createEntityCommentsAdapter(service, "ent_doc", { now: () => 999 });
		const onChange = vi.fn();
		adapter.subscribe(onChange);

		expect(adapter.list()).toEqual([]);
		await adapter.add({ anchor: { entityId: "ent_doc", blockId: "blk_1" }, body: "first" });
		expect(onChange).toHaveBeenCalled();
		expect(adapter.list().map((c) => c.body)).toEqual(["first"]);
		adapter.dispose();
	});

	it("filters out comments anchored to other documents", async () => {
		const { service } = fakeService();
		const adapter = createEntityCommentsAdapter(service, "ent_doc");
		await service.create(COMMENT_TYPE_URL, {
			documentId: "ent_other",
			blockId: "b",
			body: "elsewhere",
		});
		await service.create(COMMENT_TYPE_URL, { documentId: "ent_doc", blockId: "b", body: "mine" });
		expect(adapter.list().map((c) => c.body)).toEqual(["mine"]);
		adapter.dispose();
	});

	it("resolve / reopen patch resolvedAt; remove deletes", async () => {
		const { service } = fakeService();
		const adapter = createEntityCommentsAdapter(service, "ent_doc", { now: () => 555 });
		await adapter.add({ anchor: { entityId: "ent_doc", blockId: "b" }, body: "x" });
		const id = adapter.list()[0]?.id ?? "";

		await adapter.resolve(id);
		expect(adapter.list()[0]?.resolvedAt).toBe(555);
		await adapter.reopen(id);
		expect(adapter.list()[0]?.resolvedAt).toBeNull();
		await adapter.remove(id);
		expect(adapter.list()).toEqual([]);
		adapter.dispose();
	});
});
