/**
 * Badge host (Stage 7.14) — `services.ui.badge.set/clear`.
 *
 * An app paints an ambient state cue on its OWN dashboard icon (Chat
 * unread, Mailbox inbox, Agent "response ready", Automations failed runs)
 * — an iOS-style corner chip visible without opening the app. Either a
 * numeric count or a plain dot. The shell owns rendering (the dashboard
 * icon-corner chip). Mirroring the vault-wide total onto the OS dock /
 * taskbar badge is a deferred follow-up — the OS badge is already owned by
 * the notification-unread mirror (`dashboard-handlers.updateNotificationBadge`),
 * so a single-owner reconciliation is needed before app badges join it.
 *
 * `BadgeHost` is **pure** (no Electron imports) so validation + the
 * per-app compose is unit-tested without a window: it stores one badge per
 * app, keyed by the broker-verified calling app id (never client-supplied,
 * so an app can only badge its own icon), recomputes a plain-data model,
 * and hands it to an injected `onChange`. The dashboard-renderer forward
 * lives in `main/index.ts`, mirroring how `tray-host` keeps Electron out of
 * the testable core.
 */

import type { BadgeSpec } from "@brainstorm-os/sdk-types";

/** Main→dashboard-renderer push carrying the composed per-app badge model
 *  (7.14). The preload redefines this string (channels can't cross the
 *  main/preload layering as an import), mirroring `apps:running-changed`. */
export const BADGES_CHANGED_CHANNEL = "ui:badges-changed" as const;

/** Defensive ceiling so a misbehaving app can't push an absurd number into
 *  the icon chip. Real unread/pending counts never approach this; the chip
 *  renders large counts as `99+` regardless. */
const MAX_COUNT = 9999;

/** The plain-data model the dashboard renderer receives — one entry per
 *  app currently badging, in first-seen order. `appId` is the
 *  broker-verified caller. */
export type ComposedBadge = { appId: string } & BadgeSpec;

export type BadgeChangeListener = (badges: ComposedBadge[]) => void;

export class BadgeHost {
	/** Insertion-ordered so the composed list is stable as apps badge. */
	private readonly byApp = new Map<string, BadgeSpec>();
	private onChange: BadgeChangeListener = () => undefined;

	setListener(listener: BadgeChangeListener): void {
		this.onChange = listener;
	}

	/** Set (or replace) an app's badge. A spec that normalizes to "no
	 *  badge" (`count <= 0`) clears it instead — `set({count: 0})` is the
	 *  idiomatic "nothing unread" call an app makes as state drains. */
	set(appId: string, raw: unknown): void {
		const spec = normalizeBadge(raw);
		if (spec === null) {
			this.clear(appId);
			return;
		}
		this.byApp.delete(appId); // re-set moves the app to the end (stable newest-last)
		this.byApp.set(appId, spec);
		this.emit();
	}

	clear(appId: string): void {
		if (this.byApp.delete(appId)) this.emit();
	}

	/** Drop every app's badge (e.g. on vault close) — the icons reset so a
	 *  new vault never inherits the previous one's counts. */
	reset(): void {
		if (this.byApp.size === 0) return;
		this.byApp.clear();
		this.emit();
	}

	/** Plain-data model for the renderer, one entry per badging app. */
	compose(): ComposedBadge[] {
		const out: ComposedBadge[] = [];
		for (const [appId, spec] of this.byApp) out.push({ appId, ...spec });
		return out;
	}

	private emit(): void {
		this.onChange(this.compose());
	}
}

/**
 * Validate + normalise the raw `badge.set` argument. Returns `null` when
 * the spec means "no badge" (a non-positive count — the drain-to-empty
 * call), a `BadgeSpec` otherwise. Throws `Invalid` (broker maps that to an
 * `Invalid` reply) on a malformed payload: the argument must be an object
 * with either `dot: true` or a finite numeric `count`.
 */
export function normalizeBadge(raw: unknown): BadgeSpec | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw invalid("ui.badge.set: argument must be an object");
	}
	const r = raw as Record<string, unknown>;
	if (r.dot === true) return { dot: true };
	if (typeof r.count === "number") {
		if (!Number.isFinite(r.count)) {
			throw invalid("ui.badge.set: { count } must be a finite number");
		}
		const count = Math.floor(r.count);
		if (count <= 0) return null; // non-positive ⇒ clear
		return { count: Math.min(count, MAX_COUNT) };
	}
	throw invalid("ui.badge.set: expected { count: number } or { dot: true }");
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

// ─── Module singleton (mirrors getTrayHost) ─────────────────────────────────

let host: BadgeHost | null = null;

export function getBadgeHost(): BadgeHost {
	if (!host) host = new BadgeHost();
	return host;
}

export function resetBadgeHost(): void {
	host = null;
}
