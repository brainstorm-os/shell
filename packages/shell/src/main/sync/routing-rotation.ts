/**
 * Stage 10.11 — the client-driven routing-token rotation coordinator
 * (OQ-197; position paper in `routing-token.ts`).
 *
 * Rotation is triggered by an ACCESS CHANGE: the entity's DEK has already
 * been rotated (OQ-27's rotation envelope / member-removal re-wrap), so the
 * new routing token is simply the new DEK's derivation. This coordinator
 * performs the durable re-home choreography against the node, FAIL-CLOSED
 * at every step:
 *
 *   1. persist the intent `{entityId, from, to}` BEFORE anything crosses the
 *      wire — a crash at any later point is resumed by `resumePending()`
 *      re-sending the same idempotent `rotate` (the node converges);
 *   2. `requestRotate(from, to)` and WAIT for the node's `rotated` ack —
 *      a denial / timeout / pre-10.11 node (which silently ignores the verb)
 *      leaves the local table on the OLD token: emission continues under
 *      `from`, which the node still serves, so nothing is lost or stranded;
 *   3. only on the ack: flip the local table (the old token stays resolvable
 *      as the grace-window previous generation), subscribe the new token,
 *      and clear the persisted intent;
 *   4. `endGrace(entityId)` later unsubscribes the old token and drops the
 *      previous-generation mapping.
 *
 * A transport with no durable node (loopback) has nothing to re-home — the
 * rotation is local-table-only and completes immediately.
 */

import type { RelaySurface } from "./relay-port";
import { type RoutingTokenTable, deriveRoutingToken } from "./routing-token";

export enum RotationOutcome {
	/** Re-home acked by the node; local table flipped; grace running. */
	Rotated = "rotated",
	/** The new DEK derives the token already current — nothing to do. */
	AlreadyCurrent = "already-current",
	/** No durable-node transport — local table flipped, nothing re-homed. */
	LocalOnly = "local-only",
}

/** A persisted not-yet-acked rotation intent (crash-recovery unit). */
export type PendingRotation = {
	entityId: string;
	from: string;
	to: string;
};

/**
 * Where pending intents survive a crash. The production impl belongs in the
 * vault KV (wired in the live-sync follow-up rung); tests + the current
 * pipeline-level integration use the in-memory store.
 */
export interface RotationStateStore {
	load(): PendingRotation[];
	save(rotations: PendingRotation[]): void;
}

export class MemoryRotationStateStore implements RotationStateStore {
	#rotations: PendingRotation[] = [];

	load(): PendingRotation[] {
		return this.#rotations.map((r) => ({ ...r }));
	}

	save(rotations: PendingRotation[]): void {
		this.#rotations = rotations.map((r) => ({ ...r }));
	}
}

export type RoutingRotationContext = {
	table: RoutingTokenTable;
	store: RotationStateStore;
	/** The live relay surface, or null when offline (rotation stays pending). */
	getRelay: () => RelaySurface | null;
	/** The device's wire account — feeds the node's catalog on an open node. */
	account?: string;
};

export class RoutingRotationCoordinator {
	readonly #ctx: RoutingRotationContext;

	constructor(ctx: RoutingRotationContext) {
		this.#ctx = ctx;
	}

	/**
	 * Rotate `entityId`'s routing token to the derivation of `newDek` (the
	 * already-rotated entity DEK). Throws on a denied / timed-out re-home —
	 * the local table is NOT flipped then (emission stays on the old token,
	 * fail-closed) and the persisted intent makes `resumePending` retry.
	 */
	async rotate(entityId: string, newDek: Uint8Array): Promise<RotationOutcome> {
		const from = this.#ctx.table.tokenFor(entityId);
		const to = deriveRoutingToken(newDek, entityId);
		if (from === to) return RotationOutcome.AlreadyCurrent;
		if (from === null) {
			// First install — no old token exists anywhere, nothing to re-home.
			this.#ctx.table.install(entityId, newDek);
			return RotationOutcome.AlreadyCurrent;
		}
		this.#persist({ entityId, from, to });
		const relay = this.#ctx.getRelay();
		if (relay?.requestRotate) {
			// Fail-closed: any throw here propagates BEFORE the table flips.
			await relay.requestRotate(from, to, this.#ctx.account);
		}
		this.#commit(entityId, newDek, to, relay);
		return relay?.requestRotate ? RotationOutcome.Rotated : RotationOutcome.LocalOnly;
	}

	/**
	 * Re-drive every persisted intent (boot / reconnect). The node-side
	 * migration is idempotent, so re-sending a possibly-already-applied
	 * `rotate` converges; the table flip is keyed off the CURRENT DEK
	 * derivation, so a crash after ack but before commit also converges.
	 * Failures keep the intent for the next resume — never thrown.
	 */
	async resumePending(currentDekFor: (entityId: string) => Uint8Array | null): Promise<void> {
		for (const intent of this.#ctx.store.load()) {
			const dek = currentDekFor(intent.entityId);
			if (!dek) continue; // entity gone / DEK unavailable — keep the intent
			if (deriveRoutingToken(dek, intent.entityId) !== intent.to) {
				// The DEK rotated AGAIN since this intent — a newer rotation owns
				// the entity now; this stale hop is superseded. Drop it.
				this.#remove(intent.entityId);
				continue;
			}
			const relay = this.#ctx.getRelay();
			if (!relay) continue;
			try {
				if (relay.requestRotate) await relay.requestRotate(intent.from, intent.to, this.#ctx.account);
				this.#commit(intent.entityId, dek, intent.to, relay);
			} catch {
				// Denied / timed out — old token still live on the node; retry later.
			}
		}
	}

	/** Pending intents (test/diagnostic surface). */
	pending(): PendingRotation[] {
		return this.#ctx.store.load();
	}

	/**
	 * Grace over for `entityId`: unsubscribe the previous token and drop its
	 * resolution. Call after the node's grace window has certainly elapsed
	 * (or when every peer is known to have flipped).
	 */
	endGrace(entityId: string): void {
		const previous = this.#ctx.table.previousTokenFor(entityId);
		if (previous) this.#ctx.getRelay()?.unsubscribe?.(previous);
		this.#ctx.table.endGrace(entityId);
	}

	#commit(entityId: string, newDek: Uint8Array, to: string, relay: RelaySurface | null): void {
		this.#ctx.table.install(entityId, newDek);
		// Old-token subscription stays live for the grace window (the node fans
		// new-token frames to it anyway); the new token is subscribed so a
		// post-grace reconnect lands on the right channel.
		relay?.subscribe?.(to);
		this.#remove(entityId);
	}

	#persist(intent: PendingRotation): void {
		const rest = this.#ctx.store.load().filter((r) => r.entityId !== intent.entityId);
		this.#ctx.store.save([...rest, intent]);
	}

	#remove(entityId: string): void {
		this.#ctx.store.save(this.#ctx.store.load().filter((r) => r.entityId !== entityId));
	}
}
