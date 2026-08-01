/**
 * Agent-12b — the per-turn "what I did" timeline, derived from an assistant
 * message's persisted `toolCalls` (the loop's `AgentLoopStep[]`). This upgrades
 * the transient "used tool X" chips into a durable, ordered account: what the
 * turn searched, called, staged, and — most important — what it was DENIED,
 * named in plain language and wired to the escalation prompt.
 *
 * Pure + deterministic (no React, no DOM) so the mapping is unit-tested in
 * isolation. It reads the SAME shape the conversation already displays (no new
 * read capability — doc 77 §The surfaces), and carries only metadata: a tool
 * verb, a capability name, an outcome — never argument values or model text.
 */

import { type AgentLoopStep, ToolRefusalReason } from "@brainstorm-os/sdk-types";

/** A row in the turn timeline, tagged for the renderer's icon + phrasing. */
export enum TurnTimelineKind {
	ToolCall = "tool-call",
	ToolError = "tool-error",
	Denied = "denied",
}

export type TurnTimelineItem = {
	kind: TurnTimelineKind;
	/** The tool verb (ours — safe to render as text). */
	tool: string;
	/** For a `Denied` item, the capability this conversation does not grant —
	 *  the actionable content that drives the escalation prompt. Null when the
	 *  refusal was an unknown tool (the model invented the name). */
	capability: string | null;
	/** Stable per-occurrence key (a verb may appear several times in a turn). */
	key: string;
};

/** The capability the curated `open` tool would need to dispatch a verb —
 *  `intents.dispatch:<verb>`; mirrors `agentToolCapabilities` for the
 *  refusal→grant mapping without importing the tool object. */
export function capabilityForVerb(verb: string): string {
	return `intents.dispatch:${verb}`;
}

function isStep(value: unknown): value is AgentLoopStep {
	return (
		!!value && typeof value === "object" && typeof (value as { kind?: unknown }).kind === "string"
	);
}

/**
 * Map a persisted `toolCalls` value into ordered timeline items. Tolerant of
 * the untyped persisted shape. Mirrors the shell-side `loopStepEvents` codec:
 * `assistant` and bare `tool-call` steps contribute nothing (the row rides the
 * paired result / refusal / error), a `tool-result` is a completed call, a
 * `tool-error` a failed one, and a `tool-refused` a denial naming the missing
 * capability (for a capability-denied refusal).
 */
export function turnTimeline(raw: unknown): TurnTimelineItem[] {
	if (!Array.isArray(raw)) return [];
	const items: TurnTimelineItem[] = [];
	const counts = new Map<string, number>();
	const push = (kind: TurnTimelineKind, tool: string, capability: string | null): void => {
		const n = counts.get(tool) ?? 0;
		counts.set(tool, n + 1);
		items.push({ kind, tool, capability, key: `${tool}#${n}` });
	};
	for (const step of raw) {
		if (!isStep(step)) continue;
		switch (step.kind) {
			case "tool-result":
				push(TurnTimelineKind.ToolCall, step.tool, null);
				break;
			case "tool-error":
				push(TurnTimelineKind.ToolError, step.tool, null);
				break;
			case "tool-refused":
				push(
					TurnTimelineKind.Denied,
					step.tool,
					step.reason === ToolRefusalReason.CapabilityDenied ? capabilityForVerb(step.tool) : null,
				);
				break;
			default:
				// `assistant` / `tool-call` — no row (see module doc).
				break;
		}
	}
	return items;
}

/** How many of the timeline's items are denials — drives the run-level denial
 *  badge on the assistant bubble. */
export function timelineDenialCount(items: readonly TurnTimelineItem[]): number {
	return items.reduce((n, item) => (item.kind === TurnTimelineKind.Denied ? n + 1 : n), 0);
}
