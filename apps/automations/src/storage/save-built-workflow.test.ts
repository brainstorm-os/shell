import {
	StepKind,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_TYPE_URL,
	type WorkflowDef,
	type WorkflowStep,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { type BuilderState, triggerStep } from "../logic/builder-model";
import { type BuilderTrigger, emptyBuilderTrigger } from "../logic/builder-trigger";
import { propertiesToWorkflow, saveBuiltWorkflow } from "./automation-repository";
import type { EntitiesService, EntityRecord } from "./runtime";

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

const notify: WorkflowStep = { id: "n", kind: StepKind.Notify, title: "Hi" };

function newState(): BuilderState {
	return { name: "Greet", steps: [triggerStep(), notify] };
}

function timeTrigger(): BuilderTrigger {
	return { ...emptyBuilderTrigger(), kind: TriggerKind.Time };
}

describe("saveBuiltWorkflow", () => {
	it("returns null outside the shell", async () => {
		expect(await saveBuiltWorkflow(null, newState(), emptyBuilderTrigger())).toBeNull();
	});

	it("mints the Trigger first, then a disabled Workflow bound to its id with the step sheet", async () => {
		const svc = fakeEntities();
		const record = await saveBuiltWorkflow(svc, newState(), timeTrigger());
		expect(record).not.toBeNull();
		const triggers = [...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL);
		const workflows = [...svc.records.values()].filter((r) => r.type === WORKFLOW_TYPE_URL);
		expect(triggers).toHaveLength(1);
		expect(workflows).toHaveLength(1);
		const def = propertiesToWorkflow(workflows[0]?.properties);
		expect(def.triggerId).toBe(triggers[0]?.id);
		expect(def.enabled).toBe(false);
		expect(def.capabilities).toContain("notifications.post");
	});

	it("rolls the trigger back when the workflow write fails", async () => {
		const svc = fakeEntities();
		const bad: BuilderState = { name: "", steps: [triggerStep()] };
		await expect(saveBuiltWorkflow(svc, bad, timeTrigger())).rejects.toThrow();
		expect([...svc.records.values()].filter((r) => r.type === TRIGGER_TYPE_URL)).toHaveLength(0);
	});

	it("updates the existing trigger + workflow in place, preserving enabled", async () => {
		const svc = fakeEntities();
		const trigger = await svc.create(TRIGGER_TYPE_URL, {
			kind: TriggerKind.Manual,
			config: {},
			enabled: true,
		});
		const existingDef: WorkflowDef = {
			name: "Old",
			enabled: true,
			triggerId: trigger.id,
			steps: [triggerStep(), notify],
			capabilities: ["notifications.post"],
		};
		const wf = await svc.create(WORKFLOW_TYPE_URL, {
			name: existingDef.name,
			enabled: existingDef.enabled,
			triggerId: existingDef.triggerId,
			steps: existingDef.steps,
			capabilities: existingDef.capabilities,
		});

		const renamed: BuilderState = { name: "New name", steps: [triggerStep(), notify] };
		await saveBuiltWorkflow(svc, renamed, timeTrigger(), {
			workflowId: wf.id,
			triggerId: trigger.id,
			enabled: true,
		});

		const def = propertiesToWorkflow(svc.records.get(wf.id)?.properties);
		expect(def.name).toBe("New name");
		expect(def.enabled).toBe(true);
		expect(svc.records.get(trigger.id)?.properties.kind).toBe(TriggerKind.Time);
		// No new entities — the update path reuses the ids.
		expect([...svc.records.values()].filter((r) => r.type === WORKFLOW_TYPE_URL)).toHaveLength(1);
	});
});
