/**
 * Collab-C5-invite-anchor — `share_invites` repo tests.
 *
 * The security-relevant property is the one at the bottom: a spent invite stays
 * spent across a process restart. Single-use enforcement that lives only in
 * memory is not enforcement at all — a relaunch would re-open every invite the
 * vault ever minted.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import { ShareInvitesRepository } from "./share-invites-repo";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function openAt(vaultDir: string) {
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	return { stores, invites: new ShareInvitesRepository(db) };
}

describe("ShareInvitesRepository", () => {
	let vaultDir = "";
	let env: Awaited<ReturnType<typeof openAt>>;

	const pin = (inviteId: string, entityId: string, ownerPubB64: string, now: number) =>
		env.invites.pin({
			inviteId,
			secretB64: "c2VjcmV0",
			memberPubB64: "bWVtYmVy",
			entityId,
			ownerPubB64,
			now,
		});

	const mint = (inviteId: string, over: { expiresAt?: number } = {}) =>
		env.invites.mint({
			inviteId,
			secretB64: "c2VjcmV0",
			memberPubB64: "bWVtYmVy",
			createdAt: NOW,
			expiresAt: over.expiresAt ?? NOW + 7 * DAY,
		});

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-share-invites-"));
		env = await openAt(vaultDir);
	});

	afterEach(async () => {
		env.stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("mint + get round-trips and is idempotent on the same id", () => {
		expect(env.invites.get("inv_a")).toBeNull();
		mint("inv_a");
		mint("inv_a");
		const row = env.invites.get("inv_a");
		expect(row?.inviteId).toBe("inv_a");
		expect(row?.redeemedEntityId).toBeNull();
		expect(env.invites.listOutstanding(NOW)).toHaveLength(1);
	});

	it("pin records the one entity + granter, and the first pin wins", () => {
		mint("inv_a");
		pin("inv_a", "ent_1", "owner_1", NOW);
		pin("inv_a", "ent_2", "owner_2", NOW + 1);
		const row = env.invites.get("inv_a");
		expect(row?.redeemedEntityId).toBe("ent_1");
		expect(row?.redeemedBy).toBe("owner_1");
		expect(row?.redeemedAt).toBe(NOW);
	});

	it("revoke marks once and stops a second mark", () => {
		mint("inv_a");
		expect(env.invites.revoke("inv_a", NOW)).toBe(true);
		expect(env.invites.revoke("inv_a", NOW + 1)).toBe(false);
		expect(env.invites.get("inv_a")?.revokedAt).toBe(NOW);
	});

	it("listOutstanding hides spent, revoked and expired invites", () => {
		mint("inv_live");
		mint("inv_spent");
		mint("inv_revoked");
		mint("inv_expired", { expiresAt: NOW - 1 });
		pin("inv_spent", "ent_1", "owner_1", NOW);
		env.invites.revoke("inv_revoked", NOW);
		expect(env.invites.listOutstanding(NOW).map((r) => r.inviteId)).toEqual(["inv_live"]);
	});

	it("purgeExpired drops only unredeemed rows past the grace window", () => {
		mint("inv_old", { expiresAt: NOW - 30 * DAY });
		mint("inv_recent", { expiresAt: NOW - 1 });
		mint("inv_spent_old", { expiresAt: NOW - 30 * DAY });
		pin("inv_spent_old", "ent_1", "owner_1", NOW);
		expect(env.invites.purgeExpired(NOW, 7 * DAY)).toBe(1);
		expect(env.invites.get("inv_old")).toBeNull();
		expect(env.invites.get("inv_recent")).not.toBeNull();
		expect(
			env.invites.get("inv_spent_old"),
			"a SPENT row is what stops a replay - never purge it",
		).not.toBeNull();
	});

	it("RESTART: a spent invite is still spent after the store is reopened", async () => {
		mint("inv_a");
		pin("inv_a", "ent_1", "owner_1", NOW);
		env.stores.close();

		env = await openAt(vaultDir);
		const row = env.invites.get("inv_a");
		expect(row?.redeemedEntityId).toBe("ent_1");
		expect(row?.redeemedBy).toBe("owner_1");
		expect(env.invites.listOutstanding(NOW)).toEqual([]);
	});
});
