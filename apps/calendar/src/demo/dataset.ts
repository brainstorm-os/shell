/**
 * In-memory demo dataset for the Calendar preview drop (9.15.1.5).
 *
 * Pinned `DEMO_NOW` anchor at 2026-05-14 (Thursday) 13:00 local. Events
 * are spread across May 2026 (the focus month) with a handful in April +
 * June so prev/next navigation has content. The dataset mixes
 * instant-events, multi-hour events, multi-day events, all-day events,
 * and recurring weekly anchors so each view kind has interesting layout
 * to render.
 *
 * `DEMO_TASK_OCCURRENCES` are Tasks-app rows surfaced on the Calendar
 * via the cross-app temporal index — they ride alongside Events under
 * the same `ScheduledItem` shape so the renderer never branches on
 * source. The Stage 9.3 entities-service swap replaces these arrays
 * with live `entities.read:*` queries; the renderer stays untouched.
 */

import { IconKind, RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { EVENT_SOURCE_KEY, type ScheduledItem, sourceKeyFor } from "../logic/scheduled-item";
import type { Event } from "../types/event";

const DEMO_TASK_TYPE = "brainstorm/Task/v1";
const DEMO_PERSON_TYPE = "brainstorm/Person/v1";

/** Stable "now" anchor — 2026-05-14 (Thursday) 13:00:00 local. */
export const DEMO_NOW: number = new Date(2026, 4, 14, 13, 0, 0, 0).getTime();

const MAY = 4; // zero-indexed
const APR = 3;
const JUN = 5;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month, day, hour, minute, 0, 0).getTime();
}

const Y = 2026;

export const DEMO_EVENTS: readonly Event[] = Object.freeze([
	// Multi-day company offsite, May 11–13 (recent past relative to DEMO_NOW)
	makeEvent({
		id: "evt_offsite_2026",
		title: "Company offsite — Lake Sound",
		description: "Three-day product strategy retreat. Bring the laptop, not the slides.",
		start: at(Y, MAY, 11, 9),
		end: at(Y, MAY, 13, 17),
		allDay: false,
		location: "Lake Sound Lodge",
		colorHint: "#7c83ff",
		icon: { kind: IconKind.Emoji, value: "🏔️" },
	}),
	// Recurring weekly product review — every Thursday 10:00–11:00
	makeEvent({
		id: "evt_review_weekly",
		title: "Product review",
		start: at(Y, MAY, 14, 10),
		end: at(Y, MAY, 14, 11),
		allDay: false,
		icon: { kind: IconKind.Emoji, value: "📊" },
		recurrence: {
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Thu],
		},
		colorHint: "#5da27e",
	}),
	// Lunch with Sam (TODAY 13:00 — collides with DEMO_NOW)
	makeEvent({
		id: "evt_lunch_sam",
		title: "Lunch with Sam",
		start: at(Y, MAY, 14, 13),
		end: at(Y, MAY, 14, 14),
		allDay: false,
		location: "Pinedrop Café",
		colorHint: "#d49241",
	}),
	// Dentist (today, late afternoon)
	makeEvent({
		id: "evt_dentist",
		title: "Dentist",
		start: at(Y, MAY, 14, 16, 30),
		end: at(Y, MAY, 14, 17, 30),
		allDay: false,
		location: "3rd & Cedar",
		colorHint: "#7d97c1",
	}),
	// Tomorrow — Friday block
	makeEvent({
		id: "evt_design_review",
		title: "Design review — Notes property model",
		start: at(Y, MAY, 15, 14),
		end: at(Y, MAY, 15, 15, 30),
		allDay: false,
		colorHint: "#c66a8c",
	}),
	makeEvent({
		id: "evt_yoga_friday",
		title: "Yoga",
		start: at(Y, MAY, 15, 8),
		end: at(Y, MAY, 15, 9),
		allDay: false,
		colorHint: "#5da27e",
	}),
	// Weekend — May 16
	makeEvent({
		id: "evt_birthday_party",
		title: "Mira's birthday",
		start: at(Y, MAY, 16, 18),
		end: at(Y, MAY, 16, 22),
		allDay: false,
		location: "37 Sandpiper Ln",
		colorHint: "#d49241",
	}),
	// All-day Monday
	makeEvent({
		id: "evt_focus_day",
		title: "Focus day — no meetings",
		start: at(Y, MAY, 18, 0),
		end: at(Y, MAY, 18, 0),
		allDay: true,
		colorHint: "#7d97c1",
	}),
	// Tuesday week 2
	makeEvent({
		id: "evt_1on1_jules",
		title: "1:1 with Jules",
		start: at(Y, MAY, 19, 11),
		end: at(Y, MAY, 19, 12),
		allDay: false,
		colorHint: "#5da27e",
	}),
	// Wednesday 20 — big calendar day with several events
	makeEvent({
		id: "evt_standup_wed",
		title: "Stand-up",
		start: at(Y, MAY, 20, 9, 30),
		end: at(Y, MAY, 20, 9, 45),
		allDay: false,
		colorHint: "#5da27e",
	}),
	makeEvent({
		id: "evt_demo_practice",
		title: "Demo practice",
		start: at(Y, MAY, 20, 14),
		end: at(Y, MAY, 20, 15),
		allDay: false,
		colorHint: "#c66a8c",
	}),
	makeEvent({
		id: "evt_dinner_andre",
		title: "Dinner with André",
		start: at(Y, MAY, 20, 19),
		end: at(Y, MAY, 20, 21),
		allDay: false,
		location: "Tabernacle",
		colorHint: "#d49241",
	}),
	// Multi-day workshop, May 25–27
	makeEvent({
		id: "evt_workshop",
		title: "Design systems workshop",
		start: at(Y, MAY, 25, 10),
		end: at(Y, MAY, 27, 16),
		allDay: false,
		location: "Conway hall",
		colorHint: "#7c83ff",
	}),
	// Holiday — May 25 all-day
	makeEvent({
		id: "evt_memorial",
		title: "Memorial Day",
		start: at(Y, MAY, 25, 0),
		end: at(Y, MAY, 25, 0),
		allDay: true,
		colorHint: "#9b96a0",
	}),
	// Late May plane trip
	makeEvent({
		id: "evt_flight_out",
		title: "Flight ✈ → BCN",
		start: at(Y, MAY, 30, 6, 30),
		end: at(Y, MAY, 30, 18),
		allDay: false,
		colorHint: "#7d97c1",
	}),
	// April anchor — for prev nav
	makeEvent({
		id: "evt_taxes_april",
		title: "File taxes",
		start: at(Y, APR, 15, 9),
		end: at(Y, APR, 15, 10),
		allDay: false,
		colorHint: "#d49241",
	}),
	// June anchor — for next nav
	makeEvent({
		id: "evt_summit_june",
		title: "Brainstorm summit",
		start: at(Y, JUN, 4, 9),
		end: at(Y, JUN, 5, 17),
		allDay: false,
		location: "Stockholm",
		colorHint: "#7c83ff",
	}),
]);

