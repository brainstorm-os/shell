/**
 * The Bookmarks write gate — Lock-5(g).
 *
 * Bookmarks had NO gate at all: the lock painted chrome and nothing else, so a
 * locked bookmark could be marked read, retagged, re-covered, re-captured,
 * removed, and — the data-loss one — binned by a dedup merge.
 *
 * Every test here performs a REAL write through the funnel `app.tsx` calls and
 * asserts on the sink, so the guard and the write cannot be separated: delete
 * a `bookmarkWriteRefused` line and the matching test sees the write land.
 */

import { describe, expect, it, vi } from "vitest";
import { BOOKMARK_ENTITY_TYPE, type Bookmark } from "../types/bookmark";
import {
	type BookmarkWriteContext,
	bookmarkLocked,
	bookmarkWriteRefused,
	mergeBookmarkWrite,
	mutateBookmarkWrite,
	removeBookmarkWrite,
	saveBookmarkWrite,
	toggleBookmarkLock,
} from "./bookmark-writes";

function bookmark(id: string, over: Partial<Bookmark> = {}): Bookmark {
	return {
		id,
		url: `https://example.com/${id}`,
		title: id,
		faviconUrl: null,
		coverImageUrl: null,
		tags: [],
		readAt: null,
		archivedAt: null,
		createdAt: 1,
		updatedAt: 1,
		...over,
	} as Bookmark;
}

function ctx(list: Bookmark[]): BookmarkWriteContext & {
	save: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} {
	const save = vi.fn();
	const remove = vi.fn();
	return {
		find: (id) => list.find((b) => b.id === id),
		sink: { save, remove },
		save,
		remove,
	};
}

const rename = (title: string) => (b: Bookmark) => ({ ...b, title });

describe("bookmarkLocked", () => {
	it("reads only the literal `true` as locked", () => {
		expect(bookmarkLocked(bookmark("a"))).toBe(false);
		expect(bookmarkLocked(bookmark("a", { locked: true }))).toBe(true);
		expect(bookmarkLocked(bookmark("a", { locked: false }))).toBe(false);
		expect(bookmarkLocked(undefined)).toBe(false);
	});

	it("pins the entity type the gate is written against", () => {
		expect(BOOKMARK_ENTITY_TYPE).toBe("brainstorm/Bookmark/v1");
	});
});

describe("mutateBookmarkWrite — the single property funnel", () => {
	it("writes an UNLOCKED bookmark", () => {
		const c = ctx([bookmark("b1")]);
		expect(mutateBookmarkWrite(c, "b1", rename("Renamed"))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", title: "Renamed" }));
	});

	it("refuses every property write on a LOCKED bookmark", () => {
		const c = ctx([bookmark("b1", { locked: true })]);
		// The real call sites, one by one: mark read, archive, retag, icon,
		// cover, the metadata backfill, and each inspector property cell.
		expect(mutateBookmarkWrite(c, "b1", rename("Renamed"))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, readAt: 99 }))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, archivedAt: 99 }))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, tags: ["design"] }))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, cover: null, icon: null }))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, contentFetchedAt: 5 }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("cannot be talked past by returning a patch that only clears the lock", () => {
		// `fn` returns a WHOLE row, so there is no lock-only patch to earn the
		// exemption with — `toggleBookmarkLock` is the one door, and it is the
		// only caller that gets to name a lock-only patch.
		const c = ctx([bookmark("b1", { locked: true })]);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, locked: false }))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => ({ ...b, locked: false, title: "sneaky" }))).toBe(
			false,
		);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("writes nothing for a bookmark that is gone, or a no-op rewrite", () => {
		const c = ctx([bookmark("b1")]);
		expect(mutateBookmarkWrite(c, "missing", rename("x"))).toBe(false);
		expect(mutateBookmarkWrite(c, "b1", (b) => b)).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});
});

