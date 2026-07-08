/**
 * ROT-2 — the rotate-on-revoke orchestrator (design [73](../../../../../docs/security/73-rotate-on-revoke.md)).
 *
 * Sequences the forward-secret rotation after a member is revoked, above the
 * pure ROT-1 survivor re-wrap. The ORDER is load-bearing and fail-closed:
 *
 *   1. **Mint DEK′ first** (persist a fresh entity DEK — the store's
 *      most-recent-by-`created_at` row becomes current; the old row stays for
 *      the grace window). Persisting before anything else means a crash
 *      mid-rotation leaves DEK′ on disk so the retry converges.
 *   2. **Re-wrap DEK′ for the survivors** (ROT-1) — never the revoked member.
 *   3. **Publish the wraps** so remaining members can install DEK′ *before* the
 *      wire flips — otherwise an online survivor would re-subscribe to the new
 *      token with no key to decrypt it.
 *   4. **Re-seal the snapshot** under DEK′ at the new routing token.
 *   5. **Drive the 10.11 coordinator LAST** — it asks the node to re-home the
 *      token and flips local emission ONLY on the node's ack. Any throw before
 *      this leaves emission on the OLD token (fail-closed); the persisted DEK′
 *      + the coordinator's `resumePending` retry the hop.
 *
 * This module owns only the sequencing + the invariant; every side-effecting
 * step is an injected port (mint, member read, wrap publish, snapshot re-seal,
 * the coordinator) so the choreography is testable in-process without the live
 * relay/pipeline. Backing the ports with the real store/coordinator/pipeline —
 * and the node-interaction specifics of step 4 vs 5 — is ROT-3 + the ROT-4
 * security/pentest gate.
 */

import type { ResolvedMember } from "./access-record";
import { type SurvivorWrap, rewrapDekForSurvivors } from "./survivor-rewrap";

export type RotateOnRevokePorts = {
	/** Mint + persist a fresh DEK for the entity (becomes the current DEK).
	 *  Returns DEK′ (the orchestrator zeroes it when done) + its id. Backed by
	 *  `EntityDekStore.persist`. */
	mintDek: (entityId: string) => { dek: Uint8Array; dekId: string };
	/** The entity's current members AFTER the revoke — `resolveCurrentMembers`,
	 *  in which the removed member is already `active: false`. */
	currentMembers: (entityId: string) => readonly ResolvedMember[];
	/** The entity's type, sealed alongside DEK′ in each wrap for the cold-restore
	 *  path (10.14). Optional; omit for a bare-DEK wrap. */
	entityType?: (entityId: string) => string | undefined;
	/** Persist + emit the survivor DEK′ wraps so remaining members install it
	 *  (append into the entity doc + `emitWrapBootstrap`). Must resolve before
	 *  the wire flips. */
	publishWraps: (entityId: string, wraps: readonly SurvivorWrap[]) => Promise<void>;
	/** Re-seal the entity's current doc state under DEK′ as the new snapshot. */
	reSealSnapshot: (entityId: string, dek: Uint8Array) => Promise<void>;
	/** The 10.11 `RoutingRotationCoordinator.rotate` — re-home the token, flip
	 *  emission on the node's ack (fail-closed). */
	rotate: (entityId: string, dek: Uint8Array) => Promise<unknown>;
	/** Active survivors with no device key (pre-collection-sharing grant) — the
	 *  caller may re-share. */
	onSkipped?: (entityId: string, members: readonly string[]) => void;
};

export type RotateOnRevokeResult = {
	/** Survivor wraps produced (one per distinct surviving device). */
	rewrapped: number;
	/** Active survivors that couldn't be re-wrapped for (no device key). */
	skipped: string[];
};

/**
 * Rotate `entityId`'s DEK after a member was revoked. The revoke (the signed
 * `revokedAt` append) is the caller's job (ROT-3 hooks `SharingEngine.revoke`);
 * this runs after it, over the post-revoke member set.
 */
export async function rotateOnRevoke(
	entityId: string,
	ports: RotateOnRevokePorts,
): Promise<RotateOnRevokeResult> {
	const { dek } = ports.mintDek(entityId); // 1. persist DEK′ before anything else
	try {
		const type = ports.entityType?.(entityId);
		const { wraps, skipped } = rewrapDekForSurvivors(
			dek,
			ports.currentMembers(entityId),
			entityId,
			type,
		); // 2. survivors only — the revoked member (inactive) is excluded by construction
		if (skipped.length > 0) ports.onSkipped?.(entityId, skipped);
		await ports.publishWraps(entityId, wraps); // 3. survivors can obtain DEK′ before the flip
		await ports.reSealSnapshot(entityId, dek); // 4. new snapshot under DEK′
		await ports.rotate(entityId, dek); // 5. re-home token + flip emission on ack (fail-closed)
		return { rewrapped: wraps.length, skipped };
	} finally {
		dek.fill(0); // zero the in-memory DEK′ copy; the store holds the sealed row
	}
}
