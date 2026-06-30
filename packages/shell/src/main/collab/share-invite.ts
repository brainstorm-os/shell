/**
 * Share / invite flow — the owner-side share orchestration (Collab C2).
 *
 * C1 (`access-record.ts`) gave us the signed membership log inside the
 * entity Y.Doc. C2 is the *flow that adds a member*: an owner shares an
 * entity with a different person, which means three things have to happen
 * atomically against that entity's doc —
 *
 *   1. **authorize** — append a signed `grant` to the access log (C1), and
 *   2. **deliver the key** — HPKE-wrap the entity DEK for the collaborator
 *      so they can actually decrypt the doc, then
 *   3. **emit** the wrap over the relay so it reaches them out-of-band of
 *      the (still-encrypted) doc sync.
 *
 * **The user → wrapping-key gap.** A member-wrap (`member-wraps.ts`) is
 * sealed to a recipient *X25519* public key; the access log names a *user
 * Ed25519* key. For multi-DEVICE sync those are bridged by the owner's own
 * add-device log. For multi-USER sharing the collaborator is a different
 * person whose devices are NOT in the owner's device log — so the owner has
 * no way to learn their X25519 wrapping key on its own. C2 closes that gap
 * with a **`ShareInvite`**: a tiny self-signed bundle the collaborator hands
 * the owner out-of-band, carrying their user Ed25519 key *and* an X25519
 * wrapping key, with an Ed25519 signature that **binds the wrapping key to
 * the identity**. The owner verifies that binding before sealing a DEK to
 * the X25519 key — so an attacker can't slip their own wrapping key under a
 * victim's user identity and intercept the DEK. (Same shape as the
 * add-device record: an X25519 key signed by the sovereign Ed25519 key.)
 *
 * **Layering.** `shareEntityWithInvite` is a pure function over the doc: it
 * takes the already-opened DEK and the owner's signing secret, never touches
 * `EntityDekStore` or the relay, and returns the wrap for the caller to emit
 * via `emitWrapBootstrap`. The session-aware caller owns opening + zeroing
 * the DEK and pushing the wrap through the relay — exactly the split the
 * pipeline's `receiveWrapBootstrap` documents (the X25519 secret never
 * leaves the session). The recipient side reuses existing primitives:
 * `unwrapDekForRecipient` to recover the DEK, then — once the doc syncs and
 * is decryptable — `isActiveMember` / `roleOf` (C1) to confirm a real grant
 * backs the wrap before keeping it. The two-`VaultSession` E2E is C3.
 */

import type * as Y from "yjs";
import { base64ToBytes, bytesToBase64 } from "../credentials/crypto";
import {
	publicKeyFromSecret,
	publicKeyToBase64,
	signPayload,
	verifySignature,
} from "../credentials/identity";
import {
	type MemberWrapPayload,
	appendWrap,
	findWrapForRecipient,
	wrapDekForRecipient,
} from "../credentials/member-wraps";
import { type AccessRole, grantAccess, roleOf } from "./access-record";

/** Bump only on a wire-incompatible change to the invite shape or its signed
 *  payload construction. Pinned into the signed payload so a future codec can
 *  detect (and refuse) an invite minted under a different scheme. */
export const SHARE_INVITE_VERSION = 1 as const;

/**
 * A collaborator's self-signed invitation to be added to an entity. Produced
 * by the *invitee* (they own both secrets) and handed to the owner
 * out-of-band. The owner needs no prior knowledge of the invitee — the
 * signature proves the X25519 wrapping key belongs to the named user key.
 */
export type ShareInvite = {
	v: typeof SHARE_INVITE_VERSION;
	/** base64 user-Ed25519 public key — the invitee's stable identity; this
	 *  is what the access-log grant names. */
	userPubB64: string;
	/** base64 X25519 public key — the HPKE recipient key the owner seals the
	 *  entity DEK to. Bound to `userPubB64` by `sig`. */
	x25519PubB64: string;
	/** Human label for the invite (person / device name). Included in the
	 *  signed payload so it can't be swapped after signing. */
	label: string;
	/** base64 Ed25519 signature by `userPubB64` over the canonical payload. */
	sig: string;
};

const encoder = new TextEncoder();

/** Deterministic signed bytes for an invite. Binds scheme version, the user
 *  identity, the wrapping key, and the label — so none can be altered without
 *  invalidating the signature. Field separation is unambiguous because the two
 *  key fields are base64 of fixed 32-byte keys (the standard alphabet has no
 *  `|`) and the free-form `label` is terminal — so no two distinct
 *  `(user, x25519, label)` tuples can collide onto the same payload bytes. Keep
 *  `label` last if this ever changes. */
function invitePayload(userPubB64: string, x25519PubB64: string, label: string): Uint8Array {
	return encoder.encode(
		`brainstorm/share-invite/v${SHARE_INVITE_VERSION}|${userPubB64}|${x25519PubB64}|${label}`,
	);
}

/** Structural type guard — shape only, no crypto. */
export function isShareInvite(value: unknown): value is ShareInvite {
	if (!value || typeof value !== "object") return false;
	const i = value as Partial<ShareInvite>;
	return (
		i.v === SHARE_INVITE_VERSION &&
		typeof i.userPubB64 === "string" &&
		typeof i.x25519PubB64 === "string" &&
		typeof i.label === "string" &&
		typeof i.sig === "string"
	);
}

/**
 * Build a self-signed `ShareInvite` from a *signing closure* rather than a raw
 * secret. This is the form a `VaultSession` uses — it can sign with the user
 * Ed25519 key (`session.signPayload`) without ever exposing the secret. `sign`
 * must produce an Ed25519 signature under the key whose public half is
 * `userPub`; the owner re-verifies that binding in {@link verifyShareInvite}.
 */
