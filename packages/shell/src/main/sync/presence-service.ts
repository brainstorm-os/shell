/**
 * PRES-2b — the `presence` broker service: the app-facing, capability-gated
 * surface that drives the {@link PresenceRouter}. It is the sandbox entry point
 * for live presence (the avatar stack + remote cursors on a shared entity).
 *
 * Methods (renderer→main; the main→renderer peer push rides the router's
 * `app:presence-peers` channel, not a return value):
 *   - `publish({entityId, type, state})` — publish THIS device's presence for an
 *     entity (or `state: null` to clear). Requires `entities.read:<type>`.
 *   - `untrack({entityId})` — stop tracking (surface closed). No cap: it only
 *     clears our OWN presence and can grant nothing.
 *
 * SECURITY (design 74 §capability model, OQ-205): presence piggybacks on the
 * read grant — an app may publish/see presence for an entity IFF it already
 * holds `entities.read:<type>` (the same grant it used to open the entity). The
 * declared `envelope.caps` are an app-controlled hint; the ledger is the
 * authoritative gate, re-checked here and fail-closed (no vault / ledger error →
 * `Unavailable`; grant absent → `Denied`). Presence is display-only: it grants
 * nothing, so publishing to an entity of a type the app can read but isn't "in"
 * is cosmetic, never an escalation. The outbound peer push is gated at the
 * source by the router (only apps that published receive it).
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { PresenceRouter } from "./presence-router";

/** Presence rides the per-type entities read grant — no new default capability. */
export const PRESENCE_READ_CAPABILITY = "entities.read";

export type PresenceServiceOptions = {
	/** The active vault's presence router, or null when no vault/transport is up
	 *  (fail closed). Read on every call so a session swap is transparent. */
	readonly getRouter: () => PresenceRouter | null;
	/** SECURITY — resolve an entity's REAL type from the vault (its `entities.db`
	 *  row), so the capability gate keys on the authoritative type and never on
	 *  the app-supplied `type`. Trusting the client's type would let an app that
	 *  holds `entities.read:<cheap>` subscribe to presence for an entity of a type
	 *  it can't read (leaking collaborators' identities + cursors). Mirrors the
	 *  entities service, which resolves the type from the repo row. `null` ⇒ the
	 *  entity is unknown to this vault ⇒ deny. */
	readonly resolveEntityType: (entityId: string) => Promise<string | null>;
	/** SECURITY — the active vault's capability ledger, re-checked server-side.
	 *  Absent → the cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Re-check `entities.read:<type>` against the ledger (the authoritative gate).
 *  Fails closed: ledger error / no vault → `Unavailable`; not held → `Denied`.
 *  No-op when `getLedger` is unwired (unit tests). */
async function requireEntityRead(
	envelope: Envelope,
	options: PresenceServiceOptions,
	type: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "presence: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "presence: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, `${PRESENCE_READ_CAPABILITY}:${type}`);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "presence: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `presence.${envelope.method}: ${envelope.app} lacks read for ${type}`);
	}
}

function requireRouter(options: PresenceServiceOptions): PresenceRouter {
	const router = options.getRouter();
	if (!router) throw makeError("Unavailable", "presence: no active vault session");
	return router;
}

/** Untrusted inbound state: an object map or `null` (clear). Anything else is
 *  coerced to `null` — the render side hardens fields further via `peerFromState`. */
function parseState(value: unknown): Record<string, unknown> | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	return null;
}

export function makePresenceServiceHandler(options: PresenceServiceOptions): ServiceHandler {
	async function handlePublish(envelope: Envelope): Promise<void> {
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const entityId = typeof input.entityId === "string" ? input.entityId : "";
		if (!entityId) throw makeError("Invalid", "presence.publish: entityId required");
		// SECURITY: gate on the entity's REAL type, resolved from the vault — never
		// the app-supplied `input.type` (which the app could forge to a type it can
		// read while pointing `entityId` at one it can't, harvesting that entity's
		// collaborator presence). Unknown entity ⇒ deny.
		const type = await options.resolveEntityType(entityId);
		if (!type) throw makeError("Invalid", "presence.publish: unknown entity");
		await requireEntityRead(envelope, options, type);
		requireRouter(options).publish(envelope.app, entityId, parseState(input.state));
	}

	function handleUntrack(envelope: Envelope): void {
		const input = (envelope.args[0] ?? {}) as Record<string, unknown>;
		const entityId = typeof input.entityId === "string" ? input.entityId : "";
		if (!entityId) throw makeError("Invalid", "presence.untrack: entityId required");
		requireRouter(options).untrack(envelope.app, entityId);
	}

	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "publish":
				return await handlePublish(envelope);
			case "untrack":
				return handleUntrack(envelope);
			default:
				throw makeError("Invalid", `unknown presence method: ${envelope.method}`);
		}
	};
}
