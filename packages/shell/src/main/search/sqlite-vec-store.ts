/**
 * `SqliteVecStore` — the production `VectorStore`, backed by a sqlite-vec
 * `vec0` virtual table in `search.db`. Co-located with FTS5 so the vector
 * index rides the same encryption-at-rest envelope and the same
 * rebuildable-from-sources invariant (per
 * §vector index).
 *
 * NOT unit-tested in this repo's harness: vitest runs under `bun:sqlite`,
 * whose sqlite build rejects dynamic extension loading, so `vec0` is
 * unreachable there. The semantics are pinned by `InMemoryVectorStore`
 * (the tested reference with identical contract) and this store is exercised
 * in real Electron — the same real-runtime deferral 9.3.5.N5 used for the
 * editor bench. Keep this class THIN (SQL binding only); all reusable logic
 * lives in `VectorIndexer`, which is tested against the in-memory store.
 *
 * The vec0 table + sidecar DDL run in the constructor (mirroring
 * `SearchIndexer`'s sidecar DDL), NOT in the schema migration list — a
 * `CREATE VIRTUAL TABLE ... vec0` in a migration would throw "no such
 * module: vec0" on every search.db open where the extension didn't load
 * (i.e. every test run). The store is only constructed after a successful
 * `loadVecExtension()`, so the DDL is always safe here.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import {
	type VectorHit,
	type VectorRow,
	type VectorStore,
	assertDim,
	blobToEmbedding,
	clampK,
	embeddingToBlob,
} from "./vector-store";

/** A metadata sidecar mirroring the FTS5 indexer's pattern: vec0 holds the
 *  vector keyed by entity_id; the sidecar holds the filterable/returnable
 *  metadata (type, owner, updated_at) joined on entity_id. Keeping metadata
 *  out of vec0 avoids depending on vec0's auxiliary-column / metadata-filter
 *  syntax, which varies across sqlite-vec versions. */
function sidecarDdl(): string {
	return `
CREATE TABLE IF NOT EXISTS entity_vec_meta (
	entity_id    TEXT PRIMARY KEY,
	type         TEXT NOT NULL,
	owner_app_id TEXT NOT NULL,
	updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_vec_meta_type ON entity_vec_meta(type);
`;
}

export class SqliteVecStore implements VectorStore {
	readonly dim: number;
	private readonly db: SqliteDatabase;
	private disposed = false;

