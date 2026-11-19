/**
 * P2P-1 — the real multicast responder, behind the `LanMdnsBackend` seam.
 *
 * The only file in the LAN tree that touches `bonjour-service`. Everything the
 * shell decides about discovery is in `lan-discovery.ts` /
 * `lan-discovery-service.ts`, which never import this; this is a thin adapter
 * so the dependency is replaceable and so the rules stay testable without
 * binding UDP 5353.
 *
 * `bonjour-service` was chosen in the `P2P-0` spike: MIT, pure JS, five runtime
 * packages, no native build, and measured interoperating with the platform
 * `mDNSResponder` on macOS (a `dns-sd -B` browse saw our advert on the real LAN
 * adapter, and a remote instance resolved in 228 ms).
 *
 * **The import is lazy and every failure is absorbed.** `OQ-P2P-3` is open on
 * whether binding 5353 alongside `avahi-daemon` (Linux) or the built-in
 * responder (Windows 10+) works; `multicast-dns` sets `SO_REUSEADDR`, which is
 * usually enough, but "usually" is not a design position. `createLanMdnsBackend`
 * returns `null` when the responder cannot be created, and the discovery
 * service treats a null backend as "discovery is off here" rather than an
 * error — pairing bootstrap and manual entry never needed multicast.
 */

import type {
	LanMdnsBackend,
	LanMdnsBrowse,
	LanMdnsPublication,
	LanPublishRequest,
} from "./lan-discovery";

/** The slice of `bonjour-service` this adapter uses, declared structurally so
 *  the module typechecks without the package's types on the workspace path. */
type BonjourLike = {
	publish(opts: {
		name: string;
		type: string;
		port: number;
		host: string;
		disableIPv6: boolean;
		txt: Record<string, string>;
	}): BonjourServiceLike;
	find(
		opts: { type: string },
		onUp: (service: unknown) => void,
	): {
		stop(): void;
		removeAllListeners?: () => void;
		on?(event: string, listener: (...args: unknown[]) => void): void;
	};
	destroy(callback?: () => void): void;
};

type BonjourServiceLike = {
	stop(callback?: () => void): void;
	on?(event: string, listener: (...args: unknown[]) => void): void;
	records?: () => DnsRecordLike[];
};

const BROWSER_TXT_UPDATE_EVENT = "txt-update";

type DnsRecordLike = { type: string; data?: unknown };

/**
 * Keep an advert's address records to the addresses we chose to disclose.
 *
 * `bonjour-service` builds an A/AAAA record for EVERY non-internal interface
 * the OS reports, so left alone an advert publishes the VPN address, a routable
 * address and the global-scope IPv6 set next to the one private IPv4 the
 * listener is bound to. Exported for the test; the dialer never reads these
 * records (it uses the authenticated TXT list), so dropping them costs nothing.
 */
export function restrictAddressRecords<T extends DnsRecordLike>(
	records: readonly T[],
	allowed: readonly string[],
): T[] {
	return records.filter((record) => {
		if (record.type === "AAAA") return false;
		if (record.type !== "A") return true;
		return typeof record.data === "string" && allowed.includes(record.data);
	});
}

/**
 * Build the responder, or `null` when this platform will not give us one.
 *
 * One `Bonjour` instance per shell: it owns the socket, and two instances would
 * mean two sockets contending for the same port for no gain.
 */
export async function createLanMdnsBackend(options?: {
	onError?: (error: unknown) => void;
}): Promise<(LanMdnsBackend & { destroy(): Promise<void> }) | null> {
	let bonjour: BonjourLike;
	try {
		const mod = (await import("bonjour-service")) as unknown as {
			Bonjour: new () => BonjourLike;
		};
		bonjour = new mod.Bonjour();
	} catch (error) {
		options?.onError?.(error);
		return null;
	}

	return {
		publish(advert: LanPublishRequest): Promise<LanMdnsPublication> {
			const announce = (txt: Readonly<Record<string, string>>): BonjourServiceLike => {
				const service = bonjour.publish({
					name: advert.name,
					type: advert.type,
					port: advert.port,
					// Without `host` the SRV target and every A record are owned by
					// `os.hostname()`: a stable, human-chosen machine name broadcast
					// to the whole LAN, which defeats the per-boot instance name and
					// the rotating tag. The instance name is already random per boot.
					host: `${advert.name}.local`,
					disableIPv6: true,
					txt: { ...txt },
				});
				// Patched before the first announce: `publish` probes for ~250 ms
				// before it reads `records()`. Never pass `probe: false`, which
				// would announce synchronously with the unrestricted set.
				const buildRecords = service.records?.bind(service);
				if (buildRecords) {
					const allowed = [...advert.addresses];
					service.records = () => restrictAddressRecords(buildRecords(), allowed);
				}
				// A responder error after publish must not become an unhandled
				// 'error' event on the emitter, which would take the main process
				// down.
				service.on?.("error", (error) => options?.onError?.(error));
				return service;
			};
			const withdraw = (service: BonjourServiceLike): Promise<void> =>
				new Promise<void>((resolve) => {
					try {
						service.stop(() => resolve());
					} catch {
						resolve();
					}
					// `stop` does not always invoke its callback when the socket is
					// already gone; do not hang the reconcile queue on it.
					setTimeout(resolve, 1_000).unref?.();
				});
			let service = announce(advert.txt);
			const publication: LanMdnsPublication = {
				// `bonjour-service` has no in-place TXT update (1.4.4 registers a
				// snapshot of the records at announce), so a rotated tag reaches
				// the wire only by withdrawing and re-announcing under the SAME
				// name. The goodbye is also what makes a browsing peer see the
				// refreshed advert as a new sighting.
				async updateTxt(txt) {
					try {
						await withdraw(service);
						service = announce(txt);
					} catch (error) {
						options?.onError?.(error);
					}
				},
				stop: () => withdraw(service),
			};
			return Promise.resolve(publication);
		},

		browse(type: string, onRecord: (record: unknown) => void): LanMdnsBrowse {
			const deliver = (service: unknown): void => {
				try {
					onRecord(service);
				} catch (error) {
					options?.onError?.(error);
				}
			};
			const browser = bonjour.find({ type }, deliver);
			// `find`'s callback is the first sighting only. A peer whose responder
			// refreshes its TXT in place reports the rotated tag as an update, and
			// without this a known peer silently ages out of the candidate table.
			browser.on?.(BROWSER_TXT_UPDATE_EVENT, deliver);
			browser.on?.("error", (error) => options?.onError?.(error));
			return {
				stop() {
					try {
						browser.stop();
						browser.removeAllListeners?.();
					} catch (error) {
						options?.onError?.(error);
					}
				},
			};
		},

		destroy(): Promise<void> {
			return new Promise<void>((resolve) => {
				try {
					bonjour.destroy(() => resolve());
				} catch {
					resolve();
				}
				setTimeout(resolve, 1_000).unref?.();
			});
		},
	};
}
