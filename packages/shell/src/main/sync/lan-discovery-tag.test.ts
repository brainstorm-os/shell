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

function input(
	overrides: Partial<{ instance: string; epoch: number; port: number; addresses: string[] }> = {},
) {
	return {
		instance: "brainstorm-00112233aabbccdd",
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

describe("rotation and unlinkability", () => {
	const mine = deriveLanDiscoverySecret(SOVEREIGN);
	const theirs = deriveLanDiscoverySecret(OTHER_SOVEREIGN);
	const epoch0 = lanDiscoveryEpoch(NOW);

	it("an old tag is rejected once its epoch has left the window", () => {
		const old = lanDiscoveryTag(mine, input());
		const at = (epochs: number) =>
			verifyLanDiscoveryTag({
				secret: mine,
				tag: old,
				input: input(),
				nowMs: NOW + epochs * LAN_DISCOVERY_EPOCH_MS,
			});
		expect([at(0), at(1), at(2), at(50)]).toEqual([true, true, false, false]);
	});

	it("an old tag cannot be re-labelled with the current epoch", () => {
		const old = lanDiscoveryTag(mine, input());
		const relabelled = input({ epoch: epoch0 + 3 });
		expect(
			verifyLanDiscoveryTag({
				secret: mine,
				tag: old,
				input: relabelled,
				nowMs: NOW + 3 * LAN_DISCOVERY_EPOCH_MS,
			}),
		).toBe(false);
	});

	it("neither identity accepts the other's tag, for the same advert, in any epoch", () => {
		for (let i = 0; i < 20; i++) {
			const at = input({ epoch: epoch0 + i });
			const nowMs = NOW + i * LAN_DISCOVERY_EPOCH_MS;
			const a = lanDiscoveryTag(mine, at);
			const b = lanDiscoveryTag(theirs, at);
			expect(a).not.toBe(b);
			expect(verifyLanDiscoveryTag({ secret: theirs, tag: a, input: at, nowMs })).toBe(false);
			expect(verifyLanDiscoveryTag({ secret: mine, tag: b, input: at, nowMs })).toBe(false);
		}
	});

	it("one identity's tags across epochs share nothing an observer could link", () => {
		const tags = Array.from({ length: 64 }, (_, i) =>
			lanDiscoveryTag(mine, input({ epoch: epoch0 + i })),
		);
		expect(new Set(tags).size).toBe(tags.length);
		const bits = tags.map((tag) => [...Buffer.from(tag, "base64url")]);
		let differing = 0;
		for (let i = 1; i < bits.length; i++) {
			const [prev, cur] = [bits[i - 1] ?? [], bits[i] ?? []];
			for (let j = 0; j < cur.length; j++) {
				let x = (cur[j] ?? 0) ^ (prev[j] ?? 0);
				while (x) {
					differing += x & 1;
					x >>= 1;
				}
			}
		}
		// Consecutive tags behave like independent 128-bit strings: ~64 bits
		// differ on average. A counter or a shared prefix would sit far below.
		const mean = differing / (bits.length - 1);
		expect(mean).toBeGreaterThan(54);
		expect(mean).toBeLessThan(74);
	});

	it("the tag is not derivable from the PUBLIC half of the identity", () => {
		const fromPublic = deriveLanDiscoverySecret(new Uint8Array(32).fill(7).map((b) => b ^ 0xff));
		expect(lanDiscoveryTag(fromPublic, input())).not.toBe(lanDiscoveryTag(mine, input()));
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

	// The name is the candidate table's de-dup key and is rendered in Settings.
	it("refuses a replayed tag presented under a different instance name", () => {
		const tag = lanDiscoveryTag(secret, input());
		const renamed = input({ instance: "brainstorm-ffffffffffffffff" });
		expect(verifyLanDiscoveryTag({ secret, tag, input: renamed, nowMs: NOW })).toBe(false);
	});

	it("field shuffling cannot collide two different adverts onto one tag", () => {
		const pairs: [ReturnType<typeof input>, ReturnType<typeof input>][] = [
			[input({ instance: "a|1", port: 2 }), input({ instance: "a", port: 12 })],
			[
				input({ instance: "n", addresses: ["10.0.0.1", "10.0.0.2"] }),
				input({ instance: "n", addresses: ["10.0.0.1,10.0.0.2"] }),
			],
			[input({ port: 5, addresses: ["10.0.0.1"] }), input({ port: 51, addresses: ["0.0.0.1"] })],
			[input({ instance: "x1:y" }), input({ instance: "x", addresses: ["y"] })],
		];
		for (const [a, b] of pairs) {
			expect(lanDiscoveryTag(secret, a)).not.toBe(lanDiscoveryTag(secret, b));
		}
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
