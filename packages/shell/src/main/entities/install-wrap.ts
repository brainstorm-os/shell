/**
 * Stage 10.14 — install an unwrapped per-entity DEK into the vault.
 *
 * Shared by every path that recovers a DEK from an inbound `WrapBootstrap`
 * frame: the dev collab bridge (`collab-dev-bridge.ts`), the always-on
 * `LiveSyncEngine` wiring (`index.ts`), and the restore engine
 * (`sync/restore-engine.ts`). Each previously open-coded the same seal +
 * persist + stamp body; this is the single source of truth.
 *
 * The caller has already HPKE-unwrapped the wrap with the device X25519
 * secret (that secret never leaves the `VaultSession`) and owns zeroing the
 * passed `dek` afterwards — this helper copies the bytes through
 * `EntityDekStore.persistWithDek` and zeroes its own copy.
 *
 * **Ordering**: the parent `entities` row MUST already exist — `entity_deks`
 * carries an `ON DELETE CASCADE` FK to `entities(id)`. Live sharing creates
 * the row up front (`installShareReceiver`); the restore path materializes it
 * from the wrap's recovered `type` before calling this.
 *
 * **Monotonic (ROT-3a-i)**: `version` is the DEK's rotation ordinal, recovered
 * from the (AAD-authenticated) wrap. Install accepts a STRICTLY-NEWER ordinal
 * and no-ops on an equal-or-older one. This does two jobs at once: a re-delivered
 * SAME wrap is idempotent (equal ordinal ⇒ no-op), and a ROTATED DEK actually
 * upgrades the survivor (higher ordinal ⇒ new current row) — the old
 * "any DEK already exists ⇒ no-op" guard silently dropped rotations (F-ROT-1)
 * and, combined with receive-time ordering, allowed rollback (F-ROT-3).
 */

import type { EntitiesRepository } from "../storage/entities-repo";
import type { EntityDekStore } from "./entity-dek-store";

/**
 * Persist `dek` as `entityId`'s DEK at rotation ordinal `version` (sealed under
 * the vault master key) and stamp `entities.dek_id`. No-op when the entity
 * already holds a DEK whose ordinal is ≥ `version` (idempotent re-delivery /
 * rejected rollback). The caller retains ownership of `dek` and must zero it.
 *
 * Returns `true` when the DEK was installed (or upgraded), `false` on a no-op —
 * so a caller can tell a real rotation from a replay.
 */
export function installEntityDek(
	entityId: string,
	dek: Uint8Array,
	version: number,
	dekStore: EntityDekStore,
	repo: EntitiesRepository,
): boolean {
	const existing = dekStore.open(entityId);
	if (existing) {
		const current = existing.version;
		dekStore.close(existing.dek);
		if (version <= current) return false; // idempotent re-delivery / anti-rollback
	}
	const dekId = dekStore.nextDekId();
	const handle = dekStore.persistWithDek(entityId, dekId, dek, version);
	dekStore.close(handle.dek);
	repo.stampDekId(entityId, dekId);
	return true;
}
