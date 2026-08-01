/**
 * Agent-trace contract leaf (Agent-12a — doc 77 `platform/77-agent-observability.md`).
 *
 * The shared shape of the per-run trace substrate: one `agent_runs` row per
 * chat turn / automation run, ordered `agent_events` within it. The tables
 * live shell-side (`main/agents/trace/`); this leaf owns what BOTH sides of
 * the IPC boundary must agree on — the enums, the bounded wire projections,
 * and the **metadata-only codec** that maps loop/step activity into event
 * drafts.
 *
 * SECURITY KEYSTONE — metadata only, by construction. A trace row records
 * *what happened* (tool name, target entity id, capability checked, outcome,
 * timing) and NEVER prompt bytes, completion bytes, or raw tool-call argument
 * values (the MCP audit's "arg-shape only" rule, generalized to every tool).
 * The codec here is the enforcement point: {@link loopStepEvents} /
 * {@link workflowStepEvents} structurally CANNOT copy `assistant` content,
 * tool-call `args`, or tool `output` into a draft — every carried string is
 * an explicitly whitelisted field, and each passes {@link sanitizeTraceText}
 * (length-bounded + control/bidi-stripped) because tool names and error
 * strings can originate in model output or an untrusted MCP server. Pinned by
 * the property test in `agent-trace.test.ts`, not by review hope.
 */

import { type AgentLoopStep, ToolRefusalReason } from "./agent-loop";
import {
	type AgentTool,
	StepKind,
	type WorkflowStep,
	agentToolCapabilities,
	capabilityImplies,
} from "./automations";
import { enumGuard } from "./enum-guard";

/** The broker service name for the app-facing demarcation + own-runs reads. */
export const AGENT_TRACE_SERVICE = "agent-trace";

/** Which front-end produced a run (doc 77 §One substrate, both front-ends). */
export enum AgentRunSurface {
	Chat = "chat",
	Automation = "automation",
}

/** Why a run ended. `Refused` = the run never got to act (capability posture
 *  refused it outright); `Budget` = the AI budget gate stopped it. */
export enum AgentRunOutcome {
	Ok = "ok",
	Error = "error",
	Refused = "refused",
	Budget = "budget",
	Aborted = "aborted",
}

/** Event kinds within a run. NO `model-call` — model calls live in `ai_usage`
 *  (joined via its `run_id` column), one accounting substrate (OQ-AO-5). */
export enum AgentEventKind {
	Retrieval = "retrieval",
	ToolCall = "tool-call",
	ToolDenied = "tool-denied",
	ProposalStaged = "proposal-staged",
	ProposalApproved = "proposal-approved",
	ProposalDiscarded = "proposal-discarded",
	McpCall = "mcp-call",
	Error = "error",
}

/** Per-event outcome. Free error text never rides here — it goes to the
 *  bounded `detail` field so the discriminator stays an enum. */
export enum AgentEventOutcome {
	Ok = "ok",
	Error = "error",
	Denied = "denied",
}

export const isAgentRunSurface = enumGuard(Object.values(AgentRunSurface));
export const isAgentRunOutcome = enumGuard(Object.values(AgentRunOutcome));
export const isAgentEventKind = enumGuard(Object.values(AgentEventKind));
export const isAgentEventOutcome = enumGuard(Object.values(AgentEventOutcome));

/** Field ceilings. Sized for legibility, not archival — the trace is an
 *  operational record. Every stored string obeys one of these. */
export const AGENT_TRACE_TOOL_MAX = 128;
export const AGENT_TRACE_CAPABILITY_MAX = 256;
export const AGENT_TRACE_ID_MAX = 128;
export const AGENT_TRACE_DETAIL_MAX = 256;

/**
 * Injection-inertness (doc 77 §Security posture): bound + control-strip any
 * string destined for a trace row. Tool names can come from the model (an
 * unknown-tool refusal records the name the model asked for) and from
 * untrusted MCP servers; error strings come from providers and tool runtimes.
 * Strips C0/C1 controls, zero-width and bidi-override codepoints (UI-spoofing
 * primitives), collapses whitespace runs, and truncates to `max`.
 */
export function sanitizeTraceText(value: unknown, max: number): string {
	if (typeof value !== "string" || max <= 0) return "";
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
			.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, max)
	);
}

