/**
 * Collab-C7 — invite deep links, the default share role, and "last edited by",
 * through the real `sharing` service handler and a real `VaultSession`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	type PendingInvite,
	RosterRole,
	type ShareInviteToken,
	inviteLinkFor,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { LastEditRecorder } from "../collab/last-edit-recorder";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo";
import { SettingsRepository } from "../storage/settings-repo";
import { VaultSession } from "../vault/session";
import {
	InviteOfferOutcome,
	PENDING_INVITE_TTL_MS,
	PendingInviteSlot,
	sanitizeInviteLabel,
} from "./pending-invite";
import { readDefaultShareRole, writeDefaultShareRole } from "./share-defaults";
import { makeSharingServiceHandler } from "./sharing-service";

const APP = "io.brainstorm.notes";
const NOTE = "brainstorm/Note/v1";

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

function ledger(held: string[]): CapabilityLedger {
	return { has: (_app: string, cap: string) => held.includes(cap) } as unknown as CapabilityLedger;
}

describe("Collab-C7", () => {
	let dir: string;
	let session: VaultSession;
	let stores: DataStores;
	let entities: EntitiesRepository;
	let settings: SettingsRepository;
	let token: ShareInviteToken;
	let held: string[];
	const slot = new PendingInviteSlot();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-c7-"));
		session = await VaultSession.create({ vaultId: "vlt_c7", vaultPath: dir, forceInsecure: true });
		stores = new DataStores(join(dir, "stores"));
		entities = new EntitiesRepository(await stores.open("entities"));
		settings = new SettingsRepository(await stores.open("settings"));
		held = ["sharing.read", "sharing.share", `entities.read:${NOTE}`];
		slot.clear();
		const minter = makeSharingServiceHandler({ getSession: () => session, getRelay: () => null });
		token = (await minter(envelope("createInvite", ["Mara"]))) as ShareInviteToken;
	});
	afterEach(async () => {
		stores.close();
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	const handler = () =>
		makeSharingServiceHandler({
			getSession: () => session,
			getRelay: () => null,
			getLedger: async () => ledger(held),
			takePendingInvite: () => slot.take(1_000),
			getSettingsRepo: async () => settings,
			getEntitiesRepo: async () => entities,
		});

	describe("invite deep link slot", () => {
		it("parks a verified invite with who it is from, and hands it over once", () => {
			const { outcome, pending } = slot.offerLink(inviteLinkFor(token), 1_000);
			expect(outcome).toBe(InviteOfferOutcome.Held);
			expect(pending).toMatchObject({ invite: token, receivedAt: 1_000 });
			expect(pending?.fingerprint.startsWith("ed25519:")).toBe(true);
			expect(slot.take(1_001)?.invite).toBe(token);
			expect(slot.take(1_002)).toBeNull();
		});

		it("refuses malformed links and forged invites; nothing reaches the slot", () => {
			const forged = `${token.slice(0, -4)}AAAA`;
			for (const url of [
				`${inviteLinkFor(token)}?auto=1`,
				`${inviteLinkFor(token)}#x`,
				`${inviteLinkFor(token)}/extra`,
				`brainstorm://invite/%41${token}`,
				`brainstorm://INVITE/${token}`,
				"brainstorm://invite/short",
				inviteLinkFor(forged),
				42,
			]) {
				expect(slot.offerLink(url, 1_000)).toEqual({
					outcome: InviteOfferOutcome.Refused,
					pending: null,
				});
			}
			expect(slot.take(1_000)).toBeNull();
		});

		it("a second, different link never silently replaces the waiting one", async () => {
			const minter = makeSharingServiceHandler({ getSession: () => session, getRelay: () => null });
			const other = (await minter(envelope("createInvite", ["Other"]))) as ShareInviteToken;
			expect(slot.offerLink(inviteLinkFor(token), 1_000).outcome).toBe(InviteOfferOutcome.Held);
			expect(slot.offerLink(inviteLinkFor(token), 1_100).outcome).toBe(InviteOfferOutcome.Duplicate);
			const busy = slot.offerLink(inviteLinkFor(other), 1_200);
			expect(busy.outcome).toBe(InviteOfferOutcome.Busy);
			expect(busy.pending?.invite).toBe(token);
			expect(slot.take(1_300)?.invite).toBe(token);
			expect(slot.offerLink(inviteLinkFor(other), 1_400).outcome).toBe(InviteOfferOutcome.Held);
		});

		it("an expired waiting invite gives way to a new link", async () => {
			const minter = makeSharingServiceHandler({ getSession: () => session, getRelay: () => null });
			const other = (await minter(envelope("createInvite", ["Other"]))) as ShareInviteToken;
			slot.offerLink(inviteLinkFor(token), 0);
			expect(slot.offerLink(inviteLinkFor(other), PENDING_INVITE_TTL_MS + 1).outcome).toBe(
				InviteOfferOutcome.Held,
			);
		});

		it("sanitizes the sender-chosen label: no controls, bidi, or fake fingerprints", async () => {
			const minter = makeSharingServiceHandler({ getSession: () => session, getRelay: () => null });
			const spoof = (await minter(
				envelope("createInvite", ["Mara\u202e (ed25519:ab:cd:ef)\u0007"]),
			)) as ShareInviteToken;
			const { pending } = slot.offerLink(inviteLinkFor(spoof), 1_000);
			expect(pending?.label).toBe("Mara ()");
			expect(pending?.label).not.toMatch(/ed25519/i);
			expect(pending?.label).not.toContain("\u202e");
			expect(pending?.label).not.toContain("\u0007");
			expect(sanitizeInviteLabel("x".repeat(500))).toHaveLength(80);
		});

		it("expires an untaken invite", () => {
			slot.offerLink(inviteLinkFor(token), 0);
			expect(slot.take(PENDING_INVITE_TTL_MS + 1)).toBeNull();
		});

		it("sharing.pendingInvite is as scarce as sharing.share and consumes the slot", async () => {
			slot.offerLink(inviteLinkFor(token), 1_000);
			held = ["sharing.read"];
			await expect(handler()(envelope("pendingInvite", []))).rejects.toMatchObject({ name: "Denied" });
			held = ["sharing.read", "sharing.share"];
			const got = (await handler()(envelope("pendingInvite", []))) as PendingInvite | null;
			expect(got?.invite).toBe(token);
			expect(await handler()(envelope("pendingInvite", []))).toBeNull();
		});
	});

	describe("default share role", () => {
		it("is Viewer until widened, and only Viewer / Editor are storable", async () => {
			expect(await handler()(envelope("defaultRole", []))).toBe(RosterRole.Viewer);
			expect(writeDefaultShareRole(settings, RosterRole.Editor)).toBe(RosterRole.Editor);
			expect(await handler()(envelope("defaultRole", []))).toBe(RosterRole.Editor);
			expect(writeDefaultShareRole(settings, RosterRole.Owner)).toBe(RosterRole.Editor);
			expect(writeDefaultShareRole(settings, "admin")).toBe(RosterRole.Editor);
			expect(readDefaultShareRole(null)).toBe(RosterRole.Viewer);
		});
	});

	describe("last edited by", () => {
		beforeEach(() => {
			entities.create({
				id: "n1",
				type: NOTE,
				properties: { title: "Brief" },
				createdBy: APP,
				now: 1,
				dekId: null,
			});
		});

		it("reads the recorded editor, gated on read access to the RESOLVED type", async () => {
			let clock = 10;
			const recorder = new LastEditRecorder(entities.lastEdits, () => clock);
			recorder.note("n1", "AAAA");
			expect(await handler()(envelope("lastEdit", ["n1"]))).toEqual({ editor: "AAAA", editedAt: 10 });
			// A burst from the same editor is throttled; another editor records.
			clock = 11;
			recorder.note("n1", "AAAA");
			expect(entities.lastEdits.get("n1")?.editedAt).toBe(10);
			recorder.note("n1", "BBBB");
			expect(entities.lastEdits.get("n1")?.editor).toBe("BBBB");
			// No read grant on the note type: indistinguishable from unknown.
			held = ["sharing.read"];
			expect(await handler()(envelope("lastEdit", ["n1"]))).toBeNull();
			held = ["sharing.read", `entities.read:${NOTE}`];
			expect(await handler()(envelope("lastEdit", ["missing"]))).toBeNull();
		});

		it("an older timestamp never overwrites a newer edit", () => {
			entities.lastEdits.record("n1", "NEW", 50);
			entities.lastEdits.record("n1", "OLD", 40);
			expect(entities.lastEdits.get("n1")).toMatchObject({ editor: "NEW", editedAt: 50 });
		});
	});
});