/** Tasks-app `scheduledAt` rows surfaced on the calendar via the cross-app
 *  temporal index. The renderer treats them like instant events with a
 *  Task-source chip. Picked to interleave with the events above. */
type TaskOccurrence = {
	id: string;
	title: string;
	start: number;
};

const TASK_OCCURRENCES: readonly TaskOccurrence[] = Object.freeze([
	{ id: "task_release_notes", title: "Draft release notes", start: at(Y, MAY, 14, 9) },
	{ id: "task_dentist_call", title: "Call insurance about cleaning", start: at(Y, MAY, 14, 11) },
	{ id: "task_pay_rent", title: "Pay rent", start: at(Y, MAY, 15, 12) },
	{ id: "task_pick_flowers", title: "Pick up flowers for Mira", start: at(Y, MAY, 16, 16) },
	{ id: "task_read_brief", title: "Read the architecture brief", start: at(Y, MAY, 19, 9) },
	{ id: "task_review_pr", title: "Review the marketplace PR", start: at(Y, MAY, 22, 15) },
	{ id: "task_pack", title: "Pack for BCN", start: at(Y, MAY, 29, 18) },
]);

/** Person birthdays — surfaced as all-day "birthday" rows by the
 *  cross-app temporal index. The 9.15.4 birthdays iteration will swap
 *  this for a live `Person/v1` walk; the row shape stays. */
type BirthdayOccurrence = {
	id: string;
	personName: string;
	start: number;
};

const BIRTHDAY_OCCURRENCES: readonly BirthdayOccurrence[] = Object.freeze([
	{ id: "birthday_mira", personName: "Mira", start: at(Y, MAY, 16, 0) },
	{ id: "birthday_jules", personName: "Jules", start: at(Y, MAY, 22, 0) },
	{ id: "birthday_andre", personName: "André", start: at(Y, MAY, 28, 0) },
]);

/** Single flat list of demo `ScheduledItem`s — already projected from
 *  Events / Tasks / Birthdays. The 9.3 entities-service swap replaces
 *  this array with a `vaultEntities.list()`-driven projection; nothing
 *  downstream of `ScheduledItem` changes. */
export const DEMO_ITEMS: readonly ScheduledItem[] = Object.freeze([
	...DEMO_EVENTS.map(eventToItem),
	...TASK_OCCURRENCES.map(taskToItem),
	...BIRTHDAY_OCCURRENCES.map(birthdayToItem),
]);

function eventToItem(event: Event): ScheduledItem {
	return {
		id: event.id,
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: event.id,
		title: event.title,
		icon: event.icon ?? null,
		start: event.start,
		end: event.end,
		allDay: event.allDay,
		location: event.location,
		recurrence: event.recurrence,
		colorHint: event.colorHint,
	};
}

function taskToItem(task: TaskOccurrence): ScheduledItem {
	return {
		id: `item_${task.id}`,
		sourceKey: sourceKeyFor(DEMO_TASK_TYPE, "scheduledAt"),
		sourceEntityId: task.id,
		title: task.title,
		icon: null,
		start: task.start,
		end: null,
		allDay: false,
		location: null,
		recurrence: null,
		colorHint: "#d49241",
	};
}

function birthdayToItem(b: BirthdayOccurrence): ScheduledItem {
	return {
		id: `item_${b.id}`,
		sourceKey: sourceKeyFor(DEMO_PERSON_TYPE, "birthday"),
		sourceEntityId: b.id,
		title: `${b.personName}'s birthday`,
		icon: { kind: IconKind.Emoji, value: "🎂" },
		start: b.start,
		end: null,
		allDay: true,
		location: null,
		recurrence: null,
		colorHint: "#c66a8c",
		readonly: true,
	};
}

function makeEvent(partial: {
	id: string;
	title: string;
	description?: string;
	start: number;
	end: number | null;
	allDay: boolean;
	location?: string;
	recurrence?: Event["recurrence"];
	colorHint?: string;
	icon?: Event["icon"];
}): Event {
	const createdAt = partial.start - 7 * DAY_MS;
	return {
		id: partial.id,
		title: partial.title,
		description: partial.description ?? "",
		icon: partial.icon ?? null,
		start: partial.start,
		end: partial.end,
		allDay: partial.allDay,
		location: partial.location ?? null,
		recurrence: partial.recurrence ?? null,
		statusKey: null,
		colorHint: partial.colorHint ?? null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt,
		updatedAt: createdAt + HOUR,
	};
}
