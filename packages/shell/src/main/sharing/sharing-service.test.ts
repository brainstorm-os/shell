/**
 * Collab-C5 — the production `sharing` broker service, end to end.
 *
 * Drives the OWNER side entirely through the capability-gated service handler
 * (envelope in → result out), against two real `VaultSession`s over a loopback
 * relay. The collaborator mints its invite through ITS OWN service (token
 * round-trip) and receives via a `CollabDevBridge` standing in for the
 * production `LiveSyncEngine` receiver. Asserts: the share grants + delivers
 * (collaborator converges, decrypts, is active), revoke retains the audit, the
 * scarce `sharing.share` cap is re-checked server-side, a tampered invite token
 * is rejected, and `refreshMembership` fires so live-sync picks the entity up.
 */

import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShareInviteToken, SharedContact, SharedMember } from "@brainstorm/sdk-types";
import { RosterRole } from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import { CollabDevBridge, type CollabRelayLike } from "../collab/collab-dev-bridge";
import { ContactsStore, contactsStorePath } from "../collab/contacts-store";
import { EntitiesRepository } from "../storage/entities-repo";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import {
	SHARING_SHARE_CAPABILITY,
	type SharingServiceOptions,
	makeSharingServiceHandler,
} from "./sharing-service";

const ENTITY_ID = "ent_sharing_svc";
const ENTITY_TYPE = "brainstorm/Note/v1";
const APP = "io.brainstorm.notes";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

function envelope(method: string, args: unknown[]): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: `m_${method}`,
		app: APP,
		service: "sharing",
		method,
		args,
		caps: [],
	};
}

/** A fake ledger that grants exactly `held`. */
function fakeLedger(held: ReadonlySet<string>): CapabilityLedger {
	return { has: (_app: string, cap: string) => held.has(cap) } as unknown as CapabilityLedger;
}

async function awaitConverged(
	a: CollabDevBridge,
	b: CollabDevBridge,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const va = Buffer.from(await a.stateVector(ENTITY_ID)).toString("hex");
		const vb = Buffer.from(await b.stateVector(ENTITY_ID)).toString("hex");
		if (va === vb) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`sharing-service: ${ENTITY_ID} did not converge within ${timeoutMs}ms`);
}

