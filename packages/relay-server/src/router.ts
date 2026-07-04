/**
 * Stage 10.4 — relay-server routing table.
 *
 * Pure data-flow class. Holds the `(entityId → Set<connId>)` subscription
 * table; on `route(connId, frame)` peeks the routing header, fans out the
 * untouched frame bytes to every other subscriber for that entity, and
 * appends one audit-log entry per delivery.
 *
 * **No echo.** A subscriber that's also the sender does NOT receive its
 * own frame back. The 10.0 spike's spec is `entityId → set of subscribed
 * device labels`; we use per-connection ids so a single device with two
 * sockets (rare but possible) gets fan-out across both.
 *
 * **Malformed header tolerance.** A frame whose header fails strict-
 * shape validation is dropped + counted; we do NOT close the offending
 * connection (a malformed-frame-as-DoS would be a worse outcome — the
 * recipient is the last line of defense against bad actors per the 10.0
 * review).
 */

// relay-blind: this file intentionally has zero crypto/credential imports.
// The CI gate covers the relay-server package; the imports below are
// forbidden and any future addition requires a per-line
// `// relay-blind-exempt` review note.

import type { AuditLog } from "./audit-log";
import { type RoutingHeader, peekRoutingHeader } from "./wire";

export type RouteResult = {
	delivered: number;
	dropped: 0 | 1;
	header: RoutingHeader | null;
	/** Stage 10.11 — the CANONICAL routing key the frame fanned out under
	 *  (the header key resolved through any live rotation alias). Null when
	 *  the header was malformed. */
	routingKey: string | null;
};

/** Stage 10.11 — a rotation alias `from → to`, live until `expiresAt` (the
 *  dual-token grace window). Opaque strings only — relay-blind. */
type RotationAlias = { to: string; expiresAt: number };

/** Alias chains are followed at most this many hops (a rotation of a rotation
 *  inside one grace window); a longer chain or a cycle stops resolving. */
const MAX_ALIAS_HOPS = 8;

export class FrameRouter {
	readonly #audit: AuditLog;
	readonly #subscriptions = new Map<string, Set<string>>();
	readonly #connectionsByEntity = new Map<string, Set<string>>();
	readonly #entitiesByConnection = new Map<string, Set<string>>();
	readonly #aliases = new Map<string, RotationAlias>();
	readonly #now: () => number;
	#malformedDropped = 0;

	constructor(audit: AuditLog, opts: { now?: () => number } = {}) {
		this.#audit = audit;
		this.#now = opts.now ?? Date.now;
	}

