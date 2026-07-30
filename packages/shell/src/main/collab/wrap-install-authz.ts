/**
 * Collab-C5 - who may install a per-entity DEK wrap on this device?
 *
 * A `WrapBootstrap` frame is HPKE-sealed to this device's X25519 key, which
 * used to be treated as authorization on its own ("only we can open it, so
 * installing it is safe"). That holds for a FIRST install - the worst it can do
 * is materialize an entity we did not have - but not for a ROTATION.
 * `installEntityDek` accepts any strictly-newer DEK ordinal (ROT-3a-i), and the
 * two things an attacker needs to mint one are both public to an entity's
 * members: the inbox channel is `inbox:<sovereign pubkey>` and each member's
 * X25519 wrapping key is published in the signed access record. So without a
 * check, any member - a Viewer included - can seal a DEK of their own choosing
 * at a bumped ordinal and re-key an entity out from under its owner. The victim
 * then fails to decrypt real traffic AND emits under a key the attacker holds.
 *
 * Rotation is an Owner operation (design 73 - `SharingEngine.revoke` mints DEK′
 * and re-wraps for survivors), so the rule is:
 *
 *   - the sender is THIS identity        ⇒ allow (paired device / cold restore);
 *   - this device holds no DEK yet       ⇒ allow (bootstrap: nothing to substitute,
 *                                          and a cold device has no record to read);
 *   - otherwise                          ⇒ the sender must be an ACTIVE OWNER in
 *                                          the entity's local signed access record.
 *
 * Fail-closed: an unreadable record, a malformed key, or a sender who resolves
 * to anything less than Owner denies the install and leaves the current DEK in
 * place (which is the safe state - the device keeps reading what it could read).
 */

import type * as Y from "yjs";
import { AccessRole, keyBytesEqual, resolveCurrentMembers, roleAtLeast } from "./access-record";

export type WrapInstallAuthzInput = {
	entityId: string;
	/** The frame's AUTHENTICATED sender key (signature already verified). */
	senderKey: Uint8Array;
	/** This vault's sovereign Ed25519 public key. */
	selfPub: Uint8Array;
	/** Does this device already hold a DEK for the entity? `false` ⇒ bootstrap. */
	holdsDek: boolean;
	/** The entity's local Y.Doc, for its signed access record. */
	localDoc: Y.Doc;
	/** Decode a base64 member key to bytes; a throw is treated as "not a match". */
	decodeMemberKey: (base64: string) => Uint8Array;
};

/** May `senderKey` install a DEK wrap for `entityId` on this device? */
export function authorizesWrapInstall(input: WrapInstallAuthzInput): boolean {
	if (keyBytesEqual(input.senderKey, input.selfPub)) return true;
	if (!input.holdsDek) return true;
	for (const member of resolveCurrentMembers(input.localDoc, input.entityId)) {
		if (!member.active) continue;
		if (!roleAtLeast(member.role, AccessRole.Owner)) continue;
		let memberKey: Uint8Array;
		try {
			memberKey = input.decodeMemberKey(member.member);
		} catch {
			continue;
		}
		if (keyBytesEqual(memberKey, input.senderKey)) return true;
	}
	return false;
}
