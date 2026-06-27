/**
 * END-TO-END app-data pipeline harness.
 *
 * Every prior test called handlers directly and so never exercised the
 * one layer the *running app* must pass: the Broker's capability check
 * against a real `CapabilityLedger` populated by the real `AppInstaller`
 * from a real manifest. A silent denial there is exactly what makes
 * Database/Files/Preview fall back to demo data.
 *
 * This reproduces production in-process:
 *   real manifest (`entities.read:*`, as Database/Files/Preview declare)
 *     → real AppInstaller → real CapabilityLedger
 *     → real Broker (production-equivalent `checkCapability`)
 *     → real `vault-entities` handler → real aggregator + entities.db
 *     ← the exact envelope the SDK `vaultEntitiesProxy.list()` sends.
 *
 * If the app would see demo data in production, this test fails here —
 * deterministically, with the precise failure (CapabilityDenied vs
 * empty vs data). It is the verification surface for the wiring work.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type PropertyDef, ValueType } from "@brainstorm/sdk-types";
// `PropertyStore` is the exact store the Notes `PropertiesProvider`
// feeds the snapshot into; the picker lists `store.getSnapshot()`. It
// only imports `@brainstorm/sdk-types` (no Lexical / no Notes `Window`
// global), so it's safe to pull into the shell TS program — unlike the
// editor modules.
import { PropertyStore } from "@brainstorm/sdk/property-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
// Integration test: deliberately reaches into the apps' PURE transforms
// (no DOM) to prove "what Database/Files would actually render" from the
// real seeded pipeline — the verification surface the demo removal needs.
import { buildVaultLists } from "../../../../../apps/database/src/logic/vault-lists";
import { buildVaultFileTree } from "../../../../../apps/files/src/logic/vault-tree";
import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { AppSignatureStatus } from "../apps/app-signature";
import type { FirstPartyApp } from "../apps/first-party";
import { AppInstaller } from "../apps/installer";
import type { LaunchOrchestrator } from "../apps/launch-orchestrator";
import type { AppWindow } from "../apps/launcher";
import type { AppManifest } from "../apps/manifest";
import { bootstrapApps } from "../apps/seed-packaged-apps";
import type { CapabilityLedger as CapabilityLedgerType } from "../capabilities/ledger";
import { CapabilityLedger } from "../capabilities/ledger";
import { generateSymmetricKey } from "../credentials/crypto";
import type { DashboardStore } from "../dashboard/dashboard-store";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { readEntityDocProjection } from "../entities/entity-doc-codec";
import { makeVaultEntitiesServiceHandler } from "../entities/vault-entities-service";
import { IntentsBus } from "../intents/intents-bus";
import { makePropertiesServiceHandler } from "../properties/properties-service";
import { PROPERTIES_DOC_ID, PropertiesStore } from "../properties/properties-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { RegistryRepositories } from "../storage/registry-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { YDocStore } from "../storage/ydoc-store";

/** Ledger fake mirroring the entities-service test's: a `*`-scoped grant
 *  matches any scope for that capability. */
function fakeLedger(grants: string[]): CapabilityLedgerType {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedgerType;
}

// Mirrors the real Database/Files/Preview manifests — the load-bearing
// line is `entities.read:*`, what `vaultEntitiesProxy.list()` declares.
const APP_ID = "io.brainstorm.database";
const manifest: AppManifest = {
	id: APP_ID,
	name: "Database",
	version: "0.1.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [
		"entities.read:brainstorm/List/v1",
		"entities.write:brainstorm/List/v1",
		"entities.read:*",
		"entities.write:*",
	],
	registrations: {},
};

/** Minimal in-test fixture — one Project + two Tasks + one Note + one link.
 *  This test only needs SOMETHING in `entities.db` to prove the broker
 *  pipeline returns it. The richer release-plan narrative lives in
 *  `tools/mcp-server/src/seed/` and is exercised through the dev IPC. */
async function seedMinimalEntities(stores: DataStores): Promise<void> {
	const repo = new EntitiesRepository(await stores.open("entities"));
	const now = Date.now();
	repo.create({
		id: "p1",
		type: "brainstorm/Project/v1",
		createdBy: "io.brainstorm.tasks",
		properties: { name: "Pipeline test project" },
		dekId: null,
		now,
	});
	for (const id of ["t1", "t2"]) {
		repo.create({
			id,
			type: "brainstorm/Task/v1",
			createdBy: "io.brainstorm.tasks",
			properties: { name: `Task ${id}`, projectId: "p1" },
			dekId: null,
			now,
		});
	}
	repo.create({
		id: "n1",
		type: "io.brainstorm.notes/Note/v1",
		createdBy: "io.brainstorm.notes",
		properties: { title: "Pipeline test note" },
		dekId: null,
		now,
	});
	repo.putLink({
		id: "l1",
		sourceEntityId: "t1",
		destEntityId: "p1",
		linkType: "brainstorm/Task/in-project",
		createdAt: now,
	});
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-pipeline-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "bs-pipeline-src-"));
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await mkdir(join(sourceDir, "dist"), { recursive: true });
	await writeFile(join(sourceDir, "dist", "index.html"), "<!doctype html>", "utf8");

	const stores = new DataStores(vaultDir);
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
	return { vaultDir, sourceDir, stores, ledger, installer };
}

