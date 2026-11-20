/**
 * The sharing authorization policy (0.16.0) — the security test.
 *
 * Until 0.16 the access record had no authorization policy: `resolveMembers`
 * verified a grant only under the key that signed it, and a synced update from
 * any authorized writer is applied to the doc whole, access record included.
 * So a plain EDITOR could remove herself, add a stranger, revoke the owner and
 * make herself an Owner, on every device. This file began life as the
 * characterisation of exactly that; each of those four attacks is here again,
 * unchanged on the attacker's side, now asserting it has NO effect on what any
 * consumer resolves: the members, the authorized writers, who may install a
 * rotated DEK, and who the collection cascade wraps a child's DEK to.
 *
 * The policy itself is `access-record.ts` (module header). The ingest + DEK
 * path over real vaults is `sharing-authz-ingest.test.ts`.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { base64ToBytes } from "../credentials/crypto";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import {
	AccessRole,
	type AccessTrust,
	activeMembers,
	deriveAccessRoot,
	docTrust,
	getAccessArray,
	grantAccess,
	isAuthorizedWriter,
	isSharedRecord,
	mayGrant,
	mayRevoke,
	repairAccessRecord,
	resolveCurrentMembers,
	resolveMembers,
	revokeAccess,
	roleOf,
} from "./access-record";
import { AccessTrustStore, inMemoryAccessTrust } from "./access-trust";
import { authorizesWrapInstall } from "./wrap-install-authz";

const ENT = "ent_authz_1";
const X25519 = "c3RyYW5nZXIteDI1NTE5LXdyYXBwaW5nLWtleS0zMmI=";

type Person = { secret: Uint8Array; key: Uint8Array; pub: string };

function person(): Person {
	const kp = generateIdentity();
	return { secret: kp.secretKey, key: kp.publicKey, pub: publicKeyToBase64(kp.publicKey) };
}

function replica(of: Y.Doc): Y.Doc {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, Y.encodeStateAsUpdate(of));
	return doc;
}

/** One side's ordinary sync update applied on the other the way the ingest
 *  path applies any authorized writer's update: whole. */
