/**
 * P2P-1 — adversarial probes against the discover → dial path.
 *
 * Kept as regression tests. Each probe is something a device on the same LAN
 * can do with no key material, or with one captured advert. A red probe here
 * means the gate in front of the first unauthenticated message is open.
 *
 * History worth knowing: the gate ledger records these fixes as landed on
 * 2026-07-31, and they were not in the tree. The merge carried the feature
 * and dropped the fix commit, so the findings shipped. This file is what
 * makes a second loss fail CI instead of going unnoticed.
 */

import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LAN_CANDIDATE_TTL_MS,
	DEFAULT_LAN_DIAL_COOLDOWN_MS,
	LAN_MAX_CANDIDATES,
	LanDialCoordinator,
	LanDialMode,
	LanDialSource,
	type LanDialTarget,
} from "./lan-dial-coordinator";
import {
	LAN_MAX_ADVERT_ADDRESSES,
	LanTxtKey,
	buildLanAdvertTxt,
	parseLanAdvert,
} from "./lan-discovery";
import { LanDiscoveryService } from "./lan-discovery-service";
import {
	LAN_DISCOVERY_EPOCH_MS,
	deriveLanDiscoverySecret,
	lanDiscoveryEpoch,
} from "./lan-discovery-tag";

const VICTIM_KEY = new Uint8Array(32).fill(0x11);
const SECRET = deriveLanDiscoverySecret(VICTIM_KEY);
const NOW = 1_800_000_000_000;
const PORT = 51_820;
const HOST = "192.168.1.10";

const name = (n: number) => `brainstorm-${n.toString(16).padStart(16, "0")}`;

function genuine(
	args: { instance?: string; port?: number; addresses?: string[]; nowMs?: number } = {},
) {
	const instance = args.instance ?? name(1);
	return {
		name: instance,
		txt: buildLanAdvertTxt({
			secret: SECRET,
			instance,
			port: args.port ?? PORT,
			addresses: args.addresses ?? [HOST],
			nowMs: args.nowMs ?? NOW,
		}),
	};
}

const parse = (record: unknown, nowMs = NOW) => parseLanAdvert({ record, secret: SECRET, nowMs });

function coordinator(start = NOW) {
	const clock = { now: start };
	const targets: (LanDialTarget | null)[] = [];
	const c = new LanDialCoordinator({
		onTargetChanged: (t) => targets.push(t),
		now: () => clock.now,
	});
	return { c, clock, targets };
}

/** Run a record through the same two steps production does. */
function offer(c: LanDialCoordinator, record: unknown, nowMs: number): boolean {
	const candidate = parseLanAdvert({ record, secret: SECRET, nowMs });
	if (!candidate) return false;
	c.offerCandidate(candidate, LanDialSource.Discovery);
	return true;
}

describe("forgery from public material", () => {
	it("a tag derived from anything but the sovereign secret does not verify", () => {
		const publicLooking = [
			new Uint8Array(32).fill(0x11).map((b, i) => b ^ (i + 1)),
			new Uint8Array(32),
			new Uint8Array(64).fill(0x11),
		];
		for (const key of publicLooking) {
			const forged = buildLanAdvertTxt({
				secret: deriveLanDiscoverySecret(key),
				instance: name(1),
				port: PORT,
				addresses: [HOST],
				nowMs: NOW,
			});
			expect(parse({ name: name(1), txt: forged })).toBeNull();
		}
	});

	it("an advert that mimics every honest field but the tag produces no candidate", () => {
		const honest = genuine();
		for (const tag of ["", "A".repeat(22), "A".repeat(21), "A".repeat(23), "!".repeat(22)]) {
			expect(parse({ ...honest, txt: { ...honest.txt, [LanTxtKey.Tag]: tag } })).toBeNull();
		}
	});

	it("flipping any one character of a genuine tag breaks it", () => {
		const honest = genuine();
		const tag = honest.txt[LanTxtKey.Tag] ?? "";
		for (let i = 0; i < tag.length; i++) {
			const flipped = `${tag.slice(0, i)}${tag[i] === "A" ? "B" : "A"}${tag.slice(i + 1)}`;
			expect(parse({ ...honest, txt: { ...honest.txt, [LanTxtKey.Tag]: flipped } })).toBeNull();
		}
	});
});

