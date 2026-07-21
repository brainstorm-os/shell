/**
 * Pure paste-URL detection for the bookmark suggestion handler (9.18.2b).
 *
 * The plugin (`bookmark-suggest-plugin`) owns the Lexical command wiring;
 * this module owns the DOM-free policy: "is the pasted clipboard a single
 * bare http(s) URL?" and the `Bookmark/v1` property bag a resolve-or-create
 * writes. Keeping it pure lets the trigger rule + entity shape be unit-tested
 * without an editor.
 *
 * URL normalization stays app-local on purpose — the SDK catalog only shares
 * the codec *primitives* (`nullableString`, enum coercion), not per-app URL
 * canonicalization (Bookmarks owns its own `normalizeUrl`; Notes owns this).
 * The shape mirrors `@brainstorm-os/editor`'s `parseHttpUrl` so a bookmark
 * minted here round-trips through the same Bookmarks codec.
 */

/** The Block-Protocol type id the Bookmarks app owns. Notes mints a row of
 *  this type so the `io.brainstorm.bookmarks/bookmark` block (and the
 *  Bookmarks app, Database, Graph) read the same entity. */
export const BOOKMARK_ENTITY_TYPE = "brainstorm/Bookmark/v1";

/** Returns the normalized http(s) URL when `text` is a *single, bare*
 *  absolute URL (the whole clipboard is one link, nothing else), else `null`.
 *
 *  Deliberately strict so ordinary prose paste — even prose that contains a
 *  URL — does NOT trigger the suggestion: a bare URL is the user's clear
 *  "I pasted a link" signal. Multi-line / multi-token / whitespace-internal
 *  payloads fall through to Lexical's normal paste.
 */
export function detectBareUrl(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	// A bare URL has no internal whitespace and no newlines.
	if (/\s/.test(trimmed)) return null;
	// Require an explicit http(s) scheme — a schemeless "example.com" reads as
	// prose far too often to auto-suggest on. The user can still use the
	// `/bookmark` slash command for those.
	if (!/^https?:\/\//i.test(trimmed)) return null;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	// A hostname with no dot ("http://localhost") is almost never a bookmark
	// target; mirror `parseHttpUrl`'s guard so the two agree.
	if (!url.hostname.includes(".")) return null;
	let out = url.toString();
	// Strip the trailing slash on the bare root so `https://x.com/` and
	// `https://x.com` dedupe to the same entity.
	if (out.endsWith("/") && url.pathname === "/" && url.search === "" && url.hash === "") {
		out = out.slice(0, -1);
	}
	return out;
}

/** Bare hostname (no `www.`) for the default title — matches the bookmark
 *  block's host line so a freshly-created bookmark reads identically. */
export function hostLabel(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** The `Bookmark/v1` property bag for a URL with no scraped metadata yet.
 *  Mirrors the Bookmarks-app codec shape (`apps/bookmarks/src/storage/codec.ts`)
 *  so the row round-trips through `parseStoredBookmark` unchanged — title
 *  falls back to the host, timestamps stamp now, no favicon/cover until the
 *  9.18.6 scrape runs. The id is omitted (the entities service owns it). */
export function bookmarkEntityProperties(url: string, now: number): Record<string, unknown> {
	return {
		url,
		title: hostLabel(url),
		icon: null,
		faviconUrl: null,
		coverImageUrl: null,
		tags: [],
		savedAt: now,
		readAt: null,
		archivedAt: null,
		colorHint: null,
		createdAt: now,
		updatedAt: now,
	};
}
