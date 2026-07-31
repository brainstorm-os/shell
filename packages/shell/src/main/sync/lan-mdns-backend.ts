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
	LanAdvertRecord,
	LanMdnsBackend,
	LanMdnsBrowse,
	LanMdnsPublication,
} from "./lan-discovery";

/** The slice of `bonjour-service` this adapter uses, declared structurally so
 *  the module typechecks without the package's types on the workspace path. */
type BonjourLike = {
	publish(opts: {
		name: string;
		type: string;
		port: number;
		txt: Record<string, string>;
	}): BonjourServiceLike;
	find(
		opts: { type: string },
		onUp: (service: unknown) => void,
	): { stop(): void; removeAllListeners?: () => void };
	destroy(callback?: () => void): void;
};

type BonjourServiceLike = {
	stop(callback?: () => void): void;
	updateTxt?(txt: Record<string, string>): void;
	on?(event: string, listener: (...args: unknown[]) => void): void;
};

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
		publish(advert: LanAdvertRecord & { type: string }): Promise<LanMdnsPublication> {
			const service = bonjour.publish({
				name: advert.name,
				type: advert.type,
				port: advert.port,
				txt: { ...advert.txt },
			});
			// A responder error after publish must not become an unhandled 'error'
			// event on the emitter, which would take the main process down.
			service.on?.("error", (error) => options?.onError?.(error));
			const publication: LanMdnsPublication = {
				updateTxt(txt) {
					try {
						service.updateTxt?.({ ...txt });
					} catch (error) {
						options?.onError?.(error);
					}
					return Promise.resolve();
				},
				stop() {
					return new Promise<void>((resolve) => {
						try {
							service.stop(() => resolve());
						} catch {
							resolve();
						}
						// `stop` does not always invoke its callback when the socket is
						// already gone; do not hang the reconcile queue on it.
						setTimeout(resolve, 1_000).unref?.();
					});
				},
			};
			return Promise.resolve(publication);
		},

		browse(type: string, onRecord: (record: unknown) => void): LanMdnsBrowse {
			const browser = bonjour.find({ type }, (service) => {
				try {
					onRecord(service);
				} catch (error) {
					options?.onError?.(error);
				}
			});
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
