/**
 * Stage 10.11 — routing-token derivation + table (OQ-197 position).
 *
 * ## OQ-197 position paper — what rotates, when, what deliberately does not
 *
 * **The leak.** Today the wire routing key (`header.entityId`) is the RAW,
 * stable entity id. The relay/node can build per-entity traffic graphs keyed
 * by the true id — linkable across devices, re-pairings and (for shared
 * entities) across users — and those ids persist in audit/metering logs.
 *
 * **What ships (v1 of 10.11).** A pseudonymous *routing token* replaces the
 * raw id in the `entityId` header slot:
 *
 *     token = base64url(HKDF-SHA256(ikm = entity DEK,
 *                                   salt = "brainstorm/v1/routing-token",
 *                                   info = entityId, L = 16))
 *
 * Deriving from the per-entity DEK is the load-bearing choice: every
 * legitimate member/device already holds the DEK (HPKE member-wraps), so
 * there is ZERO new key-distribution machinery — and when the DEK rotates on
 * an access change (OQ-27's rotation envelope; member removal per OQ-203's
 * 10.10-shaped re-wrap), the routing token rotates *automatically with it*.
 * An evicted member cannot compute the new token because they never receive
 * the new DEK. Derivation is client-side only (the relay stays crypto-free);
 * to the node a token is exactly as opaque as the raw id was — zero
 * frame-format change, so the wire stays backward/forward compatible.
 *
 * **When rotation happens: on ACCESS CHANGE only — deliberately NOT on a
 * timer.** The durable node keys snapshot+tail storage and the SYNC-4a
 * restore catalog by the routing id. A time/epoch rotation would either
 * fragment that storage across epochs (breaking restore) or require an
 * explicit old→new migration op each epoch — and the migration op *shows the
 * node the link*, so the node trivially joins epochs. Periodic rotation
 * against the storing node is privacy theater; we refuse to ship it. The
 * honest adversary model for rotation is (a) the **evicted member**, who
 * knows the old token but goes dark on the new one, and (b) **long-lived
 * token exposure** in relay logs — both are served by access-change rotation.
 * Against the node itself, the win is *pseudonymization* (raw entity ids
 * never cross the wire), not unlinkability of rotation events.
 *
 * **The re-home choreography (fail-closed).** The rotating client sends
 * `rotate {from, to}` on the control channel; the durable node re-homes
 * storage atomically (dir-rename / journaled copy), moves in-flight
 * subscribers, aliases `from → to` for a dual-token grace window, records
 * `to` in the restore catalog, and acks `rotated`. The client flips emission
 * ONLY on that ack — a pre-10.11 node silently ignores the verb, so the old
 * token simply stays in use (no data loss, no stranded entity). The table
 * below keeps the previous token resolvable during grace so late frames from
 * not-yet-flipped peers still decrypt.
 *
 * **What deliberately does NOT rotate / non-goals.**
 * - No periodic/epoch rotation (see above — storage-fragmenting theater).
 * - The node CAN link `from → to` at rotation time (the migrate op is
 *   explicit). Inherent to storage continuity; documented, not hidden.
 * - Traffic *patterns* per pseudonym remain visible — inherent to pub/sub.
 * - During the grace window an evicted member subscribed to the old token
 *   still observes traffic *timing* (never content — that went dark at the
 *   DEK rotation itself). Grace is operator-tunable.
 * - Token mode is opt-in per pipeline context in this iteration (default
 *   wire behavior unchanged); flipping the live-sync engine + restore path
 *   to tokens-by-default is the tracked follow-up rung.
 *
 * **Relay-blind boundary.** This module runs client-side only (it holds the
 * DEK by definition). It must never be imported by relay/transport modules —
 * the CI fence on `**\/sync/**\/*relay*.ts` and `packages/relay-server`
 * keeps the route path crypto-free.
 */

import { Buffer } from "node:buffer";
import { hkdfSha256 } from "@brainstorm-os/native";

/** Domain separator (HKDF salt) — never reused by another derivation. */
export const ROUTING_TOKEN_SALT = "brainstorm/v1/routing-token";
/** 16 bytes → 22-char base64url. 128 bits of collision resistance is far
 *  beyond any vault's entity count; short enough to keep headers compact. */
