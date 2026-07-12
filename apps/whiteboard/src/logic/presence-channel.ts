/**
 * Presence channel — whiteboard's binding to the shared awareness primitives.
 * Re-exports the local no-transport ones from `@brainstorm/react-yjs`, and
 * delegates the real IPC transport to the shared SDK `presenceAwarenessFor`
 * (`@brainstorm/sdk/presence-stack`, PRES-3b) — ONE implementation across the
 * fleet — bound to the whiteboard entity type.
 */

import { type LocalAwareness, createLocalAwareness, randomClientId } from "@brainstorm/react-yjs";
import { presenceAwarenessFor as presenceAwarenessForEntity } from "@brainstorm/sdk/presence-stack";
import { WHITEBOARD_TYPE } from "../storage/entities-repository";

export { type LocalAwareness, createLocalAwareness, randomClientId };

/** Awareness for the board `boardEntityId` — the real DEK-sealed transport in
 *  the shell (cursors go cross-device), a local single-device channel otherwise.
 *  The id must be the vault entity id (the main gate resolves its type to check
 *  `entities.read`). */
export function presenceAwarenessFor(boardEntityId: string): LocalAwareness {
	return presenceAwarenessForEntity(boardEntityId, WHITEBOARD_TYPE);
}
