/**
 * Automations contracts (`brainstorm/Workflow|Trigger|WorkflowRun|Reminder/v1`)
 * per.
 *
 * The automations app composes the four interop mechanisms (shared
 * entities · intents · block-embedding · format I/O) into one
 * orchestrator. The four canonical types frozen here are the data the
 * shell-side scheduler (11b.2) and workflow runner (11b.3/.4) interpret,
 * and the data the (parked) builder UI (11b.11) authors.
 *
 * **Contract-freeze scope (11b.1).** Shapes + enums + structural
 * validators + the security keystone: the *aggregate-capability /
 * three-tier intersection* (`agent-tools ⊆ workflow-caps ⊆ app-caps`),
 * fail-closed at every tier (doc 39 §Capabilities & security). The
 * AI-agent / AI-call / HTTP / Code step kinds are declared so the union
 * is frozen, but their interpreters are gated (Stage 11 / Net-1 / OQ-167)
 * and not built in the engine spine.
 *
 * Near-leaf: only the `enum-guard` leaf is imported, so this barrel
 * re-exports with no cycle. Capability strings are parsed locally (a
 * three-line mirror of the shell ledger's `parseCapability` + scope rule,
 * doc 09 §Capabilities) to keep this a dependency-free contract leaf —
 * sdk-types cannot import from `@brainstorm-os/shell`.
 */

import { enumGuard } from "./enum-guard";

export const WORKFLOW_TYPE_URL = "brainstorm/Workflow/v1";
export const TRIGGER_TYPE_URL = "brainstorm/Trigger/v1";
export const WORKFLOW_RUN_TYPE_URL = "brainstorm/WorkflowRun/v1";
export const REMINDER_TYPE_URL = "brainstorm/Reminder/v1";

/** Local alias for an entity id — a plain `string` here (rather than the
 *  `index.ts` `EntityId` alias) so this contract leaf stays
 *  dependency-free and introduces no barrel cycle. */
type AutomationEntityId = string;

// ───────────────────────────── enums ─────────────────────────────

/** The curated step vocabulary (doc 39 §The step model). New kinds are
 *  added only in shell releases — an open extension surface would make
 *  workflow audits intractable. */
export enum StepKind {
	/** Pseudo-step: the workflow's trigger, always first. */
	Trigger = "trigger",
	/** Dispatch an intent to another app. */
	Intent = "intent",
	/** Create / update / query / delete an entity (sugar over `entities.*`). */
	Entity = "entity",
	/** An AI agent with tools — gated on Stage 11 (AI broker). */
	AIAgent = "ai-agent",
	/** A single-shot `ai.generate|extract|transform` — gated on Stage 11. */
	AICall = "ai-call",
	/** OS notification (notifications host service, Stage 7). */
	Notify = "notify",
	/** Delay for a duration, or until a condition. */
	Wait = "wait",
	/** Outbound HTTP via the network broker (doc 38) — gated on Net-1. */
	HTTP = "http",
	/** Sandboxed TS expression (no import / I/O) — gated on OQ-167. */
	Code = "code",
	/** Serialize entities to Markdown / CSV / JSON via the `export` service
	 *  (IE-8). Port-gated: registered only when the host wires the exporter. */
	Export = "export",
	/** if / else-if / else. */
	Branch = "branch",
	/** Iterate over a collection. */
	ForEach = "for-each",
	/** Invoke another Workflow as a step. */
	SubWorkflow = "sub-workflow",
}

export const STEP_KINDS = Object.freeze([
	StepKind.Trigger,
	StepKind.Intent,
	StepKind.Entity,
	StepKind.AIAgent,
	StepKind.AICall,
	StepKind.Notify,
	StepKind.Wait,
	StepKind.HTTP,
	StepKind.Code,
	StepKind.Export,
	StepKind.Branch,
	StepKind.ForEach,
	StepKind.SubWorkflow,
]) as readonly StepKind[];

/** The kinds whose interpreters ship in the engine spine (11b.4). The
 *  rest are declared-but-gated. */
export const ENGINE_STEP_KINDS = Object.freeze([
	StepKind.Trigger,
	StepKind.Intent,
	StepKind.Entity,
	StepKind.Notify,
	StepKind.Wait,
	StepKind.Branch,
	StepKind.ForEach,
	StepKind.SubWorkflow,
]) as readonly StepKind[];

