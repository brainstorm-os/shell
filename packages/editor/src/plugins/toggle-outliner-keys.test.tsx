// @vitest-environment jsdom
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	KEY_ENTER_COMMAND,
	KEY_TAB_COMMAND,
	type LexicalEditor,
} from "lexical";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToggleVariant } from "../block-types";
import { $createToggleNode, $isToggleNode, ToggleNode } from "../nodes/toggle-node";
import { TogglePlugin } from "./toggle-plugin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let captured: LexicalEditor | null = null;
function Capture() {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		captured = editor;
	}, [editor]);
	return null;
}

describe("TogglePlugin outliner keys (B11.30)", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function mount(): LexicalEditor {
		act(() =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "outliner-keys",
						nodes: [ToggleNode],
						onError: (e) => {
							throw e;
						},
					}}
				>
					<RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
					<TogglePlugin />
					<Capture />
				</LexicalComposer>,
			),
		);
		const editor = captured as unknown as LexicalEditor;
		act(() =>
			editor.update(
				() => {
					$getRoot().clear();
					for (const title of ["A", "B"]) {
						const t = $createToggleNode(ToggleVariant.Paragraph);
						t.append($createParagraphNode().append($createTextNode(title)), $createParagraphNode());
						$getRoot().append(t);
					}
					(
						$getRoot().getLastChildOrThrow<ToggleNode>().getFirstChild() as unknown as {
							selectEnd(): void;
						}
					).selectEnd();
				},
				{ discrete: true },
			),
		);
		return editor;
	}

	const topLevel = (e: LexicalEditor) =>
		e.getEditorState().read(() =>
			$getRoot()
				.getChildren()
				.map((c) => c.getTextContent()),
		);

	it("Tab on a summary nests the toggle and swallows the key", () => {
		const editor = mount();
		const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
		act(() =>
			editor.update(() => void editor.dispatchCommand(KEY_TAB_COMMAND, event), { discrete: true }),
		);
		expect(event.defaultPrevented).toBe(true);
		const nested = editor.getEditorState().read(() => {
			const first = $getRoot().getFirstChild();
			return $isToggleNode(first) && $isToggleNode(first.getLastChild());
		});
		expect(nested).toBe(true);
		expect(topLevel(editor)).toHaveLength(1);
	});

	it("leaves Tab / Shift+Tab to indentation when there is nothing to nest under or out of", () => {
		const editor = mount();
		act(() =>
			editor.update(
				() =>
					(
						$getRoot().getFirstChildOrThrow<ToggleNode>().getFirstChild() as unknown as {
							selectEnd(): void;
						}
					).selectEnd(),
				{ discrete: true },
			),
		);
		for (const shiftKey of [false, true]) {
			const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
			let handled = true;
			act(() =>
				editor.update(
					() => {
						handled = editor.dispatchCommand(KEY_TAB_COMMAND, event);
					},
					{ discrete: true },
				),
			);
			expect(handled).toBe(false);
			expect(event.defaultPrevented).toBe(false);
		}
		expect(topLevel(editor)).toHaveLength(2);
	});

	it("Enter on a summary starts a sibling toggle; Shift+Enter is left alone", () => {
		const editor = mount();
		const shift = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, cancelable: true });
		act(() =>
			editor.update(() => void editor.dispatchCommand(KEY_ENTER_COMMAND, shift), { discrete: true }),
		);
		expect(topLevel(editor)).toHaveLength(2);
		const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
		act(() =>
			editor.update(() => void editor.dispatchCommand(KEY_ENTER_COMMAND, enter), { discrete: true }),
		);
		expect(enter.defaultPrevented).toBe(true);
		expect(topLevel(editor)).toHaveLength(3);
	});
});
