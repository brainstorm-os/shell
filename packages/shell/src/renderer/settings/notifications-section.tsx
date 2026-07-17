/**
 * Settings → Notifications (Track C of the settings overhaul). Controls how
 * app notifications surface:
 *
 *   - OS-native toggle (Electron `Notification` alongside in-app toasts).
 *   - Do-not-disturb window (start/end; suppresses popups but history still
 *     records — enforced at the notify host, `os-notification-host`).
 *   - Per-app mute list (every installed app).
 *   - Clear notification center history.
 *
 * All writes go through `window.brainstorm.dashboard.*` and persist per-vault.
 */

import { useEffect, useId, useState } from "react";
import type { InstalledApp } from "../../preload";
import { useDashboard } from "../dashboard/use-dashboard";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { TextField, TextFieldSize } from "../ui/text-field";
import { SettingRow } from "./settings-controls";

export function NotificationsSection() {
	const snapshot = useDashboard();
	const [apps, setApps] = useState<InstalledApp[]>([]);
	const startId = useId();
	const endId = useId();

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.apps.listInstalled().then((list) => {
			if (!cancelled) setApps(list);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	if (!snapshot) {
		return <div className="settings__placeholder">{t("shell.settings.loading")}</div>;
	}
	const { notifications } = snapshot;
	const dashboard = window.brainstorm.dashboard;
	const unread = snapshot.notificationHistory.filter((n) => !n.read).length;

	return (
		<>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.notifications.delivery.title")}</h4>
				<SettingRow
					title={t("shell.settings.notifications.osNative.label")}
					description={t("shell.settings.notifications.osNative.desc")}
					control={
						<Checkbox
							checked={notifications.osNative}
							ariaLabel={t("shell.settings.notifications.osNative.label")}
							onChange={(next) => {
								void dashboard.setNotificationsOsNative(next);
							}}
						/>
					}
				/>
			</section>

			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.notifications.dnd.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.notifications.dnd.summary")}</p>
				<SettingRow
					title={t("shell.settings.notifications.dnd.enable")}
					control={
						<Checkbox
							checked={notifications.dnd.enabled}
							ariaLabel={t("shell.settings.notifications.dnd.enable")}
							onChange={(next) => {
								void dashboard.setDnd({ enabled: next });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.notifications.dnd.start")}
					htmlFor={startId}
					control={
						<TextField
							id={startId}
							type="time"
							size={TextFieldSize.Sm}
							value={notifications.dnd.start}
							disabled={!notifications.dnd.enabled}
							aria-label={t("shell.settings.notifications.dnd.start")}
							onChange={(next) => {
								void dashboard.setDnd({ start: next });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.notifications.dnd.end")}
					htmlFor={endId}
					control={
						<TextField
							id={endId}
							type="time"
							size={TextFieldSize.Sm}
							value={notifications.dnd.end}
							disabled={!notifications.dnd.enabled}
							aria-label={t("shell.settings.notifications.dnd.end")}
							onChange={(next) => {
								void dashboard.setDnd({ end: next });
							}}
						/>
					}
				/>
			</section>

			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.notifications.perApp.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.notifications.perApp.summary")}</p>
				{apps.length === 0 ? (
					<p className="settings__hint">{t("shell.settings.notifications.perApp.empty")}</p>
				) : (
					<div className="setting-list">
						{apps.map((app) => {
							const muted = notifications.mutes[app.id] === true;
							return (
								<SettingRow
									key={app.id}
									title={app.name}
									control={
										<Checkbox
											checked={!muted}
											ariaLabel={t("shell.settings.notifications.perApp.toggle", { app: app.name })}
											onChange={(next) => {
												void dashboard.setAppNotificationMuted(app.id, !next);
											}}
										/>
									}
								/>
							);
						})}
					</div>
				)}
			</section>

			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.notifications.center.title")}</h4>
				<p className="settings__section-summary">
					{t("shell.settings.notifications.center.count", {
						count: snapshot.notificationHistory.length,
						unread,
					})}
				</p>
				<div className="setting-row__control">
					<Button
						variant={ButtonVariant.Neutral}
						size={ButtonSize.Sm}
						disabled={snapshot.notificationHistory.length === 0}
						onClick={() => {
							void dashboard.clearNotificationHistory();
						}}
					>
						{t("shell.settings.notifications.center.clear")}
					</Button>
				</div>
			</section>
		</>
	);
}
