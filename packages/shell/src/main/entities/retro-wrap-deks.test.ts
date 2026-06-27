import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { EntityDekStore } from "./entity-dek-store";
import { retroWrapNullDeks } from "./retro-wrap-deks";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-retro-wrap-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const repo = new EntitiesRepository(db);
	const deks = new EntityDeksRepository(db);
	const masterKey = generateSymmetricKey();
	const dekStore = new EntityDekStore(deks, masterKey);
	return { vaultDir, stores, db, repo, deks, masterKey, dekStore };
}

/** Seed a live entity row with `dek_id = NULL` (the legacy shape). */
function seedLegacy(env: Awaited<ReturnType<typeof setup>>, id: string, now = 1): void {
	env.repo.create({
		id,
		type: "io.x/Note/v1",
		properties: { name: id },
		createdBy: "io.x",
		now,
		dekId: null,
	});
}

/** Seed a row already carrying a real dekId — wrap row pre-existing. */
function seedWrapped(env: Awaited<ReturnType<typeof setup>>, id: string, now = 1): string {
	const dekId = env.dekStore.nextDekId();
	env.repo.create({
		id,
		type: "io.x/Note/v1",
		properties: { name: id },
		createdBy: "io.x",
		now,
		dekId,
	});
	const h = env.dekStore.persist(id, dekId);
	env.dekStore.close(h.dek);
	return dekId;
}

describe("EntitiesRepository — listMissingDekIds + stampDekId", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("listMissingDekIds returns [] on an empty vault", () => {
		expect(env.repo.listMissingDekIds()).toEqual([]);
	});

	it("listMissingDekIds yields only live rows with dek_id IS NULL", () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		seedWrapped(env, "ent_c", 3);
		expect(env.repo.listMissingDekIds()).toEqual(["ent_a", "ent_b"]);
	});

	it("listMissingDekIds excludes soft-deleted rows (the Bin)", () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		env.repo.softDelete("ent_a", 99);
		expect(env.repo.listMissingDekIds()).toEqual(["ent_b"]);
	});

	it("listMissingDekIds orders by created_at then id (deterministic across runs)", () => {
		seedLegacy(env, "ent_b", 1);
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_c", 2);
		// At created_at=1, lex-order ties: ent_a < ent_b. ent_c later.
		expect(env.repo.listMissingDekIds()).toEqual(["ent_a", "ent_b", "ent_c"]);
	});

	it("stampDekId sets dek_id on a null-dek row + reports true", () => {
		seedLegacy(env, "ent_a", 1);
		expect(env.repo.stampDekId("ent_a", "dek_x")).toBe(true);
		const row = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_a") as {
			dek_id: string | null;
		};
		expect(row.dek_id).toBe("dek_x");
	});

	it("stampDekId is idempotent — a second stamp on a non-null row returns false", () => {
		seedLegacy(env, "ent_a", 1);
		expect(env.repo.stampDekId("ent_a", "dek_x")).toBe(true);
		expect(env.repo.stampDekId("ent_a", "dek_y")).toBe(false);
		const row = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_a") as {
			dek_id: string | null;
		};
		expect(row.dek_id).toBe("dek_x");
	});

	it("stampDekId returns false on a missing row", () => {
		expect(env.repo.stampDekId("ent_missing", "dek_x")).toBe(false);
	});

	it("stampDekId refuses to touch a soft-deleted row", () => {
		seedLegacy(env, "ent_a", 1);
		env.repo.softDelete("ent_a", 99);
		expect(env.repo.stampDekId("ent_a", "dek_x")).toBe(false);
	});
});

