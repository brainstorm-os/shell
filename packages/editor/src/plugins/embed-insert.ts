/**
 * Pure helpers for inserting a `BlockEmbedNode`.
 *
 * Two surfaces use these: the `/embed` slash command (which routes
 * through `block-embed-picker-plugin`, where the editor + paragraph key
 * are known) and the cross-app drag-into-note path (where a drop target
 * identifies the host paragraph). Keeping the editor mutation in pure
 * helpers lets the entity-picker UI and the slash wiring be tested
 * without a DOM.
 *
 * The helper *replaces* a target paragraph (the now-empty `/<query>`
 * row left behind by the slash menu) — it does not insert after.
 * Falling back to root-append on a missing key means a stale paragraph
 * key never silently drops the embed.
 */

import { $getNodeByKey, $getRoot, $isElementNode, type LexicalEditor, type NodeKey } from "lexical";
import { $createBlockEmbedNode } from "../nodes/block-embed-node";

export type EmbedInsertion = {
	entityId: string;
	entityType: string;
	label: string;
	/** The block id to render this embed with. Resolved by the caller from
	 *  the host's `blocks.forType(entityType)` (the providing app's live
	 *  block), falling back to the generic shell entity-card when omitted. */
	blockId?: string;
};

/** Replace the paragraph at `paragraphKey` with a `BlockEmbedNode`
 *  pointing at `insertion.entityId`. When the key is missing or no
 *  longer maps to an element node, falls back to appending at the root
 *  so the embed lands somewhere instead of silently dropping.
 *
 *  Wraps its own `editor.update({ discrete: true })` so callers don't
 *  need to know they're in a Lexical write transaction. */
export function applyEmbedInsertion(
	editor: LexicalEditor,
	paragraphKey: NodeKey | null,
	insertion: EmbedInsertion,
): void {
	editor.update(
		() => {
			const embed = insertion.blockId
				? $createBlockEmbedNode(
						insertion.entityId,
						insertion.entityType,
						insertion.label,
						insertion.blockId,
					)
				: $createBlockEmbedNode(insertion.entityId, insertion.entityType, insertion.label);
			const target = paragraphKey ? $getNodeByKey(paragraphKey) : null;
			if (target && $isElementNode(target)) {
				target.replace(embed);
				return;
			}
			$getRoot().append(embed);
		},
		{ discrete: true },
	);
}
