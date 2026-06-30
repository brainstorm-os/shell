/**
 * Access-record tests (Collab C1) — the signed, append-only membership log.
 * Covers authenticity (grant/revoke signatures), lifecycle (active → revoked
 * with audit retained), entity-binding, tamper/forgery rejection, and CRDT
 * merge of concurrent grants into a shared (owner-bootstrapped) log.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import {
	AccessRole,
	activeMembers,
	getAccessArray,
	grantAccess,
	isActiveMember,
	resolveCurrentMembers,
	resolveMembers,
	revokeAccess,
	roleOf,
} from "./access-record";

const ENT = "ent_share_1";

/** Asserts a non-empty member list and returns its first entry — the fixtures
 *  below grant before reading, so this stands in for a non-null assertion. */
function firstMember<T>(xs: readonly T[]): T {
	const [head] = xs;
	if (head === undefined) throw new Error("expected at least one member");
	return head;
}

function person() {
	const kp = generateIdentity();
	return { secret: kp.secretKey, pub: publicKeyToBase64(kp.publicKey) };
}

describe("access-record (Collab C1)", () => {
	it("grants and resolves an active member", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});

		const members = resolveMembers(doc, ENT);
		expect(members).toHaveLength(1);
		const m = firstMember(members);
		expect(m.member).toBe(marcus.pub);
		expect(m.role).toBe(AccessRole.Editor);
		expect(m.addedBy).toBe(owner.pub);
		expect(m.grantValid).toBe(true);
		expect(m.active).toBe(true);
		expect(isActiveMember(doc, ENT, marcus.pub)).toBe(true);
		expect(roleOf(doc, ENT, marcus.pub)).toBe(AccessRole.Editor);
	});

	it("is idempotent on a repeat grant for a live member", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 2000,
		});
		expect(activeMembers(doc, ENT)).toHaveLength(1);
		expect(roleOf(doc, ENT, marcus.pub)).toBe(AccessRole.Editor); // first grant stands
	});

	it("revokes a member but keeps the audit entry", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});
		const revoked = revokeAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			signerSecret: owner.secret,
			now: 5000,
		});
		expect(revoked).toBe(true);

		const all = resolveMembers(doc, ENT);
		expect(all).toHaveLength(1); // history retained
		const m = firstMember(all);
		expect(m.revokedAt).toBe(5000);
		expect(m.revokedBy).toBe(owner.pub);
		expect(m.revokeValid).toBe(true);
		expect(m.active).toBe(false);
		expect(activeMembers(doc, ENT)).toHaveLength(0);
		expect(isActiveMember(doc, ENT, marcus.pub)).toBe(false);
		expect(roleOf(doc, ENT, marcus.pub)).toBeNull();
	});

	it("re-grant after revoke makes the member active again", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 1000,
		});
		revokeAccess(doc, { entityId: ENT, member: marcus.pub, signerSecret: owner.secret, now: 2000 });
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 3000,
		});
		expect(resolveMembers(doc, ENT)).toHaveLength(2); // both the revoked + the new
		expect(activeMembers(doc, ENT)).toHaveLength(1);
		expect(roleOf(doc, ENT, marcus.pub)).toBe(AccessRole.Editor);
		// The CURRENT-members view collapses to one row per member (F-287): the
		// live re-grant, not the stale revoked row a raw find(member) would hit.
		const current = resolveCurrentMembers(doc, ENT);
		expect(current).toHaveLength(1);
		expect(firstMember(current).member).toBe(marcus.pub);
		expect(firstMember(current).active).toBe(true);
		expect(firstMember(current).role).toBe(AccessRole.Editor);
	});

	it("rejects a tampered role (grant signature no longer verifies)", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 1000,
		});
		// Attacker bumps the stored role to Owner without re-signing.
		getAccessArray(doc).get(0).set("role", AccessRole.Owner);
		const m = firstMember(resolveMembers(doc, ENT));
		expect(m.role).toBe(AccessRole.Owner); // the stored (tampered) value...
		expect(m.grantValid).toBe(false); // ...but the signature exposes it
		expect(m.active).toBe(false);
		expect(roleOf(doc, ENT, marcus.pub)).toBeNull();
	});

	it("binds a grant to its entity (can't be replayed into another doc)", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});
		// Same bytes, resolved as if they belonged to a different entity.
		const m = firstMember(resolveMembers(doc, "ent_other"));
		expect(m.grantValid).toBe(false);
		expect(m.active).toBe(false);
	});

	it("ignores a forged revoke (bad revoke signature → member stays active)", () => {
		const doc = new Y.Doc();
		const owner = person();
		const attacker = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});
		// Forge a revoke: set the fields but with a signature that doesn't verify.
		const entry = getAccessArray(doc).get(0);
		entry.set("revokedAt", 9000);
		entry.set("revokedBy", attacker.pub);
		entry.set("revokeSig", "AAAA"); // garbage
		const m = firstMember(resolveMembers(doc, ENT));
		expect(m.revokeValid).toBe(false);
		expect(m.active).toBe(true); // grant still stands; forged revoke ignored
		expect(isActiveMember(doc, ENT, marcus.pub)).toBe(true);
	});

	it("merges concurrent grants into an owner-bootstrapped log (CRDT)", () => {
		// Owner doc bootstraps the access array + the owner's own grant, then
		// both replicas receive it before each appends a concurrent grant.
		const ownerDoc = new Y.Doc();
		const owner = person();
		const a = person();
		const b = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: owner.pub,
			role: AccessRole.Owner,
			signerSecret: owner.secret,
			now: 100,
		});

		const docA = new Y.Doc();
		const docB = new Y.Doc();
		const base = Y.encodeStateAsUpdate(ownerDoc);
		Y.applyUpdate(docA, base);
		Y.applyUpdate(docB, base);

		// Concurrent grants on two replicas (both append into the shared array).
		grantAccess(docA, {
			entityId: ENT,
			member: a.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 200,
		});
		grantAccess(docB, {
			entityId: ENT,
			member: b.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 300,
		});

		// Exchange updates both ways.
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		for (const doc of [docA, docB]) {
			const active = activeMembers(doc, ENT)
				.map((m) => m.member)
				.sort();
			expect(active).toEqual([owner.pub, a.pub, b.pub].sort());
		}
	});
});

