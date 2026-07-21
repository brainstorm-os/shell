/**
 * Help-1 — thin SearchIndexer-shaped adapter for the help corpus.
 *
 * Why a sibling table rather than entity_fts?
 *
 *  - `services.search.query` stays vault-pure (per §entity_fts).
 *     Help content is corpus-static — identical across every vault — and
 *     mixing it with entity rows would bleed the corpus into broker search
 *     hits, with no scope filter that could cleanly separate the two.
 *   - The corpus is rebuildable at boot from the bundled JSON (no
 *     incremental writes, no sidecar metadata). Crash-during-rebuild is
 *     safe because the table contents are deterministic.
 *
 * Tokenisation + query escaping reuse `buildMatchExpression` from
 * `search-indexer.ts` — there must be exactly one way to escape user input
 * into an FTS5 MATCH expression. Snippet markup matches the entity
 * indexer's `<mark>…</mark>` so the renderer can use one highlighter.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import { buildMatchExpression } from "../search/search-indexer";
import type { HelpArticle, HelpCorpus, HelpHit } from "./help-corpus";

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;

export class HelpIndexer {
	private readonly db: SqliteDatabase;
	private disposed = false;

	constructor(db: SqliteDatabase) {
		this.db = db;
	}

	/** Replace the entire help_fts table contents with `corpus.articles`.
	 *  Atomic — readers either see the old corpus or the new in full. The
	 *  corpus is identical across vaults, so this runs once per main-process
	 *  boot. */
	rebuild(corpus: HelpCorpus): void {
		this.assertOpen();
		const insert = this.db.prepare(
			"INSERT INTO help_fts (topic_id, section_id, title, body) VALUES (?, ?, ?, ?)",
		);
		const fn = this.db.transaction(() => {
			this.db.exec("DELETE FROM help_fts");
			for (const a of corpus.articles) {
				insert.run(a.topicId, a.sectionId, a.title, a.plaintext);
			}
		});
		fn();
	}

	query(text: string, limit?: number): HelpHit[] {
		this.assertOpen();
		const matchExpr = buildMatchExpression(text);
		if (!matchExpr) return [];
		const clamped = clampLimit(limit);

		const rows = this.db
			.prepare(
				`SELECT
					topic_id   AS topic_id,
					section_id AS section_id,
					title      AS title,
					snippet(help_fts, 3, '<mark>', '</mark>', '…', 10) AS snippet,
					bm25(help_fts) AS score
				FROM help_fts
				WHERE help_fts MATCH ?
				ORDER BY score ASC
				LIMIT ?`,
			)
			.all(matchExpr, clamped) as Array<{
			topic_id: string;
			section_id: string;
			title: string | null;
			snippet: string | null;
			score: number;
		}>;

		return rows.map((row) => ({
			topicId: row.topic_id,
			sectionId: row.section_id,
			title: row.title ?? "",
			snippet: row.snippet ?? "",
			score: row.score,
		}));
	}

	count(): number {
		this.assertOpen();
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM help_fts").get() as { n: number };
		return row.n;
	}

	dispose(): void {
		this.disposed = true;
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("HelpIndexer: disposed");
	}
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), HARD_LIMIT);
}

/** Lookup helper used by the IPC handler — `O(corpus.articles)` walk; the
 *  corpus is small (~tens of articles), so a Map cache is over-engineering. */
export function articleByTopicId(corpus: HelpCorpus, topicId: string): HelpArticle | null {
	return corpus.articles.find((a) => a.topicId === topicId) ?? null;
}
