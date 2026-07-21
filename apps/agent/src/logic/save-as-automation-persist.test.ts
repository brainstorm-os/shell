/**
 * Agent-6 — persist test: a confirmed draft writes a Trigger entity first, then
 * a Workflow entity bound to its id, through the (faked) cap-checked entities
 * service. Verifies the two writes, the id binding, and that the persisted
 * workflow carries the draft's reviewed capability set unchanged.
 */

import {
	type Entity,
	StepKind,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_TYPE_URL,
	propertiesToWorkflow,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { WorkflowDraft } from "./save-as-automation";
import { persistWorkflowDraft } from "./save-as-automation-persist";

function fakeEntities(): {
	create: (type: string, props: Record<string, unknown>) => Promise<Entity>;
	creates: { type: string; properties: Record<string, unknown> }[];
} {
	const creates: { type: string; properties: Record<string, unknown> }[] = [];
	let n = 0;
	const create = async (type: string, properties: Record<string, unknown>): Promise<Entity> => {
		creates.push({ type, properties });
		n += 1;
		return { id: `ent_${n}`, type, properties } as unknown as Entity;
	};
	return { create, creates };
}

const draft: WorkflowDraft = {
	trigger: { kind: TriggerKind.Manual, config: {}, enabled: true },
	workflow: {
		name: "Summarise a note",
		enabled: false,
		steps: [
			{ id: "trigger", kind: StepKind.Trigger },
			{
				id: "agent",
				kind: StepKind.AIAgent,
				instructions: "do it",
				tools: [{ verb: "open", label: "Open" }],
			},
		],
		capabilities: ["ai.use", "intents.dispatch:open"],
	},
	parameters: [],
};

describe("persistWorkflowDraft", () => {
	it("creates the Trigger first, then the Workflow bound to its id", async () => {
		const entities = fakeEntities();
		const id = await persistWorkflowDraft(entities as never, draft);

		expect(entities.creates).toHaveLength(2);
		expect(entities.creates[0]?.type).toBe(TRIGGER_TYPE_URL);
		expect(entities.creates[1]?.type).toBe(WORKFLOW_TYPE_URL);
		expect(id).toBe("ent_2");

		const wfProps = entities.creates[1]?.properties ?? {};
		const decoded = propertiesToWorkflow(wfProps);
		expect(decoded.triggerId).toBe("ent_1");
		expect(decoded.name).toBe("Summarise a note");
		expect(decoded.enabled).toBe(false);
		expect(decoded.capabilities).toEqual(["ai.use", "intents.dispatch:open"]);
	});
});
