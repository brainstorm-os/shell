/**
 * The Journal write gate — Lock-5(k).
 *
 * A journal entry is a `Note/v1` and carries the same synced lock. Journal read
 * it twice, both chrome (the editor's `editable`, the header's Lock toggle),
 * and wrote a locked entry through three ungated paths: the autosave body
 * denormaliser, the day icon picker, and the check-in patch behind mood +
 * habits — a surface the editor's read-only state never covered.
 *
 * These tests drive the funnel and assert on `entities.update`.
 */

import { describe, expect, it, vi } from "vitest";
import { type EntryWriteContext, entryWriteRefused, writeEntryPatch } from "./entry-writes";

function ctx(lockedIds: string[] = []): EntryWriteContext & {
	update: ReturnType<typeof vi.fn>;
} {
	const locked = new Set(lockedIds);
	const update = vi.fn(() => Promise.resolve(null));
	return { isLocked: (id) => locked.has(id), update };
}

describe("writeEntryPatch", () => {
	it("writes onto an unlocked entry", async () => {
		const c = ctx();
		expect(await writeEntryPatch(c, "n1", { mood: "good" })).toBe(true);
		expect(c.update).toHaveBeenCalledWith("n1", { mood: "good" });
	});

	it("refuses every property write on a LOCKED entry", async () => {
		const c = ctx(["n1"]);
		// The three real writers, one by one.
		expect(await writeEntryPatch(c, "n1", { body: "denormalised snippet" })).toBe(false);
		expect(await writeEntryPatch(c, "n1", { icon: null })).toBe(false);
		expect(await writeEntryPatch(c, "n1", { mood: "good", habits: ["run"] })).toBe(false);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("lets the lock-flip through, so a lock can always be undone", async () => {
		const c = ctx(["n1"]);
		expect(await writeEntryPatch(c, "n1", { locked: false })).toBe(true);
		expect(c.update).toHaveBeenCalledWith("n1", { locked: false });
	});

	it("refuses a MIXED patch wholesale", async () => {
		const c = ctx(["n1"]);
		expect(await writeEntryPatch(c, "n1", { locked: false, mood: "good" })).toBe(false);
		expect(c.update).not.toHaveBeenCalled();
	});

	it("reports false (and writes nothing) with no entities service", async () => {
		expect(await writeEntryPatch({ isLocked: () => false, update: undefined }, "n1", {})).toBe(false);
	});

	it("reports false when the service rejects, without throwing at the caller", async () => {
		const c = ctx();
		c.update.mockRejectedValueOnce(new Error("nope"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await writeEntryPatch(c, "n1", { mood: "good" })).toBe(false);
	});
});

describe("entryWriteRefused", () => {
	it("refuses a patch-less write on a locked entry and allows it on a free one", () => {
		const c = ctx(["n1"]);
		expect(entryWriteRefused(c, "n1")).toBe(true);
		expect(entryWriteRefused(c, "n2")).toBe(false);
	});
});
