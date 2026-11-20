/**
 * P2P-1 — mDNS discovery for own devices: what to advertise, and what a browse
 * result has to survive before anyone dials it.
 *
 * Pure. The multicast responder itself lives behind an injected
 * {@link LanMdnsBackend} (`lan-mdns-backend.ts` supplies the real one over
 * `bonjour-service`), so every rule in this file is unit-testable without
 * binding UDP 5353.
 *
 * Three properties this module exists to hold:
 *
 *  1. **A record is an ADDRESS HINT, never liveness.** The `P2P-0` prototype
 *     `SIGKILL`ed an advertising host and saw no goes-away event within 20
 *     seconds; the record simply stays. Anything that reads presence in the
 *     browse list as "the peer is up" will be wrong in the direction of
 *     hanging. So this module emits candidates and says nothing about whether
 *     they are reachable — that is the dialer's problem, and the dialer has a
 *     connect deadline for exactly this reason.
 *  2. **Every field from the network is bounded before it is believed.** An
 *     advert is attacker-controlled input arriving on a multicast group anyone
 *     on the LAN can write to. Instance names, address lists, ports and TXT
 *     values are all length- and shape-checked, and a single bad field fails
 *     the whole record rather than being repaired.
 *  3. **No dial without a valid rotating tag.** See `lan-discovery-tag.ts` for
 *     why. `parseLanAdvert` cannot produce a candidate without one, so there is
 *     no code path that reaches the dialer with an unverified advert.
 *
 * Deliberately NOT named `*relay*`: the relay-blind fence scans that pattern
 * for crypto imports and this module legitimately verifies a MAC.
 */

import { isPrivateIpv4, lanWsUrl } from "./lan-address";
import {
	LAN_DISCOVERY_TAG_CHARS,
	type LanDiscoveryTagInput,
	lanDiscoveryEpoch,
	lanDiscoveryTag,
	verifyLanDiscoveryTag,
} from "./lan-discovery-tag";

/** The DNS-SD service type, without the `_`/`._tcp` decoration that
 *  `bonjour-service` adds itself. On the wire: `_brainstorm-sync._tcp`. */
export const LAN_SERVICE_TYPE = "brainstorm-sync";

/** TXT record keys. Single letters because a TXT string is capped at 255 bytes
 *  and the address list needs the room. */
export enum LanTxtKey {
	Version = "v",
	Port = "p",
	Addresses = "a",
	Epoch = "e",
	Tag = "t",
}

/** TXT schema version. A peer advertising anything else is ignored outright
 *  rather than best-effort parsed. */
export const LAN_TXT_VERSION = "2";

/** How many addresses one advert may carry. A machine with Wi-Fi, Ethernet, a
 *  VPN `utun` and a Docker bridge legitimately has several; four is enough for
 *  every real case and stops an advert from becoming a dial amplifier. */
export const LAN_MAX_ADVERT_ADDRESSES = 4;

/** Instance-name ceiling. DNS-SD allows 63 bytes; anything longer is malformed
 *  by definition. */
export const LAN_MAX_INSTANCE_NAME = 63;

/** The only shape `mintLanInstanceName` produces. Anything else was not minted
 *  by this product, so it is refused before any MAC work; it also guarantees
 *  the name has no dots, which `bonjour-service` would rewrite on publish and
 *  so break the commitment. */
const LAN_INSTANCE_NAME_RE = /^brainstorm-[0-9a-f]{16}$/;

/** The advert as it goes on the wire / comes off it. `txt` values are strings
 *  because that is all a TXT record holds. */
export type LanAdvertRecord = {
	name: string;
	port: number;
	txt: Readonly<Record<string, string>>;
};

/**
 * What we ask the responder to publish. `addresses` is the complete set of
 * addresses the advert may disclose in ANY record: the responder must not add
 * the machine's hostname or its other interfaces on its own initiative, which
 * would hand a passive observer a stable handle that outlives the rotation.
 */
export type LanPublishRequest = LanAdvertRecord & {
	type: string;
	addresses: readonly string[];
};

/** A record that passed every check: safe to hand to the dialer. */
export type LanPeerCandidate = {
	/** The advertised instance name. Ephemeral per boot, so it is a display
	 *  handle and a de-dup key, never an identity. */
	instance: string;
	/** Addresses to try, in advertised order. Every one is a private IPv4. */
	addresses: readonly string[];
	port: number;
	/** `ws://` URLs for `addresses`, in the same order — what the dialer uses. */
	urls: readonly string[];
};

/** The multicast responder, narrowed to what discovery needs. Injected so the
 *  rules above are testable and so a platform where binding 5353 fails
 *  (`OQ-P2P-3`) can be handled by supplying no backend at all. */
export type LanMdnsBackend = {
	/** Publish one service instance. Resolves with a handle that can refresh the
	 *  TXT in place (tag rotation) and stop the advert. */
	publish(advert: LanPublishRequest): Promise<LanMdnsPublication>;
	/** Start browsing. `onRecord` fires per discovered/updated instance. */
	browse(type: string, onRecord: (record: unknown) => void): LanMdnsBrowse;
};

export type LanMdnsPublication = {
	updateTxt(txt: Readonly<Record<string, string>>): Promise<void>;
	stop(): Promise<void>;
};

