/**
 * P2P-1 — the discovery lifecycle: advertise this device, browse for the
 * others, rotate the tag as epochs roll.
 *
 * The rules live in `lan-discovery.ts` and the crypto in `lan-discovery-tag.ts`;
 * this is only the reconciliation loop between a policy ("should we be
 * discoverable / should we be looking?") and a multicast responder, in the same
 * shape as `LanHostController`. It is its own file for the same reason that one
 * is: a start/stop loop has failure modes that belong to neither neighbour.
 *
 *  - **Reentrancy.** `apply()` is async (publishing binds a socket) and can be
 *    called again while a previous call is in flight, so calls are serialised
 *    on a queue. Two publications for one device would advertise two instance
 *    names and only one would be tracked.
 *  - **A responder that will not bind is not fatal.** `OQ-P2P-3` is explicitly
 *    open on whether UDP 5353 can be shared with `avahi-daemon` or the Windows
 *    responder. A backend that throws leaves discovery off and the rest of LAN
 *    sync — pairing bootstrap and manual entry — working, because those never
 *    needed multicast.
 *  - **No secret, no advert.** Without a session there is no sovereign key, so
 *    there is no tag, so there is nothing legitimate to advertise and nothing
 *    we could verify if we browsed. That is a refusal, not a degraded mode.
 */

import {
	LAN_SERVICE_TYPE,
	type LanAdvertRecord,
	type LanMdnsBackend,
	type LanMdnsBrowse,
	type LanMdnsPublication,
	type LanPeerCandidate,
	buildLanAdvertTxt,
	mintLanInstanceName,
	parseLanAdvert,
} from "./lan-discovery";
import { LAN_DISCOVERY_EPOCH_MS } from "./lan-discovery-tag";

/** What this device wants discovery to be doing right now. */
export type LanDiscoveryState = {
	/** Publish an advert for our listener. Only meaningful while hosting. */
	advertise: boolean;
	/** Browse for peers. Independent of advertising: a device that does not
	 *  accept connections still wants to find one that does. */
	browse: boolean;
	/** Our listener's bound address + port, or `null` when not listening. */
	listener: { addresses: readonly string[]; port: number } | null;
};

export type LanDiscoveryServiceOptions = {
	/** Current policy inputs, read fresh on every `apply()`. */
	readState: () => LanDiscoveryState;
	/** The identity's discovery secret, or `null` with no session. Read per
	 *  access so a vault close stops us mid-flight rather than at the next
	 *  restart. */
	discoverySecret: () => Uint8Array | null;
	/** The responder. `null` ⇒ discovery is unavailable on this platform and
	 *  every operation is a no-op (see `OQ-P2P-3`). */
	backend: LanMdnsBackend | null;
	/** A verified peer showed up. Fires per browse record that survives
	 *  `parseLanAdvert`, including repeats — de-duplication is the consumer's
	 *  job because a repeat is also how an address change arrives. */
	onCandidate: (candidate: LanPeerCandidate) => void;
	/** Publish/browse failures. Never thrown onwards. */
	onError?: (error: unknown) => void;
	now?: () => number;
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	randomBytes?: (n: number) => Uint8Array;
};

