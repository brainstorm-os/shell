/**
 * Agent-6 — generalize a conversation's executed agent run into a reusable
 * `Workflow/v1` draft (save-as-automation).
 *
 * A conversation that ran tools drove the shared {@link runAgentLoop} — the
 * SAME engine the Automations `AIAgent` step interpreter runs. So the faithful,
 * simplest representation of "do what this conversation did, again" is ONE
 * {@link AIAgentStep} behind a {@link TriggerKind.Manual} trigger, carrying the
 * conversation's instruction and the same tool set the loop offered. Per-tool
 * `IntentStep`s would hardcode one run's exact dispatch sequence and discard the
 * model's reasoning/iteration; an AIAgent step replays the conversation's
 * behaviour, not a single transcript.
 *
 * **Generalize args → parameters.** A saved automation must be reusable, not a
 * replay of one run. So run-specific concrete values are replaced with a single
 * `{{input}}` parameter (the trigger's runtime input): any entity-id-looking
 * token in the instruction is parameterized, and the instruction is framed as a
 * template referencing `{{input}}`. The original ids the conversation dispatched
 * against are recorded as example inputs in the draft (surfaced in the review
 * diff), never baked into the step.
 *
 * **Capability-subset invariant (security keystone — reviewed).** The step's
 * tools are the tools the conversation ACTUALLY dispatched, intersected with the
 * conversation's frozen capability set. So
 *   workflow-caps = aggregate(step) ⊆ frozenCaps ⊆ appCaps
 * — the generated workflow can never hold a capability broader than the agent
 * was granted. {@link generalizeConversationToWorkflow} asserts this with the
 * shared three-tier check and refuses to emit a draft that violates it.
 *
 * Everything here is pure + deterministic (no React, no SDK runtime, no vault)
 * so the args→params mapping, step derivation, idempotency, and the cap-subset
 * invariant are unit-testable in isolation.
 */

import {
	type AIAgentStep,
	type AgentLoopStep,
	type AgentTool,
	CapabilityTier,
	MemoryMode,
	StepKind,
	type TriggerDef,
	TriggerKind,
	type WorkflowDef,
	type WorkflowStep,
	agentToolCapabilities,
	aggregateWorkflowCapabilities,
	capabilityImplies,
	validateCapabilityTiers,
} from "@brainstorm-os/sdk-types";

/** The runtime-input placeholder the generalized instruction references — the
 *  Manual trigger's input is bound here when the workflow runs, so the saved
 *  automation acts on a fresh value rather than the run it was distilled from. */
export const WORKFLOW_INPUT_TOKEN = "{{input}}";

/** A run-specific concrete value lifted out of the conversation into a workflow
 *  parameter. `token` is what the instruction now references; `example` is the
 *  literal from the original run, shown in the review diff so the user sees what
 *  was generalized away. */
export type GeneralizedParameter = {
	token: string;
	example: string;
};

/** The Workflow/v1 draft a conversation generalizes to: the trigger + workflow
 *  defs ready to persist (as two entities — trigger first, then workflow bound
 *  to its id), plus the parameters lifted out for the review diff. Pure data —
 *  the persist + the review UI consume it. */
export type WorkflowDraft = {
	trigger: TriggerDef;
	/** The workflow def WITHOUT a real `triggerId` — the persist layer fills it
	 *  with the created trigger's id (mirrors the Automations save path, which
	 *  carries `triggerId` separately until the trigger entity exists). */
	workflow: Omit<WorkflowDef, "triggerId">;
	/** The run-specific values generalized into `{{…}}` parameters. */
	parameters: GeneralizedParameter[];
};

/** Heuristic: does this token look like a concrete vault entity id (the
 *  run-specific value to generalize)? Vault ids are `ent_<ULID>` / `brainstorm://…`
 *  style opaque strings; we match the `ent_`/`brainstorm:` prefixes plus a bare
 *  ULID-shaped token. Deliberately conservative — over-matching would strip real
 *  words from the instruction. */
function looksLikeEntityId(token: string): boolean {
	if (token.startsWith("ent_") || token.startsWith("brainstorm:")) return true;
	// A bare Crockford-base32 ULID (26 chars) — the id body without its prefix.
	return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(token);
}

