import { describe, expect, it } from "vitest";
import type { AgentLoopStep } from "./agent-loop";
import { ToolRefusalReason } from "./agent-loop";
import {
	AGENT_TRACE_CAPABILITY_MAX,
	AGENT_TRACE_DETAIL_MAX,
	AGENT_TRACE_TOOL_MAX,
	AgentEventKind,
	AgentEventOutcome,
	type AgentTraceEventDraft,
	WORKFLOW_RUN_DENIED_ERROR_PREFIX,
	type WorkflowTraceStep,
	WorkflowTraceStepStatus,
	collectWorkflowAgentTools,
	deniedTraceCapabilities,
	firstMissingToolCapability,
	loopStepEvents,
	sanitizeTraceText,
	workflowRunDeniedCapabilities,
	workflowStepEvents,
} from "./agent-trace";
import type { AgentTool, WorkflowStep } from "./automations";
import { StepKind } from "./automations";

const TOOL: AgentTool = { verb: "open", label: "Open an object", entityType: "brainstorm/Note/v1" };

describe("sanitizeTraceText", () => {
	it("bounds, strips controls/bidi/zero-width, collapses whitespace", () => {
		expect(sanitizeTraceText("a\u0000b\u0007c\r\nd", 100)).toBe("a b c d");
		expect(sanitizeTraceText("x\u202egnp.exe", 100)).toBe("x gnp.exe");
		expect(sanitizeTraceText("zero\u200bwidth\ufeff!", 100)).toBe("zero width !");
		expect(sanitizeTraceText("a".repeat(500), 16)).toHaveLength(16);
		expect(sanitizeTraceText(42 as unknown as string, 100)).toBe("");
		expect(sanitizeTraceText("  padded  ", 100)).toBe("padded");
	});
});

