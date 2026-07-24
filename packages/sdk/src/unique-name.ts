/**
 * Collision-free naming for user-created objects: pick the first of
 * `base, base 2, base 3, …` that no existing sibling already uses.
 *
 * Shared because two surfaces mint names against the same set: the Database's
 * list / view creation ("New list", "New list 2", …) and the Agent's proposed
 * new database (Agent-11e), which must not silently produce a second
 * collection with an existing collection's name.
 */

export function uniqueName(base: string, existing: ReadonlyArray<{ name: string }>): string {
	const taken = new Set(existing.map((entry) => entry.name));
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base} ${n}`)) n += 1;
	return `${base} ${n}`;
}
