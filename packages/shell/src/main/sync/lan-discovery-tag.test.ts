import { describe, expect, it } from "vitest";
import {
	LAN_DISCOVERY_EPOCH_MS,
	LAN_DISCOVERY_TAG_CHARS,
	deriveLanDiscoverySecret,
	lanDiscoveryEpoch,
	lanDiscoveryTag,
	verifyLanDiscoveryTag,
} from "./lan-discovery-tag";

const SOVEREIGN = new Uint8Array(32).fill(7);
const OTHER_SOVEREIGN = new Uint8Array(32).fill(9);
const NOW = 1_800_000_000_000;

function input(overrides: Partial<{ epoch: number; port: number; addresses: string[] }> = {}) {
	return {
		epoch: lanDiscoveryEpoch(NOW),
		port: 51_820,
		addresses: ["192.168.1.10"],
		...overrides,
	};
}

describe("deriveLanDiscoverySecret", () => {
	it("is deterministic for one identity", () => {
		expect([...deriveLanDiscoverySecret(SOVEREIGN)]).toEqual([
			...deriveLanDiscoverySecret(SOVEREIGN),
		]);
	});

	it("differs between identities — two users share no discovery secret", () => {
		expect([...deriveLanDiscoverySecret(SOVEREIGN)]).not.toEqual([
			...deriveLanDiscoverySecret(OTHER_SOVEREIGN),
		]);
	});

	it("refuses an empty key rather than deriving a constant every install shares", () => {
		expect(() => deriveLanDiscoverySecret(new Uint8Array(0))).toThrow(/empty sovereign key/);
	});
});

describe("lanDiscoveryTag", () => {
	const secret = deriveLanDiscoverySecret(SOVEREIGN);

	it("mints a fixed-length base64url tag", () => {
		expect(lanDiscoveryTag(secret, input())).toHaveLength(LAN_DISCOVERY_TAG_CHARS);
	});

	it("is order-insensitive across the address list", () => {
		const a = lanDiscoveryTag(secret, input({ addresses: ["192.168.1.10", "10.0.0.4"] }));
		const b = lanDiscoveryTag(secret, input({ addresses: ["10.0.0.4", "192.168.1.10"] }));
		expect(a).toBe(b);
	});

	it("changes when the epoch rolls", () => {
		const now = lanDiscoveryTag(secret, input());
		const next = lanDiscoveryTag(secret, input({ epoch: lanDiscoveryEpoch(NOW) + 1 }));
		expect(next).not.toBe(now);
	});
});

describe("verifyLanDiscoveryTag", () => {
	const secret = deriveLanDiscoverySecret(SOVEREIGN);

	it("accepts our own advert", () => {
		const tag = lanDiscoveryTag(secret, input());
		expect(verifyLanDiscoveryTag({ secret, tag, input: input(), nowMs: NOW })).toBe(true);
	});

	it("refuses a tag minted by a different identity", () => {
		const foreign = lanDiscoveryTag(deriveLanDiscoverySecret(OTHER_SOVEREIGN), input());
		expect(verifyLanDiscoveryTag({ secret, tag: foreign, input: input(), nowMs: NOW })).toBe(false);
	});

	it("tolerates one epoch of clock skew in each direction", () => {
		for (const drift of [-1, 1]) {
			const epoch = lanDiscoveryEpoch(NOW) + drift;
			const tag = lanDiscoveryTag(secret, input({ epoch }));
			expect(verifyLanDiscoveryTag({ secret, tag, input: input({ epoch }), nowMs: NOW })).toBe(true);
		}
	});

	it("refuses a tag from outside the skew window — a captured advert expires", () => {
		const epoch = lanDiscoveryEpoch(NOW) - 2;
		const tag = lanDiscoveryTag(secret, input({ epoch }));
		expect(verifyLanDiscoveryTag({ secret, tag, input: input({ epoch }), nowMs: NOW })).toBe(false);
	});

	it("expires on its own as time passes", () => {
		const tag = lanDiscoveryTag(secret, input());
		const later = NOW + LAN_DISCOVERY_EPOCH_MS * 3;
		expect(verifyLanDiscoveryTag({ secret, tag, input: input(), nowMs: later })).toBe(false);
	});

	// The property that makes a replay useless: a sniffer can copy a live tag,
	// but it is bound to the addresses and port the genuine host published, so
	// re-advertising it under the attacker's own address does not verify.
	it("refuses a replayed tag pointed at a different address", () => {
		const tag = lanDiscoveryTag(secret, input());
		const redirected = input({ addresses: ["192.168.1.99"] });
		expect(verifyLanDiscoveryTag({ secret, tag, input: redirected, nowMs: NOW })).toBe(false);
	});

	it("refuses a replayed tag pointed at a different port", () => {
		const tag = lanDiscoveryTag(secret, input());
		expect(verifyLanDiscoveryTag({ secret, tag, input: input({ port: 9999 }), nowMs: NOW })).toBe(
			false,
		);
	});

	it("refuses a wrong-length tag without doing any work", () => {
		expect(verifyLanDiscoveryTag({ secret, tag: "short", input: input(), nowMs: NOW })).toBe(false);
		expect(verifyLanDiscoveryTag({ secret, tag: "x".repeat(500), input: input(), nowMs: NOW })).toBe(
			false,
		);
	});

	it("refuses a non-integer epoch", () => {
		const tag = lanDiscoveryTag(secret, input());
		expect(
			verifyLanDiscoveryTag({ secret, tag, input: input({ epoch: Number.NaN }), nowMs: NOW }),
		).toBe(false);
	});
});
