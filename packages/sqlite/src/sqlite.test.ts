import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDriverName, open } from "./sqlite";

describe("sqlite abstraction", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), "brainstorm-sqlite-"));
	});

	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it("opens an in-memory db, executes DDL, prepares + runs statements", async () => {
		const db = await open(":memory:");
		try {
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
			const ins = db.prepare("INSERT INTO t (name) VALUES (?)");
			const r = ins.run("alpha");
			expect(r.changes).toBe(1);
			expect(Number(r.lastInsertRowid)).toBe(1);
		} finally {
			db.close();
		}
	});

	it("supports get + all + 0-row results", async () => {
		const db = await open(":memory:");
		try {
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x INTEGER)");
			db.prepare("INSERT INTO t (x) VALUES (?), (?), (?)").run(1, 2, 3);
			expect(db.prepare("SELECT * FROM t WHERE id = ?").get(1)).toMatchObject({ id: 1, x: 1 });
			expect(db.prepare("SELECT * FROM t").all()).toHaveLength(3);
			expect(db.prepare("SELECT * FROM t WHERE id = ?").get(99)).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("persists data across closes when given a file path", async () => {
		const path = join(tmp, "vol.db");
		{
			const db = await open(path);
			db.exec("CREATE TABLE notes (text TEXT)");
			db.prepare("INSERT INTO notes (text) VALUES (?)").run("hello");
			db.close();
		}
		const db = await open(path);
		try {
			const all = db.prepare("SELECT text FROM notes").all() as { text: string }[];
			expect(all.map((r) => r.text)).toEqual(["hello"]);
		} finally {
			db.close();
		}
	});

	it("tunes pragmas by default (WAL + foreign_keys + synchronous)", async () => {
		const db = await open(join(tmp, "wal.db"));
		try {
			const journal = db.pragma("journal_mode") as Array<{ journal_mode?: string }>;
			expect(journal[0]?.journal_mode?.toLowerCase()).toBe("wal");
			const fk = db.pragma("foreign_keys") as Array<{ foreign_keys?: number }>;
			expect(fk[0]?.foreign_keys).toBe(1);
			const busy = db.pragma("busy_timeout") as Array<{ timeout?: number }>;
			expect(busy[0]?.timeout).toBe(5000);
		} finally {
			db.close();
		}
	});

	it("transactions roll back on error", async () => {
		const db = await open(":memory:");
		try {
			db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
			const txn = db.transaction(() => {
				db.prepare("INSERT INTO t (id) VALUES (1)").run();
				throw new Error("boom");
			});
			expect(() => txn()).toThrow("boom");
			expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toMatchObject({ n: 0 });
		} finally {
			db.close();
		}
	});

	it("reports the active driver name after first open", async () => {
		const db = await open(":memory:");
		try {
			const name = getDriverName();
			expect(["bun", "node"]).toContain(name);
		} finally {
			db.close();
		}
	});

	it("enforces foreign key constraints when ON", async () => {
		const db = await open(":memory:");
		try {
			db.exec(`
				CREATE TABLE parent (id INTEGER PRIMARY KEY);
				CREATE TABLE child  (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
			`);
			expect(() => db.prepare("INSERT INTO child (parent_id) VALUES (?)").run(42)).toThrow();
		} finally {
			db.close();
		}
	});
});
