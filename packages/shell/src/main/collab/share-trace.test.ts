/**
 * `hasShareTrace` — can a collaborator's own writes make a shared entity look
 * as if it had never been shared? Every case below edits the access record
 * the way an Editor's client can, syncs that update to the owner, and asks
 * the owner's doc. The grants are the real `grantAccess` / `revokeAccess`.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { generateIdentity, publicKeyToBase64 } from "../credentials/identity";
import { getEntityMetaMap } from "../credentials/member-wraps";
import {
	AccessRole,
	ENTITY_ACCESS_KEY,
	getAccessArray,
	grantAccess,
	resolveCurrentMembers,
	revokeAccess,
} from "./access-record";
import { hasShareTrace } from "./share-trace";

const ENT = "ent_trace_1";

function person() {
	const kp = generateIdentity();
	return { secret: kp.secretKey, pub: publicKeyToBase64(kp.publicKey) };
}

/** An owner's doc shared with one Editor, plus that Editor's synced replica. */
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

/** Ship everything the editor's replica has that the owner's lacks. */
function syncToOwner(ownerDoc: Y.Doc, editorDoc: Y.Doc): void {
	Y.applyUpdate(ownerDoc, Y.encodeStateAsUpdate(editorDoc, Y.encodeStateVector(ownerDoc)));
}

/** What the owner's device reads after a restart: the persisted state alone. */
function reloaded(doc: Y.Doc): Y.Doc {
	const fresh = new Y.Doc();
	Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
	return fresh;
}

const activeKeys = (doc: Y.Doc) =>
	resolveCurrentMembers(doc, ENT)
		.filter((member) => member.active)
		.map((member) => member.member);

describe("hasShareTrace", () => {
	it("is false for a doc nobody else was ever given", () => {
		const owner = person();
		const untouched = new Y.Doc();
		expect(hasShareTrace(untouched, owner.pub)).toBe(false);
		const read = new Y.Doc();
		getAccessArray(read);
		expect(hasShareTrace(read, owner.pub)).toBe(false);
		const selfGranted = new Y.Doc();
		grantAccess(selfGranted, {
			entityId: ENT,
			member: owner.pub,
			role: AccessRole.Owner,
			signerSecret: owner.secret,
			now: 1,
		});
		expect(hasShareTrace(selfGranted, owner.pub)).toBe(false);
		expect(hasShareTrace(reloaded(selfGranted), owner.pub)).toBe(false);
		const body = new Y.Doc();
		body.getText("body").insert(0, "hello");
		body.getText("body").delete(0, 5);
		expect(hasShareTrace(body, owner.pub)).toBe(false);
	});

	it("is true while someone else is in the record, and after the owner revokes them", () => {
		const { owner, editor, ownerDoc } = sharedPair();
		expect(hasShareTrace(ownerDoc, owner.pub)).toBe(true);
		revokeAccess(ownerDoc, {
			entityId: ENT,
			member: editor.pub,
			signerSecret: owner.secret,
			now: 3,
		});
		expect(activeKeys(ownerDoc)).toEqual([owner.pub]);
		expect(hasShareTrace(ownerDoc, owner.pub)).toBe(true);
	});

	it("stays true when the editor deletes her own entry", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		const access = getAccessArray(editorDoc);
		const index = access.toArray().findIndex((entry) => entry.get("member") === editor.pub);
		access.delete(index, 1);
		syncToOwner(ownerDoc, editorDoc);
		expect(activeKeys(ownerDoc)).toEqual([owner.pub]);
		expect(hasShareTrace(ownerDoc, owner.pub)).toBe(true);
		expect(hasShareTrace(reloaded(ownerDoc), owner.pub)).toBe(true);
	});

	it("stays true when the editor deletes every entry", () => {
		const { owner, ownerDoc, editorDoc } = sharedPair();
		const access = getAccessArray(editorDoc);
		access.delete(0, access.length);
		syncToOwner(ownerDoc, editorDoc);
		expect(activeKeys(ownerDoc)).toEqual([]);
		expect(hasShareTrace(ownerDoc, owner.pub)).toBe(true);
		expect(hasShareTrace(reloaded(ownerDoc), owner.pub)).toBe(true);
	});

	it("stays true when the editor swaps the whole record for an empty one, or removes it", () => {
		const swapped = sharedPair();
		getEntityMetaMap(swapped.editorDoc).set(ENTITY_ACCESS_KEY, new Y.Array());
		syncToOwner(swapped.ownerDoc, swapped.editorDoc);
		expect(activeKeys(swapped.ownerDoc)).toEqual([]);
		expect(hasShareTrace(swapped.ownerDoc, swapped.owner.pub)).toBe(true);
		expect(hasShareTrace(reloaded(swapped.ownerDoc), swapped.owner.pub)).toBe(true);

		const removed = sharedPair();
		getEntityMetaMap(removed.editorDoc).delete(ENTITY_ACCESS_KEY);
		syncToOwner(removed.ownerDoc, removed.editorDoc);
		expect(hasShareTrace(removed.ownerDoc, removed.owner.pub)).toBe(true);
		expect(hasShareTrace(reloaded(removed.ownerDoc), removed.owner.pub)).toBe(true);

		const scalar = sharedPair();
		getEntityMetaMap(scalar.editorDoc).set(ENTITY_ACCESS_KEY, "gone");
		syncToOwner(scalar.ownerDoc, scalar.editorDoc);
		expect(hasShareTrace(reloaded(scalar.ownerDoc), scalar.owner.pub)).toBe(true);
	});

	it("stays true when the editor rewrites her entry to name the owner", () => {
		const { owner, editor, ownerDoc, editorDoc } = sharedPair();
		for (const entry of getAccessArray(editorDoc).toArray()) {
			if (entry.get("member") !== editor.pub) continue;
			entry.set("member", owner.pub);
			entry.set("addedBy", owner.pub);
		}
		syncToOwner(ownerDoc, editorDoc);
		const raw = getAccessArray(ownerDoc).toArray();
		expect(raw.every((entry) => entry.get("member") === owner.pub)).toBe(true);
		expect(hasShareTrace(ownerDoc, owner.pub)).toBe(true);
		expect(hasShareTrace(reloaded(ownerDoc), owner.pub)).toBe(true);
	});

	it("stays true for a record the owner did not write, whatever it claims", () => {
		const owner = person();
		const stranger = person();
		const doc = new Y.Doc();
		grantAccess(doc, {
			entityId: ENT,
			member: owner.pub,
			role: AccessRole.Owner,
			signerSecret: stranger.secret,
			now: 1,
		});
		expect(hasShareTrace(doc, owner.pub)).toBe(true);
	});
});
