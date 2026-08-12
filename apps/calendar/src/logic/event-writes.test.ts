/**
 * The Calendar write gate — Lock-5(j).
 *
 * Calendar gated the chip reschedule and the cross-app drop, then left the
 * detail surface's Save/Delete and the multi-select bulk move writing locked
 * events. The detail dialog's frozen fieldset is chrome; the bulk move has no
 * per-row affordance to freeze at all.
 *
 * These tests drive the real funnels and assert on the sink.
 */

import { describe, expect, it, vi } from "vitest";
import type { Event } from "../types/event";
import {
	type EventWriteContext,
	eventLocked,
	removeEventWrite,
	saveEventWrite,
	unlockedEvents,
} from "./event-writes";

function event(id: string, over: Partial<Event> = {}): Event {
	return { id, title: id, start: 0, end: 1, allDay: false, ...over } as Event;
}

function ctx(list: Event[]): EventWriteContext & {
	save: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} {
	const save = vi.fn(() => Promise.resolve(null));
	const remove = vi.fn(() => Promise.resolve(null));
	const map = new Map(list.map((e) => [e.id, e]));
	return { find: (id) => map.get(id), sink: { save, remove }, save, remove };
}

describe("eventLocked", () => {
	it("reads the STORED lock, not the row the caller hands back", () => {
		const c = ctx([event("e1", { locked: true })]);
		expect(eventLocked(c, "e1")).toBe(true);
		expect(eventLocked(c, "missing")).toBe(false);
	});
});

describe("saveEventWrite — the detail surface's Save", () => {
	it("saves an unlocked event", async () => {
		const c = ctx([event("e1")]);
		expect(await saveEventWrite(c, event("e1", { title: "Renamed" }))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ title: "Renamed" }));
	});

	it("refuses a save on a LOCKED event, even one claiming to be unlocked", async () => {
		const c = ctx([event("e1", { locked: true })]);
		expect(await saveEventWrite(c, event("e1", { locked: false, title: "sneaky" }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("still CREATES an event that is not stored yet", async () => {
		const c = ctx([event("e1", { locked: true })]);
		expect(await saveEventWrite(c, event("new"))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
	});
});

describe("removeEventWrite — the detail surface's Delete", () => {
	it("removes an unlocked event and refuses a locked one", async () => {
		const c = ctx([event("e1"), event("e2", { locked: true })]);
		expect(await removeEventWrite(c, "e1")).toBe(true);
		expect(await removeEventWrite(c, "e2")).toBe(false);
		expect(c.remove).toHaveBeenCalledTimes(1);
		expect(c.remove).toHaveBeenCalledWith("e1");
	});
});

describe("unlockedEvents — the bulk move's pre-filter", () => {
	it("drops the locked members and keeps the rest", () => {
		const list = [event("a"), event("b", { locked: true }), event("c")];
		expect(unlockedEvents(list).map((e) => e.id)).toEqual(["a", "c"]);
	});

	it("keeps a selection usable when one member is locked", async () => {
		// Refusing the WHOLE batch would make a multi-select unusable the moment
		// one event in it is locked; the locked one simply sits the move out, and
		// every surviving write still passes the gate below.
		const c = ctx([event("a"), event("b", { locked: true })]);
		const moved = unlockedEvents([event("a"), event("b", { locked: true })]);
		for (const ev of moved) await saveEventWrite(c, { ...ev, start: 99 });
		expect(c.save).toHaveBeenCalledTimes(1);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ id: "a", start: 99 }));
	});
});
