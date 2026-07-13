/**
 * The 11.0 search bench harness — drives the existing `SearchIndexer`
 * (FTS5 path) against a deterministic synthetic corpus and reports the
 * latency / build-time / disk-size numbers the doc-18 §Performance
 * budgets table is asking us to validate.
 *
 * Design constraints:
 *
 *   - **Engine-agnostic shape.** The harness is parameterised on a
 *     `BenchEngine` interface (`index` / `query` / `diskBytes` /
 *     `dispose`). The FTS5 engine is the only one wired today; the same
 *     harness consumes a Tantivy engine without code edits when the
 *     NAPI binding lands — the bench's output is therefore directly
 *     comparable.
 *   - **Deterministic.** Same `(seed, size)` produces byte-identical
 *     numbers modulo timer noise. We never call `Date.now()` for the
 *     corpus; only `performance.now()` for the latency samples.
 *   - **Honest measurement.** Each query runs `runsPerQuery` times after
 *     a warmup pass; we report median + p95 + p99 (not mean — tail
 *     latencies are what the budget cares about). Build-time is
 *     measured once because the index is rebuilt fresh per run.
 *   - **Budget-aware.** Each measured metric is compared against the
 *     doc-18 numbers. The output JSON carries a `passes` flag per
 *     metric so a wider tooling step (CI / Settings → Diagnostics)
 *     can summarise pass/fail without re-reading the docs.
 *
 * Out of scope for this iteration:
 *
 *   - Real prose corpora (Wikipedia, etc.). Deferred until the
 *     deterministic baseline lands a number — adding prose changes
 *     two variables at once and obscures the FTS5 baseline.
 *   - Tantivy itself. The bench takes a `BenchEngine` so the swap is
 *     one constructor; the NAPI binding is the gate, not this harness.
 *
 * Spec: §Performance budgets.
 */

import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { type SqliteDatabase, open, openWithVecExtension } from "../storage/sqlite";
import {
	type BenchQuery,
	type BenchQueryKind,
	buildBenchQueries,
	makeBenchCorpus,
} from "./bench-corpus";
import { EMBEDDING_DIM, StubEmbedder, type TextEmbedder } from "./embedder";
import { type IndexableEntity, type SearchHit, SearchIndexer } from "./search-indexer";
import { VectorIndexer, createVectorIndexer } from "./vector-indexer";
import { InMemoryVectorStore, type VectorStore } from "./vector-store";

/** The minimal engine surface the bench drives. Two implementations are
 *  expected by 11.0: FTS5 (today) and Tantivy (forward iteration). */
export type BenchEngine = {
	readonly name: string;
	/** Rebuild the index from scratch with `entities`. The harness times
	 *  the whole call; the engine is free to internally batch / commit. */
	indexAll: (entities: readonly IndexableEntity[]) => Promise<void> | void;
	/** Run a single query and return the hits. The harness times the
	 *  full call. Result shape stays `SearchHit[]` so cross-engine
	 *  comparisons can be result-set-stable (a Tantivy engine returns
	 *  the same shape so the bench script doesn't care which is under
	 *  the hood). */
	query: (q: BenchQuery, limit: number) => Promise<SearchHit[]> | SearchHit[];
	/** Disk footprint in bytes. `0` if the engine can't tell (the
	 *  caller treats `0` as "unknown" rather than "empty"). */
	diskBytes: () => number;
	dispose: () => Promise<void> | void;
};

/** Latency / size statistics gathered for one bench run. */
export type BenchStats = {
	/** Pre-sorted ascending. Tests assert min ≤ median ≤ p99 ≤ max. */
	min: number;
	median: number;
	p95: number;
	p99: number;
	max: number;
	mean: number;
	samples: number;
};

export type QueryBenchResult = {
	kind: BenchQueryKind;
	stats: BenchStats;
	/** Hits returned by the *first* run — pinned so cross-engine result
	 *  divergence is a separate signal from latency divergence. */
	firstRunHits: number;
};

