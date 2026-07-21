/**
 * Agent-6 — unit tests for generalizing a conversation into a Workflow/v1 draft.
 * Covers: tool-activity gating, step mapping (AIAgent + Manual trigger), args →
 * `{{input}}` parameter generalization, idempotency, and the cap-subset
 * invariant (the security keystone).
 */

import {
	type AgentLoopStep,
	type AgentTool,
	MemoryMode,
	StepKind,
	TriggerKind,
	aggregateWorkflowCapabilities,
	isCapabilitySubset,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	GeneralizeRefusal,
	WORKFLOW_INPUT_TOKEN,
	deriveWorkflowName,
	dispatchedEntityIds,
	dispatchedTools,
	generalizeConversationToWorkflow,
	generalizeInstruction,
} from "./save-as-automation";

const OPEN_TOOL: AgentTool = { verb: "open", label: "Open an object" };
const OPEN_CAP = "intents.dispatch:open";
// The conversation's frozen set is the full effective set (Agent-5) — it carries
// the infrastructure caps the chat runs on (`ai.use`, `ai.provider:*`) as well as
// the toggleable `intents.dispatch:*` tools. An AIAgent step needs `ai.use`, so a
// realistic frozen set includes it.
const FROZEN: string[] = ["ai.use", "ai.provider:ollama", OPEN_CAP];

function call(entityId?: string): AgentLoopStep {
	return { kind: "tool-call", call: { tool: "open", args: entityId ? { entityId } : {} } };
}
const result = (tool = "open"): AgentLoopStep => ({ kind: "tool-result", tool, output: {} });

const baseInput = {
	steps: [call("ent_01H9XABCDEFGHJKMNPQRSTVWXY"), result()] as AgentLoopStep[],
	instruction: "Open ent_01H9XABCDEFGHJKMNPQRSTVWXY and summarise it",
	offeredTools: [OPEN_TOOL],
	frozenCapabilities: FROZEN,
	conversationTitle: "Summarise a note",
};

describe("dispatchedTools", () => {
	it("returns only tools that produced a tool-result", () => {
		const steps: AgentLoopStep[] = [call(), result("open")];
		expect(dispatchedTools(steps, [OPEN_TOOL])).toEqual([OPEN_TOOL]);
	});

	it("ignores tool-calls that never resulted and unknown verbs", () => {
		const steps: AgentLoopStep[] = [call(), result("create")];
		expect(dispatchedTools(steps, [OPEN_TOOL])).toEqual([]);
	});

	it("dedupes a verb used more than once", () => {
		const steps: AgentLoopStep[] = [result("open"), result("open")];
		expect(dispatchedTools(steps, [OPEN_TOOL])).toEqual([OPEN_TOOL]);
	});
});

describe("dispatchedEntityIds", () => {
	it("collects the entity ids the loop dispatched against, deduped + ordered", () => {
		const steps: AgentLoopStep[] = [call("ent_A"), call("ent_B"), call("ent_A")];
		expect(dispatchedEntityIds(steps)).toEqual(["ent_A", "ent_B"]);
	});

	it("ignores non-string / missing ids", () => {
		const steps: AgentLoopStep[] = [{ kind: "tool-call", call: { tool: "open", args: {} } }];
		expect(dispatchedEntityIds(steps)).toEqual([]);
	});
});

describe("generalizeInstruction", () => {
	it("replaces entity-id tokens with the input placeholder", () => {
		const { instruction, parameters } = generalizeInstruction("Open ent_01ABC and tell me");
		expect(instruction).toBe(`Open ${WORKFLOW_INPUT_TOKEN} and tell me`);
		expect(parameters).toEqual([{ token: WORKFLOW_INPUT_TOKEN, example: "ent_01ABC" }]);
	});

	it("leaves an instruction with no ids untouched (no params)", () => {
		const { instruction, parameters } = generalizeInstruction("Summarise my recent notes");
		expect(instruction).toBe("Summarise my recent notes");
		expect(parameters).toEqual([]);
	});

	it("is idempotent — re-running over the placeholder adds no new params", () => {
		const once = generalizeInstruction("Open ent_01ABC");
		const twice = generalizeInstruction(once.instruction);
		expect(twice.instruction).toBe(once.instruction);
		expect(twice.parameters).toEqual([]);
	});

	it("dedupes a repeated id into one parameter", () => {
		const { parameters } = generalizeInstruction("Compare ent_A with ent_A");
		expect(parameters).toEqual([{ token: WORKFLOW_INPUT_TOKEN, example: "ent_A" }]);
	});
});

