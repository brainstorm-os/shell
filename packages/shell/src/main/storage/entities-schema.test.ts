/**
 * `entities.db` schema. Pins the migration list:
 *   - v1 → v2 adds the `entity_deks` table + index.
 *   - v2 → v3 adds the binary-asset tables (`assets` + `asset_deks` +
 *     `asset_refs`).
 *   - v3 → v4 re-types journal entries off the shared Note type.
 *   - v4 → v5 promotes `Person.company` strings to `Company/v1` entity refs.
 *   - Re-applying the migration list is a no-op (idempotent).
 *   - A fresh install has the same shape as a v1-then-migrated DB.
 */

import { open } from "@brainstorm-os/sqlite";
import { describe, expect, it } from "vitest";
import { ENTITIES_MIGRATIONS } from "./entities-schema";
import { applyMigrations, getSchemaVersion } from "./migrations";

async function fresh() {
	return open(":memory:");
}

type TableInfo = { name: string; sql: string };

function listTables(db: Awaited<ReturnType<typeof fresh>>): TableInfo[] {
	return db
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_schema_version' ORDER BY name",
		)
		.all() as TableInfo[];
}

describe("entities.db schema", () => {
	it("fresh install applies v1..v8 in order and ends at version 8", async () => {
		const db = await fresh();
		try {
			expect(await applyMigrations(db, ENTITIES_MIGRATIONS)).toBe(8);
			expect(getSchemaVersion(db)).toBe(8);
			const names = listTables(db).map((t) => t.name);
			expect(names).toContain("entities");
			expect(names).toContain("links");
			expect(names).toContain("change_log");
			expect(names).toContain("entity_deks");
			expect(names).toContain("assets");
			expect(names).toContain("asset_deks");
			expect(names).toContain("asset_refs");
		} finally {
			db.close();
		}
	});

	it("re-applying the migration list is a no-op (idempotent)", async () => {
		const db = await fresh();
		try {
			await applyMigrations(db, ENTITIES_MIGRATIONS);
			expect(getSchemaVersion(db)).toBe(8);
			// Second pass — nothing pending, version stays at 6.
			await applyMigrations(db, ENTITIES_MIGRATIONS);
			expect(getSchemaVersion(db)).toBe(8);
		} finally {
			db.close();
		}
	});

	it("v4 re-types journal-dated rows to the Journal type, never plain notes", async () => {
		const db = await fresh();
		try {
			// Seed v1..v3 tables, then insert Note-typed rows BEFORE v4 runs by
			// applying only the pre-v4 migrations first.
			const preV4 = ENTITIES_MIGRATIONS.filter((m) => m.version <= 3);
			await applyMigrations(db, preV4);

			const insert = db.prepare(
				"INSERT INTO entities (id, type, properties, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			);
			const NOTE = "io.brainstorm.notes/Note/v1";
			insert.run("journal-2026-06-01", NOTE, "{}", "io.brainstorm.notes", 1, 2);
			insert.run("n1", NOTE, "{}", "io.brainstorm.notes", 1, 2);
			// A user note whose id merely starts with "journal-" — must NOT match.
			insert.run("journal-ideas", NOTE, "{}", "io.brainstorm.notes", 1, 2);

			await applyMigrations(db, ENTITIES_MIGRATIONS);
			expect(getSchemaVersion(db)).toBe(8);

			const typeOf = (id: string) =>
				(db.prepare("SELECT type, created_by FROM entities WHERE id = ?").get(id) as {
					type: string;
					created_by: string;
				}) ?? null;
			expect(typeOf("journal-2026-06-01").type).toBe("io.brainstorm.journal/Entry/v1");
			expect(typeOf("journal-2026-06-01").created_by).toBe("io.brainstorm.journal");
			expect(typeOf("n1").type).toBe(NOTE);
			expect(typeOf("journal-ideas").type).toBe(NOTE);
		} finally {
			db.close();
		}
	});

	it("v5 promotes Person.company strings to Company/v1 entities + refs", async () => {
		const db = await fresh();
		try {
			const preV5 = ENTITIES_MIGRATIONS.filter((m) => m.version <= 4);
			await applyMigrations(db, preV5);

			const insert = db.prepare(
				"INSERT INTO entities (id, type, properties, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			);
			const PERSON = "brainstorm/Person/v1";
			insert.run("p_ada", PERSON, JSON.stringify({ name: "Ada", company: "Brainstorm" }), "x", 1, 2);
			insert.run("p_lin", PERSON, JSON.stringify({ name: "Lin", company: "Brainstorm" }), "x", 1, 2);
			insert.run("p_mara", PERSON, JSON.stringify({ name: "Mara", company: "Acme Press" }), "x", 1, 2);
			insert.run("p_kenji", PERSON, JSON.stringify({ name: "Kenji" }), "x", 1, 2);

			await applyMigrations(db, ENTITIES_MIGRATIONS);
			expect(getSchemaVersion(db)).toBe(8);

			// Two Company entities created, one per distinct name.
			const companies = db
				.prepare(
					"SELECT id, json_extract(properties, '$.name') AS name FROM entities WHERE type = ? ORDER BY id",
				)
				.all("brainstorm/Company/v1") as Array<{ id: string; name: string }>;
			expect(companies).toEqual([
				{ id: "company_acme_press", name: "Acme Press" },
				{ id: "company_brainstorm", name: "Brainstorm" },
			]);

			// People now reference the company id, not the name.
			const companyOf = (id: string) =>
				(
					db
						.prepare("SELECT json_extract(properties, '$.company') AS c FROM entities WHERE id = ?")
						.get(id) as { c: string | null }
				).c;
			expect(companyOf("p_ada")).toBe("company_brainstorm");
			expect(companyOf("p_lin")).toBe("company_brainstorm");
			expect(companyOf("p_mara")).toBe("company_acme_press");
			expect(companyOf("p_kenji")).toBeNull();

			// Idempotent re-run does not create duplicate companies.
			await applyMigrations(db, ENTITIES_MIGRATIONS);
			const count = (
				db
					.prepare("SELECT COUNT(*) AS n FROM entities WHERE type = ?")
					.get("brainstorm/Company/v1") as { n: number }
			).n;
			expect(count).toBe(2);
		} finally {
			db.close();
		}
	});

	it("asset tables have the expected key columns + cascade FKs", async () => {
		const db = await fresh();
		try {
			await applyMigrations(db, ENTITIES_MIGRATIONS);
			const assetCols = db.prepare("PRAGMA table_info('assets')").all() as Array<{
				name: string;
				pk: number;
				notnull: number;
			}>;
			const byName = Object.fromEntries(assetCols.map((c) => [c.name, c]));
			expect(byName.asset_id?.pk).toBe(1);
			expect(byName.content_hash?.notnull).toBe(1);
			expect(byName.kind?.notnull).toBe(1);

			// asset_deks + asset_refs cascade off their FKs.
			const dekFks = db.prepare("PRAGMA foreign_key_list('asset_deks')").all() as Array<{
				table: string;
				on_delete: string;
			}>;
			expect(dekFks.some((f) => f.table === "assets" && f.on_delete === "CASCADE")).toBe(true);
			const refFks = db.prepare("PRAGMA foreign_key_list('asset_refs')").all() as Array<{
				table: string;
				on_delete: string;
			}>;
			expect(refFks.some((f) => f.table === "entities" && f.on_delete === "CASCADE")).toBe(true);
			expect(refFks.some((f) => f.table === "assets" && f.on_delete === "CASCADE")).toBe(true);

			// v7 — the Asset-B1 re-home marker, nullable (NULL ⇒ not yet re-homed).
			const refCols = db.prepare("PRAGMA table_info('asset_refs')").all() as Array<{
				name: string;
				notnull: number;
			}>;
			const refByName = Object.fromEntries(refCols.map((c) => [c.name, c]));
			expect(refByName.rehomed_at).toBeDefined();
			expect(refByName.rehomed_at?.notnull).toBe(0);
		} finally {
			db.close();
		}
	});

	it("v1-then-v2 has the same `entity_deks` shape as a fresh apply", async () => {
		// Migrate v1 only, then v1+v2, on two separate DBs. The end-state
		// `sqlite_master` for `entity_deks` should match the v1+v2 path.
		const v1Only = await fresh();
		const v1AndV2 = await fresh();
		try {
			const m1 = ENTITIES_MIGRATIONS.find((m) => m.version === 1);
			if (!m1) throw new Error("v1 migration missing");
			await applyMigrations(v1Only, [m1]);
			expect(getSchemaVersion(v1Only)).toBe(1);
			const v1Names = listTables(v1Only).map((t) => t.name);
			expect(v1Names).not.toContain("entity_deks");

			await applyMigrations(v1AndV2, ENTITIES_MIGRATIONS);
			const dekRow = v1AndV2
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_deks'")
				.get() as { sql: string } | undefined;
			expect(dekRow?.sql).toMatch(/CREATE TABLE entity_deks/);

			// Now migrate v1-only DB forward and confirm shape converges.
			await applyMigrations(v1Only, ENTITIES_MIGRATIONS);
			const v1MigratedRow = v1Only
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entity_deks'")
				.get() as { sql: string } | undefined;
			expect(v1MigratedRow?.sql).toBe(dekRow?.sql);
		} finally {
			v1Only.close();
			v1AndV2.close();
		}
	});

	it("entity_deks has the expected columns + index", async () => {
		const db = await fresh();
		try {
			await applyMigrations(db, ENTITIES_MIGRATIONS);
			const columns = db.prepare("PRAGMA table_info('entity_deks')").all() as Array<{
				name: string;
				type: string;
				notnull: number;
				pk: number;
			}>;
			const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
			expect(byName.dek_id?.pk).toBe(1);
			expect(byName.entity_id?.notnull).toBe(1);
			expect(byName.version?.notnull).toBe(1);
			expect(byName.sealed_dek_json?.notnull).toBe(1);
			expect(byName.created_at?.notnull).toBe(1);

			const indexes = db.prepare("PRAGMA index_list('entity_deks')").all() as Array<{
				name: string;
			}>;
			expect(indexes.map((i) => i.name)).toContain("idx_entity_deks_entity");
		} finally {
			db.close();
		}
	});
});