describe("app-data pipeline (real install → ledger → broker → aggregator)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(env.sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("the real installer grants the `entities.read:*` wildcard the apps need", async () => {
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		// THE assertion that was never made: the wildcard scope grant.
		expect(env.ledger.has(APP_ID, "entities.read:*")).toBe(true);
	});

	it("records the bundle content hash + advisory signature status on the registry row (13.2)", async () => {
		const result = await env.installer.install({ bundleDir: env.sourceDir });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");

		// Read it back through the registry repo (the read path), not the
		// installer's return value — proves it persisted.
		const repos = new RegistryRepositories(await env.stores.open("registry"));
		const record = repos.apps.getActive(APP_ID);
		expect(record).not.toBeNull();
		expect(record?.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(record?.bundleSha256).toBe(result.app.bundleSha256);
		// Unsigned manifest under the default advisory policy → 'unsigned'.
		expect(record?.signatureStatus).toBe(AppSignatureStatus.Unsigned);
		expect(record?.signatureKeyId).toBeNull();
	});

	it("vaultEntities.list() through the real Broker returns the seeded objects (NOT demo/denied)", async () => {
		const install = await env.installer.install({ bundleDir: env.sourceDir });
		expect(install.ok).toBe(true);

		await seedMinimalEntities(env.stores);

		// Production-equivalent checkCapability (broker-context.ts:62-72):
		// every declared cap must be a live ledger grant for the app.
		const broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (app) => app === APP_ID,
			checkCapability: (app, _s, _m, caps) => caps.every((c) => env.ledger.has(app, c)),
		});
		broker.registerService(
			"vault-entities",
			makeVaultEntitiesServiceHandler({
				getVaultPath: () => env.vaultDir,
				getEntitiesRepo: async () => new EntitiesRepository(await env.stores.open("entities")),
			}),
		);

		// The EXACT envelope `vaultEntitiesProxy.list()` builds.
		const reply = await broker.dispatch(
			makeEnvelope({
				msg: "m1",
				app: APP_ID,
				service: "vault-entities",
				method: "list",
				args: [],
				caps: ["entities.read:*"],
			}),
			"renderer",
		);

		if (!reply.ok) {
			throw new Error(
				`vault-entities.list DENIED in the real pipeline: kind=${reply.error.kind} — this is exactly why the app shows demo data`,
			);
		}
		const snap = reply.value as {
			entities: Array<{
				id: string;
				type: string;
				properties: Record<string, unknown>;
				createdAt: number;
				updatedAt: number;
				deletedAt: number | null;
			}>;
			links: Array<{
				id: string;
				sourceEntityId: string;
				destEntityId: string;
				linkType: string;
				createdAt: number;
				deletedAt: number | null;
			}>;
		};
		expect(snap.entities.length).toBeGreaterThanOrEqual(4); // 1 proj + 2 task + 1 note
		expect(snap.links.length).toBeGreaterThan(0);

		// ── What Database would render from this real snapshot ──────────
		const built = buildVaultLists(snap);
		const taskList = built.lists.find((l) => l.name.includes("Task"));
		expect(taskList, "Database derives a Task list from the real vault").toBeTruthy();
		expect(built.lists.length).toBeGreaterThan(1); // per-type + "All vault items"
		expect(built.db.entities.length).toBe(snap.entities.length);

		// ── What Files would render from this real snapshot ────────────
		// Files scopes to File/Folder rows only — the seeded set (project +
		// tasks + note) carries none, so Files honestly shows just an empty
		// root rather than every vault object.
		const tree = buildVaultFileTree(snap.entities, "vault");
		expect(tree.length).toBe(1);
		expect(tree[0]?.properties.members).toEqual([]);
	});

	it("derives catalog-driven reference edges, carries `detail`, and hides the root folder", async () => {
		const install = await env.installer.install({ bundleDir: env.sourceDir });
		expect(install.ok).toBe(true);

		// Seed: a Company hub, a Person referencing it (post-promotion shape) +
		// a `links` entityRef, a regular user folder, and the shell-bootstrapped
		// root folder (must be hidden from the unified snapshot).
		const repo = new EntitiesRepository(await env.stores.open("entities"));
		const now = Date.now();
		repo.create({
			id: "co_brainstorm",
			type: "brainstorm/Company/v1",
			createdBy: "io.brainstorm.contacts",
			properties: { name: "Brainstorm" },
			dekId: null,
			now,
		});
		repo.create({
			id: "person_ada",
			type: "brainstorm/Person/v1",
			createdBy: "io.brainstorm.contacts",
			properties: { name: "Ada", company: "co_brainstorm", links: ["person_lin"] },
			dekId: null,
			now,
		});
		repo.create({
			id: "person_lin",
			type: "brainstorm/Person/v1",
			createdBy: "io.brainstorm.contacts",
			properties: { name: "Lin", company: "co_brainstorm" },
			dekId: null,
			now,
		});
		repo.create({
			id: "folder_user",
			type: "brainstorm/Folder/v1",
			createdBy: "io.brainstorm.files",
			properties: { name: "My folder", members: [] },
			dekId: null,
			now,
		});
		repo.create({
			id: "brainstorm/root-folder/v1",
			type: "brainstorm/Folder/v1",
			createdBy: "io.brainstorm.files",
			properties: { name: "Vault", members: ["folder_user"] },
			dekId: null,
			now,
		});

		const broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (app) => app === APP_ID,
			checkCapability: (app, _s, _m, caps) => caps.every((c) => env.ledger.has(app, c)),
		});
		broker.registerService(
			"vault-entities",
			makeVaultEntitiesServiceHandler({
				getVaultPath: () => env.vaultDir,
				getEntitiesRepo: async () => new EntitiesRepository(await env.stores.open("entities")),
				// The vault catalog: `company` + `links` are entityRef properties,
				// so the catalog-driven derivation must turn them into edges.
				getPropertyDefs: async () => [
					{
						key: "company",
						name: "Company",
						icon: null,
						valueType: ValueType.EntityRef,
						allowedTypes: ["brainstorm/Company/v1"],
					},
					{
						key: "links",
						name: "Links",
						icon: null,
						valueType: ValueType.EntityRef,
						allowedTypes: ["brainstorm/Person/v1"],
					},
				],
			}),
		);

		const reply = await broker.dispatch(
			makeEnvelope({
				msg: "m2",
				app: APP_ID,
				service: "vault-entities",
				method: "list",
				args: [],
				caps: ["entities.read:*"],
			}),
			"renderer",
		);
		if (!reply.ok) throw new Error(`list denied: ${reply.error.kind}`);
		const snap = reply.value as {
			entities: Array<{ id: string; type: string }>;
			links: Array<{
				sourceEntityId: string;
				destEntityId: string;
				linkType: string;
				detail?: string;
			}>;
		};

		// Root folder is infrastructure — never a vertex.
		expect(snap.entities.some((e) => e.id === "brainstorm/root-folder/v1")).toBe(false);
		// The real user folder still surfaces.
		expect(snap.entities.some((e) => e.id === "folder_user")).toBe(true);

		// Person → Company is a real reference edge (NOT a shared-attribute edge),
		// carrying the source property name as `detail`.
		const companyEdge = snap.links.find(
			(l) => l.sourceEntityId === "person_ada" && l.destEntityId === "co_brainstorm",
		);
		expect(companyEdge?.linkType).toBe("brainstorm/ref/brainstorm/Person/v1/company");
		expect(companyEdge?.detail).toBe("Company");
		expect(
			snap.links.some((l) => l.linkType.startsWith("brainstorm/shared-property/Person.company")),
		).toBe(false);

		// The generic `links` entityRef property also produces an edge.
		expect(
			snap.links.some(
				(l) =>
					l.sourceEntityId === "person_ada" &&
					l.destEntityId === "person_lin" &&
					l.linkType === "brainstorm/ref/brainstorm/Person/v1/links",
			),
		).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────
