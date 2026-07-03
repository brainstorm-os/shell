/**
 * Settings → Sync (Stage 10.7).
 *
 * Same `SyncStatusSnapshot` the dashboard chip reads, expanded into a
 * full pane: state name + tooltip, full relay URL, traffic timestamps,
 * dropped-inbound + dropped-sends (always shown, including zero),
 * diagnostic seq-state size + pair count. Long URLs clip via the
 * shared text-clamp pattern.
 */

import { SelectMenu } from "@brainstorm/sdk/select-menu";
import { useEffect, useState } from "react";
import { SelectiveSyncMode, type SelectiveSyncPolicy } from "../../shared/selective-sync-types";
import { formatRelativeAge, relayUrlHost } from "../dashboard/sync-status-popover";
import { useSyncStatus } from "../dashboard/use-sync-status";
import { SyncState } from "../dashboard/use-sync-status";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import "./sync-section.css";

export function SyncSection() {
	const { snapshot, derivedState } = useSyncStatus();

	if (!snapshot || !derivedState) {
		return (
			<section className="settings__section sync-section" data-testid="sync-section">
				<p className="settings__placeholder">{t("shell.settings.sync.unavailable")}</p>
				<RestoreControl />
				<SelectiveSyncPolicyControl />
			</section>
		);
	}

	const now = Date.now();
	const state = derivedState;
	const isLocalOnly = state === SyncState.LocalOnly;
	const host = relayUrlHost(snapshot.relayUrl);

	return (
		<section className="settings__section sync-section" data-testid="sync-section">
			<p className="settings__section-summary">{t("shell.settings.sync.summary")}</p>

			<div className="sync-section__group">
				<h4 className="sync-section__group-title">{t("shell.settings.sync.section.state")}</h4>
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.dashboard.syncStatus.chipLabel")}</span>
					<span className={`sync-section__value sync-section__value--${state}`}>
						{t(`shell.dashboard.syncStatus.state.${state}`)}
					</span>
				</div>
				<p className="sync-section__tooltip">{t(`shell.dashboard.syncStatus.tooltip.${state}`)}</p>
			</div>

			<div className="sync-section__group">
				<h4 className="sync-section__group-title">{t("shell.settings.sync.section.relay")}</h4>
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.dashboard.syncStatus.field.relay")}</span>
					<span
						className="sync-section__value sync-section__value--clip"
						title={snapshot.relayUrl ?? undefined}
						data-testid="sync-section-relay-url"
					>
						{isLocalOnly
							? t("shell.dashboard.syncStatus.field.relayNone")
							: (snapshot.relayUrl ?? t("shell.dashboard.syncStatus.field.relayNone"))}
					</span>
				</div>
				{!isLocalOnly && host && host !== snapshot.relayUrl && (
					<div className="sync-section__row">
						<span className="sync-section__label">{t("shell.dashboard.syncStatus.field.host")}</span>
						<span className="sync-section__value">{host}</span>
					</div>
				)}
				{!isLocalOnly && (
					<div className="sync-section__row">
						<span className="sync-section__label">{t("shell.dashboard.syncStatus.field.transport")}</span>
						<span className="sync-section__value">{snapshot.transportState ?? "—"}</span>
					</div>
				)}
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.settings.sync.field.connectionId")}</span>
					<span className="sync-section__value">
						{snapshot.connectionId ?? t("shell.settings.sync.connectionId.none")}
					</span>
				</div>
			</div>

			{!isLocalOnly && (
				<div className="sync-section__group">
					<h4 className="sync-section__group-title">{t("shell.settings.sync.section.traffic")}</h4>
					<div className="sync-section__row">
						<span className="sync-section__label">
							{t("shell.dashboard.syncStatus.field.lastInbound")}
						</span>
						<span className="sync-section__value">
							{formatRelativeAge(snapshot.lastInboundAtMs, now)}
						</span>
					</div>
					<div className="sync-section__row">
						<span className="sync-section__label">
							{t("shell.dashboard.syncStatus.field.lastOutbound")}
						</span>
						<span className="sync-section__value">
							{formatRelativeAge(snapshot.lastOutboundAtMs, now)}
						</span>
					</div>
					<div className="sync-section__row">
						<span className="sync-section__label">
							{t("shell.dashboard.syncStatus.field.droppedSends")}
						</span>
						<span className="sync-section__value">{snapshot.droppedSends}</span>
					</div>
					<div className="sync-section__row">
						<span className="sync-section__label">{t("shell.settings.sync.field.droppedInbound")}</span>
						<span className="sync-section__value">{snapshot.droppedInbound}</span>
					</div>
					{snapshot.attachmentSyncPausedReason != null && (
						<p
							className="sync-section__quota-warning"
							role="alert"
							data-testid="sync-section-quota-paused"
						>
							{t("shell.dashboard.syncStatus.attachmentsPaused.storageQuota")}
						</p>
					)}
				</div>
			)}

			<RestoreControl />

			<SelectiveSyncPolicyControl />

			<div className="sync-section__group">
				<h4 className="sync-section__group-title">{t("shell.settings.sync.section.diagnostics")}</h4>
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.dashboard.syncStatus.field.seqState")}</span>
					<span className="sync-section__value">
						{t("shell.dashboard.syncStatus.seqState.detail", {
							bytes: snapshot.seqStateBytes,
							count: snapshot.pairKeyCount,
						})}
					</span>
				</div>
			</div>
		</section>
	);
}

