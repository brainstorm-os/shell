/**
 * Stage 10.3c — the pairing-completion backfill.
 *
 * The ongoing producer only fires on DEK install, so it reaches entities
 * created AFTER pairing. Without this pass, everything written before the
 * second device existed stays stranded forever: the new device syncs new
 * notes and never sees a single old one.
 */

import { describe, expect, it, vi } from "vitest";
import { BACKFILL_YIELD_EVERY, backfillWrapsForSiblings } from "./wrap-backfill";

function deps(overrides: Partial<Parameters<typeof backfillWrapsForSiblings>[0]> = {}) {
	const closed: Uint8Array[] = [];
	return {
		closed,
		args: {
			listCandidates: () => [{ entityId: "ent_1", type: "brainstorm/Note/v1" }, { entityId: "ent_2" }],
			openDek: (id: string) => ({ dek: new Uint8Array(32).fill(id.length), version: 2 }),
			closeDek: (dek: Uint8Array) => {
				closed.push(dek);
			},
			fanOut: async () => ({ sent: 1, failed: [] }),
			...overrides,
		} as Parameters<typeof backfillWrapsForSiblings>[0],
	};
}

describe("backfillWrapsForSiblings", () => {
	it("fans out every existing entity, not just new ones", async () => {
		const { args } = deps();
		const result = await backfillWrapsForSiblings(args);
		expect(result.scanned).toBe(2);
		expect(result.delivered).toBe(2);
		expect(result.aborted).toBe(false);
	});

	it("always zeroes the DEK, including when the fan-out throws", async () => {
		const { args, closed } = deps({
			fanOut: async () => {
				throw new Error("relay exploded");
			},
		});
		const result = await backfillWrapsForSiblings(args);
		expect(result.failed).toBe(2);
		expect(closed).toHaveLength(2); // both handles closed despite throwing
	});

	it("keeps going after one entity fails — a partial pass beats an aborted one", async () => {
		let calls = 0;
		const { args } = deps({
			listCandidates: () => [{ entityId: "a" }, { entityId: "b" }, { entityId: "c" }],
			fanOut: async () => {
				calls += 1;
				if (calls === 2) throw new Error("nope");
				return { sent: 1, failed: [] };
			},
		});
		const result = await backfillWrapsForSiblings(args);
		expect(result.scanned).toBe(3);
		expect(result.delivered).toBe(2);
		expect(result.failed).toBe(1);
	});

	it("skips an entity with no DEK rather than failing the pass", async () => {
		const { args } = deps({ openDek: () => null });
		const result = await backfillWrapsForSiblings(args);
		expect(result.skipped).toBe(2);
		expect(result.failed).toBe(0);
	});

	it("counts an offline pass as skipped, not failed", async () => {
		// `null` is "no relay / no siblings" — an offline backfill must not
		// look like a broken one.
		const { args } = deps({ fanOut: async () => null });
		const result = await backfillWrapsForSiblings(args);
		expect(result.failed).toBe(0);
		expect(result.skipped).toBe(2);
	});

	it("stops at an abort signal and says so", async () => {
		const signal = { aborted: false };
		const { args } = deps({
			listCandidates: () => Array.from({ length: 10 }, (_, i) => ({ entityId: `e${i}` })),
			fanOut: async () => {
				signal.aborted = true; // abort after the first entity
				return { sent: 1, failed: [] };
			},
			signal,
		});
		const result = await backfillWrapsForSiblings(args);
		expect(result.aborted).toBe(true);
		expect(result.scanned).toBe(1);
	});

	it("reports progress so a long pass is not a frozen bar", async () => {
		const onProgress = vi.fn();
		const { args } = deps({ onProgress });
		await backfillWrapsForSiblings(args);
		expect(onProgress).toHaveBeenNthCalledWith(1, 1, 2);
		expect(onProgress).toHaveBeenNthCalledWith(2, 2, 2);
	});

	it("yields to the event loop on a vault larger than one batch", async () => {
		const n = BACKFILL_YIELD_EVERY * 2;
		const { args } = deps({
			listCandidates: () => Array.from({ length: n }, (_, i) => ({ entityId: `e${i}` })),
		});
		const result = await backfillWrapsForSiblings(args);
		expect(result.scanned).toBe(n);
	});
});
