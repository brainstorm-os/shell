/**
 * 11b.6 deploy + 11b.15 gate — the per-vault deployment assembly over an
 * in-memory entities fake: session-open hydration, the designation gate,
 * live re-hydration off entity changes, runNow, claim/takeover, and the
 * live app-grant ceiling.
 */

import {
	EntityEventVerb,
	StepKind,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	WorkflowRunStatus,
	type WorkflowStep,
	triggerToProperties,
	workflowToProperties,
} from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityGrant, CapabilityLedger } from "../capabilities/ledger";
import { EntityChangeEmitter } from "../entities/entity-change-emitter";
import type { UiNotification } from "../ui/notify-host";
import { AUTOMATION_HOST_ENTITY_ID } from "./automation-host-designation";
import { CALENDAR_APP_ID, EVENT_TYPE_URL, TASKS_APP_ID, TASK_TYPE_URL } from "./item-alerts";
import type { PersistedFire, SchedulerStore } from "./scheduler-service";
import { AUTOMATIONS_APP_ID, buildAutomationsDeployment } from "./wiring";

const T0 = Date.UTC(2026, 5, 11, 9, 0, 0);

type Row = { id: string; type: string; properties: Record<string, unknown> };

/** In-memory entities service double (get/query/create/update shape). */
function fakeEntitiesStore(seed: Row[] = []) {
	const rows = new Map<string, Row>(seed.map((r) => [r.id, r]));
	let seq = 0;
	const callEntities = async (method: string, arg: unknown): Promise<unknown> => {
		const a = arg as Record<string, unknown>;
		switch (method) {
			case "get":
				return rows.get(String(a.id)) ?? null;
			case "query": {
				const type = (a.query as { type?: string } | undefined)?.type;
				return [...rows.values()].filter((r) => !type || r.type === type);
			}
			case "create": {
				const id = typeof a.id === "string" ? a.id : `ent_${++seq}`;
				const row: Row = {
					id,
					type: String(a.type),
					properties: (a.properties as Record<string, unknown>) ?? {},
				};
				rows.set(id, row);
				return row;
			}
			case "update": {
				const row = rows.get(String(a.id));
				if (!row) throw new Error(`update: ${a.id} not found`);
				row.properties = { ...row.properties, ...(a.patch as Record<string, unknown>) };
				return row;
			}
			default:
				throw new Error(`unexpected entities method ${method}`);
		}
	};
	return { rows, callEntities };
}

function grantsLedger(grants: string[]): CapabilityLedger {
	return {
		listActive: (appId: string): CapabilityGrant[] => {
			expect(appId).toBe(AUTOMATIONS_APP_ID);
			return grants.map((g, i) => {
				const colon = g.indexOf(":");
				return {
					id: `g${i}`,
					appId,
					capability: colon < 0 ? g : g.slice(0, colon),
					scope: colon < 0 ? null : g.slice(colon + 1),
					grantedAt: 0,
					grantedVia: "install",
				} as CapabilityGrant;
			});
		},
	} as unknown as CapabilityLedger;
}

function memorySchedulerStore(initial: PersistedFire[] = []): SchedulerStore {
	const fires = new Map(initial.map((f) => [f.triggerId, f]));
	return {
		loadAll: () => [...fires.values()],
		save: (f) => void fires.set(f.triggerId, f),
		remove: (id) => void fires.delete(id),
	};
}

const notifySteps: WorkflowStep[] = [
	{ id: "t", kind: StepKind.Trigger },
	{ id: "n", kind: StepKind.Notify, title: "ping" },
];

function seedWorkflow(id: string, triggerId: string, config: Record<string, unknown>): Row[] {
	return [
		{
			id,
			type: WORKFLOW_TYPE_URL,
			properties: workflowToProperties({
				name: id,
				enabled: true,
				triggerId,
				steps: notifySteps,
				capabilities: ["notifications.post"],
			}),
		},
		{
			id: triggerId,
			type: TRIGGER_TYPE_URL,
			properties: triggerToProperties({ kind: TriggerKind.Time, config, enabled: true }),
		},
	];
}

function deployment(over: {
	seed?: Row[];
	grants?: string[];
	deviceId?: string;
	emitter?: EntityChangeEmitter;
	store?: SchedulerStore;
}) {
	const store = fakeEntitiesStore(over.seed ?? []);
	const emitter = over.emitter ?? new EntityChangeEmitter();
	const notified: Array<{ title: string }> = [];
	const alerts: UiNotification[] = [];
	const dep = buildAutomationsDeployment({
		callEntities: store.callEntities,
		// The interpreter ports' "ui" notify + entities all route here.
		getServiceHandler: (name) =>
			name === "ui"
				? (env) => {
						notified.push((env.args[0] ?? {}) as { title: string });
						return null;
					}
				: name === "entities"
					? (env) => store.callEntities(env.method, env.args[0])
					: undefined,
		getLedger: async () => grantsLedger(over.grants ?? ["notifications.post"]),
		schedulerStore: over.store ?? memorySchedulerStore(),
		entityChanges: emitter,
		notify: (n) => notified.push(n),
		postAlert: (n) => alerts.push(n),
		deviceId: over.deviceId ?? "device-A",
		clock: () => T0,
		// The drain loop timer is irrelevant here — ticks are driven directly.
		intervals: { set: () => 0 as unknown as ReturnType<typeof setInterval>, clear: () => {} },
	});
	return { dep, store, emitter, notified, alerts };
}