/**
 * Stage 10.13 — per-device selective-sync policy picker. Chooses which shared
 * entities the device actively syncs: Everything, Pinned only, or Pinned +
 * entities active within a rolling window. A not-in-policy shared entity simply
 * isn't subscribed; its local copy is untouched (on-demand eviction/re-fetch is
 * SYNC-2's job). Reads/writes the device-local policy over the sync-status IPC.
 */
function SelectiveSyncPolicyControl() {
	const [policy, setPolicy] = useState<SelectiveSyncPolicy | null>(null);

	useEffect(() => {
		let cancelled = false;
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge?.getPolicy) return;
		void bridge.getPolicy().then((p) => {
			if (!cancelled) setPolicy(p);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!policy) return null;

	const apply = (next: SelectiveSyncPolicy): void => {
		setPolicy(next);
		void window.brainstorm?.syncStatus?.setPolicy?.(next).then((saved) => setPolicy(saved));
	};

	const modeOptions = [
		{ value: SelectiveSyncMode.Everything, label: t("shell.settings.sync.policy.mode.everything") },
		{ value: SelectiveSyncMode.Pinned, label: t("shell.settings.sync.policy.mode.pinned") },
		{
			value: SelectiveSyncMode.PinnedPlusRecent,
			label: t("shell.settings.sync.policy.mode.pinnedPlusRecent"),
		},
	];

	return (
		<div className="sync-section__group" data-testid="selective-sync-policy">
			<h4 className="sync-section__group-title">{t("shell.settings.sync.section.policy")}</h4>
			<p className="sync-section__tooltip">{t("shell.settings.sync.policy.summary")}</p>
			<div className="sync-section__row">
				<span className="sync-section__label">{t("shell.settings.sync.policy.mode.label")}</span>
				<SelectMenu
					value={policy.mode}
					options={modeOptions}
					onChange={(mode) => apply({ ...policy, mode })}
					ariaLabel={t("shell.settings.sync.policy.mode.label")}
					data-testid="selective-sync-mode"
				/>
			</div>
			{policy.mode === SelectiveSyncMode.PinnedPlusRecent && (
				<div className="sync-section__row">
					<span className="sync-section__label">{t("shell.settings.sync.policy.recentDays.label")}</span>
					<input
						type="number"
						min={1}
						max={3650}
						className="sync-section__number"
						value={policy.recentDays}
						aria-label={t("shell.settings.sync.policy.recentDays.label")}
						data-testid="selective-sync-recent-days"
						onChange={(e) =>
							apply({ ...policy, recentDays: Number(e.currentTarget.value) || policy.recentDays })
						}
					/>
				</div>
			)}
		</div>
	);
}

enum RestorePhase {
	Idle = "idle",
	Running = "running",
	Done = "done",
	Failed = "failed",
}

/**
 * Stage 10.14 — cold restore-from-zero offer. Shown only when the keystore-intact
 * device has an empty `entities.db` AND a reachable durable node (the IPC gates
 * the offer). One click streams the catalog → encrypted backfill → row + index
 * rebuild; the summary reports what came back. Auto-detected on mount so a wiped
 * device that reopens its vault is prompted without hunting through Settings.
 */
function RestoreControl() {
	const [available, setAvailable] = useState(false);
	const [phase, setPhase] = useState<RestorePhase>(RestorePhase.Idle);
	const [summary, setSummary] = useState<{ requested: number; restored: number } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge?.restoreAvailable) return;
		void bridge.restoreAvailable().then((ok) => {
			if (!cancelled) setAvailable(ok);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!available && phase === RestorePhase.Idle) return null;

	const runRestore = (): void => {
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge?.restore) return;
		setPhase(RestorePhase.Running);
		void bridge
			.restore()
			.then((result) => {
				setSummary({ requested: result.requested, restored: result.restored });
				setPhase(RestorePhase.Done);
			})
			.catch(() => setPhase(RestorePhase.Failed));
	};

	return (
		<div className="sync-section__group" data-testid="restore-control">
			<h4 className="sync-section__group-title">{t("shell.settings.sync.restore.title")}</h4>
			<p className="sync-section__tooltip">{t("shell.settings.sync.restore.summary")}</p>
			{phase === RestorePhase.Done && summary ? (
				<p className="sync-section__tooltip" data-testid="restore-result">
					{t("shell.settings.sync.restore.done", {
						restored: summary.restored,
						requested: summary.requested,
					})}
				</p>
			) : phase === RestorePhase.Failed ? (
				<p
					className="sync-section__tooltip sync-section__tooltip--error"
					role="alert"
					data-testid="restore-error"
				>
					{t("shell.settings.sync.restore.failed")}
				</p>
			) : (
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Sm}
					loading={phase === RestorePhase.Running}
					onClick={runRestore}
					data-testid="restore-run"
				>
					{phase === RestorePhase.Running
						? t("shell.settings.sync.restore.running")
						: t("shell.settings.sync.restore.action")}
				</Button>
			)}
		</div>
	);
}
