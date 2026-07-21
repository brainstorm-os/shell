// @vitest-environment jsdom
/**
 * `normalizeEmptyDoc` guarantees an opened note is always editable — an empty
 * or title-only body becomes a TitleNode + a trailing editable paragraph, and
 * a healthy doc is left untouched (idempotent).
 */

import { $createTitleNode, BASELINE_NODES } from "@brainstorm-os/editor";
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";
import { normalizeEmptyDoc } from "./normalize-empty-plugin";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

function editor() {
	return createHeadlessEditor({
		namespace: "normalize-test",
		nodes: [...BASELINE_NODES, ...NOTES_ADDITIONAL_NODES],
		onError: (e) => {
			throw e;
		},
	});
}

function shape(ed: ReturnType<typeof editor>): string[] {
	return ed.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((c) => c.getType()),
	);
}

describe("normalizeEmptyDoc", () => {
	it("seeds title + paragraph into a completely empty root", () => {
		const ed = editor();
		ed.update(() => normalizeEmptyDoc($getRoot()), { discrete: true });
		expect(shape(ed)).toEqual(["title", "paragraph"]);
	});

	it("appends a trailing editable paragraph to a title-only doc", () => {
		const ed = editor();
		ed.update(
			() => {
				$getRoot().append($createTitleNode().append($createTextNode("My note")));
			},
			{ discrete: true },
		);
		ed.update(() => normalizeEmptyDoc($getRoot()), { discrete: true });
		expect(shape(ed)).toEqual(["title", "paragraph"]);
		const title = ed.getEditorState().read(() => $getRoot().getFirstChild()?.getTextContent());
		expect(title).toBe("My note");
	});

	it("prepends a title when the body has blocks but no title", () => {
		const ed = editor();
		ed.update(
			() => {
				$getRoot().append($createParagraphNode().append($createTextNode("orphan body")));
			},
			{ discrete: true },
		);
		ed.update(() => normalizeEmptyDoc($getRoot()), { discrete: true });
		expect(shape(ed)).toEqual(["title", "paragraph"]);
	});

	it("leaves a healthy doc (title + content) untouched", () => {
		const ed = editor();
		ed.update(
			() => {
				const root = $getRoot();
				root.append($createTitleNode().append($createTextNode("Title")));
				root.append($createParagraphNode().append($createTextNode("Body one")));
				root.append($createParagraphNode().append($createTextNode("Body two")));
			},
			{ discrete: true },
		);
		ed.update(() => normalizeEmptyDoc($getRoot()), { discrete: true });
		expect(shape(ed)).toEqual(["title", "paragraph", "paragraph"]);
		const text = ed.getEditorState().read(() => $getRoot().getTextContent());
		expect(text).toContain("Body one");
		expect(text).toContain("Body two");
	});
});