async function runsOf(store: ReturnType<typeof fakeEntitiesStore>): Promise<Row[]> {
	return (await store.callEntities("query", { query: { type: WORKFLOW_RUN_TYPE_URL } })) as Row[];
}

describe("buildAutomationsDeployment — session-open hydration", () => {
	it("hydrates persisted entities and fires a due time trigger on tick", async () => {
		const { dep, store, notified } = deployment({
			seed: seedWorkflow("wf1", "t1", { oneShotAt: T0 + 1000 }),
		});
		const status = await dep.start();
		expect(status.scheduling).toBe(true);
		await dep.host.tick(T0 + 1000);
		const runs = await runsOf(store);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.properties.status).toBe(WorkflowRunStatus.Succeeded);
		expect(notified).toContainEqual(expect.objectContaining({ title: "ping" }));
	});

	it("unregisters stale persisted scheduler fires whose entities are gone", async () => {
		const { dep } = deployment({
			seed: seedWorkflow("wf1", "t1", { oneShotAt: T0 }),
			store: memorySchedulerStore([
				{ triggerId: "t_zombie", workflowIds: ["wf_gone"], config: {}, nextFireAt: T0 },
			]),
		});
		await dep.start();
		expect(dep.scheduler.registeredTriggerIds()).toEqual(["t1"]);
	});

	it("re-derives the schedule live when an automation entity changes", async () => {
		const { dep, store, emitter } = deployment({ seed: [] });
		await dep.start();
		expect(dep.scheduler.registeredTriggerIds()).toEqual([]);

		for (const row of seedWorkflow("wf_new", "t_new", { oneShotAt: T0 + 60_000 })) {
			store.rows.set(row.id, row);
		}
		emitter.emit({
			verb: EntityEventVerb.Create,
			entityId: "wf_new",
			type: WORKFLOW_TYPE_URL,
		});
		await vi.waitFor(() => {
			expect(dep.scheduler.registeredTriggerIds()).toEqual(["t_new"]);
		});
	});

	it("enforces the live app-grant ceiling per fire (fail-closed)", async () => {
		const { dep, store } = deployment({
			seed: seedWorkflow("wf1", "t1", { oneShotAt: T0 + 1000 }),
			grants: [], // app holds nothing → workflow's declared caps exceed it
		});
		await dep.start();
		await dep.host.tick(T0 + 1000);
		const runs = await runsOf(store);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.properties.status).toBe(WorkflowRunStatus.Failed);
		expect(String(runs[0]?.properties.error)).toContain("capability-denied");
	});
});

describe("buildAutomationsDeployment — item alerts (9.14.9b)", () => {
	const dueAt = T0 + 60_000; // timed instant — fires verbatim

	it("fires a due task alert with the source app id + in-app dedupe key", async () => {
		const { dep, alerts } = deployment({
			seed: [
				{ id: "task1", type: TASK_TYPE_URL, properties: { name: "Ship 0.1.9", dueAt } },
				// Rows of other types must not derive alerts.
				{ id: "note1", type: "brainstorm/Note/v1", properties: { name: "n", dueAt } },
			],
		});
		await dep.start();
		await dep.host.tick(dueAt);
		expect(alerts).toEqual([
			{
				appId: TASKS_APP_ID,
				title: "Ship 0.1.9",
				body: "Due now",
				kind: "info",
				dedupeKey: `task1#due#${dueAt}`,
			},
		]);
	});

	it("fires an event reminder at its offset instant", async () => {
		const start = T0 + 31 * 60_000;
		const fireAt = start - 30 * 60_000; // T0 + 1min
		const { dep, alerts } = deployment({
			seed: [
				{ id: "ev1", type: EVENT_TYPE_URL, properties: { title: "Standup", start, reminders: [30] } },
			],
		});
		await dep.start();
		await dep.host.tick(fireAt);
		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({
			appId: CALENDAR_APP_ID,
			title: "Standup",
			body: "Starts in 30 minutes",
			dedupeKey: `ev1#${fireAt}`,
		});
	});

	it("completing a task live-unregisters its alert before it fires", async () => {
		const { dep, store, emitter, alerts } = deployment({
			seed: [{ id: "task1", type: TASK_TYPE_URL, properties: { name: "Ship 0.1.9", dueAt } }],
		});
		await dep.start();
		expect(dep.scheduler.registeredTriggerIds()).toEqual([`item-alert:task1#due#${dueAt}`]);

		await store.callEntities("update", { id: "task1", patch: { completedAt: T0 } });
		emitter.emit({ verb: EntityEventVerb.Update, entityId: "task1", type: TASK_TYPE_URL });
		await vi.waitFor(() => {
			expect(dep.scheduler.registeredTriggerIds()).toEqual([]);
		});
		await dep.host.tick(dueAt);
		expect(alerts).toHaveLength(0);
	});

	it("fires each alert exactly once (a later tick does not re-fire)", async () => {
		const { dep, alerts } = deployment({
			seed: [{ id: "task1", type: TASK_TYPE_URL, properties: { name: "t", dueAt } }],
		});
		await dep.start();
		await dep.host.tick(dueAt);
		await dep.host.tick(dueAt + 60_000);
		expect(alerts).toHaveLength(1);
	});
});

