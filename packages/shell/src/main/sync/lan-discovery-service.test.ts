import { describe, expect, it, vi } from "vitest";
import type { LanMdnsBackend, LanPeerCandidate } from "./lan-discovery";
import { LanTxtKey, buildLanAdvertTxt } from "./lan-discovery";
import { LanDiscoveryService, type LanDiscoveryState } from "./lan-discovery-service";
import { LAN_DISCOVERY_EPOCH_MS, deriveLanDiscoverySecret } from "./lan-discovery-tag";

const SECRET = deriveLanDiscoverySecret(new Uint8Array(32).fill(1));
const NOW = 1_800_000_000_000;

function fakeBackend() {
	const published: { txt: Record<string, string>; name: string; port: number }[] = [];
	const updates: Record<string, string>[] = [];
	let onRecord: ((r: unknown) => void) | null = null;
	let stopped = 0;
	let browseStopped = 0;
	const backend: LanMdnsBackend = {
		publish: async (advert) => {
			published.push({ txt: { ...advert.txt }, name: advert.name, port: advert.port });
			return {
				updateTxt: async (txt) => {
					updates.push({ ...txt });
				},
				stop: async () => {
					stopped += 1;
				},
			};
		},
		browse: (_type, cb) => {
			onRecord = cb;
			return {
				stop: () => {
					browseStopped += 1;
					onRecord = null;
				},
			};
		},
	};
	return {
		backend,
		published,
		updates,
		emit: (r: unknown) => onRecord?.(r),
		browsing: () => onRecord !== null,
		stopped: () => stopped,
		browseStopped: () => browseStopped,
	};
}

function service(args: {
	backend: LanMdnsBackend | null;
	state: LanDiscoveryState;
	secret?: Uint8Array | null;
	onCandidate?: (c: LanPeerCandidate) => void;
	now?: () => number;
}) {
	const timers: { cb: () => void; ms: number }[] = [];
	const svc = new LanDiscoveryService({
		readState: () => args.state,
		discoverySecret: () => (args.secret === undefined ? SECRET : args.secret),
		backend: args.backend,
		onCandidate: args.onCandidate ?? (() => undefined),
		now: args.now ?? (() => NOW),
		setTimer: (cb, ms) => {
			timers.push({ cb, ms });
			return timers.length;
		},
		clearTimer: () => undefined,
		randomBytes: (n) => new Uint8Array(n).fill(0xab),
	});
	return { svc, timers };
}

const HOSTING: LanDiscoveryState = {
	advertise: true,
	browse: true,
	listener: { addresses: ["192.168.1.10"], port: 51_820 },
};

