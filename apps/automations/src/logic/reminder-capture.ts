/**
 * 11b.12 — reminders quick-capture (pure core). The capture surface is a
 * subject field + an optional due picker + a recurrence preset; this
 * module turns that raw input into a valid `Reminder/v1` and derives the
 * row status the list renders. No DOM, no timers — `now` is passed in — so
 * the whole capture + status logic is unit-tested headless.
 *
 * Reminders are sugar over `Reminder/v1`, so capture is deliberately
 * low-friction: a bare subject + Enter produces a reminder due tomorrow
 * morning. The Done/Snooze transitions reuse the shared
 * `@brainstorm-os/sdk-types` definitions (one meaning of "done"/"snooze").
 */

import {
	RecurrenceKind,
	type ReminderDef,
	Weekday,
	isValidReminder,
	nextOccurrence,
	recurrenceToRRule,
	rruleToRecurrence,
} from "@brainstorm-os/sdk-types";

/** Recurrence choices the capture surface offers (a curated subset of the
 *  structured `Recurrence` forms — the long tail is the builder's job). */
export enum RecurrencePreset {
	None = "none",
	Daily = "daily",
	Weekdays = "weekdays",
	Weekly = "weekly",
	Monthly = "monthly",
}

export const RECURRENCE_PRESETS: readonly RecurrencePreset[] = Object.freeze([
	RecurrencePreset.None,
	RecurrencePreset.Daily,
	RecurrencePreset.Weekdays,
	RecurrencePreset.Weekly,
	RecurrencePreset.Monthly,
]);

const WEEKDAY_OF_INDEX: readonly Weekday[] = Object.freeze([
	Weekday.Sun,
	Weekday.Mon,
	Weekday.Tue,
	Weekday.Wed,
	Weekday.Thu,
	Weekday.Fri,
	Weekday.Sat,
]);

/** The RRULE string for a preset relative to a due instant, or `undefined`
 *  for a one-shot reminder. Weekly repeats on the due date's weekday;
 *  Monthly on its day-of-month. */
export function rruleForPreset(preset: RecurrencePreset, dueMs: number): string | undefined {
	const due = new Date(dueMs);
	switch (preset) {
		case RecurrencePreset.Daily:
			return recurrenceToRRule({ kind: RecurrenceKind.Daily, every: 1 });
		case RecurrencePreset.Weekdays:
			return recurrenceToRRule({
				kind: RecurrenceKind.Weekly,
				every: 1,
				days: [Weekday.Mon, Weekday.Tue, Weekday.Wed, Weekday.Thu, Weekday.Fri],
			});
		case RecurrencePreset.Weekly: {
			const day = WEEKDAY_OF_INDEX[due.getDay()] ?? Weekday.Mon;
			return recurrenceToRRule({ kind: RecurrenceKind.Weekly, every: 1, days: [day] });
		}
		case RecurrencePreset.Monthly:
			return recurrenceToRRule({
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfMonth: due.getDate(),
			});
		default:
			return undefined;
	}
}

/** Tomorrow at 09:00 local — the default due when capture omits one. */
export function defaultDue(now: number): number {
	const d = new Date(now);
	d.setHours(9, 0, 0, 0);
	d.setDate(d.getDate() + 1);
	return d.getTime();
}

/** Parse a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`, local
 *  wall-clock) to an epoch, or `null` when empty/invalid. */
export function parseDueLocal(value: string): number | null {
	const trimmed = value.trim();
	if (trimmed === "") return null;
	const ms = new Date(trimmed).getTime();
	return Number.isNaN(ms) ? null : ms;
}

export type CaptureInput = {
	subject: string;
	/** Raw `datetime-local` value; blank → `defaultDue(now)`. */
	dueLocal?: string;
	recurrence?: RecurrencePreset;
};

/** Build a valid `Reminder/v1` from capture input, or `null` when the
 *  subject is blank (the one hard requirement). */
export function buildReminder(input: CaptureInput, now: number): ReminderDef | null {
	const subject = input.subject.trim();
	if (subject === "") return null;

	const dueMs = (input.dueLocal ? parseDueLocal(input.dueLocal) : null) ?? defaultDue(now);
	const def: ReminderDef = { subject, dueAt: new Date(dueMs).toISOString() };

	const rrule = rruleForPreset(input.recurrence ?? RecurrencePreset.None, dueMs);
	if (rrule) def.recurrence = rrule;

	return isValidReminder(def) ? def : null;
}

export enum ReminderStatus {
	Done = "done",
	Snoozed = "snoozed",
	Overdue = "overdue",
	Upcoming = "upcoming",
}

function isRecurring(reminder: ReminderDef): boolean {
	return typeof reminder.recurrence === "string" && reminder.recurrence.length > 0;
}

function activeSnooze(reminder: ReminderDef, now: number): number | null {
	if (!reminder.snoozedUntil) return null;
	const snooze = Date.parse(reminder.snoozedUntil);
	return !Number.isNaN(snooze) && snooze > now ? snooze : null;
}

/** The reminder's next surfacing instant, or `null` when none: an active
 *  (future) snooze wins; a recurring reminder advances to its next
 *  occurrence (so a completed/past cycle doesn't read as stuck); a one-shot
 *  uses its `dueAt`. Mirrors the shell scheduler's snooze-overrides-due,
 *  recurrence-drives-subsequent-fires rule, derived for display. */
export function reminderNextDue(reminder: ReminderDef, now: number): number | null {
	const snooze = activeSnooze(reminder, now);
	if (snooze !== null) return snooze;
	if (isRecurring(reminder) && reminder.recurrence) {
		const rec = rruleToRecurrence(reminder.recurrence);
		const next = rec ? nextOccurrence(rec, now) : null;
		if (next !== null) return next;
	}
	const due = Date.parse(reminder.dueAt);
	return Number.isNaN(due) ? null : due;
}

/** The row state the list renders. A recurring reminder is never "done"
 *  (it always has a next occurrence) and never perpetually "overdue" — it
 *  surfaces as Upcoming (or Snoozed); `completedAt` only marks a one-shot
 *  reminder as Done. */
export function reminderStatus(reminder: ReminderDef, now: number): ReminderStatus {
	const recurring = isRecurring(reminder);
	if (reminder.completedAt && !recurring) return ReminderStatus.Done;
	if (activeSnooze(reminder, now) !== null) return ReminderStatus.Snoozed;
	if (recurring) return ReminderStatus.Upcoming;
	const due = Date.parse(reminder.dueAt);
	if (!Number.isNaN(due) && due < now) return ReminderStatus.Overdue;
	return ReminderStatus.Upcoming;
}

/** When the reminder next surfaces, as an ISO string for the row's
 *  secondary line. Falls back to the stored `dueAt` when no next instant is
 *  derivable. */
export function reminderEffectiveDue(reminder: ReminderDef, now: number): string {
	const next = reminderNextDue(reminder, now);
	return next === null ? reminder.dueAt : new Date(next).toISOString();
}
