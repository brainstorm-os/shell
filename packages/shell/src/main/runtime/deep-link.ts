/**
 * Inbound OS deeplink handling — a `brainstorm://entity/<id>` URL opened from
 * an external app (a browser, a mail client, Spotlight) should launch/focus the
 * shell and route to that entity.
 *
 * The OS delivers the URL three different ways, all funnelled through one
 * router in `index.ts`:
 *   - **macOS** — `app.on("open-url")` (fires even on cold start, before the
 *     window exists, so the URL must be queued until the app is ready).
 *   - **Windows / Linux, cold start** — the URL is appended to the launch
 *     `process.argv`.
 *   - **Windows / Linux, already running** — the URL arrives in the
 *     `second-instance` event's `argv`.
 *
 * These helpers are the pure parsing half so the lifecycle wiring stays a thin,
 * testable shell. The protocol itself (`brainstorm://`) is registered as a
 * privileged scheme for in-app asset serving; `setAsDefaultProtocolClient`
 * additionally registers the app as the OS handler for the scheme.
 */

const ENTITY_PREFIX = "brainstorm://entity/";
const SCHEME_PREFIX = "brainstorm://";

/** Parse a `brainstorm://entity/<id>` URL into its entity id, ignoring any
 *  trailing `#block-…` anchor or `?query`. Returns null for any non-entity or
 *  malformed URL so callers can fail closed. */
export function parseEntityDeepLink(url: unknown): string | null {
	if (typeof url !== "string" || !url.startsWith(ENTITY_PREFIX)) return null;
	const rest = url.slice(ENTITY_PREFIX.length);
	const id = (rest.split(/[#?]/)[0] ?? "").trim();
	return id.length > 0 ? id : null;
}

/** The first `brainstorm://` URL in a process `argv` list — Windows/Linux
 *  deliver a deeplink as a launch argument (cold start) or in the
 *  `second-instance` argv (already running). Null when none is present. */
export function deepLinkFromArgv(argv: readonly string[] | undefined): string | null {
	if (!argv) return null;
	for (const arg of argv) {
		if (typeof arg === "string" && arg.startsWith(SCHEME_PREFIX)) return arg;
	}
	return null;
}
