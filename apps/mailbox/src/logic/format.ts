/** Date label for a message row / reading-pane header — reuses the shared
 *  relative-date formatter (doc convention: never hand-roll month tables).
 *  Today renders as a clock time; other days fall back to the shared
 *  relative/absolute label. */

import { formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { t } from "../i18n";

const labels = () => ({
	today: t("date.today"),
	tomorrow: t("date.tomorrow"),
	yesterday: t("date.yesterday"),
});

function isSameDay(a: number, b: number): boolean {
	const da = new Date(a);
	const db = new Date(b);
	return (
		da.getFullYear() === db.getFullYear() &&
		da.getMonth() === db.getMonth() &&
		da.getDate() === db.getDate()
	);
}

export function messageDateLabel(epochMs: number, now: number): string {
	if (epochMs <= 0) return "";
	if (isSameDay(epochMs, now)) {
		return new Date(epochMs).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}
	return formatRelativeDate(epochMs, now, labels(), { weekdayStyle: "short" });
}
