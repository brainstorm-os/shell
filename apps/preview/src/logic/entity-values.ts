/**
 * `entityValuesFromSnapshot(snapshot, entityId)` — the focused file entity's
 * bound-property bag (`properties.values`), hydrated through the shared
 * `migrateValuesField` so an older row with no bag reads as `{}`. Pure, so the
 * inspector's value lookup is unit-tested without React or a live bridge.
 *
 * Returns `null` when the id isn't in the snapshot (the file is a demo /
 * intent-pushed sibling with no vault entity) — the inspector then renders its
 * read-only facts instead of editable rows.
 */

import type { VaultEntitiesSnapshot } from "@brainstorm-os/sdk-types";
import { isEntityLocked } from "@brainstorm-os/sdk/entity-lock";
import { type ValuesMap, migrateValuesField } from "@brainstorm-os/sdk/property-ui";

function liveEntity(
	snapshot: VaultEntitiesSnapshot,
	entityId: string | null,
): VaultEntitiesSnapshot["entities"][number] | null {
	if (!entityId) return null;
	return snapshot.entities.find((e) => e.id === entityId && e.deletedAt === null) ?? null;
}

export function entityValuesFromSnapshot(
	snapshot: VaultEntitiesSnapshot,
	entityId: string | null,
): ValuesMap | null {
	const entity = liveEntity(snapshot, entityId);
	if (!entity) return null;
	return migrateValuesField((entity.properties as Record<string, unknown>).values);
}

/**
 * Lock-5(b) — whether the previewed file's entity carries the fleet's read-only
 * lock (`properties.locked`).
 *
 * Preview's inspector used to decide it could write from the mere PRESENCE of
 * `entities.update` — which answers "does this shell expose the service?", not
 * "may I write this object?". A locked file was therefore fully editable in
 * Preview while every other app refused it. This is the missing half of that
 * question; the panel ANDs the two.
 */
export function entityLockedFromSnapshot(
	snapshot: VaultEntitiesSnapshot,
	entityId: string | null,
): boolean {
	return isEntityLocked(liveEntity(snapshot, entityId));
}
