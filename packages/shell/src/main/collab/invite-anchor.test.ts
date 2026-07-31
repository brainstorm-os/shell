/**
 * Collab-C5-invite-anchor — the anchor primitive and its single-use policy.
 *
 * The gate's own end-to-end behaviour lives in `share-bootstrap-authz.test.ts`
 * (the legitimate path) and `share-bootstrap-attack.test.ts` (the forgeries).
 * This file pins the arithmetic underneath: what the secret is derived from,
 * what the MAC binds, what a redemption does to the ledger, and every refusal
 * reason in turn.
 */

import { describe, expect, it } from "vitest";
import { generateIdentity, signPayload } from "../credentials/identity";
import {
	INVITE_NONCE_BYTES,
	INVITE_SECRET_BYTES,
	InviteRedemption,
	MAX_ANCHOR_LENGTH,
	type PinShareInviteInput,
	type ShareInviteRecord,
	type ShareInviteStoreLike,
	computeInviteAnchor,
	deriveInviteSecret,
	inviteIdForNonce,
	mintInviteNonce,
	nonceForInviteId,
	parseInviteAnchor,
	redeemInviteAnchor,
} from "./invite-anchor";

const ENTITY = "ent_brief";
const OTHER_ENTITY = "ent_other";
const OWNER = "b3duZXIta2V5";
const OTHER_OWNER = "b3RoZXItb3duZXI=";
const NOW = 1_700_000_000_000;

/** A vault identity that can derive its own invite secrets. */
function invitee() {
	const identity = generateIdentity();
	const memberPubB64 = Buffer.from(identity.publicKey).toString("base64");
	const sign = (payload: Uint8Array) => signPayload(identity.secretKey, payload);
	return {
		memberPubB64,
		sign,
		deriveSecret: (nonce: Uint8Array) => deriveInviteSecret(sign, nonce),
	};
}

/** An in-memory `share_invites` stand-in with the same contract as the repo. */
class FakeStore implements ShareInviteStoreLike {
	readonly rows = new Map<string, ShareInviteRecord>();

	seed(inviteId: string, memberPubB64: string, over: Partial<ShareInviteRecord> = {}): void {
		this.rows.set(inviteId, {
			inviteId,
			secretB64: "",
			memberPubB64,
			createdAt: NOW,
			expiresAt: NOW + 1000,
			redeemedAt: null,
			redeemedEntityId: null,
			redeemedBy: null,
			revokedAt: null,
			...over,
		});
	}

	get(inviteId: string): ShareInviteRecord | null {
		return this.rows.get(inviteId) ?? null;
	}

	pin(input: PinShareInviteInput): void {
		const row = this.rows.get(input.inviteId);
		if (row?.redeemedEntityId != null) return;
		this.rows.set(input.inviteId, {
			inviteId: input.inviteId,
			secretB64: input.secretB64,
			memberPubB64: input.memberPubB64,
			createdAt: row?.createdAt ?? input.now,
			expiresAt: row?.expiresAt ?? input.now,
			redeemedAt: input.now,
			redeemedEntityId: input.entityId,
			redeemedBy: input.ownerPubB64,
			revokedAt: row?.revokedAt ?? null,
		});
	}
}

