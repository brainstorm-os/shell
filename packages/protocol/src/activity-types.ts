/**
 * Background-activity types — shared across main / preload / renderer (like
 * `sync-status-types.ts`, this file has no imports so all three trees can use it
 * without cross-boundary coupling).
 *
 * The shell runs long operations off the interaction path — the ~130 MB
 * embedding-model download, a full search reindex, sync, imports/backups.
 * Historically each was invisible (the model download in particular ran
 * silently on first use). The background-activity store aggregates them into
 * one ambient surface in the dashboard chrome: a chip that appears while work
 * is in flight and a popover listing each operation with its progress.
 */

/** What kind of background work an operation represents — drives its icon +
 *  default title. Extensible: new long-running subsystems register their own
 *  kind rather than inventing a parallel indicator. */
export enum ActivityKind {
	/** First-run download of the on-device embedding model (plan 11.3). */
	ModelDownload = "model-download",
	/** A full search-index rebuild (vault open / manual reindex). */
	Indexing = "indexing",
	/** Sync backfill / restore-from-zero. */
	Sync = "sync",
	/** Vault import. */
	Import = "import",
	/** Vault export / backup. */
	Export = "export",
}

/** An operation is shown while `Running`; `Error` keeps it visible (with its
 *  message) until it's retried or dismissed. A finished operation is removed
 *  from the store, not marked `Done` — the surface shows only live work. */
export enum ActivityPhase {
	Running = "running",
	Error = "error",
}

/** One background operation. `percent` is null when the work is indeterminate
 *  (no measurable total — e.g. a reindex that doesn't report per-item progress);
 *  the UI then shows an indeterminate bar. The human-readable title is derived
 *  from `kind` in the renderer (localized) — main sends only the machine kind,
 *  the sync-status pattern. `detail` carries non-localizable dynamic text (a
 *  system error message), or null. */
export type BackgroundOperation = {
	readonly id: string;
	readonly kind: ActivityKind;
	readonly phase: ActivityPhase;
	readonly percent: number | null;
	readonly detail: string | null;
};

/** The full set of live operations, most-recently-updated first. */
export type ActivitySnapshot = {
	readonly operations: readonly BackgroundOperation[];
};
