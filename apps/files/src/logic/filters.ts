/**
 * Property filters for the folder-contents list (9.8.16 — Files as a
 * collection). Pure: the store runs `applyFileFilters` over the already
 * sorted/searched rows, so filters compose with sort, group-by, search and
 * the Duplicates view instead of each owning a private narrowing pass.
 *
 * The date axis reuses the SDK's live-rolling `RelativeDateRange` (the same
 * resolver the Database filter language evaluates), so "Last 7 days" here
 * and in a Database view are one definition.
 */

import {
	RelativeDateRange,
	isRelativeDateRange,
	resolveRelativeRange,
} from "@brainstorm-os/sdk/predicate-eval";
import {
	type Entity,
	FILE_TYPE,
	FOLDER_TYPE,
	NOTE_TYPE,
	readExtension,
	readSize,
} from "../types/entity";

export enum KindFilter {
	Any = "any",
	Folder = "folder",
	Image = "image",
	Document = "document",
	Audio = "audio",
	Video = "video",
	Archive = "archive",
	Other = "other",
}

export const KIND_FILTERS: readonly KindFilter[] = [
	KindFilter.Any,
	KindFilter.Folder,
	KindFilter.Image,
	KindFilter.Document,
	KindFilter.Audio,
	KindFilter.Video,
	KindFilter.Archive,
	KindFilter.Other,
];

export enum SizeFilter {
	Any = "any",
	Tiny = "tiny",
	Small = "small",
	Medium = "medium",
	Large = "large",
	Huge = "huge",
}

export const SIZE_FILTERS: readonly SizeFilter[] = [
	SizeFilter.Any,
	SizeFilter.Tiny,
	SizeFilter.Small,
	SizeFilter.Medium,
	SizeFilter.Large,
	SizeFilter.Huge,
];

const KB = 1024;
const MB = 1024 * KB;

/** Half-open byte bands `[min, max)`; the bands tile the whole range so
 *  every sized file lands in exactly one. */
const SIZE_BANDS: Record<Exclude<SizeFilter, SizeFilter.Any>, { min: number; max: number }> = {
	[SizeFilter.Tiny]: { min: 0, max: 100 * KB },
	[SizeFilter.Small]: { min: 100 * KB, max: MB },
	[SizeFilter.Medium]: { min: MB, max: 10 * MB },
	[SizeFilter.Large]: { min: 10 * MB, max: 100 * MB },
	[SizeFilter.Huge]: { min: 100 * MB, max: Number.POSITIVE_INFINITY },
};

/** Only the look-back ranges make sense for "modified" — nothing in the vault
 *  was modified tomorrow. */
export const MODIFIED_RANGES: readonly RelativeDateRange[] = [
	RelativeDateRange.Today,
	RelativeDateRange.Yesterday,
	RelativeDateRange.Last7Days,
	RelativeDateRange.Last30Days,
	RelativeDateRange.ThisWeek,
	RelativeDateRange.ThisMonth,
	RelativeDateRange.ThisYear,
];

export type FileFilters = {
	kind: KindFilter;
	size: SizeFilter;
	/** `null` = any time. */
	modified: RelativeDateRange | null;
	/** Lower-cased, no dot; `null` = any extension. */
	extension: string | null;
};

export const DEFAULT_FILE_FILTERS: FileFilters = Object.freeze({
	kind: KindFilter.Any,
	size: SizeFilter.Any,
	modified: null,
	extension: null,
});

export function hasActiveFilters(filters: FileFilters): boolean {
	return (
		filters.kind !== KindFilter.Any ||
		filters.size !== SizeFilter.Any ||
		filters.modified !== null ||
		filters.extension !== null
	);
}

export function countActiveFilters(filters: FileFilters): number {
	return (
		(filters.kind !== KindFilter.Any ? 1 : 0) +
		(filters.size !== SizeFilter.Any ? 1 : 0) +
		(filters.modified !== null ? 1 : 0) +
		(filters.extension !== null ? 1 : 0)
	);
}

const DOCUMENT_MIMES = new Set([
	"application/pdf",
	"application/json",
	"application/xml",
	"application/rtf",
	"application/msword",
	"application/vnd.ms-excel",
	"application/vnd.ms-powerpoint",
	"application/epub+zip",
]);

const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-tar",
	"application/gzip",
	"application/x-7z-compressed",
	"application/vnd.rar",
	"application/x-rar-compressed",
	"application/x-bzip2",
]);

function readMime(entity: Entity): string {
	const mime = entity.properties.mime;
	return typeof mime === "string" ? mime.toLowerCase() : "";
}

/** The kind bucket an entity belongs to. Files bucket by MIME family;
 *  Notes read as documents; every other typed object is `Other`. */
export function kindOf(entity: Entity): Exclude<KindFilter, KindFilter.Any> {
	if (entity.type === FOLDER_TYPE) return KindFilter.Folder;
	if (entity.type === NOTE_TYPE) return KindFilter.Document;
	if (entity.type !== FILE_TYPE) return KindFilter.Other;
	const mime = readMime(entity);
	if (mime.startsWith("image/")) return KindFilter.Image;
	if (mime.startsWith("audio/")) return KindFilter.Audio;
	if (mime.startsWith("video/")) return KindFilter.Video;
	if (ARCHIVE_MIMES.has(mime)) return KindFilter.Archive;
	if (
		mime.startsWith("text/") ||
		DOCUMENT_MIMES.has(mime) ||
		mime.startsWith("application/vnd.openxmlformats-officedocument.") ||
		mime.startsWith("application/vnd.oasis.opendocument.")
	) {
		return KindFilter.Document;
	}
	return KindFilter.Other;
}

function matchesSize(entity: Entity, size: SizeFilter): boolean {
	if (size === SizeFilter.Any) return true;
	if (entity.type !== FILE_TYPE) return false;
	const band = SIZE_BANDS[size];
	const bytes = readSize(entity);
	return bytes >= band.min && bytes < band.max;
}

function matchesModified(entity: Entity, range: RelativeDateRange | null, now: number): boolean {
	if (range === null) return true;
	if (!isRelativeDateRange(range)) return false;
	const window = resolveRelativeRange(range, now);
	return entity.updatedAt >= window.start && entity.updatedAt < window.end;
}

export function matchesFilters(entity: Entity, filters: FileFilters, now: number): boolean {
	if (filters.kind !== KindFilter.Any && kindOf(entity) !== filters.kind) return false;
	if (!matchesSize(entity, filters.size)) return false;
	if (filters.extension !== null && readExtension(entity) !== filters.extension) return false;
	return matchesModified(entity, filters.modified, now);
}

/** Order-preserving narrow of `entities` to the rows every active filter
 *  accepts. Inactive filters return the input as-is (a defensive copy). */
export function applyFileFilters(
	entities: readonly Entity[],
	filters: FileFilters,
	now: number,
): Entity[] {
	if (!hasActiveFilters(filters)) return entities.slice();
	return entities.filter((entity) => matchesFilters(entity, filters, now));
}

/** The distinct extensions present among `entities`, A→Z — the options the
 *  extension filter offers (an extension nobody has is never a choice). A
 *  currently-selected extension stays listed even when no row carries it,
 *  so the picker can always show + clear the active choice. */
export function collectExtensions(entities: readonly Entity[], selected: string | null): string[] {
	const seen = new Set<string>();
	for (const entity of entities) {
		const ext = readExtension(entity);
		if (ext.length > 0) seen.add(ext);
	}
	if (selected !== null) seen.add(selected);
	return [...seen].sort((a, b) => a.localeCompare(b));
}
