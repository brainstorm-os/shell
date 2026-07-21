/**
 * EntityDeksRepository — CRUD on `entities.db`'s `entity_deks` table
 * (Stage 10.1).
 *
 * Per the Stage 5 repository-pattern decision, all SQL for this table
 * lives here; the entities service / `EntityDekStore` (Stage 10.1) is pure
 * orchestration on top.
 *
 * Per §3.1 and
 * , each row stores one
 * per-entity Data Encryption Key, sealed under the vault master key
 * (XChaCha20-Poly1305 via `sealSecret`). The wrap binds to the entity id
 * via AAD (defense vs. DEK-swap); enforcement of that binding lives in
 * `EntityDekStore.open()`.
 *
 * Multi-row support per entity is forward-allocated for the rotation path
 * (Stage 10.2 / OQ-27). 10.1 writes exactly one row at create; readers use
 * `getByEntityId` which returns the **most-recent-by-`created_at`** row —
 * the rotation policy when 10.2 lands.
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import { type SealedSecret, isSealedSecret } from "../../credentials/crypto";

export type EntityDekRecord = {
	dekId: string;
	entityId: string;
	version: number;
	sealedDek: SealedSecret;
	createdAt: number;
};

export type CreateEntityDekInput = {
	dekId: string;
	entityId: string;
	sealedDek: SealedSecret;
	/** Optional — defaults to 1. Reserved for the rotation path (10.2). */
	version?: number;
	now: number;
};

type DbEntityDekRow = {
	dek_id: string;
	entity_id: string;
	version: number;
	sealed_dek_json: string;
	created_at: number;
};

export class EntityDeksRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	create(input: CreateEntityDekInput): void {
		if (!isSealedSecret(input.sealedDek)) {
			throw new Error("EntityDeksRepository.create: invalid sealedDek shape");
		}
		this.stmt(
			"INSERT INTO entity_deks (dek_id, entity_id, version, sealed_dek_json, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(
			input.dekId,
			input.entityId,
			input.version ?? 1,
			JSON.stringify(input.sealedDek),
			input.now,
		);
	}

	/**
	 * Current live DEK row for an entity, or null when no row exists.
	 * Ordering = `version DESC, created_at DESC, dek_id DESC`. **`version` is
	 * the primary key** — the monotonic rotation ordinal (ROT-3a-i). It must
	 * lead so a replayed old wrap installed with a *newer* `created_at` can't
	 * win: the anti-rollback guarantee is "highest ordinal is current", not
	 * "most-recently written". `created_at` + `dek_id` are deterministic
	 * tie-breaks (deterministic-clock tests + 10.1's single-row policy can tie
	 * on version=1). 10.2 rotation picks the newest via the same call.
	 */
	getByEntityId(entityId: string): EntityDekRecord | null {
		const row = this.stmt(
			"SELECT dek_id, entity_id, version, sealed_dek_json, created_at FROM entity_deks WHERE entity_id = ? ORDER BY version DESC, created_at DESC, dek_id DESC LIMIT 1",
		).get(entityId) as DbEntityDekRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/** The highest DEK `version` on record for `entityId`, or 0 when none.
	 *  The owner mint path allocates `maxVersionForEntity + 1`; the survivor
	 *  install path compares an incoming wrap's ordinal against the current
	 *  row (via {@link getByEntityId}). */
	maxVersionForEntity(entityId: string): number {
		const row = this.stmt("SELECT MAX(version) AS maxv FROM entity_deks WHERE entity_id = ?").get(
			entityId,
		) as { maxv: number | null } | undefined;
		return row?.maxv ?? 0;
	}

	deleteByEntityId(entityId: string): number {
		const result = this.stmt("DELETE FROM entity_deks WHERE entity_id = ?").run(entityId);
		return Number(result.changes);
	}

	delete(dekId: string): boolean {
		const result = this.stmt("DELETE FROM entity_deks WHERE dek_id = ?").run(dekId);
		return Number(result.changes) > 0;
	}
}

function rowToRecord(row: DbEntityDekRow): EntityDekRecord {
	const parsed = JSON.parse(row.sealed_dek_json) as unknown;
	if (!isSealedSecret(parsed)) {
		throw new Error(
			`entity_deks: malformed sealed_dek_json for dek_id=${row.dek_id} (entity=${row.entity_id})`,
		);
	}
	return {
		dekId: row.dek_id,
		entityId: row.entity_id,
		version: row.version,
		sealedDek: parsed,
		createdAt: row.created_at,
	};
}
