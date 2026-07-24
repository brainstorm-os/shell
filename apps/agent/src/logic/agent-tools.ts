/**
 * Agent-3 — intents-as-tools + the three-tier fail-closed capability ceiling.
 *
 * The Agent app exposes a CURATED set of intent verbs to the model as
 * {@link AgentTool}s. The shared {@link runAgentLoop} (sdk-types) is the one
 * engine that offers / dispatches them — this module supplies (1) the curated
 * tool catalogue, (2) the THIRD security tier (conversation grants) layered on
 * top of the loop's existing two-tier intersection, and (3) the pure mapping
 * from a model tool-call to a capability-checked `intents.dispatch`.
 *
 * **Three-tier ceiling (the security keystone — reviewed).**
 *   agent-tools ⊆ conversation-grants ⊆ app-caps
 * - `app-caps` = the app's manifest capabilities (`window.brainstorm.capabilities`).
 *   This is the hard ceiling: nothing the manifest does not grant is reachable.
 * - `conversation-grants` = the per-conversation granted subset. The loop's
 *   `frozenCapabilities` is `intersect(conversationGrants, appCaps)` — a
 *   conversation can only NARROW the app's caps, never broaden them.
 * - `agent-tools` = the loop's fail-closed tool intersection against that frozen
 *   set (`intersectAgentTools`), re-checked per dispatch.
 *
 * For Agent-3 the per-conversation grant defaults to the full app caps (the
 * grant UI + narrowing is Agent-5). But `conversationGrants` is a real, separate
 * input here so Agent-5 only has to populate it — the intersection already holds.
 *
 * **Why one curated `open` tool (not one per type).** The shared loop addresses
 * a tool by its `verb` alone, so two tools sharing a verb collide. The Agent
 * therefore exposes a single `open` tool — the universal, read-only cross-app
 * navigation verb (doc 37). It carries NO declared `entityType`: the shell
 * resolves an id to its type server-side (shell-mediated resolution, doc 31), so
 * the model never supplies a type, and the tool requires only
 * `intents.dispatch:open`. Mutating verbs (create/update/delete) are deliberately
 * out of scope here — they arrive with the per-conversation grant UI (Agent-5).
 */

import {
	type AgentTool,
	type AgentToolCall,
	agentToolCapabilities,
	capabilityImplies,
} from "@brainstorm-os/sdk-types";
import { proposeTools } from "./propose-artifacts";
import { PROPOSE_DATABASE_VERB } from "./propose-database";
import { PROPOSE_ROW_VERB } from "./propose-row";

/** The verbs the curated tools dispatch. `open` is the universal cross-app
 *  navigation verb every type's owner app handles (doc 37) — it only routes /
 *  surfaces an object, never mutates. Centralised here per the
 *  no-raw-string-discriminators convention. */
export const AGENT_TOOL_VERB = {
	/** Open / navigate to an object in whichever app owns its type (read-only). */
	Open: "open",
} as const;
export type AgentToolVerb = (typeof AGENT_TOOL_VERB)[keyof typeof AGENT_TOOL_VERB];

/** The curated tool catalogue offered to the model: the read-only `open`
 *  navigation verb plus the Agent-11 propose-* tools (each stages a draft the
 *  user approves — see `propose-artifacts.ts`). `translate` localises each
 *  label; the model addresses a tool by its stable `verb`. The three-tier
 *  ceiling + the loop's fail-closed intersection still gate every one.
 *
 *  `hasDatabases` (Agent-11d) gates the row tool: with no Collection in the
 *  vault every row proposal would refuse, so the tool isn't offered at all —
 *  the model is never shown an affordance it cannot use. */
export function curatedAgentTools(
	translate: (key: string) => string,
	options: { hasDatabases?: boolean } = {},
): AgentTool[] {
	return [
		{ verb: AGENT_TOOL_VERB.Open, label: translate("tool.open.label") },
		...proposeTools(translate),
		...(options.hasDatabases
			? [{ verb: PROPOSE_ROW_VERB, label: translate("propose.row.label") }]
			: []),
		{ verb: PROPOSE_DATABASE_VERB, label: translate("propose.database.label") },
	];
}

/** The full capability footprint the curated tools COULD require — the union of
 *  every curated tool's caps. The manifest must hold these for any tool to be
 *  offered; the manifest test asserts the declared caps cover them. */
export function curatedToolCapabilities(): string[] {
	const caps = new Set<string>();
	for (const tool of curatedAgentTools(() => "", { hasDatabases: true })) {
		for (const cap of agentToolCapabilities(tool)) caps.add(cap);
	}
	return [...caps].sort();
}

/**
 * The THIRD tier: the conversation's frozen capability ceiling =
 * `intersect(conversationGrants, appCaps)`. A grant the app does not hold is
 * dropped (fail-closed — a conversation can only narrow, never broaden); the
 * result is exactly the caps held by BOTH tiers. Passed to `runAgentLoop` as
 * `frozenCapabilities`, so agent-tools ⊆ conversation-grants ⊆ app-caps holds.
 *
 * Pure + deterministic — unit-tested directly.
 */
export function effectiveAgentCapabilities(
	appCaps: readonly string[],
	conversationGrants: readonly string[],
): string[] {
	return conversationGrants.filter((grant) =>
		appCaps.some((held) => capabilityImplies(held, grant)),
	);
}

/** The default per-conversation grant for Agent-3: the full app caps (no
 *  narrowing yet — Agent-5 replaces this with the user-chosen subset stored on
 *  the `Conversation/v1` `toolGrants`). Its own function so the seam is explicit
 *  and Agent-5 has one call site to change. */
export function defaultConversationGrants(appCaps: readonly string[]): string[] {
	return [...appCaps];
}

/** Map a model tool-call to the `intents.dispatch` payload. SECURITY: the
 *  payload is built from the DECLARED tool (its `verb` + `entityType`, if any),
 *  not from a model-supplied verb/type — the loop has already proved `call.tool`
 *  is in the offered set, and we re-key it to the declared tool here. The
 *  model's `args` ride through as the payload's caller-supplied fields (an
 *  `entityId` for `open`); the shell resolves the id's type itself. A declared
 *  `entityType` (none for the curated `open` tool) always overrides any
 *  `entityType` the model put in `args`. */
export function toolCallToIntent(
	tool: AgentTool,
	call: AgentToolCall,
): { verb: string; payload: Record<string, unknown> } {
	// Drop any model-supplied `entityType`, then re-add ONLY the declared one
	// (none for the curated `open` tool — the shell resolves the id's type).
	const { entityType: _ignored, ...rest } = call.args as { entityType?: unknown };
	const payload: Record<string, unknown> = { ...rest };
	if (tool.entityType) payload.entityType = tool.entityType;
	return { verb: tool.verb, payload };
}
