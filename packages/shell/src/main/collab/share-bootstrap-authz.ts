/**
 * Collab-C5-invite-anchor — the complete share-BOOTSTRAP gate on the receiver.
 *
 * `authorizesAsShareBootstrap` (F-288) answers only "does the incoming state
 * SIGN this sender as an active Editor+?". That is necessary and nowhere near
 * sufficient: an attacker signs their own grants, so a self-signed record passes
 * it, and a party who already co-members one entity with the victim can read the
 * victim's sovereign key and device X25519 out of that entity's access record,
 * seal a DEK for an entity id the victim has never seen, and bootstrap-authorize
 * a forged record with themselves as Owner. This module adds the missing half:
 * an anchor rooted in something THE VICTIM ALREADY HOLDS.
 *
 * A bootstrap is admitted through exactly one of two anchors, and never without
 * one:
 *
 *  1. **Invite redemption** (a direct share). The grant naming us carries the
 *     granter's echo of the single-use secret from the invite WE minted and
 *     handed over out-of-band, MAC-bound to this entity, our member key, and the
 *     granter's key (see `invite-anchor.ts`). We look the invite up in our own
 *     `share_invites` table and spend it. An attacker never saw that secret, and
 *     an anchor lifted out of a shared entity's record is bound to that entity.
 *
 *  2. **Container descent** (a collection cascade). The grant names a container
 *     id instead. We admit it only when our LOCAL state already says so: we are
 *     an active member of that container, the granter is an active Editor+ of
 *     that container, and the entity's type is the child type the containment
 *     registry declares for the container's type. That is design 71's stated
 *     trust model ("any member may add child entities that inherit the
 *     container's membership") reduced to what local state can verify — a
 *     channel co-member can introduce a Message and nothing else.
 *
 *  3. **Restore catalog** (a cold restore). The device asked the durable node,
 *     under its own sovereign key, for the entities this account previously
 *     synced, and is applying that backfill right now. The id set is the answer
 *     to a question only this identity could ask, and the window is the length of
 *     one explicit, user-initiated restore pass.
 *
 * Fail-closed at every step. An unreadable doc, an oversized or undecodable
 * state, an absent self-grant, an unknown/expired/spent/revoked invite, an
 * unknown container, or a child type that does not match its container's rule
 * all refuse. Nothing here throws into the receive path; the verdict enum is the
 * whole contract, and callers log it.
 */

import * as Y from "yjs";
import {
	AccessRole,
	MAX_BOOTSTRAP_STATE_BYTES,
	type ResolvedMember,
	isActiveMember,
	isAuthorizedWriter,
	resolveCurrentMembers,
	resolveMembers,
	roleAtLeast,
} from "./access-record";
import { containmentRuleForParent } from "./containment-registry";
import {
	type DeriveInviteSecretFn,
	InviteRedemption,
	type ShareInviteStoreLike,
	redeemInviteAnchor,
} from "./invite-anchor";

/** The outcome of the gate. `Allow` is the only accepting value; every other
 *  member names the precise reason so a refusal is diagnosable in a log line
 *  without leaking the anchor itself. */
export enum ShareBootstrapVerdict {
	Allow = "allow",
	DenyOversizedState = "deny-oversized-state",
	DenyLocalRecord = "deny-local-record",
	DenySenderNotWriter = "deny-sender-not-writer",
	DenyNoSelfGrant = "deny-no-self-grant",
	DenyNoAnchor = "deny-no-anchor",
	DenyGranterNotOwner = "deny-granter-not-owner",
	DenyInviteMalformed = "deny-invite-malformed",
	DenyInviteExpired = "deny-invite-expired",
	DenyInviteRevoked = "deny-invite-revoked",
	DenyInviteWrongMember = "deny-invite-wrong-member",
	DenyInviteMismatch = "deny-invite-mismatch",
	DenyInviteSpent = "deny-invite-spent",
	DenyContainerUnreadable = "deny-container-unreadable",
	DenyContainerNotMember = "deny-container-not-member",
	DenyContainerGranterNotMember = "deny-container-granter-not-member",
	DenyContainerNoRule = "deny-container-no-rule",
	DenyContainerChildType = "deny-container-child-type",
	DenyUnreadable = "deny-unreadable",
}

