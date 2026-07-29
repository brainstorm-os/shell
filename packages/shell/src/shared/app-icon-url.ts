/**
 * `brainstorm://app-icon/<appId>` URL construction — one builder, used by the
 * preload bridge (`window.brainstorm.apps.iconUrl`, which apps and renderer
 * surfaces call) and by the dashboard's icon-src resolver.
 *
 * Pure (no Electron / React / DOM) so renderer + preload share it: an icon URL
 * is a string, not a privileged operation, and a renderer component shouldn't
 * need the whole preload bridge present just to name one.
 */

/** `?v=<version>` marks the bytes immutable for that version — the protocol
 *  handler caches versioned requests aggressively, so an app update re-fetches
 *  while a relaunch repaints from cache. Omit the version to stay `no-cache`. */
export function appIconUrl(appId: string, version?: string): string {
	const base = `brainstorm://app-icon/${encodeURIComponent(appId)}`;
	return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}
