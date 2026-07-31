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

/**
 * May we bind here, or dial here? Private or loopback IPv4 literals only.
 *
 * Loopback is allowed so tests can bind without touching a real interface;
 * everything else must satisfy `isPrivateIpv4`. Anything that is not a
 * four-octet literal — a hostname, `0`, `0x0`, `::0`, a trailing dot — is
 * refused, because those are exactly the forms that resolved to a wildcard.
 */
export function isBindableAddress(address: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim());
	if (!m) return false;
	const octets = m.slice(1, 5).map(Number);
	if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	if (octets[0] === 127) return true; // loopback — test/local host client
	return isPrivateIpv4(address.trim());
}

export function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 169 && b === 254) return true; // link-local
	return false;
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
 * The ranking is by interface name, which is the only signal available without
 * probing: physical adapters first, virtual/overlay adapters last, everything
 * unknown in between. It is a heuristic and it is allowed to be, because the
 * consequence of getting it wrong is now recoverable — discovery advertises the
 * bound address explicitly, and a user can always type one in.
 */
export function rankLanInterfaces(interfaces: readonly LanInterface[]): LanInterface[] {
	return [...interfaces].sort((a, b) => interfaceRank(a.name) - interfaceRank(b.name));
}

/** Lower sorts earlier. */
function interfaceRank(name: string): number {
	const n = name.toLowerCase();
	// Overlay / virtual adapters a peer on the physical LAN cannot reach.
	if (/^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|wg|tailscale|ham)/.test(n)) return 2;
	if (n.includes("virtual") || n.includes("vethernet") || n.includes("loopback")) return 2;
	// Physical adapters, the ones a home or office LAN actually runs on.
	if (/^(en|eth|wlan|wl|wlp|enp|eno|ens)\d/.test(n)) return 0;
	if (n.includes("wi-fi") || n.includes("wifi") || n.includes("ethernet")) return 0;
	return 1;
}
