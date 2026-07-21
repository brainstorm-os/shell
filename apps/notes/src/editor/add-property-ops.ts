/**
 * Notes editor-state mutations for the add-property flow — the
 * `applyAddProperty*` family, one per `AddPropertyTargetKind`. Each must
 * run inside `editor.update(...)` (caller responsibility) so they can be
 * composed with the picker's close action.
 *
 * The pure search + classification helpers (`filterProperties`,
 * `categorizeProperty`, …) now live in `@brainstorm-os/sdk/property-ui` so
 * every properties panel shares one picker; they're re-exported here for
 * the existing Notes call sites + unit tests.
 *
 * Kept in a standalone module so unit tests can drive the insertion
 * logic against a headless editor without dragging the React menu in.
 */

import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { $createPropertyBlockNode, $isPropertyBlockNode } from "./nodes/property-block-node";
import {
	$isPropertyListBlockNode,
	type PropertyListBlockNode,
} from "./nodes/property-list-block-node";

export {
	type FilterResult,
	PropertyTypeCategory,
	categorizeProperty,
	filterProperties,
	isMultiProperty,
} from "@brainstorm-os/sdk/property-ui/pure";

/** Replace an existing paragraph (the one the user typed `/property`
 *  into) with a `PropertyBlockNode` bound to `propertyKey`. Caret
 *  lands at the next paragraph, or a fresh trailing one if the
 *  document ended with the targeted paragraph.
 *
 *  No-op if the paragraph is missing (race with concurrent edit). */
export function applyAddPropertyReplaceParagraph(
	editor: LexicalEditor,
	paragraphKey: NodeKey,
	propertyKey: string,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(paragraphKey);
			if (!node || !$isElementNode(node)) return;
			const block = $createPropertyBlockNode(propertyKey);
			node.replace(block);
			ensureTrailingParagraph(block.getKey());
		},
		{ discrete: true },
	);
}

/** Insert a fresh `PropertyBlockNode` after `blockKey`. Used by the
 *  gutter / right-click "Add property" path. */
export function applyAddPropertyInsertAfter(
	editor: LexicalEditor,
	blockKey: NodeKey,
	propertyKey: string,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(blockKey);
			if (!node || !$isElementNode(node)) {
				// Fall back to appending so the user still sees the block.
				if (!node) {
					const block = $createPropertyBlockNode(propertyKey);
					$getRoot().append(block);
					ensureTrailingParagraph(block.getKey());
				}
				return;
			}
			const block = $createPropertyBlockNode(propertyKey);
			node.insertAfter(block);
			ensureTrailingParagraph(block.getKey());
		},
		{ discrete: true },
	);
}

/** Append `propertyKey` to a `PropertyListBlockNode`'s `__propertyKeys`,
 *  idempotent (duplicate keys are dropped by the node's own writer). */
export function applyAddPropertyAppendToList(
	editor: LexicalEditor,
	listKey: NodeKey,
	propertyKey: string,
): void {
	editor.update(
		() => {
			const node = $getNodeByKey(listKey);
			if (!node || !$isPropertyListBlockNode(node)) return;
			(node as PropertyListBlockNode).addPropertyKey(propertyKey);
		},
		{ discrete: true },
	);
}

/** Make sure the document ends with a writable paragraph so the caret
 *  has somewhere to land after a `DecoratorNode` insertion. Called
 *  inside `editor.update()`. */
function ensureTrailingParagraph(newBlockKey: NodeKey): void {
	const node = $getNodeByKey(newBlockKey);
	if (!node) return;
	const next = node.getNextSibling();
	if (next && $isElementNode(next) && !$isPropertyBlockNode(next)) {
		next.selectStart();
		return;
	}
	if (!next) {
		const paragraph = $createParagraphNode();
		$getRoot().append(paragraph);
		paragraph.selectStart();
		return;
	}
	// `next` is itself a decorator — append a paragraph after the new
	// block so the caret still has a text target.
	const paragraph = $createParagraphNode();
	node.insertAfter(paragraph);
	paragraph.selectStart();
}
