/**
 * The ONE write path onto an `Event/v1` row — Lock-5(j).
 *
 * Calendar gated the two paths a lock is *obvious* on — the chip reschedule and
 * the cross-app object drop — and left the two that actually destroy things
 * ungated: the detail surface's Save/Delete (`applyDetailResult`) and the
 * multi-select bulk move, which rewrites the start of EVERY selected event with
 * no per-event check at all. The detail dialog freezes its fieldset when
 * locked, which is chrome; the bulk move has no affordance to freeze.
 *
 * So the decision lives here, once, over the shared `entity-lock` reading, and
 * the gate is inseparable from the write. Pure apart from the injected sink.
 */

import { lockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";
import type { Event } from "../types/event";

/** Where a permitted write goes — the repository under the shell. */
export type EventWriteSink = {
	save(event: Event): Promise<unknown>;
	remove(id: string): Promise<unknown>;
};

/** Built fresh per call (from refs) so a callback that outlives its render —
 *  a dialog resolve, a drag commit — reads the CURRENT lock. */
export type EventWriteContext = {
	find: (id: string) => Event | undefined;
	sink: EventWriteSink | null;
};

/** The current STORED lock for `id`, never the caller's copy of the row. An
 *  event not in the map is a creation and has no lock to honour. */
export function eventLocked(ctx: Pick<EventWriteContext, "find">, id: string): boolean {
	return ctx.find(id)?.locked === true;
}

/** Save an event row, or refuse. `next` is a whole replacement row, so there is
 *  no lock-only patch to earn the exemption with — the header's Lock toggle
 *  persists its flip through `entities.update` directly and never comes here. */
export async function saveEventWrite(ctx: EventWriteContext, next: Event): Promise<boolean> {
	if (lockRefusesWrite(eventLocked(ctx, next.id))) return false;
	await ctx.sink?.save(next);
	return true;
}

/** Delete an event, or refuse. Delete carries no patch to exempt, so a locked
 *  event refuses it outright. */
export async function removeEventWrite(ctx: EventWriteContext, id: string): Promise<boolean> {
	if (lockRefusesWrite(eventLocked(ctx, id))) return false;
	await ctx.sink?.remove(id);
	return true;
}

/** The subset of `events` a bulk operation may actually touch. The bulk move
 *  shifts a whole selection at once: rather than refusing the entire batch
 *  because one member is locked (which would make a selection unusable), the
 *  locked members are dropped and the rest proceed — every write still passes
 *  `saveEventWrite`, so this is a pre-filter, not the gate. */
export function unlockedEvents(events: readonly Event[]): Event[] {
	return events.filter((e) => !lockRefusesWrite(e.locked === true));
}