describe("replay of one captured advert", () => {
	const captured = genuine();

	it.each([
		["a different address", { [LanTxtKey.Addresses]: "192.168.1.66" }],
		["an extra address", { [LanTxtKey.Addresses]: `${HOST},192.168.1.66` }],
		["a different port", { [LanTxtKey.Port]: "4444" }],
		["a later epoch label", { [LanTxtKey.Epoch]: String(lanDiscoveryEpoch(NOW) + 1) }],
	])("is refused when pointed at %s", (_label, override) => {
		expect(parse({ ...captured, txt: { ...captured.txt, ...override } })).toBeNull();
	});

	it("is refused under a DIFFERENT instance name — the name is authenticated", () => {
		for (const other of [name(2), name(0xffff), "Andrew's laptop - trusted"]) {
			expect(parse({ ...captured, name: other })).toBeNull();
		}
	});

	it("verbatim, dies with its epoch window", () => {
		expect(parse(captured, NOW + LAN_DISCOVERY_EPOCH_MS)).not.toBeNull();
		expect(parse(captured, NOW + 2 * LAN_DISCOVERY_EPOCH_MS)).toBeNull();
		expect(parse(captured, NOW - 2 * LAN_DISCOVERY_EPOCH_MS)).toBeNull();
	});

	it("verbatim, can only ever name the genuine host's own address", () => {
		const candidate = parse(captured);
		expect(candidate?.urls).toEqual([`ws://${HOST}:${PORT}`]);
	});

	it("under thousands of names cannot grow the candidate table at all", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		let accepted = 0;
		for (let i = 2; i < 5_002; i++) {
			if (offer(c, { ...captured, name: name(i) }, NOW)) accepted += 1;
		}
		expect(accepted).toBe(0);
		expect(c.knownPeers()).toHaveLength(0);
	});
});

describe("hostile advert fields", () => {
	it.each<[string, unknown]>([
		["a string", "advert"],
		["an array", []],
		["a txt that is an array", { name: name(1), txt: [] }],
		["non-string txt values", { name: name(1), txt: { v: 2, p: PORT, a: [HOST], e: 1, t: {} } }],
		["an object-valued name", { ...genuine(), name: { toString: () => name(1) } }],
		["a name carrying markup", genuine({ instance: "<img src=x onerror=1>" })],
		["a name with a dot the responder would rewrite", genuine({ instance: "brainstorm.local" })],
		["an uppercase variant of a minted name", genuine({ instance: name(1).toUpperCase() })],
		["a 10 kB name", genuine({ instance: "b".repeat(10_000) })],
		["a broadcast address", genuine({ addresses: ["255.255.255.255"] })],
		["a multicast address", genuine({ addresses: ["224.0.0.251"] })],
		["a routable address", genuine({ addresses: ["203.0.113.7"] })],
		["CGNAT space", genuine({ addresses: ["100.64.0.1"] })],
		["loopback", genuine({ addresses: ["127.0.0.1"] })],
		["loopback in another spelling", genuine({ addresses: ["127.1.2.3"] })],
		["the wildcard", genuine({ addresses: ["0.0.0.0"] })],
		["a hostname", genuine({ addresses: ["router.local"] })],
		["an IPv6 literal", genuine({ addresses: ["fe80::1"] })],
		["an IPv4-mapped IPv6 literal", genuine({ addresses: ["::ffff:192.168.1.10"] })],
		["a hex octet", genuine({ addresses: ["0xc0.168.1.10"] })],
		["an address with a port smuggled in", genuine({ addresses: ["192.168.1.10:22"] })],
		["an address with a path", genuine({ addresses: ["192.168.1.10/x"] })],
		[
			"one address more than the ceiling",
			genuine({
				addresses: Array.from({ length: LAN_MAX_ADVERT_ADDRESSES + 1 }, (_, i) => `10.0.0.${i + 1}`),
			}),
		],
		["a repeated address", genuine({ addresses: [HOST, HOST] })],
		["port 0", genuine({ port: 0 })],
		["a port past 65535", genuine({ port: 65_536 })],
	])("refuses %s, even when it is correctly signed", (_label, record) => {
		expect(parse(record)).toBeNull();
	});

	it.each([
		["a non-canonical port", { [LanTxtKey.Port]: "051820" }],
		["a signed port", { [LanTxtKey.Port]: "+51820" }],
		["an exponent port", { [LanTxtKey.Port]: "5e4" }],
		["an absurd epoch", { [LanTxtKey.Epoch]: "9".repeat(16) }],
		["a fractional epoch", { [LanTxtKey.Epoch]: "6000000.5" }],
		["a future schema version", { [LanTxtKey.Version]: "3" }],
		["the retired schema version", { [LanTxtKey.Version]: "1" }],
	])("refuses %s", (_label, override) => {
		const honest = genuine();
		expect(parse({ ...honest, txt: { ...honest.txt, ...override } })).toBeNull();
	});

	it("is not confused by prototype-polluting keys", () => {
		const honest = genuine();
		const txt = JSON.parse(
			JSON.stringify({ ...honest.txt }).replace("{", '{"__proto__":{"t":"x"},"constructor":"x",'),
		);
		expect(parse({ name: honest.name, txt })?.port).toBe(PORT);
		expect(({} as Record<string, unknown>).t).toBeUndefined();
	});
});

