/**
 * Automations engine — production deployment assembly (11b.6 deploy
 * residue). The analogue of `connectors/wiring.ts`: builds the per-vault
 * `AutomationsHost` + `SchedulerService` + runners from the live shell
 * primitives, kept out of `index.ts` so the whole fire path stays
 * Electron-free and unit-tested; `index.ts` contributes only closures.
 *
 * Lifecycle (one deployment per open vault session):
 *   - `start()` — reconcile the persisted scheduler state against the
 *     entities (entities are the source of truth), hydrate, and start the
 *     drain loop — gated by the 11b.15 automation-host designation
 *     (`shouldRunScheduler`, fail-OPEN to the single-device default);
 *   - automation-entity changes (Workflow/Trigger/Reminder writes from the
 *     app) re-derive + re-hydrate the schedule live, no reopen needed;
 *   - `runNow()` — the Manual trigger; allowed even on a non-host device
 *     (an explicit user action on THIS device, not a schedule);
 *   - `stop()` — vault dispose.
 *
 * Capability posture: workflow fires run under the workflow's frozen
 * capability sheet via `createBrokerInterpreterPorts`; the app-grant
 * ceiling is read from the LIVE ledger per fire (a Settings revoke takes
 * effect on the next run). All entity IO goes through the capability-
 * checked entities service under the automations app identity.
 */

import {
	REMINDER_TYPE_URL,
	TRIGGER_TYPE_URL,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	type WorkflowStep,
	propertiesToReminder,
	propertiesToWorkflow,
	reminderToProperties,
} from "@brainstorm-os/sdk-types";
import type { CapabilityLedger } from "../capabilities/ledger";
import type { UiNotification } from "../ui/notify-host";
import {
	AUTOMATION_HOST_ENTITY_ID,
	AUTOMATION_HOST_TYPE_URL,
	type AutomationHostDesignation,
	claimAutomationHost,
	designationToProperties,
	propertiesToDesignation,
	shouldRunScheduler,
} from "./automation-host-designation";
import {
	AutomationsHost,
	type EntityChangeSource,
	type IntervalFactory,
	type LoadedWorkflow,
} from "./automations-host";
import {
	AUTOMATION_SCHEDULE_TYPES,
	type AutomationEntityRow,
	deriveScheduleRegistration,
} from "./automations-registration";
import {
	type ServiceHandlerGetter,
	type WorkflowEgress,
	createBrokerInterpreterPorts,
} from "./broker-interpreter-ports";
import { EVENT_TYPE_URL, ITEM_ALERT_TYPES, TASK_TYPE_URL, deriveItemAlerts } from "./item-alerts";
import { ReminderRunner } from "./reminder-runner";
import { SchedulerService, type SchedulerStore } from "./scheduler-service";
import type { WorkflowRunResult } from "./workflow-runner";

export const AUTOMATIONS_APP_ID = "io.brainstorm.automations";

export type AutomationsWiringDeps = {
	/** Capability-checked entities call under the automations app identity
	 *  (the connector wiring's `callEntities` shape, app pre-bound). */
	callEntities: (method: string, arg: unknown) => Promise<unknown>;
	/** Broker service-handler lookup backing the interpreter ports. */
	getServiceHandler: ServiceHandlerGetter;
	/** The live capability ledger — the app-grant ceiling per fire. */
	getLedger: () => Promise<CapabilityLedger | null>;
	/** Scheduler persistence (registry.db `scheduler_fires`). */
	schedulerStore: SchedulerStore;
	/** Post-commit entity changes — EntityEvent triggers + live re-hydrate. */
	entityChanges: EntityChangeSource;
	/** Reminder notification sink (the shared ui notify host). */
	notify: (n: { title: string; body?: string }) => void;
	/** 9.14.9b — item-alert sink: posts a full `UiNotification` (source
	 *  app id + dedupe key) through the shared ui notify host, so a task /
	 *  event alert fired shell-side collapses with the same alert fired by
	 *  an open app window. Optional so existing wirings/tests stay valid;
	 *  absent keeps item alerts silent. */
	postAlert?: (notification: UiNotification) => void;
	/** This device's pairing-layer identity (device Ed25519 pub, base64). */
	deviceId: string;
	/** 11b.8 — outbound HTTP for `HTTP` steps (Net-1 backed). Optional:
	 *  absent keeps the step kind gated. */
	egress?: WorkflowEgress;
	clock?: () => number;
	intervalMs?: number;
	intervals?: IntervalFactory;
	onError?: (context: string, error: unknown) => void;
};

export type AutomationsDeploymentStatus = {
	deviceId: string;
	hostDeviceId: string | null;
	scheduling: boolean;
};

