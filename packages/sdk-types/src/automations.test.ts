import { describe, expect, it } from "vitest";
import {
	type AgentTool,
	AutomationIssueCode,
	CapabilityTier,
	type ConcurrencyPolicy,
	ENGINE_STEP_KINDS,
	ENGINE_TRIGGER_KINDS,
	EntityOp,
	REMINDER_TYPE_URL,
	STEP_KINDS,
	StepKind,
	TERMINAL_RUN_STATUSES,
	TRIGGER_TYPE_URL,
	TriggerKind,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	type WorkflowDef,
	WorkflowRunStatus,
	type WorkflowStep,
	agentToolCapabilities,
	aggregateWorkflowCapabilities,
	capabilityImplies,
	isCapabilitySubset,
	isStepKind,
	isTriggerKind,
	isValidReminder,
	isValidWorkflow,
	missingCapabilities,
	stepCapabilities,
	validateCapabilityTiers,
	validateReminder,
	validateTrigger,
	validateWorkflow,
	validateWorkflowRun,
} from "./automations";

describe("type urls + enum tables", () => {
	it("freezes the four canonical type urls", () => {
		expect(WORKFLOW_TYPE_URL).toBe("brainstorm/Workflow/v1");
		expect(TRIGGER_TYPE_URL).toBe("brainstorm/Trigger/v1");
		expect(WORKFLOW_RUN_TYPE_URL).toBe("brainstorm/WorkflowRun/v1");
		expect(REMINDER_TYPE_URL).toBe("brainstorm/Reminder/v1");
	});

	it("the engine step subset is contained in the full step vocabulary", () => {
		for (const k of ENGINE_STEP_KINDS) expect(STEP_KINDS).toContain(k);
		// the gated kinds are declared but not in the engine subset
		expect(ENGINE_STEP_KINDS).not.toContain(StepKind.AIAgent);
		expect(ENGINE_STEP_KINDS).not.toContain(StepKind.HTTP);
		expect(ENGINE_STEP_KINDS).not.toContain(StepKind.Code);
	});

	it("the engine trigger subset includes startup but excludes the network/file kinds", () => {
		expect(ENGINE_TRIGGER_KINDS).toEqual([
			TriggerKind.Time,
			TriggerKind.EntityEvent,
			TriggerKind.Manual,
			TriggerKind.Startup,
		]);
		expect(ENGINE_TRIGGER_KINDS).not.toContain(TriggerKind.Webhook);
		expect(ENGINE_TRIGGER_KINDS).not.toContain(TriggerKind.FileWatch);
	});

	it("guards reject non-members", () => {
		expect(isStepKind(StepKind.Branch)).toBe(true);
		expect(isStepKind("nope")).toBe(false);
		expect(isStepKind(undefined)).toBe(false);
		expect(isTriggerKind(TriggerKind.Time)).toBe(true);
		expect(isTriggerKind("cron")).toBe(false);
	});

	it("marks only finished statuses terminal", () => {
		expect(TERMINAL_RUN_STATUSES.has(WorkflowRunStatus.Succeeded)).toBe(true);
		expect(TERMINAL_RUN_STATUSES.has(WorkflowRunStatus.TimedOut)).toBe(true);
		expect(TERMINAL_RUN_STATUSES.has(WorkflowRunStatus.Queued)).toBe(false);
		expect(TERMINAL_RUN_STATUSES.has(WorkflowRunStatus.Running)).toBe(false);
	});
});

describe("capabilityImplies — mirrors the ledger scope rule", () => {
	it("matches exact scoped grants", () => {
		expect(capabilityImplies("entities.read:Task/v1", "entities.read:Task/v1")).toBe(true);
	});

	it("a `*` grant covers any scope of the same capability", () => {
		expect(capabilityImplies("entities.read:*", "entities.read:Task/v1")).toBe(true);
	});

	it("a different capability never matches", () => {
		expect(capabilityImplies("entities.write:*", "entities.read:Task/v1")).toBe(false);
	});

	it("a scoped grant does not cover a different scope", () => {
		expect(capabilityImplies("entities.read:Note/v1", "entities.read:Task/v1")).toBe(false);
	});

	it("unscoped requests need an unscoped grant — not a wildcard", () => {
		expect(capabilityImplies("notifications.post", "notifications.post")).toBe(true);
		expect(capabilityImplies("ai.use:*", "ai.use")).toBe(false);
		expect(capabilityImplies("ai.use", "ai.use")).toBe(true);
	});

	it("a scoped request is not satisfied by an unscoped grant", () => {
		expect(capabilityImplies("entities.read", "entities.read:Task/v1")).toBe(false);
	});
});

