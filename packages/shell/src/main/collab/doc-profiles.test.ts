/**
 * The in-document profile cache (Collab-C6-b). The Y.Map is unprivileged — any
 * doc writer can set any key — so these prove the load-bearing property: a name
 * is only ever READ back when its signature verifies under the pubkey it was
 * filed under, which bounds a malicious member to replaying or deleting genuine
 * self-assertions and never to fabricating one.
 */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { generateIdentity, publicKeyToBase64, signPayload } from "../credentials/identity";
import {
	ENTITY_PROFILES_KEY,
	getProfilesMap,
	publishDocProfile,
	readDocProfile,
	readDocProfiles,
} from "./doc-profiles";
import { signProfileSnapshot } from "./profile-snapshot";

function identity() {
	const kp = generateIdentity();
	return {
		pubkey: publicKeyToBase64(kp.publicKey),
		sign: (payload: Uint8Array) => signPayload(kp.secretKey, payload),
	};
}

function snapshotFor(who: ReturnType<typeof identity>, displayName: string) {
	const snap = signProfileSnapshot({ pubkey: who.pubkey, displayName, sign: who.sign });
	if (!snap) throw new Error("expected a snapshot");
	return snap;
}

describe("publishDocProfile / readDocProfile", () => {
	it("publishes a verified snapshot and reads it back", () => {
		const doc = new Y.Doc();
		const mira = identity();

		expect(publishDocProfile(doc, mira.pubkey, snapshotFor(mira, "Mira Chen"))).toBe(true);
		expect(readDocProfile(doc, mira.pubkey)?.displayName).toBe("Mira Chen");
		doc.destroy();
	});

	it("refuses to publish an unverifiable snapshot at all", () => {
		const doc = new Y.Doc();
		const mira = identity();
		const marcus = identity();
		const miraSnap = snapshotFor(mira, "Mira Chen");

		// Marcus tries to file Mira's genuine snapshot under HIS key.
		expect(publishDocProfile(doc, marcus.pubkey, miraSnap)).toBe(false);
		// Nothing reached the doc, so nothing syncs to peers either.
		expect(getProfilesMap(doc).size).toBe(0);
		doc.destroy();
	});

	it("refuses null / missing snapshots without throwing", () => {
		const doc = new Y.Doc();
		const mira = identity();

		expect(publishDocProfile(doc, mira.pubkey, null)).toBe(false);
		expect(publishDocProfile(doc, mira.pubkey, undefined)).toBe(false);
		doc.destroy();
	});

	it("is idempotent, so a re-share emits no doc delta", () => {
		const doc = new Y.Doc();
		const mira = identity();
		const snap = snapshotFor(mira, "Mira Chen");

		expect(publishDocProfile(doc, mira.pubkey, snap)).toBe(true);
		const before = Y.encodeStateVector(doc);
		expect(publishDocProfile(doc, mira.pubkey, snap)).toBe(false);
		expect(Y.encodeStateAsUpdate(doc, before)).toHaveLength(
			Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc)).length,
		);
		doc.destroy();
	});

	it("publishes a NEW snapshot when the same identity renames itself", () => {
		const doc = new Y.Doc();
		const mira = identity();

		publishDocProfile(doc, mira.pubkey, snapshotFor(mira, "Mira Chen"));
		expect(publishDocProfile(doc, mira.pubkey, snapshotFor(mira, "Mira C."))).toBe(true);
		expect(readDocProfile(doc, mira.pubkey)?.displayName).toBe("Mira C.");
		doc.destroy();
	});

	it("drops a hand-forged map entry written past the publish guard", () => {
		// The real threat model: a malicious member does not call publishDocProfile,
		// they write the Y.Map directly. The READ is what has to hold the line.
		const doc = new Y.Doc();
		const mira = identity();
		const marcus = identity();

		getProfilesMap(doc).set(marcus.pubkey, {
			displayName: "Mira Chen",
			sig: snapshotFor(mira, "Mira Chen").sig,
		});

		expect(readDocProfile(doc, marcus.pubkey)).toBeNull();
		expect(readDocProfiles(doc).size).toBe(0);
		doc.destroy();
	});

	it("drops junk values without throwing", () => {
		const doc = new Y.Doc();
		const mira = identity();
		const map = getProfilesMap(doc);
		map.set(mira.pubkey, "not an object");
		map.set("not-a-pubkey", { displayName: "x", sig: "y" });

		expect(readDocProfiles(doc).size).toBe(0);
		expect(readDocProfile(doc, mira.pubkey)).toBeNull();
		doc.destroy();
	});

	it("reads every verified member and syncs across a Yjs merge", () => {
		const owner = new Y.Doc();
		const peer = new Y.Doc();
		const mira = identity();
		const marcus = identity();

		publishDocProfile(owner, mira.pubkey, snapshotFor(mira, "Mira Chen"));
		publishDocProfile(owner, marcus.pubkey, snapshotFor(marcus, "Marcus Webb"));
		Y.applyUpdate(peer, Y.encodeStateAsUpdate(owner));

		const seen = readDocProfiles(peer);
		expect(seen.get(mira.pubkey)?.displayName).toBe("Mira Chen");
		expect(seen.get(marcus.pubkey)?.displayName).toBe("Marcus Webb");
		owner.destroy();
		peer.destroy();
	});

	it("uses a stable top-level doc key", () => {
		expect(ENTITY_PROFILES_KEY).toBe("profiles");
	});
});
