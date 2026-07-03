/**
 * `BackgroundActivityStore` — the main-process registry of live background
 * operations (model download, reindex, sync, import/export). Subsystems `set`
 * an operation when it starts / progresses and `clear` it when it finishes;
 * the store pushes a snapshot to the dashboard on every change (same
 * onChange/snapshot shape as `SyncStatusStore`).
 *
 * Pure + dependency-free: no Electron, no timers, no I/O — the IPC push lives
 * in `activity-handlers.ts`. Ordering is most-recently-updated first so the
 * chip's summary names the freshest operation.
 */

import type { ActivitySnapshot, BackgroundOperation } from "../../activity-types";

export class BackgroundActivityStore {
	// Insertion/update order = recency: a re-`set` moves the op to the front.
	readonly #ops = new Map<string, BackgroundOperation>();
	readonly #listeners = new Set<(snap: ActivitySnapshot) => void>();

	/** Upsert an operation. Re-setting an existing id updates it in place AND
	 *  marks it most-recent (so the chip summarises the freshest work). A no-op
	 *  when the value is byte-identical to the current one — avoids a push storm
	 *  from a subsystem that re-emits an unchanged status. */
	set(op: BackgroundOperation): void {
		const existing = this.#ops.get(op.id);
		if (existing && sameOp(existing, op)) return;
		// Delete-then-set so the Map re-inserts at the end (recency = last).
		this.#ops.delete(op.id);
		this.#ops.set(op.id, op);
		this.#emit();
	}

	/** Remove a finished operation. No-op (no push) if it isn't present. */
	clear(id: string): void {
		if (this.#ops.delete(id)) this.#emit();
	}

	/** Most-recently-updated first. */
	snapshot(): ActivitySnapshot {
		return { operations: [...this.#ops.values()].reverse() };
	}

	onChange(listener: (snap: ActivitySnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(): void {
		const snap = this.snapshot();
		for (const listener of this.#listeners) {
			try {
				listener(snap);
			} catch (error) {
				console.warn("[brainstorm] background-activity listener threw:", error);
			}
		}
	}
}

function sameOp(a: BackgroundOperation, b: BackgroundOperation): boolean {
	return (
		a.kind === b.kind && a.detail === b.detail && a.phase === b.phase && a.percent === b.percent
	);
}
