/**
 * 11b.11 — the pure builder model behind the workflow-builder UI. The
 * builder authors a `Workflow/v1` the existing shell runner already
 * executes (engine spine 11b.1–.9); this module owns the editable shape,
 * the step palette, linear composition (add / remove / reorder /
 * duplicate), the output-binding affordance, the save-time capability
 * sheet, and the save-time validation pass — all DOM-free so they unit-test
 * directly.
 *
 * **OQ-166 (resolved 2026-06-14 → stable per-step uuid id references, NOT
 * Yjs RelativePosition anchors).** The v1 builder is linear: a later step
 * binds an earlier step's output by that step's stable `id`. Copy/paste
 * (duplicate) mints a fresh uuid, so a duplicated step's binding is rewired
 * by the same rule; an input referencing an absent step id is `<unbound>`
 * and `validateBuilderWorkflow` surfaces it. Member access into a bound
 * output rides the OQ-167 `code-expression` grammar at runtime — the
 * builder stores the binding as a plain expression string (`step-id` or
 * `step-id.field`), exactly what the runner's `outputs` map resolves.
 *
 * The capability sheet is the union the steps require
 * (`aggregateWorkflowCapabilities`) shown against the automations app's
 * granted ceiling, mirroring the host's `missingCapabilities` shape — the
 * consent surface the user reviews before save (doc 39 §Aggregate
 * capabilities). A workflow whose sheet exceeds the app ceiling cannot be
 * saved (the same fail-closed rule the host enforces at run time).
 */

import {
	type AIAgentStep,
	type AICallStep,
	type BranchStep,
	type CodeStep,
	EntityOp,
	type EntityStep,
	type ExportStep,
	type ForEachStep,
	type IntentStep,
	type NotifyStep,
	StepKind,
	type SubWorkflowStep,
	type WaitStep,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
	isStepKind,
	missingCapabilities,
} from "@brainstorm-os/sdk-types";

/** The step kinds the v1 builder palette offers — the engine-spine set plus
 *  the AI steps (11b.7), which the runner now has interpreters for. `Trigger`
 *  is the implicit first pseudo-step (added with the workflow, never inserted
 *  from the palette); `HTTP` stays omitted until its egress allowlist lands
 *  (11b.8b). */
export const BUILDER_STEP_KINDS = Object.freeze([
	StepKind.Intent,
	StepKind.Entity,
	StepKind.Notify,
	StepKind.Wait,
	StepKind.AICall,
	StepKind.AIAgent,
	StepKind.Branch,
	StepKind.ForEach,
	StepKind.Code,
	StepKind.Export,
	StepKind.SubWorkflow,
]) as readonly StepKind[];

/** Sentinel for an input that references a now-absent prior step (a paste
 *  across workflows, or a delete of the bound step). Mirrors the engine's
 *  documented `<unbound>` outcome (OQ-166). */
export const UNBOUND = "<unbound>";

/** Mint a fresh stable step id. `crypto.randomUUID` is available in both
 *  the renderer and the jsdom test environment; the fallback keeps the
 *  module pure of a hard `crypto` dependency for non-DOM unit runs. */
