/**
 * Persistence codec for `brainstorm/Event/v1`.
 *
 * Long-term keystone — the on-disk JSON protocol the Stage 9.3 entities
 * service will read without rename. All shape validation lives here so
 * a malformed row from a future migration / sync conflict drops to
 * `null` rather than crashing the renderer.
 *
 * Storage key: `event:<id>` — one row per Event. Matches the namespace
 * convention `apps/notes` (`note:<id>`) + `apps/tasks` (`task:<id>`) so
 * the shell-side `vaultEntities` aggregator picks Events up by prefix
 * when its scope grows.
 */

import { type Recurrence, isRecurrence } from "@brainstorm/sdk-types";
import { nullableNumber, nullableString } from "@brainstorm/sdk/codec-helpers";
import { parseIcon } from "@brainstorm/sdk/entity-icon";
import { normalizeAttendees } from "../logic/attendees";
import { normalizeReminders } from "../logic/reminders";
import { normalizeTimeZone } from "../logic/timezone";
import type { Event } from "../types/event";

export const EVENT_KEY_PREFIX = "event:";

export function eventKey(id: string): string {
	return EVENT_KEY_PREFIX + id;
}

export function serializeEvent(event: Event): Event {
	return { ...event };
}

export function parseStoredEvent(raw: unknown): Event | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;

	if (typeof r.id !== "string" || r.id === "") return null;
	if (typeof r.title !== "string") return null;
	if (typeof r.start !== "number" || !Number.isFinite(r.start)) return null;
	if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
	if (typeof r.updatedAt !== "number" || !Number.isFinite(r.updatedAt)) return null;

	const end = nullableNumber(r.end);
	// End-before-start is structurally invalid — reject so a corrupted
	// sync row doesn't paint a backwards span. (A null end is fine — that's
	// an instant event.)
	if (end !== null && end < r.start) return null;

	const recurrence: Recurrence | null = isRecurrence(r.recurrence)
		? (r.recurrence as Recurrence)
		: null;

	const event: Event = {
		id: r.id,
		title: r.title,
		icon: parseIcon(r.icon),
		start: r.start,
		end,
		allDay: r.allDay === true,
		location: nullableString(r.location),
		recurrence,
		statusKey: nullableString(r.statusKey),
		colorHint: nullableString(r.colorHint),
		reminders: normalizeReminders(r.reminders),
		attendees: normalizeAttendees(r.attendees),
		timeZone: normalizeTimeZone(r.timeZone),
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
	};
	if (typeof r.description === "string") event.description = r.description;
	if (r.locked === true) event.locked = true;
	return event;
}
