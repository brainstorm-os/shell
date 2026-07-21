import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateChannel } from "@brainstorm-os/protocol/update-wire-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppSignatureStatus } from "../../apps/app-signature";
import { InstallOrigin, OFFICIAL_CATALOG_ID } from "../../apps/install-provenance";
import { DataStores } from "../data-stores";
import { OpenerTargetKind, RegistryRepositories } from "./index";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-repos-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const repos = new RegistryRepositories(db);
	return { vaultDir, stores, db, repos };
}

const baseApp = {
	id: "io.example.notes",
	version: "1.0.0",
	sdk: "1",
	manifestPath: "/p/manifest.json",
	bundleDir: "/p",
	bundleSha256: "a".repeat(64),
	installedAt: 1000,
	updatedAt: 1000,
	signatureStatus: AppSignatureStatus.Unsigned,
	signatureKeyId: null,
	origin: InstallOrigin.BootstrapCache,
	catalogId: OFFICIAL_CATALOG_ID,
	channel: UpdateChannel.Stable,
	publisherKey: null,
	catalogVersion: null,
};

describe("AppsRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("upsert + getActive round-trips", () => {
		env.repos.apps.upsert(baseApp);
		expect(env.repos.apps.getActive("io.example.notes")).toMatchObject({
			id: "io.example.notes",
			version: "1.0.0",
		});
	});

	it("markUninstalled hides the row from getActive", () => {
		env.repos.apps.upsert(baseApp);
		expect(env.repos.apps.markUninstalled("io.example.notes")).toBe(true);
		expect(env.repos.apps.getActive("io.example.notes")).toBeNull();
	});

	it("markUninstalled is idempotent (returns false the second time)", () => {
		env.repos.apps.upsert(baseApp);
		env.repos.apps.markUninstalled("io.example.notes");
		expect(env.repos.apps.markUninstalled("io.example.notes")).toBe(false);
	});

	it("upsert reactivates a previously-uninstalled row", () => {
		env.repos.apps.upsert(baseApp);
		env.repos.apps.markUninstalled("io.example.notes");
		env.repos.apps.upsert({ ...baseApp, version: "2.0.0", installedAt: 2000, updatedAt: 2000 });
		expect(env.repos.apps.getActive("io.example.notes")).toMatchObject({ version: "2.0.0" });
	});

	it("updateBundle only touches the row when active", () => {
		env.repos.apps.upsert(baseApp);
		env.repos.apps.updateBundle({ ...baseApp, version: "1.1.0", updatedAt: 1100 });
		expect(env.repos.apps.getActive("io.example.notes")?.version).toBe("1.1.0");
		env.repos.apps.markUninstalled("io.example.notes");
		env.repos.apps.updateBundle({ ...baseApp, version: "1.2.0", updatedAt: 1200 });
		// Soft-deleted; updateBundle is a no-op on it.
		expect(env.repos.apps.getActive("io.example.notes")).toBeNull();
	});

	it("listActive returns sorted ids", () => {
		env.repos.apps.upsert({ ...baseApp, id: "z.example.app" });
		env.repos.apps.upsert({ ...baseApp, id: "a.example.app" });
		expect(env.repos.apps.listActive().map((a) => a.id)).toEqual(["a.example.app", "z.example.app"]);
	});

	it("v7 migration adds the signature columns at schema version >= 7 (13.2)", () => {
		const version = (
			env.db.prepare("SELECT MAX(version) AS v FROM _schema_version").get() as { v: number }
		).v;
		expect(version).toBeGreaterThanOrEqual(7);
		const cols = (env.db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string }>).map(
			(c) => c.name,
		);
		expect(cols).toContain("signature_status");
		expect(cols).toContain("signature_key_id");
	});

	it("a freshly-inserted row defaults to an 'unsigned' signature status", () => {
		// Insert via the raw apps schema default (no signature columns provided)
		// to model a pre-13.2 row carried across the migration.
		env.db
			.prepare(
				"INSERT INTO apps (id, version, sdk, manifest_path, bundle_dir, bundle_sha256, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("io.legacy.app", "1.0.0", "1", "/p/manifest.json", "/p", "b".repeat(64), 1, 1);
		const record = env.repos.apps.getActive("io.legacy.app");
		expect(record?.signatureStatus).toBe(AppSignatureStatus.Unsigned);
		expect(record?.signatureKeyId).toBeNull();
	});

	it("round-trips a recorded signature status + signer key id", () => {
		env.repos.apps.upsert({
			...baseApp,
			signatureStatus: AppSignatureStatus.Verified,
			signatureKeyId: "signing-key-1",
		});
		const record = env.repos.apps.getActive("io.example.notes");
		expect(record?.signatureStatus).toBe(AppSignatureStatus.Verified);
		expect(record?.signatureKeyId).toBe("signing-key-1");
	});

	it("v9 migration adds the install-provenance columns (doc 59 / 14.29)", () => {
		const version = (
			env.db.prepare("SELECT MAX(version) AS v FROM _schema_version").get() as { v: number }
		).v;
		expect(version).toBeGreaterThanOrEqual(9);
		const cols = (env.db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string }>).map(
			(c) => c.name,
		);
		for (const col of [
			"install_source",
			"catalog_id",
			"channel",
			"publisher_key",
			"catalog_version",
		]) {
			expect(cols).toContain(col);
		}
	});

	it("round-trips install provenance (origin / catalog / channel / publisher key)", () => {
		env.repos.apps.upsert({
			...baseApp,
			origin: InstallOrigin.Catalog,
			catalogId: OFFICIAL_CATALOG_ID,
			channel: UpdateChannel.Beta,
			publisherKey: "ed25519:notes-pub",
			catalogVersion: "1.0.0",
		});
		const record = env.repos.apps.getActive("io.example.notes");
		expect(record?.origin).toBe(InstallOrigin.Catalog);
		expect(record?.catalogId).toBe(OFFICIAL_CATALOG_ID);
		expect(record?.channel).toBe(UpdateChannel.Beta);
		expect(record?.publisherKey).toBe("ed25519:notes-pub");
		expect(record?.catalogVersion).toBe("1.0.0");
	});

	it("backfills a pre-v9 row to bootstrap-cache against the official catalog", () => {
		// A row inserted without the provenance columns models an install carried
		// across the v9 migration; the column defaults + migration UPDATE give it
		// bootstrap-cache / official-catalog / stable.
		env.db
			.prepare(
				"INSERT INTO apps (id, version, sdk, manifest_path, bundle_dir, bundle_sha256, installed_at, updated_at, catalog_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'brainstorm-official')",
			)
			.run("io.legacy.app", "1.0.0", "1", "/p/manifest.json", "/p", "c".repeat(64), 1, 1);
		const record = env.repos.apps.getActive("io.legacy.app");
		expect(record?.origin).toBe(InstallOrigin.BootstrapCache);
		expect(record?.catalogId).toBe(OFFICIAL_CATALOG_ID);
		expect(record?.channel).toBe(UpdateChannel.Stable);
		expect(record?.publisherKey).toBeNull();
		expect(record?.catalogVersion).toBeNull();
	});
});

