// @vitest-environment jsdom
import {
	$createListItemNode,
	$createListNode,
	$isListNode,
	ListItemNode,
	ListNode,
} from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	type LexicalEditor,
	type NodeKey,
	createEditor as createLexicalEditor,
} from "lexical";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BlockCommand, CommandCategory } from "../block-command";
import { createEditorT } from "../i18n";

const picker = vi.hoisted(() => ({
	open: vi.fn<(options: Record<string, unknown>) => boolean>(() => true),
}));

vi.mock("@brainstorm-os/sdk/menus", () => ({
	openSearchPicker: (options: Record<string, unknown>) => picker.open(options),
}));

import {
	InsertPosition,
	createInsertBlockActions,
	insertBlockWithCommand,
	insertEmptyBlock,
	insertMenuRows,
	openInsertMenu,
	pickInsertTarget,
} from "./insert-menu";

const t = createEditorT();

function createEditor(): LexicalEditor {
	return createLexicalEditor({
		nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
		onError(error) {
			throw error;
		},
	});
}

function seed(editor: LexicalEditor, texts: readonly string[]): NodeKey[] {
	const keys: NodeKey[] = [];
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			for (const text of texts) {
				const p = $createParagraphNode();
				p.append($createTextNode(text));
				root.append(p);
				keys.push(p.getKey());
			}
		},
		{ discrete: true },
	);
	return keys;
}

function texts(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((c) => c.getTextContent()),
	);
}

function command(id: string, label: string, run: BlockCommand["run"] = () => {}): BlockCommand {
	return { id, category: CommandCategory.Basic, label, icon: null, keywords: [id], run };
}

const CATALOGUE: readonly BlockCommand[] = [
	command("block.paragraph", "Text"),
	command("block.heading1", "Heading 1"),
	command("block.quote", "Quote"),
];

beforeEach(() => {
	picker.open.mockReset();
	picker.open.mockImplementation(() => true);
});

describe("insertEmptyBlock", () => {
	it("places an empty paragraph below and parks the caret in it", () => {
		const editor = createEditor();
		const [a] = seed(editor, ["alpha", "bravo"]);
		const inserted = insertEmptyBlock(editor, a as NodeKey, InsertPosition.Below);
		expect(texts(editor)).toEqual(["alpha", "", "bravo"]);
		editor.getEditorState().read(() => {
			const sel = $getSelection();
			expect($isRangeSelection(sel) && sel.anchor.getNode().getKey()).toBe(inserted);
		});
	});

	it("places it above", () => {
		const editor = createEditor();
		const [, b] = seed(editor, ["alpha", "bravo"]);
		insertEmptyBlock(editor, b as NodeKey, InsertPosition.Above);
		expect(texts(editor)).toEqual(["alpha", "", "bravo"]);
	});

	it("never nests a paragraph inside a list when inserting above a list item", () => {
		const editor = createEditor();
		const itemKeys: NodeKey[] = [];
		editor.update(
			() => {
				const list = $createListNode("bullet");
				for (const text of ["one", "two"]) {
					const item = $createListItemNode();
					item.append($createTextNode(text));
					list.append(item);
					itemKeys.push(item.getKey());
				}
				$getRoot().clear().append(list);
			},
			{ discrete: true },
		);
		insertEmptyBlock(editor, itemKeys[0] as NodeKey, InsertPosition.Above);
		editor.getEditorState().read(() => {
			const [first, second] = $getRoot().getChildren();
			expect($isParagraphNode(first)).toBe(true);
			expect($isListNode(second)).toBe(true);
		});
		insertEmptyBlock(editor, itemKeys[1] as NodeKey, InsertPosition.Above);
		editor.getEditorState().read(() => {
			const kinds = $getRoot()
				.getChildren()
				.map((c) => c.getType());
			expect(kinds).toEqual(["paragraph", "list", "paragraph", "list"]);
		});
	});

	it("returns null for a block that is gone", () => {
		const editor = createEditor();
		seed(editor, ["alpha"]);
		expect(insertEmptyBlock(editor, "missing", InsertPosition.Below)).toBeNull();
	});
});

