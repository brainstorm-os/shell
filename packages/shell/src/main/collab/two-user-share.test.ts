/**
 * Collab C3 — two-different-users end-to-end share + collaborate.
 *
 * The single explicit end-to-end against real `VaultSession`s, on the C4
 * `CollabLink` harness. Where `sync/new-device-join.test.ts` joins a *second
 * device of the same user*, this joins a *different person*: two vaults with
 * distinct sovereign identities, sharing one entity through the C2 invite flow
 * and then editing it concurrently to convergence — the relay seeing ciphertext
 * throughout. (Richer multi-step scenarios — revoke, roles — live in
 * `collab-scenario.test.ts` on the same harness.)
 */

import { Buffer } from "node:buffer";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import { AccessRole } from "./access-record";
import { CollabLink } from "./collab-harness";

const ENTITY_ID = "ent_share_2u";
const ENTITY_TYPE = "brainstorm/Note/v1";

describe("collab C3 — two different users share + collaborate end to end", () => {
	let dirOwner: string;
	let dirCollab: string;
	let link: CollabLink;

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-c3-owner-"));
		dirCollab = await mkdtemp(join(tmpdir(), "bs-c3-collab-"));
		link = await CollabLink.create({
			owner: { label: "owner", vaultId: "vlt_owner", vaultPath: dirOwner },
			collaborator: { label: "collab", vaultId: "vlt_collab", vaultPath: dirCollab },
		});
	});

	afterEach(async () => {
		await link.dispose();
		await removeTestDir(dirOwner);
		await removeTestDir(dirCollab);
	});

	it("owner shares via invite; collaborator decrypts, is an active member, both edit + converge; relay sees ciphertext", async () => {
		// Distinct sovereign identities — this is the whole point of C3.
		expect(link.owner.userPubB64).not.toBe(link.collaborator.userPubB64);

		const ownerDoc = await link.owner.provisionEntity(ENTITY_ID, ENTITY_TYPE);
		ownerDoc.getText("body").insert(0, "Owner: research brief draft. ");

		// Capture everything the blind relay carries to the collaborator.
		const relayFrames: Uint8Array[] = [];
		link.collaborator.relay.onFrame((f) => relayFrames.push(f));

		// Collaborator mints a self-signed invite; owner grants + wraps + emits;
		// collaborator installs the DEK and receives the encrypted doc state.
		const invite = link.collaborator.invite("Marcus — designer");
		await link.share({ entityId: ENTITY_ID, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		// The grant rode inside the (now-decryptable) doc — the collaborator
		// confirms a real authorization backs the DEK it just installed.
		const collabDoc = link.collaborator.docs.get(ENTITY_ID);
		expect(link.collaborator.isActiveMember(ENTITY_ID, link.collaborator.userPubB64)).toBe(true);
		expect(link.collaborator.roleOf(ENTITY_ID, link.collaborator.userPubB64)).toBe(AccessRole.Editor);
		expect(collabDoc?.getText("body").toString()).toContain("research brief draft");

		// Concurrent bidirectional editing → convergence.
		link.wireLiveSync(ENTITY_ID);
		ownerDoc.getText("body").insert(ownerDoc.getText("body").length, "[owner edit]");
		collabDoc?.getText("body").insert(collabDoc.getText("body").length, "[collab edit]");
		await link.awaitConverged(ENTITY_ID);

		const bodyOwner = ownerDoc.getText("body").toString();
		expect(collabDoc?.getText("body").toString()).toBe(bodyOwner);
		expect(bodyOwner).toContain("[owner edit]");
		expect(bodyOwner).toContain("[collab edit]");

		// Blind relay: no frame body ever held the plaintext DEK or any
		// plaintext body text.
		const dekHandle = link.owner.dekStore.open(ENTITY_ID);
		if (!dekHandle) throw new Error("expected owner DEK still present");
		const dekHex = Buffer.from(dekHandle.dek).toString("hex");
		link.owner.dekStore.close(dekHandle.dek);
		for (const frame of relayFrames) {
			const hex = Buffer.from(frame).toString("hex");
			expect(hex.includes(dekHex)).toBe(false);
			expect(hex.includes(Buffer.from("research brief draft", "utf8").toString("hex"))).toBe(false);
		}
	});
});
