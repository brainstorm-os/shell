/**
 * `brainstorm/Event/v1` — first-class calendar event.
 *
 * The Calendar app's primary entity. The Calendar's surface ALSO
 * paints Tasks (`Task.scheduledAt`), Notes (any user `Date` property),
 * and Person birthdays — but those rows are owned by their respective
 * apps; only `Event/v1` is Calendar-app-owned.
 *
 * Recurrence reuses the cross-app `Recurrence` discriminated union from
 * `@brainstorm/sdk-types` so a Task's `scheduledAt + recurrence` and an
 * Event's `start + recurrence` share the same shape (resolves OQ-CAL-1
 * by inheriting OQ-TK-1's resolution).
 */

import type { Icon, Recurrence } from "@brainstorm/sdk-types";
import type { Attendee } from "./attendee";

export type Event = {
	id: string;
	title: string;
	description?: string;
	icon?: Icon | null;
	/** Read-only lock — the event's synced `locked` property. When true the
	 *  detail form is read-only. */
	locked?: boolean;

	/** Epoch ms — start instant. Required. */
	start: number;

	/** Epoch ms — end instant; null for an instant event (single point in
	 *  time, e.g. a reminder ping). */
	end: number | null;

	/** True if the event covers the whole day(s) between `start` and
	 *  `end` without specific clock times. The renderer pins all-day rows
	 *  to the top of each day cell. */
	allDay: boolean;

	location: string | null;

	recurrence: Recurrence | null;

	/** Vocabulary key into the `event-status` dictionary (e.g.
	 *  `confirmed`, `tentative`, `cancelled`). Nullable on creation. */
	statusKey: string | null;

	/** Optional CSS colour string used as the event's chrome tint in the
	 *  Month / Week / Day cells. Falls back to the source app's accent
	 *  when the event is sourced from another app (e.g. amber tint for a
	 *  Task's `scheduledAt` row). */
	colorHint: string | null;

	/** Minutes-before-`start` reminder offsets, sorted ascending,
	 *  de-duplicated. `0` = at start time. Empty = no reminders. The
	 *  in-app scheduler fires a shell notification as each offset comes
	 *  due while the app is open; the field persists for a future
	 *  shell-side scheduler. */
	reminders: number[];

	/** Participant list with per-attendee RSVP state. Empty = no
	 *  attendees. */
	attendees: Attendee[];

	/** IANA time zone the event's wall-clock times are authored in (e.g.
	 *  `America/New_York`). `null` = the local wall-clock (the historical
	 *  behaviour). `start`/`end` stay absolute instants regardless. */
	timeZone: string | null;

	createdAt: number;
	updatedAt: number;
};
