/**
 * SearchIndexer — wraps `search.db`'s FTS5 virtual table with insert /
 * update / delete / query operations. The single writer to `entity_fts`
 * inside the main process (see
 * §Indexing pipeline).
 *
 * Why one writer in main, not a separate worker yet?
 *
 *   - Multi-segment FTS engines (bleve and similar) tend to fail on Windows
 *     under file-handle exhaustion, AV interference mid-merge, and partial
 *     segment writes after unexpected shutdowns. SQLite FTS5 lives in one
 *     DB file under WAL, with well-defined crash semantics that work the
 *     same way on every platform.
 *   - Routing every write through one process means there's no
 *     inter-process concurrency on the index. better-sqlite3 / bun:sqlite
 *     are synchronous; the FTS5 writes are millisecond-scale at our
 *     scale (target ≤ 1M entities per
 *  §Capacity assumptions).
 *   - The index is **rebuildable from sources** — if the file is ever
 *     corrupt we can drop + rebuild with zero data loss because the
 *     canonical content lives in the per-app KV stores (Stage 9.3 entities
 *     service later) and the Yjs docs.
 *
 * Query-string handling: callers pass natural-language `text`; the indexer
 * **tokenises + escapes** it before reaching FTS5 (each token wrapped in
 * double quotes with internal quotes doubled, joined by AND). Raw FTS5
 * operators in user input (`AND`/`OR`/`NEAR`/parens/`*`/`^`) are inert
 * because they sit inside quoted tokens — a user typing `quick OR brown`
 * matches both literal words, not the FTS5 disjunction. The last token
 * gets a `*` prefix-match suffix so live-typing surfaces partial matches.
 *
 * Used by:
 *   - `search-service.ts` — broker handler that exposes `services.search.query`.
 *   - `main/index.ts` — vault-activation lifecycle + reindex-on-note-write.
 */

import type { SqliteDatabase } from "../storage/sqlite";

/** What goes into the FTS5 row for one entity. */
export type IndexableEntity = {
	entityId: string;
	type: string;
	ownerAppId: string;
	title: string;
	body: string;
};

export type SearchHit = {
	entityId: string;
	type: string;
	ownerAppId: string;
	title: string;
	snippet: string;
	score: number;
	updatedAt: number;
};

export type IndexerQuery = {
	text: string;
	types?: readonly string[];
	/** Type URLs to EXCLUDE from results. Used by the Agent to keep its own
	 *  bookkeeping objects (Conversation / Message / Memory) out of retrieval —
	 *  without it the just-asked question, persisted + indexed as a Message,
	 *  outranks every real note and grounding self-references. */
	excludeTypes?: readonly string[];
	limit?: number;
};

/** A snapshot of the index's health, surfaced by the Settings → Search
 *  panel (Stage 9.22.4). Cheap to compute — pure aggregate queries over
 *  the FTS5 table + sidecar, no full scan. `coverage` (indexed vs. the
 *  number of indexable entities the sources currently hold) is *not* here
 *  because the indexer can't see the sources — the IPC layer joins this
 *  with a source count. */
export type IndexStats = {
	/** Rows in the FTS5 table. */
	total: number;
	/** Per-type row counts, busiest type first (ties broken by type name). */
	byType: ReadonlyArray<{ type: string; count: number }>;
	/** Newest `updated_at` across the index, ms epoch. 0 when empty. */
	lastIndexedAt: number;
	/** Approximate on-disk size of `search.db` in bytes. 0 if the driver
	 *  rejects the size pragmas (degrade, never throw). */
	bytes: number;
};

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 200;

/**
 * The schema in `storage/search-schema.ts` doesn't carry ownerAppId or
 * updatedAt — those columns are added here at construction-time as a
 * lightweight side-table joined on entity_id. Keeps the FTS5 virtual table
 * minimal (faster index writes) and lets us tune ranking + result-shape
 * without touching the FTS5 column list.
 */
const SIDECAR_DDL = `
CREATE TABLE IF NOT EXISTS entity_fts_meta (
	entity_id      TEXT PRIMARY KEY,
	owner_app_id   TEXT NOT NULL,
	updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_fts_meta_updated ON entity_fts_meta(updated_at);
`;

export class SearchIndexer {
	private readonly db: SqliteDatabase;
	private disposed = false;

	constructor(db: SqliteDatabase) {
		this.db = db;
		this.db.exec(SIDECAR_DDL);
	}

