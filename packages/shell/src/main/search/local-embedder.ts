/**
 * `FastembedEmbedder` — the real local embedding model for semantic search
 * (plan 11.3), dropped into the `TextEmbedder` seam 11.2 built. Wraps the
 * `@brainstorm/native-embed` NAPI addon (fastembed-rs / ONNX Runtime,
 * `bge-small-en-v1.5`, 384-d). Embeddings are computed on-device; content never
 * leaves the machine (the addon has no network beyond the one-time model-weight
 * download).
 *
 * The addon is loaded lazily + defensively (`loadFastembedEmbedder`): a platform
 * without a prebuilt `.node`, or an ONNX Runtime that fails to load, returns
 * null so search degrades to lexical-only rather than crashing — the same
 * graceful-degrade posture `createVectorIndexer` already uses when `sqlite-vec`
 * can't load. Model swaps (MiniLM, multilingual-e5-small) are a one-line change
 * in the Rust crate as long as they stay 384-d (no vec0 migration).
 */

import { EMBEDDING_DIM, type TextEmbedder } from "./embedder";
import {
	type EmbedderDownloadProgress,
	type SemanticModelStatus,
	applyProgress,
	initialStatus,
	markFailed,
	markReady,
	markStarted,
} from "./embedder-status";

/** Sink for live semantic-model download status (plan 11.3 progress UX). The
 *  shell holds the latest snapshot + exposes it to Settings → Search. */
export type StatusSink = (status: SemanticModelStatus) => void;

/** The subset of `@brainstorm/native-embed` this seam uses. */
export type EmbedNative = {
	/** Build/load the model, downloading weights into `cacheDir` on first run.
	 *  Idempotent; resolves when ready to embed. `onProgress` (optional — older
	 *  `.node`s omit it) is invoked per pinned file with cumulative byte
	 *  progress so the first-run download can render a bar. */
	embedderInit(
		cacheDir: string,
		onProgress?: (progress: EmbedderDownloadProgress) => void,
	): Promise<void>;
	/** Whether `embedderInit` has completed. */
	embedderReady(): boolean;
	/** The model's output dimension. */
	embedDim(): number;
	/** Embed `texts` into a flat row-major Float32Array (`texts.length * dim`). */
	embedBatch(texts: string[]): Promise<Float32Array>;
};

export class FastembedEmbedder implements TextEmbedder {
	readonly name = "bge-small-en-v1.5";
	readonly dim = EMBEDDING_DIM;
	readonly #native: EmbedNative;
	readonly #cacheDir: string;
	readonly #onStatus: StatusSink;
	#status: SemanticModelStatus = initialStatus();
	#ready: Promise<void> | null = null;

	constructor(native: EmbedNative, cacheDir: string, onStatus?: StatusSink) {
		this.#native = native;
		this.#cacheDir = cacheDir;
		this.#onStatus = onStatus ?? (() => {});
	}

	#emit(status: SemanticModelStatus): void {
		this.#status = status;
		this.#onStatus(status);
	}

	/** Idempotent, single-flight model init — the ~130 MB first-run download
	 *  runs once, off the JS thread (the addon uses the libuv threadpool). Folds
	 *  the native per-file byte progress into a live {@link SemanticModelStatus}
	 *  so Settings → Search can render a download bar (11.3 progress UX). */
	#ensureReady(): Promise<void> {
		if (!this.#ready) {
			this.#emit(markStarted());
			this.#ready = this.#native
				.embedderInit(this.#cacheDir, (progress) => {
					this.#emit(applyProgress(this.#status, progress));
				})
				.then(() => {
					this.#emit(markReady());
				})
				.catch((error) => {
					// Reset so a transient failure (e.g. offline first-run) can retry
					// on the next embed rather than latching a rejected promise.
					this.#ready = null;
					this.#emit(markFailed((error as Error).message ?? String(error)));
					throw error;
				});
		}
		return this.#ready;
	}

	async embed(text: string): Promise<Float32Array> {
		await this.#ensureReady();
		const flat = await this.#native.embedBatch([text]);
		if (flat.length !== this.dim) {
			throw new Error(`FastembedEmbedder: expected ${this.dim} dims, got ${flat.length}`);
		}
		return flat;
	}

	/** Batch variant — one native round-trip for many texts, reshaped into
	 *  per-text 384-d views. Used by the full-vault rebuild path (far cheaper
	 *  than N single embeds). Each returned view is a copy-free slice of the
	 *  flat buffer. */
	async embedMany(texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		await this.#ensureReady();
		const flat = await this.#native.embedBatch(texts);
		const expected = texts.length * this.dim;
		if (flat.length !== expected) {
			throw new Error(`FastembedEmbedder: expected ${expected} dims, got ${flat.length}`);
		}
		const out: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += 1) {
			out.push(flat.subarray(i * this.dim, (i + 1) * this.dim));
		}
		return out;
	}
}

/**
 * Validate a loaded native module + construct the embedder, or return null when
 * it's unusable (missing exports, or a model dimension that doesn't match the
 * store's pinned `EMBEDDING_DIM`). Pure + testable — split from the dynamic
 * import so the degrade paths can be unit-tested with a fake module.
 */
export function makeEmbedderFromNative(
	native: Partial<EmbedNative>,
	cacheDir: string,
	onStatus?: StatusSink,
): FastembedEmbedder | null {
	if (
		typeof native.embedBatch !== "function" ||
		typeof native.embedderInit !== "function" ||
		typeof native.embedDim !== "function"
	) {
		return null;
	}
	const dim = native.embedDim();
	if (dim !== EMBEDDING_DIM) {
		console.warn(
			`[search] native embedder dim ${dim} != store dim ${EMBEDDING_DIM}; semantic search disabled`,
		);
		return null;
	}
	return new FastembedEmbedder(native as EmbedNative, cacheDir, onStatus);
}

/**
 * Try to construct the native embedder. Returns null when the addon can't be
 * loaded (no prebuilt `.node` for this platform, or ONNX Runtime failed to
 * initialise) so the caller keeps lexical-only search rather than crashing.
 * Note: this does NOT trigger the model download — that happens lazily on the
 * first `embed`, so a null here is purely "the native binding is absent".
 */
export async function loadFastembedEmbedder(
	cacheDir: string,
	onStatus?: StatusSink,
): Promise<FastembedEmbedder | null> {
	try {
		// Opaque specifier (mirrors the `bun:sqlite` / `better-sqlite3` dynamic
		// imports in `storage/sqlite.ts`): the addon's generated `index.d.ts` only
		// exists after the heavy ONNX-Runtime build, which the default `build:native`
		// + CI `verify` deliberately skip. Resolving the specifier through a `const`
		// keeps `tsc --noEmit` from demanding those types (the module is cast to
		// `Partial<EmbedNative>` here anyway) — otherwise a fresh checkout fails
		// typecheck on the missing declaration.
		const specifier = "@brainstorm/native-embed";
		const native = (await import(/* @vite-ignore */ specifier)) as Partial<EmbedNative>;
		return makeEmbedderFromNative(native, cacheDir, onStatus);
	} catch (error) {
		console.warn("[search] native embedder unavailable; semantic search disabled:", error);
		return null;
	}
}