const REDEMPTION_VERDICT: Readonly<Record<InviteRedemption, ShareBootstrapVerdict>> = {
	[InviteRedemption.Ok]: ShareBootstrapVerdict.Allow,
	[InviteRedemption.Malformed]: ShareBootstrapVerdict.DenyInviteMalformed,
	[InviteRedemption.Revoked]: ShareBootstrapVerdict.DenyInviteRevoked,
	[InviteRedemption.WrongMember]: ShareBootstrapVerdict.DenyInviteWrongMember,
	[InviteRedemption.Mismatch]: ShareBootstrapVerdict.DenyInviteMismatch,
	[InviteRedemption.Expired]: ShareBootstrapVerdict.DenyInviteExpired,
	[InviteRedemption.AlreadyRedeemed]: ShareBootstrapVerdict.DenyInviteSpent,
};

export type ShareBootstrapAuthzInput = {
	/** This device's persisted doc for the entity. A non-empty access record here
	 *  is authoritative and ends the bootstrap path outright. */
	localDoc: Y.Doc;
	entityId: string;
	/** The frame's AUTHENTICATED sender key (signature already verified). */
	senderKey: Uint8Array;
	/** base64 sovereign Ed25519 key of this vault — the member the incoming
	 *  record must be granting. */
	selfPubB64: string;
	/** The decrypted Yjs update the frame carries. */
	incomingState: Uint8Array;
	now: number;
	/** This vault's outstanding invites (`share_invites`) — the replay ledger. */
	invites: ShareInviteStoreLike;
	/** Re-derive an invite's anchor secret from its nonce under this vault's
	 *  sovereign key. The trust root: it works with no local row at all. */
	deriveInviteSecret: DeriveInviteSecretFn;
	/** Stage 10.14 — is `entityId` in the catalog of a restore pass this device is
	 *  running right now? The catalog is keyed on this identity's own wire sender,
	 *  so a listed id is one this vault previously synced; a bootstrap for it is
	 *  the backfill, not an injection. Absent ⇒ never restoring. */
	isRestoring?: (entityId: string) => boolean;
	/** Load a persisted doc by entity id. The gate destroys what it loads. */
	loadDoc: (entityId: string) => Promise<Y.Doc>;
	/** The locally materialized reverse-DNS type of an entity, or null. */
	typeOf: (entityId: string) => string | null;
};

/** The current, signature-valid, active grant naming `selfPubB64`, or undefined. */
function selfGrantIn(
	probe: Y.Doc,
	entityId: string,
	selfPubB64: string,
): ResolvedMember | undefined {
	return resolveCurrentMembers(probe, entityId).find((m) => m.active && m.member === selfPubB64);
}

/** Is `granterPubB64` an active Owner in the state being offered? The person who
 *  redeemed our invite has to be an owner of the thing they are handing us. */
function granterIsOwner(probe: Y.Doc, entityId: string, granterPubB64: string): boolean {
	return resolveCurrentMembers(probe, entityId).some(
		(m) => m.active && m.member === granterPubB64 && roleAtLeast(m.role, AccessRole.Owner),
	);
}

/** Is `granterPubB64` an active Editor-or-better of the container? */
function granterMayCascade(container: Y.Doc, containerId: string, granterPubB64: string): boolean {
	return resolveCurrentMembers(container, containerId).some(
		(m) => m.active && m.member === granterPubB64 && roleAtLeast(m.role, AccessRole.Editor),
	);
}