	/** Insert or replace the index row for `entity`. Safe to call repeatedly
	 *  for the same id — semantically an upsert. Wrapped in a transaction so
	 *  the FTS5 table and sidecar never diverge after a crash mid-write. */
	indexEntity(entity: IndexableEntity, now: number = Date.now()): void {
		this.assertOpen();
		const fn = this.db.transaction(() => {
			this.db.prepare("DELETE FROM entity_fts WHERE entity_id = ?").run(entity.entityId);
			this.db
				.prepare("INSERT INTO entity_fts (entity_id, type, title, body) VALUES (?, ?, ?, ?)")
				.run(entity.entityId, entity.type, entity.title, entity.body);
			this.db
				.prepare(
					`INSERT INTO entity_fts_meta (entity_id, owner_app_id, updated_at)
					 VALUES (?, ?, ?)
					 ON CONFLICT(entity_id) DO UPDATE SET owner_app_id = excluded.owner_app_id, updated_at = excluded.updated_at`,
				)
				.run(entity.entityId, entity.ownerAppId, now);
		});
		fn();
	}

	removeEntity(entityId: string): void {
		this.assertOpen();
		const fn = this.db.transaction(() => {
			this.db.prepare("DELETE FROM entity_fts WHERE entity_id = ?").run(entityId);
			this.db.prepare("DELETE FROM entity_fts_meta WHERE entity_id = ?").run(entityId);
		});
		fn();
	}

	/**
	 * Wipe the index and re-populate from `entities`. Atomic — readers either
	 * see the old index in full or the new index in full, never half. Used
	 * on vault activation (to catch up after restarts where the index
	 * lagged the canonical store) and as the recovery path if the index is
	 * ever suspected stale.
	 */
	rebuild(entities: readonly IndexableEntity[], now: number = Date.now()): void {
		this.assertOpen();
		const insertFts = this.db.prepare(
			"INSERT INTO entity_fts (entity_id, type, title, body) VALUES (?, ?, ?, ?)",
		);
		const insertMeta = this.db.prepare(
			"INSERT OR REPLACE INTO entity_fts_meta (entity_id, owner_app_id, updated_at) VALUES (?, ?, ?)",
		);
		const fn = this.db.transaction(() => {
			this.db.exec("DELETE FROM entity_fts");
			this.db.exec("DELETE FROM entity_fts_meta");
			for (const e of pickIndexable(entities)) {
				insertFts.run(e.entityId, e.type, e.title, e.body);
				insertMeta.run(e.entityId, e.ownerAppId, now);
			}
		});
		fn();
	}

	query(query: IndexerQuery): SearchHit[] {
		this.assertOpen();
		const matchExpr = buildMatchExpression(query.text);
		if (!matchExpr) return [];
		const limit = clampLimit(query.limit);
		const typeFilter = buildTypeFilter(query.types, query.excludeTypes);

		const hits = this.runMatch(matchExpr, limit, typeFilter);
		if (hits.length > 0) return hits;

		// Natural-language fallback: the primary expression ANDs every token, so a
		// full-sentence query (the Agent feeds the raw user turn into `hybrid`)
		// matches nothing — no single object contains every function + content
		// word. When the precise AND match is empty, retry as an OR over the
		// CONTENT words (stopwords dropped), ranked by bm25 so the most relevant
		// objects still surface first. Only fires on a miss, so keyword-precise
		// launcher queries that already match are untouched.
		const orExpr = buildMatchExpression(query.text, { mode: MatchMode.Any, dropStopwords: true });
		if (!orExpr || orExpr === matchExpr) return hits;
		return this.runMatch(orExpr, limit, typeFilter);
	}

