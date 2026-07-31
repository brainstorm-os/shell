/**
 * Collab-C5-invite-anchor — the out-of-band trust anchor that roots a share
 * BOOTSTRAP in something the receiver already holds.
 *
 * ## Why signatures cannot root this
 *
 * `authorizesAsShareBootstrap` (F-288, shell #375) admits a first-share frame on
 * the strength of the signed access record the frame itself carries. Every grant
 * in that record is Ed25519-signed, and `resolveMembers` verifies each one under
 * its own `addedBy` — but `addedBy` may be the attacker. A SELF-SIGNED grant
 * verifies perfectly, so a party who already co-members a single entity with the
 * victim (and therefore reads the victim's device X25519 and sovereign key out of
 * that entity's access record, and knows their `inbox:<pubkey>` channel) can seal
 * a DEK for an entity id the victim has never seen, take the first-install
 * allowance, and then bootstrap-authorize a record in which the attacker is
 * Owner and the victim is Editor. That injects a populated, arbitrarily-typed
 * entity into the victim's vault with PERSISTENT WRITE. Signatures cannot close
 * it, because the attacker signs their own.
 *
 * ## The anchor
 *
 * The trust root has to be a secret the victim minted and only the genuinely
 * invited owner ever saw. The invitee already mints something in this flow — the
 * {@link ShareInvite} they hand the owner out-of-band — so the invite becomes
 * that secret, and the owner ECHOES a proof of possession back inside the grant:
 *
 *   - minting: the invitee draws a fresh 32-byte `secret`, derives the public
 *     handle `inviteId = SHA-256(domain‖secret)[0..16]`, and persists
 *     `(inviteId, secret, expiresAt)` in their own vault (`share_invites`) BEFORE
 *     the token leaves the process;
 *   - the token they hand out carries the secret — it IS the bearer credential,
 *     exactly like any invite link. It is not vault key material: the sovereign
 *     Ed25519 and device X25519 secrets never leave the session, and this token
 *     buys nothing but "you may bootstrap ONE entity into my vault, once, before
 *     it expires";
 *   - echoing: the owner computes
 *     `mac = HMAC-SHA256(secret, domain‖inviteId‖entityId‖memberPub‖ownerPub)`
 *     and writes `"<inviteId>:<mac>"` into the member's grant, COVERED BY THE
 *     GRANT SIGNATURE;
 *   - redemption: the receiver looks the `inviteId` up in its own table,
 *     recomputes the MAC over the entity it is actually being asked to accept and
 *     its OWN member key, and compares in constant time.
 *
 * The MAC binds (entity, member, owner), so an anchor lifted out of a shared
 * entity's record — which every co-member can read — is worthless anywhere else:
 * re-pointing it at a second entity, a different member, or a different granter
 * changes the MAC input and nothing the attacker holds can recompute it.
 *
 * ## Single use, retries, and expiry
 *
 * Redemption PINS the invite to the FIRST GRANTER that redeems it, and to nobody
 * else. One code, one collaborator: a second party who gets hold of the token - a
 * forwarded message, a shoulder-surfed screen - is refused, because the person it
 * was meant for has already claimed it. Retries by that granter are idempotent, so
 * a re-sent or duplicated opening frame still applies.
 *
 * It does NOT pin to one entity, and that is deliberate rather than a weakening.
 * `ContactsStore` exists so a teammate you have accepted once becomes a
 * click-to-share chip, and `sharing.share({contact})` re-presents that same stored
 * invite for every later share. Pinning to one entity would therefore refuse the
 * SECOND thing you ever share with a saved teammate, on their side, silently -
 * which is the same class of break as the deadlock this rung exists to close. The
 * first entity is recorded for audit; the granter is what is enforced.
 *
 * A hard burn-on-first-use was rejected for the same reason: authorization runs
 * before the update is applied, so burning the invite there would leave a dropped
 * apply permanently unrecoverable.
 *
 * Expiry gates the FIRST claim only, and is carried IN THE ANCHOR with the secret
 * derived over it - so a holder can neither strip it nor extend it, and a device
 * with no ledger row enforces it exactly like one that has the row. An UNCLAIMED
 * code stops being a key into the vault after its window; that is the code sitting
 * unused in a chat log, and the one that actually matters. Once claimed, the invite
 * is that collaborator's standing credential and `revoke` is how you withdraw it.
 *
 * Fail-closed everywhere: a missing, malformed, oversized, unknown, expired,
 * revoked or already-spent anchor refuses. Nothing here ever throws into the
 * receive path.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder();

/** Bytes of the derived invite secret (a SHA-256 digest). */
export const INVITE_SECRET_BYTES = 32;

/** Bytes of entropy in the public invite handle. */
export const INVITE_NONCE_BYTES = 16;

