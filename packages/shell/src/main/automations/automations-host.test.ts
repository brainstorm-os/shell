import {
	type AiChatMessage,
	EntityEventVerb,
	StepKind,
	type WorkflowRunDef,
	WorkflowRunStatus,
	type WorkflowStep,
} from "@brainstorm/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	AutomationsHost,
	type AutomationsHostPorts,
	type EntityChange,
	type IntervalFactory,
	type LoadedWorkflow,
	type ScheduleRegistration,
} from "./automations-host";
import { ReminderRunner } from "./reminder-runner";
import { SchedulerService, type SchedulerStore } from "./scheduler-service";
import type { InterpreterPorts } from "./step-interpreters";

const T0 = Date.UTC(2026, 5, 6, 9, 0, 0);
const DAY = 86_400_000;

function memStore(): SchedulerStore {
	const rows = new Map<string, import("./scheduler-service").PersistedFire>();
	return {
		loadAll: () => [...rows.values()],
		save: (f) => {
			rows.set(f.triggerId, f);
		},
		remove: (id) => {
			rows.delete(id);
		},
	};
}

/** A controllable interval factory: capture the handler, fire it on demand. */
function manualIntervals() {
	let handler: (() => void) | null = null;
	const intervals: IntervalFactory = {
		set: (h) => {
			handler = h;
			return 1 as unknown as ReturnType<typeof setInterval>;
		},
		clear: () => {
			handler = null;
		},
	};
	return { intervals, fire: () => handler?.(), isRunning: () => handler !== null };
}

function notifyStep(id: string): WorkflowStep {
	return { id, kind: StepKind.Notify, title: id };
}

function hostWith(over: Partial<AutomationsHostPorts> = {}) {
	const persisted: WorkflowRunDef[] = [];
	const notifyCalls: unknown[] = [];
	const interpreterPorts = (): InterpreterPorts => ({
		intents: { dispatch: vi.fn(async () => null) },
		entities: {
			create: vi.fn(async (type, properties) => ({ id: "x", type, properties })),
			update: vi.fn(async (id, patch) => ({ id, type: "T", properties: patch })),
			get: vi.fn(async (id) => ({ id, type: "T", properties: {} })),
			query: vi.fn(async () => []),
			delete: vi.fn(async () => {}),
		},
		notify: vi.fn(async (n) => {
			notifyCalls.push(n);
		}),
		sleep: vi.fn(async () => {}),
		loadWorkflowSteps: vi.fn(async () => null),
		capabilities: [],
	});
	const reminderRunner = new ReminderRunner({
		store: { load: vi.fn(async () => null), save: vi.fn(async () => {}) },
		notify: vi.fn(async () => {}),
	});
	const ports: AutomationsHostPorts = {
		scheduler: new SchedulerService(memStore()),
		reminderRunner,
		loadWorkflow: vi.fn(async () => null),
		makeInterpreterPorts: vi.fn(() => interpreterPorts()),
		persistRun: vi.fn(async (run) => {
			persisted.push(run);
		}),
		appCapabilities: [
			"notifications.post",
			"ai.use",
			"entities.read:*",
			"entities.write:*",
			"intents.dispatch:*",
		],
		clock: () => T0,
		...over,
	};
	return { host: new AutomationsHost(ports), ports, persisted };
}

