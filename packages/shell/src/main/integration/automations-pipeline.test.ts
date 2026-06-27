/**
 * In-process integration test (CLAUDE.md §4) for the Automations engine
 * spine: a fire → the `WorkflowRunner` interprets steps against the **real**
 * entities service → a real entity side-effect lands in `entities.db` → the
 * `WorkflowRun/v1` provenance is persisted. Proves the whole 11b.2–.6 path
 * without a live Electron shell (the ydoc + entities handlers run in-process,
 * the same code as production).
 *
 * Capability model under test: the `AutomationsHost` calls the entities
 * service handler directly under the **automations app identity** (the
 * trusted shell-internal pattern, like entities→ydoc), so the entities
 * service's own ledger check is the data-layer gate; the three-tier
 * `workflow ⊆ app` containment is enforced at save by 11b.1's
 * `validateCapabilityTiers`. Here the ledger grants `entities.*:*` so the
 * focus is the data path.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EntityOp,
	StepKind,
	WORKFLOW_RUN_TYPE_URL,
	WorkflowRunStatus,
	type WorkflowStep,
} from "@brainstorm/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceHandler } from "../../ipc/broker";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { AutomationsHost, type LoadedWorkflow } from "../automations/automations-host";
import { createBrokerInterpreterPorts } from "../automations/broker-interpreter-ports";
import { ReminderRunner } from "../automations/reminder-runner";
import { SchedulerService } from "../automations/scheduler-service";
import type { CapabilityLedger as CapabilityLedgerType } from "../capabilities/ledger";
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
const AUTOMATIONS_APP = "io.brainstorm.automations";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-automations-"));
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

	const notified: unknown[] = [];
	const uiHandler: ServiceHandler = (env) => {
		notified.push(env.args[0]);
		return null;
	};

	const getServiceHandler = (name: string): ServiceHandler | undefined =>
		name === "entities" ? entitiesHandler : name === "ui" ? uiHandler : undefined;

	const makeInterpreterPorts = (caps: readonly string[]) =>
		createBrokerInterpreterPorts({ getServiceHandler, appId: AUTOMATIONS_APP, caps });

	// Direct helper to call the entities service (create/query) in-test.
	const entities = (method: string, arg: unknown) =>
		entitiesHandler({
			v: 1,
			msg: "m",
			app: AUTOMATIONS_APP,
			service: "entities",
			method,
			args: [arg],
			caps: ["entities.read:*", "entities.write:*"],
		});

	return { vaultDir, stores, repo, notified, makeInterpreterPorts, entities, getServiceHandler };
}

describe("Automations pipeline — fire → run → real entity → persisted run", () => {
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

	function host(over: Partial<Parameters<typeof makeHost>[0]> = {}) {
		return makeHost({
			scheduler: new SchedulerService({ loadAll: () => [], save: () => {}, remove: () => {} }),
			loadWorkflow: async () => null,
			...over,
		});
	}
	function makeHost(opts: {
		scheduler: SchedulerService;
		loadWorkflow: (id: string) => Promise<LoadedWorkflow | null>;
	}) {
		return new AutomationsHost({
			scheduler: opts.scheduler,
			reminderRunner: new ReminderRunner({
				store: { load: async () => null, save: async () => {} },
				notify: () => {},
			}),
			loadWorkflow: opts.loadWorkflow,
			makeInterpreterPorts: env.makeInterpreterPorts,
			persistRun: async (run) => {
				await env.entities("create", { type: WORKFLOW_RUN_TYPE_URL, properties: run });
			},
			appCapabilities: ["entities.write:brainstorm/Note/v1", "ai.use"],
			clock: () => T0,
		});
	}

	// A workflow that creates a Note from the trigger payload.
	const createNoteSteps: WorkflowStep[] = [
		{ id: "trig", kind: StepKind.Trigger },
		{ id: "make", kind: StepKind.Entity, op: EntityOp.Create, entityType: "brainstorm/Note/v1" },
	];

	it("runNow creates the real entity and persists a succeeded WorkflowRun/v1", async () => {
		const h = host({
			loadWorkflow: async () => ({
				steps: createNoteSteps,
				capabilities: ["entities.write:brainstorm/Note/v1"],
			}),
		});
		// Drive the create off the trigger payload (the Note's properties).
		const result = await h.runWorkflow("wf1", "manual", { title: "Born in a workflow" });
		expect(result?.status).toBe(WorkflowRunStatus.Succeeded);

		// The Note really landed in entities.db.
		const notes = (await env.entities("query", {
			query: { type: "brainstorm/Note/v1" },
		})) as Array<{ properties: Record<string, unknown> }>;
		expect(notes).toHaveLength(1);
		expect(notes[0]?.properties.title).toBe("Born in a workflow");

		// And a WorkflowRun/v1 provenance row was persisted.
		const runs = (await env.entities("query", {
			query: { type: WORKFLOW_RUN_TYPE_URL },
		})) as Array<{ properties: Record<string, unknown> }>;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.properties).toMatchObject({
			workflow: "wf1",
			status: WorkflowRunStatus.Succeeded,
		});
	});

	it("a due time-trigger fire runs the workflow through the scheduler tick", async () => {
		const scheduler = new SchedulerService({ loadAll: () => [], save: () => {}, remove: () => {} });
		const h = makeHost({
			scheduler,
			loadWorkflow: async () => ({
				steps: createNoteSteps,
				capabilities: ["entities.write:brainstorm/Note/v1"],
			}),
		});
		await h.hydrate(
			{
				workflows: [{ triggerId: "t1", workflowId: "wf1", config: { oneShotAt: T0 } }],
				reminders: [],
				entityEvents: [],
			},
			T0 - DAY,
		);
		await h.tick(T0);

		const runs = (await env.entities("query", {
			query: { type: WORKFLOW_RUN_TYPE_URL },
		})) as unknown[];
		expect(runs).toHaveLength(1);
		// Second tick past the spent one-shot fires nothing more.
		await h.tick(T0 + DAY);
		const runs2 = (await env.entities("query", {
			query: { type: WORKFLOW_RUN_TYPE_URL },
		})) as unknown[];
		expect(runs2).toHaveLength(1);
	});

	it("persists a failed run when a step fails at runtime (AI service unavailable)", async () => {
		// The broker interpreter ports now wire the AI port, so an AICall is no
		// longer an unsupported kind — it reaches the real interpreter, which
		// fails `service-unavailable:ai` because no AI service is registered in
		// this harness. (The pure unsupported-step-kind path is covered by
		// automations-host.test.ts.) Either way the run must persist as Failed
		// with the error captured.
		const h = host({
			loadWorkflow: async () => ({
				steps: [{ id: "x", kind: StepKind.AICall, instructions: "n/a" }],
				capabilities: ["ai.use"], // clears the cap gate → reaches the interpreter
			}),
		});
		const result = await h.runWorkflow("wf-bad", "manual", null);
		expect(result?.status).toBe(WorkflowRunStatus.Failed);

		const runs = (await env.entities("query", {
			query: { type: WORKFLOW_RUN_TYPE_URL },
		})) as Array<{ properties: Record<string, unknown> }>;
		expect(runs[0]?.properties.status).toBe(WorkflowRunStatus.Failed);
		expect(String(runs[0]?.properties.error)).toContain("service-unavailable:ai");
	});
});

// ─── 11b.6 deploy residue — the production deployment assembly against the
// REAL entities service: session-open hydration from persisted entities,
// the post-commit change emitter driving an EntityEvent workflow, the
// runNow service surface, the 11b.15 designation gate, and an 11b.8 HTTP
// step through the cap-scoped egress port.

import {
	EntityEventVerb,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_TYPE_URL,
	triggerToProperties,
	workflowToProperties,
} from "@brainstorm/sdk-types";
import {
	AUTOMATIONS_RUN_CAP,
	makeAutomationsServiceHandler,
} from "../automations/automations-service";
import { AUTOMATIONS_APP_ID, buildAutomationsDeployment } from "../automations/wiring";
import type { CapabilityGrant } from "../capabilities/ledger";
import { makeEntitiesServiceHandler as makeHandlerForDeploy } from "../entities/entities-service";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";

function grantsLedgerWithList(grants: string[]): CapabilityLedgerType {
	return {
		has(_app: string, required: string): boolean {
			const [cap] = required.split(":");
			return grants.includes(required) || grants.includes(`${cap}:*`);
		},
		listActive(): CapabilityGrant[] {
			return grants.map((g, i) => {
				const colon = g.indexOf(":");
				return {
					id: `g${i}`,
					appId: AUTOMATIONS_APP_ID,
					capability: colon < 0 ? g : g.slice(0, colon),
					scope: colon < 0 ? null : g.slice(colon + 1),
					grantedAt: 0,
					grantedVia: "install",
				} as CapabilityGrant;
			});
		},
	} as unknown as CapabilityLedgerType;
}

describe("Automations deployment — session-open registration over the real entities service", () => {
	let vaultDir: string;
	let stores: DataStores;
	let entitiesHandler: ServiceHandler;
	let changeEmitter: EntityChangeEmitter;
	let notified: Array<Record<string, unknown>>;
	const grants = [
		"entities.read:*",
		"entities.write:*",
		"notifications.post",
		AUTOMATIONS_RUN_CAP,
		"network.egress:*",
	];

	beforeEach(async () => {
		__ydocCacheResetForTest();
		vaultDir = await mkdtemp(join(tmpdir(), "bs-automations-deploy-"));
		stores = new DataStores(vaultDir);
		const db = await stores.open("entities");
		const repo = new EntitiesRepository(db);
		const dekStore = new EntityDekStore(new EntityDeksRepository(db), generateSymmetricKey());
		changeEmitter = new EntityChangeEmitter();
		notified = [];
		let idSeq = 0;
		entitiesHandler = makeHandlerForDeploy({
			getRepo: async () => repo,
			getLedger: async () => grantsLedgerWithList(grants),
			getDekStore: async () => dekStore,
			newId: () => `dep_${++idSeq}`,
			onEntityChange: (c) => changeEmitter.emit(c),
		});
	});

	afterEach(async () => {
		__ydocCacheResetForTest();
		stores.close();
		await rm(vaultDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
			() => {},
		);
	});

	const callEntities = (method: string, arg: unknown) =>
		Promise.resolve(
			entitiesHandler({
				v: 1,
				msg: "dep",
				app: AUTOMATIONS_APP_ID,
				service: "entities",
				method,
				args: [arg],
				caps: [],
			}),
		);

	function makeDeployment(egress?: Parameters<typeof buildAutomationsDeployment>[0]["egress"]) {
		return buildAutomationsDeployment({
			callEntities,
			getServiceHandler: (name) =>
				name === "entities"
					? (env) => entitiesHandler(env)
					: name === "ui"
						? (env) => {
								notified.push((env.args[0] ?? {}) as Record<string, unknown>);
								return null;
							}
						: undefined,
			getLedger: async () => grantsLedgerWithList(grants),
			schedulerStore: { loadAll: () => [], save: () => {}, remove: () => {} },
			entityChanges: changeEmitter,
			notify: (n) => notified.push(n as unknown as Record<string, unknown>),
			deviceId: "device-A",
			clock: () => T0,
			intervals: { set: () => 0 as unknown as ReturnType<typeof setInterval>, clear: () => {} },
			...(egress ? { egress } : {}),
		});
	}

	async function seedAutomation(
		trigger: { kind: TriggerKind; config: Record<string, unknown> },
		steps: WorkflowStep[],
		capabilities: string[],
	): Promise<string> {
		const triggerRow = (await callEntities("create", {
			type: TRIGGER_TYPE_URL,
			properties: triggerToProperties({ ...trigger, enabled: true }),
		})) as { id: string };
		const workflowRow = (await callEntities("create", {
			type: WORKFLOW_TYPE_URL,
			properties: workflowToProperties({
				name: "wired",
				enabled: true,
				triggerId: triggerRow.id,
				steps,
				capabilities,
			}),
		})) as { id: string };
		return workflowRow.id;
	}

	const runsQuery = async () =>
		(await callEntities("query", { query: { type: WORKFLOW_RUN_TYPE_URL } })) as Array<{
			properties: Record<string, unknown>;
		}>;

	it("hydrates persisted entities on start and fires a due time trigger end-to-end", async () => {
		await seedAutomation(
			{ kind: TriggerKind.Time, config: { oneShotAt: T0 + 1000 } },
			[
				{ id: "t", kind: StepKind.Trigger },
				{ id: "make", kind: StepKind.Entity, op: EntityOp.Create, entityType: "brainstorm/Note/v1" },
			],
			["entities.write:brainstorm/Note/v1"],
		);
		const deployment = makeDeployment();
		const status = await deployment.start();
		expect(status.scheduling).toBe(true);

		await deployment.host.tick(T0 + 1000);
		const notes = (await callEntities("query", {
			query: { type: "brainstorm/Note/v1" },
		})) as unknown[];
		expect(notes).toHaveLength(1);
		expect((await runsQuery())[0]?.properties.status).toBe(WorkflowRunStatus.Succeeded);
		deployment.stop();
	});

	it("an entity write through the REAL service drives an EntityEvent workflow", async () => {
		await seedAutomation(
			{
				kind: TriggerKind.EntityEvent,
				config: { entityType: "brainstorm/Task/v1", verb: EntityEventVerb.Create },
			},
			[
				{ id: "t", kind: StepKind.Trigger },
				{ id: "n", kind: StepKind.Notify, title: "task born" },
			],
			["notifications.post"],
		);
		const deployment = makeDeployment();
		await deployment.start();

		// The post-commit emitter — not a test shim — carries this create to
		// the host. (It also triggers a schedule re-derive; both are async.)
		await callEntities("create", {
			type: "brainstorm/Task/v1",
			properties: { title: "review" },
		});
		await vi.waitFor(async () => {
			expect(notified.some((n) => n.title === "task born")).toBe(true);
		});
		const runs = await runsQuery();
		expect(runs.some((r) => r.properties.status === WorkflowRunStatus.Succeeded)).toBe(true);
		deployment.stop();
	});

	it("runNow flows through the capability-gated automations service handler", async () => {
		const workflowId = await seedAutomation(
			{ kind: TriggerKind.Manual, config: {} },
			[
				{ id: "t", kind: StepKind.Trigger },
				{ id: "n", kind: StepKind.Notify, title: "manual ping" },
			],
			["notifications.post"],
		);
		const deployment = makeDeployment();
		await deployment.start();
		const serviceHandler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: async () => grantsLedgerWithList(grants),
		});
		const result = await serviceHandler({
			v: 1,
			msg: "m",
			app: AUTOMATIONS_APP_ID,
			service: "automations",
			method: "runNow",
			args: [{ workflowId }],
			caps: [AUTOMATIONS_RUN_CAP],
		});
		expect(result).toEqual({ status: WorkflowRunStatus.Succeeded });
		expect(notified.some((n) => n.title === "manual ping")).toBe(true);

		// Fail-closed: an app without the grant is Denied before any run.
		const deniedHandler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: async () => grantsLedgerWithList([]),
		});
		await expect(
			deniedHandler({
				v: 1,
				msg: "m2",
				app: "io.evil.app",
				service: "automations",
				method: "runNow",
				args: [{ workflowId }],
				caps: [AUTOMATIONS_RUN_CAP],
			}),
		).rejects.toMatchObject({ name: "Denied" });
		deployment.stop();
	});

	it("HTTP step egresses through the cap-scoped port and binds the response", async () => {
		const seen: string[] = [];
		const egress = async (req: { url: string }) => {
			seen.push(req.url);
			return { status: 200, body: new TextEncoder().encode('{"pong":true}') };
		};
		const workflowId = await seedAutomation(
			{ kind: TriggerKind.Manual, config: {} },
			[
				{ id: "t", kind: StepKind.Trigger },
				{ id: "h", kind: StepKind.HTTP, method: "GET", url: "https://api.example.com/ping" },
			],
			["network.egress:https://api.example.com"],
		);
		const deployment = makeDeployment(egress);
		await deployment.start();
		const result = await deployment.runNow(workflowId);
		expect(result?.status).toBe(WorkflowRunStatus.Succeeded);
		expect(seen).toEqual(["https://api.example.com/ping"]);
		deployment.stop();
	});

	it("the 11b.15 designation gate parks scheduling on a non-host device", async () => {
		await callEntities("create", {
			id: "automation-host-designation",
			type: "brainstorm/AutomationHostDesignation/v1",
			properties: { deviceId: "device-OTHER", claimedAt: T0 - 1 },
		});
		const deployment = makeDeployment();
		const status = await deployment.start();
		expect(status).toEqual({ deviceId: "device-A", hostDeviceId: "device-OTHER", scheduling: false });

		const claimed = await deployment.claimHost();
		expect(claimed.scheduling).toBe(true);
		expect(claimed.hostDeviceId).toBe("device-A");
		deployment.stop();
	});
});
