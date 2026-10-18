import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
// @vitest-environment jsdom
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabPaneNode, TabsNode } from "../nodes/tabs-node";
import { INSERT_TABS_COMMAND, TabsPlugin } from "./tabs-plugin";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let editorRef: LexicalEditor | null = null;

function Capture() {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		editorRef = editor;
	}, [editor]);
	return null;
}

describe("TabsPlugin", () => {
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
		editorRef = null;
	});

	function mount(editable = true): LexicalEditor {
		act(() =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "tabs-plugin",
						nodes: [TabsNode, TabPaneNode],
						editable,
						onError: (e) => {
							throw e;
						},
					}}
				>
					<RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
					<TabsPlugin />
					<Capture />
				</LexicalComposer>,
			),
		);
		const editor = editorRef as unknown as LexicalEditor;
		act(() => {
			editor.update(
				() => {
					const p = $createParagraphNode();
					$getRoot().clear().append(p);
					p.select();
				},
				{ discrete: true },
			);
			editor.update(
				() => {
					editor.dispatchCommand(INSERT_TABS_COMMAND, 2);
				},
				{ discrete: true },
			);
		});
		return editor;
	}

	const tabs = () => [...container.querySelectorAll<HTMLElement>("[role='tab']")];
	const panes = () => [...container.querySelectorAll<HTMLElement>("[role='tabpanel']")];

	it("renders an ARIA tablist wired to its panels, showing only the first pane", () => {
		mount();
		expect(container.querySelector("[role='tablist']")).not.toBeNull();
		expect(tabs().map((t) => t.textContent)).toEqual(["Tab 1", "Tab 2"]);
		const [t1, t2] = tabs();
		const [p1, p2] = panes();
		expect(t1?.getAttribute("aria-controls")).toBe(p1?.id);
		expect(p1?.getAttribute("aria-labelledby")).toBe(t1?.id);
		expect(t1?.getAttribute("aria-selected")).toBe("true");
		expect(t2?.getAttribute("tabindex")).toBe("-1");
		expect(p1?.hasAttribute("hidden")).toBe(false);
		expect(p2?.hasAttribute("hidden")).toBe(true);
	});

	it("arrow keys move and select (automatic activation); click selects", () => {
		mount();
		const list = container.querySelector<HTMLElement>("[role='tablist']");
		act(() => {
			list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(panes()[1]?.hasAttribute("hidden")).toBe(false);
		expect(panes()[0]?.hasAttribute("hidden")).toBe(true);
		act(() => tabs()[0]?.click());
		expect(panes()[0]?.hasAttribute("hidden")).toBe(false);
	});

	it("the add button appends a pane and shows it", async () => {
		mount();
		const add = container.querySelector<HTMLElement>("[aria-label='Add tab']");
		await act(async () => {
			add?.click();
			await Promise.resolve();
		});
		expect(tabs().map((t) => t.textContent)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);
		expect(panes()[2]?.hasAttribute("hidden")).toBe(false);
	});

	it("strip events never reach the editor's input pipeline", () => {
		mount();
		const event = new KeyboardEvent("keydown", { key: "a", bubbles: true });
		tabs()[0]?.dispatchEvent(event);
		expect((event as KeyboardEvent & { _lexicalHandled?: boolean })._lexicalHandled).toBe(true);
	});
});

describe("TabsPlugin read-only", () => {
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

	it("hides the add / options controls on a locked document but still switches tabs", () => {
		const state = JSON.stringify({
			root: {
				type: "root",
				version: 1,
				format: "",
				indent: 0,
				direction: null,
				children: [
					{
						type: "tabs",
						version: 1,
						format: "",
						indent: 0,
						direction: null,
						children: ["A", "B"].map((title) => ({
							type: "tab-pane",
							version: 1,
							title,
							format: "",
							indent: 0,
							direction: null,
							children: [
								{
									type: "paragraph",
									version: 1,
									format: "",
									indent: 0,
									direction: null,
									children: [],
									textFormat: 0,
									textStyle: "",
								},
							],
						})),
					},
				],
			},
		});
		act(() =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "tabs-locked",
						nodes: [TabsNode, TabPaneNode],
						editable: false,
						editorState: state,
						onError: (e) => {
							throw e;
						},
					}}
				>
					<RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
					<TabsPlugin />
				</LexicalComposer>,
			),
		);
		expect(container.querySelector("[aria-label='Add tab']")).toBeNull();
		expect(container.querySelector("[aria-label='Tab options']")).toBeNull();
		const tabEls = [...container.querySelectorAll<HTMLElement>("[role='tab']")];
		expect(tabEls.map((t) => t.textContent)).toEqual(["A", "B"]);
		act(() => tabEls[1]?.click());
		const paneEls = [...container.querySelectorAll<HTMLElement>("[role='tabpanel']")];
		expect(paneEls[1]?.hasAttribute("hidden")).toBe(false);
	});
});
