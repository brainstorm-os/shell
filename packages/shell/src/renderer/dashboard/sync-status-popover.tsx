/**
 * Stage 10.7 — sync-status popover. Surfaces the live aggregate snapshot
 * with the state explanation, last inbound/outbound (relative —
 * `2s ago` / `3m ago` / `1h ago`), relay URL (host-only), the
 * `droppedSends` counter (only when nonzero), and a one-line seq-state
 * diagnostic (`<bytes> · <pair count>`, NO raw pair keys per the
 * negative privacy pin).
 *
 * The drilldown panel lives in Settings → Sync; that surface shows the
 * full relay URL + dropped-inbound + always-on diagnostics. The popover
 * is the quick read.
 */

import type { SyncStatusSnapshot } from "../../preload";
import { formatRelative } from "../format/relative-time";
import { t } from "../i18n/t";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { SyncState } from "./use-sync-status";

export type SyncStatusPopoverProps = {
	snapshot: SyncStatusSnapshot | null;
	derivedState: SyncState | null;
	onClose: () => void;
};

export function relayUrlHost(url: string | null): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.host || url;
	} catch {
		return url;
	}
}

/** Wraps the shared `formatRelative` with the sync surface's "Never"
 *  sentinel for an absent timestamp and its `(then, now)` call shape. */
export function formatRelativeAge(timestampMs: number | null, nowMs: number): string {
	if (timestampMs === null) return t("shell.dashboard.syncStatus.field.never");
	return formatRelative(nowMs, timestampMs);
}

export function SyncStatusPopover({ snapshot, derivedState, onClose }: SyncStatusPopoverProps) {
	const now = Date.now();
	const state = derivedState ?? SyncState.Offline;
	const relayHost = relayUrlHost(snapshot?.relayUrl ?? null);
	const isLocalOnly = state === SyncState.LocalOnly;

	return (
		<Popover
			title={t("shell.dashboard.syncStatus.popover.title")}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			onClose={onClose}
			testId="sync-status-popover"
		>
			<dl className="sync-status-popover__list" data-testid="sync-status-popover-list">
				<div className="sync-status-popover__row">
					<dt className="sync-status-popover__label">{t("shell.dashboard.syncStatus.chipLabel")}</dt>
					<dd className={`sync-status-popover__value sync-status-popover__value--${state}`}>
						{t(`shell.dashboard.syncStatus.state.${state}`)}
					</dd>
				</div>
				<p className="sync-status-popover__tooltip">
					{t(`shell.dashboard.syncStatus.tooltip.${state}`)}
				</p>
				<div className="sync-status-popover__row">
					<dt className="sync-status-popover__label">{t("shell.dashboard.syncStatus.field.relay")}</dt>
					<dd
						className="sync-status-popover__value sync-status-popover__value--clip"
						title={snapshot?.relayUrl ?? undefined}
					>
						{isLocalOnly
							? t("shell.dashboard.syncStatus.field.relayNone")
							: (relayHost ?? t("shell.dashboard.syncStatus.field.relayNone"))}
					</dd>
				</div>
				{!isLocalOnly && (
					<>
						<div className="sync-status-popover__row">
							<dt className="sync-status-popover__label">
								{t("shell.dashboard.syncStatus.field.lastInbound")}
							</dt>
							<dd className="sync-status-popover__value">
								{formatRelativeAge(snapshot?.lastInboundAtMs ?? null, now)}
							</dd>
						</div>
						<div className="sync-status-popover__row">
							<dt className="sync-status-popover__label">
								{t("shell.dashboard.syncStatus.field.lastOutbound")}
							</dt>
							<dd className="sync-status-popover__value">
								{formatRelativeAge(snapshot?.lastOutboundAtMs ?? null, now)}
							</dd>
						</div>
						{(snapshot?.droppedSends ?? 0) > 0 && (
							<div className="sync-status-popover__row">
								<dt className="sync-status-popover__label">
									{t("shell.dashboard.syncStatus.field.droppedSends")}
								</dt>
								<dd className="sync-status-popover__value">{snapshot?.droppedSends}</dd>
							</div>
						)}
					</>
				)}
				{snapshot?.attachmentSyncPausedReason != null && (
					<p
						className="sync-status-popover__warning"
						role="alert"
						data-testid="sync-status-popover-quota-paused"
					>
						{t("shell.dashboard.syncStatus.attachmentsPaused.storageQuota")}
					</p>
				)}
				<div className="sync-status-popover__row">
					<dt className="sync-status-popover__label">
						{t("shell.dashboard.syncStatus.field.seqState")}
					</dt>
					<dd className="sync-status-popover__value" data-testid="sync-status-popover-seq">
						{t("shell.dashboard.syncStatus.seqState.detail", {
							bytes: snapshot?.seqStateBytes ?? 0,
							count: snapshot?.pairKeyCount ?? 0,
						})}
					</dd>
				</div>
			</dl>
		</Popover>
	);
}
