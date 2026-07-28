/**
 * 7.14 follow-up — the OS dock/taskbar badge single owner. The aggregator
 * composes `notification unread + app-badge total` into ONE
 * `app.setBadgeCount` stream: diffed, order-independent of applier wiring,
 * and reset-safe on vault switch (the BadgeHost emits an empty composed
 * model, which must drop the app half without touching the unread half).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { OsBadgeAggregator, appBadgeTotal } from "./os-badge";

describe("appBadgeTotal", () => {
	it("sums numeric counts", () => {
		expect(
			appBadgeTotal([
				{ appId: "a", count: 3 },
				{ appId: "b", count: 2 },
			]),
		).toBe(5);
	});

	it("ignores dot badges — a dot is an uncountable cue, not a phantom 1", () => {
		expect(
			appBadgeTotal([
				{ appId: "a", count: 3 },
				{ appId: "b", dot: true },
			]),
		).toBe(3);
	});

	it("is 0 for the empty model", () => {
		expect(appBadgeTotal([])).toBe(0);
	});
});

describe("OsBadgeAggregator", () => {
	let applied: number[];
	let aggregator: OsBadgeAggregator;

	beforeEach(() => {
		applied = [];
		aggregator = new OsBadgeAggregator();
	});

	it("composes unread + app total into one setter stream", () => {
		aggregator.setApplier((n) => applied.push(n));
		aggregator.setNotificationUnread(2);
		aggregator.setAppBadges([{ appId: "mail", count: 3 }]);
		expect(applied).toEqual([0, 2, 5]);
	});

	it("diffs — an unchanged composed total never re-applies", () => {
		aggregator.setApplier((n) => applied.push(n));
		aggregator.setNotificationUnread(2);
		aggregator.setNotificationUnread(2);
		aggregator.setAppBadges([]);
		expect(applied).toEqual([0, 2]);
	});

	it("retains signals reported before the applier is wired (startup ordering)", () => {
		aggregator.setNotificationUnread(1);
		aggregator.setAppBadges([
			{ appId: "chat", count: 4 },
			{ appId: "agent", dot: true },
		]);
		expect(applied).toEqual([]);
		aggregator.setApplier((n) => applied.push(n));
		expect(applied).toEqual([5]);
	});

	it("vault switch: the BadgeHost's empty composed model drops only the app half", () => {
		aggregator.setApplier((n) => applied.push(n));
		aggregator.setNotificationUnread(2);
		aggregator.setAppBadges([{ appId: "mail", count: 7 }]);
		// `BadgeHost.reset()` on vault change emits `[]` through its listener.
		aggregator.setAppBadges([]);
		expect(applied).toEqual([0, 2, 9, 2]);
	});

	it("clamps a negative unread report to 0", () => {
		aggregator.setApplier((n) => applied.push(n));
		aggregator.setNotificationUnread(-3);
		expect(applied).toEqual([0]);
	});
});
