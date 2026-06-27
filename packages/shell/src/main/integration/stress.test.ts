/**
 * Stage 13.4 — headless stress harness.
 *
 * Drives the three documented scale points entirely in-process under the
 * `bun:sqlite` test runtime (no native rebuild, no Electron), so the numbers
 * are self-verifiable on any developer machine and in CI:
 *
 *   1. **100k entities** — bulk-insert 100k rows into a real `entities.db`,
 *      build the FTS5 index over them, then time representative queries:
 *      by-type (`EntitiesRepository.query`), by-link
 *      (`EntitiesRepository.idsByLink`), and full-text search
 *      (`SearchIndexer.query`). Asserts the doc-18 §Performance-budgets FTS
 *      target: <50ms p50 / <100ms p99 at ≤100k entities.
 *   2. **50MB Yjs doc** — build a large `Y.Doc`, apply updates through
 *      `YDocStore`, measure update→persist latency, verify each tail entry's
 *      CRC survives a reload, and prove the documented 256 KiB tail-compaction
 *      threshold fires.
 *   3. **1k-cell layout** — validate + resolve a 1000-cell `Layout/v1`
 *      through the shared validator/resolver and time it.
 *
 * The numbers print to the test output via `console.log` so a run is a live
 * before/after record. Assertions carry a deliberately generous CI-safe
 * margin (the doc target × a slack factor) because the test runs on shared,
 * unknown hardware — the raw measured numbers in the log are the real signal;
 * the assertions only guard against an order-of-magnitude regression.
 *
 * Spec: §Performance budgets,
 *  §Performance budgets.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LayoutCell,
	LayoutCellKind,
	LayoutContext,
	type LayoutDef,
	LayoutMode,
	LinkDirection,
	collectCellIds,
	validateLayout,
} from "@brainstorm/sdk-types";
import { resolveLayout } from "@brainstorm/sdk/layout-resolver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { makeBenchCorpus } from "../search/bench-corpus";
import { SearchIndexer } from "../search/search-indexer";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { applyMigrations } from "../storage/migrations";
import { SEARCH_MIGRATIONS } from "../storage/search-schema";
import { type SqliteDatabase, open } from "../storage/sqlite";
import { DEFAULT_COMPACT_THRESHOLD, YDocStore } from "../storage/ydoc-store";

/**
 * Entity count for the bulk-insert scale point. The doc budget is stated at
 * "≤100k entities"; CI runs the full 100k but a faster local iteration can
 * shrink it via the env var without editing the file. The FTS p50/p99
 * budget is independent of corpus size by design (it's a per-query latency),
 * so a smaller corpus still validates the query path — it just doesn't
 * exercise the full-scale index.
 */
const ENTITY_COUNT = clampInt(process.env.BS_STRESS_ENTITY_COUNT, 100_000, 1_000, 100_000);

/** Per-query repetitions for a stable p50/p99 estimate. */
const QUERY_RUNS = clampInt(process.env.BS_STRESS_QUERY_RUNS, 30, 5, 500);
const QUERY_WARMUP = 5;

/**
 * Doc-18 §Performance budgets: FTS <50ms p50, <100ms p99 (≤100k entities).
 * Pinned in code so a doc-number change lands in the same PR.
 */
const FTS_P50_BUDGET_MS = 50;
const FTS_P99_BUDGET_MS = 100;

/**
 * CI-safe slack multiplier. The harness runs on shared, often-virtualised
 * runners that are several times slower than the 2020-era M1 baseline the
 * doc assumes (and the doc itself says lower-end hardware is "2-3x relaxed").
 * The raw `console.log` numbers are the real signal; the assertion only
 * catches an order-of-magnitude regression. Override per the runner.
 */
const CI_SLACK = clampFloat(process.env.BS_STRESS_CI_SLACK, 8, 1, 100);