describe("buildAutomationsDeployment — designation gate (11b.15)", () => {
	const designationRow = (deviceId: string): Row => ({
		id: AUTOMATION_HOST_ENTITY_ID,
		type: "brainstorm/AutomationHostDesignation/v1",
		properties: { deviceId, claimedAt: T0 - 1000 },
	});

	it("a non-host device does not schedule, but runNow still works", async () => {
		const { dep, store } = deployment({
			seed: [...seedWorkflow("wf1", "t1", { oneShotAt: T0 }), designationRow("device-OTHER")],
			deviceId: "device-A",
		});
		const status = await dep.start();
		expect(status.scheduling).toBe(false);
		expect(status.hostDeviceId).toBe("device-OTHER");
		expect(dep.scheduler.registeredTriggerIds()).toEqual([]);

		const result = await dep.runNow("wf1");
		expect(result?.status).toBe(WorkflowRunStatus.Succeeded);
		expect(await runsOf(store)).toHaveLength(1);
	});

	it("claimHost persists the designation and starts scheduling", async () => {
		const { dep, store } = deployment({
			seed: [...seedWorkflow("wf1", "t1", { oneShotAt: T0 }), designationRow("device-OTHER")],
			deviceId: "device-A",
		});
		await dep.start();
		const status = await dep.claimHost();
		expect(status).toEqual({ deviceId: "device-A", hostDeviceId: "device-A", scheduling: true });
		expect(store.rows.get(AUTOMATION_HOST_ENTITY_ID)?.properties).toEqual({
			deviceId: "device-A",
			claimedAt: T0,
		});
		expect(dep.scheduler.registeredTriggerIds()).toEqual(["t1"]);
	});

	it("stops scheduling live when another device takes over (11b.15 — no double-fire)", async () => {
		const { dep, store, emitter } = deployment({
			seed: seedWorkflow("wf1", "t1", { oneShotAt: T0 + 60_000 }),
			deviceId: "device-A",
		});
		// device-A starts as host (no designation → single-device default runs).
		expect((await dep.start()).scheduling).toBe(true);
		expect(dep.scheduler.registeredTriggerIds()).toEqual(["t1"]);

		// device-B takes over: the vault-synced designation now names device-B.
		store.rows.set(AUTOMATION_HOST_ENTITY_ID, designationRow("device-B"));
		emitter.emit({
			verb: EntityEventVerb.Update,
			entityId: AUTOMATION_HOST_ENTITY_ID,
			type: "brainstorm/AutomationHostDesignation/v1",
		});
		await vi.waitFor(async () => {
			expect((await dep.hostStatus()).scheduling).toBe(false);
		});

		// A later automation-entity change must NOT silently restart scheduling
		// on the now-non-host device.
		emitter.emit({ verb: EntityEventVerb.Create, entityId: "wf1", type: WORKFLOW_TYPE_URL });
		await new Promise((r) => setTimeout(r, 10));
		expect((await dep.hostStatus()).scheduling).toBe(false);
	});

	it("a corrupt designation fails OPEN to the single-device default", async () => {
		const { dep } = deployment({
			seed: [
				...seedWorkflow("wf1", "t1", { oneShotAt: T0 }),
				{
					id: AUTOMATION_HOST_ENTITY_ID,
					type: "brainstorm/AutomationHostDesignation/v1",
					properties: { deviceId: 42 },
				},
			],
		});
		const status = await dep.start();
		expect(status.scheduling).toBe(true);
	});

	it("stop() halts the drain loop and the rehydrate subscription", async () => {
		const { dep, store, emitter } = deployment({ seed: [] });
		await dep.start();
		dep.stop();
		for (const row of seedWorkflow("wf_late", "t_late", { oneShotAt: T0 })) {
			store.rows.set(row.id, row);
		}
		emitter.emit({ verb: EntityEventVerb.Create, entityId: "wf_late", type: WORKFLOW_TYPE_URL });
		await new Promise((r) => setTimeout(r, 10));
		expect(dep.scheduler.registeredTriggerIds()).toEqual([]);
	});
});
