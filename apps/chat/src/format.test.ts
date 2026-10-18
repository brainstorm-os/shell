import { describe, expect, it } from "vitest";
import { formatDay, formatStamp, formatTime } from "./format";

describe("chat time formatting (Chats-3)", () => {
	const now = new Date("2026-06-20T15:00:00.000Z");

	it("labels today / yesterday by default", () => {
		expect(formatDay("2026-06-20", false, now)).toBe("Today");
		expect(formatDay("2026-06-19", false, now)).toBe("Yesterday");
	});

	it("shows the full date instead with absolute timestamps", () => {
		const label = formatDay("2026-06-20", true, now);
		expect(label).not.toBe("Today");
		expect(label).toContain("2026");
	});

	it("adds the date to a message time with absolute timestamps", () => {
		const iso = "2026-06-20T10:05:00.000Z";
		expect(formatTime(iso)).not.toContain("2026");
		expect(formatTime(iso, true)).toBe(formatStamp(iso));
		expect(formatStamp(iso)).toContain("2026");
	});

	it("degrades unparseable stamps", () => {
		expect(formatTime("nope", true)).toBe("");
		expect(formatDay("nope", true)).toBe("nope");
	});
});
