/**
 * Access-record tests (Collab C1) — the signed membership log. Covers
 * authenticity (grant/revoke signatures), lifecycle (active → revoked with
 * audit retained), entity-binding, tamper/forgery rejection, and CRDT merge of
 * concurrent grants into a shared (owner-bootstrapped) log.
 *
 * Every record here is OWNER-ROOTED: `owned()` writes the owner's genesis
 * grant first, as `SharingEngine` does, and readers resolve under that root.
 * (Before 0.16 these cases granted into an empty doc with no genesis grant and
 * resolved with no root at all; under the authorization policy such a record
 * has no members. The policy's own cases are `access-record-authz.test.ts`.)
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import {
	AccessRole,
	type AccessTrust,
	type ResolvedMember,
	activeMembers,
	getAccessArray,
	grantAccess,
	isActiveMember,
	isAuthorizedWriter,
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

/** A fresh doc carrying `owner`'s genesis grant — the root of its record. */
function owned(owner: { secret: Uint8Array; pub: string }): Y.Doc {
	const doc = new Y.Doc();
	grantAccess(doc, {
		entityId: ENT,
		member: owner.pub,
		role: AccessRole.Owner,
		signerSecret: owner.secret,
		now: 1,
	});
	return doc;
}

/** The row for `member`, asserting there is exactly one. */
function rowOf(rows: readonly ResolvedMember[], member: string): ResolvedMember {
	const found = rows.filter((m) => m.member === member);
	if (found.length !== 1) throw new Error(`expected one row for the member, got ${found.length}`);
	return found[0] as ResolvedMember;
}

describe("access-record (Collab C1)", () => {
	it("grants and resolves an active member", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});

		const members = resolveMembers(doc, ENT, trust);
		expect(members).toHaveLength(2); // the owner's genesis grant + marcus
		const m = rowOf(members, marcus.pub);
		expect(m.member).toBe(marcus.pub);
		expect(m.role).toBe(AccessRole.Editor);
		expect(m.addedBy).toBe(owner.pub);
		expect(m.grantValid).toBe(true);
		expect(m.active).toBe(true);
		expect(isActiveMember(doc, ENT, marcus.pub, trust)).toBe(true);
		expect(roleOf(doc, ENT, marcus.pub, trust)).toBe(AccessRole.Editor);
	});

	it("is idempotent on a repeat grant for a live member", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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
		expect(activeMembers(doc, ENT, trust)).toHaveLength(2);
		expect(roleOf(doc, ENT, marcus.pub, trust)).toBe(AccessRole.Editor); // first grant stands
	});

	it("revokes a member but keeps the audit entry", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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

		const all = resolveMembers(doc, ENT, trust);
		expect(all).toHaveLength(2); // history retained
		const m = rowOf(all, marcus.pub);
		expect(m.revokedAt).toBe(5000);
		expect(m.revokedBy).toBe(owner.pub);
		expect(m.revokeValid).toBe(true);
		expect(m.active).toBe(false);
		expect(activeMembers(doc, ENT, trust).map((x) => x.member)).toEqual([owner.pub]);
		expect(isActiveMember(doc, ENT, marcus.pub, trust)).toBe(false);
		expect(roleOf(doc, ENT, marcus.pub, trust)).toBeNull();
	});

	it("re-grant after revoke makes the member active again", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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
		const marcusRows = resolveMembers(doc, ENT, trust).filter((m) => m.member === marcus.pub);
		expect(marcusRows).toHaveLength(2); // both the revoked + the new
		expect(activeMembers(doc, ENT, trust)).toHaveLength(2);
		expect(roleOf(doc, ENT, marcus.pub, trust)).toBe(AccessRole.Editor);
		// The CURRENT-members view collapses to one row per member (F-287): the
		// live re-grant, not the stale revoked row a raw find(member) would hit.
		const current = resolveCurrentMembers(doc, ENT, trust);
		expect(current).toHaveLength(2);
		expect(rowOf(current, marcus.pub).active).toBe(true);
		expect(rowOf(current, marcus.pub).role).toBe(AccessRole.Editor);
	});

	it("rejects a tampered role (grant signature no longer verifies)", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 1000,
		});
		// Attacker bumps the stored role to Owner without re-signing.
		getAccessArray(doc).get(1).set("role", AccessRole.Owner);
		// The signature exposes it: the entry is no longer a statement anyone
		// made, so it is not a row at all — and certainly not an Owner.
		expect(resolveMembers(doc, ENT, trust).some((m) => m.member === marcus.pub)).toBe(false);
		expect(roleOf(doc, ENT, marcus.pub, trust)).toBeNull();
	});

	it("binds a grant to its entity (can't be replayed into another doc)", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 1000,
		});
		// Same bytes, resolved as if they belonged to a different entity.
		expect(isActiveMember(doc, "ent_other", marcus.pub, trust)).toBe(false);
		expect(resolveMembers(doc, "ent_other", trust).some((m) => m.member === marcus.pub)).toBe(false);
	});

	it("ignores a forged revoke (bad revoke signature → member stays active)", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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
		const entry = getAccessArray(doc).get(1);
		entry.set("revokedAt", 9000);
		entry.set("revokedBy", attacker.pub);
		entry.set("revokeSig", "AAAA"); // garbage
		const m = rowOf(resolveMembers(doc, ENT, trust), marcus.pub);
		expect(m.revokeValid).toBe(false);
		expect(m.active).toBe(true); // grant still stands; forged revoke ignored
		expect(isActiveMember(doc, ENT, marcus.pub, trust)).toBe(true);
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
			const active = activeMembers(doc, ENT, { root: owner.pub })
				.map((m) => m.member)
				.sort();
			expect(active).toEqual([owner.pub, a.pub, b.pub].sort());
		}
	});
});

