/**
 * Shared shell-preference contracts for the settings overhaul: language,
 * regional formats, header chrome (interface), and notifications.
 *
 * Pure types + enums + defaults — no Electron, no React — so the main
 * process, preload and renderer all import the same source of truth (the
 * `shared/` layer is the lowest, like `shared/appearance`). Wire format is the
 * enum *values* (plain strings), persisted in the per-vault dashboard Yjs doc.
 *
 * Every value drawn from a known small set is an enum, per the project's
 * no-raw-string-discriminators rule.
 */

/** Time-of-day presentation. `Auto` defers to the active locale / OS. */
export enum HourCyclePref {
	Auto = "auto",
	/** 12-hour with AM/PM. */
	H12 = "h12",
	/** 24-hour. */
	H23 = "h23",
}

/** `Intl.DateTimeFormat` dateStyle, plus `Auto` (locale default). */
export enum DateStylePref {
	Auto = "auto",
	Short = "short",
	Medium = "medium",
	Long = "long",
	Full = "full",
}

/** First day of the week. `Auto` = locale default; otherwise 0=Sunday … 6=Saturday. */
export const FIRST_DAY_AUTO = "auto" as const;
export type FirstDayOfWeek = typeof FIRST_DAY_AUTO | 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The user's chosen UI language (BCP-47 tag) for in-vault surfaces. */
export type LocaleState = {
	/** BCP-47 language tag, e.g. `"en"`, `"es"`, `"de-AT"`. */
	language: string;
};

export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_LOCALE: LocaleState = { language: DEFAULT_LANGUAGE };

/** Regional formatting overrides. Every field defaults to "auto", in which
 *  case behaviour is identical to today (the active locale / OS decides) — so
 *  introducing this is non-breaking until a user opts into an override. */
export type RegionalState = {
	hourCycle: HourCyclePref;
	dateStyle: DateStylePref;
	firstDayOfWeek: FirstDayOfWeek;
	/** BCP-47 tag for number formatting, or `"auto"`. */
	numberLocale: string;
	/** IANA zone (e.g. `"Europe/Berlin"`) or `"auto"` for the system zone. */
	timezone: string;
};

export const REGIONAL_AUTO = "auto" as const;

export const DEFAULT_REGIONAL: RegionalState = {
	hourCycle: HourCyclePref.Auto,
	dateStyle: DateStylePref.Auto,
	firstDayOfWeek: FIRST_DAY_AUTO,
	numberLocale: REGIONAL_AUTO,
	timezone: REGIONAL_AUTO,
};

/** Every toggleable control in the dashboard header. Dev-only buttons (seed /
 *  reseed) are deliberately excluded — they never ship. The ⋯ object menu of
 *  apps is unrelated; this is the shell header only. */
export enum HeaderControlId {
	Clock = "clock",
	SyncStatus = "sync-status",
	Notifications = "notifications",
	Appearance = "appearance",
	AddWidget = "add-widget",
	Search = "search",
	Marketplace = "marketplace",
	Bin = "bin",
	Cheatsheet = "cheatsheet",
	Help = "help",
	VaultInfo = "vault-info",
	Settings = "settings",
}

/** All header controls, in render order — the single list the header maps over
 *  and the Interface settings UI lists. Settings is intentionally last so it
 *  stays reachable even if everything else is hidden (the UI also pins it). */
export const HEADER_CONTROL_ORDER: readonly HeaderControlId[] = [
	HeaderControlId.Clock,
	HeaderControlId.SyncStatus,
	HeaderControlId.Notifications,
	HeaderControlId.Appearance,
	HeaderControlId.AddWidget,
	HeaderControlId.Search,
	HeaderControlId.Marketplace,
	HeaderControlId.Bin,
	HeaderControlId.Cheatsheet,
	HeaderControlId.Help,
	HeaderControlId.VaultInfo,
	HeaderControlId.Settings,
];

export type ClockPrefs = {
	show: boolean;
	showSeconds: boolean;
	/** Override the regional hour cycle for the header clock specifically. */
	hourCycle: HourCyclePref;
};

