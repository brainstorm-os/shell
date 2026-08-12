/**
 * The ONE answer to "what do we call this object?".
 *
 * Every surface that paints an entity — a Files tile, a Graph node, a
 * Database row, a Calendar chip, an editor embed, the shell's search index
 * — needs a human label out of a freeform `properties` bag. Before this
 * module each of them walked its own chain, and they disagreed on both
 * order and fallbacks: Files read `name` only, so every Note (which stores
 * its label in `title`) and every CodeFile (which stores only `path`)
 * rendered "(untitled)" in the vault browser; Graph preferred `name` over
 * `title`, so an object carrying both was called one thing on the canvas
 * and another in the file manager. Fixing Files' private copy in place is
 * what let the divergence survive — hence one module, consumed everywhere.
 *
 * The chain is type-agnostic on purpose (no per-type allowlist):
 *
 *   `title` → `name` → `displayName` → `label` → the leaf of `path`
 *
 * Each key exists in the vault today: a Note/Bookmark/Event has `title`, a
 * Person/File/Folder has `name`, a `brainstorm/Profile/v1` has ONLY
 * `displayName`, several app-authored rows carry `label`, and a
 * `brainstorm/CodeFile/v1` carries only `path`. Blank and whitespace-only
 * values fall through to the next key rather than painting an empty label,
 * and the winner comes back trimmed.
 *
 * A `path` surfaces as its LEAF segment (`src/lib/main.ts` → `main.ts`) —
 * a one-line row or a node disc has no room for a directory prefix, and
 * the leaf is what every file UI shows.
 *
 * What stays with the caller is the FALLBACK, because that genuinely
 * differs by surface: a canvas node wants "Note (untitled)", a picker
 * wants to drop the row entirely, the search collector wants "". So the
 * resolver returns `null` for "this object has no name" and never invents
 * one — use {@link entityTitleOr} when you have a fallback string in hand.
 */

/** The property keys consulted, in precedence order. `path` is handled
 *  separately (its leaf is taken, not the raw value) and so is not listed. */
export const ENTITY_TITLE_KEYS = ["title", "name", "displayName", "label"] as const;

/** The property holding a vault path, whose leaf segment names the object
 *  when no title-shaped key is set (`brainstorm/CodeFile/v1`). */
export const ENTITY_PATH_KEY = "path";

function readString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/** The last non-empty `/`-separated segment of a path — `src/lib/main.ts`
 *  → `main.ts`, `readme.md` → `readme.md`. */
export function pathLeaf(path: string): string {
	const segments = path.split("/").filter((segment) => segment.length > 0);
	return segments[segments.length - 1] ?? path;
}

/**
 * The entity's display title, or `null` when it carries no name-shaped
 * property at all. See the module doc for the chain and why the fallback
 * is the caller's.
 */
export function resolveEntityTitle(
	properties: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
	if (!properties) return null;
	for (const key of ENTITY_TITLE_KEYS) {
		const value = readString(properties[key]);
		if (value !== null) return value;
	}
	const path = readString(properties[ENTITY_PATH_KEY]);
	return path === null ? null : pathLeaf(path);
}

/** {@link resolveEntityTitle} with the caller's fallback for a nameless
 *  object — the surface decides whether that reads as an id, a localized
 *  "Untitled", or a type caption. */
export function entityTitleOr(
	properties: Readonly<Record<string, unknown>> | null | undefined,
	fallback: string,
): string {
	return resolveEntityTitle(properties) ?? fallback;
}

/** True when the entity carries a real display title. The "(untitled)"
 *  caption a surface paints is presentation, not data — sorts and pickers
 *  that must tell "named" from "nameless" ask this, never the rendered
 *  string. */
export function hasEntityTitle(
	properties: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
	return resolveEntityTitle(properties) !== null;
}
