/**
 * PendingRotationsRepository — CRUD on `entities.db.pending_rotations`.
 *
 * The durable backing for ROT-3a-ii (design 73, finding F-ROT-4). When a
 * rotate-on-revoke mints DEK′ and re-wraps the survivors but can't finish the
 * WIRE delivery — the survivor inbox `WrapBootstrap` + full-state re-emit —
 * because there's no relay (offline revoke) or the emit throws, the entity is
 * marked here. The drain (on relay-connect + boot) re-runs the wire delivery
 * for each row and `remove()`s it on success, so a deferred rotation converges
 * instead of being silently lost.
 *
 * `dekVersion` is the ordinal the mint produced; the drain re-reads the current
 * DEK and drops the row without re-emitting if a later rotation already
 * superseded it. LOCAL derived state — never syncs, never crosses the wire.
 */

import type { SqliteDatabase } from "../sqlite";

/** One entity awaiting its deferred rotation wire-delivery. */
export type PendingRotationRecord = {
	entityId: string;
	dekVersion: number;
	createdAt: number;
};

type PendingRotationRow = {
	entity_id: string;
	dek_version: number;
	created_at: number;
};

export class PendingRotationsRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/** Mark `entityId` as needing wire-delivery for its DEK ordinal `dekVersion`.
	 *  Upsert — a re-mark (a second revoke before the first drained) overwrites
	 *  with the newer ordinal. */
	mark(entityId: string, dekVersion: number, now: number): void {
		this.db
			.prepare(
				`INSERT INTO pending_rotations (entity_id, dek_version, created_at)
				VALUES (?, ?, ?)
				ON CONFLICT(entity_id) DO UPDATE SET
					dek_version = excluded.dek_version,
					created_at = excluded.created_at`,
			)
			.run(entityId, dekVersion, now);
	}

	/** Clear the pending mark for `entityId` (drain succeeded, or superseded). */
	remove(entityId: string): number {
		const result = this.db.prepare("DELETE FROM pending_rotations WHERE entity_id = ?").run(entityId);
		return Number(result.changes);
	}

	/** Every entity awaiting delivery, oldest first — the drain order. */
	listAll(): PendingRotationRecord[] {
		const rows = this.db
			.prepare(
				"SELECT entity_id, dek_version, created_at FROM pending_rotations ORDER BY created_at, entity_id",
			)
			.all() as PendingRotationRow[];
		return rows.map((r) => ({
			entityId: r.entity_id,
			dekVersion: r.dek_version,
			createdAt: r.created_at,
		}));
	}

	/** Whether `entityId` currently has a pending mark (test/introspection). */
	has(entityId: string): boolean {
		const row = this.db.prepare("SELECT 1 FROM pending_rotations WHERE entity_id = ?").get(entityId);
		return row !== undefined;
	}
}
