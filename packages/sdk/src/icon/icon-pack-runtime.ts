/**
 * `IconPack/v1` render-application (Stage 8.6). The built-in Phosphor
 * glyphs (`<Icon>` / `createIconElement` / `ICON_GLYPHS`) are the BASE;
 * an installed `brainstorm/IconPack/v1` overrides individual canonical
 * names on top — the same base/override layering Typography uses (8.7).
 *
 * The active pack is process-global and starts `null`, so with no pack
 * installed every renderer behaves exactly as before (zero regression);
 * a marketplace/theme IconPack calls `setActiveIconPack` and every
 * `<Icon>` / `useIcon` re-resolves. Overrides are memoised behind an
 * epoch that bumps on every pack swap (the "resolver-cache").
 *
 * An IconPack glyph's `svg` is inner markup on the shared 256 grid
 * (same convention as the generated `ICON_GLYPHS`), so an override drops
 * straight into the `viewBox="0 0 256 256"` wrapper both renderers use.
 */

import { type IconPackDef, resolveIconSvg } from "@brainstorm-os/sdk-types";

let activePack: IconPackDef | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
/** `${epoch}|${name}` → resolved override markup, or `null` when the
 *  active pack (if any) doesn't supply that name. Cleared on every swap;
 *  the epoch in the key makes a stale entry unreachable even if a clear
 *  is ever missed. */
const cache = new Map<string, string | null>();

/** Install (or clear, with `null`) the process-wide icon pack. Bumps
 *  the epoch, drops the cache, and notifies subscribers so live `<Icon>`
 *  / `useIcon` consumers re-resolve. */
export function setActiveIconPack(pack: IconPackDef | null): void {
	activePack = pack;
	epoch++;
	cache.clear();
	for (const fn of listeners) fn();
}

export function getActiveIconPack(): IconPackDef | null {
	return activePack;
}

/** Subscribe to pack swaps (for `useSyncExternalStore`). Returns an
 *  unsubscribe. */
export function subscribeIconPack(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

/** Monotonic snapshot id — changes iff the active pack changed. */
export function getIconPackEpoch(): number {
	return epoch;
}

/**
 * The override glyph markup for a canonical icon `name`, or `null` to
 * fall through to the built-in Phosphor glyph. Memoised per epoch.
 * Tolerates loosely-typed pack data via the contract's `resolveIconSvg`
 * (direct hit → pack `fallback` → null).
 */
export function resolveIconOverride(name: string): string | null {
	if (!activePack) return null;
	const key = `${epoch}|${name}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const resolved = resolveIconSvg(activePack, name);
	cache.set(key, resolved);
	return resolved;
}
