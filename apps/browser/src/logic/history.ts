/**
 * Browsing history (Browser-9) — the pure core behind "the browser remembers
 * the websites you visited". One `brainstorm/BrowsingHistory/v1` entity per
 * vault holds a bounded, most-recent-first visit list the chrome feeds from
 * the shell's `UrlChanged` metadata events (titles backfill from
 * `TitleChanged`). Vault-local, never synced (§Entity types) —
 * the list is bounded and clearable from the History menu, not a surveillance
 * log.
 *
 * Surfaces: omnibox suggestions (`matchHistory`) and the History menu's
 * recently-visited section (`recentVisits`).
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";
import { CLIP_TITLE_MAX_LEN, clippableUrl } from "./clip";

/** Canonical Block-Protocol type id of the vault's visit log. */
export const BROWSING_HISTORY_ENTITY_TYPE = "brainstorm/BrowsingHistory/v1";

/** Bound on the persisted visit list — recording the (N+1)th distinct URL
 *  drops the least-recently-visited one. */
export const HISTORY_MAX_VISITS = 500;

/** How many suggestions the omnibox dropdown shows. */
export const HISTORY_SUGGESTION_LIMIT = 8;

/** How many recently-visited rows the History menu shows. */
export const HISTORY_MENU_LIMIT = 10;

/** One remembered page. Re-visiting a URL bumps `visitCount` and refreshes
 *  `lastVisitedAt` instead of duplicating the row. */
export type HistoryVisit = {
	url: string;
	/** Page title from the host's `TitleChanged` events; empty until the page
	 *  reports one ({@link visitLabel} falls back to the hostname). */
	title: string;
	visitCount: number;
	lastVisitedAt: number;
};

/** The persisted entity (`brainstorm/BrowsingHistory/v1`). `visits` is
 *  most-recent-first. */
export type BrowsingHistoryRecord = {
	visits: readonly HistoryVisit[];
	createdAt: number;
	updatedAt: number;
};

/** Record a navigation: normalize + gate the URL (http(s) only — `about:blank`
 *  and custom schemes never enter history), dedupe by URL, move to front,
 *  cap. Returns the input list unchanged for unrecordable URLs. */
export function recordVisit(
	visits: readonly HistoryVisit[],
	visit: { url: string; now: number },
): readonly HistoryVisit[] {
	const url = clippableUrl(visit.url);
	if (url === null) return visits;
	const existing = visits.find((v) => v.url === url);
	const entry: HistoryVisit = existing
		? { ...existing, visitCount: existing.visitCount + 1, lastVisitedAt: visit.now }
		: { url, title: "", visitCount: 1, lastVisitedAt: visit.now };
	return [entry, ...visits.filter((v) => v.url !== url)].slice(0, HISTORY_MAX_VISITS);
}

/** Backfill the title of an already-recorded URL (titles arrive after the
 *  navigation commit). Page-supplied and untrusted — hardened like the clip
 *  title. No-op for unknown URLs or an empty/fully-stripped title. */
export function retitleVisit(
	visits: readonly HistoryVisit[],
	rawUrl: string,
	title: string,
): readonly HistoryVisit[] {
	const url = clippableUrl(rawUrl);
	if (url === null) return visits;
	const clean = sanitizeInlineText(title, CLIP_TITLE_MAX_LEN);
	if (clean.length === 0) return visits;
	let changed = false;
	const next = visits.map((v) => {
		if (v.url !== url || v.title === clean) return v;
		changed = true;
		return { ...v, title: clean };
	});
	return changed ? next : visits;
}

/** Merge the in-memory visits recorded before the stored record loaded (the
 *  load is async; a deep-link tab can commit first). Live entries win and
 *  stay newest; stored entries keep their order after them. */
