import { describe, expect, it } from "vitest";
import {
	DEFAULT_SELECTIVE_SYNC_POLICY,
	MAX_RECENT_DAYS,
	MIN_RECENT_DAYS,
	SelectiveSyncMode,
	clampRecentDays,
	entityMatchesPolicy,
	normalizeSelectiveSyncPolicy,
	toSelectiveSyncMode,
} from "./selective-sync-types";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("selective-sync policy", () => {
	it("defaults to Everything (desktop default)", () => {
		expect(DEFAULT_SELECTIVE_SYNC_POLICY.mode).toBe(SelectiveSyncMode.Everything);
	});

	it("toSelectiveSyncMode validates + falls back to Everything", () => {
		expect(toSelectiveSyncMode("pinned")).toBe(SelectiveSyncMode.Pinned);
		expect(toSelectiveSyncMode("pinned-plus-recent")).toBe(SelectiveSyncMode.PinnedPlusRecent);
		expect(toSelectiveSyncMode("garbage")).toBe(SelectiveSyncMode.Everything);
		expect(toSelectiveSyncMode(undefined)).toBe(SelectiveSyncMode.Everything);
	});

	it("clampRecentDays clamps to [MIN, MAX] and floors", () => {
		expect(clampRecentDays(30)).toBe(30);
		expect(clampRecentDays(0)).toBe(MIN_RECENT_DAYS);
		expect(clampRecentDays(99999)).toBe(MAX_RECENT_DAYS);
		expect(clampRecentDays(7.9)).toBe(7);
		expect(clampRecentDays("nope")).toBe(DEFAULT_SELECTIVE_SYNC_POLICY.recentDays);
	});

	it("normalizeSelectiveSyncPolicy repairs partial/garbage input", () => {
		expect(normalizeSelectiveSyncPolicy(null)).toEqual(DEFAULT_SELECTIVE_SYNC_POLICY);
		expect(normalizeSelectiveSyncPolicy({ mode: "pinned", recentDays: 0 })).toEqual({
			mode: SelectiveSyncMode.Pinned,
			recentDays: MIN_RECENT_DAYS,
		});
	});

	describe("entityMatchesPolicy", () => {
		it("Everything admits any entity", () => {
			const p = { mode: SelectiveSyncMode.Everything, recentDays: 30 };
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: null }, NOW)).toBe(true);
		});

		it("Pinned admits only pinned entities", () => {
			const p = { mode: SelectiveSyncMode.Pinned, recentDays: 30 };
			expect(entityMatchesPolicy(p, { pinned: true, lastActiveMs: null }, NOW)).toBe(true);
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: NOW }, NOW)).toBe(false);
		});

		it("PinnedPlusRecent admits pinned OR active within the window", () => {
			const p = { mode: SelectiveSyncMode.PinnedPlusRecent, recentDays: 30 };
			// Pinned always.
			expect(entityMatchesPolicy(p, { pinned: true, lastActiveMs: null }, NOW)).toBe(true);
			// Active 10 days ago → in window.
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: NOW - 10 * DAY }, NOW)).toBe(true);
			// Active 31 days ago → out of window.
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: NOW - 31 * DAY }, NOW)).toBe(false);
			// Unknown last-active, not pinned → excluded.
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: null }, NOW)).toBe(false);
		});

		it("PinnedPlusRecent boundary is inclusive at exactly N days", () => {
			const p = { mode: SelectiveSyncMode.PinnedPlusRecent, recentDays: 30 };
			expect(entityMatchesPolicy(p, { pinned: false, lastActiveMs: NOW - 30 * DAY }, NOW)).toBe(true);
		});
	});
});