describe("loopStepEvents (the record codec)", () => {
	const context = { tools: [TOOL], frozenCapabilities: ["intents.dispatch:open"] };

	it("maps result/error/refused and drops assistant + tool-call args", () => {
		const steps: AgentLoopStep[] = [
			{ kind: "assistant", content: '{"tool":"open","args":{"secret":"hunter2"}}' },
			{ kind: "tool-call", call: { tool: "open", args: { secret: "hunter2" } } },
			{ kind: "tool-result", tool: "open", output: { leaked: "prompt bytes" } },
			{ kind: "tool-error", tool: "open", error: "boom" },
			{ kind: "tool-refused", tool: "open", reason: ToolRefusalReason.CapabilityDenied },
			{ kind: "tool-refused", tool: "made-up", reason: ToolRefusalReason.UnknownTool },
		];
		const events = loopStepEvents(steps, {
			...context,
			// `open` needs entities.read too — the frozen set above misses it.
			dispatchDurationsMs: [12, 34],
		});
		expect(events.map((e) => [e.kind, e.outcome])).toEqual([
			[AgentEventKind.ToolCall, AgentEventOutcome.Ok],
			[AgentEventKind.ToolCall, AgentEventOutcome.Error],
			[AgentEventKind.ToolDenied, AgentEventOutcome.Denied],
			[AgentEventKind.ToolDenied, AgentEventOutcome.Denied],
		]);
		expect(events[0]?.durationMs).toBe(12);
		expect(events[1]?.durationMs).toBe(34);
		expect(events[1]?.detail).toBe("boom");
		// The capability-denied refusal NAMES the missing cap (the read the
		// frozen set does not imply); the unknown tool names none.
		expect(events[2]?.capability).toBe("entities.read:brainstorm/Note/v1");
		expect(events[3]?.capability).toBeNull();
	});

	it("firstMissingToolCapability resolves from the DECLARED tool, never the model", () => {
		expect(firstMissingToolCapability("open", { tools: [TOOL], frozenCapabilities: [] })).toBe(
			"intents.dispatch:open",
		);
		expect(
			firstMissingToolCapability("open", {
				tools: [TOOL],
				frozenCapabilities: ["intents.dispatch:open", "entities.read:brainstorm/Note/v1"],
			}),
		).toBeNull();
		expect(firstMissingToolCapability("nope", { tools: [TOOL], frozenCapabilities: [] })).toBeNull();
	});

	// ── The doc-77 metadata-only PROPERTY TEST ────────────────────────────────
	// Random hostile transcripts (secrets in args, prompt bytes in content,
	// output blobs, control/bidi characters in every string) go through the
	// codec; NO event field may carry an argument value, an assistant byte,
	// or a tool output — and every stored string is bounded + control-free.

	const CONTROL_CHARS = ["\u0000", "\u0007", "\u001b", "\r", "\n", "\u200b", "\u202e", "\u2066"];

	// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the strip
	const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

	function randomInt(max: number): number {
		return Math.floor(Math.random() * max);
	}

	function hostileString(marker: string): string {
		let s = marker;
		const pad = randomInt(4);
		for (let i = 0; i < pad; i++) {
			s += CONTROL_CHARS[randomInt(CONTROL_CHARS.length)] ?? "";
			s += Math.random().toString(36).slice(2);
		}
		if (Math.random() < 0.3) s += "<img onerror=alert(1)>";
		if (Math.random() < 0.2) s = s.repeat(1 + randomInt(50));
		return s;
	}

	function randomStep(i: number): { step: AgentLoopStep; forbidden: string[] } {
		const secret = `SECRET_ARG_${i}_${Math.random().toString(36).slice(2)}`;
		const prompt = `PROMPT_BYTES_${i}_${Math.random().toString(36).slice(2)}`;
		const output = `TOOL_OUTPUT_${i}_${Math.random().toString(36).slice(2)}`;
		const tool = hostileString(`tool_${i}`);
		switch (randomInt(5)) {
			case 0:
				return { step: { kind: "assistant", content: hostileString(prompt) }, forbidden: [prompt] };
			case 1:
				return {
					step: {
						kind: "tool-call",
						call: { tool, args: { a: hostileString(secret), nested: { b: [secret] } } },
					},
					forbidden: [secret],
				};
			case 2:
				return {
					step: { kind: "tool-result", tool, output: { deep: { value: hostileString(output) } } },
					forbidden: [output],
				};
			case 3:
				return {
					step: { kind: "tool-error", tool, error: hostileString(`err_${i}`) },
					forbidden: [],
				};
			default:
				return {
					step: {
						kind: "tool-refused",
						tool,
						reason:
							Math.random() < 0.5 ? ToolRefusalReason.UnknownTool : ToolRefusalReason.CapabilityDenied,
					},
					forbidden: [],
				};
		}
	}

	function assertMetadataOnly(events: readonly AgentTraceEventDraft[], forbidden: string[]): void {
		for (const event of events) {
			const stored = [
				event.tool,
				event.capability ?? "",
				event.detail ?? "",
				event.targetEntityId ?? "",
			];
			for (const field of stored) {
				// Bounded.
				expect(field.length).toBeLessThanOrEqual(
					Math.max(AGENT_TRACE_TOOL_MAX, AGENT_TRACE_CAPABILITY_MAX, AGENT_TRACE_DETAIL_MAX),
				);
				// Control-stripped (incl. bidi/zero-width).
				expect(field).not.toMatch(CONTROLS);
				// No prompt/arg/output bytes.
				for (const secret of forbidden) {
					expect(field.includes(secret)).toBe(false);
				}
			}
			// Enum discipline — kind/outcome only ever hold contract values.
			expect(Object.values(AgentEventKind)).toContain(event.kind);
			expect(Object.values(AgentEventOutcome)).toContain(event.outcome);
			expect(Number.isFinite(event.durationMs)).toBe(true);
			expect(event.durationMs).toBeGreaterThanOrEqual(0);
		}
	}

	it("PROPERTY: 200 random hostile transcripts never leak prompt/arg/output bytes", () => {
		for (let round = 0; round < 200; round++) {
			const steps: AgentLoopStep[] = [];
			const forbidden: string[] = [];
			const count = 1 + randomInt(8);
			for (let i = 0; i < count; i++) {
				const { step, forbidden: f } = randomStep(i);
				steps.push(step);
				forbidden.push(...f);
			}
			const events = loopStepEvents(steps, {
				tools: [TOOL],
				frozenCapabilities: Math.random() < 0.5 ? [] : ["intents.dispatch:open"],
			});
			assertMetadataOnly(events, forbidden);
		}
	});

	it("PROPERTY: 100 random workflow step logs never leak step output/input bytes", () => {
		for (let round = 0; round < 100; round++) {
			const forbidden: string[] = [];
			const stepLog: WorkflowTraceStep[] = [];
			const count = 1 + randomInt(6);
			for (let i = 0; i < count; i++) {
				const payload = `STEP_PAYLOAD_${i}_${Math.random().toString(36).slice(2)}`;
				forbidden.push(payload);
				const failed = Math.random() < 0.4;
				stepLog.push({
					stepId: `s${i}`,
					kind: [StepKind.Intent, StepKind.Entity, StepKind.HTTP, StepKind.AIAgent][
						randomInt(4)
					] as string,
					status: failed ? WorkflowTraceStepStatus.Failed : WorkflowTraceStepStatus.Succeeded,
					durationMs: randomInt(5_000),
					...(failed ? { error: hostileString(`werr_${i}`) } : {}),
					output: {
						content: hostileString(payload),
						steps: [
							{ kind: "assistant", content: hostileString(payload) },
							{ kind: "tool-result", tool: hostileString(`t${i}`), output: payload },
						],
					},
				});
			}
			const events = workflowStepEvents(stepLog, {
				tools: [TOOL],
				frozenCapabilities: ["intents.dispatch:open"],
			});
			assertMetadataOnly(events, forbidden);
		}
	});
});