describe("deriveWorkflowName", () => {
	it("prefers the conversation title", () => {
		expect(deriveWorkflowName("My title", "do a thing")).toBe("My title");
	});

	it("falls back to the first instruction line", () => {
		expect(deriveWorkflowName("", "First line\nsecond")).toBe("First line");
	});

	it("bounds a long name", () => {
		const name = deriveWorkflowName("x".repeat(100), "");
		expect(name.length).toBeLessThanOrEqual(60);
		expect(name.endsWith("…")).toBe(true);
	});
});

describe("generalizeConversationToWorkflow", () => {
	it("refuses a conversation that ran no tools", () => {
		const res = generalizeConversationToWorkflow({ ...baseInput, steps: [] });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe(GeneralizeRefusal.NoToolActivity);
	});

	it("produces a Manual trigger + a single AIAgent step", () => {
		const res = generalizeConversationToWorkflow(baseInput);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.draft.trigger.kind).toBe(TriggerKind.Manual);
		expect(res.draft.trigger.enabled).toBe(true);
		expect(res.draft.workflow.steps).toHaveLength(2);
		expect(res.draft.workflow.steps[0]?.kind).toBe(StepKind.Trigger);
		const step = res.draft.workflow.steps[1];
		expect(step?.kind).toBe(StepKind.AIAgent);
		if (step?.kind === StepKind.AIAgent) {
			expect(step.tools).toEqual([OPEN_TOOL]);
			expect(step.memory).toBe(MemoryMode.PerRun);
			expect(step.instructions).toContain(WORKFLOW_INPUT_TOKEN);
		}
	});

	it("saves the workflow DISABLED (a review-then-enable affordance)", () => {
		const res = generalizeConversationToWorkflow(baseInput);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.draft.workflow.enabled).toBe(false);
	});

	it("generalizes the run's entity ids into example parameters, not baked args", () => {
		const res = generalizeConversationToWorkflow(baseInput);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.draft.parameters).toEqual([
			{ token: WORKFLOW_INPUT_TOKEN, example: "ent_01H9XABCDEFGHJKMNPQRSTVWXY" },
		]);
		const step = res.draft.workflow.steps[1];
		if (step?.kind === StepKind.AIAgent) {
			expect(step.instructions).not.toContain("ent_01H9XABCDEFGHJKMNPQRSTVWXY");
		}
	});

	it("carries the pinned provider/model onto the step", () => {
		const res = generalizeConversationToWorkflow({
			...baseInput,
			provider: "ollama",
			model: "llama3.2",
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		const step = res.draft.workflow.steps[1];
		if (step?.kind === StepKind.AIAgent) {
			expect(step.provider).toBe("ollama");
			expect(step.model).toBe("llama3.2");
		}
	});

	it("is deterministic — same input yields a byte-equal draft", () => {
		const a = generalizeConversationToWorkflow(baseInput);
		const b = generalizeConversationToWorkflow(baseInput);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	// ── the security keystone ──────────────────────────────────────────────────

	it("the workflow's capabilities are a SUBSET of the conversation's frozen caps", () => {
		const res = generalizeConversationToWorkflow(baseInput);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.draft.workflow.capabilities).toEqual(["ai.use", OPEN_CAP]);
		expect(isCapabilitySubset(res.draft.workflow.capabilities, baseInput.frozenCapabilities)).toBe(
			true,
		);
	});

	it("aggregate caps over the steps equal the declared workflow caps", () => {
		const res = generalizeConversationToWorkflow(baseInput);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(aggregateWorkflowCapabilities(res.draft.workflow.steps)).toEqual(
			res.draft.workflow.capabilities,
		);
	});

	it("drops a used tool whose caps the frozen set no longer covers (fail closed)", () => {
		// The conversation dispatched `open`, but its frozen set is now empty — the
		// tool is dropped, and with nothing left the draft is refused (never emitted
		// with a cap the frozen set lacks).
		const res = generalizeConversationToWorkflow({ ...baseInput, frozenCapabilities: [] });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe(GeneralizeRefusal.CapabilityExceeded);
	});

	it("never emits a workflow cap outside the frozen ceiling", () => {
		// A scoped tool whose entity-read cap is NOT in the frozen set: the tool is
		// filtered out, the draft refused — proving no broadened cap can leak.
		const scopedTool: AgentTool = { verb: "open", entityType: "brainstorm/Note/v1", label: "Open" };
		const res = generalizeConversationToWorkflow({
			...baseInput,
			offeredTools: [scopedTool],
			// frozen has ai.use + the dispatch but NOT the entities.read the scoped
			// tool needs — so the tool is dropped and the draft refused.
			frozenCapabilities: ["ai.use", OPEN_CAP],
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe(GeneralizeRefusal.CapabilityExceeded);
	});
});
