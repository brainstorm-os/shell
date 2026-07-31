/**
 * Stage 10.14 — `RestoreEngine`: cold-device restore-from-zero orchestration.
 *
 * A wiped-but-keystore-intact device (its X25519 + master key survive, its
 * `entities.db` is empty) recovers its synced entities from the durable node:
 *
 *   1. **catalog** — ask the node for this account's entity ids + latest
 *      snapshot versions (`RelaySurface.requestCatalog`). The account key is
 *      the device's wire `sender` (base64url); the node recorded it from the
 *      plaintext routing header (SYNC-4a).
 *   2. **subscribe (ungated)** — `LiveSyncEngine.trackForRestoreBatch(ids)`
 *      tracks every catalog entity WITHOUT the `isShared` gate (the catalog
 *      already asserts ownership) and batch-subscribes the relay channels in
 *      chunked `bundle:true` controls (10.10), so a durable node streams the
 *      backfill as bundled frames instead of one message per frame.
 *   3. **backfill applies through the live engine** — the node streams
 *      `wraps ++ snapshot ++ tail` per entity. The wrap installs the DEK and
 *      (via the engine's `installWrap` wiring) materializes the `entities.db`
 *      row from the recovered `type`; the snapshot + tail then apply onto that
 *      row through the normal remote-apply path. No frame handling is
 *      re-implemented here — that all lives in `LiveSyncEngine`.
 * Search reindex is the caller's job (the IPC handler rebuilds the index once
 * the pass returns) — the remote-apply path materializes the row + doc but
 * doesn't touch the index.
 *
 * Completion is **quiescence-based** (initial sync is streamed, not
 * all-or-nothing per): restore resolves when every catalog entry
 * has come back, OR no new entity has landed for `quietMs`, OR the overall
 * timeout elapses — whichever first. Partial restore is a valid outcome (the
 * rest backfill lazily on access); the summary reports what came back.
 *
 * Out of scope (still gated): a fully-cold device that LOST its keystore needs
 * account recovery (security/51) to re-establish identity + re-provision DEKs.
 */

import type { LiveSyncEngine } from "./live-sync-engine";
import type { CatalogEntry } from "./relay-port";

export type RestoreSummary = {
	/** Entities the catalog listed. */
	requested: number;
	/** Entities whose DEK + row were recovered. */
	restored: number;
	/** The recovered entity ids (a subset of the catalog on a partial restore). */
	entityIds: string[];
	/** True if every catalog entry came back; false on a quiesced/timed-out partial. */
	complete: boolean;
};

export type RestoreProgress = { requested: number; restored: number };

export type RestoreEngineContext = {
	/** The device's wire `sender` (base64url) — the node's account catalog key. */
	account: string;
	/** Issue the catalog query (`RelaySurface.requestCatalog`). */
	requestCatalog: (account: string) => Promise<CatalogEntry[]>;
	/** The live-sync engine — drives ungated subscribe + applies the backfill. */
	engine: Pick<LiveSyncEngine, "trackForRestoreBatch" | "restoredType" | "whenIdle">;
	/** Progress callback fired as entities settle. Optional. */
	onProgress?: (progress: RestoreProgress) => void;
	/** Quiescence window: stop once no new entity has come back for this long.
	 *  Default 1500 ms. */
	quietMs?: number;
	/** Poll interval between quiescence checks. Default 100 ms. */
	pollMs?: number;
	/** Hard cap on the whole restore. Default 120 s. */
	overallTimeoutMs?: number;
	/** Injectable delay (tests). Default `setTimeout`. */
	delay?: (ms: number) => Promise<void>;
	/** Injectable clock (tests). Default `Date.now`. */
	nowMs?: () => number;
};

const DEFAULT_QUIET_MS = 1_500;
const DEFAULT_POLL_MS = 100;
const DEFAULT_OVERALL_TIMEOUT_MS = 120_000;

export class RestoreEngine {
	readonly #ctx: RestoreEngineContext;
	readonly #quietMs: number;
	readonly #pollMs: number;
	readonly #overallTimeoutMs: number;
	readonly #delay: (ms: number) => Promise<void>;
	readonly #now: () => number;
	#running = false;

	constructor(ctx: RestoreEngineContext) {
		this.#ctx = ctx;
		this.#quietMs = ctx.quietMs ?? DEFAULT_QUIET_MS;
		this.#pollMs = ctx.pollMs ?? DEFAULT_POLL_MS;
		this.#overallTimeoutMs = ctx.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
		this.#delay = ctx.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.#now = ctx.nowMs ?? (() => Date.now());
	}

	/** Run a restore pass. Rejects only on a catalog-fetch failure; a partial
	 *  apply (some entities never settle) resolves with `complete: false`. */
	async restore(): Promise<RestoreSummary> {
		if (this.#running) throw new Error("RestoreEngine.restore: already running");
		this.#running = true;
		try {
			const entries = await this.#ctx.requestCatalog(this.#ctx.account);
			if (entries.length === 0) {
				return { requested: 0, restored: 0, entityIds: [], complete: true };
			}
			// 10.10 — batch-track the whole catalog: one pass, chunked bundle:true
			// subscribes, so a durable node streams the backfill as bundled frames
			// (an old node falls back to the per-frame stream transparently).
			this.#ctx.engine.trackForRestoreBatch(entries.map((entry) => entry.entityId));
			await this.#awaitBackfill(entries);
			// Settle the apply chain once more so the snapshot/tail behind the
			// last-counted wrap have landed before we read rows to reindex.
			await this.#ctx.engine.whenIdle();
			const entityIds = entries
				.map((e) => e.entityId)
				.filter((id) => this.#ctx.engine.restoredType(id) !== null);
			return {
				requested: entries.length,
				restored: entityIds.length,
				entityIds,
				complete: entityIds.length === entries.length,
			};
		} finally {
			this.#running = false;
		}
	}

	/** Block until every entry is recovered, the stream quiesces, or the
	 *  overall timeout elapses. */
	async #awaitBackfill(entries: CatalogEntry[]): Promise<void> {
		const start = this.#now();
		let lastCount = -1;
		let lastChangeAt = start;
		for (;;) {
			await this.#ctx.engine.whenIdle();
			const restored = entries.reduce(
				(n, e) => n + (this.#ctx.engine.restoredType(e.entityId) !== null ? 1 : 0),
				0,
			);
			if (restored !== lastCount) {
				lastCount = restored;
				lastChangeAt = this.#now();
				this.#ctx.onProgress?.({ requested: entries.length, restored });
			}
			if (restored === entries.length) return;
			if (this.#now() - lastChangeAt >= this.#quietMs) return;
			if (this.#now() - start >= this.#overallTimeoutMs) return;
			await this.#delay(this.#pollMs);
		}
	}
}
