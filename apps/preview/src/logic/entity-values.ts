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
import { type ValuesMap, migrateValuesField } from "@brainstorm-os/sdk/property-ui";

export function entityValuesFromSnapshot(
	snapshot: VaultEntitiesSnapshot,
	entityId: string | null,
): ValuesMap | null {
	if (!entityId) return null;
	const entity = snapshot.entities.find((e) => e.id === entityId && e.deletedAt === null);
	if (!entity) return null;
	return migrateValuesField((entity.properties as Record<string, unknown>).values);
}
