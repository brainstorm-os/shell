/**
 * 11b.16 — Brainstorm-native automation import/export (pure codec).
 *
 * Export packs ONE workflow + its trigger into a portable JSON bundle
 * carrying only authorable content (name / steps / trigger config) —
 * vault-specific identity (entity ids, the trigger binding) and the two
 * security-derived fields are deliberately NOT exported:
 *   - `capabilities` are recomputed from the steps on import (a bundle
 *     can never smuggle a wider sheet than its steps justify, mirroring
 *     the 11b.1 aggregate-capability keystone);
 *   - `enabled` is forced false on import (review-before-run, the same
 *     safe default the 11b.14 template gallery ships).
 * Import is fail-closed: a malformed bundle returns structured issues,
 * never a partially-built workflow. The n8n importer is v2.
 */

import {
	type AutomationIssue,
	type TriggerDef,
	type WorkflowDef,
	type WorkflowStep,
	aggregateWorkflowCapabilities,
	isTriggerKind,
	validateTrigger,
	validateWorkflow,
} from "@brainstorm-os/sdk-types";

export const AUTOMATION_BUNDLE_KIND = "brainstorm/automation-bundle";
export const AUTOMATION_BUNDLE_VERSION = 1;

/** The portable wire shape. `workflow` carries authorable fields only. */
export type AutomationBundle = {
	kind: typeof AUTOMATION_BUNDLE_KIND;
	version: typeof AUTOMATION_BUNDLE_VERSION;
	workflow: {
		name: string;
		description?: string;
		icon?: string;
		tags?: string[];
		steps: WorkflowStep[];
	};
	trigger: {
		kind: TriggerDef["kind"];
		config: TriggerDef["config"];
	};
};

/** Pack a workflow + its trigger for export. Identity, the capability
 *  sheet, and enablement are dropped by design (see module doc). */
export function exportAutomation(workflow: WorkflowDef, trigger: TriggerDef): AutomationBundle {
	return {
		kind: AUTOMATION_BUNDLE_KIND,
		version: AUTOMATION_BUNDLE_VERSION,
		workflow: {
			name: workflow.name,
			...(workflow.description !== undefined ? { description: workflow.description } : {}),
			...(workflow.icon !== undefined ? { icon: workflow.icon } : {}),
			...(workflow.tags !== undefined ? { tags: [...workflow.tags] } : {}),
			steps: workflow.steps,
		},
		trigger: { kind: trigger.kind, config: trigger.config },
	};
}

export function serializeAutomationBundle(bundle: AutomationBundle): string {
	return JSON.stringify(bundle, null, 2);
}

export type ParseBundleResult =
	| { ok: true; bundle: AutomationBundle }
	| { ok: false; issues: string[] };

/**
 * Parse + validate untrusted bundle text. Structural shape first, then
 * the sdk-types trigger/workflow validators over a candidate (with a
 * placeholder trigger binding — the real one is minted on import).
 */
