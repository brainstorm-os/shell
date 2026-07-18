/**
 * EntityDropPlugin (B11.8) — accept an object dragged from a list / sidebar /
 * search surface and drop it into the editor as a reference at the drop point.
 *
 * Payload contract is the shared `@brainstorm/sdk/entity-drag` MIME
 * (`application/vnd.brainstorm.entity+json`). The drop handler mirrors
 * `MediaDropPlugin`: Lexical moves the caret to the drop position before
 * `DROP_COMMAND` fires, so `$getSelection()` is the drop point.
 *
 *   - Plain drop  → an inline `MentionNode` link in a new paragraph
 *     ("link block at drop point").
 *   - Alt-drop    → a block-level `TransclusionNode` (the live-preview card).
 *
 * Self-drop (dropping the open note into itself) is rejected so a note can't
 * reference itself — same guard the `@`-mention / `!@`-transclusion pickers
 * apply on insertion.
 *
 * Cross-app drag (another app's window → this editor) IS now covered, via the
 * shell-mediated drag session (DND-3): `useDropTarget` (cross-app only —
 * `nativeDisabled`, since the native path above is Lexical-command-based)
 * registers this editor as a window-level reference target. A cross-app drop
 * carries no Alt modifier, so each dropped object lands as a `MentionNode`
 * (the least-destructive default); intra-renderer Alt-drop still transcludes.
 */

import { useYDocLoaded } from "@brainstorm/react-yjs";
import { DragPayloadKind, DropEffect } from "@brainstorm/sdk-types";
import { announce } from "@brainstorm/sdk/a11y";
import {
	type EntityDragPayload,
	dataTransferHasEntity,
	readEntityDragData,
} from "@brainstorm/sdk/entity-drag";
import { useDropTarget } from "@brainstorm/sdk/object-dnd";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
	$createParagraphNode,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_HIGH,
	DRAGOVER_COMMAND,
	DROP_COMMAND,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { useEffect } from "react";
import { t, tCount } from "../i18n/t";
import { $createMentionNode } from "./nodes/mention-node";
import { $createTransclusionNode } from "./nodes/transclusion-node";
import { drainPendingEntityLinks, onPendingEntityLinks } from "./pending-link";

export type EntityDropPluginProps = {
	/** The open note's id — a drop of this same entity is rejected (no
	 *  self-reference), mirroring the mention / transclusion pickers. */
	currentNoteId: string;
	/** The open note's display title — names the target in the DND-6
	 *  live-region announcement ("Linked 2 objects into “Roadmap”"). */
	noteTitle: string;
};

/** DND-6 — announce the reference operation (not the drag motion) through the
 *  shared live region. Untitled notes announce under the list's fallback. */
function announceLinked(count: number, noteTitle: string): void {
	const note = noteTitle.trim() || t("notes.list.untitled");
	announce(tCount("notes.a11y.entityLinked", count, { note }));
}

export function EntityDropPlugin({ currentNoteId, noteTitle }: EntityDropPluginProps): null {
	const [editor] = useLexicalComposerContext();

	// Cross-app transport (DND-3): a drag from ANOTHER app's window. The shell
	// hit-tests this window + delivers the reference-only payload; insert each
	// object (≠ the open note) as a mention. Native intra-renderer DnD stays on
	// the Lexical commands below, so `nativeDisabled` here avoids double-wiring.
	useDropTarget({
		nativeDisabled: true,
		accepts: (info) => info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => DropEffect.Link,
		onDrop: (payload) => {
			const items = payload.items.filter((item) => item.entityId !== currentNoteId);
			if (items.length > 0) {
				appendEntityReferences(editor, items);
				announceLinked(items.length, noteTitle);
			}
		},
	});

	useEffect(() => {
		const removeDragover = editor.registerCommand(
			DRAGOVER_COMMAND,
			(event) => {
				if (!dataTransferHasEntity(event.dataTransfer)) return false;
				event.preventDefault();
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);

		const removeDrop = editor.registerCommand(
			DROP_COMMAND,
			(event) => {
				const payload = readEntityDragData(event.dataTransfer);
				if (!payload) return false;
				event.preventDefault();
				if (payload.entityId === currentNoteId) return true;
				insertEntityReference(editor, payload, event.altKey);
				announceLinked(1, noteTitle);
				return true;
			},
			COMMAND_PRIORITY_HIGH,
		);

		return () => {
			removeDragover();
			removeDrop();
		};
	}, [editor, currentNoteId, noteTitle]);

	return null;
}

/**
 * DND-6 — drains the "Link to note…" queue (`pending-link.ts`) into this
 * note once its Y.Doc snapshot has merged, appending the same MentionNode
 * blocks a drop produces (one transaction, one undo step, one announcement).
 * Waiting on `whenLoaded` matters: appending into a still-empty replica
 * would race the snapshot merge and duplicate content (see `useYDocLoaded`).
 */
export function PendingEntityLinkPlugin({ currentNoteId, noteTitle }: EntityDropPluginProps): null {
	const [editor] = useLexicalComposerContext();
	const whenLoaded = useYDocLoaded(currentNoteId);

	useEffect(() => {
		let alive = true;
		const insert = (): void => {
			const items = drainPendingEntityLinks(currentNoteId).filter(
				(item) => item.entityId !== currentNoteId,
			);
			if (items.length === 0) return;
			void Promise.resolve(whenLoaded).then(() => {
				if (!alive) return;
				appendEntityReferences(editor, items);
				announceLinked(items.length, noteTitle);
			});
		};
		insert(); // queued before this note mounted (the picker → open flow)
		const off = onPendingEntityLinks(currentNoteId, insert);
		return () => {
			alive = false;
			off();
		};
	}, [editor, currentNoteId, whenLoaded, noteTitle]);

	return null;
}

/** Build the block a dropped reference becomes: a block-level transclusion card,
 *  or an inline mention wrapped in its own paragraph ("link block"). */
function createReferenceBlock(payload: EntityDragPayload, asTransclusion: boolean): LexicalNode {
	const reference = asTransclusion
		? $createTransclusionNode(payload.entityId, payload.entityType, payload.label)
		: $createMentionNode(payload.entityId, payload.entityType, payload.label);
	return asTransclusion ? reference : $createParagraphNode().append(reference);
}

export function insertEntityReference(
	editor: LexicalEditor,
	payload: EntityDragPayload,
	asTransclusion: boolean,
): void {
	editor.update(
		() => {
			const block = createReferenceBlock(payload, asTransclusion);
			const sel = $getSelection();
			if ($isRangeSelection(sel)) {
				try {
					sel.anchor.getNode().getTopLevelElementOrThrow().insertAfter(block);
					return;
				} catch {
					// fall through to root append
				}
			}
			const last = $getRoot().getLastChild() as LexicalNode | null;
			if (last) last.insertAfter(block);
			else $getRoot().append(block);
		},
		{ discrete: true },
	);
}

/** Append N references (mentions) at the end of the document IN ORDER, in a
 *  single transaction — the cross-app drop path, which has no caret to insert
 *  at. One `editor.update` keeps insertion order correct (each appended block
 *  becomes the new last child) and makes the whole drop one undo step. */
export function appendEntityReferences(
	editor: LexicalEditor,
	payloads: readonly EntityDragPayload[],
): void {
	editor.update(
		() => {
			for (const payload of payloads) {
				const block = createReferenceBlock(payload, false);
				const last = $getRoot().getLastChild() as LexicalNode | null;
				if (last) last.insertAfter(block);
				else $getRoot().append(block);
			}
		},
		{ discrete: true },
	);
}
