/**
 * Stage 10.5c — `ActiveRelayOrchestrator`.
 *
 * Single source of truth for the live transport's lifecycle. Bridges
 * `setActiveVaultSession` ↔ the wire-path port (`LoopbackRelayPort` or
 * `WebSocketRelayPort`) so the rest of the shell never has to know which
 * implementation backs the currently-open vault.
 *
 *   - On session set: reads `vault.json.syncRelay`. Absent ⇒ loopback;
 *     present ⇒ `WebSocketRelayPort({url})`. The previous port (if any)
 *     is closed cleanly; subscriptions and frame listeners are migrated
 *     to the replacement so consumers don't have to re-bind.
 *   - On session clear: tears the port down to a loopback so any
 *     stragglers still hold a valid `RelayPort`.
 *   - `reconfigure()` re-reads vault.json after a `setSyncRelayConfig`
 *     mutation and rebuilds the port. Idempotent — calling with the same
 *     resolved config is a no-op (no port flap, no listener churn).
 *
 * **Relay-blind invariant carries forward.** This file intentionally has
 * zero crypto / credential imports. The 12th structural CI fence at
 * `tools/mcp-server/src/tools/relay-noble-import-check.ts` matches
 * `**\/sync/**\/*relay*.ts` — adding a forbidden import here fails the
 * audit.
 */

// relay-blind: this file intentionally has zero crypto/credential imports.
// The CI gate at tools/mcp-server/src/tools/relay-noble-import-check.ts
// asserts this; the imports below are forbidden and any future addition
// requires a per-line `// relay-blind-exempt` review note.

import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CatalogEntry, LoopbackRelayPort, type RelayPort } from "./relay-port";
import { WebSocketRelayPort } from "./websocket-relay-port";

export enum ActiveRelayKind {
	Loopback = "loopback",
	WebSocket = "websocket",
}

export type ActiveRelayState = {
	kind: ActiveRelayKind;
	port: RelayPort;
	syncRelayUrl?: string;
};

/** Minimal vault-session surface the orchestrator reads. Defined locally so
 *  this module doesn't import from `../vault` (keeps the relay-blind scope
 *  free of any transitive credential-store imports). */
export type ActiveRelayVaultSession = {
	vaultId: string;
	vaultPath: string;
};

export type MakeRelayPort = (url: string) => RelayPort;
export type MakeLoopbackPort = () => RelayPort;

export type ActiveRelayOptions = {
	/** Pluggable for tests. Defaults to `(url) => new WebSocketRelayPort({url})`. */
	makeRelayPort?: MakeRelayPort;
	/** Pluggable for tests. Defaults to a singleton-pair loopback (one self-bus). */
	makeLoopback?: MakeLoopbackPort;
	/** Pluggable for tests. Defaults to reading `<vaultPath>/vault.json`. */
	readSyncRelayUrl?: (vaultPath: string) => Promise<string | null>;
};

const STATE_EVENT = "state";

function makeDefaultLoopback(): RelayPort {
	const [port] = LoopbackRelayPort.pair(1);
	if (!port) throw new Error("ActiveRelayOrchestrator: failed to mint loopback port");
	return port;
}

function makeDefaultWebSocketPort(url: string): RelayPort {
	const port = new WebSocketRelayPort({ url });
	port.connect();
	return port;
}

/**
 * Default `vault.json` reader. Resilient to a missing / malformed file —
 * returns `null` rather than throwing so a transient FS hiccup degrades to
 * loopback (which is the safe default for any uncertain state).
 */
export async function readVaultSyncRelayUrl(vaultPath: string): Promise<string | null> {
	try {
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const parsed = JSON.parse(raw) as { syncRelay?: { url?: unknown } };
		if (
			parsed.syncRelay &&
			typeof parsed.syncRelay === "object" &&
			typeof parsed.syncRelay.url === "string" &&
			parsed.syncRelay.url.length > 0
		) {
			return parsed.syncRelay.url;
		}
		return null;
	} catch {
		return null;
	}
}

