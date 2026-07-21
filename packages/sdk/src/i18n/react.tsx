/**
 * `@brainstorm-os/sdk/i18n-react` — the React half of the app-side i18n stack
 * (12.15 slice 15b). Kept in its own subpath so the pure `@brainstorm-os/sdk/i18n`
 * barrel (`createT` / labels) stays React-free — `@brainstorm-os/sdk-types`
 * imports that barrel, and the leaf package must not pull React.
 *
 * Two hooks:
 *   - `useLocale()` — the live active UI locale, re-rendering on a language
 *     switch. The shell drives `runtime.onLocaleChange` from the
 *     `app:locale-changed` broadcast (slice 15a); the callback ARGUMENT is the
 *     live value (across the sandbox boundary `runtime.locale` is only the
 *     launch snapshot, exactly like `capabilities`), so the hook seeds from
 *     `runtime.locale` and then tracks the change stream.
 *   - `useT(manifest, overridesByLocale?)` — a locale-reactive `t()`: it
 *     re-derives `createT(manifest, overridesByLocale[locale])` whenever the
 *     locale changes, so an app needn't thread locale state itself. The
 *     per-locale overlay packs + fallback-chain resolution that populate
 *     `overridesByLocale` are slice 15c; until they ship, apps stay English
 *     (the documented partial-localization fallback) and `useT` still gives
 *     them a stable, reactive `t`.
 */

import {
	DEFAULT_FORMAT_CONTEXT,
	DEFAULT_LOCALE,
	type FormatContext,
	type Subscription,
} from "@brainstorm-os/sdk-types";
import { useEffect, useMemo, useState } from "react";
import { formatDate, formatNumber } from "../date-formatters";
import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	resolveLocalePack,
} from "./common-labels";

/** The slice of the SDK runtime the locale hooks read. Structurally typed (not
 *  the full `AppRuntime`) so the hooks work against any host that exposes a
 *  locale surface — the shell preload, the mock-shell harness, or a test fake.
 *  `onLocaleChange` may return an `{ unsubscribe }` object (the SDK runtime) or
 *  a bare teardown function; both are normalised. */
export type LocaleRuntime = {
	readonly locale?: string;
	onLocaleChange?(handler: (locale: string) => void): Subscription | (() => void);
};

/** The slice of the SDK runtime the regional-format hooks read (12.15 15f).
 *  Structurally typed like `LocaleRuntime`; `onFormatChange` may return a
 *  `Subscription` or a bare teardown function. */
export type FormatRuntime = {
	readonly format?: FormatContext;
	onFormatChange?(handler: (format: FormatContext) => void): Subscription | (() => void);
};

/** The ambient runtime, or `null` on a non-shell host (standalone preview,
 *  unit test without an injected runtime). The shell exposes the full runtime,
 *  so it carries both the locale and format surfaces. */
function ambientRuntime(): (LocaleRuntime & FormatRuntime) | null {
	return (globalThis as { brainstorm?: LocaleRuntime & FormatRuntime }).brainstorm ?? null;
}

/**
 * Live active UI locale (BCP-47 tag). Pass an explicit `runtime` in tests /
 * non-shell hosts; omit it to read the ambient `window.brainstorm`.
 */
export function useLocale(runtime?: LocaleRuntime | null): string {
	const rt = runtime !== undefined ? runtime : ambientRuntime();
	const [locale, setLocale] = useState<string>(() => rt?.locale ?? DEFAULT_LOCALE);

	useEffect(() => {
		const next = rt?.locale ?? DEFAULT_LOCALE;
		// A locale change between the initial render and effect attach (rare —
		// would need a switch within the mount tick) is caught by re-seeding here.
		setLocale(next);
		if (!rt?.onLocaleChange) return;
		const sub = rt.onLocaleChange((updated) => {
			if (typeof updated === "string" && updated.length > 0) setLocale(updated);
		});
		return typeof sub === "function" ? sub : () => sub.unsubscribe();
	}, [rt]);

	return locale;
}

/** Per-locale overlay packs, keyed by BCP-47 tag. Each is a `Partial<M>` of the
 *  manifest keys that locale translates (slice 15c produces these). */
export type LocaleOverrides<M extends Record<string, string>> = Partial<Record<string, Partial<M>>>;

/**
 * Locale-reactive `t()`. Returns a `createT`-backed function that re-derives
 * whenever the active locale changes, selecting `overridesByLocale[locale]` as
 * the overlay (English defaults when absent). Fallback-chain resolution
 * (`es-ES`→`es`→`en`) is slice 15c — this does an exact-tag lookup.
 */
