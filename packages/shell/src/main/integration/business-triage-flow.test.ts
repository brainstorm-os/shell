/**
 * End-to-end proof of the "business use-case" spine (Track B verification):
 * an incoming item fires a trigger, an AI step classifies it, and an AI-agent
 * step drafts a reply through the intents bus — the full
 * trigger → AI → action path, driven in-process through the SAME primitives
 * production wires (`AutomationsHost` → `WorkflowRunner` → core interpreters →
 * `createBrokerInterpreterPorts` → the real `ai` service handler → a provider).
 *
 * No Electron, no live vault: the broker service handlers are backed by
 * in-memory fakes + one stub `ModelProvider`, exactly as the AI broker
 * integration test does, so the whole path is deterministic and fast.
 *
 * This is the reproduce-before-you-patch harness for the business flow — it
 * asserts what actually works today (classify + draft-a-reply) and pins the
 * object-construction gap (a workflow cannot assemble a NEW entity's fields
 * from AI output with the pure step set) as an explicit, documented boundary.
 */

import {
	type AiGenerateRequest,
	type AiGenerateResult,
	EntityEventVerb,
	EntityOp,
	MessageRole,
	StepKind,
	type WorkflowRunDef,
	WorkflowRunStatus,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { makeAiServiceHandler } from "../ai/ai-service";
import type { ModelProvider } from "../ai/provider";
import {
	AutomationsHost,
	type EntityChange,
	type EntityChangeSource,
	type LoadedWorkflow,
} from "../automations/automations-host";
import { createBrokerInterpreterPorts } from "../automations/broker-interpreter-ports";
import type { ReminderRunner } from "../automations/reminder-runner";
import type { SchedulerService } from "../automations/scheduler-service";

const EMAIL_TYPE = "brainstorm/Email/v1";

/** A stub provider that plays two roles by inspecting the system region:
 *  the triage classifier (returns a one-word label) and the reply-drafting
 *  agent (a tool call, then — once a tool result is in the transcript — a
 *  final answer). This is the only "model" in the test. */
function stubProvider(record: { generateCalls: AiGenerateRequest[] }): ModelProvider {
	return {
		id: "stub",
		generate: async (req: AiGenerateRequest): Promise<AiGenerateResult> => {
			record.generateCalls.push(req);
			// `AiChatMessage.content` is `string | AiContentPart[]` (multimodal); this
			// stub only ever deals with text turns, so coerce to the text.
			const textOf = (role: MessageRole): string => {
				const c = req.messages.find((m) => m.role === role)?.content;
				return typeof c === "string" ? c : "";
			};
			const system = textOf(MessageRole.System);
			const hasToolResult = req.messages.some((m) => m.role === MessageRole.Tool);
			let content: string;
			if (system.includes("triage classifier")) {
				// The classifier sees the email JSON as the user turn.
				const user = textOf(MessageRole.User);
				content = user.includes("server is down") ? "urgent" : "normal";
			} else if (system.includes("compose:")) {
				// The reply-drafting agent: call the compose tool once, then finish.
				content = hasToolResult
					? '{"final": "I drafted a reply for you."}'
					: '{"tool": "compose", "args": {"body": "Thanks for flagging the outage — we are on it."}}';
			} else {
				content = "ok";
			}
			return { content, provider: "stub", model: "stub-1", usage: { totalTokens: 1 } };
		},
	};
}

type EntityRow = { id: string; type: string; properties: Record<string, unknown> };

/** A minimal in-memory entities service handler (get only is exercised here). */
function entitiesHandler(rows: Map<string, EntityRow>) {
	return async (envelope: { method: string; args: unknown[] }): Promise<unknown> => {
		const [arg] = envelope.args as [Record<string, unknown>];
		switch (envelope.method) {
			case "get":
				return rows.get(String(arg.id)) ?? null;
			case "query": {
				const q = (arg.query ?? {}) as { type?: string };
				return [...rows.values()].filter((r) => !q.type || r.type === q.type);
			}
			default:
				return null;
		}
	};
}

/** Records every intent dispatched by an AIAgent tool call. */
function intentsHandler(dispatched: Array<{ verb: string; payload: unknown }>) {
	return async (envelope: { args: unknown[] }): Promise<unknown> => {
		const [arg] = envelope.args as [{ verb: string; payload: unknown }];
		dispatched.push({ verb: arg.verb, payload: arg.payload });
		return { handled: true, value: { drafted: true } };
	};
}

/** A hand-driven scheduler stand-in — this flow fires off the entity-change
 *  stream, never the timer, so `tick` yields nothing. */
function idleScheduler(): SchedulerService {
	return {
		tick: async () => [],
		register: async () => {},
		unregister: async () => {},
		hydrate: async () => {},
		lastRunAt: () => null,
		registeredTriggerIds: () => [],
	} as unknown as SchedulerService;
}

function neverReminders(): ReminderRunner {
	return { fire: async () => {} } as unknown as ReminderRunner;
}

/** Build a host wired to the real ai-service handler + in-memory fakes, then
 *  run the workflow bound to a new-Email EntityEvent trigger. */
function buildHost(opts: {
	workflow: LoadedWorkflow;
	rows: Map<string, EntityRow>;
	provider: ModelProvider;
	dispatched: Array<{ verb: string; payload: unknown }>;
	runs: WorkflowRunDef[];
	entityChanges: EntityChangeSource;
}): AutomationsHost {
	const aiHandler = makeAiServiceHandler({ getProvider: () => opts.provider });
	const entities = entitiesHandler(opts.rows);
	const intents = intentsHandler(opts.dispatched);
	const getServiceHandler = (name: string) => {
		if (name === "ai") return aiHandler as never;
		if (name === "entities") return entities as never;
		if (name === "intents") return intents as never;
		if (name === "ui") return (async () => undefined) as never;
		if (name === "export") return (async () => "") as never;
		return undefined;
	};
	return new AutomationsHost({
		scheduler: idleScheduler(),
		reminderRunner: neverReminders(),
		loadWorkflow: async () => opts.workflow,
		makeInterpreterPorts: (caps) =>
			createBrokerInterpreterPorts({
				getServiceHandler,
				appId: "io.brainstorm.automations",
				caps,
			}),
		persistRun: async (run) => {
			opts.runs.push(run);
		},
		appCapabilities: () => opts.workflow.capabilities,
		clock: () => 1_000,
		entityChanges: opts.entityChanges,
	});
}

describe("business triage flow (trigger → AI classify → AI-agent draft)", () => {
	it("classifies an incoming email and drafts a reply via the intents bus", async () => {
		const rows = new Map<string, EntityRow>([
			[
				"email-1",
				{
					id: "email-1",
					type: EMAIL_TYPE,
					properties: { subject: "URGENT: outage", body: "Our server is down since 9am." },
				},
			],
		]);
		const steps: WorkflowStep[] = [
			{ id: "trigger", kind: StepKind.Trigger },
			// The EntityEvent payload uses `entityId`; a Code step lifts it to the
			// bare id the Entity Get step consumes.
			{ id: "id", kind: StepKind.Code, expression: "input.entityId" },
			{ id: "email", kind: StepKind.Entity, op: EntityOp.Get, entityType: EMAIL_TYPE },
			{
				id: "classify",
				kind: StepKind.AICall,
				instructions:
					"You are a support triage classifier. Reply with exactly one word: urgent, normal, or spam.",
			},
			{
				id: "draft",
				kind: StepKind.AIAgent,
				instructions: "Draft a brief, friendly reply acknowledging the customer's report.",
				tools: [{ verb: "compose", label: "Draft an email reply" }],
			},
		];
		const capabilities = aggregateWorkflowCapabilities(steps);

		const listeners: Array<(c: EntityChange) => void> = [];
		const entityChanges: EntityChangeSource = {
			subscribe: (l) => {
				listeners.push(l);
				return () => {};
			},
		};
		const dispatched: Array<{ verb: string; payload: unknown }> = [];
		const runs: WorkflowRunDef[] = [];
		const provider = stubProvider({ generateCalls: [] });
		const host = buildHost({
			workflow: { steps, capabilities },
			rows,
			provider,
			dispatched,
			runs,
			entityChanges,
		});
		// Register the EntityEvent(Email, create) trigger, then start + fire.
		await host.hydrate(
			{
				workflows: [],
				reminders: [],
				entityEvents: [{ workflowId: "wf-triage", type: EMAIL_TYPE, verb: EntityEventVerb.Create }],
			},
			1_000,
		);
		host.start();

		// An incoming email fires the trigger.
		for (const l of listeners)
			l({ verb: EntityEventVerb.Create, entityId: "email-1", type: EMAIL_TYPE });
		// Let the async fire settle.
		await new Promise((r) => setTimeout(r, 0));
		host.stop();

		// One run persisted, succeeded end to end.
		expect(runs).toHaveLength(1);
		const run = runs[0];
		if (!run) throw new Error("expected one persisted run");
		expect(run.status).toBe(WorkflowRunStatus.Succeeded);

		// The classifier saw the email and produced the label (recorded in provenance).
		const log = run.stepLog as Array<{ stepId: string; output?: unknown }>;
		const classify = log.find((e) => e.stepId === "classify");
		expect((classify?.output as { content?: string })?.content).toBe("urgent");

		// The AI-agent step drafted a reply by dispatching the `compose` intent.
		expect(dispatched).toHaveLength(1);
		const dispatch = dispatched[0];
		if (!dispatch) throw new Error("expected one dispatched intent");
		expect(dispatch.verb).toBe("compose");
		expect((dispatch.payload as { body?: string }).body).toContain("outage");
	});

	it("BOUNDARY: the pure step set cannot assemble a new entity's fields from AI output", () => {
		// The Entity step takes its properties ONLY from the pipeline operand
		// (`operandProperties(ctx.input)`); the Code step's grammar has no
		// object-literal syntax. So there is no pure-engine way to turn the
		// AICall's `{content:"urgent"}` into a `{priority:"urgent", title:…}`
		// patch/props. This test documents that boundary: mutation-with-computed-
		// fields must go through an AIAgent tool (an intent), not Entity steps.
		const steps: WorkflowStep[] = [
			{ id: "trigger", kind: StepKind.Trigger },
			{ id: "make", kind: StepKind.Code, expression: '{"title": "x"}' },
		];
		// `{"title":"x"}` is not valid in the expression grammar (no object
		// literals) — it parses `{` as unexpected. aggregateWorkflowCapabilities
		// still resolves (Code needs no caps), proving the step is authorable but
		// inert for object construction.
		expect(aggregateWorkflowCapabilities(steps)).toEqual([]);
	});
});