// Properties pipeline — the exact path the Notes "Add property" picker
// uses, end-to-end, with the LEGACY on-disk shape from the user's real
// vault (`brainstorm-Properties.ydoc` had `{…,"kind":"file"}` entries an
// older build wrote before the field became `valueType`). This is the
// reproduction that replaces the screenshot ping-pong: if the picker
// would read empty in production, THIS fails — deterministically.
// ─────────────────────────────────────────────────────────────────────────

const NOTES_APP_ID = "io.brainstorm.notes";
const notesManifest: AppManifest = {
	id: NOTES_APP_ID,
	name: "Notes",
	version: "0.1.0",
	sdk: "1",
	entry: "dist/index.html",
	// The load-bearing line: `properties.read` is what the SDK
	// `propertiesProxy.list()` envelope declares. Default-minimum, so the
	// real installer must grant it with no prompt.
	capabilities: ["storage.kv", "properties.read", "properties.write"],
	registrations: {},
};

/** Write the properties YDoc the way an OLD build left it: legacy `kind`
 *  entries (no `valueType`) + one already-canonical entry, persisted as a
 *  real snapshot file the production `PropertiesStore.open` will read. */
async function seedLegacyPropertiesDoc(vaultDir: string): Promise<void> {
	const doc = new Y.Doc();
	try {
		const props = doc.getMap<string>("properties");
		// Exactly the shapes found in the user's vault file.
		props.set(
			"prop_legacy_text",
			JSON.stringify({ key: "prop_legacy_text", name: "Test", icon: null, kind: "text" }),
		);
		props.set(
			"prop_legacy_file",
			JSON.stringify({ key: "prop_legacy_file", name: "Files", icon: null, kind: "file" }),
		);
		// A canonical row must keep working alongside the migrated ones.
		props.set("name", JSON.stringify({ key: "name", name: "Name", icon: null, valueType: "text" }));
		const yStore = new YDocStore(vaultDir);
		await yStore.writeSnapshot(PROPERTIES_DOC_ID, Y.encodeStateAsUpdate(doc));
	} finally {
		doc.destroy();
	}
}

