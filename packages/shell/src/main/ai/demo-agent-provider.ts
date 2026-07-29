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

/** AppForge-3 — the "build a tiny app inside Brainstorm" act: the agent
 *  drafts a `manifest.json` + an `index.html` as `propose-code-file` cards the
 *  user approves into the vault. Same capture-only contract as the default
 *  script; selected via `BRAINSTORM_DEMO_AGENT=appforge`. */
export const DEMO_AGENT_APPFORGE_SCRIPT: readonly string[] = [
	JSON.stringify({
		tool: "propose-code-file",
		args: {
			path: "hello-app/manifest.json",
			language: "json",
			content: [
				"{",
				'  "id": "io.brainstorm.hello",',
				'  "name": "Hello",',
				'  "version": "0.1.0",',
				'  "entry": "index.html",',
				'  "capabilities": []',
				"}",
				"",
			].join("\n"),
		},
	}),
	JSON.stringify({
		tool: "propose-code-file",
		args: {
			path: "hello-app/index.html",
			language: "html",
			content: [
				"<!doctype html>",
				'<html lang="en">',
				"  <head>",
				'    <meta charset="utf-8" />',
				"    <title>Hello</title>",
				"  </head>",
				"  <body>",
				"    <h1>Hello, Brainstorm!</h1>",
				"  </body>",
				"</html>",
				"",
			].join("\n"),
		},
	}),
	JSON.stringify({
		final:
			"I've drafted the two files for the Hello app — its manifest.json and index.html. Review and approve them to add the code files to your vault; nothing is saved until you do.",
		citations: [],
	}),
];

/** The env value (`BRAINSTORM_DEMO_AGENT=<value>`) that selects the AppForge
 *  code-file script; any other truthy value keeps the default follow-up reel. */
export const DEMO_AGENT_APPFORGE_MODE = "appforge";

/** Resolve which script a `BRAINSTORM_DEMO_AGENT` value drives. Pure. */
export function demoScriptForMode(mode: string | undefined): readonly string[] {
	return mode === DEMO_AGENT_APPFORGE_MODE ? DEMO_AGENT_APPFORGE_SCRIPT : DEMO_AGENT_SCRIPT;
}

/** The script step this turn is on = how many tool acks are already fed back
 *  (the loop appends one `tool`-role message per dispatched proposal). Clamped
 *  to the final reply so the loop always terminates. */
export function demoScriptIndex(
	messages: readonly AiChatMessage[],
	script: readonly string[] = DEMO_AGENT_SCRIPT,
): number {
	const toolReplies = messages.filter((m) => m.role === MessageRole.Tool).length;
	return Math.min(toolReplies, script.length - 1);
}

/** The next scripted reply for the given transcript. Pure + total. */
export function nextDemoReply(
	messages: readonly AiChatMessage[],
	script: readonly string[] = DEMO_AGENT_SCRIPT,
): string {
	const reply = script[demoScriptIndex(messages, script)];
	// The index is clamped in-bounds, but satisfy `noUncheckedIndexedAccess`.
	return reply ?? script[script.length - 1] ?? "";
}

/** The scripted demo provider. Registered as the default ONLY when
 *  `BRAINSTORM_DEMO_AGENT` is set (see the provider registration in `index.ts`),
 *  so a demo-vault agent turn with no pinned provider routes here. `mode` is
 *  the env value — `"appforge"` selects the code-file script. */
export function createDemoAgentProvider(mode?: string): ModelProvider {
	const script = demoScriptForMode(mode);
	return {
		id: DEMO_AGENT_PROVIDER_ID,
		async generate(req: AiGenerateRequest): Promise<AiGenerateResult> {
			const usage = buildUsage(0, 0);
			return {
				content: nextDemoReply(req.messages, script),
				provider: DEMO_AGENT_PROVIDER_ID,
				model: "demo-agent",
				finishReason: "stop",
				...(usage ? { usage } : {}),
			};
		},
	};
}