describe("subset + missing helpers", () => {
	const held = ["entities.read:*", "notifications.post", "ai.use"];

	it("empty request is vacuously a subset", () => {
		expect(isCapabilitySubset([], held)).toBe(true);
	});

	it("a fully-covered request is a subset", () => {
		expect(isCapabilitySubset(["entities.read:Task/v1", "ai.use"], held)).toBe(true);
		expect(missingCapabilities(["entities.read:Task/v1", "ai.use"], held)).toEqual([]);
	});

	it("an uncovered cap is reported missing and breaks the subset", () => {
		expect(isCapabilitySubset(["entities.write:Task/v1"], held)).toBe(false);
		expect(missingCapabilities(["entities.write:Task/v1", "ai.use"], held)).toEqual([
			"entities.write:Task/v1",
		]);
	});
});

describe("stepCapabilities — static footprint per kind", () => {
	it("intent → dispatch + read of its entity type", () => {
		expect(
			stepCapabilities({
				id: "s1",
				kind: StepKind.Intent,
				verb: "open",
				entityType: "Note/v1",
			}),
		).toEqual(["intents.dispatch:open", "entities.read:Note/v1"]);
	});

	it("entity read op → read; mutating op → write", () => {
		expect(
			stepCapabilities({ id: "s", kind: StepKind.Entity, op: EntityOp.Query, entityType: "Task/v1" }),
		).toEqual(["entities.read:Task/v1"]);
		expect(
			stepCapabilities({ id: "s", kind: StepKind.Entity, op: EntityOp.Update, entityType: "Task/v1" }),
		).toEqual(["entities.write:Task/v1"]);
	});

	it("notify → notifications.post", () => {
		expect(stepCapabilities({ id: "s", kind: StepKind.Notify, title: "hi" })).toEqual([
			"notifications.post",
		]);
	});

	it("http → network.egress scoped to the url origin", () => {
		expect(
			stepCapabilities({ id: "s", kind: StepKind.HTTP, method: "GET", url: "https://api.x.com/v/1" }),
		).toEqual(["network.egress:https://api.x.com"]);
		expect(
			stepCapabilities({ id: "s", kind: StepKind.HTTP, method: "GET", url: "not a url" }),
		).toEqual(["network.egress"]);
	});

	it("ai-call → ai.use (+ provider scope)", () => {
		expect(
			stepCapabilities({ id: "s", kind: StepKind.AICall, instructions: "x", provider: "anthropic" }),
		).toEqual(["ai.use", "ai.provider:anthropic"]);
	});

	it("control-flow / wait / trigger steps need no caps of their own", () => {
		expect(stepCapabilities({ id: "s", kind: StepKind.Wait, durationMs: 1000 })).toEqual([]);
		expect(stepCapabilities({ id: "s", kind: StepKind.Trigger })).toEqual([]);
	});
});

describe("aggregateWorkflowCapabilities — sorted union over nested steps", () => {
	it("walks branch + for-each children", () => {
		const steps: WorkflowStep[] = [
			{ id: "1", kind: StepKind.Trigger },
			{
				id: "2",
				kind: StepKind.Branch,
				condition: "x",
				consequent: [{ id: "2a", kind: StepKind.Notify, title: "n" }],
				alternate: [
					{
						id: "2b",
						kind: StepKind.ForEach,
						collection: "items",
						body: [{ id: "2b1", kind: StepKind.Entity, op: EntityOp.Create, entityType: "Task/v1" }],
					},
				],
			},
		];
		expect(aggregateWorkflowCapabilities(steps)).toEqual([
			"entities.write:Task/v1",
			"notifications.post",
		]);
	});

	it("dedups repeated caps", () => {
		const steps: WorkflowStep[] = [
			{ id: "1", kind: StepKind.Notify, title: "a" },
			{ id: "2", kind: StepKind.Notify, title: "b" },
		];
		expect(aggregateWorkflowCapabilities(steps)).toEqual(["notifications.post"]);
	});
});

describe("agentToolCapabilities", () => {
	it("a tool is an intent dispatch + its entity read", () => {
		const tool: AgentTool = { verb: "process", entityType: "Email/v1", label: "Classify" };
		expect(agentToolCapabilities(tool)).toEqual([
			"intents.dispatch:process",
			"entities.read:Email/v1",
		]);
	});
});

