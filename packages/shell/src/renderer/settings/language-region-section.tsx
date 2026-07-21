/**
 * Settings → Language & Region (Tracks A + B of the settings overhaul).
 *
 *   - Language: the UI language picker. Writing it persists the per-vault
 *     `locale`; the live runtime switch + locale-pack load is wired in Track A
 *     (the `LocaleProvider` re-renders the dashboard on snapshot change).
 *   - Region: format overrides (hour cycle / date style / first day of week /
 *     number locale / timezone). All default to "auto" (follow the OS); the
 *     shared formatter (Track B) reads these.
 *
 * Language list is the built-in source + shipped seed packs (Track A grows it
 * to the installed-pack set). Timezone + first-day option lists are derived
 * from `Intl` so they stay correct across platforms.
 */

import {
	DateStylePref,
	FIRST_DAY_AUTO,
	type FirstDayOfWeek,
	HourCyclePref,
	REGIONAL_AUTO,
} from "@brainstorm-os/protocol/shell-prefs";
import { useId, useMemo } from "react";
import { AVAILABLE_LANGUAGES, languageLabel } from "../../shared/locale-catalog";
import { useDashboard } from "../dashboard/use-dashboard";
import { t } from "../i18n/t";
import { SettingRow, SettingSelect } from "./settings-controls";
import { SpellcheckDictionaryPanel } from "./spellcheck-dictionary-panel";

const HOUR_CYCLE_OPTIONS: readonly { value: HourCyclePref; labelKey: string }[] = [
	{ value: HourCyclePref.Auto, labelKey: "shell.settings.region.hourCycle.auto" },
	{ value: HourCyclePref.H12, labelKey: "shell.settings.region.hourCycle.h12" },
	{ value: HourCyclePref.H23, labelKey: "shell.settings.region.hourCycle.h23" },
];

const DATE_STYLE_OPTIONS: readonly { value: DateStylePref; labelKey: string }[] = [
	{ value: DateStylePref.Auto, labelKey: "shell.settings.region.dateStyle.auto" },
	{ value: DateStylePref.Short, labelKey: "shell.settings.region.dateStyle.short" },
	{ value: DateStylePref.Medium, labelKey: "shell.settings.region.dateStyle.medium" },
	{ value: DateStylePref.Long, labelKey: "shell.settings.region.dateStyle.long" },
	{ value: DateStylePref.Full, labelKey: "shell.settings.region.dateStyle.full" },
];

/** First-day options: Auto + the seven weekdays, named in the active locale. */
function firstDayOptions(locale: string): { value: string; label: string }[] {
	const fmt = new Intl.DateTimeFormat(safeLocale(locale), { weekday: "long" });
	// 2024-01-07 is a Sunday; index 0..6 → Sun..Sat.
	const days = Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + i))));
	return [
		{ value: FIRST_DAY_AUTO, label: t("shell.settings.region.firstDay.auto") },
		...days.map((label, i) => ({ value: String(i), label })),
	];
}

/** Timezone options: Auto + every IANA zone the runtime knows. */
function timezoneOptions(): { value: string; label: string }[] {
	let zones: string[] = [];
	try {
		const supported = (
			Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
		).supportedValuesOf?.("timeZone");
		if (supported) zones = supported;
	} catch {
		zones = [];
	}
	return [
		{ value: REGIONAL_AUTO, label: t("shell.settings.region.timezone.auto") },
		...zones.map((z) => ({ value: z, label: z })),
	];
}

function safeLocale(locale: string): string | undefined {
	try {
		new Intl.DateTimeFormat(locale);
		return locale;
	} catch {
		return undefined;
	}
}

export function LanguageRegionSection() {
	const snapshot = useDashboard();
	const languageId = useId();
	const hourId = useId();
	const dateId = useId();
	const firstDayId = useId();
	const numberId = useId();
	const tzId = useId();
	const tzOptions = useMemo(() => timezoneOptions(), []);
	const dayOptions = useMemo(
		() => firstDayOptions(snapshot?.locale.language ?? "en"),
		[snapshot?.locale.language],
	);

	if (!snapshot) {
		return <div className="settings__placeholder">{t("shell.settings.loading")}</div>;
	}
	const { locale, regional } = snapshot;
	const dashboard = window.brainstorm.dashboard;

	const numberOptions = [
		{ value: REGIONAL_AUTO, label: t("shell.settings.region.number.auto") },
		...AVAILABLE_LANGUAGES.map((l) => ({ value: l, label: languageLabel(l) })),
	];

	return (
		<>
			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.region.language.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.region.language.summary")}</p>
				<SettingRow
					title={t("shell.settings.region.language.label")}
					htmlFor={languageId}
					control={
						<SettingSelect
							id={languageId}
							value={locale.language}
							ariaLabel={t("shell.settings.region.language.label")}
							options={AVAILABLE_LANGUAGES.map((l) => ({ value: l, label: languageLabel(l) }))}
							onChange={(next) => {
								void dashboard.setLanguage(next);
							}}
						/>
					}
				/>
			</section>

			<section className="settings__section">
				<h4 className="settings__section-title">{t("shell.settings.region.formats.title")}</h4>
				<p className="settings__section-summary">{t("shell.settings.region.formats.summary")}</p>
				<SettingRow
					title={t("shell.settings.region.hourCycle.label")}
					htmlFor={hourId}
					control={
						<SettingSelect
							id={hourId}
							value={regional.hourCycle}
							ariaLabel={t("shell.settings.region.hourCycle.label")}
							options={HOUR_CYCLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
							onChange={(next) => {
								void dashboard.setRegional({ hourCycle: next });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.region.dateStyle.label")}
					htmlFor={dateId}
					control={
						<SettingSelect
							id={dateId}
							value={regional.dateStyle}
							ariaLabel={t("shell.settings.region.dateStyle.label")}
							options={DATE_STYLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
							onChange={(next) => {
								void dashboard.setRegional({ dateStyle: next });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.region.firstDay.label")}
					htmlFor={firstDayId}
					control={
						<SettingSelect
							id={firstDayId}
							value={String(regional.firstDayOfWeek)}
							ariaLabel={t("shell.settings.region.firstDay.label")}
							options={dayOptions}
							onChange={(next) => {
								const parsed: FirstDayOfWeek =
									next === FIRST_DAY_AUTO ? FIRST_DAY_AUTO : (Number(next) as FirstDayOfWeek);
								void dashboard.setRegional({ firstDayOfWeek: parsed });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.region.number.label")}
					htmlFor={numberId}
					control={
						<SettingSelect
							id={numberId}
							value={regional.numberLocale}
							ariaLabel={t("shell.settings.region.number.label")}
							options={numberOptions}
							onChange={(next) => {
								void dashboard.setRegional({ numberLocale: next });
							}}
						/>
					}
				/>
				<SettingRow
					title={t("shell.settings.region.timezone.label")}
					htmlFor={tzId}
					control={
						<SettingSelect
							id={tzId}
							value={regional.timezone}
							ariaLabel={t("shell.settings.region.timezone.label")}
							options={tzOptions}
							onChange={(next) => {
								void dashboard.setRegional({ timezone: next });
							}}
						/>
					}
				/>
			</section>
			<SpellcheckDictionaryPanel />
		</>
	);
}
