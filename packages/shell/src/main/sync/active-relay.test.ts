/**
 * Stage 10.5c — `ActiveRelayOrchestrator` unit tests.
 *
 * Covers state transitions, listener / subscription migration across
 * port swaps, the no-flap path when reconfigure resolves to the same
 * transport, and the disposed-singleton contract.
 */

import { describe, expect, it, vi } from "vitest";
import {
	ActiveRelayKind,
	ActiveRelayOrchestrator,
	disposeActiveRelay,
	getActiveRelay,
	installActiveRelay,
} from "./active-relay";
import { LoopbackRelayPort, type RelayPort } from "./relay-port";

class FakePort implements RelayPort {
	readonly url: string | null;
	readonly listeners = new Set<(frame: Uint8Array) => void>();
	readonly subs = new Set<string>();
	closed = false;
	constructor(url: string | null = null) {
		this.url = url;
	}
	send(_frame: Uint8Array): void {
		if (this.closed) throw new Error("FakePort: send after close");
	}
	onFrame(cb: (frame: Uint8Array) => void): void {
		this.listeners.add(cb);
	}
	offFrame(cb: (frame: Uint8Array) => void): void {
		this.listeners.delete(cb);
	}
	subscribe(routingKey: string): void {
		this.subs.add(routingKey);
	}
	unsubscribe(routingKey: string): void {
		this.subs.delete(routingKey);
	}
	close(): void {
		this.closed = true;
	}
}

describe("ActiveRelayOrchestrator", () => {
	it("starts as loopback by default and exposes the port", () => {
		const orch = new ActiveRelayOrchestrator();
		const port = orch.currentPort();
		expect(port).toBeDefined();
		expect(orch.state().kind).toBe(ActiveRelayKind.Loopback);
		expect(orch.state().syncRelayUrl).toBeUndefined();
		orch.dispose();
	});

	it("onSessionChanged with no relay URL keeps loopback", async () => {
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => null,
		});
		const before = orch.currentPort();
		await orch.onSessionChanged({ vaultId: "v1", vaultPath: "/tmp/v1" });
		// Resolved transport unchanged (loopback → loopback) — no port flap.
		expect(orch.currentPort()).toBe(before);
		expect(orch.state().kind).toBe(ActiveRelayKind.Loopback);
		orch.dispose();
	});

	it("onSessionChanged with a relay URL rotates to WebSocket port", async () => {
		const make = vi.fn((url: string) => new FakePort(url));
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => "ws://localhost:9999",
			makeRelayPort: make,
		});
		const loopback = orch.currentPort();
		await orch.onSessionChanged({ vaultId: "v1", vaultPath: "/tmp/v1" });
		expect(make).toHaveBeenCalledWith("ws://localhost:9999");
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
		expect(orch.state().syncRelayUrl).toBe("ws://localhost:9999");
		expect(orch.currentPort()).not.toBe(loopback);
		orch.dispose();
	});

	it("migrates frame listeners across port swaps", async () => {
		const port = new FakePort("ws://t");
		let resolveUrl = false;
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => (resolveUrl ? "ws://t" : null),
			makeRelayPort: () => port,
		});
		const seen: Uint8Array[] = [];
		const cb = (f: Uint8Array): void => {
			seen.push(f);
		};
		orch.onFrame(cb);
		resolveUrl = true;
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		// The listener should now be on the FakePort.
		expect(port.listeners.has(cb)).toBe(true);
		orch.dispose();
	});

	it("migrates subscriptions across port swaps", async () => {
		const port = new FakePort("ws://t");
		let resolveUrl = false;
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => (resolveUrl ? "ws://t" : null),
			makeRelayPort: () => port,
		});
		orch.subscribe("channel-1");
		orch.subscribe("channel-2");
		resolveUrl = true;
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		expect(port.subs.has("channel-1")).toBe(true);
		expect(port.subs.has("channel-2")).toBe(true);
		orch.dispose();
	});

	it("reconfigure is a no-op when the resolved transport is unchanged", async () => {
		const make = vi.fn((url: string) => new FakePort(url));
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => "ws://stable",
			makeRelayPort: make,
		});
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		const portBefore = orch.currentPort();
		make.mockClear();
		await orch.reconfigure();
		expect(make).not.toHaveBeenCalled();
		expect(orch.currentPort()).toBe(portBefore);
		orch.dispose();
	});

	it("reconfigure rotates the port when the URL changes", async () => {
		let url: string | null = "ws://a";
		const make = vi.fn((u: string) => new FakePort(u));
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => url,
			makeRelayPort: make,
		});
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		const portA = orch.currentPort();
		url = "ws://b";
		await orch.reconfigure();
		expect(make).toHaveBeenCalledTimes(2);
		expect(orch.currentPort()).not.toBe(portA);
		expect(orch.state().syncRelayUrl).toBe("ws://b");
		orch.dispose();
	});

	it("clearing the session collapses back to loopback", async () => {
		const make = vi.fn((url: string) => new FakePort(url));
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => "ws://x",
			makeRelayPort: make,
		});
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		expect(orch.state().kind).toBe(ActiveRelayKind.WebSocket);
		await orch.onSessionChanged(null);
		expect(orch.state().kind).toBe(ActiveRelayKind.Loopback);
		orch.dispose();
	});

	it("state events fire on transport rotation", async () => {
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => "ws://x",
			makeRelayPort: () => new FakePort("ws://x"),
		});
		const seen: ActiveRelayKind[] = [];
		orch.on("state", (s) => seen.push(s.kind));
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		await orch.onSessionChanged(null);
		expect(seen).toEqual([ActiveRelayKind.WebSocket, ActiveRelayKind.Loopback]);
		orch.dispose();
	});

	it("dispose tears down + clears listeners", () => {
		const orch = new ActiveRelayOrchestrator();
		orch.onFrame(() => undefined);
		orch.subscribe("x");
		orch.dispose();
		// Idempotent.
		orch.dispose();
	});

	it("singleton install / get / dispose lifecycle", () => {
		const orch = new ActiveRelayOrchestrator();
		expect(getActiveRelay()).toBeNull();
		installActiveRelay(orch);
		expect(getActiveRelay()).toBe(orch);
		disposeActiveRelay();
		expect(getActiveRelay()).toBeNull();
	});

	it("loopback default reaches a real LoopbackRelayPort", () => {
		const orch = new ActiveRelayOrchestrator();
		expect(orch.currentPort()).toBeInstanceOf(LoopbackRelayPort);
		orch.dispose();
	});

	it("hasAssetPlane is false on loopback and true once an asset-capable port is live", async () => {
		const assetPort = Object.assign(new FakePort("ws://asset"), {
			requestAsset: async () => new Uint8Array(),
		});
		const orch = new ActiveRelayOrchestrator({
			readSyncRelayUrl: async () => "ws://asset",
			makeRelayPort: () => assetPort,
		});
		// Default loopback carries no blob plane.
		expect(orch.hasAssetPlane()).toBe(false);
		await orch.onSessionChanged({ vaultId: "v", vaultPath: "/" });
		expect(orch.hasAssetPlane()).toBe(true);
		orch.dispose();
	});
});
