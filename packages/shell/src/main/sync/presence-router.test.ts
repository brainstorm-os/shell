/**
 * PRES-2b — the presence router: the sandbox-facing half. Two parts:
 *   1. `deliverPresencePeersToApps` — the outbound fan-out (mirrors
 *      `ydoc-remote-broadcast.test`: targeted, skips destroyed, prunes dead).
 *   2. Two routers over a loopback relay converge, and each pushes the OTHER's
 *      presence to exactly its subscribed app windows.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppWindow } from "../apps/launcher";
import { AWARENESS_DEBOUNCE_MS } from "./awareness-broadcaster";
import type { PipelineContext } from "./envelope-pipeline";
import { PresenceManager } from "./presence-manager";
import {
	APP_PRESENCE_PEERS_CHANNEL,
	type PresencePeersPayload,
	PresenceRouter,
	deliverPresencePeersToApps,
} from "./presence-router";

function fakeAppWindow(
	appId: string,
	opts: { destroyed?: boolean } = {},
): { win: AppWindow; send: ReturnType<typeof vi.fn> } {
	const destroyed = opts.destroyed === true;
	const send = vi.fn();
	const win = {
		appId,
		windowId: "main",
		webContentsId: 0,
		webContents: { send, isDestroyed: () => destroyed },
	} as unknown as AppWindow;
	return { win, send };
}

describe("deliverPresencePeersToApps", () => {
	const peers = [{ clientId: 7, state: { presence: { id: "u", name: "U" } } }];

	it("delivers only to windows in targetApps", () => {
		const target = fakeAppWindow("io.brainstorm.whiteboard");
		const other = fakeAppWindow("io.brainstorm.graph");
		deliverPresencePeersToApps([target.win, other.win], "ent_1", peers, ["io.brainstorm.whiteboard"]);
		expect(target.send).toHaveBeenCalledWith(APP_PRESENCE_PEERS_CHANNEL, {
			entityId: "ent_1",
			peers,
		});
		expect(other.send).not.toHaveBeenCalled();
	});

	it("skips destroyed windows and returns them as dead for pruning", () => {
		const dead = fakeAppWindow("io.brainstorm.whiteboard", { destroyed: true });
		const live = fakeAppWindow("io.brainstorm.graph");
		const deadApps = deliverPresencePeersToApps([dead.win, live.win], "ent_1", peers, [
			"io.brainstorm.whiteboard",
			"io.brainstorm.graph",
		]);
		expect(dead.send).not.toHaveBeenCalled();
		expect(live.send).toHaveBeenCalledTimes(1);
		expect(deadApps).toEqual(["io.brainstorm.whiteboard"]);
	});

	it("is a no-op with no targets", () => {
		const win = fakeAppWindow("io.brainstorm.whiteboard");
		expect(deliverPresencePeersToApps([win.win], "ent_1", peers, [])).toEqual([]);
		expect(win.send).not.toHaveBeenCalled();
	});
});

const stub = {} as PipelineContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(AWARENESS_DEBOUNCE_MS + 30);

const APP = "io.brainstorm.whiteboard";
const ENT = "ent_shared";
const alice = { presence: { id: "u_alice", name: "Alice", color: "#e8590c" } };
const bob = { presence: { id: "u_bob", name: "Bob", color: "#2f6df6" } };

/** The peer states in the LAST payload an app window received. */
function lastPeerStates(send: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
	const call = send.mock.calls.at(-1);
	if (!call) return [];
	const payload = call[1] as PresencePeersPayload;
	return payload.peers.map((p) => p.state);
}

describe("PresenceRouter — two devices converge + fan out to app windows", () => {
	let routerA: PresenceRouter;
	let routerB: PresenceRouter;
	let winA: ReturnType<typeof fakeAppWindow>;
	let winB: ReturnType<typeof fakeAppWindow>;

	afterEach(() => {
		routerA?.dispose();
		routerB?.dispose();
	});

	function wirePair(): void {
		// Each manager's relay emit is delivered to the OTHER router's inbound — a
		// loopback standing in for the DEK-sealed relay round-trip.
		const managerA = new PresenceManager({
			pipeline: stub,
			emit: async (e, u) => routerB.applyInbound(e, u),
		});
		const managerB = new PresenceManager({
			pipeline: stub,
			emit: async (e, u) => routerA.applyInbound(e, u),
		});
		winA = fakeAppWindow(APP);
		winB = fakeAppWindow(APP);
		routerA = new PresenceRouter({ manager: managerA, getAppWindows: () => [winA.win] });
		routerB = new PresenceRouter({ manager: managerB, getAppWindows: () => [winB.win] });
	}

	it("pushes each device's presence to the other's subscribed app window", async () => {
		wirePair();
		routerA.publish(APP, ENT, alice);
		routerB.publish(APP, ENT, bob);
		await settle();

		expect(lastPeerStates(winB.send)).toContainEqual(alice);
		expect(lastPeerStates(winA.send)).toContainEqual(bob);
		// No self: A's window never sees alice among the remote peers.
		expect(lastPeerStates(winA.send)).not.toContainEqual(alice);
	});

	it("clearing presence (null) removes us from the peer's window", async () => {
		wirePair();
		routerA.publish(APP, ENT, alice);
		routerB.publish(APP, ENT, bob);
		await settle();
		expect(lastPeerStates(winB.send)).toContainEqual(alice);

		routerA.publish(APP, ENT, null);
		await settle();
		expect(lastPeerStates(winB.send)).not.toContainEqual(alice);
	});

	it("untrack tears down the entity so the peer drops us immediately", async () => {
		wirePair();
		routerA.publish(APP, ENT, alice);
		routerB.publish(APP, ENT, bob);
		await settle();
		expect(lastPeerStates(winB.send)).toContainEqual(alice);

		routerA.untrack(APP, ENT);
		await sleep(10);
		expect(lastPeerStates(winB.send)).not.toContainEqual(alice);
	});

	it("only the subscribed app window receives pushes (audience = publishers)", async () => {
		wirePair();
		// B never publishes for ENT → its window is not in the audience.
		routerA.publish(APP, ENT, alice);
		await settle();
		expect(winB.send).not.toHaveBeenCalled();
	});
});
