// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { $createHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	$createTableCellNode,
	$createTableNode,
	$createTableRowNode,
	TableCellNode,
	TableNode,
	TableRowNode,
} from "@lexical/table";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type NodeKey,
	createEditor,
} from "lexical";
import { describe, expect, it } from "vitest";
import {
	$canHaveBlockBackground,
	BLOCK_BACKGROUND_ATTR,
	applyBlockBackground,
	blockBackgroundToken,
	createBlockBackgroundActions,
	readBlockBackground,
	registerBlockBackground,
	withBlockBackground,
} from "./block-background";
import { CommandCategory } from "./block-command";
import { createEditorT } from "./i18n";
import {
	insertBlocks,
	parseBrainstormPayload,
	serializeBlocksAsJson,
} from "./plugins/block-clipboard";
import { duplicateBlocks } from "./plugins/block-ops";
import { setTableCellBackground } from "./plugins/table-ops";
import { SwatchColor } from "./text-color";

function makeEditor(): LexicalEditor {
	return createEditor({
		nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, TableNode, TableRowNode, TableCellNode],
		onError(error) {
			throw error;
		},
	});
}

function seed(editor: LexicalEditor): {
	paragraph: NodeKey;
	heading: NodeKey;
	list: NodeKey;
	item: NodeKey;
} {
	const keys = { paragraph: "", heading: "", list: "", item: "" };
	editor.update(
		() => {
			const p = $createParagraphNode().append($createTextNode("para"));
			const h = $createHeadingNode("h2").append($createTextNode("head"));
			const item = $createListItemNode().append($createTextNode("item"));
			const list = $createListNode("bullet").append(item);
			$getRoot().clear().append(p, h, list);
			keys.paragraph = p.getKey();
			keys.heading = h.getKey();
			keys.list = list.getKey();
			keys.item = item.getKey();
		},
		{ discrete: true },
	);
	return keys;
}

function styleOf(editor: LexicalEditor, key: NodeKey): string {
	return editor.getEditorState().read(() => {
		const node = $getNodeByKey(key);
		return node && $isElementNode(node) ? node.getStyle() : "";
	});
}

