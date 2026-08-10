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
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { BadgeHost } from "./badge-host";
import { type UiNotifyHost, normalizeNotification } from "./notify-host";
import type { TrayHost } from "./tray-host";

/** Defensive ceiling so a hostile app can't pump an unbounded string into
 *  the dashboard's search palette. Generous for any real query. */
const MAX_SEARCH_QUERY = 512;

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
};

export function makeUiServiceHandler(options: UiServiceOptions): ServiceHandler {
	return (envelope: Envelope): unknown => {
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
