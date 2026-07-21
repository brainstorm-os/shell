/**
 * Semantic-model download status (plan 11.3 — first-run-download progress UX).
 *
 * The local embedding model (`bge-small-en-v1.5`, ~130 MB) downloads on first
 * run inside the `@brainstorm-os/native-embed` addon. Until now that happened
 * silently: a fresh install would spend a minute fetching weights with zero
 * feedback, and a user watching semantic search "not work yet" had no way to
 * tell it was downloading vs broken. This module is the pure, network-free
 * state machine the shell exposes so Settings → Search can render a live
 * progress bar.
 *
 * It's a reducer, not a class with I/O: `initialStatus()` +
 * `applyProgress`/`markReady`/`markFailed`/`markStarted` fold the events the
 * embedder seam emits into an immutable {@link SemanticModelStatus}. Kept pure
 * so every phase transition + the percent math is unit-testable without the
 * native addon, a vault, or a real download.
 */

/** The name surfaced in the UI + the plan (pinned 384-d English model). */
export const SEMANTIC_MODEL_NAME = "bge-small-en-v1.5";

export enum EmbedderPhase {
	/** The native addon isn't available (no prebuilt `.node` for this platform,
	 *  or ONNX Runtime failed to load) — semantic search is off, search stays
	 *  lexical-only. Terminal. */
	Absent = "absent",
	/** Addon present; the model download hasn't started yet (no embed has run,
	 *  so `embedderInit` hasn't been called). */
	Idle = "idle",
	/** The first-run weight download is in flight. */
	Downloading = "downloading",
	/** The model is loaded + ready to embed. Terminal for a session. */
	Ready = "ready",
	/** The download or init failed (e.g. offline on first run). Not terminal —
	 *  the seam retries on the next embed, which moves this back to Downloading. */
	Failed = "failed",
	/** The user hasn't opted into the ~130 MB model download yet (11.3 consent
	 *  gate). Search stays lexical-only until they enable it in Settings →
	 *  Search; enabling moves this to Downloading (or Absent if the addon turns
	 *  out unavailable). */
	NeedsConsent = "needs-consent",
}

/** One per-file progress tick emitted by the native addon while fetching a
 *  pinned model file. `total` is 0 when the server sent no `Content-Length`
 *  (progress is then indeterminate for that file). */
export type EmbedderDownloadProgress = {
	/** The file being fetched, e.g. `model.onnx`. */
	readonly file: string;
	/** 0-based index of this file in the pinned set. */
	readonly fileIndex: number;
	/** Total number of files in the pinned set. */
	readonly fileCount: number;
	/** Bytes of THIS file received so far. */
	readonly downloaded: number;
	/** Total bytes of THIS file (0 = unknown / no Content-Length). */
	readonly total: number;
};

/** What Settings → Search renders for the semantic model. Immutable snapshot. */
export type SemanticModelStatus = {
	readonly phase: EmbedderPhase;
	readonly model: string;
	/** The file currently downloading (`Downloading` phase only). */
	readonly file: string | null;
	/** 1-based "file N of M" for the UI (0 when not downloading). */
	readonly fileNumber: number;
	readonly fileCount: number;
	/** Bytes received for the current file. */
	readonly downloadedBytes: number;
	/** Total bytes of the current file (0 = unknown). */
	readonly totalBytes: number;
	/** 0–100 percent of the current file, or null when indeterminate (no
	 *  Content-Length yet, or not downloading). The model file (`model.onnx`)
	 *  is ~99.9% of the bytes, so its percent is effectively the overall bar. */
	readonly percent: number | null;
	/** A failure message, surfaced as a retryable hint (`Failed` phase only). */
	readonly error: string | null;
};

function base(phase: EmbedderPhase): SemanticModelStatus {
	return {
		phase,
		model: SEMANTIC_MODEL_NAME,
		file: null,
		fileNumber: 0,
		fileCount: 0,
		downloadedBytes: 0,
		totalBytes: 0,
		percent: null,
		error: null,
	};
}

/** Status before anything is known — the addon presence probe hasn't run. */
export function initialStatus(): SemanticModelStatus {
	return base(EmbedderPhase.Idle);
}

/** The addon isn't loadable — search is lexical-only. */
export function absentStatus(): SemanticModelStatus {
	return base(EmbedderPhase.Absent);
}

/** The user hasn't consented to the model download yet (11.3 consent gate) —
 *  search is lexical-only until they enable it. */
export function needsConsentStatus(): SemanticModelStatus {
	return base(EmbedderPhase.NeedsConsent);
}

/** `embedderInit` was called — the download is (re)starting. Clears any prior
 *  progress/error so a retry after `Failed` shows a fresh bar. */
export function markStarted(): SemanticModelStatus {
	return base(EmbedderPhase.Downloading);
}

/** Fold a native progress tick into the status. Clamps the percent to [0,100]
 *  and treats a missing/zero `total` as indeterminate (null percent). A tick
 *  always implies the download is in flight, so this also recovers the phase
 *  from `Idle`/`Failed` if a stray tick arrives first. */
export function applyProgress(
	_prev: SemanticModelStatus,
	p: EmbedderDownloadProgress,
): SemanticModelStatus {
	const downloaded = Math.max(0, p.downloaded);
	const total = Math.max(0, p.total);
	const percent =
		total > 0 ? Math.min(100, Math.max(0, Math.round((downloaded / total) * 100))) : null;
	return {
		phase: EmbedderPhase.Downloading,
		model: SEMANTIC_MODEL_NAME,
		file: p.file,
		fileNumber: Math.max(0, p.fileIndex) + 1,
		fileCount: Math.max(0, p.fileCount),
		downloadedBytes: downloaded,
		totalBytes: total,
		percent,
		error: null,
	};
}

/** The model finished loading. Terminal for the session. */
export function markReady(): SemanticModelStatus {
	return { ...base(EmbedderPhase.Ready), percent: 100 };
}

/** Init/download failed. Retryable — the next embed moves back to Downloading. */
export function markFailed(message: string): SemanticModelStatus {
	return { ...base(EmbedderPhase.Failed), error: message };
}
