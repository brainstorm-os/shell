import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDay, formatStamp, formatTime } from "./format";
import { dayKey } from "./logic/chat";

describe("chat time formatting (Chats-3)", () => {
	const now = new Date(2026, 5, 20, 15, 0, 0);

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

describe("day divider agrees with the displayed time", () => {
	const savedTz = process.env.TZ;
	afterAll(() => {
		if (savedTz === undefined) Reflect.deleteProperty(process.env, "TZ");
		else process.env.TZ = savedTz;
	});

	describe.each(["Europe/Berlin", "America/Los_Angeles", "Pacific/Auckland"])("in %s", (tz) => {
		beforeAll(() => {
			process.env.TZ = tz;
		});

		it("labels the divider with the same local date the timestamp shows", () => {
			for (const iso of ["2026-08-01T22:53:00.000Z", "2026-08-02T06:30:00.000Z"]) {
				const local = new Date(iso);
				const expected = local.toLocaleDateString("en", {
					weekday: "long",
					year: "numeric",
					month: "short",
					day: "numeric",
				});
				expect(formatDay(dayKey(iso), true, local)).toBe(expected);
			}
		});

		it("calls a message sent just after local midnight Today, not Yesterday", () => {
			const iso = "2026-08-01T22:53:00.000Z";
			const now = new Date(Date.parse(iso) + 60_000);
			expect(formatDay(dayKey(iso), false, now)).toBe("Today");
			expect(formatDay(dayKey("2026-07-31T22:53:00.000Z"), false, now)).toBe("Yesterday");
		});
	});
});
