// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { $isBlockEmbedNode, BlockEmbedNode } from "../nodes/block-embed-node";
import { applyEmbedInsertion } from "./embed-insert";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "embed-insert",
		nodes: [BlockEmbedNode],
		onError: (e) => {
			throw e;
		},
	});
}

describe("applyEmbedInsertion", () => {
	it("replaces the target paragraph with a BlockEmbedNode", () => {
		const e = editor();
		let paragraphKey = "";
		e.update(
			() => {
				const p = $createParagraphNode();
				$getRoot().append(p);
				paragraphKey = p.getKey();
			},
			{ discrete: true },
		);
		applyEmbedInsertion(e, paragraphKey, {
			entityId: "n_target",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "Target note",
		});
		e.getEditorState().read(() => {
			const children = $getRoot().getChildren();
			expect(children).toHaveLength(1);
			const child = children[0];
			expect($isBlockEmbedNode(child)).toBe(true);
			if (!$isBlockEmbedNode(child)) return;
			expect(child.getEntityId()).toBe("n_target");
			expect(child.getEntityType()).toBe("io.brainstorm.notes/Note/v1");
			expect(child.getLabel()).toBe("Target note");
		});
	});

	it("appends to root when the paragraph key is missing or stale", () => {
		const e = editor();
		applyEmbedInsertion(e, null, {
			entityId: "n_x",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "X",
		});
		e.getEditorState().read(() => {
			const children = $getRoot().getChildren();
			expect(children).toHaveLength(1);
			const last = children[0];
			expect($isBlockEmbedNode(last) && last.getEntityId()).toBe("n_x");
		});

		applyEmbedInsertion(e, "no-such-key", {
			entityId: "n_y",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "Y",
		});
		e.getEditorState().read(() => {
			const children = $getRoot().getChildren();
			expect(children).toHaveLength(2);
			const last = children[1];
			expect($isBlockEmbedNode(last) && last.getEntityId()).toBe("n_y");
		});
	});
});
