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
	ACCESS_STATEMENTS_PER_SIGNER_MAX,
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

	const ROOT = "root-key";
	const grantsFrom = (signer: string, n: number, tag = signer) =>
		Array.from({ length: n }, (_, i) => ({
			kind: AccessStatementKind.Grant,
			sig: `${tag}-g-${i}`,
			body: "{}",
			signer,
		}));

	it("remembers statements idempotently and per entity; a grant and a revoke may share a signature string", () => {
		const grant = { kind: AccessStatementKind.Grant, sig: "sig-1", body: '{"g":1}', signer: ROOT };
		const revoke = { kind: AccessStatementKind.Revoke, sig: "sig-1", body: '{"r":1}', signer: ROOT };
		expect(repo.remember("ent_a", [grant, revoke], 1, ROOT)).toBe(0);
		repo.remember("ent_a", [{ ...grant, body: '{"g":"rewritten"}' }], 2, ROOT);
		expect(repo.listStatements("ent_a")).toEqual([grant, revoke]);
		expect(repo.listStatements("ent_b")).toEqual([]);
	});

	it("bounds what one signer can fill, reports what it refused, and leaves other signers and entities alone", () => {
		const flood = grantsFrom("co-owner", ACCESS_STATEMENTS_PER_SIGNER_MAX + 5);
		expect(repo.remember("ent_a", flood, 1, ROOT)).toBe(5);
		expect(repo.listStatements("ent_a")).toHaveLength(ACCESS_STATEMENTS_PER_SIGNER_MAX);
		expect(repo.remember("ent_a", grantsFrom("other", 3), 2, ROOT)).toBe(0);
		expect(repo.remember("ent_b", flood.slice(0, 2), 2, ROOT)).toBe(0);
	});

	it("always remembers a revoke by the root, whatever else is stored", () => {
		repo.remember("ent_a", grantsFrom(ROOT, ACCESS_STATEMENTS_PER_ENTITY_MAX + 3), 1, ROOT);
		for (let s = 0; s < 20; s++) {
			repo.remember("ent_a", grantsFrom(`signer-${s}`, ACCESS_STATEMENTS_PER_SIGNER_MAX), 1, ROOT);
		}
		const revoke = { kind: AccessStatementKind.Revoke, sig: "root-r-1", body: "{}", signer: ROOT };
		expect(repo.remember("ent_a", [revoke], 2, ROOT)).toBe(0);
		expect(repo.listStatements("ent_a")).toContainEqual(revoke);
	});

	it("a non-root signer at quota keeps a new revoke by giving up one of their own grants", () => {
		repo.remember("ent_a", grantsFrom("co-owner", ACCESS_STATEMENTS_PER_SIGNER_MAX), 1, ROOT);
		const revoke = {
			kind: AccessStatementKind.Revoke,
			sig: "co-r-1",
			body: "{}",
			signer: "co-owner",
		};
		expect(repo.remember("ent_a", [revoke], 2, ROOT)).toBe(0);
		const stored = repo.listStatements("ent_a");
		expect(stored).toContainEqual(revoke);
		expect(stored).toHaveLength(ACCESS_STATEMENTS_PER_SIGNER_MAX);
	});
});