describe("invite-anchor — derivation and parsing", () => {
	it("derives the secret from the nonce under the invitee's own sovereign key", () => {
		const alice = invitee();
		const bob = invitee();
		const nonce = mintInviteNonce();
		expect(nonce).toHaveLength(INVITE_NONCE_BYTES);

		const secret = alice.deriveSecret(nonce);
		expect(secret).toHaveLength(INVITE_SECRET_BYTES);
		// Deterministic: this is what lets a WIPED vault (and a paired sibling)
		// re-derive the same secret from the public nonce with no stored row.
		expect([...alice.deriveSecret(nonce)]).toEqual([...secret]);
		// Nobody else can reach it, and a different nonce is a different secret.
		expect([...bob.deriveSecret(nonce)]).not.toEqual([...secret]);
		expect([...alice.deriveSecret(mintInviteNonce())]).not.toEqual([...secret]);
	});

	it("round-trips the nonce through its public handle, and bounds what it accepts", () => {
		const nonce = mintInviteNonce();
		const inviteId = inviteIdForNonce(nonce);
		expect([...(nonceForInviteId(inviteId) ?? [])]).toEqual([...nonce]);
		for (const junk of ["", "not/base64url", "a".repeat(65), inviteIdForNonce(new Uint8Array(8))]) {
			expect(nonceForInviteId(junk), junk).toBeNull();
		}
	});

	it("refuses to mint an anchor from an out-of-bounds input", () => {
		const alice = invitee();
		const nonce = mintInviteNonce();
		const inviteId = inviteIdForNonce(nonce);
		const secret = alice.deriveSecret(nonce);
		const base = { secret, inviteId, entityId: ENTITY, memberPubB64: alice.memberPubB64 };
		expect(
			computeInviteAnchor({ ...base, secret: new Uint8Array(8), ownerPubB64: OWNER }),
		).toBeNull();
		expect(computeInviteAnchor({ ...base, entityId: "", ownerPubB64: OWNER })).toBeNull();
		expect(
			computeInviteAnchor({ ...base, entityId: "e".repeat(1000), ownerPubB64: OWNER }),
		).toBeNull();
		expect(
			computeInviteAnchor({ ...base, inviteId: "not/base64url", ownerPubB64: OWNER }),
		).toBeNull();
	});

	it("parses only a well-formed anchor and bounds what it will read", () => {
		const alice = invitee();
		const nonce = mintInviteNonce();
		const inviteId = inviteIdForNonce(nonce);
		const anchor = anchorFor(alice, nonce, {});
		expect(parseInviteAnchor(anchor)?.inviteId).toBe(inviteId);
		for (const junk of [
			null,
			42,
			"",
			":",
			"nosep",
			"id:",
			":mac",
			`${inviteId}:${"z".repeat(MAX_ANCHOR_LENGTH)}`,
			"id with spaces:bWFj",
			`${inviteId}:not base64 %%%`,
		]) {
			expect(parseInviteAnchor(junk), String(junk)).toBeNull();
		}
	});

	it("binds the MAC to the entity, the member and the granter", () => {
		const alice = invitee();
		const nonce = mintInviteNonce();
		const base = anchorFor(alice, nonce, {});
		expect(anchorFor(alice, nonce, { entityId: OTHER_ENTITY })).not.toBe(base);
		expect(anchorFor(alice, nonce, { memberPubB64: "b3RoZXI=" })).not.toBe(base);
		expect(anchorFor(alice, nonce, { ownerPubB64: OTHER_OWNER })).not.toBe(base);
	});
});

function anchorFor(
	who: ReturnType<typeof invitee>,
	nonce: Uint8Array,
	over: { entityId?: string; memberPubB64?: string; ownerPubB64?: string },
): string {
	const anchor = computeInviteAnchor({
		secret: who.deriveSecret(nonce),
		inviteId: inviteIdForNonce(nonce),
		entityId: over.entityId ?? ENTITY,
		memberPubB64: over.memberPubB64 ?? who.memberPubB64,
		ownerPubB64: over.ownerPubB64 ?? OWNER,
	});
	if (anchor === null) throw new Error("expected an anchor");
	return anchor;
}

