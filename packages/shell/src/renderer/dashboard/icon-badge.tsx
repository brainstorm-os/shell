/**
 * 7.14 — the app notification badge chip, shared between every dashboard
 * surface that shows an app tile (the icon grid and the running-windows
 * strip). ONE component + ONE subscription hook + ONE aria composer, so the
 * chip's visuals, push wiring, and screen-reader phrasing can't fork.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { BadgeUpdate } from "../../preload";
import { t } from "../i18n/t";

/** Subscribe to the main-process per-app badge pushes. Push-only: main
 *  re-emits on every set/clear and resets on vault change, so the map tracks
 *  live state. Tolerant of a missing bridge (component tests without the
 *  preload) — the map just stays empty. */
export function useAppBadges(): Map<string, BadgeUpdate> {
	const [badges, setBadges] = useState<Map<string, BadgeUpdate>>(new Map());
	useEffect(() => {
		const subscribe = window.brainstorm?.apps?.onBadgesChanged;
		if (!subscribe) return;
		const off = subscribe((entries) => {
			setBadges(new Map(entries.map((entry) => [entry.appId, entry])));
		});
		return off;
	}, []);
	return badges;
}

/** The badged tile's accessible name — folds the count (or the dot's
 *  "attention" phrasing) into the app's name so a screen-reader user reads
 *  "Mailbox: 3 notifications" on demand when tabbing to the tile (the visual
 *  chip is aria-hidden). `undefined` when unbadged, so the caller falls back
 *  to its normal label. */
export function badgeAriaLabel(
	badge: BadgeUpdate | undefined,
	appLabel: string,
): string | undefined {
	if (!badge) return undefined;
	return "count" in badge
		? t("shell.dashboard.badge.count", { app: appLabel, count: badge.count })
		: t("shell.dashboard.badge.dot", { app: appLabel });
}

/**
 * The notification badge chip an app paints on its dashboard tile: a numeric
 * count (capped `99+`) or a plain dot ("attention, no number"). Purely
 * **visual** (`aria-hidden`) — the accessible name lives on the parent tile
 * button's `aria-label` (composed via {@link badgeAriaLabel}), so a
 * screen-reader reads "Mailbox, 3 notifications" as one name on demand
 * rather than a stray `role="status"` live region per tile.
 */
export function IconBadge({ badge }: { badge: BadgeUpdate | undefined }): ReactElement | null {
	if (!badge) return null;
	if ("dot" in badge) {
		return <span className="dashboard-icons__badge dashboard-icons__badge--dot" aria-hidden="true" />;
	}
	return (
		<span className="dashboard-icons__badge" aria-hidden="true">
			{badge.count > 99 ? "99+" : String(badge.count)}
		</span>
	);
}
