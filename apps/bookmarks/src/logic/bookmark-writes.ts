/**
 * The ONE write path onto a `Bookmark/v1` row — Lock-5(g).
 *
 * Bookmarks shipped the read-only lock as CHROME only: the properties panel
 * painted every row read-only, the detail body went `contenteditable=false`,
 * the cover button went `disabled`. Nothing gated the writes. `mutateBookmark`
 * (mark read / archive, the content capture, the metadata backfill, the icon
 * and cover pickers, the Kanban lane drag, every inspector cell),
 * `removeBookmark`, the edit-tags dialog and the dedup merge all wrote a
 * locked bookmark straight through the repository. The merge is the data-loss
 * one: it BINS the losers.
 *
 * So the decision lives here, once, over the shared `entity-lock` reading, and
 * the gate is INSEPARABLE from the write — every function below both decides
 * and issues. `app.tsx` holds no lock logic of its own and has no ungated way
 * to reach the repository, which is the property the Contacts/Books spelling
 * lacked: there, deleting the `if (refused) return` line left the write behind
 * it standing and every test green.
 *
 * Pure apart from the injected sink, so the refusals are unit-testable without
 * mounting the app.
 */

import {
	anyLockRefusesWrite,
	isLockedProperties,
	lockTogglePatch,
} from "@brainstorm-os/sdk/entity-lock";
import type { Bookmark } from "../types/bookmark";

/** Where a permitted write goes: the shared entities repository under the
 *  shell, the in-memory demo list standalone. Both spellings implement this. */
export type BookmarkWriteSink = {
	save(bookmark: Bookmark): void;
	remove(id: string): void;
};

/** Everything a gated write needs. Built fresh per call (from refs) so a
 *  callback that outlives its render — a picker's `onChange`, a dialog's
 *  `onSave`, a capture that resolves seconds later — reads the CURRENT lock
 *  rather than the one that held when it was built. */
export type BookmarkWriteContext = {
	/** The live bookmark for an id, or `undefined` if it is gone. */
	find: (id: string) => Bookmark | undefined;
	sink: BookmarkWriteSink;
};

/** Whether a bookmark carries the synced read-only lock. A bookmark that is
 *  not there is not locked — "gone" is a different answer from "locked", and
 *  every caller below already refuses a missing row on its own. */
export function bookmarkLocked(bookmark: Bookmark | undefined): boolean {
	return isLockedProperties(bookmark);
}

/** Whether the lock refuses a write touching `ids`. `patch` is the property
 *  patch for a property write (so the lock-flip can be let through when it is
 *  the WHOLE patch), and is OMITTED for a write with no patch to exempt — a
 *  remove, or a merge that destroys its losers. */
export function bookmarkWriteRefused(
	ctx: Pick<BookmarkWriteContext, "find">,
	ids: readonly string[],
	patch?: Record<string, unknown>,
): boolean {
	return anyLockRefusesWrite((id) => bookmarkLocked(ctx.find(id)), ids, patch);
}

/**
 * Rewrite a bookmark through `fn`, or refuse. The single funnel behind mark
 * read / archive, the capture + metadata backfill, the icon and cover
 * pickers, the Kanban lane drag and every inspector property cell.
 *
 * Asked WITHOUT a patch: `fn` returns a whole replacement row, so there is no
 * patch whose keys could earn the lock-flip exemption. A locked bookmark
 * refuses all of it — and `setBookmarkLock` below is the one door left open,
 * so a lock can always be undone.
 *
 * Returns whether the write went out, so a caller that mirrors state locally
 * can ride that answer rather than assuming its patch landed.
 */
export function mutateBookmarkWrite(
	ctx: BookmarkWriteContext,
	id: string,
	fn: (bookmark: Bookmark) => Bookmark,
): boolean {
	const current = ctx.find(id);
	if (!current) return false;
	if (bookmarkWriteRefused(ctx, [id])) return false;
	const next = fn(current);
	if (next === current) return false;
	ctx.sink.save(next);
	return true;
}

/** Save a bookmark the caller already built — the edit-tags dialog's `onSave`,
 *  which hands back a finished row rather than a rewrite function. Gated the
 *  same way: it is a property write like any other. */
export function saveBookmarkWrite(ctx: BookmarkWriteContext, next: Bookmark): boolean {
	const current = ctx.find(next.id);
	if (!current || next === current) return false;
	if (bookmarkWriteRefused(ctx, [next.id])) return false;
	ctx.sink.save(next);
	return true;
}

/** Flip a bookmark's lock. The lock-flip is the one write a locked bookmark
 *  still takes, and it goes through the SAME gate carrying the lock-only patch
 *  — not around it — so the exemption is the shared one and nothing else can
 *  ride in on the lock key's coat-tails. */
export function toggleBookmarkLock(ctx: BookmarkWriteContext, id: string, now: number): boolean {
	const current = ctx.find(id);
	if (!current) return false;
	const patch = lockTogglePatch(bookmarkLocked(current));
	if (bookmarkWriteRefused(ctx, [id], patch)) return false;
	ctx.sink.save({ ...current, ...patch, updatedAt: now });
	return true;
}

/** Remove a bookmark, or refuse. Delete has no patch to exempt, so a locked
 *  bookmark refuses it outright — the ⋯ offers Remove disabled-with-the-reason,
 *  but the gate belongs where the write is, which the chord cannot walk around. */
export function removeBookmarkWrite(ctx: BookmarkWriteContext, id: string): boolean {
	if (!ctx.find(id)) return false;
	if (bookmarkWriteRefused(ctx, [id])) return false;
	ctx.sink.remove(id);
	return true;
}

/** Land one dedup merge: patch the survivor, bin the losers. Refused whole if
 *  ANY participant is locked — survivor or loser. This is the most destructive
 *  write in the app and the one Lock-5(g) left completely open: a locked
 *  bookmark could be silently binned by a merge it never consented to. */
export function mergeBookmarkWrite(
	ctx: BookmarkWriteContext,
	merged: Bookmark,
	removedIds: readonly string[],
): boolean {
	if (bookmarkWriteRefused(ctx, [merged.id, ...removedIds])) return false;
	ctx.sink.save(merged);
	for (const id of removedIds) ctx.sink.remove(id);
	return true;
}