describe("LanDiscoveryService", () => {
	it("advertises the bound listener with a valid tag", async () => {
		const fake = fakeBackend();
		const { svc } = service({ backend: fake.backend, state: HOSTING });
		await svc.apply();
		expect(fake.published).toHaveLength(1);
		expect(fake.published[0]?.port).toBe(51_820);
		expect(fake.published[0]?.txt[LanTxtKey.Tag]).toBe(
			buildLanAdvertTxt({ secret: SECRET, port: 51_820, addresses: ["192.168.1.10"], nowMs: NOW })[
				LanTxtKey.Tag
			],
		);
		await svc.dispose();
	});

	it("refuses to advertise or browse with no session — no key, nothing to prove", async () => {
		const fake = fakeBackend();
		const { svc } = service({ backend: fake.backend, state: HOSTING, secret: null });
		await svc.apply();
		expect(fake.published).toHaveLength(0);
		expect(fake.browsing()).toBe(false);
		await svc.dispose();
	});

	it("is inert when the platform gives us no responder (OQ-P2P-3)", async () => {
		const { svc } = service({ backend: null, state: HOSTING });
		await expect(svc.apply()).resolves.toBeUndefined();
		expect(svc.advertising).toBe(false);
		expect(svc.browsing).toBe(false);
		await svc.dispose();
	});

	it("does not advertise while not listening, but still browses", async () => {
		const fake = fakeBackend();
		const { svc } = service({
			backend: fake.backend,
			state: { advertise: false, browse: true, listener: null },
		});
		await svc.apply();
		expect(fake.published).toHaveLength(0);
		expect(fake.browsing()).toBe(true);
		await svc.dispose();
	});

	it("emits a candidate only for a record whose tag verifies", async () => {
		const seen: LanPeerCandidate[] = [];
		const fake = fakeBackend();
		const { svc } = service({
			backend: fake.backend,
			state: HOSTING,
			onCandidate: (c) => seen.push(c),
		});
		await svc.apply();

		fake.emit({
			name: "brainstorm-peer",
			txt: buildLanAdvertTxt({
				secret: SECRET,
				port: 9000,
				addresses: ["192.168.1.20"],
				nowMs: NOW,
			}),
		});
		fake.emit({
			name: "brainstorm-rogue",
			txt: buildLanAdvertTxt({
				secret: deriveLanDiscoverySecret(new Uint8Array(32).fill(2)),
				port: 9001,
				addresses: ["192.168.1.30"],
				nowMs: NOW,
			}),
		});
		fake.emit({ name: "junk" });
		fake.emit("not an object");

		expect(seen.map((c) => c.port)).toEqual([9000]);
		await svc.dispose();
	});

	it("drops its own advert when it is also browsing", async () => {
		const seen: LanPeerCandidate[] = [];
		const fake = fakeBackend();
		const { svc } = service({
			backend: fake.backend,
			state: HOSTING,
			onCandidate: (c) => seen.push(c),
		});
		await svc.apply();
		const own = svc.instance;
		expect(own).not.toBeNull();
		fake.emit({
			name: own,
			txt: buildLanAdvertTxt({
				secret: SECRET,
				port: 51_820,
				addresses: ["192.168.1.10"],
				nowMs: NOW,
			}),
		});
		expect(seen).toEqual([]);
		await svc.dispose();
	});

	it("refreshes the TXT in place across an epoch roll rather than churning the name", async () => {
		const fake = fakeBackend();
		let now = NOW;
		const { svc } = service({ backend: fake.backend, state: HOSTING, now: () => now });
		await svc.apply();
		const instance = svc.instance;
		now += LAN_DISCOVERY_EPOCH_MS;
		await svc.apply();
		expect(fake.published).toHaveLength(1);
		expect(fake.updates).toHaveLength(1);
		expect(svc.instance).toBe(instance);
		await svc.dispose();
	});

	it("republishes under a new instance when the listener address changes", async () => {
		const fake = fakeBackend();
		const state: LanDiscoveryState = {
			...HOSTING,
			listener: { addresses: ["192.168.1.10"], port: 1 },
		};
		const { svc } = service({ backend: fake.backend, state });
		await svc.apply();
		state.listener = { addresses: ["192.168.1.11"], port: 2 };
		await svc.apply();
		expect(fake.published).toHaveLength(2);
		expect(fake.stopped()).toBe(1);
		await svc.dispose();
	});

	it("tears both halves down on dispose", async () => {
		const fake = fakeBackend();
		const { svc } = service({ backend: fake.backend, state: HOSTING });
		await svc.apply();
		await svc.dispose();
		expect(fake.stopped()).toBe(1);
		expect(fake.browseStopped()).toBe(1);
		expect(svc.advertising).toBe(false);
	});

	it("survives a responder that refuses to publish", async () => {
		const onError = vi.fn();
		const backend: LanMdnsBackend = {
			publish: async () => {
				throw new Error("port 5353 in use");
			},
			browse: () => ({ stop: () => undefined }),
		};
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => SECRET,
			backend,
			onCandidate: () => undefined,
			onError,
			now: () => NOW,
		});
		await expect(svc.apply()).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledOnce();
		expect(svc.advertising).toBe(false);
		await svc.dispose();
	});

	it("survives a consumer that throws on a candidate", async () => {
		const onError = vi.fn();
		const fake = fakeBackend();
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => SECRET,
			backend: fake.backend,
			onCandidate: () => {
				throw new Error("consumer blew up");
			},
			onError,
			now: () => NOW,
		});
		await svc.apply();
		expect(() =>
			fake.emit({
				name: "brainstorm-peer",
				txt: buildLanAdvertTxt({ secret: SECRET, port: 9000, addresses: ["10.0.0.5"], nowMs: NOW }),
			}),
		).not.toThrow();
		expect(onError).toHaveBeenCalled();
		await svc.dispose();
	});
});
