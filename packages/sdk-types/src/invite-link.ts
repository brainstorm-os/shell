/**
 * Collab-C7 — the `brainstorm://invite/<token>` deep link that wraps an invite
 * code (the base64url `ShareInviteToken` the share dialog already mints).
 *
 * The link is a TRANSPORT for the existing code, nothing more: opening one only
 * pre-fills the owner's share dialog, where they still choose a role and press
 * Add. It never accepts, grants or contacts anyone by itself.
 *
 * Parsing is strict because the URL arrives from outside the app (any web page
 * or mail client can open a `brainstorm://` link): exactly the prefix, then one
 * base64url segment of bounded length — no query, fragment, extra path, percent
 * escapes or whitespace. Anything else is refused (null), never repaired.
 */

export const INVITE_LINK_PREFIX = "brainstorm://invite/";

/** Bounds on the token segment. A real invite is a few hundred characters;
 *  the ceiling stops an oversized link from reaching the decoder. */
export const INVITE_TOKEN_MIN_LENGTH = 16;
export const INVITE_TOKEN_MAX_LENGTH = 4096;

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export function isInviteTokenShape(token: unknown): token is string {
	return (
		typeof token === "string" &&
		token.length >= INVITE_TOKEN_MIN_LENGTH &&
		token.length <= INVITE_TOKEN_MAX_LENGTH &&
		TOKEN_RE.test(token)
	);
}

/** The link for an invite token (the share dialog's "Copy link"). */
export function inviteLinkFor(token: string): string {
	return `${INVITE_LINK_PREFIX}${token}`;
}

/** The token inside a `brainstorm://invite/<token>` URL, or null for anything
 *  that is not exactly that shape. */
export function parseInviteLink(url: unknown): string | null {
	if (typeof url !== "string" || !url.startsWith(INVITE_LINK_PREFIX)) return null;
	const token = url.slice(INVITE_LINK_PREFIX.length);
	return isInviteTokenShape(token) ? token : null;
}

/** What the share dialog's code field should hold for pasted text: the token
 *  from a pasted link, else the trimmed text as typed (a raw code). */
export function inviteTokenFromInput(text: string): string {
	const trimmed = text.trim();
	return parseInviteLink(trimmed) ?? trimmed;
}
