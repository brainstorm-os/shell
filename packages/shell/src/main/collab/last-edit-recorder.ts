/**
 * Collab-C7 — records who last edited a shared object, at the narrowest point
 * on the sync path: the live-sync engine calls {@link LastEditRecorder.note}
 * after an inbound update's sender was authenticated (signature), authorized
 * (writer role) and the update applied, and when a local edit to a tracked
 * (shared) entity is emitted. Nothing an app sends reaches it, so the editor
 * is always a key the pipeline verified — or this device's own.
 *
 * Throttled per entity: a burst of keystrokes from one editor is one write
 * every {@link LAST_EDIT_THROTTLE_MS}; a different editor always records.
 * Fail-soft: a write failure never affects sync.
 */

import type { LastEditsRepository } from "../storage/entities-repo";

export const LAST_EDIT_THROTTLE_MS = 5_000;
/** Bound on the in-memory throttle map (one entry per recently-edited entity). */
const THROTTLE_ENTRIES_MAX = 2_048;

export class LastEditRecorder {
	readonly #repo: LastEditsRepository;
	readonly #now: () => number;
	readonly #recent = new Map<string, { editor: string; at: number }>();

	constructor(repo: LastEditsRepository, now: () => number = Date.now) {
		this.#repo = repo;
		this.#now = now;
	}

	note(entityId: string, editorPubB64: string): void {
		const at = this.#now();
		const last = this.#recent.get(entityId);
		if (last && last.editor === editorPubB64 && at - last.at < LAST_EDIT_THROTTLE_MS) return;
		this.#recent.delete(entityId);
		this.#recent.set(entityId, { editor: editorPubB64, at });
		if (this.#recent.size > THROTTLE_ENTRIES_MAX) {
			const oldest = this.#recent.keys().next().value;
			if (oldest !== undefined) this.#recent.delete(oldest);
		}
		try {
			this.#repo.record(entityId, editorPubB64, at);
		} catch (error) {
			console.warn(`[collab] last-edit record failed: ${(error as Error).message}`);
		}
	}
}
