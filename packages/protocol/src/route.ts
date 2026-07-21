/**
 * Cross-app route helpers shared between main, preload, and renderer.
 *
 * A route is the `brainstorm://` URI a window/tab currently shows (per
 * ). The shell tracks routes per tab so
 * navigation can focus an existing tab instead of opening a duplicate.
 *
 * No `electron` import here — the renderer imports these too.
 */

export const ENTITY_ROUTE_SCHEME = "brainstorm:";
export const ENTITY_ROUTE_AUTHORITY = "entity";

/** Build the canonical route for an entity id. */
export function entityRoute(entityId: string): string {
	return `${ENTITY_ROUTE_SCHEME}//${ENTITY_ROUTE_AUTHORITY}/${encodeURIComponent(entityId)}`;
}

/** Query params that don't bear on a route's identity (per doc-37 §Route
 *  normalization — shell-curated for v1, OQ-157). */
const EPHEMERAL_QUERY_KEYS = new Set(["from", "via", "referrer"]);

/**
 * Canonicalize a route so two URIs that address the same thing compare equal:
 * decode+re-encode the path, sort query keys, drop ephemeral keys, strip a
 * trailing slash. The fragment (`#anchor`) is split off — focus-existing
 * matches on the entity portion, then scrolls to the anchor separately.
 *
 * Returns `{ base, fragment }`. Invalid input round-trips as a trimmed string
 * with an empty fragment (fail-soft — a non-route caller still gets a stable key).
 */
export function canonicalizeRoute(route: string): { base: string; fragment: string | null } {
	const trimmed = route.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { base: trimmed.replace(/\/+$/, ""), fragment: null };
	}

	const fragment = url.hash ? url.hash.slice(1) : null;

	const params = [...url.searchParams.entries()]
		.filter(([key]) => !EPHEMERAL_QUERY_KEYS.has(key))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query = params.map(([k, v]) => `${k}=${v}`).join("&");

	let path = url.pathname.replace(/\/+$/, "");
	if (path === "") path = "";

	const host = url.host;
	let base = `${url.protocol}//${host}${path}`;
	if (query) base += `?${query}`;
	return { base, fragment };
}

/** True when two routes address the same entity (fragment-insensitive). */
export function routesEquivalent(a: string, b: string): boolean {
	return canonicalizeRoute(a).base === canonicalizeRoute(b).base;
}
