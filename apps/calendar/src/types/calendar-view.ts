/**
 * `brainstorm/CalendarView/v1` — a saved viewport over the Calendar's
 * cross-app temporal index. Holds the view kind (Month / Week / Day /
 * Agenda) + week-start preference + visible-types filter so the user's
 * "Only Events + Tasks, hide birthdays" view persists across reboots.
 */

export enum CalendarViewKind {
	Year = "year",
	Month = "month",
	Week = "week",
	Day = "day",
	Agenda = "agenda",
}

/** All view kinds in display order — frozen, safe to iterate. */
export const CALENDAR_VIEW_KINDS: readonly CalendarViewKind[] = Object.freeze([
	CalendarViewKind.Year,
	CalendarViewKind.Month,
	CalendarViewKind.Week,
	CalendarViewKind.Day,
	CalendarViewKind.Agenda,
]);

/** Canonical numeric weekday for the week-start preference. Re-exported
 *  from `@brainstorm-os/sdk/date-grid` so the Calendar app shares one enum
 *  with Journal and any future date-axis app — no per-app duplicate. */
import { WeekStartsOn } from "@brainstorm-os/sdk/date-grid";
export { WeekStartsOn };

export type CalendarView = {
	id: string;
	name: string;
	kind: CalendarViewKind;
	/** Default Monday (matches ISO 8601). */
	weekStartsOn?: WeekStartsOn;
	/** Show Sat / Sun cells in Month / Week views. Default true. */
	showWeekends?: boolean;
	/** Whitelist of entity-type URLs to include in the view. Empty array
	 *  / unset = include every type the Calendar knows about. */
	visibleEntityTypes?: readonly string[];
	createdAt: number;
	updatedAt: number;
};
