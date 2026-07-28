/**
 * Browser-5 — the shell-side clip seal: maps a live-tab capture (tab metadata
 * + the Net-2 extraction of its RENDERED DOM) onto the `brainstorm/Bookmark/v1`
 * property bag the Bookmarks app reads verbatim
 * (`apps/bookmarks/src/storage/codec.ts::parseStoredBookmark`). The bag shape
 * deliberately converges with the Bookmarks app's own scrape
 * (`apps/bookmarks/src/logic/enrich.ts::metadataBackfill`) and the chrome-side
 * fallback (`apps/browser/src/logic/clip.ts::clipBookmarkProperties`) — one
 * codec, three feeders, no invented properties.
 *
 * Security: every input here is hostile page content. The URL must parse as
 * http(s) and is re-serialized from the parser (never the raw string) with a
 * length bound; title / description / site name / author are hardened via the
 * shared `sanitizeInlineText` (control / zero-width / bidi-override strip,
 * whitespace collapse, length clamp); the publish date must parse to a finite
 * epoch; the block tree is length-capped. `faviconUrl` / `coverImageUrl` are
 * contractually local `brainstorm://asset/<id>` URLs — this seal never writes a
 * remote URL into them (the Bookmarks-side scrape backfills them).
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";
import type { ReadableMeta } from "../network/readable/extract-html";
import type { SerializedBlock } from "../network/readable/html-to-blocks";

/** Canonical Block-Protocol type id of the clip artifact. Owned by the
 *  Bookmarks app (`apps/bookmarks/src/types/bookmark.ts`); restated as the
 *  wire string because the shell doesn't import app code. */
export const CAPTURE_BOOKMARK_ENTITY_TYPE = "brainstorm/Bookmark/v1";

/** Origin token for machine-extracted `contentBlocks` — the only value the
 *  Bookmarks codec accepts (`ContentProvenance.MachineExtracted`). */
export const CAPTURE_PROVENANCE_MACHINE_EXTRACTED = "machine-extracted";

/** Bounds for page-supplied strings. Title/URL mirror the chrome-side clip
 *  bounds (`apps/browser/src/logic/clip.ts`) so the two paths agree. */
export const CAPTURE_TITLE_MAX_LEN = 300;
export const CAPTURE_URL_MAX_LEN = 2048;
export const CAPTURE_DESCRIPTION_MAX_LEN = 500;
export const CAPTURE_SITE_NAME_MAX_LEN = 120;
export const CAPTURE_AUTHOR_MAX_LEN = 200;

/** Hard cap on persisted top-level blocks. The extractor input is already
 *  clamped (`LIVE_DOM_MAX_CHARS`), so this is belt-and-braces against a
 *  pathological page inflating the entity row. */
export const CAPTURE_MAX_BLOCKS = 5_000;

/** Normalize a candidate capture URL: must parse, be http(s), and fit the
 *  length bound after re-serialization. Returns the parser's serialization or
 *  `null` when the page isn't clippable (about:blank, custom schemes,
 *  oversized URLs). */
export function captureUrl(raw: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const href = parsed.href;
	if (href.length > CAPTURE_URL_MAX_LEN) return null;
	return href;
}

export type CaptureBookmarkInput = {
	/** The tab's current top-level URL (host-tracked, still page-influenced). */
	url: string;
	/** The tab's title from the host's `TitleChanged` events — page-supplied. */
	title: string;
	/** Net-2 extraction metadata, or null when the page had no article. */
	meta: ReadableMeta | null;
	/** Sanitized article blocks, or null/empty when nothing was extractable. */
	blocks: SerializedBlock[] | null;
	now: number;
};

/** The parsed publish date as finite epoch ms, or null. */
function parsePublishedAt(raw: string | null): number | null {
	if (!raw) return null;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The `brainstorm/Bookmark/v1` property bag for a captured page, or `null`
 * when the URL isn't clippable. Satisfies every field the Bookmarks codec
 * requires plus the scrape-parity metadata (description / siteName / author /
 * publishedAt) when the extraction found it; a non-empty block tree stamps the
 * `contentBlocks` + `contentProvenance` + `contentFetchedAt` triple the
 * Bookmarks detail renders. The entity id is minted by the entities service.
 */
export function captureBookmarkProperties(
	input: CaptureBookmarkInput,
): Record<string, unknown> | null {
	const url = captureUrl(input.url);
	if (url === null) return null;
	const title =
		sanitizeInlineText(input.title, CAPTURE_TITLE_MAX_LEN) ||
		sanitizeInlineText(input.meta?.title ?? "", CAPTURE_TITLE_MAX_LEN) ||
		new URL(url).hostname;
	const description = sanitizeInlineText(input.meta?.excerpt ?? "", CAPTURE_DESCRIPTION_MAX_LEN);
	const siteName = sanitizeInlineText(input.meta?.siteName ?? "", CAPTURE_SITE_NAME_MAX_LEN);
	const author = sanitizeInlineText(input.meta?.byline ?? "", CAPTURE_AUTHOR_MAX_LEN);
	const publishedAt = parsePublishedAt(input.meta?.publishedAt ?? null);
	const blocks =
		input.blocks && input.blocks.length > 0 ? input.blocks.slice(0, CAPTURE_MAX_BLOCKS) : null;
	return {
		url,
		title,
		faviconUrl: null,
		coverImageUrl: null,
		tags: [],
		savedAt: input.now,
		readAt: null,
		archivedAt: null,
		colorHint: null,
		createdAt: input.now,
		updatedAt: input.now,
		...(description ? { description } : {}),
		...(siteName ? { siteName } : {}),
		...(author ? { author } : {}),
		...(publishedAt !== null ? { publishedAt } : {}),
		...(blocks
			? {
					contentBlocks: blocks,
					contentProvenance: CAPTURE_PROVENANCE_MACHINE_EXTRACTED,
					contentFetchedAt: input.now,
				}
			: {}),
	};
}
