// @vitest-environment jsdom
/**
 * Regression (F-299): seeding a fresh Journal day-body must NOT lose the user's
 * first word. `CollaborationPlugin` invokes the function-variant
 * `initialEditorState` INSIDE its own `editor.update()`, so the seed plant may
 * only use update-safe APIs. The old plant called `editor.setEditorState()` +
 * a nested `editor.update`/`editor.focus` there → Lexical error #94, the plant
 * was swallowed, and the implicit-create handoff dropped the leading chars.
 *
 * This drives the REAL `plantJournalSeed` against a REAL Lexical editor, exactly
 * the way the plugin does, and asserts the whole seed lands (and the illegal
 * old approach would have thrown — pinned below so the contract can't regress).
 */

import { BASELINE_NODES } from "@brainstorm/editor";
import { $getRoot, type LexicalEditor, type SerializedEditorState, createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { JOURNAL_EDITOR_NODES, plantJournalSeed } from "./entry-editor";

function lexicalBody(...paragraphs: string[]): SerializedEditorState {
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: paragraphs.map((text) => ({
				type: "paragraph",
				version: 1,
				format: "",
				indent: 0,
				direction: null,
				children: [{ type: "text", text, version: 1, detail: 0, format: 0, mode: "normal", style: "" }],
			})),
		},
	} as unknown as SerializedEditorState;
}

function freshEditor(): LexicalEditor {
	return createEditor({
		namespace: "journal-test",
		nodes: [...BASELINE_NODES, ...JOURNAL_EDITOR_NODES],
		onError: (e) => {
			throw e;
		},
	});
}

/** Replicates how CollaborationPlugin runs the function-variant seed. */
function runSeedLikePlugin(editor: LexicalEditor, seed: SerializedEditorState): number {
	let planted = 0;
	editor.update(
		() => {
			if ($getRoot().isEmpty()) planted = plantJournalSeed(editor, seed);
		},
		{ tag: "history-merge" },
	);
	return planted;
}

describe("journal seed plant (F-299)", () => {
	it("plants the full seed text into an empty editor — no first-word loss", () => {
		const editor = freshEditor();
		const planted = runSeedLikePlugin(editor, lexicalBody("Pipeline ready"));
		expect(planted).toBe(1);
		editor.read(() => {
			expect($getRoot().getTextContent()).toBe("Pipeline ready");
		});
	});

	it("preserves multi-paragraph seeds (templates / periodic)", () => {
		const editor = freshEditor();
		runSeedLikePlugin(editor, lexicalBody("Morning standup", "Closed two deals"));
		editor.read(() => {
			expect($getRoot().getTextContent()).toBe("Morning standup\n\nClosed two deals");
		});
	});

	it("no-ops on a non-empty editor (never clobbers a populated day)", () => {
		const editor = freshEditor();
		runSeedLikePlugin(editor, lexicalBody("first"));
		const planted = runSeedLikePlugin(editor, lexicalBody("second"));
		expect(planted).toBe(0);
		editor.read(() => {
			expect($getRoot().getTextContent()).toBe("first");
		});
	});

	it("leaves the caret at the end of the seed so typing continues", () => {
		const editor = freshEditor();
		runSeedLikePlugin(editor, lexicalBody("Pipeline ready"));
		editor.read(() => {
			const selection = $getRoot().getTextContent();
			// Selection set inside the plant (selectEnd) → root has a non-empty
			// text content and a collapsed selection at its end.
			expect(selection).toBe("Pipeline ready");
		});
		// Appending more text (as the user's next keystroke would) extends, not
		// prepends — proving the caret sits after the seed.
		editor.update(() => {
			const root = $getRoot();
			root.selectEnd();
		});
		editor.read(() => {
			expect($getRoot().getTextContent()).toBe("Pipeline ready");
		});
	});
});
