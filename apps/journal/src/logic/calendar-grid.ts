/**
 * Journal's `Date`-based adapter over `@brainstorm-os/sdk/date-grid`.
 *
 * The canonical date math (DST-safe `addDays` / `startOfMonthGrid` /
 * `buildMonthGrid`, plus the `GridCell` shape) now lives in the SDK so
 * Journal, Calendar, Database calendar-view, and future date-axis apps
 * share one implementation ([[feedback_extract_to_sdk_at_compyy two]]).
 * Journal's renderer is `Date`-based throughout (`state.focus`,
 * `state.now`, `state.monthFocus`); this file is a thin adapter that
 * converts Date↔epoch-ms at the SDK boundary so call sites don't have
 * to change. The math itself isn't reimplemented here.
 */

import {
	type GridCell,
	addDays,
	addMonths,
	buildMonthGrid as sdkBuildMonthGrid,
	buildWeekGrid as sdkBuildWeekGrid,
	daysBetween as sdkDaysBetween,
	weekdayLabels as sdkWeekdayLabels,
} from "@brainstorm-os/sdk/date-grid";
import type { WeekStartsOn } from "../types/view";

export type { GridCell } from "@brainstorm-os/sdk/date-grid";

/** Build a 7-cell array starting on `weekStartsOn`, anchored on whatever
 *  week contains `focus`. */
export function buildWeekGrid(focus: Date, now: Date, weekStartsOn: WeekStartsOn): GridCell[] {
	return sdkBuildWeekGrid(focus.getTime(), now.getTime(), weekStartsOn);
}

/** Build a 6-row × 7-col grid for the month containing `focus`. */
export function buildMonthGrid(focus: Date, now: Date, weekStartsOn: WeekStartsOn): GridCell[][] {
	return sdkBuildMonthGrid(focus.getTime(), now.getTime(), weekStartsOn);
}

/** Weekday labels in display order for the configured `weekStartsOn`. */
export function weekdayLabels(weekStartsOn: WeekStartsOn): string[] {
	return sdkWeekdayLabels(weekStartsOn);
}

/** Step `focus` by the given number of days (negative = backward). */
export function shiftByDays(focus: Date, days: number): Date {
	return new Date(addDays(focus.getTime(), days));
}

/** Step `focus` by months (clamps day-of-month to month length). */
export function shiftByMonths(focus: Date, months: number): Date {
	return new Date(addMonths(focus.getTime(), months));
}

/** Days between two epoch-ms anchors (signed). */
export function daysBetween(a: number, b: number): number {
	return sdkDaysBetween(a, b);
}
