/**
 * New-file naming (9.7.5). Picks a collision-free `untitled*.ts` path
 * against the existing files so the in-app "New file" action never clobbers
 * one. Pure (no DOM / no service); the app wires the create call.
 */

import { sanitizeInlineText } from "@brainstorm-os/sdk/sanitize-text";

const BASE = "untitled";
const EXT = "ts";

/** Upper bound on a rename label. The typed name flows into the sidebar row
 *  and the window title, so an unbounded paste (or one carrying control /
 *  bidi-override / zero-width spoofing characters) is clamped + stripped
 *  before it reaches that chrome — `sanitizeInlineText` does both. */
const MAX_RENAME_LENGTH = 200;

/** A path not already taken: `untitled.ts`, then `untitled-2.ts`, … */
export function nextUntitledPath(existingPaths: readonly string[]): string {
	const taken = new Set(existingPaths.map((p) => p.toLowerCase()));
	const first = `${BASE}.${EXT}`;
	if (!taken.has(first)) return first;
	for (let n = 2; n < 10_000; n++) {
		const candidate = `${BASE}-${n}.${EXT}`;
		if (!taken.has(candidate)) return candidate;
	}
	// Pathological fallback — effectively unreachable.
	return `${BASE}-${existingPaths.length + 1}.${EXT}`;
}

/** Why a proposed rename was rejected (F-238). The app maps each to a
 *  localised message; centralised so the literal isn't re-typed. */
export enum RenameError {
	Empty = "empty",
	Duplicate = "duplicate",
}

export type RenameResult = { ok: true; path: string } | { ok: false; reason: RenameError };

/** Validate a user-typed rename for the file at `currentPath` against the
 *  other files' `existingPaths`. Pure (no DOM / no service): trims, rejects
 *  an empty name, and rejects a case-insensitive collision with a DIFFERENT
 *  file (renaming to the same path, or to a different-cased spelling of the
 *  current one, is allowed). */
export function validateRenamePath(
	input: string,
	currentPath: string,
	existingPaths: readonly string[],
): RenameResult {
	const path = sanitizeInlineText(input, MAX_RENAME_LENGTH);
	if (path.length === 0) return { ok: false, reason: RenameError.Empty };
	const lower = path.toLowerCase();
	const collides = existingPaths.some((p) => p !== currentPath && p.toLowerCase() === lower);
	if (collides) return { ok: false, reason: RenameError.Duplicate };
	return { ok: true, path };
}
