/**
 * Presence channel — whiteboard's binding to the shared awareness primitives.
 * The primitives live in `@brainstorm/react-yjs` (`createLocalAwareness` /
 * `createSyncedAwareness` / `createPresenceTransport`, PRES-1/2b, design
 * [74](../../../../docs/data/74-presence-transport.md)); this re-exports the
 * local ones + builds the real transport (PRES-3).
 *
 * `presenceAwarenessFor(boardEntityId)` returns awareness bound to the live
 * `presence` IPC transport when running in the shell — so cursors/selection go
 * cross-device — and a local no-transport channel otherwise (standalone /
 * preview: single-device, unchanged). Nothing downstream (publisher, peer
 * derivation, overlay paint) changes; the engine re-binds it per open board.
 */

import {
	type LocalAwareness,
	type PresenceHost,
	createLocalAwareness,
	createPresenceTransport,
	createSyncedAwareness,
	randomClientId,
} from "@brainstorm/react-yjs";
import { WHITEBOARD_TYPE } from "../storage/entities-repository";
import { getBrainstorm } from "../storage/runtime";

export { type LocalAwareness, createLocalAwareness, randomClientId };

/**
 * Awareness for the board `boardEntityId`. In the shell (both the `presence`
 * service AND the peer push are present) it rides the real DEK-sealed transport;
 * otherwise it's a local single-device channel. The board id must be the vault
 * entity id — the main-side gate resolves its type to check `entities.read`.
 */
export function presenceAwarenessFor(boardEntityId: string): LocalAwareness {
	const bs = getBrainstorm();
	const publish = bs?.services?.presence;
	const push = bs?.presence;
	if (!publish || !push) return createLocalAwareness();
	const host: PresenceHost = {
		publish: (state) => {
			void publish.publish({ entityId: boardEntityId, type: WHITEBOARD_TYPE, state });
		},
		untrack: () => {
			void publish.untrack({ entityId: boardEntityId });
		},
		onPeers: (handler) => push.onPeers(boardEntityId, handler),
	};
	return createSyncedAwareness(createPresenceTransport(host));
}
