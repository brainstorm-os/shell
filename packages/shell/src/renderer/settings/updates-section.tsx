/**
 * Settings → General → "Updates".
 *
 * On a packaged build the panel drives the 13.12 in-app updater
 * (electron-updater): Check → Available → Download (with progress) →
 * "Restart & install". On dev / unpackaged builds — where self-update can't
 * run — it falls back to the 13.6 manual-download check, which resolves to
 * up-to-date / a Download button that opens the release page via the
 * OS-handoff chokepoint / couldn't-check. The channel (Stable / Beta) +
 * last-checked stamp persist app-global through `window.brainstorm.update`.
 */

import { useCallback, useEffect, useId, useState } from "react";
import {
	type AutoUpdateState,
	UpdateAvailability,
	UpdateChannel,
	type UpdateCheckResult,
	UpdateLifecycle,
} from "../../shared/update-wire-types";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { SettingRow, SettingSelect } from "./settings-controls";

const CHANNEL_OPTIONS: readonly { value: UpdateChannel; labelKey: string }[] = [
	{ value: UpdateChannel.Stable, labelKey: "shell.settings.updates.channel.stable" },
	{ value: UpdateChannel.Beta, labelKey: "shell.settings.updates.channel.beta" },
];

export function UpdatesSection() {
	const channelId = useId();
	const [channel, setChannel] = useState<UpdateChannel>(UpdateChannel.Stable);
	const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
	const [result, setResult] = useState<UpdateCheckResult | null>(null);
	const [autoState, setAutoState] = useState<AutoUpdateState | null>(null);
	const [checking, setChecking] = useState(false);
	const currentVersion = window.brainstorm.version;

	const supported = autoState !== null && autoState.lifecycle !== UpdateLifecycle.Unsupported;

	useEffect(() => {
		let live = true;
		void window.brainstorm.update.getPrefs().then((prefs) => {
			if (!live) return;
			setChannel(prefs.channel);
			setLastCheckedAt(prefs.lastCheckedAt);
		});
		void window.brainstorm.update.getState().then((state) => {
			if (live) setAutoState(state);
		});
		const unsubscribe = window.brainstorm.update.onStateChange((state) => {
			setAutoState(state);
		});
		return () => {
			live = false;
			unsubscribe();
		};
	}, []);

	const onCheck = useCallback(async () => {
		setChecking(true);
		try {
			if (supported) {
				await window.brainstorm.update.checkAuto();
				setLastCheckedAt(new Date().toISOString());
				return;
			}
			const next = await window.brainstorm.update.check();
			setResult(next);
			setLastCheckedAt(next.checkedAt);
		} finally {
			setChecking(false);
		}
	}, [supported]);

	const onChannelChange = useCallback((next: UpdateChannel) => {
		setChannel(next);
		// A channel change invalidates the previous result.
		setResult(null);
		void window.brainstorm.update.setChannel(next);
	}, []);

	const onOpenDownloadPage = useCallback((url: string) => {
		void window.brainstorm.intents.dispatch({ verb: "open", payload: { url } });
	}, []);

	const inFlight =
		checking ||
		autoState?.lifecycle === UpdateLifecycle.Checking ||
		autoState?.lifecycle === UpdateLifecycle.Downloading;

	return (
		<section className="settings__section">
			<h4 className="settings__section-title">{t("shell.settings.updates.title")}</h4>
			<p className="settings__section-summary">{t("shell.settings.updates.summary")}</p>

			<SettingRow
				title={t("shell.settings.updates.currentVersion")}
				control={<span className="settings__value-text">{currentVersion}</span>}
			/>

			<SettingRow
				title={t("shell.settings.updates.channel")}
				description={t("shell.settings.updates.channel.description")}
				htmlFor={channelId}
				control={
					<SettingSelect
						id={channelId}
						value={channel}
						ariaLabel={t("shell.settings.updates.channel")}
						options={CHANNEL_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
						onChange={onChannelChange}
					/>
				}
			/>

			<div className="settings__updates-actions">
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Sm}
					disabled={inFlight}
					onClick={() => {
						void onCheck();
					}}
				>
					{inFlight ? t("shell.settings.updates.checking") : t("shell.settings.updates.check")}
				</Button>
				{lastCheckedAt !== null && (
					<span className="settings__updates-last">
						{t("shell.settings.updates.lastChecked", { when: formatWhen(lastCheckedAt) })}
					</span>
				)}
			</div>

			{supported && autoState !== null ? (
				<AutoUpdateResult
					state={autoState}
					onDownload={() => void window.brainstorm.update.download()}
					onInstall={() => void window.brainstorm.update.installNow()}
				/>
			) : (
				result !== null && <FeedUpdateResult result={result} onDownload={onOpenDownloadPage} />
			)}
		</section>
	);
}

