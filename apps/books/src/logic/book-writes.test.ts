/**
 * The Books write gate — Lock-5(e).
 *
 * The Lock-5(b) claim "the lock is enforced on the write, not only in the
 * panel's chrome" was refuted: the test that carried it only clicked the lock
 * button, and the lock button wrote through `entities.update` directly, so the
 * guard could be deleted with every Books test still green. These tests
 * perform REAL property writes — the ones a locked book actually receives with
 * no UI affordance in sight (a page turn, the PDF metadata backfill) — so
 * deleting the `lockRefusesWrite` line in `writeBookPatch` fails them.
 */

import { describe, expect, it, vi } from "vitest";
import { type Book, BookFormat, emptyReadingState } from "../types/book";
import { makeLocator } from "../types/locator";
import {
	type BookWriteContext,
	bookWriteRefused,
	makePositionPersister,
	removeBookEntity,
	writeBookPatch,
} from "./book-writes";

function book(): Book {
	return {
		id: "b1",
		name: "Deep Work",
		icon: null,
		format: BookFormat.Pdf,
		author: "Cal Newport",
		fileId: "f1",
		spineLength: 3,
		reading: emptyReadingState(),
		createdAt: 1,
		updatedAt: 1,
	};
}

function ctx(over: Omit<Partial<BookWriteContext>, "update"> = {}): BookWriteContext & {
	update: ReturnType<typeof vi.fn>;
} {
	const update = vi.fn(() => Promise.resolve(null));
	return { bookId: "b1", sample: false, locked: false, ...over, update };
}

describe("writeBookPatch", () => {
	it("issues the write on an unlocked book", () => {
		const c = ctx();
		expect(writeBookPatch(c, { name: "Renamed" })).toBe(true);
		expect(c.update).toHaveBeenCalledWith("b1", { name: "Renamed" });
	});

	it("refuses every property write on a LOCKED book", () => {
		const c = ctx({ locked: true });
		expect(writeBookPatch(c, { name: "Renamed" })).toBe(false);
		expect(writeBookPatch(c, { author: "Someone else" })).toBe(false);
		expect(writeBookPatch(c, { reading: { position: null, progress: 0.5, lastReadAt: 7 } })).toBe(
			false,
		);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("lets the lock-flip through, so a lock can always be undone", () => {
		const c = ctx({ locked: true });
		expect(writeBookPatch(c, { locked: false })).toBe(true);
		expect(c.update).toHaveBeenCalledWith("b1", { locked: false });
	});

	it("refuses a MIXED patch wholesale — the lock key carries nothing with it", () => {
		const c = ctx({ locked: true });
		expect(writeBookPatch(c, { locked: false, name: "renamed behind the lock" })).toBe(false);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("writes nothing for the sample book or the empty shelf", () => {
		const sample = ctx({ sample: true });
		expect(writeBookPatch(sample, { name: "x" })).toBe(false);
		const shelf = ctx({ bookId: null });
		expect(writeBookPatch(shelf, { name: "x" })).toBe(false);
		expect(sample.update).not.toHaveBeenCalled();
		expect(shelf.update).not.toHaveBeenCalled();
	});

	it("reports false (and writes nothing) when the shell exposes no entities service", () => {
		const c = { bookId: "b1", sample: false, locked: false, update: undefined };
		expect(writeBookPatch(c, { name: "x" })).toBe(false);
	});
});

describe("removeBookEntity — delete is a write too", () => {
	function removeCtx(
		over: Partial<{ bookId: string | null; sample: boolean; locked: boolean }> = {},
	) {
		const remove = vi.fn(() => Promise.resolve(null));
		return {
			ctx: { bookId: "b1", sample: false, locked: false, ...over, remove },
			remove,
		};
	}

	it("removes an unlocked book", () => {
		const { ctx, remove } = removeCtx();
		expect(removeBookEntity(ctx)).toBe(true);
		expect(remove).toHaveBeenCalledWith("b1");
	});

	it("refuses to remove a LOCKED book — and issues no delete", () => {
		// Lock-5(f): the previous spelling asserted only `bookWriteRefused(...)`
		// returning `true`, so the `entities.delete` call site in `app.tsx` could
		// lose its guard with this file still green. Now the refusal and the
		// delete are the same function, and the mock proves nothing went out.
		const { ctx, remove } = removeCtx({ locked: true });
		expect(removeBookEntity(ctx)).toBe(false);
		expect(remove).not.toHaveBeenCalled();
	});

	it("removes nothing for the sample book, the empty shelf, or a shell with no service", () => {
		const sample = removeCtx({ sample: true });
		expect(removeBookEntity(sample.ctx)).toBe(false);
		const shelf = removeCtx({ bookId: null });
		expect(removeBookEntity(shelf.ctx)).toBe(false);
		expect(sample.remove).not.toHaveBeenCalled();
		expect(shelf.remove).not.toHaveBeenCalled();
		expect(removeBookEntity({ bookId: "b1", sample: false, locked: false, remove: undefined })).toBe(
			false,
		);
	});

	it("refuses anything aimed at the sample book or the empty shelf", () => {
		expect(bookWriteRefused({ bookId: "b1", sample: true, locked: false })).toBe(true);
		expect(bookWriteRefused({ bookId: null, sample: false, locked: false })).toBe(true);
	});
});

describe("makePositionPersister — a page turn is a property write", () => {
	const locator = makeLocator(2, 0);

	it("persists each page turn through the gate", () => {
		const c = ctx();
		const persist = makePositionPersister((patch) => void writeBookPatch(c, patch), book(), 3);
		persist(locator, 0.5);
		expect(c.update).toHaveBeenCalledTimes(1);
		expect(c.update.mock.calls[0]?.[0]).toBe("b1");
		expect(c.update.mock.calls[0]?.[1]).toMatchObject({ spineLength: 3 });
	});

	it("turns pages on a LOCKED book without writing it (F-484: the lock is not chrome)", () => {
		const c = ctx({ locked: true });
		const persist = makePositionPersister((patch) => void writeBookPatch(c, patch), book(), 3);
		persist(locator, 0.5);
		persist(makeLocator(3, 0), 0.9);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("keeps chaining reading state locally, so reading a locked book still works", () => {
		const seen: Record<string, unknown>[] = [];
		const persist = makePositionPersister((patch) => seen.push(patch), book(), 3);
		persist(locator, 0.4);
		persist(makeLocator(3, 0), 0.8);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toMatchObject({ spineLength: 3 });
	});
});
