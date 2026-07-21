/**
 * Help-1 / Feedback-3 — IPC handlers for the in-shell Help center and
 * "What's new" surface.
 *
 * Three read-only channels, all serving build-time-bundled artifacts:
 *
 *   - `help:get-changelog` — Feedback-3, returns the parsed changelog.
 *   - `help:get-topic`     — Help-1, returns one Help corpus article.
 *   - `help:search`        — Help-1, full-text search over the corpus.
 *
 * No vault session is required — the corpus is a release artifact and
 * the changelog ships in the same posture. Parse / index failures are
 * fatal at module-evaluation time because they signal a broken bundle.
 *
 * Help search runs against `help_fts` (separate from `entity_fts` per
 * `search-schema.ts`), so the `services.search.query` broker route stays
 * semantically pure (vault content only). The Help center bypasses the
 * broker entirely — `window.brainstorm.help.search` is a privileged
 * dashboard-only entry point.
 */

import { open as openSqlite } from "@brainstorm-os/sqlite";
import type { IpcMain } from "electron";
import rawChangelog from "../../../changelog/changelog.json";
import rawHelpCorpus from "../../../help-corpus/corpus.json";
import { type Changelog, parseChangelog } from "../help/changelog";
import {
	type HelpArticle,
	type HelpCorpus,
	type HelpHit,
	parseCorpus,
	resolveTopicId,
} from "../help/help-corpus";
import { HelpIndexer, articleByTopicId } from "../help/help-indexer";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";

let cachedChangelog: Changelog | null = null;

export function loadBundledChangelog(): Changelog {
	if (cachedChangelog) return cachedChangelog;
	cachedChangelog = parseChangelog(rawChangelog);
	return cachedChangelog;
}

let cachedCorpus: HelpCorpus | null = null;

export function loadBundledHelpCorpus(): HelpCorpus {
	if (cachedCorpus) return cachedCorpus;
	cachedCorpus = parseCorpus(rawHelpCorpus);
	return cachedCorpus;
}

let helpIndexer: HelpIndexer | null = null;

/** Build (or rebuild) the in-memory help index from the bundled corpus.
 *  Idempotent — calling twice tears down the prior indexer cleanly. */
export async function ensureHelpIndexer(): Promise<HelpIndexer> {
	if (helpIndexer) return helpIndexer;
	const db = await openSqlite(":memory:");
	await applyMigrations(db, SEARCH_MIGRATIONS);
	const indexer = new HelpIndexer(db);
	indexer.rebuild(loadBundledHelpCorpus());
	helpIndexer = indexer;
	return indexer;
}

export function _clearChangelogCacheForTests(): void {
	cachedChangelog = null;
}

export function _clearHelpCacheForTests(): void {
	if (helpIndexer) {
		helpIndexer.dispose();
		helpIndexer = null;
	}
	cachedCorpus = null;
}

export function registerHelpHandlers(ipcMain: IpcMain): void {
	ipcMain.handle("help:get-changelog", async (): Promise<Changelog> => loadBundledChangelog());

	ipcMain.handle("help:get-corpus", async (): Promise<HelpCorpus> => loadBundledHelpCorpus());

	ipcMain.handle("help:get-topic", async (_event, args: unknown): Promise<HelpArticle | null> => {
		const topicId = readTopicId(args);
		if (topicId === null) return null;
		const corpus = loadBundledHelpCorpus();
		return articleByTopicId(corpus, topicId);
	});

	ipcMain.handle("help:search", async (_event, args: unknown): Promise<HelpHit[]> => {
		const { text, limit } = readSearchArgs(args);
		if (!text) return [];
		const indexer = await ensureHelpIndexer();
		return indexer.query(text, limit);
	});

	// Help-2 — contextual help. The renderer derives a route from the
	// focused surface (`dashboard` / `settings/<pane>` / `app/<id>` /
	// `section/<id>` / `guide/<path>`) and asks main to resolve it to a
	// concrete topic id. Falls back to the home topic when nothing
	// specific matches — never returns null when a corpus is present.
	ipcMain.handle("help:resolve-topic", async (_event, args: unknown): Promise<string | null> => {
		const route = readRoute(args);
		if (route === null) return null;
		const corpus = loadBundledHelpCorpus();
		return resolveTopicId(corpus, route);
	});
}

function readRoute(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const route = (args as { route?: unknown }).route;
	if (typeof route !== "string" || route.length === 0) return null;
	return route;
}

function readTopicId(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const topicId = (args as { topicId?: unknown }).topicId;
	if (typeof topicId !== "string" || topicId.length === 0) return null;
	return topicId;
}

function readSearchArgs(args: unknown): { text: string; limit?: number } {
	if (!args || typeof args !== "object") return { text: "" };
	const a = args as { text?: unknown; limit?: unknown };
	const text = typeof a.text === "string" ? a.text : "";
	if (typeof a.limit === "number" && Number.isFinite(a.limit) && a.limit > 0) {
		return { text, limit: Math.floor(a.limit) };
	}
	return { text };
}
