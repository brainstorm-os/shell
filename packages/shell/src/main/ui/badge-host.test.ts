import { describe, expect, it, vi } from "vitest";
import { BadgeHost, type ComposedBadge, normalizeBadge } from "./badge-host";

describe("normalizeBadge", () => {
	it("accepts a positive count and a dot", () => {
		expect(normalizeBadge({ count: 3 })).toEqual({ count: 3 });
		expect(normalizeBadge({ dot: true })).toEqual({ dot: true });
	});

	it("treats a non-positive count as a clear (null)", () => {
		expect(normalizeBadge({ count: 0 })).toBeNull();
		expect(normalizeBadge({ count: -5 })).toBeNull();
	});

	it("floors fractional counts and clamps to the ceiling", () => {
		expect(normalizeBadge({ count: 2.9 })).toEqual({ count: 2 });
		expect(normalizeBadge({ count: 1e9 })).toEqual({ count: 9999 });
	});

	it("prefers dot over count when both are present", () => {
		expect(normalizeBadge({ dot: true, count: 4 })).toEqual({ dot: true });
	});

	it("rejects malformed payloads", () => {
		expect(() => normalizeBadge(null)).toThrow(/must be an object/);
		expect(() => normalizeBadge([])).toThrow(/must be an object/);
		expect(() => normalizeBadge({})).toThrow(/count.*or.*dot/);
		expect(() => normalizeBadge({ count: Number.NaN })).toThrow(/finite/);
		expect(() => normalizeBadge({ count: "3" })).toThrow(/count.*or.*dot/);
	});

	it("throws an Invalid-named error the broker maps to Invalid", () => {
		try {
			normalizeBadge(null);
			expect.unreachable();
		} catch (err) {
			expect((err as Error).name).toBe("Invalid");
		}
	});
});

describe("BadgeHost", () => {
	function withListener(): { host: BadgeHost; last: () => ComposedBadge[]; calls: () => number } {
		const host = new BadgeHost();
		const spy = vi.fn<(b: ComposedBadge[]) => void>();
		host.setListener(spy);
		return {
			host,
			last: () => (spy.mock.calls.at(-1)?.[0] ?? []) as ComposedBadge[],
			calls: () => spy.mock.calls.length,
		};
	}

	it("composes one entry per badging app, in first-seen order", () => {
		const { host, last } = withListener();
		host.set("chat", { count: 2 });
		host.set("mailbox", { dot: true });
		expect(last()).toEqual([
			{ appId: "chat", count: 2 },
			{ appId: "mailbox", dot: true },
		]);
	});

	it("re-setting an app replaces its badge (and moves it newest-last)", () => {
		const { host, last } = withListener();
		host.set("chat", { count: 2 });
		host.set("mailbox", { count: 1 });
		host.set("chat", { count: 5 });
		expect(last()).toEqual([
			{ appId: "mailbox", count: 1 },
			{ appId: "chat", count: 5 },
		]);
	});

	it("a non-positive count clears the app's badge", () => {
		const { host, last } = withListener();
		host.set("chat", { count: 3 });
		host.set("chat", { count: 0 });
		expect(last()).toEqual([]);
	});

	it("clear() removes an app; a no-op clear does not re-emit", () => {
		const { host, last, calls } = withListener();
		host.set("chat", { count: 3 });
		const before = calls();
		host.clear("mailbox"); // not present → no emit
		expect(calls()).toBe(before);
		host.clear("chat");
		expect(last()).toEqual([]);
	});

	it("total() sums counts and ignores dots", () => {
		const { host } = withListener();
		host.set("chat", { count: 2 });
		host.set("mailbox", { count: 5 });
		host.set("agent", { dot: true });
		expect(host.total()).toBe(7);
	});

	it("reset() drops everything and emits once (no-op when already empty)", () => {
		const { host, last, calls } = withListener();
		host.set("chat", { count: 2 });
		const before = calls();
		host.reset();
		expect(last()).toEqual([]);
		expect(calls()).toBe(before + 1);
		host.reset(); // already empty → no emit
		expect(calls()).toBe(before + 1);
	});
});