describe("the network cannot steer selection", () => {
	it("Off refuses every network source", () => {
		const { c, targets } = coordinator();
		for (let i = 1; i <= 50; i++) offer(c, genuine({ instance: name(i) }), NOW);
		expect(c.target()).toBeNull();
		expect(targets).toEqual([]);
	});

	it("Manual dials only the typed address, and a flood cannot displace it", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Manual);
		c.setManualUrl("ws://192.168.1.50:9000");
		for (let i = 1; i <= 50; i++) {
			offer(c, genuine({ instance: name(i), addresses: [`10.0.0.${i}`] }), NOW);
		}
		expect(c.target()).toEqual({ url: "ws://192.168.1.50:9000", source: LanDialSource.Manual });
	});

	it("a vault close drops every network-learned peer", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		offer(c, genuine(), NOW);
		expect(c.target()).not.toBeNull();
		c.reset();
		expect(c.target()).toBeNull();
		expect(c.knownPeers()).toEqual([]);
	});

	it("a record arriving after the vault closed is refused, not verified with a stale key", async () => {
		let secret: Uint8Array | null = SECRET;
		let deliver: ((record: unknown) => void) | null = null;
		const onCandidate = vi.fn();
		const svc = new LanDiscoveryService({
			readState: () => ({ advertise: false, browse: true, listener: null }),
			discoverySecret: () => secret,
			backend: {
				publish: async () => ({ updateTxt: async () => undefined, stop: async () => undefined }),
				browse: (_type, cb) => {
					deliver = cb;
					return { stop: () => undefined };
				},
			},
			onCandidate,
			now: () => NOW,
		});
		await svc.apply();
		secret = null;
		(deliver as ((record: unknown) => void) | null)?.(genuine());
		expect(onCandidate).not.toHaveBeenCalled();
		await svc.dispose();
	});
});

