/**
 * Contacts store (Collab-C5 / C6-d, design 71) — the share-by-name directory.
 *
 * Pins: a verified invite saves + lists + round-trips by name; an unverifiable
 * invite is refused (fail-closed — a contact's wrapping key is only trusted via
 * the signature binding it to their identity); a missing/corrupt file reads as
 * empty; re-adding a pubkey updates the name; a tampered on-disk invite is
 * dropped on read.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesToBase64 } from "../credentials/crypto";
import { generateIdentity } from "../credentials/identity";
import { ContactsStore, contactsStorePath } from "./contacts-store";
import { type ShareInvite, createShareInvite } from "./share-invite";

function inviteFor(label: string): ShareInvite {
	const id = generateIdentity();
	const x25519Pub = new Uint8Array(32);
	crypto.getRandomValues(x25519Pub);
	return createShareInvite({ userSecret: id.secretKey, x25519Pub, label });
}

describe("ContactsStore", () => {
	let vaultDir = "";
	let store: ContactsStore;
	let path = "";

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-contacts-"));
		path = contactsStorePath(vaultDir);
		store = new ContactsStore({ path });
	});

	afterEach(async () => {
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("saves a verified invite and lists it by name", async () => {
		const marcus = inviteFor("Marcus");
		await store.add("Marcus", marcus);
		const list = await store.list();
		expect(list.map((c) => c.displayName)).toEqual(["Marcus"]);
		expect((await store.get(marcus.userPubB64))?.invite.userPubB64).toBe(marcus.userPubB64);
	});

	it("lists contacts display-name-sorted", async () => {
		await store.add("Priya", inviteFor("Priya"));
		await store.add("Marcus", inviteFor("Marcus"));
		expect((await store.list()).map((c) => c.displayName)).toEqual(["Marcus", "Priya"]);
	});

	it("refuses an unverifiable invite (tampered wrapping key)", async () => {
		const real = inviteFor("Mallory");
		const tampered: ShareInvite = { ...real, x25519PubB64: bytesToBase64(new Uint8Array(32)) };
		await expect(store.add("Mallory", tampered)).rejects.toThrow(/verification/);
		expect(await store.list()).toEqual([]);
	});

	it("round-trips across store instances", async () => {
		const marcus = inviteFor("Marcus");
		await store.add("Marcus", marcus);
		const reopened = new ContactsStore({ path });
		expect((await reopened.get(marcus.userPubB64))?.displayName).toBe("Marcus");
	});

	it("re-adding a pubkey updates the display name", async () => {
		const marcus = inviteFor("Marcus");
		await store.add("Marcus", marcus);
		await store.add("Marcus (design)", marcus);
		const list = await store.list();
		expect(list.length).toBe(1);
		expect(list[0]?.displayName).toBe("Marcus (design)");
	});

	it("reads a missing file as empty", async () => {
		expect(await store.list()).toEqual([]);
	});

	it("reads a corrupt file as empty (never throws into the share flow)", async () => {
		await store.add("Marcus", inviteFor("Marcus"));
		await writeFile(path, "{ not json", "utf8");
		expect(await new ContactsStore({ path }).list()).toEqual([]);
	});

	it("drops a tampered on-disk invite on read", async () => {
		const marcus = inviteFor("Marcus");
		await store.add("Marcus", marcus);
		const raw = JSON.parse(await readFile(path, "utf8"));
		raw.contacts[marcus.userPubB64].invite.x25519PubB64 = bytesToBase64(new Uint8Array(32));
		await writeFile(path, JSON.stringify(raw), "utf8");
		expect(await new ContactsStore({ path }).list()).toEqual([]);
	});
});
