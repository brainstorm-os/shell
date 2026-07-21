/**
 * Settings → Interface (Track D of the settings overhaul). Controls the
 * dashboard-header chrome: which header controls are visible and the clock
 * options. Reads the per-vault `chrome` state from the dashboard snapshot and
 * writes through `window.brainstorm.dashboard.*`.
 *
 * Header-control labels reuse the same i18n keys the header tooltips use where
 * one exists, so the toggle list reads identically to the live header.
 */

import {
	HEADER_CONTROL_ORDER,
	HeaderControlId,
	HourCyclePref,
	isHeaderControlVisible,
} from "@brainstorm-os/protocol/shell-prefs";
import { useEffect, useId } from "react";
import { useDashboard } from "../dashboard/use-dashboard";
import { t } from "../i18n/t";
import { IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { useSettingsHeaderActions } from "./header-actions";
import { SettingRow, SettingSelect, ToggleRow } from "./settings-controls";

/** i18n key per header control for the visibility list. */
const CONTROL_LABEL_KEY: Record<HeaderControlId, string> = {
	[HeaderControlId.Clock]: "shell.settings.interface.control.clock",
	[HeaderControlId.SyncStatus]: "shell.settings.interface.control.syncStatus",
	[HeaderControlId.Notifications]: "shell.settings.interface.control.notifications",
	[HeaderControlId.Appearance]: "shell.settings.interface.control.appearance",
	[HeaderControlId.AddWidget]: "shell.settings.interface.control.addWidget",
	[HeaderControlId.Search]: "shell.settings.interface.control.search",
	[HeaderControlId.Marketplace]: "shell.settings.interface.control.marketplace",
	[HeaderControlId.Bin]: "shell.settings.interface.control.bin",
	[HeaderControlId.Cheatsheet]: "shell.settings.interface.control.cheatsheet",
	[HeaderControlId.Help]: "shell.settings.interface.control.help",
	[HeaderControlId.VaultInfo]: "shell.settings.interface.control.vaultInfo",
	[HeaderControlId.Settings]: "shell.settings.interface.control.settings",
};

const HOUR_CYCLE_OPTIONS: readonly { value: HourCyclePref; labelKey: string }[] = [
	{ value: HourCyclePref.Auto, labelKey: "shell.settings.region.hourCycle.auto" },
	{ value: HourCyclePref.H12, labelKey: "shell.settings.region.hourCycle.h12" },
	{ value: HourCyclePref.H23, labelKey: "shell.settings.region.hourCycle.h23" },
];

export function InterfaceSection() {
	const snapshot = useDashboard();
	const clockHourCycleId = useId();
	const setHeaderActions = useSettingsHeaderActions();
	const dashboard = window.brainstorm.dashboard;

	useEffect(() => {
		setHeaderActions(
			<IconButton
				icon={IconName.Restore}
				label={t("shell.settings.interface.reset")}
				onClick={() => {
					void dashboard.resetChrome();
				}}
				data-testid="settings-interface-reset"
			/>,
		);
		return () => {
			setHeaderActions(null);
		};
	}, [setHeaderActions, dashboard]);

	if (!snapshot) {
		return <div className="settings__placeholder">{t("shell.settings.loading")}</div>;
	}
	const { chrome } = snapshot;

	return (
		<>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.interface.controls.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.interface.controls.summary")}</p>
				<div className="setting-list">
					{HEADER_CONTROL_ORDER.map((id) => {
						const visible = isHeaderControlVisible(chrome, id);
						const isSettings = id === HeaderControlId.Settings;
						return (
							<ToggleRow
								key={id}
								title={t(CONTROL_LABEL_KEY[id])}
								{...(isSettings
									? { description: t("shell.settings.interface.control.settings.locked") }
									: {})}
								checked={visible}
								disabled={isSettings}
								ariaLabel={t(CONTROL_LABEL_KEY[id])}
								onChange={(next) => {
									void dashboard.setHeaderControlVisible(id, next);
								}}
							/>
						);
					})}
				</div>
			</section>

			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.interface.clock.title")}</h4>
				<ToggleRow
					title={t("shell.settings.interface.clock.show")}
					checked={chrome.clock.show}
					ariaLabel={t("shell.settings.interface.clock.show")}
					onChange={(next) => {
						void dashboard.setClockPrefs({ show: next });
					}}
				/>
				<ToggleRow
					title={t("shell.settings.interface.clock.seconds")}
					checked={chrome.clock.showSeconds}
					ariaLabel={t("shell.settings.interface.clock.seconds")}
					onChange={(next) => {
						void dashboard.setClockPrefs({ showSeconds: next });
					}}
				/>
				<SettingRow
					title={t("shell.settings.interface.clock.hourCycle")}
					htmlFor={clockHourCycleId}
					control={
						<SettingSelect
							id={clockHourCycleId}
							value={chrome.clock.hourCycle}
							ariaLabel={t("shell.settings.interface.clock.hourCycle")}
							options={HOUR_CYCLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
							onChange={(next) => {
								void dashboard.setClockPrefs({ hourCycle: next });
							}}
						/>
					}
				/>
			</section>
		</>
	);
}