export function mergeVisits(
	live: readonly HistoryVisit[],
	stored: readonly HistoryVisit[],
): readonly HistoryVisit[] {
	if (live.length === 0) return stored.slice(0, HISTORY_MAX_VISITS);
	const liveUrls = new Set(live.map((v) => v.url));
	return [...live, ...stored.filter((v) => !liveUrls.has(v.url))].slice(0, HISTORY_MAX_VISITS);
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** Rank buckets for {@link matchHistory} — lower wins. */
enum MatchRank {
	HostPrefix = 0,
	UrlSubstring = 1,
	TitleSubstring = 2,
}

/** Omnibox suggestions for `query`: case-insensitive match over URL + title,
 *  host-prefix hits first ("git" → github.com before a page that merely
 *  mentions git), recency then frequency as tiebreaks. Empty query → no
 *  suggestions (recents live in the History menu, not under every focus). */
export function matchHistory(
	visits: readonly HistoryVisit[],
	query: string,
	limit: number = HISTORY_SUGGESTION_LIMIT,
): HistoryVisit[] {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return [];
	const scored: Array<{ visit: HistoryVisit; rank: MatchRank }> = [];
	for (const visit of visits) {
		const url = visit.url.toLowerCase();
		const host = hostOf(visit.url);
		let rank: MatchRank | null = null;
		if (host.startsWith(q) || host.startsWith(`www.${q}`)) rank = MatchRank.HostPrefix;
		else if (url.includes(q)) rank = MatchRank.UrlSubstring;
		else if (visit.title.toLowerCase().includes(q)) rank = MatchRank.TitleSubstring;
		if (rank !== null) scored.push({ visit, rank });
	}
	scored.sort(
		(a, b) =>
			a.rank - b.rank ||
			b.visit.lastVisitedAt - a.visit.lastVisitedAt ||
			b.visit.visitCount - a.visit.visitCount,
	);
	return scored.slice(0, limit).map((s) => s.visit);
}

/** The History menu's recently-visited slice (the list is already
 *  most-recent-first). */
export function recentVisits(
	visits: readonly HistoryVisit[],
	limit: number = HISTORY_MENU_LIMIT,
): readonly HistoryVisit[] {
	return visits.slice(0, limit);
}

/** Display label for a visit — its title, or the hostname while the page
 *  hasn't reported one. */
export function visitLabel(visit: HistoryVisit): string {
	if (visit.title.length > 0) return visit.title;
	const host = hostOf(visit.url);
	return host.length > 0 ? host : visit.url;
}

/** Project a history record onto the entity property bag (the manifest's
 *  inline schema shape). */
export function historyRecordToProperties(record: BrowsingHistoryRecord): Record<string, unknown> {
	return {
		visits: record.visits.slice(0, HISTORY_MAX_VISITS).map((v) => ({ ...v })),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

function parseVisit(input: unknown): HistoryVisit | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Record<string, unknown>;
	if (typeof raw.url !== "string") return null;
	const url = clippableUrl(raw.url);
	if (url === null) return null;
	if (typeof raw.visitCount !== "number" || raw.visitCount < 1) return null;
	if (typeof raw.lastVisitedAt !== "number") return null;
	const title =
		typeof raw.title === "string" ? sanitizeInlineText(raw.title, CLIP_TITLE_MAX_LEN) : "";
	return { url, title, visitCount: raw.visitCount, lastVisitedAt: raw.lastVisitedAt };
}

/** Decode an entity property bag back into a history record, or `null` when
 *  the shape is unusable. Fail-soft per row — a malformed visit is skipped,
 *  never a crash. */
export function historyRecordFromProperties(
	properties: Record<string, unknown> | null | undefined,
): BrowsingHistoryRecord | null {
	if (!properties || typeof properties !== "object") return null;
	if (typeof properties.createdAt !== "number" || typeof properties.updatedAt !== "number") {
		return null;
	}
	if (!Array.isArray(properties.visits)) return null;
	const visits: HistoryVisit[] = [];
	for (const raw of properties.visits.slice(0, HISTORY_MAX_VISITS)) {
		const visit = parseVisit(raw);
		if (visit) visits.push(visit);
	}
	return {
		visits,
		createdAt: properties.createdAt,
		updatedAt: properties.updatedAt,
	};
}