export function createShareInviteSigned(opts: {
	userPub: Uint8Array;
	x25519Pub: Uint8Array;
	label: string;
	sign: (payload: Uint8Array) => Uint8Array;
}): ShareInvite {
	const userPubB64 = publicKeyToBase64(opts.userPub);
	const x25519PubB64 = bytesToBase64(opts.x25519Pub);
	const sig = opts.sign(invitePayload(userPubB64, x25519PubB64, opts.label));
	return {
		v: SHARE_INVITE_VERSION,
		userPubB64,
		x25519PubB64,
		label: opts.label,
		sig: bytesToBase64(sig),
	};
}

/**
 * Build a self-signed `ShareInvite` from the invitee's user-Ed25519 secret and
 * the X25519 wrapping key they want DEKs sealed to (typically their device
 * X25519 public key). Convenience over {@link createShareInviteSigned} for
 * callers that hold the raw secret (tests, CLI). The owner later verifies this
 * with {@link verifyShareInvite}.
 */
export function createShareInvite(opts: {
	userSecret: Uint8Array;
	x25519Pub: Uint8Array;
	label: string;
}): ShareInvite {
	return createShareInviteSigned({
		userPub: publicKeyFromSecret(opts.userSecret),
		x25519Pub: opts.x25519Pub,
		label: opts.label,
		sign: (payload) => signPayload(opts.userSecret, payload),
	});
}

/**
 * Verify an invite: structural shape + the Ed25519 signature binding the
 * X25519 wrapping key to the user identity. Returns false (never throws) on a
 * malformed invite, a bad signature, or undecodable base64 — the owner refuses
 * to seal a DEK to an unverifiable key.
 */
export function verifyShareInvite(invite: unknown): invite is ShareInvite {
	if (!isShareInvite(invite)) return false;
	try {
		return verifySignature(
			base64ToBytes(invite.userPubB64),
			invitePayload(invite.userPubB64, invite.x25519PubB64, invite.label),
			base64ToBytes(invite.sig),
		);
	} catch {
		return false;
	}
}

/**
 * Owner-side share: authorize + key-deliver in one pass over the entity doc.
 *
 *   1. verify the invite (throws `Error` if it doesn't validate — a refusal,
 *      not a silent skip),
 *   2. append a signed access grant for the invitee's user key at `role`
 *      (C1 `grantAccess`, idempotent on an existing live grant),
 *   3. HPKE-wrap `dek` for the invite's X25519 key, bound to `entityId`, and
 *      append it to the doc's wraps array.
 *
 * Returns the `MemberWrapPayload` so the caller can emit it through the relay
 * via `emitWrapBootstrap`. Idempotent at the *same* role: if the invitee
 * already holds a live grant *and* a wrap for their key exists on the doc, the
 * existing wrap is returned and nothing is appended (re-sharing is a no-op, not
 * a duplicate). Re-sharing an active member at a *different* role throws —
 * grants are append-only, so a role change is `revokeAccess` then re-share, and
 * a silent no-op would otherwise hide the failed upgrade. Throws on an empty
 * `entityId` or an unverifiable invite before mutating the doc.
 *
 * Pure over the doc — it does not open the DEK from the store, emit over the
 * relay, or retain `dek`. The caller opens + zeroes the DEK and owns the emit.
 */
export function shareEntityWithInvite(
	doc: Y.Doc,
	opts: {
		entityId: string;
		invite: ShareInvite;
		role: AccessRole;
		dek: Uint8Array;
		signerSecret: Uint8Array;
		now: number;
		/** Stage 10.14 — the entity's reverse-DNS type, sealed into the wrap so a
		 *  cold device can materialize the row on restore. Optional for back-compat. */
		type?: string;
	},
): MemberWrapPayload {
	// Validate everything that can fail BEFORE any mutation, so a rejected
	// share never leaves a half-written grant on the doc (the wrap step also
	// rejects an empty entityId — asserting it up front keeps grant + wrap
	// atomic-or-nothing).
	if (opts.entityId === "") {
		throw new Error("shareEntityWithInvite: entityId must be non-empty");
	}
	if (!verifyShareInvite(opts.invite)) {
		throw new Error("shareEntityWithInvite: invite failed verification");
	}
	const recipientPub = base64ToBytes(opts.invite.x25519PubB64);

	// Grants are append-only and `grantAccess` no-ops on a live grant, so a
	// re-share at a *different* role would silently fail to change anything.
	// Surface that instead: a role change is revoke-then-re-share, not re-share.
	const currentRole = roleOf(doc, opts.entityId, opts.invite.userPubB64);
	if (currentRole !== null && currentRole !== opts.role) {
		throw new Error(
			`shareEntityWithInvite: ${opts.invite.userPubB64} is already a member at role "${currentRole}"; change a role via revokeAccess then re-share`,
		);
	}
	const existingWrap = findWrapForRecipient(doc, recipientPub);
	if (currentRole !== null && existingWrap !== null) return existingWrap;

	grantAccess(doc, {
		entityId: opts.entityId,
		member: opts.invite.userPubB64,
		role: opts.role,
		signerSecret: opts.signerSecret,
		now: opts.now,
		// Record the invitee's verified X25519 wrapping key INSIDE the signed
		// grant (collection-sharing, design 71): a later child cascade reads it
		// from the access record to wrap the child DEK to this member, with the
		// key authenticated by the same signature that authorizes the member.
		x25519: opts.invite.x25519PubB64,
	});

	if (existingWrap !== null) return existingWrap;
	const wrap = wrapDekForRecipient(opts.dek, recipientPub, opts.entityId, opts.type);
	appendWrap(doc, wrap);
	return wrap;
}
