/**
 * The set of UI languages the shell ships. English is the source language and
 * always complete; the rest are seed packs (machine-translated first pass,
 * human review later — see). Track A's
 * locale-pack loader resolves a pack per entry; the Language picker lists them.
 *
 * Pure (no Electron / React) so the renderer + main + preload share it.
 */

// The source language + fallback-chain resolver are shared with the app SDK
// (apps walk the same chain to load their own overlay packs — 12.15 slice 15c).
// They live in `@brainstorm-os/sdk/i18n` so there's one home; re-exported here so
// every existing shell importer keeps working unchanged.
export { SOURCE_LANGUAGE, localeFallbackChain } from "@brainstorm-os/sdk/i18n";

/** Languages with a shipped catalog, source language first. Grows as seed /
 *  community packs land. */
export const AVAILABLE_LANGUAGES = ["en", "es", "de"] as const;
export type AvailableLanguage = (typeof AVAILABLE_LANGUAGES)[number];

/** Languages whose catalog is a machine-translated first pass (shown with a
 *  badge in the picker; English is excluded — it's the human source). */
export const MACHINE_TRANSLATED_LANGUAGES: ReadonlySet<string> = new Set(["es", "de"]);

export function isAvailableLanguage(value: string): value is AvailableLanguage {
	return (AVAILABLE_LANGUAGES as readonly string[]).includes(value);
}

/** Human-readable label for a language tag — its autonym (the name in its own
 *  language, e.g. "Deutsch") via `Intl.DisplayNames`, falling back to the tag.
 *  Static fallbacks cover the shipped set when `Intl.DisplayNames` is absent. */
export function languageLabel(tag: string): string {
	const fallback = STATIC_LABELS[tag] ?? tag;
	try {
		const display = new Intl.DisplayNames([tag], { type: "language" });
		const name = display.of(tag);
		if (name && name !== tag) return capitalize(name);
	} catch {
		// Intl.DisplayNames unavailable — fall through to the static label.
	}
	return fallback;
}

const STATIC_LABELS: Record<string, string> = {
	en: "English",
	es: "Español",
	de: "Deutsch",
};

function capitalize(value: string): string {
	return value.length > 0 ? value[0]?.toUpperCase() + value.slice(1) : value;
}
