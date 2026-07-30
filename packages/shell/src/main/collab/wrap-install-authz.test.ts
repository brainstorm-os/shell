import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { base64ToBytes } from "../credentials/crypto";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import { AccessRole, grantAccess, revokeAccess } from "./access-record";
import { authorizesWrapInstall } from "./wrap-install-authz";

const ENTITY = "ent_wrap_authz";

type Party = ReturnType<typeof generateIdentity>;

function docWith(entries: readonly { party: Party; role: AccessRole; by: Party }[]): Y.Doc {
	const doc = new Y.Doc();
	let now = 1_000;
	for (const entry of entries) {
		grantAccess(doc, {
			entityId: ENTITY,
			member: publicKeyToBase64(entry.party.publicKey),
			role: entry.role,
			signerSecret: entry.by.secretKey,
			now: now++,
		});
	}
	return doc;
}

function check(doc: Y.Doc, sender: Uint8Array, self: Uint8Array, holdsDek: boolean): boolean {
	return authorizesWrapInstall({
		entityId: ENTITY,
		senderKey: sender,
		selfPub: self,
		holdsDek,
		localDoc: doc,
		decodeMemberKey: base64ToBytes,
	});
}

describe("authorizesWrapInstall - who may install / rotate a per-entity DEK", () => {
	const owner = generateIdentity();
	const editor = generateIdentity();
	const viewer = generateIdentity();
	const me = generateIdentity();
	const stranger = generateIdentity();

	function sharedDoc(): Y.Doc {
		return docWith([
			{ party: owner, role: AccessRole.Owner, by: owner },
			{ party: editor, role: AccessRole.Editor, by: owner },
			{ party: viewer, role: AccessRole.Viewer, by: owner },
			{ party: me, role: AccessRole.Editor, by: owner },
		]);
	}

	it("allows the FIRST install for an entity this device holds no DEK for", () => {
		const doc = new Y.Doc();
		try {
			expect(check(doc, stranger.publicKey, me.publicKey, false)).toBe(true);
		} finally {
			doc.destroy();
		}
	});

	it("allows our OWN identity to install (paired device / cold restore)", () => {
		const doc = new Y.Doc();
		try {
			expect(check(doc, me.publicKey, me.publicKey, true)).toBe(true);
		} finally {
			doc.destroy();
		}
	});

	it("allows an Owner to ROTATE a DEK we already hold", () => {
		const doc = sharedDoc();
		try {
			expect(check(doc, owner.publicKey, me.publicKey, true)).toBe(true);
		} finally {
			doc.destroy();
		}
	});

	it("DENIES an Editor rotating a DEK we already hold", () => {
		const doc = sharedDoc();
		try {
			expect(check(doc, editor.publicKey, me.publicKey, true)).toBe(false);
		} finally {
			doc.destroy();
		}
	});

	it("DENIES a Viewer rotating a DEK we already hold (the key-substitution attack)", () => {
		const doc = sharedDoc();
		try {
			expect(check(doc, viewer.publicKey, me.publicKey, true)).toBe(false);
		} finally {
			doc.destroy();
		}
	});

	it("DENIES a stranger with no grant at all", () => {
		const doc = sharedDoc();
		try {
			expect(check(doc, stranger.publicKey, me.publicKey, true)).toBe(false);
		} finally {
			doc.destroy();
		}
	});

	it("DENIES a REVOKED owner (a removed member cannot re-key what they lost)", () => {
		const doc = docWith([
			{ party: owner, role: AccessRole.Owner, by: owner },
			{ party: me, role: AccessRole.Editor, by: owner },
		]);
		try {
			revokeAccess(doc, {
				entityId: ENTITY,
				member: publicKeyToBase64(owner.publicKey),
				signerSecret: owner.secretKey,
				now: 9_000,
			});
			expect(check(doc, owner.publicKey, me.publicKey, true)).toBe(false);
		} finally {
			doc.destroy();
		}
	});

	it("fail-closed: an undecodable member key is skipped, never treated as a match", () => {
		const doc = sharedDoc();
		try {
			expect(
				authorizesWrapInstall({
					entityId: ENTITY,
					senderKey: owner.publicKey,
					selfPub: me.publicKey,
					holdsDek: true,
					localDoc: doc,
					decodeMemberKey: () => {
						throw new Error("bad key");
					},
				}),
			).toBe(false);
		} finally {
			doc.destroy();
		}
	});
});
