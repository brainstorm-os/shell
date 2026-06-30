/**
 * Collection-sharing cascade (Collab-C5, design 71) — owner-side proof.
 *
 * `shareCollection` must share the container AND cascade the same grant +
 * per-entity DEK-wrap onto every existing child, so each child becomes an
 * ordinary shared entity the always-on `LiveSyncEngine` will sync. This drives
 * a real `SharingEngine` over a persisted `YDocStore`: provision a channel + its
 * messages, share the collection with a second identity, and assert every
 * message (but no other channel's) now carries the invitee's active grant — with
 * the invitee's X25519 recorded in the signed grant (so a later child cascade
 * can wrap to them authentically). Cross-vault convergence of cascaded children
 * rides the production `LiveSyncEngine` inbox path; this test pins the cascade
 * mechanism itself, deterministically and owner-side.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MESSAGE_TYPE_URL } from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { AccessRole, resolveCurrentMembers } from "./access-record";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

const CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const CHANNEL = "ent_channel_general";
const OTHER_CHANNEL = "ent_channel_random";

function relayAdapter(port: LoopbackRelayPort): CollabRelayLike {
	return {
		currentPort: (): RelayPort => port,
		onFrame: (cb) => port.onFrame(cb),
		offFrame: (cb) => port.offFrame(cb),
	};
}

describe("SharingEngine.shareCollection — cascade onto a channel's messages", () => {
	let dirOwner = "";
	let dirGuest = "";
	let owner: VaultSession;
	let guest: VaultSession;
	let ports: LoopbackRelayPort[];
	let engine: SharingEngine;

	beforeEach(async () => {
		dirOwner = await mkdtemp(join(tmpdir(), "bs-coll-owner-"));
		dirGuest = await mkdtemp(join(tmpdir(), "bs-coll-guest-"));
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
		ports = LoopbackRelayPort.pair(2);
		const p0 = ports[0];
		if (!p0) throw new Error("expected a loopback port");
		engine = new SharingEngine(owner, () => relayAdapter(p0));
	});

	afterEach(async () => {
		for (const p of ports) p.close();
		owner.dispose();
		guest.dispose();
		await rm(dirOwner, { recursive: true, force: true });
		await rm(dirGuest, { recursive: true, force: true });
	});

	async function activeMemberKeys(entityId: string): Promise<string[]> {
		const { doc } = await owner.ydocStore.load(entityId);
		try {
			return resolveCurrentMembers(doc, entityId)
				.filter((m) => m.active)
				.map((m) => m.member)
				.sort();
		} finally {
			doc.destroy();
		}
	}

	it("grants the invitee on the channel AND every message in it, but not other channels'", async () => {
		await engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		await engine.provisionEntity("msg_1", MESSAGE_TYPE_URL, { conversation: CHANNEL, body: "hi" });
		await engine.provisionEntity("msg_2", MESSAGE_TYPE_URL, { conversation: CHANNEL, body: "team" });
		await engine.provisionEntity(OTHER_CHANNEL, CHANNEL_TYPE, { name: "random" });
		await engine.provisionEntity("msg_other", MESSAGE_TYPE_URL, { conversation: OTHER_CHANNEL });

		const guestEngine = new SharingEngine(guest, () => relayAdapter(ports[1] as LoopbackRelayPort));
		const invite = guestEngine.createInvite("Guest");
		const guestPub = guest.identity.publicKeyBase64;

		await engine.shareCollection({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		// The channel and BOTH of its messages now carry the guest as active.
		expect(await activeMemberKeys(CHANNEL)).toContain(guestPub);
		expect(await activeMemberKeys("msg_1")).toContain(guestPub);
		expect(await activeMemberKeys("msg_2")).toContain(guestPub);
		// A message in a different channel is untouched.
		expect(await activeMemberKeys("msg_other")).not.toContain(guestPub);
	});

	it("records the invitee's X25519 in each cascaded grant (so a later child cascade can wrap to them)", async () => {
		await engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		await engine.provisionEntity("msg_1", MESSAGE_TYPE_URL, { conversation: CHANNEL });

		const guestEngine = new SharingEngine(guest, () => relayAdapter(ports[1] as LoopbackRelayPort));
		const invite = guestEngine.createInvite("Guest");
		const guestPub = guest.identity.publicKeyBase64;

		await engine.shareCollection({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		const { doc } = await owner.ydocStore.load("msg_1");
		try {
			const guestMember = resolveCurrentMembers(doc, "msg_1").find((m) => m.member === guestPub);
			expect(guestMember?.active).toBe(true);
			expect(guestMember?.role).toBe(AccessRole.Editor);
			expect(guestMember?.x25519).toBe(invite.x25519PubB64);
		} finally {
			doc.destroy();
		}
	});

	it("auto-shares a child created AFTER the share to the channel's existing members (the keystone)", async () => {
		// Share an EMPTY channel with the guest first.
		await engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		const guestEngine = new SharingEngine(guest, () => relayAdapter(ports[1] as LoopbackRelayPort));
		const invite = guestEngine.createInvite("Guest");
		const guestPub = guest.identity.publicKeyBase64;
		await engine.shareCollection({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		// A new message arrives AFTER the share — the create-hook would call this.
		await engine.provisionEntity("msg_late", MESSAGE_TYPE_URL, {
			conversation: CHANNEL,
			body: "after",
		});
		const count = await engine.autoShareNewChild("msg_late", MESSAGE_TYPE_URL, CHANNEL);

		expect(count).toBe(1); // the one guest member (self is excluded)
		const { doc } = await owner.ydocStore.load("msg_late");
		try {
			const guestMember = resolveCurrentMembers(doc, "msg_late").find((m) => m.member === guestPub);
			expect(guestMember?.active).toBe(true);
			expect(guestMember?.role).toBe(AccessRole.Editor);
		} finally {
			doc.destroy();
		}
	});

	it("recascadeCollection delivers children a member is still missing (deferred re-cascade)", async () => {
		await engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "general" });
		await engine.provisionEntity("msg_1", MESSAGE_TYPE_URL, { conversation: CHANNEL });
		const guestEngine = new SharingEngine(guest, () => relayAdapter(ports[1] as LoopbackRelayPort));
		const invite = guestEngine.createInvite("Guest");
		const guestPub = guest.identity.publicKeyBase64;
		await engine.shareCollection({
			entityId: CHANNEL,
			type: CHANNEL_TYPE,
			invite,
			role: AccessRole.Editor,
		});

		// A message provisioned WITHOUT an auto-share (e.g. created while the member
		// was unsynced) — the guest is not on it yet.
		await engine.provisionEntity("msg_2", MESSAGE_TYPE_URL, { conversation: CHANNEL });
		const { doc: before } = await owner.ydocStore.load("msg_2");
		try {
			expect(resolveCurrentMembers(before, "msg_2").some((m) => m.member === guestPub)).toBe(false);
		} finally {
			before.destroy();
		}

		// The deferred re-cascade pushes every existing child to current members.
		await engine.recascadeCollection(CHANNEL, CHANNEL_TYPE);

		const { doc: after } = await owner.ydocStore.load("msg_2");
		try {
			expect(resolveCurrentMembers(after, "msg_2").find((m) => m.member === guestPub)?.active).toBe(
				true,
			);
		} finally {
			after.destroy();
		}
	});

	it("auto-share is a no-op on a solo (unshared) container", async () => {
		await engine.provisionEntity(CHANNEL, CHANNEL_TYPE, { name: "solo" });
		await engine.provisionEntity("msg_solo", MESSAGE_TYPE_URL, { conversation: CHANNEL });
		expect(await engine.autoShareNewChild("msg_solo", MESSAGE_TYPE_URL, CHANNEL)).toBe(0);
	});

	it("a single-entity collection (no containment rule) shares only itself", async () => {
		await engine.provisionEntity("ent_note", "brainstorm/Note/v1", { name: "Solo" });
		const guestEngine = new SharingEngine(guest, () => relayAdapter(ports[1] as LoopbackRelayPort));
		const invite = guestEngine.createInvite("Guest");
		// No throw, shares the note itself; nothing to cascade.
		const view = await engine.shareCollection({
			entityId: "ent_note",
			type: "brainstorm/Note/v1",
			invite,
			role: AccessRole.Viewer,
		});
		expect(view.some((m) => m.member === guest.identity.publicKeyBase64 && m.active)).toBe(true);
	});
});
