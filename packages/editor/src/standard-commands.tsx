/**
 * The shared default block-command catalogue — the generic slash-menu and
 * block-action set that needs no app-specific nodes or services. It is the
 * counterpart to each app's bespoke catalogue (Notes adds media / embed /
 * property commands on top): every app that mounts `<StandardEditingPlugins>`
 * gets exactly these, localised through the editor i18n seam (`EditorT`), so
 * the standard editing experience is defined ONCE in the common editor rather
 * than re-authored per app.
 *
 * Commands are built from an `EditorT` (not hard-coded strings) so a host
 * locale flips them via `<BrainstormEditor i18nOverrides>`. `createStandard*`
 * are factories because the label strings must resolve against the active
 * manifest at construction.
 */

import { INSERT_HORIZONTAL_RULE_COMMAND } from "@lexical/react/LexicalHorizontalRuleNode";
import { INSERT_TABLE_COMMAND } from "@lexical/table";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	type ElementFormatType,
	FORMAT_ELEMENT_COMMAND,
	INDENT_CONTENT_COMMAND,
	type LexicalEditor,
	type NodeKey,
	OUTDENT_CONTENT_COMMAND,
} from "lexical";
import type { ReactNode } from "react";
import { type BlockCommand, CommandCategory } from "./block-command";
import { BlockType, ToggleVariant } from "./block-types";
import type { EditorT } from "./i18n";
import {
	AlignCenterIcon,
	AlignJustifyIcon,
	AlignLeftIcon,
	AlignRightIcon,
	ArrowDownIcon,
	ArrowUpIcon,
	BulletListIcon,
	CalloutIcon,
	CodeIcon,
	ColumnsIcon,
	DividerIcon,
	DuplicateIcon,
	EmbedIcon,
	Heading1Icon,
	Heading2Icon,
	Heading3Icon,
	IndentIcon,
	NumberedListIcon,
	OutdentIcon,
	ParagraphIcon,
	QuoteIcon,
	TableIcon,
	TodoListIcon,
	ToggleIcon,
	TrashIcon,
} from "./icons";
import { duplicateBlocks, moveBlocksDown, moveBlocksUp } from "./plugins/block-ops";
import { INSERT_COLUMNS_COMMAND } from "./plugins/columns-plugin";
import { openEntityEmbedPicker } from "./plugins/embed-picker-store";
import { INSERT_TOGGLE_COMMAND } from "./plugins/toggle-plugin";
import { TURN_INTO_COMMAND } from "./plugins/turn-into-plugin";

/** Place a Lexical range selection spanning every key in `keys` so the next
 *  block command (`$setBlocksType` under `TURN_INTO_COMMAND`, align, indent)
 *  applies to all of them. The block keys come from the BlockSelectionStore,
 *  which doesn't drive Lexical's caret — this bridges them for one dispatch.
 *  Must run inside `editor.update`. */
export function selectBlocksAsRange(keys: ReadonlySet<NodeKey>): void {
	const targets = $getRoot()
		.getChildren()
		.filter((c) => keys.has(c.getKey()) && $isElementNode(c));
	const first = targets[0];
	const last = targets[targets.length - 1];
	if (!first || !last) return;
	first.selectStart();
	const sel = $getSelection();
	if (!$isRangeSelection(sel)) return;
	if ($isElementNode(last)) sel.focus.set(last.getKey(), last.getChildrenSize(), "element");
}

function deleteBlocks(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): void {
	editor.update(() => {
		const root = $getRoot();
		const children = root.getChildren();
		const firstIdx = children.findIndex((c) => keys.has(c.getKey()));
		const prevSibling = firstIdx > 0 ? children[firstIdx - 1] : null;
		for (const key of keys) $getNodeByKey(key)?.remove();
		if (root.getChildrenSize() === 0) {
			const paragraph = $createParagraphNode();
			root.append(paragraph);
			paragraph.selectStart();
			return;
		}
		if (prevSibling && $isElementNode(prevSibling)) {
			prevSibling.selectEnd();
			return;
		}
		const fallback = root.getFirstChild();
		if (fallback && $isElementNode(fallback)) fallback.selectStart();
	});
}

function turnInto(target: BlockType, blockKeys?: ReadonlySet<NodeKey>): (e: LexicalEditor) => void {
	return (editor) => {
		if (blockKeys && blockKeys.size > 0) editor.update(() => selectBlocksAsRange(blockKeys));
		editor.dispatchCommand(TURN_INTO_COMMAND, target);
	};
}