describe("access-record — signed X25519 wrapping key (collection-sharing, design 71)", () => {
	it("carries a member's X25519 through resolve, covered by the grant signature", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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
		const member = rowOf(resolveCurrentMembers(doc, ENT, trust), marcus.pub);
		expect(member.x25519).toBe(marcusX25519);
		expect(member.grantValid).toBe(true);
		expect(member.active).toBe(true);
	});

	it("rejects a tampered X25519 (the key is in the signed payload)", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
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
		getAccessArray(doc).get(1).set("x25519", "YXR0YWNrZXItc3Vic3RpdHV0ZWQteDI1NTE5LWtleS1oZXJl");
		expect(isActiveMember(doc, ENT, marcus.pub, trust)).toBe(false);
		expect(resolveMembers(doc, ENT, trust).some((m) => m.member === marcus.pub)).toBe(false);
	});

	it("a key-less grant resolves x25519=null and stays valid (back-compat)", () => {
		const owner = person();
		const doc = owned(owner);
		const trust: AccessTrust = { root: owner.pub };
		const marcus = person();
		grantAccess(doc, {
			entityId: ENT,
			member: marcus.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 1,
		});
		const member = rowOf(resolveCurrentMembers(doc, ENT, trust), marcus.pub);
		expect(member.x25519).toBeNull();
		expect(member.grantValid).toBe(true);
	});
});

describe("isAuthorizedWriter (Collab-C5 / F-288)", () => {
	// The wire sender key is the raw Ed25519 public-key bytes; grants store it
	// as std base64 (person().pub). We authorize by comparing decoded bytes, so
	// tests pass the raw bytes the pipeline would decode from the header.
	function seed(role: AccessRole) {
		const doc = new Y.Doc();
		const owner = generateIdentity();
		const collaborator = generateIdentity();
		// Owner self-grant (as SharingEngine.provisionEntity does), then the member.
		grantAccess(doc, {
			entityId: ENT,
			member: publicKeyToBase64(owner.publicKey),
			role: AccessRole.Owner,
			signerSecret: owner.secretKey,
			now: 1000,
		});
		grantAccess(doc, {
			entityId: ENT,
			member: publicKeyToBase64(collaborator.publicKey),
			role,
			signerSecret: owner.secretKey,
			now: 2000,
		});
		const trust: AccessTrust = { root: publicKeyToBase64(owner.publicKey) };
		return { doc, owner, collaborator, trust };
	}

	it("authorizes an Editor member's writes", () => {
		const { doc, collaborator, trust } = seed(AccessRole.Editor);
		expect(isAuthorizedWriter(doc, ENT, collaborator.publicKey, trust)).toBe(true);
	});

	it("authorizes the Owner's own writes", () => {
		const { doc, owner, trust } = seed(AccessRole.Editor);
		expect(isAuthorizedWriter(doc, ENT, owner.publicKey, trust)).toBe(true);
	});

	it("DENIES a Viewer member's writes (F-288)", () => {
		const { doc, collaborator, trust } = seed(AccessRole.Viewer);
		expect(isAuthorizedWriter(doc, ENT, collaborator.publicKey, trust)).toBe(false);
	});

	it("denies a non-member (unshared entity / stranger)", () => {
		const { doc, trust } = seed(AccessRole.Editor);
		const stranger = generateIdentity();
		expect(isAuthorizedWriter(doc, ENT, stranger.publicKey, trust)).toBe(false);
	});

	it("denies a revoked member (revoke ⇒ no writes)", () => {
		const { doc, owner, collaborator, trust } = seed(AccessRole.Editor);
		revokeAccess(doc, {
			entityId: ENT,
			member: publicKeyToBase64(collaborator.publicKey),
			signerSecret: owner.secretKey,
			now: 3000,
		});
		expect(isAuthorizedWriter(doc, ENT, collaborator.publicKey, trust)).toBe(false);
	});

	it("re-authorizes a Viewer promoted to Editor (revoke → re-grant, the real upgrade path)", () => {
		const { doc, owner, collaborator, trust } = seed(AccessRole.Viewer);
		const memberB64 = publicKeyToBase64(collaborator.publicKey);
		expect(isAuthorizedWriter(doc, ENT, collaborator.publicKey, trust)).toBe(false);
		// A live grant is idempotent, so a role change goes revoke → re-grant.
		revokeAccess(doc, { entityId: ENT, member: memberB64, signerSecret: owner.secretKey, now: 3500 });
		grantAccess(doc, {
			entityId: ENT,
			member: memberB64,
			role: AccessRole.Editor,
			signerSecret: owner.secretKey,
			now: 4000,
		});
		expect(isAuthorizedWriter(doc, ENT, collaborator.publicKey, trust)).toBe(true);
	});
});
