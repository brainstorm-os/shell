// @vitest-environment jsdom

import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type SerializedEditorState,
} from "lexical";
import { createRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactEditor, type CompactEditorHandle } from "./compact-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe("CompactEditor — storage contract (rich JSON + plain text)", () => {
	it("serializes a paragraph of marked text to JSON and flattens to plain text", () => {
		const editor = createHeadlessEditor({
			namespace: "test",
			nodes: [LinkNode, AutoLinkNode],
			onError: (e) => {
				throw e;
			},
		});
		editor.update(
			() => {
				const p = $createParagraphNode();
				const hello = $createTextNode("Hello ");
				const world = $createTextNode("world").toggleFormat("bold");
				p.append(hello, world);
				$getRoot().clear().append(p);
			},
			{ discrete: true },
		);

		const state = editor.getEditorState();
		const text = state.read(() => $getRoot().getTextContent());
		expect(text).toBe("Hello world");

		const json = JSON.parse(JSON.stringify(state.toJSON())) as SerializedEditorState;
		const para = json.root.children[0] as unknown as { type: string; children: unknown[] };
		expect(para.type).toBe("paragraph");
		expect(para.children).toHaveLength(2);
	});
});

describe("CompactEditor — DOM", () => {
	it("renders a contenteditable with the aria-label and placeholder", () => {
		act(() => {
			root.render(<CompactEditor ariaLabel="Write a message" placeholder="Message…" />);
		});
		const editable = container.querySelector<HTMLElement>(".bs-compact-editor__content");
		expect(editable).not.toBeNull();
		expect(editable?.getAttribute("contenteditable")).toBe("true");
		expect(editable?.getAttribute("aria-label")).toBe("Write a message");
		expect(container.querySelector(".bs-compact-editor__placeholder")?.textContent).toBe("Message…");
	});

	it("locks the surface when disabled", () => {
		act(() => {
			root.render(<CompactEditor disabled />);
		});
		const editable = container.querySelector<HTMLElement>(".bs-compact-editor__content");
		expect(editable?.getAttribute("contenteditable")).toBe("false");
	});

	it("exposes an imperative handle and never submits an empty surface", () => {
		const ref = createRef<CompactEditorHandle>();
		let submitted = 0;
		act(() => {
			root.render(
				<CompactEditor
					ref={ref}
					onSubmit={() => {
						submitted++;
					}}
				/>,
			);
		});
		expect(ref.current).not.toBeNull();
		act(() => {
			ref.current?.focus();
			ref.current?.clear();
			ref.current?.submit();
		});
		expect(submitted).toBe(0);
	});

	it("setText seeds the draft and submit reads it back", () => {
		const ref = createRef<CompactEditorHandle>();
		const submitted: string[] = [];
		act(() => {
			root.render(<CompactEditor ref={ref} onSubmit={(p) => submitted.push(p.text)} />);
		});
		act(() => {
			ref.current?.setText("Summarize this note");
			ref.current?.submit();
		});
		expect(submitted).toEqual(["Summarize this note"]);
		act(() => {
			ref.current?.setText("");
			ref.current?.submit();
		});
		expect(submitted).toEqual(["Summarize this note"]);
	});
});
