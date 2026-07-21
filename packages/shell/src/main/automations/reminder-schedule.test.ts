import type { ReminderDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	completeReminder,
	reminderNextFire,
	reminderNotification,
	reminderToTriggerConfig,
	snoozeReminder,
} from "./reminder-schedule";

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function reminder(over: Partial<ReminderDef> = {}): ReminderDef {
	return { subject: "Call Mira", dueAt: iso(T0), ...over };
}

describe("reminderToTriggerConfig", () => {
	it("a one-shot reminder fires at dueAt", () => {
		expect(reminderToTriggerConfig(reminder())).toEqual({ oneShotAt: T0 });
	});

	it("snoozedUntil overrides dueAt for the next fire", () => {
		const config = reminderToTriggerConfig(reminder({ snoozedUntil: iso(T0 + DAY) }));
		expect(config).toEqual({ oneShotAt: T0 + DAY });
	});

	it("a completed one-shot reminder never fires again", () => {
		expect(reminderToTriggerConfig(reminder({ completedAt: iso(T0) }))).toBeNull();
	});

	it("a recurring reminder carries the structured recurrence", () => {
		const config = reminderToTriggerConfig(reminder({ recurrence: "FREQ=DAILY" }));
		expect(config?.recurrence).toEqual({ kind: "daily", every: 1 });
		expect(config?.oneShotAt).toBe(T0);
	});

	it("a completed recurring reminder still fires its next occurrence", () => {
		const config = reminderToTriggerConfig(
			reminder({ recurrence: "FREQ=DAILY", completedAt: iso(T0) }),
		);
		expect(config).not.toBeNull();
		expect(config?.recurrence).toEqual({ kind: "daily", every: 1 });
	});

	it("a malformed dueAt with no recurrence yields no schedule", () => {
		expect(reminderToTriggerConfig(reminder({ dueAt: "not-a-date" }))).toBeNull();
	});
});

describe("reminderNextFire", () => {
	it("returns the next daily occurrence after a past due date", () => {
		const r = reminder({ recurrence: "FREQ=DAILY" });
		expect(reminderNextFire(r, T0 + 5 * DAY)).toBe(T0 + 6 * DAY);
	});

	it("returns null for a completed one-shot", () => {
		expect(reminderNextFire(reminder({ completedAt: iso(T0) }), T0 - DAY)).toBeNull();
	});
});

describe("reminderNotification", () => {
	it("uses the subject and carries the target", () => {
		expect(reminderNotification(reminder({ target: "e1" }))).toEqual({
			title: "Call Mira",
			target: "e1",
		});
	});

	it("omits target when absent", () => {
		expect(reminderNotification(reminder())).toEqual({ title: "Call Mira" });
	});
});

describe("snoozeReminder / completeReminder", () => {
	it("snooze sets snoozedUntil and clears a prior completion", () => {
		const done = reminder({ completedAt: iso(T0), target: "e1" });
		const snoozed = snoozeReminder(done, T0 + DAY);
		expect(snoozed.snoozedUntil).toBe(iso(T0 + DAY));
		expect(snoozed.completedAt).toBeUndefined();
		expect(snoozed.target).toBe("e1");
	});

	it("complete sets completedAt and clears a pending snooze", () => {
		const snoozed = reminder({ snoozedUntil: iso(T0 + DAY), recurrence: "FREQ=DAILY" });
		const done = completeReminder(snoozed, T0 + 2 * DAY);
		expect(done.completedAt).toBe(iso(T0 + 2 * DAY));
		expect(done.snoozedUntil).toBeUndefined();
		expect(done.recurrence).toBe("FREQ=DAILY");
	});

	it("transitions are immutable (do not mutate the input)", () => {
		const r = reminder();
		snoozeReminder(r, T0 + DAY);
		expect(r.snoozedUntil).toBeUndefined();
	});
});
