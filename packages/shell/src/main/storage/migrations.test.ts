import { open } from "@brainstorm-os/sqlite";
import { describe, expect, it } from "vitest";
import { type SqliteMigration, applyMigrations, getSchemaVersion } from "./migrations";

function mkMigration(version: number, sql: string, description = `m${version}`): SqliteMigration {
	return {
		version,
		description,
		up: (db) => {
			db.exec(sql);
		},
	};
}

describe("SQLite migrations", () => {
	it("reports version 0 for a fresh DB", async () => {
		const db = await open(":memory:");
		try {
			expect(getSchemaVersion(db)).toBe(0);
		} finally {
			db.close();
		}
	});

	it("applies a single migration and bumps the version", async () => {
		const db = await open(":memory:");
		try {
			const m1 = mkMigration(1, "CREATE TABLE t (id INTEGER PRIMARY KEY)");
			expect(await applyMigrations(db, [m1])).toBe(1);
			expect(getSchemaVersion(db)).toBe(1);
			expect(db.prepare("INSERT INTO t (id) VALUES (1)").run().changes).toBe(1);
		} finally {
			db.close();
		}
	});

	it("applies multiple migrations in order", async () => {
		const db = await open(":memory:");
		try {
			const migrations: SqliteMigration[] = [
				mkMigration(1, "CREATE TABLE a (id INTEGER PRIMARY KEY)"),
				mkMigration(2, "CREATE TABLE b (id INTEGER PRIMARY KEY)"),
				mkMigration(3, "CREATE TABLE c (id INTEGER PRIMARY KEY)"),
			];
			expect(await applyMigrations(db, migrations)).toBe(3);
			db.prepare("INSERT INTO a (id) VALUES (1)").run();
			db.prepare("INSERT INTO b (id) VALUES (2)").run();
			db.prepare("INSERT INTO c (id) VALUES (3)").run();
		} finally {
			db.close();
		}
	});

	it("skips already-applied migrations", async () => {
		const db = await open(":memory:");
		try {
			await applyMigrations(db, [mkMigration(1, "CREATE TABLE a (id INTEGER PRIMARY KEY)")]);
			await applyMigrations(db, [
				mkMigration(1, "CREATE TABLE a (id INTEGER PRIMARY KEY)"),
				mkMigration(2, "CREATE TABLE b (id INTEGER PRIMARY KEY)"),
			]);
			expect(getSchemaVersion(db)).toBe(2);
		} finally {
			db.close();
		}
	});

	it("rolls back a failing migration (atomic)", async () => {
		const db = await open(":memory:");
		try {
			const failing: SqliteMigration = {
				version: 1,
				description: "intentionally broken",
				up: (database) => {
					database.exec("CREATE TABLE side_effect (id INTEGER PRIMARY KEY)");
					throw new Error("nope");
				},
			};
			await expect(applyMigrations(db, [failing])).rejects.toThrow("nope");
			expect(getSchemaVersion(db)).toBe(0);
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='side_effect'")
				.all();
			expect(tables).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	it("rejects an async migration body", async () => {
		const db = await open(":memory:");
		try {
			const m: SqliteMigration = {
				version: 1,
				description: "async forbidden",
				up: () => Promise.resolve(),
			};
			await expect(applyMigrations(db, [m])).rejects.toThrow(/synchronous/);
		} finally {
			db.close();
		}
	});

	it("records description + applied_at per migration", async () => {
		const db = await open(":memory:");
		try {
			await applyMigrations(db, [
				mkMigration(1, "CREATE TABLE a (id INTEGER PRIMARY KEY)", "first"),
				mkMigration(2, "CREATE TABLE b (id INTEGER PRIMARY KEY)", "second"),
			]);
			const rows = db
				.prepare("SELECT version, description, applied_at FROM _schema_version ORDER BY version")
				.all() as Array<{ version: number; description: string; applied_at: number }>;
			expect(rows.map((r) => [r.version, r.description])).toEqual([
				[1, "first"],
				[2, "second"],
			]);
			expect(rows[0]?.applied_at).toBeGreaterThan(0);
		} finally {
			db.close();
		}
	});

	it("no-ops on an empty migration list", async () => {
		const db = await open(":memory:");
		try {
			expect(await applyMigrations(db, [])).toBe(0);
		} finally {
			db.close();
		}
	});
});
