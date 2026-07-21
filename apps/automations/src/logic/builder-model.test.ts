import {
	EntityOp,
	StepKind,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	BUILDER_STEP_KINDS,
	BuilderIssueKind,
	type BuilderState,
	CapabilityRowState,
	UNBOUND,
	addStep,
	allStepIds,
	bindableSteps,
	bindingExpression,
	bindingStepId,
	builderStateFromWorkflow,
	builderStateToWorkflow,
	cloneStepWithFreshIds,
	computeCapabilitySheet,
	duplicateStep,
	emptyBuilderState,
	makeStep,
	moveStep,
	removeStep,
	stepBindingExpressions,
	triggerStep,
	updateStep,
	validateBuilderWorkflow,
} from "./builder-model";

const APP_CAPS = [
	"entities.read:*",
	"entities.write:brainstorm/Note/v1",
	"notifications.post",
	"intents.dispatch:open",
];

function notify(id: string, title = "Hi"): WorkflowStep {
	return { id, kind: StepKind.Notify, title };
}

describe("palette", () => {
	it("offers the engine-spine + AI kinds (11b.7), never Trigger or HTTP", () => {
		expect(BUILDER_STEP_KINDS).toContain(StepKind.Notify);
		expect(BUILDER_STEP_KINDS).toContain(StepKind.Branch);
		// 11b.7 — AICall/AIAgent are now buildable (their interpreters landed).
		expect(BUILDER_STEP_KINDS).toContain(StepKind.AICall);
		expect(BUILDER_STEP_KINDS).toContain(StepKind.AIAgent);
		expect(BUILDER_STEP_KINDS).not.toContain(StepKind.Trigger);
		// HTTP stays gated until its per-origin egress allowlist (11b.8b).
		expect(BUILDER_STEP_KINDS).not.toContain(StepKind.HTTP);
	});

	it("mints a step of each builder kind with a fresh id and safe defaults", () => {
		for (const kind of BUILDER_STEP_KINDS) {
			const step = makeStep(kind);
			expect(step.kind).toBe(kind);
			expect(step.id).toMatch(/^step-/);
		}
		const entity = makeStep(StepKind.Entity);
		expect(entity.kind === StepKind.Entity && entity.op).toBe(EntityOp.Query);
	});

	it("offers the Export step (IE-8) defaulting to a valid markdown format", () => {
		expect(BUILDER_STEP_KINDS).toContain(StepKind.Export);
		const step = makeStep(StepKind.Export);
		expect(step.kind === StepKind.Export && step.format).toBe("markdown");
	});
});

describe("linear composition", () => {
	it("starts with just the trigger pseudo-step", () => {
		const s = emptyBuilderState();
		expect(s.steps).toHaveLength(1);
		expect(s.steps[0]?.kind).toBe(StepKind.Trigger);
		expect(bindableSteps(s.steps)).toHaveLength(0);
	});

	it("appends a step", () => {
		const s = addStep(emptyBuilderState(), StepKind.Notify);
		expect(s.steps).toHaveLength(2);
		expect(s.steps[1]?.kind).toBe(StepKind.Notify);
	});

	it("never appends a Trigger from the palette", () => {
		const s = addStep(emptyBuilderState(), StepKind.Trigger);
		expect(s.steps).toHaveLength(1);
	});

	it("protects the trigger from removal and from moving", () => {
		let s = addStep(emptyBuilderState(), StepKind.Notify);
		s = removeStep(s, 0);
		expect(s.steps[0]?.kind).toBe(StepKind.Trigger);
		const moved = moveStep(s, 1, -1);
		expect(moved.steps[0]?.kind).toBe(StepKind.Trigger);
	});

	it("reorders post-trigger steps", () => {
		let s = emptyBuilderState();
		s = addStep(s, StepKind.Notify);
		s = addStep(s, StepKind.Wait);
		const moved = moveStep(s, 2, -1);
		expect(moved.steps[1]?.kind).toBe(StepKind.Wait);
		expect(moved.steps[2]?.kind).toBe(StepKind.Notify);
	});

	it("updates a step in place", () => {
		let s = addStep(emptyBuilderState(), StepKind.Notify);
		s = updateStep(s, 1, notify(s.steps[1]?.id ?? "x", "Updated"));
		const step = s.steps[1];
		expect(step?.kind === StepKind.Notify && step.title).toBe("Updated");
	});
});