describe("OpenersRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.apps.upsert(baseApp);
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("insertMany + listForApp round-trips all four target kinds", () => {
		env.repos.openers.insertMany([
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.EntityType,
				target: "io.example/Note/v1",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Mime,
				target: "text/markdown",
				kind: "secondary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Scheme,
				target: "https",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Extension,
				target: "csv",
				kind: "secondary",
			},
		]);
		expect(env.repos.openers.listForApp("io.example.notes")).toHaveLength(4);
	});

	it("listForTarget filters by (target_kind, target) incl. scheme/extension", () => {
		env.repos.openers.insertMany([
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.EntityType,
				target: "io.example/Note/v1",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Scheme,
				target: "https",
				kind: "primary",
			},
		]);
		expect(
			env.repos.openers.listForTarget(OpenerTargetKind.EntityType, "io.example/Note/v1"),
		).toHaveLength(1);
		expect(env.repos.openers.listForTarget(OpenerTargetKind.Scheme, "https")).toHaveLength(1);
		// a scheme query never matches an entity_type row of the same string
		expect(env.repos.openers.listForTarget(OpenerTargetKind.Mime, "https")).toEqual([]);
	});

	it("deleteForApp clears all openers for an app", () => {
		env.repos.openers.insertMany([
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Mime,
				target: "text/plain",
				kind: "primary",
			},
		]);
		expect(env.repos.openers.deleteForApp("io.example.notes")).toBe(1);
		expect(env.repos.openers.listForApp("io.example.notes")).toEqual([]);
	});

	it("listDistinctTargets returns sorted-unique targets per kind (OpenRes-1c slice 2)", () => {
		// Two apps registering the same scheme `https`, plus a unique
		// `mailto`. The Settings → Defaults catalog wants one entry per
		// scheme regardless of how many apps claim it, so the DISTINCT
		// query is the load-bearing piece. Pinning the sort order means
		// the UI doesn't need a separate `.sort()` pass downstream.
		env.repos.apps.upsert({ ...baseApp, id: "io.example.web" });
		env.repos.openers.insertMany([
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Scheme,
				target: "https",
				kind: "primary",
			},
			{
				appId: "io.example.web",
				targetKind: OpenerTargetKind.Scheme,
				target: "https",
				kind: "secondary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Scheme,
				target: "mailto",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Extension,
				target: "pdf",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.Extension,
				target: "csv",
				kind: "primary",
			},
			{
				appId: "io.example.notes",
				targetKind: OpenerTargetKind.EntityType,
				target: "io.example/Note/v1",
				kind: "primary",
			},
		]);
		expect(env.repos.openers.listDistinctTargets(OpenerTargetKind.Scheme)).toEqual([
			"https",
			"mailto",
		]);
		expect(env.repos.openers.listDistinctTargets(OpenerTargetKind.Extension)).toEqual(["csv", "pdf"]);
		expect(env.repos.openers.listDistinctTargets(OpenerTargetKind.EntityType)).toEqual([
			"io.example/Note/v1",
		]);
		// Empty-set case — Mime has nothing registered in this fixture.
		expect(env.repos.openers.listDistinctTargets(OpenerTargetKind.Mime)).toEqual([]);
	});
});

