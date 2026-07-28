/**
 * OS dock / taskbar badge — the ONE owner of `app.setBadgeCount` (7.14
 * follow-up). Two signals feed it: the unread notification count (the
 * original mirror in `dashboard-handlers`) and the vault-wide app-badge
 * total from `BadgeHost`. Before this, each would have called
 * `app.setBadgeCount` directly and fought over the dock number; now both
 * report here and the aggregator applies the composed sum, diffed so an
 * unchanged total never re-touches the dock.
 *
 * Pure (no Electron imports), mirroring `BadgeHost`: the Electron applier
 * is injected from `main/index.ts`. Signals reported before the applier is
 * wired are retained and applied the moment it lands, so startup ordering
 * between the dashboard-store subscribe and the badge-host listener can't
 * drop a count.
 *
 * Dot badges (`{ dot: true }`) contribute 0 — the dock badge is a number,
 * and a dot is by definition an uncountable "attention" cue; inventing a
 * phantom 1 would misstate what the app reported.
 */

import type { ComposedBadge } from "./badge-host";

export type OsBadgeApplier = (count: number) => void;

/** Sum of the countable app badges — the app-badge half of the dock total. */
export function appBadgeTotal(badges: readonly ComposedBadge[]): number {
	let total = 0;
	for (const badge of badges) {
		if ("count" in badge) total += badge.count;
	}
	return total;
}

export class OsBadgeAggregator {
	private notificationUnread = 0;
	private appTotal = 0;
	/** `null` = nothing applied yet, so the first apply always goes through. */
	private lastApplied: number | null = null;
	private applier: OsBadgeApplier | null = null;

	/** Inject the Electron-side setter. Re-applies the current composed total
	 *  immediately so signals reported before wiring aren't lost. */
	setApplier(applier: OsBadgeApplier): void {
		this.applier = applier;
		this.lastApplied = null;
		this.apply();
	}

	setNotificationUnread(count: number): void {
		this.notificationUnread = Math.max(0, count);
		this.apply();
	}

	setAppBadges(badges: readonly ComposedBadge[]): void {
		this.appTotal = appBadgeTotal(badges);
		this.apply();
	}

	private apply(): void {
		if (!this.applier) return;
		const next = this.notificationUnread + this.appTotal;
		if (next === this.lastApplied) return;
		this.lastApplied = next;
		this.applier(next);
	}
}

// ─── Module singleton (mirrors getBadgeHost) ────────────────────────────────

let aggregator: OsBadgeAggregator | null = null;

export function getOsBadgeAggregator(): OsBadgeAggregator {
	if (!aggregator) aggregator = new OsBadgeAggregator();
	return aggregator;
}

export function resetOsBadgeAggregator(): void {
	aggregator = null;
}
