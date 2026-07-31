/**
 * Start page (POLISH-DSN-3) — the pure core behind the new-tab surface.
 * Ranks the browsing history into a small "top sites" tile set: most-visited
 * first, recency breaking ties, capped. History-free (or private) tabs get
 * the empty hint instead — the ranking never invents entries.
 */

import type { HistoryVisit } from "./history";

/** How many tiles the start page shows. */
export const START_PAGE_SITE_LIMIT = 8;

/** Rank visits for the start-page tile grid: visit count desc, then most
 *  recent first. Pure; input order is not mutated. */
export function startPageSites(
	visits: readonly HistoryVisit[],
	limit: number = START_PAGE_SITE_LIMIT,
): readonly HistoryVisit[] {
	return [...visits]
		.sort((a, b) => b.visitCount - a.visitCount || b.lastVisitedAt - a.lastVisitedAt)
		.slice(0, Math.max(0, limit));
}

/** Host shown under a tile title — no scheme, no `www.`, empty for an
 *  unparsable URL (the tile then shows only its title/label). */
export function siteHost(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** The tile's monogram glyph — first letter of the host (falling back to the
 *  URL), uppercased. */
export function siteMonogram(url: string): string {
	const host = siteHost(url);
	const source = host.length > 0 ? host : url;
	return source.charAt(0).toUpperCase();
}