describe("BlocksRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.apps.upsert(baseApp);
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("insertMany + listForApp", () => {
		env.repos.blocks.insertMany([
			{ id: "io.example.notes/p", appId: "io.example.notes", name: "Paragraph", registeredAt: 1 },
			{ id: "io.example.notes/h", appId: "io.example.notes", name: "Heading", registeredAt: 2 },
		]);
		const list = env.repos.blocks.listForApp("io.example.notes");
		expect(list.map((b) => b.id)).toEqual(["io.example.notes/h", "io.example.notes/p"]);
	});

	it("deleteForApp clears", () => {
		env.repos.blocks.insert({
			id: "io.example.notes/p",
			appId: "io.example.notes",
			name: "Paragraph",
			registeredAt: 1,
		});
		expect(env.repos.blocks.deleteForApp("io.example.notes")).toBe(1);
		expect(env.repos.blocks.listForApp("io.example.notes")).toEqual([]);
	});

	it("getById resolves the providing app, null when unknown", () => {
		env.repos.blocks.insert({
			id: "io.example.notes/board",
			appId: "io.example.notes",
			name: "Board",
			registeredAt: 7,
		});
		expect(env.repos.blocks.getById("io.example.notes/board")).toEqual({
			id: "io.example.notes/board",
			appId: "io.example.notes",
			name: "Board",
			registeredAt: 7,
		});
		expect(env.repos.blocks.getById("io.example.notes/missing")).toBeNull();
	});

	it("stores + reads a block bundle source; null when none / unknown", () => {
		env.repos.blocks.insertMany([
			{
				id: "io.example.db/grid",
				appId: "io.example.notes",
				name: "Grid",
				registeredAt: 1,
				source: "/* iife bundle */",
			},
			{ id: "io.example.notes/p", appId: "io.example.notes", name: "P", registeredAt: 2 },
		]);
		expect(env.repos.blocks.getSource("io.example.db/grid")).toBe("/* iife bundle */");
		// Registered block with no bundle, and an unknown id, both → null.
		expect(env.repos.blocks.getSource("io.example.notes/p")).toBeNull();
		expect(env.repos.blocks.getSource("io.example.notes/missing")).toBeNull();
	});

	it("forType resolves a block by the entity type it renders; null otherwise", () => {
		env.repos.blocks.insertMany([
			{
				id: "io.example.db/grid",
				appId: "io.example.notes",
				name: "Grid",
				registeredAt: 1,
				entityTypes: ["brainstorm/List/v1"],
			},
			{ id: "io.example.notes/p", appId: "io.example.notes", name: "P", registeredAt: 2 },
		]);
		expect(env.repos.blocks.forType("brainstorm/List/v1")).toBe("io.example.db/grid");
		expect(env.repos.blocks.forType("brainstorm/Note/v1")).toBeNull();
	});

	it("listAll spans every app, id-ordered", () => {
		env.repos.apps.upsert({
			...baseApp,
			id: "io.example.db",
			manifestPath: "/q/manifest.json",
			bundleDir: "/q",
		});
		env.repos.blocks.insertMany([
			{ id: "io.example.notes/p", appId: "io.example.notes", name: "P", registeredAt: 1 },
			{ id: "io.example.db/grid", appId: "io.example.db", name: "Grid", registeredAt: 2 },
		]);
		expect(env.repos.blocks.listAll().map((b) => b.id)).toEqual([
			"io.example.db/grid",
			"io.example.notes/p",
		]);
		expect(env.repos.blocks.listForApp("io.example.db")).toHaveLength(1);
	});
});

