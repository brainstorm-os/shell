/**
 * ROT-1 — the pure core of rotate-on-revoke (design [73](../../../../../docs/security/73-rotate-on-revoke.md)).
 *
 * On revoke, "remove access" is only cryptographically effective once the
 * entity DEK is rotated and the new DEK is re-wrapped for the members who
 * REMAIN — never for the one just removed. This module is that re-wrap,
 * factored pure: given a freshly-minted DEK′ and the entity's current members
 * (post-revoke), produce one HPKE member-wrap of DEK′ per surviving device.
 *
 * "Survivor" = a currently-**active** member. A `revokeAccess` sets the removed
 * member's row to `active: false`, so passing `resolveCurrentMembers(doc)` after
 * the revoke naturally excludes them — the removed member can NEVER end up in
 * the wrap set (property-tested). The local Owner's OTHER devices are survivors
 * too (the Owner is a member) and get DEK′ like anyone else.
 *
 * A member whose grant carried no device `x25519` key (a pre-collection-sharing
 * grant, design 71) can't be re-wrapped for — it's reported in `skipped` so the
 * caller (ROT-3) can decide to re-share rather than silently drop them.
 *
 * Pure: no DEK minting (that's the `EntityDekStore`, wired in ROT-2), no doc
 * mutation, no I/O. The caller zeroes DEK′ when done.
 */

import { base64ToBytes } from "../credentials/crypto";
import { type MemberWrapPayload, wrapDekForRecipient } from "../credentials/member-wraps";
import type { ResolvedMember } from "./access-record";

/** One survivor's re-wrap: the member's user-Ed25519 id + the DEK′ wrap sealed
 *  to their device X25519 key. */
export type SurvivorWrap = {
	/** base64 user-Ed25519 public key (the access-record member id). */
	member: string;
	wrap: MemberWrapPayload;
};

export type SurvivorRewrapResult = {
	/** One wrap per survivor that carried a device key. */
	wraps: SurvivorWrap[];
	/** Active survivors with no device `x25519` in their grant — cannot be
	 *  re-wrapped for; the caller decides (re-share). base64 member ids. */
	skipped: string[];
};

/**
 * Wrap `newDek` for every active member in `members` that carries a device
 * X25519 key. Inactive (revoked) members are excluded by the `active` filter —
 * the load-bearing guarantee for forward secrecy. De-duplicates by device key
 * (a member appearing twice, or two members sharing a device key, yields one
 * wrap per distinct recipient).
 *
 * `type` (optional) is sealed alongside the DEK for the cold-restore path
 * (10.14), matching how the original share-time wrap is produced.
 */
export function rewrapDekForSurvivors(
	newDek: Uint8Array,
	newDekVersion: number,
	members: readonly ResolvedMember[],
	entityId: string,
	type?: string,
): SurvivorRewrapResult {
	const wraps: SurvivorWrap[] = [];
	const skipped: string[] = [];
	const seenRecipients = new Set<string>();
	for (const m of members) {
		if (!m.active) continue;
		if (!m.x25519) {
			skipped.push(m.member);
			continue;
		}
		if (seenRecipients.has(m.x25519)) continue;
		let recipientPub: Uint8Array;
		try {
			recipientPub = base64ToBytes(m.x25519);
		} catch {
			skipped.push(m.member);
			continue;
		}
		seenRecipients.add(m.x25519);
		wraps.push({
			member: m.member,
			wrap: wrapDekForRecipient(newDek, recipientPub, entityId, type, newDekVersion),
		});
	}
	return { wraps, skipped };
}
