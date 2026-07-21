import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__setSqlcipherDriverForTests,
	getDriverName,
	isSqlcipherAvailable,
	open,
} from "@brainstorm-os/sqlite";
import { FakeSqlcipherDb } from "@brainstorm-os/sqlite/at-rest-fake-driver";
import { AtRestDb, deriveAtRestKey, keyToHex } from "@brainstorm-os/sqlite/at-rest-key";
import {
	AtRestState,
	classifyAtRest,
	migratePlaintextToEncrypted,
	migrationTempPath,
} from "@brainstorm-os/sqlite/at-rest-migration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MASTER = new Uint8Array(32).map((_, i) => (i * 13 + 1) & 0xff);
const rawOpen = (p: string) => new FakeSqlcipherDb(p);

/** Write a fake "plaintext" DB file (key: null) with one table+row. */
async function writePlaintext(path: string): Promise<void> {
	await writeFile(path, JSON.stringify({ key: null, tables: { notes: [{ text: "legacy-row" }] } }));
}

describe("at-rest migration (driver-independent logic)", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "brainstorm-atrest-"));
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("classifies absent / plaintext / encrypted", async () => {
		const p = join(tmp, "x.db");
		expect(classifyAtRest(p, rawOpen)).toBe(AtRestState.Absent);
		await writePlaintext(p);
		expect(classifyAtRest(p, rawOpen)).toBe(AtRestState.Plaintext);
		await writeFile(p, JSON.stringify({ key: "abcd", tables: {} }));
		expect(classifyAtRest(p, rawOpen)).toBe(AtRestState.Encrypted);
	});

	it("migrates plaintext → encrypted preserving every row (no data loss)", async () => {
		const p = join(tmp, "entities.db");
		await writePlaintext(p);
		const key = deriveAtRestKey(MASTER, AtRestDb.Entities);
		const before = await migratePlaintextToEncrypted(p, key, rawOpen);
		expect(before).toBe(AtRestState.Plaintext);

		const disk = JSON.parse(await readFile(p, "utf8"));
		expect(disk.key).toBe(keyToHex(key));
		expect(disk.tables.notes).toEqual([{ text: "legacy-row" }]);
		expect(classifyAtRest(p, rawOpen)).toBe(AtRestState.Encrypted);
	});

	it("is idempotent — re-running on an encrypted file is a no-op", async () => {
		const p = join(tmp, "registry.db");
		await writePlaintext(p);
		const key = deriveAtRestKey(MASTER, AtRestDb.Registry);
		await migratePlaintextToEncrypted(p, key, rawOpen);
		const first = await readFile(p, "utf8");
		const again = await migratePlaintextToEncrypted(p, key, rawOpen);
		expect(again).toBe(AtRestState.Encrypted);
		expect(await readFile(p, "utf8")).toBe(first);
	});

	it("absent file is a no-op (created keyed on open)", async () => {
		const p = join(tmp, "search.db");
		const key = deriveAtRestKey(MASTER, AtRestDb.Search);
		expect(await migratePlaintextToEncrypted(p, key, rawOpen)).toBe(AtRestState.Absent);
		expect(existsSync(p)).toBe(false);
	});

	it("atomicity: a crash mid-rekey leaves the plaintext original intact", async () => {
		const p = join(tmp, "ledger.db");
		await writePlaintext(p);
		const key = deriveAtRestKey(MASTER, AtRestDb.Ledger);
		const failingOpen = (path: string) => {
			const h = new FakeSqlcipherDb(path);
			return {
				exec: (sql: string) => {
					if (/rekey/i.test(sql)) throw new Error("disk full");
					h.exec(sql);
				},
				probe: (sql: string) => h.prepare(sql).get(),
				close: () => h.close(),
			};
		};
		await expect(migratePlaintextToEncrypted(p, key, failingOpen)).rejects.toThrow("disk full");
		const disk = JSON.parse(await readFile(p, "utf8"));
		expect(disk.key).toBeNull();
		expect(disk.tables.notes).toEqual([{ text: "legacy-row" }]);
		expect(existsSync(migrationTempPath(p))).toBe(false);
	});

	it("stale temp debris from a prior crash is discarded, migration still succeeds", async () => {
		const p = join(tmp, "entities.db");
		await writePlaintext(p);
		await writeFile(migrationTempPath(p), "garbage-from-old-crash");
		const key = deriveAtRestKey(MASTER, AtRestDb.Entities);
		await migratePlaintextToEncrypted(p, key, rawOpen);
		expect(JSON.parse(await readFile(p, "utf8")).tables.notes).toEqual([{ text: "legacy-row" }]);
	});
});

