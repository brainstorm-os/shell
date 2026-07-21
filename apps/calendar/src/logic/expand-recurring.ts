/**
 * Materialize recurring `ScheduledItem`s onto a visible window.
 *
 * The 9.15.5 shared engine (`occurrencesInRange`, `@brainstorm-os/sdk-types`)
 * owns the date math; this is the thin Calendar-side adapter that turns
 * one anchored item + its `recurrence` into one item *per occurrence in
 * the window*, preserving duration and re-deriving a stable per-instance
 * id. Items with no `recurrence` pass through untouched.
 *
 * Called by every view compiler over that view's own `[start, end]`
 * window (the doc 19.15 single-model resolution — birthdays, recurring
 * Events, recurring Tasks all flow through here, never per-app logic).
 * `sourceEntityId` is intentionally left intact so `intent.open` on any
 * instance still round-trips to the owning entity; only `id` is made
 * per-occurrence (the `ScheduledItem` contract anticipates exactly this).
 */

import { occurrencesInRange } from "@brainstorm-os/sdk-types";
import type { ScheduledItem } from "./scheduled-item";

export function expandRecurringItems(
	items: readonly ScheduledItem[],
	windowStart: number,
	windowEnd: number,
): ScheduledItem[] {
	const out: ScheduledItem[] = [];
	for (const item of items) {
		// Idempotent: an already-materialized occurrence (or a plain
		// non-recurring item) passes through by identity, so a second
		// expansion pass can never fan one occurrence out again.
		if (!item.recurrence || item.isRecurringInstance) {
			out.push(item);
			continue;
		}
		const duration = item.end !== null ? Math.max(0, item.end - item.start) : null;
		const starts = occurrencesInRange(item.start, item.recurrence, windowStart, windowEnd);
		for (const start of starts) {
			out.push({
				...item,
				id: `${item.id}@${start}`,
				start,
				end: duration === null ? null : start + duration,
				// Keep `recurrence` so the chip can badge + summarize the
				// pattern; `isRecurringInstance` guards re-expansion.
				isRecurringInstance: true,
			});
		}
	}
	return out;
}
