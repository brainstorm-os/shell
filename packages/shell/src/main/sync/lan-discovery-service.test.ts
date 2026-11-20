import { describe, expect, it, vi } from "vitest";
import type { LanMdnsBackend, LanPeerCandidate } from "./lan-discovery";
import { LanTxtKey, buildLanAdvertTxt } from "./lan-discovery";
import { LanDiscoveryService, type LanDiscoveryState } from "./lan-discovery-service";
import { LAN_DISCOVERY_EPOCH_MS, deriveLanDiscoverySecret } from "./lan-discovery-tag";

const SECRET = deriveLanDiscoverySecret(new Uint8Array(32).fill(1));
const NOW = 1_800_000_000_000;

function fakeBackend() {
	const published: {
		txt: Record<string, string>;
		name: string;
		port: number;
		addresses: readonly string[];
	}[] = [];
	const updates: Record<string, string>[] = [];
	let onRecord: ((r: unknown) => void) | null = null;
	let stopped = 0;
	let browseStopped = 0;
	const backend: LanMdnsBackend = {
		publish: async (advert) => {
			published.push({
				txt: { ...advert.txt },
				name: advert.name,
				port: advert.port,
				addresses: [...advert.addresses],
			});
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

function peerRecord(args: {
	name: string;
	port: number;
	addresses: string[];
	secret?: Uint8Array;
	nowMs?: number;
}) {
	return {
		name: args.name,
		txt: buildLanAdvertTxt({
			secret: args.secret ?? SECRET,
			instance: args.name,
			port: args.port,
			addresses: args.addresses,
			nowMs: args.nowMs ?? NOW,
		}),
	};
}

const PEER = "brainstorm-00000000000000aa";
const ROGUE_PEER = "brainstorm-00000000000000bb";

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
		const name = fake.published[0]?.name ?? "";
		expect(name).toBe(svc.instance);
		expect(fake.published[0]?.txt[LanTxtKey.Tag]).toBe(
			peerRecord({ name, port: 51_820, addresses: ["192.168.1.10"] }).txt[LanTxtKey.Tag],
		);
		expect(fake.published[0]?.addresses).toEqual(["192.168.1.10"]);
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

		fake.emit(peerRecord({ name: PEER, port: 9000, addresses: ["192.168.1.20"] }));
		fake.emit(
			peerRecord({
				name: ROGUE_PEER,
				port: 9001,
				addresses: ["192.168.1.30"],
				secret: deriveLanDiscoverySecret(new Uint8Array(32).fill(2)),
			}),
		);
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
		fake.emit(peerRecord({ name: own ?? "", port: 51_820, addresses: ["192.168.1.10"] }));
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
		// The refreshed TXT is signed for the SAME name in the NEW epoch, so a
		// peer verifies it without the name ever changing.
		expect(fake.updates[0]).toEqual(
			peerRecord({
				name: instance ?? "",
				port: 51_820,
				addresses: ["192.168.1.10"],
				nowMs: now,
			}).txt,
		);
		expect(fake.updates[0]?.[LanTxtKey.Tag]).not.toBe(fake.published[0]?.txt[LanTxtKey.Tag]);
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
			fake.emit(peerRecord({ name: PEER, port: 9000, addresses: ["10.0.0.5"] })),
		).not.toThrow();
		expect(onError).toHaveBeenCalled();
		await svc.dispose();
	});

	it("refuses a record that arrives after the vault closed, not verifying with a stale key", async () => {
		const seen: LanPeerCandidate[] = [];
		const fake = fakeBackend();
		let secret: Uint8Array | null = SECRET;
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => secret,
			backend: fake.backend,
			onCandidate: (c) => seen.push(c),
			now: () => NOW,
		});
		await svc.apply();
		const record = peerRecord({ name: PEER, port: 9000, addresses: ["10.0.0.5"] });
		fake.emit(record);
		expect(seen).toHaveLength(1);
		secret = null;
		fake.emit(record);
		expect(seen).toHaveLength(1);
		await svc.apply();
		expect(svc.browsing).toBe(false);
		expect(svc.advertising).toBe(false);
		await svc.dispose();
	});

	it("verifies against the identity that is open NOW, not the one browsing started under", async () => {
		const seen: LanPeerCandidate[] = [];
		const fake = fakeBackend();
		const next = deriveLanDiscoverySecret(new Uint8Array(32).fill(5));
		let secret: Uint8Array = SECRET;
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => secret,
			backend: fake.backend,
			onCandidate: (c) => seen.push(c),
			now: () => NOW,
		});
		await svc.apply();
		secret = next;
		fake.emit(peerRecord({ name: PEER, port: 9000, addresses: ["10.0.0.5"] }));
		expect(seen).toEqual([]);
		fake.emit(peerRecord({ name: PEER, port: 9000, addresses: ["10.0.0.5"], secret: next }));
		expect(seen).toHaveLength(1);
		await svc.dispose();
	});

	it("treats a key check that throws as no key", async () => {
		const onError = vi.fn();
		const fake = fakeBackend();
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => {
				throw new Error("keystore locked");
			},
			backend: fake.backend,
			onCandidate: () => undefined,
			onError,
			now: () => NOW,
		});
		await expect(svc.apply()).resolves.toBeUndefined();
		expect(fake.published).toHaveLength(0);
		expect(fake.browsing()).toBe(false);
		expect(onError).toHaveBeenCalled();
		await svc.dispose();
	});

	it("reports 'not advertising' when the responder refuses, on first publish and on rotation", async () => {
		const onError = vi.fn();
		let refuse = false;
		let stops = 0;
		const backend: LanMdnsBackend = {
			publish: async () => {
				if (refuse) throw new Error("records hook missing");
				return {
					updateTxt: async () => {
						throw new Error("records hook missing");
					},
					stop: async () => {
						stops += 1;
					},
				};
			},
			browse: () => ({ stop: () => undefined }),
		};
		let now = NOW;
		const svc = new LanDiscoveryService({
			readState: () => HOSTING,
			discoverySecret: () => SECRET,
			backend,
			onCandidate: () => undefined,
			onError,
			now: () => now,
			setTimer: () => 0,
			clearTimer: () => undefined,
		});
		await svc.apply();
		expect(svc.advertising).toBe(true);
		now += LAN_DISCOVERY_EPOCH_MS;
		refuse = true;
		await svc.apply();
		expect(svc.advertising).toBe(false);
		expect(svc.instance).toBeNull();
		expect(stops).toBe(1);
		expect(onError).toHaveBeenCalled();
		await svc.dispose();
	});
});