describe("AutomationsHost — runWorkflow", () => {
	it("loads, runs under the workflow's caps, and persists a WorkflowRun/v1", async () => {
		const loaded: LoadedWorkflow = {
			steps: [notifyStep("n")],
			capabilities: ["notifications.post"],
		};
		const { host, ports, persisted } = hostWith({ loadWorkflow: vi.fn(async () => loaded) });
		const result = await host.runWorkflow("wf1", "trig1", { foo: 1 });
		expect(result?.status).toBe(WorkflowRunStatus.Succeeded);
		expect(ports.makeInterpreterPorts).toHaveBeenCalledWith(["notifications.post"]);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({
			workflow: "wf1",
			triggeredBy: "trig1",
			status: WorkflowRunStatus.Succeeded,
		});
	});

	it("persists a failed run with its error", async () => {
		const loaded: LoadedWorkflow = {
			// declares the cap its AICall step needs, so it clears the capability
			// gate and reaches the (gated, unimplemented) interpreter.
			steps: [{ id: "x", kind: StepKind.AICall, instructions: "n/a" }],
			capabilities: ["ai.use"],
		};
		const { host, persisted } = hostWith({ loadWorkflow: vi.fn(async () => loaded) });
		const result = await host.runWorkflow("wf1", "trig1", null);
		expect(result?.status).toBe(WorkflowRunStatus.Failed);
		expect(persisted[0]?.status).toBe(WorkflowRunStatus.Failed);
		expect(persisted[0]?.error).toContain("unsupported-step-kind");
	});

	it("refuses to run a workflow whose steps exceed its declared capabilities", async () => {
		// The security ceiling: a workflow saved with a benign capability sheet
		// (here: none) cannot act beyond it even though the app holds the grant.
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: [] };
		const { host, persisted } = hostWith({ loadWorkflow: vi.fn(async () => loaded) });
		const result = await host.runWorkflow("sneaky", "trig", null);
		expect(result).toBeNull();
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toMatchObject({ workflow: "sneaky", status: WorkflowRunStatus.Failed });
		expect(persisted[0]?.error).toBe("capability-denied:notifications.post");
	});

	it("refuses to run a workflow that declared more than the app holds", async () => {
		const loaded: LoadedWorkflow = {
			steps: [notifyStep("n")],
			capabilities: ["notifications.post"],
		};
		const { host, persisted } = hostWith({
			loadWorkflow: vi.fn(async () => loaded),
			appCapabilities: [], // app grants nothing
		});
		const result = await host.runWorkflow("wf", "trig", null);
		expect(result).toBeNull();
		expect(persisted[0]?.error).toBe("capability-denied:notifications.post");
	});

	it("is a no-op (no persist) for a missing/disabled workflow", async () => {
		const { host, persisted } = hostWith({ loadWorkflow: vi.fn(async () => null) });
		expect(await host.runWorkflow("gone", "t", null)).toBeNull();
		expect(persisted).toHaveLength(0);
	});

	it("runNow runs a workflow immediately with a manual payload", async () => {
		const captured: unknown[] = [];
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host } = hostWith({
			loadWorkflow: vi.fn(async () => loaded),
			makeInterpreterPorts: () => ({
				intents: { dispatch: vi.fn(async () => null) },
				entities: {
					create: vi.fn(),
					update: vi.fn(),
					get: vi.fn(),
					query: vi.fn(),
					delete: vi.fn(),
				} as unknown as InterpreterPorts["entities"],
				notify: vi.fn(async (n) => {
					captured.push(n);
				}),
				sleep: vi.fn(async () => {}),
				loadWorkflowSteps: vi.fn(async () => null),
				capabilities: ["notifications.post"],
			}),
		});
		const result = await host.runNow("wf1");
		expect(result?.status).toBe(WorkflowRunStatus.Succeeded);
		expect(result?.triggeredBy).toBe("manual:wf1");
	});
});