describe("EntityTypesRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.apps.upsert(baseApp);
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("upsert inserts a fresh row with orphaned=false", () => {
		env.repos.entityTypes.upsert({
			id: "io.example/Note/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/Note/v1",
			schemaInline: { properties: { title: { type: "string" } } },
			registeredAt: 1,
		});
		const got = env.repos.entityTypes.get("io.example/Note/v1");
		expect(got?.orphaned).toBe(false);
		expect(got?.schemaInline).toEqual({ properties: { title: { type: "string" } } });
	});

	it("upsert refreshes an existing row and un-orphans it", () => {
		env.repos.entityTypes.upsert({
			id: "io.example/Note/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/Note/v1",
			schemaInline: null,
			registeredAt: 1,
		});
		env.repos.entityTypes.orphanForApp("io.example.notes");
		expect(env.repos.entityTypes.get("io.example/Note/v1")?.orphaned).toBe(true);

		env.repos.entityTypes.upsert({
			id: "io.example/Note/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/Note/v1",
			schemaInline: { properties: { title: { type: "string" } } },
			registeredAt: 2,
		});
		const refreshed = env.repos.entityTypes.get("io.example/Note/v1");
		expect(refreshed?.orphaned).toBe(false);
		expect(refreshed?.schemaInline).toEqual({ properties: { title: { type: "string" } } });
	});

	it("orphanForApp flips the flag for the introducing app only", () => {
		env.repos.apps.upsert({ ...baseApp, id: "io.example.other" });
		env.repos.entityTypes.upsert({
			id: "io.example/Note/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/Note/v1",
			schemaInline: null,
			registeredAt: 1,
		});
		env.repos.entityTypes.upsert({
			id: "io.example/Task/v1",
			introducedBy: "io.example.other",
			schemaUrl: "https://schemas.example.io/Task/v1",
			schemaInline: null,
			registeredAt: 2,
		});
		expect(env.repos.entityTypes.orphanForApp("io.example.notes")).toBe(1);
		expect(env.repos.entityTypes.get("io.example/Note/v1")?.orphaned).toBe(true);
		expect(env.repos.entityTypes.get("io.example/Task/v1")?.orphaned).toBe(false);
	});

	it("listForApp returns rows sorted by id", () => {
		env.repos.entityTypes.upsert({
			id: "io.example/Note/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/Note/v1",
			schemaInline: null,
			registeredAt: 1,
		});
		env.repos.entityTypes.upsert({
			id: "io.example/AAA/v1",
			introducedBy: "io.example.notes",
			schemaUrl: "https://schemas.example.io/AAA/v1",
			schemaInline: null,
			registeredAt: 1,
		});
		const list = env.repos.entityTypes.listForApp("io.example.notes");
		expect(list.map((t) => t.id)).toEqual(["io.example/AAA/v1", "io.example/Note/v1"]);
	});
});

describe("WidgetsRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.apps.upsert(baseApp);
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("insertMany + listForApp", () => {
		env.repos.widgets.insertMany([
			{
				id: "recent",
				appId: "io.example.notes",
				name: "Recent",
				size: "small",
				registeredAt: 1,
			},
		]);
		expect(env.repos.widgets.listForApp("io.example.notes")).toHaveLength(1);
	});

	it("deleteForApp clears", () => {
		env.repos.widgets.insert({
			id: "recent",
			appId: "io.example.notes",
			name: "Recent",
			size: "small",
			registeredAt: 1,
		});
		expect(env.repos.widgets.deleteForApp("io.example.notes")).toBe(1);
		expect(env.repos.widgets.listForApp("io.example.notes")).toEqual([]);
	});
});