/** The entity ids the conversation's loop actually dispatched against — pulled
 *  from the `tool-call` steps' `args.entityId` (the `open` tool's payload). These
 *  are the concrete run values; they become example inputs, never baked into the
 *  step. Deduped, order-preserved. */
export function dispatchedEntityIds(steps: readonly AgentLoopStep[]): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const step of steps) {
		if (step.kind !== "tool-call") continue;
		const raw = step.call.args.entityId;
		const id = typeof raw === "string" ? raw.trim() : "";
		if (id && !seen.has(id)) {
			seen.add(id);
			ids.push(id);
		}
	}
	return ids;
}

/** The tools the conversation ACTUALLY dispatched (a `tool-result` was recorded),
 *  reduced to the offered-tool objects. Dedup by verb (the curated set keys tools
 *  by verb). A workflow only re-offers what the conversation used — narrower than
 *  the full offered set, never broader. */
export function dispatchedTools(
	steps: readonly AgentLoopStep[],
	offeredTools: readonly AgentTool[],
): AgentTool[] {
	const byVerb = new Map(offeredTools.map((tool) => [tool.verb, tool] as const));
	const used: AgentTool[] = [];
	const seen = new Set<string>();
	for (const step of steps) {
		if (step.kind !== "tool-result") continue;
		const tool = byVerb.get(step.tool);
		if (tool && !seen.has(tool.verb)) {
			seen.add(tool.verb);
			used.push(tool);
		}
	}
	return used;
}

/**
 * Generalize the conversation's instruction into a reusable template: replace
 * every entity-id-looking token with {@link WORKFLOW_INPUT_TOKEN} and frame the
 * instruction so the agent acts on the trigger's input rather than the run it was
 * distilled from. Returns the templated instruction plus the parameters lifted
 * out (the original literals, for the review diff). Idempotent: a token already
 * equal to the placeholder is left as-is.
 */
export function generalizeInstruction(instruction: string): {
	instruction: string;
	parameters: GeneralizedParameter[];
} {
	const parameters: GeneralizedParameter[] = [];
	const seen = new Set<string>();
	const generalized = instruction
		.split(/(\s+)/)
		.map((token) => {
			if (!looksLikeEntityId(token)) return token;
			if (!seen.has(token)) {
				seen.add(token);
				parameters.push({ token: WORKFLOW_INPUT_TOKEN, example: token });
			}
			return WORKFLOW_INPUT_TOKEN;
		})
		.join("");
	return { instruction: generalized, parameters };
}

/** The instruction the generated AIAgent step carries — the generalized user
 *  instruction wrapped so the agent treats `{{input}}` as its runtime operand. */
function buildStepInstructions(generalizedInstruction: string, hasInput: boolean): string {
	const base = generalizedInstruction.trim();
	if (!hasInput) return base;
	return `${base}\n\nWhen this automation runs, ${WORKFLOW_INPUT_TOKEN} is replaced with the trigger's input.`;
}

/** A stable workflow name distilled from the conversation title / first line of
 *  the instruction, bounded so it fits a list row. */
