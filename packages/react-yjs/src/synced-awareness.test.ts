import { describe, expect, it } from "vitest";
import type { AwarenessState } from "./awareness";
import {
	type PresenceHost,
	type PresenceHostPeer,
	createLocalAwareness,
	createLoopbackTransports,
	createPresenceTransport,
	createSyncedAwareness,
} from "./synced-awareness";

const presence = (id: string): AwarenessState => ({ presence: { id, name: id, color: "#2f6df6" } });

/** A `PresenceHost` whose peer push we can drive by hand. */
function fakeHost() {
	const published: (AwarenessState | null)[] = [];
	let untracked = 0;
	let offCount = 0;
	let cb: ((peers: PresenceHostPeer[]) => void) | null = null;
	const host: PresenceHost = {
		publish: (state) => {
			published.push(state);
		},
		untrack: () => {
			untracked++;
		},
		onPeers: (handler) => {
			cb = handler;
			return () => {
				offCount++;
				cb = null;
			};
		},
	};
	return {
		host,
		published,
		get untracked() {
			return untracked;
		},
		get offCount() {
			return offCount;
		},
		pushPeers: (peers: PresenceHostPeer[]) => cb?.(peers),
	};
}

describe("createLocalAwareness (no transport)", () => {
	it("holds only its own state; a peer arrives via applyRemoteState", () => {
		const a = createLocalAwareness(1);
		a.setLocalStateField("presence", presence("u1").presence);
		expect([...a.getStates().keys()]).toEqual([1]);
		a.applyRemoteState(2, presence("u2"));
		expect(a.getStates().get(2)).toEqual(presence("u2"));
		a.applyRemoteState(2, null); // peer left
		expect(a.getStates().has(2)).toBe(false);
	});

	it("applyRemoteState ignores our own client id", () => {
		const a = createLocalAwareness(7);
		a.applyRemoteState(7, presence("spoof"));
		expect(a.getStates().has(7)).toBe(false);
	});
});

describe("createSyncedAwareness over a loopback", () => {
	it("two clients converge — each sees the other's presence, not an echo of itself", () => {
		const [tA, tB] = createLoopbackTransports();
		const a = createSyncedAwareness(tA, 1);
		const b = createSyncedAwareness(tB, 2);

		a.setLocalStateField("presence", presence("alice").presence);
		b.setLocalStateField("presence", presence("bob").presence);

		// A sees B and itself; B sees A and itself.
		expect(new Set(a.getStates().keys())).toEqual(new Set([1, 2]));
		expect(a.getStates().get(2)).toEqual(presence("bob"));
		expect(b.getStates().get(1)).toEqual(presence("alice"));
		// No self-echo: A's own state came from its own set, not a wire round-trip
		// duplicating it under a different id.
		expect(a.getStates().size).toBe(2);
	});

	it("fires the change listener on an inbound peer update (drives useAwareness)", () => {
		const [tA, tB] = createLoopbackTransports();
		const a = createSyncedAwareness(tA, 1);
		const b = createSyncedAwareness(tB, 2);
		let ticks = 0;
		a.on("change", () => {
			ticks++;
		});
		b.setLocalStateField("presence", presence("bob").presence);
		expect(ticks).toBeGreaterThan(0);
		expect(a.getStates().get(2)).toEqual(presence("bob"));
	});

	it("destroy() clears our presence for peers and stops receiving", () => {
		const [tA, tB] = createLoopbackTransports();
		const a = createSyncedAwareness(tA, 1);
		const b = createSyncedAwareness(tB, 2);
		a.setLocalStateField("presence", presence("alice").presence);
		expect(b.getStates().has(1)).toBe(true);

		a.destroy(); // publishes null for client 1
		expect(b.getStates().has(1)).toBe(false);

		// After destroy, a further peer update doesn't reach A.
		b.setLocalStateField("presence", { id: "bob", name: "bob2", color: "#2f6df6" });
		expect(a.getStates().size).toBe(0);
	});
});

describe("createPresenceTransport (host adapter)", () => {
	it("send publishes the local state (client id is the main proxy's, not ours)", () => {
		const h = fakeHost();
		const transport = createPresenceTransport(h.host);
		transport.send(1, presence("alice"));
		transport.send(1, null);
		expect(h.published).toEqual([presence("alice"), null]);
	});

	it("subscribe delivers each peer's state to the handler", () => {
		const h = fakeHost();
		const transport = createPresenceTransport(h.host);
		const seen: Array<[number, AwarenessState | null]> = [];
		transport.subscribe((id, state) => seen.push([id, state]));
		h.pushPeers([
			{ clientId: 7, state: presence("bob") },
			{ clientId: 9, state: presence("cara") },
		]);
		expect(seen).toContainEqual([7, presence("bob")]);
		expect(seen).toContainEqual([9, presence("cara")]);
	});

	it("turns a peer dropping out of the next snapshot into applyRemoteState(id, null)", () => {
		const h = fakeHost();
		const transport = createPresenceTransport(h.host);
		const seen: Array<[number, AwarenessState | null]> = [];
		transport.subscribe((id, state) => seen.push([id, state]));
		h.pushPeers([
			{ clientId: 7, state: presence("bob") },
			{ clientId: 9, state: presence("cara") },
		]);
		seen.length = 0;
		h.pushPeers([{ clientId: 7, state: presence("bob") }]); // cara (9) left
		expect(seen).toContainEqual([9, null]);
		expect(seen).not.toContainEqual([7, null]);
	});

	it("unsubscribe detaches the push and clears our presence (untrack)", () => {
		const h = fakeHost();
		const transport = createPresenceTransport(h.host);
		const unsub = transport.subscribe(() => {});
		unsub();
		expect(h.offCount).toBe(1);
		expect(h.untracked).toBe(1);
	});

	it("drives a real synced awareness end-to-end over the host", () => {
		const h = fakeHost();
		const a = createSyncedAwareness(createPresenceTransport(h.host), 1);
		a.setLocalStateField("presence", presence("alice").presence);
		expect(h.published.at(-1)).toEqual(presence("alice"));
		// A peer push lands as a remote state on the awareness (drives useAwareness).
		h.pushPeers([{ clientId: 7, state: presence("bob") }]);
		expect(a.getStates().get(7)).toEqual(presence("bob"));
		// Then the peer leaves.
		h.pushPeers([]);
		expect(a.getStates().has(7)).toBe(false);
	});
});