describe("duplicate mints fresh ids (OQ-166 copy/paste)", () => {
	it("clones a step with a new id", () => {
		const original = makeStep(StepKind.Notify);
		const clone = cloneStepWithFreshIds(original);
		expect(clone.id).not.toBe(original.id);
		expect(clone.kind).toBe(original.kind);
	});

	it("recursively re-ids container children", () => {
		const branch: WorkflowStep = {
			id: "b1",
			kind: StepKind.Branch,
			condition: "input",
			consequent: [notify("c1")],
			alternate: [notify("a1")],
		};
		const clone = cloneStepWithFreshIds(branch);
		expect(clone.id).not.toBe("b1");
		if (clone.kind === StepKind.Branch) {
			expect(clone.consequent[0]?.id).not.toBe("c1");
			expect(clone.alternate?.[0]?.id).not.toBe("a1");
		}
	});

	it("inserts the clone right after its source", () => {
		let s = addStep(emptyBuilderState(), StepKind.Notify);
		s = duplicateStep(s, 1);
		expect(s.steps).toHaveLength(3);
		expect(s.steps[1]?.id).not.toBe(s.steps[2]?.id);
		expect(s.steps[2]?.kind).toBe(StepKind.Notify);
	});
});

describe("output binding", () => {
	it("builds a bare step-id and a member-path expression", () => {
		expect(bindingExpression("step-1")).toBe("step-1");
		expect(bindingExpression("step-1", "bullets")).toBe("step-1.bullets");
		expect(bindingExpression("")).toBe(UNBOUND);
	});

	it("extracts the leading step-id token, treating input as not-a-step", () => {
		expect(bindingStepId("step-1.field")).toBe("step-1");
		expect(bindingStepId("step-1[0]")).toBe("step-1");
		expect(bindingStepId("input")).toBeNull();
		expect(bindingStepId("input.rows")).toBeNull();
		expect(bindingStepId("")).toBeNull();
	});

	it("lists only the expression-bearing fields per kind", () => {
		expect(
			stepBindingExpressions({ id: "b", kind: StepKind.Branch, condition: "x", consequent: [] }),
		).toEqual(["x"]);
		expect(
			stepBindingExpressions({ id: "f", kind: StepKind.ForEach, collection: "c", body: [] }),
		).toEqual(["c"]);
		expect(stepBindingExpressions({ id: "c", kind: StepKind.Code, expression: "e" })).toEqual(["e"]);
		expect(stepBindingExpressions(notify("n"))).toEqual([]);
	});
});

describe("capability sheet", () => {
	it("unions step caps and marks granted vs missing against the app ceiling", () => {
		const steps: WorkflowStep[] = [
			triggerStep(),
			notify("n"),
			{ id: "e", kind: StepKind.Entity, op: EntityOp.Create, entityType: "brainstorm/Secret/v1" },
		];
		const sheet = computeCapabilitySheet(steps, APP_CAPS);
		expect(sheet.required).toEqual(aggregateWorkflowCapabilities(steps));
		const notifyRow = sheet.rows.find((r) => r.capability === "notifications.post");
		expect(notifyRow?.state).toBe(CapabilityRowState.Granted);
		const secretRow = sheet.rows.find((r) => r.capability === "entities.write:brainstorm/Secret/v1");
		expect(secretRow?.state).toBe(CapabilityRowState.Missing);
		expect(sheet.missing).toContain("entities.write:brainstorm/Secret/v1");
	});

	it("is empty for a workflow whose steps need no caps", () => {
		const sheet = computeCapabilitySheet([triggerStep(), makeStep(StepKind.Wait)], APP_CAPS);
		expect(sheet.required).toHaveLength(0);
		expect(sheet.missing).toHaveLength(0);
	});

	it("11b.7 — an AIAgent's tools surface their intents.dispatch caps in the sheet", () => {
		const agent: WorkflowStep = {
			id: "g",
			kind: StepKind.AIAgent,
			instructions: "Triage.",
			provider: "ollama",
			tools: [{ verb: "search", label: "Search" }],
		};
		const sheet = computeCapabilitySheet([triggerStep(), agent], APP_CAPS);
		expect(sheet.required).toContain("ai.use");
		expect(sheet.required).toContain("ai.provider:ollama");
		// The tool's dispatch cap is part of the workflow's frozen sheet — the
		// consent surface that bounds the agent's tools fail-closed at run time.
		expect(sheet.required).toContain("intents.dispatch:search");
	});
});

