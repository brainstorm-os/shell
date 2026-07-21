/**
 * Pure scheduling + state transitions for `Reminder/v1` (11b.5). A reminder
 * is "sugar around a single-step notify workflow" (doc 39) — its own
 * high-volume entity type, not a Workflow+Trigger trio — so it gets a thin
 * pure core here rather than going through the workflow runner. The schedule
 * reuses the SchedulerService's `TimeTriggerConfig` + the structured
 * `Recurrence` engine, so reminders and workflows share one fire mechanism.
 *
 * No timers, no IO — every function takes `now`/`at` explicitly.
 */

import {
	type Recurrence,
	RecurrenceKind,
	type ReminderDef,
	rruleToRecurrence,
} from "@brainstorm-os/sdk-types";
import { type TimeTriggerConfig, computeNextFire } from "./trigger-schedule";

// The Done/Snooze transitions are now the one shared definition in
// `@brainstorm-os/sdk-types` (the Automations app reuses them); re-export so
// this module stays the runner's single import surface.
export { completeReminder, snoozeReminder } from "@brainstorm-os/sdk-types";

/** A reminder's RRULE text → structured `Recurrence`. The shared parser
 *  returns `null` only for an empty string (callers gate on a non-empty
 *  `recurrence`); a non-empty rule it cannot express becomes `Custom`. */
function parseRrule(rrule: string): Recurrence {
	return rruleToRecurrence(rrule) ?? { kind: RecurrenceKind.Custom, rrule };
}

function epochOf(iso: string | undefined): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : t;
}

/**
 * The reminder's fire schedule as a `TimeTriggerConfig`, or `null` when it
 * never fires again (a `Done` non-recurring reminder). `snoozedUntil`
 * overrides `dueAt` for the next one-shot fire (doc 39 §Reminder); a
 * recurrence drives subsequent fires. A `completedAt` on a *recurring*
 * reminder does not stop it — the recurrence supplies the next occurrence.
 */
export function reminderToTriggerConfig(reminder: ReminderDef): TimeTriggerConfig | null {
	const recurring = typeof reminder.recurrence === "string" && reminder.recurrence.length > 0;
	if (reminder.completedAt && !recurring) return null;

	const config: TimeTriggerConfig = {};
	const oneShot = epochOf(reminder.snoozedUntil) ?? epochOf(reminder.dueAt);
	if (oneShot !== null) config.oneShotAt = oneShot;
	if (recurring && reminder.recurrence) config.recurrence = parseRrule(reminder.recurrence);

	if (config.oneShotAt === undefined && config.recurrence === undefined) return null;
	return config;
}

/** The next instant strictly after `after` at which the reminder fires, or
 *  `null` when it has no future fire. */
export function reminderNextFire(reminder: ReminderDef, after: number): number | null {
	const config = reminderToTriggerConfig(reminder);
	return config ? computeNextFire(config, after) : null;
}

/** The notification a fired reminder posts (doc 39 — `target` makes the
 *  notification click-to-open the entity it is about). */
export function reminderNotification(reminder: ReminderDef): {
	title: string;
	body?: string;
	target?: string;
} {
	return { title: reminder.subject, ...(reminder.target ? { target: reminder.target } : {}) };
}
