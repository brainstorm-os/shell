/**
 * Pure display helpers for rendering an entity row/inspector. Extracted
 * from the former plain-DOM `app.ts` verbatim so the React renderer and
 * its tests share one implementation.
 */

import type { Icon } from "@brainstorm/sdk-types";
import { parseIcon } from "@brainstorm/sdk/entity-icon";
import { plural } from "@brainstorm/sdk/i18n";
import { t } from "../i18n";
import {
	type Entity,
	FILE_TYPE,
	FOLDER_TYPE,
	NOTE_TYPE,
	entityTypeName,
	readMembers,
} from "../types/entity";

/** The object's OWN universal icon, parsed defensively via the shared
 *  `parseIcon` (same validation every app uses). Returns null when the
 *  object has no own icon — per [[feedback_no_default_type_icon_fallback]]
 *  the caller renders NOTHING (empty sized slot), not a type-default
 *  emoji. */
export function readEntityIcon(entity: Entity): Icon | null {
	return parseIcon(entity.properties.icon);
}

export function typeLabel(entity: Entity): string {
	if (entity.type === FOLDER_TYPE) {
		const count = readMembers(entity).length;
		if (count === 0) return t("brainstorm.files.status.itemsZero");
		return plural(
			t,
			count,
			"brainstorm.files.status.itemsCount.one",
			"brainstorm.files.status.itemsCount.other",
		);
	}
	if (entity.type === FILE_TYPE) {
		const mime = entity.properties.mime;
		return typeof mime === "string"
			? (mime.split("/").pop() ?? mime)
			: t("brainstorm.files.type.file");
	}
	if (entity.type === NOTE_TYPE) return t("brainstorm.files.type.note");
	// The "Kind" cell for an arbitrary object the universal browser shows: the
	// type's name segment (`brainstorm/Task/v1` → "Task"). Machine-derived from
	// the type id like the file-mime fallback above, so it isn't t()-wrapped.
	return entityTypeName(entity.type);
}

const DAY_SECONDS = 86_400;

export function formatTimeAgo(when: number): string {
	if (!when) return "";
	const deltaSec = Math.max(0, (Date.now() - when) / 1000);
	if (deltaSec < DAY_SECONDS) return "Today";
	if (deltaSec < DAY_SECONDS * 2) return "Yesterday";
	if (deltaSec < DAY_SECONDS * 7) return `${Math.floor(deltaSec / DAY_SECONDS)} days ago`;
	if (deltaSec < DAY_SECONDS * 60) return `${Math.floor(deltaSec / (DAY_SECONDS * 7))} wks ago`;
	return new Date(when).toLocaleDateString();
}

export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
	return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
