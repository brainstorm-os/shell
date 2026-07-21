/**
 * Peer presence — the pure core of remote-cursor collaboration overlays.
 * Extracted from `@brainstorm-os/editor` at copy two (the Whiteboard presence
 * overlay, 9.17.19, is the second consumer; the editor module now
 * delegates here). A presence renderer draws a remote peer's caret /
 * cursor + name label from the `{ name, color }` each client publishes
 * into the awareness channel; this module decides what a local client
 * publishes: a deterministic, legible colour per client and a bounded,
 * hardened display name.
 *
 * Colours are literal hex strings, not design tokens, on purpose: cursor
 * renderers (`@lexical/yjs`'s `syncCursorPositions`, the whiteboard
 * overlay) write `color` straight into inline styles, so a `var(--…)`
 * reference would paint nothing. The palette is hand-picked to read
 * against both light and dark surfaces.
 */

import { sanitizeInlineText } from "./sanitize-text";

/** Distinct caret hues, assigned per peer. Order is the assignment cycle. */
export const PEER_COLORS: readonly string[] = [
	"#2f6df6", // blue
	"#e8590c", // orange
	"#2f9e44", // green
	"#d6336c", // pink
	"#7048e8", // violet
	"#0c8599", // teal
	"#e67700", // amber
	"#c2255c", // magenta
];

/** Upper bound on a published display name (the label sits next to a caret). */
export const PEER_NAME_MAX_LEN = 40;

/**
 * The caret colour for a peer, stable for a given `seed` (use the Yjs
 * `doc.clientID`). Wraps the palette modulo its length and is sign-safe so
 * a large or negative client id still lands on a real hue.
 */
export function peerColor(seed: number): string {
	const n = PEER_COLORS.length;
	const idx = ((Math.trunc(seed) % n) + n) % n;
	// `idx` is always in [0, n) by construction.
	return PEER_COLORS[idx] as string;
}

/**
 * Sanitize a user-supplied display name before publishing it to peers:
 * the shared inline-text hardening (`@brainstorm-os/sdk/sanitize-text` —
 * control / zero-width / bidi-override strip, whitespace collapse, clamp to
 * {@link PEER_NAME_MAX_LEN}), falling back to `fallback` when the result is
 * empty or the input was not a usable string.
 */
export function sanitizePeerName(raw: unknown, fallback: string): string {
	const cleaned = sanitizeInlineText(raw, PEER_NAME_MAX_LEN);
	return cleaned.length === 0 ? fallback : cleaned;
}

/** Renderer-local display-name preference key. Each app renderer is its own
 *  origin, so the value is per-app; identity-backed naming is the documented
 *  follow-up (there is no vault-identity display-name channel yet). */
const DISPLAY_NAME_KEY = "brainstorm:presence-name";
const DEFAULT_DISPLAY_NAME = "Anonymous";

/** The bounded, hardened display name this client publishes to peers and
 *  stamps on comments it authors. */
export function localPresenceName(): string {
	let stored: string | null = null;
	try {
		stored = globalThis.localStorage?.getItem(DISPLAY_NAME_KEY) ?? null;
	} catch {
		stored = null;
	}
	return sanitizePeerName(stored, DEFAULT_DISPLAY_NAME);
}

/** The `{ name, color }` presence payload for a doc, colour keyed by the
 *  Y.Doc client id so a peer keeps one colour per session. */
export function localPresence(clientId: number): { name: string; color: string } {
	return { name: localPresenceName(), color: peerColor(clientId) };
}