/** Default lifetime of a freshly minted invite: seven days. Long enough for a
 *  human hand-off across a weekend, short enough that an unredeemed code stops
 *  being a standing key into the vault. */
export const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Ceiling on the anchor string read off an attacker-supplied grant. An honest
 *  anchor is `22 + 1 + 44` characters; anything near this bound is junk. */
export const MAX_ANCHOR_LENGTH = 256;

/** Ceiling on every other untrusted string this module hashes. Entity ids and
 *  base64 keys are far shorter; the bound keeps a hostile record from feeding an
 *  unbounded buffer to the MAC. */
export const MAX_ANCHOR_FIELD_LENGTH = 512;

const ANCHOR_SEPARATOR = ":";
const ANCHOR_FIELD_SEPARATOR = ".";
const NONCE_DOMAIN = "brainstorm/share-invite/v2/nonce";
const SECRET_DOMAIN = "brainstorm/share-invite/v2/secret";
const MAC_DOMAIN = "brainstorm/share-anchor/v1";

/** Why a redemption attempt was refused. `Ok` is the only accepting value. */
export enum InviteRedemption {
	Ok = "ok",
	Malformed = "malformed",
	Revoked = "invite-revoked",
	WrongMember = "wrong-member",
	Mismatch = "anchor-mismatch",
	Expired = "invite-expired",
	AlreadyRedeemed = "already-redeemed",
}

/** One outstanding or spent invite, as the invitee's vault stores it. */
export type ShareInviteRecord = {
	inviteId: string;
	/** base64 of the 32-byte secret. Never leaves the main process except inside
	 *  the invite token the user deliberately hands to a collaborator. */
	secretB64: string;
	/** base64 sovereign Ed25519 key this invite was minted for (ours). */
	memberPubB64: string;
	createdAt: number;
	expiresAt: number;
	redeemedAt: number | null;
	/** The FIRST entity this invite opened. Audit only - the granter is what is
	 *  enforced, so a saved contact can share a second thing. */
	redeemedEntityId: string | null;
	/** base64 sovereign key of the granter that CLAIMED it. Enforced: nobody else
	 *  may ever redeem this invite. */
	redeemedBy: string | null;
	revokedAt: number | null;
};

/** Claiming an invite for the one granter it authorizes. Creates the row when this
 *  device has no record of the invite — see {@link redeemInviteAnchor} on why a
 *  missing row is "unclaimed", not "unknown". */
export type PinShareInviteInput = {
	inviteId: string;
	secretB64: string;
	memberPubB64: string;
	entityId: string;
	ownerPubB64: string;
	/** The MAC-bound expiry from the anchor, recorded so a later `listOutstanding`
	 *  and `purgeExpired` agree with what the anchor itself says. */
	expiresAt: number;
	now: number;
};

/** The persistence surface {@link redeemInviteAnchor} needs — satisfied by
 *  `ShareInvitesRepository`, and by a map in unit tests. */
export type ShareInviteStoreLike = {
	get(inviteId: string): ShareInviteRecord | null;
	pin(input: PinShareInviteInput): void;
};

/** Re-derive the anchor secret for a nonce under this vault's sovereign key. */
export type DeriveInviteSecretFn = (nonce: Uint8Array, expiresAt: number) => Uint8Array;

/** The parts an anchor string carries. */
export type ParsedAnchor = {
	inviteId: string;
	/** Epoch ms after which an UNCLAIMED invite stops being redeemable. Carried in
	 *  the anchor and bound into the SECRET, so a holder cannot strip or extend it
	 *  and a device with no ledger row can still enforce it. */
	expiresAt: number;
	macB64: string;
};

const BASE64URL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_MAC = /^[A-Za-z0-9+/]{1,128}={0,2}$/;
const DECIMAL = /^[0-9]{1,15}$/;

/** A MAC input field must be non-empty, bounded, and free of the `|` separator.
 *  `entityId` and `ownerPubB64` are the only variable-length fields in the MAC
 *  string; with a pipe allowed in either, two distinct tuples could in principle
 *  serialise to the same bytes. Neither can legitimately contain one. */
function withinBounds(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ANCHOR_FIELD_LENGTH && !value.includes("|");
}

/** Draw a fresh invite nonce — the invite's PUBLIC handle. */
export function mintInviteNonce(): Uint8Array {
	return new Uint8Array(randomBytes(INVITE_NONCE_BYTES));
}

/** The public handle an anchor names: the nonce, base64url. */
export function inviteIdForNonce(nonce: Uint8Array): string {
	return Buffer.from(nonce).toString("base64url");
}