/** What fires a workflow (doc 39 §Trigger kinds). */
export enum TriggerKind {
	/** Cron / RRULE + timezone + optional one-shot date. */
	Time = "time",
	/** onCreate | onUpdate | onDelete on a type, with filter. */
	EntityEvent = "entity-event",
	/** When intent verb V is dispatched (rare; system-level). */
	Intent = "intent",
	/** "Run now" button only — useful for testing. */
	Manual = "manual",
	/** Inbound HTTP via the network broker — needs `network.ingress`. */
	Webhook = "webhook",
	/** A granted FileHandle changes on disk. */
	FileWatch = "file-watch",
	/** Fires on shell launch (housekeeping workflows). */
	Startup = "startup",
}

export const TRIGGER_KINDS = Object.freeze([
	TriggerKind.Time,
	TriggerKind.EntityEvent,
	TriggerKind.Intent,
	TriggerKind.Manual,
	TriggerKind.Webhook,
	TriggerKind.FileWatch,
	TriggerKind.Startup,
]) as readonly TriggerKind[];

/** The trigger kinds wired to the scheduler in the engine spine (11b.6).
 *  Webhook (Net-1) / FileWatch (9.10) / Startup land in later slices. */
export const ENGINE_TRIGGER_KINDS = Object.freeze([
	TriggerKind.Time,
	TriggerKind.EntityEvent,
	TriggerKind.Manual,
]) as readonly TriggerKind[];

/** Lifecycle verb for an `entity-event` trigger. */
export enum EntityEventVerb {
	Create = "onCreate",
	Update = "onUpdate",
	Delete = "onDelete",
}

export const ENTITY_EVENT_VERBS = Object.freeze([
	EntityEventVerb.Create,
	EntityEventVerb.Update,
	EntityEventVerb.Delete,
]) as readonly EntityEventVerb[];

/** Entity-step operation (doc 39 — sugar over the entities host service). */
export enum EntityOp {
	Create = "create",
	Update = "update",
	Query = "query",
	Get = "get",
	Delete = "delete",
}

export const ENTITY_OPS = Object.freeze([
	EntityOp.Create,
	EntityOp.Update,
	EntityOp.Query,
	EntityOp.Get,
	EntityOp.Delete,
]) as readonly EntityOp[];

const MUTATING_ENTITY_OPS = Object.freeze(
	new Set<EntityOp>([EntityOp.Create, EntityOp.Update, EntityOp.Delete]),
);

/** A run's lifecycle state (doc 39 — `brainstorm/WorkflowRun/v1`). */
export enum WorkflowRunStatus {
	Queued = "queued",
	Running = "running",
	Succeeded = "succeeded",
	Failed = "failed",
	Cancelled = "cancelled",
	TimedOut = "timed-out",
}

export const WORKFLOW_RUN_STATUSES = Object.freeze([
	WorkflowRunStatus.Queued,
	WorkflowRunStatus.Running,
	WorkflowRunStatus.Succeeded,
	WorkflowRunStatus.Failed,
	WorkflowRunStatus.Cancelled,
	WorkflowRunStatus.TimedOut,
]) as readonly WorkflowRunStatus[];

/** Whether a run is finished (no further state transitions). */
export const TERMINAL_RUN_STATUSES = Object.freeze(
	new Set<WorkflowRunStatus>([
		WorkflowRunStatus.Succeeded,
		WorkflowRunStatus.Failed,
		WorkflowRunStatus.Cancelled,
		WorkflowRunStatus.TimedOut,
	]),
);

/** Agent-step memory scope (doc 39 §AI-agent steps). */
export enum MemoryMode {
	None = "none",
	PerRun = "per-run",
	PerWorkflow = "per-workflow",
}

export const MEMORY_MODES = Object.freeze([
	MemoryMode.None,
	MemoryMode.PerRun,
	MemoryMode.PerWorkflow,
]) as readonly MemoryMode[];

/** What happens when a workflow fires while a prior run of it is still
 *  active (doc 39 §Scheduler — runs serialized per workflow). */