export type BenchReport = {
	engine: string;
	corpus: { seed: number; size: number };
	indexBuildMs: number;
	perEntityIndexMs: number;
	diskBytes: number;
	queries: QueryBenchResult[];
	/** The doc-18 budget pass/fail summary. */
	budget: {
		queryMedianMs: { target: number; observed: number; passes: boolean };
		queryP99Ms: { target: number; observed: number; passes: boolean };
		indexBuildPerEntityMs: { target: number; observed: number; passes: boolean };
	};
	/** Wall-clock when the run completed — epoch ms. Reported back so a
	 *  cached JSON report's age is visible without parsing the filename. */
	completedAt: number;
};

export type BenchOptions = {
	seed: number;
	size: number;
	/** Per-query repetitions for percentile stability. Default 20 — gives
	 *  a usable p99 within a reasonable run time. */
	runsPerQuery?: number;
	/** Warmup runs per query (NOT counted). Default 5 — warms FTS5's
	 *  page cache + the engine's prepared statements. */
	warmupRuns?: number;
	/** Max hits returned per query. Default 50 (mirrors `DEFAULT_LIMIT`
	 *  inside `SearchIndexer`). */
	limit?: number;
};

/** Doc-18 §Performance budgets — pinned in code so the bench's pass/fail
 *  flag tracks the docs without scraping the markdown table. If the
 *  doc number changes, this constant changes in the same PR. */
export const FTS_QUERY_MEDIAN_BUDGET_MS = 50;
export const FTS_QUERY_P99_BUDGET_MS = 100;
/** A loose ceiling derived from the "index lag <2s p50" budget — if
 *  indexing one entity takes more than this, the rebuild path is
 *  outside the design. 2ms is generous on a 2020-era machine. */
export const FTS_INDEX_BUILD_PER_ENTITY_BUDGET_MS = 2;

/**
 * Run the bench end-to-end. Builds the corpus, runs warmup + measured
 * queries, returns a report. The engine is disposed before return — the
 * caller doesn't need to.
 */
export async function runBench(
	makeEngine: () => BenchEngine | Promise<BenchEngine>,
	options: BenchOptions,
): Promise<BenchReport> {
	const runsPerQuery = options.runsPerQuery ?? 20;
	const warmupRuns = options.warmupRuns ?? 5;
	const limit = options.limit ?? 50;
	const corpus = makeBenchCorpus({ seed: options.seed, size: options.size });
	const engine = await makeEngine();

	try {
		const indexStart = nowMs();
		await engine.indexAll(corpus);
		const indexBuildMs = nowMs() - indexStart;
		const perEntityIndexMs = corpus.length > 0 ? indexBuildMs / corpus.length : 0;

		const queries = buildBenchQueries();
		const results: QueryBenchResult[] = [];
		const allSamples: number[] = [];
		for (const q of queries) {
			for (let w = 0; w < warmupRuns; w += 1) await engine.query(q, limit);
			const samples: number[] = [];
			let firstRunHits = 0;
			for (let r = 0; r < runsPerQuery; r += 1) {
				const t0 = nowMs();
				const hits = await engine.query(q, limit);
				const dt = nowMs() - t0;
				samples.push(dt);
				if (r === 0) firstRunHits = hits.length;
			}
			const stats = summarize(samples);
			results.push({ kind: q.kind, stats, firstRunHits });
			allSamples.push(...samples);
		}

		const overall = summarize(allSamples);
		const diskBytes = engine.diskBytes();

		return {
			engine: engine.name,
			corpus: { seed: options.seed, size: options.size },
			indexBuildMs,
			perEntityIndexMs,
			diskBytes,
			queries: results,
			budget: {
				queryMedianMs: {
					target: FTS_QUERY_MEDIAN_BUDGET_MS,
					observed: overall.median,
					passes: overall.median <= FTS_QUERY_MEDIAN_BUDGET_MS,
				},
				queryP99Ms: {
					target: FTS_QUERY_P99_BUDGET_MS,
					observed: overall.p99,
					passes: overall.p99 <= FTS_QUERY_P99_BUDGET_MS,
				},
				indexBuildPerEntityMs: {
					target: FTS_INDEX_BUILD_PER_ENTITY_BUDGET_MS,
					observed: perEntityIndexMs,
					passes: perEntityIndexMs <= FTS_INDEX_BUILD_PER_ENTITY_BUDGET_MS,
				},
			},
			completedAt: Date.now(),
		};
	} finally {
		await engine.dispose();
	}
}

