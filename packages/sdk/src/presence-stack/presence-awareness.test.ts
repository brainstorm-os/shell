import { describe, expect, it } from "vitest";
import { PRESENCE_STATE_KEY, awarenessToPeers, peerFromState } from "./presence-awareness";

const payload = (id: string, name: string, color = "#2f6df6", avatarRef?: string) => ({
	[PRESENCE_STATE_KEY]: { id, name, color, ...(avatarRef ? { avatarRef } : {}) },
});

describe("peerFromState", () => {
	it("extracts a valid peer from the presence field", () => {
		expect(peerFromState(payload("u1", "Alice", "#e8590c", "brainstorm://asset/a"))).toEqual({
			id: "u1",
			name: "Alice",
			color: "#e8590c",
			avatarRef: "brainstorm://asset/a",
		});
	});

	it("omits avatarRef when absent", () => {
		expect(peerFromState(payload("u1", "Alice"))).toEqual({
			id: "u1",
			name: "Alice",
			color: "#2f6df6",
		});
	});

	it("returns null for a state with no presence payload (e.g. cursor-only)", () => {
		expect(peerFromState({ cursor: { x: 1 } })).toBeNull();
		expect(peerFromState({})).toBeNull();
		expect(peerFromState(null)).toBeNull();
	});

	it("returns null when a required field is missing or blank", () => {
		expect(peerFromState({ [PRESENCE_STATE_KEY]: { name: "A", color: "#000" } })).toBeNull(); // no id
		expect(peerFromState({ [PRESENCE_STATE_KEY]: { id: "u1", name: "", color: "#000" } })).toBeNull();
		expect(peerFromState({ [PRESENCE_STATE_KEY]: { id: "u1", name: "A", color: 123 } })).toBeNull();
	});
});

describe("awarenessToPeers", () => {
	it("maps other clients' states to peers, excluding the local client", () => {
		const states = new Map<number, unknown>([
			[1, payload("self", "Me")],
			[2, payload("u2", "Bob")],
			[3, payload("u3", "Cy")],
		]);
		const peers = awarenessToPeers(states, 1);
		expect(peers.map((p) => p.id)).toEqual(["u2", "u3"]);
	});

	it("skips clients with no valid presence payload", () => {
		const states = new Map<number, unknown>([
			[2, payload("u2", "Bob")],
			[3, { cursor: { x: 5 } }], // cursor-only, no presence
			[4, null],
		]);
		expect(awarenessToPeers(states, 1).map((p) => p.id)).toEqual(["u2"]);
	});

	it("keeps a member's multiple tabs as separate entries (capPresence de-dupes by id later)", () => {
		const states = new Map<number, unknown>([
			[2, payload("u2", "Bob")],
			[5, payload("u2", "Bob")], // same member, second tab (distinct clientId)
		]);
		// awarenessToPeers doesn't dedup — that's capPresence's job; both come through.
		expect(awarenessToPeers(states, 1).map((p) => p.id)).toEqual(["u2", "u2"]);
	});

	it("is empty when only the local client is present", () => {
		expect(awarenessToPeers(new Map([[1, payload("self", "Me")]]), 1)).toEqual([]);
	});
});
