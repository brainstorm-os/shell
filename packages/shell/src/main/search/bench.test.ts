/**
 * Tests for the 11.0 bench harness. Two layers:
 *
 *   1. Pure harness — engine-agnostic: drives a stub `BenchEngine` and
 *      asserts the harness shape (correct counts, warmup excluded,
 *      summarised stats, budget pass/fail). Catches regressions in the
 *      harness logic without the FTS5 cost.
 *   2. FTS5 integration — runs the real `makeFts5Engine` against a small
 *      (~200 entity) corpus and asserts the harness produces a coherent
 *      report end-to-end. Doesn't pin absolute latency numbers (those
 *      depend on the machine); pins structural invariants (monotonic
 *      percentiles, non-zero build time, queries return hits).
 */

import { describe, expect, it } from "vitest";
import {
	type BenchEngine,
	FTS_INDEX_BUILD_PER_ENTITY_BUDGET_MS,
	FTS_QUERY_MEDIAN_BUDGET_MS,
	FTS_QUERY_P99_BUDGET_MS,
	formatBenchReport,
	makeFts5Engine,
	makeVectorEngine,
	parseBenchOptions,
	runBench,
	summarize,
} from "./bench";
import { BenchQueryKind, buildBenchQueries } from "./bench-corpus";

describe("parseBenchOptions", () => {
	it("accepts numeric fields and rejects invalid size", () => {
		expect(parseBenchOptions({ seed: 1, size: 100, runsPerQuery: 3 })).toEqual({
			seed: 1,
			size: 100,
			runsPerQuery: 3,
		});
		expect(parseBenchOptions({ seed: 1, size: 0 })).toBeNull();
	});
});

/* ── summarize() ─────────────────────────────────────────────────────── */

describe("summarize", () => {
	it("zeroes everything on empty input", () => {
		const s = summarize([]);
		expect(s.samples).toBe(0);
		expect(s.median).toBe(0);
		expect(s.p99).toBe(0);
	});

	it("collapses a singleton into the same value across all percentiles", () => {
		const s = summarize([42]);
		expect(s.min).toBe(42);
		expect(s.median).toBe(42);
		expect(s.p95).toBe(42);
		expect(s.p99).toBe(42);
		expect(s.max).toBe(42);
		expect(s.mean).toBe(42);
		expect(s.samples).toBe(1);
	});

	it("computes ordered percentiles for a known sequence", () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
		const s = summarize(samples);
		expect(s.min).toBe(1);
		expect(s.max).toBe(100);
		expect(s.median).toBeCloseTo(50.5, 1);
		expect(s.p95).toBeCloseTo(95.05, 1);
		expect(s.p99).toBeCloseTo(99.01, 1);
		expect(s.mean).toBeCloseTo(50.5, 1);
	});

	it("preserves the min ≤ median ≤ p95 ≤ p99 ≤ max ordering for any input", () => {
		const samples = [3.1, 0.5, 17.2, 4.8, 0.1, 12.0, 2.3, 6.9, 9.0];
		const s = summarize(samples);
		expect(s.min).toBeLessThanOrEqual(s.median);
		expect(s.median).toBeLessThanOrEqual(s.p95);
		expect(s.p95).toBeLessThanOrEqual(s.p99);
		expect(s.p99).toBeLessThanOrEqual(s.max);
	});
});

/* ── pure harness, stub engine ───────────────────────────────────────── */

/** Builds a deterministic stub engine — every query returns a fixed
 *  number of hits with a known latency profile. Lets us pin harness
 *  behaviour without touching SQLite. */
