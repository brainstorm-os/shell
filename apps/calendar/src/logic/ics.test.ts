import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { AttendeeRsvp } from "../types/attendee";
import type { Event } from "../types/event";
import { parseCalendar, serializeCalendar } from "./ics";

function makeEvent(over: Partial<Event> = {}): Event {
	const start = new Date(2026, 4, 14, 10, 0, 0).getTime();
	return {
		id: "evt-1",
		title: "Standup",
		icon: null,
		start,
		end: start + 3_600_000,
		allDay: false,
		location: null,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt: new Date(2026, 0, 1, 0, 0, 0).getTime(),
		updatedAt: new Date(2026, 0, 2, 0, 0, 0).getTime(),
		...over,
	};
}

describe("serializeCalendar", () => {
	it("wraps events in a VCALENDAR with CRLF line endings", () => {
		const ics = serializeCalendar([makeEvent()]);
		expect(ics).toContain("BEGIN:VCALENDAR");
		expect(ics).toContain("BEGIN:VEVENT");
		expect(ics).toContain("SUMMARY:Standup");
		expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
	});

	it("escapes TEXT special chars and emits an all-day DATE value", () => {
		const ics = serializeCalendar([
			makeEvent({ title: "A; B, C", allDay: true, end: null, location: "Rm: 1" }),
		]);
		expect(ics).toContain("SUMMARY:A\\; B\\, C");
		expect(ics).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
	});
});

describe("parseCalendar", () => {
	it("round-trips a rich event through serialize → parse", () => {
		const event = makeEvent({
			title: "Weekly review",
			description: "Discuss; review, etc.",
			location: "Room 4",
			recurrence: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Thu] },
			statusKey: "tentative",
			colorHint: "#d49241",
			reminders: [10, 60],
			attendees: [
				{ name: "Mira", email: "mira@x.io", rsvp: AttendeeRsvp.Accepted },
				{ name: "Jules", email: null, rsvp: AttendeeRsvp.NeedsAction },
			],
		});
		const { events, warnings } = parseCalendar(serializeCalendar([event]));
		expect(warnings).toEqual([]);
		expect(events).toHaveLength(1);
		const out = events[0];
		expect(out).toMatchObject({
			id: "evt-1",
			title: "Weekly review",
			description: "Discuss; review, etc.",
			location: "Room 4",
			start: event.start,
			end: event.end,
			statusKey: "tentative",
			colorHint: "#d49241",
			reminders: [10, 60],
			recurrence: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Thu] },
		});
		expect(out?.attendees).toEqual([
			{ name: "Mira", email: "mira@x.io", rsvp: AttendeeRsvp.Accepted },
			{ name: "Jules", email: null, rsvp: AttendeeRsvp.NeedsAction },
		]);
	});

	it("parses an all-day event as allDay with a null end", () => {
		const { events } = parseCalendar(serializeCalendar([makeEvent({ allDay: true, end: null })]));
		expect(events[0]?.allDay).toBe(true);
		expect(events[0]?.end).toBeNull();
	});

	it("handles UTC (Z) DTSTART and a minimal foreign VEVENT", () => {
		const ics = [
			"BEGIN:VCALENDAR",
			"VERSION:2.0",
			"BEGIN:VEVENT",
			"UID:foreign-1",
			"DTSTART:20260601T120000Z",
			"SUMMARY:Imported",
			"END:VEVENT",
			"END:VCALENDAR",
			"",
		].join("\r\n");
		const { events } = parseCalendar(ics);
		expect(events).toHaveLength(1);
		expect(events[0]?.start).toBe(Date.UTC(2026, 5, 1, 12, 0, 0));
		expect(events[0]?.title).toBe("Imported");
	});

	it("warns and skips a VEVENT with no DTSTART", () => {
		const ics = ["BEGIN:VEVENT", "SUMMARY:No date", "END:VEVENT"].join("\r\n");
		const { events, warnings } = parseCalendar(ics);
		expect(events).toEqual([]);
		expect(warnings).toHaveLength(1);
	});

	it("unfolds folded lines", () => {
		const long = "x".repeat(200);
		const { events } = parseCalendar(serializeCalendar([makeEvent({ title: long })]));
		expect(events[0]?.title).toBe(long);
	});
});