describe("AutomationsHost — tick routing", () => {
	it("routes a due time-trigger fire to runWorkflow + persists", async () => {
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host, ports, persisted } = hostWith({ loadWorkflow: vi.fn(async () => loaded) });
		await host.hydrate(
			{
				workflows: [{ triggerId: "trg", workflowId: "wf1", config: { oneShotAt: T0 } }],
				reminders: [],
				entityEvents: [],
			},
			T0 - DAY,
		);
		await host.tick(T0);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.workflow).toBe("wf1");
		// spent one-shot does not fire again
		await host.tick(T0 + DAY);
		expect(persisted).toHaveLength(1);
		expect(ports.loadWorkflow).toHaveBeenCalledTimes(1);
	});

	it("routes a due reminder fire to the ReminderRunner, not a workflow", async () => {
		const reminderFire = vi.fn(async () => true);
		const reminderRunner = {
			fire: reminderFire,
			configFor: vi.fn(),
			snooze: vi.fn(),
			complete: vi.fn(),
		};
		const { host, persisted } = hostWith({
			reminderRunner: reminderRunner as unknown as ReminderRunner,
			loadWorkflow: vi.fn(async () => null),
		});
		await host.hydrate(
			{
				workflows: [],
				reminders: [{ reminderId: "rem1", config: { oneShotAt: T0 } }],
				entityEvents: [],
			},
			T0 - DAY,
		);
		await host.tick(T0);
		expect(reminderFire).toHaveBeenCalledWith("rem1");
		expect(persisted).toHaveLength(0);
	});

	it("re-hydrate clears stale reminder ids so a reused id routes as a workflow", async () => {
		// Regression: reminderIds must be re-derived each hydrate. A reminder id
		// from a prior hydrate must not shadow a workflow that later reuses it.
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host, persisted } = hostWith({ loadWorkflow: vi.fn(async () => loaded) });
		await host.hydrate(
			{
				workflows: [],
				reminders: [{ reminderId: "shared", config: { oneShotAt: T0 } }],
				entityEvents: [],
			},
			T0 - DAY,
		);
		// Second hydrate: 'shared' is now a workflow trigger, no longer a reminder.
		await host.hydrate(
			{
				workflows: [{ triggerId: "shared", workflowId: "shared", config: { oneShotAt: T0 } }],
				reminders: [],
				entityEvents: [],
			},
			T0 - DAY,
		);
		await host.tick(T0);
		// The fire routed to the workflow runner (persisted a run), not the
		// stale reminder path.
		expect(persisted.map((r) => r.workflow)).toEqual(["shared"]);
	});

	it("a failing workflow fire does not abort the rest of the tick", async () => {
		const onError = vi.fn();
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host, persisted } = hostWith({
			onError,
			loadWorkflow: vi.fn(async (id) => {
				if (id === "bad") throw new Error("load exploded");
				return loaded;
			}),
		});
		await host.hydrate(
			{
				workflows: [
					{ triggerId: "t1", workflowId: "bad", config: { oneShotAt: T0 - 1 } },
					{ triggerId: "t2", workflowId: "wf2", config: { oneShotAt: T0 - 1 } },
				],
				reminders: [],
				entityEvents: [],
			},
			T0 - DAY,
		);
		await host.tick(T0);
		expect(onError).toHaveBeenCalled();
		expect(persisted.map((r) => r.workflow)).toEqual(["wf2"]);
	});
});

