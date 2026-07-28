/**
 * Starts and stops the LAN listener from the host-listen policy — the piece that
 * finally gives `LanRelayListener` a production consumer.
 *
 * All of the *deciding* lives in `lan-host-policy.ts`; all of the *socket* lives
 * in `lan-relay-listener.ts`. This is only the reconciliation loop between them:
 * something changed → recompute `shouldListenOnLan` → make reality match. Kept
 * separate because a start/stop loop has its own failure modes that have nothing
 * to do with either neighbour:
 *
 *  - **Reentrancy.** `apply()` is async (binding a socket is), and it can be
 *    called again while a previous call is still in flight — a vault opening as
 *    the user flips the toggle. Without serialisation two listeners bind, and
 *    only one is tracked, so the other leaks for the process lifetime.
 *  - **Bind failure must not be fatal.** A busy port or a vanished interface has
 *    to leave the app running with LAN simply off, not take down the main process.
 *  - **Stop must be idempotent** and safe to call when never started, because
 *    teardown runs on paths that may never have started it (vault close on a
 *    device with the mode Off).
 *
 * Deliberately NOT named `*relay*`: the relay-blind fence scans that pattern for
 * crypto imports. This file has none — it wires an already-built host — but the
 * name would put it in scope for no reason.
 */

import { type LanHostState, shouldListenOnLan } from "./lan-host-policy";

/** The listener surface this controller drives (structural, so tests need no socket). */
export type LanListenerLike = {
	start(): Promise<{ url: string }>;
	stop(): Promise<void>;
};

export type LanHostControllerOptions = {
	/** Current policy inputs, read fresh on every `apply()`. */
	readState: () => LanHostState;
	/** Build a listener. Called once per start, so each bind gets a fresh host. */
	createListener: () => LanListenerLike | null;
	/** Bind failures + teardown errors. Never thrown onwards. */
	onError?: (error: unknown) => void;
	/** Called whenever the advertised URL changes (`null` when not listening). */
	onUrlChanged?: (url: string | null) => void;
};

export class LanHostController {
	#listener: LanListenerLike | null = null;
	#url: string | null = null;
	/** Serialises overlapping `apply()` calls — see the reentrancy note. */
	#queue: Promise<void> = Promise.resolve();
	#disposed = false;

	constructor(private readonly options: LanHostControllerOptions) {}

	/** The bound URL, or `null` when not listening. */
	get url(): string | null {
		return this.#url;
	}

	get listening(): boolean {
		return this.#listener !== null;
	}

	/**
	 * Reconcile reality with the policy. Safe to call on any change — session,
	 * toggle, share state — and safe to call concurrently.
	 */
	apply(): Promise<void> {
		this.#queue = this.#queue.then(() => this.#reconcile()).catch(() => undefined);
		return this.#queue;
	}

	/** Stop listening and refuse further work. Idempotent. */
	async dispose(): Promise<void> {
		this.#disposed = true;
		const pending = this.#queue;
		await pending.catch(() => undefined);
		await this.#stop();
	}

	async #reconcile(): Promise<void> {
		if (this.#disposed) {
			await this.#stop();
			return;
		}
		const want = shouldListenOnLan(this.options.readState());
		if (want === this.listening) return;
		if (want) await this.#start();
		else await this.#stop();
	}

	async #start(): Promise<void> {
		const listener = this.options.createListener();
		if (!listener) return; // no session / no bindable interface — stay off
		try {
			const { url } = await listener.start();
			// A dispose that landed while the socket was binding must not leave it
			// bound: we own it now, so tear it down rather than tracking it.
			if (this.#disposed) {
				await listener.stop().catch(() => undefined);
				return;
			}
			this.#listener = listener;
			this.#setUrl(url);
		} catch (error) {
			// A busy port or a vanished interface leaves LAN off, app running.
			this.options.onError?.(error);
			await listener.stop().catch(() => undefined);
		}
	}

	async #stop(): Promise<void> {
		const listener = this.#listener;
		this.#listener = null;
		this.#setUrl(null);
		if (!listener) return;
		try {
			await listener.stop();
		} catch (error) {
			this.options.onError?.(error);
		}
	}

	#setUrl(url: string | null): void {
		if (this.#url === url) return;
		this.#url = url;
		this.options.onUrlChanged?.(url);
	}
}
