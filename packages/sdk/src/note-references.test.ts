import { describe, expect, it } from "vitest";
import {
	BLOCK_EMBED_NODE_TYPE,
	INLINE_TRANSCLUSION_NODE_TYPE,
	MENTION_NODE_TYPE,
	NoteReferenceKind,
	TRANSCLUSION_NODE_TYPE,
	extractNoteReferences,
	formatBrainstormEntityUri,
	parseBrainstormEntityUri,
} from "./note-references";

function body(children: unknown[]): unknown {
	return { root: { type: "root", children } };
}

describe("extractNoteReferences", () => {
	it("returns [] for non-object / string / null bodies", () => {
		expect(extractNoteReferences(null)).toEqual([]);
		expect(extractNoteReferences("legacy string body")).toEqual([]);
		expect(extractNoteReferences(42)).toEqual([]);
	});

	it("surfaces mention / embed / transclusion chips with their kinds", () => {
		const refs = extractNoteReferences(
			body([
				{ type: MENTION_NODE_TYPE, entityId: "a", entityType: "T/v1" },
				{ type: BLOCK_EMBED_NODE_TYPE, entityId: "b", entityType: "T/v1" },
				{ type: TRANSCLUSION_NODE_TYPE, entityId: "c", entityType: "T/v1" },
			]),
		);
		expect(refs).toEqual([
			{ entityId: "a", entityType: "T/v1", kind: NoteReferenceKind.Mention },
			{ entityId: "b", entityType: "T/v1", kind: NoteReferenceKind.Embed },
			{ entityId: "c", entityType: "T/v1", kind: NoteReferenceKind.Transclusion },
		]);
	});

	it("carries the mention chip's denormalised label, clamped", () => {
		const refs = extractNoteReferences(
			body([
				{ type: MENTION_NODE_TYPE, entityId: "a", entityType: "", label: "Razor" },
				{ type: MENTION_NODE_TYPE, entityId: "b", entityType: "", label: "x".repeat(1000) },
				{ type: MENTION_NODE_TYPE, entityId: "c", entityType: "", label: 42 },
			]),
		);
		expect(refs[0]?.label).toBe("Razor");
		expect(refs[1]?.label).toHaveLength(256);
		expect(refs[2]?.label).toBeUndefined();
	});

	it("surfaces an inline transclusion as a Transclusion edge (B11.1)", () => {
		const refs = extractNoteReferences(
			body([{ type: INLINE_TRANSCLUSION_NODE_TYPE, entityId: "x", entityType: "T/v1" }]),
		);
		expect(refs).toEqual([
			{ entityId: "x", entityType: "T/v1", kind: NoteReferenceKind.Transclusion },
		]);
	});

	it("dedupes a block + inline transclusion of the same entity to one edge", () => {
		const refs = extractNoteReferences(
			body([
				{ type: TRANSCLUSION_NODE_TYPE, entityId: "d", entityType: "T/v1" },
				{ type: INLINE_TRANSCLUSION_NODE_TYPE, entityId: "d", entityType: "T/v1" },
			]),
		);
		expect(refs).toEqual([
			{ entityId: "d", entityType: "T/v1", kind: NoteReferenceKind.Transclusion },
		]);
	});

	it("surfaces brainstorm://entity link nodes and ignores external links", () => {
		const refs = extractNoteReferences(
			body([
				{ type: "link", url: "brainstorm://entity/n_1#anchor" },
				{ type: "link", url: "https://example.com" },
			]),
		);
		expect(refs).toEqual([{ entityId: "n_1", entityType: "", kind: NoteReferenceKind.Link }]);
	});

	it("recurses into children and dedupes by kind+id", () => {
		const refs = extractNoteReferences(
			body([
				{ type: "paragraph", children: [{ type: MENTION_NODE_TYPE, entityId: "a", entityType: "" }] },
				{ type: MENTION_NODE_TYPE, entityId: "a", entityType: "" },
			]),
		);
		expect(refs).toHaveLength(1);
	});

	it("drops chips with a missing / blank entityId", () => {
		expect(
			extractNoteReferences(
				body([
					{ type: MENTION_NODE_TYPE, label: "no id" },
					{ type: MENTION_NODE_TYPE, entityId: "", label: "blank" },
				]),
			),
		).toEqual([]);
	});

	it("caps recursion at MAX_DEPTH (no stack overflow on a hostile body)", () => {
		// Build a chain 200 deep with a mention at the very bottom.
		let node: Record<string, unknown> = { type: MENTION_NODE_TYPE, entityId: "deep", entityType: "" };
		for (let i = 0; i < 200; i++) node = { type: "paragraph", children: [node] };
		const refs = extractNoteReferences({ root: node });
		// Beyond depth 64 the walk stops, so the too-deep mention is not found —
		// and crucially the call returns rather than overflowing.
		expect(refs).toEqual([]);
	});
});

describe("parseBrainstormEntityUri", () => {
	it("parses the id, stripping anchor / query", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_9?x=1")).toEqual({
			entityId: "n_9",
			entityType: "",
		});
	});

	it("returns null for non-matching / empty URIs", () => {
		expect(parseBrainstormEntityUri("https://x.com")).toBeNull();
		expect(parseBrainstormEntityUri("brainstorm://entity/")).toBeNull();
	});

	it("parses a #block-<id> anchor (B11.13) alongside the entity id", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_9#block-b7")).toEqual({
			entityId: "n_9",
			entityType: "",
			blockId: "b7",
		});
	});

	it("keeps the entity id when the anchor strips a trailing query", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_9?x=1#block-b7")).toMatchObject({
			entityId: "n_9",
		});
	});

	it("ignores a non-block fragment (plain entity link, no blockId)", () => {
		const r = parseBrainstormEntityUri("brainstorm://entity/n_9#section-2");
		expect(r).toEqual({ entityId: "n_9", entityType: "" });
		expect(r?.blockId).toBeUndefined();
	});

	it("drops an empty / over-long / malformed block fragment", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_9#block-")?.blockId).toBeUndefined();
		expect(
			parseBrainstormEntityUri(`brainstorm://entity/n_9#block-${"x".repeat(129)}`)?.blockId,
		).toBeUndefined();
	});
});

describe("formatBrainstormEntityUri (B11.13)", () => {
	it("builds a plain entity URI without a block id", () => {
		expect(formatBrainstormEntityUri("n_9")).toBe("brainstorm://entity/n_9");
		expect(formatBrainstormEntityUri("n_9", null)).toBe("brainstorm://entity/n_9");
	});

	it("anchors a block id as #block-<id>", () => {
		expect(formatBrainstormEntityUri("n_9", "b7")).toBe("brainstorm://entity/n_9#block-b7");
	});

	it("round-trips through the parser", () => {
		const uri = formatBrainstormEntityUri("ent_abc", "blk_123");
		expect(parseBrainstormEntityUri(uri)).toEqual({
			entityId: "ent_abc",
			entityType: "",
			blockId: "blk_123",
		});
	});

	it("degrades to the plain link when the block id would break the fragment", () => {
		expect(formatBrainstormEntityUri("n_9", "bad#id")).toBe("brainstorm://entity/n_9");
		expect(formatBrainstormEntityUri("n_9", "with space")).toBe("brainstorm://entity/n_9");
		expect(formatBrainstormEntityUri("n_9", "x".repeat(129))).toBe("brainstorm://entity/n_9");
	});
});