/** The slash-menu catalogue: turn-the-current-block-into-X plus the structural
 *  inserts (divider / toggle / table / columns). Every command here is generic —
 *  no media upload, no entity picker, no property store. */
export function createStandardBlockCommands(t: EditorT): readonly BlockCommand[] {
	const turnIntoCmd = (
		id: string,
		key: Parameters<EditorT>[0],
		icon: ReactNode,
		keywords: readonly string[],
		target: BlockType,
	): BlockCommand => ({
		id,
		category: CommandCategory.Basic,
		label: t(key),
		description: t(`${key}.description` as Parameters<EditorT>[0]),
		icon,
		keywords,
		run: ({ editor }) => turnInto(target)(editor),
	});

	const toggleHeadingCmd = (
		id: string,
		key: Parameters<EditorT>[0],
		level: string,
		variant: ToggleVariant,
	): BlockCommand => ({
		id,
		category: CommandCategory.Basic,
		label: t(key),
		description: t(`${key}.description` as Parameters<EditorT>[0]),
		icon: <ToggleIcon />,
		keywords: ["toggle", "heading", level, "collapsible", "section"],
		run: ({ editor }) => editor.dispatchCommand(INSERT_TOGGLE_COMMAND, variant),
	});

	return [
		turnIntoCmd(
			"block.paragraph",
			"editor.block.paragraph",
			<ParagraphIcon />,
			["text", "paragraph", "plain", "p"],
			BlockType.Paragraph,
		),
		turnIntoCmd(
			"block.heading1",
			"editor.block.heading1",
			<Heading1Icon />,
			["heading", "h1", "title", "large"],
			BlockType.Heading1,
		),
		turnIntoCmd(
			"block.heading2",
			"editor.block.heading2",
			<Heading2Icon />,
			["heading", "h2", "subtitle"],
			BlockType.Heading2,
		),
		turnIntoCmd(
			"block.heading3",
			"editor.block.heading3",
			<Heading3Icon />,
			["heading", "h3", "subheading"],
			BlockType.Heading3,
		),
		turnIntoCmd(
			"block.bulletList",
			"editor.block.bulletList",
			<BulletListIcon />,
			["bullet", "list", "unordered", "ul"],
			BlockType.BulletList,
		),
		turnIntoCmd(
			"block.numberedList",
			"editor.block.numberedList",
			<NumberedListIcon />,
			["numbered", "ordered", "list", "ol"],
			BlockType.NumberedList,
		),
		turnIntoCmd(
			"block.todoList",
			"editor.block.todoList",
			<TodoListIcon />,
			["todo", "task", "checkbox", "check"],
			BlockType.TodoList,
		),
		turnIntoCmd(
			"block.quote",
			"editor.block.quote",
			<QuoteIcon />,
			["quote", "blockquote", "cite"],
			BlockType.Quote,
		),
		turnIntoCmd(
			"block.code",
			"editor.block.code",
			<CodeIcon />,
			["code", "snippet", "monospace", "fence"],
			BlockType.Code,
		),
		turnIntoCmd(
			"block.callout",
			"editor.block.callout",
			<CalloutIcon />,
			["callout", "note", "info", "aside"],
			BlockType.Callout,
		),
		{
			id: "block.divider",
			category: CommandCategory.Embed,
			label: t("editor.block.divider"),
			description: t("editor.block.divider.description"),
			icon: <DividerIcon />,
			keywords: ["divider", "hr", "rule", "separator", "line"],
			run: ({ editor }) => editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined),
		},
		{
			id: "block.toggle",
			category: CommandCategory.Basic,
			label: t("editor.block.toggle"),
			description: t("editor.block.toggle.description"),
			icon: <ToggleIcon />,
			keywords: ["toggle", "collapsible", "collapse", "expand", "accordion", "details"],
			run: ({ editor }) => editor.dispatchCommand(INSERT_TOGGLE_COMMAND, ToggleVariant.Paragraph),
		},
		toggleHeadingCmd(
			"block.toggleHeading1",
			"editor.block.toggleHeading1",
			"h1",
			ToggleVariant.Heading1,
		),
		toggleHeadingCmd(
			"block.toggleHeading2",
			"editor.block.toggleHeading2",
			"h2",
			ToggleVariant.Heading2,
		),
		toggleHeadingCmd(
			"block.toggleHeading3",
			"editor.block.toggleHeading3",
			"h3",
			ToggleVariant.Heading3,
		),
		{
			id: "block.table",
			category: CommandCategory.Embed,
			label: t("editor.block.table"),
			description: t("editor.block.table.description"),
			icon: <TableIcon />,
			keywords: ["table", "grid", "rows", "spreadsheet"],
			run: ({ editor }) =>
				editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: "3", rows: "3", includeHeaders: true }),
		},
		{
			id: "block.columns2",
			category: CommandCategory.Embed,
			label: t("editor.block.columns2"),
			description: t("editor.block.columns2.description"),
			icon: <ColumnsIcon />,
			keywords: ["columns", "column", "layout", "two", "2"],
			run: ({ editor }) => editor.dispatchCommand(INSERT_COLUMNS_COMMAND, 2),
		},
		{
			id: "block.columns3",
			category: CommandCategory.Embed,
			label: t("editor.block.columns3"),
			description: t("editor.block.columns3.description"),
			icon: <ColumnsIcon />,
			keywords: ["columns", "column", "layout", "three", "3"],
			run: ({ editor }) => editor.dispatchCommand(INSERT_COLUMNS_COMMAND, 3),
		},
	];
}