function sync(to: Y.Doc, from: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** A device: its own pinned trust, the way production resolves. */
function device(self: Person) {
	const store = new AccessTrustStore(inMemoryAccessTrust(), self.pub);
	return {
		store,
		trust: (doc: Y.Doc) => store.trustFor(doc, ENT),
		active: (doc: Y.Doc) =>
			activeMembers(doc, ENT, store.trustFor(doc, ENT))
				.map((m) => m.member)
				.sort(),
	};
}

/** Owner shares with one Editor. The owner's device has resolved the record
 *  (so its root is pinned), the Editor holds a replica. */
function sharedPair() {
	const owner = person();
	const editor = person();
	const ownerDoc = new Y.Doc();
	grantAccess(ownerDoc, {
		entityId: ENT,
		member: owner.pub,
		role: AccessRole.Owner,
		signerSecret: owner.secret,
		now: 1,
		x25519: "b3duZXIteDI1NTE5LXdyYXBwaW5nLWtleS0zMmJ5dGU=",
	});
	grantAccess(ownerDoc, {
		entityId: ENT,
		member: editor.pub,
		role: AccessRole.Editor,
		signerSecret: owner.secret,
		now: 2,
		x25519: "ZWRpdG9yLXgyNTUxOS13cmFwcGluZy1rZXktMzJieXQ=",
	});
	const ownerDevice = device(owner);
	ownerDevice.trust(ownerDoc);
	const editorDoc = replica(ownerDoc);
	return { owner, editor, ownerDoc, editorDoc, ownerDevice };
}

/** `SharingEngine.#activeMembersWithKeys` — who a new child's DEK is wrapped to. */
function cascadeRecipients(doc: Y.Doc, trust: AccessTrust): string[] {
	return activeMembers(doc, ENT, trust)
		.filter((m) => m.x25519 !== null)
		.map((m) => m.member)
		.sort();
}

function mayInstallWrap(doc: Y.Doc, trust: AccessTrust, sender: Person, self: Person): boolean {
	return authorizesWrapInstall({
		entityId: ENT,
		senderKey: sender.key,
		selfPub: self.key,
		holdsDek: true,
		localDoc: doc,
		trust,
		decodeMemberKey: base64ToBytes,
	});
}

describe("an Editor's sync update cannot change who the members are", () => {
	it("the baseline: owner and editor are the members, the entity is shared", () => {
		const { owner, editor, ownerDoc, ownerDevice } = sharedPair();
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(isSharedRecord(ownerDoc, ENT, ownerDevice.trust(ownerDoc))).toBe(true);
	});

	it("deleting her own entry does not remove her — the owner's device still syncs the entity", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		const access = getAccessArray(editorDoc);
		access.delete(
			access.toArray().findIndex((entry) => entry.get("member") === editor.pub),
			1,
		);
		sync(ownerDoc, editorDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(isSharedRecord(ownerDoc, ENT, ownerDevice.trust(ownerDoc))).toBe(true);
	});

	it("deleting EVERY entry, the owner's included, changes nothing on the owner's device", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		const access = getAccessArray(editorDoc);
		access.delete(0, access.length);
		sync(ownerDoc, editorDoc);
		expect(getAccessArray(ownerDoc).length).toBe(0);
		const trust = ownerDevice.trust(ownerDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(roleOf(ownerDoc, ENT, owner.pub, trust)).toBe(AccessRole.Owner);
		expect(roleOf(ownerDoc, ENT, editor.pub, trust)).toBe(AccessRole.Editor);
		// …and the owner's next record mutation writes the entries back.
		expect(repairAccessRecord(ownerDoc, ENT, trust)).toBe(true);
		expect(activeMembers(ownerDoc, ENT, { root: owner.pub })).toHaveLength(2);
	});

	it("a stranger she adds as Editor, with a wrapping key, is not a member, a writer or a cascade recipient", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		const stranger = person();
		grantAccess(editorDoc, {
			entityId: ENT,
			member: stranger.pub,
			role: AccessRole.Editor,
			signerSecret: editor.secret,
			now: 3,
			x25519: X25519,
		});
		sync(ownerDoc, editorDoc);
		const trust = ownerDevice.trust(ownerDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(isAuthorizedWriter(ownerDoc, ENT, stranger.key, trust)).toBe(false);
		expect(cascadeRecipients(ownerDoc, trust)).toEqual([owner.pub, editor.pub].sort());
		// The entry is in the CRDT — signed, verifiable, and without effect.
		const row = resolveMembers(ownerDoc, ENT, trust).find((m) => m.member === stranger.pub);
		expect(row).toMatchObject({ grantValid: true, authorized: false, active: false });
	});

	it("her revoke of the owner does nothing", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		revokeAccess(editorDoc, {
			entityId: ENT,
			member: owner.pub,
			signerSecret: editor.secret,
			now: 3,
		});
		sync(ownerDoc, editorDoc);
		const trust = ownerDevice.trust(ownerDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(isAuthorizedWriter(ownerDoc, ENT, owner.key, trust)).toBe(true);
		expect(roleOf(ownerDoc, ENT, owner.pub, trust)).toBe(AccessRole.Owner);
	});

	it("her revoke of ANOTHER member does nothing", () => {
		const { owner, editor, ownerDoc, ownerDevice } = sharedPair();
		const viewer = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: viewer.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 3,
		});
		const editorDoc = replica(ownerDoc);
		revokeAccess(editorDoc, {
			entityId: ENT,
			member: viewer.pub,
			signerSecret: editor.secret,
			now: 4,
		});
		sync(ownerDoc, editorDoc);
		expect(ownerDevice.active(ownerDoc)).toContain(viewer.pub);
	});

	it("making herself an Owner does not make her one, so she cannot authorize a DEK rotation", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		expect(mayInstallWrap(ownerDoc, ownerDevice.trust(ownerDoc), editor, owner)).toBe(false);
		revokeAccess(editorDoc, {
			entityId: ENT,
			member: editor.pub,
			signerSecret: editor.secret,
			now: 3,
		});
		grantAccess(editorDoc, {
			entityId: ENT,
			member: editor.pub,
			role: AccessRole.Owner,
			signerSecret: editor.secret,
			now: 4,
		});
		// Belt and braces: the same self-promotion without leaving first.
		const forged = new Y.Map<unknown>();
		const template = getAccessArray(editorDoc)
			.toArray()
			.find((e) => e.get("role") === AccessRole.Owner && e.get("member") === editor.pub);
		for (const [k, v] of template?.entries() ?? []) forged.set(k, v);
		getAccessArray(editorDoc).insert(0, [forged]);
		sync(ownerDoc, editorDoc);
		const trust = ownerDevice.trust(ownerDoc);
		expect(roleOf(ownerDoc, ENT, editor.pub, trust)).not.toBe(AccessRole.Owner);
		expect(mayInstallWrap(ownerDoc, trust, editor, owner)).toBe(false);
		expect(mayGrant(ownerDoc, ENT, editor.pub, trust)).toBe(false);
	});

	it("a grant or revoke counts only when its signer holds ownership through a chain from the root", () => {
		const { owner, editor, ownerDoc, ownerDevice } = sharedPair();
		const coOwner = person();
		const viaCoOwner = person();
		const viaEditor = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: coOwner.pub,
			role: AccessRole.Owner,
			signerSecret: owner.secret,
			now: 3,
		});
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: viaCoOwner.pub,
			role: AccessRole.Editor,
			signerSecret: coOwner.secret,
			now: 4,
		});
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: viaEditor.pub,
			role: AccessRole.Editor,
			signerSecret: editor.secret,
			now: 5,
		});
		const trust = ownerDevice.trust(ownerDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual(
			[owner.pub, editor.pub, coOwner.pub, viaCoOwner.pub].sort(),
		);
		expect(mayGrant(ownerDoc, ENT, coOwner.pub, trust)).toBe(true);
		expect(mayGrant(ownerDoc, ENT, editor.pub, trust)).toBe(false);
		expect(mayRevoke(ownerDoc, ENT, coOwner.pub, editor.pub, trust)).toBe(true);
		expect(mayRevoke(ownerDoc, ENT, editor.pub, viaCoOwner.pub, trust)).toBe(false);
		// Nobody removes the root; only the root (or she herself) removes a co-owner.
		expect(mayRevoke(ownerDoc, ENT, coOwner.pub, owner.pub, trust)).toBe(false);
		expect(mayRevoke(ownerDoc, ENT, owner.pub, owner.pub, trust)).toBe(false);
		expect(mayRevoke(ownerDoc, ENT, owner.pub, coOwner.pub, trust)).toBe(true);
		expect(mayRevoke(ownerDoc, ENT, coOwner.pub, coOwner.pub, trust)).toBe(true);
	});

	it("an inbound update that deletes or rewrites access entries has no effect once the device has seen them", () => {
		const { owner, editor, ownerDoc, ownerDevice } = sharedPair();
		const viewer = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: viewer.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 3,
		});
		revokeAccess(ownerDoc, { entityId: ENT, member: viewer.pub, signerSecret: owner.secret, now: 4 });
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		const editorDoc = replica(ownerDoc);
		for (const entry of getAccessArray(editorDoc).toArray()) {
			if (entry.get("member") !== viewer.pub) continue;
			// Blank the revoke, and separately re-append the grant as a fresh entry.
			entry.set("revokedAt", null);
			entry.set("revokedBy", null);
			entry.set("revokeSig", null);
			const copy = new Y.Map<unknown>();
			for (const [k, v] of entry.entries()) copy.set(k, v);
			getAccessArray(editorDoc).push([copy]);
		}
		sync(ownerDoc, editorDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		// A device that never saw the revoke is not protected by memory, but it IS
		// by the owner's repair, which puts the revoke back for everyone.
		const late = device(person());
		late.store.pinRoot(ENT, owner.pub);
		expect(late.active(ownerDoc)).toContain(viewer.pub);
		repairAccessRecord(ownerDoc, ENT, ownerDevice.trust(ownerDoc));
		expect(late.active(ownerDoc)).not.toContain(viewer.pub);
	});
});

