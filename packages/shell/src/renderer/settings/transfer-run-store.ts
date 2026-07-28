/**
 * Transfer-run store — module-level ownership of the ONE active transfer run
 * (main enforces a single `activeRun`), covering both directions: imports AND
 * the vault export (IE-11 residue — export joins the background pattern). The
 * run is a BACKGROUND task: leaving Settings (or the whole panel unmounting)
 * neither cancels the run nor loses its progress — coming back re-shows the
 * live state, and completion fires an OS notification when the window isn't
 * focused (owner report 2026-07-18: import/export must not block the
 * interface).
 *
 * Sections start runs with {@link startImportRun} / {@link startExportRun}
 * and render from {@link useTransferRun}; the store subscribes to the
 * main-side progress stream for the life of the run, not the life of the
 * component.
 */

import { useSyncExternalStore } from "react";
import type { ImportRunReport } from "../../preload";
import { t } from "../i18n/t";
import { ToastKind, pushToast } from "../ui/toasts";

export enum TransferRunKind {
	Import = "import",
	Export = "export",
}

export enum TransferRunStatus {
	Idle = "idle",
	Running = "running",
	Done = "done",
	Failed = "failed",
}

/** Which Backup & Migration section owns the run (drives where the done /
 *  failed state renders when the user comes back). */
export enum TransferRunSection {
	Csv = "csv",
	Obsidian = "obsidian",
	Notion = "notion",
	NotionApi = "notion-api",
	Anytype = "anytype",
	Export = "export",
}

export type TransferRunState = {
	readonly status: TransferRunStatus;
	readonly kind: TransferRunKind | null;
	readonly section: TransferRunSection | null;
	readonly progress: { done: number; total: number } | null;
	/** Import runs land their report here… */
	readonly report: ImportRunReport | null;
	/** …export runs land the written bundle path here. */
	readonly exportPath: string | null;
	readonly error: string | null;
};

const IDLE: TransferRunState = {
	status: TransferRunStatus.Idle,
	kind: null,
	section: null,
	progress: null,
	report: null,
	exportPath: null,
	error: null,
};

let state: TransferRunState = IDLE;
const listeners = new Set<() => void>();

function setState(next: TransferRunState): void {
	state = next;
	for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getTransferRunState(): TransferRunState {
	return state;
}

export function useTransferRun(): TransferRunState {
	// Third arg: the panel test server-renders the tree (renderToString).
	return useSyncExternalStore(subscribe, getTransferRunState, getTransferRunState);
}

/** Claim the single run slot and wire the main-side progress stream. Returns
 *  null when another run is already active. */
function claimRun(kind: TransferRunKind, section: TransferRunSection): (() => void) | null {
	if (state.status === TransferRunStatus.Running) return null;
	setState({ ...IDLE, status: TransferRunStatus.Running, kind, section });
	return window.brainstorm.importExport.onProgress((p) => {
		if (state.status === TransferRunStatus.Running) setState({ ...state, progress: p });
	});
}

function parkFailed(kind: TransferRunKind, section: TransferRunSection, e: unknown): void {
	const error = e instanceof Error ? e.message : String(e);
	setState({
		...IDLE,
		status: TransferRunStatus.Failed,
		kind,
		section,
		error,
	});
	announce(
		ToastKind.Error,
		t(
			kind === TransferRunKind.Export
				? "shell.settings.backupMigration.export.failed"
				: "shell.settings.backupMigration.notify.importFailed",
		),
		error,
	);
}

/** Start an import run. Returns false when another run is already active. */
export function startImportRun(
	section: TransferRunSection,
	run: () => Promise<ImportRunReport>,
): boolean {
	const stopProgress = claimRun(TransferRunKind.Import, section);
	if (!stopProgress) return false;
	run()
		.then((report) => {
			stopProgress();
			setState({
				...IDLE,
				status: TransferRunStatus.Done,
				kind: TransferRunKind.Import,
				section,
				report,
			});
			notifyImportDone(report);
		})
		.catch((e: unknown) => {
			stopProgress();
			parkFailed(TransferRunKind.Import, section, e);
		});
	return true;
}

/** Start the vault-export run. A null result (save dialog cancelled, or the
 *  run stopped) returns the store to Idle — nothing was written. Returns
 *  false when another run is already active. */
export function startExportRun(run: () => Promise<{ path: string } | null>): boolean {
	const stopProgress = claimRun(TransferRunKind.Export, TransferRunSection.Export);
	if (!stopProgress) return false;
	run()
		.then((result) => {
			stopProgress();
			if (result === null) {
				setState(IDLE);
				return;
			}
			setState({
				...IDLE,
				status: TransferRunStatus.Done,
				kind: TransferRunKind.Export,
				section: TransferRunSection.Export,
				exportPath: result.path,
			});
			notifyExportDone(result.path);
		})
		.catch((e: unknown) => {
			stopProgress();
			parkFailed(TransferRunKind.Export, TransferRunSection.Export, e);
		});
	return true;
}

export function cancelTransferRun(): void {
	void window.brainstorm.importExport.cancel();
}

/** Back to idle — the section's "run another" affordance. */
export function dismissTransferRun(): void {
	setState(IDLE);
}

/** Run-outcome notice beyond Settings — the point of a background run is not
 *  having to babysit the panel. Focused window: a toast through the shared
 *  dashboard toast host (the existing dashboard-level surface, IE-11
 *  residue); unfocused: an OS notification. */
function announce(kind: ToastKind, title: string, body: string): void {
	if (typeof document === "undefined" || document.hasFocus()) {
		pushToast({ kind, title, body });
		return;
	}
	if (typeof Notification === "undefined") return;
	try {
		new Notification(title, { body });
	} catch {
		// Notification unavailable (permissions/platform) — the in-panel state
		// still shows the result.
	}
}

function notifyImportDone(report: ImportRunReport): void {
	announce(
		ToastKind.Success,
		t("shell.settings.backupMigration.notify.title"),
		t("shell.settings.backupMigration.notify.body", {
			created: report.created,
			updated: report.updated,
		}),
	);
}

function notifyExportDone(path: string): void {
	announce(
		ToastKind.Success,
		t("shell.settings.backupMigration.notify.exportTitle"),
		t("shell.settings.backupMigration.notify.exportBody", { path }),
	);
}

/** Test-only reset. */
export function __resetTransferRunForTests(): void {
	state = IDLE;
	listeners.clear();
}
