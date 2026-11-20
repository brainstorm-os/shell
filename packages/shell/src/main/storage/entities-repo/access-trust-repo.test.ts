/**
 * `access_roots` + `access_statements` repo tests (0.16.0 sharing
 * authorization): the root pin is first-wins and survives a reopen, and the
 * statement memory is idempotent, per-entity and bounded.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import {
	ACCESS_STATEMENTS_PER_ENTITY_MAX,
	AccessStatementKind,
	AccessTrustRepository,
} from "./access-trust-repo";

describe("AccessTrustRepository", () => {
	let vaultDir = "";
	let stores: DataStores;
	let repo: AccessTrustRepository;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-access-trust-"));
		stores = new DataStores(vaultDir);
		repo = new AccessTrustRepository(await stores.open("entities"));
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});

	it("pins a root once: a second pin for the same entity is ignored", () => {
		expect(repo.getRoot("ent_a")).toBeNull();
		expect(repo.pinRoot("ent_a", "root-1", 10)).toBe("root-1");
		expect(repo.pinRoot("ent_a", "root-2", 20)).toBe("root-1");
		expect(repo.getRoot("ent_a")).toBe("root-1");
		expect(repo.getRoot("ent_b")).toBeNull();
	});

	it("keeps the pin across a reopen of the vault", async () => {
		repo.pinRoot("ent_a", "root-1", 10);
		stores.close();
		stores = new DataStores(vaultDir);
		repo = new AccessTrustRepository(await stores.open("entities"));
		expect(repo.getRoot("ent_a")).toBe("root-1");
		expect(repo.pinRoot("ent_a", "root-2", 20)).toBe("root-1");
	});

	it("pins a child's container once, and lists what a container holds", () => {
		expect(repo.getContainer("msg_1")).toBeNull();
		expect(repo.pinContainer("msg_1", "chan_a", 10)).toBe("chan_a");
		expect(repo.pinContainer("msg_1", "chan_b", 20)).toBe("chan_a");
		repo.pinContainer("msg_2", "chan_a", 30);
		repo.pinContainer("msg_3", "chan_b", 40);
		expect(repo.listContained("chan_a")).toEqual(["msg_1", "msg_2"]);
		expect(repo.listContained("chan_none")).toEqual([]);
	});

	it("remembers statements idempotently and per entity; a grant and a revoke may share a signature string", () => {
		const grant = { kind: AccessStatementKind.Grant, sig: "sig-1", body: '{"g":1}' };
		const revoke = { kind: AccessStatementKind.Revoke, sig: "sig-1", body: '{"r":1}' };
		repo.remember("ent_a", [grant, revoke], 1);
		repo.remember("ent_a", [{ ...grant, body: '{"g":"rewritten"}' }], 2);
		expect(repo.listStatements("ent_a")).toEqual([grant, revoke]);
		expect(repo.listStatements("ent_b")).toEqual([]);
	});

	it("stops taking statements at the per-entity ceiling, without touching other entities", () => {
		const batch = Array.from({ length: ACCESS_STATEMENTS_PER_ENTITY_MAX + 5 }, (_, i) => ({
			kind: AccessStatementKind.Grant,
			sig: `sig-${i}`,
			body: "{}",
		}));
		repo.remember("ent_a", batch, 1);
		expect(repo.listStatements("ent_a")).toHaveLength(ACCESS_STATEMENTS_PER_ENTITY_MAX);
		repo.remember("ent_b", batch.slice(0, 2), 1);
		expect(repo.listStatements("ent_b")).toHaveLength(2);
	});
});
