// @vitest-environment jsdom
/**
 * View tests for the SelectFieldNode picker, now rendered through the shared
 * fancy-menus runtime (the node MODEL — clamp / add / remove / import-export —
 * is covered in `select-field-node.test.ts`). Mounts the chip inside a
 * `BrainstormMenuProvider` + a Lexical editor holding a real node, opens the
 * picker, then renders the open menu's own `CustomRow` / custom-footer output
 * (the runtime virtualizes its list, which never paints under jsdom's zero
 * layout) to assert the option mutations land on the node:
 *   - clicking an option sets it as the value,
 *   - the × removes the option from the node,
 *   - typing + Enter in the footer adds the option and selects it.
 */

import { BrainstormMenuProvider, getActiveMenuStore } from "@brainstorm-os/sdk/menus";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $getRoot, type LexicalEditor, type NodeKey } from "lexical";
import { Fragment, type ReactNode, act, useEffect, useState } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	$createSelectFieldNode,
	$isSelectFieldNode,
	SelectFieldNode,
	SelectFieldView,
} from "./select-field-node";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SELECT_FIELD_MENU_ID = "bs/notes-select-field";

let container: HTMLDivElement;
let root: Root;
// A second root for re-rendering the open menu's row/footer output (the runtime
// virtualizes its real list, which doesn't paint under jsdom's zero layout).
let menuContainer: HTMLDivElement;
let menuRoot: Root;
let capturedEditor: LexicalEditor | null = null;

/** Inserts a SelectFieldNode on mount, then renders its chip view. Keeps one
 *  editor / one node so picks + removes + adds land on the live node. */
function Harness({ options, onKey }: { options: string[]; onKey: (key: NodeKey) => void }) {
	const [editor] = useLexicalComposerContext();
	const [nodeKey, setNodeKey] = useState<NodeKey | null>(null);
	capturedEditor = editor;
	// biome-ignore lint/correctness/useExhaustiveDependencies: insert once on mount.
	useEffect(() => {
		let key = "";
		editor.update(
			() => {
				const node = $createSelectFieldNode(options, null);
				$getRoot().append(node);
				key = node.getKey();
			},
			{ discrete: true },
		);
		setNodeKey(key);
		onKey(key);
	}, []);
	return nodeKey ? <SelectFieldView nodeKey={nodeKey} options={options} value={null} /> : null;
}

beforeEach(() => {
	vi.useFakeTimers();
	Element.prototype.scrollIntoView = () => {};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	menuContainer = document.createElement("div");
	document.body.appendChild(menuContainer);
	menuRoot = createRoot(menuContainer);
});

afterEach(() => {
	act(() => getActiveMenuStore()?.close(SELECT_FIELD_MENU_ID));
	act(() => vi.runAllTimers());
	act(() => menuRoot.unmount());
	act(() => root.unmount());
	menuContainer.remove();
	container.remove();
	capturedEditor = null;
	vi.useRealTimers();
});

/** Render the OPEN menu's own row + footer output (the same `CustomRow` /
 *  custom-footer the runtime renders, wired to the same module-level handlers
 *  set on open) into a queryable container, sidestepping the virtualizer. */
function renderMenuContent(): void {
	const open = getActiveMenuStore()
		?.getAll()
		.find((m) => m.id === SELECT_FIELD_MENU_ID);
	if (!open) throw new Error("select-field menu is not open");
	const ctx = { data: open.param.data } as { data: { options: string[]; value: string | null } };
	const rowSpec = (
		open.config.body as unknown as { rows: [{ render: (item: string, ctx: unknown) => ReactNode }] }
	).rows[0];
	const footer = (open.config.chrome as unknown as { footer: { render: () => ReactNode } }).footer;
	act(() => {
		menuRoot.render(
			<>
				{ctx.data.options.map((label) => (
					<Fragment key={label}>{rowSpec.render(label, ctx)}</Fragment>
				))}
				{footer.render()}
			</>,
		);
	});
}

