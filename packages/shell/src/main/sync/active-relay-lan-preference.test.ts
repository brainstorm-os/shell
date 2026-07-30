/**
 * P2P-1 — exclusive transport selection, LAN preferred.
 *
 * The property under test is not "LAN is tried first". It is that while a LAN
 * peer is carrying sync, the relay is ABSENT from the path: not deprioritised,
 * not idling in parallel, not racing. Running both would hand the relay exactly
 * the timing and volume metadata that LAN mode exists to avoid, and would make
 * the sync surface's "no server" line a false privacy claim rather than a
 * cosmetic slip. So these assert on which URL the single live port was built
 * for, and on the vault reader not even being consulted.
 */

import { describe, expect, it, vi } from "vitest";
import { ActiveRelayKind, ActiveRelayOrchestrator, type SyncRelayTarget } from "./active-relay";
import type { RelayPort } from "./relay-port";

class FakePort implements RelayPort {
	closed = false;
	constructor(readonly url: string) {}
	send(): void {}
	onFrame(): void {}
	offFrame(): void {}
	close(): void {
		this.closed = true;
	}
}

const SESSION = { vaultId: "v1", vaultPath: "/tmp/vault" };
const RELAY_URL = "wss://relay.example";
const PEER_URL = "ws://192.168.1.20:51820";

function orchestrator(lanTarget: () => SyncRelayTarget | null) {
	const built: { url: string; lan: boolean }[] = [];
	const readSyncRelayUrl = vi.fn(async () => ({ url: RELAY_URL, lan: false }));
	const orch = new ActiveRelayOrchestrator({
		makeRelayPort: (url, target) => {
			built.push({ url, lan: target.lan });
			return new FakePort(url);
		},
		readSyncRelayUrl,
		resolveLanTarget: lanTarget,
	});
	return { orch, built, readSyncRelayUrl };
}

describe("LAN-preferred exclusive selection", () => {
	it("uses the relay when there is no LAN peer", async () => {
		const { orch, built } = orchestrator(() => null);
		await orch.onSessionChanged(SESSION);
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
		expect(built).toEqual([{ url: RELAY_URL, lan: false }]);
	});

	it("replaces the relay outright once a LAN peer is selected", async () => {
		let target: SyncRelayTarget | null = null;
		const { orch, built } = orchestrator(() => target);
		await orch.onSessionChanged(SESSION);

		target = { url: PEER_URL, lan: true };
		await orch.reconfigure();

		expect(orch.state().kind).toBe(ActiveRelayKind.Lan);
		expect(orch.state().syncRelayUrl).toBe(PEER_URL);
		// Exactly one live port, and it is the peer's.
		expect(built).toEqual([
			{ url: RELAY_URL, lan: false },
			{ url: PEER_URL, lan: true },
		]);
	});

	it("does not even read vault.json while a LAN peer is live", async () => {
		const { orch, readSyncRelayUrl } = orchestrator(() => ({ url: PEER_URL, lan: true }));
		await orch.onSessionChanged(SESSION);
		expect(readSyncRelayUrl).not.toHaveBeenCalled();
		expect(orch.state().kind).toBe(ActiveRelayKind.Lan);
	});

	it("falls back to the relay the moment the peer is dropped", async () => {
		let target: SyncRelayTarget | null = { url: PEER_URL, lan: true };
		const { orch, built } = orchestrator(() => target);
		await orch.onSessionChanged(SESSION);
		expect(orch.state().kind).toBe(ActiveRelayKind.Lan);

		target = null;
		await orch.reconfigure();
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
		expect(built.at(-1)).toEqual({ url: RELAY_URL, lan: false });
	});

	it("always builds a LAN target with the channel-bound trust model", async () => {
		// Provenance, not address inference (F-466): the resolver only ever
		// produces peer devices, so the flag is not negotiable at this seam.
		const { orch, built } = orchestrator(() => ({ url: PEER_URL, lan: false }));
		await orch.onSessionChanged(SESSION);
		expect(built).toEqual([{ url: PEER_URL, lan: true }]);
		expect(orch.state().kind).toBe(ActiveRelayKind.Lan);
	});

	it("fails CLOSED to the relay when the resolver throws", async () => {
		const { orch, built } = orchestrator(() => {
			throw new Error("coordinator not ready");
		});
		await orch.onSessionChanged(SESSION);
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
		expect(built).toEqual([{ url: RELAY_URL, lan: false }]);
	});

	it("ignores a resolver that returns a malformed target", async () => {
		const { orch } = orchestrator(() => ({ url: "", lan: true }));
		await orch.onSessionChanged(SESSION);
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
	});

	it("does not consult the LAN resolver with no session", async () => {
		const resolve = vi.fn(() => ({ url: PEER_URL, lan: true }));
		const { orch } = orchestrator(resolve);
		await orch.onSessionChanged(null);
		expect(orch.state().kind).toBe(ActiveRelayKind.Loopback);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("does not flap the port when the same peer resolves again", async () => {
		const { orch, built } = orchestrator(() => ({ url: PEER_URL, lan: true }));
		await orch.onSessionChanged(SESSION);
		await orch.reconfigure();
		await orch.reconfigure();
		expect(built).toHaveLength(1);
	});
});
