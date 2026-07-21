import {
	ConcurrencyPolicy,
	EntityOp,
	REMINDER_TYPE_URL,
	type ReminderDef,
	StepKind,
	TRIGGER_TYPE_URL,
	type TriggerDef,
	TriggerKind,
	WORKFLOW_TYPE_URL,
	type WorkflowDef,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { WORKFLOW_TEMPLATES } from "../logic/templates";
import { type AutomationBundle, importAutomation } from "../logic/transfer";
import {
	deleteReminder,
	instantiateWorkflowTemplate,
	listReminders,
	listRuns,
	listWorkflows,
	loadTrigger,
	persistImportedAutomation,
	propertiesToReminder,
	propertiesToTrigger,
	propertiesToWorkflow,
	reminderToProperties,
	saveReminder,
	saveTrigger,
	saveWorkflow,
	triggerToProperties,
	workflowToProperties,
} from "./automation-repository";
import type { EntitiesService, EntityRecord } from "./runtime";

const goodWorkflow: WorkflowDef = {
	name: "Weekly digest",
	enabled: true,
	triggerId: "ent_trigger",
	steps: [{ id: "1", kind: StepKind.Notify, title: "hi" }],
	capabilities: ["notifications.post"],
	concurrency: ConcurrencyPolicy.Queue,
	description: "Sends a weekly summary",
};

const goodReminder: ReminderDef = {
	subject: "Call Priya",
	dueAt: "2026-06-08T09:00:00Z",
	recurrence: "FREQ=WEEKLY",
};

describe("workflow round-trip", () => {
	it("survives properties → def → properties", () => {
		const props = workflowToProperties(goodWorkflow);
		const back = propertiesToWorkflow(props);
		expect(back).toEqual(goodWorkflow);
	});

	it("omits absent optionals", () => {
		const props = workflowToProperties({
			name: "Bare",
			enabled: false,
			triggerId: "t",
			steps: [],
			capabilities: [],
		});
		expect("description" in props).toBe(false);
		expect("concurrency" in props).toBe(false);
		expect("tags" in props).toBe(false);
	});

	it("decodes a malformed bag to safe defaults without throwing", () => {
		const back = propertiesToWorkflow({
			name: 42,
			enabled: "yes",
			steps: "not-an-array",
			capabilities: ["ok", 7, null],
			concurrency: "burst",
		});
		expect(back.name).toBe("");
		expect(back.enabled).toBe(false);
		expect(back.triggerId).toBe("");
		expect(back.steps).toEqual([]);
		expect(back.capabilities).toEqual(["ok"]);
		expect(back.concurrency).toBeUndefined();
	});
});

describe("reminder round-trip", () => {
	it("survives properties → def → properties", () => {
		expect(propertiesToReminder(reminderToProperties(goodReminder))).toEqual(goodReminder);
	});

	it("decodes a malformed bag to safe defaults", () => {
		const back = propertiesToReminder({ subject: 1, dueAt: null });
		expect(back.subject).toBe("");
		expect(back.dueAt).toBe("");
		expect(back.recurrence).toBeUndefined();
	});
});

function fakeEntities(): EntitiesService & { records: Map<string, EntityRecord> } {
	const records = new Map<string, EntityRecord>();
	let n = 0;
	return {
		records,
		async get(id) {
			return records.get(id) ?? null;
		},
		async query({ type }) {
			const types = type === undefined ? null : Array.isArray(type) ? type : [type];
			return [...records.values()].filter((r) => !types || types.includes(r.type));
		},
		async create(type, properties, id) {
			const rid = id ?? `ent_${++n}`;
			const rec: EntityRecord = { id: rid, type, properties, createdAt: 0, updatedAt: 0 };
			records.set(rid, rec);
			return rec;
		},
		async update(id, patch) {
			const existing = records.get(id);
			if (!existing) throw new Error("no such record");
			const rec = { ...existing, properties: { ...existing.properties, ...patch } };
			records.set(id, rec);
			return rec;
		},
		async delete(id) {
			records.delete(id);
		},
	};
}

describe("entities-service persistence", () => {
	it("returns [] outside the shell (no entities service)", async () => {
		expect(await listWorkflows(null)).toEqual([]);
		expect(await listReminders(undefined)).toEqual([]);
		expect(await saveWorkflow(null, goodWorkflow)).toBeNull();
	});

	it("creates then updates a workflow keyed by id, scoped by type", async () => {
		const svc = fakeEntities();
		const created = await saveWorkflow(svc, goodWorkflow);
		expect(created?.type).toBe(WORKFLOW_TYPE_URL);

		const edited = await saveWorkflow(svc, { ...goodWorkflow, enabled: false }, created?.id);
		expect(edited?.id).toBe(created?.id);
		expect(svc.records.size).toBe(1);

		const listed = await listWorkflows(svc);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.def.enabled).toBe(false);
	});

	it("persists reminders under their own type", async () => {
		const svc = fakeEntities();
		await saveReminder(svc, goodReminder);
		const reminders = await listReminders(svc);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.def.subject).toBe("Call Priya");
		expect([...svc.records.values()][0]?.type).toBe(REMINDER_TYPE_URL);
		expect(await listWorkflows(svc)).toEqual([]);
	});

	it("refuses to persist an invalid workflow", async () => {
		const svc = fakeEntities();
		await expect(saveWorkflow(svc, { ...goodWorkflow, name: "  ", steps: [] })).rejects.toThrow(
			/invalid Workflow/,
		);
	});

	it("uses EntityOp + StepKind enums end-to-end", async () => {
		const svc = fakeEntities();
		const wf: WorkflowDef = {
			name: "Onboard client",
			enabled: true,
			triggerId: "t",
			steps: [{ id: "1", kind: StepKind.Entity, op: EntityOp.Create, entityType: "Task/v1" }],
			capabilities: ["entities.write:Task/v1"],
		};
		await saveWorkflow(svc, wf);
		const [loaded] = await listWorkflows(svc);
		expect(loaded?.def.steps[0]?.kind).toBe(StepKind.Entity);
	});

	it("deletes a reminder", async () => {
		const svc = fakeEntities();
		const created = await saveReminder(svc, goodReminder);
		await deleteReminder(svc, created?.id ?? "");
		expect(await listReminders(svc)).toEqual([]);
	});

	it("reads WorkflowRun records via listRuns", async () => {
		const svc = fakeEntities();
		await svc.create("brainstorm/WorkflowRun/v1", {
			workflow: "wf-1",
			status: "succeeded",
			triggeredAt: "2026-06-08T09:00:00Z",
		});
		expect(await listRuns(svc)).toHaveLength(1);
	});
});

