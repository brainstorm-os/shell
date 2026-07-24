/**
 * `vaultEntities.list()` snapshot bench — the measurement behind "the app got
 * slow once the vault filled up".
 *
 * Every app reads the vault through ONE call: `vaultEntities.list()` returns
 * the **whole** snapshot (entities + links), and the renderer re-fetches it
 * whenever the coarse change signal fires. So the cost every app pays on every
 * refresh is a function of TOTAL VAULT SIZE, not of what that app can use —
 * a Notes window pays for 839 plan Iterations it will never render.
 *
 * This harness measures that cost at the sizes that actually occur, in-process
 * over a real `entities.db` (the same `bun:sqlite` path the stress harness
 * uses, no Electron):
 *
 *   - **build**: `listVaultEntities` — the SQL + assembly in main.
 *   - **serialize**: `JSON.stringify` of the snapshot, a proxy for the
 *     structured-clone the IPC boundary pays per app, per refresh.
 *   - **payload**: what crosses that boundary, in MB.
 *
 * The numbers print, so a run is a live before/after record (same discipline
 * as `stress.test.ts`). Assertions are deliberately loose — they catch an
 * order-of-magnitude regression, not machine variance; the logged figures are
 * the signal.
 *
 * Sizes: 3,175 is the real dogfood vault after the plan projection landed;
 * 10,000 is the near-term shape if projections keep growing.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listVaultEntities } from "../entities/vault-entities-service";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";

/** The dogfood vault's real size after the BrainstormProject projection. */
const SEEDED_VAULT = 3_175;
/** Where the same projection lands if it keeps growing. */
const GROWTH_CASE = 10_000;

/** Generous ceilings — an order-of-magnitude guard, not a budget. */
const BUILD_CEILING_MS = 4_000;
const SERIALIZE_CEILING_MS = 4_000;

const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);

/** A row shaped like the projection's: a title, a paragraph of body, and a
 *  handful of properties — ~1.2 KB serialized, matching the measured average. */
function seedRows(repo: EntitiesRepository, count: number): void {
	const body = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);
	repo.transaction(() => {
		for (let i = 0; i < count; i += 1) {
			repo.create({
				id: `ent_bench_${i}`,
				type: i % 3 === 0 ? "brainstorm/Iteration/v1" : "io.brainstorm.notes/Note/v1",
				properties: {
					title: `Bench entity ${i}`,
					body,
					status: i % 2 === 0 ? "done" : "todo",
					code: `9.${i % 30}.${i % 7}`,
					createdAt: 1_700_000_000_000 + i,
					updatedAt: 1_700_000_000_000 + i,
				},
				createdBy: "io.brainstorm.bench",
				now: 1_700_000_000_000 + i,
				dekId: null,
			});
		}
	});
}

describe("vaultEntities.list() — full-snapshot cost by vault size", () => {
	let vaultDir = "";
	let stores: DataStores;
	let repo: EntitiesRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-snapshot-bench-"));
		stores = new DataStores(vaultDir);
		repo = new EntitiesRepository(await stores.open("entities"));
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	for (const size of [SEEDED_VAULT, GROWTH_CASE]) {
		it(
			`costs what it costs at ${size} entities (the number every app pays per refresh)`,
			{ timeout: 300_000 },
			async () => {
				seedRows(repo, size);

				const getRepo = async () => repo as never;
				// Warm once: the first call pays statement preparation.
				await listVaultEntities(vaultDir, getRepo, undefined);

				const buildStart = now();
				const snapshot = await listVaultEntities(vaultDir, getRepo, undefined);
				const buildMs = now() - buildStart;

				const serializeStart = now();
				const wire = JSON.stringify(snapshot);
				const serializeMs = now() - serializeStart;
				const payloadMb = wire.length / 1_048_576;

				console.log(
					`[snapshot-bench] ${size} entities → build ${buildMs}ms · serialize ${serializeMs}ms · payload ${payloadMb.toFixed(2)}MB · per-app-per-refresh ${(buildMs + serializeMs).toFixed(0)}ms`,
				);

				expect(snapshot.entities.length).toBe(size);
				expect(buildMs).toBeLessThan(BUILD_CEILING_MS);
				expect(serializeMs).toBeLessThan(SERIALIZE_CEILING_MS);
			},
		);
	}

	it("shows what a capability-scoped snapshot would save a single-type app", async () => {
		seedRows(repo, SEEDED_VAULT);
		const getRepo = async () => repo as never;
		const full = await listVaultEntities(vaultDir, getRepo, undefined);

		// What a Notes window can actually use: its own type. Everything else in
		// the snapshot is cost with no consumer — the case for scoping the
		// snapshot to the caller's `entities.read:<type>` grants.
		const usable = full.entities.filter((e) => e.type === "io.brainstorm.notes/Note/v1");
		const fullBytes = JSON.stringify(full).length;
		const usableBytes = JSON.stringify({ entities: usable, links: full.links }).length;
		const waste = 1 - usableBytes / fullBytes;

		console.log(
			`[snapshot-bench] a Notes window receives ${full.entities.length} entities (${(fullBytes / 1_048_576).toFixed(2)}MB) to use ${usable.length} (${(usableBytes / 1_048_576).toFixed(2)}MB) — ${(waste * 100).toFixed(0)}% of the payload has no consumer`,
		);

		expect(usable.length).toBeLessThan(full.entities.length);
	});
});
