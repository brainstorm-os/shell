import { describe, expect, it } from "vitest";
import type { AwarenessState } from "./awareness";
import {
	createLocalAwareness,
	createLoopbackTransports,
	createSyncedAwareness,
} from "./synced-awareness";

const presence = (id: string): AwarenessState => ({ presence: { id, name: id, color: "#2f6df6" } });

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
