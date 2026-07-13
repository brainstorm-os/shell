// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { RemotePeer } from "../logic/presence";
import { renderPresenceOverlay } from "./presence-overlay";

const peer = (clientId: number, name: string): RemotePeer => ({
	clientId,
	name,
	color: "#3366ff",
	graphId: "g1",
	cursor: { x: 40, y: 60 },
	selection: ["n1"],
});

describe("renderPresenceOverlay", () => {
	it("paints cursor + selection for peers", () => {
		const layer = document.createElement("div");
		const nodes = new Map([["n1", { x: 100, y: 120, radiusPx: 14 }]]);
		renderPresenceOverlay(layer, [peer(2, "Ada")], nodes, (c) => ({ x: c.x, y: c.y }));
		expect(layer.querySelector(".graph__presence-cursor")).not.toBeNull();
		expect(layer.querySelector(".graph__presence-selection")).not.toBeNull();
	});

	it("clears when peers are empty", () => {
		const layer = document.createElement("div");
		layer.textContent = "stale";
		renderPresenceOverlay(layer, [], new Map(), (c) => c);
		expect(layer.textContent).toBe("");
	});
});
