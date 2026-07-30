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
import {
	INVITE_DEFAULT_TTL_MS,
	INVITE_NONCE_BYTES,
	INVITE_SECRET_BYTES,
	computeInviteAnchor,
	deriveInviteSecret,
	inviteIdForNonce,
	mintInviteNonce,
} from "./invite-anchor";

/** Bump only on a wire-incompatible change to the invite shape or its signed
 *  payload construction. Pinned into the signed payload so a future codec can
 *  detect (and refuse) an invite minted under a different scheme.
 *
 *  - `1` — public keys + label only. **No longer accepted**: a v1 invite carries
 *    no anchor secret, so a share made from one could not be bootstrap-verified
 *    by the receiver (Collab-C5-invite-anchor). Fail-closed by construction.
 *  - `2` — adds `inviteId`, the single-use `secret` and `expiresAt`. */
export const SHARE_INVITE_VERSION = 2 as const;

/** Ceiling on the human label. It is user input that reaches a signed payload
 *  and a persisted contacts file, so it is bounded rather than trusted. */
export const MAX_INVITE_LABEL_LENGTH = 200;

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
	/** Public handle for the anchor: a 16-byte nonce, base64url. Signed, and the
	 *  invitee's `share_invites` row is keyed by it. The invitee re-derives the
	 *  secret from it under their sovereign key, so no local row is needed to
	 *  VERIFY an anchor — only to enforce single use. */
	inviteId: string;
	/** base64 of the 32-byte single-use anchor secret (Collab-C5-invite-anchor).
	 *  The owner echoes a MAC under this key inside the grant, which is the ONLY
	 *  thing that lets the invitee's shell accept a first-share bootstrap. It is a
	 *  bearer credential the human hands over deliberately; it is not vault key
	 *  material (the sovereign Ed25519 and device X25519 secrets never leave the
	 *  session) and it authorizes exactly one entity, once, before `expiresAt`. */
	secret: string;
	/** Epoch ms after which an UNREDEEMED invite stops being redeemable. */
	expiresAt: number;
	/** base64 Ed25519 signature by `userPubB64` over the canonical payload. */
	sig: string;
};

const encoder = new TextEncoder();

/** Deterministic signed bytes for an invite. Binds scheme version, the user
 *  identity, the wrapping key, the anchor handle, the expiry, and the label — so
 *  none can be altered without invalidating the signature. `inviteId` commits to
 *  the secret (it is its hash), so signing the id signs the secret too. Field
 *  separation is unambiguous because every field but `label` is base64/base64url
 *  or a decimal number (no `|` in any of those alphabets) and the free-form
 *  `label` is terminal — so no two distinct tuples collide onto the same payload
 *  bytes. Keep `label` last if this ever changes. */
function invitePayload(
	userPubB64: string,
	x25519PubB64: string,
	inviteId: string,
	expiresAt: number,
	label: string,
): Uint8Array {
	return encoder.encode(
		`brainstorm/share-invite/v${SHARE_INVITE_VERSION}|${userPubB64}|${x25519PubB64}|${inviteId}|${expiresAt}|${label}`,
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
		i.label.length <= MAX_INVITE_LABEL_LENGTH &&
		typeof i.inviteId === "string" &&
		typeof i.secret === "string" &&
		typeof i.expiresAt === "number" &&
		Number.isFinite(i.expiresAt) &&
		typeof i.sig === "string"
	);
}

/** An invite whose redemption window has closed. Checked where it matters (the
 *  owner's share, and the receiver's first redemption), never in
 *  {@link verifyShareInvite} — verification is purely cryptographic so a stored
 *  contact does not evaporate the moment its original invite ages out. */
