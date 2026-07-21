/**
 * Derive the app-facing `FormatContext` from the dashboard's language +
 * regional settings (12.15 slice 15f). The shell carries the result to apps two
 * ways — stamped on the launch handshake (first frame) and broadcast on the
 * `app:format-changed` channel (live) — so app-rendered dates / times / numbers
 * follow Settings → Regional just like the shell's own clock does.
 *
 * Pure (no Electron / React); shared by the launch stamp + the broadcast diff.
 */

import type { FormatContext } from "@brainstorm-os/sdk-types";
import { REGIONAL_AUTO, type RegionalState, hourCycleToHour12 } from "./shell-prefs";

/**
 * Map the UI language + regional overrides onto a provider-neutral
 * `FormatContext`. The number/date locale follows an explicit `numberLocale`
 * override when set, else the UI language (so formatting tracks the interface by
 * default); the hour cycle + time zone apply only when overridden. An `"auto"`
 * field leaves the corresponding context field unset (host/locale default).
 */
export function regionalToFormatContext(language: string, regional: RegionalState): FormatContext {
	const ctx: FormatContext = {};

	const formatLocale =
		regional.numberLocale && regional.numberLocale !== REGIONAL_AUTO
			? regional.numberLocale
			: language;
	if (formatLocale) ctx.locale = formatLocale;

	const hour12 = hourCycleToHour12(regional.hourCycle);
	if (hour12 !== undefined) ctx.hour12 = hour12;

	if (regional.timezone && regional.timezone !== REGIONAL_AUTO) ctx.timeZone = regional.timezone;

	return ctx;
}

/** Structural equality of two contexts — lets the broadcaster skip redundant
 *  fan-outs when an unrelated dashboard mutation leaves the format unchanged.
 *  Intentionally duplicated by the renderer-side `sameFormat` in
 *  `@brainstorm-os/sdk` `runtime.ts`: that copy can't import this one (leaf SDK
 *  must not depend on the shell), so don't "dedupe" them into a layer crossing. */
export function sameFormatContext(a: FormatContext, b: FormatContext): boolean {
	return a.locale === b.locale && a.hour12 === b.hour12 && a.timeZone === b.timeZone;
}
