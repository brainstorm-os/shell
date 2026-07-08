/**
 * The READ side of live presence: map Yjs awareness states → the
 * `PresencePeer[]` that `<PresenceStack>` renders. This DECIDES the presence
 * payload contract (below) as a documented, testable mapping — distinct from
 * guessing it: the wiring rung publishes exactly this shape and mounts the
 * stack; activating the dormant `10.6` broadcaster over the relay is that
 * rung's remaining job.
 *
 * **Payload contract.** Each client publishes, under the `presence` awareness
 * field, `{ id, name, color, avatarRef? }`:
 *   - `id` — the member's **sovereign pubkey** (base64), NOT the Yjs client id.
 *     Stable across a member's tabs/devices so `capPresence` collapses them.
 *   - `name` / `color` — resolved by the publisher (roster displayName +
 *     `peerColor`); this side trusts them (it's the member's own device).
 *   - `avatarRef?` — `brainstorm://asset/…`.
 * A state with no valid `presence` payload (a peer that only publishes a
 * cursor, say) contributes no avatar — it's skipped, not rendered blank.
 *
 * Pure + dependency-free: takes a structural `ReadonlyMap<number, state>` so
 * the SDK module needn't import `@brainstorm/react-yjs`.
 */

import { peerColor } from "../peer-presence";
import type { PresencePeer } from "./presence-stack";

/** The awareness field a client publishes its stack presence under. */
export const PRESENCE_STATE_KEY = "presence";

/** This device's identity for the presence payload — the roster self profile
 *  fields the builder needs. `displayName` may be blank (unset); the builder
 *  falls back to `fingerprint` so a peer never renders as "" / "Anonymous". */
export type PresenceSelf = {
	/** Sovereign member pubkey (base64) — the stable `PresencePeer.id`. */
	pubkey: string;
	displayName: string;
	fingerprint: string;
	avatarRef?: string;
};

/**
 * Build THIS device's presence payload — the PUBLISH side of the contract.
 * The wiring rung does `awareness.setLocalStateField(PRESENCE_STATE_KEY,
 * buildLocalPresence(self, doc.clientID))`; `awarenessToPeers` reads the same
 * shape back on peers. `id` is the sovereign pubkey (stable across a member's
 * tabs); `name` prefers the display name, falling back to the key fingerprint
 * (mirrors `useSelfDisplayName` — never blank); `color` is keyed by the Yjs
 * client id via `peerColor` (so a member's two tabs get distinct caret hues,
 * while `capPresence` still collapses them to one avatar by `id`).
 */
export function buildLocalPresence(self: PresenceSelf, clientId: number): PresencePeer {
	const name = self.displayName.trim() || self.fingerprint;
	const color = peerColor(clientId);
	return self.avatarRef
		? { id: self.pubkey, name, color, avatarRef: self.avatarRef }
		: { id: self.pubkey, name, color };
}

function readString(o: Record<string, unknown>, key: string): string | null {
	const v = o[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** Extract a valid `PresencePeer` from one client's awareness state, or null. */
export function peerFromState(state: unknown): PresencePeer | null {
	if (!state || typeof state !== "object") return null;
	const payload = (state as Record<string, unknown>)[PRESENCE_STATE_KEY];
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	const id = readString(p, "id");
	const name = readString(p, "name");
	const color = readString(p, "color");
	if (!id || !name || !color) return null;
	const avatarRef = readString(p, "avatarRef");
	return avatarRef ? { id, name, color, avatarRef } : { id, name, color };
}

/**
 * Map live awareness states → `PresencePeer[]`, EXCLUDING the local client
 * (a who's-here stack shows *others*). Order follows the states map's
 * iteration order; `capPresence` de-dupes by `id` and caps downstream.
 */
export function awarenessToPeers(
	states: ReadonlyMap<number, unknown>,
	selfClientId: number,
): PresencePeer[] {
	const peers: PresencePeer[] = [];
	for (const [clientId, state] of states) {
		if (clientId === selfClientId) continue;
		const peer = peerFromState(state);
		if (peer) peers.push(peer);
	}
	return peers;
}
