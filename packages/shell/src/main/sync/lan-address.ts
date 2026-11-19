/**
 * Which IPv4 addresses count as "the local network".
 *
 * Extracted from `lan-relay-listener.ts` in `P2P-1` because three more modules
 * need the same predicate — discovery (validating an advert's address list),
 * the dial coordinator (validating a typed address), and the interface ranking
 * — and none of them should have to pull in `ws` and `node:http` to ask a
 * question about a string. The listener re-exports these so its own callers are
 * unchanged.
 *
 * The rule is deliberately narrow: private IPv4 literals and loopback, nothing
 * else. Not hostnames, because resolving one would mean a DNS lookup driven by
 * an attacker's advert or by typed input. Not routable addresses, because a
 * listener on one is an internet-facing service, which is emphatically not what
 * "sync on my local network" means, and dialling one from a control labelled
 * "local network" is the same mistake in the other direction. Not IPv6: that is
 * a v1 restriction and a written decision rather than an accident (see
 * `rankLanInterfaces`).
 */

/** A bindable local address: private IPv4 (RFC1918) or link-local. */
export type LanInterface = { name: string; address: string };

export type Ipv4Octets = readonly [number, number, number, number];

const CANONICAL_OCTET = "(0|[1-9]\\d{0,2})";
const CANONICAL_IPV4_RE = new RegExp(
	`^${CANONICAL_OCTET}\\.${CANONICAL_OCTET}\\.${CANONICAL_OCTET}\\.${CANONICAL_OCTET}$`,
);

/**
 * Parse ONE spelling of an IPv4 address: four decimal octets, no leading
 * zeros, no hex, no short forms, no whitespace.
 *
 * Every other spelling is refused rather than normalised, because the parsers
 * downstream do not agree on what they mean: WHATWG URL parsing reads
 * `010.0.0.1` as octal, so a string that passes a private-range check as
 * "10.0.0.1" dials the routable `8.0.0.1`. The result is re-serialised and
 * compared, so anything this returns round-trips byte for byte.
 */
export function parseCanonicalIpv4(raw: string): Ipv4Octets | null {
	if (typeof raw !== "string") return null;
	const m = CANONICAL_IPV4_RE.exec(raw);
	if (!m) return null;
	const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const;
	if (octets.some((n) => n > 255)) return null;
	return octets.join(".") === raw ? octets : null;
}

function isPrivateOctets([a, b, c, d]: Ipv4Octets): boolean {
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	// Link-local stays: two machines cabled together with no DHCP is a real
	// LAN, and ranking already puts it last. The one address refused outright
	// is the cloud instance-metadata endpoint, which is never a peer and is
	// the classic target of a steered request.
	if (a === 169 && b === 254) return !(c === 169 && d === 254);
	return false;
}

/**
 * May we bind here, or dial here? Canonical private or loopback IPv4 only.
 *
 * Loopback is allowed so tests can bind without touching a real interface;
 * everything else must satisfy `isPrivateIpv4`. A hostname, `0`, `0x0`, `::0`
 * or a trailing dot is refused: those are exactly the forms that resolved to
 * a wildcard.
 */
export function isBindableAddress(address: string): boolean {
	const octets = parseCanonicalIpv4(address);
	if (!octets) return false;
	return octets[0] === 127 || isPrivateOctets(octets);
}

export function isPrivateIpv4(address: string): boolean {
	const octets = parseCanonicalIpv4(address);
	return octets !== null && isPrivateOctets(octets);
}

/**
 * The dial URL for a LAN peer, or `null`. The single place an address string
 * becomes a `ws://` URL: built from the PARSED octets, never from the input,
 * so what was validated and what is dialled cannot differ.
 */
export function lanWsUrl(
	address: string,
	port: number,
	opts: { allowLoopback?: boolean } = {},
): string | null {
	const octets = parseCanonicalIpv4(address);
	if (!octets) return null;
	const loopback = octets[0] === 127;
	if (loopback ? opts.allowLoopback !== true : !isPrivateOctets(octets)) return null;
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
	return `ws://${octets.join(".")}:${port}`;
}

/**
 * P2P-1 — order candidate interfaces so the listener binds a deliberate one.
 *
 * `lanInterfaces()` returns them in whatever order the OS enumerates, and the
 * shipped factory took `[0]`. On a machine with Docker (`172.17.0.1` on Linux),
 * a VPN `utun`, a virtual-machine host adapter, or both Wi-Fi and Ethernet,
 * "first" is arbitrary and frequently wrong — and the failure is SILENT: the
 * listener binds an address no peer can reach, and every symptom points at
 * discovery or admission instead.
 *
 * **IPv6 position (written, `P2P-1`): IPv4 only, on every path.** The listener
 * binds private IPv4, the advert carries private IPv4 literals and publishes no
 * AAAA record, and a typed or paired address must be a private IPv4 literal.
 * Reasons, in order: a link-local IPv6 address is only dialable with a zone id
 * (`fe80::1%en0`) that is meaningless on the peer and cannot go in a `ws://`
 * URL portably; a global-scope IPv6 address is ROUTABLE, so advertising or
 * binding one turns "sync on my local network" into an internet-facing service
 * and breaks the conservative `isLanRelayUrl` claim behind the "no server"
 * status line; and privacy addresses rotate, which would churn the tag's
 * address commitment. ULA (`fc00::/7`) is the one form with none of those
 * problems and is the natural first extension. The cost is stated rather than
 * hidden: on an IPv6-ONLY network `lanInterfaces()` is empty, the listener
 * stays off, discovery advertises nothing, and sync uses the relay. That case
 * must surface as "no local network address" in Settings, never as a silent
 * no-op.
 *
 * The ranking is by interface name, which is the only signal available without
 * probing: physical adapters first, virtual/overlay adapters last, everything
 * unknown in between. It is a heuristic and it is allowed to be, because the
 * consequence of getting it wrong is now recoverable — discovery advertises the
 * bound address explicitly, and a user can always type one in.
 */
export function rankLanInterfaces(interfaces: readonly LanInterface[]): LanInterface[] {
	return [...interfaces].sort(
		(a, b) =>
			interfaceRank(a.name) - interfaceRank(b.name) || addressRank(a.address) - addressRank(b.address),
	);
}

/** Lower sorts earlier. */
function interfaceRank(name: string): number {
	const n = name.toLowerCase();
	// Overlay / virtual adapters a peer on the physical LAN cannot reach.
	if (VIRTUAL_INTERFACE_PREFIX.test(n)) return 2;
	if (n.includes("virtual") || n.includes("vethernet") || n.includes("loopback")) return 2;
	if (n.includes("vpn") || n.includes("wsl") || n.includes("hyper-v")) return 2;
	// Physical adapters, the ones a home or office LAN actually runs on.
	if (/^(en|eth|wlan|wl|wlp|enp|eno|ens|enx)\w*\d/.test(n)) return 0;
	if (n.includes("wi-fi") || n.includes("wifi") || n.includes("ethernet")) return 0;
	return 1;
}

const VIRTUAL_INTERFACE_PREFIX =
	/^(docker|br-|bridge|veth|virbr|vmnet|vboxnet|vnic|utun|tun|tap|ppp|ipsec|zt|wg|tailscale|nordlynx|ham|podman|cni|flannel|lxc|lxd)/;

/**
 * Within one class of adapter, a self-assigned link-local address goes last:
 * `169.254/16` on a physical adapter means DHCP failed, so the adapter with a
 * routed private address is the one the LAN is actually on.
 */
function addressRank(address: string): number {
	return address.startsWith("169.254.") ? 1 : 0;
}
