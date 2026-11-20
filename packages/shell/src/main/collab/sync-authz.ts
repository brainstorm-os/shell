/**
 * The three authorization decisions the always-on live-sync engine asks of a
 * shared entity's access record, in one place so they are wired identically in
 * production (`main/index.ts`) and driven directly by the in-process tests:
 *
 *   - `isShared`             — does this entity sync at all?
 *   - `authorizeWriter`      — may this authenticated sender's update be applied?
 *   - `authorizeWrapInstall` — may this sender install (rotate) the entity DEK?
 *
 * For a shared CHILD (a channel's message), the writer and the wrap-install
 * decisions additionally apply the container rule (`admittedByContainers`).
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

import * as Y from "yjs";
import { base64ToBytes } from "../credentials/crypto";
import { ED25519_PUBLIC_BYTES } from "../credentials/identity";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { base64UrlToBytes } from "../pairing/pairing-channel";
import type { VaultSession } from "../vault/session";
import {
	type AccessTrust,
	hasAccessEntries,
	isAuthorizedWriter,
	isSharedRecord,
	keyBytesEqual,
} from "./access-record";
import type { AccessTrustStore } from "./access-trust";
import {
	type ContainerRuleDeps,
	admittedByContainers,
	governingContainers,
	parentNamedBy,
} from "./container-rule";
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
	/** This device's stored properties for an entity, or null. */
	propertiesOf: (entityId: string) => Record<string, unknown> | null;
	/** Told when the bootstrap gate refuses a first-share frame. Defaults to a
	 *  console warning naming the entity and the verdict. */
	onBootstrapRefused?: (entityId: string, verdict: ShareBootstrapVerdict) => void;
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
	const containerRule: ContainerRuleDeps = {
		session,
		accessTrust,
		rowOf: (entityId) => {
			const type = deps.typeOf(entityId);
			return type === null ? null : { type, properties: deps.propertiesOf(entityId) ?? {} };
		},
	};
	/** The container rule for one inbound update, AFTER the sender has passed on
	 *  the child's own record: they must stand in every container that governs
	 *  it, and - if the update moves the child - in the destination as well.
	 *  Applies the update to `doc`, which is this call's throwaway copy. */
	const admittedAsChild = async (
		doc: Y.Doc,
		entityId: string,
		trust: AccessTrust,
		senderKey: Uint8Array,
		plaintext: Uint8Array,
	): Promise<boolean> => {
		const governing = await governingContainers(containerRule, doc, entityId, trust);
		if (!(await admittedByContainers(containerRule, governing, senderKey))) return false;
		const type = deps.typeOf(entityId) ?? undefined;
		const before = parentNamedBy(type, doc);
		if (plaintext.byteLength > 0) Y.applyUpdate(doc, plaintext);
		const after = parentNamedBy(type, doc);
		if (after === before || (after !== undefined && governing.includes(after))) return true;
		// A re-parent. Dropping the parent altogether orphans the child out of
		// its channel's view while its members still hold it: refused. Naming a
		// new one needs standing there, as this device resolves that container.
		if (after === undefined) return false;
		return admittedByContainers(containerRule, [after], senderKey);
	};
	const onBootstrapRefused =
		deps.onBootstrapRefused ??
		((entityId, verdict) => {
			console.warn(`[collab] share bootstrap refused for ${entityId}: ${verdict}`);
		});
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
					const trust = accessTrust.trustFor(doc, entityId);
					if (isAuthorizedWriter(doc, entityId, senderKey, trust)) {
						return await admittedAsChild(doc, entityId, trust, senderKey, plaintext);
					}
					// A record is here but establishes no root (an entity from before
					// 0.16 whose record someone had deleted from): nobody resolves, so
					// nobody may write - EXCEPT that the true owner's statements, when
					// they come back, must be able to land. Judge the update on what
					// the record would be WITH it, by evidence only an inviter of ours
					// could have produced.
					if (trust.root === null && hasAccessEntries(doc)) {
						Y.applyUpdate(doc, plaintext);
						const root = accessTrust.recoverRoot(doc, entityId);
						if (root === null) return false;
						const recovered: AccessTrust = { root };
						if (!isAuthorizedWriter(doc, entityId, senderKey, recovered)) return false;
						return await admittedAsChild(doc, entityId, recovered, senderKey, new Uint8Array());
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
						onBootstrapRefused(entityId, verdict);
						return false;
					}
					// The gate checked the GRANTER against the container; the frame's
					// sender has to stand in it too. (The gate pinned the container.)
					return await admittedByContainers(
						containerRule,
						accessTrust.containersOf(doc, entityId, { root: null }),
						senderKey,
					);
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
					const trust = accessTrust.trustFor(doc, entityId);
					const allowed = authorizesWrapInstall({
						entityId,
						senderKey,
						selfPub: session.identity.publicKey,
						holdsDek,
						localDoc: doc,
						trust,
						decodeMemberKey: base64ToBytes,
					});
					if (!allowed || keyBytesEqual(senderKey, session.identity.publicKey)) return allowed;
					// A child's key is rotated only by someone who still stands in its
					// container: its author stays its Owner for ever, and must not be
					// able to re-key it after being removed from the channel.
					return await admittedByContainers(
						containerRule,
						await governingContainers(containerRule, doc, entityId, trust),
						senderKey,
					);
				} finally {
					doc.destroy();
				}
			} catch {
				return false;
			}
		},
	};
}
