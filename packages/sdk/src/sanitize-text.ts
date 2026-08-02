/**
 * Shared hardening for untrusted single-line text — page-supplied web titles
 * the Browser clips into the vault, peer-supplied display names the editor
 * publishes to collaborators. Extracted from `@brainstorm-os/editor`'s
 * peer-presence sanitizer at copy two (the Browser clip-to-vault path is the
 * second consumer); `sanitizePeerName` now delegates here.
 *
 * Security invariant: the stripped set is the spoofing/smuggling alphabet —
 * C0/C1 controls + DEL, zero-width characters (ZWSP/ZWNJ/ZWJ), bidi-override
 * marks, and the BOM. Stripping is done by codepoint rather than a character
 * class so a regex never embeds a joiner (which the misleading-character-class
 * lint — rightly — rejects).
 *
 * This module also owns the MULTI-LINE variant of the same alphabet
 * (`hasUnsafeBodyChars`) so both screens are read off one table.
 */

function isStrippedChar(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0x200b && code <= 0x200d) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069) ||
		code === 0xfeff
	);
}

/**
 * Coerce to string, strip control / zero-width / bidi-override characters,
 * collapse whitespace runs, trim, and clamp to `maxLength` code units.
 * Returns `""` when the input was not a usable string or nothing survives —
 * callers supply their own fallback.
 */
export function sanitizeInlineText(raw: unknown, maxLength: number): string {
	if (typeof raw !== "string") return "";
	let stripped = "";
	for (const ch of raw) {
		if (!isStrippedChar(ch.codePointAt(0) ?? 0)) stripped += ch;
	}
	return stripped.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** The multi-line counterpart of `isStrippedChar`.
 *
 * A body a human is about to APPROVE cannot be sanitized — silently altering
 * the bytes is the same failure as truncating them — so its caller refuses the
 * whole payload instead. The set is therefore narrower than the single-line
 * one on both ends: newline and tab are legitimate body structure, and
 * zero-width joiners are legitimate emoji sequences, while a bidi override or
 * an isolate makes the RENDERED text differ from the bytes that get written.
 */
function isUnsafeBodyChar(code: number): boolean {
	if (code === 0x09 || code === 0x0a) return false;
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}

export function hasUnsafeBodyChars(value: string): boolean {
	for (const ch of value) {
		if (isUnsafeBodyChar(ch.codePointAt(0) ?? 0)) return true;
	}
	return false;
}
