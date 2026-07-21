/**
 * Pure `ObjectDragItem` → `EntityAttachment` mapping (DND-4 — drop an object onto
 * a composer to pin it as context). Isolated from the rest of `composer-context`
 * (which pulls React + the icon registry) so it depends ONLY on `sdk-types` and
 * stays trivially testable.
 */

import {
	AttachmentKind,
	type EntityAttachment,
	type ObjectDragItem,
} from "@brainstorm-os/sdk-types";

/** Build a pinned-entity attachment from a dragged object. Omits empty optional
 *  fields for `exactOptionalPropertyTypes`. */
export function objectItemToAttachment(item: ObjectDragItem): EntityAttachment {
	const label = item.label.trim();
	return {
		kind: AttachmentKind.Entity,
		ref: item.entityId,
		...(label ? { label } : {}),
		...(item.entityType ? { entityType: item.entityType } : {}),
	};
}
