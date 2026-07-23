/**
 * Capture-only scripted provider (demo mode).
 *
 * The Agent-11 propose→approve reel needs the agent to *generate* proposals on
 * camera, but the promo rig is deterministic and model-free by design (it seeds
 * every other scene through the app's own dev handlers). This provider is that
 * seam for the agent scene: gated behind the `BRAINSTORM_DEMO_AGENT` env flag
 * (never registered in normal dev/prod), it returns a fixed, scripted sequence
 * of `propose-*` tool calls followed by a final answer.
 *
 * Crucially it drives the **real** {@link runAgentLoop}: each `generate` returns
 * the next scripted reply, which the genuine `parseAgentReply` →
 * `makeDispatchTool` → `buildProposal` → proposal-tray path parses, dispatches,
 * and stages. Only the "model" is scripted — every pixel downstream of it is the
 * real pipeline, so the reel shows the true propose→approve UX, reproducibly.
 */

import {
	type AiChatMessage,
	type AiGenerateRequest,
	type AiGenerateResult,
	MessageRole,
} from "@brainstorm-os/sdk-types";
import { type ModelProvider, buildUsage } from "./provider";

export const DEMO_AGENT_PROVIDER_ID = "demo";

/** The scripted turn — a "follow-up after a client call" scenario matching the
 *  VID-agent-team foundations cut. Each entry is one loop iteration's reply, in
 *  the loop's JSON tool-call protocol; the last is the final answer. Dates are
 *  fixed so the reel is byte-identical every render. */
export const DEMO_AGENT_SCRIPT: readonly string[] = [
	JSON.stringify({
		tool: "propose-contact",
		args: {
			name: "Priya Rao",
			email: "priya@meridian.co",
			company: "Meridian",
			notes: "Q3 retainer lead — met on the intro call.",
		},
	}),
	JSON.stringify({
		tool: "propose-task",
		args: {
			title: "Follow up with Priya on the Q3 retainer",
			dueDate: "2026-07-30",
			notes: "Send the scope recap and the pricing options we discussed.",
		},
	}),
	JSON.stringify({
		tool: "propose-event",
		args: {
			title: "Q3 retainer check-in with Meridian",
			start: "2026-07-31T15:00:00Z",
			notes: "30-minute call to walk through the proposal.",
		},
	}),
	JSON.stringify({
		final:
			"I've drafted a contact for Priya, a follow-up task, and a check-in event. Review and approve the ones you want to keep — nothing is saved to your vault until you do.",
		citations: [],
	}),
];

/** The script step this turn is on = how many tool acks are already fed back
 *  (the loop appends one `tool`-role message per dispatched proposal). Clamped
 *  to the final reply so the loop always terminates. */
export function demoScriptIndex(messages: readonly AiChatMessage[]): number {
	const toolReplies = messages.filter((m) => m.role === MessageRole.Tool).length;
	return Math.min(toolReplies, DEMO_AGENT_SCRIPT.length - 1);
}

/** The next scripted reply for the given transcript. Pure + total. */
export function nextDemoReply(messages: readonly AiChatMessage[]): string {
	const reply = DEMO_AGENT_SCRIPT[demoScriptIndex(messages)];
	// The index is clamped in-bounds, but satisfy `noUncheckedIndexedAccess`.
	return reply ?? DEMO_AGENT_SCRIPT[DEMO_AGENT_SCRIPT.length - 1] ?? "";
}

/** The scripted demo provider. Registered as the default ONLY when
 *  `BRAINSTORM_DEMO_AGENT` is set (see the provider registration in `index.ts`),
 *  so a demo-vault agent turn with no pinned provider routes here. */
export function createDemoAgentProvider(): ModelProvider {
	return {
		id: DEMO_AGENT_PROVIDER_ID,
		async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
			const usage = buildUsage(0, 0);
			return {
				content: nextDemoReply(req.messages),
				provider: DEMO_AGENT_PROVIDER_ID,
				model: "demo-agent",
				finishReason: "stop",
				...(usage ? { usage } : {}),
			};
		},
	};
}