const goodTrigger: TriggerDef = {
	kind: TriggerKind.Time,
	config: { recurrence: { kind: "daily", every: 1 } },
	enabled: true,
};

describe("trigger round-trip", () => {
	it("survives properties → def → properties", () => {
		expect(propertiesToTrigger(triggerToProperties(goodTrigger))).toEqual(goodTrigger);
	});

	it("decodes a malformed bag to safe defaults", () => {
		const back = propertiesToTrigger({ kind: "nonsense", config: null, enabled: "yes" });
		expect(back.kind).toBe(TriggerKind.Manual);
		expect(back.config).toEqual({});
		expect(back.enabled).toBe(false);
	});
});

describe("instantiateWorkflowTemplate", () => {
	it("persists a trigger then a workflow bound to its id, disabled", async () => {
		const svc = fakeEntities();
		const template = WORKFLOW_TEMPLATES[0];
		if (!template) throw new Error("no templates");
		const workflow = await instantiateWorkflowTemplate(svc, template);
		expect(workflow?.type).toBe(WORKFLOW_TYPE_URL);
		expect(workflow?.properties.enabled).toBe(false);

		const triggers = [...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL);
		expect(triggers).toHaveLength(1);
		expect(workflow?.properties.triggerId).toBe(triggers[0]?.id);
	});

	it("returns null outside the shell", async () => {
		const template = WORKFLOW_TEMPLATES[0];
		if (!template) throw new Error("no templates");
		expect(await instantiateWorkflowTemplate(null, template)).toBeNull();
	});

	it("rolls back the orphaned trigger when the workflow write fails", async () => {
		const svc = fakeEntities();
		const realCreate = svc.create.bind(svc);
		svc.create = async (type, props, id) => {
			if (type === WORKFLOW_TYPE_URL) throw new Error("workflow write failed");
			return realCreate(type, props, id);
		};
		const template = WORKFLOW_TEMPLATES[0];
		if (!template) throw new Error("no templates");
		await expect(instantiateWorkflowTemplate(svc, template)).rejects.toThrow(/workflow write/);
		// The trigger created in the first step must not survive the failure.
		expect([...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL)).toEqual([]);
	});
});

describe("loadTrigger", () => {
	const trigger: TriggerDef = { kind: TriggerKind.Time, config: { every: 1 }, enabled: true };

	it("decodes a stored trigger by id", async () => {
		const svc = fakeEntities();
		const rec = await saveTrigger(svc, trigger);
		const loaded = await loadTrigger(svc, rec?.id ?? "");
		expect(loaded?.kind).toBe(TriggerKind.Time);
	});

	it("returns null for an absent id or outside the shell", async () => {
		expect(await loadTrigger(fakeEntities(), "nope")).toBeNull();
		expect(await loadTrigger(null, "x")).toBeNull();
	});
});

describe("persistImportedAutomation", () => {
	const bundle: AutomationBundle = {
		kind: "brainstorm/automation-bundle",
		version: 1,
		workflow: { name: "Imported", steps: [{ id: "n", kind: StepKind.Notify, title: "Hi" }] },
		trigger: { kind: TriggerKind.Manual, config: {} },
	};

	it("mints a disabled trigger+workflow pair", async () => {
		const svc = fakeEntities();
		const workflow = await persistImportedAutomation(svc, importAutomation(bundle, "Imported"));
		expect(workflow?.type).toBe(WORKFLOW_TYPE_URL);
		expect(workflow?.properties.enabled).toBe(false);
		const triggers = [...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL);
		expect(triggers).toHaveLength(1);
		expect(workflow?.properties.triggerId).toBe(triggers[0]?.id);
	});

	it("returns null outside the shell", async () => {
		expect(await persistImportedAutomation(null, importAutomation(bundle))).toBeNull();
	});

	it("rolls back the orphaned trigger on workflow write failure", async () => {
		const svc = fakeEntities();
		const realCreate = svc.create.bind(svc);
		svc.create = async (type, props, id) => {
			if (type === WORKFLOW_TYPE_URL) throw new Error("workflow write failed");
			return realCreate(type, props, id);
		};
		await expect(persistImportedAutomation(svc, importAutomation(bundle))).rejects.toThrow(
			/workflow write/,
		);
		expect([...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL)).toEqual([]);
	});
});