const ONE_MIB = 1024 * 1024;
/** Target on-disk Y.Doc size for the large-doc scale point. */
const YDOC_TARGET_BYTES = clampInt(process.env.BS_STRESS_YDOC_MB, 50, 1, 200) * ONE_MIB;

function clampInt(raw: string | undefined, fallback: number, lo: number, hi: number): number {
	const n = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}

function clampFloat(raw: string | undefined, fallback: number, lo: number, hi: number): number {
	const n = Number.parseFloat(raw ?? "");
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}

function now(): number {
	const perf = (globalThis as { performance?: { now?: () => number } }).performance;
	return typeof perf?.now === "function" ? perf.now() : Date.now();
}

type Stats = { min: number; p50: number; p95: number; p99: number; max: number };

function summarize(samples: readonly number[]): Stats {
	if (samples.length === 0) return { min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const pct = (q: number): number => {
		const rank = q * (sorted.length - 1);
		const lo = Math.floor(rank);
		const hi = Math.ceil(rank);
		const loVal = sorted[lo] ?? 0;
		const hiVal = sorted[hi] ?? loVal;
		return loVal + (hiVal - loVal) * (rank - lo);
	};
	return {
		min: sorted[0] ?? 0,
		p50: pct(0.5),
		p95: pct(0.95),
		p99: pct(0.99),
		max: sorted[sorted.length - 1] ?? 0,
	};
}

/** Time `fn` over `QUERY_RUNS` runs after a warmup, returning latency stats. */
function timeRepeated(fn: () => unknown): Stats {
	for (let i = 0; i < QUERY_WARMUP; i += 1) fn();
	const samples: number[] = [];
	for (let i = 0; i < QUERY_RUNS; i += 1) {
		const t0 = now();
		fn();
		samples.push(now() - t0);
	}
	return summarize(samples);
}

function fmt(stats: Stats): string {
	return `p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms p99=${stats.p99.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`;
}

describe("stress: 100k entities (entities.db + FTS5)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let entitiesDb: SqliteDatabase;
	let searchDb: SqliteDatabase;
	let repo: EntitiesRepository;
	let indexer: SearchIndexer;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-stress-entities-"));
		stores = new DataStores(vaultDir);
		entitiesDb = await stores.open("entities");
		repo = new EntitiesRepository(entitiesDb);
		searchDb = await open(":memory:");
		await applyMigrations(searchDb, SEARCH_MIGRATIONS);
		indexer = new SearchIndexer(searchDb);
	});

	afterEach(async () => {
		indexer.dispose();
		searchDb.close();
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it(
		`inserts ${ENTITY_COUNT} entities and keeps FTS p50<${FTS_P50_BUDGET_MS}ms / p99<${FTS_P99_BUDGET_MS}ms`,
		{ timeout: 600_000 },
		() => {
			const corpus = makeBenchCorpus({ seed: 1, size: ENTITY_COUNT });

			// Bulk-insert into the REAL entities table inside one transaction —
			// the production write path (`EntitiesRepository.create`) per row.
			const insertStart = now();
			repo.transaction(() => {
				for (let i = 0; i < corpus.length; i += 1) {
					const e = corpus[i];
					if (!e) continue;
					repo.create({
						id: e.entityId,
						type: e.type,
						properties: { title: e.title, body: e.body },
						createdBy: e.ownerAppId,
						now: 1000 + i,
						dekId: null,
					});
				}
			});
			const insertMs = now() - insertStart;

			// A dense link layer so the by-link fast path has real fan-out:
			// chain each entity to the next under one link type.
			const linkStart = now();
			repo.transaction(() => {
				for (let i = 1; i < corpus.length; i += 1) {
					const a = corpus[i - 1];
					const b = corpus[i];
					if (!a || !b) continue;
					repo.putLink({
						id: `link-${i}`,
						sourceEntityId: a.entityId,
						destEntityId: b.entityId,
						linkType: "brainstorm/ref/next",
						createdAt: 1000 + i,
					});
				}
			});
			const linkMs = now() - linkStart;

			// Build the FTS index over the same corpus.
			const indexStart = now();
			indexer.rebuild(corpus);
			const indexMs = now() - indexStart;
			expect(indexer.count()).toBeGreaterThan(0);

			// ── Representative query timings ──
			const byType = timeRepeated(() =>
				repo.query({ type: "io.brainstorm.notes/Note/v1", limit: 50 }),
			);
			const anchor = corpus[0]?.entityId ?? "bench-000000";
			const byLink = timeRepeated(() =>
				repo.idsByLink([anchor], "brainstorm/ref/next", LinkDirection.Out),
			);
			const ftsCommon = timeRepeated(() => indexer.query({ text: "alpha", limit: 50 }));
			const ftsTwoTerm = timeRepeated(() => indexer.query({ text: "alpha beta", limit: 50 }));
			const ftsRare = timeRepeated(() => indexer.query({ text: "quintessence", limit: 50 }));
			const ftsTyped = timeRepeated(() =>
				indexer.query({ text: "alpha", types: ["io.brainstorm.notes/Note/v1"], limit: 50 }),
			);

			// Worst (highest p50 / p99) across the FTS shapes is what the budget
			// must hold against.
			const ftsShapes = [ftsCommon, ftsTwoTerm, ftsRare, ftsTyped];
			const worstP50 = Math.max(...ftsShapes.map((s) => s.p50));
			const worstP99 = Math.max(...ftsShapes.map((s) => s.p99));

			console.log(
				[
					"",
					`[stress:100k] corpus=${corpus.length} entities`,
					`  insert: ${insertMs.toFixed(0)}ms total (${(insertMs / corpus.length).toFixed(4)}ms/row)`,
					`  links : ${linkMs.toFixed(0)}ms total (${corpus.length - 1} links)`,
					`  index : ${indexMs.toFixed(0)}ms total (${(indexMs / corpus.length).toFixed(4)}ms/entity)`,
					`  query[by-type]   ${fmt(byType)}`,
					`  query[by-link]   ${fmt(byLink)}`,
					`  fts[common]      ${fmt(ftsCommon)}`,
					`  fts[two-term]    ${fmt(ftsTwoTerm)}`,
					`  fts[rare]        ${fmt(ftsRare)}`,
					`  fts[type-filter] ${fmt(ftsTyped)}`,
					`  budget: FTS p50<${FTS_P50_BUDGET_MS}ms (worst ${worstP50.toFixed(2)}ms) · p99<${FTS_P99_BUDGET_MS}ms (worst ${worstP99.toFixed(2)}ms)`,
					`  asserting with x${CI_SLACK} CI slack → p50<${(FTS_P50_BUDGET_MS * CI_SLACK).toFixed(0)}ms p99<${(FTS_P99_BUDGET_MS * CI_SLACK).toFixed(0)}ms`,
				].join("\n"),
			);

			// Sanity: the queries actually returned something (an always-empty
			// query would measure nothing meaningful).
			expect(repo.query({ type: "io.brainstorm.notes/Note/v1", limit: 1 }).length).toBe(1);
			expect(indexer.query({ text: "alpha", limit: 1 }).length).toBeGreaterThan(0);

			// Budget assertions with CI-safe slack — the raw numbers above are
			// the real signal; this guards against an order-of-magnitude
			// regression on any runner.
			expect(worstP50, "FTS p50 regressed past the slack budget").toBeLessThan(
				FTS_P50_BUDGET_MS * CI_SLACK,
			);
			expect(worstP99, "FTS p99 regressed past the slack budget").toBeLessThan(
				FTS_P99_BUDGET_MS * CI_SLACK,
			);
		},
	);
});

