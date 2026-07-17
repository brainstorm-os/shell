/**
 * PRES-3 — the reusable presence hook for a shared-entity app header.
 *
 * `usePresence(entityId, type, self)` publishes THIS device's presence for an
 * entity and returns the live remote peers — cross-device in the shell (over the
 * PRES-2b `presence` IPC transport), single-device standalone / in preview. Feed
 * the result straight to `<PresenceStack peers={...} />`. It rebinds on an
 * entity change and clears our presence on unmount.
 *
 * The dependency shape: this couples the transport (`@brainstorm/react-yjs`:
 * `createSyncedAwareness` / `createPresenceTransport` / `useAwareness`) to the
 * read-side (`awarenessToPeers` / `buildLocalPresence`, this package). It reads
 * the sandbox runtime off `window.brainstorm` — the same coupling `useVaultEntities`
 * already has — loosely typed to the presence slice only.
 */

import {
	type LocalAwareness,
	createLocalAwareness,
	createPresenceTransport,
	createSyncedAwareness,
	useAwareness,
} from "@brainstorm/react-yjs";
import { useEffect, useMemo, useState } from "react";
import {
	PRESENCE_STATE_KEY,
	type PresenceSelf,
	awarenessToPeers,
	buildLocalPresence,
} from "./presence-awareness";
import type { PresencePeer } from "./presence-stack";

/** The presence slice of the sandbox runtime (`window.brainstorm`) — the calls
 *  (`services.presence`) + the peer push (`presence.onPeers`). */
type PresenceRuntime = {
	services?: {
		presence?: {
			publish(input: {
				entityId: string;
				type: string;
				state: Record<string, unknown> | null;
			}): Promise<void>;
			untrack(input: { entityId: string }): Promise<void>;
		};
	};
	presence?: {
		onPeers(
			entityId: string,
			handler: (peers: { clientId: number; state: Record<string, unknown> }[]) => void,
		): () => void;
	};
};

/** This device's identity for the presence payload, sourced from the roster
 *  (`RosterSelf` is structurally a {@link PresenceSelf}). `null` until it
 *  resolves / outside the shell. Pass straight into {@link usePresence}. */
export function useSelf(): PresenceSelf | null {
	const [self, setSelf] = useState<PresenceSelf | null>(null);
	useEffect(() => {
		const roster = (
			globalThis as { brainstorm?: { services?: { roster?: { self?: () => Promise<PresenceSelf> } } } }
		).brainstorm?.services?.roster;
		if (!roster?.self) return;
		let cancelled = false;
		void roster.self().then((s) => {
			if (!cancelled && s) setSelf(s);
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return self;
}

function presenceRuntime(): PresenceRuntime | null {
	return (globalThis as { brainstorm?: PresenceRuntime }).brainstorm ?? null;
}

/**
 * Awareness for `entityId` of `type`: the real DEK-sealed presence transport when
 * running in the shell (both the service AND the peer push are present), else a
 * local single-device channel. The board/note id must be the vault entity id —
 * the main-side gate resolves its type to check `entities.read`.
 */
export function presenceAwarenessFor(entityId: string, type: string): LocalAwareness {
	const bs = presenceRuntime();
	const publish = bs?.services?.presence;
	const push = bs?.presence;
	if (!publish || !push) return createLocalAwareness();
	// Presence is display-only — a refused publish (entity unknown to the
	// vault, capability denied, session mid-swap) must degrade to "no avatar
	// stack", never bubble as an unhandled rejection / pageerror (F-393: the
	// broker's `presence.publish: unknown entity` surfaced as a renderer
	// pageerror). Log once per awareness so a genuine wiring bug stays visible.
	let warned = false;
	const swallow = (error: unknown): void => {
		if (warned) return;
		warned = true;
		console.warn(`[presence] publish for ${entityId} unavailable:`, error);
	};
	return createSyncedAwareness(
		createPresenceTransport({
			publish: (state) => {
				void publish.publish({ entityId, type, state }).catch(swallow);
			},
			untrack: () => {
				void publish.untrack({ entityId }).catch(swallow);
			},
			onPeers: (handler) => push.onPeers(entityId, handler),
		}),
	);
}

/**
 * Live remote peers on `entityId`, and publish `self` as this device's presence.
 * `null` entityId (nothing open) ⇒ an inert local channel (no peers). Pass a
 * STABLE `self` (memoize it) — its fields drive the publish effect.
 */
export function usePresence(
	entityId: string | null,
	type: string,
	self: PresenceSelf | null,
): PresencePeer[] {
	const awareness = useMemo<LocalAwareness>(
		() => (entityId ? presenceAwarenessFor(entityId, type) : createLocalAwareness()),
		[entityId, type],
	);

	// Tear down (clears our presence for peers) when the entity changes or on unmount.
	useEffect(() => () => awareness.destroy(), [awareness]);

	const live = useAwareness(awareness);

	// Publish (or clear) this device's presence. `self` must be a stable ref
	// (`useSelf` returns one) so a re-render with the same identity doesn't churn.
	useEffect(() => {
		if (self)
			awareness.setLocalStateField(PRESENCE_STATE_KEY, buildLocalPresence(self, awareness.clientID));
		else awareness.setLocalState(null);
	}, [awareness, self]);

	return useMemo(() => awarenessToPeers(live.states, live.clientID), [live.states, live.clientID]);
}
