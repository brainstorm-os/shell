/**
 * 11.3 — sqlite-vec ANN latency + recall, real-Electron version.
 *
 * better-sqlite3 + sqlite-vec only load inside the Electron main process
 * (Bun vitest and system Node hit ABI mismatches). The bench runs over
 * `dev:search:bench-vector` / `dev:search:vec-recall` IPC in the main
 * process on a deterministic synthetic corpus.
 *
 * Budget: doc-18 search <100ms p99 (reuses the 11.0 FTS bench ceilings).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	FTS_QUERY_MEDIAN_BUDGET_MS,
	FTS_QUERY_P99_BUDGET_MS,
} from "../../../packages/shell/src/main/search/bench";
import { launchShell } from "../lib/launch-shell";
import { waitForFirstContentfulPaintAbsoluteMs } from "../lib/measure-paint";

const BENCH_SIZE = Number.parseInt(process.env.BS_VEC_BENCH_SIZE ?? "10000", 10);
const BENCH_RUNS = Number.parseInt(process.env.BS_VEC_BENCH_RUNS ?? "10", 10);

test("sqlite-vec ANN bench + recall parity (main process)", async () => {
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-perf-vec-"));
	try {
		const { app } = await launchShell({ userDataDir, timeoutMs: 120_000 });
		try {
			const page = await app.firstWindow({ timeout: 60_000 });
			await waitForFirstContentfulPaintAbsoluteMs(page);

			const recall = await page.evaluate(async () => {
				const api = (
					window as unknown as {
						brainstorm?: {
							dev?: {
								vecSearchRecall?: (o: {
									seed: number;
									size: number;
									limit?: number;
								}) => Promise<{ ok: boolean; report?: { minRecall: number }; reason?: string }>;
							};
						};
					}
				).brainstorm;
				if (!api?.dev?.vecSearchRecall) throw new Error("dev.vecSearchRecall unavailable");
				return api.dev.vecSearchRecall({ seed: 7, size: 2000, limit: 20 });
			});
			expect(recall.ok, recall.reason ?? "recall failed").toBe(true);
			const recallReport = recall.report as {
				queries?: Array<{ kind: string; exactMatch: boolean }>;
			};
			// The 11.0 bench's rare-term + type-filter shapes target FTS5 IDF /
			// sidecar joins — not vector recall. Pin exact ANN parity on the
			// unfiltered common/multi-term shapes where the stub embedder's
			// nearest-neighbour ranking is stable.
			const exactKinds = new Set(["common-single-term", "two-term-and", "three-term-and"]);
			for (const q of recallReport.queries ?? []) {
				if (!exactKinds.has(q.kind)) continue;
				expect(q.exactMatch, `recall mismatch on ${q.kind}`).toBe(true);
			}

			const bench = await page.evaluate(
				async ({ size, runsPerQuery }) => {
					const api = (
						window as unknown as {
							brainstorm?: {
								dev?: {
									benchSearchVector?: (o: {
										seed: number;
										size: number;
										runsPerQuery?: number;
										warmupRuns?: number;
									}) => Promise<{
										ok: boolean;
										report?: {
											engine: string;
											budget: {
												queryMedianMs: { observed: number; passes: boolean };
												queryP99Ms: { observed: number; passes: boolean };
											};
											diskBytes: number;
										};
										reason?: string;
									}>;
								};
							};
						}
					).brainstorm;
					if (!api?.dev?.benchSearchVector) throw new Error("dev.benchSearchVector unavailable");
					return api.dev.benchSearchVector({
						seed: 42,
						size,
						runsPerQuery,
						warmupRuns: 3,
					});
				},
				{ size: BENCH_SIZE, runsPerQuery: BENCH_RUNS },
			);

			expect(bench.ok, bench.reason ?? "bench failed").toBe(true);
			const report = bench.report;
			expect(report?.engine).toBe("vector-sqlite-vec");
			expect(report?.diskBytes ?? 0).toBeGreaterThan(0);
			expect(report?.budget.queryMedianMs.passes).toBe(true);
			expect(report?.budget.queryP99Ms.passes).toBe(true);

			console.log(
				`[perf] vector-sqlite-vec size=${BENCH_SIZE}: ` +
					`median=${report?.budget.queryMedianMs.observed.toFixed(2)}ms/${FTS_QUERY_MEDIAN_BUDGET_MS}ms ` +
					`p99=${report?.budget.queryP99Ms.observed.toFixed(2)}ms/${FTS_QUERY_P99_BUDGET_MS}ms ` +
					`disk=${((report?.diskBytes ?? 0) / 1024 / 1024).toFixed(2)}MiB`,
			);

			const outPath = join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"results",
				`search-vector-vec-${BENCH_SIZE}.json`,
			);
			writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
