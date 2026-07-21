/**
 * EntityTypesRepository — CRUD on `registry.db.entity_types`.
 *
 * Per OQ-3 resolution: rows survive uninstall (marked `orphaned=1`) and
 * un-orphan on re-install. Upsert keeps the same row across version cycles.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

export type EntityTypeRecord = {
	id: string;
	introducedBy: string;
	schemaUrl: string;
	/** Optional inline JSON-Schema per OQ-2 hybrid. Persisted as JSON text. */
	schemaInline: Record<string, unknown> | null;
	registeredAt: number;
};

type DbRow = {
	id: string;
	introduced_by: string;
	schema_url: string;
	schema_inline: string | null;
	registered_at: number;
	orphaned: number;
};

export class EntityTypesRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/** Insert or refresh an entity type. Always un-orphans the row. */
	upsert(record: EntityTypeRecord): void {
		this.db
			.prepare(
				"INSERT INTO entity_types (id, introduced_by, schema_url, schema_inline, registered_at, orphaned) VALUES (?, ?, ?, ?, ?, 0) " +
					"ON CONFLICT(id) DO UPDATE SET introduced_by = excluded.introduced_by, schema_url = excluded.schema_url, schema_inline = excluded.schema_inline, registered_at = excluded.registered_at, orphaned = 0",
			)
			.run(
				record.id,
				record.introducedBy,
				record.schemaUrl,
				record.schemaInline ? JSON.stringify(record.schemaInline) : null,
				record.registeredAt,
			);
	}

	/** Mark every type introduced by this app as orphaned. Returns the number
	 *  of rows that flipped (per OQ-3 — orphaned-but-resolvable). */
	orphanForApp(appId: string): number {
		const result = this.db
			.prepare("UPDATE entity_types SET orphaned = 1 WHERE introduced_by = ? AND orphaned = 0")
			.run(appId);
		return Number(result.changes);
	}

	get(id: string): (EntityTypeRecord & { orphaned: boolean }) | null {
		const row = this.db
			.prepare(
				"SELECT id, introduced_by, schema_url, schema_inline, registered_at, orphaned FROM entity_types WHERE id = ?",
			)
			.get(id) as DbRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/** Every registered type, orphaned ones included (Settings → Defaults
	 *  lists them so a stale override is still visible + clearable). */
	listAll(): Array<EntityTypeRecord & { orphaned: boolean }> {
		const rows = this.db
			.prepare(
				"SELECT id, introduced_by, schema_url, schema_inline, registered_at, orphaned FROM entity_types ORDER BY id",
			)
			.all() as DbRow[];
		return rows.map(rowToRecord);
	}

	listForApp(appId: string): Array<EntityTypeRecord & { orphaned: boolean }> {
		const rows = this.db
			.prepare(
				"SELECT id, introduced_by, schema_url, schema_inline, registered_at, orphaned FROM entity_types WHERE introduced_by = ? ORDER BY id",
			)
			.all(appId) as DbRow[];
		return rows.map(rowToRecord);
	}
}

function rowToRecord(row: DbRow): EntityTypeRecord & { orphaned: boolean } {
	return {
		id: row.id,
		introducedBy: row.introduced_by,
		schemaUrl: row.schema_url,
		schemaInline: row.schema_inline
			? (JSON.parse(row.schema_inline) as Record<string, unknown>)
			: null,
		registeredAt: row.registered_at,
		orphaned: row.orphaned === 1,
	};
}
