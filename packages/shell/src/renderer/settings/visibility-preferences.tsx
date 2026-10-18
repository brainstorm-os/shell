/**
 * Settings → Appearance → Visibility (12.18). Three opt-in preferences painted
 * over every theme — in the shell renderer by `ThemeProvider` and in every app
 * renderer by the app preload — so a single toggle reaches the whole product.
 */

import {
	DEFAULT_DISPLAY_PREFS,
	DISPLAY_PREF_KEYS,
	type DisplayPrefs,
} from "@brainstorm-os/protocol/shell-prefs";
import { t } from "../i18n/t";
import { ToggleRow } from "./settings-controls";

const PREF_COPY: Record<keyof DisplayPrefs, { title: string; description: string }> = {
	higherContrast: {
		title: "shell.settings.appearance.visibility.higherContrast",
		description: "shell.settings.appearance.visibility.higherContrast.description",
	},
	emphasizeTextCursor: {
		title: "shell.settings.appearance.visibility.textCursor",
		description: "shell.settings.appearance.visibility.textCursor.description",
	},
	alwaysShowScrollbars: {
		title: "shell.settings.appearance.visibility.scrollbars",
		description: "shell.settings.appearance.visibility.scrollbars.description",
	},
};

export function VisibilityPreferences({ display }: { display: DisplayPrefs | undefined }) {
	const prefs = display ?? DEFAULT_DISPLAY_PREFS;
	return (
		<section className="settings__section" data-testid="settings-appearance-visibility">
			<h4 className="settings__section-title">{t("shell.settings.appearance.visibility.title")}</h4>
			<p className="settings__section-summary">{t("shell.settings.appearance.visibility.summary")}</p>
			<div className="setting-list">
				{DISPLAY_PREF_KEYS.map((key) => (
					<ToggleRow
						key={key}
						title={t(PREF_COPY[key].title)}
						description={t(PREF_COPY[key].description)}
						ariaLabel={t(PREF_COPY[key].title)}
						checked={prefs[key]}
						onChange={(next) => {
							void window.brainstorm.dashboard.setDisplayPrefs({ [key]: next });
						}}
					/>
				))}
			</div>
		</section>
	);
}
