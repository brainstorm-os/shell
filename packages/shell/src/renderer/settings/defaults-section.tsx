/**
 * Settings → Default apps. Three sections — entity types, schemes,
 * extensions — render the same picker pattern (label + select control)
 * against the same dashboard `defaultHandlers` map; the IntentsBus reads pins
 * via `resolveDefaultHandler(verb, signature)` where `signature` is the
 * entity type id (entity rows) or the `osHandoffSignature` (scheme /
 * extension rows).
 *
 * Scheme + extension rows include an "Open with system default" pick
 * (the {@link OS_HANDOFF_APP_ID} sentinel) so the user can explicitly
 * pin "always open `https:` in the system browser" — distinct from
 * the OS-handoff allow/deny consent memory (that's the prompt's sticky
 * choice; this is a hard pin that short-circuits the resolver).
 *
 * The type × capable-apps catalog is built shell-side (registry +
 * dashboard) and fetched once on mount; the *current* pin reads from
 * the live dashboard snapshot stream so a change reflects without a
 * refetch (mirrors `ThemeSection`).
 */

import { SelectMenu, type SelectMenuOption } from "@brainstorm-os/sdk/select-menu";
import { useEffect, useState } from "react";
import type {
	DefaultsCatalog,
	DefaultsCatalogApp,
	DefaultsExtensionEntry,
	DefaultsSchemeEntry,
} from "../../preload";
import { useDashboard } from "../dashboard/use-dashboard";
import { t } from "../i18n/t";

const AUTOMATIC = "";

/** Sentinel value the IntentsBus stores when the user explicitly pins
 *  "open via the OS" for a scheme/extension. Must match the preload
 *  re-export (`OS_HANDOFF_APP_ID`); kept as a local const to avoid a
 *  preload import in a render-hot path. */
const OS_SENTINEL = "__os__";

/** IntentsBus signature shape — `scheme:<name>` for scheme rows,
 *  `ext:<name>` for extension rows. Re-derived here rather than imported
 *  from a main module so the renderer stays unidirectional toward the
 *  preload. */
function schemeSignature(scheme: string): string {
	return `scheme:${scheme}`;
}
function extensionSignature(extension: string): string {
	return `ext:${extension}`;
}

export function DefaultsSection() {
	const snapshot = useDashboard();
	const [catalog, setCatalog] = useState<DefaultsCatalog | null>(null);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void window.brainstorm.dashboard.defaultsCatalog().then((next) => {
			if (cancelled) return;
			setCatalog(next);
			setLoaded(true);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const verb = catalog?.verb ?? "open";
	const pins = snapshot?.defaultHandlers ?? {};

	const onPick = (signature: string, appId: string) => {
		void window.brainstorm.dashboard.setDefaultHandler(
			verb,
			signature,
			appId === AUTOMATIC ? null : appId,
		);
	};

	const entries = catalog?.entries ?? [];
	const schemes = catalog?.schemes ?? [];
	const extensions = catalog?.extensions ?? [];

	if (!loaded) {
		return (
			<section className="settings__section">
				<p className="settings__section-summary">{t("shell.settings.defaults.summary")}</p>
				<p className="settings__placeholder">{t("shell.settings.defaults.loading")}</p>
			</section>
		);
	}

	const allEmpty = entries.length === 0 && schemes.length === 0 && extensions.length === 0;
	if (allEmpty) {
		return (
			<section className="settings__section">
				<p className="settings__section-summary">{t("shell.settings.defaults.summary")}</p>
				<p className="settings__placeholder">{t("shell.settings.defaults.empty")}</p>
			</section>
		);
	}

	return (
		<section className="settings__section">
			<p className="settings__section-summary">{t("shell.settings.defaults.summary")}</p>
			{entries.length > 0 && (
				<>
					<h4 className="settings__defaults-subhead">
						{t("shell.settings.defaults.section.entityTypes")}
					</h4>
					<ul className="settings__defaults-list">
						{entries.map((entry) => {
							const current = pins[`${verb}:${entry.entityType}`] ?? AUTOMATIC;
							// Human caption on the face; full wire id stays on title=
							// for power users / support (F-414).
							const label = entry.label || entry.entityType;
							return (
								<li key={entry.entityType} className="settings__defaults-row">
									<span className="settings__defaults-type" title={entry.entityType}>
										{label}
									</span>
									<SelectMenu
										className="settings__defaults-select"
										ariaLabel={t("shell.settings.defaults.pick", { type: label })}
										value={current}
										options={defaultsOptions(entry.apps)}
										onChange={(next) => onPick(entry.entityType, next)}
									/>
								</li>
							);
						})}
					</ul>
				</>
			)}
			{schemes.length > 0 && (
				<>
					<h4 className="settings__defaults-subhead">{t("shell.settings.defaults.section.schemes")}</h4>
					<ul className="settings__defaults-list">
						{schemes.map((row) => (
							<SchemeRow key={row.scheme} row={row} verb={verb} pins={pins} onPick={onPick} />
						))}
					</ul>
				</>
			)}
			{extensions.length > 0 && (
				<>
					<h4 className="settings__defaults-subhead">
						{t("shell.settings.defaults.section.extensions")}
					</h4>
					<ul className="settings__defaults-list">
						{extensions.map((row) => (
							<ExtensionRow key={row.extension} row={row} verb={verb} pins={pins} onPick={onPick} />
						))}
					</ul>
				</>
			)}
		</section>
	);
}

function SchemeRow({
	row,
	verb,
	pins,
	onPick,
}: {
	row: DefaultsSchemeEntry;
	verb: string;
	pins: Record<string, string>;
	onPick: (signature: string, appId: string) => void;
}) {
	const signature = schemeSignature(row.scheme);
	const current = pins[`${verb}:${signature}`] ?? AUTOMATIC;
	const display = `${row.scheme}:`;
	return (
		<li className="settings__defaults-row">
			<span className="settings__defaults-type" title={display}>
				{display}
			</span>
			<SelectMenu
				className="settings__defaults-select"
				ariaLabel={t("shell.settings.defaults.pickScheme", { scheme: row.scheme })}
				value={current}
				options={defaultsOptions(row.apps)}
				onChange={(next) => onPick(signature, next)}
			/>
		</li>
	);
}

function ExtensionRow({
	row,
	verb,
	pins,
	onPick,
}: {
	row: DefaultsExtensionEntry;
	verb: string;
	pins: Record<string, string>;
	onPick: (signature: string, appId: string) => void;
}) {
	const signature = extensionSignature(row.extension);
	const current = pins[`${verb}:${signature}`] ?? AUTOMATIC;
	const display = `.${row.extension}`;
	return (
		<li className="settings__defaults-row">
			<span className="settings__defaults-type" title={display}>
				{display}
			</span>
			<SelectMenu
				className="settings__defaults-select"
				ariaLabel={t("shell.settings.defaults.pickExtension", { ext: row.extension })}
				value={current}
				options={defaultsOptions(row.apps)}
				onChange={(next) => onPick(signature, next)}
			/>
		</li>
	);
}

/** Build the option list for a defaults pick — Automatic first, then the
 *  capable apps. Centralised so the OS-handoff sentinel doesn't get a
 *  "raw id" treatment in any one branch and so all three sections list
 *  apps the same way. */
function defaultsOptions(apps: readonly DefaultsCatalogApp[]): SelectMenuOption[] {
	return [
		{ value: AUTOMATIC, label: t("shell.settings.defaults.auto") },
		...apps.map((app) => ({
			value: app.appId,
			label: app.appId === OS_SENTINEL ? t("shell.settings.defaults.osHandoff") : app.label,
		})),
	];
}