describe("attacker-reachable tables are bounded", () => {
	// Reaching these tables needs a VALID tag per distinct name, which a
	// keyless attacker cannot mint. The bound is for the case the gate is
	// wrong, and for a user with many devices.
	it("the candidate table never exceeds its ceiling", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		for (let i = 1; i <= 5_000; i++) {
			offer(c, genuine({ instance: name(i), addresses: [`10.${i >> 8}.${i & 255}.9`] }), NOW);
		}
		expect(c.knownPeers().length).toBeLessThanOrEqual(LAN_MAX_CANDIDATES);
	});

	it("a flood does not evict the peer the link is live on", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		offer(c, genuine({ instance: name(1) }), NOW);
		const live = c.target();
		expect(live?.instance).toBe(name(1));
		for (let i = 2; i <= 500; i++) {
			offer(c, genuine({ instance: name(i), addresses: [`10.9.${i >> 8}.${i & 255}`] }), NOW);
		}
		expect(c.target()).toEqual(live);
		expect(c.knownPeers().some((p) => p.instance === name(1))).toBe(true);
	});

	it("a flood naming the live ADDRESS under other names protects only the live record", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		offer(c, genuine({ instance: name(1) }), NOW);
		for (let i = 2; i <= 200; i++) offer(c, genuine({ instance: name(i) }), NOW);
		expect(c.knownPeers().length).toBeLessThanOrEqual(LAN_MAX_CANDIDATES);
		expect(c.target()?.instance).toBe(name(1));
	});

	it("a discovery flood does not evict a peer learned by pairing", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		expect(c.offerPairedPeer("ws://192.168.1.77:5000")).toBe(true);
		for (let i = 1; i <= 200; i++) {
			offer(c, genuine({ instance: name(i), addresses: [`10.9.${i >> 8}.${i & 255}`] }), NOW);
		}
		expect(c.knownPeers().some((p) => p.source === LanDialSource.Pairing)).toBe(true);
	});

	it("expired candidates are evicted on insert rather than kept for the process lifetime", () => {
		const { c, clock } = coordinator();
		for (let i = 1; i <= LAN_MAX_CANDIDATES; i++) {
			offer(c, genuine({ instance: name(i), addresses: [`10.0.0.${i}`] }), clock.now);
		}
		clock.now += DEFAULT_LAN_CANDIDATE_TTL_MS + 1;
		offer(c, genuine({ instance: name(999), nowMs: clock.now }), clock.now);
		c.setMode(LanDialMode.Auto);
		expect(c.knownPeers().map((p) => p.instance)).toEqual([name(999)]);
		// Nothing stale is resurrected by winding the clock back into its window.
		clock.now -= DEFAULT_LAN_CANDIDATE_TTL_MS;
		expect(c.knownPeers().map((p) => p.instance)).toEqual([name(999)]);
	});

	it("the cooldown table is bounded and sheds expired entries", () => {
		const { c, clock } = coordinator();
		c.setMode(LanDialMode.Auto);
		for (let i = 0; i < 2_000; i++) c.noteDialUnusable(`ws://10.1.${i >> 8}.${i & 255}:5000`);
		const fresh = "ws://10.200.0.1:5000";
		offer(c, genuine({ instance: name(7), addresses: ["10.200.0.1"], port: 5000 }), clock.now);
		expect(c.target()?.url).toBe(fresh);
		// The earliest failures were shed to hold the bound; that is the safe
		// direction (a forgotten failure costs one 3 s dial, not a wedge).
		c.noteDialUnusable(fresh);
		expect(c.target()).toBeNull();
		clock.now += DEFAULT_LAN_DIAL_COOLDOWN_MS + 1;
		c.noteDialUnusable("ws://10.250.0.1:5000");
		offer(
			c,
			genuine({ instance: name(7), addresses: ["10.200.0.1"], port: 5000, nowMs: clock.now }),
			clock.now,
		);
		expect(c.target()?.url).toBe(fresh);
	});
});

describe("pairing-payload provenance", () => {
	it.each([
		"ws://127.0.0.1:8787",
		"ws://8.8.8.8:80",
		"ws://relay.example.com:443",
		"wss://192.168.1.20:443",
		"ws://user:pw@192.168.1.20:80",
		"ws://192.168.1.20:80/path",
		"ws://192.168.1.20:80?x=1",
		"ws://192.168.1.20:80#frag",
		"ws://192.168.1.20",
		"not a url",
		"",
		"ws://[fe80::1]:80",
	])("refuses %s rather than adopting it or throwing", (url) => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		expect(() => c.offerPairedPeer(url)).not.toThrow();
		expect(c.offerPairedPeer(url)).toBe(false);
		expect(c.target()).toBeNull();
		expect(c.knownPeers()).toEqual([]);
	});

	it("adopts a private address, normalised", () => {
		const { c } = coordinator();
		c.setMode(LanDialMode.Auto);
		expect(c.offerPairedPeer(" 192.168.1.20:51820 ")).toBe(true);
		expect(c.target()?.url).toBe("ws://192.168.1.20:51820");
	});
});
