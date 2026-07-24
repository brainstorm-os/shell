/**
 * Browser-6 — the chrome-side model for the downloads notice. The shell seals
 * a page download into the vault as a `brainstorm/File/v1` entity and pushes
 * DownloadStarted / DownloadCompleted / DownloadFailed metadata events (the
 * bytes never reach the chrome). This pure reducer folds those events into a
 * small, most-recent-first notice list the `DownloadTray` renders; timers +
 * dismissal live in the component. DOM-free so every branch is unit-tested.
 */

import {
	type DownloadFailReason,
	type WebViewEvent,
	WebViewEventKind,
} from "@brainstorm-os/sdk-types";

/** Lifecycle of a single download notice. */
export enum DownloadStatus {
	Downloading = "downloading",
	Completed = "completed",
	Failed = "failed",
}

export type DownloadNotice = {
	downloadId: string;
	/** The sanitized display name (Started/Failed) or stored name (Completed). */
	filename: string;
	status: DownloadStatus;
	/** The created `File/v1` entity id, once completed. */
	fileId?: string;
	/** Why it failed, once failed. */
	reason?: DownloadFailReason;
	updatedAt: number;
};

/** Most notices the tray keeps — older ones fall off (the vault still has the
 *  file; this is just transient chrome feedback). */
export const MAX_DOWNLOAD_NOTICES = 5;

/** How long a completed notice lingers before auto-dismissing (the file is
 *  already in the vault; a failed notice stays until dismissed). */
export const DOWNLOAD_NOTICE_DISMISS_MS = 5000;

function upsert(
	list: readonly DownloadNotice[],
	downloadId: string,
	patch: Omit<DownloadNotice, "downloadId">,
): DownloadNotice[] {
	const existing = list.find((n) => n.downloadId === downloadId);
	const merged: DownloadNotice = existing
		? { ...existing, ...patch, downloadId }
		: { downloadId, ...patch };
	// Newest-first: drop any prior copy, prepend, cap.
	const rest = list.filter((n) => n.downloadId !== downloadId);
	return [merged, ...rest].slice(0, MAX_DOWNLOAD_NOTICES);
}

/** Fold a shell download event into the notice list. A non-download event
 *  returns the same list reference (no re-render). */
export function reduceDownloads(
	list: readonly DownloadNotice[],
	event: WebViewEvent,
	now: number,
): DownloadNotice[] {
	switch (event.kind) {
		case WebViewEventKind.DownloadStarted:
			return upsert(list, event.downloadId, {
				filename: event.filename,
				status: DownloadStatus.Downloading,
				updatedAt: now,
			});
		case WebViewEventKind.DownloadCompleted:
			return upsert(list, event.downloadId, {
				filename: event.filename,
				status: DownloadStatus.Completed,
				fileId: event.fileId,
				updatedAt: now,
			});
		case WebViewEventKind.DownloadFailed:
			return upsert(list, event.downloadId, {
				filename: event.filename,
				status: DownloadStatus.Failed,
				reason: event.reason,
				updatedAt: now,
			});
		default:
			return list as DownloadNotice[];
	}
}

/** Remove a notice (manual dismiss / completed auto-dismiss). Same reference
 *  when nothing matches. */
export function dismissDownload(
	list: readonly DownloadNotice[],
	downloadId: string,
): DownloadNotice[] {
	if (!list.some((n) => n.downloadId === downloadId)) return list as DownloadNotice[];
	return list.filter((n) => n.downloadId !== downloadId);
}
