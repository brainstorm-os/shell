/**
 * Pure value→string formatters and string→value parsers, one per
 * (valueType, surface) combination the cells need.
 *
 * These live separately from the cell `.tsx` files because the test
 * environment is `node` (no DOM) — so the formatting logic gets unit
 * coverage, while the cell components themselves are validated by
 * eye + integration usage.
 *
 * Locale: every formatter defers to the host `Intl` (Vitest's Node
 * uses `en-US`; the Electron renderer uses the OS locale). When the
 * shell's locale layer lands (Stage 12) callers pass the chosen
 * locale through `opts.locale` instead.
 */

import {
	DateGranularity,
	type DateValue,
	type PropertyDef,
	PropertyFormat,
	ValueType,
} from "@brainstorm-os/sdk-types";

export type FormatOptions = {
	locale?: string;
};

// `Intl.*Format` construction is expensive and runs per-row per-render
// (formatNumber/formatDate). The option space is bounded (locale ×
// style × currency × precision / locale × includeTime) so a module
// cache keyed on the serialized tuple is safe and unbounded only in
// the pathological sense of "every locale ever seen this session".
const numberFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function numberFormatter(
	locale: string | undefined,
	opts: Intl.NumberFormatOptions,
): Intl.NumberFormat {
	const key = `${locale ?? ""}|${opts.style ?? ""}|${opts.currency ?? ""}|${
		opts.minimumFractionDigits ?? ""
	}|${opts.maximumFractionDigits ?? ""}`;
	let f = numberFormatters.get(key);
	if (!f) {
		f = new Intl.NumberFormat(locale, opts);
		numberFormatters.set(key, f);
	}
	return f;
}

export function dateFormatter(
	locale: string | undefined,
	includeTime: boolean,
): Intl.DateTimeFormat {
	const key = `${locale ?? ""}|${includeTime ? "1" : "0"}`;
	let f = dateFormatters.get(key);
	if (!f) {
		f = new Intl.DateTimeFormat(locale, {
			dateStyle: "medium",
			...(includeTime ? { timeStyle: "short" } : {}),
		});
		dateFormatters.set(key, f);
	}
	return f;
}

/** Render the scalar value as a display string. Returns "" for empty
 *  so the caller can decide whether to show a placeholder. The
 *  `def` carries the modifiers (format, precision, currency, etc.)
 *  the formatter needs. */
export function formatScalar(def: PropertyDef, value: unknown, opts: FormatOptions = {}): string {
	switch (def.valueType) {
		case ValueType.Text:
		case ValueType.EntityRef:
			return (value as string | null) ?? "";
		case ValueType.Number:
			return formatNumber(value as number | null, def, opts);
		case ValueType.Date:
			return formatDate(value as DateValue | null, opts);
		case ValueType.Boolean:
			return value ? "✓" : "";
		case ValueType.RichText:
			return "";
	}
}

/** The string an inline editor pre-fills with. Numbers edit as their RAW value
 *  (not the formatted display): a currency/percent symbol or digit-grouping
 *  ("$25,000", "25%", "25,000") can't load into an `<input type="number">` and
 *  would parse back to NaN — so editing a formatted number would silently wipe
 *  it. Text (incl. url/email/phone) edits as its display, which is identity. */
export function editScalar(def: PropertyDef, value: unknown): string {
	if (def.valueType === ValueType.Number) {
		return value === null || value === undefined ? "" : String(value);
	}
	return formatScalar(def, value);
}

export function formatNumber(
	value: number | null,
	def: PropertyDef,
	opts: FormatOptions = {},
): string {
	if (value === null) return "";
	const locale = opts.locale;
	const fractionDigits = def.precision;
	const formatOpts: Intl.NumberFormatOptions = {};
	if (fractionDigits !== undefined) {
		formatOpts.minimumFractionDigits = fractionDigits;
		formatOpts.maximumFractionDigits = fractionDigits;
	}
	switch (def.format) {
		case PropertyFormat.Percent:
			return numberFormatter(locale, { ...formatOpts, style: "percent" }).format(value);
		case PropertyFormat.Currency: {
			const currency = def.currency ?? "USD";
			try {
				return numberFormatter(locale, {
					...formatOpts,
					style: "currency",
					currency,
				}).format(value);
			} catch {
				return `${numberFormatter(locale, formatOpts).format(value)} ${currency}`;
			}
		}
		case PropertyFormat.Duration:
			return formatDuration(value);
		default:
			return numberFormatter(locale, formatOpts).format(value);
	}
}

