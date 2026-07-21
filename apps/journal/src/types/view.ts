/**
 * User preferences persisted via `storage.kv`. Single row keyed
 * `journal:view`. Not an entity — these are app-local and don't
 * participate in the entities-service swap.
 */

export enum JournalMode {
	/** Single day at a time — full-width entry editor. */
	Day = "day",
	/** Week strip + selected day. */
	Week = "week",
	/** Month overview + selected day. */
	Month = "month",
}

/** All three modes in display order — frozen. */
export const JOURNAL_MODES: readonly JournalMode[] = Object.freeze([
	JournalMode.Day,
	JournalMode.Week,
	JournalMode.Month,
]);

/** Canonical numeric weekday for the week-start preference. Re-exported
 *  from `@brainstorm-os/sdk/date-grid` so Journal shares the enum with
 *  Calendar and any future date-axis app. */
import { WeekStartsOn } from "@brainstorm-os/sdk/date-grid";
export { WeekStartsOn };

export type JournalView = {
	mode: JournalMode;
	weekStartsOn: WeekStartsOn;
	/** Show Sat / Sun cells in Week / Month modes. */
	showWeekends: boolean;
};

export const DEFAULT_JOURNAL_VIEW: JournalView = Object.freeze({
	mode: JournalMode.Day,
	weekStartsOn: WeekStartsOn.Monday,
	showWeekends: true,
});
