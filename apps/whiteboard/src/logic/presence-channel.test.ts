// @vitest-environment jsdom
/**
 * Local presence channel (9.17.19): the minimal `AwarenessLike` the engine
 * runs on until the Stage-10 transport binds a real `Awareness`. Pins the
 * structural contract the downstream code depends on: change fan-out on
 * every state write, local/remote separation, null-removes, destroy. PRES-3
 * adds `presenceAwarenessFor` (the real shell transport / local fallback).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_FIELD } from "./presence";
import { createLocalAwareness, presenceAwarenessFor, randomClientId } from "./presence-channel";

function setBrainstorm(bs: unknown): void {
	(window as unknown as { brainstorm?: unknown }).brainstorm = bs;
}

describe("createLocalAwareness", () => {
	it("starts empty with a stable clientID", () => {
		const a = createLocalAwareness(42);
		expect(a.clientID).toBe(42);
		expect(a.getLocalState()).toBeNull();
		expect(a.getStates().size).toBe(0);
	});

	it("setLocalStateField merges into the local state and fires change", () => {
		const a = createLocalAwareness(1);
		const onChange = vi.fn();
		a.on("change", onChange);
		a.setLocalStateField(PRESENCE_FIELD, { boardId: "wb1" });
		a.setLocalStateField("other", 7);
		expect(a.getLocalState()).toEqual({ [PRESENCE_FIELD]: { boardId: "wb1" }, other: 7 });
		expect(a.getStates().get(1)).toEqual(a.getLocalState());
		expect(onChange).toHaveBeenCalledTimes(2);
	});

	it("setLocalState(null) removes the local entry", () => {
		const a = createLocalAwareness(1);
		a.setLocalState({ x: 1 });
		a.setLocalState(null);
		expect(a.getLocalState()).toBeNull();
		expect(a.getStates().size).toBe(0);
	});

	it("applyRemoteState adds / replaces / removes peers but never the local client", () => {
		const a = createLocalAwareness(1);
		const onChange = vi.fn();
		a.on("change", onChange);
		a.applyRemoteState(2, { hello: true });
		expect(a.getStates().get(2)).toEqual({ hello: true });
		a.applyRemoteState(2, null);
		expect(a.getStates().has(2)).toBe(false);
		a.setLocalState({ mine: 1 });
		a.applyRemoteState(1, { stomped: true });
		expect(a.getLocalState()).toEqual({ mine: 1 });
		expect(onChange).toHaveBeenCalledTimes(3);
	});

	it("off unsubscribes and destroy clears everything", () => {
		const a = createLocalAwareness(1);
		const onChange = vi.fn();
		a.on("change", onChange);
		a.off("change", onChange);
		a.applyRemoteState(2, { x: 1 });
		expect(onChange).not.toHaveBeenCalled();
		a.destroy();
		expect(a.getStates().size).toBe(0);
	});

	it("randomClientId yields 32-bit non-negative ints", () => {
		for (let i = 0; i < 20; i++) {
			const id = randomClientId();
			expect(Number.isInteger(id)).toBe(true);
			expect(id).toBeGreaterThanOrEqual(0);
			expect(id).toBeLessThanOrEqual(0xffffffff);
		}
	});
});

describe("presenceAwarenessFor (PRES-3)", () => {
	afterEach(() => setBrainstorm(undefined));

	it("no shell → a local single-device channel (nothing published)", () => {
		setBrainstorm(undefined);
		const a = presenceAwarenessFor("board-1");
		a.setLocalStateField(PRESENCE_FIELD, { id: "u" });
		expect(a.getStates().get(a.clientID)).toEqual({ [PRESENCE_FIELD]: { id: "u" } });
	});

	it("in shell → publishes local state to the presence service for the board", () => {
		const publish = vi.fn(() => Promise.resolve());
		const untrack = vi.fn(() => Promise.resolve());
		// Default to a no-op (not `| null`): TS widens a closure-assigned union var
		// back to its declared type, and the app's strict tsconfig then rejects
		// calling the `| null` half — a no-op default keeps it always callable.
		let peerCb: (peers: { clientId: number; state: Record<string, unknown> }[]) => void = () => {};
		setBrainstorm({
			services: { presence: { publish, untrack } },
			presence: {
				onPeers: (
					_id: string,
					cb: (p: { clientId: number; state: Record<string, unknown> }[]) => void,
				) => {
					peerCb = cb;
					return () => {};
				},
			},
		});

		const a = presenceAwarenessFor("board-entity-1");
		a.setLocalStateField(PRESENCE_FIELD, { id: "alice" });
		expect(publish).toHaveBeenCalledWith({
			entityId: "board-entity-1",
			type: "brainstorm/Whiteboard/v1",
			state: { [PRESENCE_FIELD]: { id: "alice" } },
		});

		// An inbound peer push lands as a remote state (drives the cursor overlay).
		peerCb([{ clientId: 7, state: { [PRESENCE_FIELD]: { id: "bob" } } }]);
		expect(a.getStates().get(7)).toEqual({ [PRESENCE_FIELD]: { id: "bob" } });

		// Tearing down clears our presence for peers (untrack for THIS board).
		a.destroy();
		expect(untrack).toHaveBeenCalledWith({ entityId: "board-entity-1" });
	});
});
