import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryPrincipalKind, VersionCause } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../storage/data-stores";
import {
	EntitiesRepository,
	EntityVersionsRepository,
	HistoryChangeSetsRepository,
} from "../storage/entities-repo";
import type { HistFrameRef } from "../storage/yhist-store";
import { DAY_MS, defaultRetentionPolicy } from "./retention-policy";
import { RETENTION_DELETE_CHUNK, RETENTION_SCAN_PAGE, VersionHistory } from "./version-history";

const NOW = 1_800_000_000_000;
const FRAME = 51_200;

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-history-retention-"));
	const dataStores = new DataStores(vaultDir);
	const db = await dataStores.open("entities");
	const stores = {
		entities: new EntitiesRepository(db),
		versions: new EntityVersionsRepository(db),
		changeSets: new HistoryChangeSetsRepository(db),
	};
	return { vaultDir, dataStores, db, stores };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** `entities` × `perEntity` Idle checkpoints spread over 60 days, each with
 *  its own 50 KB frame — enough that the default cap is crossed. */
function seed(env: Env, entities: number, perEntity: number): void {
	let seq = 0;
	env.db.transaction(() => {
		for (let e = 0; e < entities; e += 1) {
			const id = `ent_${e.toString(36).padStart(6, "0")}`;
			env.stores.entities.create({
				id,
				type: "io.x/Note/v1",
				properties: { title: `n${e}` },
				createdBy: "io.x",
				now: NOW - 90 * DAY_MS,
				dekId: null,
			});
			for (let k = 0; k < perEntity; k += 1) {
				seq += 1;
				const at = NOW - Math.floor(((perEntity - k) * 60 * DAY_MS) / perEntity);
				env.stores.versions.insert({
					versionId: `ver_${seq.toString(36).padStart(8, "0")}`,
					entityId: id,
					at,
					cause: VersionCause.Idle,
					changeSetId: null,
					principals: [{ kind: HistoryPrincipalKind.Member, id: "self", lastWriteAt: at }],
					frameOffset: 8 + k * (FRAME + 8),
					frameLength: FRAME,
					stateKey: `sk${k}`,
					properties: { title: `n${e}`, body: "p".repeat(300) },
				});
			}
		}
	})();
}

describe("VersionHistory retention pass (10.16 perf)", () => {
	let env: Env;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.dataStores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("deletes in bounded transactions and yields between every step", async () => {
		const ENTITIES = 1200;
		const PER = 10;
		seed(env, ENTITIES, PER);
		const deleteSizes: number[] = [];
		const origDelete = env.stores.versions.deleteMany.bind(env.stores.versions);
		env.stores.versions.deleteMany = (ids) => {
			deleteSizes.push(ids.length);
			return origDelete(ids);
		};
		let transactions = 0;
		const origTx = env.db.transaction.bind(env.db);
		env.db.transaction = <T>(fn: () => T) => {
			const run = origTx(fn);
			return () => {
				transactions += 1;
				return run();
			};
		};
		const yields: string[] = [];
		let phase = "scan";
		const compacted = new Map<string, HistFrameRef[]>();
		const history = new VersionHistory({
			getStores: async () => env.stores,
			worker: {
				capture: async () => ({ captured: false, stateKey: "" }),
				preview: async () => ({ bodyText: "", properties: null }),
				compact: async (entityId, keep) => {
					phase = "compact";
					compacted.set(entityId, [...keep]);
					return keep.map((ref, i) => [ref.offset, 8 + i * (FRAME + 8)] as [number, number]);
				},
			},
			getRestorer: () => null,
			getPolicy: async () => {
				phase = "plan";
				return defaultRetentionPolicy(0);
			},
			now: () => NOW,
			yieldToEventLoop: async () => {
				yields.push(phase);
			},
		});

		const dropped = await history.prune();
		const rows = ENTITIES * PER;
		expect(dropped).toBeGreaterThan(0);
		expect(deleteSizes.reduce((a, b) => a + b, 0)).toBe(dropped);
		expect(Math.max(...deleteSizes)).toBeLessThanOrEqual(RETENTION_DELETE_CHUNK);
		expect(deleteSizes.length).toBeGreaterThanOrEqual(Math.ceil(dropped / RETENTION_DELETE_CHUNK));
		// One transaction per delete chunk plus one per rewritten entity — never
		// one vault-wide transaction.
		expect(transactions).toBe(deleteSizes.length + compacted.size);
		expect(yields.filter((p) => p === "scan").length).toBe(Math.floor(rows / RETENTION_SCAN_PAGE));
		// The plan's own pauses plus one after every delete chunk and every
		// scan-page's worth of candidates walked.
		expect(yields.filter((p) => p === "plan").length).toBeGreaterThanOrEqual(
			deleteSizes.length + Math.floor(rows / RETENTION_SCAN_PAGE),
		);
		expect(yields.filter((p) => p === "compact").length).toBe(compacted.size);
		expect(compacted.size).toBe(ENTITIES);

		// The keep set handed to the worker is exactly each entity's surviving
		// frames, in row order, and the rows now point at the relocated offsets.
		for (const [entityId, keep] of compacted) {
			const left = env.stores.versions.listByEntity(entityId);
			expect(left.length).toBe(keep.length);
			expect(left.length).toBeGreaterThanOrEqual(1);
			const offsets = new Set(left.map((r) => r.frameOffset));
			expect(offsets.size).toBe(left.length);
			expect(Math.max(...offsets)).toBe(8 + (keep.length - 1) * (FRAME + 8));
		}
		history.dispose();
	});

	it("stops touching the vault once disposed mid-pass", async () => {
		seed(env, 600, 10);
		let steps = 0;
		const history = new VersionHistory({
			getStores: async () => env.stores,
			worker: {
				capture: async () => ({ captured: false, stateKey: "" }),
				preview: async () => ({ bodyText: "", properties: null }),
				compact: async (_id, keep) => keep.map((ref) => [ref.offset, ref.offset] as [number, number]),
			},
			getRestorer: () => null,
			getPolicy: async () => defaultRetentionPolicy(0),
			now: () => NOW,
			yieldToEventLoop: async () => {
				steps += 1;
				if (steps === 3) history.dispose();
			},
		});
		await expect(history.prune()).rejects.toMatchObject({ name: "Unavailable" });
		expect(steps).toBe(3);
		expect(env.stores.versions.listByEntity("ent_000000")).toHaveLength(10);
	});
});