describe("workflowStepEvents", () => {
	it("maps step → tool → outcome → duration, skips trigger/skipped, expands AIAgent", () => {
		const stepLog: WorkflowTraceStep[] = [
			{
				stepId: "t",
				kind: StepKind.Trigger,
				status: WorkflowTraceStepStatus.Succeeded,
				durationMs: 0,
			},
			{
				stepId: "s1",
				kind: StepKind.Intent,
				status: WorkflowTraceStepStatus.Succeeded,
				durationMs: 40,
			},
			{
				stepId: "s2",
				kind: StepKind.AIAgent,
				status: WorkflowTraceStepStatus.Succeeded,
				durationMs: 900,
				output: {
					steps: [
						{ kind: "tool-result", tool: "open", output: { ignored: true } },
						{ kind: "tool-refused", tool: "open", reason: ToolRefusalReason.CapabilityDenied },
					],
				},
			},
			{
				stepId: "s3",
				kind: StepKind.HTTP,
				status: WorkflowTraceStepStatus.Failed,
				durationMs: 10,
				error: "http-status-500",
			},
			{ stepId: "s4", kind: StepKind.Notify, status: "skipped", durationMs: 0 },
		];
		const events = workflowStepEvents(stepLog, { tools: [TOOL], frozenCapabilities: [] });
		expect(events.map((e) => [e.kind, e.tool, e.outcome])).toEqual([
			[AgentEventKind.ToolCall, "intent:s1", AgentEventOutcome.Ok],
			[AgentEventKind.ToolCall, "ai-agent:s2", AgentEventOutcome.Ok],
			[AgentEventKind.ToolCall, "open", AgentEventOutcome.Ok],
			[AgentEventKind.ToolDenied, "open", AgentEventOutcome.Denied],
			[AgentEventKind.ToolCall, "http:s3", AgentEventOutcome.Error],
		]);
		expect(events[4]?.detail).toBe("http-status-500");
		// The inner refusal names the first missing cap of the DECLARED tool.
		expect(events[3]?.capability).toBe("intents.dispatch:open");
	});
});

describe("collectWorkflowAgentTools", () => {
	it("walks Branch/ForEach bodies", () => {
		const inner: AgentTool = { verb: "propose.note", label: "Draft" };
		const steps = [
			{ id: "a", kind: StepKind.AIAgent, instructions: "", tools: [TOOL] },
			{
				id: "b",
				kind: StepKind.Branch,
				predicate: {},
				consequent: [{ id: "c", kind: StepKind.AIAgent, instructions: "", tools: [inner] }],
				alternate: [{ id: "d", kind: StepKind.ForEach, body: [] }],
			},
		] as unknown as WorkflowStep[];
		expect(collectWorkflowAgentTools(steps).map((t) => t.verb)).toEqual(["open", "propose.note"]);
	});
});

describe("workflowRunDeniedCapabilities (12c — the denied-run error contract)", () => {
	it("parses the prefix into named capabilities, deduped + sanitized", () => {
		expect(
			workflowRunDeniedCapabilities(
				`${WORKFLOW_RUN_DENIED_ERROR_PREFIX}entities.write:io.example/Note/v1,ai.use,ai.use`,
			),
		).toEqual(["entities.write:io.example/Note/v1", "ai.use"]);
	});

	it("returns null for anything that is not a capability refusal", () => {
		expect(workflowRunDeniedCapabilities("boom")).toBeNull();
		expect(workflowRunDeniedCapabilities(undefined)).toBeNull();
		expect(workflowRunDeniedCapabilities(42)).toBeNull();
	});

	it("strips controls and bounds each name (vault data is untrusted on read)", () => {
		const parsed = workflowRunDeniedCapabilities(
			`${WORKFLOW_RUN_DENIED_ERROR_PREFIX}a‮b,${"x".repeat(600)}`,
		);
		expect(parsed?.[0]).toBe("a b");
		expect((parsed?.[1] ?? "").length).toBeLessThanOrEqual(AGENT_TRACE_CAPABILITY_MAX);
	});
});

describe("deniedTraceCapabilities (the ONE denial shaping both surfaces use)", () => {
	it("collects unique tool-denied capabilities in first-seen order", () => {
		const events = [
			{ kind: AgentEventKind.ToolCall, capability: "entities.read:*" },
			{ kind: AgentEventKind.ToolDenied, capability: "intents.dispatch:open" },
			{ kind: AgentEventKind.ToolDenied, capability: null },
			{ kind: AgentEventKind.ToolDenied, capability: "ai.use" },
			{ kind: AgentEventKind.ToolDenied, capability: "intents.dispatch:open" },
		];
		expect(deniedTraceCapabilities(events)).toEqual(["intents.dispatch:open", "ai.use"]);
	});
});