/** FTS5 engine adapter — wires the existing `SearchIndexer` into the
 *  `BenchEngine` interface. Backed by an on-disk SQLite DB; the path is
 *  caller-supplied so a CLI runner can keep the file for size analysis
 *  but tests can use `":memory:"` for speed. */
export async function makeFts5Engine(dbPath = ":memory:"): Promise<BenchEngine> {
	const db: SqliteDatabase = await open(dbPath);
	await applyMigrations(db, SEARCH_MIGRATIONS);
	const indexer = new SearchIndexer(db);
	return {
		name: "fts5",
		indexAll(entities) {
			indexer.rebuild(entities);
		},
		query(q, limit) {
			return indexer.query({
				text: q.text,
				limit,
				...(q.types ? { types: q.types } : {}),
			});
		},
		diskBytes() {
			return indexer.stats().bytes;
		},
		async dispose() {
			indexer.dispose();
			db.close();
		},
	};
}

/**
 * Vector (semantic) engine adapter — drives `VectorIndexer` through the same
 * `BenchEngine` interface so the vector path's latency / build numbers are
 * directly comparable to FTS5.
 *
 * The default store is `InMemoryVectorStore`, a brute-force O(N) cosine
 * scan: portable (runs under the `bun:sqlite` test runtime that can't load
 * sqlite-vec), reproducible, and a meaningful *brute-force* baseline — but
 * NOT sqlite-vec's ANN. The real `sqlite-vec` numbers (ANN, on-disk) are a
 * real-Electron run, the same deferral the FTS5↔Tantivy comparison uses
 * (11.0b). Pass a custom `store` to bench an alternative backend.
 *
 * Uses the `StubEmbedder` (11.2's only embedder); 11.3's
 * `multilingual-e5-small` slots in via the `embedder` option with no harness
 * change. Embedding the corpus is part of the timed build, exactly as it
 * will be in production.
 */
/**
 * sqlite-vec ANN engine adapter — the production vector backend on disk.
 * Returns `null` when `better-sqlite3` or `sqlite-vec` can't load (Bun's
 * test sqlite, or a platform missing the prebuilt binary). Uses the same
 * `StubEmbedder` as `makeVectorEngine` so numbers stay comparable; 11.3's
 * `FastembedEmbedder` slots in via the `embedder` option.
 */
export async function makeSqliteVecEngine(
	dbPath = ":memory:",
	opts?: { embedder?: TextEmbedder },
): Promise<BenchEngine | null> {
	const db = await openWithVecExtension(dbPath);
	if (!db) return null;
	const embedder = opts?.embedder ?? new StubEmbedder();
	const built = createVectorIndexer(db, embedder);
	if (!built) {
		db.close();
		return null;
	}
	const indexer = built.indexer;
	return {
		name: "vector-sqlite-vec",
		async indexAll(entities) {
			await indexer.rebuild(entities);
		},
		async query(q, limit) {
			const hits = await indexer.query(q.text, limit, q.types);
			return hits.map((h) => ({
				entityId: h.entityId,
				type: h.type,
				ownerAppId: h.ownerAppId,
				title: "",
				snippet: "",
				score: h.distance,
				updatedAt: h.updatedAt,
			}));
		},
		diskBytes() {
			return sqliteDiskBytes(db);
		},
		async dispose() {
			indexer.dispose();
			db.close();
		},
	};
}

