import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode } from "lexical";
import { describe, expect, it } from "vitest";
import { createBrainstormHeadlessEditor } from "../headless";
import { $createImageNode } from "../image-node";
import { $isBlankHintParagraph } from "./empty-paragraph-hint-plugin";

/** Build a single paragraph via `seed`, then read `$isBlankHintParagraph` off it. */
function blankFor(seed: (paragraph: ReturnType<typeof $createParagraphNode>) => void): boolean {
	const editor = createBrainstormHeadlessEditor();
	let result = false;
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			const para = $createParagraphNode();
			seed(para);
			root.append(para);
		},
		{ discrete: true },
	);
	editor.getEditorState().read(() => {
		const para = $getRoot().getFirstChild();
		if ($isParagraphNode(para)) result = $isBlankHintParagraph(para);
	});
	return result;
}

describe("$isBlankHintParagraph", () => {
	it("treats a childless paragraph as blank (the fresh-note case)", () => {
		expect(blankFor(() => {})).toBe(true);
	});

	it("treats a paragraph of only empty text nodes as blank", () => {
		expect(blankFor((p) => p.append($createTextNode("")))).toBe(true);
	});

	it("does not treat a paragraph with typed text as blank", () => {
		expect(blankFor((p) => p.append($createTextNode("hello")))).toBe(false);
	});

	it("does not treat a paragraph holding an inline decorator as blank", () => {
		// The bug: an inline field / image contributes no text, so the slash hint
		// painted "Type ‘/’ for commands" on top of the field's own placeholder.
		expect(
			blankFor((p) => p.append($createImageNode({ src: "img://1", altText: "shot", width: 120 }))),
		).toBe(false);
	});
});
