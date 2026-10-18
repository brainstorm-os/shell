/**
 * settings — the per-device app-settings broker service (`"settings"`).
 *
 * A SQLite-backed mirror of the legacy app-scoped `storage.kv` surface
 * (get/put/delete/list), for device-local UI state that must NOT sync
 * between devices: Graph/Database view config, dictionary sort, panel
 * layout. Backed by `settings.db` (per-device, never in the Yjs sync set)
 * via `SettingsRepository`.
 *
 * Identity model: app-scoped by the broker-verified `envelope.app` — each
 * app reads/writes only its own namespace, exactly like the retired
 * `kv.json` silo. No capability gate (the same posture `storage.kv` had:
 * an app's own private settings are not a cross-app information surface);
 * the per-app `app_id` partition in the table is the boundary. A missing
 * vault session fails closed (`Unavailable`).
 *
 * `value` is JSON-serialised on write and parsed on read, so the wire
 * contract matches `StorageService` exactly (callers pass/receive plain
 * JSON values, not strings).
 */

import {
	CONFIRM_SKIP_KEY_PREFIX,
	canRememberConfirm,
	confirmKindFromSkipKey,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { SettingsRepository } from "../storage/settings-repo";

export type SettingsServiceOptions = {
	/** The settings repo for the active vault, or null when none is open
	 *  (→ `Unavailable`, fail closed). */
	getRepo: () => Promise<SettingsRepository | null>;
};

function named(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function arg(envelope: { args: unknown[] }): Record<string, unknown> {
	const a = envelope.args[0];
	return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

/** Parse a stored JSON string back to its value; a corrupt blob reads as
 *  null rather than throwing (a single bad pref never breaks the app). */
function parseValue(raw: string | null): unknown {
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

export function makeSettingsServiceHandler(options: SettingsServiceOptions): ServiceHandler {
	return async (envelope) => {
		const repo = await options.getRepo();
		if (!repo) throw named("Unavailable", "settings service: no active vault session");
		const app = envelope.app;

		switch (envelope.method) {
			case "get": {
				const key = String(arg(envelope).key ?? "");
				return parseValue(repo.get(app, key));
			}
			case "put": {
				const a = arg(envelope);
				const key = String(a.key ?? "");
				if (key === "") throw named("Invalid", "settings.put: missing key");
				// 6.15 — the reserved confirmation-skip namespace only ever holds a
				// skip for a REVERSIBLE prompt kind: an irreversible prompt must not
				// be silenceable, however the write arrives.
				if (
					key.startsWith(CONFIRM_SKIP_KEY_PREFIX) &&
					!canRememberConfirm(confirmKindFromSkipKey(key))
				) {
					throw named("Invalid", "settings.put: that confirmation cannot be skipped");
				}
				repo.set(app, key, JSON.stringify(a.value ?? null));
				return undefined;
			}
			case "delete": {
				const key = String(arg(envelope).key ?? "");
				return repo.delete(app, key);
			}
			case "list": {
				const prefix = typeof arg(envelope).prefix === "string" ? String(arg(envelope).prefix) : "";
				return repo.list(app, prefix).map((e) => ({ key: e.key, value: parseValue(e.value) }));
			}
			default:
				throw named("Invalid", `unknown settings method: ${envelope.method}`);
		}
	};
}
