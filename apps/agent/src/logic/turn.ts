/**
 * Agent-3 — the tool-enabled turn runner. Wires the shared {@link runAgentLoop}
 * (sdk-types — the ONE engine, also used by the Automations `AIAgent` step) into
 * the Agent app's chat turn: the loop's `generate` port reaches the broker
 * `ai.generate`, its `dispatchTool` port dispatches an intent through the
 * cap-checked bus, and the frozen ceiling is the three-tier intersection.
 *
 * Kept out of `app.tsx` so the wiring + the security mapping are unit-testable
 * without React: a turn run is `(ports, config) → AgentLoopResult` with the
 * ports built from injected service handles.
 */

import {
	type AgentLoopConfig,
	type AgentLoopPorts,
	type AgentLoopResult,
	type AgentTool,
	type AgentToolCall,
	type AiChatMessage,
	type AiService,
	type Intent,
	type IntentsService,
	runAgentLoop,
} from "@brainstorm/sdk-types";
import { toolCallToIntent } from "./agent-tools";
import { withRetrievalContext } from "./retrieval";
import { AGENT_GROUNDING_GUIDANCE } from "./transcript";

/** The instruction region the agent loop seeds. Mirrors the plain-chat system
 *  prompt but names the tool affordance, so the model knows it may act. */
export const AGENT_TOOL_SYSTEM_PROMPT = `You are a helpful assistant inside the user's Brainstorm knowledge workspace. Answer concisely and directly. Use a tool only when it genuinely helps the user. ${AGENT_GROUNDING_GUIDANCE}`;

/** Build the loop's `dispatchTool` port over the intents service. SECURITY:
 *  the offered set the loop computed already proved `call.tool`; we re-key the
 *  call to its DECLARED tool ({@link toolCallToIntent}) so the dispatched verb +
 *  entityType come from the curated tool, never the model. The ledger re-checks
 *  `intents.dispatch:<verb>` server-side (defence in depth). */
export function makeDispatchTool(
	intents: IntentsService,
	tools: readonly AgentTool[],
): (call: AgentToolCall) => Promise<unknown> {
	const byVerb = new Map(tools.map((tool) => [tool.verb, tool] as const));
	return async (call: AgentToolCall) => {
		const tool = byVerb.get(call.tool);
		// Defence in depth: a verb not in the curated set never dispatches (the
		// loop refuses it too, but we fail closed independently).
		if (!tool) throw new Error(`unknown tool: ${call.tool}`);
		const intent = toolCallToIntent(tool, call);
		// The curated verbs are members of the `IntentVerb` union (`open`); the
		// dispatch surface types `verb` as that union. The verb came from the
		// DECLARED tool, not the model, so the narrowing is safe.
		const result = await intents.dispatch(intent as Omit<Intent, "source">);
		return result?.value ?? { handled: result?.handled ?? false };
	};
}

/** Build the loop's `generate` port over the AI broker. The frozen caps ride to
 *  the broker as the request's capability requirements (the broker re-derives
 *  them via `aiCapabilitiesForRequest`); the app passes only the transcript.
 *  Agent-5: a conversation may pin a `provider`/`model` — when set, they ride on
 *  the request so the broker routes to that provider (still re-checking the
 *  `ai.provider:<id>` cap server-side). When absent, the broker uses its
 *  configured default (the AUTO path). */
export function makeGenerate(
	ai: AiService,
	route?: { provider?: string; model?: string },
): AgentLoopPorts["generate"] {
	return async (messages: readonly AiChatMessage[]) => {
		const result = await ai.generate({
			messages,
			...(route?.provider ? { provider: route.provider } : {}),
			...(route?.model ? { model: route.model } : {}),
		});
		return {
			content: result.content,
			provenance: {
				provider: result.provider,
				model: result.model,
				generatedAt: new Date().toISOString(),
			},
		};
	};
}

/** Run one tool-enabled turn. `transcript` is the prior conversation as the AI
 *  wire format (without the system region — the loop prepends its own tool
 *  manifest). Returns the full {@link AgentLoopResult} (final answer + steps +
 *  provenance) for persistence. */
export function runAgentTurn(
	services: { ai: AiService; intents: IntentsService },
	input: {
		tools: readonly AgentTool[];
		frozenCapabilities: readonly string[];
		transcript: readonly AiChatMessage[];
		/** Agent-4 — the broker-assembled hybrid-retrieval context block to
		 *  ground this turn on (id + title + snippet per hit). Appended to the
		 *  instruction region so the model can cite real vault-object ids. Empty
		 *  when retrieval found nothing / the search service is absent (the turn
		 *  then degrades to ungrounded chat). */
		retrievalContext?: string;
		/** Agent-5 — the conversation's pinned provider/model (omitted = AUTO,
		 *  the shell's configured default). Threaded onto every `ai.generate` the
		 *  loop issues this turn. */
		provider?: string;
		model?: string;
		maxIterations?: number;
	},
): Promise<AgentLoopResult> {
	const ports: AgentLoopPorts = {
		generate: makeGenerate(services.ai, {
			...(input.provider ? { provider: input.provider } : {}),
			...(input.model ? { model: input.model } : {}),
		}),
		dispatchTool: makeDispatchTool(services.intents, input.tools),
	};
	const config: AgentLoopConfig = {
		instructions: withRetrievalContext(AGENT_TOOL_SYSTEM_PROMPT, input.retrievalContext ?? ""),
		tools: input.tools,
		frozenCapabilities: input.frozenCapabilities,
		transcript: input.transcript,
		...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
	};
	return runAgentLoop(ports, config);
}

/** The tool-activity summary the UI surfaces per turn — a compact "used tool X"
 *  list derived from the loop steps. Dispatched tool calls only (refusals /
 *  errors are recorded in provenance but not surfaced as "used"). */
export function usedToolNames(result: AgentLoopResult): string[] {
	const used: string[] = [];
	for (const step of result.steps) {
		if (step.kind === "tool-result") used.push(step.tool);
	}
	return used;
}