async function authorizeContainerDescent(
	input: ShareBootstrapAuthzInput,
	containerId: string,
	granterPubB64: string,
): Promise<ShareBootstrapVerdict> {
	let container: Y.Doc;
	try {
		container = await input.loadDoc(containerId);
	} catch {
		return ShareBootstrapVerdict.DenyContainerUnreadable;
	}
	try {
		if (!isActiveMember(container, containerId, input.selfPubB64)) {
			return input.isRestoring?.(input.entityId) === true
				? ShareBootstrapVerdict.Allow
				: ShareBootstrapVerdict.DenyContainerNotMember;
		}
		if (!granterMayCascade(container, containerId, granterPubB64)) {
			return ShareBootstrapVerdict.DenyContainerGranterNotMember;
		}
		const containerType = input.typeOf(containerId);
		const rule = containerType ? containmentRuleForParent(containerType) : null;
		if (!rule) return ShareBootstrapVerdict.DenyContainerNoRule;
		if (input.typeOf(input.entityId) !== rule.childType) {
			return ShareBootstrapVerdict.DenyContainerChildType;
		}
		return ShareBootstrapVerdict.Allow;
	} catch {
		return ShareBootstrapVerdict.DenyContainerUnreadable;
	} finally {
		container.destroy();
	}
}

/**
 * May `senderKey` bootstrap `entityId` into this vault on the strength of the
 * state they are sending? Returns a verdict; only {@link ShareBootstrapVerdict.Allow}
 * authorizes the write. An accepting invite-anchor path spends the invite as a
 * side effect (idempotently, for the pair it is pinned to).
 */
export async function authorizeShareBootstrap(
	input: ShareBootstrapAuthzInput,
): Promise<ShareBootstrapVerdict> {
	// The real apply of a remote update is delegated to the ydoc WORKER; this
	// probe decodes the same attacker-supplied bytes on the main process, so it
	// gets an explicit ceiling that the worker path does not need.
	if (input.incomingState.byteLength > MAX_BOOTSTRAP_STATE_BYTES) {
		return ShareBootstrapVerdict.DenyOversizedState;
	}
	let probe: Y.Doc;
	try {
		// A doc that already resolved a record is authoritative, so no later frame
		// can re-bootstrap around a revoke.
		if (resolveMembers(input.localDoc, input.entityId).length > 0) {
			return ShareBootstrapVerdict.DenyLocalRecord;
		}
		probe = new Y.Doc();
		Y.applyUpdate(probe, input.incomingState);
	} catch {
		return ShareBootstrapVerdict.DenyUnreadable;
	}
	try {
		// Layer 1 (F-288): the offered record must make the AUTHENTICATED sender an
		// active Editor+. Necessary, not sufficient — see the module header.
		if (!isAuthorizedWriter(probe, input.entityId, input.senderKey)) {
			return ShareBootstrapVerdict.DenySenderNotWriter;
		}
		// Every legitimate bootstrap is a record that MAKES US A MEMBER. A state
		// that does not name us has no business creating an entity in our vault,
		// whatever it says about its sender.
		const selfGrant = selfGrantIn(probe, input.entityId, input.selfPubB64);
		if (!selfGrant) return ShareBootstrapVerdict.DenyNoSelfGrant;

		// Layer 2: the out-of-band anchor.
		if (selfGrant.anchor !== null) {
			// The anchor was computed by the granter under their own key, so it is
			// bound to `addedBy`, not to whoever relayed the frame.
			if (!granterIsOwner(probe, input.entityId, selfGrant.addedBy)) {
				return ShareBootstrapVerdict.DenyGranterNotOwner;
			}
			const redemption = redeemInviteAnchor(input.invites, {
				anchor: selfGrant.anchor,
				entityId: input.entityId,
				memberPubB64: input.selfPubB64,
				ownerPubB64: selfGrant.addedBy,
				now: input.now,
				deriveSecret: input.deriveInviteSecret,
			});
			return REDEMPTION_VERDICT[redemption];
		}
		if (selfGrant.via !== null) {
			return await authorizeContainerDescent(input, selfGrant.via, selfGrant.addedBy);
		}
		// Anchor 3 - an explicit, user-initiated restore of THIS account's own
		// catalog. Covers the backfill frames of a shared entity whose cascade grant
		// arrives before its container, which no local record could yet judge.
		if (input.isRestoring?.(input.entityId) === true) return ShareBootstrapVerdict.Allow;
		return ShareBootstrapVerdict.DenyNoAnchor;
	} catch {
		return ShareBootstrapVerdict.DenyUnreadable;
	} finally {
		probe.destroy();
	}
}
