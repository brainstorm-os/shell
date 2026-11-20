/**
 * P2P-1 — advertise → browse → gated dial → admitted connection, in one process.
 *
 * Every layer is the production one except two, and both substitutions are
 * about the NETWORK, not about the code under test:
 *
 *  - **The multicast group is an in-memory bus.** `LanDiscoveryService` runs
 *    unchanged against the `LanMdnsBackend` seam; nothing binds UDP 5353. So
 *    this proves the rules (what is advertised, what survives a browse, what
 *    reaches the dialer) and proves NOTHING about `bonjour-service` on a real
 *    interface. That is `lan-mdns-backend.test.ts` for the adapter's shape and
 *    a real two-device run for the wire.
 *  - **The private address is routed to loopback.** The listener binds
 *    127.0.0.1 so the test is hermetic, while the advert names a private
 *    address, because discovery refuses loopback even under a valid tag. The
 *    `viaLoopback` socket stands in for the LAN delivering that address.
 *
 * The listener, the channel-bound admission handshake, the roster check, the
 * dial coordinator and `WebSocketRelayPort` are all real, over a real socket.
 */

import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { openLanChallenge } from "./lan-admission";
import {
	LAN_CONNECT_TIMEOUT_MS,
	LanDialCoordinator,
	LanDialMode,
	LanDialSource,
	type LanDialTarget,
} from "./lan-dial-coordinator";
import type { LanMdnsBackend, LanPublishRequest } from "./lan-discovery";
import { LanDiscoveryService } from "./lan-discovery-service";
import { deriveLanDiscoverySecret } from "./lan-discovery-tag";
import { LanHostController } from "./lan-host-controller";
import { createLanListener } from "./lan-host-factory";
import { LanHostMode } from "./lan-host-policy";
import {
	type ActiveDeviceRecord,
	createLanSessionAccess,
	makeLanClientHandshakeForSession,
} from "./lan-sync-wiring";
import {
	type WebSocketCtor,
	WebSocketRelayPort,
	WebSocketRelayState,
} from "./websocket-relay-port";

const LAN_ADDRESS = "192.168.77.10";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) await settle(20);
	return predicate();
}

/** One multicast group. Records stay until withdrawn, and a host that dies
 *  without withdrawing leaves its record behind, exactly as measured. */
function mdnsBus() {
	const records = new Map<string, { name: string; txt: Record<string, string> }>();
	const browsers = new Set<(record: unknown) => void>();
	const announce = (name: string, txt: Readonly<Record<string, string>>) => {
		const record = { name, txt: { ...txt } };
		records.set(name, record);
		for (const deliver of browsers) deliver(record);
	};
	const backend = (): LanMdnsBackend => ({
		publish: async (advert: LanPublishRequest) => {
			announce(advert.name, advert.txt);
			return {
				updateTxt: async (txt) => announce(advert.name, txt),
				stop: async () => {
					records.delete(advert.name);
				},
			};
		},
		browse: (_type, onRecord) => {
			browsers.add(onRecord);
			for (const record of records.values()) onRecord(record);
			return { stop: () => void browsers.delete(onRecord) };
		},
	});
	return { backend, announce, records };
}

const viaLoopback = class {
	constructor(url: string) {
		const NativeWebSocket = (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket;
		// biome-ignore lint/correctness/noConstructorReturn: stands in for LAN routing
		return new NativeWebSocket(url.replace(/^ws:\/\/[\d.]+:/, "ws://127.0.0.1:"));
	}
} as unknown as WebSocketCtor;

function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		edPublic: new Uint8Array(ed.publicKey),
		edSecret: new Uint8Array(ed.secretKey),
		x25519Pub: new Uint8Array(x.publicKey),
		x25519Secret: new Uint8Array(x.secretKey),
	};
}
type Device = ReturnType<typeof makeDevice>;

const recordOf = (d: Device): ActiveDeviceRecord => ({
	deviceEd25519Pub: Buffer.from(d.edPublic).toString("base64"),
	deviceX25519Pub: Buffer.from(d.x25519Pub).toString("base64"),
});

