/**
 * Persistent record of which installed apps ship an icon asset, and at what
 * version. The dashboard icon layer unmounts while the vault is locked, so its
 * component state can't survive a lock→unlock — without this the first paint
 * after a PIN unlock flashes initials placeholders for every app while
 * `apps.listInstalled()` round-trips. A module-scope map, mirrored to
 * localStorage (same pattern as the wallpaper cache), lets that first paint
 * resolve real icon `src`s immediately. The stored version keys the
 * cache-busting `?v=` query on the icon URL so an app update re-fetches its art
 * (the protocol handler serves versioned requests `immutable`).
 */

import { appIconUrl } from "../../shared/app-icon-url";

export const APP_ICON_CACHE_KEY = "brainstorm.dashboard.app-icons.v1";

// `null` until the first authoritative `apps.listInstalled()` of a fresh
// install (with nothing persisted). While null the caller renders icons
// optimistically rather than suppressing them.
let versions: Map<string, string> | null = loadFromStorage();

function loadFromStorage(): Map<string, string> | null {
	try {
		const raw = window.localStorage.getItem(APP_ICON_CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const map = new Map<string, string>();
		for (const [id, version] of Object.entries(parsed)) {
			if (typeof version === "string") map.set(id, version);
		}
		return map;
	} catch {
		return null;
	}
}

/** True once we hold an authoritative has-icon map (this session or persisted
 *  from a prior one). Before that, app icons render optimistically. */
export function appIconsKnown(): boolean {
	return versions !== null;
}

export function appHasIcon(appId: string): boolean {
	return versions?.has(appId) ?? false;
}

export function appIconVersion(appId: string): string | undefined {
	return versions?.get(appId);
}

/** Replace the cache from a fresh installed-apps list. Returns true when the
 *  cache actually changed, so the caller can skip a re-render when it didn't. */
export function setAppIcons(
	list: ReadonlyArray<{ id: string; hasIcon: boolean; version: string }>,
): boolean {
	const next = new Map<string, string>();
	for (const app of list) if (app.hasIcon) next.set(app.id, app.version);
	if (versions !== null && sameMap(versions, next)) return false;
	versions = next;
	try {
		window.localStorage.setItem(APP_ICON_CACHE_KEY, JSON.stringify(Object.fromEntries(next)));
	} catch {
		// Persisting is best-effort; the in-memory map still helps this session.
	}
	return true;
}

function sameMap(a: Map<string, string>, b: Map<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of a) if (b.get(key) !== value) return false;
	return true;
}

/**
 * Resolve the `src` for an app squircle — the ONE place a renderer surface
 * turns an app id into an icon URL. Returns a versioned (cacheable) URL for a
 * known-iconed app, `null` for a known-iconless one (so no wasted request),
 * and an optimistic unversioned URL while the cache is still cold — the
 * AppIcon's gradient+initials paint behind it, so an optimistic miss degrades
 * to the placeholder rather than a broken tile.
 *
 * Hand-built `brainstorm://app-icon/<id>` URLs are what made the running
 * strip, the window switcher and the widget headers each fire their own 404
 * for an app that ships no artwork (POLISH-LAY-8) — they all come through
 * here now.
 *
 * `epoch` (optional) appends the caller's apps-changed counter so a load that
 * raced an (re)install retries on the next edge instead of pinning the
 * initials fallback for the session (F-380 / POLISH-LAY-3).
 */
export function resolveAppIconSrc(appId: string, epoch?: number): string | null {
	if (appIconsKnown() && !appHasIcon(appId)) return null;
	const base = appIconUrl(appId, appIconVersion(appId));
	if (epoch === undefined) return base;
	return `${base}${base.includes("?") ? "&" : "?"}e=${epoch}`;
}
