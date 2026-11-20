/**
 * Pure display helpers for rendering an entity row/inspector. Extracted
 * from the former plain-DOM `app.ts` verbatim so the React renderer and
 * its tests share one implementation.
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { parseIcon } from "@brainstorm-os/sdk/entity-icon";
import { plural, t } from "../i18n";
import {
	type Entity,
	FILE_TYPE,
	FOLDER_TYPE,
	NOTE_TYPE,
	entityTypeName,
	readExtension,
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

/** MIME types that say "some bytes" rather than naming a format — what an
 *  import records when it could not tell. Their subtype is not a kind. */
const GENERIC_BINARY_MIMES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"binary/octet-stream",
	"application/x-binary",
	"application/unknown",
]);

/** The Kind of a file: its mime subtype when the mime names a real format,
 *  else its extension (`book.fb2.epub` → "EPUB"), else the generic "File". */
function fileKindLabel(entity: Entity): string {
	const raw = entity.properties.mime;
	const mime = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (mime !== "" && !GENERIC_BINARY_MIMES.has(mime)) {
		const subtype = mime.split("/").pop();
		if (subtype) return subtype;
	}
	const extension = readExtension(entity);
	return extension === "" ? t("brainstorm.files.type.file") : extension.toUpperCase();
}

export function typeLabel(entity: Entity): string {
	if (entity.type === FOLDER_TYPE) {
		const count = readMembers(entity).length;
		if (count === 0) return t("brainstorm.files.status.itemsZero");
		return plural(
			count,
			"brainstorm.files.status.itemsCount.one",
			"brainstorm.files.status.itemsCount.other",
		);
	}
	if (entity.type === FILE_TYPE) return fileKindLabel(entity);
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
	if (deltaSec < DAY_SECONDS) return t("brainstorm.files.modified.today");
	if (deltaSec < DAY_SECONDS * 2) return t("brainstorm.files.modified.yesterday");
	if (deltaSec < DAY_SECONDS * 7) {
		return plural(
			Math.floor(deltaSec / DAY_SECONDS),
			"brainstorm.files.modified.daysAgo.one",
			"brainstorm.files.modified.daysAgo.other",
		);
	}
	if (deltaSec < DAY_SECONDS * 60) {
		return plural(
			Math.floor(deltaSec / (DAY_SECONDS * 7)),
			"brainstorm.files.modified.weeksAgo.one",
			"brainstorm.files.modified.weeksAgo.other",
		);
	}
	return new Date(when).toLocaleDateString();
}

export { formatBytes } from "@brainstorm-os/sdk/format-bytes";