/**
 * The nonce an anchor's handle names, or null when it is not one.
 *
 * The encoding must be CANONICAL. `Buffer.from(s, "base64url")` is lenient: a
 * 16-byte nonce is 22 base64url characters, whose last character carries 4
 * surplus bits that decoding simply drops - so SIXTEEN distinct strings decode to
 * the same nonce. The secret is derived from the NONCE but the replay ledger is
 * keyed on the STRING, so without this round-trip a holder of a claimed invite
 * could re-spell its handle, land on a fresh unclaimed row, and redeem again -
 * past a revoke and past expiry. A pentest broke the first cut of this exactly
 * that way. Re-encoding and demanding equality collapses every spelling onto one
 * key.
 */
export function nonceForInviteId(inviteId: string): Uint8Array | null {
	if (!BASE64URL_ID.test(inviteId)) return null;
	const bytes = new Uint8Array(Buffer.from(inviteId, "base64url"));
	if (bytes.length !== INVITE_NONCE_BYTES) return null;
	return inviteIdForNonce(bytes) === inviteId ? bytes : null;
}

/**
 * Derive an invite's anchor secret from the nonce and the invitee's OWN sovereign
 * key: `SHA-256(domain‖Ed25519_sign(sk, domain‖nonce))`.
 *
 * Deriving rather than drawing at random is what makes the anchor survive a vault
 * WIPE. Ed25519 is deterministic (RFC 8032), so any device holding this identity
 * re-derives the same secret from the public nonce, forever — a cold restore has
 * no `share_invites` table left, yet must still admit the owner's backfill of an
 * entity it was legitimately shared. It also lets a PAIRED device redeem an invite
 * its sibling minted, which a per-device random secret could not.
 *
 * `sign` is `VaultSession.signPayload`: the sovereign secret never leaves the
 * session, and nothing derived here crosses IPC except inside the invite token
 * the user deliberately hands over.
 */
export function deriveInviteSecret(
	sign: (payload: Uint8Array) => Uint8Array,
	nonce: Uint8Array,
	expiresAt: number,
): Uint8Array {
	// `expiresAt` is inside the SIGNED message, so it is part of the secret's
	// identity: change it and you derive a different secret and the MAC stops
	// verifying. That is what makes expiry enforceable on a device that holds no
	// ledger row at all - a cold restore, a paired sibling - rather than a
	// property a token holder can strip by redeeming somewhere the row is missing.
	const prefix = encoder.encode(`${NONCE_DOMAIN}|`);
	const suffix = encoder.encode(`|${expiresAt}`);
	const bound = new Uint8Array(prefix.length + nonce.length + suffix.length);
	bound.set(prefix, 0);
	bound.set(nonce, prefix.length);
	bound.set(suffix, prefix.length + nonce.length);
	const signature = sign(bound);
	return new Uint8Array(
		createHash("sha256").update(SECRET_DOMAIN, "utf8").update("|").update(signature).digest(),
	);
}

/**
 * The owner-side echo: a MAC over the exact `(entity, member, owner)` triple the
 * grant authorizes, keyed by the invitee's secret. Returns the grant-field form
 * `"<inviteId>:<mac>"`, or `null` when any input is out of bounds (fail-closed —
 * a share that cannot mint an anchor emits none, and the receiver refuses).
 */
export function computeInviteAnchor(input: {
	secret: Uint8Array;
	inviteId: string;
	expiresAt: number;
	entityId: string;
	memberPubB64: string;
	ownerPubB64: string;
}): string | null {
	if (input.secret.length !== INVITE_SECRET_BYTES) return null;
	if (!BASE64URL_ID.test(input.inviteId)) return null;
	if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) return null;
	for (const field of [input.entityId, input.memberPubB64, input.ownerPubB64]) {
		if (!withinBounds(field)) return null;
	}
	const mac = createHmac("sha256", input.secret)
		.update(
			`${MAC_DOMAIN}|${input.inviteId}|${input.expiresAt}|${input.entityId}|${input.memberPubB64}|${input.ownerPubB64}`,
			"utf8",
		)
		.digest()
		.toString("base64");
	return `${input.inviteId}${ANCHOR_FIELD_SEPARATOR}${input.expiresAt}${ANCHOR_SEPARATOR}${mac}`;
}

/** Split an untrusted anchor into its parts, or null when it is not one. Both
 *  halves are charset- and length-checked before anything hashes them. */