export function freshStepId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return `step-${c.randomUUID()}`;
	return `step-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/** A new step of `kind` with safe empty defaults and a fresh id. */
export function makeStep(kind: StepKind): WorkflowStep {
	const id = freshStepId();
	switch (kind) {
		case StepKind.Intent:
			return { id, kind, verb: "open" } satisfies IntentStep;
		case StepKind.Entity:
			return { id, kind, op: EntityOp.Query, entityType: "" } satisfies EntityStep;
		case StepKind.Notify:
			return { id, kind, title: "" } satisfies NotifyStep;
		case StepKind.Wait:
			return { id, kind, durationMs: 0 } satisfies WaitStep;
		case StepKind.Branch:
			return { id, kind, condition: "", consequent: [] } satisfies BranchStep;
		case StepKind.ForEach:
			return { id, kind, collection: "", body: [] } satisfies ForEachStep;
		case StepKind.Code:
			return { id, kind, expression: "" } satisfies CodeStep;
		case StepKind.Export:
			return { id, kind, format: "markdown" } satisfies ExportStep;
		case StepKind.SubWorkflow:
			return { id, kind, workflowId: "" } satisfies SubWorkflowStep;
		case StepKind.AICall:
			return { id, kind, instructions: "" } satisfies AICallStep;
		case StepKind.AIAgent:
			return { id, kind, instructions: "", tools: [] } satisfies AIAgentStep;
		default:
			// Trigger and the gated kinds are never minted from the palette.
			return { id, kind: StepKind.Notify, title: "" } satisfies NotifyStep;
	}
}

/** The implicit leading pseudo-step; always present, never removable. */
export function triggerStep(): WorkflowStep {
	return { id: "trigger", kind: StepKind.Trigger };
}

/** The editable body — a `WorkflowDef` without its persisted capability
 *  sheet (recomputed at save) and with `triggerId` carried separately. */
export type BuilderState = {
	name: string;
	description?: string;
	steps: WorkflowStep[];
};

/** Seed an empty builder for a new workflow: the trigger pseudo-step only. */
export function emptyBuilderState(): BuilderState {
	return { name: "", steps: [triggerStep()] };
}

/** Load an existing `WorkflowDef` into editable builder state, guaranteeing
 *  the leading trigger pseudo-step (a malformed import without one is
 *  repaired rather than rejected). */
export function builderStateFromWorkflow(def: WorkflowDef): BuilderState {
	const steps =
		def.steps.length > 0 && def.steps[0]?.kind === StepKind.Trigger
			? [...def.steps]
			: [triggerStep(), ...def.steps];
	const state: BuilderState = { name: def.name, steps };
	if (def.description !== undefined) state.description = def.description;
	return state;
}

/** The non-trigger steps a binding may reference (every step is in scope for
 *  every later step; the trigger is referenced as `input`). Returns steps in
 *  composition order so the UI can offer "prior steps" relative to a cursor. */
export function bindableSteps(steps: readonly WorkflowStep[]): WorkflowStep[] {
	return steps.filter((s) => s.kind !== StepKind.Trigger);
}

// ──────────────────────── linear composition ────────────────────────

/** Append a step of `kind` to the end of the body. */
export function addStep(state: BuilderState, kind: StepKind): BuilderState {
	if (!isStepKind(kind) || kind === StepKind.Trigger) return state;
	return { ...state, steps: [...state.steps, makeStep(kind)] };
}

/** Remove the step at `index` (the trigger pseudo-step at 0 is protected). */
export function removeStep(state: BuilderState, index: number): BuilderState {
	if (index <= 0 || index >= state.steps.length) return state;
	const steps = state.steps.filter((_, i) => i !== index);
	return { ...state, steps };
}

/** Move the step at `index` by `delta` (±1), clamped to the post-trigger
 *  region — the trigger stays first and no step crosses ahead of it. */
export function moveStep(state: BuilderState, index: number, delta: number): BuilderState {
	const target = index + delta;
	if (index <= 0 || target <= 0 || index >= state.steps.length || target >= state.steps.length) {
		return state;
	}
	const steps = [...state.steps];
	const [moved] = steps.splice(index, 1);
	if (!moved) return state;
	steps.splice(target, 0, moved);
	return { ...state, steps };
}

/** Deep-clone a step, minting a fresh uuid for it and (recursively) its
 *  container children — so a duplicated step never collides ids with its
 *  source (OQ-166: copy/paste mints fresh uuids). Bindings inside the clone
 *  are NOT rewritten (they point at unchanged sibling ids); the v1 rule is
 *  "fresh id, re-bind by hand" and the validation pass flags any dangle. */
export function cloneStepWithFreshIds(step: WorkflowStep): WorkflowStep {
	const next = { ...step, id: freshStepId() } as WorkflowStep;
	if (next.kind === StepKind.Branch) {
		next.consequent = next.consequent.map(cloneStepWithFreshIds);
		if (next.alternate) next.alternate = next.alternate.map(cloneStepWithFreshIds);
	} else if (next.kind === StepKind.ForEach) {
		next.body = next.body.map(cloneStepWithFreshIds);
	}
	return next;
}

/** Duplicate the step at `index`, inserting the clone right after it. */
export function duplicateStep(state: BuilderState, index: number): BuilderState {
	if (index <= 0 || index >= state.steps.length) return state;
	const source = state.steps[index];
	if (!source) return state;
	const steps = [...state.steps];
	steps.splice(index + 1, 0, cloneStepWithFreshIds(source));
	return { ...state, steps };
}

/** Replace the step at `index` with `next` (config edits). */
export function updateStep(state: BuilderState, index: number, next: WorkflowStep): BuilderState {
	if (index < 0 || index >= state.steps.length) return state;
	const steps = state.steps.map((s, i) => (i === index ? next : s));
	return { ...state, steps };
}

// ──────────────────────── output binding ────────────────────────

/** Build a binding expression from a step id and optional member path —
 *  exactly what the runner's `outputs` map + code-expression grammar
 *  resolves (`step-id` or `step-id.field.sub`). An empty step id yields the
 *  `<unbound>` sentinel. */
export function bindingExpression(stepId: string, memberPath?: string): string {
	if (!stepId) return UNBOUND;
	const path = memberPath?.trim();
	return path ? `${stepId}.${path}` : stepId;
}

/** The leading step-id token of a binding expression (everything up to the
 *  first `.` or `[`), or null for the bare `input` reference / an empty
 *  expression. Used to validate that a binding points at a known step. */
export function bindingStepId(expression: string): string | null {
	const trimmed = expression.trim();
	if (trimmed.length === 0) return null;
	const head = trimmed.split(/[.[]/, 1)[0]?.trim() ?? "";
	if (head.length === 0 || head === "input") return null;
	return head;
}

/** All binding-bearing expression fields on a step (the operands the runner
 *  resolves against the `outputs` map): Branch.condition, ForEach.collection,
 *  Code.expression. A SubWorkflow's workflowId is an entity ref, not a
 *  binding, so it is excluded here. */
export function stepBindingExpressions(step: WorkflowStep): string[] {
	switch (step.kind) {
		case StepKind.Branch:
			return [step.condition];
		case StepKind.ForEach:
			return [step.collection];
		case StepKind.Code:
			return [step.expression];
		default:
			return [];
	}
}

// ──────────────────────── capability sheet ────────────────────────

export enum CapabilityRowState {
	/** The app already grants this capability. */
	Granted = "granted",
	/** The step needs it but the app lacks it (blocks save). */
	Missing = "missing",
}

export type CapabilityRow = { capability: string; state: CapabilityRowState };

export type CapabilitySheet = {
	/** The deterministically-sorted union the steps require. */
	required: string[];
	/** Per-capability granted/missing rows, in `required` order. */
	rows: CapabilityRow[];
	/** The subset of `required` the app does not grant. */
	missing: string[];
};

/**
 * The save-time capability sheet: the union the steps require (recursing
 * into containers via `aggregateWorkflowCapabilities`) projected against the
 * automations app's granted ceiling. Mirrors the host's
 * `missingCapabilities` shape exactly so the consent surface the user
 * reviews here is the same one the runner enforces fail-closed at run time.
 */
export function computeCapabilitySheet(
	steps: readonly WorkflowStep[],
	appCapabilities: readonly string[],
): CapabilitySheet {
	const required = aggregateWorkflowCapabilities(steps);
	const missing = missingCapabilities(required, appCapabilities);
	const missingSet = new Set(missing);
	const rows: CapabilityRow[] = required.map((capability) => ({
		capability,
		state: missingSet.has(capability) ? CapabilityRowState.Missing : CapabilityRowState.Granted,
	}));
	return { required, rows, missing };
}

// ──────────────────────── save-time validation ────────────────────────

export enum BuilderIssueKind {
	EmptyName = "empty-name",
	NoSteps = "no-steps",
	UnboundBinding = "unbound-binding",
	EmptyStepConfig = "empty-step-config",
	CapabilityExceeded = "capability-exceeded",
}

export type BuilderIssue = {
	kind: BuilderIssueKind;
	/** The offending step's id (absent for whole-workflow issues). */
	stepId?: string;
	/** A capability or binding token the issue is about. */
	detail?: string;
};

/** Every step id in the workflow, recursing into containers. */
export function allStepIds(steps: readonly WorkflowStep[]): Set<string> {
	const ids = new Set<string>();
	const walk = (s: WorkflowStep): void => {
		ids.add(s.id);
		if (s.kind === StepKind.Branch) {
			for (const c of s.consequent) walk(c);
			if (s.alternate) for (const c of s.alternate) walk(c);
		} else if (s.kind === StepKind.ForEach) {
			for (const c of s.body) walk(c);
		}
	};
	for (const s of steps) walk(s);
	return ids;
}

/** Walk every step (recursing into containers) collecting binding +
 *  config + unbound issues. `knownIds` is the set of all step ids in the
 *  whole workflow (containers reference siblings + ancestors + the trigger
 *  `input`). */
function collectStepIssues(
	step: WorkflowStep,
	knownIds: Set<string>,
	issues: BuilderIssue[],
): void {
	for (const expression of stepBindingExpressions(step)) {
		const ref = bindingStepId(expression);
		if (expression.trim() === UNBOUND || (ref !== null && !knownIds.has(ref))) {
			issues.push({ kind: BuilderIssueKind.UnboundBinding, stepId: step.id, detail: expression });
		}
	}
	switch (step.kind) {
		case StepKind.Entity:
			if (step.entityType.trim().length === 0) {
				issues.push({
					kind: BuilderIssueKind.EmptyStepConfig,
					stepId: step.id,
					detail: "entityType",
				});
			}
			break;
		case StepKind.Notify:
			if (step.title.trim().length === 0) {
				issues.push({ kind: BuilderIssueKind.EmptyStepConfig, stepId: step.id, detail: "title" });
			}
			break;
		case StepKind.Intent:
			if (step.verb.trim().length === 0) {
				issues.push({ kind: BuilderIssueKind.EmptyStepConfig, stepId: step.id, detail: "verb" });
			}
			break;
		case StepKind.SubWorkflow:
			if (step.workflowId.trim().length === 0) {
				issues.push({
					kind: BuilderIssueKind.EmptyStepConfig,
					stepId: step.id,
					detail: "workflowId",
				});
			}
			break;
		case StepKind.AICall:
		case StepKind.AIAgent:
			if (step.instructions.trim().length === 0) {
				issues.push({
					kind: BuilderIssueKind.EmptyStepConfig,
					stepId: step.id,
					detail: "instructions",
				});
			}
			break;
		case StepKind.Branch:
			for (const s of step.consequent) collectStepIssues(s, knownIds, issues);
			if (step.alternate) for (const s of step.alternate) collectStepIssues(s, knownIds, issues);
			break;
		case StepKind.ForEach:
			for (const s of step.body) collectStepIssues(s, knownIds, issues);
			break;
		default:
			break;
	}
}

/**
 * The save-time validation pass. Flags an empty name, an empty body (just
 * the trigger), any `<unbound>` / dangling binding, empty required config,
 * and a capability sheet that exceeds the app ceiling. A clean result
 * (`issues.length === 0`) is the gate the builder's Save button checks.
 */
export function validateBuilderWorkflow(
	state: BuilderState,
	appCapabilities: readonly string[],
): BuilderIssue[] {
	const issues: BuilderIssue[] = [];
	if (state.name.trim().length === 0) issues.push({ kind: BuilderIssueKind.EmptyName });
	const body = bindableSteps(state.steps);
	if (body.length === 0) issues.push({ kind: BuilderIssueKind.NoSteps });

	const knownIds = allStepIds(state.steps);
	for (const step of state.steps) collectStepIssues(step, knownIds, issues);

	const sheet = computeCapabilitySheet(state.steps, appCapabilities);
	for (const capability of sheet.missing) {
		issues.push({ kind: BuilderIssueKind.CapabilityExceeded, detail: capability });
	}
	return issues;
}

/**
 * Freeze builder state into a persistable `WorkflowDef`: the capability
 * sheet is computed from the steps (the user-reviewed union), the workflow
 * is bound to its trigger id, and `enabled` is set by the caller. Throws
 * nothing — the caller gates on `validateBuilderWorkflow` first.
 */
export function builderStateToWorkflow(
	state: BuilderState,
	triggerId: string,
	enabled: boolean,
): WorkflowDef {
	const def: WorkflowDef = {
		name: state.name.trim(),
		enabled,
		triggerId,
		steps: state.steps,
		capabilities: aggregateWorkflowCapabilities(state.steps),
	};
	if (state.description !== undefined && state.description.trim().length > 0) {
		def.description = state.description.trim();
	}
	return def;
}