export function parseAutomationBundle(text: string): ParseBundleResult {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, issues: ["Not valid JSON."] };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, issues: ["Bundle must be a JSON object."] };
	}
	const obj = raw as Record<string, unknown>;
	const issues: string[] = [];
	if (obj.kind !== AUTOMATION_BUNDLE_KIND) issues.push("Not an automation bundle.");
	if (obj.version !== AUTOMATION_BUNDLE_VERSION) {
		issues.push(`Unsupported bundle version "${String(obj.version)}".`);
	}
	const workflow = obj.workflow as Record<string, unknown> | undefined;
	const trigger = obj.trigger as Record<string, unknown> | undefined;
	if (!workflow || typeof workflow !== "object") issues.push("Bundle has no workflow.");
	if (!trigger || typeof trigger !== "object") issues.push("Bundle has no trigger.");
	if (issues.length > 0) return { ok: false, issues };

	const w = workflow as Record<string, unknown>;
	const tr = trigger as Record<string, unknown>;
	if (typeof w.name !== "string") issues.push("Workflow name must be a string.");
	if (!Array.isArray(w.steps)) issues.push("Workflow steps must be an array.");
	if (!isTriggerKind(tr.kind)) issues.push(`Unknown trigger kind "${String(tr.kind)}".`);
	if (issues.length > 0) return { ok: false, issues };

	const candidateTrigger: TriggerDef = {
		kind: tr.kind as TriggerDef["kind"],
		config: (tr.config ?? {}) as TriggerDef["config"],
		enabled: true,
	};
	// Steps are untrusted: a null / non-object entry must become an issue,
	// not a TypeError out of the validators or the capability aggregator.
	const rawSteps = w.steps as unknown[];
	if (!rawSteps.every((step) => Boolean(step) && typeof step === "object")) {
		return { ok: false, issues: ["Workflow has a malformed step."] };
	}
	const steps = rawSteps as WorkflowStep[];
	const candidateWorkflow: WorkflowDef = {
		name: w.name as string,
		enabled: false,
		triggerId: "pending",
		// Validation never needs the sheet; computing it before the step
		// kinds are validated could throw on a structurally-broken step.
		steps,
		capabilities: [],
	};
	issues.push(
		...validateTrigger(candidateTrigger).map(messageOf),
		...validateWorkflow(candidateWorkflow).map(messageOf),
	);
	if (issues.length > 0) return { ok: false, issues };
	try {
		aggregateWorkflowCapabilities(steps);
	} catch {
		// Kinds are valid but a kind-specific payload is broken (e.g. an
		// ai-agent step missing `tools`) — fail closed, per the module doc.
		return { ok: false, issues: ["Workflow has a malformed step."] };
	}

	const bundle: AutomationBundle = {
		kind: AUTOMATION_BUNDLE_KIND,
		version: AUTOMATION_BUNDLE_VERSION,
		workflow: {
			name: w.name as string,
			...(typeof w.description === "string" ? { description: w.description } : {}),
			...(typeof w.icon === "string" ? { icon: w.icon } : {}),
			...(Array.isArray(w.tags)
				? { tags: (w.tags as unknown[]).filter((x): x is string => typeof x === "string") }
				: {}),
			steps,
		},
		trigger: { kind: candidateTrigger.kind, config: candidateTrigger.config },
	};
	return { ok: true, bundle };
}

function messageOf(issue: AutomationIssue): string {
	return issue.message;
}

export type ImportedAutomation = {
	trigger: TriggerDef;
	/** Build the workflow once the minted trigger entity id is known —
	 *  the same two-phase shape `instantiateTemplate` uses (11b.14). */
	makeWorkflow: (triggerId: string) => WorkflowDef;
};

/** Resolve a validated bundle into persistable entities. Capabilities are
 *  recomputed; the workflow imports DISABLED for review. */
export function importAutomation(bundle: AutomationBundle, name?: string): ImportedAutomation {
	const capabilities = aggregateWorkflowCapabilities(bundle.workflow.steps);
	return {
		trigger: { kind: bundle.trigger.kind, config: bundle.trigger.config, enabled: true },
		makeWorkflow: (triggerId: string): WorkflowDef => {
			const def: WorkflowDef = {
				name: name ?? bundle.workflow.name,
				enabled: false,
				triggerId,
				steps: bundle.workflow.steps,
				capabilities,
			};
			if (bundle.workflow.description !== undefined) def.description = bundle.workflow.description;
			if (bundle.workflow.icon !== undefined) def.icon = bundle.workflow.icon;
			if (bundle.workflow.tags !== undefined) def.tags = [...bundle.workflow.tags];
			return def;
		},
	};
}

/** A collision-free display name for an import: the bundle's own name,
 *  else `Name (2)`, `Name (3)`, … against the existing workflow names. */
export function resolveImportName(name: string, existing: ReadonlyArray<string>): string {
	const taken = new Set(existing.map((n) => n.trim()));
	const base = name.trim().length > 0 ? name.trim() : "Imported automation";
	if (!taken.has(base)) return base;
	for (let n = 2; ; n += 1) {
		const candidate = `${base} (${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}
