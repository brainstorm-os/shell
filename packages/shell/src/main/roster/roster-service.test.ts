/**
 * Roster-service integration (Collab-C6) — the handler over a real entities.db +
 * a real ydoc access record, behind the capability gate. Proves the production
 * path: members() joins the signed access record to resolved profiles, self()/
 * setSelf() round-trip a signed Profile/v1, and the read/write caps fail closed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RosterMember, RosterSelf } from "@brainstorm-os/sdk-types";
import { RosterRole } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import { AccessRole, grantAccess } from "../collab/access-record";
import {
	generateIdentity,
	publicKeyToBase64,
	signPayload as signWith,
} from "../credentials/identity";
import { DataStores } from "../storage/data-stores";
import { YDocStore } from "../storage/ydoc-store";
import type { VaultSession } from "../vault/session";
import {
	ROSTER_READ_CAPABILITY,
	ROSTER_WRITE_CAPABILITY,
	type RosterServiceOptions,
	makeRosterServiceHandler,
} from "./roster-service";

const APP = "io.brainstorm.chat";
const CHANNEL = "ent_channel_1";

function ledgerGranting(held: ReadonlySet<string>): CapabilityLedger {
	return { has: (_app: string, cap: string) => held.has(cap) } as unknown as CapabilityLedger;
}

function envelope(method: string, args: unknown[], caps: string[]): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app: APP,
		service: "roster",
		method,
		args,
		caps,
	};
}

async function makeEnv() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-roster-"));
	const stores = new DataStores(vaultDir);
	const ydocStore = new YDocStore(vaultDir);
	const selfKp = generateIdentity();
	const selfPub = publicKeyToBase64(selfKp.publicKey);
	const session = {
		identity: { publicKeyBase64: selfPub },
		signPayload: (p: Uint8Array) =>
			// Reuse the identity module's signer via a fresh import-free closure: the
			// session interface only needs the sovereign signature here.
			signWith(selfKp.secretKey, p),
		ydocStore,
		dataStores: stores,
	} as unknown as VaultSession;
	return { vaultDir, stores, ydocStore, selfKp, selfPub, session };
}

/** Persist a granted member into the channel doc's access record on disk. */
async function grantMemberOnDisk(
	ydocStore: YDocStore,
	granterSecret: Uint8Array,
	member: string,
	role: AccessRole,
): Promise<void> {
	const doc = new Y.Doc();
	grantAccess(doc, { entityId: CHANNEL, member, role, signerSecret: granterSecret, now: 1000 });
	await ydocStore.appendUpdate(CHANNEL, Y.encodeStateAsUpdate(doc));
	doc.destroy();
}

describe("roster service (Collab-C6)", () => {
	let env: Awaited<ReturnType<typeof makeEnv>>;
	const options = (held: string[]): RosterServiceOptions => ({
		getSession: () => env.session,
		getLedger: async () => ledgerGranting(new Set(held)),
		now: () => 2000,
	});

	beforeEach(async () => {
		env = await makeEnv();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("returns just self (owner) for a never-shared channel", async () => {
		const handler = makeRosterServiceHandler(options([ROSTER_READ_CAPABILITY]));
		const members = (await handler(
			envelope("members", [CHANNEL], [ROSTER_READ_CAPABILITY]),
		)) as RosterMember[];
		expect(members).toHaveLength(1);
		expect(members[0]?.pubkey).toBe(env.selfPub);
		expect(members[0]?.isSelf).toBe(true);
		expect(members[0]?.role).toBe(RosterRole.Owner);
		// No profile set yet → name unresolved, fingerprint always present.
		expect(members[0]?.displayName).toBeUndefined();
		expect(members[0]?.fingerprint).toMatch(/^ed25519:[0-9a-f]{16}$/);
	});

	it("self()/setSelf() round-trip a signed display profile", async () => {
		const handler = makeRosterServiceHandler(
			options([ROSTER_READ_CAPABILITY, ROSTER_WRITE_CAPABILITY]),
		);
		const before = (await handler(envelope("self", [], [ROSTER_READ_CAPABILITY]))) as RosterSelf;
		expect(before.displayName).toBe("");

		const saved = (await handler(
			envelope("setSelf", [{ displayName: "  Ada Lovelace  " }], [ROSTER_WRITE_CAPABILITY]),
		)) as RosterSelf;
		expect(saved.displayName).toBe("Ada Lovelace");

		const after = (await handler(envelope("self", [], [ROSTER_READ_CAPABILITY]))) as RosterSelf;
		expect(after.displayName).toBe("Ada Lovelace");

		// The profile now resolves the self row in the member list.
		const members = (await handler(
			envelope("members", [CHANNEL], [ROSTER_READ_CAPABILITY]),
		)) as RosterMember[];
		expect(members[0]?.displayName).toBe("Ada Lovelace");
	});

	it("includes a silent granted member (no name until their profile propagates)", async () => {
		const other = generateIdentity();
		const otherPub = publicKeyToBase64(other.publicKey);
		await grantMemberOnDisk(env.ydocStore, env.selfKp.secretKey, otherPub, AccessRole.Editor);

		const handler = makeRosterServiceHandler(options([ROSTER_READ_CAPABILITY]));
		const members = (await handler(
			envelope("members", [CHANNEL], [ROSTER_READ_CAPABILITY]),
		)) as RosterMember[];
		const pubs = members.map((m) => m.pubkey);
		expect(pubs).toContain(env.selfPub);
		expect(pubs).toContain(otherPub);
		const other_ = members.find((m) => m.pubkey === otherPub);
		expect(other_?.role).toBe(RosterRole.Editor);
		expect(other_?.isSelf).toBe(false);
		expect(other_?.displayName).toBeUndefined();
	});

	it("fails closed (Denied) when roster.read is not held", async () => {
		const handler = makeRosterServiceHandler(options([]));
		await expect(
			handler(envelope("members", [CHANNEL], [ROSTER_READ_CAPABILITY])),
		).rejects.toMatchObject({ name: "Denied" });
		await expect(handler(envelope("self", [], [ROSTER_READ_CAPABILITY]))).rejects.toMatchObject({
			name: "Denied",
		});
	});

	it("fails closed (Denied) on setSelf without roster.write", async () => {
		const handler = makeRosterServiceHandler(options([ROSTER_READ_CAPABILITY]));
		await expect(
			handler(envelope("setSelf", [{ displayName: "x" }], [ROSTER_WRITE_CAPABILITY])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("fails closed (Unavailable) when there is no active vault", async () => {
		const handler = makeRosterServiceHandler({
			getSession: () => null,
			getLedger: async () => ledgerGranting(new Set([ROSTER_READ_CAPABILITY])),
		});
		await expect(
			handler(envelope("members", [CHANNEL], [ROSTER_READ_CAPABILITY])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects an unknown method", async () => {
		const handler = makeRosterServiceHandler(options([ROSTER_READ_CAPABILITY]));
		await expect(handler(envelope("nope", [], []))).rejects.toMatchObject({ name: "Invalid" });
	});
});
