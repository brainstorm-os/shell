import { t } from "./i18n";

export function navigatorLanguage(): string {
	return typeof navigator !== "undefined" ? navigator.language || "en" : "en";
}

/** `HH:MM` in the user's locale — or, with `absolute` (Chats-3), the full
 *  date + time. "" for an unparseable stamp. */
export function formatTime(iso: string, absolute = false): string {
	if (absolute) return formatStamp(iso);
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleTimeString(navigatorLanguage(), {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Date + time, always absolute — search results and the `absolute` pref. */
export function formatStamp(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	return new Date(ms).toLocaleString(navigatorLanguage(), {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** A day-divider label: Today / Yesterday / a localized date. With `absolute`
 *  (Chats-3) the relative labels give way to the full date. */
export function formatDay(dayKey: string, absolute = false, now: Date = new Date()): string {
	const ms = Date.parse(dayKey);
	if (!Number.isFinite(ms)) return dayKey;
	const that = new Date(ms);
	const startOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const diffDays = Math.round((startOf(now) - startOf(that)) / 86_400_000);
	if (!absolute) {
		if (diffDays === 0) return t("day.today");
		if (diffDays === 1) return t("day.yesterday");
	}
	return that.toLocaleDateString(navigatorLanguage(), {
		weekday: "long",
		...(absolute ? { year: "numeric" as const } : {}),
		month: "short",
		day: "numeric",
	});
}
