/**
 * `search:*` IPC handlers — privileged shell-side surface for the dashboard
 * renderer (launcher palette, Settings → Search panel).
 *
 * The dashboard is a shell-trusted surface, so it calls the `SearchIndexer`
 * over `ipcMain.handle` directly — same pattern `dashboard-handlers.ts` and
 * `properties-handlers.ts` use. Apps still go through the broker
 * (`services.search.query`, capability-gated by `search.read`).
 *
 * Stage 9.22.2 — Launcher integration with `⌘ Space`.
 * Stage 9.22.4 — `search:stats` (index health) + `search:reindex`
 * (user-triggered rebuild) for the Settings panel. Both are read/maintenance
 * affordances on the shell renderer only; apps never reindex.
 */

import { ipcMain } from "electron";
import { type SemanticModelStatus, absentStatus } from "../search/embedder-status";
import type { IndexStats, IndexerQuery, SearchHit, SearchIndexer } from "../search/search-indexer";
import { runHybridQuery } from "../search/search-service";
import type { VectorIndexer } from "../search/vector-indexer";

export const SEARCH_QUERY_CHANNEL = "search:query";
export const SEARCH_STATS_CHANNEL = "search:stats";
export const SEARCH_REINDEX_CHANNEL = "search:reindex";

/** What the Settings → Search panel renders. `available` is the number of
 *  indexable entities the *sources* currently hold (entities.db + the
 *  legacy kv fallback) — joined here because the indexer can't see the
 *  sources. `null` = no active vault session or the source scan failed;
 *  the panel shows coverage as "—" rather than a misleading 0%. */
export type SearchIndexReport = IndexStats & {
	available: number | null;
	/** 11.3 — the on-device semantic model's download/readiness status, so the
	 *  panel can render the first-run-download progress bar. Never null: an
	 *  absent native addon reports `phase: Absent` (lexical-only). */
	semantic: SemanticModelStatus;
};

export type SearchHandlerDeps = {
	/** Active vault's indexer, or null when no session is open. */
	getIndexer: () => SearchIndexer | null;
	/** 11.4 — the active vault's vector indexer, so the launcher query runs the
	 *  same `search.hybrid` fusion the broker verb does. Optional / null when
	 *  sqlite-vec didn't load or vector indexing is gated off — the path then
	 *  degrades to lexical-only (today's behaviour), sharpening once 11.3 lands. */
	getVectorIndexer?: () => VectorIndexer | null;
	/** 11.3 — the current semantic-model download/readiness status. Optional so
	 *  callers/tests that don't wire the embedder report `Absent` (lexical-only). */
	getSemanticStatus?: () => SemanticModelStatus;
	/** Rebuild the index from sources (same path as vault-activation). */
	reindex: () => Promise<void>;
	/** Count of indexable entities the sources hold right now; null when
	 *  there's no session or the scan failed. Drives the coverage estimate. */
	getAvailableCount: () => Promise<number | null>;
};

const EMPTY_STATS: IndexStats = { total: 0, byType: [], lastIndexedAt: 0, bytes: 0 };

export function registerSearchHandlers(deps: SearchHandlerDeps): void {
	ipcMain.handle(SEARCH_QUERY_CHANNEL, async (_event, query: unknown): Promise<SearchHit[]> => {
		const indexer = deps.getIndexer();
		if (!indexer) return [];
		const validated = validateQuery(query);
		if (!validated) return [];
		try {
			// 11.4 — the launcher's default search is now hybrid (lexical + vector
			// RRF). Degrades to pure lexical when no vector indexer is wired, so
			// it's identical to the prior behaviour today and sharpens with 11.3.
			return await runHybridQuery(indexer, deps.getVectorIndexer?.() ?? null, validated);
		} catch (error) {
			console.warn("[brainstorm] search:query failed:", error);
			return [];
		}
	});

	ipcMain.handle(SEARCH_STATS_CHANNEL, async (): Promise<SearchIndexReport> => {
		return buildReport(deps);
	});

	ipcMain.handle(SEARCH_REINDEX_CHANNEL, async (): Promise<SearchIndexReport> => {
		try {
			await deps.reindex();
		} catch (error) {
			console.warn("[brainstorm] search:reindex failed:", error);
		}
		return buildReport(deps);
	});
}

/** Join the indexer's self-view with a source count. Each half degrades
 *  independently — a thrown stats read still reports coverage, a failed
 *  source scan still reports the index size. Exported for unit testing (the
 *  `search:stats`/`reindex` handlers themselves need `ipcMain`). */
export async function buildReport(deps: SearchHandlerDeps): Promise<SearchIndexReport> {
	const indexer = deps.getIndexer();
	let stats: IndexStats = EMPTY_STATS;
	if (indexer) {
		try {
			stats = indexer.stats();
		} catch (error) {
			console.warn("[brainstorm] search:stats failed:", error);
		}
	}
	let available: number | null = null;
	try {
		available = await deps.getAvailableCount();
	} catch (error) {
		console.warn("[brainstorm] search coverage count failed:", error);
	}
	const semantic = deps.getSemanticStatus?.() ?? absentStatus();
	return { ...stats, available, semantic };
}

/** Pure validator — keeps the IPC boundary tight without leaking shape
 *  details into the launcher. Mirrors `search-service.ts::requireQuery`
 *  but returns `null` on malformed input (privileged caller, so we
 *  degrade to no-results rather than surface a structured error). */
export function validateQuery(input: unknown): IndexerQuery | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const raw = input as Record<string, unknown>;
	if (typeof raw.text !== "string") return null;
	const out: IndexerQuery = { text: raw.text };
	if (raw.types !== undefined) {
		if (!Array.isArray(raw.types)) return null;
		if (raw.types.some((t) => typeof t !== "string" || t.length === 0)) return null;
		out.types = raw.types as string[];
	}
	if (raw.limit !== undefined) {
		if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit)) return null;
		out.limit = raw.limit;
	}
	return out;
}
