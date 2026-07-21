/**
 * IE-2 `import` broker service. Runs against a real vault session (Electron
 * mocked) so the capability gate, the inference-only write-type lock, app-scoped
 * dedupe, and the plan/run contract are proven end-to-end through the engine.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let USER_DATA_DIR = "";
vi.mock("electron", () => ({ app: { getPath: () => USER_DATA_DIR } }));

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { __setSqlcipherDriverForTests } from "@brainstorm-os/sqlite";
import { __resetAtRestProbeForTests } from "@brainstorm-os/sqlite/at-rest-mode";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { EntitiesRepository } from "../storage/entities-repo";
import { closeActiveVaultSession, getActiveVaultSession } from "../vault/session";
import { createVault } from "../vault/vault";
import { makeImportServiceHandler } from "./import-service";
import { ImportFormat } from "./import-types";

function fakeLedger(grants: string[]): CapabilityLedger {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedger;
}

function env(app: string, method: string, arg: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app,
		service: "import",
		method,
		args: [arg],
		caps: [],
	};
}

const TYPE = "test/Note/v1";
const APP = "io.example.importer";
const JSONL = [
	JSON.stringify({ id: "n1", title: "First", body: "a" }),
	JSON.stringify({ id: "n2", title: "Second", body: "b" }),
].join("\n");

let workDir = "";
let ledgerGrants = [`entities.write:${TYPE}`];

function handler() {
	return makeImportServiceHandler({
		getSession: () => getActiveVaultSession(),
		getLedger: async () => fakeLedger(ledgerGrants),
		now: () => 1_700_000_000_000,
	});
}

async function entitiesRepo(): Promise<EntitiesRepository> {
	const session = getActiveVaultSession();
	if (!session) throw new Error("no session");
	return new EntitiesRepository(await session.dataStores.open("entities"));
}

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "bs-import-svc-"));
	USER_DATA_DIR = workDir;
	ledgerGrants = [`entities.write:${TYPE}`];
	__setSqlcipherDriverForTests(null);
	__resetAtRestProbeForTests();
	await createVault({
		name: "IMP",
		path: join(workDir, "vault"),
		keystore: { forceInsecure: true },
		seedStarterContent: false,
	});
});

afterEach(async () => {
	closeActiveVaultSession();
	await rm(workDir, { recursive: true, force: true });
});

describe("import service", () => {
	it("plans a dry-run then runs the import for an app with entities.write", async () => {
		const h = handler();
		const plan = (await h(
			env(APP, "plan", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }),
		)) as {
			willCreate: number;
			total: number;
		};
		expect(plan).toMatchObject({ willCreate: 2, total: 2 });

		const report = (await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }),
		)) as {
			created: number;
		};
		expect(report.created).toBe(2);

		const repo = await entitiesRepo();
		const rows = repo.query({ type: [TYPE] });
		expect(rows).toHaveLength(2);
		// Provenance is the calling app, not the shell.
		expect(rows[0]?.createdBy).toBe(APP);
	});

	it("re-imports idempotently (app-scoped dedupe)", async () => {
		const h = handler();
		await h(env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }));
		const second = (await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }),
		)) as {
			created: number;
			updated: number;
		};
		expect(second.created).toBe(0);
		expect(second.updated).toBe(2);
		const repo = await entitiesRepo();
		expect(repo.query({ type: [TYPE] })).toHaveLength(2);
	});

	it("namespaces dedupe by app — a second app's same source does NOT collide", async () => {
		const h = handler();
		ledgerGrants = ["entities.write:*"]; // both apps may write
		await h(
			env("io.app.a", "run", {
				format: ImportFormat.Jsonl,
				text: JSONL,
				targetType: TYPE,
				source: "s",
			}),
		);
		await h(
			env("io.app.b", "run", {
				format: ImportFormat.Jsonl,
				text: JSONL,
				targetType: TYPE,
				source: "s",
			}),
		);
		const repo = await entitiesRepo();
		// Two apps × two rows = four distinct entities (no cross-app overwrite).
		expect(repo.query({ type: [TYPE] })).toHaveLength(4);
	});

	it("never lets a dedupe match overwrite a row of a different type", async () => {
		ledgerGrants = ["entities.write:*"]; // app may write any type
		const h = handler();
		// Import source "s" into Note, then the SAME source into Other.
		await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE, source: "s" }),
		);
		await h(
			env(APP, "run", {
				format: ImportFormat.Jsonl,
				text: JSONL,
				targetType: "test/Other/v1",
				source: "s",
			}),
		);
		const repo = await entitiesRepo();
		// The Note rows are NOT overwritten; the Other import creates its own rows.
		expect(repo.query({ type: [TYPE] })).toHaveLength(2);
		expect(repo.query({ type: ["test/Other/v1"] })).toHaveLength(2);
		// Re-importing into Note still upserts the Note rows (no duplicate despite
		// the marker now also living on the Other rows).
		const again = (await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE, source: "s" }),
		)) as { created: number; updated: number };
		expect(again.created).toBe(0);
		expect(again.updated).toBe(2);
		expect(repo.query({ type: [TYPE] })).toHaveLength(2);
	});

	it("denies an app without entities.write for the target type", async () => {
		ledgerGrants = ["entities.write:test/Other/v1"]; // wrong type
		const h = handler();
		await expect(
			h(env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE })),
		).rejects.toMatchObject({ name: "Denied" });
		const repo = await entitiesRepo();
		expect(repo.query({ type: [TYPE] })).toHaveLength(0); // nothing written
	});

	it("honours a wildcard entities.write:* grant", async () => {
		ledgerGrants = ["entities.write:*"];
		const h = handler();
		const report = (await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }),
		)) as {
			created: number;
		};
		expect(report.created).toBe(2);
	});

	it("rejects bad input and unknown methods", async () => {
		const h = handler();
		await expect(
			h(env(APP, "run", { format: "xml", text: "", targetType: TYPE })),
		).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			h(env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: "" })),
		).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(
			h(env(APP, "frobnicate", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE })),
		).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("previews the source shape (columns + count + sample) without writing", async () => {
		const h = handler();
		const preview = (await h(
			env(APP, "preview", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE }),
		)) as { columns: string[]; recordCount: number; sample: Record<string, unknown>[] };
		expect(preview.columns).toEqual(["id", "title", "body"]);
		expect(preview.recordCount).toBe(2);
		expect(preview.sample).toHaveLength(2);
		// preview never writes.
		const repo = await entitiesRepo();
		expect(repo.query({ type: [TYPE] })).toHaveLength(0);
	});

	it("applies an app column mapping (rename + exclude) but keeps the cap-checked type", async () => {
		const h = handler();
		const mapping = [
			{ column: "id", property: "id", include: true },
			{ column: "title", property: "title", include: false },
			{ column: "body", property: "note", include: true },
		];
		const report = (await h(
			env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE, mapping }),
		)) as { created: number };
		expect(report.created).toBe(2);
		const repo = await entitiesRepo();
		const rows = repo.query({ type: [TYPE] });
		expect(rows).toHaveLength(2); // still the cap-checked type, not anything the mapping named
		const first = rows.find((r) => r.properties.note === "a");
		expect(first).toBeDefined();
		expect("title" in (first?.properties ?? {})).toBe(false); // excluded
	});

	it("fails closed (Unavailable) when the ledger is gone", async () => {
		const h = makeImportServiceHandler({
			getSession: () => getActiveVaultSession(),
			getLedger: async () => null,
			now: () => 1_700_000_000_000,
		});
		await expect(
			h(env(APP, "run", { format: ImportFormat.Jsonl, text: JSONL, targetType: TYPE })),
		).rejects.toMatchObject({ name: "Unavailable" });
	});
});