describe("IntentsRepository", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.apps.upsert(baseApp);
		env.repos.apps.upsert({ ...baseApp, id: "io.example.editor" });
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("insertMany + listForApp round-trips", () => {
		env.repos.intents.insertMany([
			{
				appId: "io.example.notes",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "primary",
				registeredAt: 5,
			},
			{
				appId: "io.example.notes",
				verb: "export",
				entityType: "io.example/Note/v1",
				mime: null,
				format: "text/csv",
				kind: null,
				blockId: null,
				label: "Note as CSV",
				priority: "secondary",
				registeredAt: 5,
			},
		]);
		expect(env.repos.intents.listForApp("io.example.notes")).toHaveLength(2);
	});

	it("findHandlers matches a primary entity-type opener", () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 5,
		});
		env.repos.intents.insert({
			appId: "io.example.notes",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 5,
		});
		const handlers = env.repos.intents.findHandlers({
			verb: "open",
			entityType: "io.example/Note/v1",
		});
		expect(handlers.map((h) => h.appId)).toEqual(["io.example.editor", "io.example.notes"]);
	});

	it("findHandlers treats NULL discriminator columns as wildcards", () => {
		env.repos.intents.insert({
			appId: "io.example.notes",
			verb: "process",
			entityType: null,
			mime: null,
			format: null,
			kind: "summarize",
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 5,
		});
		// Query supplies an entityType the registration left NULL — should still match.
		const handlers = env.repos.intents.findHandlers({
			verb: "process",
			entityType: "io.example/Note/v1",
			kind: "summarize",
		});
		expect(handlers).toHaveLength(1);
		// And it should NOT match when kind disagrees.
		expect(env.repos.intents.findHandlers({ verb: "process", kind: "translate" })).toHaveLength(0);
	});

	it("deleteForApp clears all intent rows for an app", () => {
		env.repos.intents.insertMany([
			{
				appId: "io.example.notes",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "primary",
				registeredAt: 5,
			},
			{
				appId: "io.example.notes",
				verb: "share",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "secondary",
				registeredAt: 5,
			},
		]);
		expect(env.repos.intents.deleteForApp("io.example.notes")).toBe(2);
		expect(env.repos.intents.listForApp("io.example.notes")).toEqual([]);
	});

	it("findActions (doc 63 / AS-1) matches multi-verb + discriminators and round-trips icon/group", () => {
		env.repos.apps.upsert({ ...baseApp, id: "io.example.agent" });
		env.repos.apps.upsert({ ...baseApp, id: "io.example.sharer" });
		env.repos.apps.upsert({ ...baseApp, id: "io.example.other" });
		env.repos.intents.insertMany([
			{
				appId: "io.example.agent",
				verb: "process",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: "summarize",
				blockId: null,
				label: "Summarize",
				priority: "secondary",
				registeredAt: 5,
				icon: "sparkle",
				actionGroup: "actions",
			},
			{
				appId: "io.example.sharer",
				verb: "share",
				entityType: null,
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: "Share",
				priority: "primary",
				registeredAt: 5,
				icon: "open-external",
				actionGroup: "share",
			},
			{
				appId: "io.example.other",
				verb: "process",
				entityType: "io.example/Task/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "secondary",
				registeredAt: 5,
			},
		]);
		// A Note target: the type-scoped process row AND the wildcard share row
		// match; the Task-scoped process row does NOT.
		const actions = env.repos.intents.findActions(["process", "share"], {
			entityType: "io.example/Note/v1",
		});
		expect(actions.map((a) => a.appId).sort()).toEqual(["io.example.agent", "io.example.sharer"]);
		const summarize = actions.find((a) => a.appId === "io.example.agent");
		expect(summarize?.icon).toBe("sparkle");
		expect(summarize?.actionGroup).toBe("actions");
		expect(summarize?.kind).toBe("summarize");
	});

	it("findActions returns [] for no verbs", () => {
		env.repos.apps.upsert({ ...baseApp, id: "io.example.agent" });
		env.repos.intents.insert({
			appId: "io.example.agent",
			verb: "process",
			entityType: null,
			mime: null,
			format: null,
			kind: "summarize",
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 5,
		});
		expect(env.repos.intents.findActions([], { entityType: "io.example/Note/v1" })).toEqual([]);
	});

	describe("scheduler_meta last_run watermark (0.3.1 missed-fire catch-up)", () => {
		it("round-trips null → value → upsert", () => {
			expect(env.repos.schedulerFires.loadLastRun()).toBeNull();
			env.repos.schedulerFires.saveLastRun(1_700_000_000_000);
			expect(env.repos.schedulerFires.loadLastRun()).toBe(1_700_000_000_000);
			env.repos.schedulerFires.saveLastRun(1_700_000_050_000);
			expect(env.repos.schedulerFires.loadLastRun()).toBe(1_700_000_050_000);
		});
	});
});