export type ChromeState = {
	/** Per-control visibility. An absent entry means visible (default true), so
	 *  new controls light up by default without a migration. */
	visibility: Partial<Record<HeaderControlId, boolean>>;
	clock: ClockPrefs;
};

export const DEFAULT_CLOCK_PREFS: ClockPrefs = {
	show: true,
	showSeconds: false,
	hourCycle: HourCyclePref.Auto,
};

export const DEFAULT_CHROME: ChromeState = {
	visibility: {},
	clock: { ...DEFAULT_CLOCK_PREFS },
};

/** Resolve the effective visibility of a header control (default visible). */
export function isHeaderControlVisible(chrome: ChromeState, id: HeaderControlId): boolean {
	return chrome.visibility[id] !== false;
}

export function isHeaderControlId(value: string): value is HeaderControlId {
	return (Object.values(HeaderControlId) as string[]).includes(value);
}

/** Resolve the effective hour cycle: a non-Auto override (e.g. the clock's own
 *  setting) wins over the regional default; Auto regional means "follow the
 *  locale/OS". Pure — shared by the header clock and the Track B formatter. */
export function effectiveHourCycle(
	override: HourCyclePref,
	regional: HourCyclePref,
): HourCyclePref {
	if (override !== HourCyclePref.Auto) return override;
	return regional;
}

/** Map an hour-cycle pref to the `Intl.DateTimeFormat` `hour12` option.
 *  `Auto` ⇒ `undefined` (let the locale decide). */
export function hourCycleToHour12(hourCycle: HourCyclePref): boolean | undefined {
	if (hourCycle === HourCyclePref.H12) return true;
	if (hourCycle === HourCyclePref.H23) return false;
	return undefined;
}

export const NOTIFICATION_KINDS = ["info", "success", "warning", "error"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: unknown): value is NotificationKind {
	return typeof value === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/** Do-not-disturb / quiet-hours window. `start`/`end` are `"HH:MM"` (24h)
 *  local-time bounds; when `end <= start` the window wraps past midnight. */
export type DndPrefs = {
	enabled: boolean;
	start: string;
	end: string;
};

export const DEFAULT_DND: DndPrefs = { enabled: false, start: "22:00", end: "08:00" };

export type NotificationsState = {
	/** Raise OS-native notifications (Electron `Notification`) in addition to
	 *  in-app toasts. */
	osNative: boolean;
	dnd: DndPrefs;
	/** appId → muted. Absent = not muted. */
	mutes: Record<string, boolean>;
};

export const DEFAULT_NOTIFICATIONS: NotificationsState = {
	osNative: true,
	dnd: { ...DEFAULT_DND },
	mutes: {},
};

/** A durable notification-center entry. The transient toast store is separate;
 *  this is the persisted history (per-vault, capped). */
export type NotificationRecord = {
	id: string;
	appId: string;
	title: string;
	body?: string;
	kind: NotificationKind;
	/** Epoch millis when posted. */
	ts: number;
	read: boolean;
	/** The vault entity this notification is about; clicking the center entry
	 *  dispatches an `intent.open` for it. Absent = inert entry. */
	entityId?: string;
};

export const NOTIFICATION_HISTORY_CAP = 200;

/** True when `now` (a Date) falls inside the DND window. Pure so it unit-tests
 *  without a clock; handles windows that wrap past midnight. */
export function isWithinDnd(dnd: DndPrefs, now: Date): boolean {
	if (!dnd.enabled) return false;
	const start = parseHhMm(dnd.start);
	const end = parseHhMm(dnd.end);
	if (start === null || end === null) return false;
	const mins = now.getHours() * 60 + now.getMinutes();
	if (start === end) return false;
	return start < end ? mins >= start && mins < end : mins >= start || mins < end;
}

function parseHhMm(value: string): number | null {
	const match = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(value);
	if (!match) return null;
	return Number(match[1]) * 60 + Number(match[2]);
}
