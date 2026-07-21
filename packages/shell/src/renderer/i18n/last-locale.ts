/**
 * Device-local memory of the last applied UI language (12.15 slice 15e).
 *
 * The active language normally rides the per-vault dashboard snapshot, so it's
 * only known once a vault is open. Pre-vault surfaces — the vault picker and the
 * lock screen — render before that, and previously fell back to English (the
 * documented Track A limitation). Persisting the last applied language *outside*
 * any vault (renderer `localStorage`, device-scoped like the wallpaper / icon
 * caches) lets those surfaces open in the language the user last used.
 *
 * Stored as a bare BCP-47 tag. Unknown / stale tags are harmless: the loader
 * resolves them through the fallback chain and lands on English.
 */

import { DEFAULT_LANGUAGE } from "@brainstorm-os/protocol/shell-prefs";

const STORAGE_KEY = "brainstorm.locale.last";

/** The last applied UI language on this device, or the source language on first
 *  run / when storage is unavailable. Synchronous so the boot path can seed the
 *  pre-vault language before first paint. */
export function readLastLocale(): string {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return stored && stored.trim().length > 0 ? stored : DEFAULT_LANGUAGE;
	} catch {
		return DEFAULT_LANGUAGE;
	}
}

/** Record the language just applied so the next boot's pre-vault surfaces use
 *  it. A storage failure is swallowed — the device simply forgets and falls
 *  back to English next time. */
export function rememberLastLocale(language: string): void {
	if (typeof language !== "string" || language.trim().length === 0) return;
	try {
		window.localStorage.setItem(STORAGE_KEY, language);
	} catch {
		// Storage disabled / full — nothing to do; English is the fallback.
	}
}