describe("what legitimately works", () => {
	it("an owner grants, changes a role and revokes", () => {
		const { owner, editor, ownerDoc, ownerDevice } = sharedPair();
		const trust = () => ownerDevice.trust(ownerDoc);
		revokeAccess(ownerDoc, { entityId: ENT, member: editor.pub, signerSecret: owner.secret, now: 3 });
		expect(roleOf(ownerDoc, ENT, editor.pub, trust())).toBeNull();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: editor.pub,
			role: AccessRole.Viewer,
			signerSecret: owner.secret,
			now: 4,
		});
		expect(roleOf(ownerDoc, ENT, editor.pub, trust())).toBe(AccessRole.Viewer);
		expect(isAuthorizedWriter(ownerDoc, ENT, editor.key, trust())).toBe(false);
	});

	it("a member may leave: her own revoke of her own grant counts", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		expect(
			revokeAccess(editorDoc, {
				entityId: ENT,
				member: editor.pub,
				signerSecret: editor.secret,
				now: 3,
			}),
		).toBe(true);
		sync(ownerDoc, editorDoc);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub]);
		expect(isSharedRecord(ownerDoc, ENT, ownerDevice.trust(ownerDoc))).toBe(false);
	});

	it("a junk revoke she scribbles on her own entry neither removes her nor makes her un-revokable", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		for (const entry of getAccessArray(editorDoc).toArray()) {
			if (entry.get("member") !== editor.pub) continue;
			entry.set("revokedAt", 3);
			entry.set("revokedBy", owner.pub);
			entry.set("revokeSig", "AAAA");
		}
		sync(ownerDoc, editorDoc);
		expect(ownerDevice.active(ownerDoc)).toContain(editor.pub);
		expect(
			revokeAccess(ownerDoc, {
				entityId: ENT,
				member: editor.pub,
				signerSecret: owner.secret,
				now: 5,
				trust: ownerDevice.trust(ownerDoc),
			}),
		).toBe(true);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub]);
	});

	it("a forged entry naming a member does not block the owner's real grant", () => {
		const { owner, editor, ownerDoc, editorDoc, ownerDevice } = sharedPair();
		const invitee = person();
		grantAccess(editorDoc, {
			entityId: ENT,
			member: invitee.pub,
			role: AccessRole.Viewer,
			signerSecret: editor.secret,
			now: 3,
		});
		sync(ownerDoc, editorDoc);
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: invitee.pub,
			role: AccessRole.Editor,
			signerSecret: owner.secret,
			now: 4,
			trust: ownerDevice.trust(ownerDoc),
		});
		expect(roleOf(ownerDoc, ENT, invitee.pub, ownerDevice.trust(ownerDoc))).toBe(AccessRole.Editor);
	});
});

