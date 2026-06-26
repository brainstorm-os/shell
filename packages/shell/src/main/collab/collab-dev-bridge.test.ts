/**
 * Collab-C4-live core — the persisted, relay-driven share flow end to end.
 *
 * Where C3 (`two-user-share.test.ts`) drives the in-memory `CollabLink`, this
 * drives the production-shaped `CollabDevBridge`: docs are loaded/persisted via
 * `YDocStore` and frames ride a `RelayPort`, exactly as the two shells will in
 * the live dogfood tier. Two real `VaultSession`s with distinct sovereign
 * identities share a Note over a loopback relay pair, both co-edit to
 * convergence through the persisted store, the owner revokes — and the relay
 * carries ciphertext throughout.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { AccessRole } from "./access-record";
import { CollabDevBridge, type CollabRelayLike } from "./collab-dev-bridge";

const ENTITY_ID = "ent_collab_live";
const ENTITY_TYPE = "brainstorm/Note/v1";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

async function awaitConverged(
	a: CollabDevBridge,
	b: CollabDevBridge,
	entityId: string,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const va = Buffer.from(await a.stateVector(entityId)).toString("hex");
		const vb = Buffer.from(await b.stateVector(entityId)).toString("hex");
		if (va === vb) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`collab-dev-bridge: ${entityId} did not converge within ${timeoutMs}ms`);
}

describe("Collab-C4-live — persisted relay-driven share + co-edit + revoke", () => {
	let dirMira: string;
	let dirMarcus: string;
	let mira: VaultSession;
	let marcus: VaultSession;
	let portMira: LoopbackRelayPort;
	let portMarcus: LoopbackRelayPort;
	let bridgeMira: CollabDevBridge;
	let bridgeMarcus: CollabDevBridge;

	beforeEach(async () => {
		dirMira = await mkdtemp(join(tmpdir(), "bs-c4live-mira-"));
		dirMarcus = await mkdtemp(join(tmpdir(), "bs-c4live-marcus-"));
		mira = await VaultSession.create({
			vaultId: "vlt_mira",
			vaultPath: dirMira,
			forceInsecure: true,
		});
		marcus = await VaultSession.create({
			vaultId: "vlt_marcus",
			vaultPath: dirMarcus,
			forceInsecure: true,
		});
		const ports = LoopbackRelayPort.pair(2);
		const a = ports[0];
		const b = ports[1];
		if (!a || !b) throw new Error("expected two loopback ports");
		portMira = a;
		portMarcus = b;
		bridgeMira = new CollabDevBridge(mira, () => relayAdapter(portMira));
		bridgeMarcus = new CollabDevBridge(marcus, () => relayAdapter(portMarcus));
	});

	afterEach(async () => {
		bridgeMira.dispose();
		bridgeMarcus.dispose();
		portMira.close();
		portMarcus.close();
		mira.dispose();
		marcus.dispose();
		await rm(dirMira, { recursive: true, force: true });
		await rm(dirMarcus, { recursive: true, force: true });
	});

	it("Mira shares a Note with Marcus; he becomes an active Editor, both edit to convergence, Mira revokes; relay sees ciphertext", async () => {
		expect(bridgeMira.whoami().userPubB64).not.toBe(bridgeMarcus.whoami().userPubB64);

		// Capture everything the blind relay carries to Marcus.
		const relayFrames: Uint8Array[] = [];
		portMarcus.onFrame((f) => relayFrames.push(f));

		// Owner provisions; both sides install receivers; collaborator mints an
		// invite; owner shares (grant + wrap + encrypted doc state over the wire).
		await bridgeMira.provisionEntity(ENTITY_ID, ENTITY_TYPE);
		await bridgeMira.editText(ENTITY_ID, "Mira: research brief draft. ");
		await bridgeMarcus.installShareReceiver(ENTITY_ID, ENTITY_TYPE);
		await bridgeMira.installShareReceiver(ENTITY_ID, ENTITY_TYPE);

		const invite = bridgeMarcus.createInvite("Marcus — designer");
		const membersAfterShare = await bridgeMira.share({
			entityId: ENTITY_ID,
			type: ENTITY_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		// Owner's view: Mira is Owner, Marcus is an active Editor.
		const marcusB64 = bridgeMarcus.whoami().userPubB64;
		const miraB64 = bridgeMira.whoami().userPubB64;
		expect(membersAfterShare.find((m) => m.member === miraB64)?.role).toBe(AccessRole.Owner);
		const marcusGrant = membersAfterShare.find((m) => m.member === marcusB64);
		expect(marcusGrant?.role).toBe(AccessRole.Editor);
		expect(marcusGrant?.active).toBe(true);

		// Marcus receives the wrap + doc state and converges on the shared content.
		await awaitConverged(bridgeMira, bridgeMarcus, ENTITY_ID);
		expect(await bridgeMarcus.readText(ENTITY_ID)).toContain("research brief draft");
		const marcusAccess = await bridgeMarcus.access(ENTITY_ID);
		expect(marcusAccess.find((m) => m.member === marcusB64)?.active).toBe(true);

		// Concurrent bidirectional editing → convergence.
		await bridgeMira.editText(ENTITY_ID, "[mira edit]");
		await bridgeMarcus.editText(ENTITY_ID, "[marcus edit]");
		await awaitConverged(bridgeMira, bridgeMarcus, ENTITY_ID);
		const miraText = await bridgeMira.readText(ENTITY_ID);
		expect(await bridgeMarcus.readText(ENTITY_ID)).toBe(miraText);
		expect(miraText).toContain("[mira edit]");
		expect(miraText).toContain("[marcus edit]");

		// Mira revokes Marcus — append-only audit; the revoke propagates as an update.
		expect(await bridgeMira.revoke(ENTITY_ID, marcusB64)).toBe(true);
		await awaitConverged(bridgeMira, bridgeMarcus, ENTITY_ID);
		const afterRevoke = await bridgeMarcus.access(ENTITY_ID);
		const revokedEntry = afterRevoke.find((m) => m.member === marcusB64);
		expect(revokedEntry?.active).toBe(false);
		expect(revokedEntry?.revokedAt).not.toBeNull();

		// Blind relay: no frame body held the plaintext DEK or any plaintext text.
		const dekHandle = (await mira.entityDekStore()).open(ENTITY_ID);
		if (!dekHandle) throw new Error("expected owner DEK still present");
		const dekHex = Buffer.from(dekHandle.dek).toString("hex");
		(await mira.entityDekStore()).close(dekHandle.dek);
		for (const frame of relayFrames) {
			const hex = Buffer.from(frame).toString("hex");
			expect(hex.includes(dekHex)).toBe(false);
			expect(hex.includes(Buffer.from("research brief draft", "utf8").toString("hex"))).toBe(false);
			expect(hex.includes(Buffer.from("[marcus edit]", "utf8").toString("hex"))).toBe(false);
		}
	});

	it("Marcus receives live edits on TWO entities shared at once (multi-entity receiver; F-289)", async () => {
		const A = "ent_brief_a";
		const B = "ent_crm_b";

		await bridgeMira.provisionEntity(A, ENTITY_TYPE);
		await bridgeMira.provisionEntity(B, ENTITY_TYPE);
		await bridgeMira.editText(A, "brief A. ");
		await bridgeMira.editText(B, "crm B. ");

		// Both teammates install receivers for BOTH entities. The single-entity
		// receiver detaches A when B is installed, so A never converges (F-289).
		await bridgeMarcus.installShareReceiver(A, ENTITY_TYPE);
		await bridgeMarcus.installShareReceiver(B, ENTITY_TYPE);
		await bridgeMira.installShareReceiver(A, ENTITY_TYPE);
		await bridgeMira.installShareReceiver(B, ENTITY_TYPE);

		await bridgeMira.share({
			entityId: A,
			type: ENTITY_TYPE,
			invite: bridgeMarcus.createInvite("Marcus"),
			role: AccessRole.Editor,
		});
		await bridgeMira.share({
			entityId: B,
			type: ENTITY_TYPE,
			invite: bridgeMarcus.createInvite("Marcus"),
			role: AccessRole.Editor,
		});

		// Marcus converges on BOTH shared docs and receives LIVE edits to each.
		await awaitConverged(bridgeMira, bridgeMarcus, A);
		await awaitConverged(bridgeMira, bridgeMarcus, B);
		await bridgeMira.editText(A, "[a live] ");
		await bridgeMira.editText(B, "[b live] ");
		await awaitConverged(bridgeMira, bridgeMarcus, A);
		await awaitConverged(bridgeMira, bridgeMarcus, B);
		expect(await bridgeMarcus.readText(A)).toContain("[a live]");
		expect(await bridgeMarcus.readText(B)).toContain("[b live]");
	});
});