/** Mount the chip for a node carrying `options`, then open the picker. */
function mountAndOpen(options: string[]): { editor: LexicalEditor; nodeKey: NodeKey } {
	let nodeKey = "";
	act(() => {
		root.render(
			<BrainstormMenuProvider>
				<LexicalComposer
					initialConfig={{
						namespace: "select-field-test",
						nodes: [SelectFieldNode],
						onError: (e) => {
							throw e;
						},
					}}
				>
					<Harness
						options={options}
						onKey={(k) => {
							nodeKey = k;
						}}
					/>
				</LexicalComposer>
			</BrainstormMenuProvider>,
		);
	});
	// Flush the insert effect + the re-render that paints the chip.
	act(() => vi.runAllTimers());
	const editor = capturedEditor;
	if (!editor) throw new Error("editor did not mount");

	const chip = container.querySelector<HTMLButtonElement>(".notes__select-field-chip");
	if (!chip) throw new Error("chip did not render");
	act(() => chip.click());
	// Flush the open animation so the runtime paints the rows.
	act(() => vi.runAllTimers());
	return { editor, nodeKey };
}

function optionButtons(): HTMLButtonElement[] {
	return Array.from(
		menuContainer.querySelectorAll<HTMLButtonElement>(".notes__select-field-option"),
	);
}

function nodeValue(editor: LexicalEditor, nodeKey: NodeKey): string | null {
	let value: string | null = null;
	editor.getEditorState().read(() => {
		const node = $getNodeByKey(nodeKey);
		if ($isSelectFieldNode(node)) value = node.getValue();
	});
	return value;
}

function nodeOptions(editor: LexicalEditor, nodeKey: NodeKey): readonly string[] {
	let options: readonly string[] = [];
	editor.getEditorState().read(() => {
		const node = $getNodeByKey(nodeKey);
		if ($isSelectFieldNode(node)) options = node.getOptions();
	});
	return options;
}

/** Fire a row button's mousedown, then flush the (non-discrete) editor update
 *  it schedules so the node mutation is visible to the assertion. */
async function mouseDown(el: Element | null | undefined): Promise<void> {
	await act(async () => {
		el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		await Promise.resolve();
	});
}

describe("SelectFieldView picker (runtime)", () => {
	it("opens the runtime picker with a row per option", () => {
		mountAndOpen(["Todo", "Doing", "Done"]);
		expect(getActiveMenuStore()?.isOpen(SELECT_FIELD_MENU_ID)).toBe(true);
		renderMenuContent();
		expect(optionButtons().map((b) => b.textContent)).toEqual(["Todo", "Doing", "Done"]);
	});

	it("clicking an option sets it as the node value", async () => {
		const { editor, nodeKey } = mountAndOpen(["Todo", "Doing", "Done"]);
		renderMenuContent();
		await mouseDown(optionButtons().find((b) => b.textContent === "Doing"));
		expect(nodeValue(editor, nodeKey)).toBe("Doing");
	});

	it("the × removes the option from the node", async () => {
		const { editor, nodeKey } = mountAndOpen(["Todo", "Doing", "Done"]);
		renderMenuContent();
		const doingRow = optionButtons()
			.find((b) => b.textContent === "Doing")
			?.closest(".notes__select-field-row");
		await mouseDown(doingRow?.querySelector(".notes__select-field-remove"));
		expect(nodeOptions(editor, nodeKey)).toEqual(["Todo", "Done"]);
	});

	it("typing + Enter in the footer adds the option and selects it", async () => {
		const { editor, nodeKey } = mountAndOpen(["Todo"]);
		renderMenuContent();
		const input = menuContainer.querySelector<HTMLInputElement>(".notes__select-field-input");
		if (!input) throw new Error("add-option input did not render");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "Blocked");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
			await Promise.resolve();
		});
		expect(nodeOptions(editor, nodeKey)).toContain("Blocked");
		expect(nodeValue(editor, nodeKey)).toBe("Blocked");
	});
});