describe("co-owners and former owners", () => {
	function withCoOwner() {
		const base = sharedPair();
		const coOwner = person();
		grantAccess(base.ownerDoc, {
			entityId: ENT,
			member: coOwner.pub,
			role: AccessRole.Owner,
			signerSecret: base.owner.secret,
			now: 3,
		});
		return { ...base, coOwner };
	}

	it("an entry signed by a former co-owner has no effect, whenever it claims to have been signed", () => {
		const { owner, editor, coOwner, ownerDoc, ownerDevice } = withCoOwner();
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: coOwner.pub,
			signerSecret: owner.secret,
			now: 10,
		});
		const stale = replica(ownerDoc);
		const stranger = person();
		// Back-dated to when she WAS an owner, and injected by a current writer.
		grantAccess(stale, {
			entityId: ENT,
			member: stranger.pub,
			role: AccessRole.Owner,
			signerSecret: coOwner.secret,
			now: 4,
			trust: { root: owner.pub },
		});
		sync(ownerDoc, stale);
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(mayInstallWrap(ownerDoc, ownerDevice.trust(ownerDoc), coOwner, owner)).toBe(false);
	});

	it("removing a co-owner voids her grants but NOT her revokes", () => {
		const { owner, editor, coOwner, ownerDoc, ownerDevice } = withCoOwner();
		const added = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: added.pub,
			role: AccessRole.Viewer,
			signerSecret: coOwner.secret,
			now: 4,
		});
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: editor.pub,
			signerSecret: coOwner.secret,
			now: 5,
			trust: ownerDevice.trust(ownerDoc),
		});
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub, coOwner.pub, added.pub].sort());
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: coOwner.pub,
			signerSecret: owner.secret,
			now: 6,
			trust: ownerDevice.trust(ownerDoc),
		});
		// `added` goes with her; the editor she removed does NOT come back.
		expect(ownerDevice.active(ownerDoc)).toEqual([owner.pub]);
	});

	it("a co-owner cannot remove the root or another co-owner", () => {
		const { owner, coOwner, ownerDoc, ownerDevice } = withCoOwner();
		const second = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: second.pub,
			role: AccessRole.Owner,
			signerSecret: owner.secret,
			now: 4,
		});
		const trust = ownerDevice.trust(ownerDoc);
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: owner.pub,
			signerSecret: coOwner.secret,
			now: 5,
			trust,
		});
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: second.pub,
			signerSecret: coOwner.secret,
			now: 5,
			trust,
		});
		expect(ownerDevice.active(ownerDoc)).toContain(owner.pub);
		expect(ownerDevice.active(ownerDoc)).toContain(second.pub);
	});
});