describe("insertMenuRows", () => {
	it("lists the whole catalogue for an empty query and ranks a query", () => {
		expect(insertMenuRows(CATALOGUE, "", "none").map((r) => r.id)).toEqual([
			"block.paragraph",
			"block.heading1",
			"block.quote",
		]);
		expect(insertMenuRows(CATALOGUE, "quo", "none").map((r) => r.id)).toEqual(["block.quote"]);
	});

	it("returns one disabled empty-state row when nothing matches", () => {
		const rows = insertMenuRows(CATALOGUE, "zzz", "No matching blocks");
		expect(rows).toEqual([{ id: "insert:empty", label: "No matching blocks", disabled: true }]);
	});
});

describe("openInsertMenu", () => {
	it("opens the shared search picker anchored to the trigger element", () => {
		const editor = createEditor();
		const [a] = seed(editor, ["alpha"]);
		const anchor = document.createElement("button");
		openInsertMenu({
			editor,
			blockKey: a as NodeKey,
			position: InsertPosition.Below,
			commands: CATALOGUE,
			t,
			anchor,
		});
		const options = picker.open.mock.calls[0]?.[0] as { anchor: Element; ariaLabel: string };
		expect(options.anchor).toBe(anchor);
		expect(options.ariaLabel).toBe("Insert a block");
		expect(texts(editor)).toEqual(["alpha"]);
	});

	it("inserts the chosen block below only after a choice", async () => {
		const editor = createEditor();
		const [a] = seed(editor, ["alpha", "bravo"]);
		const run = vi.fn();
		const commands = [command("block.x", "X", run)];
		openInsertMenu({
			editor,
			blockKey: a as NodeKey,
			position: InsertPosition.Below,
			commands,
			t,
		});
		const options = picker.open.mock.calls[0]?.[0] as { onSelect: (id: string) => void };
		options.onSelect("block.x");
		await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
		expect(texts(editor)).toEqual(["alpha", "", "bravo"]);
		expect(run.mock.calls[0]?.[0]).toMatchObject({ editor });
	});

	it("falls back to a plain paragraph when no menu host is mounted", () => {
		picker.open.mockImplementation(() => false);
		const editor = createEditor();
		const [a] = seed(editor, ["alpha"]);
		const onClose = vi.fn();
		openInsertMenu({
			editor,
			blockKey: a as NodeKey,
			position: InsertPosition.Below,
			commands: CATALOGUE,
			t,
			onClose,
		});
		expect(texts(editor)).toEqual(["alpha", ""]);
		expect(onClose).toHaveBeenCalled();
	});
});

describe("insertBlockWithCommand", () => {
	it("passes the document id to the command", async () => {
		const editor = createEditor();
		const [a] = seed(editor, ["alpha"]);
		const run = vi.fn();
		insertBlockWithCommand(
			editor,
			a as NodeKey,
			InsertPosition.Above,
			command("c", "C", run),
			"doc-1",
		);
		await vi.waitFor(() => expect(run).toHaveBeenCalled());
		expect(run.mock.calls[0]?.[0]).toMatchObject({ documentId: "doc-1" });
		expect(texts(editor)).toEqual(["", "alpha"]);
	});
});

describe("createInsertBlockActions", () => {
	it("targets the first block for Above and the last for Below", () => {
		const editor = createEditor();
		const [a, b, c] = seed(editor, ["alpha", "bravo", "charlie"]);
		const keys = new Set<NodeKey>([c as NodeKey, a as NodeKey]);
		expect(pickInsertTarget(editor, keys, InsertPosition.Above)).toBe(a);
		expect(pickInsertTarget(editor, keys, InsertPosition.Below)).toBe(c);
		expect(pickInsertTarget(editor, new Set([b as NodeKey]), InsertPosition.Below)).toBe(b);
	});

	it("exposes Insert above / below rows that open the picker", async () => {
		const editor = createEditor();
		const [a] = seed(editor, ["alpha"]);
		const actions = createInsertBlockActions(t, CATALOGUE);
		expect(actions.map((x) => [x.id, x.label, x.category])).toEqual([
			["block.insert.above", "Insert above…", CommandCategory.Insert],
			["block.insert.below", "Insert below…", CommandCategory.Insert],
		]);
		actions[1]?.run({ editor, blockKeys: new Set([a as NodeKey]) });
		await vi.waitFor(() => expect(picker.open).toHaveBeenCalledTimes(1));
	});
});