type PropertiesSnapshotReply = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, unknown>;
};

describe("properties pipeline (real install → ledger → broker → PropertiesStore)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		await writeFile(join(env.sourceDir, "manifest.json"), JSON.stringify(notesManifest), "utf8");
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(env.sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	async function dispatchList() {
		const install = await env.installer.install({ bundleDir: env.sourceDir });
		expect(install.ok).toBe(true);
		// Default-minimum grant must be live for the Notes app.
		expect(env.ledger.has(NOTES_APP_ID, "properties.read")).toBe(true);

		const yStore = new YDocStore(env.vaultDir);
		const store = await PropertiesStore.open(yStore);

		const broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (app) => app === NOTES_APP_ID,
			checkCapability: (app, _s, _m, caps) => caps.every((c) => env.ledger.has(app, c)),
		});
		broker.registerService(
			"properties",
			makePropertiesServiceHandler({ getStore: async () => store }),
		);

		const reply = await broker.dispatch(
			makeEnvelope({
				msg: "p1",
				app: NOTES_APP_ID,
				service: "properties",
				method: "list",
				args: [],
				caps: ["properties.read"], // the exact propertiesProxy.list() cap hint
			}),
			"renderer",
		);
		await store.close();
		return reply;
	}

	it("legacy `kind` properties survive the real pipeline (picker is NOT empty)", async () => {
		await seedLegacyPropertiesDoc(env.vaultDir);
		const reply = await dispatchList();

		if (!reply.ok) {
			throw new Error(
				`properties.list DENIED in the real pipeline: kind=${reply.error.kind} — this is exactly the empty picker`,
			);
		}
		const snap = reply.value as PropertiesSnapshotReply;
		const keys = Object.keys(snap.properties);

		// The user's symptom was an EMPTY catalog. The whole point.
		expect(keys.length).toBeGreaterThan(0);
		expect(keys.sort()).toEqual(["name", "prop_legacy_file", "prop_legacy_text"]);

		// Legacy `kind:"text"` → canonical text valueType.
		expect(snap.properties.prop_legacy_text?.valueType).toBe("text");
		// Legacy `kind:"file"` is a PRESET, not a ValueType — must rebuild
		// to entityRef, not be dropped (the old naive rename would 404 it).
		expect(snap.properties.prop_legacy_file?.valueType).toBe("entityRef");
		// Canonical row untouched.
		expect(snap.properties.name?.valueType).toBe("text");

		// ── What the Notes "Add property" picker would actually render ──
		// The exact app-side transform: PropertiesProvider hands the
		// snapshot to PropertyStore.applySnapshot, the picker lists
		// filterProperties(store.values(), ""). If THIS is empty, the user
		// sees "no properties" — so this is the real reproduction surface.
		const store = new PropertyStore({
			backend: { setProperty: async () => {}, removeProperty: async () => {} },
		});
		store.applySnapshot(snap.properties);
		// `ready` must flip (picker shows "Loading…" until both stores
		// load) and the catalog the picker iterates must be non-empty.
		expect(store.isLoaded()).toBe(true);
		expect([...store.getSnapshot().keys()].sort()).toEqual([
			"name",
			"prop_legacy_file",
			"prop_legacy_text",
		]);
	});

	it("an all-legacy catalog still yields a non-empty picker", async () => {
		// No canonical rows at all — the migration alone must keep the
		// picker populated, or the user sees "no properties" forever.
		const doc = new Y.Doc();
		try {
			doc
				.getMap<string>("properties")
				.set("p_only", JSON.stringify({ key: "p_only", name: "Solo", icon: null, kind: "url" }));
			await new YDocStore(env.vaultDir).writeSnapshot(PROPERTIES_DOC_ID, Y.encodeStateAsUpdate(doc));
		} finally {
			doc.destroy();
		}

		const reply = await dispatchList();
		if (!reply.ok) throw new Error(`DENIED: ${reply.error.kind}`);
		const snap = reply.value as PropertiesSnapshotReply;
		expect(Object.keys(snap.properties)).toEqual(["p_only"]);
		// URL preset → text valueType + a url format (canonical).
		expect(snap.properties.p_only?.valueType).toBe("text");
	});
});

