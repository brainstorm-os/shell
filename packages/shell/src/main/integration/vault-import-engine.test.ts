/**
 * IE-2 — shared import engine against a live vault.
 *
 * Proves the keystone the migration importers (IE-5/IE-6) ride on: a JSON
 * source parses → maps → projects → writes real `entities.db` rows, and a
 * *second* import of the same source is **idempotent** (updates the existing
 * rows by external id, never duplicates) — doc 45 §The import flow.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import { ImportFormat } from "../import/import-types";
import { importRecordsIntoVault, planRecordsImport } from "../import/vault-import-engine";
import { __resetAtRestProbeForTests } from "../storage/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { __setSqlcipherDriverForTests } from "../storage/sqlite";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";

const TYPE = "x/Contact/v1";
const SOURCE = "json:test";
const IMPORTER = "did:test:importer";

describe("IE-2 import engine (vault)", () => {
	let workDir = "";

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "brainstorm-import-"));
		USER_DATA_DIR = workDir;
		__setSqlcipherDriverForTests(null);
		__resetAtRestProbeForTests();
	});

	afterEach(async () => {
		// Close any session a (possibly-throwing) test left open before removing
		// its dir — an open SQLite handle locks the file on Windows.
		closeActiveVaultSession();
		await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("imports JSON rows then re-imports idempotently (update, not duplicate)", async () => {
		await createVault({
			name: "I",
			path: join(workDir, "vault"),
			keystore: { forceInsecure: true },
			seedStarterContent: false,
		});
		const session = getActiveVaultSession();
		if (!session) throw new Error("no active session");
		const repo = new EntitiesRepository(await session.dataStores.open("entities"));

		const v1 = JSON.stringify([
			{ id: "c1", name: "Ada", premium: true, joined: "2026-01-02" },
			{ id: "c2", name: "Grace", premium: false, joined: "2026-02-03" },
			{ name: "Anon" },
		]);
		const options = {
			format: ImportFormat.Json,
			targetType: TYPE,
			source: SOURCE,
			now: 1000,
			importedBy: IMPORTER,
		};

		// dry-run first — predicts 3 creates, writes nothing
		const plan = await planRecordsImport(session, v1, options);
		expect(plan).toMatchObject({ total: 3, willCreate: 3, willUpdate: 0 });
		expect(repo.query({ type: TYPE })).toHaveLength(0);

		const r1 = await importRecordsIntoVault(session, v1, options);
		expect(r1).toMatchObject({ created: 3, updated: 0 });
		const rows = repo.query({ type: TYPE });
		expect(rows).toHaveLength(3);

		const ada = rows.find((r) => r.properties.name === "Ada");
		expect(ada?.properties.premium).toBe(true);
		expect(ada?.properties.importExternalId).toBe("json:test:c1");
		expect((ada?.properties.joined as { at: number }).at).toBe(Date.parse("2026-01-02"));

		// re-import with c1 edited + c2 unchanged + one new keyed row
		const v2 = JSON.stringify([
			{ id: "c1", name: "Ada Lovelace", premium: false },
			{ id: "c2", name: "Grace" },
			{ id: "c3", name: "Edsger" },
		]);
		const r2 = await importRecordsIntoVault(session, v2, { ...options, now: 2000 });
		expect(r2).toMatchObject({ created: 1, updated: 2 });

		const after = repo.query({ type: TYPE });
		// 3 (first run) + 1 new keyed (c3); the anon row is untouched, c1/c2 updated
		expect(after).toHaveLength(4);
		const adaAfter = after.find((r) => r.properties.importExternalId === "json:test:c1");
		expect(adaAfter?.properties.name).toBe("Ada Lovelace");
		expect(adaAfter?.properties.premium).toBe(false);
		// shallow-merge preserved the original joined date (not in the v2 payload)
		expect((adaAfter?.properties.joined as { at: number }).at).toBe(Date.parse("2026-01-02"));

		closeActiveVaultSession();
	});
});