describe("AutomationsHost — entity-event triggers", () => {
	it("runs matching workflows on an entity change and ignores non-matches", async () => {
		const bus: { emit: ((c: EntityChange) => void) | null } = { emit: null };
		const entityChanges = {
			subscribe: (l: (c: EntityChange) => void) => {
				bus.emit = l;
				return () => {};
			},
		};
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host, persisted } = hostWith({
			entityChanges,
			loadWorkflow: vi.fn(async () => loaded),
		});
		await host.hydrate(
			{
				workflows: [],
				reminders: [],
				entityEvents: [{ workflowId: "onNewTask", type: "Task/v1", verb: EntityEventVerb.Create }],
			},
			T0,
		);
		host.start();
		bus.emit?.({ verb: EntityEventVerb.Create, entityId: "task9", type: "Task/v1" });
		await vi.waitFor(() => expect(persisted).toHaveLength(1));
		expect(persisted[0]?.workflow).toBe("onNewTask");
		expect(persisted[0]?.triggeredBy).toBe("entity-event:task9");
		// a non-matching change (wrong type) does nothing
		bus.emit?.({ verb: EntityEventVerb.Create, entityId: "n1", type: "Note/v1" });
		await new Promise((r) => setTimeout(r, 5));
		expect(persisted).toHaveLength(1);
		host.stop();
	});

	// Mailbox-8 — a new Email fires an EntityEvent trigger whose AICall step
	// triages it. Proves the whole path end-to-end: mail-created Email entities
	// already emit changes (they write through the same entities handler), the
	// generic EntityEvent framework matches `Email/v1`, and the AICall
	// interpreter runs once the host wires the AI broker port.
	it("triages a new Email through an AICall step when the AI port is wired", async () => {
		const bus: { emit: ((c: EntityChange) => void) | null } = { emit: null };
		const entityChanges = {
			subscribe: (l: (c: EntityChange) => void) => {
				bus.emit = l;
				return () => {};
			},
		};
		const aiCalls: Array<{ messages: readonly AiChatMessage[] }> = [];
		const ai = vi.fn(async (req: { messages: readonly AiChatMessage[] }) => {
			aiCalls.push({ messages: req.messages });
			return { content: "priority: high" };
		});
		const loaded: LoadedWorkflow = {
			steps: [{ id: "triage", kind: StepKind.AICall, instructions: "Classify this email." }],
			capabilities: ["ai.use"],
		};
		const { host, persisted } = hostWith({
			entityChanges,
			loadWorkflow: vi.fn(async () => loaded),
			// The production harness always wires `ai`; the default test harness
			// doesn't, so override to prove the interpreter runs.
			makeInterpreterPorts: (caps) => ({
				intents: { dispatch: vi.fn(async () => null) },
				entities: {
					create: vi.fn(),
					update: vi.fn(),
					get: vi.fn(),
					query: vi.fn(),
					delete: vi.fn(),
				},
				notify: vi.fn(async () => {}),
				sleep: vi.fn(async () => {}),
				loadWorkflowSteps: vi.fn(async () => null),
				ai,
				capabilities: caps,
			}),
		});
		await host.hydrate(
			{
				workflows: [],
				reminders: [],
				entityEvents: [
					{ workflowId: "triageMail", type: "brainstorm/Email/v1", verb: EntityEventVerb.Create },
				],
			},
			T0,
		);
		host.start();
		bus.emit?.({
			verb: EntityEventVerb.Create,
			entityId: "em1",
			type: "brainstorm/Email/v1",
		});
		await vi.waitFor(() => expect(persisted).toHaveLength(1));

		expect(persisted[0]?.status).toBe(WorkflowRunStatus.Succeeded);
		expect(ai).toHaveBeenCalledTimes(1);
		// The triage instructions are the system turn; the trigger payload (the
		// new email's ref) is the user turn the model triages.
		const system = aiCalls[0]?.messages[0];
		expect(system?.content).toBe("Classify this email.");
		expect(JSON.stringify(aiCalls[0]?.messages)).toContain("em1");
		host.stop();
	});
});

describe("AutomationsHost — lifecycle", () => {
	it("start arms a drain timer; tick fires through it; stop clears it", async () => {
		const { intervals, fire, isRunning } = manualIntervals();
		const loaded: LoadedWorkflow = { steps: [notifyStep("n")], capabilities: ["notifications.post"] };
		const { host, persisted } = hostWith({
			intervals,
			loadWorkflow: vi.fn(async () => loaded),
		});
		await host.hydrate(
			{
				workflows: [{ triggerId: "t", workflowId: "wf", config: { oneShotAt: T0 - 1 } }],
				reminders: [],
				entityEvents: [],
			},
			T0 - DAY,
		);
		host.start();
		expect(isRunning()).toBe(true);
		fire();
		await vi.waitFor(() => expect(persisted).toHaveLength(1));
		host.stop();
		expect(isRunning()).toBe(false);
	});
});
