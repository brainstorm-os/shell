/**
 * PRES-1 (design [74](../../../../docs/data/74-presence-transport.md)) — the
 * app-side presence client.
 *
 * `AwarenessLike` is a small state map (who's-here per entity), deliberately
 * NOT the `y-protocols` implementation — the sandbox app bundle stays light and
 * the y-protocols wire format lives in the MAIN-process `AwarenessBroadcaster`,
 * which translates. So this layer only needs a transport that ferries **its own
 * local state out** and **peer states in**:
 *
 *   local state change ──send(clientID, state)──▶ transport ──▶ main ──▶ relay
 *   relay ──▶ main ──▶ transport ──subscribe(cb)──▶ applyRemoteState(peer)
 *
 * `createSyncedAwareness(transport)` is the sanctioned replacement for a
 * per-app `createLocalAwareness`: with the local no-transport pair it behaves
 * identically (single-device), and with the real `presence` IPC transport
 * (PRES-2) peers light up cross-device — no downstream change (publisher, peer
 * derivation, `<PresenceStack>`).
 */

import type { AwarenessLike, AwarenessState } from "./awareness";

/** A session-unique client id: 32-bit random, mirroring Yjs's `clientID`. */
export function randomClientId(): number {
	return Math.floor(Math.random() * 0xffffffff);
}

/** An `AwarenessLike` that also accepts inbound peer states and can be torn
 *  down — the shape a transport (or a dev hook) drives. */
export type LocalAwareness = AwarenessLike & {
	/** Apply a peer's state (`null` removes them — the y-protocols dispose
	 *  convention). Ignores our own `clientID`. */
	applyRemoteState(clientId: number, state: AwarenessState | null): void;
	/** Drop every listener + remote state. */
	destroy(): void;
};

/**
 * In-process presence with no transport — a pure `AwarenessLike` state map.
 * Every device sees only itself until a transport feeds peers through
 * `applyRemoteState`. Shared home for what apps used to hand-roll.
 */
export function createLocalAwareness(clientID: number = randomClientId()): LocalAwareness {
	const states = new Map<number, AwarenessState>();
	const listeners = new Set<() => void>();
	const emit = (): void => {
		for (const listener of [...listeners]) listener();
	};
	return {
		clientID,
		getLocalState() {
			return states.get(clientID) ?? null;
		},
		setLocalState(state) {
			if (state === null) states.delete(clientID);
			else states.set(clientID, state);
			emit();
		},
		setLocalStateField(field, value) {
			const next = { ...(states.get(clientID) ?? {}), [field]: value };
			states.set(clientID, next);
			emit();
		},
		getStates() {
			return new Map(states);
		},
		on(event, handler) {
			if (event === "change") listeners.add(handler);
		},
		off(event, handler) {
			if (event === "change") listeners.delete(handler);
		},
		applyRemoteState(clientId, state) {
			if (clientId === clientID) return;
			if (state === null) states.delete(clientId);
			else states.set(clientId, state);
			emit();
		},
		destroy() {
			states.clear();
			listeners.clear();
		},
	};
}

/**
 * The wire the synced awareness rides. `send` publishes THIS device's presence
 * (the whole local state, or `null` to clear); `subscribe` delivers peer states
 * inbound (returns an unsubscribe). Injected so the client is testable against a
 * loopback and swappable for the real `presence` IPC transport (PRES-2).
 */
export type PresenceTransport = {
	send(clientID: number, state: AwarenessState | null): void;
	subscribe(handler: (clientID: number, state: AwarenessState | null) => void): () => void;
};

/** A `LocalAwareness` whose local changes publish over `transport` and whose
 *  peers arrive over it. `destroy` clears our presence for peers first. */
export function createSyncedAwareness(
	transport: PresenceTransport,
	clientID: number = randomClientId(),
): LocalAwareness {
	const local = createLocalAwareness(clientID);
	const unsubscribe = transport.subscribe((peerId, state) => local.applyRemoteState(peerId, state));
	const publish = (): void => transport.send(clientID, local.getLocalState());
	return {
		...local,
		setLocalState(state) {
			local.setLocalState(state);
			publish();
		},
		setLocalStateField(field, value) {
			local.setLocalStateField(field, value);
			publish();
		},
		destroy() {
			transport.send(clientID, null);
			unsubscribe();
			local.destroy();
		},
	};
}

/**
 * A connected pair of in-memory transports — each `send` delivers to the
 * OTHER's subscribers (never an echo to itself). For tests + the local
 * no-relay path; the real transport is the `presence` IPC route (PRES-2).
 */
export function createLoopbackTransports(): [PresenceTransport, PresenceTransport] {
	const subsA = new Set<(id: number, s: AwarenessState | null) => void>();
	const subsB = new Set<(id: number, s: AwarenessState | null) => void>();
	const make = (
		mine: Set<(id: number, s: AwarenessState | null) => void>,
		theirs: Set<(id: number, s: AwarenessState | null) => void>,
	): PresenceTransport => ({
		send(clientID, state) {
			for (const cb of [...theirs]) cb(clientID, state);
		},
		subscribe(handler) {
			mine.add(handler);
			return () => mine.delete(handler);
		},
	});
	return [make(subsA, subsB), make(subsB, subsA)];
}