// Y.Doc-source-of-truth pipeline (Phases 1+2): proves that a write through
// the REAL entities service + REAL ydoc worker lands in the entity's Y.Doc
// (the source of truth) and is materialised into entities.db (the derived
// index) — AND survives the worker dropping its in-memory replica, i.e. the
// projection is reconstructable from the on-disk Y.Doc alone. This is the
// load-bearing assumption behind retiring the per-app kv.json silos: object
// state lives in the Y.Doc, and the SQLite row is just its fast projection.
describe("Y.Doc → entities.db pipeline (real entities service + real ydoc worker)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		__ydocCacheResetForTest();
	});
	afterEach(async () => {
		__ydocCacheResetForTest();
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(env.sourceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	async function makeService() {
		const repo = new EntitiesRepository(await env.stores.open("entities"));
		const dekStore = new EntityDekStore(
			new EntityDeksRepository(await env.stores.open("entities")),
			generateSymmetricKey(),
		);
		const handler = makeEntitiesServiceHandler({
			getRepo: async () => repo,
			getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
			getDekStore: async () => dekStore,
			newId: () => `ent_${Math.random().toString(36).slice(2)}`,
			getVaultPath: () => env.vaultDir,
			// The REAL ydoc worker handler — same code path as production,
			// routed in-process (the parentPort listener is skipped in Vitest).
			ydoc: async (method, a) => {
				const reply = await handleYDocEnvelope({
					v: 1,
					msg: "y",
					app: "io.brainstorm.shell",
					service: "ydoc",
					method,
					args: [a],
					caps: [],
				});
				if (!reply.ok) throw new Error(`ydoc.${method} failed: ${reply.error.message}`);
				return reply.value;
			},
		});
		return { handler, repo };
	}

	const call = (
		handler: Awaited<ReturnType<typeof makeService>>["handler"],
		method: string,
		arg: unknown,
	) => handler({ v: 1, msg: "m", app: "io.x", service: "entities", method, args: [arg], caps: [] });

	it("create + update flow through the Y.Doc and project into entities.db", async () => {
		const { handler, repo } = await makeService();
		const made = (await call(handler, "create", {
			type: "brainstorm/Task/v1",
			properties: { title: "Ship it", statusKey: "todo" },
		})) as { id: string };

		await call(handler, "update", { id: made.id, patch: { statusKey: "done" } });

		// The row is the projection of the doc.
		expect(repo.get(made.id)?.properties).toMatchObject({ title: "Ship it", statusKey: "done" });

		// The Y.Doc on disk is the source of truth: drop the worker's
		// in-memory replica and reload from the persisted tail.
		__ydocCacheResetForTest();
		const reloaded = (await handleYDocEnvelope({
			v: 1,
			msg: "y",
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "load",
			args: [{ vaultPath: env.vaultDir, entityId: made.id }],
			caps: [],
		})) as { ok: true; value: { snapshotB64: string } } | { ok: false };
		if (!("value" in reloaded)) throw new Error("reload failed");
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Buffer.from(reloaded.value.snapshotB64, "base64"));
		expect(readEntityDocProjection(doc).properties).toMatchObject({
			title: "Ship it",
			statusKey: "done",
		});
	});

	it("a freshly-cleared entities.db is rebuilt from the on-disk Y.Doc via applyDoc", async () => {
		const { handler, repo } = await makeService();
		const made = (await call(handler, "create", {
			type: "brainstorm/Task/v1",
			properties: { title: "Persisted" },
		})) as { id: string };

		// Simulate the documented "indexes are rebuilt on each device": wipe
		// the projected row, then a doc edit re-materialises it.
		repo.softDelete(made.id, Date.now());
		repo.hardDelete(made.id);
		expect(repo.get(made.id)).toBeNull();
		// Re-create the row shell (id reuse) the way a rebuild would, then let
		// a doc-routed update reproject the live doc state into it.
		repo.create({
			id: made.id,
			type: "brainstorm/Task/v1",
			properties: {},
			createdBy: "io.x",
			now: Date.now(),
			dekId: null,
		});
		await call(handler, "update", { id: made.id, patch: { statusKey: "open" } });
		expect(repo.get(made.id)?.properties).toMatchObject({ title: "Persisted", statusKey: "open" });
	});

	// Reproduces the Books import path: import creates a `File/v1` then a
	// `Book/v1` (explicit id) through the entities SERVICE, and the book must
	// (a) show up in `vaultEntities.list()` and (b) survive a fresh repo over
	// the same entities.db. Guards "imported book disappeared after restart".
	it("an imported Book/v1 lists via vaultEntities and survives a fresh repo (restart)", async () => {
		const { handler, repo } = await makeService();
		const file = (await call(handler, "create", {
			type: "brainstorm/File/v1",
			properties: { name: "lotr.pdf", attachment: "brainstorm://asset/abc", mime: "application/pdf" },
		})) as { id: string };
		const bookId = "bk_repro_1";
		await call(handler, "create", {
			type: "brainstorm/Book/v1",
			id: bookId,
			properties: {
				id: bookId,
				name: "The Lord of the Rings",
				format: "pdf",
				fileId: file.id,
				spineLength: 0,
				reading: { position: null, progress: 0, lastReadAt: null },
				createdAt: 1,
				updatedAt: 1,
			},
		});

		const vaultEntities = makeVaultEntitiesServiceHandler({
			getVaultPath: () => env.vaultDir,
			getEntitiesRepo: async () => repo,
		});
		const snap = (await vaultEntities({
			v: 1,
			msg: "m",
			app: "io.x",
			service: "vault-entities",
			method: "list",
			args: [],
			caps: [],
		})) as { entities: Array<{ id: string; type: string }> };
		expect(snap.entities.find((e) => e.id === bookId)?.type).toBe("brainstorm/Book/v1");

		const freshRepo = new EntitiesRepository(await env.stores.open("entities"));
		expect(freshRepo.get(bookId)?.type).toBe("brainstorm/Book/v1");
	});

	// Phase 5 lazy hydration, end-to-end through the REAL worker: a seeder /
	// legacy-backfilled entity (full row, EMPTY Y.Doc) gets its complete
	// property set hydrated into the Y.Doc on the first edit — so the Y.Doc
	// the future sync ships carries the whole object, not just the patch.
	it("first edit of a seeded row (empty Y.Doc) hydrates the full property set into the Y.Doc", async () => {
		const { handler, repo } = await makeService();
		// Simulate writeVaultEntities / kv-backfill: row written straight to
		// entities.db, no Y.Doc.
		repo.create({
			id: "seed-task-1",
			type: "brainstorm/Task/v1",
			properties: { title: "Ship release", statusKey: "todo", priority: 1, projectId: "p1" },
			createdBy: "io.brainstorm.tasks",
			now: 1,
			dekId: null,
		});

		// The on-disk Y.Doc is empty before any edit.
		const before = (await handleYDocEnvelope({
			v: 1,
			msg: "y",
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "load",
			args: [{ vaultPath: env.vaultDir, entityId: "seed-task-1" }],
			caps: [],
		})) as { ok: true; value: { snapshotB64: string } } | { ok: false };
		if (!("value" in before)) throw new Error("load failed");
		const beforeDoc = new Y.Doc();
		Y.applyUpdate(beforeDoc, Buffer.from(before.value.snapshotB64, "base64"));
		expect(beforeDoc.getMap("brainstorm.props").size).toBe(0);

		// First edit: toggle status.
		await call(handler, "update", { id: "seed-task-1", patch: { statusKey: "done" } });

		// The persisted Y.Doc now holds the FULL set (hydrated), patch applied.
		__ydocCacheResetForTest();
		const after = (await handleYDocEnvelope({
			v: 1,
			msg: "y",
			app: "io.brainstorm.shell",
			service: "ydoc",
			method: "load",
			args: [{ vaultPath: env.vaultDir, entityId: "seed-task-1" }],
			caps: [],
		})) as { ok: true; value: { snapshotB64: string } } | { ok: false };
		if (!("value" in after)) throw new Error("reload failed");
		const afterDoc = new Y.Doc();
		Y.applyUpdate(afterDoc, Buffer.from(after.value.snapshotB64, "base64"));
		expect(afterDoc.getMap("brainstorm.props").toJSON()).toEqual({
			title: "Ship release",
			statusKey: "done",
			priority: 1,
			projectId: "p1",
		});
		// And the row stays consistent.
		expect(repo.get("seed-task-1")?.properties).toMatchObject({
			title: "Ship release",
			statusKey: "done",
		});
	});
});