export function useT<M extends Record<string, string>>(
	manifest: M,
	overridesByLocale?: LocaleOverrides<M>,
	runtime?: LocaleRuntime | null,
): TFunction<M> {
	const locale = useLocale(runtime);
	return useMemo(
		() => createT(manifest, overridesByLocale?.[locale]),
		[manifest, overridesByLocale, locale],
	);
}

/**
 * Locale-reactive `t()` backed by **lazily-loaded** overlay packs (12.15 slice
 * 15c). The sibling of `useT`, but instead of an eager `overridesByLocale` map
 * it takes an app's `LocalePackImporters` (`{ de: () => import("./i18n/de.json") }`)
 * and resolves the active locale's pack through `resolveLocalePack` (fallback
 * chain, source-language short-circuit, import-failure tolerance). The pack
 * code-splits, so an untranslated app — or one whose active locale has no pack —
 * adds zero cold-bundle weight and simply renders English.
 *
 * Render flow: the first frame (and every frame until the async import resolves)
 * uses the English manifest; when the overlay arrives the `t` re-derives and the
 * component re-renders. Switching locale re-runs the load. A pack that fails to
 * import falls back to English rather than throwing into render.
 *
 * Pass a STABLE `importers` reference (module-scope const, or `useMemo`) — it's
 * in the load effect's dependency array, so a fresh inline object each render
 * would re-fire the dynamic import every render.
 */
export function useLocalePackT<M extends Record<string, string>>(
	manifest: M,
	importers?: LocalePackImporters<M>,
	runtime?: LocaleRuntime | null,
): TFunction<M> {
	const locale = useLocale(runtime);
	const [overlay, setOverlay] = useState<Partial<M> | null>(null);

	useEffect(() => {
		if (!importers) {
			setOverlay(null);
			return;
		}
		let live = true;
		resolveLocalePack<M>(locale, importers)
			.then((pack) => {
				if (live) setOverlay(pack);
			})
			.catch(() => {
				if (live) setOverlay(null);
			});
		return () => {
			live = false;
		};
	}, [importers, locale]);

	return useMemo(() => createT(manifest, overlay ?? undefined), [manifest, overlay]);
}

/**
 * Live regional-format context (12.15 slice 15f) — the locale + hour cycle +
 * time zone derived from Settings → Regional, re-rendering when the user edits a
 * Regional value. Seeds from `runtime.format` (the launch snapshot) then tracks
 * `onFormatChange` (the live value across the sandbox boundary, exactly like
 * `useLocale`). Pass an explicit `runtime` in tests; omit it to read ambient
 * `window.brainstorm`.
 */
export function useFormatContext(runtime?: FormatRuntime | null): FormatContext {
	const rt = runtime !== undefined ? runtime : ambientRuntime();
	const [format, setFormat] = useState<FormatContext>(() => rt?.format ?? DEFAULT_FORMAT_CONTEXT);

	useEffect(() => {
		setFormat(rt?.format ?? DEFAULT_FORMAT_CONTEXT);
		if (!rt?.onFormatChange) return;
		const sub = rt.onFormatChange((updated) => {
			if (updated && typeof updated === "object") setFormat(updated);
		});
		return typeof sub === "function" ? sub : () => sub.unsubscribe();
	}, [rt]);

	return format;
}

/** A `formatDate` bound to the live `FormatContext` (doc-21 §240). Dates follow
 *  Settings → Regional and re-render on a change. */
export function useFormatDate(
	runtime?: FormatRuntime | null,
): (epochMs: number, options?: Intl.DateTimeFormatOptions) => string {
	const ctx = useFormatContext(runtime);
	return useMemo(
		() => (epochMs: number, options?: Intl.DateTimeFormatOptions) =>
			formatDate(epochMs, ctx, options),
		[ctx],
	);
}

/** A `formatNumber` bound to the live `FormatContext` (doc-21 §240). */
export function useFormatNumber(
	runtime?: FormatRuntime | null,
): (value: number, options?: Intl.NumberFormatOptions) => string {
	const ctx = useFormatContext(runtime);
	return useMemo(
		() => (value: number, options?: Intl.NumberFormatOptions) => formatNumber(value, ctx, options),
		[ctx],
	);
}

export type { FormatContext, LocalePackImporters, TFunction, TParams };
