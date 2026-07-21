/**
 * Route an `open` to another vault object through the shared intents service —
 * the only sanctioned cross-app navigation path (a linked company / person
 * opens in whichever app owns its type). `verb` is centralised here rather
 * than typed as a bare literal at the call site.
 */

import type { IntentsService } from "@brainstorm-os/sdk-types";
import { PERSON_TYPE, type VaultEntityLike } from "../types/person";

const OPEN_VERB = "open" as const;

export function openEntityRef(
	intents: IntentsService | null | undefined,
	entityId: string,
	entityType: string,
): void {
	if (!intents) return;
	void intents.dispatch({ verb: OPEN_VERB, payload: { entityId, entityType } });
}

/** How a running Contacts window should handle an inbound `open` for
 *  `entityId` (the F-242 running-window twin of the launch target). A Person
 *  selects directly; a Company — or a target not yet in the snapshot, which
 *  Contacts only owns as a Company — lands on its people view. */
export type OpenTargetAction = { kind: "select" | "company"; id: string };

export function resolveOpenTarget(
	entityId: string,
	entities: readonly VaultEntityLike[],
): OpenTargetAction {
	const target = entities.find((e) => e.id === entityId);
	if (target?.type === PERSON_TYPE) return { kind: "select", id: entityId };
	return { kind: "company", id: entityId };
}
