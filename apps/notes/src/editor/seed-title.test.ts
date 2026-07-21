import { TITLE_NODE_TYPE, TitleNode } from "@brainstorm-os/editor";
// @vitest-environment node
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot, ParagraphNode, TextNode } from "lexical";
import { describe, expect, it } from "vitest";
import { makeNoteBootstrap } from "./seed-title";

function makeEditor() {
	return createHeadlessEditor({
		nodes: [TitleNode, ParagraphNode, TextNode],
		onError(e) {
			throw e;
		},
	});
}

describe("makeNoteBootstrap", () => {
	it("seeds an empty root with a TitleNode (bearing trimmed storedTitle) + a trailing paragraph", () => {
		const editor = makeEditor();
		const seed = makeNoteBootstrap("  My note  ");
		editor.update(
			() => {
				seed(editor);
			},
			{ discrete: true },
		);

		const snapshot = editor.getEditorState().read(() => {
			const root = $getRoot();
			const first = root.getFirstChild();
			const second = root.getLastChild();
			return {
				childCount: root.getChildrenSize(),
				firstType: first?.getType(),
				firstText: first?.getTextContent(),
				lastType: second?.getType(),
			};
		});

		expect(snapshot.childCount).toBe(2);
		expect(snapshot.firstType).toBe(TITLE_NODE_TYPE);
		expect(snapshot.firstText).toBe("My note");
		expect(snapshot.lastType).toBe("paragraph");
	});

	it("seeds a blank TitleNode (no text child) when storedTitle is empty-after-trim", () => {
		const editor = makeEditor();
		const seed = makeNoteBootstrap("   \t  ");
		editor.update(
			() => {
				seed(editor);
			},
			{ discrete: true },
		);
		const titleText = editor.getEditorState().read(() => {
			const root = $getRoot();
			const first = root.getFirstChild();
			return first?.getType() === TITLE_NODE_TYPE ? first.getTextContent() : "<wrong>";
		});
		expect(titleText).toBe("");
	});

	it("is a no-op when the root is already non-empty (idempotency against re-runs)", () => {
		// The CollaborationPlugin gate only fires when the root XmlText is
		// empty, but the seed function itself ALSO guards on isEmpty() so a
		// re-run (test harness / hot-reload) never double-seeds.
		const editor = makeEditor();
		editor.update(
			() => {
				$getRoot().append($createParagraphNode().append($createTextNode("pre-existing")));
			},
			{ discrete: true },
		);
		const before = editor.getEditorState().toJSON();

		const seed = makeNoteBootstrap("Should not appear");
		editor.update(
			() => {
				seed(editor);
			},
			{ discrete: true },
		);
		const after = editor.getEditorState().toJSON();
		expect(after).toEqual(before);
	});
});
