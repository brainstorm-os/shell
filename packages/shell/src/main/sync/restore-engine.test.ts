import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "./relay-port";
import { RestoreEngine, type RestoreEngineContext } from "./restore-engine";

/**
 * Controllable stand-in for `LiveSyncEngine` — `trackForRestoreBatch`
 * optionally "lands the wrap" for each id (via `autoLand`), `restoredType`
 * reports it. The wrap→type→row-materialize integration over real crypto
 * lives in `live-sync-engine.test.ts`; here we drive the orchestration
 * (catalog → batch track → quiescence → summary → reindex) deterministically.
 */
class FakeEngine {
	readonly tracked: string[] = [];
	/** One entry per `trackForRestoreBatch` call — pins the 10.10 batching. */
	readonly batches: string[][] = [];
	readonly #restored = new Map<string, string>();
	autoLand: (id: string) => string | null = () => null;

	trackForRestoreBatch(ids: readonly string[]): void {
		this.batches.push([...ids]);
		for (const id of ids) {
			this.tracked.push(id);
			const type = this.autoLand(id);
			if (type) this.#restored.set(id, type);
		}
	}

	restoredType(id: string): string | null {
		return this.#restored.get(id) ?? null;
	}

	whenIdle(): Promise<unknown> {
		return Promise.resolve();
	}

	land(id: string, type: string): void {
		this.#restored.set(id, type);
	}
}

function makeCtx(
	engine: FakeEngine,
	entries: CatalogEntry[],
	overrides: Partial<RestoreEngineContext> = {},
): RestoreEngineContext {
	return {
		account: "acc-b64url",
		requestCatalog: async () => entries,
		engine,
		delay: async () => {},
		...overrides,
	};
}

describe("RestoreEngine (10.14)", () => {
	it("restores every catalog entry and reports complete", async () => {
		const engine = new FakeEngine();
		engine.autoLand = () => "brainstorm/Note/v1"; // backfill lands instantly
		const restore = new RestoreEngine(
			makeCtx(engine, [
				{ entityId: "e1", version: 1 },
				{ entityId: "e2", version: 4 },
			]),
		);
		const summary = await restore.restore();
		expect(summary).toEqual({
			requested: 2,
			restored: 2,
			entityIds: ["e1", "e2"],
			complete: true,
		});
		expect(engine.tracked).toEqual(["e1", "e2"]);
		// 10.10 — the whole catalog goes down in ONE batch call.
		expect(engine.batches).toEqual([["e1", "e2"]]);
	});

	it("resolves complete with nothing to do on an empty catalog", async () => {
		const engine = new FakeEngine();
		const restore = new RestoreEngine(makeCtx(engine, []));
		const summary = await restore.restore();
		expect(summary).toEqual({ requested: 0, restored: 0, entityIds: [], complete: true });
		expect(engine.tracked).toEqual([]);
	});

	it("returns a partial (complete:false) when some entities never come back", async () => {
		const engine = new FakeEngine();
		engine.autoLand = (id) => (id === "e1" ? "brainstorm/Note/v1" : null); // e2 stalls
		let clock = 0;
		const restore = new RestoreEngine(
			makeCtx(
				engine,
				[
					{ entityId: "e1", version: 1 },
					{ entityId: "e2", version: 1 },
				],
				{
					quietMs: 1_500,
					nowMs: () => {
						clock += 1_000;
						return clock;
					},
				},
			),
		);
		const summary = await restore.restore();
		expect(summary.requested).toBe(2);
		expect(summary.restored).toBe(1);
		expect(summary.entityIds).toEqual(["e1"]);
		expect(summary.complete).toBe(false);
	});

	it("reports progress as entities settle", async () => {
		const engine = new FakeEngine();
		engine.autoLand = () => "brainstorm/Task/v1";
		const progress: number[] = [];
		const restore = new RestoreEngine(
			makeCtx(engine, [{ entityId: "e1", version: 1 }], {
				onProgress: (p) => progress.push(p.restored),
			}),
		);
		await restore.restore();
		expect(progress.at(-1)).toBe(1);
	});

	it("refuses a concurrent restore pass", async () => {
		const engine = new FakeEngine();
		engine.autoLand = () => "brainstorm/Note/v1";
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const restore = new RestoreEngine(
			makeCtx(engine, [{ entityId: "e1", version: 1 }], {
				requestCatalog: async () => {
					await gate;
					return [{ entityId: "e1", version: 1 }];
				},
			}),
		);
		const first = restore.restore();
		await expect(restore.restore()).rejects.toThrow(/already running/);
		release();
		await first;
	});
});
