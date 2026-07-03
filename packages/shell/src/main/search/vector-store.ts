/**
 * `VectorStore` — the storage seam for one embedding per entity, queried by
 * nearest-neighbour. Two implementations:
 *
 *   - `SqliteVecStore` (sqlite-vec, in `search.db`) — the production path.
 *     `bun:sqlite` (the test runtime) cannot load dynamic extensions, so it
 *     is exercised in real Electron, not vitest (the same real-runtime
 *     deferral the 9.3.5.N5 editor bench used).
 *   - `InMemoryVectorStore` (this file) — a pure cosine store over a `Map`.
 *     It is the unit-test + bench double AND a legitimate degrade fallback,
 *     because the index is rebuildable-from-sources (the same invariant the
 *     FTS5 indexer relies on).
 *
 * Embeddings are L2-normalized unit vectors (see `embedder.ts`), so cosine
 * and L2 ranking coincide; the store reports **cosine distance**
 * (`1 - cosine_similarity`, smaller = closer) to match the
 * `distance_metric=cosine` vec0 table the production store creates.
 */

export type VectorRow = {
	entityId: string;
	type: string;
	ownerAppId: string;
	updatedAt: number;
	embedding: Float32Array;
};

export type VectorHit = {
	entityId: string;
	type: string;
	ownerAppId: string;
	updatedAt: number;
	/** Cosine distance — smaller is nearer. */
	distance: number;
};

export interface VectorStore {
	readonly dim: number;
	/** Insert or replace the vector for one entity. Throws if the embedding
	 *  length doesn't match `dim` (fail-closed — a dimension drift between
	 *  the embedder and the table would silently corrupt results). */
	upsert(row: VectorRow): void;
	remove(entityId: string): void;
	/** `k` nearest by ascending cosine distance, optionally restricted to
	 *  `types`. */
	queryNearest(embedding: Float32Array, k: number, types?: readonly string[]): VectorHit[];
	count(): number;
	clear(): void;
	/** Atomically replace the whole store with `rows`. */
	rebuild(rows: Iterable<VectorRow>): void;
	/** Every entity id currently in the store. Used by `VectorIndexer.reconcile`
	 *  to reap vectors for entities that no longer exist (or went blank) without
	 *  re-reading their embeddings. */
	snapshotIds(): Set<string>;
	dispose(): void;
}

const DEFAULT_K = 50;
const HARD_K = 200;

export function clampK(k: number | undefined): number {
	if (typeof k !== "number" || !Number.isFinite(k) || k <= 0) return DEFAULT_K;
	return Math.min(Math.floor(k), HARD_K);
}

/** Assert an embedding matches the store dimension. Centralised so both
 *  store implementations fail closed identically. */
export function assertDim(embedding: Float32Array, dim: number): void {
	if (embedding.length !== dim) {
		throw new Error(`VectorStore: embedding length ${embedding.length} != table dimension ${dim}`);
	}
}

/** Raw little-endian float32 bytes — the BLOB form sqlite-vec stores. A
 *  fresh copy (not a view) so the caller's buffer can be reused/freed. */
export function embeddingToBlob(embedding: Float32Array): Uint8Array {
	return new Uint8Array(
		embedding.buffer.slice(embedding.byteOffset, embedding.byteOffset + embedding.byteLength),
	);
}

export function blobToEmbedding(blob: Uint8Array): Float32Array {
	const copy = blob.slice();
	return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/** Cosine distance between two equal-length vectors (`1 - sim`). Defensive
 *  about non-unit inputs so a future un-normalized embedder can't silently
 *  skew ranking; for unit vectors this is `1 - dot`. Orthogonal-to-a-zero
 *  vector → distance 1 (maximally far), never NaN. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 1;
	return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class InMemoryVectorStore implements VectorStore {
	readonly dim: number;
	private rows = new Map<string, VectorRow>();
	private disposed = false;

	constructor(dim: number) {
		this.dim = dim;
	}

	upsert(row: VectorRow): void {
		this.assertOpen();
		assertDim(row.embedding, this.dim);
		// Defensive copy so a caller mutating its buffer can't alter stored
		// state (mirrors the persistent store, which serialises to bytes).
		this.rows.set(row.entityId, { ...row, embedding: row.embedding.slice() });
	}

	remove(entityId: string): void {
		this.assertOpen();
		this.rows.delete(entityId);
	}

	queryNearest(embedding: Float32Array, k: number, types?: readonly string[]): VectorHit[] {
		this.assertOpen();
		assertDim(embedding, this.dim);
		const limit = clampK(k);
		const typeSet = types && types.length > 0 ? new Set(types) : null;
		const hits: VectorHit[] = [];
		for (const row of this.rows.values()) {
			if (typeSet && !typeSet.has(row.type)) continue;
			hits.push({
				entityId: row.entityId,
				type: row.type,
				ownerAppId: row.ownerAppId,
				updatedAt: row.updatedAt,
				distance: cosineDistance(embedding, row.embedding),
			});
		}
		hits.sort((x, y) => x.distance - y.distance || y.updatedAt - x.updatedAt);
		return hits.slice(0, limit);
	}

	count(): number {
		this.assertOpen();
		return this.rows.size;
	}

	clear(): void {
		this.assertOpen();
		this.rows.clear();
	}

	rebuild(rows: Iterable<VectorRow>): void {
		this.assertOpen();
		const next = new Map<string, VectorRow>();
		for (const row of rows) {
			assertDim(row.embedding, this.dim);
			next.set(row.entityId, { ...row, embedding: row.embedding.slice() });
		}
		this.rows = next;
	}

	snapshotIds(): Set<string> {
		this.assertOpen();
		return new Set(this.rows.keys());
	}

	dispose(): void {
		this.disposed = true;
		this.rows.clear();
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("InMemoryVectorStore: disposed");
	}
}
