/**
 * Non-React locale wiring for the hybrid Database app (12.15 slice 15d).
 * There is no single React root to hang a provider on, so this module reads
 * the shell's locale surface (`window.brainstorm`) directly: resolve the
 * active locale's overlay pack, swap the app translator, and notify the
 * imperative render loop so already-painted chrome re-renders in the new
 * language. Menus / dialogs built on demand pick up the new `t` for free.
 */

import { SOURCE_LANGUAGE, createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { DATABASE_I18N, LOCALE_PACK_IMPORTERS, syncActiveTranslator } from "./i18n";

type LocaleRuntimeSlice = {
	readonly locale?: string;
	onLocaleChange?(handler: (locale: string) => void): { unsubscribe(): void } | (() => void);
};

const listeners = new Set<() => void>();

/** Register a listener fired after the active translator swaps (a pack
 *  landed, or the shell locale flipped). Returns the unsubscribe. */
export function onTranslatorChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

async function applyLocale(locale: string): Promise<void> {
	const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
	syncActiveTranslator(createT(DATABASE_I18N, pack ?? undefined));
	for (const listener of listeners) listener();
}

/** Seed from the launch-snapshot locale, then track the live change stream.
 *  App-lifetime subscription — no teardown needed. */
export function startLocaleSync(): void {
	const runtime = (globalThis as { brainstorm?: LocaleRuntimeSlice }).brainstorm;
	if (!runtime) return;
	if (runtime.locale && runtime.locale !== SOURCE_LANGUAGE) void applyLocale(runtime.locale);
	runtime.onLocaleChange?.((next) => {
		if (typeof next === "string" && next.length > 0) void applyLocale(next);
	});
}
