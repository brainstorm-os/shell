import {
	BLOCK_EMBED_NODE_TYPE as SDK_BLOCK_EMBED_NODE_TYPE,
	INLINE_TRANSCLUSION_NODE_TYPE as SDK_INLINE_TRANSCLUSION_NODE_TYPE,
	MENTION_NODE_TYPE as SDK_MENTION_NODE_TYPE,
	TRANSCLUSION_NODE_TYPE as SDK_TRANSCLUSION_NODE_TYPE,
} from "@brainstorm/sdk/note-references";
import type { SerializedEditorState } from "lexical";
import { describe, expect, it } from "vitest";
import { ReferenceKind, extractReferences, parseBrainstormEntityUri } from "./extract-references";
import { BLOCK_EMBED_NODE_TYPE } from "./nodes/block-embed-node";
import { INLINE_TRANSCLUSION_NODE_TYPE } from "./nodes/inline-transclusion-node";
import { MENTION_NODE_TYPE } from "./nodes/mention-node";
import { TRANSCLUSION_NODE_TYPE } from "./nodes/transclusion-node";

function makeState(children: unknown[]): SerializedEditorState {
	return {
		root: {
			type: "root",
			direction: null,
			format: "",
			indent: 0,
			version: 1,
			children: [
				{
					type: "paragraph",
					direction: null,
					format: "",
					indent: 0,
					version: 1,
					children,
				},
			],
		},
	} as unknown as SerializedEditorState;
}

describe("parseBrainstormEntityUri", () => {
	it("parses a plain entity URI", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
	});

	it("strips an anchor fragment", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc#p3")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
	});

	it("strips a query string", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/n_abc?source=editor")).toEqual({
			entityId: "n_abc",
			entityType: "",
		});
	});

	it("returns null for external https URLs", () => {
		expect(parseBrainstormEntityUri("https://example.com/foo")).toBeNull();
	});

	it("returns null for the bare scheme without an id", () => {
		expect(parseBrainstormEntityUri("brainstorm://entity/")).toBeNull();
	});

	it("returns null for non-entity authorities", () => {
		expect(parseBrainstormEntityUri("brainstorm://app-file/foo/bar.png")).toBeNull();
		expect(parseBrainstormEntityUri("brainstorm://chat/thr_a/msg_1")).toBeNull();
	});
});

