/**
 * Settings → General → Startup & background. "Keep running in the background"
 * (7.16) is app-global and only shown where it means something (not macOS,
 * whose dock already keeps a windowless app running).
 */

import { useEffect, useState } from "react";
import type { BackgroundPrefsView } from "../../preload";
import { t } from "../i18n/t";
import { ToggleRow } from "./settings-controls";

export function StartupSection() {
	const [background, setBackground] = useState<BackgroundPrefsView | null>(null);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.background
			?.getPrefs()
			.then((prefs) => {
				if (!cancelled) setBackground(prefs);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	if (!background?.supported) return null;

	return (
		<section className="settings__section" data-testid="settings-startup">
			<h4 className="settings__section-title">{t("shell.settings.startup.title")}</h4>
			<ToggleRow
				title={t("shell.settings.startup.keepRunning")}
				description={t("shell.settings.startup.keepRunning.description")}
				ariaLabel={t("shell.settings.startup.keepRunning")}
				checked={background.keepRunning}
				onChange={(next) => {
					void window.brainstorm.background.setKeepRunning(next).then(setBackground);
				}}
			/>
		</section>
	);
}