export class ActiveRelayOrchestrator {
	readonly #emitter = new EventEmitter();
	readonly #makeRelayPort: MakeRelayPort;
	readonly #makeLoopback: MakeLoopbackPort;
	readonly #readSyncRelayUrl: (vaultPath: string) => Promise<string | null>;
	readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
	readonly #subscribed = new Set<string>();
	#current: ActiveRelayState;
	#activeSession: ActiveRelayVaultSession | null = null;
	#switching: Promise<void> | null = null;
	#disposed = false;

	constructor(opts: ActiveRelayOptions = {}) {
		this.#makeRelayPort = opts.makeRelayPort ?? makeDefaultWebSocketPort;
		this.#makeLoopback = opts.makeLoopback ?? makeDefaultLoopback;
		this.#readSyncRelayUrl = opts.readSyncRelayUrl ?? readVaultSyncRelayUrl;
		this.#current = this.#mintLoopbackState();
	}

	/** Current `RelayPort` — the live one. Use this for `send` / subscribe. */
	currentPort(): RelayPort {
		return this.#current.port;
	}

	/** Observable snapshot of the live state (for 10.7's sync-status panel). */
	state(): ActiveRelayState {
		const { kind, port, syncRelayUrl } = this.#current;
		const out: ActiveRelayState = { kind, port };
		if (syncRelayUrl !== undefined) out.syncRelayUrl = syncRelayUrl;
		return out;
	}

	/**
	 * Register a frame listener. Listeners survive port swaps: when the
	 * orchestrator rotates loopback↔websocket the listener is re-attached
	 * to the new port automatically.
	 */
	onFrame(cb: (frame: Uint8Array) => void): void {
		this.#frameListeners.add(cb);
		this.#current.port.onFrame(cb);
	}

	offFrame(cb: (frame: Uint8Array) => void): void {
		this.#frameListeners.delete(cb);
		this.#current.port.offFrame(cb);
	}

	/**
	 * Subscribe to a routing key (entity id or pairing-channel id). The
	 * subscription survives port swaps — on a rebuild the new port (if
	 * subscription-aware) is told to subscribe to every key in the set.
	 */
	subscribe(routingKey: string): void {
		this.#subscribed.add(routingKey);
		maybeSubscribe(this.#current.port, routingKey);
	}

	unsubscribe(routingKey: string): void {
		this.#subscribed.delete(routingKey);
		maybeUnsubscribe(this.#current.port, routingKey);
	}

	/**
	 * 10.10 — subscribe many routing keys at once (the fresh-device bootstrap
	 * path). Delegates to the port's `subscribeBatch` when the transport has one
	 * (the WebSocket port coalesces into chunked `bundle:true` controls so the
	 * durable node serves bundled backfill); otherwise falls back to per-key
	 * subscribe. All keys join the swap-surviving subscription set either way.
	 */
	subscribeBatch(routingKeys: readonly string[]): void {
		for (const key of routingKeys) this.#subscribed.add(key);
		const port = this.#current.port as RelayPort & {
			subscribeBatch?: (keys: readonly string[]) => void;
		};
		if (typeof port.subscribeBatch === "function") {
			try {
				port.subscribeBatch(routingKeys);
			} catch {
				// Disposed-port subscribe is a no-op; the reconnect re-fires.
			}
			return;
		}
		for (const key of routingKeys) maybeSubscribe(this.#current.port, key);
	}

	/**
	 * Stage 10.14 — request the durable node's catalog for `account`. Delegates
	 * to the current port if it supports it (the WebSocket transport does;
	 * loopback has no server, so this rejects there). The cold-restore consumer
	 * calls this through the live `RelaySurface`.
	 */
	requestCatalog(account: string): Promise<CatalogEntry[]> {
		const withCatalog = this.#current.port as RelayPort & {
			requestCatalog?: (account: string) => Promise<CatalogEntry[]>;
		};
		if (typeof withCatalog.requestCatalog !== "function") {
			return Promise.reject(
				new Error("ActiveRelayOrchestrator.requestCatalog: transport has no durable node"),
			);
		}
		return withCatalog.requestCatalog(account);
	}

	/**
	 * Asset-B4 — send one blob-plane request frame (HAS/PUT/GET) over the live
	 * port's asset channel and resolve with the node's response. Delegates to the
	 * current port if it supports it (the WebSocket transport does; loopback has
	 * no CAS, so this rejects there). The asset up/download path calls this
	 * through the live `RelaySurface` via `relayAssetCas`.
	 */
	requestAsset(frame: Uint8Array): Promise<Uint8Array> {
		const withAsset = this.#current.port as RelayPort & {
			requestAsset?: (frame: Uint8Array) => Promise<Uint8Array>;
		};
		if (typeof withAsset.requestAsset !== "function") {
			return Promise.reject(
				new Error("ActiveRelayOrchestrator.requestAsset: transport has no durable node"),
			);
		}
		return withAsset.requestAsset(frame);
	}