describe("stress: 50MB Yjs doc (ydoc-store snapshot+tail)", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-stress-ydoc-"));
	});
	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it(
		`builds a ~${(YDOC_TARGET_BYTES / ONE_MIB).toFixed(0)}MB Y.Doc, persists via tail, verifies CRC + compaction`,
		{ timeout: 600_000 },
		async () => {
			// A large compact threshold so we control compaction explicitly and
			// can measure the steady-state append→persist cost without it tripping
			// every write.
			const store = new YDocStore(vaultDir, { compactThresholdBytes: 64 * ONE_MIB });
			const entityId = "stress-doc-0001";

			const doc = new Y.Doc();
			const text = doc.getText("body");

			// Grow the doc by appending chunks of text, persisting each delta as a
			// tail entry through the production append path. Measure the per-update
			// persist latency (the doc-18 "Y.Doc update → durable on disk" budget,
			// <50ms p99).
			const CHUNK = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(64);
			const persistSamples: number[] = [];
			let onDiskBytes = 0;
			let updates = 0;

			while (onDiskBytes < YDOC_TARGET_BYTES) {
				const before = Y.encodeStateVector(doc);
				doc.transact(() => {
					text.insert(text.length, CHUNK);
				});
				const update = Y.encodeStateAsUpdate(doc, before);
				const t0 = now();
				onDiskBytes = await store.appendUpdate(entityId, update);
				persistSamples.push(now() - t0);
				updates += 1;
				// Hard cap so a pathological loop can't run forever.
				if (updates > 2_000_000) break;
			}

			const persistStats = summarize(persistSamples);

			// Reload from disk: every tail entry's CRC must verify (no truncation),
			// and the reloaded doc must equal the in-memory one byte-for-byte.
			const loadStart = now();
			const loaded = await store.load(entityId);
			const loadMs = now() - loadStart;

			expect(loaded.truncatedTail, "a tail entry failed CRC on reload").toBe(false);
			expect(loaded.tailEntries).toBe(updates);
			const expected = Y.encodeStateAsUpdate(doc);
			const actual = Y.encodeStateAsUpdate(loaded.doc);
			expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);

			// Compaction: fold the tail into a single snapshot, then verify the
			// compacted file still reloads to the same state and carries no tail.
			const compactStart = now();
			const compactedBytes = await store.compact(entityId);
			const compactMs = now() - compactStart;
			const afterCompact = await store.load(entityId);
			expect(afterCompact.tailEntries).toBe(0);
			expect(Buffer.from(Y.encodeStateAsUpdate(afterCompact.doc)).equals(Buffer.from(expected))).toBe(
				true,
			);

			// The documented 256 KiB threshold actually fires `appendAndMaybeCompact`.
			const thresholdStore = new YDocStore(vaultDir);
			const thresholdId = "stress-doc-threshold";
			let compactedAtLeastOnce = false;
			let sizeAtCompaction = 0;
			const thresholdDoc = new Y.Doc();
			const thresholdText = thresholdDoc.getText("body");
			for (let i = 0; i < 4000 && !compactedAtLeastOnce; i += 1) {
				const before = Y.encodeStateVector(thresholdDoc);
				thresholdDoc.transact(() => {
					thresholdText.insert(thresholdText.length, CHUNK);
				});
				const update = Y.encodeStateAsUpdate(thresholdDoc, before);
				const res = await thresholdStore.appendAndMaybeCompact(thresholdId, update);
				if (res.compacted) {
					compactedAtLeastOnce = true;
					sizeAtCompaction = res.size;
				}
			}

			console.log(
				[
					"",
					`[stress:ydoc] entity=${entityId}`,
					`  built : ${(onDiskBytes / ONE_MIB).toFixed(2)}MB on disk over ${updates} tail updates`,
					`  persist/update: p50=${persistStats.p50.toFixed(2)}ms p99=${persistStats.p99.toFixed(2)}ms max=${persistStats.max.toFixed(2)}ms (budget <50ms p99)`,
					`  reload: ${loadMs.toFixed(0)}ms (CRC verified, ${loaded.tailEntries} entries)`,
					`  compact: ${compactMs.toFixed(0)}ms → ${(compactedBytes / ONE_MIB).toFixed(2)}MB single snapshot`,
					`  threshold(${(DEFAULT_COMPACT_THRESHOLD / 1024).toFixed(0)}KiB): compacted=${compactedAtLeastOnce} at ${(sizeAtCompaction / 1024).toFixed(1)}KiB`,
				].join("\n"),
			);

			expect(onDiskBytes).toBeGreaterThanOrEqual(YDOC_TARGET_BYTES);
			expect(compactedAtLeastOnce, "256 KiB tail threshold never tripped compaction").toBe(true);
			// Per-update persist latency p99 budget, with CI slack.
			expect(persistStats.p99, "Y.Doc update→persist p99 regressed").toBeLessThan(50 * CI_SLACK);
		},
	);
});

