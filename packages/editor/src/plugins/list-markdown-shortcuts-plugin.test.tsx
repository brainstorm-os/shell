// @vitest-environment happy-dom
import { $createCodeNode, $isCodeNode } from "@lexical/code";
import { $createListItemNode, $createListNode, $isListNode, type ListType } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $isQuoteNode } from "@lexical/rich-text";
import {
	$createTextNode,
	$getRoot,
	KEY_SPACE_COMMAND,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { BlockType } from "../block-types";
import { BrainstormEditor } from "../editor";
import { STANDARD_ADDITIONAL_NODES } from "../standard-nodes";
import { ListShortcutKind, matchListMarkdownPrefix } from "./list-markdown-shortcuts-plugin";
import { StandardEditingPlugins } from "./standard-editing-plugins";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CaptureEditor({ onReady }: { onReady: (e: LexicalEditor) => void }) {
	const [editor] = useLexicalComposerContext();
	onReady(editor);
	return null;
}

async function mountEditor(): Promise<{ editor: LexicalEditor; cleanup: () => void }> {
	const doc = new Doc();
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	let editor: LexicalEditor | null = null;
	await act(async () => {
		root.render(
			<BrainstormEditor doc={doc} namespace="test" additionalNodes={STANDARD_ADDITIONAL_NODES}>
				<StandardEditingPlugins />
				<CaptureEditor
					onReady={(e) => {
						editor = e;
					}}
				/>
			</BrainstormEditor>,
		);
	});
	await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
	return {
		editor: editor as unknown as LexicalEditor,
		cleanup: () => act(() => root.unmount()),
	};
}

/** Seed the doc with a single list of `listType` whose one item holds `text`,
 *  caret at the end of the text, then press Space. */
async function typePrefixInListItem(
	editor: LexicalEditor,
	listType: ListType,
	text: string,
): Promise<void> {
	await act(async () => {
		editor.update(() => {
			const root = $getRoot();
			root.clear();
			const list = $createListNode(listType);
			const item = $createListItemNode(listType === "check" ? false : undefined);
			const textNode = $createTextNode(text);
			item.append(textNode);
			list.append(item);
			root.append(list);
			textNode.select(text.length, text.length);
		});
	});
	await act(async () => {
		editor.dispatchCommand(
			KEY_SPACE_COMMAND,
			new KeyboardEvent("keydown", { key: " ", cancelable: true }),
		);
	});
}

function rootChildren(editor: LexicalEditor): LexicalNode[] {
	return editor.getEditorState().read(() => $getRoot().getChildren());
}

describe("matchListMarkdownPrefix (pure)", () => {
	it("matches the block prefixes the dogfood battery typed", () => {
		expect(matchListMarkdownPrefix("1.")).toEqual({
			kind: ListShortcutKind.List,
			listType: "number",
			checked: false,
		});
		expect(matchListMarkdownPrefix("12)")).toMatchObject({ listType: "number" });
		expect(matchListMarkdownPrefix("-")).toMatchObject({ listType: "bullet" });
		expect(matchListMarkdownPrefix("[]")).toEqual({
			kind: ListShortcutKind.List,
			listType: "check",
			checked: false,
		});
		expect(matchListMarkdownPrefix("[x]")).toMatchObject({ checked: true });
		expect(matchListMarkdownPrefix(">")).toEqual({
			kind: ListShortcutKind.Block,
			block: BlockType.Quote,
		});
		expect(matchListMarkdownPrefix("##")).toEqual({
			kind: ListShortcutKind.Block,
			block: BlockType.Heading2,
		});
		expect(matchListMarkdownPrefix("```")).toEqual({
			kind: ListShortcutKind.Code,
			language: null,
		});
		expect(matchListMarkdownPrefix("```ts")).toEqual({
			kind: ListShortcutKind.Code,
			language: "ts",
		});
		// `---` and its em-dash-mangled arrivals (`--`→`—` autocorrect).
		for (const divider of ["---", "***", "___", "—-", "——"]) {
			expect(matchListMarkdownPrefix(divider)).toEqual({ kind: ListShortcutKind.Divider });
		}
	});

	it("rejects non-prefixes", () => {
		for (const text of ["", "1", "--", "—", "####", "a.", "[xx]", "```!bad", "1500."]) {
			expect(matchListMarkdownPrefix(text)).toBeNull();
		}
	});
});

describe("ListMarkdownShortcutsPlugin", () => {
	let env: { editor: LexicalEditor; cleanup: () => void };

	beforeEach(async () => {
		env = await mountEditor();
	});
	afterEach(() => {
		env.cleanup();
	});

	it("`1. ` inside a bullet item converts to a numbered list, prefix stripped", async () => {
		await typePrefixInListItem(env.editor, "bullet", "1.");
		const lists = rootChildren(env.editor).filter($isListNode);
		expect(lists.some((l) => l.getListType() === "number")).toBe(true);
		expect(env.editor.getEditorState().read(() => $getRoot().getTextContent())).not.toContain("1.");
	});

	it("`[] ` inside a bullet item converts to an unchecked checklist", async () => {
		await typePrefixInListItem(env.editor, "bullet", "[]");
		const checked = env.editor.getEditorState().read(() => {
			const list = $getRoot()
				.getChildren()
				.filter($isListNode)
				.find((l) => l.getListType() === "check");
			const item = list?.getFirstChild();
			return item && "getChecked" in item
				? (item as { getChecked(): boolean | undefined }).getChecked()
				: undefined;
		});
		expect(checked).toBe(false);
	});

	it("`[x] ` converts to a checked to-do item", async () => {
		await typePrefixInListItem(env.editor, "bullet", "[x]");
		const checked = env.editor.getEditorState().read(() => {
			const list = $getRoot()
				.getChildren()
				.filter($isListNode)
				.find((l) => l.getListType() === "check");
			const item = list?.getFirstChild();
			return item && "getChecked" in item
				? (item as { getChecked(): boolean | undefined }).getChecked()
				: undefined;
		});
		expect(checked).toBe(true);
	});

	it("`> ` inside a numbered item converts to a quote", async () => {
		await typePrefixInListItem(env.editor, "number", ">");
		expect(rootChildren(env.editor).some($isQuoteNode)).toBe(true);
	});

	it("` ```ts ` inside a bullet item converts to a code block with the language", async () => {
		await typePrefixInListItem(env.editor, "bullet", "```ts");
		const code = rootChildren(env.editor).find($isCodeNode);
		expect(code).toBeDefined();
		expect(env.editor.getEditorState().read(() => code?.getLatest().getLanguage())).toBe("ts");
	});

	it("`—- ` (the em-dash-mangled `---`) inserts a divider", async () => {
		await typePrefixInListItem(env.editor, "bullet", "—-");
		expect(rootChildren(env.editor).some($isHorizontalRuleNode)).toBe(true);
	});

	it("a same-type prefix stays literal (`- ` inside a bullet does not convert)", async () => {
		await typePrefixInListItem(env.editor, "bullet", "-");
		const lists = rootChildren(env.editor).filter($isListNode);
		expect(lists).toHaveLength(1);
		expect(lists[0]?.getListType()).toBe("bullet");
		expect(env.editor.getEditorState().read(() => $getRoot().getTextContent())).toContain("-");
	});

	it("does nothing when the caret is not at a matching prefix", async () => {
		await typePrefixInListItem(env.editor, "bullet", "hello 1.");
		const lists = rootChildren(env.editor).filter($isListNode);
		expect(lists).toHaveLength(1);
		expect(lists[0]?.getListType()).toBe("bullet");
	});
});
