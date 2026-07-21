/**
 * Shared relative-date formatter for object rows / section headers /
 * agenda labels. Renders an epoch as "Today" / "Tomorrow" / "Yesterday",
 * a weekday name within a configurable window, or a locale month-day
 * (with year when it differs from `now`).
 *
 * Extracted at copy two: Calendar and Tasks both shipped a
 * `formatDateRelative(epochMs, now)`. The fixed anchors and the month-day
 * fallback were identical; they differed only in the weekday window and
 * style, which are now options. Callers pass their own already-translated
 * Today/Tomorrow/Yesterday labels (the `t()` namespace is app-specific).
 *
 * Locale-aware via `toLocaleDateString` (host locale); the caller never
 * hand-rolls month/weekday name tables.
 */

import type { FormatContext } from "@brainstorm-os/sdk-types";
import { daysBetween } from "./date-grid/date-grid";

/**
 * Locale + regional formatting context. Canonical definition lives in the leaf
 * `@brainstorm-os/sdk-types` so it can ride the app handshake + runtime (12.15
 * slice 15f); re-exported here because the formatters below consume it and most
 * call sites import it alongside them. Apps read the live context from
 * `runtime.format` (`useFormatContext` in `@brainstorm-os/sdk/i18n-react`); the
 * shell builds it from its dashboard snapshot.
 */
export type { FormatContext };

function withContext(
	ctx: FormatContext | undefined,
	base: Intl.DateTimeFormatOptions,
): { locale: string | undefined; options: Intl.DateTimeFormatOptions } {
	return {
		locale: ctx?.locale,
		options: {
			...base,
			...(ctx?.hour12 !== undefined ? { hour12: ctx.hour12 } : {}),
			...(ctx?.timeZone ? { timeZone: ctx.timeZone } : {}),
		},
	};
}

/**
 * Run a `Date#toLocale*String` call, degrading to the host default if the
 * context's locale / time zone is invalid. `FormatContext` carries
 * Settings → Regional values that are user-supplied AND CRDT-synced from other
 * devices, so a bad BCP-47 tag or IANA zone must never throw `RangeError` into a
 * render — it degrades to the host's own locale/zone instead. Mirrors the guard
 * the shell clock already wraps its `toLocaleTimeString` in.
 */
function safeDateFormat(
	format: (locale: string | undefined, options: Intl.DateTimeFormatOptions) => string,
	locale: string | undefined,
	options: Intl.DateTimeFormatOptions,
): string {
	try {
		return format(locale, options);
	} catch {
		// Drop the locale + the (possibly invalid) time zone; keep the shape
		// options. Host defaults can't throw, so this second call is safe.
		const hostOptions = Object.fromEntries(
			Object.entries(options).filter(([key]) => key !== "timeZone"),
		);
		return format(undefined, hostOptions);
	}
}

/** Format an instant as a date, honouring the locale + time zone in `ctx`.
 *  `options` defaults to a medium date style. */
export function formatDate(
	epochMs: number,
	ctx?: FormatContext,
	options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
	const { locale, options: opts } = withContext(ctx, options);
	return safeDateFormat((l, o) => new Date(epochMs).toLocaleDateString(l, o), locale, opts);
}

/** Format an instant as a clock time, honouring locale / hour cycle / zone. */
export function formatTime(
	epochMs: number,
	ctx?: FormatContext,
	options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" },
): string {
	const { locale, options: opts } = withContext(ctx, options);
	return safeDateFormat((l, o) => new Date(epochMs).toLocaleTimeString(l, o), locale, opts);
}

/** Format a number in the context locale. Degrades to the host locale if the
 *  context locale is an invalid tag (same CRDT-synced-input guard as the date
 *  formatters above). */
export function formatNumber(
	value: number,
	ctx?: FormatContext,
	options?: Intl.NumberFormatOptions,
): string {
	try {
		return value.toLocaleString(ctx?.locale, options);
	} catch {
		return value.toLocaleString(undefined, options);
	}
}

export type RelativeDateLabels = {
	today: string;
	tomorrow: string;
	yesterday: string;
};

export type RelativeDateOptions = {
	/** How many calendar days into the past still render as a weekday name
	 *  (beyond the special-cased "Yesterday"). Default 6. */
	weekdayBackDays?: number;
	/** How many calendar days into the future render as a weekday name
	 *  (beyond the special-cased "Tomorrow"). Default 6. */
	weekdayForwardDays?: number;
	/** `"long"` → "Friday", `"short"` → "Fri". Default `"long"`. */
	weekdayStyle?: "long" | "short";
};

export function formatRelativeDate(
	epochMs: number,
	now: number,
	labels: RelativeDateLabels,
	options?: RelativeDateOptions,
	ctx?: FormatContext,
): string {
	const back = options?.weekdayBackDays ?? 6;
	const forward = options?.weekdayForwardDays ?? 6;
	const weekdayStyle = options?.weekdayStyle ?? "long";

	const delta = daysBetween(now, epochMs);
	if (delta === 0) return labels.today;
	if (delta === 1) return labels.tomorrow;
	if (delta === -1) return labels.yesterday;

	const d = new Date(epochMs);
	if (delta >= -back && delta <= forward) {
		const { locale, options: opts } = withContext(ctx, { weekday: weekdayStyle });
		return safeDateFormat((l, o) => d.toLocaleDateString(l, o), locale, opts);
	}

	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	const { locale, options: opts } = withContext(
		ctx,
		sameYear
			? { month: "short", day: "numeric" }
			: { month: "short", day: "numeric", year: "numeric" },
	);
	return safeDateFormat((l, o) => d.toLocaleDateString(l, o), locale, opts);
}

/**
 * Date label for a **group / section header** in a scrolling list (Calendar
 * agenda day sub-headers, Tasks "Upcoming" section headers). Unlike
 * `formatRelativeDate` — which switches from a bare weekday name ("Saturday")
 * for near dates to an absolute "13 Jun" for far ones, so one scroll shows two
 * date languages — this uses ONE consistent shape: the universal "Today" /
 * "Tomorrow" / "Yesterday" anchors, and for every other day a weekday + day +
 * month ("Sat 13 Jun"). The day-of-month is always present, so a header is
 * never the ambiguous bare "Sat" ("which Saturday?"), and there is no
 * relative↔absolute switch mid-list. Both Calendar and Tasks call this so the
 * two apps' group headers read identically (cross-app consistency).
 */
export function formatGroupDate(
	epochMs: number,
	now: number,
	labels: RelativeDateLabels,
	ctx?: FormatContext,
): string {
	const delta = daysBetween(now, epochMs);
	if (delta === 0) return labels.today;
	if (delta === 1) return labels.tomorrow;
	if (delta === -1) return labels.yesterday;

	const d = new Date(epochMs);
	const sameYear = d.getFullYear() === new Date(now).getFullYear();
	const { locale, options } = withContext(
		ctx,
		sameYear
			? { weekday: "short", day: "numeric", month: "short" }
			: { weekday: "short", day: "numeric", month: "short", year: "numeric" },
	);
	return safeDateFormat((l, o) => d.toLocaleDateString(l, o), locale, options);
}
