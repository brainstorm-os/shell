import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat";
import { PINNED_MAX, pinnedMessages, readPinned, setPinned, togglePin } from "./pins";

const msg = (id: string): ChatMessage => ({
	id,
	channelId: "c1",
	body: id,
	authorRef: "a",
	authorName: "A",
	createdAt: "",
	seq: 0,
	attachments: [],
});

describe("pins (Chats-4)", () => {
	it("setPinned is idempotent: re-pinning or re-unpinning changes nothing", () => {
		expect(setPinned(["a", "b"], "b", true)).toEqual(["a", "b"]);
		expect(setPinned(["a"], "b", false)).toEqual(["a"]);
		expect(setPinned(["a"], "b", true)).toEqual(["a", "b"]);
		expect(setPinned(["a", "b"], "a", false)).toEqual(["b"]);
	});

	it("decodes defensively: strings only, de-duplicated, bounded", () => {
		expect(readPinned(["m1", 3, "", "m1", "m2", null])).toEqual(["m1", "m2"]);
		expect(readPinned("m1")).toEqual([]);
		const many = Array.from({ length: PINNED_MAX + 5 }, (_, i) => `m${i}`);
		expect(readPinned(many)).toHaveLength(PINNED_MAX);
	});

	it("toggles a pin on and off", () => {
		expect(togglePin(["m1"], "m2")).toEqual(["m1", "m2"]);
		expect(togglePin(["m1", "m2"], "m1")).toEqual(["m2"]);
	});

	it("drops the oldest pin past the cap", () => {
		const full = Array.from({ length: PINNED_MAX }, (_, i) => `m${i}`);
		const next = togglePin(full, "new");
		expect(next).toHaveLength(PINNED_MAX);
		expect(next[0]).toBe("m1");
		expect(next[next.length - 1]).toBe("new");
	});

	it("lists resolvable pins, most recently pinned first", () => {
		expect(
			pinnedMessages(["m1", "gone", "m3"], [msg("m1"), msg("m2"), msg("m3")]).map((m) => m.id),
		).toEqual(["m3", "m1"]);
	});
});
