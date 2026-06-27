/**
 * In-process integration test (CLAUDE.md §4) for the Connector sync engine
 * spine: a scheduled `SyncMapping` fire → `connectors.sync(mappingRef)` →
 * an external pull (stubbed) → idempotent projection of the resources into
 * **real** `Task/v1` rows in `entities.db` → a `SyncRun/v1` provenance row.
 * Proves the Connector-4 path (riding the real `SchedulerService` +
 * `AutomationsHost` + entities service) without a live Electron shell.
 *
 * The highest-risk invariant is pinned here: a SECOND identical fire
 * produces NO duplicate Tasks (upsert on the flat `connectorExternalId`),
 * and `external-wins` overwrites a vault edit on re-pull.
 *
 * Connector-5: the two-way leg is proven against the same real entities
 * service — a vault edit writes back to the (stubbed) provider exactly
 * once, without clobbering the local value or duplicating mirrors.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONNECTOR_TYPE_URL,
	ConflictPolicy,
	SYNC_RUN_TYPE_URL,
	SyncDirection,
	SyncRunStatus,
} from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { AutomationsHost } from "../automations/automations-host";
import { ReminderRunner } from "../automations/reminder-runner";
import { SchedulerService } from "../automations/scheduler-service";
import type { CapabilityLedger as CapabilityLedgerType } from "../capabilities/ledger";
import {
	type ConnectorsSyncDeps,
	type SyncContext,
	makeConnectorsSync,
} from "../connectors/connectors-sync-service";
import { CONNECTOR_EXTERNAL_ID_PROP } from "../connectors/sync-runner";
import { generateSymmetricKey } from "../credentials/crypto";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";

function fakeLedger(grants: string[]): CapabilityLedgerType {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
	} as unknown as CapabilityLedgerType;
}

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);
const DAY = 86_400_000;
const CONNECTOR_APP = "io.brainstorm.github-issues";
const TASK_TYPE = "brainstorm/Task/v1";

const issuePage = [
	{ id: 1, title: "First issue", state: "open", updated_at: "2026-06-01T00:00:00Z" },
	{ id: 2, title: "Second issue", state: "closed", updated_at: "2026-06-02T00:00:00Z" },
];

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-connectors-"));
	const stores = new DataStores(vaultDir);
	const repo = new EntitiesRepository(await stores.open("entities"));
	const dekStore = new EntityDekStore(
		new EntityDeksRepository(await stores.open("entities")),
		generateSymmetricKey(),
	);

	let idSeq = 0;
	const entitiesHandler = makeEntitiesServiceHandler({
		getRepo: async () => repo,
		getLedger: async () => fakeLedger(["entities.read:*", "entities.write:*"]),
		getDekStore: async () => dekStore,
		newId: () => {
			idSeq += 1;
			return `ent_${idSeq}`;
		},
		getVaultPath: () => vaultDir,
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

	const entities = (method: string, arg: unknown) =>
		entitiesHandler({
			v: 1,
			msg: "m",
			app: CONNECTOR_APP,
			service: "entities",
			method,
			args: [arg],
			caps: ["entities.read:*", "entities.write:*"],
		});

	const mapping: SyncContext["mapping"] = {
		mappingId: "mapping-1",
		accountRef: "account-1",
		externalKind: "github:issue",
		entityType: TASK_TYPE,
		fieldMap: { title: "title", status: "state" },
		direction: SyncDirection.Pull,
		conflictPolicy: ConflictPolicy.ExternalWins,
		egressOrigins: ["https://api.github.com"],
		pull: {
			path: "/repos/o/r/issues",
			externalIdField: "id",
			cursorParam: "since",
			cursorField: "updated_at",
		},
	};

	const cursors: Record<string, unknown>[] = [];
	const requests: Array<{ method: string; path: string; body?: unknown }> = [];
	const syncDeps: ConnectorsSyncDeps = {
		resolveMapping: async () => ({
			mapping,
			connectorAppId: CONNECTOR_APP,
			apiBaseUrl: "https://api.github.com",
		}),
		// Stub the external provider — the substrate's connectors.request is
		// proven by its own tests; here we feed the engine canned issues and
		// capture Connector-5 write-backs.
		request: async ({ method, path, body }) => {
			requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
			return method === "GET" ? issuePage : { ok: true };
		},
		findByExternalId: async (entityType, key) => {
			const rows = (await entities("query", { query: { type: entityType } })) as Array<{
				id: string;
				properties: Record<string, unknown>;
			}>;
			return rows.find((r) => r.properties[CONNECTOR_EXTERNAL_ID_PROP] === key)?.id ?? null;
		},
		// Connector-5 ports — same repo-backed shape as the production wiring.
		getEntity: async (id) => {
			const row = repo.get(id);
			return row ? { id: row.id, properties: row.properties, updatedAt: row.updatedAt } : null;
		},
		listByExternalIdPrefix: async (entityType, prefix) => {
			const out = [];
			for (const id of repo.idsByTypes([entityType])) {
				const row = repo.get(id);
				const key = row?.properties[CONNECTOR_EXTERNAL_ID_PROP];
				if (!row || typeof key !== "string" || !key.startsWith(prefix)) continue;
				out.push({ id: row.id, properties: row.properties, updatedAt: row.updatedAt });
			}
			return out;
		},
		createEntity: async (_app, type, properties) =>
			(await entities("create", { type, properties })) as { id: string },
		updateEntity: async (_app, id, patch) => {
			await entities("update", { id, patch });
		},
		persistSyncRun: async (_app, def) => {
			await entities("create", { type: SYNC_RUN_TYPE_URL, properties: def });
		},
		advanceCursor: async (_id, cursor) => {
			cursors.push(cursor);
		},
		now: () => T0,
	};

	const connectorSync = makeConnectorsSync(syncDeps);

	const host = new AutomationsHost({
		scheduler: new SchedulerService({ loadAll: () => [], save: () => {}, remove: () => {} }),
		reminderRunner: new ReminderRunner({
			store: { load: async () => null, save: async () => {} },
			notify: () => {},
		}),
		connectorSync,
		loadWorkflow: async () => null,
		makeInterpreterPorts: () => ({}) as never,
		persistRun: async () => {},
		appCapabilities: [],
		clock: () => T0,
	});

	const tasks = async () =>
		(await entities("query", { query: { type: TASK_TYPE } })) as Array<{
			id: string;
			properties: Record<string, unknown>;
		}>;
	const syncRuns = async () =>
		(await entities("query", { query: { type: SYNC_RUN_TYPE_URL } })) as unknown[];

	return {
		vaultDir,
		stores,
		entities,
		connectorSync,
		host,
		tasks,
		syncRuns,
		cursors,
		mapping,
		requests,
	};
}

describe("Connectors pipeline — fire → sync → real Tasks → persisted SyncRun", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		__ydocCacheResetForTest();
		env = await setup();
	});
	afterEach(async () => {
		__ydocCacheResetForTest();
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	it("a scheduled SyncMapping fire projects issues into Task/v1 + persists a SyncRun", async () => {
		await env.host.hydrate(
			{
				workflows: [],
				reminders: [],
				entityEvents: [],
				syncMappings: [{ mappingId: "mapping-1", config: { oneShotAt: T0 } }],
			},
			T0 - DAY,
		);
		await env.host.tick(T0);

		const tasks = await env.tasks();
		expect(tasks).toHaveLength(2);
		expect(tasks.map((t) => t.properties.title).sort()).toEqual(["First issue", "Second issue"]);
		expect(tasks[0]?.properties[CONNECTOR_EXTERNAL_ID_PROP]).toMatch(/^github:issue:/);

		const runs = (await env.entities("query", {
			query: { type: SYNC_RUN_TYPE_URL },
		})) as Array<{ properties: Record<string, unknown> }>;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.properties).toMatchObject({
			mappingRef: "mapping-1",
			status: SyncRunStatus.Succeeded,
			pulled: 2,
		});
		expect(env.cursors[0]).toEqual({ since: "2026-06-02T00:00:00Z" });
	});

	it("a second identical sync produces NO duplicate Tasks (idempotent upsert)", async () => {
		await env.connectorSync.runSync("mapping-1");
		expect(await env.tasks()).toHaveLength(2);
		await env.connectorSync.runSync("mapping-1");
		expect(await env.tasks()).toHaveLength(2); // upserted, not duplicated
		expect((await env.syncRuns()).length).toBe(2); // both runs recorded
	});

	it("external-wins overwrites a vault edit to a synced Task on re-pull", async () => {
		await env.connectorSync.runSync("mapping-1");
		const before = await env.tasks();
		const target = before[0];
		if (!target) throw new Error("expected a synced task");
		await env.entities("update", { id: target.id, patch: { title: "Locally edited" } });
		await env.connectorSync.runSync("mapping-1");
		const after = (await env.tasks()).find((t) => t.id === target.id);
		expect(after?.properties.title).not.toBe("Locally edited");
	});

	it("two-way: a vault edit writes back to the provider, idempotent and unclobbered (Connector-5)", async () => {
		env.mapping.direction = SyncDirection.TwoWay;
		env.mapping.push = {
			path: "/repos/o/r/issues/{externalId}",
			fieldMap: { title: "title", state: "status" },
		};
		await env.connectorSync.runSync("mapping-1"); // seed mirrors + sync-point baselines
		expect(env.requests.every((r) => r.method === "GET")).toBe(true);

		const target = (await env.tasks()).find(
			(t) => t.properties[CONNECTOR_EXTERNAL_ID_PROP] === "github:issue:1",
		);
		if (!target) throw new Error("expected the mirrored task");
		await env.entities("update", { id: target.id, patch: { title: "Edited in vault" } });

		const result = await env.connectorSync.runSync("mapping-1");
		expect(result?.status).toBe(SyncRunStatus.Succeeded);
		expect(result?.pushed).toBe(1);
		const push = env.requests.find((r) => r.method === "PATCH");
		expect(push?.path).toBe("/repos/o/r/issues/1");
		expect((push?.body as Record<string, unknown>).title).toBe("Edited in vault");
		// The remote side is unchanged, so the pull leg must NOT clobber the
		// local edit, and the mirror set must not duplicate.
		const after = await env.tasks();
		expect(after).toHaveLength(2);
		expect(after.find((t) => t.id === target.id)?.properties.title).toBe("Edited in vault");

		// A third run pushes nothing — the write-back loop is echo-free.
		const idle = await env.connectorSync.runSync("mapping-1");
		expect(idle?.pushed).toBe(0);
		expect(env.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
	});
});
