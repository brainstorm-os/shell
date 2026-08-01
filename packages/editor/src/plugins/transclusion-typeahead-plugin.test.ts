// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	ParagraphNode,
	type SerializedEditorState,
	TextNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import { $createQuoteNode, QuoteNode } from "@lexical/rich-text";
import { InlineTransclusionNode } from "../nodes/inline-transclusion-node";
import { TransclusionNode } from "../nodes/transclusion-node";
import {
	applyInlineTransclusionInsertion,
	applyTransclusionInsertion,
} from "./transclusion-typeahead-plugin";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "tr-tt",
		nodes: [ParagraphNode, TextNode, QuoteNode, TransclusionNode, InlineTransclusionNode],
		onError: (e) => {
			throw e;
		},
	});
}

function seedParagraph(e: LexicalEditor, text: string): string {
	let key = "";
	e.update(
		() => {
			const p = $createParagraphNode();
			const t = $createTextNode(text);
			p.append(t);
			$getRoot().append(p);
			key = t.getKey();
		},
		{ discrete: true },
	);
	return key;
}

function seedQuote(e: LexicalEditor, text: string): string {
	let key = "";
	e.update(
		() => {
			const q = $createQuoteNode();
			const t = $createTextNode(text);
			q.append(t);
			$getRoot().append(q);
			key = t.getKey();
		},
		{ discrete: true },
	);
	return key;
}

function readSerialized(e: LexicalEditor): SerializedEditorState {
	return e.getEditorState().toJSON();
}

type SerializedChild = { type: string; text?: string; children?: SerializedChild[] };

function collectTransclusions(state: SerializedEditorState): SerializedChild[] {
	const out: SerializedChild[] = [];
	function walk(node: SerializedChild | undefined) {
		if (!node) return;
		if (node.type === "transclusion") out.push(node);
		if (Array.isArray(node.children)) for (const c of node.children) walk(c);
	}
	for (const child of state.root.children as unknown as SerializedChild[]) walk(child);
	return out;
}

function collectByType(state: SerializedEditorState, type: string): SerializedChild[] {
	const out: SerializedChild[] = [];
	function walk(node: SerializedChild | undefined) {
		if (!node) return;
		if (node.type === type) out.push(node);
		if (Array.isArray(node.children)) for (const c of node.children) walk(c);
	}
	for (const child of state.root.children as unknown as SerializedChild[]) walk(child);
	return out;
}

function plainText(state: SerializedEditorState): string {
	const parts: string[] = [];
	function walk(node: SerializedChild | undefined) {
		if (!node) return;
		if (typeof node.text === "string") parts.push(node.text);
		if (Array.isArray(node.children)) for (const c of node.children) walk(c);
	}
	for (const child of state.root.children as unknown as SerializedChild[]) walk(child);
	return parts.join("");
}

describe("applyTransclusionInsertion", () => {
	it("replaces the !@<query> span with a TransclusionNode carrying entity coordinates", () => {
		const e = editor();
		const textKey = seedParagraph(e, "hello !@quer");
		applyTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 6, query: "quer" },
			{
				entityId: "n_target",
				entityType: "io.brainstorm.notes/Note/v1",
				label: "Quarterly review",
			},
		);
		const state = readSerialized(e);
		const transclusions = collectTransclusions(state);
		expect(transclusions).toHaveLength(1);
		const tn = transclusions[0] as unknown as {
			entityId: string;
			entityType: string;
			label: string;
		};
		expect(tn.entityId).toBe("n_target");
		expect(tn.entityType).toBe("io.brainstorm.notes/Note/v1");
		expect(tn.label).toBe("Quarterly review");
		// The "!@quer" span is consumed; the leading "hello " survives.
		const text = plainText(state);
		expect(text.includes("!@")).toBe(false);
		expect(text.startsWith("hello")).toBe(true);
	});

	it("is a no-op when the query span exceeds the text node range", () => {
		const e = editor();
		const textKey = seedParagraph(e, "short");
		applyTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 100, query: "wildly-out-of-range" },
			{ entityId: "n_x", entityType: "T/v1", label: "X" },
		);
		const state = readSerialized(e);
		expect(collectTransclusions(state)).toHaveLength(0);
		expect(plainText(state)).toBe("short");
	});

	it("preserves text before the trigger when the !@<query> sits mid-paragraph", () => {
		const e = editor();
		const textKey = seedParagraph(e, "prefix !@target suffix");
		applyTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 7, query: "target" },
			{ entityId: "n_target", entityType: "T/v1", label: "Target" },
		);
		const state = readSerialized(e);
		const text = plainText(state);
		expect(text.includes("prefix")).toBe(true);
		expect(text.includes("suffix")).toBe(true);
		expect(text.includes("!@target")).toBe(false);
		expect(collectTransclusions(state)).toHaveLength(1);
	});

	it("hoists the block node out of a quote host so deleting the quote cannot take it (F-478)", () => {
		const e = editor();
		const textKey = seedQuote(e, "!@target");
		applyTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 0, query: "target" },
			{ entityId: "n_target", entityType: "T/v1", label: "Target" },
		);
		const state = readSerialized(e);
		expect(collectTransclusions(state)).toHaveLength(1);
		// The transclusion must be a TOP-LEVEL child of root, never nested
		// inside the quote — nesting is what death-coupled the two on delete.
		const rootChildren = (state.root as unknown as { children: { type: string; children?: unknown[] }[] })
			.children;
		const topLevelTypes = rootChildren.map((c) => c.type);
		expect(topLevelTypes).toContain("transclusion");
		for (const child of rootChildren) {
			if (child.type !== "quote") continue;
			const nested = JSON.stringify(child.children ?? []);
			expect(nested.includes('"transclusion"')).toBe(false);
		}
		// The fully-consumed quote host must not linger as an empty block.
		expect(topLevelTypes).not.toContain("quote");
	});
});

describe("applyInlineTransclusionInsertion (B11.1)", () => {
	it("replaces the !@<query> span with an inline node, keeping the paragraph + surrounding text", () => {
		const e = editor();
		const textKey = seedParagraph(e, "see !@spec for details");
		applyInlineTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 4, query: "spec" },
			{ entityId: "n_spec", entityType: "io.brainstorm.notes/Note/v1", label: "The Spec" },
		);
		const state = readSerialized(e);
		const inline = collectByType(state, "inline-transclusion");
		expect(inline).toHaveLength(1);
		const node = inline[0] as unknown as { entityId: string; label: string };
		expect(node.entityId).toBe("n_spec");
		expect(node.label).toBe("The Spec");
		// No block transclusion was created, and the surrounding prose survives
		// in the SAME paragraph (inline splice, not a block break).
		expect(collectByType(state, "transclusion")).toHaveLength(0);
		const paragraphs = state.root.children as unknown as SerializedChild[];
		expect(paragraphs).toHaveLength(1);
		const text = plainText(state);
		expect(text.includes("see")).toBe(true);
		expect(text.includes("for details")).toBe(true);
		expect(text.includes("!@spec")).toBe(false);
	});

	it("is a no-op when the query span exceeds the text node range", () => {
		const e = editor();
		const textKey = seedParagraph(e, "short");
		applyInlineTransclusionInsertion(
			e,
			textKey,
			{ triggerOffset: 100, query: "way-too-long" },
			{ entityId: "n_x", entityType: "T/v1", label: "X" },
		);
		const state = readSerialized(e);
		expect(collectByType(state, "inline-transclusion")).toHaveLength(0);
		expect(plainText(state)).toBe("short");
	});
});
