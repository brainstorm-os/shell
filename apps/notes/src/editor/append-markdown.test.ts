/**
 * F-241 — headless round-trip tests for the insert-at-end append: markdown
 * parses into blocks with the Notes transformer set, and the blocks land
 * APPENDED to a target editor's existing content (never replacing it).
 */

import { BASELINE_NODES, BLOCK_MARKDOWN_TRANSFORMERS } from "@brainstorm-os/editor";
import { createHeadlessEditor } from "@lexical/headless";
import { TRANSFORMERS } from "@lexical/markdown";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { appendMarkdownAtEnd, markdownToSerializedBlocks } from "./append-markdown";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

const NODES = [...BASELINE_NODES, ...NOTES_ADDITIONAL_NODES];
const TRANSFORMER_SET = [...BLOCK_MARKDOWN_TRANSFORMERS, ...TRANSFORMERS];

function makeTargetEditor(seedText?: string) {
	const editor = createHeadlessEditor({
		namespace: "notes-insert-test",
		nodes: NODES,
		onError(err) {
			throw err;
		},
	});
	if (seedText !== undefined) {
		editor.update(
			() => {
				const p = $createParagraphNode();
				p.append($createTextNode(seedText));
				$getRoot().append(p);
			},
			{ discrete: true },
		);
	}
	return editor;
}

function rootTexts(editor: ReturnType<typeof createHeadlessEditor>): string[] {
	return editor.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((n) => n.getTextContent()),
	);
}

describe("markdownToSerializedBlocks", () => {
	it("parses headings, paragraphs and lists into top-level blocks", () => {
		const blocks = markdownToSerializedBlocks(
			"## Findings\n\nOne paragraph.\n\n- a\n- b",
			NODES,
			TRANSFORMER_SET,
		);
		expect(blocks.length).toBeGreaterThanOrEqual(3);
		expect(blocks[0]?.type).toBe("heading");
	});

	it("parses a brainstorm entity link into a link node (the link-to-note mode)", () => {
		const blocks = markdownToSerializedBlocks(
			"[Planning chat](brainstorm://entity/conv-1)",
			NODES,
			TRANSFORMER_SET,
		);
		const json = JSON.stringify(blocks);
		expect(json).toContain("brainstorm://entity/conv-1");
		expect(json).toContain('"link"');
	});
});

describe("appendMarkdownAtEnd", () => {
	it("appends after existing content, preserving it", () => {
		const editor = makeTargetEditor("Existing body");
		const applied = appendMarkdownAtEnd(editor, "Inserted reply", NODES, TRANSFORMER_SET);
		expect(applied).toBe(true);
		const texts = rootTexts(editor);
		expect(texts[0]).toBe("Existing body");
		expect(texts[texts.length - 1]).toBe("Inserted reply");
	});

	it("appends multiple blocks in order", () => {
		const editor = makeTargetEditor("Seed");
		appendMarkdownAtEnd(editor, "# Title\n\nBody line", NODES, TRANSFORMER_SET);
		const texts = rootTexts(editor);
		expect(texts).toEqual(["Seed", "Title", "Body line"]);
	});

	it("no-ops on empty / whitespace-only markdown", () => {
		const editor = makeTargetEditor("Seed");
		expect(appendMarkdownAtEnd(editor, "   \n  ", NODES, TRANSFORMER_SET)).toBe(false);
		expect(rootTexts(editor)).toEqual(["Seed"]);
	});

	it("markdown is treated as text, never HTML", () => {
		const editor = makeTargetEditor();
		appendMarkdownAtEnd(editor, "<img src=x onerror=alert(1)> plain", NODES, TRANSFORMER_SET);
		const texts = rootTexts(editor);
		expect(texts.join("\n")).toContain("<img src=x onerror=alert(1)> plain");
	});
});
