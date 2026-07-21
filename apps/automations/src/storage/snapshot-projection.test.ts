import {
	REMINDER_TYPE_URL,
	type VaultEntity,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	remindersFromSnapshot,
	runsFromSnapshot,
	workflowsFromSnapshot,
} from "./automation-repository";

function entity(
	id: string,
	type: string,
	properties: Record<string, unknown>,
	deletedAt: number | null = null,
): VaultEntity {
	return { id, type, properties, createdAt: 1, updatedAt: 1, deletedAt, ownerAppId: "app" };
}

describe("workflowsFromSnapshot", () => {
	it("projects + decodes only live Workflow/v1 entities", () => {
		const snapshot = [
			entity("wf-1", WORKFLOW_TYPE_URL, {
				name: "Daily",
				enabled: true,
				triggerId: "t",
				steps: [{}, {}],
				capabilities: [],
			}),
			entity("wf-dead", WORKFLOW_TYPE_URL, { name: "gone" }, 99),
			entity("n1", "brainstorm/Note/v1", { name: "note" }),
		];
		const workflows = workflowsFromSnapshot(snapshot);
		expect(workflows).toHaveLength(1);
		expect(workflows[0]?.def.name).toBe("Daily");
		expect(workflows[0]?.def.enabled).toBe(true);
		expect(workflows[0]?.def.steps).toHaveLength(2);
	});
});

describe("remindersFromSnapshot", () => {
	it("projects + decodes Reminder/v1 entities", () => {
		const snapshot = [
			entity("rm-1", REMINDER_TYPE_URL, { subject: "Call", dueAt: "2026-01-01T00:00:00.000Z" }),
			entity("rm-dead", REMINDER_TYPE_URL, { subject: "x", dueAt: "" }, 5),
		];
		const reminders = remindersFromSnapshot(snapshot);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]?.def.subject).toBe("Call");
	});
});

describe("runsFromSnapshot", () => {
	it("builds sorted run views resolving the workflow name from the same snapshot", () => {
		const snapshot = [
			entity("wf-1", WORKFLOW_TYPE_URL, {
				name: "Digest",
				enabled: true,
				triggerId: "t",
				steps: [],
				capabilities: [],
			}),
			entity("run-old", WORKFLOW_RUN_TYPE_URL, {
				workflow: "wf-1",
				status: "succeeded",
				triggeredAt: "2026-01-01T09:00:00.000Z",
			}),
			entity("run-new", WORKFLOW_RUN_TYPE_URL, {
				workflow: "wf-1",
				status: "failed",
				triggeredAt: "2026-02-01T09:00:00.000Z",
			}),
		];
		const runs = runsFromSnapshot(snapshot);
		expect(runs).toHaveLength(2);
		// Newest first.
		expect(runs[0]?.id).toBe("run-new");
		expect(runs[0]?.workflowName).toBe("Digest");
	});
});
