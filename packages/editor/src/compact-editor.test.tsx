// @vitest-environment jsdom

import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { $createListItemNode, $createListNode, $isListNode } from "@lexical/list";
import { $convertFromMarkdownString } from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
	type SerializedEditorState,
} from "lexical";
import { createRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	COMPOSER_BASELINE_NODES,
	COMPOSER_MARKDOWN_TRANSFORMERS,
	CompactEditor,
	type CompactEditorHandle,
} from "./compact-editor";

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

	it("payload carries a semantic HTML rendering with theme chrome stripped (Mailbox-11)", () => {
		const ref = createRef<CompactEditorHandle>();
		const payloads: { html: string; text: string }[] = [];
		let captured: LexicalEditor | null = null;
		act(() => {
			root.render(
				<CompactEditor ref={ref} onSubmit={(p) => payloads.push({ html: p.html, text: p.text })}>
					<CaptureEditor
						onReady={(e) => {
							captured = e;
						}}
					/>
				</CompactEditor>,
			);
		});
		act(() => {
			(captured as LexicalEditor | null)?.update(
				() => {
					const p = $createParagraphNode();
					p.append($createTextNode("plain "), $createTextNode("bold").toggleFormat("bold"));
					$getRoot().clear().append(p);
				},
				{ discrete: true },
			);
			ref.current?.submit();
		});
		const html = payloads[0]?.html ?? "";
		expect(html).toContain("<p");
		expect(html).toContain("plain ");
		expect(html).toMatch(/<(strong|b)[^>]*>bold<\/(strong|b)>/);
		expect(html).not.toContain("class=");
		expect(html).not.toContain('dir="');
	});

	it("submitOnEnter={false} keeps Enter a newline — submit only via the handle", () => {
		const ref = createRef<CompactEditorHandle>();
		let submitted = 0;
		let captured: LexicalEditor | null = null;
		act(() => {
			root.render(
				<CompactEditor
					ref={ref}
					submitOnEnter={false}
					onSubmit={() => {
						submitted++;
					}}
				>
					<CaptureEditor
						onReady={(e) => {
							captured = e;
						}}
					/>
				</CompactEditor>,
			);
		});
		act(() => {
			ref.current?.setText("draft");
			(captured as LexicalEditor | null)?.dispatchCommand(KEY_ENTER_COMMAND, enterEvent(false));
		});
		expect(submitted).toBe(0);
		act(() => ref.current?.submit());
		expect(submitted).toBe(1);
	});

	it("setText preserves multi-line seeds exactly (quoted reply bodies)", () => {
		const ref = createRef<CompactEditorHandle>();
		const texts: string[] = [];
		act(() => {
			root.render(<CompactEditor ref={ref} onSubmit={(p) => texts.push(p.text)} />);
		});
		act(() => {
			ref.current?.setText("Dana wrote:\n> line one\n> line two");
			ref.current?.submit();
		});
		expect(texts).toEqual(["Dana wrote:\n> line one\n> line two"]);
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

function CaptureEditor({ onReady }: { onReady: (e: LexicalEditor) => void }) {
	const [editor] = useLexicalComposerContext();
	onReady(editor);
	return null;
}

function mountWithEditor(onSubmit?: (text: string) => void): LexicalEditor {
	let editor: LexicalEditor | null = null;
	act(() => {
		root.render(
			<CompactEditor {...(onSubmit ? { onSubmit: (p) => onSubmit(p.text) } : {})}>
				<CaptureEditor
					onReady={(e) => {
						editor = e;
					}}
				/>
			</CompactEditor>,
		);
	});
	if (!editor) throw new Error("editor not captured");
	return editor;
}

function enterEvent(shiftKey: boolean): KeyboardEvent {
	return new KeyboardEvent("keydown", { key: "Enter", shiftKey, cancelable: true });
}

describe("CompactEditor — Slack-style blocks", () => {
	it("registers the list/quote/code nodes so a checklist round-trips through JSON", () => {
		const editor = createHeadlessEditor({
			namespace: "test",
			nodes: [...COMPOSER_BASELINE_NODES],
			onError: (e) => {
				throw e;
			},
		});
		editor.update(
			() => {
				const list = $createListNode("check");
				const item = $createListItemNode(true);
				item.append($createTextNode("buy milk"));
				list.append(item);
				$getRoot().clear().append(list);
			},
			{ discrete: true },
		);
		const json = JSON.parse(JSON.stringify(editor.getEditorState().toJSON())) as {
			root: { children: { type: string; listType?: string; children: { checked?: boolean }[] }[] };
		};
		const list = json.root.children[0];
		expect(list?.type).toBe("list");
		expect(list?.listType).toBe("check");
		expect(list?.children[0]?.checked).toBe(true);
	});

	it("markdown vocabulary converts lists/quote but deliberately not headings", () => {
		const editor = mountWithEditor();
		act(() => {
			editor.update(
				() => {
					// The `# ` line leads — after a quote it would be folded into the
					// blockquote by markdown lazy continuation, not left as a paragraph.
					$convertFromMarkdownString("# not a heading\n- [ ] task\n1. first\n> quoted", [
						...COMPOSER_MARKDOWN_TRANSFORMERS,
					]);
				},
				{ discrete: true },
			);
		});
		const types = editor.getEditorState().read(() =>
			$getRoot()
				.getChildren()
				.map((n) => n.getType()),
		);
		expect(types).toEqual(["paragraph", "list", "list", "quote"]);
	});

	it("plain Enter submits; Shift+Enter inside a list item starts a new item instead", async () => {
		const submitted: string[] = [];
		const editor = mountWithEditor((text) => submitted.push(text));
		act(() => {
			editor.update(
				() => {
					const list = $createListNode("bullet");
					const item = $createListItemNode();
					item.append($createTextNode("first"));
					list.append(item);
					$getRoot().clear().append(list);
					item.selectEnd();
				},
				{ discrete: true },
			);
		});

		// The dispatch-triggered update commits on a microtask — flush before reading.
		await act(async () => {
			editor.dispatchCommand(KEY_ENTER_COMMAND, enterEvent(true));
		});
		const itemCount = editor.getEditorState().read(() => {
			const list = $getRoot().getChildren().find($isListNode);
			return list ? list.getChildrenSize() : 0;
		});
		expect(itemCount).toBe(2);
		expect(submitted).toEqual([]);

		await act(async () => {
			editor.dispatchCommand(KEY_ENTER_COMMAND, enterEvent(false));
		});
		expect(submitted).toHaveLength(1);
		expect(submitted[0]?.trim()).toBe("first");
	});
});
