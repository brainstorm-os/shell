import { PEER_COLORS } from "@brainstorm/sdk/peer-presence";
import { describe, expect, it } from "vitest";
import {
	PRESENCE_FIELD,
	buildLocalPresence,
	coercePresence,
	presencePeers,
	remoteSelectionByNode,
} from "./presence";

describe("graph presence codec", () => {
	it("buildLocalPresence caps selection and assigns colour", () => {
		const payload = buildLocalPresence({
			clientId: 3,
			name: "Ada",
			graphId: "g1",
			cursor: { x: 10, y: 20 },
			selection: ["n1", "n2"],
		});
		expect(payload.color).toBe(PEER_COLORS[3 % PEER_COLORS.length]);
		expect(payload.selection).toEqual(["n1", "n2"]);
	});

	it("coercePresence drops malformed remote payloads", () => {
		expect(coercePresence(null, 1)).toBeNull();
		expect(coercePresence({ graphId: "" }, 1)).toBeNull();
	});

	it("presencePeers filters by graphId and excludes self", () => {
		const states = new Map<number, Record<string, unknown> | null>([
			[
				1,
				{
					[PRESENCE_FIELD]: buildLocalPresence({
						clientId: 1,
						name: "Me",
						graphId: "g1",
						cursor: null,
						selection: [],
					}),
				},
			],
			[
				2,
				{
					[PRESENCE_FIELD]: buildLocalPresence({
						clientId: 2,
						name: "Peer",
						graphId: "g1",
						cursor: { x: 1, y: 2 },
						selection: ["n1"],
					}),
				},
			],
			[
				3,
				{
					[PRESENCE_FIELD]: buildLocalPresence({
						clientId: 3,
						name: "Other",
						graphId: "g2",
						cursor: null,
						selection: [],
					}),
				},
			],
		]);
		const peers = presencePeers(states, 1, "g1");
		expect(peers.map((p) => p.clientId)).toEqual([2]);
	});

	it("remoteSelectionByNode is first-wins per node", () => {
		const peers = [
			{ clientId: 2, name: "A", color: "#111", graphId: "g1", cursor: null, selection: ["n1"] },
			{ clientId: 5, name: "B", color: "#222", graphId: "g1", cursor: null, selection: ["n1", "n2"] },
		];
		const map = remoteSelectionByNode(peers);
		expect(map.get("n1")?.clientId).toBe(2);
		expect(map.get("n2")?.clientId).toBe(5);
	});
});
