/**
 * Presence pure core (9.17.19): the encode half (`buildLocalPresence`) and
 * the apply half (`coercePresence` hardening + `presencePeers` derivation
 * + `remoteSelectionByNode`). Remote payloads are untrusted — the apply
 * tests are the security surface.
 */

import { PEER_COLORS } from "@brainstorm-os/sdk/peer-presence";
import { describe, expect, it } from "vitest";
import {
	PRESENCE_FIELD,
	PRESENCE_SELECTION_CAP,
	buildLocalPresence,
	coercePresence,
	presencePeers,
	remoteSelectionByNode,
} from "./presence";

describe("buildLocalPresence (encode)", () => {
	it("publishes a deterministic palette colour, the board, cursor and selection", () => {
		const p = buildLocalPresence({
			clientId: 7,
			name: "Mira",
			boardId: "wb1",
			cursor: { x: 10, y: 20 },
			selection: new Set(["n1", "n2"]),
		});
		expect(PEER_COLORS).toContain(p.color);
		expect(p).toMatchObject({ name: "Mira", boardId: "wb1", cursor: { x: 10, y: 20 } });
		expect(p.selection).toEqual(["n1", "n2"]);
	});

	it("caps the published selection", () => {
		const huge = Array.from({ length: PRESENCE_SELECTION_CAP + 50 }, (_, i) => `n${i}`);
		const p = buildLocalPresence({
			clientId: 1,
			name: "x",
			boardId: "wb1",
			cursor: null,
			selection: huge,
		});
		expect(p.selection).toHaveLength(PRESENCE_SELECTION_CAP);
	});
});

describe("coercePresence (apply hardening)", () => {
	it("rejects non-objects and missing boardId", () => {
		expect(coercePresence(null, 1)).toBeNull();
		expect(coercePresence("x", 1)).toBeNull();
		expect(coercePresence({ name: "a" }, 1)).toBeNull();
		expect(coercePresence({ boardId: "" }, 1)).toBeNull();
	});

	it("sanitizes a hostile name (controls / bidi) and clamps it", () => {
		const rlo = String.fromCharCode(0x202e);
		const hostile = `Evil${rlo}${"x".repeat(100)}`;
		const p = coercePresence({ boardId: "wb1", name: hostile }, 1);
		expect(p?.name).not.toContain(rlo);
		expect((p?.name ?? "").length).toBeLessThanOrEqual(40);
	});

	it("falls back to the deterministic colour when the published one is not plain hex", () => {
		const evil = coercePresence({ boardId: "wb1", color: "url(javascript:alert(1))" }, 5);
		expect(evil?.color).toMatch(/^#[0-9a-f]{6}$/);
		const ok = coercePresence({ boardId: "wb1", color: "#A1B2C3" }, 5);
		expect(ok?.color).toBe("#A1B2C3");
	});

	it("drops non-finite cursors and filters/caps the selection", () => {
		const p = coercePresence(
			{
				boardId: "wb1",
				cursor: { x: Number.NaN, y: 3 },
				selection: ["n1", 5, "", "n2", ...Array.from({ length: 300 }, (_, i) => `s${i}`)],
			},
			1,
		);
		expect(p?.cursor).toBeNull();
		expect(p?.selection.slice(0, 2)).toEqual(["n1", "n2"]);
		expect(p?.selection.length).toBeLessThanOrEqual(PRESENCE_SELECTION_CAP);
	});
});

describe("presencePeers (apply derivation)", () => {
	const state = (boardId: string, name: string): Record<string, unknown> => ({
		[PRESENCE_FIELD]: { boardId, name, cursor: { x: 1, y: 2 }, selection: [] },
	});

	it("excludes the local client, other boards, and malformed states", () => {
		const states = new Map<number, Record<string, unknown> | null>([
			[1, state("wb1", "me")],
			[2, state("wb1", "peer")],
			[3, state("wb2", "elsewhere")],
			[4, { [PRESENCE_FIELD]: "garbage" }],
			[5, null],
		]);
		const peers = presencePeers(states, 1, "wb1");
		expect(peers).toHaveLength(1);
		expect(peers[0]?.clientId).toBe(2);
		expect(peers[0]?.name).toBe("peer");
	});

	it("orders peers by clientId so paints are stable", () => {
		const states = new Map<number, Record<string, unknown> | null>([
			[9, state("wb1", "nine")],
			[2, state("wb1", "two")],
		]);
		expect(presencePeers(states, 0, "wb1").map((p) => p.clientId)).toEqual([2, 9]);
	});
});

describe("remoteSelectionByNode", () => {
	it("maps node → first claiming peer", () => {
		const peers = presencePeers(
			new Map<number, Record<string, unknown> | null>([
				[2, { [PRESENCE_FIELD]: { boardId: "wb1", selection: ["a", "b"] } }],
				[3, { [PRESENCE_FIELD]: { boardId: "wb1", selection: ["b", "c"] } }],
			]),
			0,
			"wb1",
		);
		const byNode = remoteSelectionByNode(peers);
		expect(byNode.get("a")?.clientId).toBe(2);
		expect(byNode.get("b")?.clientId).toBe(2);
		expect(byNode.get("c")?.clientId).toBe(3);
	});
});