export class LanDiscoveryService {
	readonly #options: LanDiscoveryServiceOptions;
	readonly #now: () => number;
	readonly #setTimer: (cb: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	readonly #randomBytes: (n: number) => Uint8Array;
	#publication: LanMdnsPublication | null = null;
	#browse: LanMdnsBrowse | null = null;
	#instance: string | null = null;
	#advertKey: string | null = null;
	#rotateHandle: unknown = null;
	#queue: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(options: LanDiscoveryServiceOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
		this.#clearTimer =
			options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.#randomBytes =
			options.randomBytes ??
			((n) => {
				const out = new Uint8Array(n);
				(globalThis.crypto as Crypto).getRandomValues(out);
				return out;
			});
	}

	/** The advertised instance name while publishing, else `null`. */
	get instance(): string | null {
		return this.#instance;
	}

	get advertising(): boolean {
		return this.#publication !== null;
	}

	get browsing(): boolean {
		return this.#browse !== null;
	}

	/** Reconcile reality with the policy. Safe to call concurrently. */
	apply(): Promise<void> {
		this.#queue = this.#queue.then(() => this.#reconcile()).catch(() => undefined);
		return this.#queue;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		await this.#queue.catch(() => undefined);
		await this.#stopAdvert();
		this.#stopBrowse();
	}

	async #reconcile(): Promise<void> {
		const backend = this.#options.backend;
		if (this.#disposed || !backend) {
			await this.#stopAdvert();
			this.#stopBrowse();
			return;
		}
		const state = this.#options.readState();
		const secret = this.#options.discoverySecret();
		// No identity ⇒ nothing to prove and nothing we could verify. Refuse
		// both halves rather than advertising an untagged record.
		if (!secret) {
			await this.#stopAdvert();
			this.#stopBrowse();
			return;
		}

		if (state.browse) this.#startBrowse(backend, secret);
		else this.#stopBrowse();

		const wantAdvert = state.advertise && state.listener !== null && state.listener.port > 0;
		if (!wantAdvert) {
			await this.#stopAdvert();
			return;
		}
		const listener = state.listener;
		if (!listener) return;
		await this.#startOrRefreshAdvert(backend, secret, listener);
	}

	#startBrowse(backend: LanMdnsBackend, secret: Uint8Array): void {
		if (this.#browse) return;
		try {
			this.#browse = backend.browse(LAN_SERVICE_TYPE, (record) => {
				// Re-read the secret per record: a vault that closed between the
				// browse starting and this record arriving must not verify.
				const live = this.#options.discoverySecret() ?? secret;
				const candidate = parseLanAdvert({
					record,
					secret: live,
					nowMs: this.#now(),
					ownInstance: this.#instance,
				});
				if (!candidate) return;
				try {
					this.#options.onCandidate(candidate);
				} catch (error) {
					this.#options.onError?.(error);
				}
			});
		} catch (error) {
			this.#browse = null;
			this.#options.onError?.(error);
		}
	}

	#stopBrowse(): void {
		const browse = this.#browse;
		this.#browse = null;
		if (!browse) return;
		try {
			browse.stop();
		} catch (error) {
			this.#options.onError?.(error);
		}
	}

	async #startOrRefreshAdvert(
		backend: LanMdnsBackend,
		secret: Uint8Array,
		listener: { addresses: readonly string[]; port: number },
	): Promise<void> {
		const key = `${listener.port}|${[...listener.addresses].sort().join(",")}`;
		const txt = buildLanAdvertTxt({
			secret,
			port: listener.port,
			addresses: listener.addresses,
			nowMs: this.#now(),
		});
		if (this.#publication && this.#advertKey === key) {
			// Same listener, new epoch: refresh the TXT in place rather than
			// churning the instance name, which peers use as a de-dup key.
			try {
				await this.#publication.updateTxt(txt);
			} catch (error) {
				this.#options.onError?.(error);
			}
			this.#armRotation();
			return;
		}
		await this.#stopAdvert();
		const instance = mintLanInstanceName(this.#randomBytes);
		const advert: LanAdvertRecord & { type: string } = {
			type: LAN_SERVICE_TYPE,
			name: instance,
			port: listener.port,
			txt,
		};
		try {
			const publication = await backend.publish(advert);
			// A dispose that landed while the responder was binding must not leave
			// us advertising: we own it now, so tear it down rather than track it.
			if (this.#disposed) {
				await publication.stop().catch(() => undefined);
				return;
			}
			this.#publication = publication;
			this.#instance = instance;
			this.#advertKey = key;
			this.#armRotation();
		} catch (error) {
			// A responder that will not bind (`OQ-P2P-3`) leaves discovery off and
			// the app running: pairing bootstrap and manual entry still work.
			this.#options.onError?.(error);
		}
	}

	async #stopAdvert(): Promise<void> {
		this.#clearRotation();
		const publication = this.#publication;
		this.#publication = null;
		this.#instance = null;
		this.#advertKey = null;
		if (!publication) return;
		try {
			await publication.stop();
		} catch (error) {
			this.#options.onError?.(error);
		}
	}

	/** Re-mint the TXT when the epoch rolls. Fires a little after the boundary
	 *  so the new tag is already the current one when it goes out. */
	#armRotation(): void {
		this.#clearRotation();
		const now = this.#now();
		const untilNextEpoch = LAN_DISCOVERY_EPOCH_MS - (now % LAN_DISCOVERY_EPOCH_MS);
		this.#rotateHandle = this.#setTimer(() => {
			this.#rotateHandle = null;
			if (this.#disposed) return;
			void this.apply();
		}, untilNextEpoch + 1_000);
	}

	#clearRotation(): void {
		if (this.#rotateHandle !== null) {
			this.#clearTimer(this.#rotateHandle);
			this.#rotateHandle = null;
		}
	}
}