/** Restrict + reorder a command set to an app's declared palette (F-070 rung
 *  (b)): keep only commands whose `id` is listed, in the palette's order. Ids
 *  in the palette with no matching command are skipped; commands not in the
 *  palette are dropped. An empty/omitted palette returns the input unchanged
 *  (default = the full shared catalogue). Pure — unit-tested. */
export function orderCommandsByPalette(
	commands: readonly BlockCommand[],
	palette: readonly string[] | undefined,
): readonly BlockCommand[] {
	if (!palette || palette.length === 0) return commands;
	const byId = new Map(commands.map((c) => [c.id, c]));
	const ordered: BlockCommand[] = [];
	for (const id of palette) {
		const cmd = byId.get(id);
		if (cmd) ordered.push(cmd);
	}
	return ordered;
}

/** Slash command that opens the transclusion typeahead — the shared "embed a
 *  live page" affordance for any app whose editor enables transclusion (an
 *  entity context is present). The slash menu clears the `/<query>` and leaves
 *  the caret at the start of an empty block before running, so inserting the
 *  `!@` trigger there satisfies `detectTransclusionTrigger` (start-of-line) and
 *  hands off to `TransclusionTypeaheadPlugin` for picking the page. Kept
 *  separate from the base set because it's gated on host capability, not a
 *  generic block. */
export function createTransclusionCommand(t: EditorT): BlockCommand {
	return {
		id: "block.transclusion",
		category: CommandCategory.Embed,
		label: t("editor.block.transclusion"),
		description: t("editor.block.transclusion.description"),
		icon: <EmbedIcon />,
		keywords: ["reference", "embed", "transclude", "transclusion", "mention", "link", "page", "live"],
		run: ({ editor }) => {
			editor.update(() => {
				const sel = $getSelection();
				if ($isRangeSelection(sel)) sel.insertText("!@");
			});
		},
	};
}

/** Slash command that opens the entity-embed picker — the shared "insert a
 *  preview card of another vault object" affordance (`BlockEmbedNode`).
 *  Host-gated like `createTransclusionCommand`: `<FullEditorPlugins>` adds
 *  it whenever the editor has an entity context, and Notes interleaves the
 *  same command into its bespoke catalogue — one id (`block.embed.entity`),
 *  one wording, everywhere (F-070). The slash menu clears the `/<query>`
 *  and leaves the caret in an empty block before `run`, so the picker
 *  anchors against that paragraph and the chosen entity replaces it. */
export function createEntityEmbedCommand(t: EditorT): BlockCommand {
	return {
		id: "block.embed.entity",
		category: CommandCategory.Embed,
		label: t("editor.block.embedEntity"),
		description: t("editor.block.embedEntity.description"),
		icon: <EmbedIcon />,
		keywords: ["embed", "preview", "page", "entity", "card", "reference", "insert"],
		run: ({ editor }) => {
			openEntityEmbedPicker(editor);
		},
	};
}

/** The block-action catalogue surfaced by the gutter grip / block menu —
 *  multi-block-aware (turn-into / align / indent / move / duplicate / delete
 *  all honour `ctx.blockKeys`). */
