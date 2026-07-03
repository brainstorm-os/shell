import { describe, expect, it } from "vitest";
import {
	BLOCK_EMBED_NODE_TYPE,
	MENTION_NODE_TYPE,
	NoteReferenceKind,
	TRANSCLUSION_NODE_TYPE,
	extractNoteReferences,
	parseBrainstormEntityUri,
} from "./extract-note-references";

function paragraph(...children: unknown[]) {
	return {
		root: {
			type: "root",
			version: 1,
			children: [{ type: "paragraph", version: 1, children }],
		},
	};
}

describe("parseBrainstormEntityUri", () => {
	it("parses a plain entity URI", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
	});

	it("strips anchor + query", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc#p3")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc?foo=1")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
	});

	it("returns null for external URLs and non-entity authorities", () => {
		expect(parseBrainstormEntityUri("https://example.com")).toBeNull();
		expect(parseBrainstormEntityUri("brainstorm://app-file/foo.png")).toBeNull();
		expect(parseBrainstormEntityUri("brainstorm://entity/")).toBeNull();
	});
});

describe("extractNoteReferences", () => {
	it("returns [] for null / string / non-object bodies", () => {
		expect(extractNoteReferences(null)).toEqual([]);
		expect(extractNoteReferences(undefined)).toEqual([]);
		expect(extractNoteReferences("legacy text")).toEqual([]);
		expect(extractNoteReferences(42)).toEqual([]);
	});

	it("surfaces a MentionNode child", () => {
		const body = paragraph({
			type: MENTION_NODE_TYPE,
			version: 1,
			entityId: "n_target",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "Target",
		});
		expect(extractNoteReferences(body)).toEqual([
			{
				entityId: "n_target",
				entityType: "io.brainstorm.notes/Note/v1",
				kind: NoteReferenceKind.Mention,
				label: "Target",
			},
		]);
	});

	it("surfaces a BlockEmbedNode reference (B9.4.1)", () => {
		const body = paragraph({
			type: BLOCK_EMBED_NODE_TYPE,
			version: 1,
			blockId: "io.brainstorm.shell/entity-card/v1",
			entityId: "ent_whiteboard1",
			entityType: "io.brainstorm.whiteboard/Board/v1",
			label: "Q3 board",
		});
		expect(extractNoteReferences(body)).toEqual([
			{
				entityId: "ent_whiteboard1",
				entityType: "io.brainstorm.whiteboard/Board/v1",
				kind: NoteReferenceKind.Embed,
				label: "Q3 board",
			},
		]);
	});

	it("keeps Mention and Embed of the same entity as distinct refs", () => {
		const body = paragraph(
			{
				type: MENTION_NODE_TYPE,
				version: 1,
				entityId: "n_same",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Same",
			},
			{
				type: BLOCK_EMBED_NODE_TYPE,
				version: 1,
				blockId: "io.brainstorm.shell/entity-card/v1",
				entityId: "n_same",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Same",
			},
		);
		const refs = extractNoteReferences(body);
		expect(refs).toHaveLength(2);
		expect(refs.map((r) => r.kind).sort()).toEqual(["embed", "mention"]);
	});

	it("ignores embeds with missing / blank entityId", () => {
		const body = paragraph(
			{ type: BLOCK_EMBED_NODE_TYPE, version: 1, label: "no-id" },
			{ type: BLOCK_EMBED_NODE_TYPE, version: 1, entityId: "", label: "blank" },
			{ type: BLOCK_EMBED_NODE_TYPE, version: 1, entityId: 42, label: "num" },
		);
		expect(extractNoteReferences(body)).toEqual([]);
	});

	it("surfaces a LinkNode with a brainstorm:// URI", () => {
		const body = paragraph({
			type: "link",
			version: 1,
			url: "brainstorm://entity/n_xyz",
			children: [],
		});
		expect(extractNoteReferences(body)).toEqual([
			{ entityId: "n_xyz", entityType: "", kind: NoteReferenceKind.Link },
		]);
	});

	it("dedupes repeat references by (kind, entityId)", () => {
		const body = paragraph(
			{
				type: MENTION_NODE_TYPE,
				version: 1,
				entityId: "n_a",
				entityType: "T/v1",
				label: "A",
			},
			{
				type: MENTION_NODE_TYPE,
				version: 1,
				entityId: "n_a",
				entityType: "T/v1",
				label: "A",
			},
		);
		expect(extractNoteReferences(body)).toHaveLength(1);
	});

	it("walks deeply nested element children", () => {
		const body = {
			root: {
				type: "root",
				children: [
					{
						type: "list",
						children: [
							{
								type: "listitem",
								children: [
									{
										type: MENTION_NODE_TYPE,
										entityId: "n_deep",
										entityType: "T/v1",
										label: "Deep",
									},
								],
							},
						],
					},
				],
			},
		};
		expect(extractNoteReferences(body)).toEqual([
			{ entityId: "n_deep", entityType: "T/v1", kind: NoteReferenceKind.Mention, label: "Deep" },
		]);
	});

	it("ignores https links", () => {
		const body = paragraph({
			type: "link",
			url: "https://anthropic.com",
			children: [],
		});
		expect(extractNoteReferences(body)).toEqual([]);
	});

	it("ignores mentions with missing / non-string entityId", () => {
		const body = paragraph(
			{ type: MENTION_NODE_TYPE, version: 1, label: "no-id" },
			{ type: MENTION_NODE_TYPE, version: 1, entityId: "", label: "blank" },
			{ type: MENTION_NODE_TYPE, version: 1, entityId: 42, label: "num" },
		);
		expect(extractNoteReferences(body)).toEqual([]);
	});

	it("tolerates malformed roots", () => {
		expect(extractNoteReferences({})).toEqual([]);
		expect(extractNoteReferences({ root: null })).toEqual([]);
		expect(extractNoteReferences({ root: { foo: "bar" } })).toEqual([]);
	});

	it("surfaces a TransclusionNode reference (B6.4a)", () => {
		const body = paragraph({
			type: TRANSCLUSION_NODE_TYPE,
			version: 1,
			entityId: "n_origin",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "Origin doc",
		});
		expect(extractNoteReferences(body)).toEqual([
			{
				entityId: "n_origin",
				entityType: "io.brainstorm.notes/Note/v1",
				kind: NoteReferenceKind.Transclusion,
				label: "Origin doc",
			},
		]);
	});

	it("keeps Embed and Transclusion of the same entity as distinct refs", () => {
		// A note can both block-embed (preview card) and transclude (live
		// reference) the same entity — they're different relationship kinds
		// and downstream consumers (Graph, backlinks) should see both edges.
		const body = paragraph(
			{
				type: BLOCK_EMBED_NODE_TYPE,
				version: 1,
				blockId: "io.brainstorm.shell/entity-card/v1",
				entityId: "n_same",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Same",
			},
			{
				type: TRANSCLUSION_NODE_TYPE,
				version: 1,
				entityId: "n_same",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Same",
			},
		);
		const refs = extractNoteReferences(body);
		expect(refs).toHaveLength(2);
		expect(refs.map((r) => r.kind).sort()).toEqual(["embed", "transclusion"]);
	});

	it("ignores transclusions with missing / blank entityId", () => {
		const body = paragraph(
			{ type: TRANSCLUSION_NODE_TYPE, version: 1, label: "no-id" },
			{ type: TRANSCLUSION_NODE_TYPE, version: 1, entityId: "", label: "blank" },
			{ type: TRANSCLUSION_NODE_TYPE, version: 1, entityId: 42, label: "num" },
		);
		expect(extractNoteReferences(body)).toEqual([]);
	});
});