describe("sqlite encrypted open path (fake SQLCipher driver)", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "brainstorm-atrest-sql-"));
		__setSqlcipherDriverForTests(FakeSqlcipherDb as never);
	});
	afterEach(async () => {
		__setSqlcipherDriverForTests(null);
		await rm(tmp, { recursive: true, force: true });
	});

	it("selects the sqlcipher driver and reports it available", async () => {
		const db = await open(join(tmp, "a.db"), {
			encryptionKeyHex: keyToHex(deriveAtRestKey(MASTER, AtRestDb.Ledger)),
		});
		try {
			expect(isSqlcipherAvailable()).toBe(true);
			expect(getDriverName()).toBe("sqlcipher");
		} finally {
			db.close();
		}
	});

	it("round-trips: write → close → reopen with correct key succeeds", async () => {
		const p = join(tmp, "rt.db");
		const hex = keyToHex(deriveAtRestKey(MASTER, AtRestDb.Entities));
		{
			const db = await open(p, { encryptionKeyHex: hex });
			db.exec("CREATE TABLE notes (text TEXT)");
			db.prepare("INSERT INTO notes (text) VALUES (?)").run("hello");
			db.close();
		}
		const db = await open(p, { encryptionKeyHex: hex });
		try {
			expect((db.prepare("SELECT text FROM notes").all() as { text: string }[])[0]?.text).toBe(
				"hello",
			);
		} finally {
			db.close();
		}
	});

	it("fail-closed: reopening with the WRONG key throws (no plaintext fallback)", async () => {
		const p = join(tmp, "fc.db");
		const right = keyToHex(deriveAtRestKey(MASTER, AtRestDb.Entities));
		const wrong = keyToHex(deriveAtRestKey(new Uint8Array(32).fill(2), AtRestDb.Entities));
		{
			const db = await open(p, { encryptionKeyHex: right });
			db.exec("CREATE TABLE secret (v TEXT)");
			db.prepare("INSERT INTO secret (v) VALUES (?)").run("classified");
			db.close();
		}
		await expect(open(p, { encryptionKeyHex: wrong })).rejects.toThrow(/wrong or missing/);
	});

	it("fail-closed: reopening with NO key throws", async () => {
		const p = join(tmp, "nokey.db");
		const hex = keyToHex(deriveAtRestKey(MASTER, AtRestDb.Search));
		{
			const db = await open(p, { encryptionKeyHex: hex });
			db.exec("CREATE TABLE t (x TEXT)");
			db.close();
		}
		await expect(open(p, {})).rejects.toThrow(/wrong or missing/);
	});

	it("transparently upgrades a legacy plaintext vault on first keyed open", async () => {
		const p = join(tmp, "legacy.db");
		await writeFile(p, JSON.stringify({ key: null, tables: { notes: [{ text: "pre-3b-data" }] } }));
		const hex = keyToHex(deriveAtRestKey(MASTER, AtRestDb.Entities));
		const db = await open(p, { encryptionKeyHex: hex });
		try {
			expect((db.prepare("SELECT text FROM notes").all() as { text: string }[])[0]?.text).toBe(
				"pre-3b-data",
			);
		} finally {
			db.close();
		}
		// And the file is now encrypted (unreadable without the key).
		await expect(open(p, {})).rejects.toThrow(/wrong or missing/);
	});
});

describe("sqlcipher driver-availability gate (contract probe)", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "brainstorm-atrest-gate-"));
	});
	afterEach(async () => {
		__setSqlcipherDriverForTests(null);
		await rm(tmp, { recursive: true, force: true });
	});

	it("falls back to the legacy driver when the SQLCipher ctor's native addon won't load", async () => {
		// Models the OQ-34 environment: package JS resolves, but the first
		// real construction throws like the missing `better_sqlite3.node`.
		class UnbuiltSqlcipherDb {
			constructor() {
				throw new Error("Could not locate the bindings file.");
			}
		}
		__setSqlcipherDriverForTests(UnbuiltSqlcipherDb as never);

		const db = await open(join(tmp, "g.db"));
		try {
			expect(isSqlcipherAvailable()).toBe(false);
			expect(["bun", "node"]).toContain(getDriverName());
			db.exec("CREATE TABLE t (x TEXT)");
			db.prepare("INSERT INTO t (x) VALUES (?)").run("ok");
			expect((db.prepare("SELECT x FROM t").all() as { x: string }[])[0]?.x).toBe("ok");
		} finally {
			db.close();
		}
	});

	it("falls back when the driver loads but PRAGMA rekey is a silent no-op", async () => {
		// Models the SQLite3MultipleCiphers / missing-sqlcipher_export class:
		// the addon constructs and runs SQL fine, but the encryption SQL the
		// migration depends on does nothing — the contract probe must catch
		// this (fail-closed verify fails) and degrade, not brick every open.
		class NoRekeySqlcipherDb extends FakeSqlcipherDb {
			override exec(sql: string): void {
				if (/^\s*PRAGMA rekey/i.test(sql)) return;
				super.exec(sql);
			}
		}
		__setSqlcipherDriverForTests(NoRekeySqlcipherDb as never);

		const db = await open(join(tmp, "g2.db"));
		try {
			expect(isSqlcipherAvailable()).toBe(false);
			expect(["bun", "node"]).toContain(getDriverName());
			db.exec("CREATE TABLE t (x TEXT)");
			db.prepare("INSERT INTO t (x) VALUES (?)").run("ok");
			expect((db.prepare("SELECT x FROM t").all() as { x: string }[])[0]?.x).toBe("ok");
		} finally {
			db.close();
		}
	});
});
