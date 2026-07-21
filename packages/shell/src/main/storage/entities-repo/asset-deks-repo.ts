/**
 * AssetDeksRepository — CRUD on `entities.db`'s `asset_deks` table
 * (binary-asset subsystem).
 *
 * Structurally identical to `entity-deks-repo.ts`: one row per per-asset
 * Data Encryption Key, sealed under the vault master key
 * (XChaCha20-Poly1305 via `sealSecret`). The wrap binds to the asset id via
 * AAD with a DISTINCT domain prefix (`brainstorm/asset-dek/v1:`) so an asset
 * wrap can never be confused with an entity wrap; enforcement lives in
 * `AssetDekStore.open()`. `version` is forward-allocated for a future
 * rotation path; today exactly one row is written per asset at create.
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import { type SealedSecret, isSealedSecret } from "../../credentials/crypto";

export type AssetDekRecord = {
	dekId: string;
	assetId: string;
	version: number;
	sealedDek: SealedSecret;
	createdAt: number;
};

export type CreateAssetDekInput = {
	dekId: string;
	assetId: string;
	sealedDek: SealedSecret;
	/** Optional — defaults to 1. Reserved for a future rotation path. */
	version?: number;
	now: number;
};

type DbAssetDekRow = {
	dek_id: string;
	asset_id: string;
	version: number;
	sealed_dek_json: string;
	created_at: number;
};

export class AssetDeksRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	create(input: CreateAssetDekInput): void {
		if (!isSealedSecret(input.sealedDek)) {
			throw new Error("AssetDeksRepository.create: invalid sealedDek shape");
		}
		this.stmt(
			"INSERT INTO asset_deks (dek_id, asset_id, version, sealed_dek_json, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(input.dekId, input.assetId, input.version ?? 1, JSON.stringify(input.sealedDek), input.now);
	}

	/**
	 * Most-recent live DEK row for an asset, or null. Ordering mirrors
	 * `entity-deks-repo` (`created_at DESC, version DESC, dek_id DESC`) so
	 * the result is deterministic across `bun:sqlite` and `better-sqlite3`.
	 */
	getByAssetId(assetId: string): AssetDekRecord | null {
		const row = this.stmt(
			"SELECT dek_id, asset_id, version, sealed_dek_json, created_at FROM asset_deks WHERE asset_id = ? ORDER BY created_at DESC, version DESC, dek_id DESC LIMIT 1",
		).get(assetId) as DbAssetDekRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	deleteByAssetId(assetId: string): number {
		const result = this.stmt("DELETE FROM asset_deks WHERE asset_id = ?").run(assetId);
		return Number(result.changes);
	}
}

function rowToRecord(row: DbAssetDekRow): AssetDekRecord {
	const parsed = JSON.parse(row.sealed_dek_json) as unknown;
	if (!isSealedSecret(parsed)) {
		throw new Error(
			`asset_deks: malformed sealed_dek_json for dek_id=${row.dek_id} (asset=${row.asset_id})`,
		);
	}
	return {
		dekId: row.dek_id,
		assetId: row.asset_id,
		version: row.version,
		sealedDek: parsed,
		createdAt: row.created_at,
	};
}