describe("validateCapabilityTiers — three-tier fail-closed intersection", () => {
	it("passes when agent ⊆ workflow ⊆ app", () => {
		const result = validateCapabilityTiers({
			appCapabilities: ["entities.read:*", "ai.use", "intents.dispatch:process"],
			workflowCapabilities: ["entities.read:Email/v1", "ai.use", "intents.dispatch:process"],
			agentToolCapabilities: ["intents.dispatch:process", "entities.read:Email/v1"],
		});
		expect(result.ok).toBe(true);
		expect(result.violations).toEqual([]);
	});

	it("flags a workflow cap the app does not hold", () => {
		const result = validateCapabilityTiers({
			appCapabilities: ["entities.read:Note/v1"],
			workflowCapabilities: ["entities.read:Task/v1"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ tier: CapabilityTier.WorkflowVsApp, capability: "entities.read:Task/v1" },
		]);
	});

	it("flags an agent tool the workflow does not list", () => {
		const result = validateCapabilityTiers({
			appCapabilities: ["intents.dispatch:open", "intents.dispatch:delete"],
			workflowCapabilities: ["intents.dispatch:open"],
			agentToolCapabilities: ["intents.dispatch:delete"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toEqual([
			{ tier: CapabilityTier.AgentVsWorkflow, capability: "intents.dispatch:delete" },
		]);
	});

	it("an agent cap present in the app but absent from the workflow still fails (fail-closed at the inner tier)", () => {
		// The whole point: the app being broad does NOT let an agent escape
		// the workflow's narrower frozen set.
		const result = validateCapabilityTiers({
			appCapabilities: ["entities.read:*"],
			workflowCapabilities: ["entities.read:Task/v1"],
			agentToolCapabilities: ["entities.read:Secret/v1"],
		});
		expect(result.ok).toBe(false);
		expect(result.violations).toContainEqual({
			tier: CapabilityTier.AgentVsWorkflow,
			capability: "entities.read:Secret/v1",
		});
	});

	it("empty tiers are vacuously contained", () => {
		expect(validateCapabilityTiers({ appCapabilities: [], workflowCapabilities: [] }).ok).toBe(true);
	});
});

describe("structural validators", () => {
	const goodWorkflow: WorkflowDef = {
		name: "Daily digest",
		enabled: true,
		triggerId: "ent_trigger",
		steps: [{ id: "1", kind: StepKind.Notify, title: "hi" }],
		capabilities: ["notifications.post"],
	};

	it("accepts a well-formed workflow", () => {
		expect(validateWorkflow(goodWorkflow)).toEqual([]);
		expect(isValidWorkflow(goodWorkflow)).toBe(true);
	});

	it("flags blank name, missing trigger, empty steps", () => {
		const codes = validateWorkflow({
			...goodWorkflow,
			name: "  ",
			triggerId: "",
			steps: [],
		}).map((i) => i.code);
		expect(codes).toContain(AutomationIssueCode.EmptyName);
		expect(codes).toContain(AutomationIssueCode.MissingTriggerRef);
		expect(codes).toContain(AutomationIssueCode.EmptySteps);
	});

	it("flags an unknown step kind", () => {
		const issues = validateWorkflow({
			...goodWorkflow,
			steps: [{ id: "1", kind: "bogus" as StepKind, title: "x" } as unknown as WorkflowStep],
		});
		expect(issues.map((i) => i.code)).toContain(AutomationIssueCode.InvalidStepKind);
	});

	it("flags an invalid concurrency policy", () => {
		const issues = validateWorkflow({
			...goodWorkflow,
			concurrency: "burst" as ConcurrencyPolicy,
		});
		expect(issues.map((i) => i.code)).toContain(AutomationIssueCode.InvalidConcurrency);
	});

	it("validates triggers structurally", () => {
		expect(
			validateTrigger({ kind: TriggerKind.Time, config: { recurrence: "FREQ=DAILY" }, enabled: true }),
		).toEqual([]);
		const bad = validateTrigger({
			kind: "cron" as TriggerKind,
			config: null as unknown as Record<string, unknown>,
			enabled: true,
		}).map((i) => i.code);
		expect(bad).toContain(AutomationIssueCode.InvalidTriggerKind);
		expect(bad).toContain(AutomationIssueCode.MissingTriggerConfig);
	});

	it("validates runs structurally", () => {
		expect(
			validateWorkflowRun({
				workflow: "ent_wf",
				triggeredAt: "2026-06-06T09:00:00Z",
				triggeredBy: "ent_trigger",
				status: WorkflowRunStatus.Running,
			}),
		).toEqual([]);
		const bad = validateWorkflowRun({
			workflow: "",
			triggeredAt: "x",
			triggeredBy: "y",
			status: "weird" as WorkflowRunStatus,
		}).map((i) => i.code);
		expect(bad).toContain(AutomationIssueCode.MissingWorkflowRef);
		expect(bad).toContain(AutomationIssueCode.InvalidRunStatus);
	});

	it("validates reminders structurally", () => {
		expect(isValidReminder({ subject: "Call Priya", dueAt: "2026-06-08T09:00:00Z" })).toBe(true);
		const bad = validateReminder({ subject: "  ", dueAt: "" }).map((i) => i.code);
		expect(bad).toContain(AutomationIssueCode.EmptySubject);
		expect(bad).toContain(AutomationIssueCode.MissingDueAt);
	});
});
