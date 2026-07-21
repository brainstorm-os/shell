/**
 * The shared tool-calling **agent loop** (11b.7) — the one engine both the
 * Automations `AIAgent` step and the Agent app (Agent-3) drive. Per
 * implementation-plan §Agent app: "One agent loop, two front-ends — Automations
 * runs it on a trigger, the Agent app on a turn; no second engine."
 *
 * It lives in this dependency-free contract leaf precisely so neither consumer
 * has to import the other: the loop is **pure orchestration over injected
 * ports** (`AgentLoopPorts.generate` calls the broker; `dispatchTool` dispatches
 * an intent). No network, no `@brainstorm-os/shell`, no DOM — so the whole
 * generate → tool-call → dispatch → feed-back → repeat path is exhaustively
 * unit-testable, and the two front-ends share identical behaviour and security.
 *
 * **Tool-call wire format (OQ position — see implementation-plan §11b.7).**
 * The built-in local provider (Ollama, OQ-60) and several cloud providers do
 * not expose a uniform native tool-calling API through the v1 `ai.generate`
 * surface (which is a plain `{messages}` → `{content}` transcript). So the loop
 * uses a single, auditable **JSON convention** carried in the assistant's text:
 * the system region instructs the model to answer with either
 *   `{"tool": "<name>", "args": { … }}`  — to call a tool, or
 *   `{"final": "<answer>", "citations": [ … ]}` — to finish.
 * The loop parses that JSON, dispatches a tool call (cap-checked), feeds the
 * result back as a `tool`-role message, and repeats to a bounded iteration cap.
 * A non-JSON / unparseable reply is treated as the final answer (the model
 * chose to talk, not act) so the loop always terminates. This is additive: when
 * a native tool-calling channel lands it can replace the parser without changing
 * the loop's control flow or the security model below.
 *
 * **Security keystone (capability-sensitive — reviewed).** The tools offered to
 * the model are the fail-closed INTERSECTION
 *   offered-tools = declared-tools ∩ { t : toolCapabilities(t) ⊆ frozenCaps }
 * computed by {@link intersectAgentTools}. A tool the frozen capability set does
 * not fully cover is never offered, and — defence in depth — a tool *call* for a
 * name not in the offered set, or whose caps are not covered, is REFUSED at
 * dispatch time (re-checked, never trusted from the model). The loop never
 * broadens caps and introduces no wildcard. The bounded `maxIterations` caps
 * runaway/cost blowups.
 */

import { type AgentTool, agentToolCapabilities, capabilityImplies } from "./automations";
import { type AiChatMessage, type AiProvenance, MessageRole } from "./conversation";

/** The hard ceiling on agent-loop iterations, regardless of a caller's request
 *  — a runaway/cost backstop (no workflow or chat turn may exceed it). */
export const AGENT_LOOP_MAX_ITERATIONS_CEILING = 12;

/** The default iteration bound when a caller pins none. */
export const AGENT_LOOP_DEFAULT_MAX_ITERATIONS = 6;

/** Why an agent loop stopped — drives provenance + the caller's UI. */
export enum AgentStopReason {
	/** The model emitted a final answer (or chose to talk, not act). */
	Final = "final",
	/** The iteration bound was reached before a final answer. */
	MaxIterations = "max-iterations",
	/** A generate call failed (provider unavailable / threw). */
	GenerateFailed = "generate-failed",
}

/** A single tool invocation the model asked for, as parsed from its reply. */
export type AgentToolCall = {
	tool: string;
	args: Record<string, unknown>;
};

/** Why a tool call was refused without dispatch (fail-closed reasons). */
export enum ToolRefusalReason {
	/** The named tool is not in the offered (intersected) set. */
	UnknownTool = "unknown-tool",
	/** The tool's capabilities are not covered by the frozen set (re-check). */
	CapabilityDenied = "capability-denied",
}

/** One step of the loop's transcript-of-record (provenance). */
export type AgentLoopStep =
	| { kind: "assistant"; content: string }
	| { kind: "tool-call"; call: AgentToolCall }
	| { kind: "tool-result"; tool: string; output: unknown }
	| { kind: "tool-refused"; tool: string; reason: ToolRefusalReason }
	| { kind: "tool-error"; tool: string; error: string };

export type AgentLoopResult = {
	stopReason: AgentStopReason;
	/** The model's final answer text (empty on a generate failure). */
	finalAnswer: string;
	/** Vault entities the final answer cited (`brainstorm://` ids), if any. */
	citations: string[];
	/** How many generate calls the loop made. */
	iterations: number;
	/** The ordered loop transcript for the run/conversation provenance. */
	steps: AgentLoopStep[];
	/** Provider/model provenance of the last successful generate, if any. */
	provenance?: AiProvenance;
	/** A generate-failure message when `stopReason` is `GenerateFailed`. */
	error?: string;
};

