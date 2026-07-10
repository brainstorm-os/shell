/**
 * Item alerts (9.14.9b) — shell-side due/scheduled alerts for Tasks and
 * event reminders for Calendar, so a reminder fires **with the app
 * closed**. 9.14.9 shipped these alerts in-window only (a tick inside the
 * app renderer); this module derives the same alerts from the persisted
 * entity rows so the per-vault automations deployment can register them
 * on the `SchedulerService` — one fire mechanism product-wide.
 *
 * Pure: rows + `now` in, registrations out. The notification payload is
 * precomputed at derive time; freshness is owned by the deployment's
 * rehydrate-on-entity-change (completing a task re-derives and the alert
 * unregisters — a tighter window than the in-app 30s tick). The dedupe
 * keys REPLICATE `@brainstorm/sdk/reminder-schedule.reminderDedupeKey`
 * over the app-side source ids (`<taskId>#due` / `<taskId>#scheduled` /
 * `<eventId>`), so when an app window is open and both schedulers fire,
 * the notify host's `(appId, dedupeKey)` window collapses the duplicate.
 * Alerts missed while the shell was closed do not back-fire — the
 * scheduler recomputes from `now` on vault open, the same posture as
 * `Reminder/v1` (a catch-up pass is a possible follow-up).
 *
 * The task instant/wording rules mirror `apps/tasks/src/logic/task-reminders.ts`
 * (midnight → 09:00, deadline wins a same-instant collision) — duplicated
 * rather than imported because that module is app-side and typed against
 * the app's `Task`; this one reads raw entity property bags. A drift fence
 * test pins the shared constants.
 */

import type { UiNotification } from "../ui/notify-host";
import { OnMissedPolicy, type TimeTriggerConfig } from "./trigger-schedule";

export const TASK_TYPE_URL = "brainstorm/Task/v1";
export const EVENT_TYPE_URL = "brainstorm/Event/v1";

/** Entity types whose writes must re-derive the item-alert schedule. */
export const ITEM_ALERT_TYPES: readonly string[] = Object.freeze([TASK_TYPE_URL, EVENT_TYPE_URL]);

export const TASKS_APP_ID = "io.brainstorm.tasks";
export const CALENDAR_APP_ID = "io.brainstorm.calendar";

/** Namespace prefix keeping alert trigger ids disjoint from workflow /
 *  reminder / sync-mapping entity ids in the shared scheduler. */
export const ITEM_ALERT_ID_PREFIX = "item-alert:";

/** Morning hour (local) a date-only task alert fires at — pinned to the
 *  app-side `DEFAULT_ALERT_HOUR` by a drift fence test. */
export const TASK_ALERT_HOUR = 9;

const MINUTE_MS = 60_000;

export type ItemAlertRegistration = {
	/** Scheduler trigger id — `item-alert:<dedupeKey>`. */
	alertId: string;
	config: TimeTriggerConfig;
	/** Posted verbatim through the ui notify host on fire. */
	notification: UiNotification;
};

type Row = { id: string; properties: Record<string, unknown> };

