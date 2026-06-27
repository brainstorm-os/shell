/**
 * The blob-plane content-addressed store (CAS) client contract.
 *
 * Asset chunks are stored and fetched by the sha256 of their **ciphertext**
 * (design [data/70 §The asset CAS]). The durable node (Asset-B3) implements
 * this over the wire (`WireKind.Asset` request/response, relay-blind, admitted
 * by the SYNC-4 two-proof handshake); `MemoryAssetCas` here backs the client
 * transport's tests + an ephemeral run.
 *
 * Three verbs only — no pub/sub (distinct from the Y.Doc control channel):
 *   - `has(hash)` so the client skips chunks already on the node before PUT,
 *   - `put(hash, chunk)` to upload a sealed chunk (idempotent by address),
 *   - `get(hash)` to fetch one for reassembly.
 * The store never holds a key and never sees plaintext — it is a dumb,
 * zero-knowledge byte cache keyed by ciphertext-hash.
 */

export interface AssetCas {
	/** True if a chunk with this ciphertext-hash is already stored (skip the PUT). */
	has(hash: string): Promise<boolean>;
	/** Store a sealed chunk under its ciphertext-hash. Idempotent — re-PUTting
	 *  the same address is a no-op. */
	put(hash: string, chunk: Uint8Array): Promise<void>;
	/** Fetch a sealed chunk by ciphertext-hash, or null if absent. */
	get(hash: string): Promise<Uint8Array | null>;
}

/** In-memory CAS — tests + ephemeral (no-durability) runs. */
export class MemoryAssetCas implements AssetCas {
	readonly #chunks = new Map<string, Uint8Array>();

	async has(hash: string): Promise<boolean> {
		return this.#chunks.has(hash);
	}

	async put(hash: string, chunk: Uint8Array): Promise<void> {
		// Defensive copy — the caller may reuse the buffer after PUT.
		if (!this.#chunks.has(hash)) this.#chunks.set(hash, new Uint8Array(chunk));
	}

	async get(hash: string): Promise<Uint8Array | null> {
		const stored = this.#chunks.get(hash);
		return stored ? new Uint8Array(stored) : null;
	}

	/** Test/diagnostic: number of distinct chunks held. */
	get size(): number {
		return this.#chunks.size;
	}
}
