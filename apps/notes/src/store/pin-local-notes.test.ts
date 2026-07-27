/**
 * `pinLocalNotes` — the store's `reconcile`, and the reason Notes could not use
 * the shared reactivity stack until that option existed.
 *
 * This logic fixed a reported bug (open a sub-page, watch it vanish) and lived
 * inline in a `setNotes` callback with no test. Extracting it for the migration
 * is what finally makes it assertable.
 */

import { describe, expect, it } from "vitest";
import type { StoredNote } from "./note";
import { pinLocalNotes } from "./use-notes";

function note(id: string, title: string, updatedAt = 1): StoredNote {
	return { id, title, body: "", updatedAt, createdAt: 0 } as StoredNote;
}

const mapOf = (...notes: StoredNote[]): Map<string, StoredNote> =>
	new Map(notes.map((n) => [n.id, n]));

describe("pinLocalNotes", () => {
	it("keeps the open note when the disk snapshot has not caught up", () => {
		// The reported sub-page bug: a freshly-created note races the entities
		// write, so `listAll` comes back without it. Dropping it would null
		// `notes.get(selectedId)`, unmount the editor mid-edit, and reset the
		// selection.
		const prev = mapOf(note("a", "Alpha"), note("new", "Untitled"));
		const next = mapOf(note("a", "Alpha"));
		const merged = pinLocalNotes(prev, next, [], "new");
		expect(merged.has("new")).toBe(true);
		expect(merged.get("new")?.title).toBe("Untitled");
	});

	it("keeps notes whose save is still in flight, with the in-memory version", () => {
		// The on-disk row is stale until the debounced persist lands, so adopting
		// it would visibly revert the user's last keystrokes.
		const prev = mapOf(note("a", "typed just now", 99));
		const next = mapOf(note("a", "stale on disk", 1));
		const merged = pinLocalNotes(prev, next, ["a"], null);
		expect(merged.get("a")?.title).toBe("typed just now");
	});

	it("returns `next` ITSELF when nothing needed pinning", () => {
		// Identity matters: the caller's `equals` short-circuit compares against
		// the previous snapshot, and a gratuitous copy here would defeat it and
		// re-render the virtualised sidebar on every broadcast.
		const next = mapOf(note("a", "Alpha"));
		expect(pinLocalNotes(mapOf(note("a", "Alpha")), next, [], null)).toBe(next);
	});

	it("does not resurrect a note that is genuinely gone", () => {
		// Deleting the open note elsewhere must still remove it — pinning applies
		// only to ids the PREVIOUS snapshot still holds, and a delete clears it
		// from local state first.
		const prev = mapOf(note("a", "Alpha"));
		const merged = pinLocalNotes(prev, mapOf(), [], "deleted-id");
		expect(merged.size).toBe(0);
	});

	it("adopts disk state for everything not pinned", () => {
		// The point of the refresh: a sibling app's edit must land.
		const prev = mapOf(note("a", "old title"), note("open", "mine"));
		const next = mapOf(note("a", "renamed elsewhere"), note("open", "stale"));
		const merged = pinLocalNotes(prev, next, [], "open");
		expect(merged.get("a")?.title).toBe("renamed elsewhere");
		expect(merged.get("open")?.title).toBe("mine");
	});

	it("pins the open note and in-flight saves together", () => {
		const prev = mapOf(note("open", "mine"), note("saving", "typed"), note("x", "old"));
		const next = mapOf(note("x", "fresh"));
		const merged = pinLocalNotes(prev, next, ["saving"], "open");
		expect([...merged.keys()].sort()).toEqual(["open", "saving", "x"]);
		expect(merged.get("x")?.title).toBe("fresh");
	});
});
