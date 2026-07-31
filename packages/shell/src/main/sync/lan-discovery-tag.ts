/**
 * P2P-1 — the rotating discovery tag that gates a dial.
 *
 * **Why this file exists.** Until `P2P-1` every address a device dialled came
 * out of a pairing payload it already trusted, so the shipped admission
 * handshake's first message — `hello{deviceAccount}`, the device's Ed25519
 * public key in cleartext — went only to a host the user had just stood in
 * front of. Discovery breaks that: once a device dials whatever advertises
 * `_brainstorm-sync._tcp`, anyone on the network can advertise, wait, and
 * harvest stable per-device identity keys. The channel-bound handshake stops
 * the attacker being *admitted*; it does not stop the disclosure, because the
 * disclosure is the first thing the client says.
 *
 * So the advertiser proves it belongs to your identity BEFORE you dial it.
 * `P2P-1` is own-devices-only — one identity, several devices — and every one
 * of those devices holds the same sovereign user key. That key is the only
 * shared secret available before any connection exists, so it is what the tag
 * is derived from.
 *
 * **The mechanism deliberately does not generalise.** Two different users share
 * no such secret, so multi-user peer-to-peer (`P2P-4`) cannot reuse this and
 * will need cross-identity admission built on the sharing model. That is the
 * point: naming the boundary in the mechanism is what keeps `P2P-4` from
 * leaking backwards into `P2P-1`.
 *
 * **The tag is bound to what it advertises, not just to time.** A tag over the
 * epoch alone is replayable for a whole epoch: a sniffer copies it, advertises
 * its own address under it, and collects the `hello` anyway. Binding the tag to
 * the advertised addresses and port means a replayed tag is only valid for the
 * addresses the genuine host published, so a replay can redirect the dial to
 * nobody. This is stronger than the spike's recommendation and costs one more
 * field in the MAC input.
 *
 * **What it is not.** A gate in FRONT of admission, never a substitute for one.
 * A device that presents a valid tag still goes through the full channel-bound
 * HPKE handshake unchanged; the tag only decides whether we are willing to say
 * `hello` at all. Anyone holding the sovereign key is already the user.
 *
 * `node:crypto` rather than `@noble/*` on purpose: HKDF and HMAC-SHA256 are
 * both built in, and this file must not add a dependency to the transport tree.
 * The file is deliberately NOT named `*relay*` — the relay-blind CI fence scans
 * that pattern for crypto imports, and this file legitimately has them.
 */

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** HKDF `info`, and the MAC's domain-separation prefix. Versioned so a future
 *  derivation change is a new namespace rather than a silent reinterpretation. */
export const LAN_DISCOVERY_INFO = "brainstorm/lan-discovery/v1";

/** HKDF salt. Fixed and public — the secrecy is entirely in the IKM. */
const LAN_DISCOVERY_SALT = "brainstorm/lan-discovery/v1/salt";

/** How long one tag stays valid. Five minutes: long enough that a peer that
 *  wakes up mid-epoch still recognises a neighbour without waiting, short
 *  enough that a captured advert is not a durable tracking handle. */
export const LAN_DISCOVERY_EPOCH_MS = 300_000;

/** Truncation length of the MAC. 16 bytes is 128 bits of forgery resistance,
 *  which is far more than a LAN adversary can grind inside one 5-minute epoch,
 *  and it keeps the TXT record small (22 base64url characters). */
export const LAN_DISCOVERY_TAG_BYTES = 16;

/** Encoded tag length, so a parser can reject a wrong-length field before it
 *  does any work. */
export const LAN_DISCOVERY_TAG_CHARS = 22;

/** How many epochs either side of ours we accept, to absorb clock skew between
 *  two of the user's own machines. One epoch each way (±5 min) is generous for
 *  devices that both run NTP and still bounds the replay window. */
export const LAN_DISCOVERY_EPOCH_SKEW = 1;

const SECRET_BYTES = 32;

/** The advert fields the tag commits to. Everything a dialer would act on. */
export type LanDiscoveryTagInput = {
	/** Epoch the tag was minted in. */
	epoch: number;
	/** The advertised listener port. */
	port: number;
	/** The advertised addresses. Order-insensitive: both sides sort. */
	addresses: readonly string[];
};

/**
 * Derive the per-identity discovery secret from the sovereign user key.
 *
 * Takes the key bytes rather than a session so the caller decides what it is
 * willing to expose; the shell passes the user identity's Ed25519 secret key,
 * which every paired device holds and no other identity does. Throws on an
 * empty key rather than deriving from nothing — a secret derived from a zero
 * length input would be a constant every installation shares.
 */
export function deriveLanDiscoverySecret(sovereignKey: Uint8Array): Uint8Array {
	if (sovereignKey.length === 0) {
		throw new Error("deriveLanDiscoverySecret: empty sovereign key");
	}
	const derived = hkdfSync(
		"sha256",
		sovereignKey,
		Buffer.from(LAN_DISCOVERY_SALT, "utf8"),
		Buffer.from(LAN_DISCOVERY_INFO, "utf8"),
		SECRET_BYTES,
	);
	return new Uint8Array(derived);
}

/** The epoch a timestamp falls in. */
export function lanDiscoveryEpoch(nowMs: number): number {
	return Math.floor(nowMs / LAN_DISCOVERY_EPOCH_MS);
}

/**
 * The MAC input. Canonical and unambiguous: every field is length-tagged by the
 * separator, addresses are sorted, so two different adverts cannot produce the
 * same pre-image by shuffling content across fields.
 */
function tagPreimage(input: LanDiscoveryTagInput): string {
	const addresses = [...input.addresses].sort().join(",");
	return `${LAN_DISCOVERY_INFO}|${input.epoch}|${input.port}|${addresses}`;
}

/** Mint the tag for one advert in one epoch. */
export function lanDiscoveryTag(secret: Uint8Array, input: LanDiscoveryTagInput): string {
	const mac = createHmac("sha256", secret).update(tagPreimage(input), "utf8").digest();
	return mac.subarray(0, LAN_DISCOVERY_TAG_BYTES).toString("base64url");
}

/**
 * Check a tag presented in an advert.
 *
 * Fail-closed at every step: a wrong-length tag, an epoch outside the skew
 * window, a non-finite epoch, or a MAC mismatch all return `false`. The compare
 * is constant-time so a wrong tag leaks no information about how wrong it was.
 */
export function verifyLanDiscoveryTag(args: {
	secret: Uint8Array;
	tag: string;
	input: LanDiscoveryTagInput;
	nowMs: number;
	skewEpochs?: number;
}): boolean {
	const { secret, tag, input, nowMs } = args;
	if (tag.length !== LAN_DISCOVERY_TAG_CHARS) return false;
	if (!Number.isSafeInteger(input.epoch)) return false;
	const skew = args.skewEpochs ?? LAN_DISCOVERY_EPOCH_SKEW;
	const local = lanDiscoveryEpoch(nowMs);
	if (Math.abs(input.epoch - local) > skew) return false;
	const expected = Buffer.from(lanDiscoveryTag(secret, input), "utf8");
	const presented = Buffer.from(tag, "utf8");
	if (expected.length !== presented.length) return false;
	return timingSafeEqual(expected, presented);
}
