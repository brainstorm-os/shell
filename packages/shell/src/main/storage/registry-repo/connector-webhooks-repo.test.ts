import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import { ConnectorWebhooksRepository, sha256Hex } from "./connector-webhooks-repo";

const OWNER = { mappingId: "map-1", accountId: "acct-1", connectorAppId: "io.x.github" };

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-connwh-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const repo = new ConnectorWebhooksRepository(db, () => 1000);
	return { vaultDir, stores, db, repo };
}

describe("ConnectorWebhooksRepository (Connector-6)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		await env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("mints an endpoint and stores ONLY the SHA-256 of the secret", () => {
		const minted = env.repo.mint(OWNER);
		expect(minted.routeId).toMatch(/^cw_/);
		expect(minted.secret.length).toBeGreaterThanOrEqual(32);

		const record = env.repo.getByMapping("map-1");
		expect(record).toMatchObject({
			routeId: minted.routeId,
			mappingId: "map-1",
			accountId: "acct-1",
			connectorAppId: "io.x.github",
			secretSha256: sha256Hex(minted.secret),
			createdAt: 1000,
		});
		// Custody: the plaintext appears nowhere in the persisted row.
		expect(JSON.stringify(record)).not.toContain(minted.secret);
	});

	it("re-mint REPLACES the endpoint (rotation): fresh routeId + secret, old row gone", () => {
		const first = env.repo.mint(OWNER);
		const second = env.repo.mint(OWNER);
		expect(second.routeId).not.toBe(first.routeId);
		expect(second.secret).not.toBe(first.secret);
		expect(env.repo.listAll()).toHaveLength(1);
		expect(env.repo.getByMapping("map-1")?.routeId).toBe(second.routeId);
	});

	it("survives a reopen (restart persistence rides the registry)", async () => {
		const minted = env.repo.mint(OWNER);
		await env.stores.close();
		const stores = new DataStores(env.vaultDir);
		const repo = new ConnectorWebhooksRepository(await stores.open("registry"));
		expect(repo.getByMapping("map-1")?.routeId).toBe(minted.routeId);
		await stores.close();
		env.stores = stores;
	});

	it("revokeByMapping removes exactly that endpoint", () => {
		env.repo.mint(OWNER);
		env.repo.mint({ mappingId: "map-2", accountId: "acct-1", connectorAppId: "io.x.github" });
		expect(env.repo.revokeByMapping("map-1")).toBe(true);
		expect(env.repo.revokeByMapping("map-1")).toBe(false);
		expect(env.repo.getByMapping("map-1")).toBeNull();
		expect(env.repo.getByMapping("map-2")).not.toBeNull();
	});

	it("revokeByAccount kills every endpoint under the account (disconnect cascade)", () => {
		env.repo.mint(OWNER);
		env.repo.mint({ mappingId: "map-2", accountId: "acct-1", connectorAppId: "io.x.github" });
		env.repo.mint({ mappingId: "map-3", accountId: "acct-OTHER", connectorAppId: "io.x.slack" });
		expect(env.repo.revokeByAccount("acct-1")).toBe(2);
		expect(env.repo.listAll().map((r) => r.mappingId)).toEqual(["map-3"]);
	});
});