/** What the loop needs from its host — the two effectful seams, both injected
 *  so the loop is pure. `generate` reaches the broker `ai` service; `dispatchTool`
 *  dispatches an intent under the SAME frozen caps the intersection was computed
 *  from (the host re-checks server-side too — defence in depth). */
export type AgentLoopPorts = {
	generate: (
		messages: readonly AiChatMessage[],
	) => Promise<{ content: string; provenance?: AiProvenance }>;
	dispatchTool: (call: AgentToolCall) => Promise<unknown>;
};

export type AgentLoopConfig = {
	/** The agent's task / persona — the seed `user`-region instruction. */
	instructions: string;
	/** The tools the agent MAY use — already the declared set; the loop
	 *  intersects them with `frozenCapabilities` before offering any. */
	tools: readonly AgentTool[];
	/** The workflow's / conversation's FROZEN capability set — the security
	 *  ceiling the offered tools (and every dispatch) are bounded by. */
	frozenCapabilities: readonly string[];
	/** Iteration bound; clamped to `[1, AGENT_LOOP_MAX_ITERATIONS_CEILING]`. */
	maxIterations?: number;
	/** Optional prior transcript (the Agent app passes the conversation so far;
	 *  Automations passes nothing — the instruction is the whole context). */
	transcript?: readonly AiChatMessage[];
};

/**
 * The fail-closed tool intersection (security keystone). Returns only the
 * declared tools whose full capability footprint
 * ({@link agentToolCapabilities}) is implied by the frozen set — an
 * unsatisfiable tool is dropped, never offered. Pure + deterministic so it is
 * property-tested directly.
 */
export function intersectAgentTools(
	declared: readonly AgentTool[],
	frozenCapabilities: readonly string[],
): AgentTool[] {
	return declared.filter((tool) =>
		agentToolCapabilities(tool).every((req) =>
			frozenCapabilities.some((held) => capabilityImplies(held, req)),
		),
	);
}

/** A stable tool name → the verb (the loop addresses tools by their intent
 *  verb; `label` is the human-facing description fed to the model). */
function toolName(tool: AgentTool): string {
	return tool.verb;
}

/** Build the `system`-region tool manifest + the JSON-protocol instruction.
 *  Exported so the protocol wording is unit-tested without a live model. */
export function buildAgentSystemPrompt(
	instructions: string,
	offeredTools: readonly AgentTool[],
): string {
	const lines: string[] = [
		instructions.trim(),
		"",
		"You can use tools to gather information or take actions. Available tools:",
	];
	if (offeredTools.length === 0) {
		lines.push("(none — answer from the conversation alone).");
	} else {
		for (const tool of offeredTools) {
			const scope = tool.entityType ? ` (entity type: ${tool.entityType})` : "";
			lines.push(`- ${toolName(tool)}: ${tool.label}${scope}`);
		}
	}
	lines.push(
		"",
		"Respond with a SINGLE JSON object and nothing else.",
		'To call a tool: {"tool": "<name>", "args": { ... }}.',
		'When you are done: {"final": "<your answer>", "citations": ["<entity-id>", ...]}.',
		"Only call tools from the list above. If no tool is needed, return the final answer.",
	);
	return lines.join("\n");
}

/** The two shapes a parsed reply can take (or null when it is neither). */
type ParsedReply =
	| { kind: "tool"; call: AgentToolCall }
	| { kind: "final"; answer: string; citations: string[] }
	| null;

/** Pull the first balanced top-level JSON object out of a model reply, even
 *  when wrapped in prose / a ```json fence. Returns the raw substring or null. */
function extractJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Parse a model reply into a tool call or a final answer. A reply that is not
 *  the JSON protocol is `null` → the loop treats it as a plain final answer
 *  (the model talked instead of acting), guaranteeing termination. */
export function parseAgentReply(content: string): ParsedReply {
	const json = extractJsonObject(content);
	if (!json) return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	if (typeof obj.tool === "string" && obj.tool.length > 0) {
		const args =
			obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
				? (obj.args as Record<string, unknown>)
				: {};
		return { kind: "tool", call: { tool: obj.tool, args } };
	}
	if (typeof obj.final === "string") {
		const citations = Array.isArray(obj.citations)
			? obj.citations.filter((c): c is string => typeof c === "string")
			: [];
		return { kind: "final", answer: obj.final, citations };
	}
	return null;
}

function clampIterations(requested: number | undefined): number {
	const n = requested ?? AGENT_LOOP_DEFAULT_MAX_ITERATIONS;
	if (!Number.isFinite(n) || n < 1) return 1;
	return Math.min(Math.floor(n), AGENT_LOOP_MAX_ITERATIONS_CEILING);
}

