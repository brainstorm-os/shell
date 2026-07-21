import { IconKind, RecurrenceKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Event } from "../types/event";
import { EVENT_KEY_PREFIX, eventKey, parseStoredEvent, serializeEvent } from "./codec";

const BASE = {
	id: "e1",
	title: "Standup",
	icon: null,
	start: 1700000000000,
	end: null,
	allDay: false,
	location: null,
	recurrence: null,
	statusKey: null,
	colorHint: null,
	reminders: [] as number[],
	attendees: [] as Event["attendees"],
	timeZone: null,
	createdAt: 1700000000000,
	updatedAt: 1700000000000,
} as const;

describe("event keys", () => {
	it("uses stable prefix", () => {
		expect(EVENT_KEY_PREFIX).toBe("event:");
		expect(eventKey("abc")).toBe("event:abc");
	});
});

describe("serializeEvent", () => {
	it("returns a structural clone", () => {
		const out = serializeEvent({ ...BASE });
		expect(out).toEqual(BASE);
		expect(out).not.toBe(BASE);
	});
});

describe("parseStoredEvent", () => {
	it("returns null for non-objects + missing required fields", () => {
		expect(parseStoredEvent(null)).toBeNull();
		expect(parseStoredEvent({ ...BASE, id: "" })).toBeNull();
		expect(parseStoredEvent({ ...BASE, title: 42 })).toBeNull();
		expect(parseStoredEvent({ ...BASE, start: "later" })).toBeNull();
		expect(parseStoredEvent({ ...BASE, createdAt: Number.NaN })).toBeNull();
	});

	it("rejects end-before-start (structurally invalid span)", () => {
		expect(parseStoredEvent({ ...BASE, end: BASE.start - 1 })).toBeNull();
	});

	it("accepts null end (instant event)", () => {
		const out = parseStoredEvent({ ...BASE, end: null });
		expect(out?.end).toBeNull();
	});

	it("accepts end-equal-start (degenerate span)", () => {
		const out = parseStoredEvent({ ...BASE, end: BASE.start });
		expect(out?.end).toBe(BASE.start);
	});

	it("preserves allDay boolean only when literally true", () => {
		expect(parseStoredEvent({ ...BASE, allDay: true })?.allDay).toBe(true);
		expect(parseStoredEvent({ ...BASE, allDay: "yes" })?.allDay).toBe(false);
		expect(parseStoredEvent({ ...BASE, allDay: 1 })?.allDay).toBe(false);
	});

	it("coerces nullable strings safely", () => {
		const out = parseStoredEvent({
			...BASE,
			location: "Kitchen",
			statusKey: 42,
			colorHint: null,
		});
		expect(out?.location).toBe("Kitchen");
		expect(out?.statusKey).toBeNull();
		expect(out?.colorHint).toBeNull();
	});

	it("validates recurrence via isRecurrence (drops malformed)", () => {
		const valid = { kind: RecurrenceKind.Daily, every: 1 };
		expect(parseStoredEvent({ ...BASE, recurrence: valid })?.recurrence).toEqual(valid);
		expect(parseStoredEvent({ ...BASE, recurrence: { kind: "fortnight" } })?.recurrence).toBeNull();
		expect(parseStoredEvent({ ...BASE, recurrence: "weekly" })?.recurrence).toBeNull();
	});

	it("preserves description when supplied as string; drops when wrong-typed", () => {
		expect(parseStoredEvent({ ...BASE, description: "agenda" })?.description).toBe("agenda");
		expect(parseStoredEvent({ ...BASE, description: 42 })?.description).toBeUndefined();
	});

	it("round-trips a valid icon through parseIcon (detail-surface write path)", () => {
		const emoji = parseStoredEvent({
			...BASE,
			icon: { kind: IconKind.Emoji, value: "🎂" },
		});
		expect(emoji?.icon).toEqual({ kind: IconKind.Emoji, value: "🎂" });

		const pack = parseStoredEvent({
			...BASE,
			icon: { kind: IconKind.Pack, value: "phosphor/cake", color: "accent" },
		});
		expect(pack?.icon).toEqual({ kind: IconKind.Pack, value: "phosphor/cake", color: "accent" });
	});

	it("drops a malformed icon to null (does not crash the renderer)", () => {
		expect(parseStoredEvent({ ...BASE, icon: "🎂" })?.icon).toBeNull();
		expect(parseStoredEvent({ ...BASE, icon: { kind: "bogus" } })?.icon).toBeNull();
		expect(parseStoredEvent({ ...BASE, icon: null })?.icon).toBeNull();
	});
});
