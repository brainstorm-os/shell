/**
 * AssetsRepository — CRUD on `entities.db`'s `assets` table (binary-asset
 * subsystem). Per the Stage 5 repository-pattern decision, all SQL for the
 * table lives here; `AssetStore` is pure orchestration on top.
 *
 * One row per stored blob. The blob bytes live off-DB at
 * `<vault>/data/assets/<prefix>/<asset_id>.enc`; this row is the metadata +
 * the `dek_id` linking to the wrapped per-asset DEK in `asset_deks`.
 * `content_hash` is a LOCAL-ONLY plaintext sha256 for dedupe hints — it
 * never crosses the sync wire (OQ-236). `bound_at` is null while the asset
 * is a preview-minted orphan and is stamped when an entity binds it; the
 * partial index on `bound_at IS NULL` keeps the TTL-reap scan cheap.
 */

import type { SqliteDatabase, SqliteStatement } from "@brainstorm-os/sqlite";
import type { AssetKind } from "../../assets/asset-types";

export type AssetRecord = {
	assetId: string;
	dekId: string;
	contentHash: string;
	mime: string;
	byteLen: number;
	kind: AssetKind;
	originUrl: string | null;
	createdAt: number;
	boundAt: number | null;
};

export type CreateAssetInput = {
	assetId: string;
	dekId: string;
	contentHash: string;
	mime: string;
	byteLen: number;
	kind: AssetKind;
	originUrl?: string | null;
	now: number;
};

type DbAssetRow = {
	asset_id: string;
	dek_id: string;
	content_hash: string;
	mime: string;
	byte_len: number;
	kind: string;
	origin_url: string | null;
	created_at: number;
	bound_at: number | null;
};

export class AssetsRepository {
	private readonly statements = new Map<string, SqliteStatement>();

	constructor(private readonly db: SqliteDatabase) {}

	private stmt(sql: string): SqliteStatement {
		const cached = this.statements.get(sql);
		if (cached) return cached;
		const prepared = this.db.prepare(sql);
		this.statements.set(sql, prepared);
		return prepared;
	}

	create(input: CreateAssetInput): void {
		this.stmt(
			"INSERT INTO assets (asset_id, dek_id, content_hash, mime, byte_len, kind, origin_url, created_at, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
		).run(
			input.assetId,
			input.dekId,
			input.contentHash,
			input.mime,
			input.byteLen,
			input.kind,
			input.originUrl ?? null,
			input.now,
		);
	}

	getById(assetId: string): AssetRecord | null {
		const row = this.stmt(
			"SELECT asset_id, dek_id, content_hash, mime, byte_len, kind, origin_url, created_at, bound_at FROM assets WHERE asset_id = ?",
		).get(assetId) as DbAssetRow | undefined;
		return row ? rowToRecord(row) : null;
	}

	/** Asset-B5 — backfill `content_hash` on a reconstructed row, ONLY while it
	 *  still carries the empty sentinel (the guard is in the SQL so a set hash
	 *  can never be overwritten). Returns true when a row was updated. */
	setContentHashIfUnset(assetId: string, contentHash: string): boolean {
		const result = this.stmt(
			"UPDATE assets SET content_hash = ? WHERE asset_id = ? AND content_hash = ''",
		).run(contentHash, assetId);
		return Number(result.changes) > 0;
	}

	/** Stamp `bound_at` so the asset is no longer a reap-eligible orphan.
	 *  Returns true when a row was updated. */
	markBound(assetId: string, now: number): boolean {
		const result = this.stmt("UPDATE assets SET bound_at = ? WHERE asset_id = ?").run(now, assetId);
		return Number(result.changes) > 0;
	}

	/** Orphans (never bound) created before `cutoff` — the TTL-reap set for
	 *  preview-minted assets the user never saved. */
	listUnboundCreatedBefore(cutoff: number): AssetRecord[] {
		const rows = this.stmt(
			"SELECT asset_id, dek_id, content_hash, mime, byte_len, kind, origin_url, created_at, bound_at FROM assets WHERE bound_at IS NULL AND created_at < ?",
		).all(cutoff) as DbAssetRow[];
		return rows.map(rowToRecord);
	}

	/** Every bound (saved, non-orphan) asset, newest first — the Files
	 *  storage inventory. Orphans are transient preview-mints awaiting the
	 *  TTL reap, so they're excluded from the user-facing list. */
	listBound(): AssetRecord[] {
		const rows = this.stmt(
			"SELECT asset_id, dek_id, content_hash, mime, byte_len, kind, origin_url, created_at, bound_at FROM assets WHERE bound_at IS NOT NULL ORDER BY created_at DESC",
		).all() as DbAssetRow[];
		return rows.map(rowToRecord);
	}

	delete(assetId: string): boolean {
		const result = this.stmt("DELETE FROM assets WHERE asset_id = ?").run(assetId);
		return Number(result.changes) > 0;
	}
}

function rowToRecord(row: DbAssetRow): AssetRecord {
	return {
		assetId: row.asset_id,
		dekId: row.dek_id,
		contentHash: row.content_hash,
		mime: row.mime,
		byteLen: row.byte_len,
		kind: row.kind as AssetKind,
		originUrl: row.origin_url,
		createdAt: row.created_at,
		boundAt: row.bound_at,
	};
}
