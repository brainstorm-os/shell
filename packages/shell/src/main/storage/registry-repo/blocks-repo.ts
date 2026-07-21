/**
 * BlocksRepository — CRUD on `registry.db.blocks`.
 *
 * Each block is `<app-id>/<block-name>`; namespaced under its owning app.
 * Rows are replaced wholesale per app on install/update.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";

export type BlockRecord = {
	id: string; // <app-id>/<block-name>
	appId: string;
	name: string;
	registeredAt: number;
	/** The app-contributed BP block bundle (self-contained IIFE string), or
	 *  null when the app ships no bundle for this block (→ fallback card). */
	source?: string | null;
	/** Entity types this block renders — when one is embedded, the host picks
	 *  this block over the shell card. Empty/absent = explicit-blockId only. */
	entityTypes?: readonly string[];
};

function serializeTypes(types: readonly string[] | undefined): string | null {
	return types && types.length > 0 ? JSON.stringify(types) : null;
}

export class BlocksRepository {
	constructor(private readonly db: SqliteDatabase) {}

	insert(block: BlockRecord): void {
		this.db
			.prepare(
				"INSERT INTO blocks (id, app_id, name, registered_at, source, entity_types) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				block.id,
				block.appId,
				block.name,
				block.registeredAt,
				block.source ?? null,
				serializeTypes(block.entityTypes),
			);
	}

	insertMany(blocks: readonly BlockRecord[]): void {
		const stmt = this.db.prepare(
			"INSERT INTO blocks (id, app_id, name, registered_at, source, entity_types) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const b of blocks)
			stmt.run(b.id, b.appId, b.name, b.registeredAt, b.source ?? null, serializeTypes(b.entityTypes));
	}

	/** The block id that renders `entityType` (first registered match,
	 *  id-ordered for determinism), or null when no block claims it — the
	 *  host then falls back to the generic shell entity-card. */
	forType(entityType: string): string | null {
		const rows = this.db
			.prepare("SELECT id, entity_types FROM blocks WHERE entity_types IS NOT NULL ORDER BY id")
			.all() as Array<{ id: string; entity_types: string }>;
		for (const row of rows) {
			try {
				const types = JSON.parse(row.entity_types) as unknown;
				if (Array.isArray(types) && types.includes(entityType)) return row.id;
			} catch {
				/* malformed row — skip; never throw on a lookup. */
			}
		}
		return null;
	}

	/** The block bundle source for `blockId`, or null when none is registered
	 *  / the block ships no bundle. Keyed single read — what `blocks.source`
	 *  serves to an embedding app. */
	getSource(blockId: string): string | null {
		const row = this.db.prepare("SELECT source FROM blocks WHERE id = ?").get(blockId) as
			| { source: string | null }
			| undefined;
		return row?.source ?? null;
	}

	deleteForApp(appId: string): number {
		const result = this.db.prepare("DELETE FROM blocks WHERE app_id = ?").run(appId);
		return Number(result.changes);
	}

	listForApp(appId: string): BlockRecord[] {
		const rows = this.db
			.prepare("SELECT id, app_id, name, registered_at FROM blocks WHERE app_id = ? ORDER BY id")
			.all(appId) as Array<{ id: string; app_id: string; name: string; registered_at: number }>;
		return rows.map(toRecord);
	}

	/** The "block-id → providing-app" resolution the 9.11 host service +
	 *  `BlockEmbedNode { blockId }` need: which app renders this block?
	 *  `null` when no app registers it (unknown / uninstalled provider). */
	getById(blockId: string): BlockRecord | null {
		const row = this.db
			.prepare("SELECT id, app_id, name, registered_at FROM blocks WHERE id = ?")
			.get(blockId) as { id: string; app_id: string; name: string; registered_at: number } | undefined;
		return row ? toRecord(row) : null;
	}

	/** Every registered block across all apps, id-ordered — the registry
	 *  enumeration `blocks.list()` exposes. */
	listAll(): BlockRecord[] {
		const rows = this.db
			.prepare("SELECT id, app_id, name, registered_at FROM blocks ORDER BY id")
			.all() as Array<{ id: string; app_id: string; name: string; registered_at: number }>;
		return rows.map(toRecord);
	}
}

function toRecord(r: {
	id: string;
	app_id: string;
	name: string;
	registered_at: number;
}): BlockRecord {
	return { id: r.id, appId: r.app_id, name: r.name, registeredAt: r.registered_at };
}
