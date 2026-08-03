/**
 * Stage 10.3c — the pairing-completion **backfill**.
 *
 * The ongoing producer only fires when an entity's DEK is installed, so it
 * reaches everything created AFTER a device is paired. Everything that existed
 * BEFORE pairing would stay stranded forever — the second device would sync
 * new notes and never see a single old one. That is the other half of the hole
 * 10.3b left, and either half alone leaves the feature broken.
 *
 * Runs on the `IE-11` long-pass contract rather than a synchronous loop,
 * because this is O(entities × devices) HPKE seals on a pairing gesture: it
 * yields to the event loop periodically, reports progress, and honours an
 * abort signal. Blocking the main thread here would freeze the UI at exactly
 * the moment the user is watching a device pair.
 *
 * Never throws. One entity that cannot be sealed must not strand every entity
 * after it — the failure is counted and the pass continues, because a partial
 * backfill is strictly better than an aborted one and the next pairing event
 * re-runs it.
 */

import { yieldToEventLoop } from "../import/import-engine";
import type { WrapFanoutResult } from "./wrap-fanout";

/** Entities per yield. Small enough that the UI stays responsive through a
 *  large vault, large enough that the yields do not dominate the pass. */
export const BACKFILL_YIELD_EVERY = 25;

/** One entity the backfill should consider. `type` rides the wrap so a cold
 *  device can materialise the row (10.14). */
export type BackfillCandidate = { entityId: string; type?: string };

export type WrapBackfillDeps = {
	/** Every entity that might need fanning out. */
	listCandidates(): readonly BackfillCandidate[];
	/** The entity's current DEK + real ordinal, or null when it has none. */
	openDek(entityId: string): { dek: Uint8Array; version: number } | null;
	/** Zero the DEK handed out by `openDek`. Always called. */
	closeDek(dek: Uint8Array): void;
	fanOut(
		entityId: string,
		dek: Uint8Array,
		version: number,
		type?: string,
	): Promise<WrapFanoutResult | null>;
	onProgress?(done: number, total: number): void;
	signal?: { readonly aborted: boolean };
};

export type WrapBackfillResult = {
	/** Entities examined before the pass ended. */
	scanned: number;
	/** Entities for which at least one wrap reached the relay. */
	delivered: number;
	/** Entities skipped because they hold no DEK, or only a placeholder. */
	skipped: number;
	/** Entities whose fan-out threw. */
	failed: number;
	/** True when an abort signal ended the pass early. */
	aborted: boolean;
};

/**
 * Fan every existing entity's DEK out to the user's other devices.
 *
 * Idempotent by construction: the worker no-ops on a recipient pubkey that
 * already has a wrap, and `installEntityDek` ignores a re-delivery at an equal
 * ordinal, so re-running this after a second pairing is safe and cheap.
 */
export async function backfillWrapsForSiblings(
	deps: WrapBackfillDeps,
): Promise<WrapBackfillResult> {
	const candidates = deps.listCandidates();
	const total = candidates.length;
	let scanned = 0;
	let delivered = 0;
	let skipped = 0;
	let failed = 0;

	for (const candidate of candidates) {
		if (deps.signal?.aborted) {
			return { scanned, delivered, skipped, failed, aborted: true };
		}
		scanned += 1;
		const handle = deps.openDek(candidate.entityId);
		if (!handle) {
			skipped += 1;
		} else {
			try {
				const result = await deps.fanOut(
					candidate.entityId,
					handle.dek,
					handle.version,
					candidate.type,
				);
				// `null` (no relay / no siblings) and a placeholder refusal are
				// both "nothing to do", not failures — counting them as errors
				// would make an offline backfill look broken.
				if (result && result.sent > 0) delivered += 1;
				else skipped += 1;
				if (result && result.failed.length > 0) failed += 1;
			} catch {
				failed += 1;
			} finally {
				deps.closeDek(handle.dek);
			}
		}
		deps.onProgress?.(scanned, total);
		if (scanned % BACKFILL_YIELD_EVERY === 0) await yieldToEventLoop();
	}
	return { scanned, delivered, skipped, failed, aborted: false };
}
