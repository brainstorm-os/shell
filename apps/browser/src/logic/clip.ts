/**
 * Clip-to-vault (Browser-5, friction F-161) — the pure core behind the
 * chrome's "Save to vault" button. Maps the metadata the chrome already holds
 * for the active tab (url + page title from the `WebView` host events) onto a
 * `brainstorm/Bookmark/v1` property bag the Bookmarks app reads verbatim
 * (`apps/bookmarks/src/storage/codec.ts::parseStoredBookmark`).
 *
 * Readable page content is captured at save time through the shell network
 * broker (`services.network.readable`, gated on `network.readable`) and
 * stamped onto the bookmark as `contentBlocks` so the Bookmarks detail renders
 * the page body instead of a blank one (F-235). A withheld grant, blocked
 * egress, or a non-extractable page leaves a link-only bookmark — never a
 * failed clip. The bookmark itself is written through the shared entities
 * service (per-type capability `entities.write:brainstorm/Bookmark/v1`).
 *
 * Security: `title` is page-supplied and untrusted — it is hardened via the
 * shared `sanitizeInlineText` (control / zero-width / bidi-override strip,
 * whitespace collapse, length clamp) before it is persisted. The URL must
 * parse as http(s) and is re-serialized from the parser (never the raw
 * string), with a length bound. The tab's favicon URL is deliberately NOT
 * persisted: `Bookmark.faviconUrl` is contractually a local
 * `brainstorm://asset/<id>` URL (offline-first, never remote) — the
 * Bookmarks-side metadata scrape backfills it.
 */

import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";

/** Canonical Block-Protocol type id of the clip artifact. Owned by the
 *  Bookmarks app (`apps/bookmarks/src/types/bookmark.ts`); apps don't import
 *  each other, so the wire string is restated here against that contract. */
export const BOOKMARK_ENTITY_TYPE = "brainstorm/Bookmark/v1";

/** Origin token for a bookmark's captured `contentBlocks`. Owned by the
 *  Bookmarks codec (`ContentProvenance.MachineExtracted` in
 *  `apps/bookmarks/src/types/bookmark.ts`); restated here as the wire string
 *  because apps don't import each other. The Bookmarks codec accepts only this
 *  token, so it doubles as the stored value. */
export const CONTENT_PROVENANCE_MACHINE_EXTRACTED = "machine-extracted";

/** Upper bound on a persisted page title (page-supplied, untrusted). */
export const CLIP_TITLE_MAX_LEN = 300;

/** Upper bound on a persisted URL (the de-facto interoperable URL length). */
export const CLIP_URL_MAX_LEN = 2048;

/** How long the button shows its "Saved" confirmation before resetting. */
export const CLIP_SAVED_RESET_MS = 2000;

/** Lifecycle of the active tab's clip attempt. Mirrors the Bookmarks app's
 *  `CaptureState` shape (its async-save affordance) at chrome scale. */
export enum ClipPhase {
	Idle = "idle",
	Saving = "saving",
	Saved = "saved",
	Failed = "failed",
}

/** A clip attempt is tracked per tab — switching tabs must not carry one
 *  tab's "Saved" flash (or failure) onto another tab's button. */
export type ClipAttempt = { tabId: string; phase: ClipPhase };

/** The phase the button renders for `activeTabId`: the recorded attempt when
 *  it belongs to that tab, else `Idle`. */
export function clipPhaseFor(attempt: ClipAttempt | null, activeTabId: string | null): ClipPhase {
	if (!attempt || activeTabId === null || attempt.tabId !== activeTabId) return ClipPhase.Idle;
	return attempt.phase;
}

/** Normalize a candidate clip URL: must parse, be http(s), and fit the length
 *  bound after re-serialization. Returns the parser's serialization (control
 *  characters percent-encoded, never the raw page string) or `null` when the
 *  page isn't clippable (about:blank, custom schemes, oversized URLs). */
export function clippableUrl(raw: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const href = parsed.href;
	if (href.length > CLIP_URL_MAX_LEN) return null;
	return href;
}

/** Whether the button is actionable: a clippable page and no save in flight.
 *  `Saved` / `Failed` stay actionable (re-clip / retry). */
export function canClip(url: string | undefined, phase: ClipPhase): boolean {
	if (phase === ClipPhase.Saving) return false;
	return url !== undefined && clippableUrl(url) !== null;
}

export type ClipPage = {
	url: string;
	/** Page-supplied title from the host's `TitleChanged` metadata events. */
	title: string;
};

/** Optional readable-content capture to stamp onto a clipped bookmark. The
 *  shell's `network.readable` broker returns `blocks: null` (or an empty array)
 *  when the fetch succeeded but no body was recovered — that case is treated as
 *  "no capture" so a bookmark is never stamped with empty content (which the
 *  Bookmarks detail would render as a blank body). */
export type ClipCapture = {
	blocks: SerializedBlock[] | null;
};

/**
 * The `brainstorm/Bookmark/v1` property bag for a clipped page, or `null`
 * when the URL isn't clippable. Satisfies every field the Bookmarks codec
 * requires (`url`/`title`/`savedAt`/`createdAt`/`updatedAt` + the nullable
 * trio it reads); the entity id is minted by the entities service, not here.
 * An empty (or fully-stripped) title falls back to the page's hostname so a
 * bookmark never renders blank.
 *
 * When `capture.blocks` carries a non-empty readable body, the bag also
 * stamps `contentBlocks` + `contentProvenance` + `contentFetchedAt` (the exact
 * triple the Bookmarks codec reads) so the saved bookmark renders the page
 * content instead of a blank body (F-235). A missing/empty capture leaves a
 * link-only bookmark, which the Bookmarks app can still capture on demand.
 */
export function clipBookmarkProperties(
	page: ClipPage,
	now: number,
	capture?: ClipCapture,
): Record<string, unknown> | null {
	const url = clippableUrl(page.url);
	if (url === null) return null;
	const title = sanitizeInlineText(page.title, CLIP_TITLE_MAX_LEN) || new URL(url).hostname;
	const blocks = capture?.blocks;
	const content =
		blocks && blocks.length > 0
			? {
					contentBlocks: blocks,
					contentProvenance: CONTENT_PROVENANCE_MACHINE_EXTRACTED,
					contentFetchedAt: now,
				}
			: {};
	return {
		url,
		title,
		faviconUrl: null,
		coverImageUrl: null,
		tags: [],
		savedAt: now,
		readAt: null,
		archivedAt: null,
		colorHint: null,
		createdAt: now,
		updatedAt: now,
		...content,
	};
}