export const ROUTING_TOKEN_BYTES = 16;

const ENCODER = new TextEncoder();

/**
 * Derive the pseudonymous routing token for `entityId` under its current
 * `dek`. Deterministic: every member/device holding the same DEK derives the
 * same token with no coordination. Rotating the DEK rotates the token.
 */
export function deriveRoutingToken(dek: Uint8Array, entityId: string): string {
	if (!(dek instanceof Uint8Array) || dek.length === 0) {
		throw invalid("deriveRoutingToken: dek must be a non-empty Uint8Array");
	}
	if (typeof entityId !== "string" || entityId.length === 0) {
		throw invalid("deriveRoutingToken: entityId must be a non-empty string");
	}
	const out = hkdfSha256(
		dek,
		ENCODER.encode(ROUTING_TOKEN_SALT),
		ENCODER.encode(entityId),
		ROUTING_TOKEN_BYTES,
	);
	return Buffer.from(out).toString("base64url");
}

/** One entity's token state: the current token plus (during a rotation grace
 *  window) the immediately-previous one, still resolvable for late frames. */
type TokenEntry = {
	current: string;
	previous: string | null;
};

/**
 * Client-side (entityId ⇄ routing token) table. Derives on `install`, keeps
 * NO DEK bytes (only the derived tokens), and retains exactly one previous
 * generation per entity so in-flight frames from a peer that hasn't flipped
 * yet still resolve during the grace window. `endGrace` drops the previous
 * token once the client unsubscribes it.
 */
export class RoutingTokenTable {
	readonly #byEntity = new Map<string, TokenEntry>();
	readonly #byToken = new Map<string, string>();

	/** Register (or re-derive) the entity's current token from its DEK.
	 *  Re-installing with the same DEK is a no-op; installing with a NEW DEK
	 *  rotates (previous token retained for grace). Returns the token. */
	install(entityId: string, dek: Uint8Array): string {
		const token = deriveRoutingToken(dek, entityId);
		const entry = this.#byEntity.get(entityId);
		if (!entry) {
			this.#byEntity.set(entityId, { current: token, previous: null });
			this.#byToken.set(token, entityId);
			return token;
		}
		if (entry.current === token) return token;
		if (entry.previous) this.#byToken.delete(entry.previous);
		entry.previous = entry.current;
		entry.current = token;
		this.#byToken.set(token, entityId);
		return token;
	}

	/** The entity's CURRENT routing token, or null if not installed. */
	tokenFor(entityId: string): string | null {
		return this.#byEntity.get(entityId)?.current ?? null;
	}

	/** The entity's previous (grace-window) token, or null. */
	previousTokenFor(entityId: string): string | null {
		return this.#byEntity.get(entityId)?.previous ?? null;
	}

	/** Resolve a wire routing token (current OR previous generation) back to
	 *  its entity id, or null for an unknown token. */
	resolve(token: string): string | null {
		return this.#byToken.get(token) ?? null;
	}

	/** Does `routedId` route to `entityId` — current OR grace-window previous?
	 *  The pipeline's receive-side header ↔ row binding in token mode
	 *  (`RoutingTokenResolver.isTokenFor`). */
	isTokenFor(routedId: string, entityId: string): boolean {
		return this.#byToken.get(routedId) === entityId;
	}

	/** Grace over: forget the previous token (the client unsubscribed it). */
	endGrace(entityId: string): void {
		const entry = this.#byEntity.get(entityId);
		if (!entry?.previous) return;
		this.#byToken.delete(entry.previous);
		entry.previous = null;
	}

	/** Drop every token for an entity (untracked / vault closed). */
	remove(entityId: string): void {
		const entry = this.#byEntity.get(entityId);
		if (!entry) return;
		this.#byToken.delete(entry.current);
		if (entry.previous) this.#byToken.delete(entry.previous);
		this.#byEntity.delete(entityId);
	}

	clear(): void {
		this.#byEntity.clear();
		this.#byToken.clear();
	}
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}