export enum ConcurrencyPolicy {
	/** The new fire waits behind the active run (default). */
	Queue = "queue",
	/** The new fire is dropped. */
	Drop = "drop",
}

export const CONCURRENCY_POLICIES = Object.freeze([
	ConcurrencyPolicy.Queue,
	ConcurrencyPolicy.Drop,
]) as readonly ConcurrencyPolicy[];

export const isStepKind = enumGuard(STEP_KINDS);
export const isTriggerKind = enumGuard(TRIGGER_KINDS);
export const isEntityEventVerb = enumGuard(ENTITY_EVENT_VERBS);
export const isEntityOp = enumGuard(ENTITY_OPS);
export const isWorkflowRunStatus = enumGuard(WORKFLOW_RUN_STATUSES);
export const isMemoryMode = enumGuard(MEMORY_MODES);
export const isConcurrencyPolicy = enumGuard(CONCURRENCY_POLICIES);

// ───────────────────────────── steps ─────────────────────────────

export type StepId = string;

/** One tool an AI-agent step may invoke — an intent the workflow already
 *  holds caps for, never arbitrary code (doc 39 §AI-agent steps). The
 *  four fields are all discoverable from the launcher's registry. */
export type AgentTool = {
	verb: string;
	entityType?: string;
	format?: string;
	label: string;
	outputSchema?: unknown;
};

type StepBase<K extends StepKind> = { id: StepId; kind: K };

/** Pseudo-step standing in for the workflow's trigger; always first. */
export type TriggerStep = StepBase<StepKind.Trigger>;

export type IntentStep = StepBase<StepKind.Intent> & {
	verb: string;
	entityType?: string;
	args?: Record<string, unknown>;
};

export type EntityStep = StepBase<StepKind.Entity> & {
	op: EntityOp;
	entityType: string;
};

export type NotifyStep = StepBase<StepKind.Notify> & {
	title: string;
	body?: string;
	/** Optional entity the notification is about (click → open). */
	target?: AutomationEntityId;
};

export type WaitStep = StepBase<StepKind.Wait> & {
	durationMs?: number;
	/** A condition expression (parked; engine spine honours `durationMs`). */
	untilCondition?: string;
};

export type BranchStep = StepBase<StepKind.Branch> & {
	condition: string;
	/** Steps run when `condition` holds. Named `consequent`/`alternate`
	 *  (not `then`/`else`) so a step object is never an accidental
	 *  thenable / reserved-word key. */
	consequent: WorkflowStep[];
	alternate?: WorkflowStep[];
};

export type ForEachStep = StepBase<StepKind.ForEach> & {
	/** Reference to a prior step's collection output. */
	collection: string;
	body: WorkflowStep[];
};

export type SubWorkflowStep = StepBase<StepKind.SubWorkflow> & {
	workflowId: AutomationEntityId;
};

export type AIAgentStep = StepBase<StepKind.AIAgent> & {
	instructions: string;
	tools: AgentTool[];
	provider?: string;
	model?: string;
	maxIterations?: number;
	outputSchema?: unknown;
	memory?: MemoryMode;
};

export type AICallStep = StepBase<StepKind.AICall> & {
	instructions: string;
	provider?: string;
	model?: string;
};

export type HTTPStep = StepBase<StepKind.HTTP> & {
	method: string;
	url: string;
};

export type CodeStep = StepBase<StepKind.Code> & {
	expression: string;
};

/** Text serialization format for the `export` host service — shared by
 *  {@link ExportStep} and the SDK `ExportService.serializeEntities`. */
export type ExportTextFormat = "json" | "csv" | "markdown";

/** The export formats, as a single source for runtime validation + UI pickers. */
export const EXPORT_TEXT_FORMATS = Object.freeze([
	"json",
	"csv",
	"markdown",
]) as readonly ExportTextFormat[];

/** Serialize the operand entities (prior step output: ids or entity records)
 *  to a text format through the `export` host service (IE-8). */
export type ExportStep = StepBase<StepKind.Export> & {
	format: ExportTextFormat;
};

export type WorkflowStep =
	| TriggerStep
	| IntentStep
	| EntityStep
	| NotifyStep
	| WaitStep
	| BranchStep
	| ForEachStep
	| SubWorkflowStep
	| AIAgentStep
	| AICallStep
	| HTTPStep
	| CodeStep
	| ExportStep;

