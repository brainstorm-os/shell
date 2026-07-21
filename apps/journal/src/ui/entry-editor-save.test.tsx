// @vitest-environment jsdom
/**
 * Journal entry-save regression — the reported "creating a Journal entry
 * doesn't save" bug. The day-body editor mounted `<BrainstormEditor>` but
 * never mounted `AutosavePlugin`, so a journal-authored edit never wrote
 * the denormalised `body` snippet → the calendar / week previews stayed
 * empty and the day looked unsaved (the rich body did persist in the
 * Y.Doc, but no surface read it back).
 *
 * This proves the fix end-to-end at the plugin level (no Playwright
 * keystrokes — those corrupt the Yjs-bound editor): `AutosavePlugin`
 * composed with `buildJournalDenormalizer` patches the entity's `body`
 * (and ONLY `body`, never `title`) on a real edit, and stays silent on
 * the mount-settle echo.
 */

import { AutosavePlugin } from "@brainstorm-os/editor";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	KEY_DOWN_COMMAND,
	type LexicalEditor,
} from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EntryUpdateFn, buildJournalDenormalizer } from "../logic/denormalize-entry";

const NOTE_ID = "journal-2026-06-01";
const DISCRETE = { discrete: true } as const;

function CaptureEditor({ onEditor }: { onEditor: (e: LexicalEditor) => void }) {
	const [editor] = useLexicalComposerContext();
	onEditor(editor);
	return null;
}

describe("journal entry save (AutosavePlugin + denormalizer)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	function mount(update: Mock<EntryUpdateFn>) {
		let editor!: LexicalEditor;
		act(() => {
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "journal-test",
						editorState: () => {
							const r = $getRoot();
							r.clear();
							r.append($createParagraphNode().append($createTextNode("seed")));
						},
						onError(e) {
							throw e;
						},
					}}
				>
					<AutosavePlugin onChange={buildJournalDenormalizer(update, NOTE_ID)} />
					<CaptureEditor
						onEditor={(e) => {
							editor = e;
						}}
					/>
				</LexicalComposer>,
			);
		});
		return editor;
	}

	function settle(editor: LexicalEditor) {
		act(() => {
			editor.update(() => {
				$getRoot().getFirstChild()?.markDirty();
			}, DISCRETE);
			vi.runAllTimers();
		});
	}

	function userEdit(editor: LexicalEditor, mutate: () => void) {
		act(() => {
			editor.dispatchCommand(KEY_DOWN_COMMAND, new KeyboardEvent("keydown", { key: "a" }));
			editor.update(mutate, DISCRETE);
			vi.runAllTimers();
		});
	}

	it("does not save on the mount-settle echo", () => {
		const update = vi.fn<EntryUpdateFn>();
		const editor = mount(update);
		settle(editor);
		expect(update).not.toHaveBeenCalled();
	});

	it("writes the body snippet to the entity on a real edit (the fix)", () => {
		const update = vi.fn<EntryUpdateFn>();
		const editor = mount(update);
		userEdit(editor, () => {
			$getRoot().clear();
			$getRoot().append($createParagraphNode().append($createTextNode("had a good day")));
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(update).toHaveBeenCalledWith(NOTE_ID, { body: "had a good day", wordCount: 4 });
	});

	it("never patches title — the entry stays identified by its ISO date", () => {
		const update = vi.fn<EntryUpdateFn>();
		const editor = mount(update);
		userEdit(editor, () => {
			$getRoot().append($createParagraphNode().append($createTextNode("more")));
		});
		const [, patch] = update.mock.calls[0] as [string, Record<string, unknown>];
		expect(patch).not.toHaveProperty("title");
	});
});