/** A trace event as the codec emits it — the recorder assigns `seq`/`ts`. */
export type AgentTraceEventDraft = {
	kind: AgentEventKind;
	tool: string;
	targetEntityId: string | null;
	/** The capability checked; for `tool-denied`, the cap that was MISSING —
	 *  the row that makes a denial actionable (doc 77 §Motivation). */
	capability: string | null;
	outcome: AgentEventOutcome;
	/** Bounded, sanitized failure detail (never a prompt/arg/output byte). */
	detail: string | null;
	durationMs: number;
};

/** One run, projected for a surface. Never a raw DB row — this is the ONLY
 *  run shape that crosses IPC (doc 77: bounded, paginated projections). */
export type AgentRunSummary = {
	id: string;
	surface: AgentRunSurface;
	conversationId: string | null;
	workflowRunId: string | null;
	agent: string;
	startedAt: number;
	endedAt: number | null;
	outcome: AgentRunOutcome | null;
	denialCount: number;
};

/** One event, projected for a surface (the IPC shape). */
export type AgentTraceEventRecord = AgentTraceEventDraft & {
	runId: string;
	seq: number;
	ts: number;
};

function draft(
	kind: AgentEventKind,
	outcome: AgentEventOutcome,
	fields: {
		tool?: string;
		capability?: string | null;
		detail?: string | null;
		durationMs?: number | undefined;
	},
): AgentTraceEventDraft {
	return {
		kind,
		tool: sanitizeTraceText(fields.tool ?? "", AGENT_TRACE_TOOL_MAX),
		targetEntityId: null,
		capability:
			fields.capability == null
				? null
				: sanitizeTraceText(fields.capability, AGENT_TRACE_CAPABILITY_MAX) || null,
		outcome,
		detail:
			fields.detail == null ? null : sanitizeTraceText(fields.detail, AGENT_TRACE_DETAIL_MAX) || null,
		durationMs: boundedDuration(fields.durationMs),
	};
}

function boundedDuration(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.min(Math.floor(value), 86_400_000);
}

/** The offered-tool context a codec caller passes so a capability-denied
 *  refusal can NAME the missing cap (computed from the declared tool's own
 *  footprint against the frozen set — never from model output). */
export type LoopTraceContext = {
	tools: readonly AgentTool[];
	frozenCapabilities: readonly string[];
	/** Per-dispatch durations keyed by 0-based dispatched-tool index, as an
	 *  instrumented `dispatchTool` measured them. Optional (0 when absent). */
	dispatchDurationsMs?: readonly number[];
};

/** The first capability a declared tool needs that the frozen set does not
 *  imply — the actionable content of a `tool-denied` row. Null when the tool
 *  is unknown (the model invented the name) or fully covered. */
export function firstMissingToolCapability(
	toolName: string,
	context: Pick<LoopTraceContext, "tools" | "frozenCapabilities">,
): string | null {
	const tool = context.tools.find((t) => t.verb === toolName);
	if (!tool) return null;
	return (
		agentToolCapabilities(tool).find(
			(req) => !context.frozenCapabilities.some((held) => capabilityImplies(held, req)),
		) ?? null
	);
}

/**
 * THE record codec for a shell-hosted `runAgentLoop` transcript: loop steps →
 * metadata-only event drafts. What each step contributes:
 *   - `assistant` → NOTHING (model text never enters the trace);
 *   - `tool-call` → NOTHING on its own (its `args` are the raw values the
 *     posture forbids; the paired result/refusal/error step carries the row);
 *   - `tool-result` → `tool-call`/ok (the `output` value is dropped);
 *   - `tool-error` → `tool-call`/error with the bounded, sanitized message;
 *   - `tool-refused` → `tool-denied` naming the missing capability.
 */
export function loopStepEvents(
	steps: readonly AgentLoopStep[],
	context: LoopTraceContext,
): AgentTraceEventDraft[] {
	const out: AgentTraceEventDraft[] = [];
	let dispatched = 0;
	for (const step of steps) {
		switch (step.kind) {
			case "tool-result":
				out.push(
					draft(AgentEventKind.ToolCall, AgentEventOutcome.Ok, {
						tool: step.tool,
						durationMs: context.dispatchDurationsMs?.[dispatched],
					}),
				);
				dispatched++;
				break;
			case "tool-error":
				out.push(
					draft(AgentEventKind.ToolCall, AgentEventOutcome.Error, {
						tool: step.tool,
						detail: step.error,
						durationMs: context.dispatchDurationsMs?.[dispatched],
					}),
				);
				dispatched++;
				break;
			case "tool-refused":
				out.push(
					draft(AgentEventKind.ToolDenied, AgentEventOutcome.Denied, {
						tool: step.tool,
						capability:
							step.reason === ToolRefusalReason.CapabilityDenied
								? firstMissingToolCapability(step.tool, context)
								: null,
						detail: step.reason,
					}),
				);
				break;
			default:
				// `assistant` / `tool-call` — deliberately no row (see above).
				break;
		}
	}
	return out;
}

