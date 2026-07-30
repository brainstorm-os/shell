/**
 * Collab-C5-invite-anchor — the anchor primitive and its single-use policy.
 *
 * The gate's own end-to-end behaviour lives in `share-bootstrap-authz.test.ts`
 * (the legitimate path) and `share-bootstrap-attack.test.ts` (the forgeries).
 * This file pins the arithmetic underneath: what the MAC binds, what a
 * redemption does to the store, and every refusal reason in turn.
 */

import { describe, expect, it } from "vitest";
import {
	INVITE_SECRET_BYTES,
	InviteRedemption,
	MAX_ANCHOR_LENGTH,
	type ShareInviteRecord,
	type ShareInviteStoreLike,
	computeInviteAnchor,
	inviteIdForSecret,
	mintInviteSecret,
	parseInviteAnchor,
	redeemInviteAnchor,
} from "./invite-anchor";

const ENTITY = "ent_brief";
const OTHER_ENTITY = "ent_other";
const MEMBER = "bWVtYmVyLWtleQ==";
const OWNER = "b3duZXIta2V5";
const OTHER_OWNER = "b3RoZXItb3duZXI=";
const NOW = 1_700_000_000_000;

/** An in-memory `share_invites` stand-in with the same contract as the repo. */
class FakeStore implements ShareInviteStoreLike {
	readonly rows = new Map<string, ShareInviteRecord>();

	static withInvite(over: Partial<ShareInviteRecord> = {}): {
		store: FakeStore;
		secret: Uint8Array;
		inviteId: string;
	} {
		const secret = mintInviteSecret();
		const inviteId = inviteIdForSecret(secret);
		const store = new FakeStore();
		store.rows.set(inviteId, {
			inviteId,
			secretB64: Buffer.from(secret).toString("base64"),
			memberPubB64: MEMBER,
			createdAt: NOW,
			expiresAt: NOW + 1000,
			redeemedAt: null,
			redeemedEntityId: null,
			redeemedBy: null,
			revokedAt: null,
			...over,
		});
		return { store, secret, inviteId };
	}

	get(inviteId: string): ShareInviteRecord | null {
		return this.rows.get(inviteId) ?? null;
	}

	pin(inviteId: string, entityId: string, ownerPubB64: string, now: number): void {
		const row = this.rows.get(inviteId);
		if (!row || row.redeemedEntityId !== null) return;
		this.rows.set(inviteId, {
			...row,
			redeemedAt: now,
			redeemedEntityId: entityId,
			redeemedBy: ownerPubB64,
		});
	}
}

function anchorFor(
	secret: Uint8Array,
	inviteId: string,
	over: { entityId?: string; memberPubB64?: string; ownerPubB64?: string } = {},
): string {
	const anchor = computeInviteAnchor({
		secret,
		inviteId,
		entityId: over.entityId ?? ENTITY,
		memberPubB64: over.memberPubB64 ?? MEMBER,
		ownerPubB64: over.ownerPubB64 ?? OWNER,
	});
	if (anchor === null) throw new Error("expected an anchor");
	return anchor;
}

describe("invite-anchor — derivation and parsing", () => {
	it("derives a stable, secret-committing invite id", () => {
		const secret = mintInviteSecret();
		expect(secret).toHaveLength(INVITE_SECRET_BYTES);
		expect(inviteIdForSecret(secret)).toBe(inviteIdForSecret(secret));
		expect(inviteIdForSecret(secret)).not.toBe(inviteIdForSecret(mintInviteSecret()));
	});

	it("refuses to mint an anchor from an out-of-bounds input", () => {
		const secret = mintInviteSecret();
		const inviteId = inviteIdForSecret(secret);
		expect(
			computeInviteAnchor({
				secret: new Uint8Array(8),
				inviteId,
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
			}),
		).toBeNull();
		expect(
			computeInviteAnchor({
				secret,
				inviteId,
				entityId: "",
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
			}),
		).toBeNull();
		expect(
			computeInviteAnchor({
				secret,
				inviteId,
				entityId: "e".repeat(1000),
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
			}),
		).toBeNull();
		expect(
			computeInviteAnchor({
				secret,
				inviteId: "not/base64url",
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
			}),
		).toBeNull();
	});

	it("parses only a well-formed anchor and bounds what it will read", () => {
		const secret = mintInviteSecret();
		const inviteId = inviteIdForSecret(secret);
		const anchor = anchorFor(secret, inviteId);
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
		const secret = mintInviteSecret();
		const inviteId = inviteIdForSecret(secret);
		const base = anchorFor(secret, inviteId);
		expect(anchorFor(secret, inviteId, { entityId: OTHER_ENTITY })).not.toBe(base);
		expect(anchorFor(secret, inviteId, { memberPubB64: "b3RoZXI=" })).not.toBe(base);
		expect(anchorFor(secret, inviteId, { ownerPubB64: OTHER_OWNER })).not.toBe(base);
	});
});