export type LanMdnsBrowse = {
	stop(): void;
};

/** Mint the TXT record for our own advert, tag included. */
export function buildLanAdvertTxt(args: {
	secret: Uint8Array;
	/** The instance name the advert is published under. Authenticated. */
	instance: string;
	port: number;
	addresses: readonly string[];
	nowMs: number;
}): Record<string, string> {
	// Caller order is PREFERENCE order (most reachable first) and is kept on the
	// wire; the tag is over the sorted set, so order is a hint an on-path
	// attacker could shuffle but only among addresses the host really signed.
	const addresses = [...args.addresses];
	const epoch = lanDiscoveryEpoch(args.nowMs);
	const input: LanDiscoveryTagInput = {
		instance: args.instance,
		epoch,
		port: args.port,
		addresses,
	};
	return {
		[LanTxtKey.Version]: LAN_TXT_VERSION,
		[LanTxtKey.Port]: String(args.port),
		[LanTxtKey.Addresses]: addresses.join(","),
		[LanTxtKey.Epoch]: String(epoch),
		[LanTxtKey.Tag]: lanDiscoveryTag(args.secret, input),
	};
}

/**
 * Turn a raw browse result into a candidate, or `null`.
 *
 * `null` for: a non-object, an instance name this product did not mint, a bad TXT
 * version, a port that is not an integer in `1..65535`, an address list that is
 * empty / oversized / contains anything that is not a private IPv4 literal, a
 * malformed epoch, a wrong-length tag, or a tag that does not verify. There is
 * no partial acceptance and no repair: a record either is entirely well-formed
 * and provably ours, or it does not exist.
 *
 * `ownInstance` lets the caller drop its own advert without a second code path
 * (a host that also browses sees itself, and dialling yourself is a loop).
 */
export function parseLanAdvert(args: {
	record: unknown;
	secret: Uint8Array;
	nowMs: number;
	ownInstance?: string | null;
}): LanPeerCandidate | null {
	const { record, secret, nowMs } = args;
	if (!record || typeof record !== "object") return null;
	const raw = record as { name?: unknown; txt?: unknown };

	if (typeof raw.name !== "string") return null;
	// Not trimmed: the name is authenticated byte-for-byte, and "repairing" it
	// first would verify a name the peer never signed.
	const instance = raw.name;
	if (!LAN_INSTANCE_NAME_RE.test(instance)) return null;
	if (args.ownInstance && instance === args.ownInstance) return null;

	if (!raw.txt || typeof raw.txt !== "object") return null;
	const txt = raw.txt as Record<string, unknown>;

	if (txt[LanTxtKey.Version] !== LAN_TXT_VERSION) return null;

	const port = parseBoundedInt(txt[LanTxtKey.Port], 1, 65_535);
	if (port === null) return null;

	const addresses = parseAddressList(txt[LanTxtKey.Addresses]);
	if (!addresses) return null;

	const epochRaw = txt[LanTxtKey.Epoch];
	if (typeof epochRaw !== "string" || !/^[1-9]\d{0,14}$/.test(epochRaw)) return null;
	const epoch = Number(epochRaw);
	if (!Number.isSafeInteger(epoch)) return null;

	const tag = txt[LanTxtKey.Tag];
	if (typeof tag !== "string" || tag.length !== LAN_DISCOVERY_TAG_CHARS) return null;

	// The tag commits to the SORTED address list, so a peer that reorders (or a
	// responder that does) still verifies, while a peer that substitutes an
	// address does not.
	const sorted = [...addresses].sort();
	const ok = verifyLanDiscoveryTag({
		secret,
		tag,
		input: { instance, epoch, port, addresses: sorted },
		nowMs,
	});
	if (!ok) return null;

	const urls: string[] = [];
	for (const address of addresses) {
		const url = lanWsUrl(address, port);
		if (!url) return null;
		urls.push(url);
	}

	return {
		instance,
		addresses,
		port,
		urls,
	};
}

function parseBoundedInt(value: unknown, min: number, max: number): number | null {
	// Canonical decimal only: one spelling per value, so two records that
	// differ on the wire never verify as the same advert.
	if (typeof value !== "string" || !/^[1-9]\d{0,6}$/.test(value)) return null;
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n < min || n > max) return null;
	return n;
}

function parseAddressList(value: unknown): readonly string[] | null {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
	const parts = value.split(",");
	if (parts.length === 0 || parts.length > LAN_MAX_ADVERT_ADDRESSES) return null;
	const out: string[] = [];
	for (const part of parts) {
		const address = part.trim();
		// Private IPv4 literals only. No hostnames (a DNS lookup driven by an
		// advert), nothing routable, and NOT loopback even under a valid tag: a
		// peer is never on our loopback, so such an advert can only point the
		// dial at a local service.
		if (address !== part || !isPrivateIpv4(address)) return null;
		if (out.includes(address)) return null;
		out.push(address);
	}
	return out;
}

/** Random, per-boot instance name. Not derived from anything stable: a fixed
 *  name would be a tracking handle that survives the tag's rotation. */
export function mintLanInstanceName(randomBytes: (n: number) => Uint8Array): string {
	return `brainstorm-${Buffer.from(randomBytes(8)).toString("hex")}`;
}