/** Render a number of **hours** as a human duration: `3h 30m`, `45m`,
 *  `2h`, `0h`. Fractional hours round to the nearest minute (1.5 → "1h
 *  30m", 0.25 → "15m"). Negative durations keep a leading "-". The "h" /
 *  "m" unit suffixes are English-only until the Stage-12 locale layer
 *  (same staging as the relative-date keywords below). Shared by the
 *  number cell + the Database aggregation footer so a Duration column's
 *  Sum reads as "40h", not "40". */
export function formatDuration(value: number | null): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return "";
	const sign = value < 0 ? "-" : "";
	const totalMinutes = Math.round(Math.abs(value) * 60);
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	if (h === 0 && m === 0) return "0h";
	if (h === 0) return `${sign}${m}m`;
	if (m === 0) return `${sign}${h}h`;
	return `${sign}${h}h ${m}m`;
}

export function formatDate(value: DateValue | null, opts: FormatOptions = {}): string {
	if (!value) return "";
	const date = new Date(value.at);
	if (Number.isNaN(date.getTime())) return "";
	const includeTime =
		value.granularity === DateGranularity.DateTime || value.granularity === DateGranularity.Time;
	return dateFormatter(opts.locale, includeTime).format(date);
}

const DAY_MS = 86_400_000;

/** Day index (local) for relative-distance math — floors to the local
 *  calendar day so DST shifts don't smear the boundary. */
function localDayIndex(ms: number): number {
	const d = new Date(ms);
	return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);
}

/** Relative date phrasing for the `PropertyView.Relative` cell:
 *  Today / Tomorrow / Yesterday, then "in N days" / "N days ago" within a
 *  fortnight, falling back to the absolute `formatDate` beyond that (a
 *  relative "in 96 days" reads worse than the date itself). `nowMs` is
 *  injectable for tests. */
export function formatRelativeDate(
	value: DateValue | null,
	nowMs: number = Date.now(),
	opts: FormatOptions = {},
): string {
	if (!value) return "";
	if (Number.isNaN(new Date(value.at).getTime())) return "";
	const diff = localDayIndex(value.at) - localDayIndex(nowMs);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	if (diff > 1 && diff <= 14) return `in ${diff} days`;
	if (diff < -1 && diff >= -14) return `${-diff} days ago`;
	return formatDate(value, opts);
}

/** Parse a free-text scalar input into the value-shape for `def`.
 *  Returns the empty form (null / `false`) when the input doesn't
 *  parse — cells call `coerceValue` afterward to clamp. */
export function parseScalar(def: PropertyDef, raw: string): unknown {
	const trimmed = raw.trim();
	switch (def.valueType) {
		case ValueType.Text:
		case ValueType.EntityRef:
			return trimmed.length === 0 ? null : trimmed;
		case ValueType.Number:
			return parseNumberInput(trimmed);
		case ValueType.Date:
			return parseDateInput(trimmed, def.granularity);
		case ValueType.Boolean:
			return /^(true|yes|1|on)$/i.test(trimmed);
		case ValueType.RichText:
			return null;
	}
}

export function parseNumberInput(raw: string): number | null {
	if (raw.length === 0) return null;
	const cleaned = raw.replace(/[\s,]/g, "");
	const n = Number(cleaned);
	return Number.isFinite(n) ? n : null;
}

/** Parses ISO-8601 date / datetime strings AND the common `YYYY-MM-DD`
 *  + `YYYY-MM-DD HH:mm` shapes. Falls through to the natural-language
 *  parser ("today", "tomorrow", "next monday", "in 3 days") for B5.9 —
 *  this is the single date entry point; the DateCell does not
 *  re-implement parsing.
 *
 *  Locale: keyword set is English-only until the Stage-12 locale layer
 *  (same staging as the `Intl`-deferred formatters above). The relative
 *  forms ("in N days") are locale-independent. */