function finiteNumber(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Mirror of the app-side `taskAlertInstant`: a local-midnight instant
 *  (the day picker's output) fires at `TASK_ALERT_HOUR` that morning; an
 *  instant carrying a real time-of-day fires verbatim. */
export function taskAlertInstant(ms: number): number {
	const d = new Date(ms);
	const isMidnight =
		d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
	if (!isMidnight) return ms;
	d.setHours(TASK_ALERT_HOUR, 0, 0, 0);
	return d.getTime();
}

function alertRegistration(
	appId: string,
	sourceId: string,
	fireAt: number,
	title: string,
	body: string,
): ItemAlertRegistration {
	// Same shape as the SDK's `reminderDedupeKey(sourceId, fireAt)`.
	const dedupeKey = `${sourceId}#${fireAt}`;
	return {
		alertId: `${ITEM_ALERT_ID_PREFIX}${dedupeKey}`,
		// FireOnce: a reminder that came due while the app was CLOSED (in the gap
		// since the scheduler's `lastRun`) fires once on next launch (0.3.1),
		// instead of being silently dropped.
		config: { oneShotAt: fireAt, onMissed: OnMissedPolicy.FireOnce },
		notification: { appId, title, body, kind: "info", dedupeKey },
	};
}

/** Human offset for an event reminder body — mirrors the calendar app's
 *  preset ladder (minutes under an hour, hours under a day, else days). */
export function reminderOffsetLabel(minutes: number): string {
	if (minutes < 60) return `${minutes} minutes`;
	if (minutes < 1440) {
		const hours = Math.round(minutes / 60);
		return hours === 1 ? "1 hour" : `${hours} hours`;
	}
	const days = Math.round(minutes / 1440);
	return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Task rows → alert registrations. One per set date on an open task:
 * `dueAt` and `scheduledAt` each fire at their (midnight-adjusted)
 * instant; when both resolve to the same instant only the due alert
 * survives (the deadline is the stronger signal). Fires already in the
 * past at `now` are dropped — they'd register as dormant rows.
 */
export function taskAlertRegistrations(
	tasks: readonly Row[],
	lastRun: number,
): ItemAlertRegistration[] {
	const out: ItemAlertRegistration[] = [];
	for (const row of tasks) {
		const p = row.properties;
		if (finiteNumber(p.completedAt) !== null) continue;
		const title = typeof p.name === "string" && p.name !== "" ? p.name : "Task";
		const dueAt = finiteNumber(p.dueAt);
		const scheduledAt = finiteNumber(p.scheduledAt);
		const dueInstant = dueAt !== null ? taskAlertInstant(dueAt) : null;
		if (dueInstant !== null && dueInstant > lastRun) {
			out.push(alertRegistration(TASKS_APP_ID, `${row.id}#due`, dueInstant, title, "Due now"));
		}
		if (scheduledAt !== null) {
			const scheduledInstant = taskAlertInstant(scheduledAt);
			if (scheduledInstant !== dueInstant && scheduledInstant > lastRun) {
				out.push(
					alertRegistration(
						TASKS_APP_ID,
						`${row.id}#scheduled`,
						scheduledInstant,
						title,
						"Scheduled to start now",
					),
				);
			}
		}
	}
	return out;
}

/**
 * Event rows → alert registrations: one per reminder offset (minutes
 * before `start`, `0` = at start). Base start only — recurring events
 * alert on their base occurrence, the same fidelity as the in-app
 * scheduler. Past fires at `now` are dropped.
 */
export function eventAlertRegistrations(
	events: readonly Row[],
	lastRun: number,
): ItemAlertRegistration[] {
	const out: ItemAlertRegistration[] = [];
	for (const row of events) {
		const p = row.properties;
		const start = finiteNumber(p.start);
		if (start === null) continue;
		const title = typeof p.title === "string" && p.title !== "" ? p.title : "Event";
		if (!Array.isArray(p.reminders)) continue;
		for (const raw of p.reminders) {
			const minutes = finiteNumber(raw);
			if (minutes === null || minutes < 0) continue;
			const fireAt = start - Math.floor(minutes) * MINUTE_MS;
			if (fireAt <= lastRun) continue;
			const body = minutes <= 0 ? "Starting now" : `Starts in ${reminderOffsetLabel(minutes)}`;
			out.push(alertRegistration(CALENDAR_APP_ID, row.id, fireAt, title, body));
		}
	}
	return out;
}

/** The full item-alert schedule for a vault's task + event rows. */
export function deriveItemAlerts(
	tasks: readonly Row[],
	events: readonly Row[],
	lastRun: number,
): ItemAlertRegistration[] {
	return [...taskAlertRegistrations(tasks, lastRun), ...eventAlertRegistrations(events, lastRun)];
}
