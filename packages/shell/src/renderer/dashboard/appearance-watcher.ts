/**
 * The renderer's reading of "does the OS want dark right now" — for Auto mode.
 *
 * **Main is the only authority.** It resolves Auto from Electron's
 * `nativeTheme.shouldUseDarkColors` and ships that reading with every dashboard
 * snapshot as `systemPrefersDark`. `useOsPrefersDark` returns it, so the
 * dashboard resolves the same slot main resolved, the same way the app windows
 * and tab strips do (they are simply told the theme name).
 *
 * The renderer's own `matchMedia("(prefers-color-scheme: dark)")` is a FALLBACK
 * ONLY — for the tick before the first snapshot lands, and for a main process
 * too old to send the field. It is not a second opinion:
 *
 *   F-495 — the owner reported a broken light/dark switch four times. Probe 940
 *   measured the two readings disagreeing inside the running shell: `main
 *   shouldUseDarkColors=true` while the dashboard renderer's `matchMedia` said
 *   `false` — and again while the dashboard was already painted
 *   `[data-theme=default-dark]`. Whenever they disagreed in Auto, the dashboard
 *   painted the wrong slot while every app window painted the right one, and
 *   nothing converged: main only broadcasts when the theme IT computed changes,
 *   so the correcting push looks redundant and never goes out. Two authorities
 *   for one decision is the bug; a poll would only have hidden it.
 *
 * SSR / non-browser contexts (tests under Bun): `matchMedia` is absent; the
 * fallback reads `false` (light) so the helper is safe to import.
 */

import { useEffect, useState } from "react";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Fallback reading. Module-private ON PURPOSE: `useOsPrefersDark` is the only
 *  way in, so no surface can quietly go back to holding a second opinion. */
function systemPrefersDark(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	return window.matchMedia(DARK_QUERY).matches;
}

function onSystemPreferenceChange(listener: (prefersDark: boolean) => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return () => undefined;
	}
	const mql = window.matchMedia(DARK_QUERY);
	const handler = (event: MediaQueryListEvent) => listener(event.matches);
	mql.addEventListener("change", handler);
	return () => mql.removeEventListener("change", handler);
}

/**
 * The authoritative OS dark reading for a dashboard-snapshot consumer: main's,
 * when it has sent one; the local `matchMedia` until then.
 *
 * Every renderer surface that resolves an Auto slot — the `:root` theme, the
 * header appearance toggle, the Settings → Appearance active-pair badge —
 * reads it here, so they can never disagree with each other or with main.
 */
export function useOsPrefersDark(
	snapshot: { systemPrefersDark?: boolean } | null | undefined,
): boolean {
	const [fallback, setFallback] = useState<boolean>(() => systemPrefersDark());
	useEffect(() => onSystemPreferenceChange(setFallback), []);
	return snapshot?.systemPrefersDark ?? fallback;
}
