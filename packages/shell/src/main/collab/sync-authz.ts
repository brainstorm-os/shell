/**
 * The three authorization decisions the always-on live-sync engine asks of a
 * shared entity's access record, in one place so they are wired identically in
 * production (`main/index.ts`) and driven directly by the in-process tests:
 *
 *   - `isShared`             — does this entity sync at all?
 *   - `authorizeWriter`      — may this authenticated sender's update be applied?
 *   - `authorizeWrapInstall` — may this sender install (rotate) the entity DEK?
 *
 * All three read the record through the owner-rooted policy under this
 * device's pinned trust (`AccessTrustStore.trustFor`). None of them reads a raw
 * entry, and each fails closed on any error.
 *
 * WHERE THE CONTROL IS. An update from an authorized writer is a CRDT delta and
 * is applied whole - there is no rejecting the part of it that touches the
 * access array. So an Editor's update CAN carry grants, revokes and deletions
 * into the doc. What it cannot do is make them count: the policy ignores a
 * statement whose signer holds no authority, and this device's memory keeps the
 * statements a deletion removes. Resolution is the load-bearing control; the
 * writer gate here is what stops a party who is not a policy-valid member from
 * writing CONTENT at all.
 */

import { base64ToBytes } from "../credentials/crypto";
import { ED25519_PUBLIC_BYTES } from "../credentials/identity";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import type { VaultSession } from "../vault/session";
import { isAuthorizedWriter, isSharedRecord, keyBytesEqual } from "./access-record";
import type { AccessTrustStore } from "./access-trust";
import { type ShareInviteStoreLike, deriveInviteSecret } from "./invite-anchor";
import { ShareBootstrapVerdict, authorizeShareBootstrap } from "./share-bootstrap-authz";
import { authorizesWrapInstall } from "./wrap-install-authz";

export type SyncAuthzDeps = {
	session: VaultSession;
	dekStore: EntityDekStore;
	accessTrust: AccessTrustStore;
	/** This vault's outstanding invites — the bootstrap gate's replay ledger. */
	shareInvites: ShareInviteStoreLike;
	/** The locally materialized type of an entity, or null. */
	typeOf: (entityId: string) => string | null;
};

export type SyncAuthz = {
	isShared: (entityId: string) => Promise<boolean>;
	authorizeWriter: (
		senderPubB64Url: string,
		entityId: string,
		plaintext: Uint8Array,
	) => Promise<boolean>;
	authorizeWrapInstall: (entityId: string, senderPubB64Url: string) => Promise<boolean>;
};

/** The frame's sender key, or null. `Buffer.from(s, "base64url")` does NOT throw
 *  on junk - it drops invalid characters and returns a short buffer - so the
 *  length is the check, not a catch that can never fire. */
function senderKeyOf(senderPubB64Url: string): Uint8Array | null {
	const key = base64UrlToBytes(senderPubB64Url);
	return key.length === ED25519_PUBLIC_BYTES ? key : null;
}

export function createSyncAuthz(deps: SyncAuthzDeps): SyncAuthz {
	const { session, dekStore, accessTrust } = deps;
	return {
		// Shared ⇔ the record lists >1 ACTIVE member under the policy. Read off
		// the persisted doc (the worker persists synchronously before `loadDoc`
		// returns, so the record is current here).
		isShared: async (entityId) => {
			try {
				const { doc } = await session.ydocStore.load(entityId);
				try {
					return isSharedRecord(doc, entityId, accessTrust.trustFor(doc, entityId));
				} finally {
					doc.destroy();
				}
			} catch {
				return false;
			}
		},

		// Collab-C5 (F-288) — a remote update applies only if its authenticated
		// sender is an Editor+ member of the entity; a Viewer's signed edit drops
		// here, and so does one from anyone the policy does not count as a member
		// (a stranger an Editor "granted", an Editor who "promoted" herself).
		//
		// Two branches exist above the persisted-record check because a record is
		// not always LOCAL yet, and denying those cases is a deadlock rather than a
		// safe refusal:
		//   1. our OWN sovereign key - a paired device and the cold-restore
		//      backfill both re-deliver this identity's own data, and a
		//      never-shared entity has no access record at all to check;
		//   2. the share BOOTSTRAP - the first frame of a new share carries the
		//      signed record that authorizes it. Signatures alone cannot root that
		//      (an attacker signs their own grants), so `authorizeShareBootstrap`
		//      additionally demands an out-of-band anchor: the granter's echo of
		//      the single-use secret from an invite THIS vault minted, or - for a
		//      collection cascade - a container this vault is already a member of.
		authorizeWriter: async (senderPubB64Url, entityId, plaintext) => {
			const senderKey = senderKeyOf(senderPubB64Url);
			if (!senderKey) return false;
			if (keyBytesEqual(senderKey, session.identity.publicKey)) return true;
			try {
				const { doc } = await session.ydocStore.load(entityId);
				try {
					if (isAuthorizedWriter(doc, entityId, senderKey, accessTrust.trustFor(doc, entityId))) {
						return true;
					}
					const verdict = await authorizeShareBootstrap({
						localDoc: doc,
						entityId,
						senderKey,
						selfPubB64: session.identity.publicKeyBase64,
						incomingState: plaintext,
						now: Date.now(),
						invites: deps.shareInvites,
						deriveInviteSecret: (nonce, expiresAt) =>
							deriveInviteSecret((bytes) => session.signPayload(bytes), nonce, expiresAt),
						loadDoc: async (id) => (await session.ydocStore.load(id)).doc,
						typeOf: deps.typeOf,
						accessTrust,
					});
					if (verdict !== ShareBootstrapVerdict.Allow) {
						console.warn(`[collab] share bootstrap refused for ${entityId}: ${verdict}`);
					}
					return verdict === ShareBootstrapVerdict.Allow;
				} finally {
					doc.destroy();
				}
			} catch {
				return false;
			}
		},

		// Collab-C5 - see `authorizesWrapInstall`: a DEK ROTATION must come from
		// an Owner (or ourselves), or any member could re-key an entity out from
		// under its owner.
		authorizeWrapInstall: async (entityId, senderPubB64Url) => {
			const senderKey = senderKeyOf(senderPubB64Url);
			if (!senderKey) return false;
			try {
				const existing = dekStore.open(entityId);
				const holdsDek = existing !== null;
				if (existing) dekStore.close(existing.dek);
				if (!holdsDek) return true; // bootstrap: no key to substitute
				const { doc } = await session.ydocStore.load(entityId);
				try {
					return authorizesWrapInstall({
						entityId,
						senderKey,
						selfPub: session.identity.publicKey,
						holdsDek,
						localDoc: doc,
						trust: accessTrust.trustFor(doc, entityId),
						decodeMemberKey: base64ToBytes,
					});
				} finally {
					doc.destroy();
				}
			} catch {
				return false;
			}
		},
	};
}