	/**
	 * Stage 10.14 — whether the CURRENT transport can answer a catalog query
	 * (i.e. is a durable-node-capable WebSocket port, not a loopback). The
	 * orchestrator always exposes `requestCatalog`, so callers gating the
	 * restore offer must probe the underlying port through this, not the
	 * always-present method.
	 */
	hasDurableNode(): boolean {
		const port = this.#current.port as RelayPort & {
			requestCatalog?: (account: string) => Promise<CatalogEntry[]>;
		};
		return typeof port.requestCatalog === "function";
	}

	/**
	 * Asset-B4 — whether the CURRENT transport can carry the blob plane (a
	 * durable-node WebSocket port, not a loopback). `requestAsset` is always
	 * present on the orchestrator (it rejects when unsupported), so upload-on-
	 * bind / serve-on-miss must probe the underlying port through this before
	 * attempting a transfer, rather than calling + catching. Mirrors
	 * `hasDurableNode` (the asset plane rides the same WebSocket port).
	 */
	hasAssetPlane(): boolean {
		const port = this.#current.port as RelayPort & {
			requestAsset?: (frame: Uint8Array) => Promise<Uint8Array>;
		};
		return typeof port.requestAsset === "function";
	}

	on(event: "state", listener: (state: ActiveRelayState) => void): this {
		this.#emitter.on(STATE_EVENT, listener);
		return this;
	}

	off(event: "state", listener: (state: ActiveRelayState) => void): this {
		this.#emitter.off(STATE_EVENT, listener);
		return this;
	}

	/**
	 * Called by `setActiveVaultSession` on every session set/clear. The
	 * orchestrator reads `vault.json.syncRelay` and rebuilds the port to
	 * match. Returns a promise the caller can `await` in tests; production
	 * callers fire-and-forget.
	 */
	onSessionChanged(session: ActiveRelayVaultSession | null): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#activeSession = session;
		return this.#rebuild();
	}

	/**
	 * Re-read vault.json and rebuild the port if the resolved transport
	 * changed (e.g. `setSyncRelayConfig` mutated the URL). No-op when the
	 * resolved transport is the same.
	 */
	reconfigure(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		return this.#rebuild();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#activeSession = null;
		this.#frameListeners.clear();
		this.#subscribed.clear();
		try {
			this.#current.port.close();
		} catch {
			// Port close throws on some impls if already closed — ignore.
		}
		this.#emitter.removeAllListeners();
	}

	#mintLoopbackState(): ActiveRelayState {
		return { kind: ActiveRelayKind.Loopback, port: this.#makeLoopback() };
	}

	async #rebuild(): Promise<void> {
		// Serialize concurrent rebuilds so two rapid session changes don't
		// race on the close/open sequence and leave a stale port behind.
		const prior = this.#switching;
		const next = (async () => {
			if (prior) {
				try {
					await prior;
				} catch {
					// Swallow — a prior rebuild's failure shouldn't block this one.
				}
			}
			await this.#performRebuild();
		})();
		this.#switching = next;
		try {
			await next;
		} finally {
			if (this.#switching === next) this.#switching = null;
		}
	}

	async #performRebuild(): Promise<void> {
		if (this.#disposed) return;
		const session = this.#activeSession;
		// Resolve the DESIRED shape first WITHOUT building a port — building
		// a port is expensive (opens a real WebSocket on the production
		// path) and would happen every reconfigure call, even no-op ones,
		// if we built unconditionally.
		const desiredKind = !session ? ActiveRelayKind.Loopback : null;
		const desiredUrl =
			session && desiredKind === null ? await this.#readSyncRelayUrl(session.vaultPath) : null;
		const resolvedKind =
			desiredKind ?? (desiredUrl ? ActiveRelayKind.WebSocket : ActiveRelayKind.Loopback);
		const before = this.#current;
		if (before.kind === resolvedKind && (before.syncRelayUrl ?? null) === (desiredUrl ?? null)) {
			// Same transport already live — no port flap, no port build.
			return;
		}
		const desired: ActiveRelayState =
			resolvedKind === ActiveRelayKind.WebSocket && desiredUrl
				? {
						kind: ActiveRelayKind.WebSocket,
						port: this.#makeRelayPort(desiredUrl),
						syncRelayUrl: desiredUrl,
					}
				: this.#mintLoopbackState();
		this.#current = desired;
		// Migrate listeners and subscriptions to the replacement BEFORE
		// closing the old one so an inflight frame doesn't slip through a
		// listener-less gap.
		for (const listener of this.#frameListeners) {
			desired.port.onFrame(listener);
		}
		for (const key of this.#subscribed) {
			maybeSubscribe(desired.port, key);
		}
		try {
			before.port.close();
		} catch {
			// Old port already closed / never opened — fine.
		}
		this.#emitter.emit(STATE_EVENT, this.state());
	}
}

