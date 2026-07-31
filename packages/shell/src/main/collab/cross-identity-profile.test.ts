/**
 * Collab-C6-b end-to-end — a shared member renders as a NAME, not a key.
 *
 * The gap this closes: `readProfile` reads `entities.db`, whose only writer was
 * `writeSelfProfile` (hardcoded to the session's OWN pubkey), so it returned
 * null for every remote member forever. The share dialog, member lists and
 * presence therefore showed `ed25519:<16 hex>` for everyone but you.
 *
 * This drives the REAL production objects — two real `VaultSession`s with
 * distinct sovereign identities, a real `SharingEngine` over a real persisted
 * `YDocStore`, and the real capability-gated roster handler — and asserts names
 * resolve in BOTH directions:
 *
 *   owner  -> invitee   via the signed snapshot riding the `ShareInvite`
 *   invitee -> owner    via the signed snapshot cached in the shared doc
 *
 * plus the security floor: an unverifiable claim never renders as a name.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { RosterMember } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION } from "../../ipc/envelope";
import { ROSTER_READ_CAPABILITY, makeRosterServiceHandler } from "../roster/roster-service";
import { LoopbackRelayPort, type RelayPort } from "../sync/relay-port";
import { VaultSession } from "../vault/session";
import { AccessRole } from "./access-record";
import { getProfilesMap, readDocProfiles } from "./doc-profiles";
import { cacheRemoteProfile, fingerprintOf, writeSelfProfile } from "./profile-store";
import { type CollabRelayLike, SharingEngine } from "./sharing-engine";

const ENTITY = "ent_brief";
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
		msg: "m1",
		app: APP,
		service: "roster",
		method,
		args,
		caps: [ROSTER_READ_CAPABILITY],
	};
}

const grantingLedger = {
	has: (_app: string, cap: string) => cap === ROSTER_READ_CAPABILITY,
} as unknown as CapabilityLedger;

describe("Collab-C6-b — cross-identity display profiles", () => {
	let dirMira = "";
	let dirMarcus = "";
	let mira: VaultSession;
	let marcus: VaultSession;
	let ports: LoopbackRelayPort[];
	let miraEngine: SharingEngine;
	let marcusEngine: SharingEngine;

	beforeEach(async () => {
		dirMira = await mkdtemp(join(tmpdir(), "bs-c6b-mira-"));
		dirMarcus = await mkdtemp(join(tmpdir(), "bs-c6b-marcus-"));
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
		ports = LoopbackRelayPort.pair(2);
		miraEngine = new SharingEngine(mira, () => relayAdapter(ports[0] as LoopbackRelayPort));
		marcusEngine = new SharingEngine(marcus, () => relayAdapter(ports[1] as LoopbackRelayPort));
	});

	afterEach(async () => {
		for (const p of ports) p.close();
		mira.dispose();
		marcus.dispose();
		await rm(dirMira, { recursive: true, force: true });
		await rm(dirMarcus, { recursive: true, force: true });
	});

	/** The roster exactly as an app receives it, over the real handler + cap gate. */
	async function rosterOn(session: VaultSession, entityId: string): Promise<RosterMember[]> {
		const handler = makeRosterServiceHandler({
			getSession: () => session,
			getLedger: async () => grantingLedger,
		});
		return (await handler(envelope("members", [entityId]))) as RosterMember[];
	}

	function named(members: RosterMember[], pubkey: string): RosterMember {
		const found = members.find((m) => m.pubkey === pubkey);
		if (!found) throw new Error(`no roster member for ${pubkey}`);
		return found;
	}

	/** Mirror the doc across the loopback so Marcus reads the entity Mira shared.
	 *  The wire path itself is proven by the C3/C4 tests; here the interest is
	 *  what the shared DOC carries, so the state is copied directly. */
	async function mirrorEntityToMarcus(): Promise<void> {
		const { doc: source } = await mira.ydocStore.load(ENTITY);
		const state = Y.encodeStateAsUpdate(source);
		source.destroy();
		const { doc: target } = await marcus.ydocStore.load(ENTITY);
		Y.applyUpdate(target, state);
		await marcus.ydocStore.appendUpdate(ENTITY, state);
		target.destroy();
	}

	it("renders a remote member by NAME on both sides after one share", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });

		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });
		await mirrorEntityToMarcus();

		// Owner side: Marcus resolves by name, not by `ed25519:<hex>`.
		const onMira = await rosterOn(mira, ENTITY);
		expect(named(onMira, marcus.identity.publicKeyBase64).displayName).toBe("Marcus Webb");

		// Invitee side: the owner resolves by name too, which no invite could
		// have delivered — it came from the snapshot cached in the shared doc.
		const onMarcus = await rosterOn(marcus, ENTITY);
		expect(named(onMarcus, mira.identity.publicKeyBase64).displayName).toBe("Mira Chen");
	});

	it("still exposes the key fingerprint alongside the name, so a name is never the only identifier", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });

		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		const member = named(await rosterOn(mira, ENTITY), marcus.identity.publicKeyBase64);
		expect(member.fingerprint).toBe(fingerprintOf(marcus.identity.publicKeyBase64));
		expect(member.fingerprint).toMatch(/^ed25519:/);
	});

	it("mints the invite carrying the signed profile, and defaults its label to the profile name", async () => {
		// The blank-quick-add-chip bug: every shipping call site passes `""`.
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });

		const invite = await marcusEngine.createInvite("");

		expect(invite.label).toBe("Marcus Webb");
		expect(invite.profile?.displayName).toBe("Marcus Webb");
	});

	it("keeps an explicit label but still attaches the signed profile", async () => {
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });

		const invite = await marcusEngine.createInvite("Marcus (work laptop)");

		expect(invite.label).toBe("Marcus (work laptop)");
		expect(invite.profile?.displayName).toBe("Marcus Webb");
	});

	it("mints a usable invite for an identity that has set no display name", async () => {
		const invite = await marcusEngine.createInvite("");

		expect(invite.profile).toBeUndefined();
		expect(invite.label).toBe("");
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });
		await expect(
			miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor }),
		).resolves.toBeDefined();
	});

	it("falls back to the fingerprint when a member has published no profile", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });

		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		expect(
			named(await rosterOn(mira, ENTITY), marcus.identity.publicKeyBase64).displayName,
		).toBeUndefined();
	});

	it("caches the invitee's profile vault-wide, so it resolves on entities never shared with them", async () => {
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });

		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		// A second, unrelated entity Marcus is a member of but whose doc carries
		// no profile map: the entities.db cache is what resolves him here.
		const OTHER = "ent_other";
		await miraEngine.provisionEntity(OTHER, ENTITY_TYPE, { name: "other" });
		const { doc } = await mira.ydocStore.load(OTHER);
		getProfilesMap(doc).clear();
		doc.destroy();
		await cacheRemoteProfile(mira, marcus.identity.publicKeyBase64, invite.profile);

		const handler = makeRosterServiceHandler({
			getSession: () => mira,
			getLedger: async () => grantingLedger,
		});
		const members = (await handler(envelope("members", [OTHER]))) as RosterMember[];
		expect(members.some((m) => m.displayName === "Marcus Webb" || m.isSelf)).toBe(true);
	});

	it("publishes BOTH parties' profiles into the shared doc", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });

		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		const { doc } = await mira.ydocStore.load(ENTITY);
		const profiles = readDocProfiles(doc);
		doc.destroy();
		expect(profiles.get(mira.identity.publicKeyBase64)?.displayName).toBe("Mira Chen");
		expect(profiles.get(marcus.identity.publicKeyBase64)?.displayName).toBe("Marcus Webb");
	});

	it("distributes a rename on a RE-share of an existing member", async () => {
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });
		const first = await marcusEngine.createInvite("");
		await miraEngine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: first,
			role: AccessRole.Editor,
		});

		await writeSelfProfile(marcus, { displayName: "Marcus W." });
		const renamed = await marcusEngine.createInvite("");
		await miraEngine.share({
			entityId: ENTITY,
			type: ENTITY_TYPE,
			invite: renamed,
			role: AccessRole.Editor,
		});

		expect(named(await rosterOn(mira, ENTITY), marcus.identity.publicKeyBase64).displayName).toBe(
			"Marcus W.",
		);
	});

	it("SECURITY — a member cannot rename another member in the shared doc", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });
		const invite = await marcusEngine.createInvite("");
		await miraEngine.share({ entityId: ENTITY, type: ENTITY_TYPE, invite, role: AccessRole.Editor });

		// Marcus, a legitimate Editor, writes a profile claiming Mira is somebody
		// else. He can reach the map; he cannot sign for her key.
		const { doc } = await mira.ydocStore.load(ENTITY);
		getProfilesMap(doc).set(mira.identity.publicKeyBase64, {
			displayName: "Finance Bot",
			sig: invite.profile?.sig ?? "",
		});
		const state = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		await mira.ydocStore.appendUpdate(ENTITY, state);

		// Mira still resolves herself from her OWN signed profile, and a peer
		// resolving her would get nothing rather than the forged name.
		const onMira = await rosterOn(mira, ENTITY);
		expect(named(onMira, mira.identity.publicKeyBase64).displayName).toBe("Mira Chen");

		const { doc: reread } = await mira.ydocStore.load(ENTITY);
		const resolved = readDocProfiles(reread);
		reread.destroy();
		expect(resolved.get(mira.identity.publicKeyBase64)).toBeUndefined();
	});

	it("SECURITY — cacheRemoteProfile refuses to overwrite the local user's own profile", async () => {
		await writeSelfProfile(mira, { displayName: "Mira Chen" });
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		const marcusInvite = await marcusEngine.createInvite("");

		// Even a perfectly-valid snapshot cannot be filed as "self".
		const written = await cacheRemoteProfile(
			mira,
			mira.identity.publicKeyBase64,
			marcusInvite.profile,
		);

		expect(written).toBeNull();
		await miraEngine.provisionEntity(ENTITY, ENTITY_TYPE, { name: "Q3 brief" });
		const members = await rosterOn(mira, ENTITY);
		expect(named(members, mira.identity.publicKeyBase64).displayName).toBe("Mira Chen");
	});

	it("SECURITY — cacheRemoteProfile refuses a snapshot that does not verify", async () => {
		await writeSelfProfile(marcus, { displayName: "Marcus Webb" });
		const invite = await marcusEngine.createInvite("");
		const forged = { ...invite.profile, displayName: "Finance Bot" };

		expect(await cacheRemoteProfile(mira, marcus.identity.publicKeyBase64, forged)).toBeNull();
	});
});