// ──────────────────────── entity payloads ────────────────────────

/** `brainstorm/Trigger/v1` — its own entity so one trigger can fire many
 *  workflows and triggers stay introspectable. */
export type TriggerDef = {
	kind: TriggerKind;
	/** Kind-specific. `time`: `{ recurrence?, timezone?, oneShotAt? }`;
	 *  `entity-event`: `{ entityType, verb, filter? }`; etc. */
	config: Record<string, unknown>;
	enabled: boolean;
	lastFiredAt?: string;
	nextFireAt?: string;
};

/** `brainstorm/Workflow/v1` — the user-authored automation. `capabilities`
 *  is frozen at save-time (the union the steps need); the user grants the
 *  aggregate. */
export type WorkflowDef = {
	name: string;
	description?: string;
	icon?: string;
	enabled: boolean;
	triggerId: AutomationEntityId;
	steps: WorkflowStep[];
	capabilities: string[];
	concurrency?: ConcurrencyPolicy;
	tags?: AutomationEntityId[];
};

/** `brainstorm/WorkflowRun/v1` — one execution record (provenance). */
export type WorkflowRunDef = {
	workflow: AutomationEntityId;
	triggeredAt: string;
	triggeredBy: AutomationEntityId;
	status: WorkflowRunStatus;
	stepLog?: unknown;
	error?: string;
	costCents?: number;
};

/** `brainstorm/Reminder/v1` — sugar over a single notify-step workflow,
 *  its own type because it is by far the highest-volume automation. */
export type ReminderDef = {
	subject: string;
	target?: AutomationEntityId;
	dueAt: string;
	/** RFC 5545 RRULE; absent = one-shot. */
	recurrence?: string;
	snoozedUntil?: string;
	completedAt?: string;
};

// ─────────────────────── capability keystone ───────────────────────
//
// The security-critical core of the automations app (doc 39 §Capabilities
// & security): three-tier intersection, fail-closed at every tier.
//   agent-tools ⊆ workflow-caps ⊆ app-caps
// A workflow cannot do anything the app lacks; an agent inside a workflow
// cannot do anything the workflow lacks.

/** `<service>.<verb>[:<scope>]` → its parts. Local three-line mirror of
 *  the shell ledger's `parseCapability` (doc 09 §Capabilities). */
function parseCapability(cap: string): { capability: string; scope: string | null } {
	const colon = cap.indexOf(":");
	if (colon < 0) return { capability: cap, scope: null };
	return { capability: cap.slice(0, colon), scope: cap.slice(colon + 1) };
}

/**
 * Does a `held` grant satisfy a `requested` capability? Mirrors the
 * ledger scope rule (doc 09): same `service.verb`, and either an exact
 * scope match, a `*` wildcard grant covering any scope, or both
 * unscoped. Unscoped requests are NOT satisfied by a scoped/`*` grant.
 */
export function capabilityImplies(held: string, requested: string): boolean {
	const h = parseCapability(held);
	const r = parseCapability(requested);
	if (h.capability !== r.capability) return false;
	if (r.scope === null) return h.scope === null;
	return h.scope === r.scope || h.scope === "*";
}

/** Every `requested` cap is implied by some cap in `held` (∅ ⊆ anything). */
export function isCapabilitySubset(requested: readonly string[], held: readonly string[]): boolean {
	return requested.every((req) => held.some((grant) => capabilityImplies(grant, req)));
}

/** The subset of `requested` caps NOT implied by any cap in `held`. */
export function missingCapabilities(
	requested: readonly string[],
	held: readonly string[],
): string[] {
	return requested.filter((req) => !held.some((grant) => capabilityImplies(grant, req)));
}

/** Origin (`scheme://host[:port]`) of a URL, or null if unparseable —
 *  used to derive the `network.egress:<origin>` scope of an HTTP step. */
