/**
 * PRES-2 — the main-side presence bridge, proven over a loopback: two managers
 * (two vaults) converge on each other's presence through the AwarenessBroadcaster,
 * with the relay `emit` looped straight into the other's `applyInbound`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { AWARENESS_DEBOUNCE_MS } from "./awareness-broadcaster";
import type { PipelineContext } from "./envelope-pipeline";
import { PresenceManager } from "./presence-manager";

const stub = {} as PipelineContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(AWARENESS_DEBOUNCE_MS + 30);

const ENT = "ent_shared";
const alice = { presence: { id: "u_alice", name: "Alice", color: "#e8590c" } };
const bob = { presence: { id: "u_bob", name: "Bob", color: "#2f6df6" } };

describe("PresenceManager — relay bridge (PRES-2)", () => {
	let a: PresenceManager;
	let b: PresenceManager;

	afterEach(() => {
		a?.dispose();
		b?.dispose();
	});

	function wirePair(): void {
		// Each manager's relay emit is delivered straight to the other's inbound —
		// a loopback standing in for the DEK-sealed relay round-trip.
		a = new PresenceManager({ pipeline: stub, emit: async (e, u) => b.applyInbound(e, u) });
		b = new PresenceManager({ pipeline: stub, emit: async (e, u) => a.applyInbound(e, u) });
	}

	it("two managers converge — each sees the other's presence, not its own", async () => {
		wirePair();
		a.setLocal(ENT, alice);
		b.setLocal(ENT, bob);
		await settle();

		const aPeers = [...a.remoteStates(ENT).values()];
		const bPeers = [...b.remoteStates(ENT).values()];
		expect(aPeers).toContainEqual(bob);
		expect(bPeers).toContainEqual(alice);
		// No self: a's remote set excludes its own proxy (only bob).
		expect(aPeers).not.toContainEqual(alice);
		expect(aPeers).toHaveLength(1);
	});

	it("clearing local presence (null) removes us from the peer's view", async () => {
		wirePair();
		a.setLocal(ENT, alice);
		await settle();
		expect([...b.remoteStates(ENT).values()]).toContainEqual(alice);

		a.setLocal(ENT, null);
		await settle();
		expect([...b.remoteStates(ENT).values()]).not.toContainEqual(alice);
	});

	it("untrack broadcasts a final null so the peer drops us immediately", async () => {
		wirePair();
		a.setLocal(ENT, alice);
		await settle();
		expect(b.remoteStates(ENT).size).toBe(1);

		a.untrack(ENT); // emits null synchronously (dispose path, no debounce wait)
		await sleep(10);
		expect(b.remoteStates(ENT).size).toBe(0);
	});

	it("onChange fires on the peer side when a remote presence lands", async () => {
		wirePair();
		let ticks = 0;
		b.onChange(ENT, () => {
			ticks++;
		});
		a.setLocal(ENT, alice);
		await settle();
		expect(ticks).toBeGreaterThan(0);
	});

	it("keeps entities isolated — presence on one doesn't leak to another", async () => {
		wirePair();
		a.setLocal("ent_A", alice);
		await settle();
		expect(b.remoteStates("ent_A").size).toBe(1);
		expect(b.remoteStates("ent_B").size).toBe(0);
	});
});
