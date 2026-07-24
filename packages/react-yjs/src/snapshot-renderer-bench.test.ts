/**
 * Renderer-side half of the snapshot bench (the main-process half lives in
 * `packages/shell/src/main/integration/snapshot-bench.test.ts`, which showed
 * the SQL + assembly costs only ~8ms at the dogfood vault's real size — so the
 * cost that makes the app feel slow has to be downstream of main).
 *
 * This measures what a RENDERER pays for one refresh of a 3,175-entity vault:
 *
 *   - **parse**: turning the IPC payload back into objects (structured clone
 *     is not JSON, but it is the same order of work and is measurable here);
 *   - **equals**: `vaultSnapshotEquals` — run on EVERY reload, including the
 *     (common) case where nothing actually changed. Its cost is the price of
 *     *not* re-rendering, so it wants to be much cheaper than a render;
 *   - **derive**: the O(n) passes apps run over the whole snapshot on every
 *     delivered change (filter-by-type is the near-universal one).
 *
 * And the behaviour that multiplies all of it: how many reloads a burst of
 * change signals actually produces.
 */

import type { VaultEntitiesSnapshot } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createQueryStore } from "./query-store";
import { vaultSnapshotEquals } from "./vault-entities";

const SEEDED_VAULT = 3_175;
const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);

function makeSnapshot(count: number): VaultEntitiesSnapshot {
	const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);
	const entities = Array.from({ length: count }, (_, i) => ({
		id: `ent_bench_${i}`,
		type: i % 3 === 0 ? "brainstorm/Iteration/v1" : "io.brainstorm.notes/Note/v1",
		properties: { title: `Bench entity ${i}`, body, status: i % 2 === 0 ? "done" : "todo" },
		createdAt: 1_700_000_000_000 + i,
		updatedAt: 1_700_000_000_000 + i,
		deletedAt: null,
		ownerAppId: "io.brainstorm.bench",
	}));
	return { entities, links: [] } as unknown as VaultEntitiesSnapshot;
}

describe("renderer cost of one vault snapshot refresh", () => {
	it("measures parse + equals + derive at the dogfood vault's size", () => {
		const snapshot = makeSnapshot(SEEDED_VAULT);
		const wire = JSON.stringify(snapshot);

		const parseStart = now();
		const parsed = JSON.parse(wire) as VaultEntitiesSnapshot;
		const parseMs = now() - parseStart;

		// The unchanged case: same content, different object identity — exactly
		// what a reload produces when nothing was edited.
		const equalsStart = now();
		const same = vaultSnapshotEquals(parsed, JSON.parse(wire) as VaultEntitiesSnapshot);
		const equalsMs = now() - equalsStart;

		// The pass nearly every app runs on every delivery.
		const deriveStart = now();
		const notes = parsed.entities.filter((e) => e.type === "io.brainstorm.notes/Note/v1");
		const deriveMs = now() - deriveStart;

		console.log(
			`[renderer-bench] ${SEEDED_VAULT} entities (${(wire.length / 1_048_576).toFixed(2)}MB) → parse ${parseMs}ms · equals ${equalsMs}ms · filter-by-type ${deriveMs}ms (${notes.length} rows)`,
		);

		expect(same).toBe(true);
		expect(notes.length).toBeGreaterThan(0);
	});

	it("collapses a burst of change signals into ONE reload", async () => {
		vi.useFakeTimers();
		try {
			const snapshot = makeSnapshot(200);
			const load = vi.fn(async () => snapshot);
			let fire: (() => void) | null = null;
			const store = createQueryStore<VaultEntitiesSnapshot>({
				subscribe: (onChange) => {
					fire = onChange;
					return () => undefined;
				},
				load,
				initial: { entities: [], links: [] } as unknown as VaultEntitiesSnapshot,
				equals: vaultSnapshotEquals,
			});
			store.subscribe(() => undefined);
			await vi.runAllTimersAsync();
			const afterBind = load.mock.calls.length;

			// 50 writes in quick succession — a seed drain, a sync burst, a
			// paste. Every one of them signals every open app.
			for (let i = 0; i < 50; i += 1) fire?.();
			await vi.runAllTimersAsync();

			const burstReloads = load.mock.calls.length - afterBind;
			console.log(
				`[renderer-bench] 50 change signals → ${burstReloads} reload(s) (trailing debounce; each reload costs a full snapshot per app)`,
			);
			expect(burstReloads).toBe(1);
			store.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does NOT notify subscribers when the reloaded snapshot is unchanged", async () => {
		vi.useFakeTimers();
		try {
			const snapshot = makeSnapshot(200);
			// A fresh object every load — the realistic case (IPC always returns
			// new objects), so identity can never short-circuit.
			const load = vi.fn(async () => JSON.parse(JSON.stringify(snapshot)));
			let fire: (() => void) | null = null;
			const store = createQueryStore<VaultEntitiesSnapshot>({
				subscribe: (onChange) => {
					fire = onChange;
					return () => undefined;
				},
				load,
				initial: { entities: [], links: [] } as unknown as VaultEntitiesSnapshot,
				equals: vaultSnapshotEquals,
			});
			let notifications = 0;
			store.subscribe(() => {
				notifications += 1;
			});
			await vi.runAllTimersAsync();
			const afterFirst = notifications;

			for (let i = 0; i < 5; i += 1) {
				fire?.();
				await vi.runAllTimersAsync();
			}

			console.log(
				`[renderer-bench] 5 no-op reloads → ${notifications - afterFirst} re-render notification(s) (the comparator is what stops a reload becoming a render)`,
			);
			expect(notifications - afterFirst).toBe(0);
			store.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
});
