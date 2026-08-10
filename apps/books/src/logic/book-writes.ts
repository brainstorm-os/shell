/**
 * The ONE write path onto a `Book/v1` row.
 *
 * Books has three property writers that never touch a UI control — the
 * page-turn persister, the PDF metadata backfill, and the header's Lock
 * toggle — plus the inspector's property cells. Spelling the read-only gate
 * per writer is how Lock-5's Books guard ended up untested: the only test that
 * claimed to "refuse a property write on a locked book" clicked the lock
 * button, which wrote through `entities.update` directly, so deleting the
 * guard changed nothing anyone asserted.
 *
 * So the decision lives here, once, off the shared `lockRefusesWrite` reading,
 * and `app.tsx` holds no write logic of its own — every writer calls
 * `writeBookPatch`. Pure apart from the injected `update`, so the refusals are
 * unit-testable without mounting a reader.
 */

import { lockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";
import type { Book } from "../types/book";
import type { Locator } from "../types/locator";
import { readingPositionPatch } from "./book-open";

/** Everything the gate needs about the CURRENT state of the open book. Built
 *  fresh per call (from refs) so a long-lived reader callback can never write
 *  against the lock that held when the book was opened. */
export type BookWriteContext = {
	/** The open book's id; `null` on the empty shelf. */
	bookId: string | null;
	/** The in-memory sample book — a preview with nothing to persist to. */
	sample: boolean;
	/** The open book's synced read-only lock. */
	locked: boolean;
	/** `entities.update`, absent on a shell without the service. */
	update: ((id: string, patch: Record<string, unknown>) => Promise<unknown> | unknown) | undefined;
};

/** Whether the open book refuses this write. `patch` is omitted for a write
 *  with no patch to exempt — the ⋯ menu's Remove, which destroys the row. */
export function bookWriteRefused(
	ctx: Omit<BookWriteContext, "update">,
	patch?: Record<string, unknown>,
): boolean {
	if (!ctx.bookId || ctx.sample) return true;
	// The lock-flip is the one patch a locked book still takes — and only when
	// it is the WHOLE patch, so `{ locked: false, name: "…" }` cannot walk a
	// rename past the gate on the lock key's coat-tails.
	return lockRefusesWrite(ctx.locked, patch);
}

/** Issue a property write, or refuse it. Returns whether the write went out —
 *  callers that mirror state locally can ride that answer rather than assuming
 *  their patch landed. */
export function writeBookPatch(ctx: BookWriteContext, patch: Record<string, unknown>): boolean {
	const bookId = ctx.bookId;
	if (!bookId || bookWriteRefused(ctx, patch)) return false;
	const update = ctx.update;
	if (!update) return false;
	void Promise.resolve(update(bookId, patch)).catch((error: unknown) => {
		console.warn(`[books] property write failed: ${(error as Error).message}`);
	});
	return true;
}

/** Persist a page turn onto the `Book/v1` row. Each write chains off the
 *  previously-advanced book so progress / lastReadAt never regress.
 *
 *  `write` is the gated path above, never a raw `entities.update`: a page turn
 *  is a property write like any other and a locked book refuses it. Reading a
 *  locked book still works — the reader advances in memory; only the
 *  persistence is dropped. */
export function makePositionPersister(
	write: (patch: Record<string, unknown>) => void,
	initial: Book,
	spineLength: number,
): (locator: Locator, progress: number) => void {
	let current = initial;
	return (locator, progress) => {
		const { book, patch } = readingPositionPatch(current, locator, progress, spineLength, Date.now());
		current = book;
		write(patch);
	};
}