describe("Collab-C5 — sharing broker service", () => {
	let dirOwner: string;
	let dirGuest: string;
	let owner: VaultSession;
	let guest: VaultSession;
	let portOwner: LoopbackRelayPort;
	let portGuest: LoopbackRelayPort;
	let ownerBridge: CollabDevBridge;
	let guestBridge: CollabDevBridge;
	let refreshSpy: ReturnType<typeof vi.fn<(id: string, type: string) => void>>;
	let ownerHandler: ReturnType<typeof makeSharingServiceHandler>;
	let guestHandler: ReturnType<typeof makeSharingServiceHandler>;

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-c5-owner-"));
		dirGuest = await mkdtemp(join(tmpdir(), "bs-c5-guest-"));
		owner = await VaultSession.create({
			vaultId: "vlt_owner",
			vaultPath: dirOwner,
			forceInsecure: true,
		});
		guest = await VaultSession.create({
			vaultId: "vlt_guest",
			vaultPath: dirGuest,
			forceInsecure: true,
		});
		const ports = LoopbackRelayPort.pair(2);
		const a = ports[0];
		const b = ports[1];
		if (!a || !b) throw new Error("expected two loopback ports");
		portOwner = a;
		portGuest = b;
		ownerBridge = new CollabDevBridge(owner, () => relayAdapter(portOwner));
		guestBridge = new CollabDevBridge(guest, () => relayAdapter(portGuest));
		refreshSpy = vi.fn<(id: string, type: string) => void>();
		const ownerOpts: SharingServiceOptions = {
			getSession: () => owner,
			getRelay: () => relayAdapter(portOwner),
			refreshMembership: refreshSpy,
			getContactsStore: async () => new ContactsStore({ path: contactsStorePath(dirOwner) }),
		};
		ownerHandler = makeSharingServiceHandler(ownerOpts);
		guestHandler = makeSharingServiceHandler({
			getSession: () => guest,
			getRelay: () => relayAdapter(portGuest),
		});
	});

	afterEach(async () => {
		ownerBridge.dispose();
		guestBridge.dispose();
		portOwner.close();
		portGuest.close();
		owner.dispose();
		guest.dispose();
		await rm(dirOwner, { recursive: true, force: true });
		await rm(dirGuest, { recursive: true, force: true });
	});

	it("shares through the service: guest mints a token, owner grants, guest converges + is active; revoke retains the audit", async () => {
		const relayFrames: Uint8Array[] = [];
		portGuest.onFrame((f) => relayFrames.push(f));

		// Owner provisions the entity + seeds content; both install receivers.
		await ownerBridge.provisionEntity(ENTITY_ID, ENTITY_TYPE);
		await ownerBridge.editText(ENTITY_ID, "Owner: research brief draft. ");
		await guestBridge.installShareReceiver(ENTITY_ID, ENTITY_TYPE);
		await ownerBridge.installShareReceiver(ENTITY_ID, ENTITY_TYPE);

		// Guest mints its invite token THROUGH THE SERVICE (token round-trip).
		const token = (await guestHandler(
			envelope("createInvite", ["Guest — designer"]),
		)) as ShareInviteToken;
		expect(typeof token).toBe("string");
		expect(token.length).toBeGreaterThan(0);

		// Owner shares THROUGH THE SERVICE.
		const members = (await ownerHandler(
			envelope("share", [
				{ entityId: ENTITY_ID, type: ENTITY_TYPE, invite: token, role: RosterRole.Editor },
			]),
		)) as SharedMember[];

		const ownerB64 = ownerBridge.whoami().userPubB64;
		const guestB64 = guestBridge.whoami().userPubB64;
		expect(members.find((m) => m.pubkey === ownerB64)?.role).toBe(RosterRole.Owner);
		const guestGrant = members.find((m) => m.pubkey === guestB64);
		expect(guestGrant?.role).toBe(RosterRole.Editor);
		expect(guestGrant?.active).toBe(true);

		// refreshMembership fired so live-sync would pick up the now-shared entity.
		expect(refreshSpy).toHaveBeenCalledWith(ENTITY_ID, ENTITY_TYPE);

		// Guest receives the wrap + doc state, converges, can read it.
		await awaitConverged(ownerBridge, guestBridge);
		expect(await guestBridge.readText(ENTITY_ID)).toContain("research brief draft");

		// `access` through the service reflects the active grant.
		const access = (await ownerHandler(envelope("access", [ENTITY_ID]))) as SharedMember[];
		expect(access.find((m) => m.pubkey === guestB64)?.active).toBe(true);

		// Owner revokes THROUGH THE SERVICE — audit retained.
		const afterRevoke = (await ownerHandler(
			envelope("revoke", [{ entityId: ENTITY_ID, type: ENTITY_TYPE, member: guestB64 }]),
		)) as SharedMember[];
		const revoked = afterRevoke.find((m) => m.pubkey === guestB64);
		expect(revoked?.active).toBe(false);
		expect(revoked?.revokedAt).not.toBeNull();

		// Blind relay: no frame carried the plaintext seed text.
		const probe = Buffer.from("research brief draft", "utf8");
		for (const f of relayFrames) {
			expect(Buffer.from(f).includes(probe)).toBe(false);
		}
	});

	it("shareCollection cascades the grant onto the channel's messages (through the service)", async () => {
		const CHANNEL = "ent_chan_svc";
		const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
		const MSG = "ent_msg_svc";
		const MESSAGE_TYPE = "brainstorm/Message/v1";
		await ownerBridge.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		await ownerBridge.provisionEntity(MSG, MESSAGE_TYPE, { conversation: CHANNEL, body: "hi team" });

		const token = (await guestHandler(envelope("createInvite", ["Guest"]))) as ShareInviteToken;
		const members = (await ownerHandler(
			envelope("shareCollection", [
				{ entityId: CHANNEL, type: CHANNEL_TYPE, invite: token, role: RosterRole.Editor },
			]),
		)) as SharedMember[];

		const guestB64 = guestBridge.whoami().userPubB64;
		// The container carries the guest as an active Editor...
		expect(members.find((m) => m.pubkey === guestB64)?.active).toBe(true);
		// ...and so does the message, via the cascade (owner-side access record).
		const msgAccess = (await ownerHandler(envelope("access", [MSG]))) as SharedMember[];
		expect(msgAccess.find((m) => m.pubkey === guestB64)?.active).toBe(true);
		expect(msgAccess.find((m) => m.pubkey === guestB64)?.role).toBe(RosterRole.Editor);
		expect(refreshSpy).toHaveBeenCalledWith(CHANNEL, CHANNEL_TYPE);
	});

	it("saves a contact then shares a collection by name — no pasted code at share time", async () => {
		const CHANNEL = "ent_chan_byname";
		const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
		const MSG = "ent_msg_byname";
		const MESSAGE_TYPE = "brainstorm/Message/v1";
		await ownerBridge.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		await ownerBridge.provisionEntity(MSG, MESSAGE_TYPE, { conversation: CHANNEL });

		// Guest hands over their invite code once; owner saves it under a name.
		const token = (await guestHandler(envelope("createInvite", ["Guest"]))) as ShareInviteToken;
		const saved = (await ownerHandler(
			envelope("saveContact", [{ invite: token, displayName: "Marcus" }]),
		)) as SharedContact;
		const guestB64 = guestBridge.whoami().userPubB64;
		expect(saved).toEqual({ pubkey: guestB64, displayName: "Marcus" });

		// The picker lists them by name.
		const contacts = (await ownerHandler(envelope("listContacts", []))) as SharedContact[];
		expect(contacts).toEqual([{ pubkey: guestB64, displayName: "Marcus" }]);

		// Share the channel BY CONTACT (no token) — the cascade still reaches the message.
		const members = (await ownerHandler(
			envelope("shareCollection", [
				{ entityId: CHANNEL, type: CHANNEL_TYPE, contact: guestB64, role: RosterRole.Editor },
			]),
		)) as SharedMember[];
		expect(members.find((m) => m.pubkey === guestB64)?.active).toBe(true);
		const msgAccess = (await ownerHandler(envelope("access", [MSG]))) as SharedMember[];
		expect(msgAccess.find((m) => m.pubkey === guestB64)?.active).toBe(true);
	});

	it("re-checks the scarce sharing.share capability server-side (fail-closed)", async () => {
		const token = (await guestHandler(envelope("createInvite", ["Guest"]))) as ShareInviteToken;
		await ownerBridge.provisionEntity(ENTITY_ID, ENTITY_TYPE);

		// A handler whose ledger does NOT grant `sharing.share` → Denied.
		const denied = makeSharingServiceHandler({
			getSession: () => owner,
			getRelay: () => relayAdapter(portOwner),
			getLedger: async () => fakeLedger(new Set(["sharing.read"])),
		});
		await expect(
			denied(
				envelope("share", [
					{ entityId: ENTITY_ID, type: ENTITY_TYPE, invite: token, role: RosterRole.Editor },
				]),
			),
		).rejects.toMatchObject({ name: "Denied" });

		// With the grant present, the same share is admitted.
		const granted = makeSharingServiceHandler({
			getSession: () => owner,
			getRelay: () => relayAdapter(portOwner),
			getLedger: async () => fakeLedger(new Set([SHARING_SHARE_CAPABILITY])),
		});
		const members = (await granted(
			envelope("share", [
				{ entityId: ENTITY_ID, type: ENTITY_TYPE, invite: token, role: RosterRole.Editor },
			]),
		)) as SharedMember[];
		expect(members.find((m) => m.pubkey === guestBridge.whoami().userPubB64)?.active).toBe(true);
	});

	it("rejects a tampered invite token with Invalid", async () => {
		await ownerBridge.provisionEntity(ENTITY_ID, ENTITY_TYPE);
		const token = (await guestHandler(envelope("createInvite", ["Guest"]))) as ShareInviteToken;
		// Flip the label inside the signed bundle — signature no longer verifies.
		const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		decoded.label = "Attacker";
		const tampered = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
		await expect(
			ownerHandler(
				envelope("share", [
					{ entityId: ENTITY_ID, type: ENTITY_TYPE, invite: tampered, role: RosterRole.Editor },
				]),
			),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("bootstraps the owner's own Owner grant when sharing an entity with no prior access record", async () => {
		// Seed a normal entity (row + DEK) the way `entities.create` does — NO
		// access record yet, unlike the dev bridge's `provisionEntity`.
		const dekStore = await owner.entityDekStore();
		const repo = new EntitiesRepository(await owner.dataStores.open("entities"));
		const dekId = dekStore.nextDekId();
		repo.transaction(() => {
			repo.create({
				id: ENTITY_ID,
				type: ENTITY_TYPE,
				properties: { name: ENTITY_ID },
				createdBy: owner.identity.publicKeyBase64,
				now: Date.now(),
				dekId,
			});
			const h = dekStore.persist(ENTITY_ID, dekId);
			dekStore.close(h.dek);
		});

		const token = (await guestHandler(envelope("createInvite", ["Guest"]))) as ShareInviteToken;
		const members = (await ownerHandler(
			envelope("share", [
				{ entityId: ENTITY_ID, type: ENTITY_TYPE, invite: token, role: RosterRole.Editor },
			]),
		)) as SharedMember[];

		// Both the owner (Owner) and the guest (Editor) are active — two members,
		// so LiveSyncEngine's `isShared` (>1) will track + sync the entity.
		const ownerB64 = ownerBridge.whoami().userPubB64;
		const guestB64 = guestBridge.whoami().userPubB64;
		expect(members.find((m) => m.pubkey === ownerB64)).toMatchObject({
			role: RosterRole.Owner,
			active: true,
		});
		expect(members.find((m) => m.pubkey === guestB64)).toMatchObject({
			role: RosterRole.Editor,
			active: true,
		});
		expect(members.filter((m) => m.active).length).toBe(2);
	});
});
