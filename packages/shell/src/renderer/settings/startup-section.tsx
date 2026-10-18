/**
 * Settings → General → Startup and background.
 *
 *   - Startup page (7.17, per vault): open the dashboard (default), today's
 *     Journal entry, or one chosen object once after the vault unlocks
 *     (`dashboard/startup-page.ts` runs it). The object picker searches the
 *     vault index and lists hits in the shared anchored menu.
 *   - "Keep running in the background" (7.16, app-global), shown only where
 *     it means something — not macOS, whose dock already keeps a windowless
 *     app running.
 */

import {
	DEFAULT_STARTUP_PAGE,
	type StartupPage,
	StartupPageKind,
} from "@brainstorm-os/protocol/shell-prefs";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { BackgroundPrefsView } from "../../preload";
import { useDashboard } from "../dashboard/use-dashboard";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { TextField } from "../ui/text-field";
import { SettingRow, SettingSelect, ToggleRow } from "./settings-controls";

const STARTUP_RESULTS_LIMIT = 8;

const KIND_OPTIONS: readonly { value: StartupPageKind; labelKey: string }[] = [
	{ value: StartupPageKind.Dashboard, labelKey: "shell.settings.startup.page.dashboard" },
	{ value: StartupPageKind.TodayJournal, labelKey: "shell.settings.startup.page.journal" },
	{ value: StartupPageKind.Object, labelKey: "shell.settings.startup.page.object" },
];

function setStartupPage(page: StartupPage): void {
	void window.brainstorm.dashboard.setStartupPage(page);
}

export function StartupSection() {
	const snapshot = useDashboard();
	const [background, setBackground] = useState<BackgroundPrefsView | null>(null);
	const pageSelectId = useId();
	const page = snapshot?.startupPage ?? DEFAULT_STARTUP_PAGE;
	const [pickingObject, setPickingObject] = useState(false);

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

	const kind = pickingObject ? StartupPageKind.Object : page.kind;

	return (
		<section className="settings__section" data-testid="settings-startup">
			<h4 className="settings__section-title">{t("shell.settings.startup.title")}</h4>
			{snapshot && (
				<SettingRow
					title={t("shell.settings.startup.page")}
					description={t("shell.settings.startup.page.description")}
					htmlFor={pageSelectId}
					control={
						<SettingSelect
							id={pageSelectId}
							value={kind}
							ariaLabel={t("shell.settings.startup.page")}
							options={KIND_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
							onChange={(next) => {
								if (next === StartupPageKind.Object) {
									setPickingObject(true);
									return;
								}
								setPickingObject(false);
								setStartupPage({ kind: next });
							}}
						/>
					}
				/>
			)}
			{kind === StartupPageKind.Object && (
				<StartupObjectPicker
					current={page.kind === StartupPageKind.Object ? page.title : null}
					onPick={(entityId, title) => {
						setPickingObject(false);
						setStartupPage({ kind: StartupPageKind.Object, entityId, title });
					}}
				/>
			)}
			{background?.supported && (
				<ToggleRow
					title={t("shell.settings.startup.keepRunning")}
					description={t("shell.settings.startup.keepRunning.description")}
					ariaLabel={t("shell.settings.startup.keepRunning")}
					checked={background.keepRunning}
					onChange={(next) => {
						void window.brainstorm.background.setKeepRunning(next).then(setBackground);
					}}
				/>
			)}
		</section>
	);
}

function StartupObjectPicker({
	current,
	onPick,
}: {
	current: string | null;
	onPick: (entityId: string, title: string) => void;
}) {
	const [query, setQuery] = useState("");
	const formRef = useRef<HTMLFormElement | null>(null);

	const search = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const anchor = formRef.current;
		const text = query.trim();
		if (!anchor || !text) return;
		const hits = await window.brainstorm.search.query({ text, limit: STARTUP_RESULTS_LIMIT });
		const untitled = t("shell.settings.startup.object.untitled");
		const rect = anchor.getBoundingClientRect();
		openAnchoredMenu(
			{ x: rect.left, y: rect.bottom },
			hits.length > 0
				? hits.map((hit) => ({
						label: hit.title || untitled,
						onSelect: () => onPick(hit.entityId, hit.title || untitled),
					}))
				: [{ label: t("shell.settings.startup.object.noMatches"), disabled: true }],
			{ menuLabel: t("shell.settings.startup.object.results"), anchor },
		);
	};

	return (
		<SettingRow
			title={t("shell.settings.startup.object")}
			description={
				current
					? t("shell.settings.startup.object.current", { title: current })
					: t("shell.settings.startup.object.none")
			}
			control={
				<form
					ref={formRef}
					className="settings__startup-search"
					onSubmit={(event) => void search(event)}
				>
					<TextField
						type="search"
						value={query}
						onChange={setQuery}
						placeholder={t("shell.settings.startup.object.placeholder")}
						aria-label={t("shell.settings.startup.object.placeholder")}
						data-testid="settings-startup-object-search"
					/>
					<Button type="submit" variant={ButtonVariant.Neutral}>
						{t("shell.settings.startup.object.find")}
					</Button>
				</form>
			}
		/>
	);
}