function maybeSubscribe(port: RelayPort, key: string): void {
	const withSub = port as RelayPort & { subscribe?: (k: string) => void };
	if (typeof withSub.subscribe === "function") {
		try {
			withSub.subscribe(key);
		} catch {
			// Subscription-aware ports throw on disposed state; the caller
			// has no recourse — drop the call, the reconnect re-fires.
		}
	}
}

function maybeUnsubscribe(port: RelayPort, key: string): void {
	const withUnsub = port as RelayPort & { unsubscribe?: (k: string) => void };
	if (typeof withUnsub.unsubscribe === "function") {
		try {
			withUnsub.unsubscribe(key);
		} catch {
			// Same as subscribe — disposed-port unsubscribe is a no-op.
		}
	}
}

// --- module-level singleton ---------------------------------------------

let singleton: ActiveRelayOrchestrator | null = null;

/** Initialize the module-level orchestrator (called once from `main/index.ts`).
 *  Returns the orchestrator. Calling twice replaces the prior instance — the
 *  test harness uses that to swap a real one for a fake. */
export function installActiveRelay(orchestrator: ActiveRelayOrchestrator): ActiveRelayOrchestrator {
	if (singleton && singleton !== orchestrator) {
		try {
			singleton.dispose();
		} catch {
			// best-effort
		}
	}
	singleton = orchestrator;
	return orchestrator;
}

/** Read the live orchestrator. Returns `null` if `installActiveRelay` was
 *  never called — production callers should treat that as "transport not
 *  yet available" and short-circuit. */
export function getActiveRelay(): ActiveRelayOrchestrator | null {
	return singleton;
}

/** Tear down + clear the singleton. Used by tests + by app shutdown. */
export function disposeActiveRelay(): void {
	if (!singleton) return;
	try {
		singleton.dispose();
	} catch {
		// best-effort
	}
	singleton = null;
}