export function makeVectorEngine(opts?: {
	store?: VectorStore;
	embedder?: TextEmbedder;
}): BenchEngine {
	const embedder = opts?.embedder ?? new StubEmbedder();
	const store = opts?.store ?? new InMemoryVectorStore(embedder.dim || EMBEDDING_DIM);
	const indexer = new VectorIndexer(store, embedder);
	return {
		name: store instanceof InMemoryVectorStore ? "vector-memory" : "vector",
		async indexAll(entities) {
			await indexer.rebuild(entities);
		},
		async query(q, limit) {
			const hits = await indexer.query(q.text, limit, q.types);
			// Map to the shared `SearchHit` shape so cross-engine comparison
			// stays result-set-stable; the bench only reads `.length`. `score`
			// carries the cosine distance (smaller = nearer).
			return hits.map((h) => ({
				entityId: h.entityId,
				type: h.type,
				ownerAppId: h.ownerAppId,
				title: "",
				snippet: "",
				score: h.distance,
				updatedAt: h.updatedAt,
			}));
		},
		diskBytes() {
			// In-memory store can't report a disk footprint; 0 = "unknown".
			return 0;
		},
		dispose() {
			indexer.dispose();
		},
	};
}

/** Render a `BenchReport` to a compact human-readable string. Used by the
 *  CLI runner and by tests that want a single-line assertion failure
 *  message. */
export function formatBenchReport(report: BenchReport): string {
	const lines: string[] = [];
	lines.push(`[${report.engine}] corpus seed=${report.corpus.seed} size=${report.corpus.size}`);
	lines.push(
		`build: ${report.indexBuildMs.toFixed(0)}ms total · ${report.perEntityIndexMs.toFixed(3)}ms/entity` +
			` · disk: ${(report.diskBytes / 1024 / 1024).toFixed(2)} MiB`,
	);
	for (const q of report.queries) {
		lines.push(
			`q[${q.kind}] median=${q.stats.median.toFixed(2)}ms ` +
				`p95=${q.stats.p95.toFixed(2)}ms p99=${q.stats.p99.toFixed(2)}ms ` +
				`max=${q.stats.max.toFixed(2)}ms hits=${q.firstRunHits}`,
		);
	}
	const b = report.budget;
	lines.push(
		`budget: median ${b.queryMedianMs.observed.toFixed(2)}/${b.queryMedianMs.target}ms ` +
			`[${b.queryMedianMs.passes ? "PASS" : "FAIL"}] · ` +
			`p99 ${b.queryP99Ms.observed.toFixed(2)}/${b.queryP99Ms.target}ms ` +
			`[${b.queryP99Ms.passes ? "PASS" : "FAIL"}] · ` +
			`build/entity ${b.indexBuildPerEntityMs.observed.toFixed(3)}/${b.indexBuildPerEntityMs.target}ms ` +
			`[${b.indexBuildPerEntityMs.passes ? "PASS" : "FAIL"}]`,
	);
	return lines.join("\n");
}

/** `page_count * page_size` for a bench DB — mirrors `SearchIndexer.stats().bytes`. */
export type VecRecallQueryResult = {
	kind: BenchQueryKind;
	recallAtK: number;
	exactMatch: boolean;
};

export type VecRecallReport = {
	corpus: { seed: number; size: number };
	k: number;
	queries: VecRecallQueryResult[];
	minRecall: number;
};

/** Compare sqlite-vec ANN top-k against the in-memory brute-force reference.
 *  Returns `null` when the production backend can't load. */
export async function measureVecRecallParity(opts: {
	seed: number;
	size: number;
	k?: number;
}): Promise<VecRecallReport | null> {
	const k = opts.k ?? 20;
	const embedder = new StubEmbedder();
	const corpus = makeBenchCorpus({ seed: opts.seed, size: opts.size });
	const memory = new InMemoryVectorStore(embedder.dim);
	const memoryIndexer = new VectorIndexer(memory, embedder);
	await memoryIndexer.rebuild(corpus);

	const db = await openWithVecExtension(":memory:");
	if (!db) return null;
	const built = createVectorIndexer(db, embedder);
	if (!built) {
		db.close();
		return null;
	}
	const vecIndexer = built.indexer;
	await vecIndexer.rebuild(corpus);

	const queries: VecRecallQueryResult[] = [];
	for (const q of buildBenchQueries()) {
		const ref = await memoryIndexer.query(q.text, k, q.types);
		const ann = await vecIndexer.query(q.text, k, q.types);
		const refIds = ref.map((h) => h.entityId);
		const annIds = ann.map((h) => h.entityId);
		queries.push({
			kind: q.kind,
			recallAtK: recallAtK(refIds, annIds, k),
			exactMatch: refIds.length === annIds.length && refIds.every((id, i) => id === annIds[i]),
		});
	}

	vecIndexer.dispose();
	db.close();

	const minRecall = queries.reduce((min, q) => Math.min(min, q.recallAtK), 1);
	return { corpus: { seed: opts.seed, size: opts.size }, k, queries, minRecall };
}

