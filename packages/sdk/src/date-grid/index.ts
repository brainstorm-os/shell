/**
 * `@brainstorm-os/sdk/date-grid` — one canonical set of week/month-grid
 * date math + `GridCell` builder used by every app with a date axis.
 * See `./date-grid.ts` for the rationale.
 */

export {
	DAY_MS,
	WeekStartsOn,
	type GridCell,
	startOfDay,
	endOfDay,
	addDays,
	addMonths,
	daysBetween,
	startOfMonth,
	endOfMonth,
	startOfWeek,
	endOfWeek,
	startOfMonthGrid,
	endOfMonthGrid,
	monthGridDays,
	weekDays,
	dateKey,
	isSameDay,
	isSameMonth,
	buildWeekGrid,
	buildMonthGrid,
	weekdayLabels,
} from "./date-grid";
