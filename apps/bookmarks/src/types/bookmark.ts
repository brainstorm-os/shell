/**
 * `brainstorm/Bookmark/v1` — saved-link entity, Bookmarks-app-owned.
 *
 * v1 ships without network ingestion (per the 9.18 plan): `title` /
 * `description` / `faviconUrl` / `coverImageUrl` are user-supplied or
 * empty in v1. Post-v1 the 9.18.6 metadata scrape populates them via
 * the network broker.
 */

import type { Cover, Icon, SerializedBlock } from "@brainstorm-os/sdk-types";

/** The canonical Block-Protocol type id this app owns. Single source of
 *  truth — storage + the object-menu target both read it from here. */
export const BOOKMARK_ENTITY_TYPE = "brainstorm/Bookmark/v1";

/** Origin of a bookmark's captured `contentBlocks` (9.18.13 provenance). The
 *  wire value is the string itself, so the enum doubles as the stored token. */
export enum ContentProvenance {
	/** Extracted from the live page by the Net-2 readable feeder — an automated
	 *  best-effort reduction, not the original markup. */
	MachineExtracted = "machine-extracted",
}

export type Bookmark = {
	id: string;
	/** Read-only lock — the bookmark's synced `locked` property. When true the
	 *  detail body editor is read-only. */
	locked?: boolean;
	/** Normalized URL — see `logic/url-parse.ts::normalizeUrl`. Always
	 *  http(s) scheme. */
	url: string;
	/** Display title. User-typed in v1; auto-populated from the page
	 *  `<title>` in 9.18.6. Falls back to the domain when empty. */
	title: string;
	description?: string;
	icon?: Icon | null;
	/** Local `brainstorm://asset/<id>` URL for the favicon the metadata
	 *  scrape downloaded + encrypted into the vault asset store (offline-first
	 *  — never a remote URL). Null until scraped; the renderer falls back to
	 *  the per-object gradient thumbnail when null. */
	faviconUrl: string | null;
	/** Local `brainstorm://asset/<id>` URL for the OpenGraph cover image —
	 *  same contract as `faviconUrl`. Null until scraped. The scrape-derived
	 *  default banner; an explicit user `cover` (below) overrides it. */
	coverImageUrl: string | null;
	/** User-chosen cover banner (image / gradient / colour) via the shared
	 *  `CoverPicker` — per-object-covers-everywhere ([[project_entity_cover_renderer]]).
	 *  Overrides the scraped `coverImageUrl`; `null`/absent falls back to the
	 *  scraped image, else the id-seeded gradient. */
	cover?: Cover | null;
	/** Source site name (OpenGraph `og:site_name`), e.g. "The New York Times".
	 *  Backfilled by the 9.18.6 metadata scrape and user-editable via the Site
	 *  property (clearing it resumes the domain fallback); surfaced on the card so
	 *  a bookmark reads as "from <site>" rather than a bare domain. `undefined`
	 *  when none — the property write-back sets it back to `undefined` to clear. */
	siteName?: string | undefined;
	/** Content-kind label from OpenGraph `og:type` (e.g. "article", "video.movie",
	 *  "website"). Backfilled by the metadata scrape; absent when the page declared
	 *  no `og:type` (the generic "page" default is not stored). Surfaced as the
	 *  read-only "Type" property. */
	mediaType?: string;
	/** Article author (OpenGraph `article:author` / `<meta name="author">`),
	 *  e.g. "Jane Doe". Backfilled by the 9.18.6 metadata scrape and user-editable
	 *  via the Author property (F-204 — citation basics the scraper may miss);
	 *  the property write-back sets `undefined` to clear. */
	author?: string | undefined;
	/** Epoch ms of the page's publish date (OpenGraph `article:published_time`).
	 *  Backfilled by the 9.18.6 metadata scrape and user-editable via the
	 *  Published date property (F-204); the property write-back sets `undefined`
	 *  to clear. */
	publishedAt?: number | undefined;
	/** Normalized tag list (lowercase, trimmed, dedup) per
	 *  `logic/tag-utils.ts::normalizeTag`. The on-disk JSON stores
	 *  the normalized form — the renderer's tag-board groupings
	 *  match without further normalization. */
	tags: readonly string[];
	/** Epoch ms when the user added the bookmark. */
	savedAt: number;
	/** Epoch ms when the user marked the bookmark as read, or null. */
	readAt: number | null;
	/** Epoch ms when the user archived the bookmark, or null. */
	archivedAt: number | null;
	/** User's freeform notes about the bookmark. v1 stores plain text;
	 *  9.6 + 9.3 future iterations may swap this for a rich-text body. */
	notes?: string;
	/** Optional CSS colour used as the bookmark card's accent tint.
	 *  Falls back to a hash-derived chip colour when null. */
	colorHint: string | null;
	/** Captured readable page content (the Net-2 extractor's `SerializedBlock[]`,
	 *  the editor's `exportJSON` shape) — populated lazily on first open of the
	 *  detail view and persisted so the content reads offline thereafter. The
	 *  forward home is the universal Yjs body (9.18.5/9.18.7); this kv field is
	 *  the pre-remodel store. */
	contentBlocks?: SerializedBlock[];
	/** Epoch ms when `contentBlocks` was captured, or absent if never. */
	contentFetchedAt?: number;
	/** How the captured body was produced (9.18.13 provenance). `"machine-extracted"`
	 *  for a Net-2 readable capture; absent for a body the user authored by hand.
	 *  Surfaced as a provenance line so a reader knows the text is an automated
	 *  extraction, not the original page. */
	contentProvenance?: ContentProvenance;
	createdAt: number;
	updatedAt: number;
	/** Transient store-level revision (the entities service's own `updatedAt`,
	 *  which the storage worker bumps on EVERY write — including a foreign
	 *  editor like the Database grid that doesn't touch the domain `updatedAt`
	 *  above). Stamped by the entities repository on read, stripped on write —
	 *  never persisted. Backs `bookmarkListEquals` change detection. */
	rev?: number;
};
