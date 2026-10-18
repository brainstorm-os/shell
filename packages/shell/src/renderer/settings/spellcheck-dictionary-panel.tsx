/**
 * Settings → Spellcheck dictionary manager (B11.17b). Lists the per-vault custom
 * words (added via the right-click "Add to dictionary" menu, B11.17a) and lets
 * the user prune them. Reads + removes through the privileged dashboard bridge
 * (`window.brainstorm.spellcheck`) — the dashboard is not a sandboxed app, so it
 * uses direct ipcMain, not the broker.
 *
 * B11.31 — the spellcheck languages are user-editable: a multi-select over the
 * platform's available dictionaries (the shared `<MultiSelectMenu>`), saved per
 * device and applied to every session live, with "Use system languages" to go
 * back to the OS preference order. On macOS the OS speller auto-detects and
 * exposes no list, so the picker is replaced by that explanation.
 */

import { MultiSelectMenu } from "@brainstorm-os/sdk/select-menu";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { t } from "../i18n/t";
import { Button, ButtonVariant } from "../ui/button";
import { IconName } from "../ui/icon";
import { IconButton, IconButtonSize } from "../ui/icon-button";
import { SettingRow } from "./settings-controls";

type LanguagesState = {
	active: readonly string[];
	available: readonly string[];
	chosen: readonly string[] | null;
};

const EMPTY_LANGUAGES: LanguagesState = { active: [], available: [], chosen: null };

/** A human name for a BCP-47 tag ("en-GB" → "English (United Kingdom)"),
 *  falling back to the tag itself. */
export function languageDisplayName(tag: string, displayNames: Intl.DisplayNames | null): string {
	try {
		return displayNames?.of(tag) ?? tag;
	} catch {
		return tag;
	}
}

function makeDisplayNames(): Intl.DisplayNames | null {
	try {
		return new Intl.DisplayNames(undefined, { type: "language" });
	} catch {
		return null;
	}
}

export function SpellcheckDictionaryPanel() {
	const [words, setWords] = useState<readonly string[]>([]);
	const [languages, setLanguages] = useState<LanguagesState>(EMPTY_LANGUAGES);
	const [loaded, setLoaded] = useState(false);

	const refresh = useCallback(async () => {
		const [list, langs] = await Promise.all([
			window.brainstorm.spellcheck.listWords(),
			window.brainstorm.spellcheck.languages(),
		]);
		setWords(list);
		setLanguages({ active: langs.active, available: langs.available, chosen: langs.chosen ?? null });
		setLoaded(true);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const displayNames = useMemo(makeDisplayNames, []);
	const languageOptions = useMemo(
		() =>
			languages.available.map((tag) => ({ id: tag, label: languageDisplayName(tag, displayNames) })),
		[languages.available, displayNames],
	);
	const languagesId = useId();

	const saveLanguages = async (next: readonly string[] | null) => {
		const langs = await window.brainstorm.spellcheck.setLanguages(next);
		setLanguages({ active: langs.active, available: langs.available, chosen: langs.chosen ?? null });
	};

	const activeNames = languages.active.map((tag) => languageDisplayName(tag, displayNames));

	const removeWord = async (word: string) => {
		const next = await window.brainstorm.spellcheck.removeWord(word);
		setWords(next);
	};

	return (
		<section className="settings__section">
			<h4 className="settings__section-title">{t("shell.settings.spellcheck.title")}</h4>
			{languages.available.length > 0 ? (
				<SettingRow
					title={t("shell.settings.spellcheck.languagesLabel")}
					description={
						languages.chosen
							? t("shell.settings.spellcheck.languages", { langs: activeNames.join(", ") })
							: t("shell.settings.spellcheck.languagesSystem", { langs: activeNames.join(", ") })
					}
					htmlFor={languagesId}
					control={
						<span className="settings__spell-langs">
							<MultiSelectMenu
								id={languagesId}
								className="setting-select"
								selected={languages.chosen ?? languages.active}
								options={languageOptions}
								ariaLabel={t("shell.settings.spellcheck.languagesLabel")}
								onChange={(next) => {
									if (next.length > 0) void saveLanguages(next);
								}}
							/>
							{languages.chosen ? (
								<Button variant={ButtonVariant.Ghost} onClick={() => void saveLanguages(null)}>
									{t("shell.settings.spellcheck.languagesReset")}
								</Button>
							) : null}
						</span>
					}
				/>
			) : (
				<p className="settings__hint">
					{languages.active.length > 0
						? t("shell.settings.spellcheck.languages", { langs: activeNames.join(", ") })
						: t("shell.settings.spellcheck.languagesAuto")}
				</p>
			)}
			{words.length > 0 ? (
				<ul className="settings__dict-list" aria-live="polite">
					{words.map((word) => (
						<li key={word} className="settings__dict-row">
							<span className="settings__dict-word">{word}</span>
							<IconButton
								icon={IconName.Close}
								label={t("shell.settings.spellcheck.remove", { word })}
								size={IconButtonSize.Sm}
								onClick={() => void removeWord(word)}
							/>
						</li>
					))}
				</ul>
			) : (
				<p className="settings__hint">
					{loaded ? t("shell.settings.spellcheck.empty") : t("shell.common.loading")}
				</p>
			)}
		</section>
	);
}