export function isShareInviteExpired(invite: ShareInvite, now: number): boolean {
	return now > invite.expiresAt;
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
	/** Epoch ms the expiry is measured from. Defaults to `Date.now()`. */
	now?: number;
	/** Redemption window. Defaults to {@link INVITE_DEFAULT_TTL_MS}. */
	ttlMs?: number;
	/** Injected anchor nonce — tests only; production draws a fresh one. */
	nonce?: Uint8Array;
}): ShareInvite {
	const userPubB64 = publicKeyToBase64(opts.userPub);
	const x25519PubB64 = bytesToBase64(opts.x25519Pub);
	const label = opts.label.slice(0, MAX_INVITE_LABEL_LENGTH);
	const nonce = opts.nonce ?? mintInviteNonce();
	if (nonce.length !== INVITE_NONCE_BYTES) {
		throw new Error(`share-invite: nonce must be ${INVITE_NONCE_BYTES} bytes`);
	}
	const inviteId = inviteIdForNonce(nonce);
	// Derived, never drawn: the invitee must be able to re-derive this secret from
	// the public nonce after a vault wipe, and on any paired device.
	const secret = deriveInviteSecret(opts.sign, nonce);
	if (secret.length !== INVITE_SECRET_BYTES) {
		throw new Error(`share-invite: derived secret must be ${INVITE_SECRET_BYTES} bytes`);
	}
	const expiresAt = (opts.now ?? Date.now()) + (opts.ttlMs ?? INVITE_DEFAULT_TTL_MS);
	const sig = opts.sign(invitePayload(userPubB64, x25519PubB64, inviteId, expiresAt, label));
	return {
		v: SHARE_INVITE_VERSION,
		userPubB64,
		x25519PubB64,
		label,
		inviteId,
		secret: bytesToBase64(secret),
		expiresAt,
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
	now?: number;
	ttlMs?: number;
	nonce?: Uint8Array;
}): ShareInvite {
	return createShareInviteSigned({
		userPub: publicKeyFromSecret(opts.userSecret),
		x25519Pub: opts.x25519Pub,
		label: opts.label,
		sign: (payload) => signPayload(opts.userSecret, payload),
		...(opts.now === undefined ? {} : { now: opts.now }),
		...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
		...(opts.nonce === undefined ? {} : { nonce: opts.nonce }),
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
		// The secret is derived from the signed nonce under the invitee's sovereign
		// key, so the OWNER cannot check the two against each other (they hold
		// neither key). What the signature does guarantee is that the nonce, the
		// expiry, both public keys and the label are the invitee's own. A tampered
		// `secret` therefore only lets a token-holder make their OWN share
		// unredeemable, which they could equally achieve by not sharing.
		if (base64ToBytes(invite.secret).length !== INVITE_SECRET_BYTES) return false;
		return verifySignature(
			base64ToBytes(invite.userPubB64),
			invitePayload(
				invite.userPubB64,
				invite.x25519PubB64,
				invite.inviteId,
				invite.expiresAt,
				invite.label,
			),
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
		/** ROT-3a-i — the DEK's rotation ordinal (from the open handle). Stamped
		 *  into the wrap so the invitee's install path can order it against a
		 *  later rotation. Omitted ⇒ a v1 (ordinal-1) wrap. */
		dekVersion?: number;
		/** Collab-C5-invite-anchor — the container this entity descends from, when
		 *  the share is a COLLECTION cascade rather than a direct one. A child's
		 *  grant carries the container id instead of an invite anchor: the receiver
		 *  is already a member of that container locally, so the container IS the
		 *  anchor and the invite stays pinned to the container alone. */
		via?: string;
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
	const via = opts.via ?? null;
	// A DIRECT share must echo the invite's anchor, so refuse an invite whose
	// redemption window has closed rather than mint a grant the receiver will
	// (correctly) refuse. A CASCADE child carries no anchor, so it is unaffected —
	// the container it descends from was anchored when it was shared.
	if (via === null && isShareInviteExpired(opts.invite, opts.now)) {
		throw new Error("shareEntityWithInvite: invite has expired");
	}
	const recipientPub = base64ToBytes(opts.invite.x25519PubB64);
	const ownerPubB64 = publicKeyToBase64(publicKeyFromSecret(opts.signerSecret));
	let anchor: string | null = null;
	if (via === null) {
		const secret = base64ToBytes(opts.invite.secret);
		try {
			anchor = computeInviteAnchor({
				secret,
				inviteId: opts.invite.inviteId,
				entityId: opts.entityId,
				memberPubB64: opts.invite.userPubB64,
				ownerPubB64,
			});
		} finally {
			secret.fill(0);
		}
		if (anchor === null) {
			throw new Error("shareEntityWithInvite: could not compute the invite anchor");
		}
	}

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
		// Collab-C5-invite-anchor — the bootstrap trust root travels with the
		// grant and is covered by its signature, so it cannot be re-pointed at
		// another entity/member without invalidating the grant AND the MAC.
		anchor,
		via,
	});

	if (existingWrap !== null) return existingWrap;
	const wrap = wrapDekForRecipient(
		opts.dek,
		recipientPub,
		opts.entityId,
		opts.type,
		opts.dekVersion,
	);
	appendWrap(doc, wrap);
	return wrap;
}