export function parseInviteAnchor(anchor: unknown): ParsedAnchor | null {
	if (typeof anchor !== "string") return null;
	if (anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH) return null;
	const cut = anchor.indexOf(ANCHOR_SEPARATOR);
	if (cut <= 0 || cut === anchor.length - 1) return null;
	const macB64 = anchor.slice(cut + 1);
	const head = anchor.slice(0, cut);
	const dot = head.indexOf(ANCHOR_FIELD_SEPARATOR);
	if (dot <= 0 || dot === head.length - 1) return null;
	const inviteId = head.slice(0, dot);
	const expiresRaw = head.slice(dot + 1);
	if (!BASE64URL_ID.test(inviteId)) return null;
	if (!DECIMAL.test(expiresRaw)) return null;
	const expiresAt = Number(expiresRaw);
	// Round-trip the number too: a leading zero or an unsafe magnitude would give
	// two spellings of one expiry, and everything here is keyed on exact strings.
	if (!Number.isSafeInteger(expiresAt) || String(expiresAt) !== expiresRaw) return null;
	if (!BASE64_MAC.test(macB64)) return null;
	return { inviteId, expiresAt, macB64 };
}

/** Constant-time comparison of two base64 MACs. A length difference answers
 *  immediately (`timingSafeEqual` requires equal lengths and would throw). */
function macEquals(a: string, b: string): boolean {
	const left = Buffer.from(a, "base64");
	const right = Buffer.from(b, "base64");
	if (left.length === 0 || left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Verify an anchor carried by a grant and, if it holds, spend the invite.
 *
 * Verification is PURELY cryptographic: the secret is re-derived from the anchor's
 * nonce under this vault's own sovereign key, so a forgery fails whatever the
 * local table says, and a legitimate anchor still verifies on a device that has
 * no record of the invite (a cold restore, or a paired sibling). The table is a
 * REPLAY LEDGER, not the trust root — which is why a missing row reads as
 * "unspent" and is created on the spot rather than refused. Expiry is enforced
 * only where a row exists; a wiped vault trades that one property for being
 * restorable at all, and every other property still holds.
 *
 * The MAC is checked BEFORE any state changes, so a forged anchor can never burn
 * a real invite. On success the invite is claimed by `ownerPubB64`; that granter
 * may redeem it again for this or any other entity they share with us, while any
 * other granter returns {@link InviteRedemption.AlreadyRedeemed}.
 */
export function redeemInviteAnchor(
	store: ShareInviteStoreLike,
	input: {
		anchor: unknown;
		entityId: string;
		memberPubB64: string;
		ownerPubB64: string;
		now: number;
		deriveSecret: DeriveInviteSecretFn;
	},
): InviteRedemption {
	const parsed = parseInviteAnchor(input.anchor);
	if (!parsed) return InviteRedemption.Malformed;
	if (!withinBounds(input.entityId)) return InviteRedemption.Malformed;
	if (!withinBounds(input.memberPubB64)) return InviteRedemption.Malformed;
	if (!withinBounds(input.ownerPubB64)) return InviteRedemption.Malformed;
	const nonce = nonceForInviteId(parsed.inviteId);
	if (!nonce) return InviteRedemption.Malformed;

	const record = store.get(parsed.inviteId);
	if (record?.revokedAt != null) return InviteRedemption.Revoked;
	if (record && record.memberPubB64 !== input.memberPubB64) return InviteRedemption.WrongMember;

	let secret: Uint8Array;
	try {
		secret = input.deriveSecret(nonce, parsed.expiresAt);
	} catch {
		return InviteRedemption.Malformed;
	}
	try {
		const expected = computeInviteAnchor({
			secret,
			inviteId: parsed.inviteId,
			expiresAt: parsed.expiresAt,
			entityId: input.entityId,
			memberPubB64: input.memberPubB64,
			ownerPubB64: input.ownerPubB64,
		});
		if (expected === null) return InviteRedemption.Malformed;
		const expectedMac = parseInviteAnchor(expected);
		if (!expectedMac || !macEquals(expectedMac.macB64, parsed.macB64)) {
			return InviteRedemption.Mismatch;
		}

		// Already claimed: only the granter who claimed it may still redeem, for any
		// entity they share with us (see the header on why the entity is recorded
		// but not enforced). Anyone else is a replay.
		if (record?.redeemedBy != null) {
			return record.redeemedBy === input.ownerPubB64
				? InviteRedemption.Ok
				: InviteRedemption.AlreadyRedeemed;
		}
		// Expiry gates the FIRST claim, and is read off the ANCHOR, not the ledger:
		// the secret is derived over it, so a holder cannot strip or extend it, and a
		// device with no row (cold restore, paired sibling) enforces it identically.
		if (input.now > parsed.expiresAt) return InviteRedemption.Expired;
		if (record && input.now > record.expiresAt) return InviteRedemption.Expired;
		store.pin({
			inviteId: parsed.inviteId,
			secretB64: Buffer.from(secret).toString("base64"),
			memberPubB64: input.memberPubB64,
			entityId: input.entityId,
			ownerPubB64: input.ownerPubB64,
			expiresAt: parsed.expiresAt,
			now: input.now,
		});
		return InviteRedemption.Ok;
	} finally {
		secret.fill(0);
	}
}