/**
 * Run the shared agent loop to completion. Deterministic given its ports:
 *   1. compute the fail-closed offered-tool set (intersection);
 *   2. seed the transcript (system manifest + instruction + prior turns);
 *   3. generate → parse → if a tool call, RE-CHECK it against the offered set
 *      and frozen caps (refuse otherwise), dispatch, feed the result back;
 *      if a final answer (or a non-protocol reply), stop;
 *   4. stop at `maxIterations` regardless.
 * Never throws on a tool failure (recorded + fed back so the model can react);
 * a `generate` throw stops the loop with `GenerateFailed`.
 */
export async function runAgentLoop(
	ports: AgentLoopPorts,
	config: AgentLoopConfig,
): Promise<AgentLoopResult> {
	const offered = intersectAgentTools(config.tools, config.frozenCapabilities);
	const offeredByName = new Map(offered.map((tool) => [toolName(tool), tool] as const));
	const maxIterations = clampIterations(config.maxIterations);

	const messages: AiChatMessage[] = [
		{ role: MessageRole.System, content: buildAgentSystemPrompt(config.instructions, offered) },
		...(config.transcript ?? []),
	];
	// Automations has no prior transcript — its instruction is the first user turn.
	if (!config.transcript || config.transcript.length === 0) {
		messages.push({ role: MessageRole.User, content: config.instructions });
	}

	const steps: AgentLoopStep[] = [];
	let provenance: AiProvenance | undefined;
	let iterations = 0;

	while (iterations < maxIterations) {
		iterations++;
		let reply: { content: string; provenance?: AiProvenance };
		try {
			reply = await ports.generate(messages);
		} catch (err) {
			return {
				stopReason: AgentStopReason.GenerateFailed,
				finalAnswer: "",
				citations: [],
				iterations,
				steps,
				...(provenance ? { provenance } : {}),
				error: err instanceof Error ? err.message : String(err),
			};
		}
		if (reply.provenance) provenance = reply.provenance;
		steps.push({ kind: "assistant", content: reply.content });
		messages.push({ role: MessageRole.Assistant, content: reply.content });

		const parsed = parseAgentReply(reply.content);

		// A final answer, or a reply that isn't the tool protocol → done.
		if (!parsed || parsed.kind === "final") {
			return {
				stopReason: AgentStopReason.Final,
				finalAnswer: parsed ? parsed.answer : reply.content,
				citations: parsed ? parsed.citations : [],
				iterations,
				steps,
				...(provenance ? { provenance } : {}),
			};
		}

		// A tool call — RE-CHECK before dispatch (defence in depth; never trust
		// a name/caps from the model).
		const call = parsed.call;
		steps.push({ kind: "tool-call", call });
		const tool = offeredByName.get(call.tool);
		if (!tool) {
			steps.push({ kind: "tool-refused", tool: call.tool, reason: ToolRefusalReason.UnknownTool });
			messages.push(toolMessage(call.tool, refusalText(ToolRefusalReason.UnknownTool)));
			continue;
		}
		const covered = agentToolCapabilities(tool).every((req) =>
			config.frozenCapabilities.some((held) => capabilityImplies(held, req)),
		);
		if (!covered) {
			steps.push({
				kind: "tool-refused",
				tool: call.tool,
				reason: ToolRefusalReason.CapabilityDenied,
			});
			messages.push(toolMessage(call.tool, refusalText(ToolRefusalReason.CapabilityDenied)));
			continue;
		}

		try {
			const output = await ports.dispatchTool(call);
			steps.push({ kind: "tool-result", tool: call.tool, output });
			messages.push(toolMessage(call.tool, JSON.stringify(output ?? null)));
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			steps.push({ kind: "tool-error", tool: call.tool, error });
			messages.push(toolMessage(call.tool, `error: ${error}`));
		}
	}

	return {
		stopReason: AgentStopReason.MaxIterations,
		finalAnswer: lastAssistantText(steps),
		citations: [],
		iterations,
		steps,
		...(provenance ? { provenance } : {}),
	};
}

/** A `tool`-role transcript message carrying a tool's result back to the model
 *  (the result is named so a multi-tool turn stays attributable). */
function toolMessage(tool: string, content: string): AiChatMessage {
	return { role: MessageRole.Tool, content: `[${tool}] ${content}` };
}

function refusalText(reason: ToolRefusalReason): string {
	return reason === ToolRefusalReason.UnknownTool
		? "refused: no such tool is available"
		: "refused: not permitted by this workflow's capabilities";
}

/** The last assistant text seen — the best-effort answer when the loop hits its
 *  iteration ceiling without a final reply. */
function lastAssistantText(steps: readonly AgentLoopStep[]): string {
	for (let i = steps.length - 1; i >= 0; i--) {
		const step = steps[i];
		if (step?.kind === "assistant") return step.content;
	}
	return "";
}