describe("retroWrapNullDeks", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("empty vault → wrapped 0 / skipped 0, idempotent", async () => {
		const a = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(a).toEqual({ wrapped: 0, skipped: 0 });
		const b = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(b).toEqual({ wrapped: 0, skipped: 0 });
	});

	it("skips shell-internal singletons with non-safe ids (never attempts a wrap)", async () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "brainstorm/root-folder/v1", 2);

		const wrapCalls: string[] = [];
		const r = await retroWrapNullDeks({
			repo: env.repo,
			dekStore: env.dekStore,
			installEntityWrap: async (id) => {
				wrapCalls.push(id);
			},
		});

		// Only the safe-id row is wrapped; the root-folder singleton is dropped
		// up front — never handed to installEntityWrap, so no `entityId must
		// match` throw and no skipped count.
		expect(r).toEqual({ wrapped: 1, skipped: 0 });
		expect(wrapCalls).toEqual(["ent_a"]);

		// The singleton row keeps its null dek_id (local-only, never syncs).
		const root = env.db
			.prepare("SELECT dek_id FROM entities WHERE id = ?")
			.get("brainstorm/root-folder/v1") as { dek_id: string | null };
		expect(root.dek_id).toBeNull();
	});

	it("wraps every null-dek row + leaves wrapped rows untouched", async () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		const dekC = seedWrapped(env, "ent_c", 3);

		const r = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(r).toEqual({ wrapped: 2, skipped: 0 });

		// All three rows now have a non-null dek_id.
		const rows = env.db.prepare("SELECT id, dek_id FROM entities ORDER BY id").all() as Array<{
			id: string;
			dek_id: string | null;
		}>;
		expect(rows.map((r) => r.id)).toEqual(["ent_a", "ent_b", "ent_c"]);
		for (const row of rows) {
			expect(row.dek_id).not.toBeNull();
			expect(row.dek_id?.length ?? 0).toBeGreaterThan(0);
		}
		// ent_c's dek_id was not rewritten (still the original wrap).
		const c = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_c") as {
			dek_id: string;
		};
		expect(c.dek_id).toBe(dekC);

		// Every entity now has exactly one entity_deks row.
		const dekCount = env.db.prepare("SELECT COUNT(*) AS n FROM entity_deks").get() as {
			n: number;
		};
		expect(dekCount.n).toBe(3);
	});

	it("second pass is a no-op (idempotent on a vault we just drained)", async () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		const first = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(first).toEqual({ wrapped: 2, skipped: 0 });
		const second = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(second).toEqual({ wrapped: 0, skipped: 0 });
		// Still one wrap row per entity (no duplicates).
		const dekCount = env.db.prepare("SELECT COUNT(*) AS n FROM entity_deks").get() as {
			n: number;
		};
		expect(dekCount.n).toBe(2);
	});

	it("excludes soft-deleted rows entirely (Bin items are not retro-wrapped)", async () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		env.repo.softDelete("ent_b", 99);

		const r = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		expect(r).toEqual({ wrapped: 1, skipped: 0 });

		// ent_b still has null dek_id; ent_a got wrapped.
		const a = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_a") as {
			dek_id: string | null;
		};
		const b = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_b") as {
			dek_id: string | null;
		};
		expect(a.dek_id).not.toBeNull();
		expect(b.dek_id).toBeNull();
	});

	it("wrap row carries the dek_id stamped on the entity row (joint integrity)", async () => {
		seedLegacy(env, "ent_a", 1);
		await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		const ent = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_a") as {
			dek_id: string;
		};
		const wrap = env.db
			.prepare("SELECT dek_id, entity_id FROM entity_deks WHERE entity_id = ?")
			.get("ent_a") as { dek_id: string; entity_id: string };
		expect(wrap.dek_id).toBe(ent.dek_id);
		expect(wrap.entity_id).toBe("ent_a");
	});

	it("the wrapped DEK round-trips via dekStore.open (encryption is real, not stub)", async () => {
		seedLegacy(env, "ent_a", 1);
		await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		const opened = env.dekStore.open("ent_a");
		expect(opened).not.toBeNull();
		expect(opened?.dek.length).toBe(32);
		expect(opened?.dek.some((b) => b !== 0)).toBe(true);
		if (opened) env.dekStore.close(opened.dek);
	});

	it("per-row failure is logged + counted, the pass continues for the rest", async () => {
		seedLegacy(env, "ent_a", 1);
		seedLegacy(env, "ent_b", 2);
		seedLegacy(env, "ent_c", 3);

		// Make persist throw on ent_b exactly once by injecting a dekStore
		// whose `persist` checks the entityId. Build a wrapping store that
		// delegates everything except `persist` for ent_b.
		const realStore = env.dekStore;
		const wrappingStore = new EntityDekStore(env.deks, env.masterKey);
		// Monkey-patch persist on the wrapping store: throw for ent_b,
		// delegate otherwise. (Using the real store internals here keeps
		// AAD + key + repo binding identical to production.)
		const originalPersist = wrappingStore.persist.bind(wrappingStore);
		wrappingStore.persist = (entityId: string, dekId: string) => {
			if (entityId === "ent_b") throw new Error("synthetic persist failure for ent_b");
			return originalPersist(entityId, dekId);
		};
		// Quiet the warn during the failing case to keep test output clean.
		const originalWarn = console.warn;
		console.warn = () => {
			/* swallow expected warn */
		};
		try {
			const r = await retroWrapNullDeks({ repo: env.repo, dekStore: wrappingStore });
			expect(r).toEqual({ wrapped: 2, skipped: 1 });
		} finally {
			console.warn = originalWarn;
		}

		// ent_a and ent_c are wrapped; ent_b is rolled back (still null
		// dek_id, no wrap row).
		const dekIds = env.db.prepare("SELECT id, dek_id FROM entities ORDER BY id").all() as Array<{
			id: string;
			dek_id: string | null;
		}>;
		expect(dekIds.find((r) => r.id === "ent_a")?.dek_id).not.toBeNull();
		expect(dekIds.find((r) => r.id === "ent_b")?.dek_id).toBeNull();
		expect(dekIds.find((r) => r.id === "ent_c")?.dek_id).not.toBeNull();
		// No wrap row was left orphan for ent_b.
		const wraps = env.db
			.prepare("SELECT COUNT(*) AS n FROM entity_deks WHERE entity_id = ?")
			.get("ent_b") as { n: number };
		expect(wraps.n).toBe(0);
		// realStore was not used; keep ref alive to dodge a "declared not used" lint.
		expect(realStore).toBe(env.dekStore);
	});

	it("a row that lost the race (dek_id stamped by a concurrent writer) is counted as neither wrapped nor skipped", async () => {
		seedLegacy(env, "ent_a", 1);
		// Simulate the concurrent writer: stamp before the pass runs.
		// (In production this is the entities.create IPC path winning the
		// race between `listMissingDekIds()` and the per-row UPDATE.)
		env.db.prepare("UPDATE entities SET dek_id = ? WHERE id = ?").run("dek_concurrent", "ent_a");

		const r = await retroWrapNullDeks({ repo: env.repo, dekStore: env.dekStore });
		// Wrapped=0 (we couldn't stamp), skipped=0 (the guard fired — not
		// an error, the row is already covered by someone else).
		expect(r).toEqual({ wrapped: 0, skipped: 0 });
		const row = env.db.prepare("SELECT dek_id FROM entities WHERE id = ?").get("ent_a") as {
			dek_id: string | null;
		};
		expect(row.dek_id).toBe("dek_concurrent");
	});

	it("listMissingDekIds throwing is non-fatal: returns {0,0}, logs", async () => {
		const brokenRepo = {
			listMissingDekIds: () => {
				throw new Error("synthetic list failure");
			},
			transaction: env.repo.transaction.bind(env.repo),
			stampDekId: env.repo.stampDekId.bind(env.repo),
		} as unknown as EntitiesRepository;
		const originalWarn = console.warn;
		console.warn = () => {
			/* swallow expected warn */
		};
		try {
			const r = await retroWrapNullDeks({ repo: brokenRepo, dekStore: env.dekStore });
			expect(r).toEqual({ wrapped: 0, skipped: 0 });
		} finally {
			console.warn = originalWarn;
		}
	});
});
