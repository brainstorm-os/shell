/**
 * Date-range math for the four Calendar views — re-export from
 * `@brainstorm-os/sdk/date-grid`. The Calendar app used to carry the
 * canonical implementation here; it's now lifted to the SDK so every
 * date-axis app (Journal, Database calendar view, Tasks date popovers,
 * future ones) reads the same DST-safe helpers
 * ([[feedback_extract_to_sdk_at_copy_two]]). The app-local file stays
 * as a thin re-export to keep the existing import paths working.
 */

export {
	addDays,
	addMonths,
	dateKey,
	daysBetween,
	endOfDay,
	endOfMonth,
	endOfMonthGrid,
	endOfWeek,
	isSameDay,
	isSameMonth,
	monthGridDays,
	startOfDay,
	startOfMonth,
	startOfMonthGrid,
	startOfWeek,
	weekDays,
} from "@brainstorm-os/sdk/date-grid";
