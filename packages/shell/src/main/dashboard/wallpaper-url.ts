/**
 * The one guard that decides whether a stored wallpaper may be painted into an
 * app renderer's header stripe, and under what URL.
 *
 * Two call sites need the identical answer — the launch path (which stamps it
 * into `--brainstorm-wallpaper=` at window create) and the live broadcast
 * (`app:wallpaper-changed`). A second copy of the origin check is how that
 * check rots: the day one side learns a new scheme and the other doesn't, a
 * hand-edited vault doc can push an arbitrary origin into every sandboxed app.
 */

import { type Wallpaper, WallpaperKind } from "./dashboard-store";

/** The only origin an app-header wallpaper may be served from — the vault's
 *  own custom protocol (see `main/assets/serve-media.ts`). */
export const WALLPAPER_URL_PREFIX = "brainstorm://wallpaper/";

/**
 * Resolve the active wallpaper to the URL an app renderer should paint, or
 * `null` when it should paint nothing.
 *
 * `null` is a VALUE, not "no news": solid and gradient wallpapers are already
 * what the header's glass renders, so a switch away from an image has to
 * *clear* the stripe. Callers must forward the `null` rather than skip.
 */
export function wallpaperImageUrl(wallpaper: Wallpaper | null | undefined): string | null {
	if (!wallpaper || wallpaper.kind !== WallpaperKind.Image) return null;
	const value = wallpaper.value;
	if (typeof value !== "string" || !value.startsWith(WALLPAPER_URL_PREFIX)) return null;
	return value;
}
