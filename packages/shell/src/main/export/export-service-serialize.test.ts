/**
 * IE-8 `export.serializeEntities` — the read-only counterpart to the import
 * service. Runs against a real vault session (Electron mocked) so the per-type
 * read filter + format dispatch are proven end-to-end.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import type { Envelope } from "../../ipc/envelope";
import type { CapabilityLedger } from "../capabilities/ledger";
import { __resetAtRestProbeForTests } from "../storage/at-rest-mode";
import { EntitiesRepository } from "../storage/entities-repo";
import { __setSqlcipherDriverForTests } from "../storage/sqlite";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import { makeExportServiceHandler } from "./export-service-handler";

function fakeLedger(grants: string[]): CapabilityLedger {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedger;
}

function env(method: string, args: unknown[]): Envelope {
	return { v: 1, msg: "m", app: "io.test.app", service: "export", method, args, caps: [] };
}

const NOTE = "test/Note/v1";
const SECRET = "test/Secret/v1";

let workDir = "";
let grants = [`entities.read:${NOTE}`];

function handler() {
	return makeExportServiceHandler({
		renderHtmlToPdf: async () => new Uint8Array(),
		getSession: () => getActiveVaultSession(),
		getLedger: async () => fakeLedger(grants),
	});
}

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "bs-export-svc-"));
	USER_DATA_DIR = workDir;
	grants = [`entities.read:${NOTE}`];
	__setSqlcipherDriverForTests(null);
	__resetAtRestProbeForTests();
	await createVault({
		name: "EX",
		path: join(workDir, "vault"),
		keystore: { forceInsecure: true },
		seedStarterContent: false,
	});
	const session = getActiveVaultSession();
	if (!session) throw new Error("expected an active vault session");
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	repo.create({
		id: "ent_a",
		type: NOTE,
		properties: { title: "Alpha" },
		createdBy: "t",
		now: 1,
		dekId: null,
	});
	repo.create({
		id: "ent_b",
		type: NOTE,
		properties: { title: "Beta" },
		createdBy: "t",
		now: 1,
		dekId: null,
	});
	repo.create({
		id: "ent_s",
		type: SECRET,
		properties: { title: "Top secret" },
		createdBy: "t",
		now: 1,
		dekId: null,
	});
});

afterEach(async () => {
	closeActiveVaultSession();
	await rm(workDir, { recursive: true, force: true });
});

describe("export.serializeEntities", () => {
	it("serializes readable entities to JSON, filtering out unreadable types", async () => {
		const h = handler();
		const json = (await h(
			env("serializeEntities", [{ ids: ["ent_a", "ent_b", "ent_s"], format: "json" }]),
		)) as string;
		const parsed = JSON.parse(json) as Array<{ id: string }>;
		// ent_s is a type the app can't read → silently filtered.
		expect(parsed.map((e) => e.id).sort()).toEqual(["ent_a", "ent_b"]);
	});

	it("serializes to Markdown", async () => {
		const h = handler();
		const md = (await h(
			env("serializeEntities", [{ ids: ["ent_a"], format: "markdown" }]),
		)) as string;
		expect(md).toContain("title: Alpha");
	});

	it("honours a wildcard entities.read:* grant (includes the secret)", async () => {
		grants = ["entities.read:*"];
		const h = handler();
		const json = (await h(
			env("serializeEntities", [{ ids: ["ent_a", "ent_s"], format: "json" }]),
		)) as string;
		expect((JSON.parse(json) as Array<{ id: string }>).map((e) => e.id).sort()).toEqual([
			"ent_a",
			"ent_s",
		]);
	});

	it("rejects a bad format / non-array ids as Invalid", async () => {
		const h = handler();
		await expect(
			h(env("serializeEntities", [{ ids: ["ent_a"], format: "xml" }])),
		).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			h(env("serializeEntities", [{ ids: "ent_a", format: "json" }])),
		).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("fails closed (Unavailable) when the ledger is gone", async () => {
		const h = makeExportServiceHandler({
			renderHtmlToPdf: async () => new Uint8Array(),
			getSession: () => getActiveVaultSession(),
			getLedger: async () => null,
		});
		await expect(
			h(env("serializeEntities", [{ ids: ["ent_a"], format: "json" }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});
