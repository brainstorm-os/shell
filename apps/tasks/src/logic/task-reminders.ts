/**
 * Due / scheduled alerts (9.14.9) — pure mapping from open tasks to the
 * shared `@brainstorm-os/sdk/reminder-schedule` `ReminderSource` shape, so the
 * one product-wide scheduler (Calendar's, extracted at copy two) drives Task
 * notifications.
 *
 * Tasks' `dueAt` / `scheduledAt` come from the mini-calendar day picker, so
 * they're usually local-midnight instants — a midnight notification helps
 * nobody, so a midnight-anchored alert fires at `DEFAULT_ALERT_HOUR` that
 * morning instead; an instant carrying a real time-of-day fires verbatim.
 * The alert kind rides the source id (`<taskId>#due` / `<taskId>#scheduled`)
 * so the notifier can word the two differently without a side-channel.
 */

import type { ReminderSource } from "@brainstorm-os/sdk/reminder-schedule";
import type { Task } from "../types/task";

export enum TaskAlertKind {
	Due = "due",
	Scheduled = "scheduled",
}

/** Morning hour (local) a date-only alert fires at. */
export const DEFAULT_ALERT_HOUR = 9;

const ALERT_ID_SEPARATOR = "#";
/** Alerts fire at the (adjusted) instant itself — no advance offsets in v1. */
const AT_START: readonly number[] = Object.freeze([0]);

/** The instant an alert for `ms` actually fires: a local-midnight instant
 *  (the day picker's output) moves to `alertHour` that morning; anything
 *  carrying a real time-of-day fires verbatim. */
export function taskAlertInstant(ms: number, alertHour: number = DEFAULT_ALERT_HOUR): number {
	const d = new Date(ms);
	const isMidnight =
		d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
	if (!isMidnight) return ms;
	d.setHours(alertHour, 0, 0, 0);
	return d.getTime();
}

/** The alert kind encoded in a reminder source id; an unrecognised suffix
 *  reads as Due (the safer wording for a deadline product). */
export function taskAlertKind(sourceId: string): TaskAlertKind {
	const suffix = sourceId.slice(sourceId.lastIndexOf(ALERT_ID_SEPARATOR) + 1);
	return suffix === TaskAlertKind.Scheduled ? TaskAlertKind.Scheduled : TaskAlertKind.Due;
}

/** Reminder sources for every open task: one per set date (due and/or
 *  scheduled). When both dates resolve to the same fire instant only the
 *  due alert survives — two simultaneous notifications for one task is
 *  noise, and the deadline is the stronger signal. */
export function taskReminderSources(
	tasks: readonly Task[],
	alertHour: number = DEFAULT_ALERT_HOUR,
): ReminderSource[] {
	const out: ReminderSource[] = [];
	for (const task of tasks) {
		if (task.completedAt !== null) continue;
		const dueStart = task.dueAt !== null ? taskAlertInstant(task.dueAt, alertHour) : null;
		if (dueStart !== null) {
			out.push({
				id: `${task.id}${ALERT_ID_SEPARATOR}${TaskAlertKind.Due}`,
				title: task.name,
				start: dueStart,
				reminders: AT_START,
			});
		}
		if (task.scheduledAt !== null) {
			const scheduledStart = taskAlertInstant(task.scheduledAt, alertHour);
			if (scheduledStart !== dueStart) {
				out.push({
					id: `${task.id}${ALERT_ID_SEPARATOR}${TaskAlertKind.Scheduled}`,
					title: task.name,
					start: scheduledStart,
					reminders: AT_START,
				});
			}
		}
	}
	return out;
}