	/** Run one FTS5 MATCH expression and map rows to {@link SearchHit}s. Shared
	 *  by the primary AND query and the OR natural-language fallback. */
	private runMatch(
		matchExpr: string,
		limit: number,
		typeFilter: { sql: string; params: readonly string[] },
	): SearchHit[] {
		// FTS5's `snippet(table, col, lhs, rhs, ellipsis, tokens)` is a built-in
		// — col=3 is `body`, lhs/rhs wrap matches in `<mark>` / `</mark>`,
		// ellipsis is `…`, tokens=10 trims to ~10 tokens of context.
		// `bm25()` returns ascending-better scores (negative = best); we sort
		// asc and break ties by `updated_at DESC` so the freshest of two
		// equally-good matches surfaces first.
		const sql = `
			SELECT
				f.entity_id AS entity_id,
				f.type      AS type,
				f.title     AS title,
				snippet(entity_fts, 3, '<mark>', '</mark>', '…', 10) AS snippet,
				bm25(entity_fts)                                      AS score,
				m.owner_app_id AS owner_app_id,
				m.updated_at   AS updated_at
			FROM entity_fts AS f
			LEFT JOIN entity_fts_meta AS m ON m.entity_id = f.entity_id
			WHERE entity_fts MATCH ?
			${typeFilter.sql}
			ORDER BY score ASC, m.updated_at DESC
			LIMIT ?
		`;
		const rows = this.db.prepare(sql).all(matchExpr, ...typeFilter.params, limit) as Array<{
			entity_id: string;
			type: string;
			title: string | null;
			snippet: string | null;
			score: number;
			owner_app_id: string | null;
			updated_at: number | null;
		}>;

		return rows.map((row) => ({
			entityId: row.entity_id,
			type: row.type,
			ownerAppId: row.owner_app_id ?? "",
			title: row.title ?? "",
			snippet: row.snippet ?? "",
			score: row.score,
			updatedAt: row.updated_at ?? 0,
		}));
	}

	/** Number of indexed entities. Cheap; useful for tests + diagnostics. */
	count(): number {
		this.assertOpen();
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM entity_fts").get() as { n: number };
		return row.n;
	}

	/** Health snapshot for the Settings → Search panel. All aggregate
	 *  queries — no full scan, safe to call on every panel open. */
	stats(): IndexStats {
		this.assertOpen();
		const total = this.count();
		const byType = (
			this.db
				.prepare("SELECT type, COUNT(*) AS n FROM entity_fts GROUP BY type ORDER BY n DESC, type ASC")
				.all() as Array<{ type: string; n: number }>
		).map((r) => ({ type: r.type, count: r.n }));
		const lastRow = this.db.prepare("SELECT MAX(updated_at) AS m FROM entity_fts_meta").get() as {
			m: number | null;
		};
		return {
			total,
			byType,
			lastIndexedAt: lastRow.m ?? 0,
			bytes: this.diskBytes(),
		};
	}

	/** `page_count * page_size` for the search DB. Wrapped because the two
	 *  drivers (`bun:sqlite` / `better-sqlite3`) shape pragma rows
	 *  differently and an encrypted-at-rest DB (Stage 3b) may refuse them
	 *  pre-key — a missing size must never blank the whole panel. */
	private diskBytes(): number {
		try {
			const pages = readPragmaNumber(this.db.pragma("page_count"));
			const size = readPragmaNumber(this.db.pragma("page_size"));
			return pages > 0 && size > 0 ? pages * size : 0;
		} catch {
			return 0;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("SearchIndexer: disposed");
	}
}

/** How the tokens of a multi-word query combine in the FTS5 MATCH expression.
 *  `All` (default) ANDs them — precise, the launcher's keyword behaviour.
 *  `Any` ORs them — the natural-language fallback when the AND match is empty. */
export enum MatchMode {
	All = "all",
	Any = "any",
}

/** Common English function words dropped when {@link buildMatchExpression} runs
 *  in the natural-language (`Any`) fallback. The Agent feeds whole user turns
 *  into search; ANDing/ORing stopwords either matches nothing or floods the
 *  results with low-signal hits. Kept deliberately small — only the highest-
 *  frequency, zero-content words — so it never strips a real query term. */
const STOPWORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"but",
	"by",
	"can",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"no",
	"not",
	"of",
	"on",
	"or",
	"our",
	"so",
	"that",
	"the",
	"their",
	"them",
	"then",
	"there",
	"these",
	"they",
	"this",
	"to",
	"was",
	"we",
	"were",
	"what",
	"when",
	"where",
	"which",
	"who",
	"whom",
	"why",
	"will",
	"with",
	"you",
	"your",
]);

/** Tokenise + escape a free-form user query into an FTS5 MATCH expression.
 *
 *   "hello world"   → `"hello" AND "world"*`
 *   `"don't"`       → `"don't"*`
 *   `"a "b" c"`     → `"a" AND "b" AND "c"*`   (internal quotes doubled)
 *   `"AND OR NEAR"` → `"AND" AND "OR" AND "NEAR"*`
 *
 * With `mode: MatchMode.Any` the tokens are ORed instead (the NL fallback); with
 * `dropStopwords` the high-frequency function words are removed first (only when
 * content words remain, so an all-stopword query still matches something).
 *
 * Empty / whitespace-only input returns null (caller short-circuits to no
 * hits). The last token gets a `*` prefix-match suffix so live-typing
 * surfaces partial matches without the user typing wildcards. */