describe("the root of authority", () => {
	it("is this identity on the device that created the record", () => {
		const { owner, ownerDoc } = sharedPair();
		expect(deriveAccessRoot(ownerDoc, ENT, { self: owner.pub })).toBe(owner.pub);
	});

	it("is taken on first sight by a member, and never replaced afterwards", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		const editorDevice = device(editor);
		expect(editorDevice.trust(editorDoc).root).toBe(owner.pub);
		// A forged root: a third party's self-signed Owner grant, plus her own
		// Owner grant to the real owner so the record still "works" under it.
		const usurper = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: usurper.pub,
			role: AccessRole.Owner,
			signerSecret: usurper.secret,
			now: 0,
			trust: { root: null },
		});
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: editor.pub,
			role: AccessRole.Owner,
			signerSecret: usurper.secret,
			now: 0,
			trust: { root: null },
		});
		sync(editorDoc, ownerDoc);
		expect(editorDevice.trust(editorDoc).root).toBe(owner.pub);
		expect(editorDevice.active(editorDoc)).toEqual([owner.pub, editor.pub].sort());
		expect(roleOf(editorDoc, ENT, editor.pub, editorDevice.trust(editorDoc))).toBe(AccessRole.Editor);
	});

	it("a record with two candidate roots is refused by a device with no pin, not guessed at", () => {
		const { editor, ownerDoc } = sharedPair();
		const usurper = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: usurper.pub,
			role: AccessRole.Owner,
			signerSecret: usurper.secret,
			now: 0,
			trust: { root: null },
		});
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: editor.pub,
			role: AccessRole.Editor,
			signerSecret: usurper.secret,
			now: 0,
			trust: { root: null },
		});
		expect(deriveAccessRoot(ownerDoc, ENT, { self: editor.pub })).toBeNull();
		const fresh = device(editor);
		expect(fresh.active(ownerDoc)).toEqual([]);
	});

	it("with no root, nobody is a member", () => {
		const { ownerDoc } = sharedPair();
		expect(resolveCurrentMembers(ownerDoc, ENT, { root: null })).toEqual([]);
	});
});

describe("convergence", () => {
	it("concurrent owner actions resolve identically on two replicas, whichever order they merge in", () => {
		const { owner, editor, ownerDoc } = sharedPair();
		const coOwner = person();
		grantAccess(ownerDoc, {
			entityId: ENT,
			member: coOwner.pub,
			role: AccessRole.Owner,
			signerSecret: owner.secret,
			now: 3,
		});
		const a = replica(ownerDoc);
		const b = replica(ownerDoc);
		const viewer = person();
		// Concurrently: the owner removes the editor; the co-owner adds a viewer
		// and (separately) also removes the editor.
		revokeAccess(a, { entityId: ENT, member: editor.pub, signerSecret: owner.secret, now: 4 });
		grantAccess(b, {
			entityId: ENT,
			member: viewer.pub,
			role: AccessRole.Viewer,
			signerSecret: coOwner.secret,
			now: 4,
			trust: { root: owner.pub },
		});
		revokeAccess(b, {
			entityId: ENT,
			member: editor.pub,
			signerSecret: coOwner.secret,
			now: 5,
			trust: { root: owner.pub },
		});
		const ab = replica(a);
		sync(ab, b);
		const ba = replica(b);
		sync(ba, a);
		const trust: AccessTrust = { root: owner.pub };
		const view = (doc: Y.Doc) =>
			resolveCurrentMembers(doc, ENT, trust)
				.map((m) => `${m.member}:${m.role}:${m.active}`)
				.sort();
		expect(view(ab)).toEqual(view(ba));
		expect(
			activeMembers(ab, ENT, trust)
				.map((m) => m.member)
				.sort(),
		).toEqual([owner.pub, coOwner.pub, viewer.pub].sort());
	});

	it("replayed and reordered entries change nothing", () => {
		const { owner, editor, ownerDoc } = sharedPair();
		revokeAccess(ownerDoc, { entityId: ENT, member: editor.pub, signerSecret: owner.secret, now: 3 });
		const trust: AccessTrust = { root: owner.pub };
		const before = activeMembers(ownerDoc, ENT, trust).map((m) => m.member);
		const shuffled = new Y.Doc();
		const entries = getAccessArray(ownerDoc)
			.toArray()
			.map((entry) => Object.fromEntries(entry.entries()));
		const target = getAccessArray(shuffled);
		for (const fields of [...entries].reverse().concat(entries)) {
			const copy = new Y.Map<unknown>();
			for (const [k, v] of Object.entries(fields)) copy.set(k, v);
			// The replay of the revoked grant comes back with its revoke stripped.
			if (fields.member === editor.pub && target.length % 2 === 0) {
				copy.set("revokedAt", null);
				copy.set("revokedBy", null);
				copy.set("revokeSig", null);
			}
			target.push([copy]);
		}
		expect(activeMembers(shuffled, ENT, trust).map((m) => m.member)).toEqual(before);
	});
});

