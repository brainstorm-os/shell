/**
 * Persistence codec for `Bookmark/v1`.
 *
 * Long-term keystone — the on-disk JSON protocol that the Stage 9.3
 * entities service will read without rename. Reads + writes go through
 * these helpers; **all** runtime shape validation lives here so a
 * malformed row from a future migration / sync conflict drops to `null`
 * rather than crashing the renderer.
 *
 * Storage key: `bookmark:<id>` — one row per `Bookmark/v1`. Matches the
 * namespace convention `apps/notes` (`note:<id>`) + `apps/tasks`
 * (`task:<id>`) so the shell-side `vaultEntities` aggregator can pick
 * Bookmarks up by `<kind>:` prefix without code changes.
 */

import type { SerializedBlock } from "@brainstorm/sdk-types";
import { nullableNumber, nullableString } from "@brainstorm/sdk/codec-helpers";
import { parseCover } from "@brainstorm/sdk/entity-cover";
import { parseIcon } from "@brainstorm/sdk/entity-icon";
import { normalizeTagList } from "../logic/tag-utils";
import { normalizeUrl } from "../logic/url-parse";
import type { Bookmark } from "../types/bookmark";
import { ContentProvenance } from "../types/bookmark";

export const BOOKMARK_KEY_PREFIX = "bookmark:";

export function bookmarkKey(id: string): string {
	return BOOKMARK_KEY_PREFIX + id;
}

export function serializeBookmark(bookmark: Bookmark): Bookmark {
	// `rev` is the transient store-level revision stamped on read — never
	// part of the on-disk protocol.
	const { rev: _rev, ...persisted } = bookmark;
	return persisted;
}

export function parseStoredBookmark(raw: unknown): Bookmark | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.url !== "string") return null;
	const url = normalizeUrl(r.url);
	if (url === null) return null;
	if (typeof r.title !== "string") return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;
	// `savedAt` defaults to the creation time — a Bookmark/v1 written without it
	// (e.g. the welcome-seed "help & docs" bookmark) is still a valid bookmark,
	// just saved when it was created. Dropping the whole row over a missing
	// `savedAt` left it invisible in the Bookmarks app while Database/Graph
	// showed it (the entity exists; only this strict codec rejected it).
	const savedAt =
		typeof r.savedAt === "number" && Number.isFinite(r.savedAt) ? r.savedAt : r.createdAt;

	const rawTags = Array.isArray(r.tags)
		? (r.tags.filter((t) => typeof t === "string") as string[])
		: [];

	const bookmark: Bookmark = {
		id: r.id,
		url,
		title: r.title,
		icon: parseIcon(r.icon),
		faviconUrl: nullableString(r.faviconUrl),
		coverImageUrl: nullableString(r.coverImageUrl),
		tags: normalizeTagList(rawTags),
		savedAt,
		readAt: nullableNumber(r.readAt),
		archivedAt: nullableNumber(r.archivedAt),
		colorHint: nullableString(r.colorHint),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	const cover = parseCover(r.cover);
	if (cover) bookmark.cover = cover;
	if (typeof r.description === "string") bookmark.description = r.description;
	if (typeof r.siteName === "string") bookmark.siteName = r.siteName;
	if (typeof r.mediaType === "string") bookmark.mediaType = r.mediaType;
	if (typeof r.author === "string") bookmark.author = r.author;
	if (r.locked === true) bookmark.locked = true;
	if (typeof r.publishedAt === "number" && Number.isFinite(r.publishedAt)) {
		bookmark.publishedAt = r.publishedAt;
	}
	if (typeof r.notes === "string") bookmark.notes = r.notes;
	// `contentFetchedAt` stamps a *completed* capture and is valid on its own:
	// the no-readable-body case (F-243) stamps it with no `contentBlocks`, and
	// the stamp is what keeps the one-shot fetch from re-firing on every reload.
	if (typeof r.contentFetchedAt === "number" && Number.isFinite(r.contentFetchedAt)) {
		bookmark.contentFetchedAt = r.contentFetchedAt;
	}
	// Captured readable content — accept only a well-formed block array
	// (each entry an object with a string `type`); a malformed value drops to
	// "not captured" rather than poisoning the row.
	if (isBlockArray(r.contentBlocks)) {
		bookmark.contentBlocks = r.contentBlocks;
		// Provenance describes the captured blocks, so it stays gated on a valid
		// block array; an unknown value drops to absent rather than poisoning the
		// row (forward-compatible with future kinds).
		if (r.contentProvenance === ContentProvenance.MachineExtracted) {
			bookmark.contentProvenance = ContentProvenance.MachineExtracted;
		}
	}
	return bookmark;
}

function isBlockArray(value: unknown): value is SerializedBlock[] {
	return (
		Array.isArray(value) &&
		value.every(
			(b) => b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
		)
	);
}
