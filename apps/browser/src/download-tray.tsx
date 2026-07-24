/**
 * Browser-6 — the downloads notice. The shell seals a page download into the
 * vault as a `brainstorm/File/v1` entity and pushes lifecycle events; this tray
 * surfaces them (downloading → saved to vault / failed). It is presentational:
 * the notice list + timers live in the app (`reduceDownloads` +
 * `dismissDownload`). A completed / failed notice is dismissable; the bytes are
 * already in the vault, so this is transient feedback, never a blocking gate.
 */

import { DownloadFailReason } from "@brainstorm-os/sdk-types";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { ReactElement } from "react";
import { t } from "./i18n";
import { type DownloadNotice, DownloadStatus } from "./logic/downloads";

function failLabel(reason: DownloadFailReason | undefined): string {
	switch (reason) {
		case DownloadFailReason.TooLarge:
			return t("download.failed.tooLarge");
		case DownloadFailReason.Empty:
			return t("download.failed.empty");
		case DownloadFailReason.Interrupted:
			return t("download.failed.interrupted");
		default:
			return t("download.failed.generic");
	}
}

function statusText(notice: DownloadNotice): string {
	switch (notice.status) {
		case DownloadStatus.Downloading:
			return t("download.saving");
		case DownloadStatus.Completed:
			return t("download.saved");
		case DownloadStatus.Failed:
			return failLabel(notice.reason);
	}
}

function statusIcon(status: DownloadStatus): IconName {
	switch (status) {
		case DownloadStatus.Downloading:
			return IconName.Download;
		case DownloadStatus.Completed:
			return IconName.Check;
		case DownloadStatus.Failed:
			return IconName.Warning;
	}
}

export function DownloadTray({
	notices,
	onDismiss,
}: {
	notices: readonly DownloadNotice[];
	onDismiss: (downloadId: string) => void;
}): ReactElement | null {
	if (notices.length === 0) return null;
	return (
		<div className="browser__downloads" role="status" aria-live="polite">
			{notices.map((notice) => (
				<div key={notice.downloadId} className="browser__download" data-status={notice.status}>
					<Icon name={statusIcon(notice.status)} size={14} />
					<span className="browser__download-name" title={notice.filename}>
						{notice.filename}
					</span>
					<span className="browser__download-status">{statusText(notice)}</span>
					<button
						type="button"
						className="browser__navbtn"
						aria-label={t("download.dismiss")}
						data-bs-tooltip={t("download.dismiss")}
						onClick={() => onDismiss(notice.downloadId)}
					>
						<Icon name={IconName.Close} size={12} />
					</button>
				</div>
			))}
		</div>
	);
}
