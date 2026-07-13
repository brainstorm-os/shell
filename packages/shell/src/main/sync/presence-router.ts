/**
 * PRES-2b (design [74](../../../../../docs/data/74-presence-transport.md)) —
 * the MAIN-side presence router: the sandbox-facing half of the transport.
 *
 * The {@link PresenceManager} (PRES-2a) owns the per-entity proxy awareness and
 * the relay bridge. This router sits above it and connects the SANDBOX:
 *
 *   app `presence.publish(entityId, state)` ─▶ router ─▶ manager.setLocal ─▶ relay
 *   relay ─▶ manager.applyInbound ─▶ onChange ─▶ router ─▶ `app:presence-peers` push
 *
 * It owns two things the manager deliberately doesn't:
 *   1. **A per-entity subscriber set** — which apps published presence for an
 *      entity (so which app windows should receive the peer pushes).
 *   2. **The outbound fan-out** — on any peer change it pushes the merged peer
 *      set to exactly those apps' windows.
 *
 * SECURITY — the outbound push carries no new authorization surface (mirrors
 * `ydoc-remote-broadcast`): a peer push only ever reaches an app already in the
 * entity's subscriber set, and an app only enters that set via the cap-gated
 * `presence.publish` (checked against `entities.read:<type>` in the service). So
 * an app can only receive presence for an entity it proved it can read. Presence
 * is display-only — it grants nothing, persists nothing, and every inbound state
 * is untrusted (the render side hardens it via `peerFromState`).
 */

import { type AppWindow, isAppWindowLive } from "../apps/launcher";
import type { PresenceManager } from "./presence-manager";

/** Must match the `ipcRenderer.on(...)` channel in `app-preload.ts`. */
export const APP_PRESENCE_PEERS_CHANNEL = "app:presence-peers";

/** One remote device's presence for an entity — a client id (the sender's proxy
 *  clientID) + its opaque, untrusted state map. */
export type PresencePeer = { clientId: number; state: Record<string, unknown> };

/** The main→renderer peer snapshot for one entity. The renderer transport diffs
 *  it against the last-seen set to drive `applyRemoteState` (departures = a
 *  clientId dropping out of `peers`). */
export type PresencePeersPayload = { entityId: string; peers: PresencePeer[] };

/**
 * Push an entity's peer snapshot to exactly the windows of `targetApps` (the
 * apps that published presence for it, so already past the `entities.read`
 * gate). Mirrors `deliverYDocUpdateToApps`: skip destroyed windows, swallow a
 * single failing send, and return the subset of `targetApps` that had **no live
 * window** so the caller can prune a dead app's subscription.
 */
export function deliverPresencePeersToApps(
	appWindows: readonly AppWindow[],
	entityId: string,
	peers: readonly PresencePeer[],
	targetApps: readonly string[],
): readonly string[] {
	if (targetApps.length === 0) return [];
	const targets = new Set(targetApps);
	const liveApps = new Set<string>();
	const payload: PresencePeersPayload = { entityId, peers: [...peers] };
	for (const win of appWindows) {
		if (!targets.has(win.appId)) continue;
		if (!isAppWindowLive(win)) continue;
		liveApps.add(win.appId);
		try {
			win.webContents.send(APP_PRESENCE_PEERS_CHANNEL, payload);
		} catch (error) {
			console.warn(`[brainstorm] presence-peers push to ${win.appId} failed:`, error);
		}
	}
	return targetApps.filter((a) => !liveApps.has(a));
}

export type PresenceRouterOptions = {
	readonly manager: PresenceManager;
	/** The live app windows, read on every push so a window open/close is
	 *  transparent (mirrors the entities broadcast wiring). */
	readonly getAppWindows: () => readonly AppWindow[];
};

export class PresenceRouter {
	readonly #manager: PresenceManager;
	readonly #getAppWindows: () => readonly AppWindow[];
	/** entityId → apps that published presence (the peer-push audience). */
	readonly #subscribers = new Map<string, Set<string>>();
	/** entityId → the manager `onChange` unsubscribe, so we wire it exactly once. */
	readonly #onChangeUnsub = new Map<string, () => void>();
	#disposed = false;

	constructor(opts: PresenceRouterOptions) {
		this.#manager = opts.manager;
		this.#getAppWindows = opts.getAppWindows;
	}

	/** An app publishes THIS device's presence for `entityId` (or `null` to clear
	 *  it). Registers the app as a peer-push subscriber, wires the manager change
	 *  listener once per entity, sets the local state, and delivers the current
	 *  peer set back so the just-subscribed app sees who's already there. */
	publish(app: string, entityId: string, state: Record<string, unknown> | null): void {
		if (this.#disposed) return;
		let subs = this.#subscribers.get(entityId);
		if (!subs) {
			subs = new Set();
			this.#subscribers.set(entityId, subs);
		}
		subs.add(app);
		if (!this.#onChangeUnsub.has(entityId)) {
			this.#onChangeUnsub.set(
				entityId,
				this.#manager.onChange(entityId, () => this.#pushPeers(entityId)),
			);
		}
		this.#manager.setLocal(entityId, state);
		this.#pushPeers(entityId);
	}

	/** An app stops tracking `entityId` (surface closed). Drops it from the peer
	 *  audience; when the last app leaves, tears down the manager proxy (which
	 *  broadcasts a final null so peers drop us). */
	untrack(app: string, entityId: string): void {
		const subs = this.#subscribers.get(entityId);
		if (!subs) return;
		subs.delete(app);
		if (subs.size === 0) this.#teardownEntity(entityId);
	}

	/** Drop an app from EVERY entity it's subscribed to (its window closed /
	 *  renderer died). Called by the runtime on app-window teardown. */
	dropApp(app: string): void {
		for (const [entityId, subs] of [...this.#subscribers]) {
			if (subs.delete(app) && subs.size === 0) this.#teardownEntity(entityId);
		}
	}

	/** Route an inbound relay awareness frame (bytes) into the manager proxy —
	 *  the manager's change listener then fans the merged peers to subscribers. */
	applyInbound(entityId: string, awarenessUpdate: Uint8Array): void {
		if (this.#disposed) return;
		this.#manager.applyInbound(entityId, awarenessUpdate);
	}

	/** Dev/dogfood introspection — the merged remote peer states for an entity. */
	remotePeerSnapshots(entityId: string): readonly PresencePeer[] {
		return [...this.#manager.remoteStates(entityId)].map(([clientId, state]) => ({
			clientId,
			state,
		}));
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsub of this.#onChangeUnsub.values()) unsub();
		this.#onChangeUnsub.clear();
		this.#subscribers.clear();
		this.#manager.dispose();
	}

	#teardownEntity(entityId: string): void {
		this.#subscribers.delete(entityId);
		this.#onChangeUnsub.get(entityId)?.();
		this.#onChangeUnsub.delete(entityId);
		this.#manager.untrack(entityId);
	}

	#pushPeers(entityId: string): void {
		const subs = this.#subscribers.get(entityId);
		if (!subs || subs.size === 0) return;
		const peers: PresencePeer[] = [...this.#manager.remoteStates(entityId)].map(
			([clientId, state]) => ({ clientId, state }),
		);
		const dead = deliverPresencePeersToApps(this.#getAppWindows(), entityId, peers, [...subs]);
		for (const app of dead) subs.delete(app);
		if (subs.size === 0) this.#teardownEntity(entityId);
	}
}