export type AutomationsDeployment = {
	start(): Promise<AutomationsDeploymentStatus>;
	stop(): void;
	runNow(workflowId: string): Promise<WorkflowRunResult | null>;
	hostStatus(): Promise<AutomationsDeploymentStatus>;
	claimHost(): Promise<AutomationsDeploymentStatus>;
	/** Exposed for tests / introspection. */
	host: AutomationsHost;
	scheduler: SchedulerService;
};

/** Live grants → the `capability[:scope]` strings the three-tier check
 *  compares against. A missing ledger reads as NO grants (fail-closed —
 *  no workflow runs against an unavailable ledger). */
async function appGrantCeiling(
	getLedger: () => Promise<CapabilityLedger | null>,
): Promise<readonly string[]> {
	try {
		const ledger = await getLedger();
		if (!ledger) return [];
		return ledger
			.listActive(AUTOMATIONS_APP_ID)
			.map((g) => (g.scope === null ? g.capability : `${g.capability}:${g.scope}`));
	} catch {
		return [];
	}
}

export function buildAutomationsDeployment(deps: AutomationsWiringDeps): AutomationsDeployment {
	const clock = deps.clock ?? (() => Date.now());
	const onError =
		deps.onError ??
		((context: string, error: unknown) => console.error(`[automations] ${context}:`, error));

	const entityRows = async (type: string): Promise<AutomationEntityRow[]> => {
		const rows = (await deps.callEntities("query", { query: { type } })) as unknown;
		if (!Array.isArray(rows)) return [];
		return rows
			.filter((r): r is { id: string; properties: Record<string, unknown> } => {
				const row = r as { id?: unknown; properties?: unknown };
				return typeof row.id === "string" && !!row.properties && typeof row.properties === "object";
			})
			.map((r) => ({ id: r.id, properties: r.properties }));
	};

	const loadWorkflow = async (workflowId: string): Promise<LoadedWorkflow | null> => {
		const row = (await deps.callEntities("get", { id: workflowId })) as {
			properties?: Record<string, unknown>;
		} | null;
		if (!row?.properties) return null;
		const def = propertiesToWorkflow(row.properties);
		if (!def.enabled) return null;
		return { steps: def.steps as WorkflowStep[], capabilities: def.capabilities };
	};

	const scheduler = new SchedulerService(deps.schedulerStore);

	const reminderRunner = new ReminderRunner({
		store: {
			load: async (id) => {
				const row = (await deps.callEntities("get", { id })) as {
					properties?: Record<string, unknown>;
				} | null;
				return row?.properties ? propertiesToReminder(row.properties) : null;
			},
			save: async (id, reminder) => {
				await deps.callEntities("update", { id, patch: reminderToProperties(reminder) });
			},
		},
		notify: (n) => deps.notify({ title: n.title, ...(n.body !== undefined ? { body: n.body } : {}) }),
	});

	const host = new AutomationsHost({
		scheduler,
		reminderRunner,
		loadWorkflow,
		makeInterpreterPorts: (caps) =>
			createBrokerInterpreterPorts({
				getServiceHandler: deps.getServiceHandler,
				appId: AUTOMATIONS_APP_ID,
				caps,
				...(deps.egress ? { egress: deps.egress } : {}),
			}),
		persistRun: async (run) => {
			await deps.callEntities("create", { type: WORKFLOW_RUN_TYPE_URL, properties: run });
		},
		appCapabilities: () => appGrantCeiling(deps.getLedger),
		clock,
		entityChanges: deps.entityChanges,
		onError,
		...(deps.postAlert ? { postAlert: deps.postAlert } : {}),
		...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
		...(deps.intervals ? { intervals: deps.intervals } : {}),
	});

	const readDesignation = async (): Promise<AutomationHostDesignation | null> => {
		try {
			const row = (await deps.callEntities("get", { id: AUTOMATION_HOST_ENTITY_ID })) as {
				properties?: Record<string, unknown>;
			} | null;
			return propertiesToDesignation(row?.properties);
		} catch (error) {
			// Fail OPEN to the single-device default — a read failure must
			// never silence automations vault-wide (11b.15 codec posture).
			onError("designation read", error);
			return null;
		}
	};

	const hydrateFromEntities = async (): Promise<void> => {
		const [workflows, triggers, reminders, tasks, events] = await Promise.all([
			entityRows(WORKFLOW_TYPE_URL),
			entityRows(TRIGGER_TYPE_URL),
			entityRows(REMINDER_TYPE_URL),
			entityRows(TASK_TYPE_URL),
			entityRows(EVENT_TYPE_URL),
		]);
		const registration = deriveScheduleRegistration({ workflows, triggers, reminders });
		// 9.14.9b — task due/scheduled + event alerts ride the same schedule.
		// 0.3.1 — register alerts whose instant is `> lastRun` (the scheduler's
		// persisted watermark), not just `> now`: a reminder that came due while
		// the app was closed (in the `(lastRun, now]` gap) is a FireOnce catch-up.
		registration.itemAlerts = deriveItemAlerts(tasks, events, scheduler.lastRunAt() ?? clock());
		// Reconcile: entities are the source of truth, so a trigger persisted
		// in `scheduler_fires` whose entity is gone/disabled must not linger.
		const live = new Set([
			...registration.workflows.map((w) => w.triggerId),
			...registration.reminders.map((r) => r.reminderId),
			...registration.itemAlerts.map((a) => a.alertId),
		]);
		for (const staleId of scheduler.registeredTriggerIds()) {
			if (!live.has(staleId)) await scheduler.unregister(staleId);
		}
		await host.hydrate(registration, clock());
	};

	let scheduling = false;
	let stopped = false;
	let rehydrating = false;
	let rehydrateQueued = false;
	let unsubscribeRehydrate: (() => void) | null = null;

	// A Workflow/Trigger/Reminder write re-derives the schedule. Coalesced:
	// a burst of writes folds into one in-flight + one queued re-derive.
	const scheduleRehydrate = (): void => {
		if (!scheduling || stopped) return;
		if (rehydrating) {
			rehydrateQueued = true;
			return;
		}
		rehydrating = true;
		void (async () => {
			try {
				do {
					rehydrateQueued = false;
					await hydrateFromEntities();
				} while (rehydrateQueued && !stopped);
			} catch (error) {
				onError("schedule rehydrate", error);
			} finally {
				rehydrating = false;
			}
		})();
	};

	const status = async (): Promise<AutomationsDeploymentStatus> => {
		const designation = await readDesignation();
		return {
			deviceId: deps.deviceId,
			hostDeviceId: designation?.deviceId ?? null,
			scheduling,
		};
	};

	const stopScheduling = (): void => {
		scheduling = false;
		unsubscribeRehydrate?.();
		unsubscribeRehydrate = null;
		host.stop();
	};

	// 11b.15 — honour an explicit takeover from another device: the designation
	// is a vault-synced entity, so when it arrives naming a different device we
	// stop scheduling here rather than double-fire every Time trigger. This is
	// NOT liveness/failover (v2) — a host that simply dies leaves its stale
	// designation and the user re-claims; this only reacts to a real takeover.
	const reevaluateHosting = async (): Promise<void> => {
		if (!scheduling || stopped) return;
		const designation = await readDesignation();
		if (!shouldRunScheduler(designation, deps.deviceId)) stopScheduling();
	};

	const startScheduling = async (): Promise<void> => {
		if (scheduling) return;
		scheduling = true;
		await scheduler.hydrate();
		await hydrateFromEntities();
		host.start();
		unsubscribeRehydrate = deps.entityChanges.subscribe((change) => {
			if (AUTOMATION_SCHEDULE_TYPES.includes(change.type) || ITEM_ALERT_TYPES.includes(change.type))
				scheduleRehydrate();
			else if (
				change.type === AUTOMATION_HOST_TYPE_URL ||
				change.entityId === AUTOMATION_HOST_ENTITY_ID
			) {
				void reevaluateHosting();
			}
		});
	};

	return {
		host,
		scheduler,
		async start() {
			stopped = false;
			const designation = await readDesignation();
			// 11b.15 session-open gate: only the designated host device runs
			// the scheduler; no designation = every device (single-device
			// default, fail-open per the codec contract).
			if (shouldRunScheduler(designation, deps.deviceId)) {
				await startScheduling();
			}
			return status();
		},
		stop() {
			stopped = true;
			scheduling = false;
			unsubscribeRehydrate?.();
			unsubscribeRehydrate = null;
			host.stop();
		},
		// Manual trigger — an explicit user action on THIS device, so it is
		// deliberately NOT designation-gated (the designation exists to stop
		// double-firing of schedules, not to block a clicked "Run now").
		runNow: (workflowId) => host.runNow(workflowId),
		hostStatus: status,
		async claimHost() {
			const designation = claimAutomationHost(deps.deviceId, clock());
			const properties = designationToProperties(designation);
			const existing = (await deps.callEntities("get", {
				id: AUTOMATION_HOST_ENTITY_ID,
			})) as unknown;
			if (existing) {
				await deps.callEntities("update", { id: AUTOMATION_HOST_ENTITY_ID, patch: properties });
			} else {
				await deps.callEntities("create", {
					id: AUTOMATION_HOST_ENTITY_ID,
					type: AUTOMATION_HOST_TYPE_URL,
					properties,
				});
			}
			// Claiming makes THIS device the host — start scheduling if the
			// session-open gate had parked it.
			if (!stopped) await startScheduling();
			return status();
		},
	};
}