describe("block background style", () => {
	it("stores only a swatch name and reads unknown values as Default", () => {
		const style = withBlockBackground("", SwatchColor.Blue);
		expect(style).toBe("--bs-block-background: blue");
		expect(readBlockBackground(style)).toBe(SwatchColor.Blue);
		expect(readBlockBackground("--bs-block-background: url(x)")).toBe(SwatchColor.Default);
		expect(readBlockBackground("")).toBe(SwatchColor.Default);
		expect(withBlockBackground(style, SwatchColor.Default)).toBe("");
		expect(blockBackgroundToken(SwatchColor.Red)).toBe("var(--color-block-background-red)");
		expect(blockBackgroundToken(SwatchColor.Default)).toBeNull();
	});

	it("applies to paragraphs, headings and list items but not list / table containers", () => {
		const editor = makeEditor();
		const keys = seed(editor);
		applyBlockBackground(
			editor,
			new Set([keys.paragraph, keys.heading, keys.list, keys.item]),
			SwatchColor.Green,
		);
		expect(readBlockBackground(styleOf(editor, keys.paragraph))).toBe(SwatchColor.Green);
		expect(readBlockBackground(styleOf(editor, keys.heading))).toBe(SwatchColor.Green);
		expect(readBlockBackground(styleOf(editor, keys.item))).toBe(SwatchColor.Green);
		expect(styleOf(editor, keys.list)).toBe("");
		editor.update(
			() => {
				expect($canHaveBlockBackground($createTableNode())).toBe(false);
			},
			{ discrete: true },
		);
		applyBlockBackground(editor, new Set([keys.paragraph]), SwatchColor.Default);
		expect(styleOf(editor, keys.paragraph)).toBe("");
	});

	it("mirrors the stored swatch onto the block DOM, live", () => {
		const editor = makeEditor();
		const root = document.createElement("div");
		root.contentEditable = "true";
		document.body.append(root);
		editor.setRootElement(root);
		const keys = seed(editor);
		const off = registerBlockBackground(editor);
		applyBlockBackground(editor, new Set([keys.heading]), SwatchColor.Purple);
		expect(editor.getElementByKey(keys.heading)?.getAttribute(BLOCK_BACKGROUND_ATTR)).toBe("purple");
		expect(editor.getElementByKey(keys.paragraph)?.hasAttribute(BLOCK_BACKGROUND_ATTR)).toBe(false);
		applyBlockBackground(editor, new Set([keys.heading]), SwatchColor.Default);
		expect(editor.getElementByKey(keys.heading)?.hasAttribute(BLOCK_BACKGROUND_ATTR)).toBe(false);
		off();
		editor.setRootElement(null);
		root.remove();
	});

	it("survives duplicate and the block clipboard round-trip", () => {
		const editor = makeEditor();
		const keys = seed(editor);
		applyBlockBackground(editor, new Set([keys.paragraph]), SwatchColor.Yellow);
		duplicateBlocks(editor, new Set([keys.paragraph]));
		const styles = editor.getEditorState().read(() =>
			$getRoot()
				.getChildren()
				.map((c) => ($isElementNode(c) ? readBlockBackground(c.getStyle()) : null)),
		);
		expect(styles.slice(0, 2)).toEqual([SwatchColor.Yellow, SwatchColor.Yellow]);

		const json = serializeBlocksAsJson(editor, new Set([keys.paragraph]));
		const payload = parseBrainstormPayload(json);
		expect(payload).not.toBeNull();
		if (!payload) return;
		const [pasted] = insertBlocks(editor, payload.blocks, new Set());
		expect(readBlockBackground(styleOf(editor, pasted as NodeKey))).toBe(SwatchColor.Yellow);
	});

	it("re-validates a pasted background name", () => {
		const editor = makeEditor();
		seed(editor);
		const [pasted] = insertBlocks(
			editor,
			[
				{
					type: "paragraph",
					version: 1,
					children: [],
					blockBackground: "expression(alert(1))",
				} as never,
			],
			new Set(),
		);
		expect(styleOf(editor, pasted as NodeKey)).toBe("");
	});

	it("offers one Background action per swatch in the block action menu", () => {
		const actions = createBlockBackgroundActions(createEditorT());
		expect(actions).toHaveLength(10);
		expect(actions.every((a) => a.category === CommandCategory.Background)).toBe(true);
		expect(actions.map((a) => a.label)).toContain("Blue");
		const editor = makeEditor();
		const keys = seed(editor);
		actions
			.find((a) => a.id === "block.background.red")
			?.run({
				editor,
				blockKeys: new Set([keys.paragraph]),
			});
		expect(readBlockBackground(styleOf(editor, keys.paragraph))).toBe(SwatchColor.Red);
	});
});

describe("table cell background", () => {
	it("sets and clears the caret cell's token background", () => {
		const editor = createHeadlessEditor({
			nodes: [TableNode, TableRowNode, TableCellNode],
			onError(error) {
				throw error;
			},
		});
		let cellKey: NodeKey = "";
		editor.update(
			() => {
				const cell = $createTableCellNode(0).append(
					$createParagraphNode().append($createTextNode("c")),
				);
				const table = $createTableNode().append($createTableRowNode().append(cell));
				$getRoot().clear().append(table);
				cell.getFirstChildOrThrow<ReturnType<typeof $createParagraphNode>>().selectEnd();
				cellKey = cell.getKey();
			},
			{ discrete: true },
		);
		setTableCellBackground(editor, blockBackgroundToken(SwatchColor.Blue));
		const read = () =>
			editor
				.getEditorState()
				.read(() => ($getNodeByKey(cellKey) as TableCellNode).getBackgroundColor());
		expect(read()).toBe("var(--color-block-background-blue)");
		setTableCellBackground(editor, null);
		expect(read()).toBeNull();
	});
});