describe("save-time validation", () => {
	function stateWith(steps: WorkflowStep[], name = "My workflow"): BuilderState {
		return { name, steps: [triggerStep(), ...steps] };
	}

	it("passes a clean workflow", () => {
		const issues = validateBuilderWorkflow(stateWith([notify("n")]), APP_CAPS);
		expect(issues).toHaveLength(0);
	});

	it("flags an empty name", () => {
		const issues = validateBuilderWorkflow(stateWith([notify("n")], "  "), APP_CAPS);
		expect(issues.some((i) => i.kind === BuilderIssueKind.EmptyName)).toBe(true);
	});

	it("flags an empty body (trigger only)", () => {
		const issues = validateBuilderWorkflow(emptyBuilderState(), APP_CAPS);
		expect(issues.some((i) => i.kind === BuilderIssueKind.NoSteps)).toBe(true);
	});

	it("flags an unbound binding referencing an absent step id", () => {
		const branch: WorkflowStep = {
			id: "b",
			kind: StepKind.Branch,
			condition: "step-ghost.value",
			consequent: [],
		};
		const issues = validateBuilderWorkflow({ name: "x", steps: [triggerStep(), branch] }, APP_CAPS);
		const unbound = issues.find((i) => i.kind === BuilderIssueKind.UnboundBinding);
		expect(unbound?.stepId).toBe("b");
		expect(unbound?.detail).toBe("step-ghost.value");
	});

	it("flags the explicit <unbound> sentinel", () => {
		const code: WorkflowStep = { id: "c", kind: StepKind.Code, expression: UNBOUND };
		const issues = validateBuilderWorkflow({ name: "x", steps: [triggerStep(), code] }, APP_CAPS);
		expect(issues.some((i) => i.kind === BuilderIssueKind.UnboundBinding)).toBe(true);
	});

	it("does NOT flag a binding to a real prior step or the trigger input", () => {
		const real: WorkflowStep = {
			id: "b",
			kind: StepKind.Branch,
			condition: "input.count > 3",
			consequent: [],
		};
		const after: WorkflowStep = {
			id: "c",
			kind: StepKind.Code,
			expression: "b.value",
		};
		const issues = validateBuilderWorkflow(
			{ name: "x", steps: [triggerStep(), real, after] },
			APP_CAPS,
		);
		expect(issues.filter((i) => i.kind === BuilderIssueKind.UnboundBinding)).toHaveLength(0);
	});

	it("flags missing required config", () => {
		const entity: WorkflowStep = {
			id: "e",
			kind: StepKind.Entity,
			op: EntityOp.Query,
			entityType: "",
		};
		const issues = validateBuilderWorkflow({ name: "x", steps: [triggerStep(), entity] }, APP_CAPS);
		const cfg = issues.find((i) => i.kind === BuilderIssueKind.EmptyStepConfig);
		expect(cfg?.detail).toBe("entityType");
	});

	it("flags a capability that exceeds the app ceiling", () => {
		const entity: WorkflowStep = {
			id: "e",
			kind: StepKind.Entity,
			op: EntityOp.Create,
			entityType: "brainstorm/Secret/v1",
		};
		const issues = validateBuilderWorkflow({ name: "x", steps: [triggerStep(), entity] }, APP_CAPS);
		const cap = issues.find((i) => i.kind === BuilderIssueKind.CapabilityExceeded);
		expect(cap?.detail).toBe("entities.write:brainstorm/Secret/v1");
	});

	it("collects ids across containers", () => {
		const branch: WorkflowStep = {
			id: "b",
			kind: StepKind.Branch,
			condition: "input",
			consequent: [notify("inner")],
		};
		const ids = allStepIds([triggerStep(), branch]);
		expect(ids.has("trigger")).toBe(true);
		expect(ids.has("b")).toBe(true);
		expect(ids.has("inner")).toBe(true);
	});

	it("11b.7 — flags an AI step with empty instructions", () => {
		for (const kind of [StepKind.AICall, StepKind.AIAgent]) {
			const step = { ...makeStep(kind), id: "ai" } as WorkflowStep;
			const issues = validateBuilderWorkflow({ name: "x", steps: [triggerStep(), step] }, APP_CAPS);
			const cfg = issues.find((i) => i.kind === BuilderIssueKind.EmptyStepConfig && i.stepId === "ai");
			expect(cfg?.detail).toBe("instructions");
		}
	});
});

describe("round-trip with WorkflowDef", () => {
	it("freezes builder state into a WorkflowDef with the step-derived sheet", () => {
		const state: BuilderState = {
			name: "  Trim me  ",
			description: "  desc  ",
			steps: [triggerStep(), notify("n")],
		};
		const def = builderStateToWorkflow(state, "trigger-1", false);
		expect(def.name).toBe("Trim me");
		expect(def.description).toBe("desc");
		expect(def.enabled).toBe(false);
		expect(def.triggerId).toBe("trigger-1");
		expect(def.capabilities).toEqual(aggregateWorkflowCapabilities(state.steps));
	});

	it("loads a WorkflowDef back into editable state, guaranteeing the trigger", () => {
		const def: WorkflowDef = {
			name: "W",
			enabled: true,
			triggerId: "t",
			steps: [notify("n")],
			capabilities: ["notifications.post"],
		};
		const state = builderStateFromWorkflow(def);
		expect(state.steps[0]?.kind).toBe(StepKind.Trigger);
		expect(state.steps).toHaveLength(2);
	});
});