describe("saveBookmarkWrite — the edit-tags dialog's finished row", () => {
	it("saves the row an unlocked bookmark's dialog hands back", () => {
		const c = ctx([bookmark("b1")]);
		expect(saveBookmarkWrite(c, bookmark("b1", { tags: ["design"] }))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ tags: ["design"] }));
	});

	it("refuses it when the bookmark was locked while the dialog was open", () => {
		// The dialog outlives the render that opened it: the gate re-reads the
		// CURRENT lock at save time, not the one that held at open time.
		const c = ctx([bookmark("b1", { locked: true })]);
		expect(saveBookmarkWrite(c, bookmark("b1", { tags: ["design"] }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});
});

describe("toggleBookmarkLock — the one write a locked bookmark still takes", () => {
	it("unlocks a locked bookmark, so a lock can always be undone", () => {
		const c = ctx([bookmark("b1", { locked: true })]);
		expect(toggleBookmarkLock(c, "b1", 42)).toBe(true);
		expect(c.save).toHaveBeenCalledWith(
			expect.objectContaining({ id: "b1", locked: false, updatedAt: 42 }),
		);
	});

	it("locks an unlocked bookmark", () => {
		const c = ctx([bookmark("b1")]);
		expect(toggleBookmarkLock(c, "b1", 42)).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ id: "b1", locked: true }));
	});

	it("writes nothing for a bookmark that is gone", () => {
		const c = ctx([bookmark("b1")]);
		expect(toggleBookmarkLock(c, "missing", 42)).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});
});

describe("removeBookmarkWrite — delete is a write too", () => {
	it("removes an unlocked bookmark", () => {
		const c = ctx([bookmark("b1")]);
		expect(removeBookmarkWrite(c, "b1")).toBe(true);
		expect(c.remove).toHaveBeenCalledWith("b1");
	});

	it("refuses to remove a LOCKED bookmark", () => {
		// Delete carries no patch, so there is no lock-flip to exempt. The ⋯
		// offers Remove disabled-with-the-reason, but this is the gate at the
		// write, which the chord and the confirm cannot walk around.
		const c = ctx([bookmark("b1", { locked: true })]);
		expect(removeBookmarkWrite(c, "b1")).toBe(false);
		expect(c.remove).not.toHaveBeenCalled();
	});
});

describe("mergeBookmarkWrite — the destructive one", () => {
	it("merges when every participant is unlocked", () => {
		const c = ctx([bookmark("b1"), bookmark("b2"), bookmark("b3")]);
		expect(mergeBookmarkWrite(c, bookmark("b1", { title: "Merged" }), ["b2", "b3"])).toBe(true);
		expect(c.save).toHaveBeenCalledTimes(1);
		expect(c.remove).toHaveBeenCalledWith("b2");
		expect(c.remove).toHaveBeenCalledWith("b3");
	});

	it("refuses the WHOLE merge when the SURVIVOR is locked", () => {
		const c = ctx([bookmark("b1", { locked: true }), bookmark("b2")]);
		expect(mergeBookmarkWrite(c, bookmark("b1", { title: "Merged" }), ["b2"])).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
		expect(c.remove).not.toHaveBeenCalled();
	});

	it("refuses the WHOLE merge when a LOSER is locked — the data-loss case", () => {
		// A loser is BINNED. A half-refused merge that saved the survivor and
		// skipped one delete would be worse than no merge, so nothing goes out.
		const c = ctx([bookmark("b1"), bookmark("b2", { locked: true }), bookmark("b3")]);
		expect(mergeBookmarkWrite(c, bookmark("b1", { title: "Merged" }), ["b2", "b3"])).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
		expect(c.remove).not.toHaveBeenCalled();
	});
});

describe("bookmarkWriteRefused — the shared reading, spelled once", () => {
	const c = ctx([bookmark("free"), bookmark("locked1", { locked: true })]);

	it("refuses a property write on a locked bookmark and allows it on a free one", () => {
		expect(bookmarkWriteRefused(c, ["locked1"], { title: "x" })).toBe(true);
		expect(bookmarkWriteRefused(c, ["free"], { title: "x" })).toBe(false);
	});

	it("lets a lock-ONLY patch through, and refuses a mixed one wholesale", () => {
		expect(bookmarkWriteRefused(c, ["locked1"], { locked: false })).toBe(false);
		expect(bookmarkWriteRefused(c, ["locked1"], { locked: false, title: "x" })).toBe(true);
	});

	it("refuses a patch-less write, and any multi-id write with one locked member", () => {
		expect(bookmarkWriteRefused(c, ["locked1"])).toBe(true);
		expect(bookmarkWriteRefused(c, ["free", "locked1"])).toBe(true);
		expect(bookmarkWriteRefused(c, ["free"])).toBe(false);
	});
});
