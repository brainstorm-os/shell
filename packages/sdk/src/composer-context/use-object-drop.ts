/**
 * `useComposerObjectDrop` (DND-4 reference adoption,) — drop an
 * object onto a composer to pin it as context. The drop `Reference` semantic:
 * each dropped `ObjectDragItem` becomes an `EntityAttachment` and is `add`ed to
 * the draft attachments — the same result as the "Link a document…" affordance,
 * reached by direct manipulation. Spans both transports via `useDropTarget`
 * (native intra-renderer drag from a list + the shell-mediated cross-app drop),
 * and only claims drags carrying the entity payload, so a media/file drop falls
 * through to the composer's upload path untouched.
 */

import { DragPayloadKind, type EntityAttachment } from "@brainstorm-os/sdk-types";
import {
	DropSemantic,
	type DropTargetHandle,
	effectForSemantic,
	useDropTarget,
} from "../object-dnd";
import { objectItemToAttachment } from "./object-attachment";

/** The minimal composer-context surface the drop needs — just `add`. */
export type ComposerObjectDropTarget = { add(attachment: EntityAttachment): boolean };

/** Wire a composer surface as an object drop target. Spread the returned
 *  `dropProps` on the composer element; drive a drop highlight off `isOver`. */
export function useComposerObjectDrop(ctx: ComposerObjectDropTarget): DropTargetHandle {
	return useDropTarget({
		accepts: (info) => info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => effectForSemantic(DropSemantic.Reference),
		onDrop: (payload) => {
			for (const item of payload.items) ctx.add(objectItemToAttachment(item));
		},
	});
}
