// @vitest-environment jsdom
import { CodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { describe, expect, it } from "vitest";
import {
	BRAINSTORM_HTML_SENTINEL,
	extractBrainstormPayloadFromHtml,
	insertBlocks,
	insertSnippet,
	parseBrainstormPayload,
	serializeBlocksAsHtml,
	serializeBlocksAsJson,
	serializeBlocksAsText,
} from "./block-clipboard";

function createEditor() {
	return createHeadlessEditor({
		nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, LinkNode, AutoLinkNode],
		onError(error) {
			throw error;
		},
	});
}

function seedThreeParagraphs(editor: LexicalEditor): NodeKey[] {
	const keys: NodeKey[] = [];
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			for (const text of ["alpha", "bravo", "charlie"]) {
				const p = $createParagraphNode();
				p.append($createTextNode(text));
				root.append(p);
				keys.push(p.getKey());
			}
		},
		{ discrete: true },
	);
	return keys;
}

function readTopLevelTexts(editor: LexicalEditor): string[] {
	const out: string[] = [];
	editor.getEditorState().read(() => {
		for (const child of $getRoot().getChildren()) {
			out.push(child.getTextContent());
		}
	});
	return out;
}

describe("serializeBlocksAsJson", () => {
	it("emits the {version, blocks} envelope for selected blocks in DOM order", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const first = keys[0];
		const last = keys[2];
		if (!first || !last) throw new Error("seed produced no keys");
		const json = serializeBlocksAsJson(editor, new Set([first, last]));
		const parsed = parseBrainstormPayload(json);
		expect(parsed).not.toBeNull();
		expect(parsed?.version).toBe(1);
		expect(parsed?.blocks).toHaveLength(2);
	});

	it("returns an empty blocks array when no keys are selected", () => {
		const editor = createEditor();
		seedThreeParagraphs(editor);
		const json = serializeBlocksAsJson(editor, new Set());
		const parsed = parseBrainstormPayload(json);
		expect(parsed?.blocks).toEqual([]);
	});
});

describe("serializeBlocksAsText", () => {
	it("joins selected blocks with a blank line", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const first = keys[0];
		const last = keys[2];
		if (!first || !last) throw new Error("seed produced no keys");
		const text = serializeBlocksAsText(editor, new Set([first, last]));
		expect(text).toBe("alpha\n\ncharlie");
	});
});

describe("serializeBlocksAsHtml", () => {
	it("embeds the canonical JSON in a sentinel script tag", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const first = keys[0];
		if (!first) throw new Error("seed produced no keys");
		const html = serializeBlocksAsHtml(editor, new Set([first]));
		expect(html).toContain(BRAINSTORM_HTML_SENTINEL);
		const extracted = extractBrainstormPayloadFromHtml(html);
		expect(extracted?.version).toBe(1);
		expect(extracted?.blocks).toHaveLength(1);
	});

	it("escapes user content with `</script>` substrings", () => {
		const editor = createEditor();
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("evil </script> attack"));
				root.append(p);
			},
			{ discrete: true },
		);
		const allKeys = new Set<NodeKey>();
		editor.getEditorState().read(() => {
			for (const child of $getRoot().getChildren()) allKeys.add(child.getKey());
		});
		const html = serializeBlocksAsHtml(editor, allKeys);
		// The raw sequence must not appear before the closing tag of our
		// own script — otherwise the JSON payload terminates early.
		const sentinelIdx = html.indexOf(BRAINSTORM_HTML_SENTINEL);
		const closingIdx = html.indexOf("</script>", sentinelIdx);
		const slice = html.slice(sentinelIdx, closingIdx);
		expect(slice).not.toMatch(/<\/script/i);
		// And the extractor still recovers the payload faithfully.
		const payload = extractBrainstormPayloadFromHtml(html);
		expect(payload?.blocks).toHaveLength(1);
	});
});

describe("extractBrainstormPayloadFromHtml", () => {
	it("returns null when no sentinel script is present", () => {
		expect(extractBrainstormPayloadFromHtml("<p>plain text</p>")).toBeNull();
	});

	it("returns null when sentinel is malformed JSON", () => {
		const html = `<script type="application/json" ${BRAINSTORM_HTML_SENTINEL}>not-json</script>`;
		expect(extractBrainstormPayloadFromHtml(html)).toBeNull();
	});
});

