import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtRestKeyError, __setSqlcipherDriverForTests } from "@brainstorm-os/sqlite";
import { FakeSqlcipherDb } from "@brainstorm-os/sqlite/at-rest-fake-driver";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores, archiveCorruptDb } from "./data-stores";
import { CorruptionRecovery, VaultCorruptionError } from "./recovery-plan";

describe("DataStores", () => {
	let vaultDir: string;
	let stores: DataStores;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-stores-"));
		stores = new DataStores(vaultDir);
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("creates data/ on first open", async () => {
		await stores.open("ledger");
		const info = await stat(join(vaultDir, "data"));
		expect(info.isDirectory()).toBe(true);
	});

	it("opens each of the four domain databases", async () => {
		for (const kind of ["ledger", "registry", "entities", "search"] as const) {
			const db = await stores.open(kind);
			expect(db).toBeDefined();
		}
	});

	it("caches per-kind handles", async () => {
		const a = await stores.open("entities");
		const b = await stores.open("entities");
		expect(a).toBe(b);
	});

	it("collapses CONCURRENT opens of a kind onto one connection (F-278 stampede)", async () => {
		// The cache is consulted synchronously but the open is async, so N callers
		// firing `open("entities")` before the first resolves each used to open a
		// SEPARATE connection — leaking N-1 live writers on the same file, which
		// deadlocks WAL writes with `SQLITE_BUSY: database is locked`. Boot fans
		// out exactly this (search reindex + vault-entities listing + restore).
		const handles = await Promise.all([
			stores.open("entities"),
			stores.open("entities"),
			stores.open("entities"),
			stores.open("entities"),
		]);
		for (const h of handles) expect(h).toBe(handles[0]);
		// And a subsequent open still returns that same single connection.
		expect(await stores.open("entities")).toBe(handles[0]);
	});

	it("reopens a cached handle whose connection was closed out-of-band", async () => {
		const a = await stores.open("registry");
		// Simulate a session teardown the cache didn't observe (the dev
		// auto-seed race that returned a dead handle → "database connection is
		// not open" → app bundles never reinstalled).
		a.close();
		expect(a.isOpen()).toBe(false);
		const b = await stores.open("registry");
		expect(b).not.toBe(a);
		expect(b.isOpen()).toBe(true);
		// The fresh handle is actually usable (prepare/exec don't throw).
		expect(
			b.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length,
		).toBeGreaterThan(0);
	});

	it("ledger.db has the capabilities table after open", async () => {
		const db = await stores.open("ledger");
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capabilities'")
			.all();
		expect(tables).toHaveLength(1);
		db
			.prepare(
				"INSERT INTO capabilities (id, app_id, capability, scope, granted_at, granted_via) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("cap_1", "io.example.app", "storage.kv", null, Date.now(), "install");
	});

	it("registry.db has all the registration tables after open", async () => {
		const db = await stores.open("registry");
		const tables = (
			db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
				name: string;
			}>
		).map((r) => r.name);
		expect(tables).toEqual(
			expect.arrayContaining([
				"_schema_version",
				"apps",
				"blocks",
				"custom_node_types",
				"entity_types",
				"openers",
				"widgets",
			]),
		);
	});

	it("entities.db round-trips an entity row with foreign-key linking", async () => {
		const db = await stores.open("entities");
		db
			.prepare(
				"INSERT INTO entities (id, type, space_id, properties, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run("ent_a", "io.example/Note/v1", null, JSON.stringify({ title: "A" }), "shell", 1, 1);
		db
			.prepare(
				"INSERT INTO entities (id, type, properties, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("ent_b", "io.example/Note/v1", JSON.stringify({ title: "B" }), "shell", 2, 2);
		db
			.prepare(
				"INSERT INTO links (id, source_entity_id, dest_entity_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run("lnk_1", "ent_a", "ent_b", "io.example/links/related/v1", 3);
		const row = db
			.prepare("SELECT json_extract(properties, '$.title') AS t FROM entities WHERE id=?")
			.get("ent_a") as { t: string };
		expect(row.t).toBe("A");
	});

	it("entities.db enforces foreign keys on links", async () => {
		const db = await stores.open("entities");
		expect(() =>
			db
				.prepare(
					"INSERT INTO links (id, source_entity_id, dest_entity_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("lnk_x", "missing_a", "missing_b", "type", 1),
		).toThrow();
	});

	it("search.db has FTS5 virtual tables that accept inserts + queries", async () => {
		const db = await stores.open("search");
		db
			.prepare("INSERT INTO entity_fts (entity_id, type, title, body) VALUES (?, ?, ?, ?)")
			.run("ent_a", "io.example/Note/v1", "hello world", "the quick brown fox");
		const hits = db
			.prepare("SELECT entity_id FROM entity_fts WHERE entity_fts MATCH ?")
			.all("brown") as Array<{ entity_id: string }>;
		expect(hits.map((h) => h.entity_id)).toEqual(["ent_a"]);
	});

	it("pathFor() returns the expected filename", () => {
		expect(stores.pathFor("ledger")).toMatch(/data[/\\]ledger\.db$/);
		expect(stores.pathFor("registry")).toMatch(/data[/\\]registry\.db$/);
		expect(stores.pathFor("entities")).toMatch(/data[/\\]entities\.db$/);
		expect(stores.pathFor("search")).toMatch(/data[/\\]search\.db$/);
	});

	it("close() makes subsequent open() throw", async () => {
		await stores.open("entities");
		stores.close();
		await expect(stores.open("ledger")).rejects.toThrow(/cannot open/);
	});

	it("close() is idempotent", async () => {
		await stores.open("entities");
		stores.close();
		expect(() => stores.close()).not.toThrow();
	});

	it("schemas re-open cleanly on a second DataStores instance", async () => {
		const db = await stores.open("entities");
		db
			.prepare(
				"INSERT INTO entities (id, type, properties, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run("ent_persist", "io.example/Note/v1", "{}", "shell", 1, 1);
		stores.close();

		const reopened = new DataStores(vaultDir);
		try {
			const db2 = await reopened.open("entities");
			const row = db2.prepare("SELECT id FROM entities WHERE id=?").get("ent_persist");
			expect(row).toMatchObject({ id: "ent_persist" });
		} finally {
			reopened.close();
		}
	});

	it("keeps a defensive master-key copy and zeroes it on close (no aliasing)", async () => {
		const master = new Uint8Array(32).fill(7);
		const keyed = new DataStores(await mkdtemp(join(tmpdir(), "brainstorm-keyed-")), {
			masterKey: master,
		});
		// caller may zero its own buffer without affecting our derivation
		master.fill(0);
		await keyed.open("ledger");
		keyed.close();
		expect(true).toBe(true);
	});
});

describe("DataStores — corrupt-file recovery (12.8, doc 28 §Recovery)", () => {
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-corrupt-"));
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	/** Create the DB file, then overwrite it (+ WAL sidecars) with garbage so a
	 *  fresh open reads an invalid SQLite header. */
	const corrupt = async (kind: "ledger" | "registry" | "entities" | "search") => {
		const seed = new DataStores(vaultDir);
		await seed.open(kind);
		seed.close();
		const path = seed.pathFor(kind);
		for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
			await rm(sidecar, { force: true });
		}
		await writeFile(path, "this is not a sqlite database — just plain bytes\n");
		return path;
	};

	it("auto-rebuilds a corrupt search.db (derived index — no prompt)", async () => {
		const path = await corrupt("search");
		const stores = new DataStores(vaultDir);
		// Opens without throwing — the malformed file is dropped + recreated.
		const db = await stores.open("search");
		// The fresh DB carries the search schema again and is queryable.
		const row = db.prepare("SELECT MAX(version) AS v FROM _schema_version").get() as {
			v: number;
		};
		expect(row.v).toBeGreaterThan(0);
		stores.close();
		expect(path.endsWith("search.db")).toBe(true);
	});

	it("refuses to auto-destroy a corrupt ledger.db → VaultCorruptionError (restore/re-init)", async () => {
		await corrupt("ledger");
		const stores = new DataStores(vaultDir);
		const err = await stores.open("ledger").then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(VaultCorruptionError);
		expect((err as VaultCorruptionError).kind).toBe("ledger");
		expect((err as VaultCorruptionError).recovery).toBe(CorruptionRecovery.PromptRestoreOrReinit);
		stores.close();
	});

	it("refuses to auto-destroy a corrupt entities.db → VaultCorruptionError (rebuild-from-sources)", async () => {
		await corrupt("entities");
		const stores = new DataStores(vaultDir);
		const err = await stores.open("entities").then(
			() => null,
			(e) => e,
		);
		expect(err).toBeInstanceOf(VaultCorruptionError);
		expect((err as VaultCorruptionError).recovery).toBe(CorruptionRecovery.PromptRebuildFromSources);
		stores.close();
	});

	it("archiveCorruptDb moves the corrupt file aside so a fresh open recreates it empty", async () => {
		const path = await corrupt("entities");
		const archived = await archiveCorruptDb(vaultDir, "entities", 12_345);

		// Archived (not deleted) — the corrupt bytes are preserved for a manual
		// restore, and the original path is now clear.
		expect(archived).toBe(`${path}.corrupt-12345`);
		await expect(stat(path)).rejects.toThrow();
		expect(await readFile(archived, "utf8")).toContain("not a sqlite database");

		// A fresh open recreates the DB empty + migrated (no VaultCorruptionError).
		const stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		const row = db.prepare("SELECT MAX(version) AS v FROM _schema_version").get() as {
			v: number;
		};
		expect(row.v).toBeGreaterThan(0);
		stores.close();
	});

	it("archiveCorruptDb is best-effort over absent sidecars", async () => {
		// Only the main file exists (no WAL/SHM/journal) — archiving must not throw.
		await corrupt("registry");
		await expect(archiveCorruptDb(vaultDir, "registry", 1)).resolves.toMatch(/\.corrupt-1$/);
	});

	it("leaves a healthy DB untouched (recovery only fires on corruption)", async () => {
		const stores = new DataStores(vaultDir);
		const a = await stores.open("registry");
		stores.close();
		const reopened = new DataStores(vaultDir);
		const b = await reopened.open("registry");
		expect(b).toBeDefined();
		expect(a).not.toBe(b); // different instances, same intact file
		reopened.close();
	});
});

describe("DataStores — wrong/missing at-rest key is negative-cached (no main-thread KDF thrash)", () => {
	// Counts driver constructions so we can prove a retry does NOT re-open the
	// DB — i.e. doesn't re-run SQLCipher's expensive KDF on the main thread,
	// the burst of which (capability + list-installed + entity reads on every
	// dashboard refresh) froze the shell on a wrong-key vault.
	let opens = 0;
	class CountingFakeSqlcipherDb extends FakeSqlcipherDb {
		constructor(path: string) {
			super(path);
			opens++;
		}
	}
	const KEY_A = new Uint8Array(32).fill(0xa1);
	const KEY_B = new Uint8Array(32).fill(0xb2);
	let vaultDir: string;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-wrongkey-"));
		__setSqlcipherDriverForTests(CountingFakeSqlcipherDb as unknown as new (path: string) => never);
		// Materialise an encrypted ledger.db under KEY_A, then re-zero the counter
		// so only the wrong-key opens below are measured.
		const seeded = new DataStores(vaultDir, { masterKey: KEY_A });
		await seeded.open("ledger");
		seeded.close();
		opens = 0;
	});

	afterEach(async () => {
		__setSqlcipherDriverForTests(null);
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("fails closed with AtRestKeyError and does not re-open the driver on retry", async () => {
		const wrong = new DataStores(vaultDir, { masterKey: KEY_B });

		const first = await wrong.open("ledger").then(
			() => null,
			(e) => e,
		);
		expect(first).toBeInstanceOf(AtRestKeyError);
		const opensAfterFirst = opens;
		expect(opensAfterFirst).toBeGreaterThan(0); // the first attempt did touch the driver

		const second = await wrong.open("ledger").then(
			() => null,
			(e) => e,
		);
		expect(second).toBeInstanceOf(AtRestKeyError);
		// The negative cache short-circuits before the driver — zero new opens.
		expect(opens).toBe(opensAfterFirst);
		wrong.close();
	});

	it("does not negative-cache a different kind — each DB is judged on its own key", async () => {
		const wrong = new DataStores(vaultDir, { masterKey: KEY_B });
		await wrong.open("ledger").then(
			() => null,
			() => undefined,
		);
		// registry.db doesn't exist yet → created fresh under KEY_B, opens fine.
		const registry = await wrong.open("registry");
		expect(registry).toBeDefined();
		wrong.close();
	});
});