describe("access-record — signed X25519 wrapping key (collection-sharing, design 71)", () => {
	it("carries a member's X25519 through resolve, covered by the grant signature", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		const marcusX25519 = "bWFyY3VzLXgyNTUxOS1wdWJrZXktYjY0LXBsYWNlaG9sZGVy";
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1,
			x25519: marcusX25519,
		});
		const member = firstMember(resolveCurrentMembers(doc, ENT));
		expect(member.member).toBe(marcus.pub);
		expect(member.x25519).toBe(marcusX25519);
		expect(member.grantValid).toBe(true);
		expect(member.active).toBe(true);
	});

	it("rejects a tampered X25519 (the key is in the signed payload)", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1,
			x25519: "b3JpZ2luYWwteDI1NTE5LWtleS1iNjQtdmFsdWUtaGVyZQ",
		});
		// Swap the stored X25519 for an attacker's — the grant signature no longer
		// matches the reconstructed payload, so the member resolves invalid.
		getAccessArray(doc).get(0).set("x25519", "YXR0YWNrZXItc3Vic3RpdHV0ZWQteDI1NTE5LWtleS1oZXJl");
		const member = firstMember(resolveMembers(doc, ENT));
		expect(member.grantValid).toBe(false);
		expect(member.active).toBe(false);
	});

	it("a key-less grant resolves x25519=null and stays valid (back-compat)", () => {
		const doc = new Y.Doc();
		const owner = person();
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 1,
		});
		const member = firstMember(resolveCurrentMembers(doc, ENT));
		expect(member.x25519).toBeNull();
		expect(member.grantValid).toBe(true);
	});
});
