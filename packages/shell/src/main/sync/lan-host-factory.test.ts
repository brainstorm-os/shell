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
	it("ALWAYS supplies a handshake and a host account", async () => {
		// The load-bearing assertion: `LanRelayHost` without a handshake is an open
		// host. If this ever passes `undefined`, the LAN listener admits anyone.
		const build = vi.fn((_o: { handshake: LanHostHandshake; hostAccount: string; address: string }) =>
			stub(),
		);
		await createLanListener({
			access: accessWith(),
			addresses: () => ["192.168.1.5"],
			build,
		})?.start();
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

	it("binds the first offered address and stops there", async () => {
		const build = vi.fn((_o: { address: string }) => stub());
		await createLanListener({
			access: accessWith(),
			addresses: () => ["10.0.0.4", "192.168.1.5"],
			build,
		})?.start();
		expect(build.mock.calls.map(([o]) => o.address)).toEqual(["10.0.0.4"]);
	});

	it("moves to the next address when the preferred one will not bind", async () => {
		const stopped: string[] = [];
		const built: { address: string; handshake: unknown }[] = [];
		const build = (o: { address: string; handshake: LanHostHandshake }): BuiltLanListener => {
			built.push(o);
			return {
				start: async () => {
					if (o.address !== "192.168.1.5") throw new Error(`EADDRNOTAVAIL ${o.address}`);
					return { url: `ws://${o.address}:5000` };
				},
				stop: async () => {
					stopped.push(o.address);
				},
				webSocketCtor: () => o.address as never,
			};
		};
		const listener = createLanListener({
			access: accessWith(),
			addresses: () => ["172.17.0.1", "10.8.0.2", "192.168.1.5", "10.0.0.9"],
			build,
		});
		await expect(listener?.start()).resolves.toEqual({ url: "ws://192.168.1.5:5000" });
		expect(built.map((b) => b.address)).toEqual(["172.17.0.1", "10.8.0.2", "192.168.1.5"]);
		// The fallback must not be a way to reach an open host.
		expect(built.every((b) => b.handshake)).toBe(true);
		expect(stopped).toEqual(["172.17.0.1", "10.8.0.2"]);
		expect(listener?.webSocketCtor()).toBe("192.168.1.5");
		await listener?.stop();
		expect(stopped.at(-1)).toBe("192.168.1.5");
	});

	it("reports the bind failure when no address binds, and holds no listener", async () => {
		const listener = createLanListener({
			access: accessWith(),
			addresses: () => ["172.17.0.1", "10.8.0.2"],
			build: (o) => ({
				...stub(),
				start: async () => {
					throw new Error(`EADDRNOTAVAIL ${o.address}`);
				},
			}),
		});
		await expect(listener?.start()).rejects.toThrow("EADDRNOTAVAIL 10.8.0.2");
		expect(() => listener?.webSocketCtor()).toThrow(/not listening/);
		await expect(listener?.stop()).resolves.toBeUndefined();
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