/**
 * Cross-app open-routing fence (9.18.7): an `open` dispatched for ANY
 * body-bearing first-party entity type — a clicked `@`-mention, a search
 * hit, a graph node — must reach that type's registered PRIMARY opener.
 * The plumbing is real end-to-end-in-process: the apps' REAL manifest.json
 * files install through the real `AppInstaller` into a real registry.db,
 * and resolution runs through the real `IntentsBus` over the real
 * `OpenersRepository`. A manifest that drops an opener, an installer that
 * stops writing opener rows, or a bus that stops merging opener handlers
 * fails here with the exact type that broke.
 */
describe("cross-app open-routing fence (9.18.7)", () => {
	/** type → its registered primary opener, per each app's manifest.json. */
	const PRIMARY_OPENERS: ReadonlyArray<{ appId: string; entityType: string }> = [
		{ appId: "io.brainstorm.notes", entityType: "io.brainstorm.notes/Note/v1" },
		{ appId: "io.brainstorm.tasks", entityType: "brainstorm/Task/v1" },
		{ appId: "io.brainstorm.calendar", entityType: "brainstorm/Event/v1" },
		{ appId: "io.brainstorm.bookmarks", entityType: "brainstorm/Bookmark/v1" },
		{ appId: "io.brainstorm.whiteboard", entityType: "brainstorm/Whiteboard/v1" },
		{ appId: "io.brainstorm.files", entityType: "brainstorm/Folder/v1" },
		{ appId: "io.brainstorm.code-editor", entityType: "brainstorm/CodeFile/v1" },
		{ appId: "io.brainstorm.journal", entityType: "io.brainstorm.journal/Entry/v1" },
	];
	const GENERIC_VIEWER = "io.brainstorm.notes";
	const APPS_DIR = fileURLToPath(new URL("../../../../../apps", import.meta.url));

	let vaultDir: string;
	let bundleRoot: string;
	let stores: DataStores;
	let bus: IntentsBus;
	let launches: Array<{ appId: string }>;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-open-fence-"));
		bundleRoot = await mkdtemp(join(tmpdir(), "bs-open-fence-src-"));
		stores = new DataStores(vaultDir);
		const ledger = new CapabilityLedger(await stores.open("ledger"));
		const registryDb = await stores.open("registry");
		const installer = new AppInstaller(vaultDir, registryDb, ledger);

		// Install each app from its REAL manifest (stub dist — the openers
		// table only needs the manifest registrations; a missing block bundle
		// degrades to the fallback card by design).
		for (const { appId } of PRIMARY_OPENERS) {
			const sourceManifest = await readFile(
				join(APPS_DIR, appId.replace("io.brainstorm.", ""), "manifest.json"),
				"utf8",
			);
			const bundleDir = join(bundleRoot, appId);
			await mkdir(join(bundleDir, "dist"), { recursive: true });
			await writeFile(join(bundleDir, "manifest.json"), sourceManifest, "utf8");
			await writeFile(join(bundleDir, "dist", "index.html"), "<!doctype html>", "utf8");
			const result = await installer.install({ bundleDir });
			expect(result.ok, `${appId} manifest must install`).toBe(true);
		}

		const repos = new RegistryRepositories(registryDb);
		const collected: Array<{ appId: string }> = [];
		launches = collected;
		const orchestrator = {
			launch: vi.fn(async (req: { appId: string }): Promise<AppWindow> => {
				collected.push({ appId: req.appId });
				return {
					appId: req.appId,
					windowId: "main",
					tabId: "tab-1",
					webContentsId: 7,
					parked: false,
					webContents: {} as AppWindow["webContents"],
					container: {} as AppWindow["container"],
				} as AppWindow;
			}),
		} as unknown as LaunchOrchestrator;
		bus = new IntentsBus({
			intents: repos.intents,
			orchestrator,
			openers: repos.openers,
			genericEntityViewerAppId: GENERIC_VIEWER,
		});
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(bundleRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("every first-party type's `open` suggests its primary opener first", async () => {
		for (const { appId, entityType } of PRIMARY_OPENERS) {
			const suggestions = await bus.suggest({ verb: "open", payload: { entityType } });
			expect(suggestions[0]?.appId, `open(${entityType})`).toBe(appId);
			expect(suggestions[0]?.priority, `open(${entityType})`).toBe("primary");
		}
	});

	it("dispatching open from another app launches the type's primary opener", async () => {
		for (const { appId, entityType } of PRIMARY_OPENERS) {
			launches.length = 0;
			const result = await bus.dispatch(
				{ verb: "open", payload: { entityType, entityId: "ent_fence" } },
				{ app: "io.brainstorm.graph" },
			);
			expect(result.handled, `open(${entityType})`).toBe(true);
			expect(
				launches.map((l) => l.appId),
				`open(${entityType})`,
			).toEqual([appId]);
		}
	});

	it("an unclaimed typed entity falls back to the generic viewer (Person → Notes)", async () => {
		// A real vault type that no installed app claims an opener for (Person
		// is owned by the Contacts provider, surfaced only as a curated List in
		// Database) still opens — in the generic object editor (Notes) — rather
		// than nowhere. (Journal/Entry is NOT this case anymore: Journal claims
		// its own primary opener so linked entries open in Journal.)
		const suggestions = await bus.suggest({
			verb: "open",
			payload: { entityType: "brainstorm/Person/v1" },
		});
		expect(suggestions[0]?.appId).toBe(GENERIC_VIEWER);
	});
});

/**
 * 13.10 — packaged-app upgrade path through the FULL pipeline.
 *
 * Reproduces the Mailbox-5 stale-app bug end-to-end: a vault holds an
 * already-registered app at an OLD manifest version that lacks a capability
 * the NEW bundled manifest declares. The packaged seeder must (1) leave a
 * fresh install alone, (2) on the next boot detect the version bump, route it
 * through `AppInstaller.update()`, and grant the new cap — so the exact
 * service envelope that was DENIED before the upgrade is ALLOWED after it.
 *
 * Without the fix, `bootstrapApps` skipped the registered app outright:
 * the upgrade never happened, the cap was never granted, and the new service
 * call failed `Denied` (demo data / broken feature). This test fails on the
 * old skip-everything seeder and passes on the compare-and-update one.
 */
const UPGRADE_APP: FirstPartyApp = {
	dir: "mailish",
	label: "Mailish",
	expectedAppId: "io.brainstorm.mailish",
};

/** The cap added by the new bundle — Mailbox-5's `mail.manage` literally. It's
 *  a distinct *capability* (not a scoped form of any wildcard the old bundle
 *  held), so the old grant set cannot cover it. */
const NEW_CAP = "mail.manage";

function upgradeManifest(version: string, capabilities: string[]): AppManifest {
	return {
		id: UPGRADE_APP.expectedAppId,
		name: UPGRADE_APP.label,
		version,
		sdk: "1",
		entry: "dist/index.html",
		capabilities,
		registrations: {},
	};
}

/** Dashboard shim: only the methods the seeder touches. */
function fakeDashboard(): DashboardStore {
	const icons: Record<string, { x: number; y: number; target: string }> = {};
	return {
		snapshot: () => ({ icons }),
		upsertIcon: (id: string, record: { x: number; y: number; target: string }) => {
			icons[id] = record;
		},
		isAppIconDismissed: () => false,
		batch: <T>(fn: () => Promise<T> | T) => Promise.resolve(fn()),
	} as unknown as DashboardStore;
}

describe("packaged-app upgrade path (13.10 — stale install → seed-upgrade → broker allows)", () => {
	let vaultDir: string;
	let appsRoot: string;
	let stores: DataStores;
	let ledger: CapabilityLedger;
	let installer: AppInstaller;
	let appsRepo: AppsRepository;

	async function writeBundle(version: string, capabilities: string[], body: string): Promise<void> {
		const dir = join(appsRoot, UPGRADE_APP.dir);
		await mkdir(join(dir, "dist"), { recursive: true });
		await writeFile(
			join(dir, "manifest.json"),
			JSON.stringify(upgradeManifest(version, capabilities)),
			"utf8",
		);
		await writeFile(join(dir, "dist", "index.html"), body, "utf8");
	}

	async function seed() {
		return bootstrapApps({
			appsRoot,
			appsRepo,
			installer,
			dashboard: fakeDashboard(),
			apps: [UPGRADE_APP],
		});
	}

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "bs-upgrade-vault-"));
		appsRoot = await mkdtemp(join(tmpdir(), "bs-upgrade-root-"));
		stores = new DataStores(vaultDir);
		ledger = new CapabilityLedger(await stores.open("ledger"));
		installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
		appsRepo = new AppsRepository(await stores.open("registry"));
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
		await rm(appsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("the stale app is DENIED before upgrade, then the seed-upgrade grants the new cap and the broker ALLOWS", async () => {
		// Ship the OLD bundle (lacks NEW_CAP), seed it: fresh install.
		await writeBundle("0.0.9", ["entities.read:*"], "<!doctype html><html>v1</html>");
		const first = await seed();
		expect(first.installed).toEqual([UPGRADE_APP.expectedAppId]);
		expect(ledger.has(UPGRADE_APP.expectedAppId, NEW_CAP)).toBe(false);

		// A call requiring the NEW cap is DENIED against the stale grant set —
		// production-equivalent checkCapability (every declared cap must be live).
		const broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (app) => app === UPGRADE_APP.expectedAppId,
			checkCapability: (app, _s, _m, caps) => caps.every((c) => ledger.has(app, c)),
		});
		broker.registerService(
			"vault-entities",
			makeVaultEntitiesServiceHandler({
				getVaultPath: () => vaultDir,
				getEntitiesRepo: async () => new EntitiesRepository(await stores.open("entities")),
			}),
		);
		const envelopeWithNewCap = makeEnvelope({
			msg: "u1",
			app: UPGRADE_APP.expectedAppId,
			service: "vault-entities",
			method: "list",
			args: [],
			caps: [NEW_CAP],
		});
		const denied = await broker.dispatch(envelopeWithNewCap, "renderer");
		expect(denied.ok).toBe(false);

		// Ship the NEW bundle (version bump + NEW_CAP), re-seed: upgrade fires.
		await writeBundle("0.1.0", ["entities.read:*", NEW_CAP], "<!doctype html><html>v2</html>");
		const second = await seed();
		expect(second.upgraded).toEqual([UPGRADE_APP.expectedAppId]);
		expect(second.installed).toEqual([]);
		expect(second.skipped).toEqual([]);
		expect(second.errors).toEqual([]);

		// The new cap is now a live grant AND the registry row moved to 0.1.0.
		expect(ledger.has(UPGRADE_APP.expectedAppId, NEW_CAP)).toBe(true);
		expect(appsRepo.getActive(UPGRADE_APP.expectedAppId)?.version).toBe("0.1.0");

		// The SAME envelope that was DENIED is now ALLOWED through the real broker.
		const allowed = await broker.dispatch(envelopeWithNewCap, "renderer");
		if (!allowed.ok) {
			throw new Error(
				`post-upgrade envelope still DENIED: kind=${allowed.error.kind} — the upgrade did not grant ${NEW_CAP}`,
			);
		}
		expect(allowed.ok).toBe(true);
	});

	it("an unchanged bundle on the next boot is skipped (no redundant update)", async () => {
		await writeBundle("0.0.9", ["entities.read:*"], "<!doctype html><html>same</html>");
		await seed();
		const second = await seed();
		expect(second.skipped).toEqual([UPGRADE_APP.expectedAppId]);
		expect(second.upgraded).toEqual([]);
		expect(second.installed).toEqual([]);
	});
});
