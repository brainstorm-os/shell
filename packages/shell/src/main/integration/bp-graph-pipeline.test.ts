/**
 * BP Graph integration test — 9.3.3.2.
 *
 * Drives the BP Graph router through the SAME pipeline a real app would
 * exercise: real `AppInstaller` populates the real `CapabilityLedger`
 * with type-scoped `entities.read:` / `entities.write:` grants; real
 * `Broker` with production-equivalent `checkCapability`; real
 * `entities` service handler over a real `entities.db`; the new `bp`
 * service handler with a real `BpGraphRouter`.
 *
 * The verification claim: a BP `createEntity` / `getEntity` /
 * `updateEntity` / `queryEntities` / `deleteEntity` round-trip
 * through `bp.dispatch` end-to-end produces the BP-shape responses the
 * block expects, with all capability gates real.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { AppInstaller } from "../apps/installer";
import type { AppManifest } from "../apps/manifest";
import { BpModule, BpSource } from "../bp/envelope";
import { makeBpGraphRouter } from "../bp/graph-router";
import { makeBpHookRouter } from "../bp/hook-router";
import { makeBpRouter } from "../bp/router";
import { CapabilityLedger } from "../capabilities/ledger";
import { generateSymmetricKey } from "../credentials/crypto";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { EntityDeksRepository } from "../storage/entities-repo/entity-deks-repo";

const APP_ID = "io.example.bp-test";
const ALLOWED_TYPE = "io.example/Note/v1";
const FORBIDDEN_TYPE = "io.example/Secret/v1";

const manifest: AppManifest = {
	id: APP_ID,
	name: "BP Test",
	version: "0.1.0",
	sdk: "1",
	entry: "dist/index.html",
	capabilities: [`entities.read:${ALLOWED_TYPE}`, `entities.write:${ALLOWED_TYPE}`],
	registrations: {},
};

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-bp-graph-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "bs-bp-graph-src-"));
	await mkdir(sourceDir, { recursive: true });
	await writeFile(join(sourceDir, "manifest.json"), JSON.stringify(manifest), "utf8");
	await mkdir(join(sourceDir, "dist"), { recursive: true });
	await writeFile(join(sourceDir, "dist", "index.html"), "<!doctype html>", "utf8");

	const stores = new DataStores(vaultDir);
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const installer = new AppInstaller(vaultDir, await stores.open("registry"), ledger);
	await installer.install({ bundleDir: sourceDir });

	const masterKey = generateSymmetricKey();
	const entitiesHandler = makeEntitiesServiceHandler({
		getRepo: async () => new EntitiesRepository(await stores.open("entities")),
		getLedger: async () => ledger,
		getDekStore: async () =>
			new EntityDekStore(new EntityDeksRepository(await stores.open("entities")), masterKey),
		newId: (() => {
			let n = 0;
			return () => `ent_test_${(++n).toString(36)}`;
		})(),
		now: () => 1_700_000_000_000,
	});

	const bpGraph = makeBpGraphRouter({
		entities: (envelope) => entitiesHandler(envelope),
	});
	const bpHook = makeBpHookRouter();
	const bpRouter = makeBpRouter({
		graph: bpGraph,
		hook: bpHook,
		now: () => 1_700_000_000_000,
	});

	const broker = new Broker({
		services: new Map(),
		verifyAppIdentity: (app) => app === APP_ID,
		// Production-equivalent: every declared cap must be a live ledger grant.
		checkCapability: (app, _s, _m, caps) => caps.every((c) => ledger.has(app, c)),
	});
	broker.registerService("entities", async (envelope) => entitiesHandler(envelope));
	broker.registerService("bp", async (envelope) => {
		const a = envelope.args[0] as { entityId: string; payload: unknown };
		return await bpRouter({ app: envelope.app, entityId: a.entityId }, a.payload);
	});

	return { vaultDir, sourceDir, stores, ledger, broker };
}

function bpRequest(messageName: string, data: unknown, module: BpModule = BpModule.Graph) {
	return {
		requestId: `rq_${messageName}`,
		messageName,
		module,
		source: BpSource.Block,
		timestamp: "2026-05-21T00:00:00.000Z",
		data,
	};
}

async function dispatchBp(
	broker: Awaited<ReturnType<typeof setup>>["broker"],
	messageName: string,
	data: unknown,
	module: BpModule = BpModule.Graph,
) {
	const reply = await broker.dispatch(
		makeEnvelope({
			msg: `m_${messageName}_${Math.random().toString(36).slice(2, 8)}`,
			app: APP_ID,
			service: "bp",
			method: "dispatch",
			args: [{ entityId: "ent_embed_host", payload: bpRequest(messageName, data, module) }],
			caps: [],
		}),
		"renderer",
	);
	if (!reply.ok) throw new Error(`bp.dispatch broker error: ${JSON.stringify(reply.error)}`);
	return reply.value as {
		requestId: string;
		messageName: string;
		module: string;
		source: string;
		data?: unknown;
		errors?: ReadonlyArray<{ code: string; message: string }>;
	};
}

describe("BP Graph through the real broker + entities pipeline", () => {
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

	it("createEntity for a granted type round-trips through the real ledger + entities-service", async () => {
		const response = await dispatchBp(env.broker, "createEntity", {
			entityTypeId: ALLOWED_TYPE,
			properties: { title: "Hello BP" },
		});
		expect(response.messageName).toBe("createEntityResponse");
		expect(response.errors).toBeUndefined();
		const created = response.data as {
			entityId: string;
			entityTypeId: string;
			properties: { title: string };
		};
		expect(created.entityTypeId).toBe(ALLOWED_TYPE);
		expect(created.properties.title).toBe("Hello BP");
		expect(created.entityId).toMatch(/^ent_test_/);
	});

	it("createEntity for a NON-granted type returns BP FORBIDDEN (real capability gate)", async () => {
		const response = await dispatchBp(env.broker, "createEntity", {
			entityTypeId: FORBIDDEN_TYPE,
			properties: { title: "secret" },
		});
		expect(response.errors).toHaveLength(1);
		expect(response.errors?.[0]?.code).toBe("FORBIDDEN");
		expect(response.data).toBeUndefined();
	});

	it("getEntity round-trips after a create", async () => {
		const created = (
			await dispatchBp(env.broker, "createEntity", {
				entityTypeId: ALLOWED_TYPE,
				properties: { title: "First" },
			})
		).data as { entityId: string };

		const got = await dispatchBp(env.broker, "getEntity", { entityId: created.entityId });
		expect(got.errors).toBeUndefined();
		const wire = got.data as { entityId: string; properties: { title: string } };
		expect(wire.entityId).toBe(created.entityId);
		expect(wire.properties.title).toBe("First");
	});

	it("getEntity for a missing id returns BP NOT_FOUND", async () => {
		const got = await dispatchBp(env.broker, "getEntity", { entityId: "ent_never" });
		expect(got.errors?.[0]?.code).toBe("NOT_FOUND");
	});

	it("updateEntity replaces the properties through entities.update", async () => {
		const created = (
			await dispatchBp(env.broker, "createEntity", {
				entityTypeId: ALLOWED_TYPE,
				properties: { title: "Before" },
			})
		).data as { entityId: string };

		const updated = await dispatchBp(env.broker, "updateEntity", {
			entityId: created.entityId,
			entityTypeId: ALLOWED_TYPE,
			properties: { title: "After" },
		});
		expect(updated.errors).toBeUndefined();
		expect((updated.data as { properties: { title: string } }).properties.title).toBe("After");

		const got = await dispatchBp(env.broker, "getEntity", { entityId: created.entityId });
		expect((got.data as { properties: { title: string } }).properties.title).toBe("After");
	});

	it("queryEntities by entityTypeId returns a BP subgraph of just the granted type", async () => {
		await dispatchBp(env.broker, "createEntity", {
			entityTypeId: ALLOWED_TYPE,
			properties: { title: "A" },
		});
		await dispatchBp(env.broker, "createEntity", {
			entityTypeId: ALLOWED_TYPE,
			properties: { title: "B" },
		});
		const queried = await dispatchBp(env.broker, "queryEntities", {
			operation: { entityTypeId: ALLOWED_TYPE },
		});
		expect(queried.errors).toBeUndefined();
		const result = queried.data as {
			results: { roots: string[]; vertices: Record<string, [{ properties: { title: string } }]> };
		};
		expect(result.results.roots).toHaveLength(2);
		const titles = result.results.roots
			.map((id) => result.results.vertices[id]?.[0]?.properties.title)
			.sort();
		expect(titles).toEqual(["A", "B"]);
	});

	it("deleteEntity soft-deletes the row and subsequent getEntity returns NOT_FOUND", async () => {
		const created = (
			await dispatchBp(env.broker, "createEntity", {
				entityTypeId: ALLOWED_TYPE,
				properties: { title: "Will-be-gone" },
			})
		).data as { entityId: string };

		const deleted = await dispatchBp(env.broker, "deleteEntity", created.entityId);
		expect(deleted.errors).toBeUndefined();
		expect(deleted.data).toBe(true);

		const got = await dispatchBp(env.broker, "getEntity", { entityId: created.entityId });
		expect(got.errors?.[0]?.code).toBe("NOT_FOUND");
	});

	it("uploadFile returns BP NOT_IMPLEMENTED (v1 deferral — OQ-BP-3)", async () => {
		const response = await dispatchBp(env.broker, "uploadFile", {
			url: "https://example.test/a.png",
			name: "a.png",
		});
		expect(response.errors?.[0]?.code).toBe("NOT_IMPLEMENTED");
	});
});

describe("BP Hook through the real broker (router is wired, overlay is OQ-BP-5)", () => {
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

	it("destroy (`node: null` + hookId) returns OK idempotently", async () => {
		const response = await dispatchBp(
			env.broker,
			"hook",
			{ type: "text", entityId: "ent_42", path: "$.body", hookId: "hk_1", node: null },
			BpModule.Hook,
		);
		expect(response.messageName).toBe("hookResponse");
		expect(response.errors).toBeUndefined();
		expect(response.data).toEqual({ hookId: "hk_1" });
	});

	it("real hook registration returns NOT_IMPLEMENTED + OQ-BP-5 pointer", async () => {
		const response = await dispatchBp(
			env.broker,
			"hook",
			{ type: "text", entityId: "ent_42", path: "$.body", hookId: null, node: {} },
			BpModule.Hook,
		);
		expect(response.errors?.[0]?.code).toBe("NOT_IMPLEMENTED");
		expect(response.errors?.[0]?.message).toMatch(/OQ-BP-5/);
	});

	it("malformed hook (missing type) returns INVALID_INPUT through the broker", async () => {
		const response = await dispatchBp(
			env.broker,
			"hook",
			{ entityId: "ent_42", path: "$.body", hookId: null, node: {} },
			BpModule.Hook,
		);
		expect(response.errors?.[0]?.code).toBe("INVALID_INPUT");
	});
});
