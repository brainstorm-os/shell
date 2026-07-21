/**
 * Pure decisions for the metadata-scrape backfill (`enrichBookmarkMetadata`).
 * Extracted so the "when does a scraped value win" policy is unit-tested
 * without the shell / network broker.
 */

import type { LinkPreview } from "@brainstorm-os/sdk-types";
import type { Bookmark } from "../types/bookmark";
import { domainFromUrl } from "./url-parse";

/**
 * The scraped page title that should replace `currentTitle`, or null to keep
 * what's there. A scraped title wins only when the current title is
 * **auto-derived** — blank, or the domain `composeBookmark` defaults to when
 * the user typed no title — so a user-chosen title is never clobbered.
 */
export function preferScrapedTitle(
	currentTitle: string,
	url: string,
	scrapedTitle: string,
): string | null {
	if (!scrapedTitle) return null;
	const autoTitle = domainFromUrl(url) ?? url;
	const isAuto = currentTitle.trim() === "" || currentTitle === autoTitle;
	if (!isAuto) return null;
	return currentTitle === scrapedTitle ? null : scrapedTitle;
}

/**
 * The scraped author that should fill the bookmark's `author`, or null to
 * keep what's there. Backfill-only: the Author property is user-editable
 * (F-204), so a scraped value never clobbers a value already set.
 */
export function preferScrapedAuthor(
	current: string | undefined,
	scraped: string | undefined,
): string | null {
	if (!scraped || scraped.trim().length === 0) return null;
	if (current && current.trim().length > 0) return null;
	return scraped.trim();
}

/**
 * The scraped publish date (epoch ms) that should fill the bookmark's
 * `publishedAt`, or null to keep what's there. Backfill-only, same policy as
 * `preferScrapedAuthor`; a non-finite scrape is dropped.
 */
export function preferScrapedPublishedAt(
	current: number | undefined,
	scraped: number | undefined,
): number | null {
	if (typeof scraped !== "number" || !Number.isFinite(scraped)) return null;
	if (current !== undefined) return null;
	return scraped;
}

/**
 * The partial Bookmark fields a scraped `preview` should backfill onto
 * `bookmark`, or null when the preview adds nothing. Every field is
 * backfill-only (the same win-policy the `preferScraped*` helpers encode) so a
 * re-scrape never clobbers a user-set value. Shared by the metadata scrape
 * (`enrichBookmarkMetadata`) and the no-readable-body capture fallback (F-243):
 * a page whose article can't be extracted still becomes a rich link, not an
 * error.
 */
export function metadataBackfill(
	bookmark: Pick<
		Bookmark,
		| "title"
		| "url"
		| "description"
		| "faviconUrl"
		| "coverImageUrl"
		| "siteName"
		| "mediaType"
		| "author"
		| "publishedAt"
	>,
	preview: LinkPreview,
): Partial<Bookmark> | null {
	const next: Partial<Bookmark> = {};
	let changed = false;
	if (preview.faviconAssetUrl && bookmark.faviconUrl !== preview.faviconAssetUrl) {
		next.faviconUrl = preview.faviconAssetUrl;
		changed = true;
	}
	if (preview.coverAssetUrl && !bookmark.coverImageUrl) {
		next.coverImageUrl = preview.coverAssetUrl;
		changed = true;
	}
	const scrapedTitle = preferScrapedTitle(bookmark.title, bookmark.url, preview.title ?? "");
	if (scrapedTitle !== null) {
		next.title = scrapedTitle;
		changed = true;
	}
	const scrapedDescription = preview.description?.trim();
	if (!bookmark.description?.trim() && scrapedDescription) {
		next.description = scrapedDescription;
		changed = true;
	}
	if (preview.siteName && bookmark.siteName !== preview.siteName) {
		next.siteName = preview.siteName;
		changed = true;
	}
	if (
		preview.mediaType &&
		preview.mediaType !== "page" &&
		bookmark.mediaType !== preview.mediaType
	) {
		next.mediaType = preview.mediaType;
		changed = true;
	}
	const scrapedAuthor = preferScrapedAuthor(bookmark.author, preview.author);
	if (scrapedAuthor !== null) {
		next.author = scrapedAuthor;
		changed = true;
	}
	const scrapedPublishedAt = preferScrapedPublishedAt(bookmark.publishedAt, preview.publishedAt);
	if (scrapedPublishedAt !== null) {
		next.publishedAt = scrapedPublishedAt;
		changed = true;
	}
	return changed ? next : null;
}
