/**
 * Collision-free naming for vault paths.
 *
 * A `CodeFile/v1` (and anything else keyed by a free-form `path`) has no
 * uniqueness constraint behind it, so every producer of a new path has to pick
 * one that is not already taken. The Code editor's "New file" does it
 * (`untitled.ts` → `untitled-2.ts`), and so does the agent when the user asks
 * to keep BOTH an existing file and a freshly drafted one at the same path
 * (`manifest.json` → `manifest-2.json`).
 *
 * The join semantics stay with the caller (a folder prefix means something
 * slightly different in each app), so this module only knows about NAMES: the
 * `-N` walk and the base/suffix split. Pure, no DOM, no service.
 */

/** Ceiling on the `-N` walk. A path list long enough to exhaust it is not a
 *  real vault; the walk degrades to the terminal suffix rather than spinning. */
const MAX_NAME_VARIANTS = 10_000;

/** Split a file NAME (never a full path) into the stem and its extension.
 *  `manifest.json` → `{ base: "manifest", suffix: ".json" }`. A name with no
 *  dot, or a dotfile whose only dot is leading (`.gitignore`), is all base —
 *  a leading dot is part of the name, not an extension. */
export function splitFileSuffix(name: string): { base: string; suffix: string } {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { base: name, suffix: "" };
	return { base: name.slice(0, dot), suffix: name.slice(dot) };
}

/**
 * The first `<base>[-N]<suffix>` the caller does not already consider taken:
 * `manifest.json`, then `manifest-2.json`, `manifest-3.json`, …
 *
 * `isTaken` receives the candidate NAME and decides — that is where the caller
 * applies its own folder join and its own case-folding, so this helper never
 * has to guess either.
 */
export function firstFreeName(
	base: string,
	suffix: string,
	isTaken: (name: string) => boolean,
): string {
	for (let n = 1; n < MAX_NAME_VARIANTS; n++) {
		const name = n === 1 ? `${base}${suffix}` : `${base}-${n}${suffix}`;
		if (!isTaken(name)) return name;
	}
	// Pathological fallback — effectively unreachable.
	return `${base}-${MAX_NAME_VARIANTS}${suffix}`;
}
