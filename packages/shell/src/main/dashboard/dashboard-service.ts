/**
 * Broker service handler for `dashboard` (Stage 7.13) — the
 * capability-gated, app-reachable face of "pin any object to the
 * dashboard".
 *
 * Methods:
 *   - pin({ entityId })      → boolean   (idempotent; false = no session)
 *   - unpin({ entityId })    → boolean   (no-op if not pinned)
 *   - isPinned({ entityId }) → boolean
 *
 * Capability gating happens in the broker via the envelope's `caps`
 * field; the SDK proxy declares the unscoped default-minimum
 * `dashboard.pin` for all three (the object menu needs the toggle state
 * to label itself, so `isPinned` reads over the same grant). Throws
 * `Unavailable` when no vault session is active; `Invalid` on malformed
 * args or an unknown method.
 *
 * Deliberately thin: the pin stores **only** the entity id (no
 * cross-app data — label/icon/opener are live-resolved by
 * `pin-resolver` on every dashboard read). The icon id is derived from
 * the entity id (`pin_<entityId>`) so pin is idempotent and unpin /
 * isPinned are a single map lookup — no scan for "an icon that happens
 * to target this id".
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { UNPLACED_ICON_POSITION } from "../../shared/dashboard-icon-grid";
import { deriveEntityTitle } from "../entities/derive-title";
import type { EntitiesRepository } from "../storage/entities-repo";
import type { DashboardStore } from "./dashboard-store";

export type DashboardServiceOptions = {
	/** Active vault's dashboard store, or null when no session is open
	 *  (→ pin/unpin resolve `false`, isPinned `false`). */
	getStore: () => Promise<DashboardStore | null>;
	/** Active vault's entities repo — used only to seed a best-effort
	 *  fallback `label` at pin time (the live resolver overrides it on
	 *  every read). `null` when unavailable; pinning still succeeds. */
	getEntitiesRepo: () => Promise<EntitiesRepository | null>;
};

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

/** Stable icon id for an entity pin. Deterministic so re-pinning is a
 *  no-op and unpin/isPinned are O(1). */
function pinIconId(entityId: string): string {
	return `pin_${entityId}`;
}

function requireEntityIdArg(envelope: Envelope): string {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw invalid(`dashboard.${envelope.method}: argument must be an object`);
	}
	const entityId = (arg as Record<string, unknown>).entityId;
	if (typeof entityId !== "string" || entityId.length === 0) {
		throw invalid(`dashboard.${envelope.method}: entityId must be a non-empty string`);
	}
	return entityId;
}

export function makeDashboardServiceHandler(options: DashboardServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		const store = await options.getStore();
		switch (envelope.method) {
			case "pin": {
				const entityId = requireEntityIdArg(envelope);
				if (!store) return false;
				const id = pinIconId(entityId);
				const existing = store.snapshot().icons[id];
				if (existing && existing.kind === "entity" && existing.target === entityId) {
					return true; // idempotent — already pinned
				}
				// Best-effort label seed (the live resolver overrides this on
				// every read; it only matters as the tombstone caption if the
				// object is later deleted). Never throws — a missing/closed
				// repo just yields an empty seed.
				let label = "";
				try {
					const repo = await options.getEntitiesRepo();
					const row = repo?.get(entityId) ?? null;
					if (row) label = deriveEntityTitle(row.properties);
				} catch {
					label = "";
				}
				// No position: the renderer places it against its real viewport
				// (POLISH-LAY-9) — main has no idea how wide the icon surface is,
				// and guessing produced slots off the right edge.
				store.upsertIcon(id, {
					...UNPLACED_ICON_POSITION,
					kind: "entity",
					target: entityId,
					label,
				});
				return true;
			}
			case "unpin": {
				const entityId = requireEntityIdArg(envelope);
				if (!store) return false;
				const id = pinIconId(entityId);
				const existing = store.snapshot().icons[id];
				if (!existing || existing.kind !== "entity" || existing.target !== entityId) {
					return false; // not pinned — no-op
				}
				store.removeIcon(id);
				return true;
			}
			case "isPinned": {
				const entityId = requireEntityIdArg(envelope);
				if (!store) return false;
				const existing = store.snapshot().icons[pinIconId(entityId)];
				return Boolean(existing && existing.kind === "entity" && existing.target === entityId);
			}
			default:
				throw invalid(`unknown dashboard method: ${envelope.method}`);
		}
	};
}