export function deriveWorkflowName(
	conversationTitle: string,
	instruction: string,
	max = 60,
): string {
	const source = conversationTitle.trim() || instruction.trim().split("\n")[0]?.trim() || "";
	const collapsed = source.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return "";
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export type GeneralizeInput = {
	/** The conversation's executed agent loop steps (the persisted `toolCalls`). */
	steps: readonly AgentLoopStep[];
	/** The user instruction the conversation ran on (the first/seed user turn,
	 *  or a representative one). Becomes the parameterized step instruction. */
	instruction: string;
	/** The tools the loop offered this conversation — the source set the used
	 *  tools are resolved from. */
	offeredTools: readonly AgentTool[];
	/** The conversation's frozen capability set (Agent-5's
	 *  `intersect(conversationGrants, appCaps)`). The cap-subset ceiling. */
	frozenCapabilities: readonly string[];
	/** A human title for the workflow (the conversation title). */
	conversationTitle: string;
	/** The pinned provider/model, if any — carried onto the step so the saved
	 *  automation routes the same way (still re-checked server-side). */
	provider?: string;
	model?: string;
};

/** Why a conversation cannot be generalized into a workflow draft. */
export enum GeneralizeRefusal {
	/** The conversation never dispatched a tool — nothing to generalize. */
	NoToolActivity = "no-tool-activity",
	/** A derived step would need a capability the conversation lacked (the
	 *  cap-subset invariant would be violated — fail closed). */
	CapabilityExceeded = "capability-exceeded",
}

export type GeneralizeResult =
	| { ok: true; draft: WorkflowDraft }
	| { ok: false; reason: GeneralizeRefusal; detail?: string };

/**
 * Generalize a conversation's executed run into a `Workflow/v1` draft —
 * the pure core of save-as-automation.
 *
 * Representation: a Manual trigger + a single AIAgent step carrying the
 * generalized instruction and the tools the conversation actually used. Args are
 * generalized via {@link generalizeInstruction} (entity ids → `{{input}}`).
 *
 * SECURITY: the step's tools are `dispatchedTools` filtered to those the frozen
 * capability set covers, and the result is asserted with
 * {@link validateCapabilityTiers} so workflow-caps ⊆ frozenCaps — a fail-closed
 * refusal (never a broadened draft) if anything is out of range.
 *
 * Deterministic + idempotent: same inputs → byte-equal draft (no timestamps, no
 * random ids; the trigger/workflow ids are minted by the persist layer).
 */
export function generalizeConversationToWorkflow(input: GeneralizeInput): GeneralizeResult {
	const usedTools = dispatchedTools(input.steps, input.offeredTools);
	if (usedTools.length === 0) {
		return { ok: false, reason: GeneralizeRefusal.NoToolActivity };
	}

	// Defence in depth: keep only tools whose caps the frozen set covers (the
	// loop already enforced this, but we never trust a persisted step blindly).
	const frozen = input.frozenCapabilities;
	const tools = usedTools.filter((tool) =>
		agentToolCapabilities(tool).every((cap) => frozen.some((f) => capabilityImplies(f, cap))),
	);
	if (tools.length === 0) {
		return { ok: false, reason: GeneralizeRefusal.CapabilityExceeded };
	}

	const { instruction: generalized, parameters: instructionParams } = generalizeInstruction(
		input.instruction,
	);
	const dispatchedIds = dispatchedEntityIds(input.steps);
	// Parameters: the instruction's lifted literals, plus the ids the loop
	// dispatched against (the runtime input the Manual trigger now supplies).
	const parameters: GeneralizedParameter[] = [...instructionParams];
	const seenExamples = new Set(parameters.map((p) => p.example));
	for (const id of dispatchedIds) {
		if (!seenExamples.has(id)) {
			seenExamples.add(id);
			parameters.push({ token: WORKFLOW_INPUT_TOKEN, example: id });
		}
	}

	const step: AIAgentStep = {
		id: "agent",
		kind: StepKind.AIAgent,
		instructions: buildStepInstructions(generalized, parameters.length > 0),
		tools,
		memory: MemoryMode.PerRun,
		...(input.provider ? { provider: input.provider } : {}),
		...(input.model ? { model: input.model } : {}),
	};
	const steps: WorkflowStep[] = [{ id: "trigger", kind: StepKind.Trigger }, step];

	const capabilities = aggregateWorkflowCapabilities(steps);

	// SECURITY: the cap-subset invariant. The workflow's aggregate caps must be a
	// subset of the conversation's frozen set (which is itself ⊆ appCaps). The
	// AIAgent step's own caps must be covered by the workflow's caps. Fail closed.
	const tiers = validateCapabilityTiers({
		appCapabilities: frozen,
		workflowCapabilities: capabilities,
		agentToolCapabilities: tools.flatMap(agentToolCapabilities),
	});
	if (!tiers.ok) {
		const detail =
			tiers.violations.find((v) => v.tier === CapabilityTier.WorkflowVsApp)?.capability ??
			tiers.violations[0]?.capability;
		return {
			ok: false,
			reason: GeneralizeRefusal.CapabilityExceeded,
			...(detail ? { detail } : {}),
		};
	}

	const trigger: TriggerDef = { kind: TriggerKind.Manual, config: {}, enabled: true };
	const name = deriveWorkflowName(input.conversationTitle, input.instruction);
	const workflow: Omit<WorkflowDef, "triggerId"> = {
		name,
		enabled: false,
		steps,
		capabilities,
	};

	return { ok: true, draft: { trigger, workflow, parameters } };
}
