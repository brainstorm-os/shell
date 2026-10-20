import { describe, expect, it } from "vitest";
import type { EntityLike } from "./chat";
import {
	DEFAULT_PREFS,
	EMPTY_USER_STATE,
	USER_STATE_TYPE,
	buildUserStateProperties,
	isOwnUserStateRow,
	maxMergeWatermarks,
	readUserState,
} from "./user-state";

const row = (id: string, properties: Record<string, unknown>): EntityLike => ({
	id,
	type: USER_STATE_TYPE,
	properties,
});

describe("maxMergeWatermarks", () => {
	it("takes the per-channel max", () => {
		expect(maxMergeWatermarks({ a: 3, b: 1 }, { a: 2, b: 5, c: 0 })).toEqual({ a: 3, b: 5, c: 0 });
	});

	it("returns the same reference when nothing is raised", () => {
		const a = { a: 3 };
		expect(maxMergeWatermarks(a, { a: 1 })).toBe(a);
		expect(maxMergeWatermarks(a, {})).toBe(a);
	});
});

describe("readUserState", () => {
	it("is empty for an unknown owner or no owner yet", () => {
		const rows = [row("u1", { owner: "pk-a", watermarks: { c: 1 } })];
		expect(readUserState(rows, "pk-b")).toBe(EMPTY_USER_STATE);
		expect(readUserState(rows, "")).toBe(EMPTY_USER_STATE);
	});

	it("merges duplicate rows from two devices: max watermarks, newest prefs, lowest id wins writes", () => {
		const state = readUserState(
			[
				row("u2", {
					owner: "pk-a",
					watermarks: { c1: 4, c2: 1 },
					prefs: { absoluteTimestamps: true },
					updatedAt: "2026-06-20T10:00:00.000Z",
				}),
				row("u1", {
					owner: "pk-a",
					watermarks: { c1: 2, c2: 7, junk: "x" },
					prefs: { absoluteTimestamps: false },
					updatedAt: "2026-06-20T09:00:00.000Z",
				}),
				row("u0", { owner: "pk-other", watermarks: { c1: 99 } }),
				{ id: "n1", type: "other/Type/v1", properties: { owner: "pk-a", watermarks: { c1: 50 } } },
			],
			"pk-a",
		);
		expect(state.primaryId).toBe("u1");
		expect(state.watermarks).toEqual({ c1: 4, c2: 7 });
		expect(state.prefs).toEqual({ absoluteTimestamps: true });
	});

	it("drops rows the caller does not own, even with a matching owner and a lower id", () => {
		const rows = [
			row("u0", { owner: "pk-a", watermarks: { c: 9 } }),
			row("u1", { owner: "pk-a", watermarks: { c: 1 } }),
		];
		const state = readUserState(rows, "pk-a", (id) => id !== "u0");
		expect(state.primaryId).toBe("u1");
		expect(state.watermarks).toEqual({ c: 1 });
		expect(isOwnUserStateRow([])).toBe(true);
		expect(isOwnUserStateRow([{ isSelf: true }, { isSelf: false }])).toBe(false);
	});

	it("defaults malformed prefs", () => {
		const state = readUserState([row("u1", { owner: "pk-a", prefs: "nope" })], "pk-a");
		expect(state.prefs).toEqual(DEFAULT_PREFS);
	});
});

describe("buildUserStateProperties", () => {
	it("copies the inputs into the wire shape", () => {
		const marks = { c1: 1 };
		const props = buildUserStateProperties({
			owner: "pk-a",
			watermarks: marks,
			prefs: DEFAULT_PREFS,
			updatedAt: "t",
		});
		expect(props).toEqual({
			owner: "pk-a",
			watermarks: { c1: 1 },
			prefs: DEFAULT_PREFS,
			updatedAt: "t",
		});
		expect(props.watermarks).not.toBe(marks);
	});
});