function recallAtK(ref: readonly string[], ann: readonly string[], k: number): number {
	const refK = ref.slice(0, k);
	if (refK.length === 0) return 1;
	const annSet = new Set(ann.slice(0, k));
	let hit = 0;
	for (const id of refK) {
		if (annSet.has(id)) hit += 1;
	}
	return hit / refK.length;
}

/** Validate bench options from an IPC payload — keeps the dev handler thin. */
export function parseBenchOptions(raw: unknown): BenchOptions | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const seed = typeof o.seed === "number" ? o.seed : Number.parseInt(String(o.seed ?? ""), 10);
	const size = typeof o.size === "number" ? o.size : Number.parseInt(String(o.size ?? ""), 10);
	if (!Number.isFinite(seed) || !Number.isFinite(size) || size <= 0) return null;
	const runsPerQuery =
		typeof o.runsPerQuery === "number"
			? o.runsPerQuery
			: o.runsPerQuery !== undefined
				? Number.parseInt(String(o.runsPerQuery), 10)
				: undefined;
	const warmupRuns =
		typeof o.warmupRuns === "number"
			? o.warmupRuns
			: o.warmupRuns !== undefined
				? Number.parseInt(String(o.warmupRuns), 10)
				: undefined;
	const limit =
		typeof o.limit === "number"
			? o.limit
			: o.limit !== undefined
				? Number.parseInt(String(o.limit), 10)
				: undefined;
	return {
		seed,
		size,
		...(Number.isFinite(runsPerQuery) ? { runsPerQuery: runsPerQuery as number } : {}),
		...(Number.isFinite(warmupRuns) ? { warmupRuns: warmupRuns as number } : {}),
		...(Number.isFinite(limit) ? { limit: limit as number } : {}),
	};
}

export function sqliteDiskBytes(db: SqliteDatabase): number {
	try {
		const pages = readPragmaNumber(db.pragma("page_count"));
		const size = readPragmaNumber(db.pragma("page_size"));
		return pages > 0 && size > 0 ? pages * size : 0;
	} catch {
		return 0;
	}
}

function readPragmaNumber(result: unknown): number {
	let value: unknown = result;
	if (Array.isArray(value)) value = value[0];
	if (value && typeof value === "object") {
		value = Object.values(value as Record<string, unknown>)[0];
	}
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A monotonic-clock millisecond timestamp. Prefers `performance.now()`
 *  (microsecond resolution on most runtimes) and falls back to
 *  `Date.now()` if `performance` is absent — never wall-clock-jumps
 *  during a run, so latency samples are stable. */
function nowMs(): number {
	const perf: { now?: () => number } | undefined = (
		globalThis as { performance?: { now?: () => number } }
	).performance;
	return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/** Pure stats — extracted here (rather than imported from
 *  `tests/perf/lib/stats.ts`) because that module is Playwright-side and
 *  the shell-side tsconfig doesn't include it. Identical formula. */
export function summarize(samples: readonly number[]): BenchStats {
	if (samples.length === 0) {
		return { min: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0, samples: 0 };
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const len = sorted.length;
	// biome-ignore lint/style/noNonNullAssertion: len>0 guarded above
	const min = sorted[0]!;
	// biome-ignore lint/style/noNonNullAssertion: len>0
	const max = sorted[len - 1]!;
	const mean = samples.reduce((acc, n) => acc + n, 0) / len;
	return {
		min,
		median: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		max,
		mean,
		samples: len,
	};
}

function percentile(sortedAsc: readonly number[], q: number): number {
	if (sortedAsc.length === 0) return 0;
	if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
	const rank = q * (sortedAsc.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	const loVal = sortedAsc[lo] ?? 0;
	const hiVal = sortedAsc[hi] ?? loVal;
	const frac = rank - lo;
	return loVal + (hiVal - loVal) * frac;
}