/** Packaged-build (electron-updater) lifecycle view. */
function AutoUpdateResult({
	state,
	onDownload,
	onInstall,
}: {
	state: AutoUpdateState;
	onDownload: () => void;
	onInstall: () => void;
}) {
	switch (state.lifecycle) {
		case UpdateLifecycle.Available:
			return (
				<div className="settings__updates-result settings__updates-result--available" role="status">
					<p className="settings__updates-headline">
						{t("shell.settings.updates.available", { version: state.version ?? "" })}
					</p>
					<Button variant={ButtonVariant.Primary} size={ButtonSize.Sm} onClick={onDownload}>
						{t("shell.settings.updates.download")}
					</Button>
				</div>
			);
		case UpdateLifecycle.Downloading: {
			const percent = state.progress?.percent ?? 0;
			return (
				<div className="settings__updates-result" role="status" aria-live="polite">
					<p className="settings__updates-headline">
						{t("shell.settings.updates.downloading", { percent })}
					</p>
					{/* Decorative track — progress is announced via the live-region text above. */}
					<div className="settings__updates-progress" aria-hidden="true">
						<div className="settings__updates-progress-bar" style={{ width: `${percent}%` }} />
					</div>
				</div>
			);
		}
		case UpdateLifecycle.Downloaded:
			return (
				<div className="settings__updates-result settings__updates-result--available" role="status">
					<p className="settings__updates-headline">
						{t("shell.settings.updates.updateReady", { version: state.version ?? "" })}
					</p>
					<Button variant={ButtonVariant.Primary} size={ButtonSize.Sm} onClick={onInstall}>
						{t("shell.settings.updates.restartInstall")}
					</Button>
				</div>
			);
		case UpdateLifecycle.NotAvailable:
			return <ResultLine messageKey="shell.settings.updates.upToDate" />;
		case UpdateLifecycle.Error:
			return (
				<div className="settings__updates-result" role="status">
					<p className="settings__updates-headline">
						{t("shell.settings.updates.error", { message: state.error ?? "" })}
					</p>
				</div>
			);
		default:
			return null;
	}
}

/** 13.6 manual-download (dev / unsupported) view. */
function FeedUpdateResult({
	result,
	onDownload,
}: {
	result: UpdateCheckResult;
	onDownload: (url: string) => void;
}) {
	if (result.availability === UpdateAvailability.Available && result.latest !== undefined) {
		const latest = result.latest;
		return (
			<div className="settings__updates-result settings__updates-result--available" role="status">
				<p className="settings__updates-headline">
					{t("shell.settings.updates.available", { version: latest.version })}
				</p>
				{latest.notes !== undefined && <p className="settings__updates-notes">{latest.notes}</p>}
				<Button
					variant={ButtonVariant.Primary}
					size={ButtonSize.Sm}
					onClick={() => onDownload(latest.downloadUrl)}
				>
					{t("shell.settings.updates.download")}
				</Button>
			</div>
		);
	}
	return (
		<ResultLine
			messageKey={
				result.availability === UpdateAvailability.UpToDate
					? "shell.settings.updates.upToDate"
					: "shell.settings.updates.unknown"
			}
		/>
	);
}

function ResultLine({ messageKey }: { messageKey: string }) {
	return (
		<div className="settings__updates-result" role="status">
			<p className="settings__updates-headline">{t(messageKey)}</p>
		</div>
	);
}

function formatWhen(iso: string): string {
	try {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return iso;
		return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
			date,
		);
	} catch {
		return iso;
	}
}
