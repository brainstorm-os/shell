/**
 * Import-run store — module-level ownership of the ONE active import run
 * (main enforces a single `activeRun`), so the run is a BACKGROUND task:
 * leaving Settings (or the whole panel unmounting) neither cancels the run
 * nor loses its progress — coming back re-shows the live state, and
 * completion fires an OS notification when the window isn't focused
 * (owner report 2026-07-18: import/export must not block the interface).
 *
 * Sections start runs with {@link startImportRun} and render from
 * {@link useImportRun}; the store subscribes to the main-side progress
 * stream for the life of the run, not the life of the component.
 */

import { useSyncExternalStore } from "react";
import type { ImportRunReport } from "../../preload";
import { t } from "../i18n/t";

export enum ImportRunStatus {
	Idle = "idle",
	Running = "running",
	Done = "done",
	Failed = "failed",
}

/** Which Backup & Migration section owns the run (drives where the done /
 *  failed state renders when the user comes back). */
export enum ImportRunSection {
	Csv = "csv",
	Obsidian = "obsidian",
	Notion = "notion",
	Anytype = "anytype",
}

export type ImportRunState = {
	readonly status: ImportRunStatus;
	readonly section: ImportRunSection | null;
	readonly progress: { done: number; total: number } | null;
	readonly report: ImportRunReport | null;
	readonly error: string | null;
};

const IDLE: ImportRunState = {
	status: ImportRunStatus.Idle,
	section: null,
	progress: null,
	report: null,
	error: null,
};

let state: ImportRunState = IDLE;
const listeners = new Set<() => void>();

function setState(next: ImportRunState): void {
	state = next;
	for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function getSnapshot(): ImportRunState {
	return state;
}

export function useImportRun(): ImportRunState {
	// Third arg: the panel test server-renders the tree (renderToString).
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Start a run. Returns false when another run is already active. */
export function startImportRun(
	section: ImportRunSection,
	run: () => Promise<ImportRunReport>,
): boolean {
	if (state.status === ImportRunStatus.Running) return false;
	setState({ ...IDLE, status: ImportRunStatus.Running, section });
	const stopProgress = window.brainstorm.importExport.onProgress((p) => {
		if (state.status === ImportRunStatus.Running) setState({ ...state, progress: p });
	});
	run()
		.then((report) => {
			stopProgress();
			setState({ ...IDLE, status: ImportRunStatus.Done, section, report });
			notifyDone(report);
		})
		.catch((e: unknown) => {
			stopProgress();
			setState({
				...IDLE,
				status: ImportRunStatus.Failed,
				section,
				error: e instanceof Error ? e.message : String(e),
			});
		});
	return true;
}

export function cancelImportRun(): void {
	void window.brainstorm.importExport.cancel();
}

/** Back to idle — the section's "import another" affordance. */
export function dismissImportRun(): void {
	setState(IDLE);
}

/** OS-level completion notice, only when the user is somewhere else — the
 *  point of a background run is not having to babysit Settings. */
function notifyDone(report: ImportRunReport): void {
	if (typeof document !== "undefined" && document.hasFocus()) return;
	if (typeof Notification === "undefined") return;
	try {
		new Notification(t("shell.settings.backupMigration.notify.title"), {
			body: t("shell.settings.backupMigration.notify.body", {
				created: report.created,
				updated: report.updated,
			}),
		});
	} catch {
		// Notification unavailable (permissions/platform) — the in-panel state
		// still shows the report.
	}
}

/** Test-only reset. */
export function __resetImportRunForTests(): void {
	state = IDLE;
	listeners.clear();
}