describe("extractReferences", () => {
	it("returns [] for null / undefined / legacy-string bodies", () => {
		expect(extractReferences(null)).toEqual([]);
		expect(extractReferences(undefined)).toEqual([]);
		expect(extractReferences("legacy plain text body")).toEqual([]);
	});

	it("returns [] for a note without references", () => {
		const state = makeState([
			{
				type: "text",
				text: "no references here",
				version: 1,
				mode: "normal",
				style: "",
				detail: 0,
				format: 0,
			},
		]);
		expect(extractReferences(state)).toEqual([]);
	});

	it("emits a Mention reference for a MentionNode child", () => {
		const state = makeState([
			{ type: "text", text: "see ", version: 1, mode: "normal", style: "", detail: 0, format: 0 },
			{
				type: MENTION_NODE_TYPE,
				version: 1,
				entityId: "n_xyz",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Project Apollo",
			},
		]);
		expect(extractReferences(state)).toEqual([
			{
				entityId: "n_xyz",
				entityType: "io.brainstorm.notes/Note/v1",
				kind: ReferenceKind.Mention,
				label: "Project Apollo",
			},
		]);
	});

	it("emits a Link reference for a LinkNode with a brainstorm:// URI", () => {
		const state = makeState([
			{
				type: "link",
				version: 1,
				url: "brainstorm://entity/n_target",
				rel: null,
				target: null,
				title: null,
				children: [
					{ type: "text", text: "target", version: 1, mode: "normal", style: "", detail: 0, format: 0 },
				],
				direction: null,
				format: "",
				indent: 0,
			},
		]);
		expect(extractReferences(state)).toEqual([
			{ entityId: "n_target", entityType: "", kind: ReferenceKind.Link },
		]);
	});

	it("ignores external https links", () => {
		const state = makeState([
			{
				type: "link",
				version: 1,
				url: "https://anthropic.com",
				children: [
					{
						type: "text",
						text: "anthropic",
						version: 1,
						mode: "normal",
						style: "",
						detail: 0,
						format: 0,
					},
				],
			},
		]);
		expect(extractReferences(state)).toEqual([]);
	});

	it("dedupes by (kind, entityId) — repeated mentions count once", () => {
		const state = makeState([
			{ type: MENTION_NODE_TYPE, version: 1, entityId: "n_a", entityType: "T/v1", label: "A" },
			{ type: "text", text: " and ", version: 1, mode: "normal", style: "", detail: 0, format: 0 },
			{ type: MENTION_NODE_TYPE, version: 1, entityId: "n_a", entityType: "T/v1", label: "A" },
		]);
		const refs = extractReferences(state);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({
			entityId: "n_a",
			entityType: "T/v1",
			kind: ReferenceKind.Mention,
			label: "A",
		});
	});

	it("emits both a Mention and a Link for the same entity (different kinds)", () => {
		const state = makeState([
			{ type: MENTION_NODE_TYPE, version: 1, entityId: "n_a", entityType: "T/v1", label: "A" },
			{
				type: "link",
				version: 1,
				url: "brainstorm://entity/n_a",
				children: [
					{ type: "text", text: "A again", version: 1, mode: "normal", style: "", detail: 0, format: 0 },
				],
			},
		]);
		const refs = extractReferences(state);
		expect(refs).toHaveLength(2);
		expect(refs.map((r) => r.kind)).toEqual([ReferenceKind.Mention, ReferenceKind.Link]);
	});

	it("walks nested element children (mention inside a list item)", () => {
		const state = {
			root: {
				type: "root",
				direction: null,
				format: "",
				indent: 0,
				version: 1,
				children: [
					{
						type: "list",
						version: 1,
						children: [
							{
								type: "listitem",
								version: 1,
								children: [
									{
										type: MENTION_NODE_TYPE,
										version: 1,
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
		} as unknown as SerializedEditorState;
		expect(extractReferences(state)).toEqual([
			{ entityId: "n_deep", entityType: "T/v1", kind: ReferenceKind.Mention, label: "Deep" },
		]);
	});

	it("skips MentionNode entries with missing / non-string entityId", () => {
		const state = makeState([
			{ type: MENTION_NODE_TYPE, version: 1, entityType: "T/v1", label: "no-id" },
			{ type: MENTION_NODE_TYPE, version: 1, entityId: "", entityType: "T/v1", label: "empty" },
		]);
		expect(extractReferences(state)).toEqual([]);
	});

	it("tolerates malformed roots without throwing", () => {
		expect(extractReferences({ root: null } as unknown as SerializedEditorState)).toEqual([]);
		expect(extractReferences({} as unknown as SerializedEditorState)).toEqual([]);
		expect(extractReferences({ root: { foo: "bar" } } as unknown as SerializedEditorState)).toEqual(
			[],
		);
	});

	it("surfaces a TransclusionNode reference (B6.4a)", () => {
		const state = makeState([
			{
				type: TRANSCLUSION_NODE_TYPE,
				version: 1,
				entityId: "n_origin",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Origin doc",
			},
		]);
		expect(extractReferences(state)).toEqual([
			{
				entityId: "n_origin",
				entityType: "io.brainstorm.notes/Note/v1",
				kind: ReferenceKind.Transclusion,
				label: "Origin doc",
			},
		]);
	});

	it("keeps Embed + Transclusion of the same entity as distinct refs", () => {
		const state = makeState([
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
		]);
		const refs = extractReferences(state);
		expect(refs).toHaveLength(2);
		expect(refs.map((r) => r.kind).sort()).toEqual(["embed", "transclusion"]);
	});

	it("ignores transclusions with missing / blank entityId", () => {
		const state = makeState([
			{ type: TRANSCLUSION_NODE_TYPE, version: 1, label: "no-id" },
			{ type: TRANSCLUSION_NODE_TYPE, version: 1, entityId: "", label: "blank" },
		]);
		expect(extractReferences(state)).toEqual([]);
	});

	// B6.5 protocol pin: the Lexical node identities (what `getType()` returns
	// and what's persisted on disk) MUST equal the strings the shared walker
	// matches. If a node renames its type without updating the walker, edges
	// silently stop resolving — this catches the drift at build time.
	it("Lexical node type constants match the shared walker's protocol constants", () => {
		expect(MENTION_NODE_TYPE).toBe(SDK_MENTION_NODE_TYPE);
		expect(BLOCK_EMBED_NODE_TYPE).toBe(SDK_BLOCK_EMBED_NODE_TYPE);
		expect(TRANSCLUSION_NODE_TYPE).toBe(SDK_TRANSCLUSION_NODE_TYPE);
		expect(INLINE_TRANSCLUSION_NODE_TYPE).toBe(SDK_INLINE_TRANSCLUSION_NODE_TYPE);
	});
});
