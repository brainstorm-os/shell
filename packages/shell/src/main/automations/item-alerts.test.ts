import { describe, expect, it } from "vitest";
import {
	CALENDAR_APP_ID,
	EVENT_TYPE_URL,
	ITEM_ALERT_ID_PREFIX,
	ITEM_ALERT_TYPES,
	TASKS_APP_ID,
	TASK_ALERT_HOUR,
	TASK_TYPE_URL,
	deriveItemAlerts,
	eventAlertRegistrations,
	reminderOffsetLabel,
	taskAlertInstant,
	taskAlertRegistrations,
} from "./item-alerts";

const NOW = new Date(2026, 6, 7, 12, 0, 0, 0).getTime(); // local noon

function taskRow(id: string, props: Record<string, unknown>) {
	return { id, properties: { name: `Task ${id}`, ...props } };
}

function eventRow(id: string, props: Record<string, unknown>) {
	return { id, properties: { title: `Event ${id}`, ...props } };
}

describe("taskAlertInstant", () => {
	it("moves a local-midnight instant to the alert hour that morning", () => {
		const midnight = new Date(2026, 6, 8, 0, 0, 0, 0).getTime();
		const instant = taskAlertInstant(midnight);
		const d = new Date(instant);
		expect(d.getHours()).toBe(TASK_ALERT_HOUR);
		expect(d.getDate()).toBe(8);
	});

	it("fires a timed instant verbatim", () => {
		const timed = new Date(2026, 6, 8, 15, 30, 0, 0).getTime();
		expect(taskAlertInstant(timed)).toBe(timed);
	});

	// Drift fence — mirrors apps/tasks/src/logic/task-reminders.ts
	// DEFAULT_ALERT_HOUR; a change there must land here too.
	it("pins the 09:00 app-side alert hour", () => {
		expect(TASK_ALERT_HOUR).toBe(9);
	});
});

describe("taskAlertRegistrations", () => {
	it("registers a due alert with the app-path dedupe key shape", () => {
		const dueAt = NOW + 3_600_000;
		const [alert] = taskAlertRegistrations([taskRow("t1", { dueAt })], NOW);
		expect(alert).toBeDefined();
		expect(alert?.config.oneShotAt).toBe(dueAt);
		expect(alert?.notification.appId).toBe(TASKS_APP_ID);
		expect(alert?.notification.title).toBe("Task t1");
		expect(alert?.notification.dedupeKey).toBe(`t1#due#${dueAt}`);
		expect(alert?.alertId).toBe(`${ITEM_ALERT_ID_PREFIX}t1#due#${dueAt}`);
	});

	it("registers due and scheduled alerts separately", () => {
		const dueAt = NOW + 7_200_000;
		const scheduledAt = NOW + 3_600_000;
		const alerts = taskAlertRegistrations([taskRow("t1", { dueAt, scheduledAt })], NOW);
		expect(alerts.map((a) => a.notification.dedupeKey)).toEqual([
			`t1#due#${dueAt}`,
			`t1#scheduled#${scheduledAt}`,
		]);
	});

	it("drops the scheduled alert when both dates resolve to the same instant", () => {
		const at = NOW + 3_600_000;
		const alerts = taskAlertRegistrations([taskRow("t1", { dueAt: at, scheduledAt: at })], NOW);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.notification.body).toBe("Due now");
	});

	it("skips completed tasks and past instants", () => {
		const past = NOW - 60_000;
		const future = NOW + 60_000;
		const alerts = taskAlertRegistrations(
			[
				taskRow("done", { dueAt: future, completedAt: NOW - 1 }),
				taskRow("past", { dueAt: past }),
				taskRow("live", { dueAt: future }),
			],
			NOW,
		);
		expect(alerts.map((a) => a.notification.title)).toEqual(["Task live"]);
	});

	it("degrades malformed rows instead of throwing", () => {
		const alerts = taskAlertRegistrations(
			[
				{ id: "bad", properties: { dueAt: "tomorrow", name: 42 } },
				taskRow("ok", { dueAt: NOW + 1_000 }),
			],
			NOW,
		);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.notification.title).toBe("Task ok");
	});
});

describe("eventAlertRegistrations", () => {
	it("registers one alert per reminder offset with the event-id dedupe key", () => {
		const start = NOW + 3_600_000;
		const alerts = eventAlertRegistrations([eventRow("e1", { start, reminders: [0, 30] })], NOW);
		expect(alerts).toHaveLength(2);
		expect(alerts[0]?.notification.dedupeKey).toBe(`e1#${start}`);
		expect(alerts[0]?.notification.body).toBe("Starting now");
		expect(alerts[1]?.notification.dedupeKey).toBe(`e1#${start - 30 * 60_000}`);
		expect(alerts[1]?.notification.body).toBe("Starts in 30 minutes");
		expect(alerts.every((a) => a.notification.appId === CALENDAR_APP_ID)).toBe(true);
	});

	it("drops offsets whose fire instant already passed", () => {
		const start = NOW + 10 * 60_000; // in 10 min
		const alerts = eventAlertRegistrations([eventRow("e1", { start, reminders: [0, 30] })], NOW);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.config.oneShotAt).toBe(start);
	});

	it("skips events without a start or reminders", () => {
		const alerts = eventAlertRegistrations(
			[
				eventRow("no-start", { reminders: [0] }),
				eventRow("no-reminders", { start: NOW + 1_000 }),
				eventRow("bad-reminders", { start: NOW + 1_000, reminders: "soon" }),
			],
			NOW,
		);
		expect(alerts).toHaveLength(0);
	});
});

describe("reminderOffsetLabel", () => {
	it("words minutes, hours, and days", () => {
		expect(reminderOffsetLabel(5)).toBe("5 minutes");
		expect(reminderOffsetLabel(60)).toBe("1 hour");
		expect(reminderOffsetLabel(120)).toBe("2 hours");
		expect(reminderOffsetLabel(1440)).toBe("1 day");
	});
});

describe("deriveItemAlerts", () => {
	it("concatenates task and event alerts", () => {
		const alerts = deriveItemAlerts(
			[taskRow("t1", { dueAt: NOW + 1_000 })],
			[eventRow("e1", { start: NOW + 1_000, reminders: [0] })],
			NOW,
		);
		expect(alerts.map((a) => a.notification.appId)).toEqual([TASKS_APP_ID, CALENDAR_APP_ID]);
	});

	it("exposes the watched type urls for the rehydrate filter", () => {
		expect(ITEM_ALERT_TYPES).toEqual([TASK_TYPE_URL, EVENT_TYPE_URL]);
	});
});
