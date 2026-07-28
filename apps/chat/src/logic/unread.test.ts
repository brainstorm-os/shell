/**
 * 7.14 follow-up — the unread-count core behind Chat's app-icon badge:
 * watermark decode, per-channel max seq (channel-resolved messages only),
 * the unread total (others' messages above the watermark; unobserved
 * channels contribute 0), and the identity-stable ack.
 */

import { describe, expect, it } from "vitest";
import { CHANNEL_TYPE, type EntityLike, MESSAGE_TYPE } from "./chat";
import {
	ackChannels,
	channelMaxSeqs,
	decodeWatermarks,
	loadWatermarks,
	saveWatermarks,
} from "./unread";
import { READ_WATERMARKS_KEY, unreadTotal } from "./unread";

function channel(id: string): EntityLike {
	return { id, type: CHANNEL_TYPE, properties: { name: id, createdAt: "2026-01-01" } };
}

function message(id: string, channelId: string, seq: number, authorRef = "them"): EntityLike {
	return {
		id,
		type: MESSAGE_TYPE,
		properties: {
			conversation: channelId,
			body: `m${seq}`,
			createdAt: "2026-01-02",
			seq,
			sender: { kind: "participant", personRef: authorRef, displayName: authorRef },
		},
	};
}

describe("decodeWatermarks", () => {
	it("keeps only finite numeric entries", () => {
		expect(
			decodeWatermarks({ a: 3, b: "x", c: Number.NaN, d: Number.POSITIVE_INFINITY, e: 0 }),
		).toEqual({ a: 3, e: 0 });
	});

	it("degrades garbage to the empty map", () => {
		expect(decodeWatermarks(null)).toEqual({});
		expect(decodeWatermarks([1, 2])).toEqual({});
		expect(decodeWatermarks("nope")).toEqual({});
	});
});

describe("channelMaxSeqs", () => {
	it("maps each channel to its highest seq, -1 when empty", () => {
		const maxes = channelMaxSeqs([
			channel("ch1"),
			channel("ch2"),
			message("m1", "ch1", 0),
			message("m2", "ch1", 4),
		]);
		expect(maxes.get("ch1")).toBe(4);
		expect(maxes.get("ch2")).toBe(-1);
	});

	it("ignores agent-transcript messages (conversation not a chat channel)", () => {
		const maxes = channelMaxSeqs([channel("ch1"), message("m1", "agent-conv", 9)]);
		expect(maxes.get("ch1")).toBe(-1);
		expect(maxes.has("agent-conv")).toBe(false);
	});
});

describe("unreadTotal", () => {
	const entities = [
		channel("ch1"),
		channel("ch2"),
		message("m1", "ch1", 0),
		message("m2", "ch1", 1),
		message("m3", "ch2", 0),
		message("m4", "ch2", 1, "me"),
		message("m5", "agent-conv", 7),
	];

	it("counts others' messages above the channel watermark", () => {
		expect(unreadTotal(entities, "me", { ch1: 0, ch2: -1 })).toBe(2);
	});

	it("excludes own messages", () => {
		// ch2 above -1: m3 (them) counts, m4 (me) doesn't.
		expect(unreadTotal(entities, "me", { ch1: 99, ch2: -1 })).toBe(1);
	});

	it("an unobserved channel contributes 0 (history never badges on first run)", () => {
		expect(unreadTotal(entities, "me", {})).toBe(0);
	});

	it("ignores messages outside live chat channels (shared Message substrate)", () => {
		expect(unreadTotal(entities, "me", { "agent-conv": -1, ch1: 99, ch2: 99 })).toBe(0);
	});
});

describe("ackChannels", () => {
	const maxes = new Map([
		["ch1", 4],
		["ch2", -1],
	]);

	it("raises the named channels to their max seq", () => {
		expect(ackChannels({}, maxes, ["ch1", "ch2"])).toEqual({ ch1: 4, ch2: -1 });
	});

	it("returns the SAME reference when nothing changes", () => {
		const marks = { ch1: 4 };
		expect(ackChannels(marks, maxes, ["ch1"])).toBe(marks);
		expect(ackChannels(marks, maxes, ["missing"])).toBe(marks);
	});

	it("never lowers a watermark", () => {
		const marks = { ch1: 9 };
		expect(ackChannels(marks, maxes, ["ch1"])).toBe(marks);
	});
});

describe("load/save round-trip", () => {
	it("persists through the kv slice under the module key", async () => {
		const kv = new Map<string, unknown>();
		const store = {
			get: <T>(key: string) => Promise.resolve((kv.get(key) as T) ?? null),
			put: (key: string, value: unknown) => {
				kv.set(key, value);
				return Promise.resolve();
			},
		};
		await saveWatermarks(store, { ch1: 3 });
		expect(kv.has(READ_WATERMARKS_KEY)).toBe(true);
		expect(await loadWatermarks(store)).toEqual({ ch1: 3 });
	});
});