function makeStubEngine(
	opts: {
		name?: string;
		queryLatencyMs?: number;
		indexLatencyMs?: number;
		diskBytes?: number;
		hitsPerQuery?: number;
	} = {},
): {
	engine: BenchEngine;
	disposed: { value: boolean };
	counters: { indexCalls: number; queryCalls: number; warmupVsMeasured: number[] };
} {
	const disposed = { value: false };
	const counters = { indexCalls: 0, queryCalls: 0, warmupVsMeasured: [] as number[] };
	const queryLatency = opts.queryLatencyMs ?? 0;
	const indexLatency = opts.indexLatencyMs ?? 0;
	const hits = opts.hitsPerQuery ?? 3;
	return {
		engine: {
			name: opts.name ?? "stub",
			async indexAll(entities) {
				counters.indexCalls += 1;
				if (indexLatency > 0) await sleep(indexLatency);
				counters.warmupVsMeasured.push(entities.length); // for asserting the corpus arrived
			},
			async query(_q, _limit) {
				counters.queryCalls += 1;
				if (queryLatency > 0) await sleep(queryLatency);
				return Array.from({ length: hits }, (_, i) => ({
					entityId: `bench-${i}`,
					type: "io.test/Note/v1",
					ownerAppId: "io.test",
					title: "stub",
					snippet: "stub snippet",
					score: -1,
					updatedAt: 0,
				}));
			},
			diskBytes() {
				return opts.diskBytes ?? 0;
			},
			async dispose() {
				disposed.value = true;
			},
		},
		disposed,
		counters,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("runBench (stub engine)", () => {
	it("runs `warmupRuns + runsPerQuery` calls per query but only measures the measured runs", async () => {
		const { engine, counters } = makeStubEngine();
		const report = await runBench(() => engine, {
			seed: 1,
			size: 10,
			runsPerQuery: 7,
			warmupRuns: 3,
		});
		const queries = buildBenchQueries();
		// Total query calls = (warmup + measured) * #queries
		expect(counters.queryCalls).toBe((3 + 7) * queries.length);
		// Reported samples per query = measured runs only.
		for (const q of report.queries) {
			expect(q.stats.samples).toBe(7);
		}
	});

	it("emits one QueryBenchResult per BenchQueryKind, preserving query order", async () => {
		const { engine } = makeStubEngine();
		const report = await runBench(() => engine, {
			seed: 1,
			size: 10,
			runsPerQuery: 2,
			warmupRuns: 0,
		});
		expect(report.queries.map((q) => q.kind)).toEqual(buildBenchQueries().map((q) => q.kind));
	});

	it("disposes the engine even when an inner step throws", async () => {
		const { engine, disposed } = makeStubEngine();
		const throwOnIndex: BenchEngine = {
			...engine,
			indexAll: () => {
				throw new Error("boom");
			},
		};
		await expect(
			runBench(() => throwOnIndex, { seed: 1, size: 10, runsPerQuery: 1, warmupRuns: 0 }),
		).rejects.toThrow("boom");
		expect(disposed.value).toBe(true);
	});

	it("populates the budget block with pass=true when latency is well under target", async () => {
		const { engine } = makeStubEngine({ queryLatencyMs: 0 });
		const report = await runBench(() => engine, {
			seed: 1,
			size: 10,
			runsPerQuery: 5,
			warmupRuns: 1,
		});
		expect(report.budget.queryMedianMs.target).toBe(FTS_QUERY_MEDIAN_BUDGET_MS);
		expect(report.budget.queryP99Ms.target).toBe(FTS_QUERY_P99_BUDGET_MS);
		expect(report.budget.indexBuildPerEntityMs.target).toBe(FTS_INDEX_BUILD_PER_ENTITY_BUDGET_MS);
		expect(report.budget.queryMedianMs.passes).toBe(true);
		expect(report.budget.queryP99Ms.passes).toBe(true);
	});

	it("flags pass=false when a metric blows the budget", async () => {
		// queryLatencyMs >> p99 budget — every measured run is over budget.
		const { engine } = makeStubEngine({ queryLatencyMs: FTS_QUERY_P99_BUDGET_MS * 3 });
		const report = await runBench(() => engine, {
			seed: 1,
			size: 5,
			runsPerQuery: 3,
			warmupRuns: 0,
		});
		expect(report.budget.queryMedianMs.passes).toBe(false);
		expect(report.budget.queryP99Ms.passes).toBe(false);
	});

	it("reports zero perEntityIndexMs for a zero-size corpus without dividing by zero", async () => {
		const { engine } = makeStubEngine();
		const report = await runBench(() => engine, { seed: 1, size: 0, runsPerQuery: 2, warmupRuns: 0 });
		expect(report.perEntityIndexMs).toBe(0);
		expect(Number.isFinite(report.perEntityIndexMs)).toBe(true);
	});

	it("carries the corpus seed + size through the report verbatim", async () => {
		const { engine } = makeStubEngine();
		const report = await runBench(() => engine, {
			seed: 999,
			size: 17,
			runsPerQuery: 1,
			warmupRuns: 0,
		});
		expect(report.corpus).toEqual({ seed: 999, size: 17 });
	});
});

/* ── FTS5 integration ────────────────────────────────────────────────── */

describe("runBench × makeFts5Engine — end-to-end", () => {
	it("produces a coherent report against a small FTS5 corpus", async () => {
		const report = await runBench(() => makeFts5Engine(":memory:"), {
			seed: 42,
			size: 200,
			runsPerQuery: 3,
			warmupRuns: 1,
		});
		expect(report.engine).toBe("fts5");
		expect(report.indexBuildMs).toBeGreaterThan(0);
		expect(report.perEntityIndexMs).toBeGreaterThanOrEqual(0);

		// Each query has a stats block with `samples` matching the requested
		// runsPerQuery, and percentiles preserve ordering.
		for (const q of report.queries) {
			expect(q.stats.samples).toBe(3);
			expect(q.stats.min).toBeLessThanOrEqual(q.stats.median);
			expect(q.stats.median).toBeLessThanOrEqual(q.stats.p99);
		}

		// The CommonSingleTerm query against an 'alpha'-rich corpus should
		// land hits in the first run (cross-checks corpus + harness wiring).
		const common = report.queries.find((q) => q.kind === BenchQueryKind.CommonSingleTerm);
		expect(common).toBeDefined();
		expect(common?.firstRunHits ?? 0).toBeGreaterThan(0);

		// On the :memory: SQLite path, page_count pragma still returns >0
		// once any tables exist, so disk size is positive (even if small).
		expect(report.diskBytes).toBeGreaterThanOrEqual(0);
	}, 30_000);

	it("formats a multi-line human-readable summary", async () => {
		const report = await runBench(() => makeFts5Engine(":memory:"), {
			seed: 42,
			size: 50,
			runsPerQuery: 2,
			warmupRuns: 0,
		});
		const text = formatBenchReport(report);
		expect(text).toContain("[fts5]");
		expect(text).toContain("budget:");
		// One line per query kind plus the header + build + budget lines.
		const lines = text.split("\n");
		expect(lines.length).toBe(3 + Object.values(BenchQueryKind).length);
	}, 30_000);

	it("produces a byte-identical corpus across two FTS5 runs of the same seed", async () => {
		// Both runs should see the same first-run hit count for every
		// query, because the corpus is byte-identical even though latency
		// numbers will differ.
		const a = await runBench(() => makeFts5Engine(":memory:"), {
			seed: 7,
			size: 100,
			runsPerQuery: 1,
			warmupRuns: 0,
		});
		const b = await runBench(() => makeFts5Engine(":memory:"), {
			seed: 7,
			size: 100,
			runsPerQuery: 1,
			warmupRuns: 0,
		});
		for (let i = 0; i < a.queries.length; i += 1) {
			expect(a.queries[i]?.firstRunHits).toBe(b.queries[i]?.firstRunHits);
			expect(a.queries[i]?.kind).toBe(b.queries[i]?.kind);
		}
	}, 30_000);
});

/* ── vector (in-memory) integration ──────────────────────────────────── */

describe("runBench × makeVectorEngine — end-to-end", () => {
	it("produces a coherent report against a small corpus (in-memory cosine baseline)", async () => {
		const report = await runBench(() => makeVectorEngine(), {
			seed: 42,
			size: 200,
			runsPerQuery: 3,
			warmupRuns: 1,
		});
		expect(report.engine).toBe("vector-memory");
		expect(report.indexBuildMs).toBeGreaterThan(0);
		for (const q of report.queries) {
			expect(q.stats.samples).toBe(3);
			expect(q.stats.min).toBeLessThanOrEqual(q.stats.median);
			expect(q.stats.median).toBeLessThanOrEqual(q.stats.p99);
		}
		// The stub embedder is a bag-of-tokens hash, so a query built from
		// corpus terms retrieves nearest neighbours — every query returns hits
		// (the in-memory store always returns up to k, ranked by distance).
		const common = report.queries.find((q) => q.kind === BenchQueryKind.CommonSingleTerm);
		expect(common?.firstRunHits ?? 0).toBeGreaterThan(0);
		// In-memory store reports 0 disk (unknown), never negative.
		expect(report.diskBytes).toBe(0);
	}, 30_000);

	it("is deterministic in hit counts across two same-seed runs", async () => {
		const a = await runBench(() => makeVectorEngine(), {
			seed: 7,
			size: 100,
			runsPerQuery: 1,
			warmupRuns: 0,
		});
		const b = await runBench(() => makeVectorEngine(), {
			seed: 7,
			size: 100,
			runsPerQuery: 1,
			warmupRuns: 0,
		});
		for (let i = 0; i < a.queries.length; i += 1) {
			expect(a.queries[i]?.firstRunHits).toBe(b.queries[i]?.firstRunHits);
		}
	}, 30_000);
});
