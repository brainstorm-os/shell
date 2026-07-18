/**
 * Project/Dedupe/Write orchestration (IE-2).
 *
 * Drives drafted entities through the idempotent write path: a draft with an
 * external id is upserted (existing → update, new → create); a draft without
 * one is always created. `planImport` is the required non-destructive dry-run
 * (doc 45 §The import flow: "every importer must implement dryRun separately
 * from run") — it reports the same create/update split run would take, without
 * writing. Both share the dedupe decision so the plan can't drift from the run.
 */

import {
	type EntityDraft,
	type ImportPlan,
	type ImportRunOptions,
	type ImportRunReport,
	type ImportWriteDeps,
	externalKeyOf,
} from "./import-types";

/** Yield to the event loop every N drafts so progress IPC flushes + an abort
 *  set mid-run is observed (the engine runs on the main thread until the
 *  utility-worker batching rung lands). */
const YIELD_EVERY = 50;

/** REAL event-loop yield. `await Promise.resolve()` only drains microtasks —
 *  IPC, input, and paint never run, so a big import froze every window
 *  (owner report 2026-07-18). setImmediate parks until the next macrotask
 *  turn, letting the main process breathe between batches. */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function dedupeKey(draft: EntityDraft, source: string): string | null {
	return draft.externalId === null ? null : externalKeyOf(source, draft.externalId);
}

/** Non-destructive scan: what `runImport` would do, by the count. */
export function planImport(
	drafts: readonly EntityDraft[],
	source: string,
	resolve: Pick<ImportWriteDeps, "findByExternalKey">,
): ImportPlan {
	let willCreate = 0;
	let willUpdate = 0;
	const byType: Record<string, number> = {};
	for (const draft of drafts) {
		byType[draft.type] = (byType[draft.type] ?? 0) + 1;
		const key = dedupeKey(draft, source);
		if (key !== null && resolve.findByExternalKey(key) !== null) willUpdate++;
		else willCreate++;
	}
	return { total: drafts.length, willCreate, willUpdate, byType, warnings: [] };
}

/** Commit drafts idempotently. Atomic per entity, continue-on-error by default
 *  (doc 45 §partial-failure semantics): a failing draft is recorded and the run
 *  continues. Streams progress + honours an abort signal (doc 45 §Streaming):
 *  the loop yields to the event loop periodically so a `signal` flipped mid-run
 *  is seen and the remaining drafts are `skipped`. */
export async function runImport(
	drafts: readonly EntityDraft[],
	source: string,
	deps: ImportWriteDeps,
	now: number,
	options: ImportRunOptions = {},
): Promise<ImportRunReport> {
	const { onProgress, signal } = options;
	const total = drafts.length;
	let created = 0;
	let updated = 0;
	let cancelled = false;
	const failed: Array<{ externalId: string | null; reason: string }> = [];
	let i = 0;
	for (; i < total; i++) {
		if (signal?.aborted) {
			cancelled = true;
			break;
		}
		const draft = drafts[i] as EntityDraft;
		try {
			const key = dedupeKey(draft, source);
			const existing = key !== null ? deps.findByExternalKey(key) : null;
			if (existing !== null) {
				deps.update(existing, draft.properties, now);
				updated++;
			} else {
				deps.create(draft, key, now);
				created++;
			}
		} catch (error) {
			failed.push({
				externalId: draft.externalId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
		onProgress?.(i + 1, total);
		if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
	}
	const skipped = total - i;
	return { created, updated, skipped, failed, ...(cancelled ? { cancelled: true } : {}) };
}