function accessFor(self: Device, roster: () => readonly ActiveDeviceRecord[]) {
	return createLanSessionAccess({
		getSession: () => ({
			deviceEd25519: { publicKey: self.edPublic },
			signWithDeviceKey: (m: Uint8Array) => new Uint8Array(ed25519.sign(m, self.edSecret)),
			openLanSealedChallenge: (a: {
				sealed: Parameters<typeof openLanChallenge>[0]["sealed"];
				hostAccount: string;
				clientAccount: string;
			}) => openLanChallenge({ ...a, deviceX25519Secret: self.x25519Secret }),
		}),
		getDevices: () => ({ listActive: roster }),
	});
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A device that hosts: real listener on loopback, advertised as `LAN_ADDRESS`. */
async function startHost(args: {
	bus: ReturnType<typeof mdnsBus>;
	device: Device;
	roster: () => readonly ActiveDeviceRecord[];
	secret: Uint8Array;
}) {
	let endpoint: { addresses: readonly string[]; port: number } | null = null;
	const controller = new LanHostController({
		readState: () => ({
			mode: LanHostMode.WhenVaultOpen,
			hasSession: true,
			hasSharedEntities: false,
		}),
		createListener: () =>
			createLanListener({
				access: accessFor(args.device, args.roster),
				addresses: () => ["127.0.0.1"],
			}),
		onUrlChanged: (url) => {
			endpoint = url ? { addresses: [LAN_ADDRESS], port: Number(new URL(url).port) } : null;
		},
	});
	const discovery = new LanDiscoveryService({
		readState: () => ({ advertise: controller.listening, browse: false, listener: endpoint }),
		discoverySecret: () => args.secret,
		backend: args.bus.backend(),
		onCandidate: () => undefined,
	});
	await controller.apply();
	await discovery.apply();
	cleanups.push(async () => {
		await discovery.dispose();
		await controller.dispose();
	});
	return { controller, discovery, port: () => endpoint?.port ?? 0 };
}

/** A device that browses and dials whatever the coordinator selects. */
async function startDialer(args: {
	bus: ReturnType<typeof mdnsBus>;
	device: Device;
	roster: () => readonly ActiveDeviceRecord[];
	secret: Uint8Array;
}) {
	const targets: (LanDialTarget | null)[] = [];
	const ports: WebSocketRelayPort[] = [];
	const coordinator = new LanDialCoordinator({
		onTargetChanged: (target) => {
			targets.push(target);
			if (!target) return;
			const port = new WebSocketRelayPort({
				url: target.url,
				wsImpl: viaLoopback,
				requireAdmission: true,
				lanHandshake: makeLanClientHandshakeForSession(accessFor(args.device, args.roster)),
				connectTimeoutMs: LAN_CONNECT_TIMEOUT_MS,
			});
			ports.push(port);
			port.connect();
		},
	});
	coordinator.setMode(LanDialMode.Auto);
	const discovery = new LanDiscoveryService({
		readState: () => ({ advertise: false, browse: true, listener: null }),
		discoverySecret: () => args.secret,
		backend: args.bus.backend(),
		onCandidate: (candidate) => coordinator.offerCandidate(candidate, LanDialSource.Discovery),
	});
	await discovery.apply();
	cleanups.push(async () => {
		for (const port of ports) port.close();
		await discovery.dispose();
	});
	return { coordinator, targets, ports };
}

describe("discover → gated dial → admission, over a real socket", () => {
	it("a device of the same identity is discovered, dialled and admitted", async () => {
		const bus = mdnsBus();
		const secret = deriveLanDiscoverySecret(new Uint8Array(32).fill(21));
		const desktop = makeDevice();
		const laptop = makeDevice();
		const roster = () => [recordOf(desktop), recordOf(laptop)];

		const host = await startHost({ bus, device: desktop, roster, secret });
		const dialer = await startDialer({ bus, device: laptop, roster, secret });

		expect(dialer.coordinator.target()).toMatchObject({
			url: `ws://${LAN_ADDRESS}:${host.port()}`,
			source: LanDialSource.Discovery,
			instance: host.discovery.instance,
		});
		const port = dialer.ports[0] as WebSocketRelayPort;
		expect(await waitUntil(() => port.gatedAdmission())).toBe(true);
		expect(port.state).toBe(WebSocketRelayState.Open);
	});

	it("a discovered device of the same identity that is NOT on the roster is still refused", async () => {
		// The tag decides whether we say hello. It never decides admission.
		const bus = mdnsBus();
		const secret = deriveLanDiscoverySecret(new Uint8Array(32).fill(22));
		const desktop = makeDevice();
		const revoked = makeDevice();

		const host = await startHost({
			bus,
			device: desktop,
			roster: () => [recordOf(desktop)],
			secret,
		});
		const dialer = await startDialer({
			bus,
			device: revoked,
			roster: () => [recordOf(desktop), recordOf(revoked)],
			secret,
		});

		expect(dialer.coordinator.target()?.url).toBe(`ws://${LAN_ADDRESS}:${host.port()}`);
		const port = dialer.ports[0] as WebSocketRelayPort;
		// The same setup admits in the test above, so "never admitted" here is
		// the roster refusing, not the dial failing to arrive.
		expect(await waitUntil(() => port.gatedAdmission(), 1_200)).toBe(false);
	});

	it("an advertiser of another identity is never dialled — no socket, so no hello to harvest", async () => {
		const bus = mdnsBus();
		const mine = deriveLanDiscoverySecret(new Uint8Array(32).fill(23));
		const theirs = deriveLanDiscoverySecret(new Uint8Array(32).fill(24));
		const laptop = makeDevice();
		const rogueDevice = makeDevice();

		let connections = 0;
		const rogueSocket = createServer((socket) => {
			connections += 1;
			socket.destroy();
		});
		await new Promise<void>((resolve) => rogueSocket.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => new Promise<void>((resolve) => rogueSocket.close(() => resolve())));

		// A complete, well-formed Brainstorm host: real listener, real advert,
		// correctly signed for ITS identity. The only thing it lacks is our key.
		await startHost({
			bus,
			device: rogueDevice,
			roster: () => [recordOf(rogueDevice), recordOf(laptop)],
			secret: theirs,
		});
		// And a bare harvester that copies the honest fields without a key.
		const rogueAddress = rogueSocket.address();
		const roguePort = typeof rogueAddress === "object" && rogueAddress ? rogueAddress.port : 0;
		bus.announce("brainstorm-00000000000000ee", {
			v: "2",
			p: String(roguePort),
			a: LAN_ADDRESS,
			e: String(Math.floor(Date.now() / 300_000)),
			t: "A".repeat(22),
		});

		const dialer = await startDialer({
			bus,
			device: laptop,
			roster: () => [recordOf(rogueDevice), recordOf(laptop)],
			secret: mine,
		});
		await settle(150);

		expect(dialer.targets).toEqual([]);
		expect(dialer.ports).toEqual([]);
		expect(dialer.coordinator.knownPeers()).toEqual([]);
		expect(connections).toBe(0);
	});

	it("a record left behind by a dead host costs one failed dial, then the relay carries sync", async () => {
		const bus = mdnsBus();
		const secret = deriveLanDiscoverySecret(new Uint8Array(32).fill(25));
		const desktop = makeDevice();
		const laptop = makeDevice();
		const roster = () => [recordOf(desktop), recordOf(laptop)];

		const host = await startHost({ bus, device: desktop, roster, secret });
		const stale = [...bus.records.values()];
		// Killed, not shut down: the listener is gone and nobody said goodbye.
		await host.controller.dispose();
		await host.discovery.dispose();
		for (const record of stale) bus.announce(record.name, record.txt);

		const dialer = await startDialer({ bus, device: laptop, roster, secret });
		const url = dialer.coordinator.target()?.url ?? "";
		expect(url).toBe(`ws://${LAN_ADDRESS}:${Number(new URL(url).port)}`);

		const port = dialer.ports[0] as WebSocketRelayPort;
		const failed = await waitUntil(
			() => port.state !== WebSocketRelayState.Open && port.state !== WebSocketRelayState.Connecting,
			LAN_CONNECT_TIMEOUT_MS + 1_500,
		);
		expect(failed).toBe(true);
		expect(port.gatedAdmission()).toBe(false);

		dialer.coordinator.noteDialUnusable(url);
		expect(dialer.coordinator.target()).toBeNull();
		// The record is still on the bus and still verifies: seeing it again
		// must not put a cooling address straight back.
		for (const record of stale) bus.announce(record.name, record.txt);
		expect(dialer.coordinator.target()).toBeNull();
		expect(dialer.ports).toHaveLength(1);
	});
});
