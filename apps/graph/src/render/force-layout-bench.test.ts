/**
 * NAPI-P candidate 1 — graph force simulation, the only superlinear path in the
 * territory map and the sole gate on NAPI-4.
 *
 * The rung's question is narrow and answerable: **does warm-tick cost exceed
 * budget on a dense graph?** NAPI-4 (porting `tickLayout` to Rust) is worth
 * doing only if it does. The plan's own estimate is ~100–200 ms/s at n=600, and
 * the layout driver targets a warm tick budget below that; anything comfortably
 * inside means the port buys nothing and the rung closes as a no-op.
 *
 * Measurement notes, so the numbers mean something:
 *   - `tickLayout` is PURE (nodes mutated in place, no DOM, no worker), so an
 *     in-process bench measures exactly what the worker would run.
 *   - Cost is O(n²) in the repulsion pass, so n is the only axis that matters;
 *     edges scale linearly and are held at a realistic 2× density.
 *   - Ticks are measured WARM (after a preconverge burn-in), because that is
 *     the steady state a user sees. Cold first-tick cost is irrelevant to the
 *     drag/settle experience.
 *   - Assertions are order-of-magnitude guards, not budgets — the LOGGED
 *     figures are the deliverable, same discipline as `stress.test.ts` and the
 *     snapshot benches. A tightened assertion here would just become a flaky
 *     CI gate on shared-runner noise.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_LAYOUT_PARAMS,
	type LayoutEdge,
	type LayoutNode,
	seedPositions,
	tickLayout,
} from "./force-layout";

/** Deterministic scale-free-ish graph: every node links to ~2 earlier nodes, so
 *  degree is skewed like a real vault rather than uniform. */
function buildGraph(nodeCount: number, seed = 7): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
	const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
	const nodes = seedPositions(ids, DEFAULT_LAYOUT_PARAMS, seed);
	const edges: LayoutEdge[] = [];
	let rng = seed;
	const next = (): number => {
		rng = (rng * 1664525 + 1013904223) % 4294967296;
		return rng / 4294967296;
	};
	for (let i = 1; i < nodeCount; i += 1) {
		const linkCount = i < 3 ? 1 : 2;
		for (let k = 0; k < linkCount; k += 1) {
			const target = Math.floor(next() * i);
			edges.push({ source: ids[i] as string, target: ids[target] as string });
		}
	}
	return { nodes, edges };
}

/** Median is the honest summary for per-frame cost — a single GC pause in a
 *  sampled mean reads as a regression that no user would feel. */
function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
		: (sorted[mid] as number);
}

function measureWarmTick(nodeCount: number): {
	medianMs: number;
	p95Ms: number;
	perSecondMs: number;
} {
	const { nodes, edges } = buildGraph(nodeCount);
	// Burn-in: reach the steady state a user actually interacts with.
	for (let i = 0; i < 40; i += 1) tickLayout(nodes, edges, DEFAULT_LAYOUT_PARAMS, 0.3);
	const samples: number[] = [];
	for (let i = 0; i < 30; i += 1) {
		const started = performance.now();
		tickLayout(nodes, edges, DEFAULT_LAYOUT_PARAMS, 0.3);
		samples.push(performance.now() - started);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const med = median(samples);
	return {
		medianMs: med,
		p95Ms: sorted[Math.floor(sorted.length * 0.95)] as number,
		// A settling graph ticks at animation rate; 60/s is the worst case the
		// driver would ask for. This is the number the plan's "~100–200 ms/s"
		// estimate is expressed in.
		perSecondMs: med * 60,
	};
}

describe("NAPI-P · graph force-sim warm-tick cost", () => {
	it("measures warm tick across the node counts that matter", () => {
		const rows = [200, 600, 1000, 2000].map((n) => ({ n, ...measureWarmTick(n) }));
		for (const r of rows) {
			console.log(
				`[napi-p/force-layout] n=${String(r.n).padStart(4)} ` +
					`median ${r.medianMs.toFixed(3)}ms · p95 ${r.p95Ms.toFixed(3)}ms ` +
					`· ${r.perSecondMs.toFixed(1)}ms per animated second (60 ticks/s)`,
			);
		}
		// The 600-node row is the one that gates NAPI-4.
		const at600 = rows.find((r) => r.n === 600);
		expect(at600).toBeDefined();
		// Order-of-magnitude guard only: a single tick at the documented soft cap
		// must not cost a whole frame budget (16.7ms). If this ever fails, the
		// NAPI-4 port is back on the table and the gap is right here in the log.
		expect((at600 as { medianMs: number }).medianMs).toBeLessThan(16.7);
	});

	it("confirms the cost really is superlinear (so the ranking was right)", () => {
		// The rung calls this "the only superlinear path". Worth verifying rather
		// than inheriting: if it were linear, n=2000 would be ~3.3× n=600.
		const a = measureWarmTick(600).medianMs;
		const b = measureWarmTick(2000).medianMs;
		const ratio = b / Math.max(a, 0.0001);
		console.log(
			`[napi-p/force-layout] n=600 → n=2000 cost ratio ${ratio.toFixed(2)}× ` +
				`(linear would be ~3.3×, quadratic ~11×)`,
		);
		expect(ratio).toBeGreaterThan(3.3);
	});
});
