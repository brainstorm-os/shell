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