describe("parseBrainstormPayload", () => {
	it("rejects payloads with wrong version", () => {
		expect(parseBrainstormPayload(JSON.stringify({ version: 99, blocks: [] }))).toBeNull();
	});

	it("rejects non-object / non-blocks-array shapes", () => {
		expect(parseBrainstormPayload(JSON.stringify(["not", "an", "object"]))).toBeNull();
		expect(parseBrainstormPayload(JSON.stringify({ version: 1, blocks: "string" }))).toBeNull();
	});

	it("accepts the canonical shape", () => {
		expect(parseBrainstormPayload(JSON.stringify({ version: 1, blocks: [] }))).toEqual({
			version: 1,
			blocks: [],
		});
	});
});

describe("insertBlocks round-trip", () => {
	it("copy → paste appends to the bottom when no replace-keys are provided", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const first = keys[0];
		if (!first) throw new Error("seed produced no keys");
		const json = serializeBlocksAsJson(editor, new Set([first]));
		const payload = parseBrainstormPayload(json);
		if (!payload) throw new Error("payload didn't parse");
		const inserted = insertBlocks(editor, payload.blocks, new Set());
		expect(inserted).toHaveLength(1);
		expect(readTopLevelTexts(editor)).toEqual(["alpha", "bravo", "charlie", "alpha"]);
	});

	it("replaces the keys passed in, inserting the new blocks in their place", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const first = keys[0];
		const middle = keys[1];
		if (!first || !middle) throw new Error("seed produced no keys");
		const json = serializeBlocksAsJson(editor, new Set([first]));
		const payload = parseBrainstormPayload(json);
		if (!payload) throw new Error("payload didn't parse");
		insertBlocks(editor, payload.blocks, new Set([middle]));
		expect(readTopLevelTexts(editor)).toEqual(["alpha", "alpha", "charlie"]);
	});

	it("preserves block structure across the serialize → parse → insert pipeline", () => {
		const editor = createEditor();
		const keys = seedThreeParagraphs(editor);
		const middle = keys[1];
		if (!middle) throw new Error("seed produced no keys");
		const json = serializeBlocksAsJson(editor, new Set([middle]));
		const payload = parseBrainstormPayload(json);
		if (!payload) throw new Error("payload didn't parse");
		insertBlocks(editor, payload.blocks, new Set());
		// Last block should be a paragraph with text "bravo".
		let lastText: string | null = null;
		let lastType: string | null = null;
		editor.getEditorState().read(() => {
			const last = $getRoot().getLastChild();
			if (!last) return;
			lastText = last.getTextContent();
			lastType = last.getType();
		});
		expect(lastText).toBe("bravo");
		expect(lastType).toBe("paragraph");
	});
});

describe("insertSnippet", () => {
	it("inserts a serialized-blocks snippet at the caret, replacing the empty slash block", () => {
		const src = createEditor();
		const keys = seedThreeParagraphs(src);
		// The block-snippet fragment = the same JSON the clipboard/paste path uses.
		const json = serializeBlocksAsJson(src, new Set([keys[0] as NodeKey, keys[1] as NodeKey]));

		const dst = createEditor();
		// The state after the slash-menu clears "/template": one empty paragraph
		// with the caret parked in it.
		dst.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				root.append(p);
				p.selectStart();
			},
			{ discrete: true },
		);

		expect(insertSnippet(dst, json)).toBe(true);
		// The empty slash paragraph is replaced (not appended-after), so the doc
		// is exactly the snippet.
		expect(readTopLevelTexts(dst)).toEqual(["alpha", "bravo"]);
	});

	it("returns false on malformed / empty / non-payload input (caller no-ops)", () => {
		const editor = createEditor();
		expect(insertSnippet(editor, "not-json")).toBe(false);
		expect(insertSnippet(editor, JSON.stringify({ version: 1, blocks: [] }))).toBe(false);
		expect(insertSnippet(editor, JSON.stringify({ nope: true }))).toBe(false);
	});
});