function urlOrigin(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** The capabilities a single step statically requires (doc 39 §Aggregate
 *  capabilities — derivable from kind + config). Container steps return
 *  only their own footprint; their children are walked by
 *  `aggregateWorkflowCapabilities`. */
export function stepCapabilities(step: WorkflowStep): string[] {
	switch (step.kind) {
		case StepKind.Intent: {
			const caps = [`intents.dispatch:${step.verb}`];
			if (step.entityType) caps.push(`entities.read:${step.entityType}`);
			return caps;
		}
		case StepKind.Entity: {
			const access = MUTATING_ENTITY_OPS.has(step.op) ? "write" : "read";
			return [`entities.${access}:${step.entityType}`];
		}
		case StepKind.Notify:
			return ["notifications.post"];
		case StepKind.AICall: {
			const caps = ["ai.use"];
			if (step.provider) caps.push(`ai.provider:${step.provider}`);
			return caps;
		}
		case StepKind.AIAgent: {
			const caps = ["ai.use"];
			if (step.provider) caps.push(`ai.provider:${step.provider}`);
			for (const tool of step.tools) caps.push(...agentToolCapabilities(tool));
			return caps;
		}
		case StepKind.HTTP: {
			const origin = urlOrigin(step.url);
			return origin ? [`network.egress:${origin}`] : ["network.egress"];
		}
		default:
			return [];
	}
}

/** The capabilities an agent tool requires to be dispatched (it is an
 *  intent, so `intents.dispatch:<verb>` + the entity read it implies). */
export function agentToolCapabilities(tool: AgentTool): string[] {
	const caps = [`intents.dispatch:${tool.verb}`];
	if (tool.entityType) caps.push(`entities.read:${tool.entityType}`);
	return caps;
}

/** Recursively collect a step's own caps and those of its children. */
function collectStepCapabilities(step: WorkflowStep, into: Set<string>): void {
	for (const cap of stepCapabilities(step)) into.add(cap);
	if (step.kind === StepKind.Branch) {
		for (const s of step.consequent) collectStepCapabilities(s, into);
		if (step.alternate) for (const s of step.alternate) collectStepCapabilities(s, into);
	} else if (step.kind === StepKind.ForEach) {
		for (const s of step.body) collectStepCapabilities(s, into);
	}
}

/**
 * The aggregate capability set a workflow's steps need — the union the
 * user reviews and grants at save-time (doc 39 §Aggregate capabilities).
 * Deterministically sorted for a stable capability sheet.
 */
export function aggregateWorkflowCapabilities(steps: readonly WorkflowStep[]): string[] {
	const caps = new Set<string>();
	for (const step of steps) collectStepCapabilities(step, caps);
	return [...caps].sort();
}

/** Which tier of the intersection a violation is at. */
export enum CapabilityTier {
	/** An agent's tools exceed the workflow's frozen capability set. */
	AgentVsWorkflow = "agent-vs-workflow",
	/** The workflow's capability set exceeds the app's granted set. */
	WorkflowVsApp = "workflow-vs-app",
}

export type CapabilityViolation = { tier: CapabilityTier; capability: string };

export type CapabilityTierInput = {
	/** Capabilities the automations app has been granted. */
	appCapabilities: readonly string[];
	/** The workflow's frozen capability set. */
	workflowCapabilities: readonly string[];
	/** Caps required by all agent-step tools across the workflow. */
	agentToolCapabilities?: readonly string[];
};

export type CapabilityTierResult = { ok: boolean; violations: CapabilityViolation[] };

/**
 * The three-tier intersection check, fail-closed: `agent-tools ⊆
 * workflow-caps ⊆ app-caps` (doc 39 §Capabilities & security). Any cap a
 * tier requests but its container does not grant is a violation; `ok` is
 * `true` only when every tier is fully contained. Empty inputs are
 * vacuously contained.
 */
export function validateCapabilityTiers(input: CapabilityTierInput): CapabilityTierResult {
	const violations: CapabilityViolation[] = [];
	for (const cap of missingCapabilities(input.workflowCapabilities, input.appCapabilities)) {
		violations.push({ tier: CapabilityTier.WorkflowVsApp, capability: cap });
	}
	for (const cap of missingCapabilities(
		input.agentToolCapabilities ?? [],
		input.workflowCapabilities,
	)) {
		violations.push({ tier: CapabilityTier.AgentVsWorkflow, capability: cap });
	}
	return { ok: violations.length === 0, violations };
}

// ──────────────────────────── validators ────────────────────────────
//
// Structural validation only — non-blank required fields, known enum
// members, well-typed references. Does NOT recurse into referenced
// entities (that is the scheduler/runner's concern). Each returns a list
// of stable issue codes so callers can localise.

export enum AutomationIssueCode {
	EmptyName = "empty-name",
	EmptySubject = "empty-subject",
	InvalidTriggerKind = "invalid-trigger-kind",
	MissingTriggerRef = "missing-trigger-ref",
	MissingTriggerConfig = "missing-trigger-config",
	EmptySteps = "empty-steps",
	InvalidStepKind = "invalid-step-kind",
	InvalidConcurrency = "invalid-concurrency",
	InvalidRunStatus = "invalid-run-status",
	MissingWorkflowRef = "missing-workflow-ref",
	MissingDueAt = "missing-due-at",
}

export type AutomationIssue = { code: AutomationIssueCode; message: string };

function isBlank(v: unknown): boolean {
	return typeof v !== "string" || v.trim().length === 0;
}

export function validateTrigger(def: TriggerDef): AutomationIssue[] {
	const issues: AutomationIssue[] = [];
	if (!isTriggerKind(def.kind)) {
		issues.push({
			code: AutomationIssueCode.InvalidTriggerKind,
			message: `Unknown trigger kind "${String(def.kind)}".`,
		});
	}
	if (!def.config || typeof def.config !== "object") {
		issues.push({
			code: AutomationIssueCode.MissingTriggerConfig,
			message: "Trigger has no config object.",
		});
	}
	return issues;
}

export function validateWorkflow(def: WorkflowDef): AutomationIssue[] {
	const issues: AutomationIssue[] = [];
	if (isBlank(def.name)) {
		issues.push({ code: AutomationIssueCode.EmptyName, message: "Workflow name is empty." });
	}
	if (isBlank(def.triggerId)) {
		issues.push({
			code: AutomationIssueCode.MissingTriggerRef,
			message: "Workflow has no trigger reference.",
		});
	}
	if (!Array.isArray(def.steps) || def.steps.length === 0) {
		issues.push({ code: AutomationIssueCode.EmptySteps, message: "Workflow has no steps." });
	} else if (!def.steps.every((s) => isStepKind(s?.kind))) {
		issues.push({
			code: AutomationIssueCode.InvalidStepKind,
			message: "Workflow has a step with an unknown kind.",
		});
	}
	if (def.concurrency !== undefined && !isConcurrencyPolicy(def.concurrency)) {
		issues.push({
			code: AutomationIssueCode.InvalidConcurrency,
			message: `Unknown concurrency policy "${String(def.concurrency)}".`,
		});
	}
	return issues;
}

export function validateWorkflowRun(def: WorkflowRunDef): AutomationIssue[] {
	const issues: AutomationIssue[] = [];
	if (isBlank(def.workflow)) {
		issues.push({
			code: AutomationIssueCode.MissingWorkflowRef,
			message: "Run has no workflow reference.",
		});
	}
	if (!isWorkflowRunStatus(def.status)) {
		issues.push({
			code: AutomationIssueCode.InvalidRunStatus,
			message: `Unknown run status "${String(def.status)}".`,
		});
	}
	return issues;
}

export function validateReminder(def: ReminderDef): AutomationIssue[] {
	const issues: AutomationIssue[] = [];
	if (isBlank(def.subject)) {
		issues.push({
			code: AutomationIssueCode.EmptySubject,
			message: "Reminder subject is empty.",
		});
	}
	if (isBlank(def.dueAt)) {
		issues.push({ code: AutomationIssueCode.MissingDueAt, message: "Reminder has no due date." });
	}
	return issues;
}

export const isValidWorkflow = (def: WorkflowDef): boolean => validateWorkflow(def).length === 0;
export const isValidTrigger = (def: TriggerDef): boolean => validateTrigger(def).length === 0;
export const isValidWorkflowRun = (def: WorkflowRunDef): boolean =>
	validateWorkflowRun(def).length === 0;
export const isValidReminder = (def: ReminderDef): boolean => validateReminder(def).length === 0;