export function createStandardBlockActions(t: EditorT): readonly BlockCommand[] {
	const turnIntoAction = (
		target: BlockType,
		key: Parameters<EditorT>[0],
		icon: ReactNode,
		keywords: readonly string[],
	): BlockCommand => ({
		id: `block.turn.${target}`,
		category: CommandCategory.TurnInto,
		label: t(key),
		icon,
		keywords,
		run: ({ editor, blockKeys }) => turnInto(target, blockKeys)(editor),
	});

	const alignAction = (
		format: Exclude<ElementFormatType, "" | "start" | "end">,
		key: Parameters<EditorT>[0],
		icon: ReactNode,
		keywords: readonly string[],
	): BlockCommand => ({
		id: `block.align.${format}`,
		category: CommandCategory.Align,
		label: t(key),
		icon,
		keywords,
		run: ({ editor, blockKeys }) => {
			if (blockKeys && blockKeys.size > 0) editor.update(() => selectBlocksAsRange(blockKeys));
			editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, format);
		},
	});

	return [
		turnIntoAction(BlockType.Paragraph, "editor.block.paragraph", <ParagraphIcon />, [
			"text",
			"paragraph",
		]),
		turnIntoAction(BlockType.Heading1, "editor.block.heading1", <Heading1Icon />, ["heading", "h1"]),
		turnIntoAction(BlockType.Heading2, "editor.block.heading2", <Heading2Icon />, ["heading", "h2"]),
		turnIntoAction(BlockType.Heading3, "editor.block.heading3", <Heading3Icon />, ["heading", "h3"]),
		turnIntoAction(BlockType.BulletList, "editor.block.bulletList", <BulletListIcon />, [
			"bullet",
			"list",
		]),
		turnIntoAction(BlockType.NumberedList, "editor.block.numberedList", <NumberedListIcon />, [
			"numbered",
			"list",
		]),
		turnIntoAction(BlockType.TodoList, "editor.block.todoList", <TodoListIcon />, ["todo", "task"]),
		turnIntoAction(BlockType.Quote, "editor.block.quote", <QuoteIcon />, ["quote"]),
		turnIntoAction(BlockType.Code, "editor.block.code", <CodeIcon />, ["code"]),
		alignAction("left", "editor.action.align.left", <AlignLeftIcon />, ["align", "left"]),
		alignAction("center", "editor.action.align.center", <AlignCenterIcon />, ["align", "center"]),
		alignAction("right", "editor.action.align.right", <AlignRightIcon />, ["align", "right"]),
		alignAction("justify", "editor.action.align.justify", <AlignJustifyIcon />, ["align", "justify"]),
		{
			id: "block.indent.increase",
			category: CommandCategory.Indent,
			label: t("editor.action.indent.increase"),
			icon: <IndentIcon />,
			keywords: ["indent", "tab", "nest"],
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) editor.update(() => selectBlocksAsRange(blockKeys));
				editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
			},
		},
		{
			id: "block.indent.decrease",
			category: CommandCategory.Indent,
			label: t("editor.action.indent.decrease"),
			icon: <OutdentIcon />,
			keywords: ["outdent", "untab", "unnest"],
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) editor.update(() => selectBlocksAsRange(blockKeys));
				editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
			},
		},
		{
			id: "block.action.moveUp",
			category: CommandCategory.Action,
			label: t("editor.action.moveUp"),
			icon: <ArrowUpIcon />,
			keywords: ["move", "shift", "up"],
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) moveBlocksUp(editor, blockKeys);
			},
		},
		{
			id: "block.action.moveDown",
			category: CommandCategory.Action,
			label: t("editor.action.moveDown"),
			icon: <ArrowDownIcon />,
			keywords: ["move", "shift", "down"],
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) moveBlocksDown(editor, blockKeys);
			},
		},
		{
			id: "block.action.duplicate",
			category: CommandCategory.Action,
			label: t("editor.action.duplicate"),
			icon: <DuplicateIcon />,
			keywords: ["duplicate", "copy", "clone"],
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) duplicateBlocks(editor, blockKeys);
			},
		},
		{
			id: "block.action.delete",
			category: CommandCategory.Action,
			label: t("editor.action.delete"),
			icon: <TrashIcon />,
			keywords: ["delete", "remove", "trash"],
			destructive: true,
			run: ({ editor, blockKeys }) => {
				if (blockKeys && blockKeys.size > 0) deleteBlocks(editor, blockKeys);
			},
		},
	];
}