	constructor(db: SqliteDatabase, dim: number) {
		this.db = db;
		this.dim = dim;
		// `dim` is a trusted compile-time constant (EMBEDDING_DIM), never user
		// input — safe to interpolate (DDL can't be parameterised). cosine
		// metric so ranking matches the InMemory reference (unit vectors).
		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS entity_vec USING vec0(entity_id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine);`,
		);
		this.db.exec(sidecarDdl());
	}

	upsert(row: VectorRow): void {
		this.assertOpen();
		assertDim(row.embedding, this.dim);
		const blob = embeddingToBlob(row.embedding);
		const fn = this.db.transaction(() => {
			this.db.prepare("DELETE FROM entity_vec WHERE entity_id = ?").run(row.entityId);
			this.db
				.prepare("INSERT INTO entity_vec (entity_id, embedding) VALUES (?, ?)")
				.run(row.entityId, blob);
			this.db
				.prepare(
					`INSERT INTO entity_vec_meta (entity_id, type, owner_app_id, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(entity_id) DO UPDATE SET type = excluded.type, owner_app_id = excluded.owner_app_id, updated_at = excluded.updated_at`,
				)
				.run(row.entityId, row.type, row.ownerAppId, row.updatedAt);
		});
		fn();
	}

	remove(entityId: string): void {
		this.assertOpen();
		const fn = this.db.transaction(() => {
			this.db.prepare("DELETE FROM entity_vec WHERE entity_id = ?").run(entityId);
			this.db.prepare("DELETE FROM entity_vec_meta WHERE entity_id = ?").run(entityId);
		});
		fn();
	}

	queryNearest(embedding: Float32Array, k: number, types?: readonly string[]): VectorHit[] {
		this.assertOpen();
		assertDim(embedding, this.dim);
		const limit = clampK(k);
		const typeFilter = types && types.length > 0 ? types : null;
		// vec0's KNN (`k = ?`) prunes BEFORE the metadata join, so a type
		// filter applied after the join could under-return. Over-fetch when a
		// type filter is present, then post-filter + trim. Over-fetch factor 4
		// (capped) is the same pragmatic post-filter-KNN trade-off the lexical
		// type filter accepts; exact-recall type filtering waits for the
		// sqlite-vec metadata-column path (validated in real Electron).
		const knnK = typeFilter ? Math.min(limit * 4, 800) : limit;
		const rows = this.db
			.prepare(
				`WITH knn AS (
					SELECT entity_id, distance FROM entity_vec
					WHERE embedding MATCH ? AND k = ?
				)
				SELECT knn.entity_id AS entity_id, knn.distance AS distance,
				       m.type AS type, m.owner_app_id AS owner_app_id, m.updated_at AS updated_at
				FROM knn JOIN entity_vec_meta AS m ON m.entity_id = knn.entity_id
				ORDER BY knn.distance ASC`,
			)
			.all(embeddingToBlob(embedding), knnK) as Array<{
			entity_id: string;
			distance: number;
			type: string | null;
			owner_app_id: string | null;
			updated_at: number | null;
		}>;

		const hits: VectorHit[] = [];
		for (const r of rows) {
			const type = r.type ?? "";
			if (typeFilter && !typeFilter.includes(type)) continue;
			hits.push({
				entityId: r.entity_id,
				type,
				ownerAppId: r.owner_app_id ?? "",
				updatedAt: r.updated_at ?? 0,
				distance: r.distance,
			});
			if (hits.length >= limit) break;
		}
		return hits;
	}

	count(): number {
		this.assertOpen();
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM entity_vec_meta").get() as { n: number };
		return row.n;
	}

	snapshotIds(): Set<string> {
		this.assertOpen();
		const rows = this.db.prepare("SELECT entity_id FROM entity_vec_meta").all() as {
			entity_id: string;
		}[];
		return new Set(rows.map((r) => r.entity_id));
	}

	clear(): void {
		this.assertOpen();
		const fn = this.db.transaction(() => {
			this.db.exec("DELETE FROM entity_vec");
			this.db.exec("DELETE FROM entity_vec_meta");
		});
		fn();
	}

	rebuild(rows: Iterable<VectorRow>): void {
		this.assertOpen();
		const fn = this.db.transaction(() => {
			this.db.exec("DELETE FROM entity_vec");
			this.db.exec("DELETE FROM entity_vec_meta");
			const insVec = this.db.prepare("INSERT INTO entity_vec (entity_id, embedding) VALUES (?, ?)");
			const insMeta = this.db.prepare(
				"INSERT OR REPLACE INTO entity_vec_meta (entity_id, type, owner_app_id, updated_at) VALUES (?, ?, ?, ?)",
			);
			for (const row of rows) {
				assertDim(row.embedding, this.dim);
				insVec.run(row.entityId, embeddingToBlob(row.embedding));
				insMeta.run(row.entityId, row.type, row.ownerAppId, row.updatedAt);
			}
		});
		fn();
	}

	/** Restore one entity's embedding from its stored BLOB — used by the
	 *  vector indexer's diagnostics, never on the query hot path. */
	getEmbedding(entityId: string): Float32Array | null {
		this.assertOpen();
		const row = this.db
			.prepare("SELECT embedding FROM entity_vec WHERE entity_id = ?")
			.get(entityId) as { embedding: Uint8Array } | undefined;
		return row ? blobToEmbedding(row.embedding) : null;
	}

	dispose(): void {
		this.disposed = true;
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("SqliteVecStore: disposed");
	}
}
