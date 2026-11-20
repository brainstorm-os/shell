/**
 * CHARACTERISATION — NOT a specification. These tests pass because the access
 * record currently has no authorization policy: `resolveMembers` verifies each
 * grant / revoke only under the key that signed it (`addedBy` / `revokedBy`),
 * never that the signer was entitled to make it, and a synced update from any
 * authorized writer is applied to the doc whole, access record included. The
 * module header says as much ("only an Owner may grant … is a deliberate
 * follow-up"). Each case shows one thing a plain EDITOR can therefore do to
 * the membership every device resolves, using only the real exported
 * functions, and names what downstream code reads that membership.
 *
 * When the sharing model gains owner-rooted authorization these assertions
 * must flip; the `it.todo` lines are the invariants to replace them with.
 * Found while hardening IE-12 (website publish), which no longer relies on
 * this record — see `share-trace.ts`.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { base64ToBytes } from "../credentials/crypto";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import {
	AccessRole,
	getAccessArray,
	grantAccess,
	isAuthorizedWriter,
	resolveCurrentMembers,
	resolveMembers,
	revokeAccess,
	roleOf,
} from "./access-record";
import { authorizesWrapInstall } from "./wrap-install-authz";

const ENT = "ent_forgery_1";

function person() {
	const kp = generateIdentity();
	return { secret: kp.secretKey, key: kp.publicKey, pub: publicKeyToBase64(kp.publicKey) };
}

/** Owner shares with one Editor; returns the owner's doc and the Editor's replica. */
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
	});
	grantAccess(ownerDoc, {
		entityId: ENT,
		member: editor.pub,
		role: AccessRole.Editor,
		signerSecret: owner.secret,
		now: 2,
	});
	const editorDoc = new Y.Doc();
	Y.applyUpdate(editorDoc, Y.encodeStateAsUpdate(ownerDoc));
	return { owner, editor, ownerDoc, editorDoc };
}

/** The Editor's ordinary sync update, applied on the owner's device the way
 *  the ingest path applies any authorized writer's update: whole. */
function syncToOwner(ownerDoc: Y.Doc, editorDoc: Y.Doc): void {
	Y.applyUpdate(ownerDoc, Y.encodeStateAsUpdate(editorDoc, Y.encodeStateVector(ownerDoc)));
}

const active = (doc: Y.Doc) =>
	resolveCurrentMembers(doc, ENT)
		.filter((member) => member.active)
		.map((member) => member.member);

/** `isShared` in main/index.ts — what decides whether a device syncs the entity. */
const isShared = (doc: Y.Doc) => resolveMembers(doc, ENT).filter((m) => m.active).length > 1;

describe("CHARACTERISATION: an Editor's sync update can change who the members are", () => {
	it("the baseline: owner and editor are the members", () => {
		const { owner, editor, ownerDoc } = sharedPair();
		expect(active(ownerDoc)).toEqual([owner.pub, editor.pub]);
		expect(isShared(ownerDoc)).toBe(true);
	});

	it("she can remove herself, so the owner's device no longer treats the entity as shared", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		const access = getAccessArray(editorDoc);
		access.delete(
			access.toArray().findIndex((entry) => entry.get("member") === editor.pub),
			1,
		);
		syncToOwner(ownerDoc, editorDoc);
		expect(active(ownerDoc)).toEqual([owner.pub]);
		expect(isShared(ownerDoc)).toBe(false);
	});

	it("she can add a stranger as an Editor, with a wrapping key, and the owner's device accepts that stranger as a writer", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		const stranger = person();
		grantAccess(editorDoc, {
			entityId: ENT,
			member: stranger.pub,
			role: AccessRole.Editor,
			signerSecret: editor.secret,
			now: 3,
			x25519: "c3RyYW5nZXIteDI1NTE5LXdyYXBwaW5nLWtleS0zMmI=",
		});
		syncToOwner(ownerDoc, editorDoc);
		expect(active(ownerDoc)).toEqual([owner.pub, editor.pub, stranger.pub]);
		expect(isAuthorizedWriter(ownerDoc, ENT, stranger.key)).toBe(true);
		// The collection cascade (`SharingEngine.#activeMembersWithKeys`) wraps a
		// new child's DEK to every active member that carries an x25519.
		const cascadeRecipients = resolveCurrentMembers(ownerDoc, ENT)
			.filter((member) => member.active && member.x25519 !== null)
			.map((member) => member.member);
		expect(cascadeRecipients).toEqual([stranger.pub]);
	});

	it("she can revoke the owner", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		expect(
			revokeAccess(editorDoc, {
				entityId: ENT,
				member: owner.pub,
				signerSecret: editor.secret,
				now: 3,
			}),
		).toBe(true);
		syncToOwner(ownerDoc, editorDoc);
		expect(active(ownerDoc)).toEqual([editor.pub]);
		expect(isAuthorizedWriter(ownerDoc, ENT, owner.key)).toBe(false);
	});

	it("she can make herself an Owner, which is what authorizes a DEK rotation", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		const install = (doc: Y.Doc) =>
			authorizesWrapInstall({
				entityId: ENT,
				senderKey: editor.key,
				selfPub: owner.key,
				holdsDek: true,
				localDoc: doc,
				decodeMemberKey: base64ToBytes,
			});
		expect(install(ownerDoc)).toBe(false);
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
		syncToOwner(ownerDoc, editorDoc);
		expect(roleOf(ownerDoc, ENT, editor.pub)).toBe(AccessRole.Owner);
		expect(install(ownerDoc)).toBe(true);
	});

	it.todo("a grant or revoke counts only when its signer was an Owner at that point in the log");
	it.todo("an inbound update that deletes or rewrites access entries is refused at ingest");
});
