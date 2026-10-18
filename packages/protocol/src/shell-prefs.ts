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

import {
	DisplayAttribute,
	DisplayAttributeValue,
	type Tokens,
	higherContrastOverrides,
} from "@brainstorm-os/tokens";

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

/** Settings → Appearance visibility preferences (12.18). Per-vault like every
 *  other appearance setting; the shell paints them into its own renderer and
 *  pushes them to every app renderer beside the theme (`app:display-changed`).
 *  All off by default ⇒ every theme renders exactly as designed. */
export type DisplayPrefs = {
	/** Stronger borders, dividers, muted labels and active-item fills — token
	 *  overrides from `@brainstorm-os/tokens` `higherContrastOverrides`. */
	higherContrast: boolean;
	/** Accent caret + a stronger selection wash in every text field. */
	emphasizeTextCursor: boolean;
	/** Classic always-visible scrollbars instead of macOS overlay bars. */
	alwaysShowScrollbars: boolean;
};

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
	higherContrast: false,
	emphasizeTextCursor: false,
	alwaysShowScrollbars: false,
};

/** Every `DisplayPrefs` key, in Settings order — the one list the store,
 *  the boot-arg codec and the Settings UI iterate. */
export const DISPLAY_PREF_KEYS: readonly (keyof DisplayPrefs)[] = [
	"higherContrast",
	"emphasizeTextCursor",
	"alwaysShowScrollbars",
];

/** Normalise an untrusted payload (IPC arg, persisted map, argv) to a full
 *  `DisplayPrefs`: unknown keys drop, non-boolean values fall to the default. */
export function toDisplayPrefs(raw: unknown): DisplayPrefs {
	const out: DisplayPrefs = { ...DEFAULT_DISPLAY_PREFS };
	if (!raw || typeof raw !== "object") return out;
	const record = raw as Record<string, unknown>;
	for (const key of DISPLAY_PREF_KEYS) {
		if (typeof record[key] === "boolean") out[key] = record[key];
	}
	return out;
}

/** argv form for an app renderer's first paint: the comma-joined names of the
 *  preferences that are on (`""` ⇒ all off). Names only — never values — so a
 *  launch arg can't carry anything the decoder doesn't already know. */
export function encodeDisplayPrefs(prefs: DisplayPrefs): string {
	return DISPLAY_PREF_KEYS.filter((key) => prefs[key]).join(",");
}

export function decodeDisplayPrefs(encoded: string | null | undefined): DisplayPrefs {
	const on = new Set((encoded ?? "").split(","));
	const out: DisplayPrefs = { ...DEFAULT_DISPLAY_PREFS };
	for (const key of DISPLAY_PREF_KEYS) out[key] = on.has(key);
	return out;
}

/** What a renderer paints for a set of display prefs over a theme: the root
 *  attributes to set (`null` ⇒ remove) and the inline token overrides to layer
 *  after the theme's own vars. Pure, so the shell renderer and the app preload
 *  resolve identically. */
export type DisplayPaint = {
	attributes: Record<DisplayAttribute, DisplayAttributeValue | null>;
	vars: Record<string, string>;
};

export function resolveDisplayPaint(prefs: DisplayPrefs, tokens: Tokens): DisplayPaint {
	return {
		attributes: {
			[DisplayAttribute.Contrast]: prefs.higherContrast ? DisplayAttributeValue.More : null,
			[DisplayAttribute.TextEmphasis]: prefs.emphasizeTextCursor ? DisplayAttributeValue.On : null,
			[DisplayAttribute.Scrollbars]: prefs.alwaysShowScrollbars ? DisplayAttributeValue.Always : null,
		},
		vars: prefs.higherContrast ? higherContrastOverrides(tokens) : {},
	};
}