export function parseDateInput(raw: string, granularity?: DateGranularity): DateValue | null {
	if (raw.length === 0) return null;
	const hasTime = /[T\s]\d{1,2}:\d{2}/.test(raw);
	const ms = Date.parse(raw);
	if (!Number.isNaN(ms)) {
		const finalGranularity =
			granularity ?? (hasTime ? DateGranularity.DateTime : DateGranularity.Date);
		return {
			at: ms,
			granularity: finalGranularity,
		};
	}
	return parseNaturalDate(raw, granularity);
}

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
] as const;

function atMidnight(d: Date): Date {
	d.setHours(0, 0, 0, 0);
	return d;
}

/** Natural-language date phrases. Returns `null` (caller clamps) on
 *  anything it doesn't recognise. `now` is injectable for tests. */
export function parseNaturalDate(
	raw: string,
	granularity?: DateGranularity,
	now: Date = new Date(),
): DateValue | null {
	const text = raw.trim().toLowerCase();
	if (text.length === 0) return null;
	const base = atMidnight(new Date(now));
	const g = granularity ?? DateGranularity.Date;
	const make = (d: Date): DateValue => ({ at: d.getTime(), granularity: g });

	if (text === "today") return make(base);
	if (text === "tomorrow") {
		base.setDate(base.getDate() + 1);
		return make(base);
	}
	if (text === "yesterday") {
		base.setDate(base.getDate() - 1);
		return make(base);
	}

	const inDays = text.match(/^in\s+(\d{1,4})\s+days?$/);
	if (inDays?.[1]) {
		base.setDate(base.getDate() + Number(inDays[1]));
		return make(base);
	}
	const agoDays = text.match(/^(\d{1,4})\s+days?\s+ago$/);
	if (agoDays?.[1]) {
		base.setDate(base.getDate() - Number(agoDays[1]));
		return make(base);
	}
	const inWeeks = text.match(/^in\s+(\d{1,3})\s+weeks?$/);
	if (inWeeks?.[1]) {
		base.setDate(base.getDate() + Number(inWeeks[1]) * 7);
		return make(base);
	}

	const next = text.match(/^next\s+(\w+)$/);
	if (next?.[1]) {
		const wd = WEEKDAYS.indexOf(next[1] as (typeof WEEKDAYS)[number]);
		if (wd >= 0) {
			const delta = (wd - base.getDay() + 7) % 7 || 7;
			base.setDate(base.getDate() + delta);
			return make(base);
		}
		if (next[1] === "week") {
			base.setDate(base.getDate() + 7);
			return make(base);
		}
		if (next[1] === "month") {
			base.setMonth(base.getMonth() + 1);
			return make(base);
		}
	}

	const bareWeekday = WEEKDAYS.indexOf(text as (typeof WEEKDAYS)[number]);
	if (bareWeekday >= 0) {
		const delta = (bareWeekday - base.getDay() + 7) % 7 || 7;
		base.setDate(base.getDate() + delta);
		return make(base);
	}

	return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d][\d\s().-]{5,}$/;

/** Validate a `text + format` scalar for the formatted kinds (Url /
 *  Email / Phone). Empty is always valid (optional). Returns `true`
 *  when the value satisfies the format or the format has no rule. The
 *  Url/Email/Phone cells render a red border + tooltip when this is
 *  `false`. */
export function isValidFormatted(format: PropertyFormat | undefined, value: string): boolean {
	const v = value.trim();
	if (v.length === 0) return true;
	switch (format) {
		case PropertyFormat.Url:
			try {
				new URL(/^[a-z][\w+.-]*:\/\//i.test(v) ? v : `https://${v}`);
				return true;
			} catch {
				return false;
			}
		case PropertyFormat.Email:
			return EMAIL_RE.test(v);
		case PropertyFormat.Phone:
			return PHONE_RE.test(v);
		default:
			return true;
	}
}
