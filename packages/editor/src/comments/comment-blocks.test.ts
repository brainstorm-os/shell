import { type CommentDef, CommentKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { openCommentBlockIds } from "./comment-blocks";
import { DOCUMENT_BLOCK_ID } from "./comments-panel";

let seq = 0;
function comment(over: Partial<CommentDef>): CommentDef {
	seq += 1;
	return {
		id: `c${seq}`,
		kind: CommentKind.Comment,
		anchor: { entityId: "doc", blockId: "block-a" },
		body: "x",
		parentId: null,
		createdAt: seq,
		updatedAt: seq,
		resolvedAt: null,
		...over,
	};
}

describe("openCommentBlockIds", () => {
	it("returns the block ids of open threads", () => {
		const ids = openCommentBlockIds([
			comment({ anchor: { entityId: "doc", blockId: "block-a" } }),
			comment({ anchor: { entityId: "doc", blockId: "block-b" } }),
		]);
		expect(ids.sort()).toEqual(["block-a", "block-b"]);
	});

	it("dedupes multiple threads on the same block", () => {
		const ids = openCommentBlockIds([
			comment({ anchor: { entityId: "doc", blockId: "block-a" } }),
			comment({ anchor: { entityId: "doc", blockId: "block-a" } }),
		]);
		expect(ids).toEqual(["block-a"]);
	});

	it("excludes resolved threads", () => {
		const ids = openCommentBlockIds([
			comment({ anchor: { entityId: "doc", blockId: "block-a" }, resolvedAt: 5 }),
			comment({ anchor: { entityId: "doc", blockId: "block-b" } }),
		]);
		expect(ids).toEqual(["block-b"]);
	});

	it("excludes the document-level anchor", () => {
		const ids = openCommentBlockIds([
			comment({ anchor: { entityId: "doc", blockId: DOCUMENT_BLOCK_ID } }),
		]);
		expect(ids).toEqual([]);
	});

	it("returns empty for no comments", () => {
		expect(openCommentBlockIds([])).toEqual([]);
	});
});