describe("invite-anchor — redemption", () => {
	function setup(over: Partial<ShareInviteRecord> | null = {}) {
		const alice = invitee();
		const nonce = mintInviteNonce();
		const inviteId = inviteIdForNonce(nonce);
		const store = new FakeStore();
		if (over !== null) store.seed(inviteId, alice.memberPubB64, over);
		const args = (o: { entityId?: string; ownerPubB64?: string; now?: number } = {}) => ({
			anchor: anchorFor(alice, nonce, {
				...(o.entityId === undefined ? {} : { entityId: o.entityId }),
				...(o.ownerPubB64 === undefined ? {} : { ownerPubB64: o.ownerPubB64 }),
			}),
			entityId: o.entityId ?? ENTITY,
			memberPubB64: alice.memberPubB64,
			ownerPubB64: o.ownerPubB64 ?? OWNER,
			now: o.now ?? NOW,
			deriveSecret: alice.deriveSecret,
		});
		return { alice, nonce, inviteId, store, args };
	}

	it("accepts a valid anchor and pins the invite to that entity + granter", () => {
		const { store, inviteId, args, alice } = setup();
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Ok);
		const row = store.get(inviteId);
		expect(row?.redeemedEntityId).toBe(ENTITY);
		expect(row?.redeemedBy).toBe(OWNER);
		expect(row?.redeemedAt).toBe(NOW);
		expect(row?.memberPubB64).toBe(alice.memberPubB64);
	});

	it("is idempotent for the SAME entity + granter, so a re-sent frame still applies", () => {
		const { store, args } = setup();
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Ok);
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Ok);
		// Even long past expiry: the invite already did its job for this pair.
		expect(redeemInviteAnchor(store, args({ now: NOW + 10_000_000 }))).toBe(InviteRedemption.Ok);
	});

	it("REPLAY: a spent invite cannot be re-pointed at a second entity or granter", () => {
		const { store, args } = setup();
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Ok);
		expect(redeemInviteAnchor(store, args({ entityId: OTHER_ENTITY }))).toBe(
			InviteRedemption.AlreadyRedeemed,
		);
		expect(redeemInviteAnchor(store, args({ ownerPubB64: OTHER_OWNER }))).toBe(
			InviteRedemption.AlreadyRedeemed,
		);
	});

	it("EXPIRED: an unredeemed invite past its window is refused and stays unspent", () => {
		const { store, inviteId, args } = setup();
		expect(redeemInviteAnchor(store, args({ now: NOW + 5000 }))).toBe(InviteRedemption.Expired);
		expect(store.get(inviteId)?.redeemedEntityId).toBeNull();
	});

	it("REVOKED: a withdrawn invite is refused even with a perfect anchor", () => {
		const { store, args } = setup({ revokedAt: NOW });
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Revoked);
	});

	it("WRONG MEMBER: a row minted for another identity refuses before the MAC", () => {
		const { store, inviteId, args } = setup();
		const row = store.get(inviteId);
		if (!row) throw new Error("expected a row");
		store.rows.set(inviteId, { ...row, memberPubB64: "c29tZW9uZS1lbHNl" });
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.WrongMember);
	});

	it("MISMATCH: another identity's anchor never verifies, and never burns the invite", () => {
		const { store, inviteId, nonce, alice } = setup();
		const mallory = invitee();
		expect(
			redeemInviteAnchor(store, {
				// Mallory MACs under a secret she derived herself. She cannot reach
				// Alice's, so the anchor is worthless however well-formed it looks.
				anchor: anchorFor(mallory, nonce, { memberPubB64: alice.memberPubB64 }),
				entityId: ENTITY,
				memberPubB64: alice.memberPubB64,
				ownerPubB64: OWNER,
				now: NOW,
				deriveSecret: alice.deriveSecret,
			}),
		).toBe(InviteRedemption.Mismatch);
		expect(store.get(inviteId)?.redeemedEntityId, "a failed attempt never burns it").toBeNull();
	});

	it("MALFORMED input refuses without touching the ledger", () => {
		const { store, alice } = setup();
		for (const anchor of [undefined, null, 7, "", "nosep", { evil: true }, "AAAA:bWFj"]) {
			expect(
				redeemInviteAnchor(store, {
					anchor,
					entityId: ENTITY,
					memberPubB64: alice.memberPubB64,
					ownerPubB64: OWNER,
					now: NOW,
					deriveSecret: alice.deriveSecret,
				}),
			).toBe(InviteRedemption.Malformed);
		}
	});

	it("NO ROW: a wiped vault still redeems, and the pin is re-established on the spot", () => {
		// The cold-restore shape. `share_invites` is gone with the rest of the
		// vault, but the sovereign key survives, so the secret re-derives and the
		// owner's backfill is admitted - then single use holds again from here.
		const { store, inviteId, args } = setup(null);
		expect(store.get(inviteId)).toBeNull();
		expect(redeemInviteAnchor(store, args())).toBe(InviteRedemption.Ok);
		expect(store.get(inviteId)?.redeemedEntityId).toBe(ENTITY);
		expect(redeemInviteAnchor(store, args({ entityId: OTHER_ENTITY }))).toBe(
			InviteRedemption.AlreadyRedeemed,
		);
	});

	it("NO ROW: a forged anchor is still refused, so the ledger is not the trust root", () => {
		const { store, nonce, alice } = setup(null);
		const mallory = invitee();
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(mallory, nonce, { memberPubB64: alice.memberPubB64 }),
				entityId: ENTITY,
				memberPubB64: alice.memberPubB64,
				ownerPubB64: OWNER,
				now: NOW,
				deriveSecret: alice.deriveSecret,
			}),
		).toBe(InviteRedemption.Mismatch);
	});
});