/** Every `AIAgent` tool a workflow's step tree declares (Branch/ForEach
 *  bodies included) — the lookup set {@link workflowStepEvents} uses to name
 *  a refused tool's missing capability. */
export function collectWorkflowAgentTools(steps: readonly WorkflowStep[]): AgentTool[] {
	const out: AgentTool[] = [];
	const walk = (list: readonly WorkflowStep[]): void => {
		for (const step of list) {
			if (step.kind === StepKind.AIAgent) out.push(...step.tools);
			else if (step.kind === StepKind.Branch) {
				walk(step.consequent);
				if (step.alternate) walk(step.alternate);
			} else if (step.kind === StepKind.ForEach) walk(step.body);
		}
	};
	walk(steps);
	return out;
}

/** The structural slice of a `WorkflowRun/v1` step-log entry the automation
 *  codec reads. Matches `workflow-runner.ts`'s `StepLogEntry` shape without
 *  importing shell code into this dependency-free leaf. */
export type WorkflowTraceStep = {
	stepId: string;
	kind: string;
	status: string;
	durationMs: number;
	error?: string;
	output?: unknown;
};

/** Mirrors the shell runner's `StepRunStatus` wire values (the runner is
 *  shell code this leaf must not import; the values are frozen on the
 *  persisted `WorkflowRun/v1` rows). */
export enum WorkflowTraceStepStatus {
	Succeeded = "succeeded",
	Failed = "failed",
}

/** An `AIAgent` step's output IS an `AgentLoopResult` — recover its steps
 *  structurally (never trusting more than the array's step shapes). */
function loopStepsFromOutput(output: unknown): AgentLoopStep[] | null {
	if (!output || typeof output !== "object") return null;
	const steps = (output as { steps?: unknown }).steps;
	if (!Array.isArray(steps)) return null;
	return steps.filter(
		(s): s is AgentLoopStep =>
			!!s && typeof s === "object" && typeof (s as { kind?: unknown }).kind === "string",
	);
}

/**
 * The record codec for an automation run: `WorkflowRun/v1` step-log entries →
 * metadata-only event drafts (step → tool → outcome → duration, doc 77 §The
 * surfaces). Skipped steps and the Trigger pseudo-step contribute nothing; an
 * `AIAgent` step additionally expands its inner loop transcript through
 * {@link loopStepEvents} — one trace, both engines. Step `output`/inputs are
 * NEVER copied (they carry pipeline data).
 */
export function workflowStepEvents(
	stepLog: readonly WorkflowTraceStep[],
	loopContext?: Pick<LoopTraceContext, "tools" | "frozenCapabilities">,
): AgentTraceEventDraft[] {
	const out: AgentTraceEventDraft[] = [];
	for (const entry of stepLog) {
		if (entry.kind === StepKind.Trigger) continue;
		if (
			entry.status !== WorkflowTraceStepStatus.Succeeded &&
			entry.status !== WorkflowTraceStepStatus.Failed
		) {
			continue;
		}
		out.push(
			draft(
				AgentEventKind.ToolCall,
				entry.status === WorkflowTraceStepStatus.Succeeded
					? AgentEventOutcome.Ok
					: AgentEventOutcome.Error,
				{
					tool: `${entry.kind}:${entry.stepId}`,
					detail: entry.status === WorkflowTraceStepStatus.Failed ? (entry.error ?? null) : null,
					durationMs: entry.durationMs,
				},
			),
		);
		if (entry.kind === StepKind.AIAgent) {
			const inner = loopStepsFromOutput(entry.output);
			if (inner) {
				out.push(
					...loopStepEvents(inner, {
						tools: loopContext?.tools ?? [],
						frozenCapabilities: loopContext?.frozenCapabilities ?? [],
					}),
				);
			}
		}
	}
	return out;
}
