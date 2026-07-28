/**
 * Bulk reschedule (9.15.15) — shift a batch of selected events together.
 * Pure: events in, shifted events out (inputs never mutated). The two
 * modes are "move the batch so its earliest event lands on a target day"
 * (preserving each event's time-of-day + the relative gaps between them)
 * and a plain ±N-day nudge.
 */

import type { Event } from "../types/event";
import { startOfDay } from "./date-range";

const DAY_MS = 86_400_000;

function shiftEvent(event: Event, deltaMs: number, now: number): Event {
	return {
		...event,
		start: event.start + deltaMs,
		end: event.end === null ? null : event.end + deltaMs,
		updatedAt: now,
	};
}

/** The per-object read-only lock gates every write path: locked events are
 *  dropped from a bulk shift (never rescheduled, never anchor the batch). */
function movable(events: readonly Event[]): Event[] {
	return events.filter((e) => e.locked !== true);
}

/** Move the whole batch so its earliest movable event's *day* becomes
 *  `targetDayStart`. The shift is a whole-day delta, so every event keeps
 *  its time-of-day and the batch keeps its internal spacing. Locked events
 *  are excluded from the result (they stay put). */
export function bulkShiftToDate(
	events: readonly Event[],
	targetDayStart: number,
	now: number = Date.now(),
): Event[] {
	const batch = movable(events);
	if (batch.length === 0) return [];
	const earliest = Math.min(...batch.map((e) => e.start));
	const deltaMs = startOfDay(targetDayStart) - startOfDay(earliest);
	if (deltaMs === 0) return batch.map((e) => ({ ...e }));
	return batch.map((e) => shiftEvent(e, deltaMs, now));
}

/** Nudge every movable event by `days` (may be negative). */
export function bulkShiftByDays(
	events: readonly Event[],
	days: number,
	now: number = Date.now(),
): Event[] {
	const batch = movable(events);
	if (days === 0) return batch.map((e) => ({ ...e }));
	return batch.map((e) => shiftEvent(e, days * DAY_MS, now));
}