describe("invite-anchor — redemption", () => {
	it("accepts a valid anchor and pins the invite to that entity + granter", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		const verdict = redeemInviteAnchor(store, {
			anchor: anchorFor(secret, inviteId),
			entityId: ENTITY,
			memberPubB64: MEMBER,
			ownerPubB64: OWNER,
			now: NOW,
		});
		expect(verdict).toBe(InviteRedemption.Ok);
		const row = store.get(inviteId);
		expect(row?.redeemedEntityId).toBe(ENTITY);
		expect(row?.redeemedBy).toBe(OWNER);
		expect(row?.redeemedAt).toBe(NOW);
	});

	it("is idempotent for the SAME entity + granter, so a re-sent frame still applies", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		const anchor = anchorFor(secret, inviteId);
		const args = { anchor, entityId: ENTITY, memberPubB64: MEMBER, ownerPubB64: OWNER, now: NOW };
		expect(redeemInviteAnchor(store, args)).toBe(InviteRedemption.Ok);
		expect(redeemInviteAnchor(store, args)).toBe(InviteRedemption.Ok);
		// Even long past expiry: the invite already did its job for this pair.
		expect(redeemInviteAnchor(store, { ...args, now: NOW + 10_000_000 })).toBe(InviteRedemption.Ok);
	});

	it("REPLAY: a spent invite cannot be re-pointed at a second entity", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, inviteId),
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.Ok);
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, inviteId, { entityId: OTHER_ENTITY }),
				entityId: OTHER_ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.AlreadyRedeemed);
	});

	it("REPLAY: a spent invite cannot be redeemed by a second granter", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		redeemInviteAnchor(store, {
			anchor: anchorFor(secret, inviteId),
			entityId: ENTITY,
			memberPubB64: MEMBER,
			ownerPubB64: OWNER,
			now: NOW,
		});
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, inviteId, { ownerPubB64: OTHER_OWNER }),
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OTHER_OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.AlreadyRedeemed);
	});

	it("EXPIRED: an unredeemed invite past its window is refused and stays unspent", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, inviteId),
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW + 5000,
			}),
		).toBe(InviteRedemption.Expired);
		expect(store.get(inviteId)?.redeemedEntityId).toBeNull();
	});

	it("REVOKED: a withdrawn invite is refused even with a perfect anchor", () => {
		const { store, secret, inviteId } = FakeStore.withInvite({ revokedAt: NOW });
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, inviteId),
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.Revoked);
	});

	it("WRONG ENTITY / WRONG MEMBER / WRONG GRANTER all fail the MAC", () => {
		const { store, secret, inviteId } = FakeStore.withInvite();
		const anchor = anchorFor(secret, inviteId);
		expect(
			redeemInviteAnchor(store, {
				anchor,
				entityId: OTHER_ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.Mismatch);
		expect(
			redeemInviteAnchor(store, {
				anchor,
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OTHER_OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.Mismatch);
		// A member key that is not the one the invite was minted for is refused
		// before the MAC is even computed.
		expect(
			redeemInviteAnchor(store, {
				anchor,
				entityId: ENTITY,
				memberPubB64: "c29tZW9uZS1lbHNl",
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.WrongMember);
		expect(store.get(inviteId)?.redeemedEntityId, "no failed attempt burns the invite").toBeNull();
	});

	it("UNKNOWN / MALFORMED refuse without touching the store", () => {
		const { store, secret } = FakeStore.withInvite();
		const strangerId = inviteIdForSecret(mintInviteSecret());
		expect(
			redeemInviteAnchor(store, {
				anchor: anchorFor(secret, strangerId),
				entityId: ENTITY,
				memberPubB64: MEMBER,
				ownerPubB64: OWNER,
				now: NOW,
			}),
		).toBe(InviteRedemption.Unknown);
		for (const anchor of [undefined, null, 7, "", "nosep", { evil: true }]) {
			expect(
				redeemInviteAnchor(store, {
					anchor,
					entityId: ENTITY,
					memberPubB64: MEMBER,
					ownerPubB64: OWNER,
					now: NOW,
				}),
			).toBe(InviteRedemption.Malformed);
		}
	});
});
