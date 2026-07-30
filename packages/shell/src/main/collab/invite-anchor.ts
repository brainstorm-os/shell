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
 * Redemption PINS the invite to the first `(entityId, ownerPub)` pair that
 * successfully redeems it. A later redemption of the same pair is idempotent, so
 * a re-sent or duplicated opening frame still applies; any OTHER pair is refused
 * outright. A hard burn-on-first-use was rejected deliberately: authorization
 * runs before the update is applied, so burning the invite there would leave a
 * dropped apply permanently unrecoverable — the exact deadlock class this rung
 * exists to close. Expiry gates the FIRST redemption only; once an invite has
 * done its job for an entity, retries for that entity keep working.
 *
 * Fail-closed everywhere: a missing, malformed, oversized, unknown, expired,
 * revoked or already-spent anchor refuses. Nothing here ever throws into the
 * receive path.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Bytes of entropy in an invite secret. */
export const INVITE_SECRET_BYTES = 32;

/** Bytes of the public invite handle derived from the secret. */
export const INVITE_ID_BYTES = 16;

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
const ID_DOMAIN = "brainstorm/share-invite/v2/id";
const MAC_DOMAIN = "brainstorm/share-anchor/v1";

/** Why a redemption attempt was refused. `Ok` is the only accepting value. */
export enum InviteRedemption {
	Ok = "ok",
	Malformed = "malformed",
	Unknown = "unknown-invite",
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
	/** The single entity this invite has been pinned to, once redeemed. */
	redeemedEntityId: string | null;
	/** base64 sovereign key of the granter that redeemed it. */
	redeemedBy: string | null;
	revokedAt: number | null;
};

/** The persistence surface {@link redeemInviteAnchor} needs — satisfied by
 *  `ShareInvitesRepository`, and by a map in unit tests. */
export type ShareInviteStoreLike = {
	get(inviteId: string): ShareInviteRecord | null;
	/** Pin an outstanding invite to its one entity + granter. */
	pin(inviteId: string, entityId: string, ownerPubB64: string, now: number): void;
};

/** The parts an anchor string carries. */
export type ParsedAnchor = {
	inviteId: string;
	macB64: string;
};

const BASE64URL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_MAC = /^[A-Za-z0-9+/]{1,128}={0,2}$/;

function withinBounds(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ANCHOR_FIELD_LENGTH;
}

/** Derive the public invite handle from the secret. Preimage-resistant, so
 *  publishing the id inside a grant reveals nothing about the secret. */
export function inviteIdForSecret(secret: Uint8Array): string {
	return createHash("sha256")
		.update(ID_DOMAIN, "utf8")
		.update("|")
		.update(secret)
		.digest()
		.subarray(0, INVITE_ID_BYTES)
		.toString("base64url");
}

/** Draw a fresh invite secret. */
export function mintInviteSecret(): Uint8Array {
	return new Uint8Array(randomBytes(INVITE_SECRET_BYTES));
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
	entityId: string;
	memberPubB64: string;
	ownerPubB64: string;
}): string | null {
	if (input.secret.length !== INVITE_SECRET_BYTES) return null;
	if (!BASE64URL_ID.test(input.inviteId)) return null;
	for (const field of [input.entityId, input.memberPubB64, input.ownerPubB64]) {
		if (!withinBounds(field)) return null;
	}
	const mac = createHmac("sha256", input.secret)
		.update(
			`${MAC_DOMAIN}|${input.inviteId}|${input.entityId}|${input.memberPubB64}|${input.ownerPubB64}`,
			"utf8",
		)
		.digest()
		.toString("base64");
	return `${input.inviteId}${ANCHOR_SEPARATOR}${mac}`;
}

/** Split an untrusted anchor into its parts, or null when it is not one. Both
 *  halves are charset- and length-checked before anything hashes them. */
export function parseInviteAnchor(anchor: unknown): ParsedAnchor | null {
	if (typeof anchor !== "string") return null;
	if (anchor.length === 0 || anchor.length > MAX_ANCHOR_LENGTH) return null;
	const cut = anchor.indexOf(ANCHOR_SEPARATOR);
	if (cut <= 0 || cut === anchor.length - 1) return null;
	const inviteId = anchor.slice(0, cut);
	const macB64 = anchor.slice(cut + 1);
	if (!BASE64URL_ID.test(inviteId)) return null;
	if (!BASE64_MAC.test(macB64)) return null;
	return { inviteId, macB64 };
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
 * The MAC is checked BEFORE any state changes, so a forged anchor can never burn
 * a real invite. On success the invite is pinned to `(entityId, ownerPubB64)`;
 * a repeat of that same pair returns `Ok` again (retry-safe), while any other
 * pair returns {@link InviteRedemption.AlreadyRedeemed}.
 */
export function redeemInviteAnchor(
	store: ShareInviteStoreLike,
	input: {
		anchor: unknown;
		entityId: string;
		memberPubB64: string;
		ownerPubB64: string;
		now: number;
	},
): InviteRedemption {
	const parsed = parseInviteAnchor(input.anchor);
	if (!parsed) return InviteRedemption.Malformed;
	if (!withinBounds(input.entityId)) return InviteRedemption.Malformed;
	if (!withinBounds(input.memberPubB64)) return InviteRedemption.Malformed;
	if (!withinBounds(input.ownerPubB64)) return InviteRedemption.Malformed;

	const record = store.get(parsed.inviteId);
	if (!record) return InviteRedemption.Unknown;
	if (record.revokedAt !== null) return InviteRedemption.Revoked;
	if (record.memberPubB64 !== input.memberPubB64) return InviteRedemption.WrongMember;

	let secret: Uint8Array;
	try {
		secret = new Uint8Array(Buffer.from(record.secretB64, "base64"));
	} catch {
		return InviteRedemption.Malformed;
	}
	const expected = computeInviteAnchor({
		secret,
		inviteId: parsed.inviteId,
		entityId: input.entityId,
		memberPubB64: input.memberPubB64,
		ownerPubB64: input.ownerPubB64,
	});
	secret.fill(0);
	if (expected === null) return InviteRedemption.Malformed;
	const expectedMac = parseInviteAnchor(expected);
	if (!expectedMac || !macEquals(expectedMac.macB64, parsed.macB64)) {
		return InviteRedemption.Mismatch;
	}

	// Already spent: the ONLY thing it may still authorize is the pair it was
	// spent on (a re-sent opening frame). Anything else is a replay.
	if (record.redeemedEntityId !== null || record.redeemedBy !== null) {
		const samePair =
			record.redeemedEntityId === input.entityId && record.redeemedBy === input.ownerPubB64;
		return samePair ? InviteRedemption.Ok : InviteRedemption.AlreadyRedeemed;
	}
	if (input.now > record.expiresAt) return InviteRedemption.Expired;
	store.pin(parsed.inviteId, input.entityId, input.ownerPubB64, input.now);
	return InviteRedemption.Ok;
}