export function buildMatchExpression(
	text: string,
	opts: { mode?: MatchMode; dropStopwords?: boolean } = {},
): string | null {
	if (typeof text !== "string") return null;
	// Split on FTS5 token boundaries. The default `unicode61` tokeniser treats
	// every character outside Unicode categories L (letter) and N (number) as
	// a separator — that means apostrophes, hyphens, underscores etc. are NOT
	// part of tokens. Mirror that exactly so a user query like "don't" emits
	// the same tokens FTS5 stored ("don" + "t"); a mismatch here means
	// typed queries silently miss content.
	const raw = text
		.split(/[^\p{L}\p{N}]+/u)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
	if (raw.length === 0) return null;

	// Drop stopwords only when content words survive — an all-stopword query
	// ("who are they") keeps its tokens rather than degrading to no match.
	let tokens = raw;
	if (opts.dropStopwords) {
		const content = raw.filter((t) => !STOPWORDS.has(t.toLowerCase()));
		if (content.length > 0) tokens = content;
	}

	const escaped = tokens.map((t) => `"${t.replace(/"/g, '""')}"`);
	const joiner = opts.mode === MatchMode.Any ? " OR " : " AND ";
	const last = escaped[escaped.length - 1];
	const lastWithPrefix = `${last}*`;
	const head = escaped.slice(0, -1);
	if (head.length === 0) return lastWithPrefix;
	return `${head.join(joiner)}${joiner}${lastWithPrefix}`;
}

export function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), HARD_LIMIT);
}

function buildTypeFilter(
	includeTypes: readonly string[] | undefined,
	excludeTypes: readonly string[] | undefined,
): { sql: string; params: readonly string[] } {
	// Type strings are app-declared URLs, not user input — still, parameterise
	// to keep the query plan stable + safe.
	const clauses: string[] = [];
	const params: string[] = [];
	if (includeTypes && includeTypes.length > 0) {
		clauses.push(`AND f.type IN (${includeTypes.map(() => "?").join(", ")})`);
		params.push(...includeTypes);
	}
	if (excludeTypes && excludeTypes.length > 0) {
		clauses.push(`AND f.type NOT IN (${excludeTypes.map(() => "?").join(", ")})`);
		params.push(...excludeTypes);
	}
	return { sql: clauses.join(" "), params };
}

/** The single predicate for "this entity earns a row in the index" —
 *  shared by `rebuild` and the coverage count so the Settings panel's
 *  "indexed vs. available" can never disagree with what `rebuild` writes
 *  (DRY: was inlined in `rebuild` only). */
export function isIndexable(e: IndexableEntity): boolean {
	if (!e.entityId || typeof e.entityId !== "string") return false;
	if (!e.type || typeof e.type !== "string") return false;
	// At least one of title / body must carry text — pure-blank rows would
	// match every search regardless of input via FTS5's MATCH-empty semantics.
	const titleHasText = typeof e.title === "string" && e.title.trim().length > 0;
	const bodyHasText = typeof e.body === "string" && e.body.trim().length > 0;
	return titleHasText || bodyHasText;
}

/** The indexable subset of `entities`, in input order. */
export function pickIndexable(entities: readonly IndexableEntity[]): readonly IndexableEntity[] {
	return entities.filter(isIndexable);
}

/** Coerce a driver pragma result to its scalar number.
 *
 *  The `pragma()` adapter (`storage/sqlite.ts`) returns the **array of
 *  rows** (`.all()` for bun:sqlite; better-sqlite3's `.pragma()` is
 *  array-by-default) — e.g. `PRAGMA page_count` → `[ { page_count: 12 } ]`,
 *  not the bare row. Unwrap: take the first row, then its first value.
 *  Also tolerates a scalar (a `{ simple: true }` driver) and a bare row
 *  object so a future adapter change can't silently zero the size again
 *  (the user-reported "search index size shows 0 B" was exactly this —
 *  the array wrapper was read as the value object). */
function readPragmaNumber(result: unknown): number {
	let value: unknown = result;
	if (Array.isArray(value)) value = value[0];
	if (value && typeof value === "object") {
		value = Object.values(value as Record<string, unknown>)[0];
	}
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
