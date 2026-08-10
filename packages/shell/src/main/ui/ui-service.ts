/**
 * Broker service handler for `ui` (Stage 7.7).
 *
 * Methods:
 *   - notify({ title, body?, kind? }) → void
 *
 * Capability gating happens in the broker via the envelope's `caps`
 * field; the SDK proxy declares `notifications.post` for `notify`. The
 * handler is thin: validate the payload shape, stamp the broker-verified
 * calling app id, and hand it to the pure `UiNotifyHost` which forwards
 * to the dashboard renderer.
 *
 * `openWindow` / `closeWindow` are declared on the SDK `UiService` but
 * not part of 7.7 — an unknown method returns `Invalid` (same as every
 * other service handler) rather than silently succeeding.
 *
 * Wire method names carry NO dots: `validateEnvelope`'s `METHOD_PATTERN`
 * accepts `[A-Za-z][A-Za-z0-9_-]*` only. `setRoute` (9.8.2c) is therefore
 * flat on the wire even though the SDK nests it as `ui.windows.setRoute`.
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { BadgeHost } from "./badge-host";
import { type UiNotifyHost, normalizeNotification } from "./notify-host";
import type { TrayHost } from "./tray-host";

/** Defensive ceiling so a hostile app can't pump an unbounded string into
 *  the dashboard's search palette. Generous for any real query. */
const MAX_SEARCH_QUERY = 512;

/** Entity ids are short opaque local strings; anything longer is malformed
 *  input, not a route. Mirrors the envelope's own app-id ceiling. */
const MAX_ENTITY_ID = 256;

export type UiServiceOptions = {
	getHost: () => UiNotifyHost;
	getTrayHost: () => TrayHost;
	/** 7.14 — `ui.badge.set/clear` (cap `ui.badge`, broker-enforced). Optional
	 *  so existing wirings/tests stay valid; absent = Unavailable. */
	getBadgeHost?: () => BadgeHost;
	/** 9.8.9 — `ui.openSearch` (cap `search.open`, broker-enforced): focus
	 *  the dashboard and open the global search palette pre-filled with the
	 *  query. Optional so existing wirings/tests stay valid; absent =
	 *  Unavailable. */
	openSearch?: (query: string) => void;
	/** 9.8.2c — `ui.setRoute` (SDK surface `ui.windows.setRoute`): the calling
	 *  app publishes the object its tab now shows after navigating IN PLACE, so
	 *  the shell's per-tab route stays current and focus-existing stops matching
	 *  a tab on the entity it used to show.
	 *
	 *  No capability: the sink resolves the tab from `source` — the caller
	 *  identity the broker already verified — so an app can only ever re-label
	 *  its own tab. The wire arg is an ENTITY ID, never a route string: the
	 *  shell builds the canonical `brainstorm://entity/<id>` URI itself, so a
	 *  hostile app cannot inject an arbitrary URI into shell chrome. Optional so
	 *  existing wirings/tests stay valid; absent = Unavailable. */
	setRoute?: (app: string, source: unknown, entityId: string | null) => void;
};

export function makeUiServiceHandler(options: UiServiceOptions): ServiceHandler {
	// `source` is optional only so the direct-call unit tests (and any handler
	// composed by hand) stay valid — the broker always supplies it, and the
	// `setRoute` sink treats a missing one as "no resolvable tab".
	return (envelope: Envelope, source?: unknown): unknown => {
		switch (envelope.method) {
			case "notify": {
				const [arg] = envelope.args as [unknown];
				const notification = normalizeNotification(envelope.app, arg);
				options.getHost().post(notification);
				return undefined;
			}
			case "tray.publish": {
				const [arg] = envelope.args as [unknown];
				// `publish` validates `arg` and throws `Invalid` on a bad
				// spec — same fail-shape as `notify`.
				options.getTrayHost().publish(envelope.app, arg);
				return undefined;
			}
			case "tray.clear": {
				options.getTrayHost().clear(envelope.app);
				return undefined;
			}
			case "badge.set": {
				if (!options.getBadgeHost) throw unavailable("ui.badge: not wired");
				const [arg] = envelope.args as [unknown];
				// `set` validates `arg` and throws `Invalid` on a bad spec —
				// same fail-shape as `notify`/`tray.publish`. The app id is the
				// broker-verified `envelope.app`, so an app can only badge its own
				// icon (never a client-supplied target).
				options.getBadgeHost().set(envelope.app, arg);
				return undefined;
			}
			case "badge.clear": {
				if (!options.getBadgeHost) throw unavailable("ui.badge: not wired");
				options.getBadgeHost().clear(envelope.app);
				return undefined;
			}
			case "openSearch": {
				// Broker already enforced `search.open` against the ledger;
				// this validates shape only. Non-string / oversized queries
				// degrade to "" rather than erroring — the palette still
				// opens, which is the user-visible intent.
				if (!options.openSearch) throw unavailable("ui.openSearch: not wired");
				const [arg] = envelope.args as [unknown];
				const raw = arg && typeof arg === "object" ? (arg as Record<string, unknown>).query : undefined;
				const query = typeof raw === "string" ? raw.slice(0, MAX_SEARCH_QUERY) : "";
				options.openSearch(query);
				return undefined;
			}
			case "setRoute": {
				if (!options.setRoute) throw unavailable("ui.setRoute: not wired");
				const [arg] = envelope.args as [unknown];
				const raw =
					arg && typeof arg === "object" ? (arg as Record<string, unknown>).entityId : undefined;
				// `null` is the meaningful "this tab shows nothing addressable" clear.
				// Anything else must be a plausible entity id — a malformed value
				// quietly clearing the route would leave the tab unfocusable with no
				// signal to the caller.
				if (raw !== null && (typeof raw !== "string" || raw === "" || raw.length > MAX_ENTITY_ID)) {
					throw invalid("ui.setRoute: entityId must be a non-empty entity id or null");
				}
				options.setRoute(envelope.app, source, raw);
				return undefined;
			}
			default:
				throw invalid(`unknown ui method: ${envelope.method}`);
		}
	};
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

function unavailable(message: string): Error {
	const err = new Error(message);
	err.name = "Unavailable";
	return err;
}