/**
 * Property: over random interleavings of valid and invalid statements,
 * (a) every replica that holds the same statements resolves the same members,
 *     whatever order they were written or merged in, and
 * (b) every active member is reachable from the root by a chain of grants each
 *     signed by an owner — checked against an independent reference model.
 */
describe("policy properties", () => {
	const CAST = 5;
	type Op =
		| { kind: "grant"; signer: number; member: number; role: AccessRole }
		| { kind: "revoke"; signer: number; member: number }
		| { kind: "delete"; index: number };
	const ROLES = [AccessRole.Owner, AccessRole.Editor, AccessRole.Viewer] as const;

	// No fast-check in this repo (see `ipc/envelope.test.ts`): a small seeded
	// generator, so a failure names a seed that reproduces.
	function generator(seed: number) {
		let state = seed >>> 0;
		const next = (): number => {
			state = (state + 0x6d2b79f5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const int = (max: number): number => Math.floor(next() * max);
		const op = (): Op => {
			const roll = next();
			if (roll < 0.5) {
				return {
					kind: "grant",
					signer: int(CAST),
					member: int(CAST),
					role: ROLES[int(ROLES.length)] as AccessRole,
				};
			}
			if (roll < 0.85) return { kind: "revoke", signer: int(CAST), member: int(CAST) };
			return { kind: "delete", index: int(9) };
		};
		const ops = (max: number): Op[] => Array.from({ length: int(max + 1) }, op);
		return { int, ops };
	}

	/** Run `body` over `runs` seeds; a failure reports the seed. */
	function forSeeds(runs: number, body: (gen: ReturnType<typeof generator>) => void): void {
		for (let seed = 1; seed <= runs; seed++) {
			try {
				body(generator(seed));
			} catch (error) {
				throw new Error(`seed ${seed}: ${(error as Error).message}`);
			}
		}
	}

	/** Apply `ops` as raw writes: every signer signs whatever the op says,
	 *  with or without the authority to. */
	function play(doc: Y.Doc, cast: Person[], ops: readonly Op[], clock: { now: number }): void {
		const root = cast[0] as Person;
		for (const o of ops) {
			clock.now += 1;
			if (o.kind === "delete") {
				const arr = getAccessArray(doc);
				if (arr.length > 1) arr.delete(1 + (o.index % (arr.length - 1)), 1);
				continue;
			}
			const signer = cast[o.signer] as Person;
			const member = cast[o.member] as Person;
			if (o.kind === "grant") {
				grantAccess(doc, {
					entityId: ENT,
					member: member.pub,
					role: o.role,
					signerSecret: signer.secret,
					now: clock.now,
					// `root: null` ⇒ always append: the op is written whether or not
					// the policy would have called it redundant.
					trust: { root: null },
				});
			} else {
				// Raw revoke: target whatever the ROOT-pinned policy says is live,
				// signed by whoever the op names.
				revokeAccess(doc, {
					entityId: ENT,
					member: member.pub,
					signerSecret: signer.secret,
					now: clock.now,
					trust: { root: root.pub },
				});
			}
		}
	}

	function genesis(cast: Person[]): Y.Doc {
		const root = cast[0] as Person;
		const doc = new Y.Doc();
		grantAccess(doc, {
			entityId: ENT,
			member: root.pub,
			role: AccessRole.Owner,
			signerSecret: root.secret,
			now: 1,
		});
		return doc;
	}

	const summary = (doc: Y.Doc, trust: AccessTrust) =>
		resolveCurrentMembers(doc, ENT, trust)
			.filter((m) => m.active)
			.map((m) => `${m.member}:${m.role}`)
			.sort();

	it("replicas converge on the same members regardless of merge order", () => {
		forSeeds(60, (gen) => {
			{
				const left = gen.ops(12);
				const right = gen.ops(12);
				const cast = Array.from({ length: CAST }, person);
				const trust: AccessTrust = { root: (cast[0] as Person).pub };
				const base = genesis(cast);
				const a = replica(base);
				const b = replica(base);
				play(a, cast, left, { now: 100 });
				play(b, cast, right, { now: 200 });
				const ab = replica(a);
				sync(ab, b);
				const ba = replica(b);
				sync(ba, a);
				expect(summary(ab, trust)).toEqual(summary(ba, trust));
			}
		});
	});

	it("only parties reachable from the root by owner-signed grants are ever active", () => {
		forSeeds(80, (gen) => {
			{
				const ops = gen.ops(20);
				const cast = Array.from({ length: CAST }, person);
				const root = (cast[0] as Person).pub;
				const trust: AccessTrust = { root };
				const doc = genesis(cast);
				play(doc, cast, ops, { now: 100 });
				// Reference model, deliberately the loosest sound bound: ignore every
				// revoke, and close over "member of an Owner grant signed by someone
				// already reachable". An active member must have a grant whose signer
				// is in that set.
				const grants = getAccessArray(doc)
					.toArray()
					.map((e) => ({
						member: e.get("member") as string,
						role: e.get("role") as AccessRole,
						addedBy: e.get("addedBy") as string,
					}));
				const reachableOwners = new Set([root]);
				for (let grew = true; grew; ) {
					grew = false;
					for (const g of grants) {
						if (g.role !== AccessRole.Owner || reachableOwners.has(g.member)) continue;
						if (!reachableOwners.has(g.addedBy)) continue;
						reachableOwners.add(g.member);
						grew = true;
					}
				}
				const active = activeMembers(doc, ENT, trust);
				expect(active.some((m) => m.member === root && m.role === AccessRole.Owner)).toBe(true);
				for (const m of active) {
					if (m.member === root) continue;
					expect(reachableOwners.has(m.addedBy)).toBe(true);
					if (m.role === AccessRole.Owner) expect(reachableOwners.has(m.member)).toBe(true);
				}
				// And no non-owner ever holds the right to grant.
				for (const p of cast) {
					if (mayGrant(doc, ENT, p.pub, trust)) expect(reachableOwners.has(p.pub)).toBe(true);
				}
			}
		});
	});

	it("a device that has seen a statement is unaffected by its deletion", () => {
		forSeeds(60, (gen) => {
			{
				const ops = gen.ops(14);
				const cuts = Array.from({ length: gen.int(7) }, () => gen.int(21));
				const cast = Array.from({ length: CAST }, person);
				const root = cast[0] as Person;
				const doc = genesis(cast);
				play(
					doc,
					cast,
					ops.filter((o) => o.kind !== "delete"),
					{ now: 100 },
				);
				const seen = device(root);
				const before = seen.active(doc);
				const arr = getAccessArray(doc);
				for (const cut of cuts) if (arr.length > 0) arr.delete(cut % arr.length, 1);
				expect(seen.active(doc)).toEqual(before);
			}
		});
	});
});

describe("unpinned trust (docTrust) — for probes and tests only", () => {
	it("derives the same root the pinned store would", () => {
		const { owner, editor, ownerDoc } = sharedPair();
		expect(docTrust(ownerDoc, ENT, { self: editor.pub }).root).toBe(owner.pub);
		expect(docTrust(ownerDoc, ENT).root).toBe(owner.pub);
	});
});
