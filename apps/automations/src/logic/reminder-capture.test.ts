import { isValidReminder } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	RecurrencePreset,
	ReminderStatus,
	buildReminder,
	defaultDue,
	parseDueLocal,
	reminderEffectiveDue,
	reminderNextDue,
	reminderStatus,
	rruleForPreset,
} from "./reminder-capture";

const NOW = Date.parse("2026-06-08T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("buildReminder", () => {
	it("rejects a blank subject", () => {
		expect(buildReminder({ subject: "   " }, NOW)).toBeNull();
	});

	it("defaults a missing due to tomorrow 09:00 and yields a valid reminder", () => {
		const def = buildReminder({ subject: "Water plants" }, NOW);
		expect(def).not.toBeNull();
		if (!def) throw new Error("expected a reminder");
		expect(isValidReminder(def)).toBe(true);
		expect(Date.parse(def.dueAt)).toBe(defaultDue(NOW));
		expect(def.recurrence).toBeUndefined();
	});

	it("uses an explicit due value when given", () => {
		const def = buildReminder({ subject: "Call", dueLocal: "2026-06-10T15:30" }, NOW);
		expect(def?.dueAt).toBe(new Date("2026-06-10T15:30").toISOString());
	});

	it("attaches a recurrence RRULE for a repeating preset", () => {
		const def = buildReminder(
			{ subject: "Standup", dueLocal: "2026-06-10T09:00", recurrence: RecurrencePreset.Daily },
			NOW,
		);
		expect(def?.recurrence).toBe("FREQ=DAILY");
	});

	it("trims the subject", () => {
		expect(buildReminder({ subject: "  hi  " }, NOW)?.subject).toBe("hi");
	});
});

describe("rruleForPreset", () => {
	it("returns undefined for None", () => {
		expect(rruleForPreset(RecurrencePreset.None, NOW)).toBeUndefined();
	});

	it("maps Weekdays to a Mon–Fri weekly rule", () => {
		expect(rruleForPreset(RecurrencePreset.Weekdays, NOW)).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
	});

	it("anchors Weekly to the due date's weekday", () => {
		// 2026-06-08 is a Monday.
		const monday = Date.parse("2026-06-08T09:00:00.000Z");
		expect(rruleForPreset(RecurrencePreset.Weekly, monday)).toBe("FREQ=WEEKLY;BYDAY=MO");
	});

	it("anchors Monthly to the due day-of-month", () => {
		const day15 = new Date(2026, 5, 15, 9).getTime();
		expect(rruleForPreset(RecurrencePreset.Monthly, day15)).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
	});
});

describe("parseDueLocal", () => {
	it("returns null for blank input", () => {
		expect(parseDueLocal("   ")).toBeNull();
	});

	it("parses a datetime-local value", () => {
		expect(parseDueLocal("2026-06-10T15:30")).toBe(new Date("2026-06-10T15:30").getTime());
	});
});

describe("reminderStatus", () => {
	const due = new Date(NOW + DAY).toISOString();

	it("is Done for a completed one-shot", () => {
		expect(reminderStatus({ subject: "x", dueAt: due, completedAt: due }, NOW)).toBe(
			ReminderStatus.Done,
		);
	});

	it("is not Done for a completed recurring reminder", () => {
		const status = reminderStatus(
			{ subject: "x", dueAt: due, completedAt: due, recurrence: "FREQ=DAILY" },
			NOW,
		);
		expect(status).not.toBe(ReminderStatus.Done);
	});

	it("is Upcoming (not perpetually Overdue) for a recurring reminder whose dueAt is in the past", () => {
		const status = reminderStatus(
			{ subject: "x", dueAt: new Date(NOW - DAY).toISOString(), recurrence: "FREQ=DAILY" },
			NOW,
		);
		expect(status).toBe(ReminderStatus.Upcoming);
	});

	it("is Snoozed when the snooze is still in the future", () => {
		const status = reminderStatus(
			{
				subject: "x",
				dueAt: new Date(NOW - DAY).toISOString(),
				snoozedUntil: new Date(NOW + HOUR).toISOString(),
			},
			NOW,
		);
		expect(status).toBe(ReminderStatus.Snoozed);
	});

	it("is Overdue when due in the past with no active snooze", () => {
		expect(reminderStatus({ subject: "x", dueAt: new Date(NOW - HOUR).toISOString() }, NOW)).toBe(
			ReminderStatus.Overdue,
		);
	});

	it("is Upcoming when due in the future", () => {
		expect(reminderStatus({ subject: "x", dueAt: due }, NOW)).toBe(ReminderStatus.Upcoming);
	});
});

describe("reminderEffectiveDue / reminderNextDue", () => {
	it("prefers the active snooze over the due date", () => {
		const r = {
			subject: "x",
			dueAt: new Date(NOW - DAY).toISOString(),
			snoozedUntil: new Date(NOW + DAY).toISOString(),
		};
		expect(reminderEffectiveDue(r, NOW)).toBe(new Date(NOW + DAY).toISOString());
	});

	it("falls back to the due date with no snooze (one-shot)", () => {
		const dueIso = new Date(NOW + DAY).toISOString();
		expect(reminderEffectiveDue({ subject: "x", dueAt: dueIso }, NOW)).toBe(dueIso);
	});

	it("advances a recurring reminder to its next occurrence", () => {
		const next = reminderNextDue(
			{ subject: "x", dueAt: new Date(NOW - DAY).toISOString(), recurrence: "FREQ=DAILY" },
			NOW,
		);
		expect(next).not.toBeNull();
		if (next !== null) expect(next).toBeGreaterThan(NOW);
	});
});
