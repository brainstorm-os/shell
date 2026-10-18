/**
 * Block-level background (B11.23) — a tint behind a whole paragraph, heading,
 * quote, callout, toggle or list item, distinct from the inline highlight
 * (`text-color.ts`) that only paints text runs.
 *
 * Persistence: the element node's own `__style` (`ElementNode.setStyle`),
 * which `@lexical/yjs` syncs as a node property — so it lives in the document
 * Y.Doc, round-trips across devices and peers, and survives duplicate /
 * copy-paste through the editor's JSON clone paths (which carry it
 * explicitly, since Lexical 0.21's element `exportJSON` omits `style`). Only
 * the swatch NAME is stored (`--bs-block-background: blue`), never a CSS
 * colour: a peer can't smuggle an arbitrary value into the page, and the
 * rendered colour always comes from the active theme's
 * `--color-block-background-<hue>` token (defined in every theme).
 *
 * Rendering: `BlockBackgroundPlugin` mirrors the stored name onto the block's
 * DOM as `data-bs-block-background`, and `editor-theme.css` maps that to the
 * token. Table cells use Lexical's own cell background with the same tokens.
 */

import { $isListNode } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $isTableCellNode, $isTableNode, $isTableRowNode } from "@lexical/table";
import {
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isRootNode,
	type ElementNode,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
} from "lexical";
import { type ReactNode, useEffect } from "react";
import { type BlockCommand, CommandCategory } from "./block-command";
import type { EditorT } from "./i18n";
import { $isColumnNode, $isColumnsNode } from "./nodes/columns-node";
import { SWATCH_COLORS, SwatchColor, mergeStyleProp } from "./text-color";

export const BLOCK_BACKGROUND_STYLE_PROP = "--bs-block-background";
export const BLOCK_BACKGROUND_ATTR = "data-bs-block-background";

const HUES = new Set<string>(SWATCH_COLORS.filter((c) => c !== SwatchColor.Default));

/** The swatch a block's stored style names; anything unknown reads Default. */
export function readBlockBackground(style: string): SwatchColor {
	for (const decl of style.split(";")) {
		const idx = decl.indexOf(":");
		if (idx < 0) continue;
		if (decl.slice(0, idx).trim() !== BLOCK_BACKGROUND_STYLE_PROP) continue;
		const value = decl.slice(idx + 1).trim();
		return HUES.has(value) ? (value as SwatchColor) : SwatchColor.Default;
	}
	return SwatchColor.Default;
}

/** The stored style with its block background set (Default clears it). */
export function withBlockBackground(style: string, color: SwatchColor): string {
	return mergeStyleProp(
		style,
		BLOCK_BACKGROUND_STYLE_PROP,
		color === SwatchColor.Default ? null : color,
	);
}

/** The theme token a hue renders through. */
export function blockBackgroundToken(color: SwatchColor): string | null {
	return color === SwatchColor.Default ? null : `var(--color-block-background-${color})`;
}

/** Whether `node` takes a block background: a block-level element that is
 *  not a structural container (list, table, columns) or the root. */
export function $canHaveBlockBackground(node: LexicalNode | null): node is ElementNode {
	if (!node || !$isElementNode(node) || node.isInline() || $isRootNode(node)) return false;
	if ($isListNode(node) || $isColumnsNode(node) || $isColumnNode(node)) return false;
	return !($isTableNode(node) || $isTableRowNode(node) || $isTableCellNode(node));
}

/** Set (or clear, with Default) the background of every block in `keys`. */
export function applyBlockBackground(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	color: SwatchColor,
): void {
	if (keys.size === 0) return;
	editor.update(
		() => {
			for (const key of keys) {
				const node = $getNodeByKey(key);
				if ($canHaveBlockBackground(node)) node.setStyle(withBlockBackground(node.getStyle(), color));
			}
		},
		{ discrete: true },
	);
}

function syncElement(editor: LexicalEditor, key: NodeKey): void {
	const dom = editor.getElementByKey(key);
	if (!dom) return;
	const node = $getNodeByKey(key);
	const color = $canHaveBlockBackground(node)
		? readBlockBackground(node.getStyle())
		: SwatchColor.Default;
	if (color === SwatchColor.Default) dom.removeAttribute(BLOCK_BACKGROUND_ATTR);
	else dom.setAttribute(BLOCK_BACKGROUND_ATTR, color);
}

function syncAll(editor: LexicalEditor): void {
	editor.getEditorState().read(() => {
		const walk = (node: LexicalNode) => {
			if (!$isElementNode(node)) return;
			syncElement(editor, node.getKey());
			for (const child of node.getChildren()) walk(child);
		};
		walk($getRoot());
	});
}

/** Mirror stored block backgrounds onto the editor's DOM, now and on every
 *  update. Returns the unregister function. */
export function registerBlockBackground(editor: LexicalEditor): () => void {
	syncAll(editor);
	const offUpdate = editor.registerUpdateListener(({ editorState, dirtyElements }) => {
		if (dirtyElements.size === 0) return;
		editorState.read(() => {
			for (const key of dirtyElements.keys()) syncElement(editor, key);
		});
	});
	const offRoot = editor.registerRootListener(() => syncAll(editor));
	return () => {
		offUpdate();
		offRoot();
	};
}

/** Mounted by `<BrainstormEditor>` so every editor — read-only previews and
 *  nested transclusion bodies included — paints block backgrounds. */
export function BlockBackgroundPlugin(): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => registerBlockBackground(editor), [editor]);
	return null;
}

export function BackgroundSwatch({ color }: { color: SwatchColor }): ReactNode {
	return (
		<span
			className="bs-editor__bg-swatch"
			{...(color === SwatchColor.Default ? {} : { [BLOCK_BACKGROUND_ATTR]: color })}
			aria-hidden="true"
		/>
	);
}

type EditorI18nKey = Parameters<EditorT>[0];

/** Swatch label, shared with the inline colour picker's names. */
export function swatchLabel(t: EditorT, color: SwatchColor): string {
	return color === SwatchColor.Default
		? t("editor.inline.color.default")
		: t(`editor.inline.colorName.${color}` as EditorI18nKey);
}

/** Block-action-menu rows (Background section) for every swatch. */
export function createBlockBackgroundActions(t: EditorT): readonly BlockCommand[] {
	return SWATCH_COLORS.map((color) => ({
		id: `block.background.${color}`,
		category: CommandCategory.Background,
		label: swatchLabel(t, color),
		icon: <BackgroundSwatch color={color} />,
		keywords: ["background", "fill", "shade", "color", "colour", color],
		run: ({ editor, blockKeys }) => {
			if (blockKeys && blockKeys.size > 0) applyBlockBackground(editor, blockKeys, color);
		},
	}));
}