describe("stress: 1k-cell layout (Layout/v1 validate + resolve)", () => {
	/** Build a `Layout/v1` with `cellCount` cells split across `groupCount`
	 *  groups (mirrors a dense form-designer / dashboard layout). */
	function buildLayout(cellCount: number, groupCount: number): LayoutDef {
		const perGroup = Math.ceil(cellCount / groupCount);
		const groups: LayoutCell[] = [];
		let made = 0;
		for (let g = 0; g < groupCount && made < cellCount; g += 1) {
			const children: LayoutCell[] = [];
			for (let c = 0; c < perGroup && made < cellCount; c += 1) {
				children.push({
					kind: LayoutCellKind.Property,
					id: `cell-${made}`,
					property: `field_${made}`,
				});
				made += 1;
			}
			groups.push({ kind: LayoutCellKind.Group, id: `group-${g}`, cells: children });
		}
		return {
			mode: LayoutMode.Stacked,
			scope: { kind: "type", target: "io.brainstorm.form/Form/v1" },
			context: LayoutContext.Full,
			cells: groups,
		};
	}

	it("validates + resolves a 1000-cell layout under budget", () => {
		const layout = buildLayout(1000, 50);

		const validateStats = timeRepeated(() => validateLayout(layout));
		expect(validateLayout(layout)).toEqual([]);

		// The id universe the resolver/reading-order machinery walks — groups +
		// leaves; assert the layout really is ~1k cells.
		const ids = collectCellIds(layout.cells);
		expect(ids.length).toBeGreaterThanOrEqual(1000);

		// Resolution picks the winner from a stack of candidate layouts at every
		// scope tier (the worst case the resolver sees per render).
		const candidates = [
			{ layout, updatedAt: 3 },
			{
				layout: { ...layout, scope: { kind: "user", target: "u1" } as const },
				updatedAt: 2,
			},
			{
				layout: { ...layout, scope: { kind: "org", target: "o1" } as const },
				updatedAt: 1,
			},
		];
		const target = {
			entityId: "ent-1",
			types: ["io.brainstorm.form/Form/v1"],
			userId: "u1",
			orgId: "o1",
			context: LayoutContext.Full,
		};
		const resolveStats = timeRepeated(() => resolveLayout(target, candidates));
		const resolved = resolveLayout(target, candidates);
		expect(resolved.source).toBe("scope");

		console.log(
			[
				"",
				`[stress:layout] cells=${ids.length}`,
				`  validate ${fmt(validateStats)}`,
				`  resolve  ${fmt(resolveStats)}`,
			].join("\n"),
		);

		// A 1k-cell validate+resolve is a single-render operation; it must stay
		// well under one frame (16ms) even with generous CI slack.
		expect(validateStats.p99, "1k-cell layout validate too slow").toBeLessThan(16 * CI_SLACK);
		expect(resolveStats.p99, "1k-cell layout resolve too slow").toBeLessThan(16 * CI_SLACK);
	});
});
