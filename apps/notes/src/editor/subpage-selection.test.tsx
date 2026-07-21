// @vitest-environment jsdom
import { BASELINE_NODES } from "@brainstorm-os/editor";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	createEditor,
} from "lexical";
import { describe, expect, it } from "vitest";
import { $createPageRefNode } from "./nodes/page-ref-node";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

function makeEditor() {
	const editor = createEditor({
		namespace: "subpage-sel",
		nodes: [...BASELINE_NODES, ...NOTES_ADDITIONAL_NODES],
		onError: (e) => {
			throw e;
		},
	});
	const root = document.createElement("div");
	root.contentEditable = "true";
	document.body.appendChild(root);
	editor.setRootElement(root);
	return editor;
}

describe("sub-page insertion leaves a clean text caret, not a node selection", () => {
	it("bare block.replace(pageRef) does NOT leave a clean text caret (the bug)", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const p = $createParagraphNode();
				p.append($createTextNode("trigger"));
				$getRoot().append(p);
				p.selectEnd();
			},
			{ discrete: true },
		);
		let blockKey = "";
		editor.getEditorState().read(() => {
			const sel = $getSelection();
			if ($isRangeSelection(sel)) blockKey = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		});
		// Bare replace throws "selection has been lost" / leaves a node
		// selection — either way it is NOT a clean collapsed text caret.
		let threw = false;
		try {
			editor.update(
				() => {
					const block = $getNodeByKey(blockKey);
					if (block && $isElementNode(block)) block.replace($createPageRefNode("e", NOTE_TYPE, ""));
				},
				{ discrete: true },
			);
		} catch {
			threw = true;
		}
		const isCleanCaret = editor.getEditorState().read(() => {
			const sel = $getSelection();
			return $isRangeSelection(sel) && sel.isCollapsed();
		});
		expect(threw || !isCleanCaret).toBe(true);
	});

	it("inserting a trailing paragraph + selectStart leaves a collapsed RANGE caret (the fix)", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const p = $createParagraphNode();
				p.append($createTextNode("trigger"));
				$getRoot().append(p);
				p.selectEnd();
			},
			{ discrete: true },
		);
		let blockKey = "";
		editor.getEditorState().read(() => {
			const sel = $getSelection();
			if ($isRangeSelection(sel)) blockKey = sel.anchor.getNode().getTopLevelElementOrThrow().getKey();
		});
		editor.update(
			() => {
				const block = $getNodeByKey(blockKey);
				if (!block || !$isElementNode(block)) return;
				const ref = $createPageRefNode("e", NOTE_TYPE, "");
				block.replace(ref);
				const trailing = $createParagraphNode();
				ref.insertAfter(trailing);
				trailing.selectStart();
			},
			{ discrete: true },
		);
		const isCollapsedRange = editor.getEditorState().read(() => {
			const sel = $getSelection();
			return $isRangeSelection(sel) && sel.isCollapsed();
		});
		expect(isCollapsedRange).toBe(true);
	});
});
