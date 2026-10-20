import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
// @vitest-environment jsdom
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
	$createParagraphNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { $isTabPaneNode, TabPaneNode, TabsNode, tabPanelDomId } from "../nodes/tabs-node";
import { tabsActiveStore } from "./tabs-active-store";
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

	function mount(editable = true, onError?: (error: Error) => void): LexicalEditor {
		act(() =>
			root.render(
				<LexicalComposer
					initialConfig={{
						namespace: "tabs-plugin",
						nodes: [TabsNode, TabPaneNode],
						editable,
						onError:
							onError ??
							((e) => {
								throw e;
							}),
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

	it("forgets a destroyed tabs block's active pane", () => {
		const editor = mount();
		act(() => tabs()[1]?.click());
		expect(tabsActiveStore(editor).size).toBe(1);
		act(() => {
			editor.update(() => $getRoot().clear().append($createParagraphNode()), { discrete: true });
		});
		expect(tabsActiveStore(editor).size).toBe(0);
	});

	it("F2 renames the focused tab; Enter commits and returns focus, Escape cancels", async () => {
		mount();
		const key = (target: Element | null | undefined, k: string) =>
			act(() => {
				target?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
			});
		key(tabs()[0], "F2");
		const input = () => container.querySelector<HTMLInputElement>(".bs-tabs__rename");
		expect(document.activeElement).toBe(input());
		act(() => {
			const el = input();
			if (!el) return;
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, "Plan");
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
		key(input(), "Enter");
		await act(async () => {
			await new Promise((r) => requestAnimationFrame(() => r(undefined)));
		});
		expect(tabs()[0]?.textContent).toBe("Plan");
		expect(document.activeElement).toBe(tabs()[0]);

		key(tabs()[0], "F2");
		key(input(), "Escape");
		expect(input()).toBeNull();
		expect(tabs()[0]?.textContent).toBe("Plan");
	});

	/** The renderer's `Array.prototype.push` throws `RangeError: Invalid array
	 *  length` past the fast-array ceiling (~10^8 elements). Lowering the
	 *  ceiling makes the pre-fix lineage walk fail in milliseconds instead of
	 *  gigabytes, with the exact error the shell logged. */
	function withPushCeiling<T>(ceiling: number, run: () => T): T {
		const push = Array.prototype.push;
		Array.prototype.push = function (this: unknown[], ...items: unknown[]): number {
			if (this.length >= ceiling) throw new RangeError("Invalid array length");
			return push.apply(this, items);
		};
		try {
			return run();
		} finally {
			Array.prototype.push = push;
		}
	}

	/** Chrome reports a focused `<input>` (or a clicked strip control) as a
	 *  collapsed document selection at its parent + child index — a DOM point
	 *  inside the tabs block but outside the panes slot. Lexical resolves it
	 *  synchronously on the `selectionchange` and commits on a microtask. */
	async function placeDomSelectionAt(node: Element): Promise<void> {
		const parent = node.parentNode;
		if (!parent) throw new Error("detached");
		const index = Array.prototype.indexOf.call(parent.childNodes, node);
		withPushCeiling(100_000, () =>
			act(() => {
				window.getSelection()?.setBaseAndExtent(parent, index, parent, index);
				document.dispatchEvent(new Event("selectionchange"));
			}),
		);
		await act(async () => {
			await Promise.resolve();
		});
	}

	it("a DOM selection inside the strip resolves into the shown pane instead of walking the DOM lineage", async () => {
		const errors: Error[] = [];
		const editor = mount(true, (e) => errors.push(e));
		act(() => tabs()[1]?.click());
		act(() => {
			tabs()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		});
		const input = container.querySelector<HTMLInputElement>(".bs-tabs__rename");
		expect(input).not.toBeNull();
		if (!input) return;
		await placeDomSelectionAt(input);
		expect(errors).toEqual([]);
		expect(container.querySelector(".bs-tabs__rename")).toBe(input);
		expect(panes()[1]?.hasAttribute("hidden")).toBe(false);
		const paneKey = editor.getEditorState().read(() => {
			const selection = $getSelection();
			if (!$isRangeSelection(selection)) return null;
			for (let n: LexicalNode | null = selection.anchor.getNode(); n; n = n.getParent()) {
				if ($isTabPaneNode(n)) return n.getKey();
			}
			return null;
		});
		expect(paneKey).not.toBeNull();
		expect(document.getElementById(tabPanelDomId(paneKey ?? ""))).toBe(panes()[1]);
	});

	it("a DOM selection on the add button leaves add-tab working", async () => {
		const errors: Error[] = [];
		mount(true, (e) => errors.push(e));
		const add = container.querySelector<HTMLElement>("[aria-label='Add tab']");
		if (!add) throw new Error("no add button");
		await placeDomSelectionAt(add);
		await act(async () => {
			add.click();
			await Promise.resolve();
		});
		expect(errors).toEqual([]);
		expect(tabs().map((t) => t.textContent)).toEqual(["Tab 1", "Tab 2", "Tab 3"]);
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
