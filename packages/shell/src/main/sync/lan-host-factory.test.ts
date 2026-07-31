/**
 * The factory's whole job is refusing to build an OPEN host. `LanRelayHost`
 * treats an absent `handshake` as "no challenge", so a wiring slip there binds a
 * socket that admits anyone on the network.
 */

import { describe, expect, it, vi } from "vitest";
import type { LanHostHandshake } from "./lan-admission";
import { type BuiltLanListener, createLanListener } from "./lan-host-factory";
import type { LanSessionAccess } from "./lan-sync-wiring";

const stub = (): BuiltLanListener => ({
	start: async () => ({ url: "ws://192.168.1.5:5000" }),
	stop: async () => undefined,
	webSocketCtor: () => class {} as never,
});

const accessWith = (over: Partial<LanSessionAccess> = {}): LanSessionAccess => ({
	deviceEd25519Public: () => new Uint8Array(32).fill(3),
	signWithDeviceKey: () => new Uint8Array(64),
	activeDeviceRecords: () => [],
	openSealed: () => null,
	...over,
});

describe("createLanListener", () => {
	it("ALWAYS supplies a handshake and a host account", () => {
		// The load-bearing assertion: `LanRelayHost` without a handshake is an open
		// host. If this ever passes `undefined`, the LAN listener admits anyone.
		const build = vi.fn((_o: { handshake: LanHostHandshake; hostAccount: string; address: string }) =>
			stub(),
		);
		createLanListener({ access: accessWith(), addresses: () => ["192.168.1.5"], build });
		expect(build).toHaveBeenCalledTimes(1);
		const opts = build.mock.calls[0]?.[0];
		expect(opts?.handshake).toBeTruthy();
		expect(typeof opts?.handshake.sealFor).toBe("function");
		expect(opts?.hostAccount).toBeTruthy();
		expect(opts?.address).toBe("192.168.1.5");
	});

	it("returns null — never an open host — when there is no session", () => {
		const build = vi.fn(() => stub());
		const listener = createLanListener({
			access: accessWith({ deviceEd25519Public: () => null }),
			addresses: () => ["192.168.1.5"],
			build,
		});
		expect(listener).toBeNull();
		expect(build).not.toHaveBeenCalled();
	});

	it("returns null when there is no bindable private address", () => {
		// No LAN interface (offline, or only loopback) ⇒ stay off rather than fall
		// back to a wildcard bind.
		const build = vi.fn(() => stub());
		const listener = createLanListener({ access: accessWith(), addresses: () => [], build });
		expect(listener).toBeNull();
		expect(build).not.toHaveBeenCalled();
	});

	it("binds the first offered address", () => {
		const build = vi.fn((o: { address: string }) => {
			expect(o.address).toBe("10.0.0.4");
			return stub();
		});
		createLanListener({
			access: accessWith(),
			addresses: () => ["10.0.0.4", "192.168.1.5"],
			build,
		});
		expect(build).toHaveBeenCalledTimes(1);
	});

	it("hands back a listener the controller can drive", async () => {
		const listener = createLanListener({
			access: accessWith(),
			addresses: () => ["192.168.1.5"],
			build: () => stub(),
		});
		expect(listener).not.toBeNull();
		await expect(listener?.start()).resolves.toEqual({ url: "ws://192.168.1.5:5000" });
		await expect(listener?.stop()).resolves.toBeUndefined();
	});
});
