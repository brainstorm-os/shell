/**
 * The ONE write path onto a journal entry's `Note/v1` row — Lock-5(k).
 *
 * A journal entry IS a note, and it carries the same synced `locked` property.
 * Journal read that property in exactly two places, both chrome: the entry
 * editor's `editable`, and the header's Lock toggle. Underneath, three writers
 * went straight to `entities.update` — the autosave body denormaliser, the day
 * icon picker, and the check-in patch that persists mood + habits — so a locked
 * entry took its mood, its habits, its icon and its denormalised body like any
 * other. The editor being read-only does not stop the check-in row, which is a
 * different surface entirely.
 *
 * Pure apart from the injected `update`, so the refusals are unit-testable
 * without mounting a day.
 */

import { lockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";

export type EntryWriteContext = {
	/** The entry's synced read-only lock, read from the LIVE vault snapshot so
	 *  it reflects a lock set on another device. */
	isLocked: (noteId: string) => boolean;
	/** `entities.update`, absent on a shell without the service. */
	update: ((id: string, patch: Record<string, unknown>) => Promise<unknown>) | undefined;
};

/** Whether the lock refuses this write. `patch` is omitted for a write with no
 *  patch to exempt; the lock-flip is the one patch a locked entry still takes,
 *  and only when it is the WHOLE patch. */
export function entryWriteRefused(
	ctx: Pick<EntryWriteContext, "isLocked">,
	noteId: string,
	patch?: Record<string, unknown>,
): boolean {
	return lockRefusesWrite(ctx.isLocked(noteId), patch);
}

/** Issue a property write onto an entry, or refuse it. Returns whether the
 *  write went out — callers that mirror state optimistically ride that answer
 *  rather than painting an edit the vault refused. */
export async function writeEntryPatch(
	ctx: EntryWriteContext,
	noteId: string,
	patch: Record<string, unknown>,
): Promise<boolean> {
	if (entryWriteRefused(ctx, noteId, patch)) return false;
	const update = ctx.update;
	if (!update) return false;
	try {
		await update(noteId, patch);
	} catch (error) {
		console.warn("[journal] entities.update failed:", error);
		return false;
	}
	return true;
}