	/**
	 * Stage 10.11 routing-token rotation — canonicalize a routing key through
	 * any unexpired rotation aliases (lazily dropping expired ones). During
	 * the grace window a subscribe / frame under the OLD token lands on the
	 * NEW token's channel; after expiry the old token is an unknown key.
	 */
	resolveKey(key: string): string {
		let current = key;
		for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
			const alias = this.#aliases.get(current);
			if (!alias) return current;
			if (alias.expiresAt <= this.#now()) {
				this.#aliases.delete(current);
				return current;
			}
			if (alias.to === key) return current; // cycle guard
			current = alias.to;
		}
		return current;
	}

	/**
	 * Stage 10.11 — apply a routing-token rotation: every current subscriber
	 * of `from` is moved onto `to` (in-flight peers keep receiving frames
	 * without a re-subscribe), and `from → to` is aliased until `expiresAt`.
	 */
	applyRotation(from: string, to: string, expiresAt: number): void {
		if (from === to) return;
		const fromSet = this.#connectionsByEntity.get(from);
		if (fromSet) {
			for (const connId of [...fromSet]) {
				this.unsubscribe(connId, from);
				this.subscribe(connId, to);
			}
		}
		this.#aliases.set(from, { to, expiresAt });
	}

	subscribe(connId: string, rawEntityId: string): void {
		const entityId = this.resolveKey(rawEntityId);
		let set = this.#connectionsByEntity.get(entityId);
		if (!set) {
			set = new Set<string>();
			this.#connectionsByEntity.set(entityId, set);
		}
		set.add(connId);
		let entitySet = this.#entitiesByConnection.get(connId);
		if (!entitySet) {
			entitySet = new Set<string>();
			this.#entitiesByConnection.set(connId, entitySet);
		}
		entitySet.add(entityId);
	}

	unsubscribe(connId: string, rawEntityId: string): void {
		const entityId = this.resolveKey(rawEntityId);
		const set = this.#connectionsByEntity.get(entityId);
		if (set) {
			set.delete(connId);
			if (set.size === 0) this.#connectionsByEntity.delete(entityId);
		}
		const entitySet = this.#entitiesByConnection.get(connId);
		if (entitySet) {
			entitySet.delete(entityId);
			if (entitySet.size === 0) this.#entitiesByConnection.delete(connId);
		}
	}

	dropConnection(connId: string): void {
		const entities = this.#entitiesByConnection.get(connId);
		if (!entities) return;
		for (const entityId of entities) {
			const set = this.#connectionsByEntity.get(entityId);
			if (set) {
				set.delete(connId);
				if (set.size === 0) this.#connectionsByEntity.delete(entityId);
			}
		}
		this.#entitiesByConnection.delete(connId);
	}

	/**
	 * Subscribers for `entityId` excluding `excludeConnId` (the sender).
	 * Returns a fresh array — the caller may mutate the set during fan-out.
	 */
	subscribersFor(entityId: string, excludeConnId: string): string[] {
		const set = this.#connectionsByEntity.get(entityId);
		if (!set) return [];
		const out: string[] = [];
		for (const id of set) {
			if (id !== excludeConnId) out.push(id);
		}
		return out;
	}

	/**
	 * Peek the routing header, fan-out the (untouched) frame bytes to
	 * every OTHER subscriber, and append one audit entry per delivery.
	 *
	 * The caller is responsible for the actual socket-write — the router
	 * is pure logic. We return the recipient list so the server-loop
	 * stays a thin wrapper around the routing decision.
	 */
	route(
		fromConnId: string,
		frame: Uint8Array,
		send: (toConnId: string, frame: Uint8Array) => void,
	): RouteResult {
		let header: RoutingHeader;
		try {
			const peeked = peekRoutingHeader(frame);
			header = peeked.header;
		} catch {
			this.#malformedDropped += 1;
			return { delivered: 0, dropped: 1, header: null, routingKey: null };
		}
		// Collab-C5 — fan out by the optional `route` (a recipient inbox channel)
		// when present, else the entity channel; 10.11 — either way the key is
		// canonicalized through live rotation aliases, so a frame emitted under
		// a rotated-away token during grace lands on the new token's channel.
		const routingKey = this.resolveKey(header.route ?? header.entityId);
		// The audit records the (canonicalized) ENTITY channel, not the routing
		// label — the C5 contract. With routing tokens both are pseudonyms.
		const auditKey = this.resolveKey(header.entityId);
		const recipients = this.subscribersFor(routingKey, fromConnId);
		let delivered = 0;
		for (const toConnId of recipients) {
			try {
				send(toConnId, frame);
				this.#audit.record({
					fromConnId,
					toConnId,
					entityId: auditKey,
					kind: header.kind,
					bytes: frame.length,
				});
				delivered += 1;
			} catch {
				// A failed write must not block fan-out to siblings.
			}
		}
		return { delivered, dropped: 0, header, routingKey };
	}

	malformedDropped(): number {
		return this.#malformedDropped;
	}

	subscriberCount(entityId: string): number {
		return this.#connectionsByEntity.get(entityId)?.size ?? 0;
	}

	connectionEntities(connId: string): readonly string[] {
		const set = this.#entitiesByConnection.get(connId);
		return set ? [...set] : [];
	}
}
