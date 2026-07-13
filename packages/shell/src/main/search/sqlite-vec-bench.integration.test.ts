/**
 * 11.3 — sqlite-vec ANN unit coverage for the bench helpers. The production
 * sqlite-vec path can't load under Bun (`better-sqlite3` is unsupported), so
 * recall + ANN latency validation runs in real Electron via
 * `tests/perf/specs/search-vector-vec.spec.ts` (`dev:search:bench-vector`).
 */

import { describe, expect, it } from "vitest";
import { makeSqliteVecEngine, makeVectorEngine, parseBenchOptions, runBench } from "./bench";
import { BenchQueryKind } from "./bench-corpus";

const runsUnderBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

describe.skipIf(runsUnderBun)(
	"sqlite-vec ANN (11.3 — requires Electron/Node native sqlite)",
	() => {
		it("produces a coherent on-disk bench report", async () => {
			const engine = await makeSqliteVecEngine(":memory:");
			expect(engine).not.toBeNull();
			if (!engine) return;

			const report = await runBench(async () => engine, {
				seed: 42,
				size: 200,
				runsPerQuery: 3,
				warmupRuns: 1,
			});
			expect(report.engine).toBe("vector-sqlite-vec");
			expect(report.indexBuildMs).toBeGreaterThan(0);
			expect(report.diskBytes).toBeGreaterThan(0);
			const common = report.queries.find((q) => q.kind === BenchQueryKind.CommonSingleTerm);
			expect(common?.firstRunHits ?? 0).toBeGreaterThan(0);
		}, 60_000);
	},
);

describe("sqlite-vec bench helpers", () => {
	it("parseBenchOptions rejects invalid payloads", () => {
		expect(parseBenchOptions(null)).toBeNull();
		expect(parseBenchOptions({ seed: 1, size: 0 })).toBeNull();
		expect(parseBenchOptions({ seed: 42, size: 100, runsPerQuery: 5 })).toEqual({
			seed: 42,
			size: 100,
			runsPerQuery: 5,
		});
	});

	it("in-memory vector engine stays available under Bun for harness regression", async () => {
		const report = await runBench(() => makeVectorEngine(), {
			seed: 42,
			size: 100,
			runsPerQuery: 2,
			warmupRuns: 0,
		});
		expect(report.engine).toBe("vector-memory");
		expect(report.indexBuildMs).toBeGreaterThan(0);
	}, 30_000);
});
