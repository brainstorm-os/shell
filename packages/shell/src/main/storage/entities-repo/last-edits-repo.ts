/**
 * `entity_last_edits` repository (Collab-C7) — the last recorded editor of each
 * shared object. Written by the sync path only (see `LastEditRecorder`); read
 * by the capability-gated `sharing.lastEdit`. One row per entity (upsert).
 *
 * SQL lives only here (CLAUDE.md §Repository pattern for SQL).
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";

export type LastEditRecord = { entityId: string; editor: string; editedAt: number };

export class LastEditsRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	/** Record an edit. An older timestamp never overwrites a newer one. */
	record(entityId: string, editor: string, editedAt: number): void {
		this.stmt(
			"INSERT INTO entity_last_edits (entity_id, editor, edited_at) VALUES (?, ?, ?) " +
				"ON CONFLICT(entity_id) DO UPDATE SET editor = excluded.editor, edited_at = excluded.edited_at " +
				"WHERE excluded.edited_at >= entity_last_edits.edited_at",
		).run(entityId, editor, editedAt);
	}

	get(entityId: string): LastEditRecord | null {
		const row = this.stmt(
			"SELECT entity_id, editor, edited_at FROM entity_last_edits WHERE entity_id = ?",
		).get(entityId) as { entity_id: string; editor: string; edited_at: number } | undefined;
		return row
			? { entityId: row.entity_id, editor: row.editor, editedAt: Number(row.edited_at) }
			: null;
	}

	delete(entityId: string): void {
		this.stmt("DELETE FROM entity_last_edits WHERE entity_id = ?").run(entityId);
	}
}
